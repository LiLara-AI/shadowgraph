import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupCodex, loadCodexSetup, runCodexSession, changeCodexSharing, codexDelivery, pauseCodex } from '../src/codex-host.js';
import { createStorage } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

async function fixture(t) {
  const root = await scratchDirectory(t), home = join(root, 'private'), alpha = join(root, 'alpha'), beta = join(root, 'beta');
  await Promise.all([mkdir(alpha), mkdir(beta)]);
  const executor = { ok: true, provider: 'codex', model: 'gpt-6.1-sol', executable: process.execPath, hostVersion: '0.161.0', binarySha256: 'a'.repeat(64), accountSalt: 'b'.repeat(32), accountFingerprint: 'c'.repeat(64) };
  await setupCodex({ home, executable: process.execPath, projects: [{ project: 'alpha', cwd: alpha }, { project: 'beta', cwd: beta }], checkExecutor: async () => executor });
  return { root, home, alpha, beta, executor, env: { ...process.env, SHADOWGRAPH_HOME: home } };
}
const events = (answer = 'The checksum fixture passed.') => [ { type: 'thread.started', thread_id: 'fixture' }, { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'message-1', type: 'agent_message', text: answer } }, { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 10 } } ];
const host = async request => ({ code: 0, stdout: events().map(JSON.stringify).join('\n'), stderr: '', localChildStopped: true });
const extractor = checked => ({ check: async () => checked, extract: async ({ prompt }) => {
  const source = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  return { status: 'success', value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: source.untrustedText, sourceRef: source.sourceRef }] }] },
    receipt: { provider: 'codex', model: 'gpt-6.1-sol', invocationStarted: true, localChildStopped: true, usage: { inputTokens: 50, outputTokens: 20 } } };
} });

test('installed wrapper boundary automatically captures, extracts, persists and delivers on a fresh run', async t => {
  const f = await fixture(t), prompt = 'Project alpha checksum fixture: choose K7; Q2 drops the footer checksum.';
  const first = await runCodexSession({ ...f, cwd: f.alpha, prompts: [prompt], maxCalls: 3, runHost: host, makeExtractor: () => extractor(f.executor) });
  assert.equal(first.results[0].captureIds.length, 2);
  assert.equal(first.results[0].extraction.completed, 2);
  assert.equal(first.calls, 3);
  let delivered;
  const second = await runCodexSession({ ...f, cwd: f.alpha, prompts: ['What happened with the footer checksum fixture?'], maxCalls: 3,
    runHost: async request => { delivered = request.input; return host(request); }, makeExtractor: () => extractor(f.executor) });
  assert.match(delivered, /K7/);
  assert.ok(second.results[0].contextBytes > 0);
  assert.equal(JSON.parse(await readFile(join(second.runDirectory, 'finished.json'))).localChildStopped, true);
});

test('sharing off/on/revoke uses the existing grant boundary and preserves source project', async t => {
  const f = await fixture(t), config = await loadCodexSetup(f.home);
  const store = await createStorage({ type: 'json', file: config.store.file, env: f.env });
  const graph = createShadowGraph(); graph.importData(await store.load());
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'checksum', text: 'K7 preserves the footer checksum on fixture version 3; other versions are unknown.' });
  await store.save(privilegedSnapshot(graph)); store.close();
  const request = { project: 'beta', prompt: 'footer checksum fixture', env: f.env };
  assert.equal((await codexDelivery({ ...request, config })).count, 0);
  await changeCodexSharing({ home: f.home, mode: 'selected', projects: ['alpha'], env: f.env });
  const shared = await codexDelivery({ ...request, config: await loadCodexSetup(f.home) });
  assert.match(shared.text, /K7/); assert.match(shared.text, /alpha/); assert.match(shared.text, /unknown/);
  await changeCodexSharing({ home: f.home, mode: 'project', env: f.env });
  assert.equal((await codexDelivery({ ...request, config: await loadCodexSetup(f.home) })).count, 0);
  // A stale policy object still cannot use the revoked grant.
  const revoked = await changeCodexSharing({ home: f.home, mode: 'all-permitted', exclude: ['alpha'], env: f.env });
  assert.deepEqual(revoked.projects, ['beta']);
  assert.equal((await codexDelivery({ ...request, config: await loadCodexSetup(f.home) })).count, 0);
});

test('bounded session stops at first host failure and pause prevents new calls', async t => {
  const f = await fixture(t); let calls = 0;
  await assert.rejects(runCodexSession({ ...f, cwd: f.alpha, prompts: ['First', 'Second'], runHost: async () => { calls++; return { code: 1, localChildStopped: true }; }, makeExtractor: () => extractor(f.executor) }), /codex_host_failed/);
  assert.equal(calls, 1);
  await pauseCodex({ home: f.home, paused: true });
  await assert.rejects(runCodexSession({ ...f, cwd: f.alpha, prompts: ['Third'], runHost: host }), /codex_memory_paused/);
});

test('idle interactive prompt input cannot outlive the session deadline', async t => {
  const f = await fixture(t);
  const prompts = { [Symbol.asyncIterator]() { return { next: () => new Promise(() => {}) }; } };
  const started = Date.now();
  await assert.rejects(runCodexSession({ ...f, cwd: f.alpha, prompts, deadlineMs: 100, makeExtractor: () => extractor(f.executor) }), /drain_stopped/);
  assert.ok(Date.now() - started < 5000);
});

test('a host policy rejection stops before extraction even when the CLI returns zero', async t => {
  const f = await fixture(t); let extracted = 0;
  const adapter = extractor(f.executor);
  await assert.rejects(runCodexSession({ ...f, cwd: f.alpha, prompts: ['Run a diagnostic'],
    runHost: async request => ({ ...await host(request), stderr: 'ERROR exec_command failed: rejected: blocked by policy' }),
    makeExtractor: () => ({ ...adapter, extract: async input => { extracted++; return adapter.extract(input); } }) }), /codex_host_policy_rejected/);
  assert.equal(extracted, 0);
});
