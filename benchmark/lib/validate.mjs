import { NO_COMMON_MODEL_REASON } from './capabilities.mjs';
import { validateDecisionResponse } from './outer-model.mjs';
import {
  ADAPTER_FAILURE_CAUSES,
  ARM_STATUSES as V11_ARM_STATUSES,
  OPERATION_FIELDS,
  UNIT_STATUSES,
  deriveArmStatus,
  namespaceRefFor,
  recordContentSha256,
  standardizedDecisionRecord,
  validateApplicability,
  validateIsolationEvidence,
  validateOperationMetrics,
  validatePersistenceEvidence,
  validateStorageMeasurement
} from './v11-contract.mjs';

const ARM_STATUSES = new Set(['MEASURED', 'NOT_MEASURED', 'FAILED', 'EXCLUDED']);
const MEASUREMENT_STATUSES = new Set(['MEASURED', 'NOT_MEASURED', 'FAILED', 'EXCLUDED']);
const REQUIRED_PHASES = ['A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2', 'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'];
const REQUIRED_MEASUREMENT_FIELDS = [
  'schemaVersion', 'runId', 'preregistrationSha256', 'harnessVersion', 'armId',
  'competitorVersion', 'status', 'statusReason', 'scenarioId', 'phase',
  'repetition', 'seed', 'startedAt', 'latencyMs', 'request', 'response',
  'usage', 'toolCalls', 'storageBytes', 'cost', 'scores', 'logs'
];
const V11_PHASES = [
  'RESET', 'A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2',
  'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'
];
const V11_RAW_FIELDS = [
  'schemaVersion', 'benchmarkVersion', 'mode', 'runId', 'attemptId', 'attemptIds',
  'status', 'preregistrationSha256', 'amendment001Sha256', 'amendment002Sha256',
  'implementationLockHash', 'environmentLockHash', 'startedAt', 'finishedAt',
  'zeroResult', 'arms', 'units'
];
const V11_ARM_FIELDS = ['armId', 'name', 'status', 'applicability'];
const V11_UNIT_FIELDS = [
  'schemaVersion', 'unitId', 'runId', 'attemptId', 'armId', 'scenarioId',
  'repetition', 'seed', 'phase', 'status', 'statusReason', 'applicability',
  'startedAt', 'finishedAt', 'latencyMs', 'decisionResponse', 'providerUsage',
  'providerModel', 'operations', 'storage', 'adapterEvidence', 'failure'
];
const V11_ADAPTER_EVIDENCE_FIELDS = [
  'reset', 'setupPersist', 'setupVerify', 'retrieve', 'persist', 'verify'
];
const V11_PUBLIC_ADAPTER_EVIDENCE_FIELDS = [
  'status', 'namespaceRef', 'nativeContextCount', 'persistenceEvidence',
  'isolationEvidence', 'operations', 'storage'
];
const V11_USAGE_COUNT_FIELDS = new Set([
  'prompt_tokens', 'completion_tokens', 'input_tokens', 'output_tokens', 'total_tokens'
]);
const V11_USAGE_DETAIL_FIELDS = new Set([
  'accepted_prediction_tokens', 'audio_tokens', 'cached_tokens', 'image_tokens',
  'reasoning_tokens', 'rejected_prediction_tokens', 'text_tokens'
]);
const V11_USAGE_OBJECT_FIELDS = new Set([
  'prompt_tokens_details', 'completion_tokens_details',
  'input_tokens_details', 'output_tokens_details'
]);
const HASH = /^[a-f0-9]{64}$/u;
const ACCEPTANCE_FORBIDDEN_FIELD = /(?:score|rank|winner|best|marketing|quality|efficacy)/iu;

