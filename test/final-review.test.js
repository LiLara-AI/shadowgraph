import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShadowGraph, rebuildProjection } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';

function decision(id = 'd1') {
  return { id, kind: 'decision', schemaVersion: 3, project: 'p', title: 'T', chosen: 'C', status: 'active', alternatives: [] };
}

test('final review: legacy facts without ids receive generated ids during import', () => {
  const graph = createShadowGraph();
  graph.importData({ facts: [{ key: 'legacy-key', value: 1 }] });
  const fact = graph.exportData().facts[0];
  assert.match(fact.id, /^fact_/);
  assert.equal(fact.key, 'legacy-key');
});

test('final review: generated legacy fact ids are deterministic and duplicate-safe', () => {
  const payload = { facts: [
    { project: 'p', key: 'same', value: { state: 'ready' } },
    { project: 'p', key: 'same', value: { state: 'ready' } }
  ] };
  const first = createShadowGraph();
  const second = createShadowGraph();
  first.importData(payload);
  second.importData(payload);
  const firstIds = first.exportData().facts.map((fact) => fact.id);
  const secondIds = second.exportData().facts.map((fact) => fact.id);
  assert.deepEqual(firstIds, secondIds, 'same legacy payload must produce the same ids after restart/import');
  assert.equal(new Set(firstIds).size, 2, 'identical duplicate facts must not overwrite one another');
  assert.match(firstIds[0], /^fact_[a-f0-9]{20}$/);
});

test('final review: malformed persisted entities are rejected with indexed diagnostics', () => {
  const cases = [
    [{ records: [decision(), { id: 'bad', kind: 'unknown' }] }, /records\[1\]/],
    [{ facts: [{ id: 'bad', kind: 'fact', project: 'p', value: 1 }] }, /facts\[0\]/],
    [{ records: [{ ...decision(), alternatives: [null] }] }, /records\[0\]\.alternatives\[0\]/],
    [{ journal: [null] }, /journal\[0\]/],
    [{ reviewSignals: [{ id: 's' }] }, /reviewSignals\[0\]/],
    [{ idempotency: [{ key: 'k', value: null }] }, /idempotency\[0\]/],
    [{ events: [{ id: 'e' }] }, /events\[0\]/]
  ];
  for (const [payload, diagnostic] of cases) {
    const graph = createShadowGraph();
    assert.throws(() => graph.importData(payload), diagnostic);
  }
});

test('final review: malformed replace is atomic for records, facts, alternatives, and journal', () => {
  for (const payload of [
    { records: [decision(), { id: 'bad', kind: 'unknown' }] },
    { facts: [{ id: 'bad', kind: 'fact', value: 1 }] },
    { records: [{ ...decision(), alternatives: [null] }] },
    { journal: [null] }
  ]) {
    const graph = createShadowGraph();
    graph.addDecision({ id: 'kept', project: 'keep', title: 'ORIGINAL', chosen: 'sqlite' });
    assert.throws(() => graph.replaceData(payload));
    assert.equal(graph.search('ORIGINAL', { project: 'keep' }).page.total, 1);
  }
});

test('final review: direct import preflights before merging valid entities', () => {
  const graph = createShadowGraph();
  graph.addDecision({ id: 'kept', project: 'keep', title: 'ORIGINAL', chosen: 'sqlite' });
  assert.throws(() => graph.importData({ records: [decision('new'), { id: 'bad', kind: 'decision', title: 1, chosen: 'x' }] }));
  assert.deepEqual(graph.exportData().records.map((item) => item.id), ['kept']);
});

test('final review: unknown confidence policy is preserved and reported unsupported', () => {
  const graph = createShadowGraph();
  graph.importData({ records: [{
    ...decision(),
    confidence: {
      initial: 0.2,
      current: 0.91,
      policy: 'future_policy_v9',
      basis: { policy: 'future_policy_v9', contributions: [{ key: 'x', direction: -1, sourceClass: 'production_verified' }] },
      history: []
    }
  }] });
  const stored = graph.exportData().records[0].confidence;
  assert.equal(stored.current, 0.91, 'unknown policy values must not be recalculated by v1');
  assert.equal(stored.policy, 'future_policy_v9');
  assert.equal(stored.basis.policy, 'future_policy_v9');
  const result = graph.validate();
  assert.equal(result.valid, false);
  assert.ok(result.issues.some((issue) => issue.code === 'unsupported_confidence_policy' && issue.severity === 'unsupported'));
});

test('final review: known confidence policy is internally consistent after migration', () => {
  const graph = createShadowGraph();
  graph.importData({ records: [{
    ...decision(),
    confidence: {
      initial: 0.5,
      current: 0.99,
      policy: 'evidence_weighted_bounded_v1',
      basis: { policy: 'evidence_weighted_bounded_v1', contributions: [{ key: 'x', kind: 'evidence', direction: 1, sourceClass: 'tool_observed' }] },
      history: []
    }
  }] });
  const confidence = graph.exportData().records[0].confidence;
  assert.equal(confidence.current, 0.64);
  assert.equal(confidence.policy, confidence.basis.policy);
});

