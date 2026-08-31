import {
  ADAPTER_OPERATIONS,
  namespaceRefFor,
  validateAdapterEnvelope
} from './v11-contract.mjs';
import { validateDecisionResponse } from './outer-model.mjs';

const REQUEST_FIELDS = [
  'schemaVersion',
  'operation',
  'runId',
  'attemptId',
  'phase',
  'armId',
  'scenarioId',
  'repetition',
  'namespace',
  'namespaceRef',
  'payload'
];

const CORRELATION_FIELDS = [
  'runId',
  'attemptId',
  'phase',
  'armId',
  'scenarioId',
  'repetition'
];

const FORBIDDEN_KEYS = new Set([
  'apikey',
  'applicability',
  'authorization',
  'commonmodel',
  'commonexecution',
  'constraints',
  'credential',
  'choice',
  'alternatives',
  'assumptions',
  'assumptionids',
  'advertisedschemas',
  'auth',
  'changedfact',
  'decisionresponse',
  'domain',
  'embedding',
  'endpoint',
  'evidence',
  'expectedanswer',
  'expectedchoice',
  'expectedchoiceid',
  'fixture',
  'irrelevantfacts',
  'instructions',
  'isolationprojectid',
  'isolationuserid',
  'key',
  'llm',
  'maxoutputtokens',
  'maxretries',
  'messages',
  'model',
  'modelconfig',
  'outerdecisionmodelcalls',
  'outermodel',
  'password',
  'permission',
  'prompt',
  'requestclass',
  'responseformat',
  'responseschema',
  'retries',
  'reviewtrigger',
  'risks',
  'riskids',
  'schema',
  'scenario',
  'score',
  'scored',
  'seed',
  'secret',
  'system',
  'temperature',
  'timeoutms',
  'token',
  'unitstatus',
  'usage',
  'failedattempt'
]);

const OUTER_MODEL_INSTRUCTION = /\b(?:call|invoke|contact)\s+(?:the\s+)?(?:(?:common|central)\s+)?outer\s+(?:decision\s+)?model\b/iu;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
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

function validateNullableString(value, label) {
  if (value !== null && !isNonEmptyString(value)) {
    throw new Error(`${label} must be null or a non-empty string`);
  }
}

function validateNamespace(namespace, label = 'adapter request.namespace') {
  assertExactKeys(namespace, ['projectId', 'userId'], label);
  validateNullableString(namespace.projectId, `${label}.projectId`);
  validateNullableString(namespace.userId, `${label}.userId`);
}

function validateRecordReference(record, label) {
  assertExactKeys(record, ['id', 'type', 'contentSha256'], label);
  if (!isNonEmptyString(record.id)) throw new Error(`${label}.id must be a non-empty string`);
  if (!isNonEmptyString(record.type)) throw new Error(`${label}.type must be a non-empty string`);
  if (typeof record.contentSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(record.contentSha256)) {
    throw new Error(`${label}.contentSha256 must be a lowercase full SHA-256 digest`);
  }
}

function validatePlainTask(value, label) {
  if (!isNonEmptyString(value)) throw new Error(`${label} must be non-empty plain text`);
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    parsed = undefined;
  }
  if (isPlainObject(parsed) || Array.isArray(parsed)) {
    throw new Error(`${label} must be plain text, not a serialized fixture`);
  }
}

function forbiddenKey(key) {
  const normalized = normalizedKey(key);
  return FORBIDDEN_KEYS.has(normalized)
    || normalized.includes('outermodel')
    || normalized.endsWith('apikey')
    || normalized.endsWith('password')
    || normalized.endsWith('secret')
    || normalized.endsWith('credential')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('bearertoken')
    || normalized.endsWith('token');
}

function validateAdapterData(value, label, seen = new Set()) {
  if (typeof value === 'string') {
    if (OUTER_MODEL_INSTRUCTION.test(value)) {
      throw new Error(`${label} contains forbidden outer-model instructions`);
    }
    return;
  }
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${label} must contain finite JSON numbers`);
    return;
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error(`${label} must not contain circular data`);
    seen.add(value);
    value.forEach((item, index) => validateAdapterData(item, `${label}[${index}]`, seen));
    seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) throw new Error(`${label} must contain JSON-compatible data`);
  if (seen.has(value)) throw new Error(`${label} must not contain circular data`);
  seen.add(value);
  for (const [key, child] of Object.entries(value)) {
    if (forbiddenKey(key)) throw new Error(`${label} contains forbidden field: ${key}`);
    if (child === undefined) throw new Error(`${label}.${key} must not be undefined`);
    validateAdapterData(child, `${label}.${key}`, seen);
  }
  seen.delete(value);
}

function validateCorrelation(correlation) {
  assertExactKeys(correlation, CORRELATION_FIELDS, 'adapter correlation');
  for (const field of ['runId', 'attemptId', 'phase', 'armId', 'scenarioId']) {
    if (!isNonEmptyString(correlation[field])) {
      throw new Error(`adapter correlation.${field} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(correlation.repetition) || correlation.repetition < 0) {
    throw new Error('adapter correlation.repetition must be a non-negative safe integer');
  }
}

