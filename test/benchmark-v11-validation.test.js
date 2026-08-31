import assert from 'node:assert/strict';
import test from 'node:test';

import { aggregateRun } from '../benchmark/lib/aggregate.mjs';
import { validateRawRun } from '../benchmark/lib/validate.mjs';
import * as v11Contract from '../benchmark/lib/v11-contract.mjs';

const TRUSTED_SOURCE_HASHES = Object.freeze({
  preregistrationSha256: '1'.repeat(64),
  amendment001Sha256: '2'.repeat(64),
  amendment002Sha256: '3'.repeat(64)
});
const PREREGISTRATION_SHA = TRUSTED_SOURCE_HASHES.preregistrationSha256;
const RUN_ID = 'run-validation-1';

function aggregationOptions(overrides = {}) {
  return {
    trustedSourceHashes: TRUSTED_SOURCE_HASHES,
    ...overrides
  };
}

const PHASES = [
  'RESET',
  'A',
  'B',
  'C',
  'D_TRUE',
  'D_FALSE_0',
  'D_FALSE_1',
  'D_FALSE_2',
  'E',
  'ISOLATION_PROJECT',
  'ISOLATION_USER'
];

const OPERATION_FIELDS = [
  'memoryReadOperations',
  'memoryWriteOperations',
  'mcpToolCalls',
  'outerDecisionModelCalls',
  'internalMemoryModelCalls',
  'embeddingCalls',
  'persistenceVerificationOperations'
];

function applicability(userIsolation = 'SUPPORTED', persistence = 'SUPPORTED') {
  return {
    userIsolation: {
      status: userIsolation,
      reason: userIsolation === 'SUPPORTED' ? null : 'native user isolation is not applicable'
    },
    persistence: {
      status: persistence,
      reason: persistence === 'SUPPORTED' ? null : 'persistence is not applicable'
    }
  };
}

function scenario() {
  return {
    id: 'ACC_VALIDATION_1',
    projectId: 'project-primary',
    userId: 'user-primary',
    isolationProjectId: 'project-alternate',
    isolationUserId: 'user-alternate',
    task: 'Choose the safe option.',
    choice: { id: 'choice-one', label: 'Choice one' },
    alternatives: [{ id: 'choice-two', label: 'Choice two', reasonId: 'reason-two', reason: 'Less suitable' }],
    constraints: [{ id: 'constraint-one', text: 'Must be safe' }],
    assumptionIds: ['assumption-one'],
    evidence: [{ id: 'evidence-one', text: 'Observed evidence' }],
    riskIds: ['risk-one'],
    reviewTrigger: { id: 'trigger-one', key: 'load', operator: 'greaterThan', value: 10 },
    changedFact: { id: 'changed-one', key: 'load', value: 20 },
    irrelevantFacts: [
      { id: 'irrelevant-one', key: 'colour', value: 'blue' },
      { id: 'irrelevant-two', key: 'format', value: 'json' },
      { id: 'irrelevant-three', key: 'timezone', value: 'UTC' }
    ],
    failedAttempt: {
      id: 'failed-one',
      approachId: 'choice-two',
      reasonId: 'failed-reason-one',
      reason: 'The alternative failed.'
    }
  };
}

function preregistration(arms) {
  return {
    arms: arms.map(({ id, name, applicability: armApplicability }) => ({
      id,
      name,
      applicability: structuredClone(armApplicability)
    })),
    commonExecution: { repetitions: 1, randomSeeds: [17] },
    scenarios: [scenario()],
    marketingThresholds: {
      noResultText: 'No comparative result is available.',
      measuredOnlyText: 'Measured results are available.'
    }
  };
}

function decision(phase) {
  return {
    decisionId: `decision-${phase.toLowerCase()}`,
    choiceId: 'choice-one',
    recalledAlternativeIds: ['choice-two'],
    recalledRejectionReasonIds: ['reason-two'],
    constraintIdsAddressed: ['constraint-one'],
    evidenceIdsCited: ['evidence-one'],
    riskIdsRecognized: ['risk-one'],
    reviewTriggerIds: ['trigger-one'],
    changedFactDetected: phase === 'D_TRUE',
    changedFactId: phase === 'D_TRUE' ? 'changed-one' : null,
    recommendation: `Recommendation for ${phase}`,
    failedAttemptIdsAvoided: phase === 'E' ? ['failed-one'] : [],
    failedAttemptReasonIdsCited: phase === 'E' ? ['failed-reason-one'] : [],
    memoryProjectId: 'project-primary',
    memoryUserId: 'user-primary'
  };
}

function operations(overrides = {}) {
  return Object.fromEntries(OPERATION_FIELDS.map((field) => [field, overrides[field] ?? 0]));
}

function storage() {
  return {
    status: 'MEASURED',
    bytes: 64,
    scope: 'isolated fixture state',
    method: 'recursive byte count',
    reason: null,
    blockedClaims: []
  };
}

function adapterEvidence() {
  return {
    reset: null,
    setupPersist: null,
    setupVerify: null,
    retrieve: null,
    persist: null,
    verify: null
  };
}

function recordedAdapterEvidence({
  arm,
  phase,
  status = 'SUCCEEDED',
  namespace = { projectId: 'project-primary', userId: 'user-primary' },
  nativeContextCount = 0,
  persistenceEvidence = null,
  isolationEvidence = null,
  operationCounts = {}
} = {}) {
  return {
    status,
    namespaceRef: v11Contract.namespaceRefFor({
      runId: RUN_ID,
      armId: arm.id,
      scenarioId: 'ACC_VALIDATION_1',
      repetition: 0,
      phase
    }, namespace),
    nativeContextCount,
    persistenceEvidence,
    isolationEvidence,
    operations: operations(operationCounts),
    storage: storage()
  };
}

