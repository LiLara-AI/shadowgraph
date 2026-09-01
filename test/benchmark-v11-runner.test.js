import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { aggregateRun } from '../benchmark/lib/aggregate.mjs';
import {
  requestOuterDecision,
  STANDARD_DECISION_RESPONSE_SCHEMA
} from '../benchmark/lib/outer-model.mjs';
import { createProgressLedger, createUnitEvidenceLedger } from '../benchmark/lib/progress.mjs';
import { validateRawRun } from '../benchmark/lib/validate.mjs';
import {
  recordContentSha256,
  unitIdFor as contractUnitIdFor
} from '../benchmark/lib/v11-contract.mjs';
import {
  V11_PHASES,
  runV11Benchmark,
  unitIdFor
} from '../benchmark/lib/v11-runner.mjs';

const OPERATION_FIELDS = [
  'memoryReadOperations',
  'memoryWriteOperations',
  'mcpToolCalls',
  'outerDecisionModelCalls',
  'internalMemoryModelCalls',
  'embeddingCalls',
  'persistenceVerificationOperations'
];

const HASHES = Object.freeze({
  preregistrationSha256: '738ee8b4813fab77da2e4e24582b12e756686650e4c39fad41c5337f831f5dac',
  amendment001Sha256: '2b209df6ca46a179e332acd4ed0b16a35a089f5c14575dd86353db0dc7249c4a',
  amendment002Sha256: '08e12eca3f93bd67cfeaf90a2064f91beb240e78a8fd63ed8645da78c0d88f1b',
  implementationLockHash: '4'.repeat(64),
  environmentLockHash: '5'.repeat(64)
});
const AMENDMENT_002_PATH = fileURLToPath(
  new URL('../benchmark/preregistration-amendment-002.json', import.meta.url)
);

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

test('unitIdFor is unambiguous when arm and scenario ids contain colons', () => {
  const left = unitIdFor({ armId: 'a:b', scenarioId: 'c', repetition: 0, phase: 'A' });
  const right = unitIdFor({ armId: 'a', scenarioId: 'b:c', repetition: 0, phase: 'A' });
  assert.notEqual(left, right);
  assert.equal(new Set([left, right]).size, 2);
});

test('unitIdFor is one bounded domain-separated identity shared with the contract', () => {
  assert.strictEqual(unitIdFor, contractUnitIdFor);
  const correlation = {
    armId: 'a'.repeat(256),
    scenarioId: 'b'.repeat(256),
    repetition: Number.MAX_SAFE_INTEGER,
    phase: 'ISOLATION_PROJECT'
  };
  const id = unitIdFor(correlation);
  assert.match(id, /^unit:[a-f0-9]{64}$/u);
  assert.ok(id.length <= 256);
  const canonicalCorrelation = JSON.stringify({
    armId: correlation.armId,
    phase: correlation.phase,
    repetition: correlation.repetition,
    scenarioId: correlation.scenarioId
  });
  const expectedDigest = createHash('sha256')
    .update('shadowgraph:v1.1:unit-id:v1', 'utf8')
    .update('\0', 'utf8')
    .update(canonicalCorrelation, 'utf8')
    .digest('hex');
  assert.equal(id, `unit:${expectedDigest}`);
  assert.equal(id, unitIdFor(structuredClone(correlation)));
  for (const distinct of [
    { ...correlation, armId: `${'a'.repeat(255)}b` },
    { ...correlation, scenarioId: `${'b'.repeat(255)}a` },
    { ...correlation, repetition: Number.MAX_SAFE_INTEGER - 1 },
    { ...correlation, phase: 'ISOLATION_USER' }
  ]) {
    assert.notEqual(id, unitIdFor(distinct));
  }
  assert.throws(
    () => unitIdFor({ ...correlation, attemptId: 'attempt-must-not-change-unit-state' }),
    /unknown.*unit.*attemptId/iu
  );
});

function applicability(userIsolation = 'SUPPORTED', persistence = 'SUPPORTED') {
  return {
    userIsolation: {
      status: userIsolation,
      reason: userIsolation === 'SUPPORTED' ? null : 'native user isolation is not applicable'
    },
    persistence: {
      status: persistence,
      reason: persistence === 'SUPPORTED' ? null : 'the control intentionally persists no records'
    }
  };
}

function arm(overrides = {}) {
  return {
    id: 'mem0-oss',
    name: 'Mem0 OSS',
    applicability: applicability(),
    ...overrides
  };
}

function scenario(overrides = {}) {
  return {
    id: 'ACC_RUNNER_1',
    projectId: 'project-primary',
    userId: 'user-primary',
    isolationProjectId: 'project-alternate',
    isolationUserId: 'user-alternate',
    task: 'Choose a safe migration approach.',
    failedAttempt: {
      id: 'failed-attempt-one',
      approachId: 'unsafe-approach',
      reasonId: 'known-failure-reason',
      reason: 'The unsafe approach previously failed.'
    },
    ...overrides
  };
}

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

function decision(phase) {
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
    memoryProjectId: 'project-primary',
    memoryUserId: 'user-primary'
  };
}

function adapterEnvelope(request, { status = 'SUCCEEDED', failure = null } = {}) {
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
  const emptyRetrieval = request.armId === 'no-memory'
    || ['ISOLATION_PROJECT', 'ISOLATION_USER'].includes(request.phase);
  return {
    schemaVersion: 1,
    operation: request.operation,
    runId: request.runId,
    attemptId: request.attemptId,
    phase: request.phase,
    armId: request.armId,
    scenarioId: request.scenarioId,
    repetition: request.repetition,
    status,
    result: status === 'SUCCEEDED'
      ? {
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
        }
      : { nativeContext: [], persistenceEvidence: null, isolationEvidence: null },
    failure,
    operations: emptyOperations(operationCounts),
    storage: measuredStorage()
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

function progressRecorder(onAppend = null, onWatchdog = null) {
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
      await onAppend?.(event, events);
    },
    async watchdogState() {
      return await onWatchdog?.(structuredClone(activeCorrelation), events) ?? {
        stalled: false,
        cause: null,
        elapsedMs: 0,
        referenceEvent: activeCorrelation === null ? null : 'unit_started',
        activeCorrelation: structuredClone(activeCorrelation)
      };
    }
  };
}

