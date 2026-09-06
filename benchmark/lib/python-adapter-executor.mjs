import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile
} from 'node:fs/promises';
import { isIP } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import { fileURLToPath } from 'node:url';

import { validateAdapterRequest, validateAdapterResponse } from './adapter-protocol.mjs';
import {
  CONTAINER_PATHS,
  buildContainerInvocation,
  buildContainerKillInvocation
} from './python-container-runtime.mjs';
import { canonicalJson } from './v11-contract.mjs';
import { PROVIDER_MODEL_CLASSES, isPinnedModelId } from './v11-provider-models.mjs';

const DEFAULT_HOST_PATH = fileURLToPath(new URL('../adapters/python_host.py', import.meta.url));
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_REQUEST_BYTES = 1024 * 1024;
const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_BOUNDARY_BYTES = 16 * 1024 * 1024;
const OWNERSHIP_MARKER = '.shadowgraph-benchmark-state-v1';
const OWNERSHIP_CONTENT = 'shadowgraph benchmark state root v1\n';
const ENVIRONMENT_ALLOWLIST = Object.freeze([
  'COMSPEC',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'PATH',
  'PATHEXT',
  'SystemRoot',
  'TZ',
  'WINDIR'
]);

export const PYTHON_ADAPTER_SPECS = Object.freeze({
  'mem0-oss': Object.freeze({
    armId: 'mem0-oss',
    packages: Object.freeze({ mem0ai: '2.0.19' }),
    requestClasses: Object.freeze(['internal_memory_llm', 'embedding'])
  }),
  graphiti: Object.freeze({
    armId: 'graphiti',
    packages: Object.freeze({ 'graphiti-core': '0.29.3', httpx: '0.28.1' }),
    requestClasses: Object.freeze(['internal_memory_llm', 'embedding'])
  }),
  'basic-memory': Object.freeze({
    armId: 'basic-memory',
    packages: Object.freeze({ 'basic-memory': '0.23.2' }),
    requestClasses: Object.freeze([])
  }),
  cognee: Object.freeze({
    armId: 'cognee',
    packages: Object.freeze({ cognee: '1.5.3' }),
    requestClasses: Object.freeze(['internal_memory_llm', 'embedding'])
  })
});

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The pinned model for each class the arm meters, in the same shape as the
// route record: present and null for a class this arm does not use. Validated
// here rather than trusted from the caller, because the wrapper this produces
// is the only thing standing between a library's default model and a
// measurement that silently describes different weights than the lock pins.
function normalizeProviderModels(value, requestClasses) {
  if (requestClasses.length === 0) {
    if (value !== undefined && value !== null) {
      const declared = isPlainRecord(value)
        && PROVIDER_MODEL_CLASSES.every((requestClass) => value[requestClass] === null);
      if (!declared) {
        throw new PythonAdapterExecutorError(
          'CONTRACT_FAILURE',
          'This Python adapter does not accept pinned provider models'
        );
      }
    }
    return Object.fromEntries(PROVIDER_MODEL_CLASSES.map((requestClass) => [requestClass, null]));
  }
  if (!isPlainRecord(value)) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Python adapter pinned provider models are required'
    );
  }
  const normalized = {};
  for (const requestClass of PROVIDER_MODEL_CLASSES) {
    const model = value[requestClass];
    if (!requestClasses.includes(requestClass)) {
      if (model !== null && model !== undefined) {
        throw new PythonAdapterExecutorError(
          'CONTRACT_FAILURE',
          'Python adapter received a model for a class it does not meter'
        );
      }
      normalized[requestClass] = null;
      continue;
    }
    if (!isPlainRecord(model) || !isPinnedModelId(model.modelId)) {
      throw new PythonAdapterExecutorError(
        'CONTRACT_FAILURE',
        'Python adapter pinned provider model is invalid'
      );
    }
    const dimension = model.embeddingDimension ?? null;
    // Only the embedding class carries a width, and it must carry one: a
    // client told the model but not its dimension sizes its own storage from
    // a default, which is how a 768-wide vector meets a 1536-wide collection.
    if (requestClass === 'embedding') {
      if (!Number.isSafeInteger(dimension) || dimension <= 0) {
        throw new PythonAdapterExecutorError(
          'CONTRACT_FAILURE',
          'Python adapter pinned embedding model must record its dimension'
        );
      }
    } else if (dimension !== null) {
      throw new PythonAdapterExecutorError(
        'CONTRACT_FAILURE',
        'Only the pinned embedding model may record a dimension'
      );
    }
    normalized[requestClass] = { modelId: model.modelId, embeddingDimension: dimension };
  }
  return normalized;
}