function correlationFromRequest(request) {
  return Object.fromEntries(CORRELATION_FIELDS.map((field) => [field, request[field]]));
}

function namespaceCorrelation(value) {
  return Object.fromEntries(
    ['runId', 'armId', 'scenarioId', 'repetition', 'phase'].map((field) => [field, value[field]])
  );
}

function sameRecordReference(left, right) {
  return left?.id === right?.id
    && left?.type === right?.type
    && left?.contentSha256 === right?.contentSha256;
}

function validatePayload(operation, payload, request) {
  if (!isPlainObject(payload)) throw new Error('adapter request.payload must be an object');
  if (operation === 'reset') {
    assertExactKeys(payload, [], 'reset payload');
  } else if (operation === 'retrieve') {
    assertExactKeys(payload, ['query'], 'retrieve payload');
    assertExactKeys(payload.query, ['scenarioId', 'task'], 'retrieve payload.query');
    if (payload.query.scenarioId !== request.scenarioId) {
      throw new Error('retrieve payload.query.scenarioId must match adapter request correlation');
    }
    validatePlainTask(payload.query.task, 'retrieve payload.query.task');
  } else if (operation === 'persist') {
    assertExactKeys(payload, ['record'], 'persist payload');
    assertExactKeys(payload.record, ['id', 'type', 'content'], 'persist payload.record');
    if (!isNonEmptyString(payload.record.id)) throw new Error('persist payload.record.id must be a non-empty string');
    if (!isNonEmptyString(payload.record.type)) throw new Error('persist payload.record.type must be a non-empty string');
    if (!isPlainObject(payload.record.content)) throw new Error('persist payload.record.content must be an object');
    if (payload.record.type === 'decision') {
      validateDecisionResponse(payload.record.content);
    } else if (payload.record.type === 'failed_attempt') {
      assertExactKeys(payload.record.content, ['id', 'approachId', 'reasonId', 'reason'], 'failed attempt record content');
      for (const field of ['id', 'approachId', 'reasonId', 'reason']) {
        if (!isNonEmptyString(payload.record.content[field])) {
          throw new Error(`failed attempt record content.${field} must be a non-empty string`);
        }
      }
      if (payload.record.id !== payload.record.content.id) {
        throw new Error('failed attempt record id must match its content id');
      }
    } else {
      throw new Error('persist payload.record.type must be decision or failed_attempt');
    }
  } else if (operation === 'verify') {
    assertExactKeys(
      payload,
      ['expectedRecord', 'alternateNamespace', 'alternateNamespaceRef', 'expectedAbsentRecord'],
      'verify payload'
    );
    validateRecordReference(payload.expectedRecord, 'verify payload.expectedRecord');
    const hasIsolationProbe = payload.alternateNamespace !== null;
    if (hasIsolationProbe) {
      validateNamespace(payload.alternateNamespace, 'verify payload.alternateNamespace');
      validateRecordReference(payload.expectedAbsentRecord, 'verify payload.expectedAbsentRecord');
      const expectedAlternateRef = namespaceRefFor(
        namespaceCorrelation(request),
        payload.alternateNamespace
      );
      if (payload.alternateNamespaceRef !== expectedAlternateRef) {
        throw new Error('verify payload.alternateNamespaceRef does not match the alternate namespace and correlation');
      }
      if (payload.alternateNamespaceRef === request.namespaceRef) {
        throw new Error('verify payload alternate namespace must differ from the requested primary namespace');
      }
    } else if (payload.alternateNamespaceRef !== null || payload.expectedAbsentRecord !== null) {
      throw new Error('non-isolation verify payload requires null alternateNamespaceRef and expectedAbsentRecord');
    }
  }
  validateAdapterData(payload, 'adapter request.payload');
}

/**
 * Validate a memory-only adapter request. The exact allowlist intentionally has
 * no place for model configuration, fixture truth, prompts, usage, or unit status.
 */
