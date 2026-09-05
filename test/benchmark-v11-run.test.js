// The v1.1 run path: readiness, adapter routing, and the connection from the
// runner through the validator to the aggregator.
//
// The readiness assertions run against the real candidate. The end-to-end
// assertion uses a stub registry, because a READY verdict is not reachable from
// the real one today - graphiti declares user isolation the product does not
// have, and three immutable prerequisites are absent. That is the candidate's
// actual state, not a gap in the test: what is under test here is that the
// pieces are connected, and the readiness tests below cover the refusal.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createProgressLedger, createUnitEvidenceLedger } from '../benchmark/lib/progress.mjs';
import { loadV11AcceptanceDefinition } from '../benchmark/lib/v11-definition.mjs';
import { buildV11Prompt } from '../benchmark/lib/v11-prompts.mjs';
import { createV11Registry } from '../benchmark/lib/v11-registry.mjs';
import {
  V11RunError,
  V11_PREREQUISITE_GATES,
  computeV11Readiness,
  createV11AdapterExecutor,
  executeV11AcceptanceRun
} from '../benchmark/lib/v11-run.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPOSITORY_ROOT, 'benchmark', 'cli.mjs');
const BENCHMARK_ROOT = path.join(REPOSITORY_ROOT, 'benchmark');
const AMENDMENT_002_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-002.json');
const AMENDMENT_003_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-003.json');

async function realCandidate() {
  const competitorLock = JSON.parse(
    await (await import('node:fs/promises')).readFile(
      path.join(BENCHMARK_ROOT, 'competitors.lock.json'),
      'utf8'
    )
  );
  const registry = createV11Registry({
    competitorLock,
    containerImage: competitorLock.pythonImage
  });
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  return { registry, ...loaded };
}

async function runCli(args) {
  try {
    const { stdout } = await execFileAsync(process.execPath, [CLI, ...args]);
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '' };
  }
}

test('the run command and the preflight command answer readiness identically', async () => {
  const preflight = await runCli(['v11-preflight']);
  const run = await runCli(['v11-run']);

  const preflightReport = JSON.parse(preflight.stdout);
  const runReport = JSON.parse(run.stdout);

  assert.equal(preflightReport.readiness, 'NOT READY');
  assert.equal(runReport.status, 'REFUSED');
  assert.equal(runReport.readiness.readiness, 'NOT READY');
  // One computation, one answer. A preflight that said NOT READY while a run
  // started anyway is exactly the disagreement this shares code to prevent.
  assert.deepEqual(runReport.readiness.blockers, preflightReport.blockers);
  assert.deepEqual(runReport.readiness.declaredCounts, preflightReport.declaredCounts);
  assert.deepEqual(runReport.readiness.derivedCounts, preflightReport.derivedCounts);
});

test('a refused run writes no artifact and exits non-zero', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-run-');

  const result = await runCli(['v11-run', '--out', directory]);
  assert.equal(result.code, 1);

  const report = JSON.parse(result.stdout);
  assert.equal(report.status, 'REFUSED');
  assert.deepEqual(report.artifactsWritten, []);
  assert.deepEqual(await readdir(directory), [], 'a blocked run must leave nothing behind');
});

test('readiness names every unmet immutable prerequisite, not only applicability', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-missing-gates-');
  const candidate = await realCandidate();
  const report = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory
  });

  const unmet = report.blockers.filter((blocker) => blocker.kind === 'immutable-prerequisite');
  assert.equal(unmet.length, V11_PREREQUISITE_GATES.length);
  for (const gate of V11_PREREQUISITE_GATES) {
    const found = unmet.find((blocker) => blocker.requirement === gate.requirement);
    assert.ok(found, `${gate.requirement} is not reported`);
    assert.match(found.note, /cannot establish authenticity/u);
  }
});

test('a prerequisite file that exists but is empty is not treated as satisfied', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-gates-');
  for (const gate of V11_PREREQUISITE_GATES) {
    await writeFile(path.join(directory, gate.file), '{}\n', 'utf8');
  }

  const candidate = await realCandidate();
  const report = await computeV11Readiness({ ...candidate, benchmarkRoot: directory });
  const unmet = report.blockers.filter((blocker) => blocker.kind === 'immutable-prerequisite');
  assert.equal(unmet.length, V11_PREREQUISITE_GATES.length);
  assert.ok(unmet.every((blocker) => blocker.detail === 'the declaring file contains no usable entry'));
});

