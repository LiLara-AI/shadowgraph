// Capture enrolment (OD-3; plan v1.4.4 §21.3, §22.6.1; programme plan revision 6 PR-36a): `activate capture` and
// `deactivate capture`, the private-store refusal, the origin, the coverage and the frozen admission limits. Every
// CLI run points HOME, USERPROFILE and SHADOWGRAPH_HOME into a scratch directory; nothing here writes capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore, createStorage } from '../src/storage.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { runtimeHookCommand } from '../src/host-hooks.js';
import { ledgerPath } from '../src/internal/deletion-knowledge.js';
import { activeCapture, CAPTURE_LIMITS, coverageIssue, limitsIssue, storeRepository } from '../src/capture-hook.js';

const CLI = resolve('src/cli.js');
const VERIFIED = JSON.parse(readFileSync('integrations/claude-code.coverage.json', 'utf8')).verifiedVersion;

function run(args, home, env = {}) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: home, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: join(home, 'sg-home'), SHADOWGRAPH_FILE: '', ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end();
    child.on('close', (code) => settle({ code, stdout, stderr }));
  });
}

async function setup(t, directory = 'stores') {
  const home = await scratchDirectory(t, 'shadowgraph-capture-activation-');
  const store = join(home, directory, 'memory.json');
  await mkdir(join(home, directory), { recursive: true });
  await createJsonFileStore(store).save(privilegedSnapshot(createShadowGraph()));
  return { home, store, record: join(home, 'sg-home', 'activation.json'), env: { SHADOWGRAPH_HOME: join(home, 'sg-home') } };
}

const activate = (home, store, ...flags) => run(['activate', 'capture', '--evidence', 'ag2-receipt', '--store', store, '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json'), ...flags], home);

test('activate capture records the store, one origin, all projects and the frozen limits; deactivation turns it off', async (t) => {
  const { home, store, record, env } = await setup(t);
  assert.equal(await activeCapture(env), null, 'inert before activation');
  // A capability the record already holds is kept.
  await mkdir(join(home, 'sg-home'));
  await writeFile(record, JSON.stringify({ version: 1, capabilities: { delivery: { state: 'deactivated' } }, history: [{ capability: 'delivery', state: 'deactivated' }] }));
  const bytes = await readFile(store);
  const first = await activate(home, store);
  assert.equal(first.code, 0, first.stderr);
  assert.ok((await readFile(store)).equals(bytes), 'activation writes nothing into the store: nothing is captured, reads are unaffected');
  const output = JSON.parse(first.stdout);
  assert.deepEqual([output.capability, output.state, output.file], ['capture', 'active', realpathSync.native(record)]);
  const capture = output.record.capabilities.capture;
  assert.deepEqual(capture.store, { file: realpathSync.native(store), storage: 'json' });
  assert.match(capture.originId, /^origin_[0-9a-f-]{36}$/u);
  assert.deepEqual(capture.coverage, { projects: 'all', exclude: [] }, 'every project, by default (OD-3)');
  assert.deepEqual(capture.limits, CAPTURE_LIMITS);
  assert.deepEqual([capture.evidence, capture.surface, capture.host, capture.runtime], ['ag2-receipt', 'cli', { name: 'claude-code', version: VERIFIED, verifiedVersion: null, verified: false }, null], 'no host version is verified for capture before AG-2');
  assert.deepEqual(output.record.capabilities.delivery, { state: 'deactivated' });
  assert.deepEqual(await activeCapture(env), capture);
  // Narrowing is a re-activation: the origin stays, and the history keeps the coverage it replaced.
  const narrowed = JSON.parse((await activate(home, store, '--exclude', 'secret, client-x')).stdout).record;
  assert.deepEqual(narrowed.capabilities.capture.coverage, { projects: 'all', exclude: ['secret', 'client-x'] });
  assert.equal(narrowed.capabilities.capture.originId, capture.originId, 'one installation, one origin');
  const only = JSON.parse((await activate(home, store, '--only', 'app')).stdout).record;
  assert.deepEqual(only.capabilities.capture.coverage, { projects: 'only', include: ['app'] });
  assert.deepEqual(only.history.map((entry) => [entry.capability, entry.state, entry.coverage ?? null]), [
    ['delivery', 'deactivated', null],
    ['capture', 'active', { projects: 'all', exclude: [] }],
    ['capture', 'active', { projects: 'all', exclude: ['secret', 'client-x'] }],
    ['capture', 'active', { projects: 'only', include: ['app'] }]
  ]);
  assert.ok(only.history.slice(1).every((entry) => JSON.stringify(entry.limits) === JSON.stringify(CAPTURE_LIMITS) && entry.store === realpathSync.native(store) && entry.originId === capture.originId), 'each activation\'s limits, store and origin are kept');
  // A record that lost its capture entry takes the origin back from the history.
  const lost = JSON.parse(await readFile(record, 'utf8'));
  delete lost.capabilities.capture;
  await writeFile(record, JSON.stringify(lost));
  assert.equal(JSON.parse((await activate(home, store, '--only', 'app')).stdout).record.capabilities.capture.originId, capture.originId);
  const off = await run(['deactivate', 'capture'], home);
  assert.equal(off.code, 0, off.stderr);
  assert.deepEqual([JSON.parse(off.stdout).state, JSON.parse(off.stdout).changed], ['deactivated', true]);
  assert.equal(await activeCapture(env), null);
  const saved = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual([saved.capabilities.capture.state, saved.capabilities.capture.originId, saved.capabilities.delivery], ['deactivated', capture.originId, { state: 'deactivated' }]);
  assert.deepEqual(saved.history.at(-1).capability, 'capture');
  assert.equal(JSON.parse((await run(['deactivate', 'capture'], home)).stdout).changed, false, 'nothing active, nothing written');
  // Deactivating delivery leaves capture's record alone, and the other way round.
  assert.equal(JSON.parse((await run(['deactivate', 'delivery'], home)).stdout).changed, false);
});

