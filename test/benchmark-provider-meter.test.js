import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { requestOuterDecision, STANDARD_DECISION_RESPONSE_SCHEMA } from '../benchmark/lib/outer-model.mjs';
import { startProviderMeter } from '../benchmark/lib/provider-meter.mjs';

const EVENT_FIELDS = [
  'schema',
  'version',
  'event',
  'requestNumber',
  'runId',
  'attemptId',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'requestClass',
  'requestedModel',
  'providerModel',
  'latencyMs',
  'outcome',
  'failure',
  'httpStatus',
  'usage'
];

const BASE_CORRELATION = Object.freeze({
  runId: 'run-meter-1',
  attemptId: 'attempt-meter-1',
  armId: 'shadowgraph-full',
  scenarioId: 'S01_DATABASE',
  repetition: 0,
  phase: 'A',
  requestClass: 'outer_decision_llm'
});

const CLIENT_SECRET = 'client-authorization-secret-9f4d';
const UPSTREAM_SECRET = 'upstream-provider-secret-67a2';

function decision() {
  return {
    decisionId: 'decision-1',
    choiceId: 'option-a',
    recalledAlternativeIds: [],
    recalledRejectionReasonIds: [],
    constraintIdsAddressed: [],
    evidenceIdsCited: [],
    riskIdsRecognized: [],
    reviewTriggerIds: [],
    changedFactDetected: null,
    changedFactId: null,
    recommendation: 'Use option A.',
    failedAttemptIdsAvoided: [],
    failedAttemptReasonIdsCited: [],
    memoryProjectId: null,
    memoryUserId: null
  };
}

function outerRequest() {
  return {
    system: 'Return a benchmark decision.',
    prompt: 'Choose among the supplied options.',
    responseSchema: { ...STANDARD_DECISION_RESPONSE_SCHEMA }
  };
}

function outerConfig(endpoint) {
  return {
    endpoint,
    apiKey: CLIENT_SECRET,
    model: 'requested-outer-model',
    seed: 17,
    temperature: 0,
    maxOutputTokens: 512,
    timeoutMs: 5_000
  };
}

function providerPayload({
  model = 'reported-provider-model',
  usage = { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 },
  response = decision()
} = {}) {
  const payload = {
    choices: [{ message: { content: JSON.stringify(response) } }]
  };
  if (model !== undefined) payload.model = model;
  if (usage !== undefined) payload.usage = usage;
  return payload;
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'shadowgraph-provider-meter-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const address = server.address();
  return {
    server,
    origin: `http://127.0.0.1:${address.port}`
  };
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function ledgerEvents(ledgerPath) {
  const content = await readFile(ledgerPath, 'utf8');
  if (content.length === 0) return [];
  assert.ok(content.endsWith('\n'), 'ledger must end on a complete NDJSON record');
  return content.trimEnd().split('\n').map((line) => JSON.parse(line));
}

async function within(promise, timeoutMs, message) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function sendIncompleteRequest(url, { method = 'POST', contentLength }) {
  const target = new URL(url);
  let socket;
  const resultPromise = new Promise((resolve, reject) => {
    const chunks = [];
    socket = netConnect({ host: target.hostname, port: Number(target.port) }, () => {
      socket.write([
        `${method} ${target.pathname}${target.search} HTTP/1.1`,
        `Host: ${target.host}`,
        'Content-Type: application/json',
        `Content-Length: ${contentLength}`,
        'Connection: keep-alive',
        '',
        '{'
      ].join('\r\n'));
    });
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.once('error', reject);
    socket.once('close', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      const [head, body = ''] = raw.split('\r\n\r\n');
      const lines = head.split('\r\n');
      const headers = Object.fromEntries(lines.slice(1).map((line) => {
        const separator = line.indexOf(':');
        return [line.slice(0, separator).toLowerCase(), line.slice(separator + 1).trim()];
      }));
      resolve({
        status: Number(lines[0].split(' ')[1]),
        connection: headers.connection,
        body
      });
    });
  });
  try {
    return await within(
      resultPromise,
      750,
      `incomplete ${method} ${target.pathname} (${contentLength} bytes) kept its response open`
    );
  } finally {
    socket?.destroy();
  }
}

