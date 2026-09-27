import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedRebuild } from '../src/internal/snapshot.js';
import { createShadowGraphServer } from '../src/server.js';
import { buildToolCatalog, toolResult, METADATA_TIER } from '../src/mcp-tools.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const now = () => '2026-01-01T00:00:00.000Z';
const json = (value) => JSON.parse(JSON.stringify(value));
const scoped = (g) => ({ journal: g.getJournal({ project: 'alpha' }), redact: g.redact({ project: 'alpha' }), rebuild: g.rebuild({ project: 'alpha' }) });

test('PR-11 blocked rebuild coverage withholds global issue counts while preserving the whole-store verdict', () => {
  const read = (betaCount) => {
    const writer = createShadowGraph({ now });
    writer.addDecision({ project: 'alpha', title: 'alpha', chosen: 'x' });
    for (let i = 0; i < betaCount; i++) writer.addDecision({ project: 'beta', title: 'beta', chosen: 'x' });
    const payload = privilegedSnapshot(writer);
    for (const record of payload.records.filter((r) => r.project === 'beta')) record.confidence.policy = 'unsupported';
    for (const entry of payload.journal.filter((e) => e.project === 'beta')) entry.payload.confidence.policy = 'unsupported';
    const graph = createShadowGraph({ now });
    graph.importData(payload);
    return { public: json(graph.rebuild({ project: 'alpha' })), privileged: privilegedRebuild(graph) };
  };
  const one = read(1); const two = read(2);
  assert.equal(one.public.rebuildable, false);
  assert.equal(one.public.completeness.complete, false, 'a withheld projection is not complete');
  assert.deepEqual(one.public.projection.records, []);
  assert.deepEqual(two.public, one.public, 'beta issue volume does not escape through a global diagnostic');
  assert.notDeepEqual(two.privileged.skipped, one.privileged.skipped, 'privileged diagnostics retain complete issue counts');
});

test('PR-11 beta-only activity does not change alpha journal envelopes; privileged counters remain truthful', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'alpha', chosen: 'x' });
  const before = json(scoped(graph));
  const stored = privilegedSnapshot(graph);
  graph.addDecision({ project: 'beta', title: 'beta', chosen: 'y' });
  graph.setRevision(7);
  const after = json(scoped(graph));
  assert.deepEqual(after, before, 'unchanged alpha query cannot reveal beta-only activity through global envelope counters');
  for (const key of ['journalSeq', 'journalEpoch', 'revision']) assert.equal(Object.hasOwn(after.redact, key), false);
  for (const key of ['journalSeq', 'journalEpoch']) assert.equal(Object.hasOwn(after.journal.completeness, key), false);
  for (const key of ['journalEpoch', 'applied', 'replayedFrom', 'replayedTo']) assert.equal(Object.hasOwn(after.rebuild, key), false);
  const full = privilegedSnapshot(graph);
  assert.equal(full.journalSeq, stored.journalSeq + 1);
  assert.equal(full.revision, 7);
  assert.equal(privilegedRebuild(graph).applied, 2);
  graph.addDecision({ project: 'alpha', title: 'next', chosen: 'z' });
  assert.deepEqual(graph.getJournal({ project: 'alpha' }).items.map((entry) => entry.seq), [1, 3], 'canonical ordering is retained, never relabelled as scoped numbering');
  assert.deepEqual(graph.getJournal({ project: 'alpha' }).completeness.gaps, [], 'interleaving alone is not missing history');
});

for (const path of ['search', 'retrieve', 'recall', 'getJournal', 'memoryHistory']) {
  test(`PR-11 ${path}: pagination counts survive unresolved-origin coverage`, () => {
    const graph = createShadowGraph({ now });
    for (const owner of [{ project: 'alpha' }, { originId: 'origin_a' }]) {
      for (let i = 0; i < 3; i++) graph.remember({ ...owner, memoryType: 'note', key: 'note', text: `revision ${i}` });
    }
    const call = (options) => path === 'memoryHistory' ? graph.memoryHistory({ ...options, memoryType: 'note', key: 'note' })
      : path === 'getJournal' ? graph.getJournal(options) : graph[path]('', options);
    for (const owner of [{ project: 'alpha' }, { originId: 'origin_a' }]) {
      const full = call({ ...owner, limit: 100 });
      const page = call({ ...owner, limit: 1, offset: 1 });
      assert.equal(page.completeness.total, full.items.length);
      assert.equal(page.completeness.returned, page.items.length);
      assert.equal(page.completeness.omitted, full.items.length - page.items.length);
      assert.equal(page.completeness.limitSource, 'caller');
      assert.equal(page.completeness.losslessItems, true);
      assert.equal(page.page.hasMore, 2 < full.items.length);
      assert.equal(page.completeness.complete, false);
      assert.equal(full.completeness.complete, !!owner.project);
      if (!owner.project) assert.equal(full.completeness.limitation?.code, 'scoped_coverage');
      assert.equal(call(owner).completeness.limitSource, 'default');
    }
  });
}

