import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backupFile, restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { journalGaps, rebuildProjection } from '../src/journal.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-08-28T00:00:00.000Z';
const RAW_ID = 'DS_P1_007_RAW_PURGED_ENTITY_SENTINEL';
const RAW_ALT_ID = 'DS_P1_007_RAW_PURGED_ALTERNATIVE_SENTINEL';
const RAW_FACT_ID = 'DS_P1_007_RAW_PURGED_FACT_SENTINEL';
const RAW_RELATION_ID = 'DS_P1_007_RAW_PURGED_RELATION_SENTINEL';
const RAW_EVENT_ID = 'DS_P1_007_RAW_PURGED_EVENT_SENTINEL';
const BASELINE_METADATA_SENTINEL = 'DS_P1_008_BASELINE_METADATA_SENTINEL';
const NODE_SQLITE = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE_TEST_OPTIONS = NODE_SQLITE.available ? {} : { skip: NODE_SQLITE.reason };

function decision(id, project, title = id) {
  return {
    id,
    kind: 'decision',
    schemaVersion: 4,
    project,
    title,
    chosen: 'preserve',
    status: 'active',
    alternatives: [],
    confidence: 0.5
  };
}

function schema4RawLedgerFixture({ mode = 'logical' } = {}) {
  const kept = decision('ds-p1-007-kept', 'ds-p1-007-kept', 'Kept project');
  const purged = {
    ...decision(RAW_ID, 'legacy-cross-project-scope', 'Private legacy decision'),
    alternatives: [{ id: RAW_ALT_ID, label: 'Private alternative', reopenWhen: [] }]
  };
  const fact = {
    id: RAW_FACT_ID,
    kind: 'fact',
    schemaVersion: 4,
    project: 'legacy-cross-project-scope',
    key: 'private-fact',
    value: 'private-value',
    source: 'agent_claimed',
    sourceClass: 'agent_claimed',
    status: 'active',
    verificationStatus: 'unverified',
    confidence: 0.5,
    observedAt: NOW
  };
  const relation = {
    id: RAW_RELATION_ID,
    kind: 'relation',
    schemaVersion: 4,
    project: 'ds-p1-007-kept',
    from: kept.id,
    to: RAW_ALT_ID,
    relation: 'depends_on',
    createdAt: NOW
  };
  const baseline = {
    id: 'ds-p1-007-baseline',
    seq: 1,
    type: 'projection.baseline',
    at: NOW,
    project: null,
    entityKind: null,
    entityId: null,
    schemaVersion: 4,
    derivedFrom: 'live_state_at_migration',
    payload: {
      records: [kept, purged],
      facts: [fact],
      relations: [relation],
      idempotency: [
        { key: 'decision:legacy-cross-project-scope:private-retry', value: purged },
        { key: 'decision:ds-p1-007-kept:kept-retry', value: kept }
      ]
    },
    provenance: { actor: null, client: null, sessionId: null }
  };
  const markerSequence = mode === 'hard' ? 3 : 3;
  const journal = [baseline];
  if (mode === 'logical') {
    journal.push({
      id: 'ds-p1-007-private-snapshot',
      seq: 2,
      type: 'decision.recorded',
      at: NOW,
      project: purged.project,
      entityKind: 'decision',
      entityId: purged.id,
      schemaVersion: 4,
      payload: purged,
      idempotencyKey: 'decision:legacy-cross-project-scope:private-retry',
      provenance: { actor: null, client: null, sessionId: null }
    });
  }
  journal.push({
    id: 'ds-p1-007-raw-marker',
    seq: markerSequence,
    type: 'project.purged',
    at: NOW,
    project: 'legacy-purge-command-scope',
    entityKind: 'project',
    entityId: 'legacy-purge-command-scope',
    schemaVersion: 4,
    payload: {
      project: 'legacy-purge-command-scope',
      mode,
      removed: 4,
      purgedEntityIds: [RAW_ID, RAW_FACT_ID],
      ...(mode === 'hard' ? { removedJournalSequences: [2] } : {})
    },
    provenance: { actor: 'legacy-actor', client: 'legacy-client', sessionId: 'legacy-session' }
  });
  journal.push({
    id: 'ds-p1-007-repeated-marker',
    seq: 4,
    type: 'project.purged',
    at: NOW,
    project: 'legacy-purge-command-scope',
    entityKind: 'project',
    entityId: 'legacy-purge-command-scope',
    schemaVersion: 4,
    payload: {
      project: 'legacy-purge-command-scope',
      mode: 'logical',
      removed: 0,
      purgedEntityIds: [RAW_ID, RAW_FACT_ID]
    },
    provenance: { actor: null, client: null, sessionId: null }
  });

  return {
    schemaVersion: 4,
    revision: 0,
    records: [kept, purged],
    facts: [fact],
    relations: [relation],
    reviewSignals: [{
      id: `review-${RAW_ID}`,
      decisionId: RAW_ID,
      reason: `review-${RAW_ID}`,
      status: 'open',
      createdAt: NOW
    }],
    idempotency: [
      { key: 'decision:legacy-cross-project-scope:private-retry', value: purged },
      { key: 'decision:ds-p1-007-kept:kept-retry', value: kept }
    ],
    events: [{ id: RAW_EVENT_ID, type: 'decision.recorded', at: NOW, project: purged.project, recordId: RAW_ID }],
    journal,
    journalSeq: 4,
    journalEpoch: 1
  };
}

