import test from 'node:test';
import assert from 'node:assert/strict';
import fsPromises, { open, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { measureWrites, observeFileSystem, windowPhases } from '../scripts/context-size.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

// The write-budget measurement's phase observer (PR #12 F1 diagnostic) only
// times calls. These checks hold its arithmetic, its content-free records and
// the restoration of the file-system functions it wraps.
const event = (op, role, started, ended, code) => ({ op, role, started, ended, ...(code ? { code } : {}) });

test('a save window splits into lock wait and polls, rename retries and backoff, reads, the write, the gap before it and the remainder', () => {
  const events = [
    event('open', 'lock', 0, 1, 'EEXIST'), event('open', 'lock', 26, 27, 'EPERM'), event('open', 'lock', 52, 53),
    event('handle.writeFile', 'lock', 53, 54),
    event('readFile', 'store', 54, 57), event('stat', 'other', 57, 58, 'ENOENT'),
    event('writeFile', 'temp', 70, 74),
    event('rename', 'temp', 74, 75, 'EPERM'), event('rename', 'temp', 95, 96),
    event('handle.close', 'lock', 96, 97), event('readFile', 'lock', 97, 98), event('unlink', 'lock', 98, 99),
    event('readFile', 'store', 200, 201)
  ];
  const save = windowPhases({ started: 0, ended: 100, events, gc: [{ started: 60, ended: 64 }] });
  assert.deepEqual(save.calls, { lock: 7, store: 1, temp: 3, other: 1 });
  assert.deepEqual(save.lock, { attempts: 3, acquired: 1, contentionCalls: 2, codes: { EEXIST: 1, EPERM: 1 }, waitMs: 53, pollMs: 50, handleAndReleaseMs: 4 });
  assert.deepEqual(save.rename, { attempts: 2, committed: 1, codes: { EPERM: 1 }, callMs: 2, backoffMs: 20 });
  assert.equal(save.writes, 1);
  assert.deepEqual([save.ms, save.readMs, save.writeMs, save.preWriteGapMs, save.fsMs, save.gcMs, save.unaccountedMs], [100, 3, 4, 12, 17, 4, 1]);
  assert.deepEqual(save.otherFs, { calls: 1, ms: 1, codes: { ENOENT: 1 } });
  const delivery = windowPhases({ started: 0, ended: 300, events, excluded: [{ started: 0, ended: 100 }] });
  assert.deepEqual([delivery.ms, delivery.readMs, delivery.lock.attempts, delivery.rename.attempts, delivery.fsMs], [200, 1, 0, 0, 1]);
});

test('the observer records only operation, file role, interval and error code, and restores what it wrapped', async (t) => {
  const root = await scratchDirectory(t), original = { rename: fsPromises.rename, open: fsPromises.open };
  const observation = observeFileSystem();
  try {
    await writeFile(join(root, 'store.json.lock'), 'token');
    await open(join(root, 'store.json.lock'), 'wx').then((handle) => handle.close(), () => {});
    await rename(join(root, '.store.json.1.tmp'), join(root, 'store.json')).catch(() => {});
  } finally { observation.stop(); }
  assert.deepEqual(observation.events.map(({ op, role, code }) => [op, role, code]), [['writeFile', 'lock', undefined], ['open', 'lock', 'EEXIST'], ['rename', 'temp', 'ENOENT']]);
  assert.ok(observation.events.every((item) => Object.keys(item).every((key) => ['op', 'role', 'started', 'ended', 'code'].includes(key))));
  assert.equal(JSON.stringify(observation.events).includes(root), false);
  assert.deepEqual([fsPromises.rename, fsPromises.open, rename, open], [original.rename, original.open, original.rename, original.open]);
});

test('every measured save carries phases that account for its whole window, with no path or content', async () => {
  const original = fsPromises.rename;
  const report = await measureWrites({ deliveries: 1 });
  assert.equal(fsPromises.rename, original);
  for (const tier of ['grant', 'nullReference']) {
    assert.equal(report[tier].phases.length, report[tier].deliveries);
    report[tier].phases.forEach((delivery, index) => {
      assert.equal(delivery.saves.length, report[tier].saveMs[index].length);
      delivery.saves.forEach((save, at) => {
        assert.equal(save.ms, report[tier].saveMs[index][at]);
        assert.ok(save.lock.attempts >= 1 && save.rename.attempts >= 1 && save.writeMs > 0, JSON.stringify(save));
        const parts = save.fsMs + save.lock.pollMs + save.rename.backoffMs + save.preWriteGapMs + save.unaccountedMs;
        assert.ok(parts >= save.ms - 0.01 && save.unaccountedMs >= 0, JSON.stringify(save));
      });
    });
  }
  assert.doesNotMatch(JSON.stringify([report.grant.phases, report.nullReference.phases]), /[\\/]|store\.json|context-size|Synthetic|regional/);
});
