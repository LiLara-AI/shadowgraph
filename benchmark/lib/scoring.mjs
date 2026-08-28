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

function targetLeaked(scenario, decisionId, probe) {
  if (probe?.persistedLeak === true) return true;
  const response = probe?.response ?? {};
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

export function scoreScenario(scenario, lifecycle) {
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

  const metrics = {
    decisionRetrievalAccuracy: recall.choiceId === scenario.choice.id && typeof recall.decisionId === 'string' && recall.decisionId.length > 0 ? 1 : 0,
    rejectedAlternativeRecall: uniqueIntersectionCount(recall.recalledAlternativeIds, alternativeIds) / alternativeIds.length,
    rejectionReasonRecall: uniqueIntersectionCount(recall.recalledRejectionReasonIds, reasonIds) / reasonIds.length,
    changedFactDetection: changed.changedFactDetected === true && changed.changedFactId === scenario.changedFact.id ? 1 : 0,
    falseAlertRate: falseProbes.length === 0
      ? null
      : falseProbes.filter((response) => response?.changedFactDetected === true).length / falseProbes.length,
    failedAttemptAvoidance: avoidedFailure ? 1 : 0,
    projectIsolation: targetLeaked(scenario, lifecycle.A?.decisionId, lifecycle.ISOLATION_PROJECT) ? 0 : 1,
    userIsolation: lifecycle.ISOLATION_USER?.notApplicable === true
      ? null
      : targetLeaked(scenario, lifecycle.A?.decisionId, lifecycle.ISOLATION_USER) ? 0 : 1
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
