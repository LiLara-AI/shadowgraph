// Offline non-scored acceptance for the v1.1 candidate.
//
// Drives the frozen acceptance definition through the real runner for every
// planned unit: 2 ACC scenarios x 2 repetitions x 7 arms x 11 phases. The
// adapters and the outer model are stubs, so what this measures is the harness
// and not any product. It produces no score, no ranking and no comparative
// claim, and it is not evidence that a real acceptance run has been executed.
//
// The prompts come from the real `buildV11Prompt` rather than a stub, because
// the fairness properties asserted here are worthless against a stub that
// cannot diverge in the first place. Everything with an external dependency is
// injected, so this needs no service, no container and no network.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { STANDARD_DECISION_RESPONSE_SCHEMA } from '../benchmark/lib/outer-model.mjs';
import { createProgressLedger, createUnitEvidenceLedger } from '../benchmark/lib/progress.mjs';
import { loadV11AcceptanceDefinition } from '../benchmark/lib/v11-definition.mjs';
import { V11_OUTER_SYSTEM_PROMPT, buildV11Prompt } from '../benchmark/lib/v11-prompts.mjs';
import { V11_ARM_IDS } from '../benchmark/lib/v11-registry.mjs';
import { runV11Benchmark, unitIdFor } from '../benchmark/lib/v11-runner.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const AMENDMENT_002_PATH = fileURLToPath(
  new URL('../benchmark/preregistration-amendment-002.json', import.meta.url)
);

// The frozen source digests, stated so a change to the frozen bytes fails this
// suite instead of silently re-baselining it.
const HASHES = Object.freeze({
  preregistrationSha256: '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac',
  amendment001Sha256: '2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a',
  amendment002Sha256: '08e12eca3f93bd67cfeaf90a2064f91beb240e78a8fd63ed8645da78c0d88f1b',
  implementationLockHash: '4'.repeat(64),
  environmentLockHash: '5'.repeat(64)
});

const OPERATION_FIELDS = [
  'memoryReadOperations',
  'memoryWriteOperations',
  'mcpToolCalls',
  'outerDecisionModelCalls',
  'internalMemoryModelCalls',
  'embeddingCalls',
  'persistenceVerificationOperations'
];

function emptyOperations(overrides = {}) {
  return Object.fromEntries(OPERATION_FIELDS.map((field) => [field, overrides[field] ?? 0]));
}

function measuredStorage() {
  return {
    status: 'MEASURED',
    bytes: 32,
    scope: 'isolated fixture state',
    method: 'fixture byte count',
    reason: null,
    blockedClaims: []
  };
}

function unavailableStorage() {
  return {
    status: 'NOT_AVAILABLE',
    bytes: null,
    scope: 'isolated fixture state',
    method: null,
    reason: 'the control arm stores nothing to measure',
    blockedClaims: ['storage bytes']
  };
}

function decision(phase, namespace) {
  return {
    decisionId: `decision-${phase.toLowerCase()}`,
    choiceId: 'choice-one',
    recalledAlternativeIds: [],
    recalledRejectionReasonIds: [],
    constraintIdsAddressed: [],
    evidenceIdsCited: [],
    riskIdsRecognized: [],
    reviewTriggerIds: [],
    changedFactDetected: false,
    changedFactId: null,
    recommendation: `recommendation for ${phase}`,
    failedAttemptIdsAvoided: [],
    failedAttemptReasonIdsCited: [],
    memoryProjectId: namespace.projectId,
    memoryUserId: namespace.userId
  };
}

/**
 * A cooperating adapter that respects the declared applicability matrix.
 *
 * The stub is deliberately not more permissive than the contract. An arm whose
 * applicability declares no persistence must answer persist and verify with
 * NOT_APPLICABLE rather than inventing storage, and retrieval must be empty
 * wherever the arm cannot legitimately have anything to recall - after RESET in
 * phase A, in an alternate namespace, and for the control arm throughout. A
 * stub looser than the product is how a defect stays invisible.
 */
