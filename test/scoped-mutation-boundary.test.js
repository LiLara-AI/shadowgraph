import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { createStorage } from '../src/storage.js';
import { privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// PR-10 (P1 findings F-30, F-06 and F-31): a change to an existing entity is a
// WRITE, and its boundary is the write's own project or origin alone. A
// mutation named by id may modify only an entity that boundary owns. Another
// project's id, legacy data, another origin's entity and an id that exists
// nowhere are refused alike, so the answer cannot tell them apart; with
// neither a project nor an origin nothing is resolved at all. review,
// reconsider and maintain evaluate and change only what the request's scope
// owns, and with no scope they evaluate and change nothing. Every fixture is
// synthetic.

const NOW = '2026-01-01T00:00:00.000Z';
const now = () => NOW;
const PAST = '2025-01-01T00:00:00.000Z';
const OBSERVED = '2024-01-01T00:00:00.000Z';

function legacyPayload() {
  const writer = createShadowGraph({ now });
  writer.addDecision({ project: 'default', id: 'legacy-dflt-decision', title: 'Legacy decision', chosen: 'x', reviewAfter: PAST });
  writer.addFact({ project: 'default', id: 'legacy-dflt-fact', key: 'ttl', value: 1, observedAt: OBSERVED, expiresAt: PAST });
  const payload = privilegedSnapshot(writer);
  payload.schemaVersion = 5;
  for (const entity of [...payload.records, ...payload.facts, ...payload.journal.map((entry) => entry.payload)]) {
    if (!entity || typeof entity !== 'object') continue;
    delete entity.attribution;
    delete entity.originId;
    if (entity.schemaVersion === 6) entity.schemaVersion = 5;
  }
  for (const entry of payload.journal) entry.schemaVersion = 5;
  return payload;
}

// Every owner holds a decision that is due for review, a replacement decision
// and a fact that has expired; alpha and the real "default" also hold an
// open review signal.
function fixture() {
  const graph = createShadowGraph({ now, verifier: { verify: async () => ({ verifierIdentity: 'test' }), validateStored: () => true } });
  graph.importData(legacyPayload());
  for (const [owner, prefix] of [[{ project: 'alpha' }, 'alpha'], [{ project: 'beta' }, 'beta'], [{ project: 'default' }, 'real-dflt'], [{ originId: 'origin_a' }, 'origin-a'], [{ originId: 'origin_b' }, 'origin-b']]) {
    graph.addDecision({ ...owner, id: `${prefix}-decision`, title: `${prefix} decision`, chosen: 'x', reviewAfter: PAST });
    graph.addDecision({ ...owner, id: `${prefix}-replacement`, title: `${prefix} replacement`, chosen: 'y' });
    graph.addFact({ ...owner, id: `${prefix}-fact`, key: 'ttl', value: 1, observedAt: OBSERVED, expiresAt: PAST });
  }
  graph.review({ project: 'alpha' }).items;
  graph.review({ project: 'default' }).items;
  return graph;
}

const signalOf = (graph, decisionId) => privilegedSnapshot(graph).reviewSignals.find((signal) => signal.decisionId === decisionId).id;

// Each by-id mutation, called for `scope` on the entity `prefix` owns (or on an
// id that exists nowhere).
const MUTATIONS = {
  setOutcome: (graph, scope, prefix) => graph.setOutcome(`${prefix}-decision`, { status: 'failed' }, scope),
  updateDecisionStatus: (graph, scope, prefix) => graph.updateDecisionStatus(`${prefix}-decision`, 'planned', scope),
  addConfidenceEvidence: (graph, scope, prefix) => graph.addConfidenceEvidence({ ...scope, decisionId: `${prefix}-decision`, reason: 'benchmark', key: 'k1' }),
  supersedeDecision: (graph, scope, prefix) => graph.supersedeDecision({ ...scope, decisionId: `${prefix}-decision`, replacementId: `${prefix}-replacement` }),
  verifyFact: (graph, scope, prefix) => graph.verifyFact({ ...scope, factId: `${prefix}-fact`, evidencePath: 'evidence.json' }),
  acknowledgeReview: (graph, scope, prefix) => graph.acknowledgeReview(prefix === 'absent' ? 'review_absent' : signalOf(graph, `${prefix}-decision`), scope)
};

async function outcome(run) {
  try { await run(); return 'changed'; }
  catch (error) { return `${error.code ?? ''}|${error.message}`; }
}

test('a by-id mutation changes only what its own project or origin owns', async () => {
  // [scope, entity it may change, entities it may not]
  const cases = [
    [{ project: 'alpha' }, 'alpha', ['beta', 'real-dflt', 'legacy-dflt', 'origin-a']],
    [{ project: 'beta' }, 'beta', ['alpha']],
    [{ project: 'default' }, 'real-dflt', ['legacy-dflt', 'alpha']],
    [{ originId: 'origin_a' }, 'origin-a', ['origin-b', 'alpha', 'legacy-dflt']],
    [{ originId: 'origin_b' }, 'origin-b', ['origin-a']]
  ];
  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    for (const [scope, own, others] of cases) {
      if (name === 'acknowledgeReview' && !['alpha', 'real-dflt'].includes(own)) continue;
      const graph = fixture();
      const absent = await outcome(() => mutate(graph, scope, 'absent'));
      assert.notEqual(absent, 'changed', `${name} ${JSON.stringify(scope)} absent`);
      for (const other of others) {
        if (name === 'acknowledgeReview' && !['alpha', 'real-dflt'].includes(other)) continue;
        const before = JSON.stringify(privilegedSnapshot(graph));
        assert.equal(await outcome(() => mutate(graph, scope, other)), absent, `${name} ${JSON.stringify(scope)} on ${other} answers as for an absent id`);
        assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, `${name} ${JSON.stringify(scope)} changed nothing of ${other}`);
      }
      assert.equal(await outcome(() => mutate(graph, scope, own)), 'changed', `${name} ${JSON.stringify(scope)} on its own ${own}`);
    }
  }
});