function requireField(object, field, context) {
  if (!Object.hasOwn(object, field)) throw new Error(`${context} is missing required field ${field}`);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertExactFields(object, fields, context) {
  if (!isPlainObject(object)) throw new Error(`${context} must be an object`);
  const expected = new Set(fields);
  for (const field of Object.keys(object)) {
    if (!expected.has(field)) throw new Error(`${context} contains unknown field ${field}`);
  }
  for (const field of fields) requireField(object, field, context);
}

function assertTimestamp(value, context) {
  if (!isNonEmptyString(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${context} must be an ISO timestamp`);
  }
}

function assertHash(value, context) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new Error(`${context} must be a lowercase full SHA-256 digest`);
  }
}

function assertAcceptanceFieldsAbsent(value, context = 'acceptance output') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertAcceptanceFieldsAbsent(item, `${context}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [field, child] of Object.entries(value)) {
    if (ACCEPTANCE_FORBIDDEN_FIELD.test(field)) {
      throw new Error(`${context} contains forbidden field ${field}`);
    }
    assertAcceptanceFieldsAbsent(child, `${context}.${field}`);
  }
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasRecordedOperations(operations) {
  return Object.values(operations).some((value) => value !== 0);
}

function hasAdapterEvidence(adapterEvidence) {
  return Object.values(adapterEvidence).some((value) => value !== null);
}

function v11UnitId(armId, scenarioId, repetition, phase) {
  const components = [armId, scenarioId, String(repetition), phase];
  return `unit:${components.map((value) => `${value.length}:${value}`).join(':')}`;
}

function validateV11AdapterEvidence(value, context) {
  if (value === null) return;
  assertExactFields(value, V11_PUBLIC_ADAPTER_EVIDENCE_FIELDS, context);
  if (!['SUCCEEDED', 'FAILED', 'NOT_APPLICABLE'].includes(value.status)) {
    throw new Error(`${context}.status is invalid`);
  }
  assertHash(value.namespaceRef, `${context}.namespaceRef`);
  if (!Number.isSafeInteger(value.nativeContextCount) || value.nativeContextCount < 0) {
    throw new Error(`${context}.nativeContextCount must be a non-negative safe integer`);
  }
  validateOperationMetrics(value.operations);
  validateStorageMeasurement(value.storage);
  validatePersistenceEvidence(value.persistenceEvidence);
  validateIsolationEvidence(value.isolationEvidence);
  if (value.operations.outerDecisionModelCalls !== 0) {
    throw new Error(`${context} must not claim harness-owned outer decision calls`);
  }
  if (value.status === 'NOT_APPLICABLE'
    && (value.nativeContextCount !== 0
      || value.persistenceEvidence !== null
      || value.isolationEvidence !== null)) {
    throw new Error(`${context} NOT_APPLICABLE must not contain adapter evidence`);
  }
}

function sumAdapterOperations(adapterEvidence) {
  const totals = Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0]));
  for (const evidence of Object.values(adapterEvidence)) {
    if (evidence === null) continue;
    for (const field of OPERATION_FIELDS) {
      const total = totals[field] + evidence.operations[field];
      if (!Number.isSafeInteger(total)) throw new Error(`Adapter operation ${field} overflowed`);
      totals[field] = total;
    }
  }
  return totals;
}

function validateV11OperationAccounting(unit, context) {
  const adapterTotals = sumAdapterOperations(unit.adapterEvidence);
  for (const field of OPERATION_FIELDS) {
    if (field === 'outerDecisionModelCalls') continue;
    if (unit.operations[field] !== adapterTotals[field]) {
      throw new Error(`${context}.operations.${field} differs from recorded adapter evidence`);
    }
  }
  if (![0, 1].includes(unit.operations.outerDecisionModelCalls)) {
    throw new Error(`${context}.operations.outerDecisionModelCalls must be zero or one`);
  }
}

function requiredAdapterEvidence(unit, key, expectedStatus, context) {
  const evidence = unit.adapterEvidence[key];
  if (evidence === null || evidence.status !== expectedStatus) {
    throw new Error(`${context} MEASURED requires ${key} adapter evidence with status ${expectedStatus}`);
  }
  return evidence;
}

function validatePersistenceProof(evidence, expectedRecord, namespaceRef, context) {
  const proof = evidence.persistenceEvidence;
  if (proof?.verified !== true
    || !sameJson(proof.expectedRecord, expectedRecord)
    || proof.matchedRecordIds.length !== 1
    || proof.matchedRecordIds[0] !== expectedRecord.id
    || proof.observedContentSha256 !== expectedRecord.contentSha256
    || proof.namespaceRef !== namespaceRef) {
    throw new Error(`${context} must prove the exact persisted record in the requested namespace`);
  }
}

function validateIsolationProof(evidence, expectedNamespaceRef, expectedAbsentRecord, context) {
  const proof = evidence.isolationEvidence;
  if (proof?.verified !== true
    || !sameJson(proof.expectedAbsentRecord, expectedAbsentRecord)
    || proof.matchingRecordIdCount !== 0
    || proof.matchingContentCount !== 0
    || proof.alternateNamespaceRef !== expectedNamespaceRef) {
    throw new Error(`${context} must prove the exact alternate namespace without matching record ids or content`);
  }
}

function primaryNamespace(unit, scenario) {
  return {
    projectId: scenario.projectId,
    userId: unit.applicability.userIsolation.status === 'SUPPORTED' ? scenario.userId : null
  };
}

function expectedAlternateNamespace(unit, scenario) {
  if (unit.phase === 'ISOLATION_PROJECT') {
    return {
      projectId: scenario.isolationProjectId,
      userId: unit.applicability.userIsolation.status === 'SUPPORTED' ? scenario.userId : null
    };
  }
  if (unit.phase === 'ISOLATION_USER') {
    return { projectId: scenario.projectId, userId: scenario.isolationUserId };
  }
  return null;
}

function expectedEvidenceNamespace(unit, scenario, evidenceKey) {
  if (evidenceKey === 'retrieve') {
    return expectedAlternateNamespace(unit, scenario) ?? primaryNamespace(unit, scenario);
  }
  return primaryNamespace(unit, scenario);
}

