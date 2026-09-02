import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

test('SQLite storage round-trips relational graph and rejects stale revisions', async (t) => {
  let store;
  try {
    const dir = await scratchDirectory(t, 'shadowgraph-sqlite-');
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
    const dir = await scratchDirectory(t, 'shadowgraph-sqlite-backup-');
    store = await createSqliteStore(join(dir, 'graph.db'));
    await store.save({ schemaVersion: 2, records: [{ id: 'd1', kind: 'decision', project: 'default', status: 'active', title: 'Backup decision', chosen: 'SQLite' }], facts: [], relations: [], events: [] });
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

test('SQLite create, load, save, backup, restore, rollback, and close leave no live handles or sidecars', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { return t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); }
  const directory = await scratchDirectory(t, 'shadowgraph sqlite handle lifecycle ');
  const file = join(directory, 'live state with spaces.db');
  const backup = join(directory, 'backup source with spaces.db');
  const active = new Set();
  let opened = 0;
  let closed = 0;
  const store = await createSqliteStore(file, {
    openDatabase(path, options) {
      const handle = options ? new DatabaseSync(path, options) : new DatabaseSync(path);
      active.add(handle);
      opened += 1;
      return handle;
    },
    closeHandle(handle) {
      assert.equal(active.delete(handle), true, 'every close must correspond to one tracked open');
      closed += 1;
      handle.close();
    }
  });
  const assertIdle = async (stage) => {
    assert.equal(active.size, 0, `${stage} must not retain a DatabaseSync handle`);
    const names = await readdir(directory);
    assert.equal(names.includes('live state with spaces.db-wal'), false, `${stage} must not retain WAL`);
    assert.equal(names.includes('live state with spaces.db-shm'), false, `${stage} must not retain SHM`);
  };
  await assertIdle('create');
  const payload = {
    schemaVersion: 2,
    records: [{ id: 'lifecycle', kind: 'decision', project: 'default', status: 'active', title: 'Lifecycle', chosen: 'safe' }],
    facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null
  };
  await store.save(payload);
  await assertIdle('save');
  const loaded = await store.load();
  assert.equal(loaded.revision, 1);
  await assertIdle('load');
  await store.backup(backup);
  await assertIdle('backup');
  await store.save(loaded);
  assert.equal((await store.load()).revision, 2);
  await store.restore(backup);
  assert.equal((await store.load()).revision, 3);
  await assertIdle('restore');
  await assert.rejects(
    store.restore(backup, { afterReplace() { throw new Error('injected lifecycle rollback'); } }),
    (error) => error.code === 'sqlite_restore_rolled_back' && /injected lifecycle rollback/.test(error.message)
  );
  assert.equal((await store.load()).revision, 3, 'rollback must preserve the exact prior revision');
  await assertIdle('rollback');

  store.close();
  assert.doesNotThrow(() => store.close(), 'close remains idempotent after all operation-scoped handles are gone');
  await assert.rejects(store.load(), /closed/);
  await assert.rejects(store.save(loaded), /closed/);
  await assert.rejects(store.backup(join(directory, 'closed backup.db')), /closed/);
  await assert.rejects(store.restore(backup), /closed/);
  assert.equal(active.size, 0);
  assert.equal(closed, opened, 'all SQLite open paths must have a matching close');
  await unlink(file);
  await assert.rejects(stat(file), (error) => error.code === 'ENOENT', 'the closed destination must be removable on Windows');
});
