import { historicalIds } from '../tools/historical-ids.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import * as kernel from '../src/shadowgraph.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRebuild, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { historicalRelation } from '../tools/historical-relation.js';

// Labels below refer to IDs returned by ordinary creation, never supplied IDs.
const fixtureIds = {};

// PR-09 (plan v1.4.4 §10.5; P1 reconciliation F-12, and F-16 as corrected by
// the owner): every id is resolved through one chokepoint, inside the
// boundary of the request that names it. A by-id read of an id outside that
// boundary -- another project, the real project "default", legacy data,
// another origin -- has exactly the outcome of an id that does not exist. A
// traversal inherits its root request's boundary and never crosses it, not
// even to come back. A new relation joins two entities of the one project, or
// the one origin, it is written for; nothing widens a write. Every fixture is
// synthetic.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;

// Legacy data a store written before schema 6 holds: a record in the
// literal "default" and one stored with no project.
function legacyPayload() {
  const historical = {};
  const writer = createShadowGraph({ now });
  historical['legacy-default-decision'] = writer.addDecision({ project: 'default', title: 'Legacy MARKER decision', chosen: 'x' }).id;
  historical['legacy-projectless-decision'] = writer.addDecision({ project: 'default', title: 'Projectless MARKER decision', chosen: 'x' }).id;
  const payload = historicalIds(privilegedSnapshot(writer), historical, { now });
  payload.schemaVersion = 5;
  const strip = (entity) => {
    if (!entity || typeof entity !== 'object') return;
    delete entity.attribution;
    delete entity.originId;
    // Schema 5 predates erasure tokens and attempt causes (schema 7).
    delete entity.erasureToken;
    delete entity.causalClaim;
    if (entity.schemaVersion >= 6) entity.schemaVersion = 5;
  };
  for (const entity of payload.records) strip(entity);
  for (const entry of payload.journal) { entry.schemaVersion = 5; strip(entry.payload); }
  delete payload.records.find((entity) => entity.id === 'legacy-projectless-decision').project;
  const entry = payload.journal.find((item) => item.entityId === 'legacy-projectless-decision');
  delete entry.payload.project;
  entry.project = null;
  return payload;
}

// A relation across a boundary that a store written before PR-09 can hold;
// link() refuses to create one now. It is kept as legacy data.
const importHistoricalRelation = (graph, relation) => graph.importData(historicalRelation({ ...relation, seq: privilegedSnapshot(graph).journalSeq + 1, at: NOW }));

