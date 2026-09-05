import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createProgressLedger, createUnitEvidenceLedger } from '../benchmark/lib/progress.mjs';
import { createV11RunResources } from '../benchmark/lib/v11-run-resources.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

/**
 * The real ledgers, not doubles.
 *
 * The defect this module exists to close was invisible to a fake: the fake
 * progress recorder had no close() and accepted appends forever, so a test
 * could assert the exact teardown ordering that made every real run die on its
 * last line. Every assertion here goes through `createProgressLedger`, whose
 * append rejects once closed.
 */

const RUN_ID = 'run-v11-resources-1';
const ATTEMPT_ID = 'attempt-v11-resources-1';

function runEvent(event) {
  return { event, armId: null, scenarioId: null, repetition: null, phase: null, evidence: {} };
}

function meterDouble(record) {
  return {
    close: async () => {
      record.push('meter');
    }
  };
}

async function realLedgers(t, record) {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-resources-');
  const progressPath = path.join(directory, 'progress.ndjson');
  const progress = await createProgressLedger({
    path: progressPath,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    monotonicNow: () => record.length,
    unitTimeoutMs: 120_000,
    sensitiveValues: []
  });
  const unitEvidence = await createUnitEvidenceLedger({
    path: path.join(directory, 'units.ndjson'),
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    sensitiveValues: []
  });
  return { progressPath, progress, unitEvidence };
}

test('closing the measurement leaves the run its own ledger to write the terminal event to', async (t) => {
  const closed = [];
  const { progressPath, progress, unitEvidence } = await realLedgers(t, closed);
  const resources = createV11RunResources({ meter: meterDouble(closed), progress, unitEvidence });

  await progress.append(runEvent('run_started'));
  // This is the runner's hook, at the runner's moment: after the plan loop and
  // before the terminal event.
  await resources.closeMeasurement();
  assert.deepEqual(closed, ['meter']);

  // The property. A closed progress ledger rejects here, and the run would end
  // with no terminal record and no artifact.
  await progress.append(runEvent('run_finished'));

  await resources.close();
  const records = (await readFile(progressPath, 'utf8')).trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(records.map((each) => each.event), ['run_started', 'run_finished']);
});

test('the full close shuts the run ledgers, and the measurement close stays closed', async (t) => {
  const closed = [];
  const { progress, unitEvidence } = await realLedgers(t, closed);
  const resources = createV11RunResources({ meter: meterDouble(closed), progress, unitEvidence });

  await progress.append(runEvent('run_started'));
  await resources.close();

  await assert.rejects(progress.append(runEvent('run_finished')), /Progress ledger is closed/u);
  assert.deepEqual(closed, ['meter']);
});

test('every close is memoized, not only the meter', async (t) => {
  // Counting the meter alone left `close` free to be de-memoised: the ledgers
  // it shuts are idempotent enough not to complain, so nothing observed the
  // second call. All three are recorded here.
  const closed = [];
  const resources = createV11RunResources({
    meter: { close: async () => closed.push('meter') },
    progress: { close: async () => closed.push('progress') },
    unitEvidence: { append: () => {}, close: async () => closed.push('unitEvidence') }
  });

  await Promise.all([resources.closeMeasurement(), resources.closeMeasurement()]);
  assert.deepEqual(closed, ['meter']);

  await Promise.all([resources.close(), resources.close()]);
  await resources.close();
  await resources.closeMeasurement();

  assert.deepEqual(
    closed,
    ['meter', 'progress', 'unitEvidence'],
    'closing twice must be closing once, for each of the three'
  );
});

test('the runner is given the measurement close, and this module is what pairs them', async (t) => {
  // F4 was the *caller* pairing these wrongly, on a line no test executes:
  // handing the runner the full teardown closed the progress ledger the
  // terminal event still had to be written to. Splitting the closes here did
  // not fix that by itself - putting `close` back at the call site reproduced
  // the whole defect with the suite green - so the pairing is made here.
  const closed = [];
  const { progress, unitEvidence } = await realLedgers(t, closed);
  const resources = createV11RunResources({ meter: meterDouble(closed), progress, unitEvidence });

  assert.deepEqual(Object.keys(resources.runnerResources), [
    'progress',
    'persistUnit',
    'closeResources'
  ]);
  assert.equal(resources.runnerResources.progress, progress);
  assert.equal(resources.runnerResources.closeResources, resources.closeMeasurement);
  assert.notEqual(resources.runnerResources.closeResources, resources.close);

  // And it survives the hook being called: the ledger is still writable.
  await resources.runnerResources.closeResources();
  await progress.append(runEvent('run_started'));
  await resources.close();
});

test('a resource that fails to close is reported as itself', async (t) => {
  const closed = [];
  const { progress, unitEvidence } = await realLedgers(t, closed);
  const failure = new Error('meter socket refused to close');
  const resources = createV11RunResources({
    meter: {
      close: async () => {
        throw failure;
      }
    },
    progress,
    unitEvidence
  });

  await assert.rejects(resources.closeMeasurement(), (error) => error === failure);
  // The memoized rejection is the same object, so a caller that already carries
  // it can recognise it rather than reporting it twice.
  await assert.rejects(resources.close(), (error) => error === failure);
});

test('two resources that fail to close are reported together', async (t) => {
  const closed = [];
  const { progress, unitEvidence } = await realLedgers(t, closed);
  const meterFailure = new Error('meter socket refused to close');
  const ledgerFailure = new Error('unit evidence fsync failed');
  const resources = createV11RunResources({
    meter: {
      close: async () => {
        throw meterFailure;
      }
    },
    progress,
    unitEvidence: {
      close: async () => {
        throw ledgerFailure;
      }
    }
  });

  await assert.rejects(resources.close(), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.deepEqual(error.errors, [meterFailure, ledgerFailure]);
    return true;
  });
});

test('a resource that is not closable, or the same one passed twice, is refused', async (t) => {
  const closed = [];
  const { progress, unitEvidence } = await realLedgers(t, closed);
  const meter = meterDouble(closed);

  for (const [resources, pattern] of [
    [{ progress, unitEvidence }, /provider meter/u],
    [{ meter, unitEvidence }, /progress ledger/u],
    [{ meter, progress }, /unit evidence ledger/u],
    [{ meter, progress: {}, unitEvidence }, /progress ledger/u],
    [{ meter: null, progress, unitEvidence }, /provider meter/u]
  ]) {
    assert.throws(() => createV11RunResources(resources), pattern);
  }

  // One object serving as two resources would put a ledger the runner still
  // writes to behind the measurement close - this defect arriving through the
  // argument instead of the body.
  assert.throws(
    () => createV11RunResources({ meter, progress, unitEvidence: progress }),
    /three distinct resources/u
  );
  assert.throws(
    () => createV11RunResources({ meter: progress, progress, unitEvidence }),
    /three distinct resources/u
  );
  assert.throws(() => createV11RunResources(null), /provider meter/u);

  await progress.close();
  await unitEvidence.close();
});