function namespaceEvidenceRef(unit, namespace) {
  return namespaceRefFor({
    runId: unit.runId,
    armId: unit.armId,
    scenarioId: unit.scenarioId,
    repetition: unit.repetition,
    phase: unit.phase
  }, namespace);
}

function validateRecordedEvidenceBindings(unit, scenario, context) {
  const alternate = expectedAlternateNamespace(unit, scenario);
  for (const evidenceKey of V11_ADAPTER_EVIDENCE_FIELDS) {
    const evidence = unit.adapterEvidence[evidenceKey];
    if (evidence === null) continue;
    const expectedNamespace = expectedEvidenceNamespace(unit, scenario, evidenceKey);
    if (evidence.namespaceRef !== namespaceEvidenceRef(unit, expectedNamespace)) {
      const kind = evidenceKey === 'retrieve' && alternate !== null ? 'alternate' : 'primary';
      throw new Error(`${context}.adapterEvidence.${evidenceKey} must use the exact ${kind} namespace reference`);
    }
    if (evidenceKey !== 'retrieve' && evidence.nativeContextCount !== 0) {
      throw new Error(`${context}.adapterEvidence.${evidenceKey} must not claim native retrieval context`);
    }
  }
  const retrieve = unit.adapterEvidence.retrieve;
  if (retrieve !== null
    && (alternate !== null || unit.armId === 'no-memory')
    && retrieve.nativeContextCount !== 0) {
    throw new Error(`${context}.adapterEvidence.retrieve must prove empty native context`);
  }
}

function validateMeasuredAdapterEvidence(unit, scenario, raw, context) {
  if (unit.statusReason !== null) throw new Error(`${context} MEASURED requires null statusReason`);
  if (unit.phase === 'RESET') {
    const reset = requiredAdapterEvidence(unit, 'reset', 'SUCCEEDED', context);
    for (const key of V11_ADAPTER_EVIDENCE_FIELDS.filter((field) => field !== 'reset')) {
      if (unit.adapterEvidence[key] !== null) throw new Error(`${context} RESET contains unexpected ${key} evidence`);
    }
    if (unit.operations.outerDecisionModelCalls !== 0) {
      throw new Error(`${context} RESET must not claim an outer decision call`);
    }
    if (!sameJson(unit.storage, reset.storage)) {
      throw new Error(`${context}.storage differs from RESET adapter evidence`);
    }
    if (reset.persistenceEvidence !== null || reset.isolationEvidence !== null) {
      throw new Error(`${context} RESET must not contain verification claims`);
    }
    return;
  }

  if (unit.adapterEvidence.reset !== null) {
    throw new Error(`${context} decision unit contains unexpected reset evidence`);
  }
  const retrieve = requiredAdapterEvidence(unit, 'retrieve', 'SUCCEEDED', context);
  if (retrieve.persistenceEvidence !== null || retrieve.isolationEvidence !== null) {
    throw new Error(`${context} retrieve evidence must not contain verification claims`);
  }
  const persistenceStatus = unit.applicability.persistence.status === 'SUPPORTED'
    ? 'SUCCEEDED'
    : 'NOT_APPLICABLE';
  const persist = requiredAdapterEvidence(unit, 'persist', persistenceStatus, context);
  const verify = requiredAdapterEvidence(unit, 'verify', persistenceStatus, context);
  if (persist.persistenceEvidence !== null || persist.isolationEvidence !== null) {
    throw new Error(`${context}.adapterEvidence.persist must not contain verification claims`);
  }
  if (unit.phase === 'E') {
    requiredAdapterEvidence(unit, 'setupPersist', persistenceStatus, context);
    const setupVerify = requiredAdapterEvidence(unit, 'setupVerify', persistenceStatus, context);
    if (persistenceStatus === 'SUCCEEDED') {
      validatePersistenceProof(
        setupVerify,
        {
          id: scenario.failedAttempt.id,
          type: 'failed_attempt',
          contentSha256: recordContentSha256(scenario.failedAttempt)
        },
        namespaceEvidenceRef(unit, primaryNamespace(unit, scenario)),
        `${context}.adapterEvidence.setupVerify`
      );
    }
  } else if (unit.adapterEvidence.setupPersist !== null || unit.adapterEvidence.setupVerify !== null) {
    throw new Error(`${context} non-E unit contains unexpected setup evidence`);
  }

  if (unit.operations.outerDecisionModelCalls !== 1) {
    throw new Error(`${context} MEASURED decision unit requires exactly one outer decision call`);
  }
  if (!sameJson(unit.storage, verify.storage)) {
    throw new Error(`${context}.storage differs from terminal verify evidence`);
  }
  if (persistenceStatus === 'SUCCEEDED') {
    const expectedDecisionRecord = standardizedDecisionRecord({
      armId: unit.armId,
      scenarioId: unit.scenarioId,
      repetition: unit.repetition,
      phase: unit.phase
    }, unit.decisionResponse);
    validatePersistenceProof(
      verify,
      {
        id: expectedDecisionRecord.id,
        type: expectedDecisionRecord.type,
        contentSha256: recordContentSha256(expectedDecisionRecord.content)
      },
      namespaceEvidenceRef(unit, primaryNamespace(unit, scenario)),
      `${context}.adapterEvidence.verify`
    );
    const alternate = expectedAlternateNamespace(unit, scenario);
    if (alternate === null) {
      if (verify.isolationEvidence !== null) {
        throw new Error(`${context}.adapterEvidence.verify contains unrequested isolation evidence`);
      }
    } else {
      const phaseA = raw.units.find((candidate) => candidate.armId === unit.armId
        && candidate.scenarioId === unit.scenarioId
        && candidate.repetition === unit.repetition
        && candidate.phase === 'A');
      const phaseARecord = standardizedDecisionRecord({
        armId: unit.armId,
        scenarioId: unit.scenarioId,
        repetition: unit.repetition,
        phase: 'A'
      }, phaseA.decisionResponse);
      validateIsolationProof(
        verify,
        namespaceEvidenceRef(unit, alternate),
        {
          id: phaseARecord.id,
          type: phaseARecord.type,
          contentSha256: recordContentSha256(phaseARecord.content)
        },
        `${context}.adapterEvidence.verify`
      );
    }
  } else if (persist.persistenceEvidence !== null
    || persist.isolationEvidence !== null
    || verify.persistenceEvidence !== null
    || verify.isolationEvidence !== null) {
    throw new Error(`${context} NOT_APPLICABLE persistence must not contain verification claims`);
  }
}

