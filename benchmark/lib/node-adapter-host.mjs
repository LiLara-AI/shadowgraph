import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rm,
  unlink,
  writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validateAdapterResponse } from './adapter-protocol.mjs';
import { canonicalJson, OPERATION_FIELDS } from './v11-contract.mjs';

export const MCP_PROTOCOL_VERSION = '2024-11-05';
export const DEFAULT_OPERATION_TIMEOUT_MS = 30_000;
export const MAX_NDJSON_BYTES = 4 * 1024 * 1024;
export const PROCESS_TERMINATION_GRACE_MS = 1_000;

export const FULL_TOOL_NAMES = Object.freeze([
  'shadowgraph_record_decision',
  'shadowgraph_record_attempt',
  'shadowgraph_review',
  'shadowgraph_search',
  'shadowgraph_context',
  'shadowgraph_remember',
  'shadowgraph_recall',
  'shadowgraph_record_fact',
  'shadowgraph_record_outcome',
  'shadowgraph_confidence_evidence',
  'shadowgraph_update_status',
  'shadowgraph_link',
  'shadowgraph_traverse',
  'shadowgraph_supersede',
  'shadowgraph_redact',
  'shadowgraph_purge',
  'shadowgraph_maintain',
  'shadowgraph_retrieve',
  'shadowgraph_validate',
  'shadowgraph_journal',
  'shadowgraph_rebuild',
  'shadowgraph_review_signals',
  'shadowgraph_purge_preview',
  'shadowgraph_ack_review',
  'shadowgraph_repair_plan',
  'shadowgraph_backup',
  'shadowgraph_restore'
]);

export const COMPACT_TOOL_NAMES = Object.freeze([
  'shadowgraph_record_decision',
  'shadowgraph_record_attempt',
  'shadowgraph_review',
  'shadowgraph_search',
  'shadowgraph_context',
  'shadowgraph_remember',
  'shadowgraph_recall',
  'shadowgraph_record_fact',
  'shadowgraph_record_outcome',
  'shadowgraph_maintain',
  'shadowgraph_retrieve',
  'shadowgraph_validate'
]);

const ENVIRONMENT_ALLOWLIST = Object.freeze([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR'
]);
const ENDPOINT_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOENT',
  'ENOTFOUND',
  'EPIPE'
]);
const OWNERSHIP_MARKER = '.shadowgraph-benchmark-state-v1';
const OWNERSHIP_CONTENT = 'shadowgraph benchmark state root v1\n';
const POISON_DIRECTORY = '.poison';
const FALLBACK_POISON_PREFIX = '.shadowgraph-benchmark-poison-v1-';
const POISON_CONTENT = 'ambiguous persist\n';
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DEFAULT_MCP_ENTRY = path.join(repositoryRoot, 'src', 'mcp.js');
const activeSessions = new Set();
const poisonLatches = new Set();

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function hasNestedErrorCode(error, codes) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if (typeof current.code === 'string' && codes.has(current.code)) return true;
    current = current.cause;
  }
  return false;
}

export class AdapterHostError extends Error {
  constructor(cause, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined);
    this.name = 'AdapterHostError';
    this.adapterCause = cause;
    this.ambiguous = options.ambiguous === true;
  }
}