function adapterEnvelope(request, applicability, { status = 'SUCCEEDED', failure = null } = {}) {
  const persists = applicability.get(request.armId).persistence.status !== 'NOT_APPLICABLE';
  const notApplicable = !persists && ['persist', 'verify'].includes(request.operation);
  const effectiveStatus = notApplicable ? 'NOT_APPLICABLE' : status;

  if (effectiveStatus !== 'SUCCEEDED') {
    return {
      schemaVersion: 1,
      operation: request.operation,
      runId: request.runId,
      attemptId: request.attemptId,
      phase: request.phase,
      armId: request.armId,
      scenarioId: request.scenarioId,
      repetition: request.repetition,
      status: effectiveStatus,
      result: { nativeContext: [], persistenceEvidence: null, isolationEvidence: null },
      failure: notApplicable ? null : failure,
      operations: emptyOperations(),
      storage: persists ? measuredStorage() : unavailableStorage()
    };
  }

  const expectedRecord = request.operation === 'verify' ? request.payload.expectedRecord : null;
  const alternateNamespaceRef = request.operation === 'verify'
    ? request.payload.alternateNamespaceRef
    : null;
  const expectedAbsentRecord = request.operation === 'verify'
    ? request.payload.expectedAbsentRecord
    : null;
  const operationCounts = {
    reset: {},
    retrieve: { memoryReadOperations: 1 },
    persist: { memoryWriteOperations: 1 },
    verify: { persistenceVerificationOperations: 1 }
  }[request.operation];

  // Nothing is recallable in phase A: RESET has just cleared the namespace, and
  // the isolation phases read a namespace the record was never written to.
  const emptyRetrieval = !persists
    || ['A', 'ISOLATION_PROJECT', 'ISOLATION_USER'].includes(request.phase);

  return {
    schemaVersion: 1,
    operation: request.operation,
    runId: request.runId,
    attemptId: request.attemptId,
    phase: request.phase,
    armId: request.armId,
    scenarioId: request.scenarioId,
    repetition: request.repetition,
    status: 'SUCCEEDED',
    result: {
      nativeContext: request.operation === 'retrieve' && !emptyRetrieval
        ? [{ type: 'fixture-context' }]
        : [],
      persistenceEvidence: request.operation === 'verify'
        ? {
            verified: true,
            expectedRecord,
            matchedRecordIds: [expectedRecord.id],
            observedContentSha256: expectedRecord.contentSha256,
            namespaceRef: request.namespaceRef
          }
        : null,
      isolationEvidence: alternateNamespaceRef === null
        ? null
        : {
            verified: true,
            expectedAbsentRecord,
            alternateNamespaceRef,
            matchingRecordIdCount: 0,
            matchingContentCount: 0
          }
    },
    failure: null,
    operations: emptyOperations(operationCounts),
    storage: persists ? measuredStorage() : unavailableStorage()
  };
}

function fakeClock() {
  let wall = Date.parse('2026-08-31T00:00:00.000Z');
  let monotonic = 0;
  return {
    now: () => new Date(wall += 1_000).toISOString(),
    monotonicNow: () => monotonic += 5
  };
}

function progressRecorder() {
  const events = [];
  let activeCorrelation = null;
  return {
    events,
    async append(event) {
      events.push(structuredClone(event));
      if (event.event === 'unit_started') {
        activeCorrelation = {
          armId: event.armId,
          scenarioId: event.scenarioId,
          repetition: event.repetition,
          phase: event.phase
        };
      } else if (['unit_finished', 'unit_failed', 'run_interrupted', 'run_finished'].includes(event.event)) {
        activeCorrelation = null;
      }
    },
    async watchdogState() {
      return {
        stalled: false,
        cause: null,
        elapsedMs: 0,
        referenceEvent: activeCorrelation === null ? null : 'unit_started',
        activeCorrelation: structuredClone(activeCorrelation)
      };
    }
  };
}

/** One full-plan acceptance run with every external dependency injected. */
async function acceptanceRun(overrides = {}) {
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  const { definition, scenarios } = loaded;
  const applicability = new Map(
    definition.arms.map((arm) => [arm.id, structuredClone(arm.applicability)])
  );
  const clock = fakeClock();
  const progress = progressRecorder();
  const outerRequests = [];
  const adapterRequests = [];

  const options = {
    runId: 'run-acceptance-offline',
    attemptId: 'attempt-acceptance-offline',
    scored: false,
    arms: definition.arms.map(({ id, name, applicability }) => ({
      id,
      name,
      applicability: structuredClone(applicability)
    })),
    scenarios: structuredClone(scenarios),
    repetitions: definition.commonExecution.repetitions,
    seeds: [...definition.commonExecution.randomSeeds],
    ...HASHES,
    amendment002Path: AMENDMENT_002_PATH,
    progress,
    persistUnit: async () => {},
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    buildOuterRequest: (input) => {
      // The real builder. A stub here would make every fairness assertion in
      // this file vacuous, because a stub cannot diverge between arms.
      const built = buildV11Prompt({
        phase: input.phase,
        scenario: input.scenario,
        nativeContext: input.nativeContext
      });
      outerRequests.push({
        armId: input.arm.id,
        scenarioId: input.scenario.id,
        phase: input.phase,
        nativeContextLength: input.nativeContext.length,
        built: structuredClone(built)
      });
      return built;
    },
    requestOuter: async ({ correlation, namespace }) => ({
      decision: decision(correlation.phase, namespace),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      providerModel: 'stub-outer-model',
      requestCount: 1,
      correlation: { ...correlation }
    }),
    executeAdapter: async (request) => {
      adapterRequests.push(structuredClone(request));
      return adapterEnvelope(request, applicability);
    },
    ...overrides
  };

  const raw = await runV11Benchmark(options);
  return {
    raw,
    loaded,
    definition,
    scenarios,
    applicability,
    progress,
    outerRequests,
    adapterRequests
  };
}

