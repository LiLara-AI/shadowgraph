import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { ADAPTER_FAILURE_CAUSES, UNIT_STATUSES } from '../benchmark/lib/v11-contract.mjs';
import {
  FAILURE_MODES,
  MUTATING_OPERATIONS,
  MutationFenceError,
  approvedFailureCauses,
  armMutationFence,
  pendingMutationLatches,
  resolveMutationOutcome
} from '../benchmark/lib/v11-mutation-fence.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const CORRELATION = {
  runId: 'run-1',
  attemptId: 'attempt-1',
  armId: 'mem0-oss',
  scenarioId: 'ACC_ONE',
  repetition: 0,
  phase: 'B'
};

const DIRECTORY_FSYNC_OPTIONS = {
  skip: process.platform === 'win32'
    ? 'Windows cannot provide the directory fsync durability this fence requires'
    : false
};

async function stateRoot(t) {
  const root = await scratchDirectory(t, 'sg-fence-');
  return root;
}

test('a latch is durable before the mutation is attempted', DIRECTORY_FSYNC_OPTIONS, async (t) => {
  const root = await stateRoot(t);
  const fence = await armMutationFence({
    stateRoot: root, correlation: CORRELATION, operation: 'persist'
  });

  // The latch exists the moment arming returns, so a process killed on the very
  // next instruction still leaves the unit correctly unresolved.
  const pending = await pendingMutationLatches(root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].operation, 'persist');
  assert.equal(pending[0].armId, 'mem0-oss');

  await fence.confirm();
  assert.deepEqual(await pendingMutationLatches(root), []);
});

test('only an explicit confirmation clears the latch', DIRECTORY_FSYNC_OPTIONS, async (t) => {
  const root = await stateRoot(t);
  const fence = await armMutationFence({
    stateRoot: root, correlation: CORRELATION, operation: 'reset'
  });

  await fence.abandon();
  const pending = await pendingMutationLatches(root);
  assert.equal(pending.length, 1, 'abandoning must leave the latch in place');

  // A fence settles once; a second settlement would let a late success erase
  // evidence of an earlier unresolved mutation.
  await assert.rejects(() => fence.confirm(), MutationFenceError);
});

test('a surviving latch forces FAILED and AMBIGUOUS whatever the attempt claimed', () => {
  // Even a reported success cannot clear a latch that is still on disk: the
  // durable state, not the report, decides.
  const claimed = resolveMutationOutcome({
    operation: 'persist', succeeded: true, latchPresent: true
  });
  assert.equal(claimed.unitStatus, 'FAILED');
  assert.equal(claimed.mutationState, 'AMBIGUOUS');
  assert.equal(claimed.unitStatus === 'MEASURED', false);
});

test('every failure mode fails closed for a mutating operation', () => {
  for (const failureMode of FAILURE_MODES) {
    const resolved = resolveMutationOutcome({
      operation: 'persist',
      succeeded: false,
      failureMode,
      latchPresent: true
    });
    assert.equal(resolved.unitStatus, 'FAILED', failureMode);
    assert.equal(resolved.mutationState, 'AMBIGUOUS', failureMode);
    assert.ok(ADAPTER_FAILURE_CAUSES.includes(resolved.failureCause), failureMode);
    assert.equal(resolved.retryable, false, failureMode);
  }

  // The specific modes the goal names, mapped to approved causes.
  const mapping = {
    timeout: 'TIMEOUT',
    crash: 'INFRASTRUCTURE_FAILURE',
    malformed_output: 'CONTRACT_FAILURE',
    persist_failed: 'OPERATION_FAILED',
    reset_failed: 'OPERATION_FAILED',
    cleanup_failed: 'INFRASTRUCTURE_FAILURE'
  };
  for (const [failureMode, cause] of Object.entries(mapping)) {
    const resolved = resolveMutationOutcome({
      operation: 'reset', succeeded: false, failureMode, latchPresent: true
    });
    assert.equal(resolved.failureCause, cause, failureMode);
  }
});

