import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import {
  hardPurgeGapLedgerReport,
  INVALID_JOURNAL_SEQUENCE_CODE,
  rebuildProjection,
  schema5PurgeArtifactIssue
} from '../src/journal.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-08-28T12:00:00.000Z';
const PROJECT = 'semantic-purge-project';
const NULL_PROVENANCE = Object.freeze({ actor: null, client: null, sessionId: null });
const INVALID_CODE = 'noncanonical_schema5_purge_artifact';
const INVALID_REASON = 'journal contains noncanonical schema-5 purge artifacts';
const NODE_SQLITE = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE_TEST_OPTIONS = NODE_SQLITE.available ? {} : { skip: NODE_SQLITE.reason };
const VICTIM = Object.freeze({
  id: 'semantic-purge-victim',
  kind: 'decision',
  schemaVersion: 5,
  project: PROJECT,
  title: 'Must survive an invalid purge marker',
  chosen: 'preserve',
  status: 'proposed',
  alternatives: [],
  confidence: 0.5
});

function seedEntry(schemaVersion = 5) {
  const payload = { ...VICTIM, schemaVersion };
  return {
    id: `semantic-seed-${schemaVersion}`,
    seq: 1,
    type: 'decision.recorded',
    at: NOW,
    project: PROJECT,
    entityKind: 'decision',
    entityId: payload.id,
    schemaVersion,
    payload,
    idempotencyKey: `decision:${PROJECT}:semantic-retry`,
    provenance: { ...NULL_PROVENANCE }
  };
}

function canonicalMarker(base = 'logical') {
  const hard = base === 'hard';
  return {
    id: `semantic-${base}-marker`,
    seq: hard ? 3 : 2,
    type: 'project.purged',
    at: NOW,
    project: PROJECT,
    entityKind: 'project',
    entityId: null,
    schemaVersion: 5,
    payload: {
      project: PROJECT,
      mode: base,
      removed: 1,
      removedJournalSequences: hard ? [2] : []
    },
    provenance: { ...NULL_PROVENANCE }
  };
}

function invalidCase(name, mutate, detail, base = 'logical') {
  return Object.freeze({ name, mutate, detail, base });
}

