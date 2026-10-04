import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { privilegedSnapshot, privilegedLiveSnapshot } from '../src/internal/snapshot.js';
import { ledgerPath, registryFile, readLedger, classifyRestore } from '../src/internal/deletion-knowledge.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const now = () => '2026-10-04T00:00:00.000Z', sqlite = (await getRuntimeCapabilities()).nodeSqlite;
for (const type of ['json', 'sqlite']) for (const scope of ['project', 'origin']) {
  test(`${type} ${scope} pre-purge orphan raw cannot reappear through an applicable registry restore`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr43-orphan-raw-'), file = join(root, 'store'), backup = join(root, 'backup'), destination = join(root, 'destination');
    const env = { SHADOWGRAPH_HOME: join(root, 'home') }, graph = createShadowGraph({ now });
    const owner = scope === 'project' ? { project: 'a', originId: 'a' } : { originId: 'a' };
    graph.addDecision({ ...owner, title: 'Lineage anchor', chosen: 'A' });
    const payload = privilegedSnapshot(graph), raw = { contentRef: 'orphan-source', project: scope === 'project' ? 'a' : null,
      attribution: scope === 'project' ? 'project' : 'unattributed', originId: 'a', text: 'PURGED ORPHAN RAW' };
    payload.captureContent = [raw];
    const store = await createStorage({ type, file, env }); t.after(() => store.close());
    await store.save(payload); await backupFile(file, backup, { store, env }); const original = await readFile(backup);
    const loaded = createShadowGraph({ now }); loaded.importData(await store.load());
    if (scope === 'project') loaded.purgeProject('a'); else loaded.purgeOrigin('a');
    await store.save(privilegedSnapshot(loaded));
    assert.equal((await store.load()).captureContent?.length ?? 0, 0);
    const target = await createStorage({ type, file: destination, env }); t.after(() => target.close());
    await target.save(privilegedSnapshot(createShadowGraph({ now }))); await target.load();
    const paths = [destination, ledgerPath(destination), registryFile(env), backup, ledgerPath(backup)], before = await bytes(paths);
    try {
      await assert.rejects(type === 'json' ? restoreFile(backup, destination, { env, now: now() }) : target.restore(backup, { now: now() }), /unbound.*capture|orphan.*raw/i);
    } catch (error) {
      if (error.code === 'ERR_ASSERTION' && error.message.includes('Missing expected rejection')) {
        const restored = await target.load();
        assert.deepEqual(restored.captureContent, [raw], 'RED witness: the purged raw actually reappears');
        t.diagnostic('Valid RED: applicable registry restore returned the purged orphan raw entry');
      }
      throw error;
    }
    assert.deepEqual(await readFile(backup), original);
    assert.deepEqual(await bytes(paths), before, 'refusal precedes generation, pending, primitive and registry writes');
  });
}

