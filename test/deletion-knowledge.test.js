// PR-37a: the deletion-knowledge reader floor (plan rev6 §3.5, §3.8; OD-DP1 =
// Option A). This build reads the store control ledger and the per-user
// deletion registry, honours them at load in one chokepoint, preserves them,
// and refuses every restore or import it cannot make deletion-aware. Nothing
// here writes a ledger or registry entry: the fixtures are hand-built, as
// PR-37 will write them.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto, { createHash } from 'node:crypto';
import { execFile, execFileSync, execSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, readFile, readdir, rm, stat, symlink, writeFile, mkdir } from 'node:fs/promises';
import fsModule from 'node:fs';
import { existsSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { PURGE_AWARE_RESTORE_UNSUPPORTED, validateRestorePayload } from '../src/restore-validation.js';
import { downgradeStore, writePreservationCopy } from '../src/schema-conversion.js';
import { readStoreForDelivery } from '../src/delivery.js';
import { createShadowGraphServer } from '../src/server.js';
import { privilegedLiveSnapshot, privilegedRecordCapture, privilegedRecordSelfEvent, privilegedRecordTranscript, privilegedSnapshot, privilegedWithheldCounts } from '../src/internal/snapshot.js';
import { DELETION_CODES, DELETION_VIEW, ledgerPath, registryAppliesTo, registryFile, tombstoneAppliesTo } from '../src/internal/deletion-knowledge.js';
import { isLegacyUnnumberedMetadataEntry } from '../src/journal.js';
import { historicalIds } from '../tools/historical-ids.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { syncMarkdownWorkspace } from '../src/markdown-workspace.js';
import { CAPTURE_LIMITS, runCapture } from '../src/capture-hook.js';
import { privilegedBindProject, privilegedTransitionCapture } from '../src/internal/snapshot.js';
import { mintOriginId } from '../src/scope.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-09-30T12:00:00.000Z';
const BEFORE = '2026-09-10T00:00:00.000Z';
const TOMBSTONE_AT = '2026-09-20T00:00:00.000Z';
const AFTER = '2026-09-25T00:00:00.000Z';
const now = () => NOW;
const SENTINEL = 'withheld-sentinel-3c9d';
const ADMISSION = Object.freeze({ limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 }, storeBytes: 0 });
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const BACKENDS = [['json', {}], ['sqlite', sqlite.available ? {} : { skip: sqlite.reason }]];
const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mcpPath = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = async (path) => (existsSync(path) ? sha256(await readFile(path)) : null);
const NULL_PROVENANCE = { actor: null, client: null, sessionId: null };
const miss = (overrides = {}) => ({
  missId: 'miss_hidden', at: NOW, source: 'runtime', evidence: 'fallback_recovery',
  scope: { project: 'p', originId: null, requestState: 'project_selected' },
  queryDigest: 'a'.repeat(64), recordId: 'none', boundRevision: null, tier: 'T0', stage: 'not_ranked', rank: null,
  signals: { lexical: { available: true, matched: 0 }, semantic: { available: false, matched: 0 }, graph: { available: false, matched: 0 }, temporal: { available: false, matched: 0 } },
  reason: 'no_signal_match', ...overrides
});

// A store of two projects. In p: a decision, memory, fact and capture item
// that tombstones will name, their relation, retry keys, signal and miss, and
// project-labelled entries from before and after a tombstone's instant.
function fixture({ baseline = false } = {}) {
  let graph = createShadowGraph({ now });
  const kept = graph.addDecision({ project: 'p', title: 'kept decision', chosen: 'kept choice', idempotencyKey: 'kept' });
  const hidden = graph.addDecision({ project: 'p', title: `hidden ${SENTINEL}`, chosen: `choice ${SENTINEL}`, idempotencyKey: 'hidden', reviewAfter: '2020-01-01T00:00:00.000Z', alternatives: [{ label: `alternative ${SENTINEL}` }] });
  graph.link({ project: 'p', from: kept.id, to: hidden.id, relation: 'informs' });
  const memory = graph.remember({ project: 'p', memoryType: 'note', key: 'hidden-key', text: `memory ${SENTINEL}`, idempotencyKey: 'memory' }).memory;
  const fact = graph.addFact({ project: 'p', key: 'hidden-fact', value: `fact ${SENTINEL}`, idempotencyKey: 'fact' });
  const other = graph.addDecision({ project: 'q', title: 'other project', chosen: 'other' });
  graph.review({ project: 'p' });
  const capture = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: `capture ${SENTINEL}`, admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user' } });
  let payload = privilegedSnapshot(graph);
  payload.events.push({ id: 'note-before', type: 'project.note', at: BEFORE, project: 'p' }, { id: 'note-after', type: 'project.note', at: AFTER, project: 'p' });
  payload.runtimeMisses = [miss({ recordId: hidden.id }), miss({ missId: 'miss_old', at: BEFORE, recordId: kept.id }), miss({ missId: 'miss_kept', at: AFTER, recordId: kept.id })];
  if (baseline) {
    // A journal-less store: the import builds a baseline, which W must leave.
    payload = { ...payload, journal: [], journalSeq: 0, journalEpoch: null };
    graph = createShadowGraph({ now });
    graph.importData(payload);
    payload = privilegedSnapshot(graph);
  }
  const token = (id) => [...payload.records, ...payload.facts].find((entity) => entity.id === id).erasureToken;
  return {
    payload,
    ids: { kept: kept.id, hidden: hidden.id, alternative: hidden.alternatives[0].id, memory: memory.id, fact: fact.id, other: other.id, capture: capture.id },
    tokens: { hidden: token(hidden.id), memory: token(memory.id), fact: token(fact.id), capture: token(capture.id) }
  };
}

const tombstone = (fields) => ({ kind: 'item', mode: 'logical', at: TOMBSTONE_AT, tokens: [], ...fields });
// Each view as a ledger, with what it withholds: the tokens, and the projects
// whose own earlier entries it withholds.
const VIEWS = {
  item: (f) => ({ ledger: { version: 1, tombstones: [tombstone({ tokens: [f.tokens.hidden, f.tokens.memory, f.tokens.fact, f.tokens.capture] })] }, tokens: [f.tokens.hidden, f.tokens.memory, f.tokens.fact, f.tokens.capture], projects: [] }),
  project: (f) => ({ ledger: { version: 1, tombstones: [tombstone({ kind: 'project', purgedProject: 'p', mode: 'hard', tokens: [f.tokens.hidden], moveIn: 'none', seq: 3 })] }, tokens: [f.tokens.hidden], projects: [{ project: 'p', at: TOMBSTONE_AT }] }),
  origin: (f) => ({ ledger: { version: 1, tombstones: [tombstone({ kind: 'origin', purgedOrigin: 'origin-a', tokens: [f.tokens.capture] })] }, tokens: [f.tokens.capture], projects: [] }),
  quarantine: (f) => ({ ledger: { version: 1, quarantine: [{ token: f.tokens.memory }, { token: f.tokens.fact, reason: 'carried' }] }, tokens: [f.tokens.memory, f.tokens.fact], projects: [] }),
  'tokens null': () => ({ ledger: { version: 1, tombstones: [tombstone({ kind: 'project', purgedProject: 'p', tokens: null, moveIn: 'unknown' })] }, tokens: [], projects: [{ project: 'p', at: TOMBSTONE_AT }] }),
  unknown: (f) => ({ ledger: { version: 1, tombstones: [tombstone({ kind: 'mystery', mode: 'whatever', moveIn: 'perhaps', tokens: [f.tokens.hidden] })], laterBuildState: { carried: true } }, tokens: [f.tokens.hidden], projects: [] })
};

async function storeOf(t, backend, payload, ledger) {
  const dir = await scratchDirectory(t, 'deletion-knowledge-');
  const file = join(dir, backend === 'sqlite' ? 'store.db' : 'store.json');
  const store = await createStorage({ type: backend, file });
  // A copy: a payload carrying a purge models one by a build before PR-37d,
  // whose marker alone reaches the store (PR-37d design §2.2, §9.3).
  await store.save(structuredClone(payload));
  const stored = await store.load();
  store.close?.();
  if (ledger !== undefined) await writeFile(`${file}.control.json`, typeof ledger === 'string' ? ledger : JSON.stringify(ledger));
  return { dir, file, backend, stored: JSON.parse(JSON.stringify(stored)) };
}

// The same store with no view.
function plainOf(state) {
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(state.stored));
  return graph;
}

// What a store holds: its bytes for JSON; for SQLite, its payload, since a
// connection may fold the write-ahead log into the main file.
async function content({ file, backend }) {
  if (backend === 'json') return fileHash(file);
  const { DatabaseSync } = await import('node:sqlite');
  const { exportSqlitePayload } = await import('../src/sqlite-storage.js');
  const database = new DatabaseSync(file, { readOnly: true });
  try { return sha256(JSON.stringify(exportSqlitePayload(database))); } finally { database.close(); }
}

async function load({ file, backend }, options = {}) {
  const store = await createStorage({ type: backend, file, ...options });
  try { return await store.load(); } finally { store.close?.(); }
}

async function graphOf(state, options) {
  const graph = createShadowGraph({ now });
  graph.importData(await load(state, options));
  return graph;
}

// S′ (design §2.5, §11 R-11): the store with W removed, built here from the
// design's rules and not by the kernel. W's journal entries are logical
// skeletons and a baseline loses W, as a logical purge leaves them.
const SKELETON_FIELDS = ['id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId', 'schemaVersion', 'payload', 'replayable', 'originalType', 'redacted', 'redactedReason', 'provenance'];
const BASELINE_FIELDS = ['id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId', 'schemaVersion', 'derivedFrom', 'replayable'];
function withoutWithheld(source, { tokens, projects }) {
  const payload = structuredClone(source);
  const named = new Set(tokens);
  const ids = new Set();
  for (const entity of [...payload.records, ...payload.facts]) if (named.has(entity.erasureToken)) { ids.add(entity.id); for (const alternative of entity.alternatives ?? []) ids.add(alternative.id); }
  const relationIds = new Set(payload.relations.filter((relation) => ids.has(relation.from) || ids.has(relation.to)).map((relation) => relation.id));
  const predates = (project, at) => typeof project === 'string' && projects.some((item) => item.project === project && !(Date.parse(at) >= Date.parse(item.at)));
  const entityKeys = ['recordId', 'factId', 'replacementId'];
  const event = (item) => entityKeys.some((key) => ids.has(item[key])) || relationIds.has(item.relationId)
    || (![...entityKeys, 'relationId'].some((key) => item[key] != null) && !item.type.startsWith('access.') && predates(item.project, item.at));
  const entry = (item) => ids.has(item.entityId) || relationIds.has(item.entityId) || ids.has(item.payload?.id) || relationIds.has(item.payload?.id)
    || (item.type === 'relation.created' && (ids.has(item.payload?.from) || ids.has(item.payload?.to)));
  const hiddenSeqs = new Set();
  payload.journal = payload.journal.map((item) => {
    if (item.type === 'projection.baseline' && item.payload && item.redacted !== true) {
      const keep = (value) => !ids.has(value?.id);
      const next = {
        records: item.payload.records.filter(keep), facts: item.payload.facts.filter(keep),
        relations: item.payload.relations.filter((relation) => !relationIds.has(relation.id) && !ids.has(relation.from) && !ids.has(relation.to)),
        idempotency: item.payload.idempotency.filter((retry) => keep(retry.value))
      };
      if (['records', 'facts', 'relations', 'idempotency'].every((name) => next[name].length === item.payload[name].length)) return item;
      return { ...Object.fromEntries(BASELINE_FIELDS.filter((name) => Object.hasOwn(item, name)).map((name) => [name, item[name]])), payload: next, provenance: NULL_PROVENANCE };
    }
    if (!entry(item)) return item;
    hiddenSeqs.add(item.seq);
    return { ...Object.fromEntries(SKELETON_FIELDS.filter((name) => Object.hasOwn(item, name)).map((name) => [name, item[name]])), entityId: null, payload: null, redacted: true, redactedReason: 'project_purged', provenance: NULL_PROVENANCE };
  });
  payload.records = payload.records.filter((item) => !ids.has(item.id));
  payload.facts = payload.facts.filter((item) => !ids.has(item.id));
  payload.relations = payload.relations.filter((item) => !relationIds.has(item.id));
  payload.reviewSignals = payload.reviewSignals.filter((item) => !ids.has(item.decisionId));
  payload.idempotency = payload.idempotency.filter((item) => !ids.has(item.value?.id));
  payload.events = payload.events.filter((item) => !event(item));
  const contentRefs = new Set(source.records.filter((item) => ids.has(item.id)).map((item) => item.contentRef).filter(Boolean));
  if (payload.runtimeMisses) payload.runtimeMisses = payload.runtimeMisses.filter((item) => !ids.has(item.recordId) && !predates(item.scope?.project, item.at));
  if (payload.captureContent) payload.captureContent = payload.captureContent.filter((item) => !contentRefs.has(item.contentRef));
  // A session opened after a project's tombstone is not withheld (PR-37c design §1.3, R9); one with no time is.
  if (payload.captureSessions) payload.captureSessions = payload.captureSessions.filter((item) => !(item.attribution === 'project' && predates(item.project, item.startedAt)));
  return { payload, hiddenSeqs, ids, relationIds };
}

// Every public read of one scope. Journal reads of S′ leave out W's
// skeletons, which no scope sees (F15).
function reads(graph, scope, ids, hiddenSeqs = new Set()) {
  const journal = graph.getJournal({ ...scope, limit: 500 });
  const visible = journal.items.filter((item) => !hiddenSeqs.has(item.seq));
  const hiddenHere = journal.items.length - visible.length;
  const less = (value) => (typeof value === 'number' ? value - hiddenHere : value);
  const stats = graph.stats(scope);
  const redacted = graph.redact(scope);
  return {
    search: graph.search('decision memory fact capture', scope),
    retrieve: graph.retrieve('decision', scope),
    recall: graph.recall('memory', scope),
    context: graph.context({ ...scope, query: 'decision' }),
    exportData: graph.exportData(scope),
    journal: { ...journal, items: visible, page: { ...journal.page, total: less(journal.page.total) }, completeness: { ...journal.completeness, returned: less(journal.completeness.returned), total: less(journal.completeness.total) } },
    rebuild: graph.rebuild(scope).projection,
    validate: graph.validate(scope),
    stats: { ...stats, journal: stats.journal - hiddenHere },
    signals: graph.getReviewSignals(scope),
    memoryHistory: graph.memoryHistory({ ...scope, memoryType: 'note', key: 'hidden-key' }),
    traverse: graph.traverse({ ...scope, id: ids.kept }),
    redact: { ...redacted, journal: redacted.journal.filter((item) => !hiddenSeqs.has(item.seq)) },
    legacy: graph.legacyAttributionReview(scope),
    expand: ['hidden', 'memory', 'kept'].map((name) => answer(() => graph.expand({ ...scope, recordId: ids[name], digest: 'x' }))),
    memoryHistoryById: answer(() => graph.memoryHistory({ ...scope, id: ids.memory })),
    projectSummary: scope.project ? graph.projectSummary(scope.project) : null,
    repairPlan: graph.repairPlan(scope),
    reconsider: answer(() => graph.reconsider(scope)),
    // These persist review signals, alike on both graphs.
    review: answer(() => graph.review(scope)),
    reviewContext: answer(() => graph.reviewContext({ ...scope, query: 'decision' })),
    maintain: answer(() => graph.maintain(scope))
  };
}

