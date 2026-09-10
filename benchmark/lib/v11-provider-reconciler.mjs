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
import { traceNativeAttempts } from './v11-native-attempts.mjs';
import { validateCampaignPolicy } from './v11-campaign-budget.mjs';

const LEDGER_SCHEMA = 'shadowgraph.provider-meter.event';
const LEDGER_VERSIONS = new Set([1, 2]);
const LEDGER_EVENT = 'provider_request';
const PLAN_SCHEMA = 'shadowgraph.provider-meter.plan';
const PLAN_VERSION = 1;
const OPAQUE_DISPATCH_ID = /^[a-f0-9]{48}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

const CORRELATION_FIELDS = Object.freeze([
  'runId',
  'attemptId',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'requestClass'
]);
const ROOT_OPERATIONS = new Set(['reset', 'retrieve', 'persist', 'verify', 'outer-decision']);
const CAMPAIGN_RESERVATION_ID = /^[A-Za-z0-9-]+:[1-9]\d*$/;
const SAFE_LINEAGE_ID = /^[A-Za-z0-9._:-]+$/;
const PLAN_DISPOSITIONS = new Set(['root-initial', 'data-dependent-child', 'recovery']);
const DYNAMIC_UNBOUND_DENIAL_CODES = new Set([
  'MISSING_OR_MALFORMED_DISPATCH_ALIAS',
  'UNKNOWN_DISPATCH_ALIAS',
  'INVALID_DISPATCH_ALIAS_BINDING',
  'INVALID_DISPATCH_DECLARATION'
]);
const CAMPAIGN_JOIN_FIELDS = Object.freeze([
  ...CORRELATION_FIELDS,
  'rootOperation', 'rootInvocationId', 'plannedDispatchId', 'planSlot', 'disposition'
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
  'INCOMPLETE_USAGE',
  'UNVERIFIED_OPERATION_COUNT',
  'DISPATCH_PLAN_LEDGER_UNREADABLE',
  'DISPATCH_PLAN_INVALID',
  'DISPATCH_PLAN_MISSING',
  'DISPATCH_PLAN_UNKNOWN_ALIAS',
  'DISPATCH_PLAN_MISMATCH',
  'STATIC_DISPATCH_REPLAY',
  'STATIC_DISPATCH_UNCONSUMED',
  'CAMPAIGN_LEDGER_UNREADABLE',
  'CAMPAIGN_LEDGER_INVALID',
  'CAMPAIGN_RESERVATION_MISSING',
  'CAMPAIGN_RESERVATION_UNKNOWN',
  'CAMPAIGN_RESERVATION_MISMATCH',
  'CAMPAIGN_RESERVATION_REUSED',
  'CAMPAIGN_RESERVATION_ORPHANED',
  'NATIVE_ATTEMPT_TRACE_DISCREPANT'
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
function isNativeCapDenial(event) {
  return event?.version === 2
    && event?.outcome === 'FAILED'
    && event?.failure?.code === 'NATIVE_ATTEMPT_CAP_EXHAUSTED'
    && event?.campaignReservationId === undefined;
}

function correlationKey(value, requireRootOperation = false) {
  const fields = requireRootOperation
    ? [...CORRELATION_FIELDS, 'rootOperation']
    : CORRELATION_FIELDS;
  return fields
    .map((field) => {
      const component = String(value[field]);
      return `${component.length}:${component}`;
    })
    .join('|');
}

function readableCorrelation(value, requireRootOperation = false) {
  const correlation = {};
  for (const field of CORRELATION_FIELDS) correlation[field] = value[field];
  if (requireRootOperation) correlation.rootOperation = value.rootOperation;
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
      || !LEDGER_VERSIONS.has(parsed.version)
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
    if (parsed.version === 2 && (!isNonEmptyString(parsed.rootInvocationId)
      || !OPAQUE_DISPATCH_ID.test(parsed.plannedDispatchId)
      || !OPAQUE_DISPATCH_ID.test(parsed.dispatchAlias)
      || !isNonEmptyString(parsed.planSlot)
      || !isNonEmptyString(parsed.disposition))) {
      malformed.push({ lineNumber, reason: 'dispatch plan identity is incomplete' });
      continue;
    }
    events.push({ ...parsed, lineNumber });
  }
  return { events, malformed };
}

function expectationKey(expectation, requireRootOperation = false) {
  return correlationKey(expectation, requireRootOperation);
}

function validateExpectation(expectation, index, requireRootOperation = false) {
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
  if (requireRootOperation && (!isNonEmptyString(expectation.rootOperation)
    || !ROOT_OPERATIONS.has(expectation.rootOperation))) {
    throw new Error(`expectation[${index}].rootOperation must be a known root operation`);
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
function reconcileProviderEvidenceInternal(input, toleratedTransportFailureRequestNumbers = new Set()) {
  if (!isPlainObject(input)) throw new Error('reconciliation input must be an object');
  if (!(toleratedTransportFailureRequestNumbers instanceof Set)) {
    throw new Error('tolerated transport failures must be an internal set');
  }
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
    unverifiedCounts = [],
    requireRootOperation = false
  } = input;
  if (!Array.isArray(events)) throw new Error('events must be an array');
  if (!Array.isArray(expectations)) throw new Error('expectations must be an array');
  if (typeof requireRootOperation !== 'boolean') {
    throw new Error('requireRootOperation must be boolean');
  }
  expectations.forEach((expectation, index) => validateExpectation(expectation, index, requireRootOperation));
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
    const key = correlationKey(event, requireRootOperation);
    if (!observed.has(key)) observed.set(key, []);
    observed.get(key).push(event);
  }

  const expectedKeys = new Set();
  let unverifiedObserved = 0;
  for (const expectation of expectations) {
    const key = expectationKey(expectation, requireRootOperation);
    expectedKeys.add(key);
    const matched = observed.get(key) ?? [];
    const correlation = readableCorrelation(expectation, requireRootOperation);
    const countsAreVerifiable = !unverified.has(correlationPrefix(expectation));

    if (!countsAreVerifiable) {
      // A failed root operation can lose its adapter operation metrics after the
      // meter has already admitted and recorded a provider request. Preserve
      // the traffic for all per-event checks, but never call that evidence
      // reconciled: Amendment 005 requires every admitted provider attempt to
      // be attributable to a root-operation count.
      unverifiedObserved += matched.length;
      if (matched.length > 0 || expectation.expectedCalls > 0) {
        findings.push({
          code: 'UNVERIFIED_OPERATION_COUNT',
          correlation,
          expected: expectation.expectedCalls,
          observed: matched.length
        });
      }
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
      const toleratedTransportFailure = toleratedTransportFailureRequestNumbers.has(event.requestNumber);
      if (event.outcome !== 'SUCCEEDED' && !toleratedTransportFailure) {
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
      correlation: readableCorrelation(matched[0], requireRootOperation),
      expected: 0,
      observed: matched.length
    });
  }

  const expectedCalls = expectations.reduce((total, entry) => (
    unverified.has(correlationPrefix(entry)) ? total : total + entry.expectedCalls
  ), 0);
  const matchedCalls = expectations.reduce((total, entry) => {
    if (unverified.has(correlationPrefix(entry))) return total;
    const matched = observed.get(expectationKey(entry, requireRootOperation)) ?? [];
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

/** Public reconciliation is strict: only the live trace path can permit B precursors. */
export function reconcileProviderEvidence(input) {
  return reconcileProviderEvidenceInternal(input);
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
 * A FAILED unit can lose host operation metrics after the meter has already
 * admitted traffic. Its counts are labelled `unverifiedCounts` so the
 * reconciler preserves the event rather than inventing a retry or dropping it;
 * any observed traffic or nonzero declared count then produces
 * `UNVERIFIED_OPERATION_COUNT` and blocks reconciliation. A host-synthesised
 * zero envelope is therefore never a route to a reconciled native call.
 *
 * Per-event model/outcome/usage/ledger-number checks still run on every failed
 * unit. `EXCLUDED` and `NOT_MEASURED` units are different: `validateRawRun` *forbids* them from recording any
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

function planCorrelationKey(correlation) {
  return [
    correlation.runId,
    correlation.attemptId,
    correlation.armId,
    correlation.scenarioId,
    String(correlation.repetition),
    correlation.phase,
    correlation.requestClass,
    correlation.rootOperation
  ].map((value) => `${value.length}:${value}`).join('|');
}

function validPlanCorrelation(correlation) {
  return isPlainObject(correlation)
    && CORRELATION_FIELDS.every((field) => (
      field === 'repetition'
        ? Number.isSafeInteger(correlation.repetition) && correlation.repetition >= 0
        : isNonEmptyString(correlation[field])
    ))
    && isNonEmptyString(correlation.rootOperation)
    && ROOT_OPERATIONS.has(correlation.rootOperation);
}

function samePlanCorrelation(left, right) {
  return validPlanCorrelation(left) && validPlanCorrelation(right)
    && [...CORRELATION_FIELDS, 'rootOperation'].every((field) => left[field] === right[field]);
}

function parseDispatchPlanLedger(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) {
    return { findings: ['DISPATCH_PLAN_LEDGER_UNREADABLE'], plans: new Map() };
  }
  const roots = new Map();
  const plans = new Map();
  const dispatchIds = new Set();
  const findings = [];
  for (const line of text.trimEnd().split('\n')) {
    let row;
    try { row = JSON.parse(line); } catch { findings.push('DISPATCH_PLAN_INVALID'); continue; }
    if (!isPlainObject(row) || row.schema !== PLAN_SCHEMA || row.version !== PLAN_VERSION
      || !isNonEmptyString(row.recordedAt) || !Number.isFinite(Date.parse(row.recordedAt))) {
      findings.push('DISPATCH_PLAN_INVALID');
      continue;
    }
    if (row.event === 'root_plan') {
      const expectedChildRule = row.identityMode === 'dynamic'
        ? 'data-dependent-before-send'
        : null;
      if (!isNonEmptyString(row.rootInvocationId) || !isNonEmptyString(row.planSlot)
        || !['dynamic', 'static'].includes(row.identityMode)
        || row.childRule !== expectedChildRule
        || !validPlanCorrelation(row.correlation)) {
        findings.push('DISPATCH_PLAN_INVALID');
        continue;
      }
      const key = `${row.rootInvocationId}|${planCorrelationKey(row.correlation)}|${row.planSlot}`;
      if (roots.has(key)) findings.push('DISPATCH_PLAN_INVALID');
      else roots.set(key, row);
      continue;
    }
    if (row.event === 'dispatch_plan') {
      if (!OPAQUE_DISPATCH_ID.test(row.plannedDispatchId) || !OPAQUE_DISPATCH_ID.test(row.alias)
        || !isNonEmptyString(row.rootInvocationId) || !isNonEmptyString(row.parentRootInvocationId)
        || !isNonEmptyString(row.rootPlanSlot) || !isNonEmptyString(row.planSlot)
        || !['root-initial', 'data-dependent-child', 'recovery'].includes(row.disposition)
        || !(row.recoveryOf === null || OPAQUE_DISPATCH_ID.test(row.recoveryOf))
        || !validPlanCorrelation(row.correlation)) {
        findings.push('DISPATCH_PLAN_INVALID');
        continue;
      }
      const rootKey = `${row.rootInvocationId}|${planCorrelationKey(row.correlation)}|${row.rootPlanSlot}`;
      const root = roots.get(rootKey);
      const dispositionMatchesRoot = root !== undefined && (
        root.identityMode === 'static'
          ? row.disposition === 'root-initial'
          : row.disposition === 'data-dependent-child' || row.disposition === 'recovery'
      );
      if (!root || row.parentRootInvocationId !== root.rootInvocationId
        || row.childRule !== root.childRule || !dispositionMatchesRoot
        || plans.has(row.alias) || dispatchIds.has(row.plannedDispatchId)) {
        findings.push('DISPATCH_PLAN_INVALID');
        continue;
      }
      const plan = { ...row, closed: false };
      plans.set(row.alias, plan);
      dispatchIds.add(row.plannedDispatchId);
      continue;
    }
    if (row.event === 'dispatch_closed' || row.event === 'dispatch_consumed') {
      const plan = plans.get(row.alias);
      const consumedStatic = row.event === 'dispatch_consumed';
      if (!plan || plan.closed || row.plannedDispatchId !== plan.plannedDispatchId
        || row.rootInvocationId !== plan.rootInvocationId || row.planSlot !== plan.planSlot
        || (consumedStatic && plan.disposition !== 'root-initial')
        || (!consumedStatic && plan.disposition === 'root-initial')) {
        findings.push('DISPATCH_PLAN_INVALID');
      } else {
        plan.closed = true;
      }
      continue;
    }
    if (row.event === 'dispatch_denied') {
      const correlationFields = [...CORRELATION_FIELDS, 'rootOperation'];
      const denialFields = [
        'schema', 'version', 'recordedAt', 'event', 'code', 'rootInvocationId', 'rootPlanSlot', 'planSlot',
        'correlation', 'plannedDispatchId', 'alias', 'disposition'
      ];
      const exactCorrelation = isPlainObject(row.correlation)
        && Object.keys(row.correlation).length === correlationFields.length
        && correlationFields.every((field) => Object.hasOwn(row.correlation, field));
      if (Object.keys(row).length !== denialFields.length
        || !denialFields.every((field) => Object.hasOwn(row, field))
        || !isNonEmptyString(row.code) || !isNonEmptyString(row.rootInvocationId)
        || !isNonEmptyString(row.rootPlanSlot) || !exactCorrelation || !validPlanCorrelation(row.correlation)) {
        findings.push('DISPATCH_PLAN_INVALID');
        continue;
      }
      const rootKey = `${row.rootInvocationId}|${planCorrelationKey(row.correlation)}|${row.rootPlanSlot}`;
      const root = roots.get(rootKey);
      const allNull = row.planSlot === null
        && row.plannedDispatchId === null && row.alias === null && row.disposition === null;
      const allBound = isNonEmptyString(row.planSlot)
        && OPAQUE_DISPATCH_ID.test(row.plannedDispatchId)
        && OPAQUE_DISPATCH_ID.test(row.alias) && PLAN_DISPOSITIONS.has(row.disposition);
      if (!root || (!allNull && !allBound)) {
        findings.push('DISPATCH_PLAN_INVALID');
        continue;
      }
      if (allBound) {
        const plan = plans.get(row.alias);
        if (!plan || row.plannedDispatchId !== plan.plannedDispatchId
          || row.rootInvocationId !== plan.rootInvocationId || row.rootPlanSlot !== plan.rootPlanSlot
          || row.planSlot !== plan.planSlot
          || row.disposition !== plan.disposition || !samePlanCorrelation(row.correlation, plan.correlation)) {
          findings.push('DISPATCH_PLAN_INVALID');
        }
      } else if (root.identityMode === 'static' || !DYNAMIC_UNBOUND_DENIAL_CODES.has(row.code)) {
        findings.push('DISPATCH_PLAN_INVALID');
      }
      continue;
    }
    findings.push('DISPATCH_PLAN_INVALID');
  }
  for (const plan of plans.values()) {
    if (plan.disposition === 'data-dependent-child' && !plan.closed) {
      findings.push('DISPATCH_PLAN_INVALID');
    }
  }
  return { findings: [...new Set(findings)], plans };
}

function reconcileDispatchPlans(events, text) {
  const parsed = parseDispatchPlanLedger(text);
  const findings = [...parsed.findings];
  const consumedStaticAliases = new Set();
  for (const event of events) {
    if (event.version !== 2) {
      findings.push('DISPATCH_PLAN_MISSING');
      continue;
    }
    const plan = parsed.plans.get(event.dispatchAlias);
    if (!plan) {
      findings.push('DISPATCH_PLAN_UNKNOWN_ALIAS');
      continue;
    }
    if (plan.disposition === 'root-initial') {
      if (!plan.closed) findings.push('STATIC_DISPATCH_UNCONSUMED');
      else if (consumedStaticAliases.has(plan.alias)) findings.push('STATIC_DISPATCH_REPLAY');
      else consumedStaticAliases.add(plan.alias);
    }
    if (event.plannedDispatchId !== plan.plannedDispatchId
      || event.rootInvocationId !== plan.rootInvocationId
      || event.planSlot !== plan.planSlot
      || event.disposition !== plan.disposition
      || !samePlanCorrelation(event, plan.correlation)) {
      findings.push('DISPATCH_PLAN_MISMATCH');
    }
  }
  return { status: findings.length ? 'DISCREPANT' : 'RECONCILED', findings: [...new Set(findings)] };
}

function parseCampaignReservationLedger(text, expectedImplementationLockHash = null) {
  if (typeof text !== 'string' || !text.endsWith('\n')) {
    return { findings: ['CAMPAIGN_LEDGER_UNREADABLE'], reservations: new Map() };
  }
  const rows = [];
  try {
    for (const line of text.trimEnd().split('\n')) rows.push(JSON.parse(line));
  } catch {
    return { findings: ['CAMPAIGN_LEDGER_INVALID'], reservations: new Map() };
  }
  let policy;
  try {
    if (rows[0]?.event !== 'policy') throw new Error('missing policy');
    policy = validateCampaignPolicy(rows[0].policy);
  } catch {
    return { findings: ['CAMPAIGN_LEDGER_INVALID'], reservations: new Map() };
  }
  const { campaignId } = policy;
  if (expectedImplementationLockHash !== null && policy.implementationLockHash !== expectedImplementationLockHash) {
    return { findings: ['CAMPAIGN_LEDGER_INVALID'], reservations: new Map() };
  }
  const sessions = new Map();
  const reservations = new Map();
  const counts = Object.fromEntries(Object.keys(policy.limits).map((key) => [key, 0]));
  let total = 0;
  let recoveries = 0;
  const findings = [];
  for (const row of rows.slice(1)) {
    if (!isPlainObject(row)) { findings.push('CAMPAIGN_LEDGER_INVALID'); continue; }
    if (row.event === 'session') {
      const fields = ['event', 'id', 'recovery', 'kind', 'runId', 'attemptId'];
      if (Object.keys(row).sort().join() !== fields.sort().join()
        || !isNonEmptyString(row.id) || sessions.has(row.id)
        || typeof row.recovery !== 'boolean'
        || !['probe', 'acceptance'].includes(row.kind)
        || !isNonEmptyString(row.runId) || !isNonEmptyString(row.attemptId)) {
        findings.push('CAMPAIGN_LEDGER_INVALID');
      } else {
        sessions.set(row.id, row);
        if (row.recovery) recoveries += 1;
      }
      continue;
    }
    if (row.event !== 'reservation') { findings.push('CAMPAIGN_LEDGER_INVALID'); continue; }
    const fields = ['event', 'reservationId', 'session', ...CAMPAIGN_JOIN_FIELDS];
    const session = sessions.get(row.session);
    if (Object.keys(row).sort().join() !== fields.slice().sort().join()
      || !CAMPAIGN_RESERVATION_ID.test(row.reservationId)
      || row.reservationId !== `${campaignId}:${total + 1}`
      || !row.reservationId.startsWith(`${campaignId}:`)
      || reservations.has(row.reservationId)
      || !session
      || !Object.hasOwn(policy.limits, row.requestClass)
      || row.runId !== session.runId || row.attemptId !== session.attemptId
      || !CAMPAIGN_JOIN_FIELDS.every((field) => (
        field === 'repetition'
          ? Number.isSafeInteger(row.repetition) && row.repetition >= 0
          : isNonEmptyString(row[field])
      ))
      || !SAFE_LINEAGE_ID.test(row.rootInvocationId)
      || !OPAQUE_DISPATCH_ID.test(row.plannedDispatchId)
      || !SAFE_LINEAGE_ID.test(row.planSlot)
      || !PLAN_DISPOSITIONS.has(row.disposition)
      || !ROOT_OPERATIONS.has(row.rootOperation)) {
      findings.push('CAMPAIGN_LEDGER_INVALID');
      continue;
    }
    reservations.set(row.reservationId, row);
    counts[row.requestClass] += 1;
    total += 1;
  }
  if (total > policy.maxRequests || sessions.size > policy.maxSessions
    || recoveries > policy.maxRecoveryAttempts
    || Object.keys(counts).some((requestClass) => counts[requestClass] > policy.limits[requestClass])) {
    findings.push('CAMPAIGN_LEDGER_INVALID');
  }
  return { findings: [...new Set(findings)], reservations };
}

function reconcileCampaignReservations(events, text, expectedImplementationLockHash = null, expectedAttemptId = null) {
  const parsed = parseCampaignReservationLedger(text, expectedImplementationLockHash);
  const findings = [...parsed.findings];
  const used = new Set();
  for (const event of events) {
    if (isNativeCapDenial(event)) continue;
    if (event.version !== 2 || !CAMPAIGN_RESERVATION_ID.test(event.campaignReservationId)) {
      findings.push('CAMPAIGN_RESERVATION_MISSING');
      continue;
    }
    const reservation = parsed.reservations.get(event.campaignReservationId);
    if (!reservation) {
      findings.push('CAMPAIGN_RESERVATION_UNKNOWN');
      continue;
    }
    if (used.has(event.campaignReservationId)) {
      findings.push('CAMPAIGN_RESERVATION_REUSED');
      continue;
    }
    used.add(event.campaignReservationId);
    if (!CAMPAIGN_JOIN_FIELDS.every((field) => event[field] === reservation[field])) {
      findings.push('CAMPAIGN_RESERVATION_MISMATCH');
    }
  }
  for (const [reservationId, reservation] of parsed.reservations) {
    if (reservation.attemptId === expectedAttemptId && !used.has(reservationId)) {
      findings.push('CAMPAIGN_RESERVATION_ORPHANED');
    }
  }
  return { status: findings.length ? 'DISCREPANT' : 'RECONCILED', findings: [...new Set(findings)] };
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
  const {
    ledgerText = null,
    ledgerPath,
    raw,
    attemptId,
    pinnedModels,
    nativeAttemptPolicy,
    planLedgerText = null,
    campaignLedgerText = null,
    requireDispatchPlans = false,
    requireCampaignReservations = false
  } = input ?? {};
  if (typeof requireDispatchPlans !== 'boolean' || typeof requireCampaignReservations !== 'boolean') {
    throw new Error('dispatch plan and campaign reservation requirements must be boolean');
  }
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
  const envelope = (status, totals, findings, nativeAttemptTrace = null) => Object.freeze({
    schema: 'shadowgraph.v11.provider-reconciliation',
    version: 1,
    attemptId,
    ledgerPath,
    status,
    totals,
    findings: Object.freeze(findings),
    nativeAttemptTrace
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
  const dispatchPlanEvidence = requireDispatchPlans
    ? reconcileDispatchPlans(events, planLedgerText)
    : null;
  const rawImplementationLockHash = raw?.implementationLockHash;
  const campaignReservationEvidence = requireCampaignReservations
    ? (typeof rawImplementationLockHash === 'string' && SHA256.test(rawImplementationLockHash)
      ? reconcileCampaignReservations(events, campaignLedgerText, rawImplementationLockHash, attemptId)
      : { status: 'DISCREPANT', findings: ['CAMPAIGN_LEDGER_INVALID'] })
    : null;
  const { expectations, unverifiedCounts } = providerExpectationsFromRun(raw, attemptId);
  const expectedModels = {
    // The outer decision and an arm's own internal calls are the same pinned
    // chat model: the lock states it once and both routes use it.
    outer_decision_llm: pinnedModels.internal_memory_llm.modelId,
    internal_memory_llm: pinnedModels.internal_memory_llm.modelId,
    embedding: pinnedModels.embedding.modelId
  };
  let report = reconcileProviderEvidenceInternal({
    events,
    malformed,
    expectations,
    unverifiedCounts,
    expectedModels
  });
  let nativeAttemptTrace = null;
  if (nativeAttemptPolicy !== undefined) {
    try {
      nativeAttemptTrace = traceNativeAttempts({
        events,
        expectedModels,
        policy: nativeAttemptPolicy,
        requireDispatchPlans
      });
    } catch {
      nativeAttemptTrace = Object.freeze({
        status: 'DISCREPANT',
        trace: Object.freeze([]),
        findings: Object.freeze([{ code: 'NATIVE_ATTEMPT_TRACE_INVALID' }])
      });
    }
    if (nativeAttemptTrace.status === 'RECONCILED') {
      const resolvedTransportFailures = new Set(
        nativeAttemptTrace.trace
          .filter((entry) => entry.category === 'B' && entry.priorRequestNumber !== null)
          .map((entry) => entry.priorRequestNumber)
      );
      if (resolvedTransportFailures.size > 0) {
        report = reconcileProviderEvidenceInternal({
          events,
          malformed,
          expectations,
          unverifiedCounts,
          expectedModels
        }, resolvedTransportFailures);
      }
    }
  }
  let findings = [...report.findings];
  let status = report.status;
  if (dispatchPlanEvidence !== null && dispatchPlanEvidence.status !== 'RECONCILED') {
    status = 'DISCREPANT';
    findings.push(...dispatchPlanEvidence.findings.map((code) => ({ code })));
  }
  if (campaignReservationEvidence !== null && campaignReservationEvidence.status !== 'RECONCILED') {
    status = 'DISCREPANT';
    findings.push(...campaignReservationEvidence.findings.map((code) => ({ code })));
  }
  if (nativeAttemptTrace?.status !== null && nativeAttemptTrace?.status !== undefined
    && nativeAttemptTrace.status !== 'RECONCILED') {
    status = 'DISCREPANT';
    findings.push({
      code: 'NATIVE_ATTEMPT_TRACE_DISCREPANT',
      traceFindings: nativeAttemptTrace.findings.length
    });
  }
  if (input.providerBudget !== undefined) {
    const budgetEvidence = reconcileProviderAttempts({
      text: input.attemptLedgerText, events, expectedBudget: input.providerBudget
    });
    return Object.freeze({ ...envelope(
      budgetEvidence.status === 'RECONCILED' ? status : 'DISCREPANT', report.totals, findings, nativeAttemptTrace
    ), budgetEvidence });
  }
  return envelope(status, report.totals, findings, nativeAttemptTrace);
}
