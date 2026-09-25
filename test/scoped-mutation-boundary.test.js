import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { createStorage } from '../src/storage.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
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
  graph.review({ project: 'alpha' });
  graph.review({ project: 'default' });
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
  assert.deepEqual(graph.review({}), []);
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
  assert.deepEqual(graph.review({ project: 'beta' }).map((item) => item.decisionId), ['beta-decision']);
  assert.deepEqual(graph.review({ project: 'default' }).map((item) => item.decisionId), ['real-dflt-decision'], 'legacy "default" is not the real project');
  assert.deepEqual(graph.review({ originId: 'origin_a' }).map((item) => item.decisionId), ['origin-a-decision']);
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