test('capture refuses a store inside any git repository or working tree, with nothing that permits it', async (t) => {
  const { home, record } = await setup(t);
  const inside = [];
  // A repository, a worktree (its `.git` is a file), the git directory itself, and a bare repository (git's own answer).
  const repository = join(home, 'repo');
  await mkdir(join(repository, '.git'), { recursive: true });
  inside.push(join(repository, 'nested', 'memory.json'));
  const worktree = join(home, 'worktree');
  await mkdir(worktree);
  await writeFile(join(worktree, '.git'), 'gitdir: /elsewhere\n');
  inside.push(join(worktree, 'memory.json'));
  inside.push(join(repository, '.git', 'memory.json'));
  const bare = join(home, 'bare.git');
  execFileSync('git', ['init', '--bare', '--quiet', bare]);
  inside.push(join(bare, 'memory.json'));
  for (const file of inside) {
    await mkdir(resolve(file, '..'), { recursive: true });
    await createJsonFileStore(file).save(privilegedSnapshot(createShadowGraph()));
    const result = await activate(home, file);
    assert.equal(result.code, 1, file);
    assert.match(result.stderr, /capture_store_inside_repository .*plan section 21\.3 and source-of-truth section 7/u, file);
    // An environment that would place it elsewhere changes nothing.
    assert.equal((await run(['activate', 'capture', '--evidence', 'x', '--store', file, '--host-version', VERIFIED], home, { GIT_DIR: join(home, 'nowhere'), GIT_CEILING_DIRECTORIES: home })).code, 1, file);
    assert.equal(existsSync(record), false, file);
  }
  assert.equal(await storeRepository(join(home, 'stores', 'memory.json')), null);
  assert.equal(await storeRepository(inside[0]), repository);
  assert.equal(await storeRepository(inside[1]), worktree);
  assert.equal(await storeRepository(inside[2]), join(repository, '.git'));
  // A link placed on the path is followed, at activation and at every later check.
  const linked = join(home, 'linked');
  symlinkSync(join(repository, 'nested'), linked, 'junction');
  assert.equal(await storeRepository(join(linked, 'memory.json')), realpathSync.native(repository));
  assert.equal((await activate(home, join(linked, 'memory.json'))).code, 1);
  // The invoking environment's GIT_DIR can make any directory a working tree, so it is asked too.
  const clean = join(home, 'stores', 'memory.json');
  const placed = await activate(home, clean, '--only', 'app');
  assert.equal((await run(['activate', 'capture', '--evidence', 'x', '--store', clean, '--host-version', VERIFIED], home, { GIT_DIR: bare })).code, 1);
  // A check git cannot answer refuses: it fails closed.
  const blind = await run(['activate', 'capture', '--evidence', 'x', '--store', clean, '--host-version', VERIFIED], home, { PATH: join(home, 'no-programs'), Path: join(home, 'no-programs') });
  assert.equal(blind.code, 1);
  assert.match(blind.stderr, /capture_store_inside_repository .*could not rule out/u);
  assert.equal(placed.code, 0, placed.stderr);
  assert.equal(JSON.parse(await readFile(record, 'utf8')).history.length, 1, 'only the clean activation was written');
});

