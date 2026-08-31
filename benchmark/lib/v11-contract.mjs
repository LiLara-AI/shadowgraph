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

    if (!Number.isInteger(value)) {
      throw new Error(`Operation metric ${field} must be an integer, got ${typeof value}`);
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
    if (!Number.isInteger(storage.bytes) || storage.bytes < 0) {
      throw new Error('Storage bytes must be a non-negative integer');
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
 * Validate common adapter envelope format.
 * Reject null/non-object input, missing core fields, invalid unit status, invalid repetition.
 * Require non-empty string phase/armId/scenarioId and integer repetition >= 0.
 * Always call all three nested validators - operations, applicability, and storage are required.
 */
export function validateAdapterEnvelope(envelope) {
  // Validate input type
  if (envelope === null || envelope === undefined) {
    throw new Error('envelope cannot be null or undefined');
  }

  if (typeof envelope !== 'object' || Array.isArray(envelope)) {
    throw new Error('envelope must be an object');
  }

  // Validate required core fields
  if (!envelope.phase || typeof envelope.phase !== 'string' || envelope.phase.trim() === '') {
    throw new Error('Missing or invalid envelope.phase (must be non-empty string)');
  }

  if (!envelope.armId || typeof envelope.armId !== 'string' || envelope.armId.trim() === '') {
    throw new Error('Missing or invalid envelope.armId (must be non-empty string)');
  }

  if (!envelope.scenarioId || typeof envelope.scenarioId !== 'string' || envelope.scenarioId.trim() === '') {
    throw new Error('Missing or invalid envelope.scenarioId (must be non-empty string)');
  }

  if (typeof envelope.repetition !== 'number' || !Number.isInteger(envelope.repetition)) {
    throw new Error('Missing or invalid envelope.repetition (must be integer)');
  }

  if (envelope.repetition < 0) {
    throw new Error('envelope.repetition must be non-negative integer');
  }

  if (!envelope.status || typeof envelope.status !== 'string') {
    throw new Error('Missing envelope.status');
  }

  // Validate unit status (must be one of the four valid statuses)
  const validUnitStatuses = new Set(UNIT_STATUSES);
  if (!validUnitStatuses.has(envelope.status)) {
    throw new Error(`Invalid envelope.status: ${envelope.status}. Must be one of: ${UNIT_STATUSES.join(', ')}`);
  }

  // Require operations, applicability, and storage - these are NOT optional
  if (!envelope.operations) {
    throw new Error('envelope.operations is required');
  }

  if (!envelope.applicability) {
    throw new Error('envelope.applicability is required');
  }

  if (!envelope.storage) {
    throw new Error('envelope.storage is required');
  }

  // Always call all three nested validators
  validateOperationMetrics(envelope.operations);
  validateApplicability(envelope.applicability);
  validateStorageMeasurement(envelope.storage);
}
