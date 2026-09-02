import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { backupFile, restoreFile } from '../src/backup.js';
import { RevisionConflictError } from '../src/revision-store.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-08-27T12:00:00.000Z';

function semanticSnapshot(payload) {
  const { revision, ...semantic } = structuredClone(payload);
  return semantic;
}

function sourceGraph() {
  const graph = createShadowGraph({ now: () => NOW });
  const decision = graph.addDecision({
    id: 'aba-source-decision', project: 'ds-p1-004', title: 'Restored decision', chosen: 'safe'
  });
  const fact = graph.addFact({
    id: 'aba-source-fact', project: 'ds-p1-004', key: 'restore-contract', value: 'preserved'
  });
  graph.link({ id: 'aba-source-relation', from: decision.id, to: fact.id, relation: 'supported_by' });
  return graph;
}

function withDecision(payload, id) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData(payload);
  graph.addDecision({ id, project: 'ds-p1-004', title: id, chosen: id });
  return graph.exportData();
}

async function createStore(backend, path) {
  return backend === 'sqlite' ? createSqliteStore(path) : createJsonFileStore(path);
}

async function restore(backend, store, source, destination, afterReplace) {
  return backend === 'sqlite'
    ? store.restore(source, { afterReplace })
    : restoreFile(source, destination, { afterReplace });
}

async function advanceTo(store, targetRevision) {
  while ((await store.load()).revision < targetRevision) {
    const current = await store.load();
    await store.save(current);
  }
}

async function setStoredRevision(backend, path, revision) {
  if (backend === 'json') {
    const payload = JSON.parse(await readFile(path, 'utf8'));
    if (revision === undefined) delete payload.revision;
    else payload.revision = revision;
    await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return;
  }
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(path);
  try {
    database.exec('PRAGMA journal_mode = DELETE; BEGIN IMMEDIATE');
    if (revision === undefined) database.prepare('DELETE FROM shadowgraph_meta WHERE key = ?').run('revision');
    else database.prepare('INSERT INTO shadowgraph_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('revision', String(revision));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    database.close();
  }
}

async function restoreArtifacts(directory) {
  return (await readdir(directory)).filter((name) => /\.(?:tmp|rollback|recovery|restore|old)(?:-(?:wal|shm|journal))?$/.test(name)).sort();
}

async function closeServer(server) {
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}

async function prepareRestoreScenario(backend, directory) {
  const destination = join(directory, backend === 'sqlite' ? 'live.db' : 'live.json');
  const source = join(directory, backend === 'sqlite' ? 'source.db' : 'source.json');
  const store = await createStore(backend, destination);
  await store.save(sourceGraph().exportData());
  await backupFile(destination, source, { store });
  const sourceStore = await createStore(backend, source);
  const sourcePayload = await sourceStore.load();
  sourceStore.close();
  const sourceBytes = await readFile(source);
  await store.save(withDecision(await store.load(), 'interface-pre-restore'));
  const stalePayload = withDecision(await store.load(), 'interface-retained-stale');
  store.close();
  return { destination, source, sourcePayload, sourceBytes, stalePayload };
}

function externalSave(backend, path, payload) {
  const storageUrl = new URL('../src/storage.js', import.meta.url).href;
  const sqliteUrl = new URL('../src/sqlite-storage.js', import.meta.url).href;
  const code = `
    const backend = process.argv[1];
    const path = process.argv[2];
    const payload = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'));
    const store = backend === 'sqlite'
      ? await (await import(${JSON.stringify(sqliteUrl)})).createSqliteStore(path)
      : (await import(${JSON.stringify(storageUrl)})).createJsonFileStore(path);
    try {
      const revision = await store.save(payload);
      process.stdout.write(JSON.stringify({ status: 'fulfilled', revision }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: 'rejected', name: error.name, code: error.code, expected: error.expected, actual: error.actual, message: error.message }));
    } finally { store.close(); }
  `;
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, backend, path, encoded], { stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolveOutcome, rejectOutcome) => {
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectOutcome);
    child.on('close', (codeValue) => {
      if (codeValue !== 0) return rejectOutcome(new Error(`external save exited ${codeValue}: ${stderr}`));
      try { resolveOutcome(JSON.parse(stdout)); }
      catch (error) { rejectOutcome(new Error(`external save returned invalid JSON: ${stdout}\n${stderr}\n${error.message}`)); }
    });
  });
}

