// Standalone semantic reader floor before the final PR-37 lifecycle writer.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { DELETION_VIEW, attachLedgerView, ledgerPath, readLedger, registryFile } from '../src/internal/deletion-knowledge.js';
import { captureRawExpired, effectiveCaptureExpiry } from '../src/internal/capture-retention.js';
import { privilegedRebuild, privilegedRecordCapture, privilegedSnapshot, privilegedTransitionCapture, privilegedValidate } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const START = '2026-10-01T00:00:00.000Z';
const ADMISSION = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 }, storeBytes: 0 };
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const BACKENDS = [['json', {}], ['sqlite', sqlite.available ? {} : { skip: sqlite.reason }]];
const record = (graph, project = 'p') => privilegedRecordCapture(graph, { project, originId: 'origin-retention', text: `raw ${project}`, admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId: `session-${project}`, role: 'user' } });
const block = (graph, project = 'p') => graph.search('', { project }).completeness.capture;
const lease = { leaseId: 'lease', ownerId: 'worker', ownerBootId: 'boot', leaseExpiresAt: '2026-11-01T00:00:00.000Z' };

async function fixture(t, backend) {
  const dir = await scratchDirectory(t, 'retention-reader-');
  const file = join(dir, `store.${backend === 'json' ? 'json' : 'db'}`);
  const env = { SHADOWGRAPH_HOME: join(dir, 'home') };
  const store = await createStorage({ type: backend, file, env });
  t.after(() => store.close?.());
  const graph = createShadowGraph({ now: () => START });
  const item = record(graph);
  record(graph, 'q');
  graph.setRevision(await store.save(privilegedSnapshot(graph)));
  return { dir, file, env, store, graph, item, backend };
}
const writeControls = (f, retentionOverrides, extra = {}) => writeFile(ledgerPath(f.file), JSON.stringify({ version: 1, retentionOverrides, futureMember: { carried: true }, ...extra }));
const restore = (f, source, options = {}) => f.backend === 'json' ? restoreFile(source, f.file, { env: f.env, ...options }) : f.store.restore(source, options);
const backup = (f, name) => backupFile(f.file, join(f.dir, name), { env: f.env, store: f.store });

function stampDeadlines(value) {
  if (value === null || typeof value !== 'object') return;
  if (value.kind === 'capture') value.expiresAt = '2026-10-03T00:00:00.000Z';
  for (const child of Object.values(value)) stampDeadlines(child);
}

// Model a later writer's committed payload beside its interrupted restore
// record without asking this reader to perform an unsupported restore.
async function stampStoredDeadlines(f, { wal = false } = {}) {
  if (f.backend === 'json') {
    const payload = JSON.parse(await readFile(f.file, 'utf8'));
    stampDeadlines(payload);
    await writeFile(f.file, JSON.stringify(payload));
    return;
  }
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(f.file);
  try {
    if (wal) db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    for (const table of ['shadowgraph_entities', 'shadowgraph_journal', 'shadowgraph_idempotency']) {
      for (const row of db.prepare(`SELECT rowid, payload FROM ${table}`).all()) {
        const payload = JSON.parse(row.payload);
        stampDeadlines(payload);
        db.prepare(`UPDATE ${table} SET payload = ? WHERE rowid = ?`).run(JSON.stringify(payload), row.rowid);
      }
    }
  } finally { if (!wal) db.close(); }
  return wal ? db : null;
}

