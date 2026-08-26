import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import {
  copyFile as realCopyFile,
  mkdtemp,
  readdir,
  rename as realRename,
  stat as realStat,
  unlink as realUnlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createShadowGraphServer } from '../src/server.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';

const snapshot = (id) => ({
  schemaVersion: 3,
  revision: 0,
  records: [{ id, kind: 'decision', project: 'default', status: 'active', title: id, chosen: id }],
  facts: [],
  relations: [],
  reviewSignals: [],
  idempotency: [],
  events: [],
  journal: [],
  journalSeq: 0,
  journalEpoch: null
});

const journalSnapshot = (title = 'NEW') => {
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  graph.addDecision({ project: 'default', title, chosen: title });
  return graph.exportData();
};

const unsupported = (error) => /SQLite storage requires Node/.test(error.message);
const closeQuietly = (store) => { try { store?.close(); } catch { /* test cleanup */ } };
const artifactPattern = /\.(?:restore|rollback|old|recovery)(?:-(?:wal|shm|journal))?$/;

async function artifacts(directory) {
  return (await readdir(directory)).filter((name) => artifactPattern.test(name)).sort();
}

async function createPair(t, prefix, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  const livePath = join(directory, 'live.db');
  const sourcePath = join(directory, 'source.db');
  let live;
  let source;
  try {
    live = await createSqliteStore(livePath, options.liveOptions);
    source = await createSqliteStore(sourcePath, options.sourceOptions);
  } catch (error) {
    closeQuietly(live);
    closeQuietly(source);
    if (unsupported(error)) {
      t.skip(error.message);
      return null;
    }
    throw error;
  }
  const pair = { directory, livePath, sourcePath, live, source };
  t.after(() => {
    closeQuietly(pair.live);
    closeQuietly(pair.source);
  });
  return pair;
}

async function assertOldState(pair) {
  assert.equal((await pair.live.load()).records[0].id, 'OLD', 'live handle must read the old state');
  pair.live.close();
  pair.live = undefined;
  const reopened = await createSqliteStore(pair.livePath);
  try {
    assert.equal((await reopened.load()).records[0].id, 'OLD', 'disk state must reopen as the old state');
  } finally {
    reopened.close();
  }
  assert.deepEqual(await artifacts(pair.directory), [], 'ordinary recovery must clean restore artifacts');
}

async function seed(pair) {
  await pair.live.save(snapshot('OLD'));
  await pair.source.save(snapshot('NEW'));
}

async function databaseSync(t) {
  try {
    return (await import('node:sqlite')).DatabaseSync;
  } catch (error) {
    t.skip(`node:sqlite unavailable: ${error.message}`);
    return null;
  }
}

function openWith(DatabaseSync, path, options) {
  return options ? new DatabaseSync(path, options) : new DatabaseSync(path);
}

test('SQLite restore rejects malformed readable payload before touching live state', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-malformed-');
  if (!pair) return;
  await pair.live.save(snapshot('OLD'));
  await pair.source.save({ ...snapshot('NEW'), records: [{ id: 'bad', kind: 'unknown' }] });
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath), /records\[0\] is malformed/);
  await assertOldState(pair);
});

test('SQLite restore rejects a journal entry missing its required payload', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-journal-missing-payload-');
  if (!pair) return;
  await pair.live.save(snapshot('OLD'));
  const malformed = journalSnapshot('NEW');
  delete malformed.journal.find((entry) => entry.type === 'decision.recorded').payload;
  await pair.source.save(malformed);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath), /missing_payload/);
  await assertOldState(pair);
});

test('SQLite restore rejects a replayable journal type marked non-replayable', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-journal-replayable-flag-');
  if (!pair) return;
  await pair.live.save(snapshot('OLD'));
  const contradictory = journalSnapshot('NEW');
  contradictory.journal.find((entry) => entry.type === 'decision.recorded').replayable = false;
  await pair.source.save(contradictory);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath), /marked_non_replayable/);
  await assertOldState(pair);
});

