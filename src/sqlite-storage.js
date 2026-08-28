// Relational SQLite backend for ShadowGraph. Requires Node 22.5+ node:sqlite.
//
// node:sqlite is a RELEASE CANDIDATE (Node stability 1.2), not stable, so the
// import is guarded and JSON remains a fully supported fallback.
import { copyFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { nextRevision, assertRevision, createDestinationFence, currentRevision, nextRevisionAfter } from './revision-store.js';
import { createRestoreValidator, requiresLegacyPurgeMigration } from './restore-validation.js';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from './runtime-capabilities.js';
import { SCHEMA_VERSION } from './shadowgraph.js';

const EMPTY = { schemaVersion: SCHEMA_VERSION, revision: 0, records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null };

export async function createSqliteStore(filePath, options = {}) {
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error(NODE_SQLITE_NOT_APPLICABLE_REASON); }

  await mkdir(dirname(filePath), { recursive: true });
  const openDatabase = options.openDatabase ?? ((path, openOptions) => openOptions ? new DatabaseSync(path, openOptions) : new DatabaseSync(path));
  const openImmutableDatabase = options.openImmutableDatabase ?? (options.openDatabase
    ? null
    : ((path) => new DatabaseSync(new URL(`${pathToFileURL(path).href}?immutable=1`), { readOnly: true })));
  const closeHandle = options.closeHandle ?? ((handle) => handle.close());
  const restoreFs = {
    copyFile: options.restoreFs?.copyFile ?? copyFile,
    rename: options.restoreFs?.rename ?? rename,
    stat: options.restoreFs?.stat ?? stat,
    unlink: options.restoreFs?.unlink ?? unlink
  };
  const fault = (stage) => options.restoreFault?.(stage);
  const saveFault = (stage, context) => options.saveFault?.(stage, context);
  const configuredRestoreValidator = options.restoreValidator ?? createRestoreValidator();
  const fence = createDestinationFence(filePath, options);

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

  let restoring = false;
  let permanentlyClosed = false;

  function exportFrom(database) {
    const readMeta = (key, fallback = '0') => database.prepare('SELECT value FROM shadowgraph_meta WHERE key = ?').get(key)?.value ?? fallback;
    const epoch = readMeta('journalEpoch', '');
    const result = { schemaVersion: Number(readMeta('schemaVersion', String(SCHEMA_VERSION))), revision: Number(readMeta('revision', '0')), records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: Number(readMeta('journalSeq', '0')), journalEpoch: epoch === '' ? null : Number(epoch) };
    for (const row of database.prepare('SELECT kind, payload FROM shadowgraph_entities ORDER BY rowid').all()) { const item = JSON.parse(row.payload); (item.kind === 'fact' ? result.facts : result.records).push(item); }
    for (const row of database.prepare('SELECT payload FROM shadowgraph_relations ORDER BY rowid').all()) result.relations.push(JSON.parse(row.payload));
    for (const row of database.prepare('SELECT payload FROM shadowgraph_reviews ORDER BY rowid').all()) result.reviewSignals.push(JSON.parse(row.payload));
    for (const row of database.prepare('SELECT key, payload FROM shadowgraph_idempotency ORDER BY rowid').all()) result.idempotency.push({ key: row.key, value: JSON.parse(row.payload) });
    for (const row of database.prepare('SELECT payload FROM shadowgraph_events ORDER BY rowid').all()) result.events.push(JSON.parse(row.payload));
    // Ordered by seq, not rowid: seq is the journal's contract ordering key.
    for (const row of database.prepare('SELECT payload FROM shadowgraph_journal ORDER BY seq, rowid').all()) result.journal.push(JSON.parse(row.payload));
    return result;
  }

  function replaceRelational(database, data) {
    database.exec('DELETE FROM shadowgraph_entities; DELETE FROM shadowgraph_relations; DELETE FROM shadowgraph_reviews; DELETE FROM shadowgraph_idempotency; DELETE FROM shadowgraph_events; DELETE FROM shadowgraph_journal; DELETE FROM shadowgraph_meta;');
    const meta = database.prepare('INSERT INTO shadowgraph_meta (key,value) VALUES (?,?)');
    meta.run('schemaVersion', String(data.schemaVersion ?? SCHEMA_VERSION));
    meta.run('revision', String(data.revision ?? 0));
    meta.run('journalSeq', String(data.journalSeq ?? 0));
    meta.run('journalEpoch', data.journalEpoch === null || data.journalEpoch === undefined ? '' : String(data.journalEpoch));
    const entity = database.prepare('INSERT INTO shadowgraph_entities (id,kind,project,payload) VALUES (?,?,?,?)');
    for (const item of [...(data.records ?? []), ...(data.facts ?? [])]) entity.run(item.id, item.kind, item.project ?? 'default', JSON.stringify(item));
    const relation = database.prepare('INSERT INTO shadowgraph_relations (id,source_id,target_id,relation,created_at,payload) VALUES (?,?,?,?,?,?)');
    for (const item of data.relations ?? []) relation.run(item.id, item.from, item.to, item.relation, item.createdAt ?? null, JSON.stringify(item));
    const review = database.prepare('INSERT INTO shadowgraph_reviews (id,decision_id,status,payload) VALUES (?,?,?,?)');
    for (const item of data.reviewSignals ?? []) review.run(item.id, item.decisionId, item.status ?? 'open', JSON.stringify(item));
    const idem = database.prepare('INSERT INTO shadowgraph_idempotency (key,payload) VALUES (?,?)');
    for (const item of data.idempotency ?? []) idem.run(item.key, JSON.stringify(item.value));
    const event = database.prepare('INSERT INTO shadowgraph_events (id,project,payload) VALUES (?,?,?)');
    for (const item of data.events ?? []) event.run(item.id, item.project ?? null, JSON.stringify(item));
    // Written inside the SAME transaction as the state above, so a crash can never
    // leave the journal describing a state that was not committed.
    const journalRow = database.prepare('INSERT INTO shadowgraph_journal (id,seq,type,project,entity_id,payload) VALUES (?,?,?,?,?,?)');
    for (const item of data.journal ?? []) journalRow.run(item.id, Number.isInteger(item.seq) ? item.seq : null, item.type ?? null, item.project ?? null, item.entityId ?? null, JSON.stringify(item));
  }

  function migrateLegacyPayload(database) {
    const legacy = database.prepare('SELECT payload FROM shadowgraph_state WHERE id = 1').get();
    if (!legacy) return;
    database.exec('BEGIN IMMEDIATE');
    try { replaceRelational(database, JSON.parse(legacy.payload)); database.exec('DROP TABLE shadowgraph_state; COMMIT'); }
    catch (error) { database.exec('ROLLBACK'); throw error; }
  }

  const quoteSqlPath = (path) => String(path).replaceAll("'", "''");
  const sidecars = (path) => [`${path}-wal`, `${path}-shm`, `${path}-journal`];
  const normalizePath = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  const samePath = (left, right) => normalizePath(left) === normalizePath(right);
  const closeChecked = (handle, stage) => { if (handle) closeHandle(handle, stage); };
  const payloadIdentity = (payload) => JSON.stringify(payload);

  const persistedCollections = [
    ['records', 'id'],
    ['facts', 'id'],
    ['relations', 'id'],
    ['reviewSignals', 'id'],
    ['idempotency', 'key'],
    ['events', 'id'],
    ['journal', 'id']
  ];

  function removesPersistedRows(current, next) {
    return persistedCollections.some(([collection, key]) => {
      const nextKeys = new Set((next[collection] ?? []).map((item) => item?.[key]));
      return (current[collection] ?? []).some((item) => !nextKeys.has(item?.[key]));
    });
  }

  function persistedPayload(data) {
    const result = {
      schemaVersion: Number(data.schemaVersion ?? SCHEMA_VERSION),
      revision: Number(data.revision ?? 0),
      records: [],
      facts: [],
      relations: data.relations ?? [],
      reviewSignals: data.reviewSignals ?? [],
      idempotency: data.idempotency ?? [],
      events: data.events ?? [],
      journal: data.journal ?? [],
      journalSeq: Number(data.journalSeq ?? 0),
      journalEpoch: data.journalEpoch === null || data.journalEpoch === undefined ? null : Number(data.journalEpoch)
    };
    for (const item of [...(data.records ?? []), ...(data.facts ?? [])]) {
      (item.kind === 'fact' ? result.facts : result.records).push(item);
    }
    return result;
  }

  function assertCommittedPayload(database, payload) {
    if (payloadIdentity(exportFrom(database)) !== payloadIdentity(persistedPayload(payload))) {
      throw new Error('committed SQLite payload does not match the requested save');
    }
  }

  function securelyCompactCommittedSave(database, payload, context) {
    let initialError;
    try {
      saveFault('afterCommit', context);
      // VACUUM is intentionally outside the write transaction. DELETE journal
      // mode and secure_delete have already scrubbed removed cells at COMMIT;
      // VACUUM now eliminates every freelist/unused page before acknowledgement.
      database.exec('VACUUM');
      saveFault('afterCompact', context);
      assertCommittedPayload(database, payload);
      return;
    } catch (error) {
      initialError = error;
    }

    try {
      // COMMIT may succeed and a callback/checkpoint may then throw. Reconcile the
      // committed state instead of reporting a failure that would roll live graph
      // state behind durable SQLite state. A second SQLite-native VACUUM is safe.
      database.exec('VACUUM');
      assertCommittedPayload(database, payload);
    } catch (reconciliationError) {
      const fatal = new Error(`SQLite destructive save committed but secure compaction could not be confirmed: ${reconciliationError.message}`);
      fatal.code = 'sqlite_save_compaction_unconfirmed';
      fatal.cause = initialError;
      fatal.reconciliationCause = reconciliationError;
      throw fatal;
    }
  }

  async function removePath(path) {
    try { await restoreFs.unlink(path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }

  async function removeDatabase(path) {
    for (const item of [...sidecars(path), path]) await removePath(item);
  }

  function openReadable(path, openOptions, opener = openDatabase) {
    let handle;
    try {
      handle = opener(path, openOptions);
      const payload = exportFrom(handle);
      return { handle, payload };
    } catch (error) {
      try { closeChecked(handle, 'read-failure'); } catch { /* preserve original failure */ }
      throw error;
    }
  }

  async function hasSourceSidecars(path) {
    for (const candidate of sidecars(path)) {
      try {
        const info = await restoreFs.stat(candidate);
        if (info.isFile()) return true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    }
    return false;
  }

  async function cleanupArtifacts(paths) {
    const retained = [];
    for (const path of paths) {
      if (!path) continue;
      try { await removeDatabase(path); }
      catch {
        const inventory = await inspectArtifacts([path]);
        if (inventory.retainedArtifacts.length || inventory.unknownArtifacts.length) retained.push(path);
      }
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

  function openLiveDatabase(stage) {
    if (permanentlyClosed) throw new Error('SQLite storage is closed');
    let candidate;
    try {
      candidate = openDatabase(filePath);
      prepareDatabase(candidate, stage);
      migrateLegacyPayload(candidate);
      const opened = candidate;
      candidate = undefined;
      return opened;
    } finally {
      closeChecked(candidate, `${stage}-failure`);
    }
  }

  // Creating a store still materializes and migrates the database, but no
  // connection survives the destination fence. Every later operation follows
  // the same open/use/close discipline so another process can replace the main
  // file and remove WAL/SHM sidecars while it owns the exclusive fence.
  await fence.run(async () => {
    let database;
    try { database = openLiveDatabase('initial'); }
    finally { closeChecked(database, 'initial'); }
  });

  return {
    async load() {
      if (restoring) throw new Error('SQLite restore is in progress');
      if (permanentlyClosed) throw new Error('SQLite storage is closed');
      return fence.run(async () => {
        if (restoring) throw new Error('SQLite restore is in progress');
        let database;
        try {
          database = openLiveDatabase('load');
          return exportFrom(database);
        } finally {
          closeChecked(database, 'load');
        }
      });
    },

    async save(data) {
      if (restoring) throw new Error('SQLite restore is in progress');
      if (permanentlyClosed) throw new Error('SQLite storage is closed');
      return fence.run(async () => {
        if (restoring) throw new Error('SQLite restore is in progress');
        let database;
        try {
          database = openLiveDatabase('save');
          const current = exportFrom(database);
          assertRevision(current, data?.expectedRevision ?? data?.revision);
          const payload = nextRevision(Array.isArray(data) ? { ...EMPTY, records: data } : { ...data, revision: current.revision, expectedRevision: undefined });
          const destructive = removesPersistedRows(current, payload);
          const context = { current, payload, destructive };
          if (destructive) {
            // Changing journal mode and checkpointing are forbidden inside an
            // active transaction. The destination fence and operation-scoped
            // handles ensure no other ShadowGraph connection is open here.
            database.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON');
          }
          database.exec('BEGIN IMMEDIATE');
          let committed = false;
          try {
            replaceRelational(database, payload);
            saveFault('beforeCommit', context);
            database.exec('COMMIT');
            committed = true;
            if (destructive) securelyCompactCommittedSave(database, payload, context);
            else saveFault('afterCommit', context);
            return payload.revision;
          } catch (error) {
            if (!committed) database.exec('ROLLBACK');
            throw error;
          }
        } finally {
          closeChecked(database, 'save');
        }
      });
    },

    // Guarantee: source/replacement validation, process-level rollback for caught
    // errors, and a destination fence shared with every save handle/process.
    // VACUUM INTO folds committed WAL state into standalone files. Non-goals:
    // crash recovery and fsync/power-loss durability.
    async restore(source, restoreOptions = {}) {
      if (restoring) throw new Error('SQLite restore is already in progress');
      if (permanentlyClosed) throw new Error('SQLite storage is closed');
      if (typeof source !== 'string' || !source.trim()) throw new Error('Restore source must be a non-empty path');

      return fence.run(async () => {
      if (restoring) throw new Error('SQLite restore is already in progress');
      if (permanentlyClosed) throw new Error('SQLite storage is closed');
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
      let db;
      let oldPayload;
      let installedRevision;
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
        let normalized = await configuredRestoreValidator(payload);
        if (restoreOptions.validate && restoreOptions.validate !== configuredRestoreValidator) {
          const customNormalized = await restoreOptions.validate(payload);
          if (customNormalized && typeof customNormalized === 'object' && Array.isArray(customNormalized.records)) normalized = customNormalized;
        }
        return requiresLegacyPurgeMigration(payload) ? normalized : payload;
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
          liveClosed = false;
        } finally {
          closeQuietly(candidate, 'recovery');
        }
      };

      try {
        db = openLiveDatabase('restore');
        const destinationPayload = exportFrom(db);
        const info = await restoreFs.stat(sourcePath);
        if (!info.isFile()) throw new Error('Restore source must be a regular SQLite file');

        fault('beforeSourceOpen');
        try {
          // Opening a checkpointed WAL-mode database read-only can itself create
          // empty -wal/-shm files. When no source sidecar exists, immutable mode is
          // safe (all committed state is in the main file) and makes this snapshot
          // observational: source bytes and artifact inventory remain untouched.
          // If WAL/rollback state already exists, use SQLite's normal read-only
          // path so VACUUM INTO includes those committed pages.
          const immutableSource = openImmutableDatabase && !(await hasSourceSidecars(sourcePath));
          sourceHandle = openReadable(
            sourcePath,
            { readOnly: true },
            immutableSource ? openImmutableDatabase : openDatabase
          ).handle;
          const sourcePayload = exportFrom(sourceHandle);
          await validateSnapshot(sourcePayload);
          currentRevision(sourcePayload, 'Restore source');
          if (samePath(sourcePath, destination)) return { source, destination: reportedDestination, unchanged: true };
          installedRevision = nextRevisionAfter(destinationPayload, sourcePayload);
          fault('beforeSourceSnapshot');
          stagedExists = true;
          sourceHandle.exec(`VACUUM INTO '${quoteSqlPath(stagedPath)}'`);
        } finally {
          closeChecked(sourceHandle, 'source');
          sourceHandle = undefined;
        }

        try {
          stagedHandle = openDatabase(stagedPath);
          const stagedPayload = exportFrom(stagedHandle);
          const normalizedStagedPayload = await validateSnapshot(stagedPayload);
          const stagedWasNormalized = normalizedStagedPayload !== stagedPayload;
          // A source snapshot may have arrived in WAL mode. At this isolated staged
          // file (never the caller's source or the live destination), checkpoint it
          // first, switch to a standalone rollback journal, and enable SQLite's
          // native secure deletion before removing legacy rows. Raw page rewriting
          // is unsafe because it can corrupt b-trees, overflow chains, and checksums.
          stagedHandle.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA journal_mode = DELETE; PRAGMA secure_delete = ON; BEGIN IMMEDIATE');
          try {
            if (stagedWasNormalized) {
              replaceRelational(stagedHandle, { ...normalizedStagedPayload, revision: installedRevision });
              fault('afterStagedReplace');
            } else {
              stagedHandle.prepare('INSERT INTO shadowgraph_meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run('revision', String(installedRevision));
            }
            stagedHandle.exec('COMMIT');
          } catch (error) {
            stagedHandle.exec('ROLLBACK');
            throw error;
          }
          if (stagedWasNormalized) {
            // VACUUM is deliberately outside the transaction above. It rebuilds a
            // minimal database through SQLite itself, eliminating the freelist and
            // unused legacy pages after secure_delete scrubbed deleted live cells.
            // The final checkpoint makes the staged artifact standalone before its
            // atomic rename; no WAL/SHM content is allowed to accompany it.
            stagedHandle.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE)');
          }
          // Domain-check the rewritten bytes without firing the caller activation
          // hook a second time at the staged path. The custom validator already
          // inspected the source/staged snapshot and runs again on the installed
          // replacement, where a failure is covered by verified rollback.
          await configuredRestoreValidator(exportFrom(stagedHandle));
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
        if (restoreOptions.afterReplace) await restoreOptions.afterReplace(replacementPayload);

        closeChecked(replacementHandle, 'replacement');
        replacementHandle = undefined;
        liveClosed = true;
        committed = true;
        const retainedArtifacts = await cleanupArtifacts([rollbackPath, displacedPath]);
        rollbackExists = retainedArtifacts.includes(rollbackPath);
        displacedExists = retainedArtifacts.includes(displacedPath);
        const result = retainedArtifacts.length ? { source, destination: reportedDestination, retainedArtifacts } : { source, destination: reportedDestination };
        return result;
      } catch (error) {
        for (const [handle, stage] of [[db, 'live'], [sourceHandle, 'source'], [stagedHandle, 'staged'], [rollbackHandle, 'rollback'], [replacementHandle, 'replacement'], [liveHandle, 'live'], [recoveryHandle, 'recovery']]) {
          closeQuietly(handle, stage);
        }
        db = sourceHandle = stagedHandle = rollbackHandle = replacementHandle = liveHandle = recoveryHandle = undefined;

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
              liveClosed = true;
            }
            if (!recoveredInPlace) {
              // Preserve rollbackPath until the restored live database has opened,
              // prepared, and matched the old payload. A failed recovery therefore
              // still leaves a complete standalone snapshot for manual repair.
              await removeDatabase(recoveryPath);
              recoveryExists = true;
              fault('beforeRecoveryCopy');
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
        for (const [handle, stage] of [[db, 'live'], [sourceHandle, 'source'], [stagedHandle, 'staged'], [rollbackHandle, 'rollback'], [replacementHandle, 'replacement'], [liveHandle, 'live'], [recoveryHandle, 'recovery']]) {
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
      });
    },

    async backup(destination) {
      if (restoring) throw new Error('SQLite restore is in progress');
      if (permanentlyClosed) throw new Error('SQLite storage is closed');
      return fence.run(async () => {
        if (restoring) throw new Error('SQLite restore is in progress');
        if (permanentlyClosed) throw new Error('SQLite storage is closed');
        await mkdir(dirname(destination), { recursive: true });
        const temporary = join(dirname(destination), `.${basename(destination)}.${process.pid}.${Date.now()}.tmp`);
        let database;
        try {
          database = openLiveDatabase('backup');
          database.exec(`VACUUM INTO '${quoteSqlPath(temporary)}'`);
          closeChecked(database, 'backup');
          database = undefined;
          await rename(temporary, destination);
          return { source: filePath, destination };
        } finally {
          closeChecked(database, 'backup');
          await unlink(temporary).catch(() => {});
        }
      });
    },

    close() {
      if (restoring) throw new Error('Cannot close SQLite storage during restore');
      permanentlyClosed = true;
    }
  };
}
