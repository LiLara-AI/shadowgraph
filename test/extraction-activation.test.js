import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { FROZEN_WORKER_BUDGETS } from '../src/internal/extraction-budget.js';
import { createDestinationFence, fenceLockPath } from '../src/revision-store.js';
const state = () => import('../src/internal/extraction-state.js');
const activation = () => import('../src/activation.js');
async function setup(t) {
  const root = await scratchDirectory(t), env = { SHADOWGRAPH_HOME: root };
  const runtime = { path: join(root, 'shadowgraph-runtime'), commit: 'a'.repeat(40), extraction: true };
  const store = { file: join(root, 'memory.json'), storage: 'json' };
  const extraction = { state: 'active', activationId: randomUUID(), changedAt: new Date().toISOString(), store, runtime,
    noOverageConfirmed: true, budgets: { ...FROZEN_WORKER_BUDGETS }, model: 'claude-opus-5[1m]',
    executor: { ok: true, executable: join(root, 'claude.exe'), binarySha256: 'b'.repeat(64), hostVersion: '2.1.288', model: 'claude-opus-5[1m]', restrictions: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`E-${i + 1}`, true])) } };
  const record = { version: 1, capabilities: { extraction, capture: { state: 'active', store, runtime } }, history: [] };
  const file = join(root, 'activation.json'); const save = () => writeFile(file, JSON.stringify(record)); await save();
  return { root, env, extraction, record, file, save };
}
test('extraction activation reader requires frozen budgets, exact shared runtime/store, confirmation and executor receipt', async t => {
  const f = await setup(t), { activeExtraction } = await state();
  assert.deepEqual(await activeExtraction(f.env), f.extraction);
  for (const change of [e => { e.noOverageConfirmed = false; }, e => { e.activationId = ''; }, e => { e.budgets.calls++; }, e => { e.executor.restrictions['E-7'] = false; }, e => { e.executor.executable = 'claude'; }, e => { e.runtime.extraction = false; }, e => { e.model = 'another'; }]) {
    const copy = structuredClone(f.record); change(copy.capabilities.extraction); await writeFile(f.file, JSON.stringify(copy));
    assert.equal(await activeExtraction(f.env), null);
  }
  for (const field of ['runtime', 'store']) {
    const copy = structuredClone(f.record); copy.capabilities.capture[field] = field === 'runtime' ? { ...f.extraction.runtime, commit: 'c'.repeat(40) } : { ...f.extraction.store, file: join(f.root, 'other') };
    await writeFile(f.file, JSON.stringify(copy)); assert.equal(await activeExtraction(f.env), null);
  }
  await writeFile(f.file, '{broken'); assert.equal(await activeExtraction(f.env), null);
});
test('extraction deactivation persists inert state before waiting and reports a still-running worker as deferred', async t => {
  const f = await setup(t), { workerFenceFile, activeExtraction } = await state();
  const { deactivateExtraction } = await activation(); let release, ready;
  const entered = new Promise(r => { ready = r; });
  const worker = createDestinationFence(workerFenceFile(f.env)).run(() => new Promise(r => { release = r; ready(); }));
  await entered;
  try {
    const out = await deactivateExtraction({ env: f.env, cleanupTimeoutMs: 25 });
    assert.equal(out.state, 'deactivated'); assert.equal(out.cleanup.status, 'deferred');
    assert.equal(await activeExtraction(f.env), null);
    assert.equal(JSON.parse(await readFile(f.file)).capabilities.extraction.state, 'deactivated');
  } finally { release(); await worker; }
  const again = await deactivateExtraction({ env: f.env });
  assert.equal(again.cleanup.status, 'complete'); assert.equal(again.changed, false);
  assert.equal(JSON.parse(await readFile(f.file)).history.length, 1);
});
test('extraction deactivation does not open or repair an unreadable/pending store', async t => {
  const f = await setup(t), { deactivateExtraction } = await activation();
  await writeFile(f.extraction.store.file, '{broken');
  await writeFile(`${f.extraction.store.file}.control.json`, '{pending-restore');
  const result = await deactivateExtraction({ env: f.env });
  assert.equal(result.cleanup.status, 'complete');
  assert.equal(await readFile(f.extraction.store.file, 'utf8'), '{broken');
  assert.equal(await readFile(`${f.extraction.store.file}.control.json`, 'utf8'), '{pending-restore');
});

import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { CAPTURE_LIMITS } from '../src/capture-hook.js';
import { pinnedRuntime } from '../src/host-hooks.js';
import { initializeUsage, usageFile, withWorkerBudget } from '../src/internal/extraction-budget.js';
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

