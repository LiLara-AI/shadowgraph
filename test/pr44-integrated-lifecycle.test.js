// Synthetic development integration. Actual provider/host proof remains AG3.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import * as kernel from '../src/internal/snapshot.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { runDeliver } from '../src/delivery.js';
import { syncMarkdownWorkspace } from '../src/markdown-workspace.js';
import { readLedger } from '../src/internal/deletion-knowledge.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { deactivateCapture, deactivateExtraction } from '../src/activation.js';
import { activeExtraction } from '../src/internal/extraction-state.js';
import { FROZEN_WORKER_BUDGETS } from '../src/internal/extraction-budget.js';
import { changeHookSettings } from '../src/host-hooks.js';
import { randomUUID } from 'node:crypto';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const text = 'The fixture completed in staging.';
const deliveredIds = context => context.split('\n').filter(line => line.startsWith('item: ')).map(line => JSON.parse(line.slice(6))).map(item => item.expansion?.recordId ?? item.record?.id ?? item.line?.recordId);
const admission = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 100 }, storeBytes: 0 };
for (const type of ['json', 'sqlite']) for (const mode of ['logical', 'hard']) {
  test(`${type} ${mode} integrated capture, extraction, delivery, correction, reprocess, expiry, deletion and restore`, type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    const root = await scratchDirectory(t, 'pr44-integrated-'), cwd = join(root, 'work'), directory = join(root, 'markdown');
    await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
    await writeFile(join(cwd, '.shadowgraph/project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: cwd, project: 'p', confirmed: true }));
    let instant = '2026-10-04T00:00:00.000Z';
    const env = { ...process.env, SHADOWGRAPH_HOME: join(root, 'home') }, now = () => instant;
    const options = { type, file: join(root, 'store'), env, project: 'p', now };
    const store = await createStorage(options); t.after(() => store.close());
    const initial = createShadowGraph({ now });
    const capture = kernel.privilegedRecordCapture(initial, { project: 'p', originId: 'synthetic', text, admission,
      source: { event: 'UserPromptSubmit', sessionId: 'synthetic' } });
    const peer = initial.remember({ project: 'q', memoryType: 'note', key: 'peer', text: 'OTHER PROJECT PRIVATE EXPERIENCE' }).memory;
    await store.save(kernel.privilegedSnapshot(initial));
    const response = { status: 'success', receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' },
      value: { records: [{ kind: 'memory', fields: [{ name: 'text', text, sourceRef: capture.id }] }] } };
    const claim = await claimCapture(options); assert.equal(claim.status, 'claimed');
    assert.equal((await commitCapture(options, claim, response)).status, 'committed');
    const load = async () => { const graph = createShadowGraph({ now }); graph.importData(await store.load()); return graph; };
    const mutate = async change => { const graph = await load(); const result = change(graph); await store.save(kernel.privilegedSnapshot(graph)); return result; };
    const deliver = async () => {
      const prior = process.cwd(); process.chdir(cwd); let output = '';
      try { await runDeliver({ file: options.file, storage: type, env, readInput: () => JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'fixture staging owner correction preserved' }), write: value => { output += value; } }); }
      finally { process.chdir(prior); }
      assert.equal(output.includes('OTHER PROJECT PRIVATE EXPERIENCE'), false);
      return output ? JSON.parse(output).hookSpecificOutput.additionalContext : '';
    };
    const beforeCorrection = await store.load(), original = beforeCorrection.records.find(x => x.kind === 'memory' && x.project === 'p');
    assert.ok(deliveredIds(await deliver()).includes(original.id));
    await syncMarkdownWorkspace({ graph: await load(), directory, project: 'p', mode: 'push' });
    const corrected = await mutate(graph => graph.remember({ project: 'p', originId: original.originId, memoryType: original.memoryType, key: original.key, text: 'Owner correction preserved.' }).memory);
    const delivered = await deliver(); assert.ok(deliveredIds(delivered).includes(corrected.id)); assert.equal(deliveredIds(delivered).includes(original.id), false);
    await mutate(graph => kernel.privilegedRequestReprocess(graph, { project: 'p', id: capture.id }));
    const reprocessClaim = await claimCapture(options);
    assert.equal((await commitCapture(options, reprocessClaim, response)).status, 'committed');
    assert.ok((await store.load()).records.some(x => x.id === corrected.id && x.status === 'active'));
    assert.equal((await commitCapture(options, reprocessClaim, response)).status, 'superseded_result');
    const pending = await mutate(graph => kernel.privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic', text: 'Delete pending raw.', admission,
      source: { event: 'UserPromptSubmit', sessionId: 'pending' } }));
    await mutate(graph => kernel.privilegedDeleteCapture(graph, { project: 'p', id: pending.id }));
    assert.equal((await store.load()).records.some(x => x.id === pending.id), false);
    const expiring = await mutate(graph => kernel.privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic', text: 'Expire uncited raw.', admission,
      source: { event: 'UserPromptSubmit', sessionId: 'expiry' } }));
    instant = '2026-10-12T00:00:00.000Z';
    const expiry = await mutate(graph => kernel.privilegedExpireCapture(graph));
    assert.equal(expiry.expired, 1); assert.ok(expiry.keptCited >= 1);
    const expired = await store.load();
    assert.equal(expired.records.find(x => x.id === expiring.id).contentRef, null);
    assert.ok(expired.captureContent.some(x => x.contentRef === capture.contentRef));
    const backup = join(root, 'backup'); await backupFile(options.file, backup, { store, env }); const backupBytes = await readFile(backup);
    const graph = await load(); await syncMarkdownWorkspace({ graph, directory, project: 'p', mode: 'push' });
    graph.purgeProject('p', { mode }); await store.save(kernel.privilegedSnapshot(graph));
    const prune = await syncMarkdownWorkspace({ graph: await load(), directory, project: 'p', mode: 'push', prune: true });
    assert.ok(prune.pruned > 0); assert.equal(deliveredIds(await deliver()).includes(corrected.id), false);
    const destination = join(root, 'restored'), restored = await createStorage({ type, file: destination, env }); t.after(() => restored.close());
    await (type === 'json' ? restoreFile(backup, destination, { env, now: now() }) : restored.restore(backup, { now: now() }));
    const after = await restored.load();
    assert.equal(after.records.some(x => x.project === 'p'), false); assert.ok(after.records.some(x => x.id === peer.id));
    assert.equal((await readLedger(destination)).pending.length, 0);
    const restarted = createShadowGraph({ now }); restarted.importData(after);
    const replay = kernel.privilegedRebuild(restarted);
    assert.equal(replay.rebuildable, mode !== 'hard', replay.reason); assert.deepEqual(replay.skipped, []);
    if (mode === 'hard') assert.equal(replay.reason, 'journal epoch is outside the available sequence range');
    // Restore validation proves every hard-splice gap and exact parity of all
    // surviving collections; a successful load alone is insufficient.
    validateRestorePayload(after, { now });
    assert.deepEqual(await readFile(backup), backupBytes);
    assert.equal((await claimCapture({ ...options, file: destination })).status, 'idle');
    // Synthetic activation state exercises local shutdown and settings cleanup;
    // it is not an executor receipt or proof of real-host activation.
    const runtime = { path: join(root, 'shadowgraph-runtime'), commit: 'a'.repeat(40), extraction: true };
    const enrolled = { file: destination, storage: type };
    const extraction = { state: 'active', activationId: randomUUID(), changedAt: now(), runtime, store: enrolled,
      noOverageConfirmed: true, budgets: { ...FROZEN_WORKER_BUDGETS }, model: 'claude-opus-5[1m]',
      executor: { ok: true, executable: join(root, 'synthetic-claude.exe'), binarySha256: 'b'.repeat(64), hostVersion: '2.1.288', model: 'claude-opus-5[1m]',
        restrictions: Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`E-${i + 1}`, true])) } };
    await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
    const activationFile = join(env.SHADOWGRAPH_HOME, 'activation.json');
    await writeFile(activationFile, JSON.stringify({ version: 1, capabilities: { extraction, capture: { state: 'active', runtime, store: enrolled } }, history: [] }));
    assert.ok(await activeExtraction(env));
    const stopped = await deactivateExtraction({ env }); assert.equal(stopped.cleanup.status, 'complete');
    assert.equal(await activeExtraction(env), null);
    const disabled = await deactivateCapture({ env, cleanupTimeoutMs: 5000 }); assert.equal(disabled.state, 'deactivated');
    assert.equal(disabled.cleanup.status, 'complete');
    const settings = join(root, 'host-settings.json');
    await writeFile(settings, JSON.stringify({ model: 'owner-choice', hooks: { UserPromptSubmit: [{ hooks: [
      { type: 'command', command: 'shadowgraph deliver --hook' }, { type: 'command', command: 'owner-command' }
    ] }], Stop: [{ hooks: [{ type: 'command', command: 'shadowgraph capture --hook' }] }] } }));
    const uninstalled = await changeHookSettings(settings, 'uninstall', { env }); assert.equal(uninstalled.removed, 2);
    const keptSettings = JSON.parse(await readFile(settings, 'utf8')); assert.equal(keptSettings.model, 'owner-choice');
    assert.ok(JSON.stringify(keptSettings).includes('owner-command')); assert.equal(JSON.stringify(keptSettings).includes('shadowgraph'), false);
    assert.deepEqual((await restored.load()).records, after.records);
    assert.deepEqual(await readFile(backup), backupBytes);
  });
}
