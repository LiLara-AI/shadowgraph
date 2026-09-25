import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { restoreFile } from '../src/backup.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { createShadowGraphServer } from '../src/server.js';
import { syncMarkdownWorkspace } from '../src/markdown-workspace.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { historicalRelation } from '../tools/historical-relation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// PR-10 (plan v1.4.4 §10.5, §11; P1 reconciliation F-01, F-04, F-08, F-09,
// F-16, F-17, F-21, F-25): the last public reads take the request's scope.
// getJournal, stats, redact's output, the public export, review signals,
// memory history and the public forms of validate, repairPlan and rebuild each
// answer inside the boundary of the request -- a selected project, or one
// origin -- and a read with neither sees nothing. No answer names an id from
// outside it: another project, the real project "default", legacy data or
// another origin. Relations stored across a boundary are kept and left out of
// every view. The privileged snapshot, and the store-wide integrity checks
// persistence and restore depend on, stay whole. Every fixture is synthetic.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const PAST = '2025-01-01T00:00:00.000Z';

// What a store written before schema 6 holds: a decision and a memory in the
// literal "default", and a decision stored with no project at all.
function legacyPayload() {
  const writer = createShadowGraph({ now });
  writer.addDecision({ project: 'default', id: 'legacy-dflt-decision', title: 'Legacy decision', chosen: 'x' });
  writer.remember({ project: 'default', id: 'legacy-dflt-memory', memoryType: 'note', key: 'note', text: 'Legacy note' });
  writer.addDecision({ project: 'default', id: 'legacy-projectless-decision', title: 'Projectless decision', chosen: 'x' });
  const payload = privilegedSnapshot(writer);
  payload.schemaVersion = 5;
  const strip = (entity) => {
    if (!entity || typeof entity !== 'object') return;
    delete entity.attribution;
    delete entity.originId;
    if (entity.schemaVersion === 6) entity.schemaVersion = 5;
  };
  for (const entity of payload.records) strip(entity);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  delete payload.records.find((entity) => entity.id === 'legacy-projectless-decision').project;
  const entry = payload.journal.find((item) => item.entityId === 'legacy-projectless-decision');
  delete entry.payload.project;
  entry.project = null;
  for (const event of payload.events) if (event.recordId === 'legacy-projectless-decision') delete event.project;
  return payload;
}

const importHistoricalRelation = (graph, relation) => graph.importData(historicalRelation({ ...relation, seq: privilegedSnapshot(graph).journalSeq + 1, at: NOW }));

// Every id a scope owns. No id is a substring of another.
const OWNED = {
  alpha: ['alpha-decision', 'alpha-alternative', 'alpha-attempt', 'alpha-memory', 'alpha-fact', 'alpha-due-decision', 'relation-alpha-tried'],
  beta: ['beta-decision', 'beta-attempt', 'beta-memory', 'beta-fact', 'beta-due-decision', 'relation-beta-tried'],
  default: ['real-dflt-decision', 'real-dflt-memory'],
  legacy: ['legacy-dflt-decision', 'legacy-dflt-memory', 'legacy-projectless-decision'],
  originA: ['origin-a-decision', 'origin-a-attempt', 'origin-a-memory', 'relation-origin-a-tried'],
  originB: ['origin-b-decision']
};
// Relations stored across a boundary: no scope owns them.
const CROSSING = ['relation-alpha-beta', 'relation-beta-alpha', 'relation-alpha-dflt', 'relation-alpha-legacy', 'relation-alpha-origin', 'relation-origin-a-b'];
const EVERY_ID = [...Object.values(OWNED).flat(), ...CROSSING];
const SCOPES = {
  unresolved: {},
  alpha: { project: 'alpha' },
  beta: { project: 'beta' },
  default: { project: 'default' },
  originA: { originId: 'origin_a' },
  originB: { originId: 'origin_b' }
};

