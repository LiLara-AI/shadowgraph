// Keyed merge and derived-index regression coverage.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedRebuild } from '../src/internal/snapshot.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const now = () => '2026-10-04T00:00:00.000Z';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const ordered = values => [...values].sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
function parity(graph, hardGap = false) {
  const snapshot = privilegedSnapshot(graph), report = privilegedRebuild(graph);
  assert.equal(report.rebuildable, !hardGap, report.reason); assert.deepEqual(report.skipped, []);
  if (hardGap) assert.equal(report.reason, 'journal contains unexplained sequence gaps inside the replay range');
  for (const key of ['records', 'facts', 'relations', 'idempotency']) assert.deepEqual(ordered(report.projection[key]), ordered(snapshot[key]), key);
  validateRestorePayload(snapshot, { now }); return snapshot;
}
for (const owner of [{ project: 'p' }, { originId: 'origin-a' }]) {
  const label = owner.project ? 'project' : 'origin';
  test(`${label} unrelated journal-less overwrite preserves a changed keyed decision and its retry`, () => {
    const graph = createShadowGraph({ now });
    const input = { ...owner, title: 'A', chosen: 'a', idempotencyKey: 'a' };
    const a = graph.addDecision(input), b = graph.addDecision({ ...owner, title: 'B', chosen: 'b' });
    graph.updateDecisionStatus(a.id, 'planned', owner);
    const before = privilegedSnapshot(graph), changed = { ...before.records.find(x => x.id === b.id), title: 'Changed' };
    graph.importData({ schemaVersion: 7, records: [changed] });
    const after = parity(graph);
    assert.deepEqual(after.records.find(x => x.id === a.id), before.records.find(x => x.id === a.id));
    assert.equal(after.records.find(x => x.id === b.id).title, 'Changed');
    assert.equal(graph.addDecision(input).id, a.id);
    assert.equal(privilegedSnapshot(graph).journalSeq, after.journalSeq, 'retry creates no new entry');
  });
}
for (const backend of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) test(`${backend} keyed overwrite survives durable load, rebuild and a later ${mode} purge/restore`, backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
  const dir = await scratchDirectory(t, 'pr44-keyed-merge-'), file = join(dir, backend === 'json' ? 'store.json' : 'store.db');
  const env = { SHADOWGRAPH_HOME: join(dir, 'home') }, graph = createShadowGraph({ now });
  const a = graph.addDecision({ project: 'keep', title: 'A', chosen: 'a', idempotencyKey: 'a' });
  const b = graph.addDecision({ project: 'remove', title: 'B', chosen: 'b' });
  graph.updateDecisionStatus(a.id, 'planned', { project: 'keep' });
  const snapshot = privilegedSnapshot(graph);
  graph.importData({ schemaVersion: 7, records: [{ ...snapshot.records.find(x => x.id === b.id), title: 'Changed' }] });
  const store = await createStorage({ type: backend, file, env });
  try {
    await store.save(parity(graph));
    const backup = join(dir, 'backup'); await backupFile(file, backup, { store, env });
    const backupBytes = await readFile(backup);
    const loaded = createShadowGraph({ now }); loaded.importData(await store.load()); parity(loaded);
    loaded.purgeProject('remove', { mode }); await store.save(parity(loaded, mode === 'hard'));
    const final = createShadowGraph({ now }); final.importData(await store.load()); const after = parity(final, mode === 'hard');
    assert.equal(after.records.length, 1); assert.equal(after.records[0].id, a.id); assert.equal(after.records[0].status, 'planned');
    const destination = join(dir, 'restored'), restored = await createStorage({ type: backend, file: destination, env });
    try {
      if (backend === 'json') await restoreFile(backup, destination, { env, now: now() }); else await restored.restore(backup, { now: now() });
      const reopened = createShadowGraph({ now }); reopened.importData(await restored.load());
      const result = parity(reopened, mode === 'hard');
      assert.equal(result.records.length, 1); assert.equal(result.records[0].id, a.id); assert.equal(result.records[0].status, 'planned');
      assert.deepEqual(await readFile(backup), backupBytes);
    } finally { restored.close(); }
  } finally { store.close(); }
});
test('keyed overwrite does not normalize an imported retry to a different canonical entity', () => {
  const graph = createShadowGraph({ now });
  const a = graph.addDecision({ project: 'p', title: 'A', chosen: 'a', idempotencyKey: 'a' });
  const b = graph.addDecision({ project: 'p', title: 'B', chosen: 'b' });
  graph.updateDecisionStatus(a.id, 'planned', { project: 'p' });
  const before = privilegedSnapshot(graph), value = before.records.find(x => x.id === b.id);
  for (const retry of [{ ...value, title: 'corrupted' }, { ...value, project: 'q' }]) {
    assert.throws(() => graph.importData({ schemaVersion: 7, records: [{ ...value, title: 'Changed' }], idempotency: [{ key: before.idempotency[0].key, value: retry }] }));
    assert.deepEqual(privilegedSnapshot(graph), before);
  }
});