// One run drives every count, fairness and leakage assertion below. Re-running
// the 308-unit plan per assertion would cost minutes for no extra coverage.
const primary = await acceptanceRun();

/** Arms the frozen matrix declares as having no applicable user isolation. */
function notApplicableUserIsolation(definition) {
  return definition.arms
    .filter((arm) => arm.applicability.userIsolation.status === 'NOT_APPLICABLE')
    .map((arm) => arm.id);
}

/** Units per arm per phase: one for each scenario and repetition. */
function unitsPerArmPhase(definition) {
  return primary.scenarios.length * definition.commonExecution.repetitions;
}

test('the plan covers every unit the frozen definition declares, exactly once', () => {
  const { raw, definition, scenarios } = primary;

  const planned = scenarios.length
    * definition.commonExecution.repetitions
    * definition.arms.length
    * definition.phases.length;
  assert.equal(scenarios.length, 2);
  assert.equal(definition.commonExecution.repetitions, 2);
  assert.equal(definition.arms.length, 7);
  assert.equal(definition.phases.length, 11);
  assert.equal(planned, 308);
  assert.equal(raw.units.length, 308);
  assert.equal(raw.status, 'COMPLETE');

  const seen = new Set(raw.units.map((unit) => unit.unitId));
  assert.equal(seen.size, 308, 'unit ids must be unique across the whole plan');

  for (const arm of definition.arms) {
    for (const scenario of scenarios) {
      for (let repetition = 0; repetition < definition.commonExecution.repetitions; repetition += 1) {
        for (const phase of definition.phases) {
          const id = unitIdFor({ armId: arm.id, scenarioId: scenario.id, repetition, phase });
          assert.ok(seen.has(id), `missing unit ${arm.id}/${scenario.id}/${repetition}/${phase}`);
        }
      }
    }
  }
});

test('measured, excluded and reset counts match the applicability matrix in force', () => {
  const { raw, definition, loaded } = primary;

  const excluded = raw.units.filter((unit) => unit.status === 'EXCLUDED');
  const measured = raw.units.filter((unit) => unit.status === 'MEASURED');
  const reset = raw.units.filter((unit) => unit.phase === 'RESET');

  // Derived from the declared matrix rather than restated, so a future
  // amendment moves the assertion with it instead of leaving a stale literal.
  const notApplicable = notApplicableUserIsolation(definition);
  const perArmPhase = unitsPerArmPhase(definition);
  assert.equal(excluded.length, notApplicable.length * perArmPhase);
  assert.ok(excluded.every((unit) => unit.phase === 'ISOLATION_USER'));
  assert.ok(excluded.every((unit) => notApplicable.includes(unit.armId)));
  assert.ok(
    excluded.every((unit) => typeof unit.statusReason === 'string' && unit.statusReason.length > 0),
    'an excluded unit must carry the declared reason, not a bare status'
  );

  assert.equal(measured.length, 308 - excluded.length);
  assert.equal(reset.length, definition.arms.length * perArmPhase);

  const observed = {
    totalUnits: raw.units.length,
    excludedUnits: excluded.length,
    measuredUnits: measured.length,
    resetUnits: reset.length,
    outerDecisionCalls: measured.length - reset.length
  };
  assert.deepEqual(observed, definition.expectedCounts);
  assert.deepEqual(observed, loaded.expectedCounts);
  assert.deepEqual(observed, {
    totalUnits: 308,
    excludedUnits: 16,
    measuredUnits: 292,
    resetUnits: 28,
    outerDecisionCalls: 264
  });
});

test('exactly the measured non-reset units make one outer decision call each', () => {
  const { raw, outerRequests } = primary;

  assert.equal(outerRequests.length, 264);
  assert.equal(outerRequests.some((entry) => entry.phase === 'RESET'), false);

  // The runner's own per-unit counter must agree with what the outer stub saw.
  const counted = raw.units.reduce(
    (total, unit) => total + unit.operations.outerDecisionModelCalls,
    0
  );
  assert.equal(counted, 264);
  for (const unit of raw.units) {
    const expected = unit.status === 'MEASURED' && unit.phase !== 'RESET' ? 1 : 0;
    assert.equal(
      unit.operations.outerDecisionModelCalls,
      expected,
      `${unit.armId}/${unit.phase} made the wrong number of outer calls`
    );
  }
});