function validateV11Failure(failure, context) {
  assertExactFields(failure, ['cause', 'operation', 'message'], context);
  if (!ADAPTER_FAILURE_CAUSES.includes(failure.cause)) {
    throw new Error(`${context}.cause is invalid`);
  }
  if (!isNonEmptyString(failure.operation) || !isNonEmptyString(failure.message)) {
    throw new Error(`${context} requires non-empty operation and message`);
  }
}

function validateV11ProviderUsage(usage, context) {
  if (usage === null) return;
  if (!isPlainObject(usage)) throw new Error(`${context} must be null or an object`);
  const validateCount = (value, field) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error(`${context}.${field} must be a non-negative safe integer`);
    }
  };
  for (const [field, value] of Object.entries(usage)) {
    if (V11_USAGE_COUNT_FIELDS.has(field)) {
      validateCount(value, field);
      continue;
    }
    if (!V11_USAGE_OBJECT_FIELDS.has(field) || !isPlainObject(value)) {
      throw new Error(`${context} contains unknown or invalid field ${field}`);
    }
    for (const [detailField, detailValue] of Object.entries(value)) {
      if (!V11_USAGE_DETAIL_FIELDS.has(detailField)) {
        throw new Error(`${context}.${field} contains unknown field ${detailField}`);
      }
      validateCount(detailValue, `${field}.${detailField}`);
    }
  }
}

function validateIsolationPhaseABinding(unit, raw, context) {
  if (!['ISOLATION_PROJECT', 'ISOLATION_USER'].includes(unit.phase)) return;
  const phaseA = raw.units.find((candidate) => candidate.armId === unit.armId
    && candidate.scenarioId === unit.scenarioId
    && candidate.repetition === unit.repetition
    && candidate.phase === 'A');
  if (phaseA?.status !== 'MEASURED' || phaseA.decisionResponse === null) {
    throw new Error(`${context} isolation proof requires a valid measured Phase A unit`);
  }
  validateDecisionResponse(phaseA.decisionResponse);
}

function unavailableClaimFields(arm) {
  return Object.keys(arm).filter((field) => /(?:score|winner|rank|token|cost|quality|infer|estimat)/iu.test(field));
}

function expectedUnitKeys(preregistration, armId) {
  const keys = new Set();
  for (let repetition = 0; repetition < preregistration.commonExecution.repetitions; repetition += 1) {
    for (const scenario of preregistration.scenarios) {
      for (const phase of REQUIRED_PHASES) keys.add(`${armId}\u0000${scenario.id}\u0000${repetition}\u0000${phase}`);
    }
  }
  return keys;
}

