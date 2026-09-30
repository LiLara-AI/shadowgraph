// Delivery activation (plan §26; programme plan revision 6 §3.4 PR-32 and §5): `activate delivery` and
// `deactivate delivery`, the pinned store and the store-confirmed binding on the hook path, the host version,
// and the deadline. Every CLI run points HOME, USERPROFILE and SHADOWGRAPH_HOME into a scratch directory.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedBindProject, privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { DELIVERY_DEADLINE_MS, deliveryDeadlineMs, runDeliver } from '../src/delivery.js';

const CLI = resolve('src/cli.js');
const VERIFIED = JSON.parse(readFileSync('integrations/claude-code.coverage.json', 'utf8')).verifiedVersion;
const hook = (event, prompt) => JSON.stringify({ session_id: 's-1', hook_event_name: event, ...(prompt === undefined ? {} : { prompt }) });

function run(args, { home, cwd = home, stdin = '', env = {} }) {
  return new Promise((settle) => {
    const started = Date.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd, stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: join(home, 'sg-home'), SHADOWGRAPH_FILE: '', SHADOWGRAPH_DELIVERY_DEADLINE_MS: '', ...env }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(stdin);
    child.on('close', (code) => settle({ code, stdout, stderr, ms: Date.now() - started }));
  });
}

// A home with a bound workspace and a store holding one decision, bound in the store as well unless asked not to.
async function setup(t, { title = 'queue broker choice', storeBinding = true } = {}) {
  const home = await scratchDirectory(t, 'shadowgraph-activation-');
  const cwd = join(home, 'work');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'app', confirmed: true }));
  const store = join(home, 'stores', 'memory.json');
  await mkdir(join(home, 'stores'));
  const graph = createShadowGraph();
  graph.addDecision({ project: 'app', title, chosen: 'kafka' });
  if (storeBinding) privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'app', reason: 'test' });
  await createJsonFileStore(store).save(privilegedSnapshot(graph));
  return { home, cwd, store, record: join(home, 'sg-home', 'activation.json') };
}

const activate = (home, store, version = VERIFIED) => run(['activate', 'delivery', '--evidence', 'receipt-test', '--store', store, '--host-version', version, '--settings', join(home, 'settings-fixture.json')], { home });
const payloadOf = (result) => (result.stdout ? JSON.parse(result.stdout).hookSpecificOutput.additionalContext : '');
const headOf = (result) => JSON.parse(payloadOf(result).split('\n').find((line) => line.startsWith('head: ')).slice(6));

test('the hook is inert before activation, delivers once delivery is active, and is inert again after deactivation; the history keeps both', async (t) => {
  const { home, cwd, store, record } = await setup(t);
  const before = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.deepEqual([before.code, before.stdout, before.stderr], [0, '', '']);
  assert.ok(before.ms < 2500, `${before.ms} ms: inert, it neither waits for input nor for its deadline`);
  // A capability the record already holds is kept; activating twice appends to the history.
  await mkdir(join(home, 'sg-home'));
  await writeFile(record, JSON.stringify({ version: 1, capabilities: { capture: { state: 'deactivated' } }, history: [{ capability: 'capture', state: 'deactivated' }] }));
  assert.equal((await activate(home, store)).code, 0);
  const activated = await activate(home, store);
  assert.equal(activated.code, 0, activated.stderr);
  assert.equal(JSON.parse(activated.stdout).state, 'active');
  const first = JSON.parse(activated.stdout).record;
  assert.deepEqual([first.capabilities.capture, first.history.length, first.capabilities.delivery.hooksInstalled, first.capabilities.delivery.runtime], [{ state: 'deactivated' }, 3, false, null]);
  const active = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.equal(active.code, 0);
  assert.ok(payloadOf(active).includes('queue broker choice'), active.stdout.slice(0, 300));
  const deactivated = await run(['deactivate', 'delivery'], { home });
  assert.equal(deactivated.code, 0, deactivated.stderr);
  assert.equal(JSON.parse(deactivated.stdout).state, 'deactivated');
  const after = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.deepEqual([after.code, after.stdout, after.stderr], [0, '', '']);
  const saved = JSON.parse(await readFile(record, 'utf8'));
  assert.equal(saved.capabilities.delivery.state, 'deactivated');
  assert.deepEqual(saved.history.map((entry) => [entry.capability, entry.state, entry.evidence ?? null]), [['capture', 'deactivated', null], ['delivery', 'active', 'receipt-test'], ['delivery', 'active', 'receipt-test'], ['delivery', 'deactivated', null]]);
  assert.equal(saved.history[1].store, realpathSync.native(store), 'the history keeps each activation\'s store');
  const pinned = JSON.parse(activated.stdout).record.capabilities.delivery;
  assert.deepEqual([pinned.store, pinned.surface, pinned.capBytes], [{ file: realpathSync.native(store), storage: 'json' }, 'cli', 8000]);
  assert.ok(pinned.deadlineMs < pinned.hookTimeoutSeconds * 1000);
});

