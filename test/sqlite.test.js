import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteStore } from '../src/sqlite-storage.js';

test('SQLite storage round-trips relational graph and rejects stale revisions', async (t) => {
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
    // G4-B: the journal is persisted in the SAME transaction as the state, so the
    // loaded envelope always carries journal/journalSeq/journalEpoch.
    assert.deepEqual(await store.load(), { ...payload, reviewSignals: [], idempotency: [], revision: 1, journal: [], journalSeq: 0, journalEpoch: null });
    await assert.rejects(store.save({ ...payload, revision: 0 }), /revision conflict/);
    await store.save({ ...payload, revision: 1, records: [{ id: 'd2', kind: 'decision' }] });
    assert.equal((await store.load()).revision, 2);
  } finally { store.close(); }
});

test('SQLite backup uses a consistent database snapshot', async (t) => {
  let store;
  try {
    const dir = await mkdtemp(join(tmpdir(), 'shadowgraph-sqlite-backup-'));
    store = await createSqliteStore(join(dir, 'graph.db'));
    await store.save({ schemaVersion: 2, records: [{ id: 'd1', kind: 'decision' }], facts: [], relations: [], events: [] });
    const destination = join(dir, 'copy.db');
    await store.backup(destination);
    await store.backup(destination);
    const copy = await createSqliteStore(destination);
    assert.equal((await copy.load()).records[0].id, 'd1');
    copy.close();
    await store.restore(destination);
    assert.equal((await store.load()).records[0].id, 'd1');
  } catch (error) { if (/requires Node/.test(error.message)) return t.skip(error.message); throw error; }
  finally { store?.close(); }
});
