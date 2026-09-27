import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph, isCommittedRejection } from '../src/shadowgraph.js';
import { privilegedIssueAccess, privilegedSnapshot, privilegedAccessRefusal } from '../src/internal/snapshot.js';
import { ACCESS_AUDIT_POLICY } from '../src/access.js';
import { mergeAuthorityRestore } from '../src/authority-restore.js';

function auditFixture() {
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  for (const project of ['alpha', 'beta', 'gamma']) graph.addDecision({ id: project, project, title: project, chosen: 'x', reviewAfter: '2025-01-01T00:00:00.000Z' });
  return graph;
}
function grant(graph, projects = ['beta']) {
  return privilegedIssueAccess(graph, { scope: { projects }, surfaces: ['cli'], expiresAt: '2026-12-31T00:00:00.000Z', reason: 'synthetic audit test' }).entry;
}

test('private transport refusal audit cannot issue authority and rejects caller-selected reason detail', () => {
  const graph = auditFixture();
  privilegedAccessRefusal(graph, { surface: 'cli', reason: 'grant_bounds_invalid', accessId: 'unknown' });
  const state = privilegedSnapshot(graph);
  assert.equal(state.access, undefined);
  assert.equal(state.events.find(event => event.type === 'access.refused').reason, 'grant_bounds_invalid');
  assert.throws(() => privilegedAccessRefusal(graph, { reason: 'arbitrary private detail' }), /Unsupported access refusal/);
  assert.deepEqual(privilegedSnapshot(graph), state);
});

test('a failing by-id read commits only the bounded grant refusal after canonical rollback', () => {
  const graph = auditFixture(), before = privilegedSnapshot(graph);
  assert.throws(() => graph.reconsider({ project: 'alpha', accessId: 'missing', decisionId: 'beta' }), error => error.message === 'Decision not found' && isCommittedRejection(error));
  const after = privilegedSnapshot(graph);
  for (const key of ['records', 'facts', 'relations', 'reviewSignals', 'journal', 'idempotency']) assert.deepEqual(after[key], before[key], key);
  const refusal = after.events.find(event => event.type === 'access.refused');
  assert.equal(refusal.count, 1); assert.equal(refusal.recordsReturnedTotal, 0);
});

test('audit counts unique returned decision projections in review and reconsider', () => {
  for (const method of ['review', 'reconsider']) {
    const graph = auditFixture(), access = grant(graph);
    graph[method]({ project: 'alpha', accessId: access.accessId });
    assert.equal(privilegedSnapshot(graph).events.find(event => event.type === 'access.used').recordsReturnedTotal, 2, method);
  }
});

test('invalid surface values cannot enlarge retained refusal records', () => {
  const graph = auditFixture();
  for (const surface of ['private-input-'.repeat(10000), { secret: 'private-input' }, null]) graph.search('', { project: 'alpha', accessId: 'missing', surface });
  const events = privilegedSnapshot(graph).events.filter(event => event.type === 'access.refused');
  assert.equal(events.reduce((total, event) => total + event.count, 0), 3);
  assert.ok(events.every(event => Buffer.byteLength(JSON.stringify(event)) < 2048));
  assert.doesNotMatch(JSON.stringify(events), /private-input/);
});

test('bounded audit samples identify the resolved request and exact wider-scope fingerprint', () => {
  const graph = auditFixture(), access = grant(graph);
  graph.search('', { project: 'alpha', accessId: access.accessId });
  graph.search('', { originId: 'synthetic-origin', accessId: access.accessId });
  graph.search('', { project: 'oversized-'.repeat(10000), accessId: access.accessId });
  const aggregate = privilegedSnapshot(graph).events.find(event => event.type === 'access.used');
  assert.deepEqual(aggregate.samples[0].resolvedScope, { state: 'project_selected', project: 'alpha', originId: null });
  assert.deepEqual(aggregate.samples[1].resolvedScope, { state: 'project_unresolved', project: null, originId: 'synthetic-origin' });
  assert.match(aggregate.samples[2].resolvedScope.project, /^sha256:[a-f0-9]{64}$/);
  assert.match(aggregate.samples[0].grantScopeHash, /^[a-f0-9]{64}$/);
  assert.equal(aggregate.samples[0].grantScopeHash, aggregate.samples[2].grantScopeHash);
  assert.ok(Buffer.byteLength(JSON.stringify(aggregate)) < 2048);
});

test('partial scope purge narrows grants and delegations before recreated material can be read', () => {
  const graph = auditFixture(), access = grant(graph, ['beta', 'gamma']);
  const delegation = privilegedIssueAccess(graph, { type: 'delegation', issuanceLimit: 2, scope: { projects: ['beta', 'gamma'] }, surfaces: ['cli'], expiresAt: '2026-12-31T00:00:00.000Z', reason: 'synthetic purge test' }).entry;
  graph.purgeProject('beta', { mode: 'logical' });
  graph.addDecision({ id: 'new-beta', project: 'beta', title: 'new beta', chosen: 'x' });
  const state = privilegedSnapshot(graph);
  for (const id of [access.accessId, delegation.accessId]) assert.deepEqual(state.access.entries.find(entry => entry.accessId === id).scope.projects, ['gamma']);
  assert.deepEqual(graph.exportData({ project: 'alpha', accessId: access.accessId }).records.map(record => record.id).sort(), ['alpha', 'gamma']);
  graph.purgeProject('gamma', { mode: 'logical' });
  const terminal = privilegedSnapshot(graph);
  for (const id of [access.accessId, delegation.accessId]) {
    assert.equal(terminal.access.entries.find(entry => entry.accessId === id).state, 'revoked');
    assert.ok(terminal.accessRevocations.entries.some(entry => entry.accessId === id));
  }
});

