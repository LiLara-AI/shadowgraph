import { REQUEST_CLASSES } from './v11-contract.mjs';

export const NATIVE_ROOT_OPERATIONS = Object.freeze([
  'reset', 'retrieve', 'persist', 'verify', 'outer-decision'
]);

const RECOVERY_CATEGORIES = new Set(['B', 'C', 'D']);
const RESPONSE_FORMATS = new Set([null, 'json_schema', 'json_object', 'other']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function assertExactKeys(value, expected, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set(expected);
  if (Object.keys(value).some((key) => !allowed.has(key))
    || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new Error(`${label} has an invalid field shape`);
  }
}

function rootKey(event) {
  return [
    event.runId,
    event.attemptId,
    event.armId,
    event.scenarioId,
    String(event.repetition),
    event.phase,
    event.rootOperation,
    event.requestClass
  ].map((value) => `${value.length}:${value}`).join('|');
}

function validateEvent(event, index) {
  if (!isPlainObject(event)) throw new Error(`native attempt event ${index} must be an object`);
  for (const field of ['runId', 'attemptId', 'armId', 'scenarioId', 'phase', 'rootOperation', 'requestClass']) {
    if (!isNonEmptyString(event[field]) || !SAFE_ID.test(event[field])) {
      throw new Error(`native attempt event ${index} has invalid correlation`);
    }
  }
  if (!Number.isSafeInteger(event.repetition) || event.repetition < 0
    || !Number.isSafeInteger(event.requestNumber) || event.requestNumber < 1) {
    throw new Error(`native attempt event ${index} has invalid numeric evidence`);
  }
  if (!NATIVE_ROOT_OPERATIONS.includes(event.rootOperation) || !REQUEST_CLASSES.includes(event.requestClass)) {
    throw new Error(`native attempt event ${index} has invalid native operation evidence`);
  }
  if (!['SUCCEEDED', 'FAILED'].includes(event.outcome) || !RESPONSE_FORMATS.has(event.responseFormat ?? null)) {
    throw new Error(`native attempt event ${index} has invalid observable outcome evidence`);
  }
}

/**
 * Validate the prospective, arm-neutral policy. A policy may permit B/C/D only
 * for an arm/class whose independently captured probe establishes that behavior;
 * this function governs the shape used by both the preflight proof verifier and
 * the live meter trace. It does not decide a product's behavior from its name.
 */
export function validateNativeAttemptPolicy(policy, armIds = null) {
  assertExactKeys(policy, [
    'schema', 'version', 'maxAttemptsPerRootRequestClass', 'arms'
  ], 'native attempt policy');
  if (policy.schema !== 'shadowgraph.v11.native-attempt-policy' || policy.version !== 1
    || !Number.isSafeInteger(policy.maxAttemptsPerRootRequestClass)
    || policy.maxAttemptsPerRootRequestClass < 1
    || policy.maxAttemptsPerRootRequestClass > 32
    || !Array.isArray(policy.arms)) {
    throw new Error('native attempt policy is invalid');
  }
  const policies = new Map();
  for (const arm of policy.arms) {
    assertExactKeys(arm, ['armId', 'recovery'], 'native attempt arm policy');
    if (!isNonEmptyString(arm.armId) || policies.has(arm.armId) || !isPlainObject(arm.recovery)) {
      throw new Error('native attempt policy arms are invalid');
    }
    if (Object.keys(arm.recovery).sort().join('|') !== [...REQUEST_CLASSES].sort().join('|')) {
      throw new Error('native attempt policy must cover every provider request class');
    }
    const recovery = {};
    for (const requestClass of REQUEST_CLASSES) {
      const categories = arm.recovery[requestClass];
      if (!Array.isArray(categories)
        || new Set(categories).size !== categories.length
        || categories.some((category) => !RECOVERY_CATEGORIES.has(category))) {
        throw new Error('native attempt policy recovery categories are invalid');
      }
      recovery[requestClass] = Object.freeze([...categories]);
    }
    policies.set(arm.armId, Object.freeze(recovery));
  }
  if (armIds !== null) {
    if (!Array.isArray(armIds) || new Set(armIds).size !== armIds.length
      || armIds.some((armId) => !policies.has(armId))
      || policies.size !== armIds.length) {
      throw new Error('native attempt policy does not cover the exact benchmark arm set');
    }
  }
  return Object.freeze({
    maxAttemptsPerRootRequestClass: policy.maxAttemptsPerRootRequestClass,
    policies
  });
}

/**
 * Derive a safe, meter-owned trace. B is observable after a failed prior wire
 * attempt; D is observable when a successful prior attempt changes output mode;
 * C is the remaining same-mode successful follow-up and is accepted only when
 * an independent probe has authorized C for the same arm/class. E is never
 * inferred away: both requested and provider model must equal the locked model.
 */
export function traceNativeAttempts({ events, expectedModels, policy, armIds = null }) {
  if (!Array.isArray(events) || !isPlainObject(expectedModels)) {
    throw new Error('native attempt trace requires events and expected models');
  }
  const validatedPolicy = validateNativeAttemptPolicy(policy, armIds);
  for (const requestClass of REQUEST_CLASSES) {
    if (!isNonEmptyString(expectedModels[requestClass])) {
      throw new Error('native attempt trace requires every pinned model id');
    }
  }
  const findings = [];
  const trace = [];
  const groups = new Map();
  const seenRequestNumbers = new Set();
  const ordered = [...events].sort((left, right) => left.requestNumber - right.requestNumber);
  for (const [index, event] of ordered.entries()) {
    validateEvent(event, index + 1);
    if (seenRequestNumbers.has(event.requestNumber)) {
      findings.push({ code: 'DUPLICATE_REQUEST_NUMBER', requestNumber: event.requestNumber });
      continue;
    }
    seenRequestNumbers.add(event.requestNumber);
    const recovery = validatedPolicy.policies.get(event.armId)?.[event.requestClass];
    if (recovery === undefined) {
      findings.push({ code: 'UNPOLICIED_ARM_OR_CLASS', requestNumber: event.requestNumber });
      continue;
    }
    const key = rootKey(event);
    const prior = groups.get(key) ?? [];
    const sequence = prior.length + 1;
    let category = 'INITIAL';
    if (sequence > 1) {
      if (prior.at(-1).outcome === 'FAILED') category = 'B';
      else if ((prior.at(-1).responseFormat ?? null) !== (event.responseFormat ?? null)) category = 'D';
      else category = 'C';
    }
    const expectedModel = expectedModels[event.requestClass];
    // A transport failure has no provider response model to attest. `null` is
    // the meter's explicit unavailable-evidence value, not evidence of E
    // fallback. Successful events still require the pinned provider model, and
    // any non-null failed model must agree with it.
    const providerModelMatches = event.outcome === 'FAILED'
      ? event.providerModel === null || event.providerModel === expectedModel
      : event.providerModel === expectedModel;
    if (event.requestedModel !== expectedModel || !providerModelMatches) {
      findings.push({ code: 'MODEL_OR_PROVIDER_FALLBACK', requestNumber: event.requestNumber });
      category = 'E';
    }
    if (sequence > validatedPolicy.maxAttemptsPerRootRequestClass) {
      findings.push({ code: 'ROOT_CLASS_ATTEMPT_CAP_EXCEEDED', requestNumber: event.requestNumber });
    }
    if (RECOVERY_CATEGORIES.has(category) && !recovery.includes(category)) {
      findings.push({ code: 'UNAUTHORIZED_NATIVE_RECOVERY', requestNumber: event.requestNumber, category });
    }
    const entry = Object.freeze({
      requestNumber: event.requestNumber,
      runId: event.runId,
      attemptId: event.attemptId,
      armId: event.armId,
      scenarioId: event.scenarioId,
      repetition: event.repetition,
      phase: event.phase,
      rootOperation: event.rootOperation,
      requestClass: event.requestClass,
      sequence,
      category,
      priorRequestNumber: prior.at(-1)?.requestNumber ?? null,
      outcome: event.outcome,
      responseFormat: event.responseFormat ?? null
    });
    prior.push(entry);
    groups.set(key, prior);
    trace.push(entry);
  }
  return Object.freeze({
    status: findings.length === 0 ? 'RECONCILED' : 'DISCREPANT',
    trace: Object.freeze(trace),
    findings: Object.freeze(findings)
  });
}
