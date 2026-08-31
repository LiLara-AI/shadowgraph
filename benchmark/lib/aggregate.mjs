import { scoreScenario } from './scoring.mjs';
import { validateV11RawRun } from './validate.mjs';

const REQUIRED_PHASES = [
  'A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2',
  'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'
];
const METRIC_NAMES = [
  'decisionRetrievalAccuracy', 'rejectedAlternativeRecall', 'rejectionReasonRecall',
  'changedFactDetection', 'falseAlertRate', 'failedAttemptAvoidance',
  'projectIsolation', 'userIsolation'
];
const V11_DECISION_PHASES = [
  'A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2',
  'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'
];
const SHA256 = /^[a-f0-9]{64}$/u;
const V11_SOURCE_HASH_FIELDS = [
  'preregistrationSha256',
  'amendment001Sha256',
  'amendment002Sha256'
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireTrustedV11SourceHashes(raw, trustedSourceHashes) {
  if (!isPlainObject(trustedSourceHashes)) {
    throw new Error('Trusted v1.1 source hashes are required for aggregation');
  }
  const fields = Object.keys(trustedSourceHashes);
  if (fields.length !== V11_SOURCE_HASH_FIELDS.length
    || fields.some((field) => !V11_SOURCE_HASH_FIELDS.includes(field))) {
    throw new Error('Trusted v1.1 source hashes must contain exactly preregistrationSha256, amendment001Sha256, and amendment002Sha256');
  }
  for (const field of V11_SOURCE_HASH_FIELDS) {
    if (!SHA256.test(trustedSourceHashes[field])) {
      throw new Error(`Trusted v1.1 source hash ${field} must be a lowercase full SHA-256 digest`);
    }
    if (raw?.[field] !== trustedSourceHashes[field]) {
      throw new Error(`v1.1 raw ${field} does not match the trusted source hash`);
    }
  }
}

function requireV11AggregationOptions(options) {
  if (!isPlainObject(options)) {
    throw new Error('Trusted v1.1 source hashes are required for aggregation');
  }
  const unknown = Object.keys(options).find((field) => field !== 'trustedSourceHashes');
  if (unknown !== undefined) {
    throw new Error(`Unknown v1.1 aggregation option ${unknown}; only trustedSourceHashes is allowed`);
  }
  if (!Object.hasOwn(options, 'trustedSourceHashes')) {
    throw new Error('Trusted v1.1 source hashes are required for aggregation');
  }
  return options.trustedSourceHashes;
}

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

function aggregateLegacyRun(raw, preregistration) {
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

function v11IsolationLeak(unit) {
  const evidence = unit?.adapterEvidence?.verify?.isolationEvidence;
  return Array.isArray(evidence?.leakedRecordIds) && evidence.leakedRecordIds.length > 0;
}

function v11LifecycleFrom(units) {
  const byPhase = new Map(units.map((unit) => [unit.phase, unit]));
  return {
    A: byPhase.get('A')?.decisionResponse,
    B: byPhase.get('B')?.decisionResponse,
    C: byPhase.get('C')?.decisionResponse,
    D_TRUE: byPhase.get('D_TRUE')?.decisionResponse,
    D_FALSE: [0, 1, 2].map((index) => byPhase.get(`D_FALSE_${index}`)?.decisionResponse),
    E: byPhase.get('E')?.decisionResponse,
    ISOLATION_PROJECT: {
      response: byPhase.get('ISOLATION_PROJECT')?.decisionResponse,
      persistedLeak: v11IsolationLeak(byPhase.get('ISOLATION_PROJECT'))
    },
    ISOLATION_USER: {
      response: byPhase.get('ISOLATION_USER')?.decisionResponse,
      persistedLeak: v11IsolationLeak(byPhase.get('ISOLATION_USER'))
    }
  };
}

function v11UsageTotal(usage) {
  if (Number.isFinite(usage?.totalTokens)) return usage.totalTokens;
  if (Number.isFinite(usage?.total_tokens)) return usage.total_tokens;
  return null;
}

function v11ZeroResultText(zeroResult) {
  return `No measured result is available. Recorded causes: ${zeroResult.causes.join(', ')}.`;
}

function summarizeV11Arm(arm, raw, preregistration) {
  const scores = [];
  const economics = [];
  for (let repetition = 0; repetition < preregistration.commonExecution.repetitions; repetition += 1) {
    for (const scenario of preregistration.scenarios) {
      const units = raw.units.filter((unit) => (
        unit.armId === arm.armId
        && unit.scenarioId === scenario.id
        && unit.repetition === repetition
      ));
      const byPhase = new Map(units.map((unit) => [unit.phase, unit]));
      const complete = V11_DECISION_PHASES.every((phase) => {
        const unit = byPhase.get(phase);
        if (!unit) return false;
        if (phase === 'ISOLATION_USER'
          && arm.applicability.userIsolation.status === 'NOT_APPLICABLE') {
          return unit.status === 'EXCLUDED';
        }
        return unit.status === 'MEASURED';
      });
      if (!complete) return null;

      const scored = scoreScenario(
        scenario,
        v11LifecycleFrom(units),
        { applicability: arm.applicability }
      );
      scores.push({ scenarioId: scenario.id, repetition, ...scored });
      const measuredUnits = units.filter((unit) => unit.phase !== 'RESET' && unit.status === 'MEASURED');
      const tokenValues = measuredUnits.map((unit) => v11UsageTotal(unit.providerUsage));
      const storageMeasurements = measuredUnits.map((unit) => unit.storage);
      economics.push({
        scenarioId: scenario.id,
        repetition,
        outerDecisionTokens: tokenValues.every(Number.isFinite)
          ? tokenValues.reduce((sum, value) => sum + value, 0)
          : null,
        mcpToolCalls: measuredUnits.reduce((sum, unit) => sum + unit.operations.mcpToolCalls, 0),
        lifecycleLatencyMs: measuredUnits.reduce((sum, unit) => sum + unit.latencyMs, 0),
        peakStorageBytes: storageMeasurements.length > 0
          && storageMeasurements.every((storage) => storage?.status === 'MEASURED')
          ? Math.max(...storageMeasurements.map((storage) => storage.bytes))
          : null
      });
    }
  }
  const expected = preregistration.scenarios.length * preregistration.commonExecution.repetitions;
  if (scores.length !== expected) return null;
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
    armId: arm.armId,
    rankEligible: true,
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
      meanOuterDecisionTokens: round(macroScenarioMean(
        economics,
        preregistration.scenarios,
        (item) => item.outerDecisionTokens
      )),
      // Total lifecycle tokens require the separately correlated internal-provider ledger.
      meanLifecycleTokens: null,
      meanLifecycleMcpToolCalls: round(macroScenarioMean(economics, preregistration.scenarios, (item) => item.mcpToolCalls)),
      medianLifecycleLatencyMs: round(median(economics.map((item) => item.lifecycleLatencyMs))),
      meanPeakStorageBytes: round(macroScenarioMean(economics, preregistration.scenarios, (item) => item.peakStorageBytes))
    }
  };
}

