import { readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { nextRevision, assertRevision, createDestinationFence, restoreLock } from './revision-store.js';
import { SCHEMA_VERSION } from './shadowgraph.js';
import { refusePublicExport } from './internal/collections.js';
import { DELETION_VIEW, attachDeletionView, canonicalPath, commitFile, readUnfenced, refuseDeletionFileDestination, registerStoreIo, storeIo } from './internal/deletion-knowledge.js';
import { RestorePendingError, activation, asRestoreRefusal, completeRestore, purgeRecorded, recordPurges, resolvePendingRestore, restoreContext, restoreHook, saveResolving, settleAfterFailure } from './internal/restore-wrapper.js';

// Journal lives INSIDE the same payload as the state and is written by the same
// atomic temp-write + rename. See journal-contract.md §atomicity: state and
// journal can never diverge because they are never written separately.
const empty = () => ({ schemaVersion: SCHEMA_VERSION, revision: 0, records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null });

const unreadable = () => new Error('ShadowGraph storage is invalid or unreadable');

// The temporary payload files an earlier killed save left beside the store,
// which may hold what a purge removes (PR-37d review finding 7): only commit()'s
// own shape, `.<store>.<pid>.<13-digit ms>.<random>.tmp`, which no ledger's,
// registry's, sidecar's or backup's temporary file takes (re-review new finding
// 1); as every save writes one inside the store fence, none is in flight there.
// A store whose file is named `restore` shares that shape with the JSON restore
// primitive's own temporary file, kept for a crashed restore's recovery, so
// nothing beside it is removed (declared).
async function removeLeftTemporaries(target) {
  if (basename(target) === 'restore') return;
  const prefix = `.${basename(target)}.`;
  for (const name of await readdir(dirname(target))) {
    if (name.startsWith(prefix) && name.endsWith('.tmp') && /^\d+\.\d{13}\.[a-z0-9]+$/u.test(name.slice(prefix.length, -'.tmp'.length))) await rm(join(dirname(target), name), { force: true });
  }
}

// The store's text and payload; an absent store reads as empty, its text null.
async function readStored(filePath) {
  let text;
  try { text = await readFile(filePath, 'utf8'); }
  catch (error) {
    if (error.code !== 'ENOENT') throw unreadable();
    return { text: null, payload: empty() };
  }
  try { return { text, payload: JSON.parse(text) }; } catch { throw unreadable(); }
}

export function createJsonFileStore(filePath, options = {}) {
  let saveQueue = Promise.resolve();
  const fence = createDestinationFence(filePath, options);
  // One step inside the fence, after this handle's earlier ones.
  const fenced = (step) => {
    const operation = saveQueue.then(() => fence.run(step));
    saveQueue = operation.catch(() => {});
    return operation;
  };
  // Writes `input` as the payload after `current`: a temporary file, renamed
  // over the store's final name, links followed, the name every ledger read
  // and write uses. So a save through an alias of the file's own name -- a
  // symbolic link to it, or its 8.3 name -- writes the file its ledger lies
  // beside and leaves the link a link (review finding 3; design §3.1).
  //
  // Every payload write of this store goes through here, the purge commit
  // point (PR-37d design §3.1, §3.4): no store at a deletion record file's
  // name (step 0), then the deletion records of a purge the payload carries
  // (steps 1-7), all before the temporary file, which a failed commit removes
  // (V-18); the purge's record is cleared after the payload commit (step 12).
  // A purge's write first removes the temporary files killed saves left.
  // `hook`: the capture hook's write, which never carries a purge.
  async function commit(current, input, { hook = false } = {}) {
    const payload = nextRevision(Array.isArray(input) ? { ...empty(), records: input } : { ...input, revision: current.revision ?? 0, expectedRevision: undefined });
    const context = { current, payload, destructive: false };
    const target = await canonicalPath(filePath);
    await refuseDeletionFileDestination(filePath, options.env);
    const clear = await recordPurges(filePath, { current, data: input, env: options.env, lock: options, hook, fault: (stage) => options.saveFault?.(stage, context) });
    const temporaryPath = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    // The store keeps its mode, or is owner-only when new; a capture store is
    // owner-only whatever it was (FND-P6-11; PR-37b).
    const mode = options.mode ?? await stat(target).then((info) => info.mode & 0o777, () => 0o600);
    try {
      if (clear) await removeLeftTemporaries(target);
      try {
        await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode });
        options.saveFault?.('beforeCommit', context);
        await commitFile(temporaryPath, target, options.rename);
      } catch (error) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      if (clear) {
        await options.saveFault?.('beforeRecordCleared', context);
        await clear();
      }
    } catch (error) { throw clear ? purgeRecorded(error) : error; }
    options.saveFault?.('afterCommit', context);
    return payload.revision;
  }
  // The payload and its view inside the fence, where no writer can interleave,
  // so no bracket is needed (PR-37c design §8.1). The capture hook's update
  // refuses every pending record (`pending: 'refuse'`).
  async function readFenced(pending) {
    const { text, payload } = await readStored(filePath);
    return attachDeletionView(payload, filePath, { registry: true, env: options.env, pending, absent: text === null });
  }
  // The store's own I/O, for the restore wrapper and its resolvers (PR-37c
  // design §3.6): `read` gives the stored payload with no view, or null when
  // there is none, and never makes the file; `commit` writes over what `read`
  // last gave; `load` is the fenced read with its view. `held`: the caller
  // holds the fence already. `lock`: the fence options a purge completion's
  // registry lock takes too (PR-37d design §3.7).
  const io = {
    file: filePath,
    env: options.env,
    lock: options,
    run(step, { held = false } = {}) {
      let last;
      const tools = {
        read: async () => {
          const { text, payload } = await readStored(filePath);
          last = payload;
          return text === null ? null : payload;
        },
        commit: async (next) => commit(last ?? (await readStored(filePath)).payload, next),
        load: () => readFenced('suppress')
      };
      return held ? step(tools) : fence.run(() => step(tools));
    }
  };
  return registerStoreIo({
    // The payload, then the deletion records beside it (PR-37a), with no fence
    // held: the ledger read is bracketed by the payload's identity, read again
    // after it, and a load that keeps losing that race is busy (PR-37c design
    // §8.1). A record it cannot serve, or an unreadable ledger, refuses it.
    // `loadFault` is a test seam, awaited between the payload and the ledger.
    async load() {
      const payload = await readUnfenced(filePath, () => readStored(filePath), {
        registry: true, env: options.env, afterPayloadRead: () => options.loadFault?.('afterPayloadRead')
      });
      if (payload === null) throw Object.assign(new Error('ShadowGraph storage changed on every read; try again'), { code: 'storage_lock_timeout' });
      return payload;
    },
    // A save never commits over a restore record: it completes the record
    // first, under the restore lock, and is tried once more (PR-37c design
    // §8.3). `pending: 'read'`: a read's audit save, which refuses any record
    // instead (PR-37d review finding 2).
    async save(data, { pending = 'suppress' } = {}) {
      refusePublicExport(data);
      return saveResolving(io, options, () => fenced(async () => {
        const current = await readFenced(pending);
        if (current[DELETION_VIEW]?.pending) throw new RestorePendingError();
        assertRevision(current, data?.expectedRevision ?? (data?.revision === undefined ? undefined : data.revision));
        return commit(current, data);
      }));
    },
    // Load, change and write under one hold of the fence, so no revision can
    // conflict (automatic capture, PR-36c; PR-36 design review D-2): `change`
    // gets the stored payload and returns the next one, or null (or nothing)
    // to write nothing. Resolves to the new revision, or null. The capture
    // hook's only write: any pending record refuses it before `change` runs,
    // so the hook writes nothing then (PR-37c design §8.3, R8).
    async update(change) {
      return fenced(async () => {
        const current = await readFenced('refuse');
        const next = await change(current);
        if (next === null || next === undefined) return null;
        refusePublicExport(next);
        return commit(current, next, { hook: true });
      });
    },
    close() {}
  }, io);
}

