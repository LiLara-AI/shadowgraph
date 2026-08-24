import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createJsonFileStore(filePath) {
  let saveQueue = Promise.resolve();
  return {
    async load() {
      try {
        const text = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(text);
        return Array.isArray(parsed) ? parsed : parsed;
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
    async save(records) {
      const payload = Array.isArray(records) ? { schemaVersion: 2, records, facts: [], events: [] } : records;
      saveQueue = saveQueue.then(async () => {
        await mkdir(dirname(filePath), { recursive: true });
        const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.tmp`);
        await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
        await rename(temporaryPath, filePath);
      });
      return saveQueue;
    }
  };
}