function primaryNamespace(arm) {
  return {
    projectId: 'project-primary',
    userId: arm.applicability.userIsolation.status === 'SUPPORTED' ? 'user-primary' : null
  };
}

function alternateNamespace(arm, phase) {
  if (phase === 'ISOLATION_PROJECT') {
    return {
      projectId: 'project-alternate',
      userId: arm.applicability.userIsolation.status === 'SUPPORTED' ? 'user-primary' : null
    };
  }
  if (phase === 'ISOLATION_USER') {
    return { projectId: 'project-primary', userId: 'user-alternate' };
  }
  return null;
}

function retrievalNamespace(arm, phase) {
  return alternateNamespace(arm, phase) ?? primaryNamespace(arm);
}

function persistenceEvidence(arm, phase, expectedRecord) {
  return {
    verified: true,
    expectedRecord,
    matchedRecordIds: [expectedRecord.id],
    observedContentSha256: expectedRecord.contentSha256,
    namespaceRef: v11Contract.namespaceRefFor({
      runId: RUN_ID,
      armId: arm.id,
      scenarioId: 'ACC_VALIDATION_1',
      repetition: 0,
      phase
    }, primaryNamespace(arm))
  };
}

function isolationEvidence(arm, phase) {
  const alternate = alternateNamespace(arm, phase);
  if (alternate !== null) {
    return {
      verified: true,
      expectedAbsentRecord: decisionRecordReference(arm, 'A'),
      alternateNamespaceRef: v11Contract.namespaceRefFor({
        runId: RUN_ID,
        armId: arm.id,
        scenarioId: 'ACC_VALIDATION_1',
        repetition: 0,
        phase
      }, alternate),
      matchingRecordIdCount: 0,
      matchingContentCount: 0
    };
  }
  return null;
}

function decisionRecordReference(arm, phase) {
  return {
    id: v11Contract.decisionRecordId({
      armId: arm.id,
      scenarioId: 'ACC_VALIDATION_1',
      repetition: 0,
      phase
    }),
    type: 'decision',
    contentSha256: v11Contract.recordContentSha256(decision(phase))
  };
}

function testUnitId(armId, phase) {
  const components = [armId, 'ACC_VALIDATION_1', '0', phase];
  return `unit:${components.map((value) => `${value.length}:${value}`).join(':')}`;
}

function expectedNamespaceRef(arm, phase, namespace) {
  return v11Contract.namespaceRefFor({
    runId: RUN_ID,
    armId: arm.id,
    scenarioId: 'ACC_VALIDATION_1',
    repetition: 0,
    phase
  }, namespace);
}

function addOperationCounts(target, counts) {
  for (const [field, value] of Object.entries(counts)) target[field] += value;
}

function unit({ arm, phase, status = 'MEASURED', failure = null }) {
  const isReset = phase === 'RESET';
  const isExcluded = status === 'EXCLUDED';
  const isFailed = status === 'FAILED';
  const evidence = adapterEvidence();
  const operationTotals = operations();
  const persistenceSupported = arm.applicability.persistence.status === 'SUPPORTED';
  const persistenceStatus = persistenceSupported ? 'SUCCEEDED' : 'NOT_APPLICABLE';
  let response = isReset || isExcluded ? null : decision(phase);
  let usage = isReset || isExcluded ? null : { total_tokens: 12 };
  let providerModel = isReset || isExcluded ? null : 'provider-model';

  if (!isExcluded && isReset) {
    evidence.reset = recordedAdapterEvidence({ arm, phase, namespace: primaryNamespace(arm) });
  } else if (!isExcluded) {
    const failureOperation = isFailed ? failure.operation : null;
    const retrieveStatus = failureOperation === 'retrieve' ? 'FAILED' : 'SUCCEEDED';
    evidence.retrieve = recordedAdapterEvidence({
      arm,
      phase,
      status: retrieveStatus,
      namespace: retrievalNamespace(arm, phase),
      nativeContextCount: 0,
      operationCounts: { memoryReadOperations: 1 }
    });
    addOperationCounts(operationTotals, evidence.retrieve.operations);

    if (failureOperation === 'retrieve') {
      response = null;
      usage = null;
      providerModel = null;
    } else {
      operationTotals.outerDecisionModelCalls = 1;
      if (failureOperation === 'outer') {
        response = null;
        usage = null;
        providerModel = null;
      } else {
        if (phase === 'E') {
          const setupPersistStatus = failureOperation === 'setupPersist' ? 'FAILED' : persistenceStatus;
          evidence.setupPersist = recordedAdapterEvidence({
            arm,
            phase,
            status: setupPersistStatus,
            namespace: primaryNamespace(arm),
            operationCounts: persistenceSupported ? { memoryWriteOperations: 1 } : {}
          });
          addOperationCounts(operationTotals, evidence.setupPersist.operations);
          if (failureOperation !== 'setupPersist') {
            const setupVerifyStatus = failureOperation === 'setupVerify' ? 'FAILED' : persistenceStatus;
            evidence.setupVerify = recordedAdapterEvidence({
              arm,
              phase,
              status: setupVerifyStatus,
              namespace: primaryNamespace(arm),
              persistenceEvidence: persistenceSupported && setupVerifyStatus === 'SUCCEEDED'
                ? persistenceEvidence(arm, phase, {
                    id: 'failed-one',
                    type: 'failed_attempt',
                    contentSha256: v11Contract.recordContentSha256(scenario().failedAttempt)
                  })
                : null,
              operationCounts: persistenceSupported ? { persistenceVerificationOperations: 1 } : {}
            });
            addOperationCounts(operationTotals, evidence.setupVerify.operations);
          }
        }

        if (!['setupPersist', 'setupVerify'].includes(failureOperation)) {
          const persistStatus = failureOperation === 'persist' ? 'FAILED' : persistenceStatus;
          evidence.persist = recordedAdapterEvidence({
            arm,
            phase,
            status: persistStatus,
            namespace: primaryNamespace(arm),
            operationCounts: persistenceSupported ? { memoryWriteOperations: 1 } : {}
          });
          addOperationCounts(operationTotals, evidence.persist.operations);
          if (failureOperation !== 'persist') {
            const verifyStatus = failureOperation === 'verify' ? 'FAILED' : persistenceStatus;
            const expectedRecord = decisionRecordReference(arm, phase);
            evidence.verify = recordedAdapterEvidence({
              arm,
              phase,
              status: verifyStatus,
              namespace: primaryNamespace(arm),
              persistenceEvidence: persistenceSupported && verifyStatus === 'SUCCEEDED'
                ? persistenceEvidence(arm, phase, expectedRecord)
                : null,
              isolationEvidence: persistenceSupported && verifyStatus === 'SUCCEEDED'
                ? isolationEvidence(arm, phase)
                : null,
              operationCounts: persistenceSupported ? { persistenceVerificationOperations: 1 } : {}
            });
            addOperationCounts(operationTotals, evidence.verify.operations);
          }
        }
      }
    }
  }
  return {
    schemaVersion: 1,
    unitId: testUnitId(arm.id, phase),
    runId: RUN_ID,
    attemptId: 'attempt-validation-1',
    armId: arm.id,
    scenarioId: 'ACC_VALIDATION_1',
    repetition: 0,
    seed: 17,
    phase,
    status,
    statusReason: isExcluded ? arm.applicability.userIsolation.reason : isFailed ? failure.message : null,
    applicability: structuredClone(arm.applicability),
    startedAt: '2026-08-31T00:00:00.000Z',
    finishedAt: '2026-08-31T00:00:01.000Z',
    latencyMs: isExcluded ? null : 10,
    decisionResponse: response,
    providerUsage: usage,
    providerModel,
    operations: operationTotals,
    storage: isExcluded ? null : storage(),
    adapterEvidence: evidence,
    failure
  };
}

