// ShadowGraph journal replay — see docs/handoffs/journal-contract.md.
//
// This module is PURE. It must never touch the clock, the filesystem, randomness,
// or re-execute domain logic. Rebuild is a FOLD over complete post-operation
// snapshots, which is what makes it deterministic and what stops a replay from
// re-deriving trust (a command-replay design could mint `verified` through future
// code paths — see ADR-0001 D4/D14).

import { effectiveFactExpirationBoundary, factValidityPolicyIssue, isValidIsoInstant } from './fact-validity.js';

export const JOURNAL_SCHEMA_VERSION = 5;
export const INVALID_BASELINE_PLACEMENT_CODE = 'invalid_projection_baseline_placement';
export const NONCANONICAL_SCHEMA5_PURGE_ARTIFACT_CODE = 'noncanonical_schema5_purge_artifact';

const PURGE_SKELETON_FIELDS = new Set([
  'id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId',
  'schemaVersion', 'payload', 'replayable', 'originalType',
  'redacted', 'redactedReason', 'provenance'
]);
const PURGE_MARKER_FIELDS = new Set([
  'id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId',
  'schemaVersion', 'payload', 'provenance'
]);
const PURGE_MARKER_PAYLOAD_FIELDS = new Set([
  'project', 'mode', 'removed', 'removedJournalSequences'
]);

