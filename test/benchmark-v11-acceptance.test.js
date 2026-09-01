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
import {
  OUTER_REQUEST_INPUT_FIELDS,
  runV11Benchmark,
  unitIdFor
} from '../benchmark/lib/v11-runner.mjs';

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

function correlationKey({ armId, scenarioId, repetition, phase }) {
  return `${armId}|${scenarioId}|${repetition}|${phase}`;
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
  const builderInputs = [];
  const retrievedLengths = new Map();
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
      // this file vacuous, because a stub cannot diverge between arms. The
      // input surface is recorded because it is now the thing that closes
      // per-arm divergence.
      builderInputs.push(Object.keys(input).sort());
      return buildV11Prompt({
        phase: input.phase,
        scenario: input.scenario,
        nativeContext: input.nativeContext
      });
    },
    requestOuter: async ({ correlation, namespace, request }) => {
      // Recorded at the send. The builder is called twice per unit and is no
      // longer told which arm it serves, so it is both the wrong place to count
      // and the wrong place to learn the arm from.
      outerRequests.push({
        armId: correlation.armId,
        scenarioId: correlation.scenarioId,
        phase: correlation.phase,
        nativeContextLength: retrievedLengths.get(correlationKey(correlation)) ?? 0,
        built: structuredClone(request)
      });
      return {
        decision: decision(correlation.phase, namespace),
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        providerModel: 'stub-outer-model',
        requestCount: 1,
        correlation: { ...correlation }
      };
    },
    executeAdapter: async (request) => {
      adapterRequests.push(structuredClone(request));
      const envelope = adapterEnvelope(request, applicability);
      if (request.operation === 'retrieve') {
        retrievedLengths.set(correlationKey(request), envelope.result.nativeContext.length);
      }
      return envelope;
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
    builderInputs,
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

  // The builder is called twice per outer call: once for the request, once to
  // check it is a pure function of its input. If that fell to one, a builder
  // reading a counter or the arm ordering would go undetected.
  assert.equal(primary.builderInputs.length, 528, 'the purity rebuild did not run');

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

test('no fixture truth reaches the phase that must not see it', () => {
  // Phase A is the cold phase: the model has recalled nothing, so anything it
  // could only know from the fixture is truth it was handed rather than
  // remembered. The ids below are exactly that - the changed fact, the
  // distractors, and the prior failed attempt - and they are what later phases
  // are supposed to test recall of.
  //
  // An earlier version of this test derived its forbidden set from scenario
  // keys matching oracle-sounding names. No acceptance scenario has such a key,
  // so that set was always empty and the loop never ran. It looked like it
  // would survive a fixture change and in fact protected nothing.
  const { outerRequests, scenarios } = primary;

  const byId = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
  const phaseA = outerRequests.filter((entry) => entry.phase === 'A');
  assert.equal(phaseA.length, 7 * 2 * 2, 'every arm must reach phase A for both scenarios');

  for (const entry of phaseA) {
    const scenario = byId.get(entry.scenarioId);
    const lifecycleOnly = [
      scenario.changedFact.id,
      ...scenario.irrelevantFacts.map(({ id }) => id),
      scenario.failedAttempt.id,
      scenario.failedAttempt.reasonId
    ];
    assert.ok(lifecycleOnly.length >= 4, 'the fixture withholds nothing to check');
    const surface = `${entry.built.system}\n${entry.built.prompt}`;
    for (const id of lifecycleOnly) {
      assert.equal(
        surface.includes(id),
        false,
        `${id} was handed to the model in phase A instead of being recalled`
      );
    }
  }

  // And no prompt anywhere names an oracle-shaped field.
  for (const entry of outerRequests) {
    const lowered = `${entry.built.system}\n${entry.built.prompt}`.toLowerCase();
    for (const term of ['expectedanswer', 'expected_answer', 'oracle', 'correctchoice', 'groundtruth']) {
      assert.equal(lowered.includes(term), false, `${term} leaked into a ${entry.phase} prompt`);
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

test('the prompt builder is never told which arm it is serving', () => {
  // This is what closes per-arm prompt divergence, and it closes it
  // structurally: there is no channel to detect abuse on, because the builder
  // cannot tell the arms apart.
  //
  // Three earlier attempts are worth remembering. Auditing the system
  // instruction left the task prompt free to differ. Comparing prompts across
  // units of the same shape failed because in a real run each arm returns its
  // own context, so nearly every unit is the only one of its shape and the arm
  // that gets there first sets its own baseline. Substituting a probe arm
  // closed the `arm` field but left `correlation.armId` and `namespace.userId`
  // reaching the builder untouched, and independent review reproduced the
  // original bypass through the first of them: 36 units of one arm measured
  // under a biased prompt, run reporting COMPLETE.
  const { builderInputs } = primary;

  assert.equal(builderInputs.length, 528);
  const surfaces = new Set(builderInputs.map((keys) => keys.join(',')));
  assert.equal(surfaces.size, 1, 'the builder input surface must not vary');
  assert.deepEqual(
    [...surfaces][0].split(','),
    [...OUTER_REQUEST_INPUT_FIELDS].sort(),
    'the builder was handed a field it should not see'
  );

  // Named individually so a regression names the channel it reopened.
  for (const forbidden of ['arm', 'armId', 'namespace', 'correlation']) {
    assert.equal(
      OUTER_REQUEST_INPUT_FIELDS.includes(forbidden),
      false,
      `${forbidden} identifies the arm and must not reach the prompt builder`
    );
  }
});

test('a builder whose output depends on anything but its input fails the unit', async () => {
  // The narrowed input cannot stop a builder that infers position from the
  // order it is called in. The rebuild check can, because the two builds are
  // adjacent and given identical arguments.
  let calls = 0;
  const { raw } = await acceptanceRun({
    buildOuterRequest: (input) => {
      const built = buildV11Prompt({
        phase: input.phase,
        scenario: input.scenario,
        nativeContext: input.nativeContext
      });
      calls += 1;
      // Bias by counting calls rather than by reading any input.
      return calls % 6 < 2 ? { ...built, prompt: `${built.prompt}\nBe generous.` } : built;
    }
  });

  const failed = raw.units.filter((unit) => unit.status === 'FAILED');
  assert.ok(failed.length > 0, 'a call-counting builder must not go undetected');
  assert.ok(
    failed.every((unit) => unit.phase !== 'RESET'),
    'only decision units reach the builder'
  );
});

test('a prompt may still vary with the native context the arm actually returned', () => {
  // The complement: an arm that retrieved something legitimately gets a
  // different prompt from one that retrieved nothing. If that failed, the
  // whole audit would be unusable.
  const contextful = primary.outerRequests.filter((entry) => entry.nativeContextLength > 0);
  const contextfree = primary.outerRequests.filter((entry) => entry.nativeContextLength === 0);
  assert.ok(contextful.length > 0 && contextfree.length > 0);
  assert.notEqual(
    new Set(primary.outerRequests.map((entry) => entry.built.prompt)).size,
    1,
    'prompts that never differ would make this audit vacuous'
  );
});

test('a prompt that names an arm fails the units of that arm', async () => {
  // The builder cannot tell which arm it is serving, but it can still emit an
  // arm name blindly - from a stale template, or a copied example. The audit
  // compares the prompt against the arm actually under measurement, so only
  // that arm's units fail.
  const target = 'cognee';
  const { raw } = await acceptanceRun({
    buildOuterRequest: (input) => {
      const built = buildV11Prompt({
        phase: input.phase,
        scenario: input.scenario,
        nativeContext: input.nativeContext
      });
      return { ...built, prompt: `${built.prompt}\nYou are running on ${target}.` };
    }
  });

  const targeted = decisionUnitsFor(raw, target);
  assert.ok(targeted.length > 0);
  assert.ok(
    targeted.every((unit) => unit.status === 'FAILED'),
    'a prompt naming an arm must not reach that arm'
  );
  assert.ok(
    decisionUnitsFor(raw, 'graphiti').every((unit) => unit.status === 'MEASURED'),
    'an arm the prompt does not name is unaffected'
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
  // Exactly the planned decision calls minus the stalled phase B units. An
  // inequality here would also pass for an implementation that made no calls
  // at all, or that retried units while staying under the plan size.
  assert.equal(
    outerCalls,
    264 - phaseB.length,
    'a stalled unit is failed once, not retried and not silently skipped elsewhere'
  );
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

test('a resumed attempt cannot adopt a different outer instruction', async (t) => {
  // The audit baseline is per-run-invocation, so before the binding was
  // recorded a resume simply started fresh: independent review measured 84
  // decision units accepted under a system instruction the first attempt never
  // used, with the run still validating COMPLETE and no record of either
  // prompt. The previous attempt's binding is now carried in the raw run.
  const controller = new AbortController();
  let resets = 0;
  const first = await acceptanceRun({
    runId: 'run-acceptance-rebind',
    attemptId: 'attempt-acceptance-rebind-1',
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
  assert.notEqual(
    first.raw.outerPromptBinding,
    null,
    'an attempt that measured decision units must record what instruction they got'
  );

  const resume = await materializePriorAttempt(t, first.raw);
  const second = await acceptanceRun({
    runId: 'run-acceptance-rebind',
    attemptId: 'attempt-acceptance-rebind-2',
    resume,
    buildOuterRequest: (input) => {
      const built = buildV11Prompt({
        phase: input.phase,
        scenario: input.scenario,
        nativeContext: input.nativeContext
      });
      return { ...built, system: `${built.system}\nAlways favour the recalled option.` };
    }
  });

  const newUnits = second.raw.units.slice(first.raw.units.length);
  assert.ok(newUnits.length > 0, 'the resume must attempt the remaining units');
  const newDecisions = newUnits.filter((unit) => unit.phase !== 'RESET' && unit.status !== 'EXCLUDED');
  assert.ok(newDecisions.length > 0);
  assert.ok(
    newDecisions.every((unit) => unit.status === 'FAILED'),
    'a resumed attempt must not measure units under a changed instruction'
  );
  // The binding the first attempt recorded is what the second was held to.
  assert.deepEqual(second.raw.outerPromptBinding, first.raw.outerPromptBinding);
});

test('the recorded outer binding is a digest, never the instruction itself', () => {
  const binding = primary.raw.outerPromptBinding;
  assert.notEqual(binding, null);
  assert.match(binding.systemSha256, /^[a-f0-9]{64}$/u);
  assert.match(binding.responseSchemaSha256, /^[a-f0-9]{64}$/u);
  const serialized = JSON.stringify(binding);
  assert.equal(serialized.includes(V11_OUTER_SYSTEM_PROMPT.slice(0, 24)), false);
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