function boundedInteger(value, fallback, { minimum, maximum, label }) {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > maximum) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', `${label} is outside the allowed bound`);
  }
  return resolved;
}

function unbracket(hostname) {
  return hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
}

function isLiteralLoopback(hostname) {
  const value = unbracket(hostname).toLowerCase();
  if (value === '::1') return true;
  if (isIP(value) !== 4) return false;
  return value.split('.')[0] === '127';
}

function validateProviderEndpoint(value) {
  if (!isNonEmptyString(value)) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'A fresh metered provider endpoint is required');
  }
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'The metered provider endpoint is invalid');
  }
  if (endpoint.protocol !== 'http:'
    || !isLiteralLoopback(endpoint.hostname)
    || endpoint.username
    || endpoint.password
    || endpoint.search
    || endpoint.hash
    || ['', '/'].includes(endpoint.pathname)) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'The metered provider endpoint is invalid');
  }
  return endpoint.toString().replace(/\/$/u, '');
}

function providerCorrelation(request, requestClass) {
  return {
    runId: request.runId,
    attemptId: request.attemptId,
    armId: request.armId,
    scenarioId: request.scenarioId,
    repetition: request.repetition,
    phase: request.phase,
    requestClass
  };
}

function remainingMs(deadlineAt) {
  return Math.max(0, deadlineAt - performance.now());
}

function waitBounded(operation, deadlineAt, signal, rejectionError = new PythonAdapterExecutorError(
  'INFRASTRUCTURE_FAILURE',
  'Python adapter infrastructure failed'
)) {
  if (signal?.aborted) {
    return Promise.reject(new PythonAdapterExecutorError(
      'OPERATOR_INTERRUPTION',
      'Python adapter operation was interrupted'
    ));
  }
  const remaining = remainingMs(deadlineAt);
  if (remaining < 1) {
    return Promise.reject(new PythonAdapterExecutorError(
      'TIMEOUT',
      'Python adapter lifecycle timed out'
    ));
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, new PythonAdapterExecutorError(
      'OPERATOR_INTERRUPTION',
      'Python adapter operation was interrupted'
    ));
    const timer = setTimeout(() => finish(reject, new PythonAdapterExecutorError(
      'TIMEOUT',
      'Python adapter lifecycle timed out'
    )), remaining);
    signal?.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => finish(resolve, value),
      (error) => finish(reject, rejectionError === null ? error : rejectionError)
    );
  });
}

function childEnvironment(stateLeaf, invocationRoot) {
  const environment = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  const homeRoot = path.join(stateLeaf, 'home');
  const configRoot = path.join(stateLeaf, 'config');
  const cacheRoot = path.join(stateLeaf, 'cache');
  const dataRoot = path.join(stateLeaf, 'data');
  const tempRoot = path.join(invocationRoot, 'tmp');
  Object.assign(environment, {
    HOME: homeRoot,
    USERPROFILE: homeRoot,
    XDG_CONFIG_HOME: configRoot,
    XDG_CACHE_HOME: cacheRoot,
    XDG_DATA_HOME: dataRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT: stateLeaf,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONHASHSEED: '0',
    PYTHONPATH: '',
    PYTHONSTARTUP: '',
    PIP_CONFIG_FILE: process.platform === 'win32' ? 'NUL' : '/dev/null',
    MEM0_TELEMETRY: 'false',
    GRAPHITI_TELEMETRY_ENABLED: 'false',
    TELEMETRY_DISABLED: '1',
    BASIC_MEMORY_FORCE_LOCAL: 'true',
    BASIC_MEMORY_MODE: 'local',
    BASIC_MEMORY_CONFIG_DIR: path.join(configRoot, 'basic-memory'),
    COGNEE_TRACING_ENABLED: 'false',
    COGNEE_SYSTEM_ROOT_DIRECTORY: path.join(dataRoot, 'cognee-system'),
    COGNEE_DATA_ROOT_DIRECTORY: path.join(dataRoot, 'cognee-data'),
    OTEL_SDK_DISABLED: 'true'
  });
  return environment;
}

/**
 * The environment the adapter sees inside the pinned container.
 *
 * The same variables `childEnvironment` sets, resolved to the in-container
 * layout, plus the one the host path deliberately blanks: `PYTHONPATH` names
 * the read-only mount holding the wheel set the lock pins, because the pinned
 * image is a bare interpreter and every arm would otherwise fail at import.
 *
 * Nothing is inherited from the host here. `childEnvironment` forwards an
 * allowlist because a host interpreter needs the host's PATH; a container has
 * the image's own, and forwarding the host's would make the run depend on the
 * machine it was started from.
 */
