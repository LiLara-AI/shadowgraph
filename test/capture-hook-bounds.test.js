// The capture hook's bounds and edges (programme plan revision 6 PR-36c; PR-36 design review D-2, D-3, D-5, D-13,
// D-17; the PR-36c tests review, red tests RT-1 to RT-19): the lock and deadline bounds, the artefacts classification
// sees, the outcome rule's forms, the store footprint, the installer's kinds, the manifest's declarations and the
// privileged writer's one caller. Every CLI run points HOME, USERPROFILE and SHADOWGRAPH_HOME into a scratch directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, unlink, utimes, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { CAPTURE_LIMITS, captureDeadlineMs, observedEvent, runCapture, storeFootprint, superviseCapture, toolOutcome } from '../src/capture-hook.js';
import { changeHookSettings, runtimeHookCommand, shadowGraphHookKind } from '../src/host-hooks.js';
import { privilegedBindProject, privilegedRecordCapture, privilegedRecordSelfEvent, privilegedSnapshot } from '../src/internal/snapshot.js';
import { mintOriginId } from '../src/scope.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const CLI = resolve('src/cli.js');
const bytes = (value) => JSON.stringify(value);
const slash = (path) => path.replaceAll('\\', '/');

async function setup(t, { record = {}, storage = 'json' } = {}) {
  const root = await scratchDirectory(t, 'shadowgraph-capture-bounds-');
  const cwd = join(root, 'work');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  const home = join(root, 'home');
  const sgHome = join(root, 'sg-home');
  await mkdir(home);
  await mkdir(sgHome);
  const file = join(root, 'private', storage === 'sqlite' ? 'memory.db' : 'memory.json');
  await mkdir(dirname(file));
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'alpha', confirmed: true }));
  const graph = createShadowGraph();
  privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'alpha', reason: 'synthetic capture test', surface: 'cli' });
  const store = await createStorage({ type: storage, file });
  await store.save(privilegedSnapshot(graph));
  store.close?.();
  const capture = { state: 'active', changedAt: '2026-01-01T00:00:00.000Z', evidence: 'synthetic', store: { file, storage }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'], ...record };
  const activation = join(sgHome, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { capture } }));
  return { root, cwd, file, home, sgHome, activation, capture, storage, env: { HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: sgHome } };
}
const load = async ({ file, storage }) => {
  const store = await createStorage({ type: storage, file });
  try { return await store.load(); } finally { store.close?.(); }
};
const items = async (s) => (await load(s)).records.filter((item) => item.kind === 'capture');
const prompt = (text, fields = {}) => JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'session-1', cwd: '/work', prompt: text, message_id: 'msg_1', ...fields });
const bash = (command, fields = {}) => JSON.stringify({ hook_event_name: 'PostToolUse', session_id: 'session-1', cwd: '/work', tool_name: 'Bash', tool_input: { command }, tool_response: 'x', tool_use_id: 'toolu_1', ...fields });
const capture = (s, input, options = {}) => runCapture({ capture: s.capture, input, deadline: Date.now() + 10_000, record: s.activation, home: s.home, cwd: s.cwd, ...options });

function spawnCli(args, { cwd, env, input = '' }) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SHADOWGRAPH_')));
  return new Promise((settle, fail) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { ...base, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => settle({ code, stdout, stderr, ms: Date.now() - started }));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
}
const hook = (s, input, env = {}) => spawnCli(['capture', '--hook'], { cwd: s.cwd, env: { ...s.env, ...env }, input });
const silent = (result, label) => assert.deepEqual([result.code, result.stdout, result.stderr], [0, '', ''], label);

// The pid of a process that has exited.
const deadPid = () => new Promise((settle) => {
  const child = spawn(process.execPath, ['-e', '']);
  child.on('close', () => settle(child.pid));
});

