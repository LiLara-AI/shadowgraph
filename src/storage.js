import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export function createJsonFileStore(filePath) {
  return {
    async load() {
      try {
        const text = await readFile(filePath, 'utf8');
        const parsed = JSON.parse(text);
        return Array.isArray(parsed.records) ? parsed.records : [];
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    },
    async save(records) {
      await mkdir(dirname(filePath), { recursive: true });
      const temporaryPath = join(dirname(filePath), `.${filePath.split(/[\\/]/).pop()}.tmp`);
      await writeFile(temporaryPath, JSON.stringify({ version: 1, records }, null, 2) + '\n', 'utf8');
      await rename(temporaryPath, filePath);
    }
  };
}
