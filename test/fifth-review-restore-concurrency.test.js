import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { restoreFile } from '../src/backup.js';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createDestinationFence } from '../src/revision-store.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';

const FIXED_NOW = '2026-08-27T12:00:00.000Z';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function graphPayload(id, revision = 0) {
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  graph.addDecision({ id, project: 'fifth-review', title: id, chosen: id });
  return { ...graph.exportData(), revision };
}

function writerPayload(current, id) {
  const graph = createShadowGraph({ now: () => FIXED_NOW });
  graph.importData(current);
  graph.addDecision({ id, project: 'fifth-review', title: id, chosen: id });
  return graph.exportData();
}

async function settleState(promise, milliseconds = 150) {
  return Promise.race([
    promise.then(
      (value) => ({ settled: true, status: 'fulfilled', value }),
      (reason) => ({ settled: true, status: 'rejected', reason })
    ),
    delay(milliseconds).then(() => ({ settled: false }))
  ]);
}

function assertAcknowledgedWriteWasNotLost(writer, durable, writerId) {
  if (writer.status === 'fulfilled') {
    assert.equal(
      durable.records.some((record) => record.id === writerId),
      true,
      `save acknowledged revision ${writer.value}, but ${writerId} disappeared from fresh durable state`
    );
    return;
  }
  assert.match(writer.reason?.message ?? '', /revision conflict|busy|lock|restore/i);
}

async function waitForFile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { await stat(path); return; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await delay(5);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function writePayload(path, payload) {
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

async function advanceSqliteRevision(store, targetRevision) {
  while ((await store.load()).revision < targetRevision) await store.save(await store.load());
}

function externalWriter(backend, file, id, count = 1) {
  const storageUrl = new URL('../src/storage.js', import.meta.url).href;
  const sqliteUrl = new URL('../src/sqlite-storage.js', import.meta.url).href;
  const code = `
    const backend = process.argv[1];
    const file = process.argv[2];
    const id = process.argv[3];
    const count = Number(process.argv[4]);
    const store = backend === 'sqlite'
      ? await (await import(${JSON.stringify(sqliteUrl)})).createSqliteStore(file)
      : (await import(${JSON.stringify(storageUrl)})).createJsonFileStore(file);
    try {
      const payload = await store.load();
      const records = [...payload.records];
      for (let index = 0; index < count; index += 1) records.push({
        id: count === 1 ? id : id + '-' + index,
        kind: 'decision', schemaVersion: 5, project: 'fifth-review',
        title: id, chosen: id, status: 'active', alternatives: []
      });
      const revision = await store.save({ ...payload, expectedRevision: payload.revision, records });
      process.stdout.write(JSON.stringify({ status: 'fulfilled', revision }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: 'rejected', name: error.name, code: error.code, message: error.message }));
    } finally { store.close(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, backend, file, id, String(count)], {
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const outcome = new Promise((resolveOutcome, rejectOutcome) => {
    child.on('error', rejectOutcome);
    child.on('close', (codeValue) => {
      if (codeValue !== 0) return rejectOutcome(new Error(`external writer exited ${codeValue}: ${stderr}`));
      try { resolveOutcome(JSON.parse(stdout)); }
      catch (error) { rejectOutcome(new Error(`external writer returned invalid JSON: ${stdout}\n${stderr}\n${error.message}`)); }
    });
  });
  return { child, outcome };
}

function gatedSqliteWriter(file, id, mode = 'after-load') {
  const sqliteUrl = new URL('../src/sqlite-storage.js', import.meta.url).href;
  const code = `
    const mode = process.argv[3];
    if (mode === 'during') process.stdout.write(JSON.stringify({ phase: 'started' }) + '\\n');
    const store = await (await import(${JSON.stringify(sqliteUrl)})).createSqliteStore(process.argv[1]);
    const payload = await store.load();
    if (mode === 'after-load') {
      process.stdout.write(JSON.stringify({ phase: 'loaded', revision: payload.revision }) + '\\n');
      await new Promise((resolveInput) => process.stdin.once('data', resolveInput));
    }
    try {
      const records = [...payload.records, {
        id: process.argv[2], kind: 'decision', schemaVersion: 5,
        project: 'fifth-review', title: process.argv[2], chosen: process.argv[2],
        status: 'active', alternatives: []
      }];
      const revision = await store.save({ ...payload, expectedRevision: payload.revision, records });
      process.stdout.write(JSON.stringify({ phase: 'outcome', status: 'fulfilled', revision }) + '\\n');
    } catch (error) {
      process.stdout.write(JSON.stringify({ phase: 'outcome', status: 'rejected', name: error.name, code: error.code, message: error.message }) + '\\n');
    } finally { store.close(); process.stdin.destroy(); }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', code, file, id, mode], {
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const started = deferred();
  const loaded = deferred();
  const outcome = deferred();
  const exited = deferred();
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
      const message = JSON.parse(line);
      if (message.phase === 'started') started.resolve(message);
      if (message.phase === 'loaded') loaded.resolve(message);
      if (message.phase === 'outcome') outcome.resolve(message);
    }
  });
  child.on('error', (error) => {
    if (mode === 'during') started.reject(error);
    else loaded.reject(error);
    outcome.reject(error);
  });
  child.on('close', (codeValue) => {
    exited.resolve(codeValue);
    if (codeValue === 0) return;
    const error = new Error(`gated SQLite writer exited ${codeValue}: ${stderr}`);
    if (mode === 'during') started.reject(error);
    else loaded.reject(error);
    outcome.reject(error);
  });
  return {
    child,
    started: started.promise,
    loaded: loaded.promise,
    outcome: Promise.all([outcome.promise, exited.promise]).then(([message]) => message),
    proceed() { child.stdin.write('save\n'); }
  };
}