test('a mutable service manifest reference does not satisfy the service gate', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-mutable-service-manifest-');
  await writeFile(path.join(directory, 'service-images.json'), JSON.stringify({
    schema: 'shadowgraph.service-images',
    version: 1,
    services: [{ name: 'ollama', image: 'ollama/ollama:latest' }]
  }), 'utf8');
  await writeFile(path.join(directory, 'model-weights.lock.json'), JSON.stringify({
    models: [{ modelId: 'fixture', digestKind: 'model_weights', weightsDigest: 'sha256:' + 'b'.repeat(64) }]
  }), 'utf8');
  await writeFile(path.join(directory, 'python-wheels.lock.json'), JSON.stringify({
    wheels: [{ name: 'fixture', sha256: 'c'.repeat(64) }]
  }), 'utf8');

  const candidate = await realCandidate();
  const report = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory,
    satisfiedPreconditions: ['pinned backend access-control configuration']
  });

  assert.ok(report.blockers.some((blocker) => (
    blocker.kind === 'immutable-prerequisite' && blocker.requirement === 'service-manifest'
  )));
});

test('a digest-suffixed service reference does not satisfy the service gate', async (t) => {
  // implementation-lock.mjs refuses an image containing '@', so a manifest that
  // inlines a digest could clear readiness and still never produce a lock.
  const directory = await scratchDirectory(t, 'shadowgraph-v11-digest-service-manifest-');
  await writeFile(path.join(directory, 'service-images.json'), JSON.stringify({
    schema: 'shadowgraph.service-images',
    version: 1,
    services: [{ name: 'ollama', image: 'ollama/ollama@sha256:' + 'a'.repeat(64) }]
  }), 'utf8');
  await writeFile(path.join(directory, 'model-weights.lock.json'), JSON.stringify({
    models: [{ modelId: 'fixture', digestKind: 'model_weights', weightsDigest: 'sha256:' + 'b'.repeat(64) }]
  }), 'utf8');
  await writeFile(path.join(directory, 'python-wheels.lock.json'), JSON.stringify({
    wheels: [{ name: 'fixture', sha256: 'c'.repeat(64) }]
  }), 'utf8');

  const candidate = await realCandidate();
  const report = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory,
    satisfiedPreconditions: ['pinned backend access-control configuration']
  });

  assert.ok(report.blockers.some((blocker) => (
    blocker.kind === 'immutable-prerequisite' && blocker.requirement === 'service-manifest'
  )));
});

test('the canonical tagged service manifest satisfies the service prerequisite gate', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-service-manifest-');
  await writeFile(path.join(directory, 'service-images.json'), JSON.stringify({
    schema: 'shadowgraph.service-images',
    version: 1,
    services: [{ name: 'ollama', image: 'ollama/ollama:0.33.2' }]
  }), 'utf8');
  await writeFile(path.join(directory, 'model-weights.lock.json'), JSON.stringify({
    models: [{ modelId: 'fixture', digestKind: 'model_weights', weightsDigest: 'sha256:' + 'b'.repeat(64) }]
  }), 'utf8');
  await writeFile(path.join(directory, 'python-wheels.lock.json'), JSON.stringify({
    wheels: [{ name: 'fixture', sha256: 'c'.repeat(64) }]
  }), 'utf8');

  const candidate = await realCandidate();
  const report = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory,
    satisfiedPreconditions: ['pinned backend access-control configuration']
  });

  assert.equal(
    report.blockers.some((blocker) => (
      blocker.kind === 'immutable-prerequisite' && blocker.requirement === 'service-manifest'
    )),
    false
  );
});

test('the committed service manifest uses references the implementation lock can pin', async () => {
  // benchmark/lib/implementation-lock.mjs is the authority for this file. Its
  // assertLockableImage refuses any reference containing '@' ("must be an image
  // repository/name, not an image ID") and any mutable `latest`. A readiness
  // gate that demanded an inline digest would accept a manifest that can never
  // produce an implementation lock, so the two validators are checked together.
  const manifest = JSON.parse(await readFile(path.join(BENCHMARK_ROOT, 'service-images.json'), 'utf8'));

  assert.equal(manifest.schema, 'shadowgraph.service-images');
  assert.ok(Array.isArray(manifest.services) && manifest.services.length > 0);
  for (const service of manifest.services) {
    assert.equal(service.image.includes('@'), false, `${service.name} names an image ID, not a repository`);
    assert.equal(/(?:^|[/:@])latest(?:$|[/:@])/iu.test(service.image), false, `${service.name} is mutable`);
    assert.match(service.image, /^[^@\s]+:[^@\s:]+$/u, `${service.name} must carry an explicit tag`);
  }
});