export async function createStorage(options = {}) {
  if ((options.type ?? process.env.SHADOWGRAPH_STORAGE ?? 'json') === 'sqlite') {
    const { createSqliteStore } = await import('./sqlite-storage.js');
    const store = await createSqliteStore(options.file, {
      restoreValidator: options.restoreValidator,
      restoreFault: options.restoreFault,
      restoreFs: options.restoreFs,
      saveFault: options.saveFault,
      lockTimeoutMs: options.lockTimeoutMs,
      staleLockMs: options.staleLockMs,
      lockPollIntervalMs: options.lockPollIntervalMs,
      env: options.env
    });
    // The `./storage` restore is the restore wrapper around the unchanged
    // primitive, which takes the store fence itself (PR-37c design §3.3): step
    // 0 and the post-step take it too, the pre-step runs in the hook's first
    // call inside the primitive's hold, and the gap after the primitive is
    // closed by the save rule (§8.3). The raw store's restore stays the
    // primitive (d37a F18). `verifier` is the wrapper's own option.
    const restore = store.restore;
    const io = storeIo(store);
    store.restore = (source, restoreOptions = {}) => restoreLock(options.file, options).run(async () => {
      await asRestoreRefusal(resolvePendingRestore(io, { verifier: restoreOptions.verifier }));
      const ctx = restoreContext({
        source, destination: options.file, env: options.env, verifier: restoreOptions.verifier, backend: 'sqlite',
        instant: restoreOptions.now ?? new Date().toISOString(), read: () => io.run(({ read }) => read(), { held: true })
      });
      const callerValidate = restoreOptions.validate === options.restoreValidator ? undefined : restoreOptions.validate;
      let result;
      try { result = await restore(source, { ...restoreOptions, validate: restoreHook(ctx, callerValidate), afterReplace: activation(ctx, restoreOptions.afterReplace) }); }
      catch (error) {
        await settleAfterFailure(io, ctx);
        throw error;
      }
      return completeRestore(io, ctx, result, restoreOptions.afterReplace, { load: () => store.load(), restoreFault: options.restoreFault });
    });
    return store;
  }
  return createJsonFileStore(options.file, options);
}