function startMcp(file) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  const pending = new Map();
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

async function closeServer(server) {
  if (server.listening) await new Promise((resolveClose) => server.close(resolveClose));
}

test('DS-P1-003 JSON: an independent handle cannot acknowledge a save during restore and lose it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review json '));
  const destination = join(directory, 'live state.json');
  const source = join(directory, 'restore source.json');
  const restoreStore = createJsonFileStore(destination, { staleLockMs: 60 });
  const writerStore = createJsonFileStore(destination, { staleLockMs: 60 });
  await restoreStore.save(graphPayload('json-old'));
  await writeFile(source, `${JSON.stringify(graphPayload('json-restored', 17), null, 2)}\n`, 'utf8');

  const validationEntered = deferred();
  const releaseValidation = deferred();
  const restoring = restoreFile(source, destination, {
    staleLockMs: 60,
    async validate() {
      validationEntered.resolve();
      await releaseValidation.promise;
    }
  });
  await validationEntered.promise;

  const current = await writerStore.load();
  const writing = writerStore.save(writerPayload(current, 'json-writer'));
  const beforeRelease = await settleState(writing);
  releaseValidation.resolve();
  const [restoreOutcome, writerOutcome] = await Promise.allSettled([restoring, writing]);

  assert.equal(restoreOutcome.status, 'fulfilled', restoreOutcome.reason?.message);
  const reopened = createJsonFileStore(destination);
  const durable = await reopened.load();
  reopened.close();
  assert.equal(durable.records.some((record) => record.id === 'json-restored'), true);
  assertAcknowledgedWriteWasNotLost(writerOutcome, durable, 'json-writer');
  assert.equal(beforeRelease.settled, false, 'writer settled while restore still owned its validation window');
  restoreStore.close();
  writerStore.close();
});