/**
 * Start a meter with its shutdown already registered.
 *
 * A meter holds a listening socket and an open ledger descriptor, so one that
 * is never closed keeps the Node event loop alive and the test process hangs
 * forever - at near-zero CPU, with nothing on stdout, after every test in the
 * file has already reported. That is not a hypothetical: the concurrent-provider
 * test below created its meter and closed it only on the success path, eight
 * assertions later. Any one of them throwing left the socket open, and because
 * the temporary-directory hook still ran, the ledger it held became an
 * open-but-deleted file - which is exactly what a stuck run was found holding.
 *
 * Registering inside the helper makes the failure mode unreachable rather than
 * unlikely. `close()` is idempotent (provider-meter.mjs memoizes closePromise),
 * so a test may still close explicitly to assert shutdown behaviour.
 *
 * The close is bounded too. Registering a hook guarantees close() is CALLED,
 * not that it RETURNS: it awaits server.close(), which settles only once every
 * connection has drained. A cleanup hook that can park forever is the same
 * silent stall one layer up, so a meter that will not shut down names itself
 * instead. Requests carry their own deadlines, so a healthy close is
 * milliseconds; 5s is far above the sub-second budgets this file already holds
 * close to at its two explicit shutdown assertions.
 */
async function startTrackedMeter(t, config) {
  const meter = await startProviderMeter(config);
  t.after(() => within(
    meter.close(),
    5_000,
    'meter close did not finish within 5s; a socket or ledger handle is leaking'
  ));
  return meter;
}

async function meterFor(t, upstreamBaseUrl, overrides = {}) {
  const directory = await temporaryDirectory(t);
  const ledgerPath = path.join(directory, 'provider-requests.ndjson');
  const meter = await startProviderMeter({
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl,
    upstreamAuthorization: `Bearer ${UPSTREAM_SECRET}`,
    ledgerPath,
    upstreamTimeoutMs: 2_000,
    ...overrides
  });
  t.after(() => meter.close());
  return { meter, ledgerPath };
}

function assertExactEvent(event, expected = {}) {
  assert.deepEqual(Object.keys(event), EVENT_FIELDS);
  assert.equal(event.schema, 'shadowgraph.provider-meter.event');
  assert.equal(event.version, 1);
  assert.equal(event.event, 'provider_request');
  assert.ok(Number.isSafeInteger(event.requestNumber) && event.requestNumber > 0);
  assert.ok(Number.isFinite(event.latencyMs) && event.latencyMs >= 0);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(event[key], value, key);
}

test('configuration is loopback-only, ledgers are collision-safe, and bindings require exact correlation', async (t) => {
  const upstream = await listen(t, (_request, response) => response.end('{}'));
  const directory = await temporaryDirectory(t);

  const baseConfig = {
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: upstream.origin,
    upstreamAuthorization: null,
    ledgerPath: path.join(directory, 'meter.ndjson'),
    upstreamTimeoutMs: 1_000
  };

  await assert.rejects(
    startProviderMeter({ ...baseConfig, listenerUrl: 'http://0.0.0.0:0' }),
    /listenerUrl.*loopback/i
  );
  await assert.rejects(
    startProviderMeter({ ...baseConfig, listenerUrl: 'http://localhost:0' }),
    /listenerUrl.*loopback/i
  );
  await assert.rejects(
    startProviderMeter({ ...baseConfig, upstreamBaseUrl: 'https://example.com/v1' }),
    /upstreamBaseUrl.*loopback/i
  );
  await assert.rejects(
    startProviderMeter({
      ...baseConfig,
      upstreamBaseUrl: `http://localhost:${new URL(upstream.origin).port}/v1`
    }),
    /upstreamBaseUrl.*loopback/i
  );
  await assert.rejects(
    startProviderMeter({ ...baseConfig, upstreamBaseUrl: `http://user:password@127.0.0.1:${new URL(upstream.origin).port}/v1` }),
    /upstreamBaseUrl.*credentials/i
  );

  await writeFile(baseConfig.ledgerPath, 'preserve-me\n', { flag: 'wx' });
  await assert.rejects(startProviderMeter(baseConfig), /ledger already exists/i);
  assert.equal(await readFile(baseConfig.ledgerPath, 'utf8'), 'preserve-me\n');

  const fresh = await startTrackedMeter(t, {
    ...baseConfig,
    ledgerPath: path.join(directory, 'fresh.ndjson')
  });

  const { requestClass: _omitted, ...missingClass } = BASE_CORRELATION;
  assert.throws(() => fresh.bindEndpoint(missingClass), /requestClass/i);
  assert.throws(
    () => fresh.bindEndpoint({ ...BASE_CORRELATION, requestClass: 'unclassified' }),
    /requestClass/i
  );
  assert.throws(
    () => fresh.bindEndpoint({ ...BASE_CORRELATION, extra: 'not-allowed' }),
    /Unknown provider meter correlation field/i
  );
});

