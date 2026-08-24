import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createJsonFileStore(filePath) {
  let saveQueue = Promise.resolve();
  return {
    async load() {
      try { return JSON.parse(await readFile(filePath, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return { schemaVersion: 2, records: [], facts: [], events: [] }; throw new Error('ShadowGraph storage is invalid or unreadable'); }
    },
    async save(data) {
      const payload = Array.isArray(data) ? { schemaVersion: 2, records: data, facts: [], events: [] } : data;
      saveQueue = saveQueue.then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
        await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        await rename(temporaryPath, filePath);
      });
      return saveQueue;
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
