import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShadowGraph, SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';

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

test('schema 4 memory state survives JSON restart and journal rebuild', async () => {
  assert.equal(SCHEMA_VERSION, 4);
  assert.deepEqual(SUPPORTED_SCHEMA_VERSIONS, [1, 2, 3, 4]);
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-memory-json-'));
  const store = createJsonFileStore(join(directory, 'data.json'));
  const graph = seedGraph();
  await store.save(graph.exportData());

  const restarted = createShadowGraph();
  restarted.importData(await store.load());
  assertMemoryState(restarted);
});

test('schema 4 memory state has JSON and SQLite restart parity', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-memory-sqlite-'));
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