function assertRawIdentityAbsent(value, label) {
  const text = Buffer.isBuffer(value) ? value.toString('utf8') : JSON.stringify(value);
  for (const sentinel of [RAW_ID, RAW_ALT_ID, RAW_FACT_ID, RAW_RELATION_ID, RAW_EVENT_ID]) {
    assert.equal(text.includes(sentinel), false, `${label} retained ${sentinel}`);
  }
}

function projectionIdentity(report) {
  return {
    records: report.projection.records.map((item) => item.id).sort(),
    facts: report.projection.facts.map((item) => item.id).sort(),
    relations: report.projection.relations.map((item) => item.id).sort(),
    idempotency: report.projection.idempotency.map((item) => item.value.id).sort()
  };
}

test('DS-P1-007 ninth review RED: schema 4 raw purge ledgers and every referenced copy are migrated without changing projection or gaps', () => {
  for (const mode of ['logical', 'hard']) {
    const fixture = schema4RawLedgerFixture({ mode });
    const before = rebuildProjection(fixture.journal, { journalEpoch: fixture.journalEpoch });
    const beforeGaps = journalGaps(fixture.journal);
    assert.deepEqual(projectionIdentity(before), {
      records: ['ds-p1-007-kept'], facts: [], relations: [], idempotency: ['ds-p1-007-kept']
    });

    const graph = createShadowGraph({ now: () => NOW });
    graph.importData(fixture);
    const exported = graph.exportData();
    const after = rebuildProjection(exported.journal, { journalEpoch: exported.journalEpoch });

    assertRawIdentityAbsent(exported, `${mode} migrated export`);
    assertRawIdentityAbsent(graph.getJournal({ limit: 1000 }), `${mode} journal read`);
    assertRawIdentityAbsent(graph.rebuild(), `${mode} exposed rebuild`);
    assert.deepEqual(projectionIdentity(after), projectionIdentity(before), `${mode}: raw fold parity`);
    assert.deepEqual(journalGaps(exported.journal), beforeGaps, `${mode}: hard-gap evidence`);
    assert.equal(after.rebuildable, before.rebuildable, `${mode}: rebuildable parity`);
    assert.equal(after.reason, before.reason, `${mode}: rebuild reason parity`);
    assert.deepEqual(exported.records.map((item) => item.id), ['ds-p1-007-kept']);
    assert.deepEqual(exported.idempotency.map((item) => item.value.id), ['ds-p1-007-kept']);
    assert.equal(exported.reviewSignals.length, 0);
    assert.equal(exported.events.length, 0);
    for (const marker of exported.journal.filter((entry) => entry.type === 'project.purged')) {
      assert.equal(Object.hasOwn(marker.payload, 'purgedEntityIds'), false);
      assert.equal(marker.entityId, null);
    }
  }
});

