import test from 'node:test';
import assert from 'node:assert/strict';
import * as kernel from '../src/shadowgraph.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRebuild, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { historicalRelation } from '../tools/historical-relation.js';

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
  const writer = createShadowGraph({ now });
  writer.addDecision({ project: 'default', id: 'legacy-default-decision', title: 'Legacy MARKER decision', chosen: 'x' });
  writer.addDecision({ project: 'default', id: 'legacy-projectless-decision', title: 'Projectless MARKER decision', chosen: 'x' });
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
  return payload;
}

// A relation across a boundary that a store written before PR-09 can hold;
// link() refuses to create one now. It is kept as legacy data.
const importHistoricalRelation = (graph, relation) => graph.importData(historicalRelation({ ...relation, seq: privilegedSnapshot(graph).journalSeq + 1, at: NOW }));

function fixture() {
  const graph = createShadowGraph({ now });
  graph.importData(legacyPayload());
  graph.addDecision({ project: 'alpha', id: 'alpha-decision', title: 'Alpha MARKER cache', chosen: 'redis', alternatives: [{ id: 'alpha-alternative', label: 'memcached', reasonRejected: 'slower' }] });
  graph.addAttempt({ project: 'alpha', id: 'alpha-attempt', solution: 'alpha warm-up script', result: 'worked' });
  graph.remember({ project: 'alpha', id: 'alpha-memory', memoryType: 'note', key: 'note', text: 'MEMORY-MARKER alpha' });
  graph.remember({ project: 'alpha', id: 'alpha-memory-alice', scope: { userId: 'alice' }, memoryType: 'note', key: 'note', text: 'MEMORY-MARKER alice' });
  graph.addFact({ project: 'alpha', id: 'alpha-fact', key: 'latency', value: 10 });
  graph.addDecision({ project: 'alpha', id: 'alpha-far-decision', title: 'Alpha far MARKER decision', chosen: 'x' });
  graph.addDecision({ project: 'beta', id: 'beta-decision', title: 'Beta MARKER cache', chosen: 'memcached' });
  graph.addAttempt({ project: 'beta', id: 'beta-attempt', solution: 'beta warm-up script', result: 'worked' });
  graph.addDecision({ project: 'default', id: 'default-decision', title: 'Real default MARKER decision', chosen: 'x' });
  graph.addDecision({ originId: 'origin_a', id: 'origin-a-decision', title: 'Origin a MARKER decision', chosen: 'x' });
  graph.addAttempt({ originId: 'origin_a', id: 'origin-a-attempt', solution: 'origin a script', result: 'worked' });
  graph.addDecision({ originId: 'origin_b', id: 'origin-b-decision', title: 'Origin b MARKER decision', chosen: 'x' });
  graph.link({ project: 'alpha', id: 'relation-alpha-tried', from: 'alpha-decision', to: 'alpha-attempt', relation: 'tried' });
  graph.link({ project: 'alpha', id: 'relation-alpha-noted', from: 'alpha-decision', to: 'alpha-memory', relation: 'noted' });
  graph.link({ project: 'alpha', id: 'relation-alpha-alice', from: 'alpha-decision', to: 'alpha-memory-alice', relation: 'noted' });
  graph.link({ project: 'alpha', id: 'relation-alpha-measured', from: 'alpha-attempt', to: 'alpha-fact', relation: 'measured' });
  graph.link({ originId: 'origin_a', id: 'relation-origin-a-tried', from: 'origin-a-decision', to: 'origin-a-attempt', relation: 'tried' });
  // Cross-boundary relations, as history left them. The walk out of alpha
  // through beta and back into alpha is the one a traversal must not take.
  importHistoricalRelation(graph, { id: 'relation-alpha-beta', from: 'alpha-decision', to: 'beta-attempt', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-beta-alpha-far', from: 'beta-attempt', to: 'alpha-far-decision', relation: 'related', project: 'beta' });
  importHistoricalRelation(graph, { id: 'relation-alpha-default', from: 'alpha-decision', to: 'default-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-alpha-legacy', from: 'alpha-decision', to: 'legacy-default-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-alpha-projectless', from: 'alpha-attempt', to: 'legacy-projectless-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-alpha-origin', from: 'alpha-decision', to: 'origin-a-decision', relation: 'related', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation-origin-a-b', from: 'origin-a-attempt', to: 'origin-b-decision', relation: 'related', project: null });
  return graph;
}

// Everything a read in alpha must never return or name.
const HIDDEN_FROM_ALPHA = [
  'beta-decision', 'beta-attempt', 'default-decision', 'legacy-default-decision', 'legacy-projectless-decision',
  'origin-a-decision', 'origin-a-attempt', 'origin-b-decision', 'relation-alpha-beta', 'relation-beta-alpha-far',
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
  const own = graph.traverse({ id: 'alpha-decision', project: 'alpha' });
  assert.equal(own.nodes[0].id, 'alpha-decision', 'the root comes first');
  assert.equal(Object.hasOwn(own, 'limitation'), false);
  assert.equal(graph.traverse({ id: 'beta-decision', project: 'beta' }).nodes[0].id, 'beta-decision');
  for (const hidden of ['beta-decision', 'beta-attempt', 'default-decision', 'legacy-default-decision', 'legacy-projectless-decision', 'origin-a-decision']) {
    const result = graph.traverse({ id: hidden, project: 'alpha' });
    assert.deepEqual(result.nodes, [], hidden);
    assert.deepEqual(result.relations, [], hidden);
    assert.equal(result.limitation.code, 'scoped_coverage', hidden);
  }
  assert.deepEqual(graph.traverse({ id: 'alpha-decision', project: 'beta' }).nodes, []);
  // An alternative is inside the boundary its decision is inside.
  assert.deepEqual(nodeIds(graph.traverse({ id: 'alpha-alternative', project: 'alpha' })), ['alpha-alternative']);
  assert.deepEqual(graph.traverse({ id: 'alpha-alternative', project: 'beta' }).nodes, []);
});

test('an out-of-scope id and an id that does not exist have exactly the same outcome', () => {
  const graph = fixture();
  const cases = [
    { scope: { project: 'alpha' }, hidden: ['beta-decision', 'beta-attempt', 'default-decision', 'legacy-default-decision', 'legacy-projectless-decision', 'origin-a-decision'] },
    { scope: { project: 'default' }, hidden: ['legacy-default-decision', 'legacy-projectless-decision', 'alpha-decision'] },
    { scope: { originId: 'origin_b' }, hidden: ['origin-a-decision', 'alpha-decision'] },
    { scope: {}, hidden: ['alpha-decision', 'beta-decision', 'default-decision', 'legacy-default-decision', 'origin-a-decision'] },
    // A memory outside the requested memory scope, in its own project (F-12).
    { scope: { project: 'alpha' }, hidden: ['alpha-memory-alice'] }
  ];
  for (const { scope, hidden } of cases) {
    for (const id of hidden) {
      for (const options of [{}, { depth: 3, direction: 'out' }, { relation: 'related' }]) {
        const absent = outcomeOf(() => graph.traverse({ id: ABSENT, ...scope, ...options }));
        const outside = outcomeOf(() => graph.traverse({ id, ...scope, ...options }));
        assert.deepEqual(outside, absent, `${id} under ${JSON.stringify(scope)} ${JSON.stringify(options)}`);
        assertNamesNone(outside, [...HIDDEN_FROM_ALPHA, id], `${id} outcome`);
      }
      // Invalid input fails the same way whether or not the id exists.
      for (const bad of [{ depth: 0 }, { depth: 11 }, { direction: 'sideways' }, { scope: { team: 'x' } }]) {
        assert.deepEqual(outcomeOf(() => graph.traverse({ id, ...scope, ...bad })), outcomeOf(() => graph.traverse({ id: ABSENT, ...scope, ...bad })), `${id} ${JSON.stringify(bad)}`);
      }
    }
  }
  assert.throws(() => graph.traverse({ id: 'alpha-decision', project: '' }), /project must be a non-empty string/);
  for (const id of [undefined, '', 7]) assert.throws(() => graph.traverse({ id, project: 'alpha' }), /A traversal requires an id/);
});

test('a by-id read under an origin sees that origin only', () => {
  const graph = fixture();
  assert.deepEqual(nodeIds(graph.traverse({ id: 'origin-a-decision', originId: 'origin_a', depth: 5 })), ['origin-a-attempt', 'origin-a-decision'], 'the historical relation into origin b is not crossed');
  for (const scope of [{ originId: 'origin_b' }, { project: 'alpha' }, { originId: '' }, {}]) {
    assert.deepEqual(outcomeOf(() => graph.traverse({ id: 'origin-a-decision', ...scope })), outcomeOf(() => graph.traverse({ id: ABSENT, ...scope })), JSON.stringify(scope));
  }
  // A project, when one is selected, decides; the origin adds nothing.
  assert.deepEqual(graph.traverse({ id: 'origin-a-decision', project: 'alpha', originId: 'origin_a' }).nodes, []);
});

test('a traversal stays inside its root request\'s project and never leaves it to come back', () => {
  const graph = fixture();
  const alpha = graph.traverse({ id: 'alpha-decision', project: 'alpha', depth: 10 });
  assert.deepEqual(nodeIds(alpha), ['alpha-attempt', 'alpha-decision', 'alpha-fact', 'alpha-memory']);
  assert.deepEqual(relationIds(alpha), ['relation-alpha-measured', 'relation-alpha-noted', 'relation-alpha-tried']);
  assert.equal(nodeIds(alpha).includes('alpha-far-decision'), false, 'reachable only through beta, so not reached');
  assertNamesNone(alpha, HIDDEN_FROM_ALPHA, 'alpha traversal');
  // The memory scope still narrows memory nodes inside the project.
  assert.deepEqual(nodeIds(graph.traverse({ id: 'alpha-decision', project: 'alpha', scope: { userId: 'alice' } })).filter((id) => id.startsWith('alpha-memory')), ['alpha-memory-alice']);
  // From the far decision, the relation back through beta leads nowhere.
  const far = graph.traverse({ id: 'alpha-far-decision', project: 'alpha', depth: 10 });
  assert.deepEqual(nodeIds(far), ['alpha-far-decision']);
  assert.deepEqual(far.relations, []);
  // Beta's view of the same relations discloses nothing of alpha.
  const beta = graph.traverse({ id: 'beta-attempt', project: 'beta', depth: 10 });
  assert.deepEqual(nodeIds(beta), ['beta-attempt']);
  assertNamesNone(beta, ['alpha-', 'relation-alpha', 'relation-beta-alpha-far'], 'beta traversal');
  // Every direction and relation filter keeps the same boundary.
  for (const direction of ['in', 'out', 'both']) {
    for (const relation of [undefined, 'related', 'tried']) {
      const result = graph.traverse({ id: 'alpha-decision', project: 'alpha', depth: 10, direction, ...(relation ? { relation } : {}) });
      assertNamesNone(result, HIDDEN_FROM_ALPHA, `${direction} ${relation}`);
    }
  }
  // The real project "default" does not reach legacy "default" data.
  assert.deepEqual(nodeIds(graph.traverse({ id: 'default-decision', project: 'default', depth: 10 })), ['default-decision']);
});

test('a new relation joins two entities of the one project or origin it is written for', () => {
  const graph = fixture();
  const relation = graph.link({ project: 'alpha', from: 'alpha-far-decision', to: 'alpha-fact', relation: 'depends_on' });
  assert.equal(relation.from, 'alpha-far-decision');
  assert.equal(privilegedSnapshot(graph).journal.find((item) => item.entityId === relation.id).project, 'alpha');
  // An alternative belongs to its decision's project.
  graph.link({ project: 'alpha', from: 'alpha-attempt', to: 'alpha-alternative', relation: 'reconsiders' });
  const origin = graph.link({ originId: 'origin_a', from: 'origin-a-attempt', to: 'origin-a-decision', relation: 'informs' });
  assert.equal(privilegedSnapshot(graph).journal.find((item) => item.entityId === origin.id).project, null);
  graph.link({ project: 'default', from: 'default-decision', to: 'default-decision', relation: 'self' });
  assert.equal(graph.validate().valid, true);
});

test('a relation across the boundary is refused exactly like one to an entity that does not exist', () => {
  const graph = fixture();
  const refusals = [
    [{ project: 'alpha' }, 'alpha-decision', 'beta-attempt'],
    [{ project: 'alpha' }, 'beta-decision', 'alpha-attempt'],
    [{ project: 'alpha' }, 'alpha-decision', 'default-decision'],
    [{ project: 'alpha' }, 'alpha-decision', 'legacy-default-decision'],
    [{ project: 'alpha' }, 'alpha-decision', 'legacy-projectless-decision'],
    [{ project: 'alpha' }, 'alpha-decision', 'origin-a-decision'],
    [{ project: 'alpha', originId: 'origin_a' }, 'alpha-decision', 'origin-a-decision'],
    [{ originId: 'origin_a' }, 'origin-a-decision', 'alpha-decision'],
    [{ originId: 'origin_a' }, 'origin-a-decision', 'origin-b-decision'],
    [{ project: 'default' }, 'default-decision', 'legacy-default-decision'],
    [{ project: 'beta' }, 'beta-decision', 'alpha-alternative'],
    // A wider read never widens a write: nothing in the request can.
    [{ project: 'alpha', grantId: 'grant_synthetic', grant: { projects: ['beta'] } }, 'alpha-decision', 'beta-attempt']
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
  assert.throws(() => graph.link({ from: 'alpha-decision', to: 'alpha-attempt', relation: 'related' }), (error) => error.code === 'write_scope_unresolved');
  assert.deepEqual(privilegedSnapshot(graph), before, 'no refused link wrote anything');
});

test('relations written before this rule are kept, and scoped reads do not cross them', () => {
  const graph = fixture();
  const ids = (snapshot) => snapshot.relations.map((relation) => relation.id).sort();
  const before = ids(privilegedSnapshot(graph));
  for (const id of ['relation-alpha-beta', 'relation-beta-alpha-far', 'relation-alpha-default', 'relation-alpha-legacy', 'relation-alpha-projectless', 'relation-alpha-origin', 'relation-origin-a-b']) {
    assert.ok(before.includes(id), id);
  }
  graph.traverse({ id: 'alpha-decision', project: 'alpha', depth: 10 });
  graph.link({ project: 'alpha', from: 'alpha-decision', to: 'alpha-fact', relation: 'depends_on' });
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
  assert.deepEqual(retrieved.items.filter((item) => item.matchedBy === 'graph').map((item) => item.record.id).sort(), ['alpha-attempt', 'alpha-fact', 'alpha-memory']);
  assertNamesNone(retrieved, HIDDEN_FROM_ALPHA, 'retrieve');
  const recalled = graph.recall('', { project: 'alpha', focalId: 'alpha-decision' });
  assert.deepEqual(recalled.items.filter((item) => item.ranks.graph !== null).map((item) => item.record.id).sort(), ['alpha-attempt', 'alpha-fact', 'alpha-memory']);
  assertNamesNone(recalled, HIDDEN_FROM_ALPHA, 'recall');
  const focus = (focalId) => graph.recall('', { project: 'alpha', focalId });
  for (const hidden of ['beta-attempt', 'default-decision', 'legacy-default-decision', 'origin-a-decision']) {
    assert.deepEqual(focus(hidden), focus(ABSENT), `a focus on ${hidden} is answered like an absent one`);
  }
  assert.deepEqual(graph.retrieve('MARKER', {}).items, []);
  assert.deepEqual(graph.recall('', {}).items, []);
});

test('no result computed under one boundary is reused under another', () => {
  // By-id reads, traversals and graph expansions under every boundary,
  // interleaved on one graph: each must equal the same call on a fresh graph.
  const calls = [
    ['traverse', { id: 'alpha-decision', project: 'alpha', depth: 10 }],
    ['traverse', { id: 'alpha-decision', project: 'beta', depth: 10 }],
    ['traverse', { id: 'alpha-decision', depth: 10 }],
    ['traverse', { id: 'origin-a-decision', originId: 'origin_a', depth: 10 }],
    ['traverse', { id: 'origin-a-decision', originId: 'origin_b', depth: 10 }],
    ['traverse', { id: 'beta-attempt', project: 'beta', depth: 10 }],
    ['traverse', { id: 'beta-attempt', project: 'alpha', depth: 10 }],
    ['retrieve', 'MARKER', { project: 'alpha' }],
    ['retrieve', 'MARKER', { project: 'beta' }],
    ['retrieve', 'MARKER', { originId: 'origin_a' }],
    ['recall', '', { project: 'alpha', focalId: 'alpha-decision' }],
    ['recall', '', { project: 'beta', focalId: 'alpha-decision' }],
    ['recall', '', { originId: 'origin_b', focalId: 'origin-a-decision' }]
  ];
  const run = (graph, [name, ...args]) => graph[name](...args);
  const shared = fixture();
  for (const call of [...calls, ...[...calls].reverse(), ...calls]) assert.deepEqual(run(shared, call), run(fixture(), call), JSON.stringify(call));
});

test('the by-id chokepoint and its raw lookup are not public', () => {
  const graph = fixture();
  for (const name of ['entity', 'rawEntity']) {
    assert.equal(Object.hasOwn(graph, name), false, `graph.${name}`);
    assert.equal(Object.hasOwn(kernel, name), false, `module export ${name}`);
  }
});
