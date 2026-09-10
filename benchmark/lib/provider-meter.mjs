import { randomBytes } from 'node:crypto';
import { open } from 'node:fs/promises';
import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';

import { REQUEST_CLASSES } from './v11-contract.mjs';
import { validateProviderBudget } from './v11-budget.mjs';

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
const ROOT_OPERATIONS = new Set(['reset', 'retrieve', 'persist', 'verify', 'outer-decision']);

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
const OPAQUE_DISPATCH_ID = /^[a-f0-9]{48}$/u;
const CAMPAIGN_RESERVATION_ID = /^[A-Za-z0-9-]+:[1-9]\d*$/u;
const HEADER_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const MODEL_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:/@+~-]{0,255}$/u;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const FAILURE_BODY = Buffer.from('{"error":"provider_meter_upstream_failure"}');

const SAFE_REQUEST_HEADERS = ['accept', 'content-type'];
const SAFE_RESPONSE_HEADERS = ['cache-control', 'content-encoding', 'content-type', 'retry-after'];
const DISPATCH_ALIAS_HEADER = 'x-shadowgraph-dispatch-alias';
const DISPATCH_IDENTITY_MODES = new Set(['dynamic', 'static']);
const RESOURCE_BY_REQUEST_CLASS = Object.freeze({
  outer_decision_llm: '/chat/completions',
  internal_memory_llm: '/chat/completions',
  embedding: '/embeddings'
});

/**
 * The resource a client asked for, with one leading `/v1` removed.
 *
 * A bound capability is a whole URL, and the upstream's version segment is
 * already inside it - `/provider-meter/v1/<id>` proxies to an upstream base
 * that itself ends in `/v1`. Clients disagree about whether that means they
 * should append `/embeddings` or `/v1/embeddings`, and both name the same
 * resource. Mem0's OpenAI client appends the first; Cognee's
 * `openai_compatible` embedding engine appends the second, unconditionally -
 * handing it a URL that already ends in `/embeddings` only produced
 * `/embeddings/v1/embeddings`, so this cannot be fixed by shaping the endpoint.
 *
 * F27: every one of Cognee's embedding requests was refused with
 * CLIENT_CONTRACT_FAILURE in zero milliseconds, its persist failed, and every
 * later phase failed behind it - an arm reported as failing for a disagreement
 * about a path segment.
 *
 * What the comparison is actually for is unchanged: a capability bound for
 * embeddings must not be usable for a chat completion. Stripping one `/v1`
 * from either side of that comparison cannot turn one resource into the other,
 * and nothing else is normalised - the match stays exact.
 */
function boundResourcePath(resourcePath) {
  return resourcePath.startsWith('/v1/') ? resourcePath.slice(3) : resourcePath;
}
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

