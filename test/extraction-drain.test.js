import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorage } from '../src/storage.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot, privilegedRebuild } from '../src/internal/snapshot.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { CLEANUP_BOUND_FOR_TESTS, claimCapture, runExtractionDrain } from '../src/internal/extraction-worker.js';
import { storeIo } from '../src/internal/deletion-knowledge.js';
import { initializeUsage, FROZEN_WORKER_BUDGETS, usageFile } from '../src/internal/extraction-budget.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
const START = '2026-10-01T00:00:00.000Z';
const admission = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 1000, maxItemBytes: 2 ** 20, maxItemsPerSession: 1000 }, storeBytes: 0 };
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const backendSkip = (type) => (type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {});
async function setup(t, type, count = 1, budgets = {}) {
  const root = await scratchDirectory(t); let at = START;
  const options = { type, file: join(root, 'memory'), env: { SHADOWGRAPH_HOME: root }, project: 'p', now: () => at, budgets: { ...FROZEN_WORKER_BUDGETS, ...budgets } };
  const graph = createShadowGraph({ now: options.now }); const items = [];
  for (let i = 0; i < count; i++) items.push(privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic-origin', text: `Synthetic observation ${i}.`, admission, source: { event: 'UserPromptSubmit', sessionId: 'synthetic-session' } }));
  const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
  await initializeUsage({ env: options.env, now: () => Date.parse(at) });
  const read = async () => { const s = await createStorage(options); try { return await s.load(); } finally { s.close(); } };
  const response = { status: 'success', value: { records: [] }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } };
  // A drain's block cleanup must finish within its bound. Tests of what a block
  // records take the test-only seam, so a slow runner cannot turn their block
  // into a failed cleanup (a Windows CI runner did, at the one-second bound);
  // the tests of the production bound itself take `production`, without it.
  return { options: { ...options, [CLEANUP_BOUND_FOR_TESTS]: 60_000 }, production: options, items, read, response, clock: value => { at = value; } };
}
// A content-free trace of a drain's store operations, through its openStore
// seam: each open as an operation or the bounded cleanup (only the cleanup caps
// the lock wait), when its store opened and closed, how its fenced run ended (an
// error's code or name, never a message or data), and whether its signal
// aborted and why. With `holdCleanup`, a cleanup's store open waits until the
// test releases it (or, with `releaseAfterMs`, until that long after the held
// open began), so a test decides when a cleanup may proceed. Every open is
// registered before it waits, so settled() waits for a held store too: its
// late open and its close.
// The bound each traced cleanup's signal was armed with, read from a spy on
// AbortSignal.timeout: the call whose result is the signal its store open got.
const armedWith = (timeouts, trace) => [...new Set(trace.cleanups().map(entry => timeouts.mock.calls.find(call => call.result === trace.signalOf(entry))?.arguments[0]))];
function storeTrace({ holdCleanup = false, releaseAfterMs } = {}) {
  const started = performance.now(), events = [], closed = [], signals = new Map();
  const at = () => Math.round(performance.now() - started);
  let release = () => {}, releasedAt, timer;
  const held = holdCleanup ? new Promise(resolve => { release = () => { releasedAt ??= at(); resolve(); }; }) : null;
  const openStore = async o => {
    const entry = { kind: o.lockTimeoutMs === undefined ? 'operation' : 'cleanup', at: at() };
    events.push(entry); signals.set(entry, o.signal);
    let done; closed.push(new Promise(resolve => { done = resolve; }));
    o.signal?.addEventListener('abort', () => { entry.aborted = { reason: o.signal.reason?.name ?? 'unknown', at: at() }; }, { once: true });
    try {
      if (held && entry.kind === 'cleanup') {
        if (releaseAfterMs !== undefined) timer ??= setTimeout(release, releaseAfterMs);
        await held;
      }
      const store = await createStorage(o), io = storeIo(store), run = io.run, close = store.close;
      entry.opened = at();
      io.run = (...args) => run.apply(io, args).then(value => { entry.run = 'ok'; return value; }, error => { entry.run = String(error?.code ?? error?.name ?? 'error'); throw error; });
      store.close = (...args) => { try { return close.apply(store, args); } finally { entry.closed = at(); done(); } };
      return store;
    } catch (error) { entry.openError = String(error?.code ?? error?.name ?? 'error'); done(); throw error; }
  };
  return { openStore, events, release: () => release(), releasedAt: () => releasedAt, settled: () => Promise.all(closed), cleanups: () => events.filter(entry => entry.kind === 'cleanup'), signalOf: entry => signals.get(entry) };
}
const usageCalls = async env => JSON.parse(await readFile(usageFile(env))).calls.length;
const workerErrors = data => { const g = createShadowGraph(); g.importData(data); return g.search('', { project: 'p' }).completeness.capture.workerErrors ?? []; };
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
  // A refusal belongs to the refused item: it is charged once, kept (raw, retention) and never claimed again,
  // and the drain goes on to other eligible work instead of stopping on it.
  const refusal = { status: 'blocked', blockedReason: 'provider_refusal', receipt: { invocationStarted: true } };
  test(`drain ${type}: a provider refusal is charged once, never claimed again, keeps its data and does not hold back later items`, skip, async t => {
    const f = await setup(t, type, 3); let calls = 0;
    const before = (await f.read()).records.filter(x => x.kind === 'capture');
    const executor = { extract: async () => (++calls === 1 ? refusal : f.response) };
    const out = await runExtractionDrain({ ...f.options, sleep: async () => {}, executor });
    assert.deepEqual([out.status, out.completed], ['idle', 2]);
    assert.equal(calls, 3); assert.equal(await usageCalls(f.options.env), 3);
    let data = await f.read(); let captures = data.records.filter(x => x.kind === 'capture');
    assert.deepEqual(captures.map(x => [x.state, x.blockedReason]), [['blocked', 'provider_refusal'], ['extracted', null], ['extracted', null]]);
    const refused = captures[0];
    assert.equal(refused.attempts, 1); assert.equal(refused.lastError, 'provider_refusal'); assert.equal(refused.cancelRequested, false);
    assert.equal(refused.contentRef, before[0].contentRef); assert.equal(refused.expiresAt, before[0].expiresAt);
    assert.ok((data.captureContent ?? []).some(entry => entry.contentRef === refused.contentRef), 'the refused raw stays under normal retention');
    assert.equal(data.records.filter(x => x.kind !== 'capture').length, 0, 'no record is written from a refusal');
    const settled = data.journal.filter(entry => entry.entityId === refused.id).at(-1);
    assert.deepEqual([settled.type, settled.payload.state, settled.payload.blockedReason], ['extraction.failed', 'blocked', 'provider_refusal']);
    assert.ok(workerErrors(data).some(x => x.reason === 'provider_refusal'), 'the status names the refusal after the drain');
    // A later drain spends nothing on it, and a clean drain clears the status.
    const again = await runExtractionDrain({ ...f.options, sleep: async () => {}, executor });
    assert.equal(again.status, 'idle'); assert.equal(calls, 3); assert.equal(await usageCalls(f.options.env), 3);
    data = await f.read(); captures = data.records.filter(x => x.kind === 'capture');
    assert.deepEqual([captures[0].state, captures[0].attempts], ['blocked', 1]);
    assert.ok(!workerErrors(data).some(x => x.reason === 'provider_refusal'));
  });
  // Review R2: a drain stopped between the refusal and its commit still settles the refusal on its item.
  test(`drain ${type}: a refusal held across a stopped drain is settled on its item and never sent again`, skip, async t => {
    const f = await setup(t, type, 2); let calls = 0;
    const executor = { extract: async () => (++calls === 1 ? refusal : f.response) };
    const stopped = await runExtractionDrain({ ...f.options, sleep: async () => {}, guard: async () => calls === 0, executor });
    assert.deepEqual([stopped.status, stopped.blockedReason, calls], ['blocked', 'drain_stopped', 1]);
    let captures = (await f.read()).records.filter(x => x.kind === 'capture');
    assert.deepEqual(captures.map(x => [x.state, x.blockedReason]), [['blocked', 'provider_refusal'], ['pending', null]]);
    const next = await runExtractionDrain({ ...f.options, sleep: async () => {}, executor });
    assert.deepEqual([next.status, next.completed, calls], ['idle', 1, 2]);
    captures = (await f.read()).records.filter(x => x.kind === 'capture');
    assert.deepEqual(captures.map(x => x.state), ['blocked', 'extracted']);
  });
  // Re-check N-B: a budget stop later in the same drain must not hide the refusal from the status.
  test(`drain ${type}: a refusal stays visible when the same drain later stops on a budget`, skip, async t => {
    const f = await setup(t, type, 5, { items: 4 }); let calls = 0;
    const out = await runExtractionDrain({ ...f.options, sleep: async () => {}, executor: { extract: async () => (++calls === 1 ? refusal : f.response) } });
    assert.deepEqual([out.status, out.blockedReason, calls], ['blocked', 'drain_items', 4]);
    const data = await f.read();
    assert.ok(workerErrors(data).some(x => x.reason === 'provider_refusal'), JSON.stringify(workerErrors(data)));
    assert.deepEqual(data.records.filter(x => x.kind === 'capture').map(x => x.state), ['blocked', 'extracted', 'extracted', 'extracted', 'pending']);
  });
  // Every other blocked response is unchanged: it ends the drain and leaves the item pending.
  test(`drain ${type}: an unknown_terminal response still ends the drain with the item pending`, skip, async t => {
    const f = await setup(t, type, 2); let calls = 0;
    const out = await runExtractionDrain({ ...f.options, sleep: async () => {}, executor: { extract: async () => { calls++; return { status: 'blocked', blockedReason: 'unknown_terminal', receipt: { invocationStarted: true } }; } } });
    assert.deepEqual([out.status, out.blockedReason, calls], ['blocked', 'unknown_terminal', 1]);
    assert.deepEqual((await f.read()).records.filter(x => x.kind === 'capture').map(x => [x.state, x.blockedReason]), [['pending', 'unknown_terminal'], ['pending', null]]);
  });
  test(`drain ${type}: a refusal in one project does not hold back another project's work in the same drain`, skip, async t => {
    const f = await setup(t, type, 1);
    const graph = createShadowGraph({ now: f.options.now }); graph.importData(await f.read());
    privilegedRecordCapture(graph, { project: 'q', originId: 'synthetic-origin', text: 'Synthetic observation in q.', admission, source: { event: 'UserPromptSubmit', sessionId: 'other-session' } });
    const store = await createStorage(f.options); await store.save(privilegedSnapshot(graph)); store.close();
    let calls = 0;
    const out = await runExtractionDrain({ ...f.options, scopes: [{ project: 'p' }, { project: 'q' }], sleep: async () => {}, executor: { extract: async () => (++calls === 1 ? refusal : f.response) } });
    assert.deepEqual([out.status, out.completed, calls], ['idle', 1, 2]);
    const captures = (await f.read()).records.filter(x => x.kind === 'capture');
    assert.deepEqual(captures.map(x => [x.project, x.state]), [['p', 'blocked'], ['q', 'extracted']]);
  });
  test(`drain ${type}: a second schema-invalid response persists failed once with two charged calls`, skip, async t => {
    const f = await setup(t, type); let calls = 0;
    await runExtractionDrain({ ...f.options, sleep: async () => {}, executor: { extract: async () => { calls++; return { status: 'schema_invalid' }; } } });
    const item = (await f.read()).records.find(x => x.kind === 'capture');
    assert.equal(calls, 2); assert.equal(item.state, 'failed'); assert.equal(item.lastError, 'schema_invalid'); assert.equal(item.attempts, 2);
    assert.equal(JSON.parse(await readFile(usageFile(f.options.env))).calls.length, 2);
  });
  // The success path: every cleanup completes. Its bound is raised through the
  // test-only seam so a slow runner cannot decide this test; the production
  // bound's enforcement has tests of its own below. Nothing but `blocked` with
  // the exact reason, receipt, usage and state passes.
  test(`drain ${type}: each budget blocks with pending work intact`, skip, async t => {
    for (const [budgets, reason, expectedCalls] of [[{ inputBytes: 1 }, 'input_bytes', 0], [{ journalEntriesPerSession: 1 }, 'session_journal', 0], [{ calls: 1 }, 'drain_calls', 1], [{ items: 1 }, 'drain_items', 1], [{ windowCalls: 1 }, 'window_calls', 1]]) {
      const f = await setup(t, type, 2, budgets), trace = storeTrace(); let calls = 0;
      const result = await runExtractionDrain({ ...f.options, openStore: trace.openStore, [CLEANUP_BOUND_FOR_TESTS]: 60_000, executor: { extract: async () => { calls++; return f.response; } } });
      await trace.settled();
      const why = `${JSON.stringify(budgets)} result ${JSON.stringify(result)} trace ${JSON.stringify(trace.events)}`;
      assert.deepEqual(result, { status: 'blocked', blockedReason: reason, completed: expectedCalls, storeReceiptWritten: true }, why);
      assert.equal(calls, expectedCalls, why); assert.equal(await usageCalls(f.options.env), expectedCalls, why);
      assert.ok(trace.cleanups().length >= 1 && trace.cleanups().every(entry => entry.run === 'ok' && !entry.aborted), why);
      const data = await f.read();
      assert.deepEqual(data.records.filter(x => x.kind === 'capture' && x.state === 'pending').map(x => x.id), f.items.slice(expectedCalls).map(x => x.id), why);
      assert.ok(data.records.every(x => x.kind !== 'capture' || x.lease === null), why);
      assert.ok(workerErrors(data).some(x => x.reason === reason), why);
    }
  });
  // A block's cleanup that cannot finish within the production bound (no seam):
  // its store open is held until the drain has answered, so the bound, not a
  // timer race, ends it. A failed cleanup, not a stop: the cleanup ran once, its
  // own signal timed out, no receipt was written, and the store it opened late
  // commits nothing. The claim it could not release keeps its 300 s lease; a
  // drain after that deadline reclaims it and records the unknown period, and
  // usage is never refunded.
  test(`drain ${type}: a block whose cleanup cannot finish in the production bound fails that cleanup once, commits nothing later, and is reclaimed after the lease`, { ...skip, timeout: 30_000 }, async t => {
    const f = await setup(t, type, 2, { calls: 1 }), trace = storeTrace({ holdCleanup: true }); let calls = 0;
    const extract = async () => { calls++; return f.response; };
    const result = await runExtractionDrain({ ...f.production, openStore: trace.openStore, executor: { extract } });
    const why = `result ${JSON.stringify(result)} trace ${JSON.stringify(trace.events)}`;
    assert.deepEqual(result, { status: 'unavailable', reason: 'worker_or_store_unavailable', completed: 1, storeReceiptWritten: false }, why);
    assert.equal(trace.cleanups().length, 1, why); assert.equal(trace.cleanups()[0].aborted?.reason, 'TimeoutError', why);
    assert.equal(calls, 1); assert.equal(await usageCalls(f.options.env), 1);
    const before = await f.read();
    trace.release(); await trace.settled();
    const [late] = trace.cleanups();
    assert.ok(late.opened !== undefined && late.closed !== undefined, `the held cleanup store opened late and was closed: ${JSON.stringify(late)}`);
    assert.equal(late.run, undefined, 'the cleanup store opened after the timeout ran no step');
    assert.deepEqual(await f.read(), before, 'nothing was committed after the timeout');
    const captures = before.records.filter(x => x.kind === 'capture');
    assert.deepEqual(captures.map(x => x.state), ['extracted', 'processing']);
    assert.equal(Date.parse(captures[1].lease.leaseExpiresAt) - Date.parse(START), 300_000);
    assert.ok(!workerErrors(before).some(x => ['drain_calls', 'drain_stopped'].includes(x.reason)), 'no receipt for the block');
    f.clock('2026-10-01T00:05:01.000Z');
    const later = await runExtractionDrain({ ...f.options, executor: { extract } });
    assert.equal(later.completed, 1); assert.equal(calls, 2); assert.equal(await usageCalls(f.options.env), 2);
    const after = await f.read();
    assert.deepEqual(after.records.filter(x => x.kind === 'capture').map(x => x.state), ['extracted', 'extracted']);
    assert.ok(after.captureSessions[0].gaps.some(x => x.reason === 'extraction_unknown_period'));
  });
  test(`drain ${type}: a stop whose cleanup cannot finish in the production bound is still a stop, with one cleanup, no receipt and nothing committed later`, { ...skip, timeout: 30_000 }, async t => {
    const f = await setup(t, type, 2), trace = storeTrace({ holdCleanup: true }); let calls = 0;
    const result = await runExtractionDrain({ ...f.production, openStore: trace.openStore, guard: async () => false, executor: { extract: async () => { calls++; return f.response; } } });
    const why = `result ${JSON.stringify(result)} trace ${JSON.stringify(trace.events)}`;
    assert.deepEqual(result, { status: 'blocked', blockedReason: 'drain_stopped', completed: 0, storeReceiptWritten: false }, why);
    assert.equal(trace.cleanups().length, 1, why); assert.equal(trace.cleanups()[0].aborted?.reason, 'TimeoutError', why);
    assert.equal(calls, 0); assert.equal(await usageCalls(f.options.env), 0);
    const before = await f.read();
    trace.release(); await trace.settled();
    const [late] = trace.cleanups();
    assert.ok(late.opened !== undefined && late.closed !== undefined, `the held cleanup store opened late and was closed: ${JSON.stringify(late)}`);
    assert.equal(late.run, undefined); assert.deepEqual(await f.read(), before);
    assert.deepEqual(before.records.filter(x => x.kind === 'capture').map(x => [x.state, x.lease]), [['pending', null], ['pending', null]]);
    assert.ok(!workerErrors(before).some(x => x.reason === 'drain_stopped'));
  });
  // The production bound is enforced on its own, whatever look-alike setting a
  // caller passes. The cleanup's store open is held and released 3 s after it
  // began; the cleanup's one-second timeout was armed before that open, so it
  // fires first whatever the runner's speed (timers fire in due order). A bound
  // above 3 s would let the released cleanup run and commit, which fails here;
  // one below 1 s fails the floor. The drain answers before the release.
  test(`drain ${type}: the production cleanup bound is enforced and no look-alike setting raises it`, { ...skip, timeout: 30_000 }, async t => {
    const f = await setup(t, type, 2, { calls: 1 }), trace = storeTrace({ holdCleanup: true, releaseAfterMs: 3000 });
    const timeouts = t.mock.method(AbortSignal, 'timeout');
    const decoys = { cleanupBoundForTests: 60_000, cleanupMs: 60_000, [String(CLEANUP_BOUND_FOR_TESTS)]: 60_000, env: { ...f.options.env, SHADOWGRAPH_EXTRACTION_CLEANUP_MS: '60000' } };
    const drainStarted = performance.now();
    const result = await runExtractionDrain({ ...f.production, ...decoys, openStore: trace.openStore, executor: { extract: async () => f.response } });
    const answeredMs = performance.now() - drainStarted, releasedBeforeAnswer = trace.releasedAt();
    await trace.settled();
    const [cleanup] = trace.cleanups(), why = JSON.stringify(trace.events);
    assert.deepEqual(result, { status: 'unavailable', reason: 'worker_or_store_unavailable', completed: 1, storeReceiptWritten: false }, why);
    assert.equal(releasedBeforeAnswer, undefined, 'the drain answered while its cleanup was still held');
    assert.equal(cleanup.aborted?.reason, 'TimeoutError', why);
    assert.ok(cleanup.aborted.at < trace.releasedAt() && cleanup.opened >= trace.releasedAt(), why);
    assert.equal(cleanup.run, undefined, why);
    assert.ok(answeredMs >= 1000, `answered after ${Math.round(answeredMs)} ms`);
    assert.deepEqual(armedWith(timeouts, trace), [1000], 'the cleanup signal is armed with exactly the production bound');
  });
  // The seam raises the bound of the drain that sets it and of no other: there a
  // cleanup held past one second completes and writes its receipt, while a later
  // drain without the seam still times its held cleanup out.
  test(`drain ${type}: the test-only seam raises the cleanup bound of the drain that sets it and of no other`, { ...skip, timeout: 30_000 }, async t => {
    const f = await setup(t, type, 2, { calls: 1 }), trace = storeTrace({ holdCleanup: true, releaseAfterMs: 1500 });
    const timeouts = t.mock.method(AbortSignal, 'timeout');
    const result = await runExtractionDrain({ ...f.options, openStore: trace.openStore, [CLEANUP_BOUND_FOR_TESTS]: 60_000, executor: { extract: async () => f.response } });
    await trace.settled();
    assert.deepEqual(armedWith(timeouts, trace), [60_000], 'the seamed cleanup signal is armed with the seam');
    assert.deepEqual(result, { status: 'blocked', blockedReason: 'drain_calls', completed: 1, storeReceiptWritten: true }, JSON.stringify(trace.events));
    assert.ok(trace.cleanups().every(entry => entry.run === 'ok' && !entry.aborted));
    const g = await setup(t, type, 2, { calls: 1 }), unseamed = storeTrace({ holdCleanup: true, releaseAfterMs: 3000 });
    const next = await runExtractionDrain({ ...g.production, openStore: unseamed.openStore, executor: { extract: async () => g.response } });
    await unseamed.settled();
    assert.deepEqual(next, { status: 'unavailable', reason: 'worker_or_store_unavailable', completed: 1, storeReceiptWritten: false }, JSON.stringify(unseamed.events));
    assert.equal(unseamed.cleanups()[0].aborted?.reason, 'TimeoutError');
    assert.deepEqual(armedWith(timeouts, unseamed), [1000], 'a later drain without the seam is armed with the production bound');
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
    // The restore runs on the fixtures' clock: on the real one, their capture
    // would pass its 7-day raw retention once that week had gone by.
    if (type === 'json') await restoreFile(backup, f.options.file, { now: f.options.now() });
    else { const s = await createStorage(f.options); try { await s.restore(backup, { now: f.options.now() }); } finally { s.close(); } }
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
  // The wall deadline is the drain's own timer, armed with its budget. The
  // executor never answers, and the test fires that timer itself once the call
  // has started (slow Windows CI runners outlasted a 1 s budget before it). The
  // budget is above this test's own timeout, so neither the timer nor the
  // budget's elapsed-time check can end the drain before the test does. The
  // timer must be armed with exactly that budget before the call, and a
  // response arriving after the stop opens no store and commits nothing.
  test(`drain ${type}: wall deadline bounds an unresponsive executor and prevents late commit`, { ...skip, timeout: 120_000 }, async t => {
    const wallMs = 200_000, f = await setup(t, type, 1, { wallMs }), trace = storeTrace();
    const realSetTimeout = globalThis.setTimeout; let resolveCall, called = false, armedBeforeCall = false, fireWall = null;
    t.mock.method(globalThis, 'setTimeout', (callback, ms, ...args) => {
      if (ms !== wallMs || fireWall) return realSetTimeout(callback, ms, ...args);
      const handle = realSetTimeout(() => {}, 2 ** 31 - 1);
      fireWall = () => { clearTimeout(handle); callback(...args); };
      return handle;
    });
    const result = await runExtractionDrain({ ...f.options, openStore: trace.openStore, executor: { extract: async () => {
      called = true; armedBeforeCall = fireWall !== null;
      if (armedBeforeCall) realSetTimeout(fireWall, 0);
      return new Promise(resolve => { resolveCall = resolve; });
    } } });
    assert.equal(called, true); assert.equal(armedBeforeCall, true, 'the wall timer was armed with exactly the configured budget before the call');
    assert.equal(result.status, 'blocked'); assert.equal(result.blockedReason, 'drain_stopped');
    const opened = trace.events.length;
    resolveCall(f.response); await new Promise(resolve => realSetTimeout(resolve, 2000));
    assert.equal(trace.events.length, opened, 'no store is opened after the drain stopped');
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
    // The deadline under test includes the production cleanup bound, so this
    // drain runs without the seam: a slow cleanup still answers within it.
    const f = await setup(t, type, 1, { wallMs: 50 }); let release, calls = 0;
    const pending = runExtractionDrain({ ...f.production, guard: () => new Promise(resolve => { release = resolve; }), executor: { extract: async () => { calls++; return f.response; } } });
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

for (const type of ['json', 'sqlite']) test(`drain registers each dedicated invocation before execution and preserves retry prompt identity (${type})`, backendSkip(type), async t => {
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

for (const type of ['json', 'sqlite']) test(`one automatic drain shares its call ceiling across distinct project queues (${type})`, backendSkip(type), async t => {
  const f = await setup(t, type, 1, { calls: 1 }); const graph = createShadowGraph({ now: f.options.now }); graph.importData(await f.read());
  const other = privilegedRecordCapture(graph, { project: 'q', originId: 'synthetic-origin', text: 'Other project observation.', admission, source: { event: 'UserPromptSubmit', sessionId: 'other-session' } });
  const store = await createStorage(f.options); await store.save(privilegedSnapshot(graph)); store.close(); let calls = 0;
  const out = await runExtractionDrain({ ...f.options, project: undefined, scopes: [{ project: 'p' }, { project: 'q' }], executor: { extract: async () => { calls++; return f.response; } } });
  assert.equal(calls, 1); assert.equal(out.completed, 1); assert.equal(out.blockedReason, 'drain_calls');
  const items = (await f.read()).records.filter(x => x.kind === 'capture');
  assert.equal(items.find(x => x.id === f.items[0].id).state, 'extracted'); assert.equal(items.find(x => x.id === other.id).state, 'pending');
});

// Only tests set the drain's cleanup bound: no production module names the
// seam, so no command line, request, environment, workspace or stored setting
// reaches it, and the production bound stays one second.
test('only tests name the drain cleanup seam; production keeps the one-second bound', async () => {
  const repo = new URL('../', import.meta.url), naming = [];
  const { files } = JSON.parse(await readFile(new URL('package.json', repo), 'utf8'));
  // Every file the package ships, not only src/.
  for (const entry of files) {
    const paths = entry.endsWith('/') ? (await readdir(new URL(entry, repo), { recursive: true })).map(name => entry + name.split(/[\\/]/u).join('/')) : [entry];
    for (const path of paths) if (/\.[cm]?js$/u.test(path) && (await readFile(new URL(path, repo), 'utf8')).includes('CLEANUP_BOUND_FOR_TESTS')) naming.push(path);
  }
  assert.deepEqual(naming, ['src/internal/extraction-worker.js']);
  assert.match(await readFile(new URL('src/internal/extraction-worker.js', repo), 'utf8'), /^const CLEANUP_BOUND_MS = 1000;$/mu);
});
