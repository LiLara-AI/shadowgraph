import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { chmod, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { createDestinationFence, fenceLockPath } from '../src/revision-store.js';
import { createJsonFileStore } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const busy = () => Object.assign(new Error('synthetic file busy'), { code: 'EPERM' });
const payload = (title) => ({ revision: 0, records: [{ id: 'decision-io', kind: 'decision', title, chosen: 'local', project: 'alpha', status: 'active', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] });

test('a transient lock-release error preserves the completed result and permits the next writer', async t => {
  const dir = await scratchDirectory(t, 'closeout release ');
  const file = join(dir, 'memory.json'), lock = await fenceLockPath(file);
  const original = fs.promises.unlink;
  let failures = 0;
  fs.promises.unlink = async (path, ...args) => {
    if (String(path) === lock && failures++ < 2) throw busy();
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const fence = createDestinationFence(file, { lockTimeoutMs: 100 });
    assert.equal(await fence.run(() => 77), 77);
    assert.equal(await fence.run(() => 88), 88);
  } finally { fs.promises.unlink = original; syncBuiltinESMExports(); }
});

test('a failed JSON payload sync refuses replacement and preserves the previous store', async t => {
  const dir = await scratchDirectory(t, 'closeout sync ');
  const file = join(dir, 'memory.json');
  const store = createJsonFileStore(file);
  await store.save(payload('old'));
  const before = await readFile(file);
  const original = fs.promises.open;
  fs.promises.open = async (path, ...args) => {
    const handle = await original(path, ...args);
    if (basename(String(path)).startsWith('.memory.json.') && String(path).endsWith('.tmp')) {
      handle.sync = async () => { throw Object.assign(new Error('synthetic sync failure'), { code: 'EIO' }); };
    }
    return handle;
  };
  syncBuiltinESMExports();
  try { await assert.rejects(store.save({ ...payload('new'), revision: 1 }), { code: 'EIO' }); }
  finally { fs.promises.open = original; syncBuiltinESMExports(); }
  assert.deepEqual(await readFile(file), before);
});

test('exhausted release retries preserve the operation outcome and the original operation failure', async t => {
  const dir = await scratchDirectory(t, 'closeout release outcome ');
  const original = fs.promises.unlink;
  fs.promises.unlink = async (path, ...args) => {
    if (String(path).startsWith(dir) && String(path).endsWith('.lock')) throw busy();
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(createDestinationFence(join(dir, 'completed.json')).run(() => 77), error => {
      assert.equal(error.code, 'storage_lock_release_failed');
      assert.equal(error.operationCompleted, true);
      assert.equal(error.operationResult, 77);
      return true;
    });
    const failure = new Error('operation failed before completion');
    await assert.rejects(createDestinationFence(join(dir, 'failed.json')).run(() => { throw failure; }), error => {
      assert.equal(error, failure);
      assert.equal(error.releaseCause.code, 'EPERM');
      return true;
    });
  } finally { fs.promises.unlink = original; syncBuiltinESMExports(); }
});

test('JSON backup retries a transient replacement error and keeps a usable snapshot', async t => {
  const dir = await scratchDirectory(t, 'closeout backup ');
  const source = join(dir, 'memory.json'), target = join(dir, 'snapshot.json');
  await createJsonFileStore(source).save(payload('backup'));
  const original = fs.promises.rename;
  let failures = 0;
  fs.promises.rename = async (from, to) => {
    if (String(to) === target && failures++ < 2) throw busy();
    return original(from, to);
  };
  syncBuiltinESMExports();
  try { await backupFile(source, target); }
  finally { fs.promises.rename = original; syncBuiltinESMExports(); }
  assert.equal(JSON.parse(await readFile(target, 'utf8')).records[0].title, 'backup');
});

test('syncing a backup copy preserves a readable read-only source and its final mode', async t => {
  const dir = await scratchDirectory(t, 'closeout readonly backup ');
  const source = join(dir, 'memory.json'), target = join(dir, 'snapshot.json');
  await createJsonFileStore(source).save(payload('read-only backup'));
  await chmod(source, 0o400);
  const before = await readFile(source);
  try {
    await backupFile(source, target);
    assert.deepEqual(await readFile(target), before);
    assert.deepEqual(await readFile(source), before);
    if (process.platform !== 'win32') {
      assert.equal((await stat(source)).mode & 0o777, 0o400);
      assert.equal((await stat(target)).mode & 0o777, 0o400);
    }
  } finally { await chmod(source, 0o600); await chmod(target, 0o600).catch(() => {}); }
});

test('JSON restore retries transient replacement and rollback failures without losing old bytes', async t => {
  const dir = await scratchDirectory(t, 'closeout restore ');
  const source = join(dir, 'snapshot.json'), target = join(dir, 'memory.json');
  // An empty valid snapshot isolates the filesystem primitive from domain semantics.
  await writeFile(source, JSON.stringify({ revision: 0, records: [] }));
  await writeFile(target, JSON.stringify({ revision: 0, records: [] }));
  const before = await readFile(target);
  let replacementFailures = 0, rollbackFailures = 0;
  const restoreFs = { rename: async (from, to) => {
    if (String(from).endsWith('.tmp') && replacementFailures++ < 2) throw busy();
    if (String(from).endsWith('.recovery') && rollbackFailures++ < 2) throw busy();
    return rename(from, to);
  } };
  await assert.rejects(restoreFile(source, target, { env: { SHADOWGRAPH_HOME: join(dir, 'home') }, restoreFs, afterReplace: () => { throw new Error('activation refused'); } }), { code: 'json_restore_rolled_back' });
  assert.deepEqual(await readFile(target), before);
  assert.ok(replacementFailures >= 3 && rollbackFailures >= 3);
});