test('the committed model lock names no mutable model reference', async () => {
  // validateModels in implementation-lock.mjs rejects a `latest` model ID, so a
  // weights digest recorded against one could never be locked.
  const lock = JSON.parse(await readFile(path.join(BENCHMARK_ROOT, 'model-weights.lock.json'), 'utf8'));
  assert.ok(Array.isArray(lock.models) && lock.models.length > 0);
  for (const model of lock.models) {
    assert.equal(/(?:^|[/:@])latest(?:$|[/:@])/iu.test(model.modelId), false, `${model.modelId} is mutable`);
  }
});

test('a malformed prerequisite file blocks rather than crashing readiness', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-gates-');
  for (const gate of V11_PREREQUISITE_GATES) {
    await writeFile(path.join(directory, gate.file), 'not json', 'utf8');
  }

  const candidate = await realCandidate();
  const report = await computeV11Readiness({ ...candidate, benchmarkRoot: directory });
  const unmet = report.blockers.filter((blocker) => blocker.kind === 'immutable-prerequisite');
  assert.ok(unmet.every((blocker) => blocker.detail === 'the declaring file is not valid JSON'));
  assert.equal(report.readiness, 'NOT READY');
});

test('adapter routing follows the lock, and an unconfigured runtime is refused', async () => {
  const { registry } = await realCandidate();
  const seen = [];
  const host = (kind) => (descriptor) => {
    seen.push([descriptor.armId, kind]);
    return async (request) => ({ routedTo: kind, armId: request.armId });
  };

  const executeAdapter = createV11AdapterExecutor({
    registry,
    hosts: {
      control: host('control'),
      'node-mcp': host('node-mcp'),
      'python-container': host('python-container')
    }
  });

  assert.deepEqual(seen, [
    ['no-memory', 'control'],
    ['shadowgraph-full', 'node-mcp'],
    ['shadowgraph-compact', 'node-mcp'],
    ['mem0-oss', 'python-container'],
    ['graphiti', 'python-container'],
    ['basic-memory', 'python-container'],
    ['cognee', 'python-container']
  ]);
  assert.deepEqual(
    await executeAdapter({ armId: 'cognee' }, {}),
    { routedTo: 'python-container', armId: 'cognee' }
  );

  // A missing host is a refusal. Falling back to whichever host happens to be
  // configured would report a measurement of software the lock does not pin.
  assert.throws(
    () => createV11AdapterExecutor({
      registry,
      hosts: { control: host('control'), 'node-mcp': host('node-mcp') }
    }),
    (error) => error instanceof V11RunError
      && error.code === 'RUNTIME_UNAVAILABLE'
      && /python-container/u.test(error.message)
  );
});

test('the module refuses to run a candidate its own readiness check blocks', async () => {
  const candidate = await realCandidate();
  await assert.rejects(
    executeV11AcceptanceRun({
      ...candidate,
      benchmarkRoot: BENCHMARK_ROOT,
      runId: 'run-should-not-start',
      attemptId: 'attempt-should-not-start',
      sourceHashes: candidate.sourceHashes,
      amendment002Path: AMENDMENT_002_PATH,
      amendment003Path: AMENDMENT_003_PATH,
      implementationLockHash: '4'.repeat(64),
      environmentLockHash: '5'.repeat(64),
      executeAdapter: async () => {
        throw new Error('an adapter must not be reached by a blocked run');
      },
      // The canonical builder, so this reaches the readiness gate rather than
      // stopping at the builder-identity check that precedes it.
      buildOuterRequest: buildV11Prompt,
      requestOuter: async () => {
        throw new Error('the outer model must not be called by a blocked run');
      },
      progress: { async append() {}, async watchdogState() { return null; } },
      persistUnit: async () => {},
      now: () => new Date().toISOString(),
      monotonicNow: () => 0
    }),
    (error) => error instanceof V11RunError && error.code === 'NOT_READY'
  );
});

