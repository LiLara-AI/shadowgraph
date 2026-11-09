// Synthetic executor only. The worker must close every store before calling it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { ledgerPath, registryFile, storeIo } from '../src/internal/deletion-knowledge.js';
import { resolvePendingRestore } from '../src/internal/restore-wrapper.js';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedRecordCapture, privilegedSnapshot, privilegedValidate, privilegedRebuild, privilegedCancelCapture, privilegedExpireCapture, privilegedInspectCapture, privilegedIssueAccess } from '../src/internal/snapshot.js';
import { claimCapture, commitCapture, runExtractionItem } from '../src/internal/extraction-worker.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { t1Line } from '../src/compact-tier.js';
import { classifyClaim } from '../src/verification.js';

const START = '2026-10-01T00:00:00.000Z';
const TEXT = 'The fixture completed in staging.';
const admission = { limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 1000, maxItemBytes: 2 ** 20, maxItemsPerSession: 1000 }, storeBytes: 0 };
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
async function setup(t, type, text = TEXT) {
  const root = await scratchDirectory(t); const file = join(root, 'memory');
  let at = START;
  const options = { type, file, env: { SHADOWGRAPH_HOME: root }, now: () => at, project: 'p', ownerId: 'fixture-worker', ownerBootId: 'fixture-boot', leaseMs: 60000 };
  const graph = createShadowGraph({ now: options.now });
  const item = privilegedRecordCapture(graph, { project: 'p', originId: 'synthetic-origin', text, admission, source: { event: 'UserPromptSubmit', sessionId: 'synthetic-session' } });
  const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
  const read = async () => { const s = await createStorage(options); try { return await s.load(); } finally { s.close(); } };
  const mutate = async change => { const s = await createStorage(options); try { const data = await s.load(); await s.save(await change(data)); } finally { s.close(); } };
  const result = { status: 'success', value: { records: [{ kind: 'memory', fields: [{ name: 'text', text: TEXT, sourceRef: item.id }] }] }, receipt: { invocationStarted: true, model: 'claude-opus-5[1m]' } };
  return { options, item, read, mutate, result, clock: value => { at = value; } };
}
for (const type of ['json', 'sqlite']) {
  const skip = type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {};
  test(`worker ${type}: journal order survives clock reversal and protects an earlier live lease`, skip, async t => {
    for (const active of [false, true]) for (const time of [START, '2026-09-30T23:59:59.000Z']) {
      const f = await setup(t, type);
      if (active) assert.equal((await claimCapture(f.options)).id, f.item.id);
      f.clock(time);
      let second;
      await f.mutate(data => { const g = createShadowGraph({ now: f.options.now }); g.importData(data);
        second = privilegedRecordCapture(g, { project: 'p', originId: 'synthetic-origin', text: TEXT, admission, source: { event: 'UserPromptSubmit', sessionId: 'synthetic-session' } });
        const imported = privilegedSnapshot(g); imported.records.reverse(); return imported; });
      const entries = (await f.read()).journal.filter(entry => entry.type === 'capture.recorded');
      assert.ok(entries.find(entry => entry.entityId === f.item.id).seq < entries.find(entry => entry.entityId === second.id).seq);
      const claimed = await claimCapture(f.options);
      if (active) assert.equal(claimed.status, 'idle', 'later capture cannot bypass the live earlier lease');
      else assert.equal(claimed.id, f.item.id, 'journal sequence wins over wall-clock order');
    }
  });
  test(`worker ${type}: missing capture creation order refuses instead of guessing from imported timestamps`, skip, async t => {
    const f = await setup(t, type);
    await f.mutate(data => ({ ...data, journal: [], lastJournalSeq: 0 }));
    await assert.rejects(claimCapture(f.options), { code: 'capture_order_unavailable' });
  });
  test(`worker ${type}: retention crosses inside a live lease, including hook cleanup and clock reversal`, skip, async t => {
    for (const cleanup of [false, true]) {
      const f = await setup(t, type); f.clock('2026-10-07T23:59:50.000Z');
      const claim = await claimCapture(f.options); assert.equal(claim.status, 'claimed');
      f.clock('2026-10-08T00:00:00.000Z');
      assert.ok(Date.parse(claim.lease.leaseExpiresAt) > Date.parse(f.options.now()), 'retention, not lease expiry, invalidates');
      if (cleanup) {
        const controls = [ledgerPath(f.options.file), registryFile(f.options.env)];
        const before = await Promise.all(controls.map(file => readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; })));
        const store = await createStorage(f.options);
        try { await store.update(data => { const g = createShadowGraph({ now: f.options.now }); g.importData(data); privilegedExpireCapture(g); return privilegedSnapshot(g); }); }
        finally { store.close(); }
        assert.deepEqual(await Promise.all(controls.map(file => readFile(file).catch(error => { if (error.code === 'ENOENT') return null; throw error; }))), before, 'hook cleanup leaves ledger and registry unchanged');
        f.clock('2026-10-07T23:59:55.000Z');
      }
      assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result');
      assert.equal((await f.read()).records.filter(item => item.kind !== 'capture').length, 0);
    }
  });
  test(`worker ${type}: extracted causal evidence survives persistence, rebuild and compact delivery`, skip, async t => {
    for (const [source, statement, expectedClass] of [
      ['The cache reset fixed the test.', 'The cache reset fixed the test.', 'quoted'],
      ["The migration didn't complete.", 'The migration did not complete.', 'entailed'],
      ['The job stopped.\n\nThe job stopped in staging.', 'The job stopped', 'ambiguous']
    ]) {
      const f = await setup(t, type, source), claim = await claimCapture(f.options);
      const result = { ...f.result, value: { records: [{ kind: 'attempt', fields: ['solution', 'result', 'reason'].map(name => ({ name, text: statement, sourceRef: f.item.id })) }] } };
      assert.equal((await commitCapture(f.options, claim, result)).status, 'committed');
      const data = await f.read(), attempt = data.records.find(item => item.kind === 'attempt');
      const verified = classifyClaim({ text: statement, sourceRef: f.item.id }, source);
      assert.equal(verified.class, expectedClass, 'valid verifier control');
      assert.deepEqual(attempt.causalClaim, {
        statement, state: 'recorded', sourceClass: 'agent_claimed', class: expectedClass, verifierVersion: verified.verifierVersion,
        ...(verified.rule ? { rule: verified.rule } : {}), ...(verified.readings ? { readings: verified.readings } : {}),
        ...(verified.checks ? { checks: verified.checks } : {}), evidence: [{ sourceRef: f.item.id, span: verified.span, text: source.slice(verified.span.start, verified.span.end) }]
      });
      assert.equal(attempt.verificationStatus, 'unverified');
      assert.equal(t1Line(attempt).claimClass, expectedClass);
      const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
      assert.equal(privilegedValidate(graph).valid, true);
      assert.equal(privilegedRebuild(graph).rebuildable, true, 'decorated journal and idempotency copies agree');
      assert.deepEqual(graph.exportData({ project: 'p' }).records.find(item => item.id === attempt.id).causalClaim, attempt.causalClaim);
    }
  });
  test(`worker ${type}: replacing an item's token or claim authority cannot reuse a lease`, skip, async t => {
    for (const changed of ['token', 'authority']) {
      const f = await setup(t, type); let grant;
      if (changed === 'authority') await f.mutate(data => { const g = createShadowGraph({ now: f.options.now }); g.importData(data);
        grant = privilegedIssueAccess(g, { scope: { projects: ['p'] }, surfaces: ['cli'], expiresAt: '2026-10-02T00:00:00.000Z', reason: 'Synthetic claim grant' }).entry;
        return privilegedSnapshot(g); });
      if (grant) f.options.accessId = grant.accessId;
      const claim = await claimCapture(f.options);
      await f.mutate(data => {
        const change = value => { if (!value || typeof value !== 'object') return;
          if (value.id === f.item.id && value.kind === 'capture') {
            if (changed === 'token') value.erasureToken = 'replacement-fixture-token';
            else if (value.lease) delete value.lease.accessId;
          }
          for (const child of Object.values(value)) change(child);
        }; change(data); return data;
      });
      assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result');
      assert.equal((await f.read()).records.filter(item => item.kind !== 'capture').length, 0);
    }
  });
  test(`worker ${type}: success without an actual pinned invocation receipt cannot create canonical memory`, skip, async t => {
    for (const receipt of [undefined, { invocationStarted: false }, { invocationStarted: true, model: 'another-model' }]) {
      const f = await setup(t, type), claim = await claimCapture(f.options);
      assert.equal((await commitCapture(f.options, claim, { ...f.result, receipt })).status, 'executor_failed');
      const data = await f.read();
      assert.equal(data.records.filter(item => item.kind !== 'capture').length, 0);
      assert.equal(data.records.find(item => item.id === f.item.id).receipts.length, 0);
    }
  });
  test(`worker ${type}: quarantined or wrong-scope results never materialize and an expired grant stays unusable`, skip, async t => {
    for (const change of ['quarantine', 'scope', 'clock']) {
      const f = await setup(t, type); let grant;
      if (change === 'clock') await f.mutate(data => {
        const g = createShadowGraph({ now: f.options.now }); g.importData(data);
        grant = privilegedIssueAccess(g, { scope: { projects: ['p'] }, surfaces: ['cli'], expiresAt: '2026-10-01T00:00:10.000Z', reason: 'Synthetic clock race' }).entry;
        return privilegedSnapshot(g);
      });
      if (grant) f.options.accessId = grant.accessId;
      const claim = await claimCapture(f.options);
      if (change === 'quarantine') await writeFile(ledgerPath(f.options.file), JSON.stringify({ version: 1, quarantine: [{ token: f.item.erasureToken, at: START }] }));
      if (change === 'scope') f.options.project = 'q';
      if (change === 'clock') f.clock('2026-10-01T00:00:10.000Z');
      assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result');
      if (change === 'clock') { f.clock(START); assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result', 'settled lease cannot become usable after clock reversal'); }
      assert.equal((await f.read()).records.filter(item => item.kind !== 'capture').length, 0);
    }
  });
  test(`worker ${type}: typed records remain typed, duplicate commit is inert and output expiry survives rebuild and restore`, skip, async t => {
    for (const [kind, names] of [['decision', ['title', 'chosen']], ['attempt', ['solution', 'result']]]) {
      const f = await setup(t, type), claim = await claimCapture(f.options);
      f.result.value.records = [{ kind, fields: names.map(name => ({ name, text: TEXT, sourceRef: f.item.id })) }, { kind: 'memory', fields: [{ name: 'text', text: 'Unsupported fixture assertion.', sourceRef: f.item.id }] }];
      assert.equal((await commitCapture(f.options, claim, f.result)).status, 'committed');
      assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result');
      let data = await f.read(); const produced = data.records.filter(item => item.kind !== 'capture');
      assert.equal(produced.length, 1); assert.equal(produced[0].kind, kind);
      if (kind === 'attempt') { assert.deepEqual(produced[0].causalClaim, { state: 'unknown' }); assert.deepEqual(produced[0].outcomeEvidence, { state: 'absent' }); }
      const backup = `${f.options.file}.backup`, store = await createStorage(f.options);
      try { await backupFile(f.options.file, backup, { store, env: f.options.env }); } finally { store.close(); }
      f.clock('2026-10-08T00:00:00.000Z');
      if (type === 'json') await restoreFile(backup, f.options.file, { now: f.options.now(), env: f.options.env });
      else { const s = await createStorage(f.options); try { await s.restore(backup, { now: f.options.now() }); } finally { s.close(); } }
      data = await f.read();
      assert.equal(JSON.stringify(data).includes('Unsupported fixture assertion.'), false, 'restore post-step enforces seven-day output expiry even with cited raw');
      const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
      assert.equal(privilegedRebuild(graph).rebuildable, true);
      assert.equal(privilegedValidate(graph).valid, true);
    }
  });
  test(`worker ${type}: closed across call, verified commit, one canonical result and rebuild parity`, skip, async t => {
    const f = await setup(t, type);
    let opened = 0;
    const openStore = async options => {
      const store = await createStorage(options); opened += 1; const close = store.close;
      store.close = () => { opened -= 1; close(); }; return store;
    };
    const done = await runExtractionItem({ ...f.options, openStore, executor: { invoke: async ({ prompt }) => {
      assert.equal(opened, 0); assert.ok(prompt.includes(TEXT));
      await f.mutate(data => data);
      return f.result;
    } } });
    assert.equal(done.status, 'committed'); assert.equal(opened, 0);
    const data = await f.read(); const records = data.records.filter(item => item.kind !== 'capture');
    assert.equal(records.length, 1); assert.equal(records[0].text, TEXT);
    assert.equal(records[0].claims[0].class, 'quoted'); assert.equal(records[0].verificationStatus, 'unverified');
    assert.equal(records[0].captureRef, f.item.id);
    assert.equal(records[0].claims[0].evidence, TEXT.slice(records[0].claims[0].span.start, records[0].claims[0].span.end));
    assert.equal((await runExtractionItem({ ...f.options, executor: { invoke() { assert.fail('no second call'); } } })).status, 'idle');
    const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
    assert.equal(privilegedValidate(graph).valid, true); assert.equal(privilegedRebuild(graph).rebuildable, true);
  });
  test(`worker ${type}: expired lease reclaims and rejects the old result; redaction and expiry reject late results`, skip, async t => {
    const f = await setup(t, type);
    const first = await claimCapture(f.options); assert.equal(first.status, 'claimed');
    f.clock('2026-10-01T00:01:00.000Z');
    assert.equal((await commitCapture(f.options, first, f.result)).status, 'superseded_result');
    const second = await claimCapture(f.options); assert.equal(second.status, 'claimed'); assert.notEqual(first.leaseId, second.leaseId);
    assert.equal((await commitCapture(f.options, first, f.result)).status, 'superseded_result');
    await f.mutate(data => { data.captureContent[0].text = 'Redacted fixture.'; return data; });
    assert.equal((await commitCapture(f.options, second, f.result)).status, 'superseded_result');
    assert.equal((await f.read()).records.filter(item => item.kind !== 'capture').length, 0);
    f.clock('2026-10-08T00:00:00.000Z');
    assert.equal((await claimCapture(f.options)).status, 'idle');
  });
  test(`worker ${type}: unsupported output stays private, repeated source spans count once`, skip, async t => {
    const f = await setup(t, type); const claim = await claimCapture(f.options);
    f.result.value.records.push({ kind: 'memory', fields: [{ name: 'text', text: 'All production work succeeded.', sourceRef: f.item.id }] });
    f.result.value.records.push(f.result.value.records[0]);
    assert.equal((await commitCapture(f.options, claim, f.result)).status, 'committed');
    const data = await f.read(); assert.equal(data.records.filter(item => item.kind !== 'capture').length, 1);
    const item = data.records.find(item => item.id === f.item.id);
    assert.equal(item.extractionOutput.unsupported.length, 1);
    assert.equal(item.extractionOutput.expiresAt, '2026-10-08T00:00:00.000Z');
    f.clock('2026-10-08T00:00:00.000Z');
    const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
    assert.equal(privilegedInspectCapture(graph, { project: 'p' }).items[0].extractionOutput.unsupported.length, 0);
    privilegedExpireCapture(graph);
    assert.equal(JSON.stringify(privilegedSnapshot(graph)).includes('All production work succeeded.'), false);
    assert.equal(privilegedSnapshot(graph).records.filter(value => value.kind !== 'capture').length, 1, 'accepted experience and its evidence survive output expiry');
  });
  test(`worker ${type}: owner cancellation during a call invalidates and rejects the result`, skip, async t => {
    const f = await setup(t, type), claim = await claimCapture(f.options);
    await f.mutate(data => { const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
      assert.equal(privilegedCancelCapture(graph, { project: 'p', id: f.item.id }).changed, true);
      return privilegedSnapshot(graph); });
    assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result');
    assert.equal((await f.read()).records.filter(item => item.kind !== 'capture').length, 0);
  });
  test(`worker ${type}: correction marks the in-flight capture cancelled before persistence`, skip, async t => {
    const f = await setup(t, type);
    await f.mutate(data => { const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
      graph.remember({ project: 'p', memoryType: 'note', key: 'fixture', text: 'Original fixture statement.' });
      return privilegedSnapshot(graph); });
    const claim = await claimCapture(f.options);
    await f.mutate(data => { const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
      graph.remember({ project: 'p', memoryType: 'note', key: 'fixture', text: 'Corrected fixture statement.' });
      const next = privilegedSnapshot(graph);
      assert.equal(next.records.find(item => item.id === f.item.id).cancelRequested, true);
      return next; });
    assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result');
    const data = await f.read();
    assert.equal(data.events.find(value => value.type === 'extraction.superseded').count, 1);
    assert.equal(JSON.stringify(data.events.find(value => value.type === 'extraction.superseded')).includes(f.item.id), false);
    assert.equal((await claimCapture(f.options)).status, 'idle');
  });
  for (const cause of ['grant expiry', 'grant revocation', 'retention expiry', 'attribution import', 'restore', 'restore without destination ledger', 'purge then restore', 'correction then restore']) {
    test(`worker ${type}: late result cannot cross ${cause}`, skip, async t => {
      const f = await setup(t, type); f.options.leaseMs = 180000;
      let grant;
      if (cause.startsWith('grant')) await f.mutate(data => {
        const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
        grant = privilegedIssueAccess(graph, { scope: { projects: ['p'] }, surfaces: ['cli'], expiresAt: '2026-10-01T00:01:00.000Z', reason: 'Synthetic extraction race' }).entry;
        return privilegedSnapshot(graph);
      });
      if (grant) f.options.accessId = grant.accessId;
      const claim = await claimCapture(f.options); assert.equal(claim.status, 'claimed');
      if (cause.includes('restore')) {
        const backup = `${f.options.file}.backup`;
        const store = await createStorage(f.options);
        try { await backupFile(f.options.file, backup, { store, env: f.options.env }); } finally { store.close(); }
        if (cause === 'purge then restore') await f.mutate(data => { const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
          graph.purgeProject('p', { hard: true }); return privilegedSnapshot(graph); });
        if (cause === 'correction then restore') await f.mutate(data => { data.captureContent[0].text = 'Corrected fixture text.'; return data; });
        if (cause === 'restore without destination ledger') await unlink(ledgerPath(f.options.file)).catch(error => { if (error.code !== 'ENOENT') throw error; });
        if (type === 'json') await restoreFile(backup, f.options.file, { env: f.options.env, now: START });
        else { const restored = await createStorage(f.options); try { await restored.restore(backup, { now: START }); } finally { restored.close(); } }
      } else if (cause === 'grant expiry') f.clock('2026-10-01T00:01:00.000Z');
      else if (cause === 'retention expiry') f.clock('2026-10-08T00:00:00.000Z');
      else if (cause === 'grant revocation') await f.mutate(data => { const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
        graph.revokeAccess({ accessId: grant.accessId }); return privilegedSnapshot(graph); });
      else if (cause === 'attribution import') await f.mutate(data => {
        // Import is a privileged whole-store writer. Rewrite the synthetic
        // bundle consistently, including journal, raw and session ownership.
        const move = value => { if (!value || typeof value !== 'object') return;
          if (value.project === 'p') value.project = 'q';
          for (const name of ['key', 'idempotencyKey']) if (typeof value[name] === 'string' && value[name].startsWith('capture:p:')) value[name] = `capture:q:${value[name].slice('capture:p:'.length)}`;
          for (const child of Object.values(value)) move(child); };
        move(data);
        const graph = createShadowGraph({ now: f.options.now }); graph.importData(data);
        assert.equal(privilegedValidate(graph).valid, true);
        return privilegedSnapshot(graph);
      });
      assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result');
      const after = await f.read();
      assert.equal(after.records.filter(item => item.kind !== 'capture').length, 0);
      if (cause === 'purge then restore') assert.equal(after.records.some(item => item.id === f.item.id), false, 'purged capture never resurrects');
    });
  }
  test(`worker ${type}: killed claimant closes store, expired lease reclaims, late completion cannot duplicate`, skip, async t => {
    const f = await setup(t, type);
    const moduleUrl = new URL('../src/internal/extraction-worker.js', import.meta.url).href;
    const script = `import { claimCapture } from ${JSON.stringify(moduleUrl)}; const options=JSON.parse(process.argv[1]); options.now=()=>${JSON.stringify(START)}; console.log(JSON.stringify(await claimCapture(options))); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, JSON.stringify(f.options)], { env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    t.after(() => child.kill());
    const exited = once(child, 'exit');
    const first = await new Promise((resolve, reject) => {
      let text = ''; const timer = setTimeout(() => reject(new Error('Synthetic claimant timeout')), 10000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.stdout.on('data', data => { text += data; if (text.includes('\n')) { clearTimeout(timer); try { resolve(JSON.parse(text.split('\n')[0])); } catch (error) { reject(error); } } });
    });
    assert.equal(first.status, 'claimed'); child.kill(); await exited;
    f.clock('2026-10-01T00:01:00.000Z');
    const second = await claimCapture(f.options); assert.equal(second.status, 'claimed');
    assert.notEqual(first.leaseId, second.leaseId);
    assert.equal((await commitCapture(f.options, first, f.result)).status, 'superseded_result');
    assert.equal((await commitCapture(f.options, second, f.result)).status, 'committed');
    assert.equal((await f.read()).records.filter(value => value.kind !== 'capture').length, 1);
  });
  test(`worker ${type}: crash after restore primitive leaves generation advanced and pending work refuses late commit`, skip, async t => {
    const f = await setup(t, type), claim = await claimCapture(f.options), backup = `${f.options.file}.backup`;
    const saved = await createStorage(f.options);
    try { await backupFile(f.options.file, backup, { store: saved, env: f.options.env }); } finally { saved.close(); }
    await f.mutate(data => { const graph = createShadowGraph({ now: f.options.now }); graph.importData(data); graph.purgeProject('p', { hard: true }); return privilegedSnapshot(graph); });
    const restoreFault = stage => { if (stage === 'beforePostStep') throw new Error('Synthetic crash between primitive and post-step'); };
    let restored;
    if (type === 'json') restored = await restoreFile(backup, f.options.file, { env: f.options.env, now: START, restoreFault });
    else { const store = await createStorage({ ...f.options, restoreFault }); try { restored = await store.restore(backup, { now: START }); } finally { store.close(); } }
    assert.equal(restored.completion, 'pending');
    await assert.rejects(commitCapture(f.options, claim, f.result), { code: 'deletion_pending_unsupported_at_this_build' });
    const store = await createStorage(f.options); try { await resolvePendingRestore(storeIo(store)); } finally { store.close(); }
    assert.equal((await commitCapture(f.options, claim, f.result)).status, 'superseded_result');
    assert.equal((await f.read()).records.some(value => value.id === f.item.id), false);
  });
}