async function syncDirectoryDurably(directory) {
  const handle = await open(directory, process.platform === 'win32' ? 'r+' : 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

const DEFAULT_DURABILITY_OPERATIONS = Object.freeze({
  openFile: (...args) => open(...args),
  syncDirectory: syncDirectoryDurably
});

function durabilityOperations(candidate) {
  const operations = candidate ?? DEFAULT_DURABILITY_OPERATIONS;
  if (typeof operations !== 'object' || operations === null
    || typeof operations.openFile !== 'function'
    || typeof operations.syncDirectory !== 'function') {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark durability operations are invalid');
  }
  return operations;
}

export function classifyHostError(error, options = {}) {
  if (error instanceof AdapterHostError) return error;
  if (options.signal?.aborted || error?.name === 'AbortError') {
    return new AdapterHostError('OPERATOR_INTERRUPTION', 'Adapter operation was interrupted', {
      cause: error,
      ambiguous: options.ambiguous === true
    });
  }
  if (hasNestedErrorCode(error, ENDPOINT_CODES)) {
    return new AdapterHostError('ENDPOINT_UNAVAILABLE', 'Adapter endpoint is unavailable', {
      cause: error,
      ambiguous: options.ambiguous === true
    });
  }
  return new AdapterHostError('INFRASTRUCTURE_FAILURE', 'Adapter infrastructure failed', {
    cause: error,
    ambiguous: options.ambiguous === true
  });
}

export function emptyOperations(overrides = {}) {
  return Object.fromEntries(OPERATION_FIELDS.map((field) => [field, overrides[field] ?? 0]));
}

export function measuredStorage(bytes, scope = 'ShadowGraph product state leaf') {
  return {
    status: 'MEASURED',
    bytes,
    scope,
    method: 'sum of regular file sizes after the MCP child process closed',
    reason: null,
    blockedClaims: []
  };
}

export function adapterEnvelope(request, options = {}) {
  const envelope = {
    schemaVersion: 1,
    operation: request.operation,
    runId: request.runId,
    attemptId: request.attemptId,
    phase: request.phase,
    armId: request.armId,
    scenarioId: request.scenarioId,
    repetition: request.repetition,
    status: options.status ?? 'SUCCEEDED',
    result: options.result ?? {
      nativeContext: [],
      persistenceEvidence: null,
      isolationEvidence: null
    },
    failure: options.failure ?? null,
    operations: emptyOperations(options.operations),
    storage: options.storage
  };
  validateAdapterResponse({ request, response: envelope });
  return envelope;
}

export function failedEnvelope(request, error, storage, operations = {}) {
  const classified = classifyHostError(error);
  return adapterEnvelope(request, {
    status: 'FAILED',
    result: { nativeContext: [], persistenceEvidence: null, isolationEvidence: null },
    failure: { cause: classified.adapterCause, message: classified.message },
    operations,
    storage
  });
}

export function buildChildEnvironment({ file, storage, compact }) {
  if (!path.isAbsolute(file)) throw new AdapterHostError('CONTRACT_FAILURE', 'MCP state file must be absolute');
  if (!['json', 'sqlite'].includes(storage)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Unsupported ShadowGraph storage backend');
  }
  const environment = {};
  for (const name of ENVIRONMENT_ALLOWLIST) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  environment.SHADOWGRAPH_FILE = file;
  environment.SHADOWGRAPH_STORAGE = storage;
  environment.SHADOWGRAPH_MCP_COMPACT = compact ? '1' : '0';
  return environment;
}

function boundedTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value >= 120_000) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Adapter timeout must be a positive integer below 120000ms');
  }
  return value;
}

function boundedOutputLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_NDJSON_BYTES) {
    throw new AdapterHostError('CONTRACT_FAILURE', `Adapter output limit must be between 1 and ${MAX_NDJSON_BYTES} bytes`);
  }
  return value;
}

function exactObjectKeys(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key))
    && keys.length >= required.length
    && keys.length <= required.length + optional.length;
}

function jsonRpcResponseKind(message) {
  if (!exactObjectKeys(message, ['jsonrpc', 'id'], ['result', 'error']) || message.jsonrpc !== '2.0') {
    return null;
  }
  const hasResult = Object.hasOwn(message, 'result');
  const hasError = Object.hasOwn(message, 'error');
  if (hasResult === hasError) return null;
  if (hasError) {
    if (!exactObjectKeys(message, ['jsonrpc', 'id', 'error'])) return null;
    if (!exactObjectKeys(message.error, ['code', 'message'], ['data'])
      || !Number.isSafeInteger(message.error.code)
      || typeof message.error.message !== 'string') {
      return null;
    }
    return 'error';
  }
  return exactObjectKeys(message, ['jsonrpc', 'id', 'result']) ? 'result' : null;
}