test('a real run may use only the frozen prompt builder', async () => {
  // No runtime check can make an arbitrary injected function pure. Three rounds
  // of review went into narrowing what a builder can see - it gets phase,
  // scenario and native context, nothing that names the arm - and a builder
  // that counts its own calls still recovers the unit index, and from there the
  // arm, because the plan is ordered and the runner calls it a fixed number of
  // times per unit. Review demonstrated it: a biased prompt delivered to all 36
  // decision units of one named arm, run reporting COMPLETE.
  //
  // Rather than add another detector to that arms race, a run refuses anything
  // but the canonical builder. This is checked before readiness, so it holds
  // whether or not the candidate could otherwise start.
  const candidate = await realCandidate();
  const common = {
    ...candidate,
    benchmarkRoot: BENCHMARK_ROOT,
    runId: 'run-builder-identity',
    attemptId: 'attempt-builder-identity',
    sourceHashes: candidate.sourceHashes,
    amendment002Path: AMENDMENT_002_PATH,
    amendment003Path: AMENDMENT_003_PATH,
    implementationLockHash: '4'.repeat(64),
    environmentLockHash: '5'.repeat(64),
    executeAdapter: async () => {
      throw new Error('an adapter must not be reached');
    },
    requestOuter: async () => {
      throw new Error('the outer model must not be reached');
    },
    progress: { async append() {}, async watchdogState() { return null; } },
    persistUnit: async () => {},
    now: () => new Date().toISOString(),
    monotonicNow: () => 0
  };

  const impostors = [
    ['a wrapper that merely forwards', (input) => buildV11Prompt(input)],
    ['a stub', () => ({ system: 's', prompt: 'p', responseSchema: {} })],
    ['nothing at all', undefined]
  ];
  for (const [label, buildOuterRequest] of impostors) {
    await assert.rejects(
      executeV11AcceptanceRun({ ...common, buildOuterRequest }),
      (error) => error instanceof V11RunError
        && error.code === 'NON_CANONICAL_PROMPT_BUILDER',
      label
    );
  }

  // The canonical builder gets past the identity check and is stopped by
  // readiness instead, which is the next gate and the correct one.
  await assert.rejects(
    executeV11AcceptanceRun({ ...common, buildOuterRequest: buildV11Prompt }),
    (error) => error instanceof V11RunError && error.code === 'NOT_READY'
  );
});

