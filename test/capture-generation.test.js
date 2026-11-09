import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { generationIssue, joinGenerations, restoreGeneration, effectiveGeneration, invalidatedCaptureTokens } from '../src/internal/capture-generation.js';
import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { ledgerPath, readLedger } from '../src/internal/deletion-knowledge.js';
import { privilegedExpireCapture } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';

const START = '2026-10-01T00:00:00.000Z';
const END = '2026-10-08T00:00:00.000Z';
const admission = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 10000, maxItemBytes: 2 ** 20, maxItemsPerSession: 10000 }, storeBytes: 0 };
function fixture() {
  const graph = createShadowGraph({ now: () => START });
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic-origin', text: 'The fixture completed in staging.', admission, source: { event: 'UserPromptSubmit', sessionId: 'synthetic-session' } });
  return { graph, item, payload: privilegedSnapshot(graph) };
}

test('generation ledger validates counters and refuses ambiguous or overflowing state', () => {
  assert.equal(generationIssue({}), null);
  assert.equal(generationIssue({ generationBase: 3, generationCounters: [{ token: 'opaque', counter: 4 }] }), null);
  for (const state of [{ generationBase: -1 }, { generationBase: 1.5 }, { generationBase: Number.MAX_SAFE_INTEGER + 1 }, { generationCounters: {} }, { generationCounters: [{ token: '', counter: 1 }] }, { generationCounters: [{ token: 't', counter: -1 }] }, { generationCounters: [{ token: 't', counter: 1 }, { token: 't', counter: 2 }] }]) assert.ok(generationIssue(state));
});

test('generation joins by maxima; every real restore advances base even with no sidecar', () => {
  const a = { generationBase: 5, generationCounters: [{ token: 'a', counter: 9 }, { token: 'b', counter: 2 }] };
  const b = { generationBase: 2, generationCounters: [{ token: 'a', counter: 3 }, { token: 'c', counter: 4 }] };
  assert.deepEqual(joinGenerations(a, b), { generationBase: 5, generationCounters: [{ token: 'a', counter: 9 }, { token: 'b', counter: 2 }, { token: 'c', counter: 4 }] });
  assert.deepEqual(joinGenerations(a, a), a);
  assert.equal(restoreGeneration(a, b).generationBase, 6);
  assert.equal(restoreGeneration(a, null).generationBase, 6);
  assert.equal(restoreGeneration(null, null).generationBase, 1);
  assert.throws(() => restoreGeneration({ generationBase: Number.MAX_SAFE_INTEGER }, null));
});

test('effective generation uses the fenced clock and cannot treat expiry as usable raw', () => {
  const { item, payload } = fixture();
  const ledger = { generationBase: 10, generationCounters: [{ token: item.erasureToken, counter: 3 }] };
  assert.equal(effectiveGeneration(item, ledger, payload, START), 13);
  assert.equal(effectiveGeneration(item, ledger, payload, END), 14);
  assert.equal(effectiveGeneration({ ...item, blockedReason: 'raw_expired' }, ledger, payload, START), 14);
  assert.throws(() => effectiveGeneration(item, ledger, payload, 'invalid'));
  assert.throws(() => effectiveGeneration(item, { generationBase: Number.MAX_SAFE_INTEGER }, payload, END));
});

test('invalidating persistent changes cover attribution, raw redaction, cancellation, removal and referenced corrections', () => {
  const { item, payload } = fixture();
  const changed = (edit) => { const next = structuredClone(payload); edit(next); return invalidatedCaptureTokens(payload, next); };
  for (const edit of [
    next => { next.records[0].project = 'q'; },
    next => { next.records[0].cancelRequested = true; },
    next => { next.captureContent[0].text = 'redacted'; },
    next => { next.records = []; },
    next => { next.captureContent = []; }
  ]) assert.deepEqual(changed(edit), [item.erasureToken]);
  assert.deepEqual(changed(next => { next.records[0].lease = { leaseId: 'a', ownerId: 'b', ownerBootId: 'c', leaseExpiresAt: END }; next.records[0].state = 'processing'; }), [], 'claim alone does not invalidate its own generation');
  const before = structuredClone(payload);
  before.records.push({ id: 'm', kind: 'memory', project: 'p', attribution: 'project', text: 'Before', status: 'active', erasureToken: 'memory-token' });
  before.records[0].producedRecordIds = ['m'];
  const after = structuredClone(before); after.records[1].status = 'superseded';
  assert.deepEqual(invalidatedCaptureTokens(before, after), [item.erasureToken]);
});

