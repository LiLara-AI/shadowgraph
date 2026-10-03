// M-6 uses the existing durable purge commit boundary, never a second save protocol.
import test from 'node:test';
import assert from 'node:assert/strict';
import { link, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createStorage } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { captureItemRecordValid, ledgerPath, readLedger, registryFile } from '../src/internal/deletion-knowledge.js';
import { privilegedDeleteCapture, privilegedRecordCapture, privilegedRecordTranscript, privilegedSnapshot } from '../src/internal/snapshot.js';

const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const BACKENDS = [['json', {}], ['sqlite', sqlite.available ? {} : { skip: sqlite.reason }]];
async function fixture(t, backend, fault) {
  const dir = await scratchDirectory(t, 'capture-item-delete-');
  const file = join(dir, `memory.${backend === 'json' ? 'json' : 'db'}`);
  const env = { SHADOWGRAPH_HOME: join(dir, 'home') };
  // Each clock read differs: a pending identity and its committed marker
  // must share one captured instant, not depend on millisecond coincidence.
  let clock = Date.now();
  const graph = createShadowGraph({ now: () => new Date(clock++).toISOString() });
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-delete', text: 'synthetic deleted item raw', source: { event: 'Stop', sessionId: 'session' }, admission: { limits: { maxStoreBytes: 2 ** 30, maxQueueDepth: 100, maxItemBytes: 2 ** 20, maxItemsPerSession: 100 }, storeBytes: 0 } });
  const open = (saveFault) => createStorage({ type: backend, file, env, saveFault });
  const first = await open(); graph.setRevision(await first.save(privilegedSnapshot(graph))); first.close?.();
  privilegedDeleteCapture(graph, { project: 'p', id: item.id });
  const store = await open(fault); t.after(() => store.close?.());
  return { dir, file, env, graph, item, store, open };
}

