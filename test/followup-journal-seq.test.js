import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { restoreFile } from '../src/backup.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { createShadowGraphServer } from '../src/server.js';
import { getRuntimeCapabilities, NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';
import {
  INVALID_JOURNAL_SEQUENCE_CODE,
  JOURNAL_TYPE_ENTITY_KIND,
  NONCANONICAL_SCHEMA5_PURGE_ARTIFACT_CODE,
  REPLAYABLE_ENTRY_TYPES
} from '../src/journal.js';
import { createShadowGraph, rebuildProjection } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-08-28T12:00:00.000Z';
const INVALID_SEQUENCE = /invalid_journal_sequence|journal\[1\]\.seq must be a positive safe integer/i;
const DUPLICATE_SEQUENCE_CODE = 'duplicate_journal_sequence';
const DUPLICATE_SEQUENCE = /duplicate_journal_sequence/i;

function legacyDecision(schemaVersion, id = `legacy-seq-${schemaVersion}`) {
  return {
    id,
    kind: 'decision',
    schemaVersion,
    project: 'ds-p1-009',
    title: `Schema ${schemaVersion} compatibility`,
    chosen: 'preserve',
    status: 'active',
    alternatives: [],
    confidence: 0.5
  };
}

function legacyPayload(schemaVersion) {
  const record = legacyDecision(schemaVersion);
  return {
    schemaVersion,
    revision: 0,
    records: [record],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: [{
      id: `legacy-baseline-${schemaVersion}`,
      seq: 1,
      type: 'projection.baseline',
      at: NOW,
      project: null,
      entityKind: null,
      entityId: null,
      schemaVersion,
      derivedFrom: 'live_state_at_migration',
      payload: { records: [record], facts: [], relations: [], idempotency: [] },
      provenance: { actor: null, client: null, sessionId: null }
    }],
    journalSeq: 1,
    journalEpoch: 1
  };
}

function withJournalSequence(schemaVersion, seq) {
  const payload = legacyPayload(schemaVersion);
  payload.journal.push({
    id: `legacy-metadata-${schemaVersion}`,
    seq,
    type: 'legacy_metadata_event',
    at: NOW,
    project: null,
    entityKind: null,
    entityId: payload.records[0].id,
    schemaVersion,
    payload: null,
    replayable: false,
    originalType: 'decision.recorded',
    provenance: { actor: null, client: null, sessionId: null }
  });
  return payload;
}

const INVALID_ENTRY_SEQUENCES = Object.freeze([
  ['negative', -1],
  ['zero', 0],
  ['fractional', 1.5],
  ['NaN', Number.NaN],
  ['positive Infinity', Number.POSITIVE_INFINITY],
  ['negative Infinity', Number.NEGATIVE_INFINITY],
  ['MAX_SAFE_INTEGER plus one', Number.MAX_SAFE_INTEGER + 1]
]);

function seededGraph() {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({
    id: 'ds-p1-009-live',
    project: 'ds-p1-009-live',
    title: 'Must survive rejection',
    chosen: 'keep'
  });
  return graph;
}

test('DS-P1-009 schemas 1/2 reject every explicitly invalid journal entry sequence before import or replacement mutation', () => {
  for (const schemaVersion of [1, 2]) {
    for (const [label, seq] of INVALID_ENTRY_SEQUENCES) {
      const payload = withJournalSequence(schemaVersion, seq);

      const imported = createShadowGraph({ now: () => NOW });
      const importBefore = imported.exportData();
      assert.throws(
        () => imported.importData(payload),
        INVALID_SEQUENCE,
        `schema ${schemaVersion} ${label}: import diagnostic`
      );
      assert.deepEqual(imported.exportData(), importBefore, `schema ${schemaVersion} ${label}: import is state-atomic`);

      const replaced = seededGraph();
      const replaceBefore = replaced.exportData();
      assert.throws(
        () => replaced.replaceData(payload),
        INVALID_SEQUENCE,
        `schema ${schemaVersion} ${label}: replacement diagnostic`
      );
      assert.deepEqual(replaced.exportData(), replaceBefore, `schema ${schemaVersion} ${label}: replacement is state-atomic`);

      assert.throws(
        () => validateRestorePayload(payload, { now: () => NOW }),
        INVALID_SEQUENCE,
        `schema ${schemaVersion} ${label}: restore validation diagnostic`
      );

      const report = rebuildProjection(payload.journal, {
        journalEpoch: payload.journalEpoch,
        sourceSchemaVersion: schemaVersion
      });
      assert.equal(report.rebuildable, false, `schema ${schemaVersion} ${label}: pure rebuild rejects`);
      assert.equal(report.applied, 0, `schema ${schemaVersion} ${label}: an invalid ordering key prevents any partial fold`);
      assert.equal(report.skipped.some((item) => item.why === 'invalid_journal_sequence'), true, `schema ${schemaVersion} ${label}: stable rebuild diagnostic`);
    }
  }
});

test('DS-P1-009 canonical schema 1/2 snapshots still migrate, validate, and rebuild', () => {
  for (const schemaVersion of [1, 2]) {
    const graph = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => graph.importData(legacyPayload(schemaVersion)), `schema ${schemaVersion}: import`);
    assert.equal(graph.validate().valid, true, `schema ${schemaVersion}: validation`);
    assert.equal(graph.rebuild().rebuildable, true, `schema ${schemaVersion}: rebuild`);
    assert.deepEqual(graph.rebuild().projection.records.map((record) => record.id), [`legacy-seq-${schemaVersion}`]);
  }
});

const INVALID_ENVELOPE_NUMBERS = Object.freeze([
  ['negative', -1],
  ['fractional', 1.5],
  ['NaN', Number.NaN],
  ['positive Infinity', Number.POSITIVE_INFINITY],
  ['negative Infinity', Number.NEGATIVE_INFINITY],
  ['MAX_SAFE_INTEGER plus one', Number.MAX_SAFE_INTEGER + 1]
]);

test('DS-P1-009 schemas 1/2 reject unsafe envelope journalSeq and journalEpoch values before mutation', () => {
  for (const schemaVersion of [1, 2]) {
    for (const [field, cases, diagnostic] of [
      ['journalSeq', INVALID_ENVELOPE_NUMBERS, /journalSeq must be a non-negative safe integer/i],
      ['journalEpoch', [['zero', 0], ...INVALID_ENVELOPE_NUMBERS], /journalEpoch must be a positive safe integer or null/i]
    ]) {
      for (const [label, value] of cases) {
        const payload = { ...legacyPayload(schemaVersion), [field]: value };
        const imported = createShadowGraph({ now: () => NOW });
        const importBefore = imported.exportData();
        assert.throws(() => imported.importData(payload), diagnostic, `schema ${schemaVersion} ${field} ${label}: import`);
        assert.deepEqual(imported.exportData(), importBefore, `schema ${schemaVersion} ${field} ${label}: import atomicity`);

        const replaced = seededGraph();
        const replaceBefore = replaced.exportData();
        assert.throws(() => replaced.replaceData(payload), diagnostic, `schema ${schemaVersion} ${field} ${label}: replacement`);
        assert.deepEqual(replaced.exportData(), replaceBefore, `schema ${schemaVersion} ${field} ${label}: replacement atomicity`);
        assert.throws(() => validateRestorePayload(payload, { now: () => NOW }), diagnostic, `schema ${schemaVersion} ${field} ${label}: restore validation`);

        if (field === 'journalEpoch') {
          const report = rebuildProjection(payload.journal, {
            journalEpoch: value,
            sourceSchemaVersion: schemaVersion
          });
          assert.equal(report.rebuildable, false, `schema ${schemaVersion} ${field} ${label}: rebuild rejects`);
          assert.equal(report.reason, 'journal epoch must be a positive safe integer or null', `schema ${schemaVersion} ${field} ${label}: rebuild diagnostic`);
        }
      }
    }
  }
});

