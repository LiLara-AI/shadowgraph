const CONFIG_FIELDS = [
  'endpoint',
  'apiKey',
  'model',
  'seed',
  'temperature',
  'maxOutputTokens',
  'timeoutMs'
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

const REQUEST_FIELDS = ['system', 'prompt', 'responseSchema'];
const RESPONSE_TYPES = new Set(['string', 'string|null', 'string[]', 'boolean|null']);
const HEADER_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

export const STANDARD_DECISION_RESPONSE_SCHEMA = Object.freeze({
  decisionId: 'string|null',
  choiceId: 'string|null',
  recalledAlternativeIds: 'string[]',
  recalledRejectionReasonIds: 'string[]',
  constraintIdsAddressed: 'string[]',
  evidenceIdsCited: 'string[]',
  riskIdsRecognized: 'string[]',
  reviewTriggerIds: 'string[]',
  changedFactDetected: 'boolean|null',
  changedFactId: 'string|null',
  recommendation: 'string',
  failedAttemptIdsAvoided: 'string[]',
  failedAttemptReasonIdsCited: 'string[]',
  memoryProjectId: 'string|null',
  memoryUserId: 'string|null'
});

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

function assertNonEmptyString(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`${label} must be a non-empty string`);
}

function validateResponseSchema(responseSchema) {
  if (!isPlainObject(responseSchema) || Object.keys(responseSchema).length === 0) {
    throw new Error('responseSchema must be a non-empty object');
  }
  assertExactKeys(responseSchema, Object.keys(STANDARD_DECISION_RESPONSE_SCHEMA), 'responseSchema');
  for (const [field, type] of Object.entries(responseSchema)) {
    assertNonEmptyString(field, 'responseSchema field name');
    if (!RESPONSE_TYPES.has(type)) throw new Error(`Unsupported responseSchema type for ${field}: ${type}`);
    if (type !== STANDARD_DECISION_RESPONSE_SCHEMA[field]) {
      throw new Error(`responseSchema type for ${field} must equal ${STANDARD_DECISION_RESPONSE_SCHEMA[field]}`);
    }
  }
}

function validateRequest(request) {
  assertExactKeys(request, REQUEST_FIELDS, 'outer request');
  assertNonEmptyString(request.system, 'outer request.system');
  assertNonEmptyString(request.prompt, 'outer request.prompt');
  validateResponseSchema(request.responseSchema);
}

function validateConfig(config) {
  assertExactKeys(config, CONFIG_FIELDS, 'outer config');
  assertNonEmptyString(config.endpoint, 'outer config.endpoint');
  let endpoint;
  try {
    endpoint = new URL(config.endpoint);
  } catch {
    throw new Error('outer config.endpoint must be a valid URL');
  }
  if (!['http:', 'https:'].includes(endpoint.protocol)) {
    throw new Error('outer config.endpoint must use HTTP or HTTPS');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('outer config.endpoint must not contain credentials, query parameters, or fragments');
  }
  if (config.apiKey !== null && !isNonEmptyString(config.apiKey)) {
    throw new Error('outer config.apiKey must be null or a non-empty string');
  }
  assertNonEmptyString(config.model, 'outer config.model');
  if (!Number.isSafeInteger(config.seed) || config.seed < 0) {
    throw new Error('outer config.seed must be a non-negative safe integer');
  }
  if (!Number.isFinite(config.temperature) || config.temperature < 0 || config.temperature > 2) {
    throw new Error('outer config.temperature must be a finite number from 0 through 2');
  }
  if (!Number.isSafeInteger(config.maxOutputTokens) || config.maxOutputTokens < 1) {
    throw new Error('outer config.maxOutputTokens must be a positive safe integer');
  }
  if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1) {
    throw new Error('outer config.timeoutMs must be a positive safe integer');
  }
}

function validateCorrelation(correlation) {
  assertExactKeys(correlation, CORRELATION_FIELDS, 'outer correlation');
  for (const field of ['runId', 'attemptId', 'armId', 'scenarioId', 'phase']) {
    if (!isNonEmptyString(correlation[field]) || !HEADER_SAFE_ID.test(correlation[field])) {
      throw new Error(`outer correlation.${field} must be a header-safe identifier`);
    }
  }
  if (!Number.isSafeInteger(correlation.repetition) || correlation.repetition < 0) {
    throw new Error('outer correlation.repetition must be a non-negative safe integer');
  }
  if (correlation.requestClass !== 'outer_decision_llm') {
    throw new Error('outer correlation.requestClass must equal outer_decision_llm');
  }
}

function textDescriptor(value, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  assertNonEmptyString(value.id, `${label}.id`);
  const text = value.text ?? value.label;
  assertNonEmptyString(text, `${label}.text`);
  return { id: value.id, text };
}

