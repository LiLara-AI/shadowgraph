import { copyFile, mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { createDestinationFence, currentRevision, nextRevisionAfter } from './revision-store.js';
import { guardAuthorityRestore, validateRestorePayload, validateRestoreSnapshot } from './restore-validation.js';
import { mergeAuthorityRestore } from './authority-restore.js';
import { backupSidecar, deletionRestoreHook, refuseDeletionFileDestination, writeSidecar } from './internal/deletion-knowledge.js';

// A backup carries the store's deletion records beside it (PR-37a): the
// payload is read, then the records; their copy lands first, then the payload.
// Both go to the destination's final path, which is never a deletion record
// file however it is spelled.
export async function backupFile(source, destination, options = {}) {
  const target = await refuseDeletionFileDestination(destination, options.env);
  await mkdir(dirname(target), { recursive: true });
  if (options.store?.backup) return options.store.backup(destination);
  const temporary = join(dirname(target), `.${target.split(/[\\/]/).pop()}.${process.pid}.${Date.now()}.tmp`);
  try {
    await copyFile(source, temporary);
    await writeSidecar(target, await backupSidecar(source, target, options.env));
    await rename(temporary, target);
    return { source, destination };
  }
  finally { await unlink(temporary).catch(() => {}); }
}

// The restore refuses what needs deletion semantics this build lacks
// (PR-37a), through the validate hook the unchanged primitive calls inside the
// fence before any write. A destination that is not there holds nothing; one
// that is there but cannot be read refuses.
export async function restoreFile(source, destination, options = {}) {
  const fence = createDestinationFence(destination, options);
  const validate = deletionRestoreHook({
    source, destination, env: options.env, validate: options.validate,
    readDestination: async () => {
      try { return JSON.parse(await readFile(destination, 'utf8')); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }
  });
  return fence.run(() => restoreJsonFileFenced(source, destination, { ...options, validate }));
}

async function restoreJsonFileFenced(source, destination, options) {
  if (options.storage === 'sqlite' || destination.toLowerCase().endsWith('.db')) throw new Error('JSON restore cannot overwrite a SQLite database; use the SQLite backup snapshot directly or a database-aware restore');
  const backupPayload = JSON.parse(await readFile(source, 'utf8'));
  if (!backupPayload || typeof backupPayload !== 'object' || !Array.isArray(backupPayload.records)) throw new Error('Backup is not a JSON ShadowGraph export; SQLite files require a database-aware restore');
  const payload = options.memoryOnly === true ? guardAuthorityRestore(backupPayload, { memoryOnly: true }) : backupPayload;
  const sourceForInstallation = await validateRestoreSnapshot(payload, { validators: [options.validate] });
  currentRevision(payload, 'Restore source');
  const normalizePath = (path) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path);
  if (normalizePath(source) === normalizePath(destination)) {
    return { source, destination, records: payload.records.length, unchanged: true };
  }
  await mkdir(dirname(destination), { recursive: true });
  const token = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const temporaryPath = join(dirname(destination), `.restore.${token}.tmp`);
  const rollbackPath = join(dirname(destination), `.restore.${token}.rollback`);
  const recoveryPath = join(dirname(destination), `.restore.${token}.recovery`);
  const restoreFs = {
    copyFile: options.restoreFs?.copyFile ?? copyFile,
    readFile: options.restoreFs?.readFile ?? readFile,
    rename: options.restoreFs?.rename ?? rename,
    stat: options.restoreFs?.stat ?? stat,
    unlink: options.restoreFs?.unlink ?? unlink,
    writeFile: options.restoreFs?.writeFile ?? writeFile
  };
  const fault = (stage) => options.restoreFault?.(stage);
  let previousBytes;
  let destinationExisted = true;
  let recoveryUnconfirmed = false;
  let artifactCleanupFinished = false;
  try { previousBytes = await restoreFs.readFile(destination); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    destinationExisted = false;
  }
  const previousPayload = destinationExisted ? JSON.parse(Buffer.from(previousBytes).toString('utf8')) : {};
  const merged = options.memoryOnly === true ? sourceForInstallation : mergeAuthorityRestore(sourceForInstallation, previousPayload, { now: options.now ?? new Date().toISOString() });
  const installedPayload = { ...merged, revision: nextRevisionAfter(previousPayload, payload) };
  // Validate the exact candidate after authority/audit merging and legacy
  // normalization. The source callback is observational and cannot alter it.
  validateRestorePayload(installedPayload);
  const assertExactBytes = async (path, expected, label) => {
    const actual = await restoreFs.readFile(path);
    if (!Buffer.from(actual).equals(Buffer.from(expected))) throw new Error(`${label} does not match the original destination bytes`);
  };
  const artifactPaths = [rollbackPath, recoveryPath, temporaryPath];
  const inspectArtifacts = async (paths = artifactPaths) => {
    const retainedArtifacts = [];
    const unknownArtifacts = [];
    for (const path of paths) {
      try { if ((await restoreFs.stat(path)).isFile()) retainedArtifacts.push(path); }
      catch (error) {
        if (error.code !== 'ENOENT') unknownArtifacts.push({ path, code: error.code ?? 'unknown' });
      }
    }
    return { retainedArtifacts, unknownArtifacts };
  };
  const cleanupArtifacts = async () => {
    const errors = [];
    for (const path of artifactPaths) {
      try { await restoreFs.unlink(path); }
      catch (error) {
        if (error.code !== 'ENOENT') errors.push({ path, code: error.code ?? 'unknown' });
      }
    }
    const inventory = await inspectArtifacts();
    return {
      ...inventory,
      artifactCleanup: {
        status: inventory.unknownArtifacts.length ? 'unknown' : inventory.retainedArtifacts.length ? 'incomplete' : 'complete',
        errors
      }
    };
  };
  const reportCleanupAnomaly = (target, report) => {
    if (!report.artifactCleanup.errors.length && !report.retainedArtifacts.length && !report.unknownArtifacts.length) return target;
    target.retainedArtifacts = report.retainedArtifacts;
    target.unknownArtifacts = report.unknownArtifacts;
    target.artifactCleanup = report.artifactCleanup;
    target.rollbackArtifact = report.retainedArtifacts.includes(rollbackPath) ? rollbackPath : undefined;
    target.recoveryArtifact = report.retainedArtifacts.includes(recoveryPath) ? recoveryPath : undefined;
    target.temporaryArtifact = report.retainedArtifacts.includes(temporaryPath) ? temporaryPath : undefined;
    return target;
  };
  try {
    await restoreFs.writeFile(temporaryPath, JSON.stringify(installedPayload, null, 2) + '\n', 'utf8');
    // Materialize and read back the complete old file before installing anything.
    // Recovery installs a verified copy, so this sole rollback artifact is never
    // consumed until the old destination has been confirmed byte-for-byte.
    if (destinationExisted) {
      await restoreFs.writeFile(rollbackPath, previousBytes);
      await assertExactBytes(rollbackPath, previousBytes, 'JSON rollback artifact');
    }
    try {
      fault('beforeReplacementRename');
      await restoreFs.rename(temporaryPath, destination);
      fault('afterReplacementRename');
      if (options.afterReplace) await options.afterReplace(installedPayload);
    } catch (cause) {
      try {
        if (destinationExisted) {
          fault('beforeRollbackInstall');
          await restoreFs.copyFile(rollbackPath, recoveryPath);
          await assertExactBytes(recoveryPath, previousBytes, 'JSON recovery copy');
          await restoreFs.rename(recoveryPath, destination);
          await assertExactBytes(destination, previousBytes, 'Restored JSON destination');
          fault('afterRollbackConfirmed');
        } else {
          await restoreFs.unlink(destination).catch((error) => { if (error.code !== 'ENOENT') throw error; });
          try {
            await restoreFs.stat(destination);
            throw new Error('replacement destination still exists after recovery');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        }
      } catch (recoveryCause) {
        recoveryUnconfirmed = true;
        const error = new Error(`JSON restore failed and rollback is unconfirmed: ${recoveryCause.message}`);
        error.code = 'json_restore_recovery_unconfirmed';
        error.cause = cause;
        error.recoveryCause = recoveryCause;
        const inventory = await inspectArtifacts();
        error.retainedArtifacts = inventory.retainedArtifacts;
        if (inventory.unknownArtifacts.length) error.unknownArtifacts = inventory.unknownArtifacts;
        error.rollbackArtifact = error.retainedArtifacts.includes(rollbackPath) ? rollbackPath : undefined;
        error.recoveryArtifact = error.retainedArtifacts.includes(recoveryPath) ? recoveryPath : undefined;
        error.temporaryArtifact = error.retainedArtifacts.includes(temporaryPath) ? temporaryPath : undefined;
        throw error;
      }
      const error = new Error(`JSON restore failed; previous file restored: ${cause.message}`);
      error.code = 'json_restore_rolled_back';
      error.cause = cause;
      const cleanupReport = await cleanupArtifacts();
      artifactCleanupFinished = true;
      reportCleanupAnomaly(error, cleanupReport);
      throw error;
    }
    const result = { source, destination, records: installedPayload.records.length };
    const cleanupReport = await cleanupArtifacts();
    artifactCleanupFinished = true;
    return reportCleanupAnomaly(result, cleanupReport);
  } finally {
    if (!recoveryUnconfirmed && !artifactCleanupFinished) {
      await restoreFs.unlink(temporaryPath).catch(() => {});
      await restoreFs.unlink(recoveryPath).catch(() => {});
      await restoreFs.unlink(rollbackPath).catch(() => {});
    }
  }
}