test('DS-P1-009 rounded unsafe duplicates are rejected as unsafe before duplicate ordering can be guessed', () => {
  const roundedLeft = Number.MAX_SAFE_INTEGER + 1;
  const roundedRight = Number.MAX_SAFE_INTEGER + 2;
  assert.equal(roundedLeft, roundedRight, 'the two mathematical values collide after binary64 rounding');

  for (const schemaVersion of [1, 2]) {
    const payload = withJournalSequence(schemaVersion, roundedLeft);
    payload.journal.push({
      ...payload.journal[1],
      id: `legacy-rounded-duplicate-${schemaVersion}`,
      seq: roundedRight
    });
    assert.throws(() => createShadowGraph({ now: () => NOW }).importData(payload), INVALID_SEQUENCE, `schema ${schemaVersion}: import`);
    assert.throws(() => validateRestorePayload(payload, { now: () => NOW }), INVALID_SEQUENCE, `schema ${schemaVersion}: restore validation`);
    const report = rebuildProjection(payload.journal, { journalEpoch: 1, sourceSchemaVersion: schemaVersion });
    assert.equal(report.rebuildable, false);
    assert.equal(report.reason, 'journal contains invalid sequence numbers');
    assert.equal(report.skipped.filter((item) => item.why === 'invalid_journal_sequence').length, 2);
    assert.deepEqual(report.duplicates, [], 'unsafe rounded values never enter duplicate ordering');
  }
});

test('DS-P1-009 schemas 1/2 reject unsafe projection-baseline sequences before placement or fold', () => {
  for (const schemaVersion of [1, 2]) {
    for (const [label, seq] of INVALID_ENTRY_SEQUENCES) {
      const payload = legacyPayload(schemaVersion);
      payload.journal[0].seq = seq;
      const diagnostic = /journal\[0\]\.seq must be a positive safe integer/i;
      assert.throws(() => createShadowGraph({ now: () => NOW }).importData(payload), diagnostic, `schema ${schemaVersion} ${label}: import`);
      assert.throws(() => validateRestorePayload(payload, { now: () => NOW }), diagnostic, `schema ${schemaVersion} ${label}: restore validation`);
      const report = rebuildProjection(payload.journal, { journalEpoch: 1, sourceSchemaVersion: schemaVersion });
      assert.equal(report.rebuildable, false, `schema ${schemaVersion} ${label}: rebuild rejects`);
      assert.equal(report.reason, 'journal contains invalid sequence numbers');
      assert.equal(report.applied, 0, 'invalid baseline is never folded');
    }
  }
});

function legacyHardGapPayload(schemaVersion, ledger = [2], markerSeq = 3) {
  const record = legacyDecision(schemaVersion, `legacy-gap-${schemaVersion}`);
  return {
    schemaVersion,
    revision: 0,
    records: [],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: [
      {
        id: `legacy-gap-seed-${schemaVersion}`,
        seq: 1,
        type: 'decision.recorded',
        at: NOW,
        project: record.project,
        entityKind: 'decision',
        entityId: record.id,
        schemaVersion,
        payload: record,
        provenance: { actor: null, client: null, sessionId: null }
      },
      {
        id: `legacy-gap-marker-${schemaVersion}`,
        seq: markerSeq,
        type: 'project.purged',
        at: NOW,
        project: record.project,
        entityKind: 'project',
        entityId: record.project,
        schemaVersion,
        payload: {
          project: record.project,
          mode: 'hard',
          removed: 1,
          removedJournalSequences: ledger,
          purgedEntityIds: [record.id]
        },
        provenance: { actor: null, client: null, sessionId: null }
      }
    ],
    journalSeq: Number.isSafeInteger(markerSeq) && markerSeq > 0 ? markerSeq : 3,
    journalEpoch: 1
  };
}

const UNSAFE_GAP_RELATIONS = Object.freeze([
  ['negative ledger', [-1], 3, /positive safe integers/i],
  ['zero ledger', [0], 3, /positive safe integers/i],
  ['fractional ledger', [1.5], 3, /positive safe integers/i],
  ['NaN ledger', [Number.NaN], 3, /positive safe integers/i],
  ['infinite ledger', [Number.POSITIVE_INFINITY], 3, /positive safe integers/i],
  ['unsafe ledger', [Number.MAX_SAFE_INTEGER + 1], 3, /positive safe integers/i],
  ['duplicate ledger', [2, 2], 3, /duplicate removedJournalSequences/i],
  ['present sequence claim', [1], 3, /not an actual missing journal sequence/i],
  ['noncausal marker claim', [3], 3, /strictly earlier/i],
  ['uncovered gap', [], 3, /does not explain journal sequence 2|cannot cover declared gap/i]
]);

test('DS-P1-009 schemas 1/2 reject unsafe hard-gap ledger relations across import, replacement, validation, and rebuild', () => {
  for (const schemaVersion of [1, 2]) {
    for (const [label, ledger, markerSeq, diagnostic] of UNSAFE_GAP_RELATIONS) {
      const payload = legacyHardGapPayload(schemaVersion, ledger, markerSeq);
      const imported = createShadowGraph({ now: () => NOW });
      const importBefore = imported.exportData();
      assert.throws(() => imported.importData(payload), diagnostic, `schema ${schemaVersion} ${label}: import`);
      assert.deepEqual(imported.exportData(), importBefore, `schema ${schemaVersion} ${label}: import atomicity`);

      const replaced = seededGraph();
      const replaceBefore = replaced.exportData();
      assert.throws(() => replaced.replaceData(payload), diagnostic, `schema ${schemaVersion} ${label}: replacement`);
      assert.deepEqual(replaced.exportData(), replaceBefore, `schema ${schemaVersion} ${label}: replacement atomicity`);
      assert.throws(() => validateRestorePayload(payload, { now: () => NOW }), diagnostic, `schema ${schemaVersion} ${label}: restore validation`);

      const report = rebuildProjection(payload.journal, { journalEpoch: 1, sourceSchemaVersion: schemaVersion });
      assert.equal(report.rebuildable, false, `schema ${schemaVersion} ${label}: rebuild rejects`);
    }
  }
});

const SQLITE_AVAILABLE = (await getRuntimeCapabilities()).nodeSqlite.available;
const SQLITE_TEST_OPTIONS = SQLITE_AVAILABLE ? {} : { skip: NODE_SQLITE_NOT_APPLICABLE_REASON };

async function writeJson(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function livePayload(id) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({
    id,
    project: 'ds-p1-009-live',
    title: 'Must survive rejected restore',
    chosen: 'keep'
  });
  return graph.exportData();
}

async function seedJson(path, id) {
  const store = createJsonFileStore(path);
  await store.save(livePayload(id));
  const state = await store.load();
  store.close();
  return state;
}

function runRestoreCli(destination, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', 'restore', source], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        SHADOWGRAPH_FILE: destination,
        SHADOWGRAPH_STORAGE: 'json'
      },
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
    const error = new Error(`MCP exited before replying (code ${code}): ${stderr}`);
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  return {
    call(request) {
      return new Promise((resolve, reject) => {
        const key = JSON.stringify(request.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`MCP timed out: ${stderr}`));
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

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve) => server.close(resolve));
}

test('DS-P1-009 JSON restore rejects schemas 1/2 before replacement and preserves exact destination bytes across restart', async (t) => {
  for (const schemaVersion of [1, 2]) {
    const directory = await scratchDirectory(t, `shadowgraph-ds-p1-009-json-${schemaVersion}-`);
    const source = join(directory, 'unsafe.json');
    const destination = join(directory, 'live.json');
    await writeJson(source, withJournalSequence(schemaVersion, Number.MAX_SAFE_INTEGER + 1));
    const beforeState = await seedJson(destination, `json-kept-${schemaVersion}`);
    const beforeBytes = await readFile(destination);

    await assert.rejects(restoreFile(source, destination), INVALID_SEQUENCE, `schema ${schemaVersion}: restore diagnostic`);
    assert.deepEqual(await readFile(destination), beforeBytes, `schema ${schemaVersion}: exact JSON bytes are unchanged`);

    const restarted = createJsonFileStore(destination);
    assert.deepEqual(await restarted.load(), beforeState, `schema ${schemaVersion}: restarted JSON state is unchanged`);
    restarted.close();
  }
});

