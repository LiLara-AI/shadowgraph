// FINAL PR37: policy reconciliation is outside the frozen R16 primitive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createStorage } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { ledgerPath, readLedger } from '../src/internal/deletion-knowledge.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';

const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const BACKENDS = [['json', {}], ['sqlite', sqlite.available ? {} : { skip: sqlite.reason }]];
const AT = '2026-10-10T00:00:00.000Z';
async function fixture(t, backend, { sourceDays = 30, destinationDays = 2, fresh = false } = {}) {
  const dir = await scratchDirectory(t, 'capture-retention-restore-');
  const env = { SHADOWGRAPH_HOME: join(dir, 'home') };
  const source = join(dir, 'source'); const destination = join(dir, 'destination'); const backup = join(dir, 'backup');
  const open = (file, options = {}) => createStorage({ type: backend, file, env, ...options });
  const writer = await open(source);
  const graph = createShadowGraph({ now: () => '2026-10-01T00:00:00.000Z' });
  // Install policy through the same store view the capture writer consumes.
  await writeFile(ledgerPath(source), JSON.stringify({ version: 1, retentionOverrides: [{ project: 'p', days: sourceDays }] }));
  graph.importData(await writer.load());
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-restore', text: 'synthetic restore raw', source: { event: 'Stop', sessionId: 'session' }, admission: { limits: { maxStoreBytes: 2 ** 30, maxQueueDepth: 100, maxItemBytes: 2 ** 20, maxItemsPerSession: 100 }, storeBytes: 0 } });
  await writer.save(privilegedSnapshot(graph));
  await backupFile(source, backup, { env, store: writer }); writer.close?.();
  if (!fresh) {
    const target = await open(destination);
    await target.save(privilegedSnapshot(createShadowGraph())); target.close?.();
    await writeFile(ledgerPath(destination), JSON.stringify({ version: 1, future: { preserved: true }, retentionOverrides: [{ project: 'p', days: destinationDays }] }));
  }
  const restore = async (options = {}) => {
    if (backend === 'json') return restoreFile(backup, destination, { env, now: AT, ...options });
    // createStorage materializes a fresh SQLite destination, as the existing
    // adapter does. Fresh-policy adoption must be explicit about this case.
    const target = await open(destination, { restoreFault: options.restoreFault });
    try { return await target.restore(backup, { now: AT, ...options }); } finally { target.close?.(); }
  };
  const load = async () => { const target = await open(destination); try { return await target.load(); } finally { target.close?.(); } };
  return { dir, env, source, destination, backup, restore, load, item, open };
}