const INVALID_MARKER_CASES = Object.freeze([
  invalidCase('id_missing', (entry) => { delete entry.id; }, /id must be a non-empty string/i),
  invalidCase('id_empty', (entry) => { entry.id = ''; }, /id must be a non-empty string/i),
  invalidCase('id_non_string', (entry) => { entry.id = 7; }, /id must be a non-empty string/i),
  invalidCase('seq_missing', (entry) => { delete entry.seq; }, /seq must be a positive safe integer/i),
  invalidCase('seq_zero', (entry) => { entry.seq = 0; }, /seq must be a positive safe integer/i),
  invalidCase('seq_negative', (entry) => { entry.seq = -1; }, /seq must be a positive safe integer/i),
  invalidCase('seq_fractional', (entry) => { entry.seq = 1.5; }, /seq must be a positive safe integer/i),
  invalidCase('seq_unsafe', (entry) => { entry.seq = Number.MAX_SAFE_INTEGER + 1; }, /seq must be a positive safe integer/i),
  invalidCase('project_missing', (entry) => { delete entry.project; }, /project must be a non-empty string/i),
  invalidCase('project_empty', (entry) => { entry.project = ''; }, /project must be a non-empty string/i),
  invalidCase('project_whitespace', (entry) => { entry.project = '   '; }, /project must be a non-empty string/i),
  invalidCase('project_non_string', (entry) => { entry.project = 7; }, /project must be a non-empty string/i),
  invalidCase('payload_project_missing', (entry) => { delete entry.payload.project; }, /payload\.project must be a non-empty string/i),
  invalidCase('payload_project_empty', (entry) => { entry.payload.project = ''; }, /payload\.project must be a non-empty string/i),
  invalidCase('payload_project_whitespace', (entry) => { entry.payload.project = '   '; }, /payload\.project must be a non-empty string/i),
  invalidCase('payload_project_non_string', (entry) => { entry.payload.project = 7; }, /payload\.project must be a non-empty string/i),
  invalidCase('project_mismatch', (entry) => { entry.payload.project = 'another-project'; }, /project must equal payload\.project/i),
  invalidCase('entity_kind_missing', (entry) => { delete entry.entityKind; }, /must use project kind and erase entityId/i),
  invalidCase('entity_kind_wrong', (entry) => { entry.entityKind = 'decision'; }, /must use project kind and erase entityId/i),
  invalidCase('entity_id_missing', (entry) => { delete entry.entityId; }, /must use project kind and erase entityId/i),
  invalidCase('entity_id_non_null', (entry) => { entry.entityId = PROJECT; }, /must use project kind and erase entityId/i),
  invalidCase('provenance_missing', (entry) => { delete entry.provenance; }, /erase provenance identity/i),
  invalidCase('provenance_array', (entry) => { entry.provenance = []; }, /erase provenance identity/i),
  invalidCase('provenance_extra_field', (entry) => { entry.provenance.requestId = 'private'; }, /erase provenance identity/i),
  invalidCase('provenance_actor', (entry) => { entry.provenance.actor = 'private'; }, /erase provenance identity/i),
  invalidCase('provenance_client', (entry) => { entry.provenance.client = 'private'; }, /erase provenance identity/i),
  invalidCase('provenance_session', (entry) => { entry.provenance.sessionId = 'private'; }, /erase provenance identity/i),
  invalidCase('forbidden_envelope_field', (entry) => { entry.requestId = 'private'; }, /forbidden identity field requestId/i),
  invalidCase('payload_null', (entry) => { entry.payload = null; }, /payload must be an object|purge skeleton must set redacted true/i),
  invalidCase('payload_array', (entry) => { entry.payload = []; }, /payload must be an object/i),
  invalidCase('forbidden_payload_field', (entry) => { entry.payload.purgedEntityIds = [VICTIM.id]; }, /forbidden payload field purgedEntityIds/i),
  invalidCase('mode_missing', (entry) => { delete entry.payload.mode; }, /mode must be exactly logical or hard/i),
  invalidCase('mode_non_string', (entry) => { entry.payload.mode = 1; }, /mode must be exactly logical or hard/i),
  invalidCase('mode_noncanonical', (entry) => { entry.payload.mode = 'Logical'; }, /mode must be exactly logical or hard/i),
  invalidCase('removed_missing', (entry) => { delete entry.payload.removed; }, /removed must be a non-negative safe integer/i),
  invalidCase('removed_non_number', (entry) => { entry.payload.removed = '1'; }, /removed must be a non-negative safe integer/i),
  invalidCase('removed_negative', (entry) => { entry.payload.removed = -1; }, /removed must be a non-negative safe integer/i),
  invalidCase('removed_fractional', (entry) => { entry.payload.removed = 0.5; }, /removed must be a non-negative safe integer/i),
  invalidCase('removed_unsafe', (entry) => { entry.payload.removed = Number.MAX_SAFE_INTEGER + 1; }, /removed must be a non-negative safe integer/i),
  invalidCase('ledger_missing', (entry) => { delete entry.payload.removedJournalSequences; }, /removedJournalSequences must be present and be an array/i),
  invalidCase('ledger_null', (entry) => { entry.payload.removedJournalSequences = null; }, /removedJournalSequences must be present and be an array/i),
  invalidCase('ledger_non_array', (entry) => { entry.payload.removedJournalSequences = '2'; }, /removedJournalSequences must be present and be an array/i),
  invalidCase('ledger_zero', (entry) => { entry.payload.removedJournalSequences = [0]; }, /positive safe integers/i, 'hard'),
  invalidCase('ledger_negative', (entry) => { entry.payload.removedJournalSequences = [-1]; }, /positive safe integers/i, 'hard'),
  invalidCase('ledger_fractional', (entry) => { entry.payload.removedJournalSequences = [1.5]; }, /positive safe integers/i, 'hard'),
  invalidCase('ledger_unsafe', (entry) => { entry.payload.removedJournalSequences = [Number.MAX_SAFE_INTEGER + 1]; }, /positive safe integers/i, 'hard'),
  invalidCase('ledger_duplicate', (entry) => { entry.payload.removedJournalSequences = [2, 2]; }, /strictly increasing.*unique/i, 'hard'),
  invalidCase('ledger_unsorted', (entry) => { entry.seq = 4; entry.payload.removedJournalSequences = [3, 2]; }, /strictly increasing.*unique/i, 'hard'),
  invalidCase('logical_ledger_nonempty', (entry) => { entry.payload.removedJournalSequences = [1]; }, /logical purge.*empty removedJournalSequences/i),
  invalidCase('ledger_self_authorization', (entry) => { entry.payload.removedJournalSequences = [3]; }, /strictly earlier than marker sequence/i, 'hard'),
  invalidCase('ledger_future_authorization', (entry) => { entry.payload.removedJournalSequences = [4]; }, /strictly earlier than marker sequence/i, 'hard')
]);

