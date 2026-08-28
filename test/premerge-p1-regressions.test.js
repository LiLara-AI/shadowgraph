import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { restoreFile } from '../src/backup.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { JOURNAL_TYPE_ENTITY_KIND, REPLAYABLE_ENTRY_TYPES } from '../src/journal.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';

const BOUNDARY = '2026-08-28T00:00:01.000Z';

async function verifyAcrossIoBoundary(postIoInstant) {
  const clock = { value: '2026-08-28T00:00:00.999Z' };
  const validationInstants = [];
  const verifier = {
    async verify({ fact }) {
      await Promise.resolve();
      clock.value = postIoInstant;
      return { factId: fact.id, verifierIdentity: 'premerge-boundary-verifier' };
    },
    validateStored(_fact, { trustedValidationInstant } = {}) {
      validationInstants.push(trustedValidationInstant);
      return Date.parse(trustedValidationInstant) < Date.parse(BOUNDARY);
    }
  };
  const graph = createShadowGraph({ now: () => clock.value, verifier });
  const fact = graph.addFact({
    id: `verification-${postIoInstant}`,
    project: 'premerge-verification',
    key: 'boundary',
    value: postIoInstant,
    expiresAt: BOUNDARY
  });
  return { graph, fact, validationInstants };
}

test('P1 premerge verifier slice: commit uses trusted now sampled after verifier I/O at [before, at, after] boundary', async () => {
  const before = await verifyAcrossIoBoundary('2026-08-28T00:00:00.999Z');
  const accepted = await before.graph.verifyFact({ factId: before.fact.id, evidencePath: 'trusted-local-evidence.json' });
  assert.equal(accepted.operation, 'VERIFIED');
  assert.equal(accepted.fact.verificationStatus, 'verified');
  assert.deepEqual(before.validationInstants, ['2026-08-28T00:00:00.999Z']);

  for (const instant of [BOUNDARY, '2026-08-28T00:00:02.000Z']) {
    const rejected = await verifyAcrossIoBoundary(instant);
    const stateBeforeVerification = rejected.graph.exportData();
    await assert.rejects(
      rejected.graph.verifyFact({ factId: rejected.fact.id, evidencePath: 'trusted-local-evidence.json' }),
      /invalid or expired persisted fact verification/i
    );
    assert.deepEqual(rejected.validationInstants, [instant]);
    assert.deepEqual(rejected.graph.exportData(), stateBeforeVerification, 'failed verification cannot elevate trust or append history');
  }
});

test('P1 follow-up verifier slice: identical retry crossing the signed boundary revalidates and atomically expires trust', async () => {
  const clock = { value: '2026-08-28T00:00:00.999Z' };
  const validationInstants = [];
  const attestation = { factId: 'verification-identical-retry', verifierIdentity: 'premerge-boundary-verifier' };
  const verifier = {
    async verify({ fact }) {
      await Promise.resolve();
      if (fact.verificationStatus === 'verified') clock.value = BOUNDARY;
      return attestation;
    },
    validateStored(_fact, { trustedValidationInstant } = {}) {
      validationInstants.push(trustedValidationInstant);
      return Date.parse(trustedValidationInstant) < Date.parse(BOUNDARY);
    }
  };
  const graph = createShadowGraph({ now: () => clock.value, verifier });
  const fact = graph.addFact({
    id: attestation.factId,
    project: 'premerge-verification',
    key: 'identical-retry-boundary',
    value: true,
    expiresAt: BOUNDARY
  });
  const first = await graph.verifyFact({ factId: fact.id, evidencePath: 'trusted-local-evidence.json' });
  assert.equal(first.operation, 'VERIFIED');

  await assert.rejects(
    graph.verifyFact({ factId: fact.id, evidencePath: 'trusted-local-evidence.json' }),
    /invalid or expired persisted fact verification/i
  );
  assert.deepEqual(validationInstants, ['2026-08-28T00:00:00.999Z', BOUNDARY], 'identical retry must validate with the post-I/O instant');
  const after = graph.exportData();
  const stored = after.facts.find((item) => item.id === fact.id);
  assert.equal(stored.status, 'expired');
  assert.equal(stored.verificationStatus, 'expired');
  assert.equal(stored.temporal.validTo, BOUNDARY);
  assert.equal(stored.temporal.invalidatedAt, BOUNDARY);
  assert.equal(after.journal.filter((entry) => entry.type === 'fact.verified').length, 1);
  assert.equal(after.journal.at(-1).type, 'fact.expired');
});

test('P1 follow-up verification transaction slice: sequence overflow leaves all graph state byte-for-byte unchanged', async () => {
  const verifier = {
    async verify({ fact }) {
      await Promise.resolve();
      return { factId: fact.id, verifierIdentity: 'premerge-overflow-verifier' };
    },
    validateStored() { return true; }
  };
  const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z', verifier });
  const fact = graph.addFact({
    id: 'verification-sequence-overflow',
    project: 'premerge-verification-overflow',
    key: 'verification-transaction',
    value: 'must remain unverified',
    idempotencyKey: 'verification-overflow-retry'
  });
  graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER });
  const before = graph.exportData();

  await assert.rejects(
    graph.verifyFact({ factId: fact.id, evidencePath: 'trusted-local-evidence.json' }),
    /journal sequence overflow/i
  );
  assert.deepEqual(
    graph.exportData(),
    before,
    'failed verification must preserve status, attestation, journal, events, idempotency, revision, and sequence'
  );
});

function schema5RawPurgeLedger(kind) {
  const rawIdentity = 'P1_PREMERGE_RAW_PURGED_IDENTITY';
  const common = {
    id: `raw-${kind}`,
    seq: 1,
    at: '2026-08-28T00:00:00.000Z',
    project: 'premerge-purged',
    schemaVersion: 5,
    provenance: { actor: rawIdentity, client: 'raw-client', sessionId: 'raw-session' }
  };
  const entry = kind === 'marker'
    ? {
        ...common,
        type: 'project.purged',
        entityKind: 'project',
        entityId: rawIdentity,
        payload: {
          project: 'premerge-purged', mode: 'logical', removed: 1,
          removedJournalSequences: [], purgedEntityIds: [rawIdentity]
        }
      }
    : {
        ...common,
        type: 'decision.recorded',
        entityKind: 'decision',
        entityId: rawIdentity,
        payload: null,
        redacted: true,
        redactedReason: 'project_purged',
        requestId: rawIdentity
      };
  return {
    schemaVersion: 5,
    revision: 0,
    records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [],
    journal: [entry], journalSeq: 1, journalEpoch: 1
  };
}