test('activation needs evidence and an existing store, and writes nothing otherwise; a corrupt record leaves the hook inert', async (t) => {
  const { home, cwd, store, record } = await setup(t);
  for (const args of [['activate', 'delivery', '--store', store], ['activate', 'delivery', '--evidence', 'x'], ['activate', 'delivery', '--evidence', 'x', '--store', join(home, 'missing.json')], ['activate', 'capture', '--store', store], ['activate', 'delivery', '--evidence', 'x', '--store', store, '--unknown', 'y']]) {
    const result = await run([...args, '--host-version', VERIFIED], { home });
    assert.equal(result.code, 1, args.join(' '));
    assert.equal(existsSync(record), false, args.join(' '));
  }
  // A store that cannot be read as the kind declared is refused too.
  const unreadable = join(home, 'stores', 'unreadable.json');
  await writeFile(unreadable, '{not json');
  for (const args of [['--store', unreadable], ['--store', store, '--storage', 'sqlite']]) {
    const result = await run(['activate', 'delivery', '--evidence', 'x', '--host-version', VERIFIED, ...args], { home });
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /activation_store_unreadable/u);
  }
  await mkdir(join(home, 'sg-home'));
  await writeFile(record, '{ "capabilities": ');
  const corrupt = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.deepEqual([corrupt.code, corrupt.stdout, corrupt.stderr], [0, '', '']);
  // Deactivation still succeeds: the unreadable record is kept beside a new one that says delivery is off.
  const deactivated = await run(['deactivate', 'delivery'], { home });
  assert.equal(deactivated.code, 0, deactivated.stderr);
  const { keptAside } = JSON.parse(deactivated.stdout);
  assert.equal(await readFile(keptAside, 'utf8'), '{ "capabilities": ');
  assert.equal(JSON.parse(await readFile(record, 'utf8')).capabilities.delivery.state, 'deactivated');
  // A store inside a git working tree is accepted, with a warning for the owner.
  const repository = join(home, 'repository');
  await mkdir(repository);
  execFileSync('git', ['init', '-q'], { cwd: repository });
  await copyFile(store, join(repository, 'memory.json'));
  const warned = await run(['activate', 'delivery', '--evidence', 'x', '--host-version', VERIFIED, '--store', join(repository, 'memory.json')], { home });
  assert.equal(warned.code, 0, warned.stderr);
  assert.match(JSON.parse(warned.stdout).warning, /git working tree/u);
});

test('a pinned SQLite store another process holds is reported busy at once, and its lock is left as it was', async (t) => {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { return t.skip('node:sqlite unavailable'); }
  const { home, cwd } = await setup(t);
  const { createStorage } = await import('../src/storage.js');
  const database = join(home, 'stores', 'memory.db');
  const graph = createShadowGraph();
  graph.addDecision({ project: 'app', title: 'queue broker sqlite', chosen: 'kafka' });
  privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'app', reason: 'test' });
  const sqlite = await createStorage({ file: database, type: 'sqlite' });
  await sqlite.save(privilegedSnapshot(graph));
  sqlite.close?.();
  assert.ok(DatabaseSync);
  assert.equal((await run(['activate', 'delivery', '--evidence', 'receipt-test', '--store', database, '--storage', 'sqlite', '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')], { home })).code, 0);
  // Read without a lock, the store is delivered, and nothing (no runtime warning either) reaches stderr.
  const served = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.deepEqual([served.code, served.stderr], [0, '']);
  assert.ok(payloadOf(served).includes('queue broker sqlite'));
  const lock = `${database}.lock`;
  const token = JSON.stringify({ pid: process.pid, token: 'held-by-test', acquiredAt: new Date().toISOString() });
  await writeFile(lock, token);
  const busy = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.equal(busy.code, 0);
  assert.deepEqual([headOf(busy).store, headOf(busy).reason], ['unavailable', 'busy']);
  assert.ok(busy.ms < 5000, `${busy.ms} ms`);
  assert.equal(await readFile(lock, 'utf8'), token);
  // Held by another process, the store still counts as readable for activation.
  assert.equal((await run(['activate', 'delivery', '--evidence', 'receipt-test', '--store', database, '--storage', 'sqlite', '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')], { home })).code, 0);
  assert.equal(await readFile(lock, 'utf8'), token);
});