class NdjsonClient {
  constructor(options) {
    this.signal = options.signal;
    this.timeoutMs = boundedTimeout(options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS);
    this.deadline = performance.now() + this.timeoutMs;
    this.cleanupReserveMs = Math.min(100, Math.max(1, this.timeoutMs / 5));
    this.maxBytes = boundedOutputLimit(options.maxBytes ?? MAX_NDJSON_BYTES);
    this.pending = new Map();
    this.sequence = 0;
    this.stdoutBuffer = '';
    this.stdoutBytes = 0;
    this.stderrBytes = 0;
    this.closed = false;
    this.terminating = null;
    this.fatalError = null;
    this.commitRisk = false;
    this.exit = new Promise((resolve) => { this.resolveExit = resolve; });
    const entry = path.resolve(options.entryPath ?? DEFAULT_MCP_ENTRY);
    if (!path.isAbsolute(entry)) throw new AdapterHostError('CONTRACT_FAILURE', 'MCP entry path must be absolute');
    try {
      this.child = spawn(process.execPath, [entry], {
        cwd: repositoryRoot,
        env: options.environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
        windowsHide: true
      });
    } catch (error) {
      throw classifyHostError(error);
    }
    activeSessions.add(this);
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.onStdout(chunk));
    this.child.stderr.on('data', (chunk) => this.onStderr(chunk));
    this.child.on('error', (error) => this.fail(classifyHostError(error, { signal: this.signal })));
    this.child.on('close', (code, signal) => this.onClose(code, signal));
    this.abortListener = () => this.fail(new AdapterHostError(
      'OPERATOR_INTERRUPTION',
      'Adapter operation was interrupted',
      { ambiguous: this.hasAmbiguousPending() }
    ));
    this.signal?.addEventListener('abort', this.abortListener, { once: true });
    if (this.signal?.aborted) this.abortListener();
  }

  hasAmbiguousPending() {
    return [...this.pending.values()].some((pending) => pending.operationCall && !pending.received);
  }

  hasCommitRisk() {
    return this.commitRisk
      || [...this.pending.values()].some((pending) => pending.commitRisk === true && !pending.received);
  }

  remainingMs() {
    return Math.max(0, this.deadline - performance.now());
  }

  workRemainingMs() {
    return Math.max(0, this.remainingMs() - this.cleanupReserveMs);
  }

  recordFatal(error) {
    const classified = classifyHostError(error, {
      signal: this.signal,
      ambiguous: error?.ambiguous === true || this.hasCommitRisk()
    });
    if (this.hasCommitRisk()) classified.ambiguous = true;
    this.fatalError ??= classified;
    return this.fatalError;
  }

  onStderr(chunk) {
    this.stderrBytes += Buffer.byteLength(chunk, 'utf8');
    if (this.stderrBytes > this.maxBytes) {
      this.fail(new AdapterHostError('CONTRACT_FAILURE', 'MCP stderr exceeded the bounded output limit', {
        ambiguous: this.hasAmbiguousPending()
      }));
    }
  }

  onStdout(chunk) {
    this.stdoutBytes += Buffer.byteLength(chunk, 'utf8');
    if (this.stdoutBytes > this.maxBytes) {
      this.fail(new AdapterHostError('CONTRACT_FAILURE', 'MCP stdout exceeded the bounded output limit', {
        ambiguous: this.hasAmbiguousPending()
      }));
      return;
    }
    this.stdoutBuffer += chunk;
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > this.maxBytes) {
      this.fail(new AdapterHostError('CONTRACT_FAILURE', 'MCP NDJSON line exceeded the bounded line limit', {
        ambiguous: this.hasAmbiguousPending()
      }));
      return;
    }
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
    }
  }

  onLine(line) {
    if (this.fatalError) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.fail(new AdapterHostError('CONTRACT_FAILURE', 'MCP emitted malformed NDJSON', {
        cause: error,
        ambiguous: this.hasAmbiguousPending()
      }));
      return;
    }
    const kind = jsonRpcResponseKind(message);
    if (kind === null) {
      this.fail(new AdapterHostError('CONTRACT_FAILURE', 'MCP emitted an invalid JSON-RPC response', {
        ambiguous: this.hasAmbiguousPending()
      }));
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      this.fail(new AdapterHostError('CONTRACT_FAILURE', 'MCP response id was not requested', {
        ambiguous: this.hasAmbiguousPending()
      }));
      return;
    }
    pending.received = true;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (kind === 'error') {
      pending.reject(new AdapterHostError('OPERATION_FAILED', 'MCP tool call failed'));
    } else {
      if (pending.commitRisk === true) this.commitRisk = true;
      pending.resolve(message.result);
    }
  }

  onClose(code, signal) {
    if (this.closed) return;
    if (this.stdoutBuffer.length > 0) {
      this.recordFatal(new AdapterHostError('CONTRACT_FAILURE', 'MCP emitted an unterminated NDJSON line', {
        ambiguous: this.hasAmbiguousPending()
      }));
    } else if (this.pending.size > 0) {
      this.recordFatal(new AdapterHostError('INFRASTRUCTURE_FAILURE', 'MCP child exited before completing the operation', {
        ambiguous: this.hasAmbiguousPending()
      }));
    }
    if (this.fatalError) this.rejectPending(this.fatalError);
    this.closed = true;
    activeSessions.delete(this);
    this.signal?.removeEventListener('abort', this.abortListener);
    this.resolveExit({ code, signal });
  }

  rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  fail(error) {
    const fatal = this.recordFatal(error);
    if (this.closed) return;
    this.rejectPending(fatal);
    void this.terminate();
  }

  request(method, params, options = {}) {
    if (this.fatalError) return Promise.reject(this.fatalError);
    if (this.closed || this.terminating) {
      return Promise.reject(new AdapterHostError('INFRASTRUCTURE_FAILURE', 'MCP child is not available'));
    }
    if (this.signal?.aborted) {
      return Promise.reject(new AdapterHostError('OPERATOR_INTERRUPTION', 'Adapter operation was interrupted'));
    }
    const id = `shadowgraph-benchmark-${++this.sequence}`;
    const line = `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`;
    if (Buffer.byteLength(line, 'utf8') > this.maxBytes) {
      return Promise.reject(new AdapterHostError('CONTRACT_FAILURE', 'MCP request exceeded the bounded line limit'));
    }
    const remainingMs = this.workRemainingMs();
    if (remainingMs <= 0) {
      const timeout = new AdapterHostError('TIMEOUT', 'MCP operation timed out');
      this.fail(timeout);
      return Promise.reject(timeout);
    }
    return new Promise((resolve, reject) => {
      const pending = {
        resolve,
        reject,
        operationCall: options.operationCall === true,
        commitRisk: options.commitRisk === true,
        received: false,
        timer: setTimeout(() => {
          if (!this.pending.has(id)) return;
          const ambiguous = pending.operationCall && !pending.received;
          this.pending.delete(id);
          reject(new AdapterHostError('TIMEOUT', 'MCP operation timed out', { ambiguous }));
          this.fail(new AdapterHostError('TIMEOUT', 'MCP operation timed out', { ambiguous }));
        }, remainingMs)
      };
      this.pending.set(id, pending);
      this.child.stdin.write(line, (error) => {
        if (!error) return;
        if (!this.pending.delete(id)) return;
        clearTimeout(pending.timer);
        const classified = classifyHostError(error, {
          signal: this.signal,
          ambiguous: pending.operationCall
        });
        reject(classified);
        this.fail(classified);
      });
    });
  }

  notify(method, params) {
    if (this.fatalError) throw this.fatalError;
    if (this.closed || this.terminating) {
      throw new AdapterHostError('INFRASTRUCTURE_FAILURE', 'MCP child is not available');
    }
    const line = `${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`;
    if (Buffer.byteLength(line, 'utf8') > this.maxBytes) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'MCP notification exceeded the bounded line limit');
    }
    this.child.stdin.write(line);
  }

  async initialize(compact) {
    const initialized = await this.request('initialize', {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'shadowgraph-benchmark-v1.1', version: '1' }
    });
    if (initialized?.protocolVersion !== MCP_PROTOCOL_VERSION) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'MCP negotiated an unexpected protocol version');
    }
    this.notify('notifications/initialized', {});
    const listed = await this.request('tools/list', {});
    if (!Array.isArray(listed?.tools)) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'MCP tools/list response is invalid');
    }
    const expected = compact ? COMPACT_TOOL_NAMES : FULL_TOOL_NAMES;
    const names = listed.tools.map((tool) => tool?.name);
    if (canonicalJson(names) !== canonicalJson(expected)) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'MCP tool surface does not match the locked benchmark surface');
    }
    this.tools = listed.tools;
  }

  async callTool(name, args, options = {}) {
    if (!this.tools?.some((tool) => tool.name === name)) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'Requested MCP tool is outside the negotiated surface');
    }
    const result = await this.request('tools/call', { name, arguments: args }, {
      operationCall: true,
      commitRisk: options.commitRisk === true
    });
    if (!Array.isArray(result?.content) || result.content.length !== 1
      || result.content[0]?.type !== 'text' || typeof result.content[0].text !== 'string') {
      throw new AdapterHostError('CONTRACT_FAILURE', 'MCP tool result is not one textual content item', {
        ambiguous: options.ambiguousOnInvalidResponse === true
      });
    }
    try {
      return JSON.parse(result.content[0].text);
    } catch (error) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'MCP tool result contains malformed JSON', {
        cause: error,
        ambiguous: options.ambiguousOnInvalidResponse === true
      });
    }
  }

  async runOperation(operation) {
    if (this.fatalError) throw this.fatalError;
    const remainingMs = this.workRemainingMs();
    if (remainingMs <= 0) {
      const timeout = new AdapterHostError('TIMEOUT', 'MCP operation timed out', {
        ambiguous: this.hasCommitRisk()
      });
      this.fail(timeout);
      throw timeout;
    }
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        const error = new AdapterHostError('TIMEOUT', 'MCP operation timed out', {
          ambiguous: this.hasCommitRisk()
        });
        this.fail(error);
        reject(error);
      }, remainingMs);
    });
    try {
      return await Promise.race([Promise.resolve().then(() => operation(this)), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  async waitForExitWithin(limitMs) {
    if (this.closed) return true;
    const waitMs = Math.min(Math.max(0, limitMs), this.remainingMs());
    if (waitMs <= 0) return false;
    let timer;
    try {
      return await Promise.race([
        this.exit.then(() => true),
        new Promise((resolve) => { timer = setTimeout(() => resolve(false), waitMs); })
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  async closeNormally() {
    let deadlineForcedTermination = false;
    if (!this.closed) {
      if (!this.child.stdin.destroyed) this.child.stdin.end();
      const remainingMs = this.remainingMs();
      const cleanupReserve = Math.min(this.cleanupReserveMs, remainingMs / 2);
      const normalCloseBudget = Math.min(
        PROCESS_TERMINATION_GRACE_MS,
        Math.max(0, remainingMs - cleanupReserve)
      );
      const completed = await this.waitForExitWithin(normalCloseBudget);
      if (!completed) {
        deadlineForcedTermination = normalCloseBudget < PROCESS_TERMINATION_GRACE_MS;
        await this.terminate();
      }
    }
    if (this.fatalError) throw this.fatalError;
    if (deadlineForcedTermination) {
      throw new AdapterHostError('TIMEOUT', 'MCP child cleanup reached the operation deadline', {
        ambiguous: this.hasCommitRisk()
      });
    }
    if (!this.closed) {
      throw new AdapterHostError('TIMEOUT', 'MCP child cleanup exceeded the operation deadline', {
        ambiguous: this.hasCommitRisk()
      });
    }
    const exit = await this.exit;
    if (this.fatalError) throw this.fatalError;
    if (exit.code !== 0) {
      throw new AdapterHostError('INFRASTRUCTURE_FAILURE', 'MCP child exited unsuccessfully', {
        ambiguous: this.hasCommitRisk()
      });
    }
    return exit;
  }

  async terminate() {
    if (this.terminating) return this.terminating;
    this.terminating = (async () => {
      if (this.closed) return true;
      this.child.kill('SIGTERM');
      const remainingMs = this.remainingMs();
      const killReserve = Math.min(this.cleanupReserveMs / 2, remainingMs / 2);
      const terminated = await this.waitForExitWithin(
        Math.min(PROCESS_TERMINATION_GRACE_MS, Math.max(0, remainingMs - killReserve))
      );
      if (!terminated && !this.closed) this.child.kill('SIGKILL');
      if (this.closed) return true;
      return this.waitForExitWithin(this.remainingMs());
    })();
    return this.terminating;
  }
}

export async function withMcpSession(options, operation) {
  const compact = options.compact === true;
  const environment = buildChildEnvironment({
    file: options.file,
    storage: options.storage ?? 'json',
    compact
  });
  const client = new NdjsonClient({ ...options, compact, environment });
  let value;
  let failure = null;
  try {
    await client.initialize(compact);
    value = await client.runOperation(operation);
  } catch (error) {
    failure = classifyHostError(error, { signal: options.signal, ambiguous: error?.ambiguous === true });
  }
  let closeFailure = null;
  try {
    await client.closeNormally();
  } catch (error) {
    closeFailure = classifyHostError(error, { signal: options.signal, ambiguous: error?.ambiguous === true });
  }
  failure = client.fatalError ?? failure ?? closeFailure;
  if (failure) throw failure;
  return value;
}

function stateIdentity(backend, request) {
  return {
    backend,
    runId: request.runId,
    armId: request.armId,
    scenarioId: request.scenarioId,
    repetition: request.repetition
  };
}

export function stateLeafDigest(backend, request) {
  if (!['json', 'sqlite'].includes(backend)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Unsupported ShadowGraph storage backend');
  }
  return createHash('sha256')
    .update('shadowgraph:benchmark-state-leaf:v1\0', 'utf8')
    .update(canonicalJson(stateIdentity(backend, request)), 'utf8')
    .digest('hex');
}

async function ensureOwnedRoot(configuredRoot) {
  if (!isNonEmptyString(configuredRoot) || !path.isAbsolute(configuredRoot)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'A mandatory absolute benchmark state root is required');
  }
  const root = path.resolve(configuredRoot);
  if (root === path.parse(root).root) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark state root must not be a filesystem root');
  }
  await mkdir(root, { recursive: true });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark state root must be a real directory');
  }
  const resolvedRoot = await realpath(root);
  const marker = path.join(resolvedRoot, OWNERSHIP_MARKER);
  try {
    const content = await readFile(marker, 'utf8');
    if (content !== OWNERSHIP_CONTENT) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark state root ownership marker is invalid');
    }
  } catch (error) {
    if (error instanceof AdapterHostError) throw error;
    if (error.code !== 'ENOENT') throw error;
    const entries = await readdir(resolvedRoot);
    if (entries.length !== 0) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'Refusing to adopt a non-empty benchmark state root');
    }
    await writeFile(marker, OWNERSHIP_CONTENT, { encoding: 'utf8', flag: 'wx' });
  }
  return resolvedRoot;
}