test('a clean failure is distinguished from an ambiguous one', () => {
  // No surviving latch means the mutation never began. That is still a failed
  // unit, but durable state is known rather than unresolved.
  const clean = resolveMutationOutcome({
    operation: 'persist', succeeded: false, failureMode: 'endpoint_unavailable', latchPresent: false
  });
  assert.equal(clean.unitStatus, 'FAILED');
  assert.equal(clean.mutationState, 'CLEAN');
  assert.equal(clean.failureCause, 'ENDPOINT_UNAVAILABLE');

  // A read cannot leave durable state unresolved, so it stays retryable.
  const read = resolveMutationOutcome({
    operation: 'retrieve', succeeded: false, failureMode: 'timeout', latchPresent: false
  });
  assert.equal(read.mutationState, 'CLEAN');
  assert.equal(read.retryable, true);

  // A mutating operation is never retried even when it failed cleanly.
  const mutating = resolveMutationOutcome({
    operation: 'persist', succeeded: false, failureMode: 'timeout', latchPresent: false
  });
  assert.equal(mutating.retryable, false);
});

test('a confirmed success on untouched state is the only path to MEASURED', () => {
  const measured = resolveMutationOutcome({
    operation: 'persist', succeeded: true, latchPresent: false
  });
  assert.equal(measured.unitStatus, 'MEASURED');
  assert.equal(measured.mutationState, 'CLEAN');
  assert.equal(measured.failureCause, null);
});

test('resume sees latches left by a previous attempt', DIRECTORY_FSYNC_OPTIONS, async (t) => {
  const root = await stateRoot(t);
  // A previous attempt armed a fence and never returned.
  await armMutationFence({ stateRoot: root, correlation: CORRELATION, operation: 'persist' });

  // A fresh process starting against the same state root observes it.
  const onResume = await pendingMutationLatches(root);
  assert.equal(onResume.length, 1);
  assert.equal(onResume[0].runId, 'run-1');

  const resolved = resolveMutationOutcome({
    operation: 'persist', succeeded: false, failureMode: 'crash', latchPresent: onResume.length > 0
  });
  assert.equal(resolved.mutationState, 'AMBIGUOUS');
});

test('an unreadable latch counts as present, never as absence', async (t) => {
  const root = await stateRoot(t);
  const directory = path.join(root, '.mutation-fence');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'corrupt.latch'), 'not json', 'utf8');

  const pending = await pendingMutationLatches(root);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].readable, false);
});

test('no state root yields no latches rather than an error', async (t) => {
  const root = await stateRoot(t);
  assert.deepEqual(await pendingMutationLatches(path.join(root, 'never-created')), []);
});

test('the fence introduces no unit status and no failure cause of its own', () => {
  for (const status of ['MEASURED', 'FAILED']) {
    assert.ok(UNIT_STATUSES.includes(status), status);
  }
  assert.equal(UNIT_STATUSES.includes('AMBIGUOUS'), false, 'AMBIGUOUS is not a unit status');
  for (const cause of approvedFailureCauses()) {
    assert.ok(ADAPTER_FAILURE_CAUSES.includes(cause), cause);
  }
  assert.equal(approvedFailureCauses().length, 6);
});

test('latch names are bounded and disclose no caller-supplied identifier', DIRECTORY_FSYNC_OPTIONS, async (t) => {
  const root = await stateRoot(t);
  const hostile = {
    ...CORRELATION,
    armId: 'a'.repeat(300),
    scenarioId: '../../escape'
  };
  const fence = await armMutationFence({
    stateRoot: root, correlation: hostile, operation: 'persist'
  });

  const name = path.basename(fence.path);
  assert.match(name, /^[a-f0-9]{64}\.latch$/u);
  assert.equal(name.includes('escape'), false);
  assert.equal(path.dirname(fence.path), path.join(root, '.mutation-fence'));
  await fence.confirm();
});

test('malformed fence input is refused', async (t) => {
  const root = await stateRoot(t);
  await assert.rejects(
    () => armMutationFence({ stateRoot: 'relative', correlation: CORRELATION, operation: 'persist' }),
    MutationFenceError
  );
  await assert.rejects(
    () => armMutationFence({ stateRoot: root, correlation: {}, operation: 'persist' }),
    MutationFenceError
  );
  // A read operation must not arm a fence: it cannot leave state unresolved.
  await assert.rejects(
    () => armMutationFence({ stateRoot: root, correlation: CORRELATION, operation: 'retrieve' }),
    MutationFenceError
  );
  assert.deepEqual(MUTATING_OPERATIONS, ['reset', 'persist']);

  assert.throws(() => resolveMutationOutcome({
    operation: 'persist', succeeded: false, failureMode: 'invented', latchPresent: false
  }), MutationFenceError);
  assert.throws(() => resolveMutationOutcome({
    operation: 'persist', succeeded: false, latchPresent: false
  }), /must declare its failure mode/u);
});
