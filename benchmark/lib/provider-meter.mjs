import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

import { REQUEST_CLASSES } from './v11-contract.mjs';

const CONFIG_FIELDS = [
  'listenerUrl',
  'upstreamBaseUrl',
  'upstreamAuthorization',
  'ledgerPath',
  'upstreamTimeoutMs'
];

const CORRELATION_FIELDS = [
  'runId',
  'attemptId',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'requestClass'
];

const CORRELATION_HEADERS = Object.freeze({
  runId: 'x-shadowgraph-run-id',
  attemptId: 'x-shadowgraph-attempt-id',
  armId: 'x-shadowgraph-arm-id',
  scenarioId: 'x-shadowgraph-scenario-id',
  repetition: 'x-shadowgraph-repetition',
  phase: 'x-shadowgraph-phase',
  requestClass: 'x-shadowgraph-request-class'
});

const ROUTE_PREFIX = '/provider-meter/v1/';
const OPAQUE_ROUTE_ID = /^[a-f0-9]{48}$/u;
const HEADER_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,255}$/u;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FAILURE_BODY = Buffer.from('{"error":"provider_meter_upstream_failure"}');

const SAFE_REQUEST_HEADERS = ['accept', 'content-type'];
const SAFE_RESPONSE_HEADERS = ['cache-control', 'content-encoding', 'content-type', 'retry-after'];
const RESOURCE_BY_REQUEST_CLASS = Object.freeze({
  outer_decision_llm: '/chat/completions',
  internal_memory_llm: '/chat/completions',
  embedding: '/embeddings'
});
const USAGE_COUNT_FIELDS = new Set([
  'prompt_tokens',
  'completion_tokens',
  'input_tokens',
  'output_tokens',
  'total_tokens'
]);
const USAGE_DETAIL_FIELDS = new Set([
  'accepted_prediction_tokens',
  'audio_tokens',
  'cached_tokens',
  'image_tokens',
  'reasoning_tokens',
  'rejected_prediction_tokens',
  'text_tokens'
]);
const USAGE_OBJECT_FIELDS = new Set([
  'prompt_tokens_details',
  'completion_tokens_details',
  'input_tokens_details',
  'output_tokens_details'
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing required ${label} field: ${key}`);
  }
}

function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isLoopbackHostname(hostname) {
  const value = unbracket(hostname).toLowerCase();
  if (value === '::1') return true;
  if (isIP(value) !== 4) return false;
  return value.split('.')[0] === '127';
}

function parseEndpoint(value, label, { listener = false } = {}) {
  if (!isNonEmptyString(value)) throw new Error(`${label} must be a non-empty URL`);
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const allowedProtocols = listener ? ['http:'] : ['http:', 'https:'];
  if (!allowedProtocols.includes(endpoint.protocol)) {
    throw new Error(`${label} must use ${listener ? 'HTTP' : 'HTTP or HTTPS'}`);
  }
  if (!isLoopbackHostname(endpoint.hostname)) {
    throw new Error(`${label} must use a loopback hostname`);
  }
  if (endpoint.username || endpoint.password) {
    throw new Error(`${label} must not contain credentials`);
  }
  if (endpoint.search || endpoint.hash) {
    throw new Error(`${label} must not contain query parameters or fragments`);
  }
  if (listener && !['', '/'].includes(endpoint.pathname)) {
    throw new Error(`${label} must not contain a path`);
  }
  return endpoint;
}

function validateConfig(config) {
  assertExactKeys(config, CONFIG_FIELDS, 'provider meter config');
  const listener = parseEndpoint(config.listenerUrl, 'listenerUrl', { listener: true });
  const upstream = parseEndpoint(config.upstreamBaseUrl, 'upstreamBaseUrl');
  if (config.upstreamAuthorization !== null) {
    if (!isNonEmptyString(config.upstreamAuthorization) || /[\r\n]/u.test(config.upstreamAuthorization)) {
      throw new Error('upstreamAuthorization must be null or a safe non-empty string');
    }
  }
  if (!isNonEmptyString(config.ledgerPath)) {
    throw new Error('ledgerPath must be a non-empty string');
  }
  if (!Number.isSafeInteger(config.upstreamTimeoutMs) || config.upstreamTimeoutMs < 1) {
    throw new Error('upstreamTimeoutMs must be a positive safe integer');
  }
  return { listener, upstream };
}

function validateCorrelation(correlation) {
  assertExactKeys(correlation, CORRELATION_FIELDS, 'provider meter correlation');
  for (const field of ['runId', 'attemptId', 'armId', 'scenarioId', 'phase']) {
    if (!isNonEmptyString(correlation[field]) || !HEADER_SAFE_ID.test(correlation[field])) {
      throw new Error(`provider meter correlation.${field} must be a header-safe identifier`);
    }
  }
  if (!Number.isSafeInteger(correlation.repetition) || correlation.repetition < 0) {
    throw new Error('provider meter correlation.repetition must be a non-negative safe integer');
  }
  if (!REQUEST_CLASSES.includes(correlation.requestClass)) {
    throw new Error(`Invalid provider meter correlation.requestClass: ${correlation.requestClass}`);
  }
  return Object.freeze({ ...correlation });
}

function correlationHeadersMatch(request, correlation) {
  const entries = CORRELATION_FIELDS.map((field) => [
    field,
    CORRELATION_HEADERS[field],
    request.headers[CORRELATION_HEADERS[field]]
  ]);
  const supplied = entries.filter(([, , value]) => value !== undefined);
  if (supplied.length === 0) return true;
  if (supplied.length !== entries.length) return false;
  return entries.every(([field, , value]) => {
    if (Array.isArray(value)) return false;
    return String(value) === String(correlation[field]);
  });
}

function declaredBodyExceedsLimit(request, limit) {
  const value = request.headers['content-length'];
  if (value === undefined) return false;
  if (Array.isArray(value) || !/^\d+$/u.test(value)) return true;
  try {
    return BigInt(value) > BigInt(limit);
  } catch {
    return true;
  }
}

function boundedResponse(response, status, body, headers = {}) {
  if (response.headersSent || response.writableEnded) return;
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string' && !/[\r\n]/u.test(value)) response.setHeader(name, value);
  }
  response.statusCode = status;
  response.setHeader('content-length', String(body.length));
  response.end(body);
}

function failureResponse(response) {
  boundedResponse(response, 502, FAILURE_BODY, { 'content-type': 'application/json' });
}

function codedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function readBoundedBody(stream, limit, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    let deadline;

    const cleanup = () => {
      clearTimeout(deadline);
      stream.off('data', onData);
      stream.off('end', onEnd);
      stream.off('aborted', onAborted);
      stream.off('error', onError);
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(Buffer.concat(chunks, bytes));
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk) => {
      const buffer = Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > limit) {
        stream.pause();
        fail(codedError('BODY_LIMIT_EXCEEDED'));
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => succeed();
    const onAborted = () => fail(codedError('DOWNSTREAM_ABORTED'));
    const onError = (error) => fail(error);

    deadline = setTimeout(() => {
      stream.pause();
      fail(codedError('PROVIDER_REQUEST_TIMEOUT'));
    }, timeoutMs);
    deadline.unref?.();
    stream.on('data', onData);
    stream.once('end', onEnd);
    stream.once('aborted', onAborted);
    stream.once('error', onError);
  });
}

function parseRequestedModel(body) {
  if (body.length === 0) throw new Error('INVALID_CLIENT_JSON');
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('INVALID_CLIENT_JSON');
  }
  if (!isPlainObject(payload)) throw new Error('INVALID_CLIENT_JSON');
  if (!Object.hasOwn(payload, 'model') || payload.model === null) throw new Error('INVALID_CLIENT_MODEL');
  validateModelIdentifier(payload.model, 'INVALID_CLIENT_MODEL');
  return payload.model;
}

function validateModelIdentifier(value, code) {
  if (!isNonEmptyString(value)
    || !MODEL_IDENTIFIER.test(value)
    || value.includes('://')
    || /^[A-Za-z]:\//u.test(value)
    || value.split('/').includes('..')) {
    throw new Error(code);
  }
}

function validateUsageCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('INVALID_PROVIDER_USAGE');
}

function validateUsageDetails(value) {
  if (value === null) return;
  if (!isPlainObject(value)) throw new Error('INVALID_PROVIDER_USAGE');
  for (const [field, count] of Object.entries(value)) {
    if (!USAGE_DETAIL_FIELDS.has(field)) throw new Error('INVALID_PROVIDER_USAGE');
    validateUsageCount(count);
  }
}

function validateProviderUsage(value) {
  if (!isPlainObject(value)) throw new Error('INVALID_PROVIDER_USAGE');
  for (const [field, fieldValue] of Object.entries(value)) {
    if (USAGE_COUNT_FIELDS.has(field)) validateUsageCount(fieldValue);
    else if (USAGE_OBJECT_FIELDS.has(field)) validateUsageDetails(fieldValue);
    else throw new Error('INVALID_PROVIDER_USAGE');
  }
}

function resourceTarget(upstreamBase, resourcePath, search) {
  let decoded;
  try {
    decoded = decodeURIComponent(resourcePath);
  } catch {
    throw new Error('INVALID_RESOURCE_PATH');
  }
  if (decoded.includes('\\') || decoded.includes('\0') || decoded.split('/').includes('..')) {
    throw new Error('INVALID_RESOURCE_PATH');
  }
  const target = new URL(upstreamBase);
  const basePath = target.pathname.replace(/\/+$/u, '');
  target.pathname = `${basePath}${resourcePath}`;
  target.search = search;
  return target;
}

function safeRequestHeaders(request, body, upstreamAuthorization) {
  const headers = {
    'accept-encoding': 'identity',
    'content-length': String(body.length)
  };
  for (const name of SAFE_REQUEST_HEADERS) {
    const value = request.headers[name];
    if (typeof value === 'string' && !/[\r\n]/u.test(value)) headers[name] = value;
  }
  if (upstreamAuthorization !== null) headers.authorization = upstreamAuthorization;
  return headers;
}

function requestUpstream({ target, method, headers, body, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const transport = target.protocol === 'https:' ? httpsRequest : httpRequest;
    let upstreamRequest;
    let upstreamResponse;
    let deadline;
    let settled = false;

    const cleanup = () => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', abortForDownstream);
    };
    const succeed = (value) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const stop = (code) => {
      const error = new Error(code);
      error.code = code;
      fail(error);
      upstreamResponse?.destroy(error);
      upstreamRequest?.destroy(error);
    };
    const abortForDownstream = () => stop('DOWNSTREAM_ABORTED');

    if (signal?.aborted) {
      stop('DOWNSTREAM_ABORTED');
      return;
    }
    signal?.addEventListener('abort', abortForDownstream, { once: true });
    deadline = setTimeout(() => stop('UPSTREAM_TIMEOUT'), timeoutMs);
    deadline.unref?.();

    try {
      upstreamRequest = transport(target, { method, headers }, (response) => {
      upstreamResponse = response;
      const chunks = [];
      let bytes = 0;

      upstreamResponse.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_RESPONSE_BYTES) {
          stop('UPSTREAM_RESPONSE_LIMIT');
          return;
        }
        chunks.push(buffer);
      });
      upstreamResponse.once('aborted', () => {
        const error = new Error('UPSTREAM_ABORTED');
        error.code = 'UPSTREAM_ABORTED';
        fail(error);
      });
      upstreamResponse.once('error', fail);
      upstreamResponse.once('end', () => {
        if (settled) return;
        succeed({
          status: upstreamResponse.statusCode,
          headers: upstreamResponse.headers,
          body: Buffer.concat(chunks, bytes)
        });
      });
      });
      upstreamRequest.once('error', fail);
      upstreamRequest.end(body);
    } catch (error) {
      fail(error);
    }
  });
}

function secretFragments(value) {
  if (!isNonEmptyString(value)) return [];
  const fragments = [];
  const trimmed = value.trim();
  fragments.push(trimmed);
  const separator = trimmed.indexOf(' ');
  if (separator !== -1) {
    const credential = trimmed.slice(separator + 1).trim();
    if (credential.length > 0) fragments.push(credential);
  }
  return fragments;
}

function protectedFragments({ upstream, upstreamAuthorization, clientAuthorization }) {
  return [...new Set([
    upstream.origin,
    upstream.host,
    upstream.toString(),
    ...secretFragments(upstreamAuthorization),
    ...secretFragments(clientAuthorization)
  ].filter((value) => typeof value === 'string' && value.length > 0))];
}

function containsProtectedData(body, fragments) {
  const text = body.toString('utf8');
  return fragments.some((fragment) => fragment.length >= 8 && text.includes(fragment));
}

function containsProtectedText(value, fragments) {
  return typeof value === 'string' && fragments.some((fragment) => value.includes(fragment));
}

function parseMeasuredProviderResponse(body) {
  let payload;
  try {
    payload = JSON.parse(body.toString('utf8'));
  } catch {
    throw new Error('INVALID_PROVIDER_JSON');
  }
  if (!isPlainObject(payload)) throw new Error('INVALID_PROVIDER_JSON');

  let providerModel = null;
  if (Object.hasOwn(payload, 'model') && payload.model !== null) {
    validateModelIdentifier(payload.model, 'INVALID_PROVIDER_MODEL');
    providerModel = payload.model;
  }

  let usage = null;
  if (Object.hasOwn(payload, 'usage') && payload.usage !== null) {
    validateProviderUsage(payload.usage);
    usage = payload.usage;
  }
  return { providerModel, usage };
}

function elapsedSince(start) {
  return Number(Math.max(0, performance.now() - start).toFixed(3));
}

function safeResponseHeaders(headers) {
  const safe = {};
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && !/[\r\n]/u.test(value)) safe[name] = value;
  }
  return safe;
}

/**
 * Start a local-only, zero-retry provider proxy with an exclusive append ledger.
 * Each endpoint returned by bindEndpoint is an opaque capability bound to one
 * exact benchmark correlation and contains no upstream URL or authorization.
 */
export async function startProviderMeter(config) {
  const { listener, upstream } = validateConfig(config);
  let ledger;
  try {
    ledger = await open(config.ledgerPath, 'ax', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Provider meter ledger already exists');
    throw error;
  }

  const bindings = new Map();
  let state = 'STARTING';
  let nextRequestNumber = 1;
  let ledgerTail = Promise.resolve();
  let closePromise = null;
  let advertisedOrigin;
  const inFlight = new Set();

  function appendEvent({
    correlation,
    requestedModel,
    providerModel,
    latencyMs,
    outcome,
    failure,
    httpStatus,
    usage
  }) {
    const operation = ledgerTail.then(async () => {
      const event = {
        schema: 'shadowgraph.provider-meter.event',
        version: 1,
        event: 'provider_request',
        requestNumber: nextRequestNumber,
        runId: correlation.runId,
        attemptId: correlation.attemptId,
        armId: correlation.armId,
        scenarioId: correlation.scenarioId,
        repetition: correlation.repetition,
        phase: correlation.phase,
        requestClass: correlation.requestClass,
        requestedModel,
        providerModel,
        latencyMs,
        outcome,
        failure,
        httpStatus,
        usage
      };
      nextRequestNumber += 1;
      await ledger.write(`${JSON.stringify(event)}\n`);
      await ledger.sync();
      return event;
    });
    ledgerTail = operation.catch(() => {});
    return operation;
  }

  async function handleIncoming(request, response) {
    if (state !== 'OPEN') {
      boundedResponse(response, 503, Buffer.from('{"error":"provider_meter_closed"}'), {
        'content-type': 'application/json'
      });
      return;
    }
    if (!isNonEmptyString(request.url) || !request.url.startsWith('/') || request.url.startsWith('//')) {
      boundedResponse(response, 404, Buffer.from('{"error":"not_found"}'), { 'content-type': 'application/json' });
      return;
    }

    let incoming;
    try {
      incoming = new URL(request.url, advertisedOrigin);
    } catch {
      boundedResponse(response, 404, Buffer.from('{"error":"not_found"}'), { 'content-type': 'application/json' });
      return;
    }
    if (incoming.origin !== advertisedOrigin) {
      boundedResponse(response, 404, Buffer.from('{"error":"not_found"}'), { 'content-type': 'application/json' });
      return;
    }

    const route = incoming.pathname.slice(ROUTE_PREFIX.length);
    if (!incoming.pathname.startsWith(ROUTE_PREFIX)) {
      boundedResponse(response, 404, Buffer.from('{"error":"not_found"}'), { 'content-type': 'application/json' });
      return;
    }
    const slash = route.indexOf('/');
    const routeId = slash === -1 ? route : route.slice(0, slash);
    const resourcePath = slash === -1 ? '' : route.slice(slash);
    const correlation = OPAQUE_ROUTE_ID.test(routeId) ? bindings.get(routeId) : undefined;
    if (!correlation || resourcePath.length < 2) {
      boundedResponse(response, 404, Buffer.from('{"error":"not_found"}'), { 'content-type': 'application/json' });
      return;
    }
    if (!correlationHeadersMatch(request, correlation)) {
      boundedResponse(response, 400, Buffer.from('{"error":"invalid_correlation"}'), {
        'content-type': 'application/json'
      });
      return;
    }

    const started = performance.now();
    const deadlineAt = started + config.upstreamTimeoutMs;
    const rejectBoundRequest = async (status) => {
      await appendEvent({
        correlation,
        requestedModel: null,
        providerModel: null,
        latencyMs: elapsedSince(started),
        outcome: 'FAILED',
        failure: {
          code: 'CLIENT_CONTRACT_FAILURE',
          message: 'Metered provider request violated the bound contract'
        },
        httpStatus: null,
        usage: null
      });
      const headers = { 'content-type': 'application/json' };
      if (!request.complete) headers.connection = 'close';
      boundedResponse(response, status, Buffer.from(
        status === 405 ? '{"error":"method_not_allowed"}' : '{"error":"invalid_provider_request"}'
      ), headers);
    };
    const rejectTimedOutRequest = async () => {
      await appendEvent({
        correlation,
        requestedModel: null,
        providerModel: null,
        latencyMs: elapsedSince(started),
        outcome: 'FAILED',
        failure: {
          code: 'PROVIDER_REQUEST_TIMEOUT',
          message: 'Metered provider request exceeded its absolute deadline'
        },
        httpStatus: null,
        usage: null
      });
      boundedResponse(response, 408, Buffer.from('{"error":"provider_request_timeout"}'), {
        connection: 'close',
        'content-type': 'application/json'
      });
    };
    const recordDownstreamAbort = () => appendEvent({
      correlation,
      requestedModel: null,
      providerModel: null,
      latencyMs: elapsedSince(started),
      outcome: 'FAILED',
      failure: { code: 'DOWNSTREAM_ABORTED', message: 'Metered provider client disconnected' },
      httpStatus: null,
      usage: null
    });
    const remainingDeadlineMs = () => Math.max(0, Math.floor(deadlineAt - performance.now()));

    if (request.method !== 'POST') {
      await rejectBoundRequest(405);
      return;
    }
    if (resourcePath !== RESOURCE_BY_REQUEST_CLASS[correlation.requestClass]) {
      await rejectBoundRequest(400);
      return;
    }
    if (declaredBodyExceedsLimit(request, MAX_REQUEST_BYTES)) {
      await rejectBoundRequest(400);
      return;
    }

    let body;
    let requestedModel;
    let target;
    try {
      const inboundTimeoutMs = remainingDeadlineMs();
      if (inboundTimeoutMs < 1) throw codedError('PROVIDER_REQUEST_TIMEOUT');
      body = await readBoundedBody(request, MAX_REQUEST_BYTES, inboundTimeoutMs);
      requestedModel = parseRequestedModel(body);
      target = resourceTarget(upstream, resourcePath, incoming.search);
    } catch (error) {
      if (error?.code === 'PROVIDER_REQUEST_TIMEOUT') {
        await rejectTimedOutRequest();
        return;
      }
      if (error?.code === 'DOWNSTREAM_ABORTED') {
        await recordDownstreamAbort();
        return;
      }
      await rejectBoundRequest(400);
      return;
    }

    const fragments = protectedFragments({
      upstream,
      upstreamAuthorization: config.upstreamAuthorization,
      clientAuthorization: typeof request.headers.authorization === 'string'
        ? request.headers.authorization
        : null
    });
    if (fragments.some((fragment) => requestedModel?.includes(fragment))) {
      await rejectBoundRequest(400);
      return;
    }

    let upstreamResponse;
    const downstream = new AbortController();
    const abortForClient = () => downstream.abort();
    request.once('aborted', abortForClient);
    response.once('close', abortForClient);
    request.socket.once('close', abortForClient);
    if (request.aborted || response.destroyed) downstream.abort();
    try {
      const upstreamTimeoutMs = remainingDeadlineMs();
      if (upstreamTimeoutMs < 1) throw codedError('UPSTREAM_TIMEOUT');
      upstreamResponse = await requestUpstream({
        target,
        method: request.method,
        headers: safeRequestHeaders(request, body, config.upstreamAuthorization),
        body,
        timeoutMs: upstreamTimeoutMs,
        signal: downstream.signal
      });
    } catch (error) {
      const timedOut = error?.code === 'UPSTREAM_TIMEOUT';
      const downstreamAborted = error?.code === 'DOWNSTREAM_ABORTED';
      await appendEvent({
        correlation,
        requestedModel,
        providerModel: null,
        latencyMs: elapsedSince(started),
        outcome: 'FAILED',
        failure: downstreamAborted
          ? { code: 'DOWNSTREAM_ABORTED', message: 'Metered provider client disconnected' }
          : timedOut
            ? { code: 'UPSTREAM_TIMEOUT', message: 'Loopback provider request timed out' }
            : { code: 'UPSTREAM_NETWORK_FAILURE', message: 'Loopback provider request failed' },
        httpStatus: null,
        usage: null
      });
      failureResponse(response);
      return;
    } finally {
      request.off('aborted', abortForClient);
      response.off('close', abortForClient);
      request.socket.off('close', abortForClient);
    }

    if (downstream.signal.aborted || request.aborted || response.destroyed) {
      await appendEvent({
        correlation,
        requestedModel,
        providerModel: null,
        latencyMs: elapsedSince(started),
        outcome: 'FAILED',
        failure: { code: 'DOWNSTREAM_ABORTED', message: 'Metered provider client disconnected' },
        httpStatus: null,
        usage: null
      });
      return;
    }

    if (containsProtectedData(upstreamResponse.body, fragments)) {
      await appendEvent({
        correlation,
        requestedModel,
        providerModel: null,
        latencyMs: elapsedSince(started),
        outcome: 'FAILED',
        failure: {
          code: 'CREDENTIAL_ECHO_DETECTED',
          message: 'Loopback provider response contained protected data'
        },
        httpStatus: upstreamResponse.status,
        usage: null
      });
      failureResponse(response);
      return;
    }

    if (upstreamResponse.status < 200 || upstreamResponse.status >= 300) {
      await appendEvent({
        correlation,
        requestedModel,
        providerModel: null,
        latencyMs: elapsedSince(started),
        outcome: 'FAILED',
        failure: {
          code: 'UPSTREAM_HTTP_STATUS',
          message: 'Loopback provider returned a non-success HTTP status'
        },
        httpStatus: upstreamResponse.status,
        usage: null
      });
      boundedResponse(
        response,
        upstreamResponse.status,
        upstreamResponse.body,
        safeResponseHeaders(upstreamResponse.headers)
      );
      return;
    }

    let measured;
    try {
      measured = parseMeasuredProviderResponse(upstreamResponse.body);
    } catch {
      await appendEvent({
        correlation,
        requestedModel,
        providerModel: null,
        latencyMs: elapsedSince(started),
        outcome: 'FAILED',
        failure: {
          code: 'PROVIDER_CONTRACT_FAILURE',
          message: 'Loopback provider returned an invalid measured response'
        },
        httpStatus: upstreamResponse.status,
        usage: null
      });
      failureResponse(response);
      return;
    }

    if (containsProtectedText(measured.providerModel, fragments)) {
      await appendEvent({
        correlation,
        requestedModel,
        providerModel: null,
        latencyMs: elapsedSince(started),
        outcome: 'FAILED',
        failure: {
          code: 'CREDENTIAL_ECHO_DETECTED',
          message: 'Loopback provider response contained protected data'
        },
        httpStatus: upstreamResponse.status,
        usage: null
      });
      failureResponse(response);
      return;
    }

    await appendEvent({
      correlation,
      requestedModel,
      providerModel: measured.providerModel,
      latencyMs: elapsedSince(started),
      outcome: 'SUCCEEDED',
      failure: null,
      httpStatus: upstreamResponse.status,
      usage: measured.usage
    });
    boundedResponse(
      response,
      upstreamResponse.status,
      upstreamResponse.body,
      safeResponseHeaders(upstreamResponse.headers)
    );
  }

  const server = createServer((request, response) => {
    const operation = handleIncoming(request, response)
      .catch(() => failureResponse(response))
      .finally(() => inFlight.delete(operation));
    inFlight.add(operation);
  });
  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  try {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      const port = listener.port === '' ? 80 : Number(listener.port);
      server.listen({ host: unbracket(listener.hostname), port, exclusive: true });
    });
  } catch (error) {
    await ledger.close();
    throw error;
  }

  const address = server.address();
  const advertised = new URL(listener);
  advertised.port = String(address.port);
  advertised.pathname = '/';
  advertisedOrigin = advertised.origin;
  state = 'OPEN';

  function bindEndpoint(input) {
    if (state !== 'OPEN') throw new Error('Provider meter is closed');
    const correlation = validateCorrelation(input);
    let routeId;
    do routeId = randomBytes(24).toString('hex'); while (bindings.has(routeId));
    bindings.set(routeId, correlation);
    return `${advertisedOrigin}${ROUTE_PREFIX}${routeId}`;
  }

  async function close() {
    if (closePromise !== null) return closePromise;
    state = 'CLOSING';
    closePromise = (async () => {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      await Promise.allSettled([...inFlight]);
      await ledgerTail;
      await ledger.close();
      bindings.clear();
      state = 'CLOSED';
    })();
    return closePromise;
  }

  return Object.freeze({ bindEndpoint, close });
}
