import { scoreScenario } from './scoring.mjs';

const REQUIRED_PHASES = [
  'A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2',
  'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'
];
const METRIC_NAMES = [
  'decisionRetrievalAccuracy', 'rejectedAlternativeRecall', 'rejectionReasonRecall',
  'changedFactDetection', 'falseAlertRate', 'failedAttemptAvoidance',
  'projectIsolation', 'userIsolation'
];

function mean(values) {
  const finite = values.filter(Number.isFinite);
  return finite.length === values.length && values.length > 0
    ? finite.reduce((sum, value) => sum + value, 0) / finite.length
    : null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length !== values.length || sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function round(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function macroScenarioMean(items, scenarios, selector) {
  return mean(scenarios.map((scenario) => mean(
    items.filter((item) => item.scenarioId === scenario.id).map(selector)
  )));
}

function lifecycleFrom(measurements) {
  const byPhase = new Map(measurements.map((item) => [item.phase, item]));
  return {
    A: byPhase.get('A')?.response,
    B: byPhase.get('B')?.response,
    C: byPhase.get('C')?.response,
    D_TRUE: byPhase.get('D_TRUE')?.response,
    D_FALSE: [0, 1, 2].map((index) => byPhase.get(`D_FALSE_${index}`)?.response),
    E: byPhase.get('E')?.response,
    ISOLATION_PROJECT: {
      response: byPhase.get('ISOLATION_PROJECT')?.response,
      persistedLeak: byPhase.get('ISOLATION_PROJECT')?.response?.persistedLeak === true
    },
    ISOLATION_USER: {
      response: byPhase.get('ISOLATION_USER')?.response,
      persistedLeak: byPhase.get('ISOLATION_USER')?.response?.persistedLeak === true,
      notApplicable: byPhase.get('ISOLATION_USER')?.response?.notApplicable === true
    }
  };
}

function groupMeasurements(measurements) {
  const groups = new Map();
  for (const item of measurements) {
    const key = `${item.armId}\u0000${item.scenarioId}\u0000${item.repetition}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function summarizeArm(armId, raw, preregistration, groups) {
  const expectedGroupCount = preregistration.scenarios.length * preregistration.commonExecution.repetitions;
  const scores = [];
  const economics = [];
  let complete = true;
  for (let repetition = 0; repetition < preregistration.commonExecution.repetitions; repetition += 1) {
    for (const scenario of preregistration.scenarios) {
      const key = `${armId}\u0000${scenario.id}\u0000${repetition}`;
      const units = groups.get(key) ?? [];
      const phases = new Set(units.map((item) => item.phase));
      if (units.length !== REQUIRED_PHASES.length
        || REQUIRED_PHASES.some((phase) => !phases.has(phase))
        || units.some((item) => item.status !== 'MEASURED')) {
        complete = false;
        continue;
      }
      const scored = scoreScenario(scenario, lifecycleFrom(units));
      scores.push({ scenarioId: scenario.id, repetition, ...scored });
      const tokenValues = units.map((item) => item.usage?.totalTokens);
      const costValues = units.map((item) => item.cost?.amount);
      economics.push({
        scenarioId: scenario.id,
        repetition,
        totalTokens: tokenValues.every(Number.isFinite) ? tokenValues.reduce((sum, value) => sum + value, 0) : null,
        toolCalls: units.reduce((sum, item) => sum + item.toolCalls, 0),
        lifecycleLatencyMs: units.reduce((sum, item) => sum + item.latencyMs, 0),
        cost: costValues.every(Number.isFinite) ? costValues.reduce((sum, value) => sum + value, 0) : null,
        peakStorageBytes: Math.max(...units.map((item) => item.storageBytes ?? 0))
      });
    }
  }
  complete = complete && scores.length === expectedGroupCount;
  if (!complete) return null;
  const metrics = {};
  for (const name of METRIC_NAMES) {
    metrics[name] = round(macroScenarioMean(scores, preregistration.scenarios, (item) => item.metrics[name]));
  }
  metrics.efficacyComposite = round(mean([
    metrics.decisionRetrievalAccuracy,
    metrics.rejectedAlternativeRecall,
    metrics.rejectionReasonRecall,
    metrics.changedFactDetection,
    metrics.failedAttemptAvoidance,
    Number.isFinite(metrics.falseAlertRate) ? 1 - metrics.falseAlertRate : null
  ]));
  return {
    armId,
    rankEligible: complete && metrics.userIsolation !== null,
    scenarioRepetitions: scores.length,
    metrics,
    quality: {
      mean: round(macroScenarioMean(scores, preregistration.scenarios, (item) => item.quality.total)),
      criteria: Object.fromEntries(Object.keys(scores[0]?.quality.criteria ?? {}).map((name) => [
        name,
        round(macroScenarioMean(scores, preregistration.scenarios, (item) => item.quality.criteria[name]))
      ]))
    },
    economics: {
      meanLifecycleTokens: round(macroScenarioMean(economics, preregistration.scenarios, (item) => item.totalTokens)),
      meanLifecycleToolCalls: round(macroScenarioMean(economics, preregistration.scenarios, (item) => item.toolCalls)),
      medianLifecycleLatencyMs: round(median(economics.map((item) => item.lifecycleLatencyMs))),
      meanLifecycleCost: round(macroScenarioMean(economics, preregistration.scenarios, (item) => item.cost)),
      meanPeakStorageBytes: round(macroScenarioMean(economics, preregistration.scenarios, (item) => item.peakStorageBytes))
    }
  };
}

function pairwiseWin(candidate, competitor) {
  return candidate.metrics.efficacyComposite >= competitor.metrics.efficacyComposite + 0.05
    && candidate.quality.mean >= competitor.quality.mean - 0.5
    && candidate.metrics.projectIsolation === 1
    && candidate.metrics.userIsolation === 1
    && competitor.metrics.projectIsolation === 1
    && competitor.metrics.userIsolation === 1
    && candidate.metrics.falseAlertRate <= competitor.metrics.falseAlertRate
    && candidate.metrics.failedAttemptAvoidance >= competitor.metrics.failedAttemptAvoidance;
}

function bestCandidate(armResults, preregistration) {
  if (armResults.length !== preregistration.arms.length || armResults.some((result) => !result.rankEligible)) return null;
  const nonShadowGraph = armResults.filter((result) => !result.armId.startsWith('shadowgraph-'));
  for (const candidate of armResults.filter((result) => result.armId.startsWith('shadowgraph-'))) {
    const metrics = candidate.metrics;
    if (!(metrics.decisionRetrievalAccuracy >= 0.95
      && metrics.rejectedAlternativeRecall >= 0.90
      && metrics.rejectionReasonRecall >= 0.90
      && metrics.changedFactDetection >= 0.90
      && metrics.falseAlertRate <= 0.05
      && metrics.failedAttemptAvoidance >= 0.90
      && metrics.projectIsolation === 1
      && metrics.userIsolation === 1
      && candidate.quality.mean >= 14)) continue;
    if (armResults.some((result) => result.armId !== candidate.armId && !pairwiseWin(candidate, result))) continue;
    const peerTokenMedian = median(nonShadowGraph.map((result) => result.economics.meanLifecycleTokens));
    const peerLatencyMedian = median(nonShadowGraph.map((result) => result.economics.medianLifecycleLatencyMs));
    if (!Number.isFinite(candidate.economics.meanLifecycleTokens)
      || !Number.isFinite(candidate.economics.medianLifecycleLatencyMs)
      || !Number.isFinite(peerTokenMedian)
      || !Number.isFinite(peerLatencyMedian)
      || candidate.economics.meanLifecycleTokens > peerTokenMedian * 0.8
      || candidate.economics.medianLifecycleLatencyMs > peerLatencyMedian * 0.8) continue;
    return candidate;
  }
  return null;
}

export function aggregateRun(raw, preregistration) {
  const counts = {
    measuredArms: raw.arms.filter((arm) => arm.status === 'MEASURED').length,
    notMeasuredArms: raw.arms.filter((arm) => arm.status === 'NOT_MEASURED').length,
    failedArms: raw.arms.filter((arm) => arm.status === 'FAILED').length,
    excludedArms: raw.arms.filter((arm) => arm.status === 'EXCLUDED').length,
    measurements: raw.measurements.length
  };
  const base = {
    schemaVersion: 1,
    runId: raw.runId,
    preregistrationSha256: raw.preregistrationSha256,
    generatedFromRaw: true,
    counts
  };
  if (counts.measuredArms === 0) {
    return {
      ...base,
      rankEligibleArms: [],
      armResults: [],
      bestClaimAllowed: false,
      allowedMarketingText: preregistration.marketingThresholds.noResultText
    };
  }
  const groups = groupMeasurements(raw.measurements);
  const armResults = preregistration.arms
    .map((registered) => raw.arms.find((arm) => arm.armId === registered.id))
    .filter((arm) => arm?.status === 'MEASURED')
    .map((arm) => summarizeArm(arm.armId, raw, preregistration, groups))
    .filter((result) => result !== null);
  counts.measuredCompleteArms = armResults.length;
  const rankEligibleArms = armResults.filter((result) => result.rankEligible).map((result) => result.armId);
  const candidate = bestCandidate(armResults, preregistration);
  return {
    ...base,
    rankEligibleArms,
    armResults,
    bestClaimAllowed: candidate !== null,
    allowedMarketingText: candidate
      ? `${raw.arms.find((arm) => arm.armId === candidate.armId)?.name ?? candidate.armId} was best on the preregistered ShadowGraph warm-lifecycle benchmark under the recorded model, machine, scenarios, and repetitions.`
      : preregistration.marketingThresholds.measuredOnlyText
  };
}