function fixtureForSchema(schemaVersion, options) {
  const fixture = structuredClone(schema4RawLedgerFixture(options));
  fixture.schemaVersion = schemaVersion;
  for (const item of [...fixture.records, ...fixture.facts, ...fixture.relations]) item.schemaVersion = schemaVersion;
  for (const entry of fixture.journal) {
    entry.schemaVersion = schemaVersion;
    if (entry.type === 'projection.baseline') {
      for (const item of [...entry.payload.records, ...entry.payload.facts, ...entry.payload.relations]) item.schemaVersion = schemaVersion;
      for (const item of entry.payload.idempotency) item.value.schemaVersion = schemaVersion;
    } else if (entry.payload?.kind) {
      entry.payload.schemaVersion = schemaVersion;
    }
  }
  for (const item of fixture.idempotency) item.value.schemaVersion = schemaVersion;
  return fixture;
}

test('DS-P1-007 ninth review: schemas 1-4 and a journal-bearing merge cannot resurrect raw-ledger entities', () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    const graph = createShadowGraph({ now: () => NOW });
    graph.importData(fixtureForSchema(schemaVersion, { mode: 'logical' }));
    assertRawIdentityAbsent(graph.exportData(), `schema ${schemaVersion} export`);
    assertRawIdentityAbsent(graph.rebuild(), `schema ${schemaVersion} rebuild`);
  }

  const destination = createShadowGraph({ now: () => NOW });
  const host = destination.addDecision({
    id: 'ds-p1-007-merge-host', project: 'ds-p1-007-existing',
    title: 'Existing nonpurged project', chosen: 'preserve', idempotencyKey: 'host-retry'
  });
  const purged = {
    ...decision(RAW_ID, 'legacy-cross-project-scope', 'Merged private decision'),
    alternatives: [{ id: RAW_ALT_ID, label: 'Merged private alternative', reopenWhen: [] }]
  };
  const kept = decision('ds-p1-007-merge-kept', 'ds-p1-007-merge-kept', 'Merged kept decision');
  const relation = {
    id: RAW_RELATION_ID, kind: 'relation', schemaVersion: 4,
    project: host.project, from: host.id, to: RAW_ALT_ID,
    relation: 'depends_on', createdAt: NOW
  };
  destination.importData({
    schemaVersion: 4,
    records: [purged, kept], facts: [], relations: [relation], reviewSignals: [],
    idempotency: [{ key: 'decision:legacy-cross-project-scope:private-retry', value: purged }],
    events: [{ id: RAW_EVENT_ID, type: 'decision.recorded', at: NOW, project: purged.project, recordId: RAW_ID }],
    journal: [
      {
        id: 'ds-p1-007-merge-private', seq: 2, type: 'decision.recorded', at: NOW,
        project: purged.project, entityKind: 'decision', entityId: purged.id, schemaVersion: 4,
        payload: purged, idempotencyKey: 'decision:legacy-cross-project-scope:private-retry',
        provenance: { actor: null, client: null, sessionId: null }
      },
      {
        id: 'ds-p1-007-merge-relation', seq: 3, type: 'relation.created', at: NOW,
        project: relation.project, entityKind: 'relation', entityId: relation.id, schemaVersion: 4,
        payload: relation, provenance: { actor: null, client: null, sessionId: null }
      },
      {
        id: 'ds-p1-007-merge-marker', seq: 4, type: 'project.purged', at: NOW,
        project: 'legacy-purge-command-scope', entityKind: 'project', entityId: 'legacy-purge-command-scope', schemaVersion: 4,
        payload: { project: 'legacy-purge-command-scope', mode: 'logical', removed: 3, purgedEntityIds: [RAW_ID] },
        provenance: { actor: null, client: null, sessionId: null }
      },
      {
        id: 'ds-p1-007-merge-kept-entry', seq: 5, type: 'decision.recorded', at: NOW,
        project: kept.project, entityKind: 'decision', entityId: kept.id, schemaVersion: 4,
        payload: kept, provenance: { actor: null, client: null, sessionId: null }
      }
    ],
    journalSeq: 5,
    journalEpoch: 1
  });
  const merged = destination.exportData();
  assertRawIdentityAbsent(merged, 'merge export');
  assert.deepEqual(merged.records.map((item) => item.id).sort(), [host.id, kept.id].sort());
  assert.equal(destination.rebuild().rebuildable, true);
  assert.deepEqual(destination.rebuild().projection.records.map((item) => item.id).sort(), [host.id, kept.id].sort());
});

async function createStore(backend, path) {
  return backend === 'sqlite' ? createSqliteStore(path) : createJsonFileStore(path);
}