function baseOptions(overrides = {}) {
  const clock = fakeClock();
  const progress = progressRecorder();
  return {
    runId: 'run-v11-1',
    attemptId: 'attempt-v11-1',
    scored: false,
    arms: [arm()],
    scenarios: [scenario()],
    repetitions: 1,
    seeds: [17],
    ...HASHES,
    amendment002Path: AMENDMENT_002_PATH,
    progress,
    persistUnit: async () => {},
    now: clock.now,
    monotonicNow: clock.monotonicNow,
    buildOuterRequest: ({ phase }) => ({
      system: 'Common system instruction.',
      prompt: `Common prompt for ${phase}.`,
      responseSchema: { ...STANDARD_DECISION_RESPONSE_SCHEMA }
    }),
    requestOuter: async ({ correlation }) => ({
      decision: decision(correlation.phase),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      providerModel: 'provider-model',
      requestCount: 1,
      correlation: { ...correlation }
    }),
    executeAdapter: async (request) => adapterEnvelope(request),
    ...overrides
  };
}

function noMemoryArm() {
  return arm({
    id: 'no-memory',
    name: 'No Memory',
    applicability: {
      userIsolation: {
        status: 'NOT_APPLICABLE',
        reason: 'control has no memory system or native user namespace'
      },
      persistence: {
        status: 'NOT_APPLICABLE',
        reason: 'control intentionally persists no records'
      }
    }
  });
}

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

async function ledgerArtifact(progressPath, unitEvidencePath, attemptId) {
  return {
    attemptId,
    progressPath,
    progressSha256: sha256(await readFile(progressPath)),
    unitEvidencePath,
    unitEvidenceSha256: sha256(await readFile(unitEvidencePath))
  };
}

async function materializePriorAttempt(t, raw, extraStarted = []) {
  const directory = await mkdtemp(path.join(tmpdir(), 'shadowgraph-v11-resume-'));
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
    for (const started of extraStarted) {
      await progress.append(progressInput('unit_started', started, { seed: started.seed }));
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
    attemptLedgers: [await ledgerArtifact(progressPath, unitEvidencePath, raw.attemptId)],
    infrastructureRepaired: false
  };
}

function assertNoAcceptanceClaims(value) {
  const stack = [value];
  while (stack.length > 0) {
    const current = stack.pop();
    if (Array.isArray(current)) {
      stack.push(...current);
      continue;
    }
    if (current === null || typeof current !== 'object') continue;
    for (const [key, child] of Object.entries(current)) {
      assert.doesNotMatch(key, /(?:scores?|rankings?|winner|best|marketing|deltas?)/iu);
      stack.push(child);
    }
  }
}

test('integrated runner executes retrieve → outer → persist → verify and checkpoints every terminal unit', async () => {
  const trace = [];
  let phaseAPersisted = false;
  const progress = progressRecorder();
  const options = baseOptions({
    progress,
    executeAdapter: async (request) => {
      trace.push(`${request.phase}:${request.operation}`);
      if (request.phase === 'A' && request.operation === 'persist') phaseAPersisted = true;
      return adapterEnvelope(request);
    },
    requestOuter: async ({ correlation }) => {
      trace.push(`${correlation.phase}:outer`);
      if (correlation.phase === 'A') assert.equal(phaseAPersisted, false, 'Phase A answer must precede persistence');
      return {
        decision: decision(correlation.phase),
        usage: null,
        providerModel: null,
        requestCount: 1,
        correlation: { ...correlation }
      };
    }
  });

  const raw = await runV11Benchmark(options);

  assert.equal(raw.mode, 'ACCEPTANCE');
  assert.equal(raw.status, 'COMPLETE');
  assert.equal(raw.units.length, V11_PHASES.length);
  assert.deepEqual(
    trace.filter((entry) => entry.startsWith('A:')),
    ['A:retrieve', 'A:outer', 'A:persist', 'A:verify']
  );
  assert.deepEqual(
    trace.filter((entry) => entry.startsWith('E:')),
    ['E:persist', 'E:verify', 'E:retrieve', 'E:outer', 'E:persist', 'E:verify']
  );
  assert.equal(raw.units.find((unit) => unit.phase === 'A').status, 'MEASURED');
  assert.equal(raw.arms[0].status, 'MEASURED');

  const progressNames = progress.events.map((event) => event.event);
  assert.equal(progressNames[0], 'run_started');
  assert.equal(progressNames.at(-1), 'run_finished');
  for (let index = 0; index < progress.events.length; index += 1) {
    const event = progress.events[index];
    if (!['unit_finished', 'unit_failed'].includes(event.event)) continue;
    assert.equal(progress.events[index + 1]?.event, 'checkpoint');
    const nextStarted = progress.events.slice(index + 1).findIndex((candidate) => candidate.event === 'unit_started');
    if (nextStarted !== -1) assert.ok(nextStarted >= 1, 'checkpoint must precede the next unit');
  }
  assertNoAcceptanceClaims(raw);
});

test('a failed unit remains raw evidence, later units continue, and arm status is derived mechanically', async () => {
  const progress = progressRecorder();
  const raw = await runV11Benchmark(baseOptions({
    progress,
    executeAdapter: async (request) => {
      if (request.phase === 'B' && request.operation === 'retrieve') {
        return adapterEnvelope(request, {
          status: 'FAILED',
          failure: { cause: 'OPERATION_FAILED', message: 'fixture failure detail' }
        });
      }
      return adapterEnvelope(request);
    }
  }));

  const failed = raw.units.find((unit) => unit.phase === 'B');
  assert.equal(failed.status, 'FAILED');
  assert.deepEqual(failed.failure, {
    cause: 'OPERATION_FAILED',
    operation: 'retrieve',
    message: 'Measured adapter operation failed'
  });
  assert.equal(raw.units.find((unit) => unit.phase === 'C').status, 'MEASURED');
  assert.equal(raw.arms[0].status, 'PARTIAL_FAILED');
  assert.ok(progress.events.some((event) => event.event === 'unit_failed' && event.phase === 'B'));
});