test('a by-id mutation with neither a project nor an origin resolves no id at all', async () => {
  for (const [name, mutate] of Object.entries(MUTATIONS)) {
    const graph = fixture();
    const before = JSON.stringify(privilegedSnapshot(graph));
    const existing = await outcome(() => mutate(graph, {}, 'alpha'));
    assert.match(existing, /^write_scope_unresolved\|/, name);
    assert.equal(await outcome(() => mutate(graph, {}, 'absent')), existing, `${name}: existing and absent ids are refused alike`);
    assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, `${name} changed nothing`);
  }
});

test('supersession no longer tells another project\'s decision from a missing one', () => {
  const graph = fixture();
  const refusal = (replacementId) => { try { graph.supersedeDecision({ project: 'alpha', decisionId: 'alpha-decision', replacementId }); return null; } catch (error) { return error.message; } };
  assert.equal(refusal('beta-replacement'), refusal('replacement-absent'));
  assert.doesNotMatch(refusal('beta-replacement'), /same project/);
});

test('HTTP answers an out-of-scope id exactly as an absent one', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-mutation-http-');
  const file = join(directory, 'data.json');
  await (await createStorage({ type: 'json', file })).save(privilegedSnapshot(fixture()));
  const app = await createShadowGraphServer({ file, now });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body) => { const response = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); return `${response.status} ${await response.text()}`; };
  // Routes that forward the request body carry the scope through.
  for (const [path, body] of [
    ['/supersede', (id) => ({ project: 'alpha', decisionId: id, replacementId: 'alpha-replacement' })],
    ['/confidence-evidence', (id) => ({ project: 'alpha', decisionId: id, reason: 'r', key: 'k' })],
    ['/reconsider', (id) => ({ project: 'alpha', decisionId: id })]
  ]) {
    assert.equal(await post(path, body('beta-decision')), await post(path, body('decision-absent')), path);
  }
  // Routes that pass only the id carry no scope until the transport is aligned
  // (PR-13): they are refused, alike for every id.
  for (const [path, body] of [
    ['/outcomes', (id) => ({ decisionId: id, outcome: { status: 'failed' } })],
    ['/status', (id) => ({ decisionId: id, status: 'planned' })],
    ['/review-signals/ack', (id) => ({ id })]
  ]) {
    const existing = await post(path, body(path === '/review-signals/ack' ? signalOf(app.graph, 'alpha-decision') : 'alpha-decision'));
    assert.match(existing, /^400 .*write_scope_unresolved/, path);
    assert.equal(await post(path, body('absent')), existing, path);
  }
});