function directLeaf(root, digest) {
  const leaf = path.resolve(root, digest);
  if (path.dirname(leaf) !== root || path.basename(leaf) !== digest || !/^[a-f0-9]{64}$/u.test(digest)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark state leaf is not a direct opaque child');
  }
  return leaf;
}

function poisonPath(root, digest) {
  return path.join(root, POISON_DIRECTORY, `${digest}.poison`);
}

function fallbackPoisonPath(root, digest) {
  return path.join(root, `${FALLBACK_POISON_PREFIX}${digest}`);
}

function poisonLatchKey(paths) {
  if (!path.isAbsolute(paths.root) || !/^[a-f0-9]{64}$/u.test(paths.digest)) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison latch identity is invalid');
  }
  return `${paths.root}\0${paths.digest}`;
}

function directPoisonDirectory(root) {
  const poisonDirectory = path.resolve(root, POISON_DIRECTORY);
  if (path.dirname(poisonDirectory) !== root || path.basename(poisonDirectory) !== POISON_DIRECTORY) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison directory is not a direct owned child');
  }
  return poisonDirectory;
}

async function ensurePoisonDirectory(root, durability) {
  const operations = durabilityOperations(durability);
  const poisonDirectory = directPoisonDirectory(root);
  try {
    await mkdir(poisonDirectory, { recursive: false });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const state = await lstat(poisonDirectory);
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison directory must be a real directory');
  }
  const resolved = await realpath(poisonDirectory);
  if (resolved !== poisonDirectory || path.dirname(resolved) !== root) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison directory escaped the owned state root');
  }
  // A visible directory is not crash-durable until its parent entry is synced.
  // Sync on every verification so a prior failed/legacy creation is never trusted.
  await operations.syncDirectory(root);
  return poisonDirectory;
}

