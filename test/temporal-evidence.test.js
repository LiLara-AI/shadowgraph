import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

// Plan v1.4.4 §17.5 (AC-016, AC-029, AC-030, AC-032; PC-11, PC-12; PR-29): each
// record the relevance path delivers carries what its stored times and
// supersession support saying about when it held and whether it holds at the
// read's instant. Presentation only: nothing is written, no status changes, and
// when only the recording order tells two versions apart the conflict is
// unresolved on both sides.
const NOW = '2026-03-01T00:00:00.000Z';
const graphAt = () => createShadowGraph({ now: () => NOW });
function clocked(start) {
  let clock = start;
  return { graph: createShadowGraph({ now: () => clock }), set: (value) => { clock = value; } };
}
const read = (graph, input, project = 'alpha') => graph.context({ project, ...input }).relevant;
const idOf = (item) => (item.tier === 'T1' ? item.line.recordId : item.record.id);
const itemOf = (block, id) => block.items.find((item) => idOf(item) === id);
const stateOf = (block, id) => itemOf(block, id).temporalEvidence.currentState;
const state = (value, basis, evidence = [], evidenceOmitted = 0) => ({ state: value, basis, evidence, evidenceOmitted });

test('AC-016: an event time stored apart from the recording time is shown, and as-of selection follows it', () => {
  const graph = graphAt();
  const fact = graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west', observedAt: '2025-06-01T00:00:00.000Z' });
  assert.deepEqual(itemOf(read(graph, { query: 'region' }), fact.id).temporalEvidence, {
    recordedAt: NOW, eventTime: { at: '2025-06-01T00:00:00.000Z', state: 'known' }, currentState: state('current', 'validity_window')
  });
  assert.equal(itemOf(read(graph, { query: 'region', asOf: '2025-01-01T00:00:00.000Z' }), fact.id), undefined, 'before the event it did not hold');
  assert.ok(itemOf(read(graph, { query: 'region', asOf: '2025-07-01T00:00:00.000Z' }), fact.id), 'after the event it held, though it was recorded later');
  // An observation time apart from the recording is an event time even when the validity start was given as the recording time.
  const observed = graph.addFact({ project: 'alpha', key: 'build', value: 'green', observedAt: '2025-06-01T00:00:00.000Z', validFrom: NOW });
  assert.deepEqual(itemOf(read(graph, { query: 'build' }), observed.id).temporalEvidence.eventTime, { at: '2025-06-01T00:00:00.000Z', state: 'known' });
  // Its validity start is still only the recording time, so before it the placement is undetermined.
  const { graph: later, set } = clocked('2026-01-10T00:00:00.000Z');
  const build = later.addFact({ project: 'alpha', key: 'build', value: 'green', observedAt: '2025-06-01T00:00:00.000Z', validFrom: '2026-01-10T00:00:00.000Z', expiresAt: '2026-01-20T00:00:00.000Z' });
  set(NOW);
  later.maintain({ project: 'alpha' });
  assert.deepEqual(stateOf(read(later, { query: 'zebra', asOf: '2025-07-01T00:00:00.000Z' }), build.id), state('undetermined', null));
});

test('an event time the write did not give apart is unknown, and the head counts the records so placed', () => {
  const graph = graphAt();
  const fact = graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west' });
  const decision = graph.addDecision({ project: 'alpha', title: 'region failover plan', chosen: 'active-passive' });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 'region failover drill', result: 'failed: dns cache', resultClass: 'failed' });
  const block = read(graph, { query: 'region' });
  for (const record of [fact, decision, attempt]) assert.deepEqual(itemOf(block, record.id).temporalEvidence.eventTime, { at: null, state: 'unknown' }, record.kind);
  assert.equal(stateOf(block, attempt.id), null, 'an attempt is an event, not a state');
  assert.deepEqual(block.temporal, { asOf: null, eventTimeUnknown: 3, recordingOrderOnly: 0 });
  assert.equal(read(graph, { query: 'region', asOf: '2026-02-01T00:00:00.000Z' }).temporal.asOf, '2026-02-01T00:00:00.000Z');
});

