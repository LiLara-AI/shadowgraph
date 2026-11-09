import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedLiveSnapshot, privilegedRecordCapture } from '../src/internal/snapshot.js';
import { attachLedgerView } from '../src/internal/deletion-knowledge.js';
import { t1Line } from '../src/compact-tier.js';
import { withoutSourceCopies } from '../src/internal/source-availability.js';
import { createStorage } from '../src/storage.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { join } from 'node:path';
const now = () => '2026-10-04T00:00:00.000Z';
function fixture() {
  const graph = createShadowGraph({ now });
  const capture = privilegedRecordCapture(graph, { project: 'p', originId: 'origin', text: 'Synthetic evidence',
    source: { event: 'UserPromptSubmit', sessionId: 'synthetic' }, admission: { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 100, maxItemBytes: 2 ** 20, maxItemsPerSession: 100 }, storeBytes: 0 } });
  const memory = graph.remember({ project: 'p', memoryType: 'note', key: 'source-test', text: 'Accepted experience', idempotencyKey: 'accepted' }).memory;
  const payload = privilegedSnapshot(graph);
  const decorate = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === memory.id && value.kind === 'memory') {
      value.captureRef = capture.id;
      value.claims = [{ text: 'Accepted experience', sourceRef: capture.id, class: 'ambiguous',
        verifierVersion: 'claim-fixture', readings: ['Synthetic evidence A', 'Synthetic evidence B'], evidence: 'Synthetic evidence' }];
    } else for (const child of Object.values(value)) decorate(child);
  };
  decorate(payload);
  return { payload, capture, memory };
}
test('unavailable ambiguous source reader preserves recorded class without retaining copied readings', () => {
  const { payload, memory } = fixture();
  const transform = value => {
    if (!value || typeof value !== 'object') return;
    if (value.sourceRef) { value.sourceAvailability = 'unavailable'; delete value.readings; delete value.evidence; }
    for (const child of Object.values(value)) transform(child);
  };
  transform(payload);
  const graph = createShadowGraph({ now }); graph.importData(payload);
  const record = graph.exportData({ project: 'p' }).records.find(x => x.id === memory.id);
  assert.equal(record.claims[0].class, 'ambiguous');
  const line = t1Line(record);
  assert.match(line.line, /source unavailable/i);
  assert.equal(line.provenance.citedEvidenceUnavailable, true);
  assert.equal(Object.hasOwn(line.provenance, 'sourceAvailability'), false);
  assert.equal(line.claimClass, 'ambiguous');
  assert.deepEqual(privilegedSnapshot(graph).records, payload.records);
});
test('source unavailability is a closed evidence-removal exception, not a way to waive claim requirements', () => {
  for (const edit of [claim => { delete claim.readings; }, claim => { claim.sourceAvailability = 'unavailable'; },
    claim => { claim.sourceAvailability = 'unavailable'; delete claim.readings; },
    claim => { claim.sourceAvailability = 'unavailable'; delete claim.readings; delete claim.evidence; delete claim.verifierVersion; }]) {
    const { payload } = fixture(); edit(payload.records.find(x => x.kind === 'memory').claims[0]);
    assert.throws(() => createShadowGraph({ now }).importData(payload));
  }
});
test('held-source evidence projection is hidden on reads but preserved byte-for-byte for save and owner release', () => {
  const { payload, capture, memory } = fixture(), original = structuredClone(payload);
  attachLedgerView(payload, { quarantine: [{ token: capture.erasureToken, at: now() }] });
  const graph = createShadowGraph({ now }); graph.importData(payload);
  const live = privilegedLiveSnapshot(graph);
  assert.equal(live.records.some(x => x.id === capture.id), false);
  const shown = graph.exportData({ project: 'p' }).records.find(x => x.id === memory.id);
  assert.equal(shown.sourceAvailability, 'unavailable');
  assert.equal(shown.claims[0].class, 'ambiguous');
  assert.equal(Object.hasOwn(shown.claims[0], 'evidence'), false);
  assert.equal(Object.hasOwn(shown.claims[0], 'readings'), false);
  const line = graph.context({ project: 'p', query: 'Accepted experience', compact: true }).relevant.items[0].line;
  assert.match(line.line, /source unavailable/i);
  assert.equal(line.provenance.sourceAvailability, 'unavailable');
  const { operation, scope, ...handle } = line.expansion;
  const expanded = graph.expand({ ...handle, project: scope.project });
  assert.equal(expanded.status, 'current');
  assert.equal(expanded.record.claims[0].sourceAvailability, 'unavailable');
  assert.equal(Object.hasOwn(expanded.record.claims[0], 'evidence'), false);
  assert.deepEqual(privilegedSnapshot(graph), original);
  assert.equal(JSON.stringify(live).includes('Synthetic evidence'), false);
  const released = createShadowGraph({ now }); released.importData(privilegedSnapshot(graph));
  assert.deepEqual(released.exportData({ project: 'p' }).records.find(x => x.id === memory.id).claims,
    original.records.find(x => x.id === memory.id).claims);
});
test('source projection removes only exact cited copies and keeps mixed-source evidence and recorded verification', () => {
  const record = { id: 'attempt', kind: 'attempt', solution: 'Accepted experience',
    claims: [{ sourceRef: 'gone', text: 'Canonical claim', class: 'quoted', evidence: 'Removed copy', checks: { scope: 'consistent' } },
      { sourceRef: 'kept', text: 'Other claim', class: 'ambiguous', evidence: 'Other copy', readings: ['Other source reading'] }],
    causalClaim: { state: 'recorded', class: 'ambiguous', statement: 'Recorded reason', readings: ['Source units'],
      evidence: [{ sourceRef: 'gone', text: 'Removed copy', span: { start: 0, end: 4 } }, { sourceRef: 'kept', text: 'Other copy' }] } };
  const before = structuredClone(record), result = withoutSourceCopies(record, new Set(['gone']));
  assert.deepEqual(record, before, 'projection does not mutate canonical input');
  assert.deepEqual(result.claims[1], record.claims[1]);
  assert.deepEqual(result.causalClaim.evidence[1], record.causalClaim.evidence[1]);
  assert.deepEqual(result.claims[0].checks, record.claims[0].checks);
  assert.equal(result.claims[0].text, 'Canonical claim');
  assert.equal(result.causalClaim.statement, 'Recorded reason');
  assert.equal(result.causalClaim.class, 'ambiguous');
  assert.equal(Object.hasOwn(result.causalClaim, 'readings'), false);
  assert.equal(Object.hasOwn(result.causalClaim.evidence[0], 'text'), false);
  assert.equal(withoutSourceCopies(record, new Set(['unrelated'])), record);
});
test('source projection preserves literal fact values, metadata, unknown entities and future collections', () => {
  const literal = { id: 'literal', kind: 'memory', text: 'Owner literal', sourceRef: 'gone', evidence: 'Literal evidence', readings: ['Literal reading'],
    claims: [{ class: 'ambiguous', sourceRef: 'gone', evidence: 'Literal nested copy', readings: ['Literal nested reading'] }] };
  const payload = { schemaVersion: 7, records: [{ id: 'm', kind: 'memory', text: 'Accepted', metadata: literal },
    { id: 'future', kind: 'future_kind', contents: literal }], facts: [{ id: 'f', kind: 'fact', key: 'literal', value: literal }],
    futureCollection: [literal], journal: [{ type: 'legacy_metadata_event', payload: literal }] };
  assert.deepEqual(withoutSourceCopies(payload, new Set(['gone'])), payload);
});
test('a held producing capture does not select a causal claim from another cited source', () => {
  const record = { id: 'a', kind: 'attempt', solution: 'Accepted', captureRef: 'gone',
    causalClaim: { state: 'recorded', class: 'ambiguous', readings: ['Keep this source reading'], evidence: [{ sourceRef: 'kept', text: 'Keep copy' }] } };
  const output = withoutSourceCopies(record, new Set(['gone']));
  assert.equal(output.sourceAvailability, 'unavailable');
  assert.deepEqual(output.causalClaim, record.causalClaim);
});
test('record-level source unavailability cannot retain copies for that same source', () => {
  const { payload } = fixture();
  payload.records.find(x => x.kind === 'memory').sourceAvailability = 'unavailable';
  assert.throws(() => createShadowGraph({ now }).importData(payload), /unavailable|evidence/i);
});
test('T1 distinguishes a missing cited source from the record producing capture', () => {
  const record = { id: 'm', kind: 'memory', memoryType: 'note', key: 'key', text: 'Accepted', captureRef: 'available-a',
    claims: [{ class: 'quoted', text: 'Accepted', sourceRef: 'gone-b', sourceAvailability: 'unavailable', verifierVersion: 'fixture' }] };
  const line = t1Line(record);
  assert.equal(line.provenance.sourceRef, 'available-a');
  assert.equal(Object.hasOwn(line.provenance, 'sourceAvailability'), false);
  assert.equal(line.provenance.citedEvidenceUnavailable, true);
  assert.match(line.line, /source unavailable/i);
  const short = t1Line(record, { ceiling: 5 });
  assert.ok(short.decisiveOmitted.includes('sourceAvailability'));
  assert.equal(short.requiresExpansion, true);
});
test('causal unavailable markers cannot contradict evidence-node text', () => {
  for (const parent of ['record', 'cause', 'node']) {
    const { payload, capture } = fixture();
    const record = payload.records.find(x => x.kind === 'memory');
    record.causalClaim = { state: 'recorded', class: 'quoted', verifierVersion: 'fixture', evidence: [{ sourceRef: capture.id, text: 'Copied source' }] };
    if (parent === 'record') record.sourceAvailability = 'unavailable';
    if (parent === 'cause') record.causalClaim.sourceAvailability = 'unavailable';
    if (parent === 'node') record.causalClaim.evidence[0].sourceAvailability = 'unavailable';
    assert.throws(() => createShadowGraph({ now }).importData(payload), /unavailable/i);
  }
});
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
test('accepted sparse attempts suppress held copies while preserving canonical and unrelated sources', () => {
  for (const reason of [undefined, 'Legacy reason']) {
    const { payload, capture } = fixture();
    const sparse = { id: 'sparse-attempt', kind: 'attempt', schemaVersion: 7, project: 'p', attribution: 'project',
      captureRef: capture.id, ...(reason === undefined ? {} : { reason }),
      claims: [{ class: 'quoted', verifierVersion: 'fixture', text: 'Accepted sparse claim', sourceRef: capture.id, evidence: 'HELD COPY' },
        { class: 'quoted', verifierVersion: 'fixture', text: 'Other claim', sourceRef: 'available', evidence: 'KEEP COPY' }] };
    payload.records.push(sparse);
    const original = structuredClone(payload);
    attachLedgerView(payload, { quarantine: [{ token: capture.erasureToken, at: now() }] });
    const graph = createShadowGraph({ now }); graph.importData(payload);
    for (const view of [graph.exportData({ project: 'p' }), privilegedLiveSnapshot(graph)]) {
      const shown = view.records.find(x => x.id === sparse.id);
      assert.equal(shown.sourceAvailability, 'unavailable');
      assert.equal(Object.hasOwn(shown.claims[0], 'evidence'), false);
      assert.deepEqual(shown.claims[1], sparse.claims[1]);
    }
    const carriers = { journal: [{ type: 'attempt.recorded', payload: sparse }], idempotency: [{ response: { attempt: sparse } }] };
    assert.equal(JSON.stringify(withoutSourceCopies(carriers, new Set([capture.id]))).includes('HELD COPY'), false);
    assert.deepEqual(new Map(privilegedSnapshot(graph).records.map(x => [x.id, x])), new Map(original.records.map(x => [x.id, x])));
    const released = createShadowGraph({ now }); released.importData(privilegedSnapshot(graph));
    const restored = released.exportData({ project: 'p' }).records.find(x => x.id === sparse.id);
    assert.deepEqual(restored.claims, sparse.claims);
    assert.equal(restored.reason, sparse.reason);
    assert.equal(Object.hasOwn(restored, 'sourceAvailability'), false);
  }
});