test('Task 3 outer requests traverse one opaque bound endpoint and preserve exact usage', async (t) => {
  const upstreamCalls = [];
  const upstream = await listen(t, async (request, response) => {
    const body = await readBody(request);
    upstreamCalls.push({
      url: request.url,
      authorization: request.headers.authorization,
      clientCorrelation: request.headers['x-shadowgraph-run-id'],
      body
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(providerPayload()));
  });
  const { meter, ledgerPath } = await meterFor(t, `${upstream.origin}/v1`);
  const endpoint = meter.bindEndpoint(BASE_CORRELATION);

  assert.equal(new URL(endpoint).hostname, '127.0.0.1');
  assert.notEqual(new URL(endpoint).port, new URL(upstream.origin).port);
  assert.ok(!endpoint.includes(UPSTREAM_SECRET));
  assert.ok(!endpoint.includes(CLIENT_SECRET));

  const result = await requestOuterDecision({
    fetchImpl: fetch,
    config: outerConfig(endpoint),
    correlation: { ...BASE_CORRELATION },
    request: outerRequest()
  });

  assert.equal(upstreamCalls.length, 1, 'one incoming outer request must cause one upstream request');
  assert.equal(upstreamCalls[0].url, '/v1/chat/completions');
  assert.equal(upstreamCalls[0].authorization, `Bearer ${UPSTREAM_SECRET}`);
  assert.equal(upstreamCalls[0].clientCorrelation, undefined, 'correlation headers are meter-local');
  assert.ok(!upstreamCalls[0].body.toString('utf8').includes(CLIENT_SECRET));
  assert.deepEqual(result.decision, decision());
  assert.deepEqual(result.usage, { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 });
  assert.equal(result.providerModel, 'reported-provider-model');
  assert.equal(result.requestCount, 1);

  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 1);
  assertExactEvent(events[0], {
    requestNumber: 1,
    ...BASE_CORRELATION,
    requestedModel: 'requested-outer-model',
    providerModel: 'reported-provider-model',
    outcome: 'SUCCEEDED',
    failure: null,
    httpStatus: 200,
    usage: { prompt_tokens: 13, completion_tokens: 7, total_tokens: 20 }
  });

  const evidence = await readFile(ledgerPath, 'utf8');
  for (const forbidden of [CLIENT_SECRET, UPSTREAM_SECRET, endpoint, upstream.origin, 'Choose among the supplied options.']) {
    assert.ok(!evidence.includes(forbidden), `ledger leaked ${forbidden}`);
  }
});

test('internal-memory and embedding providers use separately bound metered endpoints', async (t) => {
  const upstreamUrls = [];
  const upstream = await listen(t, async (request, response) => {
    upstreamUrls.push(request.url);
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ model: `reported-${body.model}`, usage: { total_tokens: body.model.length }, data: [] }));
  });
  const { meter, ledgerPath } = await meterFor(t, `${upstream.origin}/openai/v1`);

  const memoryCorrelation = {
    ...BASE_CORRELATION,
    phase: 'B',
    requestClass: 'internal_memory_llm'
  };
  const embeddingCorrelation = {
    ...BASE_CORRELATION,
    phase: 'C',
    requestClass: 'embedding'
  };
  const memoryEndpoint = meter.bindEndpoint(memoryCorrelation);
  const embeddingEndpoint = meter.bindEndpoint(embeddingCorrelation);

  const [memoryResponse, embeddingResponse] = await Promise.all([
    fetch(`${memoryEndpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'memory-model', messages: [] })
    }),
    fetch(`${embeddingEndpoint}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'embedding-model', input: ['private embedding input'] })
    })
  ]);
  assert.equal(memoryResponse.status, 200);
  assert.equal(embeddingResponse.status, 200);
  await memoryResponse.arrayBuffer();
  await embeddingResponse.arrayBuffer();
  assert.deepEqual(upstreamUrls.sort(), ['/openai/v1/chat/completions', '/openai/v1/embeddings']);

  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 2);
  const byClass = Object.fromEntries(events.map((event) => [event.requestClass, event]));
  assertExactEvent(byClass.internal_memory_llm, {
    ...memoryCorrelation,
    requestedModel: 'memory-model',
    providerModel: 'reported-memory-model',
    usage: { total_tokens: 12 },
    outcome: 'SUCCEEDED',
    failure: null,
    httpStatus: 200
  });
  assertExactEvent(byClass.embedding, {
    ...embeddingCorrelation,
    requestedModel: 'embedding-model',
    providerModel: 'reported-embedding-model',
    usage: { total_tokens: 15 },
    outcome: 'SUCCEEDED',
    failure: null,
    httpStatus: 200
  });
  const evidence = await readFile(ledgerPath, 'utf8');
  assert.ok(!evidence.includes('private embedding input'));
});