test('P1 premerge schema slice: schema 5 rejects raw purge ledgers instead of migrating current data', () => {
  for (const kind of ['marker', 'skeleton']) {
    const payload = schema5RawPurgeLedger(kind);
    const graph = createShadowGraph();
    assert.throws(
      () => graph.importData(payload),
      /schema 5.*purge|noncanonical.*purge|forbidden.*purge/i,
      `${kind}: direct import must reject current-schema raw identity`
    );

    const live = createShadowGraph();
    live.addDecision({ id: `kept-${kind}`, project: 'kept', title: 'Keep live state', chosen: 'preserve' });
    const before = live.exportData();
    assert.throws(
      () => live.replaceData(payload),
      /schema 5.*purge|noncanonical.*purge|forbidden.*purge/i,
      `${kind}: replacement must reject current-schema raw identity`
    );
    assert.deepEqual(live.exportData(), before, `${kind}: failed replacement must be atomic`);
  }
});

function schema5DisguisedPurgeSkeleton(redactedMode) {
  const rawIdentity = `P1_DISGUISED_PURGE_${redactedMode.toUpperCase()}`;
  const entry = {
    id: `disguised-${redactedMode}`,
    seq: 1,
    type: 'decision.recorded',
    at: '2026-08-28T00:00:00.000Z',
    project: 'premerge-disguised-purge',
    entityKind: 'decision',
    entityId: rawIdentity,
    schemaVersion: 5,
    payload: null,
    redactedReason: 'project_purged',
    provenance: { actor: rawIdentity, client: 'raw-client', sessionId: 'raw-session' },
    requestId: rawIdentity
  };
  if (redactedMode === 'false') entry.redacted = false;
  if (redactedMode === 'payload-null-no-reason') delete entry.redactedReason;
  return {
    schemaVersion: 5,
    revision: 0,
    records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [],
    journal: [entry], journalSeq: 1, journalEpoch: 1
  };
}

test('P1 follow-up schema slice: purge-reason and replayable payload-null skeletons require canonical redacted true', () => {
  for (const redactedMode of ['false', 'omitted', 'payload-null-no-reason']) {
    const payload = schema5DisguisedPurgeSkeleton(redactedMode);
    assert.throws(
      () => createShadowGraph().importData(payload),
      /schema 5.*purge|noncanonical.*purge|redacted true/i,
      `${redactedMode}: direct import must not accept a disguised purge skeleton`
    );

    const live = createShadowGraph();
    live.addDecision({ id: `kept-disguised-${redactedMode}`, project: 'kept', title: 'Keep live state', chosen: 'preserve' });
    const before = live.exportData();
    assert.throws(
      () => live.replaceData(payload),
      /schema 5.*purge|noncanonical.*purge|redacted true/i,
      `${redactedMode}: replacement must reject before mutation`
    );
    assert.deepEqual(live.exportData(), before);
  }

  const rebuildPayload = schema5DisguisedPurgeSkeleton('payload-null-no-reason');
  rebuildPayload.schemaVersion = 4;
  rebuildPayload.journal[0].schemaVersion = 4;
  const rebuildProbe = createShadowGraph();
  assert.doesNotThrow(() => rebuildProbe.importData(rebuildPayload), 'legacy import remains readable before current-schema rebuild validation');
  const rebuild = rebuildProbe.rebuild();
  assert.equal(rebuild.rebuildable, false);
  assert.match(rebuild.reason, /noncanonical schema-5 purge artifacts/i);

  const canonicalSkeleton = schema5DisguisedPurgeSkeleton('canonical');
  Object.assign(canonicalSkeleton.journal[0], {
    entityId: null,
    redacted: true,
    provenance: { actor: null, client: null, sessionId: null }
  });
  delete canonicalSkeleton.journal[0].requestId;
  const canonical = createShadowGraph();
  assert.doesNotThrow(() => canonical.importData(canonicalSkeleton));
  assert.equal(canonical.rebuild().rebuildable, true);

  const legacy = schema5DisguisedPurgeSkeleton('legacy');
  legacy.journal[0] = {
    id: 'legitimate-payload-null-legacy', seq: 1, type: 'legacy_metadata_event',
    at: '2026-08-28T00:00:00.000Z', project: null, entityKind: null,
    entityId: 'legacy-audit-identity', schemaVersion: 5, payload: null,
    replayable: false, originalType: 'decision.recorded',
    provenance: { actor: 'legacy-actor', client: null, sessionId: null }
  };
  const compatible = createShadowGraph();
  assert.doesNotThrow(() => compatible.importData(legacy));
  assert.equal(compatible.exportData().journal[0].type, 'legacy_metadata_event');
  assert.equal(compatible.rebuild().reason === 'journal contains noncanonical schema-5 purge artifacts', false);
});

test('P1 replayability schema slice: replayable:false cannot disguise a payload-null current-schema replayable entry', () => {
  const payload = schema5DisguisedPurgeSkeleton('payload-null-no-reason');
  payload.journal[0].replayable = false;
  const rejection = /replayable.*(?:false|type)|noncanonical.*purge|redacted true/i;

  assert.throws(
    () => createShadowGraph().importData(payload),
    rejection,
    'direct import must reject the exact decision.recorded bypass before storing it'
  );

  const live = createShadowGraph();
  live.addDecision({ id: 'kept-replayable-contradiction', project: 'kept', title: 'Keep live state', chosen: 'preserve' });
  const before = live.exportData();
  assert.throws(() => live.replaceData(payload), rejection, 'replacement must reject before mutation');
  assert.deepEqual(live.exportData(), before);

  const legacyEnvelope = structuredClone(payload);
  legacyEnvelope.schemaVersion = 4;
  legacyEnvelope.journal[0].schemaVersion = 4;
  const validationProbe = createShadowGraph();
  assert.doesNotThrow(() => validationProbe.importData(legacyEnvelope), 'legacy envelopes remain readable');
  const validation = validationProbe.validate();
  assert.equal(validation.valid, false, 'current in-memory validation must classify the contradiction');
  assert.ok(validation.issues.some((issue) => issue.code === 'noncanonical_schema5_purge_artifact'));
  const rebuild = validationProbe.rebuild();
  assert.equal(rebuild.rebuildable, false, 'rebuild must fail closed rather than silently dropping the entry');
  assert.match(rebuild.reason, /noncanonical schema-5 purge artifacts/i);
});

