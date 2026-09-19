function values(value) {
  return Array.isArray(value) ? value : [];
}

function uniqueIntersectionCount(actual, expected) {
  const wanted = new Set(expected);
  return new Set(values(actual).filter((item) => wanted.has(item))).size;
}

function coverageScore(actual, expected) {
  const count = uniqueIntersectionCount(actual, expected);
  if (count === 0) return 0;
  return count === expected.length ? 2 : 1;
}

function responseMentionsTarget(scenario, decisionId, response) {
  const scalarTargets = new Set([
    decisionId,
    scenario.choice.id,
    scenario.failedAttempt.id,
    ...scenario.alternatives.map((item) => item.id),
    ...scenario.alternatives.map((item) => item.reasonId)
  ].filter(Boolean));
  for (const key of ['decisionId', 'choiceId', 'changedFactId']) {
    if (scalarTargets.has(response[key])) return true;
  }
  for (const key of ['recalledAlternativeIds', 'recalledRejectionReasonIds', 'failedAttemptIdsAvoided', 'failedAttemptReasonIdsCited']) {
    if (values(response[key]).some((item) => scalarTargets.has(item))) return true;
  }
  return false;
}

/**
 * Interpret an adapter's recorded isolation evidence as an inspection outcome.
 *
 * The adapters report `verified` alongside two match counts. Both matter, and
 * they can disagree: `verified` is the adapter's own summary, while the counts
 * are what it actually found. When a count says a target record is present, that
 * is a leak whatever the summary claims, so the counts win. Returning null for
 * absent evidence is what lets the scorer distinguish "inspected and clean" from
 * "never inspected", which the frozen rule needs and the old code could not do.
 */
export function isolationInspectionFrom(evidence) {
  if (evidence === null || evidence === undefined || typeof evidence !== 'object') return null;
  const matchingRecordIds = evidence.matchingRecordIdCount;
  const matchingContent = evidence.matchingContentCount;
  // An evidence object without both counters did not report what the rule asks
  // about, so it is not an inspection for this purpose. Coercing the missing
  // counters to 0 would have let `verified: true` alone stand as a confirmation
  // - the counts win only if they are there to win.
  if (!Number.isFinite(matchingRecordIds) || !Number.isFinite(matchingContent)) return null;
  const leaked = matchingRecordIds > 0 || matchingContent > 0;
  return { verified: evidence.verified === true && !leaked, leaked };
}

/**
 * The v1.0 lifecycle carries its inspection as a single boolean, `persistedLeak`.
 *
 * That protocol is already frozen and has scored published runs, so this reads
 * the boolean as the inspection outcome it stands for rather than reclassifying
 * v1.0 units as unverifiable, which would silently restate historical scores.
 * The v1.0 flag has the same weakness the v1.1 field had - it is computed with
 * `=== true`, so an absent inspection becomes "no leak" - and that is tracked
 * separately rather than fixed here, where fixing it would change frozen v1.0
 * results as a side effect of a v1.1 repair.
 */
function inspectionFromLegacyFlag(probe) {
  if (typeof probe.persistedLeak !== 'boolean') return null;
  return { verified: probe.persistedLeak === false, leaked: probe.persistedLeak === true };
}

/**
 * Score one isolation probe as 1 (clean), 0 (leaked), or null (not verifiable).
 *
 * The frozen rule reads "1 only when response contains none of the target
 * fixture ids and persisted-state inspection confirms no target record copied".
 * Two conditions, joined by "and", behind an "only when". So a 1 has to be
 * earned twice, and the two ways of not earning it differ: a leak scores 0,
 * while an absent answer or an inspection that never ran scores neither, because
 * there is nothing to score. Returning 1 there - which is what a missing probe
 * used to produce - awards the best result on a hard isolation gate to whichever
 * arm supplied the least evidence.
 *
 * `persistenceMeasured` is false for arms declaring persistence NOT_APPLICABLE.
 * They keep no records, so no inspection can confirm anything about records they
 * do not have, and demanding one would penalise the control for working exactly
 * as designed.
 */
function isolationScore(scenario, decisionId, probe, persistenceMeasured) {
  if (probe === null || probe === undefined) return null;
  const inspection = probe.inspection ?? inspectionFromLegacyFlag(probe);
  if (inspection?.leaked === true) return 0;

  const response = probe.response;
  if (response === null || response === undefined || typeof response !== 'object') return null;
  if (responseMentionsTarget(scenario, decisionId, response)) return 0;

  if (!persistenceMeasured) return 1;
  if (inspection === null) return null;
  // Three outcomes, not two. A leak is 0 and a confirmation is 1, but an
  // inspection that ran and confirmed nothing is neither: scoring it 0 would
  // charge the arm for a defect in the inspection, and scoring it 1 is the
  // fail-open this function exists to close.
  return inspection.verified === true ? 1 : null;
}

/**
 * Score the three D_FALSE probes as a rate, or as null when the set is short.
 *
 * The frozen rule fixes the denominator at three, then says what a missing
 * answer is: "Null, malformed, or missing is a failed unit, not a negative
 * prediction." Counting such a probe as a negative makes silence
 * indistinguishable from a correct negative, and an arm answering none of the
 * three would post the best false-alert rate in the run. So the rate exists only
 * when all three probes carry a real boolean, and the counts travel beside it so
 * a null rate can still be told apart from a set that never ran.
 */
