import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';

import { createAdapterRequest, validateAdapterResponse } from './adapter-protocol.mjs';
import { OUTER_HTTP_ERROR_CODE, validateDecisionResponse } from './outer-model.mjs';
import { validateV11RawRun } from './validate.mjs';
import {
  OPERATION_FIELDS,
  V11_PHASES,
  canonicalJson,
  deriveArmStatus,
  namespaceRefFor,
  recordContentSha256,
  standardizedDecisionRecord,
  unitIdFor,
  validateApplicability,
  validateOperationMetrics,
  validateStorageMeasurement
} from './v11-contract.mjs';

export { V11_PHASES, unitIdFor };

/**
 * Everything a prompt builder is given.
 *
 * Exported so a caller can see the whole surface at a glance: there is nothing
 * on it that identifies the arm, and that is the point.
 */
export const OUTER_REQUEST_INPUT_FIELDS = Object.freeze(['phase', 'scenario', 'nativeContext']);

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const AMENDMENT_002_SHA256 = '08e12eca3f93bd67cfeaf90a2064f91beb240e78a8fd63ed8645da78c0d88f1b';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
const UNIT_TIMEOUT_MS = 120_000;
const RESUME_PROGRESS_EVENTS = new Set([
  'run_started',
  'unit_started',
  'unit_finished',
  'unit_failed',
  'checkpoint',
  'heartbeat',
  'run_interrupted',
  'run_finished'
]);
const RESUME_PROGRESS_FIELDS = [
  'schema',
  'version',
  'eventNumber',
  'event',
  'monotonicMs',
  'runId',
  'attemptId',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'evidence'
];
const TIMEOUT_ERROR_CODES = new Set([
  'ETIMEDOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UPSTREAM_TIMEOUT',
  'PROVIDER_REQUEST_TIMEOUT'
]);
const ENDPOINT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTDOWN',
  'EHOSTUNREACH',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'ERR_SOCKET_CLOSED'
]);
const OUTER_RESULT_FIELDS = ['decision', 'usage', 'providerModel', 'requestCount', 'correlation'];
const OUTER_CORRELATION_FIELDS = [
  'runId',
  'attemptId',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'requestClass'
];
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

function requireSafeId(value, label) {
  if (!isNonEmptyString(value) || !SAFE_ID.test(value)) {
    throw new Error(`${label} must be a header-safe non-empty identifier`);
  }
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH.test(value)) {
    throw new Error(`${label} must be a lowercase full SHA-256 digest`);
  }
}