function runCli(file, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'restore', source], {
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

async function seedDestination(path) {
  const store = createJsonFileStore(path);
  const old = createShadowGraph({ now: () => NOW });
  old.addDecision({ id: `old-${path.split(/[\\/]/).pop()}`, project: 'old', title: 'Old', chosen: 'replace' });
  await store.save(old.exportData());
  store.close();
}

test('DS-P1-007 ninth review RED: raw schema-4 restores are normalized in JSON/SQLite, backups, CLI, HTTP, and MCP bytes', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-ninth-review-restore-');
  const raw = schema4RawLedgerFixture({ mode: 'logical' });
  const rawJson = join(directory, 'raw.json');
  await writeFile(rawJson, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
  assert.equal((await readFile(rawJson, 'utf8')).includes(RAW_ID), true, 'source proves the raw identifier existed');

  await t.test('direct JSON restart, backup, and restore bytes', async () => {
    const destination = join(directory, 'direct.json');
    const backup = join(directory, 'direct.backup.json');
    await seedDestination(destination);
    await restoreFile(rawJson, destination);
    assertRawIdentityAbsent(await readFile(destination), 'direct JSON restored bytes');
    let store = createJsonFileStore(destination);
    const reopened = await store.load();
    assertRawIdentityAbsent(reopened, 'direct JSON restart');
    await backupFile(destination, backup, { store });
    store.close();
    assertRawIdentityAbsent(await readFile(backup), 'direct JSON backup bytes');
  });

  await t.test('direct SQLite restart, backup, and restore bytes', SQLITE_TEST_OPTIONS, async () => {
    const source = join(directory, 'raw.db');
    const destination = join(directory, 'direct.db');
    const backup = join(directory, 'direct.backup.db');
    const assertStandaloneCompactedDatabase = async (path, label) => {
      assertRawIdentityAbsent(await readFile(path), `${label} main file (live cells and unused page bytes)`);
      for (const suffix of ['-wal', '-shm', '-journal']) {
        await assert.rejects(readFile(`${path}${suffix}`), (error) => error.code === 'ENOENT', `${label} must not retain ${suffix}`);
      }
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(path, { readOnly: true });
      try {
        assert.equal(database.prepare('PRAGMA integrity_check').get().integrity_check, 'ok', `${label} integrity`);
        assert.equal(database.prepare('PRAGMA freelist_count').get().freelist_count, 0, `${label} freelist must be empty`);
      } finally {
        database.close();
      }
    };

    let sourceStore = await createSqliteStore(source);
    await sourceStore.save(raw);
    const sourcePayload = await sourceStore.load();
    sourceStore.close();
    sourceStore = undefined;
    const sourceBytesBefore = await readFile(source);
    assert.equal(sourceBytesBefore.toString('utf8').includes(RAW_ID), true, 'SQLite source proves the raw identifier existed');

    const expectedGraph = createShadowGraph({ now: () => NOW });
    expectedGraph.importData(sourcePayload);
    const expected = expectedGraph.exportData();

    let store = await createSqliteStore(destination);
    const old = createShadowGraph({ now: () => NOW });
    old.addDecision({ id: 'sqlite-old', project: 'old', title: 'Old', chosen: 'replace' });
    await store.save(old.exportData());
    const oldRevision = (await store.load()).revision;
    await store.restore(source);
    const restored = await store.load();
    assertRawIdentityAbsent(restored, 'direct SQLite restart');
    assert.equal(restored.revision, Math.max(oldRevision, sourcePayload.revision) + 1, 'restore revision stays monotonic');
    for (const key of ['schemaVersion', 'records', 'facts', 'relations', 'reviewSignals', 'idempotency', 'events', 'journal', 'journalSeq', 'journalEpoch']) {
      assert.deepEqual(restored[key], expected[key], `normalized SQLite restore preserves ${key} semantics`);
    }
    assert.deepEqual(await readFile(source), sourceBytesBefore, 'normalized restore must not rewrite source bytes');
    await assertStandaloneCompactedDatabase(destination, 'direct SQLite restored database');

    await backupFile(destination, backup, { store });
    store.close();
    await assertStandaloneCompactedDatabase(backup, 'direct SQLite backup database');
  });

  await t.test('SQLite staged delete-then-failure rolls back without changing source or destination', SQLITE_TEST_OPTIONS, async () => {
    const source = join(directory, 'failure-raw.db');
    const destination = join(directory, 'failure-direct.db');
    let sourceStore = await createSqliteStore(source);
    await sourceStore.save(raw);
    sourceStore.close();
    sourceStore = undefined;
    const sourceBytesBefore = await readFile(source);

    const store = await createSqliteStore(destination, {
      restoreFault(stage) {
        if (stage === 'afterStagedReplace') throw new Error('injected delete-then-failure');
      }
    });
    const old = createShadowGraph({ now: () => NOW });
    old.addDecision({ id: 'sqlite-rollback-old', project: 'old', title: 'Old', chosen: 'preserve' });
    await store.save(old.exportData());
    const destinationBefore = await store.load();
    await assert.rejects(store.restore(source), /injected delete-then-failure/);
    assert.deepEqual(await store.load(), destinationBefore, 'staged normalization failure preserves destination semantics and revision');
    assert.deepEqual(await readFile(source), sourceBytesBefore, 'staged normalization failure leaves source bytes unchanged');
    for (const path of [source, destination]) {
      for (const suffix of ['-wal', '-shm', '-journal']) {
        await assert.rejects(readFile(`${path}${suffix}`), (error) => error.code === 'ENOENT', `${path}${suffix} must not survive staged rollback`);
      }
    }
    store.close();
  });

  await t.test('CLI restore', async () => {
    const destination = join(directory, 'cli.json');
    await seedDestination(destination);
    const result = await runCli(destination, rawJson);
    assert.equal(result.code, 0, result.stderr);
    assertRawIdentityAbsent(result.stdout, 'CLI response');
    assertRawIdentityAbsent(await readFile(destination), 'CLI durable bytes');
  });

  await t.test('HTTP restore', async () => {
    const destination = join(directory, 'http.json');
    await seedDestination(destination);
    const app = await createShadowGraphServer({ file: destination, now: () => NOW });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: rawJson })
      });
      assert.equal(response.status, 200, JSON.stringify(await response.clone().json()));
      assertRawIdentityAbsent(await response.text(), 'HTTP response');
      assertRawIdentityAbsent(app.graph.exportData(), 'HTTP live graph');
      assertRawIdentityAbsent(await readFile(destination), 'HTTP durable bytes');
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
    }
  });

  await t.test('MCP restore', async () => {
    const destination = join(directory, 'mcp.json');
    await seedDestination(destination);
    const rpc = startMcp(destination);
    try {
      await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const response = await rpc.call({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'shadowgraph_restore', arguments: { source: rawJson } }
      });
      assert.equal(response.error, undefined, response.error?.message);
      assertRawIdentityAbsent(response, 'MCP response');
      const journal = await rpc.call({
        jsonrpc: '2.0', id: 3, method: 'tools/call',
        params: { name: 'shadowgraph_journal', arguments: { limit: 1000 } }
      });
      assertRawIdentityAbsent(journal, 'MCP journal');
      assertRawIdentityAbsent(await readFile(destination), 'MCP durable bytes');
    } finally {
      await rpc.stop();
    }
  });
});

