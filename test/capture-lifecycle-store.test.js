// FINAL PR37: non-recovering cleanup, synthetic activation records only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { createDestinationFence } from '../src/revision-store.js';
import { deactivateCapture } from '../src/activation.js';
import * as hooks from '../src/capture-hook.js';
import { journalHead, ledgerPath, readLedger, registryFile } from '../src/internal/deletion-knowledge.js';
import { privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { quarantineSelection } from '../src/internal/quarantine.js';
import * as lifecycle from '../src/internal/capture-lifecycle.js';

const START = '2026-10-01T00:00:00.000Z';
const END = Date.parse('2026-10-08T00:00:00.000Z');
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const BACKENDS = [['json', {}], ['sqlite', sqlite.available ? {} : { skip: sqlite.reason }]];
const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const runCli = (f, args) => promisify(execFile)(process.execPath, [CLI, 'capture', ...args], { cwd: f.dir, env: { ...process.env, ...f.env }, timeout: 10_000 });
async function fixture(t, backend) {
  const dir = await scratchDirectory(t, 'capture-lifecycle-store-');
  const home = join(dir, 'home');
  await mkdir(home);
  const file = join(dir, `capture.${backend === 'json' ? 'json' : 'db'}`);
  const manual = join(dir, 'manual.json');
  await writeFile(manual, 'manual-store-sentinel');
  const env = { SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: manual, HOME: home, USERPROFILE: home };
  const graph = createShadowGraph({ now: () => START });
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-lifecycle', text: 'synthetic eligible raw', admission: { limits: hooks.CAPTURE_LIMITS, storeBytes: 0 }, source: { event: 'Stop', sessionId: 'session' } });
  const store = await createStorage({ type: backend, file, env });
  await store.save(privilegedSnapshot(graph));
  store.close?.();
  const capture = { state: 'active', changedAt: START, store: { file, storage: backend }, originId: 'origin-lifecycle', coverage: { projects: 'all', exclude: [] }, limits: hooks.CAPTURE_LIMITS };
  const activation = join(home, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { capture }, history: [] }));
  await writeFile(ledgerPath(file), JSON.stringify({ version: 1, quarantine: [{ token: privilegedSnapshot(graph).records.find((r) => r.id === item.id).erasureToken, at: START }], futureMember: true }));
  await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [], futureMember: true }));
  const unchangedFiles = [ledgerPath(file), registryFile(env), manual];
  const bytes = () => Promise.all(unchangedFiles.map((path) => readFile(path, 'utf8')));
  const load = async () => { const handle = await createStorage({ type: backend, file, env }); try { return await handle.load(); } finally { handle.close?.(); } };
  const expire = (options = {}) => hooks.expireCaptureStore({ env, now: () => END, ...options });
  return { dir, file, env, capture, activation, bytes, load, expire };
}

