import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startProviderMeter } from '../benchmark/lib/provider-meter.mjs';
import { reconcileProviderAttempts } from '../benchmark/lib/v11-budget.mjs';
import { runProviderReconciliation } from '../benchmark/lib/v11-provider-reconciler.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const CORRELATION = Object.freeze({
  runId: 'run-plan-1',
  attemptId: 'attempt-plan-1',
  armId: 'cognee',
  scenarioId: 'ACC_PLAN_1',
  repetition: 0,
  phase: 'A',
  requestClass: 'embedding',
  rootOperation: 'persist',
  rootInvocationId: 'root-persist-1',
  planSlot: 'root-embedding',
  identityMode: 'dynamic'
});

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function providerResponse(model = 'nomic-embed-text:v1.5') {
  return JSON.stringify({ model, usage: { input_tokens: 1, total_tokens: 1 }, data: [] });
}

test('a dynamic dispatch plan is durable before send and aliases cannot be omitted, forged, or reused', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-dispatch-plan-');
  const ledgerPath = path.join(directory, 'provider.ndjson');
  const budget = {
    schema: 'shadowgraph.v11.provider-budget', version: 1,
    authorizationRef: 'offline-dynamic-plan-test', runId: CORRELATION.runId, attemptId: CORRELATION.attemptId,
    implementationLockHash: 'a'.repeat(64), maxRetries: 0,
    limits: { outer_decision_llm: 1, internal_memory_llm: 1, embedding: 1 }
  };
  let upstreamCalls = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCalls += 1;
    assert.equal(request.headers['x-shadowgraph-dispatch-alias'], undefined, 'identity header must stay local');
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(providerResponse());
  });
  const meter = await startProviderMeter({
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: `${upstream}/v1`,
    upstreamAuthorization: null,
    ledgerPath,
    upstreamTimeoutMs: 5_000
  }, {
    budget,
    requireRootOperation: true,
    requireDispatchPlans: true,
    maxAttemptsPerRootRequestClass: 2
  });
  t.after(() => meter.close());

  const route = await meter.bindPlannedEndpoint(CORRELATION);
  assert.match(route.endpoint, /^http:\/\/127\.0\.0\.1:\d+\/provider-meter\/v1\/[a-f0-9]{48}$/u);
  assert.match(route.declareEndpoint, /\/__shadowgraph\/declare$/u);
  assert.match(route.closeEndpoint, /\/__shadowgraph\/close$/u);

  const missing = await fetch(`${route.endpoint}/embeddings`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text:v1.5', input: ['one'] })
  });
  assert.equal(missing.status, 403);
  assert.equal(upstreamCalls, 0);

  const declared = await fetch(route.declareEndpoint, { method: 'POST' });
  assert.equal(declared.status, 201);
  const identity = await declared.json();
  assert.match(identity.plannedDispatchId, /^[a-f0-9]{48}$/u);
  assert.match(identity.alias, /^[a-f0-9]{48}$/u);

  const plansBeforeSend = await readFile(`${ledgerPath}.plans.ndjson`, 'utf8');
  const planRecords = plansBeforeSend.trimEnd().split('\n').map((line) => JSON.parse(line));
  const rootPlan = planRecords.find((record) => record.event === 'root_plan');
  const dispatchPlan = planRecords.find((record) => record.event === 'dispatch_plan');
  assert.match(plansBeforeSend, /"event":"root_plan"/u);
  assert.match(plansBeforeSend, /"event":"dispatch_plan"/u);
  assert.equal(rootPlan.childRule, 'data-dependent-before-send');
  assert.equal(dispatchPlan.childRule, 'data-dependent-before-send');
  assert.equal(dispatchPlan.parentRootInvocationId, rootPlan.rootInvocationId);
  assert.equal(dispatchPlan.rootPlanSlot, rootPlan.planSlot);
  assert.ok(plansBeforeSend.endsWith('\n'));

  const forged = await fetch(`${route.endpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shadowgraph-dispatch-alias': 'f'.repeat(48) },
    body: JSON.stringify({ model: 'nomic-embed-text:v1.5', input: ['one'] })
  });
  assert.equal(forged.status, 403);
  assert.equal(upstreamCalls, 0);

  const accepted = await fetch(`${route.endpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shadowgraph-dispatch-alias': identity.alias },
    body: JSON.stringify({ model: 'nomic-embed-text:v1.5', input: ['one'] })
  });
  assert.equal(accepted.status, 200);
  assert.equal(upstreamCalls, 1);

  const closed = await fetch(route.closeEndpoint, {
    method: 'POST', headers: { 'x-shadowgraph-dispatch-alias': identity.alias }
  });
  assert.equal(closed.status, 204);

  const reused = await fetch(`${route.endpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shadowgraph-dispatch-alias': identity.alias },
    body: JSON.stringify({ model: 'nomic-embed-text:v1.5', input: ['one'] })
  });
  assert.equal(reused.status, 403);
  const duplicateClose = await fetch(route.closeEndpoint, {
    method: 'POST', headers: { 'x-shadowgraph-dispatch-alias': identity.alias }
  });
  assert.equal(duplicateClose.status, 403);
  const crossRoute = await meter.bindPlannedEndpoint({
    ...CORRELATION,
    rootInvocationId: 'root-persist-cross',
    planSlot: 'root-embedding-cross'
  });
  const crossBinding = await fetch(`${crossRoute.endpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shadowgraph-dispatch-alias': identity.alias },
    body: JSON.stringify({ model: 'nomic-embed-text:v1.5', input: ['one'] })
  });
  assert.equal(crossBinding.status, 403);
  assert.equal(upstreamCalls, 1);

  const finalPlanRecords = (await readFile(`${ledgerPath}.plans.ndjson`, 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line));
  const boundDenials = finalPlanRecords.filter((record) => record.event === 'dispatch_denied'
    && record.code === 'INVALID_OR_REUSED_DISPATCH_ALIAS');
  const unknownDenial = finalPlanRecords.find((record) => record.event === 'dispatch_denied'
    && record.code === 'UNKNOWN_DISPATCH_ALIAS');
  const crossDenial = finalPlanRecords.find((record) => record.event === 'dispatch_denied'
    && record.code === 'INVALID_DISPATCH_ALIAS_BINDING');
  const crossRootPlan = finalPlanRecords.find((record) => record.event === 'root_plan'
    && record.rootInvocationId === 'root-persist-cross');
  assert.equal(boundDenials.length, 2);
  for (const denial of boundDenials) assert.deepEqual(denial, {
    schema: 'shadowgraph.provider-meter.plan',
    version: 1,
    recordedAt: denial.recordedAt,
    event: 'dispatch_denied',
    code: 'INVALID_OR_REUSED_DISPATCH_ALIAS',
    rootInvocationId: dispatchPlan.rootInvocationId,
    rootPlanSlot: rootPlan.planSlot,
    planSlot: dispatchPlan.planSlot,
    correlation: dispatchPlan.correlation,
    plannedDispatchId: dispatchPlan.plannedDispatchId,
    alias: dispatchPlan.alias,
    disposition: dispatchPlan.disposition
  });
  assert.deepEqual(unknownDenial, {
    schema: 'shadowgraph.provider-meter.plan',
    version: 1,
    recordedAt: unknownDenial.recordedAt,
    event: 'dispatch_denied',
    code: 'UNKNOWN_DISPATCH_ALIAS',
    rootInvocationId: rootPlan.rootInvocationId,
    rootPlanSlot: rootPlan.planSlot,
    planSlot: null,
    correlation: rootPlan.correlation,
    plannedDispatchId: null,
    alias: null,
    disposition: null
  });
  assert.deepEqual(crossDenial, {
    schema: 'shadowgraph.provider-meter.plan',
    version: 1,
    recordedAt: crossDenial.recordedAt,
    event: 'dispatch_denied',
    code: 'INVALID_DISPATCH_ALIAS_BINDING',
    rootInvocationId: crossRootPlan.rootInvocationId,
    rootPlanSlot: crossRootPlan.planSlot,
    planSlot: null,
    correlation: crossRootPlan.correlation,
    plannedDispatchId: null,
    alias: null,
    disposition: null
  });

  const events = (await readFile(ledgerPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  const attemptLedger = await readFile(`${ledgerPath}.attempts.ndjson`, 'utf8');
  const attemptReconciliation = reconcileProviderAttempts({ text: attemptLedger, events });
  assert.equal(attemptReconciliation.status, 'RECONCILED');
  assert.deepEqual(attemptReconciliation.findings, []);
});