function markerFor(testCase) {
  const marker = canonicalMarker(testCase.base);
  marker.id = `invalid-${testCase.name}`;
  testCase.mutate(marker);
  return marker;
}

function currentEnvelope(marker) {
  return {
    schemaVersion: 5,
    revision: 0,
    records: [],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: [structuredClone(marker)],
    journalSeq: 3,
    journalEpoch: 1
  };
}

function liveVictimGraph() {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({
    id: VICTIM.id,
    project: PROJECT,
    title: VICTIM.title,
    chosen: VICTIM.chosen,
    idempotencyKey: 'semantic-retry'
  });
  return graph;
}

function assertPureRejected(report, testCase) {
  const invalidSequence = testCase.name.startsWith('seq_');
  assert.equal(report.rebuildable, false, `${testCase.name}: invalid marker blocks complete rebuild`);
  assert.equal(
    report.reason,
    invalidSequence ? 'journal contains invalid sequence numbers' : INVALID_REASON,
    `${testCase.name}: stable rebuild reason`
  );
  assert.equal(report.applied, invalidSequence ? 0 : 1, `${testCase.name}: invalid marker is not folded`);
  assert.deepEqual(report.projection.records, invalidSequence ? [] : [VICTIM], `${testCase.name}: invalid marker cannot delete the projection`);
  assert.deepEqual(report.projection.idempotency, invalidSequence ? [] : [{
    key: `decision:${PROJECT}:semantic-retry`,
    value: VICTIM
  }], `${testCase.name}: invalid marker cannot delete idempotency state`);
  assert.equal(report.skipped.length, 1, `${testCase.name}: one attributable skip`);
  assert.equal(report.skipped[0].why, invalidSequence ? INVALID_JOURNAL_SEQUENCE_CODE : INVALID_CODE, `${testCase.name}: stable skip code`);
  assert.match(report.skipped[0].detail, testCase.detail, `${testCase.name}: semantic diagnostic`);
}

test('schema-5 purge marker values and relationships fail closed before pure fold or graph mutation', () => {
  for (const testCase of INVALID_MARKER_CASES) {
    const marker = markerFor(testCase);
    assert.match(schema5PurgeArtifactIssue(marker), testCase.detail, `${testCase.name}: authoritative validator`);
    assertPureRejected(
      rebuildProjection([seedEntry(), marker], { journalEpoch: 1 }),
      testCase
    );

    const direct = liveVictimGraph();
    const directBefore = direct.exportData();
    assert.throws(
      () => direct.importData(currentEnvelope(marker)),
      testCase.detail,
      `${testCase.name}: direct import rejects`
    );
    assert.deepEqual(direct.exportData(), directBefore, `${testCase.name}: direct import is atomic`);

    const replacement = liveVictimGraph();
    const replacementBefore = replacement.exportData();
    assert.throws(
      () => replacement.replaceData(currentEnvelope(marker)),
      testCase.detail,
      `${testCase.name}: replacement rejects`
    );
    assert.deepEqual(replacement.exportData(), replacementBefore, `${testCase.name}: replacement is atomic`);

    assert.throws(
      () => validateRestorePayload(currentEnvelope(marker), { now: () => NOW }),
      testCase.detail,
      `${testCase.name}: restore validation rejects`
    );
  }
});

