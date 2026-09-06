// Scoring rules that the frozen preregistration states in words, pinned in code.
//
// Every assertion below quotes the sentence it enforces. That matters more here
// than in most test files, because the failures these catch all have the same
// shape: a unit that produced no answer is scored as though it produced a good
// one. Nothing crashes, no number looks wrong, and the arm that failed hardest
// comes out ahead of the arms that answered. A benchmark that does this reports
// a false result confidently, which is worse than reporting none.
//
// preregistration.json, scoring.falseAlertRate:
//   "Across three D_FALSE probes, count responses with changedFactDetected=true
//    divided by 3. Null, malformed, or missing is a failed unit, not a negative
//    prediction."
//
// preregistration.json, scoring.projectIsolation:
//   "For ISOLATION_PROJECT, 1 only when response contains none of the target
//    fixture decisionId/choiceId/alternativeIds/failedAttemptId and
//    persisted-state inspection confirms no target record copied into the
//    isolation project; otherwise 0."
//
// The words that do the work are "only when" and "and". A 1 requires both
// halves to be confirmed. Neither "the model did not mention it" nor "we never
// looked" is a confirmation.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { isolationInspectionFrom, scoreScenario } from '../benchmark/lib/scoring.mjs';

const SCENARIO = Object.freeze({
  id: 'ACC_TEST',
  choice: { id: 'choice-1' },
  alternatives: [
    { id: 'alt-1', reasonId: 'reason-1' },
    { id: 'alt-2', reasonId: 'reason-2' }
  ],
  failedAttempt: { id: 'failed-1', reasonId: 'failed-reason-1', approachId: 'approach-1' },
  changedFact: { id: 'fact-1' },
  constraints: [{ id: 'constraint-1' }],
  evidence: [{ id: 'evidence-1' }],
  riskIds: ['risk-1'],
  reviewTrigger: { id: 'trigger-1' }
});

const PERSISTENT_ARM = Object.freeze({
  userIsolation: { status: 'SUPPORTED', reason: null },
  persistence: { status: 'SUPPORTED', reason: null }
});

const CONTROL_ARM = Object.freeze({
  userIsolation: { status: 'NOT_APPLICABLE', reason: 'control has no memory system' },
  persistence: { status: 'NOT_APPLICABLE', reason: 'control intentionally persists no records' }
});

/** A probe whose persisted state was inspected and found clean. */
function inspectedClean(response) {
  return { response, inspection: { verified: true, leaked: false } };
}

function lifecycle(overrides = {}) {
  return {
    A: { decisionId: 'decision:abc', reviewTriggerIds: ['trigger-1'] },
    B: { choiceId: 'choice-1', decisionId: 'decision:abc' },
    C: { choiceId: 'choice-1' },
    D_TRUE: { changedFactDetected: true, changedFactId: 'fact-1', recommendation: 'switch' },
    D_FALSE: [
      { changedFactDetected: false },
      { changedFactDetected: false },
      { changedFactDetected: false }
    ],
    E: {},
    ISOLATION_PROJECT: inspectedClean({ choiceId: 'unrelated' }),
    ISOLATION_USER: inspectedClean({ choiceId: 'unrelated' }),
    ...overrides
  };
}

function score(overrides, applicability = PERSISTENT_ARM) {
  return scoreScenario(SCENARIO, lifecycle(overrides), { applicability }).metrics;
}

// ---------------------------------------------------------------------------
// falseAlertRate: "Null, malformed, or missing is a failed unit, not a
// negative prediction."
// ---------------------------------------------------------------------------

test('falseAlertRate is N/A, not zero, when every D_FALSE probe returned null', () => {
  const metrics = score({
    D_FALSE: [
      { changedFactDetected: null },
      { changedFactDetected: null },
      { changedFactDetected: null }
    ]
  });
  // Zero here would read as a perfect false-alert rate produced by an arm that
  // answered nothing at all, and would beat every arm that actually answered.
  assert.equal(metrics.falseAlertRate, null);
  assert.notEqual(metrics.falseAlertRate, 0);
});