test('P1 replayability schema matrix: every payload-null replayable type is a purge skeleton regardless of caller flag', () => {
  for (const type of REPLAYABLE_ENTRY_TYPES) {
    for (const callerFlag of ['omitted', 'false']) {
      const payload = schema5DisguisedPurgeSkeleton('payload-null-no-reason');
      Object.assign(payload.journal[0], {
        id: `payload-null-${type}-${callerFlag}`,
        type,
        entityKind: JOURNAL_TYPE_ENTITY_KIND[type] ?? null
      });
      if (callerFlag === 'false') payload.journal[0].replayable = false;
      assert.throws(
        () => createShadowGraph().importData(payload),
        /replayable.*(?:false|type)|noncanonical.*purge|redacted true/i,
        `${type}/${callerFlag}: payload-null classification must not trust the caller flag`
      );
    }

    const canonicalPayload = schema5DisguisedPurgeSkeleton('payload-null-no-reason');
    Object.assign(canonicalPayload.journal[0], {
      id: `canonical-payload-null-${type}`,
      type,
      entityKind: JOURNAL_TYPE_ENTITY_KIND[type] ?? null,
      entityId: null,
      redacted: true,
      redactedReason: 'project_purged',
      provenance: { actor: null, client: null, sessionId: null }
    });
    delete canonicalPayload.journal[0].requestId;
    assert.doesNotThrow(
      () => createShadowGraph().importData(canonicalPayload),
      `${type}: canonical purge skeleton remains readable`
    );
  }

  const compatible = createShadowGraph();
  const legacy = schema5DisguisedPurgeSkeleton('legacy-non-replayable');
  legacy.journal[0] = {
    id: 'narrow-legacy-metadata-event', seq: 1, type: 'legacy_metadata_event',
    at: '2026-08-28T00:00:00.000Z', project: null, entityKind: null,
    entityId: 'legacy-audit-identity', schemaVersion: 5, payload: null,
    replayable: false, originalType: 'decision.recorded',
    provenance: { actor: 'legacy-actor', client: null, sessionId: null }
  };
  assert.doesNotThrow(() => compatible.importData(legacy));
  assert.equal(compatible.exportData().journal[0].type, 'legacy_metadata_event');
});

