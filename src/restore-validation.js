import { createShadowGraph } from './shadowgraph.js';
import { hardPurgeGapLedgerReport } from './journal.js';

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
  const validation = staging.validate();
  const blocking = validation.issues.filter((issue) => issue.severity === 'error' || issue.severity === 'unsupported');
  if (blocking.length) {
    const codes = [...new Set(blocking.map((issue) => issue.code))].join(', ');
    throw new Error(`Refusing to restore data: ${blocking.length} blocking issue(s) — ${codes}`);
  }

  const live = staging.exportData();
  const rebuild = staging.rebuild();
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
  const rebuilt = normalizedRebuild.exportData();

  for (const key of ['records', 'facts', 'relations', 'idempotency']) {
    if (canonicalCollection(live[key]) !== canonicalCollection(rebuilt[key])) {
      throw new Error(`Refusing to restore data: journal projection does not match live ${key}`);
    }
  }
  return live;
}
