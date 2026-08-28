import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { backupFile, restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { rebuildProjection } from '../src/journal.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';

const NOW = '2026-08-27T15:00:00.000Z';
const NODE_SQLITE = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE_TEST_OPTIONS = NODE_SQLITE.available ? {} : { skip: NODE_SQLITE.reason };
const LEGACY_PURGED_ID = 'rrv04-legacy-purged-secret-id';
const LEGACY_PURGED_CONTENT = 'RRV04_LEGACY_PURGED_SECRET_CONTENT';
const RRV06_SECRETS = [
  'RRV06_SECRET_ACTOR',
  'RRV06_SECRET_CLIENT',
  'RRV06_SECRET_SESSION',
  'RRV06_SECRET_CAUSATION',
  'RRV06_SECRET_REQUEST',
  'RRV06_SECRET_USER',
  'RRV06_SECRET_AGENT',
  'RRV06_SECRET_RUN',
  'RRV06_SECRET_IDEMPOTENCY'
];

function legacySchema3PurgeFixture() {
  const secret = {
    id: LEGACY_PURGED_ID,
    kind: 'decision',
    schemaVersion: 3,
    title: LEGACY_PURGED_CONTENT,
    chosen: 'erase',
    status: 'active',
    alternatives: [],
    confidence: 0.5
  };
  const relation = {
    id: 'rrv04-legacy-secret-relation',
    schemaVersion: 3,
    from: 'rrv04-host',
    to: LEGACY_PURGED_ID,
    relation: 'depends_on'
  };
  const kept = {
    id: 'rrv04-import-kept',
    kind: 'decision',
    schemaVersion: 3,
    project: 'rrv04-kept',
    title: 'RRV04 kept import',
    chosen: 'keep',
    status: 'active',
    alternatives: [],
    confidence: 0.5
  };
  return {
    schemaVersion: 3,
    revision: 0,
    records: [kept],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [{
      id: `event-${LEGACY_PURGED_ID}`,
      type: 'decision.recorded',
      at: NOW,
      recordId: LEGACY_PURGED_ID
    }],
    journal: [
      {
        id: 'rrv04-legacy-baseline',
        seq: 2,
        type: 'projection.baseline',
        at: NOW,
        project: null,
        entityKind: null,
        entityId: null,
        schemaVersion: 3,
        payload: {
          records: [secret],
          facts: [],
          relations: [relation],
          idempotency: [{ key: 'decision:legacy-secret-retry', value: secret }]
        },
        provenance: { actor: 'legacy-secret-actor', client: 'legacy-secret-client', sessionId: 'legacy-secret-session' }
      },
      {
        id: 'rrv04-legacy-purge-marker',
        seq: 3,
        type: 'project.purged',
        at: NOW,
        project: 'rrv04-private',
        entityKind: 'project',
        entityId: 'rrv04-private',
        schemaVersion: 3,
        payload: {
          project: 'rrv04-private',
          mode: 'logical',
          removed: 2,
          purgedEntityIds: [LEGACY_PURGED_ID]
        },
        provenance: { actor: 'legacy-purge-actor', client: 'legacy-purge-client', sessionId: 'legacy-purge-session' }
      },
      {
        id: 'rrv04-kept-entry',
        seq: 4,
        type: 'decision.recorded',
        at: NOW,
        project: kept.project,
        entityKind: 'decision',
        entityId: kept.id,
        schemaVersion: 3,
        payload: kept,
        provenance: { actor: null, client: null, sessionId: null }
      }
    ],
    journalSeq: 4,
    journalEpoch: 1
  };
}

function ids(projection) {
  return {
    records: projection.records.map((item) => item.id).sort(),
    facts: projection.facts.map((item) => item.id).sort(),
    relations: projection.relations.map((item) => item.id).sort(),
    idempotency: projection.idempotency.map((item) => item.value.id).sort()
  };
}

function assertLegacySecretAbsent(value, label) {
  const serialized = Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value);
  assert.equal(serialized.includes(LEGACY_PURGED_ID), false, `${label} retained the legacy purged id`);
  assert.equal(serialized.includes(LEGACY_PURGED_CONTENT), false, `${label} retained the legacy purged content`);
}