function containerAdapterEnvironment(stateLeafName) {
  const stateLeaf = path.posix.join(CONTAINER_PATHS.state, stateLeafName);
  const homeRoot = path.posix.join(stateLeaf, 'home');
  const configRoot = path.posix.join(stateLeaf, 'config');
  const cacheRoot = path.posix.join(stateLeaf, 'cache');
  const dataRoot = path.posix.join(stateLeaf, 'data');
  const tempRoot = CONTAINER_PATHS.scratch;
  return {
    HOME: homeRoot,
    XDG_CONFIG_HOME: configRoot,
    XDG_CACHE_HOME: cacheRoot,
    XDG_DATA_HOME: dataRoot,
    TEMP: tempRoot,
    TMP: tempRoot,
    TMPDIR: tempRoot,
    SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT: stateLeaf,
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONHASHSEED: '0',
    PYTHONPATH: CONTAINER_PATHS.runtime,
    PYTHONSTARTUP: '',
    PIP_CONFIG_FILE: '/dev/null',
    MEM0_TELEMETRY: 'false',
    GRAPHITI_TELEMETRY_ENABLED: 'false',
    TELEMETRY_DISABLED: '1',
    BASIC_MEMORY_FORCE_LOCAL: 'true',
    BASIC_MEMORY_MODE: 'local',
    BASIC_MEMORY_CONFIG_DIR: path.posix.join(configRoot, 'basic-memory'),
    COGNEE_TRACING_ENABLED: 'false',
    COGNEE_SYSTEM_ROOT_DIRECTORY: path.posix.join(dataRoot, 'cognee-system'),
    COGNEE_DATA_ROOT_DIRECTORY: path.posix.join(dataRoot, 'cognee-data'),
    OTEL_SDK_DISABLED: 'true'
  };
}

/**
 * The environment the container *client* runs with.
 *
 * Not the adapter's environment - that travels as explicit `--env` arguments.
 * This is only what the local `docker` binary needs to find its daemon.
 */
function containerClientEnvironment() {
  const environment = {};
  for (const name of [...ENVIRONMENT_ALLOWLIST, 'DOCKER_HOST', 'DOCKER_CONTEXT', 'DOCKER_CONFIG', 'HOME']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return environment;
}

/**
 * Assemble the one invocation that runs an adapter inside the pinned image.
 *
 * The container gets a fresh name per invocation rather than one derived from
 * the unit: a reset and a persist for the same unit share a state leaf, so a
 * name derived from that leaf would collide with a container that had not
 * finished being removed, and Docker would refuse the second one for a reason
 * that has nothing to do with the measurement.
 */
function containerLaunch({ container, hostPath, invocationRoot, stateRoot, stateLeafName }) {
  const containerName = `shadowgraph-v11-${randomUUID().replaceAll('-', '')}`;
  const environment = containerAdapterEnvironment(stateLeafName);
  let invocation;
  try {
    invocation = buildContainerInvocation({
      image: container.image,
      containerName,
      hostPath,
      adaptersDirectory: path.dirname(hostPath),
      runtimeRoot: container.runtimeRoot ?? null,
      invocationRoot,
      stateRoot,
      uid: process.getuid(),
      gid: process.getgid(),
      networkMode: container.networkMode ?? 'host',
      environment,
      dockerExecutable: container.dockerExecutable ?? 'docker'
    });
  } catch (error) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      `Python adapter container invocation is invalid: ${error?.message ?? 'unknown reason'}`
    );
  }
  return {
    command: invocation.command,
    commandArgs: [...invocation.args],
    childEnv: containerClientEnvironment(),
    containerName,
    dockerExecutable: container.dockerExecutable ?? 'docker',
    // The adapter sees container paths, so those are the strings that could
    // appear in its output and must be redacted alongside the host ones.
    fragments: [
      environment.SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT,
      CONTAINER_PATHS.state,
      CONTAINER_PATHS.runtime,
      containerName
    ]
  };
}

function protectedVariants(value) {
  if (!isNonEmptyString(value)) return [];
  const buffer = Buffer.from(value, 'utf8');
  return [...new Set([
    value,
    encodeURIComponent(value),
    buffer.toString('base64'),
    buffer.toString('base64url')
  ])];
}