test('DS-P1-009 SQLite restore rejects schemas 1/2 before replacement and preserves exact database bytes and state across restart', SQLITE_TEST_OPTIONS, async (t) => {
  for (const schemaVersion of [1, 2]) {
    const directory = await scratchDirectory(t, `shadowgraph-ds-p1-009-sqlite-${schemaVersion}-`);
    const source = join(directory, 'unsafe.db');
    const destination = join(directory, 'live.db');

    const sourceStore = await createSqliteStore(source);
    await sourceStore.save(withJournalSequence(schemaVersion, Number.MAX_SAFE_INTEGER + 1));
    sourceStore.close();

    const seedStore = await createSqliteStore(destination);
    await seedStore.save(livePayload(`sqlite-kept-${schemaVersion}`));
    const beforeState = await seedStore.load();
    seedStore.close();
    const beforeBytes = await readFile(destination);

    const restoreStore = await createSqliteStore(destination);
    await assert.rejects(restoreStore.restore(source), INVALID_SEQUENCE, `schema ${schemaVersion}: restore diagnostic`);
    restoreStore.close();
    assert.deepEqual(await readFile(destination), beforeBytes, `schema ${schemaVersion}: exact SQLite main-file bytes are unchanged`);

    const restarted = await createSqliteStore(destination);
    assert.deepEqual(await restarted.load(), beforeState, `schema ${schemaVersion}: restarted SQLite state is unchanged`);
    restarted.close();
  }
});

test('DS-P1-009 CLI, HTTP, and MCP restore reject schemas 1/2 atomically and restart on the original JSON state', async (t) => {
  for (const schemaVersion of [1, 2]) {
    const directory = await scratchDirectory(t, `shadowgraph-ds-p1-009-surfaces-${schemaVersion}-`);
    const source = join(directory, 'unsafe.json');
    await writeJson(source, withJournalSequence(schemaVersion, Number.MAX_SAFE_INTEGER + 1));

    await t.test(`schema ${schemaVersion} CLI`, async () => {
      const destination = join(directory, 'cli.json');
      const beforeState = await seedJson(destination, `cli-kept-${schemaVersion}`);
      const beforeBytes = await readFile(destination);
      const result = await runRestoreCli(destination, source);
      assert.notEqual(result.code, 0);
      assert.match(result.stderr, INVALID_SEQUENCE);
      assert.deepEqual(await readFile(destination), beforeBytes, 'CLI rejection preserves exact bytes');
      const restarted = createJsonFileStore(destination);
      assert.deepEqual(await restarted.load(), beforeState, 'CLI destination restarts on original state');
      restarted.close();
    });

    await t.test(`schema ${schemaVersion} HTTP`, async () => {
      const destination = join(directory, 'http.json');
      const beforeState = await seedJson(destination, `http-kept-${schemaVersion}`);
      const beforeBytes = await readFile(destination);
      const app = await createShadowGraphServer({ file: destination, now: () => NOW });
      const liveBefore = app.graph.exportData();
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      try {
        const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source })
        });
        const body = await response.json();
        assert.equal(response.status, 400);
        assert.match(body.error, INVALID_SEQUENCE);
        assert.deepEqual(app.graph.exportData(), liveBefore, 'HTTP rejection preserves live state');
        assert.deepEqual(await readFile(destination), beforeBytes, 'HTTP rejection preserves exact bytes');
      } finally {
        await closeServer(app.server);
      }
      const restarted = createJsonFileStore(destination);
      assert.deepEqual(await restarted.load(), beforeState, 'HTTP destination restarts on original state');
      restarted.close();
    });

    await t.test(`schema ${schemaVersion} MCP`, async () => {
      const destination = join(directory, 'mcp.json');
      const beforeState = await seedJson(destination, `mcp-kept-${schemaVersion}`);
      const beforeBytes = await readFile(destination);
      const rpc = startMcp(destination);
      try {
        await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
        const response = await rpc.call({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'shadowgraph_restore', arguments: { source } }
        });
        assert.ok(response.error);
        assert.match(response.error.message, INVALID_SEQUENCE);
      } finally {
        await rpc.stop();
      }
      assert.deepEqual(await readFile(destination), beforeBytes, 'MCP rejection preserves exact bytes');
      const restarted = createJsonFileStore(destination);
      assert.deepEqual(await restarted.load(), beforeState, 'MCP destination restarts on original state');
      restarted.close();
    });
  }
});

function journalLessLegacyPayload(schemaVersion) {
  const record = legacyDecision(schemaVersion, `journal-less-${schemaVersion}`);
  return {
    schemaVersion,
    revision: 0,
    records: [record],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [{
      id: `legacy-event-${schemaVersion}`,
      type: 'decision.recorded',
      at: NOW,
      project: record.project,
      recordId: record.id
    }],
    journal: [],
    journalSeq: 0,
    journalEpoch: null
  };
}

test('DS-P1-009 canonical journal-less and hard-gap schema 1/2 data retains migration compatibility across repeated restart', () => {
  for (const schemaVersion of [1, 2]) {
    assert.doesNotThrow(() => validateRestorePayload(journalLessLegacyPayload(schemaVersion), { now: () => NOW }));
    let payload = journalLessLegacyPayload(schemaVersion);
    for (let restart = 0; restart < 3; restart += 1) {
      const graph = createShadowGraph({ now: () => NOW });
      assert.doesNotThrow(() => graph.importData(payload), `schema ${schemaVersion} restart ${restart}: import`);
      assert.equal(graph.validate().valid, true, `schema ${schemaVersion} restart ${restart}: validation`);
      assert.equal(graph.rebuild().rebuildable, true, `schema ${schemaVersion} restart ${restart}: rebuild`);
      assert.deepEqual(graph.rebuild().projection.records.map((record) => record.id), [`journal-less-${schemaVersion}`]);
      assert.equal(graph.exportData().journal.some((entry) => entry.type === 'legacy_metadata_event'), true);
      assert.equal(graph.exportData().journal.some((entry) => entry.type === 'projection.baseline'), true);
      payload = graph.exportData();
    }

    const hardGap = legacyHardGapPayload(schemaVersion);
    const hardGapGraph = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => hardGapGraph.importData(hardGap), `schema ${schemaVersion}: valid hard-gap import`);
    assert.equal(hardGapGraph.validate().valid, true, `schema ${schemaVersion}: valid hard-gap validation`);
    assert.doesNotThrow(() => validateRestorePayload(hardGap, { now: () => NOW }), `schema ${schemaVersion}: valid hard-gap restore validation`);
  }
});

test('DS-P1-009 canonical schema 1/2 data restores through JSON and migrates after restart', async (t) => {
  for (const schemaVersion of [1, 2]) {
    const directory = await scratchDirectory(t, `shadowgraph-ds-p1-009-valid-json-${schemaVersion}-`);
    const source = join(directory, 'legacy.json');
    const destination = join(directory, 'live.json');
    await writeJson(source, journalLessLegacyPayload(schemaVersion));
    await seedJson(destination, `valid-json-old-${schemaVersion}`);
    await restoreFile(source, destination);
    const store = createJsonFileStore(destination);
    const restoredPayload = await store.load();
    store.close();
    const restarted = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => restarted.importData(restoredPayload));
    assert.equal(restarted.validate().valid, true);
    assert.equal(restarted.rebuild().rebuildable, true);
    assert.deepEqual(restarted.exportData().records.map((record) => record.id), [`journal-less-${schemaVersion}`]);
  }
});

