import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';

async function post(base, path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

test('HTTP exposes scoped remember and hybrid recall routes', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-http-memory-');
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
  const durable = privilegedSnapshot(createShadowGraph());
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
  assert.equal(privilegedSnapshot(app.graph).records.some((record) => record.key === 'must-not-stick'), false);
  assert.equal(privilegedSnapshot(app.graph).journal.some((entry) => entry.payload?.key === 'must-not-stick'), false);

  const failedFact = await post(base, '/facts', { project: 'app', key: 'fact-must-not-stick', value: true });
  assert.equal(failedFact.status, 400);
  assert.equal(privilegedSnapshot(app.graph).facts.some((fact) => fact.key === 'fact-must-not-stick'), false);
});

// Plan v1.4.4 PR-16 (§13.2): POST /context is the default-path read and commits
// nothing; POST /review-context carries evaluate-and-persist.
test('HTTP context is a read, and review-context persists the review signals it creates', async (t) => {
  const seed = createShadowGraph({ now: () => '2026-08-27T00:00:00.000Z' });
  const due = seed.addDecision({
    project: 'app', title: 'Due review', chosen: 'A',
    reviewAfter: '2026-01-01T00:00:00.000Z'
  });
  let durable = privilegedSnapshot(seed);
  const store = {
    load: async () => structuredClone(durable),
    save: async (data) => { saves += 1; durable = structuredClone(data); return (durable.revision ?? 0) + 1; },
    close() {}
  };
  let saves = 0;
  const app = await createShadowGraphServer({ store, now: () => '2026-08-27T00:00:00.000Z' });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const address = app.server.address();
  const base = `http://127.0.0.1:${address.port}`;

  const response = await post(base, '/context', { project: 'app' });
  assert.equal(response.status, 200);
  assert.equal(response.body.openReviews.length, 1);
  assert.equal(response.body.notice.replacement.http, 'POST /review-context');
  assert.equal(saves, 0, 'the default-path read commits nothing');
  assert.equal(durable.reviewSignals.length, 0);
  const evaluated = await post(base, '/review-context', { project: 'app' });
  assert.equal(evaluated.status, 200);
  assert.equal(evaluated.body.openReviews.length, 1);
  assert.equal(durable.reviewSignals.length, 1);
  assert.equal(durable.reviewSignals[0].decisionId, due.id);
});

// PR-16 review finding: the kernel treats any presented readProvenance as an
// access request and audits its refusal. With /context no longer committing,
// the transport must route that request through the fenced access operation,
// or the refusal stays live and a later unrelated write commits it.
test('HTTP context with a presented readProvenance commits its refusal audit in the same request', async (t) => {
  let durable = privilegedSnapshot(createShadowGraph());
  let saves = 0;
  const store = {
    load: async () => structuredClone(durable),
    save: async (data) => { saves += 1; durable = structuredClone(data); return (durable.revision ?? 0) + 1; },
    close() {}
  };
  const app = await createShadowGraphServer({ store });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const refused = (snapshot) => snapshot.events.filter((event) => event.type === 'access.refused').length;

  const response = await post(base, '/context', { project: 'app', readProvenance: {} });
  assert.equal(response.status, 200);
  assert.equal(saves, 1, 'the refusal is saved by this request');
  assert.equal(refused(durable), 1);
  assert.equal(refused(privilegedSnapshot(app.graph)), 1);
  await post(base, '/facts', { project: 'other', key: 'k', value: 'v' });
  assert.equal(refused(durable), 1, 'a later write does not carry a pending read effect');
});
