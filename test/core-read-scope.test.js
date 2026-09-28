import { historicalIds } from '../tools/historical-ids.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { historicalRelation } from '../tools/historical-relation.js';

// Labels below refer to IDs returned by ordinary creation, never supplied IDs.
const fixtureIds = {};

// PR-08 (plan v1.4.4 §10.2, §10.5; owner decisions OD-1, OD-3): the five core
// read paths -- the project predicate behind search, search itself, retrieve,
// recall and context -- read only inside the boundary the call resolves to.
// A selected project sees what that project owns, and a graph expansion made
// by these paths stays inside the same boundary. A call that selects no
// project never widens to every project and never falls back to the shared
// "default" bucket. Legacy data in "default", or stored with no project,
// belongs to no project a caller can name. The completeness envelope of an
// unresolved read is PR-11's and is not asserted here.

const NOW = '2026-01-01T00:00:00.000Z';
const PAST = '2025-06-01T00:00:00.000Z';
const now = () => NOW;

// A schema-5 store: a decision and a memory in the literal legacy "default",
// a decision stored with no project, and a decision of the explicit legacy
// project alpha, which keeps its project (WS-11 mapping i).
function legacyPayload() {
  const historical = {};
  const writer = createShadowGraph({ now });
  historical['legacy-default-decision'] = writer.addDecision({ project: 'default', title: 'Legacy MARKER cache', chosen: 'x' }).id;
  historical['legacy-default-memory'] = writer.remember({ project: 'default', memoryType: 'note', key: 'legacy', text: 'MEMORY-MARKER legacy default' }).memory.id;
  historical['legacy-projectless-decision'] = writer.addDecision({ project: 'default', title: 'Projectless MARKER cache', chosen: 'x' }).id;
  historical['legacy-alpha-decision'] = writer.addDecision({ project: 'alpha', title: 'Legacy alpha MARKER cache', chosen: 'x' }).id;
  const payload = historicalIds(privilegedSnapshot(writer), historical, { now });
  payload.schemaVersion = 5;
  const strip = (entity) => {
    if (!entity || typeof entity !== 'object') return;
    delete entity.attribution;
    delete entity.originId;
    if (entity.schemaVersion === 6) entity.schemaVersion = 5;
  };
  for (const entity of [...payload.records, ...payload.facts]) strip(entity);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  delete payload.records.find((entity) => entity.id === 'legacy-projectless-decision').project;
  const entry = payload.journal.find((item) => item.entityId === 'legacy-projectless-decision');
  delete entry.payload.project;
  entry.project = null;
  return payload;
}

// A relation across projects, as a store written before PR-09 holds it;
// link() refuses to create one now (P1 reconciliation F-16).
const importHistoricalRelation = (graph, relation) => graph.importData(historicalRelation({ ...relation, seq: privilegedSnapshot(graph).journalSeq + 1, at: NOW }));