test('diagnostic resume preserves prior failed evidence byte-for-byte and runs only never-started units', async (t) => {
  const controller = new AbortController();
  const firstProgress = progressRecorder((event) => {
    if (event.event === 'checkpoint' && event.phase === 'A') controller.abort();
  });
  const first = await runV11Benchmark(baseOptions({
    progress: firstProgress,
    signal: controller.signal,
    executeAdapter: async (request) => {
      if (request.phase === 'A' && request.operation === 'retrieve') {
        return adapterEnvelope(request, {
          status: 'FAILED',
          failure: { cause: 'CONTRACT_FAILURE', message: 'private fixture detail' }
        });
      }
      return adapterEnvelope(request);
    }
  }));
  assert.equal(first.status, 'INTERRUPTED');
  const priorBytes = JSON.stringify(first.units);
  const resume = await materializePriorAttempt(t, first);

  const resumedTrace = [];
  const resumed = await runV11Benchmark(baseOptions({
    attemptId: 'attempt-v11-2',
    progress: progressRecorder(),
    executeAdapter: async (request) => {
      resumedTrace.push(`${request.phase}:${request.operation}`);
      return adapterEnvelope(request);
    },
    resume
  }));

  assert.equal(JSON.stringify(resumed.units.slice(0, first.units.length)), priorBytes);
  assert.equal(resumed.units.find((unit) => unit.phase === 'A').status, 'FAILED');
  assert.ok(!resumedTrace.some((entry) => entry.startsWith('RESET:')));
  assert.ok(!resumedTrace.some((entry) => entry.startsWith('A:')));
  assert.ok(resumedTrace.some((entry) => entry.startsWith('B:')));
  assert.equal(resumed.attemptId, 'attempt-v11-2');
  assert.deepEqual(resumed.attemptIds, ['attempt-v11-1', 'attempt-v11-2']);
  assert.equal(new Set(resumed.units.map((unit) => unit.unitId)).size, resumed.units.length);
  assert.ok(resumed.units.every((unit) => unit.unitId.startsWith('unit:')));
});

test('diagnostic resume never replaces a started unit that had no terminal evidence', async (t) => {
  const controller = new AbortController();
  const firstProgress = progressRecorder((event) => {
    if (event.event === 'checkpoint' && event.phase === 'RESET') controller.abort();
  });
  const first = await runV11Benchmark(baseOptions({
    progress: firstProgress,
    signal: controller.signal
  }));
  const interruptedStartedId = unitIdFor({
    armId: 'mem0-oss',
    scenarioId: 'ACC_RUNNER_1',
    repetition: 0,
    phase: 'A'
  });
  const resume = await materializePriorAttempt(t, first, [{
    armId: 'mem0-oss',
    scenarioId: 'ACC_RUNNER_1',
    repetition: 0,
    phase: 'A',
    seed: 17
  }]);
  const trace = [];
  const resumed = await runV11Benchmark(baseOptions({
    attemptId: 'attempt-v11-2',
    executeAdapter: async (request) => {
      trace.push(`${request.phase}:${request.operation}`);
      return adapterEnvelope(request);
    },
    resume
  }));

  assert.ok(!trace.some((entry) => entry.startsWith('RESET:')));
  assert.ok(!trace.some((entry) => entry.startsWith('A:')));
  assert.ok(trace.some((entry) => entry.startsWith('B:')));
  assert.equal(resumed.units.some((unit) => unit.unitId === interruptedStartedId), false);
  assert.equal(resumed.arms[0].status, 'PARTIAL_FAILED');
  assert.equal(resumed.status, 'INTERRUPTED');
  const definition = {
    arms: [arm()],
    commonExecution: { repetitions: 1, randomSeeds: [17] },
    scenarios: [scenario()],
    marketingThresholds: { noResultText: 'unused', measuredOnlyText: 'unused' }
  };
  assert.equal(validateRawRun(resumed, definition, HASHES.preregistrationSha256).valid, true);
});

test('resume rejects lock changes, reused attempt ids, infrastructure repair, and digest changes', async (t) => {
  const controller = new AbortController();
  const progress = progressRecorder((event) => {
    if (event.event === 'checkpoint' && event.phase === 'RESET') controller.abort();
  });
  const previousRaw = await runV11Benchmark(baseOptions({ progress, signal: controller.signal }));
  const resume = await materializePriorAttempt(t, previousRaw);

  await assert.rejects(
    runV11Benchmark(baseOptions({
      attemptId: 'attempt-v11-2',
      implementationLockHash: '9'.repeat(64),
      resume
    })),
    /implementation lock.*new runId/i
  );
  await assert.rejects(
    runV11Benchmark(baseOptions({ resume })),
    /new attemptId/i
  );
  await assert.rejects(
    runV11Benchmark(baseOptions({
      attemptId: 'attempt-v11-2',
      resume: { ...resume, infrastructureRepaired: true }
    })),
    /infrastructure repair.*new runId/i
  );
  await assert.rejects(
    runV11Benchmark(baseOptions({
      attemptId: 'attempt-v11-2',
      resume: { ...resume, previousRawSha256: '0'.repeat(64) }
    })),
    /previous raw artifact.*sha256/i
  );
});