function validateLegacyRawRun(raw, preregistration, expectedSha256) {
  for (const field of [
    'schemaVersion', 'runId', 'preregistrationSha256', 'harnessVersion',
    'startedAt', 'finishedAt', 'configuration', 'environment', 'dependencies',
    'capabilityProbe', 'arms', 'measurements'
  ]) requireField(raw, field, 'raw run');
  if (raw.schemaVersion !== 1) throw new Error(`Unsupported raw run schemaVersion ${raw.schemaVersion}`);
  if (raw.preregistrationSha256 !== expectedSha256) throw new Error('Raw run preregistration hash does not match the frozen preregistration');
  if (!Array.isArray(raw.arms) || !Array.isArray(raw.measurements)) throw new Error('Raw run arms and measurements must be arrays');

  const expectedArmIds = preregistration.arms.map((arm) => arm.id).sort();
  const actualArmIds = raw.arms.map((arm) => arm.armId).sort();
  if (new Set(actualArmIds).size !== actualArmIds.length) throw new Error('Raw run contains duplicate arm ids');
  if (JSON.stringify(actualArmIds) !== JSON.stringify(expectedArmIds)) {
    throw new Error(`Raw run arm ids differ from preregistration: ${actualArmIds.join(', ')}`);
  }

  for (const arm of raw.arms) {
    for (const field of ['armId', 'name', 'status', 'competitorVersion', 'command', 'exitCode', 'logPath', 'reason']) {
      requireField(arm, field, `arm ${arm.armId ?? '<unknown>'}`);
    }
    if (!ARM_STATUSES.has(arm.status)) throw new Error(`Arm ${arm.armId} has invalid status ${arm.status}`);
    if (arm.status !== 'MEASURED' && (Object.hasOwn(arm, 'score') || Object.hasOwn(arm, 'scores'))) {
      throw new Error(`${arm.status} arm ${arm.armId} must not contain score data`);
    }
    const claimFields = arm.status === 'MEASURED' ? [] : unavailableClaimFields(arm);
    if (claimFields.length > 0) throw new Error(`unavailable arm ${arm.armId} contains forbidden claim field ${claimFields[0]}`);
  }

  const configured = raw.configuration;
  if (configured.temperature !== preregistration.commonExecution.temperature
    || configured.maxInputTokens !== preregistration.commonExecution.maxInputTokens
    || configured.maxOutputTokens !== preregistration.commonExecution.maxOutputTokens
    || configured.repetitions !== preregistration.commonExecution.repetitions
    || JSON.stringify(configured.seeds) !== JSON.stringify(preregistration.commonExecution.randomSeeds)) {
    throw new Error('Raw run common model configuration differs from preregistration');
  }
  if (configured.commonModelAvailable === false) {
    if (raw.measurements.length !== 0) throw new Error('A no-common-model run cannot contain comparative measurements');
    if (raw.arms.some((arm) => arm.status === 'MEASURED')) throw new Error('A no-common-model run cannot mark an arm MEASURED');
    if (raw.capabilityProbe?.reason !== NO_COMMON_MODEL_REASON) throw new Error('A no-common-model run must record the exact no-common-model reason');
    if (raw.arms.some((arm) => arm.status !== 'NOT_MEASURED' || arm.reason !== NO_COMMON_MODEL_REASON)) {
      throw new Error('Every arm must be NOT_MEASURED with the exact no-common-model reason');
    }
  }

  const seenUnits = new Set();
  for (const [index, measurement] of raw.measurements.entries()) {
    const context = `measurement ${index}`;
    for (const field of REQUIRED_MEASUREMENT_FIELDS) requireField(measurement, field, context);
    if (!MEASUREMENT_STATUSES.has(measurement.status)) throw new Error(`${context} has invalid status ${measurement.status}`);
    if (!expectedArmIds.includes(measurement.armId)) throw new Error(`${context} has unknown arm ${measurement.armId}`);
    if (!preregistration.scenarios.some((scenario) => scenario.id === measurement.scenarioId)) throw new Error(`${context} has unknown scenario ${measurement.scenarioId}`);
    if (!Number.isInteger(measurement.repetition) || measurement.repetition < 0 || measurement.repetition >= preregistration.commonExecution.repetitions) {
      throw new Error(`${context} has invalid repetition ${measurement.repetition}`);
    }
    if (measurement.seed !== preregistration.commonExecution.randomSeeds[measurement.repetition]) throw new Error(`${context} seed does not match preregistration`);
    const unitKey = `${measurement.armId}\u0000${measurement.scenarioId}\u0000${measurement.repetition}\u0000${measurement.phase}`;
    if (seenUnits.has(unitKey)) throw new Error(`Duplicate measurement unit ${unitKey}`);
    seenUnits.add(unitKey);
    if (measurement.status !== 'MEASURED' && measurement.scores !== null) throw new Error(`${context} is ${measurement.status} but contains scores`);
    if (measurement.status !== 'MEASURED') {
      for (const field of ['latencyMs', 'response', 'usage', 'toolCalls', 'storageBytes', 'cost', 'scores']) {
        if (measurement[field] !== null) throw new Error(`${context} is unavailable but contains ${field} claim data`);
      }
    }
    if (measurement.status === 'MEASURED') {
      if (measurement.response === null || typeof measurement.response !== 'object') throw new Error(`${context} is MEASURED without a response object`);
      if (!Number.isFinite(measurement.latencyMs) || measurement.latencyMs < 0) throw new Error(`${context} has invalid latencyMs`);
      if (!Number.isInteger(measurement.toolCalls) || measurement.toolCalls < 0) throw new Error(`${context} has invalid toolCalls`);
      if (measurement.storageBytes !== null && (!Number.isInteger(measurement.storageBytes) || measurement.storageBytes < 0)) throw new Error(`${context} has invalid storageBytes`);
    }
  }

  for (const arm of raw.arms) {
    const armMeasurements = raw.measurements.filter((measurement) => measurement.armId === arm.armId);
    if (arm.status !== 'MEASURED') {
      if (armMeasurements.some((measurement) => measurement.status === 'MEASURED')) throw new Error(`Unavailable arm ${arm.armId} contains measured units`);
      continue;
    }
    const expected = expectedUnitKeys(preregistration, arm.armId);
    const actual = new Set(armMeasurements.filter((measurement) => measurement.status === 'MEASURED').map((measurement) => (
      `${measurement.armId}\u0000${measurement.scenarioId}\u0000${measurement.repetition}\u0000${measurement.phase}`
    )));
    if (actual.size !== expected.size || [...expected].some((key) => !actual.has(key))) {
      throw new Error(`MEASURED arm ${arm.armId} does not contain every preregistered complete lifecycle unit`);
    }
  }

  const count = (status) => raw.arms.filter((arm) => arm.status === status).length;
  return {
    valid: true,
    counts: {
      arms: raw.arms.length,
      measuredArms: count('MEASURED'),
      notMeasuredArms: count('NOT_MEASURED'),
      failedArms: count('FAILED'),
      excludedArms: count('EXCLUDED'),
      measurements: raw.measurements.length
    }
  };
}