test('every arm receives an identical outer prompt for the same phase and scenario', () => {
  // Prompt fairness is what makes arms comparable at all. If one arm could be
  // given different instructions, no measured difference between arms would
  // mean anything.
  const { outerRequests } = primary;

  const systems = new Set(outerRequests.map((entry) => entry.built.system));
  assert.equal(systems.size, 1, 'all 264 outer calls must share one system prompt');

  // Every arm reaches every phase except ISOLATION_USER, where the arms the
  // matrix declares NOT_APPLICABLE are excluded before any prompt is built.
  const excludedFromUserIsolation = notApplicableUserIsolation(primary.definition).length;
  const byPhaseScenario = new Map();
  for (const entry of outerRequests) {
    const key = `${entry.phase}|${entry.scenarioId}`;
    if (!byPhaseScenario.has(key)) byPhaseScenario.set(key, new Map());
    byPhaseScenario.get(key).set(entry.armId, entry.built.prompt);
  }
  for (const [key, byArm] of byPhaseScenario) {
    const expectedArms = key.startsWith('ISOLATION_USER|') ? 7 - excludedFromUserIsolation : 7;
    assert.equal(byArm.size, expectedArms, `${key} was not run for the expected arms`);
    // Prompts may differ only where the arm actually returned native context,
    // which is the arm's own retrieval and not an instruction difference.
    const withoutContext = new Set(
      outerRequests
        .filter((entry) => `${entry.phase}|${entry.scenarioId}` === key
          && entry.nativeContextLength === 0)
        .map((entry) => entry.built.prompt)
    );
    assert.equal(withoutContext.size, 1, `prompt diverged between context-free arms in ${key}`);
  }

  for (const entry of outerRequests) {
    assert.deepEqual(entry.built.responseSchema, STANDARD_DECISION_RESPONSE_SCHEMA);
  }
});

test('no arm identity reaches any outer prompt', () => {
  const { outerRequests } = primary;

  const armTerms = [
    ...V11_ARM_IDS,
    'no memory',
    'shadowgraph',
    'mem0',
    'graphiti',
    'basic memory',
    'cognee'
  ];
  for (const entry of outerRequests) {
    const surface = `${entry.built.system}\n${entry.built.prompt}`.toLowerCase();
    for (const term of armTerms) {
      assert.equal(
        surface.includes(term.toLowerCase()),
        false,
        `arm identity "${term}" leaked into a ${entry.phase} prompt for ${entry.armId}`
      );
    }
  }
});

test('no fixture truth reaches any outer prompt', () => {
  const { outerRequests, scenarios } = primary;

  const oracleTerms = ['expectedanswer', 'expected_answer', 'oracle', 'correctchoice', 'groundtruth'];
  // Whatever the fixtures themselves name as withheld truth must not appear.
  const withheld = new Set();
  for (const scenario of scenarios) {
    for (const key of Object.keys(scenario)) {
      if (oracleTerms.some((term) => key.toLowerCase().includes(term))) withheld.add(key);
    }
  }

  for (const entry of outerRequests) {
    const surface = `${entry.built.system}\n${entry.built.prompt}`;
    const lowered = surface.toLowerCase();
    for (const term of oracleTerms) {
      assert.equal(lowered.includes(term), false, `${term} leaked into a ${entry.phase} prompt`);
    }
    for (const key of withheld) {
      assert.equal(surface.includes(key), false, `${key} leaked into a ${entry.phase} prompt`);
    }
  }
});

test('adapters are asked for memory operations only, never for a decision', () => {
  const { adapterRequests, outerRequests } = primary;

  assert.ok(adapterRequests.length > 0);
  for (const request of adapterRequests) {
    assert.ok(
      ['reset', 'retrieve', 'persist', 'verify'].includes(request.operation),
      `adapters must not be asked to ${request.operation}`
    );
  }

  // No adapter may see the outer instructions. Adapters do legitimately store
  // the decision the model returned - that is the memory operation under test -
  // but an adapter that could see the prompt or the response schema could
  // answer in the model's place, and the arm would be measuring itself.
  const forbidden = new Set([V11_OUTER_SYSTEM_PROMPT]);
  for (const entry of outerRequests) forbidden.add(entry.built.prompt);

  for (const request of adapterRequests) {
    const serialized = JSON.stringify(request);
    assert.equal(
      serialized.includes('responseSchema'),
      false,
      `a response schema was handed to an adapter in phase ${request.phase}`
    );
    for (const text of forbidden) {
      assert.equal(
        serialized.includes(JSON.stringify(text).slice(1, -1)),
        false,
        `outer instructions were handed to an adapter in phase ${request.phase}`
      );
    }
  }
});

