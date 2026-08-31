import { open } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

export const PROGRESS_EVENTS = Object.freeze([
  'run_started',
  'unit_started',
  'unit_finished',
  'unit_failed',
  'checkpoint',
  'heartbeat',
  'run_interrupted',
  'run_finished'
]);

const CONFIG_FIELDS = new Set([
  'path',
  'runId',
  'attemptId',
  'now',
  'monotonicNow',
  'unitTimeoutMs',
  'sensitiveValues'
]);

const REQUIRED_CONFIG_FIELDS = ['path', 'runId', 'attemptId'];
const EVENT_INPUT_FIELDS = [
  'event',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'evidence'
];
const UNIT_CORRELATION_FIELDS = ['armId', 'scenarioId', 'repetition', 'phase'];
const RUN_EVENTS = new Set(['run_started', 'run_interrupted', 'run_finished']);
const UNIT_EVENTS = new Set(['unit_started', 'unit_finished', 'unit_failed', 'checkpoint', 'heartbeat']);
const WATCHDOG_INPUT_FIELDS = [
  'currentMonotonicMs',
  'unitTimeoutMs',
  'unitStartedMonotonicMs',
  'lastHeartbeatMonotonicMs',
  'lastCheckpointMonotonicMs'
];

const HEADER_SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const EVIDENCE_KEY = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u;
const MAX_EVIDENCE_BYTES = 4_096;
const MAX_EVIDENCE_DEPTH = 5;
const MAX_EVIDENCE_NODES = 128;
const MAX_EVIDENCE_KEYS = 32;
const MAX_EVIDENCE_ARRAY_ITEMS = 64;
const MAX_EVIDENCE_STRING = 512;

const NON_PUBLIC_KEYS = new Set([
  'accesstoken',
  'apikey',
  'authorization',
  'authtoken',
  'bearertoken',
  'clientsecret',
  'credential',
  'directory',
  'embedding',
  'filepath',
  'messages',
  'nativecontext',
  'password',
  'path',
  'privatekey',
  'prompt',
  'requestbody',
  'responsebody',
  'secret',
  'stderr',
  'stdout',
  'token',
  'url'
]);

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function assertExactKeys(value, expectedKeys, label) {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(value)) {
    if (!expected.has(key)) throw new Error(`Unknown ${label} field: ${key}`);
  }
  for (const key of expectedKeys) {
    if (!Object.hasOwn(value, key)) throw new Error(`Missing required ${label} field: ${key}`);
  }
}

function ledgerDependencies(dependencies) {
  if (dependencies === undefined) return { openFile: open };
  assertExactKeys(dependencies, ['openFile'], 'ledger dependencies');
  if (typeof dependencies.openFile !== 'function') {
    throw new Error('ledger dependencies.openFile must be a function');
  }
  return dependencies;
}

async function writeFully(file, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  let offset = 0;
  while (offset < bytes.length) {
    const result = await file.write(bytes, offset, bytes.length - offset);
    const bytesWritten = result?.bytesWritten;
    if (!Number.isSafeInteger(bytesWritten) || bytesWritten < 1 || bytesWritten > bytes.length - offset) {
      throw new Error('Ledger write made no valid progress');
    }
    offset += bytesWritten;
  }
}

function validateIdentifier(value, label) {
  if (!isNonEmptyString(value) || !HEADER_SAFE_ID.test(value)) {
    throw new Error(`${label} must be a header-safe identifier`);
  }
}