test('SQLite restore rejects a journal epoch outside the available sequence range', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-journal-epoch-');
  if (!pair) return;
  await pair.live.save(snapshot('OLD'));
  const impossible = journalSnapshot('NEW');
  impossible.records = [];
  impossible.journalEpoch = impossible.journalSeq + 1;
  await pair.source.save(impossible);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath), /journal epoch is outside the available sequence range/);
  await assertOldState(pair);
});

test('SQLite restore rejects live state that diverges from its journal projection', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-journal-parity-');
  if (!pair) return;
  await pair.live.save(snapshot('OLD'));
  const divergent = journalSnapshot('JOURNAL');
  divergent.records[0].title = 'LIVE_ONLY_TAMPER';
  await pair.source.save(divergent);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath), /journal projection does not match live records/);
  await assertOldState(pair);
});

test('SQLite restore succeeds, folds source WAL state, closes its source handle, and cleans artifacts', async (t) => {
  const DatabaseSync = await databaseSync(t);
  if (!DatabaseSync) return;
  const openedPaths = new WeakMap();
  let internalSourceCloses = 0;
  let sourceRaw;
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-success-', {
    liveOptions: {
      openDatabase(path, options) {
        const handle = openWith(DatabaseSync, path, options);
        openedPaths.set(handle, resolve(path));
        return handle;
      },
      closeHandle(handle) {
        if (openedPaths.get(handle) === resolve(pair.sourcePath)) internalSourceCloses += 1;
        handle.close();
      }
    },
    sourceOptions: {
      openDatabase(path, options) {
        const handle = openWith(DatabaseSync, path, options);
        if (resolve(path).endsWith('source.db')) {
          sourceRaw = handle;
          handle.exec('PRAGMA wal_autocheckpoint = 0');
        }
        return handle;
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  assert.ok(sourceRaw, 'test must control the source connection');
  assert.ok((await readdir(pair.directory)).includes('source.db-wal'), 'source mutation must still be represented by WAL state');

  await pair.live.restore(pair.sourcePath, { validate: (payload) => {
    assert.equal(payload.records[0].id, 'NEW');
  } });

  assert.equal(internalSourceCloses, 1, 'restore-owned source handle closes exactly once');
  assert.equal((await pair.live.load()).records[0].id, 'NEW');
  pair.live.close();
  pair.live = undefined;
  pair.source.close();
  pair.source = undefined;
  const reopened = await createSqliteStore(pair.livePath);
  try { assert.equal((await reopened.load()).records[0].id, 'NEW'); }
  finally { reopened.close(); }
  assert.deepEqual(await artifacts(pair.directory), []);
});

test('SQLite restore closes its source handle when validation fails', async (t) => {
  const DatabaseSync = await databaseSync(t);
  if (!DatabaseSync) return;
  const openedPaths = new WeakMap();
  let sourceCloses = 0;
  let sourcePath;
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-source-close-', {
    liveOptions: {
      openDatabase(path, options) {
        const handle = openWith(DatabaseSync, path, options);
        openedPaths.set(handle, resolve(path));
        return handle;
      },
      closeHandle(handle) {
        if (openedPaths.get(handle) === resolve(sourcePath)) sourceCloses += 1;
        handle.close();
      }
    }
  });
  if (!pair) return;
  sourcePath = pair.sourcePath;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath, { validate: () => { throw new Error('validation failed'); } }), /validation failed/);
  assert.equal(sourceCloses, 1, 'restore-owned source handle must close on failure');
  await assertOldState(pair);
});

