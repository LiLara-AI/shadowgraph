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
import { createHash } from 'node:crypto';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { canonicalJson } from '../benchmark/lib/v11-contract.mjs';
import { createProgressLedger, createUnitEvidenceLedger } from '../benchmark/lib/progress.mjs';
import { loadV11AcceptanceDefinition, loadV11FinalAcceptanceDefinition, loadV11ScoredDefinition } from '../benchmark/lib/v11-definition.mjs';
import { buildV11FinalReport } from '../benchmark/lib/v11-final-report.mjs';
import { attestV11LiveServices, captureVerifiedServiceEvidence } from '../benchmark/lib/v11-service-evidence.mjs';
import { buildV11Prompt } from '../benchmark/lib/v11-prompts.mjs';
import { createV11Registry } from '../benchmark/lib/v11-registry.mjs';
import {
  V11RunError,
  V11_PREREQUISITE_GATES,
  computeV11Readiness,
  createV11AdapterExecutor,
  executeV11AcceptanceRun,
  executeV11FinalAcceptanceRun,
  executeV11ScoredRun
} from '../benchmark/lib/v11-run.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));
const CLI = path.join(REPOSITORY_ROOT, 'benchmark', 'cli.mjs');
const BENCHMARK_ROOT = path.join(REPOSITORY_ROOT, 'benchmark');
const AMENDMENT_002_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-002.json');
const AMENDMENT_003_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-003.json');
const AMENDMENT_004_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-004.json');
const AMENDMENT_005_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-005.json');
const AMENDMENT_005_SIDECAR_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-005.sha256');
const AMENDMENT_006_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-006.json');
const AMENDMENT_006_SIDECAR_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-006.sha256');
const AMENDMENT_008_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-008.json');
const AMENDMENT_008_SIDECAR_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-008.sha256');
const AMENDMENT_009_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-009.json');
const AMENDMENT_009_SIDECAR_PATH = path.join(BENCHMARK_ROOT, 'preregistration-amendment-009.sha256');

function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function serviceImageEntry(name, image) {
  const lastColon = image.lastIndexOf(':');
  const repository = image.slice(0, lastColon);
  const tag = image.slice(lastColon + 1);
  const manifestBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    config: {
      mediaType: 'application/vnd.oci.image.config.v1+json',
      digest: `sha256:${'a'.repeat(64)}`,
      size: 1
    },
    layers: [{
      mediaType: 'application/vnd.oci.image.layer.v1.tar+gzip',
      digest: `sha256:${'b'.repeat(64)}`,
      size: 1
    }]
  }));
  const digest = sha256Digest(manifestBytes);
  const indexBytes = Buffer.from(JSON.stringify({
    schemaVersion: 2,
    mediaType: 'application/vnd.oci.image.index.v1+json',
    manifests: [{
      mediaType: 'application/vnd.oci.image.manifest.v1+json',
      digest,
      size: manifestBytes.length,
      platform: { os: 'linux', architecture: 'amd64' }
    }]
  }));
  return {
    name,
    image,
    digest,
    digestKind: 'oci-platform-manifest',
    platform: 'linux/amd64',
    registryAttestation: {
      registry: 'registry-1.docker.io',
      repository: repository.includes('/') ? repository : `library/${repository}`,
      tag,
      indexDigest: sha256Digest(indexBytes),
      indexBase64: indexBytes.toString('base64'),
      platformManifestBase64: manifestBytes.toString('base64')
    }
  };
}

function cleanProviderReconciliation(raw) {
  const events = raw.units.filter((unit) => unit.providerUsage !== null).map((unit, index) => ({
    requestNumber: index + 1,
    requestClass: 'outer_decision_llm',
    outcome: 'SUCCEEDED',
    providerModel: unit.providerModel,
    usage: unit.providerUsage,
    latencyMs: 1,
    correlation: {
      runId: raw.runId,
      attemptId: raw.attemptId,
      armId: unit.armId,
      scenarioId: unit.scenarioId,
      repetition: unit.repetition,
      phase: unit.phase
    }
  }));
  return {
    schema: 'shadowgraph.v11.provider-reconciliation',
    version: 1,
    runId: raw.runId,
    attemptId: raw.attemptId,
    ledgerPath: 'offline-provider-ledger.ndjson',
    status: 'RECONCILED',
    totals: {
      expectedCalls: events.length,
      observedEvents: events.length,
      matchedCalls: events.length,
      malformedLines: 0,
      unexpectedEvents: 0,
      missingCalls: 0,
      retryEvents: 0,
      modelMismatches: 0,
      failedOutcomes: 0,
      incompleteUsage: 0,
      unverifiedCountUnits: 0,
      unverifiedCountEvents: 0
    },
    events,
    evidenceHashes: {
      providerLedgerSha256: '1'.repeat(64),
      attemptLedgerSha256: '2'.repeat(64),
      planLedgerSha256: '3'.repeat(64),
      campaignLedgerSha256: '4'.repeat(64)
    },
    findings: [],
    nativeAttemptTrace: { status: 'RECONCILED', findings: [], trace: [] },
    budgetEvidence: { status: 'RECONCILED', findings: [] }
  };
}

async function createNativeAttemptEvidenceFixture(directory, candidate) {
  const observedAt = '2026-09-08T09:59:00.000Z';
  const identityProtocol = {
    meterIssuedOpaqueAlias: true,
    durablePlanBeforeDispatch: true,
    rootInvocationAndDispatchIds: true,
    bodyIndependentIdentity: true,
    contextCarrierOnly: true,
    planClosureBeforeReconciliation: true,
    aggregateCapIndependentOfAliases: true,
    campaignReservationJoinedBeforeDispatch: true
  };
  const recoverySpecs = [
    { armId: 'graphiti', requestClass: 'internal_memory_llm', category: 'B', packageName: 'graphiti-core', packageVersion: '0.29.3', modelId: 'qwen2.5:7b' },
    { armId: 'cognee', requestClass: 'internal_memory_llm', category: 'B', packageName: 'cognee', packageVersion: '1.5.3', modelId: 'qwen2.5:7b' },
    { armId: 'cognee', requestClass: 'internal_memory_llm', category: 'C', packageName: 'cognee', packageVersion: '1.5.3', modelId: 'qwen2.5:7b' },
    { armId: 'cognee', requestClass: 'embedding', category: 'B', packageName: 'cognee', packageVersion: '1.5.3', modelId: 'nomic-embed-text:v1.5' }
  ];
  const entries = [];
  for (const spec of recoverySpecs) {
    const chat = spec.requestClass === 'internal_memory_llm';
    const taxonomy = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((name) => [name, name === spec.category]));
    const wireAttempts = spec.category === 'C'
      ? [1, 2, 3].map((ordinal) => ({
          ordinal, path: '/v1/chat/completions', outcome: 'SUCCEEDED', modelId: spec.modelId,
          retryOrdinal: 0, responseFormat: 'json_object'
        }))
      : [
          { ordinal: 1, path: chat ? '/v1/chat/completions' : '/v1/embeddings', outcome: 'FAILED', modelId: spec.modelId, retryOrdinal: 0, responseFormat: chat ? 'json_object' : null },
          { ordinal: 2, path: chat ? '/v1/chat/completions' : '/v1/embeddings', outcome: 'SUCCEEDED', modelId: spec.modelId, retryOrdinal: 1, responseFormat: chat ? 'json_object' : null }
        ];
    const reportName = `${spec.armId}-${spec.requestClass}-${spec.category}.report.json`;
    const reportText = `${JSON.stringify({
      schema: 'shadowgraph.v11.native-attempt-loopback-report', version: 1, observedAt,
      amendment006Sha256: candidate.sourceHashes.amendment006Sha256,
      amendment008Sha256: candidate.sourceHashes.amendment008Sha256,
      identityProtocol,
      armId: spec.armId, requestClass: spec.requestClass, category: spec.category,
      package: { name: spec.packageName, version: spec.packageVersion },
      modelId: spec.modelId, network: 'loopback-only', rootOperationInvocations: 1,
      wireAttempts, taxonomy, allAttemptsMetered: true,
      providerUsageAccounting: 'metered-complete-or-fail-closed',
      modelEndpointPinned: true, harnessOperationReruns: 0
    })}\n`;
    await writeFile(path.join(directory, reportName), reportText, 'utf8');
    entries.push({
      armId: spec.armId, requestClass: spec.requestClass, category: spec.category,
      package: { name: spec.packageName, version: spec.packageVersion }, modelId: spec.modelId,
      outcome: 'PASS', network: 'loopback-only', wireRequests: wireAttempts.length,
      allAttemptsMetered: true, providerUsageAccounting: 'metered-complete-or-fail-closed',
      modelEndpointPinned: true, harnessOperationReruns: 0, taxonomy,
      probeReport: reportName,
      probeSha256: createHash('sha256').update(reportText).digest('hex')
    });
  }
  const evidencePath = path.join(directory, 'native-attempt-evidence.json');
  await writeFile(evidencePath, `${JSON.stringify({
    schema: 'shadowgraph.v11.native-attempt-evidence', version: 1, observedAt,
    amendment006Sha256: candidate.sourceHashes.amendment006Sha256,
    amendment008Sha256: candidate.sourceHashes.amendment008Sha256,
    identityProtocol,
    entries
  })}\n`, 'utf8');
  return evidencePath;
}

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
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? error.message ?? '' };
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