function notMeasuredUnit({ arm, phase }) {
  const result = unit({ arm, phase, status: 'NOT_MEASURED' });
  result.statusReason = 'Unit was not measured';
  result.latencyMs = null;
  result.decisionResponse = null;
  result.providerUsage = null;
  result.providerModel = null;
  result.operations = operations();
  result.storage = null;
  result.adapterEvidence = adapterEvidence();
  return result;
}

function rawRun({ mode = 'SCORED', armDefinitions, mutateUnit = null, zeroResult = null }) {
  const units = [];
  for (const arm of armDefinitions) {
    for (const phase of PHASES) {
      let next;
      if (phase === 'ISOLATION_USER' && arm.applicability.userIsolation.status === 'NOT_APPLICABLE') {
        next = unit({ arm, phase, status: 'EXCLUDED' });
      } else if (mutateUnit) {
        next = mutateUnit({ arm, phase }) ?? unit({ arm, phase });
      } else {
        next = unit({ arm, phase });
      }
      units.push(next);
    }
  }
  const statusByArm = new Map(armDefinitions.map((arm) => {
    const statuses = units.filter((item) => item.armId === arm.id).map((item) => item.status);
    const nonExcluded = statuses.filter((status) => status !== 'EXCLUDED');
    let status;
    if (nonExcluded.length === 0) status = 'EXCLUDED';
    else if (nonExcluded.every((value) => value === 'MEASURED')) status = 'MEASURED';
    else if (nonExcluded.some((value) => value === 'MEASURED')) status = 'PARTIAL_FAILED';
    else if (nonExcluded.some((value) => value === 'FAILED')) status = 'FAILED';
    else status = 'NOT_MEASURED';
    return [arm.id, status];
  }));
  return {
    schemaVersion: 2,
    benchmarkVersion: '1.1',
    mode,
    runId: RUN_ID,
    attemptId: 'attempt-validation-1',
    attemptIds: ['attempt-validation-1'],
    status: 'COMPLETE',
    preregistrationSha256: PREREGISTRATION_SHA,
    amendment001Sha256: '2'.repeat(64),
    amendment002Sha256: '3'.repeat(64),
    implementationLockHash: '4'.repeat(64),
    environmentLockHash: '5'.repeat(64),
    startedAt: '2026-08-31T00:00:00.000Z',
    finishedAt: '2026-08-31T00:01:00.000Z',
    zeroResult,
    arms: armDefinitions.map((arm) => ({
      armId: arm.id,
      name: arm.name,
      status: statusByArm.get(arm.id),
      applicability: structuredClone(arm.applicability)
    })),
    units
  };
}

test('schema v2 aggregation requires trusted source hashes and rejects raw source-hash tampering', () => {
  const arms = [{ id: 'arm-hash-bound', name: 'Hash-bound arm', applicability: applicability() }];
  const raw = rawRun({ armDefinitions: arms });
  const document = preregistration(arms);

  assert.throws(
    () => aggregateRun(raw, document),
    /trusted.*source hashes.*required/iu
  );

  for (const field of [
    'preregistrationSha256',
    'amendment001Sha256',
    'amendment002Sha256'
  ]) {
    const tampered = structuredClone(raw);
    tampered[field] = '9'.repeat(64);
    assert.throws(
      () => aggregateRun(tampered, document, aggregationOptions()),
      new RegExp(`${field}.*trusted`, 'iu'),
      `${field} tampering must be rejected before aggregation`
    );
  }
});

test('schema v2 aggregation rejects every option except trustedSourceHashes before doing work', () => {
  const arms = [{ id: 'arm-options', name: 'Options arm', applicability: applicability() }];
  const raw = rawRun({ armDefinitions: arms });
  const document = preregistration(arms);
  let injectedScorerCalls = 0;

  assert.throws(
    () => aggregateRun(raw, document, {
      ...aggregationOptions(),
      scoreScenarioImpl() {
        injectedScorerCalls += 1;
        return {};
      }
    }),
    /scoreScenarioImpl|unknown.*aggregation option|only trustedSourceHashes/iu
  );
  assert.equal(injectedScorerCalls, 0);
});

