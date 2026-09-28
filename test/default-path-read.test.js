import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedIssueAccess } from '../src/internal/snapshot.js';

// Plan v1.4.4 PR-15 (§13.1, PC-25(a), AC-059 clause 1): the default-path context
// read evaluates the working set without writing canonical truth. context()
// itself is unchanged for its callers until PR-16 routes the transports.
const NOW = '2026-01-01T00:00:00.000Z', END = '2026-02-01T00:00:00.000Z';
const CANONICAL = ['records', 'facts', 'relations', 'reviewSignals', 'idempotency', 'journal', 'journalSeq', 'events'];

function fixture() {
  const graph = createShadowGraph({ now: () => NOW });
  for (const project of ['alpha', 'beta']) {
    graph.addDecision({ project, title: `${project} cache policy`, chosen: 'lru', reviewAfter: '2025-01-01T00:00:00.000Z' });
    const queue = graph.addDecision({ project, title: `${project} queue choice`, chosen: 'fifo' });
    graph.setOutcome(queue.id, { status: 'failed', sourceClass: 'tool_observed' }, { project });
    graph.addDecision({ project, title: `${project} latency budget`, chosen: 'tight', alternatives: [{ label: 'loose', reason: 'too slow', reopenWhen: [{ key: 'latency', operator: 'greater_than', value: 10 }] }] });
    graph.addFact({ project, key: 'latency', value: 30, observedAt: NOW });
  }
  return graph;
}
const canonical = graph => {
  const snapshot = privilegedSnapshot(graph);
  return JSON.stringify(Object.fromEntries(CANONICAL.map(key => [key, snapshot[key]])));
};
const withoutSignalFields = value => JSON.parse(JSON.stringify(value, (key, item) => (key === 'reviewSignalId' || key === 'reviewSignalStatus' ? undefined : item)));

test('PR-15: repeated default-path reads leave canonical truth byte-equal', () => {
  const graph = fixture();
  const before = canonical(graph);
  let first;
  for (let i = 0; i < 50; i += 1) {
    const result = graph.readContext({ project: 'alpha' });
    first ??= result;
    assert.equal(canonical(graph), before, `read ${i + 1} changed canonical state`);
  }
  assert.equal(first.openReviews.length, 3, 'all three due decisions are reported');
  assert.equal(privilegedSnapshot(graph).reviewSignals.length, 0, 'no review signal was minted by reading');
});

test('PR-15: context() still evaluates and persists, unchanged for its callers', () => {
  const graph = fixture();
  graph.context({ project: 'alpha' });
  assert.equal(privilegedSnapshot(graph).reviewSignals.length, 3);
});

test('PR-15: the read reports existing signals without duplicating them', () => {
  const graph = fixture();
  const unpersisted = graph.readContext({ project: 'alpha' }).openReviews;
  assert.ok(unpersisted.every(item => item.reviewSignalStatus === 'unpersisted' && item.reviewSignalId === undefined));
  graph.review({ project: 'alpha' });
  const minted = privilegedSnapshot(graph).reviewSignals.length;
  assert.equal(minted, 3);
  const before = canonical(graph);
  const persisted = graph.readContext({ project: 'alpha' }).openReviews;
  assert.ok(persisted.every(item => typeof item.reviewSignalId === 'string' && item.reviewSignalStatus === 'open'));
  assert.equal(canonical(graph), before);
  assert.equal(privilegedSnapshot(graph).reviewSignals.length, minted);
});

test('PR-15: under a wider-read grant the read persists no own or foreign signal', () => {
  const graph = fixture();
  const grant = privilegedIssueAccess(graph, { scope: { projects: ['beta'] }, surfaces: ['cli', 'http', 'mcp'], expiresAt: END, reason: 'synthetic comparison' }).entry;
  const before = privilegedSnapshot(graph);
  const result = graph.readContext({ project: 'alpha', accessId: grant.accessId });
  assert.equal(result.completeness.scope.grant?.accessId, grant.accessId);
  const after = privilegedSnapshot(graph);
  for (const key of CANONICAL.filter(key => key !== 'events')) assert.deepEqual(after[key], before[key], key);
  assert.equal(after.reviewSignals.length, 0);
  // The only permitted change is the declared, bounded access accounting (§10.9.7).
  const added = after.events.filter(event => !before.events.some(prior => prior.id === event.id));
  assert.ok(added.every(event => String(event.type).startsWith('access.')), JSON.stringify(added.map(event => event.type)));
});

test('PR-15: the read returns the same working set as context(), without persisting', () => {
  // One graph, read first: the read changes nothing, so context() then sees the
  // same state. Two fixtures would differ in their generated canonical ids (F-33).
  const graph = fixture();
  const read = graph.readContext({ project: 'alpha' });
  const evaluated = graph.context({ project: 'alpha' });
  assert.deepEqual(withoutSignalFields(read), withoutSignalFields(evaluated));
});