export function aggregateV11Run(raw, preregistration, options = {}) {
  const trustedSourceHashes = requireV11AggregationOptions(options);
  requireTrustedV11SourceHashes(raw, trustedSourceHashes);
  validateV11RawRun(raw, preregistration, trustedSourceHashes.preregistrationSha256);
  const counts = {
    measuredArms: raw.arms.filter((arm) => arm.status === 'MEASURED').length,
    partialFailedArms: raw.arms.filter((arm) => arm.status === 'PARTIAL_FAILED').length,
    failedArms: raw.arms.filter((arm) => arm.status === 'FAILED').length,
    notMeasuredArms: raw.arms.filter((arm) => arm.status === 'NOT_MEASURED').length,
    excludedArms: raw.arms.filter((arm) => arm.status === 'EXCLUDED').length,
    units: raw.units.length
  };
  const base = {
    schemaVersion: 2,
    benchmarkVersion: '1.1',
    mode: raw.mode,
    runId: raw.runId,
    status: raw.status,
    zeroResult: structuredClone(raw.zeroResult),
    counts,
    armStatuses: raw.arms.map((arm) => ({
      armId: arm.armId,
      status: arm.status,
      applicability: structuredClone(arm.applicability)
    }))
  };
  if (raw.mode === 'ACCEPTANCE') return base;

  const armResults = raw.arms
    .filter((arm) => arm.status === 'MEASURED')
    .map((arm) => summarizeV11Arm(arm, raw, preregistration))
    .filter((result) => result !== null);
  counts.measuredCompleteArms = armResults.length;
  const rankEligibleArms = armResults.map((result) => result.armId);
  const candidate = bestCandidate(armResults, preregistration);
  return {
    ...base,
    rankEligibleArms,
    armResults,
    bestClaimAllowed: candidate !== null,
    allowedMarketingText: candidate
      ? `${raw.arms.find((arm) => arm.armId === candidate.armId)?.name ?? candidate.armId} was best on the preregistered ShadowGraph warm-lifecycle benchmark under the recorded model, machine, scenarios, and repetitions.`
      : raw.zeroResult !== null
        ? v11ZeroResultText(raw.zeroResult)
        : preregistration.marketingThresholds.measuredOnlyText
  };
}

export function aggregateRun(raw, preregistration, options) {
  return raw?.schemaVersion === 2
    ? aggregateV11Run(raw, preregistration, options)
    : aggregateLegacyRun(raw, preregistration);
}