async function verifiedPoisonMarker(paths) {
  const poisonDirectory = await ensurePoisonDirectory(paths.root, paths.durability);
  const expected = path.join(poisonDirectory, `${paths.digest}.poison`);
  if (paths.poisonDirectory !== poisonDirectory || paths.poison !== expected
    || path.dirname(expected) !== poisonDirectory
    || path.basename(expected) !== `${paths.digest}.poison`) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison marker is outside its owned directory');
  }
  return expected;
}

async function verifiedFallbackPoisonMarker(paths) {
  const root = await ensureOwnedRoot(paths.root);
  const expected = fallbackPoisonPath(root, paths.digest);
  if (root !== paths.root || paths.fallbackPoison !== expected
    || path.dirname(expected) !== root
    || path.basename(expected) !== `${FALLBACK_POISON_PREFIX}${paths.digest}`) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark fallback poison marker is outside its owned root');
  }
  return expected;
}

async function validateExistingControlMarker(marker, parent) {
  const state = await lstat(marker);
  if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison marker must be a regular single-link file');
  }
  const resolved = await realpath(marker);
  if (resolved !== marker || path.dirname(resolved) !== parent) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison marker escaped its owned directory');
  }
  return state;
}

async function controlMarkerExists(paths, verifyMarker) {
  const marker = await verifyMarker(paths);
  try {
    await validateExistingControlMarker(marker, path.dirname(marker));
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

async function removeControlMarker(paths, verifyMarker) {
  const marker = await verifyMarker(paths);
  let state;
  try {
    state = await lstat(marker);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  await validateExistingControlMarker(marker, path.dirname(marker));
  const verifiedAgain = await verifyMarker(paths);
  if (verifiedAgain !== marker || !state.isFile()) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison marker changed during reset');
  }
  await unlink(marker);
}

async function createDurableControlMarker(paths, verifyMarker) {
  const operations = durabilityOperations(paths.durability);
  const marker = await verifyMarker(paths);
  let handle;
  try {
    handle = await operations.openFile(marker, 'wx', 0o600);
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  if (handle) {
    try {
      await handle.writeFile(POISON_CONTENT, { encoding: 'utf8' });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await operations.syncDirectory(path.dirname(marker));
  }
  const verifiedAgain = await verifyMarker(paths);
  if (verifiedAgain !== marker) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark poison marker changed during creation');
  }
  await validateExistingControlMarker(marker, path.dirname(marker));
}

export async function statePaths({ stateRoot, backend, request, durability }) {
  const operations = durabilityOperations(durability);
  const root = await ensureOwnedRoot(stateRoot);
  const digest = stateLeafDigest(backend, request);
  const leaf = directLeaf(root, digest);
  const poisonDirectory = await ensurePoisonDirectory(root, operations);
  return {
    root,
    leaf,
    digest,
    file: path.join(leaf, backend === 'sqlite' ? 'shadowgraph.sqlite' : 'shadowgraph.json'),
    poisonDirectory,
    poison: poisonPath(root, digest),
    fallbackPoison: fallbackPoisonPath(root, digest),
    durability: operations
  };
}

export async function resetStateLeaf(options) {
  const paths = await statePaths(options);
  await rm(paths.leaf, { recursive: true, force: true });
  await removeControlMarker(paths, verifiedPoisonMarker);
  await removeControlMarker(paths, verifiedFallbackPoisonMarker);
  await mkdir(paths.leaf);
  await inspectProductStateLeaf(paths.leaf, paths.file);
  poisonLatches.delete(poisonLatchKey(paths));
  return paths;
}

export async function requireStateLeaf(options) {
  const paths = await statePaths(options);
  let state;
  try {
    state = await lstat(paths.leaf);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark state leaf must be reset before use');
    }
    throw error;
  }
  if (!state.isDirectory() || state.isSymbolicLink()) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Benchmark state leaf must be a real directory');
  }
  await inspectProductStateLeaf(paths.leaf, paths.file);
  const primaryPoisoned = await controlMarkerExists(paths, verifiedPoisonMarker);
  const fallbackPoisoned = await controlMarkerExists(paths, verifiedFallbackPoisonMarker);
  if (primaryPoisoned || fallbackPoisoned || poisonLatches.has(poisonLatchKey(paths))) {
    throw new AdapterHostError('INFRASTRUCTURE_FAILURE', 'Benchmark state leaf is poisoned by an ambiguous persist');
  }
  return paths;
}

export async function poisonStateLeaf(paths) {
  poisonLatches.add(poisonLatchKey(paths));
  try {
    await createDurableControlMarker(paths, verifiedPoisonMarker);
    return;
  } catch {
    // The in-memory latch is already fail-closed; attempt the independent root marker next.
  }
  try {
    await createDurableControlMarker(paths, verifiedFallbackPoisonMarker);
  } catch (error) {
    throw new AdapterHostError('INFRASTRUCTURE_FAILURE', 'Ambiguous persist could not be durably marked', {
      cause: error,
      ambiguous: true
    });
  }
}

async function inspectProductStateLeaf(leaf, expectedFile) {
  const leafState = await lstat(leaf);
  if (!leafState.isDirectory() || leafState.isSymbolicLink() || await realpath(leaf) !== leaf) {
    throw new AdapterHostError('CONTRACT_FAILURE', 'Product state leaf must be a real owned directory');
  }
  let expectedName = null;
  if (expectedFile !== undefined) {
    if (path.dirname(expectedFile) !== leaf || path.resolve(expectedFile) !== expectedFile) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'Product state file is not a direct owned child');
    }
    expectedName = path.basename(expectedFile);
  }

  const names = await readdir(leaf);
  let bytes = 0;
  for (const name of names) {
    const entry = path.resolve(leaf, name);
    if (path.dirname(entry) !== leaf || path.basename(entry) !== name) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'Product state entry is not a direct owned child');
    }
    const state = await lstat(entry);
    if (!state.isFile() || state.isSymbolicLink() || state.nlink !== 1) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'Product state leaf contains an unsafe entry');
    }
    const resolved = await realpath(entry);
    if (resolved !== entry || path.dirname(resolved) !== leaf) {
      throw new AdapterHostError('CONTRACT_FAILURE', 'Product state entry escaped the owned leaf');
    }
    if (!Number.isSafeInteger(state.size) || state.size < 0 || !Number.isSafeInteger(bytes + state.size)) {
      throw new AdapterHostError('INFRASTRUCTURE_FAILURE', 'Product state size could not be measured safely');
    }
    bytes += state.size;
  }

  if (expectedName !== null) {
    try {
      await lstat(expectedFile);
      if (!names.includes(expectedName)) {
        throw new AdapterHostError('CONTRACT_FAILURE', 'Product state file name is not exact');
      }
    } catch (error) {
      if (error instanceof AdapterHostError) throw error;
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return bytes;
}

export async function measureStateLeaf(leaf) {
  const bytes = await inspectProductStateLeaf(leaf);
  return measuredStorage(bytes);
}

let cleanupInstalled = false;
export function installProcessCleanup() {
  if (cleanupInstalled) return;
  cleanupInstalled = true;
  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.once(signal, async () => {
      await Promise.allSettled([...activeSessions].map((session) => session.terminate()));
      process.exit(signal === 'SIGINT' ? 130 : 143);
    });
  }
}

installProcessCleanup();