function rawAuthorityIsUnsafe(value) {
  if (typeof value !== 'string' || value.includes('\\')) return true;
  const match = /^(?:https?):\/\/([^/?#]*)/iu.exec(value);
  if (match === null || match[1].length === 0) return true;
  return match[1].includes('@');
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
  if (rawAuthorityIsUnsafe(value)) {
    throw new Error(`${label} must use a canonical HTTP or HTTPS URL without credentials`);
  }
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

function validateBinding(value, requireRootOperation) {
  if (!isPlainObject(value)) throw new Error('provider meter binding must be an object');
  const hasRootOperation = Object.hasOwn(value, 'rootOperation');
  const expectedFields = [
    ...CORRELATION_FIELDS,
    ...(hasRootOperation || requireRootOperation ? ['rootOperation'] : [])
  ];
  assertExactKeys(value, expectedFields, 'provider meter binding');
  const { rootOperation = null, ...correlation } = value;
  if (rootOperation !== null && (!isNonEmptyString(rootOperation) || !ROOT_OPERATIONS.has(rootOperation))) {
    throw new Error('provider meter rootOperation is invalid');
  }
  if (requireRootOperation && rootOperation === null) {
    throw new Error('provider meter rootOperation is required');
  }
  return Object.freeze({ ...validateCorrelation(correlation), rootOperation });
}

function validatePlannedBinding(value) {
  if (!isPlainObject(value)) throw new Error('planned provider meter binding must be an object');
  assertExactKeys(value, [
    ...CORRELATION_FIELDS,
    'rootOperation',
    'rootInvocationId',
    'planSlot',
    'identityMode'
  ], 'planned provider meter binding');
  const { rootInvocationId, planSlot, identityMode, ...rootBinding } = value;
  if (!isNonEmptyString(rootInvocationId) || !HEADER_SAFE_ID.test(rootInvocationId)) {
    throw new Error('planned provider meter rootInvocationId must be a header-safe identifier');
  }
  if (!isNonEmptyString(planSlot) || !HEADER_SAFE_ID.test(planSlot)) {
    throw new Error('planned provider meter planSlot must be a header-safe identifier');
  }
  if (!DISPATCH_IDENTITY_MODES.has(identityMode)) {
    throw new Error('planned provider meter identityMode is invalid');
  }
  return Object.freeze({
    ...validateBinding(rootBinding, true),
    rootInvocationId,
    planSlot,
    identityMode
  });
}

function rootRequestClassKey(correlation) {
  return [correlation.rootInvocationId, correlation.requestClass]
    .map((value) => {
      const text = String(value);
      return `${text.length}:${text}`;
    })
    .join('|');
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

function parseRequestMetadata(body) {
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
  const format = payload.response_format;
  const responseFormat = format === undefined || format === null
    ? null
    : isPlainObject(format) && format.type === 'json_schema'
      ? 'json_schema'
      : isPlainObject(format) && format.type === 'json_object'
        ? 'json_object'
        : 'other';
  return { requestedModel: payload.model, responseFormat };
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
export async function startProviderMeter(config, {
  budget = null,
  campaignReserve = null,
  requireRootOperation = false,
  requireDispatchPlans = false,
  maxAttemptsPerRootRequestClass = null
} = {}) {
  // Legacy stand-alone meter users have no operational authorization contract.
  // The v1.1 acceptance binding always supplies a validated budget; never default it there.
  const authorization = budget === null ? null : validateProviderBudget(budget);
  if (typeof requireRootOperation !== 'boolean') {
    throw new Error('requireRootOperation must be boolean');
  }
  if (typeof requireDispatchPlans !== 'boolean') {
    throw new Error('requireDispatchPlans must be boolean');
  }
  if (requireDispatchPlans && !requireRootOperation) {
    throw new Error('requireDispatchPlans requires root operation evidence');
  }
  if (maxAttemptsPerRootRequestClass !== null && (
    !Number.isSafeInteger(maxAttemptsPerRootRequestClass)
    || maxAttemptsPerRootRequestClass < 1
    || maxAttemptsPerRootRequestClass > 32
  )) {
    throw new Error('maxAttemptsPerRootRequestClass must be null or an integer from one through 32');
  }
  if (maxAttemptsPerRootRequestClass !== null && !requireRootOperation) {
    throw new Error('maxAttemptsPerRootRequestClass requires root operation evidence');
  }
  if (maxAttemptsPerRootRequestClass !== null && !requireDispatchPlans) {
    throw new Error('maxAttemptsPerRootRequestClass requires planned dispatch identity');
  }
  const { listener, upstream } = validateConfig(config);
  let ledger;
  let attempts;
  let plans;
  try {
    ledger = await open(config.ledgerPath, 'ax', 0o600);
    if (authorization !== null) attempts = await open(`${config.ledgerPath}.attempts.ndjson`, 'ax', 0o600);
    if (requireDispatchPlans) plans = await open(`${config.ledgerPath}.plans.ndjson`, 'ax', 0o600);
  } catch (error) {
    await ledger?.close();
    await plans?.close();
    await attempts?.close();
    if (error?.code === 'EEXIST') throw new Error('Provider meter ledger already exists');
    throw error;
  }

  const bindings = new Map();
  const dispatchPlans = new Map();
  const rootPlanKeys = new Set();
  const dynamicChildOrdinals = new Map();
  let state = 'STARTING';
  let nextRequestNumber = 1;
  let ledgerTail = Promise.resolve();
  let closePromise = null;
  let advertisedOrigin;
  const inFlight = new Set();
  const consumed = Object.fromEntries(REQUEST_CLASSES.map((name) => [name, 0]));
  const nativeAttemptCounts = new Map();
  let nextAttemptNumber = 1;
  let auditTail = Promise.resolve();
  let planTail = Promise.resolve();
  let evidenceFailure = null;
  let budgetStopped = false;

  function audit(record) {
    if (!attempts) return Promise.resolve();
    const operation = auditTail.then(async () => {
      if (evidenceFailure) throw evidenceFailure;
      await attempts.write(`${JSON.stringify({
        schema: 'shadowgraph.provider-meter.attempt', version: 1,
        recordedAt: new Date().toISOString(), ...record
      })}\n`);
      await attempts.sync();
    });
    auditTail = operation.catch((error) => { evidenceFailure = error; });
    return operation;
  }

  function opaqueDispatchId() {
    return randomBytes(24).toString('hex');
  }

  function rootPlanKey(binding) {
    return [
      binding.runId,
      binding.attemptId,
      binding.armId,
      binding.scenarioId,
      String(binding.repetition),
      binding.phase,
      binding.requestClass,
      binding.rootOperation,
      binding.rootInvocationId,
      binding.planSlot
    ].map((value) => `${value.length}:${value}`).join('|');
  }

  function appendPlan(record) {
    const operation = planTail.then(async () => {
      if (!plans || evidenceFailure) throw evidenceFailure ?? new Error('Provider meter plan ledger is unavailable');
      await plans.write(`${JSON.stringify({
        schema: 'shadowgraph.provider-meter.plan',
        version: 1,
        recordedAt: new Date().toISOString(),
        ...record
      })}\n`);
      await plans.sync();
    });
    planTail = operation.catch((error) => { evidenceFailure = error; });
    return operation;
  }

  async function createDispatchPlan(binding, routeId, {
    disposition = 'data-dependent-child',
    planSlot = null
  } = {}) {
    const childKey = rootPlanKey(binding);
    const ordinal = (dynamicChildOrdinals.get(childKey) ?? 0) + 1;
    dynamicChildOrdinals.set(childKey, ordinal);
    const plannedDispatchId = opaqueDispatchId();
    const alias = opaqueDispatchId();
    const plan = Object.freeze({
      plannedDispatchId,
      alias,
      rootInvocationId: binding.rootInvocationId,
      parentRootInvocationId: binding.rootInvocationId,
      rootPlanSlot: binding.planSlot,
      childRule: binding.identityMode === 'dynamic' ? 'data-dependent-before-send' : null,
      planSlot: planSlot ?? `${binding.planSlot}:child:${ordinal}`,
      disposition,
      recoveryOf: null,
      correlation: Object.freeze({
        runId: binding.runId,
        attemptId: binding.attemptId,
        armId: binding.armId,
        scenarioId: binding.scenarioId,
        repetition: binding.repetition,
        phase: binding.phase,
        requestClass: binding.requestClass,
        rootOperation: binding.rootOperation
      }),
      routeId,
      state: 'active'
    });
    await appendPlan({
      event: 'dispatch_plan',
      plannedDispatchId: plan.plannedDispatchId,
      alias: plan.alias,
      rootInvocationId: plan.rootInvocationId,
      parentRootInvocationId: plan.parentRootInvocationId,
      rootPlanSlot: plan.rootPlanSlot,
      childRule: plan.childRule,
      planSlot: plan.planSlot,
      disposition: plan.disposition,
      recoveryOf: plan.recoveryOf,
      correlation: plan.correlation
    });
    dispatchPlans.set(plan.alias, plan);
    return plan;
  }

  async function closeDispatchPlan(plan) {
    if (plan.state !== 'active') return false;
    await appendPlan({
      event: 'dispatch_closed',
      plannedDispatchId: plan.plannedDispatchId,
      alias: plan.alias,
      rootInvocationId: plan.rootInvocationId,
      planSlot: plan.planSlot
    });
    dispatchPlans.set(plan.alias, Object.freeze({ ...plan, state: 'closed' }));
    return true;
  }

  function reserveStaticDispatchPlan(plan) {
    if (plan.disposition !== 'root-initial' || plan.state !== 'active') return false;
    dispatchPlans.set(plan.alias, Object.freeze({ ...plan, state: 'consuming' }));
    return true;
  }

  async function consumeStaticDispatchPlan(plan) {
    await appendPlan({
      event: 'dispatch_consumed',
      plannedDispatchId: plan.plannedDispatchId,
      alias: plan.alias,
      rootInvocationId: plan.rootInvocationId,
      planSlot: plan.planSlot
    });
    dispatchPlans.set(plan.alias, Object.freeze({ ...plan, state: 'consumed' }));
  }

  async function recordPlanDenial(binding, code, dispatchPlan = null) {
    const correlation = {
      runId: binding.runId,
      attemptId: binding.attemptId,
      armId: binding.armId,
      scenarioId: binding.scenarioId,
      repetition: binding.repetition,
      phase: binding.phase,
      requestClass: binding.requestClass,
      rootOperation: binding.rootOperation
    };
    if (dispatchPlan !== null && (
      dispatchPlan.rootInvocationId !== binding.rootInvocationId
      || (binding.identityMode === 'static'
        ? dispatchPlan.planSlot !== binding.planSlot
        : dispatchPlan.rootPlanSlot !== binding.planSlot)
      || dispatchPlan.correlation?.runId !== correlation.runId
      || dispatchPlan.correlation?.attemptId !== correlation.attemptId
      || dispatchPlan.correlation?.armId !== correlation.armId
      || dispatchPlan.correlation?.scenarioId !== correlation.scenarioId
      || dispatchPlan.correlation?.repetition !== correlation.repetition
      || dispatchPlan.correlation?.phase !== correlation.phase
      || dispatchPlan.correlation?.requestClass !== correlation.requestClass
      || dispatchPlan.correlation?.rootOperation !== correlation.rootOperation
    )) {
      throw new Error('dispatch denial plan identity does not match its binding');
    }
    await appendPlan({
      event: 'dispatch_denied',
      code,
      rootInvocationId: binding.rootInvocationId,
      rootPlanSlot: binding.planSlot,
      planSlot: dispatchPlan?.planSlot ?? null,
      correlation,
      plannedDispatchId: dispatchPlan?.plannedDispatchId ?? null,
      alias: dispatchPlan?.alias ?? null,
      disposition: dispatchPlan?.disposition ?? null
    });
  }

  function appendCompletion({
    correlation,
    requestedModel,
    providerModel,
    latencyMs,
    outcome,
    failure,
    httpStatus,
    usage,
    responseFormat = null,
    dispatchPlan = null,
    campaignReservationId = null
  }) {
    const operation = ledgerTail.then(async () => {
      const event = {
        schema: 'shadowgraph.provider-meter.event',
        version: dispatchPlan === null ? 1 : 2,
        event: 'provider_request',
        requestNumber: nextRequestNumber,
        runId: correlation.runId,
        attemptId: correlation.attemptId,
        armId: correlation.armId,
        scenarioId: correlation.scenarioId,
        repetition: correlation.repetition,
        phase: correlation.phase,
        requestClass: correlation.requestClass,
        rootOperation: correlation.rootOperation,
        requestedModel,
        responseFormat,
        providerModel,
        latencyMs,
        outcome,
        failure,
        httpStatus,
        usage,
        ...(dispatchPlan === null ? {} : {
          rootInvocationId: dispatchPlan.rootInvocationId,
          plannedDispatchId: dispatchPlan.plannedDispatchId,
          planSlot: dispatchPlan.planSlot,
          dispatchAlias: dispatchPlan.alias,
          disposition: dispatchPlan.disposition,
          ...(campaignReservationId === null ? {} : { campaignReservationId })
        })
      };
      nextRequestNumber += 1;
      await ledger.write(`${JSON.stringify(event)}\n`);
      await ledger.sync();
      return event;
    });
    ledgerTail = operation.catch((error) => { evidenceFailure = error; });
    return operation;
  }

  function dispatchAliasFromRequest(request) {
    const value = request.headers[DISPATCH_ALIAS_HEADER];
    if (Array.isArray(value) || typeof value !== 'string' || !OPAQUE_DISPATCH_ID.test(value)) {
      return null;
    }
    return value;
  }

  function dispatchPlanForRequest(request, binding, routeId) {
    if (binding.identityMode === 'static') {
      if (request.headers[DISPATCH_ALIAS_HEADER] !== undefined) {
        return { code: 'STATIC_ALIAS_FORBIDDEN', denialPlan: binding.staticDispatchPlan };
      }
      const plan = dispatchPlans.get(binding.staticDispatchPlan.alias);
      if (!plan || plan.routeId !== routeId || plan.state !== 'active') {
        return { code: 'INVALID_OR_REUSED_DISPATCH_ALIAS', denialPlan: plan ?? binding.staticDispatchPlan };
      }
      return { plan };
    }
    const alias = dispatchAliasFromRequest(request);
    if (alias === null) return { code: 'MISSING_OR_MALFORMED_DISPATCH_ALIAS' };
    const plan = dispatchPlans.get(alias);
    if (!plan) return { code: 'UNKNOWN_DISPATCH_ALIAS' };
    if (plan.routeId !== routeId || plan.rootInvocationId !== binding.rootInvocationId) {
      return { code: 'INVALID_DISPATCH_ALIAS_BINDING' };
    }
    if (plan.state !== 'active') return { code: 'INVALID_OR_REUSED_DISPATCH_ALIAS', denialPlan: plan };
    return { plan };
  }

  function campaignReservationInput(correlation, dispatchPlan) {
    if (dispatchPlan === null) return correlation.requestClass;
    return {
      requestClass: correlation.requestClass,
      runId: correlation.runId,
      attemptId: correlation.attemptId,
      armId: correlation.armId,
      scenarioId: correlation.scenarioId,
      repetition: correlation.repetition,
      phase: correlation.phase,
      rootOperation: correlation.rootOperation,
      rootInvocationId: dispatchPlan.rootInvocationId,
      plannedDispatchId: dispatchPlan.plannedDispatchId,
      planSlot: dispatchPlan.planSlot,
      disposition: dispatchPlan.disposition
    };
  }

  async function denyPlannedRequest(response, binding, code, dispatchPlan = null) {
    try {
      await recordPlanDenial(binding, code, dispatchPlan);
    } catch {
      failureResponse(response);
      return;
    }
    boundedResponse(response, 403, Buffer.from('{"error":"dispatch_plan_denied"}'), {
      'content-type': 'application/json', connection: 'close'
    });
  }

  async function handlePlanEndpoint(request, response, resourcePath, binding, routeId) {
    if (resourcePath === '/__shadowgraph/declare') {
      if (request.method !== 'POST' || binding.identityMode !== 'dynamic'
        || request.headers[DISPATCH_ALIAS_HEADER] !== undefined) {
        await denyPlannedRequest(
          response,
          binding,
          'INVALID_DISPATCH_DECLARATION',
          binding.identityMode === 'static' ? binding.staticDispatchPlan : null
        );
        return true;
      }
      let plan;
      try {
        plan = await createDispatchPlan(binding, routeId);
      } catch {
        failureResponse(response);
        return true;
      }
      const body = Buffer.from(JSON.stringify({
        plannedDispatchId: plan.plannedDispatchId,
        alias: plan.alias
      }));
      boundedResponse(response, 201, body, { 'content-type': 'application/json' });
      return true;
    }
    if (resourcePath === '/__shadowgraph/close') {
      if (request.method !== 'POST' || binding.identityMode !== 'dynamic') {
        await denyPlannedRequest(
          response,
          binding,
          'INVALID_DISPATCH_CLOSE',
          binding.identityMode === 'static' ? binding.staticDispatchPlan : null
        );
        return true;
      }
      const alias = dispatchAliasFromRequest(request);
      if (alias === null) {
        await denyPlannedRequest(response, binding, 'MISSING_OR_MALFORMED_DISPATCH_ALIAS');
        return true;
      }
      const plan = dispatchPlans.get(alias);
      if (!plan) {
        await denyPlannedRequest(response, binding, 'UNKNOWN_DISPATCH_ALIAS');
        return true;
      }
      if (plan.routeId !== routeId || plan.rootInvocationId !== binding.rootInvocationId) {
        await denyPlannedRequest(response, binding, 'INVALID_DISPATCH_ALIAS_BINDING');
        return true;
      }
      if (plan.state !== 'active') {
        await denyPlannedRequest(response, binding, 'INVALID_OR_REUSED_DISPATCH_ALIAS', plan);
        return true;
      }
      try {
        await closeDispatchPlan(plan);
      } catch {
        failureResponse(response);
        return true;
      }
      boundedResponse(response, 204, Buffer.alloc(0));
      return true;
    }
    return false;
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

    if (requireDispatchPlans && await handlePlanEndpoint(request, response, resourcePath, correlation, routeId)) {
      return;
    }
    let dispatchPlan = null;
    if (requireDispatchPlans) {
      const identity = dispatchPlanForRequest(request, correlation, routeId);
      if (identity.code) {
        await denyPlannedRequest(response, correlation, identity.code, identity.denialPlan ?? null);
        return;
      }
      dispatchPlan = identity.plan;
      if (dispatchPlan.disposition === 'root-initial') {
        if (!reserveStaticDispatchPlan(dispatchPlan)) {
          await denyPlannedRequest(response, correlation, 'INVALID_OR_REUSED_DISPATCH_ALIAS', dispatchPlan);
          return;
        }
        try {
          await consumeStaticDispatchPlan(dispatchPlan);
        } catch {
          failureResponse(response);
          return;
        }
      }
    }

    const started = performance.now();
    const attemptNumber = nextAttemptNumber++;
    const attemptCorrelation = dispatchPlan === null ? correlation : {
      ...correlation,
      rootInvocationId: dispatchPlan.rootInvocationId,
      plannedDispatchId: dispatchPlan.plannedDispatchId,
      planSlot: dispatchPlan.planSlot,
      dispatchAlias: dispatchPlan.alias,
      disposition: dispatchPlan.disposition
    };
    // Reserve synchronously before any await, including journal I/O. Failures
    // and malformed admitted requests consume slots; none are refunded.
    const rootAttemptKey = rootRequestClassKey(attemptCorrelation);
    const attemptsSoFar = nativeAttemptCounts.get(rootAttemptKey) ?? 0;
    const nativeCapDenied = maxAttemptsPerRootRequestClass !== null
      && attemptsSoFar >= maxAttemptsPerRootRequestClass;
    // Count before any await and never refund. A campaign/budget rejection is
    // still a native attempt at this root/class; only a cap denial occurs before
    // the new attempt can enter the bounded native sequence.
    if (!nativeCapDenied && maxAttemptsPerRootRequestClass !== null) {
      nativeAttemptCounts.set(rootAttemptKey, attemptsSoFar + 1);
    }
    let admitted = !nativeCapDenied && (authorization === null || (!budgetStopped && !evidenceFailure
      && consumed[correlation.requestClass] < authorization.limits[correlation.requestClass]));
    let campaignReservationId = null;
    if (admitted) consumed[correlation.requestClass] += 1;
    if (admitted && campaignReserve !== null) {
      try {
        const reservation = await campaignReserve(campaignReservationInput(correlation, dispatchPlan));
        if (reservation === false) {
          admitted = false;
        } else if (dispatchPlan !== null) {
          if (reservation === null || typeof reservation !== 'object'
            || Object.keys(reservation).length !== 1
            || !CAMPAIGN_RESERVATION_ID.test(reservation.reservationId)) {
            admitted = false;
          } else {
            campaignReservationId = reservation.reservationId;
          }
        } else if (reservation !== true) {
          admitted = false;
        }
      } catch {
        admitted = false;
      }
    }
    if (!admitted && !nativeCapDenied) budgetStopped = true;
    await audit({ event: 'admission', attemptNumber, correlation: attemptCorrelation, admitted,
      authorizationRef: authorization?.authorizationRef ?? null, campaignReservationId });
    const appendEvent = async (event) => {
      const completion = await appendCompletion({ ...event, dispatchPlan, campaignReservationId });
      await audit({ event: 'completion', attemptNumber, requestNumber: completion.requestNumber,
        outcome: completion.outcome });
      return completion;
    };
    if (!admitted) {
      await appendEvent({ correlation, requestedModel: null, providerModel: null,
        latencyMs: elapsedSince(started), outcome: 'FAILED',
        failure: nativeCapDenied
          ? { code: 'NATIVE_ATTEMPT_CAP_EXHAUSTED', message: 'Native root request-class ceiling reached; dispatch denied' }
          : { code: 'PROVIDER_BUDGET_EXHAUSTED', message: 'Operational safety ceiling reached; dispatch denied' },
        httpStatus: null, usage: null });
      boundedResponse(response, 403, Buffer.from('{"error":"provider_budget_exhausted"}'), {
        'content-type': 'application/json', connection: 'close'
      });
      return;
    }
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
    const boundResource = boundResourcePath(resourcePath);
    if (boundResource !== RESOURCE_BY_REQUEST_CLASS[correlation.requestClass]) {
      await rejectBoundRequest(400);
      return;
    }
    if (declaredBodyExceedsLimit(request, MAX_REQUEST_BYTES)) {
      await rejectBoundRequest(400);
      return;
    }

    let body;
    let requestedModel;
    let responseFormat = null;
    let target;
    try {
      const inboundTimeoutMs = remainingDeadlineMs();
      if (inboundTimeoutMs < 1) throw codedError('PROVIDER_REQUEST_TIMEOUT');
      body = await readBoundedBody(request, MAX_REQUEST_BYTES, inboundTimeoutMs);
      ({ requestedModel, responseFormat } = parseRequestMetadata(body));
      // The normalised resource, not the client's spelling. The upstream base
      // already carries its own version segment, so forwarding a client's
      // `/v1/embeddings` verbatim would ask it for `/v1/v1/embeddings`.
      target = resourceTarget(upstream, boundResource, incoming.search);
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
      // Write-ahead intent is not proof of upstream receipt. An interrupted
      // intent without completion remains UNKNOWN, not a successful request.
      await audit({ event: 'dispatch_intent', attemptNumber });
      // A concurrent completion may fail while the audit write/sync awaits.
      // Recheck the sticky failure at the last synchronous dispatch boundary.
      if (evidenceFailure) throw evidenceFailure;
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
        responseFormat,
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
        responseFormat,
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
        responseFormat,
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
        responseFormat,
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
        responseFormat,
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
        responseFormat,
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
      responseFormat,
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
    if (authorization !== null) await audit({ event: 'authorization', budget: authorization });
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
    await attempts?.close();
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
    const correlation = validateBinding(input, requireRootOperation);
    if (authorization !== null) validateProviderBudget(authorization, correlation);
    let routeId;
    do routeId = randomBytes(24).toString('hex'); while (bindings.has(routeId));
    bindings.set(routeId, correlation);
    return `${advertisedOrigin}${ROUTE_PREFIX}${routeId}`;
  }

  async function bindPlannedEndpoint(input) {
    if (!requireDispatchPlans) {
      throw new Error('Provider meter was not started with required dispatch plans');
    }
    if (state !== 'OPEN') throw new Error('Provider meter is closed');
    const binding = validatePlannedBinding(input);
    if (authorization !== null) validateProviderBudget(authorization, binding);
    const key = rootPlanKey(binding);
    if (rootPlanKeys.has(key)) throw new Error('Duplicate provider meter root plan');
    let routeId;
    do routeId = randomBytes(24).toString('hex'); while (bindings.has(routeId));
    await appendPlan({
      event: 'root_plan',
      rootInvocationId: binding.rootInvocationId,
      planSlot: binding.planSlot,
      identityMode: binding.identityMode,
      childRule: binding.identityMode === 'dynamic' ? 'data-dependent-before-send' : null,
      correlation: {
        runId: binding.runId,
        attemptId: binding.attemptId,
        armId: binding.armId,
        scenarioId: binding.scenarioId,
        repetition: binding.repetition,
        phase: binding.phase,
        requestClass: binding.requestClass,
        rootOperation: binding.rootOperation
      }
    });
    let bound = binding;
    if (binding.identityMode === 'static') {
      const staticDispatchPlan = await createDispatchPlan(binding, routeId, {
        disposition: 'root-initial',
        planSlot: binding.planSlot
      });
      bound = Object.freeze({ ...binding, staticDispatchPlan });
    }
    rootPlanKeys.add(key);
    bindings.set(routeId, bound);
    const endpoint = `${advertisedOrigin}${ROUTE_PREFIX}${routeId}`;
    return Object.freeze({
      endpoint,
      declareEndpoint: `${endpoint}/__shadowgraph/declare`,
      closeEndpoint: `${endpoint}/__shadowgraph/close`
    });
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
      await auditTail;
      await planTail;
      await ledger.close();
      await attempts?.close();
      await plans?.close();
      bindings.clear();
      dispatchPlans.clear();
      state = 'CLOSED';
      if (evidenceFailure) throw evidenceFailure;
    })();
    return closePromise;
  }

  return Object.freeze({ bindEndpoint, bindPlannedEndpoint, close });
}
