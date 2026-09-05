// The composition a real run executes against, driven.
//
// This suite exists because of what three adversarial reviews kept finding. The
// binding used to live in `benchmark/cli.mjs`, past the readiness refusal that
// every CLI test stops at, so a canary `throw` at the top of it left the whole
// suite green. Each guard it called was tested; the line that called it was not.
// Reverting any one of those lines passed 2344 tests:
//
//   - handing the runner the close that shuts the ledger it still writes to
//     (every run executes 308 units and writes no artifact);
//   - pointing the runtime check at the manifest instead of the site it gates
//     (the in-place upgrade it exists to catch);
//   - a clock returning a number where the runner requires an ISO string
//     (every run dies on its first line).
//
// All three are asserted here, against the real module, with doubles for the
// things that would otherwise need a container, a socket and a clean worktree.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { createProgressLedger } from '../benchmark/lib/progress.mjs';
import { UNIT_TIMEOUT_MS } from '../benchmark/lib/v11-runner.mjs';
import { bindV11Runtime, providerLedgerPath } from '../benchmark/lib/v11-runtime-binding.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const IMAGE = `python:3.12.11-slim@sha256:${'4'.repeat(64)}`;
const WHEELS_LOCK = { schemaVersion: 1, wheels: [{ name: 'httpx==0.28.1', sha256: 'c'.repeat(64) }] };
const MANIFEST = {
  schema: 'shadowgraph.v11.python-runtime',
  version: 1,
  image: IMAGE,
  wheelsLockSha256: 'ignored - the double verifies',
  distributions: [{ name: 'httpx', version: '0.28.1' }]
};
const PREREGISTRATION = {
  commonExecution: { requestTimeoutMs: 30_000, temperature: 0, maxOutputTokens: 512 }
};
const MODEL_WEIGHTS = {
  schemaVersion: 1,
  models: [
    {
      kind: 'decision_llm',
      modelId: 'qwen2.5:0.5b',
      digestKind: 'model_weights',
      weightsDigest: `sha256:${'a'.repeat(64)}`,
      embeddingDimension: null
    },
    {
      kind: 'embedding',
      modelId: 'nomic-embed-text:v1.5',
      digestKind: 'model_weights',
      weightsDigest: `sha256:${'b'.repeat(64)}`,
      embeddingDimension: 768
    }
  ]
};
const SERVICE_EVIDENCE = {
  services: [{ name: 'ollama', image: 'ollama/ollama:0.12.3', resolvedDigest: `sha256:${'d'.repeat(64)}` }]
};
// Distinct, so a swap is visible: the run record carries both, and they say
// different things about what was measured.
const IMPLEMENTATION_LOCK_HASH = '1'.repeat(64);
const ENVIRONMENT_LOCK_HASH = '2'.repeat(64);
const REQUEST_OUTER_DECISION = async () => ({ decision: null });


/**
 * Every constructor the binding reaches for, replaced.
 *
 * The doubles are recorders rather than stubs where the order matters: the
 * implementation lock has to be taken before any file is created, because it
 * refuses a repository with an untracked file.
 */