test('SQLite restore closes its source handle when reading the source fails', async (t) => {
  const DatabaseSync = await databaseSync(t);
  if (!DatabaseSync) return;
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-sqlite-restore-source-read-failure-'));
  const livePath = join(directory, 'live.db');
  const sourcePath = join(directory, 'source.db');
  const openedPaths = new WeakMap();
  let sourceCloses = 0;
  let live;
  try {
    live = await createSqliteStore(livePath, {
      openDatabase(path, options) {
        const handle = openWith(DatabaseSync, path, options);
        openedPaths.set(handle, resolve(path));
        return handle;
      },
      closeHandle(handle) {
        if (openedPaths.get(handle) === resolve(sourcePath)) sourceCloses += 1;
        handle.close();
      }
    });
  } catch (error) {
    if (unsupported(error)) return t.skip(error.message);
    throw error;
  }
  const pair = { directory, livePath, sourcePath, live, source: undefined };
  t.after(() => closeQuietly(pair.live));
  await live.save(snapshot('OLD'));
  const rawSource = new DatabaseSync(sourcePath);
  rawSource.close();

  await assert.rejects(live.restore(sourcePath), /no such table: shadowgraph_meta/);
  assert.equal(sourceCloses, 1, 'source handle must close after a read failure');
  await assertOldState(pair);
});

test('SQLite restore keeps old state when failure occurs before replacement', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-before-', {
    liveOptions: { restoreFault(stage) { if (stage === 'beforeSourceSnapshot') throw new Error('injected pre-replacement failure'); } }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;
  await assert.rejects(pair.live.restore(pair.sourcePath), /injected pre-replacement failure/);
  await assertOldState(pair);
});

test('SQLite restore keeps old state when live displacement rename fails', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-displace-', {
    liveOptions: {
      restoreFs: {
        async rename(from, to) {
          if (String(to).endsWith('.old')) throw new Error('injected live displacement failure');
          return realRename(from, to);
        }
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;
  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored: injected live displacement failure/);
  await assertOldState(pair);
});

test('SQLite restore keeps old state when replacement rename fails', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-rename-', {
    liveOptions: {
      restoreFs: {
        async rename(from, to) {
          if (String(from).endsWith('.restore')) throw new Error('injected replacement rename failure');
          return realRename(from, to);
        }
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;
  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored: injected replacement rename failure/);
  await assertOldState(pair);
});

test('SQLite restore rolls back failure after replacement rename and before reopen', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-post-rename-', {
    liveOptions: { restoreFault(stage) { if (stage === 'afterReplacementRename') throw new Error('injected post-rename failure'); } }
  });
  if (!pair) return;
  await seed(pair);
  assert.ok((await readdir(pair.directory)).includes('live.db-wal'), 'old committed state must still be represented by live WAL before rollback snapshot');
  pair.source.close();
  pair.source = undefined;
  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored: injected post-rename failure/);
  await assertOldState(pair);
});

test('SQLite restore rolls back an actual replacement DatabaseSync open failure', async (t) => {
  const DatabaseSync = await databaseSync(t);
  if (!DatabaseSync) return;
  let liveOpens = 0;
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-open-', {
    liveOptions: {
      openDatabase(path, options) {
        if (String(path).endsWith('live.db')) {
          liveOpens += 1;
          if (liveOpens === 2) return new DatabaseSync(path, { readOnly: 'not-a-boolean' });
        }
        return openWith(DatabaseSync, path, options);
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored:.*options\.readOnly.*boolean/i);
  assert.equal(liveOpens, 5, 'initial, failed replacement, rejected destination inspection, recovered read-only inspection, and verified recovery opens must occur');
  await assertOldState(pair);
});

test('SQLite restore rolls back an actual replacement prepare failure', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-prepare-', {
    liveOptions: {
      prepareDatabase(database, stage, runDefault) {
        if (stage === 'replacement') database.exec('THIS IS NOT VALID SQL');
        return runDefault(database);
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored:.*syntax error/i);
  await assertOldState(pair);
});

test('SQLite restore rolls back a failure while reading the installed replacement', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-replacement-read-', {
    liveOptions: {
      prepareDatabase(database, stage, runDefault) {
        runDefault(database);
        if (stage === 'replacement') database.exec('DROP TABLE shadowgraph_meta');
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored:.*shadowgraph_meta/i);
  await assertOldState(pair);
});

test('SQLite restore rolls back a domain-validation failure on the installed replacement', async (t) => {
  let validationCalls = 0;
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-replacement-validation-');
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath, {
    validate() {
      validationCalls += 1;
      if (validationCalls === 3) throw new Error('injected installed replacement validation failure');
    }
  }), /previous database restored: injected installed replacement validation failure/);
  assert.equal(validationCalls, 3, 'source, staged snapshot, and installed replacement must each be validated');
  await assertOldState(pair);
});

