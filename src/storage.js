import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { nextRevision, assertRevision } from './revision-store.js';

const empty = () => ({ schemaVersion: 2, revision: 0, records: [], facts: [], relations: [], reviewSignals: [], idempotency: [], events: [] });

export function createJsonFileStore(filePath) {
  let saveQueue = Promise.resolve();
  return {
    async load() {
      try { return JSON.parse(await readFile(filePath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return empty(); throw new Error('ShadowGraph storage is invalid or unreadable'); }
    },
    async save(data) {
      const input = data;
      const operation = saveQueue.then(async () => {
        const current = await this.load();
        assertRevision(current, input?.expectedRevision ?? (input?.revision === undefined ? undefined : input.revision));
        const payload = nextRevision(Array.isArray(input) ? { ...empty(), records: input } : { ...input, revision: current.revision ?? 0, expectedRevision: undefined });
        await mkdir(dirname(filePath), { recursive: true });
        const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
        await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        await rename(temporaryPath, filePath);
        return payload.revision;
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