test('delivery and capture share one store and one runtime while both are active', async (t) => {
  const { home, store, record } = await setup(t);
  const other = join(home, 'stores', 'other.json');
  await createJsonFileStore(other).save(privilegedSnapshot(createShadowGraph()));
  const file = realpathSync.native(store);
  await mkdir(join(home, 'sg-home'));
  const delivering = (fields) => writeFile(record, JSON.stringify({ version: 1, capabilities: { delivery: { state: 'active', store: { file, storage: 'json' }, runtime: null, ...fields } }, history: [] }));
  await delivering({});
  const elsewhere = await activate(home, other);
  assert.equal(elsewhere.code, 1);
  assert.match(elsewhere.stderr, /activation_store_differs_from_delivery/u);
  await delivering({ runtime: { path: join(home, 'runtime', 'a'.repeat(40)), commit: 'a'.repeat(40) } });
  const unpinned = await activate(home, store);
  assert.equal(unpinned.code, 1);
  assert.match(unpinned.stderr, /activation_runtime_differs_from_delivery/u, 'a delivery runtime too old for capture is never left beside it');
  await delivering({});
  assert.equal((await activate(home, store)).code, 0, 'the same store and runtime');
  // And the other way round: capture active, delivery for another store is refused.
  const delivery = await run(['activate', 'delivery', '--evidence', 'x', '--store', other, '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')], home);
  assert.equal(delivery.code, 1);
  assert.match(delivery.stderr, /activation_store_differs_from_capture/u);
  assert.equal((await run(['activate', 'delivery', '--evidence', 'x', '--store', store, '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')], home)).code, 0);
  // A re-pin: with both active, neither moves to another runtime alone; capture goes off first, delivery moves, capture
  // follows. (Here capture's recorded runtime stands in for the old one and the installed binary for the new.)
  const saved = JSON.parse(await readFile(record, 'utf8'));
  saved.capabilities.capture.runtime = { path: join(home, 'runtime', 'b'.repeat(40)), commit: 'b'.repeat(40) };
  saved.capabilities.delivery.runtime = saved.capabilities.capture.runtime;
  await writeFile(record, JSON.stringify(saved));
  const moved = await run(['activate', 'delivery', '--evidence', 'x', '--store', store, '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')], home);
  assert.equal(moved.code, 1);
  assert.match(moved.stderr, /activation_runtime_differs_from_capture .*deactivate capture, re-activate delivery on the new runtime, then activate capture/u);
  assert.equal((await run(['deactivate', 'capture'], home)).code, 0);
  assert.equal((await run(['activate', 'delivery', '--evidence', 'x', '--store', store, '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')], home)).code, 0);
  assert.equal((await activate(home, store)).code, 0);
});