test('SQLite restore reports unconfirmed recovery and retains the complete rollback snapshot', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-recovery-failure-', {
    liveOptions: {
      restoreFault(stage) { if (stage === 'afterReplacementRename') throw new Error('trigger recovery'); },
      restoreFs: {
        async copyFile(from, to) {
          if (String(from).endsWith('.rollback')) throw new Error('injected recovery copy failure');
          return realCopyFile(from, to);
        }
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;

  let recoveryError;
  await assert.rejects(pair.live.restore(pair.sourcePath), (error) => {
    recoveryError = error;
    assert.equal(error.code, 'sqlite_restore_recovery_unconfirmed');
    assert.match(error.message, /rollback is unconfirmed/);
    assert.ok(error.rollbackArtifact);
    assert.equal(error.recoveryArtifact, undefined, 'a copy failure before file creation must not report a nonexistent recovery file');
    return true;
  });
  for (const path of recoveryError.retainedArtifacts) {
    assert.equal((await realStat(path)).isFile(), true);
    await realUnlink(path);
  }
  assert.deepEqual(await artifacts(pair.directory), [], 'test cleanup removes intentionally retained recovery artifacts');
});

test('SQLite unconfirmed recovery reports exactly the staged, rollback, and displaced files that exist', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-artifact-inventory-', {
    liveOptions: {
      restoreFs: {
        async rename(from, to) {
          if (String(from).endsWith('.restore')) throw new Error('injected replacement rename failure');
          return realRename(from, to);
        },
        async copyFile(from, to) {
          if (String(from).endsWith('.rollback')) throw new Error('injected recovery copy failure');
          return realCopyFile(from, to);
        }
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;

  let recoveryError;
  await assert.rejects(pair.live.restore(pair.sourcePath), (error) => {
    recoveryError = error;
    assert.equal(error.code, 'sqlite_restore_recovery_unconfirmed');
    assert.ok(error.stagedArtifact);
    assert.ok(error.rollbackArtifact);
    assert.ok(error.displacedArtifact);
    assert.equal(error.recoveryArtifact, undefined);
    return true;
  });
  await assert.rejects(realStat(pair.livePath), (error) => error.code === 'ENOENT', 'recovery inspection must not create an empty live database');
  const suffixes = recoveryError.retainedArtifacts.map((path) => path.match(/\.(restore|rollback|old)$/)?.[1]).filter(Boolean).sort();
  assert.deepEqual(suffixes, ['old', 'restore', 'rollback']);
  for (const path of recoveryError.retainedArtifacts) {
    assert.equal((await realStat(path)).isFile(), true);
    await realUnlink(path);
  }
  assert.deepEqual(await artifacts(pair.directory), []);
});

test('HTTP SQLite restore failure keeps in-memory graph and persistent database aligned', async (t) => {
  const pair = await createPair(t, 'shadowgraph-http-sqlite-restore-post-replacement-', {
    liveOptions: { restoreFault(stage) { if (stage === 'afterReplacementRename') throw new Error('injected HTTP post-replacement failure'); } }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;
  const app = await createShadowGraphServer({ file: pair.livePath, storage: 'sqlite', store: pair.live });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: pair.sourcePath })
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /previous database restored/);
    assert.equal(app.graph.search('OLD').page.total, 1);
    assert.equal(app.graph.search('NEW').page.total, 0);
    assert.equal((await pair.live.load()).records[0].id, 'OLD');
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
  }
  await assertOldState(pair);
});

