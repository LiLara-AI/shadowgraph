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
  const { events, malformed = [], expectations, expectedModels = null } = input;
  if (!Array.isArray(events)) throw new Error('events must be an array');
  if (!Array.isArray(expectations)) throw new Error('expectations must be an array');
  expectations.forEach(validateExpectation);

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
  for (const expectation of expectations) {
    const key = expectationKey(expectation);
    expectedKeys.add(key);
    const matched = observed.get(key) ?? [];
    const correlation = readableCorrelation(expectation);

    if (matched.length < expectation.expectedCalls) {
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

  const expectedCalls = expectations.reduce((total, entry) => total + entry.expectedCalls, 0);
  const matchedCalls = expectations.reduce((total, entry) => {
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
      malformedLines: malformed.length
    }),
    findings: Object.freeze(findings)
  });
}