test('schema v2 validation retains partial evidence and verifies mechanical arm status with RESET and EXCLUDED units', () => {
  const arms = [
    { id: 'arm-partial', name: 'Partial arm', applicability: applicability() },
    { id: 'arm-na', name: 'N/A arm', applicability: applicability('NOT_APPLICABLE') }
  ];
  const failure = { cause: 'OPERATION_FAILED', operation: 'verify', message: 'Verification failed' };
  const raw = rawRun({
    armDefinitions: arms,
    mutateUnit: ({ arm, phase }) => arm.id === 'arm-partial' && phase === 'B'
      ? unit({ arm, phase, status: 'FAILED', failure })
      : null
  });

  const failed = raw.units.find((item) => item.armId === 'arm-partial' && item.phase === 'B');
  const before = structuredClone(failed);
  const result = validateRawRun(raw, preregistration(arms), PREREGISTRATION_SHA);

  assert.equal(result.valid, true);
  assert.equal(result.schemaVersion, 2);
  assert.deepEqual(result.counts, {
    arms: 2,
    measuredArms: 1,
    partialFailedArms: 1,
    failedArms: 0,
    notMeasuredArms: 0,
    excludedArms: 0,
    units: 22,
    measuredUnits: 20,
    failedUnits: 1,
    notMeasuredUnits: 0,
    excludedUnits: 1
  });
  assert.deepEqual(failed, before, 'validation must not erase partial evidence');
  assert.equal(failed.latencyMs, 10);
  assert.deepEqual(failed.providerUsage, { total_tokens: 12 });
  assert.equal(failed.decisionResponse.choiceId, 'choice-one');
  assert.equal(raw.arms.find((arm) => arm.armId === 'arm-partial').status, 'PARTIAL_FAILED');
  assert.equal(raw.units.find((item) => item.armId === 'arm-na' && item.phase === 'ISOLATION_USER').status, 'EXCLUDED');
});

test('schema v2 validation rejects an arm status that disagrees with its unit evidence', () => {
  const arms = [{ id: 'arm-partial', name: 'Partial arm', applicability: applicability() }];
  const failure = { cause: 'OPERATION_FAILED', operation: 'retrieve', message: 'Retrieval failed' };
  const raw = rawRun({
    armDefinitions: arms,
    mutateUnit: ({ arm, phase }) => phase === 'B'
      ? unit({ arm, phase, status: 'FAILED', failure })
      : null
  });
  raw.arms[0].status = 'MEASURED';

  assert.throws(
    () => validateRawRun(raw, preregistration(arms), PREREGISTRATION_SHA),
    /status MEASURED.*mechanically derived PARTIAL_FAILED/i
  );
  assert.throws(
    () => aggregateRun(raw, preregistration(arms), aggregationOptions()),
    /status MEASURED.*mechanically derived PARTIAL_FAILED/i,
    'v1.1 aggregation must reject invalid raw input instead of trusting the caller'
  );
});

test('schema v2 validation binds raw applicability to the harness-owned definition', () => {
  const registeredArm = {
    id: 'arm-applicability',
    name: 'Applicability arm',
    applicability: applicability('NOT_APPLICABLE')
  };
  const raw = rawRun({ armDefinitions: [registeredArm] });
  const definition = preregistration([registeredArm]);
  raw.arms[0].applicability = applicability();
  for (const item of raw.units) item.applicability = applicability();
  const userIsolation = raw.units.find((item) => item.phase === 'ISOLATION_USER');
  userIsolation.status = 'MEASURED';
  userIsolation.statusReason = null;
  userIsolation.finishedAt = '2026-08-31T00:00:01.000Z';
  userIsolation.latencyMs = 10;
  userIsolation.decisionResponse = decision('ISOLATION_USER');
  userIsolation.providerUsage = { total_tokens: 12 };
  userIsolation.providerModel = 'provider-model';
  userIsolation.operations = operations({ outerDecisionModelCalls: 1, memoryReadOperations: 1 });
  userIsolation.storage = storage();

  assert.throws(
    () => validateRawRun(raw, definition, PREREGISTRATION_SHA),
    /applicability.*harness-owned|harness-owned.*applicability/iu
  );
});