async function prepareInvocationRoot(deadlineAt, signal) {
  const root = await waitBounded(
    mkdtemp(path.join(os.tmpdir(), 'shadowgraph-python-adapter-')),
    deadlineAt,
    signal
  );
  try {
    await waitBounded(Promise.all([
      mkdir(path.join(root, 'cwd')),
      mkdir(path.join(root, 'tmp'))
    ]), deadlineAt, signal);
    return root;
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function stateLeafDigest(adapterId, request) {
  return createHash('sha256')
    .update('shadowgraph:python-adapter-state-leaf:v1\0', 'utf8')
    .update(canonicalJson({
      adapterId,
      runId: request.runId,
      armId: request.armId,
      scenarioId: request.scenarioId,
      repetition: request.repetition
    }), 'utf8')
    .digest('hex');
}

async function validateOwnedMarker(root, deadlineAt, signal) {
  const marker = path.join(root, OWNERSHIP_MARKER);
  const metadata = await waitBounded(lstat(marker), deadlineAt, signal);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Benchmark state root ownership marker is invalid'
    );
  }
  const [resolved, content] = await waitBounded(Promise.all([
    realpath(marker),
    readFile(marker, 'utf8')
  ]), deadlineAt, signal);
  if (resolved !== marker || path.dirname(resolved) !== root || content !== OWNERSHIP_CONTENT) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Benchmark state root ownership marker is invalid'
    );
  }
}

async function lstatOrMissing(directory, deadlineAt, signal) {
  try {
    return await waitBounded(lstat(directory), deadlineAt, signal, null);
  } catch (error) {
    if (error instanceof PythonAdapterExecutorError) throw error;
    if (error?.code === 'ENOENT') return null;
    throw new PythonAdapterExecutorError(
      'INFRASTRUCTURE_FAILURE',
      'Benchmark state directory could not be inspected'
    );
  }
}

async function validateRealDirectory(directory, deadlineAt, signal) {
  const metadata = await lstatOrMissing(directory, deadlineAt, signal);
  if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Benchmark state path must contain only real directories'
    );
  }
  const resolved = await waitBounded(realpath(directory), deadlineAt, signal);
  if (resolved !== directory) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Benchmark state path must not traverse symbolic links'
    );
  }
}

async function ensureDirectoryChainNoFollow(directory, deadlineAt, signal) {
  const filesystemRoot = path.parse(directory).root;
  await validateRealDirectory(filesystemRoot, deadlineAt, signal);
  let current = filesystemRoot;
  const relative = path.relative(filesystemRoot, directory);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    await validateRealDirectory(current, deadlineAt, signal);
    const next = path.join(current, segment);
    let metadata = await lstatOrMissing(next, deadlineAt, signal);
    if (metadata === null) {
      // Node has no portable openat/O_NOFOLLOW mkdir primitive. Checking each
      // parent immediately before and after the direct mkdir closes the static
      // ancestor-symlink case; a privileged concurrent path swap remains a
      // narrow platform TOCTOU boundary and is rechecked before returning.
      await validateRealDirectory(current, deadlineAt, signal);
      try {
        await waitBounded(mkdir(next), deadlineAt, signal, null);
      } catch (error) {
        if (error instanceof PythonAdapterExecutorError) throw error;
        if (error?.code !== 'EEXIST') {
          throw new PythonAdapterExecutorError(
            'INFRASTRUCTURE_FAILURE',
            'Benchmark state directory could not be prepared'
          );
        }
      }
      metadata = await lstatOrMissing(next, deadlineAt, signal);
    }
    if (metadata === null || !metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new PythonAdapterExecutorError(
        'CONTRACT_FAILURE',
        'Benchmark state path must contain only real directories'
      );
    }
    await validateRealDirectory(next, deadlineAt, signal);
    await validateRealDirectory(current, deadlineAt, signal);
    current = next;
  }
  return current;
}

