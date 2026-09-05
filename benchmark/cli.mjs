#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, release as osRelease, totalmem, type as osType } from 'node:os';
import path, { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { aggregateRun } from './lib/aggregate.mjs';
import { adapterCommandForRecord, loadAdapterConfiguration, redactConfiguredSecrets, runAdapterRequest } from './lib/adapters.mjs';
import { NO_COMMON_MODEL_REASON, probeCommonCapabilities, readCommonModelConfiguration } from './lib/capabilities.mjs';
import { verifyPreregistration } from './lib/preregistration.mjs';
import { CONTAINER_PATHS } from './lib/python-container-runtime.mjs';
import { loadV11AcceptanceDefinition } from './lib/v11-definition.mjs';
import { LIST_DISTRIBUTIONS_SCRIPT, PYTHON_IMPORT_MODULES, pythonRuntimeManifest, renderRequirements, verifyPythonRuntime } from './lib/v11-python-runtime.mjs';
import { providerModelsFromLock } from './lib/v11-provider-models.mjs';
import { parseProviderLedger, reconcileProviderEvidence, runProviderReconciliation } from './lib/v11-provider-reconciler.mjs';
import { createV11Registry } from './lib/v11-registry.mjs';
import { combineRunFailure } from './lib/v11-run-resources.mjs';
import { bindV11Runtime, providerLedgerPath } from './lib/v11-runtime-binding.mjs';
import { computeV11Readiness, executeV11AcceptanceRun } from './lib/v11-run.mjs';
import { ollamaManifestPath, ollamaWeightsDigest, probeServices } from './lib/v11-service-probe.mjs';
import { validateRawRun } from './lib/validate.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const preregistrationPath = join(root, 'benchmark', 'preregistration.json');
const preregistrationHashPath = join(root, 'benchmark', 'preregistration.sha256');
const competitorLockPath = join(root, 'benchmark', 'competitors.lock.json');

// Probe records are evidence about the environment, not results of a run. They
// were written under `benchmark/results/`, where the candidate's own no-result
// sweep forbids any directory of that name on disk, tracked or not - so running
// a documented probe command made the test that guards the headline claim fail.
// Keeping `results/` to mean "a run happened" is what makes that claim checkable.
const PROBE_RECORDS = 'probe-records';
const HARNESS_VERSION = '1.0.0';
const PHASES = ['A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2', 'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'];

function parseArgs(argv) {
  if (argv.length === 0) {
    throw new Error(
      'Usage: benchmark/cli.mjs <preflight|v11-preflight|v11-service-probe|v11-precondition-probe|v11-fence-probe|v11-arm-probe|v11-python-runtime|v11-run|run|validate|aggregate> [options]'
    );
  }
  const command = argv[0];
  const options = {};
  const tokens = [];
  for (const token of argv.slice(1)) {
    if (token.startsWith('--') && token.includes('=')) {
      const index = token.indexOf('=');
      tokens.push(token.slice(0, index), token.slice(index + 1));
    } else tokens.push(token);
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith('--')) throw new Error(`Unexpected positional argument: ${token}`);
    const name = token.slice(2);
    const value = tokens[++index];
    if (value === undefined || value.startsWith('--')) throw new Error(`Option --${name} requires a value`);
    if (Object.hasOwn(options, name)) throw new Error(`Option --${name} was supplied more than once`);
    options[name] = value;
  }
  return { command, options };
}

function optionPath(value, fallback = null) {
  if (value === undefined) return fallback;
  return isAbsolute(value) ? value : resolve(root, value);
}

function safeRunId(value = new Date().toISOString().replace(/[-:.]/gu, '').replace('Z', 'Z')) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) throw new Error('run id must contain only letters, numbers, dot, underscore, or dash');
  return value;
}

function positiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`Expected a positive integer, received ${value}`);
  return parsed;
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function adapterFailureEvidence(error) {
  return {
    message: error instanceof Error ? error.message : 'Unknown adapter failure',
    stdout: typeof error?.stdout === 'string' ? error.stdout : '',
    stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    command: typeof error?.command === 'string' ? error.command : null,
    exitCode: Number.isInteger(error?.exitCode) ? error.exitCode : null,
    signal: typeof error?.signal === 'string' ? error.signal : null
  };
}

function adapterFailureLogLines(evidence) {
  const lines = [`Adapter failure: ${evidence.message}`];
  if (evidence.stdout.trim().length > 0) lines.push(`Adapter stdout: ${evidence.stdout.trim()}`);
  if (evidence.stderr.trim().length > 0) lines.push(`Adapter stderr: ${evidence.stderr.trim()}`);
  return [...new Set(lines)];
}

async function captured(executable, args, options = {}) {
  try {
    const run = await execFileAsync(executable, args, {
      cwd: root,
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      ...options
    });
    return { ok: true, stdout: run.stdout.trim(), stderrPresent: run.stderr.trim().length > 0 };
  } catch (error) {
    return { ok: false, exitCode: Number.isInteger(error.code) ? error.code : null };
  }
}

async function captureEnvironment() {
  const npm = process.env.npm_execpath
    ? await captured(process.execPath, [process.env.npm_execpath, '--version'])
    : process.platform === 'win32'
      ? await captured(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'npm --version'])
      : await captured('npm', ['--version']);
  const [gitCommit, gitStatus, python, pip, docker] = await Promise.all([
    captured('git', ['rev-parse', 'HEAD']),
    captured('git', ['status', '--short']),
    captured('python', ['--version']),
    captured('pip', ['--version']),
    captured('docker', ['version', '--format', '{{json .}}'])
  ]);
  const cpuList = cpus();
  let dockerValue = null;
  if (docker.ok) {
    try { dockerValue = JSON.parse(docker.stdout); } catch { dockerValue = { captured: true, parseable: false }; }
  }
  return {
    node: process.version,
    npm: npm.ok ? npm.stdout : null,
    python: python.ok ? python.stdout : null,
    pip: pip.ok ? pip.stdout : null,
    platform: process.platform,
    arch: process.arch,
    os: { type: osType(), release: osRelease() },
    cpu: { model: cpuList[0]?.model ?? 'unknown', logicalCount: cpuList.length },
    totalMemoryBytes: totalmem(),
    git: {
      commit: gitCommit.ok ? gitCommit.stdout : null,
      dirty: gitStatus.ok ? gitStatus.stdout.length > 0 : null,
      status: gitStatus.ok ? gitStatus.stdout.split(/\r?\n/u).filter(Boolean) : null
    },
    docker: dockerValue
  };
}

function dependencyEvidence(lock) {
  const logs = 'benchmark/results/20260827T153024Z/logs';
  return {
    lock,
    probes: {
      'mem0-oss': { runnable: true, version: '2.0.19', import: 'ok', logPath: `${logs}/mem0-install.log` },
      graphiti: { runnable: true, version: '0.29.3', supportPackages: ['httpx==0.28.1'], import: 'ok', logPath: `${logs}/graphiti-install-with-httpx.log`, initialFailureLogPath: `${logs}/graphiti-install.log` },
      'basic-memory': { runnable: true, version: '0.23.2', import: 'ok', logPath: `${logs}/basic-memory-install.log` },
      cognee: { runnable: true, version: '1.5.3', import: 'ok', comparativeMeasurement: false, logPath: `${logs}/cognee-install.log`, statusPath: `${logs}/cognee-install.status.json` }
    }
  };
}

function versionFor(lock, armId) {
  return lock.arms?.[armId]?.version ?? null;
}