test('wrong or partial correlation and unknown opaque routes fail before upstream traffic', async (t) => {
  let upstreamCount = 0;
  const upstream = await listen(t, (_request, response) => {
    upstreamCount += 1;
    response.end(JSON.stringify({ usage: null }));
  });
  const { meter, ledgerPath } = await meterFor(t, upstream.origin);
  const endpoint = meter.bindEndpoint(BASE_CORRELATION);

  const partial = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shadowgraph-run-id': BASE_CORRELATION.runId
    },
    body: JSON.stringify({ model: 'never-forwarded' })
  });
  assert.equal(partial.status, 400);

  const wrongClass = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shadowgraph-run-id': BASE_CORRELATION.runId,
      'x-shadowgraph-attempt-id': BASE_CORRELATION.attemptId,
      'x-shadowgraph-arm-id': BASE_CORRELATION.armId,
      'x-shadowgraph-scenario-id': BASE_CORRELATION.scenarioId,
      'x-shadowgraph-repetition': String(BASE_CORRELATION.repetition),
      'x-shadowgraph-phase': BASE_CORRELATION.phase,
      'x-shadowgraph-request-class': 'embedding'
    },
    body: JSON.stringify({ model: 'never-forwarded' })
  });
  assert.equal(wrongClass.status, 400);

  const unknown = new URL(endpoint);
  unknown.pathname = `${unknown.pathname.slice(0, unknown.pathname.lastIndexOf('/') + 1)}unknown-binding/chat/completions`;
  const unknownResponse = await fetch(unknown, { method: 'POST', body: '{}' });
  assert.equal(unknownResponse.status, 404);

  assert.equal(upstreamCount, 0);
  assert.deepEqual(await ledgerEvents(ledgerPath), []);
});

test('request-class routes and methods cannot be mislabeled and every bound rejection is counted', async (t) => {
  let upstreamCount = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCount += 1;
    await readBody(request);
    response.end('{}');
  });
  const { meter, ledgerPath } = await meterFor(t, upstream.origin);
  const embeddingEndpoint = meter.bindEndpoint({ ...BASE_CORRELATION, requestClass: 'embedding' });
  const outerEndpoint = meter.bindEndpoint(BASE_CORRELATION);

  const wrongEmbeddingRoute = await fetch(`${embeddingEndpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embedding-model' })
  });
  const wrongOuterRoute = await fetch(`${outerEndpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'outer-model' })
  });
  const wrongMethod = await fetch(`${embeddingEndpoint}/embeddings`, { method: 'GET' });

  assert.equal(wrongEmbeddingRoute.status, 400);
  assert.equal(wrongOuterRoute.status, 400);
  assert.equal(wrongMethod.status, 405);
  assert.equal(upstreamCount, 0);

  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 3);
  assert.deepEqual(events.map((event) => event.requestNumber), [1, 2, 3]);
  for (const event of events) {
    assertExactEvent(event, {
      outcome: 'FAILED',
      failure: {
        code: 'CLIENT_CONTRACT_FAILURE',
        message: 'Metered provider request violated the bound contract'
      },
      httpStatus: null,
      providerModel: null,
      usage: null
    });
  }
});

test('early bound rejections close incomplete bodies and cannot block meter shutdown', async (t) => {
  let upstreamCount = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCount += 1;
    await readBody(request);
    response.end('{}');
  });
  const directory = await temporaryDirectory(t);
  const ledgerPath = path.join(directory, 'early-rejections.ndjson');
  const meter = await startTrackedMeter(t, {
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: upstream.origin,
    upstreamAuthorization: null,
    ledgerPath,
    upstreamTimeoutMs: 2_000
  });
  const endpoint = meter.bindEndpoint(BASE_CORRELATION);

  const wrongMethod = await sendIncompleteRequest(`${endpoint}/chat/completions`, {
    method: 'PUT',
    contentLength: 100
  });
  const wrongRoute = await sendIncompleteRequest(`${endpoint}/embeddings`, {
    contentLength: 100
  });
  const declaredOversize = await sendIncompleteRequest(`${endpoint}/chat/completions`, {
    contentLength: (8 * 1024 * 1024) + 1
  });

  assert.deepEqual(
    [wrongMethod.status, wrongRoute.status, declaredOversize.status],
    [405, 400, 400]
  );
  assert.deepEqual(
    [wrongMethod.connection, wrongRoute.connection, declaredOversize.connection],
    ['close', 'close', 'close']
  );
  assert.equal(upstreamCount, 0);
  await within(meter.close(), 750, 'early rejection sockets blocked meter shutdown');
  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 3);
  assert.ok(events.every((event) => event.failure?.code === 'CLIENT_CONTRACT_FAILURE'));
});