test('DS-P1-009 canonical schema 1/2 data restores through SQLite and migrates after restart', SQLITE_TEST_OPTIONS, async (t) => {
  for (const schemaVersion of [1, 2]) {
    const directory = await scratchDirectory(t, `shadowgraph-ds-p1-009-valid-sqlite-${schemaVersion}-`);
    const source = join(directory, 'legacy.db');
    const destination = join(directory, 'live.db');
    const sourceStore = await createSqliteStore(source);
    await sourceStore.save(journalLessLegacyPayload(schemaVersion));
    sourceStore.close();
    const destinationStore = await createSqliteStore(destination);
    await destinationStore.save(livePayload(`valid-sqlite-old-${schemaVersion}`));
    await destinationStore.restore(source);
    destinationStore.close();
    const reopened = await createSqliteStore(destination);
    const restoredPayload = await reopened.load();
    reopened.close();
    const restarted = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => restarted.importData(restoredPayload));
    assert.equal(restarted.validate().valid, true);
    assert.equal(restarted.rebuild().rebuildable, true);
    assert.deepEqual(restarted.exportData().records.map((record) => record.id), [`journal-less-${schemaVersion}`]);
  }
});

function duplicateDecisionEntry(schemaVersion, { id, seq, entityId }) {
  const record = legacyDecision(schemaVersion, entityId);
  return {
    id,
    seq,
    type: 'decision.recorded',
    at: NOW,
    project: record.project,
    entityKind: 'decision',
    entityId,
    schemaVersion,
    payload: record,
    provenance: { actor: null, client: null, sessionId: null }
  };
}

function duplicateBaselineEntry(schemaVersion, { id, seq }) {
  return {
    id,
    seq,
    type: 'projection.baseline',
    at: NOW,
    project: null,
    entityKind: null,
    entityId: null,
    schemaVersion,
    derivedFrom: 'live_state_at_migration',
    payload: { records: [], facts: [], relations: [], idempotency: [] },
    provenance: { actor: null, client: null, sessionId: null }
  };
}

function duplicatePurgeMarkerEntry(schemaVersion, { id, seq }) {
  return {
    id,
    seq,
    type: 'project.purged',
    at: NOW,
    project: 'ds-p1-duplicate-purge',
    entityKind: 'project',
    entityId: null,
    schemaVersion,
    payload: {
      project: 'ds-p1-duplicate-purge',
      mode: 'logical',
      removed: 0,
      purgedEntityIds: []
    },
    provenance: { actor: null, client: null, sessionId: null }
  };
}

function duplicateLegacyMetadataEntry(schemaVersion, { id, seq, entityId }) {
  return {
    id,
    seq,
    type: 'legacy_metadata_event',
    at: NOW,
    project: null,
    entityKind: null,
    entityId,
    schemaVersion,
    payload: null,
    replayable: false,
    originalType: 'decision.recorded',
    provenance: { actor: null, client: null, sessionId: null }
  };
}

function duplicateEntry(kind, schemaVersion, values) {
  if (kind === 'decision') return duplicateDecisionEntry(schemaVersion, values);
  if (kind === 'baseline') return duplicateBaselineEntry(schemaVersion, values);
  if (kind === 'marker') return duplicatePurgeMarkerEntry(schemaVersion, values);
  if (kind === 'metadata') return duplicateLegacyMetadataEntry(schemaVersion, values);
  throw new Error(`Unknown duplicate fixture kind ${kind}`);
}

const DUPLICATE_SEQUENCE_CASES = Object.freeze([
  {
    label: 'two replayable decisions with different ids at the minimum sequence',
    kinds: ['decision', 'decision'],
    sameId: false,
    seq: 1,
    journalSeq: 1,
    journalEpoch: 1
  },
  {
    label: 'two replayable decisions with the same id at the maximum safe sequence',
    kinds: ['decision', 'decision'],
    sameId: true,
    seq: Number.MAX_SAFE_INTEGER,
    journalSeq: Number.MAX_SAFE_INTEGER,
    journalEpoch: Number.MAX_SAFE_INTEGER
  },
  {
    label: 'replayable and non-replayable entries with different ids',
    kinds: ['decision', 'metadata'],
    sameId: false,
    seq: 1,
    journalSeq: Number.MAX_SAFE_INTEGER,
    journalEpoch: 1
  },
  {
    label: 'duplicate migration baselines with different ids',
    kinds: ['baseline', 'baseline'],
    sameId: false,
    seq: Number.MAX_SAFE_INTEGER,
    journalSeq: Number.MAX_SAFE_INTEGER,
    journalEpoch: Number.MAX_SAFE_INTEGER
  },
  {
    label: 'duplicate legacy purge markers with the same id',
    kinds: ['marker', 'marker'],
    sameId: true,
    seq: 1,
    journalSeq: 1,
    journalEpoch: 1
  },
  {
    label: 'duplicate legacy metadata entries with different ids',
    kinds: ['metadata', 'metadata'],
    sameId: false,
    seq: Number.MAX_SAFE_INTEGER,
    journalSeq: Number.MAX_SAFE_INTEGER,
    journalEpoch: Number.MAX_SAFE_INTEGER
  },
  {
    label: 'migration baseline and legacy purge marker collision',
    kinds: ['baseline', 'marker'],
    sameId: false,
    seq: 1,
    journalSeq: Number.MAX_SAFE_INTEGER,
    journalEpoch: 1
  }
]);

function duplicateSequencePayload(schemaVersion, scenario, reversed = false) {
  const sharedId = `duplicate-shared-${schemaVersion}`;
  const entries = scenario.kinds.map((kind, index) => duplicateEntry(kind, schemaVersion, {
    id: scenario.sameId ? sharedId : `duplicate-${kind}-${schemaVersion}-${index}`,
    seq: scenario.seq,
    entityId: scenario.sameId ? sharedId : `duplicate-entity-${schemaVersion}-${index}`
  }));
  return {
    schemaVersion,
    revision: 0,
    records: [],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: reversed ? entries.reverse() : entries,
    journalSeq: scenario.journalSeq,
    journalEpoch: scenario.journalEpoch
  };
}

function assertDuplicateSequenceError(action, label) {
  let thrown = null;
  try { action(); }
  catch (error) { thrown = error; }
  assert.ok(thrown, `${label}: duplicate input must be rejected`);
  assert.equal(thrown.code, DUPLICATE_SEQUENCE_CODE, `${label}: stable error code`);
  assert.match(thrown.message, DUPLICATE_SEQUENCE, `${label}: stable diagnostic in message`);
  return thrown;
}

async function assertDuplicateSequenceRejection(action, label) {
  let thrown = null;
  try { await action(); }
  catch (error) { thrown = error; }
  assert.ok(thrown, `${label}: duplicate input must be rejected`);
  assert.equal(thrown.code, DUPLICATE_SEQUENCE_CODE, `${label}: stable error code`);
  assert.match(thrown.message, DUPLICATE_SEQUENCE, `${label}: stable diagnostic in message`);
  return thrown;
}

function assertDuplicateSequenceRebuild(report, scenario, label) {
  assert.equal(report.rebuildable, false, `${label}: ambiguous journal is not rebuildable`);
  assert.match(report.reason, /duplicate sequence/i, `${label}: rebuild explains the duplicate`);
  assert.deepEqual(report.duplicates, [{ seq: scenario.seq, count: 2 }], `${label}: duplicate summary is stable`);
  assert.equal(report.skipped.filter((item) => item.why === DUPLICATE_SEQUENCE_CODE).length, 2, `${label}: neither colliding entry is folded`);
  assert.equal(report.applied, 0, `${label}: arbitrary same-sequence ordering is never applied`);
  assert.deepEqual(report.projection, {
    schemaVersion: 5,
    records: [],
    facts: [],
    relations: [],
    idempotency: []
  }, `${label}: ambiguous input cannot choose a projection winner`);
}

