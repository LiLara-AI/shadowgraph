import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorage } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot, privilegedRebuild } from '../src/internal/snapshot.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { claimCapture, runExtractionDrain } from '../src/internal/extraction-worker.js';
import { initializeUsage, FROZEN_WORKER_BUDGETS, usageFile } from '../src/internal/extraction-budget.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
const START = '2026-10-01T00:00:00.000Z';
const admission = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 1000, maxItemBytes: 2 ** 20, maxItemsPerSession: 1000 }, storeBytes: 0 };
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
async function setup(t, type, count = 1, budgets = {}) {
  const root = await scratchDirectory(t); let at = START;
  const options = { type, file: join(root, 'memory'), env: { SHADOWGRAPH_HOME: root }, project: 'p', now: () => at, budgets: { ...FROZEN_WORKER_BUDGETS, ...budgets } };
  const graph = createShadowGraph({ now: options.now }); const items = [];
  for (let i = 0; i < count; i++) items.push(privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic-origin', text: `Synthetic observation ${i}.`, admission, source: { event: 'UserPromptSubmit', sessionId: 'synthetic-session' } }));
  const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
  await initializeUsage({ env: options.env, now: () => Date.parse(at) });
  const read = async () => { const s = await createStorage(options); try { return await s.load(); } finally { s.close(); } };
  const response = { status: 'success', value: { records: [] }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } };
  return { options, items, read, response, clock: value => { at = value; } };
}
for (const type of ['json', 'sqlite']) {
  const skip = type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {};
  test(`drain ${type}: one schema retry, durable usage, committed empty result and stop on executor block`, skip, async t => {
    const f = await setup(t, type, 3); const prompts = []; let count = 0;
    const out = await runExtractionDrain({ ...f.options, sleep: async () => {}, executor: { extract: async request => {
      prompts.push(request.prompt); count++;
      return count === 1 ? { status: 'schema_invalid' } : count === 2 ? f.response : { status: 'blocked', blockedReason: 'rate_limit' };
    } } });
    assert.equal(out.status, 'blocked'); assert.equal(count, 3); assert.equal(prompts[0], prompts[1]);
    assert.equal(JSON.parse(await readFile(usageFile(f.options.env))).calls.length, 3);
    const data = await f.read(), captures = data.records.filter(x => x.kind === 'capture');
    assert.equal(captures[0].state, 'extracted'); assert.equal(captures[0].attempts, 2);
    assert.equal(captures[1].state, 'pending'); assert.equal(captures[2].state, 'pending');
    const g = createShadowGraph(); g.importData(data); const status = g.search('', { project: 'p' }).completeness.capture;
    assert.equal(status.extractionAvailable, false); assert.ok(status.workerErrors.some(x => x.reason === 'executor_blocked'));
  });
  test(`drain ${type}: a second schema-invalid response persists failed once with two charged calls`, skip, async t => {
    const f = await setup(t, type); let calls = 0;
    await runExtractionDrain({ ...f.options, sleep: async () => {}, executor: { extract: async () => { calls++; return { status: 'schema_invalid' }; } } });
    const item = (await f.read()).records.find(x => x.kind === 'capture');
    assert.equal(calls, 2); assert.equal(item.state, 'failed'); assert.equal(item.lastError, 'schema_invalid'); assert.equal(item.attempts, 2);
    assert.equal(JSON.parse(await readFile(usageFile(f.options.env))).calls.length, 2);
  });
  test(`drain ${type}: each budget blocks with pending work intact`, skip, async t => {
    for (const [budgets, reason, expectedCalls] of [[{ inputBytes: 1 }, 'input_bytes', 0], [{ journalEntriesPerSession: 1 }, 'session_journal', 0], [{ calls: 1 }, 'drain_calls', 1], [{ items: 1 }, 'drain_items', 1], [{ windowCalls: 1 }, 'window_calls', 1]]) {
      const f = await setup(t, type, 2, budgets); let calls = 0;
      const result = await runExtractionDrain({ ...f.options, executor: { extract: async () => { calls++; return f.response; } } });
      assert.equal(result.status, 'blocked', JSON.stringify(budgets));
      assert.equal(result.blockedReason, reason); assert.equal(calls, expectedCalls); assert.equal(result.completed, expectedCalls);
      const data = await f.read();
      assert.deepEqual(data.records.filter(x => x.kind === 'capture' && x.state === 'pending').map(x => x.id), f.items.slice(expectedCalls).map(x => x.id));
      assert.ok(data.records.every(x => x.kind !== 'capture' || x.lease === null));
    }
  });
  test(`drain ${type}: output journal ceiling rolls back every proposed canonical record`, skip, async t => {
    const f = await setup(t, type, 1, { journalEntriesPerSession: 3 });
    const response = { ...f.response, value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: 'Synthetic observation 0.', sourceRef: f.items[0].id }] }] } };
    const result = await runExtractionDrain({ ...f.options, executor: { extract: async () => response } });
    assert.equal(result.status, 'blocked'); assert.equal(result.blockedReason, 'session_journal');
    const data = await f.read(); assert.equal(data.records.filter(x => x.kind !== 'capture').length, 0);
    assert.equal(data.records.find(x => x.kind === 'capture').state, 'pending');
    const g = createShadowGraph(); g.importData(data); assert.equal(privilegedRebuild(g).rebuildable, true);
  });
  test(`drain ${type}: failed response commit retains lease and recovers unknown period on a later write`, skip, async t => {
    const f = await setup(t, type); let invoked = false;
    const result = await runExtractionDrain({ ...f.options, openStore: async options => {
      if (invoked) throw new Error('synthetic save medium unavailable'); return createStorage(options);
    }, executor: { extract: async () => { invoked = true; return f.response; } } });
    assert.equal(result.storeReceiptWritten, false); assert.equal(result.status, 'unavailable');
    const lost = (await f.read()).records.find(x => x.kind === 'capture'); assert.equal(lost.state, 'processing'); assert.equal(lost.receipts.length, 0);
    f.clock('2026-10-01T00:05:01.000Z');
    await runExtractionDrain({ ...f.options, executor: { extract: async () => f.response } });
    const data = await f.read(); assert.ok(data.captureSessions[0].gaps.some(x => x.reason === 'extraction_unknown_period'));
    assert.equal(JSON.parse(await readFile(usageFile(f.options.env))).calls.length, 2);
  });
  test(`drain ${type}: failure inside the actual store commit persists neither success nor receipt`, skip, async t => {
    const f = await setup(t, type); let responseReady = false, commitFailed = false;
    const result = await runExtractionDrain({ ...f.options, saveFault: point => {
      if (responseReady && point === 'beforeCommit') { commitFailed = true; throw new Error('synthetic write failure'); }
    }, executor: { extract: async () => { responseReady = true; return f.response; } } });
    assert.equal(commitFailed, true); assert.equal(result.status, 'unavailable'); assert.equal(result.storeReceiptWritten, false);
    const before = await f.read(), item = before.records.find(x => x.kind === 'capture');
    assert.equal(item.state, 'processing'); assert.equal(item.receipts.length, 0); assert.equal(before.captureSessions[0].extraction, undefined);
    f.clock('2026-10-01T00:05:01.000Z'); await runExtractionDrain({ ...f.options, executor: { extract: async () => f.response } });
    const after = await f.read(); assert.ok(after.captureSessions[0].gaps.some(x => x.reason === 'extraction_unknown_period'));
    assert.equal(JSON.parse(await readFile(usageFile(f.options.env))).calls.length, 2);
  });
  test(`drain ${type}: restore cannot refund reserved usage and worker errors remain scope-local`, skip, async t => {
    const f = await setup(t, type, 1, { windowCalls: 1 }); const backup = join(f.options.env.SHADOWGRAPH_HOME, 'before.backup');
    if (type === 'json') await backupFile(f.options.file, backup);
    else { const s = await createStorage(f.options); try { await s.backup(backup); } finally { s.close(); } }
    await runExtractionDrain({ ...f.options, executor: { extract: async () => f.response } });
    if (type === 'json') await restoreFile(backup, f.options.file);
    else { const s = await createStorage(f.options); try { await s.restore(backup); } finally { s.close(); } }
    let called = false;
    const result = await runExtractionDrain({ ...f.options, executor: { extract: async () => { called = true; return f.response; } } });
    assert.equal(result.blockedReason, 'window_calls'); assert.equal(called, false);
    const g = createShadowGraph(); g.importData(await f.read());
    assert.equal(g.search('', { project: 'other' }).completeness.capture.workerErrors, undefined);
    assert.ok(g.search('', { project: 'p' }).completeness.capture.workerErrors.some(x => x.reason === 'window_calls'));
  });
  test(`drain ${type}: missing usage and failed store never invoke or fabricate a store receipt`, skip, async t => {
    const f = await setup(t, type); let calls = 0;
    const before = await readFile(f.options.file);
    const result = await runExtractionDrain({ ...f.options, openStore: async () => { throw new Error('unwritable synthetic store'); }, executor: { extract: async () => { calls++; return f.response; } } });
    assert.equal(result.status, 'unavailable'); assert.equal(result.storeReceiptWritten, false); assert.equal(calls, 0);
    assert.deepEqual(await readFile(f.options.file), before);
    await writeFile(usageFile(f.options.env), '{}');
    assert.equal((await runExtractionDrain({ ...f.options, executor: { extract: async () => { calls++; } } })).status, 'blocked');
    assert.equal(calls, 0);
  });
  test(`drain ${type}: expired lease recovery declares an unknown period, with no invented result`, skip, async t => {
    const f = await setup(t, type); await claimCapture({ ...f.options, leaseMs: 1000 });
    f.clock('2026-10-01T00:00:02.000Z');
    await runExtractionDrain({ ...f.options, executor: { extract: async () => f.response } });
    const data = await f.read(), g = createShadowGraph(); g.importData(data);
    assert.ok(g.search('', { project: 'p' }).completeness.capture.gaps.some(x => x.reason === 'extraction_unknown_period' && x.from === START && x.to === f.options.now()));
  });
  test(`drain ${type}: deactivation/deadline discards output and a late promise cannot commit`, skip, async t => {
    const f = await setup(t, type); let called = false; const controller = new AbortController();
    const result = await runExtractionDrain({ ...f.options, signal: controller.signal, executor: { extract: async ({ signal }) => {
      called = true; controller.abort(); assert.equal(signal.aborted, true); return f.response;
    } } });
    assert.equal(result.status, 'blocked');
    assert.ok((await f.read()).records.every(x => x.kind === 'capture' && x.state !== 'extracted'));
    assert.equal(called, true);
  });
  test(`drain ${type}: wall deadline bounds an unresponsive executor and prevents late commit`, skip, async t => {
    const f = await setup(t, type, 1, { wallMs: 1000 }); let resolveCall, called = false;
    const result = await runExtractionDrain({ ...f.options, executor: { extract: async () => {
      called = true; return new Promise(resolve => { resolveCall = resolve; });
    } } });
    assert.equal(called, true); assert.equal(result.status, 'blocked'); assert.equal(result.blockedReason, 'drain_stopped');
    resolveCall(f.response); await new Promise(resolve => setImmediate(resolve));
    const data = await f.read(); assert.equal(data.records.find(x => x.kind === 'capture').state, 'pending');
    assert.equal(data.records.find(x => x.kind === 'capture').receipts.length, 0);
  });
  test(`drain ${type}: abort during commit preparation or final persistence never commits output`, skip, async t => {
    for (const stage of ['open', 'beforeCommit']) {
      const f = await setup(t, type), controller = new AbortController(); let responseReady = false;
      const out = await runExtractionDrain({ ...f.options, signal: controller.signal,
        openStore: async options => { if (stage === 'open' && responseReady) controller.abort(); return createStorage(options); },
        saveFault: point => { if (stage === point && responseReady) controller.abort(); },
        executor: { extract: async () => { responseReady = true; return f.response; } } });
      assert.equal(out.completed, 0); const item = (await f.read()).records.find(x => x.kind === 'capture');
      assert.notEqual(item.state, 'extracted'); assert.equal(item.receipts.length, 0);
    }
  });
  test(`drain ${type}: never-resolving guards are deadline bounded and late guards cannot start calls`, skip, async t => {
    const f = await setup(t, type, 1, { wallMs: 50 }); let release, calls = 0;
    const pending = runExtractionDrain({ ...f.options, guard: () => new Promise(resolve => { release = resolve; }), executor: { extract: async () => { calls++; return f.response; } } });
    const result = await Promise.race([pending, new Promise(resolve => setTimeout(() => resolve('hung'), 1800))]);
    if (result === 'hung') release(true);
    assert.notEqual(result, 'hung'); release(true); await pending; assert.equal(calls, 0);
  });
  test(`drain ${type}: schema-conformant duplicate fields are observed once without a quality retry`, skip, async t => {
    const f = await setup(t, type); let calls = 0;
    const field = { name: 'text', text: 'Synthetic observation 0.', sourceRef: f.items[0].id };
    const out = await runExtractionDrain({ ...f.options, executor: { extract: async () => { calls++; return { ...f.response, value: { records: [{ kind: 'memory', fields: [field, field] }] } }; } } });
    assert.equal(calls, 1); assert.equal(out.completed, 1);
    assert.equal((await f.read()).records.filter(x => x.kind === 'memory').length, 1);
  });
  test(`drain ${type}: status writes preserve populated foreign project and unattributed sessions`, skip, async t => {
    const f = await setup(t, type), graph = createShadowGraph({ now: f.options.now }); graph.importData(await f.read());
    for (const owner of [{ project: 'other', originId: 'other-origin' }, { originId: 'unattributed-origin' }]) {
      privilegedRecordCapture(graph, { ...owner, text: 'Foreign synthetic capture.', admission, source: { event: 'UserPromptSubmit', sessionId: `${owner.originId}-session` } });
    }
    const store = await createStorage(f.options); await store.save(privilegedSnapshot(graph)); store.close();
    const before = (await f.read()).captureSessions.filter(x => x.project !== 'p');
    await runExtractionDrain({ ...f.options, executor: { extract: async () => ({ status: 'blocked' }) } });
    assert.deepEqual((await f.read()).captureSessions.filter(x => x.project !== 'p'), before);
    await runExtractionDrain({ ...f.options, executor: { extract: async () => f.response } });
    assert.deepEqual((await f.read()).captureSessions.filter(x => x.project !== 'p'), before);
    const otherBefore = (await f.read()).captureSessions.filter(x => x.originId !== 'unattributed-origin');
    await runExtractionDrain({ ...f.options, project: undefined, originId: 'unattributed-origin', executor: { extract: async () => ({ status: 'blocked' }) } });
    assert.deepEqual((await f.read()).captureSessions.filter(x => x.originId !== 'unattributed-origin'), otherBefore);
  });
}

