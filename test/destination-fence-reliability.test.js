import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readFile, stat, unlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDestinationFence, fenceLockPath } from '../src/revision-store.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const old = new Date('2000-01-01T00:00:00Z');
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const options = { staleLockMs: 20, lockTimeoutMs: 5000, lockPollIntervalMs: 2 };

// Removing an old guard can split the reclaimer mutex when its owner is paused.
test('an old reclaim guard is never stolen on elapsed time', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph reclaim guard ');
  const file = join(directory, 'state.json');
  const lock = await fenceLockPath(file);
  await writeFile(lock, 'dead-owner');
  await writeFile(`${lock}.reclaim`, `${process.pid}:paused-reclaimer`);
  await utimes(lock, old, old);
  await utimes(`${lock}.reclaim`, old, old);
  const identity = await stat(`${lock}.reclaim`);
  await assert.rejects(createDestinationFence(file, { ...options, lockTimeoutMs: 80 }).run(() => {
    assert.fail('a waiter entered through a held reclaim guard');
  }), { code: 'storage_lock_timeout' });
  assert.equal(await readFile(lock, 'utf8'), 'dead-owner');
  assert.equal((await stat(`${lock}.reclaim`)).ino, identity.ino);
});

// Pausing the real file write exposes the open-before-token window. Atomic
// publication must make this an unpublished contender, never an owner.
test('a paused token writer cannot enter alongside the next lock owner', { timeout: 15000 }, async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph token publication ');
  const file = join(directory, 'state.json');
  const lock = await fenceLockPath(file);
  const writing = deferred(), resume = deferred(), entered = deferred(), release = deferred(), firstState = deferred();
  const original = fs.promises.open, originalWrite = fs.promises.writeFile;
  let intercepted = false, inside = 0, most = 0;
  fs.promises.open = async (...args) => {
    const handle = await original(...args);
    if (!intercepted && String(args[0]).startsWith(lock) && args[1] === 'wx') {
      intercepted = true;
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (...values) => {
        await utimes(args[0], old, old);
        writing.resolve();
        await resume.promise;
        return write(...values);
      };
    }
    return handle;
  };
  fs.promises.writeFile = async (path, ...args) => {
    if (!intercepted && String(path).startsWith(lock)) {
      intercepted = true;
      writing.resolve();
      await resume.promise;
    }
    return originalWrite(path, ...args);
  };
  syncBuiltinESMExports();
  t.after(() => { fs.promises.open = original; fs.promises.writeFile = originalWrite; syncBuiltinESMExports(); });
  const first = createDestinationFence(file, options).run(async () => {
    inside += 1; most = Math.max(most, inside); firstState.resolve('entered'); inside -= 1;
  }, { onWait: () => firstState.resolve('waiting') });
  await writing.promise;
  const second = createDestinationFence(file, options).run(async () => {
    inside += 1; most = Math.max(most, inside); entered.resolve();
    await release.promise; inside -= 1;
  });
  try {
    await entered.promise;
    resume.resolve();
    assert.equal(await firstState.promise, 'waiting');
    assert.equal(most, 1);
  } finally {
    resume.resolve(); release.resolve(); await Promise.all([first, second]);
  }
});

test('a stale waiter preserves a replacement live lock and a live owner survives old mtime', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph replacement owner ');
  const file = join(directory, 'state.json');
  const lock = await fenceLockPath(file);
  await writeFile(lock, 'dead-owner');
  await utimes(lock, old, old);
  const replacement = `${process.pid}:replacement:owner`;
  await assert.rejects(createDestinationFence(file, { ...options, lockTimeoutMs: 80 }).run(() => assert.fail('live lock stolen'), {
    onWait: async () => { await writeFile(lock, replacement); await utimes(lock, old, old); }
  }), { code: 'storage_lock_timeout' });
  assert.equal(await readFile(lock, 'utf8'), replacement);
});

test('release leaves a replacement token alone, including when the operation throws', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph release identity ');
  const file = join(directory, 'state.json');
  const lock = await fenceLockPath(file);
  await assert.rejects(createDestinationFence(file, options).run(async () => {
    await unlink(lock);
    await writeFile(lock, `${process.pid}:replacement`);
    throw new Error('synthetic operation failure');
  }), /synthetic operation failure/);
  assert.equal(await readFile(lock, 'utf8'), `${process.pid}:replacement`);
});

test('stale-lock waiters serialize real updates without losing any write', { timeout: 30000 }, async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph stale update writers ');
  const file = join(directory, 'state.json');
  await writeFile(file, JSON.stringify({ schemaVersion: 7, revision: 0, records: [] }));
  const lock = await fenceLockPath(file);
  await writeFile(lock, 'dead-owner');
  await utimes(lock, old, old);
  let inside = 0, most = 0;
  await Promise.all(Array.from({ length: 16 }, async (_, index) => {
    const store = createJsonFileStore(file, options);
    try {
      await store.update(async (current) => {
        inside += 1; most = Math.max(most, inside);
        await delay(2);
        current.records.push({ id: `writer-${index}` });
        inside -= 1;
        return current;
      });
    } finally { store.close(); }
  }));
  const result = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(most, 1);
  assert.equal(result.revision, 16);
  assert.deepEqual(result.records.map(({ id }) => id).sort(), Array.from({ length: 16 }, (_, index) => `writer-${index}`).sort());
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});
