import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nextRevision, assertRevision } from './revision-store.js';

// Journal lives INSIDE the same payload as the state and is written by the same
// atomic temp-write + rename. See journal-contract.md §atomicity: state and
// journal can never diverge because they are never written separately.
const empty = () => ({ schemaVersion: 3, revision: 0, records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [], journal: [], journalSeq: 0, journalEpoch: null });

export function createJsonFileStore(filePath, options = {}) {
  let saveQueue = Promise.resolve();
  const lockPath = `${filePath}.lock`;
  const lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  const staleLockMs = options.staleLockMs ?? 30000;
  async function acquireLock() {
    const started = Date.now();
    const token = `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await mkdir(dirname(filePath), { recursive: true });
    while (true) {
      try {
        const handle = await open(lockPath, 'wx');
        await handle.writeFile(token, 'utf8');
        return async () => {
          await handle.close();
          try { if ((await readFile(lockPath, 'utf8')) === token) await unlink(lockPath); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        try {
          if (Date.now() - (await stat(lockPath)).mtimeMs > staleLockMs) { await unlink(lockPath).catch((candidate) => { if (candidate.code !== 'ENOENT') throw candidate; }); continue; }
        } catch (candidate) { if (candidate.code === 'ENOENT') continue; throw candidate; }
        if (Date.now() - started >= lockTimeoutMs) throw new Error(`ShadowGraph JSON writer lock timed out after ${lockTimeoutMs}ms; use SQLite for multi-process writers`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }
  return {
    async load() {
      try { return JSON.parse(await readFile(filePath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return empty(); throw new Error('ShadowGraph storage is invalid or unreadable'); }
    },
    async save(data) {
      const input = data;
      const operation = saveQueue.then(async () => {
        const release = await acquireLock();
        try {
          const current = await this.load();
          assertRevision(current, input?.expectedRevision ?? (input?.revision === undefined ? undefined : input.revision));
          const payload = nextRevision(Array.isArray(input) ? { ...empty(), records: input } : { ...input, revision: current.revision ?? 0, expectedRevision: undefined });
          const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
          await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
          await rename(temporaryPath, filePath);
          return payload.revision;
        } finally { await release(); }
      });
      saveQueue = operation.catch(() => {});
      return operation;
    }
  };
}

export async function createStorage(options = {}) {
  if ((options.type ?? process.env.SHADOWGRAPH_STORAGE ?? 'json') === 'sqlite') {
    const { createSqliteStore } = await import('./sqlite-storage.js');
    return createSqliteStore(options.file);
  }
  return createJsonFileStore(options.file);
}