test('reconsider answers another project\'s decision exactly as a missing one', () => {
  const graph = fixture();
  const refusal = (input) => { try { graph.reconsider(input); return null; } catch (error) { return error.message; } };
  const before = privilegedSnapshot(graph).reviewSignals.length;
  assert.equal(refusal({ project: 'alpha', decisionId: 'beta-decision' }), 'Decision not found');
  assert.equal(refusal({ project: 'alpha', decisionId: 'decision-absent' }), 'Decision not found');
  assert.equal(refusal({ project: 'default', decisionId: 'legacy-dflt-decision' }), 'Decision not found');
  assert.equal(refusal({ originId: 'origin_b', decisionId: 'origin-a-decision' }), 'Decision not found');
  assert.equal(refusal({ decisionId: 'alpha-decision' }), 'Decision not found', 'no scope addresses no decision');
  assert.equal(privilegedSnapshot(graph).reviewSignals.length, before, 'no signal was raised for another owner');
  assert.equal(graph.reconsider({ project: 'beta', decisionId: 'beta-decision' }).decisions[0].decisionId, 'beta-decision');
});

test('review, reconsider and maintain with no scope evaluate and change nothing', () => {
  const graph = fixture();
  const before = JSON.stringify(privilegedSnapshot(graph));
  assert.deepEqual(graph.review({}).items, []);
  const reconsidered = graph.reconsider({});
  assert.deepEqual(reconsidered.decisions, []);
  assert.equal(reconsidered.limitation?.code, 'scoped_coverage');
  assert.notEqual(reconsidered.verdict, 'unchanged', 'nothing evaluated never reads as "checked, and fine"');
  const maintained = graph.maintain({ now: NOW });
  assert.deepEqual([maintained.staleDecisionIds, maintained.reviewSignals, maintained.due], [[], [], []]);
  assert.equal(maintained.limitation?.code, 'scoped_coverage');
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
});

test('review, reconsider and maintain evaluate and change only their own scope', () => {
  const graph = fixture();
  assert.deepEqual(graph.review({ project: 'beta' }).items.map((item) => item.decisionId), ['beta-decision']);
  assert.deepEqual(graph.review({ project: 'default' }).items.map((item) => item.decisionId), ['real-dflt-decision'], 'legacy "default" is not the real project');
  assert.deepEqual(graph.review({ originId: 'origin_a' }).items.map((item) => item.decisionId), ['origin-a-decision']);
  assert.deepEqual(graph.reconsider({ project: 'alpha' }).decisions.map((item) => item.decisionId).sort(), ['alpha-decision', 'alpha-replacement']);
  const maintained = graph.maintain({ project: 'alpha', now: NOW });
  assert.deepEqual(maintained.staleDecisionIds, ['alpha-decision']);
  assert.deepEqual([...new Set(maintained.reviewSignals.map((signal) => signal.decisionId))], ['alpha-decision']);
  const status = (id) => { const stored = privilegedSnapshot(graph); return [...stored.records, ...stored.facts].find((entity) => entity.id === id).status; };
  assert.equal(status('alpha-decision'), 'stale');
  assert.equal(status('alpha-fact'), 'expired');
  for (const id of ['beta-decision', 'real-dflt-decision', 'legacy-dflt-decision', 'origin-a-decision']) assert.notEqual(status(id), 'stale', id);
  for (const id of ['beta-fact', 'real-dflt-fact', 'legacy-dflt-fact', 'origin-a-fact']) assert.equal(status(id), 'active', id);
  assert.deepEqual(graph.maintain({ project: 'default', now: NOW }).staleDecisionIds, ['real-dflt-decision'], 'maintaining the real "default" leaves legacy data alone');
  assert.notEqual(status('legacy-dflt-decision'), 'stale');
});