test('activation needs evidence, an existing readable store and one coverage form, and writes nothing otherwise', async (t) => {
  const { home, store, record } = await setup(t);
  for (const args of [
    ['--store', store],
    ['--evidence', 'x'],
    ['--evidence', 'x', '--store', join(home, 'missing.json')],
    ['--evidence', 'x', '--store', store, '--only', 'a', '--exclude', 'b'],
    ['--evidence', 'x', '--store', store, '--only', 'a,,b'],
    ['--evidence', 'x', '--store', store, '--exclude', 'a,a'],
    ['--evidence', 'x', '--store', store, '--storage', 'sqlite'],
    ['--evidence', 'x', '--store', store, '--unknown', 'y']
  ]) {
    const result = await run(['activate', 'capture', ...args, '--host-version', VERIFIED], home);
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(existsSync(record), false, args.join(' '));
  }
  assert.equal((await run(['activate', 'extraction', '--evidence', 'x', '--store', store], home)).code, 1, 'no other capability yet');
  // A SQLite store is refused: delivery would report it busy at every captured prompt (review C-3).
  try {
    await import('node:sqlite');
    const sqlite = join(home, 'stores', 'memory.db');
    const created = await createStorage({ type: 'sqlite', file: sqlite });
    await created.save(privilegedSnapshot(createShadowGraph()));
    created.close();
    const refusedSqlite = await run(['activate', 'capture', '--evidence', 'x', '--store', sqlite, '--storage', 'sqlite', '--host-version', VERIFIED], home);
    assert.equal(refusedSqlite.code, 1);
    assert.match(refusedSqlite.stderr, /capture_store_sqlite_unsupported/u);
    assert.equal(existsSync(record), false);
  } catch (error) {
    if (error.code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
  }
  // Outside a scratch location the owner confirms at a terminal; a run without one is refused and writes nothing.
  const owned = join(home, '.shadowgraph');
  const refused = await run(['activate', 'capture', '--evidence', 'x', '--store', store, '--host-version', VERIFIED], home, { SHADOWGRAPH_HOME: owned });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /activation_requires_owner_confirmation/u);
  assert.equal(existsSync(join(owned, 'activation.json')), false);
});

test('a capture record that is not active or not well formed leaves capture inert', async (t) => {
  const { home, record, env } = await setup(t);
  await mkdir(join(home, 'sg-home'));
  const valid = { state: 'active', store: { file: resolve(home, 'stores', 'memory.json'), storage: 'json' }, originId: 'origin_x', coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS } };
  const write = (capture) => writeFile(record, JSON.stringify({ version: 1, capabilities: { capture } }));
  await write(valid);
  assert.deepEqual(await activeCapture(env), valid);
  for (const [label, capture] of [
    ['deactivated', { ...valid, state: 'deactivated' }],
    ['a relative store', { ...valid, store: { file: 'memory.json', storage: 'json' } }],
    ['an unknown storage', { ...valid, store: { ...valid.store, storage: 'csv' } }],
    ['no origin', { ...valid, originId: ' ' }],
    ['an unknown coverage', { ...valid, coverage: { projects: 'some' } }],
    ['an empty only', { ...valid, coverage: { projects: 'only', include: [] } }],
    ['a repeated exclusion', { ...valid, coverage: { projects: 'all', exclude: ['a', 'a'] } }],
    ['a missing limit', { ...valid, limits: { ...CAPTURE_LIMITS, maxQueueDepth: undefined } }],
    ['a zero limit', { ...valid, limits: { ...CAPTURE_LIMITS, maxItemBytes: 0 } }],
    ['a malformed server list', { ...valid, mcpServerNames: ['shadowgraph', 'shadowgraph'] }]
  ]) {
    await write(capture);
    assert.equal(await activeCapture(env), null, label);
  }
  await writeFile(record, '{not json');
  assert.equal(await activeCapture(env), null, 'an unreadable record');
  assert.equal(await activeCapture({ SHADOWGRAPH_HOME: 'relative' }), null, 'a relative home');
  assert.equal(coverageIssue({ projects: 'only', include: ['app'] }), null);
  assert.equal(limitsIssue(CAPTURE_LIMITS), null);
  assert.deepEqual(Object.keys(CAPTURE_LIMITS), ['maxStoreBytes', 'maxQueueDepth', 'maxItemBytes', 'maxItemsPerSession']);
});

