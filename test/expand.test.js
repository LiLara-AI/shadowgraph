import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedIssueAccess } from '../src/internal/snapshot.js';

// Plan v1.4.4 PR-27 (§17.3; G-5 §7-§8; AC-018, AC-031, AC-032): a T1 line's
// handle expands to the full record inside the boundary of the read that
// produced the line, checked against the revision the line was derived from;
// a record that cannot be served is an explicit limitation, never a
// substituted summary, and its structural counterparts are investigated within
// a declared budget.
const NOW = '2026-03-01T00:00:00.000Z';
const LATER = '2026-03-02T00:00:00.000Z';

function fixture() {
  let clock = NOW;
  const graph = createShadowGraph({ now: () => clock });
  const queue = graph.addDecision({ project: 'alpha', title: 'message queue', chosen: 'postgres outbox', alternatives: [{ label: 'kafka cluster', reasonRejected: 'operational cost' }] });
  const attempt = graph.addAttempt({ project: 'alpha', solution: 'bulk backfill', result: 'failed: lock timeout', resultClass: 'failed', reason: 'locks held too long' });
  const twin = graph.addAttempt({ project: 'beta', solution: 'bulk backfill', result: 'failed: lock timeout', resultClass: 'failed' });
  return { graph, queue, attempt, twin, tick: (instant) => { clock = instant; } };
}
// The handle as a line carries it, and the expand input it becomes.
const lineOf = (graph, query, input = {}) => graph.context({ project: 'alpha', query, compact: true, ...input }).relevant.items[0].line;
// Accepts a line or its handle.
const handleInput = (value) => {
  const { operation, scope, ...handle } = value.expansion ?? value;
  return { ...handle, project: scope.project, ...(scope.grantId ? { grantId: scope.grantId } : {}) };
};

test('AC-018 and G-5 §7: a line expands to the very record it was derived from', () => {
  const { graph, queue } = fixture();
  const line = lineOf(graph, 'kafka');
  assert.equal(line.expansion.operation, 'shadowgraph_expand');
  const expanded = graph.expand(handleInput(line.expansion));
  assert.equal(expanded.status, 'current');
  assert.equal(expanded.revisionChanged, false);
  assert.deepEqual(expanded.boundRevision, { recordId: queue.id, digest: line.boundRevision.digest });
  assert.deepEqual(expanded.currentRevision, expanded.boundRevision);
  // The record the same read delivers in full.
  assert.deepEqual(expanded.record, graph.context({ project: 'alpha', query: 'kafka' }).relevant.items[0].record);
  assert.equal(expanded.completeness.complete, true);
  // The relevant block now names a working expansion path.
  assert.deepEqual(graph.context({ project: 'alpha', query: 'kafka' }).relevant.expansion, { operation: 'shadowgraph_expand', available: true });
});

test('G-5 §7.2: a changed record is served as the current record, never as the revision the line came from', () => {
  const { graph, queue } = fixture();
  const line = lineOf(graph, 'kafka');
  graph.setOutcome(queue.id, { status: 'failed', sourceClass: 'tool_observed' }, { project: 'alpha' });
  const expanded = graph.expand(handleInput(line.expansion));
  assert.equal(expanded.status, 'revision_changed');
  assert.equal(expanded.revisionChanged, true);
  assert.equal(expanded.boundRevision.digest, line.boundRevision.digest);
  assert.notEqual(expanded.currentRevision.digest, line.boundRevision.digest);
  assert.equal(expanded.currentRevision.digest, lineOf(graph, 'kafka').boundRevision.digest, 'the current digest is the one a fresh line carries');
  assert.equal(expanded.record.outcome.status, 'failed');
  assert.deepEqual([expanded.completeness.complete, expanded.completeness.limitation.code], [false, 'revision_changed']);
  // A handle from another derivation version is never taken as this revision.
  assert.equal(graph.expand({ ...handleInput(lineOf(graph, 'kafka').expansion), derivationVersion: 't1-line-v0' }).status, 'revision_changed');
});

