import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { privilegedSnapshot, privilegedLiveSnapshot, privilegedRecordSelfEvent } from '../src/internal/snapshot.js';
import { SELF_SIGNALS } from '../src/internal/capture-source.js';
import { readLedger, ledgerPath, registryFile } from '../src/internal/deletion-knowledge.js';
import { backupFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const execute = promisify(execFile), cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const now = () => '2026-10-04T00:00:00.000Z';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
async function setup(t, backend) {
  const dir = await scratchDirectory(t, 'pr43-origin-scope-'), file = join(dir, 'store');
  const env = { ...process.env, SHADOWGRAPH_HOME: join(dir, 'home'), SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: backend };
  const graph = createShadowGraph({ now });
  const a = graph.addDecision({ originId: 'a', title: 'A', chosen: 'a' });
  const p = graph.addDecision({ project: 'p', originId: 'a', title: 'P', chosen: 'p' });
  const b = graph.addDecision({ originId: 'b', title: 'B', chosen: 'b' });
  return { dir, file, env, graph, a, p, b, open: options => createStorage({ type: backend, file, env, ...options }) };
}
for (const backend of ['json', 'sqlite']) {
  const options = backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {};
  test(`${backend} CLI purge selects exactly one explicit project or origin`, options, async t => {
    const f = await setup(t, backend), store = await f.open();
    try { await store.save(privilegedSnapshot(f.graph)); } finally { store.close(); }
    const invoke = (command, value) => execute(process.execPath, [cli, command, JSON.stringify(value)], { env: f.env, cwd: f.dir });
    const preview = JSON.parse((await invoke('purge-preview', { originId: 'a' })).stdout);
    assert.equal(preview.originId, 'a'); assert.equal(preview.records, 1);
    const before = await readFile(f.file);
    for (const value of [{ project: 'p', originId: 'a' }, { project: null, originId: 'a' }, {}, { originId: ' ' }]) {
      await assert.rejects(invoke('purge', value)); assert.deepEqual(await readFile(f.file), before);
    }
    const removed = JSON.parse((await invoke('purge', { originId: 'a', mode: 'hard' })).stdout);
    assert.equal(removed.removed, 1);
    const check = await f.open();
    try {
      const after = await check.load();
      assert.deepEqual(after.records.map(x => x.id).sort(), [f.p.id, f.b.id].sort());
      assert.equal((await readLedger(f.file)).tombstones[0].purgedOrigin, 'a');
    } finally { check.close(); }
  });
  test(`${backend} mixed hard purges lift each older unrecorded marker under its own scope`, options, async t => {
    const f = await setup(t, backend);
    f.graph.purgeOrigin('a'); f.graph.purgeProject('p');
    const store = await f.open();
    try {
      // A preservation copy drops transient intents, leaving older bare markers.
      await store.save(structuredClone(privilegedSnapshot(f.graph)));
      const graph = createShadowGraph({ now }); graph.importData(await store.load());
      graph.purgeProject('p', { mode: 'hard' }); graph.purgeOrigin('a', { mode: 'hard' });
      await store.save(privilegedSnapshot(graph));
      const ledger = await readLedger(f.file), lifted = ledger.tombstones.filter(x => x.tokens === null);
      assert.equal(lifted.length, 2);
      assert.deepEqual(lifted.map(x => x.kind === 'origin' ? ['origin', x.purgedOrigin] : ['project', x.purgedProject]).sort(), [['origin', 'a'], ['project', 'p']]);
      const markers = (await store.load()).journal.filter(x => ['origin.purged', 'project.purged'].includes(x.type));
      for (const row of lifted) assert.ok(markers.some(m => m.seq === row.seq && m.at === row.at && (row.kind === 'origin' ? m.payload.originId === row.purgedOrigin : m.project === row.purgedProject)));
    } finally { store.close(); }
  });
  test(`${backend} pending origin scope hides tokenless material and same-instant self-only sessions without resolving on read`, options, async t => {
    const f = await setup(t, backend);
    privilegedRecordSelfEvent(f.graph, { originId: 'a', signal: SELF_SIGNALS[0], source: { event: 'UserPromptSubmit', sessionId: 'self' } });
    const snapshot = privilegedSnapshot(f.graph);
    const strip = value => { if (!value || typeof value !== 'object') return; if (value.id === f.a.id) delete value.erasureToken; for (const item of Object.values(value)) strip(item); };
    strip(snapshot);
    const store = await f.open(); try { await store.save(snapshot); } finally { store.close(); }
    const failing = await f.open({ saveFault: stage => { if (stage === 'deletionLedgerWritten') throw new Error('synthetic interruption'); } });
    try { const graph = createShadowGraph({ now }); graph.importData(await failing.load()); graph.purgeOrigin('a'); await assert.rejects(failing.save(privilegedSnapshot(graph)), /synthetic interruption/); }
    finally { failing.close(); }
    const paths = [f.file, ledgerPath(f.file), registryFile(f.env)];
    const bytes = () => Promise.all(paths.map(p => readFile(p).catch(e => { if (e.code === 'ENOENT') return null; throw e; })));
    const before = await bytes(), opened = await f.open();
    try {
      const graph = createShadowGraph({ now }); graph.importData(await opened.load());
      const live = privilegedLiveSnapshot(graph);
      assert.equal(live.records.some(x => x.id === f.a.id), false); assert.equal((live.captureSessions ?? []).length, 0);
      assert.ok(live.records.some(x => x.id === f.p.id)); assert.deepEqual(await bytes(), before);
      await backupFile(f.file, join(f.dir, 'recovery-backup'), { store: opened, env: f.env });
      assert.equal((await readLedger(f.file)).pending.length, 0);
      assert.equal((await opened.load()).records.some(x => x.id === f.a.id), false);
    } finally { opened.close(); }
  });
}