test('RRV-04: schema-3 raw purge ids are migrated before an unrelated later purge can change rebuild projection', () => {
  for (const laterMode of ['logical', 'hard']) {
    const graph = createShadowGraph({ now: () => NOW });
    graph.addDecision({ id: 'rrv04-host', project: 'rrv04-host-project', title: 'Host', chosen: 'keep' });
    const fixture = legacySchema3PurgeFixture();
    const rawProjection = rebuildProjection(
      [...graph.exportData().journal, ...fixture.journal],
      { journalEpoch: fixture.journalEpoch }
    );
    assert.equal(rawProjection.projection.records.some((item) => item.id === LEGACY_PURGED_ID), false, 'the accepted raw legacy marker removes its id');

    graph.importData(fixture);
    graph.addDecision({
      id: `rrv04-unrelated-${laterMode}`,
      project: `rrv04-unrelated-${laterMode}`,
      title: 'Unrelated later content',
      chosen: 'remove only this'
    });
    graph.purgeProject(`rrv04-unrelated-${laterMode}`, { mode: laterMode });

    const afterSanitization = graph.exportData();
    const rawRebuilt = rebuildProjection(afterSanitization.journal, { journalEpoch: afterSanitization.journalEpoch });
    assert.deepEqual(ids(rawRebuilt.projection), ids(rawProjection.projection), `${laterMode}: sanitization must preserve the pre-sanitization fold`);
    const rebuilt = graph.rebuild();
    assert.equal(rebuilt.rebuildable, laterMode === 'logical');
    assertLegacySecretAbsent(afterSanitization, `${laterMode} live export`);
    assertLegacySecretAbsent(rawRebuilt, `${laterMode} raw rebuild`);
    assertLegacySecretAbsent(rebuilt, `${laterMode} rebuild`);
  }
});

test('RRV-04 / DS-P1-007: every predecessor schema 1-4 raw purge marker is migrated', () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    const graph = createShadowGraph({ now: () => NOW });
    if (schemaVersion < 4) graph.addDecision({ id: 'rrv04-host', project: 'rrv04-host-project', title: 'Host', chosen: 'keep' });
    const fixture = legacySchema3PurgeFixture();
    fixture.schemaVersion = schemaVersion;
    fixture.records = fixture.records.map((item) => ({ ...item, schemaVersion }));
    fixture.journal = fixture.journal.map((entry) => ({ ...entry, schemaVersion }));
    if (schemaVersion === 4) fixture.journalEpoch = 2;
    graph.importData(fixture);
    const exported = graph.exportData();
    assertLegacySecretAbsent(exported, `schema ${schemaVersion} migrated export`);
    assertLegacySecretAbsent(graph.rebuild(), `schema ${schemaVersion} migrated rebuild`);
    assert.equal(exported.journal.find((entry) => entry.id === 'rrv04-legacy-purge-marker').payload.purgedEntityIds, undefined);
  }

  const migratedSchema4 = createShadowGraph({ now: () => NOW });
  migratedSchema4.importData({
    schemaVersion: 4,
    records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [],
    journal: [{
      id: 'rrv04-schema4-unrelated-marker', seq: 1, type: 'project.purged', at: NOW,
      project: 'rrv04-schema4-unrelated', entityKind: 'project', entityId: 'rrv04-schema4-unrelated',
      schemaVersion: 4,
      payload: { project: 'rrv04-schema4-unrelated', mode: 'logical', removed: 1, purgedEntityIds: ['rrv04-do-not-retain'] },
      provenance: { actor: null, client: null, sessionId: null }
    }],
    journalSeq: 1,
    journalEpoch: 1
  });
  migratedSchema4.addDecision({ id: 'rrv04-other', project: 'rrv04-other', title: 'Other', chosen: 'erase' });
  migratedSchema4.purgeProject('rrv04-other', { mode: 'logical' });
  const marker = migratedSchema4.exportData().journal.find((entry) => entry.id === 'rrv04-schema4-unrelated-marker');
  assert.equal(Object.hasOwn(marker.payload, 'purgedEntityIds'), false);
  assert.equal(marker.entityId, null);
});

