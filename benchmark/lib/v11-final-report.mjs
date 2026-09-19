import { validateV11ProviderReconciliationGate } from './aggregate.mjs';
import { isolationInspectionFrom, scoreScenario } from './scoring.mjs';

const SHADOWGRAPH_ARMS = Object.freeze(['shadowgraph-full', 'shadowgraph-compact']);
const DECISION_PHASES = Object.freeze([
  'A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2', 'E',
  'ISOLATION_PROJECT', 'ISOLATION_USER'
]);
const METRIC_NAMES = Object.freeze([
  'decisionRetrievalAccuracy', 'rejectedAlternativeRecall', 'rejectionReasonRecall',
  'assumptionRecall', 'evidenceRecall', 'persistenceAcrossRestart',
  'changedFactDetection', 'falsePositiveRate', 'dFalseNullMissingRate',
  'failedAttemptAvoidance', 'failedAttemptReasonCitation',
  'projectIsolation', 'userIsolation', 'fixedDecisionQuality'
]);
const QUALITY_THRESHOLD = 0.1;
const DISCRETE_THRESHOLD = 0.005;
const ECONOMIC_THRESHOLD = 0.05;

function mean(values) {
  return values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function unitDurationMs(unit) {
  const start = Date.parse(unit?.startedAt);
  const finish = Date.parse(unit?.finishedAt);
  return Number.isFinite(start) && Number.isFinite(finish) && finish >= start ? finish - start : null;
}

function totalTokens(usage) {
  if (Number.isFinite(usage?.total_tokens)) return usage.total_tokens;
  if (Number.isFinite(usage?.totalTokens)) return usage.totalTokens;
  return null;
}

function intersectionCount(actual, expected) {
  const expectedSet = new Set(expected ?? []);
  return [...new Set(actual ?? [])].filter((value) => expectedSet.has(value)).length;
}

function isolationInspection(unit) {
  return isolationInspectionFrom(unit?.adapterEvidence?.verify?.isolationEvidence);
}

function lifecycleFrom(units) {
  const byPhase = new Map(units.map((unit) => [unit.phase, unit]));
  const phaseA = byPhase.get('A');
  return {
    A: phaseA?.decisionResponse == null ? phaseA?.decisionResponse : {
      ...phaseA.decisionResponse,
      persistedDecisionId: phaseA.adapterEvidence?.verify?.persistenceEvidence?.expectedRecord?.id ?? null
    },
    B: byPhase.get('B')?.decisionResponse,
    C: byPhase.get('C')?.decisionResponse,
    D_TRUE: byPhase.get('D_TRUE')?.decisionResponse,
    D_FALSE: [0, 1, 2].map((index) => byPhase.get(`D_FALSE_${index}`)?.decisionResponse),
    E: byPhase.get('E')?.decisionResponse,
    ISOLATION_PROJECT: {
      response: byPhase.get('ISOLATION_PROJECT')?.decisionResponse,
      inspection: isolationInspection(byPhase.get('ISOLATION_PROJECT'))
    },
    ISOLATION_USER: {
      response: byPhase.get('ISOLATION_USER')?.decisionResponse,
      inspection: isolationInspection(byPhase.get('ISOLATION_USER'))
    }
  };
}

function lifecycleMetrics(scenario, units, applicability) {
  const lifecycle = lifecycleFrom(units);
  const phaseA = units.find(({ phase }) => phase === 'A');
  const scoring = scoreScenario(scenario, lifecycle, {
    applicability,
    persistenceMeasured: phaseA?.adapterEvidence?.verify?.persistenceEvidence?.verified === true
  });
  const scored = scoring.metrics;
  const falsePredictions = lifecycle.D_FALSE.filter((response) => response?.changedFactDetected === true).length;
  const invalidFalsePredictions = lifecycle.D_FALSE.filter((response) => typeof response?.changedFactDetected !== 'boolean').length;
  const persisted = lifecycle.A?.persistedDecisionId;
  const phaseB = lifecycle.B;
  const phaseE = lifecycle.E;
  const alternativeIds = scenario.alternatives.map(({ id }) => id);
  const rejectionReasonIds = scenario.alternatives.map(({ reasonId }) => reasonId);
  const evidenceIds = scenario.evidence.map(({ id }) => id);
  return {
    values: {
      decisionRetrievalAccuracy: scored.decisionRetrievalAccuracy,
      rejectedAlternativeRecall: scored.rejectedAlternativeRecall,
      rejectionReasonRecall: scored.rejectionReasonRecall,
      assumptionRecall: intersectionCount(phaseB?.assumptionIds, scenario.assumptionIds) / scenario.assumptionIds.length,
      evidenceRecall: intersectionCount(phaseB?.evidenceIds, evidenceIds) / evidenceIds.length,
      persistenceAcrossRestart: typeof persisted === 'string' && persisted.length > 0 ? 1 : 0,
      changedFactDetection: scored.changedFactDetection,
      falsePositiveRate: falsePredictions / 3,
      dFalseNullMissingRate: invalidFalsePredictions / 3,
      failedAttemptAvoidance: scored.failedAttemptAvoidance,
      failedAttemptReasonCitation: phaseE?.failedAttemptReasonIdsCited?.includes(scenario.failedAttempt.reasonId) ? 1 : 0,
      projectIsolation: scored.projectIsolation,
      userIsolation: scored.userIsolation,
      fixedDecisionQuality: scoring.quality.total
    },
    counts: {
      decisionRetrievalAccuracy: [scored.decisionRetrievalAccuracy, 1],
      rejectedAlternativeRecall: [intersectionCount(phaseB?.rejectedAlternativeIds, alternativeIds), alternativeIds.length],
      rejectionReasonRecall: [intersectionCount(phaseB?.rejectionReasonIds, rejectionReasonIds), rejectionReasonIds.length],
      assumptionRecall: [intersectionCount(phaseB?.assumptionIds, scenario.assumptionIds), scenario.assumptionIds.length],
      evidenceRecall: [intersectionCount(phaseB?.evidenceIds, evidenceIds), evidenceIds.length],
      persistenceAcrossRestart: [typeof persisted === 'string' && persisted.length > 0 ? 1 : 0, 1],
      changedFactDetection: [scored.changedFactDetection, 1],
      falsePositiveRate: [falsePredictions, 3],
      dFalseNullMissingRate: [invalidFalsePredictions, 3],
      failedAttemptAvoidance: [scored.failedAttemptAvoidance, 1],
      failedAttemptReasonCitation: [phaseE?.failedAttemptReasonIdsCited?.includes(scenario.failedAttempt.reasonId) ? 1 : 0, 1],
      projectIsolation: [scored.projectIsolation, 1],
      userIsolation: scored.userIsolation === null ? null : [scored.userIsolation, 1],
      fixedDecisionQuality: [scoring.quality.total, 1]
    },
    quality: scoring.quality.criteria
  };
}

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function percentileType7(sorted, probability) {
  if (sorted.length === 0) return null;
  const h = (sorted.length - 1) * probability;
  const lower = Math.floor(h);
  const upper = Math.ceil(h);
  const weight = h - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function clusteredDifferenceInterval(left, right, bootstrap) {
  const rightByKey = new Map(right.map((sample) => [`${sample.scenarioId}\u0000${sample.repetition}`, sample.value]));
  const paired = left
    .filter((sample) => rightByKey.has(`${sample.scenarioId}\u0000${sample.repetition}`))
    .map((sample) => ({
      scenarioId: sample.scenarioId,
      repetition: sample.repetition,
      difference: sample.value - rightByKey.get(`${sample.scenarioId}\u0000${sample.repetition}`)
    }));
  const scenarioIds = [...new Set(paired.map(({ scenarioId }) => scenarioId))].sort();
  const completePairs = paired.length === 30
    && scenarioIds.length === 10
    && scenarioIds.every((scenarioId) => paired.filter((row) => row.scenarioId === scenarioId).length === 3);
  if (!completePairs) return { interval: null, pairedCount: paired.length, scenarioCount: scenarioIds.length };
  const byScenario = new Map(scenarioIds.map((scenarioId) => [
    scenarioId,
    mean(paired.filter((row) => row.scenarioId === scenarioId).map(({ difference }) => difference))
  ]));
  const random = seededRandom(bootstrap.seed);
  const replicates = [];
  for (let index = 0; index < bootstrap.replicates; index += 1) {
    let sum = 0;
    for (let draw = 0; draw < scenarioIds.length; draw += 1) {
      sum += byScenario.get(scenarioIds[Math.floor(random() * scenarioIds.length)]);
    }
    replicates.push(sum / scenarioIds.length);
  }
  replicates.sort((a, b) => a - b);
  return {
    interval: [percentileType7(replicates, 0.025), percentileType7(replicates, 0.975)],
    pairedCount: paired.length,
    scenarioCount: scenarioIds.length
  };
}

function comparisonClass(metric, left, right) {
  if (metric === 'lifecycleLatencyMs' || metric === 'totalLifecycleTokens') {
    const denominator = Math.max(Math.abs(left), Math.abs(right));
    if (denominator === 0 || Math.abs(left - right) / denominator < ECONOMIC_THRESHOLD) return 'TIE';
    return left < right ? 'SHADOWGRAPH_WINS' : 'SHADOWGRAPH_LOSES';
  }
  const threshold = metric === 'fixedDecisionQuality' ? QUALITY_THRESHOLD : DISCRETE_THRESHOLD;
  if (Math.abs(left - right) < threshold) return 'TIE';
  const lowerIsBetter = ['falsePositiveRate', 'dFalseNullMissingRate'].includes(metric);
  return (lowerIsBetter ? left < right : left > right) ? 'SHADOWGRAPH_WINS' : 'SHADOWGRAPH_LOSES';
}

function providerEconomics(raw, events, armId, lifecycleKeys) {
  const armEvents = (Array.isArray(events) ? events : []).filter((event) => event.correlation?.armId === armId);
  const arm = raw.arms.find((entry) => entry.armId === armId);
  const completeUsage = arm?.status === 'MEASURED' && armEvents.length > 0
    && armEvents.every((event) => totalTokens(event.usage) !== null);
  const eventTokens = completeUsage ? armEvents.reduce((sum, event) => sum + totalTokens(event.usage), 0) : null;
  const decisionUnits = raw.units.filter((unit) => unit.armId === armId && DECISION_PHASES.includes(unit.phase) && unit.status === 'MEASURED');
  const operationFields = [
    'mcpToolCalls', 'memoryReadOperations', 'memoryWriteOperations',
    'persistenceVerificationOperations', 'internalMemoryModelCalls',
    'embeddingCalls', 'outerDecisionModelCalls'
  ];
  const operationBreakdown = Object.fromEntries(operationFields.map((field) => [field, 0]));
  for (const unit of raw.units.filter((entry) => entry.armId === armId)) {
    for (const evidence of Object.values(unit.adapterEvidence ?? {})) {
      for (const field of operationFields) operationBreakdown[field] += evidence?.operations?.[field] ?? 0;
    }
  }
  const byLifecycle = new Map(lifecycleKeys.map((key) => [key, 0]));
  const seenLifecycles = new Set();
  let lifecycleUsageComplete = completeUsage;
  for (const event of armEvents) {
    const correlation = event.correlation;
    const key = `${correlation?.scenarioId}\u0000${correlation?.repetition}`;
    const tokens = totalTokens(event.usage);
    if (!byLifecycle.has(key) || tokens === null) lifecycleUsageComplete = false;
    else {
      byLifecycle.set(key, byLifecycle.get(key) + tokens);
      seenLifecycles.add(key);
    }
  }
  lifecycleUsageComplete = lifecycleUsageComplete && seenLifecycles.size === lifecycleKeys.length;
  const tokenSamples = lifecycleUsageComplete
    ? [...byLifecycle.entries()].map(([key, value]) => {
        const [scenarioId, repetition] = key.split('\u0000');
        return { scenarioId, repetition: Number(repetition), value };
      })
    : [];
  return {
    armId,
    validUsageEventCount: completeUsage ? armEvents.length : armEvents.filter((event) => totalTokens(event.usage) !== null).length,
    providerEventCount: armEvents.length,
    missingUsageEventCount: armEvents.filter((event) => totalTokens(event.usage) === null).length,
    totalLifecycleTokens: eventTokens,
    meanLifecycleTokens: eventTokens === null ? null : eventTokens / lifecycleKeys.length,
    meanDecisionUnitLatencyMs: mean(decisionUnits.map(unitDurationMs).filter(Number.isFinite)),
    meanProviderAttemptLatencyMs: mean(armEvents.map(({ latencyMs }) => latencyMs).filter(Number.isFinite)),
    internalMemoryLlmCalls: armEvents.filter(({ requestClass }) => requestClass === 'internal_memory_llm').length,
    embeddingCalls: armEvents.filter(({ requestClass }) => requestClass === 'embedding').length,
    outerDecisionLlmCalls: armEvents.filter(({ requestClass }) => requestClass === 'outer_decision_llm').length,
    operationBreakdown,
    storageStatus: arm?.storage?.status ?? null,
    attributableStorageBytes: Number.isFinite(arm?.storage?.bytes) ? arm.storage.bytes : null,
    providerCostUsd: completeUsage ? 0 : null,
    providerCostBasis: completeUsage ? 'local-free' : 'unavailable-incomplete-usage',
    hardwareEnergyCost: null,
    tokenSamples
  };
}

export function buildV11FinalReport({ raw, aggregate, providerReconciliation, scenarios, amendment }) {
  validateV11ProviderReconciliationGate(raw, providerReconciliation);
  if (raw.mode !== 'SCORED' || aggregate?.mode !== 'SCORED'
    || raw.runId !== aggregate.runId
    || amendment?.uncertainty?.method !== 'scenario-cluster percentile bootstrap'
    || amendment?.uncertainty?.replicates !== 10000
    || amendment?.uncertainty?.seed !== 20260912
    || amendment?.uncertainty?.quantileEstimator !== 'R7_LINEAR_INTERPOLATION'
    || amendment?.uncertainty?.resampleTraversalOrder !== 'REPLICATE_THEN_SCENARIO_DRAW_THEN_REPETITION') {
    throw new Error('Final report inputs do not match Amendment 009');
  }
  const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  if (scenarioById.size !== 10) throw new Error('Final report requires the ten frozen scenarios');
  const samplesByArm = new Map();
  const quality = [];
  const metrics = [];
  const validity = raw.arms.map((arm) => ({
    armId: arm.armId,
    executionStatus: arm.status,
    comparabilityStatus: arm.status === 'MEASURED' ? 'VALIDLY_COMPARABLE' : 'NOT_VALIDLY_COMPARABLE',
    measuredUnits: raw.units.filter((unit) => unit.armId === arm.armId && unit.status === 'MEASURED').length,
    failedUnits: raw.units.filter((unit) => unit.armId === arm.armId && unit.status === 'FAILED').length,
    excludedUnits: raw.units.filter((unit) => unit.armId === arm.armId && unit.status === 'EXCLUDED').length,
    applicability: structuredClone(arm.applicability)
  }));
  const validArms = new Set(validity.filter(({ comparabilityStatus }) => comparabilityStatus === 'VALIDLY_COMPARABLE').map(({ armId }) => armId));

  for (const arm of raw.arms.filter(({ armId }) => validArms.has(armId))) {
    const samples = {};
    const qualitySamples = {};
    const counts = {};
    for (const scenario of scenarios) {
      for (let repetition = 0; repetition < 3; repetition += 1) {
        const units = raw.units.filter((unit) => unit.armId === arm.armId
          && unit.scenarioId === scenario.id && unit.repetition === repetition);
        const measuredPhases = new Map(units.map((unit) => [unit.phase, unit.status]));
        const complete = DECISION_PHASES.every((phase) => (
          phase === 'ISOLATION_USER' && arm.applicability.userIsolation.status === 'NOT_APPLICABLE'
            ? measuredPhases.get(phase) === 'EXCLUDED'
            : measuredPhases.get(phase) === 'MEASURED'
        ));
        if (!complete) continue;
        const scored = lifecycleMetrics(scenario, units, arm.applicability);
        for (const [metric, value] of Object.entries(scored.values)) {
          if (value === null || !Number.isFinite(value)) continue;
          (samples[metric] ??= []).push({ scenarioId: scenario.id, repetition, value });
          const pair = scored.counts[metric];
          if (pair !== null) {
            counts[metric] ??= [0, 0];
            counts[metric][0] += pair[0];
            counts[metric][1] += pair[1];
          }
        }
        for (const [criterion, value] of Object.entries(scored.quality)) {
          (qualitySamples[criterion] ??= []).push(value);
        }
      }
    }
    samplesByArm.set(arm.armId, samples);
    for (const [metric, metricSamples] of Object.entries(samples)) {
      const [numerator, denominator] = counts[metric];
      metrics.push({
        armId: arm.armId,
        metric,
        numerator,
        denominator,
        validSampleCount: metricSamples.length,
        excludedCount: raw.units.filter((unit) => unit.armId === arm.armId && unit.status === 'EXCLUDED').length,
        failedCount: 0,
        pointEstimate: numerator / denominator
      });
    }
    quality.push({
      armId: arm.armId,
      comparabilityStatus: 'VALIDLY_COMPARABLE',
      validSampleCount: 30,
      excludedCount: raw.units.filter((unit) => unit.armId === arm.armId && unit.status === 'EXCLUDED').length,
      failedCount: 0,
      criteria: Object.fromEntries(Object.entries(qualitySamples).map(([criterion, values]) => [criterion, {
        numerator: values.reduce((sum, value) => sum + value, 0),
        denominator: values.length,
        meanScore: mean(values)
      }]))
    });
  }
  for (const arm of raw.arms.filter(({ armId }) => !validArms.has(armId))) {
    const excludedCount = raw.units.filter((unit) => unit.armId === arm.armId && unit.status === 'EXCLUDED').length;
    const failedCount = raw.units.filter((unit) => unit.armId === arm.armId && unit.status === 'FAILED').length;
    for (const metric of METRIC_NAMES) {
      metrics.push({ armId: arm.armId, metric, numerator: null, denominator: null,
        validSampleCount: 0, excludedCount, failedCount, pointEstimate: null });
    }
    quality.push({ armId: arm.armId, comparabilityStatus: 'NOT_VALIDLY_COMPARABLE',
      validSampleCount: 0, excludedCount, failedCount, criteria: null });
  }

  const lifecycleKeys = scenarios.flatMap((scenario) => [0, 1, 2].map((repetition) => `${scenario.id}\u0000${repetition}`));
  const economics = raw.arms.map((arm) => providerEconomics(raw, providerReconciliation.events, arm.armId, lifecycleKeys));
  for (const row of economics.filter(({ armId }) => validArms.has(armId))) {
    const unitsByLifecycle = lifecycleKeys.map((key) => {
      const [scenarioId, repetition] = key.split('\u0000');
      return {
        scenarioId,
        repetition: Number(repetition),
        value: raw.units.filter((unit) => unit.armId === row.armId
          && unit.scenarioId === scenarioId && unit.repetition === Number(repetition)
          && unit.status === 'MEASURED').reduce((sum, unit) => sum + (unitDurationMs(unit) ?? 0), 0)
      };
    });
    const samples = samplesByArm.get(row.armId);
    samples.lifecycleLatencyMs = unitsByLifecycle;
    if (row.tokenSamples.length === lifecycleKeys.length) samples.totalLifecycleTokens = row.tokenSamples;
  }

  const bootstrap = amendment.uncertainty;
  const pairwise = [];
  const comparisonMetrics = [...METRIC_NAMES, 'lifecycleLatencyMs', 'totalLifecycleTokens'];
  for (const shadowGraphArmId of SHADOWGRAPH_ARMS) {
    for (const comparatorArmId of raw.arms.map(({ armId }) => armId).filter((armId) => armId !== shadowGraphArmId)) {
      const left = samplesByArm.get(shadowGraphArmId) ?? {};
      const right = samplesByArm.get(comparatorArmId) ?? {};
      for (const metric of comparisonMetrics) {
        const leftSamples = left[metric];
        const rightSamples = right[metric];
        const armComparable = validArms.has(shadowGraphArmId) && validArms.has(comparatorArmId);
        const interval = armComparable && Array.isArray(leftSamples) && Array.isArray(rightSamples)
          ? clusteredDifferenceInterval(leftSamples, rightSamples, bootstrap)
          : { interval: null, pairedCount: 0, scenarioCount: 0 };
        const comparable = armComparable && interval.interval !== null;
        const leftEstimate = comparable ? mean(leftSamples.map(({ value }) => value)) : null;
        const comparatorEstimate = comparable ? mean(rightSamples.map(({ value }) => value)) : null;
        pairwise.push({
          candidate: shadowGraphArmId,
          comparator: comparatorArmId,
          metric,
          comparabilityStatus: comparable ? 'VALIDLY_COMPARABLE' : 'NOT_VALIDLY_COMPARABLE',
          candidateEstimate: leftEstimate,
          comparatorEstimate,
          absoluteDifference: comparable ? leftEstimate - comparatorEstimate : null,
          percentageDifference: comparable && comparatorEstimate !== 0
            ? 100 * (leftEstimate - comparatorEstimate) / Math.abs(comparatorEstimate) : null,
          validPairedSampleCount: interval.pairedCount,
          scenarioCount: interval.scenarioCount,
          confidenceInterval: interval.interval,
          tieClassification: comparable ? comparisonClass(metric, leftEstimate, comparatorEstimate) : null
        });
      }
    }
  }
  const fullCompactRows = pairwise.filter((row) => row.candidate === 'shadowgraph-full'
    && row.comparator === 'shadowgraph-compact');
  const functionalRows = fullCompactRows.filter((row) => METRIC_NAMES.includes(row.metric)
    && row.metric !== 'userIsolation' && row.comparabilityStatus === 'VALIDLY_COMPARABLE');
  const fullCompactEquivalence = {
    comparabilityStatus: validArms.has('shadowgraph-full') && validArms.has('shadowgraph-compact')
      ? 'VALIDLY_COMPARABLE' : 'NOT_VALIDLY_COMPARABLE',
    functionallyEquivalent: functionalRows.length === METRIC_NAMES.length - 1
      && functionalRows.every((row) => row.tieClassification === 'TIE'),
    functionalMetricCount: functionalRows.length,
    jointlyUnavailableMetrics: fullCompactRows.filter((row) => METRIC_NAMES.includes(row.metric)
      && row.comparabilityStatus !== 'VALIDLY_COMPARABLE').map(({ metric }) => metric),
    economicRows: fullCompactRows.filter((row) => ['lifecycleLatencyMs', 'totalLifecycleTokens'].includes(row.metric))
  };

  return {
    schema: 'shadowgraph.v11.final-benchmark-report',
    version: 1,
    runId: raw.runId,
    attemptId: raw.attemptId,
    methodology: {
      amendment009Sha256: raw.amendment009Sha256,
      scenarios: 10,
      repetitions: 3,
      bootstrap: {
        method: bootstrap.method,
        replicates: bootstrap.replicates,
        seed: bootstrap.seed,
        confidenceLevel: bootstrap.confidenceLevel,
        quantileEstimator: bootstrap.quantileEstimator,
        traversalOrder: bootstrap.resampleTraversalOrder
      }
    },
    validity,
    metrics,
    quality,
    economics: economics.map(({ tokenSamples, ...row }) => row),
    pairwise,
    fullCompactEquivalence,
    failures: raw.units.filter(({ status }) => status === 'FAILED').map((unit) => ({
      unitId: unit.unitId,
      armId: unit.armId,
      scenarioId: unit.scenarioId,
      repetition: unit.repetition,
      phase: unit.phase,
      cause: unit.failure?.cause ?? null,
      operation: unit.failure?.operation ?? null,
      message: unit.failure?.message ?? null
    })),
    unsupportedClaims: [
      'Causal product-improvement claims beyond this randomized arm order and fixed scenario design',
      'Cloud-provider price equivalence or hardware-energy cost',
      'User isolation for arms whose preregistered applicability is NOT_APPLICABLE',
      'A seven-arm winner when any arm is not validly comparable',
      'Generalization beyond the ten frozen scenarios and pinned local models/runtimes'
    ],
    bestClaimAllowed: aggregate.bestClaimAllowed === true && validity.every(({ comparabilityStatus }) => comparabilityStatus === 'VALIDLY_COMPARABLE')
  };
}