test('a ready candidate runs the plan and reaches the validator and the aggregator', async (t) => {
  // Stub registry: a READY verdict is unreachable from the real one today, and
  // that is the candidate's true state. What is proven here is the connection -
  // runner to validator to aggregator - not that the real candidate is ready.
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  const { definition, scenarios, sourceHashes } = loaded;

  const gateDirectory = await scratchDirectory(t, 'shadowgraph-v11-ready-');
  const outputDirectory = await scratchDirectory(t, 'shadowgraph-v11-out-');
  await writeFile(
    path.join(gateDirectory, 'model-weights.lock.json'),
    JSON.stringify({
      models: [{ modelId: 'fixture-model', digestKind: 'model_weights', weightsDigest: `sha256:${'a'.repeat(64)}` }]
    }),
    'utf8'
  );
  await writeFile(
    path.join(gateDirectory, 'service-images.json'),
    // The legacy `serviceImages` key is still accepted, but the image must be a
    // reference implementation-lock.mjs could pin: repository plus explicit tag.
    JSON.stringify({ serviceImages: [{ name: 'fixture-service', image: 'fixture/service:1.0.0' }] }),
    'utf8'
  );
  await writeFile(
    path.join(gateDirectory, 'python-wheels.lock.json'),
    JSON.stringify({ wheels: [{ name: 'fixture-wheel', sha256: 'c'.repeat(64) }] }),
    'utf8'
  );

  const declaredCounts = definition.expectedCounts;
  const registry = {
    descriptors: definition.arms.map((arm) => ({
      armId: arm.id,
      kind: arm.id === 'no-memory' ? 'control' : 'node-mcp',
      requiredService: null
    })),
    verifyApplicability: () => ({ status: 'CONSISTENT', findings: [] }),
    expectedCounts: () => ({ ...declaredCounts })
  };

  const progressPath = path.join(outputDirectory, 'attempt.progress.ndjson');
  const unitEvidencePath = path.join(outputDirectory, 'attempt.units.ndjson');
  let monotonic = 0;
  const progress = await createProgressLedger({
    path: progressPath,
    runId: 'run-v11-connected',
    attemptId: 'attempt-v11-connected',
    monotonicNow: () => (monotonic += 5)
  });
  const unitEvidence = await createUnitEvidenceLedger({
    path: unitEvidencePath,
    runId: 'run-v11-connected',
    attemptId: 'attempt-v11-connected',
    sensitiveValues: []
  });
  t.after(async () => {
    await progress.close().catch(() => {});
    await unitEvidence.close().catch(() => {});
  });

  let wall = Date.parse('2026-08-31T00:00:00.000Z');
  const applicability = new Map(definition.arms.map((arm) => [arm.id, arm.applicability]));
  const reconciled = [];
  const outcome = await executeV11AcceptanceRun({
    registry,
    definition,
    scenarios,
    benchmarkRoot: gateDirectory,
    runId: 'run-v11-connected',
    attemptId: 'attempt-v11-connected',
    sourceHashes,
    amendment002Path: AMENDMENT_002_PATH,
    amendment003Path: AMENDMENT_003_PATH,
    implementationLockHash: '4'.repeat(64),
    environmentLockHash: '5'.repeat(64),
    progress,
    persistUnit: (unit) => unitEvidence.append(unit),
    now: () => new Date((wall += 1_000)).toISOString(),
    monotonicNow: () => (monotonic += 5),
    buildOuterRequest: buildV11Prompt,
    requestOuter: async ({ correlation, namespace }) => ({
      decision: stubDecision(correlation.phase, namespace),
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      providerModel: 'stub-outer-model',
      requestCount: 1,
      correlation: { ...correlation }
    }),
    executeAdapter: async (request) => stubEnvelope(request, applicability),
    // Required, and handed the record it is to judge. The run refuses without
    // it: a run that wrote a provider ledger nobody read is how three of the
    // reconciler's discrepancy codes became unreachable in production.
    reconcileProviderEvidence: (raw) => {
      reconciled.push(raw);
      return { status: 'RECONCILED', findings: [] };
    }
  });

  assert.equal(outcome.readiness.readiness, 'READY');
  // The reconciliation ran, saw this run's own record, and its verdict is
  // carried out with the artifact rather than left to the caller to ask for.
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0], outcome.raw);
  assert.equal(outcome.providerEvidence.status, 'RECONCILED');
  assert.equal(outcome.raw.units.length, 308);
  assert.equal(outcome.raw.mode, 'ACCEPTANCE');
  assert.equal(outcome.validation.valid, true, 'the validator must accept the run it just produced');
  assert.equal(outcome.aggregate.mode, 'ACCEPTANCE');

  // Counting units is not the same as measuring them. Without this, the test
  // passed with every unit FAILED - found by mutating the prompt-input
  // narrowing and watching this test stay green while the plan collapsed. A
  // connection test that cannot tell a working pipeline from a broken one is
  // asserting that the functions exist, not that they connect.
  const measured = outcome.raw.units.filter((unit) => unit.status === 'MEASURED');
  const excluded = outcome.raw.units.filter((unit) => unit.status === 'EXCLUDED');
  assert.equal(measured.length, 288);
  assert.equal(excluded.length, 20);
  assert.equal(outcome.raw.units.some((unit) => unit.status === 'FAILED'), false);

  // The checkpoint ledger the resume path reads was written for every unit.
  const progressLines = (await (await import('node:fs/promises'))
    .readFile(progressPath, 'utf8')).trim().split('\n');
  const checkpoints = progressLines.filter((line) => JSON.parse(line).event === 'checkpoint');
  assert.equal(checkpoints.length, 308);

  // Non-scored means non-scored all the way through the aggregate.
  const serialized = JSON.stringify(outcome.aggregate).toLowerCase();
  for (const forbidden of ['winner', 'ranking', 'outperform', 'leaderboard']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }
});