// PR-11: coverage describes the resolved request independently of whether a
// finite local page happened to contain every known candidate.
const COVERAGE_READS = {
  search: (g, s) => g.search('', s),
  retrieve: (g, s) => g.retrieve('', s),
  recall: (g, s) => g.recall('', s),
  context: (g, s) => g.context(s),
  memoryHistory: (g, s) => g.memoryHistory({ ...s, memoryType: 'note', key: 'note' }),
  traverse: (g, s) => g.traverse({ ...s, id: 'alpha-decision' }),
  review: (g, s) => g.review(s),
  getReviewSignals: (g, s) => g.getReviewSignals(s),
  reconsider: (g, s) => g.reconsider(s),
  maintain: (g, s) => g.maintain(s),
  exportData: (g, s) => g.exportData(s),
  redact: (g, s) => g.redact(s),
  getJournal: (g, s) => g.getJournal(s),
  stats: (g, s) => g.stats(s),
  validate: (g, s) => g.validate(s),
  repairPlan: (g, s) => g.repairPlan(s),
  rebuild: (g, s) => g.rebuild(s)
};

for (const [path, read] of Object.entries(COVERAGE_READS)) {
  for (const [name, scope] of Object.entries(SCOPES)) {
    test(`PR-11 ${path}: serialized ${name} request coverage and boundary`, () => {
      const result = JSON.parse(JSON.stringify(read(fixture(), { ...scope, grant: { project: 'beta', all: true } })));
      assert.deepEqual(result.completeness?.scope && {
        project: result.completeness.scope.project,
        requestState: result.completeness.scope.requestState,
        originPresented: result.completeness.scope.originPresented,
        grant: result.completeness.scope.grant
      }, { project: path === 'redact' ? null : scope.project ?? null, requestState: scope.project ? 'project_selected' : 'project_unresolved', originPresented: !!scope.originId, grant: null });
      if (path === 'redact') assert.equal(result.completeness.scope.projectLabelWithheld, !!scope.project);
      if (!scope.project) {
        assert.equal(result.completeness.complete, false);
        assert.equal(result.completeness.limitation?.code, 'scoped_coverage');
      }
      // traverse echoes its caller-supplied root even when it cannot resolve it.
      const { root, ...answer } = result;
      assert.deepEqual(foreignIds(answer, name), []);
    });
  }
}

// The ids from outside `scope` that `output` names.
function foreignIds(output, scope) {
  const text = JSON.stringify(output);
  const own = new Set(OWNED[scope] ?? []);
  return EVERY_ID.filter((id) => !own.has(id) && text.includes(`"${id}"`));
}