test('recording order only: of two same-key facts with no event times, both sides are unresolved', () => {
  const graph = graphAt();
  const first = graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west' });
  const second = graph.addFact({ project: 'alpha', key: 'region', value: 'us-east' });
  const block = read(graph, { query: 'region', compact: true });
  assert.deepEqual(block.items.map(idOf), [second.id], 'as of now only the later version holds a window');
  assert.deepEqual(stateOf(block, second.id), state('unresolved', 'recording_order_only', [first.id]));
  assert.equal(block.temporal.recordingOrderOnly, 1, 'the head declares it');
  // The earlier version, which the fallback delivers among the stale assumptions.
  assert.deepEqual(stateOf(read(graph, { query: 'zebra' }), first.id), state('unresolved', 'recording_order_only', [second.id]));
  // Expansion agrees: the pair is left unresolved, both positions delivered.
  const { recordId, digest, derivationVersion, derivedAt } = block.items[0].line.expansion;
  const [pair] = graph.expand({ recordId, digest, derivationVersion, derivedAt, project: 'alpha' }).investigation.pairs;
  assert.deepEqual([pair.recordId, pair.state, pair.basis], [first.id, 'unresolved', []]);
  assert.equal(privilegedSnapshot(graph).facts.find((fact) => fact.id === first.id).status, 'superseded', 'canonical status is untouched');
});

test('an equal event time is recording order too; a later known one decides by the validity window', () => {
  const graph = graphAt();
  const tied = graph.addFact({ project: 'alpha', key: 'zone', value: 'a', validFrom: '2025-01-01T00:00:00.000Z' });
  const tie = graph.addFact({ project: 'alpha', key: 'zone', value: 'b', validFrom: '2025-01-01T00:00:00.000Z' });
  assert.deepEqual(stateOf(read(graph, { query: 'zone' }), tie.id), state('unresolved', 'recording_order_only', [tied.id]));

  const earlier = graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west', validFrom: '2025-01-01T00:00:00.000Z' });
  const later = graph.addFact({ project: 'alpha', key: 'region', value: 'us-east', validFrom: '2025-06-01T00:00:00.000Z' });
  assert.deepEqual(stateOf(read(graph, { query: 'region' }), later.id), state('current', 'validity_window', [earlier.id]));
  const then = read(graph, { query: 'region', asOf: '2025-03-01T00:00:00.000Z' });
  assert.deepEqual(stateOf(then, earlier.id), state('current', 'validity_window'), 'as of then, the successor had not begun');
  assert.equal(itemOf(then, later.id), undefined);
  // The superseded version the fallback delivers is historical once its successor began, and not yet valid before its own start.
  assert.deepEqual(stateOf(read(graph, { query: 'zebra' }), earlier.id), state('historical', 'validity_window', [later.id]));
  assert.deepEqual(stateOf(read(graph, { query: 'zebra', asOf: '2025-06-01T00:00:00.000Z' }), earlier.id), state('historical', 'validity_window', [later.id]), 'the successor began at that very instant');
  assert.deepEqual(stateOf(read(graph, { query: 'zebra', asOf: '2024-06-01T00:00:00.000Z' }), earlier.id), state('not_yet_valid', 'validity_window'));
  graph.addFact({ project: 'alpha', key: 'region', value: 'ap-south', validFrom: '2025-09-01T00:00:00.000Z' });
  assert.deepEqual(stateOf(read(graph, { query: 'zebra', asOf: '2025-03-01T00:00:00.000Z' }), later.id), state('not_yet_valid', 'validity_window', [earlier.id]), 'a version not yet valid names the one it followed');
  // An unknown earlier event time leaves recording order even beside a known later one.
  const unknown = graph.addFact({ project: 'alpha', key: 'rack', value: 'r1' });
  const known = graph.addFact({ project: 'alpha', key: 'rack', value: 'r2', validFrom: '2026-06-01T00:00:00.000Z' });
  assert.deepEqual(stateOf(read(graph, { query: 'rack', asOf: '2026-07-01T00:00:00.000Z' }), known.id), state('unresolved', 'recording_order_only', [unknown.id]));
});

