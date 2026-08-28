import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';

test('v0.25 supports lifecycle, relationships, and retrieval filters', () => {
  const graph = createShadowGraph();
  const decision = graph.addDecision({ project: 'demo', title: 'Use SQLite', chosen: 'SQLite', confidence: 0.8, assumptions: ['local'] });
  for (const status of ['planned', 'in_progress', 'executed', 'validated']) graph.updateDecisionStatus(decision.id, status);
  assert.equal(graph.exportData().records[0].status, 'validated');
  graph.addFact({ id: 'fact_1', project: 'demo', key: 'storage-mode', value: 'local' });
  const relation = graph.link({ from: decision.id, to: 'fact_1', relation: 'depends_on' });
  assert.equal(relation.relation, 'depends_on');
  assert.equal(graph.exportData().relations.length, 1);
  // G6: paginated envelope. G7: 'SQLite' matches the `chosen` content field.
  assert.equal(graph.search('SQLite', { project: 'demo', status: 'validated', minConfidence: 0.7 }).items.length, 1);
});