test('G5-7: an id outside the boundary answers exactly as an unknown one, whatever it names', () => {
  const { graph, queue, twin } = fixture();
  const alice = graph.remember({ project: 'alpha', scope: { userId: 'alice' }, memoryType: 'note', key: 'k', text: 'alice only' }).memory;
  const handle = handleInput(lineOf(graph, 'kafka').expansion);
  const unknown = JSON.stringify(graph.expand({ ...handle, recordId: 'decision:missing' }));
  for (const recordId of [twin.id, alice.id, queue.alternatives[0].id]) {
    assert.equal(JSON.stringify(graph.expand({ ...handle, recordId })).replaceAll(recordId, 'decision:missing'), unknown, recordId);
  }
  const answer = JSON.parse(unknown);
  assert.deepEqual([answer.status, answer.record, answer.revisionChanged, answer.currentRevision, answer.investigation], ['unavailable', null, null, null, null]);
  assert.deepEqual(answer.completeness.limitation, { ...answer.completeness.limitation, code: 'expansion_unavailable', reason: 'unavailable', recordId: 'decision:missing' });
  assert.equal(answer.completeness.complete, false);
});

test('G5-6: a record purged after its line was derived answers purged, or unavailable after a hard purge, with no content', () => {
  for (const [mode, reason] of [['logical', 'purged'], ['hard', 'unavailable']]) {
    const { graph, tick } = fixture();
    const handle = handleInput(lineOf(graph, 'kafka').expansion);
    tick(LATER);
    graph.purgeProject('alpha', { mode });
    const expanded = graph.expand(handle);
    assert.deepEqual([expanded.status, expanded.record, expanded.completeness.complete], [reason, null, false], mode);
    assert.deepEqual([expanded.completeness.limitation.code, expanded.completeness.limitation.reason, expanded.completeness.limitation.recordId], ['expansion_unavailable', reason, handle.recordId]);
    assert.equal(JSON.stringify(expanded).includes('kafka'), false, 'no substituted summary');
    // An unknown id in the same scope answers the same: the purge, not the id, decides.
    assert.equal(graph.expand({ ...handle, recordId: 'decision:missing' }).status, reason);
    // A line derived after the purge knows nothing of it, and an undated one cannot be placed before it.
    assert.equal(graph.expand({ ...handle, derivedAt: LATER }).status, 'unavailable');
    const { derivedAt, ...undated } = handle;
    assert.equal(graph.expand(undated).status, 'unavailable');
  }
});

test('G5-10: the same expansion twice gives the same bytes, and expanding writes nothing', () => {
  const { graph } = fixture();
  const handle = handleInput(lineOf(graph, 'kafka').expansion);
  const before = JSON.stringify(privilegedSnapshot(graph));
  const first = JSON.stringify(graph.expand(handle));
  assert.equal(JSON.stringify(graph.expand(handle)), first);
  assert.equal(JSON.stringify(graph.expand({ ...handle, recordId: 'decision:missing' })), JSON.stringify(graph.expand({ ...handle, recordId: 'decision:missing' })));
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
});

test('a grant is inherited from the line and re-checked at use: audited while valid, fails closed once revoked', () => {
  const { graph, twin } = fixture();
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'expand fixture' }).entry;
  const line = graph.context({ project: 'alpha', accessId: grant.accessId, query: 'backfill', compact: true }).relevant.items.find((item) => item.line.recordId === twin.id).line;
  const handle = handleInput(line.expansion);
  assert.equal(handle.grantId, grant.accessId);
  // One audit aggregate per grant, surface, outcome and UTC day: each use adds to its count.
  const used = () => privilegedSnapshot(graph).events.filter((event) => event.type === 'access.used').reduce((sum, event) => sum + event.count, 0);
  const auditedBefore = used();
  const granted = graph.expand(handle);
  assert.deepEqual([granted.status, granted.record.id], ['current', twin.id]);
  assert.equal(used(), auditedBefore + 1, 'the granted expansion is audited');
  assert.equal(granted.readProvenance.accessId, grant.accessId);
  // Without the grant, the granted record is outside the boundary: unavailable, as an unknown id.
  const { grantId, ...ownScope } = handle;
  assert.equal(graph.expand(ownScope).status, 'unavailable');
  graph.revokeAccess({ accessId: grant.accessId });
  const revoked = graph.expand(handle);
  assert.deepEqual([revoked.status, revoked.record], ['unavailable', null]);
});

