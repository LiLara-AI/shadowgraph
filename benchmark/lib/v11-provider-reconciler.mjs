// Provider-evidence reconciliation for v1.1.
//
// The provider meter is a proxy: it forwards traffic and appends one ledger
// event per request. Deciding whether that ledger *agrees* with what the run
// claims to have done is a separate responsibility, and it lives here so the
// proxy stays a proxy.
//
// Reconciliation is exact. A ledger event belongs to one measured unit only if
// every correlation component matches - run, attempt, arm, scenario,
// repetition, phase - plus the request class. Nothing is matched by proximity,
// ordering or best fit, because a benchmark that tolerates approximate
// attribution cannot support a claim about which arm issued which call.
//
// This module performs no I/O and holds no state.

import { reconcileProviderAttempts } from './v11-budget.mjs';

const LEDGER_SCHEMA = 'shadowgraph.provider-meter.event';
const LEDGER_VERSION = 1;
const LEDGER_EVENT = 'provider_request';

const CORRELATION_FIELDS = Object.freeze([
  'runId',
  'attemptId',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'requestClass'
]);

/** Every discrepancy this reconciler can report. */
export const RECONCILIATION_CODES = Object.freeze([
  // Not produced by `reconcileProviderEvidence` - a ledger it cannot read is a
  // ledger it is never handed - but produced by `runProviderReconciliation`
  // above it, and this list is documented as the complete set.
  'LEDGER_UNREADABLE',
  'MALFORMED_EVENT',
  'LEDGER_GAP',
  'DUPLICATE_REQUEST_NUMBER',
  'MISSING_CALL',
  'UNEXPECTED_CALL',
  'RETRY_OBSERVED',
  'MODEL_MISMATCH',
  'FAILED_OUTCOME',
  'INCOMPLETE_USAGE'
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Stable key over the full correlation. Lengths are prefixed so no component can impersonate another. */
function correlationKey(value) {
  return CORRELATION_FIELDS
    .map((field) => {
      const component = String(value[field]);
      return `${component.length}:${component}`;
    })
    .join('|');
}

function readableCorrelation(value) {
  const correlation = {};
  for (const field of CORRELATION_FIELDS) correlation[field] = value[field];
  return correlation;
}

/**
 * Parse a provider-meter ledger.
 *
 * Malformed lines are collected rather than thrown on: a truncated or corrupt
 * ledger is itself evidence about the run, and discarding it would turn
 * incomplete evidence into apparent agreement.
 */
export function parseProviderLedger(text) {
  if (typeof text !== 'string') throw new Error('provider ledger must be a string');
  const events = [];
  const malformed = [];
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    const lineNumber = index + 1;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed.push({ lineNumber, reason: 'not valid JSON' });
      continue;
    }
    if (!isPlainObject(parsed)
      || parsed.schema !== LEDGER_SCHEMA
      || parsed.version !== LEDGER_VERSION
      || parsed.event !== LEDGER_EVENT) {
      malformed.push({ lineNumber, reason: 'not a provider-meter request event' });
      continue;
    }
    if (!Number.isSafeInteger(parsed.requestNumber) || parsed.requestNumber < 0) {
      malformed.push({ lineNumber, reason: 'requestNumber is not a non-negative integer' });
      continue;
    }
    const correlationInvalid = CORRELATION_FIELDS.some((field) => (
      field === 'repetition'
        ? !Number.isSafeInteger(parsed.repetition) || parsed.repetition < 0
        : !isNonEmptyString(parsed[field])
    ));
    if (correlationInvalid) {
      malformed.push({ lineNumber, reason: 'correlation is incomplete' });
      continue;
    }
    events.push({ ...parsed, lineNumber });
  }
  return { events, malformed };
}

function expectationKey(expectation) {
  return correlationKey(expectation);
}

function validateExpectation(expectation, index) {
  if (!isPlainObject(expectation)) {
    throw new Error(`expectation[${index}] must be an object`);
  }
  for (const field of CORRELATION_FIELDS) {
    if (field === 'repetition') {
      if (!Number.isSafeInteger(expectation.repetition) || expectation.repetition < 0) {
        throw new Error(`expectation[${index}].repetition must be a non-negative safe integer`);
      }
      continue;
    }
    if (!isNonEmptyString(expectation[field])) {
      throw new Error(`expectation[${index}].${field} must be a non-empty string`);
    }
  }
  if (!Number.isSafeInteger(expectation.expectedCalls) || expectation.expectedCalls < 0) {
    throw new Error(`expectation[${index}].expectedCalls must be a non-negative safe integer`);
  }
}

