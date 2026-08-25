// ShadowGraph journal replay — see docs/handoffs/journal-contract.md.
//
// This module is PURE. It must never touch the clock, the filesystem, randomness,
// or re-execute domain logic. Rebuild is a FOLD over complete post-operation
// snapshots, which is what makes it deterministic and what stops a replay from
// re-deriving trust (a command-replay design could mint `verified` through future
// code paths — see ADR-0001 D4/D14).

export const JOURNAL_SCHEMA_VERSION = 3;

// Entry types that carry a replayable payload. Every one of these is produced by
// real code in src/shadowgraph.js — no aspirational types are listed here.
export const REPLAYABLE_ENTRY_TYPES = Object.freeze([
  'projection.baseline',
  'decision.recorded',
  'decision.status_changed',
  'decision.superseded',
  'decision.aged',
  'attempt.recorded',
  'fact.observed',
  'fact.superseded',
  'fact.expired',
  'outcome.recorded',
  'confidence.changed',
  'relation.created',
  'project.purged'
]);

// Entry types recorded for audit that intentionally do not mutate a projection.
export const NON_REPLAYABLE_ENTRY_TYPES = Object.freeze(['legacy_metadata_event']);

export const JOURNAL_ENTRY_TYPES = Object.freeze([
  ...REPLAYABLE_ENTRY_TYPES,
  ...NON_REPLAYABLE_ENTRY_TYPES
]);

const KIND_TO_COLLECTION = Object.freeze({
  decision: 'records',
  attempt: 'records',
  fact: 'facts',
  relation: 'relations'
});

function emptyProjection() {
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, records: [], facts: [], relations: [], idempotency: [] };
}

function normalizeIdempotencyKey(key, value) {
  if (typeof key !== 'string') return key;
  const match = /^(decision|attempt|fact):([^:]+)$/.exec(key);
  return match && value?.project ? `${match[1]}:${value.project}:${match[2]}` : key;
}

export function isReplayable(entry) {
  return Number.isInteger(entry?.seq) && entry.replayable !== false && REPLAYABLE_ENTRY_TYPES.includes(entry.type);
}

/**
 * Sequence numbers that appear more than once.
 *
 * A duplicate `seq` makes the fold ORDER-DEPENDENT: two entries claiming the same
 * position cannot be totally ordered, so "last writer wins" would silently depend
 * on array order in the file. That is reported, never guessed at.
 */
export function duplicateSequences(entries = []) {
  const seen = new Map();
  for (const entry of entries) {
    if (!Number.isInteger(entry?.seq)) continue;
    seen.set(entry.seq, (seen.get(entry.seq) ?? 0) + 1);
  }
  return [...seen.entries()].filter(([, count]) => count > 1).map(([seq, count]) => ({ seq, count })).sort((left, right) => left.seq - right.seq);
}

/**
 * Rebuild a projection from journal entries.
 *
 * Returns an explicit report rather than throwing, because a caller must be able
 * to tell "rebuilt everything" from "rebuilt what it could" — silently returning
 * a partial graph is the failure mode this contract exists to prevent.
 */
