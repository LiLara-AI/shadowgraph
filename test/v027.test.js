import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

test('traverses explainable relationships with depth and direction', () => {
  const graph = createShadowGraph();
  const first = graph.addDecision({ project: 'app', title: 'First', chosen: 'A' });
  const second = graph.addDecision({ project: 'app', title: 'Second', chosen: 'B' });
  const fact = graph.addFact({ project: 'app', key: 'runtime', value: 'local' });
  graph.link({ project: 'app', from: first.id, to: second.id, relation: 'supersedes' });
  graph.link({ project: 'app', from: second.id, to: fact.id, relation: 'depends_on' });
  const result = graph.traverse({ project: 'app', id: first.id, depth: 2, direction: 'out' });
  assert.deepEqual(result.nodes.map((item) => item.id), [first.id, second.id, fact.id]);
  assert.equal(result.relations.length, 2);
});

test('supersedes a decision only within the same project', () => {
  const graph = createShadowGraph();
  const oldDecision = graph.addDecision({ project: 'app', title: 'Old', chosen: 'A' });
  const newDecision = graph.addDecision({ project: 'app', title: 'New', chosen: 'B' });
  const result = graph.supersedeDecision({ project: 'app', decisionId: oldDecision.id, replacementId: newDecision.id });
  assert.equal(result.previous.status, 'superseded');
  assert.equal(result.replacement.supersedes[0], oldDecision.id);
  // Another project's decision is outside the write's boundary, and is refused
  // exactly as one that does not exist.
  assert.throws(() => graph.supersedeDecision({ project: 'app', decisionId: oldDecision.id, replacementId: graph.addDecision({ project: 'other', title: 'Other', chosen: 'C' }).id }), /Supersession requires two existing decisions/);
});

test('redacts sensitive fields and purges a project with relations', () => {
  const graph = createShadowGraph();
  const decision = graph.addDecision({ project: 'private', title: 'Use token', chosen: 'Bearer secret-value' });
  const fact = graph.addFact({ project: 'private', key: 'apiKey', value: 'super-secret' });
  graph.link({ project: 'private', from: decision.id, to: fact.id, relation: 'depends_on' });
  graph.addDecision({ project: 'public', title: 'Public', chosen: 'Visible' });
  const safe = graph.redact({ project: 'private' });
  assert.equal(safe.records[0].chosen, 'Bearer [REDACTED]');
  assert.equal(safe.facts[0].value, '[REDACTED]');
  assert.equal(safe.events.every((item) => item.project === 'private'), true);
  assert.equal(safe.events.some((item) => item.project === 'public'), false);
  assert.equal(graph.purgeProject('private').removed, 2);
  assert.equal(privilegedSnapshot(graph).relations.length, 0);
  assert.equal(privilegedSnapshot(graph).events.some((item) => item.project === 'private'), false);
});

test('traversal omits dangling relations and migration ids stay deterministic', () => {
  const graph = createShadowGraph();
  graph.importData({ records: [{ id: 'legacy', kind: 'decision', project: 'legacy-app', title: 'Legacy', chosen: 'A', alternatives: [{ label: 'B' }] }], relations: [{ id: 'dangling', from: 'legacy', to: 'missing', relation: 'depends_on' }] });
  const first = privilegedSnapshot(graph).records[0].alternatives[0].id;
  const traversal = graph.traverse({ project: 'legacy-app', id: 'legacy' });
  assert.deepEqual(traversal.nodes.map((node) => node.id), ['legacy']);
  assert.equal(traversal.relations.length, 0);
  const secondGraph = createShadowGraph();
  secondGraph.importData({ records: [{ id: 'legacy', kind: 'decision', title: 'Legacy', chosen: 'A', alternatives: [{ label: 'B' }] }] });
  assert.equal(privilegedSnapshot(secondGraph).records[0].alternatives[0].id, first);
});

test('migration preserves confidence initial values and prevents supersession cycles', () => {
  const graph = createShadowGraph();
  graph.importData({ records: [{ id: 'd1', kind: 'decision', project: 'app', title: 'Old', chosen: 'A', confidence: { initial: 0.9, current: 0.2, history: [] }, alternatives: [] }, { id: 'd2', kind: 'decision', project: 'app', title: 'New', chosen: 'B', confidence: 0.5, alternatives: [] }] });
  assert.equal(privilegedSnapshot(graph).records.find((item) => item.id === 'd1').confidence.initial, 0.9);
  graph.supersedeDecision({ project: 'app', decisionId: 'd1', replacementId: 'd2' });
  assert.throws(() => graph.supersedeDecision({ project: 'app', decisionId: 'd2', replacementId: 'd1' }), /invalid decision chain/);
});

test('migration preserves legacy current confidence when adding first new evidence', () => {
  const graph = createShadowGraph();
  graph.importData({ records: [{ id: 'legacy-confidence', kind: 'decision', project: 'app', title: 'Old', chosen: 'A', confidence: { initial: 0.5, current: 0.9, history: [] }, alternatives: [] }] });
  const before = privilegedSnapshot(graph).records[0].confidence;
  assert.equal(before.current, 0.9);
  const after = graph.addConfidenceEvidence({ project: 'app', decisionId: 'legacy-confidence', key: 'new-observation', sourceClass: 'tool_observed', reason: 'new evidence' });
  assert.equal(after.confidence.current, 1.0, 'legacy current becomes the explicit baseline for the first new contribution');
  assert.equal(after.confidence.migratedFromLegacyCurrent, false);
});
test('search requires every query term', () => {
  const graph = createShadowGraph();
  graph.addDecision({ project: 'default', title: 'Database selection', chosen: 'PostgreSQL' });
  graph.addDecision({ project: 'default', title: 'Cache selection', chosen: 'Redis' });
  // G6: paginated envelope; every term must still match a content field (G7).
  assert.equal(graph.search('database postgres', { project: 'default' }).items.length, 1);
  assert.equal(graph.search('database redis', { project: 'default' }).items.length, 0);
});