async function writable(t) {
  const f = await setup(t);
  const runtime = await syntheticRuntime(f.extraction.runtime.path, {
    'src/cli.js': '// fixture', 'src/internal/capture-retention.js': '// fixture',
    'src/capture-lifecycle-capability.json': '{"version":1}',
    'src/extraction-capability.json': '{"version":1,"workerFloor":"PR40","activationFloor":"PR41"}',
    'integrations/claude-code.capture-hooks.json': '{}'
  });
  const pinned = await pinnedRuntime(runtime);
  f.record.capabilities.capture = { ...f.record.capabilities.capture, runtime: pinned, originId: 'origin_fixture', coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS } };
  f.record.capabilities.extraction.state = 'deactivated'; await f.save();
  const store = await createStorage({ type: 'json', file: f.extraction.store.file });
  await store.save(privilegedSnapshot(createShadowGraph())); store.close();
  return { ...f, options: { env: f.env, evidence: 'synthetic-AG3', store: f.extraction.store.file, runtime,
    settings: join(f.root, 'host-config.json'), executable: f.extraction.executor.executable, noOverageConfirmed: true,
    executorCheck: async () => f.extraction.executor } };
}
test('extraction activation records a resolved gate and never refunds usage on reactivation', async t => {
  const f = await writable(t), { activateExtraction } = await activation(), { activeExtraction } = await state();
  const result = await activateExtraction(f.options);
  assert.equal(result.state, 'active'); assert.equal(result.record.capabilities.extraction.noOverageConfirmed, true);
  assert.deepEqual(result.record.capabilities.extraction.budgets, FROZEN_WORKER_BUDGETS);
  assert.equal((await activeExtraction(f.env)).activationId, result.record.capabilities.extraction.activationId);
  await withWorkerBudget({ env: f.env }, b => b.reserve()); const before = await readFile(usageFile(f.env));
  const next = await activateExtraction(f.options);
  assert.notEqual(next.record.capabilities.extraction.activationId, result.record.capabilities.extraction.activationId);
  assert.deepEqual(await readFile(usageFile(f.env)), before);
  assert.equal(next.record.history.length, 2);
});
test('extraction activation refuses missing confirmation, unresolved restrictions and old runtime before writing', async t => {
  const f = await writable(t), { activateExtraction } = await activation(); const before = await readFile(f.file);
  for (const patch of [{ noOverageConfirmed: false }, { noOverageConfirmed: undefined }, { executable: 'claude' }, { executorCheck: async () => ({ ok: false }) }]) {
    await assert.rejects(activateExtraction({ ...f.options, ...patch })); assert.deepEqual(await readFile(f.file), before);
  }
  const old = await syntheticRuntime(join(f.root, 'shadowgraph-old'), { 'src/cli.js': '// old' });
  await assert.rejects(activateExtraction({ ...f.options, runtime: old }), /cannot_extract/);
  assert.deepEqual(await readFile(f.file), before);
  await assert.rejects(readFile(usageFile(f.env)), { code: 'ENOENT' });
});
test('extraction activation refuses concurrent record changes and malformed usage rather than resetting either', async t => {
  const f = await writable(t), { activateExtraction } = await activation();
  await assert.rejects(activateExtraction({ ...f.options, afterConfirmation: () => writeFile(f.file, '{changed') }), /changed_while_confirming/);
  assert.equal(await readFile(f.file, 'utf8'), '{changed');
  await f.save(); await writeFile(usageFile(f.env), '{}'); const before = await readFile(f.file);
  await assert.rejects(activateExtraction(f.options), /worker_usage_unavailable/);
  assert.deepEqual(await readFile(f.file), before); assert.equal(await readFile(usageFile(f.env), 'utf8'), '{}');
});