async function harness(t, overrides = {}) {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-binding-');
  const trace = [];
  const closed = [];
  const progressPath = path.join(directory, 'progress.ndjson');
  const meter = {
    close: async () => {
      closed.push('meter');
    },
    bindEndpoint: (correlation) => `http://127.0.0.1:43100/v1/${correlation.requestClass}`
  };

  const seen = {
    nodeHosts: [],
    pythonHosts: [],
    adapterExecutor: [],
    outerTransport: [],
    implementationLock: [],
    environmentLock: [],
    progressLedger: [],
    unitLedger: []
  };

  const injections = {
    readFile: async (file) => {
      trace.push(`read:${path.basename(file)}`);
      if (file.endsWith('python-wheels.lock.json')) return JSON.stringify(WHEELS_LOCK);
      if (file.endsWith('runtime-manifest.json')) return JSON.stringify(MANIFEST);
      if (file.endsWith('model-weights.lock.json')) return JSON.stringify(MODEL_WEIGHTS);
      if (file.endsWith('preregistration.json')) return JSON.stringify(PREREGISTRATION);
      if (file.endsWith('service-evidence.json')) return JSON.stringify(SERVICE_EVIDENCE);
      throw Object.assign(new Error(`unexpected read: ${file}`), { code: 'ENOENT' });
    },
    mkdir: async (target) => {
      trace.push(`mkdir:${path.basename(target)}`);
    },
    readPythonSiteDistributions: async () => {
      trace.push('read-site');
      return MANIFEST.distributions;
    },
    verifyPythonRuntime: (input) => {
      trace.push('verify-runtime');
      verified.push(input);
      return { valid: true, findings: [] };
    },
    createImplementationLock: async (config) => {
      trace.push('implementation-lock');
      seen.implementationLock.push(config);
      return { lockSha256: IMPLEMENTATION_LOCK_HASH };
    },
    discoverImplementationLockFiles: async (repoRoot) => [`${repoRoot}/benchmark/cli.mjs`],
    observeEnvironment: async (config) => {
      trace.push('observe-environment');
      return { observedFor: config.pythonImage };
    },
    buildEnvironmentLock: (config) => {
      seen.environmentLock.push(config);
      return { digest: ENVIRONMENT_LOCK_HASH };
    },
    startProviderMeter: async (config) => {
      trace.push('meter');
      meterConfig.push(config);
      return meter;
    },
    createProgressLedger: async (config) => {
      trace.push('progress');
      seen.progressLedger.push(config);
      return await createProgressLedger({ ...config, path: progressPath });
    },
    createUnitEvidenceLedger: async (config) => {
      trace.push('unit-evidence');
      seen.unitLedger.push(config);
      return { append: async () => {}, close: async () => closed.push('unitEvidence') };
    },
    createV11NodeHosts: (config) => {
      seen.nodeHosts.push(config);
      return { control: () => {}, 'node-mcp': () => {} };
    },
    createV11PythonHosts: (config) => {
      seen.pythonHosts.push(config);
      return { 'python-container': () => {} };
    },
    createV11AdapterExecutor: (config) => {
      seen.adapterExecutor.push(config);
      return async () => {};
    },
    createMeteredOuterTransport: (config) => {
      seen.outerTransport.push(config);
      return async () => {};
    },
    requestOuterDecision: REQUEST_OUTER_DECISION,
    ...overrides
  };
  const verified = [];
  const meterConfig = [];

  const input = {
    repositoryRoot: directory,
    benchmarkRoot: path.join(directory, 'benchmark'),
    competitorLock: { pythonImage: IMAGE },
    definition: { commonExecution: { randomSeeds: [11, 22] } },
    registry: { descriptorFor: () => ({}) },
    runId: 'run-binding-1',
    attemptId: 'attempt-binding-1',
    serviceEvidencePath: path.join(directory, 'service-evidence.json'),
    ledgerDirectory: directory,
    providerUpstream: 'http://127.0.0.1:11434/v1',
    stateRoot: path.join(directory, 'node-state'),
    pythonStateRoot: path.join(directory, 'python-state'),
    pythonRuntimeSite: path.join(directory, 'runtime', 'site'),
    platform: 'linux'
  };

  return { input, injections, trace, closed, verified, meterConfig, progressPath, directory, seen };
}

test('the runner is handed the measurement close, and can still write its terminal event', async (t) => {
  const { input, injections, closed, progressPath } = await harness(t);
  const bound = await bindV11Runtime(input, injections);

  // The three the runner takes, and nothing renamed.
  assert.equal(typeof bound.dependencies.progress.append, 'function');
  assert.equal(typeof bound.dependencies.persistUnit, 'function');
  assert.equal(typeof bound.dependencies.closeResources, 'function');
  assert.notEqual(bound.dependencies.closeResources, bound.close);

  // The runner's hook, at the runner's moment.
  await bound.dependencies.closeResources();
  assert.deepEqual(closed, ['meter'], 'only the meter closes here');

  // The property F4 was: the terminal event still has somewhere to go.
  await bound.dependencies.progress.append({
    event: 'run_started',
    armId: null,
    scenarioId: null,
    repetition: null,
    phase: null,
    evidence: {}
  });
  await bound.dependencies.progress.append({
    event: 'run_finished',
    armId: null,
    scenarioId: null,
    repetition: null,
    phase: null,
    evidence: {}
  });

  await bound.close();
  assert.deepEqual(closed, ['meter', 'unitEvidence']);
  await assert.rejects(
    bound.dependencies.progress.append({
      event: 'run_finished',
      armId: null,
      scenarioId: null,
      repetition: null,
      phase: null,
      evidence: {}
    }),
    /Progress ledger is closed/u
  );
  assert.ok(progressPath.endsWith('progress.ndjson'));
});