export function rebuildProjection(entries = [], options = {}) {
  const all = Array.isArray(entries) ? [...entries] : [];
  const journalEpoch = Number.isInteger(options.journalEpoch) ? options.journalEpoch : null;

  const legacy = [];
  const skipped = [];
  const replayable = [];

  for (const entry of all) {
    if (!entry || typeof entry !== 'object') {
      skipped.push({ seq: null, type: null, why: 'not_an_object' });
      continue;
    }
    if (!Number.isInteger(entry.seq)) {
      // Pre-journal metadata-only event: no payload exists, so it can never be
      // replayed. Recorded honestly instead of being silently dropped.
      legacy.push({ id: entry.id ?? null, type: entry.type ?? null, why: 'metadata_only_no_seq' });
      continue;
    }
    if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion > JOURNAL_SCHEMA_VERSION) {
      skipped.push({ seq: entry.seq, type: entry.type, why: 'unsupported_schema_version' });
      continue;
    }
    if (NON_REPLAYABLE_ENTRY_TYPES.includes(entry.type)) {
      legacy.push({ id: entry.id ?? null, type: entry.type, why: 'non_replayable_type' });
      continue;
    }
    if (!REPLAYABLE_ENTRY_TYPES.includes(entry.type)) {
      skipped.push({ seq: entry.seq, type: entry.type ?? null, why: 'unknown_entry_type' });
      continue;
    }
    // A replayable TYPE explicitly flagged `replayable: false` is contradictory
    // data. Replaying it anyway would ignore the flag; dropping it quietly would
    // lose an entity. It is skipped AND reported, so the diagnostic and the
    // rebuildable status agree.
    if (!isReplayable(entry)) {
      skipped.push({ seq: entry.seq, type: entry.type, why: 'marked_non_replayable' });
      continue;
    }
    replayable.push(entry);
  }

  // A duplicate `seq` cannot be totally ordered, so "last writer wins" would
  // depend on file order rather than on the sequence. Detected and declared.
  const duplicates = duplicateSequences(replayable);

  // `seq` is the ordering key. `at` is deliberately NOT used: it is injectable in
  // tests and ties within a millisecond are normal, so it cannot totally order.
  replayable.sort((left, right) => left.seq - right.seq);

  const start = journalEpoch ?? (replayable.length ? replayable[0].seq : null);
  const maxSeq = replayable.length ? replayable[replayable.length - 1].seq : null;
  const inRange = replayable.filter((entry) => start === null || entry.seq >= start);
  const rangeGaps = journalGaps(inRange);
  const invalidEpoch = start !== null && (maxSeq === null || start > maxSeq || (inRange.length > 0 && inRange[0].seq !== start));

  const entities = new Map();
  const idempotency = new Map();
  let applied = 0;

  for (const entry of inRange) {
    if (entry.type === 'project.purged') {
      const project = entry.payload?.project ?? entry.project;
      const purgedIds = new Set(entry.payload?.purgedEntityIds ?? []);
      for (const [key, value] of [...entities]) if (value.entity?.project === project || purgedIds.has(key)) entities.delete(key);
      // P0-1: idempotency payloads are CLONES of purged entities. If a replay
      // rebuilt them, a retry with an old key would hand back deleted content and
      // the purge would be undone by the rebuild.
      for (const [key, value] of [...idempotency]) if (value?.project === project || purgedIds.has(value?.id)) idempotency.delete(key);
      applied += 1;
      continue;
    }
    if (entry.redacted === true || entry.payload === null) {
      // Tombstoned entry: the content is gone by design. Remove the entity so a
      // rebuild after a logical purge does not resurrect purged data.
      if (entry.entityId) {
        entities.delete(entry.entityId);
        for (const [key, value] of [...idempotency]) if (value?.id === entry.entityId) idempotency.delete(key);
      }
      applied += 1;
      continue;
    }
    if (entry.type === 'projection.baseline') {
      for (const collection of ['records', 'facts', 'relations']) {
        for (const item of entry.payload?.[collection] ?? []) {
          if (item?.id) entities.set(item.id, { collection, entity: item });
        }
      }
      for (const item of entry.payload?.idempotency ?? []) if (item?.key) idempotency.set(normalizeIdempotencyKey(item.key, item.value), item.value);
      applied += 1;
      continue;
    }
    const collection = KIND_TO_COLLECTION[entry.entityKind];
    if (!collection || !entry.entityId) {
      skipped.push({ seq: entry.seq, type: entry.type, why: 'unmappable_entity' });
      continue;
    }
    // A MISSING payload (undefined) is malformed data, and is deliberately not
    // treated like a tombstone (payload === null, handled above). Silently
    // dropping it would produce a projection that is short an entity while still
    // reporting rebuildable:true — exactly the "partial graph presented as
    // complete" failure this contract exists to prevent.
    if (entry.payload === undefined || typeof entry.payload !== 'object') {
      skipped.push({ seq: entry.seq, type: entry.type, why: 'missing_payload' });
      continue;
    }
    // Last writer per entity wins. Because every payload is a COMPLETE snapshot,
    // no ordering-sensitive merge is required and a corrupt entry damages one
    // entity rather than poisoning the chain.
    entities.set(entry.entityId, { collection, entity: entry.payload });
    if (entry.idempotencyKey) idempotency.set(normalizeIdempotencyKey(entry.idempotencyKey, entry.payload), entry.payload);
    applied += 1;
  }

  const projection = emptyProjection();
  for (const { collection, entity } of entities.values()) {
    if (entity && typeof entity === 'object') projection[collection].push(entity);
  }
  const entityIds = new Set([...projection.records, ...projection.facts].map((item) => item.id));
  const danglingRelations = projection.relations.filter((relation) => !entityIds.has(relation.from) || !entityIds.has(relation.to));
  if (danglingRelations.length) {
    skipped.push(...danglingRelations.map((relation) => ({ seq: null, type: 'relation.created', why: 'dangling_relation', relationId: relation.id })));
    projection.relations = projection.relations.filter((relation) => entityIds.has(relation.from) && entityIds.has(relation.to));
  }
  for (const collection of ['records', 'facts', 'relations']) {
    projection[collection].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }
  projection.idempotency = [...idempotency.entries()]
    .map(([key, value]) => ({ key, value }))
    .sort((left, right) => left.key.localeCompare(right.key));

  const unsupported = skipped.filter((item) => ['unsupported_schema_version', 'unknown_entry_type', 'missing_payload', 'unmappable_entity', 'marked_non_replayable', 'dangling_relation'].includes(item.why));
  const crossesEpoch = legacy.length > 0 && (journalEpoch === null || journalEpoch > 0);

  let rebuildable = true;
  let reason = null;
  if (invalidEpoch) {
    rebuildable = false;
    reason = 'journal epoch is outside the available sequence range';
  } else if (rangeGaps.length) {
    rebuildable = false;
    reason = 'journal contains unexplained sequence gaps inside the replay range';
  } else if (duplicates.length) {
    // Reported BEFORE unsupported entries: an ambiguous ordering makes the whole
    // fold untrustworthy, not just one entity.
    rebuildable = false;
    reason = `journal contains duplicate sequence numbers (${duplicates.map((item) => item.seq).join(', ')}), so entry order is ambiguous`;
  } else if (unsupported.length) {
    rebuildable = false;
    reason = 'journal contains unsupported or unknown entries inside the replay range';
  } else if (options.requireFullHistory && crossesEpoch) {
    rebuildable = false;
    reason = 'pre-epoch metadata-only entries are not replayable';
  }

  return {
    ok: true,
    rebuildable,
    reason,
    projection,
    journalEpoch: start,
    replayedFrom: inRange.length ? inRange[0].seq : null,
    replayedTo: inRange.length ? inRange[inRange.length - 1].seq : null,
    applied,
    skipped,
    legacy,
    duplicates
  };
}

/** Contiguity report. A hard purge legitimately creates gaps; they are declared, not hidden. */
export function journalGaps(entries = []) {
  const sequences = entries
    .filter((entry) => Number.isInteger(entry?.seq))
    .map((entry) => entry.seq)
    .sort((left, right) => left - right);
  const gaps = [];
  for (let index = 1; index < sequences.length; index += 1) {
    const previous = sequences[index - 1];
    const current = sequences[index];
    if (current > previous + 1) gaps.push({ from: previous + 1, to: current - 1 });
  }
  return gaps;
}