test('RT-1 a success is observed only for a single command, however it is written; no non-zero status is', () => {
  const source = { event: 'PostToolUse', toolCallId: 'toolu_1', toolName: 'Bash' };
  const absent = { outcomeEvidence: { state: 'absent', source } };
  const outcome = (command, exitCode) => toolOutcome({ event: 'PostToolUse', toolCallId: 'toolu_1', toolName: 'Bash', toolInput: { command }, toolResponse: { exit_code: exitCode } });
  for (const command of ['npm test', 'grep a b', 'egrep a b', 'fgrep a b', 'rg a', 'ag a', 'diff a b', 'cmp a b', 'test -f a', '[ -f a ]', '[[ -f a ]]', 'LC_ALL=C grep a b', 'env grep a b', 'FOO=1 npm test', 'npm test;']) assert.deepEqual(outcome(command, 1), absent, command);
  for (const command of ['FOO=1 npm test', 'env npm test', 'env LC_ALL=C npm test', '/usr/bin/grep a b', 'npm test;']) assert.equal(outcome(command, 0).resultClass, 'succeeded', command);
  for (const command of ['', 'FOO=1', 'a && b', 'a | b']) assert.deepEqual(outcome(command, 0), absent, `no single program: ${JSON.stringify(command)}`);
});

test('RT-2 SHADOWGRAPH_CAPTURE_DEADLINE_MS only shortens the deadline', () => {
  assert.deepEqual(['60000', '100', '0', '-5', 'abc', undefined].map((value) => captureDeadlineMs(value === undefined ? {} : { SHADOWGRAPH_CAPTURE_DEADLINE_MS: value })), [5000, 100, 5000, 5000, 5000, 5000]);
});

test('RT-3 the supervisor swallows a worker error and does not exit early for it', async () => {
  const worker = new EventEmitter();
  let exits = 0;
  const done = superviseCapture(worker, { deadline: Date.now() + 10_000, hardCap: Date.now() + 20_000, exit: () => { exits += 1; } });
  assert.doesNotThrow(() => worker.emit('error', new Error('the worker failed to start')));
  assert.equal(exits, 0);
  worker.emit('exit');
  await done;
});

test('RT-4 a lock a dead writer left is taken over, and the capture is written', async (t) => {
  const s = await setup(t);
  const lock = `${s.file}.lock`;
  await writeFile(lock, `${await deadPid()}:${Date.now() - 60_000}:crashed`);
  const old = new Date(Date.now() - 5_000);
  await utimes(lock, old, old);
  assert.equal(await capture(s, prompt('after a crash'), { deadline: Date.now() + 3_000 }), 'written');
  assert.equal((await items(s)).length, 1);
});

test('RT-5 a live lock is waited for no longer than the time left, and nothing is written', async (t) => {
  const s = await setup(t);
  const before = bytes(await load(s));
  await writeFile(`${s.file}.lock`, `${process.pid}:${Date.now()}:held`);
  const started = Date.now();
  await assert.rejects(capture(s, prompt('blocked'), { deadline: started + 1_500 }));
  assert.ok(Date.now() - started < 2_500, `${Date.now() - started} ms`);
  assert.equal(bytes(await load(s)), before);
});

test('RT-6 the commit margin is twice the time spent inside the store, and at least 250 ms', async (t) => {
  const s = await setup(t);
  const clock = (spent) => {
    const base = Date.now();
    let calls = 0;
    // Before the section: the git bound, the lock bound, then `entered`; everything after is `spent` later.
    return { base, now: () => (calls++ < 3 ? base : base + spent) };
  };
  const slow = clock(400);
  assert.equal(await capture(s, prompt('slow', { message_id: 'msg_a' }), { deadline: slow.base + 1_000, now: slow.now }), 'out_of_time', '400 + 2 x 400 > 1000');
  assert.deepEqual(await items(s), []);
  const quick = clock(100);
  assert.equal(await capture(s, prompt('quick', { message_id: 'msg_b' }), { deadline: quick.base + 1_000, now: quick.now }), 'written', '100 + max(250, 200) <= 1000');
});

test('RT-7 the store bytes admission sees include an orphaned temporary file', async (t) => {
  const s = await setup(t, { record: { limits: { ...CAPTURE_LIMITS, maxStoreBytes: 256 * 1024 } } });
  await writeFile(join(dirname(s.file), `.${basename(s.file)}.1.2.orphan.tmp`), Buffer.alloc(512 * 1024));
  assert.equal(await capture(s, prompt('into a full store')), 'refused');
  assert.deepEqual(await items(s), []);
});

