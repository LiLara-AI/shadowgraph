import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const amendmentPath = fileURLToPath(new URL('../benchmark/preregistration-amendment-009.json', import.meta.url));
const sidecarPath = fileURLToPath(new URL('../benchmark/preregistration-amendment-009.sha256', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const ARMS = [
  'no-memory', 'shadowgraph-full', 'shadowgraph-compact', 'mem0-oss',
  'graphiti', 'basic-memory', 'cognee'
];
const SCENARIOS = [
  'S01_DATABASE', 'S02_DEPLOYMENT', 'S03_CACHING', 'S04_API_ERRORS',
  'S05_MIGRATION', 'S06_AUTH', 'S07_TESTING', 'S08_PERFORMANCE',
  'S09_CHANGED_CONSTRAINT', 'S10_RELEASE_BACKUP'
];
const PHASES = [
  'RESET', 'A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1',
  'D_FALSE_2', 'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'
];

test('Amendment 009 authorizes exactly the prospective 10x3 final profile and authenticates its bytes', async () => {
  const [bytes, sidecar] = await Promise.all([readFile(amendmentPath), readFile(sidecarPath, 'utf8')]);
  const digest = sha256(bytes);
  const amendment = JSON.parse(bytes);

  assert.equal(sidecar, `${digest}  benchmark/preregistration-amendment-009.json\n`);
  assert.equal(amendment.schemaVersion, 1);
  assert.equal(amendment.amendmentId, 'amendment-009');
  assert.equal(amendment.status, 'AUTHORIZED_FOR_NON_SCORED_ACCEPTANCE_AND_FINAL_SCORED_V1_1');
  assert.deepEqual(amendment.supersedes, {
    amendment008File: 'benchmark/preregistration-amendment-008.json',
    amendment008Sha256: '184ba096d3b3d762f96e37c9a594925dd22e9628b9649a89d4a0a0c8fdff5ff9',
    preregistrationFile: 'benchmark/preregistration.json',
    preregistrationSha256: '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac'
  });
  assert.equal(amendment.reason.validComparativeResultObserved, false);
  assert.equal(amendment.reason.acceptance005Rescored, false);
  assert.equal(amendment.retrospectiveEffect.rewriteHistoricalArtifacts, false);
  assert.equal(amendment.retrospectiveEffect.rescoreExistingRuns, false);
  assert.equal(amendment.retrospectiveEffect.resumeHistoricalRuns, false);

  const acceptance = amendment.executionProfiles.acceptance;
  assert.equal(acceptance.scored, false);
  assert.equal(acceptance.amendment009Bound, true);
  assert.equal(acceptance.sourceHashCount, 9);
  assert.equal(acceptance.scenarioCount, 2);
  assert.equal(acceptance.repetitions, 2);
  assert.deepEqual(acceptance.seeds, [1729, 2718]);
  assert.deepEqual(acceptance.expectedCounts, {
    totalUnits: 308,
    excludedUnits: 20,
    applicableUnits: 288,
    resetUnits: 28,
    outerDecisionCalls: 260
  });

  const scored = amendment.executionProfiles.scored;
  assert.equal(scored.scored, true);
  assert.equal(scored.scenarioSource, 'benchmark/preregistration.json#scenarios');
  assert.deepEqual(scored.scenarioIds, SCENARIOS);
  assert.deepEqual(scored.armIds, ARMS);
  assert.deepEqual(scored.phases, PHASES);
  assert.equal(scored.repetitions, 3);
  assert.deepEqual(scored.seeds, [1729, 2718, 31415]);
  assert.deepEqual(scored.expectedCounts, {
    totalUnits: 2310,
    excludedUnits: 150,
    applicableUnits: 2160,
    resetUnits: 210,
    outerDecisionCalls: 1950
  });
  assert.equal(scored.rawBindsAcceptanceEligibilitySha256, true);

  const corrections = amendment.prospectiveCorrections;
  assert.deepEqual(corrections.phaseE.operationSlots.persist, ['setupPersist', 'persist']);
  assert.deepEqual(corrections.phaseE.operationSlots.verify, ['setupVerify', 'verify']);
  assert.equal(corrections.changedFact.nullDfalseStatus, 'FAILED');
  assert.equal(corrections.changedFact.nullCountsAsNegative, false);
  assert.equal(corrections.isolation.alternateNamespaceResetBeforeRetrieve, true);
  assert.equal(corrections.graphiti.minimumNeo4jVersion, '5.26.0');
  assert.equal(corrections.graphiti.nativeProjectScope, 'group_id property in one neo4j database');
  assert.equal(corrections.graphiti.embeddingMayBeZeroAfterValidExtraction, true);
  assert.equal(corrections.graphiti.boltReachableRequired, true);
  assert.equal(corrections.graphiti.authenticationDisabledRequired, true);
  assert.equal(corrections.graphiti.liveServiceAttestationRequired, true);
  assert.equal(corrections.decisionRecall.scoringRuleChanged, true);
  assert.equal(corrections.decisionRecall.requiredDecisionId, 'EXACT_PHASE_A_PERSISTED_RECORD_ID');
  assert.deepEqual(corrections.timeouts, {
    providerRequestTimeoutMs: 120000,
    adapterOperationTimeoutMs: 300000,
    unitTimeoutMs: 600000,
    heartbeatIntervalMs: 30000
  });

  const retry = amendment.nativeAttemptPolicy;
  assert.equal(retry.maxAttemptsPerRootRequestClass, 24);
  assert.equal(retry.freshPinnedLoopbackEvidenceRequired, true);
  assert.deepEqual(retry.arms.find(({ armId }) => armId === 'graphiti').recovery.internal_memory_llm, ['B']);
  assert.deepEqual(retry.arms.find(({ armId }) => armId === 'cognee').recovery.internal_memory_llm, ['B', 'C']);
  assert.deepEqual(retry.arms.find(({ armId }) => armId === 'cognee').recovery.embedding, ['B']);

  assert.deepEqual(amendment.uncertainty, {
    confidenceLevel: 0.95,
    method: 'scenario-cluster percentile bootstrap',
    clusters: 'ten scenario ids; retain all three repetitions within each resampled scenario',
    replicates: 10000,
    rng: 'mulberry32',
    seed: 20260912,
    intervalQuantiles: [0.025, 0.975],
    quantileEstimator: 'R7_LINEAR_INTERPOLATION',
    resampleTraversalOrder: 'REPLICATE_THEN_SCENARIO_DRAW_THEN_REPETITION',
    insufficientRule: 'no interval unless both arms have all ten paired scenario clusters for the metric',
    tieRule: 'frozen point-estimate thresholds; intervals are descriptive and do not change tie classification'
  });

  assert.deepEqual(amendment.cumulativeProgramBudget.ceilings, {
    sessions: 16,
    outer_decision_llm: 2730,
    internal_memory_llm: 2738,
    embedding: 10801,
    totalRequests: 16269
  });
  assert.equal(amendment.cumulativeProgramBudget.refunds, false);
  assert.equal(amendment.cumulativeProgramBudget.transfers, false);
  assert.equal(amendment.cumulativeProgramBudget.scoredSessions, 1);
  assert.equal(amendment.cumulativeProgramBudget.programLineageId, 'shadowgraph-v11-final-program');
  assert.equal(amendment.cumulativeProgramBudget.continuityRegistryAnchoredByGenesis, true);
  assert.deepEqual(amendment.cumulativeProgramBudget.sessionLimits, {
    probe: 12,
    acceptance: 3,
    scored: 1
  });
  assert.equal(amendment.cumulativeProgramBudget.absoluteDeadline, '2026-09-25T23:37:31.000Z');
  assert.deepEqual(amendment.scoredAcceptanceGate, {
    required: true,
    amendment009Bound: true,
    exactImplementationLockRequired: true,
    rawValidationStatus: 'VALID',
    providerReconciliationStatus: 'RECONCILED',
    applicableFailedUnits: 0,
    replacementAcceptanceAllowed: false,
    moduleTrustedCapabilityRequired: true,
    artifactRevalidationRequired: true
  });
  assert.deepEqual(amendment.reporting.providerEvidence, {
    sanitizedEventsIncluded: true,
    providerAttemptPlanCampaignLedgerHashesRequired: true,
    standaloneConsumersRecomputeReconciliation: true
  });
});