function fixture() {
  const graph = createShadowGraph({ now });
  graph.importData(legacyPayload());
  graph.addDecision({ project: 'alpha', id: 'alpha-decision', title: 'Alpha cache', chosen: 'redis', alternatives: [{ id: 'alpha-alternative', label: 'memcached', reasonRejected: 'slower' }] });
  graph.addAttempt({ project: 'alpha', id: 'alpha-attempt', solution: 'alpha warm-up', result: 'worked' });
  graph.remember({ project: 'alpha', id: 'alpha-memory', memoryType: 'note', key: 'note', text: 'Alpha note, header Bearer alpha-secret-token' });
  graph.addFact({ project: 'alpha', id: 'alpha-fact', key: 'latency', value: 10 });
  graph.addDecision({ project: 'alpha', id: 'alpha-due-decision', title: 'Alpha due', chosen: 'x', reviewAfter: PAST });
  graph.link({ project: 'alpha', id: 'relation-alpha-tried', from: 'alpha-decision', to: 'alpha-attempt', relation: 'tried' });
  graph.addDecision({ project: 'beta', id: 'beta-decision', title: 'Beta cache', chosen: 'memcached' });
  graph.addAttempt({ project: 'beta', id: 'beta-attempt', solution: 'beta warm-up', result: 'worked' });
  graph.remember({ project: 'beta', id: 'beta-memory', memoryType: 'note', key: 'note', text: 'Beta note' });
  graph.addFact({ project: 'beta', id: 'beta-fact', key: 'latency', value: 99 });
  graph.addDecision({ project: 'beta', id: 'beta-due-decision', title: 'Beta due', chosen: 'x', reviewAfter: PAST });
  graph.link({ project: 'beta', id: 'relation-beta-tried', from: 'beta-decision', to: 'beta-attempt', relation: 'tried' });
  graph.addDecision({ project: 'default', id: 'real-dflt-decision', title: 'Real default decision', chosen: 'x' });
  graph.remember({ project: 'default', id: 'real-dflt-memory', memoryType: 'note', key: 'note', text: 'Real default note' });
  graph.addDecision({ originId: 'origin_a', id: 'origin-a-decision', title: 'Origin a decision', chosen: 'x' });
  graph.addAttempt({ originId: 'origin_a', id: 'origin-a-attempt', solution: 'origin a script', result: 'worked' });
  graph.remember({ originId: 'origin_a', id: 'origin-a-memory', memoryType: 'note', key: 'note', text: 'Origin a note' });
  graph.link({ originId: 'origin_a', id: 'relation-origin-a-tried', from: 'origin-a-decision', to: 'origin-a-attempt', relation: 'tried' });
  graph.addDecision({ originId: 'origin_b', id: 'origin-b-decision', title: 'Origin b decision', chosen: 'x' });
  importHistoricalRelation(graph, { id: 'relation-alpha-beta', from: 'alpha-decision', to: 'beta-attempt', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-beta-alpha', from: 'beta-decision', to: 'alpha-attempt', relation: 'related', project: 'beta' });
  importHistoricalRelation(graph, { id: 'relation-alpha-dflt', from: 'alpha-decision', to: 'real-dflt-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-alpha-legacy', from: 'alpha-decision', to: 'legacy-dflt-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-alpha-origin', from: 'alpha-decision', to: 'origin-a-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-origin-a-b', from: 'origin-a-attempt', to: 'origin-b-decision', relation: 'related', project: null });
  graph.review({ project: 'alpha' }).items;
  graph.review({ project: 'beta' }).items;
  return graph;
}

test('the fixture ids cannot mask one another', () => {
  for (const id of EVERY_ID) assert.deepEqual(EVERY_ID.filter((other) => other !== id && other.includes(id)), [], id);
  const snapshot = privilegedSnapshot(fixture());
  for (const id of EVERY_ID) assert.ok(JSON.stringify(snapshot).includes(`"${id}"`), `the store holds ${id}`);
  assert.equal(snapshot.reviewSignals.length, 2);
});

test('getJournal answers inside the scope and names nothing outside it', () => {
  const graph = fixture();
  for (const [name, scope] of Object.entries(SCOPES)) {
    const result = graph.getJournal({ ...scope, limit: 1000 });
    assert.deepEqual(foreignIds(result, name), [], name);
    for (const id of OWNED[name] ?? []) {
      if (id.includes('alternative')) continue;
      assert.ok(result.items.some((entry) => entry.entityId === id), `${name} sees its own entry for ${id}`);
    }
  }
  assert.deepEqual(graph.getJournal({ limit: 1000 }).items, []);
  // The real project "default" and legacy data never share a view.
  assert.ok(graph.getJournal({ project: 'default', limit: 1000 }).items.every((entry) => entry.payload?.attribution === 'project'));
  // Historical relations across a boundary are kept, and no view shows them.
  const stored = privilegedSnapshot(graph);
  for (const id of CROSSING) {
    assert.ok(stored.relations.some((relation) => relation.id === id), `${id} is still stored`);
    assert.ok(stored.journal.some((entry) => entry.entityId === id), `${id} is still journalled`);
  }
});

test('a scoped journal read positions only the gaps its own hard purges explain', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', id: 'a1', title: 'A', chosen: 'x' });
  graph.addDecision({ project: 'beta', id: 'b1', title: 'B', chosen: 'x' });
  graph.addDecision({ project: 'gamma', id: 'g1', title: 'G', chosen: 'x' });
  graph.addDecision({ project: 'alpha', id: 'a2', title: 'A2', chosen: 'x' });
  graph.purgeProject('beta', { mode: 'hard' });
  const alpha = graph.getJournal({ project: 'alpha', limit: 1000 });
  assert.deepEqual(alpha.completeness.gaps, [], 'a gap beta left is not positioned for alpha');
  assert.equal(alpha.completeness.limitation?.code, 'scoped_coverage');
  graph.purgeProject('gamma', { mode: 'hard' });
  const gamma = graph.getJournal({ project: 'gamma', limit: 1000 });
  assert.deepEqual(gamma.completeness.gaps, [{ from: 3, to: 3 }], 'gamma sees the gap its own purge left');
  assert.deepEqual(graph.getJournal({ project: 'alpha', limit: 1000 }).completeness.gaps, []);
  assert.deepEqual(graph.getJournal({ limit: 1000 }).completeness.gaps, []);
  // The store-wide gaps are still there for the privileged integrity path.
  const seqs = privilegedSnapshot(graph).journal.map((entry) => entry.seq);
  assert.ok(!seqs.includes(2) && !seqs.includes(3));
});

test('stats counts only what the scope owns', () => {
  const graph = fixture();
  const zero = { total: 0, decisions: 0, attempts: 0, facts: 0, relations: 0, reviewSignals: 0, events: 0, journal: 0 };
  const { schemaVersion, completeness, ...unresolved } = graph.stats();
  assert.equal(schemaVersion, 6);
  assert.deepEqual(unresolved, zero);
  const counts = (scope) => { const { schemaVersion: version, completeness, ...rest } = graph.stats(scope); return rest; };
  const journalOf = (scope) => graph.getJournal({ ...scope, limit: 1000 }).page.total;
  assert.deepEqual(counts({ project: 'alpha' }), { total: 4, decisions: 2, attempts: 1, facts: 1, relations: 1, reviewSignals: 1, events: 6, journal: journalOf({ project: 'alpha' }) });
  assert.deepEqual(counts({ project: 'beta' }), { total: 4, decisions: 2, attempts: 1, facts: 1, relations: 1, reviewSignals: 1, events: 6, journal: journalOf({ project: 'beta' }) });
  assert.deepEqual(counts({ project: 'default' }), { total: 2, decisions: 1, attempts: 0, facts: 0, relations: 0, reviewSignals: 0, events: 2, journal: journalOf({ project: 'default' }) });
  assert.deepEqual(counts({ originId: 'origin_a' }), { total: 3, decisions: 1, attempts: 1, facts: 0, relations: 1, reviewSignals: 0, events: 4, journal: journalOf({ originId: 'origin_a' }) });
  assert.deepEqual(counts({ originId: 'origin_b' }), { total: 1, decisions: 1, attempts: 0, facts: 0, relations: 0, reviewSignals: 0, events: 1, journal: journalOf({ originId: 'origin_b' }) });
});

test('redact returns only the scope, still redacted, and names nothing outside it', () => {
  const graph = fixture();
  const unresolved = graph.redact({});
  for (const collection of ['records', 'facts', 'relations', 'reviewSignals', 'idempotency', 'events', 'journal']) assert.deepEqual(unresolved[collection], [], collection);
  for (const [name, scope] of Object.entries(SCOPES)) assert.deepEqual(foreignIds(graph.redact(scope), name), [], name);
  const alpha = graph.redact({ project: 'alpha' });
  assert.deepEqual(alpha.records.map((record) => record.id).sort(), ['alpha-attempt', 'alpha-decision', 'alpha-due-decision', 'alpha-memory']);
  assert.deepEqual(alpha.relations.map((relation) => relation.id), ['relation-alpha-tried']);
  assert.ok(alpha.journal.length > 0);
  assert.doesNotMatch(JSON.stringify(alpha), /alpha-secret-token/, 'the journal copy is redacted too');
  assert.deepEqual(graph.redact({ project: 'default' }).records.map((record) => record.id).sort(), ['real-dflt-decision', 'real-dflt-memory']);
});

test('the public export is scoped and carries none of the store internals', () => {
  const graph = fixture();
  for (const [name, scope] of Object.entries(SCOPES)) {
    const exported = graph.exportData(scope);
    assert.equal(exported.exportKind, 'public_scoped', name);
    for (const key of ['journal', 'idempotency', 'journalSeq', 'journalEpoch', 'revision', 'access', 'accessRevocations', 'storedWithoutProject']) {
      assert.equal(Object.hasOwn(exported, key), false, `${name} export carries no ${key}`);
    }
    assert.equal(exported.completeness.limitation.code, 'scoped_coverage', name);
    assert.deepEqual(foreignIds(exported, name), [], name);
  }
  assert.deepEqual(graph.exportData().records, []);
  assert.deepEqual(graph.exportData({ project: 'alpha' }).records.map((record) => record.id).sort(), ['alpha-attempt', 'alpha-decision', 'alpha-due-decision', 'alpha-memory']);
  assert.deepEqual(graph.exportData({ project: 'default' }).records.map((record) => record.id).sort(), ['real-dflt-decision', 'real-dflt-memory']);
  assert.deepEqual(graph.exportData({ originId: 'origin_a' }).relations.map((relation) => relation.id), ['relation-origin-a-tried']);
});

test('a public export is never accepted as a store', async (t) => {
  const graph = fixture();
  const exported = graph.exportData({ project: 'alpha' });
  const before = JSON.stringify(privilegedSnapshot(graph));
  assert.throws(() => createShadowGraph({ now }).importData(exported), { code: 'public_export_not_a_store' });
  assert.throws(() => graph.replaceData(exported), { code: 'public_export_not_a_store' });
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, 'a refused replace changes nothing');
  assert.throws(() => validateRestorePayload(exported), { code: 'public_export_not_a_store' });
  const directory = await scratchDirectory(t, 'shadowgraph-public-export-');
  for (const type of ['json', 'sqlite']) {
    const file = join(directory, `data.${type === 'json' ? 'json' : 'db'}`);
    const store = await createStorage({ type, file });
    try {
      await store.save(privilegedSnapshot(graph));
      const saved = JSON.stringify(await store.load());
      await assert.rejects(store.save(exported), { code: 'public_export_not_a_store' }, type);
      assert.equal(JSON.stringify(await store.load()), saved, `${type}: the store is unchanged`);
    } finally { store.close?.(); }
  }
  const source = join(directory, 'public-export.json');
  await writeFile(source, JSON.stringify(exported));
  const destination = join(directory, 'restored.json');
  await assert.rejects(restoreFile(source, destination, {}), /public_export_not_a_store/);
  await assert.rejects(readFile(destination, 'utf8'), { code: 'ENOENT' });
});