test('the hook reads the pinned store only: neither SHADOWGRAPH_FILE nor a store the workspace ships is read', async (t) => {
  const { home, cwd, store } = await setup(t);
  const other = join(home, 'stores', 'other.json');
  const graph = createShadowGraph();
  graph.addDecision({ project: 'app', title: 'queue broker planted', chosen: 'planted' });
  privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'app', reason: 'test' });
  await createJsonFileStore(other).save(privilegedSnapshot(graph));
  await createJsonFileStore(join(cwd, '.shadowgraph', 'data.json')).save(privilegedSnapshot(graph));
  assert.equal((await activate(home, store)).code, 0);
  for (const env of [{ SHADOWGRAPH_FILE: other }, {}]) {
    const result = await run(['deliver', '--hook'], { home, cwd, stdin: hook('UserPromptSubmit', 'queue broker'), env });
    assert.ok(payloadOf(result).includes('queue broker choice'), result.stdout.slice(0, 300));
    assert.ok(!payloadOf(result).includes('planted'));
  }
});

test('on the hook path a workspace binding the pinned store has not confirmed selects no project', async (t) => {
  const { home, cwd, store } = await setup(t, { storeBinding: false });
  assert.equal((await activate(home, store)).code, 0);
  const session = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.equal(headOf(session).limitation.code, 'project_unresolved');
  assert.ok(!payloadOf(session).includes('queue broker choice'));
  const prompt = await run(['deliver', '--hook'], { home, cwd, stdin: hook('UserPromptSubmit', 'queue broker') });
  assert.deepEqual([prompt.code, prompt.stdout], [0, '']);
});

test('a host version other than the verified one is recorded, and delivered, as unverified', async (t) => {
  const { home, cwd, store, record } = await setup(t);
  assert.equal((await activate(home, store, '9.9.9')).code, 0);
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')).capabilities.delivery.host, { name: 'claude-code', version: '9.9.9', verifiedVersion: VERIFIED, verified: false });
  const unverified = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.deepEqual(headOf(unverified).host, { name: 'claude-code', version: '9.9.9', verifiedVersion: VERIFIED, verified: false });
  assert.equal((await activate(home, store)).code, 0);
  const verified = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.equal(headOf(verified).host.verified, true);
});

test('past its deadline the hook exits 0 having printed nothing, and the store is unchanged', async (t) => {
  const { home, cwd, store } = await setup(t);
  assert.equal((await activate(home, store)).code, 0);
  const bytes = await readFile(store);
  const late = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart'), env: { SHADOWGRAPH_DELIVERY_DEADLINE_MS: '1' } });
  assert.deepEqual([late.code, late.stdout, late.stderr], [0, '', '']);
  assert.ok(late.ms < 5000, `${late.ms} ms`);
  assert.deepEqual(await readFile(store), bytes);
  // The variable only shortens the deadline.
  const lengthened = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart'), env: { SHADOWGRAPH_DELIVERY_DEADLINE_MS: '99999999' } });
  assert.ok(payloadOf(lengthened).includes('queue broker choice'));
});