function assertRrv06SecretsAbsent(value, label) {
  const serialized = Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value);
  for (const secret of RRV06_SECRETS) assert.equal(serialized.includes(secret), false, `${label} retained ${secret}`);
}

function rrv06LogicalPurgeGraph() {
  const seed = createShadowGraph({ now: () => NOW });
  seed.addDecision({
    id: 'rrv06-private-decision',
    project: 'rrv06-private',
    title: 'Private decision',
    chosen: 'erase',
    actor: RRV06_SECRETS[0],
    client: RRV06_SECRETS[1],
    sessionId: RRV06_SECRETS[2],
    idempotencyKey: RRV06_SECRETS[8]
  });
  const payload = seed.exportData();
  Object.assign(payload.journal[0], {
    causationId: RRV06_SECRETS[3],
    requestId: RRV06_SECRETS[4],
    userId: RRV06_SECRETS[5],
    agentId: RRV06_SECRETS[6],
    runId: RRV06_SECRETS[7],
    transition: { actor: RRV06_SECRETS[0], client: RRV06_SECRETS[1], sessionId: RRV06_SECRETS[2] }
  });
  Object.assign(payload.events[0], {
    actor: RRV06_SECRETS[0],
    client: RRV06_SECRETS[1],
    sessionId: RRV06_SECRETS[2],
    requestId: RRV06_SECRETS[4]
  });
  const graph = createShadowGraph({ now: () => NOW });
  graph.replaceData(payload);
  graph.purgeProject('rrv06-private', { mode: 'logical' });
  return graph;
}

test('RRV-06: logical purge retains only non-identifying audit skeleton fields and null provenance', () => {
  const graph = rrv06LogicalPurgeGraph();
  const live = graph.exportData();
  const skeletons = live.journal.filter((entry) => entry.redactedReason === 'project_purged');
  assert.equal(skeletons.length, 1);
  const allowedFields = new Set([
    'id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId', 'schemaVersion',
    'payload', 'replayable', 'originalType', 'redacted', 'redactedReason', 'provenance'
  ]);
  for (const skeleton of skeletons) {
    assert.deepEqual(skeleton.provenance, { actor: null, client: null, sessionId: null });
    assert.deepEqual(Object.keys(skeleton).filter((key) => !allowedFields.has(key)), []);
    assert.equal(skeleton.entityId, null);
    assert.equal(skeleton.payload, null);
  }
  assert.equal(live.events.length, 0);
  assert.equal(live.idempotency.length, 0);
  assertRrv06SecretsAbsent(live, 'logical purge live export');
  assertRrv06SecretsAbsent(graph.getJournal({ limit: 1000 }), 'logical purge journal');
  assertRrv06SecretsAbsent(graph.redact({ project: 'rrv06-private' }), 'logical purge redaction');
  assertRrv06SecretsAbsent(graph.rebuild(), 'logical purge rebuild');
});

async function createStore(backend, path) {
  return backend === 'sqlite' ? createSqliteStore(path) : createJsonFileStore(path);
}

