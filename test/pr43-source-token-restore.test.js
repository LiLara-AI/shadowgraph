import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { privilegedSnapshot, privilegedLiveSnapshot, privilegedRebuild, privilegedReapplyDeletion } from '../src/internal/snapshot.js';
import { ledgerPath, readLedger, classifyRestore } from '../src/internal/deletion-knowledge.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { applyQuarantine } from '../src/internal/quarantine.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
const now = () => '2026-10-04T00:00:00.000Z';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
for (const mode of ['logical', 'hard']) test(`${mode} source cleanup and token assignment keep a keyed attempt retry coherent`, () => {
  const graph = createShadowGraph({ now });
  const source = graph.addDecision({ project: 'source', title: 'Source', chosen: 'Source' });
  const input = { project: 'keep', solution: 'Accepted solution', result: 'Accepted result', idempotencyKey: 'attempt' };
  const attempt = graph.addAttempt(input), payload = privilegedSnapshot(graph);
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === attempt.id && value.kind === 'attempt') {
      delete value.erasureToken;
      value.claims = [{ class: 'quoted', verifierVersion: 'fixture', text: input.solution, sourceRef: source.id, evidence: 'ATTEMPT SOURCE COPY' }];
    } else for (const child of Object.values(value)) visit(child);
  };
  visit(payload); validateRestorePayload(payload);
  const loaded = createShadowGraph({ now }); loaded.importData(payload);
  const result = privilegedReapplyDeletion(loaded, { remove: [{ id: source.id, mode }], quarantine: [{ id: attempt.id }] });
  const after = privilegedSnapshot(loaded), kept = after.records.find(x => x.id === attempt.id);
  assert.equal(kept.erasureToken, result.assignedTokens[0]);
  assert.equal(after.idempotency[0].value.erasureToken, kept.erasureToken);
  assert.equal(JSON.stringify(after).includes('ATTEMPT SOURCE COPY'), false);
  assert.equal(loaded.addAttempt(input).id, attempt.id);
  validateRestorePayload(after);
  const rebuilt = privilegedRebuild(loaded); assert.deepEqual(rebuilt.skipped, []);
  assert.deepEqual(rebuilt.projection.records.find(x => x.id === attempt.id), kept);
});
for (const type of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) for (const cited of [true, false]) for (const stage of cited ? [null, 'beforePostStep', 'postStepLedgerWritten', 'postStepCommitted'] : [null]) {
  test(`${type} ${mode} tokenless survivor quarantine composes with source cleanup=${cited}, interruption=${stage}`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr43-source-token-'), env = { SHADOWGRAPH_HOME: join(root, 'home') };
    const graph = createShadowGraph({ now });
    const source = graph.addDecision({ project: 'source', title: 'Source', chosen: 'Source' });
    const memory = graph.remember({ project: 'keep', memoryType: 'note', key: 'experience', text: 'Accepted experience', idempotencyKey: 'retry' }).memory;
    const payload = privilegedSnapshot(graph);
    const decorate = value => {
      if (!value || typeof value !== 'object') return;
      if (value.id === memory.id && value.kind === 'memory') {
        delete value.erasureToken;
        if (cited) value.claims = [{ class: 'quoted', verifierVersion: 'fixture', text: 'Accepted experience', sourceRef: source.id, evidence: 'SOURCE COPY MUST DISAPPEAR' }];
      } else for (const child of Object.values(value)) decorate(child);
    };
    decorate(payload); validateRestorePayload(payload);
    const tombstone = { kind: 'project', purgedProject: 'source', mode, at: now(), seq: 1,
      tokens: [payload.records.find(x => x.id === source.id).erasureToken], moveIn: 'unknown' };
    const plan = classifyRestore(payload, { tombstones: [tombstone] }, { live: [], descent: false, descentMode: null, overlap: [], postdated: [] });
    assert.ok(plan.remove.some(x => x.id === source.id)); assert.ok(plan.quarantine.some(x => x.id === memory.id));
    const file = join(root, 'source'), backup = join(root, 'backup'), destination = join(root, 'target');
    const store = await createStorage({ type, file, env }); t.after(() => store.close());
    await store.save(payload); await backupFile(file, backup, { store, env }); const backupBytes = await readFile(backup);
    let minted;
    const restoreFault = stage ? async at => {
      if (at === stage) { minted = (await readLedger(destination)).pending[0].minted; throw new Error('synthetic source-token interruption'); }
    } : undefined;
    const target = await createStorage({ type, file: destination, env, restoreFault }); t.after(() => target.close());
    await target.save(privilegedSnapshot(createShadowGraph({ now })));
    await writeFile(ledgerPath(destination), JSON.stringify({ version: 1, tombstones: [tombstone] }));
    const options = { env, now: now(), restoreFault };
    const result = type === 'json' ? await restoreFile(backup, destination, options) : await target.restore(backup, options);
    if (stage) {
      assert.equal(result.completion, 'pending');
      const pending = await target.load(), view = createShadowGraph({ now }); view.importData(pending);
      assert.equal(privilegedLiveSnapshot(view).records.some(x => [source.id, memory.id].includes(x.id)), false);
      await backupFile(destination, join(root, 'recovered'), { store: target, env });
    }
    const restored = await target.load(), kept = restored.records.find(x => x.id === memory.id);
    assert.equal(restored.records.some(x => x.id === source.id), false);
    assert.equal(typeof kept.erasureToken, 'string'); assert.equal(kept.text, memory.text);
    if (minted) assert.deepEqual(minted, [kept.erasureToken], 'recovery reuses the reserved token');
    if (cited) {
      assert.equal(kept.claims[0].sourceAvailability, 'unavailable');
      assert.equal(kept.claims[0].class, 'quoted'); assert.equal(kept.claims[0].verifierVersion, 'fixture');
      assert.equal(JSON.stringify(restored).includes('SOURCE COPY MUST DISAPPEAR'), false);
    }
    const loaded = createShadowGraph({ now }); loaded.importData(restored);
    assert.equal(privilegedLiveSnapshot(loaded).records.some(x => x.id === memory.id), false);
    // Rebuild the persisted (privileged) state, including its held entity.
    const plain = createShadowGraph({ now }); plain.importData(JSON.parse(JSON.stringify(restored)));
    const rebuilt = privilegedRebuild(plain); assert.deepEqual(rebuilt.skipped, []);
    assert.deepEqual(rebuilt.projection.records.find(x => x.id === memory.id), kept);
    assert.equal(restored.idempotency.find(x => x.value?.id === memory.id).value.erasureToken, kept.erasureToken);
    assert.equal((await readLedger(destination)).pending.length, 0);
    await backupFile(destination, join(root, 'post'), { store: target, env });
    assert.deepEqual(await target.load(), restored, 'settled recovery does not assign a second token');
    await applyQuarantine(target, 'release', [memory.id], { now });
    const released = createShadowGraph({ now }); released.importData(await target.load());
    assert.equal(privilegedLiveSnapshot(released).records.find(x => x.id === memory.id).erasureToken, kept.erasureToken);
    assert.deepEqual(await readFile(backup), backupBytes);
  });
}
