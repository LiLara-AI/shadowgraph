import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../src/sqlite-storage.js';

test('SQLite migrates legacy single-payload files into relational tables', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch (error) { return t.skip(error.message); }
  const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-sqlite-migration-'));
  const file = join(dir, 'legacy.db');
  const db = new DatabaseSync(file);
  const payload = { schemaVersion: 2, revision: 4, records: [{ id: 'd1', kind: 'decision', title: 'Legacy', chosen: 'A' }], facts: [], relations: [], events: [] };
  db.exec('CREATE TABLE shadowgraph_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL)');
  db.prepare('INSERT INTO shadowgraph_state (id,payload) VALUES (1,?)').run(JSON.stringify(payload));
  db.close();
  const store = await createSqliteStore(file);
  try { const loaded = await store.load(); assert.equal(loaded.revision, 4); assert.equal(loaded.records[0].title, 'Legacy'); }
  finally { store.close(); }
});