function expectedV11UnitIds(preregistration, armId) {
  const ids = new Set();
  for (let repetition = 0; repetition < preregistration.commonExecution.repetitions; repetition += 1) {
    for (const scenario of preregistration.scenarios) {
      for (const phase of V11_PHASES) ids.add(v11UnitId(armId, scenario.id, repetition, phase));
    }
  }
  return ids;
}

function validateV11Unit(unit, raw, preregistration, armsById, seenUnitIds) {
  const context = `unit ${unit?.unitId ?? '<unknown>'}`;
  assertExactFields(unit, V11_UNIT_FIELDS, context);
  if (unit.schemaVersion !== 1) throw new Error(`${context}.schemaVersion must equal 1`);
  if (!UNIT_STATUSES.includes(unit.status)) throw new Error(`${context} has invalid status ${unit.status}`);
  if (!V11_PHASES.includes(unit.phase)) throw new Error(`${context} has invalid phase ${unit.phase}`);
  if (unit.runId !== raw.runId) throw new Error(`${context}.runId does not match raw run`);
  if (!raw.attemptIds.includes(unit.attemptId)) throw new Error(`${context}.attemptId is not registered by the raw run`);
  const arm = armsById.get(unit.armId);
  if (!arm) throw new Error(`${context} has unknown arm ${unit.armId}`);
  const scenario = preregistration.scenarios.find((item) => item.id === unit.scenarioId);
  if (!scenario) throw new Error(`${context} has unknown scenario ${unit.scenarioId}`);
  if (!Number.isSafeInteger(unit.repetition)
    || unit.repetition < 0
    || unit.repetition >= preregistration.commonExecution.repetitions) {
    throw new Error(`${context} has invalid repetition ${unit.repetition}`);
  }
  if (unit.seed !== preregistration.commonExecution.randomSeeds[unit.repetition]) {
    throw new Error(`${context} seed does not match preregistration`);
  }
  const expectedId = v11UnitId(unit.armId, unit.scenarioId, unit.repetition, unit.phase);
  if (unit.unitId !== expectedId) throw new Error(`${context} correlation does not match unitId ${expectedId}`);
  if (seenUnitIds.has(unit.unitId)) throw new Error(`Duplicate v1.1 unit ${unit.unitId}`);
  seenUnitIds.add(unit.unitId);

  validateApplicability(unit.applicability);
  if (!sameJson(unit.applicability, arm.applicability)) {
    throw new Error(`${context}.applicability differs from harness-owned arm metadata`);
  }
  assertTimestamp(unit.startedAt, `${context}.startedAt`);
  if (unit.finishedAt !== null) assertTimestamp(unit.finishedAt, `${context}.finishedAt`);
  if (unit.latencyMs !== null && (!Number.isFinite(unit.latencyMs) || unit.latencyMs < 0)) {
    throw new Error(`${context}.latencyMs must be null or a non-negative finite number`);
  }
  validateV11ProviderUsage(unit.providerUsage, `${context}.providerUsage`);
  if (unit.providerModel !== null && !isNonEmptyString(unit.providerModel)) {
    throw new Error(`${context}.providerModel must be null or a non-empty string`);
  }
  validateOperationMetrics(unit.operations);
  if (unit.storage !== null) validateStorageMeasurement(unit.storage);
  assertExactFields(unit.adapterEvidence, V11_ADAPTER_EVIDENCE_FIELDS, `${context}.adapterEvidence`);
  for (const field of V11_ADAPTER_EVIDENCE_FIELDS) {
    validateV11AdapterEvidence(unit.adapterEvidence[field], `${context}.adapterEvidence.${field}`);
  }
  validateV11OperationAccounting(unit, context);
  if (unit.decisionResponse !== null) validateDecisionResponse(unit.decisionResponse);

  if (unit.status === 'FAILED') {
    validateV11Failure(unit.failure, `${context}.failure`);
    if (!isNonEmptyString(unit.statusReason)) throw new Error(`${context} FAILED requires statusReason`);
  } else if (unit.failure !== null) {
    throw new Error(`${context} ${unit.status} must have null failure`);
  }
  if (['MEASURED', 'FAILED'].includes(unit.status)
    && (unit.finishedAt === null || unit.latencyMs === null)) {
    throw new Error(`${context} ${unit.status} must be terminal with finishedAt and latencyMs`);
  }
  if (unit.status === 'MEASURED') {
    if (unit.phase === 'RESET' && unit.decisionResponse !== null) {
      throw new Error(`${context} RESET must not contain a decision response`);
    }
    if (unit.phase !== 'RESET' && unit.decisionResponse === null) {
      throw new Error(`${context} MEASURED decision unit requires a decision response`);
    }
    validateIsolationPhaseABinding(unit, raw, context);
    validateMeasuredAdapterEvidence(unit, scenario, raw, context);
  }
  if (unit.status === 'NOT_MEASURED') {
    if (!isNonEmptyString(unit.statusReason)) throw new Error(`${context} NOT_MEASURED requires statusReason`);
    if (unit.latencyMs !== null
      || unit.decisionResponse !== null
      || unit.providerUsage !== null
      || unit.providerModel !== null
      || unit.storage !== null
      || hasRecordedOperations(unit.operations)
      || hasAdapterEvidence(unit.adapterEvidence)) {
      throw new Error(`${context} NOT_MEASURED must not contain result claims`);
    }
  }
  if (unit.status === 'EXCLUDED') {
    if (!isNonEmptyString(unit.statusReason)) throw new Error(`${context} EXCLUDED requires statusReason`);
    if (unit.phase !== 'ISOLATION_USER'
      || unit.applicability.userIsolation.status !== 'NOT_APPLICABLE') {
      throw new Error(`${context} EXCLUDED must match harness-owned non-applicability`);
    }
    if (unit.statusReason !== unit.applicability.userIsolation.reason) {
      throw new Error(`${context} EXCLUDED reason must match harness-owned applicability`);
    }
    if (unit.latencyMs !== null
      || unit.decisionResponse !== null
      || unit.providerUsage !== null
      || unit.providerModel !== null
      || unit.storage !== null
      || hasRecordedOperations(unit.operations)
      || hasAdapterEvidence(unit.adapterEvidence)) {
      throw new Error(`${context} EXCLUDED must not contain result claims`);
    }
  }
  if (['MEASURED', 'FAILED'].includes(unit.status)) {
    validateRecordedEvidenceBindings(unit, scenario, context);
  }
}

