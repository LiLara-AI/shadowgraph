import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedReapplyDeletion } from '../src/internal/snapshot.js';
import { attachLedgerView } from '../src/internal/deletion-knowledge.js';
const now = () => '2026-10-04T00:00:00.000Z';
function fixture({ journal = true, sameOwner = false, removeExperience = false, keyed = true } = {}) {
  const graph = createShadowGraph({ now });
  const a = graph.addDecision({ project: 'a', title: 'Source A', chosen: 'A' });
  const b = graph.addDecision({ project: sameOwner ? 'a' : 'b', title: 'Source B', chosen: 'B' });
  const memory = graph.remember({ project: removeExperience ? 'a' : 'keep', memoryType: 'note', key: 'mixed', text: 'Accepted experience', ...(keyed ? { idempotencyKey: 'mixed' } : {}) }).memory;
  const payload = privilegedSnapshot(graph);
  const decorate = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === memory.id && value.kind === 'memory') value.causalClaim = {
      state: 'recorded', class: 'ambiguous', verifierVersion: 'fixture', statement: 'Accepted reason',
      readings: ['Unassigned source reading A', 'Unassigned source reading B'],
      evidence: [{ sourceRef: a.id, text: 'Source A' }, { sourceRef: b.id, text: 'Source B' }]
    };
    else for (const child of Object.values(value)) decorate(child);
  };
  decorate(payload);
  if (!journal) { payload.journal = []; payload.journalSeq = 0; delete payload.journalEpoch; payload.idempotency = []; }
  const loaded = createShadowGraph({ now }); loaded.importData(payload);
  return { graph: loaded, a, b, memory };
}
for (const journal of [true, false]) for (const operation of ['purge', 'reapply']) {
  test(`${operation} refuses partially selected mixed-source readings before mutating canonical state (journal=${journal})`, () => {
    const f = fixture({ journal }), before = privilegedSnapshot(f.graph);
    const act = operation === 'purge' ? () => f.graph.purgeProject('a')
      : () => privilegedReapplyDeletion(f.graph, { remove: [{ id: f.a.id, mode: 'logical' }] });
    assert.throws(act, /mixed.source|unassigned.*readings/i);
    assert.deepEqual(privilegedSnapshot(f.graph), before);
    assert.equal(f.graph.exportData({ project: 'keep' }).records[0].causalClaim.readings.length, 2);
  });
}
for (const mode of ['logical', 'hard']) {
  test(`${mode} complete mixed-source selection removes all copies and keeps accepted experience`, () => {
    const f = fixture({ sameOwner: true });
    f.graph.purgeProject('a', { mode });
    const current = f.graph.exportData({ project: 'keep' }).records.find(x => x.id === f.memory.id);
    assert.equal(current.text, 'Accepted experience');
    assert.equal(current.causalClaim.statement, 'Accepted reason');
    assert.equal(current.causalClaim.class, 'ambiguous');
    assert.equal(Object.hasOwn(current.causalClaim, 'readings'), false);
    assert.ok(current.causalClaim.evidence.every(item => item.sourceAvailability === 'unavailable' && !Object.hasOwn(item, 'text')));
  });
  test(`${mode} deleting the complete experience does not refuse its mixed-source reading copies`, () => {
    const f = fixture({ removeExperience: true });
    f.graph.purgeProject('a', { mode });
    const payload = privilegedSnapshot(f.graph);
    assert.equal(payload.records.some(x => x.id === f.memory.id || x.id === f.a.id), false);
    assert.ok(payload.records.some(x => x.id === f.b.id));
    assert.equal(JSON.stringify(payload).includes('Unassigned source reading'), false);
  });
}

test('an index refresh after source purge cannot reintroduce deleted evidence from a stale memory index', () => {
  const f = fixture({ sameOwner: true, keyed: false });
  f.graph.purgeProject('a');
  const indexed = f.graph.remember({ project: 'keep', memoryType: 'note', key: 'mixed', text: 'Accepted experience', embedding: [1, 0] });
  assert.equal(indexed.indexUpdated, true);
  assert.equal(indexed.memory.causalClaim.sourceAvailability, 'unavailable');
  assert.equal(Object.hasOwn(indexed.memory.causalClaim, 'readings'), false);
  assert.equal(JSON.stringify(privilegedSnapshot(f.graph)).includes('Unassigned source reading'), false);
});

test('a refused partial purge restores the held view and leaves privileged state unchanged', () => {
  const f = fixture(), payload = privilegedSnapshot(f.graph);
  attachLedgerView(payload, { quarantine: [{ token: payload.records.find(x => x.id === f.a.id).erasureToken, at: now() }] });
  const graph = createShadowGraph({ now }); graph.importData(payload);
  const before = privilegedSnapshot(graph), view = graph.exportData({ project: 'keep' });
  assert.throws(() => graph.purgeProject('a'), /mixed.source/i);
  assert.deepEqual(privilegedSnapshot(graph), before);
  assert.deepEqual(graph.exportData({ project: 'keep' }), view);
  assert.equal(graph.exportData({ project: 'a' }).records.length, 0);
});

test('fact replacement uses the source-cleaned current fact and cannot journal a stale evidence copy', () => {
  const graph = createShadowGraph({ now });
  const source = graph.addDecision({ project: 'source', title: 'Fact source', chosen: 'A' });
  const fact = graph.addFact({ project: 'keep', key: 'status', value: 'old' });
  const payload = privilegedSnapshot(graph);
  const decorate = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === fact.id && value.kind === 'fact') value.claims = [{ class: 'quoted', verifierVersion: 'fixture', text: 'Accepted fact', sourceRef: source.id, evidence: 'DELETED FACT EVIDENCE' }];
    else for (const child of Object.values(value)) decorate(child);
  };
  decorate(payload);
  const loaded = createShadowGraph({ now }); loaded.importData(payload);
  loaded.purgeProject('source');
  loaded.addFact({ project: 'keep', key: 'status', value: 'new' });
  const after = privilegedSnapshot(loaded), old = after.facts.find(x => x.id === fact.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.claims[0].sourceAvailability, 'unavailable');
  assert.equal(JSON.stringify(after).includes('DELETED FACT EVIDENCE'), false);
});

test('source removal refuses before rewriting copied evidence inside a newer entity schema', () => {
  const f = fixture({ sameOwner: true }), payload = privilegedSnapshot(f.graph);
  const future = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === f.memory.id && value.kind === 'memory') value.schemaVersion += 1;
    else for (const child of Object.values(value)) future(child);
  };
  future(payload);
  const graph = createShadowGraph({ now }); graph.importData(payload);
  const before = privilegedSnapshot(graph);
  assert.throws(() => graph.purgeProject('a'), /future|newer|unsupported/i);
  assert.deepEqual(privilegedSnapshot(graph), before);
});
