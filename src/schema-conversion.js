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
import { copyFile, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { backupFile } from './backup.js';
import { createStorage } from './storage.js';
import { validateRestorePayload } from './restore-validation.js';
import { extraCollections } from './internal/collections.js';
import { RUNTIME_MISSES } from './internal/miss-ledger.js';

// Collections whose reader floor is above every downgrade target: a build below
// it would carry their entries but never purge them, so conversion leaves them
// out and reports only how many entries each held (PR-28a).
const BELOW_FLOOR_COLLECTIONS = Object.freeze([RUNTIME_MISSES]);
function excludeBelowFloor(source, report) {
  for (const collection of BELOW_FLOOR_COLLECTIONS) {
    if (source[collection] === undefined) continue;
    if (!report.excludedCollections.includes(collection)) report.excludedCollections.push(collection);
    report.excludedEntryCounts[collection] = Array.isArray(source[collection]) ? source[collection].length : 0;
  }
}
import { privilegedSnapshot } from './internal/snapshot.js';

const sha256 = async (path) => createHash('sha256').update(await readFile(path)).digest('hex');
const samePath = (left, right) => (process.platform === 'win32' ? resolve(left).toLowerCase() === resolve(right).toLowerCase() : resolve(left) === resolve(right));

// The same file under another name -- through a linked directory, or a short
// name -- is still the same file: an existing path is compared by its real
// path, a file not yet written by the real path of its directory.
async function canonicalPath(path) {
  const absolute = resolve(path);
  const real = await realpath(absolute).catch(() => null)
    ?? join(await realpath(dirname(absolute)).catch(() => dirname(absolute)), basename(absolute));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

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
  const tokened = () => { const snapshot = privilegedSnapshot(graph); return [...snapshot.records, ...snapshot.facts].filter((entity) => entity.erasureToken !== undefined).length; };
  validateRestorePayload(privilegedSnapshot(graph));
  const tokenedBefore = tokened();
  const preservation = await writePreservationCopy({ store, file, storageType, destination: preservationCopy });
  const batches = [];
  for (;;) {
    const batch = graph.migrateAttribution({ limit: batchSize });
    if (batch.migrated) graph.setRevision(await store.save(privilegedSnapshot(graph)));
    batches.push(batch);
    if (batch.complete) break;
  }
  // Then the erasure-token backfill (plan rev6 §3.2): each batch is restore-
  // validated before it is saved, so a batch a reader would refuse never lands.
  // ponytail: whole-store validation per batch costs O(n^2 / batchSize); a
  // large store takes a larger batchSize.
  const tokenBatches = [];
  for (;;) {
    const batch = graph.backfillErasureTokens({ limit: batchSize });
    if (batch.assigned) {
      const snapshot = privilegedSnapshot(graph);
      validateRestorePayload(snapshot);
      graph.setRevision(await store.save(snapshot));
    }
    tokenBatches.push(batch);
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
    // Every token this run gave: on the attribution migration's own entries,
    // and by the backfill.
    tokens: {
      assigned: tokened() - tokenedBefore,
      backfilled: tokenBatches.reduce((total, batch) => total + batch.assigned, 0),
      batches: tokenBatches.filter((batch) => batch.assigned).length,
      highWaterMark: tokenBatches.findLast((batch) => batch.highWaterMark)?.highWaterMark ?? null,
      skipped: tokenBatches.at(-1).skipped
    },
    complete: true
  };
}

function dropReferencing(report, collection, items, refersToExcluded, describe) {
  return items.filter((item) => {
    if (!refersToExcluded(item)) return true;
    report.excluded.push({ collection, ...describe(item), reason: 'refers to an excluded entity' });
    return false;
  });
}

const SCHEMA_7_FIELDS = ['claims', 'causalClaim', 'captureRef', 'outcomeEvidence', 'erasureToken'];

// A schema-6 fork takes this build's own schema-7 snapshot, and nothing newer.
function assertSchema7Source(source) {
  if (source.schemaVersion !== 7) throw new Error(`A downgrade to schema 6 converts a schema-7 snapshot; this one is schema ${source.schemaVersion}`);
  const newer = labelled(source).find((item) => Number.isInteger(item?.schemaVersion) && item.schemaVersion > 7);
  if (newer) throw new Error(`A downgrade converts schema-7 data at most; this store holds schema-${newer.schemaVersion} data a newer build wrote`);
}

// A schema-6 rendering of a schema-7 snapshot (§19.3.2 steps 3-4; plan v1.4.4
// PR-21). Pure. What schema 6 cannot represent is left out and named in the
// report -- it is not deleted; it stays in the preservation copy:
//   - the claim-evidence fields and the internal erasureToken, per entity;
//   - an attempt captured with no result class, which a schema-6 reader would
//     classify from its prose, and whatever refers to it;
//   - the journal history, which schema-6 readers cannot replay once it holds
//     schema-7 entries -- the copy starts from one schema-6 baseline instead.
// Every other collection is carried, each schema-6 reader preserving them,
// except those whose reader floor is above schema 6 (BELOW_FLOOR_COLLECTIONS):
// they are left out and counted. The
// authority collections among them are the same grants a backup already
// holds; the report says they were carried.
export function downgradeToSchema6(snapshot, { now = () => new Date().toISOString() } = {}) {
  assertSchema7Source(snapshot);
  const source = structuredClone(snapshot);
  const report = { fromSchemaVersion: 7, toSchemaVersion: 6, removedFields: [], excluded: [], carriedCollections: [], excludedCollections: [], excludedEntryCounts: {}, journal: null };
  const excludedIds = new Set();
  const byId = new Map();
  const convert = (entity) => {
    if (entity.kind === 'attempt' && (entity.captureRef != null || entity.outcomeEvidence != null) && entity.resultClass == null) {
      excludedIds.add(entity.id);
      report.excluded.push({ collection: 'records', id: entity.id, kind: 'attempt', reason: 'captured with no result class: a schema-6 reader would classify it from its prose' });
      return null;
    }
    const fields = SCHEMA_7_FIELDS.filter((field) => Object.hasOwn(entity, field));
    for (const field of fields) delete entity[field];
    if (entity.schemaVersion === 7) entity.schemaVersion = 6;
    if (fields.length) report.removedFields.push({ id: entity.id, kind: entity.kind, fields });
    byId.set(entity.id, entity);
    return entity;
  };
  const records = (source.records ?? []).map(convert).filter(Boolean);
  const facts = (source.facts ?? []).map(convert).filter(Boolean);
  const drop = (...args) => dropReferencing(report, ...args);
  const relations = drop('relations', source.relations ?? [], (item) => excludedIds.has(item.from) || excludedIds.has(item.to), (item) => ({ id: item.id }))
    .map((item) => (item.schemaVersion === 7 ? { ...item, schemaVersion: 6 } : item));
  const reviewSignals = drop('reviewSignals', source.reviewSignals ?? [], (item) => excludedIds.has(item.decisionId), (item) => ({ id: item.id }));
  const idempotency = drop('idempotency', source.idempotency ?? [], (item) => excludedIds.has(item.value?.id), (item) => ({ key: item.key }))
    .map((item) => ({ key: item.key, value: structuredClone(byId.get(item.value?.id) ?? item.value) }));
  const events = drop('events', source.events ?? [], (item) => [item.recordId, item.factId, item.relationId].some((id) => excludedIds.has(id)), (item) => ({ id: item.id }));
  const journal = source.journal ?? [];
  const byType = {};
  for (const entry of journal) byType[entry?.type ?? 'unknown'] = (byType[entry?.type ?? 'unknown'] ?? 0) + 1;
  const seq = (Number.isSafeInteger(source.journalSeq) ? source.journalSeq : 0) + 1;
  report.journal = { replacedEntries: journal.length, byType, baselineSeq: seq };
  const extras = extraCollections(source).filter(([key]) => !BELOW_FLOOR_COLLECTIONS.includes(key));
  report.carriedCollections = extras.map(([key]) => key);
  excludeBelowFloor(source, report);
  return {
    report,
    payload: {
      schemaVersion: 6,
      revision: source.revision ?? 0,
      records, facts, relations, reviewSignals, idempotency, events,
      journal: [{
        id: `jentry_downgrade_${seq}`, seq, type: 'projection.baseline', at: now(), project: null,
        entityKind: null, entityId: null, schemaVersion: 6, derivedFrom: 'downgrade_from_schema_7',
        payload: { records: structuredClone(records), facts: structuredClone(facts), relations: structuredClone(relations), idempotency: structuredClone(idempotency) },
        provenance: { actor: null, client: null, sessionId: null }
      }],
      journalSeq: seq,
      journalEpoch: seq,
      ...Object.fromEntries(extras)
    }
  };
}

// 7 to 6, and on to 5 through 6, with one report.
function downgradeTo(snapshot, toSchemaVersion, options) {
  const six = downgradeToSchema6(snapshot, options);
  if (toSchemaVersion === 6) return six;
  const five = downgradeToSchema5(six.payload, options);
  const removedFields = six.report.removedFields.map((item) => ({ ...item, fields: [...item.fields] }));
  for (const item of five.report.removedFields) {
    const held = removedFields.find((entry) => entry.id === item.id);
    if (held) held.fields.push(...item.fields);
    else removedFields.push(item);
  }
  return {
    payload: five.payload,
    report: {
      ...five.report, fromSchemaVersion: 7, removedFields, excluded: [...six.report.excluded, ...five.report.excluded],
      excludedCollections: [...new Set([...six.report.excludedCollections, ...five.report.excludedCollections])],
      excludedEntryCounts: { ...six.report.excludedEntryCounts, ...five.report.excludedEntryCounts },
      journal: { ...six.report.journal, baselineSeq: five.report.journal.baselineSeq }
    }
  };
}

// A schema-5 rendering of a schema-6 snapshot (§19.3.2 steps 3-4). Pure. What
// schema 5 cannot represent is left out and named in the report -- it is not
// deleted; it stays in the preservation copy:
//   - attribution and originId fields;
//   - unattributed entities, which schema 5 could only place in "default", and
//     whatever refers to them;
//   - memories and facts of the real project "default" that share an identity
//     with legacy data, which schema 5 could only merge into it;
//   - the journal history, which schema-5 readers cannot replay once it holds
//     schema-6 entries -- the copy starts from one schema-5 baseline instead;
//   - collections a schema-5 reader does not know.
// This build converts only what it writes. Data a newer writer produced
// (schema 7, read since plan v1.4.4 PR-20) is refused, never relabelled as 5;
// so is an erasure token, which only schema 7 assigns, whatever it sits on.
const labelled = (source) => [...(source.records ?? []), ...(source.facts ?? []), ...(source.relations ?? []),
  ...(source.idempotency ?? []).map((item) => item?.value), ...(source.journal ?? []).flatMap((entry) => [entry, entry?.payload])];

function assertSchema6Source(source) {
  const items = labelled(source);
  const newer = items.find((item) => Number.isInteger(item?.schemaVersion) && item.schemaVersion > 6);
  if (newer) throw new Error(`A downgrade to schema 5 converts schema-6 data only; this store holds schema-${newer.schemaVersion} data a newer build wrote`);
  if (items.some((item) => item?.erasureToken !== undefined)) throw new Error('A downgrade to schema 5 converts schema-6 data only; this store holds erasure tokens a newer build assigned');
}

export function downgradeToSchema5(snapshot, { now = () => new Date().toISOString() } = {}) {
  assertSchema6Source(snapshot);
  const source = structuredClone(snapshot);
  const report = { fromSchemaVersion: source.schemaVersion, toSchemaVersion: 5, removedFields: [], excluded: [], excludedCollections: [], excludedEntryCounts: {}, journal: null };
  const excludedIds = new Set();
  const byId = new Map();
  // Schema 5 has a single "default". A memory or fact that the real project
  // "default" wrote with the identity of a legacy one -- legacy data being
  // "default" as stored, or stored with no project -- would share its scope
  // there, and two active records in one scope is not valid schema 5. The real
  // project's records of such an identity are left out and named.
  const legacyOwned = (entity) => entity.attribution === 'legacy_ambiguous' || entity.attribution === 'legacy_unattributed'
    || (entity.attribution === undefined && (entity.project ?? 'default') === 'default');
  const identity = (entity) => (entity.kind === 'memory'
    ? JSON.stringify(['memory', entity.scope?.userId ?? null, entity.scope?.agentId ?? null, entity.scope?.runId ?? null, entity.memoryType ?? null, entity.key ?? null])
    : JSON.stringify(['fact', entity.key ?? null]));
  const legacyIdentities = new Set([...(source.records ?? []), ...(source.facts ?? [])]
    .filter((entity) => ['memory', 'fact'].includes(entity.kind) && legacyOwned(entity)).map(identity));
  const convert = (entity) => {
    if (entity.attribution === 'unattributed') {
      excludedIds.add(entity.id);
      for (const alternative of entity.alternatives ?? []) if (alternative?.id) excludedIds.add(alternative.id);
      report.excluded.push({ collection: entity.kind === 'fact' ? 'facts' : 'records', id: entity.id, kind: entity.kind, originId: entity.originId ?? null, reason: 'unattributed: schema 5 has no owner for it but "default"' });
      return null;
    }
    if (entity.attribution === 'project' && entity.project === 'default' && ['memory', 'fact'].includes(entity.kind) && legacyIdentities.has(identity(entity))) {
      excludedIds.add(entity.id);
      report.excluded.push({ collection: entity.kind === 'fact' ? 'facts' : 'records', id: entity.id, kind: entity.kind, project: 'default', reason: 'the real project "default" shares this identity with legacy data: schema 5 cannot keep them apart' });
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
  const drop = (...args) => dropReferencing(report, ...args);
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
  excludeBelowFloor(source, report);
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
export async function downgradeStore({ graph, store, file, storageType = 'json', output, preservationCopy, toSchemaVersion = 5, now }) {
  if (!output) throw new Error('A downgrade needs an output path');
  if (!preservationCopy) throw new Error('A preservation copy needs a destination path');
  if (![5, 6].includes(toSchemaVersion)) throw new Error('A downgrade targets schema 6 or schema 5');
  assertSchema7Source(privilegedSnapshot(graph));
  const reportPath = `${output}.report.json`;
  // Four files with four jobs, told apart before anything is written: the
  // report must never land on the preservation copy it vouches for (§19.3.2
  // step 3), and nothing lands on the store or the output. A SQLite database
  // also owns the side files SQLite writes next to it. An alias no path
  // reveals (a different letter case on a volume that ignores case) is still
  // caught: the report and the output are created only where nothing exists,
  // after the preservation copy, so they fail rather than write over it.
  const sidecars = (path) => (storageType === 'sqlite' ? [`${path}-wal`, `${path}-shm`, `${path}-journal`] : []);
  const roles = [
    ['the store it converts', [file, ...sidecars(file)]],
    ['the downgraded output', [output, ...sidecars(output)]],
    ['the preservation copy', [preservationCopy]],
    ['the conversion report', [reportPath]]
  ];
  const canonical = await Promise.all(roles.map(async ([role, paths]) => [role, await Promise.all(paths.map(canonicalPath))]));
  for (const [index, [role, paths]] of canonical.entries()) {
    for (const [otherRole, otherPaths] of canonical.slice(index + 1)) {
      if (paths.some((path) => otherPaths.includes(path))) throw new Error(`A downgrade needs distinct files: ${role} and ${otherRole} would be the same file`);
    }
  }
  if (await exists(output)) throw new Error(`Refusing to overwrite an existing file with a downgrade: ${output}`);
  if (await exists(reportPath)) throw new Error(`Refusing to overwrite an existing report: ${reportPath}`);
  const preservation = await writePreservationCopy({ store, file, storageType, destination: preservationCopy });
  await writeFile(reportPath, `${JSON.stringify({ status: 'converting', preservationCopy: preservation }, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  if (await exists(output)) throw new Error(`Refusing to overwrite an existing file with a downgrade: ${output}`);
  const { payload, report } = downgradeTo(privilegedSnapshot(graph), toSchemaVersion, { now });
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
  if (await sha256(preservation.path) !== preservation.sha256) throw new Error('The preservation copy no longer matches the hash it was verified with');
  const result = { status: 'complete', preservationCopy: preservation, output, outputSha256: await sha256(output), ...report, note: 'Everything listed as removed or excluded is intact in the preservation copy; nothing was deleted, and the current-format store was not changed.' };
  await writeFile(reportPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  return { ...result, report: reportPath };
}