function validateConfiguration(config) {
  if (!isPlainObject(config)) throw new Error('progress config must be an object');
  for (const key of Object.keys(config)) {
    if (!CONFIG_FIELDS.has(key)) throw new Error(`Unknown progress config field: ${key}`);
  }
  for (const key of REQUIRED_CONFIG_FIELDS) {
    if (!Object.hasOwn(config, key)) throw new Error(`Missing required progress config field: ${key}`);
  }
  if (!isNonEmptyString(config.path)) throw new Error('progress config.path must be a non-empty string');
  validateIdentifier(config.runId, 'progress config.runId');
  validateIdentifier(config.attemptId, 'progress config.attemptId');
  if (config.now !== undefined && config.monotonicNow !== undefined) {
    throw new Error('progress config must provide at most one monotonic clock');
  }
  const monotonicNow = config.monotonicNow ?? config.now ?? (() => performance.now());
  if (typeof monotonicNow !== 'function') throw new Error('progress monotonic clock must be a function');
  const unitTimeoutMs = config.unitTimeoutMs ?? 120_000;
  if (!Number.isSafeInteger(unitTimeoutMs) || unitTimeoutMs < 1) {
    throw new Error('progress unitTimeoutMs must be a positive safe integer');
  }
  const sensitiveValues = config.sensitiveValues ?? [];
  if (!Array.isArray(sensitiveValues) || !sensitiveValues.every(isNonEmptyString)) {
    throw new Error('progress sensitiveValues must be an array of non-empty strings');
  }
  if (sensitiveValues.length > 64) throw new Error('progress sensitiveValues exceeds its bound');
  return { monotonicNow, unitTimeoutMs, sensitiveValues: [...new Set(sensitiveValues)] };
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[^a-z0-9]/gu, '');
}

function nonPublicKey(value) {
  const normalized = normalizedKey(value);
  return NON_PUBLIC_KEYS.has(normalized)
    || normalized.endsWith('apikey')
    || normalized.endsWith('accesstoken')
    || normalized.endsWith('authtoken')
    || normalized.endsWith('path')
    || normalized.endsWith('password')
    || normalized.endsWith('privatekey')
    || normalized.endsWith('secret')
    || normalized.endsWith('token')
    || normalized.endsWith('url');
}

function nonPublicString(value, sensitiveValues) {
  if (sensitiveValues.some((protectedValue) => value.includes(protectedValue))) return true;
  if (/\bBearer\s+\S+/iu.test(value)) return true;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)) return true;
  if (/\b(?:https?|file):\/\//iu.test(value)) return true;
  if (/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\)/u.test(value)) return true;
  if (/\/(?:home|Users|tmp)(?:\/|$)/u.test(value)) return true;
  if (/\b(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|password)\s*[:=]/iu.test(value)) {
    return true;
  }
  return false;
}

function clonePublicEvidence(evidence, sensitiveValues) {
  if (!isPlainObject(evidence)) throw new Error('progress public evidence must be an object');
  const seen = new Set();
  const budget = { nodes: 0 };

  function visit(value, depth) {
    budget.nodes += 1;
    if (budget.nodes > MAX_EVIDENCE_NODES || depth > MAX_EVIDENCE_DEPTH) {
      throw new Error('progress public evidence exceeds its structural bound');
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) throw new Error('progress public evidence numbers must be safe integers');
      return;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_EVIDENCE_STRING || nonPublicString(value, sensitiveValues)) {
        throw new Error('progress public evidence contains non-public data');
      }
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_EVIDENCE_ARRAY_ITEMS || seen.has(value)) {
        throw new Error('progress public evidence exceeds its structural bound');
      }
      seen.add(value);
      value.forEach((item) => visit(item, depth + 1));
      seen.delete(value);
      return;
    }
    if (!isPlainObject(value) || seen.has(value)) {
      throw new Error('progress public evidence must contain bounded JSON values');
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_EVIDENCE_KEYS) throw new Error('progress public evidence exceeds its structural bound');
    seen.add(value);
    for (const key of keys) {
      if (!EVIDENCE_KEY.test(key) || nonPublicKey(key)) {
        throw new Error('progress public evidence contains non-public data');
      }
      if (value[key] === undefined) throw new Error('progress public evidence must contain bounded JSON values');
      visit(value[key], depth + 1);
    }
    seen.delete(value);
  }

  visit(evidence, 0);
  let serialized;
  try {
    serialized = JSON.stringify(evidence);
  } catch {
    throw new Error('progress public evidence must contain bounded JSON values');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_EVIDENCE_BYTES) {
    throw new Error('progress public evidence exceeds its byte bound');
  }
  return JSON.parse(serialized);
}