function runCliCommand(destination, command, payload, storage = 'json') {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', command, JSON.stringify(payload)], {
      cwd: process.cwd(),
      env: { ...process.env, SHADOWGRAPH_FILE: destination, SHADOWGRAPH_STORAGE: storage },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function runRestoreCli(destination, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'restore', source], {
      cwd: process.cwd(),
      env: { ...process.env, SHADOWGRAPH_FILE: destination, SHADOWGRAPH_STORAGE: 'json' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startRestoreMcp(destination) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: destination, SHADOWGRAPH_STORAGE: 'json' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let buffered = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    buffered += chunk;
    const lines = buffered.split(/\r?\n/);
    buffered = lines.pop();
    for (const line of lines.filter((candidate) => candidate.trim())) {
      const response = JSON.parse(line);
      const waiter = pending.get(JSON.stringify(response.id));
      if (!waiter) continue;
      pending.delete(JSON.stringify(response.id));
      waiter.resolve(response);
    }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited with ${code}: ${stderr}`));
    pending.clear();
  });
  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const key = JSON.stringify(request.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`MCP timeout: ${stderr}`));
        }, 10_000);
        pending.set(key, {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
}

function safeRestorePayload(id) {
  const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
  graph.addDecision({ id, project: 'premerge-restore-kept', title: 'Keep destination', chosen: 'preserve' });
  return graph.exportData();
}

async function seedJsonRestoreDestination(path, id) {
  const store = createJsonFileStore(path);
  await store.save(safeRestorePayload(id));
  store.close();
  return readFile(path);
}

test('P1 follow-up schema surfaces: redacted false, omitted, or replayable:false purge skeletons fail closed on every restore path', async () => {
  const rejection = /schema 5.*purge|noncanonical.*purge|redacted true|replayable.*(?:false|type)/i;
  for (const redactedMode of ['false', 'omitted', 'replayable-false']) {
    const directory = await mkdtemp(join(tmpdir(), `shadowgraph-premerge-purge-${redactedMode}-`));
    const payload = schema5DisguisedPurgeSkeleton(redactedMode === 'replayable-false' ? 'payload-null-no-reason' : redactedMode);
    if (redactedMode === 'replayable-false') payload.journal[0].replayable = false;
    const sourceJson = join(directory, 'malicious.json');
    await writeFile(sourceJson, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    assert.throws(() => validateRestorePayload(payload), rejection, `${redactedMode}: restore validator`);

    const jsonDestination = join(directory, 'direct.json');
    const jsonBefore = await seedJsonRestoreDestination(jsonDestination, `json-kept-${redactedMode}`);
    await assert.rejects(restoreFile(sourceJson, jsonDestination), rejection, `${redactedMode}: JSON restore`);
    assert.deepEqual(await readFile(jsonDestination), jsonBefore, `${redactedMode}: JSON bytes stay unchanged`);

    const sqliteSource = join(directory, 'malicious.db');
    const sqliteDestination = join(directory, 'direct.db');
    const sqliteSourceStore = await createSqliteStore(sqliteSource);
    await sqliteSourceStore.save(payload);
    sqliteSourceStore.close();
    const sqliteStore = await createSqliteStore(sqliteDestination);
    await sqliteStore.save(safeRestorePayload(`sqlite-kept-${redactedMode}`));
    const sqliteBefore = await sqliteStore.load();
    try {
      await assert.rejects(sqliteStore.restore(sqliteSource), rejection, `${redactedMode}: SQLite restore`);
      assert.deepEqual(await sqliteStore.load(), sqliteBefore, `${redactedMode}: SQLite state stays unchanged`);
    } finally {
      sqliteStore.close();
    }

    const cliDestination = join(directory, 'cli.json');
    const cliBefore = await seedJsonRestoreDestination(cliDestination, `cli-kept-${redactedMode}`);
    const cli = await runRestoreCli(cliDestination, sourceJson);
    assert.notEqual(cli.code, 0, `${redactedMode}: CLI must reject`);
    assert.match(cli.stderr, rejection);
    assert.deepEqual(await readFile(cliDestination), cliBefore, `${redactedMode}: CLI bytes stay unchanged`);

    const httpDestination = join(directory, 'http.json');
    const httpBefore = await seedJsonRestoreDestination(httpDestination, `http-kept-${redactedMode}`);
    const app = await createShadowGraphServer({ file: httpDestination, now: () => '2026-08-28T00:00:00.000Z' });
    const liveBefore = app.graph.exportData();
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: sourceJson })
      });
      const body = await response.json();
      assert.equal(response.status, 400, `${redactedMode}: HTTP must reject`);
      assert.match(body.error, rejection);
      assert.deepEqual(app.graph.exportData(), liveBefore, `${redactedMode}: HTTP live graph stays unchanged`);
      assert.deepEqual(await readFile(httpDestination), httpBefore, `${redactedMode}: HTTP bytes stay unchanged`);
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
    }

    const mcpDestination = join(directory, 'mcp.json');
    const mcpBefore = await seedJsonRestoreDestination(mcpDestination, `mcp-kept-${redactedMode}`);
    const rpc = startRestoreMcp(mcpDestination);
    try {
      await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const response = await rpc.call({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'shadowgraph_restore', arguments: { source: sourceJson } }
      });
      assert.ok(response.error, `${redactedMode}: MCP must reject`);
      assert.match(response.error.message, rejection);
      assert.deepEqual(await readFile(mcpDestination), mcpBefore, `${redactedMode}: MCP bytes stay unchanged`);
    } finally {
      await rpc.stop();
    }
  }
});

test('P1 premerge expiration slice: effective expiration cannot precede validFrom or mutate fact state', () => {
  const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
  graph.addFact({
    id: 'expiration-original', project: 'premerge-expiration', key: 'window', value: 'original',
    idempotencyKey: 'original-retry'
  });
  const before = graph.exportData();
  assert.throws(
    () => graph.addFact({
      id: 'expiration-invalid', project: 'premerge-expiration', key: 'window', value: 'must-not-land',
      validFrom: '2026-08-28T00:00:10.000Z',
      expiresAt: '2026-08-28T00:00:05.000Z',
      idempotencyKey: 'invalid-retry'
    }),
    /effective expiration boundary.*(?:precede|before).*validFrom/i
  );
  assert.deepEqual(graph.exportData(), before, 'interval rejection must precede fact, journal, event, and idempotency mutation');

  const equalBoundary = graph.addFact({
    id: 'expiration-equal', project: 'premerge-expiration', key: 'equal-window', value: 'instantaneous',
    validFrom: '2026-08-28T00:00:10.000Z',
    expiresAt: '2026-08-28T00:00:10.000Z'
  });
  assert.equal(equalBoundary.validityPolicy.effectiveExpirationBoundary, equalBoundary.temporal.validFrom);

  const persisted = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
  persisted.addFact({
    id: 'persisted-invalid-interval', project: 'premerge-expiration', key: 'persisted-window', value: true,
    validFrom: '2026-08-28T00:00:10.000Z', expiresAt: '2026-08-28T00:00:20.000Z'
  });
  const payload = persisted.exportData();
  const contradict = (fact) => {
    fact.expiresAt = '2026-08-28T00:00:05.000Z';
    fact.validityPolicy.declaredExpiresAt = fact.expiresAt;
    fact.validityPolicy.effectiveExpirationBoundary = fact.expiresAt;
  };
  contradict(payload.facts[0]);
  contradict(payload.journal.find((entry) => entry.type === 'fact.observed').payload);
  const restarted = createShadowGraph();
  assert.throws(
    () => restarted.importData(payload),
    /effective expiration boundary.*(?:precede|before).*validFrom/i,
    'schema-5 persisted intervals must fail import/restart validation'
  );
});

function graphAtPurgeSequenceLimit(mode) {
  const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
  const decision = graph.addDecision({
    id: `overflow-decision-${mode}`,
    project: 'premerge-overflow',
    title: 'Atomic purge target',
    chosen: 'preserve everything on failure',
    alternatives: [{ id: `overflow-alternative-${mode}`, label: 'Alternative identity' }],
    idempotencyKey: `decision-retry-${mode}`
  });
  const fact = graph.addFact({
    id: `overflow-fact-${mode}`,
    project: 'premerge-overflow',
    key: 'atomic-purge-fact',
    value: mode,
    idempotencyKey: `fact-retry-${mode}`
  });
  graph.link({ id: `overflow-relation-${mode}`, from: decision.id, to: fact.id, relation: 'depends_on' });
  graph.addDecision({ id: `overflow-kept-${mode}`, project: 'premerge-kept', title: 'Unrelated state', chosen: 'keep' });
  graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER });
  return graph;
}

test('P1 journal atomicity exact reproductions: addDecision and superseding addFact cannot mutate before sequence overflow', () => {
  {
    const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
    graph.addDecision({ id: 'overflow-existing-decision', project: 'atomicity', title: 'Existing', chosen: 'preserve' });
    graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER });
    const before = graph.exportData();
    assert.throws(
      () => graph.addDecision({ id: 'overflow-new-decision', project: 'atomicity', title: 'Must not land', chosen: 'reject' }),
      /journal sequence overflow/i
    );
    assert.deepEqual(graph.exportData(), before, 'addDecision overflow must not leave a record or breadcrumb event');
  }

  {
    const graph = createShadowGraph({ now: () => '2026-08-28T00:00:00.000Z' });
    graph.addFact({ id: 'overflow-original-fact', project: 'atomicity', key: 'supersession', value: 'original' });
    graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER });
    const before = graph.exportData();
    assert.throws(
      () => graph.addFact({ id: 'overflow-replacement-fact', project: 'atomicity', key: 'supersession', value: 'must-not-land' }),
      /journal sequence overflow/i
    );
    assert.deepEqual(graph.exportData(), before, 'addFact overflow must not supersede or narrow the original fact');
  }
});

const ATOMIC_NOW = '2026-08-28T00:00:00.000Z';
const ATOMIC_LATER = '2026-08-29T00:00:00.000Z';

function atomicGraph() {
  return createShadowGraph({ now: () => ATOMIC_NOW });
}

const JOURNAL_MUTATOR_CASES = [
  {
    name: 'addDecision ADD', required: 1,
    build() { const graph = atomicGraph(); return { graph, invoke: () => graph.addDecision({ id: 'matrix-decision', project: 'matrix', title: 'Decision', chosen: 'A' }) }; }
  },
  {
    name: 'addAttempt ADD', required: 1,
    build() { const graph = atomicGraph(); return { graph, invoke: () => graph.addAttempt({ id: 'matrix-attempt', project: 'matrix', solution: 'Try', result: 'Failed safely' }) }; }
  },
  {
    name: 'remember ADD', required: 1,
    build() { const graph = atomicGraph(); return { graph, invoke: () => graph.remember({ id: 'matrix-memory-add', project: 'matrix', scope: {}, memoryType: 'note', key: 'add', text: 'add' }) }; }
  },
  {
    name: 'remember UPDATE', required: 2,
    build() {
      const graph = atomicGraph();
      graph.remember({ id: 'matrix-memory-old', project: 'matrix', scope: {}, memoryType: 'note', key: 'update', text: 'old' });
      return { graph, invoke: () => graph.remember({ id: 'matrix-memory-new', project: 'matrix', scope: {}, memoryType: 'note', key: 'update', text: 'new' }) };
    }
  },
  {
    name: 'remember index refresh', required: 1,
    build() {
      const graph = atomicGraph();
      graph.remember({ id: 'matrix-memory-index', project: 'matrix', scope: {}, memoryType: 'note', key: 'index', text: 'same' });
      return { graph, invoke: () => graph.remember({ project: 'matrix', scope: {}, memoryType: 'note', key: 'index', text: 'same', embedding: [0.1, 0.2] }) };
    }
  },
  {
    name: 'applyMemoryPlan mixed batch', required: 4,
    build() {
      const graph = atomicGraph();
      graph.remember({ id: 'matrix-plan-update-old', project: 'matrix', scope: {}, memoryType: 'note', key: 'update', text: 'old' });
      graph.remember({ id: 'matrix-plan-delete', project: 'matrix', scope: {}, memoryType: 'note', key: 'delete', text: 'delete' });
      return {
        graph,
        invoke: () => graph.applyMemoryPlan({ project: 'matrix', scope: {}, operations: [
          { action: 'ADD', id: 'matrix-plan-add', memoryType: 'note', key: 'add', text: 'add' },
          { action: 'UPDATE', id: 'matrix-plan-update-new', memoryType: 'note', key: 'update', text: 'new' },
          { action: 'DELETE', memoryType: 'note', key: 'delete' },
          { action: 'NOOP', memoryType: 'note', key: 'noop' }
        ] })
      };
    }
  },
  {
    name: 'applyMemoryPlan index refresh followed by same-key content update', required: 3,
    build() {
      const graph = atomicGraph();
      graph.remember({ id: 'matrix-plan-index-old', project: 'matrix', scope: {}, memoryType: 'note', key: 'index-then-update', text: 'old' });
      return {
        graph,
        invoke: () => graph.applyMemoryPlan({ project: 'matrix', scope: {}, operations: [
          { action: 'UPDATE', memoryType: 'note', key: 'index-then-update', text: 'old', embedding: [0.1], idempotencyKey: 'same-key' },
          { action: 'UPDATE', id: 'matrix-plan-index-new', memoryType: 'note', key: 'index-then-update', text: 'new', idempotencyKey: 'same-key' }
        ] })
      };
    }
  },
  {
    name: 'addFact ADD', required: 1,
    build() { const graph = atomicGraph(); return { graph, invoke: () => graph.addFact({ id: 'matrix-fact-add', project: 'matrix', key: 'add', value: 1 }) }; }
  },
  {
    name: 'addFact supersession', required: 2,
    build() {
      const graph = atomicGraph();
      graph.addFact({ id: 'matrix-fact-old', project: 'matrix', key: 'update', value: 'old' });
      return { graph, invoke: () => graph.addFact({ id: 'matrix-fact-new', project: 'matrix', key: 'update', value: 'new' }) };
    }
  },
  {
    name: 'setOutcome with confidence contribution', required: 2,
    build() {
      const graph = atomicGraph();
      const decision = graph.addDecision({ id: 'matrix-outcome', project: 'matrix', title: 'Outcome', chosen: 'A' });
      return { graph, invoke: () => graph.setOutcome(decision.id, { status: 'successful', sourceClass: 'agent_claimed', observedAt: ATOMIC_NOW }) };
    }
  },
  {
    name: 'setOutcome unknown without confidence contribution', required: 1,
    build() {
      const graph = atomicGraph();
      const decision = graph.addDecision({ id: 'matrix-outcome-unknown', project: 'matrix', title: 'Unknown outcome', chosen: 'A' });
      return { graph, invoke: () => graph.setOutcome(decision.id, { status: 'unknown', sourceClass: 'agent_claimed', observedAt: ATOMIC_NOW }) };
    }
  },
  {
    name: 'addConfidenceEvidence changed', required: 1,
    build() {
      const graph = atomicGraph();
      const decision = graph.addDecision({ id: 'matrix-confidence', project: 'matrix', title: 'Confidence', chosen: 'A' });
      return { graph, invoke: () => graph.addConfidenceEvidence({ decisionId: decision.id, key: 'matrix-evidence', reason: 'Evidence' }) };
    }
  },
  {
    name: 'updateDecisionStatus transition', required: 1,
    build() {
      const graph = atomicGraph();
      const decision = graph.addDecision({ id: 'matrix-status', project: 'matrix', title: 'Status', chosen: 'A' });
      return { graph, invoke: () => graph.updateDecisionStatus(decision.id, 'planned') };
    }
  },
  {
    name: 'link relation', required: 1,
    build() {
      const graph = atomicGraph();
      const from = graph.addDecision({ id: 'matrix-link-from', project: 'matrix', title: 'From', chosen: 'A' });
      const to = graph.addDecision({ id: 'matrix-link-to', project: 'matrix', title: 'To', chosen: 'B' });
      return { graph, invoke: () => graph.link({ id: 'matrix-link', from: from.id, to: to.id, relation: 'depends_on' }) };
    }
  },
  {
    name: 'supersedeDecision relation and causation chain', required: 3,
    build() {
      const graph = atomicGraph();
      const previous = graph.addDecision({ id: 'matrix-supersede-old', project: 'matrix', title: 'Old', chosen: 'A' });
      const replacement = graph.addDecision({ id: 'matrix-supersede-new', project: 'matrix', title: 'New', chosen: 'B' });
      return { graph, invoke: () => graph.supersedeDecision({ decisionId: previous.id, replacementId: replacement.id }) };
    }
  },
  {
    name: 'maintain lifecycle batch', required: 4,
    build() {
      const graph = atomicGraph();
      graph.addDecision({ id: 'matrix-maintain-decision-a', project: 'matrix', title: 'Due A', chosen: 'A', reviewAfter: ATOMIC_NOW });
      graph.addDecision({ id: 'matrix-maintain-decision-b', project: 'matrix', title: 'Due B', chosen: 'B', reviewAfter: ATOMIC_NOW });
      graph.addFact({ id: 'matrix-maintain-fact-a', project: 'matrix', key: 'due-a', value: 1, expiresAt: ATOMIC_NOW });
      graph.addFact({ id: 'matrix-maintain-fact-b', project: 'matrix', key: 'due-b', value: 2, expiresAt: ATOMIC_NOW });
      return { graph, invoke: () => graph.maintain({ now: ATOMIC_LATER }) };
    }
  }
];

test('P1 journal reservation matrix: every journal-writing public mutator has exact near-boundary success and atomic overflow', () => {
  for (const scenario of JOURNAL_MUTATOR_CASES) {
    const success = scenario.build();
    success.graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER - scenario.required });
    const successBefore = success.graph.exportData();
    assert.doesNotThrow(success.invoke, `${scenario.name}: exact reservation should succeed`);
    const successAfter = success.graph.exportData();
    assert.equal(successAfter.journal.length - successBefore.journal.length, scenario.required, `${scenario.name}: journal entry inventory`);
    assert.equal(successAfter.journalSeq, Number.MAX_SAFE_INTEGER, `${scenario.name}: final reserved sequence`);

    const failure = scenario.build();
    failure.graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER - scenario.required + 1 });
    const failureBefore = failure.graph.exportData();
    assert.throws(failure.invoke, /journal sequence overflow/i, `${scenario.name}: insufficient reservation must reject`);
    assert.deepEqual(failure.graph.exportData(), failureBefore, `${scenario.name}: rejection must preserve exportData byte-for-byte`);
  }
});

function importDeltaAtSequence(sequence) {
  const seed = atomicGraph();
  const decision = seed.addDecision({ id: 'matrix-import-decision', project: 'matrix', title: 'Old import title', chosen: 'A' });
  const envelope = seed.exportData();
  envelope.journal[0].seq = sequence;
  envelope.journalSeq = sequence;
  envelope.journalEpoch = sequence;
  const graph = atomicGraph();
  graph.importData(envelope);

  const factSource = atomicGraph();
  const fact = factSource.addFact({ id: 'matrix-import-fact', project: 'matrix', key: 'imported', value: true });
  return {
    graph,
    invoke: () => graph.importData({
      schemaVersion: 5,
      records: [{ ...decision, title: 'New import title' }],
      facts: [fact],
      events: [{ id: 'matrix-import-event', type: 'legacy.custom', at: ATOMIC_NOW, project: 'matrix' }]
    })
  };
}

test('P1 causation reservation: near-boundary multi-entry operations retain deterministic order, causation IDs, and epoch', () => {
  {
    const graph = atomicGraph();
    const decision = graph.addDecision({ id: 'causation-outcome', project: 'matrix', title: 'Outcome', chosen: 'A' });
    const epoch = graph.exportData().journalEpoch;
    graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER - 2 });
    graph.setOutcome(decision.id, { status: 'successful', observedAt: ATOMIC_NOW });
    const after = graph.exportData();
    const entries = after.journal.slice(-2);
    assert.deepEqual(entries.map((entry) => [entry.seq, entry.type]), [
      [Number.MAX_SAFE_INTEGER - 1, 'outcome.recorded'],
      [Number.MAX_SAFE_INTEGER, 'confidence.changed']
    ]);
    assert.equal(entries[1].causationId, entries[0].id);
    assert.equal(after.journalEpoch, epoch);
  }

  {
    const graph = atomicGraph();
    const previous = graph.addDecision({ id: 'causation-old', project: 'matrix', title: 'Old', chosen: 'A' });
    const replacement = graph.addDecision({ id: 'causation-new', project: 'matrix', title: 'New', chosen: 'B' });
    const epoch = graph.exportData().journalEpoch;
    graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER - 3 });
    graph.supersedeDecision({ decisionId: previous.id, replacementId: replacement.id });
    const after = graph.exportData();
    const entries = after.journal.slice(-3);
    assert.deepEqual(entries.map((entry) => [entry.seq, entry.type]), [
      [Number.MAX_SAFE_INTEGER - 2, 'relation.created'],
      [Number.MAX_SAFE_INTEGER - 1, 'decision.superseded'],
      [Number.MAX_SAFE_INTEGER, 'decision.recorded']
    ]);
    assert.equal(entries[2].causationId, entries[1].id);
    assert.equal(after.journalEpoch, epoch);
  }
});

test('P1 import-generated delta reservation: multi-entry import succeeds at the exact boundary or changes nothing', () => {
  const required = 3;
  const success = importDeltaAtSequence(Number.MAX_SAFE_INTEGER - required);
  const successBefore = success.graph.exportData();
  assert.doesNotThrow(success.invoke);
  const successAfter = success.graph.exportData();
  assert.equal(successAfter.journal.length - successBefore.journal.length, required);
  assert.deepEqual(successAfter.journal.slice(-required).map((entry) => entry.seq), [
    Number.MAX_SAFE_INTEGER - 2,
    Number.MAX_SAFE_INTEGER - 1,
    Number.MAX_SAFE_INTEGER
  ]);

  const failure = importDeltaAtSequence(Number.MAX_SAFE_INTEGER - required + 1);
  const failureBefore = failure.graph.exportData();
  assert.throws(failure.invoke, /journal sequence overflow/i);
  assert.deepEqual(failure.graph.exportData(), failureBefore);
});

const ZERO_JOURNAL_MUTATOR_CASES = [
  {
    name: 'setRevision',
    build() { const graph = atomicGraph(); return { graph, invoke: () => graph.setRevision(7) }; }
  },
  {
    name: 'replaceData with an already journaled snapshot',
    build() {
      const graph = atomicGraph();
      graph.addDecision({ id: 'zero-replace', project: 'matrix', title: 'Replace', chosen: 'A' });
      return { graph, afterBoundary: () => graph.exportData(), invoke: (snapshot) => graph.replaceData(snapshot) };
    }
  },
  {
    name: 'addDecision idempotent retry',
    build() {
      const graph = atomicGraph();
      const input = { id: 'zero-decision', project: 'matrix', title: 'Decision', chosen: 'A', idempotencyKey: 'retry' };
      graph.addDecision(input);
      return { graph, invoke: () => graph.addDecision({ ...input, title: 'Ignored retry' }) };
    }
  },
  {
    name: 'addAttempt idempotent retry',
    build() {
      const graph = atomicGraph();
      const input = { id: 'zero-attempt', project: 'matrix', solution: 'Try', result: 'Result', idempotencyKey: 'retry' };
      graph.addAttempt(input);
      return { graph, invoke: () => graph.addAttempt({ ...input, result: 'Ignored retry' }) };
    }
  },
  {
    name: 'remember unchanged',
    build() {
      const graph = atomicGraph();
      graph.remember({ id: 'zero-memory', project: 'matrix', scope: {}, memoryType: 'note', key: 'same', text: 'same' });
      return { graph, invoke: () => graph.remember({ project: 'matrix', scope: {}, memoryType: 'note', key: 'same', text: 'same' }) };
    }
  },
  {
    name: 'applyMemoryPlan NOOP batch',
    build() {
      const graph = atomicGraph();
      return { graph, invoke: () => graph.applyMemoryPlan({ project: 'matrix', scope: {}, operations: [{ action: 'NOOP', memoryType: 'note', key: 'none' }] }) };
    }
  },
  {
    name: 'addFact idempotent retry',
    build() {
      const graph = atomicGraph();
      const input = { id: 'zero-fact', project: 'matrix', key: 'fact', value: true, idempotencyKey: 'retry' };
      graph.addFact(input);
      return { graph, invoke: () => graph.addFact({ ...input, value: false }) };
    }
  },
  {
    name: 'addConfidenceEvidence duplicate',
    build() {
      const graph = atomicGraph();
      const decision = graph.addDecision({ id: 'zero-confidence', project: 'matrix', title: 'Confidence', chosen: 'A' });
      const input = { decisionId: decision.id, key: 'same-evidence', reason: 'same', observedAt: ATOMIC_NOW };
      graph.addConfidenceEvidence(input);
      return { graph, invoke: () => graph.addConfidenceEvidence(input) };
    }
  },
  {
    name: 'updateDecisionStatus same status',
    build() {
      const graph = atomicGraph();
      const decision = graph.addDecision({ id: 'zero-status', project: 'matrix', title: 'Status', chosen: 'A' });
      return { graph, invoke: () => graph.updateDecisionStatus(decision.id, 'proposed') };
    }
  },
  {
    name: 'supersedeDecision idempotent retry',
    build() {
      const graph = atomicGraph();
      const previous = graph.addDecision({ id: 'zero-supersede-old', project: 'matrix', title: 'Old', chosen: 'A' });
      const replacement = graph.addDecision({ id: 'zero-supersede-new', project: 'matrix', title: 'New', chosen: 'B' });
      graph.supersedeDecision({ decisionId: previous.id, replacementId: replacement.id });
      return { graph, invoke: () => graph.supersedeDecision({ decisionId: previous.id, replacementId: replacement.id }) };
    }
  },
  {
    name: 'review signal creation',
    build() {
      const graph = atomicGraph();
      graph.addDecision({
        id: 'zero-review', project: 'matrix', title: 'Review', chosen: 'A',
        alternatives: [{ id: 'zero-review-alt', label: 'B', reopenWhen: ['changed'] }]
      });
      return { graph, invoke: () => graph.review({ project: 'matrix', changedFacts: ['changed'] }) };
    }
  },
  {
    name: 'context signal creation',
    build() {
      const graph = atomicGraph();
      graph.addDecision({
        id: 'zero-context', project: 'matrix', title: 'Context', chosen: 'A',
        alternatives: [{ id: 'zero-context-alt', label: 'B', reopenWhen: ['changed'] }]
      });
      return { graph, invoke: () => graph.context({ project: 'matrix', changedFacts: ['changed'] }) };
    }
  },
  {
    name: 'maintain with no lifecycle transitions',
    build() { const graph = atomicGraph(); return { graph, invoke: () => graph.maintain({ now: ATOMIC_LATER }) }; }
  },
  {
    name: 'acknowledgeReview',
    build() {
      const graph = atomicGraph();
      graph.addDecision({
        id: 'zero-ack', project: 'matrix', title: 'Ack', chosen: 'A',
        alternatives: [{ id: 'zero-ack-alt', label: 'B', reopenWhen: ['changed'] }]
      });
      graph.review({ project: 'matrix', changedFacts: ['changed'] });
      const signal = graph.getReviewSignals()[0];
      return { graph, invoke: () => graph.acknowledgeReview(signal.id) };
    }
  },
  {
    name: 'importData semantic NOOP',
    build() {
      const graph = atomicGraph();
      const decision = graph.addDecision({ id: 'zero-import', project: 'matrix', title: 'Import', chosen: 'A' });
      return { graph, invoke: () => graph.importData({ schemaVersion: 5, records: [decision] }) };
    }
  }
];

test('P1 zero-entry mutator inventory: journal-free public mutation paths remain available at MAX_SAFE_INTEGER', () => {
  for (const scenario of ZERO_JOURNAL_MUTATOR_CASES) {
    const { graph, invoke, afterBoundary } = scenario.build();
    graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER });
    const argument = afterBoundary?.();
    const before = graph.exportData();
    assert.doesNotThrow(() => invoke(argument), `${scenario.name}: zero-entry path must not reserve a sequence`);
    const after = graph.exportData();
    assert.equal(after.journal.length, before.journal.length, `${scenario.name}: zero journal entries`);
    assert.equal(after.journalSeq, Number.MAX_SAFE_INTEGER, `${scenario.name}: high-water mark stays exact`);
  }
});

test('P1 verifyFact reservation: one-entry commit reaches MAX_SAFE_INTEGER and identical retry needs zero entries', async () => {
  const verifier = {
    async verify({ fact }) { return { factId: fact.id, verifierIdentity: 'matrix-verifier' }; },
    validateStored() { return true; }
  };
  const graph = createShadowGraph({ now: () => ATOMIC_NOW, verifier });
  const fact = graph.addFact({ id: 'matrix-verify', project: 'matrix', key: 'verify', value: true });
  graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER - 1 });
  const before = graph.exportData();
  const verified = await graph.verifyFact({ factId: fact.id, evidencePath: 'trusted.json' });
  assert.equal(verified.operation, 'VERIFIED');
  const after = graph.exportData();
  assert.equal(after.journal.length, before.journal.length + 1);
  assert.equal(after.journal.at(-1).seq, Number.MAX_SAFE_INTEGER);

  const retryBefore = graph.exportData();
  const retry = await graph.verifyFact({ factId: fact.id, evidencePath: 'trusted.json' });
  assert.equal(retry.operation, 'NOOP');
  assert.deepEqual(graph.exportData(), retryBefore);
});

test('P1 purge near-boundary reservation: logical and hard modes commit one exact final sequence', () => {
  for (const mode of ['logical', 'hard']) {
    const graph = atomicGraph();
    graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER - 2 });
    const source = atomicGraph();
    const decision = source.addDecision({ id: `near-purge-${mode}`, project: `near-purge-${mode}`, title: 'Purge', chosen: 'A' });
    graph.importData({ schemaVersion: 5, records: [decision] });
    assert.equal(graph.exportData().journalSeq, Number.MAX_SAFE_INTEGER - 1);
    const result = graph.purgeProject(`near-purge-${mode}`, { mode });
    assert.equal(result.mode, mode);
    assert.equal(graph.exportData().journalSeq, Number.MAX_SAFE_INTEGER);
    assert.equal(graph.exportData().journal.at(-1).type, 'project.purged');
  }
});

test('P1 premerge purge slice: logical and hard purge preserve every collection on journal sequence overflow', () => {
  for (const mode of ['logical', 'hard']) {
    const graph = graphAtPurgeSequenceLimit(mode);
    const before = graph.exportData();
    assert.throws(
      () => graph.purgeProject('premerge-overflow', { mode }),
      /journal sequence overflow/i,
      `${mode}: the marker sequence must be rejected`
    );
    assert.deepEqual(graph.exportData(), before, `${mode}: purge failure must be atomic across all live and audit collections`);
  }
});

function sequenceOverflowPayload(id) {
  const graph = atomicGraph();
  graph.addDecision({ id, project: 'transport-overflow', title: 'Keep persisted state', chosen: 'preserve' });
  graph.importData({ schemaVersion: 5, journal: [], journalSeq: Number.MAX_SAFE_INTEGER });
  return graph.exportData();
}

async function seedOverflowStore(store, id) {
  await store.save(sequenceOverflowPayload(id));
  return store.load();
}

test('P1 journal overflow persistence: JSON/SQLite HTTP plus CLI and MCP reject without changing live or durable state', async () => {
  for (const backend of ['json', 'sqlite']) {
    const directory = await mkdtemp(join(tmpdir(), `shadowgraph-premerge-overflow-http-${backend}-`));
    const destination = join(directory, backend === 'sqlite' ? 'live.db' : 'live.json');
    const store = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
    const durableBefore = await seedOverflowStore(store, `http-${backend}-kept`);
    const app = await createShadowGraphServer({ file: destination, storage: backend, store, now: () => ATOMIC_NOW });
    const liveBefore = app.graph.exportData();
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/decisions`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: `http-${backend}-must-not-land`, project: 'transport-overflow', title: 'Must not land', chosen: 'reject' })
      });
      assert.equal(response.status, 400, `${backend}: HTTP overflow must reject`);
      assert.match((await response.json()).error, /journal sequence overflow/i);
      assert.deepEqual(app.graph.exportData(), liveBefore, `${backend}: HTTP live state`);
      assert.deepEqual(await store.load(), durableBefore, `${backend}: HTTP durable state`);
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
      store.close();
    }
  }

  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-premerge-overflow-transports-'));
  const cliDestination = join(directory, 'cli.json');
  const cliStore = createJsonFileStore(cliDestination);
  await seedOverflowStore(cliStore, 'cli-kept');
  cliStore.close();
  const cliBefore = await readFile(cliDestination);
  const cli = await runCliCommand(cliDestination, 'decision', {
    id: 'cli-must-not-land', project: 'transport-overflow', title: 'Must not land', chosen: 'reject'
  });
  assert.notEqual(cli.code, 0);
  assert.match(cli.stderr, /journal sequence overflow/i);
  assert.deepEqual(await readFile(cliDestination), cliBefore, 'CLI destination bytes');

  const mcpDestination = join(directory, 'mcp.json');
  const mcpStore = createJsonFileStore(mcpDestination);
  await seedOverflowStore(mcpStore, 'mcp-kept');
  mcpStore.close();
  const mcpBefore = await readFile(mcpDestination);
  const rpc = startRestoreMcp(mcpDestination);
  try {
    await rpc.call({ jsonrpc: '2.0', id: 30, method: 'tools/list' });
    const response = await rpc.call({
      jsonrpc: '2.0', id: 31, method: 'tools/call',
      params: {
        name: 'shadowgraph_record_decision',
        arguments: { id: 'mcp-must-not-land', project: 'transport-overflow', title: 'Must not land', chosen: 'reject' }
      }
    });
    assert.ok(response.error);
    assert.match(response.error.message, /journal sequence overflow/i);
    assert.deepEqual(await readFile(mcpDestination), mcpBefore, 'MCP destination bytes');
  } finally {
    await rpc.stop();
  }
});
