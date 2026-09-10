import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { validateProviderBudget } from '../benchmark/lib/v11-budget.mjs';
import * as budgetModule from '../benchmark/lib/v11-budget.mjs';
import { reconcileProviderEvidence, runProviderReconciliation } from '../benchmark/lib/v11-provider-reconciler.mjs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { computeV11Readiness } from '../benchmark/lib/v11-run.mjs';
import { bindV11Runtime } from '../benchmark/lib/v11-runtime-binding.mjs';
import { loadV11AcceptanceDefinition } from '../benchmark/lib/v11-definition.mjs';
import { createV11Registry } from '../benchmark/lib/v11-registry.mjs';
import { createServer } from 'node:http';
import { startProviderMeter } from '../benchmark/lib/provider-meter.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const benchmarkRoot = path.join(root, 'benchmark');

export function fixtureBudget(overrides = {}) {
  // Offline fixture authorization only; never an operational budget proposal.
  return {
    schema: 'shadowgraph.v11.provider-budget', version: 1,
    authorizationRef: 'offline-test-only', runId: 'budget-test', attemptId: 'budget-test-1',
    implementationLockHash: 'a'.repeat(64), maxRetries: 0,
    limits: { outer_decision_llm: 2, internal_memory_llm: 2, embedding: 2 },
    ...overrides
  };
}

async function candidate() {
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: root });
  const competitorLock = JSON.parse(await readFile(path.join(benchmarkRoot, 'competitors.lock.json'), 'utf8'));
  return { ...loaded, benchmarkRoot, registry: createV11Registry({ competitorLock, containerImage: competitorLock.pythonImage }) };
}

test('missing provider authorization is an explicit readiness blocker', async () => {
  const result = await computeV11Readiness(await candidate());
  assert.ok(result.blockers.some((b) => b.code === 'PROVIDER_BUDGET_REQUIRED'));
});

test('unresolved budget refuses before runtime discovery or any resource construction', async () => {
  const calls = [];
  const injections = Object.fromEntries(['readFile', 'mkdir', 'startProviderMeter', 'createProgressLedger',
    'createUnitEvidenceLedger', 'observeEnvironment', 'createImplementationLock', 'readPythonSiteDistributions']
    .map((name) => [name, () => { calls.push(name); throw new Error('must not dispatch'); }]));
  await assert.rejects(bindV11Runtime({ platform: 'linux' }, injections),
    (error) => error.code === 'PROVIDER_BUDGET_REQUIRED');
  assert.deepEqual(calls, []);
});