for (const [backend, options] of BACKENDS) {
  test(`retention reader ${backend}: load exposes validated overrides without losing unknown members on save or backup`, options, async (t) => {
    const f = await fixture(t, backend);
    const overrides = [{ project: 'p', days: 1, futureWindowProperty: true }];
    await writeControls(f, overrides);
    const controls = await readFile(ledgerPath(f.file), 'utf8');
    const loaded = await f.store.load();
    assert.deepEqual(loaded[DELETION_VIEW].retentionOverrides, overrides);
    assert.deepEqual((await readLedger(f.file)).retentionOverrides, overrides);
    await f.store.save(loaded);
    await backup(f, 'copy');
    assert.equal(await readFile(ledgerPath(f.file), 'utf8'), controls);
    assert.equal(await readFile(ledgerPath(join(f.dir, 'copy')), 'utf8'), controls);
  });

  test(`retention reader ${backend}: malformed controls fail closed on load, save, backup and restore with no durable change`, options, async (t) => {
    const f = await fixture(t, backend);
    await backup(f, 'before');
    for (const malformed of [null, {}, [{ days: 1 }], [{ project: '', days: 1 }], [{ project: 'p', days: 0 }], [{ project: 'p', days: -1 }], [{ project: 'p', days: 1.5 }], [{ project: 'p', days: '7' }], [{ project: 'p', days: 1 }, { project: 'p', days: 2 }]]) {
      await writeControls(f, malformed);
      const before = [await readFile(f.file), await readFile(ledgerPath(f.file))];
      for (const operation of [() => f.store.load(), () => f.store.save(privilegedSnapshot(f.graph)), () => backup(f, 'refused'), () => restore(f, join(f.dir, 'before'))]) {
        await assert.rejects(operation(), (error) => error.code === 'control_ledger_malformed' || error.cause?.code === 'control_ledger_malformed');
        assert.deepEqual([await readFile(f.file), await readFile(ledgerPath(f.file))], before);
      }
    }
  });

  test(`retention reader ${backend}: effective expiry is checked at consumption time and scoped, while save/rebuild preserve raw`, options, async (t) => {
    const f = await fixture(t, backend);
    await writeControls(f, [{ project: 'p', days: 1 }]);
    let clock = '2026-10-01T23:59:59.999Z';
    const graph = createShadowGraph({ now: () => clock });
    graph.importData(await f.store.load());
    const before = privilegedSnapshot(graph);
    assert.equal(block(graph).pending, 1);
    clock = '2026-10-02T00:00:00.000Z';
    assert.equal(block(graph).pending, 0);
    assert.equal(block(graph).blocked, 1);
    assert.equal(block(graph, 'q').pending, 1);
    assert.equal(block(graph).gaps.some((gap) => gap.reason === 'raw_expired'), true);
    assert.match(graph.search('', { project: 'p' }).completeness.limitation.detail, /re-extraction/i);
    assert.throws(() => privilegedTransitionCapture(graph, { id: f.item.id, to: 'processing', lease }), { code: 'capture_raw_expired' });
    assert.deepEqual(privilegedSnapshot(graph), before, 'reader never sweeps or mutates raw');
    assert.equal(privilegedValidate(graph).valid, true);
    const rebuilt = privilegedRebuild(graph);
    assert.equal(rebuilt.rebuildable, true);
    graph.setRevision(await f.store.save(privilegedSnapshot(graph)));
    assert.deepEqual((await f.store.load()).captureContent, before.captureContent);
    assert.equal(block(graph).blocked, 1, 'rebuild/save cannot discard the effective policy');
    graph.replaceData(privilegedSnapshot(graph));
    assert.equal(block(graph).blocked, 1, 'replaceData keeps the installed policy');
  });

  test(`retention reader ${backend}: merge cannot replace a stricter installed policy with a looser source`, options, async (t) => {
    const f = await fixture(t, backend);
    await writeControls(f, [{ project: 'p', days: 1 }]);
    const graph = createShadowGraph({ now: () => '2026-10-02T00:00:00.000Z' });
    graph.importData(await f.store.load());
    const before = privilegedSnapshot(graph);
    await writeControls(f, [{ project: 'p', days: 30 }]);
    const incoming = await f.store.load();
    assert.throws(() => graph.importData(incoming), { code: 'purge_aware_restore_unsupported_at_this_build' });
    assert.deepEqual(privilegedSnapshot(graph), before);
  });

  test(`retention reader ${backend}: expiry is independent of quarantine and leaves canonical and persistence evidence intact`, options, async (t) => {
    const f = await fixture(t, backend);
    const decision = f.graph.addDecision({ project: 'q', title: 'Accepted experience', chosen: 'keep the evidence' });
    f.graph.setRevision(await f.store.save(privilegedSnapshot(f.graph)));
    await writeControls(f, [{ project: 'p', days: 1 }], { quarantine: [{ token: f.item.erasureToken, at: START }] });
    const loaded = await f.store.load();
    const graph = createShadowGraph({ now: () => '2026-10-03T00:00:00.000Z' });
    graph.importData(loaded);
    const before = privilegedSnapshot(graph);
    assert.equal(captureRawExpired(before.records.find((item) => item.id === f.item.id), loaded[DELETION_VIEW].retentionOverrides, '2026-10-03T00:00:00.000Z'), true);
    const result = graph.search('', { project: 'p' });
    assert.equal(result.completeness.quarantined, 1);
    assert.equal(block(graph).blocked, 0, 'withheld identity is not disclosed as an ordinary expired item');
    assert.equal(before.records.some((item) => item.id === decision.id), true);
    assert.deepEqual(privilegedSnapshot(graph), before);
    assert.deepEqual(before.captureContent, loaded.captureContent, 'the reader neither deletes source evidence nor releases quarantine');
  });

  for (const side of ['destination', 'backup']) test(`retention reader ${backend}: ${side} overrides refuse unsupported restore before writes`, options, async (t) => {
    const f = await fixture(t, backend);
    if (side === 'backup') await writeControls(f, [{ project: 'p', days: 1 }]);
    await backup(f, 'source');
    if (side === 'destination') await writeControls(f, [{ project: 'p', days: 2 }]);
    const before = [await readFile(f.file), await readFile(ledgerPath(f.file))];
    await assert.rejects(restore(f, join(f.dir, 'source')), { code: 'purge_aware_restore_unsupported_at_this_build' });
    assert.deepEqual([await readFile(f.file), await readFile(ledgerPath(f.file))], before);
  });

  test(`retention reader ${backend}: recorded item deadlines require the lifecycle recovery floor too`, options, async (t) => {
    const f = await fixture(t, backend);
    const payload = await f.store.load();
    stampDeadlines(payload);
    await f.store.save(payload);
    await backup(f, 'stamped');
    const before = await readFile(f.file);
    await assert.rejects(restore(f, join(f.dir, 'stamped')), { code: 'purge_aware_restore_unsupported_at_this_build' });
    assert.deepEqual(await readFile(f.file), before);
  });

  for (const control of ['override', 'recorded deadline']) test(`retention reader ${backend}: a pending retention-sensitive restore with ${control} is never resolved by load, save, backup or restore`, options, async (t) => {
    const f = await fixture(t, backend);
    await backup(f, 'before');
    f.graph.purgeProject('p');
    f.graph.setRevision(await f.store.save(privilegedSnapshot(f.graph)));
    const options = { restoreFault: (stage) => { if (stage === 'beforePostStep') throw new Error('test interrupted post-step'); } };
    const interruptedStore = backend === 'sqlite' ? await createStorage({ type: backend, file: f.file, env: f.env, ...options }) : null;
    let result;
    try { result = interruptedStore ? await interruptedStore.restore(join(f.dir, 'before')) : await restore(f, join(f.dir, 'before'), options); }
    finally { interruptedStore?.close(); }
    assert.equal(result.completion, 'pending');
    const ledger = JSON.parse(await readFile(ledgerPath(f.file), 'utf8'));
    assert.equal(ledger.pending[0].kind, 'restore');
    if (control === 'override') {
      ledger.retentionOverrides = [{ project: 'p', days: 1 }];
      await writeFile(ledgerPath(f.file), JSON.stringify(ledger));
    } else await stampStoredDeadlines(f);
    const before = [await readFile(f.file), await readFile(ledgerPath(f.file))];
    for (const operation of [() => f.store.load(), () => f.store.save(privilegedSnapshot(f.graph)), () => backup(f, 'refused-pending'), () => restore(f, join(f.dir, 'before'))]) {
      await assert.rejects(operation(), (error) => error.code === 'deletion_pending_unsupported_at_this_build' || error.cause?.code === 'deletion_pending_unsupported_at_this_build');
      assert.deepEqual([await readFile(f.file), await readFile(ledgerPath(f.file))], before);
    }
  });

  for (const pending of ['purge', 'restore']) for (const control of ['override', 'recorded deadline', ...(backend === 'sqlite' ? ['WAL deadline'] : [])]) test(`retention reader ${backend}: unsupported source ${control} refuses before completing a destination ${pending}`, options, async (t) => {
    const f = await fixture(t, backend);
    const source = join(f.dir, 'before');
    await backup(f, 'before');
    f.graph.purgeProject('p');
    if (pending === 'purge') {
      const interrupted = await createStorage({ type: backend, file: f.file, env: f.env, saveFault(stage) { if (stage === 'deletionLedgerWritten') throw new Error('test interrupted purge'); } });
      try { await assert.rejects(interrupted.save(privilegedSnapshot(f.graph)), /test interrupted purge/); }
      finally { interrupted.close?.(); }
    } else {
      f.graph.setRevision(await f.store.save(privilegedSnapshot(f.graph)));
      const fault = { restoreFault(stage) { if (stage === 'beforePostStep') throw new Error('test interrupted restore'); } };
      const interrupted = backend === 'sqlite' ? await createStorage({ type: backend, file: f.file, env: f.env, ...fault }) : null;
      try { assert.equal((interrupted ? await interrupted.restore(source) : await restore(f, source, fault)).completion, 'pending'); }
      finally { interrupted?.close(); }
    }
    assert.equal((await readLedger(f.file)).pending[0].kind, pending);
    if (control === 'override') await writeFile(ledgerPath(source), JSON.stringify({ version: 1, retentionOverrides: [{ project: 'p', days: 1 }] }));
    else {
      const wal = await stampStoredDeadlines({ ...f, file: source }, { wal: control === 'WAL deadline' });
      if (wal) {
        t.after(() => wal.close());
        assert.ok((await readFile(`${source}-wal`)).length > 0, 'the deadline is committed in active WAL pages');
      }
    }
    const files = [f.file, ledgerPath(f.file), registryFile(f.env), source, ledgerPath(source), ...['-wal', '-shm', '-journal'].map((suffix) => `${source}${suffix}`)];
    const bytes = () => Promise.all(files.map((file) => readFile(file).then((value) => createHash('sha256').update(value).digest('hex')).catch((error) => { if (error.code === 'ENOENT') return null; throw error; })));
    const before = await bytes();
    await assert.rejects(restore(f, source), { code: 'purge_aware_restore_unsupported_at_this_build' });
    assert.deepEqual(await bytes(), before, 'unsupported restore cannot complete a purge/restore or alter the registry first');
  });
}