test('HTTP SQLite restore reports unconfirmed recovery as 500, retains rollback, and fail-closes the server', async (t) => {
  const pair = await createPair(t, 'shadowgraph-http-sqlite-restore-unconfirmed-', {
    liveOptions: {
      restoreFault(stage) { if (stage === 'afterReplacementRename') throw new Error('trigger HTTP recovery'); },
      restoreFs: {
        async copyFile(from, to) {
          if (String(from).endsWith('.rollback')) throw new Error('injected HTTP recovery failure');
          return realCopyFile(from, to);
        }
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;
  const app = await createShadowGraphServer({ file: pair.livePath, storage: 'sqlite', store: pair.live });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: pair.sourcePath })
    });
    assert.equal(response.status, 500);
    assert.match((await response.json()).error, /rollback is unconfirmed/);
    assert.equal(app.graph.search('OLD').page.total, 1, 'in-memory state must not be replaced after an unconfirmed disk recovery');

    const base = `http://127.0.0.1:${app.server.address().port}`;
    const writeAfterFatal = await fetch(`${base}/decisions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: 'default', title: 'POST_FATAL', chosen: 'x' })
    });
    assert.equal(writeAfterFatal.status, 503, 'unconfirmed recovery must latch the server unavailable before graph mutation');
    assert.match((await writeAfterFatal.json()).error, /persistent storage unavailable/i);
    assert.equal(app.graph.search('POST_FATAL').page.total, 0, 'a degraded server must not mutate in-memory graph state');

    const readAfterFatal = await fetch(`${base}/search?query=OLD`);
    assert.equal(readAfterFatal.status, 503, 'a degraded server must not serve potentially divergent graph reads');
    const healthAfterFatal = await fetch(`${base}/health`);
    assert.equal(healthAfterFatal.status, 200);
    const degradedHealth = await healthAfterFatal.json();
    assert.equal(degradedHealth.ok, false);
    assert.equal(degradedHealth.status, 'degraded');
  } finally {
    await new Promise((resolveClose) => app.server.close(resolveClose));
  }
  const retained = await artifacts(pair.directory);
  assert.ok(retained.some((name) => name.endsWith('.rollback')));
  for (const name of retained) await realUnlink(join(pair.directory, name));
  assert.deepEqual(await artifacts(pair.directory), []);
});

test('SQLite restore cleans an old-file artifact when rename moves then throws', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-moved-then-threw-', {
    liveOptions: {
      restoreFs: {
        async rename(from, to) {
          if (String(to).endsWith('.old')) {
            await realRename(from, to);
            throw new Error('injected moved-then-threw rename failure');
          }
          return realRename(from, to);
        }
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;
  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored: injected moved-then-threw rename failure/);
  await assertOldState(pair);
});

test('SQLite restore reopens old state when failure occurs after live close but before replacement', async (t) => {
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-after-close-', {
    liveOptions: { restoreFault(stage) { if (stage === 'afterLiveClose') throw new Error('injected post-close failure'); } }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;
  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored: injected post-close failure/);
  await assertOldState(pair);
});

test('SQLite restore recovers old state when stale-sidecar cleanup fails', async (t) => {
  let livePath;
  let failed = false;
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-sidecar-failure-', {
    liveOptions: {
      restoreFs: {
        async unlink(path) {
          if (!failed && String(path) === `${livePath}-wal`) {
            failed = true;
            const error = new Error('injected sidecar unlink failure');
            error.code = 'EIO';
            throw error;
          }
          return realUnlink(path);
        }
      }
    }
  });
  if (!pair) return;
  livePath = pair.livePath;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;
  await assert.rejects(pair.live.restore(pair.sourcePath), /previous database restored: injected sidecar unlink failure/);
  assert.equal(failed, true, 'the filesystem failure must execute');
  await assertOldState(pair);
});

test('SQLite restore reports a temporary artifact when cleanup itself fails', async (t) => {
  let validationCalls = 0;
  const pair = await createPair(t, 'shadowgraph-sqlite-restore-cleanup-failure-', {
    liveOptions: {
      restoreFs: {
        async unlink(path) {
          if (String(path).endsWith('.restore')) {
            const error = new Error('injected restore cleanup failure');
            error.code = 'EIO';
            throw error;
          }
          return realUnlink(path);
        }
      }
    }
  });
  if (!pair) return;
  await seed(pair);
  pair.source.close();
  pair.source = undefined;

  await assert.rejects(pair.live.restore(pair.sourcePath, {
    validate() {
      validationCalls += 1;
      if (validationCalls === 2) throw new Error('injected staged validation failure');
    }
  }), (error) => {
    assert.match(error.message, /staged validation failure/);
    assert.ok(error.retainedArtifacts?.some((path) => String(path).endsWith('.restore')));
    return true;
  });
  assert.equal((await pair.live.load()).records[0].id, 'OLD');
  const leftovers = await artifacts(pair.directory);
  assert.ok(leftovers.some((name) => name.endsWith('.restore')));
  for (const name of leftovers) await realUnlink(join(pair.directory, name));
});

test('CLI SQLite restore refuses a domain-invalid snapshot and preserves old state', async (t) => {
  const pair = await createPair(t, 'shadowgraph-cli-sqlite-restore-invalid-');
  if (!pair) return;
  await pair.live.save(snapshot('OLD'));
  await pair.source.save({ ...snapshot('NEW'), records: [{ id: 'bad', kind: 'unknown' }] });
  pair.live.close();
  pair.live = undefined;
  pair.source.close();
  pair.source = undefined;

  const result = await new Promise((resolveChild, rejectChild) => {
    const child = spawn(process.execPath, ['src/cli.js', 'restore', pair.sourcePath], {
      cwd: process.cwd(),
      env: { ...process.env, SHADOWGRAPH_STORAGE: 'sqlite', SHADOWGRAPH_FILE: pair.livePath }
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', rejectChild);
    child.on('close', (code) => resolveChild({ code, stdout, stderr }));
  });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /records\[0\] is malformed/);
  const reopened = await createSqliteStore(pair.livePath);
  try { assert.equal((await reopened.load()).records[0].id, 'OLD'); }
  finally { reopened.close(); }
  assert.deepEqual(await artifacts(pair.directory), []);
});

test('MCP SQLite restore refuses a domain-invalid snapshot and preserves old state', async (t) => {
  const pair = await createPair(t, 'shadowgraph-mcp-sqlite-restore-invalid-');
  if (!pair) return;
  await pair.live.save(snapshot('OLD'));
  await pair.source.save({ ...snapshot('NEW'), records: [{ id: 'bad', kind: 'unknown' }] });
  pair.live.close();
  pair.live = undefined;
  pair.source.close();
  pair.source = undefined;

  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_STORAGE: 'sqlite', SHADOWGRAPH_FILE: pair.livePath }
  });
  const responsePromise = new Promise((resolveResponse, rejectResponse) => {
    let buffer = '';
    const timer = setTimeout(() => rejectResponse(new Error('Timed out waiting for MCP restore response')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolveResponse(JSON.parse(buffer.slice(0, newline)));
    });
    child.on('error', (error) => { clearTimeout(timer); rejectResponse(error); });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 91, method: 'tools/call', params: { name: 'shadowgraph_restore', arguments: { source: pair.sourcePath } } })}\n`);
  const response = await responsePromise;
  child.kill();
  await once(child, 'exit');
  assert.equal(response.id, 91);
  assert.match(response.error.message, /records\[0\] is malformed/);
  const reopened = await createSqliteStore(pair.livePath);
  try { assert.equal((await reopened.load()).records[0].id, 'OLD'); }
  finally { reopened.close(); }
  assert.deepEqual(await artifacts(pair.directory), []);
});

