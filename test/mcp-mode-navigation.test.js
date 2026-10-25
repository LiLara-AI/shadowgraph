import test from 'node:test';
import assert from 'node:assert/strict';
import { buildToolCatalog, selectTools, projectTool, METADATA_TIER } from '../src/mcp-tools.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

function descriptions(value, path = '') {
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, child]) => key === 'description' && typeof child === 'string'
    ? [[`${path}.description`, child]] : descriptions(child, `${path}.${key}`));
}
function withoutDescriptions(value) {
  if (Array.isArray(value)) return value.map(withoutDescriptions);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'description').map(([key, child]) => [key, withoutDescriptions(child)]));
}

for (const verifier of [false, true]) for (const embeddingConfigured of [false, true]) {
  test(`compact navigation qualifies every unavailable tool, verifier=${verifier}, embeddings=${embeddingConfigured}`, () => {
    const full = buildToolCatalog({ verifier, embeddingConfigured });
    const before = JSON.stringify(full);
    const compact = selectTools(full, { compact: true });
    assert.equal(full.length, verifier ? 36 : 35);
    assert.equal(compact.length, 16);
    const names = new Set(compact.map(tool => tool.name));
    for (const entry of compact) {
      assert.ok(entry.description.length <= 550, `${entry.name}: compact navigation must remain concise`);
      const wire = projectTool(entry, METADATA_TIER.STRUCTURED);
      let unavailable = false;
      for (const [path, description] of descriptions(wire)) for (const match of description.matchAll(/shadowgraph_[a-z_]+/gu)) {
        if (names.has(match[0])) continue;
        unavailable = true;
        assert.ok(full.some(tool => tool.name === match[0]), `${entry.name}${path}: nonexistent target ${match[0]}`);
        assert.equal(description.slice(match.index + match[0].length).startsWith(' (full mode only)'), true,
          `${entry.name}${path}: unqualified unavailable target ${match[0]}`);
      }
      if (unavailable) assert.match(entry.description, /operator.*restart.*SHADOWGRAPH_MCP_COMPACT=0/u);
      const original = full.find(tool => tool.name === entry.name);
      assert.deepEqual(withoutDescriptions(wire), withoutDescriptions(projectTool(original, METADATA_TIER.STRUCTURED)), 'qualification cannot change schemas, annotations or capabilities');
    }
    assert.equal(JSON.stringify(full), before, 'selecting compact must not mutate the full catalog');
    assert.deepEqual(selectTools(full), full);
    assert.deepEqual(selectTools(compact, { compact: true }), compact, 'selection must be repeatable');
  });
}

test('tool choice explains working context, lookup, expansion, evaluation and maintenance', () => {
  const byName = Object.fromEntries(buildToolCatalog().map(tool => [tool.name, tool]));
  const desc = name => byName[`shadowgraph_${name}`].description;
  assert.match(desc('context'), /^Read .*working set/u);
  assert.match(desc('retrieve'), /one-hop/u);
  assert.match(desc('recall'), /Rank.*lexical.*vector/u);
  assert.match(desc('expand'), /input/u);
  assert.match(desc('review_context'), /shadowgraph_review.*also persists/u);
  assert.doesNotMatch(desc('review_context'), /evaluates rules only/u);
  assert.match(desc('review'), /persist/i);
  assert.match(desc('maintain'), /stale.*expire/u);
  assert.match(desc('reconsider'), /manual_review/u);
  assert.match(desc('record_attempt'), /existing decision/u);
  assert.match(desc('ack_review'), /shadowgraph_review_context/u);
  assert.match(byName.shadowgraph_context.inputSchema.properties.compact.description, /tool.*mode/u);
  assert.match(byName.shadowgraph_expand.inputSchema.description, /scope.*top level/u);
  assert.doesNotMatch(byName.shadowgraph_context.outputSchema.properties.relevant.properties.processing.description, /inactive in this build/u);
});

test('review and review_context both persist; context evaluates without persisting', () => {
  const graph = createShadowGraph();
  const decision = graph.addDecision({ project: 'p', title: 'Routing', chosen: 'local', alternatives: [{ label: 'remote', reopenWhen: [{ key: 'ready', operator: 'equals', value: true }] }] });
  graph.addFact({ project: 'p', key: 'ready', value: true });
  const before = privilegedSnapshot(graph);
  const context = graph.context({ project: 'p' });
  assert.equal(context.firedConditions[0].reviewSignalStatus, 'unpersisted');
  assert.deepEqual(privilegedSnapshot(graph).reviewSignals, before.reviewSignals);
  const due = graph.review({ project: 'p' });
  assert.equal(due.items[0].decisionId, decision.id);
  assert.equal(due.items[0].reviewSignalStatus, 'open');
  assert.equal(privilegedSnapshot(graph).reviewSignals.length, 1);
  const reviewed = graph.reviewContext({ project: 'p' });
  assert.equal(reviewed.openReviews[0].reviewSignalId, due.items[0].reviewSignalId);
  assert.equal(privilegedSnapshot(graph).reviewSignals.length, 1, 'repeat evaluation deduplicates the signal');
  assert.equal(privilegedSnapshot(graph).records.find(record => record.id === decision.id).status, decision.status, 'evaluation does not act on the decision lifecycle');
});