// A store written before PR-10 by a build that chose review evidence by
// project label (fbba512 and earlier): a real "default" decision's signal cites
// a legacy "default" fact -- as its evidence, or among its conflicting
// evidence -- and origin_a's decision's signal cites origin_b's fact, because
// both origins' labels were empty. The correction package reproduces exactly
// this across the real builds (v0.41.0, then fbba512, then this one). Here
// every fact is written by the owner the history left it with, the signals are
// raised by this kernel's own review while those ids were in scope, and the
// store is admitted through importData. Only the conflicting reference, which
// this kernel can no longer produce, is appended as that build recorded it.
const reopen = (id, key, value) => [{ id, label: `${key} alternative`, reasonRejected: 'r', reopenWhen: [{ key, operator: 'greater_than', value }] }];
const DECISIONS = [
  [{ project: 'default' }, 'real-dflt-lag', reopen('alt-lag', 'lag', 5)],
  [{ project: 'default' }, 'real-dflt-load', reopen('alt-load', 'load', 50)],
  [{ originId: 'origin_a' }, 'origin-a-depth', reopen('alt-depth', 'depth', 5)]
];
const HIDDEN = ['legacy-lag-fact', 'legacy-load-fact', 'origin-b-depth-fact'];

function labelMatchedHistory() {
  const history = createShadowGraph({ now });
  for (const [owner, id, alternatives] of DECISIONS) history.addDecision({ ...owner, id, title: id, chosen: 'x', alternatives });
  history.addFact({ project: 'default', id: 'legacy-lag-fact', key: 'lag', value: 9, observedAt: OBSERVED });
  history.addFact({ project: 'default', id: 'real-dflt-load-fact', key: 'load', value: 90, observedAt: NOW });
  history.addFact({ originId: 'origin_a', id: 'origin-b-depth-fact', key: 'depth', value: 9, observedAt: NOW });
  history.review({ project: 'default' }).items;
  history.review({ originId: 'origin_a' }).items;
  const signals = privilegedSnapshot(history).reviewSignals;

  const legacy = createShadowGraph({ now });
  legacy.addFact({ project: 'default', id: 'legacy-lag-fact', key: 'lag', value: 9, observedAt: OBSERVED });
  legacy.addFact({ project: 'default', id: 'legacy-load-fact', key: 'load', value: 1, observedAt: OBSERVED });
  const legacyPayload = privilegedSnapshot(legacy);
  legacyPayload.schemaVersion = 5;
  for (const entity of [...legacyPayload.facts, ...legacyPayload.journal.map((entry) => entry.payload)]) {
    delete entity.attribution;
    delete entity.originId;
    entity.schemaVersion = 5;
  }
  for (const entry of legacyPayload.journal) entry.schemaVersion = 5;

  const store = createShadowGraph({ now });
  store.importData(legacyPayload);
  for (const [owner, id, alternatives] of DECISIONS) store.addDecision({ ...owner, id, title: id, chosen: 'x', alternatives });
  store.addFact({ project: 'default', id: 'real-dflt-load-fact', key: 'load', value: 90, observedAt: NOW });
  store.addFact({ originId: 'origin_b', id: 'origin-b-depth-fact', key: 'depth', value: 9, observedAt: NOW });
  const payload = privilegedSnapshot(store);
  const reference = (id) => { const { value, observedAt, temporal, sourceClass, verificationStatus } = payload.facts.find((fact) => fact.id === id); return { factId: id, value, observedAt, validFrom: temporal?.validFrom ?? observedAt, sourceClass, verificationStatus }; };
  signals.find((signal) => signal.decisionId === 'real-dflt-load').violatedConditions[0].conflictingEvidence = [reference('real-dflt-load-fact'), reference('legacy-load-fact')];
  payload.reviewSignals = signals;
  const graph = createShadowGraph({ now });
  graph.importData(payload);
  return graph;
}