test('an arm without native user isolation is never given a user namespace', () => {
  // Isolation is never manufactured: an arm whose product exposes no
  // user-scoped record API must receive a null user namespace rather than a
  // synthesized one folded into the project id.
  const { adapterRequests, definition, scenarios } = primary;

  const notApplicable = new Set(notApplicableUserIsolation(definition));
  const userIds = new Set(
    scenarios.flatMap((scenario) => [scenario.userId, scenario.isolationUserId])
  );

  for (const request of adapterRequests) {
    if (!notApplicable.has(request.armId)) continue;
    assert.equal(
      request.namespace.userId,
      null,
      `${request.armId} was given a user namespace it has no native support for`
    );
    for (const userId of userIds) {
      assert.equal(
        request.namespace.projectId.includes(userId),
        false,
        `${request.armId} had a user id folded into its project namespace`
      );
    }
  }
});

test('the run reports itself as acceptance and produces no ranking', () => {
  const { raw } = primary;

  assert.equal(raw.mode, 'ACCEPTANCE');
  assert.equal(raw.benchmarkVersion, '1.1');
  assert.equal(raw.zeroResult, null);
  const serialized = JSON.stringify(raw).toLowerCase();
  for (const forbidden of ['winner', 'ranking', 'outperform', 'leaderboard', 'score']) {
    assert.equal(serialized.includes(forbidden), false, `the raw run mentions ${forbidden}`);
  }
});

test('the frozen source digests are carried through the run unchanged', () => {
  const { raw, loaded } = primary;

  assert.equal(raw.preregistrationSha256, loaded.sourceHashes.preregistrationSha256);
  assert.equal(raw.amendment001Sha256, loaded.sourceHashes.amendment001Sha256);
  assert.equal(raw.amendment002Sha256, loaded.sourceHashes.amendment002Sha256);
  assert.equal(raw.preregistrationSha256, HASHES.preregistrationSha256);
  assert.equal(raw.amendment001Sha256, HASHES.amendment001Sha256);
  assert.equal(raw.amendment002Sha256, HASHES.amendment002Sha256);
});

test('every unit is checkpointed, and no unit reports an unapproved status', () => {
  const { raw, progress } = primary;

  const checkpoints = progress.events.filter((event) => event.event === 'checkpoint');
  assert.equal(checkpoints.length, 308, 'every unit must be checkpointed for resume');

  for (const unit of raw.units) {
    assert.ok(
      ['MEASURED', 'FAILED', 'NOT_MEASURED', 'EXCLUDED'].includes(unit.status),
      `${unit.unitId} reported the unapproved status ${unit.status}`
    );
  }
  // AMBIGUOUS is a mutation state and must never surface as a unit status.
  assert.equal(JSON.stringify(raw.units).includes('AMBIGUOUS'), false);
});

test('an adapter failure fails its own units closed without shrinking the plan', async () => {
  const { raw } = await acceptanceRun({
    executeAdapter: async (request) => {
      if (request.armId === 'graphiti' && request.operation === 'persist') {
        return adapterEnvelope(request, primary.applicability, {
          status: 'FAILED',
          failure: {
            cause: 'ADAPTER_ERROR',
            message: 'injected persist failure',
            operation: 'persist'
          }
        });
      }
      return adapterEnvelope(request, primary.applicability);
    }
  });

  assert.equal(raw.units.length, 308, 'a failing arm must not shrink the plan');

  const failed = raw.units.filter((unit) => unit.status === 'FAILED');
  assert.ok(failed.length > 0, 'the injected failure must produce failed units');
  assert.ok(
    failed.every((unit) => unit.armId === 'graphiti'),
    'one arm failing must not fail the others'
  );
  for (const unit of failed) {
    assert.ok(unit.failure !== null && typeof unit.failure.cause === 'string');
  }

  // The other six arms are untouched: 292 measured minus graphiti's own share.
  const otherArmsMeasured = raw.units.filter(
    (unit) => unit.armId !== 'graphiti' && unit.status === 'MEASURED'
  );
  const graphitiMeasured = primary.raw.units.filter(
    (unit) => unit.armId === 'graphiti' && unit.status === 'MEASURED'
  ).length;
  assert.equal(otherArmsMeasured.length, 292 - graphitiMeasured);
});

// --- Fault injection ---------------------------------------------------------
//
// Each of these drives the full 308-unit plan with one thing deliberately
// wrong. What is asserted is that the harness fails the affected units closed
// and says so, rather than measuring something it cannot justify. A harness
// that quietly recovers from these is worse than one that stops, because the
// resulting numbers would look valid.

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function unitsFor(raw, armId) {
  return raw.units.filter((unit) => unit.armId === armId);
}