test('restore preserves the audit explaining a retained destination scope restriction', () => {
  const graph = auditFixture(), access = grant(graph, ['beta', 'gamma']);
  const backup = privilegedSnapshot(graph);
  graph.purgeProject('beta', { mode: 'logical' });
  const destination = privilegedSnapshot(graph);
  const narrowed = destination.events.find(event => event.type === 'access.scope_narrowed');
  assert.ok(narrowed);
  const restored = mergeAuthorityRestore(backup, destination, { now: '2026-01-01T00:00:00.000Z' });
  assert.deepEqual(restored.access.entries.find(entry => entry.accessId === access.accessId).scope.projects, ['gamma']);
  assert.deepEqual(restored.events.find(event => event.id === narrowed.id), narrowed);
});

test('operational audit retains the most recent bounded sample and expires aggregates without expiring witnesses', () => {
  let at = '2026-01-01T00:00:00.000Z';
  const graph = createShadowGraph({ now: () => at });
  graph.addDecision({ id: 'a', project: 'alpha', title: 'a', chosen: 'a' });
  graph.addDecision({ id: 'b', project: 'beta', title: 'b', chosen: 'b' });
  const grant = privilegedIssueAccess(graph, { scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2026-12-31T00:00:00.000Z', reason: 'synthetic audit test' }).entry;
  const before = privilegedSnapshot(graph);
  for (let second = 1; second <= 5; second++) { at = `2026-01-01T00:00:0${second}.000Z`; graph.search('', { project: 'alpha', accessId: grant.accessId }); }
  const payload = privilegedSnapshot(graph);
  const aggregate = payload.events.find(event => event.type === 'access.used');
  assert.equal(aggregate.count, 5); assert.equal(aggregate.recordsReturnedTotal, 10);
  assert.deepEqual(aggregate.samples.map(item => item.at), ['2026-01-01T00:00:03.000Z', '2026-01-01T00:00:04.000Z', '2026-01-01T00:00:05.000Z']);
  assert.equal(aggregate.firstAt, '2026-01-01T00:00:01.000Z');
  assert.equal(aggregate.lastAt, at);
  for (const key of ['records', 'facts', 'relations', 'reviewSignals', 'journal', 'idempotency']) assert.deepEqual(payload[key], before[key], key);
  at = '2026-03-01T00:00:00.000Z';
  graph.search('', { project: 'alpha', accessId: grant.accessId });
  const after = privilegedSnapshot(graph);
  assert.equal(after.events.filter(event => event.type === 'access.used').length, 1);
  assert.ok(after.events.some(event => event.id === grant.issuanceEventId));
});

test('refusal overflow conserves counts and reveals no caller-controlled arbitrary payload', () => {
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  for (let i = 0; i < 600; i++) graph.search('', { accessId: `unknown-sensitive-${i}` });
  const audit = privilegedSnapshot(graph).events;
  assert.equal(audit.reduce((sum, event) => sum + event.count, 0), 600);
  assert.ok(audit.length <= ACCESS_AUDIT_POLICY.keysPerDay + 1);
  assert.doesNotMatch(JSON.stringify(audit), /unknown-sensitive/);
  assert.equal(audit.find(event => event.type === 'access.audit_overflow').refusedCount, 600 - ACCESS_AUDIT_POLICY.keysPerDay);
});

test('malformed authority cannot remove otherwise permitted own-scope reads', () => {
  for (const access of [{ entries: { some: 1 } }, { entries: 'invalid' }, [], null]) {
    const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
    graph.addDecision({ project: 'alpha', title: 'own memory', chosen: 'x' });
    graph.importData({ records: [], access });
    const result = graph.search('own', { project: 'alpha', accessId: 'unknown' });
    assert.equal(result.items.length, 1);
    assert.equal(result.completeness.complete, false);
    assert.equal(result.completeness.scope.grant, null);
  }
});

test('load reconciles a retained revocation tombstone without reconstructing authority from events', () => {
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  const grant = privilegedIssueAccess(graph, { scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2026-12-31T00:00:00.000Z', reason: 'synthetic ledger test' }).entry;
  const source = privilegedSnapshot(graph);
  source.accessRevocations.entries.push({ accessId: grant.accessId, revokedAt: '2026-01-01T00:00:00.000Z', terminalReason: 'revoked', eventId: 'lost-event' });
  source.accessRevocations.ledgerSeq = 1;
  const restored = createShadowGraph(); restored.importData(source);
  const entry = privilegedSnapshot(restored).access.entries[0];
  assert.equal(entry.state, 'revoked');
  assert.equal(entry.revokedAt, '2026-01-01T00:00:00.000Z');
});