test('AC-031: same-key facts resolve by explicit supersession and different times, with both positions and the evidence', () => {
  const { graph, tick } = fixture();
  const older = graph.addFact({ project: 'alpha', key: 'latency', value: '5ms', validFrom: '2025-01-01T00:00:00.000Z' });
  tick(LATER);
  // An event time apart from the recording time (PR-29: one equal to it is unknown).
  const newer = graph.addFact({ project: 'alpha', key: 'latency', value: '30ms', validFrom: '2026-02-15T00:00:00.000Z' });
  const line = graph.context({ project: 'alpha', query: 'latency', compact: true }).relevant.items.find((item) => item.line.recordId === newer.id).line;
  const { investigation } = graph.expand(handleInput(line.expansion));
  assert.deepEqual(investigation.budget, { maxExpansions: 5, used: 1, outcome: 'within_budget' });
  assert.equal(investigation.pairs.length, 1);
  const [pair] = investigation.pairs;
  assert.deepEqual([pair.recordId, pair.relation, pair.state], [older.id, 'same_key', 'resolved']);
  assert.deepEqual(pair.basis, ['explicit_supersession', 'different_times']);
  assert.equal(pair.position.recordId, older.id, 'the other position, as its line');
  assert.equal(pair.record.value, '5ms', 'and in full, fetched within the budget');
  assert.equal(investigation.limitation.code, 'structural_only');
  // From the older side the newer fact is both the same key and its supersession link: listed once.
  const fromOlder = graph.expand(handleInput(pair.position)).investigation;
  assert.deepEqual(fromOlder.pairs.map((item) => [item.recordId, item.relation]), [[newer.id, 'same_key']]);
});

test('AC-032: an unresolved conflict delivers both positions, investigated; past the budget it says so', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData({ facts: [
    { id: 'fact-eu', kind: 'fact', project: 'alpha', key: 'region', value: 'eu', status: 'active', sourceClass: 'tool_observed', validFrom: '2025-01-01T00:00:00.000Z' },
    { id: 'fact-us', kind: 'fact', project: 'alpha', key: 'region', value: 'us', status: 'active', sourceClass: 'agent_claimed', validFrom: '2025-01-01T00:00:00.000Z' }
  ] });
  const line = graph.context({ project: 'alpha', query: 'region', compact: true }).relevant.items.find((item) => item.line.recordId === 'fact-eu').line;
  const investigated = graph.expand(handleInput(line.expansion));
  assert.equal(investigated.record.value, 'eu');
  assert.deepEqual(investigated.investigation.pairs.map(({ recordId, relation, state, basis }) => ({ recordId, relation, state, basis })), [{ recordId: 'fact-us', relation: 'same_key', state: 'unresolved', basis: [] }]);
  assert.equal(investigated.investigation.pairs[0].record.value, 'us');
  assert.equal(investigated.completeness.complete, true, 'fully investigated, though unresolved');
  // No budget: neither side disappears, and the exhausted budget is declared.
  const exhausted = graph.expand({ ...handleInput(line.expansion), maxExpansions: 0 });
  assert.deepEqual(exhausted.investigation.budget, { maxExpansions: 0, used: 0, outcome: 'exhausted' });
  const [pair] = exhausted.investigation.pairs;
  assert.deepEqual([pair.state, pair.basis, Object.hasOwn(pair, 'record'), pair.position.recordId], ['uninvestigated', [], false, 'fact-us']);
  assert.equal(exhausted.record.value, 'eu');
  assert.deepEqual([exhausted.completeness.complete, exhausted.completeness.limitation.code], [false, 'investigation_budget_exhausted']);
});