test('unavailable source identity forbids duplicate causal and claim copies but preserves different sources', () => {
  for (const marker of ['node', 'claim', 'record']) for (const copied of ['text', 'evidence', 'readings']) {
    const { payload, capture } = fixture();
    const record = payload.records.find(x => x.kind === 'memory');
    record.claims = [{ class: 'quoted', verifierVersion: 'fixture', text: 'Accepted', sourceRef: capture.id }];
    record.causalClaim = { state: 'recorded', class: 'quoted', verifierVersion: 'fixture',
      evidence: [{ sourceRef: capture.id }, { sourceRef: 'available', text: 'KEEP COPY' }] };
    if (marker === 'node') record.causalClaim.evidence[0].sourceAvailability = 'unavailable';
    if (marker === 'claim') record.claims[0].sourceAvailability = 'unavailable';
    if (marker === 'record') record.sourceAvailability = 'unavailable';
    createShadowGraph({ now }).importData(structuredClone(payload)); // valid different-source control
    record.causalClaim.evidence.push({ sourceRef: capture.id, [copied]: copied === 'readings' ? ['LEAK'] : 'LEAK' });
    assert.throws(() => createShadowGraph({ now }).importData(payload), /unavailable/i, `${marker}/${copied}`);
  }
  const { payload, capture } = fixture();
  const record = payload.records.find(x => x.kind === 'memory');
  record.causalClaim = { state: 'recorded', evidence: [{ sourceRef: capture.id, sourceAvailability: 'unavailable' }] };
  assert.throws(() => createShadowGraph({ now }).importData(payload), /unavailable/i, 'causal marker also constrains same-source claim copies');
});

