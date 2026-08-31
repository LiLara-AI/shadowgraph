// v1.1 Contract Kernel - Amendment 002 Implementation

export const UNIT_STATUSES = ['MEASURED', 'FAILED', 'NOT_MEASURED', 'EXCLUDED'];

export const ARM_STATUSES = ['MEASURED', 'PARTIAL_FAILED', 'FAILED', 'NOT_MEASURED', 'EXCLUDED'];

export const REQUEST_CLASSES = ['outer_decision_llm', 'internal_memory_llm', 'embedding'];

export const OPERATION_FIELDS = [
  'memoryReadOperations',
  'memoryWriteOperations',
  'mcpToolCalls',
  'outerDecisionModelCalls',
  'internalMemoryModelCalls',
  'embeddingCalls',
  'persistenceVerificationOperations'
];

export const ADAPTER_OPERATIONS = ['reset', 'retrieve', 'persist', 'verify'];

export const ADAPTER_STATUSES = ['SUCCEEDED', 'FAILED', 'NOT_APPLICABLE'];

export const ADAPTER_FAILURE_CAUSES = [
  'ENDPOINT_UNAVAILABLE',
  'ADAPTER_INVALID',
  'INFRASTRUCTURE_FAILURE',
  'CONTRACT_FAILURE',
  'OPERATOR_INTERRUPTION',
  'TIMEOUT',
  'OPERATION_FAILED'
];

const ADAPTER_ENVELOPE_FIELDS = [
  'schemaVersion',
  'operation',
  'runId',
  'attemptId',
  'phase',
  'armId',
  'scenarioId',
  'repetition',
  'status',
  'result',
  'failure',
  'operations',
  'storage'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expectedKeys, label) {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) {
      throw new Error(`Unknown ${label} field: ${key}`);
    }
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) {
      throw new Error(`Missing required ${label} field: ${key}`);
    }
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateNullableString(value, label) {
  if (value !== null && !isNonEmptyString(value)) {
    throw new Error(`${label} must be null or a non-empty string`);
  }
}

function validateNamespace(namespace, label) {
  if (!isPlainObject(namespace)) throw new Error(`${label} must be an object`);
  assertExactKeys(namespace, ['projectId', 'userId'], label);
  validateNullableString(namespace.projectId, `${label}.projectId`);
  validateNullableString(namespace.userId, `${label}.userId`);
}

function validateRecordReference(record, label) {
  if (!isPlainObject(record)) throw new Error(`${label} must be an object`);
  assertExactKeys(record, ['id', 'type'], label);
  if (!isNonEmptyString(record.id)) throw new Error(`${label}.id must be a non-empty string`);
  if (!isNonEmptyString(record.type)) throw new Error(`${label}.type must be a non-empty string`);
}