test('schema v2 validation requires exact persisted adapter evidence shapes', () => {
  const arm = { id: 'arm-evidence', name: 'Evidence arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const definition = preregistration([arm]);
  const isolationUnit = raw.units.find((item) => item.phase === 'ISOLATION_PROJECT');
  isolationUnit.adapterEvidence.verify = recordedAdapterEvidence({
    arm,
    phase: 'ISOLATION_PROJECT'
  });
  isolationUnit.adapterEvidence.verify.isolationEvidence = { verified: true };

  assert.throws(
    () => validateRawRun(raw, definition, PREREGISTRATION_SHA),
    /isolationEvidence.*(?:missing|required|field|namespace|leaked)/iu
  );

  const persistenceRaw = rawRun({ armDefinitions: [arm] });
  const persistenceUnit = persistenceRaw.units.find((item) => item.phase === 'A');
  persistenceUnit.adapterEvidence.verify = recordedAdapterEvidence({ arm, phase: 'A' });
  persistenceUnit.adapterEvidence.verify.persistenceEvidence = {
    verified: true,
    expectedRecord: { id: 'decision-a', type: 'decision', contentSha256: 'a'.repeat(64) },
    matchedRecordIds: []
  };
  assert.throws(
    () => validateRawRun(persistenceRaw, definition, PREREGISTRATION_SHA),
    /persistenceEvidence.*(?:missing|required|field|namespace|matched)/iu
  );

  const missingEvidenceRaw = rawRun({ armDefinitions: [arm] });
  const phaseA = missingEvidenceRaw.units.find((item) => item.phase === 'A');
  phaseA.adapterEvidence.retrieve = null;
  phaseA.operations.memoryReadOperations = 0;
  assert.equal(phaseA.adapterEvidence.retrieve, null);
  assert.throws(
    () => validateRawRun(missingEvidenceRaw, definition, PREREGISTRATION_SHA),
    /MEASURED.*(?:retrieve|adapter evidence)/iu
  );
});

test('decision storage identifiers are deterministic, unit-unique, and independent of model decision ids', () => {
  const phaseA = {
    armId: 'arm-record-id',
    scenarioId: 'ACC_VALIDATION_1',
    repetition: 0,
    phase: 'A'
  };
  const phaseB = { ...phaseA, phase: 'B' };
  const sharedModelDecisionId = 'model-reused-this-id';
  const responseA = { ...decision('A'), decisionId: sharedModelDecisionId };
  const responseB = { ...decision('B'), decisionId: sharedModelDecisionId };

  const idA = v11Contract.decisionRecordId(phaseA);
  assert.equal(idA, v11Contract.decisionRecordId(structuredClone(phaseA)));
  for (const distinctCorrelation of [
    { ...phaseA, armId: 'arm-record-id-other' },
    { ...phaseA, scenarioId: 'ACC_VALIDATION_2' },
    { ...phaseA, repetition: 1 },
    phaseB,
    { ...phaseA, armId: 'arm:record', scenarioId: 'id' },
    { ...phaseA, armId: 'arm', scenarioId: 'record:id' }
  ]) {
    assert.notEqual(idA, v11Contract.decisionRecordId(distinctCorrelation));
  }
  assert.notEqual(idA, sharedModelDecisionId);
  assert.deepEqual(
    v11Contract.standardizedDecisionRecord(phaseA, responseA),
    { id: idA, type: 'decision', content: responseA }
  );
  assert.equal(
    v11Contract.standardizedDecisionRecord(phaseB, responseB).content.decisionId,
    sharedModelDecisionId,
    'the model decisionId remains standardized content, never the storage key'
  );
});

test('schema v2 validator shares the unambiguous length-prefixed unit id format', () => {
  const arm = { id: 'arm:with:colons', name: 'Colon arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  assert.ok(raw.units.every((item) => item.unitId.startsWith('unit:')));
  assert.equal(new Set(raw.units.map((item) => item.unitId)).size, raw.units.length);
  assert.doesNotThrow(() => validateRawRun(raw, preregistration([arm]), PREREGISTRATION_SHA));
});

test('schema v2 validation rejects model-id reuse as a persisted storage-id collision', () => {
  const arm = { id: 'arm-record-collision', name: 'Record collision arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const phaseA = raw.units.find((item) => item.phase === 'A');
  const phaseB = raw.units.find((item) => item.phase === 'B');
  phaseB.decisionResponse.decisionId = phaseA.decisionResponse.decisionId;
  const phaseAStorageId = decisionRecordReference(arm, 'A').id;
  phaseB.adapterEvidence.verify.persistenceEvidence.expectedRecord.id = phaseAStorageId;
  phaseB.adapterEvidence.verify.persistenceEvidence.matchedRecordIds = [phaseAStorageId];

  assert.throws(
    () => validateRawRun(raw, preregistration([arm]), PREREGISTRATION_SHA),
    /persisted record|storage.*id|expected.*record|unit-unique/iu
  );
});

test('schema v2 validation rejects any-record persistence matches', () => {
  const arm = { id: 'arm-any-record', name: 'Any-record arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const phaseA = raw.units.find((item) => item.phase === 'A');
  phaseA.adapterEvidence.verify.persistenceEvidence.matchedRecordIds.push('unrelated-record');

  assert.throws(
    () => validateRawRun(raw, preregistration([arm]), PREREGISTRATION_SHA),
    /exact persisted record|matchedRecordIds|only matched record|any-record/iu
  );
});

test('schema v2 validation binds isolation retrieval to alternate namespaces and persistence to primary', () => {
  const arm = { id: 'arm-isolation-binding', name: 'Isolation binding arm', applicability: applicability() };
  const document = preregistration([arm]);
  const raw = rawRun({ armDefinitions: [arm] });
  assert.doesNotThrow(() => validateRawRun(raw, document, PREREGISTRATION_SHA));

  const projectIsolation = raw.units.find((item) => item.phase === 'ISOLATION_PROJECT');
  assert.equal(
    projectIsolation.adapterEvidence.retrieve.namespaceRef,
    expectedNamespaceRef(arm, 'ISOLATION_PROJECT', alternateNamespace(arm, 'ISOLATION_PROJECT'))
  );
  assert.equal(
    projectIsolation.adapterEvidence.persist.namespaceRef,
    expectedNamespaceRef(arm, 'ISOLATION_PROJECT', primaryNamespace(arm))
  );
  assert.equal(projectIsolation.adapterEvidence.verify.namespaceRef, projectIsolation.adapterEvidence.persist.namespaceRef);
  assert.equal(Object.hasOwn(projectIsolation.adapterEvidence.retrieve, 'namespace'), false);

  const invalidCases = [
    ['primary retrieve namespace', (item) => {
      item.adapterEvidence.retrieve.namespaceRef = expectedNamespaceRef(arm, item.phase, primaryNamespace(arm));
    }],
    ['non-empty isolation retrieval', (item) => { item.adapterEvidence.retrieve.nativeContextCount = 1; }],
    ['alternate persist namespace', (item) => {
      item.adapterEvidence.persist.namespaceRef = expectedNamespaceRef(
        arm,
        item.phase,
        alternateNamespace(arm, item.phase)
      );
    }],
    ['alternate verify namespace', (item) => {
      const alternate = alternateNamespace(arm, item.phase);
      const alternateRef = expectedNamespaceRef(arm, item.phase, alternate);
      item.adapterEvidence.verify.namespaceRef = alternateRef;
      item.adapterEvidence.verify.persistenceEvidence.namespaceRef = alternateRef;
    }],
    ['missing captured namespace', (item) => { delete item.adapterEvidence.retrieve.namespaceRef; }],
    ['raw namespace disclosure', (item) => {
      item.adapterEvidence.retrieve.namespace = alternateNamespace(arm, item.phase);
    }]
  ];
  for (const [label, mutate] of invalidCases) {
    const invalid = structuredClone(raw);
    mutate(invalid.units.find((item) => item.phase === 'ISOLATION_PROJECT'));
    assert.throws(
      () => validateRawRun(invalid, document, PREREGISTRATION_SHA),
      /(?:retrieve|persist|verify|adapter evidence).*(?:namespace|context)|missing.*namespace/iu,
      label
    );
  }
});

test('schema v2 validation rejects a matching Phase-A id in the alternate namespace', () => {
  const arm = { id: 'arm-phase-a-leak', name: 'Phase-A leak arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const isolation = raw.units.find((item) => item.phase === 'ISOLATION_PROJECT');
  const phaseATargetId = decisionRecordReference(arm, 'A').id;
  const isolationRecordId = decisionRecordReference(arm, 'ISOLATION_PROJECT').id;
  isolation.adapterEvidence.verify.isolationEvidence.verified = false;
  isolation.adapterEvidence.verify.isolationEvidence.matchingRecordIdCount = 1;
  assert.notEqual(phaseATargetId, isolationRecordId);
  assert.equal(
    phaseATargetId === isolationRecordId,
    false,
    'the Phase-A target is distinct from the isolation unit record'
  );

  assert.throws(
    () => validateRawRun(raw, preregistration([arm]), PREREGISTRATION_SHA),
    /isolationEvidence.*zero matching|alternate namespace.*without matching/iu
  );
});

test('schema v2 validation rejects matching Phase-A content under a different id', () => {
  const arm = { id: 'arm-phase-a-content-leak', name: 'Phase-A content leak arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const isolation = raw.units.find((item) => item.phase === 'ISOLATION_PROJECT');
  isolation.adapterEvidence.verify.isolationEvidence.verified = false;
  isolation.adapterEvidence.verify.isolationEvidence.matchingRecordIdCount = 0;
  isolation.adapterEvidence.verify.isolationEvidence.matchingContentCount = 1;
  assert.throws(
    () => validateRawRun(raw, preregistration([arm]), PREREGISTRATION_SHA),
    /isolationEvidence.*zero matching|alternate namespace.*without matching/iu
  );
});

test('schema v2 validation binds isolation counts to the exact Phase-A target', () => {
  const arm = { id: 'arm-phase-a-target', name: 'Phase-A target arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const isolation = raw.units.find((item) => item.phase === 'ISOLATION_PROJECT');
  isolation.adapterEvidence.verify.isolationEvidence.expectedAbsentRecord.id = 'different-phase-a-record';
  assert.throws(
    () => validateRawRun(raw, preregistration([arm]), PREREGISTRATION_SHA),
    /exact alternate namespace|expectedAbsentRecord|Phase-A/iu
  );
});

test('schema v2 validation rejects a same-id persistence match with the wrong content hash', () => {
  const arm = { id: 'arm-wrong-content', name: 'Wrong-content arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const phaseA = raw.units.find((item) => item.phase === 'A');
  phaseA.adapterEvidence.verify.persistenceEvidence.observedContentSha256 = 'f'.repeat(64);
  assert.throws(
    () => validateRawRun(raw, preregistration([arm]), PREREGISTRATION_SHA),
    /exact expected record content hash|exact persisted record/iu
  );
});

test('schema v2 validation accepts repeated model decision ids only with distinct deterministic storage ids', () => {
  const arm = { id: 'arm-model-id-reuse', name: 'Model id reuse arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const phaseA = raw.units.find((item) => item.phase === 'A');
  const phaseB = raw.units.find((item) => item.phase === 'B');
  phaseB.decisionResponse.decisionId = phaseA.decisionResponse.decisionId;
  const phaseBHash = v11Contract.recordContentSha256(phaseB.decisionResponse);
  phaseB.adapterEvidence.verify.persistenceEvidence.expectedRecord.contentSha256 = phaseBHash;
  phaseB.adapterEvidence.verify.persistenceEvidence.observedContentSha256 = phaseBHash;

  assert.notEqual(
    phaseA.adapterEvidence.verify.persistenceEvidence.expectedRecord.id,
    phaseB.adapterEvidence.verify.persistenceEvidence.expectedRecord.id
  );
  assert.doesNotThrow(() => validateRawRun(raw, preregistration([arm]), PREREGISTRATION_SHA));
});

test('schema v2 validation forbids invented evidence for persistence N/A and excluded user isolation', () => {
  const arm = {
    id: 'no-memory',
    name: 'No-memory control',
    applicability: applicability('NOT_APPLICABLE', 'NOT_APPLICABLE')
  };
  const document = preregistration([arm]);
  const raw = rawRun({ armDefinitions: [arm] });
  assert.doesNotThrow(() => validateRawRun(raw, document, PREREGISTRATION_SHA));

  const invalidPersistence = structuredClone(raw);
  const phaseA = invalidPersistence.units.find((item) => item.phase === 'A');
  phaseA.adapterEvidence.persist.persistenceEvidence = persistenceEvidence(
    arm,
    'A',
    decisionRecordReference(arm, 'A')
  );
  assert.throws(
    () => validateRawRun(invalidPersistence, document, PREREGISTRATION_SHA),
    /NOT_APPLICABLE.*(?:evidence|claims)|persistence.*NOT_APPLICABLE/iu
  );

  const invalidIsolation = structuredClone(raw);
  const projectIsolation = invalidIsolation.units.find((item) => item.phase === 'ISOLATION_PROJECT');
  projectIsolation.adapterEvidence.verify.isolationEvidence = isolationEvidence(arm, 'ISOLATION_PROJECT');
  assert.throws(
    () => validateRawRun(invalidIsolation, document, PREREGISTRATION_SHA),
    /NOT_APPLICABLE.*(?:evidence|claims)|persistence.*NOT_APPLICABLE/iu
  );

  const invalidExcluded = structuredClone(raw);
  const userIsolation = invalidExcluded.units.find((item) => item.phase === 'ISOLATION_USER');
  userIsolation.adapterEvidence.retrieve = recordedAdapterEvidence({
    arm,
    phase: 'ISOLATION_USER',
    namespace: alternateNamespace(arm, 'ISOLATION_USER')
  });
  assert.throws(
    () => validateRawRun(invalidExcluded, document, PREREGISTRATION_SHA),
    /EXCLUDED.*claims/iu
  );
});

test('schema v2 validation enforces terminal measured/failed units and claim-free EXCLUDED/NOT_MEASURED units', () => {
  const excludedArm = {
    id: 'arm-excluded-unit',
    name: 'Excluded-unit arm',
    applicability: applicability('NOT_APPLICABLE')
  };
  const excludedRaw = rawRun({ armDefinitions: [excludedArm] });
  const excludedDocument = preregistration([excludedArm]);
  validateRawRun(excludedRaw, excludedDocument, PREREGISTRATION_SHA);
  const excludedIndex = excludedRaw.units.findIndex((item) => item.phase === 'ISOLATION_USER');
  const excludedMutations = [
    ['latencyMs', (item) => { item.latencyMs = 1; }],
    ['providerUsage', (item) => { item.providerUsage = { total_tokens: 1 }; }],
    ['providerModel', (item) => { item.providerModel = 'provider-model'; }],
    ['decisionResponse', (item) => { item.decisionResponse = decision('ISOLATION_USER'); }],
    ['storage', (item) => { item.storage = storage(); }],
    ['operations', (item) => { item.operations.outerDecisionModelCalls = 1; }],
    ['adapterEvidence', (item) => {
      item.adapterEvidence.retrieve = recordedAdapterEvidence({ arm: excludedArm, phase: item.phase });
    }],
    ['statusReason', (item) => { item.statusReason = 'model-declared non-applicability'; }]
  ];
  for (const [field, mutate] of excludedMutations) {
    const invalid = structuredClone(excludedRaw);
    mutate(invalid.units[excludedIndex]);
    assert.throws(
      () => validateRawRun(invalid, excludedDocument, PREREGISTRATION_SHA),
      /EXCLUDED.*(?:claims|latency|applicability)/iu,
      `EXCLUDED ${field} must be rejected`
    );
  }

  const unavailableArm = {
    id: 'arm-not-measured',
    name: 'Not measured arm',
    applicability: applicability()
  };
  const unavailableRaw = rawRun({
    armDefinitions: [unavailableArm],
    zeroResult: {
      causes: ['NOT_MEASURED'],
      message: 'No decision unit was measured; see retained unit and progress evidence.'
    },
    mutateUnit: ({ arm, phase }) => notMeasuredUnit({ arm, phase })
  });
  const unavailableDocument = preregistration([unavailableArm]);
  validateRawRun(unavailableRaw, unavailableDocument, PREREGISTRATION_SHA);
  const unavailableMutations = [
    ['latencyMs', (item) => { item.latencyMs = 1; }],
    ['providerUsage', (item) => { item.providerUsage = { total_tokens: 1 }; }],
    ['providerModel', (item) => { item.providerModel = 'provider-model'; }],
    ['decisionResponse', (item) => { item.decisionResponse = decision('A'); }],
    ['storage', (item) => { item.storage = storage(); }],
    ['operations', (item) => { item.operations.memoryReadOperations = 1; }],
    ['adapterEvidence', (item) => {
      item.adapterEvidence.retrieve = recordedAdapterEvidence({ arm: unavailableArm, phase: item.phase });
    }]
  ];
  for (const [field, mutate] of unavailableMutations) {
    const invalid = structuredClone(unavailableRaw);
    mutate(invalid.units[1]);
    assert.throws(
      () => validateRawRun(invalid, unavailableDocument, PREREGISTRATION_SHA),
      /NOT_MEASURED.*claims|operations.*recorded adapter evidence/iu,
      `NOT_MEASURED ${field} must be rejected`
    );
  }

  const failedArm = { id: 'arm-failed-terminal', name: 'Failed arm', applicability: applicability() };
  const failure = { cause: 'TIMEOUT', operation: 'outer', message: 'Outer request timed out' };
  const failedRaw = rawRun({
    armDefinitions: [failedArm],
    mutateUnit: ({ arm, phase }) => phase === 'A'
      ? unit({ arm, phase, status: 'FAILED', failure })
      : null
  });
  const failedDocument = preregistration([failedArm]);
  for (const field of ['finishedAt', 'latencyMs']) {
    const invalid = structuredClone(failedRaw);
    invalid.units.find((item) => item.phase === 'A')[field] = null;
    assert.throws(
      () => validateRawRun(invalid, failedDocument, PREREGISTRATION_SHA),
      /FAILED.*terminal/iu,
      `FAILED ${field} must be terminal`
    );
  }
});

test('schema v2 validation accepts only exact non-negative provider usage counts', () => {
  const arm = { id: 'arm-usage', name: 'Usage arm', applicability: applicability() };
  const raw = rawRun({ armDefinitions: [arm] });
  const document = preregistration([arm]);
  const targetIndex = raw.units.findIndex((item) => item.phase === 'A');
  raw.units[targetIndex].providerUsage = {
    input_tokens: 4,
    output_tokens: 8,
    total_tokens: 12,
    input_tokens_details: { cached_tokens: 1 }
  };
  validateRawRun(raw, document, PREREGISTRATION_SHA);

  const invalidUsage = [
    { total_tokens: -1 },
    { total_tokens: 1.5 },
    { totalTokens: 12 },
    { total_tokens: 12, input_tokens_details: { unknown_tokens: 1 } },
    { total_tokens: 12, output_tokens_details: { reasoning_tokens: -1 } }
  ];
  for (const providerUsage of invalidUsage) {
    const invalid = structuredClone(raw);
    invalid.units[targetIndex].providerUsage = providerUsage;
    assert.throws(
      () => validateRawRun(invalid, document, PREREGISTRATION_SHA),
      /providerUsage.*(?:invalid|unknown|non-negative|safe integer)/iu
    );
  }
});

test('schema v2 aggregation excludes partial arms while harness-owned N/A stays null without blocking general rank eligibility', () => {
  const arms = [
    { id: 'arm-partial', name: 'Partial arm', applicability: applicability() },
    { id: 'arm-na', name: 'N/A arm', applicability: applicability('NOT_APPLICABLE') }
  ];
  const failure = { cause: 'OPERATION_FAILED', operation: 'retrieve', message: 'Retrieval failed' };
  const raw = rawRun({
    armDefinitions: arms,
    mutateUnit: ({ arm, phase }) => arm.id === 'arm-partial' && phase === 'B'
      ? unit({ arm, phase, status: 'FAILED', failure })
      : null
  });
  const document = preregistration(arms);
  validateRawRun(raw, document, PREREGISTRATION_SHA);

  const aggregate = aggregateRun(raw, document, aggregationOptions());

  assert.equal(aggregate.schemaVersion, 2);
  assert.equal(aggregate.mode, 'SCORED');
  assert.deepEqual(aggregate.rankEligibleArms, ['arm-na']);
  assert.deepEqual(aggregate.armResults.map((result) => result.armId), ['arm-na']);
  assert.equal(aggregate.armResults[0].rankEligible, true);
  assert.equal(aggregate.armResults[0].metrics.userIsolation, null);
  assert.equal(aggregate.armResults[0].economics.meanOuterDecisionTokens, 108);
  assert.equal(
    aggregate.armResults[0].economics.meanLifecycleTokens,
    null,
    'outer-only usage must not be mislabeled as total lifecycle tokens'
  );
  assert.equal(aggregate.armResults.some((result) => result.armId === 'arm-partial'), false);
  assert.equal(aggregate.bestClaimAllowed, false);
});

test('schema v2 zero-result validation and aggregation preserve the actual recorded causes', () => {
  const arms = [{ id: 'arm-timeout', name: 'Timeout arm', applicability: applicability() }];
  const failure = { cause: 'TIMEOUT', operation: 'outer', message: 'Outer request timed out' };
  const zeroResult = {
    causes: ['TIMEOUT'],
    message: 'No decision unit was measured; see retained unit and progress evidence.'
  };
  const raw = rawRun({
    armDefinitions: arms,
    zeroResult,
    mutateUnit: ({ arm, phase }) => phase === 'RESET'
      ? null
      : unit({ arm, phase, status: 'FAILED', failure })
  });
  const document = preregistration(arms);
  document.marketingThresholds.noResultText = 'No result: required benchmark endpoints are unavailable.';

  assert.doesNotThrow(() => validateRawRun(raw, document, PREREGISTRATION_SHA));
  const aggregate = aggregateRun(raw, document, aggregationOptions());
  assert.deepEqual(aggregate.zeroResult, zeroResult);
  assert.equal(aggregate.allowedMarketingText, 'No measured result is available. Recorded causes: TIMEOUT.');
  assert.doesNotMatch(aggregate.allowedMarketingText, /endpoint/iu);

  const substituted = structuredClone(raw);
  substituted.zeroResult.causes = ['ENDPOINT_UNAVAILABLE'];
  assert.throws(
    () => validateRawRun(substituted, document, PREREGISTRATION_SHA),
    /zeroResult.*actual recorded cause/i
  );

  const embellished = structuredClone(raw);
  embellished.zeroResult.causes = ['TIMEOUT', 'ENDPOINT_UNAVAILABLE'];
  assert.throws(
    () => validateRawRun(embellished, document, PREREGISTRATION_SHA),
    /zeroResult.*actual recorded cause/i
  );
});

test('schema v2 acceptance aggregation emits no evaluation, ranking, or marketing fields', () => {
  const arms = [{ id: 'arm-acceptance', name: 'Acceptance arm', applicability: applicability() }];
  const raw = rawRun({ mode: 'ACCEPTANCE', armDefinitions: arms });
  const document = preregistration(arms);
  validateRawRun(raw, document, PREREGISTRATION_SHA);

  const aggregate = aggregateRun(raw, document, aggregationOptions());
  const forbidden = /(?:score|rank|winner|best|marketing|quality|efficacy)/iu;
  const visit = (value, path = 'aggregate') => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      assert.equal(forbidden.test(key), false, `${path}.${key} is forbidden in acceptance output`);
      visit(child, `${path}.${key}`);
    }
  };

  assert.equal(aggregate.mode, 'ACCEPTANCE');
  visit(aggregate);

  const contaminated = structuredClone(raw);
  contaminated.units[1].adapterEvidence.retrieve = recordedAdapterEvidence({
    arm: arms[0],
    phase: contaminated.units[1].phase
  });
  contaminated.units[1].adapterEvidence.retrieve.persistenceEvidence = { quality: null };
  assert.throws(
    () => validateRawRun(contaminated, document, PREREGISTRATION_SHA),
    /acceptance output.*forbidden field quality/iu
  );
  assert.throws(
    () => aggregateRun(contaminated, document, aggregationOptions()),
    /acceptance output.*forbidden field quality/iu
  );
});