// The store's size is measured under its lock (PR-36b amendment; PR-36c contract review K-1): a burst of hooks against
// a store with room for a few items stops at its ceiling, since each sees the size the one before it left.
test('RT-7b a burst against a nearly full store stops at its ceiling', async (t) => {
  const probe = await setup(t);
  const empty = await storeFootprint(probe.file);
  const limit = empty + 20_000;
  const s = await setup(t, { record: { limits: { ...CAPTURE_LIMITS, maxStoreBytes: limit } } });
  const results = await Promise.all(Array.from({ length: 8 }, (_, index) => hook(s, prompt(`burst ${index}`, { message_id: `msg_${index}`, session_id: `session-${index}` }))));
  for (const result of results) silent(result);
  const written = (await items(s)).length;
  assert.ok(written >= 1 && written < 8, `${written} of 8 written`);
  assert.ok(await storeFootprint(s.file) <= limit, `the store stays within ${limit} bytes`);
});

// A re-delivery is known by the id the store already held, never by the clock (correctness review C-5): a clock that
// steps back while a new item is written keeps it, and a re-delivery stays one however its time compares.
test('RT-7c a new item is kept when the clock steps back, and a re-delivery is held whatever the clock says', async (t) => {
  const s = await setup(t);
  const base = Date.now();
  let calls = 0;
  const steppedBack = () => (calls++ < 3 ? base : base - 2_000);
  assert.equal(await capture(s, prompt('new, as the clock steps back', { message_id: 'msg_back' }), { deadline: base + 10_000, now: steppedBack }), 'written');
  const revision = (await load(s)).revision;
  const ahead = () => Date.now() + 3_600_000;
  assert.equal(await capture(s, prompt('new, as the clock steps back', { message_id: 'msg_back' }), { deadline: ahead() + 10_000, now: ahead }), 'already_held');
  assert.equal((await load(s)).revision, revision);
  assert.equal((await items(s)).length, 1);
});

