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
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createProgressLedger } from '../benchmark/lib/progress.mjs';
import { buildV11Prompt } from '../benchmark/lib/v11-prompts.mjs';
import { ADAPTER_OPERATION_TIMEOUT_MS, UNIT_TIMEOUT_MS } from '../benchmark/lib/v11-runner.mjs';
import { captureVerifiedServiceEvidence } from '../benchmark/lib/v11-service-evidence.mjs';
import { bindV11Runtime, providerLedgerPath } from '../benchmark/lib/v11-runtime-binding.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const IMAGE = `python:3.12.11-slim@sha256:${'4'.repeat(64)}`;
// Distinct from IMAGE on purpose. The manifest records the image a site was
// *built* against; the competitor lock names the image the benchmark pins.
// `verifyPythonRuntime` compares them, and while the fixture made them equal
// the comparison could be made self-comparing on the run path with the whole
// suite green - which is the same shape as the wheel-lock hash beside it.
const MANIFEST_IMAGE = `python:3.12.11-slim@sha256:${'5'.repeat(64)}`;
const WHEELS_LOCK = { schemaVersion: 1, wheels: [{ name: 'httpx==0.28.1', sha256: 'c'.repeat(64) }] };
const MANIFEST = {
  schema: 'shadowgraph.v11.python-runtime',
  version: 1,
  image: MANIFEST_IMAGE,
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
      modelId: 'qwen2.5:7b',
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
const SERVICE_MANIFEST = JSON.parse(readFileSync(
  new URL('../benchmark/service-images.json', import.meta.url),
  'utf8'
));
const SERVICE_EVIDENCE_OBSERVED_AT = new Date().toISOString();
const SERVICE_EVIDENCE = {
  schema: 'shadowgraph.v11.service-evidence',
  version: 2,
  observedAt: SERVICE_EVIDENCE_OBSERVED_AT,
  services: SERVICE_MANIFEST.services.map((service, index) => {
    const containerId = `fixture-container-${service.name}`;
    const containerReference = `fixture-service-${service.name}`;
    const common = {
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
        containerReference,
        containerId,
        containerImageId: `sha256:${String(index + 1).repeat(64)}`
      },
      checks: [{
        kind: 'image-identity', endpoint: containerReference,
        observedAt: SERVICE_EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'fixture identity'
      }]
    };
    if (service.name === 'neo4j') {
      return {
        ...common,
        servedModels: [],
        checks: [...common.checks,
          { kind: 'http-status', endpoint: 'http://127.0.0.1:7474/', observedAt: SERVICE_EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' },
          { kind: 'cypher-statement', endpoint: 'http://127.0.0.1:7474/db/neo4j/tx/commit', observedAt: SERVICE_EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'RETURN 1' }
        ]
      };
    }
    return {
      ...common,
      servedModels: MODEL_WEIGHTS.models.map(({ modelId, weightsDigest }) => ({ modelId, weightsDigest })),
      checks: [...common.checks,
        { kind: 'openai-chat-completions', endpoint: 'http://127.0.0.1:11434/v1/chat/completions', observedAt: SERVICE_EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' },
        { kind: 'openai-embeddings', endpoint: 'http://127.0.0.1:11434/v1/embeddings', observedAt: SERVICE_EVIDENCE_OBSERVED_AT, outcome: 'PASS', detail: 'HTTP 200' }
      ]
    };
  })
};
const SERVICE_EVIDENCE_TEXT = JSON.stringify(SERVICE_EVIDENCE);
const VERIFIED_SERVICE_EVIDENCE = captureVerifiedServiceEvidence({
  evidenceText: SERVICE_EVIDENCE_TEXT,
  serviceManifest: SERVICE_MANIFEST,
  modelWeights: MODEL_WEIGHTS,
  now: Date.now()
});
// Distinct, so a swap is visible: the run record carries both, and they say
// different things about what was measured.
const IMPLEMENTATION_LOCK_HASH = '1'.repeat(64);
const ENVIRONMENT_LOCK_HASH = '2'.repeat(64);
const REQUEST_OUTER_DECISION = async () => ({ decision: null });
const NATIVE_ATTEMPT_POLICY = Object.freeze({
  schema: 'shadowgraph.v11.native-attempt-policy',
  version: 1,
  maxAttemptsPerRootRequestClass: 24,
  arms: [{
    armId: 'fixture-arm',
    recovery: {
      outer_decision_llm: [],
      internal_memory_llm: [],
      embedding: []
    }
  }]
});


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
    // Records what it was asked to bind. The meter mints one capability per
    // (correlation, request class), so what the arm is handed is only as
    // attributable as the correlation that was passed - and a double that
    // dropped it left the single wire between a metered arm and the meter
    // asserted by its URL suffix alone.
    bindEndpoint: (correlation) => {
      seen.endpoints.push(correlation);
      return `http://127.0.0.1:43100/v1/${correlation.requestClass}`;
    },
    bindPlannedEndpoint: async (input) => {
      seen.plannedEndpoints.push(input);
      const endpoint = `http://127.0.0.1:43100/v1/planned-${input.requestClass}`;
      return {
        endpoint,
        declareEndpoint: `${endpoint}/__shadowgraph/declare`,
        closeEndpoint: `${endpoint}/__shadowgraph/close`
      };
    }
  };

  const seen = {
    created: [],
    siteRead: [],
    endpoints: [],
    plannedEndpoints: [],
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
      if (file.endsWith('service-images.json')) return JSON.stringify(SERVICE_MANIFEST);
      if (file.endsWith('preregistration.json')) return JSON.stringify(PREREGISTRATION);
      throw Object.assign(new Error(`unexpected read: ${file}`), { code: 'ENOENT' });
    },
    mkdir: async (target) => {
      trace.push(`mkdir:${path.basename(target)}`);
      seen.created.push(target);
    },
    readPythonSiteDistributions: async (sitePath) => {
      trace.push('read-site');
      seen.siteRead.push(sitePath);
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
    providerBudget: {
      schema: 'shadowgraph.v11.provider-budget', version: 1, authorizationRef: 'offline-test-only',
      runId: 'run-binding-1', attemptId: 'attempt-binding-1', implementationLockHash: IMPLEMENTATION_LOCK_HASH,
      maxRetries: 0, limits: { outer_decision_llm: 1, internal_memory_llm: 1, embedding: 1 }
    },
    repositoryRoot: directory,
    benchmarkRoot: path.join(directory, 'benchmark'),
    competitorLock: { pythonImage: IMAGE },
    definition: { commonExecution: { randomSeeds: [11, 22] } },
    nativeAttemptPolicy: NATIVE_ATTEMPT_POLICY,
    registry: { descriptorFor: () => ({}) },
    runId: 'run-binding-1',
    attemptId: 'attempt-binding-1',
    verifiedServiceEvidence: VERIFIED_SERVICE_EVIDENCE,
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

test('the acceptance binding passes its exact authorized budget to the meter', async (t) => {
  const h = await harness(t);
  let options;
  const original = h.injections.startProviderMeter;
  h.injections.startProviderMeter = async (config, actual) => {
    options = actual;
    return original(config);
  };
  const bound = await bindV11Runtime(h.input, h.injections);
  try {
    assert.deepEqual(options, {
      budget: h.input.providerBudget,
      requireRootOperation: true,
      requireDispatchPlans: true,
      maxAttemptsPerRootRequestClass: 24
    });
  }
  finally { await bound.close(); }
});

test('an otherwise configured runtime cannot begin discovery with an unresolved budget', async (t) => {
  const h = await harness(t);
  for (const providerBudget of [undefined, {}, { ...h.input.providerBudget, maxRetries: 1 }]) {
    await assert.rejects(bindV11Runtime({ ...h.input, providerBudget }, h.injections), /budget/iu);
  }
  assert.deepEqual(h.trace, []);
});

test('the acceptance binding reserves against its persistent campaign before dispatch', async (t) => {
  const h = await harness(t);
  const calls = [];
  h.input.campaign = { root: path.join(h.directory, 'campaign'), policy: {
    campaignId: 'offline-only', implementationLockHash: IMPLEMENTATION_LOCK_HASH,
    maxRequests: 2, maxSessions: 3, maxRecoveryAttempts: 0,
    deadline: '2099-01-01T00:00:00.000Z',
    limits: { outer_decision_llm: 1, internal_memory_llm: 1, embedding: 1 }
  } };
  const dispatch = {
    requestClass: 'embedding', runId: h.input.runId, attemptId: h.input.attemptId,
    armId: 'cognee', scenarioId: 'ACC_PLAN_1', repetition: 0, phase: 'A',
    rootOperation: 'persist', rootInvocationId: 'root-campaign-1',
    plannedDispatchId: 'a'.repeat(48), planSlot: 'adapter-embedding:child:1',
    disposition: 'data-dependent-child'
  };
  h.injections.openCampaignBudget = async (root, policy) => {
    calls.push(['open', root, policy]);
    return { beginSession: async (...args) => calls.push(['session', ...args]),
      reserve: async (input) => { calls.push(['reserve', input]); return { reservationId: 'offline-only:1' }; },
      close: async () => calls.push(['close']) };
  };
  const original = h.injections.startProviderMeter;
  let meterOptions;
  h.injections.startProviderMeter = async (config, options) => {
    meterOptions = options;
    return original(config);
  };
  const bound = await bindV11Runtime(h.input, h.injections);
  try {
    assert.equal(typeof meterOptions.campaignReserve, 'function');
    assert.deepEqual(await meterOptions.campaignReserve(dispatch), { reservationId: 'offline-only:1' });
    assert.deepEqual(calls.slice(0, 3), [
      ['open', h.input.campaign.root, h.input.campaign.policy],
      ['session', h.input.attemptId, {
        kind: 'acceptance', runId: h.input.runId, attemptId: h.input.attemptId
      }],
      ['reserve', dispatch]
    ]);
  } finally { await bound.close(); }
  assert.deepEqual(calls.at(-1), ['close']);
});

test('a budget for different implementation bytes refuses before environment or file creation', async (t) => {
  const h = await harness(t);
  h.input.providerBudget.implementationLockHash = 'f'.repeat(64);
  await assert.rejects(bindV11Runtime(h.input, h.injections), (e) => e.code === 'PROVIDER_BUDGET_MISMATCH');
  assert.equal(h.trace.includes('observe-environment'), false);
  assert.deepEqual(h.seen.created, []);
  assert.deepEqual(h.meterConfig, []);
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
    [{ verifiedServiceEvidence: null }, /verified service-evidence snapshot/u]
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

test('the acceptance binding refuses a raw or schema-less service-evidence substitute', async (t) => {
  const { input, injections } = await harness(t);
  input.verifiedServiceEvidence = {
    services: [{ name: 'ollama', image: 'ollama/ollama:0.12.3', resolvedDigest: `sha256:${'d'.repeat(64)}` }]
  };

  await assert.rejects(
    bindV11Runtime(input, injections),
    /verified service evidence|service-evidence snapshot/u
  );
});

test('a replacement raw path cannot alter the snapshot-derived implementation identity', async (t) => {
  const { input, injections, seen, trace } = await harness(t);
  const rawPath = path.join(input.ledgerDirectory, 'replaced-service-evidence.json');
  input.serviceEvidencePath = rawPath;
  const originalReadFile = injections.readFile;
  injections.readFile = async (file, ...rest) => {
    if (file === rawPath) {
      return JSON.stringify({ schema: 'replaced', services: [] });
    }
    return await originalReadFile(file, ...rest);
  };

  const bound = await bindV11Runtime(input, injections);
  try {
    assert.equal(trace.some((entry) => entry === 'read:replaced-service-evidence.json'), false);
    assert.equal(seen.implementationLock[0].serviceEvidenceSha256, VERIFIED_SERVICE_EVIDENCE.evidenceSha256);
    assert.deepEqual(seen.implementationLock[0].serviceImages, VERIFIED_SERVICE_EVIDENCE.serviceImages);
  } finally {
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
  assert.equal(verified[0].image, IMAGE, 'the image the benchmark pins');
  assert.notEqual(verified[0].image, MANIFEST.image,
    'not the one the manifest says it was built against - that is the comparison');
  assert.deepEqual(verified[0].manifest.distributions, MANIFEST.distributions);
  // And the site those distributions were read from is the one the arms mount.
  assert.deepEqual(seen.siteRead, [input.pythonRuntimeSite]);

  // The meter listens on loopback. Every other loopback constraint in this
  // binding is asserted; this one decides what the meter is reachable *from*.
  assert.equal(meterConfig[0].listenerUrl, 'http://127.0.0.1:0');

  // The implementation lock receives exactly the immutable service identities
  // and the evidence-byte hash captured by readiness, never a reopened path.
  assert.deepEqual(seen.implementationLock, [{
    repoRoot: input.repositoryRoot,
    files: [`${input.repositoryRoot}/benchmark/cli.mjs`],
    models: MODEL_WEIGHTS.models,
    serviceImages: VERIFIED_SERVICE_EVIDENCE.serviceImages,
    serviceEvidenceSha256: VERIFIED_SERVICE_EVIDENCE.evidenceSha256
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

  // The per-operation deadline, stated rather than defaulted. This argument was
  // absent, and `python-adapter-executor.mjs` fell back to its own 30s default -
  // sized when the pinned model was 0.5b, and three and a half times smaller than
  // the 105.9s Cognee's persist measures at 7B. The run would have recorded a
  // harness ceiling as the product failing. Nothing caught it, because an omitted
  // argument looks like every other line of a composition until something asserts
  // it is there.
  assert.equal(seen.pythonHosts[0].timeoutMs, ADAPTER_OPERATION_TIMEOUT_MS);

  // And it has to stay under the unit deadline, so a genuinely stuck unit is
  // reported by the unit watchdog rather than by whichever operation was running.
  assert.ok(ADAPTER_OPERATION_TIMEOUT_MS < UNIT_TIMEOUT_MS,
    'the operation ceiling must sit below the unit ceiling');

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
  assert.equal(outer.model, 'qwen2.5:7b');
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

  // The directories a run creates, and no others: its ledger directory and
  // one state root per host family, in that order because the two locks are
  // built before anything is written. Asserted by full path - a basename says
  // nothing about which root was made, and the two roots were swappable.
  assert.deepEqual(seen.created, [
    input.ledgerDirectory,
    input.stateRoot,
    input.pythonStateRoot
  ]);

  // The prompt builder is the one this methodology froze, not an injected one.
  // The runner accepts a builder because that is what makes the runner
  // testable; the run path is where that freedom has to end.
  assert.equal(bound.dependencies.buildOuterRequest, buildV11Prompt);

  // And what the run reports about the site it measured. Neither lock can
  // name it: the environment lock's fields are frozen, and the implementation
  // lock covers tracked repository sources.
  assert.deepEqual({ ...bound.runtime }, {
    manifestPath: path.join(path.dirname(path.resolve(input.pythonRuntimeSite)), 'runtime-manifest.json'),
    sitePath: input.pythonRuntimeSite,
    distributions: MANIFEST.distributions.length,
    serviceEvidenceSha256: VERIFIED_SERVICE_EVIDENCE.evidenceSha256
  });

  await bound.close();
});

test('the endpoint the Python arms are given is a meter-owned planned capability', async (t) => {
  // `providerEndpointFor` is the only thing connecting a metered arm to the
  // meter, and it must carry the pre-dispatch plan rather than a broad route.
  const { input, injections, seen } = await harness(t);
  const bound = await bindV11Runtime(input, injections);

  const correlation = {
    runId: input.runId,
    attemptId: input.attemptId,
    armId: 'cognee',
    scenarioId: 'ACC_ONE',
    repetition: 0,
    phase: 'B',
    requestClass: 'embedding',
    rootOperation: 'persist'
  };
  const plan = {
    rootInvocationId: '0f0f0f0f-1111-4222-8333-444444444444',
    rootOperation: 'persist',
    planSlot: 'adapter-embedding',
    identityMode: 'dynamic'
  };
  const route = await seen.pythonHosts[0].providerEndpointFor('embedding', correlation, plan);
  assert.deepEqual(route, { endpoint: 'http://127.0.0.1:43100/v1/planned-embedding' });
  // The whole plan and correlation reach the meter. No legacy broad binding may
  // mint a route capable of silently accepting an unplanned child request.
  assert.deepEqual(seen.endpoints, []);
  assert.deepEqual(seen.plannedEndpoints, [{ ...correlation, ...plan }]);
  assert.notEqual(seen.plannedEndpoints[0], correlation, 'the plan is copied into a new binding record');

  await bound.close();
});