for (const [backend, options] of BACKENDS) {
  for (const state of ['absent', 'empty']) test(`capture item deletion ${backend}: ${state} recovery retains anonymous knowledge exactly once`, options, async (t) => {
    const f = await fixture(t, backend, (stage) => { if (stage === 'deletionLedgerWritten') throw new Error('synthetic interruption'); });
    await assert.rejects(f.store.save(privilegedSnapshot(f.graph)), /synthetic interruption/u);
    f.store.close?.();
    await unlink(f.file);
    if (state === 'empty' && backend === 'json') await writeFile(f.file, JSON.stringify(privilegedSnapshot(createShadowGraph())));
    const next = await f.open();
    try {
      await next.save(privilegedSnapshot(createShadowGraph()));
      const payload = await next.load();
      const graph = createShadowGraph(); graph.importData(payload);
      await next.save(privilegedSnapshot(graph));
      assert.equal((await readLedger(f.file)).pending.length, 0);
      assert.equal((await readLedger(f.file)).tombstones.length, 1);
      assert.equal(JSON.parse(await readFile(registryFile(f.env), 'utf8')).tombstones.length, 1);
      assert.equal(JSON.stringify(await next.load()).includes(f.item.id), false);
    } finally { next.close?.(); }
  });
  test(`capture item deletion ${backend}: hard-linked payload refuses before ledger or registry writes`, options, async (t) => {
    const f = await fixture(t, backend);
    f.store.close?.();
    const alias = join(f.dir, 'other-name');
    await link(f.file, alias);
    const before = await readFile(f.file);
    const next = await f.open();
    try { await assert.rejects(next.save(privilegedSnapshot(f.graph)), { code: 'deletion_file_destination_refused' }); }
    finally { next.close?.(); }
    assert.deepEqual(await readFile(alias), before);
    await assert.rejects(readFile(ledgerPath(f.file)), { code: 'ENOENT' });
    await assert.rejects(readFile(registryFile(f.env)), { code: 'ENOENT' });
  });
  test(`capture item deletion ${backend}: malformed future pending records refuse without durable effects`, options, async (t) => {
    const f = await fixture(t, backend, (stage) => { if (stage === 'deletionLedgerWritten') throw new Error('synthetic interruption'); });
    await assert.rejects(f.store.save(privilegedSnapshot(f.graph)), /synthetic interruption/u);
    f.store.close?.();
    const ledger = JSON.parse(await readFile(ledgerPath(f.file), 'utf8'));
    for (const malformed of [
      { ...ledger.pending[0], futureMeaning: true },
      { ...ledger.pending[0], items: [] },
      { ...ledger.pending[0], items: ledger.pending[0].items.map((item) => ({ ...item, token: 'different-token' })) }
    ]) {
      await writeFile(ledgerPath(f.file), JSON.stringify({ ...ledger, pending: [malformed] }));
      const before = [await readFile(f.file), await readFile(ledgerPath(f.file))];
      const next = await f.open();
      try {
        await assert.rejects(next.load(), { code: 'deletion_pending_unsupported_at_this_build' });
        await assert.rejects(next.save(privilegedSnapshot(f.graph)), { code: 'deletion_pending_unsupported_at_this_build' });
      } finally { next.close?.(); }
      assert.deepEqual([await readFile(f.file), await readFile(ledgerPath(f.file))], before);
      await assert.rejects(readFile(registryFile(f.env)), { code: 'ENOENT' });
    }
  });
  test(`capture item deletion ${backend}: restoring a pre-deletion backup into a fresh path removes raw and blocks delayed transcript recapture`, options, async (t) => {
    const f = await fixture(t, backend);
    const backup = join(f.dir, 'before-delete');
    await backupFile(f.file, backup, { env: f.env, store: f.store });
    await f.store.save(privilegedSnapshot(f.graph));
    const destination = join(f.dir, 'restored');
    let restored;
    if (backend === 'json') await restoreFile(backup, destination, { env: f.env });
    restored = await createStorage({ type: backend, file: destination, env: f.env });
    try {
      if (backend === 'sqlite') await restored.restore(backup);
      const payload = await restored.load();
      assert.equal(JSON.stringify(payload).includes('synthetic deleted item raw'), false);
      assert.equal(JSON.stringify(payload).includes(f.item.id), false);
      assert.equal(payload.captureSessions[0].cursor.blocked.reason, 'capture_deleted');
      const graph = createShadowGraph(); graph.importData(payload);
      privilegedRecordTranscript(graph, { project: 'p', originId: 'origin-delete', sessionId: 'session', activatedAt: new Date().toISOString(), trigger: 'PreCompact', admission: { limits: {}, storeBytes: 0 }, transcript: { ref: 'synthetic-transcript', size: () => { assert.fail('deleted transcript must not be read'); }, read: () => { assert.fail('deleted transcript must not be read'); } } });
    } finally { restored.close?.(); }
  });
  for (const bad of ['token', 'committed marker']) test(`capture item deletion ${backend}: mismatched ${bad} refuses recovery without changing any file`, options, async (t) => {
    const stage = bad === 'token' ? 'deletionLedgerWritten' : 'beforeRecordCleared';
    const f = await fixture(t, backend, (at) => { if (at === stage) throw new Error('synthetic interruption'); });
    await assert.rejects(f.store.save(privilegedSnapshot(f.graph)), /synthetic interruption/u);
    f.store.close?.();
    const ledger = JSON.parse(await readFile(ledgerPath(f.file), 'utf8'));
    if (bad === 'token') { ledger.pending[0].items[0].token = 'different-token'; ledger.tombstones[0].tokens = ['different-token']; }
    else { ledger.pending[0].items[0].marker.seq += 1; ledger.tombstones[0].seq += 1; }
    assert.equal(captureItemRecordValid(ledger.pending[0], ledger.tombstones), true, 'shape valid; identity must reject it');
    await writeFile(ledgerPath(f.file), JSON.stringify(ledger));
    const files = [f.file, ledgerPath(f.file), registryFile(f.env)];
    const bytes = () => Promise.all(files.map((file) => readFile(file).catch((e) => e.code === 'ENOENT' ? null : Promise.reject(e))));
    const before = await bytes();
    const next = await f.open();
    try { await assert.rejects(next.save(privilegedSnapshot(f.graph)), (error) => ['capture_delete_identity_refused', 'deletion_pending_unsupported_at_this_build'].includes(error.code)); }
    finally { next.close?.(); }
    assert.deepEqual(await bytes(), before);
  });
  test(`capture item deletion ${backend}: one anonymous item tombstone, one registry entry, no pending record or deleted material`, options, async (t) => {
    const f = await fixture(t, backend);
    await f.store.save(privilegedSnapshot(f.graph));
    const payload = await f.store.load();
    assert.equal(payload.records.some((r) => r.kind === 'capture'), false);
    for (const text of [JSON.stringify(payload), await readFile(ledgerPath(f.file), 'utf8'), await readFile(registryFile(f.env), 'utf8')]) {
      assert.equal(text.includes(f.item.id), false);
      assert.equal(text.includes('synthetic deleted item raw'), false);
    }
    const ledger = await readLedger(f.file);
    assert.equal(ledger.tombstones.length, 1);
    assert.equal(ledger.tombstones[0].kind, 'item');
    assert.equal(ledger.pending.length, 0);
    assert.equal(JSON.parse(await readFile(registryFile(f.env), 'utf8')).tombstones.length, 1);
  });
  for (const stage of ['deletionLedgerWritten', 'beforeCommit', 'beforeRecordCleared']) test(`capture item deletion ${backend}: interrupted ${stage} refuses reads/hooks/backups; next write completes once`, options, async (t) => {
    const f = await fixture(t, backend, (at) => { if (at === stage) throw new Error(`synthetic ${stage}`); });
    await assert.rejects(f.store.save(privilegedSnapshot(f.graph)), new RegExp(`synthetic ${stage}`));
    f.store.close?.();
    const ledger = await readLedger(f.file);
    assert.equal(ledger.pending[0].kind, 'capture_item');
    assert.equal(ledger.pending[0].items[0].id, f.item.id);
    const files = [f.file, ledgerPath(f.file), registryFile(f.env)];
    const bytes = () => Promise.all(files.map((file) => readFile(file).catch((e) => e.code === 'ENOENT' ? null : Promise.reject(e))));
    const before = await bytes();
    const next = await f.open();
    try {
      await assert.rejects(next.load(), { code: 'deletion_pending_unsupported_at_this_build' });
      await assert.rejects(next.update(() => { assert.fail('hook must never reach the callback'); }), { code: 'deletion_pending_unsupported_at_this_build' });
      await assert.rejects(backupFile(f.file, join(f.dir, 'backup'), { env: f.env, store: next }));
      assert.deepEqual(await bytes(), before);
      await assert.rejects(next.save(privilegedSnapshot(f.graph)), { name: 'RevisionConflictError' });
      const payload = await next.load();
      const current = createShadowGraph(); current.importData(payload);
      await next.save(privilegedSnapshot(current));
      assert.equal((await readLedger(f.file)).pending.length, 0);
      assert.equal((await readLedger(f.file)).tombstones.length, 1);
      assert.equal(JSON.parse(await readFile(registryFile(f.env), 'utf8')).tombstones.length, 1);
      assert.equal(JSON.stringify(await next.load()).includes(f.item.id), false);
      assert.equal(payload.captureSessions[0].cursor.blocked.reason, 'capture_deleted');
    } finally { next.close?.(); }
  });
}