test('as of an instant, a successor of unknown event time leaves the earlier version unresolved, not current', () => {
  const { graph, set } = clocked('2026-01-01T00:00:00.000Z');
  const a = graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west' });
  set('2026-02-01T00:00:00.000Z');
  const b = graph.addFact({ project: 'alpha', key: 'region', value: 'us-east' });
  assert.deepEqual(stateOf(read(graph, { query: 'region', asOf: '2026-01-15T00:00:00.000Z' }), a.id), state('unresolved', 'recording_order_only', [b.id]));
  const owner = clocked('2025-01-01T00:00:00.000Z');
  const teamA = owner.graph.addFact({ project: 'alpha', key: 'owner', value: 'team-a', validFrom: '2024-06-01T00:00:00.000Z' });
  owner.set('2026-02-01T00:00:00.000Z');
  const teamB = owner.graph.addFact({ project: 'alpha', key: 'owner', value: 'team-b' });
  assert.deepEqual(stateOf(read(owner.graph, { query: 'owner', asOf: '2025-06-01T00:00:00.000Z' }), teamA.id), state('unresolved', 'recording_order_only', [teamB.id]));
});

const inIdOrder = (ids) => [...ids].sort((left, right) => left.localeCompare(right));

test('a version unresolved against its predecessor also names a successor recorded later', () => {
  const { graph, set } = clocked('2026-01-01T00:00:00.000Z');
  const a = graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west', validFrom: '2025-06-01T00:00:00.000Z' });
  const b = graph.addFact({ project: 'alpha', key: 'region', value: 'us-east', validFrom: '2025-06-01T00:00:00.000Z' });
  set('2026-01-02T00:00:00.000Z');
  const c = graph.addFact({ project: 'alpha', key: 'region', value: 'ap-south', validFrom: '2027-01-01T00:00:00.000Z' });
  assert.deepEqual(stateOf(read(graph, { query: 'region' }), b.id), state('unresolved', 'recording_order_only', [a.id, c.id]), 'the earlier versions, then the later');
});

test('an end the writer declared before the next version began decides, though no event time is known', () => {
  const { graph, set } = clocked('2026-01-01T00:00:00.000Z');
  const old = graph.addFact({ project: 'alpha', key: 'latency', value: '5ms', expiresAt: '2026-02-01T00:00:00.000Z' });
  set(NOW);
  const fresh = graph.addFact({ project: 'alpha', key: 'latency', value: '30ms' });
  const block = read(graph, { query: 'latency', compact: true });
  assert.deepEqual(stateOf(block, fresh.id), state('current', 'validity_window', [old.id]));
  const { recordId, digest, derivationVersion, derivedAt } = itemOf(block, fresh.id).line.expansion;
  const [pair] = graph.expand({ recordId, digest, derivationVersion, derivedAt, project: 'alpha' }).investigation.pairs;
  assert.deepEqual([pair.recordId, pair.state, pair.basis], [old.id, 'resolved', ['explicit_supersession', 'different_times']]);
});

