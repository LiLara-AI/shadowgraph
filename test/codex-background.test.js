import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { setupCodex, runCodexSession, loadCodexSetup, codexDelivery, codexHostRequest } from '../src/codex-host.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

async function fixture(t) {
  const root = await scratchDirectory(t), home = join(root, 'private'), cwd = join(root, 'work');
  await mkdir(cwd);
  const executor = { ok: true, provider: 'codex', model: 'gpt-6.1-sol', executable: process.execPath, hostVersion: '0.161.0', binarySha256: 'a'.repeat(64), accountSalt: 'b'.repeat(32), accountFingerprint: 'c'.repeat(64) };
  await setupCodex({ home, executable: process.execPath, projects: [{ project: 'sample', cwd }], hostMode: 'text', checkExecutor: async () => executor });
  return { home, cwd, executor, env: { ...process.env, SHADOWGRAPH_HOME: home } };
}
const host = async () => ({ code: 0, localChildStopped: true, stdout: [
  { type: 'turn.started' }, { type: 'item.completed', item: { id: 'answer', type: 'agent_message', text: 'Work completed.' } },
  { type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }
].map(JSON.stringify).join('\n'), stderr: '' });
const extracted = ({ prompt }) => {
  const source = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  return { status: 'success', value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: source.untrustedText, sourceRef: source.sourceRef }] }] },
    receipt: { provider: 'codex', model: 'gpt-6.1-sol', invocationStarted: true, localChildStopped: true } };
};

test('ready answers and a second host task do not wait for a delayed extractor', async t => {
  const f = await fixture(t); let release, entered, calls = 0, displayed = 0;
  const held = new Promise(r => { release = r; }), started = new Promise(r => { entered = r; });
  const timeout = setTimeout(release, 3000); t.after(() => { clearTimeout(timeout); release(); });
  let displayedBeforeRelease;
  const run = runCodexSession({ ...f, prompts: ['First work.', 'Second work.'], maxCalls: 6,
    runHost: async () => { calls++; return host(); }, onResult: () => { displayed++; if (displayed === 2) { displayedBeforeRelease = calls; release(); } },
    makeExtractor: () => ({ check: async () => f.executor, extract: async input => { entered(); await held; return extracted(input); } }) });
  await started;
  assert.ok(displayed >= 1, 'completed host output must be visible before the extractor settles');
  await run;
  assert.equal(displayedBeforeRelease, 2, 'second otherwise-permitted task completes while memory is pending');
});

test('memory failure retains pending work, permits both tasks, and recovers automatically on restart', async t => {
  const f = await fixture(t); let calls = 0;
  const first = await runCodexSession({ ...f, prompts: ['Choose P9 for the lunar checksum fixture.', 'Second ordinary work.'], maxCalls: 6, settleMs: 0, memoryRetryMs: 500,
    runHost: async () => { calls++; return host(); },
    makeExtractor: () => ({ check: async () => f.executor, extract: async () => ({ status: 'blocked', blockedReason: 'synthetic_unavailable', receipt: { invocationStarted: false, localChildStopped: true } }) }) });
  assert.equal(calls, 2);
  assert.equal(first.results.length, 2);
  const config = await loadCodexSetup(f.home);
  let data = JSON.parse(await readFile(config.store.file));
  assert.equal(data.records.filter(x => x.kind === 'capture' && x.state === 'pending').length, 4);
  await runCodexSession({ ...f, prompts: [], settleMs: 5000, memoryRetryMs: 100,
    makeExtractor: () => ({ check: async () => f.executor, extract: async input => extracted(input) }) });
  data = JSON.parse(await readFile(config.store.file));
  assert.equal(data.records.filter(x => x.kind === 'capture' && x.state === 'extracted').length, 4);
  const delivery = await codexDelivery({ config, project: 'sample', prompt: 'lunar checksum fixture', env: f.env });
  assert.match(delivery.text, /P9/);
  const recordCount = data.records.length;
  await runCodexSession({ ...f, prompts: [], makeExtractor: () => ({ check: async () => f.executor, extract: async () => { throw new Error('already processed'); } }) });
  assert.equal(JSON.parse(await readFile(config.store.file)).records.length, recordCount);
});

test('ordinary interactive work is not capped at the old eight-turn demonstration ceiling', async t => {
  const f = await fixture(t);
  const config = await loadCodexSetup(f.home);
  // Exclusion is an ordinary configured capture choice, not a memory failure.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(f.home, 'codex-integration.json'), JSON.stringify({ ...config, capture: { mode: 'all', exclude: ['sample'] } }));
  const result = await runCodexSession({ ...f, prompts: Array.from({ length: 10 }, (_, i) => `Work ${i}`), runHost: host,
    makeExtractor: () => ({ check: async () => f.executor, extract: async () => { throw new Error('excluded'); } }) });
  assert.equal(result.results.length, 10);
});

