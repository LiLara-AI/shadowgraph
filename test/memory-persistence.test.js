import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createShadowGraph, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

function seedGraph() {
  const graph = createShadowGraph({ now: () => '2026-10-01T00:00:00.000Z' });
  graph.remember({
    project: 'assistant', scope: { userId: 'alice', agentId: 'helper' },
    memoryType: 'preference', key: 'tone', text: 'Concise', idempotencyKey: 'tone-v1'
  });
  graph.remember({
    project: 'assistant', scope: { userId: 'alice', agentId: 'helper' },
    memoryType: 'preference', key: 'tone', text: 'Concise and direct', idempotencyKey: 'tone-v2'
  });
  return graph;
}

function assertMemoryState(graph) {
  const history = graph.memoryHistory({
    project: 'assistant', scope: { userId: 'alice', agentId: 'helper' },
    memoryType: 'preference', key: 'tone'
  });
  assert.equal(history.items.length, 2);
  assert.deepEqual(history.items.map((item) => item.status), ['superseded', 'active']);
  assert.equal(graph.recall('direct', {
    project: 'assistant', scope: { userId: 'alice', agentId: 'helper' },
    currentAt: '2026-10-02T00:00:00.000Z'
  }).items[0].record.text, 'Concise and direct');
  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true);
  assert.equal(rebuilt.projection.records.filter((item) => item.kind === 'memory').length, 2);
}

test('schema 5 memory state survives JSON restart and journal rebuild', async (t) => {
  assert.equal(SCHEMA_VERSION, 5);
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, [1, 2, 3, 4, 5]);
  const directory = await scratchDirectory(t, 'shadowgraph-memory-json-');
  const store = createJsonFileStore(join(directory, 'data.json'));
  const graph = seedGraph();
  await store.save(graph.exportData());

  const restarted = createShadowGraph();
  restarted.importData(await store.load());
  assertMemoryState(restarted);
});

test('schema 5 memory state has JSON and SQLite restart parity', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-memory-sqlite-');
  let store;
  try { store = await createSqliteStore(join(directory, 'data.db')); }
  catch (error) { if (/requires Node/.test(error.message)) return t.skip(error.message); throw error; }
  const graph = seedGraph();
  await store.save(graph.exportData());
  store.close();

  const reopened = await createSqliteStore(join(directory, 'data.db'));
  const restarted = createShadowGraph();
  restarted.importData(await reopened.load());
  assertMemoryState(restarted);
  reopened.close();
});

test('schema 4 lifecycle snapshots migrate atomically to schema 5 with JSON and SQLite parity', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-schema4-lifecycle-');
  const legacy = {
    schemaVersion: 4,
    revision: 0,
    records: [{
      id: 'legacy-active', kind: 'decision', schemaVersion: 4, project: 'app',
      title: 'Legacy active', chosen: 'A', status: 'active', alternatives: [], confidence: 0.5
    }],
    facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null
  };
  const json = createJsonFileStore(join(directory, 'legacy.json'));
  await json.save(legacy);
  const fromJson = createShadowGraph();
  fromJson.importData(await json.load());
  assert.equal(fromJson.exportData().schemaVersion, SCHEMA_VERSION);
  assert.equal(fromJson.exportData().records[0].status, 'proposed');
  assert.equal(fromJson.exportData().records[0].migration.legacyDecisionStatus, 'active');

  let sqlite;
  try { sqlite = await createSqliteStore(join(directory, 'legacy.db')); }
  catch (error) { if (/requires Node/.test(error.message)) return t.skip(error.message); throw error; }
  await sqlite.save(legacy);
  sqlite.close();
  const reopened = await createSqliteStore(join(directory, 'legacy.db'));
  const fromSqlite = createShadowGraph();
  fromSqlite.importData(await reopened.load());
  reopened.close();
  assert.deepEqual(fromSqlite.exportData().records, fromJson.exportData().records);
  assert.deepEqual(fromSqlite.rebuild().projection.records, fromJson.rebuild().projection.records);
});
