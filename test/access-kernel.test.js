import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedIssueAccess, privilegedAccessInspection, privilegedBindProject, privilegedResolveProjectBinding } from '../src/internal/snapshot.js';
import { ACCESS_AUDIT_POLICY } from '../src/access.js';
import { historicalRelation } from '../tools/historical-relation.js';

const NOW = '2026-01-01T00:00:00.000Z', END = '2026-02-01T00:00:00.000Z';
const bounds = { scope: { projects: ['beta'] }, surfaces: ['cli', 'http', 'mcp'], expiresAt: END, reason: 'synthetic comparison' };
function fixture() {
  let at = NOW;
  const graph = createShadowGraph({ now: () => at });
  const ids = {};
  for (const project of ['alpha', 'beta', 'gamma', 'default']) {
    ids[project] = graph.addDecision({ project, title: `${project} comparison`, chosen: 'x', reviewAfter: '2025-01-01T00:00:00.000Z' }).id;
    graph.remember({ project, memoryType: 'note', key: 'note', text: `${project} comparison` });
  }
  return { graph, ids, advance: value => { at = value; } };
}
const issue = (graph, overrides = {}) => privilegedIssueAccess(graph, { ...bounds, ...overrides }).entry;

test('proposal confers nothing and only trusted owner issuance or a bounded delegation grants access', () => {
  const { graph } = fixture();
  const proposal = graph.requestAccess(bounds);
  assert.equal(proposal.type, 'request');
  const refused = graph.search('comparison', { project: 'alpha', accessId: proposal.accessId });
  assert.equal(refused.items.some(x => x.record?.project === 'beta'), false);
  assert.equal(refused.completeness.scope.grant, null);
  assert.equal(graph.issueAccess({ ...bounds, confirmed: true, ownerConfirmation: true }).ok, false);
  const grant = issue(graph, { requestId: proposal.accessId });
  assert.notEqual(grant.accessId, proposal.accessId);
  assert.equal(grant.derivedFrom, proposal.accessId);
  assert.equal(privilegedSnapshot(graph).access.entries.find(x => x.accessId === proposal.accessId).state, 'requested');
  assert.equal(graph.search('comparison', { project: 'alpha', accessId: grant.accessId }).completeness.scope.grant.accessId, grant.accessId);
});

test('planned grantId read alias rechecks current authority and conflicting ids fail closed', () => {
  const { graph } = fixture(); const grant = issue(graph);
  assert.equal(graph.search('comparison', { project: 'alpha', grantId: grant.accessId }).completeness.scope.grant?.accessId, grant.accessId);
  const conflict = graph.search('comparison', { project: 'alpha', grantId: grant.accessId, accessId: 'different' });
  assert.equal(conflict.completeness.scope.grant, null);
  assert.doesNotMatch(JSON.stringify(conflict), /beta comparison/);
});

test('an origin-only grant read remains project-unresolved and describes the actual wider read', () => {
  const { graph, ids } = fixture(); const grant = issue(graph);
  const origin = graph.addDecision({ originId: 'synthetic-origin', title: 'origin comparison', chosen: 'x' });
  const result = graph.search('comparison', { originId: 'synthetic-origin', grantId: grant.accessId });
  assert.deepEqual(result.items.map(item => item.record.id).sort(), [ids.beta, origin.id].sort());
  assert.equal(result.completeness.scope.requestState, 'project_unresolved');
  assert.equal(result.completeness.scope.project, null);
  assert.equal(result.completeness.complete, false);
  assert.match(result.completeness.limitation.detail, /explicit wider/i);
});

for (const method of ['search', 'retrieve', 'recall', 'context', 'review', 'reconsider', 'exportData', 'redact', 'stats', 'getJournal', 'rebuild', 'validate', 'getReviewSignals']) {
  test(`grant current-state lookup reaches ${method} while preserving foreign canonical state`, () => {
    const { graph, ids } = fixture(); const grant = issue(graph);
    const options = { project: 'alpha', accessId: grant.accessId, surface: 'cli', limit: 100 };
    const before = privilegedSnapshot(graph);
    const call = () => ['search', 'retrieve', 'recall'].includes(method) ? graph[method]('comparison', options) : graph[method](options);
    const result = call();
    assert.equal(result.completeness.scope.grant.accessId, grant.accessId);
    if (['search', 'retrieve', 'recall', 'context', 'exportData'].includes(method)) assert.match(JSON.stringify(result), /beta/);
    assert.doesNotMatch(JSON.stringify(result), /gamma comparison/);
    const after = privilegedSnapshot(graph);
    for (const key of ['records', 'facts', 'relations']) assert.deepEqual(after[key], before[key], key);
    assert.equal(after.reviewSignals.some(x => x.decisionId === ids.beta), false);
    graph.revokeAccess({ accessId: grant.accessId });
    const denied = call();
    assert.equal(denied.completeness.scope.grant, null);
    assert.doesNotMatch(JSON.stringify(denied), /beta comparison/);
  });
}