// The tests review's round-2 red tests (R2-1 to R2-3). R2-1 is deterministic: a lock the test holds lines the writers
// up, so each measures the store the one before it left.
test('R2-1 concurrent captures near the store ceiling admit one item, since each measures the store under the fence', async (t) => {
  const promptOf = (id) => prompt('the same prompt', { message_id: id });
  // The kernel's admission threshold for one item on this store, found by bisection on a graph (no disk).
  const probe = await setup(t);
  const payload = await load(probe);
  const s0 = await storeFootprint(probe.file);
  const admits = (max) => {
    const graph = createShadowGraph();
    graph.importData(payload);
    return !privilegedRecordCapture(graph, {
      project: 'alpha', originId: probe.capture.originId, text: 'the same prompt', sourceIdentity: 'unattributed_observer',
      source: { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user', hostEventId: 'msg_0', toolCallId: null },
      observation: { host: 'claude-code', hostVersion: null, toolName: null, cwd: '/work', outcome: null },
      admission: { limits: { ...CAPTURE_LIMITS, maxStoreBytes: max }, storeBytes: s0 }
    }).refused;
  };
  let low = s0;
  let high = s0 + 1024 * 1024;
  assert.ok(admits(high) && !admits(low));
  while (high - low > 1) { const middle = Math.floor((low + high) / 2); if (admits(middle)) high = middle; else low = middle; }
  const estimate = high - s0;
  // What one capture adds on disk.
  assert.equal(await capture(probe, promptOf('msg_0')), 'written');
  const growth = (await storeFootprint(probe.file)) - s0;
  assert.ok(growth > 2 && growth < estimate, JSON.stringify({ estimate, growth }));
  // The same store, fresh, with a ceiling one item wide.
  const s = await setup(t);
  const base = await storeFootprint(s.file);
  s.capture.limits.maxStoreBytes = base + estimate + Math.floor(growth / 2);
  const lock = `${s.file}.lock`;
  await writeFile(lock, `${process.pid}:${Date.now()}:held-by-the-test`);
  const released = new Promise((settle) => setTimeout(() => unlink(lock).then(settle), 2_000));
  const results = await Promise.all(['msg_1', 'msg_2', 'msg_3', 'msg_4'].map((id) => capture(s, promptOf(id))));
  await released;
  assert.equal((await items(s)).length, 1, JSON.stringify({ base, estimate, growth, results }));
  assert.equal(results.filter((result) => result === 'written' || result === 'refused').length, 4);
});

test('R2-2 delivery on a runtime that cannot capture is refused a store holding only capture sessions, or a busy one', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-delivery-bounds-');
  const store = join(home, 'stores', 'memory.json');
  await mkdir(dirname(store), { recursive: true });
  const verified = JSON.parse(readFileSync('integrations/claude-code.coverage.json', 'utf8')).verifiedVersion;
  const env = { HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: join(home, 'sg-home') };
  const unable = await syntheticRuntime(join(home, 'shadowgraph-runtime', 'unable'), { 'src/cli.js': '// synthetic' });
  const activate = (file = store, storage = 'json') => spawnCli(['activate', 'delivery', '--evidence', 'ag2-receipt', '--store', file, '--storage', storage, '--host-version', verified, '--settings', join(home, 'settings-fixture.json'), '--runtime', unable], { cwd: home, env });
  const graph = createShadowGraph();
  const saved = await createStorage({ type: 'json', file: store });
  await saved.save(privilegedSnapshot(graph));
  const clean = await activate();
  assert.equal(clean.code, 0, clean.stderr);
  assert.equal((await spawnCli(['deactivate', 'delivery'], { cwd: home, env })).code, 0);
  // Busy (a SQLite store another writer holds: delivery reads a JSON store whole, never busy): it may hold capture.
  const busy = join(home, 'stores', 'memory.db');
  await writeFile(busy, 'SQLite format 3\0');
  await writeFile(`${busy}.lock`, `${process.pid}:${Date.now()}:held`);
  assert.match((await activate(busy, 'sqlite')).stderr, /activation_runtime_cannot_read_capture/u, 'a busy store may hold capture');
  // Only a self-event was counted: a session record, no item and no content.
  graph.importData(await saved.load());
  privilegedRecordSelfEvent(graph, { project: 'alpha', originId: mintOriginId(), signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'session-1' } });
  const snapshot = privilegedSnapshot(graph);
  assert.deepEqual([snapshot.records.filter((record) => record.kind === 'capture').length, snapshot.captureSessions.length], [0, 1]);
  await saved.save(snapshot);
  assert.match((await activate()).stderr, /activation_runtime_cannot_read_capture/u, 'a session record is capture state');
});

test('R2-3 an exit_code that is not the integer 0 is no success', () => {
  const outcome = (response) => toolOutcome({ event: 'PostToolUse', toolCallId: 't', toolName: 'Bash', toolInput: { command: 'npm test' }, toolResponse: response }).outcomeEvidence.state;
  assert.deepEqual([{ exit_code: 0 }, { exit_code: '0' }, { exit_code: false }, { exit_code: null }, { exit_code: '' }].map(outcome), ['observed', 'absent', 'absent', 'absent', 'absent']);
});

test('RT-8 a touch of the activation record, the worktree binding or the runtime is a self-event', async (t) => {
  const s = await setup(t);
  const runtimeDirectory = join(s.root, 'rt', 'abc');
  s.capture.runtime = { path: runtimeDirectory };
  assert.equal(await capture(s, bash(`cat ${slash(s.activation)}`)), 'self_event', 'the activation record');
  assert.equal(await capture(s, bash(`cat ${slash(join(s.cwd, '.shadowgraph', 'project-binding.json'))}`)), 'self_event', 'the worktree binding');
  assert.equal(await capture(s, bash(`node ${slash(join(runtimeDirectory, 'src', 'cli.js'))} search {}`)), 'self_event', 'the runtime entry point');
  assert.equal(await capture(s, bash('cat ~/../sg-home/activation.json')), 'self_event', 'the record, through the home it was given');
  assert.deepEqual(await items(s), []);
  // The spawned hook passes the record it read as an artefact too.
  const spawned = await setup(t);
  silent(await hook(spawned, bash(`cat ${slash(spawned.activation)}`)));
  assert.deepEqual(await items(spawned), []);
  assert.deepEqual((await load(spawned)).captureSessions[0].selfEvents, { 'S-1': { PostToolUse: 1 } });
});