test('DS-P1-003 SQLite: an independent handle cannot acknowledge a save during restore and lose it', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review sqlite '));
  const destination = join(directory, 'live state.db');
  const source = join(directory, 'restore source.db');
  let restoreStore;
  let writerStore;
  let sourceStore;
  try {
    restoreStore = await createSqliteStore(destination, { staleLockMs: 60 });
    writerStore = await createSqliteStore(destination, { staleLockMs: 60 });
    sourceStore = await createSqliteStore(source);
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  await restoreStore.save(graphPayload('sqlite-old'));
  await sourceStore.save(graphPayload('sqlite-restored'));
  for (let revision = 1; revision < 17; revision += 1) {
    await sourceStore.save(await sourceStore.load());
  }
  sourceStore.close();

  const validationEntered = deferred();
  const releaseValidation = deferred();
  let validationCount = 0;
  const restoring = restoreStore.restore(source, {
    async validate() {
      if (validationCount++ !== 0) return;
      validationEntered.resolve();
      await releaseValidation.promise;
    }
  });
  await validationEntered.promise;

  const loadAttempted = deferred();
  const writing = (async () => {
    const loading = writerStore.load();
    loadAttempted.resolve();
    const current = await loading;
    return writerStore.save(writerPayload(current, 'sqlite-writer'));
  })();
  await loadAttempted.promise;
  releaseValidation.resolve();
  const [restoreOutcome, writerOutcome] = await Promise.allSettled([restoring, writing]);

  assert.equal(restoreOutcome.status, 'fulfilled', restoreOutcome.reason?.message);
  writerStore?.close();
  restoreStore.close();
  const reopened = await createSqliteStore(destination);
  const durable = await reopened.load();
  reopened.close();
  assert.equal(durable.records.some((record) => record.id === 'sqlite-restored'), true);
  assertAcknowledgedWriteWasNotLost(writerOutcome, durable, 'sqlite-writer');
});

test('DS-P1-003 SQLite: an idle child handle cannot block restore replacement', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review sqlite deterministic child '));
  const destination = join(directory, 'live state.db');
  const source = join(directory, 'restore source.db');
  let destinationStore;
  let sourceStore;
  try {
    destinationStore = await createSqliteStore(destination);
    sourceStore = await createSqliteStore(source);
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  await destinationStore.save(graphPayload('sqlite-deterministic-child-old'));
  await sourceStore.save(graphPayload('sqlite-deterministic-child-restored'));
  await advanceSqliteRevision(sourceStore, 17);
  sourceStore.close();

  const child = gatedSqliteWriter(destination, 'sqlite-deterministic-child-writer');
  t.after(() => {
    if (child.child.exitCode === null && child.child.signalCode === null) child.child.kill();
  });
  const loaded = await child.loaded;
  assert.equal(loaded.revision, 1, 'child must retain the pre-restore snapshot');

  const validationEntered = deferred();
  const releaseValidation = deferred();
  let validationCount = 0;
  const restoring = destinationStore.restore(source, { async validate() {
    if (validationCount++ !== 0) return;
    validationEntered.resolve();
    await releaseValidation.promise;
  } });
  await validationEntered.promise;
  releaseValidation.resolve();
  const restoreOutcome = await Promise.allSettled([restoring]);
  child.proceed();
  const writerOutcome = await child.outcome;

  assert.equal(restoreOutcome[0].status, 'fulfilled', restoreOutcome[0].reason?.stack ?? restoreOutcome[0].reason?.message);
  destinationStore.close();
  const reopened = await createSqliteStore(destination);
  const durable = await reopened.load();
  reopened.close();
  assert.equal(durable.records.some((record) => record.id === 'sqlite-deterministic-child-restored'), true);
  if (writerOutcome.status === 'fulfilled') {
    assert.equal(durable.records.some((record) => record.id === 'sqlite-deterministic-child-writer'), true);
  } else {
    assert.match(writerOutcome.message, /revision conflict/i);
  }
});