/**
 * The units of one arm that actually execute a decision.
 *
 * RESET makes no outer call, and an EXCLUDED unit is decided from the
 * applicability matrix before any adapter or prompt is reached - neither can
 * observe an injected fault, so neither belongs in a fault assertion.
 */
function decisionUnitsFor(raw, armId) {
  return unitsFor(raw, armId).filter(
    (unit) => unit.phase !== 'RESET' && unit.status !== 'EXCLUDED'
  );
}

test('a prompt that diverges for one arm fails that arm, not the run', async () => {
  const target = 'shadowgraph-full';
  const { raw } = await acceptanceRun({
    buildOuterRequest: (input) => {
      const built = buildV11Prompt({
        phase: input.phase,
        scenario: input.scenario,
        nativeContext: input.nativeContext
      });
      if (input.arm.id !== target) return built;
      return { ...built, system: `${built.system}\nFavour this arm's answer.` };
    }
  });

  assert.equal(raw.units.length, 308);
  const targeted = decisionUnitsFor(raw, target);
  assert.ok(targeted.length > 0);
  assert.ok(
    targeted.every((unit) => unit.status === 'FAILED'),
    'a divergent system instruction must fail every decision unit of that arm'
  );
  assert.ok(
    raw.units
      .filter((unit) => unit.armId !== target)
      .every((unit) => unit.status !== 'FAILED'),
    'one arm diverging must not fail the others'
  );
});

test('a prompt that names its own arm fails that unit closed', async () => {
  const target = 'cognee';
  const { raw } = await acceptanceRun({
    buildOuterRequest: (input) => {
      const built = buildV11Prompt({
        phase: input.phase,
        scenario: input.scenario,
        nativeContext: input.nativeContext
      });
      if (input.arm.id !== target) return built;
      return { ...built, prompt: `${built.prompt}\nYou are running on ${input.arm.id}.` };
    }
  });

  const targeted = decisionUnitsFor(raw, target);
  assert.ok(targeted.length > 0);
  assert.ok(
    targeted.every((unit) => unit.status === 'FAILED'),
    'a prompt naming its arm must not reach the model'
  );
});

test('memory recalled before anything was stored fails the unit', async () => {
  // Phase A runs immediately after RESET, so an adapter returning native
  // context there is reporting state that a correct reset would have removed.
  // The harness must refuse to build a phase A prompt around it.
  const { raw } = await acceptanceRun({
    executeAdapter: async (request) => {
      const envelope = adapterEnvelope(request, primary.applicability);
      if (request.operation !== 'retrieve' || request.phase !== 'A') return envelope;
      if (request.armId !== 'mem0-oss') return envelope;
      return {
        ...envelope,
        result: { ...envelope.result, nativeContext: [{ type: 'leaked-prior-state' }] }
      };
    }
  });

  const leaked = raw.units.filter((unit) => unit.armId === 'mem0-oss' && unit.phase === 'A');
  assert.equal(leaked.length, 4);
  assert.ok(leaked.every((unit) => unit.status === 'FAILED'), 'leaked prior state must fail phase A');
  assert.ok(leaked.every((unit) => unit.decisionResponse === null));
});

test('a failed reset fails its unit and never becomes a measured decision', async () => {
  const { raw } = await acceptanceRun({
    executeAdapter: async (request) => {
      if (request.operation === 'reset' && request.armId === 'basic-memory') {
        return adapterEnvelope(request, primary.applicability, {
          status: 'FAILED',
          failure: { cause: 'ADAPTER_ERROR', message: 'injected reset failure', operation: 'reset' }
        });
      }
      return adapterEnvelope(request, primary.applicability);
    }
  });

  const resets = raw.units.filter((unit) => unit.armId === 'basic-memory' && unit.phase === 'RESET');
  assert.equal(resets.length, 4);
  assert.ok(resets.every((unit) => unit.status === 'FAILED'));
  assert.ok(resets.every((unit) => unit.failure !== null));
  // The plan is still complete: a failed reset does not delete the units after it.
  assert.equal(raw.units.length, 308);
});

test('unverified persistence is never reported as measured', async () => {
  const { raw } = await acceptanceRun({
    executeAdapter: async (request) => {
      const envelope = adapterEnvelope(request, primary.applicability);
      if (request.operation !== 'verify' || request.armId !== 'shadowgraph-compact') return envelope;
      return {
        ...envelope,
        result: {
          ...envelope.result,
          persistenceEvidence: { ...envelope.result.persistenceEvidence, verified: false }
        }
      };
    }
  });

  const affected = decisionUnitsFor(raw, 'shadowgraph-compact');
  assert.ok(affected.length > 0);
  assert.ok(
    affected.every((unit) => unit.status === 'FAILED'),
    'a claim of persistence the adapter did not verify must fail the unit'
  );
});