// A read with its quarantine disclosure (PR-37c design §9.3) taken out: the
// count and the sentence that names it.
const QUARANTINE_SENTENCE = / \d+ items? of this scope (?:is|are) withheld as possibly purged; only the owner can release or purge them\./gu;
function undisclosed(value) {
  if (typeof value === 'string') return value.replace(QUARANTINE_SENTENCE, '');
  if (Array.isArray(value)) return value.map(undisclosed);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'quarantined').map(([key, item]) => [key, undisclosed(item)]));
  return value;
}

// A read's value, or its refusal: a refusal must be the same refusal.
function answer(read) {
  try { return { value: read() }; } catch (error) { return { error: error.message, code: error.code }; }
}

const SCOPES = [{ project: 'p' }, { project: 'q' }, {}];

// Each withheld entity's own content (review T-18).
function withheldContents(f, tokens) {
  const by = { hidden: ['hidden ', 'choice ', 'alternative '], memory: ['memory '], fact: ['fact '], capture: ['capture '] };
  return Object.entries(by).filter(([name]) => tokens.includes(f.tokens[name])).flatMap(([, texts]) => texts.map((text) => `${text}${SENTINEL}`));
}

for (const [backend, options] of BACKENDS) {
  test(`PR-37a reader ${backend}: a ledger of every kind loads; unknown kinds, modes and moveIn values withhold their tokens`, options, async (t) => {
    const f = fixture();
    const ledger = { version: 1, tombstones: [
      tombstone({ kind: 'project', purgedProject: 'z', tokens: null }), tombstone({ kind: 'origin', purgedOrigin: 'o', mode: 'hard', tokens: [] }),
      tombstone({ kind: 'mystery', mode: 'unheard', moveIn: 'perhaps', tokens: [f.tokens.hidden] })
    ], quarantine: [{ token: f.tokens.fact }], futureRetentionControls: [{ anything: true }], laterBuildState: { carried: 4 } };
    const state = await storeOf(t, backend, f.payload, ledger);
    const graph = await graphOf(state);
    const live = privilegedLiveSnapshot(graph);
    assert.equal(live.records.some((item) => item.id === f.ids.hidden), false);
    assert.equal(live.facts.some((item) => item.id === f.ids.fact), false);
    assert.equal(live.records.some((item) => item.id === f.ids.kept), true);
  });

  test(`PR-37a reader ${backend}: each malformed acted-on field, an empty file and a newer version refuse the load`, options, async (t) => {
    const f = fixture();
    const cases = [
      ['', 'control_ledger_malformed'], ['   ', 'control_ledger_malformed'], ['not json', 'control_ledger_malformed'], ['[]', 'control_ledger_malformed'],
      [{}, 'control_ledger_malformed'], [{ version: 0 }, 'control_ledger_malformed'], [{ version: '1' }, 'control_ledger_malformed'], [{ version: 1.5 }, 'control_ledger_malformed'],
      [{ version: 1, tombstones: {} }, 'control_ledger_malformed'], [{ version: 1, tombstones: [7] }, 'control_ledger_malformed'], [{ version: 1, tombstones: [null] }, 'control_ledger_malformed'],
      [{ version: 1, tombstones: [{ kind: 'item' }] }, 'control_ledger_malformed'], [{ version: 1, tombstones: [tombstone({ tokens: [''] })] }, 'control_ledger_malformed'],
      [{ version: 1, tombstones: [tombstone({ tokens: 'x' })] }, 'control_ledger_malformed'],
      [{ version: 1, tombstones: [tombstone({ kind: 'project', purgedProject: '' })] }, 'control_ledger_malformed'],
      [{ version: 1, tombstones: [tombstone({ kind: 'project', purgedProject: 'p', at: 'yesterday' })] }, 'control_ledger_malformed'],
      [{ version: 1, quarantine: [{}] }, 'control_ledger_malformed'], [{ version: 1, quarantine: 'x' }, 'control_ledger_malformed'],
      [{ version: 1, pending: {} }, 'control_ledger_malformed'],
      [{ version: 2 }, 'control_ledger_newer_version'],
      [{ version: 1, pending: [{ kind: 'purge' }] }, 'deletion_pending_unsupported_at_this_build']
    ];
    const state = await storeOf(t, backend, f.payload);
    for (const [ledger, code] of cases) {
      await writeFile(`${state.file}.control.json`, typeof ledger === 'string' ? ledger : JSON.stringify(ledger));
      await assert.rejects(load(state), (error) => error.code === code && !error.message.includes(state.dir), JSON.stringify(ledger));
    }
    // A ledger that is there but cannot be read is never "none".
    const other = await storeOf(t, backend, f.payload);
    await mkdir(`${other.file}.control.json`);
    await assert.rejects(load(other), { code: 'control_ledger_malformed' });
  });

  test(`PR-37a reader ${backend}: a tombstone carrying only what the reader acts on loads and withholds (F13)`, options, async (t) => {
    const f = fixture();
    const graph = await graphOf(await storeOf(t, backend, f.payload, { version: 1, tombstones: [{ tokens: [f.tokens.hidden] }, { kind: 'item', tokens: null }] }));
    assert.equal(privilegedLiveSnapshot(graph).records.some((item) => item.id === f.ids.hidden), false);
  });

  test(`PR-37a reader ${backend}: no ledger withholds nothing`, options, async (t) => {
    const f = fixture();
    const state = await storeOf(t, backend, f.payload);
    const graph = await graphOf(state);
    assert.deepEqual(privilegedLiveSnapshot(graph), privilegedSnapshot(graph));
    assert.equal(privilegedSnapshot(graph).records.some((item) => item.id === f.ids.hidden), true);
  });

  test(`PR-37a pending ${backend}: a pending record refuses load, save and update, and delivery reports memory unavailable`, options, async (t) => {
    const f = fixture();
    const state = await storeOf(t, backend, f.payload, { version: 1, pending: [{ kind: 'restore', carried: true }] });
    const store = await createStorage({ type: backend, file: state.file });
    t.after(() => store.close?.());
    const before = await readFile(state.file);
    for (const attempt of [() => store.load(), () => store.save(f.payload), () => store.update(() => f.payload)]) {
      await assert.rejects(attempt(), { code: 'deletion_pending_unsupported_at_this_build' });
    }
    assert.deepEqual(await readFile(state.file), before);
    // Memory unavailable; the pending record is named for the capture line (PR-37b).
    assert.deepEqual(await readStoreForDelivery({ file: state.file, storage: backend }), { unavailable: 'unreadable', pending: true });
  });

  for (const [name, view] of Object.entries(VIEWS)) for (const shape of ['journal', 'baseline']) {
    test(`PR-37a withholding ${backend} ${name} ${shape}: every public read equals the read of S′, and none names W`, options, async (t) => {
      const f = fixture({ baseline: shape === 'baseline' });
      const { ledger, tokens, projects } = view(f);
      const state = await storeOf(t, backend, f.payload, ledger);
      const viewed = await graphOf(state);
      const stored = JSON.parse(JSON.stringify(privilegedSnapshot(viewed)));
      const expected = withoutWithheld(stored, { tokens, projects });
      const reference = createShadowGraph({ now });
      reference.importData(expected.payload);
      // The persistence form is the store unchanged; the live form is S′ itself,
      // collections no read shows included (review T-7).
      assert.deepEqual(privilegedSnapshot(viewed), privilegedSnapshot(plainOf(state)));
      assert.deepEqual(privilegedLiveSnapshot(viewed), privilegedSnapshot(reference));
      const contents = withheldContents(f, tokens);
      for (const scope of SCOPES) {
        const actual = reads(viewed, scope, f.ids);
        // The preview counts W apart, as `withheld`, which S′, holding no W, cannot show (PR-37d design §6.1, R5 L1
        // VS1); every W entity is p's.
        if (actual.projectSummary) {
          assert.equal(actual.projectSummary.withheld, scope.project === 'p' ? tokens.length : 0, 'the preview counts W apart');
          actual.projectSummary.withheld = 0;
        }
        // Quarantine is also disclosed by count (PR-37c design §9.3), which S′, holding no ledger, cannot show.
        assert.deepEqual(name === 'quarantine' ? undisclosed(actual) : actual, reads(reference, scope, f.ids, expected.hiddenSeqs), `${JSON.stringify(scope)}`);
        if (name === 'quarantine' && scope.project === 'p') assert.match(JSON.stringify(actual), /"quarantined":2/u, 'the quarantine is counted');
        const text = JSON.stringify(actual);
        // A read given an id echoes it back as for an unknown one; the rest name none.
        const { expand, memoryHistoryById, ...unprompted } = actual;
        for (const token of tokens) assert.equal(text.includes(token), false, 'a withheld token');
        for (const id of [...expected.ids, ...expected.relationIds]) assert.equal(JSON.stringify(unprompted).includes(id), false, `withheld id ${id}`);
        for (const content of contents) assert.equal(text.includes(content), false, `withheld content ${content}`);
      }
      // The live journal folds to exactly the live state, as after a logical purge.
      assert.equal(viewed.validate().valid, true);
    });
  }

  test(`PR-37a chokepoint ${backend}: a rollback keeps the view, a reload brings a fresh one, and no view withholds nothing`, options, async (t) => {
    const f = fixture();
    const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
    const graph = await graphOf(state);
    const hidden = () => privilegedLiveSnapshot(graph).records.some((item) => item.id === f.ids.hidden);
    graph.replaceData(privilegedSnapshot(graph));
    assert.equal(hidden(), false);
    graph.replaceData(await load(state));
    assert.equal(hidden(), false);
    // A reload brings the ledger now on disk, not the one installed.
    const origin = await storeOf(t, backend, f.payload, VIEWS.origin(f).ledger);
    const reloaded = await graphOf(origin);
    assert.equal(privilegedLiveSnapshot(reloaded).records.some((item) => item.id === f.ids.hidden), true);
    await writeFile(ledgerPath(origin.file), JSON.stringify(VIEWS.item(f).ledger));
    reloaded.replaceData(await load(origin));
    assert.equal(privilegedLiveSnapshot(reloaded).records.some((item) => item.id === f.ids.hidden), false);
    const plain = createShadowGraph({ now });
    plain.importData(JSON.parse(JSON.stringify(f.payload)));
    assert.equal(privilegedLiveSnapshot(plain).records.some((item) => item.id === f.ids.hidden), true);
  });

  test(`PR-37a files ${backend}: loads, saves, updates, backups and downgrades never write the ledger or the registry; a purge writes exactly its tombstone and its registry entry, and a restore then lifts nothing (PR-37c design §13.4; PR-37d design §9.3)`, options, async (t) => {
    const f = fixture();
    const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
    const env = { SHADOWGRAPH_HOME: join(state.dir, 'home') };
    await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
    await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [], laterBuildState: 1 }));
    const files = [`${state.file}.control.json`, registryFile(env)];
    const before = await Promise.all(files.map(fileHash));
    const store = await createStorage({ type: backend, file: state.file, env });
    t.after(() => store.close?.());
    const graph = createShadowGraph({ now });
    graph.importData(await store.load());
    graph.addDecision({ project: 'p', title: 'written', chosen: 'w' });
    graph.setRevision(await store.save(privilegedSnapshot(graph)));
    await store.update((current) => current);
    graph.replaceData(await store.load());
    assert.deepEqual(await Promise.all(files.map(fileHash)), before);
    // The purge writes q's tombstone beside the store and its entry in the registry, and nothing else: no pending
    // member is left, and every other member of both is kept (PR-37d design §3.4, §3.6).
    const [ledgerBefore, registryBefore] = await Promise.all(files.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    graph.purgeProject('q', { mode: 'hard' });
    graph.setRevision(await store.save(privilegedSnapshot(graph)));
    const [ledgerPurged, registryPurged] = await Promise.all(files.map(async (path) => JSON.parse(await readFile(path, 'utf8'))));
    const tombstone = ledgerPurged.tombstones.at(-1);
    assert.deepEqual(ledgerPurged, { ...ledgerBefore, tombstones: [...ledgerBefore.tombstones, tombstone] });
    assert.deepEqual([tombstone.purgedProject, tombstone.mode, Array.isArray(tombstone.tokens)], ['q', 'hard', true]);
    const { lineage, ...entry } = registryPurged.tombstones.at(-1);
    assert.deepEqual(registryPurged, { ...registryBefore, tombstones: [...registryBefore.tombstones, { ...entry, lineage }] });
    assert.deepEqual(entry, tombstone, 'the registry entry is the tombstone with its lineage');
    const purged = await Promise.all(files.map(fileHash));
    const extension = backend === 'sqlite' ? 'db' : 'json';
    const backup = join(state.dir, `backup.${extension}`);
    await backupFile(state.file, backup, { store, env });
    assert.deepEqual(await Promise.all(files.map(fileHash)), purged);
    // q's marker is recorded by its tombstone, so restore lifts nothing. PR39 advances the
    // restore base and records removal of the capture suppressed by p's existing item tombstone.
    if (backend === 'sqlite') await store.restore(backup);
    else await restoreFile(backup, state.file, { env });
    assert.deepEqual(JSON.parse(await readFile(files[0], 'utf8')), { ...ledgerPurged, generationBase: (ledgerPurged.generationBase ?? 0) + 1, generationCounters: [{ token: f.tokens.capture, counter: 1 }] }, 'no tombstone lifted; restore generation and suppressed-capture removal recorded');
    assert.equal(await fileHash(files[1]), purged[1], 'registry unchanged');
    const restored = await Promise.all(files.map(fileHash));
    graph.replaceData(await store.load());
    await downgradeStore({ graph, store, file: state.file, storageType: backend, output: join(state.dir, `down.${extension}`), preservationCopy: join(state.dir, `kept.${extension}`), toSchemaVersion: 6, now });
    assert.deepEqual(await Promise.all(files.map(fileHash)), restored);
  });
}

test('PR-37a byte identity: a load then a snapshot is the stored payload, and a save after a write keeps W', async (t) => {
  const f = fixture();
  const canonical = createShadowGraph({ now });
  canonical.importData(f.payload);
  const state = await storeOf(t, 'json', privilegedSnapshot(canonical), VIEWS.item(f).ledger);
  const raw = await readFile(state.file, 'utf8');
  const graph = await graphOf(state);
  assert.equal(`${JSON.stringify(privilegedSnapshot(graph), null, 2)}\n`, raw);
  graph.addDecision({ project: 'p', title: 'after', chosen: 'a' });
  const store = await createStorage({ file: state.file });
  await store.save(privilegedSnapshot(graph));
  const saved = await readFile(state.file, 'utf8');
  assert.equal(saved.includes(`hidden ${SENTINEL}`), true);
  assert.equal(saved.includes(f.tokens.hidden), true);
});