test('the deadline can only be shortened, and a delivery past it writes nothing', async (t) => {
  assert.equal(deliveryDeadlineMs({ SHADOWGRAPH_DELIVERY_DEADLINE_MS: '99999999' }), DELIVERY_DEADLINE_MS);
  assert.equal(deliveryDeadlineMs({ SHADOWGRAPH_DELIVERY_DEADLINE_MS: '250' }), 250);
  for (const value of ['', '0', '-5', 'soon']) assert.equal(deliveryDeadlineMs({ SHADOWGRAPH_DELIVERY_DEADLINE_MS: value }), DELIVERY_DEADLINE_MS, value);
  const { home, cwd, store } = await setup(t);
  assert.equal((await activate(home, store)).code, 0);
  const written = [];
  const previous = process.cwd();
  process.chdir(cwd);
  try {
    const env = { ...process.env, SHADOWGRAPH_HOME: join(home, 'sg-home') };
    await runDeliver({ args: ['--hook'], readInput: () => hook('SessionStart'), env, deadline: Date.now() - 1, write: (text) => written.push(text) });
    assert.deepEqual(written, []);
    await runDeliver({ args: ['--hook'], readInput: () => hook('SessionStart'), env, write: (text) => written.push(text) });
    assert.equal(written.length, 1);
  } finally {
    process.chdir(previous);
  }
});

test('deactivating with nothing active writes nothing', async (t) => {
  const { home, record } = await setup(t);
  const result = await run(['deactivate', 'delivery'], { home });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual([JSON.parse(result.stdout).changed, existsSync(record)], [false, false]);
});

test('the deadline holds while the work is still running: a delivery that needs longer gives nothing, on time', async (t) => {
  const { home, cwd } = await setup(t);
  // One record of 30 MB: reading, ranking and redacting it takes seconds, all of it synchronous work.
  const graph = createShadowGraph();
  graph.addDecision({ project: 'app', title: 'queue broker huge', chosen: 'kafka', goal: 'word '.repeat(6_000_000) });
  privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'app', reason: 'test' });
  const large = join(home, 'stores', 'large.json');
  await createJsonFileStore(large).save(privilegedSnapshot(graph));
  assert.equal((await activate(home, large)).code, 0);
  // The whole work, timed in this process with no deadline, is longer than the deadline given below.
  const env = { ...process.env, SHADOWGRAPH_HOME: join(home, 'sg-home') };
  const written = [];
  const previous = process.cwd();
  process.chdir(cwd);
  const started = Date.now();
  try {
    await runDeliver({ args: ['--hook'], readInput: () => hook('SessionStart'), env, write: (text) => written.push(text) });
  } finally {
    process.chdir(previous);
  }
  const whole = Date.now() - started;
  assert.equal(written.length, 1, 'the whole work ends in a line');
  assert.ok(whole > 400, `${whole} ms`);
  const short = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart'), env: { SHADOWGRAPH_DELIVERY_DEADLINE_MS: '400' } });
  assert.deepEqual([short.code, short.stdout, short.stderr], [0, '', '']);
  // Stopped before the work could have finished, whatever the machine's speed.
  assert.ok(short.ms < Math.min(whole, 400 + 1500), `${short.ms} ms against ${whole} ms for the whole work`);
  // A worker that fails outright -- here out of memory -- leaves the hook silent too, with nothing on stderr.
  const starved = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart'), env: { NODE_OPTIONS: '--max-old-space-size=40' } });
  assert.deepEqual([starved.code, starved.stdout, starved.stderr], [0, '', '']);
});

test('activation outside a scratch location asks the owner at a terminal; deactivation never asks', async (t) => {
  const { home, store } = await setup(t);
  const temporary = join(home, 'temporary');
  await mkdir(temporary);
  const moved = { TMP: temporary, TEMP: temporary, TMPDIR: temporary };
  const refused = await run(['activate', 'delivery', '--evidence', 'x', '--store', store, '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')], { home, env: moved });
  assert.equal(refused.code, 1);
  assert.match(refused.stderr, /activation_requires_owner_confirmation/u);
  assert.equal(existsSync(join(home, 'sg-home', 'activation.json')), false);
  assert.equal((await activate(home, store)).code, 0);
  const deactivated = await run(['deactivate', 'delivery'], { home, env: moved });
  assert.equal(deactivated.code, 0, deactivated.stderr);
});