test('retention reader: an empty graph with installed policy cannot silently adopt a looser incoming policy', () => {
  let clock = '2026-10-03T00:00:00.000Z';
  const graph = createShadowGraph({ now: () => clock });
  graph.importData(attachLedgerView(privilegedSnapshot(createShadowGraph()), { retentionOverrides: [{ project: 'p', days: 1 }] }));
  const source = createShadowGraph({ now: () => START });
  record(source);
  const incoming = attachLedgerView(privilegedSnapshot(source), { retentionOverrides: [{ project: 'p', days: 30 }] });
  const before = privilegedSnapshot(graph);
  assert.throws(() => graph.importData(incoming), { code: 'purge_aware_restore_unsupported_at_this_build' });
  assert.deepEqual(privilegedSnapshot(graph), before);
  record(graph);
  clock = '2026-10-04T00:00:00.000Z';
  assert.equal(block(graph).blocked, 1, 'the installed policy survives the refused merge');
});

test('retention reader: default, override, recorded deadline, invalid clock and future-schema boundaries', () => {
  const graph = createShadowGraph({ now: () => START });
  const item = record(graph);
  assert.equal(effectiveCaptureExpiry(item), '2026-10-08T00:00:00.000Z');
  assert.equal(captureRawExpired(item, [], '2026-10-07T23:59:59.999Z'), false);
  assert.equal(captureRawExpired(item, [], '2026-10-08T00:00:00.000Z'), true);
  assert.equal(effectiveCaptureExpiry(item, [{ project: 'p', days: 30 }]), '2026-10-31T00:00:00.000Z');
  assert.equal(effectiveCaptureExpiry({ ...item, expiresAt: '2026-10-03T00:00:00.000Z' }, [{ project: 'p', days: 30 }]), '2026-10-03T00:00:00.000Z');
  assert.equal(captureRawExpired({ ...item, state: 'blocked', blockedReason: 'raw_expired', expiresAt: '2026-10-31T00:00:00.000Z' }, [{ project: 'p', days: 30 }], START), true, 'an expired skeleton never becomes usable again');
  assert.equal(effectiveCaptureExpiry({ ...item, attribution: 'unattributed', project: null }, [{ project: 'p', days: 1 }]), '2026-10-08T00:00:00.000Z');
  assert.equal(effectiveCaptureExpiry({ ...item, schemaVersion: 99 }), null);
  assert.equal(effectiveCaptureExpiry({ ...item, createdAt: 'unknown' }), null);
  assert.throws(() => captureRawExpired(item, [], 'invalid'), { code: 'capture_clock_invalid' });
});

test('retention reader: expired duplicate hints do not make fresh material refer to expired raw', () => {
  let clock = START;
  const graph = createShadowGraph({ now: () => clock });
  const first = record(graph);
  const repeat = record(graph);
  assert.equal(repeat.possibleDuplicateOf, first.id);
  clock = '2026-10-09T00:00:00.000Z';
  const fresh = record(graph);
  assert.equal(fresh.possibleDuplicateOf, null);
  assert.equal(fresh.occurrenceSeq, 3, 'expiry does not rewind the session mark');
});

test('retention reader: fresh assistant material cannot point at an expired Transcript with a different host identity', () => {
  let clock = START;
  const graph = createShadowGraph({ now: () => clock });
  const transcript = (hostEventId) => privilegedRecordCapture(graph, { project: 'p', originId: 'origin-retention', text: 'Repeated assistant text.', admission: ADMISSION, source: { event: 'Transcript', sessionId: 'session-p', role: 'assistant', hostEventId } });
  const first = transcript('a1');
  assert.equal(transcript('a2').possibleDuplicateOf, first.id);
  clock = '2026-10-09T00:00:00.000Z';
  assert.equal(transcript('a3').possibleDuplicateOf, null);
});