// Ids, tokens and capture refs from fixed sequences, one per graph, so two
// graphs given the same writes write the same things.
function deterministic(t) {
  const original = { random: Math.random, now: Date.now, uuid: crypto.randomUUID };
  const streams = new Map();
  let stream = null;
  Math.random = () => { stream.random = (stream.random * 7919 + 13) % 10007; return stream.random / 10007; };
  Date.now = () => 1_790_000_000_000;
  crypto.randomUUID = () => `00000000-0000-4000-8000-${String(++stream.uuid).padStart(12, '0')}`;
  syncBuiltinESMExports();
  t.after(() => { Math.random = original.random; Date.now = original.now; crypto.randomUUID = original.uuid; syncBuiltinESMExports(); });
  return (name, seed = 1) => { if (!streams.has(name)) streams.set(name, { random: seed, uuid: seed * 1000 }); stream = streams.get(name); };
}

test('PR-37a invariants: after import and every write, the persistence form equals the view-less graph\'s, and the store stays whole and valid', async (t) => {
  const use = deterministic(t);
  use('fixture', 4242);
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  use('load'); const loaded = await load(state);
  use('viewed'); const viewed = createShadowGraph({ now }); viewed.importData(loaded);
  use('plain'); const plain = plainOf(state);
  assert.deepEqual(privilegedSnapshot(viewed), privilegedSnapshot(plain));
  const made = {};
  const writes = [
    ['decision q', (g) => { made.q = g.addDecision({ project: 'q', title: 'new q', chosen: 'n' }).id; }],
    ['decision p', (g) => { made.p = g.addDecision({ project: 'p', title: 'new p', chosen: 'n', idempotencyKey: 'new-p' }).id; }],
    ['attempt', (g) => g.addAttempt({ project: 'p', solution: 's', result: 'r' })],
    ['memory', (g) => g.remember({ project: 'p', memoryType: 'note', key: 'other-key', text: 't' })],
    ['fact', (g) => g.addFact({ project: 'p', key: 'other-fact', value: 'v' })],
    ['link', (g) => g.link({ project: 'p', from: f.ids.kept, to: made.p, relation: 'informs' })],
    ['status', (g) => g.updateDecisionStatus(f.ids.kept, 'planned', { project: 'p' })],
    ['outcome', (g) => g.setOutcome(f.ids.kept, { status: 'successful' }, { project: 'p' })],
    ['evidence', (g) => g.addConfidenceEvidence({ project: 'p', decisionId: f.ids.kept, key: 'observed', reason: 'r' })],
    ['capture', (g) => privilegedRecordCapture(g, { project: 'p', originId: 'origin-a', text: 'later', admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user' } })],
    ['self event', (g) => privilegedRecordSelfEvent(g, { project: 'p', originId: 'origin-a', signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'session-1' } })],
    ['purge q logical', (g) => g.purgeProject('q', { mode: 'logical' })],
    ['purge q hard', (g) => g.purgeProject('q', { mode: 'hard' })]
  ];
  for (const [label, write] of writes) {
    use('viewed'); write(viewed);
    use('plain'); write(plain);
    // The checks draw ids of their own (a staging import), never the graphs'.
    use('checks');
    const persisted = privilegedSnapshot(viewed);
    assert.deepEqual(persisted, privilegedSnapshot(plain), `transparency after ${label}`);
    assert.doesNotThrow(() => validateRestorePayload(persisted), `validity after ${label}`);
    assert.doesNotThrow(() => createShadowGraph({ now }).importData(persisted), `view-less import after ${label}`);
    assert.equal(privilegedLiveSnapshot(viewed).records.some((item) => item.id === f.ids.hidden), false, `still withheld after ${label}`);
  }
});

test('PR-37a writes around W: a W id is never allocated, and a retry key or scope W holds refuses and changes nothing', async (t) => {
  const f = fixture();
  // The first id the generator gives is the withheld decision's.
  const original = { random: Math.random, now: Date.now };
  t.after(() => { Math.random = original.random; Date.now = original.now; });
  Date.now = () => 1_790_000_000_000;
  Math.random = () => 0.5;
  const candidate = `decision_1790000000000_${(0.5).toString(36).slice(2, 8)}`;
  Math.random = original.random;
  const payload = JSON.parse(JSON.stringify(f.payload).replaceAll(f.ids.alternative, candidate));
  const state = await storeOf(t, 'json', payload, VIEWS.item(f).ledger);
  const graph = await graphOf(state);
  let calls = 0;
  Math.random = () => (calls++ === 0 ? 0.5 : original.random());
  const made = graph.addDecision({ project: 'p', title: 'fresh', chosen: 'f' });
  Math.random = original.random;
  assert.notEqual(made.id, candidate);
  assert.ok(calls >= 2, 'the colliding candidate was skipped');
  // Nor is a token W holds issued again.
  const uuid = crypto.randomUUID;
  let issued = 0;
  crypto.randomUUID = () => (issued++ === 0 ? f.tokens.hidden : uuid());
  syncBuiltinESMExports();
  try {
    const fresh = graph.addDecision({ project: 'q', title: 'tokened', chosen: 't' });
    assert.notEqual(privilegedSnapshot(graph).records.find((item) => item.id === fresh.id).erasureToken, f.tokens.hidden);
    assert.ok(issued >= 2);
  } finally { crypto.randomUUID = uuid; syncBuiltinESMExports(); }
  const before = privilegedSnapshot(graph);
  for (const [attempt, code] of [
    [() => graph.addDecision({ project: 'p', title: 'again', chosen: 'a', idempotencyKey: 'hidden' }), 'idempotency_key_withheld'],
    [() => graph.remember({ project: 'p', memoryType: 'note', key: 'hidden-key', text: 'again' }), 'scope_key_withheld'],
    [() => graph.applyMemoryPlan({ project: 'p', operations: [{ action: 'ADD', memoryType: 'note', key: 'hidden-key', text: 'again' }] }), 'scope_key_withheld'],
    [() => graph.addFact({ project: 'p', key: 'hidden-fact', value: 'again' }), 'scope_key_withheld']
  ]) {
    assert.throws(attempt, (error) => error.code === code && !error.message.includes(SENTINEL));
    assert.deepEqual(privilegedSnapshot(graph), before);
  }
  // A plan's DELETE of a scope W holds finds nothing to invalidate.
  const deleted = graph.applyMemoryPlan({ project: 'p', operations: [{ action: 'DELETE', memoryType: 'note', key: 'hidden-key' }] });
  assert.deepEqual(deleted.results.map((item) => [item.operation, item.memory]), [['NOOP', null]]);
  assert.deepEqual(privilegedSnapshot(graph), before);
  // Journal sequences continue past W's.
  const top = Math.max(...before.journal.map((entry) => entry.seq));
  graph.addDecision({ project: 'q', title: 'next', chosen: 'n' });
  assert.equal(privilegedSnapshot(graph).journal.at(-1).seq, top + 1);
});

for (const mode of ['logical', 'hard']) test(`PR-37a purge ${mode}: a purge reaches W, its result counts live memory only, and the store equals a purge with no view`, async (t) => {
  const use = deterministic(t);
  use('fixture', 4242);
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const viewed = await graphOf(state);
  const plain = plainOf(state);
  const before = viewed.projectSummary('p');
  use('viewed'); const result = viewed.purgeProject('p', { mode });
  use('plain'); const reference = plain.purgeProject('p', { mode });
  assert.equal(result.records, before.records);
  assert.ok(result.removed < reference.removed);
  // W -- p's decision, memory, fact and capture -- is counted apart, by the preview too (PR-37d design §6.1).
  assert.deepEqual([before.withheld, result.withheld, reference.withheld], [4, 4, 0]);
  const persisted = privilegedSnapshot(viewed);
  const marker = (snapshot) => snapshot.journal.find((entry) => entry.type === 'project.purged');
  assert.equal(marker(persisted).payload.removed, result.removed, 'the marker counts live memory');
  assert.equal(marker(privilegedSnapshot(plain)).payload.removed, reference.removed);
  // Everything else is the purge with no view.
  const without = (snapshot) => ({ ...snapshot, journal: snapshot.journal.map((entry) => (entry.type === 'project.purged' ? { ...entry, payload: { ...entry.payload, removed: null } } : entry)) });
  assert.deepEqual(without(persisted), without(privilegedSnapshot(plain)));
  if (mode === 'logical') assert.ok(result.journalEntriesRedacted < reference.journalEntriesRedacted, 'a logical purge counts the live entries it redacts');
  assert.equal(JSON.stringify(persisted).includes(SENTINEL), false);
  assert.deepEqual(privilegedWithheldCounts(viewed), {});
});

test('PR-37a capture: a session W holds is never minted again or written to, and capture keeps clear of what W holds', async (t) => {
  const f = fixture();
  // A session opened before its project's tombstone is one the tombstone holds (PR-37c design §1.3, R9).
  const opened = structuredClone(f.payload);
  opened.captureSessions[0].startedAt = BEFORE;
  const state = await storeOf(t, 'json', opened, VIEWS.project(f).ledger);
  const graph = await graphOf(state);
  const before = privilegedSnapshot(graph);
  const source = { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user' };
  assert.deepEqual(privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: 'more', admission: ADMISSION, source }), { refused: { reason: 'session_withheld' }, changed: false });
  assert.deepEqual(privilegedRecordSelfEvent(graph, { project: 'p', originId: 'origin-a', signal: 'S-1', source }), { refused: { reason: 'session_withheld' }, changed: false });
  const read = privilegedRecordTranscript(graph, { originId: 'origin-a', sessionId: 'session-1', project: 'p', activatedAt: NOW, trigger: null, transcript: null });
  assert.equal(read.withheld, 'session_withheld');
  assert.equal(read.refused, 0);
  assert.equal(read.changed, false);
  assert.deepEqual(privilegedSnapshot(graph), before);
  // An item tombstone withholds the capture but not its session: a new
  // capture of the session takes the next ordinal past the withheld one.
  const itemGraph = await graphOf(await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger));
  const next = privilegedRecordCapture(itemGraph, { project: 'p', originId: 'origin-a', text: 'next prompt', admission: ADMISSION, source });
  assert.equal(next.occurrenceSeq, 2);
  // So it does where the session keeps no high-water mark.
  const unmarked = structuredClone(f.payload);
  delete unmarked.captureSessions[0].occurrenceSeqHighWater;
  const unmarkedGraph = await graphOf(await storeOf(t, 'json', unmarked, VIEWS.item(f).ledger));
  assert.equal(privilegedRecordCapture(unmarkedGraph, { project: 'p', originId: 'origin-a', text: 'next prompt', admission: ADMISSION, source }).occurrenceSeq, 2);
  const persisted = privilegedSnapshot(itemGraph);
  assert.doesNotThrow(() => validateRestorePayload(persisted));
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(persisted));
});

// The restore refusal (design §4, §11 R-1, R-5, R-9): each trigger, on the
// direct entries of both backends, memory-only included.
async function restoreCase(t, backend, setup) {
  const f = fixture();
  const destination = await storeOf(t, backend, f.payload);
  const source = await storeOf(t, backend, fixture().payload);
  const env = { SHADOWGRAPH_HOME: join(destination.dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  await setup({ f, destination, source, env });
  const restore = async (memoryOnly) => {
    if (backend === 'json') return restoreFile(source.file, destination.file, { env, memoryOnly });
    const store = await createStorage({ type: 'sqlite', file: destination.file, env });
    try { return await store.restore(source.file, { memoryOnly }); } finally { store.close(); }
  };
  return { f, destination, source, env, restore };
}

// Saved as a copy: its purge callers model a purge by a build before PR-37d,
// whose marker PR-37c lifts (PR-37d design §9.3).
async function rewrite({ file, backend }, change) {
  const store = await createStorage({ type: backend, file });
  try { await store.save(structuredClone(change(await store.load()))); } finally { store.close?.(); }
}

const TRIGGERS = {
  'D ledger tombstone': ({ destination }) => writeFile(`${destination.file}.control.json`, JSON.stringify({ version: 1, tombstones: [tombstone({ kind: 'project', purgedProject: 'z', tokens: null })] })),
  'D ledger quarantine': ({ destination }) => writeFile(`${destination.file}.control.json`, JSON.stringify({ version: 1, quarantine: [{ token: 'x' }] })),
  'D ledger pending': ({ destination }) => writeFile(`${destination.file}.control.json`, JSON.stringify({ version: 1, pending: [{ kind: 'purge' }] })),
  'D ledger unreadable': ({ destination }) => writeFile(`${destination.file}.control.json`, '{'),
  'B sidecar with knowledge': ({ source }) => writeFile(`${source.file}.control.json`, JSON.stringify({ version: 1, tombstones: [] })),
  'B sidecar newer': ({ source }) => writeFile(`${source.file}.control.json`, JSON.stringify({ version: 2 })),
  // A sidecar never carries a record (C3): a non-empty pending list refuses, an empty one does not (M60; review
  // finding 11, X-sidecar-pending).
  'B sidecar pending': ({ source }) => writeFile(`${source.file}.control.json`, JSON.stringify({ version: 1, pending: [{ kind: 'purge' }] })),
  'registry tombstone': ({ env }) => writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [tombstone({ tokens: ['anything'] })] })),
  'registry unreadable': ({ env }) => writeFile(registryFile(env), 'nope'),
  'registry root relative': async ({ env }) => { env.SHADOWGRAPH_HOME = 'relative-home'; },
  'D transcript cursor': ({ destination }) => rewrite(destination, (payload) => ({ ...payload, captureSessions: payload.captureSessions.map((session) => ({ ...session, cursor: { carried: true } })) })),
  'D purge marker': ({ destination }) => rewrite(destination, (payload) => {
    const graph = createShadowGraph({ now }); graph.importData(payload);
    graph.purgeProject('q', { mode: 'logical' });
    return privilegedSnapshot(graph);
  })
};
const NON_TRIGGERS = {
  'D ledger with opaque future controls and later members only': ({ destination }) => writeFile(`${destination.file}.control.json`, JSON.stringify({ version: 1, futureRetentionControls: [{ days: 30 }], laterBuildState: { carried: true } })),
  'B sidecar with its version only': ({ source }) => writeFile(`${source.file}.control.json`, JSON.stringify({ version: 1 })),
  'registry tombstone B disproves': async ({ env, source }) => {
    const payload = await load(source);
    assert.ok(payload.journal.some((entry) => entry.seq === payload.journalEpoch));
    await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [tombstone({ kind: 'project', purgedProject: 'p', tokens: null, lineage: { epochEntryId: 'another-lineage', headEntryId: 'another-head' } })] }));
  },
  'no knowledge anywhere': async () => {}
};