for (const [backend, options] of BACKENDS) {
  test(`capture retention controls ${backend}: scoped positive policy edits preserve unknown ledger members and all store/registry bytes`, options, async (t) => {
    const f = await fixture(t, backend);
    await writeFile(ledgerPath(f.file), JSON.stringify({ version: 1, future: { preserved: true }, retentionOverrides: [{ project: 'p', days: 3, futureWindowMember: 'kept' }, { project: 'q', days: 5 }] }));
    const store = await createStorage({ type: backend, file: f.file, env: f.env });
    try {
      const payload = await readFile(f.file);
      const registry = await readFile(registryFile(f.env));
      const before = (await readLedger(f.file)).retentionOverrides;
      const result = await lifecycle.applyCaptureRetention(store, { project: 'p', days: 2 }, { expectedOverrides: before });
      assert.equal(result.days, 2);
      const ledger = JSON.parse(await readFile(ledgerPath(f.file), 'utf8'));
      assert.deepEqual(ledger, { version: 1, future: { preserved: true }, retentionOverrides: [{ project: 'p', days: 2, futureWindowMember: 'kept' }, { project: 'q', days: 5 }] });
      assert.deepEqual(await readFile(f.file), payload);
      assert.deepEqual(await readFile(registryFile(f.env)), registry);
      const changed = await readFile(ledgerPath(f.file));
      await assert.rejects(lifecycle.applyCaptureRetention(store, { project: 'p', days: 9 }, { expectedOverrides: before }), { code: 'capture_retention_changed_while_confirming' });
      for (const days of [0, -1, 1.5, '2', Infinity]) await assert.rejects(lifecycle.applyCaptureRetention(store, { project: 'p', days }));
      assert.deepEqual(await readFile(ledgerPath(f.file)), changed);
    } finally { store.close?.(); }
  });
  test(`capture retention controls ${backend}: pending refusal and non-TTY CLI leave policy unchanged`, options, async (t) => {
    const f = await fixture(t, backend);
    const before = await f.bytes();
    await assert.rejects(runCli(f, ['retention', JSON.stringify({ project: 'p', days: 2 })]), /owner_confirmation_required/u);
    assert.deepEqual(await f.bytes(), before);
    const read = JSON.parse((await runCli(f, ['retention', JSON.stringify({ project: 'p' })])).stdout);
    assert.equal(read.days, 7);
    await writeFile(ledgerPath(f.file), JSON.stringify({ version: 1, pending: [{ kind: 'purge' }] }));
    const pending = await f.bytes();
    const store = await createStorage({ type: backend, file: f.file, env: f.env });
    try { await assert.rejects(lifecycle.applyCaptureRetention(store, { project: 'p', days: 2 }), { code: 'deletion_pending_unsupported_at_this_build' }); }
    finally { store.close?.(); }
    assert.deepEqual(await f.bytes(), pending);
  });
  test(`capture lifecycle CLI ${backend}: inspection uses the activation store after deactivation; cancellation requires owner TTY`, options, async (t) => {
    const f = await fixture(t, backend);
    await writeFile(ledgerPath(f.file), JSON.stringify({ version: 1 }));
    await writeFile(f.activation, JSON.stringify({ version: 1, capabilities: { capture: { ...f.capture, state: 'deactivated' } } }));
    const payload = await f.load();
    const before = await readFile(f.file);
    const item = payload.records.find((r) => r.kind === 'capture');
    const result = JSON.parse((await runCli(f, ['inspect', JSON.stringify({ project: 'p', id: item.id })])).stdout);
    assert.equal(result.items[0].id, item.id);
    assert.equal(JSON.stringify(result).includes('synthetic eligible raw'), false);
    assert.deepEqual(JSON.parse((await runCli(f, ['inspect'])).stdout).items, []);
    await assert.rejects(runCli(f, ['cancel', JSON.stringify({ project: 'p', id: item.id })]), /owner_confirmation_required/u);
    await assert.rejects(runCli(f, ['delete', JSON.stringify({ project: 'p', id: item.id })]), /owner_confirmation_required/u);
    assert.deepEqual(await readFile(f.file), before);
    assert.equal((await f.bytes())[2], 'manual-store-sentinel');
    const cleaned = JSON.parse((await runCli(f, ['expire'])).stdout);
    assert.equal(cleaned.status, 'complete');
    await assert.rejects(runCli(f, ['expire', '--store', f.file]), /Usage/u);
  });
  test(`capture lifecycle store ${backend}: explicit expiry uses only the activation store, preserves controls and quarantine`, options, async (t) => {
    const f = await fixture(t, backend);
    const before = await f.bytes();
    const result = await f.expire();
    assert.equal(result.status, 'complete');
    assert.equal(result.expired, 1);
    assert.deepEqual(await f.bytes(), before);
    const payload = await f.load();
    assert.equal(payload.captureContent?.length ?? 0, 0);
    const graph = createShadowGraph(); graph.importData(payload);
    assert.equal(graph.search('', { project: 'p' }).completeness.quarantined, 1);
    assert.equal((await f.expire()).changed, false);
  });
  test(`capture lifecycle store ${backend}: deadline abandonment reports no committed cleanup`, options, async (t) => {
    const f = await fixture(t, backend);
    const before = await readFile(f.file);
    const result = await f.expire({ deadline: END });
    assert.equal(result.status, 'deferred');
    assert.equal(result.reason, 'out_of_time');
    assert.equal(result.expired, 0);
    assert.deepEqual(await readFile(f.file), before);
  });
  test(`capture lifecycle store ${backend}: locked-store deactivation disables first and reports deferred cleanup`, options, async (t) => {
    const f = await fixture(t, backend);
    const before = await f.bytes();
    let unlock, acquired;
    const ready = new Promise((resolve) => { acquired = resolve; });
    const holding = createDestinationFence(f.file).run(async () => { acquired(); await new Promise((resolve) => { unlock = resolve; }); });
    await ready;
    try {
      const result = await deactivateCapture({ env: f.env, cleanupTimeoutMs: 600 });
      assert.equal(result.state, 'deactivated');
      assert.equal(result.changed, true);
      assert.equal(result.cleanup.status, 'deferred');
      assert.equal(result.cleanup.reason, 'storage_lock_timeout');
      assert.equal(JSON.parse(await readFile(f.activation, 'utf8')).capabilities.capture.state, 'deactivated');
    } finally { unlock(); await holding; }
    assert.deepEqual(await f.bytes(), before);
    const disabled = await readFile(f.activation);
    assert.equal((await deactivateCapture({ env: f.env })).changed, false);
    assert.deepEqual(await readFile(f.activation), disabled);
    assert.equal((await f.expire()).expired, 1, 'explicit cleanup works when capture is inactive');
  });
  for (const pending of ['purge', 'restore', 'capture_item']) test(`capture lifecycle store ${backend}: ${pending} pending refuses cleanup without recovery; deactivation still disables`, options, async (t) => {
    const f = await fixture(t, backend);
    // Unknown shapes also refuse; valid purge/restore interruption cases are
    // covered separately so this cannot stand in for the resolver boundary.
    await writeFile(ledgerPath(f.file), JSON.stringify({ version: 1, pending: [{ kind: pending }] }));
    const before = await f.bytes();
    const payload = await readFile(f.file);
    await assert.rejects(f.expire(), { code: 'deletion_pending_unsupported_at_this_build' });
    const result = await deactivateCapture({ env: f.env });
    assert.equal(result.state, 'deactivated');
    assert.equal(result.cleanup.status, 'deferred');
    assert.deepEqual(await f.bytes(), before);
    assert.deepEqual(await readFile(f.file), payload);
  });
  for (const pending of ['purge', 'restore']) test(`capture lifecycle store ${backend}: known ${pending} pending is not completed by expiry, hook or deactivation`, options, async (t) => {
    const f = await fixture(t, backend);
    if (pending === 'purge') {
      const handle = await createStorage({ type: backend, file: f.file, env: f.env, saveFault: (stage) => { if (stage === 'deletionLedgerWritten') throw new Error('synthetic interruption'); } });
      try {
        const graph = createShadowGraph(); graph.importData(await handle.load());
        graph.purgeProject('p', { mode: 'logical' });
        await assert.rejects(handle.save(privilegedSnapshot(graph)), /synthetic interruption/u);
      } finally { handle.close?.(); }
    } else {
      const payload = await f.load();
      const head = journalHead(payload);
      await writeFile(ledgerPath(f.file), JSON.stringify({ version: 1, pending: [{ kind: 'restore', pre: { revision: payload.revision, head, existed: true }, expected: { revision: payload.revision + 1, head }, add: { tombstones: [], quarantine: [] }, inputs: { live: [], descent: false, descentMode: null, overlap: [], postdated: [] } }] }));
    }
    assert.equal((await readLedger(f.file)).pending[0].kind, pending);
    const before = await f.bytes();
    const payload = await readFile(f.file);
    await assert.rejects(f.expire(), { code: 'deletion_pending_unsupported_at_this_build' });
    const selecting = await createStorage({ type: backend, file: f.file, env: f.env });
    try {
      for (const verb of ['list', 'release', 'purge']) await assert.rejects(quarantineSelection(selecting, verb, verb === 'list' ? {} : { project: 'p' }), { code: 'deletion_pending_unsupported_at_this_build' });
    } finally { selecting.close?.(); }
    await assert.rejects(hooks.runCapture({ capture: f.capture, env: f.env, input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'other-session' }), deadline: END + 10_000, now: () => END, cwd: f.dir, registry: registryFile(f.env) }), { code: 'deletion_pending_unsupported_at_this_build' });
    const result = await deactivateCapture({ env: f.env });
    assert.equal(result.cleanup.status, 'deferred');
    assert.equal(result.state, 'deactivated');
    assert.deepEqual(await f.bytes(), before);
    assert.deepEqual(await readFile(f.file), payload);
  });
  test(`FND-P6-20 ${backend}: a retention-free restore in its pre-state is not cleared by quarantine listing or selection`, options, async (t) => {
    const f = await fixture(t, backend);
    const store = await createStorage({ type: backend, file: f.file, env: f.env });
    try {
      const empty = createShadowGraph(); empty.setRevision((await store.load()).revision);
      await store.save(privilegedSnapshot(empty));
      const payload = await store.load();
      const head = journalHead(payload);
      await writeFile(ledgerPath(f.file), JSON.stringify({ version: 1, pending: [{ kind: 'restore', pre: { revision: payload.revision, head, existed: true }, expected: { revision: payload.revision + 1, head }, add: { tombstones: [], quarantine: [] }, inputs: { live: [], descent: false, descentMode: null, overlap: [], postdated: [] } }] }));
      const before = await f.bytes();
      const stored = await readFile(f.file);
      for (const verb of ['list', 'release', 'purge']) {
        await assert.rejects(quarantineSelection(store, verb, verb === 'list' ? {} : { project: 'p' }), { code: 'deletion_pending_unsupported_at_this_build' });
        assert.deepEqual(await f.bytes(), before);
        assert.deepEqual(await readFile(f.file), stored);
      }
    } finally { store.close?.(); }
  });
}