function sanitizedCommonConfiguration(configuration) {
  if (!configuration) return { llm: null, embedding: null };
  const safeEndpoint = (value) => {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString().replace(/\/$/u, '');
  };
  return {
    llm: { id: configuration.llm.model, endpoint: safeEndpoint(configuration.llm.endpoint) },
    embedding: { id: configuration.embedding.model, endpoint: safeEndpoint(configuration.embedding.endpoint) }
  };
}

function noModelArms(preregistration, lock, logPath) {
  return preregistration.arms.map((arm) => ({
    armId: arm.id,
    name: arm.name,
    status: 'NOT_MEASURED',
    competitorVersion: versionFor(lock, arm.id),
    command: 'node benchmark/cli.mjs preflight',
    exitCode: 2,
    logPath,
    reason: NO_COMMON_MODEL_REASON
  }));
}

function expandTemplate(template, scenario, phase) {
  const values = {
    id: scenario.id,
    projectId: scenario.projectId,
    userId: scenario.userId,
    isolationProjectId: scenario.isolationProjectId,
    isolationUserId: scenario.isolationUserId,
    task: scenario.task,
    constraints_json: JSON.stringify(scenario.constraints),
    evidence_json: JSON.stringify(scenario.evidence),
    changed_fact_json: JSON.stringify(scenario.changedFact),
    irrelevant_fact_json: JSON.stringify(scenario.irrelevantFacts[Number(phase.slice(-1))])
  };
  return template.replace(/\{([a-zA-Z0-9_]+)\}/gu, (match, key) => Object.hasOwn(values, key) ? String(values[key]) : match);
}

function phasePrompt(preregistration, scenario, phase) {
  const templateKey = phase.startsWith('D_FALSE_') ? 'D_FALSE'
    : phase === 'ISOLATION_PROJECT' ? 'ISOLATION_PROJECT'
      : phase === 'ISOLATION_USER' ? 'ISOLATION_USER' : phase;
  return expandTemplate(preregistration.promptProtocol.phaseTemplates[templateKey], scenario, phase);
}

function validResponse(response, schema) {
  if (response === null || typeof response !== 'object' || Array.isArray(response)) return false;
  return Object.keys(schema).every((key) => Object.hasOwn(response, key));
}

function rotatedArmIds(preregistration, seed) {
  const ids = preregistration.arms.map((arm) => arm.id);
  const offset = seed % ids.length;
  return [...ids.slice(offset), ...ids.slice(0, offset)];
}

function measurementBase({ runId, sha256, armId, version, scenario, phase, repetition, seed, request }) {
  return {
    schemaVersion: 1,
    runId,
    preregistrationSha256: sha256,
    harnessVersion: HARNESS_VERSION,
    armId,
    competitorVersion: version,
    status: 'FAILED',
    statusReason: null,
    scenarioId: scenario.id,
    phase,
    repetition,
    seed,
    startedAt: new Date().toISOString(),
    latencyMs: null,
    request,
    response: null,
    usage: null,
    toolCalls: null,
    storageBytes: null,
    cost: null,
    scores: null,
    logs: []
  };
}

async function executeMeasuredRun({ preregistration, sha256, lock, runId, outputPath, adapterConfigPath, capabilityProbe, environment }) {
  if (!adapterConfigPath) throw new Error('A common model is available, but --adapter-config was not provided for the seven real arms');
  const armIds = preregistration.arms.map((arm) => arm.id);
  const adapters = await loadAdapterConfiguration(adapterConfigPath, armIds);
  const common = readCommonModelConfiguration(process.env);
  const secretSources = [common, ...Object.values(adapters)];
  const measurements = [];
  const failures = new Map(armIds.map((armId) => [armId, []]));
  const failureEvidence = new Map(armIds.map((armId) => [armId, []]));
  const stateRoot = join(dirname(outputPath), 'state');
  const recordFailure = (armId, unit, error) => {
    failures.get(armId).push(unit);
    const safe = redactConfiguredSecrets(adapterFailureEvidence(error), ...secretSources);
    failureEvidence.get(armId).push({ unit, ...safe });
    return safe;
  };
  for (let repetition = 0; repetition < preregistration.commonExecution.repetitions; repetition += 1) {
    const seed = preregistration.commonExecution.randomSeeds[repetition];
    for (const scenario of preregistration.scenarios) {
      for (const armId of rotatedArmIds(preregistration, seed)) {
        const stateDirectory = join(stateRoot, armId, scenario.id, String(repetition));
        await mkdir(stateDirectory, { recursive: true });
        try {
          await runAdapterRequest(adapters[armId], {
            schemaVersion: 1, action: 'reset', armId, scenarioId: scenario.id, repetition, seed, stateDirectory
          });
        } catch (error) {
          recordFailure(armId, `${scenario.id}/${repetition}/reset`, error);
        }
        for (const phase of PHASES) {
          const prompt = phasePrompt(preregistration, scenario, phase);
          const request = { system: preregistration.promptProtocol.system, prompt, responseSchema: preregistration.promptProtocol.responseSchema };
          const measurement = measurementBase({
            runId, sha256, armId, version: versionFor(lock, armId), scenario, phase, repetition, seed, request
          });
          const started = performance.now();
          try {
            const output = await runAdapterRequest(adapters[armId], {
              schemaVersion: 1,
              action: 'phase',
              armId,
              scenario,
              phase,
              repetition,
              seed,
              stateDirectory,
              request,
              commonModel: common,
              commonExecution: preregistration.commonExecution
            });
            const elapsed = performance.now() - started;
            if (!output.persistedVerified || !validResponse(output.response, preregistration.promptProtocol.responseSchema)) {
              throw new Error('adapter response or persisted-state verification failed');
            }
            Object.assign(measurement, {
              status: 'MEASURED',
              latencyMs: Number(elapsed.toFixed(3)),
              response: output.response,
              usage: output.usage,
              toolCalls: output.toolCalls,
              storageBytes: output.storageBytes,
              cost: { currency: 'USD', amount: 0, source: 'local-free' },
              logs: output.logs
            });
          } catch (error) {
            measurement.statusReason = 'The bounded real adapter request failed; no value was inferred.';
            const safe = recordFailure(armId, `${scenario.id}/${repetition}/${phase}`, error);
            measurement.logs = adapterFailureLogLines(safe);
          }
          measurements.push(measurement);
        }
      }
    }
  }
  await Promise.all(armIds.map((armId) => writeJson(
    join(dirname(outputPath), 'logs', `${armId}.log`),
    { schemaVersion: 1, armId, failures: failureEvidence.get(armId) }
  )));
  const arms = preregistration.arms.map((arm) => {
    const failed = failures.get(arm.id);
    return {
      armId: arm.id,
      name: arm.name,
      status: failed.length === 0 ? 'MEASURED' : 'FAILED',
      competitorVersion: versionFor(lock, arm.id),
      command: adapterCommandForRecord(adapters[arm.id], common),
      exitCode: failed.length === 0 ? 0 : 1,
      logPath: relative(root, join(dirname(outputPath), 'logs', `${arm.id}.log`)).replaceAll('\\', '/'),
      reason: failed.length === 0 ? null : `${failed.length} bounded adapter unit(s) failed; see raw measurements.`
    };
  });
  return redactConfiguredSecrets({ capabilityProbe, environment, arms, measurements }, ...secretSources);
}

