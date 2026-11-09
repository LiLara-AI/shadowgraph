import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { parseMemoryMarkdown, syncMarkdownWorkspace } from '../src/markdown-workspace.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const input = { project: 'p', memoryType: 'note', key: 'warmup', text: 'Warmup lasts six seconds.' };
const invalidate = graph => graph.applyMemoryPlan({ project: 'p', operations: [{ action: 'DELETE', memoryType: 'note', key: 'warmup' }] });
async function fixture(t) {
  const directory = await scratchDirectory(t, 'shadowgraph-pr42-markdown-');
  const graph = createShadowGraph({ now: () => '2026-10-04T00:00:00.000Z' });
  graph.remember(input);
  const pushed = await syncMarkdownWorkspace({ graph, directory, project: 'p', mode: 'push' });
  return { graph, directory, path: pushed.files[0].path };
}

test('PR42: push refreshes an invalidated tracked memory without deleting its history', async t => {
  const f = await fixture(t); invalidate(f.graph);
  const before = privilegedSnapshot(f.graph);
  const result = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push' });
  assert.equal(result.written, 1);
  assert.deepEqual(result.conflicts, []);
  assert.equal(parseMemoryMarkdown(await readFile(f.path, 'utf8')).status, 'invalidated');
  assert.deepEqual(privilegedSnapshot(f.graph), before);
  assert.equal((await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push' })).unchanged, 1);
});

test('PR42: an edit matching the invalidated status cannot revive canonical memory on pull', async t => {
  const f = await fixture(t); invalidate(f.graph);
  const edited = (await readFile(f.path, 'utf8')).replace('status: "active"', 'status: "invalidated"').replace(input.text, 'Edited stale claim.');
  await writeFile(f.path, edited);
  const before = privilegedSnapshot(f.graph);
  const result = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'pull' });
  assert.equal(result.imported, 0);
  assert.deepEqual(result.conflicts.map(x => x.reason), ['canonical_memory_not_active']);
  assert.deepEqual(privilegedSnapshot(f.graph), before);
  assert.equal(await readFile(f.path, 'utf8'), edited);
});

test('PR42: correction push protects a user-edited tracked file and reports its conflict', async t => {
  const f = await fixture(t); invalidate(f.graph);
  const edited = (await readFile(f.path, 'utf8')).replace(input.text, 'User edited this file.');
  await writeFile(f.path, edited);
  const result = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push' });
  assert.equal(result.written, 0);
  assert.deepEqual(result.conflicts.map(x => x.reason), ['both_file_and_memory_changed']);
  assert.equal(await readFile(f.path, 'utf8'), edited);
});

test('PR42: projection refresh does not publish untracked history or overwrite an active replacement', async t => {
  const f = await fixture(t); invalidate(f.graph);
  const empty = await scratchDirectory(t, 'shadowgraph-pr42-untracked-');
  assert.equal((await syncMarkdownWorkspace({ graph: f.graph, directory: empty, project: 'p', mode: 'push' })).written, 0);
  const current = f.graph.remember({ ...input, text: 'Warmup lasts eight seconds.' }).memory;
  const result = await syncMarkdownWorkspace({ ...f, project: 'p', mode: 'push' });
  assert.equal(result.written, 1);
  const parsed = parseMemoryMarkdown(await readFile(f.path, 'utf8'));
  assert.equal(parsed.id, current.id);
  assert.equal(parsed.status, 'active');
  assert.equal(parsed.text, current.text);
});

test('PR42: review-signal reads identify corrected decision history without rewriting the signal', () => {
  const graph = createShadowGraph();
  const old = graph.addDecision({ project: 'p', title: 'Use replica', chosen: 'replica', alternatives: [{ label: 'primary', reopenWhen: [{ key: 'lag', operator: 'gte', value: 500 }] }] });
  graph.addFact({ project: 'p', key: 'lag', value: 900 }); graph.maintain({ project: 'p' });
  const stored = privilegedSnapshot(graph).reviewSignals;
  assert.equal(stored.length, 1);
  const next = graph.addDecision({ project: 'p', title: 'Use primary', chosen: 'primary' });
  graph.supersedeDecision({ decisionId: old.id, replacementId: next.id, project: 'p' });
  const before = privilegedSnapshot(graph);
  const signal = graph.getReviewSignals({ project: 'p' }).items[0];
  assert.equal(signal.historical, true);
  assert.equal(signal.decisionState, 'superseded');
  assert.equal(signal.supersededBy, next.id);
  assert.deepEqual(privilegedSnapshot(graph), before, 'projection is read-only');
  assert.deepEqual(before.reviewSignals, stored, 'correction does not forge acknowledgement or rewrite review evidence');
  assert.equal(graph.getReviewSignals({ project: 'q' }).items.length, 0);
});

test('PR42: historical miss diagnostics never restore a superseded decision to the working set', () => {
  const graph = createShadowGraph();
  const old = graph.addDecision({ project: 'p', title: 'Replica query', chosen: 'replica' });
  graph.context({ project: 'p', query: 'zebra' });
  const diagnostics = privilegedSnapshot(graph).runtimeMisses;
  assert.equal(diagnostics[0].recordId, old.id);
  const next = graph.addDecision({ project: 'p', title: 'Primary query', chosen: 'primary' });
  graph.supersedeDecision({ decisionId: old.id, replacementId: next.id, project: 'p' });
  const current = graph.context({ project: 'p' });
  assert.equal(current.activeDecisions.some(x => x.id === old.id), false);
  assert.equal(current.activeDecisions.some(x => x.id === next.id), true);
  assert.deepEqual(privilegedSnapshot(graph).runtimeMisses, diagnostics);
  assert.equal(JSON.stringify(current).includes(diagnostics[0].missId), false);
});