test('AC-031: a decision and the one it superseded resolve by the explicit supersession', () => {
  const { graph, queue } = fixture();
  const replacement = graph.addDecision({ project: 'alpha', title: 'message queue rework', chosen: 'managed queue' });
  graph.supersedeDecision({ project: 'alpha', decisionId: queue.id, replacementId: replacement.id });
  const line = graph.context({ project: 'alpha', query: 'rework', compact: true }).relevant.items[0].line;
  const [pair] = graph.expand(handleInput(line.expansion)).investigation.pairs;
  assert.deepEqual([pair.recordId, pair.relation, pair.state, pair.basis], [queue.id, 'supersedes', 'resolved', ['explicit_supersession']]);
});

test('expansion inputs are validated', () => {
  const { graph } = fixture();
  const handle = handleInput(lineOf(graph, 'kafka').expansion);
  assert.throws(() => graph.expand({ ...handle, recordId: 7 }), /recordId must be a non-empty string/);
  assert.throws(() => graph.expand({ ...handle, digest: undefined }), /digest must be a non-empty string/);
  assert.throws(() => graph.expand({ ...handle, maxExpansions: -1 }), /maxExpansions must be an integer from 0 to 50/);
  assert.throws(() => graph.expand({ ...handle, maxExpansions: 51 }), /maxExpansions must be an integer from 0 to 50/);
  assert.throws(() => graph.expand({ ...handle, derivedAt: 'yesterday' }), /derivedAt must be a valid timestamp/);
});

// --- review round 1 -----------------------------------------------------------

test('the investigation never reaches outside the boundary; links it cannot reach are counted alike and make the answer incomplete', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData({ records: [
    { id: 'd-beta', kind: 'decision', project: 'beta', title: 'beta SECRET successor', chosen: 'b', status: 'proposed' },
    { id: 'd-alpha', kind: 'decision', project: 'alpha', title: 'alpha plan', chosen: 'a', status: 'superseded', supersededBy: 'd-beta', supersedes: ['d-ghost'] }
  ] });
  const expanded = graph.expand(handleInput(lineOf(graph, 'plan')));
  assert.equal(expanded.status, 'current');
  assert.deepEqual(expanded.investigation.pairs, []);
  assert.equal(expanded.investigation.unreachableLinks, 2, 'another project\'s record and a missing one are counted alike');
  assert.equal(JSON.stringify(expanded.investigation).includes('SECRET'), false);
  assert.deepEqual([expanded.completeness.complete, expanded.completeness.limitation.code], [false, 'links_unavailable']);
});

test('no identity reaches nothing, and an origin-scoped read expands from its own handle', () => {
  const { graph } = fixture();
  const { project, ...noScope } = handleInput(lineOf(graph, 'kafka'));
  assert.equal(graph.expand(noScope).status, 'unavailable');
  const origin = graph.addDecision({ originId: 'origin-1', title: 'origin cache', chosen: 'lru' });
  const line = graph.context({ originId: 'origin-1', query: 'origin cache', compact: true }).relevant.items[0].line;
  assert.deepEqual(line.expansion.scope, { project: null, grantId: null, originId: 'origin-1' });
  const { operation, scope, ...fields } = line.expansion;
  const expanded = graph.expand({ ...Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null)), originId: scope.originId });
  assert.deepEqual([expanded.status, expanded.record.id], ['current', origin.id]);
});