const bytes = paths => Promise.all(paths.map(path => readFile(path).catch(error => { if (error.code === 'ENOENT') return null; throw error; })));
for (const type of ['json', 'sqlite']) for (const scope of ['project', 'origin']) {
  test(`${type} pending ${scope} raw-only purge withholds reads, preserves persistence and resolves only on ordinary write`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr43-orphan-pending-'), file = join(root, 'store'), env = { SHADOWGRAPH_HOME: join(root, 'home') };
    const graph = createShadowGraph({ now }), payload = privilegedSnapshot(graph);
    const raw = { contentRef: 'raw-only', project: scope === 'project' ? 'a' : null,
      attribution: scope === 'project' ? 'project' : 'unattributed', originId: 'a', text: 'Selected raw' };
    const peer = { contentRef: 'peer', project: 'keep', attribution: 'project', originId: 'a', text: 'Keep raw' };
    payload.captureContent = [raw, peer];
    const first = await createStorage({ type, file, env });
    try { await first.save(payload); } finally { first.close(); }
    const failing = await createStorage({ type, file, env, saveFault: stage => { if (stage === 'deletionLedgerWritten') throw new Error('synthetic interruption'); } });
    try {
      const loaded = createShadowGraph({ now }); loaded.importData(await failing.load());
      if (scope === 'project') loaded.purgeProject('a'); else loaded.purgeOrigin('a');
      await assert.rejects(failing.save(privilegedSnapshot(loaded)), /synthetic interruption/);
    } finally { failing.close(); }
    const store = await createStorage({ type, file, env }); t.after(() => store.close());
    const before = await store.load(), loaded = createShadowGraph({ now }); loaded.importData(before);
    const paths = [file, ledgerPath(file), registryFile(env)], original = await bytes(paths);
    assert.equal((await readLedger(file)).pending.length, 1);
    assert.deepEqual(privilegedLiveSnapshot(loaded).captureContent, [peer]);
    assert.deepEqual(privilegedSnapshot(loaded).captureContent, [raw, peer]);
    await store.load();
    await assert.rejects(store.update(p => p), { code: 'deletion_pending_unsupported_at_this_build' });
    assert.deepEqual(await bytes(paths), original);
    await backupFile(file, join(root, 'recovered-backup'), { store, env });
    assert.deepEqual((await store.load()).captureContent, [peer]);
    assert.equal((await readLedger(file)).pending.length, 0);
  });
}
const raw = { contentRef: 'orphan', project: 'a', attribution: 'project', originId: 'o', text: 'Private synthetic raw' };
const inputs = { live: [], overlap: [], postdated: [], descent: false, descentMode: null };
const stone = { kind: 'project', purgedProject: 'a', tokens: [], moveIn: 'none', mode: 'hard' };
for (const mode of ['logical', 'hard']) test(`${mode} unbound raw classification preserves precise scope, postdating and conservative move-in`, () => {
  const payload = { records: [], facts: [], captureContent: [raw] }, t = { ...stone, mode };
  const classify = (tombstones, overrides = {}, value = payload) => classifyRestore(value, { tombstones }, { ...inputs, ...overrides });
  for (const tombstones of [[], [{ ...t, purgedProject: 'other' }], [{ ...t, kind: 'origin', purgedOrigin: 'o', purgedProject: undefined }]])
    assert.deepEqual(classify(tombstones).remove, []);
  assert.deepEqual(classify([t], { postdated: [0] }).quarantine, []);
  for (const tombstones of [[t], [{ ...t, purgedProject: 'other', moveIn: 'some' }], [{ ...t, purgedProject: 'other', moveIn: 'unknown' }], [{ ...t, purgedProject: 'other', moveIn: undefined }]]) {
    assert.throws(() => classify(tombstones), { code: 'purge_aware_restore_unsupported_at_this_build' });
    assert.throws(() => classify(tombstones, {}, { ...payload, captureContent: [{ ...raw, at: '2099-01-01T00:00:00.000Z' }] }), /unbound.*capture/i);
  }
  assert.throws(() => classify([t, t], { postdated: [0] }), /unbound.*capture/i);
  assert.throws(() => classify([t], {}, { ...payload, records: [{ kind: 'capture', id: 'foreign', contentRef: raw.contentRef, project: 'foreign', attribution: 'project', originId: 'o' }] }), /unbound.*capture/i);
});

for (const type of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) {
  test(`${type} ${mode} raw created after a recorded purge marker restores through registry`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr43-orphan-postdated-'), file = join(root, 'store'), backup = join(root, 'backup'), env = { SHADOWGRAPH_HOME: join(root, 'home') };
    const graph = createShadowGraph({ now }); graph.addDecision({ project: 'a', title: 'Old', chosen: 'Old' });
    const store = await createStorage({ type, file, env }); t.after(() => store.close());
    await store.save(privilegedSnapshot(graph));
    const loaded = createShadowGraph({ now }); loaded.importData(await store.load()); loaded.purgeProject('a', { mode });
    await store.save(privilegedSnapshot(loaded));
    const payload = await store.load(); payload.captureContent = [raw]; await store.save(payload);
    await backupFile(file, backup, { store, env });
    const target = await createStorage({ type, file: join(root, 'fresh'), env }); t.after(() => target.close());
    if (type === 'json') await restoreFile(backup, join(root, 'fresh'), { env }); else await target.restore(backup);
    assert.deepEqual((await target.load()).captureContent, [raw]);
  });
}