function validateEventInput(input, sensitiveValues) {
  assertExactKeys(input, EVENT_INPUT_FIELDS, 'progress event');
  if (!PROGRESS_EVENTS.includes(input.event)) {
    throw new Error(`Unsupported progress event: ${input.event}`);
  }
  const runEvent = RUN_EVENTS.has(input.event);
  const unitEvent = UNIT_EVENTS.has(input.event);
  if (runEvent) {
    if (UNIT_CORRELATION_FIELDS.some((field) => input[field] !== null)) {
      throw new Error('run-level correlation fields must all be null');
    }
  } else if (unitEvent) {
    for (const field of ['armId', 'scenarioId', 'phase']) {
      validateIdentifier(input[field], `progress event.${field}`);
    }
    if (!Number.isSafeInteger(input.repetition) || input.repetition < 0) {
      throw new Error('progress event.repetition must be a non-negative safe integer');
    }
  }
  let evidence;
  try {
    evidence = clonePublicEvidence(input.evidence, sensitiveValues);
  } catch {
    throw new Error('Progress public evidence is invalid or non-public');
  }
  return {
    event: input.event,
    armId: input.armId,
    scenarioId: input.scenarioId,
    repetition: input.repetition,
    phase: input.phase,
    evidence
  };
}

function unitKey(correlation) {
  return `${correlation.armId}\u0000${correlation.scenarioId}\u0000${correlation.repetition}\u0000${correlation.phase}`;
}

function sameUnit(left, right) {
  return UNIT_CORRELATION_FIELDS.every((field) => left?.[field] === right?.[field]);
}

function correlationOf(event) {
  return Object.fromEntries(UNIT_CORRELATION_FIELDS.map((field) => [field, event[field]]));
}

function nullableMonotonic(value, label) {
  if (value !== null && (!Number.isFinite(value) || value < 0)) {
    throw new Error(`${label} must be null or a non-negative finite monotonic time`);
  }
}

/**
 * Make a pure unit-stall decision from monotonic progress only. There is no
 * stdout parameter: console silence is deliberately outside the watchdog.
 */
export function evaluateWatchdog(input) {
  assertExactKeys(input, WATCHDOG_INPUT_FIELDS, 'watchdog input');
  if (!Number.isFinite(input.currentMonotonicMs) || input.currentMonotonicMs < 0) {
    throw new Error('watchdog currentMonotonicMs must be a non-negative finite number');
  }
  if (!Number.isSafeInteger(input.unitTimeoutMs) || input.unitTimeoutMs < 1) {
    throw new Error('watchdog unitTimeoutMs must be a positive safe integer');
  }
  nullableMonotonic(input.unitStartedMonotonicMs, 'watchdog unitStartedMonotonicMs');
  nullableMonotonic(input.lastHeartbeatMonotonicMs, 'watchdog lastHeartbeatMonotonicMs');
  nullableMonotonic(input.lastCheckpointMonotonicMs, 'watchdog lastCheckpointMonotonicMs');
  if (input.unitStartedMonotonicMs === null && input.lastHeartbeatMonotonicMs !== null) {
    throw new Error('watchdog heartbeat requires an active unit start');
  }
  for (const value of [
    input.unitStartedMonotonicMs,
    input.lastHeartbeatMonotonicMs,
    input.lastCheckpointMonotonicMs
  ]) {
    if (value !== null && value > input.currentMonotonicMs) {
      throw new Error('watchdog progress time must not be in the future');
    }
  }

  if (input.unitStartedMonotonicMs === null) {
    return {
      stalled: false,
      cause: null,
      elapsedMs: 0,
      referenceEvent: input.lastCheckpointMonotonicMs === null ? null : 'checkpoint'
    };
  }

  const candidates = [
    { event: 'unit_started', monotonicMs: input.unitStartedMonotonicMs },
    ...(input.lastCheckpointMonotonicMs === null
      ? []
      : [{ event: 'checkpoint', monotonicMs: input.lastCheckpointMonotonicMs }]),
    ...(input.lastHeartbeatMonotonicMs === null
      ? []
      : [{ event: 'heartbeat', monotonicMs: input.lastHeartbeatMonotonicMs }])
  ];
  const reference = candidates.reduce((latest, candidate) => (
    candidate.monotonicMs >= latest.monotonicMs ? candidate : latest
  ));
  const elapsedMs = input.currentMonotonicMs - reference.monotonicMs;
  const stalled = elapsedMs >= input.unitTimeoutMs;
  return {
    stalled,
    cause: stalled ? 'UNIT_TIMEOUT' : null,
    elapsedMs,
    referenceEvent: reference.event
  };
}