function fixture() {
  const graph = createShadowGraph({ now });
  graph.importData(legacyPayload());
  for (const project of ['alpha', 'beta']) {
    fixtureIds[`${project}-decision`] = graph.addDecision({ project, title: `${project} MARKER cache`, chosen: 'redis' }).id;
    fixtureIds[`${project}-overdue`] = graph.addDecision({ project, title: `${project} overdue MARKER review`, chosen: 'later', reviewAfter: PAST }).id;
    fixtureIds[`${project}-attempt`] = graph.addAttempt({ project, solution: `${project} warm-up script`, result: 'failed', resultClass: 'failed' }).id;
    fixtureIds[`${project}-memory`] = graph.remember({ project, memoryType: 'note', key: 'note', text: `MEMORY-MARKER ${project}` }).memory.id;
    fixtureIds[`${project}-fact-old`] = graph.addFact({ project, key: 'latency', value: 10, observedAt: '2025-01-01T00:00:00.000Z' }).id;
    fixtureIds[`${project}-fact-new`] = graph.addFact({ project, key: 'latency', value: 20, observedAt: '2025-02-01T00:00:00.000Z' }).id;
  }
  graph.link({ project: 'alpha', from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-attempt'], relation: 'tried' });
  graph.link({ project: 'alpha', from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-memory'], relation: 'noted' });
  // The deliberate cross-project edge, and a way back into alpha through beta:
  // a read in alpha must not follow either.
  importHistoricalRelation(graph, { id: 'relation-alpha-beta', from: fixtureIds['alpha-decision'], to: fixtureIds['beta-attempt'], relation: 'related', project: 'alpha' });
  fixtureIds['alpha-far-decision'] = graph.addDecision({ project: 'alpha', title: 'alpha far decision', chosen: 'x' }).id;
  importHistoricalRelation(graph, { id: 'relation-beta-alpha-far', from: fixtureIds['beta-attempt'], to: fixtureIds['alpha-far-decision'], relation: 'related', project: 'beta' });
  // The real project named "default", and two capture origins with no project.
  fixtureIds['default-decision'] = graph.addDecision({ project: 'default', title: 'Real default MARKER cache', chosen: 'x' }).id;
  fixtureIds['default-memory'] = graph.remember({ project: 'default', memoryType: 'note', key: 'note', text: 'MEMORY-MARKER real default' }).memory.id;
  for (const origin of ['a', 'b']) {
    fixtureIds[`origin-${origin}-decision`] = graph.addDecision({ originId: `origin_${origin}`, title: `origin ${origin} MARKER cache`, chosen: 'x' }).id;
    fixtureIds[`origin-${origin}-memory`] = graph.remember({ originId: `origin_${origin}`, memoryType: 'note', key: 'note', text: `MEMORY-MARKER origin ${origin}` }).memory.id;
  }
  return graph;
}

const ids = (items) => items.map((item) => item.record?.id ?? item.id).sort();
const contextIds = (context) => ({
  activeDecisions: ids(context.activeDecisions),
  staleAssumptions: ids(context.staleAssumptions),
  failedAttempts: ids(context.failedAttempts),
  firedConditions: context.firedConditions.map((item) => item.decisionId).sort()
});

// What each boundary may see, per path. The legacy "default" and projectless
// records appear under no project, and the origins only to their own origin.
// recall ranks every kind, so the project's MARKER decisions come with its
// memory.
const EXPECTED = () => ({
  alpha: {
    search: [fixtureIds['alpha-decision'], fixtureIds['alpha-overdue'], 'legacy-alpha-decision'].sort(),
    decisions: [fixtureIds['alpha-decision'], fixtureIds['alpha-far-decision'], fixtureIds['alpha-overdue'], 'legacy-alpha-decision'].sort(),
    recall: [fixtureIds['alpha-decision'], fixtureIds['alpha-memory'], fixtureIds['alpha-overdue'], 'legacy-alpha-decision'].sort()
  },
  beta: { search: [fixtureIds['beta-decision'], fixtureIds['beta-overdue']].sort(), decisions: [fixtureIds['beta-decision'], fixtureIds['beta-overdue']].sort(), recall: [fixtureIds['beta-decision'], fixtureIds['beta-memory'], fixtureIds['beta-overdue']].sort() },
  default: { search: [fixtureIds['default-decision']], decisions: [fixtureIds['default-decision']], recall: [fixtureIds['default-decision'], fixtureIds['default-memory']].sort() }
});

for (const project of ['alpha', 'beta', 'default']) {
  test(`an explicit ${project} read returns only what ${project} owns, on every core path`, () => {
    const graph = fixture();
    const expected = EXPECTED()[project];
    assert.deepEqual(ids(graph.search('MARKER', { project }).items), expected.search, 'search');
    assert.deepEqual(ids(graph.search('', { project, kind: 'decision' }).items), expected.decisions, 'the project predicate alone');
    assert.deepEqual(ids(graph.recall('MEMORY-MARKER', { project }).items), expected.recall, 'recall');
    const context = graph.context({ project });
    assert.equal(context.project, project);
    for (const [name, values] of Object.entries(contextIds(context))) {
      for (const id of values) assert.ok([...privilegedSnapshot(graph).records, ...privilegedSnapshot(graph).facts].find(record => record.id === id)?.project === project, `context ${name} holds ${id}`);
    }
    const retrieved = graph.retrieve('MARKER', { project });
    for (const item of retrieved.items) {
      const owner = item.record.project;
      assert.equal(owner, project, `retrieve returned ${item.record.id} of ${owner}`);
      assert.notEqual(item.record.attribution, 'legacy_ambiguous');
    }
  });
}

test('an explicit "default" read sees the real project only, never legacy "default" or projectless data (OD-1)', () => {
  const graph = fixture();
  for (const read of [
    () => ids(graph.search('', { project: 'default' }).items),
    () => ids(graph.retrieve('', { project: 'default' }).items),
    () => ids(graph.recall('', { project: 'default' }).items),
    () => Object.values(contextIds(graph.context({ project: 'default' }))).flat()
  ]) {
    const seen = read();
    for (const legacy of ['legacy-default-decision', 'legacy-default-memory', 'legacy-projectless-decision']) assert.equal(seen.includes(legacy), false, `${legacy} in ${JSON.stringify(seen)}`);
  }
  // The distinction survives the attribution migration: legacy data is then
  // legacy_ambiguous or legacy_unattributed, and still in no project's read.
  graph.migrateAttribution();
  assert.deepEqual(ids(graph.search('MARKER', { project: 'default' }).items), EXPECTED().default.search);
  assert.deepEqual(ids(graph.recall('MEMORY-MARKER', { project: 'default' }).items), EXPECTED().default.recall);
});

test('a read with no project returns nothing on every core path: no other project, no "default" bucket', () => {
  const graph = fixture();
  const signalsBefore = privilegedSnapshot(graph).reviewSignals.length;
  for (const options of [{}, { project: undefined }, { project: null }]) {
    assert.deepEqual(graph.search('MARKER', options).items, [], 'search');
    assert.deepEqual(graph.search('', { ...options, kind: 'decision' }).items, [], 'the project predicate alone');
    assert.deepEqual(graph.retrieve('MARKER', options).items, [], 'retrieve');
    assert.deepEqual(graph.retrieve('', options).items, [], 'retrieve, empty query');
    assert.deepEqual(graph.recall('MEMORY-MARKER', options).items, [], 'recall');
    assert.deepEqual(graph.recall('', options).items, [], 'recall, empty query');
    const context = graph.context(options);
    assert.deepEqual(contextIds(context), { activeDecisions: [], staleAssumptions: [], failedAttempts: [], firedConditions: [] }, 'context');
    assert.deepEqual([context.belowConfidenceThreshold, context.conditionDiagnostics, context.reusableAttempts], [[], [], []]);
  }
  assert.equal(graph.context().activeDecisions.length, 0, 'context() with no argument');
  // Nothing was evaluated, so nothing was written.
  assert.equal(privilegedSnapshot(graph).reviewSignals.length, signalsBefore, 'an unresolved context raises no review signal');
  // Not relabelled as the shared "default" bucket either.
  assert.equal(graph.recall('', {}).completeness.scope.project, null);
  assert.equal(graph.context({}).project, null);
  assert.equal(graph.context({}).completeness.scope.project, null);
});

test('an unresolved read that presents an origin id sees only that origin\'s unattributed records', () => {
  const graph = fixture();
  assert.deepEqual(ids(graph.search('MARKER', { originId: 'origin_a' }).items), [fixtureIds['origin-a-decision']]);
  assert.deepEqual(ids(graph.retrieve('MARKER', { originId: 'origin_a' }).items), [fixtureIds['origin-a-decision']]);
  assert.deepEqual(ids(graph.recall('MEMORY-MARKER', { originId: 'origin_a' }).items), [fixtureIds['origin-a-decision'], fixtureIds['origin-a-memory']].sort());
  assert.deepEqual(contextIds(graph.context({ originId: 'origin_a' })).activeDecisions, [fixtureIds['origin-a-decision']]);
  // A project, when one is selected, decides; the origin adds nothing to it.
  assert.deepEqual(ids(graph.search('MARKER', { project: 'beta', originId: 'origin_a' }).items), EXPECTED().beta.search);
  for (const blank of ['', '   ', null]) assert.deepEqual(graph.search('MARKER', { originId: blank }).items, [], `origin ${JSON.stringify(blank)}`);
  assert.deepEqual(graph.search('MARKER', { originId: 'origin_unknown' }).items, []);
});

test('graph expansion by retrieve stays inside the read boundary, from either side of the cross-project edge', () => {
  const graph = fixture();
  const alpha = graph.retrieve('MARKER', { project: 'alpha' });
  const expanded = alpha.items.filter((item) => item.matchedBy === 'graph');
  assert.deepEqual(ids(expanded), [fixtureIds['alpha-attempt'], fixtureIds['alpha-memory']].sort());
  assert.equal(JSON.stringify(alpha).includes(fixtureIds['beta-attempt']), false, 'the beta endpoint is not disclosed');
  const beta = graph.retrieve('warm-up', { project: 'beta' });
  assert.deepEqual(ids(beta.items), [fixtureIds['beta-attempt']]);
  for (const id of [fixtureIds['alpha-decision'], fixtureIds['alpha-attempt'], fixtureIds['alpha-memory'], fixtureIds['alpha-far-decision']]) assert.equal(JSON.stringify(beta).includes(id), false, 'the alpha endpoint is not disclosed');
});

test('recall ranks the graph only through records inside the boundary', () => {
  const graph = fixture();
  const ranked = (focalId) => graph.recall('', { project: 'alpha', focalId });
  const fromAlpha = ranked(fixtureIds['alpha-decision']);
  const graphHits = fromAlpha.items.filter((item) => item.ranks.graph !== null).map((item) => item.record.id).sort();
  assert.deepEqual(graphHits, [fixtureIds['alpha-attempt'], fixtureIds['alpha-memory']].sort(), 'no hop through beta reaches alpha-far-decision');
  // An out-of-scope focus is answered exactly like one that does not exist.
  assert.deepEqual(ranked(fixtureIds['beta-attempt']).signals, ranked('decision_absent').signals);
  assert.deepEqual(ranked(fixtureIds['beta-attempt']).items.map((item) => item.ranks.graph), ranked('decision_absent').items.map((item) => item.ranks.graph));
});

test('context evaluates and records reviews only for the selected project', () => {
  const graph = fixture();
  const alpha = graph.reviewContext({ project: 'alpha' });
  assert.deepEqual(alpha.openReviews.map((item) => item.decisionId), [fixtureIds['alpha-overdue']]);
  assert.deepEqual(ids(alpha.staleAssumptions), [fixtureIds['alpha-fact-old']]);
  assert.deepEqual(ids(alpha.failedAttemptsToAvoid), [fixtureIds['alpha-attempt']]);
  const signals = privilegedSnapshot(graph).reviewSignals.map((signal) => signal.decisionId);
  assert.deepEqual(signals, [fixtureIds['alpha-overdue']], 'no signal is raised for another project');
});

test('an invalid project is still refused on every core path', () => {
  const graph = fixture();
  for (const read of [
    () => graph.search('', { project: '' }),
    () => graph.retrieve('', { project: ' ' }),
    () => graph.recall('', { project: 7 }),
    () => graph.context({ project: '' })
  ]) assert.throws(read, /project must be a non-empty string/);
});
