// Binding the runtime a real v1.1 acceptance run executes against.
//
// This lived in `benchmark/cli.mjs` and that is the reason it is here. Three
// consecutive adversarial reviews found the same class of defect in it, and
// each time the finding was the same sentence: *no test enters this code*. A
// canary `throw` at the top of the function left the whole suite green, because
// every test that drives the CLI stops at the readiness refusal above it. So
// each guard was correct in the library it called and chosen wrongly at the
// line that called it, and reverting any of those lines passed 2344 tests:
//
//   - the runner was handed the close that shuts the ledger it still writes to,
//     which would have made every run execute 308 units and write no artifact;
//   - the bind-time runtime check was pointed at a manifest instead of the site
//     it gates, which is the in-place upgrade it was written to catch;
//   - the clock handed to the runner returned a number where the runner
//     requires an ISO string, which stops every run on its first line.
//
// Nothing in a shell script can fix that. What fixes it is being reachable, so
// the composition is a function with injectable constructors, and the run path
// is what the tests drive.
//
// The order below is not arbitrary. The implementation lock is taken **first**,
// before any file is created, because it refuses a repository with any
// untracked file - opening a ledger first would make the run unlockable and the
// failure would look like a lock defect rather than an ordering one. The meter
// comes before the hosts and before the outer transport, because both close
// over its endpoint minting. And everything comes before the runner, which
// constructs nothing.
//
// Teardown is returned rather than performed, and the run's own half of it is
// not this function's to choose: `runnerResources` carries the progress ledger,
// the unit ledger's append and the *measurement* close already paired.

import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path, { dirname, join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { createImplementationLock, discoverImplementationLockFiles } from './implementation-lock.mjs';
import { requestOuterDecision } from './outer-model.mjs';
import { createProgressLedger, createUnitEvidenceLedger } from './progress.mjs';
import { startProviderMeter } from './provider-meter.mjs';
import { validateProviderBudget } from './v11-budget.mjs';
import { openCampaignBudget } from './v11-campaign-budget.mjs';
import { createV11AdapterExecutor, V11RunError } from './v11-run.mjs';
import { observeEnvironment } from './v11-environment.mjs';
import { buildEnvironmentLock } from './v11-locks.mjs';
import { createV11NodeHosts } from './v11-node-hosts.mjs';
import { createMeteredOuterTransport } from './v11-outer-transport.mjs';
import { buildV11Prompt } from './v11-prompts.mjs';
import { providerModelsFromLock } from './v11-provider-models.mjs';
import { createV11PythonHosts } from './v11-python-hosts.mjs';
import { readPythonSiteDistributions, verifyPythonRuntime } from './v11-python-runtime.mjs';
import { validateNativeAttemptPolicy } from './v11-native-attempts.mjs';
import { resolveVerifiedServiceEvidence } from './v11-service-evidence.mjs';
import { createV11RunResources } from './v11-run-resources.mjs';
import { ADAPTER_OPERATION_TIMEOUT_MS, UNIT_TIMEOUT_MS } from './v11-runner.mjs';

/**
 * The ledger this attempt's meter writes and this attempt's run reads.
 *
 * One function, because the two call sites are far apart: a path that drifted
 * would make every run report `UNAVAILABLE` and exit non-zero for a reason that
 * has nothing to do with its traffic.
 */
export function providerLedgerPath(ledgerDirectory, attemptId) {
  return join(ledgerDirectory, `${attemptId}.provider-requests.ndjson`);
}

const CANONICAL_LOOPBACK_AUTHORITY = /^(?:127\.(?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])\.(?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])\.(?:0|[1-9]\d?|1\d{2}|2[0-4]\d|25[0-5])|\[::1\])(?::(?:0|[1-9]\d{0,4}))?$/u;
const CANONICAL_LOOPBACK_URL = /^http:\/\/([^/?#]*)(?:\/[^?#]*)?$/u;
const RAW_URI_UNSAFE = /[\s\u0000-\u001F\u007F\\]/u;
const RAW_URI_STRIPPABLE = /[\s\u0000-\u001F\u007F\\]/gu;
const RAW_URI_SCHEME = /^[A-Za-z][A-Za-z\d+.-]*:/u;

function rawAuthorityIsUnsafe(value) {
  if (typeof value !== 'string') return false;
  // This stripped value is classification-only: accepted upstreams are always
  // validated against the original bytes below. It identifies forms WHATWG
  // would repair (for example `\0http://`, `http ://`, or `https://`) before
  // they can reach URL construction, while ordinary malformed prose remains on
  // the existing absolute-URL error path.
  const schemeCandidate = value.replace(RAW_URI_STRIPPABLE, '');
  if (!RAW_URI_SCHEME.test(schemeCandidate)) return false;
  if (RAW_URI_UNSAFE.test(value)) return true;
  const match = CANONICAL_LOOPBACK_URL.exec(value);
  return match === null || !CANONICAL_LOOPBACK_AUTHORITY.test(match[1]);
}

/** Refuse a provider upstream that is not literally on loopback. */
export function assertLoopbackUpstream(value) {
  if (rawAuthorityIsUnsafe(value)) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      '--provider-upstream must be a canonical literal loopback http URL without userinfo, whitespace, query, or fragment'
    );
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new V11RunError('RUNTIME_UNAVAILABLE', '--provider-upstream must be an absolute http URL');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      '--provider-upstream must be a canonical literal loopback http URL without userinfo, whitespace, query, or fragment'
    );
  }
  const host = parsed.hostname.replace(/^\[|\]$/gu, '');
  const loopback = host === '::1' || /^127(?:\.\d{1,3}){3}$/u.test(host);
  if (parsed.protocol !== 'http:' || !loopback) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      '--provider-upstream must be a literal loopback http URL: a measured run may not reach a remote provider'
    );
  }
}