test('DS-P1-010 every explicit positive-safe sequence is unique in schemas 1/2 before import, replace, restore validation, or rebuild fold', () => {
  for (const schemaVersion of [1, 2]) {
    for (const scenario of DUPLICATE_SEQUENCE_CASES) {
      const reports = [];
      for (const reversed of [false, true]) {
        const order = reversed ? 'reversed' : 'forward';
        const label = `schema ${schemaVersion} ${scenario.label} ${order}`;
        const payload = duplicateSequencePayload(schemaVersion, scenario, reversed);

        const imported = createShadowGraph({ now: () => NOW });
        const importBefore = JSON.stringify(imported.exportData());
        assertDuplicateSequenceError(() => imported.importData(payload), `${label}: import`);
        assert.equal(JSON.stringify(imported.exportData()), importBefore, `${label}: import preserves exact live serialization`);

        const replaced = seededGraph();
        const replaceBefore = JSON.stringify(replaced.exportData());
        assertDuplicateSequenceError(() => replaced.replaceData(payload), `${label}: replace`);
        assert.equal(JSON.stringify(replaced.exportData()), replaceBefore, `${label}: replace preserves exact live serialization`);

        assertDuplicateSequenceError(
          () => validateRestorePayload(payload, { now: () => NOW }),
          `${label}: restore validation`
        );

        const report = rebuildProjection(payload.journal, {
          journalEpoch: payload.journalEpoch,
          sourceSchemaVersion: schemaVersion
        });
        assertDuplicateSequenceRebuild(report, scenario, `${label}: pure rebuild`);
        reports.push(report);
      }
      assert.equal(reports[0].reason, reports[1].reason, `schema ${schemaVersion} ${scenario.label}: diagnosis is reorder invariant`);
      assert.deepEqual(reports[0].duplicates, reports[1].duplicates, `schema ${schemaVersion} ${scenario.label}: duplicate summary is reorder invariant`);
      assert.deepEqual(reports[0].projection, reports[1].projection, `schema ${schemaVersion} ${scenario.label}: no array-order winner`);
    }
  }
});

test('DS-P1-010 duplicate sequence diagnostic takes precedence over same journal ids in every supported schema', () => {
  const sameIdScenario = DUPLICATE_SEQUENCE_CASES.find((scenario) => scenario.sameId && scenario.kinds.every((kind) => kind === 'decision'));
  assert.ok(sameIdScenario);
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    for (const reversed of [false, true]) {
      const graph = createShadowGraph({ now: () => NOW });
      const before = JSON.stringify(graph.exportData());
      assertDuplicateSequenceError(
        () => graph.importData(duplicateSequencePayload(schemaVersion, sameIdScenario, reversed)),
        `schema ${schemaVersion} same ids ${reversed ? 'reversed' : 'forward'}`
      );
      assert.equal(JSON.stringify(graph.exportData()), before, `schema ${schemaVersion}: preflight is state-atomic`);
    }
  }
});

test('DS-P1-010 explicitly unnumbered legacy journal arrays remain preserved as metadata-only history', () => {
  for (const schemaVersion of [1, 2]) {
    const payload = {
      schemaVersion,
      revision: 0,
      records: [],
      facts: [],
      relations: [],
      reviewSignals: [],
      idempotency: [],
      events: [],
      journal: [
        { id: `unnumbered-left-${schemaVersion}`, type: 'legacy_metadata_event', schemaVersion, payload: null, replayable: false },
        { id: `unnumbered-right-${schemaVersion}`, type: 'legacy_metadata_event', schemaVersion, payload: null, replayable: false }
      ],
      journalSeq: 0,
      journalEpoch: null
    };
    const graph = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => graph.importData(payload), `schema ${schemaVersion}: unnumbered legacy import`);
    assert.equal(graph.exportData().journal.length, 2, `schema ${schemaVersion}: both unnumbered entries preserved`);
    assert.equal(graph.exportData().journal.every((entry) => entry.seq === undefined), true, `schema ${schemaVersion}: migration does not invent source order`);
    const rebuild = graph.rebuild();
    assert.equal(rebuild.legacy.filter((entry) => entry.why === 'metadata_only_no_seq').length, 2, `schema ${schemaVersion}: both entries declared legacy`);
    assert.deepEqual(rebuild.duplicates, [], `schema ${schemaVersion}: missing sequences are not duplicates`);
  }
});

function fixtureName(scenario, index) {
  return `${index}-${scenario.label.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()}`;
}

test('DS-P1-010 JSON restore rejects every schema 1/2 duplicate table row before replacement and preserves exact bytes across restart', async (t) => {
  for (const schemaVersion of [1, 2]) {
    const directory = await scratchDirectory(t, `shadowgraph-ds-p1-010-json-${schemaVersion}-`);
    const destination = join(directory, 'live.json');
    const beforeState = await seedJson(destination, `json-duplicate-kept-${schemaVersion}`);
    const beforeBytes = await readFile(destination);

    for (const [index, scenario] of DUPLICATE_SEQUENCE_CASES.entries()) {
      const source = join(directory, `${fixtureName(scenario, index)}.json`);
      await writeJson(source, duplicateSequencePayload(schemaVersion, scenario, index % 2 === 1));
      await assertDuplicateSequenceRejection(
        () => restoreFile(source, destination),
        `schema ${schemaVersion} ${scenario.label}: JSON restore`
      );
      assert.deepEqual(await readFile(destination), beforeBytes, `schema ${schemaVersion} ${scenario.label}: exact JSON destination bytes`);
      const restarted = createJsonFileStore(destination);
      assert.deepEqual(await restarted.load(), beforeState, `schema ${schemaVersion} ${scenario.label}: JSON restart state`);
      restarted.close();
    }
  }
});

test('DS-P1-010 SQLite restore rejects every schema 1/2 duplicate table row before replacement and preserves exact bytes across restart', SQLITE_TEST_OPTIONS, async (t) => {
  for (const schemaVersion of [1, 2]) {
    const directory = await scratchDirectory(t, `shadowgraph-ds-p1-010-sqlite-${schemaVersion}-`);
    const destination = join(directory, 'live.db');
    const seedStore = await createSqliteStore(destination);
    await seedStore.save(livePayload(`sqlite-duplicate-kept-${schemaVersion}`));
    const beforeState = await seedStore.load();
    seedStore.close();
    const beforeBytes = await readFile(destination);

    for (const [index, scenario] of DUPLICATE_SEQUENCE_CASES.entries()) {
      const source = join(directory, `${fixtureName(scenario, index)}.db`);
      const sourceStore = await createSqliteStore(source);
      const sqlitePayload = duplicateSequencePayload(schemaVersion, scenario, index % 2 === 1);
      // SQLite's journal primary key correctly refuses duplicate journal ids at
      // fixture-write time. Keep that backend fixture readable by uniquifying only
      // the ids; the positive-safe sequence collision remains the domain defect.
      sqlitePayload.journal = sqlitePayload.journal.map((entry, entryIndex) => ({
        ...entry,
        id: `${entry.id}-sqlite-${entryIndex}`
      }));
      await sourceStore.save(sqlitePayload);
      sourceStore.close();

      const restoreStore = await createSqliteStore(destination);
      try {
        await assertDuplicateSequenceRejection(
          () => restoreStore.restore(source),
          `schema ${schemaVersion} ${scenario.label}: SQLite restore`
        );
      } finally {
        restoreStore.close();
      }
      assert.deepEqual(await readFile(destination), beforeBytes, `schema ${schemaVersion} ${scenario.label}: exact SQLite main-file bytes`);
      const restarted = await createSqliteStore(destination);
      assert.deepEqual(await restarted.load(), beforeState, `schema ${schemaVersion} ${scenario.label}: SQLite restart state`);
      restarted.close();
    }
  }
});