const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
for (const type of ['json', 'sqlite']) {
  const options = type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {};
  test(`generation ${type}: malformed state refuses load; invalidation persists before payload and opaque members survive`, options, async t => {
    const root = await scratchDirectory(t); const file = join(root, 'memory');
    const env = { SHADOWGRAPH_HOME: root };
    let failCommit = false;
    const store = await createStorage({ type, file, env, saveFault: stage => { if (failCommit && stage === 'beforeCommit') throw new Error('Synthetic payload failure'); } }); t.after(() => store.close());
    const { item, payload } = fixture(); await store.save(payload);
    await writeFile(ledgerPath(file), JSON.stringify({ version: 1, generationBase: -1 }));
    await assert.rejects(store.load(), { code: 'control_ledger_malformed' });
    await writeFile(ledgerPath(file), JSON.stringify({ version: 1, generationBase: 4, generationCounters: [{ token: item.erasureToken, counter: 2 }], future: { opaque: true } }));
    const before = await store.load(); const next = structuredClone(before);
    next.captureContent[0].text = 'The fixture was redacted.';
    await store.save(next);
    const ledger = await readLedger(file);
    assert.equal(ledger.generationBase, 4);
    assert.equal(ledger.generationCounters.find(entry => entry.token === item.erasureToken).counter, 3);
    assert.deepEqual(JSON.parse(await readFile(ledgerPath(file), 'utf8')).future, { opaque: true });
    const persisted = await store.load(); const failed = structuredClone(persisted); failed.captureContent[0].text = 'Another redaction.';
    failCommit = true;
    await assert.rejects(store.save(failed), /Synthetic payload failure/u);
    assert.deepEqual(await store.load(), persisted, 'payload failure preserves old material');
    assert.equal((await readLedger(file)).generationCounters.find(entry => entry.token === item.erasureToken).counter, 4, 'durable invalidation precedes the failed payload commit');
  });

  test(`generation ${type}: backup carries counters and restore advances base with and without either sidecar`, options, async t => {
    const root = await scratchDirectory(t); const file = join(root, 'memory'), backup = join(root, 'backup');
    const env = { SHADOWGRAPH_HOME: root };
    const store = await createStorage({ type, file, env }); t.after(() => store.close());
    const { payload } = fixture(); await store.save(payload);
    await writeFile(ledgerPath(file), JSON.stringify({ version: 1, generationBase: 5, generationCounters: [{ token: 'opaque-counter', counter: 8 }] }));
    await backupFile(file, backup, { store, env });
    const restore = () => type === 'json' ? restoreFile(backup, file, { env, now: START }) : store.restore(backup, { now: START });
    await restore();
    assert.equal((await readLedger(file)).generationBase, 6);
    assert.deepEqual((await readLedger(file)).generationCounters, [{ token: 'opaque-counter', counter: 8 }]);
    await unlink(ledgerPath(file));
    await restore();
    assert.equal((await readLedger(file)).generationBase, 6, 'missing destination uses backup base');
    await unlink(ledgerPath(backup));
    await restore();
    assert.equal((await readLedger(file)).generationBase, 7, 'missing backup sidecar still advances destination');
  });

  test(`generation ${type}: hook expiry never writes ledger, registry or resolves pending work`, options, async t => {
    const root = await scratchDirectory(t); const file = join(root, 'memory');
    const env = { SHADOWGRAPH_HOME: root };
    const store = await createStorage({ type, file, env }); t.after(() => store.close());
    const { item, payload } = fixture(); await store.save(payload);
    const bytes = JSON.stringify({ version: 1, generationBase: 3 });
    await writeFile(ledgerPath(file), bytes);
    await store.update(current => {
      const graph = createShadowGraph({ now: () => END }); graph.importData(current);
      privilegedExpireCapture(graph); return privilegedSnapshot(graph);
    });
    assert.equal(await readFile(ledgerPath(file), 'utf8'), bytes);
    const expired = (await store.load()).records.find(value => value.id === item.id);
    assert.equal(expired.contentRef, null);
    assert.equal(effectiveGeneration(expired, await readLedger(file), await store.load(), START), 4);
    await assert.rejects(readFile(join(root, 'deletion-registry.json')), { code: 'ENOENT' });
  });
  test(`generation ${type}: hook update refuses an arbitrary raw mutation without side effects`, options, async t => {
    const root = await scratchDirectory(t); const file = join(root, 'memory');
    const store = await createStorage({ type, file, env: { SHADOWGRAPH_HOME: root } }); t.after(() => store.close());
    await store.save(fixture().payload);
    const before = await store.load();
    await assert.rejects(store.update(current => { current.captureContent[0].text = 'Arbitrary replacement'; return current; }), { code: 'capture_hook_invalidating_write' });
    assert.deepEqual(await store.load(), before);
    await assert.rejects(readFile(ledgerPath(file)), { code: 'ENOENT' });
  });
}