// Entry types that carry a replayable payload. Every one of these is produced by
// real code in src/shadowgraph.js — no aspirational types are listed here.
export const REPLAYABLE_ENTRY_TYPES = Object.freeze([
  'projection.baseline',
  'decision.recorded',
  'decision.status_changed',
  'decision.superseded',
  'decision.aged',
  'decision.staled',
  'attempt.recorded',
  'memory.recorded',
  'memory.indexed',
  'memory.superseded',
  'memory.invalidated',
  'fact.observed',
  'fact.verified',
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

export const JOURNAL_TYPE_ENTITY_KIND = Object.freeze({
  'decision.recorded': 'decision', 'decision.status_changed': 'decision',
  'decision.superseded': 'decision', 'decision.aged': 'decision', 'decision.staled': 'decision',
  'attempt.recorded': 'attempt',
  'fact.observed': 'fact', 'fact.verified': 'fact', 'fact.superseded': 'fact', 'fact.expired': 'fact',
  'outcome.recorded': 'decision', 'confidence.changed': 'decision',
  'relation.created': 'relation',
  'memory.recorded': 'memory', 'memory.indexed': 'memory',
  'memory.superseded': 'memory', 'memory.invalidated': 'memory',
  'project.purged': 'project'
});

const KIND_TO_COLLECTION = Object.freeze({
  decision: 'records',
  attempt: 'records',
  memory: 'records',
  fact: 'facts',
  relation: 'relations'
});

/**
 * Return the canonicality problem for a current-schema purge artifact, or null.
 *
 * Payload-null replayable entries are purge skeletons regardless of a caller's
 * replayability flag. Current markers and skeletons must not retain identities
 * outside their explicit allowlists. Schemas 1-4 stay outside this validator so
 * their raw purge artifacts remain available to the migration boundary.
 * `sourceSchemaVersion` lets envelope validators apply schema-5 rules when an
 * entry omitted its own version; pure journal replay intentionally has no such
 * envelope and validates entries that declare schema 5 directly.
 */
export function schema5PurgeArtifactIssue(entry, sourceSchemaVersion = undefined) {
  const entrySchemaVersion = Number.isInteger(entry?.schemaVersion) ? entry.schemaVersion : sourceSchemaVersion;
  const currentEnvelope = sourceSchemaVersion === JOURNAL_SCHEMA_VERSION;
  if ((!currentEnvelope && entrySchemaVersion !== JOURNAL_SCHEMA_VERSION) || !entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const canonicalNullProvenance = (value) => value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 3
    && value.actor === null
    && value.client === null
    && value.sessionId === null;
  const nonEmptyString = (value) => typeof value === 'string' && Boolean(value.trim());

  const replayableType = REPLAYABLE_ENTRY_TYPES.includes(entry.type);
  if (replayableType && entry.replayable === false) {
    return 'marked_non_replayable: replayable journal type cannot set replayable false';
  }
  const hasPurgeReason = Object.hasOwn(entry, 'redactedReason');
  const replayablePayloadNullSkeleton = entry.payload === null && replayableType;
  const isPurgeSkeleton = entry.redacted === true || hasPurgeReason || replayablePayloadNullSkeleton;

  if (isPurgeSkeleton) {
    if (entry.redacted !== true) return 'purge skeleton must set redacted true';
    const forbidden = Object.keys(entry).find((name) => !PURGE_SKELETON_FIELDS.has(name));
    if (forbidden) return `redacted purge skeleton contains forbidden identity field ${forbidden}`;
    if (entry.entityId !== null || entry.payload !== null) return 'redacted purge skeleton must erase entityId and payload';
    if (!canonicalNullProvenance(entry.provenance)) return 'redacted purge skeleton must erase provenance identity';
    const allowedReasons = entrySchemaVersion === JOURNAL_SCHEMA_VERSION
      ? ['project_purged']
      : ['project_purged', 'legacy_project_purged'];
    if (!allowedReasons.includes(entry.redactedReason)) return 'redacted purge skeleton has a noncanonical redactedReason';
    return null;
  }

  if (entry.type !== 'project.purged') return null;
  const forbidden = Object.keys(entry).find((name) => !PURGE_MARKER_FIELDS.has(name));
  if (forbidden) return `purge marker contains forbidden identity field ${forbidden}`;
  if (!nonEmptyString(entry.id)) return 'purge marker id must be a non-empty string';
  if (!Number.isSafeInteger(entry.seq) || entry.seq <= 0) return 'purge marker seq must be a positive safe integer';
  if (entry.entityKind !== 'project' || entry.entityId !== null) return 'purge marker must use project kind and erase entityId';
  if (!canonicalNullProvenance(entry.provenance)) return 'purge marker must erase provenance identity';
  if (!entry.payload || typeof entry.payload !== 'object' || Array.isArray(entry.payload)) return 'purge marker payload must be an object';
  const forbiddenPayload = Object.keys(entry.payload).find((name) => !PURGE_MARKER_PAYLOAD_FIELDS.has(name));
  if (forbiddenPayload) return `purge marker contains forbidden payload field ${forbiddenPayload}`;
  if (!nonEmptyString(entry.project)) return 'purge marker project must be a non-empty string';
  if (!nonEmptyString(entry.payload.project)) return 'purge marker payload.project must be a non-empty string';
  if (entry.project !== entry.payload.project) return 'purge marker project must equal payload.project';
  if (!['logical', 'hard'].includes(entry.payload.mode)) return 'purge marker mode must be exactly logical or hard';
  if (!Number.isSafeInteger(entry.payload.removed) || entry.payload.removed < 0) return 'purge marker removed must be a non-negative safe integer';
  if (!Object.hasOwn(entry.payload, 'removedJournalSequences') || !Array.isArray(entry.payload.removedJournalSequences)) {
    return 'purge marker removedJournalSequences must be present and be an array';
  }
  let previousSequence = 0;
  const seenSequences = new Set();
  for (const sequence of entry.payload.removedJournalSequences) {
    if (!Number.isSafeInteger(sequence) || sequence <= 0) return 'purge marker removedJournalSequences must contain positive safe integers';
    if (seenSequences.has(sequence)) return 'purge marker has duplicate removedJournalSequences; values must be strictly increasing and unique';
    if (sequence < previousSequence) return 'purge marker removedJournalSequences must be strictly increasing and unique';
    seenSequences.add(sequence);
    previousSequence = sequence;
  }
  if (entry.payload.mode === 'logical' && entry.payload.removedJournalSequences.length) {
    return 'logical purge marker must use an empty removedJournalSequences array';
  }
  if (entry.payload.mode === 'hard' && entry.payload.removedJournalSequences.some((sequence) => sequence >= entry.seq)) {
    return 'hard purge marker removedJournalSequences must be strictly earlier than marker sequence';
  }
  return null;
}

export function journalEntryPostconditionIssue(entry) {
  if (!entry || entry.redacted === true || entry.payload === null) return null;
  if (!['fact.verified', 'fact.expired', 'fact.superseded'].includes(entry.type)) return null;
  const fact = entry.payload;
  if (!fact || typeof fact !== 'object' || Array.isArray(fact) || fact.kind !== 'fact') return `${entry.type} requires a fact payload`;
  if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion >= 5) {
    const validityIssue = factValidityPolicyIssue(fact, { required: true });
    if (validityIssue) return `${entry.type} has invalid fact validity: ${validityIssue}`;
  }
  if (entry.type === 'fact.verified') {
    if (fact.status !== 'active' || fact.verificationStatus !== 'verified' || !fact.verification || typeof fact.verification !== 'object') {
      return 'fact.verified requires an active, verified fact with an attestation';
    }
    if (fact.temporal?.invalidatedAt != null) return 'fact.verified cannot carry an invalidated active fact';
  }
  if (entry.type === 'fact.expired') {
    if (fact.status !== 'expired' || fact.verificationStatus !== 'expired') return 'fact.expired requires expired status and verificationStatus';
    if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion >= 4) {
      const expirationBoundary = effectiveFactExpirationBoundary(fact);
      if (!expirationBoundary || !isValidIsoInstant(fact.temporal?.validTo) || !isValidIsoInstant(fact.temporal?.invalidatedAt)) return 'fact.expired requires effective expiration and invalidation boundaries';
      if (Date.parse(fact.temporal.validTo) > Date.parse(expirationBoundary)) return 'fact.expired validTo cannot exceed its effective expiration boundary';
      if (Date.parse(fact.temporal.invalidatedAt) < Date.parse(expirationBoundary)) return 'fact.expired invalidatedAt cannot precede its effective expiration boundary';
    }
  }
  if (entry.type === 'fact.superseded') {
    if (fact.status !== 'superseded' || typeof fact.supersededBy !== 'string' || !fact.supersededBy || fact.supersededBy === fact.id) {
      return 'fact.superseded requires a distinct superseding fact id';
    }
    if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion >= 4 && (!fact.temporal?.validTo || !fact.temporal?.invalidatedAt)) {
      return 'fact.superseded requires validity narrowing and invalidation boundaries';
    }
  }
  return null;
}