const INVALID_GAP_CASES = Object.freeze([
  Object.freeze({
    name: 'ledger_claims_present_sequence',
    marker() {
      const marker = canonicalMarker('hard');
      marker.payload.removedJournalSequences = [1];
      return marker;
    },
    detail: /not an actual missing journal sequence/i
  }),
  Object.freeze({
    name: 'ledger_omits_actual_gap',
    marker() {
      const marker = canonicalMarker('hard');
      marker.payload.removedJournalSequences = [];
      return marker;
    },
    detail: /does not explain journal sequence 2/i
  }),
  Object.freeze({
    name: 'ledger_only_partially_covers_gap',
    marker() {
      const marker = canonicalMarker('hard');
      marker.seq = 4;
      marker.payload.removedJournalSequences = [2];
      return marker;
    },
    detail: /does not explain journal sequence 3/i
  })
]);

test('hard-purge gap relationships are validated before pure fold and public graph mutation', () => {
  for (const testCase of INVALID_GAP_CASES) {
    const marker = testCase.marker();
    marker.id = `invalid-gap-${testCase.name}`;
    assert.equal(schema5PurgeArtifactIssue(marker), null, `${testCase.name}: entry-local shape is canonical`);
    const ledger = hardPurgeGapLedgerReport([seedEntry(), marker], { journalEpoch: 1 });
    assert.equal(ledger.valid, false, `${testCase.name}: journal relationship is invalid`);
    assert.ok(ledger.issues.some((issue) => testCase.detail.test(issue.message)), `${testCase.name}: gap diagnostic`);
    assertPureRejected(rebuildProjection([seedEntry(), marker], { journalEpoch: 1 }), testCase);

    const direct = liveVictimGraph();
    const directBefore = direct.exportData();
    assert.throws(() => direct.importData(currentEnvelope(marker)), /hard purge|journal sequence|removedJournalSequences/i);
    assert.deepEqual(direct.exportData(), directBefore, `${testCase.name}: direct import is atomic`);

    const replacement = liveVictimGraph();
    const replacementBefore = replacement.exportData();
    assert.throws(() => replacement.replaceData(currentEnvelope(marker)), /hard purge|journal sequence|removedJournalSequences/i);
    assert.deepEqual(replacement.exportData(), replacementBefore, `${testCase.name}: replacement is atomic`);

    assert.throws(
      () => validateRestorePayload(currentEnvelope(marker), { now: () => NOW }),
      /hard purge|journal sequence|removedJournalSequences/i,
      `${testCase.name}: restore validation rejects`
    );
  }
});

test('graph validate and rebuild reuse one authoritative semantic marker diagnostic without deletion', () => {
  const marker = canonicalMarker('logical');
  delete marker.schemaVersion;
  marker.payload.mode = 'soft';
  const graph = liveVictimGraph();
  graph.importData({
    schemaVersion: 1,
    records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [],
    journal: [marker], journalSeq: 2, journalEpoch: 1
  });

  const validation = graph.validate();
  const markerIssues = validation.issues.filter((issue) => issue.code === INVALID_CODE);
  assert.equal(validation.valid, false);
  assert.equal(markerIssues.length, 1, 'validate reports the authoritative marker diagnostic once');
  assert.match(markerIssues[0].detail, /mode must be exactly logical or hard/i);

  const rebuild = graph.rebuild();
  assert.equal(rebuild.rebuildable, false);
  assert.equal(rebuild.reason, INVALID_REASON);
  assert.deepEqual(rebuild.projection.records.map((item) => item.id), [VICTIM.id]);
  assert.equal(rebuild.skipped.filter((item) => item.why === INVALID_CODE).length, 1, 'rebuild reports one skip, not a private-copy duplicate');
  assert.match(rebuild.skipped.find((item) => item.why === INVALID_CODE).detail, /mode must be exactly logical or hard/i);
});