test('a static dispatch plan is consumed by one send and cannot authorize replay', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-static-dispatch-plan-');
  const ledgerPath = path.join(directory, 'provider.ndjson');
  let upstreamCalls = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCalls += 1;
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(providerResponse('qwen2.5:7b'));
  });
  const meter = await startProviderMeter({
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: `${upstream}/v1`,
    upstreamAuthorization: null,
    ledgerPath,
    upstreamTimeoutMs: 5_000
  }, {
    requireRootOperation: true,
    requireDispatchPlans: true,
    maxAttemptsPerRootRequestClass: 2
  });
  t.after(() => meter.close());
  const route = await meter.bindPlannedEndpoint({
    ...CORRELATION,
    rootInvocationId: 'root-static-1',
    planSlot: 'outer-decision',
    identityMode: 'static',
    requestClass: 'internal_memory_llm',
    rootOperation: 'outer-decision'
  });

  const staticPlanBeforeRequests = (await readFile(`${ledgerPath}.plans.ndjson`, 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line))
    .find((record) => record.event === 'dispatch_plan');
  assert.ok(staticPlanBeforeRequests);

  const aliasForbidden = await fetch(`${route.endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shadowgraph-dispatch-alias': 'f'.repeat(48) },
    body: JSON.stringify({ model: 'qwen2.5:7b', messages: [] })
  });
  assert.equal(aliasForbidden.status, 403);
  const closeForbidden = await fetch(route.closeEndpoint, {
    method: 'POST', headers: { 'x-shadowgraph-dispatch-alias': staticPlanBeforeRequests.alias }
  });
  assert.equal(closeForbidden.status, 403);

  const first = await fetch(`${route.endpoint}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen2.5:7b', messages: [] })
  });
  assert.equal(first.status, 200);
  const replay = await fetch(`${route.endpoint}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'qwen2.5:7b', messages: [] })
  });
  assert.equal(replay.status, 403);
  assert.equal(upstreamCalls, 1);

  const records = (await readFile(`${ledgerPath}.plans.ndjson`, 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line));
  const staticPlan = records.find((record) => record.event === 'dispatch_plan');
  const denials = records.filter((record) => record.event === 'dispatch_denied');
  assert.equal(records.filter((record) => record.event === 'dispatch_closed').length, 0);
  assert.equal(records.filter((record) => record.event === 'dispatch_consumed').length, 1);
  assert.deepEqual(denials.map((denial) => ({
    code: denial.code,
    plannedDispatchId: denial.plannedDispatchId,
    alias: denial.alias,
    rootInvocationId: denial.rootInvocationId,
    rootPlanSlot: denial.rootPlanSlot,
    planSlot: denial.planSlot,
    disposition: denial.disposition,
    correlation: denial.correlation
  })), [
    'STATIC_ALIAS_FORBIDDEN',
    'INVALID_DISPATCH_CLOSE',
    'INVALID_OR_REUSED_DISPATCH_ALIAS'
  ].map((code) => ({
    code,
    plannedDispatchId: staticPlan?.plannedDispatchId,
    alias: staticPlan?.alias,
    rootInvocationId: staticPlan?.rootInvocationId,
    rootPlanSlot: staticPlan?.planSlot,
    planSlot: staticPlan?.planSlot,
    disposition: 'root-initial',
    correlation: staticPlan?.correlation
  })));
  const providerLedger = await readFile(ledgerPath, 'utf8');
  const reconciliation = runProviderReconciliation({
    ledgerText: providerLedger,
    ledgerPath: 'provider.ndjson',
    planLedgerText: await readFile(`${ledgerPath}.plans.ndjson`, 'utf8'),
    requireDispatchPlans: true,
    raw: {
      implementationLockHash: 'a'.repeat(64),
      units: [{
        unitId: 'static-plan-unit', runId: CORRELATION.runId, attemptId: CORRELATION.attemptId,
        armId: 'cognee', scenarioId: CORRELATION.scenarioId, repetition: 0, phase: 'A', status: 'MEASURED',
        operations: {
          memoryReadOperations: 0, memoryWriteOperations: 0, mcpToolCalls: 0,
          outerDecisionModelCalls: 0, internalMemoryModelCalls: 1, embeddingCalls: 0,
          persistenceVerificationOperations: 0
        }
      }]
    },
    attemptId: CORRELATION.attemptId,
    pinnedModels: {
      internal_memory_llm: { modelId: 'qwen2.5:7b' },
      embedding: { modelId: 'nomic-embed-text:v1.5' }
    }
  });
  assert.equal(reconciliation.status, 'RECONCILED', JSON.stringify(reconciliation.findings));
  assert.deepEqual(reconciliation.findings, []);
});

test('campaign reservation is joined to the planned dispatch before upstream send', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-campaign-dispatch-');
  const ledgerPath = path.join(directory, 'provider.ndjson');
  const reservations = [];
  const upstream = await listen(t, async (request, response) => {
    assert.equal(reservations.length, 1, 'campaign reservation must precede upstream send');
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(providerResponse());
  });
  const meter = await startProviderMeter({
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: `${upstream}/v1`,
    upstreamAuthorization: null,
    ledgerPath,
    upstreamTimeoutMs: 5_000
  }, {
    requireRootOperation: true,
    requireDispatchPlans: true,
    campaignReserve: async (reservation) => {
      reservations.push(reservation);
      return { reservationId: 'offline-only:1' };
    }
  });
  t.after(() => meter.close());
  const route = await meter.bindPlannedEndpoint(CORRELATION);
  const declared = await fetch(route.declareEndpoint, { method: 'POST' });
  const identity = await declared.json();
  const response = await fetch(`${route.endpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-shadowgraph-dispatch-alias': identity.alias },
    body: JSON.stringify({ model: 'nomic-embed-text:v1.5', input: ['one'] })
  });
  assert.equal(response.status, 200);
  const closed = await fetch(route.closeEndpoint, {
    method: 'POST', headers: { 'x-shadowgraph-dispatch-alias': identity.alias }
  });
  assert.equal(closed.status, 204);

  assert.deepEqual(reservations, [{
    requestClass: 'embedding', runId: 'run-plan-1', attemptId: 'attempt-plan-1', armId: 'cognee',
    scenarioId: 'ACC_PLAN_1', repetition: 0, phase: 'A', rootOperation: 'persist',
    rootInvocationId: 'root-persist-1', plannedDispatchId: identity.plannedDispatchId,
    planSlot: 'root-embedding:child:1', disposition: 'data-dependent-child'
  }]);
  const events = (await readFile(ledgerPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(events[0].campaignReservationId, 'offline-only:1');
});