test('DS-P1-010 CLI, HTTP, and MCP reject the schema 1/2 duplicate table with exact live/durable atomicity and restart', async (t) => {
  for (const schemaVersion of [1, 2]) {
    const directory = await scratchDirectory(t, `shadowgraph-ds-p1-010-surfaces-${schemaVersion}-`);
    const sources = [];
    for (const [index, scenario] of DUPLICATE_SEQUENCE_CASES.entries()) {
      const source = join(directory, `${fixtureName(scenario, index)}.json`);
      await writeJson(source, duplicateSequencePayload(schemaVersion, scenario, index % 2 === 1));
      sources.push([scenario, source]);
    }

    await t.test(`schema ${schemaVersion} CLI duplicate table`, async () => {
      const destination = join(directory, 'cli-duplicates.json');
      const beforeState = await seedJson(destination, `cli-duplicate-kept-${schemaVersion}`);
      const beforeBytes = await readFile(destination);
      for (const [scenario, source] of sources) {
        const result = await runRestoreCli(destination, source);
        assert.notEqual(result.code, 0, `${scenario.label}: CLI rejects`);
        assert.match(result.stderr, DUPLICATE_SEQUENCE, `${scenario.label}: CLI stable diagnostic`);
        assert.deepEqual(await readFile(destination), beforeBytes, `${scenario.label}: CLI exact durable bytes`);
        const restarted = createJsonFileStore(destination);
        assert.deepEqual(await restarted.load(), beforeState, `${scenario.label}: CLI restart state`);
        restarted.close();
      }
    });

    await t.test(`schema ${schemaVersion} HTTP duplicate table`, async () => {
      const destination = join(directory, 'http-duplicates.json');
      const beforeState = await seedJson(destination, `http-duplicate-kept-${schemaVersion}`);
      const beforeBytes = await readFile(destination);
      const app = await createShadowGraphServer({ file: destination, now: () => NOW });
      const liveBefore = JSON.stringify(app.graph.exportData());
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      try {
        for (const [scenario, source] of sources) {
          const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ source })
          });
          const body = await response.json();
          assert.equal(response.status, 400, `${scenario.label}: HTTP rejects`);
          assert.match(body.error, DUPLICATE_SEQUENCE, `${scenario.label}: HTTP stable diagnostic`);
          assert.equal(JSON.stringify(app.graph.exportData()), liveBefore, `${scenario.label}: HTTP exact live serialization`);
          assert.deepEqual(await readFile(destination), beforeBytes, `${scenario.label}: HTTP exact durable bytes`);
        }
      } finally {
        await closeServer(app.server);
      }
      const restarted = createJsonFileStore(destination);
      assert.deepEqual(await restarted.load(), beforeState, 'HTTP destination restarts on original state');
      restarted.close();
    });

    await t.test(`schema ${schemaVersion} MCP duplicate table`, async () => {
      const destination = join(directory, 'mcp-duplicates.json');
      const beforeState = await seedJson(destination, `mcp-duplicate-kept-${schemaVersion}`);
      const beforeBytes = await readFile(destination);
      const rpc = startMcp(destination);
      try {
        await rpc.call({ jsonrpc: '2.0', id: `list-${schemaVersion}`, method: 'tools/list' });
        for (const [index, [scenario, source]] of sources.entries()) {
          const response = await rpc.call({
            jsonrpc: '2.0',
            id: `restore-${schemaVersion}-${index}`,
            method: 'tools/call',
            params: { name: 'shadowgraph_restore', arguments: { source } }
          });
          assert.ok(response.error, `${scenario.label}: MCP rejects`);
          assert.match(response.error.message, DUPLICATE_SEQUENCE, `${scenario.label}: MCP stable diagnostic`);
          const validationResponse = await rpc.call({
            jsonrpc: '2.0',
            id: `validate-${schemaVersion}-${index}`,
            method: 'tools/call',
            params: { name: 'shadowgraph_validate', arguments: {} }
          });
          assert.equal(validationResponse.error, undefined, `${scenario.label}: MCP live graph remains readable`);
          const validation = JSON.parse(validationResponse.result.content[0].text);
          assert.equal(validation.valid, true, `${scenario.label}: MCP live graph remains valid`);
          assert.deepEqual(await readFile(destination), beforeBytes, `${scenario.label}: MCP exact durable bytes while live`);
        }
      } finally {
        await rpc.stop();
      }
      assert.deepEqual(await readFile(destination), beforeBytes, 'MCP destination keeps exact bytes after shutdown');
      const restarted = createJsonFileStore(destination);
      assert.deepEqual(await restarted.load(), beforeState, 'MCP destination restarts on original state');
      restarted.close();
    });
  }
});

const ABSENT_SEQUENCE_VARIANTS = Object.freeze([
  ['missing', (entry) => { delete entry.seq; }],
  ['explicit undefined', (entry) => { entry.seq = undefined; }],
  ['null', (entry) => { entry.seq = null; }]
]);

function replayableEntry(type, schemaVersion, sequence = 1) {
  const entityKind = JOURNAL_TYPE_ENTITY_KIND[type] ?? null;
  const entityId = `seq-less-${type.replaceAll('.', '-')}-${schemaVersion}`;
  let payload;
  if (type === 'projection.baseline') {
    payload = { records: [], facts: [], relations: [], idempotency: [] };
  } else if (type === 'project.purged') {
    payload = {
      project: 'seq-less-project',
      mode: 'logical',
      removed: 0,
      removedJournalSequences: []
    };
  } else if (entityKind === 'fact') {
    payload = {
      id: entityId,
      kind: 'fact',
      schemaVersion,
      project: 'seq-less-project',
      key: entityId,
      value: true,
      status: 'active',
      verificationStatus: 'unverified'
    };
  } else if (entityKind === 'relation') {
    payload = {
      id: entityId,
      kind: 'relation',
      schemaVersion,
      project: 'seq-less-project',
      from: 'seq-less-left',
      to: 'seq-less-right',
      relation: 'supports'
    };
  } else if (entityKind === 'memory') {
    payload = {
      id: entityId,
      kind: 'memory',
      schemaVersion,
      project: 'seq-less-project',
      memoryType: 'semantic',
      key: entityId,
      text: 'Sequence identity is structural',
      status: 'active'
    };
  } else if (entityKind === 'attempt') {
    payload = {
      id: entityId,
      kind: 'attempt',
      schemaVersion,
      project: 'seq-less-project',
      action: 'probe',
      result: 'rejected'
    };
  } else {
    payload = {
      id: entityId,
      kind: 'decision',
      schemaVersion,
      project: 'seq-less-project',
      title: 'Reject sequence-less replay',
      chosen: 'reject',
      status: schemaVersion >= 5 ? 'proposed' : 'active',
      alternatives: [],
      confidence: 0.5
    };
  }

  return {
    id: `journal-${entityId}`,
    seq: sequence,
    type,
    at: NOW,
    project: type === 'projection.baseline' ? null : 'seq-less-project',
    entityKind,
    entityId: ['projection.baseline', 'project.purged'].includes(type) ? null : entityId,
    schemaVersion,
    ...(type === 'projection.baseline' ? { derivedFrom: 'live_state_at_migration' } : {}),
    payload,
    provenance: { actor: null, client: null, sessionId: null }
  };
}

function replayableSequencePayload(schemaVersion, type, variant) {
  const entry = replayableEntry(type, schemaVersion);
  variant(entry);
  return {
    schemaVersion,
    revision: 0,
    records: [],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: [entry],
    journalSeq: 0,
    journalEpoch: null
  };
}

function assertInvalidJournalSequence(action, label) {
  let thrown = null;
  try { action(); }
  catch (error) { thrown = error; }
  assert.ok(thrown, `${label}: must reject`);
  assert.equal(thrown.code, INVALID_JOURNAL_SEQUENCE_CODE, `${label}: stable error code`);
  assert.match(thrown.message, /invalid_journal_sequence/i, `${label}: stable diagnostic code in message`);
  assert.match(thrown.message, /seq must be a positive safe integer/i, `${label}: actionable diagnostic`);
  return thrown;
}