test('drain json: cancellation between transient rename attempts never commits model output', async t => {
  const f = await setup(t, 'json'), controller = new AbortController();
  let responseReady = false, interrupted = false;
  const out = await runExtractionDrain({ ...f.options, signal: controller.signal,
    rename: async (from, to) => {
      if (responseReady && !interrupted) {
        interrupted = true; controller.abort();
        throw Object.assign(new Error('synthetic sharing violation'), { code: 'EPERM' });
      }
      return rename(from, to);
    }, executor: { extract: async () => { responseReady = true; return f.response; } } });
  assert.equal(interrupted, true); assert.equal(out.completed, 0);
  const item = (await f.read()).records.find(x => x.kind === 'capture');
  assert.notEqual(item.state, 'extracted'); assert.equal(item.receipts.length, 0);
  assert.equal(JSON.parse(await readFile(usageFile(f.options.env))).calls.length, 1);
});

for (const type of ['json', 'sqlite']) test(`drain registers each dedicated invocation before execution and preserves retry prompt identity (${type})`, async t => {
  const { readInvocationContext, identityFile } = await import('../src/internal/extraction-identity.js');
  const f = await setup(t, type); const identities = [], prompts = [];
  const out = await runExtractionDrain({ ...f.options, sleep: async () => {}, executor: { extract: async request => {
    assert.ok(request.identity, 'worker must provide its registered identity');
    const context = await readInvocationContext({ env: f.options.env, now: () => Date.parse(f.options.now()) });
    const row = context.workerInvocations.find(row => row.invocationId === request.identity.invocationId);
    assert.ok(row, 'registration exists before the executor is entered');
    const item = (await f.read()).records.find(x => x.kind === 'capture');
    assert.equal(row.leaseId, item.lease.leaseId); assert.equal(row.to, item.lease.leaseExpiresAt);
    identities.push(request.identity); prompts.push(request.prompt);
    return identities.length === 1 ? { status: 'schema_invalid' } : f.response;
  } } });
  assert.equal(out.completed, 1); assert.equal(identities.length, 2);
  assert.notEqual(identities[0].invocationId, identities[1].invocationId);
  assert.equal(identities[0].correlationToken, identities[1].correlationToken); assert.equal(prompts[0], prompts[1]);
  assert.doesNotMatch(await readFile(identityFile(f.options.env), 'utf8'), /Synthetic observation/);
  const bad = await setup(t, type); await writeFile(identityFile(bad.options.env), '{}'); let calls = 0;
  const blocked = await runExtractionDrain({ ...bad.options, executor: { extract: async () => { calls++; return bad.response; } } });
  assert.equal(calls, 0); assert.equal(blocked.completed, 0);
  assert.equal((await bad.read()).records.find(x => x.kind === 'capture').state, 'pending');
});

for (const type of ['json', 'sqlite']) test(`one automatic drain shares its call ceiling across distinct project queues (${type})`, async t => {
  const f = await setup(t, type, 1, { calls: 1 }); const graph = createShadowGraph({ now: f.options.now }); graph.importData(await f.read());
  const other = privilegedRecordCapture(graph, { project: 'q', originId: 'synthetic-origin', text: 'Other project observation.', admission, source: { event: 'UserPromptSubmit', sessionId: 'other-session' } });
  const store = await createStorage(f.options); await store.save(privilegedSnapshot(graph)); store.close(); let calls = 0;
  const out = await runExtractionDrain({ ...f.options, project: undefined, scopes: [{ project: 'p' }, { project: 'q' }], executor: { extract: async () => { calls++; return f.response; } } });
  assert.equal(calls, 1); assert.equal(out.completed, 1); assert.equal(out.blockedReason, 'drain_calls');
  const items = (await f.read()).records.filter(x => x.kind === 'capture');
  assert.equal(items.find(x => x.id === f.items[0].id).state, 'extracted'); assert.equal(items.find(x => x.id === other.id).state, 'pending');
});
