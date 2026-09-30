import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { nextRevision, assertRevision, createDestinationFence } from './revision-store.js';
import { SCHEMA_VERSION } from './shadowgraph.js';
import { refusePublicExport } from './internal/collections.js';

// Journal lives INSIDE the same payload as the state and is written by the same
// atomic temp-write + rename. See journal-contract.md §atomicity: state and
// journal can never diverge because they are never written separately.
const empty = () => ({ schemaVersion: SCHEMA_VERSION, revision: 0, records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null });

// On Windows a process reading the store (host delivery reads it at every
// prompt) can briefly block the rename that commits a save. It is tried a few
// more times; if it still fails, the temporary file is removed and the save
// fails as before (FND-P5-01). `move` is a test seam.
async function commitFile(temporaryPath, filePath, move = rename) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await move(temporaryPath, filePath);
    } catch (error) {
      if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
        await rm(temporaryPath, { force: true });
        throw error;
      }
      await delay(20 * attempt);
    }
  }
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
  // Writes `input` as the payload after `current`: a temporary file, renamed.
  async function commit(current, input) {
    const payload = nextRevision(Array.isArray(input) ? { ...empty(), records: input } : { ...input, revision: current.revision ?? 0, expectedRevision: undefined });
    const context = { current, payload, destructive: false };
    const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    options.saveFault?.('beforeCommit', context);
    await commitFile(temporaryPath, filePath, options.rename);
    options.saveFault?.('afterCommit', context);
    return payload.revision;
  }
  return {
    async load() {
      try { return JSON.parse(await readFile(filePath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return empty(); throw new Error('ShadowGraph storage is invalid or unreadable'); }
    },
    async save(data) {
      refusePublicExport(data);
      return fenced(async () => {
        const current = await this.load();
        assertRevision(current, data?.expectedRevision ?? (data?.revision === undefined ? undefined : data.revision));
        return commit(current, data);
      });
    },
    // Load, change and write under one hold of the fence, so no revision can
    // conflict (automatic capture, PR-36c; PR-36 design review D-2): `change`
    // gets the stored payload and returns the next one, or null (or nothing)
    // to write nothing. Resolves to the new revision, or null.
    async update(change) {
      return fenced(async () => {
        const current = await this.load();
        const next = await change(current);
        if (next === null || next === undefined) return null;
        refusePublicExport(next);
        return commit(current, next);
      });
    },
    close() {}
  };
}

export async function createStorage(options = {}) {
  if ((options.type ?? process.env.SHADOWGRAPH_STORAGE ?? 'json') === 'sqlite') {
    const { createSqliteStore } = await import('./sqlite-storage.js');
    return createSqliteStore(options.file, {
      restoreValidator: options.restoreValidator,
      restoreFault: options.restoreFault,
      restoreFs: options.restoreFs,
      saveFault: options.saveFault,
      lockTimeoutMs: options.lockTimeoutMs,
      staleLockMs: options.staleLockMs,
      lockPollIntervalMs: options.lockPollIntervalMs
    });
  }
  return createJsonFileStore(options.file, options);
}