async function createRun(options) {
  const [{ document: preregistration, sha256 }, lock] = await Promise.all([
    verifyPreregistration(preregistrationPath, preregistrationHashPath),
    readFile(competitorLockPath, 'utf8').then(JSON.parse)
  ]);
  const runId = safeRunId(options['run-id']);
  const outputPath = optionPath(options.output, join(root, 'benchmark', 'results', runId, 'raw-run.json'));
  const probeTimeoutMs = positiveInteger(options['probe-timeout-ms'], 1500);
  const startedAt = new Date().toISOString();
  const [capabilityProbe, environment] = await Promise.all([
    probeCommonCapabilities({ timeoutMs: probeTimeoutMs }),
    captureEnvironment()
  ]);
  const logPath = join(dirname(outputPath), 'logs', 'capability-probe.json');
  await writeJson(logPath, capabilityProbe);
  const common = sanitizedCommonConfiguration(readCommonModelConfiguration(process.env));
  let body;
  if (!capabilityProbe.commonModelAvailable) {
    body = {
      capabilityProbe,
      environment,
      arms: noModelArms(preregistration, lock, relative(root, logPath).replaceAll('\\', '/')),
      measurements: []
    };
  } else {
    body = await executeMeasuredRun({
      preregistration,
      sha256,
      lock,
      runId,
      outputPath,
      adapterConfigPath: optionPath(options['adapter-config']),
      capabilityProbe,
      environment
    });
  }
  const raw = {
    schemaVersion: 1,
    runId,
    preregistrationSha256: sha256,
    harnessVersion: HARNESS_VERSION,
    startedAt,
    finishedAt: new Date().toISOString(),
    configuration: {
      commonModelAvailable: capabilityProbe.commonModelAvailable,
      ...common,
      temperature: preregistration.commonExecution.temperature,
      maxInputTokens: preregistration.commonExecution.maxInputTokens,
      maxOutputTokens: preregistration.commonExecution.maxOutputTokens,
      repetitions: preregistration.commonExecution.repetitions,
      seeds: preregistration.commonExecution.randomSeeds
    },
    environment: body.environment,
    dependencies: dependencyEvidence(lock),
    capabilityProbe: body.capabilityProbe,
    arms: body.arms,
    measurements: body.measurements
  };
  validateRawRun(raw, preregistration, sha256);
  await writeJson(outputPath, raw);
  return { raw, preregistration, outputPath };
}

async function preflight(options) {
  const timeoutMs = positiveInteger(options['probe-timeout-ms'], 1500);
  const result = await probeCommonCapabilities({ timeoutMs });
  if (options.output) await writeJson(optionPath(options.output), result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.commonModelAvailable) process.exitCode = 2;
}