function addBaselineMetadata(payload, { redactableCollection = false } = {}) {
  const baseline = payload.journal.find((entry) => entry.type === 'projection.baseline');
  Object.assign(baseline, {
    causationId: BASELINE_METADATA_SENTINEL,
    idempotencyKey: BASELINE_METADATA_SENTINEL,
    requestId: BASELINE_METADATA_SENTINEL,
    userId: BASELINE_METADATA_SENTINEL,
    agentId: BASELINE_METADATA_SENTINEL,
    runId: BASELINE_METADATA_SENTINEL,
    arbitraryEnvelopeField: BASELINE_METADATA_SENTINEL,
    provenance: {
      actor: BASELINE_METADATA_SENTINEL,
      client: BASELINE_METADATA_SENTINEL,
      sessionId: BASELINE_METADATA_SENTINEL
    }
  });
  baseline.payload.arbitraryPayloadField = BASELINE_METADATA_SENTINEL;
  if (redactableCollection) {
    baseline.payload.records[0].secretNote = BASELINE_METADATA_SENTINEL;
    const liveRecord = payload.records.find((item) => item.id === baseline.payload.records[0].id);
    if (liveRecord) liveRecord.secretNote = BASELINE_METADATA_SENTINEL;
  }
  return payload;
}

function baselineMetadataFixture() {
  const source = createShadowGraph({ now: () => NOW });
  source.importData({
    schemaVersion: 3,
    records: [
      { ...decision('ds-p1-008-kept', 'ds-p1-008-kept', 'Kept baseline record'), schemaVersion: 3 },
      { ...decision('ds-p1-008-private', 'ds-p1-008-private', 'Private baseline record'), schemaVersion: 3 }
    ]
  });
  return addBaselineMetadata(source.exportData());
}