test('check-integrations refuses a coverage manifest without its host version, same-turn gap, stages or an uncovered trigger, and a deadline at the hook timeout', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-activation-');
  await cp('scripts/check-integrations.mjs', join(root, 'scripts', 'check-integrations.mjs'));
  await cp('integrations', join(root, 'integrations'), { recursive: true });
  await cp('src', join(root, 'src'), { recursive: true });
  await cp('package.json', join(root, 'package.json'));
  const check = () => new Promise((settle) => spawn(process.execPath, [join(root, 'scripts', 'check-integrations.mjs')], { stdio: 'ignore' }).on('close', settle));
  assert.equal(await check(), 0, 'the shipped manifest passes');
  const manifest = JSON.parse(readFileSync('integrations/claude-code.coverage.json', 'utf8'));
  const without = (key) => { const copy = structuredClone(manifest); delete copy[key]; return copy; };
  const variants = [
    without('verifiedVersion'), without('sameTurnGap'), { ...manifest, host: 'other-host' },
    { ...manifest, triggers: manifest.triggers.filter((row) => row.status !== 'uncovered') },
    { ...manifest, triggers: manifest.triggers.map((row) => (row.trigger === 'UserPromptSubmit' ? { ...row, status: 'unverified' } : row)) },
    { ...manifest, triggers: manifest.triggers.map((row, index) => (index === 0 ? { ...row, stages: { ...row.stages, replayProtection: undefined } } : row)) },
    { ...manifest, stages: manifest.stages.slice(1) },
    { ...manifest, triggers: manifest.triggers.map((row, index) => (index === 0 ? { ...row, stages: { ...row.stages, replayProtection: ' ' } } : row)) },
    { ...manifest, triggers: manifest.triggers.map((row, index) => (index === 1 ? { ...row, status: 'partly' } : row)) }
  ];
  for (const variant of variants) {
    await writeFile(join(root, 'integrations', 'claude-code.coverage.json'), JSON.stringify(variant));
    assert.notEqual(await check(), 0, JSON.stringify(variant).slice(0, 120));
  }
  await writeFile(join(root, 'integrations', 'claude-code.coverage.json'), JSON.stringify(manifest));
  const delivery = join(root, 'src', 'delivery.js');
  await writeFile(delivery, (await readFile(delivery, 'utf8')).replace(/export const DELIVERY_DEADLINE_MS = \d+;/u, 'export const DELIVERY_DEADLINE_MS = 10000;'));
  assert.notEqual(await check(), 0, 'a deadline at the hook timeout is refused');
});

test('a workspace bound to one project in its file and to another in the store selects neither', async (t) => {
  const { home, cwd } = await setup(t, { storeBinding: false });
  const graph = createShadowGraph();
  graph.addDecision({ project: 'app', title: 'queue broker choice', chosen: 'kafka' });
  graph.addDecision({ project: 'other', title: 'queue broker elsewhere', chosen: 'sqs' });
  privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'other', reason: 'test' });
  const store = join(home, 'stores', 'other-binding.json');
  await createJsonFileStore(store).save(privilegedSnapshot(graph));
  assert.equal((await activate(home, store)).code, 0);
  const session = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
  assert.equal(headOf(session).limitation.code, 'project_unresolved');
  assert.ok(!payloadOf(session).includes('queue broker'));
});

test('without --host-version, a host that cannot be found is recorded as unknown, and so unverified', async (t) => {
  const { home, store, record } = await setup(t);
  const empty = join(home, 'empty-path');
  await mkdir(empty);
  const result = await run(['activate', 'delivery', '--evidence', 'receipt-test', '--store', store, '--settings', join(home, 'settings-fixture.json')], { home, env: { PATH: empty, Path: empty } });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(await readFile(record, 'utf8')).capabilities.delivery.host, { name: 'claude-code', version: 'unknown', verifiedVersion: VERIFIED, verified: false });
});