function falseAlertOutcome(probes) {
  const required = 3;
  const valid = probes
    .slice(0, required)
    .filter((probe) => typeof probe?.changedFactDetected === 'boolean');
  const alerts = valid.filter((probe) => probe.changedFactDetected === true).length;
  return {
    rate: valid.length === required ? alerts / required : null,
    required,
    valid: valid.length,
    failed: required - valid.length
  };
}

export function scoreScenario(scenario, lifecycle, { applicability = null } = {}) {
  const recall = lifecycle.B ?? {};
  const repeated = lifecycle.C ?? {};
  const changed = lifecycle.D_TRUE ?? {};
  const falseProbes = values(lifecycle.D_FALSE);
  const failed = lifecycle.E ?? {};
  const alternativeIds = scenario.alternatives.map((item) => item.id);
  const reasonIds = scenario.alternatives.map((item) => item.reasonId);
  const avoidedFailure = values(failed.failedAttemptIdsAvoided).includes(scenario.failedAttempt.id)
    && values(failed.failedAttemptReasonIdsCited).includes(scenario.failedAttempt.reasonId)
    && failed.choiceId !== scenario.failedAttempt.approachId;

  const userIsolationNotApplicable = applicability === null
    ? lifecycle.ISOLATION_USER?.notApplicable === true
    : applicability?.userIsolation?.status === 'NOT_APPLICABLE';
  // An arm that declares no persistence has no persisted state for the second
  // half of the isolation rule to inspect. Anything else must be inspected.
  const persistenceMeasured = applicability === null
    ? true
    : applicability?.persistence?.status !== 'NOT_APPLICABLE';
  const targetDecisionId = Object.hasOwn(lifecycle.A ?? {}, 'persistedDecisionId')
    ? lifecycle.A.persistedDecisionId
    : lifecycle.A?.decisionId;
  const falseAlerts = falseAlertOutcome(falseProbes);
  const metrics = {
    decisionRetrievalAccuracy: recall.choiceId === scenario.choice.id
      && typeof targetDecisionId === 'string'
      && targetDecisionId.length > 0
      && recall.decisionId === targetDecisionId ? 1 : 0,
    rejectedAlternativeRecall: uniqueIntersectionCount(recall.recalledAlternativeIds, alternativeIds) / alternativeIds.length,
    rejectionReasonRecall: uniqueIntersectionCount(recall.recalledRejectionReasonIds, reasonIds) / reasonIds.length,
    changedFactDetection: changed.changedFactDetected === true && changed.changedFactId === scenario.changedFact.id ? 1 : 0,
    falseAlertRate: falseAlerts.rate,
    falseAlertProbesRequired: falseAlerts.required,
    falseAlertProbesValid: falseAlerts.valid,
    falseAlertProbesFailed: falseAlerts.failed,
    failedAttemptAvoidance: avoidedFailure ? 1 : 0,
    projectIsolation: isolationScore(
      scenario, targetDecisionId, lifecycle.ISOLATION_PROJECT, persistenceMeasured
    ),
    userIsolation: userIsolationNotApplicable
      ? null
      : isolationScore(scenario, targetDecisionId, lifecycle.ISOLATION_USER, persistenceMeasured)
  };

  const addressedConstraints = uniqueIntersectionCount(repeated.constraintIdsAddressed, scenario.constraints.map((item) => item.id));
  const constraintFit = addressedConstraints === 0
    ? 0
    : addressedConstraints === scenario.constraints.length && repeated.choiceId === scenario.choice.id ? 2 : 1;
  const changedFactResponse = metrics.changedFactDetection === 0
    ? 0
    : typeof changed.recommendation === 'string' && changed.recommendation.trim().length > 0 ? 2 : 1;
  const failedIdPresent = values(failed.failedAttemptIdsAvoided).includes(scenario.failedAttempt.id)
    && failed.choiceId !== scenario.failedAttempt.approachId;
  const knownFailureAvoidance = failedIdPresent
    ? values(failed.failedAttemptReasonIdsCited).includes(scenario.failedAttempt.reasonId) ? 2 : 1
    : 0;
  const triggerInA = values(lifecycle.A?.reviewTriggerIds).includes(scenario.reviewTrigger.id);
  const triggerInC = values(repeated.reviewTriggerIds).includes(scenario.reviewTrigger.id);
  const reversibilityReviewTrigger = triggerInA && triggerInC ? 2 : triggerInA || triggerInC ? 1 : 0;

  const criteria = {
    constraintFit,
    evidenceQuality: coverageScore(repeated.evidenceIdsCited, scenario.evidence.map((item) => item.id)),
    alternativeCoverage: coverageScore(repeated.recalledAlternativeIds, alternativeIds),
    rejectionRationale: coverageScore(repeated.recalledRejectionReasonIds, reasonIds),
    riskRecognition: coverageScore(repeated.riskIdsRecognized, scenario.riskIds),
    reversibilityReviewTrigger,
    changedFactResponse,
    knownFailureAvoidance
  };
  return {
    metrics,
    quality: {
      criteria,
      total: Object.values(criteria).reduce((sum, value) => sum + value, 0)
    }
  };
}