function transitionFor(state, event, monotonicMs) {
  if (state.runState === 'NOT_STARTED') {
    if (event.event !== 'run_started') throw new Error('The first event must be run_started');
    return () => { state.runState = 'RUNNING'; };
  }
  if (state.runState === 'TERMINAL') throw new Error('Progress run is already terminal');

  if (event.event === 'run_started') throw new Error('run_started may be recorded only once');

  if (event.event === 'unit_started') {
    if (state.activeUnit !== null) throw new Error('Cannot start a unit while another active unit exists');
    if (state.pendingCheckpoint !== null) {
      throw new Error('A durable checkpoint is required before the next unit can start');
    }
    const key = unitKey(event);
    if (state.startedUnits.has(key)) throw new Error('This unit was already started');
    const correlation = correlationOf(event);
    return () => {
      state.startedUnits.add(key);
      state.activeUnit = {
        correlation,
        startedMonotonicMs: monotonicMs,
        lastHeartbeatMonotonicMs: null
      };
    };
  }

  if (event.event === 'heartbeat') {
    if (state.activeUnit === null) throw new Error('heartbeat requires an active unit');
    if (!sameUnit(state.activeUnit.correlation, event)) {
      throw new Error('heartbeat must match the active unit correlation');
    }
    return () => { state.activeUnit.lastHeartbeatMonotonicMs = monotonicMs; };
  }

  if (event.event === 'unit_finished' || event.event === 'unit_failed') {
    if (state.activeUnit === null) throw new Error(`${event.event} requires an active unit`);
    if (!sameUnit(state.activeUnit.correlation, event)) {
      throw new Error(`${event.event} must match the active unit correlation`);
    }
    const correlation = correlationOf(event);
    return () => {
      state.activeUnit = null;
      state.pendingCheckpoint = correlation;
    };
  }

  if (event.event === 'checkpoint') {
    if (state.pendingCheckpoint === null) {
      throw new Error('checkpoint requires a terminal unit event');
    }
    if (!sameUnit(state.pendingCheckpoint, event)) {
      throw new Error('checkpoint must match the terminal unit correlation');
    }
    return () => {
      state.pendingCheckpoint = null;
      state.lastCheckpointMonotonicMs = monotonicMs;
    };
  }

  if (event.event === 'run_finished') {
    if (state.activeUnit !== null) throw new Error('run_finished cannot replace an active unit terminal event');
    if (state.pendingCheckpoint !== null) {
      throw new Error('A durable checkpoint is required before run_finished');
    }
    return () => { state.runState = 'TERMINAL'; };
  }

  if (event.event === 'run_interrupted') {
    return () => {
      state.runState = 'TERMINAL';
      state.activeUnit = null;
      state.pendingCheckpoint = null;
    };
  }

  throw new Error(`Unsupported progress event: ${event.event}`);
}

/**
 * Create a new append-only progress ledger. The file is opened exclusively;
 * append resolves only after the complete NDJSON record has been flushed and
 * fsynced. runId and attemptId are bound once and injected into every record.
 */