async function assertPayloadAcrossRestartBackupRestore(t, payload, assertSafe, label) {
  for (const backend of ['json', 'sqlite']) {
    await t.test(`${label} ${backend}`, backend === 'sqlite' ? SQLITE_TEST_OPTIONS : {}, async () => {
      const directory = await mkdtemp(join(tmpdir(), `shadowgraph-third-review-${backend}-`));
      const extension = backend === 'sqlite' ? 'db' : 'json';
      const livePath = join(directory, `live.${extension}`);
      const backupPath = join(directory, `backup.${extension}`);
      const destinationPath = join(directory, `destination.${extension}`);

      let liveStore = await createStore(backend, livePath);
      await liveStore.save(payload);
      assertSafe(await readFile(livePath), `${label} ${backend} live bytes`);
      await backupFile(livePath, backupPath, { store: liveStore });
      liveStore.close();
      assertSafe(await readFile(backupPath), `${label} ${backend} backup bytes`);

      liveStore = await createStore(backend, livePath);
      const reopened = await liveStore.load();
      liveStore.close();
      assertSafe(reopened, `${label} ${backend} reopened`);
      assert.doesNotThrow(() => validateRestorePayload(reopened, { now: () => NOW }));

      let destinationStore = await createStore(backend, destinationPath);
      const old = createShadowGraph({ now: () => NOW });
      old.addDecision({ id: `${label}-${backend}-old`, project: 'old', title: 'Old', chosen: 'replace' });
      await destinationStore.save(old.exportData());
      if (backend === 'sqlite') {
        await destinationStore.restore(backupPath);
      } else {
        destinationStore.close();
        await restoreFile(backupPath, destinationPath);
        destinationStore = await createStore(backend, destinationPath);
      }
      const restored = await destinationStore.load();
      destinationStore.close();
      assertSafe(restored, `${label} ${backend} restored`);
      assertSafe(await readFile(destinationPath), `${label} ${backend} restored bytes`);
      assert.doesNotThrow(() => validateRestorePayload(restored, { now: () => NOW }));
    });
  }
}

test('RRV-04: migrated schema-3 purge stays erased through JSON/SQLite restart, backup, and restore', async (t) => {
  for (const laterMode of ['logical', 'hard']) {
    const graph = createShadowGraph({ now: () => NOW });
    graph.addDecision({ id: 'rrv04-host', project: 'rrv04-host-project', title: 'Host', chosen: 'keep' });
    graph.importData(legacySchema3PurgeFixture());
    graph.addDecision({
      id: `rrv04-persist-unrelated-${laterMode}`,
      project: `rrv04-persist-unrelated-${laterMode}`,
      title: 'Unrelated persisted content',
      chosen: 'remove only this'
    });
    graph.purgeProject(`rrv04-persist-unrelated-${laterMode}`, { mode: laterMode });
    const payload = graph.exportData();
    assertLegacySecretAbsent(payload, `${laterMode} pre-persist export`);
    assertLegacySecretAbsent(graph.rebuild(), `${laterMode} pre-persist rebuild`);
    await assertPayloadAcrossRestartBackupRestore(t, payload, assertLegacySecretAbsent, `rrv04-${laterMode}`);
  }
});

test('RRV-06: logical purge identity metadata stays scrubbed through JSON/SQLite restart, backup, restore, redaction, and rebuild', async (t) => {
  const graph = rrv06LogicalPurgeGraph();
  const payload = graph.exportData();
  assertRrv06SecretsAbsent(payload, 'RRV-06 pre-persist export');
  assertRrv06SecretsAbsent(graph.redact({ project: 'rrv06-private' }), 'RRV-06 pre-persist redaction');
  assertRrv06SecretsAbsent(graph.rebuild(), 'RRV-06 pre-persist rebuild');
  await assertPayloadAcrossRestartBackupRestore(t, payload, assertRrv06SecretsAbsent, 'rrv06-logical');
});

function forgedFutureLedgerPayload() {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ id: 'rrv07-kept-before', project: 'rrv07-kept', title: 'Before', chosen: 'keep' });
  graph.addDecision({ id: 'rrv07-kept-after', project: 'rrv07-kept', title: 'After', chosen: 'keep' });
  const payload = graph.exportData();
  payload.journal[1].seq = 4;
  payload.journal.splice(1, 0, {
    id: 'rrv07-forged-early-marker',
    seq: 2,
    type: 'project.purged',
    at: NOW,
    project: 'rrv07-unrelated',
    entityKind: 'project',
    entityId: null,
    schemaVersion: 5,
    payload: {
      project: 'rrv07-unrelated',
      mode: 'hard',
      removed: 0,
      removedJournalSequences: [3]
    },
    provenance: { actor: null, client: null, sessionId: null }
  });
  payload.journalSeq = 4;
  payload.journalEpoch = 1;
  return payload;
}