function collectMatrixFailure(failures, label, assertion) {
  try { assertion(); }
  catch (error) { failures.push(`${label}: ${error.message}`); }
}

test('DS-P1-011 every replayable type in schemas 1-5 requires a positive-safe sequence before import, replace, validation, or rebuild', () => {
  const failures = [];
  const emptyProjection = { schemaVersion: 5, records: [], facts: [], relations: [], idempotency: [] };
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    for (const type of REPLAYABLE_ENTRY_TYPES) {
      for (const [variantLabel, variant] of ABSENT_SEQUENCE_VARIANTS) {
        const label = `schema ${schemaVersion} ${type} ${variantLabel}`;
        const payload = replayableSequencePayload(schemaVersion, type, variant);

        const imported = createShadowGraph({ now: () => NOW });
        const importBefore = JSON.stringify(imported.exportData());
        collectMatrixFailure(failures, `${label}: import diagnostic`, () => assertInvalidJournalSequence(() => imported.importData(payload), `${label}: import`));
        collectMatrixFailure(failures, `${label}: import atomicity`, () => assert.equal(JSON.stringify(imported.exportData()), importBefore));

        const replaced = seededGraph();
        const replaceBefore = JSON.stringify(replaced.exportData());
        collectMatrixFailure(failures, `${label}: replace diagnostic`, () => assertInvalidJournalSequence(() => replaced.replaceData(payload), `${label}: replace`));
        collectMatrixFailure(failures, `${label}: replace atomicity`, () => assert.equal(JSON.stringify(replaced.exportData()), replaceBefore));

        collectMatrixFailure(failures, `${label}: restore validation`, () => {
          assertInvalidJournalSequence(() => validateRestorePayload(payload, { now: () => NOW }), `${label}: restore validation`);
        });

        collectMatrixFailure(failures, `${label}: pure rebuild`, () => {
          const report = rebuildProjection(payload.journal, {
            journalEpoch: payload.journalEpoch,
            sourceSchemaVersion: schemaVersion
          });
          assert.equal(report.rebuildable, false, 'invalid ordering identity blocks rebuildability');
          assert.equal(report.reason, 'journal contains invalid sequence numbers');
          assert.equal(report.applied, 0, 'no partial projection is applied');
          assert.deepEqual(report.projection, emptyProjection, 'no partial projection is exposed');
          assert.equal(report.skipped.filter((item) => item.why === INVALID_JOURNAL_SEQUENCE_CODE).length, 1);
          assert.equal(report.skipped.some((item) => item.why === NONCANONICAL_SCHEMA5_PURGE_ARTIFACT_CODE), false, 'sequence diagnosis precedes purge semantics');
        });
      }
    }
  }
  assert.equal(
    failures.length,
    0,
    `${failures.length} replayable sequence matrix assertion(s) failed:\n${failures.slice(0, 24).join('\n')}${failures.length > 24 ? `\n... ${failures.length - 24} more` : ''}`
  );
});

test('DS-P1-011 one invalid ordering key prevents a valid prefix from being exposed as an applied partial projection', () => {
  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    const valid = replayableEntry('decision.recorded', schemaVersion, 1);
    const invalid = replayableEntry('decision.recorded', schemaVersion, 2);
    delete invalid.seq;
    invalid.id += '-invalid';
    invalid.entityId += '-invalid';
    invalid.payload.id = invalid.entityId;
    const report = rebuildProjection([valid, invalid], { journalEpoch: 1, sourceSchemaVersion: schemaVersion });
    assert.equal(report.rebuildable, false, `schema ${schemaVersion}: invalid sequence blocks rebuild`);
    assert.equal(report.reason, 'journal contains invalid sequence numbers');
    assert.equal(report.applied, 0, `schema ${schemaVersion}: valid prefix is not presented as a partial projection`);
    assert.deepEqual(report.projection.records, [], `schema ${schemaVersion}: valid prefix is not exposed`);
    assert.equal(report.skipped.some((item) => item.why === INVALID_JOURNAL_SEQUENCE_CODE), true);
  }
});

test('DS-P2-011 unsafe schema-5 purge marker sequences diagnose invalid_journal_sequence before purge canonicality', () => {
  const variants = [
    ...ABSENT_SEQUENCE_VARIANTS,
    ...INVALID_ENTRY_SEQUENCES.map(([label, value]) => [label, (entry) => { entry.seq = value; }])
  ];
  for (const [label, variant] of variants) {
    const payload = replayableSequencePayload(5, 'project.purged', variant);
    const graph = seededGraph();
    const before = JSON.stringify(graph.exportData());
    const error = assertInvalidJournalSequence(() => graph.replaceData(payload), `schema 5 purge ${label}`);
    assert.equal(error.message.includes('noncanonical_schema5_purge_artifact'), false, `${label}: no competing purge diagnosis`);
    assert.equal(JSON.stringify(graph.exportData()), before, `${label}: replacement is atomic`);

    const report = rebuildProjection(payload.journal, { sourceSchemaVersion: 5 });
    assert.equal(report.rebuildable, false, `${label}: pure rebuild rejects`);
    assert.equal(report.reason, 'journal contains invalid sequence numbers', `${label}: sequence reason wins`);
    assert.equal(report.applied, 0, `${label}: purge marker is not folded`);
    assert.equal(report.skipped.length, 1, `${label}: one stable primary diagnosis`);
    assert.equal(report.skipped[0].why, INVALID_JOURNAL_SEQUENCE_CODE, `${label}: stable rebuild code`);
  }
});

function rawLegacyMetadataPayload(schemaVersion) {
  const entries = [
    {
      id: `raw-legacy-decision-${schemaVersion}`,
      type: 'decision.recorded',
      at: NOW,
      project: 'legacy-metadata',
      recordId: `raw-legacy-record-${schemaVersion}`,
      schemaVersion
    },
    {
      id: `raw-legacy-fact-${schemaVersion}`,
      type: 'fact.observed',
      at: NOW,
      project: 'legacy-metadata',
      factId: `raw-legacy-fact-record-${schemaVersion}`,
      schemaVersion
    }
  ];
  return {
    schemaVersion,
    revision: 0,
    records: [],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: entries,
    journalSeq: 0,
    journalEpoch: null
  };
}

function explicitLegacyMetadataPayload(schemaVersion, variant) {
  const entry = {
    id: `explicit-legacy-metadata-${schemaVersion}`,
    type: 'legacy_metadata_event',
    at: NOW,
    project: null,
    entityKind: null,
    entityId: `legacy-audit-${schemaVersion}`,
    schemaVersion,
    payload: null,
    replayable: false,
    originalType: 'decision.recorded',
    provenance: { actor: null, client: null, sessionId: null }
  };
  variant(entry);
  return {
    schemaVersion,
    revision: 0,
    records: [],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: [entry],
    journalSeq: 0,
    journalEpoch: null
  };
}

