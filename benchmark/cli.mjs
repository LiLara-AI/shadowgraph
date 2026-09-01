#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { cpus, totalmem, type as osType, release as osRelease } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { aggregateRun } from './lib/aggregate.mjs';
import {
  adapterCommandForRecord,
  loadAdapterConfiguration,
  redactConfiguredSecrets,
  runAdapterRequest
} from './lib/adapters.mjs';
import {
  NO_COMMON_MODEL_REASON,
  probeCommonCapabilities,
  readCommonModelConfiguration
} from './lib/capabilities.mjs';
import { verifyPreregistration } from './lib/preregistration.mjs';
import { loadV11AcceptanceDefinition } from './lib/v11-definition.mjs';
import { createV11Registry } from './lib/v11-registry.mjs';
import { validateRawRun } from './lib/validate.mjs';

const execFileAsync = promisify(execFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const preregistrationPath = join(root, 'benchmark', 'preregistration.json');
const preregistrationHashPath = join(root, 'benchmark', 'preregistration.sha256');
const competitorLockPath = join(root, 'benchmark', 'competitors.lock.json');
const HARNESS_VERSION = '1.0.0';
const PHASES = ['A', 'B', 'C', 'D_TRUE', 'D_FALSE_0', 'D_FALSE_1', 'D_FALSE_2', 'E', 'ISOLATION_PROJECT', 'ISOLATION_USER'];

function parseArgs(argv) {
  if (argv.length === 0) {
    throw new Error(
      'Usage: benchmark/cli.mjs <preflight|v11-preflight|run|validate|aggregate> [options]'
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
async function readGateJson(filePath) {
  let text;
  try {
    text = await readFile(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable' };
  }
  try {
    return { state: 'present', value: JSON.parse(text) };
  } catch {
    return { state: 'malformed' };
  }
}

const FULL_SHA256 = /^sha256:[a-f0-9]{64}$/u;

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Describe why a prerequisite is unmet, or null when it is met.
 *
 * These gates confirm that evidence is present and well-formed. They cannot
 * confirm it is authentic: a syntactically valid digest for a model nobody ran
 * would satisfy the shape check. Authenticity is the reviewer's job, and the
 * blocker text says so rather than implying the check proves more than it does.
 */
function unmetReason(gate, isSatisfied) {
  if (gate.state === 'absent') return 'the declaring file does not exist';
  if (gate.state === 'unreadable') return 'the declaring file could not be read';
  if (gate.state === 'malformed') return 'the declaring file is not valid JSON';
  return isSatisfied(gate.value) ? null : 'the declaring file contains no usable entry';
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
  const competitorLock = JSON.parse(await readFile(competitorLockPath, 'utf8'));
  const containerImage = competitorLock.pythonImage;
  const registry = createV11Registry({ competitorLock, containerImage });

  const { definition, scenarios } = await loadV11AcceptanceDefinition({ repositoryRoot: root });
  const declared = Object.fromEntries(
    definition.arms.map((arm) => [arm.id, arm.applicability])
  );
  const satisfied = typeof options.preconditions === 'string' && options.preconditions.length > 0
    ? options.preconditions.split(',').map((entry) => entry.trim()).filter(Boolean)
    : [];

  const applicability = registry.verifyApplicability(declared, satisfied);
  const derivedCounts = registry.expectedCounts({
    scenarios: scenarios.length,
    repetitions: definition.commonExecution.repetitions,
    phases: definition.phases,
    declared
  });

  const declaredCounts = definition.expectedCounts;
  const countMismatches = Object.keys(derivedCounts)
    .filter((key) => derivedCounts[key] !== declaredCounts[key])
    .map((key) => ({ count: key, declared: declaredCounts[key], derived: derivedCounts[key] }));

  const blockers = [];
  for (const finding of applicability.findings) {
    blockers.push({ kind: 'applicability', ...finding });
  }
  for (const mismatch of countMismatches) {
    blockers.push({ kind: 'expected-counts', ...mismatch });
  }
  for (const descriptor of registry.descriptors) {
    if (descriptor.requiredService !== null) {
      blockers.push({
        kind: 'required-service',
        armId: descriptor.armId,
        service: descriptor.requiredService
      });
    }
  }

  // Immutable prerequisites. The implementation lock requires a full
  // sha256:<64 hex> weight digest per model and a committed service manifest.
  // Neither exists, and neither may be synthesised, so readiness has to account
  // for them or it would report READY for a run that cannot lawfully start.
  const prerequisites = [
    {
      requirement: 'model-weight-digests',
      gate: await readGateJson(join(root, 'benchmark', 'model-weights.lock.json')),
      isSatisfied: (value) => Array.isArray(value?.models) && value.models.length > 0
        && value.models.every((model) => (
          isPlainRecord(model)
          && model.digestKind === 'model_weights'
          && typeof model.weightsDigest === 'string'
          && FULL_SHA256.test(model.weightsDigest)
          && typeof model.modelId === 'string'
          && model.modelId.length > 0
        ))
    },
    {
      requirement: 'service-manifest',
      gate: await readGateJson(join(root, 'benchmark', 'service-images.json')),
      isSatisfied: (value) => Array.isArray(value?.serviceImages) && value.serviceImages.length > 0
        && value.serviceImages.every((service) => (
          isPlainRecord(service)
          && typeof service.name === 'string' && service.name.length > 0
          && typeof service.image === 'string' && service.image.length > 0
        ))
    },
    {
      requirement: 'reproducible-runtime-bytes',
      gate: await readGateJson(join(root, 'benchmark', 'python-wheels.lock.json')),
      isSatisfied: (value) => Array.isArray(value?.wheels) && value.wheels.length > 0
        && value.wheels.every((wheel) => (
          isPlainRecord(wheel)
          && typeof wheel.name === 'string' && wheel.name.length > 0
          && typeof wheel.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(wheel.sha256)
        ))
    }
  ];

  for (const { requirement, gate, isSatisfied } of prerequisites) {
    const reason = unmetReason(gate, isSatisfied);
    if (reason !== null) {
      blockers.push({
        kind: 'immutable-prerequisite',
        requirement,
        detail: reason,
        note: 'presence and shape only; this check cannot establish authenticity'
      });
    }
  }

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
      nativeUserNamespace: descriptor.isolation.userNamespace
    })),
    applicability,
    declaredCounts,
    derivedCounts,
    readiness: blockers.length === 0 ? 'READY' : 'NOT READY',
    blockers
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (blockers.length > 0) process.exitCode = 1;
  return report;
}

const { command, options } = parseArgs(process.argv.slice(2));
if (command === 'preflight') await preflight(options);
else if (command === 'v11-preflight') await v11Preflight(options);
else if (command === 'run') {
  const { raw, preregistration } = await createRun(options);
  const aggregate = aggregateRun(raw, preregistration);
  if (aggregate.allowedMarketingText) process.stdout.write(`${aggregate.allowedMarketingText}\n`);
} else if (command === 'validate') await validateCommand(options);
else if (command === 'aggregate') await aggregateCommand(options);
else throw new Error(`Unknown benchmark command: ${command}`);
