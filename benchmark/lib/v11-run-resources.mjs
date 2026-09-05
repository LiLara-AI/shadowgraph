/**
 * The two closes a bound v1.1 run needs, and why they cannot be one.
 *
 * The runner calls `closeResources()` after the plan loop and *before* it
 * appends the terminal `run_finished` / `run_interrupted` event. That moment
 * exists for one resource only: the provider meter. Closing it there drains the
 * in-flight handlers and the ledger append chain, so the provider ledger is
 * complete at the instant the run declares itself finished, and a request still
 * being recorded afterwards would be traffic the run could not account for.
 *
 * The progress ledger and the unit evidence ledger are the opposite kind of
 * thing: they are the run's own output channels, and the terminal event the
 * runner has not written yet goes into the first of them. Closing them at that
 * moment does not make the record complete - it destroys it. `progress.append`
 * rejects once closed, so a run that executed every unit and validated its own
 * raw record would die on its last line and write no artifact at all.
 *
 * So the split is structural rather than remembered: `closeMeasurement` is
 * built from the meter and can reach nothing else, and `close` - the caller's
 * `finally` - closes all three. Both are memoized, because the two are called
 * on every successful run and closing twice must be closing once.
 *
 * That was not enough on its own, and a review said so: splitting the closes
 * here left the *choice* of which one to hand the runner in the CLI, on a line
 * no test executes, and putting `close` back there reproduced the whole defect
 * with 2336 tests green. So the choice is made here too. `runnerResources` is
 * the three options the runner takes from this module, already paired; a caller
 * that spreads it cannot pair them wrongly, and this module's own tests are
 * what check the pairing.
 */

function assertClosable(value, name) {
  if (value === null || typeof value !== 'object' || typeof value.close !== 'function') {
    throw new Error(`${name} must be a resource with a close()`);
  }
  return value;
}

function memoize(work) {
  let promise = null;
  return () => {
    if (promise === null) promise = Promise.resolve().then(work);
    return promise;
  };
}

/**
 * Bind the run's three resources into the two closes the run path uses.
 *
 * @param {{meter: {close: Function}, progress: {close: Function}, unitEvidence: {close: Function}}} resources
 * @returns {Readonly<{closeMeasurement: () => Promise<void>, close: () => Promise<void>}>}
 */
export function createV11RunResources(resources) {
  const given = resources ?? {};
  const meter = assertClosable(given.meter ?? null, 'the provider meter');
  const progress = assertClosable(given.progress ?? null, 'the progress ledger');
  const unitEvidence = assertClosable(given.unitEvidence ?? null, 'the unit evidence ledger');
  // One object passed twice would mean the measurement close also closes a
  // ledger the runner still writes to - the exact failure this split exists to
  // make unrepresentable, arriving through the argument instead of the body.
  if (meter === progress || meter === unitEvidence || progress === unitEvidence) {
    throw new Error('a v1.1 run needs three distinct resources: provider meter, progress ledger, unit evidence ledger');
  }

  const closeMeasurement = memoize(() => meter.close());

  const close = memoize(async () => {
    const failures = [];
    for (const dispose of [closeMeasurement, () => progress.close(), () => unitEvidence.close()]) {
      try {
        await dispose();
      } catch (error) {
        failures.push(error);
      }
    }
    // A single failure is rethrown as itself. Wrapping it would hide the one
    // thing the operator needs from a teardown error - which resource failed -
    // behind a wrapper that says only that one did.
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) {
      throw new AggregateError(failures, 'a v1.1 run resource failed to close');
    }
  });

  return Object.freeze({
    closeMeasurement,
    close,
    // What the runner is given. `closeResources` is the measurement close and
    // can be nothing else: the ledgers beside it are the ones the runner is
    // still writing to when it calls that hook.
    runnerResources: Object.freeze({
      progress,
      persistUnit: (unit) => unitEvidence.append(unit),
      closeResources: closeMeasurement
    })
  });
}
