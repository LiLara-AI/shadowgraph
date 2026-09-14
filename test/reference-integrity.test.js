import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';

const AT = '2026-01-01T00:00:00Z';

// Schemas 1-3 had collection-local ids, so the same id could name a decision and
// an attempt. Schema 4 has one global namespace, so importing such a payload
// renames the later entity -- and the old id survives on the earlier one.
function legacyPayloadWithCollision(extra = {}) {
  return {
    schemaVersion: 3,
    records: [
      { id: 'x1', kind: 'decision', project: 'p', title: 'A', chosen: 'a', status: 'active', confidence: 0.5, createdAt: AT, updatedAt: AT },
      { id: 'x1', kind: 'attempt', project: 'p', solution: 's', result: 'failed', createdAt: AT }
    ],
    facts: [],
    relations: [{ id: 'r1', kind: 'relation', from: 'x1', to: 'x1', relation: 'depends_on', createdAt: AT }],
    reviewSignals: [], idempotency: [], events: [], journal: [],
    ...extra
  };
}

const codes = (graph) => graph.validate().issues.map((issue) => issue.code);

test('a legacy collision renames the later entity and leaves the old id in use', () => {
  const graph = createShadowGraph();
  graph.importData(legacyPayloadWithCollision());
  const ids = graph.exportData().records.map((record) => `${record.kind}:${record.id}`);
  assert.ok(ids.includes('decision:x1'), 'the first entity keeps the id');
  assert.ok(ids.some((id) => id.startsWith('attempt:attempt_')), 'the colliding one is renamed');
});

test('a reference left pointing at a reused legacy id is declared, not silently rebound', () => {
  const graph = createShadowGraph();
  graph.importData(legacyPayloadWithCollision());

  // The relation still resolves -- to the decision -- which is exactly what makes
  // it dangerous. It must not look healthy.
  const [relation] = graph.exportData().relations;
  assert.equal(relation.from, 'x1');
  assert.equal(relation.to, 'x1');
  assert.deepEqual(relation.migration.ambiguousLegacyEndpoints, ['from', 'to']);

  assert.ok(codes(graph).includes('ambiguous_legacy_relation_endpoint'));
  assert.equal(graph.validate().valid, false, 'an ambiguous link makes the graph not valid');
});

test('the endpoint is never guessed at: no rebinding happens', () => {
  const graph = createShadowGraph();
  graph.importData(legacyPayloadWithCollision());
  const renamed = graph.exportData().records.find((record) => record.kind === 'attempt').id;
  const [relation] = graph.exportData().relations;
  assert.notEqual(relation.from, renamed, 'the import did not invent a link to the renamed entity');
  assert.notEqual(relation.to, renamed);
});

test('record-level references to a reused legacy id are declared too', () => {
  const graph = createShadowGraph();
  const payload = legacyPayloadWithCollision();
  payload.records[0].supersedes = ['x1'];
  payload.records[0].failedAttempts = ['x1'];
  graph.importData(payload);

  const record = graph.exportData().records.find((item) => item.id === 'x1');
  assert.deepEqual([...record.migration.ambiguousLegacyReferences].sort(), ['failedAttempts', 'supersedes']);
  assert.ok(codes(graph).includes('ambiguous_legacy_reference'));
});

test('a legacy payload with no collision is not flagged', () => {
  const graph = createShadowGraph();
  const payload = legacyPayloadWithCollision();
  payload.records[1].id = 'x2';
  payload.relations[0].to = 'x2';
  graph.importData(payload);

  assert.ok(!codes(graph).includes('ambiguous_legacy_relation_endpoint'), 'no false positive');
  const [relation] = graph.exportData().relations;
  assert.equal(relation.migration, undefined, 'and no marker is written');
});

test('the ambiguity marker survives a repeated import unchanged', () => {
  const graph = createShadowGraph();
  graph.importData(legacyPayloadWithCollision());
  const first = graph.exportData();
  const reimported = createShadowGraph();
  reimported.importData(first);

  const [relation] = reimported.exportData().relations;
  assert.deepEqual(relation.migration.ambiguousLegacyEndpoints, ['from', 'to'], 'it is not lost on round trip');
  assert.ok(codes(reimported).includes('ambiguous_legacy_relation_endpoint'), 'and it is still reported');
});

test('redaction drops links whose endpoint it did not include', () => {
  const graph = createShadowGraph();
  const owner = graph.addDecision({
    project: 'p', title: 'Owner', chosen: 'a',
    alternatives: [{ label: 'alt', reasonRejected: 'not now' }]
  });
  const alternativeId = owner.alternatives[0].id;
  const other = graph.addDecision({ project: 'p', title: 'Other', chosen: 'b' });
  graph.link({ from: other.id, to: alternativeId, relation: 'depends_on' });
  graph.addDecision({ project: 'other', title: 'Elsewhere', chosen: 'c' });

  const redacted = graph.redact({ project: 'p' });
  const includedIds = new Set([
    ...redacted.records.map((item) => item.id),
    ...redacted.facts.map((item) => item.id)
  ]);

  // Every surviving relation must resolve inside what was actually returned.
  for (const relation of redacted.relations) {
    assert.ok(includedIds.has(relation.from), `relation ${relation.id} from-endpoint escaped the redaction`);
    assert.ok(includedIds.has(relation.to), `relation ${relation.id} to-endpoint escaped the redaction`);
  }
  // The nested alternative is not a top-level record, so the link to it is
  // dropped rather than left pointing at an endpoint the caller cannot see.
  assert.ok(!redacted.relations.some((relation) => relation.to === alternativeId));
  assert.ok(!redacted.records.some((record) => record.project !== 'p'), 'and no other project leaks');
});