async function ensureOwnedStateRoot(configuredRoot, deadlineAt, signal) {
  const resolvedRoot = await ensureDirectoryChainNoFollow(
    configuredRoot,
    deadlineAt,
    signal
  );
  const marker = path.join(resolvedRoot, OWNERSHIP_MARKER);
  let markerExists = true;
  try {
    await waitBounded(lstat(marker), deadlineAt, signal, null);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new PythonAdapterExecutorError(
        'INFRASTRUCTURE_FAILURE',
        'Benchmark state ownership could not be validated'
      );
    }
    markerExists = false;
  }
  if (!markerExists) {
    const entries = await waitBounded(readdir(resolvedRoot), deadlineAt, signal);
    if (entries.length !== 0) {
      throw new PythonAdapterExecutorError(
        'CONTRACT_FAILURE',
        'Refusing to adopt a non-empty benchmark state root'
      );
    }
    try {
      await waitBounded(
        writeFile(marker, OWNERSHIP_CONTENT, { encoding: 'utf8', flag: 'wx', mode: 0o600 }),
        deadlineAt,
        signal,
        null
      );
    } catch (writeError) {
      if (writeError?.code !== 'EEXIST') {
        throw new PythonAdapterExecutorError(
          'INFRASTRUCTURE_FAILURE',
          'Benchmark state ownership could not be established'
        );
      }
    }
  }
  await validateOwnedMarker(resolvedRoot, deadlineAt, signal);
  await validateRealDirectory(resolvedRoot, deadlineAt, signal);
  return resolvedRoot;
}

async function ensureDirectDirectory(parent, name, deadlineAt, signal) {
  await validateRealDirectory(parent, deadlineAt, signal);
  const directory = path.resolve(parent, name);
  if (path.dirname(directory) !== parent || path.basename(directory) !== name) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Benchmark state directory escaped its owned parent'
    );
  }
  try {
    await waitBounded(mkdir(directory), deadlineAt, signal, null);
  } catch (error) {
    if (error?.code !== 'EEXIST') {
      throw new PythonAdapterExecutorError(
        'INFRASTRUCTURE_FAILURE',
        'Benchmark state directory could not be prepared'
      );
    }
  }
  const metadata = await waitBounded(lstat(directory), deadlineAt, signal);
  const resolved = await waitBounded(realpath(directory), deadlineAt, signal);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()
    || resolved !== directory || path.dirname(resolved) !== parent) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Benchmark state directory is unsafe'
    );
  }
  await validateRealDirectory(parent, deadlineAt, signal);
  return directory;
}

async function preparePersistentState(stateRoot, adapterId, request, deadlineAt, signal) {
  const root = await ensureOwnedStateRoot(stateRoot, deadlineAt, signal);
  const digest = stateLeafDigest(adapterId, request);
  const leaf = await ensureDirectDirectory(root, digest, deadlineAt, signal);
  const home = await ensureDirectDirectory(leaf, 'home', deadlineAt, signal);
  const config = await ensureDirectDirectory(leaf, 'config', deadlineAt, signal);
  const cache = await ensureDirectDirectory(leaf, 'cache', deadlineAt, signal);
  const data = await ensureDirectDirectory(leaf, 'data', deadlineAt, signal);
  await Promise.all([
    ensureDirectDirectory(config, 'basic-memory', deadlineAt, signal),
    ensureDirectDirectory(data, 'cognee-system', deadlineAt, signal),
    ensureDirectDirectory(data, 'cognee-data', deadlineAt, signal)
  ]);
  if (![home, config, cache, data].every((entry) => path.dirname(entry) === leaf)) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Benchmark state layout is invalid');
  }
  return leaf;
}

async function validateHostPath(hostPath, deadlineAt, signal) {
  if (!path.isAbsolute(hostPath)) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter host path must be absolute');
  }
  let metadata;
  try {
    metadata = await waitBounded(lstat(hostPath), deadlineAt, signal);
  } catch (error) {
    if (error instanceof PythonAdapterExecutorError) throw error;
    throw new PythonAdapterExecutorError('INFRASTRUCTURE_FAILURE', 'Python adapter host is unavailable');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter host must be a regular file');
  }
}

function parseStrictResponse(stdout, request, protectedFragments) {
  if (stdout.length < 2 || stdout[stdout.length - 1] !== 0x0a) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter output violated the protocol');
  }
  let newlineCount = 0;
  for (const byte of stdout) {
    if (byte === 0x0a) newlineCount += 1;
    if (byte === 0x0d) {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter output violated the protocol');
    }
  }
  if (newlineCount !== 1) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter output violated the protocol');
  }
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(stdout.subarray(0, -1));
  } catch {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter output violated the protocol');
  }
  if (protectedFragments.some((fragment) => fragment && text.includes(fragment))) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter output exposed protected runtime data');
  }
  let response;
  try {
    response = JSON.parse(text);
  } catch {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter output violated the protocol');
  }
  try {
    validateAdapterResponse({ request, response });
  } catch {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter response violated the contract');
  }
  return response;
}

