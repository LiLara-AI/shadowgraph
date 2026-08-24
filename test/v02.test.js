import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph, SCHEMA_VERSION } from '../src/shadowgraph.js';

test('v0.2 creates explainable search results and context', () => {
  const graph = createShadowGraph({ now: () => '2026-08-24T00:00:00.000Z' });
  const decision = graph.addDecision({ project: 'app', title: 'Choose database', chosen: 'PostgreSQL', confidence: 0.8, evidence: [{ source: 'load-test', type: 'tool_observed', confidence: 0.9 }], alternatives: [{ label: 'SQLite', reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'local' }] }] });
  graph.addAttempt({ project: 'app', solution: 'Rewrite everything', result: 'failed regression' });
  const search = graph.search('database', { project: 'app' });
  assert.equal(search[0].record.id, decision.id);
  assert.deepEqual(search[0].matched, ['title']);
  const context = graph.context({ project: 'app', facts: { deployment: 'local' } });
  assert.equal(context.activeDecisions.length, 1);
  assert.equal(context.failedAttemptsToAvoid.length, 1);
  assert.equal(context.openReviews.length, 1);
  assert.equal(context.openReviews[0].alternativesToReconsider[0], 'SQLite');
});

test('outcomes update confidence and produce review signals', () => {
  const graph = createShadowGraph();
  const decision = graph.addDecision({ title: 'Use cache', chosen: 'Redis', confidence: 0.8 });
  const updated = graph.setOutcome(decision.id, { status: 'failed', lessons: ['Cache invalidation was unsafe'] });
  assert.equal(Number(updated.confidence.current.toFixed(2)), 0.6);
  assert.equal(graph.review().length, 1);
});

test('facts and v0.1 records migrate into the v0.2 export shape', () => {
  const graph = createShadowGraph();
  graph.importData([{ id: 'old', kind: 'decision', title: 'Old', chosen: 'A', confidence: 0.7, alternatives: [] }]);
  graph.addFact({ key: 'users', value: 100, source: 'human_confirmed', confidence: 1 });
  const data = graph.exportData();
  assert.equal(data.schemaVersion, SCHEMA_VERSION);
  assert.equal(data.records[0].confidence.current, 0.7);
  assert.equal(data.facts[0].source, 'human_confirmed');
});