test('concurrent attempts reserve a finite ceiling before dispatch and retain denied failures', async (t) => {
  const dir = await scratchDirectory(t, 'budget-meter-offline-');
  let received = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    received += 1;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture-model', usage: { total_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const ledgerPath = path.join(dir, 'provider.ndjson');
  const meter = await startProviderMeter({
    listenerUrl: 'http://127.0.0.1:0', upstreamBaseUrl: `http://127.0.0.1:${server.address().port}/v1`,
    upstreamAuthorization: null, ledgerPath, upstreamTimeoutMs: 1000
  }, { budget: fixtureBudget({ limits: { outer_decision_llm: 1, internal_memory_llm: 2, embedding: 2 } }) });
  t.after(() => meter.close());
  const url = meter.bindEndpoint({ runId: 'budget-test', attemptId: 'budget-test-1', armId: 'no-memory',
    scenarioId: 'fixture', repetition: 0, phase: 'A', requestClass: 'outer_decision_llm' });
  const send = () => fetch(`${url}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"model":"fixture-model"}'
  }).then(async (r) => { await r.text(); return r.status; });
  const statuses = await Promise.all([send(), send()]);
  assert.deepEqual(statuses.sort(), [200, 403]);
  assert.equal(received, 1, 'only the admitted slot reaches the offline upstream');
  await meter.close();
  const events = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 2);
  assert.equal(events.filter((e) => e.outcome === 'FAILED' && e.failure.code === 'PROVIDER_BUDGET_EXHAUSTED').length, 1);
  const audit = (await readFile(`${ledgerPath}.attempts.ndjson`, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(audit.filter((e) => e.event === 'admission' && e.admitted).length, 1);
  assert.equal(audit.filter((e) => e.event === 'admission' && !e.admitted).length, 1);
  assert.equal(audit.filter((e) => e.event === 'dispatch_intent').length, 1);
  assert.equal(audit.filter((e) => e.event === 'completion').length, 2);
  assert.deepEqual(audit[0].budget.limits, { outer_decision_llm: 1, internal_memory_llm: 2, embedding: 2 });
  const reconciled = budgetModule.reconcileProviderAttempts({ text: audit.map(JSON.stringify).join('\n') + '\n', events });
  assert.equal(reconciled.status, 'BLOCKED');
  assert.deepEqual(reconciled.counts.outer_decision_llm, {
    admitted: 1, denied: 1, dispatchIntents: 1, completed: 2, succeeded: 1, failed: 1, incomplete: 0
  });
  const ordinary = reconcileProviderEvidence({ events, expectations: [{
    ...events[0], expectedCalls: 1
  }] });
  assert.equal(ordinary.status, 'DISCREPANT');
  assert.ok(ordinary.findings.some((f) => f.code === 'FAILED_OUTCOME'));
  assert.ok(ordinary.findings.some((f) => f.code === 'RETRY_OBSERVED'));
});

test('CLI consumes the explicit budget while other prerequisites still forbid all writes', async (t) => {
  const dir = await scratchDirectory(t, 'budget-cli-offline-');
  const budgetPath = path.join(dir, 'budget.json');
  await writeFile(budgetPath, JSON.stringify(fixtureBudget()));
  const cli = promisify(execFile);
  for (const command of ['v11-preflight', 'v11-run']) {
    let result;
    try {
      result = await cli(process.execPath, [path.join(benchmarkRoot, 'cli.mjs'), command,
        '--provider-budget', budgetPath, '--run-id', 'budget-test', '--attempt-id', 'budget-test-1', '--out', path.join(dir, 'out')]);
    } catch (error) { result = error; }
    assert.equal(result.code, 1);
    const report = JSON.parse(result.stdout);
    const readiness = command === 'v11-run' ? report.readiness : report;
    assert.equal(readiness.readiness, 'NOT READY');
    assert.deepEqual(readiness.blockers.filter((b) => b.kind === 'operational-budget'), []);
    assert.deepEqual(readiness.providerBudget, fixtureBudget());
  }
  assert.deepEqual(await readdir(dir), ['budget.json']);
});

test('a new authorized run cannot reconcile without its write-ahead attempt ledger', () => {
  const result = runProviderReconciliation({ ledgerText: '', ledgerPath: 'offline.ndjson',
    raw: { runId: 'budget-test', units: [] }, attemptId: 'budget-test-1', providerBudget: fixtureBudget(),
    pinnedModels: { internal_memory_llm: { modelId: 'fixture' }, embedding: { modelId: 'fixture-embed' } } });
  assert.equal(result.status, 'DISCREPANT');
  assert.equal(result.budgetEvidence.status, 'BLOCKED');
});

test('failed upstream calls consume the ceiling and the meter never retries them', async (t) => {
  const dir = await scratchDirectory(t, 'budget-failed-offline-');
  let received = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    received += 1; res.statusCode = 500; res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const ledgerPath = path.join(dir, 'provider.ndjson');
  const budget = fixtureBudget({ limits: { outer_decision_llm: 1, internal_memory_llm: 1, embedding: 1 } });
  const meter = await startProviderMeter({ listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, upstreamAuthorization: null,
    ledgerPath, upstreamTimeoutMs: 1000 }, { budget });
  t.after(() => meter.close());
  const c = { runId: budget.runId, attemptId: budget.attemptId, armId: 'cognee', scenarioId: 'fixture',
    repetition: 0, phase: 'A', requestClass: 'internal_memory_llm' };
  assert.throws(() => meter.bindEndpoint({ ...c, attemptId: 'different' }), /attemptId/u);
  const url = meter.bindEndpoint(c);
  const send = async (endpoint, resource) => {
    const r = await fetch(`${endpoint}/${resource}`, { method: 'POST', body: '{"model":"fixture"}' });
    await r.text(); return r.status;
  };
  assert.equal(await send(url, 'chat/completions'), 500);
  assert.equal(received, 1, 'no automatic upstream retry');
  assert.equal(await send(url, 'chat/completions'), 403, 'failed slot was not refunded');
  const other = meter.bindEndpoint({ ...c, requestClass: 'embedding' });
  assert.equal(await send(other, 'embeddings'), 403, 'budget stop latches across classes');
  assert.equal(received, 1);
  await meter.close();
  const events = (await readFile(ledgerPath, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(events.length, 3);
  assert.ok(events.every((e) => e.outcome === 'FAILED'));
});

test('write-ahead evidence distinguishes complete, incomplete, malformed and misbound attempts', () => {
  const budget = fixtureBudget();
  const correlation = { runId: budget.runId, attemptId: budget.attemptId, armId: 'cognee', scenarioId: 'fixture',
    repetition: 0, phase: 'A', requestClass: 'embedding' };
  const wrap = (row) => ({ schema: 'shadowgraph.provider-meter.attempt', version: 1,
    recordedAt: '2026-09-07T00:00:00.000Z', ...row });
  const encode = (rows) => rows.map((r) => JSON.stringify(wrap(r))).join('\n') + '\n';
  const rows = [{ event: 'authorization', budget }, { event: 'admission', attemptNumber: 1, correlation, admitted: true },
    { event: 'dispatch_intent', attemptNumber: 1 }];
  const incomplete = budgetModule.reconcileProviderAttempts({ text: encode(rows), events: [] });
  assert.equal(incomplete.status, 'BLOCKED');
  assert.equal(incomplete.counts.embedding.incomplete, 1);
  assert.equal(incomplete.counts.embedding.completed, 0);
  const event = { ...correlation, requestNumber: 1, outcome: 'SUCCEEDED' };
  const completed = [...rows, { event: 'completion', attemptNumber: 1, requestNumber: 1, outcome: 'SUCCEEDED' }];
  const run = (text, events = [event], expectedBudget = budget) => budgetModule.reconcileProviderAttempts({ text, events, expectedBudget });
  assert.equal(run(encode(completed)).status, 'RECONCILED');
  // Independent review P2: absent identity fields must not act as wildcards.
  for (const key of ['runId', 'attemptId']) {
    const forged = structuredClone(completed);
    delete forged[1].correlation[key];
    const mismatched = { ...event, [key]: 'different' };
    assert.equal(run(encode(forged), [mismatched]).status, 'BLOCKED', key);
  }
  for (const text of [null, '', '{', encode(completed).trimEnd(), encode([...completed, completed.at(-1)]),
    encode([...rows, { event: 'completion', attemptNumber: 1, requestNumber: 2, outcome: 'SUCCEEDED' }])]) {
    assert.equal(run(text).status, 'BLOCKED');
  }
  assert.equal(run(encode(completed), [{ ...event, armId: 'other' }]).status, 'BLOCKED');
  assert.equal(run(encode(completed), [event], fixtureBudget({ limits: { outer_decision_llm: 0, internal_memory_llm: 0, embedding: 0 } })).status, 'BLOCKED');
});

test('plan-bound write-ahead admissions must match the exact completion and campaign identity', () => {
  const budget = fixtureBudget();
  const correlation = {
    runId: budget.runId,
    attemptId: budget.attemptId,
    armId: 'cognee',
    scenarioId: 'planned-fixture',
    repetition: 0,
    phase: 'A',
    requestClass: 'embedding',
    rootOperation: 'persist',
    rootInvocationId: 'planned-root',
    plannedDispatchId: 'a'.repeat(48),
    planSlot: 'planned-root:child:1',
    dispatchAlias: 'b'.repeat(48),
    disposition: 'data-dependent-child'
  };
  const event = {
    ...correlation,
    requestNumber: 1,
    outcome: 'SUCCEEDED',
    campaignReservationId: 'offline-test-only:1'
  };
  const wrap = (row) => ({
    schema: 'shadowgraph.provider-meter.attempt',
    version: 1,
    recordedAt: '2026-09-10T00:00:00.000Z',
    ...row
  });
  const encode = (rows) => rows.map((row) => JSON.stringify(wrap(row))).join('\n') + '\n';
  const admission = {
    event: 'admission',
    attemptNumber: 1,
    correlation,
    admitted: true,
    authorizationRef: budget.authorizationRef,
    campaignReservationId: event.campaignReservationId
  };
  const complete = [
    { event: 'authorization', budget },
    admission,
    { event: 'dispatch_intent', attemptNumber: 1 },
    { event: 'completion', attemptNumber: 1, requestNumber: 1, outcome: 'SUCCEEDED' }
  ];
  assert.equal(budgetModule.reconcileProviderAttempts({ text: encode(complete), events: [event], expectedBudget: budget }).status, 'RECONCILED');
  for (const [field, forged] of Object.entries({
    plannedDispatchId: 'c'.repeat(48),
    dispatchAlias: 'd'.repeat(48),
    disposition: 'recovery',
    campaignReservationId: 'offline-test-only:999'
  })) {
    const forgedAdmission = structuredClone(admission);
    if (field === 'campaignReservationId') forgedAdmission[field] = forged;
    else forgedAdmission.correlation[field] = forged;
    const rows = [complete[0], forgedAdmission, complete[2], complete[3]];
    assert.equal(
      budgetModule.reconcileProviderAttempts({ text: encode(rows), events: [event], expectedBudget: budget }).status,
      'BLOCKED',
      field
    );
  }
});

test('native-cap denial completes an audit without masquerading as a provider-budget denial', () => {
  const budget = fixtureBudget({ limits: { outer_decision_llm: 0, internal_memory_llm: 0, embedding: 1 } });
  const correlation = {
    runId: budget.runId,
    attemptId: budget.attemptId,
    armId: 'cognee',
    scenarioId: 'native-cap',
    repetition: 0,
    phase: 'probe',
    requestClass: 'embedding',
    rootOperation: 'persist',
    rootInvocationId: 'native-cap-root',
    plannedDispatchId: 'a'.repeat(48),
    planSlot: 'native-cap-root',
    dispatchAlias: 'b'.repeat(48),
    disposition: 'root-initial',
    identityMode: 'static',
    staticDispatchPlan: { opaque: true }
  };
  const event = {
    runId: budget.runId,
    attemptId: budget.attemptId,
    armId: 'cognee',
    scenarioId: 'native-cap',
    repetition: 0,
    phase: 'probe',
    requestClass: 'embedding',
    rootOperation: 'persist',
    rootInvocationId: 'native-cap-root',
    plannedDispatchId: 'a'.repeat(48),
    planSlot: 'native-cap-root',
    dispatchAlias: 'b'.repeat(48),
    disposition: 'root-initial',
    requestNumber: 1,
    outcome: 'FAILED',
    failure: { code: 'NATIVE_ATTEMPT_CAP_EXHAUSTED' }
  };
  const row = (value) => ({
    schema: 'shadowgraph.provider-meter.attempt', version: 1,
    recordedAt: '2026-09-09T00:00:00.000Z', ...value
  });
  const text = [
    row({ event: 'authorization', budget }),
    row({ event: 'admission', attemptNumber: 1, correlation, admitted: false,
      authorizationRef: budget.authorizationRef, campaignReservationId: null }),
    row({ event: 'completion', attemptNumber: 1, requestNumber: 1, outcome: 'FAILED' })
  ].map(JSON.stringify).join('\n') + '\n';
  const result = budgetModule.reconcileProviderAttempts({ text, events: [event], expectedBudget: budget });
  assert.equal(result.status, 'RECONCILED');
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.counts.embedding, {
    admitted: 0, denied: 1, dispatchIntents: 0, completed: 1, succeeded: 0, failed: 1, incomplete: 0
  });
});

test('concurrent completion-write failure blocks dispatch after audit await', async (t) => {
  const directory = await scratchDirectory(t, 'v11-budget-audit-race-');
  const ledger = path.join(directory, 'completion.ndjson');
  let releaseAudit;
  const auditPaused = new Promise((resolve) => { releaseAudit = resolve; });
  let reachedAudit;
  const atAudit = new Promise((resolve) => { reachedAudit = resolve; });
  let firstUpstream;
  const atFirstUpstream = new Promise((resolve) => { firstUpstream = resolve; });
  const responseBody = JSON.stringify({ model: 'fixture-model', usage: {}, choices: [] });
  let upstreamCalls = 0;
  let firstResponse;
  const upstream = createServer((req, res) => {
    upstreamCalls += 1;
    req.resume();
    res.setHeader('content-type', 'application/json');
    if (upstreamCalls === 1) { firstResponse = res; firstUpstream(); }
    else res.end(responseBody);
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const originalOpen = fs.promises.open;
  let completionFailure = false;
  let meter;
  t.after(async () => {
    releaseAudit();
    fs.promises.open = originalOpen; syncBuiltinESMExports();
    firstResponse?.end(responseBody);
    await meter?.close().catch(() => {});
    await new Promise((resolve) => { upstream.close(resolve); upstream.closeAllConnections(); });
  });
  fs.promises.open = async (file, ...args) => {
    const handle = await originalOpen(file, ...args);
    if (file !== `${ledger}.attempts.ndjson` && file !== ledger) return handle;
    let entry;
    return {
      async write(data) {
        if (file === ledger && completionFailure) throw new Error('fixture completion-write failure');
        entry = JSON.parse(data); return handle.write(data);
      },
      async sync() {
        if (entry.event === 'dispatch_intent' && entry.attemptNumber === 2) {
          reachedAudit(); await auditPaused;
        }
        return handle.sync();
      },
      close: () => handle.close()
    };
  };
  syncBuiltinESMExports();
  const budget = fixtureBudget({ limits: { outer_decision_llm: 2, internal_memory_llm: 1, embedding: 1 } });
  meter = await startProviderMeter({
    listenerUrl: 'http://127.0.0.1:0', upstreamAuthorization: null,
    upstreamBaseUrl: `http://127.0.0.1:${upstream.address().port}/v1`, ledgerPath: ledger, upstreamTimeoutMs: 5000
  }, { budget });
  const base = { runId: budget.runId, attemptId: budget.attemptId, armId: 'no-memory',
    scenarioId: 'ACC_INCIDENT_HANDOFF', repetition: 0, phase: 'A', requestClass: 'outer_decision_llm' };
  const a = meter.bindEndpoint(base);
  const b = meter.bindEndpoint({ ...base, phase: 'B' });
  const send = (route) => fetch(`${route}/chat/completions`, { method: 'POST',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'fixture-model' }) });
  const first = send(a);
  await atFirstUpstream;
  const second = send(b);
  await atAudit;
  // Deterministic failure while B's dispatch-intent sync is paused.
  completionFailure = true;
  firstResponse.end(responseBody);
  const firstResult = await first; await firstResult.text();
  assert.equal(firstResult.status, 502); // Existing meter evidence-failure response.
  releaseAudit();
  const secondResult = await second; await secondResult.text();
  assert.equal(secondResult.status, 502);
  assert.equal(upstreamCalls, 1);
  await assert.rejects(meter.close(), /fixture completion-write failure/iu);
});

test('budgets reject non-finite limits, omissions, retries and mismatched identities', () => {
  for (const value of [null, {}, fixtureBudget({ implementationLockHash: ['a'.repeat(64)] }), fixtureBudget({ maxRetries: 1 }),
    ...[null, Infinity, NaN, -1, 0.1, '2'].map((embedding) => fixtureBudget({
      limits: { outer_decision_llm: 1, internal_memory_llm: 1, embedding }
    }))]) assert.throws(() => validateProviderBudget(value), /budget/iu);
  assert.throws(() => validateProviderBudget(fixtureBudget(), { runId: 'different' }), /runId/u);
  const original = fixtureBudget();
  const accepted = validateProviderBudget(original);
  original.limits.embedding = 100;
  assert.equal(accepted.limits.embedding, 2, 'caller mutation cannot raise the accepted cap');
});