test('capture lifecycle store: unreadable store does not prevent deactivation or report cleanup success', async (t) => {
  const f = await fixture(t, 'json');
  await writeFile(f.file, 'unreadable synthetic store');
  const result = await deactivateCapture({ env: f.env });
  assert.equal(result.state, 'deactivated');
  assert.equal(result.cleanup.status, 'deferred');
  assert.equal(await readFile(f.file, 'utf8'), 'unreadable synthetic store');
});

test('capture lifecycle store: hook skip retains expiry but never mutates controls or manual memory', async (t) => {
  const f = await fixture(t, 'json');
  const before = await f.bytes();
  await hooks.runCapture({ capture: f.capture, env: f.env, input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'other-session' }), deadline: END + 10_000, now: () => END, home: f.env.HOME, cwd: f.dir, registry: registryFile(f.env) });
  assert.equal((await f.load()).captureContent?.length ?? 0, 0);
  assert.deepEqual(await f.bytes(), before);
});

test('capture lifecycle store: owner inspection reports the repository path and restriction without writing', async (t) => {
  const f = await fixture(t, 'json');
  await mkdir(join(f.dir, '.git'));
  const before = [...await f.bytes(), await readFile(f.file, 'utf8')];
  await assert.rejects(lifecycle.captureLifecycle('inspect', { project: 'p' }, { env: f.env, cwd: f.dir }), (error) => {
    assert.equal(error.code, 'store_inside_repository');
    assert.ok(error.message.includes(f.file));
    assert.ok(error.message.includes(f.dir));
    assert.match(error.message, /section 21\.3/u);
    return true;
  });
  assert.deepEqual([...await f.bytes(), await readFile(f.file, 'utf8')], before);
});