import { privilegedRecordCapture } from '../src/internal/snapshot.js';
async function activated(t) {
  const f = await writable(t), { activateExtraction } = await activation(); await activateExtraction(f.options);
  const store = await createStorage({ type: 'json', file: f.extraction.store.file });
  const graph = createShadowGraph(); graph.importData(await store.load());
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'origin_fixture', text: 'Synthetic pending work.', source: { event: 'UserPromptSubmit', sessionId: 's' }, admission: { limits: CAPTURE_LIMITS, storeBytes: 0 } });
  await store.save(privilegedSnapshot(graph)); store.close();
  const read = async () => { const s = await createStorage({ type: 'json', file: f.extraction.store.file }); try { return await s.load(); } finally { s.close(); } };
  return { ...f, item, read };
}
test('activated worker is inert without activation and refuses a different running runtime before any executor', async t => {
  const f = await writable(t), { runActivatedExtraction } = await import('../src/extraction-runtime.js'); let calls = 0;
  const options = { env: f.env, project: 'p', executorFactory: () => { calls++; throw new Error('must not enter'); } };
  assert.equal((await runActivatedExtraction(options)).status, 'inactive');
  await (await activation()).activateExtraction(f.options);
  assert.equal((await runActivatedExtraction(options)).blockedReason, 'runtime_mismatch'); assert.equal(calls, 0);
});
test('deactivation interrupts a model call, retains pending work and waits for local child settlement', async t => {
  const f = await activated(t), { runActivatedExtraction } = await import('../src/extraction-runtime.js');
  let entered, stopped = false; const ready = new Promise(r => { entered = r; });
  const controller = new AbortController(); t.after(() => controller.abort());
  const worker = runActivatedExtraction({ env: f.env, project: 'p', runtimeDirectory: f.options.runtime, signal: controller.signal,
    executorFactory: () => ({ extract: async ({ signal }) => {
      // The store can be opened independently: no worker store is held across invocation.
      assert.equal((await f.read()).records.find(x => x.id === f.item.id).state, 'processing'); entered();
      await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }); });
      await new Promise(resolve => setTimeout(resolve, 50)); stopped = true;
      return { status: 'success', value: { records: [] }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } };
    } }) });
  await ready;
  const result = await (await activation()).deactivateExtraction({ env: f.env });
  assert.equal(result.cleanup.status, 'complete'); assert.equal(stopped, true);
  assert.equal((await worker).status, 'blocked');
  const item = (await f.read()).records.find(x => x.id === f.item.id);
  assert.equal(item.state, 'pending'); assert.equal(item.receipts.length, 0); assert.equal(item.lease, null);
});
test('automatic extraction follows capture coverage; explicit manual project does not consume other projects', async t => {
  const f = await activated(t), { runActivatedExtraction } = await import('../src/extraction-runtime.js'); let calls = 0;
  const data = JSON.parse(await readFile(f.file)); data.capabilities.capture.coverage = { projects: 'only', include: ['other'] }; await writeFile(f.file, JSON.stringify(data));
  const options = { env: f.env, runtimeDirectory: f.options.runtime, executorFactory: () => ({ extract: async () => { calls++; return { status: 'success', value: { records: [] }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } }; } }) };
  assert.equal((await runActivatedExtraction({ ...options, automatic: true })).status, 'idle'); assert.equal(calls, 0);
  assert.equal((await runActivatedExtraction({ ...options, project: 'other' })).status, 'idle'); assert.equal(calls, 0);
  assert.equal((await runActivatedExtraction({ ...options, project: 'p' })).completed, 1); assert.equal(calls, 1);
});

import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { changeHookSettings } from '../src/host-hooks.js';
test('trigger only requests detached one-shot extraction after eligible capture; self traffic cannot recurse', async t => {
  const f = await activated(t), { triggerExtraction } = await import('../src/internal/extraction-trigger.js');
  const calls = []; let unrefs = 0;
  const options = { env: f.env, runtimeDirectory: f.options.runtime, deadline: Date.now() + 5000, spawnProcess: (...args) => {
    calls.push(args); const child = new EventEmitter(); child.unref = () => { unrefs++; }; return child;
  } };
  for (const event of ['Stop', 'SessionEnd']) assert.equal((await triggerExtraction({ ...options, event, outcome: 'written' })).status, 'requested');
  assert.equal(calls.length, 2); assert.equal(unrefs, 2);
  for (const [executable, args, spawnOptions] of calls) {
    assert.equal(executable, process.execPath); assert.deepEqual(args.slice(1), ['extract', '--automatic']);
    assert.equal(spawnOptions.detached, true); assert.equal(spawnOptions.windowsHide, true); assert.equal(spawnOptions.shell, false); assert.equal(spawnOptions.stdio, 'ignore');
    assert.equal(spawnOptions.env.SHADOWGRAPH_HOME, f.env.SHADOWGRAPH_HOME);
  }
  for (const patch of [{ event: 'UserPromptSubmit' }, { outcome: 'self_event' }, { outcome: 'out_of_time' }, { deadline: 0 }, { runtimeDirectory: f.root }]) {
    assert.equal((await triggerExtraction({ ...options, event: 'Stop', outcome: 'written', ...patch })).status, 'inert');
  }
  await (await activation()).deactivateExtraction({ env: f.env });
  assert.equal((await triggerExtraction({ ...options, event: 'Stop', outcome: 'written' })).status, 'inert'); assert.equal(calls.length, 2);
});
test('uninstall disables extraction even when no hooks remain', async t => {
  const f = await activated(t); const settings = join(f.root, 'host-config.json'); await writeFile(settings, '{"model":"owner-choice"}');
  const result = await changeHookSettings(settings, 'uninstall', { env: f.env });
  assert.equal(result.removed, 0); assert.equal(result.extraction.state, 'deactivated');
  assert.equal(await (await state()).activeExtraction(f.env), null); assert.equal(await readFile(settings, 'utf8'), '{"model":"owner-choice"}');
});
test('extract CLI dispatch is inert without activation and never opens its manual store override', async t => {
  const root = await scratchDirectory(t), manual = join(root, 'manual.json'); await writeFile(manual, 'manual-canary');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'extract'], {
    cwd: root, env: { ...process.env, SHADOWGRAPH_HOME: root, SHADOWGRAPH_FILE: manual }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
  const code = await new Promise(resolve => child.once('close', resolve));
  assert.equal(code, 0, stderr); assert.equal(JSON.parse(stdout).status, 'inactive'); assert.equal(await readFile(manual, 'utf8'), 'manual-canary');
});