test('a window a same-key write closed is no declared end, though migration records it as one; a declared one decides', () => {
  const graph = graphAt();
  graph.importData({ schemaVersion: 4, facts: [
    { id: 'reg-a', kind: 'fact', key: 'region', value: 'eu-west', project: 'alpha', status: 'superseded', supersededBy: 'reg-b', temporal: { validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z', recordedAt: '2026-01-01T00:00:00.000Z', invalidatedAt: null } },
    { id: 'reg-b', kind: 'fact', key: 'region', value: 'us-east', project: 'alpha', status: 'active', temporal: { validFrom: '2026-02-01T00:00:00.000Z', validTo: null, recordedAt: '2026-02-01T00:00:00.000Z', invalidatedAt: null } }
  ] });
  const block = read(graph, { query: 'region', compact: true });
  assert.deepEqual(stateOf(block, 'reg-b'), state('unresolved', 'recording_order_only', ['reg-a']));
  assert.deepEqual(stateOf(read(graph, { query: 'zebra' }), 'reg-a'), state('unresolved', 'recording_order_only', ['reg-b']));
  const { recordId, digest, derivationVersion, derivedAt } = itemOf(block, 'reg-b').line.expansion;
  const [pair] = graph.expand({ recordId, digest, derivationVersion, derivedAt, project: 'alpha' }).investigation.pairs;
  assert.deepEqual([pair.recordId, pair.state, pair.basis], ['reg-a', 'unresolved', []]);
  // A declared expiry at the next start decides; a declared validity end only before it.
  const { graph: native, set } = clocked('2026-01-01T00:00:00.000Z');
  const expiring = native.addFact({ project: 'alpha', key: 'latency', value: '5ms', expiresAt: '2026-02-01T00:00:00.000Z' });
  const ending = native.addFact({ project: 'alpha', key: 'zone', value: 'z1', validTo: '2026-01-20T00:00:00.000Z' });
  const closing = native.addFact({ project: 'alpha', key: 'rack', value: 'r1', validTo: '2026-02-01T00:00:00.000Z' });
  set('2026-02-01T00:00:00.000Z');
  const latency = native.addFact({ project: 'alpha', key: 'latency', value: '30ms' });
  const zone = native.addFact({ project: 'alpha', key: 'zone', value: 'z2' });
  const rack = native.addFact({ project: 'alpha', key: 'rack', value: 'r2' });
  set(NOW);
  assert.deepEqual(stateOf(read(native, { query: 'latency' }), latency.id), state('current', 'validity_window', [expiring.id]));
  assert.deepEqual(stateOf(read(native, { query: 'zone' }), zone.id), state('current', 'validity_window', [ending.id]));
  assert.deepEqual(stateOf(read(native, { query: 'rack' }), rack.id), state('unresolved', 'recording_order_only', [closing.id]), 'an end at the next start is where a write would close it');
});

test('in a chain of versions only the recording order tells apart, expansion resolves no pair', () => {
  const { graph, set } = clocked('2026-01-01T00:00:00.000Z');
  graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west' });
  set('2026-02-01T00:00:00.000Z');
  graph.addFact({ project: 'alpha', key: 'region', value: 'us-east' });
  set(NOW);
  const last = graph.addFact({ project: 'alpha', key: 'region', value: 'ap-south' });
  const { recordId, digest, derivationVersion, derivedAt } = itemOf(read(graph, { query: 'region', compact: true }), last.id).line.expansion;
  const { pairs } = graph.expand({ recordId, digest, derivationVersion, derivedAt, project: 'alpha' }).investigation;
  assert.equal(pairs.length, 2);
  for (const pair of pairs) assert.deepEqual([pair.state, pair.basis], ['unresolved', []]);
});

test('a successor that has not begun leaves the version holding now current, whatever the recording order', () => {
  const graph = graphAt();
  const now = graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west', validFrom: '2025-01-01T00:00:00.000Z' });
  graph.addFact({ project: 'alpha', key: 'region', value: 'us-east', validFrom: '2027-01-01T00:00:00.000Z' });
  const block = read(graph, { query: 'region' });
  assert.deepEqual(block.items.map(idOf), [now.id]);
  assert.deepEqual(stateOf(block, now.id), state('current', 'validity_window'));
  assert.deepEqual(stateOf(block, now.id), stateOf(read(graph, { query: 'region', asOf: NOW }), now.id), 'no asOf reads at now');
});

test('a closed validity window is historical: an expiry passed, or a version ended within the read', () => {
  const { graph, set } = clocked('2026-01-10T00:00:00.000Z');
  const cert = graph.addFact({ project: 'alpha', key: 'token-ttl', value: '30m', expiresAt: '2026-01-20T00:00:00.000Z' });
  set(NOW);
  assert.deepEqual(stateOf(read(graph, { query: 'token-ttl' }), cert.id), state('historical', 'validity_window'), 'before maintain marks it');
  graph.maintain({ project: 'alpha' });
  assert.deepEqual(stateOf(read(graph, { query: 'zebra' }), cert.id), state('historical', 'validity_window'), 'and after, through the fallback');
  // A legacy superseded fact, read as of an instant inside its window, held then.
  graph.importData({ facts: [{ id: 'legacy-fact', key: 'region', value: 'eu', project: 'alpha', status: 'superseded', validTo: '2025-01-01T00:00:00.000Z' }] });
  assert.deepEqual(stateOf(read(graph, { query: 'region', asOf: '2024-06-01T00:00:00.000Z' }), 'legacy-fact'), state('current', 'validity_window'));
  // An expired status ends a version only when no end time is stored.
  const legacy = graphAt();
  legacy.importData({ facts: [
    { id: 'legacy-expired', key: 'badge', value: 'b', project: 'alpha', status: 'expired' },
    { id: 'legacy-superseded', key: 'shelf', value: 's', project: 'alpha', status: 'superseded' }
  ] });
  assert.deepEqual(stateOf(read(legacy, { query: 'zebra' }), 'legacy-expired'), state('historical', 'validity_window'));
  assert.deepEqual(stateOf(read(legacy, { query: 'zebra' }), 'legacy-superseded'), state('historical', null), 'superseded, with no window and no successor to decide');
});

test('an expired version read as of an instant inside its window held then; the window bounds are exact', () => {
  const { graph, set } = clocked('2026-01-01T00:00:00.000Z');
  const cert = graph.addFact({ project: 'alpha', key: 'tls-cert', value: 'v1', validFrom: '2025-12-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z' });
  set(NOW);
  graph.maintain({ project: 'alpha' });
  assert.deepEqual(stateOf(read(graph, { query: 'tls-cert', asOf: '2026-01-15T00:00:00.000Z' }), cert.id), state('current', 'validity_window'));
  assert.deepEqual(stateOf(read(graph, { query: 'zebra', asOf: '2026-02-01T00:00:00.000Z' }), cert.id), state('historical', 'validity_window'), 'at its end it no longer holds');
  assert.deepEqual(stateOf(read(graph, { query: 'tls-cert', asOf: '2025-12-01T00:00:00.000Z' }), cert.id), state('current', 'validity_window'), 'at its start it holds');
  // Before a start that is only its recording time, the placement is unknown.
  const { graph: unknown, set: move } = clocked('2026-01-10T00:00:00.000Z');
  const ttl = unknown.addFact({ project: 'alpha', key: 'token-ttl', value: '30m', expiresAt: '2026-01-20T00:00:00.000Z' });
  move(NOW);
  unknown.maintain({ project: 'alpha' });
  assert.deepEqual(stateOf(read(unknown, { query: 'zebra', asOf: '2025-06-01T00:00:00.000Z' }), ttl.id), state('undetermined', null));
});

test('a legacy fact reads its times as the as-of selection does', () => {
  const graph = graphAt();
  graph.importData({ facts: [
    { id: 'legacy-observed', key: 'zone', value: 'z1', project: 'alpha', status: 'active', observedAt: '2025-05-05T00:00:00.000Z' },
    { id: 'legacy-dated', kind: 'fact', key: 'rack', value: 'r', project: 'alpha', status: 'active', observedAt: '2024-03-01T00:00:00.000Z', validFrom: '2024-01-01T00:00:00.000Z', recordedAt: '2024-04-01T00:00:00.000Z' },
    { id: 'legacy-kindless', key: 'shelf', value: 's', project: 'alpha', observedAt: '2024-01-01T00:00:00.000Z', temporal: { validFrom: '2024-01-01T00:00:00.000Z', validTo: null, recordedAt: '2024-02-01T00:00:00.000Z', invalidatedAt: null } }
  ] });
  const observed = itemOf(read(graph, { query: 'zone' }), 'legacy-observed').temporalEvidence;
  assert.deepEqual([observed.recordedAt, observed.eventTime], ['2025-05-05T00:00:00.000Z', { at: null, state: 'unknown' }], 'an observation time with no other is the recording time');
  const dated = itemOf(read(graph, { query: 'rack', asOf: '2024-02-01T00:00:00.000Z' }), 'legacy-dated').temporalEvidence;
  assert.deepEqual([dated.recordedAt, dated.eventTime], ['2024-04-01T00:00:00.000Z', { at: '2024-01-01T00:00:00.000Z', state: 'known' }]);
  assert.deepEqual(itemOf(read(graph, { query: 'shelf' }), 'legacy-kindless').temporalEvidence.eventTime, { at: '2024-01-01T00:00:00.000Z', state: 'known' });
});

test('memories follow the same rules as facts', () => {
  const graph = graphAt();
  const first = graph.remember({ project: 'alpha', memoryType: 'preference', key: 'deploy-window', text: 'deploys on tuesday' }).memory;
  const second = graph.remember({ project: 'alpha', memoryType: 'preference', key: 'deploy-window', text: 'deploys on thursday' }).memory;
  assert.deepEqual(stateOf(read(graph, { query: 'deploys' }), second.id), state('unresolved', 'recording_order_only', [first.id]));
  const dated = graphAt();
  const before = dated.remember({ project: 'alpha', memoryType: 'preference', key: 'w', text: 'ships on tuesday', validFrom: '2025-01-01T00:00:00.000Z' }).memory;
  const after = dated.remember({ project: 'alpha', memoryType: 'preference', key: 'w', text: 'ships on thursday', validFrom: '2025-06-01T00:00:00.000Z' }).memory;
  const item = itemOf(read(dated, { query: 'ships' }), after.id);
  assert.deepEqual(item.temporalEvidence.eventTime, { at: '2025-06-01T00:00:00.000Z', state: 'known' });
  assert.deepEqual(item.temporalEvidence.currentState, state('current', 'validity_window', [before.id]));
});

test('AC-029: an explicit supersession decides and links both sides; AC-030: review, reconsideration and failure end nothing', () => {
  const { graph, set } = clocked('2026-01-01T00:00:00.000Z');
  const queue = graph.addDecision({ project: 'alpha', title: 'message queue', chosen: 'postgres outbox' });
  const rework = graph.addDecision({ project: 'alpha', title: 'message queue rework', chosen: 'managed queue' });
  graph.supersedeDecision({ project: 'alpha', decisionId: queue.id, replacementId: rework.id });
  const retention = graph.addDecision({ project: 'alpha', title: 'message retention', chosen: 'thirty days' });
  for (const status of ['in_progress', 'executed', 'reconsidered']) graph.updateDecisionStatus(retention.id, status, { project: 'alpha' });
  const broker = graph.addDecision({ project: 'alpha', title: 'message broker', chosen: 'rabbit' });
  for (const status of ['in_progress', 'failed']) graph.updateDecisionStatus(broker.id, status, { project: 'alpha' });
  const cache = graph.addDecision({ project: 'alpha', title: 'message cache', chosen: 'lru', reviewAfter: '2026-01-15T00:00:00.000Z' });
  set('2026-02-01T00:00:00.000Z');
  graph.maintain({ project: 'alpha' });
  const block = read(graph, { query: 'message' });
  assert.deepEqual(stateOf(block, rework.id), state('current', 'explicit_supersession', [queue.id]));
  assert.deepEqual(stateOf(block, queue.id), state('historical', 'explicit_supersession', [rework.id]));
  for (const decision of [retention, broker, cache]) assert.deepEqual(stateOf(block, decision.id), state('current', null), decision.title);
  // A replacement ended by its own lifecycle is historical on no supersession basis; so is an archived decision.
  graph.updateDecisionStatus(rework.id, 'abandoned', { project: 'alpha' });
  assert.deepEqual(stateOf(read(graph, { query: 'message' }), rework.id), state('historical', null));
  graph.updateDecisionStatus(retention.id, 'archived', { project: 'alpha' });
  assert.deepEqual(stateOf(read(graph, { query: 'message' }), retention.id), state('historical', null));
  // As of an instant, a decision's state is undetermined: it stores no event time.
  assert.deepEqual(stateOf(read(graph, { query: 'message', asOf: '2026-01-10T00:00:00.000Z' }), queue.id), state('undetermined', null, [rework.id]));
});

test('every supersession link the read may reach is named, either side, capped and counted; none beyond the boundary', () => {
  const graph = graphAt();
  const merged = graph.addDecision({ project: 'alpha', title: 'queue merged', chosen: 'c' });
  const earlier = [];
  for (let index = 0; index < 12; index += 1) {
    const one = graph.addDecision({ project: 'alpha', title: `queue ${index}`, chosen: 'a' });
    graph.supersedeDecision({ project: 'alpha', decisionId: one.id, replacementId: merged.id });
    earlier.push(one.id);
  }
  const hub = stateOf(read(graph, { query: 'merged' }), merged.id);
  assert.deepEqual([hub.state, hub.basis, hub.evidenceOmitted], ['current', 'explicit_supersession', 2]);
  assert.deepEqual(hub.evidence, inIdOrder(earlier).slice(0, 10), 'the first ten in id order, however the store was loaded');
  // Links stored as arrays, on either side, name the same supersession.
  graph.importData({ records: [
    { id: 'dA', kind: 'decision', project: 'alpha', title: 'deploy A', chosen: 'x', status: 'superseded', supersededBy: ['dB'] },
    { id: 'dB', kind: 'decision', project: 'alpha', title: 'deploy B', chosen: 'x', status: 'executed', supersedes: ['dA'] }
  ] });
  const deploy = read(graph, { query: 'deploy' });
  assert.deepEqual(stateOf(deploy, 'dB'), state('current', 'explicit_supersession', ['dA']));
  assert.deepEqual(stateOf(deploy, 'dA'), state('historical', 'explicit_supersession', ['dB']));
  // A link stored on one side only still names both.
  graph.importData({ records: [
    { id: 'dC', kind: 'decision', project: 'alpha', title: 'rollout C', chosen: 'x', status: 'executed' },
    { id: 'dD', kind: 'decision', project: 'alpha', title: 'rollout D', chosen: 'x', status: 'executed', supersedes: ['dC'] },
    { id: 'dE', kind: 'decision', project: 'alpha', title: 'rollout E', chosen: 'x', status: 'superseded', supersededBy: ['dF'] },
    { id: 'dF', kind: 'decision', project: 'alpha', title: 'rollout F', chosen: 'x', status: 'executed' }
  ] });
  const rollout = read(graph, { query: 'rollout' });
  assert.deepEqual(['dC', 'dD', 'dE', 'dF'].map((id) => stateOf(rollout, id)), [
    state('historical', 'explicit_supersession', ['dD']), state('current', 'explicit_supersession', ['dC']),
    state('historical', 'explicit_supersession', ['dF']), state('current', 'explicit_supersession', ['dE'])
  ]);
  // A link that crosses the boundary decides nothing and names nothing.
  const queue = graph.addDecision({ project: 'alpha', title: 'message queue', chosen: 'postgres outbox' });
  const rework = graph.addDecision({ project: 'alpha', title: 'message queue rework', chosen: 'managed queue' });
  graph.supersedeDecision({ project: 'alpha', decisionId: queue.id, replacementId: rework.id });
  const old = graph.addFact({ project: 'alpha', key: 'region', value: 'eu', validFrom: '2025-01-01T00:00:00.000Z' });
  const moved = graph.addFact({ project: 'alpha', key: 'region', value: 'us', validFrom: '2025-06-01T00:00:00.000Z' });
  graph.attribute({ ids: [rework.id, moved.id], targetProject: 'beta', reason: 'moved' });
  assert.deepEqual(stateOf(read(graph, { query: 'message queue', compact: true }), queue.id), state('historical', null));
  assert.deepEqual(stateOf(read(graph, { query: 'message queue', compact: true }, 'beta'), rework.id), state('current', null));
  assert.deepEqual(stateOf(read(graph, { query: 'zebra' }), old.id), state('historical', 'validity_window'));
});

test('a supersession linking another kind, which only an import stores, is explicit on both paths', () => {
  const graph = graphAt();
  graph.importData({ records: [
    { id: 'm1', kind: 'memory', project: 'alpha', memoryType: 'preference', key: 'w', text: 'ships on tuesday', status: 'superseded', supersededBy: 'd1' },
    { id: 'd1', kind: 'decision', project: 'alpha', title: 'ships on thursday', chosen: 'x', status: 'executed', supersedes: ['m1'] },
    { id: 'd2', kind: 'decision', project: 'alpha', title: 'ships from berlin', chosen: 'x', status: 'superseded', supersededBy: ['m2'] },
    { id: 'm2', kind: 'memory', project: 'alpha', memoryType: 'preference', key: 'v', text: 'ships from lisbon', status: 'active', supersedes: ['d2'] }
  ] });
  const block = read(graph, { query: 'ships', compact: true });
  assert.deepEqual(stateOf(block, 'm2'), state('current', 'validity_window', ['d2']), 'a predecessor of another kind is no recording-order rival');
  assert.deepEqual(stateOf(block, 'd2'), state('historical', 'explicit_supersession', ['m2']));
  assert.deepEqual(stateOf(block, 'm1'), state('historical', 'explicit_supersession', ['d1']));
  assert.deepEqual(stateOf(block, 'd1'), state('current', 'explicit_supersession', ['m1']));
  assert.deepEqual(stateOf(read(graph, { query: 'ships', asOf: '2026-01-01T00:00:00.000Z' }), 'm1'), state('undetermined', null, ['d1']));
  const { recordId, digest, derivationVersion, derivedAt } = itemOf(block, 'm1').line.expansion;
  const [pair] = graph.expand({ recordId, digest, derivationVersion, derivedAt, project: 'alpha' }).investigation.pairs;
  assert.deepEqual([pair.recordId, pair.state, pair.basis], ['d1', 'resolved', ['explicit_supersession']]);
});

test('a decision or attempt reads its creation time only, whatever else a writer left', () => {
  const graph = graphAt();
  graph.importData({ records: [
    { id: 'dx', kind: 'decision', project: 'alpha', title: 'legacy plan', chosen: 'x', createdAt: '2025-01-01T00:00:00.000Z', temporal: { recordedAt: 1735689600000 } },
    { id: 'ax', kind: 'attempt', project: 'alpha', solution: 'legacy plan drill', result: 'failed: x', resultClass: 'failed', createdAt: '2025-01-02T00:00:00.000Z', temporal: { recordedAt: { at: '2025-01-01' } } }
  ] });
  const block = read(graph, { query: 'legacy plan' });
  assert.equal(itemOf(block, 'dx').temporalEvidence.recordedAt, '2025-01-01T00:00:00.000Z');
  assert.equal(itemOf(block, 'ax').temporalEvidence.recordedAt, '2025-01-02T00:00:00.000Z');
});

test('recordedAt is the recording time for every kind, and the head counts only delivered items', () => {
  const graph = graphAt();
  const decision = graph.addDecision({ project: 'alpha', title: 'freeze plan', chosen: 'friday', createdAt: '2025-01-01T00:00:00.000Z' });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 'freeze drill', result: 'failed: x', resultClass: 'failed' });
  const memory = graph.remember({ project: 'alpha', memoryType: 'note', key: 'k', text: 'freeze notes', createdAt: '2025-01-01T00:00:00.000Z' }).memory;
  const block = read(graph, { query: 'freeze' });
  assert.equal(itemOf(block, decision.id).temporalEvidence.recordedAt, decision.createdAt);
  assert.equal(itemOf(block, attempt.id).temporalEvidence.recordedAt, attempt.createdAt);
  assert.equal(itemOf(block, memory.id).temporalEvidence.recordedAt, NOW, 'a memory\'s recording time, not its declared creation');
  const paged = read(graph, { query: 'freeze', limit: 1 });
  assert.deepEqual([paged.returned, paged.temporal.eventTimeUnknown], [1, 1]);
});

test('lines carry the evidence too, and the presentation writes nothing', () => {
  const graph = graphAt();
  graph.addFact({ project: 'alpha', key: 'region', value: 'eu-west' });
  graph.addFact({ project: 'alpha', key: 'region', value: 'us-east' });
  graph.addDecision({ project: 'alpha', title: 'region failover plan', chosen: 'active-passive' });
  const before = JSON.stringify(privilegedSnapshot(graph));
  const block = read(graph, { query: 'region', compact: true });
  assert.ok(block.items.every((item) => item.temporalEvidence && item.tier === 'T1'));
  read(graph, { query: 'region', asOf: '2026-02-01T00:00:00.000Z' });
  graph.context({ project: 'alpha' });
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
});