function assertIsoTimestamp(value, label) {
  if (!isNonEmptyString(value) || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must return an ISO timestamp`);
  }
  return value;
}

function zeroOperations() {
  return Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0]));
}

function addOperations(target, source) {
  validateOperationMetrics(source);
  for (const field of OPERATION_FIELDS) {
    const value = target[field] + source[field];
    if (!Number.isSafeInteger(value)) throw new Error(`Operation metric ${field} overflowed`);
    target[field] = value;
  }
}

function publicAdapterEvidence(response, namespaceRef) {
  if (response === null) return null;
  return {
    status: response.status,
    namespaceRef,
    nativeContextCount: response.result.nativeContext.length,
    persistenceEvidence: structuredClone(response.result.persistenceEvidence),
    isolationEvidence: structuredClone(response.result.isolationEvidence),
    operations: { ...response.operations },
    storage: structuredClone(response.storage)
  };
}

function publicFailure(cause, operation, message) {
  return { cause, operation, message };
}

function adapterFailure(response, operation) {
  if (response.status !== 'FAILED') return null;
  return publicFailure(
    response.failure.cause,
    operation,
    'Measured adapter operation failed'
  );
}

function errorGraph(error) {
  const pending = [error];
  const seen = new Set();
  const values = [];
  while (pending.length > 0) {
    const candidate = pending.shift();
    if ((typeof candidate !== 'object' && typeof candidate !== 'function')
      || candidate === null
      || seen.has(candidate)) continue;
    seen.add(candidate);
    values.push(candidate);
    if (candidate.cause !== undefined) pending.push(candidate.cause);
    if (Array.isArray(candidate.errors)) pending.push(...candidate.errors);
  }
  return values;
}

function thrownFailure(error, operation, signal) {
  if (signal?.aborted) {
    return publicFailure('OPERATOR_INTERRUPTION', operation, 'Operator interrupted the measured unit');
  }
  const errors = errorGraph(error);
  if (errors.some((item) => item.name === 'AbortError' || TIMEOUT_ERROR_CODES.has(item.code))) {
    return publicFailure('TIMEOUT', operation, 'Measured operation exceeded its registered timeout');
  }
  const httpError = errors.find((item) => item.code === OUTER_HTTP_ERROR_CODE
    && Number.isInteger(item.status)
    && item.status >= 400
    && item.status <= 599);
  if (httpError?.status === 408) {
    return publicFailure('TIMEOUT', operation, 'Measured operation exceeded its registered timeout');
  }
  if ([502, 503, 504].includes(httpError?.status)) {
    return publicFailure('ENDPOINT_UNAVAILABLE', operation, 'Measured endpoint was unavailable');
  }
  if (httpError !== undefined) {
    return publicFailure('OPERATION_FAILED', operation, 'Measured provider operation failed');
  }
  if (errors.some((item) => ENDPOINT_ERROR_CODES.has(item.code))) {
    return publicFailure('ENDPOINT_UNAVAILABLE', operation, 'Measured endpoint was unavailable');
  }
  return publicFailure('CONTRACT_FAILURE', operation, 'Measured operation failed closed');
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw Object.assign(new Error('Measured operation was aborted'), { name: 'AbortError' });
}

async function loadAmendment002(options) {
  if (options.amendment002Sha256 !== AMENDMENT_002_SHA256) {
    throw new Error('Amendment 002 hash is not the exact locked v1.1 source digest');
  }
  let source;
  try {
    source = await readFile(options.amendment002Path);
  } catch {
    throw new Error('Unable to read Amendment 002 source');
  }
  const actualHash = createHash('sha256').update(source).digest('hex');
  if (actualHash !== options.amendment002Sha256) {
    throw new Error('Amendment 002 source bytes do not match amendment002Sha256');
  }
  let amendment;
  try {
    amendment = JSON.parse(source.toString('utf8'));
  } catch {
    throw new Error('Amendment 002 source is not valid JSON');
  }
  if (amendment?.supersedes?.preregistrationSha256 !== options.preregistrationSha256) {
    throw new Error('Amendment 002 preregistration hash does not match the runner option');
  }
  if (amendment?.supersedes?.amendment001Sha256 !== options.amendment001Sha256) {
    throw new Error('Amendment 002 Amendment 001 hash does not match the runner option');
  }
  const matrix = amendment?.definitions?.applicability?.armMatrix;
  if (!isPlainObject(matrix) || Object.keys(matrix).length === 0) {
    throw new Error('Amendment 002 must define a non-empty applicability armMatrix');
  }
  for (const [armId, declared] of Object.entries(matrix)) {
    try {
      validateApplicability(declared);
    } catch (error) {
      throw new Error(`Amendment 002 armMatrix entry ${armId} is invalid`, { cause: error });
    }
  }
  for (const arm of options.arms) {
    const declared = matrix[arm.id];
    if (!Object.hasOwn(matrix, arm.id)) {
      throw new Error(`Arm ${arm.id} is absent from Amendment 002 armMatrix`);
    }
    for (const capability of ['userIsolation', 'persistence']) {
      if (arm.applicability[capability].status !== declared[capability].status
        || arm.applicability[capability].reason !== declared[capability].reason) {
        throw new Error(`Arm ${arm.id} applicability contradicts Amendment 002 armMatrix`);
      }
    }
  }
  return amendment;
}

function validateArm(arm, seen) {
  if (!isPlainObject(arm)) throw new Error('Each arm must be an object');
  requireSafeId(arm.id, 'arm.id');
  if (seen.has(arm.id)) throw new Error(`Duplicate arm id: ${arm.id}`);
  seen.add(arm.id);
  if (!isNonEmptyString(arm.name)) throw new Error(`Arm ${arm.id} must have a non-empty name`);
  validateApplicability(arm.applicability);
}

function validateScenario(scenario, seen) {
  if (!isPlainObject(scenario)) throw new Error('Each scenario must be an object');
  for (const field of [
    'id', 'projectId', 'userId', 'isolationProjectId', 'isolationUserId', 'task'
  ]) {
    if (!isNonEmptyString(scenario[field])) throw new Error(`scenario.${field} must be a non-empty string`);
  }
  requireSafeId(scenario.id, 'scenario.id');
  if (seen.has(scenario.id)) throw new Error(`Duplicate scenario id: ${scenario.id}`);
  seen.add(scenario.id);
  if (!isPlainObject(scenario.failedAttempt)) throw new Error('scenario.failedAttempt must be an object');
  for (const field of ['id', 'approachId', 'reasonId', 'reason']) {
    if (!isNonEmptyString(scenario.failedAttempt[field])) {
      throw new Error(`scenario.failedAttempt.${field} must be a non-empty string`);
    }
  }
}

function validationDefinition(options) {
  return {
    arms: options.arms.map((arm) => ({
      id: arm.id,
      name: arm.name,
      applicability: structuredClone(arm.applicability)
    })),
    commonExecution: {
      repetitions: options.repetitions,
      randomSeeds: [...options.seeds]
    },
    scenarios: structuredClone(options.scenarios)
  };
}

async function readHashedEvidence(path, expectedHash, label) {
  if (!isNonEmptyString(path)) throw new Error(`${label} path must be a non-empty string`);
  requireHash(expectedHash, `${label} sha256`);
  let source;
  try {
    source = await readFile(path);
  } catch {
    throw new Error(`Unable to read ${label}`);
  }
  const actualHash = createHash('sha256').update(source).digest('hex');
  if (actualHash !== expectedHash) throw new Error(`${label} does not match its sha256`);
  return source;
}

function parseJsonEvidence(source, label) {
  try {
    const parsed = JSON.parse(source.toString('utf8'));
    if (!isPlainObject(parsed)) throw new Error('not an object');
    return parsed;
  } catch {
    throw new Error(`${label} must contain one JSON object`);
  }
}

function parseNdjsonEvidence(source, label, allowEmpty) {
  if (source.length === 0) {
    if (allowEmpty) return [];
    throw new Error(`${label} must not be empty`);
  }
  const text = source.toString('utf8');
  if (!text.endsWith('\n')) throw new Error(`${label} is truncated`);
  const lines = text.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) throw new Error(`${label} contains a blank record`);
  return lines.map((line, index) => {
    try {
      const parsed = JSON.parse(line);
      if (!isPlainObject(parsed)) throw new Error('not an object');
      return parsed;
    } catch {
      throw new Error(`${label} record ${index + 1} is invalid`);
    }
  });
}

function progressUnitId(record) {
  return unitIdFor({
    armId: record.armId,
    scenarioId: record.scenarioId,
    repetition: record.repetition,
    phase: record.phase
  });
}

function validateRunStartedRecord(record, options) {
  assertExactKeys(
    record.evidence,
    ['mode', 'implementationLockHash', 'environmentLockHash'],
    'resume run_started evidence'
  );
  if (record.evidence.mode !== (options.scored ? 'SCORED' : 'ACCEPTANCE')
    || record.evidence.implementationLockHash !== options.implementationLockHash
    || record.evidence.environmentLockHash !== options.environmentLockHash) {
    throw new Error('Resume progress run_started evidence differs from the current locked run');
  }
}

function validateProgressRecords(
  records,
  options,
  artifact,
  plannedIds,
  startedIds,
  terminals
) {
  let activeId = null;
  let pendingCheckpointId = null;
  let lastMonotonicMs = null;
  let terminalRun = false;
  const attemptTerminalIds = new Set();
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    assertExactKeys(record, RESUME_PROGRESS_FIELDS, `resume progress record ${index + 1}`);
    if (record.schema !== 'shadowgraph.progress.event' || record.version !== 1) {
      throw new Error('Resume progress record has an unsupported schema');
    }
    if (record.eventNumber !== index + 1) {
      throw new Error('Resume progress event numbers must be contiguous from one');
    }
    if (!Number.isFinite(record.monotonicMs)
      || record.monotonicMs < 0
      || (lastMonotonicMs !== null && record.monotonicMs < lastMonotonicMs)) {
      throw new Error('Resume progress monotonic time is invalid');
    }
    lastMonotonicMs = record.monotonicMs;
    if (record.runId !== options.runId || record.attemptId !== artifact.attemptId) {
      throw new Error('Resume progress correlation differs from its run or attempt');
    }
    if (!RESUME_PROGRESS_EVENTS.has(record.event) || terminalRun) {
      throw new Error('Resume progress contains an invalid event sequence');
    }

    if (record.event === 'run_started') {
      if (index !== 0 || activeId !== null || pendingCheckpointId !== null) {
        throw new Error('Resume progress must begin with exactly one run_started');
      }
      if ([record.armId, record.scenarioId, record.repetition, record.phase].some((value) => value !== null)) {
        throw new Error('Resume run event contains unit correlation');
      }
      validateRunStartedRecord(record, options);
      continue;
    }
    if (index === 0) throw new Error('Resume progress must begin with run_started');

    if (record.event === 'run_interrupted') {
      if (index !== records.length - 1 || pendingCheckpointId !== null) {
        throw new Error('Resume progress must end durably with run_interrupted');
      }
      if ([record.armId, record.scenarioId, record.repetition, record.phase].some((value) => value !== null)
        || !isPlainObject(record.evidence)
        || record.evidence.cause !== 'OPERATOR_INTERRUPTION') {
        throw new Error('Resume run_interrupted evidence is invalid');
      }
      activeId = null;
      terminalRun = true;
      continue;
    }
    if (record.event === 'run_finished') {
      throw new Error('Diagnostic resume cannot use a finished attempt ledger');
    }

    const id = progressUnitId(record);
    if (!plannedIds.has(id)) throw new Error(`Resume contains unknown started unit: ${id}`);
    if (record.event === 'unit_started') {
      if (activeId !== null || pendingCheckpointId !== null || startedIds.has(id)) {
        throw new Error(`Resume contains a duplicate or out-of-order unit start: ${id}`);
      }
      const expectedSeed = options.seeds[record.repetition];
      if (!isPlainObject(record.evidence) || record.evidence.seed !== expectedSeed) {
        throw new Error(`Resume unit start ${id} has the wrong seed`);
      }
      activeId = id;
      startedIds.add(id);
      continue;
    }
    if (record.event === 'heartbeat') {
      if (activeId !== id) throw new Error(`Resume heartbeat does not match its active unit: ${id}`);
      continue;
    }
    if (record.event === 'unit_finished' || record.event === 'unit_failed') {
      if (activeId !== id || terminals.has(id)) {
        throw new Error(`Resume terminal event does not match its active unit: ${id}`);
      }
      terminals.set(id, {
        attemptId: artifact.attemptId,
        event: record.event,
        evidence: structuredClone(record.evidence),
        checkpointed: false
      });
      attemptTerminalIds.add(id);
      activeId = null;
      pendingCheckpointId = id;
      continue;
    }
    if (record.event === 'checkpoint') {
      if (pendingCheckpointId !== id) {
        throw new Error(`Resume checkpoint does not match its terminal unit: ${id}`);
      }
      terminals.get(id).checkpointed = true;
      pendingCheckpointId = null;
      continue;
    }
    throw new Error(`Unsupported resume progress event: ${record.event}`);
  }
  if (!terminalRun) throw new Error('Resume progress ledger must end with run_interrupted');
  return attemptTerminalIds;
}

async function validateAttemptArtifact(
  artifact,
  options,
  plannedIds,
  startedIds,
  terminals,
  durableUnits,
  durableUnitIds
) {
  assertExactKeys(artifact, [
    'attemptId',
    'progressPath',
    'progressSha256',
    'unitEvidencePath',
    'unitEvidenceSha256'
  ], 'resume attempt ledger');
  requireSafeId(artifact.attemptId, 'resume attempt ledger.attemptId');
  const [progressSource, unitSource] = await Promise.all([
    readHashedEvidence(artifact.progressPath, artifact.progressSha256, 'resume progress ledger'),
    readHashedEvidence(artifact.unitEvidencePath, artifact.unitEvidenceSha256, 'resume unit-evidence ledger')
  ]);
  const records = parseNdjsonEvidence(progressSource, 'resume progress ledger', false);
  const attemptTerminalIds = validateProgressRecords(
    records,
    options,
    artifact,
    plannedIds,
    startedIds,
    terminals
  );
  const units = parseNdjsonEvidence(unitSource, 'resume unit-evidence ledger', true);
  for (const unit of units) {
    if (unit.runId !== options.runId || unit.attemptId !== artifact.attemptId) {
      throw new Error('Resume unit evidence differs from its run or attempt');
    }
    if (!isNonEmptyString(unit.unitId) || !plannedIds.has(unit.unitId) || durableUnitIds.has(unit.unitId)) {
      throw new Error(`Resume unit evidence has an unknown or duplicate unitId: ${unit.unitId}`);
    }
    const terminal = terminals.get(unit.unitId);
    const expectedTerminal = unit.status === 'FAILED' ? 'unit_failed' : 'unit_finished';
    if (terminal?.attemptId !== artifact.attemptId
      || terminal.event !== expectedTerminal
      || terminal.checkpointed !== true
      || terminal.evidence?.status !== unit.status
      || (unit.status === 'FAILED'
        && (terminal.evidence.cause !== unit.failure?.cause
          || terminal.evidence.operation !== unit.failure?.operation))) {
      throw new Error(`Resume unit ${unit.unitId} lacks matching durable terminal evidence`);
    }
    durableUnitIds.add(unit.unitId);
    durableUnits.push(unit);
    attemptTerminalIds.delete(unit.unitId);
  }
  if (attemptTerminalIds.size > 0) {
    throw new Error(`Resume terminal event lacks unit evidence: ${[...attemptTerminalIds][0]}`);
  }
}

async function validateResume(options, plannedIds) {
  const resume = options.resume;
  if (resume === null || resume === undefined) return null;
  if (!isPlainObject(resume)) throw new Error('resume must be null or an object');
  assertExactKeys(
    resume,
    [
      'previousRawPath',
      'previousRawSha256',
      'attemptLedgers',
      'infrastructureRepaired'
    ],
    'resume'
  );
  if (resume.infrastructureRepaired === true) {
    throw new Error('Infrastructure repair requires a new runId');
  }
  if (resume.infrastructureRepaired !== false) {
    throw new Error('resume.infrastructureRepaired must be false');
  }
  if (!Array.isArray(resume.attemptLedgers) || resume.attemptLedgers.length === 0) {
    throw new Error('resume.attemptLedgers must be a non-empty array');
  }
  const previousRawSource = await readHashedEvidence(
    resume.previousRawPath,
    resume.previousRawSha256,
    'resume previous raw artifact'
  );
  const previousRaw = parseJsonEvidence(previousRawSource, 'resume previous raw artifact');
  if (previousRaw.runId !== options.runId) {
    throw new Error('Diagnostic resume requires the same runId');
  }
  if (previousRaw.attemptId === options.attemptId
    || previousRaw.attemptIds?.includes(options.attemptId)) {
    throw new Error('Diagnostic resume requires a new attemptId');
  }
  if (previousRaw.implementationLockHash !== options.implementationLockHash) {
    throw new Error('Changed implementation lock requires a new runId');
  }
  if (previousRaw.environmentLockHash !== options.environmentLockHash) {
    throw new Error('Changed environment lock requires a new runId');
  }
  for (const field of ['preregistrationSha256', 'amendment001Sha256', 'amendment002Sha256']) {
    if (previousRaw[field] !== options[field]) {
      throw new Error(`Changed ${field} requires a new runId`);
    }
  }
  if (previousRaw.mode !== (options.scored ? 'SCORED' : 'ACCEPTANCE')) {
    throw new Error('Diagnostic resume cannot change scored mode');
  }
  if (previousRaw.status !== 'INTERRUPTED') {
    throw new Error('Diagnostic resume requires an INTERRUPTED previous raw run');
  }
  validateV11RawRun(previousRaw, validationDefinition(options), options.preregistrationSha256);
  if (previousRaw.attemptIds.length !== resume.attemptLedgers.length
    || previousRaw.attemptIds.some((attemptId, index) => (
      attemptId !== resume.attemptLedgers[index]?.attemptId
    ))) {
    throw new Error('Resume attempt ledgers must exactly match previousRaw.attemptIds in order');
  }
  if (previousRaw.attemptId !== previousRaw.attemptIds.at(-1)) {
    throw new Error('Resume previousRaw.attemptId must be the last prior attempt');
  }
  const paths = [resume.previousRawPath];
  const attemptIds = new Set();
  for (const artifact of resume.attemptLedgers) {
    if (!isPlainObject(artifact)) throw new Error('Each resume attempt ledger must be an object');
    for (const field of ['progressPath', 'unitEvidencePath']) {
      if (isNonEmptyString(artifact[field])) paths.push(artifact[field]);
    }
    if (attemptIds.has(artifact.attemptId)) throw new Error('Resume attempt ledger ids must be unique');
    attemptIds.add(artifact.attemptId);
  }
  if (new Set(paths).size !== paths.length) throw new Error('Resume evidence paths must be distinct');

  const startedIds = new Set();
  const terminals = new Map();
  const durableUnits = [];
  const durableUnitIds = new Set();
  for (const artifact of resume.attemptLedgers) {
    await validateAttemptArtifact(
      artifact,
      options,
      plannedIds,
      startedIds,
      terminals,
      durableUnits,
      durableUnitIds
    );
  }
  if (!isDeepStrictEqual(durableUnits, previousRaw.units)) {
    throw new Error('Resume unit-evidence ledgers do not exactly match previousRaw.units');
  }
  return {
    previousRaw,
    startedUnitIds: [...startedIds]
  };
}

function validateOptions(options) {
  if (!isPlainObject(options)) throw new Error('runner options must be an object');
  requireSafeId(options.runId, 'runId');
  requireSafeId(options.attemptId, 'attemptId');
  if (typeof options.scored !== 'boolean') throw new Error('scored must be boolean');
  if (!Array.isArray(options.arms) || options.arms.length === 0) throw new Error('arms must be non-empty');
  if (!Array.isArray(options.scenarios) || options.scenarios.length === 0) throw new Error('scenarios must be non-empty');
  const armIds = new Set();
  options.arms.forEach((item) => validateArm(item, armIds));
  const scenarioIds = new Set();
  options.scenarios.forEach((item) => validateScenario(item, scenarioIds));
  if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error('repetitions must be a positive safe integer');
  }
  if (!Array.isArray(options.seeds)
    || options.seeds.length !== options.repetitions
    || !options.seeds.every((seed) => Number.isSafeInteger(seed) && seed >= 0)) {
    throw new Error('seeds must contain one non-negative safe integer per repetition');
  }
  for (const field of [
    'preregistrationSha256',
    'amendment001Sha256',
    'amendment002Sha256',
    'implementationLockHash',
    'environmentLockHash'
  ]) requireHash(options[field], field);
  if (!isNonEmptyString(options.amendment002Path)) {
    throw new Error('amendment002Path must identify the exact Amendment 002 source file');
  }
  if (!isPlainObject(options.progress)
    || typeof options.progress.append !== 'function'
    || typeof options.progress.watchdogState !== 'function') {
    throw new Error('progress.append and progress.watchdogState are required');
  }
  if (options.closeResources !== undefined && typeof options.closeResources !== 'function') {
    throw new Error('closeResources must be a function when provided');
  }
  if (options.heartbeatIntervalMs !== undefined
    && (!Number.isSafeInteger(options.heartbeatIntervalMs) || options.heartbeatIntervalMs < 1)) {
    throw new Error('heartbeatIntervalMs must be a positive safe integer when provided');
  }
  for (const field of [
    'executeAdapter',
    'buildOuterRequest',
    'requestOuter',
    'persistUnit',
    'now',
    'monotonicNow'
  ]) {
    if (typeof options[field] !== 'function') throw new Error(`${field} must be a function`);
  }
}

function rotatedArms(arms, seed) {
  const offset = seed % arms.length;
  return [...arms.slice(offset), ...arms.slice(0, offset)];
}

function createPlan(options) {
  const plan = [];
  for (let repetition = 0; repetition < options.repetitions; repetition += 1) {
    for (const scenario of options.scenarios) {
      for (const arm of rotatedArms(options.arms, options.seeds[repetition])) {
        for (const phase of V11_PHASES) {
          plan.push({
            unitId: unitIdFor({ armId: arm.id, scenarioId: scenario.id, repetition, phase }),
            arm,
            scenario,
            repetition,
            seed: options.seeds[repetition],
            phase
          });
        }
      }
    }
  }
  return plan;
}

function primaryNamespace(spec) {
  return {
    projectId: spec.scenario.projectId,
    userId: spec.arm.applicability.userIsolation.status === 'SUPPORTED'
      ? spec.scenario.userId
      : null
  };
}

function alternateNamespace(spec) {
  if (spec.phase === 'ISOLATION_PROJECT') {
    return {
      projectId: spec.scenario.isolationProjectId,
      userId: spec.arm.applicability.userIsolation.status === 'SUPPORTED'
        ? spec.scenario.userId
        : null
    };
  }
  if (spec.phase === 'ISOLATION_USER') {
    return {
      projectId: spec.scenario.projectId,
      userId: spec.scenario.isolationUserId
    };
  }
  return null;
}

function correlation(options, spec) {
  return {
    runId: options.runId,
    attemptId: options.attemptId,
    phase: spec.phase,
    armId: spec.arm.id,
    scenarioId: spec.scenario.id,
    repetition: spec.repetition
  };
}

function namespaceCorrelation(options, spec) {
  return {
    runId: options.runId,
    armId: spec.arm.id,
    scenarioId: spec.scenario.id,
    repetition: spec.repetition,
    phase: spec.phase
  };
}

function progressEvent(event, spec = null, evidence = null) {
  return {
    event,
    armId: spec?.arm.id ?? null,
    scenarioId: spec?.scenario.id ?? null,
    repetition: spec?.repetition ?? null,
    phase: spec?.phase ?? null,
    evidence
  };
}

async function appendProgress(options, event, spec = null, evidence = null) {
  await options.progress.append(progressEvent(event, spec, evidence));
}

async function persistCompletedUnit(options, unit) {
  await options.persistUnit(structuredClone(unit));
}

function startHeartbeat(options, spec) {
  let active = true;
  let failure = null;
  let queue = Promise.resolve();
  const intervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const timer = setInterval(() => {
    queue = queue.then(async () => {
      if (!active || failure !== null) return;
      try {
        await appendProgress(options, 'heartbeat', spec, { state: 'IN_PROGRESS' });
      } catch (error) {
        failure = error;
      }
    });
  }, intervalMs);
  timer.unref?.();

  return async () => {
    active = false;
    clearInterval(timer);
    await queue;
    if (failure !== null) throw failure;
  };
}

function watchdogError(failure) {
  return Object.assign(new Error(failure.cause), { unitFailure: failure });
}

function watchdogCorrelationMatches(activeCorrelation, spec) {
  return isPlainObject(activeCorrelation)
    && activeCorrelation.armId === spec.arm.id
    && activeCorrelation.scenarioId === spec.scenario.id
    && activeCorrelation.repetition === spec.repetition
    && activeCorrelation.phase === spec.phase;
}

function readUnitMonotonic(options) {
  const value = options.monotonicNow();
  if (!Number.isFinite(value) || value < 0) {
    throw new Error('monotonicNow must return a non-negative finite number');
  }
  return value;
}

async function runWithUnitWatchdog(options, spec, startedMonotonic, operation) {
  const controller = new AbortController();
  let completed = false;
  let pollTimer = null;
  let hardTimer = null;
  let rejectControl;
  const control = new Promise((resolve, reject) => {
    void resolve;
    rejectControl = reject;
  });

  const fail = (failure) => {
    if (completed) return;
    const error = watchdogError(failure);
    rejectControl(error);
    controller.abort(error);
  };
  const timeout = () => fail(publicFailure(
    'TIMEOUT',
    'runner',
    `Measured unit exceeded the ${UNIT_TIMEOUT_MS}ms monotonic deadline`
  ));
  const operatorAbort = () => fail(publicFailure(
    'OPERATOR_INTERRUPTION',
    'runner',
    'Operator interrupted the measured unit'
  ));

  if (options.signal?.aborted) operatorAbort();
  else options.signal?.addEventListener('abort', operatorAbort, { once: true });

  const poll = async () => {
    if (completed) return;
    try {
      const state = await options.progress.watchdogState();
      if (completed) return;
      if (!isPlainObject(state)
        || typeof state.stalled !== 'boolean'
        || (state.stalled ? state.cause !== 'UNIT_TIMEOUT' : state.cause !== null)
        || !Number.isFinite(state.elapsedMs)
        || state.elapsedMs < 0
        || !watchdogCorrelationMatches(state.activeCorrelation, spec)) {
        fail(publicFailure(
          'CONTRACT_FAILURE',
          'watchdog',
          'Progress watchdog did not report the active unit correlation'
        ));
        return;
      }
      const current = readUnitMonotonic(options);
      if (current < startedMonotonic) {
        fail(publicFailure('CONTRACT_FAILURE', 'watchdog', 'Unit monotonic clock moved backwards'));
        return;
      }
      const hardElapsed = current - startedMonotonic;
      if (state.stalled || hardElapsed >= UNIT_TIMEOUT_MS) {
        timeout();
        return;
      }
      const intervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
      pollTimer = setTimeout(poll, Math.max(1, Math.min(intervalMs, UNIT_TIMEOUT_MS - hardElapsed)));
      pollTimer.unref?.();
    } catch {
      fail(publicFailure('CONTRACT_FAILURE', 'watchdog', 'Progress watchdog failed closed'));
    }
  };

  hardTimer = setTimeout(timeout, UNIT_TIMEOUT_MS);
  void poll();
  try {
    return await Promise.race([
      Promise.resolve().then(() => operation(controller.signal)),
      control
    ]);
  } finally {
    completed = true;
    clearTimeout(pollTimer);
    clearTimeout(hardTimer);
    options.signal?.removeEventListener('abort', operatorAbort);
  }
}

function baseUnit(options, spec, startedAt) {
  return {
    schemaVersion: 1,
    unitId: spec.unitId,
    runId: options.runId,
    attemptId: options.attemptId,
    armId: spec.arm.id,
    scenarioId: spec.scenario.id,
    repetition: spec.repetition,
    seed: spec.seed,
    phase: spec.phase,
    status: 'FAILED',
    statusReason: null,
    applicability: structuredClone(spec.arm.applicability),
    startedAt,
    finishedAt: null,
    latencyMs: null,
    decisionResponse: null,
    providerUsage: null,
    providerModel: null,
    operations: zeroOperations(),
    storage: null,
    adapterEvidence: {
      reset: null,
      setupPersist: null,
      setupVerify: null,
      retrieve: null,
      persist: null,
      verify: null
    },
    failure: null
  };
}

function elapsed(started, finished) {
  return Number(Math.max(0, finished - started).toFixed(3));
}

function assertAdapterOutcome(response, spec, operation) {
  const failure = adapterFailure(response, operation);
  if (failure !== null) throw Object.assign(new Error('ADAPTER_FAILED'), { unitFailure: failure });
  if (response.status === 'NOT_APPLICABLE') {
    const permitted = ['persist', 'verify'].includes(operation)
      && spec.arm.applicability.persistence.status === 'NOT_APPLICABLE';
    if (!permitted) {
      throw Object.assign(new Error('UNEXPECTED_NOT_APPLICABLE'), {
        unitFailure: publicFailure('CONTRACT_FAILURE', operation, 'Adapter returned unexpected NOT_APPLICABLE')
      });
    }
  } else if (['persist', 'verify'].includes(operation)
    && spec.arm.applicability.persistence.status === 'NOT_APPLICABLE') {
    throw Object.assign(new Error('EXPECTED_NOT_APPLICABLE'), {
      unitFailure: publicFailure('CONTRACT_FAILURE', operation, 'Adapter contradicted harness applicability')
    });
  }
}

async function invokeAdapter(
  options,
  spec,
  operation,
  namespace,
  payload,
  unit,
  signal,
  evidenceKey = operation
) {
  const request = createAdapterRequest({
    operation,
    correlation: correlation(options, spec),
    namespace,
    payload
  });
  let response;
  try {
    throwIfAborted(signal);
    response = await options.executeAdapter(request, { signal });
    throwIfAborted(signal);
    validateAdapterResponse({ request, response });
    addOperations(unit.operations, response.operations);
    unit.adapterEvidence[evidenceKey] = publicAdapterEvidence(response, request.namespaceRef);
    unit.storage = structuredClone(response.storage);
    assertAdapterOutcome(response, spec, operation);
  } catch (error) {
    if (error?.unitFailure) throw error;
    throw Object.assign(new Error('ADAPTER_CONTRACT_FAILURE'), {
      unitFailure: thrownFailure(error, operation, options.signal)
    });
  }
  return response;
}

function validateUsageCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid provider usage count');
}

function validateOuterUsage(usage) {
  if (usage === null) return;
  if (!isPlainObject(usage)) throw new Error('Outer provider usage must be null or an object');
  for (const [field, value] of Object.entries(usage)) {
    if (USAGE_COUNT_FIELDS.has(field)) {
      validateUsageCount(value);
      continue;
    }
    if (!USAGE_OBJECT_FIELDS.has(field) || !isPlainObject(value)) {
      throw new Error(`Invalid outer provider usage field: ${field}`);
    }
    for (const [detailField, detailValue] of Object.entries(value)) {
      if (!USAGE_DETAIL_FIELDS.has(detailField)) {
        throw new Error(`Invalid outer provider usage detail field: ${detailField}`);
      }
      validateUsageCount(detailValue);
    }
  }
}

function domainDigest(domain, value) {
  return createHash('sha256')
    .update(domain, 'utf8')
    .update('\0', 'utf8')
    .update(canonicalJson(value), 'utf8')
    .digest('hex');
}

/**
 * Audit the outer request the harness is about to send.
 *
 * The runner is the one place every arm passes through, so it is the only
 * place that can hold the outer decision path common. The prompt builder is
 * injected, which is what makes the runner testable - and also what would let
 * a caller hand one arm different instructions. Arms whose instructions
 * differed would make every measured difference between them meaningless.
 *
 * Three things are held common, and the third is the one that matters most:
 *
 *  - the system instruction and the response schema, fixed by the first
 *    measured decision unit and required to match thereafter;
 *  - the prompt, which must not depend on the arm. This one took three
 *    attempts and the first two are worth recording, because each looked
 *    sufficient. Auditing only the system instruction left the task prompt -
 *    where the instructions actually live - free to differ per arm. Comparing
 *    prompts across units sharing a phase, scenario and native context is
 *    weaker than it looks: in a real run each arm returns its own context, so
 *    almost every unit is the only one of its shape and the arm that gets there
 *    first sets its own baseline. Substituting a probe arm and requiring an
 *    identical rebuild closed the `arm` field but left `correlation.armId` and
 *    `namespace.userId` reaching the builder unsubstituted, and both were
 *    exploitable: branching on `correlation.armId` reproduced the original
 *    bypass exactly.
 *
 *    The builder is now given `phase`, `scenario` and `nativeContext` and
 *    nothing else, so no channel identifying the arm reaches it at all. That is
 *    structural rather than detective - there is nothing left to detect - and
 *    it is why the input surface is exported and asserted. The rebuild check
 *    below stays, because a builder could still infer position from the order
 *    it is called in; the two builds are adjacent and identical, so a builder
 *    whose output depends on anything but its arguments is caught;
 *  - the prompt must not name the arm it is running, which is the same bias
 *    arriving by a shorter route.
 *
 * What is checked is divergence, not a particular wording. Pinning the text
 * here would bind the runner to one prompt module without catching anything
 * divergence does not, and `buildV11Prompt` already audits its own output.
 *
 * The system and schema baseline is carried across a diagnostic resume through
 * `outerPromptBinding` in the previous raw run, so a resumed attempt cannot
 * quietly adopt a different instruction. The arm-invariance check needs no
 * baseline at all, so it holds identically on a resumed attempt.
 */
function auditOuterRequest(request, spec, rebuild, baseline) {
  assertExactKeys(request, ['system', 'prompt', 'responseSchema'], 'outer request');
  if (!isNonEmptyString(request.system)) {
    throw new Error('Outer request system instruction must be a non-empty string');
  }
  if (!isNonEmptyString(request.prompt)) {
    throw new Error('Outer request prompt must be a non-empty string');
  }

  const systemSha256 = domainDigest('shadowgraph:v1.1:outer-system:v1', request.system);
  const responseSchemaSha256 = domainDigest(
    'shadowgraph:v1.1:outer-schema:v1',
    request.responseSchema ?? null
  );
  if (baseline.systemSha256 === null) {
    baseline.systemSha256 = systemSha256;
    baseline.responseSchemaSha256 = responseSchemaSha256;
  } else {
    if (systemSha256 !== baseline.systemSha256) {
      throw new Error('Outer request system instruction diverged from the common outer path');
    }
    if (responseSchemaSha256 !== baseline.responseSchemaSha256) {
      throw new Error('Outer request response schema diverged from the common outer path');
    }
  }

  // The same call again, with the same arguments. A prompt builder is a pure
  // function of its input; one whose output drifts between adjacent calls is
  // reading something the harness did not give it - a counter, a clock, the
  // order the arms happen to run in - and that is a channel for per-arm
  // variation the narrowed input cannot close.
  if (!isDeepStrictEqual(rebuild(), request)) {
    throw new Error('Outer request builder is not a pure function of its input');
  }

  const prompt = request.prompt.toLowerCase();
  for (const identity of [spec.arm.id, spec.arm.name]) {
    if (isNonEmptyString(identity) && prompt.includes(identity.toLowerCase())) {
      throw new Error('Outer request prompt must not identify the arm under measurement');
    }
  }
}

function validateOuterResult(outer, expectedCorrelation) {
  assertExactKeys(outer, OUTER_RESULT_FIELDS, 'outer result');
  if (outer.requestCount !== 1) throw new Error('outer result.requestCount must equal 1');
  validateDecisionResponse(outer.decision);
  validateOuterUsage(outer.usage);
  if (outer.providerModel !== null && !isNonEmptyString(outer.providerModel)) {
    throw new Error('outer result.providerModel must be null or a non-empty string');
  }
  assertExactKeys(outer.correlation, OUTER_CORRELATION_FIELDS, 'outer result.correlation');
  for (const field of OUTER_CORRELATION_FIELDS) {
    if (outer.correlation[field] !== expectedCorrelation[field]) {
      throw new Error(`Outer result correlation mismatch for ${field}`);
    }
  }
}

async function executeReset(options, spec, unit, signal) {
  const namespace = primaryNamespace(spec);
  const response = await invokeAdapter(options, spec, 'reset', namespace, {}, unit, signal);
  unit.storage = structuredClone(response.storage);
}

function phaseAExpectedAbsentRecord(spec, completedUnits) {
  if (!['ISOLATION_PROJECT', 'ISOLATION_USER'].includes(spec.phase)) return null;
  const phaseA = completedUnits.find((candidate) => candidate.armId === spec.arm.id
    && candidate.scenarioId === spec.scenario.id
    && candidate.repetition === spec.repetition
    && candidate.phase === 'A');
  if (phaseA?.status !== 'MEASURED' || phaseA.decisionResponse === null) {
    throw Object.assign(new Error('MISSING_PHASE_A_EVIDENCE'), {
      unitFailure: publicFailure(
        'CONTRACT_FAILURE',
        'verify',
        'Isolation verification requires a valid measured Phase A unit'
      )
    });
  }
  let record;
  try {
    validateDecisionResponse(phaseA.decisionResponse);
    record = standardizedDecisionRecord({
      armId: spec.arm.id,
      scenarioId: spec.scenario.id,
      repetition: spec.repetition,
      phase: 'A'
    }, phaseA.decisionResponse);
  } catch {
    throw Object.assign(new Error('INVALID_PHASE_A_EVIDENCE'), {
      unitFailure: publicFailure(
        'CONTRACT_FAILURE',
        'verify',
        'Isolation verification requires a valid measured Phase A unit'
      )
    });
  }
  return {
    id: record.id,
    type: record.type,
    contentSha256: recordContentSha256(record.content)
  };
}

async function executeDecision(options, spec, unit, signal, completedUnits, outerBaseline) {
  const expectedAbsentRecord = phaseAExpectedAbsentRecord(spec, completedUnits);
  const namespace = primaryNamespace(spec);
  const probeNamespace = alternateNamespace(spec);
  const retrievalNamespace = probeNamespace ?? namespace;
  if (spec.phase === 'E') {
    const failedAttemptRecord = {
      id: spec.scenario.failedAttempt.id,
      type: 'failed_attempt',
      content: structuredClone(spec.scenario.failedAttempt)
    };
    await invokeAdapter(
      options,
      spec,
      'persist',
      namespace,
      { record: failedAttemptRecord },
      unit,
      signal,
      'setupPersist'
    );
    await invokeAdapter(
      options,
      spec,
      'verify',
      namespace,
      {
        expectedRecord: {
          id: failedAttemptRecord.id,
          type: failedAttemptRecord.type,
          contentSha256: recordContentSha256(failedAttemptRecord.content)
        },
        alternateNamespace: null,
        alternateNamespaceRef: null,
        expectedAbsentRecord: null
      },
      unit,
      signal,
      'setupVerify'
    );
  }
  const retrieved = await invokeAdapter(options, spec, 'retrieve', retrievalNamespace, {
    query: { scenarioId: spec.scenario.id, task: spec.scenario.task }
  }, unit, signal);

  const outerCorrelation = {
    ...correlation(options, spec),
    requestClass: 'outer_decision_llm'
  };
  let outer;
  try {
    // Exactly the fields a fair prompt may depend on. The arm, the namespace
    // and the correlation are all deliberately absent: each identifies the arm
    // under measurement, directly or by proxy, and a builder that cannot see
    // which arm it is serving cannot favour one.
    const buildOuter = () => options.buildOuterRequest({
      phase: spec.phase,
      scenario: structuredClone(spec.scenario),
      nativeContext: structuredClone(retrieved.result.nativeContext)
    });
    const outerRequest = buildOuter();
    auditOuterRequest(outerRequest, spec, buildOuter, outerBaseline);
    throwIfAborted(signal);
    unit.operations.outerDecisionModelCalls += 1;
    outer = await options.requestOuter({
      correlation: outerCorrelation,
      request: outerRequest,
      namespace: structuredClone(retrievalNamespace),
      signal
    });
    throwIfAborted(signal);
    validateOuterResult(outer, outerCorrelation);
  } catch (error) {
    throw Object.assign(new Error('OUTER_FAILURE'), {
      unitFailure: thrownFailure(error, 'outer', options.signal)
    });
  }
  unit.decisionResponse = structuredClone(outer.decision);
  unit.providerUsage = structuredClone(outer.usage);
  unit.providerModel = outer.providerModel;

  const record = standardizedDecisionRecord({
    armId: spec.arm.id,
    scenarioId: spec.scenario.id,
    repetition: spec.repetition,
    phase: spec.phase
  }, outer.decision);
  const persisted = await invokeAdapter(options, spec, 'persist', namespace, { record }, unit, signal);
  const verified = await invokeAdapter(options, spec, 'verify', namespace, {
    expectedRecord: {
      id: record.id,
      type: record.type,
      contentSha256: recordContentSha256(record.content)
    },
    alternateNamespace: probeNamespace,
    alternateNamespaceRef: probeNamespace === null
      ? null
      : namespaceRefFor(namespaceCorrelation(options, spec), probeNamespace),
    expectedAbsentRecord
  }, unit, signal);
  unit.storage = structuredClone(verified.storage ?? persisted.storage);
}

async function executeUnit(options, spec, completedUnits, outerBaseline) {
  const startedAt = assertIsoTimestamp(options.now(), 'now');
  const startedMonotonic = readUnitMonotonic(options);
  const unit = baseUnit(options, spec, startedAt);
  await appendProgress(options, 'unit_started', spec, { seed: spec.seed });
  const stopHeartbeat = startHeartbeat(options, spec);

  if (spec.phase === 'ISOLATION_USER'
    && spec.arm.applicability.userIsolation.status === 'NOT_APPLICABLE') {
    await stopHeartbeat();
    unit.status = 'EXCLUDED';
    unit.statusReason = spec.arm.applicability.userIsolation.reason;
    unit.finishedAt = assertIsoTimestamp(options.now(), 'now');
    unit.latencyMs = null;
    validateOperationMetrics(unit.operations);
    await persistCompletedUnit(options, unit);
    await appendProgress(options, 'unit_finished', spec, { status: unit.status });
    await appendProgress(options, 'checkpoint', spec, { status: unit.status });
    return unit;
  }

  try {
    await runWithUnitWatchdog(options, spec, startedMonotonic, async (signal) => {
      if (spec.phase === 'RESET') await executeReset(options, spec, unit, signal);
      else await executeDecision(options, spec, unit, signal, completedUnits, outerBaseline);
    });
    unit.status = 'MEASURED';
  } catch (error) {
    unit.status = 'FAILED';
    unit.failure = error?.unitFailure ?? thrownFailure(error, 'runner', options.signal);
    unit.statusReason = unit.failure.message;
  }
  await stopHeartbeat();
  const finishedMonotonic = readUnitMonotonic(options);
  unit.finishedAt = assertIsoTimestamp(options.now(), 'now');
  unit.latencyMs = elapsed(startedMonotonic, finishedMonotonic);
  validateOperationMetrics(unit.operations);
  if (unit.storage !== null) validateStorageMeasurement(unit.storage);
  await persistCompletedUnit(options, unit);

  if (unit.status === 'MEASURED') {
    await appendProgress(options, 'unit_finished', spec, { status: unit.status });
  } else {
    await appendProgress(options, 'unit_failed', spec, {
      status: unit.status,
      cause: unit.failure.cause,
      operation: unit.failure.operation
    });
  }
  await appendProgress(options, 'checkpoint', spec, { status: unit.status });
  return unit;
}

function deriveArms(options, plan, units) {
  const byId = new Map(units.map((unit) => [unit.unitId, unit]));
  return options.arms.map((arm) => {
    const statuses = plan
      .filter((spec) => spec.arm.id === arm.id)
      .map((spec) => byId.get(spec.unitId) ?? { status: 'NOT_MEASURED' });
    return {
      armId: arm.id,
      name: arm.name,
      status: deriveArmStatus(statuses),
      applicability: structuredClone(arm.applicability)
    };
  });
}

function zeroResultFor(units, interrupted) {
  const measuredDecisionUnits = units.filter((unit) => unit.phase !== 'RESET' && unit.status === 'MEASURED');
  if (measuredDecisionUnits.length > 0) return null;
  const causes = new Set(units
    .filter((unit) => unit.phase !== 'RESET' && unit.status === 'FAILED')
    .map((unit) => unit.failure?.cause)
    .filter(isNonEmptyString));
  if (interrupted) causes.add('OPERATOR_INTERRUPTION');
  if (causes.size === 0) causes.add('NOT_MEASURED');
  return {
    causes: [...causes].sort(),
    message: 'No decision unit was measured; see retained unit and progress evidence.'
  };
}

/**
 * Execute the v1.1 candidate plan through one harness-owned boundary. Adapters
 * receive memory-only requests; the outer decision call remains centralized.
 */
async function executeV11Benchmark(options, closeResources) {
  await loadAmendment002(options);
  const plan = createPlan(options);
  const plannedIds = new Set(plan.map((spec) => spec.unitId));
  const resume = await validateResume(options, plannedIds);
  const startedIds = new Set(resume?.startedUnitIds ?? []);
  const units = structuredClone(resume?.previousRaw.units ?? []);
  const priorUnitIds = new Set(units.map((unit) => unit.unitId));
  let interrupted = [...startedIds].some((unitId) => !priorUnitIds.has(unitId));
  // Fixed by the first measured decision unit and required to match
  // thereafter. The system and schema half is seeded from the previous
  // attempt's recorded binding, so a resume cannot quietly adopt a different
  // instruction; the per-shape prompt half starts empty because prompt text is
  // not retained in the raw run. See auditOuterRequest.
  const priorBinding = resume?.previousRaw.outerPromptBinding ?? null;
  const outerBaseline = {
    systemSha256: priorBinding?.systemSha256 ?? null,
    responseSchemaSha256: priorBinding?.responseSchemaSha256 ?? null
  };
  const startedAt = resume?.previousRaw.startedAt ?? assertIsoTimestamp(options.now(), 'now');
  const attemptIds = resume
    ? [...resume.previousRaw.attemptIds, options.attemptId]
    : [options.attemptId];

  await appendProgress(options, 'run_started', null, {
    mode: options.scored ? 'SCORED' : 'ACCEPTANCE',
    implementationLockHash: options.implementationLockHash,
    environmentLockHash: options.environmentLockHash
  });

  for (const spec of plan) {
    if (startedIds.has(spec.unitId)) continue;
    if (options.signal?.aborted) {
      interrupted = true;
      break;
    }
    startedIds.add(spec.unitId);
    units.push(await executeUnit(options, spec, units, outerBaseline));
  }
  if (options.signal?.aborted) interrupted = true;
  await closeResources();
  const finishedAt = assertIsoTimestamp(options.now(), 'now');
  const arms = deriveArms(options, plan, units);
  const result = {
    schemaVersion: 2,
    benchmarkVersion: '1.1',
    mode: options.scored ? 'SCORED' : 'ACCEPTANCE',
    runId: options.runId,
    attemptId: options.attemptId,
    attemptIds,
    status: interrupted ? 'INTERRUPTED' : 'COMPLETE',
    preregistrationSha256: options.preregistrationSha256,
    amendment001Sha256: options.amendment001Sha256,
    amendment002Sha256: options.amendment002Sha256,
    implementationLockHash: options.implementationLockHash,
    environmentLockHash: options.environmentLockHash,
    startedAt,
    finishedAt,
    zeroResult: zeroResultFor(units, interrupted),
    outerPromptBinding: outerBaseline.systemSha256 === null
      ? priorBinding
      : {
          systemSha256: outerBaseline.systemSha256,
          responseSchemaSha256: outerBaseline.responseSchemaSha256
        },
    arms,
    units
  };
  validateV11RawRun(result, validationDefinition(options), options.preregistrationSha256);

  if (interrupted) {
    await appendProgress(options, 'run_interrupted', null, { cause: 'OPERATOR_INTERRUPTION' });
  } else {
    await appendProgress(options, 'run_finished', null, { status: 'COMPLETE' });
  }
  return result;
}

export async function runV11Benchmark(options) {
  const configuredClose = isPlainObject(options) && typeof options.closeResources === 'function'
    ? options.closeResources
    : null;
  let closePromise = null;
  const closeResources = () => {
    if (closePromise === null) {
      closePromise = configuredClose === null
        ? Promise.resolve()
        : Promise.resolve().then(() => configuredClose());
    }
    return closePromise;
  };
  let result;
  let primaryError = null;
  try {
    validateOptions(options);
    result = await executeV11Benchmark(options, closeResources);
  } catch (error) {
    primaryError = error;
  }

  let closeError = null;
  try {
    await closeResources();
  } catch (error) {
    closeError = error;
  }
  if (primaryError !== null && closeError !== null && primaryError !== closeError) {
    throw new AggregateError(
      [primaryError, closeError],
      `Runner failure (${primaryError.message}) and resource cleanup failure (${closeError.message})`
    );
  }
  if (primaryError !== null) throw primaryError;
  if (closeError !== null) throw closeError;
  return result;
}

export function createV11Runner(dependencies) {
  if (!isPlainObject(dependencies)) throw new Error('runner dependencies must be an object');
  return Object.freeze({
    run: (plan) => runV11Benchmark({ ...plan, ...dependencies })
  });
}

export const defaultRunnerClock = Object.freeze({
  now: () => new Date().toISOString(),
  monotonicNow: () => performance.now()
});