const storedSignal = (graph, decisionId) => privilegedSnapshot(graph).reviewSignals.find((signal) => signal.decisionId === decisionId);

test('PR-11 historical signal reads expose only owner identity and lifecycle with partial coverage', () => {
  const graph = labelMatchedHistory();
  const before = JSON.stringify(privilegedSnapshot(graph));
  for (const [owner, decisionId] of DECISIONS) {
    const signal = storedSignal(graph, decisionId);
    const response = JSON.parse(JSON.stringify(graph.getReviewSignals({ ...owner, status: 'open' })));
    const item = response.items?.find((candidate) => candidate.id === signal.id);
    assert.ok(item, `${decisionId}: the owner's stored signal must not look absent`);
    assert.deepEqual(Object.keys(item).sort(), ['createdAt', 'decisionId', 'id', 'kind', 'limitation', 'status']);
    assert.equal(item.limitation.code, 'scoped_coverage');
    assert.equal(response.completeness.complete, false);
    assert.equal(response.completeness.losslessItems, false);
    assert.equal(response.completeness.limitation.code, 'scoped_coverage');
    assert.deepEqual(HIDDEN.filter((id) => JSON.stringify(response).includes(id)), []);
    assert.equal(response.completeness.total, owner.project ? 2 : 1, 'only owner signals counted');
    for (const read of ['exportData', 'redact', 'stats']) {
      const view = JSON.parse(JSON.stringify(graph[read](owner)));
      assert.equal(view.completeness.complete, false, read);
      assert.deepEqual(HIDDEN.filter((id) => JSON.stringify(view).includes(id)), [], read);
      if (Array.isArray(view.reviewSignals)) assert.deepEqual(view.reviewSignals.find((s) => s.id === signal.id), item, read);
    }
    assert.deepEqual(graph.getReviewSignals({ ...owner, status: 'acknowledged' }).items, []);
    item.status = 'changed by caller';
  }
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before, 'coverage adds no writes or historical reassessment');
  assert.deepEqual(graph.getReviewSignals({ project: 'alpha' }).items, []);
  assert.equal(graph.getReviewSignals({ project: 'alpha' }).completeness.complete, true, 'no other owner omission notice');
});

test('PR-11 all-in-scope signal reads remain full and status filtering does not inherit omitted detail', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', id: 'alpha-signal', title: 'alpha', chosen: 'x', alternatives: reopen('alpha-alt', 'lag', 5) });
  graph.addFact({ project: 'alpha', key: 'lag', value: 9, observedAt: NOW });
  graph.review({ project: 'alpha' });
  const signal = storedSignal(graph, 'alpha-signal');
  const response = JSON.parse(JSON.stringify(graph.getReviewSignals({ project: 'alpha' })));
  assert.deepEqual(response.items, [signal]);
  assert.equal(response.completeness.complete, true);
  assert.equal(response.completeness.losslessItems, true);
  graph.acknowledgeReview(signal.id, { project: 'alpha' });
  assert.deepEqual(graph.getReviewSignals({ project: 'alpha', status: 'open' }).items, []);
  assert.equal(graph.getReviewSignals({ project: 'alpha', status: 'open' }).completeness.complete, true);
  assert.equal(graph.getReviewSignals({ project: 'alpha', status: 'acknowledged' }).items[0].id, signal.id);
});