test('persistence saves and reloads every project while the public export is scoped (JSON and SQLite)', async (t) => {
  const graph = fixture();
  const directory = await scratchDirectory(t, 'shadowgraph-public-persist-');
  for (const type of ['json', 'sqlite']) {
    const store = await createStorage({ type, file: join(directory, `persist.${type === 'json' ? 'json' : 'db'}`) });
    try {
      await store.save(privilegedSnapshot(graph));
      const reloaded = createShadowGraph({ now });
      reloaded.importData(await store.load());
      const stored = privilegedSnapshot(reloaded);
      for (const id of EVERY_ID) assert.ok(JSON.stringify(stored).includes(`"${id}"`), `${type} keeps ${id}`);
      for (const scope of Object.values(SCOPES)) assert.deepEqual(reloaded.exportData(scope), graph.exportData(scope), `${type} ${JSON.stringify(scope)}`);
      assert.deepEqual(reloaded.exportData({ project: 'alpha' }).records.map((record) => record.id).sort(), ['alpha-attempt', 'alpha-decision', 'alpha-due-decision', 'alpha-memory']);
    } finally { store.close?.(); }
  }
});

test('review signals are read inside the scope', () => {
  const graph = fixture();
  assert.deepEqual(graph.getReviewSignals({}).items, []);
  assert.deepEqual(graph.getReviewSignals({ project: 'alpha' }).items.map((signal) => signal.decisionId), ['alpha-due-decision']);
  assert.deepEqual(graph.getReviewSignals({ project: 'beta', status: 'open' }).items.map((signal) => signal.decisionId), ['beta-due-decision']);
  assert.deepEqual(graph.getReviewSignals({ project: 'default' }).items, []);
  assert.deepEqual(graph.getReviewSignals({ originId: 'origin_a' }).items, []);
});