test('correlation-valid malformed requests remain visible as sanitized failed attempts', async (t) => {
  let upstreamCount = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCount += 1;
    await readBody(request);
    response.end('{}');
  });
  const { meter, ledgerPath } = await meterFor(t, upstream.origin);
  const endpoint = meter.bindEndpoint(BASE_CORRELATION);

  const malformed = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not-json'
  });
  const missingModel = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [] })
  });
  const privateModel = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'https://private.invalid/account/model', messages: [] })
  });
  const windowsPathModel = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'C:/Users/private/account/model', messages: [] })
  });
  const emptyBody = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: ''
  });
  const upstreamEchoModel = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: `model-${new URL(upstream.origin).host}`,
      messages: []
    })
  });

  assert.deepEqual(
    [
      malformed.status,
      missingModel.status,
      privateModel.status,
      windowsPathModel.status,
      emptyBody.status,
      upstreamEchoModel.status
    ],
    [400, 400, 400, 400, 400, 400]
  );
  assert.equal(upstreamCount, 0);
  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 6);
  for (const event of events) {
    assertExactEvent(event, {
      requestedModel: null,
      providerModel: null,
      outcome: 'FAILED',
      failure: {
        code: 'CLIENT_CONTRACT_FAILURE',
        message: 'Metered provider request violated the bound contract'
      },
      httpStatus: null,
      usage: null
    });
  }
  const evidence = await readFile(ledgerPath, 'utf8');
  assert.ok(!evidence.includes('not-json'));
  assert.ok(!evidence.includes('private.invalid'));
  assert.ok(!evidence.includes('C:/Users/private'));
  assert.ok(!evidence.includes(new URL(upstream.origin).host));
});

test('successful status and body bytes are forwarded exactly and missing usage stays null', async (t) => {
  const exactBody = Buffer.from(' {\n  "model": "embedding-reported",\n  "data": []\n}\n', 'utf8');
  const upstreamRequests = [];
  const upstream = await listen(t, async (request, response) => {
    upstreamRequests.push({ url: request.url, body: await readBody(request) });
    response.writeHead(201, { 'content-type': 'application/json; charset=utf-8' });
    response.end(exactBody);
  });
  const { meter, ledgerPath } = await meterFor(t, `${upstream.origin}/v1`);
  const correlation = { ...BASE_CORRELATION, requestClass: 'embedding' };
  const endpoint = meter.bindEndpoint(correlation);
  const requestBytes = Buffer.from('{"model":"embedding-requested","input":[1,2,3]}');

  const response = await fetch(`${endpoint}/embeddings?encoding_format=float`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: requestBytes
  });
  const received = Buffer.from(await response.arrayBuffer());
  assert.equal(response.status, 201);
  assert.deepEqual(received, exactBody);
  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0].url, '/v1/embeddings?encoding_format=float');
  assert.deepEqual(upstreamRequests[0].body, requestBytes);

  const [event] = await ledgerEvents(ledgerPath);
  assertExactEvent(event, {
    ...correlation,
    requestedModel: 'embedding-requested',
    providerModel: 'embedding-reported',
    usage: null,
    outcome: 'SUCCEEDED',
    failure: null,
    httpStatus: 201
  });
});

test('upstream HTTP failures are forwarded once and recorded without inventing usage', async (t) => {
  let upstreamCount = 0;
  const failureBody = Buffer.from('{"error":{"message":"temporarily busy"}}');
  const upstream = await listen(t, async (request, response) => {
    upstreamCount += 1;
    await readBody(request);
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '1' });
    response.end(failureBody);
  });
  const { meter, ledgerPath } = await meterFor(t, upstream.origin);
  const endpoint = meter.bindEndpoint({ ...BASE_CORRELATION, requestClass: 'internal_memory_llm' });

  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'memory-requested' })
  });
  assert.equal(response.status, 429);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), failureBody);
  assert.equal(upstreamCount, 1);

  const [event] = await ledgerEvents(ledgerPath);
  assertExactEvent(event, {
    requestClass: 'internal_memory_llm',
    requestedModel: 'memory-requested',
    providerModel: null,
    usage: null,
    outcome: 'FAILED',
    failure: {
      code: 'UPSTREAM_HTTP_STATUS',
      message: 'Loopback provider returned a non-success HTTP status'
    },
    httpStatus: 429
  });
});