test('final review: separate JSON store instances cannot both commit the same revision', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-json-collision-'));
  const file = join(dir, 'graph.json');
  const first = createJsonFileStore(file);
  const second = createJsonFileStore(file);
  const seed = createShadowGraph();
  const revision = await first.save(seed.exportData());
  const left = createShadowGraph({ revision });
  left.addDecision({ id: 'left', title: 'Left', chosen: 'L' });
  const right = createShadowGraph({ revision });
  right.addDecision({ id: 'right', title: 'Right', chosen: 'R' });
  const results = await Promise.allSettled([first.save(left.exportData()), second.save(right.exportData())]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected' && /revision conflict/i.test(item.reason.message)).length, 1);
  const loaded = await first.load();
  assert.equal(loaded.revision, revision + 1);
  assert.equal(loaded.records.length, 1, 'one complete writer wins; no merged or truncated payload');
});

test('final review: rebuild rejects sequence gaps and impossible epochs', () => {
  const entries = [
    { id: 'j1', seq: 1, type: 'decision.recorded', entityKind: 'decision', entityId: 'd1', schemaVersion: 3, payload: decision() },
    { id: 'j3', seq: 3, type: 'fact.observed', entityKind: 'fact', entityId: 'f1', schemaVersion: 3, payload: { id: 'f1', kind: 'fact', project: 'p', key: 'k', value: 1 } }
  ];
  assert.equal(rebuildProjection(entries).rebuildable, false);
  assert.equal(rebuildProjection(entries, { journalEpoch: 999 }).rebuildable, false);
});

test('final review: decision, fact, and attempt idempotency namespaces survive rebuild and import', () => {
  const graph = createShadowGraph();
  const d = graph.addDecision({ title: 'D', chosen: 'C', idempotencyKey: 'same' });
  const f = graph.addFact({ key: 'F', value: 1, idempotencyKey: 'same' });
  const a = graph.addAttempt({ solution: 'A', result: 'R', idempotencyKey: 'same' });
  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true);
  assert.deepEqual(rebuilt.projection.idempotency.map((item) => item.key).sort(), ['attempt:default:same', 'decision:default:same', 'fact:default:same']);
  const restarted = createShadowGraph();
  restarted.importData({ ...rebuilt.projection, schemaVersion: 3 });
  assert.equal(restarted.addDecision({ title: 'other', chosen: 'x', idempotencyKey: 'same' }).id, d.id);
  assert.equal(restarted.addFact({ key: 'other', value: 2, idempotencyKey: 'same' }).id, f.id);
  assert.equal(restarted.addAttempt({ solution: 'other', result: 'x', idempotencyKey: 'same' }).id, a.id);
});

test('final review: identical idempotency keys are isolated by project', () => {
  const graph = createShadowGraph();
  const first = graph.addDecision({ project: 'p1', title: 'One', chosen: 'A', idempotencyKey: 'same' });
  const second = graph.addDecision({ project: 'p2', title: 'Two', chosen: 'B', idempotencyKey: 'same' });
  assert.notEqual(second.id, first.id);
  assert.equal(graph.addDecision({ project: 'p1', title: 'retry', chosen: 'x', idempotencyKey: 'same' }).id, first.id);
  assert.equal(graph.addDecision({ project: 'p2', title: 'retry', chosen: 'x', idempotencyKey: 'same' }).id, second.id);
  assert.equal(graph.rebuild().projection.idempotency.length, 2);
});

test('final review: declared journalSeq is not regressed on import', () => {
  const graph = createShadowGraph();
  graph.importData({ journalSeq: 99, journalEpoch: 1, journal: [{ id: 'j1', seq: 1, type: 'fact.observed', entityKind: 'fact', entityId: 'f1', schemaVersion: 3, payload: { id: 'f1', kind: 'fact', project: 'p', key: 'k', value: 1 } }] });
  graph.addFact({ project: 'p', key: 'next', value: 2 });
  assert.equal(graph.getJournal({ limit: 100 }).items.at(-1).seq, 100);
});

test('final review: an empty imported journal still preserves its declared sequence high-water mark', () => {
  const graph = createShadowGraph();
  graph.importData({ journalSeq: 99, journal: [] });
  graph.addFact({ project: 'p', key: 'next', value: 2 });
  assert.equal(graph.getJournal({ limit: 100 }).items.at(-1).seq, 100);
});

test('final review: legacy unscoped idempotency is migrated by payload project', () => {
  const graph = createShadowGraph();
  graph.importData({ idempotency: [{ key: 'decision:legacy-key', value: { id: 'old', kind: 'decision', project: 'legacy', title: 'Old', chosen: 'A' } }] });
  assert.equal(graph.addDecision({ project: 'legacy', title: 'retry', chosen: 'x', idempotencyKey: 'legacy-key' }).id, 'old');
  const fresh = graph.addDecision({ project: 'other', title: 'Fresh', chosen: 'B', idempotencyKey: 'legacy-key' });
  assert.equal(fresh.project, 'other');
});