test('RRV-07: an earlier hard-purge marker cannot authorize a future missing sequence', () => {
  const payload = forgedFutureLedgerPayload();
  const target = createShadowGraph({ now: () => NOW });
  const before = target.exportData();
  assert.throws(() => target.importData(payload), /removedJournalSequences|hard purge ledger|earlier than/i);
  assert.deepEqual(target.exportData(), before, 'rejected direct import must be atomic');

  const replacement = createShadowGraph({ now: () => NOW });
  replacement.addDecision({ id: 'rrv07-old-live', project: 'old', title: 'Old', chosen: 'keep' });
  const replacementBefore = replacement.exportData();
  assert.throws(() => replacement.replaceData(payload), /removedJournalSequences|hard purge ledger|earlier than/i);
  assert.deepEqual(replacement.exportData(), replacementBefore, 'rejected replacement must be atomic');
  assert.throws(() => validateRestorePayload(payload, { now: () => NOW }), /removedJournalSequences|hard purge ledger|earlier than/i);
});

function validInternalGapPayload() {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ id: 'rrv07-internal-before', project: 'rrv07-kept', title: 'Before', chosen: 'keep' });
  graph.addDecision({ id: 'rrv07-internal-gone', project: 'rrv07-gone', title: 'Gone', chosen: 'erase' });
  graph.addDecision({ id: 'rrv07-internal-after', project: 'rrv07-kept', title: 'After', chosen: 'keep' });
  graph.purgeProject('rrv07-gone', { mode: 'hard' });
  return graph.exportData();
}

test('RRV-07: ledger values are positive safe unique actual gaps and every gap is covered', () => {
  const cases = [
    { label: 'zero', ledger: [0], pattern: /positive safe integers/i },
    { label: 'negative', ledger: [-1], pattern: /positive safe integers/i },
    { label: 'fractional', ledger: [1.5], pattern: /positive safe integers/i },
    { label: 'unsafe', ledger: [Number.MAX_SAFE_INTEGER + 1], pattern: /positive safe integers/i },
    { label: 'duplicate', ledger: [2, 2], pattern: /duplicate removedJournalSequences/i },
    { label: 'present unrelated sequence', ledger: [1, 2], pattern: /not an actual missing journal sequence/i },
    { label: 'uncovered gap', ledger: [], pattern: /does not explain journal sequence 2/i }
  ];
  for (const { label, ledger, pattern } of cases) {
    const payload = validInternalGapPayload();
    payload.journal.find((entry) => entry.type === 'project.purged').payload.removedJournalSequences = ledger;
    const graph = createShadowGraph({ now: () => NOW });
    assert.throws(() => graph.importData(payload), pattern, label);
    assert.throws(() => validateRestorePayload(payload, { now: () => NOW }), pattern, label);
  }
});

test('RRV-07: real leading/internal gaps and transitive later same-project hard purges remain accepted', () => {
  const accepted = [validInternalGapPayload()];

  const leading = createShadowGraph({ now: () => NOW });
  leading.addDecision({ id: 'rrv07-leading-gone', project: 'rrv07-leading', title: 'Gone first', chosen: 'erase' });
  leading.addDecision({ id: 'rrv07-leading-kept', project: 'rrv07-kept', title: 'Kept second', chosen: 'keep' });
  leading.purgeProject('rrv07-leading', { mode: 'hard' });
  accepted.push(leading.exportData());

  const transitive = createShadowGraph({ now: () => NOW });
  transitive.addDecision({ id: 'rrv07-transitive-gone', project: 'rrv07-transitive', title: 'Gone', chosen: 'erase' });
  transitive.purgeProject('rrv07-transitive', { mode: 'hard' });
  transitive.purgeProject('rrv07-transitive', { mode: 'hard' });
  accepted.push(transitive.exportData());

  for (const payload of accepted) {
    const graph = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => graph.importData(payload));
    assert.doesNotThrow(() => validateRestorePayload(payload, { now: () => NOW }));
  }
});