test('on the hook path only a worktree binding counts: a .git file naming another repository selects nothing', async (t) => {
  const { home, store } = await setup(t, { storeBinding: false });
  const victim = join(home, 'victim');
  await mkdir(victim);
  execFileSync('git', ['init', '-q'], { cwd: victim });
  const { discoverWorkspace } = await import('../src/internal/access-transport.js');
  const owned = await discoverWorkspace(victim);
  // The owner's repository is bound as a shared repository, in the store and in its common directory.
  const graph = createShadowGraph();
  graph.addDecision({ project: 'app', title: 'queue broker shared secret', chosen: 'kafka' });
  privilegedBindProject(graph, { type: 'shared_repository', path: owned.commonDir, project: 'app', reason: 'test' });
  const shared = join(home, 'stores', 'shared.json');
  await createJsonFileStore(shared).save(privilegedSnapshot(graph));
  await writeFile(join(owned.commonDir, 'shadowgraph-project-binding.json'), JSON.stringify({ version: 1, type: 'shared_repository', path: owned.commonDir, project: 'app', confirmed: true }));
  assert.equal((await activate(home, shared)).code, 0);
  // A directory that ships only a .git file pointing at it, as an archive could.
  const planted = join(home, 'planted');
  await mkdir(planted);
  await writeFile(join(planted, '.git'), `gitdir: ${join(victim, '.git')}\n`);
  for (const cwd of [planted, victim]) {
    const session = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') });
    assert.equal(headOf(session).limitation.code, 'project_unresolved', cwd);
    assert.ok(!payloadOf(session).includes('shared secret'), cwd);
  }
});

test('on the hook path a work tree git places elsewhere selects nothing, nor does a shared-repository binding the store confirms as a worktree', async (t) => {
  const { home } = await setup(t, { storeBinding: false });
  const victim = join(home, 'victim');
  await mkdir(join(victim, 'sub'), { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: victim });
  const { discoverWorkspace } = await import('../src/internal/access-transport.js');
  const { worktreeRoot, commonDir } = await discoverWorkspace(victim);
  const graph = createShadowGraph();
  graph.addDecision({ project: 'app', title: 'queue broker worktree secret', chosen: 'kafka' });
  privilegedBindProject(graph, { type: 'worktree', path: worktreeRoot, project: 'app', reason: 'test' });
  const bound = join(home, 'stores', 'bound.json');
  await createJsonFileStore(bound).save(privilegedSnapshot(graph));
  assert.equal((await activate(home, bound)).code, 0);
  const selects = async (cwd) => payloadOf(await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') })).includes('worktree secret');
  // Only a shared-repository file binding: the store's worktree binding does not make it count.
  await writeFile(join(commonDir, 'shadowgraph-project-binding.json'), JSON.stringify({ version: 1, type: 'shared_repository', path: commonDir, project: 'app', confirmed: true }));
  assert.equal(await selects(victim), false);
  await mkdir(join(worktreeRoot, '.shadowgraph'));
  await writeFile(join(worktreeRoot, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: worktreeRoot, project: 'app', confirmed: true }));
  // A directory that ships only a .git whose configuration places its work tree at the owner's, as an archive could.
  const planted = join(home, 'planted');
  await mkdir(planted);
  execFileSync('git', ['init', '-q'], { cwd: planted });
  execFileSync('git', ['config', 'core.worktree', worktreeRoot], { cwd: planted });
  assert.equal(resolve(execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: planted, encoding: 'utf8' }).trim()), worktreeRoot, 'git names the owner\'s work tree');
  assert.equal(await selects(planted), false);
  assert.equal(await selects(victim), true);
  assert.equal(await selects(join(victim, 'sub')), true);
});

test('on the hook path a work tree whose name only extends the owner\'s -- a newline and more, trailing whitespace -- is not taken for it', async (t) => {
  const { home } = await setup(t, { storeBinding: false });
  const owner = join(home, 'app');
  // A newline, a space or a tab cannot end a Windows name; a no-break or ideographic space can, on every platform.
  const suffixes = process.platform === 'win32' ? [' ', '　'] : ['\nX', ' ', '\t', ' ', '　'];
  const siblings = suffixes.map((suffix) => join(home, `app${suffix}`));
  for (const directory of [owner, ...siblings]) {
    await mkdir(directory);
    execFileSync('git', ['init', '-q'], { cwd: directory });
  }
  const { discoverWorkspace } = await import('../src/internal/access-transport.js');
  const { worktreeRoot } = await discoverWorkspace(owner);
  for (const sibling of siblings) assert.equal(basename((await discoverWorkspace(sibling)).worktreeRoot), basename(sibling), JSON.stringify(sibling));
  const graph = createShadowGraph();
  graph.addDecision({ project: 'app', title: 'queue broker newline secret', chosen: 'kafka' });
  privilegedBindProject(graph, { type: 'worktree', path: worktreeRoot, project: 'app', reason: 'test' });
  const bound = join(home, 'stores', 'bound.json');
  await createJsonFileStore(bound).save(privilegedSnapshot(graph));
  await mkdir(join(worktreeRoot, '.shadowgraph'));
  await writeFile(join(worktreeRoot, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: worktreeRoot, project: 'app', confirmed: true }));
  assert.equal((await activate(home, bound)).code, 0);
  const selects = async (cwd) => payloadOf(await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') })).includes('newline secret');
  for (const sibling of siblings) assert.equal(await selects(sibling), false, JSON.stringify(sibling));
  assert.equal(await selects(owner), true);
});