test('every non-empty native recovery policy entry requires fresh external evidence', async () => {
  const candidate = await realCandidate();
  const report = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: BENCHMARK_ROOT,
    verificationInstant: Date.parse('2026-09-08T10:00:00.000Z')
  });
  assert.deepEqual(
    report.blockers
      .filter((blocker) => blocker.kind === 'native-attempt-evidence')
      .map(({ armId, requestClass, category }) => ({ armId, requestClass, category }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    [
      { armId: 'cognee', requestClass: 'embedding', category: 'B' },
      { armId: 'cognee', requestClass: 'internal_memory_llm', category: 'C' }
    ]
  );
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
    version: 3,
    services: [{ ...serviceImageEntry('ollama', 'ollama/ollama:0.33.2'), image: 'ollama/ollama:latest' }]
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
    version: 3,
    services: [{
      ...serviceImageEntry('ollama', 'ollama/ollama:0.33.2'),
      image: 'ollama/ollama@sha256:' + 'a'.repeat(64)
    }]
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

test('an untagged service reference with a registry port does not satisfy the service gate', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-untagged-service-manifest-');
  await writeFile(path.join(directory, 'service-images.json'), JSON.stringify({
    schema: 'shadowgraph.service-images',
    version: 3,
    services: [{
      ...serviceImageEntry('ollama', 'ollama/ollama:0.33.2'),
      image: 'registry.example:5000/team/ollama'
    }]
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
    version: 3,
    services: [serviceImageEntry('ollama', 'ollama/ollama:0.33.2')]
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

test('a service manifest without a committed OCI platform-manifest identity blocks readiness', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-service-manifest-identity-');
  await writeFile(path.join(directory, 'service-images.json'), JSON.stringify({
    schema: 'shadowgraph.service-images',
    version: 3,
    services: [{
      ...serviceImageEntry('ollama', 'ollama/ollama:0.33.2'),
      digestKind: 'oci-image-index'
    }]
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

test('the committed service manifest uses references the implementation lock can pin', async () => {
  // benchmark/lib/implementation-lock.mjs is the authority for this file. Its
  // assertLockableImage refuses any reference containing '@' ("must be an image
  // repository/name, not an image ID") and any mutable `latest`. A readiness
  // gate that demanded an inline digest would accept a manifest that can never
  // produce an implementation lock, so the two validators are checked together.
  const manifest = JSON.parse(await readFile(path.join(BENCHMARK_ROOT, 'service-images.json'), 'utf8'));

  assert.equal(manifest.schema, 'shadowgraph.service-images');
  assert.equal(manifest.version, 3);
  assert.deepEqual(
    manifest.services.map(({ name, image, digest, digestKind, platform, registryAttestation }) => ({
      name,
      image,
      digest,
      digestKind,
      platform,
      registry: registryAttestation.registry,
      repository: registryAttestation.repository,
      tag: registryAttestation.tag,
      indexDigest: registryAttestation.indexDigest
    })),
    [
      {
        name: 'neo4j',
        image: 'neo4j:5.26.0',
        digest: 'sha256:d5e6396795ab2b813d5c6ac820ba36f129c412ea4ad982ffccab7b8f69e9e6a5',
        digestKind: 'oci-platform-manifest',
        platform: 'linux/amd64',
        registry: 'registry-1.docker.io',
        repository: 'library/neo4j',
        tag: '5.26.0',
        indexDigest: 'sha256:5a015e53de1895e7eee1574ae0325cf8c4b89587222778108c594bdd45a474b5'
      },
      {
        name: 'ollama',
        image: 'ollama/ollama:0.33.2',
        digest: 'sha256:9e7d782e99880c70f9563c51633da875ca605518a8f8d95c2532bda70a027b7a',
        digestKind: 'oci-platform-manifest',
        platform: 'linux/amd64',
        registry: 'registry-1.docker.io',
        repository: 'ollama/ollama',
        tag: '0.33.2',
        indexDigest: 'sha256:020e4134285e2ef4d8fd801234176de3b4faadc992a3eb06c8e66a2f9d4c4ba2'
      }
    ]
  );
  for (const service of manifest.services) {
    assert.equal(service.image.includes('@'), false, `${service.name} names an image ID, not a repository`);
    assert.equal(/(?:^|[/:@])latest(?:$|[/:@])/iu.test(service.image), false, `${service.name} is mutable`);
    assert.match(service.image, /^[^@\s]+:[^@\s:]+$/u, `${service.name} must carry an explicit tag`);
    const attestation = service.registryAttestation;
    assert.deepEqual(Object.keys(attestation).sort(), [
      'indexBase64', 'indexDigest', 'platformManifestBase64', 'registry', 'repository', 'tag'
    ]);
    for (const field of ['indexBase64', 'platformManifestBase64']) {
      const decoded = Buffer.from(attestation[field], 'base64');
      assert.equal(decoded.toString('base64'), attestation[field], `${service.name} ${field} is canonical base64`);
    }
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

test('adapter routing refuses a second invocation of the same measured root operation', async () => {
  const { registry } = await realCandidate();
  let calls = 0;
  const host = () => () => async () => {
    calls += 1;
    return { status: 'SUCCEEDED' };
  };
  const executeAdapter = createV11AdapterExecutor({
    registry,
    hosts: { control: host(), 'node-mcp': host(), 'python-container': host() }
  });
  const request = {
    runId: 'run-no-rerun',
    attemptId: 'attempt-no-rerun',
    armId: 'cognee',
    scenarioId: 'ACC_TRACE_1',
    repetition: 0,
    phase: 'A',
    operation: 'persist'
  };

  await executeAdapter(request, {});
  await assert.rejects(
    executeAdapter(request, {}),
    (error) => error instanceof V11RunError && error.code === 'HARNESS_OPERATION_REEXECUTION'
  );
  assert.equal(calls, 1);
});

test('adapter routing permits the two declared Phase-E persist slots but rejects an exact slot replay', async () => {
  const { registry } = await realCandidate();
  let calls = 0;
  const hostOptions = [];
  const host = () => () => async (_request, options) => {
    calls += 1;
    hostOptions.push(options);
    return { status: 'SUCCEEDED' };
  };
  const executeAdapter = createV11AdapterExecutor({
    registry,
    hosts: { control: host(), 'node-mcp': host(), 'python-container': host() }
  });
  const request = {
    runId: 'run-phase-e-slots',
    attemptId: 'attempt-phase-e-slots',
    armId: 'shadowgraph-full',
    scenarioId: 'ACC_TRACE_1',
    repetition: 0,
    phase: 'E',
    operation: 'persist'
  };

  await executeAdapter(request, { operationSlot: 'setupPersist' });
  await executeAdapter(request, { operationSlot: 'persist' });
  await assert.rejects(
    executeAdapter(request, { operationSlot: 'persist' }),
    (error) => error instanceof V11RunError && error.code === 'HARNESS_OPERATION_REEXECUTION'
  );
  assert.equal(calls, 2);
  assert.deepEqual(hostOptions, [{}, {}], 'harness-only slot identity must not reach product hosts');
});

test('adapter routing rejects omitted, unknown, and cross-operation slots before host execution', async () => {
  const { registry } = await realCandidate();
  let calls = 0;
  const host = () => () => async () => {
    calls += 1;
    return { status: 'SUCCEEDED' };
  };
  const executeAdapter = createV11AdapterExecutor({
    registry,
    hosts: { control: host(), 'node-mcp': host(), 'python-container': host() }
  });
  const request = {
    runId: 'run-invalid-slots',
    attemptId: 'attempt-invalid-slots',
    armId: 'shadowgraph-full',
    scenarioId: 'ACC_TRACE_1',
    repetition: 0,
    phase: 'E',
    operation: 'verify'
  };
  for (const options of [{}, { operationSlot: 'unknown' }, { operationSlot: 'setupPersist' }]) {
    await assert.rejects(
      executeAdapter(request, options),
      (error) => error instanceof V11RunError && error.code === 'HARNESS_OPERATION_SLOT_INVALID'
    );
  }
  await assert.rejects(
    executeAdapter({ ...request, phase: 'A' }, { operationSlot: 'setupVerify' }),
    (error) => error instanceof V11RunError && error.code === 'HARNESS_OPERATION_SLOT_INVALID'
  );
  assert.equal(calls, 0);
});

test('readiness rejects a final campaign outside the one frozen program lineage', async () => {
  const historical = await realCandidate();
  const final = await loadV11FinalAcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  const report = await computeV11Readiness({
    ...historical,
    ...final,
    benchmarkRoot: BENCHMARK_ROOT,
    implementationLockHash: '4'.repeat(64),
    campaign: {
      root: 'C:/benchmark-evidence/second-program-root',
      policy: {
        campaignId: 'second-final-program',
        deadline: '2026-09-25T23:37:31.000Z',
        implementationLockHash: '4'.repeat(64),
        maxRequests: 16269,
        maxSessions: 16,
        maxRecoveryAttempts: 0,
        limits: { outer_decision_llm: 2730, internal_memory_llm: 2738, embedding: 10801 },
        sessionLimits: { probe: 12, acceptance: 3, scored: 1 },
        campaignRegistryPath: path.join(REPOSITORY_ROOT, '..', 'second-program.claim.json'),
        continuityRegistryPath: path.join(REPOSITORY_ROOT, '..', 'second-program.continuity.ndjson')
      }
    },
    verificationInstant: Date.parse('2026-09-12T00:00:00.000Z')
  });
  assert.ok(report.blockers.some(({ code }) => code === 'PROGRAM_BUDGET_MISMATCH'));
});

test('readiness rejects a final campaign whose absolute deadline exceeds fourteen days', async () => {
  const historical = await realCandidate();
  const final = await loadV11FinalAcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  const implementationLockHash = '4'.repeat(64);
  const report = await computeV11Readiness({
    ...historical,
    ...final,
    benchmarkRoot: BENCHMARK_ROOT,
    implementationLockHash,
    campaign: {
      root: 'missing-final-campaign-root',
      policy: {
        campaignId: 'shadowgraph-v11-final-program',
        deadline: '2026-09-26T23:37:31.000Z',
        implementationLockHash,
        maxRequests: 16269,
        maxSessions: 16,
        maxRecoveryAttempts: 0,
        limits: { outer_decision_llm: 2730, internal_memory_llm: 2738, embedding: 10801 },
        sessionLimits: { probe: 12, acceptance: 3, scored: 1 },
        campaignRegistryPath: path.join(REPOSITORY_ROOT, '..', 'deadline-too-long-claim.json'),
        continuityRegistryPath: path.join(REPOSITORY_ROOT, '..', 'deadline-too-long-continuity.ndjson')
      }
    },
    verifyCampaignPolicyLineage: async () => {},
    verificationInstant: Date.parse('2026-09-12T00:00:00.000Z')
  });
  assert.ok(report.blockers.some(({ code }) => code === 'PROGRAM_BUDGET_MISMATCH'), JSON.stringify(report.blockers));
});

test('readiness rejects a final campaign beyond Amendment 009 cumulative ceilings', async () => {
  const historical = await realCandidate();
  const final = await loadV11FinalAcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  const report = await computeV11Readiness({
    registry: historical.registry,
    ...final,
    benchmarkRoot: BENCHMARK_ROOT,
    implementationLockHash: '4'.repeat(64),
    campaign: {
      root: path.join(REPOSITORY_ROOT, '..', 'oversized-final-campaign'),
      policy: {
        campaignId: 'shadowgraph-v11-final-program',
        deadline: '2026-09-20T00:00:00.000Z',
        implementationLockHash: '4'.repeat(64),
        maxRequests: 999999,
        maxSessions: 999,
        maxRecoveryAttempts: 0,
        limits: { outer_decision_llm: 999999, internal_memory_llm: 999999, embedding: 999999 },
        sessionLimits: { probe: 997, acceptance: 1, scored: 1 },
        campaignRegistryPath: path.join(REPOSITORY_ROOT, '..', 'oversized-final-campaign.claim.json'),
        continuityRegistryPath: path.join(REPOSITORY_ROOT, '..', 'oversized-final-campaign.continuity.ndjson')
      }
    },
    assertCampaignPolicy: (value) => value,
    verifyCampaignLineage: async () => {},
    verificationInstant: Date.parse('2026-09-12T00:00:00.000Z')
  });
  assert.ok(
    report.blockers.some(({ code }) => code === 'PROGRAM_BUDGET_MISMATCH'),
    JSON.stringify(report.blockers)
  );
});

test('readiness reports an expired campaign before runtime binding', async () => {
  const candidate = await realCandidate();
  const report = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: BENCHMARK_ROOT,
    verificationInstant: Date.parse('2026-09-12T00:00:00.000Z'),
    campaign: {
      root: 'fixture-expired-campaign',
      policy: {
        campaignId: 'fixture-expired-campaign',
        implementationLockHash: '4'.repeat(64),
        maxRequests: 1,
        maxSessions: 1,
        maxRecoveryAttempts: 0,
        deadline: '2020-01-01T00:00:00.000Z',
        limits: { outer_decision_llm: 1, internal_memory_llm: 0, embedding: 0 }
      }
    },
    assertRestrictedCampaignPolicy: () => Object.freeze({}),
    verifyCampaignLineage: async () => Object.freeze({})
  });

  assert.ok(report.blockers.some((blocker) => (
    blocker.kind === 'campaign' && blocker.code === 'CAMPAIGN_EXPIRED'
  )));
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
      amendment004Path: AMENDMENT_004_PATH,
      amendment005Path: AMENDMENT_005_PATH,
      amendment005SidecarPath: AMENDMENT_005_SIDECAR_PATH,
    amendment006Path: AMENDMENT_006_PATH,
    amendment006SidecarPath: AMENDMENT_006_SIDECAR_PATH,
    amendment008Path: AMENDMENT_008_PATH,
    amendment008SidecarPath: AMENDMENT_008_SIDECAR_PATH,
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

test('scored execution requires the exact scored profile before readiness or effects', async () => {
  const acceptance = await realCandidate();
  const scored = {
    registry: acceptance.registry,
    ...await loadV11ScoredDefinition({ repositoryRoot: REPOSITORY_ROOT })
  };
  const acceptanceEligibility = {
    schema: 'shadowgraph.v11.acceptance-eligibility',
    version: 1,
    status: 'ELIGIBLE_FOR_SCORED',
    runId: 'accepted-run',
    attemptId: 'accepted-attempt-1',
    implementationLockHash: '4'.repeat(64),
    amendment009Sha256: scored.sourceHashes.amendment009Sha256,
    rawSha256: 'a'.repeat(64),
    providerReconciliationSha256: 'b'.repeat(64),
    counts: { totalUnits: 308, applicableUnits: 288, excludedUnits: 20, failedUnits: 0 },
    issuedAt: '2026-09-08T09:59:00.000Z'
  };
  let effects = 0;
  const common = {
    benchmarkRoot: BENCHMARK_ROOT,
    runId: 'run-scored-profile-gate',
    attemptId: 'attempt-scored-profile-gate',
    implementationLockHash: '4'.repeat(64),
    environmentLockHash: '5'.repeat(64),
    amendment002Path: AMENDMENT_002_PATH,
    amendment003Path: AMENDMENT_003_PATH,
    amendment004Path: AMENDMENT_004_PATH,
    amendment005Path: AMENDMENT_005_PATH,
    amendment005SidecarPath: AMENDMENT_005_SIDECAR_PATH,
    amendment006Path: AMENDMENT_006_PATH,
    amendment006SidecarPath: AMENDMENT_006_SIDECAR_PATH,
    amendment008Path: AMENDMENT_008_PATH,
    amendment008SidecarPath: AMENDMENT_008_SIDECAR_PATH,
    amendment009Path: AMENDMENT_009_PATH,
    amendment009SidecarPath: AMENDMENT_009_SIDECAR_PATH,
    buildOuterRequest: buildV11Prompt,
    executeAdapter: async () => { effects += 1; },
    requestOuter: async () => { effects += 1; },
    persistUnit: async () => { effects += 1; },
    reconcileProviderEvidence: async () => { effects += 1; }
  };

  await assert.rejects(
    executeV11ScoredRun({ ...common, ...acceptance }),
    (error) => error instanceof V11RunError && error.code === 'PROFILE_MODE_MISMATCH'
  );
  assert.equal(effects, 0);

  await assert.rejects(
    executeV11ScoredRun({ ...common, ...scored }),
    (error) => error instanceof V11RunError && error.code === 'ACCEPTANCE_GATE_REQUIRED'
  );
  assert.equal(effects, 0);

  await assert.rejects(
    executeV11ScoredRun({ ...common, ...scored, acceptanceEligibility, nativeAttemptPolicy: null }),
    (error) => error instanceof V11RunError && error.code === 'ACCEPTANCE_GATE_REQUIRED'
  );
  assert.equal(effects, 0);

  await assert.rejects(
    executeV11ScoredRun({ ...common, ...scored, acceptanceEligibility }),
    (error) => error instanceof V11RunError && error.code === 'ACCEPTANCE_GATE_REQUIRED'
  );
  assert.equal(effects, 0);
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
    amendment004Path: AMENDMENT_004_PATH,
    amendment005Path: AMENDMENT_005_PATH,
    amendment005SidecarPath: AMENDMENT_005_SIDECAR_PATH,
    amendment006Path: AMENDMENT_006_PATH,
    amendment006SidecarPath: AMENDMENT_006_SIDECAR_PATH,
    amendment008Path: AMENDMENT_008_PATH,
    amendment008SidecarPath: AMENDMENT_008_SIDECAR_PATH,
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
  const loaded = await loadV11FinalAcceptanceDefinition({ repositoryRoot: REPOSITORY_ROOT });
  const { definition, scenarios, sourceHashes, nativeAttemptPolicy } = loaded;

  const gateDirectory = await scratchDirectory(t, 'shadowgraph-v11-ready-');
  const outputDirectory = await scratchDirectory(t, 'shadowgraph-v11-out-');
  await writeFile(
    path.join(gateDirectory, 'model-weights.lock.json'),
    await readFile(path.join(BENCHMARK_ROOT, 'model-weights.lock.json'))
  );
  await writeFile(
    path.join(gateDirectory, 'service-images.json'),
    await readFile(path.join(BENCHMARK_ROOT, 'service-images.json'))
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
      requiredService: null,
      ...({
        graphiti: { packageName: 'graphiti-core', version: '0.29.3' },
        cognee: { packageName: 'cognee', version: '1.5.3' }
      }[arm.id] ?? {})
    })),
    verifyApplicability: () => ({ status: 'CONSISTENT', findings: [] }),
    expectedCounts: () => ({ ...declaredCounts })
  };
  const nativeAttemptEvidencePath = await createNativeAttemptEvidenceFixture(gateDirectory, loaded);
  const serviceDocument = structuredClone(await committedServiceEvidence());
  const serviceObservedAt = '2026-09-08T09:59:00.000Z';
  serviceDocument.observedAt = serviceObservedAt;
  for (const service of serviceDocument.services) {
    for (const check of service.checks) check.observedAt = serviceObservedAt;
  }
  const verifiedServiceEvidence = captureVerifiedServiceEvidence({
    evidenceText: JSON.stringify(serviceDocument),
    serviceManifest: JSON.parse(await readFile(path.join(gateDirectory, 'service-images.json'), 'utf8')),
    modelWeights: JSON.parse(await readFile(path.join(gateDirectory, 'model-weights.lock.json'), 'utf8')),
    now: Date.parse('2026-09-08T10:00:00.000Z')
  });
  const liveServiceAttestation = await attestV11LiveServices({
    snapshot: verifiedServiceEvidence,
    deps: {
      inspectContainer: async (reference) => {
        const service = serviceDocument.services.find(({ imageIdentity }) => imageIdentity.containerReference === reference);
        return { id: service.imageIdentity.containerId, image: service.imageIdentity.containerImageId };
      },
      connectTcp: async () => true,
      readContainerEnvironmentValue: async () => 'none',
      readModelWeightsDigest: async (reference, modelId) => serviceDocument.services
        .find(({ imageIdentity }) => imageIdentity.containerReference === reference)
        .servedModels.find((model) => model.modelId === modelId).weightsDigest
    }
  });

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
  const readyInput = {
    // Explicit offline authorization, not a production limit or an extra readiness bypass.
    providerBudget: { schema: 'shadowgraph.v11.provider-budget', version: 1,
      authorizationRef: 'offline-test-only', runId: 'run-v11-connected', attemptId: 'attempt-v11-connected',
      implementationLockHash: '4'.repeat(64), maxRetries: 0,
      limits: { outer_decision_llm: 260, internal_memory_llm: 0, embedding: 0 } },
    registry,
    definition,
    scenarios,
    nativeAttemptPolicy,
    nativeAttemptEvidencePath,
    verifiedServiceEvidence,
    liveServiceAttestation,
    verificationInstant: Date.parse('2026-09-08T10:00:00.000Z'),
    benchmarkRoot: gateDirectory,
    runId: 'run-v11-connected',
    attemptId: 'attempt-v11-connected',
    campaign: {
      root: 'fixture-campaign-root',
      policy: {
        campaignId: 'shadowgraph-v11-final-program',
        deadline: '2026-09-25T23:37:31.000Z',
        implementationLockHash: '4'.repeat(64),
        maxRequests: 16269,
        maxSessions: 16,
        maxRecoveryAttempts: 0,
        limits: { outer_decision_llm: 2730, internal_memory_llm: 2738, embedding: 10801 },
        sessionLimits: { probe: 12, acceptance: 3, scored: 1 },
        campaignRegistryPath: path.join(outputDirectory, 'fixture-final-program.claim.json'),
        continuityRegistryPath: path.join(outputDirectory, 'fixture-final-program.continuity.ndjson')
      }
    },
    verifyCampaignLineage: async () => Object.freeze({}),
    assertRestrictedCampaignPolicy: () => Object.freeze({}),
    sourceHashes,
    amendment002Path: AMENDMENT_002_PATH,
    amendment003Path: AMENDMENT_003_PATH,
    amendment004Path: AMENDMENT_004_PATH,
    amendment005Path: AMENDMENT_005_PATH,
    amendment005SidecarPath: AMENDMENT_005_SIDECAR_PATH,
    amendment006Path: AMENDMENT_006_PATH,
    amendment006SidecarPath: AMENDMENT_006_SIDECAR_PATH,
    amendment008Path: AMENDMENT_008_PATH,
    amendment008SidecarPath: AMENDMENT_008_SIDECAR_PATH,
    amendment009Path: AMENDMENT_009_PATH,
    amendment009SidecarPath: AMENDMENT_009_SIDECAR_PATH,
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
      return cleanProviderReconciliation(raw);
    }
  };

  // A caller that supplies a campaign object directly must not bypass the
  // receipt-bound continuation verification performed by the CLI path.
  const lineageBlocked = await computeV11Readiness({
    ...readyInput,
    verifyCampaignLineage: async () => { throw new Error('invalid-campaign-lineage'); }
  });
  assert.ok(lineageBlocked.blockers.some((blocker) => (
    blocker.kind === 'campaign' && blocker.code === 'CAMPAIGN_CONTINUITY_INVALID'
  )));

  const restrictedBlocked = await computeV11Readiness({
    ...readyInput,
    assertRestrictedCampaignPolicy: () => { throw new Error('Campaign continuation is unsupported in restricted execution mode'); },
    verifyCampaignLineage: async () => { throw new Error('must-not-verify-continuation'); }
  });
  assert.ok(restrictedBlocked.blockers.some((blocker) => (
    blocker.kind === 'campaign' && blocker.code === 'CAMPAIGN_CONTINUATION_UNSUPPORTED'
  )));

  // All non-budget prerequisites are satisfied in this fixture. Budget absence
  // alone must stop dispatch, not merely accompany unrelated readiness failures.
  let dispatched = 0;
  await assert.rejects(executeV11FinalAcceptanceRun({ ...readyInput, providerBudget: null,
    executeAdapter: async () => { dispatched += 1; throw new Error('not reached'); },
    requestOuter: async () => { dispatched += 1; throw new Error('not reached'); }
  }), (e) => e.code === 'NOT_READY'
    && e.readiness.blockers.length === 1 && e.readiness.blockers[0].code === 'PROVIDER_BUDGET_REQUIRED');
  assert.equal(dispatched, 0);

  // The two refusals this input has to pass through, checked against the same
  // READY candidate rather than against a fixture of their own - they fire
  // before the plan loop, so asking costs one readiness computation each.
  //
  // A review deleted both guards and watched 2344 tests stay green, and deleted
  // the CLI's call and watched the same. The requirement is what makes the
  // reconciliation a property of a run rather than of a caller, so the
  // requirement is what has to be tested.
  await assert.rejects(
    executeV11FinalAcceptanceRun({ ...readyInput, reconcileProviderEvidence: undefined }),
    /must reconcile its own provider evidence/u
  );
  await assert.rejects(
    executeV11FinalAcceptanceRun({ ...readyInput, reconcileProviderEvidence: 'yes please' }),
    /must reconcile its own provider evidence/u
  );
  // An answer that is not a verdict is not a reconciliation: an artifact would
  // be written beside a run nobody judged. This guard sits after the plan loop -
  // there is nothing to reconcile before it - so each case is a whole run and
  // needs its own ledgers; two cover the shapes, an answer that is not an object
  // and one whose status is not a string.
  let spare = 0;
  for (const answer of [undefined, { status: 42 }]) {
    spare += 1;
    const spareProgress = await createProgressLedger({
      path: path.join(outputDirectory, `spare-${spare}.progress.ndjson`),
      runId: 'run-v11-connected',
      attemptId: 'attempt-v11-connected',
      monotonicNow: () => (monotonic += 5)
    });
    const spareUnits = await createUnitEvidenceLedger({
      path: path.join(outputDirectory, `spare-${spare}.units.ndjson`),
      runId: 'run-v11-connected',
      attemptId: 'attempt-v11-connected',
      sensitiveValues: []
    });
    await assert.rejects(
      executeV11FinalAcceptanceRun({
        ...readyInput,
        progress: spareProgress,
        persistUnit: (unit) => spareUnits.append(unit),
        reconcileProviderEvidence: () => answer
      }),
      /must report a status/u,
      JSON.stringify(answer ?? null)
    );
    await spareProgress.close();
    await spareUnits.close();
  }

  const outcome = await executeV11FinalAcceptanceRun(readyInput);

  assert.equal(outcome.readiness.readiness, 'READY');
  // The reconciliation ran, saw this run's own record, and its verdict is
  // carried out with the artifact rather than left to the caller to ask for.
  assert.equal(reconciled.length, 1);
  assert.equal(reconciled[0], outcome.raw);
  assert.equal(outcome.providerEvidence.status, 'RECONCILED');
  assert.equal(outcome.acceptanceEligibility.status, 'ELIGIBLE_FOR_SCORED');
  assert.equal(outcome.acceptanceEligibility.implementationLockHash, '4'.repeat(64));
  assert.equal(outcome.acceptanceEligibility.amendment009Sha256, sourceHashes.amendment009Sha256);
  assert.equal(outcome.raw.units.length, 308);
  assert.equal(outcome.raw.mode, 'ACCEPTANCE');
  assert.equal(outcome.validation.valid, true, 'the validator must accept the run it just produced');
  assert.equal(outcome.aggregate.mode, 'ACCEPTANCE');

  const rawPath = path.join(outputDirectory, 'cli-v11-raw.json');
  const aggregatePath = path.join(outputDirectory, 'cli-v11-aggregate.json');
  await writeFile(rawPath, `${JSON.stringify(outcome.raw)}\n`, 'utf8');
  const cliAggregate = await runCli(['aggregate', '--input', rawPath, '--output', aggregatePath]);
  assert.equal(cliAggregate.code, 0, `${cliAggregate.stderr}\n${cliAggregate.stdout}`);
  const cliAggregateArtifact = JSON.parse(await readFile(aggregatePath, 'utf8'));
  assert.equal(cliAggregateArtifact.schemaVersion, 2);
  assert.equal(cliAggregateArtifact.mode, 'ACCEPTANCE');

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

  const acceptedRawPath = path.join(outputDirectory, 'accepted.raw.json');
  const acceptedProviderPath = path.join(outputDirectory, 'accepted.provider-reconciliation.json');
  const acceptedEligibilityPath = path.join(outputDirectory, 'accepted.acceptance-eligibility.json');
  await Promise.all([
    writeFile(acceptedRawPath, `${JSON.stringify(outcome.raw)}\n`, 'utf8'),
    writeFile(acceptedProviderPath, `${JSON.stringify(outcome.providerEvidence)}\n`, 'utf8'),
    writeFile(acceptedEligibilityPath, `${JSON.stringify(outcome.acceptanceEligibility)}\n`, 'utf8')
  ]);
  const acceptedPreflight = await runCli([
    'v11-preflight', '--mode', 'scored',
    '--acceptance-evidence', acceptedEligibilityPath,
    '--accepted-raw', acceptedRawPath,
    '--accepted-reconciliation', acceptedProviderPath
  ]);
  assert.ok([0, 1].includes(acceptedPreflight.code), acceptedPreflight.stderr);
  assert.notEqual(acceptedPreflight.stdout, '', acceptedPreflight.stderr);
  const acceptedPreflightReport = JSON.parse(acceptedPreflight.stdout);
  assert.deepEqual(acceptedPreflightReport.acceptanceEligibility, {
    status: 'ELIGIBLE_FOR_SCORED',
    runId: outcome.raw.runId,
    attemptId: outcome.raw.attemptId
  });
  const tamperedEligibilityPath = path.join(outputDirectory, 'tampered.acceptance-eligibility.json');
  await writeFile(tamperedEligibilityPath, `${JSON.stringify({
    ...outcome.acceptanceEligibility,
    rawSha256: 'f'.repeat(64)
  })}\n`, 'utf8');
  const tamperedPreflight = await runCli([
    'v11-preflight', '--mode', 'scored',
    '--acceptance-evidence', tamperedEligibilityPath,
    '--accepted-raw', acceptedRawPath,
    '--accepted-reconciliation', acceptedProviderPath
  ]);
  assert.equal(tamperedPreflight.code, 1);
  assert.match(tamperedPreflight.stderr, /does not match the supplied raw/iu);

  const scoredCandidate = await loadV11ScoredDefinition({ repositoryRoot: REPOSITORY_ROOT });
  const scoredGateDirectory = await scratchDirectory(t, 'shadowgraph-v11-scored-ready-');
  for (const file of ['model-weights.lock.json', 'service-images.json', 'python-wheels.lock.json']) {
    await writeFile(
      path.join(scoredGateDirectory, file),
      await readFile(path.join(BENCHMARK_ROOT, file))
    );
  }
  const nativeObservedAt = '2026-09-08T09:59:00.000Z';
  const identityProtocol = {
    meterIssuedOpaqueAlias: true,
    durablePlanBeforeDispatch: true,
    rootInvocationAndDispatchIds: true,
    bodyIndependentIdentity: true,
    contextCarrierOnly: true,
    planClosureBeforeReconciliation: true,
    aggregateCapIndependentOfAliases: true,
    campaignReservationJoinedBeforeDispatch: true
  };
  const recoverySpecs = [
    { armId: 'graphiti', requestClass: 'internal_memory_llm', category: 'B', packageName: 'graphiti-core', packageVersion: '0.29.3', modelId: 'qwen2.5:7b' },
    { armId: 'cognee', requestClass: 'internal_memory_llm', category: 'B', packageName: 'cognee', packageVersion: '1.5.3', modelId: 'qwen2.5:7b' },
    { armId: 'cognee', requestClass: 'internal_memory_llm', category: 'C', packageName: 'cognee', packageVersion: '1.5.3', modelId: 'qwen2.5:7b' },
    { armId: 'cognee', requestClass: 'embedding', category: 'B', packageName: 'cognee', packageVersion: '1.5.3', modelId: 'nomic-embed-text:v1.5' }
  ];
  const nativeEntries = [];
  for (const spec of recoverySpecs) {
    const chat = spec.requestClass === 'internal_memory_llm';
    const taxonomy = Object.fromEntries(['A', 'B', 'C', 'D', 'E'].map((name) => [name, name === spec.category]));
    const wireAttempts = spec.category === 'C'
      ? [1, 2, 3].map((ordinal) => ({
          ordinal,
          path: '/v1/chat/completions',
          outcome: 'SUCCEEDED',
          modelId: spec.modelId,
          retryOrdinal: 0,
          responseFormat: 'json_object'
        }))
      : [
          { ordinal: 1, path: chat ? '/v1/chat/completions' : '/v1/embeddings', outcome: 'FAILED', modelId: spec.modelId, retryOrdinal: 0, responseFormat: chat ? 'json_object' : null },
          { ordinal: 2, path: chat ? '/v1/chat/completions' : '/v1/embeddings', outcome: 'SUCCEEDED', modelId: spec.modelId, retryOrdinal: 1, responseFormat: chat ? 'json_object' : null }
        ];
    const reportName = `${spec.armId}-${spec.requestClass}-${spec.category}.report.json`;
    const reportText = `${JSON.stringify({
      schema: 'shadowgraph.v11.native-attempt-loopback-report',
      version: 1,
      observedAt: nativeObservedAt,
      amendment006Sha256: scoredCandidate.sourceHashes.amendment006Sha256,
      amendment008Sha256: scoredCandidate.sourceHashes.amendment008Sha256,
      identityProtocol,
      armId: spec.armId,
      requestClass: spec.requestClass,
      category: spec.category,
      package: { name: spec.packageName, version: spec.packageVersion },
      modelId: spec.modelId,
      network: 'loopback-only',
      rootOperationInvocations: 1,
      wireAttempts,
      taxonomy,
      allAttemptsMetered: true,
      providerUsageAccounting: 'metered-complete-or-fail-closed',
      modelEndpointPinned: true,
      harnessOperationReruns: 0
    })}\n`;
    await writeFile(path.join(scoredGateDirectory, reportName), reportText, 'utf8');
    nativeEntries.push({
      armId: spec.armId,
      requestClass: spec.requestClass,
      category: spec.category,
      package: { name: spec.packageName, version: spec.packageVersion },
      modelId: spec.modelId,
      outcome: 'PASS',
      network: 'loopback-only',
      wireRequests: wireAttempts.length,
      allAttemptsMetered: true,
      providerUsageAccounting: 'metered-complete-or-fail-closed',
      modelEndpointPinned: true,
      harnessOperationReruns: 0,
      taxonomy,
      probeReport: reportName,
      probeSha256: createHash('sha256').update(reportText).digest('hex')
    });
  }
  const scoredNativeAttemptEvidencePath = path.join(scoredGateDirectory, 'native-attempt-evidence.json');
  await writeFile(scoredNativeAttemptEvidencePath, `${JSON.stringify({
    schema: 'shadowgraph.v11.native-attempt-evidence',
    version: 1,
    observedAt: nativeObservedAt,
    amendment006Sha256: scoredCandidate.sourceHashes.amendment006Sha256,
    amendment008Sha256: scoredCandidate.sourceHashes.amendment008Sha256,
    identityProtocol,
    entries: nativeEntries
  })}\n`, 'utf8');
  const scoredProgressPath = path.join(outputDirectory, 'scored.progress.ndjson');
  const scoredUnitEvidencePath = path.join(outputDirectory, 'scored.units.ndjson');
  const scoredProgress = await createProgressLedger({
    path: scoredProgressPath,
    runId: 'run-v11-scored-connected',
    attemptId: 'attempt-v11-scored-connected',
    monotonicNow: () => (monotonic += 5)
  });
  const scoredUnitEvidence = await createUnitEvidenceLedger({
    path: scoredUnitEvidencePath,
    runId: 'run-v11-scored-connected',
    attemptId: 'attempt-v11-scored-connected',
    sensitiveValues: []
  });
  t.after(async () => {
    await scoredProgress.close().catch(() => {});
    await scoredUnitEvidence.close().catch(() => {});
  });
  const scoredApplicability = new Map(
    scoredCandidate.definition.arms.map((arm) => [arm.id, arm.applicability])
  );
  const scoredRegistry = {
    descriptors: scoredCandidate.definition.arms.map((arm) => {
      const runtime = {
        graphiti: { packageName: 'graphiti-core', version: '0.29.3' },
        cognee: { packageName: 'cognee', version: '1.5.3' }
      }[arm.id] ?? {};
      return {
        armId: arm.id,
        kind: arm.id === 'no-memory' ? 'control' : 'node-mcp',
        requiredService: null,
        ...runtime
      };
    }),
    verifyApplicability: () => ({ status: 'CONSISTENT', findings: [] }),
    expectedCounts: () => ({ ...scoredCandidate.definition.expectedCounts })
  };
  const scoredReconciled = [];
  const scoredDefinition = { ...scoredCandidate.definition };
  Object.defineProperty(scoredDefinition, 'marketingThresholds', {
    enumerable: true,
    get() {
      assert.equal(scoredReconciled.length, 1, 'scored aggregation must follow reconciliation');
      return scoredCandidate.definition.marketingThresholds;
    }
  });
  let scoredOutcome;
  try {
    scoredOutcome = await executeV11ScoredRun({
    ...readyInput,
    ...scoredCandidate,
    definition: scoredDefinition,
    registry: scoredRegistry,
    acceptanceEligibility: outcome.acceptanceEligibility,
    benchmarkRoot: scoredGateDirectory,
    nativeAttemptEvidencePath,
    verificationInstant: Date.parse('2026-09-08T10:00:00.000Z'),
    runId: 'run-v11-scored-connected',
    attemptId: 'attempt-v11-scored-connected',
    providerBudget: {
      schema: 'shadowgraph.v11.provider-budget',
      version: 1,
      authorizationRef: 'offline-scored-test-only',
      runId: 'run-v11-scored-connected',
      attemptId: 'attempt-v11-scored-connected',
      implementationLockHash: '4'.repeat(64),
      maxRetries: 0,
      limits: { outer_decision_llm: 1950, internal_memory_llm: 0, embedding: 0 }
    },
    amendment009Path: AMENDMENT_009_PATH,
    amendment009SidecarPath: AMENDMENT_009_SIDECAR_PATH,
    progress: scoredProgress,
    persistUnit: (unit) => scoredUnitEvidence.append(unit),
    executeAdapter: async (request) => stubEnvelope(request, scoredApplicability),
    reconcileProviderEvidence: (raw) => {
      scoredReconciled.push(raw);
      return cleanProviderReconciliation(raw);
    }
  });
  } catch (error) {
    assert.fail(JSON.stringify(error?.readiness?.blockers ?? { code: error?.code, message: error?.message }));
  }

  assert.equal(scoredOutcome.readiness.readiness, 'READY');
  assert.equal(scoredOutcome.raw.mode, 'SCORED');
  assert.equal(
    scoredOutcome.raw.acceptanceEligibilitySha256,
    createHash('sha256').update(canonicalJson(outcome.acceptanceEligibility)).digest('hex')
  );
  assert.equal(scoredOutcome.raw.units.length, 2310);
  assert.equal(scoredOutcome.raw.units.filter(({ status }) => status === 'MEASURED').length, 2160);
  assert.equal(scoredOutcome.raw.units.filter(({ status }) => status === 'EXCLUDED').length, 150);
  assert.equal(scoredOutcome.validation.valid, true);
  assert.equal(scoredOutcome.providerEvidence.status, 'RECONCILED');
  assert.equal(scoredReconciled.length, 1);
  assert.equal(scoredReconciled[0], scoredOutcome.raw);
  assert.equal(scoredOutcome.aggregate.mode, 'SCORED');
  assert.equal(scoredOutcome.aggregate.armResults.length, 7);
  assert.equal(scoredOutcome.aggregate.bestClaimAllowed, false);
  const reportProviderEvidence = {
    ...scoredOutcome.providerEvidence,
    events: scoredOutcome.raw.units
      .filter(({ providerUsage }) => providerUsage !== null)
      .map((unit, index) => ({
        requestNumber: index + 1,
        requestClass: 'outer_decision_llm',
        outcome: 'SUCCEEDED',
        providerModel: unit.providerModel,
        latencyMs: 1,
        usage: structuredClone(unit.providerUsage),
        correlation: {
          runId: unit.runId,
          attemptId: unit.attemptId,
          armId: unit.armId,
          scenarioId: unit.scenarioId,
          repetition: unit.repetition,
          phase: unit.phase
        }
      }))
  };
  const finalReport = buildV11FinalReport({
    raw: scoredOutcome.raw,
    aggregate: scoredOutcome.aggregate,
    providerReconciliation: reportProviderEvidence,
    scenarios: scoredCandidate.scenarios,
    amendment: JSON.parse(await readFile(AMENDMENT_009_PATH, 'utf8'))
  });
  assert.equal(finalReport.validity.length, 7);
  assert.ok(finalReport.metrics.every(({ numerator, denominator, validSampleCount }) => (
    Number.isFinite(numerator) && denominator > 0 && validSampleCount > 0
  )));
  assert.ok(finalReport.pairwise.some(({ candidate, comparator }) => (
    candidate === 'shadowgraph-full' && comparator === 'no-memory'
  )));
  assert.equal(finalReport.pairwise.length, 192);
  assert.ok(finalReport.pairwise.every(({ comparabilityStatus, confidenceInterval }) => (
    comparabilityStatus === 'VALIDLY_COMPARABLE'
      ? Array.isArray(confidenceInterval) && confidenceInterval.length === 2
      : confidenceInterval === null
  )));
  assert.equal(
    finalReport.fullCompactEquivalence.functionallyEquivalent,
    true,
    JSON.stringify({
      equivalence: finalReport.fullCompactEquivalence,
      nonTies: finalReport.pairwise.filter((row) => row.candidate === 'shadowgraph-full'
        && row.comparator === 'shadowgraph-compact' && row.tieClassification !== 'TIE')
    })
  );
  assert.equal(finalReport.economics.length, 7);
  assert.equal(finalReport.failures.length, 0);
  assert.equal(finalReport.methodology.bootstrap.replicates, 10000);
  const scoredRawPath = path.join(outputDirectory, 'cli-v11-scored-raw.json');
  const scoredAggregatePath = path.join(outputDirectory, 'cli-v11-scored-aggregate.json');
  const scoredProviderPath = path.join(outputDirectory, 'cli-v11-scored-provider-reconciliation.json');
  const refusedAggregatePath = path.join(outputDirectory, 'cli-v11-scored-refused-aggregate.json');
  await writeFile(scoredRawPath, `${JSON.stringify(scoredOutcome.raw)}\n`, 'utf8');
  await writeFile(scoredProviderPath, `${JSON.stringify(reportProviderEvidence)}\n`, 'utf8');
  const cliScoredValidation = await runCli(['validate', '--input', scoredRawPath]);
  assert.equal(cliScoredValidation.code, 0, `${cliScoredValidation.stderr}\n${cliScoredValidation.stdout}`);
  assert.equal(JSON.parse(cliScoredValidation.stdout).valid, true);
  const refusedAggregate = await runCli([
    'aggregate', '--input', scoredRawPath, '--output', refusedAggregatePath
  ]);
  assert.equal(refusedAggregate.code, 1);
  await assert.rejects(readFile(refusedAggregatePath), { code: 'ENOENT' });
  const selfAssertedAggregate = await runCli([
    'aggregate', '--input', scoredRawPath, '--output', scoredAggregatePath,
    '--provider-reconciliation', scoredProviderPath
  ]);
  assert.equal(selfAssertedAggregate.code, 1);
  await assert.rejects(readFile(scoredAggregatePath), { code: 'ENOENT' });
  const finalReportDirectory = path.join(outputDirectory, 'final-report');
  const selfAssertedReport = await runCli([
    'v11-final-report',
    '--raw', scoredRawPath,
    '--aggregate', path.join(outputDirectory, 'missing-scored-aggregate.json'),
    '--provider-reconciliation', scoredProviderPath,
    '--out', finalReportDirectory
  ]);
  assert.equal(selfAssertedReport.code, 1);
  await assert.rejects(readdir(finalReportDirectory), { code: 'ENOENT' });
  const acceptedRawBeforeOverwriteProbe = await readFile(acceptedRawPath, 'utf8');
  const overwriteProbe = await runCli(['aggregate', '--input', acceptedRawPath, '--output', acceptedRawPath]);
  assert.equal(overwriteProbe.code, 1);
  assert.equal(await readFile(acceptedRawPath, 'utf8'), acceptedRawBeforeOverwriteProbe);
  const scoredProgressLines = (await readFile(scoredProgressPath, 'utf8')).trim().split('\n');
  assert.equal(scoredProgressLines.filter((line) => JSON.parse(line).event === 'checkpoint').length, 2310);
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

function serviceContainerReference(name) {
  return `fixture-service-${name}`;
}

function evidenceChecks(name) {
  const checks = [{
    kind: 'image-identity',
    endpoint: serviceContainerReference(name),
    observedAt: EVIDENCE_OBSERVED_AT,
    outcome: 'PASS',
    detail: 'fixture immutable image identity established'
  }];
  if (name === 'neo4j') {
    checks.push(
      { kind: 'http-status', endpoint: 'http://127.0.0.1:7474/', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' },
      { kind: 'cypher-statement', endpoint: 'http://127.0.0.1:7474/db/neo4j/tx/commit', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'RETURN 1 AS ok' },
      { kind: 'bolt-connect', endpoint: 'bolt://127.0.0.1:7687', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'TCP CONNECT' },
      { kind: 'authentication-posture', endpoint: serviceContainerReference(name), observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'NEO4J_AUTH=none' }
    );
    return checks;
  }
  checks.push(
    { kind: 'openai-chat-completions', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' },
    { kind: 'openai-embeddings', endpoint: 'http://127.0.0.1:11434/v1/embeddings', observedAt: EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' }
  );
  return checks;
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
    version: 2,
    observedAt: EVIDENCE_OBSERVED_AT,
    services: manifest.services.map((service, index) => {
      const containerId = `container-${service.name}`;
      return {
        name: service.name,
        image: service.image,
        resolvedDigest: service.digest,
        containerId,
        imageIdentity: {
          schema: 'shadowgraph.v11.service-image-identity',
          version: 1,
          serviceName: service.name,
          image: service.image,
          platformManifestDigest: service.digest,
          registryIndexDigest: service.registryAttestation.indexDigest,
          platform: service.platform,
          immutableReference: `${service.image.slice(0, service.image.lastIndexOf(':'))}@${service.digest}`,
          containerReference: serviceContainerReference(service.name),
          containerId,
          containerImageId: `sha256:${String(index + 1).repeat(64)}`
        },
        servedModels: service.name === 'neo4j' ? [] : servedModels,
        checks: evidenceChecks(service.name)
      };
    }),
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

test('readiness carries immutable verified evidence bytes instead of reopening a replaced path', async (t) => {
  const directory = await committedGateDirectory(t, 'shadowgraph-v11-evidence-snapshot-');
  const serviceEvidencePath = path.join(directory, 'service-evidence.json');
  await writeFile(serviceEvidencePath, JSON.stringify(await committedServiceEvidence()), 'utf8');
  const candidate = await realCandidate();
  const first = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory,
    serviceEvidencePath,
    verificationInstant: EVIDENCE_NOW
  });
  assert.ok(first.verifiedServiceEvidence, 'a valid readiness decision must retain a trusted snapshot');
  assert.match(first.serviceEvidence.evidenceSha256, /^[a-f0-9]{64}$/u);
  assert.deepEqual(serviceBlockers(first), []);

  await writeFile(serviceEvidencePath, '{ replaced after validation', 'utf8');
  let rawPathReads = 0;
  const replay = await computeV11Readiness({
    ...candidate,
    benchmarkRoot: directory,
    serviceEvidencePath,
    verifiedServiceEvidence: first.verifiedServiceEvidence,
    verificationInstant: EVIDENCE_NOW,
    readFileImpl: async (file, ...rest) => {
      if (path.resolve(file) === path.resolve(serviceEvidencePath)) {
        rawPathReads += 1;
        throw new Error('the replaced raw evidence path must not be reopened');
      }
      return await readFile(file, ...rest);
    }
  });
  assert.equal(rawPathReads, 0);
  assert.equal(replay.serviceEvidence.evidenceSha256, first.serviceEvidence.evidenceSha256);
  assert.deepEqual(replay.serviceEvidence.verifiedServices, first.serviceEvidence.verifiedServices);
  assert.deepEqual(serviceBlockers(replay), []);
});

test('case-varied service evidence clears canonical required services', async (t) => {
  const evidence = await committedServiceEvidence();
  for (const service of evidence.services) {
    service.name = service.name[0].toUpperCase() + service.name.slice(1);
  }
  const report = await readinessWithEvidence(t, 'shadowgraph-v11-evidence-case-', evidence);

  assert.deepEqual(serviceBlockers(report), []);
  assert.deepEqual([...report.serviceEvidence.verifiedServices].sort(), ['neo4j', 'ollama']);
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
  assert.deepEqual(preflightReport.blockers.map((blocker) => blocker.code), [
    'CAMPAIGN_CONFIGURATION_REQUIRED',
    'PROVIDER_BUDGET_REQUIRED',
    'DECLARED_ISOLATION_PRECONDITION_UNMET',
    'SERVICE_LIVE_ATTESTATION_REQUIRED',
    'NATIVE_ATTEMPT_EVIDENCE_REQUIRED',
    'NATIVE_ATTEMPT_EVIDENCE_REQUIRED',
    'NATIVE_ATTEMPT_EVIDENCE_REQUIRED',
    'NATIVE_ATTEMPT_EVIDENCE_REQUIRED'
  ]);
  assert.deepEqual(await readdir(outputDirectory), [], 'a still-blocked run writes nothing');
});