function stubDecision(phase, namespace) {
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

const OPERATION_FIELDS = [
  'memoryReadOperations',
  'memoryWriteOperations',
  'mcpToolCalls',
  'outerDecisionModelCalls',
  'internalMemoryModelCalls',
  'embeddingCalls',
  'persistenceVerificationOperations'
];

function stubEnvelope(request, applicability) {
  const persists = applicability.get(request.armId).persistence.status !== 'NOT_APPLICABLE';
  const notApplicable = !persists && ['persist', 'verify'].includes(request.operation);
  const operations = Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0]));
  const storage = persists
    ? {
        status: 'MEASURED',
        bytes: 32,
        scope: 'isolated fixture state',
        method: 'fixture byte count',
        reason: null,
        blockedClaims: []
      }
    : {
        status: 'NOT_AVAILABLE',
        bytes: null,
        scope: 'isolated fixture state',
        method: null,
        reason: 'the control arm stores nothing to measure',
        blockedClaims: ['storage bytes']
      };
  const base = {
    schemaVersion: 1,
    operation: request.operation,
    runId: request.runId,
    attemptId: request.attemptId,
    phase: request.phase,
    armId: request.armId,
    scenarioId: request.scenarioId,
    repetition: request.repetition,
    failure: null,
    operations,
    storage
  };
  if (notApplicable) {
    return {
      ...base,
      status: 'NOT_APPLICABLE',
      result: { nativeContext: [], persistenceEvidence: null, isolationEvidence: null }
    };
  }
  const expectedRecord = request.operation === 'verify' ? request.payload.expectedRecord : null;
  const alternateNamespaceRef = request.operation === 'verify'
    ? request.payload.alternateNamespaceRef
    : null;
  const counts = {
    reset: {},
    retrieve: { memoryReadOperations: 1 },
    persist: { memoryWriteOperations: 1 },
    verify: { persistenceVerificationOperations: 1 }
  }[request.operation];
  const emptyRetrieval = !persists
    || ['A', 'ISOLATION_PROJECT', 'ISOLATION_USER'].includes(request.phase);
  return {
    ...base,
    status: 'SUCCEEDED',
    operations: { ...operations, ...counts },
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
            expectedAbsentRecord: request.payload.expectedAbsentRecord,
            alternateNamespaceRef,
            matchingRecordIdCount: 0,
            matchingContentCount: 0
          }
    }
  };
}

// --- verified service evidence -------------------------------------------
//
// Two arms need a service the repository does not contain. These tests fix the
// direction of the default: the blocker stands unless a fresh probe record
// agrees with the committed manifest and the committed weight lock, and it
// stands again the moment any single part of that agreement is removed.

async function committedGateDirectory(t, prefix) {
  const directory = await scratchDirectory(t, prefix);
  for (const file of ['service-images.json', 'model-weights.lock.json', 'python-wheels.lock.json']) {
    await writeFile(path.join(directory, file), await readFile(path.join(BENCHMARK_ROOT, file), 'utf8'), 'utf8');
  }
  return directory;
}

const EVIDENCE_OBSERVED_AT = '2026-09-05T02:55:00.000Z';
const EVIDENCE_NOW = Date.parse('2026-09-05T03:00:00.000Z');