test('MCP valid SQLite restore does not perform a post-commit save', async (t) => {
  const pair = await createPair(t, 'shadowgraph-mcp-sqlite-restore-valid-');
  if (!pair) return;
  await seed(pair);
  pair.live.close();
  pair.live = undefined;
  pair.source.close();
  pair.source = undefined;

  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_STORAGE: 'sqlite', SHADOWGRAPH_FILE: pair.livePath }
  });
  const responsePromise = new Promise((resolveResponse, rejectResponse) => {
    let buffer = '';
    const timer = setTimeout(() => rejectResponse(new Error('Timed out waiting for MCP restore response')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolveResponse(JSON.parse(buffer.slice(0, newline)));
    });
    child.on('error', (error) => { clearTimeout(timer); rejectResponse(error); });
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 92, method: 'tools/call', params: { name: 'shadowgraph_restore', arguments: { source: pair.sourcePath } } })}\n`);
  const response = await responsePromise;
  child.kill();
  await once(child, 'exit');
  assert.equal(response.id, 92);
  assert.equal(response.error, undefined);
  const reopened = await createSqliteStore(pair.livePath);
  try {
    const payload = await reopened.load();
    assert.equal(payload.records[0].id, 'NEW');
    assert.equal(payload.revision, 1, 'restore must preserve the source revision without a second save');
  } finally {
    reopened.close();
  }
  assert.deepEqual(await artifacts(pair.directory), []);
});

test('HTTP rejects a concurrent mutation before graph state changes during restore', async (t) => {
  let releaseStat;
  let reachedStat;
  const statReached = new Promise((resolveReached) => { reachedStat = resolveReached; });
  const statRelease = new Promise((resolveRelease) => { releaseStat = resolveRelease; });
  let sourcePath;
  const pair = await createPair(t, 'shadowgraph-http-sqlite-restore-concurrency-', {
    liveOptions: {
      restoreFs: {
        async stat(path) {
          if (resolve(path) === resolve(sourcePath)) {
            reachedStat();
            await statRelease;
          }
          return realStat(path);
        }
      }
    }
  });
  if (!pair) return;
  sourcePath = pair.sourcePath;
  const oldSnapshot = snapshot('OLD');
  oldSnapshot.records[0].reviewAfter = '2025-01-01T00:00:00.000Z';
  await pair.live.save(oldSnapshot);
  await pair.source.save(snapshot('NEW'));
  pair.source.close();
  pair.source = undefined;
  const app = await createShadowGraphServer({ file: pair.livePath, storage: 'sqlite', store: pair.live, now: () => '2026-01-01T00:00:00.000Z' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    const restoreResponsePromise = fetch(`${base}/restore`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ source: pair.sourcePath })
    });
    await statReached;
    const writeResponse = await fetch(`${base}/decisions`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'RACE', chosen: 'bad' })
    });
    assert.equal(writeResponse.status, 400);
    assert.match((await writeResponse.json()).error, /restore is in progress/);
    assert.equal(app.graph.search('RACE').page.total, 0, 'rejected write must not mutate the graph');
    const contextResponse = await fetch(`${base}/context`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'default' })
    });
    assert.equal(contextResponse.status, 400, 'context can create review signals and must be blocked during restore');
    assert.match((await contextResponse.json()).error, /restore is in progress/);
    assert.equal(app.graph.getReviewSignals().length, 0, 'blocked context must not create an in-memory-only review signal');
    releaseStat();
    const restoreResponse = await restoreResponsePromise;
    assert.equal(restoreResponse.status, 200);
    assert.equal(app.graph.search('NEW').page.total, 1);
    assert.equal(app.graph.search('RACE').page.total, 0);
    assert.equal((await pair.live.load()).records.some((record) => record.title === 'RACE'), false);
  } finally {
    releaseStat();
    await new Promise((resolveClose) => app.server.close(resolveClose));
  }
  pair.live.close();
  pair.live = undefined;
  const reopened = await createSqliteStore(pair.livePath);
  try {
    assert.equal((await reopened.load()).records.some((record) => record.title === 'RACE'), false);
  } finally {
    reopened.close();
  }
  assert.deepEqual(await artifacts(pair.directory), []);
});