for (const [backend, options] of BACKENDS) {
  for (const stage of ['beforePostStep', 'postStepLedgerWritten', 'postStepCommitted']) test(`capture retention restore ${backend}: interrupted ${stage} keeps effective policy and next-write recovery cannot revive raw`, options, async (t) => {
    // Both the consumer and resolver see a clock before the raw deadline,
    // regardless of the calendar day on which this regression runs.
    const RealDate = Date;
    const earlier = RealDate.parse('2026-10-02T00:00:00.000Z');
    globalThis.Date = class extends RealDate {
      constructor(...args) { super(...(args.length ? args : [earlier])); }
      static now() { return earlier; }
    };
    t.after(() => { globalThis.Date = RealDate; });
    const f = await fixture(t, backend, { sourceDays: 30, destinationDays: 5 });
    const result = await f.restore({ restoreFault: (at) => { if (at === stage) throw new Error('synthetic restore interruption'); } });
    assert.equal(result.completion, 'pending');
    const ledger = await readLedger(f.destination);
    assert.equal(ledger.pending[0].inputs.retention.overrides[0].days, 5);
    assert.equal(ledger.pending[0].inputs.retention.at, AT);
    const store = await f.open(f.destination);
    try {
      const graph = createShadowGraph(); graph.importData(await store.load());
      assert.equal(graph.search('', { project: 'p' }).completeness.capture.expired, 1, 'pending view honors the original restore instant before recovery');
      try { await store.save(privilegedSnapshot(graph)); } catch (error) { assert.equal(error.name, 'RevisionConflictError'); }
      const after = await store.load();
      assert.equal(JSON.stringify(after).includes('synthetic restore raw'), false);
      assert.equal((await readLedger(f.destination)).pending.length, 0);
      assert.equal((await readLedger(f.destination)).retentionOverrides[0].days, 5);
    } finally { store.close?.(); }
  });
  test(`capture retention restore ${backend}: no-effect reconciliation preserves callback policy and reports differing windows without control writes`, options, async (t) => {
    const f = await fixture(t, backend);
    const before = await readFile(ledgerPath(f.destination));
    const sourceBefore = await readFile(ledgerPath(f.backup));
    const running = createShadowGraph({ now: () => '2026-10-04T00:00:00.000Z' });
    const result = await f.restore({ now: '2026-10-01T00:00:00.000Z', afterReplace: (payload) => running.replaceData(payload) });
    assert.equal(running.search('', { project: 'p' }).completeness.capture.expired, 1);
    assert.deepEqual(result.retention.differences, [{ project: 'p', destinationDays: 2, backupDays: 30, effectiveDays: 2 }]);
    assert.deepEqual(await readFile(ledgerPath(f.destination)), before);
    assert.deepEqual(await readFile(ledgerPath(f.backup)), sourceBefore);
    const loaded = createShadowGraph({ now: () => '2026-10-04T00:00:00.000Z' }); loaded.importData(await f.load());
    assert.deepEqual(running.search('', { project: 'p' }).completeness.capture, loaded.search('', { project: 'p' }).completeness.capture);
  });
  test(`capture retention restore ${backend}: stricter destination controls survive and expiry completes before caller activation`, options, async (t) => {
    const f = await fixture(t, backend);
    const sourceBefore = await readFile(f.backup);
    const sidecarBefore = await readFile(ledgerPath(f.backup));
    const seen = [];
    const result = await f.restore({ afterReplace: (payload) => { seen.push(payload); assert.equal(JSON.stringify(payload).includes('synthetic restore raw'), false); } });
    assert.equal(result.completion, undefined);
    assert.ok(seen.length >= 1);
    assert.equal(result.retention.overrides.find((r) => r.project === 'p').days, 2);
    assert.deepEqual(result.retention.differences, [{ project: 'p', destinationDays: 2, backupDays: 30, effectiveDays: 2 }]);
    const ledger = JSON.parse(await readFile(ledgerPath(f.destination), 'utf8'));
    assert.equal(ledger.version, 1); assert.deepEqual(ledger.future, { preserved: true });
    assert.equal(ledger.retentionOverrides[0].days, 2);
    assert.equal(ledger.pending, undefined);
    assert.equal(JSON.stringify(await f.load()).includes('synthetic restore raw'), false);
    assert.deepEqual(await readFile(f.backup), sourceBefore);
    assert.deepEqual(await readFile(ledgerPath(f.backup)), sidecarBefore);
  });
  test(`capture retention restore ${backend}: stricter backup policy wins without extending recorded deadlines`, options, async (t) => {
    const f = await fixture(t, backend, { sourceDays: 2, destinationDays: 30 });
    const result = await f.restore();
    assert.equal(result.retention.overrides[0].days, 2);
    const payload = await f.load();
    const item = payload.records.find((r) => r.id === f.item.id);
    assert.equal(item.expiresAt, '2026-10-03T00:00:00.000Z');
    assert.equal(item.blockedReason, 'raw_expired');
  });
  test(`capture retention restore ${backend}: rejection inside activation restores exact destination policy bytes`, options, async (t) => {
    const f = await fixture(t, backend);
    const before = await readFile(ledgerPath(f.destination));
    await assert.rejects(f.restore({ afterReplace: () => { throw new Error('synthetic caller refusal'); } }), /synthetic caller refusal/u);
    assert.deepEqual(await readFile(ledgerPath(f.destination)), before);
    assert.equal((await f.load()).records.length, 0);
  });
}

for (const [backend, options] of BACKENDS) test(`capture retention restore ${backend}: genuinely fresh destination adopts backup policy with an explicit flag`, options, async (t) => {
  const f = await fixture(t, backend, { fresh: true });
  const result = await f.restore();
  assert.equal(result.retention.freshDestination, true);
  assert.equal(result.retention.overrides[0].days, 30);
  assert.equal((await readLedger(f.destination)).retentionOverrides[0].days, 30);
  assert.ok(JSON.stringify(await f.load()).includes('synthetic restore raw'));
});