export async function createProgressLedger(config, dependencies) {
  const { monotonicNow, unitTimeoutMs, sensitiveValues } = validateConfiguration(config);
  const { openFile } = ledgerDependencies(dependencies);
  let file;
  try {
    file = await openFile(config.path, 'ax', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Progress ledger already exists');
    throw error;
  }

  const state = {
    runState: 'NOT_STARTED',
    activeUnit: null,
    pendingCheckpoint: null,
    lastCheckpointMonotonicMs: null,
    startedUnits: new Set()
  };
  let accepting = true;
  let closed = false;
  let closePromise = null;
  let persistenceFailed = false;
  let nextEventNumber = 1;
  let lastObservedMonotonicMs = null;
  let writeQueue = Promise.resolve();

  function readMonotonic() {
    const value = monotonicNow();
    if (!Number.isFinite(value) || value < 0) {
      throw new Error('Progress monotonic clock must return a non-negative finite number');
    }
    if (lastObservedMonotonicMs !== null && value < lastObservedMonotonicMs) {
      throw new Error('Progress monotonic clock moved backwards');
    }
    lastObservedMonotonicMs = value;
    return value;
  }

  function append(input) {
    if (!accepting) return Promise.reject(new Error('Progress ledger is closed'));
    let event;
    try {
      event = validateEventInput(input, sensitiveValues);
    } catch (error) {
      return Promise.reject(error);
    }

    const operation = writeQueue.then(async () => {
      if (persistenceFailed) throw new Error('Progress ledger persistence previously failed');
      if (nextEventNumber > Number.MAX_SAFE_INTEGER) throw new Error('Progress event number exhausted');
      const monotonicMs = readMonotonic();
      const applyTransition = transitionFor(state, event, monotonicMs);
      const record = {
        schema: 'shadowgraph.progress.event',
        version: 1,
        eventNumber: nextEventNumber,
        event: event.event,
        monotonicMs,
        runId: config.runId,
        attemptId: config.attemptId,
        armId: event.armId,
        scenarioId: event.scenarioId,
        repetition: event.repetition,
        phase: event.phase,
        evidence: event.evidence
      };
      try {
        await writeFully(file, `${JSON.stringify(record)}\n`);
        await file.sync();
      } catch {
        persistenceFailed = true;
        throw new Error('Progress ledger persistence failed');
      }
      applyTransition();
      nextEventNumber += 1;
      return record;
    });
    writeQueue = operation.catch(() => {});
    return operation;
  }

  async function watchdogState() {
    await writeQueue;
    const currentMonotonicMs = readMonotonic();
    const decision = evaluateWatchdog({
      currentMonotonicMs,
      unitTimeoutMs,
      unitStartedMonotonicMs: state.activeUnit?.startedMonotonicMs ?? null,
      lastHeartbeatMonotonicMs: state.activeUnit?.lastHeartbeatMonotonicMs ?? null,
      lastCheckpointMonotonicMs: state.lastCheckpointMonotonicMs
    });
    return {
      ...decision,
      activeCorrelation: state.activeUnit === null ? null : { ...state.activeUnit.correlation }
    };
  }

  function close() {
    if (closePromise !== null) return closePromise;
    accepting = false;
    closePromise = (async () => {
      await writeQueue;
      if (!closed) {
        await file.close();
        closed = true;
      }
    })();
    return closePromise;
  }

  return Object.freeze({ append, watchdogState, close });
}

const UNIT_EVIDENCE_CONFIG_FIELDS = ['path', 'runId', 'attemptId', 'sensitiveValues'];
const MAX_UNIT_EVIDENCE_BYTES = 2 * 1024 * 1024;
const MAX_UNIT_EVIDENCE_DEPTH = 16;
const MAX_UNIT_EVIDENCE_NODES = 100_000;
const MAX_UNIT_EVIDENCE_KEYS = 512;
const MAX_UNIT_EVIDENCE_ARRAY_ITEMS = 10_000;
const MAX_UNIT_EVIDENCE_STRING = 128 * 1024;

function validateUnitEvidenceConfiguration(config) {
  assertExactKeys(config, UNIT_EVIDENCE_CONFIG_FIELDS, 'unit evidence config');
  if (!isNonEmptyString(config.path)) throw new Error('unit evidence config.path must be a non-empty string');
  validateIdentifier(config.runId, 'unit evidence config.runId');
  validateIdentifier(config.attemptId, 'unit evidence config.attemptId');
  if (!Array.isArray(config.sensitiveValues) || !config.sensitiveValues.every(isNonEmptyString)) {
    throw new Error('unit evidence sensitiveValues must be an array of non-empty strings');
  }
  if (config.sensitiveValues.length > 64) throw new Error('unit evidence sensitiveValues exceeds its bound');
  return [...new Set(config.sensitiveValues)];
}

function privateUnitString(value, sensitiveValues) {
  if (sensitiveValues.some((protectedValue) => value.includes(protectedValue))) return true;
  if (/\bBearer\s+\S+/iu.test(value)) return true;
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(value)) return true;
  if (/(?:^|[\s"'(])(?:[A-Za-z]:[\\/]|\\\\)/u.test(value)) return true;
  if (/\/(?:home|Users|tmp)(?:\/|$)/u.test(value)) return true;
  return /\b(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|client[-_ ]?secret|password)\s*[:=]/iu.test(value);
}

function cloneUnitEvidence(input, config, sensitiveValues) {
  if (!isPlainObject(input)) throw new Error('unit evidence must be an object');
  if (input.runId !== config.runId) throw new Error('unit evidence runId must match its ledger');
  if (input.attemptId !== config.attemptId) throw new Error('unit evidence attemptId must match its ledger');
  validateIdentifier(input.unitId, 'unit evidence unitId');
  const seen = new Set();
  const budget = { nodes: 0 };

  function visit(value, depth) {
    budget.nodes += 1;
    if (budget.nodes > MAX_UNIT_EVIDENCE_NODES || depth > MAX_UNIT_EVIDENCE_DEPTH) {
      throw new Error('unit evidence exceeds its structural bound');
    }
    if (value === null || typeof value === 'boolean') return;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new Error('unit evidence must contain finite numbers');
      return;
    }
    if (typeof value === 'string') {
      if (value.length > MAX_UNIT_EVIDENCE_STRING || privateUnitString(value, sensitiveValues)) {
        throw new Error('unit evidence contains non-public data');
      }
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_UNIT_EVIDENCE_ARRAY_ITEMS || seen.has(value)) {
        throw new Error('unit evidence exceeds its structural bound');
      }
      seen.add(value);
      value.forEach((item) => visit(item, depth + 1));
      seen.delete(value);
      return;
    }
    if (!isPlainObject(value) || seen.has(value)) {
      throw new Error('unit evidence must contain bounded JSON values');
    }
    const keys = Object.keys(value);
    if (keys.length > MAX_UNIT_EVIDENCE_KEYS) throw new Error('unit evidence exceeds its structural bound');
    seen.add(value);
    for (const key of keys) {
      if (nonPublicKey(key)) throw new Error('unit evidence contains non-public data');
      if (value[key] === undefined) throw new Error('unit evidence must contain bounded JSON values');
      visit(value[key], depth + 1);
    }
    seen.delete(value);
  }

  visit(input, 0);
  let serialized;
  try {
    serialized = JSON.stringify(input);
  } catch {
    throw new Error('unit evidence must contain bounded JSON values');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_UNIT_EVIDENCE_BYTES) {
    throw new Error('unit evidence exceeds its byte bound');
  }
  return { record: JSON.parse(serialized), serialized };
}

/**
 * Create an append-only, fsync-before-resolution journal for complete raw units.
 * Semantic validation remains the validator's job; this boundary guarantees
 * correlation, privacy, immutability, and durability before progress advances.
 */
export async function createUnitEvidenceLedger(config, dependencies) {
  const sensitiveValues = validateUnitEvidenceConfiguration(config);
  const { openFile } = ledgerDependencies(dependencies);
  let file;
  try {
    file = await openFile(config.path, 'ax', 0o600);
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Unit evidence ledger already exists');
    throw new Error('Unable to create unit evidence ledger');
  }

  let accepting = true;
  let closed = false;
  let closePromise = null;
  let writeQueue = Promise.resolve();
  let fatalError = null;
  const unitIds = new Set();

  function append(input) {
    if (!accepting) return Promise.reject(new Error('Unit evidence ledger is closed'));
    if (fatalError !== null) return Promise.reject(new Error('Unit evidence ledger is unavailable'));
    let candidate;
    try {
      candidate = cloneUnitEvidence(input, config, sensitiveValues);
      if (unitIds.has(candidate.record.unitId)) throw new Error('Duplicate unit evidence unitId');
      unitIds.add(candidate.record.unitId);
    } catch (error) {
      const message = /duplicate|runId|attemptId|unitId/iu.test(error.message)
        ? error.message
        : 'Unit evidence is invalid, private, or exceeds its bound';
      return Promise.reject(new Error(message));
    }

    const write = writeQueue.then(async () => {
      try {
        await writeFully(file, `${candidate.serialized}\n`);
        await file.sync();
      } catch {
        fatalError = new Error('Unit evidence ledger write failed');
        throw fatalError;
      }
    });
    writeQueue = write.catch(() => {});
    return write;
  }

  function close() {
    if (closePromise !== null) return closePromise;
    accepting = false;
    closePromise = (async () => {
      await writeQueue;
      if (!closed) {
        await file.close();
        closed = true;
      }
    })();
    return closePromise;
  }

  return Object.freeze({ append, close });
}