test('RT-9 the spawned hook is silent on the excluded, newer-schema, refused and SQLite paths', async (t) => {
  const excluded = await setup(t, { record: { coverage: { projects: 'all', exclude: ['alpha'] } } });
  silent(await hook(excluded, prompt('excluded')), 'excluded');
  assert.deepEqual(await items(excluded), []);
  const newer = await setup(t);
  const payload = await load(newer);
  await writeFile(newer.file, JSON.stringify({ ...payload, schemaVersion: payload.schemaVersion + 1 }));
  const kept = await readFile(newer.file, 'utf8');
  silent(await hook(newer, prompt('newer')), 'newer schema');
  assert.equal(await readFile(newer.file, 'utf8'), kept);
  const refused = await setup(t, { record: { limits: { ...CAPTURE_LIMITS, maxItemBytes: 16 } } });
  silent(await hook(refused, prompt('longer than sixteen bytes')), 'refused');
  assert.deepEqual(await items(refused), []);
  try { await import('node:sqlite'); } catch { return; }
  const sqlite = await setup(t, { storage: 'sqlite' });
  silent(await hook(sqlite, prompt('into sqlite')), 'sqlite');
  assert.deepEqual(await items(sqlite), [], 'a SQLite store is never captured into');
});

test('RT-10 update refuses a public export and writes nothing', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-update-bounds-');
  const kinds = [['json', join(root, 'data.json')]];
  try { await import('node:sqlite'); kinds.push(['sqlite', join(root, 'data.db')]); } catch {}
  for (const [type, file] of kinds) {
    const store = await createStorage({ type, file });
    await store.save(privilegedSnapshot(createShadowGraph()));
    const revision = (await store.load()).revision;
    await assert.rejects(store.update(() => createShadowGraph().exportData({ project: 'alpha' })), { code: 'public_export_not_a_store' }, type);
    assert.equal((await store.load()).revision, revision, type);
    // One update writes once: revision + 1.
    assert.equal(await store.update((current) => current), revision + 1, type);
    store.close?.();
  }
});

test('RT-11 reinstalling a kind beside the other changes nothing, and removing an absent kind removes nothing', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-hooks-bounds-');
  const settings = join(home, 'host-hooks-fixture.json');
  await writeFile(settings, `${JSON.stringify({ hooks: {} }, null, 2)}\n`);
  assert.equal((await changeHookSettings(settings, 'install')).changed, true);
  assert.equal((await changeHookSettings(settings, 'uninstall', { kind: 'capture' })).removed, 0, 'no capture handler to remove');
  assert.equal((await changeHookSettings(settings, 'install', { kind: 'capture' })).changed, true);
  const both = await readFile(settings, 'utf8');
  assert.equal((await changeHookSettings(settings, 'install')).changed, false, 'delivery again: nothing changes');
  assert.equal((await changeHookSettings(settings, 'install', { kind: 'capture' })).changed, false, 'capture again: nothing changes');
  assert.equal(await readFile(settings, 'utf8'), both);
  await assert.rejects(changeHookSettings(settings, 'uninstall', { kind: 'extract' }), /hook_kind_unknown/u);
});

// A verified runtime written here (as test/capture-activation.test.js builds one).
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