function evidenceChecks(name) {
  if (name === 'neo4j') {
    return [
      { kind: 'http-status', endpoint: 'http://127.0.0.1:7474/', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' },
      { kind: 'cypher-statement', endpoint: 'http://127.0.0.1:7474/db/neo4j/tx/commit', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'RETURN 1 AS ok' }
    ];
  }
  return [
    { kind: 'openai-chat-completions', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' },
    { kind: 'openai-embeddings', endpoint: 'http://127.0.0.1:11434/v1/embeddings', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' }
  ];
}

async function committedServiceEvidence(overrides = {}) {
  const manifest = JSON.parse(await readFile(path.join(BENCHMARK_ROOT, 'service-images.json'), 'utf8'));
  const weights = JSON.parse(await readFile(path.join(BENCHMARK_ROOT, 'model-weights.lock.json'), 'utf8'));
  const servedModels = weights.models.map((model) => ({
    modelId: model.modelId,
    weightsDigest: model.weightsDigest
  }));
  return {
    schema: 'shadowgraph.v11.service-evidence',
    version: 1,
    observedAt: EVIDENCE_OBSERVED_AT,
    services: manifest.services.map((service, index) => ({
      name: service.name,
      image: service.image,
      resolvedDigest: 'sha256:' + String(index + 1).repeat(64).slice(0, 64),
      containerId: 'container-' + service.name,
      servedModels: service.name === 'neo4j' ? [] : servedModels,
      checks: evidenceChecks(service.name)
    })),
    ...overrides
  };
}

async function readinessWithEvidence(t, prefix, evidence, extra = {}) {
  const directory = await committedGateDirectory(t, prefix);
  let serviceEvidencePath = null;
  if (evidence !== null) {
    serviceEvidencePath = path.join(directory, 'service-evidence.json');
    await writeFile(serviceEvidencePath, JSON.stringify(evidence), 'utf8');
  }
  const candidate = await realCandidate();
  return await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory,
    serviceEvidencePath,
    verificationInstant: EVIDENCE_NOW,
    ...extra
  });
}

function serviceBlockers(report) {
  return report.blockers.filter((blocker) => blocker.kind === 'required-service');
}

test('without service evidence every required service is still a blocker', async (t) => {
  const report = await readinessWithEvidence(t, 'shadowgraph-v11-no-evidence-', null);
  const services = serviceBlockers(report);
  assert.deepEqual(services.map((blocker) => blocker.armId).sort(), ['cognee', 'graphiti']);
  for (const blocker of services) {
    assert.ok(blocker.unverified.length > 0, 'the blocker must name what is unverified');
  }
  assert.ok(report.serviceEvidence.findings.some((finding) => finding.code === 'SERVICE_EVIDENCE_ABSENT'));
  assert.deepEqual(report.serviceEvidence.verifiedServices, []);
});

test('a fresh probe record that agrees with the committed locks clears both required services', async (t) => {
  const report = await readinessWithEvidence(
    t,
    'shadowgraph-v11-evidence-ok-',
    await committedServiceEvidence()
  );
  assert.deepEqual(serviceBlockers(report), [], 'a verified service is no longer a blocker');
  assert.deepEqual([...report.serviceEvidence.verifiedServices].sort(), ['neo4j', 'ollama']);
  assert.match(report.serviceEvidence.note, /cannot establish/iu);
});

test('evidence for the common endpoint alone clears Cognee and not Graphiti', async (t) => {
  const evidence = await committedServiceEvidence();
  evidence.services = evidence.services.filter((service) => service.name !== 'neo4j');
  const report = await readinessWithEvidence(t, 'shadowgraph-v11-evidence-partial-', evidence);

  const services = serviceBlockers(report);
  assert.deepEqual(services.map((blocker) => blocker.armId), ['graphiti']);
  assert.deepEqual(services[0].unverified, ['neo4j']);
});

test('a stale probe record clears nothing', async (t) => {
  const report = await readinessWithEvidence(
    t,
    'shadowgraph-v11-evidence-stale-',
    await committedServiceEvidence(),
    { verificationInstant: EVIDENCE_NOW + 7 * 60 * 60 * 1000 }
  );
  assert.deepEqual(serviceBlockers(report).map((blocker) => blocker.armId).sort(), ['cognee', 'graphiti']);
  assert.ok(report.serviceEvidence.findings.some((finding) => finding.code === 'SERVICE_EVIDENCE_STALE'));
});

test('a probe record whose served weights disagree with the committed lock clears nothing', async (t) => {
  const evidence = await committedServiceEvidence();
  const endpoint = evidence.services.find((service) => service.servedModels.length > 0);
  endpoint.servedModels[0].weightsDigest = 'sha256:' + 'd'.repeat(64);
  const report = await readinessWithEvidence(t, 'shadowgraph-v11-evidence-weights-', evidence);

  assert.deepEqual(serviceBlockers(report).map((blocker) => blocker.armId).sort(), ['cognee', 'graphiti']);
  assert.ok(report.serviceEvidence.findings.some((finding) => (
    finding.code === 'SERVICE_MODEL_DIGEST_MISMATCH'
  )));
});

test('a probe record that names an image the committed manifest does not pin clears nothing', async (t) => {
  const evidence = await committedServiceEvidence();
  for (const service of evidence.services) service.image = service.image + '-modified';
  const report = await readinessWithEvidence(t, 'shadowgraph-v11-evidence-image-', evidence);
  assert.deepEqual(serviceBlockers(report).map((blocker) => blocker.armId).sort(), ['cognee', 'graphiti']);
});

test('an unreadable or malformed probe record blocks rather than crashing readiness', async (t) => {
  const directory = await committedGateDirectory(t, 'shadowgraph-v11-evidence-malformed-');
  const serviceEvidencePath = path.join(directory, 'service-evidence.json');
  await writeFile(serviceEvidencePath, '{ not json', 'utf8');
  const candidate = await realCandidate();

  const report = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory,
    serviceEvidencePath,
    verificationInstant: EVIDENCE_NOW
  });
  assert.equal(report.readiness, 'NOT READY');
  assert.deepEqual(serviceBlockers(report).map((blocker) => blocker.armId).sort(), ['cognee', 'graphiti']);
});