function malformedRestorePayload() {
  const marker = canonicalMarker('logical');
  marker.payload.mode = 'soft';
  return {
    schemaVersion: 5,
    revision: 0,
    records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [],
    journal: [seedEntry(), marker], journalSeq: 2, journalEpoch: 1
  };
}

function runCli(destination, source) {
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
      const key = JSON.stringify(response.id);
      const waiter = pending.get(key);
      if (!waiter) continue;
      pending.delete(key);
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

async function writeOldDestination(path) {
  const old = createShadowGraph({ now: () => NOW });
  old.addDecision({ id: 'semantic-old-live', project: 'old', title: 'Old state', chosen: 'keep' });
  const store = createJsonFileStore(path);
  await store.save(old.exportData());
  store.close();
}

test('malformed marker rejection is atomic across JSON and SQLite restore', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-semantic-purge-restore-');
  const payload = malformedRestorePayload();

  await t.test('JSON restore', async () => {
    const source = join(directory, 'malformed.json');
    const destination = join(directory, 'live.json');
    await writeFile(source, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await writeOldDestination(destination);
    const before = await readFile(destination);
    await assert.rejects(restoreFile(source, destination), /mode must be exactly logical or hard/i);
    assert.deepEqual(await readFile(destination), before);
  });

  await t.test('SQLite restore', SQLITE_TEST_OPTIONS, async () => {
    const source = join(directory, 'malformed.db');
    const destination = join(directory, 'live.db');
    const sourceStore = await createSqliteStore(source);
    await sourceStore.save(payload);
    sourceStore.close();

    const old = createShadowGraph({ now: () => NOW });
    old.addDecision({ id: 'semantic-old-sqlite', project: 'old', title: 'Old SQLite state', chosen: 'keep' });
    const destinationStore = await createSqliteStore(destination);
    await destinationStore.save(old.exportData());
    const before = await destinationStore.load();
    await assert.rejects(destinationStore.restore(source), /mode must be exactly logical or hard/i);
    assert.deepEqual(await destinationStore.load(), before);
    destinationStore.close();
  });
});

test('malformed marker rejection is atomic across CLI, HTTP, and MCP restore', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-semantic-purge-interfaces-');
  const source = join(directory, 'malformed.json');
  await writeFile(source, `${JSON.stringify(malformedRestorePayload(), null, 2)}\n`, 'utf8');

  await t.test('CLI', async () => {
    const destination = join(directory, 'cli-live.json');
    await writeOldDestination(destination);
    const before = await readFile(destination);
    const result = await runCli(destination, source);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /mode must be exactly logical or hard/i);
    assert.deepEqual(await readFile(destination), before);
  });

  await t.test('HTTP', async () => {
    const destination = join(directory, 'http-live.json');
    await writeOldDestination(destination);
    const before = await readFile(destination);
    const app = await createShadowGraphServer({ file: destination, now: () => NOW });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source })
      });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /mode must be exactly logical or hard/i);
      assert.deepEqual(await readFile(destination), before);
    } finally {
      await new Promise((resolve) => app.server.close(resolve));
    }
  });

  await t.test('MCP', async () => {
    const destination = join(directory, 'mcp-live.json');
    await writeOldDestination(destination);
    const before = await readFile(destination);
    const rpc = startMcp(destination);
    try {
      await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const response = await rpc.call({
        jsonrpc: '2.0', id: 2, method: 'tools/call',
        params: { name: 'shadowgraph_restore', arguments: { source } }
      });
      assert.equal(response.result, undefined, 'legacy tool failures use the numeric JSON-RPC error form');
      assert.deepEqual(response.error, { code: -32000, message: 'Tool execution failed' });
      const publicFailure = JSON.stringify(response);
      assert.equal(publicFailure.includes(source), false, 'MCP failure disclosed the restore path');
      assert.equal(publicFailure.includes(destination), false, 'MCP failure disclosed the storage path');
      assert.equal(publicFailure.includes(VICTIM.id), false, 'MCP failure disclosed the retained entity id');
      assert.equal(publicFailure.includes('mode must be exactly logical or hard'), false, 'MCP failure disclosed the raw purge diagnostic');
      assert.deepEqual(await readFile(destination), before);
    } finally {
      await rpc.stop();
    }
  });
});