test('RT-12 activation records its own kind\'s handlers and the default server; install-hooks --capture runs the runtime\'s capture verb', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-activation-bounds-');
  const store = join(home, 'stores', 'memory.json');
  await mkdir(dirname(store), { recursive: true });
  const saved = await createStorage({ type: 'json', file: store });
  await saved.save(privilegedSnapshot(createShadowGraph()));
  const verified = JSON.parse(readFileSync('integrations/claude-code.coverage.json', 'utf8')).verifiedVersion;
  const env = { HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: join(home, 'sg-home') };
  const settings = join(home, 'settings-fixture.json');
  const cli = (args) => spawnCli(args, { cwd: home, env });
  const activate = (capability) => cli(['activate', capability, '--evidence', 'ag2-receipt', '--store', store, '--host-version', verified, '--settings', settings]);
  // Only delivery's handlers installed: capture's are not.
  await writeFile(settings, JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'shadowgraph deliver --hook', timeout: 10 }] }] } }));
  const captureOnly = await activate('capture');
  assert.equal(captureOnly.code, 0, captureOnly.stderr);
  const recorded = JSON.parse(captureOnly.stdout).record.capabilities.capture;
  assert.deepEqual([recorded.hooksInstalled, recorded.mcpServerNames], [false, ['shadowgraph']], 'no capture handler; the default server name');
  // Only capture's handlers installed: delivery's are not.
  await writeFile(settings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'shadowgraph capture --hook', timeout: 10 }] }] } }));
  const deliveryOnly = await activate('delivery');
  assert.equal(deliveryOnly.code, 0, deliveryOnly.stderr);
  assert.equal(JSON.parse(deliveryOnly.stdout).record.capabilities.delivery.hooksInstalled, false);
  // install-hooks --capture with a runtime that can capture writes that runtime's capture command.
  const template = readFileSync('integrations/claude-code.capture-hooks.json', 'utf8');
  const able = await syntheticRuntime(join(home, 'shadowgraph-runtime', 'able'), { 'src/cli.js': '// synthetic', 'integrations/claude-code.capture-hooks.json': template });
  const hooksFile = join(home, 'host-hooks-fixture.json');
  const installed = await cli(['install-hooks', '--capture', '--settings', hooksFile, '--runtime', able]);
  assert.equal(installed.code, 0, installed.stderr);
  const handlers = Object.values(JSON.parse(await readFile(hooksFile, 'utf8')).hooks).flat().flatMap((group) => group.hooks);
  assert.equal(handlers.length, 6, 'the four events with material and the transcript cursor\'s two flush triggers (PR-36)');
  for (const handler of handlers) {
    assert.equal(shadowGraphHookKind(handler), 'capture');
    assert.equal(handler.command, runtimeHookCommand(realpathSync.native(able), process.execPath, 'capture'));
  }
});

test('RT-13 a Stop is captured as the assistant\'s item; only a failure carries its error', async (t) => {
  const s = await setup(t);
  assert.equal(await capture(s, JSON.stringify({ hook_event_name: 'Stop', session_id: 'session-1', last_assistant_message: 'Done.' })), 'written');
  const [item] = await items(s);
  assert.deepEqual([item.source.event, item.source.role, item.source.hostEventId], ['Stop', 'assistant', null]);
  assert.doesNotMatch(observedEvent({ hook_event_name: 'PostToolUse', session_id: 's', tool_name: 'Read', tool_input: {}, tool_response: 'ok', tool_use_id: 't', error: 'not a failure' }).text, /error/u);
});

test('RT-14 the footprint counts each side file and only a .tmp beside the store', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-footprint-bounds-');
  const file = join(root, 'memory.db');
  await writeFile(file, 'x'.repeat(10));
  for (const [suffix, size] of [['-wal', 1], ['-shm', 2], ['-journal', 4]]) await writeFile(`${file}${suffix}`, 'x'.repeat(size));
  await writeFile(join(root, '.memory.db.1.2.abc.tmp'), 'x'.repeat(8));
  await writeFile(join(root, '.memory.db.backup'), 'x'.repeat(100));
  assert.equal(await storeFootprint(file), 25);
});