function assertSanitizedBaseline(payload, label, expectedRecordIds) {
  const serialized = Buffer.isBuffer(payload) ? payload.toString('utf8') : JSON.stringify(payload);
  assert.equal(serialized.includes(BASELINE_METADATA_SENTINEL), false, `${label} retained identifying baseline metadata`);
  if (Buffer.isBuffer(payload)) return;
  const baseline = payload.journal.find((entry) => entry.type === 'projection.baseline');
  assert.ok(baseline, `${label} retains the baseline placement`);
  assert.deepEqual(baseline.provenance, { actor: null, client: null, sessionId: null }, `${label} nulls baseline provenance`);
  assert.deepEqual(Object.keys(baseline.payload).sort(), ['facts', 'idempotency', 'records', 'relations'], `${label} canonicalizes the baseline payload`);
  const allowedEnvelope = new Set([
    'id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId', 'schemaVersion',
    'derivedFrom', 'replayable', 'payload', 'provenance'
  ]);
  assert.deepEqual(Object.keys(baseline).filter((key) => !allowedEnvelope.has(key)), [], `${label} canonicalizes the baseline envelope`);
  if (expectedRecordIds) assert.deepEqual(baseline.payload.records.map((item) => item.id).sort(), [...expectedRecordIds].sort(), `${label} preserves only expected baseline records`);
}

function assertBaselineRebuildParity(payload, label) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.replaceData(payload);
  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true, `${label} remains rebuildable`);
  assert.deepEqual(
    rebuilt.projection.records.map((item) => item.id).sort(),
    payload.records.map((item) => item.id).sort(),
    `${label} rebuild records match live projection`
  );
  return graph.exportData();
}

async function assertBaselineAcrossPersistence(t, payload, label, expectedRecordIds) {
  for (const backend of ['json', 'sqlite']) {
    await t.test(`${label} ${backend} restart, backup, and restore`, backend === 'sqlite' ? SQLITE_TEST_OPTIONS : {}, async (t) => {
      const directory = await scratchDirectory(t, `shadowgraph-ds-p1-008-${backend}-`);
      const extension = backend === 'sqlite' ? 'db' : 'json';
      const live = join(directory, `live.${extension}`);
      const backup = join(directory, `backup.${extension}`);
      const destination = join(directory, `destination.${extension}`);
      const assertDurableBytes = async (path, stage) => {
        assertSanitizedBaseline(await readFile(path), stage);
        if (backend === 'sqlite') {
          for (const suffix of ['-wal', '-shm', '-journal']) {
            await assert.rejects(readFile(`${path}${suffix}`), (error) => error.code === 'ENOENT', `${stage} must not retain ${suffix}`);
          }
        }
      };

      let liveStore = await createStore(backend, live);
      await liveStore.save(payload);
      await assertDurableBytes(live, `${label} ${backend} live bytes`);
      await backupFile(live, backup, { store: liveStore });
      liveStore.close();
      await assertDurableBytes(backup, `${label} ${backend} backup bytes`);

      liveStore = await createStore(backend, live);
      const restarted = await liveStore.load();
      liveStore.close();
      assertSanitizedBaseline(restarted, `${label} ${backend} restart`, expectedRecordIds);
      assertBaselineRebuildParity(restarted, `${label} ${backend} restart`);

      let destinationStore = await createStore(backend, destination);
      const old = createShadowGraph({ now: () => NOW });
      old.addDecision({ id: `${label}-${backend}-old`, project: 'old', title: 'Old', chosen: 'replace' });
      await destinationStore.save(old.exportData());
      if (backend === 'sqlite') {
        await destinationStore.restore(backup);
      } else {
        destinationStore.close();
        await restoreFile(backup, destination);
        destinationStore = await createStore(backend, destination);
      }
      const restored = await destinationStore.load();
      destinationStore.close();
      assertSanitizedBaseline(restored, `${label} ${backend} restore`, expectedRecordIds);
      assertBaselineRebuildParity(restored, `${label} ${backend} restore`);
      await assertDurableBytes(destination, `${label} ${backend} restored bytes`);
    });
  }
}