function runChild({
  spawnProcess,
  processGroupIsolation,
  command,
  commandArgs,
  childEnv,
  containerName,
  dockerExecutable,
  invocationRoot,
  input,
  request,
  maxOutputBytes,
  deadlineAt,
  signal,
  protectedFragments
}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(command, commandArgs, {
        cwd: path.join(invocationRoot, 'cwd'),
        env: childEnv,
        detached: processGroupIsolation,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch {
      reject(new PythonAdapterExecutorError(
        'INFRASTRUCTURE_FAILURE',
        'Python adapter process could not start'
      ));
      return;
    }

    const stdoutChunks = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let failure = null;
    let closed = false;
    let settled = false;
    let killTimer = null;
    const remaining = remainingMs(deadlineAt);
    const cleanupReserve = Math.min(250, Math.max(25, remaining / 5));
    const processBudget = Math.max(1, remaining - cleanupReserve);
    const terminationGrace = Math.min(50, Math.max(10, processBudget / 5));

    const cleanup = () => {
      clearTimeout(timeoutTimer);
      clearTimeout(killTimer);
      clearTimeout(hardSettleTimer);
      signal?.removeEventListener('abort', abortListener);
    };

    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };

    const signalProcessTree = (processSignal) => {
      let groupSignaled = false;
      if (processGroupIsolation && Number.isSafeInteger(child.pid) && child.pid > 0) {
        try {
          process.kill(-child.pid, processSignal);
          groupSignaled = true;
        } catch {
          // A direct signal below is the bounded fallback for a spawn race.
        }
      }
      if (!groupSignaled) {
        try {
          child.kill(processSignal);
        } catch {
          // The hard-settlement timer remains authoritative.
        }
      }
    };

    // Signalling the foreground `docker run` client does not reach the
    // container if that client is SIGKILLed, so cleanup addresses the container
    // by name as well. Fire-and-forget: the invocation's own settlement path
    // stays authoritative, and a removal that fails must not turn a completed
    // measurement into a failed one.
    let containerRemoved = false;
    const removeContainer = () => {
      if (containerName === null || containerRemoved) return;
      containerRemoved = true;
      try {
        const kill = buildContainerKillInvocation(containerName, dockerExecutable);
        const remover = spawnProcess(kill.command, [...kill.args], {
          stdio: 'ignore',
          shell: false,
          windowsHide: true
        });
        remover?.unref?.();
        remover?.on?.('error', () => {});
      } catch {
        // The hard-settlement timer remains authoritative.
      }
    };

    const beginTermination = (error) => {
      if (failure === null) failure = error;
      if (closed || settled) return;
      signalProcessTree('SIGTERM');
      removeContainer();
      if (closed || settled) return;
      if (killTimer === null) {
        killTimer = setTimeout(() => {
          if (closed || settled) return;
          signalProcessTree('SIGKILL');
        }, Math.min(25, terminationGrace / 2));
        killTimer.unref?.();
      }
    };

    const abortListener = () => beginTermination(new PythonAdapterExecutorError(
      'OPERATOR_INTERRUPTION',
      'Python adapter operation was interrupted'
    ));
    signal?.addEventListener('abort', abortListener, { once: true });

    const timeoutTimer = setTimeout(() => beginTermination(new PythonAdapterExecutorError(
      'TIMEOUT',
      'Python adapter lifecycle timed out'
    )), Math.max(1, processBudget - terminationGrace));
    timeoutTimer.unref?.();

    const hardSettleTimer = setTimeout(() => {
      if (closed || settled) return;
      if (failure === null) {
        failure = new PythonAdapterExecutorError(
          'TIMEOUT',
          'Python adapter lifecycle timed out'
        );
      }
      signalProcessTree('SIGKILL');
      removeContainer();
      child.stdin.destroy?.();
      child.stdout.destroy?.();
      child.stderr.destroy?.();
      finish(reject, failure);
    }, processBudget);

    child.stdout.on('data', (chunk) => {
      const buffer = Buffer.from(chunk);
      stdoutBytes += buffer.length;
      if (stdoutBytes > maxOutputBytes) {
        beginTermination(new PythonAdapterExecutorError(
          'CONTRACT_FAILURE',
          'Python adapter output exceeded its bound'
        ));
        return;
      }
      stdoutChunks.push(buffer);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += Buffer.byteLength(chunk);
      if (stderrBytes > maxOutputBytes) {
        beginTermination(new PythonAdapterExecutorError(
          'INFRASTRUCTURE_FAILURE',
          'Python adapter process failed'
        ));
      }
    });
    child.stdin.on('error', () => beginTermination(new PythonAdapterExecutorError(
      'INFRASTRUCTURE_FAILURE',
      'Python adapter process failed'
    )));
    child.on('error', () => beginTermination(new PythonAdapterExecutorError(
      'INFRASTRUCTURE_FAILURE',
      'Python adapter process failed'
    )));
    child.on('close', (code, exitSignal) => {
      closed = true;
      if (settled) return;
      // The client can die without this harness having asked it to: an operator
      // kill, the OOM killer, a session teardown, a broken attach to a remote
      // daemon. `beginTermination` never ran, so nothing has addressed the
      // container, and `--rm` cannot help because the container did not exit -
      // least of all when the adapter is hung, which is exactly when it matters.
      // Removal by name is the only thing that reaches it.
      if (exitSignal !== null) removeContainer();
      if (failure !== null) {
        finish(reject, failure);
        return;
      }
      if (code !== 0 || exitSignal !== null || stderrBytes > 0) {
        finish(reject, new PythonAdapterExecutorError(
          'INFRASTRUCTURE_FAILURE',
          'Python adapter process failed'
        ));
        return;
      }
      try {
        finish(
          resolve,
          parseStrictResponse(Buffer.concat(stdoutChunks, stdoutBytes), request, protectedFragments)
        );
      } catch (error) {
        finish(reject, error);
      }
    });
    if (signal?.aborted) abortListener();
    if (failure === null) {
      try {
        child.stdin.end(input);
      } catch {
        beginTermination(new PythonAdapterExecutorError(
          'INFRASTRUCTURE_FAILURE',
          'Python adapter process failed'
        ));
      }
    }
  });
}