function validateStringArray(values, label) {
  if (!Array.isArray(values) || !values.every(isNonEmptyString)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}

function validatePersistenceEvidence(evidence) {
  if (evidence === null) return;
  if (!isPlainObject(evidence)) throw new Error('persistenceEvidence must be null or an object');
  assertExactKeys(evidence, ['verified', 'expectedRecord', 'matchedRecordIds', 'namespace'], 'persistenceEvidence');
  if (typeof evidence.verified !== 'boolean') throw new Error('persistenceEvidence.verified must be boolean');
  if (evidence.expectedRecord !== null) validateRecordReference(evidence.expectedRecord, 'persistenceEvidence.expectedRecord');
  validateStringArray(evidence.matchedRecordIds, 'persistenceEvidence.matchedRecordIds');
  validateNamespace(evidence.namespace, 'persistenceEvidence.namespace');
  if (evidence.verified && evidence.expectedRecord !== null && !evidence.matchedRecordIds.includes(evidence.expectedRecord.id)) {
    throw new Error('verified persistenceEvidence requires expectedRecord.id in matchedRecordIds');
  }
}

function validateIsolationEvidence(evidence) {
  if (evidence === null) return;
  if (!isPlainObject(evidence)) throw new Error('isolationEvidence must be null or an object');
  assertExactKeys(evidence, ['verified', 'alternateNamespace', 'leakedRecordIds'], 'isolationEvidence');
  if (typeof evidence.verified !== 'boolean') throw new Error('isolationEvidence.verified must be boolean');
  validateNamespace(evidence.alternateNamespace, 'isolationEvidence.alternateNamespace');
  validateStringArray(evidence.leakedRecordIds, 'isolationEvidence.leakedRecordIds');
  if (evidence.verified && evidence.leakedRecordIds.length > 0) {
    throw new Error('verified isolationEvidence requires empty leakedRecordIds');
  }
}

function validateAdapterResult(result) {
  if (!isPlainObject(result)) throw new Error('adapter result must be an object');
  assertExactKeys(result, ['nativeContext', 'persistenceEvidence', 'isolationEvidence'], 'adapter result');
  if (!Array.isArray(result.nativeContext) || !result.nativeContext.every(isPlainObject)) {
    throw new Error('adapter result.nativeContext must be an array of native record objects');
  }
  validatePersistenceEvidence(result.persistenceEvidence);
  validateIsolationEvidence(result.isolationEvidence);
}

function validateAdapterFailure(status, failure) {
  if (status === 'FAILED') {
    if (!isPlainObject(failure)) throw new Error('FAILED adapter response requires a structured failure');
    assertExactKeys(failure, ['cause', 'message'], 'adapter failure');
    if (!ADAPTER_FAILURE_CAUSES.includes(failure.cause)) throw new Error(`Invalid adapter failure cause: ${failure.cause}`);
    if (!isNonEmptyString(failure.message)) throw new Error('adapter failure.message must be a non-empty string');
    return;
  }
  if (failure !== null) throw new Error(`${status} adapter response must have null failure`);
}

/**
 * Derive arm status mechanically from unit statuses.
 * - All measured → MEASURED
 * - Measured plus failed/unavailable → PARTIAL_FAILED
 * - Failed with no measured units → FAILED
 * - All unavailable → NOT_MEASURED
 * - All EXCLUDED → EXCLUDED
 * - EXCLUDED is treated as genuinely non-applicable (ignored in derivation)
 * - Explicitly excluded → EXCLUDED
 */
export function deriveArmStatus(units, options = {}) {
  // Explicit arm-level exclusion
  if (options?.excluded === true) {
    return 'EXCLUDED';
  }

  // Validate input
  if (!Array.isArray(units)) {
    throw new Error('units must be an array');
  }

  if (units.length === 0) {
    return 'NOT_MEASURED';
  }

  // Validate all units and filter out EXCLUDED
  const validStatuses = new Set(UNIT_STATUSES);
  const nonExcludedUnits = [];

  for (const unit of units) {
    if (!unit || typeof unit !== 'object') {
      throw new Error('unit missing status field');
    }
    if (!unit.status) {
      throw new Error('unit missing status field');
    }
    if (!validStatuses.has(unit.status)) {
      throw new Error(`unknown unit status: ${unit.status}`);
    }

    // EXCLUDED units are genuinely non-applicable - ignore them
    if (unit.status !== 'EXCLUDED') {
      nonExcludedUnits.push(unit);
    }
  }

  // If all units are EXCLUDED, the arm is EXCLUDED
  if (nonExcludedUnits.length === 0) {
    return 'EXCLUDED';
  }

  // Derive status from non-excluded units
  const hasMeasured = nonExcludedUnits.some(u => u.status === 'MEASURED');
  const hasFailed = nonExcludedUnits.some(u => u.status === 'FAILED');
  const hasNotMeasured = nonExcludedUnits.some(u => u.status === 'NOT_MEASURED');

  if (hasMeasured && (hasFailed || hasNotMeasured)) {
    return 'PARTIAL_FAILED';
  }

  if (hasMeasured) {
    return 'MEASURED';
  }

  if (hasFailed) {
    return 'FAILED';
  }

  return 'NOT_MEASURED';
}

/**
 * Validate applicability metadata (harness-owned, not LLM output).
 * Requires exactly userIsolation and persistence, each with status and reason.
 * SUPPORTED requires reason: null.
 * NOT_APPLICABLE requires a non-empty reason.
 */
export function validateApplicability(applicability) {
  if (!isPlainObject(applicability)) {
    throw new Error('applicability must be an object');
  }

  const validStatuses = ['SUPPORTED', 'NOT_APPLICABLE'];
  const requiredCapabilities = ['userIsolation', 'persistence'];
  const applicabilityKeys = Object.keys(applicability);
  for (const key of applicabilityKeys) {
    if (!requiredCapabilities.includes(key)) {
      throw new Error(`Unknown applicability capability: ${key}`);
    }
  }

  for (const capability of requiredCapabilities) {
    if (!Object.hasOwn(applicability, capability)) {
      throw new Error(`Missing applicability.${capability}`);
    }

    const record = applicability[capability];
    if (!isPlainObject(record)) {
      throw new Error(`applicability.${capability} must be an object`);
    }
    assertExactKeys(record, ['status', 'reason'], `applicability.${capability}`);

    if (!validStatuses.includes(record.status)) {
      throw new Error(`Invalid applicability status for ${capability}: ${record.status}. Must be SUPPORTED or NOT_APPLICABLE.`);
    }

    // SUPPORTED requires reason: null
    if (record.status === 'SUPPORTED') {
      if (record.reason !== null) {
        throw new Error(`${capability} with SUPPORTED status must have null reason, got: ${record.reason}`);
      }
    }

    // NOT_APPLICABLE requires a non-empty reason
    if (record.status === 'NOT_APPLICABLE') {
      if (!isNonEmptyString(record.reason)) {
        throw new Error(`${capability} with NOT_APPLICABLE status requires a non-empty string reason`);
      }
    }
  }
}

/**
 * Validate operation metrics - exact non-negative integer counters.
 * Require exactly all seven declared counters.
 * Forbid legacy generic 'toolCalls' field.
 * Reject unknown/extra fields.
 */
export function validateOperationMetrics(metrics) {
  if (!isPlainObject(metrics)) {
    throw new Error('operation metrics must be an object');
  }

  // Forbid legacy toolCalls
  if (Object.hasOwn(metrics, 'toolCalls')) {
    throw new Error('Legacy generic "toolCalls" field is forbidden. Use specific operation counters instead.');
  }

  assertExactKeys(metrics, OPERATION_FIELDS, 'operation');

  // Require all seven fields
  for (const field of OPERATION_FIELDS) {
    const value = metrics[field];

    if (!Number.isSafeInteger(value)) {
      throw new Error(`Operation metric ${field} must be a safe integer, got ${typeof value}`);
    }

    if (value < 0) {
      throw new Error(`Operation metric ${field} must be non-negative, got ${value}`);
    }
  }
}

/**
 * Validate storage measurement.
 * Require full shape: {status, bytes, scope, method, reason, blockedClaims}.
 * - MEASURED requires integer bytes, non-empty scope/method, null reason, empty blockedClaims
 * - NOT_AVAILABLE requires null bytes, non-empty scope/reason, null or non-empty method, non-empty blockedClaims
 */
export function validateStorageMeasurement(storage) {
  if (!isPlainObject(storage)) {
    throw new Error('storage measurement must be an object');
  }

  const validStatuses = ['MEASURED', 'NOT_AVAILABLE'];

  // Require all fields
  const requiredFields = ['status', 'bytes', 'scope', 'method', 'reason', 'blockedClaims'];
  assertExactKeys(storage, requiredFields, 'storage');

  if (!validStatuses.includes(storage.status)) {
    throw new Error(`Invalid storage status: ${storage.status}`);
  }

  if (storage.status === 'MEASURED') {
    // MEASURED requires non-null integer bytes
    if (storage.bytes === null || storage.bytes === undefined) {
      throw new Error('MEASURED storage bytes required');
    }
    if (!Number.isSafeInteger(storage.bytes) || storage.bytes < 0) {
      throw new Error('Storage bytes must be a non-negative safe integer');
    }

    // MEASURED requires non-empty scope
    if (!isNonEmptyString(storage.scope)) {
      throw new Error('MEASURED storage scope must be a non-empty string');
    }

    // MEASURED requires non-empty method
    if (!isNonEmptyString(storage.method)) {
      throw new Error('MEASURED storage method must be a non-empty string');
    }

    // MEASURED requires null reason
    if (storage.reason !== null) {
      throw new Error('MEASURED storage must have null reason');
    }

    // MEASURED requires empty blockedClaims
    if (!Array.isArray(storage.blockedClaims) || storage.blockedClaims.length > 0) {
      throw new Error('MEASURED storage must have empty blockedClaims array');
    }
  }

  if (storage.status === 'NOT_AVAILABLE') {
    // NOT_AVAILABLE requires null bytes
    if (storage.bytes !== null) {
      throw new Error('Storage status NOT_AVAILABLE requires null bytes');
    }

    // NOT_AVAILABLE requires non-empty scope
    if (!isNonEmptyString(storage.scope)) {
      throw new Error('NOT_AVAILABLE storage scope must be a non-empty string');
    }

    // NOT_AVAILABLE requires non-empty reason
    if (!isNonEmptyString(storage.reason)) {
      throw new Error('Storage status NOT_AVAILABLE reason must be a non-empty string');
    }

    // NOT_AVAILABLE requires non-empty blockedClaims (array of strings)
    if (!Array.isArray(storage.blockedClaims) || storage.blockedClaims.length === 0 || !storage.blockedClaims.every(isNonEmptyString)) {
      throw new Error('NOT_AVAILABLE storage requires non-empty blockedClaims array listing storage-dependent claims');
    }

    // method can be null or non-empty string for NOT_AVAILABLE
    if (storage.method !== null && !isNonEmptyString(storage.method)) {
      throw new Error('NOT_AVAILABLE storage method must be null or non-empty string');
    }
  }
}

/**
 * Validate the raw memory-adapter response. Applicability, the decision response,
 * the outer-model call count, and final unit status remain harness-owned evidence.
 */
export function validateAdapterEnvelope(envelope) {
  if (!isPlainObject(envelope)) throw new Error('adapter envelope must be an object');
  assertExactKeys(envelope, ADAPTER_ENVELOPE_FIELDS, 'adapter envelope');

  if (envelope.schemaVersion !== 1) throw new Error('adapter envelope.schemaVersion must equal 1');
  if (!ADAPTER_OPERATIONS.includes(envelope.operation)) throw new Error(`Invalid adapter operation: ${envelope.operation}`);
  for (const field of ['runId', 'attemptId', 'phase', 'armId', 'scenarioId']) {
    if (!isNonEmptyString(envelope[field])) throw new Error(`adapter envelope.${field} must be a non-empty string`);
  }
  if (!Number.isSafeInteger(envelope.repetition) || envelope.repetition < 0) {
    throw new Error('adapter envelope.repetition must be a non-negative safe integer');
  }
  if (!ADAPTER_STATUSES.includes(envelope.status)) throw new Error(`Invalid adapter status: ${envelope.status}`);

  validateAdapterResult(envelope.result);
  validateAdapterFailure(envelope.status, envelope.failure);
  validateOperationMetrics(envelope.operations);
  if (envelope.operations.outerDecisionModelCalls !== 0) {
    throw new Error('Adapter envelope outerDecisionModelCalls must be zero; the harness owns the outer decision model');
  }
  validateStorageMeasurement(envelope.storage);
}