test('a required service the committed manifest does not declare cannot be verified away', async (t) => {
  // Registry and manifest can drift. If the manifest stops declaring a service
  // an arm requires, no probe record may stand in for the missing declaration.
  const directory = await scratchDirectory(t, 'shadowgraph-v11-evidence-drift-');
  const manifest = JSON.parse(await readFile(path.join(BENCHMARK_ROOT, 'service-images.json'), 'utf8'));
  manifest.services = manifest.services.filter((service) => service.name !== 'neo4j');
  await writeFile(path.join(directory, 'service-images.json'), JSON.stringify(manifest), 'utf8');
  for (const file of ['model-weights.lock.json', 'python-wheels.lock.json']) {
    await writeFile(path.join(directory, file), await readFile(path.join(BENCHMARK_ROOT, file), 'utf8'), 'utf8');
  }
  const evidence = await committedServiceEvidence();
  const serviceEvidencePath = path.join(directory, 'service-evidence.json');
  await writeFile(serviceEvidencePath, JSON.stringify(evidence), 'utf8');

  const candidate = await realCandidate();
  const report = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory,
    serviceEvidencePath,
    verificationInstant: EVIDENCE_NOW
  });
  const graphiti = serviceBlockers(report).find((blocker) => blocker.armId === 'graphiti');
  assert.ok(graphiti, 'graphiti must remain blocked');
  assert.deepEqual(graphiti.unverified, ['neo4j']);
});

test('clearing the services does not clear the other blockers', async (t) => {
  // The Cognee ACL precondition is a separate claim about the product, not
  // about a host. Provisioning must not silently satisfy it.
  const report = await readinessWithEvidence(
    t,
    'shadowgraph-v11-evidence-acl-',
    await committedServiceEvidence()
  );
  assert.equal(report.readiness, 'NOT READY');
  assert.ok(report.blockers.some((blocker) => (
    blocker.kind === 'applicability' && blocker.code === 'DECLARED_ISOLATION_PRECONDITION_UNMET'
  )));
});

test('preflight and run answer readiness identically when evidence is presented', async (t) => {
  // The readiness input grew a second operator-supplied path. A flag that
  // reached preflight and not the run would put the two commands back into
  // disagreement, which is the one thing sharing this computation exists to
  // prevent - and the no-argument symmetry test above cannot see it.
  const directory = await scratchDirectory(t, 'shadowgraph-v11-cli-symmetry-');
  const outputDirectory = await scratchDirectory(t, 'shadowgraph-v11-cli-symmetry-out-');
  const observedAt = new Date().toISOString();
  const evidence = await committedServiceEvidence({ observedAt });
  for (const service of evidence.services) {
    for (const entry of service.checks) entry.observedAt = observedAt;
  }
  const serviceEvidencePath = path.join(directory, 'service-evidence.json');
  await writeFile(serviceEvidencePath, JSON.stringify(evidence), 'utf8');

  const preflight = await runCli(['v11-preflight', '--service-evidence', serviceEvidencePath]);
  const run = await runCli([
    'v11-run',
    '--service-evidence', serviceEvidencePath,
    '--out', outputDirectory
  ]);

  const preflightReport = JSON.parse(preflight.stdout);
  const runReport = JSON.parse(run.stdout);

  assert.deepEqual(runReport.readiness.blockers, preflightReport.blockers);
  assert.equal(runReport.readiness.readiness, preflightReport.readiness);
  assert.deepEqual(
    runReport.readiness.serviceEvidence.verifiedServices,
    preflightReport.serviceEvidence.verifiedServices
  );

  // Presented evidence really does clear the services it covers, and really
  // does not clear anything else.
  assert.deepEqual(preflightReport.serviceEvidence.verifiedServices, ['neo4j', 'ollama']);
  assert.deepEqual(preflightReport.blockers.filter((blocker) => blocker.kind === 'required-service'), []);
  assert.equal(preflightReport.readiness, 'NOT READY');
  assert.deepEqual(preflightReport.blockers.map((blocker) => blocker.code), ['DECLARED_ISOLATION_PRECONDITION_UNMET']);
  assert.deepEqual(await readdir(outputDirectory), [], 'a still-blocked run writes nothing');
});
