import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedRebuild } from '../src/internal/snapshot.js';
import { privilegedRecordCapture } from '../src/internal/snapshot.js';
import { createStorage } from '../src/storage.js';
import { runExtractionItem } from '../src/internal/extraction-worker.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const NOW = '2026-10-04T00:00:00.000Z';
function fixture() {
  const graph = createShadowGraph({ now: () => NOW });
  const input = { project: 'p', originId: 'fixture', solution: 'Synthetic staging migration', result: 'Failed in staging.', resultClass: 'failed', reusableWhen: [{ key: 'ready', operator: 'equals', value: true }] };
  const old = graph.addAttempt(input), next = graph.addAttempt({ ...input, result: 'Succeeded in staging.', resultClass: 'succeeded' });
  const data = privilegedSnapshot(graph);
  for (const record of data.records) record.captureRef = 'synthetic-capture';
  for (const entry of data.journal) if (entry.type === 'attempt.recorded') entry.payload.captureRef = 'synthetic-capture';
  graph.replaceData(data);
  const link = () => graph.link({ project: 'p', from: next.id, to: old.id, relation: 'supersedes' });
  return { graph, old, next, link };
}

function privateSuccessor() {
  const { graph, old } = fixture();
  const next = graph.remember({ project: 'p', originId: 'fixture', scope: { userId: 'alice' }, memoryType: 'note', key: 'private', text: 'Synthetic staging migration' }).memory;
  const data = privilegedSnapshot(graph);
  data.records.find(x => x.id === next.id).captureRef = 'synthetic-capture';
  data.journal.find(x => x.entityId === next.id).payload.captureRef = 'synthetic-capture';
  graph.replaceData(data);
  return { graph, old, next, link: () => graph.link({ project: 'p', from: next.id, to: old.id, relation: 'supersedes' }) };
}

test('PR42 reader: memory scope is checked before projecting any supersession identity or lifecycle', () => {
  const { graph, old, next, link } = privateSuccessor(); link();
  const before = privilegedSnapshot(graph);
  const context = graph.context({ project: 'p', query: 'staging' });
  assert.ok(context.failedAttempts.some(x => x.id === old.id));
  assert.equal(JSON.stringify(context).includes(next.id), false);
  const ordinary = graph.search('staging', { project: 'p' });
  assert.equal(JSON.stringify(ordinary).includes(next.id), false);
  const selected = graph.search('staging', { project: 'p', scope: { userId: 'alice' } });
  assert.deepEqual(selected.items.find(x => x.record.id === old.id).record.supersededBy, [next.id]);
  assert.deepEqual(privilegedSnapshot(graph), before);
});

test('PR42 reader: superseded extraction representation is historical in search, recall and context, with no read writes', () => {
  const { graph, old, next, link } = fixture(); link();
  const before = privilegedSnapshot(graph);
  const context = graph.context({ project: 'p', facts: { ready: true } });
  assert.equal(context.failedAttempts.some(x => x.id === old.id), false);
  assert.equal(context.reusableAttempts.some(x => x.attemptId === old.id), false);
  assert.equal(graph.traverse({ project: 'p', id: old.id }).nodes.find(x => x.id === old.id).derivationState, 'superseded');
  for (const found of [graph.search('staging', { project: 'p' }).items, graph.retrieve('staging', { project: 'p' }).items, graph.recall('staging', { project: 'p' }).items]) {
    const record = found.find(x => x.record.id === old.id).record;
    assert.equal(record.derivationState, 'superseded');
    assert.deepEqual(record.supersededBy, [next.id]);
  }
  const relevant = graph.context({ project: 'p', query: 'staging' }).relevant.items.find(x => x.record?.id === old.id);
  assert.equal(relevant.temporalEvidence.currentState.state, 'historical');
  assert.equal(relevant.temporalEvidence.currentState.basis, 'explicit_supersession');
  assert.deepEqual(privilegedSnapshot(graph), before);
});