function validateV11ZeroResult(raw) {
  const measuredDecisionUnits = raw.units.filter((unit) => unit.phase !== 'RESET' && unit.status === 'MEASURED');
  if (measuredDecisionUnits.length > 0) {
    if (raw.zeroResult !== null) throw new Error('A run with measured decision units must have null zeroResult');
    return;
  }
  assertExactFields(raw.zeroResult, ['causes', 'message'], 'zeroResult');
  if (!Array.isArray(raw.zeroResult.causes)
    || raw.zeroResult.causes.length === 0
    || !raw.zeroResult.causes.every(isNonEmptyString)
    || new Set(raw.zeroResult.causes).size !== raw.zeroResult.causes.length) {
    throw new Error('zeroResult.causes must be a non-empty unique string array');
  }
  if (!isNonEmptyString(raw.zeroResult.message)) {
    throw new Error('zeroResult.message must be non-empty');
  }
  const recordedCauses = new Set(raw.units
    .filter((unit) => unit.phase !== 'RESET' && unit.status === 'FAILED')
    .map((unit) => unit.failure?.cause)
    .filter(isNonEmptyString));
  if (raw.status === 'INTERRUPTED') recordedCauses.add('OPERATOR_INTERRUPTION');
  if (recordedCauses.size === 0) recordedCauses.add('NOT_MEASURED');
  if (recordedCauses.size !== raw.zeroResult.causes.length
    || [...recordedCauses].some((cause) => !raw.zeroResult.causes.includes(cause))) {
    throw new Error('zeroResult does not exactly preserve the actual recorded causes');
  }
}

