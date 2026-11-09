// Origin recovery uses the same durable boundary as project purge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { exportSqlitePayload } from '../src/sqlite-storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { privilegedSnapshot, privilegedLiveSnapshot, privilegedRecordCapture } from '../src/internal/snapshot.js';
import { ledgerPath, registryFile, readLedger, readRegistry } from '../src/internal/deletion-knowledge.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const now = () => '2026-10-04T00:00:00.000Z';
async function fixture(t, backend) {
  const dir = await scratchDirectory(t, 'pr43-origin-durable-');
  const env = { SHADOWGRAPH_HOME: join(dir, 'home') };
  const file = join(dir, backend === 'json' ? 'store.json' : 'store.db');
  const graph = createShadowGraph({ now });
  const removed = graph.addDecision({ originId: 'origin-a', title: 'Removed synthetic', chosen: 'Remove' });
  const other = graph.addDecision({ originId: 'origin-b', title: 'Other synthetic', chosen: 'Keep' });
  const peer = graph.addDecision({ project: 'p', originId: 'origin-a', title: 'Project synthetic', chosen: 'Keep' });
  const open = options => createStorage({ type: backend, file, env, ...options });
  const store = await open();
  try { await store.save(privilegedSnapshot(graph)); } finally { store.close(); }
  return { dir, env, file, open, removed, other, peer };
}
const bytes = paths => Promise.all(paths.map(path => readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })));
async function storedPayload(file, backend) {
  if (backend === 'json') return JSON.parse(await readFile(file, 'utf8'));
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
  try { return exportSqlitePayload(db); } finally { db.close(); }
}
for (const backend of ['json', 'sqlite']) {
  const options = backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {};
  for (const mode of ['logical', 'hard']) {
    test(`${backend} ${mode} origin tombstone and registry prevent pre-purge backup resurrection in a fresh path`, options, async t => {
      const f = await fixture(t, backend), source = join(f.dir, 'before');
      const store = await f.open();
      try {
        await backupFile(f.file, source, { store, env: f.env });
        const backupBefore = await readFile(source);
        const graph = createShadowGraph({ now }); graph.importData(await store.load());
        graph.purgeOrigin('origin-a', { mode });
        await store.save(privilegedSnapshot(graph));
        const ledger = await readLedger(f.file), registry = await readRegistry(f.env);
        assert.equal(ledger.pending.length, 0);
        assert.equal(ledger.tombstones.filter(x => x.kind === 'origin' && x.purgedOrigin === 'origin-a').length, 1);
        assert.equal(registry.tombstones.filter(x => x.kind === 'origin' && x.purgedOrigin === 'origin-a').length, 1);
        const destination = join(f.dir, 'fresh');
        let target;
        try {
          if (backend === 'json') await restoreFile(source, destination, { env: f.env });
          target = await createStorage({ type: backend, file: destination, env: f.env });
          if (backend === 'sqlite') await target.restore(source);
          const restored = await target.load();
          validateRestorePayload(restored);
          assert.equal(restored.records.some(x => x.id === f.removed.id), false);
          assert.ok(restored.records.some(x => x.id === f.other.id));
          assert.ok(restored.records.some(x => x.id === f.peer.id));
          assert.equal(restored.journal.find(x => x.type === 'restore.reapplied')?.payload.mode, mode);
          assert.deepEqual(await readFile(source), backupBefore, 'backup is retained byte-for-byte');
        } finally { target?.close(); }
      } finally { store.close(); }
    });
    for (const stage of ['deletionLedgerWritten', 'beforeCommit', 'beforeRecordCleared']) {
      test(`${backend} ${mode} pending origin purge at ${stage} hides its entire scope and recovers once`, options, async t => {
        const f = await fixture(t, backend);
        const failing = await f.open({ saveFault: at => { if (at === stage) throw new Error('synthetic interruption'); } });
        try {
          const graph = createShadowGraph({ now }); graph.importData(await failing.load());
          graph.purgeOrigin('origin-a', { mode });
          await assert.rejects(failing.save(privilegedSnapshot(graph)), /synthetic interruption/);
        } finally { failing.close(); }
        const paths = [f.file, ledgerPath(f.file), registryFile(f.env)], beforeOpen = await bytes(paths);
        const payloadBefore = await storedPayload(f.file, backend);
        const ledger = await readLedger(f.file);
        assert.equal(ledger.pending[0].purges[0].originId, 'origin-a');
        assert.equal(Object.hasOwn(ledger.pending[0].purges[0], 'project'), false);
        const store = await f.open();
        try {
          // SQLite opens lazily on load and selects WAL mode. The first load
          // preserves canonical data and control files; subsequent reads must
          // preserve exact bytes too.
          const graph = createShadowGraph({ now }); graph.importData(await store.load());
          assert.deepEqual(await storedPayload(f.file, backend), payloadBefore);
          assert.deepEqual((await bytes(paths)).slice(1), beforeOpen.slice(1));
          const before = await bytes(paths);
          await store.load();
          assert.equal(privilegedLiveSnapshot(graph).records.some(x => x.id === f.removed.id), false);
          assert.ok(privilegedLiveSnapshot(graph).records.some(x => x.id === f.peer.id));
          assert.deepEqual(await bytes(paths), before, 'a read never resolves pending work');
          await assert.rejects(store.update(payload => payload), { code: 'deletion_pending_unsupported_at_this_build' });
          assert.deepEqual(await bytes(paths), before, 'hook-style update writes neither ledger nor registry');
          await backupFile(f.file, join(f.dir, 'recovered-backup'), { store, env: f.env });
          const after = await store.load();
          assert.equal((await readLedger(f.file)).pending.length, 0);
          assert.equal(after.records.some(x => x.id === f.removed.id), false);
          assert.ok(after.records.some(x => x.id === f.other.id));
          assert.ok(after.records.some(x => x.id === f.peer.id));
          assert.equal(after.journal.filter(x => x.type === 'origin.purged').length, 1);
          validateRestorePayload(after);
          const stable = await bytes(paths);
          await store.load();
          assert.deepEqual(await bytes(paths), stable);
        } finally { store.close(); }
      });
    }
  }
}
