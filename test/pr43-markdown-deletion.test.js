import test from 'node:test';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import assert from 'node:assert/strict';
import { readFile, writeFile, unlink, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { syncMarkdownWorkspace } from '../src/markdown-workspace.js';
import { privilegedSnapshot, privilegedLiveSnapshot } from '../src/internal/snapshot.js';
import { attachLedgerView } from '../src/internal/deletion-knowledge.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const now = () => '2026-10-04T00:00:00.000Z';
const exists = path => readFile(path).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
async function fixture(t) {
  const root = await scratchDirectory(t, 'pr43-markdown-deletion-'), directory = join(root, 'workspace');
  const graph = createShadowGraph({ now });
  const memories = ['p', 'q'].map(project => graph.remember({ project, memoryType: 'note', key: 'same', text: `Synthetic ${project}` }).memory);
  const files = [];
  for (const project of ['p', 'q']) files.push((await syncMarkdownWorkspace({ graph, directory, project, mode: 'push' })).files[0]);
  return { root, directory, graph, memories, files, state: join(directory, '.shadowgraph-sync.json') };
}
test('Markdown stale projection stays by default, refuses pull and is pruned only by explicit selected-project opt-in', async t => {
  const f = await fixture(t), [p, q] = f.files;
  const pBytes = await readFile(p.path), qBytes = await readFile(q.path);
  f.graph.purgeProject('p');
  const before = privilegedSnapshot(f.graph);
  const ordinary = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push' });
  assert.equal(ordinary.written, 0); assert.deepEqual(await readFile(p.path), pBytes);
  const pull = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'pull' });
  assert.equal(pull.imported, 0); assert.ok(pull.conflicts.some(x => x.reason === 'canonical_memory_missing'));
  assert.deepEqual(privilegedSnapshot(f.graph), before);
  const dry = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true, dryRun: true });
  assert.equal(dry.pruned, 1); assert.deepEqual(await readFile(p.path), pBytes);
  const done = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true });
  assert.equal(done.pruned, 1); assert.equal(await exists(p.path), false);
  assert.deepEqual(await readFile(q.path), qBytes);
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(Object.hasOwn(state.files, p.relativePath), false); assert.ok(state.files[q.relativePath]);
  assert.equal((await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true })).pruned, 0);
});
test('Markdown prune preserves edited and untracked files and other project tracking', async t => {
  const f = await fixture(t), [p, q] = f.files;
  await writeFile(p.path, (await readFile(p.path, 'utf8')) + '\nOwner edit\n');
  const untracked = join(f.directory, 'p', 'owner-note.md'); await writeFile(untracked, 'Owner material');
  const before = await Promise.all([p.path, q.path, untracked].map(path => readFile(path)));
  f.graph.purgeProject('p');
  const done = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true });
  assert.equal(done.pruned, 0); assert.ok(done.conflicts.some(x => x.path === p.path));
  assert.deepEqual(await Promise.all([p.path, q.path, untracked].map(path => readFile(path))), before);
  assert.ok(JSON.parse(await readFile(f.state, 'utf8')).files[p.relativePath]);
});
test('Markdown missing-file cleanup can retry after deletion without deleting another project', async t => {
  const f = await fixture(t), [p, q] = f.files;
  f.graph.purgeProject('p'); await unlink(p.path);
  await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true });
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(Object.hasOwn(state.files, p.relativePath), false); assert.ok(state.files[q.relativePath]);
  assert.equal(await exists(q.path), true);
});
test('Markdown selected-project prune preserves another project even when both canonical records were purged', async t => {
  const f = await fixture(t), [p, q] = f.files;
  const qBytes = await readFile(q.path), before = JSON.parse(await readFile(f.state, 'utf8'));
  f.graph.purgeProject('p'); f.graph.purgeProject('q');
  const done = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true });
  assert.equal(done.pruned, 1); assert.equal(await exists(p.path), false);
  assert.deepEqual(await readFile(q.path), qBytes);
  assert.deepEqual(JSON.parse(await readFile(f.state, 'utf8')).files[q.relativePath], before.files[q.relativePath]);
});
test('Markdown untracked quarantined projection refuses pull without recreating its hidden record', async t => {
  const f = await fixture(t), snapshot = privilegedSnapshot(f.graph);
  const hidden = snapshot.records.find(x => x.id === f.memories[0].id);
  const view = attachLedgerView(snapshot, { tombstones: [], quarantine: [{ token: hidden.erasureToken, reason: 'possibly_purged', at: now() }], retentionOverrides: [] });
  const held = createShadowGraph({ now }); held.importData(view);
  assert.equal(privilegedLiveSnapshot(held).records.some(x => x.id === hidden.id), false, 'valid fixture: the selected identity is actually held');
  const state = JSON.parse(await readFile(f.state, 'utf8')); delete state.files[f.files[0].relativePath];
  await writeFile(f.state, JSON.stringify(state));
  const before = privilegedSnapshot(held);
  const pulled = await syncMarkdownWorkspace({ graph: held, directory: f.directory, project: 'p', mode: 'pull' });
  assert.equal(pulled.imported, 0); assert.ok(pulled.conflicts.length);
  assert.deepEqual(privilegedSnapshot(held), before);
});
test('Markdown prune refuses malicious tracked paths before touching files outside its workspace', async t => {
  const f = await fixture(t), outside = join(f.root, 'outside.md');
  const bytes = await readFile(f.files[0].path); await writeFile(outside, bytes);
  f.graph.purgeProject('p');
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  state.files['../outside.md'] = { ...state.files[f.files[0].relativePath] };
  await writeFile(f.state, JSON.stringify(state));
  await assert.rejects(syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true }), /path|workspace|unsafe/i);
  assert.deepEqual(await readFile(outside), bytes); assert.equal(await exists(f.files[0].path), true);
});
test('Markdown prune does not follow a directory symlink into an external projection', async t => {
  const f = await fixture(t), outside = join(f.root, 'external'); await mkdir(outside);
  const bytes = await readFile(f.files[0].path), target = join(outside, 'note.md'); await writeFile(target, bytes);
  const alias = join(f.directory, 'alias');
  try { await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) { t.skip(`symlink capability unavailable: ${error.code}`); return; } throw error; }
  f.graph.purgeProject('p');
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  state.files['alias/note.md'] = { ...state.files[f.files[0].relativePath] }; await writeFile(f.state, JSON.stringify(state));
  await assert.rejects(syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true }), /link|path|workspace|unsafe/i);
  assert.deepEqual(await readFile(target), bytes);
});

