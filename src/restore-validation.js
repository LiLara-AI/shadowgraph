import { createShadowGraph } from './shadowgraph.js';
import { hardPurgeGapLedgerReport } from './journal.js';
import { privilegedRebuild, privilegedSnapshot, privilegedValidate } from './internal/snapshot.js';

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function collectionIdentity(item) {
  return String(item?.id ?? item?.key ?? JSON.stringify(stable(item)));
}

function canonicalCollection(items = []) {
  return JSON.stringify([...items].sort((left, right) => collectionIdentity(left).localeCompare(collectionIdentity(right))).map(stable));
}

export function createRestoreValidator(options = {}) {
  return (payload) => validateRestorePayload(payload, options);
}

// The preservation-only guard remains available to callers that cannot merge
// authority. PR12's restore paths use the narrowing merge; memory-only restore
// still uses this helper to strip both collections before installation.
export const AUTHORITY_COLLECTIONS = Object.freeze(['access', 'accessRevocations']);
export const AUTHORITY_RESTORE_UNSUPPORTED = 'authority_restore_unsupported_at_this_build';
// Beside it, the refusal of a restore that deletion records apply to
// (PR-37a): a presence check, as the authority guard is.
export { PURGE_AWARE_RESTORE_UNSUPPORTED } from './internal/deletion-knowledge.js';

export function guardAuthorityRestore(payload, { memoryOnly = false } = {}) {
  const present = payload && typeof payload === 'object' ? AUTHORITY_COLLECTIONS.filter((key) => Object.hasOwn(payload, key)) : [];
  if (!present.length) return payload;
  if (!memoryOnly) {
    const error = new Error(`Refusing to restore authority collections (${present.join(', ')}): this build preserves them but cannot restore them safely; restore memory only to proceed without them`);
    error.code = AUTHORITY_RESTORE_UNSUPPORTED;
    error.collections = present;
    throw error;
  }
  const memory = { ...payload };
  for (const key of present) delete memory[key];
  return memory;
}

export function requiresLegacyPurgeMigration(payload) {
  const sourceVersion = payload?.schemaVersion;
  if (Number.isInteger(sourceVersion) && sourceVersion >= 5) return false;
  return Array.isArray(payload?.journal) && payload.journal.some((entry) =>
    entry?.type === 'project.purged' && Array.isArray(entry?.payload?.purgedEntityIds)
  );
}

export function validateRestorePayload(payload, options = {}) {
  const staging = createShadowGraph(options);
  staging.importData(payload);
  // The whole store is being restored, so it is checked whole (F-17).
  const validation = privilegedValidate(staging);
  const blocking = validation.issues.filter((issue) => issue.severity === 'error' || issue.severity === 'unsupported');
  if (blocking.length) {
    const codes = [...new Set(blocking.map((issue) => issue.code))].join(', ');
    throw new Error(`Refusing to restore data: ${blocking.length} blocking issue(s) — ${codes}`);
  }

  const live = privilegedSnapshot(staging);
  const rebuild = privilegedRebuild(staging);
  const corruptSkipped = rebuild.skipped;
  if (corruptSkipped.length) {
    const reasons = [...new Set(corruptSkipped.map((entry) => entry.why))].join(', ');
    throw new Error(`Refusing to restore data: journal rebuild contains ${corruptSkipped.length} corrupt or unsupported entry/entries — ${reasons}`);
  }
  if (!rebuild.rebuildable) {
    const internalHardPurgeGap = rebuild.reason === 'journal contains unexplained sequence gaps inside the replay range';
    const leadingHardPurgeGap = rebuild.reason === 'journal epoch is outside the available sequence range'
      && Number.isInteger(rebuild.journalEpoch)
      && Number.isInteger(rebuild.replayedFrom)
      && rebuild.journalEpoch < rebuild.replayedFrom;
    if (!internalHardPurgeGap && !leadingHardPurgeGap) {
      throw new Error(`Refusing to restore data: ${rebuild.reason}`);
    }
    const ledger = hardPurgeGapLedgerReport(live.journal, { journalEpoch: rebuild.journalEpoch });
    if (!ledger.valid) {
      throw new Error(`Refusing to restore data: ${ledger.issues[0].message}`);
    }
  }

  // A supported legacy snapshot is compared after applying the same entity
  // migrations to both sides. Live collections are migrated by importData(); the
  // journal fold intentionally replays stored snapshots verbatim. Comparing those
  // two raw shapes made every journal-bearing schema 1–3 backup unrestorable after
  // a schema bump even when its semantics were intact.
  const normalizedRebuild = createShadowGraph(options);
  normalizedRebuild.importData({
    schemaVersion: Number.isInteger(payload?.schemaVersion) ? payload.schemaVersion : live.schemaVersion,
    records: rebuild.projection.records,
    facts: rebuild.projection.facts,
    relations: rebuild.projection.relations,
    idempotency: rebuild.projection.idempotency
  });
  const rebuilt = privilegedSnapshot(normalizedRebuild);

  for (const key of ['records', 'facts', 'relations', 'idempotency']) {
    if (canonicalCollection(live[key]) !== canonicalCollection(rebuilt[key])) {
      throw new Error(`Refusing to restore data: journal projection does not match live ${key}`);
    }
  }
  return live;
}

// Mandatory validation can never be replaced by an extension. Extensions may
// reject, including under a configured verifier, but cannot transform the
// payload selected for installation or the object later activated in memory.
export async function validateRestoreSnapshot(payload, { validators = [], ...options } = {}) {
  const normalized = validateRestorePayload(payload, options);
  for (const validator of new Set(validators)) {
    if (typeof validator === 'function' && validator !== validateRestorePayload) await validator(structuredClone(payload));
  }
  return requiresLegacyPurgeMigration(payload) ? normalized : payload;
}