export class PythonAdapterExecutorError extends Error {
  constructor(cause, message) {
    super(message);
    this.name = 'PythonAdapterExecutorError';
    this.adapterCause = cause;
  }
}

export function createPythonAdapterExecutor(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter executor options are invalid');
  }
  const spec = PYTHON_ADAPTER_SPECS[options.adapterId];
  if (!spec || options.armId !== spec.armId) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter id and arm binding are invalid');
  }
  const pythonExecutable = options.pythonExecutable ?? 'python3';
  if (!isNonEmptyString(pythonExecutable) || /[\r\n\0]/u.test(pythonExecutable)) {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python executable is invalid');
  }
  const hostPath = path.resolve(options.hostPath ?? DEFAULT_HOST_PATH);
  if (!isNonEmptyString(options.stateRoot)
    || /[\r\n\0]/u.test(options.stateRoot)
    || !path.isAbsolute(options.stateRoot)) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'A mandatory absolute benchmark state root is required'
    );
  }
  const stateRoot = path.resolve(options.stateRoot);
  if (stateRoot === path.parse(stateRoot).root) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Benchmark state root must not be a filesystem root'
    );
  }
  if (options.spawnProcess !== undefined && typeof options.spawnProcess !== 'function') {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python process launcher is invalid');
  }
  const spawnProcess = options.spawnProcess ?? spawn;
  const processGroupIsolation = process.platform !== 'win32';
  if (!processGroupIsolation) {
    throw new PythonAdapterExecutorError(
      'CONTRACT_FAILURE',
      'Python adapter execution requires process-group isolation'
    );
  }
  // The ceiling is one second under the runner's unit deadline, so that when a
  // unit does stall it is the unit watchdog that reports it rather than this
  // one. The two numbers move together; see UNIT_TIMEOUT_MS in v11-runner.mjs
  // for what sized them.
  const timeoutMs = boundedInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, {
    minimum: 50,
    maximum: 599_000,
    label: 'Python adapter timeout'
  });
  const maxRequestBytes = boundedInteger(options.maxRequestBytes, DEFAULT_MAX_REQUEST_BYTES, {
    minimum: 128,
    maximum: MAX_BOUNDARY_BYTES,
    label: 'Python adapter request limit'
  });
  const maxOutputBytes = boundedInteger(options.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES, {
    minimum: 128,
    maximum: MAX_BOUNDARY_BYTES,
    label: 'Python adapter output limit'
  });
  if (spec.requestClasses.length > 0 && typeof options.providerEndpointFor !== 'function') {
    throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter provider routing is required');
  }
  const providerModels = normalizeProviderModels(options.providerModels, spec.requestClasses);

  // Container execution is opt-in. Without it the adapter runs on whatever
  // interpreter the host carries, which is right for the unit tests and wrong
  // for a measurement: the competitor lock pins an image precisely so that a
  // recorded number describes software somebody can reconstruct.
  const container = options.container ?? null;
  if (container !== null) {
    if (!isPlainRecord(container)) {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter container options must be an object');
    }
    if (!isNonEmptyString(container.image)) {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter container requires a pinned image');
    }
    if (container.runtimeRoot !== undefined
      && container.runtimeRoot !== null
      && (!isNonEmptyString(container.runtimeRoot) || !path.isAbsolute(container.runtimeRoot))) {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter runtime root must be an absolute path');
    }
    if (container.dockerExecutable !== undefined && !isNonEmptyString(container.dockerExecutable)) {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter container executable is invalid');
    }
  }
  const usedEndpoints = new Set();

  async function routesFor(request, deadlineAt, signal) {
    const routes = { internal_memory_llm: null, embedding: null };
    const allocated = [];
    for (const requestClass of spec.requestClasses) {
      const correlation = providerCorrelation(request, requestClass);
      const endpoint = validateProviderEndpoint(await waitBounded(
        Promise.resolve().then(() => options.providerEndpointFor(requestClass, correlation)),
        deadlineAt,
        signal,
        new PythonAdapterExecutorError(
          'CONTRACT_FAILURE',
          'Provider route allocation failed'
        )
      ));
      if (usedEndpoints.has(endpoint) || allocated.includes(endpoint)) {
        throw new PythonAdapterExecutorError(
          'CONTRACT_FAILURE',
          'Each provider endpoint capability must be fresh'
        );
      }
      routes[requestClass] = endpoint;
      allocated.push(endpoint);
    }
    for (const endpoint of allocated) usedEndpoints.add(endpoint);
    return routes;
  }

  async function execute(request, { signal } = {}) {
    const deadlineAt = performance.now() + timeoutMs;
    try {
      validateAdapterRequest(request);
    } catch {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter request violated the contract');
    }
    if (request.armId !== spec.armId) {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter request arm does not match');
    }
    if (signal?.aborted) {
      throw new PythonAdapterExecutorError(
        'OPERATOR_INTERRUPTION',
        'Python adapter operation was interrupted'
      );
    }
    const routes = await routesFor(request, deadlineAt, signal);
    const wrapper = {
      schemaVersion: 2,
      adapterId: options.adapterId,
      request,
      providerRoutes: routes,
      providerModels
    };
    let input;
    try {
      input = Buffer.from(`${JSON.stringify(wrapper)}\n`, 'utf8');
    } catch {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter request could not be serialized');
    }
    if (input.length > maxRequestBytes) {
      throw new PythonAdapterExecutorError('CONTRACT_FAILURE', 'Python adapter request exceeded its bound');
    }
    await validateHostPath(hostPath, deadlineAt, signal);
    let invocationRoot = null;
    let result;
    let primaryError = null;
    try {
      const stateLeaf = await preparePersistentState(
        stateRoot,
        options.adapterId,
        request,
        deadlineAt,
        signal
      );
      invocationRoot = await prepareInvocationRoot(deadlineAt, signal);
      const launch = container === null
        ? {
            command: pythonExecutable,
            commandArgs: [hostPath],
            childEnv: childEnvironment(stateLeaf, invocationRoot),
            containerName: null,
            dockerExecutable: 'docker',
            fragments: []
          }
        : containerLaunch({
            container,
            hostPath,
            invocationRoot,
            stateRoot,
            stateLeafName: path.basename(stateLeaf)
          });
      result = await runChild({
        spawnProcess,
        processGroupIsolation,
        command: launch.command,
        commandArgs: launch.commandArgs,
        childEnv: launch.childEnv,
        containerName: launch.containerName,
        dockerExecutable: launch.dockerExecutable,
        invocationRoot,
        input,
        request,
        maxOutputBytes,
        deadlineAt,
        signal,
        protectedFragments: [
          ...Object.values(routes).filter(Boolean),
          stateRoot,
          stateLeaf,
          invocationRoot,
          hostPath,
          ...launch.fragments
        ].flatMap(protectedVariants)
      });
    } catch (error) {
      primaryError = error;
    }
    if (invocationRoot !== null) {
      try {
        await waitBounded(
          rm(invocationRoot, { recursive: true, force: true }),
          deadlineAt,
          undefined
        );
      } catch (cleanupError) {
        if (primaryError === null) primaryError = cleanupError;
      }
    }
    if (primaryError !== null) throw primaryError;
    return result;
  }

  return Object.freeze({ execute });
}