function legacyEnvelope(schemaVersion) {
  const marker = canonicalMarker('logical');
  Object.assign(marker, {
    id: `legacy-marker-${schemaVersion}`,
    schemaVersion,
    entityId: PROJECT,
    provenance: { actor: 'legacy-actor', client: 'legacy-client', sessionId: 'legacy-session' }
  });
  delete marker.payload.removedJournalSequences;
  marker.payload.purgedEntityIds = [VICTIM.id];
  return {
    schemaVersion,
    revision: 0,
    records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [],
    journal: [seedEntry(schemaVersion), marker], journalSeq: 2, journalEpoch: 1
  };
}

test('schemas 1-4 raw markers migrate compatibly while canonical schema-5 logical and hard gaps remain valid', () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    const payload = legacyEnvelope(schemaVersion);
    assert.equal(schema5PurgeArtifactIssue(payload.journal[1]), null, `schema ${schemaVersion}: pure legacy marker stays outside schema-5 validation`);
    assert.deepEqual(rebuildProjection(payload.journal, { journalEpoch: 1 }).projection.records, [], `schema ${schemaVersion}: legacy raw fold remains compatible`);

    const imported = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => imported.importData(payload), `schema ${schemaVersion}: import migrates`);
    assert.equal(imported.validate().valid, true, `schema ${schemaVersion}: migrated graph validates`);
    assert.equal(imported.rebuild().projection.records.length, 0, `schema ${schemaVersion}: migrated rebuild stays erased`);
    assert.doesNotThrow(() => validateRestorePayload(payload, { now: () => NOW }), `schema ${schemaVersion}: restore migration remains compatible`);
  }

  for (const mode of ['logical', 'hard']) {
    const source = createShadowGraph({ now: () => NOW });
    source.addDecision({ id: `valid-kept-${mode}`, project: 'valid-kept', title: 'Keep', chosen: 'keep' });
    source.addDecision({ id: `valid-purged-${mode}`, project: `valid-purged-${mode}`, title: 'Erase', chosen: 'erase' });
    source.purgeProject(`valid-purged-${mode}`, { mode });
    const payload = source.exportData();
    const marker = payload.journal.findLast((entry) => entry.type === 'project.purged');
    assert.equal(schema5PurgeArtifactIssue(marker), null, `${mode}: canonical marker`);
    if (mode === 'logical') assert.deepEqual(marker.payload.removedJournalSequences, []);
    else assert.equal(hardPurgeGapLedgerReport(payload.journal, { journalEpoch: payload.journalEpoch }).valid, true);

    const imported = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => imported.importData(payload), `${mode}: direct import`);
    assert.equal(imported.validate().valid, true, `${mode}: graph validation`);
    const replacement = liveVictimGraph();
    assert.doesNotThrow(() => replacement.replaceData(payload), `${mode}: replacement`);
    assert.doesNotThrow(() => validateRestorePayload(payload, { now: () => NOW }), `${mode}: restore validation`);
  }
});