/**
 * Reconcile observed provider traffic against what the run declared it would do.
 *
 * `expectations` is one entry per (correlation, requestClass) with the number of
 * calls that correlation should have produced. The report never contains request
 * or response bodies - only correlations, counts and model identifiers - so it
 * is safe to retain as evidence.
 */
export function reconcileProviderEvidence(input) {
  if (!isPlainObject(input)) throw new Error('reconciliation input must be an object');
  const {
    events,
    malformed = [],
    expectations,
    expectedModels = null,
    // Correlations whose *counts* the run record cannot vouch for. Everything
    // else about their traffic still is: the model it named, the outcome it
    // reported, the usage it returned, and its place in the ledger's numbering.
    //
    // The first attempt at this removed those events from `events` entirely,
    // which was wrong three ways at once: it left a hole in the request
    // numbering so LEDGER_GAP fired on the very run it meant to stop failing;
    // it skipped MODEL_MISMATCH, FAILED_OUTCOME and INCOMPLETE_USAGE, none of
    // which read a count; and it therefore let an arm reach an unpinned model
    // and crash, and reported RECONCILED.
    unverifiedCounts = []
  } = input;
  if (!Array.isArray(events)) throw new Error('events must be an array');
  if (!Array.isArray(expectations)) throw new Error('expectations must be an array');
  expectations.forEach(validateExpectation);
  if (!Array.isArray(unverifiedCounts)) throw new Error('unverifiedCounts must be an array');
  const unverified = new Set(unverifiedCounts.map((correlation) => {
    if (!isPlainObject(correlation)) throw new Error('every unverified count must name a correlation');
    return correlationPrefix(correlation);
  }));

  const findings = [];

  for (const entry of malformed) {
    findings.push({
      code: 'MALFORMED_EVENT',
      lineNumber: entry.lineNumber,
      detail: entry.reason
    });
  }

  // Ledger continuity: the meter numbers requests consecutively, so a gap means
  // evidence is missing even when every expected call appears to be present.
  const numbers = events.map((event) => event.requestNumber).sort((left, right) => left - right);
  const seenNumbers = new Set();
  for (const number of numbers) {
    if (seenNumbers.has(number)) {
      findings.push({ code: 'DUPLICATE_REQUEST_NUMBER', requestNumber: number });
    }
    seenNumbers.add(number);
  }
  for (let index = 1; index < numbers.length; index += 1) {
    const previous = numbers[index - 1];
    const current = numbers[index];
    if (current !== previous && current !== previous + 1) {
      findings.push({ code: 'LEDGER_GAP', after: previous, before: current });
    }
  }

  const observed = new Map();
  for (const event of events) {
    const key = correlationKey(event);
    if (!observed.has(key)) observed.set(key, []);
    observed.get(key).push(event);
  }

  const expectedKeys = new Set();
  let unverifiedObserved = 0;
  for (const expectation of expectations) {
    const key = expectationKey(expectation);
    expectedKeys.add(key);
    const matched = observed.get(key) ?? [];
    const correlation = readableCorrelation(expectation);
    const countsAreVerifiable = !unverified.has(correlationPrefix(expectation));

    if (!countsAreVerifiable) {
      // No count comparison, and no UNEXPECTED_CALL either: the events are
      // matched to this correlation, so they are accounted for. Every per-event
      // check below still runs on them.
      unverifiedObserved += matched.length;
    } else if (matched.length < expectation.expectedCalls) {
      findings.push({
        code: 'MISSING_CALL',
        correlation,
        expected: expectation.expectedCalls,
        observed: matched.length
      });
    } else if (matched.length > expectation.expectedCalls) {
      // Extra calls on a correlation that was expected to make some are
      // retries; a correlation expected to make none is an unexpected call.
      findings.push({
        code: expectation.expectedCalls === 0 ? 'UNEXPECTED_CALL' : 'RETRY_OBSERVED',
        correlation,
        expected: expectation.expectedCalls,
        observed: matched.length
      });
    }

    for (const event of matched) {
      if (event.outcome !== 'SUCCEEDED') {
        findings.push({
          code: 'FAILED_OUTCOME',
          correlation,
          requestNumber: event.requestNumber,
          outcome: event.outcome ?? null,
          httpStatus: event.httpStatus ?? null
        });
      }
      if (!isPlainObject(event.usage)) {
        findings.push({
          code: 'INCOMPLETE_USAGE',
          correlation,
          requestNumber: event.requestNumber
        });
      }
      const requested = event.requestedModel ?? null;
      const provided = event.providerModel ?? null;
      const declared = expectedModels === null
        ? null
        : expectedModels[event.requestClass] ?? null;
      const mismatched = (requested !== null && provided !== null && requested !== provided)
        || (declared !== null && requested !== null && requested !== declared);
      if (mismatched) {
        findings.push({
          code: 'MODEL_MISMATCH',
          correlation,
          requestNumber: event.requestNumber,
          requestedModel: requested,
          providerModel: provided,
          declaredModel: declared
        });
      }
    }
  }

  // Traffic on a correlation nobody declared: the run cannot account for it.
  for (const [key, matched] of observed) {
    if (expectedKeys.has(key)) continue;
    findings.push({
      code: 'UNEXPECTED_CALL',
      correlation: readableCorrelation(matched[0]),
      expected: 0,
      observed: matched.length
    });
  }

  const expectedCalls = expectations.reduce((total, entry) => (
    unverified.has(correlationPrefix(entry)) ? total : total + entry.expectedCalls
  ), 0);
  const matchedCalls = expectations.reduce((total, entry) => {
    if (unverified.has(correlationPrefix(entry))) return total;
    const matched = observed.get(expectationKey(entry)) ?? [];
    return total + Math.min(matched.length, entry.expectedCalls);
  }, 0);

  findings.sort((left, right) => (
    RECONCILIATION_CODES.indexOf(left.code) - RECONCILIATION_CODES.indexOf(right.code)
  ));

  return Object.freeze({
    status: findings.length === 0 ? 'RECONCILED' : 'DISCREPANT',
    totals: Object.freeze({
      expectedCalls,
      observedEvents: events.length,
      matchedCalls,
      malformedLines: malformed.length,
      // Traffic this run could not hold its own record's counts to. Named and
      // counted rather than removed - every other check still applied to it.
      // The set is keyed by unit, since a correlation's request class is not part
      // of what makes its counts unverifiable.
      unverifiedCountUnits: unverified.size,
      unverifiedCountEvents: unverifiedObserved
    }),
    findings: Object.freeze(findings)
  });
}