test('memory history is read inside the scope', () => {
  const graph = fixture();
  const history = (scope) => graph.memoryHistory({ ...scope, memoryType: 'note', key: 'note' }).items.map((memory) => memory.id);
  assert.deepEqual(history({}), [], 'no project is not the legacy "default" bucket');
  assert.deepEqual(history({ project: 'default' }), ['real-dflt-memory']);
  assert.deepEqual(history({ project: 'alpha' }), ['alpha-memory']);
  assert.deepEqual(history({ originId: 'origin_a' }), ['origin-a-memory']);
});

// A store with an integrity error in beta only: a beta decision whose stored
// status no build writes.
function withBetaIntegrityError() {
  const payload = privilegedSnapshot(fixture());
  payload.records.push({ id: 'beta-broken-decision', kind: 'decision', schemaVersion: 6, project: 'beta', attribution: 'project', title: 'Broken', chosen: 'x', status: 'weird', alternatives: [], confidence: { current: 0.5 } });
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  return graph;
}

test('validate and repairPlan list only the scope\'s issues; the whole-store verdict names nothing', () => {
  const graph = withBetaIntegrityError();
  const unresolved = graph.validate();
  assert.equal(unresolved.valid, false, 'the verdict still covers the whole store');
  assert.deepEqual(unresolved.issues, []);
  assert.equal(unresolved.limitation?.code, 'scoped_coverage');
  const alpha = graph.validate({ project: 'alpha' });
  assert.equal(alpha.valid, false);
  assert.deepEqual(alpha.issues, []);
  assert.deepEqual(foreignIds(alpha, 'alpha'), []);
  assert.doesNotMatch(JSON.stringify(alpha), /beta-broken-decision/);
  const beta = graph.validate({ project: 'beta' });
  assert.deepEqual(beta.issues.map((issue) => [issue.code, issue.recordId]), [['unknown_decision_status', 'beta-broken-decision'], ['legacy_confidence_without_basis', 'beta-broken-decision']]);
  assert.deepEqual(beta.counts, { error: 1, legacy: 1, unsupported: 0, info: 0 });
  assert.deepEqual(foreignIds(beta, 'beta'), []);
  assert.deepEqual(graph.repairPlan().actions, []);
  assert.deepEqual(graph.repairPlan({ project: 'alpha' }).actions, []);
  assert.deepEqual(graph.repairPlan({ project: 'beta' }).actions.map((action) => action.recordId), ['beta-broken-decision', 'beta-broken-decision']);
});

