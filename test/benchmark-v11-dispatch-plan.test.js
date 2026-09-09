import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startProviderMeter } from '../benchmark/lib/provider-meter.mjs';
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

function providerResponse() {
  return JSON.stringify({ model: 'nomic-embed-text:v1.5', usage: { input_tokens: 1, total_tokens: 1 }, data: [] });
}

test('a dynamic dispatch plan is durable before send and aliases cannot be omitted, forged, or reused', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-dispatch-plan-');
  const ledgerPath = path.join(directory, 'provider.ndjson');
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
  assert.equal(upstreamCalls, 1);
});

test('a static dispatch plan is consumed by one send and cannot authorize replay', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-static-dispatch-plan-');
  const ledgerPath = path.join(directory, 'provider.ndjson');
  let upstreamCalls = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCalls += 1;
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
  assert.equal(records.filter((record) => record.event === 'dispatch_consumed').length, 1);
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