test('causal readings cannot retain copied units when a cited source is unavailable without a parent flag', () => {
  for (const marker of ['record', 'claim', 'node']) {
    const { payload, capture } = fixture();
    const record = payload.records.find(x => x.kind === 'memory');
    record.claims = [{ class: 'quoted', verifierVersion: 'fixture', text: 'Accepted', sourceRef: capture.id }];
    if (marker === 'record') record.sourceAvailability = 'unavailable';
    if (marker === 'claim') record.claims[0].sourceAvailability = 'unavailable';
    record.causalClaim = { state: 'recorded', class: 'ambiguous', verifierVersion: 'fixture', readings: ['RAW SOURCE READING'],
      evidence: [{ sourceRef: marker === 'node' ? capture.id : 'available', ...(marker === 'node' ? { sourceAvailability: 'unavailable' } : {}) }] };
    if (marker !== 'node') createShadowGraph({ now }).importData(structuredClone(payload)); // producing source alone cannot bind another cause
    record.causalClaim.evidence[0].sourceRef = capture.id;
    assert.throws(() => createShadowGraph({ now }).importData(payload), /unavailable/i, marker);
  }
});

test('held capture content references suppress typed evidence copies without persisting the view', () => {
  const { payload, capture, memory } = fixture();
  const decorate = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === memory.id && value.kind === 'memory') {
      delete value.captureRef;
      value.claims[0].sourceRef = capture.contentRef;
      value.causalClaim = { state: 'recorded', class: 'quoted', verifierVersion: 'fixture',
        evidence: [{ sourceRef: capture.contentRef, text: 'HELD CONTENT COPY' }, { sourceRef: 'available', text: 'KEEP COPY' }] };
    } else for (const item of Object.values(value)) decorate(item);
  };
  decorate(payload); const original = structuredClone(payload);
  attachLedgerView(payload, { quarantine: [{ token: capture.erasureToken, at: now() }] });
  const graph = createShadowGraph({ now }); graph.importData(payload);
  const shown = graph.exportData({ project: 'p' }).records.find(x => x.id === memory.id);
  assert.equal(shown.claims[0].sourceAvailability, 'unavailable');
  assert.equal(Object.hasOwn(shown.claims[0], 'evidence'), false);
  assert.equal(Object.hasOwn(shown.claims[0], 'readings'), false);
  assert.equal(Object.hasOwn(shown.causalClaim.evidence[0], 'text'), false);
  assert.equal(shown.causalClaim.evidence[1].text, 'KEEP COPY');
  assert.equal(Object.hasOwn(shown, 'sourceAvailability'), false, 'no fabricated producing-source identity');
  assert.deepEqual(privilegedSnapshot(graph), original);
  const released = createShadowGraph({ now }); released.importData(privilegedSnapshot(graph));
  assert.deepEqual(released.exportData({ project: 'p' }).records.find(x => x.id === memory.id).claims,
    original.records.find(x => x.id === memory.id).claims);
});