test('RT-15 only the capture hook calls the privileged capture writer', async () => {
  const callers = { privilegedRecordCapture: [], privilegedRecordSelfEvent: [], privilegedTransitionCapture: [] };
  for (const directory of ['src', 'scripts', 'bin', 'integrations']) {
    let names = [];
    try { names = (await readdir(directory, { recursive: true })).filter((name) => /\.(?:m?js|cjs|py)$/u.test(name)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    for (const name of names) {
      const source = await readFile(join(directory, name), 'utf8');
      for (const verb of Object.keys(callers)) if (source.includes(verb)) callers[verb].push(`${directory}/${name.replaceAll('\\', '/')}`);
    }
  }
  for (const verb of Object.keys(callers)) callers[verb].sort();
  assert.deepEqual(callers, { privilegedRecordCapture: ['src/capture-hook.js', 'src/internal/snapshot.js'], privilegedRecordSelfEvent: ['src/capture-hook.js', 'src/internal/snapshot.js'], privilegedTransitionCapture: ['src/internal/snapshot.js'] });
});

test('RT-16 check-integrations refuses a capture template with async, a matcher, another event or a short timeout', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-integrations-bounds-');
  for (const part of ['scripts', 'integrations', 'src']) await cp(part, join(root, part), { recursive: true });
  await cp('package.json', join(root, 'package.json'));
  const check = () => new Promise((settle) => spawn(process.execPath, [join(root, 'scripts', 'check-integrations.mjs')], { stdio: 'ignore' }).on('close', settle));
  assert.equal(await check(), 0, 'the shipped templates pass');
  const template = JSON.parse(readFileSync('integrations/claude-code.capture-hooks.json', 'utf8'));
  const handler = template.hooks.Stop[0].hooks[0];
  for (const variant of [
    { hooks: { ...template.hooks, Stop: [{ hooks: [{ ...handler, async: true }] }] } },
    { hooks: { ...template.hooks, Stop: [{ matcher: '*', hooks: [handler] }] } },
    { hooks: { ...template.hooks, SubagentStop: template.hooks.Stop } },
    { hooks: { ...template.hooks, Stop: [{ hooks: [{ ...handler, timeout: 8 }] }] } }
  ]) {
    await writeFile(join(root, 'integrations', 'claude-code.capture-hooks.json'), `${JSON.stringify(variant, null, 2)}\n`);
    assert.notEqual(await check(), 0, JSON.stringify(variant));
  }
});

// D-3 end to end. Self-calibrating: it measures, on the child's own clock, when this machine enters and leaves the
// store, then sets the deadline between the two; it skips, saying so, if it cannot. Heavy (a store of about 90 MB).
test('RT-17 a deadline that falls inside the store waits for it to leave and leaves no lock', async (t) => {
  const s = await setup(t);
  const graph = createShadowGraph();
  graph.importData(await load(s));
  for (let index = 0; index < 8000; index += 1) graph.addDecision({ project: 'alpha', title: `decision ${index} ${'x'.repeat(2000)}`, chosen: 'y'.repeat(2000) });
  const store = await createStorage({ type: 'json', file: s.file });
  await store.save(privilegedSnapshot(graph));
  // Over the store limit: the first capture opens the episode; later ones write nothing, so the section is load and import.
  silent(await hook(s, prompt('opens the episode', { message_id: 'msg_0' })));
  // The child's clock starts once Node has started and imported the hook: an inert run (no record) measures that
  // offset, from above (it includes the inert run's own exit).
  const inert = await hook(s, prompt('inert'), { SHADOWGRAPH_HOME: join(s.root, 'no-record') });
  silent(inert);
  const watched = async (label, env = {}) => {
    const lock = `${s.file}.lock`;
    const started = Date.now();
    let enter = null;
    let leave = null;
    const poll = setInterval(() => {
      const held = existsSync(lock);
      if (held && enter === null) enter = Date.now() - started;
      if (!held && enter !== null && leave === null) leave = Date.now() - started;
    }, 2);
    const result = await hook(s, prompt(label, { message_id: label }), env);
    clearInterval(poll);
    return { ...result, enter, leave, ms: Date.now() - started, lockLeft: existsSync(lock) };
  };
  const calibration = await watched('calibrate');
  silent(calibration);
  if (calibration.enter === null || calibration.leave === null) { t.skip(`the store was not entered: ${JSON.stringify(calibration)}`); return; }
  // On the child's clock: the worker takes the lock only with 250 ms left, and must still be inside at the deadline.
  const low = calibration.enter - inert.ms + 250;
  const high = calibration.leave - inert.ms;
  if (high - low < 120) { t.skip(`cannot straddle here: ${JSON.stringify({ offset: inert.ms, low, high })}`); return; }
  const deadline = Math.floor((low + high) / 2);
  const run = await watched('straddled', { SHADOWGRAPH_CAPTURE_DEADLINE_MS: String(deadline) });
  silent(run);
  if (run.enter === null) { t.skip(`did not enter before ${deadline} ms: ${JSON.stringify(run)}`); return; }
  const context = JSON.stringify({ offset: inert.ms, low, high, deadline, ...run });
  assert.equal(run.lockLeft, false, `the store's lock is released: ${context}`);
  assert.ok(run.leave !== null && run.ms >= run.leave, `the process outlives the section: ${context}`);
  t.diagnostic(context);
});

test('RT-18 in a git work tree the shared binding is an artefact, and outsideWorkTree captures nothing', async (t) => {
  const git = (cwd, ...args) => new Promise((settle, fail) => spawn('git', args, { cwd, stdio: 'ignore' }).on('close', (code) => (code === 0 ? settle() : fail(new Error(`git ${args.join(' ')}: ${code}`)))));
  const s = await setup(t);
  await git(s.cwd, 'init', '-q');
  assert.equal(await capture(s, bash(`cat ${slash(join(s.cwd, '.git', 'shadowgraph-project-binding.json'))}`)), 'self_event', 'the shared-repository binding');
  assert.equal(await capture(s, prompt('inside the tree')), 'written', 'the recorded worktree binding still resolves');
  // core.worktree names another directory, whose binding the store has also recorded.
  const other = join(s.root, 'elsewhere');
  await mkdir(join(other, '.shadowgraph'), { recursive: true });
  await writeFile(join(other, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(other), project: 'alpha', confirmed: true }));
  const store = await createStorage({ type: 'json', file: s.file });
  const graph = createShadowGraph();
  graph.importData(await store.load());
  privilegedBindProject(graph, { type: 'worktree', path: resolve(other), project: 'alpha', reason: 'synthetic capture test', surface: 'cli' });
  await store.save(privilegedSnapshot(graph));
  await git(s.cwd, 'config', 'core.worktree', slash(other));
  assert.equal(await capture(s, prompt('outside the tree', { message_id: 'msg_out' })), 'project_unresolved');
  assert.equal((await items(s)).length, 1);
});

