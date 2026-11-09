import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { privilegedRecordCapture, privilegedInspectCapture, privilegedSnapshot, privilegedRebuild } from '../src/internal/snapshot.js';
import * as primitives from '../src/internal/snapshot.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { effectiveGeneration } from '../src/internal/capture-generation.js';
import { readLedger } from '../src/internal/deletion-knowledge.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const START = '2026-10-04T00:00:00.000Z';
const TEXT = 'The fixture completed in staging.';
const admission = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 1000, maxItemBytes: 2 ** 20, maxItemsPerSession: 1000 }, storeBytes: 0 };
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
async function fixture(t, type, kind = 'memory', initialTexts = [TEXT]) {
  const root = await scratchDirectory(t, 'shadowgraph-pr42-reprocess-');
  let at = START;
  const options = { type, file: join(root, 'memory'), env: { SHADOWGRAPH_HOME: root }, project: 'p', now: () => at };
  const graph = createShadowGraph({ now: options.now });
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic', text: TEXT, admission, source: { event: 'UserPromptSubmit', sessionId: 'synthetic-session' } });
  const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
  const read = async () => { const s = await createStorage(options); try { return await s.load(); } finally { s.close(); } };
  const mutate = async change => { const s = await createStorage(options); try { await s.update(change); } finally { s.close(); } };
  const output = text => ({ status: 'success', value: { records: [{ kind, fields: (kind === 'memory' ? ['text'] : kind === 'decision' ? ['title', 'chosen'] : ['solution', 'result']).map(name => ({ name, text, sourceRef: item.id })) }] }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } });
  const response = { ...output(TEXT), value: { records: initialTexts.flatMap(text => output(text).value.records) } };
  assert.equal((await commitCapture(options, await claimCapture(options), response)).status, 'committed');
  const inspect = async () => { const g = createShadowGraph({ now: options.now }); g.importData(await read()); return privilegedInspectCapture(g, { project: 'p', id: item.id }).items[0]; };
  const request = async (input = {}) => {
    const s = await createStorage(options);
    try {
      const g = createShadowGraph({ now: options.now }); g.importData(await s.load());
      const result = primitives.privilegedRequestReprocess(g, { project: 'p', id: item.id, ...input });
      await s.save(privilegedSnapshot(g)); return result;
    } finally { s.close(); }
  };
  const ownerEdit = async edit => {
    const s = await createStorage(options);
    try { const g = createShadowGraph({ now: options.now }); g.importData(await s.load()); edit(g); await s.save(privilegedSnapshot(g)); }
    finally { s.close(); }
  };
  return { options, item, read, mutate, inspect, request, response, output, ownerEdit, clock: value => { at = value; } };
}