test('resume validates prior evidence before side effects and preserves the full attempt chain', async (t) => {
  const firstController = new AbortController();
  const firstProgress = progressRecorder((event) => {
    if (event.event === 'checkpoint' && event.phase === 'RESET') firstController.abort();
  });
  const first = await runV11Benchmark(baseOptions({
    progress: firstProgress,
    signal: firstController.signal
  }));
  const firstResume = await materializePriorAttempt(t, first, [{
    armId: 'mem0-oss',
    scenarioId: 'ACC_RUNNER_1',
    repetition: 0,
    phase: 'A',
    seed: 17
  }]);
  const directory = await mkdtemp(path.join(tmpdir(), 'shadowgraph-v11-repeat-resume-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const secondProgressPath = path.join(directory, 'attempt-v11-2.progress.ndjson');
  const secondUnitsPath = path.join(directory, 'attempt-v11-2.units.ndjson');
  const secondRawPath = path.join(directory, 'attempt-v11-2.raw.json');
  const secondProgress = await createProgressLedger({
    path: secondProgressPath,
    runId: 'run-v11-1',
    attemptId: 'attempt-v11-2'
  });
  const secondUnits = await createUnitEvidenceLedger({
    path: secondUnitsPath,
    runId: 'run-v11-1',
    attemptId: 'attempt-v11-2',
    sensitiveValues: []
  });
  let second;
  try {
    second = await runV11Benchmark(baseOptions({
      attemptId: 'attempt-v11-2',
      progress: secondProgress,
      persistUnit: (unit) => secondUnits.append(unit),
      resume: firstResume
    }));
  } finally {
    await secondProgress.close();
    await secondUnits.close();
  }
  await writeDurableJson(secondRawPath, second);
  const secondArtifact = await ledgerArtifact(
    secondProgressPath,
    secondUnitsPath,
    'attempt-v11-2'
  );
  const repeatedResume = {
    previousRawPath: secondRawPath,
    previousRawSha256: sha256(await readFile(secondRawPath)),
    attemptLedgers: [...firstResume.attemptLedgers, secondArtifact],
    infrastructureRepaired: false
  };
  const thirdTrace = [];
  const third = await runV11Benchmark(baseOptions({
    attemptId: 'attempt-v11-3',
    resume: repeatedResume,
    executeAdapter: async (request) => {
      thirdTrace.push(`${request.phase}:${request.operation}`);
      return adapterEnvelope(request);
    }
  }));

  assert.deepEqual(third.attemptIds, ['attempt-v11-1', 'attempt-v11-2', 'attempt-v11-3']);
  assert.equal(third.status, 'INTERRUPTED');
  assert.deepEqual(thirdTrace, []);

  let progressWrites = 0;
  let adapterCalls = 0;
  await assert.rejects(
    runV11Benchmark(baseOptions({
      attemptId: 'attempt-v11-2',
      progress: progressRecorder(() => { progressWrites += 1; }),
      executeAdapter: async (request) => {
        adapterCalls += 1;
        return adapterEnvelope(request);
      },
      resume: { ...firstResume, previousRawSha256: '0'.repeat(64) }
    })),
    /previous raw artifact.*sha256/iu
  );
  assert.equal(progressWrites, 0, 'invalid prior evidence must fail before progress or adapter side effects');
  assert.equal(adapterCalls, 0);
});

test('native user-isolation N/A is an EXCLUDED unit without a synthetic namespace or adapter call', async () => {
  const calls = [];
  const raw = await runV11Benchmark(baseOptions({
    arms: [arm({
      id: 'shadowgraph-full',
      name: 'ShadowGraph Full',
      applicability: {
        userIsolation: {
          status: 'NOT_APPLICABLE',
          reason: 'decision records have a native project namespace but no native user namespace'
        },
        persistence: { status: 'SUPPORTED', reason: null }
      }
    })],
    executeAdapter: async (request) => {
      calls.push(request);
      return adapterEnvelope(request);
    }
  }));

  const userIsolation = raw.units.find((unit) => unit.phase === 'ISOLATION_USER');
  assert.equal(userIsolation.status, 'EXCLUDED');
  assert.match(userIsolation.statusReason, /no native user namespace/i);
  assert.equal(userIsolation.latencyMs, null);
  assert.ok(!calls.some((request) => request.phase === 'ISOLATION_USER'));
  assert.equal(raw.arms[0].status, 'MEASURED');
});

test('invalid retrieve evidence fails closed before outer decision and later adapter operations', async () => {
  const trace = [];
  const outerPhases = [];
  const raw = await runV11Benchmark(baseOptions({
    executeAdapter: async (request) => {
      trace.push(`${request.phase}:${request.operation}`);
      const response = adapterEnvelope(request);
      if (request.phase !== 'A' || request.operation !== 'retrieve') return response;
      const expectedRecord = {
        id: 'unexpected-retrieve-record',
        type: 'decision',
        contentSha256: 'a'.repeat(64)
      };
      return {
        ...response,
        result: {
          ...response.result,
          persistenceEvidence: {
            verified: true,
            expectedRecord,
            matchedRecordIds: [expectedRecord.id],
            observedContentSha256: expectedRecord.contentSha256,
            namespaceRef: request.namespaceRef
          }
        }
      };
    },
    requestOuter: async ({ correlation }) => {
      outerPhases.push(correlation.phase);
      return {
        decision: decision(correlation.phase),
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        providerModel: 'provider-model',
        requestCount: 1,
        correlation: { ...correlation }
      };
    }
  }));

  const phaseA = raw.units.find((unit) => unit.phase === 'A');
  assert.deepEqual(phaseA.failure, {
    cause: 'CONTRACT_FAILURE',
    operation: 'retrieve',
    message: 'Measured operation failed closed'
  });
  assert.equal(phaseA.decisionResponse, null);
  assert.equal(phaseA.adapterEvidence.retrieve, null);
  assert.equal(phaseA.operations.memoryReadOperations, 0);
  assert.equal(phaseA.operations.outerDecisionModelCalls, 0);
  assert.deepEqual(trace.filter((entry) => entry.startsWith('A:')), ['A:retrieve']);
  assert.equal(outerPhases.includes('A'), false);
});

test('outer correlation mismatch fails closed after retrieve and before persist without retry', async () => {
  const trace = [];
  let outerCalls = 0;
  const raw = await runV11Benchmark(baseOptions({
    executeAdapter: async (request) => {
      trace.push(`${request.phase}:${request.operation}`);
      return adapterEnvelope(request);
    },
    requestOuter: async ({ correlation }) => {
      outerCalls += 1;
      return {
        decision: decision(correlation.phase),
        usage: null,
        providerModel: null,
        requestCount: 1,
        correlation: { ...correlation, attemptId: 'wrong-attempt' }
      };
    }
  }));

  const phaseA = raw.units.find((unit) => unit.phase === 'A');
  assert.equal(phaseA.status, 'FAILED');
  assert.deepEqual(phaseA.failure, {
    cause: 'CONTRACT_FAILURE',
    operation: 'outer',
    message: 'Measured operation failed closed'
  });
  assert.equal(phaseA.operations.memoryReadOperations, 1);
  assert.equal(phaseA.operations.outerDecisionModelCalls, 1);
  assert.equal(phaseA.decisionResponse, null);
  assert.deepEqual(trace.filter((entry) => entry.startsWith('A:')), ['A:retrieve']);
  assert.equal(outerCalls, V11_PHASES.length - 3);
  assert.ok(!trace.some((entry) => entry.startsWith('ISOLATION_PROJECT:')));
  assert.ok(!trace.some((entry) => entry.startsWith('ISOLATION_USER:')));
  for (const phase of ['ISOLATION_PROJECT', 'ISOLATION_USER']) {
    assert.deepEqual(raw.units.find((unit) => unit.phase === phase).failure, {
      cause: 'CONTRACT_FAILURE',
      operation: 'verify',
      message: 'Isolation verification requires a valid measured Phase A unit'
    });
  }
});

test('trusted outer HTTP statuses map to public causes without retry or response-detail leakage', async () => {
  const cases = [
    [408, 'TIMEOUT', 'Measured operation exceeded its registered timeout'],
    [502, 'ENDPOINT_UNAVAILABLE', 'Measured endpoint was unavailable'],
    [503, 'ENDPOINT_UNAVAILABLE', 'Measured endpoint was unavailable'],
    [504, 'ENDPOINT_UNAVAILABLE', 'Measured endpoint was unavailable'],
    [429, 'OPERATION_FAILED', 'Measured provider operation failed'],
    [500, 'OPERATION_FAILED', 'Measured provider operation failed']
  ];

  for (const [status, cause, message] of cases) {
    let phaseARequestCalls = 0;
    let phaseAFetchCalls = 0;
    const privateDetail = `private-http-${status}-detail`;
    const raw = await runV11Benchmark(baseOptions({
      requestOuter: async ({ correlation, request }) => {
        if (correlation.phase === 'A') phaseARequestCalls += 1;
        return requestOuterDecision({
          fetchImpl: async () => {
            if (correlation.phase === 'A') {
              phaseAFetchCalls += 1;
              return new Response(JSON.stringify({ error: privateDetail }), { status });
            }
            return new Response(JSON.stringify({
              model: 'provider-model',
              choices: [{
                message: { role: 'assistant', content: JSON.stringify(decision(correlation.phase)) },
                finish_reason: 'stop',
                index: 0
              }],
              usage: null
            }), { status: 200 });
          },
          config: {
            endpoint: 'http://127.0.0.1:11434/v1',
            apiKey: null,
            model: 'provider-model',
            seed: 17,
            temperature: 0,
            maxOutputTokens: 900,
            timeoutMs: 1_000
          },
          correlation,
          request
        });
      }
    }));

    const failure = raw.units.find((unit) => unit.phase === 'A').failure;
    assert.deepEqual(failure, { cause, operation: 'outer', message });
    assert.equal(Object.hasOwn(failure, 'status'), false);
    assert.equal(JSON.stringify(failure).includes(privateDetail), false);
    assert.equal(phaseARequestCalls, 1);
    assert.equal(phaseAFetchCalls, 1);
  }
});

test('persist failure retains measured outer evidence and prevents verify without retry', async () => {
  const trace = [];
  const raw = await runV11Benchmark(baseOptions({
    executeAdapter: async (request) => {
      trace.push(`${request.phase}:${request.operation}`);
      if (request.phase === 'A' && request.operation === 'persist') {
        return adapterEnvelope(request, {
          status: 'FAILED',
          failure: { cause: 'OPERATION_FAILED', message: 'fixture persistence failure' }
        });
      }
      return adapterEnvelope(request);
    }
  }));

  const phaseA = raw.units.find((unit) => unit.phase === 'A');
  assert.equal(phaseA.status, 'FAILED');
  assert.equal(phaseA.failure.operation, 'persist');
  assert.equal(phaseA.operations.memoryReadOperations, 1);
  assert.equal(phaseA.operations.outerDecisionModelCalls, 1);
  assert.equal(phaseA.operations.memoryWriteOperations, 1);
  assert.notEqual(phaseA.decisionResponse, null);
  assert.notEqual(phaseA.adapterEvidence.persist, null);
  assert.equal(phaseA.adapterEvidence.verify, null);
  assert.deepEqual(
    trace.filter((entry) => entry.startsWith('A:')),
    ['A:retrieve', 'A:persist']
  );
});

test('runner writes a complete durable lifecycle through the real progress ledger contract', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'shadowgraph-v11-runner-'));
  const ledgerPath = path.join(directory, 'progress.ndjson');
  const unitPath = path.join(directory, 'units.ndjson');
  const progress = await createProgressLedger({
    path: ledgerPath,
    runId: 'run-v11-1',
    attemptId: 'attempt-v11-1'
  });
  const unitEvidence = await createUnitEvidenceLedger({
    path: unitPath,
    runId: 'run-v11-1',
    attemptId: 'attempt-v11-1',
    sensitiveValues: []
  });

  try {
    const raw = await runV11Benchmark(baseOptions({
      progress,
      persistUnit: (unit) => unitEvidence.append(unit)
    }));
    await progress.close();
    await unitEvidence.close();
    const records = (await readFile(ledgerPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const durableUnits = (await readFile(unitPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(raw.status, 'COMPLETE');
    assert.deepEqual(durableUnits, raw.units);
    assert.equal(records[0].event, 'run_started');
    assert.equal(records.at(-1).event, 'run_finished');
    assert.deepEqual(
      records.map((record) => record.eventNumber),
      Array.from({ length: records.length }, (_, index) => index + 1)
    );
    for (let index = 0; index < records.length; index += 1) {
      if (!['unit_finished', 'unit_failed'].includes(records[index].event)) continue;
      assert.equal(records[index + 1]?.event, 'checkpoint');
    }
  } finally {
    await progress.close();
    await unitEvidence.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('each complete unit is durably handed off before its terminal progress event and next unit', async () => {
  const trace = [];
  const persisted = [];
  const progress = progressRecorder((event) => {
    trace.push(`${event.phase ?? 'run'}:progress:${event.event}`);
  });
  const raw = await runV11Benchmark(baseOptions({
    progress,
    persistUnit: async (unit) => {
      persisted.push(structuredClone(unit));
      trace.push(`${unit.phase}:evidence`);
    }
  }));

  assert.deepEqual(persisted, raw.units);
  for (const unit of raw.units) {
    const started = trace.indexOf(`${unit.phase}:progress:unit_started`);
    const evidence = trace.indexOf(`${unit.phase}:evidence`);
    const terminal = trace.findIndex(
      (entry, index) => index > evidence
        && [`${unit.phase}:progress:unit_finished`, `${unit.phase}:progress:unit_failed`].includes(entry)
    );
    const checkpoint = trace.indexOf(`${unit.phase}:progress:checkpoint`, terminal + 1);
    assert.ok(started < evidence && evidence < terminal && terminal < checkpoint);
    const nextStarted = trace.findIndex(
      (entry, index) => index > checkpoint && entry.endsWith(':progress:unit_started')
    );
    if (nextStarted !== -1) assert.ok(checkpoint < nextStarted);
  }
});

test('long-running units emit correlated heartbeats and a timeout fails once without retry', async () => {
  const progress = progressRecorder();
  let resetCalls = 0;
  let phaseAOuterCalls = 0;
  const raw = await runV11Benchmark(baseOptions({
    heartbeatIntervalMs: 2,
    progress,
    executeAdapter: async (request) => {
      if (request.phase === 'RESET') {
        resetCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return adapterEnvelope(request);
    },
    requestOuter: async ({ correlation }) => {
      if (correlation.phase === 'A') {
        phaseAOuterCalls += 1;
        throw Object.assign(new Error('fixture timeout'), { code: 'UPSTREAM_TIMEOUT' });
      }
      return {
        decision: decision(correlation.phase),
        usage: null,
        providerModel: null,
        requestCount: 1,
        correlation: { ...correlation }
      };
    }
  }));

  const heartbeats = progress.events.filter((event) => event.event === 'heartbeat');
  assert.ok(heartbeats.some((event) => event.phase === 'RESET'));
  assert.ok(heartbeats.every((event) => event.armId === 'mem0-oss' && event.scenarioId === 'ACC_RUNNER_1'));
  assert.equal(resetCalls, 1);
  assert.equal(phaseAOuterCalls, 1);
  assert.deepEqual(raw.units.find((unit) => unit.phase === 'A').failure, {
    cause: 'TIMEOUT',
    operation: 'outer',
    message: 'Measured operation exceeded its registered timeout'
  });
});

for (const [field, fakeHash] of [
  ['preregistrationSha256', '9'.repeat(64)],
  ['amendment001Sha256', '8'.repeat(64)]
]) {
  test(`runner binds ${field} to Amendment 002 before callbacks`, async () => {
    const calls = { progress: 0, adapter: 0, outer: 0, persist: 0, close: 0 };
    await assert.rejects(
      runV11Benchmark(baseOptions({
        [field]: fakeHash,
        progress: progressRecorder(() => { calls.progress += 1; }),
        executeAdapter: async (request) => {
          calls.adapter += 1;
          return adapterEnvelope(request);
        },
        requestOuter: async ({ correlation }) => {
          calls.outer += 1;
          return {
            decision: decision(correlation.phase),
            usage: null,
            providerModel: null,
            requestCount: 1,
            correlation: { ...correlation }
          };
        },
        persistUnit: async () => { calls.persist += 1; },
        closeResources: async () => { calls.close += 1; }
      })),
      /Amendment 002.*(?:preregistration|Amendment 001).*hash/iu
    );
    assert.deepEqual(calls, { progress: 0, adapter: 0, outer: 0, persist: 0, close: 1 });
  });
}

test('runner rejects changed Amendment 002 bytes and arm-matrix contradictions before side effects', async (t) => {
  const source = await readFile(AMENDMENT_002_PATH);
  assert.equal(sha256(source), HASHES.amendment002Sha256);
  const directory = await mkdtemp(path.join(tmpdir(), 'shadowgraph-v11-amendment-'));
  const changedPath = path.join(directory, 'amendment-002.changed.json');
  await writeFile(changedPath, Buffer.concat([source, Buffer.from('\n')]));
  const changedHash = sha256(await readFile(changedPath));
  t.after(() => rm(directory, { recursive: true, force: true }));

  for (const overrides of [
    { amendment002Path: changedPath },
    { amendment002Path: changedPath, amendment002Sha256: changedHash },
    { arms: [arm({ applicability: applicability('NOT_APPLICABLE', 'SUPPORTED') })] }
  ]) {
    let adapterCalls = 0;
    const progress = progressRecorder();
    await assert.rejects(
      runV11Benchmark(baseOptions({
        ...overrides,
        progress,
        executeAdapter: async (request) => {
          adapterCalls += 1;
          return adapterEnvelope(request);
        }
      })),
      /Amendment 002|armMatrix|applicability/iu
    );
    assert.equal(progress.events.length, 0);
    assert.equal(adapterCalls, 0);
  }
});

test('watchdog aborts and races a non-cooperative unit once with exact correlation', async () => {
  let watchdogCalls = 0;
  let resetCalls = 0;
  let resetSignal = null;
  let abortObserved = false;
  const progress = progressRecorder(null, async (activeCorrelation) => {
    watchdogCalls += 1;
    const stalled = activeCorrelation?.phase === 'RESET';
    return {
      stalled,
      cause: stalled ? 'UNIT_TIMEOUT' : null,
      elapsedMs: stalled ? 120_000 : 0,
      referenceEvent: activeCorrelation === null ? null : 'unit_started',
      activeCorrelation
    };
  });
  const raw = await runV11Benchmark(baseOptions({
    heartbeatIntervalMs: 1,
    progress,
    executeAdapter: async (request, { signal }) => {
      if (request.phase === 'RESET') {
        resetCalls += 1;
        resetSignal = signal;
        signal?.addEventListener('abort', () => { abortObserved = true; }, { once: true });
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return adapterEnvelope(request);
    }
  }));

  assert.ok(watchdogCalls > 0);
  assert.equal(resetCalls, 1);
  assert.equal(abortObserved, true);
  assert.equal(resetSignal?.aborted, true);
  assert.deepEqual(raw.units.find((unit) => unit.phase === 'RESET').failure, {
    cause: 'TIMEOUT',
    operation: 'runner',
    message: 'Measured unit exceeded the 120000ms monotonic deadline'
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  const reset = raw.units.find((unit) => unit.phase === 'RESET');
  assert.equal(reset.adapterEvidence.reset, null, 'late non-cooperative completion must not mutate raw evidence');
  assert.equal(reset.operations.memoryReadOperations, 0);
  assert.equal(reset.operations.memoryWriteOperations, 0);
});

test('120000ms monotonic unit bound fires even when recent heartbeats report no stall', async () => {
  let monotonic = 0;
  let resetCalls = 0;
  const raw = await runV11Benchmark(baseOptions({
    heartbeatIntervalMs: 1,
    monotonicNow: () => (monotonic += 120_001),
    executeAdapter: async (request) => {
      if (request.phase === 'RESET') {
        resetCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
      return adapterEnvelope(request);
    }
  }));

  assert.equal(resetCalls, 1);
  assert.equal(raw.units.find((unit) => unit.phase === 'RESET').failure?.cause, 'TIMEOUT');
});

test('nested endpoint errors retain ENDPOINT_UNAVAILABLE instead of becoming contract failures', async () => {
  const raw = await runV11Benchmark(baseOptions({
    requestOuter: async ({ correlation }) => {
      if (correlation.phase === 'A') {
        throw new Error('provider wrapper', {
          cause: Object.assign(new Error('connect failed'), { code: 'ECONNREFUSED' })
        });
      }
      return {
        decision: decision(correlation.phase),
        usage: null,
        providerModel: null,
        requestCount: 1,
        correlation: { ...correlation }
      };
    }
  }));

  assert.deepEqual(raw.units.find((unit) => unit.phase === 'A').failure, {
    cause: 'ENDPOINT_UNAVAILABLE',
    operation: 'outer',
    message: 'Measured endpoint was unavailable'
  });
  assert.equal(raw.units.find((unit) => unit.phase === 'B').status, 'MEASURED');
});

test('isolation phases retrieve, model, persist, and verify in the actual probed namespace', async () => {
  const adapterRequests = [];
  const outerRequests = [];
  await runV11Benchmark(baseOptions({
    executeAdapter: async (request) => {
      adapterRequests.push(structuredClone(request));
      if (['ISOLATION_PROJECT', 'ISOLATION_USER'].includes(request.phase)
        && request.operation === 'verify') {
        return adapterEnvelope(request, {
          status: 'FAILED',
          failure: { cause: 'OPERATION_FAILED', message: 'fixture terminal failure' }
        });
      }
      return adapterEnvelope(request);
    },
    requestOuter: async (input) => {
      outerRequests.push(structuredClone(input));
      return {
        decision: decision(input.correlation.phase),
        usage: null,
        providerModel: null,
        requestCount: 1,
        correlation: { ...input.correlation }
      };
    }
  }));

  const expected = {
    ISOLATION_PROJECT: { projectId: 'project-alternate', userId: 'user-primary' },
    ISOLATION_USER: { projectId: 'project-primary', userId: 'user-alternate' }
  };
  for (const [phase, namespace] of Object.entries(expected)) {
    const phaseRequests = adapterRequests.filter((request) => request.phase === phase);
    assert.deepEqual(phaseRequests.map((request) => request.operation), ['retrieve', 'persist', 'verify']);
    assert.deepEqual(phaseRequests[0].namespace, namespace);
    assert.deepEqual(phaseRequests[1].namespace, {
      projectId: 'project-primary',
      userId: 'user-primary'
    });
    assert.deepEqual(phaseRequests[2].namespace, {
      projectId: 'project-primary',
      userId: 'user-primary'
    });
    assert.deepEqual(phaseRequests.at(-1).payload.alternateNamespace, namespace);
    assert.equal(phaseRequests.at(-1).payload.alternateNamespaceRef, phaseRequests[0].namespaceRef);
    assert.equal(phaseRequests.at(-1).payload.expectedAbsentRecord.type, 'decision');
    assert.match(phaseRequests.at(-1).payload.expectedAbsentRecord.contentSha256, /^[a-f0-9]{64}$/u);
    assert.match(phaseRequests[0].namespaceRef, /^[a-f0-9]{64}$/u);
    assert.notEqual(phaseRequests[0].namespaceRef, phaseRequests[1].namespaceRef);
    assert.deepEqual(outerRequests.find((request) => request.correlation.phase === phase).namespace, namespace);
  }
  const failedAttemptVerify = adapterRequests.find((request) => request.phase === 'E'
    && request.operation === 'verify'
    && request.payload.expectedRecord.type === 'failed_attempt');
  assert.equal(
    failedAttemptVerify.payload.expectedRecord.contentSha256,
    recordContentSha256(scenario().failedAttempt)
  );
});

test('persisted decision ids are deterministic per unit and keep the model decisionId in content', async () => {
  const persisted = [];
  await runV11Benchmark(baseOptions({
    arms: [noMemoryArm()],
    requestOuter: async ({ correlation }) => ({
      decision: { ...decision(correlation.phase), decisionId: 'shared-model-decision' },
      usage: null,
      providerModel: null,
      requestCount: 1,
      correlation: { ...correlation }
    }),
    executeAdapter: async (request) => {
      if (request.operation === 'persist' && request.payload.record.type === 'decision') {
        persisted.push(structuredClone(request.payload.record));
      }
      return adapterEnvelope(
        request,
        ['persist', 'verify'].includes(request.operation)
          ? { status: 'NOT_APPLICABLE' }
          : undefined
      );
    }
  }));

  assert.equal(persisted.length, V11_PHASES.length - 2);
  assert.equal(new Set(persisted.map((record) => record.id)).size, persisted.length);
  assert.ok(persisted.every((record) => record.content.decisionId === 'shared-model-decision'));
  assert.ok(persisted.every((record) => record.id !== record.content.decisionId));
});

test('no-memory project isolation proves only empty alternate retrieval and records no persistence claims', async () => {
  const requests = [];
  const raw = await runV11Benchmark(baseOptions({
    arms: [noMemoryArm()],
    executeAdapter: async (request) => {
      requests.push(structuredClone(request));
      return adapterEnvelope(
        request,
        ['persist', 'verify'].includes(request.operation)
          ? { status: 'NOT_APPLICABLE' }
          : undefined
      );
    }
  }));
  const projectIsolation = raw.units.find((unit) => unit.phase === 'ISOLATION_PROJECT');
  assert.equal(projectIsolation.status, 'MEASURED');
  assert.equal(projectIsolation.adapterEvidence.retrieve.nativeContextCount, 0);
  assert.match(projectIsolation.adapterEvidence.retrieve.namespaceRef, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(projectIsolation.adapterEvidence.retrieve, 'namespace'), false);
  for (const key of ['persist', 'verify']) {
    assert.equal(projectIsolation.adapterEvidence[key].status, 'NOT_APPLICABLE');
    assert.equal(projectIsolation.adapterEvidence[key].persistenceEvidence, null);
    assert.equal(projectIsolation.adapterEvidence[key].isolationEvidence, null);
  }
  const serialized = JSON.stringify(projectIsolation.adapterEvidence);
  assert.equal(serialized.includes('project-alternate'), false);
  assert.equal(serialized.includes('user-primary'), false);
  assert.ok(requests.some((request) => request.phase === 'ISOLATION_PROJECT'
    && request.operation === 'retrieve'
    && request.namespace.projectId === 'project-alternate'));
});

test('resume derives started units from hashed durable ledgers and never reruns a start without terminal evidence', async (t) => {
  const controller = new AbortController();
  controller.abort();
  const first = await runV11Benchmark(baseOptions({
    arms: [noMemoryArm()],
    signal: controller.signal
  }));
  const resetStarted = {
    armId: 'no-memory',
    scenarioId: 'ACC_RUNNER_1',
    repetition: 0,
    phase: 'RESET',
    seed: 17
  };
  const resume = await materializePriorAttempt(t, first, [resetStarted]);
  const trace = [];
  const resumed = await runV11Benchmark(baseOptions({
    arms: [noMemoryArm()],
    attemptId: 'attempt-v11-2',
    resume,
    executeAdapter: async (request) => {
      trace.push(`${request.phase}:${request.operation}`);
      return adapterEnvelope(
        request,
        ['persist', 'verify'].includes(request.operation)
          ? { status: 'NOT_APPLICABLE' }
          : undefined
      );
    }
  }));

  assert.ok(!trace.some((entry) => entry.startsWith('RESET:')));
  assert.ok(trace.some((entry) => entry.startsWith('A:')));
  assert.equal(resumed.units.some((unit) => unit.unitId === unitIdFor({
    armId: 'no-memory',
    scenarioId: 'ACC_RUNNER_1',
    repetition: 0,
    phase: 'RESET'
  })), false);
  assert.equal(resumed.status, 'INTERRUPTED');
  assert.deepEqual(resumed.attemptIds, ['attempt-v11-1', 'attempt-v11-2']);
});

test('runner closes metering resources exactly once on success, interruption, and fatal progress failure', async () => {
  for (const mode of ['success', 'interruption', 'failure']) {
    let closeCalls = 0;
    let resourcesClosed = false;
    const controller = new AbortController();
    if (mode === 'interruption') controller.abort();
    const options = baseOptions({
      signal: controller.signal,
      closeResources: async () => {
        closeCalls += 1;
        resourcesClosed = true;
      },
      ...(mode === 'failure'
        ? {
            progress: {
              async append() {
                throw new Error('fixture progress failure');
              },
              async watchdogState() {
                throw new Error('watchdog must not run after fatal progress failure');
              }
            }
          }
        : {
            progress: progressRecorder((event) => {
              if (['run_finished', 'run_interrupted'].includes(event.event)) {
                assert.equal(resourcesClosed, true, 'terminal progress requires closed resources');
              }
            })
          })
    });

    if (mode === 'failure') {
      await assert.rejects(runV11Benchmark(options), /fixture progress failure/i);
    } else {
      const raw = await runV11Benchmark(options);
      assert.equal(raw.status, mode === 'success' ? 'COMPLETE' : 'INTERRUPTED');
    }
    assert.equal(closeCalls, 1, `${mode} must close resources once`);
  }
});

test('adapter boundary receives no outer authority, credentials, or full scoring fixture', async () => {
  const forbiddenSentinels = [
    'fixture-choice-must-stay-harness-side',
    'fixture-private-marker',
    'outer-authority-secret'
  ];
  const requests = [];
  await runV11Benchmark(baseOptions({
    arms: [arm({ outerAuthority: 'outer-authority-secret' })],
    scenarios: [scenario({
      expectedChoiceId: 'fixture-choice-must-stay-harness-side',
      privateFixtureMarker: 'fixture-private-marker'
    })],
    executeAdapter: async (request) => {
      const serialized = JSON.stringify(request);
      for (const sentinel of forbiddenSentinels) assert.ok(!serialized.includes(sentinel));
      requests.push(structuredClone(request));
      return adapterEnvelope(request);
    }
  }));

  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => !Object.hasOwn(request, 'commonModel')));
  assert.ok(requests.every((request) => !Object.hasOwn(request.payload, 'responseSchema')));
});

test('one acceptance artifact flows through the integrated runner, validator, and aggregator', async () => {
  const raw = await runV11Benchmark(baseOptions());
  const definition = {
    arms: [arm()],
    commonExecution: { repetitions: 1, randomSeeds: [17] },
    scenarios: [scenario()],
    marketingThresholds: {
      noResultText: 'Legacy zero-result text must not enter acceptance output.',
      measuredOnlyText: 'Legacy measured text must not enter acceptance output.'
    }
  };

  assert.equal(validateRawRun(raw, definition, HASHES.preregistrationSha256).valid, true);
  const aggregate = aggregateRun(raw, definition, {
    trustedSourceHashes: {
      preregistrationSha256: HASHES.preregistrationSha256,
      amendment001Sha256: HASHES.amendment001Sha256,
      amendment002Sha256: HASHES.amendment002Sha256
    }
  });
  assert.equal(aggregate.mode, 'ACCEPTANCE');
  assertNoAcceptanceClaims(aggregate);
});