async function validateCommand(options) {
  const input = optionPath(options.input);
  if (!input) throw new Error('validate requires --input <raw-run.json>');
  const [{ document, sha256 }, raw] = await Promise.all([
    verifyPreregistration(preregistrationPath, preregistrationHashPath),
    readFile(input, 'utf8').then(JSON.parse)
  ]);
  const result = validateRawRun(raw, document, sha256);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function aggregateCommand(options) {
  const input = optionPath(options.input);
  if (!input) throw new Error('aggregate requires --input <raw-run.json>');
  const output = optionPath(options.output, join(dirname(input), 'aggregate.json'));
  const [{ document, sha256 }, raw] = await Promise.all([
    verifyPreregistration(preregistrationPath, preregistrationHashPath),
    readFile(input, 'utf8').then(JSON.parse)
  ]);
  validateRawRun(raw, document, sha256);
  const aggregate = aggregateRun(raw, document);
  await writeJson(output, aggregate);
  if (aggregate.allowedMarketingText) process.stdout.write(`${aggregate.allowedMarketingText}\n`);
}


/**
 * Read a JSON file for a readiness gate.
 *
 * Returns `{ state }` rather than throwing. A missing, unreadable or malformed
 * prerequisite is an unsatisfied prerequisite: letting a SyntaxError escape
 * would abort the command and emit no readiness report at all.
 */
/** Load the frozen candidate: competitor lock, registry, acceptance definition. */
async function loadV11Candidate() {
  const competitorLock = JSON.parse(await readFile(competitorLockPath, 'utf8'));
  const containerImage = competitorLock.pythonImage;
  const registry = createV11Registry({ competitorLock, containerImage });
  const loaded = await loadV11AcceptanceDefinition({ repositoryRoot: root });
  return { competitorLock, containerImage, registry, ...loaded };
}

/**
 * Refuse the flag that used to assert a precondition.
 *
 * `--preconditions` let an operator declare that a declared isolation
 * precondition held, and the v1.1 blocker matrix said plainly what that was
 * worth: an input, not proof. Dropping it silently would leave existing scripts
 * quietly weaker than they were, so it is refused by name and points at the
 * command that produces a demonstration instead.
 */
function refuseAssertedPreconditions(options) {
  if (options.preconditions !== undefined) {
    throw new Error(
      '--preconditions asserted a precondition rather than demonstrating one. '
      + 'Run v11-precondition-probe and present its record with --precondition-evidence <path>.'
    );
  }
}

/** Where a precondition demonstration is read from, if the operator names one. */
function parsePreconditionEvidencePath(options) {
  return typeof options['precondition-evidence'] === 'string'
    ? optionPath(options['precondition-evidence'])
    : null;
}

/**
 * Where a service probe record is read from, if the operator names one.
 *
 * Null when no `--service-evidence` is given, and null is the state that leaves
 * every required-service blocker standing. There is no default path: a run that
 * picked one up from a well-known location would clear its own blockers with a
 * file nobody chose to present.
 */
function parseServiceEvidencePath(options) {
  return typeof options['service-evidence'] === 'string'
    ? optionPath(options['service-evidence'])
    : null;
}

/**
 * Execute the non-scored acceptance plan.
 *
 * The readiness gate is the same computation `v11-preflight` reports, and it
 * is not overridable. There is deliberately no flag that runs over blockers:
 * they describe evidence the numbers would be read against, so a run that
 * ignored them would produce results nobody could hold to anything. A refusal
 * writes no artifact, so a blocked attempt cannot leave behind a directory
 * that later reads as evidence.
 */
async function v11RunCommand(options) {
  const candidate = await loadV11Candidate();
  const benchmarkRoot = join(root, 'benchmark');
  refuseAssertedPreconditions(options);
  const preconditionEvidencePath = parsePreconditionEvidencePath(options);

  // Readiness is decided before anything else is touched, including the
  // runtime binding. A blocked candidate must produce a refusal that names
  // its blockers, not a failure to reach hosts that were never the point.
  const serviceEvidencePath = parseServiceEvidencePath(options);
  const readiness = await computeV11Readiness({
    ...candidate,
    benchmarkRoot,
    preconditionEvidencePath,
    serviceEvidencePath
  });
  if (readiness.readiness !== 'READY') {
    process.stdout.write(`${JSON.stringify({
      schema: 'shadowgraph.v11.run',
      version: 1,
      status: 'REFUSED',
      reason: 'the candidate is not ready to execute an acceptance run',
      artifactsWritten: [],
      readiness
    }, null, 2)}`);
    process.exitCode = 1;
    return null;
  }

  const outputDirectory = optionPath(options.out, join(benchmarkRoot, 'results'));
  const runId = safeRunId(options['run-id']);
  const attemptId = safeRunId(options['attempt-id'] ?? `${runId}-attempt-1`);
  const ledgerDirectory = optionPath(options['ledger-dir'], outputDirectory);

  const runtime = await v11RuntimeDependencies(options, {
    ...candidate,
    benchmarkRoot,
    runId,
    attemptId,
    serviceEvidencePath,
    ledgerDirectory
  });

  let outcome;
  let failure = null;
  try {
    outcome = await executeV11AcceptanceRun({
      ...candidate,
      benchmarkRoot,
      preconditionEvidencePath,
      serviceEvidencePath,
      runId,
      attemptId,
      sourceHashes: candidate.sourceHashes,
      amendment002Path: join(benchmarkRoot, 'preregistration-amendment-002.json'),
      amendment003Path: join(benchmarkRoot, 'preregistration-amendment-003.json'),
      ...runtime.dependencies,
      // Judged inside the run rather than after it, so a caller cannot omit it.
      // Reached only once `closeResources` has closed the meter, which is what
      // makes the ledger complete at the moment it is read.
      reconcileProviderEvidence: (raw) => reconcileRunProviderEvidence({
        ledgerPath: providerLedgerPath(ledgerDirectory, attemptId),
        raw,
        attemptId,
        pinnedModels: runtime.pinnedModels
      })
    });
  } catch (error) {
    failure = error;
  }

  // Neither failure may hide the other, and neither may be reported twice.
  // `combineRunFailure` owns that, because this line is not one any test reaches
  // and the rule has been wrong here in both directions.
  let teardownFailure = null;
  try {
    await runtime.close();
  } catch (error) {
    teardownFailure = error;
  }
  failure = combineRunFailure(failure, teardownFailure);
  if (failure !== null) throw failure;

  const reconciliation = outcome.providerEvidence;
  const rawPath = join(outputDirectory, `${attemptId}.raw.json`);
  const aggregatePath = join(outputDirectory, `${attemptId}.aggregate.json`);
  const reconciliationPath = join(outputDirectory, `${attemptId}.provider-reconciliation.json`);
  await writeJson(rawPath, outcome.raw);
  await writeJson(aggregatePath, outcome.aggregate);
  await writeJson(reconciliationPath, reconciliation);
  process.stdout.write(`${JSON.stringify({
    schema: 'shadowgraph.v11.run',
    version: 1,
    status: outcome.raw.status,
    mode: outcome.raw.mode,
    // Always true where it is reachable: `validateRawRun` throws on an invalid
    // run rather than returning a verdict, so reaching this line is the
    // verdict. Reported because an artifact that does not say it was validated
    // is indistinguishable from one that was not.
    valid: outcome.validation.valid,
    providerEvidence: reconciliation.status,
    // Which site the arms imported, and how much of it was checked. Neither
    // lock can carry this, so the run says it.
    pythonRuntime: runtime.runtime,
    artifactsWritten: [rawPath, aggregatePath, reconciliationPath]
  }, null, 2)}`);
  // A run whose own provider traffic does not match its record is not a clean
  // result reported alongside a caveat. It is a discrepancy, and it exits so.
  //
  // The `!outcome.validation.valid` guard that used to stand beside this one is
  // gone: `validateRawRun` throws on an invalid run, so the guard could not
  // fire and read as a check that was not one.
  if (reconciliation.status !== 'RECONCILED') process.exitCode = 1;
  return outcome;
}


/**
 * Compare this attempt's provider ledger with the traffic the run recorded.
 *
 * A missing ledger is a discrepancy, not an absence: the meter opens the file
 * when the run binds, so a run that produced a record and no ledger has lost
 * its evidence, and reporting that as `RECONCILED` would be the strongest
 * possible overstatement this reconciliation can make.
 */
async function reconcileRunProviderEvidence({ ledgerPath, raw, attemptId, pinnedModels }) {
  let ledgerText = null;
  try {
    ledgerText = await readFile(ledgerPath, 'utf8');
  } catch {
    // Left null on purpose. What an unreadable ledger *means* is decided in
    // `runProviderReconciliation`, where it can be tested, rather than here.
  }
  return runProviderReconciliation({ ledgerText, ledgerPath, raw, attemptId, pinnedModels });
}

/**
 * Bind the runtime a real run executes against.
 *
 * A wrapper, deliberately. The composition itself is
 * `benchmark/lib/v11-runtime-binding.mjs`, because three consecutive reviews
 * found defects in it here and each time the finding was the same sentence: no
 * test enters this file past the readiness refusal. Everything below is option
 * parsing; everything that decides anything is in the module, where it is
 * driven by tests.
 */
async function v11RuntimeDependencies(options, context) {
  return await bindV11Runtime({
    repositoryRoot: root,
    benchmarkRoot: context.benchmarkRoot,
    competitorLock: context.competitorLock,
    definition: context.definition,
    registry: context.registry,
    runId: context.runId,
    attemptId: context.attemptId,
    serviceEvidencePath: context.serviceEvidencePath,
    ledgerDirectory: context.ledgerDirectory,
    providerUpstream: options['provider-upstream'],
    stateRoot: optionPath(options['state-root']),
    pythonStateRoot: optionPath(options['python-state-root']),
    pythonRuntimeSite: optionPath(options['python-runtime'])
  });
}

/**
 * Offline readiness check for the v1.1 candidate.
 *
 * Binds the competitor lock, the frozen acceptance definition and the observed
 * native isolation together, and reports whether they agree. It contacts no
 * service, executes no arm and produces no result: a NOT READY verdict here is
 * a statement about the candidate, not about any arm's behaviour.
 */
async function v11Preflight(options) {
  refuseAssertedPreconditions(options);
  const { registry, definition, scenarios, containerImage } = await loadV11Candidate();
  const {
    applicability,
    declaredCounts,
    derivedCounts,
    preconditionEvidence,
    serviceEvidence,
    readiness,
    blockers
  } = await computeV11Readiness({
    registry,
    definition,
    scenarios,
    benchmarkRoot: join(root, 'benchmark'),
    preconditionEvidencePath: parsePreconditionEvidencePath(options),
    serviceEvidencePath: parseServiceEvidencePath(options)
  });

  const report = {
    schema: 'shadowgraph.v11.preflight',
    version: 1,
    scored: false,
    containerImage,
    arms: registry.descriptors.map((descriptor) => ({
      armId: descriptor.armId,
      kind: descriptor.kind,
      version: descriptor.version,
      nativeProjectNamespace: descriptor.isolation.projectNamespace,
      nativeUserNamespace: descriptor.isolation.userNamespace,
      requiredServiceNames: descriptor.requiredServiceNames
    })),
    applicability,
    declaredCounts,
    derivedCounts,
    preconditionEvidence,
    serviceEvidence,
    readiness,
    blockers
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (blockers.length > 0) process.exitCode = 1;
  return report;
}

// Listing is restricted to the runtime directory. The pinned image carries its
// own pip and setuptools, and a listing that swept the whole import path would
// report those as distributions the wheel lock does not pin - a finding about
// the interpreter rather than about the runtime being built.
/**
 * Build the reproducible Python runtime the container arms execute against.
 *
 * Installed into a directory rather than baked into a derived image: a derived
 * image would have a local id and no registry digest, so it could not satisfy
 * the digest-pinned reference the container runtime requires, and it would
 * replace the interpreter the competitor lock names. Mounting the directory
 * read-only keeps the image exactly what the lock pins.
 */
async function v11PythonRuntimeCommand(options) {
  const runtimeRoot = optionPath(options.out);
  if (runtimeRoot === null) {
    throw new Error('v11-python-runtime requires --out <runtime-root>');
  }
  // The runtime is written by a container and read by the harness, so it has to
  // come out owned by the invoking user rather than by root.
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('v11-python-runtime requires a POSIX host so the built runtime is owned by the invoking user');
  }
  const benchmarkRoot = join(root, 'benchmark');
  const wheelsLockPath = join(benchmarkRoot, 'python-wheels.lock.json');
  const [competitorLock, wheelsLockText] = await Promise.all([
    readFile(competitorLockPath, 'utf8').then(JSON.parse),
    readFile(wheelsLockPath, 'utf8')
  ]);
  const wheelsLock = JSON.parse(wheelsLockText);
  const wheelsLockSha256 = createHash('sha256').update(wheelsLockText, 'utf8').digest('hex');
  const image = competitorLock.pythonImage;
  const sitePath = join(runtimeRoot, 'site');
  const manifestPath = join(runtimeRoot, 'runtime-manifest.json');

  const dockerRun = (extraArgs, command) => execFileAsync('docker', [
    'run', '--rm', '--init',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${runtimeRoot},target=/runtime`,
    '--env', 'HOME=/runtime',
    '--env', 'PIP_DISABLE_PIP_VERSION_CHECK=1',
    ...extraArgs,
    image,
    ...command
  ], { maxBuffer: 64 * 1024 * 1024 });

  if (options.verify !== 'only') {
    await mkdir(sitePath, { recursive: true });
    await writeFile(join(runtimeRoot, 'requirements.txt'), renderRequirements(wheelsLock), 'utf8');
    // Network is needed to fetch the pinned wheels and nothing else; every
    // artifact it may accept is fixed by --require-hashes.
    await dockerRun(['--network', 'host'], [
      'python', '-m', 'pip', 'install',
      '--require-hashes', '--no-cache-dir', '--no-warn-script-location',
      '--target', '/runtime/site',
      '-r', '/runtime/requirements.txt'
    ]);
  }

  const { stdout: listed } = await dockerRun(['--network', 'none'], [
    'python', '-c', LIST_DISTRIBUTIONS_SCRIPT, '/runtime/site'
  ]);
  const distributions = JSON.parse(listed);

  // A present distribution does not imply a working import, so the probe does
  // both: it imports the arm's module and then reads the distribution version
  // the lock pins. The lock's own probe string is metadata-only - it resolves a
  // .dist-info directory without executing the package - so on its own it would
  // report PASS for exactly the Graphiti failure the lock documents.
  const importProbes = [];
  for (const [armId, entry] of Object.entries(competitorLock.arms)) {
    if (typeof entry.importProbe !== 'string' || entry.type !== 'pypi') continue;
    const importModule = PYTHON_IMPORT_MODULES[armId];
    if (importModule === undefined) {
      throw new Error(`arm ${armId} is a pinned Python arm with no import module declared`);
    }
    let observed = null;
    let failure = null;
    try {
      const { stdout } = await dockerRun(
        ['--network', 'none', '--env', `PYTHONPATH=${CONTAINER_PATHS.runtime}`,
          '--mount', `type=bind,source=${sitePath},target=${CONTAINER_PATHS.runtime},readonly`],
        ['python', '-c', `import ${importModule}\n${entry.importProbe}`]
      );
      observed = stdout.trim();
    } catch (error) {
      observed = null;
      failure = String(error?.message ?? error).split('\n').slice(-3).join(' ').slice(0, 240);
      process.stderr.write(`${armId} import probe failed: ${failure}\n`);
    }
    importProbes.push({
      armId,
      package: entry.package,
      importModule,
      expected: entry.version,
      observed,
      failure,
      outcome: observed === entry.version ? 'PASS' : 'FAIL'
    });
  }

  // A build writes what it built; a verification reads what the build wrote and
  // replaces only what it can re-observe. `pythonRuntimeManifest` owns that rule,
  // because this command is entered by no test and the rule has been wrong here
  // in both directions.
  const verifyOnly = options.verify === 'only';
  let recorded = null;
  if (verifyOnly) {
    try {
      recorded = JSON.parse(await readFile(manifestPath, 'utf8'));
    } catch (error) {
      throw new Error(
        `--verify only requires the manifest the build wrote; ${manifestPath} could not be read: ${error?.message ?? error}`
      );
    }
  }
  const manifest = pythonRuntimeManifest({
    recorded,
    verifyOnly,
    image,
    wheelsLockSha256,
    distributions,
    importProbes,
    builtAt: new Date().toISOString()
  });
  if (!verifyOnly) await writeJson(manifestPath, manifest);

  const verification = verifyPythonRuntime({ manifest, wheelsLock, wheelsLockSha256, image });
  process.stdout.write(`${JSON.stringify({
    schema: 'shadowgraph.v11.python-runtime-build',
    version: 1,
    image,
    runtimeRoot,
    manifestPath,
    distributions: distributions.length,
    importProbes,
    valid: verification.valid,
    findings: verification.findings
  }, null, 2)}\n`);
  if (!verification.valid) process.exitCode = 1;
  return manifest;
}

/**
 * Run the Cognee ACL demonstration inside the pinned image and record it.
 *
 * The harness performs the demonstration rather than accepting a description of
 * one. The backend pairing is passed explicitly because the pairing *is* the
 * precondition: `ENABLE_BACKEND_ACCESS_CONTROL` plus stores that can physically
 * carry per-dataset isolation. Nothing here decides whether the result clears a
 * blocker - `v11-preflight --precondition-evidence` does that, and it refuses a
 * record whose demonstration failed.
 */
async function v11PreconditionProbeCommand(options) {
  const runtimeRoot = optionPath(options.runtime);
  const workRoot = optionPath(options.work);
  if (runtimeRoot === null || workRoot === null) {
    throw new Error('v11-precondition-probe requires --runtime <runtime-site> and --work <writable-root>');
  }
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('v11-precondition-probe requires a POSIX host so the demonstration state is owned by the invoking user');
  }
  const llmEndpoint = options['llm-endpoint'];
  const embeddingEndpoint = options['embedding-endpoint'];
  if (typeof llmEndpoint !== 'string' || typeof embeddingEndpoint !== 'string') {
    throw new Error('v11-precondition-probe requires --llm-endpoint and --embedding-endpoint');
  }

  const benchmarkRoot = join(root, 'benchmark');
  const [competitorLock, modelWeights] = await Promise.all([
    readFile(competitorLockPath, 'utf8').then(JSON.parse),
    readFile(join(benchmarkRoot, 'model-weights.lock.json'), 'utf8').then(JSON.parse)
  ]);
  const modelFor = (kind) => {
    const model = modelWeights.models.find((entry) => entry.kind === kind);
    if (model === undefined) throw new Error(`the model weight lock pins no ${kind} model`);
    return model.modelId;
  };

  const outputPath = optionPath(options.out, join(benchmarkRoot, PROBE_RECORDS, 'precondition-evidence.json'));
  const probeDirectory = join(benchmarkRoot, 'probes');
  const containerProbes = '/opt/shadowgraph/probes';
  const containerWork = '/run/shadowgraph/demonstration';

  await mkdir(join(workRoot, 'system', 'databases'), { recursive: true });
  await mkdir(join(workRoot, 'data'), { recursive: true });
  await mkdir(join(workRoot, 'home'), { recursive: true });

  // Remove any record a previous demonstration left in this working root before
  // running. Without this, a probe that never started - an unreachable
  // container runtime, an image that will not pull - would read the earlier
  // record back and present it as the outcome of a run that did not happen.
  const demonstrationPath = join(workRoot, 'precondition-evidence.json');
  await rm(demonstrationPath, { force: true });

  const environment = {
    PYTHONPATH: CONTAINER_PATHS.runtime,
    PYTHONDONTWRITEBYTECODE: '1',
    HOME: `${containerWork}/home`,
    // The precondition itself.
    ENABLE_BACKEND_ACCESS_CONTROL: 'true',
    // The pairing that can carry it. Both are file-backed, so the
    // demonstration needs no service beyond the common endpoint.
    VECTOR_DB_PROVIDER: 'lancedb',
    VECTOR_DATASET_DATABASE_HANDLER: 'lancedb',
    GRAPH_DATABASE_PROVIDER: 'ladybug',
    GRAPH_DATASET_DATABASE_HANDLER: 'ladybug',
    DATA_ROOT_DIRECTORY: `${containerWork}/data`,
    SYSTEM_ROOT_DIRECTORY: `${containerWork}/system`,
    TELEMETRY_DISABLED: '1',
    COGNEE_TRACING_ENABLED: 'false',
    OTEL_SDK_DISABLED: 'true',
    SHADOWGRAPH_LLM_ENDPOINT: llmEndpoint,
    SHADOWGRAPH_EMBEDDING_ENDPOINT: embeddingEndpoint,
    // Cognee routes its completion path through litellm, which requires the
    // provider prefix to resolve a model it has not seen before. The embedding
    // path uses the OpenAI-compatible engine directly and takes the bare id.
    SHADOWGRAPH_LLM_MODEL: `openai/${modelFor('decision_llm')}`,
    SHADOWGRAPH_EMBEDDING_MODEL: modelFor('embedding'),
    SHADOWGRAPH_DEMONSTRATION_OUTPUT: `${containerWork}/precondition-evidence.json`
  };

  const args = [
    'run', '--rm', '--init',
    '--network', 'host',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${runtimeRoot},target=${CONTAINER_PATHS.runtime},readonly`,
    '--mount', `type=bind,source=${probeDirectory},target=${containerProbes},readonly`,
    '--mount', `type=bind,source=${workRoot},target=${containerWork}`
  ];
  for (const name of Object.keys(environment).sort()) {
    args.push('--env', `${name}=${environment[name]}`);
  }
  args.push(competitorLock.pythonImage, 'python', `${containerProbes}/cognee_acl_demonstration.py`);

  let demonstrationFailed = false;
  try {
    await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    // A demonstration that fails is a recorded outcome, not a crash. The probe
    // still writes its record, and the record is what the gate reads.
    demonstrationFailed = true;
    if (typeof error?.stderr === 'string' && error.stderr.length > 0) process.stderr.write(error.stderr);
  }

  let evidence;
  try {
    evidence = JSON.parse(await readFile(demonstrationPath, 'utf8'));
  } catch (error) {
    // No record at all means the demonstration never reached the point of
    // writing one. That is a failure to report, not a record to invent.
    throw new Error(
      `the demonstration wrote no record; the probe did not run to completion: ${error?.message ?? error}`
    );
  }
  await writeJson(outputPath, evidence);
  process.stdout.write(`${JSON.stringify({
    schema: 'shadowgraph.v11.precondition-probe',
    version: 1,
    armId: evidence.armId ?? null,
    precondition: evidence.precondition ?? null,
    observedAt: evidence.observedAt ?? null,
    outcome: evidence.outcome ?? 'FAIL',
    outputPath,
    steps: (evidence.steps ?? []).map((entry) => ({ step: entry.step, outcome: entry.outcome }))
  }, null, 2)}\n`);
  if (demonstrationFailed || evidence.outcome !== 'PASS') process.exitCode = 1;
  return evidence;
}

/**
 * Demonstrate that no measured arm can reach a model the benchmark has not
 * pinned.
 *
 * Unlike the ACL demonstration this one is not about a single arm's capability.
 * Every Python arm in the shared runtime has a path to unpinned weights that the
 * provider meter cannot see - Basic Memory enables semantic search whenever
 * `fastembed` is importable and embeds locally with `bge-small-en-v1.5`, Mem0's
 * Qdrant store pulls `Qdrant/bm25` on the write path, LiteLLM fetches its cost
 * map at import, and Cognee resolves tokenizers from HuggingFace and tiktoken.
 * The frozen `providerMetering.rule` and `sameConfigurationRule` already forbid
 * all of it, so closing these is conformance rather than a change of method.
 *
 * The probe runs the real libraries against the pinned runtime and reports what
 * happened, including failure. It mounts the adapters directory as well as the
 * probes directory so that the gate under demonstration is the one `python_host`
 * actually applies rather than a restatement of it.
 */
async function v11FenceProbeCommand(options) {
  const runtimeRoot = optionPath(options.runtime);
  const workRoot = optionPath(options.work);
  if (runtimeRoot === null || workRoot === null) {
    throw new Error('v11-fence-probe requires --runtime <runtime-site> and --work <writable-root>');
  }
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('v11-fence-probe requires a POSIX host so the demonstration state is owned by the invoking user');
  }

  const benchmarkRoot = join(root, 'benchmark');
  const competitorLock = JSON.parse(await readFile(competitorLockPath, 'utf8'));
  const outputPath = optionPath(options.out, join(benchmarkRoot, PROBE_RECORDS, 'fence-evidence.json'));
  const probeDirectory = join(benchmarkRoot, 'probes');
  const adapterDirectory = join(benchmarkRoot, 'adapters');
  const containerProbes = '/opt/shadowgraph/probes';
  const containerWork = '/run/shadowgraph/demonstration';

  await mkdir(workRoot, { recursive: true });

  // A record left by an earlier run would otherwise be read back and presented
  // as the outcome of a run that never started.
  const demonstrationPath = join(workRoot, 'fence-evidence.json');
  await rm(demonstrationPath, { force: true });

  const environment = {
    PYTHONPATH: `${CONTAINER_PATHS.runtime}:${CONTAINER_PATHS.adapters}`,
    PYTHONDONTWRITEBYTECODE: '1',
    HOME: containerWork,
    SHADOWGRAPH_DEMONSTRATION_OUTPUT: `${containerWork}/fence-evidence.json`
  };

  // The host network namespace is what the measured units get, so it is what
  // the demonstration has to run in: a fence proven under `--network none`
  // would prove nothing about the configuration that is actually measured.
  const args = [
    'run', '--rm', '--init',
    '--network', 'host',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${runtimeRoot},target=${CONTAINER_PATHS.runtime},readonly`,
    '--mount', `type=bind,source=${probeDirectory},target=${containerProbes},readonly`,
    '--mount', `type=bind,source=${adapterDirectory},target=${CONTAINER_PATHS.adapters},readonly`,
    '--mount', `type=bind,source=${workRoot},target=${containerWork}`,
    '--workdir', containerWork
  ];
  for (const name of Object.keys(environment).sort()) {
    args.push('--env', `${name}=${environment[name]}`);
  }
  args.push(competitorLock.pythonImage, 'python', `${containerProbes}/unpinned_model_fence_demonstration.py`);

  let demonstrationFailed = false;
  try {
    await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    demonstrationFailed = true;
    if (typeof error?.stderr === 'string' && error.stderr.length > 0) process.stderr.write(error.stderr);
  }

  let evidence;
  try {
    evidence = JSON.parse(await readFile(demonstrationPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `the demonstration wrote no record; the probe did not run to completion: ${error?.message ?? error}`
    );
  }
  await writeJson(outputPath, evidence);
  process.stdout.write(`${JSON.stringify({
    schema: 'shadowgraph.v11.fence-probe',
    version: 1,
    precondition: evidence.precondition ?? null,
    observedAt: evidence.observedAt ?? null,
    outcome: evidence.outcome ?? 'FAIL',
    outputPath,
    steps: (evidence.steps ?? []).map((entry) => ({ step: entry.step, outcome: entry.outcome }))
  }, null, 2)}\n`);
  if (demonstrationFailed || evidence.outcome !== 'PASS') process.exitCode = 1;
  return evidence;
}

// What each arm's runtime has to be shown doing, and what its demonstration
// needs to do it. One entry per arm that has one; an arm without an entry is
// refused rather than silently skipped.
//
// The environments differ because the questions do. Mem0's is about execution,
// so it needs the pinned model endpoint. Cognee's is about who assigns a
// dataset its id, which is answered entirely inside the file-backed stores the
// ACL demonstration established - and asking it without a model endpoint is
// part of the answer being narrow.
const ARM_PROBES = Object.freeze({
  'mem0-oss': Object.freeze({
    script: 'mem0_execution_demonstration.py',
    requiresModelEndpoint: true,
    environment: (work) => ({
      SHADOWGRAPH_STATE_ROOT: `${work}/state`,
      SHADOWGRAPH_PROVIDER_LEDGER: `${work}/provider-ledger.ndjson`
    }),
    directories: ['state'],
    // The probe's proxy writes the same ledger the harness's meter writes, so
    // the agreement between what the arm claims and what crossed the wire can be
    // judged by the reconciler that will judge the real run.
    ledger: 'provider-ledger.ndjson'
  }),
  cognee: Object.freeze({
    script: 'cognee_dataset_identity_demonstration.py',
    // Even a question about dataset identity needs one: Cognee's `add` runs a
    // pipeline that tests the LLM connection before it will ingest anything.
    requiresModelEndpoint: true,
    environment: (work) => ({
      HOME: `${work}/home`,
      VECTOR_DB_PROVIDER: 'lancedb',
      VECTOR_DATASET_DATABASE_HANDLER: 'lancedb',
      GRAPH_DATABASE_PROVIDER: 'ladybug',
      GRAPH_DATASET_DATABASE_HANDLER: 'ladybug',
      DATA_ROOT_DIRECTORY: `${work}/data`,
      SYSTEM_ROOT_DIRECTORY: `${work}/system`,
      TELEMETRY_DISABLED: '1',
      COGNEE_TRACING_ENABLED: 'false',
      OTEL_SDK_DISABLED: 'true',
      LITELLM_LOCAL_MODEL_COST_MAP: 'True'
    }),
    directories: ['home', 'data', 'system/databases']
  })
});

/**
 * Demonstrate that one arm executes a real benchmark unit.
 *
 * The run path can answer this too now - it binds a meter and all seven arms -
 * so this is the narrower instrument rather than the only one, and the sentence
 * that used to stand here (that `v11-run` had no meter and no bound hosts) is
 * no longer true. What it still answers better than a run does is the question
 * the blocker record actually poses - can this arm's pinned library be driven
 * through the adapter contract, metered, with retries off - against the real
 * service rather than a fake, without a plan, a ledger, a lock or an artifact.
 *
 * The probe runs its own loopback proxy and counts what crosses it, so the
 * count in the envelope is checked against one the adapter did not produce.
 */
async function v11ArmProbeCommand(options) {
  const armId = options.arm;
  if (typeof armId !== 'string' || !Object.hasOwn(ARM_PROBES, armId)) {
    throw new Error(
      `v11-arm-probe requires --arm <${Object.keys(ARM_PROBES).join('|')}>`
    );
  }
  const probe = ARM_PROBES[armId];
  const runtimeRoot = optionPath(options.runtime);
  const workRoot = optionPath(options.work);
  if (runtimeRoot === null || workRoot === null) {
    throw new Error('v11-arm-probe requires --runtime <runtime-site> and --work <writable-root>');
  }
  const modelEndpoint = options['model-endpoint'];
  if (probe.requiresModelEndpoint && (typeof modelEndpoint !== 'string' || modelEndpoint.length === 0)) {
    throw new Error(`v11-arm-probe --arm ${armId} requires --model-endpoint <openai-compatible base url>`);
  }
  if (typeof process.getuid !== 'function' || typeof process.getgid !== 'function') {
    throw new Error('v11-arm-probe requires a POSIX host so the demonstration state is owned by the invoking user');
  }

  const benchmarkRoot = join(root, 'benchmark');
  const [competitorLock, modelWeights] = await Promise.all([
    readFile(competitorLockPath, 'utf8').then(JSON.parse),
    readFile(join(benchmarkRoot, 'model-weights.lock.json'), 'utf8').then(JSON.parse)
  ]);
  // The lock is the authority on which models an arm may use, here as
  // everywhere else: a probe that named its own would be demonstrating
  // something other than the benchmark.
  const pinned = providerModelsFromLock(modelWeights);

  const outputPath = optionPath(
    options.out,
    join(benchmarkRoot, PROBE_RECORDS, `${armId}-execution-evidence.json`)
  );
  const probeDirectory = join(benchmarkRoot, 'probes');
  const adapterDirectory = join(benchmarkRoot, 'adapters');
  const containerProbes = '/opt/shadowgraph/probes';
  const containerWork = '/run/shadowgraph/demonstration';

  for (const directory of probe.directories) {
    await mkdir(join(workRoot, ...directory.split('/')), { recursive: true });
  }
  const demonstrationPath = join(workRoot, 'execution-evidence.json');
  await rm(demonstrationPath, { force: true });

  const environment = {
    PYTHONPATH: `${CONTAINER_PATHS.runtime}:${CONTAINER_PATHS.adapters}`,
    PYTHONDONTWRITEBYTECODE: '1',
    HOME: containerWork,
    SHADOWGRAPH_LLM_MODEL: pinned.internal_memory_llm.modelId,
    SHADOWGRAPH_EMBEDDING_MODEL: pinned.embedding.modelId,
    SHADOWGRAPH_EMBEDDING_DIMENSION: String(pinned.embedding.embeddingDimension),
    SHADOWGRAPH_DEMONSTRATION_OUTPUT: `${containerWork}/execution-evidence.json`,
    ...probe.environment(containerWork)
  };
  if (probe.requiresModelEndpoint) environment.SHADOWGRAPH_MODEL_ENDPOINT = modelEndpoint;

  const args = [
    'run', '--rm', '--init',
    '--network', 'host',
    '--user', `${process.getuid()}:${process.getgid()}`,
    '--mount', `type=bind,source=${runtimeRoot},target=${CONTAINER_PATHS.runtime},readonly`,
    '--mount', `type=bind,source=${probeDirectory},target=${containerProbes},readonly`,
    '--mount', `type=bind,source=${adapterDirectory},target=${CONTAINER_PATHS.adapters},readonly`,
    '--mount', `type=bind,source=${workRoot},target=${containerWork}`,
    '--workdir', containerWork
  ];
  for (const name of Object.keys(environment).sort()) {
    args.push('--env', `${name}=${environment[name]}`);
  }
  args.push(competitorLock.pythonImage, 'python', `${containerProbes}/${probe.script}`);

  let demonstrationFailed = false;
  try {
    await execFileAsync('docker', args, { maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    demonstrationFailed = true;
    if (typeof error?.stderr === 'string' && error.stderr.length > 0) process.stderr.write(error.stderr);
  }

  let evidence;
  try {
    evidence = JSON.parse(await readFile(demonstrationPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `the demonstration wrote no record; the probe did not run to completion: ${error?.message ?? error}`
    );
  }
  // Reconciliation is the point of the ledger, and it is done here rather than
  // in the probe on purpose: a demonstration that judged its own evidence would
  // be exercising its own comparison, and the comparison that matters is the
  // one the run uses.
  //
  // It is the same comparison now. When this was written the run path did not
  // reconcile at all - the meter wrote a ledger on every run and nothing read it
  // back - so this was the only caller and the sentence above was aspirational.
  // `v11RunCommand` reconciles its own attempt's ledger and exits non-zero on a
  // discrepancy; this probe remains the narrower rehearsal.
  let reconciliation = null;
  if (typeof probe.ledger === 'string') {
    const ledgerPath = join(workRoot, probe.ledger);
    let ledgerText;
    try {
      ledgerText = await readFile(ledgerPath, 'utf8');
    } catch (error) {
      throw new Error(
        `the demonstration declared a provider ledger it did not write: ${error?.message ?? error}`
      );
    }
    const { events, malformed } = parseProviderLedger(ledgerText);
    reconciliation = reconcileProviderEvidence({
      events,
      malformed,
      expectations: evidence.expectations ?? [],
      expectedModels: {
        internal_memory_llm: pinned.internal_memory_llm.modelId,
        embedding: pinned.embedding.modelId
      }
    });

    // A reconciliation that agrees is worth exactly as much as the chance it
    // had to disagree. So the same ledger is reconciled again with one event
    // duplicated - which is what a single transparent retry would have looked
    // like - and the run refuses unless that produces RETRY_OBSERVED. Without
    // this, a reconciler that had quietly stopped comparing would report
    // RECONCILED on every run and read as a clean result.
    const control = events.length === 0
      ? null
      : reconcileProviderEvidence({
        events: [...events, { ...events[0], requestNumber: events.length }],
        malformed,
        expectations: evidence.expectations ?? [],
        expectedModels: {
          internal_memory_llm: pinned.internal_memory_llm.modelId,
          embedding: pinned.embedding.modelId
        }
      });
    const controlDetects = control !== null
      && control.findings.some((finding) => finding.code === 'RETRY_OBSERVED');

    evidence = {
      ...evidence,
      reconciliation,
      retryControl: control === null
        ? { detected: false, reason: 'the ledger recorded no traffic to duplicate' }
        : { detected: controlDetects, findings: control.findings }
    };
    if (reconciliation.status !== 'RECONCILED' || !controlDetects) {
      evidence = { ...evidence, outcome: 'FAIL' };
    }
  }

  await writeJson(outputPath, evidence);
  process.stdout.write(`${JSON.stringify({
    schema: 'shadowgraph.v11.arm-execution-probe',
    version: 1,
    armId,
    precondition: evidence.precondition ?? null,
    observedAt: evidence.observedAt ?? null,
    outcome: evidence.outcome ?? 'FAIL',
    outputPath,
    steps: (evidence.steps ?? []).map((entry) => ({ step: entry.step, outcome: entry.outcome })),
    reconciliation: reconciliation === null
      ? null
      : { status: reconciliation.status, totals: reconciliation.totals, findings: reconciliation.findings },
    retryControl: evidence.retryControl ?? null
  }, null, 2)}\n`);
  if (demonstrationFailed || evidence.outcome !== 'PASS') process.exitCode = 1;
  return evidence;
}

/** Ask the local container runtime one question and return its trimmed answer. */
async function dockerField(args) {
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

/**
 * The container-runtime side of the probe.
 *
 * Each of these is one `docker` question with a fixed format string. They are
 * separated from the probe so that the probe's behaviour on an unreachable
 * service is testable without a container runtime.
 */
const IMAGE_IDENTITY_FORMAT = '{{.Id}}\t{{json .RootFS.Layers}}';

async function inspectImageIdentity(reference) {
  const [id, layers] = (await dockerField(['image', 'inspect', reference, '--format', IMAGE_IDENTITY_FORMAT]))
    .split('\t');
  return { id, layers: JSON.parse(layers) };
}

const containerRuntimeProbes = {
  inspectContainer: async (name) => {
    const answer = await dockerField(['container', 'inspect', name, '--format', '{{.Id}} {{.Image}}']);
    const [id, image] = answer.split(' ');
    return { id, image, layers: (await inspectImageIdentity(image)).layers };
  },
  inspectImage: inspectImageIdentity,
  readModelWeightsDigest: async (container, modelId) => ollamaWeightsDigest(
    await dockerField(['exec', container, 'cat', ollamaManifestPath(modelId)])
  )
};

/**
 * Resolve a service's credential from the environment, never from a file.
 *
 * The evidence record carries endpoints and outcomes and no credential, and
 * this is why: the secret is read here, used for one request, and never enters
 * anything that is written down.
 */
function serviceAuthorization(service) {
  const variable = service.authEnvironmentVariable;
  if (typeof variable !== 'string' || variable.length === 0) return null;
  const value = process.env[variable];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`service ${service.name} declares ${variable}, which is not set in the environment`);
  }
  return `Basic ${Buffer.from(value, 'utf8').toString('base64')}`;
}

/**
 * Probe the services an operator has provisioned and write the evidence record.
 *
 * This command decides nothing. It writes what the services answered, including
 * when they answered badly, and `v11-preflight --service-evidence` is where that
 * record is judged. Keeping the two apart is what stops a probe from being able
 * to clear its own blocker.
 */
async function v11ServiceProbeCommand(options) {
  const endpointsPath = optionPath(options.endpoints);
  if (endpointsPath === null) {
    throw new Error('v11-service-probe requires --endpoints <service-endpoints.json>');
  }
  const benchmarkRoot = join(root, 'benchmark');
  const [endpoints, serviceManifest, modelWeights] = await Promise.all([
    readFile(endpointsPath, 'utf8').then(JSON.parse),
    readFile(join(benchmarkRoot, 'service-images.json'), 'utf8').then(JSON.parse),
    readFile(join(benchmarkRoot, 'model-weights.lock.json'), 'utf8').then(JSON.parse)
  ]);

  const evidence = await probeServices({
    endpoints,
    serviceManifest,
    modelWeights,
    ...containerRuntimeProbes,
    readAuthorization: serviceAuthorization,
    now: Date.now()
  });

  const outputPath = optionPath(options.out, join(benchmarkRoot, PROBE_RECORDS, 'service-evidence.json'));
  await writeJson(outputPath, evidence);

  const failedChecks = evidence.services.flatMap((service) => service.checks
    .filter((entry) => entry.outcome !== 'PASS')
    .map((entry) => ({ service: service.name, check: entry.kind, detail: entry.detail })));
  process.stdout.write(`${JSON.stringify({
    schema: 'shadowgraph.v11.service-probe',
    version: 1,
    observedAt: evidence.observedAt,
    outputPath,
    services: evidence.services.map((service) => ({
      name: service.name,
      checks: service.checks.length,
      failed: service.checks.filter((entry) => entry.outcome !== 'PASS').length,
      servedModels: service.servedModels.map((model) => model.modelId)
    })),
    failedChecks
  }, null, 2)}\n`);
  if (failedChecks.length > 0) process.exitCode = 1;
  return evidence;
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === 'preflight') await preflight(options);
else if (command === 'v11-preflight') await v11Preflight(options);
else if (command === 'v11-service-probe') await v11ServiceProbeCommand(options);
else if (command === 'v11-python-runtime') await v11PythonRuntimeCommand(options);
else if (command === 'v11-precondition-probe') await v11PreconditionProbeCommand(options);
else if (command === 'v11-fence-probe') await v11FenceProbeCommand(options);
else if (command === 'v11-arm-probe') await v11ArmProbeCommand(options);
else if (command === 'v11-run') await v11RunCommand(options);
else if (command === 'run') {
  const { raw, preregistration } = await createRun(options);
  const aggregate = aggregateRun(raw, preregistration);
  if (aggregate.allowedMarketingText) process.stdout.write(`${aggregate.allowedMarketingText}\n`);
} else if (command === 'validate') await validateCommand(options);
else if (command === 'aggregate') await aggregateCommand(options);
else throw new Error(`Unknown benchmark command: ${command}`);