export function validateAdapterRequest(request) {
  assertExactKeys(request, REQUEST_FIELDS, 'adapter request');
  if (request.schemaVersion !== 1) throw new Error('adapter request.schemaVersion must equal 1');
  if (!ADAPTER_OPERATIONS.includes(request.operation)) {
    throw new Error(`Invalid adapter request operation: ${request.operation}`);
  }
  validateCorrelation(correlationFromRequest(request));
  validateNamespace(request.namespace);
  const expectedNamespaceRef = namespaceRefFor(namespaceCorrelation(request), request.namespace);
  if (request.namespaceRef !== expectedNamespaceRef) {
    throw new Error('adapter request.namespaceRef does not match its namespace and correlation');
  }
  validatePayload(request.operation, request.payload, request);
}

export function createAdapterRequest({ operation, correlation, namespace, payload }) {
  validateCorrelation(correlation);
  const request = {
    schemaVersion: 1,
    operation,
    ...correlation,
    namespace,
    namespaceRef: namespaceRefFor(namespaceCorrelation(correlation), namespace),
    payload
  };
  validateAdapterRequest(request);
  return request;
}

/**
 * Validate both the strict v1.1 response envelope and its relationship to the
 * request. Decision output and final unit evidence remain outside this API.
 */
export function validateAdapterResponse({ request, response }) {
  validateAdapterRequest(request);
  validateAdapterEnvelope(response);
  for (const field of ['operation', ...CORRELATION_FIELDS]) {
    if (response[field] !== request[field]) {
      throw new Error(`Adapter response correlation mismatch for ${field}`);
    }
  }

  if (response.status === 'NOT_APPLICABLE') {
    const { nativeContext, persistenceEvidence, isolationEvidence } = response.result;
    if (nativeContext.length !== 0 || persistenceEvidence !== null || isolationEvidence !== null) {
      throw new Error('NOT_APPLICABLE adapter response must have an empty native result and no evidence');
    }
  }

  if (request.operation !== 'retrieve' && response.result.nativeContext.length !== 0) {
    throw new Error('Adapter response nativeContext is only allowed for retrieve');
  }
  if (request.operation !== 'verify'
    && (response.result.persistenceEvidence !== null || response.result.isolationEvidence !== null)) {
    throw new Error('Adapter response evidence is only allowed for verify');
  }

  const persistenceEvidence = response.result.persistenceEvidence;
  if (persistenceEvidence !== null && persistenceEvidence.namespaceRef !== request.namespaceRef) {
    throw new Error('Adapter response persistence evidence does not use the requested namespace reference');
  }
  if (request.operation === 'verify') {
    const expectedRecord = request.payload.expectedRecord;
    const expectedAbsentRecord = request.payload.expectedAbsentRecord;
    const alternateNamespace = request.payload.alternateNamespace;
    const alternateNamespaceRef = request.payload.alternateNamespaceRef;
    const isolationEvidence = response.result.isolationEvidence;

    if (persistenceEvidence !== null && !sameRecordReference(persistenceEvidence.expectedRecord, expectedRecord)) {
      throw new Error('Adapter verification response does not identify the requested record');
    }
    if (alternateNamespace !== null && isolationEvidence !== null
      && isolationEvidence.alternateNamespaceRef !== alternateNamespaceRef) {
      throw new Error('Adapter verification response does not use the requested alternate namespace reference');
    }
    if (alternateNamespace !== null && isolationEvidence !== null
      && !sameRecordReference(isolationEvidence.expectedAbsentRecord, expectedAbsentRecord)) {
      throw new Error('Adapter verification response does not identify the requested absent record target');
    }
    if (alternateNamespace === null && isolationEvidence !== null) {
      throw new Error('Adapter verification response includes unrequested isolation evidence');
    }

    const persistenceVerified = persistenceEvidence?.verified === true
      && persistenceEvidence.matchedRecordIds.length === 1
      && persistenceEvidence.matchedRecordIds[0] === expectedRecord.id
      && persistenceEvidence.observedContentSha256 === expectedRecord.contentSha256;
    const isolationVerified = alternateNamespace === null
      || (isolationEvidence?.verified === true
        && isolationEvidence.matchingRecordIdCount === 0
        && isolationEvidence.matchingContentCount === 0);

    if (response.status === 'SUCCEEDED') {
      if (!persistenceVerified) {
        throw new Error('SUCCEEDED adapter verification requires persistence verified for the requested record');
      }
      if (!isolationVerified) {
        throw new Error('SUCCEEDED adapter verification requires isolation verified with no matching ids or content');
      }
    }

    if (response.status === 'FAILED' && persistenceVerified && isolationVerified) {
      throw new Error('FAILED adapter response contradicts fully successful verification evidence');
    }

  }
}
