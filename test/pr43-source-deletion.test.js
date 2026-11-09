import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { privilegedRecordCapture, privilegedSnapshot, privilegedLiveSnapshot, privilegedRebuild } from '../src/internal/snapshot.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { applyQuarantine } from '../src/internal/quarantine.js';
import { ledgerPath, readLedger } from '../src/internal/deletion-knowledge.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { t1Line } from '../src/compact-tier.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { classifyClaim } from '../src/verification.js';
const NOW = '2026-10-04T00:00:00.000Z';
const TEXT = 'The fixture completed in staging.';
const admission = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 1000, maxItemBytes: 2 ** 20, maxItemsPerSession: 1000 }, storeBytes: 0 };
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
for (const type of ['json', 'sqlite']) test(`${type} authorized quarantine purge removes cited source copies, preserves recorded verification and stays hidden after restore`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
  const root = await scratchDirectory(t, 'pr43-source-delete-');
  const options = { type, file: join(root, 'store'), env: { SHADOWGRAPH_HOME: join(root, 'home') }, project: 'p', now: () => NOW };
  const graph = createShadowGraph({ now: options.now });
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'source-origin', text: TEXT, admission,
    source: { event: 'UserPromptSubmit', sessionId: 'synthetic' } });
  const store = await createStorage(options); t.after(() => store.close());
  await store.save(privilegedSnapshot(graph));
  const response = { status: 'success', value: { records: [{ kind: 'attempt', fields: ['solution', 'result', 'reason'].map(name => ({ name, text: TEXT, sourceRef: item.id })) }] }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } };
  assert.equal((await commitCapture(options, await claimCapture(options), response)).status, 'committed');
  const before = await store.load(), accepted = before.records.find(x => x.kind === 'attempt');
  assert.equal(accepted.claims[0].class, 'quoted');
  assert.ok(accepted.claims[0].evidence); assert.ok(accepted.causalClaim.evidence[0].text);
  const backup = join(root, 'backup'); await backupFile(options.file, backup, { store, env: options.env });
  const backupBytes = await readFile(backup);
  const controls = JSON.parse(await readFile(ledgerPath(options.file), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{"version":1}'; throw error; }));
  controls.quarantine = [{ token: item.erasureToken, reason: 'possibly_purged', at: NOW }];
  await writeFile(ledgerPath(options.file), JSON.stringify(controls));
  // This is the existing owner-only quarantine deletion path, not a widening
  // of pending-item deletion to completed extraction.
  await applyQuarantine(store, 'purge', [item.id], {});
  const check = async (restored = false, target = store) => {
    const stored = await target.load(), loaded = createShadowGraph({ now: options.now }); loaded.importData(stored);
    const payload = privilegedLiveSnapshot(loaded), current = payload.records.find(x => x.id === accepted.id);
    assert.ok(current, 'accepted experience survives its source');
    assert.equal(payload.records.some(x => x.id === item.id), false);
    assert.equal(current.sourceAvailability, 'unavailable');
    assert.equal(current.claims[0].sourceAvailability, 'unavailable');
    assert.equal(Object.hasOwn(current.claims[0], 'evidence'), false);
    assert.equal(Object.hasOwn(current.causalClaim.evidence[0], 'text'), false);
    for (const field of ['solution', 'result', 'reason', 'verificationStatus']) assert.deepEqual(current[field], accepted[field]);
    for (const field of ['class', 'verifierVersion', 'span', 'text']) assert.deepEqual(current.claims[0][field], accepted.claims[0][field]);
    assert.equal(current.causalClaim.class, accepted.causalClaim.class);
    assert.equal(current.causalClaim.state, accepted.causalClaim.state);
    const visit = value => {
      if (!value || typeof value !== 'object') return;
      if (value.sourceRef === item.id) {
        assert.equal(Object.hasOwn(value, 'evidence'), false, 'no evidence copy survives in journal or retry data');
        assert.equal(value.sourceAvailability, 'unavailable');
      }
      for (const child of Object.values(value)) visit(child);
    };
    visit(payload);
    if (!restored) visit(stored);
    // Quarantine has no purge tombstone: restore may bring back hidden raw.
    // Its visible projection is unavailable, while saved originals stay held.
    else {
      assert.ok(stored.records.some(x => x.id === item.id));
      assert.deepEqual(privilegedSnapshot(loaded), stored);
    }
    const replayed = createShadowGraph({ now: options.now }); replayed.importData(payload);
    const rebuilt = privilegedRebuild(replayed);
    assert.deepEqual(rebuilt.skipped, []);
    assert.deepEqual(rebuilt.projection.records.find(x => x.id === accepted.id), current);
    const compact = t1Line(current);
    assert.equal(compact.provenance.sourceAvailability, 'unavailable');
    assert.match(compact.line, /source unavailable/i);
    assert.equal(compact.claimClass, 'quoted');
  };
  await check();
  const restore = () => type === 'json' ? restoreFile(backup, options.file, { env: options.env, now: NOW }) : store.restore(backup, { now: NOW });
  const beforeRefusal = await readFile(options.file), ledgerBefore = await readFile(ledgerPath(options.file));
  await assert.rejects(restore(), /destination holds a transcript cursor/);
  assert.deepEqual(await readFile(options.file), beforeRefusal);
  assert.deepEqual(await readFile(ledgerPath(options.file)), ledgerBefore);
  const freshFile = join(root, 'fresh');
  await writeFile(ledgerPath(freshFile), ledgerBefore);
  const fresh = await createStorage({ ...options, file: freshFile }); t.after(() => fresh.close());
  await (type === 'json' ? restoreFile(backup, freshFile, { env: options.env, now: NOW }) : fresh.restore(backup, { now: NOW }));
  await check(true, fresh);
  assert.deepEqual(await readFile(backup), backupBytes);
  assert.equal((await readLedger(options.file)).pending.length, 0);
});
for (const type of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) for (const scope of ['project', 'origin']) for (const reference of ['id', 'contentRef']) {
  test(`${type} ${mode} ${scope} ${reference} source purge preserves other-owned ambiguous experience and removes its source copies through restore`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr43-source-scope-'), file = join(root, 'store');
    const env = { SHADOWGRAPH_HOME: join(root, 'home') }, text = 'The job stopped. The job stopped in staging.';
    const graph = createShadowGraph({ now: () => NOW });
    const source = privilegedRecordCapture(graph, { ...(scope === 'project' ? { project: 'source' } : {}), originId: 'source', text, admission,
      source: { event: 'UserPromptSubmit', sessionId: 'synthetic' } });
    const accepted = graph.remember({ project: 'keep', memoryType: 'note', key: 'experience', text: 'The job stopped', idempotencyKey: 'retry' }).memory;
    const payload = privilegedSnapshot(graph), claim = { ...classifyClaim({ text: 'The job stopped', sourceRef: source[reference] }, text), evidence: text };
    assert.equal(claim.class, 'ambiguous');
    const decorate = value => {
      if (!value || typeof value !== 'object') return;
      if (value.id === accepted.id && value.kind === 'memory') { value.captureRef = source.id; value.claims = [structuredClone(claim)]; }
      else for (const child of Object.values(value)) decorate(child);
    };
    decorate(payload);
    const store = await createStorage({ type, file, env }); t.after(() => store.close());
    await store.save(payload); const loaded = createShadowGraph({ now: () => NOW }); loaded.importData(await store.load());
    const backup = join(root, 'backup'); await backupFile(file, backup, { store, env });
    const beforeBackup = await readFile(backup);
    if (scope === 'origin') loaded.purgeOrigin('source', { mode }); else loaded.purgeProject('source', { mode });
    // Exercise the live memory index before a reload can rebuild it.
    assert.equal(loaded.recall('job', { project: 'keep' }).items[0].record.claims[0].sourceAvailability, 'unavailable');
    const noOp = loaded.remember({ project: 'keep', memoryType: 'note', key: 'experience', text: 'The job stopped' });
    assert.equal(noOp.operation, 'NOOP');
    assert.equal(noOp.memory.claims[0].sourceAvailability, 'unavailable', 'unkeyed immediate retry uses the updated current index');
    const plan = loaded.applyMemoryPlan({ project: 'keep', operations: [{ action: 'NOOP', memoryType: 'note', key: 'experience' }] });
    assert.equal(JSON.stringify(plan).includes(text), false, 'memory plan cannot expose the old source copy');
    await store.save(privilegedSnapshot(loaded));
    const verify = async target => {
      const current = await target.load();
      assert.equal(current.records.some(x => x.id === source.id), false);
      const retained = current.records.find(x => x.id === accepted.id);
      assert.equal(retained.sourceAvailability, 'unavailable');
      assert.equal(retained.claims[0].class, 'ambiguous');
      assert.equal(retained.claims[0].text, claim.text);
      assert.equal(Object.hasOwn(retained.claims[0], 'readings'), false);
      assert.equal(Object.hasOwn(retained.claims[0], 'evidence'), false);
      const g = createShadowGraph({ now: () => NOW }); g.importData(current);
      const replay = privilegedRebuild(g);
      assert.deepEqual(replay.skipped, []);
      assert.deepEqual(replay.projection.records.find(x => x.id === accepted.id), retained);
      assert.deepEqual(g.remember({ project: 'keep', memoryType: 'note', key: 'experience', text: 'The job stopped', idempotencyKey: 'retry' }).memory.claims, retained.claims);
    };
    await verify(store);
    const freshFile = join(root, 'fresh'), fresh = await createStorage({ type, file: freshFile, env }); t.after(() => fresh.close());
    await (type === 'json' ? restoreFile(backup, freshFile, { env, now: NOW }) : fresh.restore(backup, { now: NOW }));
    await verify(fresh); assert.deepEqual(await readFile(backup), beforeBackup);
  });
}