test('RRV-07: an enormous uncovered range is rejected by bounded arithmetic at its first missing sequence', () => {
  const payload = validInternalGapPayload();
  const marker = payload.journal.find((entry) => entry.type === 'project.purged');
  const later = payload.journal.find((entry) => entry.type !== 'project.purged' && entry.seq === 3);
  later.seq = Number.MAX_SAFE_INTEGER - 1;
  marker.seq = Number.MAX_SAFE_INTEGER;
  marker.payload.removedJournalSequences = [2];
  payload.journalSeq = Number.MAX_SAFE_INTEGER;
  assert.throws(
    () => validateRestorePayload(payload, { now: () => NOW }),
    /does not explain journal sequence 3/i
  );
});

function runCli(file, command, argument) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', command, argument], {
      cwd: process.cwd(),
      env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' },
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

function startMcp(file) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const pending = new Map();
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
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

test('RRV-07: forged future ledgers fail closed in JSON/SQLite restore and CLI/HTTP/MCP', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-rrv07-surfaces-'));
  const payload = forgedFutureLedgerPayload();
  const sourceJson = join(directory, 'forged.json');
  await writeFile(sourceJson, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const old = createShadowGraph({ now: () => NOW });
  old.addDecision({ id: 'rrv07-surface-old', project: 'old', title: 'Old', chosen: 'keep' });

  await t.test('direct JSON restore', async () => {
    const destination = join(directory, 'direct-live.json');
    const store = createJsonFileStore(destination);
    await store.save(old.exportData());
    store.close();
    const before = await readFile(destination);
    await assert.rejects(restoreFile(sourceJson, destination), /strictly earlier than/i);
    assert.deepEqual(await readFile(destination), before);
  });

  await t.test('direct SQLite restore', SQLITE_TEST_OPTIONS, async () => {
    const source = join(directory, 'forged.db');
    const destination = join(directory, 'direct-live.db');
    const sourceStore = await createSqliteStore(source);
    await sourceStore.save(payload);
    sourceStore.close();
    const destinationStore = await createSqliteStore(destination);
    await destinationStore.save(old.exportData());
    const before = await destinationStore.load();
    await assert.rejects(destinationStore.restore(source), /strictly earlier than/i);
    assert.deepEqual(await destinationStore.load(), before);
    destinationStore.close();
  });

  await t.test('CLI JSON restore', async () => {
    const destination = join(directory, 'cli-live.json');
    const store = createJsonFileStore(destination);
    await store.save(old.exportData());
    store.close();
    const before = await readFile(destination);
    const result = await runCli(destination, 'restore', sourceJson);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /strictly earlier than/i);
    assert.deepEqual(await readFile(destination), before);
  });

  await t.test('HTTP JSON restore', async () => {
    const destination = join(directory, 'http-live.json');
    const store = createJsonFileStore(destination);
    await store.save(old.exportData());
    store.close();
    const before = await readFile(destination);
    const app = await createShadowGraphServer({ file: destination, now: () => NOW });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: sourceJson })
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /strictly earlier than/i);
      assert.deepEqual(await readFile(destination), before);
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
    }
  });

  await t.test('MCP JSON restore', async () => {
    const destination = join(directory, 'mcp-live.json');
    const store = createJsonFileStore(destination);
    await store.save(old.exportData());
    store.close();
    const before = await readFile(destination);
    const rpc = startMcp(destination);
    try {
      await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const response = await rpc.call({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'shadowgraph_restore', arguments: { source: sourceJson } }
      });
      assert.equal(response.result, undefined, 'legacy tool failures use the numeric JSON-RPC error form');
      assert.deepEqual(response.error, { code: -32000, message: 'Tool execution failed' });
      const publicFailure = JSON.stringify(response);
      assert.equal(publicFailure.includes(sourceJson), false, 'MCP failure disclosed the forged source path');
      assert.equal(publicFailure.includes(destination), false, 'MCP failure disclosed the storage path');
      assert.equal(publicFailure.includes('rrv07-forged-early-marker'), false, 'MCP failure disclosed the forged ledger id');
      assert.equal(publicFailure.includes('strictly earlier than'), false, 'MCP failure disclosed the raw ledger diagnostic');
      assert.deepEqual(await readFile(destination), before);
    } finally {
      await rpc.stop();
    }
  });
});