test('malformed provider JSON and malformed usage fail closed with sanitized 502 evidence', async (t) => {
  let call = 0;
  const upstream = await listen(t, async (request, response) => {
    call += 1;
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (call === 1) response.end('not-json-private-body');
    else response.end(JSON.stringify({ model: 'provider-model', usage: ['not', 'an', 'object'], data: [] }));
  });
  const { meter, ledgerPath } = await meterFor(t, upstream.origin);
  const endpoint = meter.bindEndpoint({ ...BASE_CORRELATION, requestClass: 'embedding' });

  for (const model of ['first-model', 'second-model']) {
    const response = await fetch(`${endpoint}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, input: [] })
    });
    assert.equal(response.status, 502);
    assert.equal(await response.text(), '{"error":"provider_meter_upstream_failure"}');
  }
  assert.equal(call, 2, 'contract failures must not trigger retries');

  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 2);
  assert.deepEqual(events.map((event) => event.requestNumber), [1, 2]);
  for (const event of events) {
    assertExactEvent(event, {
      requestClass: 'embedding',
      outcome: 'FAILED',
      failure: {
        code: 'PROVIDER_CONTRACT_FAILURE',
        message: 'Loopback provider returned an invalid measured response'
      },
      httpStatus: 200,
      usage: null
    });
  }
  const publicEvidence = `${await readFile(ledgerPath, 'utf8')} ${events.map(JSON.stringify).join(' ')}`;
  assert.ok(!publicEvidence.includes(UPSTREAM_SECRET));
  assert.ok(!publicEvidence.includes('not-json'));
  assert.ok(!publicEvidence.includes('not an object'));
});

test('model identifiers and provider usage are bounded to public numeric evidence', async (t) => {
  const responses = [
    { model: '/private/account/model', usage: { total_tokens: 2 }, data: [] },
    { model: 'C:/Users/private/account/model', usage: { total_tokens: 2 }, data: [] },
    { model: 'provider-model', usage: { privatePrompt: 'private prompt contents' }, data: [] },
    { model: 'provider-model', usage: { total_tokens: '2' }, data: [] },
    { model: 'provider-model', usage: { total_tokens: -1 }, data: [] },
    {
      model: 'provider-model',
      usage: {
        prompt_tokens: 3,
        completion_tokens: 2,
        total_tokens: 5,
        prompt_tokens_details: { cached_tokens: 1 }
      },
      data: []
    }
  ];
  let call = 0;
  const upstream = await listen(t, async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(responses[call++]));
  });
  const { meter, ledgerPath } = await meterFor(t, upstream.origin);
  const endpoint = meter.bindEndpoint({ ...BASE_CORRELATION, requestClass: 'embedding' });

  const statuses = [];
  for (let index = 0; index < responses.length; index += 1) {
    const response = await fetch(`${endpoint}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'embedding-model', input: [] })
    });
    statuses.push(response.status);
    await response.arrayBuffer();
  }
  assert.deepEqual(statuses, [502, 502, 502, 502, 502, 200]);

  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 6);
  assert.deepEqual(events.slice(0, 5).map((event) => event.outcome), Array(5).fill('FAILED'));
  assert.deepEqual(events[5].usage, responses[5].usage);
  const evidence = await readFile(ledgerPath, 'utf8');
  assert.ok(!evidence.includes('/private/account/model'));
  assert.ok(!evidence.includes('C:/Users/private'));
  assert.ok(!evidence.includes('private prompt contents'));
  assert.ok(!evidence.includes('privatePrompt'));
});