/**
 * Validate each fact's lifecycle as an ordered state machine. Per-entry shape
 * checks are insufficient: a forged second `fact.verified` snapshot is locally
 * valid while still resurrecting a terminal fact or rewriting verified history.
 */
export function journalFactLifecycleIssues(entries = [], options = {}) {
  const epoch = Number.isInteger(options.journalEpoch) ? options.journalEpoch : null;
  const sourceSchemaVersion = options.sourceSchemaVersion;
  const ordered = [...(Array.isArray(entries) ? entries : [])]
    .filter((entry) => Number.isSafeInteger(entry?.seq)
      && (epoch === null || entry.seq >= epoch)
      && schema5PurgeArtifactIssue(entry, sourceSchemaVersion) === null)
    .sort((left, right) => left.seq - right.seq);
  const states = new Map();
  const issues = [];
  const fail = (entry, detail) => issues.push({
    seq: entry.seq, type: entry.type, entityId: entry.entityId ?? entry.payload?.id ?? null, detail
  });

  for (const entry of ordered) {
    if (entry.redacted === true || entry.payload === null) continue;
    if (entry.type === 'projection.baseline') {
      // Canonical baselines begin with an empty state map. A narrowly accepted
      // migration-extension baseline is additive: retaining this map is the proof
      // that prior terminal lifecycle cannot be forgotten or reset.
      for (const fact of entry.payload?.facts ?? []) {
        if (!fact?.id) continue;
        states.set(fact.id, {
          project: fact.project ?? null,
          phase: ['expired', 'superseded'].includes(fact.status) ? 'terminal' : 'active',
          terminalType: ['expired', 'superseded'].includes(fact.status) ? fact.status : null,
          verified: fact.verificationStatus === 'verified' && Boolean(fact.verification)
        });
      }
      continue;
    }
    if (entry.type === 'project.purged') {
      const project = entry.payload?.project ?? entry.project;
      for (const [factId, state] of states) if (state.project === project) states.delete(factId);
      continue;
    }
    if (!['fact.observed', 'fact.verified', 'fact.expired', 'fact.superseded'].includes(entry.type)) continue;
    const factId = entry.entityId ?? entry.payload?.id;
    if (!factId) continue;
    const state = states.get(factId);

    if (entry.type === 'fact.observed') {
      if (state) { fail(entry, 'fact.observed cannot rewrite an existing fact lifecycle'); continue; }
      if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion >= 5 && entry.payload?.status !== 'active') {
        fail(entry, 'schema-5 fact.observed must begin in the active lifecycle state');
        continue;
      }
      states.set(factId, {
        project: entry.project ?? entry.payload?.project ?? null,
        phase: ['expired', 'superseded'].includes(entry.payload?.status) ? 'terminal' : 'active',
        terminalType: ['expired', 'superseded'].includes(entry.payload?.status) ? entry.payload.status : null,
        verified: entry.payload?.verificationStatus === 'verified' && Boolean(entry.payload?.verification)
      });
      continue;
    }

    if (!state) {
      fail(entry, `${entry.type} requires a preceding fact.observed or projection baseline`);
      continue;
    }
    if (entry.type === 'fact.verified') {
      if (state.phase === 'terminal') {
        fail(entry, `terminal ${state.terminalType} fact cannot transition back to active verified`);
        continue;
      }
      if (state.verified) {
        fail(entry, 'duplicate or rewritten fact.verified transition is not monotonic');
        continue;
      }
      state.verified = true;
      continue;
    }
    if (state.phase === 'terminal') {
      fail(entry, `terminal ${state.terminalType} fact cannot transition again through ${entry.type}`);
      continue;
    }
    state.phase = 'terminal';
    state.terminalType = entry.type === 'fact.expired' ? 'expired' : 'superseded';
  }
  return issues;
}

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
 * A replay baseline is a boundary, never an in-stream mutation. Allowing one
 * after ordinary entries lets its complete snapshots overwrite terminal history
 * while the lifecycle validator forgets everything that preceded it. A baseline
 * is therefore unique, first in replay order, and (when declared) owns the epoch.
 */