test('unconfirmed executor settlement remains deferred after the lifetime lock is released', async t => {
  const f = await activated(t), { runActivatedExtraction } = await import('../src/extraction-runtime.js');
  let enter, release; const ready = new Promise(r => { enter = r; });
  const worker = runActivatedExtraction({ env: f.env, project: 'p', runtimeDirectory: f.options.runtime,
    executorFactory: () => ({ extract: () => new Promise(r => { release = r; enter(); }) }) });
  await ready;
  const result = await (await activation()).deactivateExtraction({ env: f.env, cleanupTimeoutMs: 3000 });
  assert.equal((await worker).cleanup.status, 'deferred');
  assert.equal(result.cleanup.status, 'deferred');
  assert.equal((await (await activation()).deactivateExtraction({ env: f.env })).cleanup.status, 'deferred');
  release({ status: 'blocked' });
});

test('availability is a fresh scoped read projection, never persisted or inferred for another store', async t => {
  const f = await activated(t), { readExtractionAvailability } = await import('../src/internal/extraction-availability.js');
  const record = JSON.parse(await readFile(f.file)); record.capabilities.capture.coverage = { projects: 'only', include: ['p'] }; await writeFile(f.file, JSON.stringify(record));
  const before = await readFile(f.extraction.store.file);
  const available = await readExtractionAvailability({ file: f.extraction.store.file, storage: 'json', env: f.env });
  const graph = createShadowGraph({ extractionAvailable: available }); graph.importData(await f.read());
  assert.equal(graph.search('', { project: 'p' }).completeness.capture.extractionAvailable, true);
  assert.equal(graph.search('', { project: 'other' }).completeness.capture.extractionAvailable, false);
  assert.equal(available.active, true);
  const detached = createShadowGraph(); detached.importData(privilegedSnapshot(graph));
  assert.equal(detached.search('', { project: 'p' }).completeness.capture.extractionAvailable, false);
  assert.equal((await readExtractionAvailability({ file: join(f.root, 'manual-other'), storage: 'json', env: f.env })).active, false);
  await (await activation()).deactivateExtraction({ env: f.env });
  assert.equal((await readExtractionAvailability({ file: f.extraction.store.file, storage: 'json', env: f.env })).active, false);
  assert.deepEqual(await readFile(f.extraction.store.file), before);
});

import { runBounded } from '../src/extractor.js';
test('real local child exits before deactivation reports complete and its model result is discarded', async t => {
  const f = await activated(t), { runActivatedExtraction } = await import('../src/extraction-runtime.js');
  let ready, childPid, stopped; const entered = new Promise(r => { ready = r; });
  const worker = runActivatedExtraction({ env: f.env, project: 'p', runtimeDirectory: f.options.runtime, executorFactory: () => ({ extract: async ({ signal }) => {
    const out = await runBounded({ executable: process.execPath, args: ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], cwd: f.root, env: process.env, signal,
      spawnProcess: (...args) => { const child = spawn(...args); childPid = child.pid; child.stdout.once('data', ready); return child; } });
    stopped = out.localChildStopped;
    return { status: 'blocked', receipt: { localChildStopped: out.localChildStopped } };
  } }) });
  await entered; assert.ok(Number.isInteger(childPid));
  const result = await (await activation()).deactivateExtraction({ env: f.env });
  assert.equal(result.cleanup.status, 'complete'); assert.equal(stopped, true); assert.equal((await worker).completed, 0);
  assert.throws(() => process.kill(childPid, 0));
  assert.equal((await f.read()).records.find(x => x.id === f.item.id).state, 'pending');
});
import { createShadowGraphServer } from '../src/server.js';
test('HTTP refreshes extraction availability after deactivation and exposes no activation or extraction route', async t => {
  const f = await activated(t);
  const app = await createShadowGraphServer({ file: f.extraction.store.file, env: f.env, cwd: f.root });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => app.server.close(resolve)));
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const first = await (await fetch(`${url}/search?project=p`)).json();
  assert.equal(first.completeness.capture.extractionAvailable, true);
  for (const path of ['/extract', '/activate/extraction']) assert.equal((await fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 404);
  await (await activation()).deactivateExtraction({ env: f.env });
  assert.equal((await (await fetch(`${url}/search?project=p`)).json()).completeness.capture.extractionAvailable, false);
});