export function validateV11RawRun(raw, preregistration, expectedSha256) {
  assertExactFields(raw, V11_RAW_FIELDS, 'v1.1 raw run');
  if (raw.schemaVersion !== 2 || raw.benchmarkVersion !== '1.1') {
    throw new Error('v1.1 raw run requires schemaVersion 2 and benchmarkVersion 1.1');
  }
  if (!['SCORED', 'ACCEPTANCE'].includes(raw.mode)) throw new Error(`Invalid v1.1 run mode ${raw.mode}`);
  if (raw.mode === 'ACCEPTANCE') assertAcceptanceFieldsAbsent(raw);
  if (!['COMPLETE', 'INTERRUPTED'].includes(raw.status)) throw new Error(`Invalid v1.1 run status ${raw.status}`);
  if (!isNonEmptyString(raw.runId) || !isNonEmptyString(raw.attemptId)) {
    throw new Error('v1.1 raw run requires runId and attemptId');
  }
  if (!Array.isArray(raw.attemptIds)
    || raw.attemptIds.length === 0
    || !raw.attemptIds.every(isNonEmptyString)
    || new Set(raw.attemptIds).size !== raw.attemptIds.length
    || raw.attemptIds.at(-1) !== raw.attemptId) {
    throw new Error('v1.1 raw run attemptIds must be unique and end with attemptId');
  }
  for (const field of [
    'preregistrationSha256', 'amendment001Sha256', 'amendment002Sha256',
    'implementationLockHash', 'environmentLockHash'
  ]) assertHash(raw[field], `v1.1 raw run.${field}`);
  if (raw.preregistrationSha256 !== expectedSha256) {
    throw new Error('Raw run preregistration hash does not match the frozen preregistration');
  }
  assertTimestamp(raw.startedAt, 'v1.1 raw run.startedAt');
  assertTimestamp(raw.finishedAt, 'v1.1 raw run.finishedAt');
  if (!Array.isArray(raw.arms) || !Array.isArray(raw.units)) {
    throw new Error('v1.1 raw run arms and units must be arrays');
  }

  const registeredArms = new Map(preregistration.arms.map((arm) => [arm.id, arm]));
  const armsById = new Map();
  for (const arm of raw.arms) {
    assertExactFields(arm, V11_ARM_FIELDS, `v1.1 arm ${arm?.armId ?? '<unknown>'}`);
    const registered = registeredArms.get(arm.armId);
    if (!registered) throw new Error(`v1.1 raw run has unknown arm ${arm.armId}`);
    if (armsById.has(arm.armId)) throw new Error(`v1.1 raw run has duplicate arm ${arm.armId}`);
    if (arm.name !== registered.name) throw new Error(`v1.1 arm ${arm.armId} name differs from preregistration`);
    if (!V11_ARM_STATUSES.includes(arm.status)) throw new Error(`v1.1 arm ${arm.armId} has invalid status ${arm.status}`);
    validateApplicability(registered.applicability);
    validateApplicability(arm.applicability);
    if (!sameJson(arm.applicability, registered.applicability)) {
      throw new Error(`v1.1 arm ${arm.armId} applicability differs from harness-owned definition`);
    }
    armsById.set(arm.armId, arm);
  }
  if (armsById.size !== registeredArms.size
    || [...registeredArms.keys()].some((armId) => !armsById.has(armId))) {
    throw new Error('v1.1 raw run arm ids differ from preregistration');
  }

  const seenUnitIds = new Set();
  for (const unit of raw.units) validateV11Unit(unit, raw, preregistration, armsById, seenUnitIds);
  for (const [armId, arm] of armsById) {
    const expected = expectedV11UnitIds(preregistration, armId);
    if (raw.status === 'COMPLETE' && [...expected].some((unitId) => !seenUnitIds.has(unitId))) {
      throw new Error(`COMPLETE v1.1 arm ${armId} is missing a planned unit`);
    }
    const statuses = [...expected].map((unitId) => (
      raw.units.find((unit) => unit.unitId === unitId) ?? { status: 'NOT_MEASURED' }
    ));
    const derived = deriveArmStatus(statuses);
    if (arm.status !== derived) {
      throw new Error(`v1.1 arm ${armId} status ${arm.status} differs from mechanically derived ${derived}`);
    }
  }
  validateV11ZeroResult(raw);

  const armCount = (status) => raw.arms.filter((arm) => arm.status === status).length;
  const unitCount = (status) => raw.units.filter((unit) => unit.status === status).length;
  return {
    valid: true,
    schemaVersion: 2,
    counts: {
      arms: raw.arms.length,
      measuredArms: armCount('MEASURED'),
      partialFailedArms: armCount('PARTIAL_FAILED'),
      failedArms: armCount('FAILED'),
      notMeasuredArms: armCount('NOT_MEASURED'),
      excludedArms: armCount('EXCLUDED'),
      units: raw.units.length,
      measuredUnits: unitCount('MEASURED'),
      failedUnits: unitCount('FAILED'),
      notMeasuredUnits: unitCount('NOT_MEASURED'),
      excludedUnits: unitCount('EXCLUDED')
    }
  };
}

export function validateRawRun(raw, preregistration, expectedSha256) {
  return raw?.schemaVersion === 2
    ? validateV11RawRun(raw, preregistration, expectedSha256)
    : validateLegacyRawRun(raw, preregistration, expectedSha256);
}
