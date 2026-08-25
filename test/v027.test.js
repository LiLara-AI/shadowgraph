import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';

test('traverses explainable relationships with depth and direction', () => {
  const graph = createShadowGraph();
  const first = graph.addDecision({ project: 'app', title: 'First', chosen: 'A' });
  const second = graph.addDecision({ project: 'app', title: 'Second', chosen: 'B' });
  const fact = graph.addFact({ project: 'app', key: 'runtime', value: 'local' });
  graph.link({ from: first.id, to: second.id, relation: 'supersedes' });
  graph.link({ from: second.id, to: fact.id, relation: 'depends_on' });
  const result = graph.traverse({ id: first.id, depth: 2, direction: 'out' });
  assert.deepEqual(result.nodes.map((item) => item.id), [first.id, second.id, fact.id]);
  assert.equal(result.relations.length, 2);
});

test('supersedes a decision only within the same project', () => {
  const graph = createShadowGraph();
  const oldDecision = graph.addDecision({ project: 'app', title: 'Old', chosen: 'A' });
  const newDecision = graph.addDecision({ project: 'app', title: 'New', chosen: 'B' });
  const result = graph.supersedeDecision({ decisionId: oldDecision.id, replacementId: newDecision.id });
  assert.equal(result.previous.status, 'superseded');
  assert.equal(result.replacement.supersedes[0], oldDecision.id);
  assert.throws(() => graph.supersedeDecision({ decisionId: oldDecision.id, replacementId: graph.addDecision({ project: 'other', title: 'Other', chosen: 'C' }).id }), /same project/);
});

test('redacts sensitive fields and purges a project with relations', () => {
  const graph = createShadowGraph();
  const decision = graph.addDecision({ project: 'private', title: 'Use token', chosen: 'Bearer secret-value' });
  const fact = graph.addFact({ project: 'private', key: 'apiKey', value: 'super-secret' });
  graph.link({ from: decision.id, to: fact.id, relation: 'depends_on' });
  graph.addDecision({ project: 'public', title: 'Public', chosen: 'Visible' });
  const safe = graph.redact({ project: 'private' });
  assert.equal(safe.records[0].chosen, 'Bearer [REDACTED]');
  assert.equal(safe.facts[0].value, '[REDACTED]');
  assert.equal(safe.events.every((item) => item.project === 'private'), true);
  assert.equal(safe.events.some((item) => item.project === 'public'), false);
  assert.equal(graph.purgeProject('private').removed, 2);
  assert.equal(graph.stats().relations, 0);
  assert.equal(graph.exportData().events.some((item) => item.project === 'private'), false);
});

test('traversal omits dangling relations and migration ids stay deterministic', () => {
  const graph = createShadowGraph();
  graph.importData({ records: [{ id: 'legacy', kind: 'decision', title: 'Legacy', chosen: 'A', alternatives: [{ label: 'B' }] }], relations: [{ id: 'dangling', from: 'legacy', to: 'missing', relation: 'depends_on' }] });
  const first = graph.exportData().records[0].alternatives[0].id;
  assert.equal(graph.traverse({ id: 'legacy' }).relations.length, 0);
  const secondGraph = createShadowGraph();
  secondGraph.importData({ records: [{ id: 'legacy', kind: 'decision', title: 'Legacy', chosen: 'A', alternatives: [{ label: 'B' }] }] });
  assert.equal(secondGraph.exportData().records[0].alternatives[0].id, first);
});

test('migration preserves confidence initial values and prevents supersession cycles', () => {
  const graph = createShadowGraph();
  graph.importData({ records: [{ id: 'd1', kind: 'decision', title: 'Old', chosen: 'A', confidence: { initial: 0.9, current: 0.2, history: [] }, alternatives: [] }, { id: 'd2', kind: 'decision', title: 'New', chosen: 'B', confidence: 0.5, alternatives: [] }] });
  assert.equal(graph.exportData().records.find((item) => item.id === 'd1').confidence.initial, 0.9);
  graph.supersedeDecision({ decisionId: 'd1', replacementId: 'd2' });
  assert.throws(() => graph.supersedeDecision({ decisionId: 'd2', replacementId: 'd1' }), /invalid decision chain/);
});

test('migration preserves legacy current confidence when adding first new evidence', () => {
  const graph = createShadowGraph();
  graph.importData({ records: [{ id: 'legacy-confidence', kind: 'decision', title: 'Old', chosen: 'A', confidence: { initial: 0.5, current: 0.9, history: [] }, alternatives: [] }] });
  const before = graph.exportData().records[0].confidence;
  assert.equal(before.current, 0.9);
  const after = graph.addConfidenceEvidence({ decisionId: 'legacy-confidence', key: 'new-observation', sourceClass: 'tool_observed', reason: 'new evidence' });
  assert.equal(after.confidence.current, 1.0, 'legacy current becomes the explicit baseline for the first new contribution');
  assert.equal(after.confidence.migratedFromLegacyCurrent, false);
});
test('search requires every query term', () => {
  const graph = createShadowGraph();
  graph.addDecision({ title: 'Database selection', chosen: 'PostgreSQL' });
  graph.addDecision({ title: 'Cache selection', chosen: 'Redis' });
  // G6: paginated envelope; every term must still match a content field (G7).
  assert.equal(graph.search('database postgres').items.length, 1);
  assert.equal(graph.search('database redis').items.length, 0);
});