import { setTimeout as pause } from 'node:timers/promises';
test('killed activated worker is reclaimed after proved child shutdown and lease expiry without duplicate output', async t => {
  const f = await activated(t), ready = join(f.root, 'ready-child.json');
  const runtimeUrl = new URL('../src/extraction-runtime.js', import.meta.url).href;
  const supervisionUrl = new URL('../src/internal/extraction-supervision.js', import.meta.url).href;
  const request = { executable: process.execPath, args: ['-e', `require('fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid}));setInterval(()=>{},1000)`], cwd: f.root, input: '', timeoutMs: 10000, maxOutputBytes: 100 };
  const code = `import {runActivatedExtraction} from ${JSON.stringify(runtimeUrl)};import {runSupervised} from ${JSON.stringify(supervisionUrl)};await runActivatedExtraction({env:process.env,project:'p',runtimeDirectory:${JSON.stringify(f.options.runtime)},executorFactory:({supervision})=>({extract:({signal})=>runSupervised({...${JSON.stringify(request)},env:process.env,signal},supervision)})});`;
  const parent = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: f.root, env: { ...process.env, ...f.env }, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let errors = ''; parent.stderr.on('data', b => { errors += b; }); t.after(() => parent.kill('SIGKILL'));
  let child;
  for (let i = 0; i < 100; i++) { child = await readFile(ready, 'utf8').then(JSON.parse, () => null); if (child) break; await pause(50); }
  assert.ok(child?.pid, errors);
  assert.equal((await f.read()).records.find(x => x.id === f.item.id).state, 'processing');
  const closed = new Promise(resolve => parent.once('close', resolve)); parent.kill('SIGKILL'); await closed;
  const { workerSettlement } = await state();
  for (let i = 0; i < 100 && await workerSettlement(f.env) !== 'clear'; i++) await pause(25);
  assert.equal(await workerSettlement(f.env), 'clear'); assert.throws(() => process.kill(child.pid, 0));
  await pause(2100); // The killed process's two-second stale fence, not a model wait.
  // Match the simulated five-minute lease expiry for the separate usage fence.
  await utimes(await fenceLockPath(usageFile(f.env)), new Date(0), new Date(0));
  const { runActivatedExtraction } = await import(runtimeUrl); let calls = 0;
  const out = await runActivatedExtraction({ env: f.env, project: 'p', runtimeDirectory: f.options.runtime, now: () => new Date(Date.now() + 301000).toISOString(),
    executorFactory: () => ({ extract: async () => { calls++; return { status: 'success', value: { records: [] }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } }; } }) });
  assert.equal(out.completed, 1, JSON.stringify(out)); assert.equal(calls, 1);
  const data = await f.read(), item = data.records.find(x => x.id === f.item.id);
  assert.equal(item.state, 'extracted'); assert.equal(item.receipts.length, 1); assert.equal(item.lease, null);
  assert.ok(data.captureSessions[0].gaps.some(gap => gap.reason === 'extraction_unknown_period'));
});


test('concurrent deactivation preserves both disabled capabilities and both history entries', async t => {
  const f = await setup(t), api = await activation();
  f.record.capabilities.delivery = structuredClone(f.record.capabilities.capture);
  for (let i = 0; i < 8; i++) {
    await f.save();
    const [extraction, delivery] = await Promise.all([api.deactivateExtraction({ env: f.env }), api.deactivateDelivery({ env: f.env })]);
    assert.equal(extraction.state, 'deactivated'); assert.equal(delivery.state, 'deactivated');
    const record = JSON.parse(await readFile(f.file));
    assert.equal(record.capabilities.extraction.state, 'deactivated');
    assert.equal(record.capabilities.delivery.state, 'deactivated');
    assert.deepEqual(record.history.map(x => x.capability).sort(), ['delivery', 'extraction']);
    assert.equal(await (await state()).activeExtraction(f.env), null);
  }
});