test('withheld raw content qualifies both its content reference and surviving capture identity', () => {
  for (const reference of ['id', 'contentRef']) {
    const { payload, capture, memory } = fixture();
    const peer = { ...structuredClone(capture), id: 'shared-content-peer', erasureToken: '11111111-1111-4111-8111-111111111111' };
    payload.records.push(peer);
    const decorate = value => {
      if (!value || typeof value !== 'object') return;
      if (value.id === memory.id && value.kind === 'memory') { delete value.captureRef; value.claims[0].sourceRef = peer[reference]; }
      else for (const item of Object.values(value)) decorate(item);
    };
    decorate(payload); const original = structuredClone(payload);
    attachLedgerView(payload, { quarantine: [{ token: capture.erasureToken, at: now() }] });
    const graph = createShadowGraph({ now }); graph.importData(payload);
    const live = privilegedLiveSnapshot(graph);
    assert.equal((live.captureContent ?? []).length, 0, 'valid fixture: the raw entry is actually withheld');
    assert.ok(live.records.some(item => item.id === peer.id), 'peer entity token is not quarantined');
    const shown = graph.exportData({ project: 'p' }).records.find(item => item.id === memory.id);
    assert.equal(shown.claims[0].sourceAvailability, 'unavailable');
    assert.equal(Object.hasOwn(shown.claims[0], 'readings'), false);
    assert.deepEqual(privilegedSnapshot(graph), original);
  }
});

for (const type of ['json', 'sqlite']) test(`${type} unavailable source reader round-trips canonical, journal and retry copies without rewriting future members`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
  const { payload, capture } = fixture();
  const next = withoutSourceCopies(payload, new Set([capture.id]));
  next.futureCollection = [{ opaque: 'preserve' }];
  const root = await scratchDirectory(t, 'pr43-source-reader-');
  const store = await createStorage({ type, file: join(root, 'store'), env: { SHADOWGRAPH_HOME: join(root, 'home') } });
  try {
    const graph = createShadowGraph({ now }); graph.importData(next);
    await store.save(privilegedSnapshot(graph));
    const first = await store.load(), read = createShadowGraph({ now }); read.importData(first);
    const again = privilegedSnapshot(read);
    for (const key of ['records', 'journal', 'idempotency', 'futureCollection']) assert.deepEqual(again[key], first[key]);
    await store.save(again);
    const second = await store.load();
    for (const key of ['records', 'journal', 'idempotency', 'futureCollection']) assert.deepEqual(second[key], first[key]);
  } finally { store.close(); }
});