function idDescriptors(scenario, objectsKey, idsKey, label) {
  const byId = new Map();
  const ids = scenario[idsKey] ?? [];
  if (!Array.isArray(ids) || !ids.every(isNonEmptyString)) {
    throw new Error(`scenario.${idsKey} must be an array of non-empty strings`);
  }
  for (const id of ids) byId.set(id, { id });

  const objects = scenario[objectsKey] ?? [];
  if (!Array.isArray(objects)) throw new Error(`scenario.${objectsKey} must be an array when present`);
  for (const value of objects) {
    if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
    assertNonEmptyString(value.id, `${label}.id`);
    if (value.text === undefined) byId.set(value.id, { id: value.id });
    else {
      assertNonEmptyString(value.text, `${label}.text`);
      byId.set(value.id, { id: value.id, text: value.text });
    }
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function sortedDescriptors(values, label) {
  if (!Array.isArray(values)) throw new Error(`${label} must be an array`);
  const descriptors = values.map((value, index) => textDescriptor(value, `${label}[${index}]`));
  const ids = descriptors.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error(`${label} must not contain duplicate ids`);
  return descriptors.sort((left, right) => left.id.localeCompare(right.id));
}

function optionDescriptors(scenario) {
  const alternatives = scenario.alternatives;
  if (!Array.isArray(alternatives)) throw new Error('scenario.alternatives must be an array');
  return sortedDescriptors([scenario.choice, ...alternatives], 'scenario options');
}

function rejectionReasonDescriptors(scenario) {
  if (!Array.isArray(scenario.alternatives)) throw new Error('scenario.alternatives must be an array');
  const reasons = scenario.alternatives.map((alternative, index) => {
    if (!isPlainObject(alternative)) throw new Error(`scenario.alternatives[${index}] must be an object`);
    assertNonEmptyString(alternative.id, `scenario.alternatives[${index}].id`);
    assertNonEmptyString(alternative.reasonId, `scenario.alternatives[${index}].reasonId`);
    assertNonEmptyString(alternative.reason, `scenario.alternatives[${index}].reason`);
    return { id: alternative.reasonId, optionId: alternative.id, text: alternative.reason };
  });
  const ids = reasons.map(({ id }) => id);
  if (new Set(ids).size !== ids.length) throw new Error('scenario rejection reasons must not contain duplicate ids');
  return reasons.sort((left, right) => left.id.localeCompare(right.id));
}

function validateReviewTrigger(reviewTrigger) {
  if (!isPlainObject(reviewTrigger)) throw new Error('scenario.reviewTrigger must be an object');
  for (const field of ['id', 'key', 'operator']) {
    assertNonEmptyString(reviewTrigger[field], `scenario.reviewTrigger.${field}`);
  }
  if (!Object.hasOwn(reviewTrigger, 'value') || reviewTrigger.value === undefined) {
    throw new Error('scenario.reviewTrigger.value is required');
  }
  try {
    JSON.stringify(reviewTrigger.value);
  } catch {
    throw new Error('scenario.reviewTrigger.value must be JSON serializable');
  }
  return {
    id: reviewTrigger.id,
    key: reviewTrigger.key,
    operator: reviewTrigger.operator,
    value: reviewTrigger.value
  };
}

function chatCompletionsEndpoint(base) {
  const endpoint = new URL(base);
  const path = endpoint.pathname.replace(/\/+$/u, '');
  endpoint.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
  return endpoint.toString();
}

function validateDecision(decision, responseSchema) {
  assertExactKeys(decision, Object.keys(responseSchema), 'decision response');
  for (const [field, type] of Object.entries(responseSchema)) {
    const value = decision[field];
    if (type === 'string' && typeof value !== 'string') {
      throw new Error(`decision response.${field} must be a string`);
    }
    if (type === 'string|null' && value !== null && typeof value !== 'string') {
      throw new Error(`decision response.${field} must be a string or null`);
    }
    if (type === 'boolean|null' && value !== null && typeof value !== 'boolean') {
      throw new Error(`decision response.${field} must be a boolean or null`);
    }
    if (type === 'string[]' && (!Array.isArray(value) || !value.every((item) => typeof item === 'string'))) {
      throw new Error(`decision response.${field} must be an array of strings`);
    }
  }
}

export function validateDecisionResponse(decision) {
  validateDecision(decision, STANDARD_DECISION_RESPONSE_SCHEMA);
}

function parseProviderPayload(text) {
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Outer model provider returned malformed JSON');
  }
  if (!isPlainObject(payload)) throw new Error('Outer model provider response must be an object');
  if (!Array.isArray(payload.choices) || payload.choices.length !== 1) {
    throw new Error('Outer model provider response must contain exactly one choice');
  }
  const message = payload.choices[0]?.message;
  if (!isPlainObject(message) || typeof message.content !== 'string') {
    throw new Error('Outer model provider choice must contain string message content');
  }
  if (payload.model !== undefined && !isNonEmptyString(payload.model)) {
    throw new Error('Outer model provider model must be a non-empty string when present');
  }
  if (payload.usage !== undefined && payload.usage !== null && !isPlainObject(payload.usage)) {
    throw new Error('Outer model provider usage must be an object or null when present');
  }
  return payload;
}

/**
 * Build the common Phase A decision request from an allowlist of scenario inputs.
 * Choice and alternative fixture labels are deliberately flattened and sorted as
 * equal candidate options; hidden scoring and lifecycle fields are never read.
 */
export function buildPhaseARequest({ scenario, system, responseSchema }) {
  if (!isPlainObject(scenario)) throw new Error('scenario must be an object');
  for (const field of ['id', 'projectId', 'userId', 'task']) {
    assertNonEmptyString(scenario[field], `scenario.${field}`);
  }
  assertNonEmptyString(system, 'system');
  validateResponseSchema(responseSchema);

  const options = optionDescriptors(scenario);
  const rejectionReasons = rejectionReasonDescriptors(scenario);
  const constraints = sortedDescriptors(scenario.constraints, 'scenario.constraints');
  const assumptions = idDescriptors(scenario, 'assumptions', 'assumptionIds', 'scenario assumption');
  const evidence = sortedDescriptors(scenario.evidence, 'scenario.evidence');
  const risks = idDescriptors(scenario, 'risks', 'riskIds', 'scenario risk');
  const reviewTrigger = validateReviewTrigger(scenario.reviewTrigger);

  const prompt = [
    `Phase A fresh decision for scenario ${scenario.id}.`,
    `Project ID: ${scenario.projectId}`,
    `User ID: ${scenario.userId}`,
    `Task: ${scenario.task}`,
    `Candidate options: ${JSON.stringify(options)}`,
    `Rejection reasons: ${JSON.stringify(rejectionReasons)}`,
    `Assumptions: ${JSON.stringify(assumptions)}`,
    `Evidence: ${JSON.stringify(evidence)}`,
    `Risks: ${JSON.stringify(risks)}`,
    `Review trigger: ${JSON.stringify(reviewTrigger)}`,
    `Constraints: ${JSON.stringify(constraints)}`,
    'Choose an option using only these inputs and return the requested JSON object.'
  ].join('\n');

  return { system, prompt, responseSchema: { ...responseSchema } };
}

/**
 * Make one measured outer-decision request. There is intentionally no retry loop
 * and no response repair or fixture-derived fallback.
 */
export async function requestOuterDecision({ fetchImpl, config, correlation, request }) {
  if (typeof fetchImpl !== 'function') throw new Error('Outer decision request requires fetchImpl');
  validateConfig(config);
  validateCorrelation(correlation);
  validateRequest(request);

  const headers = {
    'content-type': 'application/json',
    'x-shadowgraph-run-id': correlation.runId,
    'x-shadowgraph-attempt-id': correlation.attemptId,
    'x-shadowgraph-arm-id': correlation.armId,
    'x-shadowgraph-scenario-id': correlation.scenarioId,
    'x-shadowgraph-repetition': String(correlation.repetition),
    'x-shadowgraph-phase': correlation.phase,
    'x-shadowgraph-request-class': correlation.requestClass
  };
  if (config.apiKey !== null) headers.authorization = `Bearer ${config.apiKey}`;

  const schemaInstruction = `Return exactly one JSON object with this field contract: ${JSON.stringify(request.responseSchema)}`;
  const body = {
    model: config.model,
    seed: config.seed,
    temperature: config.temperature,
    max_tokens: config.maxOutputTokens,
    n: 1,
    stream: false,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: request.system },
      { role: 'user', content: `${request.prompt}\n\n${schemaInstruction}` }
    ]
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  timer.unref?.();
  let response;
  let responseText;
  try {
    response = await fetchImpl(chatCompletionsEndpoint(config.endpoint), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });
    if (!response || typeof response.ok !== 'boolean' || !Number.isInteger(response.status) || typeof response.text !== 'function') {
      throw new Error('Outer model provider returned an invalid HTTP response');
    }
    if (!response.ok) throw new Error(`Outer model provider HTTP ${response.status}`);
    responseText = await response.text();
  } finally {
    clearTimeout(timer);
  }

  const payload = parseProviderPayload(responseText);
  let decision;
  try {
    decision = JSON.parse(payload.choices[0].message.content);
  } catch {
    throw new Error('Outer model decision content must be strict JSON without wrappers');
  }
  validateDecision(decision, request.responseSchema);

  return {
    decision,
    usage: payload.usage ?? null,
    providerModel: payload.model ?? null,
    requestCount: 1,
    correlation: { ...correlation }
  };
}