test('DS-P1-008 ninth review RED: rewritten baselines are selectively canonical across migration, purge, redaction, and persistence', async (t) => {
  const persistedCases = [];

  for (const mode of ['logical', 'hard']) {
    const graph = createShadowGraph({ now: () => NOW });
    graph.replaceData(baselineMetadataFixture());
    const before = graph.exportData();
    const baselineBefore = before.journal.find((entry) => entry.type === 'projection.baseline');
    graph.purgeProject('ds-p1-008-private', { mode });
    const exported = graph.exportData();
    const baselineAfter = exported.journal.find((entry) => entry.type === 'projection.baseline');
    assert.equal(exported.journalEpoch, before.journalEpoch, `${mode} purge preserves journalEpoch`);
    assert.equal(baselineAfter.seq, baselineBefore.seq, `${mode} purge preserves baseline placement`);
    assertSanitizedBaseline(exported, `${mode} purge`, ['ds-p1-008-kept']);
    assertBaselineRebuildParity(exported, `${mode} purge`);
    persistedCases.push({ label: `runtime-${mode}`, payload: exported, expectedRecordIds: ['ds-p1-008-kept'] });
  }

  for (const schemaVersion of [1, 2, 3, 4]) {
    const fixture = addBaselineMetadata(fixtureForSchema(schemaVersion, { mode: 'logical' }));
    const graph = createShadowGraph({ now: () => NOW });
    graph.importData(fixture);
    const exported = graph.exportData();
    assertSanitizedBaseline(exported, `schema ${schemaVersion} legacy migration`, ['ds-p1-007-kept']);
    assertBaselineRebuildParity(exported, `schema ${schemaVersion} legacy migration`);
    persistedCases.push({ label: `legacy-schema-${schemaVersion}`, payload: exported, expectedRecordIds: ['ds-p1-007-kept'] });
  }

  {
    const redactionFixture = addBaselineMetadata(baselineMetadataFixture(), { redactableCollection: true });
    const graph = createShadowGraph({ now: () => NOW });
    graph.replaceData(redactionFixture);
    const redacted = graph.redact({ patterns: ['secretNote'], replacement: '[REDACTED]' });
    assertSanitizedBaseline(redacted, 'redaction', ['ds-p1-008-kept', 'ds-p1-008-private']);
    assert.equal(redacted.records[0].secretNote, '[REDACTED]', 'redaction changes the live and baseline collection consistently');
    assert.equal(redacted.journal.find((entry) => entry.type === 'projection.baseline').payload.records[0].secretNote, '[REDACTED]');
    assertBaselineRebuildParity(redacted, 'redaction');
    assert.equal(JSON.stringify(graph.exportData()).includes(BASELINE_METADATA_SENTINEL), true, 'redaction must not mutate the live baseline');
    persistedCases.push({
      label: 'redaction', payload: redacted,
      expectedRecordIds: ['ds-p1-008-kept', 'ds-p1-008-private']
    });
  }

  {
    const graph = createShadowGraph({ now: () => NOW });
    graph.replaceData(baselineMetadataFixture());
    graph.purgeProject('ds-p1-008-absent', { mode: 'logical' });
    const untouched = graph.exportData();
    const baseline = untouched.journal.find((entry) => entry.type === 'projection.baseline');
    assert.equal(baseline.arbitraryEnvelopeField, BASELINE_METADATA_SENTINEL, 'an untouched baseline envelope is not sanitized');
    assert.equal(baseline.payload.arbitraryPayloadField, BASELINE_METADATA_SENTINEL, 'an untouched baseline payload is not sanitized');
    assert.deepEqual(baseline.provenance, {
      actor: BASELINE_METADATA_SENTINEL,
      client: BASELINE_METADATA_SENTINEL,
      sessionId: BASELINE_METADATA_SENTINEL
    }, 'an untouched baseline provenance is preserved');
  }

  for (const item of persistedCases) {
    await assertBaselineAcrossPersistence(t, item.payload, item.label, item.expectedRecordIds);
  }
});