// A verified runtime written here: a gzipped ustar archive of `package/<name>` entries, the files beside it, and the
// manifest naming its digest (src/host-hooks.js pinnedRuntime checks all three).
async function syntheticRuntime(directory, files) {
  const blocks = [];
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    const header = Buffer.alloc(512);
    header.write(`package/${name}`, 0);
    header.write(`${body.length.toString(8).padStart(11, '0')}\0`, 124);
    header.write('0', 156);
    header.write('ustar\0', 257);
    blocks.push(header, body, Buffer.alloc((512 - (body.length % 512)) % 512));
    await mkdir(join(directory, name, '..'), { recursive: true });
    await writeFile(join(directory, name), body);
  }
  const tarball = gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
  await writeFile(join(directory, 'package.tgz'), tarball);
  await writeFile(join(directory, 'runtime.json'), JSON.stringify({ commit: 'a'.repeat(40), tree: 'b'.repeat(40), tarballSha256: createHash('sha256').update(tarball).digest('hex') }));
  return directory;
}

test('lifecycle runtime floor refuses template-only capture and retention-blind delivery before writing settings or activation', async (t) => {
  const { home, store, record } = await setup(t);
  const settings = join(home, 'settings-fixture.json');
  await writeFile(settings, '{}');
  const base = { 'src/cli.js': '// synthetic', 'integrations/claude-code.capture-hooks.json': '{}' };
  const prior = await syntheticRuntime(join(home, 'shadowgraph-runtime', 'prior'), base);
  const reader = await syntheticRuntime(join(home, 'shadowgraph-runtime', 'reader'), { ...base, 'src/internal/capture-retention.js': '// semantic reader fixture' });
  const deliver = (runtime) => run(['activate', 'delivery', '--evidence', 'fixture', '--store', store, '--host-version', VERIFIED, '--settings', settings, '--runtime', runtime], home);
  for (const runtime of [prior, reader]) {
    const result = await activate(home, store, '--runtime', runtime);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /activation_runtime_cannot_capture_lifecycle/u);
    const hook = await run(['install-hooks', '--capture', '--settings', settings, '--runtime', runtime], home);
    assert.equal(hook.code, 1);
    assert.match(hook.stderr, /runtime_cannot_capture_lifecycle/u);
    assert.equal(await readFile(settings, 'utf8'), '{}');
    assert.equal(existsSync(record), false);
  }
  // Policy alone imposes the reader floor, even before the first capture.
  await writeFile(ledgerPath(store), JSON.stringify({ version: 1, retentionOverrides: [{ project: 'alpha', days: 1 }] }));
  const refused = await deliver(prior);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /activation_runtime_cannot_read_retention/u);
  assert.equal(existsSync(record), false);
  assert.equal((await deliver(reader)).code, 0);
});

