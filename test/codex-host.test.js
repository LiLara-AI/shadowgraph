import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setupCodex, loadCodexSetup, runCodexSession, changeCodexSharing, codexDelivery, pauseCodex, inspectCodex, codexStatus } from '../src/codex-host.js';
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
  const inspected = await inspectCodex({ home: f.home, cwd: f.beta, query: request.prompt, env: f.env });
  const handle = inspected.relevant.items[0].line.expansion;
  assert.match(JSON.stringify((await inspectCodex({ home: f.home, cwd: f.beta, handle, env: f.env })).record), /K7/);
  await changeCodexSharing({ home: f.home, mode: 'project', env: f.env });
  assert.equal((await codexDelivery({ ...request, config: await loadCodexSetup(f.home) })).count, 0);
  assert.equal((await inspectCodex({ home: f.home, cwd: f.beta, handle, env: f.env })).record, null);
  assert.equal((await codexStatus(f.home, f.env)).counts.pendingEligible, 0);
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

test('ordinary user correction preserves history, rebuilds old compact views and withholds stale derived echoes', async t => {
  const f = await fixture(t);
  const original = 'For alpha export, we choose K7 for fixture v3. ' + 'The source condition remains fixture v3, and the other environments are untested. '.repeat(6);
  const correction = 'Correction for alpha export: K7 is withdrawn. We now choose R8 for fixture v3; its checksum test passed.';
  const adapter = { ...extractor(f.executor), extract: async ({ prompt }) => {
    const input = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
    if (input.role !== 'user') return extractor(f.executor).extract({ prompt });
    const choice = input.untrustedText === original ? original : 'We now choose R8 for fixture v3; its checksum test passed.';
    return { status: 'success', value: { records: [{ kind: 'decision', fields: [{ name: 'chosen', text: choice, sourceRef: input.sourceRef }],
      ...(input.untrustedText === correction ? { correction: { recordId: input.correctionCandidates[0]?.recordId ?? 'missing', priorChosen: original, statement: correction } } : {}) }] },
      receipt: { provider: 'codex', model: 'gpt-6.1-sol', invocationStarted: true, localChildStopped: true } };
  } };
  await runCodexSession({ ...f, cwd: f.alpha, prompts: [original], maxCalls: 3, runHost: host, makeExtractor: () => adapter });
  const inspected = await inspectCodex({ ...f, cwd: f.alpha, query: 'alpha export fixture' });
  const inspectedDecision = inspected.relevant.items.find(item => item.record?.kind === 'decision' || item.line?.kind === 'decision');
  assert.equal(inspectedDecision.tier, 'T2', 'a long source stays full while exposing its revision handle');
  const handle = inspectedDecision.line?.expansion ?? inspectedDecision.expansion;
  assert.ok(handle);
  await runCodexSession({ ...f, cwd: f.alpha, prompts: [correction], maxCalls: 3, runHost: host, makeExtractor: () => adapter });
  const config = await loadCodexSetup(f.home), data = JSON.parse(await readFile(config.store.file));
  const old = data.records.find(record => record.kind === 'decision' && record.chosen === original);
  const current = data.records.find(record => record.kind === 'decision' && record.correction);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, current.id);
  assert.equal(current.correction.status, 'model_proposed');
  assert.match(current.interpretation.sourceText, /withdrawn/);
  const expanded = await inspectCodex({ ...f, cwd: f.alpha, handle });
  assert.equal(expanded.revisionChanged, true);
  const delivery = await codexDelivery({ config, project: 'alpha', prompt: 'alpha export fixture', env: f.env });
  assert.match(delivery.text, /R8/);
  const echoes = data.records.filter(record => record.memoryDependencies?.includes(old.id));
  assert.ok(echoes.length > 0);
  assert.ok(echoes.every(record => !delivery.sourceIds.includes(record.id)));
});

test('memory-informed answers cannot launder a shared source into locally readable memory after revocation', async t => {
  const f = await fixture(t), config = await loadCodexSetup(f.home);
  const store = await createStorage({ type: 'json', file: config.store.file, env: f.env });
  const graph = createShadowGraph(); graph.importData(await store.load());
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'checksum', text: 'K7 preserves the footer checksum in fixture 3.' });
  await store.save(privilegedSnapshot(graph)); store.close();
  await changeCodexSharing({ home: f.home, mode: 'selected', projects: ['alpha'], env: f.env });
  await runCodexSession({ ...f, cwd: f.beta, prompts: ['Which footer checksum approach applies?'], maxCalls: 3,
    runHost: async () => ({ code: 0, stdout: events('K7 preserves the footer checksum in fixture 3.').map(JSON.stringify).join('\n'), stderr: '', localChildStopped: true }),
    makeExtractor: () => extractor(f.executor) });
  await changeCodexSharing({ home: f.home, mode: 'project', env: f.env });
  const after = await codexDelivery({ config: await loadCodexSetup(f.home), project: 'beta', prompt: 'footer checksum approach', env: f.env });
  assert.doesNotMatch(after.text, /K7/);
  const reopened = await createStorage({ type: 'json', file: config.store.file, env: f.env });
  const checked = createShadowGraph(); checked.importData(await reopened.load()); reopened.close();
  assert.doesNotMatch(JSON.stringify(checked.exportData({ project: 'beta' })), /K7/);
  assert.doesNotMatch(JSON.stringify(checked.getJournal({ project: 'beta' })), /K7/);
});
