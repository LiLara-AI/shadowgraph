import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nextRevision, assertRevision, createDestinationFence } from './revision-store.js';
import { SCHEMA_VERSION } from './shadowgraph.js';

// Journal lives INSIDE the same payload as the state and is written by the same
// atomic temp-write + rename. See journal-contract.md §atomicity: state and
// journal can never diverge because they are never written separately.
const empty = () => ({ schemaVersion: SCHEMA_VERSION, revision: 0, records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null });

export function createJsonFileStore(filePath, options = {}) {
  let saveQueue = Promise.resolve();
  const fence = createDestinationFence(filePath, options);
  return {
    async load() {
      try { return JSON.parse(await readFile(filePath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return empty(); throw new Error('ShadowGraph storage is invalid or unreadable'); }
    },
    async save(data) {
      const input = data;
      const operation = saveQueue.then(() => fence.run(async () => {
          const current = await this.load();
          assertRevision(current, input?.expectedRevision ?? (input?.revision === undefined ? undefined : input.revision));
          const payload = nextRevision(Array.isArray(input) ? { ...empty(), records: input } : { ...input, revision: current.revision ?? 0, expectedRevision: undefined });
          const context = { current, payload, destructive: false };
          const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
          await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
          options.saveFault?.('beforeCommit', context);
          await rename(temporaryPath, filePath);
          options.saveFault?.('afterCommit', context);
          return payload.revision;
      }));
      saveQueue = operation.catch(() => {});
      return operation;
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
