import { NO_COMMON_MODEL_REASON } from './capabilities.mjs';

const ARM_STATUSES = new Set(['MEASURED', 'NOT_MEASURED', 'FAILED', 'EXCLUDED']);
const MEASUREMENT_STATUSES = new Set(['MEASURED', 'NOT_MEASURED', 'FAILED', 'EXCLUDED']);
const REQUIRED_PHASES = ['A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2', 'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'];
const REQUIRED_MEASUREMENT_FIELDS = [
  'schemaVersion', 'runId', 'preregistrationSha256', 'harnessVersion', 'armId',
  'competitorVersion', 'status', 'statusReason', 'scenarioId', 'phase',
  'repetition', 'seed', 'startedAt', 'latencyMs', 'request', 'response',
  'usage', 'toolCalls', 'storageBytes', 'cost', 'scores', 'logs'
];

function requireField(object, field, context) {
  if (!Object.hasOwn(object, field)) throw new Error(`${context} is missing required field ${field}`);
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

export function validateRawRun(raw, preregistration, expectedSha256) {
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
