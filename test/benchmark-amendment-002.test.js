import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

test('frozen preregistration hash remains unchanged', async () => {
  const content = await readFile('benchmark/preregistration.json', 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  assert.equal(
    hash,
    '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac',
    'Original frozen preregistration.json hash must never change'
  );
});

test('Amendment 001 exists byte-identically with correct hash', async () => {
  const content = await readFile('benchmark/preregistration-amendment-001.json', 'utf8');
  const hash = createHash('sha256').update(content).digest('hex');
  assert.equal(
    hash,
    '2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a',
    'Amendment 001 must be byte-identical to frozen version'
  );

  const sidecar = await readFile('benchmark/preregistration-amendment-001.sha256', 'utf8');
  assert.match(sidecar, /^2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a/);
});

test('Amendment 002 exists with valid structure and sidecar', async () => {
  const content = await readFile('benchmark/preregistration-amendment-002.json', 'utf8');
  const amendment = JSON.parse(content);

  // Must be PROPOSED status
  assert.equal(amendment.status, 'PROPOSED_NOT_AUTHORIZED_FOR_SCORED_RUN');
  assert.equal(amendment.amendmentId, 'amendment-002');
  assert.equal(amendment.amendmentVersion, '1.1.0');

  // Must reference original preregistration and Amendment 001
  assert.equal(
    amendment.supersedes.preregistrationSha256,
    '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac'
  );
  assert.equal(
    amendment.supersedes.amendment001Sha256,
    '2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a'
  );

  // Must define all four unit statuses
  assert.ok(amendment.definitions.unitStatuses);
  assert.ok(amendment.definitions.unitStatuses.includes('MEASURED'));
  assert.ok(amendment.definitions.unitStatuses.includes('FAILED'));
  assert.ok(amendment.definitions.unitStatuses.includes('NOT_MEASURED'));
  assert.ok(amendment.definitions.unitStatuses.includes('EXCLUDED'));

  // Must define all five arm statuses
  assert.ok(amendment.definitions.armStatuses);
  assert.ok(amendment.definitions.armStatuses.includes('MEASURED'));
  assert.ok(amendment.definitions.armStatuses.includes('PARTIAL_FAILED'));
  assert.ok(amendment.definitions.armStatuses.includes('FAILED'));
  assert.ok(amendment.definitions.armStatuses.includes('NOT_MEASURED'));
  assert.ok(amendment.definitions.armStatuses.includes('EXCLUDED'));

  // Must define mechanical arm status derivation
  assert.ok(amendment.definitions.armStatusDerivation);

  // Must define applicability as harness metadata
  assert.ok(amendment.definitions.applicability);

  // Must define request classes for metering
  assert.ok(amendment.definitions.requestClasses);
  assert.ok(amendment.definitions.requestClasses.includes('outer_decision_llm'));
  assert.ok(amendment.definitions.requestClasses.includes('internal_memory_llm'));
  assert.ok(amendment.definitions.requestClasses.includes('embedding'));

  // Must define exact operation counters
  assert.ok(amendment.definitions.operationMetrics);
  assert.ok(amendment.definitions.operationMetrics.memoryReadOperations !== undefined);
  assert.ok(amendment.definitions.operationMetrics.memoryWriteOperations !== undefined);
  assert.ok(amendment.definitions.operationMetrics.mcpToolCalls !== undefined);

  // Must define storage measurement with null policy
  assert.ok(amendment.definitions.storageMeasurement);

  // Must define actual-cause zero-result reporting
  assert.ok(amendment.definitions.truthfulZeroResult);

  // Must define append-only progress
  assert.ok(amendment.definitions.progress);

  // Must define resume/new-run policy
  assert.ok(amendment.definitions.interruption);

  // Must define integrated runner rule
  assert.ok(amendment.definitions.integratedRunner);

  // Must define implementation lock
  assert.ok(amendment.definitions.implementationLock);

  // Must define adapter boundaries
  assert.ok(amendment.definitions.adapterProtocol);

  // Must define acceptance shape
  assert.ok(amendment.candidateAcceptance);

  // Must define reproducibility fields
  assert.ok(amendment.definitions.reproducibility);

  // Must define byte-identical bundle rule
  assert.ok(amendment.definitions.reviewBundle);

  // F1-F17: Verify resolved methodology choices
  assert.ok(amendment.resolvedMethodologyChoices, 'Must have resolvedMethodologyChoices');

  assert.deepEqual(amendment.resolvedMethodologyChoices.schemaTokenEconomics, {
    status: 'REMOVED_FROM_V1_1',
    advertisedSchemas: 'REPRODUCIBILITY_EVIDENCE_ONLY',
    commonOuterModelPrompt: false,
    claimEnabled: false
  });

  assert.deepEqual(amendment.resolvedMethodologyChoices.notApplicableCapabilityHandling, {
    unitStatus: 'EXCLUDED',
    blockedClaims: 'CAPABILITY_SPECIFIC_ONLY',
    armRankEligibility: 'UNAFFECTED_IF_OTHERWISE_MEASURED',
    supersedesAmendment001: true,
    noSyntheticUserNamespaces: true
  });

  assert.deepEqual(amendment.resolvedMethodologyChoices.measuredOperationRetries, {
    outerModelMaxRetries: 0,
    memoryOperationMaxRetries: 0,
    libraryDefaultRetriesDisabled: true,
    providerRetryAttemptsRecordedAsFailures: true,
    diagnosticRetriesSubstituteMeasuredEvidence: false
  });

  assert.deepEqual(amendment.resolvedMethodologyChoices.diagnosticResume, {
    sameRunId: true,
    requiresIdenticalImplementationEnvironmentLock: true,
    newAttemptId: true,
    runsOnlyNeverStartedUnits: true,
    infrastructureRepairRequiresNewRunId: true
  });

  assert.deepEqual(amendment.resolvedMethodologyChoices.neo4jCogneeStorage, {
    status: 'NOT_AVAILABLE',
    bytes: null,
    exactAttributableScopeRequiredForMeasured: true,
    blockedClaims: 'STORAGE_DEPENDENT_ONLY'
  });

  assert.deepEqual(amendment.resolvedMethodologyChoices.cogneeProviderMode, {
    mode: 'OPENAI_COMPATIBLE_LOCALHOST_THROUGH_METERING_PROXY',
    mixedNativeOllamaAndV1Allowed: false
  });

  assert.deepEqual(amendment.resolvedMethodologyChoices.modelDigestRequirement, {
    llmWeightDigestRequired: true,
    embeddingWeightDigestRequired: true,
    mutableTagSufficient: false,
    containerDigestSufficient: false,
    blocksRealAcceptance: true,
    blocksReadiness: true,
    blocksOfficialExecution: true
  });

  assert.equal(amendment.definitions.armStatusDerivation.excludedUnitRule, 'IGNORE_WHEN_DERIVING_APPLICABLE_ARM_STATUS');
  assert.equal(amendment.definitions.armStatusDerivation.allUnitsExcludedRule, 'EXCLUDED');
  assert.equal(amendment.definitions.applicability.notApplicable.unitStatus, 'EXCLUDED');
  assert.equal(amendment.definitions.applicability.notApplicable.blockedClaims, 'CAPABILITY_SPECIFIC_ONLY');
  assert.equal(amendment.definitions.applicability.notApplicable.armRankEligibility, 'UNAFFECTED_IF_OTHERWISE_MEASURED');
  assert.equal(
    amendment.definitions.applicability.schema.userIsolation.reason,
    'null for SUPPORTED | non-empty string for NOT_APPLICABLE'
  );
  assert.equal(
    amendment.definitions.applicability.schema.persistence.reason,
    'null for SUPPORTED | non-empty string for NOT_APPLICABLE'
  );
  assert.equal(amendment.definitions.centralOuterModel.measuredMaxRetries, 0);
  assert.equal(amendment.definitions.interruption.resume.sameRunId, true);
  assert.equal(amendment.definitions.interruption.resume.requiresIdenticalImplementationEnvironmentLock, true);
  assert.equal(amendment.definitions.interruption.resume.runsOnlyNeverStartedUnits, true);
  assert.equal(amendment.definitions.interruption.infrastructureRepairRequiresNewRunId, true);
  assert.deepEqual(amendment.definitions.adapterProtocol.shadowgraphSpecific.schemaEconomics, {
    claimStatus: 'REMOVED_FROM_V1_1',
    advertisedSchemas: 'REPRODUCIBILITY_EVIDENCE_ONLY',
    includedInCommonOuterModelPrompt: false
  });
  assert.equal(amendment.definitions.reproducibility.missingModelWeightDigestBlocks.realAcceptance, true);
  assert.equal(amendment.definitions.reproducibility.missingModelWeightDigestBlocks.readiness, true);
  assert.equal(amendment.definitions.reproducibility.missingModelWeightDigestBlocks.officialExecution, true);
  assert.equal(amendment.candidateAcceptance.requiresFullModelWeightDigests, true);

  // Verify sidecar exists and contains the hash
  const hash = createHash('sha256').update(content).digest('hex');
  const sidecar = await readFile('benchmark/preregistration-amendment-002.sha256', 'utf8');

  // Exact canonical line match (not prefix)
  const expectedSidecar = `${hash}  benchmark/preregistration-amendment-002.json\n`;
  assert.equal(
    sidecar,
    expectedSidecar,
    'Sidecar must match exact canonical format with two spaces and newline'
  );
});

test('Amendment 002 exposes each F1-F17 contract section', async () => {
  const amendment = JSON.parse(await readFile('benchmark/preregistration-amendment-002.json', 'utf8'));
  const expectedOperationFields = [
    'memoryReadOperations',
    'memoryWriteOperations',
    'mcpToolCalls',
    'outerDecisionModelCalls',
    'internalMemoryModelCalls',
    'embeddingCalls',
    'persistenceVerificationOperations'
  ];

  assert.ok(amendment.definitions.centralOuterModel); // F1
  assert.ok(amendment.definitions.providerMetering); // F2
  assert.ok(amendment.definitions.phaseAGroundTruth); // F3
  assert.deepEqual(amendment.definitions.unitStatuses, ['MEASURED', 'FAILED', 'NOT_MEASURED', 'EXCLUDED']); // F4
  assert.ok(amendment.definitions.applicability); // F5
  assert.equal(amendment.definitions.applicability.noMemoryRules.persistence, 'NOT_APPLICABLE'); // F6
  assert.deepEqual(Object.keys(amendment.definitions.operationMetrics).filter((key) => key !== 'rule'), expectedOperationFields); // F7
  assert.ok(amendment.definitions.storageMeasurement); // F8
  assert.ok(amendment.definitions.progress && amendment.definitions.interruption && amendment.definitions.watchdog); // F9
  assert.ok(amendment.definitions.truthfulZeroResult); // F10
  assert.ok(amendment.definitions.integratedRunner); // F11
  assert.ok(amendment.definitions.implementationLock); // F12
  assert.ok(amendment.definitions.adapterProtocol); // F13
  assert.equal(amendment.candidateAcceptance.scored, false); // F14
  assert.ok(amendment.definitions.reproducibility); // F15
  assert.ok(amendment.definitions.reviewBundle); // F16
  assert.equal(amendment.greenGates.length, 10); // F17
});