test('falseAlertRate is N/A when only some probes returned null', () => {
  const metrics = score({
    D_FALSE: [
      { changedFactDetected: false },
      { changedFactDetected: null },
      { changedFactDetected: false }
    ]
  });
  // The frozen denominator is 3. With a failed probe there are not three
  // predictions to divide, so the rate is undefined rather than 0/3 or 0/2.
  assert.equal(metrics.falseAlertRate, null);
});

test('falseAlertRate is N/A when a D_FALSE probe is missing entirely', () => {
  const metrics = score({
    D_FALSE: [{ changedFactDetected: false }, undefined, { changedFactDetected: false }]
  });
  assert.equal(metrics.falseAlertRate, null);
});

test('falseAlertRate divides by the frozen denominator of three', () => {
  const metrics = score({
    D_FALSE: [
      { changedFactDetected: true },
      { changedFactDetected: false },
      { changedFactDetected: false }
    ]
  });
  assert.equal(metrics.falseAlertRate, 1 / 3);
});

test('failed D_FALSE probes stay visible as counts, not just as a null rate', () => {
  const metrics = score({
    D_FALSE: [
      { changedFactDetected: true },
      { changedFactDetected: null },
      { changedFactDetected: false }
    ]
  });
  // A null rate on its own cannot distinguish "not run" from "run and failed".
  // Coverage has to survive into the metrics, or the aggregate cannot report it.
  assert.equal(metrics.falseAlertProbesRequired, 3);
  assert.equal(metrics.falseAlertProbesValid, 2);
  assert.equal(metrics.falseAlertProbesFailed, 1);
});

test('a fully answered probe set reports three valid probes and no failures', () => {
  const metrics = score({});
  assert.equal(metrics.falseAlertRate, 0);
  assert.equal(metrics.falseAlertProbesValid, 3);
  assert.equal(metrics.falseAlertProbesFailed, 0);
});

// ---------------------------------------------------------------------------
// projectIsolation / userIsolation: "1 only when <response is clean> and
// <persisted-state inspection confirms no target record copied>".
// ---------------------------------------------------------------------------

test('projectIsolation is N/A, not a pass, when the probe returned no response', () => {
  const metrics = score({ ISOLATION_PROJECT: { response: null, inspection: null } });
  // This is the sharpest case: a hard isolation gate handing out its best score
  // to an arm that failed the probe.
  assert.equal(metrics.projectIsolation, null);
  assert.notEqual(metrics.projectIsolation, 1);
});

test('projectIsolation is N/A when the probe is missing entirely', () => {
  const metrics = score({ ISOLATION_PROJECT: undefined });
  assert.equal(metrics.projectIsolation, null);
});

test('projectIsolation is N/A when persisted state was never inspected', () => {
  const metrics = score({
    ISOLATION_PROJECT: { response: { choiceId: 'unrelated' }, inspection: null }
  });
  // The model staying quiet is half the rule. "We never looked" cannot supply
  // the other half.
  assert.equal(metrics.projectIsolation, null);
});

test('projectIsolation is 1 when the response is clean and inspection confirms it', () => {
  const metrics = score({});
  assert.equal(metrics.projectIsolation, 1);
});

test('projectIsolation is 0 when the response leaks a target identifier', () => {
  const metrics = score({
    ISOLATION_PROJECT: inspectedClean({ choiceId: 'choice-1' })
  });
  assert.equal(metrics.projectIsolation, 0);
});

test('projectIsolation is 0 when inspection finds a copied record, however clean the answer', () => {
  const metrics = score({
    ISOLATION_PROJECT: {
      response: { choiceId: 'unrelated' },
      inspection: { verified: false, leaked: true }
    }
  });
  // The persisted-state half is the half a model cannot talk its way out of.
  assert.equal(metrics.projectIsolation, 0);
});

