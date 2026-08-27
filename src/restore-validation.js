import { createShadowGraph } from './shadowgraph.js';
import { journalGaps } from './journal.js';

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
    const hardPurgeMarkers = live.journal.filter((entry) => entry.type === 'project.purged' && entry.payload?.mode === 'hard');
    const hasHardPurgeMarker = hardPurgeMarkers.length > 0;
    const internalHardPurgeGap = rebuild.reason === 'journal contains unexplained sequence gaps inside the replay range';
    const leadingHardPurgeGap = rebuild.reason === 'journal epoch is outside the available sequence range'
      && Number.isInteger(rebuild.journalEpoch)
      && Number.isInteger(rebuild.replayedFrom)
      && rebuild.journalEpoch < rebuild.replayedFrom;
    if (!hasHardPurgeMarker || (!internalHardPurgeGap && !leadingHardPurgeGap)) {
      throw new Error(`Refusing to restore data: ${rebuild.reason}`);
    }
    const numbered = live.journal.filter((entry) => Number.isSafeInteger(entry.seq) && (!Number.isSafeInteger(rebuild.journalEpoch) || entry.seq >= rebuild.journalEpoch));
    const ranges = journalGaps(numbered).map((gap) => ({ from: gap.from, to: gap.to }));
    if (leadingHardPurgeGap) ranges.push({ from: rebuild.journalEpoch, to: rebuild.replayedFrom - 1 });
    ranges.sort((left, right) => left.from - right.from);
    const explained = [...new Set(hardPurgeMarkers.flatMap((entry) => Array.isArray(entry.payload?.removedJournalSequences)
      ? entry.payload.removedJournalSequences.filter((seq) => Number.isSafeInteger(seq) && seq > 0)
      : []))].sort((left, right) => left - right);
    const totalMissing = ranges.reduce((sum, range) => sum + (range.to - range.from + 1), 0);
    let firstUnexplained = null;
    let explainedIndex = 0;
    for (const range of ranges) {
      while (explainedIndex < explained.length && explained[explainedIndex] < range.from) explainedIndex += 1;
      let cursor = range.from;
      let index = explainedIndex;
      while (index < explained.length && explained[index] <= range.to) {
        if (explained[index] > cursor) break;
        if (explained[index] === cursor) cursor += 1;
        index += 1;
      }
      if (cursor <= range.to) { firstUnexplained = cursor; break; }
      explainedIndex = index;
    }
    if (firstUnexplained !== null) {
      if (totalMissing > 10_000) throw new Error(`Refusing to restore data: hard purge ledger cannot cover declared gap; first unexplained sequence ${firstUnexplained}`);
      throw new Error(`Refusing to restore data: hard purge does not explain journal sequence(s) ${firstUnexplained}`);
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
  return payload;
}
