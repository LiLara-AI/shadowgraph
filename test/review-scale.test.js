// Corrective for plan v1.4.4 PR-10: a read reviews every decision it can see against the stored facts it can see.
// Those facts are gathered once per read, so a read's cost grows with the store, not with decisions times facts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';

test('a read reviews many decisions against many facts in time linear in the store, with the same results', () => {
  const graph = createShadowGraph();
  for (let index = 0; index < 1500; index += 1) {
    graph.addDecision({ project: 'p', title: `decision ${index}`, chosen: 'x', alternatives: [{ label: `alt ${index}`, reasonRejected: 'r', reopenWhen: [{ key: `k${index}`, operator: 'greater_than', value: 1 }] }] });
  }
  for (let index = 0; index < 3000; index += 1) graph.addFact({ project: 'p', key: `k${index}`, value: index % 2 ? 5 : 0 });
  const started = performance.now();
  const view = graph.context({ project: 'p', limit: 1000 });
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 1500, `${Math.round(elapsed)} ms`);
  // Every decision whose key holds 5 fired, and no other.
  assert.equal(view.firedConditions.length, 750);
  assert.ok(view.firedConditions.every((entry) => Number(entry.reason.slice(1)) % 2 === 1));
});