test('DS-P1-003/004 SQLite stress: child writers, two restores, rollback, idle handles, and ABA remain durable', async (t) => {
  for (let repetition = 0; repetition < 3; repetition += 1) {
    const directory = await mkdtemp(join(tmpdir(), `shadowgraph sqlite lifecycle stress ${repetition} `));
    const destination = join(directory, 'live state with spaces.db');
    const firstSource = join(directory, 'first restore source.db');
    const secondSource = join(directory, 'second restore source.db');
    let destinationStore;
    let idleStore;
    let firstSourceStore;
    let secondSourceStore;
    try {
      destinationStore = await createSqliteStore(destination);
      idleStore = await createSqliteStore(destination);
      firstSourceStore = await createSqliteStore(firstSource);
      secondSourceStore = await createSqliteStore(secondSource);
    } catch (error) {
      if (/requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    t.after(() => {
      for (const store of [destinationStore, idleStore, firstSourceStore, secondSourceStore]) {
        try { store?.close(); } catch {}
      }
    });

    await destinationStore.save(graphPayload(`stress-old-${repetition}`));
    await firstSourceStore.save(graphPayload(`stress-first-${repetition}`));
    await advanceSqliteRevision(firstSourceStore, 5);
    await secondSourceStore.save(graphPayload(`stress-second-${repetition}`));
    await advanceSqliteRevision(secondSourceStore, 7);
    firstSourceStore.close();
    firstSourceStore = undefined;
    secondSourceStore.close();
    secondSourceStore = undefined;

    const idleSnapshot = await idleStore.load();
    assert.equal(idleSnapshot.revision, 1);
    const staleChild = gatedSqliteWriter(destination, `stress-stale-child-${repetition}`);
    t.after(() => {
      if (staleChild.child.exitCode === null && staleChild.child.signalCode === null) staleChild.child.kill();
    });
    assert.equal((await staleChild.loaded).revision, 1);

    await destinationStore.restore(firstSource);
    assert.equal((await destinationStore.load()).revision, 6);
    await assert.rejects(
      destinationStore.restore(secondSource, { afterReplace() { throw new Error(`stress rollback ${repetition}`); } }),
      (error) => error.code === 'sqlite_restore_rolled_back' && error.message.includes(`stress rollback ${repetition}`)
    );
    const rolledBack = await destinationStore.load();
    assert.equal(rolledBack.revision, 6, 'failed restore must roll back the exact prior revision');
    assert.deepEqual(rolledBack.records.map((record) => record.id), [`stress-first-${repetition}`]);

    const validationEntered = deferred();
    const releaseValidation = deferred();
    let validationCount = 0;
    const finalRestore = destinationStore.restore(secondSource, { async validate() {
      if (validationCount++ !== 0) return;
      validationEntered.resolve();
      await releaseValidation.promise;
    } });
    await validationEntered.promise;
    const duringChild = gatedSqliteWriter(destination, `stress-during-child-${repetition}`, 'during');
    t.after(() => {
      if (duringChild.child.exitCode === null && duringChild.child.signalCode === null) duringChild.child.kill();
    });
    await duringChild.started;
    releaseValidation.resolve();
    const [restoreResult, duringOutcome] = await Promise.all([finalRestore, duringChild.outcome]);
    assert.equal(restoreResult.destination, destination);
    assert.equal(duringOutcome.status, 'fulfilled', duringOutcome.message);

    staleChild.proceed();
    const staleOutcome = await staleChild.outcome;
    assert.equal(staleOutcome.status, 'rejected');
    assert.match(staleOutcome.message, /revision conflict/i);

    const reopened = await createSqliteStore(destination);
    const durable = await reopened.load();
    reopened.close();
    assert.equal(durable.revision, 9);
    assert.equal(durable.records.some((record) => record.id === `stress-second-${repetition}`), true);
    assert.equal(durable.records.some((record) => record.id === `stress-during-child-${repetition}`), true);
    assert.equal(durable.records.some((record) => record.id === `stress-stale-child-${repetition}`), false);
    assert.equal(durable.records.some((record) => record.id === `stress-first-${repetition}`), false);
    assert.deepEqual(await idleStore.load(), durable, 'an idle independent store must reopen the final durable identity');

    destinationStore.close();
    destinationStore = undefined;
    idleStore.close();
    idleStore = undefined;
    const leftovers = (await readdir(directory)).filter((name) =>
      name.startsWith('live state with spaces.db-') || /\.(?:restore|rollback|old|recovery)$/.test(name)
    );
    assert.deepEqual(leftovers, [], 'the destination and all restore artifacts must be removable after each repetition');
  }
});

test('DS-P1-003 SQLite: an independent restore waiter releases its stale live handle before replacement', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review sqlite restore waiter '));
  const destination = join(directory, 'live state.db');
  const firstSource = join(directory, 'first source.db');
  const secondSource = join(directory, 'second source.db');
  let first;
  let second;
  let firstSourceStore;
  let secondSourceStore;
  try {
    first = await createSqliteStore(destination);
    second = await createSqliteStore(destination);
    firstSourceStore = await createSqliteStore(firstSource);
    secondSourceStore = await createSqliteStore(secondSource);
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  await first.save(graphPayload('sqlite-restore-waiter-old'));
  await firstSourceStore.save(graphPayload('sqlite-restore-waiter-first'));
  await advanceSqliteRevision(firstSourceStore, 17);
  firstSourceStore.close();
  await secondSourceStore.save(graphPayload('sqlite-restore-waiter-second'));
  await advanceSqliteRevision(secondSourceStore, 19);
  secondSourceStore.close();

  const validationEntered = deferred();
  const releaseValidation = deferred();
  let validations = 0;
  const firstRestore = first.restore(firstSource, { async validate() {
    if (validations++ !== 0) return;
    validationEntered.resolve();
    await releaseValidation.promise;
  } });
  await validationEntered.promise;
  const secondRestore = second.restore(secondSource);
  assert.equal((await settleState(secondRestore)).settled, false);
  releaseValidation.resolve();
  const outcomes = await Promise.allSettled([firstRestore, secondRestore]);
  assert.deepEqual(
    outcomes.map((outcome) => outcome.status),
    ['fulfilled', 'fulfilled'],
    outcomes.map((outcome) => outcome.reason?.stack ?? outcome.reason?.message ?? null).join('\n---\n')
  );
  first.close();
  second.close();
  const reopened = await createSqliteStore(destination);
  assert.deepEqual((await reopened.load()).records.map((record) => record.id), ['sqlite-restore-waiter-second']);
  reopened.close();
});

test('DS-P1-003 JSON: validation callback reentry fails explicitly instead of deadlocking the destination fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review json reentry '));
  const destination = join(directory, 'live state.json');
  const source = join(directory, 'restore source.json');
  const destinationStore = createJsonFileStore(destination, { lockTimeoutMs: 2000 });
  const callbackStore = createJsonFileStore(destination, { lockTimeoutMs: 2000 });
  await destinationStore.save(graphPayload('json-reentry-old'));
  const stalePayload = writerPayload(await callbackStore.load(), 'json-reentry-writer');
  await writePayload(source, graphPayload('json-reentry-restored', 17));
  let callbackError;

  await restoreFile(source, destination, {
    async validate() {
      await assert.rejects(callbackStore.save(stalePayload), (error) => {
        callbackError = error;
        return error.code === 'storage_lock_reentrant';
      });
    }
  });

  assert.equal(callbackError.name, 'DestinationFenceReentryError');
  const reopened = createJsonFileStore(destination);
  assert.deepEqual((await reopened.load()).records.map((record) => record.id), ['json-reentry-restored']);
  reopened.close();
  destinationStore.close();
  callbackStore.close();
});