test('Windows workspace host explicitly selects a sandbox backend without disabling policy', async t => {
  const f = await fixture(t), config = { ...await loadCodexSetup(f.home), hostMode: 'workspace' };
  const request = codexHostRequest({ config, cwd: f.cwd, prompt: 'Run the local test.', platform: 'win32' });
  assert.ok(request.args.includes('windows.sandbox="unelevated"'));
  assert.equal(request.args[request.args.indexOf('--sandbox') + 1], 'workspace-write');
  assert.ok(!request.args.some(arg => /ignore-rules|bypass/iu.test(arg)));
  assert.ok(request.args.includes('approval_policy="never"'));
});

test('failed memory recovers while the session is idle and the next task automatically receives it', async t => {
  const f = await fixture(t); let available = false, hostCalls = 0, failures = 0, recovered, timeout, failed, completed = 0;
  const failureObserved = new Promise(resolve => { failed = resolve; });
  const ready = new Promise((resolve, reject) => { recovered = resolve; timeout = setTimeout(() => reject(new Error('automatic recovery timeout')), 6000); });
  t.after(() => clearTimeout(timeout));
  const prompts = { async *[Symbol.asyncIterator]() {
    yield 'Lunar checksum fixture uses P9.';
    await failureObserved;
    yield 'Another work task.';
    await ready;
    yield 'How should the lunar checksum fixture be handled?';
  } };
  const result = await runCodexSession({ ...f, prompts, memoryRetryMs: 100,
    runHost: async request => { if (++hostCalls === 3) assert.match(request.input, /P9/); return host(); },
    onResult: result => { if (result.turn === 1) available = true; },
    onMemory: state => { completed += state.completed ?? 0; if (state.status === 'blocked') failed(); if (available && state.status === 'idle' && completed >= 4) recovered(); },
    makeExtractor: () => ({ check: async () => f.executor, extract: async input => {
      if (!available) { failures++; return { status: 'blocked', blockedReason: 'synthetic_unavailable', receipt: { invocationStarted: false, localChildStopped: true } }; }
      return extracted(input);
    } }) });
  assert.equal(hostCalls, 3); assert.ok(failures > 0 && failures <= 2);
  assert.ok(result.results[2].contextBytes > 0);
});

test('durable outbox survives unavailable storage and replay after a commit is idempotent', async t => {
  const f = await fixture(t), config = await loadCodexSetup(f.home), pristine = await readFile(config.store.file).catch(() => null);
  const adapter = () => ({ check: async () => f.executor, extract: async input => extracted(input) });
  const first = await runCodexSession({ ...f, prompts: ['Lunar checksum uses P9.'], settleMs: 0, memoryRetryMs: 100,
    runHost: host, makeExtractor: adapter, onResult: async () => { await writeFile(config.store.file, 'temporarily unavailable'); } });
  assert.equal(first.results[0].acceptedDurably, true);
  const outbox = join(f.home, 'outbox'), files = await readdir(outbox);
  assert.equal(files.length, 1);
  const accepted = await readFile(join(outbox, files[0]));
  if (pristine) await writeFile(config.store.file, pristine); else await unlink(config.store.file);
  await runCodexSession({ ...f, prompts: [], settleMs: 5000, memoryRetryMs: 100, makeExtractor: adapter });
  const before = JSON.parse(await readFile(config.store.file));
  assert.equal(before.records.filter(r => r.kind === 'capture').length, 2);
  assert.equal((await readdir(outbox)).length, 0);
  // Crash after commit and before deleting the receipt: exact accepted source
  // identities must resolve to the prior captures, never new experience.
  await writeFile(join(outbox, files[0]), accepted);
  await runCodexSession({ ...f, prompts: [], makeExtractor: adapter });
  const after = JSON.parse(await readFile(config.store.file));
  assert.equal(after.records.length, before.records.length);
  assert.equal(after.journal.filter(e => e.type === 'capture.recorded').length, 2);
});

test('abort settles the active extractor, keeps acknowledged work pending, and restart recovers it', async t => {
  const f = await fixture(t), controller = new AbortController(); let stopped = false;
  const first = await runCodexSession({ ...f, prompts: ['Lunar checksum uses P9.'], signal: controller.signal,
    runHost: host, makeExtractor: () => ({ check: async () => f.executor, extract: input => new Promise(resolve => {
      input.signal.addEventListener('abort', () => { stopped = true; resolve({ status: 'blocked', blockedReason: 'drain_stopped', receipt: { localChildStopped: true } }); }, { once: true });
      setImmediate(() => controller.abort());
    }) }) });
  assert.equal(stopped, true);
  assert.equal(JSON.parse(await readFile(join(first.runDirectory, 'finished.json'))).localChildStopped, true);
  const config = await loadCodexSetup(f.home), data = JSON.parse(await readFile(config.store.file));
  assert.equal(data.records.filter(r => r.kind === 'capture' && r.state === 'pending').length, 2);
  await runCodexSession({ ...f, prompts: [], makeExtractor: () => ({ check: async () => f.executor, extract: async input => extracted(input) }) });
  assert.equal(JSON.parse(await readFile(config.store.file)).records.filter(r => r.kind === 'capture' && r.state === 'extracted').length, 2);
});