test('a pinned runtime must be able to capture, and every installed handler must run it with its own verb (FND-P6-10)', async (t) => {
  const { home, store } = await setup(t);
  const settings = join(home, 'settings-fixture.json');
  // A real runtime of a build before the capture verb, PR-36a's, where the history holds that commit; a checkout
  // without it (a shallow CI clone) uses a verified runtime written here without the capture template instead. npm's
  // cache and logs go to the scratch directory, never the user's.
  const PR36A = '0534b0734dce293f21ed31c214a9e2010721bc97';
  let held = true;
  try { execFileSync('git', ['cat-file', '-e', `${PR36A}^{commit}`], { stdio: 'ignore' }); } catch { held = false; }
  let old;
  if (held) {
    const installed = await new Promise((settle) => {
      const child = spawn(process.execPath, [resolve('scripts/install-runtime.mjs'), '--commit', PR36A], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: join(home, 'sg-home'), LOCALAPPDATA: join(home, 'local'), APPDATA: join(home, 'roaming'), npm_config_cache: join(home, 'npm-cache') } });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => settle({ code, stdout, stderr }));
    });
    assert.equal(installed.code, 0, installed.stderr);
    old = JSON.parse(installed.stdout);
  } else {
    t.diagnostic(`${PR36A} is not in this checkout's history: a synthetic runtime without the capture template stands in`);
    old = { path: await syntheticRuntime(join(home, 'shadowgraph-runtime', 'unable'), { 'src/cli.js': '// synthetic' }), commit: 'a'.repeat(40) };
  }
  assert.equal(old.captures ?? false, false);
  const refused = await activate(home, store, '--runtime', old.path);
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /activation_runtime_cannot_capture/u);
  assert.match((await run(['install-hooks', '--capture', '--settings', settings, '--runtime', old.path], home)).stderr, /runtime_cannot_capture/u);
  // Delivery on such a runtime may read a store holding no capture, and is refused one that holds it.
  const deliverOld = () => run(['activate', 'delivery', '--evidence', 'ag2-receipt', '--store', store, '--host-version', VERIFIED, '--settings', settings, '--runtime', old.path], home);
  assert.equal((await deliverOld()).code, 0);
  const kept = createJsonFileStore(store);
  const graph = createShadowGraph();
  graph.importData(await kept.load());
  privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin_x', text: 'captured', admission: { limits: { ...CAPTURE_LIMITS }, storeBytes: 0 }, source: { event: 'UserPromptSubmit', sessionId: 'session-1' } });
  await kept.save(privilegedSnapshot(graph));
  assert.match((await deliverOld()).stderr, /activation_runtime_cannot_read_capture/u);
  assert.equal((await run(['deactivate', 'delivery'], home)).code, 0);
  // The lifecycle build ships its declared capability with the reader and hook.
  const template = readFileSync('integrations/claude-code.capture-hooks.json', 'utf8');
  const able = await syntheticRuntime(join(home, 'shadowgraph-runtime', 'able'), { 'src/cli.js': '// synthetic', 'integrations/claude-code.capture-hooks.json': template,
    'src/internal/capture-retention.js': '// semantic reader fixture', 'src/capture-lifecycle-capability.json': '{"version":1}' });
  const accepted = await activate(home, store, '--runtime', able, '--mcp-servers', 'memory,shadowgraph');
  assert.equal(accepted.code, 0, accepted.stderr);
  const capture = JSON.parse(accepted.stdout).record.capabilities.capture;
  assert.deepEqual([capture.runtime.captures, capture.mcpServerNames, capture.hooksInstalled], [true, ['memory', 'shadowgraph'], false]);
  assert.match((await activate(home, store, '--mcp-servers', 'memory,memory')).stderr, /activation_projects_malformed \(--mcp-servers\)/u);
  // Installed handlers of either kind that run another runtime are refused; both kinds running it are accepted.
  const ours = (runtime, kind) => ({ hooks: [{ type: 'command', command: runtimeHookCommand(runtime, process.execPath, kind), timeout: 10 }] });
  await writeFile(settings, JSON.stringify({ hooks: { SessionStart: [ours(able, 'deliver')], Stop: [ours(old.path, 'capture')] } }));
  assert.match((await activate(home, store, '--runtime', able)).stderr, /activation_hooks_run_another_runtime/u);
  await writeFile(settings, JSON.stringify({ hooks: { SessionStart: [ours(able, 'deliver')], Stop: [ours(able, 'capture')] } }));
  const both = await activate(home, store, '--runtime', able);
  assert.equal(both.code, 0, both.stderr);
  assert.equal(JSON.parse(both.stdout).record.capabilities.capture.hooksInstalled, true);
  // Delivery on the same runtime accepts capture's handlers beside its own.
  const delivery = await run(['activate', 'delivery', '--evidence', 'ag2-receipt', '--store', store, '--host-version', VERIFIED, '--settings', settings, '--runtime', able], home);
  assert.equal(delivery.code, 0, delivery.stderr);
  assert.equal(JSON.parse(delivery.stdout).record.capabilities.delivery.hooksInstalled, true);
});
