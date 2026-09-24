// Moving a store onto schema 6 and, if ever needed, forking a schema-5 copy
// back off it (plan v1.4.4 §9.6, §19.3.2).
//
// Neither operation writes in place over anything it cannot give back. Before
// either one runs, a verified, complete, current-format preservation copy of
// the store is written -- a store-native backup the same build can restore --
// and its hash is recorded. The migration then changes the live store only
// through ordinary journalled saves; the downgrade writes a separate new file
// and leaves the current store untouched.
import { createHash } from 'node:crypto';
import { copyFile, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { backupFile } from './backup.js';
import { createStorage } from './storage.js';
import { validateRestorePayload } from './restore-validation.js';
import { extraCollections } from './internal/collections.js';
import { privilegedSnapshot } from './internal/snapshot.js';

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const samePath = (left, right) => (process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right));

async function exists(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

async function loadThrough(type, path) {
  const store = await createStorage({ type, file: path });
  try { return await store.load(); } finally { store.close?.(); }
}

// Step 1 of §19.3.2: a complete current-format copy, verified before anything
// depends on it. The copy is read back through a scratch duplicate -- opening a
// store can touch its file -- checked by restore validation, compared with what
// the store itself holds, and hashed before and after to prove it was not
// altered.
export async function writePreservationCopy({ store, file, storageType = 'json', destination }) {
  if (!destination) throw new Error('A preservation copy needs a destination path');
  if (samePath(destination, file)) throw new Error('The preservation copy cannot be the store itself');
  if (await exists(destination)) throw new Error(`Refusing to overwrite an existing file with a preservation copy: ${destination}`);
  await backupFile(file, destination, { store });
  const hash = await sha256(destination);
  const scratch = join(dirname(resolve(destination)), `.preservation-check.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}`);
  try {
    await copyFile(destination, scratch);
    const preserved = await loadThrough(storageType, scratch);
    validateRestorePayload(preserved);
    const stored = await store.load();
    for (const key of new Set([...Object.keys(stored), ...Object.keys(preserved)])) {
      if (JSON.stringify(preserved[key]) !== JSON.stringify(stored[key])) throw new Error(`Preservation copy does not match the store (${key})`);
    }
  } finally {
    for (const path of [scratch, `${scratch}-wal`, `${scratch}-shm`, `${scratch}-journal`]) await unlink(path).catch(() => {});
  }
  if (await sha256(destination) !== hash) throw new Error('Preservation copy changed while it was being verified');
  return { path: destination, sha256: hash, verified: true };
}

// The resumable attribution migration, persisted batch by batch. Restore
// validation runs before anything changes and again at the end; an
// interrupted run leaves a store the current build reads, and running this
// again continues from the entities still unattributed.
export async function migrateStore({ graph, store, file, storageType = 'json', batchSize = 500, preservationCopy }) {
  validateRestorePayload(privilegedSnapshot(graph));
  const preservation = await writePreservationCopy({ store, file, storageType, destination: preservationCopy });
  const batches = [];
  for (;;) {
    const batch = graph.migrateAttribution({ limit: batchSize });
    if (batch.migrated) graph.setRevision(await store.save(privilegedSnapshot(graph)));
    batches.push(batch);
    if (batch.complete) break;
  }
  validateRestorePayload(privilegedSnapshot(graph));
  const attributions = { project: 0, legacy_ambiguous: 0, legacy_unattributed: 0 };
  for (const batch of batches) for (const [name, count] of Object.entries(batch.attributions)) attributions[name] += count;
  return {
    preservationCopy: preservation,
    migrated: batches.reduce((total, batch) => total + batch.migrated, 0),
    attributions,
    batches: batches.filter((batch) => batch.migrated).length,
    highWaterMark: batches.findLast((batch) => batch.highWaterMark)?.highWaterMark ?? null,
    complete: true
  };
}

// A schema-5 rendering of a schema-6 snapshot (§19.3.2 steps 3-4). Pure. What
// schema 5 cannot represent is left out and named in the report -- it is not
// deleted; it stays in the preservation copy:
//   - attribution and originId fields;
//   - unattributed entities, which schema 5 could only place in "default", and
//     whatever refers to them;
//   - the journal history, which schema-5 readers cannot replay once it holds
//     schema-6 entries -- the copy starts from one schema-5 baseline instead;
//   - collections a schema-5 reader does not know.
export function downgradeToSchema5(snapshot, { now = () => new Date().toISOString() } = {}) {
  const source = structuredClone(snapshot);
  const report = { fromSchemaVersion: source.schemaVersion, toSchemaVersion: 5, removedFields: [], excluded: [], excludedCollections: [], journal: null };
  const excludedIds = new Set();
  const byId = new Map();
  const convert = (entity) => {
    if (entity.attribution === 'unattributed') {
      excludedIds.add(entity.id);
      for (const alternative of entity.alternatives ?? []) if (alternative?.id) excludedIds.add(alternative.id);
      report.excluded.push({ collection: entity.kind === 'fact' ? 'facts' : 'records', id: entity.id, kind: entity.kind, originId: entity.originId ?? null, reason: 'unattributed: schema 5 has no owner for it but "default"' });
      return null;
    }
    const fields = ['attribution', 'originId'].filter((field) => Object.hasOwn(entity, field));
    for (const field of fields) delete entity[field];
    if (entity.schemaVersion === 6) entity.schemaVersion = 5;
    if (fields.length) report.removedFields.push({ id: entity.id, kind: entity.kind, fields });
    byId.set(entity.id, entity);
    return entity;
  };
  const records = (source.records ?? []).map(convert).filter(Boolean);
  const facts = (source.facts ?? []).map(convert).filter(Boolean);
  const drop = (collection, items, refersToExcluded, describe) => items.filter((item) => {
    if (!refersToExcluded(item)) return true;
    report.excluded.push({ collection, ...describe(item), reason: 'refers to an excluded unattributed entity' });
    return false;
  });
  const relations = drop('relations', source.relations ?? [], (item) => excludedIds.has(item.from) || excludedIds.has(item.to), (item) => ({ id: item.id }))
    .map((item) => (item.schemaVersion === 6 ? { ...item, schemaVersion: 5 } : item));
  const reviewSignals = drop('reviewSignals', source.reviewSignals ?? [], (item) => excludedIds.has(item.decisionId), (item) => ({ id: item.id }));
  const idempotency = drop('idempotency', source.idempotency ?? [], (item) => excludedIds.has(item.value?.id), (item) => ({ key: item.key }))
    .map((item) => ({ key: item.key, value: structuredClone(byId.get(item.value?.id) ?? item.value) }));
  const events = drop('events', source.events ?? [], (item) => [item.recordId, item.factId, item.relationId].some((id) => excludedIds.has(id)), (item) => ({ id: item.id }));
  const journal = source.journal ?? [];
  const byType = {};
  for (const entry of journal) byType[entry?.type ?? 'unknown'] = (byType[entry?.type ?? 'unknown'] ?? 0) + 1;
  const seq = (Number.isSafeInteger(source.journalSeq) ? source.journalSeq : 0) + 1;
  report.journal = { replacedEntries: journal.length, byType, baselineSeq: seq };
  report.excludedCollections = extraCollections(source).map(([key]) => key);
  return {
    report,
    payload: {
      schemaVersion: 5,
      revision: source.revision ?? 0,
      records, facts, relations, reviewSignals, idempotency, events,
      journal: [{
        id: `jentry_downgrade_${seq}`, seq, type: 'projection.baseline', at: now(), project: null,
        entityKind: null, entityId: null, schemaVersion: 5, derivedFrom: 'downgrade_from_schema_6',
        payload: { records: structuredClone(records), facts: structuredClone(facts), relations: structuredClone(relations), idempotency: structuredClone(idempotency) },
        provenance: { actor: null, client: null, sessionId: null }
      }],
      journalSeq: seq,
      journalEpoch: seq
    }
  };
}

// §19.3.2 end to end: preservation copy first and recorded in the report
// before any conversion runs; the downgraded store as a separate new file;
// the current store left untouched.
export async function downgradeStore({ graph, store, file, storageType = 'json', output, preservationCopy, now }) {
  if (!output) throw new Error('A downgrade needs an output path');
  if (samePath(output, file)) throw new Error('A downgrade never writes over the store it converts');
  if (preservationCopy && samePath(output, preservationCopy)) throw new Error('A downgrade never writes over its preservation copy');
  if (await exists(output)) throw new Error(`Refusing to overwrite an existing file with a downgrade: ${output}`);
  const reportPath = `${output}.report.json`;
  if (await exists(reportPath)) throw new Error(`Refusing to overwrite an existing report: ${reportPath}`);
  const preservation = await writePreservationCopy({ store, file, storageType, destination: preservationCopy });
  await writeFile(reportPath, `${JSON.stringify({ status: 'converting', preservationCopy: preservation }, null, 2)}\n`, 'utf8');
  const { payload, report } = downgradeToSchema5(privilegedSnapshot(graph), { now });
  validateRestorePayload(payload);
  if (storageType === 'sqlite') {
    const target = await createStorage({ type: 'sqlite', file: output });
    try { await target.save({ ...payload, expectedRevision: 0 }); } finally { target.close?.(); }
  } else {
    const temporary = `${output}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    await rename(temporary, output);
  }
  validateRestorePayload(await loadThrough(storageType, output));
  const result = { status: 'complete', preservationCopy: preservation, output, outputSha256: await sha256(output), ...report, note: 'Everything listed as removed or excluded is intact in the preservation copy; nothing was deleted, and the current-format store was not changed.' };
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { ...result, report: reportPath };
}