for (const type of ['json', 'sqlite']) {
  const skip = type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {};
  test(`PR42 ${type}: changed and identical proposals preserve current identities in either order and on repeat`, skip, async t => {
    for (const texts of [[TEXT, 'fixture completed in staging.'], ['fixture completed in staging.', TEXT]]) {
      const f = await fixture(t, type), original = (await f.read()).records.find(x => x.kind === 'memory');
      const response = { ...f.response, value: { records: texts.flatMap(text => f.output(text).value.records) } };
      for (let run = 0; run < 2; run++) {
        await f.request();
        assert.equal((await commitCapture(f.options, await claimCapture(f.options), response)).status, 'committed');
        const snapshot = await f.read(), ids = snapshot.records.find(x => x.id === f.item.id).producedRecordIds;
        assert.equal(ids.length, 2);
        assert.ok(ids.includes(original.id), 'the unchanged ID is retained');
        assert.deepEqual(snapshot.records.find(x => x.id === original.id), original, 'unchanged provenance is retained');
        assert.deepEqual(ids.map(id => snapshot.records.find(x => x.id === id).text).sort(), [...texts].sort());
        assert.ok(ids.every(id => snapshot.records.find(x => x.id === id).status === 'active'));
        assert.equal((await f.inspect()).lastReprocessing.preservedCorrections, 0);
      }
    }
  });
  test(`PR42 ${type}: extraction-owned decision merge links do not become fictitious owner corrections`, skip, async t => {
    const f = await fixture(t, type, 'decision', [TEXT, 'fixture completed in staging.']);
    const original = (await f.read()).records.find(x => x.kind === 'decision' && x.title === TEXT);
    await f.request();
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), f.output(TEXT))).status, 'committed');
    const merged = await f.read();
    assert.deepEqual(merged.records.find(x => x.id === f.item.id).producedRecordIds, [original.id]);
    assert.equal(merged.records.find(x => x.id === original.id).supersedes.length, 1);
    await f.request();
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), f.output('The fixture completed in staging'))).status, 'committed');
    const after = await f.read(), ids = after.records.find(x => x.id === f.item.id).producedRecordIds;
    assert.equal(ids.length, 1);
    assert.notEqual(ids[0], original.id);
    assert.equal(after.records.find(x => x.id === original.id).status, 'superseded');
    assert.equal((await f.inspect()).lastReprocessing.preservedCorrections, 0);
    assert.equal((await f.inspect()).derivedInvalidated, false, 'internal history-link receipts are not cited current-record evidence');
    assert.equal((await f.inspect()).reprocessable, false, 'completed current output has neither recipe drift nor owner correction');
    const graph = createShadowGraph({ now: f.options.now }); graph.importData(after);
    const byId = values => [...values].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(privilegedRebuild(graph).projection.records), byId(after.records));
  });
  test(`PR42 ${type}: writer linkage witnesses never adopt a later owner change or leak receipt members`, skip, async t => {
    const f = await fixture(t, type, 'decision', [TEXT, 'fixture completed in staging.']);
    const original = (await f.read()).records.find(x => x.kind === 'decision' && x.title === TEXT);
    await f.request();
    await commitCapture(f.options, await claimCapture(f.options), f.output(TEXT));
    await f.ownerEdit(graph => graph.updateDecisionStatus(original.id, 'planned', { project: 'p' }));
    const corrected = (await f.read()).records.filter(x => x.kind !== 'capture');
    for (let run = 0; run < 2; run++) {
      await f.request();
      await commitCapture(f.options, await claimCapture(f.options), f.output('The fixture completed in staging'));
      assert.deepEqual((await f.read()).records.filter(x => x.kind !== 'capture'), corrected);
      assert.equal((await f.inspect()).lastReprocessing.preservedCorrections, 1);
    }
    await f.mutate(data => {
      data.records.find(x => x.id === f.item.id).receipts.at(-1).reprocessing = {
        preservedCorrections: 'private-count', skippedProposals: { nested: 'private-proposal' }, retainedPriorEvidence: 'private-flag',
        future: { raw: 'private-raw' }, linkageUpdates: [{ recordId: 'private-id', before: 'private-hash' }]
      };
      return data;
    });
    const before = await f.read(), inspection = await f.inspect();
    assert.deepEqual(inspection.lastReprocessing, {});
    assert.equal(JSON.stringify(inspection).includes('private-'), false);
    assert.deepEqual(await f.read(), before);
  });
  test(`PR42 ${type}: recipe drift is queryable and never queues an extraction`, skip, async t => {
    for (const field of ['promptVersion', 'schemaVersion', 'model']) {
      const f = await fixture(t, type);
      assert.equal((await f.inspect()).reprocessable, false);
      await f.mutate(data => { data.records.find(x => x.id === f.item.id).receipts.at(-1)[field] = 'previous-version'; return data; });
      const before = await readFile(f.options.file), snapshot = await f.read();
      const status = await f.inspect();
      assert.equal(status.reprocessable, true, field);
      assert.equal(status.recipeChanged, true);
      assert.ok(status.reprocessReasons.includes(field));
      assert.equal(status.state, 'extracted');
      assert.deepEqual(await f.read(), snapshot, 'inspection changes no queue, receipt or derived record');
      assert.deepEqual(await readFile(f.options.file), before);
      f.clock('2026-10-12T00:00:00.000Z');
      const expired = await f.inspect();
      assert.equal(expired.reprocessable, false);
      assert.equal(expired.reprocessingUnavailableReason, 'raw_expired');
    }
  });
  test(`PR42 ${type}: explicit reprocess request preserves history, advances generation and defeats an in-flight result`, skip, async t => {
    const f = await fixture(t, type), before = await f.read();
    const item = before.records.find(x => x.id === f.item.id);
    const generation = effectiveGeneration(item, await readLedger(f.options.file), before, f.options.now());
    assert.equal(typeof primitives.privilegedRequestReprocess, 'function', 'owner-only request primitive exists');
    const result = await f.request();
    assert.equal(result.state, 'pending');
    const after = await f.read(), pending = after.records.find(x => x.id === f.item.id);
    assert.deepEqual(pending.producedRecordIds, item.producedRecordIds);
    assert.deepEqual(after.records.filter(x => x.kind !== 'capture'), before.records.filter(x => x.kind !== 'capture'));
    assert.deepEqual(after.captureContent, before.captureContent);
    assert.equal(pending.reprocessRequest.actor, 'owner');
    assert.equal(pending.reprocessRequest.surface, 'cli');
    assert.ok(effectiveGeneration(pending, await readLedger(f.options.file), after, f.options.now()) > generation);
    const claim = await claimCapture(f.options);
    await f.request();
    assert.equal((await commitCapture(f.options, claim, f.response)).status, 'superseded_result');
    assert.deepEqual((await f.read()).records.filter(x => x.kind !== 'capture'), before.records.filter(x => x.kind !== 'capture'));
  });
  test(`PR42 ${type}: reprocessing refuses other ownership and expired raw without changing the store`, skip, async t => {
    const f = await fixture(t, type), before = await readFile(f.options.file);
    assert.equal(typeof primitives.privilegedRequestReprocess, 'function', 'owner-only request primitive exists');
    await assert.rejects(f.request({ project: 'q' }), { code: 'capture_item_not_found' });
    assert.deepEqual(await readFile(f.options.file), before);
    f.clock('2026-10-12T00:00:00.000Z');
    await assert.rejects(f.request(), { code: 'raw_expired' });
    assert.deepEqual(await readFile(f.options.file), before, 'cited raw cannot be re-extracted after its raw retention deadline');
  });
  for (const kind of ['memory', 'decision', 'attempt']) {
    test(`PR42 ${type}: reprocessing ${kind} replaces its representation and retains linked history`, skip, async t => {
      const f = await fixture(t, type, kind), before = await f.read();
      const old = before.records.find(x => x.kind === kind);
      await f.request();
      const claim = await claimCapture(f.options);
      const result = await commitCapture(f.options, claim, f.output('fixture completed in staging.'));
      assert.equal(result.status, 'committed');
      const after = await f.read(), item = after.records.find(x => x.id === f.item.id);
      assert.equal(item.producedRecordIds.length, 1);
      assert.notEqual(item.producedRecordIds[0], old.id);
      const graph = createShadowGraph({ now: f.options.now }); graph.importData(after);
      const historical = kind === 'memory'
        ? graph.memoryHistory({ project: 'p', memoryType: old.memoryType, key: old.key }).items.find(x => x.id === old.id)
        : graph.search('staging', { project: 'p' }).items.find(x => x.record.id === old.id).record;
      assert.equal(kind === 'attempt' ? historical.derivationState : historical.status, 'superseded');
      assert.ok([historical.supersededBy].flat().includes(item.producedRecordIds[0]));
      assert.equal(after.records.filter(x => x.kind === kind).length, 2, 'one historical and one replacement representation');
      assert.equal((await commitCapture(f.options, claim, f.output('fixture completed in staging.'))).status, 'superseded_result');
      assert.deepEqual((await f.read()).records.filter(x => x.kind !== 'capture'), after.records.filter(x => x.kind !== 'capture'), 'late replay cannot append a third representation');
    });
  }
  test(`PR42 ${type}: reprocessing never supersedes an owner-corrected memory, even with the same timestamp`, skip, async t => {
    const f = await fixture(t, type), before = await f.read();
    const original = before.records.find(x => x.kind === 'memory');
    await f.ownerEdit(graph => graph.remember({ project: 'p', originId: original.originId, memoryType: original.memoryType, key: original.key, text: 'Owner correction preserved.' }));
    const corrected = (await f.read()).records.filter(x => x.kind !== 'capture');
    await f.request();
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), f.response)).status, 'committed');
    assert.deepEqual((await f.read()).records.filter(x => x.kind !== 'capture'), corrected);
    assert.ok((await f.read()).records.some(x => x.text === 'Owner correction preserved.' && x.status === 'active'));
  });
  test(`PR42 ${type}: empty supported output preserves prior canonical evidence instead of erasing it`, skip, async t => {
    const f = await fixture(t, type), before = await f.read();
    await f.request();
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), { ...f.response, value: { records: [] } })).status, 'committed');
    const after = await f.read();
    assert.deepEqual(after.records.filter(x => x.kind !== 'capture'), before.records.filter(x => x.kind !== 'capture'));
    assert.deepEqual(after.records.find(x => x.id === f.item.id).producedRecordIds, before.records.find(x => x.id === f.item.id).producedRecordIds);
    assert.equal((await f.inspect()).lastReprocessing.retainedPriorEvidence, true);
  });
  test(`PR42 ${type}: an identical memory reprocess does not create duplicate history or rewrite prior provenance`, skip, async t => {
    const f = await fixture(t, type), before = await f.read();
    await f.request();
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), f.response)).status, 'committed');
    const after = await f.read();
    assert.deepEqual(after.records.filter(x => x.kind !== 'capture'), before.records.filter(x => x.kind !== 'capture'));
    assert.deepEqual(after.journal.filter(x => x.entityKind === 'memory'), before.journal.filter(x => x.entityKind === 'memory'));
  });
  test(`PR42 ${type}: cancellation of a reprocess request leaves existing experience intact and defeats its late result`, skip, async t => {
    const f = await fixture(t, type), before = await f.read();
    await f.request(); const claim = await claimCapture(f.options);
    await f.ownerEdit(graph => primitives.privilegedCancelCapture(graph, { project: 'p', id: f.item.id }));
    assert.equal((await commitCapture(f.options, claim, f.response)).status, 'superseded_result');
    assert.deepEqual((await f.read()).records.filter(x => x.kind !== 'capture'), before.records.filter(x => x.kind !== 'capture'));
    assert.equal((await claimCapture(f.options)).status, 'idle');
  });

  test(`PR42 ${type}: replacement can split, merge and change kind without accumulating current copies`, skip, async t => {
    const f = await fixture(t, type), original = (await f.read()).records.find(x => x.kind === 'memory');
    await f.request();
    const split = { ...f.response, value: { records: ['fixture completed in staging.', 'The fixture completed in staging'].map(text => f.output(text).value.records[0]) } };
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), split)).status, 'committed');
    let snapshot = await f.read(), ids = snapshot.records.find(x => x.id === f.item.id).producedRecordIds;
    assert.equal(ids.length, 2);
    assert.equal(snapshot.records.find(x => x.id === original.id).status, 'superseded');
    assert.equal(snapshot.records.filter(x => x.kind === 'memory' && x.status === 'active').length, 2);
    await f.request();
    const merged = { ...f.response, value: { records: [{ kind: 'decision', fields: ['title', 'chosen'].map(name => ({ name, text: TEXT, sourceRef: f.item.id })) }] } };
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), merged)).status, 'committed');
    snapshot = await f.read();
    const current = snapshot.records.find(x => x.id === f.item.id).producedRecordIds;
    assert.equal(current.length, 1);
    assert.equal(snapshot.records.find(x => x.id === current[0]).kind, 'decision');
    assert.equal(snapshot.records.filter(x => x.kind === 'memory' && x.status === 'active').length, 0);
    for (const id of ids) {
      assert.equal(snapshot.records.find(x => x.id === id).status, 'superseded');
      assert.ok(snapshot.relations.some(x => x.from === current[0] && x.to === id && x.relation === 'supersedes'));
    }
    const graph = createShadowGraph({ now: f.options.now }); graph.importData(snapshot);
    const replayed = privilegedRebuild(graph);
    assert.equal(replayed.rebuildable, true);
    const byId = values => [...values].sort((a, b) => a.id.localeCompare(b.id));
    assert.deepEqual(byId(replayed.projection.records), byId(snapshot.records), 'replay retains every canonical record and capture field');
    assert.deepEqual(byId(replayed.projection.relations), byId(snapshot.relations));
  });

  test(`PR42 ${type}: a same-clock owner change to a decision is preserved on reprocessing`, skip, async t => {
    const f = await fixture(t, type, 'decision'), old = (await f.read()).records.find(x => x.kind === 'decision');
    await f.ownerEdit(graph => graph.updateDecisionStatus(old.id, 'planned', { project: 'p' }));
    const corrected = (await f.read()).records.filter(x => x.kind !== 'capture');
    await f.request();
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), f.output('fixture completed in staging.'))).status, 'committed');
    assert.deepEqual((await f.read()).records.filter(x => x.kind !== 'capture'), corrected);
    await f.request();
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), f.output('fixture completed in staging.'))).status, 'committed');
    assert.deepEqual((await f.read()).records.filter(x => x.kind !== 'capture'), corrected, 'a skipped reprocess never adopts the owner edit as model-owned output');
    assert.equal((await f.inspect()).lastReprocessing.preservedCorrections, 1);
  });

  test(`PR42 ${type}: a failed reprocess remains inspectable and can be explicitly requested again without refunding attempts`, skip, async t => {
    const f = await fixture(t, type);
    await f.request();
    assert.equal((await commitCapture(f.options, await claimCapture(f.options), { status: 'failed' })).status, 'executor_failed');
    const failed = (await f.read()).records.find(x => x.id === f.item.id);
    assert.equal(failed.state, 'blocked');
    await f.request();
    const pending = (await f.read()).records.find(x => x.id === f.item.id);
    assert.equal(pending.attempts, failed.attempts);
    assert.deepEqual(pending.receipts, failed.receipts);
    assert.deepEqual(pending.producedRecordIds, failed.producedRecordIds);
    assert.equal(pending.state, 'pending');
  });
}
