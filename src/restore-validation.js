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

// R16 rev 2 §7.2. This build carries the authority collections through an
// ordinary save, but it has none of the semantics a safe restore of them needs
// (the narrowing merge arrives with the grant lifecycle), so it refuses to
// restore a backup that contains them. The check is by key name only. A
// memory-only restore strips both keys and restores everything else: memory is
// never withheld because authority could not be restored, and no authority is
// installed that could later be reactivated.
export const AUTHORITY_COLLECTIONS = Object.freeze(['access', 'accessRevocations']);
export const AUTHORITY_RESTORE_UNSUPPORTED = 'authority_restore_unsupported_at_this_build';

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
  guardAuthorityRestore(payload);
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