function startMcp(backend, path) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: path, SHADOWGRAPH_STORAGE: backend },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
    for (const line of lines.filter((candidate) => candidate.trim())) {
      const response = JSON.parse(line);
      const waiter = pending.get(JSON.stringify(response.id));
      if (!waiter) continue;
      pending.delete(JSON.stringify(response.id));
      waiter.resolve(response);
    }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  return {
    call(request) {
      return new Promise((resolveCall, rejectCall) => {
        const key = JSON.stringify(request.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          rejectCall(new Error(`MCP call timed out: ${stderr}`));
        }, 15_000);
        pending.set(key, {
          resolve(value) { clearTimeout(timer); resolveCall(value); },
          reject(error) { clearTimeout(timer); rejectCall(error); }
        });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 ${backend}: restore mints a monotonic revision and rejects the retained ABA payload`, async (t) => {
    const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 ${backend} aba `);
    const destination = join(directory, backend === 'sqlite' ? 'live.db' : 'live.json');
    const source = join(directory, backend === 'sqlite' ? 'backup.db' : 'backup.json');
    let destinationStore;
    try {
      destinationStore = await createStore(backend, destination);
    } catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    t.after(() => { try { destinationStore?.close(); } catch {} });

    assert.equal(await destinationStore.save(sourceGraph().exportData()), 1);
    await backupFile(destination, source, { store: destinationStore });
    const sourceStore = await createStore(backend, source);
    const sourcePayload = await sourceStore.load();
    sourceStore.close();
    const sourceBytes = await readFile(source);
    assert.equal(sourcePayload.revision, 1);

    const destinationAtOne = await destinationStore.load();
    assert.equal(await destinationStore.save(withDecision(destinationAtOne, 'pre-restore-write')), 2);
    const staleCaptureStore = await createStore(backend, destination);
    const stalePayload = withDecision(await staleCaptureStore.load(), 'retained-stale-write');
    staleCaptureStore.close();
    assert.equal(stalePayload.revision, 2);

    const activated = createShadowGraph({ now: () => NOW });
    activated.importData(await destinationStore.load());
    await restore(backend, destinationStore, source, destination, (payload) => activated.replaceData(payload));

    const installed = await destinationStore.load();
    assert.equal(installed.revision, 3, 'restore revision must be max(destination=2, source=1) + 1');
    assert.equal(activated.exportData().revision, installed.revision, 'activated graph must expose the installed revision');
    assert.deepEqual(semanticSnapshot(installed), semanticSnapshot(sourcePayload), 'restore changes only the concurrency revision');
    assert.deepEqual(await readFile(source), sourceBytes, 'restore must not mutate backup bytes');

    assert.equal(await destinationStore.save(withDecision(installed, 'legitimate-post-restore-write')), 4);
    const staleWriter = await createStore(backend, destination);
    await assert.rejects(staleWriter.save(stalePayload), (error) => {
      assert.ok(error instanceof RevisionConflictError);
      assert.equal(error.expected, 2);
      assert.equal(error.actual, 4);
      return true;
    });
    staleWriter.close();

    destinationStore.close();
    destinationStore = undefined;
    const reopened = await createStore(backend, destination);
    const durable = await reopened.load();
    reopened.close();
    assert.equal(durable.revision, 4);
    assert.equal(durable.records.some((record) => record.id === 'legitimate-post-restore-write'), true);
    assert.equal(durable.records.some((record) => record.id === 'retained-stale-write'), false);
    assert.equal(durable.records.some((record) => record.id === 'pre-restore-write'), false);
    assert.deepEqual(durable.facts, sourcePayload.facts);
    assert.deepEqual(durable.relations, sourcePayload.relations);
    assert.deepEqual(durable.journal.slice(0, sourcePayload.journal.length), sourcePayload.journal);
    assert.deepEqual(await readFile(source), sourceBytes);
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 ${backend}: a newer source still installs max(source,destination) + 1`, async (t) => {
    const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 ${backend} newer source `);
    const destination = join(directory, backend === 'sqlite' ? 'live.db' : 'live.json');
    const source = join(directory, backend === 'sqlite' ? 'source.db' : 'source.json');
    let destinationStore;
    let sourceStore;
    try {
      destinationStore = await createStore(backend, destination);
      sourceStore = await createStore(backend, source);
    } catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    t.after(() => { try { destinationStore?.close(); } catch {} try { sourceStore?.close(); } catch {} });
    await destinationStore.save(withDecision(sourceGraph().exportData(), 'newer-source-destination'));
    await advanceTo(destinationStore, 2);
    await sourceStore.save(sourceGraph().exportData());
    await advanceTo(sourceStore, 5);
    const sourcePayload = await sourceStore.load();
    sourceStore.close();
    sourceStore = undefined;
    const sourceBytes = await readFile(source);

    await restore(backend, destinationStore, source, destination);
    const installed = await destinationStore.load();
    assert.equal(installed.revision, 6);
    assert.deepEqual(semanticSnapshot(installed), semanticSnapshot(sourcePayload));
    assert.deepEqual(await readFile(source), sourceBytes);
    destinationStore.close();
    destinationStore = undefined;
    const reopened = await createStore(backend, destination);
    assert.equal((await reopened.load()).revision, 6);
    reopened.close();
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 ${backend}: zero and missing legacy source revisions are high-water mark zero`, async (t) => {
    for (const legacyRevision of [0, undefined]) {
      const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 ${backend} legacy revision `);
      const destination = join(directory, backend === 'sqlite' ? 'live.db' : 'live.json');
      const source = join(directory, backend === 'sqlite' ? 'source.db' : 'source.json');
      let destinationStore;
      let sourceStore;
      try {
        destinationStore = await createStore(backend, destination);
        sourceStore = await createStore(backend, source);
      } catch (error) {
        if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
        throw error;
      }
      await destinationStore.save(withDecision(sourceGraph().exportData(), 'legacy-destination'));
      await advanceTo(destinationStore, 2);
      await sourceStore.save(sourceGraph().exportData());
      sourceStore.close();
      await setStoredRevision(backend, source, legacyRevision);
      const inspectedSource = await createStore(backend, source);
      const sourcePayload = await inspectedSource.load();
      inspectedSource.close();
      const sourceBytes = await readFile(source);
      assert.equal(sourcePayload.revision ?? 0, 0);

      await restore(backend, destinationStore, source, destination);
      const installed = await destinationStore.load();
      assert.equal(installed.revision, 3, `${legacyRevision === undefined ? 'missing' : 'zero'} source revision must normalize to zero`);
      assert.deepEqual(semanticSnapshot(installed), semanticSnapshot(sourcePayload));
      assert.deepEqual(await readFile(source), sourceBytes);
      destinationStore.close();
      sourceStore = undefined;
    }
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 ${backend}: same-path restore remains byte-for-byte and revision unchanged`, async (t) => {
    const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 ${backend} same path `);
    const path = join(directory, backend === 'sqlite' ? 'state.db' : 'state.json');
    let store;
    try { store = await createStore(backend, path); }
    catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    await store.save(sourceGraph().exportData());
    const before = await readFile(path);
    const result = await restore(backend, store, path, path);
    assert.equal(result.unchanged, true);
    assert.equal((await store.load()).revision, 1);
    assert.deepEqual(await readFile(path), before);
    store.close();
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 ${backend}: MAX_SAFE_INTEGER rejects restore and save without rounding or replacement`, async (t) => {
    const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 ${backend} overflow `);
    const destination = join(directory, backend === 'sqlite' ? 'live.db' : 'live.json');
    const source = join(directory, backend === 'sqlite' ? 'source.db' : 'source.json');
    let destinationStore;
    let sourceStore;
    try {
      destinationStore = await createStore(backend, destination);
      sourceStore = await createStore(backend, source);
    } catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    await destinationStore.save(withDecision(sourceGraph().exportData(), 'overflow-old'));
    await sourceStore.save(sourceGraph().exportData());
    sourceStore.close();
    await setStoredRevision(backend, source, Number.MAX_SAFE_INTEGER);
    const destinationBefore = await readFile(destination);
    const sourceBefore = await readFile(source);

    await assert.rejects(restore(backend, destinationStore, source, destination), (error) => {
      assert.equal(error.name, 'RevisionOverflowError');
      assert.equal(error.code, 'revision_overflow');
      return true;
    });
    assert.deepEqual(await readFile(destination), destinationBefore);
    assert.deepEqual(await readFile(source), sourceBefore);
    assert.deepEqual(await restoreArtifacts(directory), []);

    destinationStore.close();
    await setStoredRevision(backend, destination, Number.MAX_SAFE_INTEGER);
    await setStoredRevision(backend, source, 1);
    destinationStore = await createStore(backend, destination);
    const destinationMaxBytes = await readFile(destination);
    const resetSourceBytes = await readFile(source);
    await assert.rejects(restore(backend, destinationStore, source, destination), (error) => error.name === 'RevisionOverflowError' && error.code === 'revision_overflow');
    assert.deepEqual(await readFile(destination), destinationMaxBytes);
    assert.deepEqual(await readFile(source), resetSourceBytes);
    const maxPayload = await destinationStore.load();
    const maxBytes = await readFile(destination);
    await assert.rejects(destinationStore.save(maxPayload), (error) => error.name === 'RevisionOverflowError' && error.code === 'revision_overflow');
    assert.deepEqual(await readFile(destination), maxBytes);
    destinationStore.close();
    destinationStore = undefined;
    sourceStore = undefined;
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 ${backend}: post-install failure rolls back the exact old revision and leaves source bytes unchanged`, async (t) => {
    const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 ${backend} rollback `);
    const destination = join(directory, backend === 'sqlite' ? 'live.db' : 'live.json');
    const source = join(directory, backend === 'sqlite' ? 'source.db' : 'source.json');
    let destinationStore;
    let sourceStore;
    try {
      destinationStore = await createStore(backend, destination);
      sourceStore = await createStore(backend, source);
    } catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    await destinationStore.save(withDecision(sourceGraph().exportData(), 'rollback-old'));
    await advanceTo(destinationStore, 2);
    const oldPayload = await destinationStore.load();
    const oldBytes = await readFile(destination);
    await sourceStore.save(sourceGraph().exportData());
    sourceStore.close();
    const sourceBytes = await readFile(source);
    let activatedRevision;

    await assert.rejects(restore(backend, destinationStore, source, destination, (payload) => {
      activatedRevision = payload.revision;
      throw new Error('injected DS-P1-004 activation failure');
    }), (error) => {
      assert.equal(error.code, backend === 'sqlite' ? 'sqlite_restore_rolled_back' : 'json_restore_rolled_back');
      return true;
    });
    assert.equal(activatedRevision, 3, 'activation must receive the candidate installed revision before rollback');
    const recovered = await destinationStore.load();
    assert.deepEqual(recovered, oldPayload);
    if (backend === 'json') assert.deepEqual(await readFile(destination), oldBytes);
    assert.deepEqual(await readFile(source), sourceBytes);
    assert.deepEqual(await restoreArtifacts(directory), []);
    destinationStore.close();
    destinationStore = undefined;
    sourceStore = undefined;
    const reopened = await createStore(backend, destination);
    assert.deepEqual(await reopened.load(), oldPayload);
    reopened.close();
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 ${backend}: a separate process retained at the pre-restore revision cannot erase a later write`, async (t) => {
    const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 ${backend} process aba `);
    let scenario;
    try { scenario = await prepareRestoreScenario(backend, directory); }
    catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    const store = await createStore(backend, scenario.destination);
    await restore(backend, store, scenario.source, scenario.destination);
    const installed = await store.load();
    assert.equal(installed.revision, 3);
    assert.equal(await store.save(withDecision(installed, 'process-legitimate-post-restore')), 4);
    store.close();

    const staleOutcome = await externalSave(backend, scenario.destination, scenario.stalePayload);
    assert.deepEqual(staleOutcome, {
      status: 'rejected', name: 'RevisionConflictError', expected: 2, actual: 4,
      message: 'ShadowGraph revision conflict: expected 2, found 4'
    });
    const reopened = await createStore(backend, scenario.destination);
    const durable = await reopened.load();
    reopened.close();
    assert.equal(durable.revision, 4);
    assert.equal(durable.records.some((record) => record.id === 'process-legitimate-post-restore'), true);
    assert.equal(durable.records.some((record) => record.id === 'interface-retained-stale'), false);
    assert.deepEqual(await readFile(scenario.source), scenario.sourceBytes);
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 HTTP ${backend}: success activates exactly the fresh durable revision`, async (t) => {
    const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 HTTP ${backend} `);
    let scenario;
    let app;
    try {
      scenario = await prepareRestoreScenario(backend, directory);
      app = await createShadowGraphServer({ file: scenario.destination, storage: backend, now: () => NOW });
    } catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    t.after(async () => { await closeServer(app.server); });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const base = `http://127.0.0.1:${app.server.address().port}`;

    const restoreResponse = await fetch(`${base}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: scenario.source })
    });
    assert.equal(restoreResponse.status, 200, await restoreResponse.text());
    const live = await (await fetch(`${base}/records`)).json();
    const durableStore = await createStore(backend, scenario.destination);
    const durable = await durableStore.load();
    durableStore.close();
    assert.equal(live.revision, 3);
    assert.equal(durable.revision, 3);
    assert.deepEqual(live, durable);
    assert.deepEqual(semanticSnapshot(durable), semanticSnapshot(scenario.sourcePayload));

    const writeResponse = await fetch(`${base}/decisions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: `http-${backend}-post-restore`, project: 'ds-p1-004', title: 'HTTP post restore', chosen: 'keep' })
    });
    assert.equal(writeResponse.status, 200, await writeResponse.text());
    const staleOutcome = await externalSave(backend, scenario.destination, scenario.stalePayload);
    assert.equal(staleOutcome.name, 'RevisionConflictError');
    assert.equal(staleOutcome.expected, 2);
    assert.equal(staleOutcome.actual, 4);
    assert.equal(app.graph.exportData().revision, 4);
    await closeServer(app.server);

    const reopened = await createStore(backend, scenario.destination);
    const final = await reopened.load();
    reopened.close();
    assert.equal(final.revision, 4);
    assert.equal(final.records.some((record) => record.id === `http-${backend}-post-restore`), true);
    assert.equal(final.records.some((record) => record.id === 'interface-retained-stale'), false);
    assert.deepEqual(await readFile(scenario.source), scenario.sourceBytes);
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-004 MCP ${backend}: success exposes the exact fresh revision in graph and durable storage`, async (t) => {
    const directory = await scratchDirectory(t, `shadowgraph ds-p1-004 MCP ${backend} `);
    let scenario;
    try { scenario = await prepareRestoreScenario(backend, directory); }
    catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    const rpc = startMcp(backend, scenario.destination);
    t.after(async () => { await rpc.stop(); });
    await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const restored = await rpc.call({
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'shadowgraph_restore', arguments: { source: scenario.source } }
    });
    assert.equal(restored.error, undefined, restored.error?.message);
    const redacted = await rpc.call({
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'shadowgraph_redact', arguments: {} }
    });
    assert.equal(redacted.error, undefined, redacted.error?.message);
    const live = JSON.parse(redacted.result.content[0].text);
    const durableStore = await createStore(backend, scenario.destination);
    const durable = await durableStore.load();
    durableStore.close();
    assert.equal(live.revision, 3);
    assert.equal(durable.revision, 3);
    assert.deepEqual(live, durable);
    assert.deepEqual(semanticSnapshot(durable), semanticSnapshot(scenario.sourcePayload));

    const written = await rpc.call({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: {
        name: 'shadowgraph_record_decision',
        arguments: { id: `mcp-${backend}-post-restore`, project: 'ds-p1-004', title: 'MCP post restore', chosen: 'keep' }
      }
    });
    assert.equal(written.error, undefined, written.error?.message);
    const staleOutcome = await externalSave(backend, scenario.destination, scenario.stalePayload);
    assert.equal(staleOutcome.name, 'RevisionConflictError');
    assert.equal(staleOutcome.expected, 2);
    assert.equal(staleOutcome.actual, 4);
    await rpc.stop();

    const reopened = await createStore(backend, scenario.destination);
    const final = await reopened.load();
    reopened.close();
    assert.equal(final.revision, 4);
    assert.equal(final.records.some((record) => record.id === `mcp-${backend}-post-restore`), true);
    assert.equal(final.records.some((record) => record.id === 'interface-retained-stale'), false);
    assert.deepEqual(await readFile(scenario.source), scenario.sourceBytes);
  });
}