test('the hook\'s output is the worker\'s one line: what the worker writes itself is dropped, and it is stopped once the line is out', async (t) => {
  const { home, cwd, store } = await setup(t);
  assert.equal((await activate(home, store)).code, 0);
  const marker = join(home, 'worker-outlived-its-line');
  const preload = join(home, 'worker-preload.mjs');
  await writeFile(preload, [
    "import { isMainThread, parentPort } from 'node:worker_threads';",
    "import { writeFileSync } from 'node:fs';",
    'if (!isMainThread) {',
    "  process.stdout.write('stray worker output\\n');",
    "  process.stderr.write('stray worker error\\n');",
    '  const post = parentPort.postMessage.bind(parentPort);',
    `  parentPort.postMessage = (value) => { post(value); setTimeout(() => writeFileSync(${JSON.stringify(marker)}, 'x'), 1500); };`,
    '}',
    ''
  ].join('\n'));
  const result = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart'), env: { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
  assert.equal(result.code, 0);
  assert.equal(result.stderr, '');
  assert.ok(!result.stdout.includes('stray worker'), result.stdout);
  assert.ok(payloadOf(result).includes('queue broker choice'));
  assert.equal(existsSync(marker), false, 'the worker was stopped once its line was written');
});

test('deactivation keeps a record it cannot read for a reason other than its content, and fails', { skip: process.platform !== 'win32' }, async (t) => {
  const { home, store, record } = await setup(t);
  assert.equal((await activate(home, store)).code, 0);
  const before = await readFile(record, 'utf8');
  // Another process holds the record open, letting others rename it but not read it.
  const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$f = [IO.File]::Open('${record}', 'Open', 'Read', 'Delete'); [Console]::Out.WriteLine('held'); [void][Console]::In.ReadLine(); $f.Close()`], { stdio: ['pipe', 'pipe', 'ignore'] });
  await once(holder.stdout, 'data');
  const result = await run(['deactivate', 'delivery'], { home });
  holder.stdin.end('\n');
  await once(holder, 'close');
  assert.equal(result.code, 1);
  assert.equal(await readFile(record, 'utf8'), before);
  assert.deepEqual((await readdir(dirname(record))).filter((name) => name.includes('unreadable')), []);
});

test('on Windows the hook never runs a program the workspace holds in place of git', { skip: process.platform !== 'win32' }, async (t) => {
  const { home, cwd, store } = await setup(t);
  assert.equal((await activate(home, store)).code, 0);
  await copyFile(process.execPath, join(cwd, 'git.exe'));
  await writeFile(join(cwd, 'rev-parse'), "require('fs').writeFileSync(require('path').join(__dirname, 'planted-git-ran'), 'x');\n");
  // The variable removed however it is spelled, as a host that does not set it would leave it (an empty value still sets it).
  const unset = Object.fromEntries(Object.keys(process.env).filter((key) => key.toLowerCase() === 'nodefaultcurrentdirectoryinexepath').map((key) => [key, undefined]));
  const result = await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart'), env: unset });
  assert.equal(result.code, 0);
  assert.equal(existsSync(join(cwd, 'planted-git-ran')), false);
  assert.ok(payloadOf(result).includes('queue broker choice'), 'delivery still ran, with the real git');
});

test('owner confirmation cannot be skipped by moving the temporary directory over the home, or for a .shadowgraph directory', async (t) => {
  const { home, store } = await setup(t);
  const real = userInfo().homedir;
  for (const env of [{ TMP: real, TEMP: real, TMPDIR: real }, { SHADOWGRAPH_HOME: join(home, '.shadowgraph') }]) {
    const refused = await run(['activate', 'delivery', '--evidence', 'x', '--store', store, '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')], { home, env });
    assert.equal(refused.code, 1, JSON.stringify(env));
    assert.match(refused.stderr, /activation_requires_owner_confirmation/u);
  }
  assert.equal(existsSync(join(home, 'sg-home', 'activation.json')) || existsSync(join(home, '.shadowgraph', 'activation.json')), false);
});

test('activation refuses evidence that holds a credential, a malformed host version, and a record changed while the owner decides', async (t) => {
  const { home, store, record } = await setup(t);
  for (const [flag, value] of [['--evidence', `https://example.com/receipt?token=${'abcdef'.repeat(4)}`], ['--evidence', `gh${'p_'}${'a'.repeat(36)}`], ['--host-version', 'latest']]) {
    const args = ['activate', 'delivery', '--evidence', 'receipt-test', '--store', store, '--host-version', VERIFIED, '--settings', join(home, 'settings-fixture.json')];
    args[args.indexOf(flag) + 1] = value;
    const refused = await run(args, { home });
    assert.equal(refused.code, 1, value);
    assert.ok(!refused.stdout.includes(value) && !refused.stderr.includes(value) && existsSync(record) === false, value);
  }
  const { activateDelivery } = await import('../src/activation.js');
  const env = { ...process.env, SHADOWGRAPH_HOME: join(home, 'sg-home') };
  await mkdir(join(home, 'sg-home'), { recursive: true });
  await assert.rejects(activateDelivery({ env, evidence: 'receipt-test', store, hostVersion: VERIFIED, settings: join(home, 'settings-fixture.json'), afterConfirmation: () => writeFile(record, '{"history":[]}') }), /activation_record_changed_while_confirming/u);
  assert.equal(await readFile(record, 'utf8'), '{"history":[]}');
});

