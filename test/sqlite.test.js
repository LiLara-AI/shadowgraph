import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../src/sqlite-storage.js';

test('SQLite storage round-trips the v0.26 graph when node:sqlite is available', async (t) => {
  let store;
  try {
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-sqlite-'));
    store = await createSqliteStore(join(dir, 'graph.db'));
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  try {
    const payload = { schemaVersion: 2, records: [{ id: 'd1', kind: 'decision' }], facts: [], relations: [{ id: 'r1', from: 'd1', to: 'f1', relation: 'depends_on' }], events: [] };
    await store.save(payload);
    assert.deepEqual(await store.load(), payload);
  } finally {
    store.close();
  }
});