// The operation metric that states, for one unit, how many calls of a given
// request class the run says it made. Every class the meter can mint is here:
// a class the run could produce and this table omitted would be traffic no
// expectation covers, which the reconciler would then report as unexpected
// rather than as unmeasured.
const OPERATION_FIELD_BY_REQUEST_CLASS = Object.freeze({
  outer_decision_llm: 'outerDecisionModelCalls',
  internal_memory_llm: 'internalMemoryModelCalls',
  embedding: 'embeddingCalls'
});

/**
 * The provider traffic a finished run says it produced, as expectations.
 *
 * The run record is the claim and the ledger is the observation, and until
 * this existed the two were never brought together: the meter wrote a ledger
 * for every acceptance run and nothing read it back, so `RETRY_OBSERVED`,
 * `MODEL_MISMATCH` and `UNEXPECTED_CALL` were codes no run could emit.
 *
 * One expectation per (unit, request class), including the classes a unit
 * reports as zero. An unmatched event is reported whether or not an
 * expectation names its correlation, so the zero is not what makes a stray
 * call visible - what it adds is the run's own statement that this arm meters
 * nothing, carried in `totals.expectedCalls` and checked rather than assumed.
 *
 * Only this attempt's units, because the ledger is opened per attempt: a
 * resumed run carries units from earlier attempts whose provider traffic is in
 * an earlier ledger, and expecting them here would report every one of them
 * missing.
 *
 * Every unit of the attempt gets expectations, including the ones that failed.
 * What a FAILED unit does not get is a *count* the reconciler will hold it to,
 * and it is returned in `unverifiedCounts` for that: a host-synthesised failure
 * envelope zeroes the operation metrics, and an abort observed between the
 * adapter returning and the counts being added discards them, while the calls
 * the container had already made are in the ledger either way. Holding those
 * correlations to zero would report `UNEXPECTED_CALL` and `RETRY_OBSERVED` on
 * every run containing one adapter failure.
 *
 * Only the count. Everything else about that traffic is still checked - the
 * model it named, the outcome it reported, the usage it returned, its place in
 * the ledger's numbering - because none of those read a count. An earlier
 * version of this dropped the events instead and let an arm reach an unpinned
 * model and crash while the run reported `RECONCILED`.
 *
 * And only FAILED. `EXCLUDED` and `NOT_MEASURED` units are not units the
 * harness failed to observe: `validateRawRun` *forbids* them from recording any
 * operation at all, so their zero is structural and the record does know the
 * answer. Excusing them excused the 20 excluded units every acceptance plan
 * schedules - a fifteenth of the run, on correlations an arm can still reach a
 * model from.
 */
/** A unit's correlation, without the request class: one key per unit. */
function correlationPrefix(value) {
  return CORRELATION_FIELDS
    .filter((field) => field !== 'requestClass')
    .map((field) => String(value[field]))
    .join(String.fromCharCode(31));
}

