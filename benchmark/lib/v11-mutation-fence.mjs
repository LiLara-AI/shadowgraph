// Durable mutation fencing for v1.1.
//
// A native persist or reset can commit in an external store before the harness
// learns what happened: the process is killed on timeout, the container dies,
// the response is malformed, or cleanup fails after the write landed. In every
// one of those cases the harness knows only that it did not receive a
// confirmation, which is not the same as knowing the mutation did not happen.
//
// The Node adapter host already fences this with an on-disk poison latch. The
// Python path had no equivalent, and the runner cannot supply one: from the
// runner's side a killed adapter is indistinguishable from an adapter that
// committed and then died. So the fence lives at the boundary that performs the
// mutation.
//
// The rule is fail-closed. A latch is written before the mutation is attempted
// and removed only on an explicit confirmed success. Anything else leaves the
// latch in place, and a unit whose mutation state is unresolved is reported
// FAILED with an approved failure cause. No new unit status is introduced:
// MEASURED, FAILED, NOT_MEASURED and EXCLUDED remain the only four, and an
// ambiguous mutation is never MEASURED.

import { createHash } from 'node:crypto';
import { mkdir, open, readFile, readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { ADAPTER_FAILURE_CAUSES } from './v11-contract.mjs';

/** Operations that can change durable state, and so require a fence. */
export const MUTATING_OPERATIONS = Object.freeze(['reset', 'persist']);

/** Resolved mutation states. */
export const MUTATION_STATES = Object.freeze(['CLEAN', 'AMBIGUOUS']);

const LATCH_DIRECTORY = '.mutation-fence';
const LATCH_VERSION = 1;

/**
 * How each failure mode maps to an approved adapter failure cause.
 *
 * Every one of these leaves an attempted mutation unconfirmed, so all of them
 * are fail-closed for a mutating operation.
 */
const FAILURE_CAUSE_BY_MODE = new Map([
  ['timeout', 'TIMEOUT'],
  ['crash', 'INFRASTRUCTURE_FAILURE'],
  ['malformed_output', 'CONTRACT_FAILURE'],
  ['persist_failed', 'OPERATION_FAILED'],
  ['reset_failed', 'OPERATION_FAILED'],
  ['cleanup_failed', 'INFRASTRUCTURE_FAILURE'],
  ['interrupted', 'OPERATOR_INTERRUPTION'],
  ['endpoint_unavailable', 'ENDPOINT_UNAVAILABLE']
]);

/** Failure modes this fence understands. */
export const FAILURE_MODES = Object.freeze([...FAILURE_CAUSE_BY_MODE.keys()]);

export class MutationFenceError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MutationFenceError';
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

const CORRELATION_FIELDS = Object.freeze([
  'runId', 'attemptId', 'armId', 'scenarioId', 'repetition', 'phase'
]);

function validateCorrelation(correlation) {
  if (!isPlainObject(correlation)) {
    throw new MutationFenceError('mutation correlation must be an object');
  }
  for (const field of CORRELATION_FIELDS) {
    if (field === 'repetition') {
      if (!Number.isSafeInteger(correlation.repetition) || correlation.repetition < 0) {
        throw new MutationFenceError('mutation correlation.repetition must be a non-negative safe integer');
      }
      continue;
    }
    if (typeof correlation[field] !== 'string' || correlation[field].length === 0) {
      throw new MutationFenceError(`mutation correlation.${field} must be a non-empty string`);
    }
  }
}

/** Bounded, opaque latch filename, so no caller-supplied id reaches the filesystem. */
function latchName(correlation, operation) {
  const digest = createHash('sha256')
    .update('shadowgraph:v1.1:mutation-fence:v1', 'utf8')
    .update('\0', 'utf8')
    .update(JSON.stringify({
      armId: correlation.armId,
      attemptId: correlation.attemptId,
      operation,
      phase: correlation.phase,
      repetition: correlation.repetition,
      runId: correlation.runId,
      scenarioId: correlation.scenarioId
    }), 'utf8')
    .digest('hex');
  return `${digest}.latch`;
}

async function syncDirectory(directory) {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Arm a fence before attempting a mutation.
 *
 * The latch is written and fsynced, and its directory is fsynced too, before
 * the caller touches the native store. If the process dies immediately after
 * this returns, the latch is already durable and the unit is correctly
 * reported as unresolved rather than clean.
 */
export async function armMutationFence({ stateRoot, correlation, operation }) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    throw new MutationFenceError('stateRoot must be an absolute path');
  }
  validateCorrelation(correlation);
  if (!MUTATING_OPERATIONS.includes(operation)) {
    throw new MutationFenceError(`operation ${operation} does not mutate durable state`);
  }

  const directory = path.join(stateRoot, LATCH_DIRECTORY);
  await mkdir(directory, { recursive: true });
  const latchPath = path.join(directory, latchName(correlation, operation));
  const record = JSON.stringify({
    version: LATCH_VERSION,
    operation,
    ...Object.fromEntries(CORRELATION_FIELDS.map((field) => [field, correlation[field]]))
  });

  const handle = await open(latchPath, 'w');
  try {
    await handle.writeFile(`${record}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await syncDirectory(directory);

  let settled = false;
  return Object.freeze({
    path: latchPath,
    /** Clear the latch. Only ever called after a confirmed, well-formed success. */
    async confirm() {
      if (settled) throw new MutationFenceError('mutation fence was already settled');
      settled = true;
      await rm(latchPath, { force: true });
      await syncDirectory(directory);
    },
    /** Leave the latch in place: the mutation state is unresolved. */
    async abandon() {
      if (settled) throw new MutationFenceError('mutation fence was already settled');
      settled = true;
    }
  });
}

/** Latches still present under a state root, i.e. mutations never confirmed. */
export async function pendingMutationLatches(stateRoot) {
  if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)) {
    throw new MutationFenceError('stateRoot must be an absolute path');
  }
  const directory = path.join(stateRoot, LATCH_DIRECTORY);
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const latches = [];
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.latch')) continue;
    let parsed;
    try {
      parsed = JSON.parse(await readFile(path.join(directory, entry), 'utf8'));
    } catch {
      // An unreadable latch is still a latch: it cannot be treated as absence.
      latches.push({ file: entry, readable: false });
      continue;
    }
    latches.push({ file: entry, readable: true, ...parsed });
  }
  return latches;
}

/**
 * Resolve a unit outcome, failing closed on any unconfirmed mutation.
 *
 * `latchPresent` is the observed durable state after the attempt, not a guess:
 * the caller reads it back rather than inferring it from the error.
 */
export function resolveMutationOutcome(input) {
  if (!isPlainObject(input)) throw new MutationFenceError('outcome input must be an object');
  const { operation, succeeded, failureMode = null, latchPresent } = input;
  if (typeof succeeded !== 'boolean') {
    throw new MutationFenceError('succeeded must be a boolean');
  }
  if (typeof latchPresent !== 'boolean') {
    throw new MutationFenceError('latchPresent must be a boolean');
  }
  if (failureMode !== null && !FAILURE_CAUSE_BY_MODE.has(failureMode)) {
    throw new MutationFenceError(`unknown failure mode: ${failureMode}`);
  }
  if (!succeeded && failureMode === null) {
    throw new MutationFenceError('a failed attempt must declare its failure mode');
  }

  const mutating = MUTATING_OPERATIONS.includes(operation);

  // A latch that survived is decisive regardless of what the attempt reported:
  // the mutation was begun and never confirmed.
  if (latchPresent) {
    return Object.freeze({
      unitStatus: 'FAILED',
      mutationState: 'AMBIGUOUS',
      failureCause: failureMode === null
        ? 'CONTRACT_FAILURE'
        : FAILURE_CAUSE_BY_MODE.get(failureMode),
      retryable: false
    });
  }

  if (succeeded) {
    return Object.freeze({
      unitStatus: 'MEASURED',
      mutationState: 'CLEAN',
      failureCause: null,
      retryable: false
    });
  }

  // A failure with no surviving latch: durable state is known to be untouched
  // for a mutating operation, and was never at risk for a read.
  return Object.freeze({
    unitStatus: 'FAILED',
    mutationState: 'CLEAN',
    failureCause: FAILURE_CAUSE_BY_MODE.get(failureMode),
    retryable: !mutating
  });
}

/** Every failure cause this module can emit is one the contract already approves. */
export function approvedFailureCauses() {
  return Object.freeze([...new Set(FAILURE_CAUSE_BY_MODE.values())]
    .filter((cause) => ADAPTER_FAILURE_CAUSES.includes(cause))
    .sort());
}