test('the latency measurement times the hook against a matched no-op and counts only payloads holding a record', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-latency-');
  const result = await new Promise((settle) => {
    const child = spawn(process.execPath, [resolve('scripts/context-size.mjs'), '--deliver', '--runs', '1'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: join(home, 'sg-home') } });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.on('close', (code) => settle({ code, stdout }));
  });
  assert.equal(result.code, 0);
  const report = JSON.parse(result.stdout);
  for (const key of ['noop', 'sessionStart', 'userPromptSubmit']) assert.ok(Number.isFinite(report[key].p50) && report[key].p50 > 0, key);
  assert.equal(report.delivered, '2 of 2');
  // A head with no record in it is not counted as delivered.
  const { holdsRecord } = await import('../scripts/context-size.mjs');
  const bound = await setup(t);
  const unbound = await setup(t, { storeBinding: false });
  for (const { home: at, store } of [bound, unbound]) assert.equal((await activate(at, store)).code, 0);
  const withRecord = await run(['deliver', '--hook'], { home: bound.home, cwd: bound.cwd, stdin: hook('SessionStart') });
  const headOnly = await run(['deliver', '--hook'], { home: unbound.home, cwd: unbound.cwd, stdin: hook('SessionStart') });
  assert.ok(headOnly.stdout.length > 0, 'the unbound session start still has a head');
  assert.deepEqual([holdsRecord(''), holdsRecord(headOnly.stdout), holdsRecord(withRecord.stdout)], [false, false, true]);
});

test('lifecycle: install the hooks, activate, deliver, deactivate, uninstall -- the settings come back as they were', async (t) => {
  const { home, cwd, store, record } = await setup(t);
  const settings = join(home, 'settings-fixture.json');
  const original = `${JSON.stringify({ model: 'opus' }, null, 2)}\n`;
  await writeFile(settings, original);
  assert.equal((await run(['install-hooks', '--settings', settings], { home })).code, 0);
  const activated = await activate(home, store);
  assert.equal(JSON.parse(activated.stdout).record.capabilities.delivery.hooksInstalled, true);
  assert.ok(payloadOf(await run(['deliver', '--hook'], { home, cwd, stdin: hook('SessionStart') })).includes('queue broker choice'));
  assert.equal((await run(['deactivate', 'delivery'], { home })).code, 0);
  assert.equal((await run(['uninstall-hooks', '--settings', settings], { home })).code, 0);
  assert.equal(await readFile(settings, 'utf8'), original);
  assert.equal(JSON.parse(await readFile(record, 'utf8')).capabilities.delivery.state, 'deactivated');
});