export function journalBaselinePlacementIssues(entries = [], options = {}) {
  const all = Array.isArray(entries) ? entries : [];
  const epoch = Number.isSafeInteger(options.journalEpoch) && options.journalEpoch > 0
    ? options.journalEpoch
    : null;
  const sourceSchemaVersion = options.sourceSchemaVersion;
  const replayable = all
    .filter((entry) => Number.isSafeInteger(entry?.seq)
      && entry.seq > 0
      && entry.replayable !== false
      && REPLAYABLE_ENTRY_TYPES.includes(entry.type)
      && schema5PurgeArtifactIssue(entry, sourceSchemaVersion) === null)
    .sort((left, right) => left.seq - right.seq);
  const baselines = replayable.filter((entry) => entry.type === 'projection.baseline');
  if (!baselines.length) return [];

  const issues = [];
  const firstReplayableSequence = replayable[0]?.seq ?? null;
  const currentEntities = new Map();
  const historicalEntities = new Map();
  const currentIdempotency = new Map();
  let priorReplayableEntries = 0;
  const stable = (value) => {
    if (Array.isArray(value)) return value.map(stable);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  };
  const same = (left, right) => JSON.stringify(stable(left)) === JSON.stringify(stable(right));
  const putEntity = (item, collection, project) => {
    if (!item?.id) return;
    const value = { entity: item, collection, project: item.project ?? project ?? null };
    currentEntities.set(item.id, value);
    historicalEntities.set(item.id, value);
  };
  const push = (entry, placement, detail) => issues.push({
    code: INVALID_BASELINE_PLACEMENT_CODE,
    seq: entry.seq,
    type: entry.type,
    placement,
    detail
  });
  const migrationExtensionProblem = (entry) => {
    let addsNewState = false;
    for (const collection of ['records', 'facts', 'relations']) {
      for (const item of entry.payload?.[collection] ?? []) {
        if (!item?.id) continue;
        const historical = historicalEntities.get(item.id);
        const current = currentEntities.get(item.id);
        if (historical && !current) return `migration baseline would resurrect previously removed entity ${item.id}`;
        if (current && !same(current.entity, item)) {
          if (current.collection === 'facts' && ['expired', 'superseded'].includes(current.entity?.status)) {
            return `migration baseline would rewrite terminal ${current.entity.status} fact ${item.id}`;
          }
          return `migration baseline would rewrite existing ${current.collection.slice(0, -1)} ${item.id}`;
        }
        if (!historical) addsNewState = true;
      }
    }
    for (const item of entry.payload?.idempotency ?? []) {
      if (!item?.key) continue;
      const canonicalEntity = item.value?.id ? currentEntities.get(item.value.id)?.entity : null;
      const previous = canonicalEntity ?? currentIdempotency.get(item.key);
      if (previous && !same(previous, item.value)) return `migration baseline would rewrite idempotency key ${item.key}`;
      if (!previous) addsNewState = true;
    }
    return addsNewState ? null : 'migration baseline does not add any previously unseen projection state';
  };

  for (const entry of replayable) {
    if (entry.type === 'project.purged') {
      const project = entry.payload?.project ?? entry.project;
      const purgedIds = new Set(entry.payload?.purgedEntityIds ?? []);
      for (const [entityId, value] of currentEntities) if (value.project === project || value.entity?.project === project) purgedIds.add(entityId);
      for (const [entityId, value] of [...currentEntities]) {
        if (value.collection !== 'relations' && (purgedIds.has(entityId) || value.project === project || value.entity?.project === project)) currentEntities.delete(entityId);
      }
      for (const [entityId, value] of [...currentEntities]) {
        if (value.collection === 'relations' && (value.project === project || purgedIds.has(value.entity?.from) || purgedIds.has(value.entity?.to))) currentEntities.delete(entityId);
      }
      for (const [key, value] of [...currentIdempotency]) if (value?.project === project || purgedIds.has(value?.id)) currentIdempotency.delete(key);
      priorReplayableEntries += 1;
      continue;
    }
    if (entry.redacted === true || entry.payload === null) {
      if (entry.entityId) currentEntities.delete(entry.entityId);
      priorReplayableEntries += 1;
      continue;
    }
    if (entry.type === 'projection.baseline') {
      const baselineIndex = baselines.indexOf(entry);
      if (baselineIndex > 0) {
        push(entry, 'duplicate', `projection.baseline at sequence ${entry.seq} duplicates the baseline at sequence ${baselines[0].seq}`);
      } else {
        const canonicalPlacement = entry.seq === firstReplayableSequence && (epoch === null || entry.seq === epoch);
        // Schemas 1–3 could retain a leading sequence gap without the later hard-
        // purge ledger. The first surviving legacy migration baseline is safe: no
        // replayable state precedes it, so there is no lifecycle for it to reset.
        const legacyFirstSurvivor = entry.schemaVersion <= 3
          && entry.seq === firstReplayableSequence
          && (epoch === null || entry.seq >= epoch);
        const migrationMarker = entry.derivedFrom === 'live_state_at_migration' || entry.schemaVersion <= 3;
        const extensionProblem = migrationMarker && priorReplayableEntries > 0
          ? migrationExtensionProblem(entry)
          : 'baseline is not a monotonic migration extension';
        const monotonicMigrationExtension = migrationMarker && priorReplayableEntries > 0 && (
          extensionProblem === null
          || (entry.schemaVersion <= 3 && extensionProblem === 'migration baseline does not add any previously unseen projection state')
        );

        if (!canonicalPlacement && !legacyFirstSurvivor && !monotonicMigrationExtension) {
          if (epoch !== null && entry.seq < epoch) {
            push(entry, 'rewind', `projection.baseline sequence ${entry.seq} precedes declared journalEpoch ${epoch}`);
          } else if (epoch !== null && entry.seq > epoch) {
            push(entry, 'wrong_epoch', `projection.baseline sequence ${entry.seq} does not equal declared journalEpoch ${epoch}`);
          }
          if (entry.seq !== firstReplayableSequence) {
            push(entry, 'midstream', `projection.baseline sequence ${entry.seq} is not the first replayable sequence ${firstReplayableSequence}`);
          }
          const terminalMatch = /terminal (expired|superseded) fact/.exec(extensionProblem);
          if (terminalMatch) push(entry, 'after_terminal', extensionProblem);
          else if (migrationMarker) push(entry, 'migration_rewrite', extensionProblem);
        }
      }
      for (const collection of ['records', 'facts', 'relations']) {
        for (const item of entry.payload?.[collection] ?? []) putEntity(item, collection, item?.project ?? null);
      }
      for (const item of entry.payload?.idempotency ?? []) if (item?.key) currentIdempotency.set(item.key, item.value);
      priorReplayableEntries += 1;
      continue;
    }
    const collection = KIND_TO_COLLECTION[entry.entityKind];
    if (collection && entry.entityId && entry.payload && typeof entry.payload === 'object') {
      putEntity(entry.payload, collection, entry.project);
      if (entry.idempotencyKey) currentIdempotency.set(entry.idempotencyKey, entry.payload);
    }
    priorReplayableEntries += 1;
  }
  return issues;
}