const REAL = Object.freeze({
  startProviderMeter,
  openCampaignBudget,
  createProgressLedger,
  createUnitEvidenceLedger,
  createImplementationLock,
  discoverImplementationLockFiles,
  observeEnvironment,
  buildEnvironmentLock,
  createV11NodeHosts,
  createV11PythonHosts,
  createV11AdapterExecutor,
  createMeteredOuterTransport,
  requestOuterDecision,
  readPythonSiteDistributions,
  verifyPythonRuntime,
  readFile,
  mkdir,
  now: () => new Date().toISOString(),
  monotonicNow: () => performance.now()
});

/**
 * Bind the runtime dependencies a real run needs.
 *
 * `v11RuntimeDependencies` threw `RUNTIME_UNAVAILABLE` for the whole life of the
 * candidate, and the refusal was correct while it stood: a placeholder here
 * would have let a readiness change start a run against hosts nobody
 * provisioned. What replaces it keeps that property - everything below either
 * resolves to a real, pinned thing or refuses by name.
 *
 * @param {object} input paths and locks the caller has already resolved
 * @param {object} [injections] constructors, so a test can drive this
 */
export async function bindV11Runtime(input, injections = {}) {
  const providerBudget = validateProviderBudget(input.providerBudget, {
    runId: input.runId, attemptId: input.attemptId
  });
  const build = { ...REAL, ...injections };
  const {
    repositoryRoot,
    benchmarkRoot,
    competitorLock,
    definition,
    nativeAttemptPolicy,
    registry,
    runId,
    attemptId,
    verifiedServiceEvidence,
    ledgerDirectory,
    providerUpstream,
    stateRoot,
    pythonStateRoot,
    pythonRuntimeSite,
    platform = process.platform
  } = input;

  let normalizedNativeAttemptPolicy;
  try {
    normalizedNativeAttemptPolicy = validateNativeAttemptPolicy(nativeAttemptPolicy);
  } catch {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      'the frozen arm-neutral native-attempt policy is missing or invalid'
    );
  }

  // The Python executor refuses win32 outright, and its container launch reads
  // POSIX uid/gid. Saying so here names the real constraint instead of
  // surfacing an executor error about process groups.
  if (platform === 'win32') {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      'a v1.1 acceptance run requires a POSIX host: the pinned Python arms run in containers owned by the invoking user'
    );
  }

  if (typeof providerUpstream !== 'string' || providerUpstream.length === 0) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      'a v1.1 acceptance run requires --provider-upstream <loopback OpenAI-compatible base url>'
    );
  }
  // The meter refuses a non-loopback upstream itself, but by then a ledger has
  // been opened and a socket bound. Refusing here names the flag.
  assertLoopbackUpstream(providerUpstream);

  if (stateRoot === null || pythonStateRoot === null || pythonRuntimeSite === null
    || stateRoot === undefined || pythonStateRoot === undefined || pythonRuntimeSite === undefined) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      'a v1.1 acceptance run requires --state-root, --python-state-root and --python-runtime (the installed site directory)'
    );
  }
  // The Python executor adopts its root by writing an ownership marker and
  // refuses a non-empty root without one; the node adapters write no marker. One
  // shared root therefore makes whichever arm runs second refuse, at a point
  // where the message would describe the state root rather than the collision.
  if (path.resolve(stateRoot) === path.resolve(pythonStateRoot)) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      'the node and Python arms need separate state roots: the Python executor takes ownership of its own'
    );
  }

  // The site directory the four Python arms import, checked against the lock
  // that was supposed to have built it.
  //
  // `verifyPythonRuntime` had exactly one caller - the build command - so the
  // run path mounted whatever `--python-runtime` named. A site built from a
  // stale wheel lock, or one where a transitive dependency was upgraded in
  // place, satisfies every arm's own `require_versions` (which checks only that
  // arm's top-level pinned distribution) and produces an artifact whose
  // implementation and environment lock hashes are identical to a run on the
  // locked 227-package set. Neither lock can cover this directory - the
  // implementation lock covers tracked repository sources and the environment
  // lock's fields are frozen - so refusing here is what makes those hashes mean
  // the configuration that was actually measured.
  const wheelsLockText = await build.readFile(join(benchmarkRoot, 'python-wheels.lock.json'), 'utf8');
  const runtimeManifestPath = join(dirname(path.resolve(pythonRuntimeSite)), 'runtime-manifest.json');
  let runtimeManifest;
  try {
    runtimeManifest = JSON.parse(await build.readFile(runtimeManifestPath, 'utf8'));
  } catch (error) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      `--python-runtime must name a site directory built by v11-python-runtime; ${runtimeManifestPath} could not be read: ${error?.message ?? error}`
    );
  }
  // The distributions come from the site the arms will import, and everything
  // else - the image, the wheel-lock hash, the recorded import probes - from the
  // manifest that claims to describe it. Verifying only the manifest was the
  // defect a review found here: `pip install --target <site> --upgrade httpx`
  // left the manifest untouched and the bind-time check reported valid, which is
  // precisely the in-place upgrade this refusal was written for.
  let siteDistributions;
  try {
    siteDistributions = await build.readPythonSiteDistributions(pythonRuntimeSite);
  } catch (error) {
    throw new V11RunError('RUNTIME_UNAVAILABLE', error?.message ?? String(error));
  }
  const runtimeVerification = build.verifyPythonRuntime({
    manifest: { ...runtimeManifest, distributions: siteDistributions },
    wheelsLock: JSON.parse(wheelsLockText),
    wheelsLockSha256: createHash('sha256').update(wheelsLockText, 'utf8').digest('hex'),
    image: competitorLock.pythonImage
  });
  if (!runtimeVerification.valid) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      `the pinned Python runtime does not match the wheel lock: ${JSON.stringify(runtimeVerification.findings)}`
    );
  }

  const modelWeights = JSON.parse(
    await build.readFile(join(benchmarkRoot, 'model-weights.lock.json'), 'utf8')
  );
  const pinnedModels = providerModelsFromLock(modelWeights);
  const preregistration = JSON.parse(
    await build.readFile(join(benchmarkRoot, 'preregistration.json'), 'utf8')
  );
  const execution = preregistration.commonExecution;

  // Runtime binding consumes the exact service-evidence snapshot preflight
  // verified. It never reopens --service-evidence: replacing that raw path after
  // readiness cannot change the immutable service identities or its byte hash.
  if (verifiedServiceEvidence === null || verifiedServiceEvidence === undefined) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      'the implementation lock requires a verified service-evidence snapshot from readiness'
    );
  }
  let serviceManifest;
  try {
    serviceManifest = JSON.parse(await build.readFile(join(benchmarkRoot, 'service-images.json'), 'utf8'));
  } catch {
    throw new V11RunError('RUNTIME_UNAVAILABLE', 'the committed service manifest could not be read for verified service evidence');
  }
  const verifiedServices = resolveVerifiedServiceEvidence({
    snapshot: verifiedServiceEvidence,
    serviceManifest,
    modelWeights,
    now: Date.now()
  });
  if (verifiedServices.evidenceSha256 === null || verifiedServices.serviceImages.length === 0) {
    throw new V11RunError(
      'RUNTIME_UNAVAILABLE',
      `verified service evidence is unavailable: ${verifiedServices.findings.map((finding) => finding.code).join(',')}`
    );
  }
  const { serviceImages, evidenceSha256: serviceEvidenceSha256 } = verifiedServices;

  // 1. The lock, before anything creates a file.
  const implementationLock = await build.createImplementationLock({
    repoRoot: repositoryRoot,
    files: await build.discoverImplementationLockFiles(repositoryRoot),
    models: modelWeights.models,
    serviceImages,
    serviceEvidenceSha256
  });

  // 2. The machine, observed rather than asserted.
  validateProviderBudget(providerBudget, { implementationLockHash: implementationLock.lockSha256 ?? null });
  const environmentLock = build.buildEnvironmentLock({
    observations: await build.observeEnvironment({ pythonImage: competitorLock.pythonImage })
  });

  // 3. Now files may be created.
  await build.mkdir(ledgerDirectory, { recursive: true });
  await build.mkdir(stateRoot, { recursive: true });
  await build.mkdir(pythonStateRoot, { recursive: true });

  const closers = [];
  const disposeOnFailure = async () => {
    for (const close of closers.reverse()) {
      try {
        await close();
      } catch {
        // A failed construction is already being reported; a teardown error on
        // top of it would replace the reason with a symptom.
      }
    }
  };

  try {
    let campaign = null;
    if (input.campaign !== undefined) {
      campaign = await build.openCampaignBudget(input.campaign.root, input.campaign.policy, { implementationLockHash: implementationLock.lockSha256 });
      closers.push(() => campaign.close());
      await campaign.beginSession(attemptId, {
        kind: 'acceptance',
        runId,
        attemptId
      });
    }
    const meter = await build.startProviderMeter({
      listenerUrl: 'http://127.0.0.1:0',
      upstreamBaseUrl: providerUpstream,
      upstreamAuthorization: null,
      ledgerPath: providerLedgerPath(ledgerDirectory, attemptId),
      upstreamTimeoutMs: execution.requestTimeoutMs
    }, {
      budget: providerBudget,
      requireRootOperation: true,
      requireDispatchPlans: true,
      maxAttemptsPerRootRequestClass: normalizedNativeAttemptPolicy.maxAttemptsPerRootRequestClass,
      ...(campaign === null ? {} : {
      campaignReserve: (dispatch) => campaign.reserve(dispatch)
    }) });
    closers.push(() => meter.close());

    const progress = await build.createProgressLedger({
      path: join(ledgerDirectory, `${attemptId}.progress.ndjson`),
      runId,
      attemptId,
      unitTimeoutMs: UNIT_TIMEOUT_MS
    });
    closers.push(() => progress.close());

    const unitEvidence = await build.createUnitEvidenceLedger({
      path: join(ledgerDirectory, `${attemptId}.units.ndjson`),
      runId,
      attemptId,
      sensitiveValues: []
    });
    closers.push(() => unitEvidence.close());

    const providerEndpointFor = async (_requestClass, correlation, plan) => {
      const route = await meter.bindPlannedEndpoint({
        ...correlation,
        ...plan
      });
      if (!route || typeof route.endpoint !== 'string') {
        throw new Error('planned provider route did not establish an endpoint');
      }
      return Object.freeze({ endpoint: route.endpoint });
    };

    const executeAdapter = build.createV11AdapterExecutor({
      registry,
      hosts: {
        ...build.createV11NodeHosts({ stateRoot }),
        ...build.createV11PythonHosts({
          stateRoot: pythonStateRoot,
          runtimeRoot: pythonRuntimeSite,
          providerEndpointFor,
          modelWeights,
          // Stated here rather than left to the executor's own default. That
          // default is 30s, sized for a 0.5b model, and omitting this argument
          // is exactly what F25 was: an operation ceiling three and a half
          // times smaller than the work the pinned model now does, on a line no
          // test entered.
          timeoutMs: ADAPTER_OPERATION_TIMEOUT_MS
        })
      }
    });

    const requestOuter = build.createMeteredOuterTransport({
      meter,
      model: pinnedModels.internal_memory_llm.modelId,
      seeds: definition.commonExecution.randomSeeds,
      temperature: execution.temperature,
      maxOutputTokens: execution.maxOutputTokens,
      timeoutMs: execution.requestTimeoutMs,
      requestDecision: build.requestOuterDecision
    });

    // Two closes, not one: the runner's hook may only reach the meter, because
    // the terminal progress event it has not written yet goes into a ledger the
    // same call would otherwise shut. See v11-run-resources.mjs.
    const resources = createV11RunResources({ meter, progress, unitEvidence });
    const { runnerResources } = resources;
    let closePromise = null;
    const close = () => {
      if (closePromise === null) closePromise = (async () => {
        const failures = [];
        try { await resources.close(); } catch (error) { failures.push(error); }
        try { await campaign?.close(); } catch (error) { failures.push(error); }
        if (failures.length === 1) throw failures[0];
        if (failures.length > 1) throw new AggregateError(failures, 'Run and campaign cleanup failed');
      })();
      return closePromise;
    };

    return {
      dependencies: {
        providerBudget,
        executeAdapter,
        buildOuterRequest: buildV11Prompt,
        requestOuter,
        // The progress ledger, the unit ledger's append and the *measurement*
        // close, paired in v11-run-resources.mjs rather than here.
        ...runnerResources,
        // An ISO string, not `Date.now()`. The runner stamps `startedAt` with
        // `assertIsoTimestamp(options.now(), 'now')` before it appends
        // `run_started`, so a numeric clock stopped every run on its first line -
        // after the meter, the ledgers and both locks had been built.
        now: build.now,
        monotonicNow: build.monotonicNow,
        implementationLockHash: implementationLock.lockSha256,
        environmentLockHash: environmentLock.digest
      },
      close,
      // Returned so the reconciliation compares the ledger against the models
      // this run was actually bound to, rather than against a second reading of
      // the lock that could drift from it.
      pinnedModels,
      // Reported in the run's summary, so the artifact is not the only place
      // that says which site was measured - the environment lock's ten fields
      // cannot name it and the implementation lock covers tracked sources only.
      runtime: Object.freeze({
        manifestPath: runtimeManifestPath,
        sitePath: pythonRuntimeSite,
        distributions: siteDistributions.length,
        serviceEvidenceSha256
      })
    };
  } catch (error) {
    await disposeOnFailure();
    throw error;
  }
}