test('the purge that decides is the first of the read\'s own project after the line: others, later ones and undated handles do not', () => {
  const clock = { at: NOW };
  const graph = createShadowGraph({ now: () => clock.at });
  graph.addDecision({ project: 'alpha', title: 'message queue', chosen: 'outbox' });
  graph.addDecision({ project: 'gamma', title: 'unrelated', chosen: 'x' });
  const handle = handleInput(lineOf(graph, 'queue'));
  const missing = { ...handle, recordId: 'decision:missing' };
  // A purge of a project the read does not cover changes nothing.
  clock.at = LATER;
  graph.purgeProject('gamma', { mode: 'logical' });
  assert.equal(graph.expand(missing).status, 'unavailable');
  // The hard purge that removed the record decides; a later logical purge does not turn it into purged.
  graph.purgeProject('alpha', { mode: 'hard' });
  assert.equal(graph.expand(handle).status, 'unavailable');
  clock.at = '2026-03-03T00:00:00.000Z';
  graph.addDecision({ project: 'alpha', title: 'again', chosen: 'y' });
  graph.purgeProject('alpha', { mode: 'logical' });
  assert.equal(graph.expand(handle).status, 'unavailable');
  // A logical purge followed by another: the first, scrubbed by the second, still decides, and it was logical.
  const again = createShadowGraph({ now: () => clock.at });
  clock.at = NOW;
  again.addDecision({ project: 'alpha', title: 'message queue', chosen: 'outbox' });
  const twice = handleInput(lineOf(again, 'queue'));
  clock.at = LATER;
  again.purgeProject('alpha', { mode: 'logical' });
  clock.at = '2026-03-03T00:00:00.000Z';
  again.addDecision({ project: 'alpha', title: 'again', chosen: 'y' });
  again.purgeProject('alpha', { mode: 'logical' });
  assert.equal(again.expand(twice).status, 'purged');
  // A handle with no derivation instant cannot place any purge after it.
  const { derivedAt, ...undated } = handle;
  assert.equal(graph.expand(undated).status, 'unavailable');
});

test('a granted project\'s purge answers unavailable: the purge narrows the grant, so the expansion fails closed', () => {
  const { graph, twin, tick } = fixture();
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta', 'gamma'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'expand fixture' }).entry;
  const line = graph.context({ project: 'alpha', accessId: grant.accessId, query: 'backfill', compact: true }).relevant.items.find((item) => item.line.recordId === twin.id).line;
  tick(LATER);
  graph.purgeProject('beta', { mode: 'logical' });
  assert.equal(graph.expand(handleInput(line)).status, 'unavailable');
});

test('a line derived as of an instant expands as current with that instant, and changes without it', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addFact({ project: 'alpha', key: 'region', value: 'eu', validFrom: '2025-01-01T00:00:00.000Z', validTo: '2025-06-01T00:00:00.000Z' });
  const line = graph.context({ project: 'alpha', query: 'region', asOf: '2025-03-01T00:00:00.000Z', compact: true }).relevant.items[0].line;
  const handle = handleInput(line);
  assert.equal(handle.asOf, '2025-03-01T00:00:00.000Z');
  assert.equal(graph.expand(handle).status, 'current');
  const { asOf, ...undated } = handle;
  assert.equal(graph.expand(undated).status, 'revision_changed');
});

test('counterparts are the same key only, and a link outside the boundary leaves the digest exact', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addFact({ project: 'alpha', key: 'latency', value: '5ms' });
  graph.addFact({ project: 'alpha', key: 'throughput', value: '9k' });
  graph.addFact({ project: 'beta', key: 'latency', value: '7ms' });
  const expanded = graph.expand(handleInput(lineOf(graph, 'latency')));
  assert.deepEqual([expanded.status, expanded.investigation.total], ['current', 0]);
  // An attempt linking into another project: the line and the expansion leave the link out alike.
  const beta = graph.addAttempt({ project: 'beta', solution: 'beta probe', result: 'ok', resultClass: 'succeeded' });
  graph.addAttempt({ project: 'alpha', solution: 'linked probe', result: 'ok', resultClass: 'succeeded', relatedTo: [beta.id] });
  assert.equal(graph.expand(handleInput(lineOf(graph, 'linked'))).status, 'current');
});