export function assertJournalBaselinePlacement(entries = [], options = {}) {
  const issues = journalBaselinePlacementIssues(entries, options);
  if (issues.length) {
    const error = new Error(`Invalid projection baseline placement (${INVALID_BASELINE_PLACEMENT_CODE}): ${issues[0].detail}`);
    error.code = INVALID_BASELINE_PLACEMENT_CODE;
    error.issues = issues;
    throw error;
  }
  return { valid: true, issues: [] };
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

function hardPurgeMarkerRelationshipIssues(entries = [], options = {}) {
  const sourceSchemaVersion = options.sourceSchemaVersion;
  const report = hardPurgeGapLedgerReport(entries, options);
  const issuesByMarkerSequence = new Map();
  for (const issue of report.issues) {
    if (Number.isSafeInteger(issue.markerSeq) && !issuesByMarkerSequence.has(issue.markerSeq)) {
      issuesByMarkerSequence.set(issue.markerSeq, issue.message);
    }
  }
  if (report.firstUnexplained !== null) {
    for (const marker of entries) {
      const currentSchemaArtifact = sourceSchemaVersion === JOURNAL_SCHEMA_VERSION
        || marker?.schemaVersion === JOURNAL_SCHEMA_VERSION;
      if (!currentSchemaArtifact
        || marker?.type !== 'project.purged'
        || marker?.payload?.mode !== 'hard'
        || !Number.isSafeInteger(marker.seq)
        || marker.seq <= report.firstUnexplained
        || schema5PurgeArtifactIssue(marker, sourceSchemaVersion) !== null
        || issuesByMarkerSequence.has(marker.seq)) continue;
      const unexplained = report.issues.find((issue) => issue.code === 'unexplained_journal_gap');
      issuesByMarkerSequence.set(marker.seq, unexplained?.message
        ?? `hard purge does not explain journal sequence ${report.firstUnexplained}`);
    }
  }
  return issuesByMarkerSequence;
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
  const sourceSchemaVersion = options.sourceSchemaVersion;

  const legacy = [];
  const skipped = [];
  const replayable = [];
  const purgeArtifactIssues = [];
  const hardPurgeRelationshipIssues = hardPurgeMarkerRelationshipIssues(all, {
    journalEpoch,
    sourceSchemaVersion
  });

  for (const entry of all) {
    if (!entry || typeof entry !== 'object') {
      skipped.push({ seq: null, type: null, why: 'not_an_object' });
      continue;
    }
    if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion > JOURNAL_SCHEMA_VERSION) {
      skipped.push({ seq: entry.seq, type: entry.type, why: 'unsupported_schema_version' });
      continue;
    }
    const purgeArtifactIssue = schema5PurgeArtifactIssue(entry, sourceSchemaVersion)
      ?? hardPurgeRelationshipIssues.get(entry.seq)
      ?? null;
    if (purgeArtifactIssue) {
      const issue = {
        seq: entry.seq ?? null,
        type: entry.type ?? null,
        why: NONCANONICAL_SCHEMA5_PURGE_ARTIFACT_CODE,
        detail: purgeArtifactIssue
      };
      skipped.push(issue);
      purgeArtifactIssues.push(issue);
      continue;
    }
    if (!Number.isInteger(entry.seq)) {
      // Pre-journal metadata-only event: no payload exists, so it can never be
      // replayed. Recorded honestly instead of being silently dropped.
      legacy.push({ id: entry.id ?? null, type: entry.type ?? null, why: 'metadata_only_no_seq' });
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
    const expectedEntityKind = JOURNAL_TYPE_ENTITY_KIND[entry.type];
    if (expectedEntityKind && entry.entityKind != null && KIND_TO_COLLECTION[entry.entityKind] && entry.entityKind !== expectedEntityKind) {
      skipped.push({ seq: entry.seq, type: entry.type, why: 'type_entity_kind_mismatch' });
      continue;
    }
    const postconditionIssue = journalEntryPostconditionIssue(entry);
    if (postconditionIssue) {
      skipped.push({ seq: entry.seq, type: entry.type, why: 'type_payload_postcondition_mismatch', detail: postconditionIssue });
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
  const baselinePlacementIssues = journalBaselinePlacementIssues(replayable, {
    journalEpoch: start,
    sourceSchemaVersion
  });
  const invalidBaselineSequences = new Set(baselinePlacementIssues.map((issue) => issue.seq));
  skipped.push(...baselinePlacementIssues.map((issue) => ({
    seq: issue.seq, type: issue.type, why: INVALID_BASELINE_PLACEMENT_CODE,
    placement: issue.placement, detail: issue.detail
  })));
  const lifecycleIssues = journalFactLifecycleIssues(
    inRange.filter((entry) => !invalidBaselineSequences.has(entry.seq)),
    { journalEpoch: start, sourceSchemaVersion }
  );
  const invalidLifecycleSequences = new Set(lifecycleIssues.map((issue) => issue.seq));
  skipped.push(...lifecycleIssues.map((issue) => ({
    seq: issue.seq, type: issue.type, why: 'fact_lifecycle_violation', entityId: issue.entityId, detail: issue.detail
  })));
  const rangeGaps = journalGaps(inRange);
  const invalidEpoch = start !== null && (maxSeq === null || start > maxSeq || (inRange.length > 0 && inRange[0].seq !== start));

  const entities = new Map();
  const idempotency = new Map();
  let applied = 0;

  for (const entry of inRange) {
    if (invalidBaselineSequences.has(entry.seq)) continue;
    if (invalidLifecycleSequences.has(entry.seq)) continue;
    if (entry.type === 'project.purged') {
      const project = entry.payload?.project ?? entry.project;
      // Schema <=5 markers may carry raw purgedEntityIds. They remain readable for
      // compatibility, but new markers need none: collect the project's current
      // entities (including nested alternatives) and remove relations by endpoint.
      const purgedIds = new Set(entry.payload?.purgedEntityIds ?? []);
      for (const [key, value] of entities) {
        if (value.entity?.project !== project && value.project !== project && !purgedIds.has(key)) continue;
        purgedIds.add(key);
        for (const alternative of value.entity?.alternatives ?? []) if (alternative?.id) purgedIds.add(alternative.id);
      }
      for (const [key, value] of [...entities]) {
        if (value.collection !== 'relations' && (value.entity?.project === project || value.project === project || purgedIds.has(key))) entities.delete(key);
      }
      for (const [key, value] of [...entities]) {
        if (value.collection !== 'relations') continue;
        const relation = value.entity;
        if (value.project === project || purgedIds.has(relation?.from) || purgedIds.has(relation?.to)) entities.delete(key);
      }
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
          if (item?.id) entities.set(item.id, { collection, entity: item, project: item.project ?? null });
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
    entities.set(entry.entityId, { collection, entity: entry.payload, project: entry.project ?? entry.payload?.project ?? null });
    if (entry.idempotencyKey) idempotency.set(normalizeIdempotencyKey(entry.idempotencyKey, entry.payload), entry.payload);
    applied += 1;
  }

  const projection = emptyProjection();
  for (const { collection, entity } of entities.values()) {
    if (entity && typeof entity === 'object') projection[collection].push(entity);
  }
  const entityIds = new Set();
  for (const record of projection.records) {
    entityIds.add(record.id);
    for (const alternative of record.alternatives ?? []) if (alternative?.id) entityIds.add(alternative.id);
  }
  for (const fact of projection.facts) entityIds.add(fact.id);
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

  const invalidLifecycleFactIds = new Set(lifecycleIssues.map((issue) => issue.entityId).filter(Boolean));
  projection.facts = projection.facts.map((fact) => invalidLifecycleFactIds.has(fact.id) && fact.verificationStatus === 'verified'
    ? { ...fact, verificationStatus: 'unverified', verificationUntrustedReason: 'journal_lifecycle_invalid' }
    : fact);

  const unsupported = skipped.filter((item) => ['unsupported_schema_version', 'unknown_entry_type', 'missing_payload', 'unmappable_entity', 'type_entity_kind_mismatch', 'type_payload_postcondition_mismatch', 'fact_lifecycle_violation', INVALID_BASELINE_PLACEMENT_CODE, 'marked_non_replayable', NONCANONICAL_SCHEMA5_PURGE_ARTIFACT_CODE, 'dangling_relation'].includes(item.why));
  const crossesEpoch = legacy.length > 0 && (journalEpoch === null || journalEpoch > 0);

  let rebuildable = true;
  let reason = null;
  if (purgeArtifactIssues.length) {
    rebuildable = false;
    reason = 'journal contains noncanonical schema-5 purge artifacts';
  } else if (baselinePlacementIssues.length) {
    rebuildable = false;
    reason = 'journal contains invalid projection baseline placement';
  } else if (invalidEpoch) {
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
  } else if (lifecycleIssues.length) {
    rebuildable = false;
    reason = 'journal contains non-monotonic fact lifecycle transitions';
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

function firstRangeContaining(ranges, value) {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const range = ranges[middle];
    if (value < range.from) high = middle - 1;
    else if (value > range.to) low = middle + 1;
    else return range;
  }
  return null;
}

/**
 * Validate the surviving evidence for hard-purge sequence gaps without ever
 * expanding a gap into an integer range. A marker can explain only missing
 * sequences that precede that marker; present/unrelated sequences are not valid
 * purge evidence, and every actual replay-range gap needs later evidence.
 */
export function hardPurgeGapLedgerReport(entries = [], options = {}) {
  const all = Array.isArray(entries) ? entries : [];
  const epoch = Number.isSafeInteger(options.journalEpoch) && options.journalEpoch > 0
    ? options.journalEpoch
    : null;
  const sourceSchemaVersion = options.sourceSchemaVersion;
  const numbered = all
    .filter((entry) => Number.isSafeInteger(entry?.seq) && entry.seq > 0 && (epoch === null || entry.seq >= epoch))
    .sort((left, right) => left.seq - right.seq);
  const ranges = journalGaps(numbered).map((range) => ({ from: range.from, to: range.to }));
  if (epoch !== null && numbered.length && epoch < numbered[0].seq) {
    ranges.unshift({ from: epoch, to: numbered[0].seq - 1 });
  }

  const issues = [];
  const claims = [];
  const claimedInRange = new Map();
  const hardMarkers = all
    .filter((entry) => entry?.type === 'project.purged'
      && entry?.payload?.mode === 'hard'
      && schema5PurgeArtifactIssue(entry, sourceSchemaVersion) === null)
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));

  for (const marker of hardMarkers) {
    const ledger = marker.payload?.removedJournalSequences;
    if (ledger === undefined) continue;
    if (!Array.isArray(ledger)) {
      issues.push({
        code: 'hard_purge_ledger_not_array', markerSeq: marker.seq ?? null,
        message: `Hard purge marker sequence ${marker.seq ?? 'unknown'} removedJournalSequences must be an array`
      });
      continue;
    }
    const withinMarker = new Set();
    for (const value of ledger) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        issues.push({
          code: 'invalid_hard_purge_ledger_sequence', markerSeq: marker.seq ?? null, ledgerSeq: value,
          message: `Hard purge marker sequence ${marker.seq ?? 'unknown'} removedJournalSequences must contain positive safe integers`
        });
        continue;
      }
      if (withinMarker.has(value)) {
        issues.push({
          code: 'duplicate_hard_purge_ledger_sequence', markerSeq: marker.seq ?? null, ledgerSeq: value,
          message: `Hard purge marker sequence ${marker.seq ?? 'unknown'} has duplicate removedJournalSequences value ${value}`
        });
        continue;
      }
      withinMarker.add(value);
      if (!Number.isSafeInteger(marker.seq) || marker.seq <= value) {
        issues.push({
          code: 'noncausal_hard_purge_ledger_sequence', markerSeq: marker.seq ?? null, ledgerSeq: value,
          message: `Hard purge ledger sequence ${value} must be strictly earlier than its surviving marker sequence ${marker.seq ?? 'unknown'}`
        });
        continue;
      }
      // Evidence older than the declared replay epoch is historical and does not
      // authorize a current gap. Preserve it, but never count it toward coverage.
      if (epoch !== null && value < epoch) continue;
      const range = firstRangeContaining(ranges, value);
      if (!range) {
        issues.push({
          code: 'unrelated_hard_purge_ledger_sequence', markerSeq: marker.seq, ledgerSeq: value,
          message: `Hard purge ledger sequence ${value} is not an actual missing journal sequence`
        });
        continue;
      }
      if (claimedInRange.has(value)) {
        issues.push({
          code: 'multiply_claimed_hard_purge_ledger_sequence', markerSeq: marker.seq, ledgerSeq: value,
          previousMarkerSeq: claimedInRange.get(value),
          message: `Hard purge ledger sequence ${value} is claimed by more than one surviving marker`
        });
        continue;
      }
      claimedInRange.set(value, marker.seq);
      claims.push(value);
    }
  }

  claims.sort((left, right) => left - right);
  let claimIndex = 0;
  let firstUnexplained = null;
  for (const range of ranges) {
    while (claimIndex < claims.length && claims[claimIndex] < range.from) claimIndex += 1;
    let cursor = range.from;
    while (claimIndex < claims.length && claims[claimIndex] <= range.to) {
      const claim = claims[claimIndex];
      if (claim > cursor) break;
      if (claim === cursor) cursor += 1;
      claimIndex += 1;
    }
    if (cursor <= range.to) {
      firstUnexplained = cursor;
      issues.push({
        code: 'unexplained_journal_gap', ledgerSeq: cursor,
        message: `hard purge ledger cannot cover declared gap; journal contains unexplained sequence gaps; hard purge does not explain journal sequence ${cursor}`
      });
      break;
    }
  }

  return {
    valid: issues.length === 0,
    issues,
    ranges,
    firstUnexplained,
    claims: claims.length
  };
}

export function assertHardPurgeGapLedgers(entries = [], options = {}) {
  const report = hardPurgeGapLedgerReport(entries, options);
  if (!report.valid) {
    const error = new Error(report.issues[0].message);
    error.code = report.issues[0].code;
    error.issues = report.issues;
    throw error;
  }
  return report;
}