test('the privileged integrity path still checks the whole store', () => {
  const graph = withBetaIntegrityError();
  const stored = privilegedSnapshot(graph);
  assert.throws(() => createShadowGraph({ now }).replaceData(stored), /unknown_decision_status/);
  assert.throws(() => validateRestorePayload(stored), /unknown_decision_status|blocking/);
});

test('rebuild returns the projection of the scope only', () => {
  const graph = fixture();
  const unresolved = graph.rebuild();
  assert.equal(unresolved.rebuildable, true);
  for (const collection of ['records', 'facts', 'relations', 'idempotency']) assert.deepEqual(unresolved.projection[collection], [], collection);
  for (const [name, scope] of Object.entries(SCOPES)) assert.deepEqual(foreignIds(graph.rebuild(scope), name), [], name);
  const alpha = graph.rebuild({ project: 'alpha' });
  assert.deepEqual(alpha.projection.records.map((record) => record.id).sort(), ['alpha-attempt', 'alpha-decision', 'alpha-due-decision', 'alpha-memory']);
  assert.deepEqual(alpha.projection.relations.map((relation) => relation.id), ['relation-alpha-tried']);
});

async function runCli(env, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env: { ...process.env, ...env } });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
}

test('GET /records and the list verb serve the scoped public export', async (t) => {
  const graph = fixture();
  const directory = await scratchDirectory(t, 'shadowgraph-public-transport-');
  const file = join(directory, 'data.json');
  const store = await createStorage({ type: 'json', file });
  await store.save(privilegedSnapshot(graph));
  const app = await createShadowGraphServer({ file });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const unresolved = await (await fetch(`${base}/records`)).json();
  assert.equal(unresolved.exportKind, 'public_scoped');
  assert.deepEqual(unresolved.records, []);
  const alpha = await (await fetch(`${base}/records?project=alpha`)).json();
  assert.deepEqual(alpha, graph.exportData({ project: 'alpha' }));
  const listed = await runCli({ SHADOWGRAPH_FILE: file }, ['list', JSON.stringify({ project: 'beta' })]);
  assert.deepEqual(listed, graph.exportData({ project: 'beta' }));
  assert.deepEqual((await runCli({ SHADOWGRAPH_FILE: file }, ['list'])).records, []);
});