const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
for (const type of ['json', 'sqlite']) {
  const skip = type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {};
  test(`PR42 reader ${type}: actual delivery serialization retains supersession and a usable expansion handle`, skip, async t => {
    for (const hidden of [false, true]) {
    const root = await scratchDirectory(t, 'shadowgraph-pr42-delivery-');
    const cwd = join(root, 'work'), file = join(root, 'memory');
    await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
    await writeFile(join(cwd, '.shadowgraph/project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: cwd, project: 'p', confirmed: true }));
    const { graph, old, next, link } = hidden ? privateSuccessor() : fixture(); link();
    const store = await createStorage({ type, file, env: { SHADOWGRAPH_HOME: root } });
    await store.save(privilegedSnapshot(graph)); store.close();
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'deliver'], { cwd, env: { ...process.env, SHADOWGRAPH_HOME: root, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: type }, windowsHide: true });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject); child.on('close', code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'staging' }));
    });
    assert.equal(result.code, 0, result.stderr); assert.equal(result.stderr, '');
    const output = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    const items = output.split('\n').filter(x => x.startsWith('item: ')).map(x => JSON.parse(x.slice(6)));
    const prior = items.find(x => x.expansion?.recordId === old.id);
    assert.ok(prior);
    if (hidden) {
      assert.equal(prior.currentState, null);
      assert.equal(output.includes(next.id), false, 'private-scoped successor identity must not leak through delivery');
    } else {
      assert.equal(prior.currentState.state, 'historical');
      assert.ok(prior.line.includes('superseded by') && prior.line.includes(next.id), 'delivered compact text must retain the replacement identity');
    }
    const { operation, scope, ...handle } = prior.expansion;
    assert.equal(graph.expand({ ...handle, project: 'p' }).status, 'current');
    }
  });
  test(`PR42 reader ${type}: relation meaning survives store round trip and journal replay without canonical mutation`, skip, async t => {
    const root = await scratchDirectory(t, 'shadowgraph-pr42-reader-');
    const { graph, old, link } = fixture(); link();
    const store = await createStorage({ type, file: join(root, 'memory'), env: { SHADOWGRAPH_HOME: root } });
    try {
      await store.save(privilegedSnapshot(graph));
      const before = await store.load();
      const fresh = createShadowGraph({ now: () => NOW }); fresh.importData(before);
      assert.equal(fresh.context({ project: 'p' }).failedAttempts.some(x => x.id === old.id), false);
      const rebuilt = privilegedRebuild(fresh);
      assert.equal(rebuilt.rebuildable, true);
      const replayed = createShadowGraph({ now: () => NOW }); replayed.importData(rebuilt.projection);
      assert.equal(replayed.context({ project: 'p' }).failedAttempts.some(x => x.id === old.id), false);
      assert.equal(replayed.search('staging', { project: 'p' }).items.find(x => x.record.id === old.id).record.derivationState, 'superseded');
      assert.deepEqual(privilegedSnapshot(fresh).records, before.records);
      assert.deepEqual(await store.load(), before);
    } finally { store.close(); }
  });
  test(`PR42 reader ${type}: queued reprocessing fails closed before a reader-floor worker invokes extraction`, skip, async t => {
    const root = await scratchDirectory(t, 'shadowgraph-pr42-floor-');
    const graph = createShadowGraph({ now: () => NOW });
    const item = privilegedRecordCapture(graph, { project: 'p', originId: 'fixture', text: 'Synthetic queue fixture.', source: { event: 'Stop', sessionId: 's' }, admission: { limits: { maxStoreBytes: 2 ** 30, maxQueueDepth: 100, maxItemBytes: 2 ** 20, maxItemsPerSession: 100 }, storeBytes: 0 } });
    const data = privilegedSnapshot(graph);
    data.records.find(x => x.id === item.id).reprocessRequest = { id: 'synthetic-request', actor: 'owner', surface: 'cli', at: NOW };
    const options = { type, file: join(root, 'memory'), env: { SHADOWGRAPH_HOME: root }, project: 'p', now: () => NOW };
    const store = await createStorage(options);
    try {
      await store.save(data); const before = await store.load();
      let invoked = 0;
      await assert.rejects(runExtractionItem({ ...options, executor: { invoke() { invoked++; throw Error('must not invoke'); } } }), { code: 'capture_reprocessing_unsupported' });
      assert.equal(invoked, 0);
      assert.deepEqual(await store.load(), before);
    } finally { store.close(); }
  });
}

test('PR42 reader: a new supersession edge invalidates a compact handle and expansion links both representations', () => {
  const { graph, old, next, link } = fixture();
  const item = graph.context({ project: 'p', query: 'staging', compact: true }).relevant.items.find(x => x.line?.recordId === old.id);
  assert.ok(item?.line);
  link();
  const { operation, scope, ...handle } = item.line.expansion;
  const result = graph.expand({ project: 'p', ...handle });
  assert.equal(result.status, 'revision_changed');
  assert.equal(result.record.derivationState, 'superseded');
  assert.ok(result.investigation.pairs.some(x => x.recordId === next.id && x.relation === 'superseded_by'));
  const snapshot = privilegedSnapshot(graph);
  const rebuilt = privilegedRebuild(graph);
  assert.equal(rebuilt.rebuildable, true);
  assert.deepEqual(privilegedSnapshot(graph).records, snapshot.records, 'projection is never persisted');
});

test('PR42 reader: generic, different-capture and cross-owner links do not suppress attempts', () => {
  for (const variation of ['no_capture', 'other_capture', 'other_project', 'other_origin', 'forged_projection', 'forged_without_capture']) {
    const { graph, old, next } = fixture();
    const data = privilegedSnapshot(graph);
    const replacement = data.records.find(x => x.id === next.id);
    if (variation === 'no_capture') delete replacement.captureRef;
    if (variation === 'other_capture') replacement.captureRef = 'another-capture';
    if (variation === 'other_project') replacement.project = 'q';
    if (variation === 'other_origin') replacement.originId = 'another-origin';
    data.relations = [{ id: 'fixture-edge', kind: 'relation', from: next.id, to: old.id, relation: 'supersedes', createdAt: NOW }];
    if (variation.startsWith('forged_')) {
      data.relations = [];
      data.records.find(x => x.id === old.id).derivationState = 'superseded';
      if (variation === 'forged_without_capture') delete data.records.find(x => x.id === old.id).captureRef;
    }
    graph.replaceData(data);
    const result = graph.context({ project: 'p' });
    assert.ok(result.failedAttempts.some(x => x.id === old.id), variation);
    assert.equal(result.failedAttempts.find(x => x.id === old.id).derivationState, undefined, `${variation}: working-set presentation`);
    const fallback = graph.context({ project: 'p', query: 'zebra' }).relevant.items.find(x => x.record?.id === old.id);
    assert.equal(fallback.temporalEvidence.currentState, null, `${variation}: fallback has no explicit supersession proof`);
    assert.equal(graph.search('staging', { project: 'p' }).items.find(x => x.record.id === old.id).record.derivationState, undefined);
  }
});
