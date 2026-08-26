import { copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export async function backupFile(source, destination, options = {}) {
  await mkdir(dirname(destination), { recursive: true });
  if (options.store?.backup) return options.store.backup(destination);
  const temporary = join(dirname(destination), `.${destination.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.tmp`);
  try { await copyFile(source, temporary); await rename(temporary, destination); return { source, destination }; }
  finally { await unlink(temporary).catch(() => {}); }
}

export async function restoreFile(source, destination, options = {}) {
  if (options.storage === 'sqlite' || destination.toLowerCase().endsWith('.db')) throw new Error('JSON restore cannot overwrite a SQLite database; use the SQLite backup snapshot directly or a database-aware restore');
  const payload = JSON.parse(await readFile(source, 'utf8'));
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.records)) throw new Error('Backup is not a JSON ShadowGraph export; SQLite files require a database-aware restore');
  if (options.validate) await options.validate(payload);
  await mkdir(dirname(destination), { recursive: true });
  const temporaryPath = join(dirname(destination), `.restore.${process.pid}.${Date.now()}.tmp`);
  try {
    await writeFile(temporaryPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await rename(temporaryPath, destination);
    return { source, destination, records: payload.records.length };
  } finally { await unlink(temporaryPath).catch(() => {}); }
}