test('read grants never widen maintenance, canonical writes or acknowledgement ownership', () => {
  const { graph, ids } = fixture(); const grant = issue(graph);
  graph.review({ project: 'beta' });
  const before = privilegedSnapshot(graph);
  const input = { project: 'alpha', accessId: grant.accessId };
  graph.maintain(input);
  assert.deepEqual(privilegedSnapshot(graph).records.filter(x => x.project === 'beta'), before.records.filter(x => x.project === 'beta'));
  assert.throws(() => graph.updateDecisionStatus(ids.beta, 'abandoned', input), /not found/i);
  assert.throws(() => graph.setOutcome(ids.beta, 'bad', input), /not found/i);
  const review = before.reviewSignals.find(x => x.decisionId === ids.beta);
  assert.throws(() => graph.acknowledgeReview(review.id, input), /not found/i);
});

test('expiry and inherited expansion provenance recheck without silently widening the original boundary', () => {
  const { graph, advance } = fixture(); const grant = issue(graph);
  const first = graph.retrieve('comparison', { project: 'alpha', accessId: grant.accessId });
  assert.ok(first.readProvenance);
  const wider = issue(graph, { scope: { projects: ['beta', 'gamma'] } });
  const derived = graph.retrieve('comparison', { project: 'gamma', accessId: wider.accessId, readProvenance: first.readProvenance });
  assert.doesNotMatch(JSON.stringify(derived), /gamma comparison/);
  advance(END);
  const expired = graph.retrieve('comparison', { readProvenance: first.readProvenance });
  assert.equal(expired.completeness.scope.grant, null);
  assert.doesNotMatch(JSON.stringify(expired), /beta comparison/);
  assert.match(JSON.stringify(expired), /alpha comparison/);
});

test('a traversal widens only by its grant, and a revoked grant\'s inherited provenance keeps the original request', () => {
  const { graph, ids } = fixture(); const grant = issue(graph);
  // A relation stored across projects before link() refused one: only the grant may follow it.
  graph.importData(historicalRelation({ id: 'relation-alpha-beta', from: ids.alpha, to: ids.beta, relation: 'related', project: 'alpha', seq: privilegedSnapshot(graph).journalSeq + 1, at: NOW }));
  const projects = (result) => [...new Set(result.nodes.map((node) => node.project))].sort();
  assert.deepEqual(projects(graph.traverse({ project: 'alpha', id: ids.alpha, depth: 3 })), ['alpha']);
  const widened = graph.traverse({ project: 'alpha', accessId: grant.accessId, id: ids.alpha, depth: 3 });
  assert.deepEqual(projects(widened), ['alpha', 'beta']);
  assert.equal(widened.completeness.scope.grant.accessId, grant.accessId);
  graph.revokeAccess({ accessId: grant.accessId });
  // Reusing the widened provenance rechecks the grant at use; the call's own project cannot replace the original request.
  const rechecked = graph.traverse({ id: ids.alpha, readProvenance: widened.readProvenance, project: 'default', depth: 3 });
  assert.deepEqual(projects(rechecked), ['alpha']);
  assert.equal(rechecked.completeness.scope.grant, null);
  assert.equal(rechecked.completeness.scope.project, 'alpha');
});

test('delegated issuance is bounded, retry-stable, terminal and separately revocable', () => {
  const { graph } = fixture();
  const delegation = issue(graph, { type: 'delegation', issuanceLimit: 2 });
  const input = { ...bounds, delegationId: delegation.accessId, idempotencyKey: 'attempt-1' };
  const first = graph.issueAccess(input); assert.equal(first.ok, true);
  assert.equal(graph.issueAccess(input).entry.accessId, first.entry.accessId);
  assert.equal(graph.issueAccess({ ...input, scope: { projects: ['gamma'] }, idempotencyKey: 'invalid' }).ok, false);
  assert.equal(graph.issueAccess({ ...input, type: 'delegation', idempotencyKey: 'nested' }).ok, false);
  const second = graph.issueAccess({ ...input, idempotencyKey: 'attempt-2' }); assert.equal(second.ok, true);
  assert.equal(graph.issueAccess({ ...input, idempotencyKey: 'attempt-3' }).ok, false);
  const inspection = privilegedAccessInspection(graph);
  assert.equal(inspection.access.entries.find(x => x.accessId === delegation.accessId).issuanceConsumed, 2);
  graph.revokeAccess({ accessId: delegation.accessId });
  assert.equal(graph.search('', { project: 'alpha', accessId: first.entry.accessId }).completeness.scope.grant, null);
  graph.discardAccess({ accessId: second.entry.accessId });
  const snapshot = privilegedSnapshot(graph);
  assert.equal(snapshot.access.entries.length, 3);
  assert.ok(snapshot.accessRevocations.entries.some(x => x.accessId === second.entry.accessId));
});