for (const owner of [{ project: 'p' }, { originId: 'origin-a' }]) test(`keyed memory index refresh remains readable and replayable for ${owner.project ? 'project' : 'origin'} ownership`, () => {
  const graph = createShadowGraph({ now }), input = { ...owner, memoryType: 'note', key: 'indexed', text: 'Canonical experience', idempotencyKey: 'indexed' };
  const memory = graph.remember(input).memory;
  const before = privilegedSnapshot(graph), originalRetry = before.idempotency[0];
  graph.importData({ schemaVersion: 7, idempotency: [{ key: originalRetry.key + '-alias', value: originalRetry.value }] });
  const updated = graph.remember({ ...input, idempotencyKey: undefined, embedding: [1, 0] });
  assert.equal(updated.operation, 'NOOP'); assert.equal(updated.indexUpdated, true); assert.equal(updated.memory.id, memory.id);
  const snapshot = parity(graph);
  assert.deepEqual(snapshot.idempotency[0].value.embedding, [1, 0]);
  assert.equal(snapshot.idempotency.length, 2);
  assert.ok(snapshot.idempotency.every(item => JSON.stringify(item.value.embedding) === '[1,0]'));
  const indexed = snapshot.journal.filter(item => item.type === 'memory.indexed');
  assert.equal(indexed.length, 2);
  assert.deepEqual(new Set(indexed.map(item => item.idempotencyKey)), new Set(snapshot.idempotency.map(item => item.key)));
  assert.deepEqual(graph.remember(input).memory.embedding, [1, 0]);
  assert.equal(privilegedSnapshot(graph).journalSeq, snapshot.journalSeq);
});

test('keyed index refresh reserves capacity for all aliases before changing any state', () => {
  const graph = createShadowGraph({ now });
  const input = { project: 'p', memoryType: 'note', key: 'indexed', text: 'Experience', idempotencyKey: 'retry' };
  graph.remember(input);
  const retry = privilegedSnapshot(graph).idempotency[0];
  graph.importData({ schemaVersion: 7, idempotency: [{ key: retry.key + '-alias', value: retry.value }] });
  graph.importData({ schemaVersion: 7, journalSeq: Number.MAX_SAFE_INTEGER - 1 });
  const before = privilegedSnapshot(graph);
  assert.throws(() => graph.remember({ ...input, idempotencyKey: undefined, embedding: [1, 0] }), /overflow/i);
  assert.deepEqual(privilegedSnapshot(graph), before);
});

test('a journal-less overwrite preserves keyed fact lifecycle and still rejects a forged retry value', () => {
  let instant = '2026-10-04T00:00:00.000Z';
  const graph = createShadowGraph({ now: () => instant });
  const input = { project: 'p', key: 'version', value: 'old', idempotencyKey: 'fact' };
  const old = graph.addFact(input), unrelated = graph.addDecision({ project: 'p', title: 'Other', chosen: 'A' });
  instant = '2026-10-04T00:01:00.000Z'; graph.addFact({ project: 'p', key: 'version', value: 'new' });
  const before = privilegedSnapshot(graph), next = { ...before.records.find(x => x.id === unrelated.id), title: 'Changed' };
  graph.importData({ schemaVersion: 7, records: [next] });
  const after = parity(graph);
  assert.equal(after.facts.find(x => x.id === old.id).status, 'superseded');
  assert.equal(graph.addFact(input).status, 'superseded');
  const retry = after.idempotency.find(x => x.value.id === old.id);
  assert.throws(() => graph.importData({ schemaVersion: 7, records: [{ ...next, title: 'Again' }], idempotency: [{ ...retry, value: { ...retry.value, value: 'FORGED' } }] }));
  assert.deepEqual(privilegedSnapshot(graph), after);
});

test('origin retry corruption cannot hide behind a journal-less overwrite parity normalization', () => {
  const graph = createShadowGraph({ now }), input = { originId: 'a', title: 'Source', chosen: 'A', idempotencyKey: 'retry' };
  const a = graph.addDecision(input), b = graph.addDecision({ originId: 'a', title: 'Other', chosen: 'B' });
  graph.updateDecisionStatus(a.id, 'planned', { originId: 'a' });
  const before = privilegedSnapshot(graph), retry = before.idempotency[0];
  assert.throws(() => graph.importData({ schemaVersion: 7, records: [{ ...before.records.find(x => x.id === b.id), title: 'Changed' }],
    idempotency: [{ key: retry.key, value: { ...retry.value, originId: 'b' } }] }));
  assert.deepEqual(privilegedSnapshot(graph), before);
});