// PR-37c design §13.4: knowledge itself no longer refuses (§5.2). These triggers
// stay refusals, with the same code; the rest proceed, each with what it does.
const REFUSING = ['D ledger pending', 'D ledger unreadable', 'B sidecar newer', 'B sidecar pending', 'registry unreadable', 'registry root relative', 'D transcript cursor'];
const PROCEEDING = {
  // A tokens:null tombstone with no recorded move-in: every B candidate not live in D is quarantined.
  'D ledger tombstone': async ({ result, destination, source }) => {
    assert.deepEqual([result.deletionKnowledge, result.reapplied.quarantined], ['present', 0]);
    const restored = await load(destination);
    const quarantine = new Set(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')).quarantine.map((entry) => entry.token));
    const own = [...restored.records, ...restored.facts].filter((entity) => (source.stored.records.some((item) => item.id === entity.id) || source.stored.facts.some((item) => item.id === entity.id)));
    assert.ok(own.length > 0);
    for (const entity of own) assert.equal(quarantine.has(entity.erasureToken), true, entity.id);
    const graph = createShadowGraph({ now });
    graph.importData(restored);
    const live = new Set([...privilegedLiveSnapshot(graph).records, ...privilegedLiveSnapshot(graph).facts].map((item) => item.id));
    assert.deepEqual(own.filter((entity) => live.has(entity.id)).map((entity) => entity.id), []);
  },
  'D ledger quarantine': async ({ result, ledgerBefore, destination }) => {
    assert.equal(result.deletionKnowledge, 'present');
    assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')), { ...ledgerBefore, generationBase: 1, generationCounters: [] }, 'only generation advances');
  },
  'B sidecar with knowledge': async ({ result, destination }) => {
    assert.equal(result.deletionKnowledge, 'none', 'an empty tombstone list');
    assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')), { version: 1, generationBase: 1, generationCounters: [] });
  },
  'registry tombstone': async ({ result, destination }) => {
    assert.equal(result.deletionKnowledge, 'none', 'a token B lacks');
    assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')), { version: 1, generationBase: 1, generationCounters: [] });
  },
  // Lifted; B's q material quarantined, its p material visible.
  'D purge marker': async ({ result, destination, source }) => {
    assert.equal(result.deletionKnowledge, 'present');
    const ledger = JSON.parse(await readFile(ledgerPath(destination.file), 'utf8'));
    assert.deepEqual(ledger.tombstones.map((item) => [item.purgedProject, item.mode, item.tokens, item.moveIn]), [['q', 'logical', null, 'none']]);
    const graph = createShadowGraph({ now });
    graph.importData(await load(destination));
    const live = new Set(privilegedLiveSnapshot(graph).records.map((item) => item.id));
    for (const item of source.stored.records) assert.equal(live.has(item.id), item.project !== 'q', `${item.project} ${item.kind}`);
  }
};

for (const [backend, options] of BACKENDS) {
  for (const name of REFUSING) test(`PR-37a restore ${backend} refuses: ${name}; memory-only too; D and its ledger unchanged`, options, async (t) => {
    const setup = TRIGGERS[name];
    const { destination, restore } = await restoreCase(t, backend, setup);
    const ledger = `${destination.file}.control.json`;
    const before = [await content(destination), await fileHash(ledger)];
    for (const memoryOnly of [false, true]) {
      await assert.rejects(restore(memoryOnly), (error) => error.code === PURGE_AWARE_RESTORE_UNSUPPORTED && !error.message.includes(destination.dir));
      assert.deepEqual([await content(destination), await fileHash(ledger)], before);
    }
  });
  for (const [name, check] of Object.entries(PROCEEDING)) test(`PR-37c restore ${backend} proceeds: ${name}; memory-only too (PR-37c design §13.4)`, options, async (t) => {
    for (const memoryOnly of [false, true]) {
      const { destination, source, env, restore } = await restoreCase(t, backend, TRIGGERS[name]);
      const registryBefore = await fileHash(registryFile(env));
      const ledgerBefore = await readFile(ledgerPath(destination.file), 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return null; throw error; });
      const result = await restore(memoryOnly);
      await check({ result, destination, source, ledgerBefore });
      assert.equal(await fileHash(registryFile(env)), registryBefore, 'the registry is never written');
    }
  });
  for (const [name, setup] of Object.entries(NON_TRIGGERS)) test(`PR-37a restore ${backend} proceeds: ${name}; D's generation advances while prior knowledge and the registry stay unchanged`, options, async (t) => {
    const { restore, destination, source, env } = await restoreCase(t, backend, setup);
    const files = [ledgerPath(destination.file), registryFile(env)];
    const before = await Promise.all(files.map(fileHash));
    const prior = await readFile(files[0], 'utf8').then(JSON.parse, error => { if (error.code === 'ENOENT') return { version: 1 }; throw error; });
    let base = 0;
    for (const memoryOnly of [false, true]) {
      await restore(memoryOnly);
      assert.deepEqual(JSON.parse(await readFile(files[0], 'utf8')), { ...prior, generationBase: ++base, generationCounters: [] });
      assert.equal(await fileHash(files[1]), before[1]);
    }
    const restored = await load(destination);
    assert.deepEqual(restored.records.map((item) => item.id), (await load(source)).records.map((item) => item.id));
  });
}

test('PR-37a restore: a cursor-bearing backup restores into a cursor-free store (the verdict is taken once, on D)', { skip: sqlite.available ? false : sqlite.reason }, async (t) => {
  const { restore, destination } = await restoreCase(t, 'sqlite', ({ source }) => rewrite(source, (payload) => ({ ...payload, captureSessions: payload.captureSessions.map((session) => ({ ...session, cursor: { carried: true } })) })));
  await restore(false);
  assert.ok((await load(destination)).captureSessions.some((session) => session.cursor));
});