test('Markdown interrupted tracking write can retry a completed prune without losing another project', async t => {
  const f = await fixture(t), [p, q] = f.files;
  f.graph.purgeProject('p');
  const before = await readFile(f.state), qBefore = await readFile(q.path), original = fs.promises.rename;
  let injected = false;
  const mocked = t.mock.method(fs.promises, 'rename', async (from, to) => {
    if (to === f.state && !injected) { injected = true; throw new Error('synthetic state-write interruption'); }
    return original(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true }), /synthetic state-write interruption/);
    assert.equal(injected, true);
    assert.equal(await exists(p.path), false, 'file removal completed before tracking failed');
    assert.deepEqual(await readFile(f.state), before);
    assert.deepEqual(await readFile(q.path), qBefore);
  } finally { mocked.mock.restore(); syncBuiltinESMExports(); }
  const retry = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true });
  assert.equal(retry.pruned, 0);
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  assert.equal(Object.hasOwn(state.files, p.relativePath), false);
  assert.ok(state.files[q.relativePath]);
});
test('Markdown historical missing tracking without owner remains', async t => {
  const f = await fixture(t), [p] = f.files;
  f.graph.purgeProject('p');
  const state = JSON.parse(await readFile(f.state, 'utf8'));
  delete state.files[p.relativePath].project; await writeFile(f.state, JSON.stringify(state));
  await unlink(p.path);
  await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true });
  assert.ok(JSON.parse(await readFile(f.state, 'utf8')).files[p.relativePath]);
});
test('Markdown prune preserves a tracked hard-linked file and reports its conflict', async t => {
  const f = await fixture(t), [p] = f.files, alias = join(f.root, 'owner-copy.md');
  try { await fs.promises.link(p.path, alias); }
  catch (error) { if (['EPERM','EACCES','ENOTSUP'].includes(error.code)) { t.skip(`hardlink capability unavailable: ${error.code}`); return; } throw error; }
  const before = await readFile(alias); f.graph.purgeProject('p');
  const done = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true });
  assert.equal(done.pruned, 0); assert.ok(done.conflicts.some(x => x.reason === 'unsafe_projection_file'));
  assert.deepEqual(await readFile(alias), before); assert.deepEqual(await readFile(p.path), before);
});
test('Markdown prune refuses reserved or alternate-stream tracking before deleting eligible projections', async t => {
  for (const name of ['NUL.txt', 'CON', 'p/note.md:stream', 'p/../escape.md', '/absolute.md', 'p/trailing.']) {
    const f = await fixture(t), [p] = f.files; f.graph.purgeProject('p');
    const state = JSON.parse(await readFile(f.state, 'utf8'));
    state.files[name] = { ...state.files[p.relativePath] }; await writeFile(f.state, JSON.stringify(state));
    await assert.rejects(syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push', prune: true }), /unsafe|path/i, name);
    assert.equal(await exists(p.path), true);
  }
});
