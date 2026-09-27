import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { createShadowGraphServer } from '../src/server.js';
import { buildToolCatalog, toolResult, METADATA_TIER } from '../src/mcp-tools.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const now = () => '2026-01-01T00:00:00.000Z';
const selectedScope = { project: null, projectLabelWithheld: true, requestState: 'project_selected', originPresented: false, grant: null };
const cases = [
  { name: 'project key rule', project: 'customer-orion', patterns: ['^project$'], masked: true },
  { name: 'default credential URL rule', project: 'https://client.invalid/?token=synthetic-value', masked: true },
  { name: 'default Bearer rule', project: 'Bearer synthetic-project-value', masked: true },
  { name: 'whole collection rules', project: 'customer-orion', patterns: ['^(records|facts|relations|events|journal)$'], masked: true },
  { name: 'literal value pattern control', project: 'sensitive-client', patterns: ['sensitive-client'], masked: false },
  { name: 'default secret word control', project: 'secret-client', masked: false },
  { name: 'benign control', project: 'alpha', masked: false }
];

for (const scenario of cases) test(`redaction metadata withholds the project label: ${scenario.name}`, () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: scenario.project, title: 'Ordinary', chosen: 'x' });
  const outside = graph.addDecision({ project: 'unrelated', title: 'Other', chosen: 'y' });
  const before = JSON.stringify(privilegedSnapshot(graph));
  const result = graph.redact({ project: scenario.project, patterns: scenario.patterns, replacement: '[MASKED]' });
  const { completeness, ...body } = result;
  assert.equal(!JSON.stringify(body).includes(scenario.project), scenario.masked, 'establish the body policy before checking metadata');
  if (scenario.masked) assert.equal(JSON.stringify(result).includes(scenario.project), false, 'no wrapper restores the masked value');
  assert.deepEqual(completeness.scope, selectedScope);
  assert.equal(completeness.complete, true);
  assert.equal(completeness.losslessItems, false);
  assert.equal(result.exportKind, 'scoped_redaction');
  assert.equal(JSON.stringify(result).includes(outside.id), false);
  assert.equal(graph.exportData({ project: scenario.project }).completeness.scope.project, scenario.project, 'ordinary reads retain the actual scope label');
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
});

test('redaction protects structural coverage from caller patterns and replacement values', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'customer-orion', title: 'Ordinary', chosen: 'x' });
  const before = JSON.stringify(privilegedSnapshot(graph));
  for (const replacement of ['public_scoped', '', 'project_unresolved', { grant: 'fake', project: 'fake' }]) {
    const value = JSON.parse(JSON.stringify(graph.redact({ project: 'customer-orion', patterns: ['.'], replacement })));
    assert.equal(JSON.stringify(value).includes('customer-orion'), false);
    assert.deepEqual(value.completeness.scope, selectedScope);
    assert.equal(value.exportKind, 'scoped_redaction');
    assert.equal(value.completeness.complete, true);
    assert.equal(value.completeness.losslessItems, false);
    assert.equal(value.completeness.limitation.code, 'scoped_coverage');
  }
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
});

test('withheld redaction labels preserve selected, exact-origin and unresolved content boundaries', () => {
  const graph = createShadowGraph({ now });
  const selected = graph.addDecision({ project: 'alpha', title: 'Project', chosen: 'x' });
  const ownOrigin = graph.addDecision({ originId: 'origin_a', title: 'Origin', chosen: 'x' });
  const otherOrigin = graph.addDecision({ originId: 'origin_b', title: 'Other', chosen: 'x' });
  const before = JSON.stringify(privilegedSnapshot(graph));
  for (const [input, ids, scope, complete] of [
    [{ project: 'alpha', originId: 'origin_a' }, [selected.id], { ...selectedScope, originPresented: true }, true],
    [{ originId: 'origin_a' }, [ownOrigin.id], { project: null, projectLabelWithheld: false, requestState: 'project_unresolved', originPresented: true, grant: null }, false],
    [{}, [], { project: null, projectLabelWithheld: false, requestState: 'project_unresolved', originPresented: false, grant: null }, false],
    [{ project: 'empty-project' }, [], selectedScope, true]
  ]) {
    const result = JSON.parse(JSON.stringify(graph.redact(input)));
    assert.deepEqual(result.records.map(record => record.id), ids);
    assert.deepEqual(result.completeness.scope, scope);
    assert.equal(result.completeness.complete, complete);
    assert.equal(result.completeness.losslessItems, false);
    assert.equal(JSON.stringify(result).includes(otherOrigin.id), false);
  }
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
});

test('redaction schema and MCP serialization describe a withheld label without changing ordinary read scopes', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'customer-orion', title: 'Ordinary', chosen: 'x' });
  const catalog = buildToolCatalog();
  const entry = catalog.find(tool => tool.name === 'shadowgraph_redact');
  const scope = entry.outputSchema.properties.completeness.properties.scope;
  assert.equal(scope.properties.project.type, 'null');
  assert.ok(scope.required.includes('projectLabelWithheld'));
  assert.equal(scope.properties.projectLabelWithheld.type, 'boolean');
  const ordinary = catalog.find(tool => tool.name === 'shadowgraph_search').outputSchema.properties.completeness.properties.scope;
  assert.equal(Object.hasOwn(ordinary.properties, 'projectLabelWithheld'), false);
  const view = graph.redact({ project: 'customer-orion', patterns: ['^project$'] });
  const result = JSON.parse(JSON.stringify(toolResult(entry, view, METADATA_TIER.STRUCTURED)));
  assert.equal(JSON.stringify(result).includes('customer-orion'), false);
  assert.deepEqual(result.structuredContent.completeness.scope, selectedScope);
  assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
});

test('HTTP redaction serializes safe scope metadata without changing the graph or durable store', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-redaction-scope-');
  const file = join(directory, 'store.json');
  const app = await createShadowGraphServer({ storage: 'json', file });
  app.graph.addDecision({ project: 'customer-orion', title: 'Ordinary', chosen: 'x' });
  const outside = app.graph.addDecision({ project: 'unrelated', title: 'Other', chosen: 'y' });
  await app.persist();
  const before = JSON.stringify(privilegedSnapshot(app.graph));
  const bytes = await readFile(file);
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/redact`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'customer-orion', patterns: ['^project$'], replacement: '[MASKED]' })
    });
    assert.equal(response.status, 200);
    const serialized = await response.text();
    assert.equal(serialized.includes('customer-orion'), false);
    assert.equal(serialized.includes(outside.id), false);
    const result = JSON.parse(serialized);
    assert.equal(result.records[0].project, '[MASKED]');
    assert.deepEqual(result.completeness.scope, selectedScope);
    assert.equal(result.exportKind, 'scoped_redaction');
    assert.equal(JSON.stringify(privilegedSnapshot(app.graph)), before);
    assert.deepEqual(await readFile(file), bytes);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
});