async function call(t, surface, state, source) {
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: state.backend, SHADOWGRAPH_API_TOKEN: '', SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '' };
  if (surface === 'cli') {
    try { return { ok: true, text: (await execute(process.execPath, [cliPath, 'restore', source], { cwd: state.dir, env })).stdout }; }
    catch (error) { return { ok: false, text: `${error.stderr}` }; }
  }
  if (surface === 'http') {
    const app = await createShadowGraphServer({ file: state.file, storage: state.backend, cwd: state.dir, apiToken: '' });
    app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
    t.after(() => new Promise((resolve) => app.server.close(resolve)));
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, { method: 'POST', body: JSON.stringify({ source }) });
    return { ok: response.ok, text: await response.text() };
  }
  const child = spawn(process.execPath, [mcpPath], { cwd: state.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const responses = [];
  child.stdout.on('data', (data) => { buffer += data; const lines = buffer.split('\n'); buffer = lines.pop(); responses.push(...lines.filter(Boolean).map((line) => JSON.parse(line))); });
  const rpc = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let waited = 0; waited < 15000; waited += 20) {
      const found = responses.find((item) => item.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('MCP timeout');
  };
  await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  const response = await rpc(2, 'tools/call', { name: 'shadowgraph_restore', arguments: { source } });
  return { ok: !response.error && response.result?.isError !== true, text: JSON.stringify(response) };
}

for (const [backend, options] of BACKENDS) for (const surface of ['cli', 'http', 'mcp']) {
  // PR-37c design §13.4: knowledge proceeds and says so on every surface; a
  // refusal still crosses the boundary as its code, naming no path.
  test(`PR-37a restore ${backend}/${surface}: a restore that knowledge reaches succeeds with deletionKnowledge present; a refusal crosses the boundary as its code, naming no path, and D is unchanged`, options, async (t) => {
    const f = fixture();
    const destination = await storeOf(t, backend, f.payload, { version: 1, tombstones: [tombstone({ kind: 'project', purgedProject: 'z', tokens: null })] });
    const source = await storeOf(t, backend, fixture().payload);
    const result = await call(t, surface, destination, source.file);
    assert.equal(result.ok, true, result.text);
    assert.match(result.text, /deletionKnowledge\\?"\s*:\s*\\?"present/);
    const refused = await storeOf(t, backend, f.payload);
    const newer = await storeOf(t, backend, fixture().payload, { version: 2 });
    const before = await content(refused);
    const refusal = await call(t, surface, refused, newer.file);
    assert.equal(refusal.ok, false, refusal.text);
    assert.match(refusal.text, /purge_aware_restore_unsupported_at_this_build/);
    assert.equal(refusal.text.includes(refused.dir), false);
    assert.equal(await content(refused), before);
  });
}

test('PR-37a merge import: each trigger refuses a merge; a load into an empty graph and a replace do not', async (t) => {
  const f = fixture();
  const holding = () => { const graph = createShadowGraph({ now }); graph.addDecision({ project: 'q', title: 'held', chosen: 'h' }); return graph; };
  const viewOf = (payload, view) => Object.defineProperty(structuredClone(payload), DELETION_VIEW, { value: { tokens: new Set(), projects: [], knowledge: false, registryApplies: false, ...view } });
  const incoming = fixture().payload;
  // (1) the installed view has knowledge
  const viewed = await graphOf(await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger));
  assert.throws(() => viewed.importData(incoming), { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  const quarantined = await graphOf(await storeOf(t, 'json', f.payload, VIEWS.quarantine(f).ledger));
  assert.throws(() => quarantined.importData(incoming), { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  // (2) the incoming view has knowledge; (5) a registry tombstone applies to it
  assert.throws(() => holding().importData(viewOf(incoming, { knowledge: true })), { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  assert.throws(() => holding().importData(viewOf(incoming, { registryApplies: true })), { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  // (3) the graph's journal holds a purge marker
  const purged = holding(); purged.purgeProject('q', { mode: 'logical' });
  assert.throws(() => purged.importData(incoming), { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  // (4) the merge would replace a held transcript cursor
  const cursorPayload = structuredClone(f.payload);
  cursorPayload.captureSessions = cursorPayload.captureSessions.map((session) => ({ ...session, cursor: { carried: true } }));
  const cursored = createShadowGraph({ now }); cursored.importData(cursorPayload);
  assert.throws(() => cursored.importData({ captureSessions: cursorPayload.captureSessions.map(({ cursor, ...session }) => session) }), { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  // Not merges: a load into an empty graph, and a replace.
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(viewOf(incoming, { knowledge: true, registryApplies: true })));
  assert.doesNotThrow(() => viewed.replaceData(incoming));
  // Nothing applies: an ordinary merge still merges.
  assert.doesNotThrow(() => holding().importData({ records: [] }));
});

test('PR-37a registry applicability: a token tombstone always applies; lineage is disproved only by a backup holding its own different epoch and none of the lineage ids', async (t) => {
  const payload = fixture().payload;
  const epoch = payload.journal.find((entry) => entry.seq === payload.journalEpoch);
  assert.equal(tombstoneAppliesTo({ tokens: ['x'] }, payload), true);
  assert.equal(tombstoneAppliesTo({ tokens: null }, payload), true);
  assert.equal(tombstoneAppliesTo({ tokens: null, lineage: { epochEntryId: 'other' } }, payload), false);
  assert.equal(tombstoneAppliesTo({ tokens: null, lineage: { epochEntryId: epoch.id } }, payload), true);
  assert.equal(tombstoneAppliesTo({ tokens: null, lineage: { epochEntryId: 'other', headEntryId: payload.journal.at(-1).id } }, payload), true);
  assert.equal(tombstoneAppliesTo({ tokens: null, lineage: { headEntryId: 'other' } }, payload), true);
  assert.equal(tombstoneAppliesTo({ tokens: null, lineage: { epochEntryId: 'other' } }, { ...payload, journal: payload.journal.slice(1) }), true);
  assert.equal(tombstoneAppliesTo({ tokens: ['x'], lineage: { epochEntryId: 'other' } }, payload), true, 'tokens always apply');
  assert.equal(tombstoneAppliesTo({ tokens: null, lineage: { epochEntryId: 'other', markerEntryId: payload.journal.at(-1).id } }, payload), true, 'a marker lineage id proves lineage');
  const gapped = { ...payload, journal: payload.journal.filter((entry, index) => index !== 2) };
  assert.equal(tombstoneAppliesTo({ tokens: null, lineage: { epochEntryId: 'other' } }, gapped), true, 'a journal with a gap is not intact');
  const dir = await scratchDirectory(t, 'deletion-registry-');
  await assert.rejects(registryAppliesTo(payload, { SHADOWGRAPH_HOME: 'relative' }), { code: 'control_ledger_malformed' });
  assert.equal(await registryAppliesTo(payload, { SHADOWGRAPH_HOME: dir }), false);
});

for (const [backend, options] of BACKENDS) test(`PR-37a backup ${backend}: the ledger is copied byte for byte; a stale or different sidecar, a deletion-file destination and a pending record refuse`, options, async (t) => {
  const f = fixture();
  const ledgerText = `${JSON.stringify(VIEWS.unknown(f).ledger, null, 3)}\n`;
  const state = await storeOf(t, backend, f.payload, ledgerText);
  const store = await createStorage({ type: backend, file: state.file });
  t.after(() => store.close?.());
  const extension = backend === 'sqlite' ? 'db' : 'json';
  const backup = join(state.dir, `copy.${extension}`);
  await backupFile(state.file, backup, { store });
  assert.equal(await readFile(`${backup}.control.json`, 'utf8'), ledgerText);
  // The same bytes again are fine; different ones are never written over.
  await backupFile(state.file, backup, { store });
  await writeFile(`${backup}.control.json`, '{"version":1}');
  await assert.rejects(backupFile(state.file, backup, { store }), { code: 'backup_control_ledger_stale' });
  const plain = await storeOf(t, backend, f.payload);
  const plainStore = await createStorage({ type: backend, file: plain.file });
  t.after(() => plainStore.close?.());
  await assert.rejects(backupFile(plain.file, backup, { store: plainStore }), { code: 'backup_control_ledger_stale' });
  for (const target of [join(state.dir, 'x.control.json'), registryFile()]) {
    await assert.rejects(backupFile(state.file, target, { store }), { code: 'deletion_file_destination_refused' });
    if (backend === 'sqlite') await assert.rejects(store.backup(target), { code: 'deletion_file_destination_refused' });
  }
  await writeFile(`${state.file}.control.json`, JSON.stringify({ version: 1, pending: [{ kind: 'purge' }] }));
  await assert.rejects(backupFile(state.file, join(state.dir, `other.${extension}`), backend === 'sqlite' ? { store } : {}), { code: 'deletion_pending_unsupported_at_this_build' });
});

test('PR-37a preservation copy: the copy carries the ledger, hashed with it', async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const store = await createStorage({ file: state.file });
  const copy = await writePreservationCopy({ store, file: state.file, destination: join(state.dir, 'kept.json') });
  assert.equal(copy.controlLedger.sha256, await fileHash(`${state.file}.control.json`));
  assert.equal(copy.controlLedger.path, join(state.dir, 'kept.json.control.json'));
});

for (const [backend, options] of BACKENDS) test(`PR-37a below floor ${backend}: a downgrade leaves W out, counts it without ids, keeps the preservation copy's ledger, gives its output only the tokensStripped flag, and refuses a stale output ledger`, options, async (t) => {
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const store = await createStorage({ type: backend, file: state.file });
  t.after(() => store.close?.());
  const graph = createShadowGraph({ now });
  graph.importData(await store.load());
  const extension = backend === 'sqlite' ? 'db' : 'json';
  const output = join(state.dir, `down.${extension}`);
  const result = await downgradeStore({ graph, store, file: state.file, storageType: backend, output, preservationCopy: join(state.dir, `kept.${extension}`), toSchemaVersion: 6, now });
  const downgraded = await load({ file: output, backend });
  assert.equal(JSON.stringify(downgraded).includes(SENTINEL), false);
  for (const id of [f.ids.hidden, f.ids.alternative, f.ids.memory, f.ids.fact, f.ids.capture]) assert.equal(JSON.stringify(downgraded).includes(id), false, `no withheld id below the floor: ${id}`);
  for (const id of [f.ids.hidden, f.ids.memory, f.ids.fact, f.ids.capture]) assert.equal(JSON.stringify(result).includes(id), false);
  assert.ok(result.withheldEntryCounts.records >= 2);
  assert.ok(result.withheldEntryCounts.journal >= 2);
  // Its output gets a ledger of exactly the tokensStripped flag (PR-37c design §4.7, §13.4).
  assert.deepEqual(Object.keys(JSON.parse(await readFile(`${output}.control.json`, 'utf8'))).sort(), ['tokensStripped', 'version']);
  assert.ok(existsSync(join(state.dir, `kept.${extension}.control.json`)));
  const stale = join(state.dir, `again.${extension}`);
  await writeFile(`${stale}.control.json`, '{"version":1}');
  await assert.rejects(downgradeStore({ graph, store, file: state.file, storageType: backend, output: stale, preservationCopy: join(state.dir, `kept2.${extension}`), toSchemaVersion: 6, now }), { code: 'backup_control_ledger_stale' });
});

test('PR-37a restore.reapplied: a hand-built post-step store restore-validates with rebuild parity; malformed shapes are refused; shadowgraph.js is its one writer (PR-37c design §13.4)', async () => {
  const f = fixture();
  const reapplied = (payload, mode, fields = {}) => {
    const seq = ++payload.journalSeq;
    payload.journal.push({ id: `reapplied-${seq}`, seq, type: 'restore.reapplied', at: NOW, project: null, entityKind: null, entityId: null, schemaVersion: 7, payload: { mode, removedJournalSequences: [], removed: 1, skeletons: 0, ...fields }, provenance: NULL_PROVENANCE });
    return payload;
  };
  // Logical: W's entries are skeletons, its entities gone.
  const logical = withoutWithheld(f.payload, { tokens: [f.tokens.hidden], projects: [] }).payload;
  assert.doesNotThrow(() => validateRestorePayload(reapplied(structuredClone(logical), 'logical', { skeletons: 3 })));
  // Hard: W's entries spliced, the gap they leave explained by the entry.
  const hard = structuredClone(logical);
  const removed = hard.journal.filter((entry) => entry.redacted === true).map((entry) => entry.seq);
  hard.journal = hard.journal.filter((entry) => entry.redacted !== true);
  assert.doesNotThrow(() => validateRestorePayload(reapplied(structuredClone(hard), 'hard', { removedJournalSequences: removed, spliced: removed.length })));
  for (const fields of [{ quarantinedIds: 1 }, { removed: -1 }, { removed: { nested: 1 } }, { mode: 'soft' }, { removedJournalSequences: [1] }]) {
    assert.throws(() => validateRestorePayload(reapplied(structuredClone(logical), 'logical', fields)), undefined, JSON.stringify(fields));
  }
  for (const envelope of [{ project: 'p' }, { entityId: 'x' }, { entityKind: 'decision' }, { actor: 'someone' }]) {
    const payload = reapplied(structuredClone(logical), 'logical');
    Object.assign(payload.journal.at(-1), envelope);
    assert.throws(() => validateRestorePayload(payload), undefined, JSON.stringify(envelope));
  }
  // A hard gap no entry explains is refused, and so are sequences out of order.
  assert.throws(() => validateRestorePayload(reapplied(structuredClone(hard), 'hard')));
  assert.throws(() => validateRestorePayload(reapplied(structuredClone(hard), 'hard', { removedJournalSequences: [...removed].reverse() })));
  assert.throws(() => validateRestorePayload(reapplied(structuredClone(hard), 'hard', { removedJournalSequences: [...removed, removed[0]] })));
  // Never legacy metadata, and refused at import as at restore.
  assert.equal(isLegacyUnnumberedMetadataEntry({ id: 'x', type: 'restore.reapplied', at: NOW, schemaVersion: 1 }), false);
  assert.throws(() => createShadowGraph({ now }).importData(reapplied(structuredClone(logical), 'logical', { removed: -1 })));
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const emitters = [];
  for (const name of (await readdir(src, { recursive: true })).filter((item) => item.endsWith('.js'))) {
    if (name !== 'journal.js' && /type:\s*'restore\.reapplied'/.test(await readFile(join(src, name), 'utf8'))) emitters.push(name);
  }
  assert.deepEqual(emitters, ['shadowgraph.js']);
});

test('PR-37a codes: every deletion refusal is a public MCP code, and generation state is confined to the internal ledger implementation', async () => {
  const mcp = await readFile(new URL('../src/mcp.js', import.meta.url), 'utf8');
  assert.match(mcp, /\.\.\.DELETION_CODES/);
  assert.equal(DELETION_CODES.length, 9);
  const src = fileURLToPath(new URL('../src/', import.meta.url));
  const users = [];
  for (const name of (await readdir(src, { recursive: true })).filter((item) => item.endsWith('.js'))) {
    if (/generationBase/.test(await readFile(join(src, name), 'utf8'))) users.push(name.replaceAll('\\', '/'));
  }
  assert.deepEqual(users.sort(), ['internal/capture-generation.js', 'internal/deletion-knowledge.js']);
});

// F17 asks that the registry root not be under the home; on Windows the
// scratch directory itself is under the home, so the guard checks the
// owner's own ShadowGraph folder (declared).
test('PR-37a isolation: no test resolves the deletion registry under the real home', () => {
  const file = registryFile();
  assert.ok(file, 'SHADOWGRAPH_HOME resolves');
  assert.ok(isAbsolute(process.env.SHADOWGRAPH_HOME));
  const inside = relative(join(userInfo().homedir, '.shadowgraph'), file);
  assert.ok(inside.startsWith('..') || isAbsolute(inside), 'the registry is not the owner\'s');
});

for (const [backend, options] of BACKENDS) test(`PR-37a registry at load ${backend}: a registry tombstone that applies is noted for the merge refusal only, and an unreadable registry never fails a load`, options, async (t) => {
  const f = fixture();
  // Model PR-37a's retention-neutral shape. A newly stamped deadline now
  // independently refuses merge, which this registry-only case does not test.
  const legacy = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.kind === 'capture') value.expiresAt = null;
    for (const child of Object.values(value)) legacy(child);
  };
  legacy(f.payload);
  const state = await storeOf(t, backend, f.payload);
  const env = { SHADOWGRAPH_HOME: join(state.dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const holding = () => { const graph = createShadowGraph({ now }); graph.importData({ events: [{ id: 'held-event', type: 'note' }] }); return graph; };
  const none = await load(state, { env });
  assert.equal(none[DELETION_VIEW].registryApplies, false);
  assert.doesNotThrow(() => holding().importData(none));
  await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [tombstone({ tokens: ['anything'] })] }));
  const applied = await load(state, { env });
  assert.equal(applied[DELETION_VIEW].registryApplies, true);
  const loaded = createShadowGraph({ now });
  loaded.importData(applied);
  assert.equal(privilegedLiveSnapshot(loaded).records.some((item) => item.id === f.ids.hidden), true, 'the registry withholds nothing at load');
  assert.throws(() => holding().importData(applied), { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  await writeFile(registryFile(env), '{ not json');
  assert.equal((await load(state, { env }))[DELETION_VIEW].registryApplies, true);
});

test('PR-37a Markdown pull: a file of a withheld memory reads as one whose memory is missing', async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload);
  const directory = join(state.dir, 'markdown');
  await syncMarkdownWorkspace({ graph: plainOf(state), directory, mode: 'push', project: 'p' });
  await writeFile(`${state.file}.control.json`, JSON.stringify(VIEWS.item(f).ledger));
  const viewed = await graphOf(state);
  const before = privilegedSnapshot(viewed);
  const result = await syncMarkdownWorkspace({ graph: viewed, directory, mode: 'pull', project: 'p', dryRun: true });
  assert.deepEqual(result.conflicts.map((item) => item.reason), ['canonical_memory_missing']);
  assert.deepEqual(privilegedSnapshot(viewed), before);
});

test('PR-37a transcript: a withheld transcript item counts as held, so a rewound cursor never captures its text again', async (t) => {
  const say = (uuid, text) => `${JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;
  const file = { ref: 'ref-a', bytes: Buffer.alloc(0), size: () => file.bytes.length, read: (start, length) => file.bytes.subarray(start, start + length) };
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const read = (target, trigger) => privilegedRecordTranscript(target, { originId: 'origin-a', sessionId: 'session-1', project: 'p', activatedAt: '2026-08-01T00:00:00.000Z', trigger, triggerItemId: null, transcript: file, admission: ADMISSION });
  read(graph, null);
  const rewound = structuredClone(privilegedSnapshot(graph).captureSessions[0].cursor);
  file.bytes = Buffer.from(say('u-1', `assistant ${SENTINEL}`));
  read(graph, 'Stop');
  const payload = privilegedSnapshot(graph);
  const item = payload.records.find((entry) => entry.kind === 'capture' && entry.source.event === 'Transcript');
  assert.ok(item, 'the text was captured once');
  payload.captureSessions[0].cursor = rewound;
  const state = await storeOf(t, 'json', payload, { version: 1, tombstones: [tombstone({ tokens: [item.erasureToken] })] });
  const viewed = await graphOf(state);
  read(viewed, 'Stop');
  const after = privilegedSnapshot(viewed);
  assert.equal(after.records.filter((entry) => entry.kind === 'capture' && entry.source.event === 'Transcript').length, 1, 'never captured again');
  assert.doesNotThrow(() => validateRestorePayload(after));
});

test('PR-37a capture hook: an event of a session deletion records withhold writes nothing', async (t) => {
  const root = await scratchDirectory(t, 'deletion-capture-hook-');
  const cwd = join(root, 'work');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  const home = join(root, 'home');
  await mkdir(home);
  const file = join(root, 'private', 'memory.json');
  await mkdir(join(root, 'private'));
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: cwd, project: 'alpha', confirmed: true }));
  const graph = createShadowGraph();
  privilegedBindProject(graph, { type: 'worktree', path: cwd, project: 'alpha', reason: 'synthetic capture test', surface: 'cli' });
  const store = await createStorage({ file });
  await store.save(privilegedSnapshot(graph));
  const capture = { state: 'active', changedAt: '2026-01-01T00:00:00.000Z', evidence: 'synthetic', store: { file, storage: 'json' }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'] };
  const run = (input) => runCapture({ capture, input: JSON.stringify({ session_id: 'session-1', cwd: '/work', ...input }), deadline: Date.now() + 10_000, record: join(root, 'activation.json'), home, cwd });
  assert.equal(await run({ hook_event_name: 'UserPromptSubmit', prompt: 'first prompt', message_id: 'msg_1' }), 'written');
  await writeFile(`${file}.control.json`, JSON.stringify({ version: 1, tombstones: [tombstone({ kind: 'project', purgedProject: 'alpha', tokens: null, at: '2099-01-01T00:00:00.000Z' })] }));
  const before = await readFile(file);
  const self = await run({ hook_event_name: 'PostToolUse', tool_name: 'mcp__shadowgraph__search', tool_input: {}, tool_response: 'x', tool_use_id: 'toolu_1' });
  assert.equal((await readFile(file)).toString(), before.toString(), 'self-event: ' + self);
  const prompt = await run({ hook_event_name: 'UserPromptSubmit', prompt: 'second prompt', message_id: 'msg_2' });
  assert.equal((await readFile(file)).toString(), before.toString(), 'prompt: ' + prompt);
});

// ---------------------------------------------------------------------------
// The review round (briefs/PR37a-review-correctness.md, -contract.md, -tests.md).
// ---------------------------------------------------------------------------

const BACK = String.fromCharCode(92);
const namespaced = (path) => `${BACK}${BACK}?${BACK}${path}`;
// A file's 8.3 name, where the volume keeps them.
function shortName(path) {
  if (process.platform !== 'win32') return null;
  try {
    const short = execSync(`cmd /c for %I in ("${path}") do @echo %~sI`, { encoding: 'utf8' }).trim();
    return short && short.toLowerCase() !== path.toLowerCase() ? short : null;
  } catch { return null; }
}
const WINDOWS = process.platform === 'win32' ? {} : { skip: 'Windows path spellings' };


for (const [backend, options] of BACKENDS) test(`K-1/C-1 ${backend}: a backup never lands on a ledger or the registry, however its path is spelled`, { ...WINDOWS, ...options }, async (t) => {
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const other = await storeOf(t, backend, f.payload, VIEWS.quarantine(f).ledger);
  const env = { SHADOWGRAPH_HOME: join(state.dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [tombstone({ tokens: ['kept'] })] }));
  const store = await createStorage({ type: backend, file: state.file, env });
  t.after(() => store.close?.());
  const targets = [ledgerPath(other.file), registryFile(env)];
  const before = await Promise.all(targets.map(fileHash));
  const spellings = targets.flatMap((target) => [namespaced(target), shortName(target)].filter(Boolean));
  for (const destination of spellings) {
    await assert.rejects(backupFile(state.file, destination, { store, env }), { code: 'deletion_file_destination_refused' }, destination);
    if (backend === 'sqlite') await assert.rejects(store.backup(destination), { code: 'deletion_file_destination_refused' }, destination);
  }
  assert.deepEqual(await Promise.all(targets.map(fileHash)), before);
  // A registry not there yet: its name in its folder, spelled otherwise.
  fsModule.rmSync(registryFile(env));
  await assert.rejects(backupFile(state.file, namespaced(registryFile(env)), { store, env }), { code: 'deletion_file_destination_refused' });
  assert.equal(existsSync(registryFile(env)), false);
  // A copy at another spelling of an existing backup is that backup's: its sidecar decides.
  const backup = join(state.dir, `copy.${backend === 'sqlite' ? 'db' : 'json'}`);
  await backupFile(state.file, backup, { store, env });
  await writeFile(ledgerPath(backup), '{"version":1}');
  for (const alias of [namespaced(backup), shortName(backup)].filter(Boolean)) {
    await assert.rejects(backupFile(state.file, alias, { store, env }), { code: 'backup_control_ledger_stale' }, alias);
  }
});

// PR-37c design §13.4: the hard-linked name still refuses; the names that find
// the sidecar now proceed and merge it.
for (const [backend, options] of BACKENDS) test(`C-2 ${backend}: a backup reached through another name keeps its sidecar, or the restore refuses`, options, async (t) => {
  const f = fixture();
  const destination = await storeOf(t, backend, f.payload);
  const source = await storeOf(t, backend, fixture().payload, { version: 1, quarantine: [{ token: f.tokens.memory }] });
  const linked = join(source.dir, `latest.${backend === 'sqlite' ? 'db' : 'json'}`);
  await link(source.file, linked);
  const restore = (name) => (backend === 'json'
    ? restoreFile(name, destination.file)
    : (async () => { const store = await createStorage({ type: 'sqlite', file: destination.file }); try { return await store.restore(name); } finally { store.close(); } })());
  const before = await content(destination);
  await assert.rejects(restore(linked), { code: PURGE_AWARE_RESTORE_UNSUPPORTED }, linked);
  assert.equal(await content(destination), before);
  for (const name of (process.platform === 'win32' ? [namespaced(source.file), shortName(source.file)] : []).filter(Boolean)) {
    assert.equal((await restore(name)).deletionKnowledge, 'present', name);
    assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')).quarantine, [{ token: f.tokens.memory }], name);
  }
});

for (const [backend, options] of BACKENDS) test(`C-5 ${backend}: a backup onto the store's own path leaves its ledger as it is`, options, async (t) => {
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const ledger = ledgerPath(state.file);
  const before = await stat(ledger, { bigint: true });
  const bytes = await readFile(ledger);
  const store = backend === 'sqlite' ? await createStorage({ type: 'sqlite', file: state.file }) : null;
  try { await backupFile(state.file, state.file, store ? { store } : {}); } finally { store?.close(); }
  const after = await stat(ledger, { bigint: true });
  assert.equal(after.ino, before.ino, 'never renamed over');
  assert.deepEqual(await readFile(ledger), bytes);
});

test('C-9: a restore into a destination that cannot be read refuses; a fresh destination restores', async (t) => {
  const f = fixture();
  const destination = await storeOf(t, 'json', f.payload);
  const source = await storeOf(t, 'json', fixture().payload);
  await writeFile(destination.file, '{ not a store');
  await assert.rejects(restoreFile(source.file, destination.file), (error) => error.code === PURGE_AWARE_RESTORE_UNSUPPORTED && /fresh path/.test(error.message));
  assert.equal(await readFile(destination.file, 'utf8'), '{ not a store');
  const fresh = join(destination.dir, 'fresh.json');
  await restoreFile(source.file, fresh);
  assert.ok((await load({ file: fresh, backend: 'json' })).records.length);
});

// PR-37c design §13.4, §3.5 (V-5): a same-path restore is unchanged, says
// whether knowledge reaches it, and writes nothing.
test('K-6/T-24: a restore of a store onto itself is unchanged where deletion records apply, says so, and writes nothing', async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const before = [await fileHash(state.file), await fileHash(ledgerPath(state.file))];
  const inode = (await stat(ledgerPath(state.file), { bigint: true })).ino;
  const result = await restoreFile(state.file, state.file);
  assert.deepEqual([result.unchanged, result.deletionKnowledge], [true, 'present']);
  assert.deepEqual([await fileHash(state.file), await fileHash(ledgerPath(state.file))], before);
  assert.equal((await stat(ledgerPath(state.file), { bigint: true })).ino, inode, 'never rewritten, not even put back');
});

test('C-4: a memory written into a scope whose latest version W holds takes the version a graph with no view would give', async (t) => {
  const use = deterministic(t);
  use('fixture', 4242);
  const graph = createShadowGraph({ now });
  graph.remember({ project: 'p', memoryType: 'note', key: 'versioned', text: 'v1' });
  const second = graph.remember({ project: 'p', memoryType: 'note', key: 'versioned', text: `v2 ${SENTINEL}` }).memory;
  graph.applyMemoryPlan({ project: 'p', operations: [{ action: 'DELETE', memoryType: 'note', key: 'versioned' }] });
  const payload = privilegedSnapshot(graph);
  const token = payload.records.find((item) => item.id === second.id).erasureToken;
  const state = await storeOf(t, 'json', payload, { version: 1, tombstones: [tombstone({ tokens: [token] })] });
  use('load'); const loaded = await load(state);
  use('viewed'); const viewed = createShadowGraph({ now }); viewed.importData(loaded);
  use('plain'); const plain = plainOf(state);
  use('viewed'); const written = viewed.remember({ project: 'p', memoryType: 'note', key: 'versioned', text: 'v3' }).memory;
  use('plain'); const expected = plain.remember({ project: 'p', memoryType: 'note', key: 'versioned', text: 'v3' }).memory;
  assert.equal(written.version, expected.version);
  use('checks');
  assert.deepEqual(privilegedSnapshot(viewed), privilegedSnapshot(plain));
});

test('R-4 fault: a fault after replaceData clears the graph leaves the store and W as they were', async (t) => {
  const f = fixture();
  const loaded = await load(await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger));
  const graph = createShadowGraph({ now });
  graph.importData(loaded);
  const before = privilegedSnapshot(graph);
  const view = loaded[DELETION_VIEW];
  let faulted = false;
  for (let fault = 1; fault < 400 && !faulted; fault += 1) {
    let reads = 0;
    const hostile = { ...view, get tokens() { if (++reads === fault) throw new Error('injected fault'); return view.tokens; } };
    try { graph.replaceData(Object.defineProperty(structuredClone(before), DELETION_VIEW, { value: hostile })); }
    catch (error) { faulted = error.message.includes('injected fault') && !error.message.startsWith('Refusing to replace'); }
  }
  assert.ok(faulted, 'a fault after the clear was injected');
  assert.deepEqual(privilegedSnapshot(graph), before);
  assert.equal(privilegedLiveSnapshot(graph).records.some((item) => item.id === f.ids.hidden), false);
});

test('R-4 fault: a fault inside a purge that reaches W leaves the store and W as they were', async (t) => {
  const f = fixture();
  const loaded = await load(await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger));
  const base = loaded[DELETION_VIEW];
  let armed = false;
  let reads = 0;
  const view = { ...base, get tokens() { if (armed && ++reads === 1) throw new Error('injected fault'); return base.tokens; } };
  const graph = createShadowGraph({ now });
  graph.importData(Object.defineProperty(structuredClone(loaded), DELETION_VIEW, { value: view }));
  const before = privilegedSnapshot(graph);
  armed = true;
  assert.throws(() => graph.purgeProject('p', { mode: 'logical' }), /injected fault/);
  assert.deepEqual(privilegedSnapshot(graph), before);
  assert.equal(privilegedLiveSnapshot(graph).records.some((item) => item.id === f.ids.hidden), false);
});

for (const [backend, options] of BACKENDS) test(`T-5 ${backend}: what delivery reads withholds W`, options, async (t) => {
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const read = await readStoreForDelivery({ file: state.file, storage: backend });
  const graph = createShadowGraph({ now });
  graph.importData(read.payload);
  const text = JSON.stringify([graph.exportData({ project: 'p' }), graph.context({ project: 'p', query: 'hidden decision memory' })]);
  for (const piece of [SENTINEL, f.ids.hidden, f.tokens.hidden]) assert.equal(text.includes(piece), false);
});

async function mcpCalls(t, state, calls, extraEnv = {}) {
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: state.backend, SHADOWGRAPH_API_TOKEN: '', SHADOWGRAPH_MCP_COMPACT: '0', SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '', ...extraEnv };
  const child = spawn(process.execPath, [mcpPath], { cwd: state.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(async () => { if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; } });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const responses = [];
  child.stdout.on('data', (data) => { buffer += data; const lines = buffer.split('\n'); buffer = lines.pop(); responses.push(...lines.filter(Boolean).map((line) => JSON.parse(line))); });
  const rpc = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let waited = 0; waited < 15000; waited += 20) {
      const found = responses.find((item) => item.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error('MCP timeout');
  };
  await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  const texts = [];
  let id = 2;
  for (const [name, args] of calls) texts.push(JSON.stringify(await rpc(id++, 'tools/call', { name, arguments: args })));
  return texts;
}

for (const [backend, options] of BACKENDS) test(`T-4 ${backend}: HTTP, CLI and MCP reads name no withheld token, id or content`, options, async (t) => {
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const app = await createShadowGraphServer({ file: state.file, storage: backend, cwd: state.dir, apiToken: '' });
  app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const texts = [];
  for (const path of ['/records?project=p', '/search?project=p&q=hidden', '/journal?project=p', '/stats?project=p']) texts.push(await (await fetch(base + path)).text());
  texts.push(await (await fetch(`${base}/context`, { method: 'POST', body: JSON.stringify({ project: 'p', query: 'hidden decision memory' }) })).text());
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_API_TOKEN: '' };
  for (const args of [['list', JSON.stringify({ project: 'p' })], ['search', JSON.stringify({ project: 'p', query: 'hidden' })]]) texts.push((await execute(process.execPath, [cliPath, ...args], { cwd: state.dir, env })).stdout);
  texts.push(...await mcpCalls(t, state, [['shadowgraph_search', { query: 'hidden decision', project: 'p' }], ['shadowgraph_journal', { project: 'p' }], ['shadowgraph_redact', { project: 'p' }], ['shadowgraph_context', { project: 'p', query: 'hidden' }]]));
  const contents = withheldContents(f, VIEWS.item(f).tokens);
  for (const text of texts) {
    for (const piece of [...contents, f.ids.hidden, f.ids.memory, f.ids.fact, f.ids.capture, ...VIEWS.item(f).tokens]) assert.equal(text.includes(piece), false, `${piece} in ${text.slice(0, 120)}`);
  }
});

test('R-11.4: a stored live link survives logical purge while public reads withhold its inaccessible target', async (t) => {
  const f = fixture();
  const graph = createShadowGraph({ now });
  graph.importData(structuredClone(f.payload));
  graph.supersedeDecision({ project: 'p', decisionId: f.ids.hidden, replacementId: f.ids.kept, reason: 'replaced' });
  const viewed = await graphOf(await storeOf(t, 'json', privilegedSnapshot(graph), VIEWS.item(f).ledger));
  const LINK_FIELDS = new Set(['supersedes', 'supersededBy', 'relatedTo', 'failedAttempts']);
  const found = [];
  const walk = (value, key) => {
    if (typeof value === 'string') { if (value.includes(f.ids.hidden)) found.push(key); }
    else if (Array.isArray(value)) value.forEach((item) => walk(item, key));
    else if (value && typeof value === 'object') for (const [child, item] of Object.entries(value)) walk(item, child);
  };
  walk(privilegedLiveSnapshot(viewed).records, null);
  assert.ok(found.length, 'the canonical live relationship is still there');
  assert.deepEqual([...new Set(found)].filter((key) => !LINK_FIELDS.has(key)), []);
  found.length = 0;
  walk([viewed.exportData({ project: 'p' }).records, viewed.search('kept', { project: 'p' }), viewed.context({ project: 'p', query: 'kept decision' })], null);
  assert.deepEqual(found, [], 'public records do not name the withheld target, even through link fields');
});

test('T-9/R-8: a copy whose sidecar cannot land leaves no payload copy (the ledger copy lands first)', async (t) => {
  for (const backend of BACKENDS.filter(([, options]) => !options.skip).map(([name]) => name)) {
    const f = fixture();
    const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
    const store = backend === 'sqlite' ? await createStorage({ type: 'sqlite', file: state.file }) : null;
    const backup = join(state.dir, `copy.${backend === 'sqlite' ? 'db' : 'json'}`);
    const original = fsModule.promises.rename;
    fsModule.promises.rename = async (from, to) => { if (String(to).endsWith('.control.json')) throw Object.assign(new Error('injected'), { code: 'EIO' }); return original(from, to); };
    syncBuiltinESMExports();
    try { await assert.rejects(backupFile(state.file, backup, store ? { store } : {})); }
    finally { fsModule.promises.rename = original; syncBuiltinESMExports(); store?.close(); }
    assert.equal(existsSync(backup), false, `${backend}: no payload copy without its sidecar`);
  }
});

test('T-10: a tombstoned project\'s access entries are never withheld', async (t) => {
  const f = fixture();
  const payload = structuredClone(f.payload);
  payload.events.push({ id: 'access-before', type: 'access.issued', at: BEFORE, project: 'p' });
  const viewed = await graphOf(await storeOf(t, 'json', payload, VIEWS.project(f).ledger));
  assert.ok(privilegedLiveSnapshot(viewed).events.some((item) => item.id === 'access-before'));
  assert.equal(privilegedLiveSnapshot(viewed).events.some((item) => item.id === 'note-before'), false);
});

test('T-14: a downgrade whose output is a deletion record path is refused', async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const store = await createStorage({ file: state.file });
  const graph = createShadowGraph({ now });
  graph.importData(await store.load());
  await assert.rejects(downgradeStore({ graph, store, file: state.file, storageType: 'json', output: join(state.dir, 'x.control.json'), preservationCopy: join(state.dir, 'kept.json'), toSchemaVersion: 6, now }), { code: 'deletion_file_destination_refused' });
});

// PR #12 security review: a store copy carries unknown top-level members byte
// for byte, so one written over the activation record could turn capture or
// delivery on with no owner confirmation. No copy lands on the owner's files
// beside the registry, existing or not, however the name is cased.
test('a copy never lands on the activation record or the extraction state files', async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const env = { SHADOWGRAPH_HOME: join(state.dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const activation = join(env.SHADOWGRAPH_HOME, 'activation.json');
  await writeFile(activation, '{"version":1,"capabilities":{}}');
  const before = await fileHash(activation);
  const owned = ['activation.json', 'extraction-usage.json', 'extraction-invocations.json', 'extraction-worker', 'extraction-worker.settlement.json'];
  for (const name of [...owned, 'Activation.JSON', ...owned.map((file) => `${file}.lock`)]) {
    await assert.rejects(backupFile(state.file, join(env.SHADOWGRAPH_HOME, name), { env }), { code: 'deletion_file_destination_refused' }, name);
  }
  assert.equal(await fileHash(activation), before);
  assert.deepEqual(await readdir(env.SHADOWGRAPH_HOME), ['activation.json'], 'nothing was written beside it');
  const store = await createStorage({ file: state.file });
  const graph = createShadowGraph({ now });
  graph.importData(await store.load());
  assert.ok(process.env.SHADOWGRAPH_HOME, 'the process home is the isolated test home');
  await assert.rejects(downgradeStore({ graph, store, file: state.file, storageType: 'json', output: join(dirname(registryFile()), 'activation.json'), preservationCopy: join(state.dir, 'kept.json'), toSchemaVersion: 6, now }), { code: 'deletion_file_destination_refused' });
  // Any other name in that folder still takes a backup.
  await backupFile(state.file, join(env.SHADOWGRAPH_HOME, 'store-backup.json'), { env });
  assert.ok(existsSync(join(env.SHADOWGRAPH_HOME, 'store-backup.json')));
});

// A SQLite store's own backup, which a library caller may reach directly,
// refuses the same files.
test('a SQLite backup called directly never lands on the activation record or its lock', BACKENDS[1][1], async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'sqlite', f.payload, VIEWS.item(f).ledger);
  const env = { SHADOWGRAPH_HOME: join(state.dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const store = await createStorage({ type: 'sqlite', file: state.file, env });
  t.after(() => store.close?.());
  for (const name of ['activation.json', 'activation.json.lock']) {
    await assert.rejects(store.backup(join(env.SHADOWGRAPH_HOME, name)), { code: 'deletion_file_destination_refused' }, name);
  }
  assert.deepEqual(await readdir(env.SHADOWGRAPH_HOME), []);
});

test('T-6/C1: a capture re-sent with the host id of a withheld capture is refused and writes nothing', async (t) => {
  const graph = createShadowGraph({ now });
  const source = { event: 'UserPromptSubmit', sessionId: 'session-9', role: 'user', hostEventId: 'msg_1' };
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: `capture ${SENTINEL}`, admission: ADMISSION, source });
  const payload = privilegedSnapshot(graph);
  const token = payload.records.find((entry) => entry.id === item.id).erasureToken;
  const viewed = await graphOf(await storeOf(t, 'json', payload, { version: 1, tombstones: [tombstone({ tokens: [token] })] }));
  const before = privilegedSnapshot(viewed);
  assert.deepEqual(privilegedRecordCapture(viewed, { project: 'p', originId: 'origin-a', text: 'again', admission: ADMISSION, source }), { refused: { reason: 'idempotency_key_withheld' }, changed: false });
  assert.deepEqual(privilegedSnapshot(viewed), before);
});

test('T-15: a withheld legacy entity stored with no project keeps that mark through a save', async (t) => {
  const graph = createShadowGraph({ now });
  const ids = {};
  ids['decision-alpha'] = graph.addDecision({ project: 'alpha', title: 'Alpha', chosen: 'x' }).id;
  ids['decision-z-projectless'] = graph.addDecision({ project: 'default', title: `Stored without a project ${SENTINEL}`, chosen: 'z' }).id;
  const payload = historicalIds(privilegedSnapshot(graph), ids, { now });
  payload.schemaVersion = 5;
  const strip = (entity) => { if (!entity || typeof entity !== 'object') return; delete entity.attribution; delete entity.originId; delete entity.erasureToken; delete entity.causalClaim; if (entity.schemaVersion >= 6) entity.schemaVersion = 5; };
  for (const entity of [...payload.records, ...payload.facts, ...payload.relations]) strip(entity);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  for (const entity of payload.records) if (entity.id === 'decision-z-projectless') delete entity.project;
  for (const entry of payload.journal) if (entry.entityId === 'decision-z-projectless') { delete entry.payload.project; entry.project = null; }
  const loaded = createShadowGraph({ now });
  loaded.importData(payload);
  const stored = privilegedSnapshot(loaded);
  stored.records.find((item) => item.id === 'decision-z-projectless').erasureToken = '11111111-2222-4333-8444-555555555555';
  const state = await storeOf(t, 'json', stored, { version: 1, tombstones: [tombstone({ tokens: ['11111111-2222-4333-8444-555555555555'] })] });
  const viewed = await graphOf(state);
  assert.equal(privilegedLiveSnapshot(viewed).records.some((item) => item.id === 'decision-z-projectless'), false);
  assert.ok(privilegedSnapshot(plainOf(state)).storedWithoutProject?.includes('decision-z-projectless'));
  assert.deepEqual(privilegedSnapshot(viewed).storedWithoutProject, privilegedSnapshot(plainOf(state)).storedWithoutProject);
});

test('transcript rule 2: a withheld Stop\'s final message found in the transcript is never captured again', async (t) => {
  const say = (uuid, text) => `${JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;
  const file = { ref: 'ref-a', bytes: Buffer.alloc(0), size: () => file.bytes.length, read: (start, length) => file.bytes.subarray(start, start + length) };
  let clock = Date.parse('2026-09-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const read = (target, trigger) => privilegedRecordTranscript(target, { originId: 'origin-a', sessionId: 'session-1', project: 'p', activatedAt: '2026-08-01T00:00:00.000Z', trigger, triggerItemId: null, transcript: file, admission: ADMISSION });
  read(graph, null);
  const stop = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: `final words ${SENTINEL}`, admission: ADMISSION, source: { event: 'Stop', sessionId: 'session-1', role: 'assistant' } });
  const payload = privilegedSnapshot(graph);
  file.bytes = Buffer.from(say('u-9', `final words ${SENTINEL}`));
  const token = payload.records.find((entry) => entry.id === stop.id).erasureToken;
  const viewed = await graphOf(await storeOf(t, 'json', payload, { version: 1, tombstones: [tombstone({ tokens: [token] })] }));
  read(viewed, 'Stop');
  assert.equal(JSON.stringify(privilegedLiveSnapshot(viewed)).includes(SENTINEL), false, 'the withheld Stop\'s words are not captured again');
  assert.doesNotThrow(() => validateRestorePayload(privilegedSnapshot(viewed)));
});

for (const [backend, options] of BACKENDS) for (const viewName of ['project', 'item']) test(`T-6 ${backend} ${viewName}: the full store stays valid after every writer, the privileged capture writers included, and W-disjoint writes stay transparent`, options, async (t) => {
  const use = deterministic(t);
  use('fixture', 4242);
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS[viewName](f).ledger);
  use('load'); const loaded = await load(state);
  use('viewed'); const viewed = createShadowGraph({ now }); viewed.importData(loaded);
  use('plain'); const plain = plainOf(state);
  const made = {};
  const lease = { leaseId: 'l', ownerId: 'o', ownerBootId: 'b', leaseExpiresAt: '2099-01-01T00:00:00.000Z' };
  const fresh = { event: 'UserPromptSubmit', sessionId: 'session-2', role: 'user' };
  // [label, write, whether it reaches W in a graph with no view]
  const writes = [
    ['capture, new session', (g) => { made.capture = privilegedRecordCapture(g, { project: 'p', originId: 'origin-a', text: 'new', admission: ADMISSION, source: fresh }).id; }, false],
    ['transcript, new session', (g) => privilegedRecordTranscript(g, { originId: 'origin-a', sessionId: 'session-2', project: 'p', activatedAt: NOW, trigger: null, transcript: null }), false],
    ['transition', (g) => privilegedTransitionCapture(g, { id: made.capture, to: 'processing', lease }), false],
    ['memory plan', (g) => g.applyMemoryPlan({ project: 'p', operations: [{ action: 'ADD', memoryType: 'note', key: 'plan-key', text: 'p' }] }), false],
    ['decision', (g) => { made.decision = g.addDecision({ project: 'p', title: 'n', chosen: 'n', reviewAfter: '2020-01-01T00:00:00.000Z' }).id; }, false],
    ['outcome', (g) => g.setOutcome(f.ids.kept, { status: 'successful' }, { project: 'p' }), false],
    ['evidence', (g) => g.addConfidenceEvidence({ project: 'p', decisionId: f.ids.kept, key: 'observed', reason: 'r' }), false],
    ['link', (g) => g.link({ project: 'p', from: made.decision, to: f.ids.kept, relation: 'informs' }), false],
    ['self event', (g) => privilegedRecordSelfEvent(g, { project: 'p', originId: 'origin-a', signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'session-2' } }), false],
    ['supersede', (g) => g.supersedeDecision({ project: 'p', decisionId: f.ids.kept, replacementId: made.decision, reason: 'r' }), false],
    ['attribute', (g) => g.attribute({ ids: [f.ids.other], targetProject: 'q2', reason: 'r' }), false],
    ['migrate attribution', (g) => g.migrateAttribution({}), false],
    ['backfill tokens', (g) => g.backfillErasureTokens({}), false],
    ['review', (g) => g.review({ project: 'p' }), true],
    ['acknowledge', (g) => { const signal = g.getReviewSignals({ project: 'p' }).items.find((item) => item.decisionId === made.decision); if (signal) g.acknowledgeReview(signal.id, { project: 'p' }); }, true],
    ['review context', (g) => g.reviewContext({ project: 'p', query: 'n' }), true],
    ['maintain', (g) => g.maintain({ project: 'p' }), true],
    ['purge q', (g) => g.purgeProject('q', { mode: 'hard' }), false]
  ];
  let touched = false;
  for (const [label, write, reachesW] of writes) {
    use('viewed'); write(viewed);
    use('plain'); write(plain);
    use('checks');
    touched ||= reachesW;
    const persisted = privilegedSnapshot(viewed);
    if (!touched) assert.deepEqual(persisted, privilegedSnapshot(plain), `transparency after ${label}`);
    assert.doesNotThrow(() => validateRestorePayload(persisted), `validity after ${label}`);
    assert.doesNotThrow(() => createShadowGraph({ now }).importData(persisted), `view-less import after ${label}`);
    assert.equal(privilegedLiveSnapshot(viewed).records.some((item) => item.id === f.ids.hidden), false, `still withheld after ${label}`);
  }
});

// PR-37c design §13.4: the registry tombstone (a token B lacks) proceeds with
// none; the marker proceeds and is lifted.
for (const surface of ['cli', 'http', 'mcp']) test(`T-17 ${surface}: a registry tombstone naming a token B lacks and a purge marker no longer refuse the restore, memory-only too`, async (t) => {
  for (const trigger of ['registry', 'marker']) for (const memoryOnly of [false, true]) {
    const f = fixture();
    const destination = await storeOf(t, 'json', f.payload);
    const source = await storeOf(t, 'json', fixture().payload);
    const home = join(destination.dir, 'home');
    await mkdir(home, { recursive: true });
    if (trigger === 'registry') await writeFile(registryFile({ SHADOWGRAPH_HOME: home }), JSON.stringify({ version: 1, tombstones: [tombstone({ tokens: ['anything'] })] }));
    else await rewrite(destination, (payload) => { const graph = createShadowGraph({ now }); graph.importData(payload); graph.purgeProject('q', { mode: 'logical' }); return privilegedSnapshot(graph); });
    const before = await content(destination);
    let text;
    if (surface === 'cli') {
      const env = { ...process.env, SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: destination.file, SHADOWGRAPH_STORAGE: 'json', SHADOWGRAPH_API_TOKEN: '' };
      try { text = (await execute(process.execPath, [cliPath, 'restore', source.file, ...(memoryOnly ? ['--memory-only'] : [])], { cwd: destination.dir, env })).stdout; }
      catch (error) { text = `${error.stderr}`; }
    } else if (surface === 'http') {
      const saved = process.env.SHADOWGRAPH_HOME;
      process.env.SHADOWGRAPH_HOME = home;
      try {
        const app = await createShadowGraphServer({ file: destination.file, storage: 'json', cwd: destination.dir, apiToken: '' });
        app.server.listen(0, '127.0.0.1'); await once(app.server, 'listening');
        try { text = await (await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, { method: 'POST', body: JSON.stringify({ source: source.file, memoryOnly }) })).text(); }
        finally { await new Promise((resolve) => app.server.close(resolve)); }
      } finally { process.env.SHADOWGRAPH_HOME = saved; }
    } else {
      [text] = await mcpCalls(t, destination, [['shadowgraph_restore', { source: source.file, memoryOnly }]], { SHADOWGRAPH_HOME: home });
    }
    const label = `${trigger} memoryOnly=${memoryOnly}: ${text.slice(0, 200)}`;
    assert.match(text, trigger === 'registry' ? /deletionKnowledge\\?"\s*:\s*\\?"none/ : /deletionKnowledge\\?"\s*:\s*\\?"present/, label);
    assert.notEqual(await content(destination), before, label);
    if (trigger === 'registry') assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')), { version: 1, generationBase: 1, generationCounters: [] }, label);
    else assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')).tombstones.map((item) => [item.purgedProject, item.tokens]), [['q', null]], label);
  }
});

test('T-16 (§9 item 12): the build before the floor serves what this build withholds', async (t) => {
  let tree;
  try { tree = execFileSync('git', ['ls-tree', '-r', '--name-only', '13d9714', 'src'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n'); } catch { tree = null; }
  if (!tree) { t.skip('the history does not hold 13d9714'); return; }
  const root = await scratchDirectory(t, 'shadowgraph-pr36-');
  for (const path of tree) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), execFileSync('git', ['show', `13d9714:${path}`]));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const earlier = await import(pathToFileURL(join(root, 'src', 'shadowgraph.js')).href);
  const earlierStorage = await import(pathToFileURL(join(root, 'src', 'storage.js')).href);
  const below = earlier.createShadowGraph({ now });
  below.importData(await earlierStorage.createJsonFileStore(state.file).load());
  assert.equal(JSON.stringify(below.exportData({ project: 'p' })).includes(`hidden ${SENTINEL}`), true, 'below the floor, withheld material is served (fail-open)');
  const here = await graphOf(state);
  assert.equal(JSON.stringify(here.exportData({ project: 'p' })).includes(`hidden ${SENTINEL}`), false, 'at the floor, it is withheld');
});

// ---------------------------------------------------------------------------
// The re-review round (briefs/PR37a-re-review-*.md) and the round-2 mutants.
// ---------------------------------------------------------------------------

for (const [backend, options] of BACKENDS) test(`C-2 ${backend}: a backup restored through its 8.3 name finds the sidecar beside its final name`, { ...WINDOWS, ...options }, async (t) => {
  const f = fixture();
  const destination = await storeOf(t, backend, f.payload);
  const source = await storeOf(t, backend, fixture().payload, { version: 1, quarantine: [{ token: f.tokens.memory }] });
  const short = shortName(source.file);
  if (!short) { t.skip('the volume keeps no 8.3 names'); return; }
  assert.equal((await stat(source.file)).nlink, 1, 'no other hard link');
  // PR-37c design §13.4: it proceeds, and merges the sidecar.
  const attempt = backend === 'json'
    ? restoreFile(short, destination.file)
    : (async () => { const store = await createStorage({ type: 'sqlite', file: destination.file }); try { return await store.restore(short); } finally { store.close(); } })();
  assert.equal((await attempt).deletionKnowledge, 'present');
  assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')).quarantine, [{ token: f.tokens.memory }]);
});

test('C-2: a destination reached through another hard link, with its ledger beside the other name, refuses', async (t) => {
  const f = fixture();
  const real = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const alias = join(real.dir, 'alias.json');
  await link(real.file, alias);
  const source = await storeOf(t, 'json', fixture().payload);
  const before = await fileHash(real.file);
  await assert.rejects(restoreFile(source.file, alias), { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  assert.equal(await fileHash(real.file), before);
});

test('re-review R2-1: two different ledgers beside one store\'s names refuse its load and its backup', { ...WINDOWS }, async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const short = shortName(state.file);
  if (!short) { t.skip('the volume keeps no 8.3 names'); return; }
  await writeFile(`${short}.control.json`, JSON.stringify(VIEWS.quarantine(f).ledger));
  await assert.rejects(load({ file: short, backend: 'json' }), { code: 'control_ledger_malformed' });
  await assert.rejects(backupFile(short, join(state.dir, 'copy.json'), {}), { code: 'control_ledger_malformed' });
  // One ledger reached by both names is one ledger: a store opened by another
  // spelling, whose ledger path is another spelling of the same file, loads.
  const other = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  for (const name of [shortName(other.file), namespaced(other.file)].filter(Boolean)) {
    assert.equal(privilegedLiveSnapshot(await graphOf({ file: name, backend: 'json' })).records.some((item) => item.id === f.ids.hidden), false, name);
  }
});

test('re-review R2-2: a memory\'s validFrom is checked against live versions only, and the store stays valid', async (t) => {
  const graph = createShadowGraph({ now });
  graph.remember({ project: 'p', memoryType: 'note', key: 'timed', text: 'v1', validFrom: '2026-01-01T00:00:00.000Z' });
  const second = graph.remember({ project: 'p', memoryType: 'note', key: 'timed', text: `v2 ${SENTINEL}`, validFrom: '2026-06-01T00:00:00.000Z' }).memory;
  graph.applyMemoryPlan({ project: 'p', operations: [{ action: 'DELETE', memoryType: 'note', key: 'timed', validAt: '2026-07-01T00:00:00.000Z' }] });
  const payload = privilegedSnapshot(graph);
  const token = payload.records.find((item) => item.id === second.id).erasureToken;
  const viewed = await graphOf(await storeOf(t, 'json', payload, { version: 1, tombstones: [tombstone({ tokens: [token] })] }));
  // Before the withheld version's validFrom, after the live one's: what a
  // store without the withheld version accepts.
  const written = viewed.remember({ project: 'p', memoryType: 'note', key: 'timed', text: 'v3', validFrom: '2026-03-01T00:00:00.000Z' }).memory;
  assert.equal(written.version, 3, 'the version still counts past the withheld one');
  assert.doesNotThrow(() => validateRestorePayload(privilegedSnapshot(viewed)));
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(privilegedSnapshot(viewed)));
});

test('re-review R2-4: a backup to a symbolic link replaces the link, never the file it points to', async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload);
  const dated = join(state.dir, 'dated.json');
  await writeFile(dated, 'an earlier backup');
  const latest = join(state.dir, 'latest.json');
  try { fsModule.symlinkSync(dated, latest); } catch (error) { t.skip(`symbolic links are not available here (${error.code})`); return; }
  await backupFile(state.file, latest, {});
  assert.equal(await readFile(dated, 'utf8'), 'an earlier backup');
  assert.equal(fsModule.lstatSync(latest).isSymbolicLink(), false);
  assert.ok((await readFile(latest, 'utf8')).includes('"records"'));
});

test('re-review contract R2-2: a registry whose folder is not there yet is refused under another spelling, and no folder is made', { ...WINDOWS }, async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload);
  const env = { SHADOWGRAPH_HOME: join(state.dir, 'not-yet', 'home') };
  await assert.rejects(backupFile(state.file, namespaced(registryFile(env)), { env }), { code: 'deletion_file_destination_refused' });
  assert.equal(existsSync(join(state.dir, 'not-yet')), false);
});

// ---------------------------------------------------------------------------
// The tests lens's round-2 probes (briefs/PR37a-re-review-tests.md), lifted.
// ---------------------------------------------------------------------------

test('R2-P1b: the registry and a ledger spelled as a UNC path are refused', { ...WINDOWS }, async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const env = { SHADOWGRAPH_HOME: join(state.dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const unc = (path) => `${BACK}${BACK}localhost${BACK}${path[0]}$${path.slice(2)}`;
  if (!existsSync(unc(state.file))) { t.skip('the administrative share is not reachable'); return; }
  for (const present of [false, true]) {
    if (present) await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [] }));
    const before = await fileHash(registryFile(env));
    await assert.rejects(backupFile(state.file, unc(registryFile(env)), { env }), { code: 'deletion_file_destination_refused' });
    assert.equal(await fileHash(registryFile(env)), before);
  }
  await assert.rejects(backupFile(state.file, unc(ledgerPath(state.file)), { env }), { code: 'deletion_file_destination_refused' });
});

for (const [backend, options] of BACKENDS) test(`R2-P2 ${backend}: a backup into a folder not there yet still carries its sidecar`, options, async (t) => {
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const store = await createStorage({ type: backend, file: state.file });
  t.after(() => store.close?.());
  const destination = join(state.dir, 'a', 'b', `copy.${backend === 'sqlite' ? 'db' : 'json'}`);
  await backupFile(state.file, destination, { store });
  assert.ok(existsSync(destination));
  assert.deepEqual(await readFile(ledgerPath(destination)), await readFile(ledgerPath(state.file)));
});

test('R2-P3: a SQLite restore through ./storage into a destination not there yet restores', { skip: sqlite.available ? false : sqlite.reason }, async (t) => {
  const source = await storeOf(t, 'sqlite', fixture().payload);
  const fresh = join(source.dir, 'fresh', 'restored.db');
  await mkdir(dirname(fresh), { recursive: true });
  const store = await createStorage({ type: 'sqlite', file: fresh });
  try { await store.restore(source.file); } finally { store.close(); }
  assert.ok((await load({ file: fresh, backend: 'sqlite' })).records.length);
});

// PR-37c design §13.4: it proceeds through the destination's one ledger. A spelling whose final component is the 8.3
// name of the store file itself refuses before any write (PR-37c review finding 1, design §3.1): the primitive would
// leave the file under that name, away from its ledger.
for (const [backend, options] of BACKENDS) test(`R2-P5 ${backend}: a restore into another spelling of a ledger-bearing destination proceeds through its one ledger, and through the 8.3 name of the store file itself refuses`, { ...WINDOWS, ...options }, async (t) => {
  const f = fixture();
  const destination = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const source = await storeOf(t, backend, fixture().payload);
  const ledger = await readFile(ledgerPath(destination.file));
  let generationBase = 0;
  // A case variant of the file's own name is the same name on win32 (re-review N-4): it proceeds.
  const caseVariant = join(dirname(destination.file), basename(destination.file).toUpperCase());
  for (const name of [namespaced(destination.file), caseVariant, shortName(destination.file)].filter(Boolean)) {
    const attempt = backend === 'json'
      ? restoreFile(source.file, name)
      : (async () => { const store = await createStorage({ type: 'sqlite', file: name }); try { return await store.restore(source.file); } finally { store.close(); } })();
    const fileAlias = basename(name).toLowerCase() !== basename(destination.file).toLowerCase();
    if (fileAlias) await assert.rejects(attempt, { code: PURGE_AWARE_RESTORE_UNSUPPORTED }, name);
    else { assert.equal((await attempt).deletionKnowledge, 'present', name); generationBase++; }
    assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file))), { ...JSON.parse(ledger), generationBase, generationCounters: [] }, `${name}: only successful replacement advances generation`);
    assert.deepEqual((await readdir(destination.dir)).filter((item) => item.toLowerCase().endsWith('.control.json')).map((item) => item.toLowerCase()), [`store.${backend === 'sqlite' ? 'db' : 'json'}.control.json`], name);
  }
});

for (const [backend, options] of BACKENDS) test(`R2-P6 ${backend}: a store loaded, or delivered, through its 8.3 name honours its ledger`, { ...WINDOWS, ...options }, async (t) => {
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const alias = shortName(state.file);
  if (!alias) { t.skip('the volume keeps no 8.3 names'); return; }
  assert.equal(privilegedLiveSnapshot(await graphOf({ ...state, file: alias })).records.some((item) => item.id === f.ids.hidden), false);
  const read = await readStoreForDelivery({ file: alias, storage: backend });
  const delivered = createShadowGraph({ now });
  delivered.importData(read.payload);
  assert.equal(JSON.stringify(delivered.exportData({ project: 'p' })).includes(SENTINEL), false);
});

test('R2-P7: through a directory junction the ledger is honoured, and the registry is refused as a destination', { ...WINDOWS }, async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const junction = `${state.dir}-j`;
  await symlink(state.dir, junction, 'junction');
  t.after(() => rm(junction, { force: true }));
  assert.equal(privilegedLiveSnapshot(await graphOf({ ...state, file: join(junction, 'store.json') })).records.some((item) => item.id === f.ids.hidden), false);
  const env = { SHADOWGRAPH_HOME: join(state.dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  await assert.rejects(backupFile(state.file, join(junction, 'home', 'deletion-registry.json'), { env }), { code: 'deletion_file_destination_refused' });
});

// PR-37c design §13.4: it proceeds, and merges the sidecar it found.
for (const [backend, options] of BACKENDS) test(`R2-P8 ${backend}: a source spelled another way, with no other hard link, has its sidecar found and merged`, { ...WINDOWS, ...options }, async (t) => {
  const f = fixture();
  const destination = await storeOf(t, backend, f.payload);
  const source = await storeOf(t, backend, fixture().payload, { version: 1, quarantine: [{ token: f.tokens.memory }] });
  for (const name of [namespaced(source.file), shortName(source.file)].filter(Boolean)) {
    const attempt = backend === 'json'
      ? restoreFile(name, destination.file)
      : (async () => { const store = await createStorage({ type: 'sqlite', file: destination.file }); try { return await store.restore(name); } finally { store.close(); } })();
    assert.equal((await attempt).deletionKnowledge, 'present', name);
    assert.deepEqual(JSON.parse(await readFile(ledgerPath(destination.file), 'utf8')).quarantine, [{ token: f.tokens.memory }], name);
  }
});

test('R2-P9: a ledger name not there yet, spelled in another case, is refused as a destination', async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload);
  const other = await storeOf(t, 'json', f.payload);
  await assert.rejects(backupFile(state.file, join(other.dir, 'STORE.JSON.CONTROL.JSON'), {}), { code: 'deletion_file_destination_refused' });
  assert.equal(existsSync(ledgerPath(other.file)), false);
});

test('R2-P10: a ledger beside a store\'s 8.3 spelling is honoured when the store is opened by that spelling', { ...WINDOWS }, async (t) => {
  const f = fixture();
  const state = await storeOf(t, 'json', f.payload);
  const alias = shortName(state.file);
  if (!alias) { t.skip('the volume keeps no 8.3 names'); return; }
  await writeFile(ledgerPath(alias), JSON.stringify(VIEWS.item(f).ledger));
  assert.equal(privilegedLiveSnapshot(await graphOf({ ...state, file: alias })).records.some((item) => item.id === f.ids.hidden), false);
});

test('R2-P11: a write whose beside-another-owner retry key W holds is refused, and the store stays loadable', async (t) => {
  // A legacy "default" decision holds retry key k; the real project "default" then writes with k, beside it.
  const first = createShadowGraph({ now });
  first.addDecision({ project: 'default', title: 'legacy', chosen: 'l', idempotencyKey: 'k' });
  const payload = privilegedSnapshot(first);
  payload.schemaVersion = 5;
  const strip = (entity) => { if (!entity || typeof entity !== 'object') return; delete entity.attribution; delete entity.originId; delete entity.erasureToken; delete entity.causalClaim; if (entity.schemaVersion >= 6) entity.schemaVersion = 5; };
  for (const entity of payload.records) strip(entity);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  for (const item of payload.idempotency) strip(item.value);
  const second = createShadowGraph({ now });
  second.importData(payload);
  const beside = second.addDecision({ project: 'default', title: `beside ${SENTINEL}`, chosen: 'b', idempotencyKey: 'k' });
  const stored = privilegedSnapshot(second);
  const token = stored.records.find((item) => item.id === beside.id).erasureToken;
  const viewed = await graphOf(await storeOf(t, 'json', stored, { version: 1, tombstones: [tombstone({ tokens: [token] })] }));
  assert.throws(() => viewed.addDecision({ project: 'default', title: 'again', chosen: 'a', idempotencyKey: 'k' }), { code: 'idempotency_key_withheld' });
  assert.doesNotThrow(() => createShadowGraph({ now }).importData(privilegedSnapshot(viewed)));
});

for (const [backend, options] of BACKENDS) test(`R2-P12 ${backend}: a restore into another hard link of a ledger-bearing destination refuses`, options, async (t) => {
  const f = fixture();
  const destination = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const source = await storeOf(t, backend, fixture().payload);
  const linked = join(destination.dir, `latest.${backend === 'sqlite' ? 'db' : 'json'}`);
  await link(destination.file, linked);
  const before = await content(destination);
  const attempt = backend === 'json'
    ? restoreFile(source.file, linked)
    : (async () => { const store = await createStorage({ type: 'sqlite', file: linked }); try { return await store.restore(source.file); } finally { store.close(); } })();
  await assert.rejects(attempt, { code: PURGE_AWARE_RESTORE_UNSUPPORTED });
  assert.equal(await content(destination), before);
});

for (const [backend, options] of BACKENDS) test(`R2-T5 ${backend}: a source whose restore.reapplied entry is malformed is refused at restore, and nothing lands`, options, async (t) => {
  const payload = structuredClone(fixture().payload);
  const seq = ++payload.journalSeq;
  payload.journal.push({ id: `reapplied-${seq}`, seq, type: 'restore.reapplied', at: NOW, project: null, entityKind: null, entityId: null, schemaVersion: 7, payload: { mode: 'logical', removedJournalSequences: [], removed: -1, skeletons: 0 }, provenance: NULL_PROVENANCE });
  const dir = await scratchDirectory(t, 'deletion-knowledge-');
  const extension = backend === 'sqlite' ? 'db' : 'json';
  const source = join(dir, `source.${extension}`);
  if (backend === 'json') await writeFile(source, JSON.stringify(payload));
  else { const store = await createStorage({ type: 'sqlite', file: source }); try { await store.save(payload); } finally { store.close(); } }
  const destination = join(dir, `restored.${extension}`);
  const attempt = backend === 'json'
    ? restoreFile(source, destination)
    : (async () => { const store = await createStorage({ type: 'sqlite', file: destination }); try { return await store.restore(source); } finally { store.close(); } })();
  await assert.rejects(attempt, /restore.reapplied removed must be a non-negative safe integer/);
  if (backend === 'json') assert.equal(existsSync(destination), false);
  else assert.equal((await load({ file: destination, backend })).records.length, 0);
});

// PR-37c design §13.4: it proceeds, and says knowledge reached it.
test('R2-T6: a readable destination that deletion records reach is restored, never sent to a fresh path', async (t) => {
  const f = fixture();
  const destination = await storeOf(t, 'json', f.payload, VIEWS.item(f).ledger);
  const source = await storeOf(t, 'json', fixture().payload);
  assert.equal((await restoreFile(source.file, destination.file)).deletionKnowledge, 'present');
});

test('R2-T3: whether this volume keeps the 8.3 names the 8.3 cases need', { ...WINDOWS }, (t) => {
  if (!shortName(fileURLToPath(import.meta.url))) t.diagnostic('this volume keeps no 8.3 names: the 8.3 spellings are not exercised here');
});

for (const [backend, options] of BACKENDS) test(`R2-T3 ${backend}: a hard link to the registry is refused as a destination, on every platform`, options, async (t) => {
  const f = fixture();
  const state = await storeOf(t, backend, f.payload, VIEWS.item(f).ledger);
  const env = { SHADOWGRAPH_HOME: join(state.dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [tombstone({ tokens: ['kept'] })] }));
  const linked = join(state.dir, 'registry-link.json');
  await link(registryFile(env), linked);
  const before = await fileHash(registryFile(env));
  const store = await createStorage({ type: backend, file: state.file, env });
  t.after(() => store.close?.());
  await assert.rejects(backupFile(state.file, linked, { store, env }), { code: 'deletion_file_destination_refused' });
  if (backend === 'sqlite') await assert.rejects(store.backup(linked), { code: 'deletion_file_destination_refused' });
  assert.equal(await fileHash(registryFile(env)), before);
  // Not there yet, and named in another case: still the registry's name in its folder.
  fsModule.rmSync(linked);
  fsModule.rmSync(registryFile(env));
  const upper = join(env.SHADOWGRAPH_HOME, 'DELETION-REGISTRY.JSON');
  await assert.rejects(backupFile(state.file, upper, { store, env }), { code: 'deletion_file_destination_refused' });
  assert.equal(existsSync(upper), false);
});