test('capture lifecycle store: hook cleanup preserves required cited evidence and quarantine entries', async (t) => {
  const f = await fixture(t, 'json');
  const handle = await createStorage({ file: f.file, env: f.env });
  const graph = createShadowGraph({ now: () => START }); graph.importData(await handle.load());
  const decision = graph.addDecision({ project: 'p', title: 'synthetic accepted experience', chosen: 'keep evidence' });
  const payload = privilegedSnapshot(graph);
  const capture = payload.records.find((item) => item.kind === 'capture');
  const cite = (value) => {
    if (!value || typeof value !== 'object') return;
    if (value.id === decision.id && value.kind === 'decision') value.captureRef = capture.id;
    for (const child of Object.values(value)) cite(child);
  };
  cite(payload); await handle.save(payload);
  const before = await f.bytes();
  const source = (await f.load()).captureContent;
  await hooks.runCapture({ capture: f.capture, env: f.env, input: JSON.stringify({ hook_event_name: 'PreCompact', session_id: 'other-session' }), deadline: END + 10_000, now: () => END, home: f.env.HOME, cwd: f.dir, registry: registryFile(f.env) });
  assert.deepEqual((await f.load()).captureContent, source);
  assert.deepEqual(await f.bytes(), before);
  handle.close?.();
});

test('capture lifecycle store: successful deactivation cleanup closes an existing store-limit episode', async (t) => {
  const f = await fixture(t, 'json');
  await writeFile(ledgerPath(f.file), '{"version":1}');
  const handle = await createStorage({ file: f.file, env: f.env });
  const graph = createShadowGraph({ now: () => START }); graph.importData(await handle.load());
  privilegedRecordCapture(graph, { project: 'q', originId: 'another-origin', text: 'synthetic refused capture', source: { event: 'UserPromptSubmit', sessionId: 'another-session' }, admission: { limits: { ...hooks.CAPTURE_LIMITS, maxQueueDepth: 1 }, storeBytes: 0 } });
  assert.ok(privilegedSnapshot(graph).events.some((entry) => entry.type === 'capture.limited' && entry.since));
  await handle.save(privilegedSnapshot(graph)); handle.close?.();
  const result = await deactivateCapture({ env: f.env });
  assert.equal(result.cleanup.status, 'complete');
  assert.equal((await f.load()).events.some((entry) => entry.type === 'capture.limited' && entry.since), false);
});

test('capture lifecycle store: incomplete bounded cleanup is disclosed and later passes make progress', async (t) => {
  const f = await fixture(t, 'json');
  const store = await createStorage({ file: f.file, env: f.env });
  const graph = createShadowGraph({ now: () => START }); graph.importData(await store.load());
  for (let index = 0; index < 65; index += 1) privilegedRecordCapture(graph, { project: 'q', originId: 'other-origin', text: `synthetic raw ${index}`, admission: { limits: hooks.CAPTURE_LIMITS, storeBytes: 0 }, source: { event: 'UserPromptSubmit', sessionId: 'another-session', hostEventId: `message-${index}` } });
  await store.save(privilegedSnapshot(graph));
  const first = await f.expire();
  assert.equal(first.status, 'partial');
  assert.equal(first.expired, 64);
  const second = await f.expire();
  assert.equal(second.status, 'complete');
  assert.equal(second.expired, 2);
  assert.equal((await f.load()).captureContent?.length ?? 0, 0);
});