test('PR-11 context budgets and absent/outside traversal remain non-disclosing', () => {
  const graph = createShadowGraph({ now });
  const ids = {};
  for (const project of ['alpha', 'beta']) for (let i = 0; i < 3; i++) ids[`${project}-${i}`] = graph.addDecision({ project, title: `${project} ${i}`, chosen: 'x' }).id;
  const page = graph.context({ project: 'alpha', limit: 1 });
  assert.equal(page.completeness.complete, false);
  assert.deepEqual(page.completeness.collections.activeDecisions, { returned: 1, total: 3, hasMore: true, omitted: 2 });
  assert.equal(page.completeness.limitSource, 'caller');
  assert.equal(graph.context({ project: 'alpha' }).completeness.complete, true);
  assert.deepEqual({ ...graph.traverse({ project: 'alpha', id: ids['beta-0'] }), root: null }, { ...graph.traverse({ project: 'alpha', id: 'absent' }), root: null });
  assert.equal(graph.traverse({ id: ids['alpha-0'] }).completeness?.complete, false);
});

test('PR-11 redaction stamps truthful metadata after custom transformations and adds no writes', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ originId: 'origin_a', title: 'private', chosen: 'x' });
  const before = JSON.stringify(privilegedSnapshot(graph));
  const result = json(graph.redact({ originId: 'origin_a', patterns: ['scope', 'complete', 'exportKind', 'revision'], replacement: 'MASK' }));
  assert.equal(result.exportKind, 'scoped_redaction');
  assert.equal(result.completeness?.complete, false);
  assert.equal(result.completeness.scope.originPresented, true);
  assert.equal(result.completeness.losslessItems, false, 'redacted output is transformed');
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
});

test('PR-11 MCP review envelopes survive text and structured serialization', () => {
  const graph = createShadowGraph({ now });
  const catalog = buildToolCatalog();
  for (const [name, method] of [['shadowgraph_review', 'review'], ['shadowgraph_review_signals', 'getReviewSignals']]) {
    const entry = catalog.find((tool) => tool.name === name);
    const value = graph[method]({});
    const result = json(toolResult(entry, value, METADATA_TIER.STRUCTURED));
    assert.ok(entry.outputSchema, name);
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.deepEqual(result.structuredContent.items, []);
    assert.equal(result.structuredContent.completeness.complete, false);
  }
});

test('PR-11 HTTP and CLI serialize coverage, including doctor count projection', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-coverage-');
  const file = join(directory, 'store.json');
  const app = await createShadowGraphServer({ file });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    const base = `http://127.0.0.1:${app.server.address().port}`;
    for (const path of ['/stats', '/review-signals', '/records']) {
      const response = await fetch(`${base}${path}`);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).completeness?.complete, false, path);
    }
    const review = await fetch(`${base}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal((await review.json()).completeness?.complete, false);
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
  const run = async (command) => json(JSON.parse((await promisify(execFile)(process.execPath, ['src/cli.js', command], { env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json' } })).stdout));
  await run('setup');
  assert.equal((await run('signals')).completeness?.complete, false);
  const doctor = await run('doctor');
  assert.equal(doctor.graph.completeness?.complete, false);
  assert.equal(doctor.graph.limitation?.code, 'scoped_coverage');
});

test('PR-11 dashboard renders object metadata as JSON through text content', async () => {
  const html = await readFile(new URL('../dashboard/index.html', import.meta.url), 'utf8');
  const load = html.slice(html.indexOf('async function load()'), html.indexOf("$('load').onclick"));
  const elements = Object.fromEntries(['stats', 'signals', 'records'].map((id) => [id, { textContent: '', children: [], replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } }]));
  const value = { decisions: 0, completeness: { complete: false, limitation: { code: 'scoped_coverage' } } };
  const document = { createElement: () => ({ textContent: '', className: '' }) };
  await new Function('$', 'request', 'document', `${load}; return load();`)((id) => elements[id], async () => value, document);
  const rendered = elements.stats.textContent + elements.stats.children.map((child) => child.textContent).join('');
  assert.ok(rendered.includes('scoped_coverage'));
  assert.ok(rendered.includes('false'));
  assert.equal(rendered.includes('[object Object]'), false);
});