test('audit aggregates bounded details and excludes authority from public and masked redaction metadata', () => {
  const { graph } = fixture(); const grant = issue(graph);
  for (let index = 0; index < 300; index++) graph.search('comparison', { project: 'alpha', accessId: grant.accessId });
  for (let index = 0; index < 600; index++) graph.search('', { project: 'alpha', accessId: `missing-${index}` });
  const snapshot = privilegedSnapshot(graph);
  const aggregates = snapshot.events.filter(x => ['access.used', 'access.refused'].includes(x.type));
  assert.ok(aggregates.length <= ACCESS_AUDIT_POLICY.keysPerDay + 1);
  assert.equal(aggregates.find(x => x.type === 'access.used' && x.accessId === grant.accessId).count, 300);
  assert.ok(aggregates.every(x => (x.samples ?? []).length <= ACCESS_AUDIT_POLICY.sampleLimit));
  const output = graph.redact({ project: 'alpha', accessId: grant.accessId, patterns: ['project'] });
  assert.equal(output.exportKind, 'scoped_redaction');
  assert.equal(output.completeness.scope.projectLabelWithheld, true);
  assert.doesNotMatch(JSON.stringify(output.completeness), /alpha|beta/);
  assert.equal(output.access, undefined); assert.equal(output.accessRevocations, undefined);
  assert.equal(output.readProvenance, undefined);
});

test('confirmed bindings explicitly distinguish shared repository and worktree mappings', () => {
  const { graph } = fixture();
  assert.equal(privilegedResolveProjectBinding(graph, { worktreeRoot: '/synthetic/w', commonDir: '/synthetic/repo/.git' }), null);
  privilegedBindProject(graph, { type: 'shared_repository', path: '/synthetic/repo/.git', project: 'alpha' });
  privilegedBindProject(graph, { type: 'worktree', path: '/synthetic/w', project: 'beta', reason: 'explicit synthetic mapping', surface: 'cli' });
  const audit = privilegedSnapshot(graph).events.findLast(event => event.type === 'project.bound');
  assert.equal(audit.reason, 'explicit synthetic mapping');
  assert.equal(audit.surface, 'cli');
  assert.equal(audit.mode, 'confirmation');
  assert.equal(audit.activationSignal, 'local_binding_file');
  assert.equal(privilegedResolveProjectBinding(graph, { worktreeRoot: '/synthetic/w', commonDir: '/synthetic/repo/.git' }).project, 'beta');
  assert.equal(privilegedResolveProjectBinding(graph, { worktreeRoot: '/synthetic/other', commonDir: '/synthetic/repo/.git' }).project, 'alpha');
  assert.equal(graph.search('comparison', { binding: privilegedResolveProjectBinding(graph, { worktreeRoot: '/synthetic/w' }) }).completeness.scope.project, 'beta');
});

for (const mode of ['logical', 'hard']) test(`purge ${mode} retains authority witness and terminal tombstone`, () => {
  const { graph } = fixture(); const grant = issue(graph);
  graph.purgeProject('beta', { mode });
  const snapshot = privilegedSnapshot(graph);
  assert.equal(snapshot.access.entries.find(x => x.accessId === grant.accessId).state, 'revoked');
  assert.ok(snapshot.accessRevocations.entries.some(x => x.accessId === grant.accessId));
  assert.ok(snapshot.events.some(x => x.id === grant.issuanceEventId));
  assert.deepEqual(snapshot.records.map(x => x.project).filter(x => x === 'beta'), []);
});

test('wider fact evaluation cannot persist an own decision signal from foreign evidence', () => {
  for (const method of ['review', 'reconsider', 'context', 'maintain']) {
    const graph = createShadowGraph({ now: () => NOW });
    graph.addDecision({ project: 'alpha', title: 'check latency', chosen: 'x', reopenWhen: [{ key: 'latency', operator: 'gt', value: 10 }] });
    graph.addFact({ project: 'beta', key: 'latency', value: 30, observedAt: NOW });
    const grant = issue(graph);
    graph[method]({ project: 'alpha', accessId: grant.accessId });
    assert.deepEqual(privilegedSnapshot(graph).reviewSignals, [], method);
  }
});

test('authority transaction failures preserve complete state including budget and witness', () => {
  let calls = 0, throwAt = Infinity;
  const graph = createShadowGraph({ now: () => { if (++calls === throwAt) throw new Error('clock fault'); return NOW; } });
  const delegation = issue(graph, { type: 'delegation', issuanceLimit: 3 });
  const saved = privilegedSnapshot(graph);
  for (let offset = 1; offset <= 1; offset++) {
    calls = 0; throwAt = offset;
    assert.throws(() => graph.issueAccess({ ...bounds, delegationId: delegation.accessId }), /clock fault/);
    assert.deepEqual(privilegedSnapshot(graph), saved);
  }
});
