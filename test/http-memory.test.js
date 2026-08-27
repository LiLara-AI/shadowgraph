import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('HTTP exposes scoped remember and hybrid recall routes', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-http-memory-'));
  const app = await createShadowGraphServer({ file: join(directory, 'data.json') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const remembered = await post(base, '/memories', {
    project: 'app', scope: { userId: 'alice' }, memoryType: 'preference', key: 'editor',
    text: 'Prefers VS Code', embedding: [1, 0]
  });
  assert.equal(remembered.status, 200);
  assert.equal(remembered.body.operation, 'ADD');

  const recalled = await post(base, '/recall', {
    project: 'app', scope: { userId: 'alice' }, query: 'development environment', queryEmbedding: [1, 0]
  });
  assert.equal(recalled.status, 200);
  assert.equal(recalled.body.items[0].record.text, 'Prefers VS Code');
  assert.equal(recalled.body.signals.semantic.available, true);
  assert.equal(recalled.body.completeness.losslessItems, true);
});

test('HTTP rolls live memory back when ordinary persistence fails', async (t) => {
  const durable = createShadowGraph().exportData();
  const store = {
    load: async () => structuredClone(durable),
    save: async () => { throw new Error('injected persistence failure'); },
    close() {}
  };
  const app = await createShadowGraphServer({ store });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const response = await post(base, '/memories', {
    project: 'app', memoryType: 'note', key: 'must-not-stick', text: 'Transient'
  });
  assert.equal(response.status, 400);
  assert.match(response.body.error, /injected persistence failure/);
  assert.equal(app.graph.exportData().records.some((record) => record.key === 'must-not-stick'), false);
  assert.equal(app.graph.exportData().journal.some((entry) => entry.payload?.key === 'must-not-stick'), false);

  const failedFact = await post(base, '/facts', { project: 'app', key: 'fact-must-not-stick', value: true });
  assert.equal(failedFact.status, 400);
  assert.equal(app.graph.exportData().facts.some((fact) => fact.key === 'fact-must-not-stick'), false);
});

test('HTTP context persists review signals that it creates', async (t) => {
  const seed = createShadowGraph({ now: () => '2026-08-27T00:00:00.000Z' });
  seed.addDecision({
    id: 'due-decision', project: 'app', title: 'Due review', chosen: 'A',
    reviewAfter: '2026-01-01T00:00:00.000Z'
  });
  let durable = seed.exportData();
  const store = {
    load: async () => structuredClone(durable),
    save: async (data) => { durable = structuredClone(data); return (durable.revision ?? 0) + 1; },
    close() {}
  };
  const app = await createShadowGraphServer({ store, now: () => '2026-08-27T00:00:00.000Z' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const response = await post(base, '/context', { project: 'app' });
  assert.equal(response.status, 200);
  assert.equal(response.body.openReviews.length, 1);
  assert.equal(durable.reviewSignals.length, 1);
  assert.equal(durable.reviewSignals[0].decisionId, 'due-decision');
});