test('escaped and short credentials cannot become public provider model evidence', async (t) => {
  const shortSecret = 'x7';
  const escapedSecret = [...UPSTREAM_SECRET]
    .map((character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`)
    .join('');
  let call = 0;
  const upstream = await listen(t, async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    if (call++ === 0) {
      response.end(`{"model":"${escapedSecret}","usage":{"total_tokens":1},"data":[]}`);
    } else {
      response.end(JSON.stringify({ model: shortSecret, usage: { total_tokens: 1 }, data: [] }));
    }
  });

  const escapedMeter = await meterFor(t, upstream.origin);
  const escapedEndpoint = escapedMeter.meter.bindEndpoint({
    ...BASE_CORRELATION,
    requestClass: 'embedding'
  });
  const escapedResponse = await fetch(`${escapedEndpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embedding-model', input: [] })
  });
  assert.equal(escapedResponse.status, 502);

  const shortMeter = await meterFor(t, upstream.origin, {
    upstreamAuthorization: `Bearer ${shortSecret}`
  });
  const shortEndpoint = shortMeter.meter.bindEndpoint({
    ...BASE_CORRELATION,
    attemptId: 'attempt-meter-short-secret',
    requestClass: 'embedding'
  });
  const shortResponse = await fetch(`${shortEndpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embedding-model', input: [] })
  });
  assert.equal(shortResponse.status, 502);

  for (const ledgerPath of [escapedMeter.ledgerPath, shortMeter.ledgerPath]) {
    const [event] = await ledgerEvents(ledgerPath);
    assertExactEvent(event, {
      providerModel: null,
      outcome: 'FAILED',
      failure: {
        code: 'CREDENTIAL_ECHO_DETECTED',
        message: 'Loopback provider response contained protected data'
      },
      httpStatus: 200,
      usage: null
    });
    const evidence = await readFile(ledgerPath, 'utf8');
    assert.ok(!evidence.includes(UPSTREAM_SECRET));
    assert.ok(!evidence.includes(shortSecret));
  }
});

test('the absolute request deadline includes a slow correlation-valid client body', async (t) => {
  let upstreamCount = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCount += 1;
    await readBody(request);
    response.end(JSON.stringify(providerPayload()));
  });
  const { meter, ledgerPath } = await meterFor(t, upstream.origin, { upstreamTimeoutMs: 45 });
  const endpoint = meter.bindEndpoint(BASE_CORRELATION);
  const payload = Buffer.from(JSON.stringify({ model: 'outer-model', messages: [] }));
  let clientRequest;
  const responsePromise = new Promise((resolve, reject) => {
    clientRequest = httpRequest(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length
      }
    }, async (response) => {
      const body = await readBody(response);
      resolve({ status: response.statusCode, body: body.toString('utf8') });
    });
    clientRequest.once('error', reject);
    clientRequest.write(payload.subarray(0, 1));
  });

  let result;
  try {
    result = await within(responsePromise, 750, 'slow client body escaped the absolute deadline');
  } finally {
    clientRequest.destroy();
  }

  assert.deepEqual(result, {
    status: 408,
    body: '{"error":"provider_request_timeout"}'
  });
  assert.equal(upstreamCount, 0);
  const [event] = await ledgerEvents(ledgerPath);
  assertExactEvent(event, {
    requestedModel: null,
    providerModel: null,
    outcome: 'FAILED',
    failure: {
      code: 'PROVIDER_REQUEST_TIMEOUT',
      message: 'Metered provider request exceeded its absolute deadline'
    },
    httpStatus: null,
    usage: null
  });
});

test('upstream timeout is an absolute deadline even when response bytes keep arriving', async (t) => {
  const upstream = await listen(t, async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    const interval = setInterval(() => response.write(' '), 10);
    response.once('close', () => clearInterval(interval));
    setTimeout(() => {
      clearInterval(interval);
      if (!response.writableEnded) response.end(JSON.stringify(providerPayload()));
    }, 220);
  });
  const { meter, ledgerPath } = await meterFor(t, upstream.origin, { upstreamTimeoutMs: 45 });
  const endpoint = meter.bindEndpoint(BASE_CORRELATION);
  const started = performance.now();
  const response = await fetch(`${endpoint}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'outer-model', messages: [] })
  });
  const elapsed = performance.now() - started;

  assert.equal(response.status, 502);
  assert.ok(elapsed < 180, `absolute deadline took ${elapsed}ms`);
  const [event] = await ledgerEvents(ledgerPath);
  assertExactEvent(event, {
    outcome: 'FAILED',
    failure: { code: 'UPSTREAM_TIMEOUT', message: 'Loopback provider request timed out' },
    httpStatus: null,
    usage: null
  });
});

test('downstream aborts are recorded and close drains in-flight handlers before closing the ledger', async (t) => {
  let releaseUpstream;
  let markStarted;
  const started = new Promise((resolve) => { markStarted = resolve; });
  const upstream = await listen(t, async (request, response) => {
    await readBody(request);
    markStarted();
    await new Promise((resolve) => { releaseUpstream = resolve; });
    if (!response.writableEnded) {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(providerPayload()));
    }
  });
  const directory = await temporaryDirectory(t);
  const ledgerPath = path.join(directory, 'abort.ndjson');
  const meter = await startProviderMeter({
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: upstream.origin,
    upstreamAuthorization: null,
    ledgerPath,
    upstreamTimeoutMs: 2_000
  });
  // Not startTrackedMeter: close() drains in-flight handlers, and this test
  // parks one deliberately. The release has to happen before the close, so this
  // hook owns both. A second close-only hook could run first and deadlock
  // against the handler this one is about to release.
  t.after(() => {
    releaseUpstream?.();
    return meter.close();
  });
  const endpoint = meter.bindEndpoint(BASE_CORRELATION);
  const payload = JSON.stringify({ model: 'outer-model', messages: [] });
  let clientRequest;
  const pending = new Promise((resolve) => {
    clientRequest = httpRequest(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload)
      }
    }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    clientRequest.once('error', resolve);
    clientRequest.end(payload);
  });

  await started;
  clientRequest.destroy();
  await pending;
  const closing = meter.close();
  await within(closing, 1_000, 'meter close did not drain the disconnected handler');
  releaseUpstream();
  await closing;

  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 1);
  assertExactEvent(events[0], {
    outcome: 'FAILED',
    failure: { code: 'DOWNSTREAM_ABORTED', message: 'Metered provider client disconnected' },
    httpStatus: null,
    usage: null
  });
});

