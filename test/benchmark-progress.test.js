import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  PROGRESS_EVENTS,
  createProgressLedger,
  createUnitEvidenceLedger,
  evaluateWatchdog
} from '../benchmark/lib/progress.mjs';

const EVENT_FIELDS = [
  'schema',
  'version',
  'eventNumber',
  'event',
  'monotonicMs',
  'runId',
  'attemptId',
  'armId',
  'scenarioId',
  'repetition',
  'phase',
  'evidence'
];

const RUN_ID = 'run-progress-1';
const ATTEMPT_ID = 'attempt-progress-1';
const UNIT_A = Object.freeze({
  armId: 'shadowgraph-full',
  scenarioId: 'S01_DATABASE',
  repetition: 0,
  phase: 'A'
});
const UNIT_B = Object.freeze({
  armId: 'mem0-oss',
  scenarioId: 'S02_API',
  repetition: 1,
  phase: 'B'
});

function runEvent(event, evidence = {}) {
  return {
    event,
    armId: null,
    scenarioId: null,
    repetition: null,
    phase: null,
    evidence
  };
}

function unitEvent(event, correlation = UNIT_A, evidence = {}) {
  return { event, ...correlation, evidence };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'shadowgraph-progress-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function readEvents(progressPath) {
  const text = await readFile(progressPath, 'utf8');
  if (text.length === 0) return [];
  assert.ok(text.endsWith('\n'), 'progress ledger must contain complete NDJSON lines');
  return text.trimEnd().split('\n').map((line) => JSON.parse(line));
}

async function createLedger(t, overrides = {}) {
  const directory = await temporaryDirectory(t);
  const progressPath = path.join(directory, 'progress.ndjson');
  const clock = { value: 0 };
  const ledger = await createProgressLedger({
    path: progressPath,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    monotonicNow: () => clock.value,
    unitTimeoutMs: 120_000,
    sensitiveValues: [],
    ...overrides
  });
  t.after(() => ledger.close());
  return { clock, ledger, progressPath };
}

function assertExactRecord(record, expected = {}) {
  assert.deepEqual(Object.keys(record), EVENT_FIELDS);
  assert.equal(record.schema, 'shadowgraph.progress.event');
  assert.equal(record.version, 1);
  assert.ok(Number.isSafeInteger(record.eventNumber) && record.eventNumber > 0);
  assert.ok(Number.isFinite(record.monotonicMs) && record.monotonicMs >= 0);
  assert.equal(record.runId, RUN_ID);
  assert.equal(record.attemptId, ATTEMPT_ID);
  for (const [key, value] of Object.entries(expected)) assert.deepEqual(record[key], value, key);
}

function shortWritingFile(maxBytes) {
  const chunks = [];
  const actions = [];
  return {
    handle: {
      async write(value, offset = 0, length) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
        const requested = length ?? (bytes.length - offset);
        const bytesWritten = maxBytes === 0 ? 0 : Math.min(maxBytes, requested);
        chunks.push(Buffer.from(bytes.subarray(offset, offset + bytesWritten)));
        actions.push({ type: 'write', bytesWritten });
        return { bytesWritten };
      },
      async sync() { actions.push({ type: 'sync' }); },
      async close() { actions.push({ type: 'close' }); }
    },
    actions,
    text() { return Buffer.concat(chunks).toString('utf8'); }
  };
}

test('progress event names are frozen and a new ledger is exclusive', async (t) => {
  assert.deepEqual(PROGRESS_EVENTS, [
    'run_started',
    'unit_started',
    'unit_finished',
    'unit_failed',
    'checkpoint',
    'heartbeat',
    'run_interrupted',
    'run_finished'
  ]);

  const directory = await temporaryDirectory(t);
  const progressPath = path.join(directory, 'existing.ndjson');
  await writeFile(progressPath, 'preserve-existing-evidence\n', { flag: 'wx' });
  await assert.rejects(
    createProgressLedger({
      path: progressPath,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      monotonicNow: () => 0,
      unitTimeoutMs: 120_000,
      sensitiveValues: []
    }),
    /progress ledger already exists/i
  );
  assert.equal(await readFile(progressPath, 'utf8'), 'preserve-existing-evidence\n');

  await assert.rejects(
    createProgressLedger({
      path: path.join(directory, 'unknown-config.ndjson'),
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      monotonicNow: () => 0,
      unitTimeoutMs: 120_000,
      sensitiveValues: [],
      unexpected: true
    }),
    /Unknown progress config field/i
  );
});