test('G5-10 with counterparts and a moving clock: expanding reads no clock', () => {
  let tick = 0;
  const graph = createShadowGraph({ now: () => new Date(Date.parse(NOW) + (tick += 1) * 1000).toISOString() });
  graph.addFact({ project: 'alpha', key: 'latency', value: '5ms' });
  graph.addFact({ project: 'alpha', key: 'latency', value: '30ms' });
  const handle = handleInput(lineOf(graph, 'latency'));
  const first = JSON.stringify(graph.expand(handle));
  assert.equal(JSON.parse(first).investigation.pairs.length, 1);
  assert.equal(JSON.stringify(graph.expand(handle)), first);
});

test('the superseded side names its replacement; position lines carry the request\'s scope and grant', () => {
  const { graph, queue } = fixture();
  const replacement = graph.addDecision({ project: 'alpha', title: 'message queue rework', chosen: 'managed queue' });
  graph.supersedeDecision({ project: 'alpha', decisionId: queue.id, replacementId: replacement.id });
  const [pair] = graph.expand(handleInput(lineOf(graph, 'kafka'))).investigation.pairs;
  assert.deepEqual([pair.recordId, pair.relation, pair.state, pair.basis], [replacement.id, 'superseded_by', 'resolved', ['explicit_supersession']]);
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'expand fixture' }).entry;
  const granted = graph.expand(handleInput(lineOf(graph, 'rework', { accessId: grant.accessId })));
  assert.deepEqual(granted.investigation.pairs[0].position.expansion.scope, { project: 'alpha', grantId: grant.accessId });
});

// PR-29 (§17.5 row 3): versions a same-key write separated only by the
// recording order are not resolved by it; with distinct event times they are,
// and so is a legacy fact whose declared end precedes the next one's start.
test('a memory names the memory it superseded as a counterpart, resolved only by distinct event times', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const older = graph.remember({ project: 'alpha', memoryType: 'note', key: 'fridays', text: 'deploy on fridays is fine' }).memory;
  const newer = graph.remember({ project: 'alpha', memoryType: 'note', key: 'fridays', text: 'deploys wait until monday' }).memory;
  const line = graph.context({ project: 'alpha', query: 'monday', compact: true }).relevant.items.find((item) => item.line.recordId === newer.id).line;
  const [pair] = graph.expand(handleInput(line)).investigation.pairs;
  assert.deepEqual([pair.recordId, pair.relation, pair.state, pair.basis], [older.id, 'supersedes', 'unresolved', []]);
  const dated = createShadowGraph({ now: () => NOW });
  const before = dated.remember({ project: 'alpha', memoryType: 'note', key: 'fridays', text: 'deploy on fridays is fine', validFrom: '2025-01-01T00:00:00.000Z' }).memory;
  const after = dated.remember({ project: 'alpha', memoryType: 'note', key: 'fridays', text: 'deploys wait until monday', validFrom: '2025-06-01T00:00:00.000Z' }).memory;
  const datedLine = dated.context({ project: 'alpha', query: 'monday', compact: true }).relevant.items.find((item) => item.line.recordId === after.id).line;
  const [datedPair] = dated.expand(handleInput(datedLine)).investigation.pairs;
  assert.deepEqual([datedPair.recordId, datedPair.state, datedPair.basis], [before.id, 'resolved', ['explicit_supersession']]);
});