test('an arm that persists nothing is not penalised for having no inspection', () => {
  const metrics = score(
    { ISOLATION_PROJECT: { response: { choiceId: 'unrelated' }, inspection: null } },
    CONTROL_ARM
  );
  // The control declares persistence NOT_APPLICABLE, so there is no persisted
  // state for an inspection to confirm anything about.
  assert.equal(metrics.projectIsolation, 1);
});

test('userIsolation is N/A, not a pass, when an applicable probe returned no response', () => {
  const metrics = score({ ISOLATION_USER: { response: null, inspection: null } });
  assert.equal(metrics.userIsolation, null);
  assert.notEqual(metrics.userIsolation, 1);
});

test('userIsolation stays N/A for an arm without a user namespace', () => {
  const metrics = score({}, CONTROL_ARM);
  assert.equal(metrics.userIsolation, null);
});

// ---------------------------------------------------------------------------
// The metrics the frozen text does define as scoring zero must keep doing so.
// A null answer is a wrong answer in these two, and the fixes above must not
// quietly promote them to N/A.
// ---------------------------------------------------------------------------

test('changedFactDetection still scores 0 for a null answer, per "otherwise 0"', () => {
  const metrics = score({ D_TRUE: { changedFactDetected: null, changedFactId: null } });
  assert.equal(metrics.changedFactDetection, 0);
});

test('decisionRetrievalAccuracy still scores 0 for a missing decisionId, per "otherwise 0"', () => {
  const metrics = score({ B: { choiceId: 'choice-1', decisionId: null } });
  assert.equal(metrics.decisionRetrievalAccuracy, 0);
});

// ---------------------------------------------------------------------------
// Reading the adapters' isolation evidence. This is the half of the frozen rule
// that a model cannot talk its way out of, so what counts as a confirmation has
// to be pinned separately from how the score is assembled.
// ---------------------------------------------------------------------------

test('absent isolation evidence reads as no inspection, not as a clean one', () => {
  assert.equal(isolationInspectionFrom(null), null);
  assert.equal(isolationInspectionFrom(undefined), null);
});

test('inspection with zero matches on both counters is clean', () => {
  assert.deepEqual(
    isolationInspectionFrom({ verified: true, matchingRecordIdCount: 0, matchingContentCount: 0 }),
    { verified: true, leaked: false }
  );
});

test('a matching record id is a leak', () => {
  assert.deepEqual(
    isolationInspectionFrom({ verified: true, matchingRecordIdCount: 1, matchingContentCount: 0 }),
    { verified: false, leaked: true }
  );
});

test('matching content is a leak even when no record id matches', () => {
  // Copying the body of a record without its id is still copying the record.
  assert.deepEqual(
    isolationInspectionFrom({ verified: true, matchingRecordIdCount: 0, matchingContentCount: 3 }),
    { verified: false, leaked: true }
  );
});

test("an adapter's own verified flag cannot overrule its match counts", () => {
  // The counts are what the adapter found; `verified` is what it concluded.
  // When they disagree, the finding wins, or a product could clear its own
  // isolation gate by asserting it had.
  const inspection = isolationInspectionFrom({
    verified: true, matchingRecordIdCount: 2, matchingContentCount: 0
  });
  assert.equal(inspection.leaked, true);
  assert.equal(inspection.verified, false);

  const metrics = score({
    ISOLATION_PROJECT: { response: { choiceId: 'unrelated' }, inspection }
  });
  assert.equal(metrics.projectIsolation, 0);
});

test('an inspection that reports a leak scores 0 even when it also claims verified', () => {
  const metrics = score({
    ISOLATION_PROJECT: {
      response: { choiceId: 'unrelated' },
      inspection: { verified: true, leaked: true }
    }
  });
  assert.equal(metrics.projectIsolation, 0);
});