test('RT-19 the coverage manifest declares each never-captured case and each declaration the plan requires', () => {
  const { capture: block } = JSON.parse(readFileSync('integrations/claude-code.coverage.json', 'utf8'));
  const has = (list, pattern, label) => assert.ok(block[list].some((line) => pattern.test(line)), `${list}: ${label}`);
  // PreCompact, SessionEnd and a content-less Stop are no longer never captured: the transcript cursor reads at them
  // (PR-36), and what it never reads is listed instead.
  for (const [pattern, label] of [[/not resolved/u, 'an unresolved project'], [/coverage leaves out/u, 'an uncovered project'], [/1 MiB/u, 'a payload over 1 MiB'], [/before the session's first capture/u, 'transcript before the anchor'], [/before capture was last activated/u, 'transcript while capture was off'], [/subagents' own transcript files/u, 'subagent transcripts'], [/worker's \(S-3\)/u, 'ShadowGraph\'s own sessions'], [/regular file/u, 'a transcript that is not a regular .jsonl file'], [/own traffic/u, 'self-events'], [/maxItemBytes/u, 'an item over maxItemBytes'], [/reasoning/u, 'hidden reasoning'], [/SQLite/u, 'a SQLite store']]) has('neverCaptured', pattern, label);
  for (const [pattern, label] of [[/session_in_another_project/u, 'D-6'], [/possibleDuplicateOf/u, 'the duplicate marker'], [/tool_calls_not_captured/u, 'gaps reconstructed for tool calls only'], [/capture_limited/u, 'the steady state'], [/exit_code[^.]*hypothetical/u, 'exit_code'], [/latency/u, 'latency'], [/Turning capture off/u, 'deactivation'], [/FND-P6-11/u, 'permissions'], [/redact/u, 'no redaction until PR-37'], [/lock/u, 'lock contention'], [/hypothesis[^.]*transcript_unrecognised/u, 'the transcript shape'], [/session_left_project/u, 'a session leaving its project'], [/transcript_reanchored[^.]*transcript_rewritten/u, 'anchoring'], [/compact/u, 'compaction'], [/pauses it/u, 'hooks reinstalled'], [/recorded twice/u, 'rule 2\'s limit'], [/merge import/u, 'merged cursors'], [/falls behind/u, 'a session the reads fall behind'], [/Subagent entries/u, 'sidechain entries'], [/never the place/u, 'the time a session left its project'], [/never read \(transcript_unrecognised\)/u, 'a malformed cursor'], [/rollback pin/u, 'an earlier build under-declares']]) has('declarations', pattern, label);
  assert.match(block.hostFields, /AG-2/u);
});