function fixture() {
  const graph = createShadowGraph({ now });
  graph.importData(legacyPayload());
  const created = graph.addDecision({ project: 'alpha', title: 'Alpha MARKER cache', chosen: 'redis', alternatives: [{ label: 'memcached', reasonRejected: 'slower' }] });
  fixtureIds['alpha-decision'] = created.id;
  fixtureIds['alpha-alternative'] = created.alternatives[0].id;
  fixtureIds['alpha-attempt'] = graph.addAttempt({ project: 'alpha', solution: 'alpha warm-up script', result: 'worked' }).id;
  fixtureIds['alpha-memory'] = graph.remember({ project: 'alpha', memoryType: 'note', key: 'note', text: 'MEMORY-MARKER alpha' }).memory.id;
  fixtureIds['alpha-memory-alice'] = graph.remember({ project: 'alpha', scope: { userId: 'alice' }, memoryType: 'note', key: 'note', text: 'MEMORY-MARKER alice' }).memory.id;
  fixtureIds['alpha-fact'] = graph.addFact({ project: 'alpha', key: 'latency', value: 10 }).id;
  fixtureIds['alpha-far-decision'] = graph.addDecision({ project: 'alpha', title: 'Alpha far MARKER decision', chosen: 'x' }).id;
  fixtureIds['beta-decision'] = graph.addDecision({ project: 'beta', title: 'Beta MARKER cache', chosen: 'memcached' }).id;
  fixtureIds['beta-attempt'] = graph.addAttempt({ project: 'beta', solution: 'beta warm-up script', result: 'worked' }).id;
  fixtureIds['default-decision'] = graph.addDecision({ project: 'default', title: 'Real default MARKER decision', chosen: 'x' }).id;
  fixtureIds['origin-a-decision'] = graph.addDecision({ originId: 'origin_a', title: 'Origin a MARKER decision', chosen: 'x' }).id;
  fixtureIds['origin-a-attempt'] = graph.addAttempt({ originId: 'origin_a', solution: 'origin a script', result: 'worked' }).id;
  fixtureIds['origin-b-decision'] = graph.addDecision({ originId: 'origin_b', title: 'Origin b MARKER decision', chosen: 'x' }).id;
  fixtureIds['relation-alpha-tried'] = graph.link({ project: 'alpha', from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-attempt'], relation: 'tried' }).id;
  fixtureIds['relation-alpha-noted'] = graph.link({ project: 'alpha', from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-memory'], relation: 'noted' }).id;
  fixtureIds['relation-alpha-alice'] = graph.link({ project: 'alpha', from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-memory-alice'], relation: 'noted' }).id;
  fixtureIds['relation-alpha-measured'] = graph.link({ project: 'alpha', from: fixtureIds['alpha-attempt'], to: fixtureIds['alpha-fact'], relation: 'measured' }).id;
  fixtureIds['relation-origin-a-tried'] = graph.link({ originId: 'origin_a', from: fixtureIds['origin-a-decision'], to: fixtureIds['origin-a-attempt'], relation: 'tried' }).id;
  // Cross-boundary relations, as history left them. The walk out of alpha
  // through beta and back into alpha is the one a traversal must not take.
  importHistoricalRelation(graph, { id: 'relation-alpha-beta', from: fixtureIds['alpha-decision'], to: fixtureIds['beta-attempt'], relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-beta-alpha-far', from: fixtureIds['beta-attempt'], to: fixtureIds['alpha-far-decision'], relation: 'related', project: 'beta' });
  importHistoricalRelation(graph, { id: 'relation-alpha-default', from: fixtureIds['alpha-decision'], to: fixtureIds['default-decision'], relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-alpha-legacy', from: fixtureIds['alpha-decision'], to: 'legacy-default-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-alpha-projectless', from: fixtureIds['alpha-attempt'], to: 'legacy-projectless-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-alpha-origin', from: fixtureIds['alpha-decision'], to: fixtureIds['origin-a-decision'], relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-origin-a-b', from: fixtureIds['origin-a-attempt'], to: fixtureIds['origin-b-decision'], relation: 'related', project: null });
  return graph;
}

// Everything a read in alpha must never return or name.
const HIDDEN_FROM_ALPHA = () => [
  fixtureIds['beta-decision'], fixtureIds['beta-attempt'], fixtureIds['default-decision'], 'legacy-default-decision', 'legacy-projectless-decision',
  fixtureIds['origin-a-decision'], fixtureIds['origin-a-attempt'], fixtureIds['origin-b-decision'], 'relation-alpha-beta', 'relation-beta-alpha-far',
  'relation-alpha-default', 'relation-alpha-legacy', 'relation-alpha-projectless', 'relation-alpha-origin', 'beta', 'origin_'
];
const assertNamesNone = (value, names, label) => {
  const text = JSON.stringify(value);
  for (const name of names) assert.equal(text.includes(name), false, `${label} names ${name}`);
};
const nodeIds = (result) => result.nodes.map((node) => node.id).sort();
const relationIds = (result) => result.relations.map((relation) => relation.id).sort();
// The only difference an absent id may make is the id the caller typed.
const withoutRoot = (result) => ({ ...result, root: '<root>' });
const outcomeOf = (call) => {
  try { return { result: withoutRoot(call()) }; }
  catch (error) { return { error: { name: error.name, message: error.message, code: error.code ?? null, keys: Object.keys(error).sort() } }; }
};
const ABSENT = 'decision_absent_0000';

test('a by-id read returns an id of its own project and nothing outside it', () => {
  const graph = fixture();
  const own = graph.traverse({ id: fixtureIds['alpha-decision'], project: 'alpha' });
  assert.equal(own.nodes[0].id, fixtureIds['alpha-decision'], 'the root comes first');
  assert.equal(Object.hasOwn(own, 'limitation'), false);
  assert.equal(graph.traverse({ id: fixtureIds['beta-decision'], project: 'beta' }).nodes[0].id, fixtureIds['beta-decision']);
  for (const hidden of [fixtureIds['beta-decision'], fixtureIds['beta-attempt'], fixtureIds['default-decision'], 'legacy-default-decision', 'legacy-projectless-decision', fixtureIds['origin-a-decision']].sort()) {
    const result = graph.traverse({ id: hidden, project: 'alpha' });
    assert.deepEqual(result.nodes, [], hidden);
    assert.deepEqual(result.relations, [], hidden);
    assert.equal(result.limitation.code, 'scoped_coverage', hidden);
  }
  assert.deepEqual(graph.traverse({ id: fixtureIds['alpha-decision'], project: 'beta' }).nodes, []);
  // An alternative is inside the boundary its decision is inside.
  assert.deepEqual(nodeIds(graph.traverse({ id: fixtureIds['alpha-alternative'], project: 'alpha' })), [fixtureIds['alpha-alternative']]);
  assert.deepEqual(graph.traverse({ id: fixtureIds['alpha-alternative'], project: 'beta' }).nodes, []);
});

test('an out-of-scope id and an id that does not exist have exactly the same outcome', () => {
  const graph = fixture();
  const cases = [
    { scope: { project: 'alpha' }, hidden: [fixtureIds['beta-decision'], fixtureIds['beta-attempt'], fixtureIds['default-decision'], 'legacy-default-decision', 'legacy-projectless-decision', fixtureIds['origin-a-decision']].sort() },
    { scope: { project: 'default' }, hidden: ['legacy-default-decision', 'legacy-projectless-decision', fixtureIds['alpha-decision']].sort() },
    { scope: { originId: 'origin_b' }, hidden: [fixtureIds['origin-a-decision'], fixtureIds['alpha-decision']].sort() },
    { scope: {}, hidden: [fixtureIds['alpha-decision'], fixtureIds['beta-decision'], fixtureIds['default-decision'], 'legacy-default-decision', fixtureIds['origin-a-decision']].sort() },
    // A memory outside the requested memory scope, in its own project (F-12).
    { scope: { project: 'alpha' }, hidden: [fixtureIds['alpha-memory-alice']] }
  ];
  for (const { scope, hidden } of cases) {
    for (const id of hidden) {
      for (const options of [{}, { depth: 3, direction: 'out' }, { relation: 'related' }]) {
        const absent = outcomeOf(() => graph.traverse({ id: ABSENT, ...scope, ...options }));
        const outside = outcomeOf(() => graph.traverse({ id, ...scope, ...options }));
        assert.deepEqual(outside, absent, `${id} under ${JSON.stringify(scope)} ${JSON.stringify(options)}`);
        assertNamesNone(outside, [...HIDDEN_FROM_ALPHA(), id], `${id} outcome`);
      }
      // Invalid input fails the same way whether or not the id exists.
      for (const bad of [{ depth: 0 }, { depth: 11 }, { direction: 'sideways' }, { scope: { team: 'x' } }]) {
        assert.deepEqual(outcomeOf(() => graph.traverse({ id, ...scope, ...bad })), outcomeOf(() => graph.traverse({ id: ABSENT, ...scope, ...bad })), `${id} ${JSON.stringify(bad)}`);
      }
    }
  }
  assert.throws(() => graph.traverse({ id: fixtureIds['alpha-decision'], project: '' }), /project must be a non-empty string/);
  for (const id of [undefined, '', 7]) assert.throws(() => graph.traverse({ id, project: 'alpha' }), /A traversal requires an id/);
});

test('a by-id read under an origin sees that origin only', () => {
  const graph = fixture();
  assert.deepEqual(nodeIds(graph.traverse({ id: fixtureIds['origin-a-decision'], originId: 'origin_a', depth: 5 })), [fixtureIds['origin-a-attempt'], fixtureIds['origin-a-decision']].sort(), 'the historical relation into origin b is not crossed');
  for (const scope of [{ originId: 'origin_b' }, { project: 'alpha' }, { originId: '' }, {}]) {
    assert.deepEqual(outcomeOf(() => graph.traverse({ id: fixtureIds['origin-a-decision'], ...scope })), outcomeOf(() => graph.traverse({ id: ABSENT, ...scope })), JSON.stringify(scope));
  }
  // A project, when one is selected, decides; the origin adds nothing.
  assert.deepEqual(graph.traverse({ id: fixtureIds['origin-a-decision'], project: 'alpha', originId: 'origin_a' }).nodes, []);
});

test('a traversal stays inside its root request\'s project and never leaves it to come back', () => {
  const graph = fixture();
  const alpha = graph.traverse({ id: fixtureIds['alpha-decision'], project: 'alpha', depth: 10 });
  assert.deepEqual(nodeIds(alpha), [fixtureIds['alpha-attempt'], fixtureIds['alpha-decision'], fixtureIds['alpha-fact'], fixtureIds['alpha-memory']].sort());
  assert.deepEqual(relationIds(alpha), [fixtureIds['relation-alpha-measured'], fixtureIds['relation-alpha-noted'], fixtureIds['relation-alpha-tried']].sort());
  assert.equal(nodeIds(alpha).includes(fixtureIds['alpha-far-decision']), false, 'reachable only through beta, so not reached');
  assertNamesNone(alpha, HIDDEN_FROM_ALPHA(), 'alpha traversal');
  // The memory scope still narrows memory nodes inside the project.
  assert.deepEqual(nodeIds(graph.traverse({ id: fixtureIds['alpha-decision'], project: 'alpha', scope: { userId: 'alice' } })).filter((id) => [fixtureIds['alpha-memory'], fixtureIds['alpha-memory-alice']].includes(id)), [fixtureIds['alpha-memory-alice']]);
  // From the far decision, the relation back through beta leads nowhere.
  const far = graph.traverse({ id: fixtureIds['alpha-far-decision'], project: 'alpha', depth: 10 });
  assert.deepEqual(nodeIds(far), [fixtureIds['alpha-far-decision']]);
  assert.deepEqual(far.relations, []);
  // Beta's view of the same relations discloses nothing of alpha.
  const beta = graph.traverse({ id: fixtureIds['beta-attempt'], project: 'beta', depth: 10 });
  assert.deepEqual(nodeIds(beta), [fixtureIds['beta-attempt']]);
  assertNamesNone(beta, [fixtureIds['alpha-decision'], fixtureIds['alpha-attempt'], fixtureIds['alpha-fact'], fixtureIds['alpha-memory'], fixtureIds['relation-alpha-tried'], 'relation-beta-alpha-far'], 'beta traversal');
  // Every direction and relation filter keeps the same boundary.
  for (const direction of ['in', 'out', 'both']) {
    for (const relation of [undefined, 'related', 'tried']) {
      const result = graph.traverse({ id: fixtureIds['alpha-decision'], project: 'alpha', depth: 10, direction, ...(relation ? { relation } : {}) });
      assertNamesNone(result, HIDDEN_FROM_ALPHA(), `${direction} ${relation}`);
    }
  }
  // The real project "default" does not reach legacy "default" data.
  assert.deepEqual(nodeIds(graph.traverse({ id: fixtureIds['default-decision'], project: 'default', depth: 10 })), [fixtureIds['default-decision']]);
});

test('a new relation joins two entities of the one project or origin it is written for', () => {
  const graph = fixture();
  const relation = graph.link({ project: 'alpha', from: fixtureIds['alpha-far-decision'], to: fixtureIds['alpha-fact'], relation: 'depends_on' });
  assert.equal(relation.from, fixtureIds['alpha-far-decision']);
  assert.equal(privilegedSnapshot(graph).journal.find((item) => item.entityId === relation.id).project, 'alpha');
  // An alternative belongs to its decision's project.
  graph.link({ project: 'alpha', from: fixtureIds['alpha-attempt'], to: fixtureIds['alpha-alternative'], relation: 'reconsiders' });
  const origin = graph.link({ originId: 'origin_a', from: fixtureIds['origin-a-attempt'], to: fixtureIds['origin-a-decision'], relation: 'informs' });
  assert.equal(privilegedSnapshot(graph).journal.find((item) => item.entityId === origin.id).project, null);
  graph.link({ project: 'default', from: fixtureIds['default-decision'], to: fixtureIds['default-decision'], relation: 'self' });
  assert.equal(graph.validate().valid, true);
});

test('a relation across the boundary is refused exactly like one to an entity that does not exist', () => {
  const graph = fixture();
  const refusals = [
    [{ project: 'alpha' }, fixtureIds['alpha-decision'], fixtureIds['beta-attempt']],
    [{ project: 'alpha' }, fixtureIds['beta-decision'], fixtureIds['alpha-attempt']],
    [{ project: 'alpha' }, fixtureIds['alpha-decision'], fixtureIds['default-decision']],
    [{ project: 'alpha' }, fixtureIds['alpha-decision'], 'legacy-default-decision'],
    [{ project: 'alpha' }, fixtureIds['alpha-decision'], 'legacy-projectless-decision'],
    [{ project: 'alpha' }, fixtureIds['alpha-decision'], fixtureIds['origin-a-decision']],
    [{ project: 'alpha', originId: 'origin_a' }, fixtureIds['alpha-decision'], fixtureIds['origin-a-decision']],
    [{ originId: 'origin_a' }, fixtureIds['origin-a-decision'], fixtureIds['alpha-decision']],
    [{ originId: 'origin_a' }, fixtureIds['origin-a-decision'], fixtureIds['origin-b-decision']],
    [{ project: 'default' }, fixtureIds['default-decision'], 'legacy-default-decision'],
    [{ project: 'beta' }, fixtureIds['beta-decision'], fixtureIds['alpha-alternative']],
    // A wider read never widens a write: nothing in the request can.
    [{ project: 'alpha', grantId: 'grant_synthetic', grant: { projects: ['beta'] } }, fixtureIds['alpha-decision'], fixtureIds['beta-attempt']]
  ];
  const before = privilegedSnapshot(graph);
  for (const [scope, from, to] of refusals) {
    const refused = outcomeOf(() => graph.link({ ...scope, from, to, relation: 'related' }));
    assert.ok(refused.error, `${from} -> ${to} under ${JSON.stringify(scope)} was refused`);
    assert.match(refused.error.message, /Relation endpoints must exist/);
    assert.deepEqual(refused, outcomeOf(() => graph.link({ ...scope, from, to: ABSENT, relation: 'related' })), `${from} -> ${to}: as an absent target`);
    assert.deepEqual(refused, outcomeOf(() => graph.link({ ...scope, from: ABSENT, to, relation: 'related' })), `${from} -> ${to}: as an absent source`);
    assertNamesNone(refused, [from, to, 'beta', 'origin_', 'legacy', 'default'], `refusal of ${from} -> ${to}`);
  }
  // No project and no origin: nothing would own the relation.
  assert.throws(() => graph.link({ from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-attempt'], relation: 'related' }), (error) => error.code === 'write_scope_unresolved');
  assert.deepEqual(privilegedSnapshot(graph), before, 'no refused link wrote anything');
});

test('relations written before this rule are kept, and scoped reads do not cross them', () => {
  const graph = fixture();
  const ids = (snapshot) => snapshot.relations.map((relation) => relation.id).sort();
  const before = ids(privilegedSnapshot(graph));
  for (const id of ['relation-alpha-beta', 'relation-beta-alpha-far', 'relation-alpha-default', 'relation-alpha-legacy', 'relation-alpha-projectless', 'relation-alpha-origin', 'relation-origin-a-b']) {
    assert.ok(before.includes(id), id);
  }
  graph.traverse({ id: fixtureIds['alpha-decision'], project: 'alpha', depth: 10 });
  graph.link({ project: 'alpha', from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-fact'], relation: 'depends_on' });
  assert.deepEqual(ids(privilegedSnapshot(graph)).filter((id) => before.includes(id)), before, 'nothing rewritten or deleted');
  // Whole-store integrity is privileged (plan PR-10); a scoped rebuild never
  // follows the historical alpha-beta relation, which is exactly the point.
  assert.equal(privilegedValidate(graph).valid, true);
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true, rebuilt.reason);
  assert.ok(rebuilt.projection.relations.some((relation) => relation.id === 'relation-alpha-beta'));
});

test('retrieve and recall stay non-leaking through the same chokepoint', () => {
  const graph = fixture();
  // retrieve adds each neighbour it accepts to the hits as it goes, so the
  // fact measured by the attempt joins too -- from inside alpha only.
  const retrieved = graph.retrieve('MARKER', { project: 'alpha' });
  assert.deepEqual(retrieved.items.filter((item) => item.matchedBy === 'graph').map((item) => item.record.id).sort(), [fixtureIds['alpha-attempt'], fixtureIds['alpha-fact'], fixtureIds['alpha-memory']].sort());
  assertNamesNone(retrieved, HIDDEN_FROM_ALPHA(), 'retrieve');
  const recalled = graph.recall('', { project: 'alpha', focalId: fixtureIds['alpha-decision'] });
  assert.deepEqual(recalled.items.filter((item) => item.ranks.graph !== null).map((item) => item.record.id).sort(), [fixtureIds['alpha-attempt'], fixtureIds['alpha-fact'], fixtureIds['alpha-memory']].sort());
  assertNamesNone(recalled, HIDDEN_FROM_ALPHA(), 'recall');
  const focus = (focalId) => graph.recall('', { project: 'alpha', focalId });
  for (const hidden of [fixtureIds['beta-attempt'], fixtureIds['default-decision'], 'legacy-default-decision', fixtureIds['origin-a-decision']].sort()) {
    assert.deepEqual(focus(hidden), focus(ABSENT), `a focus on ${hidden} is answered like an absent one`);
  }
  assert.deepEqual(graph.retrieve('MARKER', {}).items, []);
  assert.deepEqual(graph.recall('', {}).items, []);
});

test('no result computed under one boundary is reused under another', () => {
  // By-id reads, traversals and graph expansions under every boundary,
  // interleaved on one graph: each must equal the same call on a fresh graph.
  const shared = fixture();
  const saved = privilegedSnapshot(shared);
  const fresh = () => { const graph = createShadowGraph({ now }); graph.importData(saved); return graph; };
  const calls = [
    ['traverse', { id: fixtureIds['alpha-decision'], project: 'alpha', depth: 10 }],
    ['traverse', { id: fixtureIds['alpha-decision'], project: 'beta', depth: 10 }],
    ['traverse', { id: fixtureIds['alpha-decision'], depth: 10 }],
    ['traverse', { id: fixtureIds['origin-a-decision'], originId: 'origin_a', depth: 10 }],
    ['traverse', { id: fixtureIds['origin-a-decision'], originId: 'origin_b', depth: 10 }],
    ['traverse', { id: fixtureIds['beta-attempt'], project: 'beta', depth: 10 }],
    ['traverse', { id: fixtureIds['beta-attempt'], project: 'alpha', depth: 10 }],
    ['retrieve', 'MARKER', { project: 'alpha' }],
    ['retrieve', 'MARKER', { project: 'beta' }],
    ['retrieve', 'MARKER', { originId: 'origin_a' }],
    ['recall', '', { project: 'alpha', focalId: fixtureIds['alpha-decision'] }],
    ['recall', '', { project: 'beta', focalId: fixtureIds['alpha-decision'] }],
    ['recall', '', { originId: 'origin_b', focalId: fixtureIds['origin-a-decision'] }]
  ];
  const run = (graph, [name, ...args]) => graph[name](...args);
  for (const call of [...calls, ...[...calls].reverse(), ...calls]) assert.deepEqual(run(shared, call), run(fresh(), call), JSON.stringify(call));
});

test('the by-id chokepoint and its raw lookup are not public', () => {
  const graph = fixture();
  for (const name of ['entity', 'rawEntity']) {
    assert.equal(Object.hasOwn(graph, name), false, `graph.${name}`);
    assert.equal(Object.hasOwn(kernel, name), false, `module export ${name}`);
  }
});