test('DS-P1-011 only true legacy unnumbered metadata remains compatible and is declared by validate/rebuild', () => {
  for (const schemaVersion of [1, 2]) {
    const graph = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(() => graph.importData(rawLegacyMetadataPayload(schemaVersion)));
    const validation = graph.validate();
    assert.equal(validation.valid, true, `schema ${schemaVersion}: legacy metadata remains readable`);
    assert.equal(validation.issues.filter((issue) => issue.code === 'legacy_metadata_without_sequence').length, 2);
    const rebuild = graph.rebuild();
    assert.equal(rebuild.rebuildable, true, `schema ${schemaVersion}: metadata does not claim projection mutations`);
    assert.equal(rebuild.applied, 0);
    assert.equal(rebuild.legacy.filter((entry) => entry.why === 'metadata_only_no_seq').length, 2);
  }

  for (const schemaVersion of [1, 2, 3, 4, 5]) {
    const graph = createShadowGraph({ now: () => NOW });
    assert.doesNotThrow(
      () => graph.importData(explicitLegacyMetadataPayload(schemaVersion, (entry) => { delete entry.seq; })),
      `schema ${schemaVersion}: explicit non-replayable metadata import`
    );
    const validation = graph.validate();
    assert.equal(validation.valid, true, `schema ${schemaVersion}: explicit legacy metadata validates`);
    assert.equal(validation.issues.some((issue) => issue.code === 'legacy_metadata_without_sequence'), true);
    const rebuild = graph.rebuild();
    assert.equal(rebuild.rebuildable, true);
    assert.equal(rebuild.applied, 0);
    assert.equal(rebuild.legacy[0].why, 'metadata_only_no_seq');

    const nullPayload = explicitLegacyMetadataPayload(schemaVersion, (entry) => { entry.seq = null; });
    assertInvalidJournalSequence(() => createShadowGraph({ now: () => NOW }).importData(nullPayload), `schema ${schemaVersion}: null is not unnumbered`);

    for (const mutate of [
      (entry) => { delete entry.replayable; },
      (entry) => { entry.payload = { id: entry.entityId }; }
    ]) {
      const disguised = explicitLegacyMetadataPayload(schemaVersion, (entry) => { delete entry.seq; mutate(entry); });
      assertInvalidJournalSequence(() => createShadowGraph({ now: () => NOW }).importData(disguised), `schema ${schemaVersion}: metadata exception is narrow`);
    }
  }
});

function sequenceSurfaceScenarios() {
  const missingLegacyReplayable = replayableSequencePayload(1, 'decision.recorded', (entry) => { delete entry.seq; });
  const unsafeCurrentPurge = replayableSequencePayload(5, 'project.purged', (entry) => { entry.seq = Number.MAX_SAFE_INTEGER + 1; });
  return [
    ['schema-1-seq-less-decision', missingLegacyReplayable],
    ['schema-5-unsafe-purge-marker', unsafeCurrentPurge]
  ];
}

test('DS-P1-011 JSON restore rejects seq-less replay and unsafe schema-5 purge ordering before replacement, with exact restart atomicity', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-ds-p1-011-json-');
  const destination = join(directory, 'live.json');
  const beforeState = await seedJson(destination, 'json-sequence-order-kept');
  const beforeBytes = await readFile(destination);
  for (const [label, payload] of sequenceSurfaceScenarios()) {
    const source = join(directory, `${label}.json`);
    await writeJson(source, payload);
    await assert.rejects(restoreFile(source, destination), /invalid_journal_sequence/i, label);
    assert.deepEqual(await readFile(destination), beforeBytes, `${label}: exact destination bytes`);
    const restarted = createJsonFileStore(destination);
    assert.deepEqual(await restarted.load(), beforeState, `${label}: restart state`);
    restarted.close();
  }
});

test('DS-P1-011 SQLite restore rejects seq-less replay and unsafe schema-5 purge ordering before replacement, with exact restart atomicity', SQLITE_TEST_OPTIONS, async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-ds-p1-011-sqlite-');
  const destination = join(directory, 'live.db');
  const seedStore = await createSqliteStore(destination);
  await seedStore.save(livePayload('sqlite-sequence-order-kept'));
  const beforeState = await seedStore.load();
  seedStore.close();
  const beforeBytes = await readFile(destination);

  for (const [label, payload] of sequenceSurfaceScenarios()) {
    const source = join(directory, `${label}.db`);
    const sourceStore = await createSqliteStore(source);
    await sourceStore.save(payload);
    sourceStore.close();

    const restoreStore = await createSqliteStore(destination);
    try {
      await assert.rejects(restoreStore.restore(source), /invalid_journal_sequence/i, label);
    } finally {
      restoreStore.close();
    }
    assert.deepEqual(await readFile(destination), beforeBytes, `${label}: exact SQLite main-file bytes`);
    const restarted = await createSqliteStore(destination);
    assert.deepEqual(await restarted.load(), beforeState, `${label}: restart state`);
    restarted.close();
  }
});

test('DS-P1-011 CLI, HTTP, and MCP reject seq-less replay and unsafe schema-5 purge ordering atomically across restart', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-ds-p1-011-surfaces-');
  const sources = [];
  for (const [label, payload] of sequenceSurfaceScenarios()) {
    const source = join(directory, `${label}.json`);
    await writeJson(source, payload);
    sources.push([label, source]);
  }

  await t.test('CLI', async () => {
    const destination = join(directory, 'cli.json');
    const beforeState = await seedJson(destination, 'cli-sequence-order-kept');
    const beforeBytes = await readFile(destination);
    for (const [label, source] of sources) {
      const result = await runRestoreCli(destination, source);
      assert.notEqual(result.code, 0, `${label}: CLI rejects`);
      assert.match(result.stderr, /invalid_journal_sequence/i, `${label}: CLI primary diagnostic`);
      assert.deepEqual(await readFile(destination), beforeBytes, `${label}: CLI exact durable bytes`);
    }
    const restarted = createJsonFileStore(destination);
    assert.deepEqual(await restarted.load(), beforeState, 'CLI restart state');
    restarted.close();
  });

  await t.test('HTTP', async () => {
    const destination = join(directory, 'http.json');
    const beforeState = await seedJson(destination, 'http-sequence-order-kept');
    const beforeBytes = await readFile(destination);
    const app = await createShadowGraphServer({ file: destination, now: () => NOW });
    const liveBefore = JSON.stringify(app.graph.exportData());
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try {
      for (const [label, source] of sources) {
        const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ source })
        });
        const body = await response.json();
        assert.equal(response.status, 400, `${label}: HTTP rejects`);
        assert.match(body.error, /invalid_journal_sequence/i, `${label}: HTTP primary diagnostic`);
        assert.equal(JSON.stringify(app.graph.exportData()), liveBefore, `${label}: HTTP live atomicity`);
        assert.deepEqual(await readFile(destination), beforeBytes, `${label}: HTTP durable atomicity`);
      }
    } finally {
      await closeServer(app.server);
    }
    const restarted = createJsonFileStore(destination);
    assert.deepEqual(await restarted.load(), beforeState, 'HTTP restart state');
    restarted.close();
  });

  await t.test('MCP', async () => {
    const destination = join(directory, 'mcp.json');
    const beforeState = await seedJson(destination, 'mcp-sequence-order-kept');
    const beforeBytes = await readFile(destination);
    const rpc = startMcp(destination);
    try {
      await rpc.call({ jsonrpc: '2.0', id: 'sequence-list', method: 'tools/list' });
      for (const [index, [label, source]] of sources.entries()) {
        const response = await rpc.call({
          jsonrpc: '2.0',
          id: `sequence-restore-${index}`,
          method: 'tools/call',
          params: { name: 'shadowgraph_restore', arguments: { source } }
        });
        assert.ok(response.error, `${label}: MCP rejects`);
        assert.match(response.error.message, /invalid_journal_sequence/i, `${label}: MCP primary diagnostic`);
        const validationResponse = await rpc.call({
          jsonrpc: '2.0',
          id: `sequence-validate-${index}`,
          method: 'tools/call',
          params: { name: 'shadowgraph_validate', arguments: {} }
        });
        assert.equal(validationResponse.error, undefined, `${label}: MCP original graph remains readable`);
        assert.equal(JSON.parse(validationResponse.result.content[0].text).valid, true, `${label}: MCP original graph remains valid`);
        assert.deepEqual(await readFile(destination), beforeBytes, `${label}: MCP durable atomicity`);
      }
    } finally {
      await rpc.stop();
    }
    const restarted = createJsonFileStore(destination);
    assert.deepEqual(await restarted.load(), beforeState, 'MCP restart state');
    restarted.close();
  });
});
