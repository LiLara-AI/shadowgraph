// Relational SQLite backend for ShadowGraph. Requires Node 22.5+ node:sqlite.
//
// node:sqlite is a RELEASE CANDIDATE (Node stability 1.2), not stable, so the
// import is guarded and JSON remains a fully supported fallback.
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { nextRevision, assertRevision } from './revision-store.js';
import { validateRestorePayload as validateDomainRestorePayload } from './restore-validation.js';

const EMPTY = { schemaVersion: 3, revision: 0, records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null };

export async function createSqliteStore(filePath, options = {}) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('SQLite storage requires Node 22.5+ with node:sqlite; use JSON storage on Node 20'); }

  await mkdir(dirname(filePath), { recursive: true });
  const openDatabase = options.openDatabase ?? ((path, openOptions) => openOptions ? new DatabaseSync(path, openOptions) : new DatabaseSync(path));
  const closeHandle = options.closeHandle ?? ((handle) => handle.close());
  const restoreFs = {
    copyFile: options.restoreFs?.copyFile ?? copyFile,
    rename: options.restoreFs?.rename ?? rename,
    stat: options.restoreFs?.stat ?? stat,
    unlink: options.restoreFs?.unlink ?? unlink
  };
  const fault = (stage) => options.restoreFault?.(stage);

  function prepareSchema(database) {
    database.exec(`PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS shadowgraph_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shadowgraph_entities (id TEXT PRIMARY KEY, kind TEXT NOT NULL, project TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shadowgraph_relations (id TEXT PRIMARY KEY, source_id TEXT NOT NULL, target_id TEXT NOT NULL, relation TEXT NOT NULL, created_at TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shadowgraph_reviews (id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shadowgraph_idempotency (key TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shadowgraph_events (id TEXT PRIMARY KEY, project TEXT, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shadowgraph_journal (id TEXT PRIMARY KEY, seq INTEGER, type TEXT, project TEXT, entity_id TEXT, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS shadowgraph_journal_seq ON shadowgraph_journal (seq);
      CREATE TABLE IF NOT EXISTS shadowgraph_state (id INTEGER PRIMARY KEY CHECK (id = 1), payload TEXT NOT NULL);`);
  }

  function prepareDatabase(database, stage) {
    if (options.prepareDatabase) return options.prepareDatabase(database, stage, prepareSchema);
    return prepareSchema(database);
  }

  let db = openDatabase(filePath);
  prepareDatabase(db, 'initial');
  let restoring = false;

  function exportFrom(database) {
    const readMeta = (key, fallback = '0') => database.prepare('SELECT value FROM shadowgraph_meta WHERE key = ?').get(key)?.value ?? fallback;
    const epoch = readMeta('journalEpoch', '');
    const result = { schemaVersion: Number(readMeta('schemaVersion', '3')), revision: Number(readMeta('revision', '0')), records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: Number(readMeta('journalSeq', '0')), journalEpoch: epoch === '' ? null : Number(epoch) };
    for (const row of database.prepare('SELECT kind, payload FROM shadowgraph_entities ORDER BY rowid').all()) { const item = JSON.parse(row.payload); (item.kind === 'fact' ? result.facts : result.records).push(item); }
    for (const row of database.prepare('SELECT payload FROM shadowgraph_relations ORDER BY rowid').all()) result.relations.push(JSON.parse(row.payload));
    for (const row of database.prepare('SELECT payload FROM shadowgraph_reviews ORDER BY rowid').all()) result.reviewSignals.push(JSON.parse(row.payload));
    for (const row of database.prepare('SELECT key, payload FROM shadowgraph_idempotency ORDER BY rowid').all()) result.idempotency.push({ key: row.key, value: JSON.parse(row.payload) });
    for (const row of database.prepare('SELECT payload FROM shadowgraph_events ORDER BY rowid').all()) result.events.push(JSON.parse(row.payload));
    // Ordered by seq, not rowid: seq is the journal's contract ordering key.
    for (const row of database.prepare('SELECT payload FROM shadowgraph_journal ORDER BY seq, rowid').all()) result.journal.push(JSON.parse(row.payload));
    return result;
  }

  function replaceRelational(data) {
    db.exec('DELETE FROM shadowgraph_entities; DELETE FROM shadowgraph_relations; DELETE FROM shadowgraph_reviews; DELETE FROM shadowgraph_idempotency; DELETE FROM shadowgraph_events; DELETE FROM shadowgraph_journal; DELETE FROM shadowgraph_meta;');
    const meta = db.prepare('INSERT INTO shadowgraph_meta (key,value) VALUES (?,?)');
    meta.run('schemaVersion', String(data.schemaVersion ?? 3));
    meta.run('revision', String(data.revision ?? 0));
    meta.run('journalSeq', String(data.journalSeq ?? 0));
    meta.run('journalEpoch', data.journalEpoch === null || data.journalEpoch === undefined ? '' : String(data.journalEpoch));
    const entity = db.prepare('INSERT INTO shadowgraph_entities (id,kind,project,payload) VALUES (?,?,?,?)');
    for (const item of [...(data.records ?? []), ...(data.facts ?? [])]) entity.run(item.id, item.kind, item.project ?? 'default', JSON.stringify(item));
    const relation = db.prepare('INSERT INTO shadowgraph_relations (id,source_id,target_id,relation,created_at,payload) VALUES (?,?,?,?,?,?)');
    for (const item of data.relations ?? []) relation.run(item.id, item.from, item.to, item.relation, item.createdAt ?? null, JSON.stringify(item));
    const review = db.prepare('INSERT INTO shadowgraph_reviews (id,decision_id,status,payload) VALUES (?,?,?,?)');
    for (const item of data.reviewSignals ?? []) review.run(item.id, item.decisionId, item.status ?? 'open', JSON.stringify(item));
    const idem = db.prepare('INSERT INTO shadowgraph_idempotency (key,payload) VALUES (?,?)');
    for (const item of data.idempotency ?? []) idem.run(item.key, JSON.stringify(item.value));
    const event = db.prepare('INSERT INTO shadowgraph_events (id,project,payload) VALUES (?,?,?)');
    for (const item of data.events ?? []) event.run(item.id, item.project ?? null, JSON.stringify(item));
    // Written inside the SAME transaction as the state above, so a crash can never
    // leave the journal describing a state that was not committed.
    const journalRow = db.prepare('INSERT INTO shadowgraph_journal (id,seq,type,project,entity_id,payload) VALUES (?,?,?,?,?,?)');
    for (const item of data.journal ?? []) journalRow.run(item.id, Number.isInteger(item.seq) ? item.seq : null, item.type ?? null, item.project ?? null, item.entityId ?? null, JSON.stringify(item));
  }

  function migrateLegacyPayload() {
    const legacy = db.prepare('SELECT payload FROM shadowgraph_state WHERE id = 1').get();
    if (!legacy) return;
    db.exec('BEGIN IMMEDIATE');
    try { replaceRelational(JSON.parse(legacy.payload)); db.exec('DROP TABLE shadowgraph_state; COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  const quoteSqlPath = (path) => String(path).replaceAll("'", "''");
  const sidecars = (path) => [`${path}-wal`, `${path}-shm`, `${path}-journal`];
  const normalizePath = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const samePath = (left, right) => normalizePath(left) === normalizePath(right);
  const closeChecked = (handle, stage) => { if (handle) closeHandle(handle, stage); };
  const payloadIdentity = (payload) => JSON.stringify(payload);

  async function removePath(path) {
    try { await restoreFs.unlink(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function removeDatabase(path) {
    for (const item of [...sidecars(path), path]) await removePath(item);
  }

  function openReadable(path, openOptions) {
    let handle;
    try {
      handle = openDatabase(path, openOptions);
      const payload = exportFrom(handle);
      return { handle, payload };
    } catch (error) {
      try { closeChecked(handle, 'read-failure'); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  async function cleanupArtifacts(paths) {
    const retained = [];
    for (const path of paths) {
      if (!path) continue;
      try { await removeDatabase(path); }
      catch { retained.push(path); }
    }
    return retained;
  }

  async function inspectArtifacts(paths) {
    const retainedArtifacts = [];
    const unknownArtifacts = [];
    const candidates = [...new Set(paths.filter(Boolean).flatMap((path) => [path, ...sidecars(path)]))];
    for (const path of candidates) {
      try {
        const info = await stat(path);
        if (info.isFile()) retainedArtifacts.push(path);
      } catch (error) {
        if (error.code !== 'ENOENT') unknownArtifacts.push({ path, code: error.code ?? 'unknown' });
      }
    }
    return { retainedArtifacts, unknownArtifacts };
  }

  migrateLegacyPayload();

  return {
    async load() {
      if (restoring) throw new Error('SQLite restore is in progress');
      if (!db) throw new Error('SQLite storage is closed');
      return exportFrom(db);
    },

    async save(data) {
      if (restoring) throw new Error('SQLite restore is in progress');
      if (!db) throw new Error('SQLite storage is closed');
      db.exec('BEGIN IMMEDIATE');
      try {
        const current = exportFrom(db);
        assertRevision(current, data?.expectedRevision ?? data?.revision);
        const payload = nextRevision(Array.isArray(data) ? { ...EMPTY, records: data } : { ...data, revision: current.revision, expectedRevision: undefined });
        replaceRelational(payload);
        db.exec('COMMIT');
        return payload.revision;
      } catch (error) {
        db.exec('ROLLBACK');
        throw error;
      }
    },

    // Guarantee: source/replacement validation and process-level rollback for
    // caught errors. VACUUM INTO folds committed WAL state into standalone files.
    // Non-goals: crash recovery, fsync/power-loss durability, and coordination
    // with another process writing the live database during restore.
    async restore(source, restoreOptions = {}) {
      if (restoring) throw new Error('SQLite restore is already in progress');
      if (!db) throw new Error('SQLite storage is closed');
      if (typeof source !== 'string' || !source.trim()) throw new Error('Restore source must be a non-empty path');

      restoring = true;
      const destination = resolve(filePath);
      const reportedDestination = filePath;
      const sourcePath = resolve(source);
      const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
      const stagedPath = join(dirname(destination), `.${basename(destination)}.${token}.restore`);
      const rollbackPath = join(dirname(destination), `.${basename(destination)}.${token}.rollback`);
      const displacedPath = join(dirname(destination), `.${basename(destination)}.${token}.old`);
      const recoveryPath = join(dirname(destination), `.${basename(destination)}.${token}.recovery`);
      let sourceHandle;
      let stagedHandle;
      let rollbackHandle;
      let replacementHandle;
      let recoveryHandle;
      let liveHandle;
      let oldPayload;
      let stagedExists = false;
      let rollbackExists = false;
      let displacedExists = false;
      let recoveryExists = false;
      let rollbackReady = false;
      let liveClosed = false;
      let committed = false;
      let recoveryUnconfirmed = false;
      let cleanupReported = false;

      const closeQuietly = (handle, stage) => {
        try { closeChecked(handle, stage); }
        catch { /* recovery/cleanup continues */ }
      };

      const validateSnapshot = async (payload) => {
        validateDomainRestorePayload(payload);
        if (restoreOptions.validate) await restoreOptions.validate(payload);
      };

      const confirmOldAtDestination = async () => {
        let inspection;
        let candidate;
        try {
          const info = await restoreFs.stat(destination);
          if (!info.isFile()) throw new Error('Recovery destination is not a regular SQLite file');
          inspection = openDatabase(destination, { readOnly: true });
          const inspectedPayload = exportFrom(inspection);
          if (payloadIdentity(inspectedPayload) !== payloadIdentity(oldPayload)) throw new Error('Recovered payload does not match the rollback snapshot');
        } finally {
          closeQuietly(inspection, 'recovery-inspection');
        }
        try {
          candidate = openDatabase(destination);
          prepareDatabase(candidate, 'recovery');
          const payload = exportFrom(candidate);
          if (payloadIdentity(payload) !== payloadIdentity(oldPayload)) throw new Error('Recovered payload does not match the rollback snapshot after prepare');
          db = candidate;
          candidate = undefined;
          liveClosed = false;
        } finally {
          closeQuietly(candidate, 'recovery');
        }
      };

      try {
        const info = await restoreFs.stat(sourcePath);
        if (!info.isFile()) throw new Error('Restore source must be a regular SQLite file');

        fault('beforeSourceOpen');
        try {
          sourceHandle = openReadable(sourcePath, { readOnly: true }).handle;
          const sourcePayload = exportFrom(sourceHandle);
          await validateSnapshot(sourcePayload);
          if (samePath(sourcePath, destination)) return { source, destination: reportedDestination, unchanged: true };
          fault('beforeSourceSnapshot');
          stagedExists = true;
          sourceHandle.exec(`VACUUM INTO '${quoteSqlPath(stagedPath)}'`);
        } finally {
          closeChecked(sourceHandle, 'source');
          sourceHandle = undefined;
        }

        try {
          ({ handle: stagedHandle } = openReadable(stagedPath, { readOnly: true }));
          const stagedPayload = exportFrom(stagedHandle);
          await validateSnapshot(stagedPayload);
        } finally {
          closeChecked(stagedHandle, 'staged');
          stagedHandle = undefined;
        }

        rollbackExists = true;
        db.exec(`VACUUM INTO '${quoteSqlPath(rollbackPath)}'`);
        try {
          ({ handle: rollbackHandle, payload: oldPayload } = openReadable(rollbackPath, { readOnly: true }));
        } finally {
          closeChecked(rollbackHandle, 'rollback');
          rollbackHandle = undefined;
        }
        rollbackReady = true;

        liveHandle = db;
        db = undefined;
        liveClosed = true;
        closeChecked(liveHandle, 'live');
        liveHandle = undefined;
        fault('afterLiveClose');

        // Closing the final in-process connection checkpoints WAL. The verified
        // rollback snapshot remains the authoritative old state; sidecars are not
        // required for recovery and stale ones must not accompany another main file.
        for (const path of sidecars(destination)) await removePath(path);
        displacedExists = true;
        await restoreFs.rename(destination, displacedPath);
        await restoreFs.rename(stagedPath, destination);
        stagedExists = false;
        fault('afterReplacementRename');

        replacementHandle = openDatabase(destination);
        prepareDatabase(replacementHandle, 'replacement');
        const replacementPayload = exportFrom(replacementHandle);
        await validateSnapshot(replacementPayload);

        db = replacementHandle;
        replacementHandle = undefined;
        liveClosed = false;
        committed = true;
        const retainedArtifacts = await cleanupArtifacts([rollbackPath, displacedPath]);
        rollbackExists = retainedArtifacts.includes(rollbackPath);
        displacedExists = retainedArtifacts.includes(displacedPath);
        return retainedArtifacts.length ? { source, destination: reportedDestination, retainedArtifacts } : { source, destination: reportedDestination };
      } catch (error) {
        for (const [handle, stage] of [[sourceHandle, 'source'], [stagedHandle, 'staged'], [rollbackHandle, 'rollback'], [replacementHandle, 'replacement'], [liveHandle, 'live'], [recoveryHandle, 'recovery']]) {
          closeQuietly(handle, stage);
        }
        sourceHandle = stagedHandle = rollbackHandle = replacementHandle = liveHandle = recoveryHandle = undefined;

        if (rollbackReady && liveClosed && !committed) {
          try {
            let recoveredInPlace = false;
            // If the old main file is still present, reopen and compare it first.
            // A failed or move-then-throw rename can leave either path state; a
            // payload comparison decides safely without trusting optimistic flags.
            try {
              await confirmOldAtDestination();
              recoveredInPlace = true;
            } catch {
              closeQuietly(db, 'recovery');
              db = undefined;
              liveClosed = true;
            }
            if (!recoveredInPlace) {
              // Preserve rollbackPath until the restored live database has opened,
              // prepared, and matched the old payload. A failed recovery therefore
              // still leaves a complete standalone snapshot for manual repair.
              await removeDatabase(recoveryPath);
              recoveryExists = true;
              await restoreFs.copyFile(rollbackPath, recoveryPath);
              try {
                ({ handle: recoveryHandle } = openReadable(recoveryPath, { readOnly: true }));
                const recoveryPayload = exportFrom(recoveryHandle);
                if (payloadIdentity(recoveryPayload) !== payloadIdentity(oldPayload)) throw new Error('Recovery copy does not match the rollback snapshot');
              } finally {
                closeChecked(recoveryHandle, 'recovery-copy');
                recoveryHandle = undefined;
              }
              await removeDatabase(destination);
              await restoreFs.rename(recoveryPath, destination);
              recoveryExists = false;
              await confirmOldAtDestination();
            }

            const retainedArtifacts = await cleanupArtifacts([
              stagedExists ? stagedPath : null,
              rollbackExists ? rollbackPath : null,
              displacedExists ? displacedPath : null,
              recoveryExists ? recoveryPath : null
            ]);
            stagedExists = rollbackExists = displacedExists = recoveryExists = false;
            const recovered = new Error(`SQLite restore failed; previous database restored: ${error.message}`);
            recovered.code = 'sqlite_restore_rolled_back';
            recovered.cause = error;
            if (retainedArtifacts.length) recovered.retainedArtifacts = retainedArtifacts;
            throw recovered;
          } catch (recoveryError) {
            if (recoveryError.code === 'sqlite_restore_rolled_back') throw recoveryError;
            recoveryUnconfirmed = true;
            const inventory = await inspectArtifacts([stagedPath, rollbackPath, displacedPath, recoveryPath]);
            const fatal = new Error(`SQLite restore failed and rollback is unconfirmed: ${recoveryError.message}`);
            fatal.code = 'sqlite_restore_recovery_unconfirmed';
            fatal.cause = error;
            fatal.recoveryCause = recoveryError;
            fatal.retainedArtifacts = inventory.retainedArtifacts;
            if (inventory.unknownArtifacts.length) fatal.unknownArtifacts = inventory.unknownArtifacts;
            fatal.stagedArtifact = inventory.retainedArtifacts.includes(stagedPath) ? stagedPath : undefined;
            fatal.rollbackArtifact = inventory.retainedArtifacts.includes(rollbackPath) ? rollbackPath : undefined;
            fatal.displacedArtifact = inventory.retainedArtifacts.includes(displacedPath) ? displacedPath : undefined;
            fatal.recoveryArtifact = inventory.retainedArtifacts.includes(recoveryPath) ? recoveryPath : undefined;
            throw fatal;
          }
        }

        const retainedArtifacts = await cleanupArtifacts([
          stagedExists ? stagedPath : null,
          rollbackExists ? rollbackPath : null,
          displacedExists ? displacedPath : null,
          recoveryExists ? recoveryPath : null
        ]);
        cleanupReported = true;
        stagedExists = retainedArtifacts.includes(stagedPath);
        rollbackExists = retainedArtifacts.includes(rollbackPath);
        displacedExists = retainedArtifacts.includes(displacedPath);
        recoveryExists = retainedArtifacts.includes(recoveryPath);
        if (retainedArtifacts.length) {
          error.retainedArtifacts = [...new Set([...(error.retainedArtifacts ?? []), ...retainedArtifacts])];
        }
        throw error;
      } finally {
        for (const [handle, stage] of [[sourceHandle, 'source'], [stagedHandle, 'staged'], [rollbackHandle, 'rollback'], [replacementHandle, 'replacement'], [liveHandle, 'live'], [recoveryHandle, 'recovery']]) {
          closeQuietly(handle, stage);
        }
        if (!recoveryUnconfirmed && !cleanupReported) {
          if (stagedExists) await removeDatabase(stagedPath).catch(() => {});
          if (!rollbackReady && rollbackExists) await removeDatabase(rollbackPath).catch(() => {});
          if (!rollbackReady && displacedExists) await removeDatabase(displacedPath).catch(() => {});
          if (recoveryExists) await removeDatabase(recoveryPath).catch(() => {});
        }
        restoring = false;
      }
    },

    async backup(destination) {
      if (restoring) throw new Error('SQLite restore is in progress');
      if (!db) throw new Error('SQLite storage is closed');
      await mkdir(dirname(destination), { recursive: true });
      const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`);
      try {
        db.exec(`VACUUM INTO '${quoteSqlPath(temporary)}'`);
        await rename(temporary, destination);
        return { source: filePath, destination };
      } finally {
        await unlink(temporary).catch(() => {});
      }
    },

    close() {
      if (restoring) throw new Error('Cannot close SQLite storage during restore');
      if (db) {
        db.close();
        db = undefined;
      }
    }
  };
}