test('a malformed adapter envelope fails the unit without disclosing internals', async () => {
  const { raw } = await acceptanceRun({
    executeAdapter: async (request) => {
      if (request.operation === 'retrieve' && request.armId === 'graphiti') {
        return { schemaVersion: 1, operation: request.operation, result: 'not an object' };
      }
      return adapterEnvelope(request, primary.applicability);
    }
  });

  const failed = unitsFor(raw, 'graphiti').filter((unit) => unit.status === 'FAILED');
  assert.ok(failed.length > 0);
  for (const unit of failed) {
    assert.ok(typeof unit.failure.cause === 'string' && unit.failure.cause.length > 0);
    // The public failure must not carry the thrown text, a stack, or a path.
    const message = unit.failure.message;
    assert.equal(message.includes('not an object'), false);
    assert.equal(/\bat\s+\w+\s+\(/u.test(message), false, 'a stack frame reached public output');
    assert.equal(/[A-Za-z]:\\|\/(?:home|mnt|usr)\//u.test(message), false, 'a path reached public output');
  }
});

test('an outer model failure never falls back to a fabricated decision', async () => {
  const { raw } = await acceptanceRun({
    requestOuter: async () => {
      throw new Error('injected outer transport failure');
    }
  });

  const decisionUnits = raw.units.filter(
    (unit) => unit.phase !== 'RESET' && unit.status !== 'EXCLUDED'
  );
  assert.ok(decisionUnits.length > 0);
  for (const unit of decisionUnits) {
    assert.equal(unit.status, 'FAILED');
    assert.equal(unit.decisionResponse, null, 'no decision may be invented for a failed outer call');
    assert.equal(unit.failure.message.includes('injected outer transport failure'), false);
  }
  // With nothing measured, the run must say so rather than report an empty result.
  assert.notEqual(raw.zeroResult, null);
  assert.ok(raw.zeroResult.causes.length > 0);
});

test('a stalled unit is failed once by the watchdog, not retried', async () => {
  let outerCalls = 0;
  const { raw } = await acceptanceRun({
    progress: (() => {
      const events = [];
      let active = null;
      return {
        events,
        async append(event) {
          events.push(structuredClone(event));
          if (event.event === 'unit_started') {
            active = {
              armId: event.armId,
              scenarioId: event.scenarioId,
              repetition: event.repetition,
              phase: event.phase
            };
          } else if (['unit_finished', 'unit_failed', 'run_interrupted', 'run_finished'].includes(event.event)) {
            active = null;
          }
        },
        async watchdogState() {
          // Every phase B unit is reported as stalled; nothing else is.
          const stalled = active !== null && active.phase === 'B';
          return {
            stalled,
            cause: stalled ? 'UNIT_TIMEOUT' : null,
            elapsedMs: stalled ? 900_000 : 0,
            referenceEvent: active === null ? null : 'unit_started',
            activeCorrelation: active === null ? null : { ...active }
          };
        }
      };
    })(),
    requestOuter: async ({ correlation, namespace }) => {
      outerCalls += 1;
      return {
        decision: decision(correlation.phase, namespace),
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        providerModel: 'stub-outer-model',
        requestCount: 1,
        correlation: { ...correlation }
      };
    }
  });

  const phaseB = raw.units.filter((unit) => unit.phase === 'B');
  assert.equal(phaseB.length, 28);
  assert.ok(phaseB.every((unit) => unit.status === 'FAILED'), 'a stalled unit must fail');
  assert.ok(phaseB.every((unit) => unit.failure !== null));
  // 264 planned decision calls minus the 28 phase B units that never completed
  // one - and no unit is attempted twice.
  assert.equal(outerCalls <= 264, true, 'a stalled unit must not be retried');
});

test('an interruption stops the run and reports it rather than completing the plan', async () => {
  const controller = new AbortController();
  let started = 0;
  const { raw } = await acceptanceRun({
    signal: controller.signal,
    executeAdapter: async (request) => {
      if (request.operation === 'reset') {
        started += 1;
        if (started === 5) controller.abort();
      }
      return adapterEnvelope(request, primary.applicability);
    }
  });

  assert.equal(raw.status, 'INTERRUPTED');
  assert.ok(raw.units.length > 0, 'the units completed before the interruption are retained');
  assert.ok(raw.units.length < 308, 'an interrupted run must not report the full plan');
  assert.equal(new Set(raw.units.map((unit) => unit.unitId)).size, raw.units.length);
});

test('resuming an interrupted attempt completes the plan without redoing measured units', async (t) => {
  const controller = new AbortController();
  let resets = 0;
  const first = await acceptanceRun({
    runId: 'run-acceptance-resume',
    attemptId: 'attempt-acceptance-resume-1',
    signal: controller.signal,
    executeAdapter: async (request) => {
      if (request.operation === 'reset') {
        resets += 1;
        if (resets === 6) controller.abort();
      }
      return adapterEnvelope(request, primary.applicability);
    }
  });
  assert.equal(first.raw.status, 'INTERRUPTED');
  const priorUnits = first.raw.units.length;
  assert.ok(priorUnits > 0 && priorUnits < 308);
  const priorBytes = JSON.stringify(first.raw.units);

  const resume = await materializePriorAttempt(t, first.raw);
  const replayed = [];
  const second = await acceptanceRun({
    runId: 'run-acceptance-resume',
    attemptId: 'attempt-acceptance-resume-2',
    resume,
    executeAdapter: async (request) => {
      replayed.push(unitIdFor({
        armId: request.armId,
        scenarioId: request.scenarioId,
        repetition: request.repetition,
        phase: request.phase
      }));
      return adapterEnvelope(request, primary.applicability);
    }
  });

  assert.equal(second.raw.units.length, 308, 'the resumed attempt must finish the plan');
  assert.equal(second.raw.status, 'COMPLETE');
  assert.deepEqual(second.raw.attemptIds, [
    'attempt-acceptance-resume-1',
    'attempt-acceptance-resume-2'
  ]);
  // Prior evidence is carried forward byte-for-byte, not re-measured.
  assert.equal(JSON.stringify(second.raw.units.slice(0, priorUnits)), priorBytes);
  assert.equal(
    new Set(second.raw.units.map((unit) => unit.unitId)).size,
    308,
    'resume must not duplicate a unit'
  );
  const alreadyDone = new Set(first.raw.units.map((unit) => unit.unitId));
  assert.equal(
    replayed.some((unitId) => alreadyDone.has(unitId)),
    false,
    'a unit with terminal evidence must not be run again'
  );
});

function progressInput(event, unit = null, evidence = null) {
  return {
    event,
    armId: unit?.armId ?? null,
    scenarioId: unit?.scenarioId ?? null,
    repetition: unit?.repetition ?? null,
    phase: unit?.phase ?? null,
    evidence
  };
}

async function writeDurableJson(filePath, value) {
  const file = await open(filePath, 'wx', 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Write the ledgers a diagnostic resume reads, exactly as the CLI would. */
async function materializePriorAttempt(t, raw) {
  const directory = await mkdtemp(path.join(tmpdir(), 'shadowgraph-v11-acceptance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const progressPath = path.join(directory, `${raw.attemptId}.progress.ndjson`);
  const unitEvidencePath = path.join(directory, `${raw.attemptId}.units.ndjson`);
  const previousRawPath = path.join(directory, `${raw.attemptId}.raw.json`);
  const progress = await createProgressLedger({
    path: progressPath,
    runId: raw.runId,
    attemptId: raw.attemptId
  });
  const unitEvidence = await createUnitEvidenceLedger({
    path: unitEvidencePath,
    runId: raw.runId,
    attemptId: raw.attemptId,
    sensitiveValues: []
  });
  try {
    await progress.append(progressInput('run_started', null, {
      mode: raw.mode,
      implementationLockHash: raw.implementationLockHash,
      environmentLockHash: raw.environmentLockHash
    }));
    for (const unit of raw.units) {
      await progress.append(progressInput('unit_started', unit, { seed: unit.seed }));
      await unitEvidence.append(unit);
      const terminal = unit.status === 'FAILED' ? 'unit_failed' : 'unit_finished';
      await progress.append(progressInput(terminal, unit, unit.status === 'FAILED'
        ? { status: unit.status, cause: unit.failure.cause, operation: unit.failure.operation }
        : { status: unit.status }));
      await progress.append(progressInput('checkpoint', unit, { status: unit.status }));
    }
    await progress.append(progressInput('run_interrupted', null, { cause: 'OPERATOR_INTERRUPTION' }));
  } finally {
    await progress.close();
    await unitEvidence.close();
  }
  await writeDurableJson(previousRawPath, raw);
  return {
    previousRawPath,
    previousRawSha256: sha256(await readFile(previousRawPath)),
    attemptLedgers: [{
      attemptId: raw.attemptId,
      progressPath,
      progressSha256: sha256(await readFile(progressPath)),
      unitEvidencePath,
      unitEvidenceSha256: sha256(await readFile(unitEvidencePath))
    }],
    infrastructureRepaired: false
  };
}