test('network failures and credential echoes produce bounded non-leaking failures', async (t) => {
  const echoUpstream = await listen(t, async (request, response) => {
    await readBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'provider-model',
      usage: null,
      echoedAuthorization: request.headers.authorization
    }));
  });
  const echoMeter = await meterFor(t, echoUpstream.origin);
  const echoEndpoint = echoMeter.meter.bindEndpoint({ ...BASE_CORRELATION, requestClass: 'internal_memory_llm' });
  const echoResponse = await fetch(`${echoEndpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${CLIENT_SECRET}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model: 'memory-model' })
  });
  assert.equal(echoResponse.status, 502);
  const echoPublic = `${echoEndpoint}\n${await echoResponse.text()}\n${await readFile(echoMeter.ledgerPath, 'utf8')}`;
  for (const secret of [CLIENT_SECRET, UPSTREAM_SECRET, echoUpstream.origin]) {
    assert.ok(!echoPublic.includes(secret), `public meter evidence leaked ${secret}`);
  }

  const unavailable = await listen(t, (_request, response) => response.end('{}'));
  const unavailableOrigin = unavailable.origin;
  await new Promise((resolve) => unavailable.server.close(resolve));
  const networkMeter = await meterFor(t, unavailableOrigin);
  const networkEndpoint = networkMeter.meter.bindEndpoint({ ...BASE_CORRELATION, requestClass: 'embedding' });
  const networkResponse = await fetch(`${networkEndpoint}/embeddings`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'embedding-model', input: [] })
  });
  assert.equal(networkResponse.status, 502);
  assert.equal(await networkResponse.text(), '{"error":"provider_meter_upstream_failure"}');
  const [networkEvent] = await ledgerEvents(networkMeter.ledgerPath);
  assertExactEvent(networkEvent, {
    outcome: 'FAILED',
    failure: {
      code: 'UPSTREAM_NETWORK_FAILURE',
      message: 'Loopback provider request failed'
    },
    httpStatus: null,
    usage: null,
    providerModel: null
  });
  const networkEvidence = await readFile(networkMeter.ledgerPath, 'utf8');
  assert.ok(!networkEvidence.includes(new URL(unavailableOrigin).port));
  assert.doesNotMatch(networkEvidence, /ECONNREFUSED|connect|127\.0\.0\.1/iu);
});

test('concurrent provider calls serialize as complete monotonically numbered NDJSON and shutdown is clean', async (t) => {
  let upstreamCount = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCount += 1;
    const body = JSON.parse((await readBody(request)).toString('utf8'));
    await new Promise((resolve) => setTimeout(resolve, (17 - body.ordinal) % 5));
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: `provider-${body.ordinal}`,
      usage: { total_tokens: body.ordinal },
      data: []
    }));
  });
  const directory = await temporaryDirectory(t);
  const ledgerPath = path.join(directory, 'concurrent.ndjson');
  const meter = await startTrackedMeter(t, {
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: upstream.origin,
    upstreamAuthorization: null,
    ledgerPath,
    upstreamTimeoutMs: 2_000
  });
  const endpoint = meter.bindEndpoint({ ...BASE_CORRELATION, requestClass: 'embedding' });

  const responses = await Promise.all(Array.from({ length: 18 }, async (_, ordinal) => {
    const response = await fetch(`${endpoint}/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: `requested-${ordinal}`, ordinal, input: [] })
    });
    await response.arrayBuffer();
    return response.status;
  }));
  assert.deepEqual(new Set(responses), new Set([200]));
  assert.equal(upstreamCount, 18);

  const rawLedger = await readFile(ledgerPath, 'utf8');
  assert.equal(rawLedger.split('\n').length, 19, '18 complete records plus the final empty line');
  const events = await ledgerEvents(ledgerPath);
  assert.equal(events.length, 18);
  assert.deepEqual(events.map((event) => event.requestNumber), Array.from({ length: 18 }, (_, index) => index + 1));
  assert.equal(new Set(events.map((event) => event.requestedModel)).size, 18);
  for (const event of events) assertExactEvent(event, { outcome: 'SUCCEEDED', requestClass: 'embedding' });

  await meter.close();
  await meter.close();
  assert.throws(() => meter.bindEndpoint(BASE_CORRELATION), /closed/i);
});