test('acknowledging a signal an earlier build raised on hidden facts discloses none of them', () => {
  const graph = labelMatchedHistory();
  assert.equal(privilegedValidate(graph).valid, true, 'the store is admitted as a valid store');
  for (const [, decisionId] of DECISIONS) assert.ok(storedSignal(graph, decisionId).violatedConditions.some((condition) => HIDDEN.includes(condition.evidence?.factId) || (condition.conflictingEvidence ?? []).some((item) => HIDDEN.includes(item.factId))), `${decisionId} cites a hidden fact`);
  // review() names the load signal to its owner (identity is the rule, not the
  // fact), so the owner must be able to close it.
  const loadSignal = storedSignal(graph, 'real-dflt-load');
  assert.equal(graph.review({ project: 'default' }).items.find((item) => item.decisionId === 'real-dflt-load')?.reviewSignalId, loadSignal.id);

  for (const [owner, decisionId] of DECISIONS) {
    const signal = storedSignal(graph, decisionId);
    const history = JSON.stringify(signal.violatedConditions);
    assert.equal(graph.getReviewSignals(owner).items.find((item) => item.id === signal.id)?.limitation.code, 'scoped_coverage', `${decisionId}: the read view withholds detail explicitly`);
    const answer = graph.acknowledgeReview(signal.id, owner);
    assert.deepEqual(HIDDEN.filter((id) => JSON.stringify(answer).includes(id)), [], `${decisionId}: the answer names no hidden fact`);
    assert.equal(Object.hasOwn(answer, 'violatedConditions'), false, `${decisionId}: no evidence the caller may not read`);
    assert.equal(answer.limitation?.code, 'scoped_coverage');
    assert.deepEqual([answer.id, answer.decisionId, answer.kind, answer.status], [signal.id, decisionId, 'review', 'acknowledged']);
    for (const key of ['reason', 'alternativesToReconsider', 'createdAt', 'acknowledgedAt']) assert.ok(Object.hasOwn(answer, key), `${decisionId}: ${key}`);
    const stored = storedSignal(graph, decisionId);
    assert.equal(stored.status, 'acknowledged');
    assert.equal(JSON.stringify(stored.violatedConditions), history, `${decisionId}: the recorded evidence is kept`);
    const again = graph.acknowledgeReview(signal.id, owner);
    assert.deepEqual(Object.keys(again).sort(), Object.keys(answer).sort(), `${decisionId}: a repeat answers the same way`);
    assert.throws(() => graph.acknowledgeReview(signal.id, { project: 'alpha' }), { message: 'Review signal not found' });
    assert.throws(() => graph.acknowledgeReview('review_absent', owner), { message: 'Review signal not found' });
    assert.throws(() => graph.acknowledgeReview(signal.id, {}), { code: 'write_scope_unresolved' });
  }
  assert.equal(graph.review({ project: 'default' }).items.find((item) => item.decisionId === 'real-dflt-load').reviewSignalStatus, 'acknowledged');
});

test('acknowledging a signal whose evidence is all in scope returns the whole signal', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', id: 'alpha-lag', title: 'alpha-lag', chosen: 'x', alternatives: reopen('alt-alpha', 'lag', 5) });
  graph.addFact({ project: 'alpha', id: 'alpha-lag-fact', key: 'lag', value: 9, observedAt: NOW });
  graph.review({ project: 'alpha' }).items;
  const signal = storedSignal(graph, 'alpha-lag');
  const answer = graph.acknowledgeReview(signal.id, { project: 'alpha' });
  assert.deepEqual(answer, storedSignal(graph, 'alpha-lag'));
  assert.equal(answer.violatedConditions[0].evidence.factId, 'alpha-lag-fact');
  assert.equal(Object.hasOwn(answer, 'limitation'), false);
});