test('the clock the runner is given returns an ISO timestamp', async (t) => {
  // `assertIsoTimestamp(options.now(), 'now')` is the first thing the runner
  // stamps. `Date.now()` is a Number, and it stopped every run on its first
  // line - after the meter, both ledgers and both locks had been built.
  const { input, injections } = await harness(t);
  const bound = await bindV11Runtime(input, injections);

  const stamped = bound.dependencies.now();
  assert.equal(typeof stamped, 'string');
  assert.match(stamped, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  assert.equal(new Date(stamped).toISOString(), stamped);
  assert.equal(typeof bound.dependencies.monotonicNow(), 'number');

  await bound.close();
});

test('the runtime verification is handed the site, not the manifest that describes it', async (t) => {
  // The in-place upgrade case: `pip install --target <site> --upgrade httpx`
  // leaves the manifest untouched, so verifying the manifest reports valid while
  // the arms import the upgraded package.
  const { input, injections, verified } = await harness(t, {
    readPythonSiteDistributions: async () => [{ name: 'httpx', version: '9.9.9' }]
  });
  const bound = await bindV11Runtime(input, injections);

  assert.equal(verified.length, 1);
  assert.deepEqual(verified[0].manifest.distributions, [{ name: 'httpx', version: '9.9.9' }]);
  assert.equal(verified[0].image, IMAGE, 'the image still comes from the competitor lock');
  await bound.close();
});

test('a site the wheel lock does not describe refuses the run by name', async (t) => {
  const { input, injections } = await harness(t, {
    verifyPythonRuntime: () => ({
      valid: false,
      findings: [{ code: 'DISTRIBUTION_VERSION_MISMATCH', distribution: 'httpx' }]
    })
  });

  await assert.rejects(bindV11Runtime(input, injections), (error) => {
    assert.equal(error.cause ?? error.code ?? error.reason, 'RUNTIME_UNAVAILABLE');
    assert.match(error.message, /does not match the wheel lock/u);
    assert.match(error.message, /DISTRIBUTION_VERSION_MISMATCH/u);
    return true;
  });
});

test('a site with no manifest beside it refuses, naming the path it looked for', async (t) => {
  const { input, injections } = await harness(t, {
    readFile: async (file) => {
      if (file.endsWith('runtime-manifest.json')) throw new Error('ENOENT: no such file');
      if (file.endsWith('python-wheels.lock.json')) return JSON.stringify(WHEELS_LOCK);
      throw new Error(`unexpected read: ${file}`);
    }
  });

  await assert.rejects(bindV11Runtime(input, injections), (error) => {
    assert.match(error.message, /built by v11-python-runtime/u);
    assert.match(error.message, /runtime-manifest\.json/u);
    return true;
  });
});

test('the implementation lock is taken before any file is created', async (t) => {
  // It refuses a repository with any untracked file, so opening a ledger first
  // would make the run unlockable and the failure would read as a lock defect
  // rather than an ordering one.
  const { input, injections, trace } = await harness(t);
  const bound = await bindV11Runtime(input, injections);

  const lockAt = trace.indexOf('implementation-lock');
  assert.notEqual(lockAt, -1);
  for (const later of ['mkdir:', 'meter', 'progress', 'unit-evidence']) {
    const at = trace.findIndex((entry) => entry.startsWith(later));
    assert.ok(at > lockAt, `${later} must come after the implementation lock`);
  }
  // And the environment is observed rather than asserted, before files too.
  assert.ok(trace.indexOf('observe-environment') > lockAt);
  await bound.close();
});

test('the meter writes the ledger this attempt will read back', async (t) => {
  const { input, injections, meterConfig } = await harness(t);
  const bound = await bindV11Runtime(input, injections);

  assert.equal(meterConfig.length, 1);
  assert.equal(
    meterConfig[0].ledgerPath,
    providerLedgerPath(input.ledgerDirectory, input.attemptId),
    'the meter and the reconciliation must name one file'
  );
  assert.equal(meterConfig[0].upstreamBaseUrl, input.providerUpstream);
  assert.equal(meterConfig[0].upstreamAuthorization, null);
  await bound.close();
});

test('everything already built is closed when a later step fails', async (t) => {
  const { input, injections, closed } = await harness(t, {
    createUnitEvidenceLedger: async () => {
      throw new Error('the unit ledger could not be opened');
    }
  });

  await assert.rejects(bindV11Runtime(input, injections), /unit ledger could not be opened/u);
  assert.deepEqual(closed, ['meter'], 'the meter was built, so the meter is closed');
});

test('the refusals that keep a run off a machine it cannot measure on', async (t) => {
  const { input, injections } = await harness(t);

  for (const [override, pattern] of [
    [{ platform: 'win32' }, /POSIX host/u],
    [{ providerUpstream: undefined }, /--provider-upstream/u],
    [{ providerUpstream: '' }, /--provider-upstream/u],
    [{ providerUpstream: 'https://api.openai.com/v1' }, /literal loopback/u],
    [{ providerUpstream: 'http://10.0.0.5:11434/v1' }, /literal loopback/u],
    [{ providerUpstream: 'not a url' }, /absolute http URL/u],
    [{ stateRoot: null }, /--state-root/u],
    [{ pythonStateRoot: undefined }, /--state-root/u],
    [{ pythonRuntimeSite: null }, /--state-root/u],
    [{ serviceEvidencePath: null }, /--service-evidence/u]
  ]) {
    await assert.rejects(
      bindV11Runtime({ ...input, ...override }, injections),
      pattern,
      JSON.stringify(override)
    );
  }

  // The two state roots must differ: the Python executor takes ownership of its
  // own by writing a marker, and the node adapters write none, so one shared
  // root makes whichever arm runs second refuse for a reason that describes the
  // root rather than the collision.
  await assert.rejects(
    bindV11Runtime({ ...input, pythonStateRoot: input.stateRoot }, injections),
    /separate state roots/u
  );
  // Loopback in every spelling the meter accepts. A fresh harness each time,
  // because a progress ledger refuses to reopen a path it already wrote.
  for (const upstream of ['http://127.0.0.1:11434/v1', 'http://127.9.9.9:1/v1', 'http://[::1]:11434/v1']) {
    const fresh = await harness(t);
    const bound = await bindV11Runtime({ ...fresh.input, providerUpstream: upstream }, fresh.injections);
    await bound.close();
  }
});

test('every argument of the composition, because the composition is all this does', async (t) => {
  // A review changed one token at a time in `bindV11Runtime` and ran the suite:
  // the Python arms mounting the node state root, the two state roots swapped
  // between host families, the wheel-lock hash made self-comparing, the outer
  // model and seeds and temperature, the two lock hashes swapped - six
  // mis-wirings, all green. Moving the function out of the CLI made it
  // reachable; nothing made it *asserted*. The doubles recorded their arguments
  // and no test read them.
  //
  // This asserts the wiring, argument by argument. It is long because the
  // function is a composition and there is no shorter honest way to pin one.
  const { input, injections, seen, meterConfig, verified } = await harness(t);
  const bound = await bindV11Runtime(input, injections);

  const wheelsLockSha256 = createHash('sha256')
    .update(JSON.stringify(WHEELS_LOCK), 'utf8')
    .digest('hex');

  // The runtime verification: the site's distributions, the lock read from the
  // repository, the hash computed from that text, and the image the competitor
  // lock pins. Taking the hash from the manifest instead would make
  // RUNTIME_WHEELS_LOCK_MISMATCH compare a value with itself.
  assert.equal(verified.length, 1);
  assert.deepEqual(verified[0].wheelsLock, WHEELS_LOCK);
  assert.equal(verified[0].wheelsLockSha256, wheelsLockSha256);
  assert.notEqual(verified[0].wheelsLockSha256, MANIFEST.wheelsLockSha256);
  assert.equal(verified[0].image, IMAGE);
  assert.deepEqual(verified[0].manifest.distributions, MANIFEST.distributions);

  // The implementation lock: this repository, the files discovered in it, the
  // models the weight lock pins, and the digests the service probe verified -
  // not the tags it started from.
  assert.deepEqual(seen.implementationLock, [{
    repoRoot: input.repositoryRoot,
    files: [`${input.repositoryRoot}/benchmark/cli.mjs`],
    models: MODEL_WEIGHTS.models,
    serviceImages: [{
      name: 'ollama',
      image: 'ollama/ollama:0.12.3',
      digest: SERVICE_EVIDENCE.services[0].resolvedDigest
    }]
  }]);

  // The environment lock is built from what was observed, not asserted.
  assert.deepEqual(seen.environmentLock, [{ observations: { observedFor: IMAGE } }]);

  // The two host families get their own state roots. Swapping them mounts the
  // node arms' directory into the container while the Python executor writes its
  // ownership marker where the node adapters read.
  assert.deepEqual(seen.nodeHosts, [{ stateRoot: input.stateRoot }]);
  assert.equal(seen.pythonHosts.length, 1);
  assert.equal(seen.pythonHosts[0].stateRoot, input.pythonStateRoot);
  assert.equal(seen.pythonHosts[0].runtimeRoot, input.pythonRuntimeSite,
    'the arms mount the site that was verified');
  assert.deepEqual(seen.pythonHosts[0].modelWeights, MODEL_WEIGHTS);
  assert.equal(typeof seen.pythonHosts[0].providerEndpointFor, 'function');

  // The executor routes by the registry it was given, to both families.
  assert.equal(seen.adapterExecutor.length, 1);
  assert.equal(seen.adapterExecutor[0].registry, input.registry);
  assert.deepEqual(Object.keys(seen.adapterExecutor[0].hosts).sort(), [
    'control',
    'node-mcp',
    'python-container'
  ]);

  // The outer transport is the frozen execution parameters, and the pinned chat
  // model - the same one the internal memory route uses.
  assert.equal(seen.outerTransport.length, 1);
  const outer = seen.outerTransport[0];
  assert.equal(outer.model, 'qwen2.5:0.5b');
  assert.deepEqual(outer.seeds, [11, 22]);
  assert.equal(outer.temperature, PREREGISTRATION.commonExecution.temperature);
  assert.equal(outer.maxOutputTokens, PREREGISTRATION.commonExecution.maxOutputTokens);
  assert.equal(outer.timeoutMs, PREREGISTRATION.commonExecution.requestTimeoutMs);
  assert.equal(outer.requestDecision, REQUEST_OUTER_DECISION);
  assert.equal(outer.meter.bindEndpoint !== undefined, true);

  // The meter's deadline is the frozen one too.
  assert.equal(meterConfig[0].upstreamTimeoutMs, PREREGISTRATION.commonExecution.requestTimeoutMs);

  // The ledgers are named for this attempt, and the progress ledger's stall
  // deadline is the runner's own unit timeout rather than a restated number.
  assert.equal(seen.progressLedger[0].runId, input.runId);
  assert.equal(seen.progressLedger[0].attemptId, input.attemptId);
  assert.equal(seen.progressLedger[0].unitTimeoutMs, UNIT_TIMEOUT_MS);
  assert.match(seen.progressLedger[0].path, /attempt-binding-1\.progress\.ndjson$/u);
  assert.equal(seen.unitLedger[0].runId, input.runId);
  assert.equal(seen.unitLedger[0].attemptId, input.attemptId);
  assert.match(seen.unitLedger[0].path, /attempt-binding-1\.units\.ndjson$/u);
  assert.deepEqual(seen.unitLedger[0].sensitiveValues, []);

  // And the two hashes the run record carries, each from its own lock.
  assert.equal(bound.dependencies.implementationLockHash, IMPLEMENTATION_LOCK_HASH);
  assert.equal(bound.dependencies.environmentLockHash, ENVIRONMENT_LOCK_HASH);

  await bound.close();
});

test('the endpoint the Python arms are given is minted per correlation by the meter', async (t) => {
  // `providerEndpointFor` is the only thing connecting a metered arm to the
  // meter, and it is a closure the double could not otherwise see into.
  const { input, injections, seen } = await harness(t);
  const bound = await bindV11Runtime(input, injections);

  const correlation = {
    runId: input.runId,
    attemptId: input.attemptId,
    armId: 'mem0-oss',
    scenarioId: 'ACC_ONE',
    repetition: 0,
    phase: 'B',
    requestClass: 'embedding'
  };
  const endpoint = seen.pythonHosts[0].providerEndpointFor('embedding', correlation);
  assert.equal(endpoint, 'http://127.0.0.1:43100/v1/embedding');

  await bound.close();
});