test('DS-P1-003 SQLite: activation callback reentry fails explicitly and the replacement remains usable', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review sqlite reentry '));
  const destination = join(directory, 'live state.db');
  const source = join(directory, 'restore source.db');
  let destinationStore;
  let callbackStore;
  let sourceStore;
  try {
    destinationStore = await createSqliteStore(destination, { lockTimeoutMs: 2000 });
    sourceStore = await createSqliteStore(source);
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  await destinationStore.save(graphPayload('sqlite-reentry-old'));
  const stalePayload = writerPayload(await destinationStore.load(), 'sqlite-reentry-writer');
  await sourceStore.save(graphPayload('sqlite-reentry-restored'));
  await advanceSqliteRevision(sourceStore, 17);
  sourceStore.close();
  callbackStore = await createSqliteStore(destination, { lockTimeoutMs: 2000 });
  let callbackError;

  await destinationStore.restore(source, {
    async afterReplace() {
      try {
        await assert.rejects(callbackStore.save(stalePayload), (error) => {
          callbackError = error;
          return error.code === 'storage_lock_reentrant';
        });
      } finally {
        callbackStore.close();
        callbackStore = undefined;
      }
    }
  });

  assert.equal(callbackError.name, 'DestinationFenceReentryError');
  destinationStore.close();
  const reopened = await createSqliteStore(destination);
  assert.deepEqual((await reopened.load()).records.map((record) => record.id), ['sqlite-reentry-restored']);
  reopened.close();
});

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-003 ${backend}: destination fence times out explicitly and then recovers a stale lock`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `shadowgraph fifth review ${backend} lock `));
    const destination = join(directory, backend === 'sqlite' ? 'live state.db' : 'live state.json');
    let store;
    try {
      store = backend === 'sqlite'
        ? await createSqliteStore(destination, { lockTimeoutMs: 60, staleLockMs: 10_000, lockPollIntervalMs: 5 })
        : createJsonFileStore(destination, { lockTimeoutMs: 60, staleLockMs: 10_000, lockPollIntervalMs: 5 });
    } catch (error) {
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }
    await store.save(graphPayload(`${backend}-lock-old`));
    const pendingPayload = writerPayload(await store.load(), `${backend}-lock-writer`);
    const lockPath = `${resolve(destination)}.lock`;
    await writeFile(lockPath, 'live-owner', 'utf8');
    await assert.rejects(store.save(pendingPayload), (error) => {
      assert.equal(error.code, 'storage_lock_timeout');
      assert.equal(resolve(error.lockPath), resolve(lockPath));
      return true;
    });

    await utimes(lockPath, new Date('2000-01-01T00:00:00.000Z'), new Date('2000-01-01T00:00:00.000Z'));
    const recoveringStore = backend === 'sqlite'
      ? await createSqliteStore(destination, { lockTimeoutMs: 1000, staleLockMs: 20, lockPollIntervalMs: 5 })
      : createJsonFileStore(destination, { lockTimeoutMs: 1000, staleLockMs: 20, lockPollIntervalMs: 5 });
    const revision = await recoveringStore.save(pendingPayload);
    assert.equal(revision, 2);
    await assert.rejects(stat(lockPath), (error) => error.code === 'ENOENT');
    recoveringStore.close();
    store.close();
    const reopened = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
    assert.equal((await reopened.load()).records.some((record) => record.id === `${backend}-lock-writer`), true);
    reopened.close();
  });
}

for (const backend of ['json', 'sqlite']) {
  test(`DS-P1-003 ${backend}: a child-process writer waits behind restore and is checked against restored state`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), `shadowgraph fifth review ${backend} child `));
    const destination = join(directory, backend === 'sqlite' ? 'live state.db' : 'live state.json');
    const source = join(directory, backend === 'sqlite' ? 'restore source.db' : 'restore source.json');
    let destinationStore;
    let sourceStore;
    try {
      destinationStore = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
      await destinationStore.save(graphPayload(`${backend}-child-old`));
      if (backend === 'sqlite') {
        sourceStore = await createSqliteStore(source);
        await sourceStore.save(graphPayload(`${backend}-child-restored`));
        await advanceSqliteRevision(sourceStore, 17);
        sourceStore.close();
        sourceStore = undefined;
      } else {
        await writePayload(source, graphPayload(`${backend}-child-restored`, 17));
      }
    } catch (error) {
      destinationStore?.close();
      sourceStore?.close();
      if (backend === 'sqlite' && /requires Node/.test(error.message)) return t.skip(error.message);
      throw error;
    }

    const validationEntered = deferred();
    const releaseValidation = deferred();
    let validationCount = 0;
    const restoring = backend === 'sqlite'
      ? destinationStore.restore(source, { async validate() {
        if (validationCount++ !== 0) return;
        validationEntered.resolve();
        await releaseValidation.promise;
      } })
      : restoreFile(source, destination, { async validate() {
        validationEntered.resolve();
        await releaseValidation.promise;
      } });
    await validationEntered.promise;
    const child = externalWriter(backend, destination, `${backend}-child-writer`);
    const beforeRelease = await settleState(child.outcome);
    assert.equal(beforeRelease.settled, false, 'child writer must remain pending while restore owns the fence');
    releaseValidation.resolve();
    const [restoreOutcome, writerOutcome] = await Promise.allSettled([restoring, child.outcome]);
    assert.equal(restoreOutcome.status, 'fulfilled', restoreOutcome.reason?.message);
    assert.equal(writerOutcome.status, 'fulfilled', writerOutcome.reason?.message);
    destinationStore.close();
    const reopened = backend === 'sqlite' ? await createSqliteStore(destination) : createJsonFileStore(destination);
    const durable = await reopened.load();
    reopened.close();
    assert.equal(durable.records.some((record) => record.id === `${backend}-child-restored`), true);
    if (writerOutcome.value.status === 'fulfilled') {
      assert.equal(
        durable.records.some((record) => record.id === `${backend}-child-writer`),
        true,
        'an acknowledged child write must survive a fresh durable reopen'
      );
    } else {
      assert.match(writerOutcome.value.message, /revision conflict/i);
      assert.equal(durable.records.some((record) => record.id === `${backend}-child-writer`), false);
    }
  });
}

test('DS-P1-003 JSON: restore waits when a child writer already owns the destination fence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review json writer first '));
  const destination = join(directory, 'live state.json');
  const source = join(directory, 'restore source.json');
  const seed = createJsonFileStore(destination);
  await seed.save(graphPayload('json-writer-first-old'));
  seed.close();
  await writePayload(source, graphPayload('json-writer-first-restored', 17));

  const child = externalWriter('json', destination, 'json-writer-first', 50_000);
  await waitForFile(`${resolve(destination)}.lock`);
  const restoring = restoreFile(source, destination);
  const [writerOutcome, restoreOutcome] = await Promise.all([child.outcome, restoring]);
  assert.equal(writerOutcome.status, 'fulfilled');
  assert.equal(restoreOutcome.records, 1);
  const reopened = createJsonFileStore(destination);
  assert.deepEqual((await reopened.load()).records.map((record) => record.id), ['json-writer-first-restored']);
  reopened.close();
});

test('DS-P1-003 SQLite: a child writer begun before restore either completes first or conflicts', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review sqlite writer first '));
  const destination = join(directory, 'live state.db');
  const source = join(directory, 'restore source.db');
  let destinationStore;
  let sourceStore;
  try {
    destinationStore = await createSqliteStore(destination);
    sourceStore = await createSqliteStore(source);
  } catch (error) {
    if (/requires Node/.test(error.message)) return t.skip(error.message);
    throw error;
  }
  await destinationStore.save(graphPayload('sqlite-writer-first-old'));
  await sourceStore.save(graphPayload('sqlite-writer-first-restored'));
  await advanceSqliteRevision(sourceStore, 17);
  sourceStore.close();

  const child = externalWriter('sqlite', destination, 'sqlite-writer-first', 2000);
  await waitForFile(`${resolve(destination)}.lock`);
  const restoring = destinationStore.restore(source);
  const [writerOutcome, restoreOutcome] = await Promise.all([child.outcome, restoring]);
  if (writerOutcome.status === 'rejected') assert.match(writerOutcome.message, /revision conflict|lock/i);
  else assert.equal(writerOutcome.status, 'fulfilled');
  assert.equal(restoreOutcome.destination, destination);
  destinationStore.close();
  const reopened = await createSqliteStore(destination);
  const durable = await reopened.load();
  reopened.close();
  assert.equal(durable.records.some((record) => record.id === 'sqlite-writer-first-restored'), true);
  if (writerOutcome.status === 'fulfilled') {
    if (writerOutcome.revision === durable.revision) {
      assert.equal(
        durable.records.some((record) => record.id === 'sqlite-writer-first-1999'),
        true,
        'a writer serialized after restore must survive at its acknowledged durable revision'
      );
    } else {
      assert.equal(
        writerOutcome.revision < durable.revision,
        true,
        'a fulfilled writer may be absent only when a later restore installed a higher revision'
      );
      assert.deepEqual(durable.records.map((record) => record.id), ['sqlite-writer-first-restored']);
    }
  } else {
    assert.deepEqual(durable.records.map((record) => record.id), ['sqlite-writer-first-restored']);
  }
});

test('DS-P1-003 HTTP restore fences an external JSON writer through activation and fresh reopen', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review HTTP external writer '));
  const destination = join(directory, 'live state.json');
  const source = join(directory, 'restore source.json');
  const seed = createJsonFileStore(destination);
  await seed.save(graphPayload('http-old'));
  seed.close();
  await writePayload(source, graphPayload('http-restored', 17));
  const writeEntered = deferred();
  const releaseWrite = deferred();
  let gated = false;
  const app = await createShadowGraphServer({
    file: destination,
    restoreFs: {
      async writeFile(path, data, encoding) {
        if (!gated && String(path).endsWith('.tmp')) {
          gated = true;
          writeEntered.resolve();
          await releaseWrite.promise;
        }
        return writeFile(path, data, encoding);
      }
    }
  });
  t.after(async () => { await closeServer(app.server); });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const writerStore = createJsonFileStore(destination);
  const stalePayload = writerPayload(await writerStore.load(), 'http-external-writer');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const restoring = fetch(`${base}/restore`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source })
  });
  await writeEntered.promise;
  const writing = writerStore.save(stalePayload);
  assert.equal((await settleState(writing)).settled, false);
  releaseWrite.resolve();
  const [response, writerOutcome] = await Promise.all([restoring, Promise.allSettled([writing])]);
  assert.equal(response.status, 200, await response.text());
  assert.equal(writerOutcome[0].status, 'rejected');
  assert.match(writerOutcome[0].reason.message, /revision conflict/i);
  writerStore.close();
  await closeServer(app.server);
  const reopened = createJsonFileStore(destination);
  assert.deepEqual((await reopened.load()).records.map((record) => record.id), ['http-restored']);
  reopened.close();
});

test('DS-P1-003 MCP restore fences an external JSON writer in a separate server process', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fifth review MCP external writer '));
  const destination = join(directory, 'live state.json');
  const source = join(directory, 'restore source.json');
  const seed = createJsonFileStore(destination);
  await seed.save(graphPayload('mcp-old'));
  seed.close();
  const replacementGraph = createShadowGraph({ now: () => FIXED_NOW });
  for (let index = 0; index < 3000; index += 1) {
    replacementGraph.addDecision({ id: `mcp-restored-${index}`, project: 'fifth-review', title: `MCP ${index}`, chosen: `MCP ${index}` });
  }
  await writePayload(source, { ...replacementGraph.exportData(), revision: 17 });
  const writerStore = createJsonFileStore(destination);
  const stalePayload = writerPayload(await writerStore.load(), 'mcp-external-writer');
  const rpc = startMcp(destination);
  t.after(async () => { await rpc.stop(); });
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const restoring = rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'shadowgraph_restore', arguments: { source } }
  });
  await waitForFile(`${resolve(destination)}.lock`);
  const writing = writerStore.save(stalePayload);
  const [restoreResponse, writerOutcome] = await Promise.all([restoring, Promise.allSettled([writing])]);
  assert.equal(restoreResponse.error, undefined, restoreResponse.error?.message);
  assert.equal(writerOutcome[0].status, 'rejected');
  assert.match(writerOutcome[0].reason.message, /revision conflict/i);
  writerStore.close();
  await rpc.stop();
  const reopened = createJsonFileStore(destination);
  const durable = await reopened.load();
  reopened.close();
  assert.equal(durable.records.length, 3000);
  assert.equal(durable.records.some((record) => record.id === 'mcp-external-writer'), false);
});

test('DS-P1-003 destination fence treats a transiently unopenable lock as contention and still fails closed', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph fence contention '));
  const destination = join(directory, 'live state.json');
  const lockPath = `${resolve(destination)}.lock`;

  // A held lock must still fail closed rather than being stolen.
  const holder = createDestinationFence(destination, { lockTimeoutMs: 2000, lockPollIntervalMs: 5 });
  const impatient = createDestinationFence(destination, { lockTimeoutMs: 60, staleLockMs: 10_000, lockPollIntervalMs: 5 });
  const held = deferred();
  const holding = holder.run(async () => { await held.promise; });
  await waitForFile(lockPath);
  await assert.rejects(impatient.run(async () => 'must not run'), (error) => {
    assert.equal(error.code, 'storage_lock_timeout');
    return true;
  });
  held.resolve();
  await holding;

  // A foreign lock that disappears while a writer is waiting must be waited out,
  // not treated as a hard failure. On Windows the same window can answer `open`
  // with EPERM/EACCES instead of EEXIST, which is why those codes count as
  // contention there; the observable contract is identical on every platform.
  await writeFile(lockPath, 'foreign-holder', 'utf8');
  const patient = createDestinationFence(destination, { lockTimeoutMs: 5000, staleLockMs: 10_000, lockPollIntervalMs: 5 });
  let waited = false;
  const removal = delay(120).then(() => rm(lockPath, { force: true }));
  const acquired = await patient.run(async () => 'acquired', { onWait: () => { waited = true; } });
  await removal;
  assert.equal(acquired, 'acquired');
  assert.equal(waited, true, 'the writer must report waiting rather than failing immediately');

  // The fence is reusable and leaves no lock behind.
  assert.equal(await patient.run(async () => 'reacquired'), 'reacquired');
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith('.lock')), []);
  await rm(directory, { recursive: true, force: true });
});