test('a complete lifecycle is append-only, exactly correlated, and monotonically numbered', async (t) => {
  const { clock, ledger, progressPath } = await createLedger(t);

  const inputs = [
    runEvent('run_started', { implementationLockSha256: 'a'.repeat(64) }),
    unitEvent('unit_started', UNIT_A),
    unitEvent('heartbeat', UNIT_A, { nativeOperationCount: 1 }),
    unitEvent('unit_finished', UNIT_A, { unitStatus: 'MEASURED' }),
    unitEvent('checkpoint', UNIT_A, { terminalEventNumber: 4 }),
    unitEvent('unit_started', UNIT_B),
    unitEvent('unit_failed', UNIT_B, { failureCause: 'TIMEOUT' }),
    unitEvent('checkpoint', UNIT_B, { terminalEventNumber: 7 }),
    runEvent('run_finished', { runStatus: 'COMPLETED' })
  ];

  for (const [index, input] of inputs.entries()) {
    clock.value = index * 10;
    const record = await ledger.append(input);
    assertExactRecord(record, {
      eventNumber: index + 1,
      event: input.event,
      monotonicMs: clock.value,
      armId: input.armId,
      scenarioId: input.scenarioId,
      repetition: input.repetition,
      phase: input.phase,
      evidence: input.evidence
    });
    const durable = await readEvents(progressPath);
    assert.equal(durable.length, index + 1, 'append must resolve only after the complete record is durable');
  }

  const records = await readEvents(progressPath);
  assert.deepEqual(records.map(({ eventNumber }) => eventNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(records.map(({ monotonicMs }) => monotonicMs), [0, 10, 20, 30, 40, 50, 60, 70, 80]);
  records.forEach((record) => assertExactRecord(record));
});

test('a terminal unit event and its checkpoint must be durable before another unit starts', async (t) => {
  const { clock, ledger, progressPath } = await createLedger(t);
  await ledger.append(runEvent('run_started'));
  clock.value = 1;
  await ledger.append(unitEvent('unit_started', UNIT_A));

  await assert.rejects(ledger.append(unitEvent('unit_started', UNIT_B)), /active unit/i);
  await assert.rejects(ledger.append(unitEvent('unit_finished', UNIT_B)), /active unit correlation/i);

  clock.value = 2;
  await ledger.append(unitEvent('unit_finished', UNIT_A, { unitStatus: 'MEASURED' }));
  await assert.rejects(ledger.append(unitEvent('unit_started', UNIT_B)), /checkpoint.*required/i);
  await assert.rejects(ledger.append(unitEvent('checkpoint', UNIT_B)), /terminal unit correlation/i);

  clock.value = 3;
  await ledger.append(unitEvent('checkpoint', UNIT_A, { terminalEventNumber: 3 }));
  clock.value = 4;
  await ledger.append(unitEvent('unit_started', UNIT_B));
  clock.value = 5;
  await ledger.append(unitEvent('unit_failed', UNIT_B, { failureCause: 'TIMEOUT' }));
  await assert.rejects(ledger.append(runEvent('run_finished')), /checkpoint.*required/i);
  clock.value = 6;
  await ledger.append(unitEvent('checkpoint', UNIT_B, { terminalEventNumber: 6 }));

  await assert.rejects(ledger.append(unitEvent('unit_started', UNIT_A)), /already started/i);
  clock.value = 7;
  await ledger.append(runEvent('run_finished'));
  await assert.rejects(ledger.append(runEvent('run_interrupted')), /terminal/i);

  const records = await readEvents(progressPath);
  assert.deepEqual(records.map(({ event }) => event), [
    'run_started',
    'unit_started',
    'unit_finished',
    'checkpoint',
    'unit_started',
    'unit_failed',
    'checkpoint',
    'run_finished'
  ]);
  assert.deepEqual(records.map(({ eventNumber }) => eventNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('queued writes preserve terminal-checkpoint-start ordering and close drains them', async (t) => {
  const directory = await temporaryDirectory(t);
  const progressPath = path.join(directory, 'queued.ndjson');
  let monotonicMs = 0;
  const ledger = await createProgressLedger({
    path: progressPath,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    monotonicNow: () => monotonicMs++,
    unitTimeoutMs: 120_000,
    sensitiveValues: []
  });

  const writes = [
    ledger.append(runEvent('run_started')),
    ledger.append(unitEvent('unit_started', UNIT_A)),
    ledger.append(unitEvent('unit_finished', UNIT_A, { unitStatus: 'MEASURED' })),
    ledger.append(unitEvent('checkpoint', UNIT_A, { terminalEventNumber: 3 })),
    ledger.append(unitEvent('unit_started', UNIT_B)),
    ledger.append(unitEvent('heartbeat', UNIT_B)),
    ledger.append(unitEvent('unit_failed', UNIT_B, { failureCause: 'TIMEOUT' })),
    ledger.append(unitEvent('checkpoint', UNIT_B, { terminalEventNumber: 7 })),
    ledger.append(runEvent('run_finished'))
  ];
  const closing = ledger.close();
  await Promise.all([...writes, closing]);

  const records = await readEvents(progressPath);
  assert.equal(records.length, 9);
  assert.deepEqual(records.map(({ eventNumber }) => eventNumber), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  assert.deepEqual(records.map(({ monotonicMs: value }) => value), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  await assert.rejects(ledger.append(runEvent('run_started')), /closed/i);
  await ledger.close();
});

test('watchdog uses only monotonic unit, heartbeat, and checkpoint state', async (t) => {
  const { clock, ledger } = await createLedger(t);
  await ledger.append(runEvent('run_started'));
  clock.value = 10;
  await ledger.append(unitEvent('unit_started', UNIT_A));

  clock.value = 120_009;
  assert.deepEqual(await ledger.watchdogState(), {
    stalled: false,
    cause: null,
    elapsedMs: 119_999,
    referenceEvent: 'unit_started',
    activeCorrelation: { ...UNIT_A }
  });
  clock.value = 120_010;
  assert.deepEqual(await ledger.watchdogState(), {
    stalled: true,
    cause: 'UNIT_TIMEOUT',
    elapsedMs: 120_000,
    referenceEvent: 'unit_started',
    activeCorrelation: { ...UNIT_A }
  });

  await ledger.append(unitEvent('heartbeat', UNIT_A));
  clock.value = 240_009;
  assert.equal((await ledger.watchdogState()).stalled, false, 'heartbeat resets the monotonic watchdog');
  clock.value = 240_010;
  assert.equal((await ledger.watchdogState()).stalled, true);

  clock.value = 240_011;
  await ledger.append(unitEvent('unit_failed', UNIT_A, { failureCause: 'TIMEOUT' }));
  clock.value = 240_012;
  await ledger.append(unitEvent('checkpoint', UNIT_A, { terminalEventNumber: 4 }));
  clock.value = 999_999;
  assert.deepEqual(await ledger.watchdogState(), {
    stalled: false,
    cause: null,
    elapsedMs: 0,
    referenceEvent: 'checkpoint',
    activeCorrelation: null
  });

  assert.deepEqual(evaluateWatchdog({
    currentMonotonicMs: 500,
    unitTimeoutMs: 300,
    unitStartedMonotonicMs: 100,
    lastHeartbeatMonotonicMs: 200,
    lastCheckpointMonotonicMs: 300
  }), {
    stalled: false,
    cause: null,
    elapsedMs: 200,
    referenceEvent: 'checkpoint'
  });
  assert.throws(() => evaluateWatchdog({
    currentMonotonicMs: 500,
    unitTimeoutMs: 300,
    unitStartedMonotonicMs: 100,
    lastHeartbeatMonotonicMs: null,
    lastCheckpointMonotonicMs: null,
    stdoutLastSeenMonotonicMs: 499
  }), /Unknown watchdog input field/i);
});

test('only bounded public evidence is accepted and rejected data never reaches disk or errors', async (t) => {
  const protectedRuntimeValue = 'runtime-private-value-4c9e';
  const directory = await temporaryDirectory(t);
  const progressPath = path.join(directory, 'public-only.ndjson');
  let monotonicMs = 0;
  const ledger = await createProgressLedger({
    path: progressPath,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    monotonicNow: () => monotonicMs++,
    unitTimeoutMs: 120_000,
    sensitiveValues: [protectedRuntimeValue]
  });
  t.after(() => ledger.close());

  await ledger.append(runEvent('run_started', {
    implementationLockSha256: 'b'.repeat(64),
    scored: false
  }));
  await ledger.append(unitEvent('unit_started', UNIT_A));

  const profilePath = ['C:', 'Users', 'private-user', 'model.json'].join('\\');
  const posixProfilePath = ['', 'home', 'private-user', 'model.json'].join('/');
  const bearerValue = ['Bearer', 'private-provider-value'].join(' ');
  const forbiddenKey = ['api', 'Key'].join('');
  const circular = {};
  circular.self = circular;
  const leakingGetter = {};
  Object.defineProperty(leakingGetter, 'note', {
    enumerable: true,
    get() { throw new Error(protectedRuntimeValue); }
  });

  const unsafeEvidence = [
    { note: protectedRuntimeValue },
    { note: profilePath },
    { note: posixProfilePath },
    { note: `diagnostic at ${profilePath}` },
    { note: `diagnostic at ${posixProfilePath}` },
    { note: bearerValue },
    { [forbiddenKey]: 'not-public' },
    { privatePath: 'relative/private-artifact' },
    { nativeContext: ['not-public'] },
    { note: 'x'.repeat(513) },
    { count: Number.POSITIVE_INFINITY },
    { count: 1n },
    circular,
    leakingGetter
  ];

  for (const evidence of unsafeEvidence) {
    await assert.rejects(
      ledger.append(unitEvent('heartbeat', UNIT_A, evidence)),
      (error) => {
        assert.match(error.message, /public evidence/i);
        assert.ok(!error.message.includes(protectedRuntimeValue));
        assert.ok(!error.message.includes('private-user'));
        return true;
      }
    );
  }

  const mutableEvidence = { operationCount: 1, health: { ready: true } };
  const append = ledger.append(unitEvent('heartbeat', UNIT_A, mutableEvidence));
  mutableEvidence.operationCount = 999;
  mutableEvidence.health.ready = false;
  await append;

  const text = await readFile(progressPath, 'utf8');
  for (const forbidden of [protectedRuntimeValue, 'private-user', 'private-provider-value', 'not-public', 'nativeContext']) {
    assert.ok(!text.includes(forbidden), `progress ledger leaked ${forbidden}`);
  }
  const records = await readEvents(progressPath);
  assert.equal(records.length, 3);
  assert.deepEqual(records[2].evidence, { operationCount: 1, health: { ready: true } });
});

test('event and correlation validation fail before any record is appended', async (t) => {
  const { ledger, progressPath } = await createLedger(t);

  await assert.rejects(ledger.append(unitEvent('unit_started', UNIT_A)), /first event.*run_started/i);
  await assert.rejects(ledger.append(runEvent('unknown_event')), /Unsupported progress event/i);
  await assert.rejects(ledger.append({ ...runEvent('run_started'), runId: RUN_ID }), /Unknown progress event field/i);
  await assert.rejects(
    ledger.append({ ...runEvent('run_started'), armId: 'unexpected-arm' }),
    /run-level correlation.*null/i
  );
  await ledger.append(runEvent('run_started'));

  await assert.rejects(
    ledger.append(unitEvent('unit_started', { ...UNIT_A, repetition: -1 })),
    /repetition.*non-negative safe integer/i
  );
  await assert.rejects(
    ledger.append(unitEvent('unit_started', { ...UNIT_A, phase: 'bad phase with spaces' })),
    /phase.*header-safe/i
  );
  const records = await readEvents(progressPath);
  assert.equal(records.length, 1);
  assert.equal(records[0].eventNumber, 1);
});

test('unit evidence ledger is exclusive, append-only, durable, and correlation bound', async (t) => {
  const directory = await temporaryDirectory(t);
  const evidencePath = path.join(directory, 'units.ndjson');
  const ledger = await createUnitEvidenceLedger({
    path: evidencePath,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    sensitiveValues: []
  });
  t.after(() => ledger.close());
  await assert.rejects(
    createUnitEvidenceLedger({
      path: evidencePath,
      runId: RUN_ID,
      attemptId: ATTEMPT_ID,
      sensitiveValues: []
    }),
    /already exists/i
  );

  const first = {
    schemaVersion: 1,
    unitId: 'arm-one:scenario-one:0:A',
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    status: 'MEASURED',
    latencyMs: 12.5,
    evidence: { persisted: true }
  };
  const second = {
    ...first,
    unitId: 'arm-one:scenario-one:0:B',
    status: 'FAILED',
    failure: { cause: 'TIMEOUT' }
  };
  const appends = [ledger.append(first), ledger.append(second)];
  first.status = 'FAILED';
  first.evidence.persisted = false;
  await Promise.all(appends);
  await ledger.close();

  const records = await readEvents(evidencePath);
  assert.equal(records.length, 2);
  assert.equal(records[0].status, 'MEASURED');
  assert.deepEqual(records[0].evidence, { persisted: true });
  assert.equal(records[1].unitId, second.unitId);
  await assert.rejects(ledger.append(second), /closed/i);
});

test('unit evidence ledger rejects duplicates, mismatched correlation, and private data before append', async (t) => {
  const directory = await temporaryDirectory(t);
  const evidencePath = path.join(directory, 'units-private.ndjson');
  const protectedValue = 'runtime-sensitive-unit-value';
  const ledger = await createUnitEvidenceLedger({
    path: evidencePath,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    sensitiveValues: [protectedValue]
  });
  t.after(() => ledger.close());
  const valid = {
    schemaVersion: 1,
    unitId: 'arm-one:scenario-one:0:A',
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    status: 'FAILED',
    failure: { cause: 'TIMEOUT', message: 'Measured operation timed out' }
  };

  await ledger.append(valid);
  await assert.rejects(ledger.append(valid), /duplicate/i);
  await assert.rejects(
    ledger.append({ ...valid, unitId: 'arm-one:scenario-one:0:B', attemptId: 'wrong-attempt' }),
    /attemptId.*match/i
  );
  await assert.rejects(
    ledger.append({
      ...valid,
      unitId: 'arm-one:scenario-one:0:C',
      failure: { cause: 'CONTRACT_FAILURE', message: protectedValue }
    }),
    (error) => {
      assert.match(error.message, /non-public|private/i);
      assert.ok(!error.message.includes(protectedValue));
      return true;
    }
  );

  const records = await readEvents(evidencePath);
  assert.equal(records.length, 1);
});

test('progress append loops over deterministic short writes before fsync and resolution', async (t) => {
  const directory = await temporaryDirectory(t);
  const progressPath = path.join(directory, 'short-progress.ndjson');
  const fake = shortWritingFile(7);
  const openCalls = [];
  const ledger = await createProgressLedger({
    path: progressPath,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    monotonicNow: () => 42,
    unitTimeoutMs: 120_000,
    sensitiveValues: []
  }, {
    openFile: async (...args) => {
      openCalls.push(args);
      return fake.handle;
    }
  });
  t.after(() => ledger.close());

  const record = await ledger.append(runEvent('run_started', { scored: false }));
  assert.deepEqual(openCalls, [[progressPath, 'ax', 0o600]]);
  assert.equal(fake.text(), `${JSON.stringify(record)}\n`);
  const writeActions = fake.actions.filter(({ type }) => type === 'write');
  assert.ok(writeActions.length > 1);
  assert.ok(writeActions.every(({ bytesWritten }) => bytesWritten > 0 && bytesWritten <= 7));
  assert.deepEqual(fake.actions.at(-1), { type: 'sync' });
});

test('unit-evidence append loops over deterministic short writes before fsync and resolution', async (t) => {
  const directory = await temporaryDirectory(t);
  const evidencePath = path.join(directory, 'short-units.ndjson');
  const fake = shortWritingFile(5);
  const openCalls = [];
  const ledger = await createUnitEvidenceLedger({
    path: evidencePath,
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    sensitiveValues: []
  }, {
    openFile: async (...args) => {
      openCalls.push(args);
      return fake.handle;
    }
  });
  t.after(() => ledger.close());
  const evidence = {
    schemaVersion: 1,
    unitId: 'arm-one:scenario-one:0:A',
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    status: 'MEASURED',
    evidence: { persisted: true }
  };

  await ledger.append(evidence);
  assert.deepEqual(openCalls, [[evidencePath, 'ax', 0o600]]);
  assert.equal(fake.text(), `${JSON.stringify(evidence)}\n`);
  const writeActions = fake.actions.filter(({ type }) => type === 'write');
  assert.ok(writeActions.length > 1);
  assert.ok(writeActions.every(({ bytesWritten }) => bytesWritten > 0 && bytesWritten <= 5));
  assert.deepEqual(fake.actions.at(-1), { type: 'sync' });
});

test('both ledgers fail closed when a write reports zero-byte progress', async (t) => {
  const directory = await temporaryDirectory(t);

  const progressFake = shortWritingFile(0);
  const progress = await createProgressLedger({
    path: path.join(directory, 'zero-progress.ndjson'),
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    monotonicNow: () => 0,
    unitTimeoutMs: 120_000,
    sensitiveValues: []
  }, { openFile: async () => progressFake.handle });
  t.after(() => progress.close());
  await assert.rejects(progress.append(runEvent('run_started')), /persistence failed/i);
  assert.deepEqual(progressFake.actions, [{ type: 'write', bytesWritten: 0 }]);

  const evidenceFake = shortWritingFile(0);
  const unitEvidence = await createUnitEvidenceLedger({
    path: path.join(directory, 'zero-units.ndjson'),
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    sensitiveValues: []
  }, { openFile: async () => evidenceFake.handle });
  t.after(() => unitEvidence.close());
  await assert.rejects(unitEvidence.append({
    schemaVersion: 1,
    unitId: 'arm-one:scenario-one:0:A',
    runId: RUN_ID,
    attemptId: ATTEMPT_ID,
    status: 'FAILED'
  }), /write failed/i);
  assert.deepEqual(evidenceFake.actions, [{ type: 'write', bytesWritten: 0 }]);
});