export function providerExpectationsFromRun(raw, attemptId) {
  if (!isPlainObject(raw) || !Array.isArray(raw.units)) {
    throw new Error('provider expectations require a raw run record with units');
  }
  if (!isNonEmptyString(attemptId)) {
    throw new Error('provider expectations require the attempt whose ledger is being read');
  }
  const expectations = [];
  const unverifiedCounts = [];
  for (const unit of raw.units) {
    if (!isPlainObject(unit)) throw new Error('every unit must be an object');
    if (unit.attemptId !== attemptId) continue;
    const correlation = {
      runId: unit.runId,
      attemptId: unit.attemptId,
      armId: unit.armId,
      scenarioId: unit.scenarioId,
      repetition: unit.repetition,
      phase: unit.phase
    };
    if (unit.status === 'FAILED') {
      unverifiedCounts.push({ unitId: unit.unitId, status: unit.status, ...correlation });
    }
    if (!isPlainObject(unit.operations)) {
      throw new Error(`unit ${String(unit.unitId)} records no operation metrics`);
    }
    for (const requestClass of Object.keys(OPERATION_FIELD_BY_REQUEST_CLASS)) {
      const field = OPERATION_FIELD_BY_REQUEST_CLASS[requestClass];
      const expectedCalls = unit.operations[field];
      if (!Number.isSafeInteger(expectedCalls) || expectedCalls < 0) {
        throw new Error(`unit ${String(unit.unitId)} records no ${field}`);
      }
      expectations.push({ ...correlation, requestClass, expectedCalls });
    }
  }
  return { expectations, unverifiedCounts };
}

/**
 * The reconciliation a finished run writes beside its record.
 *
 * Pure: the caller reads the ledger and passes its text, or `null` when it
 * could not be read. That is deliberate - the interesting decision here is what
 * an *absent* ledger means, and a function that did its own I/O would leave
 * that decision in a `catch` block nothing could test. A missing ledger is a
 * discrepancy rather than an absence: the meter opens the file when the run
 * binds, so a run that produced a record and no ledger has lost its evidence,
 * and reporting that as `RECONCILED` would be the strongest overstatement this
 * comparison is capable of.
 */
export function runProviderReconciliation(input) {
  const { ledgerText = null, ledgerPath, raw, attemptId, pinnedModels } = input ?? {};
  if (!isNonEmptyString(ledgerPath)) {
    throw new Error('a run reconciliation must name the ledger it read');
  }
  // The *ids*, not merely the descriptors. A descriptor present and nameless
  // passed the earlier check, made every entry of `expectedModels` undefined,
  // and `expectedModels[requestClass] ?? null` then turned the whole model
  // comparison off - a ledger recording an unpinned model reconciled clean.
  const named = (descriptor) => isPlainObject(descriptor) && isNonEmptyString(descriptor.modelId);
  if (!isPlainObject(pinnedModels)
    || !named(pinnedModels.internal_memory_llm)
    || !named(pinnedModels.embedding)) {
    throw new Error('a run reconciliation requires the pinned model ids the run was bound to');
  }
  const envelope = (status, totals, findings) => Object.freeze({
    schema: 'shadowgraph.v11.provider-reconciliation',
    version: 1,
    attemptId,
    ledgerPath,
    status,
    totals,
    findings: Object.freeze(findings)
  });

  if (ledgerText === null) {
    return envelope('UNAVAILABLE', null, [{
      code: 'LEDGER_UNREADABLE',
      detail: 'the provider ledger this run wrote could not be read'
    }]);
  }
  if (typeof ledgerText !== 'string') {
    throw new Error('a run reconciliation reads ledger text or nothing at all');
  }

  const { events, malformed } = parseProviderLedger(ledgerText);
  const { expectations, unverifiedCounts } = providerExpectationsFromRun(raw, attemptId);
  const report = reconcileProviderEvidence({
    events,
    malformed,
    expectations,
    unverifiedCounts,
    expectedModels: {
      // The outer decision and an arm's own internal calls are the same pinned
      // chat model: the lock states it once and both routes use it.
      outer_decision_llm: pinnedModels.internal_memory_llm.modelId,
      internal_memory_llm: pinnedModels.internal_memory_llm.modelId,
      embedding: pinnedModels.embedding.modelId
    }
  });
  if (input.providerBudget !== undefined) {
    const budgetEvidence = reconcileProviderAttempts({
      text: input.attemptLedgerText, events, expectedBudget: input.providerBudget
    });
    return Object.freeze({ ...envelope(
      budgetEvidence.status === 'RECONCILED' ? report.status : 'DISCREPANT', report.totals, report.findings
    ), budgetEvidence });
  }
  return envelope(report.status, report.totals, report.findings);
}