test('each basis from the records themselves: the same value in any key order, and windows that overlap', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData({ facts: [
    { id: 'limits-a', kind: 'fact', project: 'alpha', key: 'limits', value: { cpu: 2, mem: 4 }, status: 'active', validFrom: '2025-01-01T00:00:00.000Z' },
    { id: 'limits-b', kind: 'fact', project: 'alpha', key: 'limits', value: { mem: 4, cpu: 2 }, status: 'active', validFrom: '2025-01-01T00:00:00.000Z' },
    { id: 'zone-a', kind: 'fact', project: 'alpha', key: 'zone', value: 'a', status: 'active', validFrom: '2025-01-01T00:00:00.000Z', validTo: '2027-01-01T00:00:00.000Z' },
    { id: 'zone-b', kind: 'fact', project: 'alpha', key: 'zone', value: 'b', status: 'active', validFrom: '2025-06-01T00:00:00.000Z' }
  ] });
  const pairOf = (recordId, query) => {
    const line = graph.context({ project: 'alpha', query, compact: true }).relevant.items.find((item) => item.line.recordId === recordId).line;
    const [pair] = graph.expand(handleInput(line)).investigation.pairs;
    return [pair.state, pair.basis];
  };
  assert.deepEqual(pairOf('limits-a', 'limits'), ['resolved', ['same_value']]);
  assert.deepEqual(pairOf('zone-a', 'zone'), ['unresolved', []], 'windows that overlap settle nothing');
  // A fact with no declared start is valid from its observation.
  graph.importData({ facts: [
    { id: 'rate-old', kind: 'fact', project: 'alpha', key: 'rate', value: 1, status: 'active', observedAt: '2025-01-01T00:00:00.000Z', validTo: '2025-02-01T00:00:00.000Z' },
    { id: 'rate-new', kind: 'fact', project: 'alpha', key: 'rate', value: 2, status: 'active', observedAt: '2025-03-01T00:00:00.000Z' }
  ] });
  assert.deepEqual(pairOf('rate-new', 'rate'), ['resolved', ['different_times']]);
});

test('positions are bounded, current rivals first; defaults and the order of limitations', () => {
  const graph = createShadowGraph({ now: () => NOW });
  for (let index = 0; index < 30; index += 1) graph.addFact({ project: 'alpha', key: 'latency', value: `${index}ms`, validFrom: new Date(Date.parse('2025-01-01T00:00:00.000Z') + index * 86400000).toISOString() });
  graph.importData({ facts: [{ id: 'rival', kind: 'fact', project: 'alpha', key: 'latency', value: '99ms', status: 'active', validFrom: '2020-01-01T00:00:00.000Z' }] });
  const latest = graph.context({ project: 'alpha', query: 'latency', compact: true }).relevant.items.find((item) => item.line.line.includes('"29ms"')).line;
  const handle = handleInput(latest);
  const none = graph.expand({ ...handle, maxExpansions: 0 }).investigation;
  assert.deepEqual([none.total, none.pairs.length, none.omitted, none.budget.used], [30, 10, 20, 0]);
  assert.equal(none.pairs[0].recordId, 'rival', 'the unsettled rival comes first');
  assert.ok(none.pairs[1].position.line.includes('"28ms"'), 'then the most recent history');
  const many = graph.expand({ ...handle, maxExpansions: 20 }).investigation;
  assert.deepEqual([many.pairs.length, many.budget.used, many.omitted, many.budget.outcome], [20, 20, 10, 'exhausted']);
  // No derivation version is the current one; a changed record outranks an exhausted budget.
  const { derivationVersion, ...unversioned } = handle;
  assert.equal(graph.expand(unversioned).status, 'current');
  graph.addFact({ project: 'alpha', key: 'latency', value: '31ms' });
  const changed = graph.expand({ ...handle, maxExpansions: 0 });
  assert.deepEqual([changed.status, changed.completeness.limitation.code], ['revision_changed', 'revision_changed']);
});

test('every input is validated before any record is resolved', () => {
  const { graph } = fixture();
  const handle = handleInput(lineOf(graph, 'kafka'));
  assert.throws(() => graph.expand(null), /expand input must be an object/);
  assert.throws(() => graph.expand([handle]), /expand input must be an object/);
  assert.throws(() => graph.expand({ ...handle, recordId: '' }), /recordId must be a non-empty string/);
  assert.throws(() => graph.expand({ ...handle, derivationVersion: 1 }), /derivationVersion must be a string/);
  assert.throws(() => graph.expand({ ...handle, maxExpansions: 1.5 }), /maxExpansions must be an integer from 0 to 50/);
  assert.throws(() => graph.expand({ ...handle, asOf: 'soon' }), /asOf must be a valid timestamp/);
  assert.equal(graph.expand({ ...handle, maxExpansions: 50 }).status, 'current');
});