test('markdown push writes only a named project\'s own memories and never collides legacy with the real "default"', async (t) => {
  const graph = fixture();
  const directory = await scratchDirectory(t, 'shadowgraph-markdown-scope-');
  const files = async (path) => { try { return (await readdir(path, { recursive: true })).filter((name) => name.endsWith('.md') || name.endsWith('.json')); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

  const refused = await syncMarkdownWorkspace({ graph, directory: join(directory, 'none'), mode: 'push' });
  assert.equal(refused.limitation?.code, 'scoped_coverage');
  assert.equal(refused.written, 0);
  assert.deepEqual(await files(join(directory, 'none')), [], 'an unresolved push writes no file, not even its state');
  const originPush = await syncMarkdownWorkspace({ graph, directory: join(directory, 'origin'), mode: 'push', originId: 'origin_a' });
  assert.equal(originPush.limitation?.code, 'scoped_coverage', 'an origin owns no project to write its memories under');
  assert.deepEqual(await files(join(directory, 'origin')), []);

  const alpha = await syncMarkdownWorkspace({ graph, directory: join(directory, 'alpha'), mode: 'push', project: 'alpha' });
  assert.deepEqual(alpha.files.map((item) => item.memoryId), ['alpha-memory']);

  const defaults = join(directory, 'default');
  const real = await syncMarkdownWorkspace({ graph, directory: defaults, mode: 'push', project: 'default' });
  assert.deepEqual(real.files.map((item) => item.memoryId), ['real-dflt-memory'], 'legacy "default" memory is never pushed as the real project');
  const written = await readFile(real.files[0].path, 'utf8');
  assert.match(written, /Real default note/);
  // Pull the real project's file back after an edit: it updates the real
  // project, and the legacy memory with the same identity is untouched.
  await writeFile(real.files[0].path, written.replace('Real default note', 'Edited real default note'));
  const legacyBefore = JSON.stringify(privilegedSnapshot(graph).records.find((record) => record.id === 'legacy-dflt-memory'));
  const pulled = await syncMarkdownWorkspace({ graph, directory: defaults, mode: 'pull', project: 'default' });
  assert.deepEqual(pulled.conflicts, []);
  assert.equal(pulled.results[0].previous.id, 'real-dflt-memory');
  assert.equal(JSON.stringify(privilegedSnapshot(graph).records.find((record) => record.id === 'legacy-dflt-memory')), legacyBefore);
});
