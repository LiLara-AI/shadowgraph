// ShadowGraph: an explainable, outcome-aware decision graph.
//
// Contracts (docs/handoffs/):
//   provenance-contract.md  — source classes, why nothing can be `verified`
//   lifecycle-contract.md   — the 13 decision statuses and their classification
//   journal-contract.md     — append-oriented journal + rebuildable projections
//   completeness-contract.md— pagination / no-silent-omission on every read path
//   search-contract.md      — content fields vs filters
//   confidence-contract.md  — evidence-weighted bounded confidence

import { assertHardPurgeGapLedgers, assertJournalBaselinePlacement, assertJournalEntrySequence, assertUniqueJournalSequences, rebuildProjection, journalGaps, duplicateSequences, journalBaselinePlacementIssues, journalEntryPostconditionIssue, journalEntrySequenceIssue, journalFactLifecycleIssues, schema5PurgeArtifactIssue, JOURNAL_ENTRY_TYPES, JOURNAL_TYPE_ENTITY_KIND, REPLAYABLE_ENTRY_TYPES } from './journal.js';
import { createConfidence, applyContribution, setOutcomeContribution, computeConfidence, summarizeBasis, CONFIDENCE_POLICY } from './confidence.js';
import { hybridSearch } from './hybrid-search.js';
import { effectiveFactExpirationBoundary, factValidityPolicyIssue, isValidIsoInstant } from './fact-validity.js';
import { createHash } from 'node:crypto';

// PUBLIC API. These vocabularies are part of the supported surface (see
// docs/api-reference.md) and are frozen so a consumer cannot mutate validation
// behaviour at a distance.
export const SCHEMA_VERSION = 5;
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2, 3, 4, 5]);
const GLOBAL_ENTITY_NAMESPACE_SCHEMA_VERSION = 4;

// A source class records WHAT WAS CLAIMED about a fact's origin. It is never proof
// and never by itself grants trust.
export const SOURCE_CLASSES = Object.freeze(['agent_claimed', 'tool_observed', 'human_confirmed', 'production_verified']);
// `verified` is deliberately UNREACHABLE from caller input; `expired` is owned by
// maintain(). See provenance-contract.md §2 and open question U-1.
export const VERIFICATION_STATUSES = Object.freeze(['unverified', 'verified', 'contradicted', 'expired']);

// `status` is an overloaded field name here. These values apply ONLY to decisions.
// Alternatives use `rejected`; facts use active/superseded/expired; review signals
// use open/acknowledged; outcomes use successful/mixed/failed/unknown.
export const DOCUMENTED_DECISION_STATUSES = Object.freeze([
  'proposed', 'planned', 'in_progress', 'executed', 'validated',
  'failed', 'reconsidered', 'superseded', 'abandoned'
]);
// Schema 5 resolves the historical active/proposed and aging/stale overlap.
// `status` is one explicit disposition state machine rather than two axes whose
// combinations could contradict each other. `active` migrates to `proposed`;
// `aging` migrates to system-produced `stale`. `archived` is explicit and
// terminal, distinct from the execution outcome `abandoned`.
export const LEGACY_DECISION_STATUSES = Object.freeze(['active', 'aging']);
export const DECISION_STATUSES = Object.freeze([...DOCUMENTED_DECISION_STATUSES, 'stale', 'archived']);
export const DECISION_TRANSITIONS = Object.freeze({
  proposed: Object.freeze(['planned', 'in_progress', 'abandoned', 'archived']),
  planned: Object.freeze(['in_progress', 'abandoned', 'archived']),
  in_progress: Object.freeze(['executed', 'failed', 'abandoned', 'archived']),
  executed: Object.freeze(['validated', 'failed', 'reconsidered', 'archived']),
  validated: Object.freeze(['reconsidered', 'archived']),
  failed: Object.freeze(['reconsidered', 'abandoned', 'archived']),
  reconsidered: Object.freeze(['planned', 'in_progress', 'abandoned', 'archived']),
  stale: Object.freeze(['reconsidered', 'archived']),
  abandoned: Object.freeze(['archived']),
  superseded: Object.freeze([]),
  archived: Object.freeze([])
});
const CURRENT_DECISION_STATUSES = Object.freeze(['proposed', 'planned', 'in_progress', 'executed', 'validated', 'reconsidered']);

export const OUTCOME_STATUSES = Object.freeze(['successful', 'mixed', 'failed', 'unknown']);
export const MEMORY_TYPES = Object.freeze(['preference', 'profile', 'goal', 'instruction', 'procedure', 'episode', 'note']);
const MEMORY_STATUSES = Object.freeze(['active', 'superseded', 'invalidated']);


// G7: the ONLY fields a free-text query may match. Schema/metadata keys are not
// content, so `search('confidence')` must not match a record that merely has a
// confidence field. See search-contract.md.
export const CONTENT_SEARCH_FIELDS = Object.freeze([
  'title', 'goal', 'chosen', 'assumption', 'evidence', 'alternative',
  'attempt solution', 'attempt result', 'attempt reason', 'environment'
]);
// Structured filters. Matching one of these NEVER counts as a content match.
export const SEARCH_FILTERS = Object.freeze(['project', 'status', 'minConfidence', 'sourceClass', 'kind']);

export const DEFAULT_PAGE_LIMIT = 50;
export const MAX_PAGE_LIMIT = 1000;

const COMMITTED_REJECTION = Symbol('shadowgraph.committedRejection');
export function isCommittedRejection(error) {
  return Boolean(error?.[COMMITTED_REJECTION]);
}

export { rebuildProjection, journalGaps, CONFIDENCE_POLICY };

function assertFiniteJsonNumbers(value, seen = new WeakSet()) {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') throw new Error('Values must be plain JSON data');
  if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('Non-finite numbers are not JSON-serializable');
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  if (!Array.isArray(value)) {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('Values must be plain JSON data');
  }
  seen.add(value);
  for (const child of Array.isArray(value) ? value : Object.values(value)) assertFiniteJsonNumbers(child, seen);
}

function clone(value) {
  assertFiniteJsonNumbers(value);
  return JSON.parse(JSON.stringify(value));
}

// Legacy facts may have no id. Runtime-random ids make the same persisted legacy
// file produce a different graph on every import, which breaks restart parity and
// makes relations/idempotency difficult to audit. Canonicalize the content and
// hash it; an occurrence ordinal keeps duplicate, otherwise-identical legacy
// facts distinct without depending on wall-clock time or randomness.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

const PURGE_SKELETON_FIELDS = new Set([
  'id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId',
  'schemaVersion', 'payload', 'replayable', 'originalType',
  'redacted', 'redactedReason', 'provenance'
]);

const REWRITTEN_BASELINE_ENVELOPE_FIELDS = Object.freeze([
  'id', 'seq', 'type', 'at', 'project', 'entityKind', 'entityId',
  'schemaVersion', 'derivedFrom', 'replayable'
]);

// A baseline that had one of its projection collections rewritten is no longer
// the original audit envelope. Keep only the fields needed to identify, order,
// classify, and replay that boundary; caller/request metadata must not hitch a
// ride on the rewritten snapshot. This is intentionally selective: callers must
// invoke it only after records/facts/relations/idempotency actually changed.
function sanitizeRewrittenBaseline(entry) {
  const payload = entry?.payload ?? {};
  const canonicalEntry = {};
  for (const field of REWRITTEN_BASELINE_ENVELOPE_FIELDS) {
    if (Object.hasOwn(entry, field)) canonicalEntry[field] = entry[field];
  }
  canonicalEntry.payload = {
    records: Array.isArray(payload.records) ? payload.records : [],
    facts: Array.isArray(payload.facts) ? payload.facts : [],
    relations: Array.isArray(payload.relations) ? payload.relations : [],
    idempotency: Array.isArray(payload.idempotency) ? payload.idempotency : []
  };
  canonicalEntry.provenance = { actor: null, client: null, sessionId: null };
  for (const field of Object.keys(entry)) delete entry[field];
  Object.assign(entry, canonicalEntry);
  return entry;
}

function scrubLogicalPurgeSkeleton(entry, reason = 'project_purged') {
  for (const key of Object.keys(entry)) if (!PURGE_SKELETON_FIELDS.has(key)) delete entry[key];
  entry.entityId = null;
  entry.payload = null;
  entry.redacted = true;
  entry.redactedReason = reason;
  entry.provenance = { actor: null, client: null, sessionId: null };
  return entry;
}

function scrubPurgeMarkerIdentity(entry) {
  delete entry.idempotencyKey;
  delete entry.causationId;
  delete entry.transition;
  delete entry.actor;
  delete entry.client;
  delete entry.sessionId;
  delete entry.userId;
  delete entry.agentId;
  delete entry.runId;
  delete entry.requestId;
  entry.entityId = null;
  entry.provenance = { actor: null, client: null, sessionId: null };
}

function factEffectiveExpirationIntervalIssue(fact) {
  const validFrom = fact?.temporal?.validFrom ?? fact?.validFrom ?? fact?.observedAt ?? null;
  const boundary = effectiveFactExpirationBoundary(fact);
  if (validFrom && boundary && compareInstants(boundary, validFrom) < 0) {
    return 'Fact effective expiration boundary must not precede validFrom';
  }
  return null;
}

function filterInPlace(items, keep) {
  const originalLength = items.length;
  let write = 0;
  for (const item of items) if (keep(item)) items[write++] = item;
  items.length = write;
  return items.length !== originalLength;
}

function legacyPurgeMarkerIds(entry) {
  return new Set(Array.isArray(entry?.payload?.purgedEntityIds)
    ? entry.payload.purgedEntityIds.filter((value) => typeof value === 'string' && value)
    : []);
}

function extendLegacyPurgeIds(ids, project, marker, importedJournal, importedRecords, importedFacts) {
  const includeEntity = (item) => {
    if (!item || typeof item !== 'object') return;
    if (!ids.has(item.id) && item.project !== project) return;
    if (typeof item.id === 'string' && item.id) ids.add(item.id);
    for (const alternative of item.alternatives ?? []) {
      if (typeof alternative?.id === 'string' && alternative.id) ids.add(alternative.id);
    }
  };
  for (const item of [...importedRecords, ...importedFacts]) includeEntity(item);
  for (const entry of importedJournal) {
    if (entry === marker) continue;
    if (Number.isSafeInteger(marker.seq) && Number.isSafeInteger(entry?.seq) && entry.seq >= marker.seq) continue;
    if (entry?.type === 'projection.baseline') {
      for (const item of [...(entry.payload?.records ?? []), ...(entry.payload?.facts ?? [])]) includeEntity(item);
    } else {
      includeEntity(entry?.payload);
    }
  }
  return ids;
}

function baselineReferencesPurge(item, ids, project) {
  return ids.has(item?.id) || item?.project === project;
}

function relationReferencesPurge(item, ids, project) {
  return ids.has(item?.id) || ids.has(item?.from) || ids.has(item?.to) || item?.project === project;
}

function journalEntryReferencesPurge(entry, ids, project) {
  if (entry?.project === project || entry?.payload?.project === project) return true;
  if (ids.has(entry?.entityId) || ids.has(entry?.payload?.id)) return true;
  return relationReferencesPurge(entry?.payload, ids, project);
}

function rewriteBaselineForProjectPurge(entry, project, removed, removedRelationIds) {
  if (entry?.type !== 'projection.baseline' || !entry.payload || entry.redacted === true) return false;
  const payload = entry.payload;
  const keep = (value) => value?.project !== project && !removed.has(value?.id);
  const records = (payload.records ?? []).filter(keep);
  const facts = (payload.facts ?? []).filter(keep);
  const relations = (payload.relations ?? []).filter((relation) => (
    !removedRelationIds.has(relation?.id) && !removed.has(relation?.from) && !removed.has(relation?.to)
  ));
  const idempotency = (payload.idempotency ?? []).filter((item) => keep(item?.value));
  const changed = records.length !== (payload.records ?? []).length
    || facts.length !== (payload.facts ?? []).length
    || relations.length !== (payload.relations ?? []).length
    || idempotency.length !== (payload.idempotency ?? []).length;
  if (!changed) return false;
  payload.records = records;
  payload.facts = facts;
  payload.relations = relations;
  payload.idempotency = idempotency;
  sanitizeRewrittenBaseline(entry);
  return true;
}

function journalProjectionSignature(report) {
  return JSON.stringify(canonical(report.projection));
}

// Schemas 1–4 could express a purge only by retaining raw entity ids in the
// marker. Before removing that privacy-sensitive ledger, migrate the referenced
// pre-marker snapshots into payload-free tombstones (and shared baseline members
// out of their collections). The fold before and after is checked here, while both
// forms are still available, so migration cannot silently change projection
// semantics or hard-purge gap evidence.
function migrateLegacyPurgeArtifacts({
  sourceSchemaVersion,
  existingJournal,
  importedJournal,
  importedRecords,
  importedFacts,
  importedRelations,
  importedSignals,
  importedIdempotency,
  importedEvents,
  journalEpoch: candidateJournalEpoch
}) {
  if (Number.isInteger(sourceSchemaVersion) && sourceSchemaVersion >= SCHEMA_VERSION) return;
  const legacyMarkers = importedJournal.filter((entry) => entry?.type === 'project.purged');
  for (const marker of legacyMarkers) {
    scrubPurgeMarkerIdentity(marker);
    if (marker.payload && typeof marker.payload === 'object' && !Array.isArray(marker.payload)
      && !Object.hasOwn(marker.payload, 'removedJournalSequences')) {
      marker.payload.removedJournalSequences = [];
    }
  }
  const markers = legacyMarkers
    .filter((entry) => Array.isArray(entry?.payload?.purgedEntityIds))
    .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
  if (!markers.length) return;

  const originalImportedJournal = clone(importedJournal);
  const beforeJournal = [...clone(existingJournal), ...originalImportedJournal];
  const before = rebuildProjection(beforeJournal, { journalEpoch: candidateJournalEpoch });
  const allLegacyPurgedIds = new Set();
  const allLegacyPurgedProjects = new Set();

  for (const marker of markers) {
    const project = marker.payload?.project ?? marker.project ?? null;
    const ids = extendLegacyPurgeIds(
      legacyPurgeMarkerIds(marker), project, marker,
      importedJournal, importedRecords, importedFacts
    );
    for (const value of ids) allLegacyPurgedIds.add(value);
    if (project !== null) allLegacyPurgedProjects.add(project);
    for (const entry of importedJournal) {
      if (entry === marker) continue;
      if (Number.isSafeInteger(marker.seq) && Number.isSafeInteger(entry?.seq) && entry.seq >= marker.seq) continue;
      if (entry?.type === 'projection.baseline' && entry.payload && typeof entry.payload === 'object') {
        let baselineChanged = false;
        if (filterInPlace(entry.payload.records ?? [], (item) => !baselineReferencesPurge(item, ids, project))) baselineChanged = true;
        if (filterInPlace(entry.payload.facts ?? [], (item) => !baselineReferencesPurge(item, ids, project))) baselineChanged = true;
        if (filterInPlace(entry.payload.relations ?? [], (item) => !relationReferencesPurge(item, ids, project))) baselineChanged = true;
        if (filterInPlace(entry.payload.idempotency ?? [], (item) => !baselineReferencesPurge(item?.value, ids, project))) baselineChanged = true;
        if (baselineChanged) sanitizeRewrittenBaseline(entry);
        continue;
      }
      if (entry?.type === 'project.purged') continue;
      if (journalEntryReferencesPurge(entry, ids, project)) scrubLogicalPurgeSkeleton(entry, 'legacy_project_purged');
    }
    scrubPurgeMarkerIdentity(marker);
    delete marker.payload.purgedEntityIds;
  }

  const afterJournal = [...clone(existingJournal), ...importedJournal];
  const after = rebuildProjection(afterJournal, { journalEpoch: candidateJournalEpoch });
  const beforeGaps = journalGaps(beforeJournal);
  const afterGaps = journalGaps(afterJournal);
  if (
    journalProjectionSignature(before) !== journalProjectionSignature(after)
    || before.rebuildable !== after.rebuildable
    || before.reason !== after.reason
    || before.journalEpoch !== after.journalEpoch
    || before.replayedFrom !== after.replayedFrom
    || before.replayedTo !== after.replayedTo
    || JSON.stringify(beforeGaps) !== JSON.stringify(afterGaps)
  ) {
    throw new Error('Legacy purge migration would change journal projection or gap evidence');
  }

  const survivingIds = new Set([
    ...before.projection.records.map((item) => item.id),
    ...before.projection.facts.map((item) => item.id)
  ]);
  const survivingRelationIds = new Set(before.projection.relations.map((item) => item.id));
  const survivingIdempotencyKeys = new Set(before.projection.idempotency.map((item) => item.key));
  const entityWasPurged = (item) => allLegacyPurgedIds.has(item?.id) || allLegacyPurgedProjects.has(item?.project);
  const relationWasPurged = (item) => allLegacyPurgedIds.has(item?.id)
    || allLegacyPurgedIds.has(item?.from)
    || allLegacyPurgedIds.has(item?.to)
    || allLegacyPurgedProjects.has(item?.project);
  filterInPlace(importedRecords, (item) => !entityWasPurged(item) || survivingIds.has(item.id));
  filterInPlace(importedFacts, (item) => !entityWasPurged(item) || survivingIds.has(item.id));
  filterInPlace(importedRelations, (item) => !relationWasPurged(item) || survivingRelationIds.has(item?.id));
  filterInPlace(importedSignals, (item) => !allLegacyPurgedIds.has(item?.decisionId));
  filterInPlace(importedIdempotency, (item) => !entityWasPurged(item?.value) || survivingIdempotencyKeys.has(item?.key));
  filterInPlace(importedEvents, (item) => {
    if (allLegacyPurgedIds.has(item?.recordId) || allLegacyPurgedIds.has(item?.factId) || allLegacyPurgedIds.has(item?.relationId)) return false;
    return !markers.some((marker) => item?.project === (marker.payload?.project ?? marker.project));
  });
}

function idempotencySemanticEntity(value) {
  if (!value || typeof value !== 'object') return null;
  const common = {
    id: value.id, kind: value.kind, project: value.project ?? 'default',
    actor: value.actor ?? null, client: value.client ?? null, sessionId: value.sessionId ?? null
  };
  if (value.kind === 'fact') return canonical({
    ...common, key: value.key, value: value.value, source: value.source ?? null,
    sourceClass: value.sourceClass ?? null, sourceRaw: value.sourceRaw ?? null,
    confidence: value.confidence ?? null, expiresAt: value.expiresAt ?? null,
    observedAt: value.observedAt ?? null, validityPolicy: value.validityPolicy ?? null,
    temporal: {
      validFrom: value.temporal?.validFrom ?? value.validFrom ?? value.observedAt ?? null,
      recordedAt: value.temporal?.recordedAt ?? value.recordedAt ?? value.observedAt ?? null
    }
  });
  if (value.kind === 'decision') return canonical({
    ...common, title: value.title, goal: value.goal ?? '', chosen: value.chosen,
    assumptions: value.assumptions ?? [], evidence: value.evidence ?? [], alternatives: value.alternatives ?? [],
    failedAttempts: value.failedAttempts ?? [], reviewAfter: value.reviewAfter ?? null,
    createdAt: value.createdAt ?? null,
    confidenceInitial: typeof value.confidence === 'number' ? value.confidence : value.confidence?.initial ?? null
  });
  if (value.kind === 'memory') return canonical({
    ...common, scope: value.scope ?? {}, memoryType: value.memoryType, key: value.key,
    text: value.text, version: value.version ?? 1, metadata: value.metadata ?? {},
    tags: value.tags ?? [], embedding: value.embedding ?? null, sourceClass: value.sourceClass ?? null,
    createdAt: value.createdAt ?? null,
    temporal: {
      validFrom: value.temporal?.validFrom ?? value.createdAt ?? null,
      recordedAt: value.temporal?.recordedAt ?? value.createdAt ?? null
    }
  });
  if (value.kind === 'attempt') {
    const semantic = clone(value);
    delete semantic.schemaVersion;
    return canonical(semantic);
  }
  return canonical(common);
}

function idempotencySemanticallyMatches(left, right) {
  return JSON.stringify(idempotencySemanticEntity(left)) === JSON.stringify(idempotencySemanticEntity(right));
}

function legacyFactId(fact, index, allFacts) {
  const content = { ...fact };
  delete content.id;
  const canonicalContent = JSON.stringify(canonical(content));
  const occurrence = allFacts.slice(0, index).filter((candidate) => {
    const prior = { ...candidate };
    delete prior.id;
    return JSON.stringify(canonical(prior)) === canonicalContent;
  }).length;
  const digest = createHash('sha256').update(JSON.stringify({ content: canonicalContent, occurrence })).digest('hex').slice(0, 20);
  return `fact_${digest}`;
}

function legacyCollisionId(kind, item, index, used) {
  const digest = createHash('sha256').update(JSON.stringify(canonical({ kind, item, index }))).digest('hex').slice(0, 20);
  let candidate = `${kind}_${digest}`;
  let suffix = 1;
  while (used.has(candidate)) candidate = `${kind}_${digest}_${suffix++}`;
  return candidate;
}

// ---------------------------------------------------------------------------
// Pagination helpers (G6). Every multi-result read path goes through these, so
// there is exactly one place where "how much did we omit" is decided.
// ---------------------------------------------------------------------------
function resolvePage(options = {}, total) {
  const rawLimit = options.limit;
  if (rawLimit !== undefined && (!Number.isInteger(rawLimit) || rawLimit < 1 || rawLimit > MAX_PAGE_LIMIT)) {
    throw new Error(`Page limit must be an integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  const rawOffset = options.offset ?? 0;
  if (!Number.isInteger(rawOffset) || rawOffset < 0) throw new Error('Page offset must be a non-negative integer');
  const limit = rawLimit ?? Math.min(Math.max(total, 1), DEFAULT_PAGE_LIMIT);
  return { offset: rawOffset, limit, total, hasMore: rawOffset + limit < total, limitApplied: rawLimit !== undefined };
}

function paginate(items, options, scope, extra = {}) {
  const page = resolvePage(options, items.length);
  const slice = items.slice(page.offset, page.offset + page.limit);
  return {
    items: slice,
    page: { offset: page.offset, limit: page.limit, total: page.total, hasMore: page.hasMore },
    completeness: {
      scope,
      returned: slice.length,
      total: page.total,
      complete: slice.length === page.total,
      omitted: page.total - slice.length,
      losslessItems: true,
      limitSource: page.limitApplied ? 'caller' : 'default',
      ...extra
    }
  };
}

export function createShadowGraph(options = {}) {
  const now = options.now ?? (() => new Date().toISOString());
  const verifier = options.verifier ?? null;
  let transactionContext = null;

  function recordMapChange(map, key) {
    const context = transactionContext;
    if (!context || context.mode !== 'undo') return;
    let keys = context.mapKeys.get(map);
    if (!keys) { keys = new Set(); context.mapKeys.set(map, keys); }
    if (keys.has(key)) return;
    keys.add(key);
    const had = Map.prototype.has.call(map, key);
    const previous = Map.prototype.get.call(map, key);
    context.undo.push(() => {
      if (had) Map.prototype.set.call(map, key, previous);
      else Map.prototype.delete.call(map, key);
    });
  }

  function recordMapClear(map) {
    const context = transactionContext;
    if (!context || context.mode !== 'undo' || map.size === 0) return;
    const entries = [...map];
    context.undo.push(() => {
      Map.prototype.clear.call(map);
      for (const [key, value] of entries) Map.prototype.set.call(map, key, value);
    });
  }

  class TransactionMap extends Map {
    set(key, value) { recordMapChange(this, key); return super.set(key, value); }
    delete(key) { recordMapChange(this, key); return super.delete(key); }
    clear() { recordMapClear(this); return super.clear(); }
  }

  class TransactionArray extends Array {
    static get [Symbol.species]() { return Array; }

    push(...items) {
      const context = transactionContext;
      if (context?.mode === 'undo') {
        const previousLength = this.length;
        context.undo.push(() => { this.length = previousLength; });
      }
      return super.push(...items);
    }
  }

  const records = new TransactionMap();
  const currentMemories = new TransactionMap();
  const facts = new TransactionMap();
  const currentFacts = new TransactionMap();
  const events = new TransactionArray();
  const journal = new TransactionArray();
  const relations = new TransactionMap();
  const reviewSignals = new TransactionMap();
  const idempotency = new TransactionMap();
  let revision = Number.isInteger(options.revision) ? options.revision : 0;
  let journalSeq = 0;
  let journalEpoch = null;
  let activeMutation = null;

  // Destructive whole-graph operations use one structured snapshot. Ordinary
  // writes use the undo log below, cloning only entities they actually modify.
  // Both mechanisms deliberately avoid the JSON write-boundary clone() helper:
  // rollback must remain available when JSON serialization is the failure.
  function captureMutableState() {
    return structuredClone({
      records: [...records],
      currentMemories: [...currentMemories],
      facts: [...facts],
      currentFacts: [...currentFacts],
      events,
      journal,
      relations: [...relations],
      reviewSignals: [...reviewSignals],
      idempotency: [...idempotency],
      revision,
      journalSeq,
      journalEpoch
    });
  }

  function restoreMutableState(snapshot) {
    const restoreMap = (target, entries) => {
      target.clear();
      for (const [key, value] of entries) target.set(key, value);
    };
    restoreMap(records, snapshot.records);
    restoreMap(currentMemories, snapshot.currentMemories);
    restoreMap(facts, snapshot.facts);
    restoreMap(currentFacts, snapshot.currentFacts);
    restoreMap(relations, snapshot.relations);
    restoreMap(reviewSignals, snapshot.reviewSignals);
    restoreMap(idempotency, snapshot.idempotency);
    events.length = 0;
    for (const item of snapshot.events) events.push(item);
    journal.length = 0;
    for (const item of snapshot.journal) journal.push(item);
    revision = snapshot.revision;
    journalSeq = snapshot.journalSeq;
    journalEpoch = snapshot.journalEpoch;
  }

  function touchMutableObject(value) {
    const context = transactionContext;
    if (!context || context.mode !== 'undo' || context.touched.has(value)) return value;
    context.touched.add(value);
    const before = structuredClone(value);
    context.undo.push(() => {
      for (const key of Reflect.ownKeys(value)) delete value[key];
      Object.assign(value, before);
    });
    return value;
  }

  function mutationInProgressError(requested) {
    return new Error(`ShadowGraph mutation already in progress (${activeMutation}); reentrant mutation ${requested} rejected`);
  }

  function committedRejection(error) {
    return { [COMMITTED_REJECTION]: error };
  }

  function transactional(name, operation, { mode = 'undo' } = {}) {
    return function transactionBoundary(...args) {
      if (activeMutation !== null) throw mutationInProgressError(name);
      // Mark the boundary active before capturing rollback state so unexpected
      // stored accessors cannot reenter a mutator during capture.
      activeMutation = name;
      let before = null;
      try {
        if (mode === 'snapshot') before = captureMutableState();
        else if (mode === 'undo') transactionContext = {
          mode: 'undo',
          undo: [],
          mapKeys: new WeakMap(),
          touched: new WeakSet(),
          revision,
          journalSeq,
          journalEpoch
        };
      } catch (error) {
        activeMutation = null;
        throw error;
      }
      const rollback = (error) => {
        try {
          const context = transactionContext;
          transactionContext = null;
          if (before) restoreMutableState(before);
          else if (context?.mode === 'undo') {
            for (let index = context.undo.length - 1; index >= 0; index -= 1) context.undo[index]();
            revision = context.revision;
            journalSeq = context.journalSeq;
            journalEpoch = context.journalEpoch;
          }
        } finally {
          transactionContext = null;
          activeMutation = null;
        }
        throw error;
      };
      try {
        const value = operation(...args);
        if (value && typeof value.then === 'function') {
          return Promise.resolve(value).then(
            (result) => {
              transactionContext = null;
              activeMutation = null;
              // Expiring previously verified trust is a successful lifecycle
              // commit whose legacy public contract is a rejected Promise. Model
              // it as an explicit committed outcome, then reject only after the
              // transaction has closed; real exceptions still take rollback.
              if (result?.[COMMITTED_REJECTION]) {
                const rejection = result[COMMITTED_REJECTION];
                Object.defineProperty(rejection, COMMITTED_REJECTION, { value: true });
                throw rejection;
              }
              return result;
            },
            rollback
          );
        }
        transactionContext = null;
        activeMutation = null;
        return value;
      } catch (error) {
        return rollback(error);
      }
    };
  }

  function setRevision(value) { if (Number.isInteger(value) && value >= revision) revision = value; }
  function assertUnusedEntityId(value, reserved = null) {
    if (typeof value !== 'string' || !value) throw new Error('Entity id must be a non-empty string');
    const alternativeExists = [...records.values()].some((record) => (record.alternatives ?? []).some((alternative) => alternative.id === value));
    if (records.has(value) || facts.has(value) || relations.has(value) || alternativeExists || reserved?.has(value)) {
      throw new Error(`Entity id already exists: ${value}`);
    }
  }

  function id(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // Legacy breadcrumb trail. Kept verbatim for backward compatibility; the journal
  // is the rebuildable record.
  function event(type, payload) {
    const data = clone(payload);
    let project = data.project;
    const refId = data.recordId ?? data.factId;
    if (!project && refId) project = entity(refId)?.project;
    if (!project && data.relationId) {
      const relation = relations.get(data.relationId);
      project = entity(relation?.from)?.project ?? entity(relation?.to)?.project;
    }
    events.push({ id: id('event'), type, at: now(), ...(project ? { project } : {}), ...data });
  }

  function prebuildJournalEntry(input, sequence) {
    if (!JOURNAL_ENTRY_TYPES.includes(input.type)) throw new Error(`Unknown journal entry type: ${input.type}`);
    if (!Number.isSafeInteger(sequence) || sequence <= 0) throw new Error('Journal sequence overflow: the next sequence must be a positive safe integer');
    const entry = {
      id: input.id ?? id('jentry'),
      seq: sequence,
      type: input.type,
      at: input.at ?? now(),
      project: input.project ?? null,
      entityKind: input.entityKind ?? null,
      entityId: input.entityId ?? null,
      schemaVersion: input.schemaVersion ?? SCHEMA_VERSION,
      payload: input.payload === undefined ? null : clone(input.payload),
      provenance: {
        actor: input.provenance?.actor ?? null,
        client: input.provenance?.client ?? null,
        sessionId: input.provenance?.sessionId ?? null
      },
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      ...(input.causationId ? { causationId: input.causationId } : {})
    };
    const expectedKind = JOURNAL_TYPE_ENTITY_KIND[entry.type];
    if (expectedKind && entry.entityKind !== expectedKind) throw new Error(`${entry.type} requires entityKind ${expectedKind}`);
    if (entry.payload?.id !== undefined && entry.entityId !== entry.payload.id) throw new Error(`${entry.type} entityId must match payload.id`);
    if (entry.payload?.project !== undefined && entry.project !== entry.payload.project) throw new Error(`${entry.type} project must match payload.project`);
    if (entry.payload?.kind !== undefined && entry.entityKind !== entry.payload.kind) throw new Error(`${entry.type} entityKind must match payload.kind`);
    const postconditionIssue = journalEntryPostconditionIssue(entry);
    if (postconditionIssue) throw new Error(`${entry.type} postcondition failed: ${postconditionIssue}`);
    return entry;
  }

  function assertJournalCapacity(requiredEntries) {
    if (!Number.isSafeInteger(requiredEntries) || requiredEntries < 0) {
      throw new Error('Journal reservation must request a non-negative safe entry count');
    }
    if (!Number.isSafeInteger(journalSeq) || requiredEntries > Number.MAX_SAFE_INTEGER - journalSeq) {
      throw new Error(`Journal sequence overflow: cannot reserve ${requiredEntries} safe sequence number(s)`);
    }
    return { first: journalSeq + 1, last: journalSeq + requiredEntries, count: requiredEntries };
  }

  // G4: append a complete post-operation snapshot. `seq` is the ordering key —
  // `at` cannot be, because now() is injectable and millisecond ties are normal.
  function appendJournal(input) {
    assertJournalCapacity(1);
    const entry = prebuildJournalEntry(input, journalSeq + 1);
    journalSeq = entry.seq;
    if (journalEpoch === null) journalEpoch = entry.seq;
    journal.push(entry);
    return entry;
  }

  function writeProvenance(record) {
    return { actor: record?.actor ?? null, client: record?.client ?? null, sessionId: record?.sessionId ?? null };
  }

  function importIdempotencyKey(key, value) {
    if (typeof key !== 'string') return key;
    const match = /^(decision|attempt|fact):([^:]+)$/.exec(key);
    return match && value?.project ? `${match[1]}:${value.project}:${match[2]}` : key;
  }

  function strings(value, name) {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) throw new Error(`${name} must be an array of strings`);
    return [...value];
  }

  function validateIdempotencyKey(value) {
    if (value === undefined || value === null || value === '') return;
    if (typeof value !== 'string' || value.length > 200) throw new Error('idempotencyKey must be a string of at most 200 characters');
  }

  function scopedIdempotencyKey(input, action) {
    const project = normalizeProject(input?.project);
    if (action !== 'memory') return `${action}:${project}:${input.idempotencyKey}`;
    const scope = normalizeMemoryScope(input.scope);
    const identity = JSON.stringify([scope.userId, scope.agentId, scope.runId, input.memoryType ?? null, input.key ?? null]);
    return `memory:${project}:${identity}:${input.idempotencyKey}`;
  }

  function idempotent(input, action) {
    if (!input?.idempotencyKey) return undefined;
    validateIdempotencyKey(input.idempotencyKey);
    const project = normalizeProject(input.project);
    const existing = idempotency.get(scopedIdempotencyKey(input, action));
    if (existing) return clone(canonicalIdempotencyValue(existing));
    // Legacy keys did not include project (all actions) or exact memory identity.
    // Reuse one only when the payload belongs to the same project and, for a
    // memory, the exact same scope/type/key; otherwise it would leak another
    // user's retry result.
    const legacyKeys = [`${action}:${project}:${input.idempotencyKey}`, `${action}:${input.idempotencyKey}`];
    for (const key of legacyKeys) {
      const legacy = idempotency.get(key);
      if (!legacy || (legacy.project ?? 'default') !== project) continue;
      if (action === 'memory' && memoryScopeKey(legacy) !== memoryScopeKey(input)) continue;
      return clone(canonicalIdempotencyValue(legacy));
    }
    return undefined;
  }
  function rememberIdempotency(input, action, value) {
    if (input?.idempotencyKey) idempotency.set(scopedIdempotencyKey({ ...input, ...value }, action), clone(value));
  }

  function canonicalIdempotencyValue(value) {
    const current = value?.kind === 'fact' ? facts.get(value.id) : records.get(value?.id);
    if (!current) throw new Error('Idempotency entry must reference an existing entity');
    if (!idempotencySemanticallyMatches(value, current)) {
      throw new Error(`Idempotency entry semantic mismatch with canonical entity ${value.id}`);
    }
    return current;
  }

  function addDecision(input) {
    const existing = idempotent(input, 'decision'); if (existing) return existing;
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title.trim() || typeof input.chosen !== 'string' || !input.chosen.trim()) throw new Error('A decision requires non-empty title and chosen strings');
    validateTemporalFields(input, ['createdAt', 'reviewAfter']);
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Decision confidence must be a number between 0 and 1');
    const alternatives = input.alternatives ?? [];
    if (!Array.isArray(alternatives) || alternatives.some((item) => !item || typeof item.label !== 'string' || !item.label.trim())) throw new Error('Decision alternatives must have non-empty label strings');
    const project = normalizeProject(input.project);
    const evidence = (input.evidence ?? []).map((item) => normalizeEvidence(item, now));
    const record = {
      id: input.id ?? id('decision'), kind: 'decision', schemaVersion: SCHEMA_VERSION,
      project, title: input.title, goal: input.goal ?? '', chosen: input.chosen,
      // G2: provenance travels with the decision. Plain JSON values only.
      ...provenanceFields(input),
      // G8: confidence carries an auditable basis, not a bare number.
      confidence: createConfidence(confidence, evidence.length), status: 'proposed',
      assumptions: strings(input.assumptions, 'assumptions'), evidence,
      alternatives: alternatives.map((item) => ({ id: item.id ?? id('alternative'), label: item.label, reasonRejected: item.reasonRejected ?? item.reason ?? '', reopenWhen: normalizeRules(item.reopenWhen ?? []), status: 'rejected' })),
      failedAttempts: [...(input.failedAttempts ?? [])], outcome: input.outcome ?? null,
      reviewAfter: input.reviewAfter ?? null, createdAt: input.createdAt ?? now(), updatedAt: now()
    };
    clone(record);
    assertUnusedEntityId(record.id);
    const reservedIds = new Set([record.id]);
    for (const alternative of record.alternatives) {
      assertUnusedEntityId(alternative.id, reservedIds);
      reservedIds.add(alternative.id);
    }
    assertJournalCapacity(1);
    records.set(record.id, record);
    event('decision.recorded', { recordId: record.id });
    appendJournal({ type: 'decision.recorded', entityKind: 'decision', entityId: record.id, project: record.project, payload: record, provenance: writeProvenance(record), idempotencyKey: input.idempotencyKey ? `decision:${record.project}:${input.idempotencyKey}` : undefined });
    const result = clone(record); rememberIdempotency(input, 'decision', result); return result;
  }

  function addAttempt(input) {
    const existing = idempotent(input, 'attempt'); if (existing) return existing;
    if (!input || typeof input !== 'object' || typeof input.solution !== 'string' || !input.solution.trim() || typeof input.result !== 'string' || !input.result.trim()) throw new Error('An attempt requires non-empty solution and result strings');
    validateTemporalFields(input, ['createdAt']);
    const attempt = { id: input.id ?? id('attempt'), kind: 'attempt', schemaVersion: SCHEMA_VERSION, project: normalizeProject(input.project), ...provenanceFields(input), solution: input.solution, result: input.result, environment: input.environment ?? '', reason: input.reason ?? '', reusableWhen: normalizeRules(input.reusableWhen ?? []), relatedTo: input.relatedTo ?? [], createdAt: input.createdAt ?? now() };
    clone(attempt);
    assertUnusedEntityId(attempt.id);
    assertJournalCapacity(1);
    records.set(attempt.id, attempt);
    event('attempt.recorded', { recordId: attempt.id });
    appendJournal({ type: 'attempt.recorded', entityKind: 'attempt', entityId: attempt.id, project: attempt.project, payload: attempt, provenance: writeProvenance(attempt), idempotencyKey: input.idempotencyKey ? `attempt:${attempt.project}:${input.idempotencyKey}` : undefined });
    const result = clone(attempt); rememberIdempotency(input, 'attempt', result); return result;
  }

  // Scoped memory covers profile and continuity use cases without flattening
  // decisions, alternatives, evidence, and outcomes into generic text.
  function remember(input) {
    const existingRetry = idempotent(input, 'memory');
    if (existingRetry) return { operation: 'NOOP', memory: existingRetry };
    if (!input || typeof input !== 'object') throw new Error('A memory requires an input object');
    if (!MEMORY_TYPES.includes(input.memoryType)) throw new Error(`Memory type must be one of: ${MEMORY_TYPES.join(', ')}`);
    if (typeof input.key !== 'string' || !input.key.trim()) throw new Error('A memory requires a non-empty key');
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('A memory requires non-empty text');
    if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new Error('Memory metadata must be an object');
    validateTemporalFields(input, ['recordedAt', 'createdAt', 'validFrom', 'validTo']);
    const project = normalizeProject(input.project);
    const scope = normalizeMemoryScope(input.scope);
    const tags = strings(input.tags, 'tags');
    const metadata = clone(input.metadata ?? {});
    const embedding = normalizeEmbedding(input.embedding);
    const scopeKey = memoryScopeKey({ project, scope, memoryType: input.memoryType, key: input.key });
    const previous = currentMemories.get(scopeKey);
    const latest = [...records.values()]
      .filter((record) => record.kind === 'memory' && memoryScopeKey(record) === scopeKey)
      .sort((left, right) => (right.version ?? 1) - (left.version ?? 1) || compareInstants(right.temporal?.validFrom, left.temporal?.validFrom) || String(right.id).localeCompare(String(left.id)))[0];
    const recordedAt = input.recordedAt ?? now();
    const validFrom = input.validFrom ?? recordedAt;
    const validTo = input.validTo ?? null;
    const temporalRequested = Object.prototype.hasOwnProperty.call(input, 'validFrom') || Object.prototype.hasOwnProperty.call(input, 'validTo');
    if (temporalRequested) validateMemoryInterval(validFrom, validTo);
    const nextContent = canonical({ text: input.text, metadata, tags });
    const previousContent = previous ? canonical({ text: previous.text, metadata: previous.metadata ?? {}, tags: previous.tags ?? [] }) : null;
    const sameRequestedInterval = !temporalRequested || (sameInstant(previous?.temporal?.validFrom, validFrom) && sameInstant(previous?.temporal?.validTo ?? null, validTo));
    if (previous && JSON.stringify(previousContent) === JSON.stringify(nextContent) && sameRequestedInterval) {
      const indexUpdated = input.embedding !== undefined && JSON.stringify(canonical(previous.embedding)) !== JSON.stringify(canonical(embedding));
      if (indexUpdated) {
        assertJournalCapacity(1);
        const indexedAt = recordedAt;
        touchMutableObject(previous);
        previous.embedding = embedding;
        previous.updatedAt = indexedAt;
        event('memory.indexed', { recordId: previous.id, project });
        appendJournal({ type: 'memory.indexed', entityKind: 'memory', entityId: previous.id, project, payload: clone(previous), provenance: writeProvenance({ ...previous, ...input }) });
      }
      return { operation: 'NOOP', memory: clone(previous), ...(indexUpdated ? { indexUpdated: true } : {}) };
    }

    validateMemoryInterval(validFrom, validTo);
    if (latest?.temporal?.validFrom && compareInstants(validFrom, latest.temporal.validFrom) < 0) {
      throw new Error('Memories for one identity must be recorded in non-decreasing validFrom order');
    }
    const provenance = provenanceFields(input);
    const memory = {
      id: input.id ?? id('memory'), kind: 'memory', schemaVersion: SCHEMA_VERSION,
      project, scope, memoryType: input.memoryType, key: input.key, text: input.text,
      version: (latest?.version ?? 0) + 1,
      metadata, tags, embedding, ...provenance, verificationStatus: 'unverified', status: 'active',
      temporal: { validFrom, validTo, recordedAt, invalidatedAt: null },
      createdAt: input.createdAt ?? recordedAt, updatedAt: recordedAt,
      ...(previous ? { supersedes: previous.id } : {})
    };
    assertUnusedEntityId(memory.id);
    assertJournalCapacity(previous ? 2 : 1);

    if (previous) {
      touchMutableObject(previous);
      previous.status = 'superseded';
      previous.supersededBy = memory.id;
      previous.temporal = { ...(previous.temporal ?? {}), validTo: earliestBoundary(previous.temporal?.validTo, validFrom), invalidatedAt: recordedAt };
      previous.updatedAt = recordedAt;
      appendJournal({ type: 'memory.superseded', entityKind: 'memory', entityId: previous.id, project, payload: clone(previous), provenance: writeProvenance(memory) });
    }

    records.set(memory.id, memory);
    currentMemories.set(scopeKey, memory);
    event('memory.recorded', { recordId: memory.id, project });
    appendJournal({ type: 'memory.recorded', entityKind: 'memory', entityId: memory.id, project, payload: memory, provenance: writeProvenance(memory), idempotencyKey: input.idempotencyKey ? scopedIdempotencyKey({ ...input, ...memory }, 'memory') : undefined });
    rememberIdempotency(input, 'memory', memory);
    return { operation: previous ? 'UPDATE' : 'ADD', memory: clone(memory), ...(previous ? { previous: clone(previous) } : {}) };
  }

  function memoryHistory(input = {}) {
    const project = normalizeProject(input.project);
    const scope = normalizeMemoryScope(input.scope);
    const scopeKey = memoryScopeKey({ project, scope, memoryType: input.memoryType, key: input.key });
    const items = [...records.values()]
      .filter((record) => record.kind === 'memory' && memoryScopeKey(record) === scopeKey)
      .sort((left, right) => (left.version ?? 1) - (right.version ?? 1) || compareInstants(left.temporal?.validFrom ?? left.createdAt, right.temporal?.validFrom ?? right.createdAt) || String(left.id).localeCompare(String(right.id)))
      .map(clone);
    return paginate(items, input, { project, scope, memoryType: input.memoryType, key: input.key }, { historical: true });
  }

  function applyMemoryPlan(input = {}) {
    if (!Array.isArray(input.operations)) throw new Error('Memory plan operations must be an array');
    const project = normalizeProject(input.project);
    const defaultScope = normalizeMemoryScope(input.scope);
    const actions = new Set(['ADD', 'UPDATE', 'DELETE', 'NOOP']);
    const simulatedValidFrom = new Map([...currentMemories].map(([key, memory]) => [key, memory.temporal?.validFrom ?? null]));
    const reservedIds = new Set();

    // Preflight the complete plan before mutating anything. Extraction output is
    // untrusted input; one malformed late operation must not leave a partial plan.
    const operations = input.operations.map((raw) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Memory plan operations must be objects');
      const action = String(raw.action ?? '').toUpperCase();
      if (!actions.has(action)) throw new Error('Memory plan action must be ADD, UPDATE, DELETE, or NOOP');
      if (!MEMORY_TYPES.includes(raw.memoryType)) throw new Error(`Memory type must be one of: ${MEMORY_TYPES.join(', ')}`);
      if (typeof raw.key !== 'string' || !raw.key.trim()) throw new Error('A memory plan operation requires a non-empty key');
      if (['ADD', 'UPDATE'].includes(action) && (typeof raw.text !== 'string' || !raw.text.trim())) throw new Error(`${action} memory plan operations require non-empty text`);
      if (raw.metadata !== undefined && (!raw.metadata || typeof raw.metadata !== 'object' || Array.isArray(raw.metadata))) throw new Error('Memory metadata must be an object');
      strings(raw.tags, 'tags');
      normalizeEmbedding(raw.embedding);
      validateIdempotencyKey(raw.idempotencyKey);
      validateTemporalFields(raw, ['recordedAt', 'createdAt', 'validFrom', 'validTo', 'validAt']);
      const scope = normalizeMemoryScope(raw.scope ?? defaultScope);
      if (['ADD', 'UPDATE'].includes(action) && raw.id !== undefined) {
        assertUnusedEntityId(raw.id, reservedIds);
        reservedIds.add(raw.id);
      }
      for (const name of ['actor', 'client', 'sessionId']) provenanceString(raw[name] ?? input[name], name);
      const recordedAt = ['ADD', 'UPDATE'].includes(action) ? (raw.recordedAt ?? now()) : raw.recordedAt;
      const identityKey = memoryScopeKey({ project, scope, memoryType: raw.memoryType, key: raw.key });
      if (['ADD', 'UPDATE'].includes(action)) {
        const validFrom = raw.validFrom ?? recordedAt;
        validateMemoryInterval(validFrom, raw.validTo ?? null);
        const previousValidFrom = simulatedValidFrom.get(identityKey);
        if (previousValidFrom && compareInstants(validFrom, previousValidFrom) < 0) {
          throw new Error('Memories for one identity must be recorded in non-decreasing validFrom order');
        }
        simulatedValidFrom.set(identityKey, validFrom);
      } else if (action === 'DELETE') {
        const previousValidFrom = simulatedValidFrom.get(identityKey);
        if (previousValidFrom && raw.validAt && compareInstants(raw.validAt, previousValidFrom) < 0) {
          throw new Error('Memory invalidation time must not precede validFrom');
        }
        // Invalidation ends current validity; it does not erase history. Keep the
        // last validFrom so a later operation in this plan cannot sneak in an
        // out-of-order backfill and fail only after DELETE has already mutated.
      }
      return { ...clone(raw), action, scope, ...(recordedAt ? { recordedAt } : {}) };
    });

    const simulatedMemories = new Map([...currentMemories].map(([key, memory]) => [key, clone(memory)]));
    const simulatedIdempotency = new Set();
    let requiredJournalEntries = 0;
    for (const operation of operations) {
      const scopeKey = memoryScopeKey({ project, scope: operation.scope, memoryType: operation.memoryType, key: operation.key });
      const current = simulatedMemories.get(scopeKey);
      if (operation.action === 'NOOP' || (operation.action === 'DELETE' && !current)) continue;
      if (operation.action === 'DELETE') {
        requiredJournalEntries += 1;
        simulatedMemories.delete(scopeKey);
        continue;
      }

      const operationInput = { ...operation, project, scope: operation.scope };
      const idempotencyKey = operation.idempotencyKey ? scopedIdempotencyKey(operationInput, 'memory') : null;
      if ((idempotencyKey && simulatedIdempotency.has(idempotencyKey)) || idempotent(operationInput, 'memory')) continue;
      const metadata = clone(operation.metadata ?? {});
      const tags = strings(operation.tags, 'tags');
      const embedding = normalizeEmbedding(operation.embedding);
      const temporalRequested = Object.hasOwn(operation, 'validFrom') || Object.hasOwn(operation, 'validTo');
      const validFrom = operation.validFrom ?? operation.recordedAt;
      const validTo = operation.validTo ?? null;
      const nextContent = canonical({ text: operation.text, metadata, tags });
      const currentContent = current ? canonical({ text: current.text, metadata: current.metadata ?? {}, tags: current.tags ?? [] }) : null;
      const sameRequestedInterval = !temporalRequested || (sameInstant(current?.temporal?.validFrom, validFrom) && sameInstant(current?.temporal?.validTo ?? null, validTo));
      if (current && JSON.stringify(currentContent) === JSON.stringify(nextContent) && sameRequestedInterval) {
        const indexUpdated = operation.embedding !== undefined && JSON.stringify(canonical(current.embedding)) !== JSON.stringify(canonical(embedding));
        if (indexUpdated) {
          requiredJournalEntries += 1;
          current.embedding = embedding;
          current.updatedAt = operation.recordedAt;
        }
      } else {
        requiredJournalEntries += current ? 2 : 1;
        simulatedMemories.set(scopeKey, {
          id: operation.id ?? `reserved-memory-${simulatedMemories.size}`,
          kind: 'memory', project, scope: operation.scope, memoryType: operation.memoryType,
          key: operation.key, text: operation.text, metadata, tags, embedding, status: 'active',
          temporal: { validFrom, validTo, recordedAt: operation.recordedAt, invalidatedAt: null }
        });
        // remember() stores idempotency only for ADD/UPDATE snapshots. Index-only
        // refreshes return before rememberIdempotency(), so a later operation with
        // the same caller key must still be counted independently.
        if (idempotencyKey) simulatedIdempotency.add(idempotencyKey);
      }
    }
    assertJournalCapacity(requiredJournalEntries);

    const results = [];
    for (const operation of operations) {
      const scopeKey = memoryScopeKey({ project, scope: operation.scope, memoryType: operation.memoryType, key: operation.key });
      const current = currentMemories.get(scopeKey);
      if (operation.action === 'NOOP' || (operation.action === 'DELETE' && !current)) {
        results.push({ operation: 'NOOP', memory: current ? clone(current) : null });
        continue;
      }
      if (operation.action === 'DELETE') {
        const recordedAt = operation.recordedAt ?? now();
        const requestedBoundary = operation.validAt ?? recordedAt;
        const validFrom = current.temporal?.validFrom ?? requestedBoundary;
        const safeBoundary = compareInstants(requestedBoundary, validFrom) < 0 ? validFrom : requestedBoundary;
        touchMutableObject(current);
        current.status = 'invalidated';
        current.temporal = {
          ...(current.temporal ?? {}),
          validTo: earliestBoundary(current.temporal?.validTo, safeBoundary),
          invalidatedAt: recordedAt
        };
        current.updatedAt = recordedAt;
        currentMemories.delete(scopeKey);
        event('memory.invalidated', { recordId: current.id, project });
        appendJournal({ type: 'memory.invalidated', entityKind: 'memory', entityId: current.id, project, payload: clone(current), provenance: writeProvenance({ ...input, ...operation }) });
        results.push({ operation: 'DELETE', memory: clone(current) });
        continue;
      }
      results.push(remember({
        ...operation,
        project,
        scope: operation.scope,
        sourceClass: operation.sourceClass ?? input.sourceClass,
        actor: operation.actor ?? input.actor,
        client: operation.client ?? input.client,
        sessionId: operation.sessionId ?? input.sessionId
      }));
    }
    return { results, completeness: { complete: true, requested: operations.length, applied: results.length } };
  }

  function addFact(input) {
    if (!input || typeof input.key !== 'string' || !input.key.trim()) throw new Error('A fact requires a non-empty key');
    validateTemporalFields(input, ['recordedAt', 'observedAt', 'validFrom', 'validTo', 'expiresAt']);
    const project = normalizeProject(input.project);
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Fact confidence must be a number between 0 and 1');
    const factScope = JSON.stringify([project, input.key]);
    const previous = currentFacts.get(factScope);
    // G2: a source label is a CLAIM about origin, not a grant of trust. Unknown or
    // non-canonical labels downgrade to agent_claimed with the raw label kept for
    // audit. See provenance-contract.md §4.
    const provenance = provenanceFields(input);
    // G2: no caller input may produce `verified`. Every input — the source string,
    // any reference, this very field — arrives through the same untrusted path (the
    // agent's own tool call), so deriving trust from it would make `verified` mean
    // only "someone typed something". `contradicted` is allowed: it LOWERS trust.
    // `expired` is owned by maintain(). Contract §2; open question U-1.
    const requested = input.verificationStatus;
    if (requested !== undefined) {
      if (!VERIFICATION_STATUSES.includes(requested)) throw new Error('Invalid fact verificationStatus');
      if (requested === 'verified' || requested === 'expired') throw new Error(`A caller cannot set fact verificationStatus to ${requested}`);
    }
    const verificationStatus = requested === 'contradicted' ? 'contradicted' : 'unverified';
    const recordedAt = input.recordedAt ?? now();
    const observedAt = input.observedAt ?? recordedAt;
    const validFrom = input.validFrom ?? observedAt;
    const validTo = input.validTo ?? null;
    if (validTo && compareInstants(validTo, validFrom) <= 0) throw new Error('Fact validTo must be later than validFrom');
    const effectiveExpirationBoundary = earliestBoundary(input.expiresAt ?? null, validTo);
    if (effectiveExpirationBoundary && compareInstants(effectiveExpirationBoundary, validFrom) < 0) {
      throw new Error('Fact effective expiration boundary must not precede validFrom');
    }
    const existing = idempotent(input, 'fact'); if (existing) return existing;
    if (previous?.temporal?.validFrom && compareInstants(validFrom, previous.temporal.validFrom) < 0) {
      throw new Error('Facts for one scope must be recorded in non-decreasing validFrom order');
    }
    const fact = {
      id: input.id ?? id('fact'), kind: 'fact', schemaVersion: SCHEMA_VERSION,
      project, key: input.key, value: input.value,
      source: provenance.sourceClass, ...provenance, confidence, verificationStatus,
      status: 'active', expiresAt: input.expiresAt ?? null, observedAt,
      validityPolicy: {
        declaredExpiresAt: input.expiresAt ?? null,
        declaredValidTo: validTo,
        effectiveExpirationBoundary
      },
      temporal: { validFrom, validTo, recordedAt, invalidatedAt: null }
    };
    clone(fact);
    assertUnusedEntityId(fact.id);
    assertJournalCapacity(previous ? 2 : 1);
    if (previous) {
      touchMutableObject(previous);
      previous.status = 'superseded';
      previous.supersededBy = fact.id;
      previous.temporal = {
        validFrom: previous.temporal?.validFrom ?? previous.observedAt ?? null,
        validTo: earliestBoundary(previous.temporal?.validTo, validFrom),
        recordedAt: previous.temporal?.recordedAt ?? previous.observedAt ?? null,
        invalidatedAt: recordedAt
      };
      // The implicit supersession used to be silent. It is now an explicit entry.
      appendJournal({ type: 'fact.superseded', entityKind: 'fact', entityId: previous.id, project: previous.project, payload: clone(previous), provenance: writeProvenance(fact) });
    }
    facts.set(fact.id, fact); currentFacts.set(factScope, fact);
    event('fact.observed', { factId: fact.id, key: fact.key });
    appendJournal({ type: 'fact.observed', entityKind: 'fact', entityId: fact.id, project: fact.project, payload: fact, provenance: writeProvenance(fact), idempotencyKey: input.idempotencyKey ? `fact:${fact.project}:${input.idempotencyKey}` : undefined });
    const result = clone(fact); rememberIdempotency(input, 'fact', result); return result;
  }

  async function verifyFact(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Fact verification requires an input object');
    const allowed = new Set(['factId', 'evidencePath']);
    if (Object.keys(input).some((name) => !allowed.has(name))) throw new Error('Fact verification only accepts factId and evidencePath');
    if (typeof input.factId !== 'string' || !input.factId) throw new Error('Fact verification requires a non-empty factId');
    if (typeof input.evidencePath !== 'string' || !input.evidencePath.trim()) throw new Error('Fact verification requires a non-empty evidencePath');
    if (!verifier || typeof verifier.verify !== 'function' || typeof verifier.validateStored !== 'function') {
      throw new Error('Fact verification is unavailable: configure a separate trusted verifier');
    }
    const fact = facts.get(input.factId);
    if (!fact || fact.kind !== 'fact') throw new Error('Fact not found');
    if (fact.status !== 'active') throw new Error('Only an active fact can be verified');
    const attestation = await verifier.verify({ fact: clone(fact), evidencePath: input.evidencePath });
    // Evidence verification may perform filesystem I/O. The commit decision must
    // use a fresh trusted clock sample after that await, never the pre-I/O instant.
    const trustedValidationInstant = now();
    const current = facts.get(input.factId);
    if (!current || current.kind !== 'fact') throw new Error('Fact not found');
    if (current.status !== 'active') throw new Error('Only an active fact can be verified');
    const next = clone(attestation);
    const candidate = { ...clone(current), verificationStatus: 'verified', verification: next };
    if (!verifier.validateStored(candidate, { trustedValidationInstant })) {
      let expiredDuringValidation = false;
      const expirationBoundary = effectiveFactExpirationBoundary(current);
      if (
        current.verificationStatus === 'verified'
        && expirationBoundary
        && compareInstants(expirationBoundary, trustedValidationInstant) <= 0
      ) {
        const expired = {
          ...clone(current),
          status: 'expired',
          verificationStatus: 'expired',
          temporal: {
            validFrom: current.temporal?.validFrom ?? current.observedAt ?? null,
            validTo: earliestBoundary(current.temporal?.validTo ?? current.validTo ?? null, expirationBoundary),
            recordedAt: current.temporal?.recordedAt ?? current.observedAt ?? null,
            invalidatedAt: trustedValidationInstant
          }
        };
        const entry = prebuildJournalEntry({
          type: 'fact.expired', entityKind: 'fact', entityId: current.id,
          project: current.project, at: trustedValidationInstant, payload: expired
        }, journalSeq + 1);
        touchMutableObject(current);
        Object.assign(current, expired);
        journalSeq = entry.seq;
        if (journalEpoch === null) journalEpoch = entry.seq;
        journal.push(entry);
        expiredDuringValidation = true;
      }
      const error = new Error('Verifier returned an invalid or expired persisted fact verification');
      if (expiredDuringValidation) return committedRejection(error);
      throw error;
    }
    if (current.verificationStatus === 'verified') {
      if (JSON.stringify(canonical(current.verification)) === JSON.stringify(canonical(next))) {
        return { operation: 'NOOP', fact: clone(current) };
      }
      throw new Error('Fact is already verified by a different attestation');
    }
    const entry = prebuildJournalEntry({
      type: 'fact.verified', entityKind: 'fact', entityId: current.id,
      project: current.project, at: trustedValidationInstant, payload: candidate,
      provenance: { actor: next.verifierIdentity, client: 'local-evidence-verifier', sessionId: null }
    }, journalSeq + 1);
    touchMutableObject(current);
    Object.assign(current, candidate);
    journalSeq = entry.seq;
    if (journalEpoch === null) journalEpoch = entry.seq;
    journal.push(entry);
    return { operation: 'VERIFIED', fact: clone(current) };
  }

  function entity(entityId) {
    if (records.has(entityId)) return records.get(entityId);
    if (facts.has(entityId)) return facts.get(entityId);
    for (const record of records.values()) {
      const alternative = record.kind === 'decision' && record.alternatives?.find((item) => item.id === entityId);
      if (alternative) return { ...alternative, kind: 'alternative', project: record.project, decisionId: record.id };
    }
    return undefined;
  }

  function link(input) {
    if (!input || typeof input.from !== 'string' || typeof input.to !== 'string' || typeof input.relation !== 'string' || !input.relation.trim()) throw new Error('A relationship requires from, to, and relation');
    if (!entity(input.from) || !entity(input.to)) throw new Error('Relation endpoints must exist before linking');
    validateTemporalFields(input, ['recordedAt', 'createdAt', 'validFrom', 'validTo']);
    const recordedAt = input.recordedAt ?? now();
    const createdAt = input.createdAt ?? recordedAt;
    const validFrom = input.validFrom ?? createdAt;
    const validTo = input.validTo ?? null;
    if (validTo && compareInstants(validTo, validFrom) <= 0) throw new Error('Relation validTo must be later than validFrom');
    const relation = {
      id: input.id ?? id('relation'), kind: 'relation', schemaVersion: SCHEMA_VERSION,
      from: input.from, to: input.to, relation: input.relation, createdAt,
      temporal: { validFrom, validTo, recordedAt, invalidatedAt: null }
    };
    assertUnusedEntityId(relation.id);
    assertJournalCapacity(1);
    relations.set(relation.id, relation);
    event('relation.created', { relationId: relation.id });
    appendJournal({ type: 'relation.created', entityKind: 'relation', entityId: relation.id, project: entity(relation.from)?.project ?? entity(relation.to)?.project ?? null, payload: relation });
    return clone(relation);
  }

  function traverse(input = {}) {
    if (typeof input.id !== 'string' || !entity(input.id)) throw new Error('A traversal requires an existing id');
    const memoryProject = normalizeProject(input.project);
    const memoryScope = normalizeMemoryScope(input.scope);
    const memoryVisible = (item) => item?.kind !== 'memory' || (item.project === memoryProject && sameMemoryScopeValues(item.scope, memoryScope));
    if (!memoryVisible(entity(input.id))) throw new Error('Traversal root is outside the requested memory scope');
    const direction = input.direction ?? 'both';
    if (!['in', 'out', 'both'].includes(direction)) throw new Error('Traversal direction must be in, out, or both');
    const depth = input.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 1 || depth > 10) throw new Error('Traversal depth must be an integer between 1 and 10');
    const seen = new Set([input.id]); const nodes = [clone(entity(input.id))]; const edges = []; let frontier = [input.id];
    for (let level = 0; level < depth && frontier.length; level += 1) {
      const next = [];
      for (const relation of relations.values()) {
        if (input.relation && relation.relation !== input.relation) continue;
        const fromMatch = direction !== 'in' && frontier.includes(relation.from);
        const toMatch = direction !== 'out' && frontier.includes(relation.to);
        if (!fromMatch && !toMatch) continue;
        const targetId = fromMatch ? relation.to : relation.from;
        if (!entity(targetId)) continue;
        if (!memoryVisible(entity(targetId))) continue;
        if (!edges.some((item) => item.id === relation.id)) edges.push(clone(relation));
        if (!seen.has(targetId) && entity(targetId)) { seen.add(targetId); next.push(targetId); nodes.push(clone(entity(targetId))); }
      }
      frontier = next;
    }
    return { root: input.id, direction, depth, nodes, relations: edges };
  }

  function supersedeDecision(input = {}) {
    const previous = records.get(input.decisionId); const replacement = records.get(input.replacementId);
    if (!previous || previous.kind !== 'decision' || !replacement || replacement.kind !== 'decision') throw new Error('Supersession requires two existing decisions');
    if (previous.id === replacement.id) throw new Error('A decision cannot supersede itself');
    if (previous.project !== replacement.project) throw new Error('Superseding decisions must belong to the same project');
    if (previous.status === 'superseded' && previous.supersededBy === replacement.id) return { previous: clone(previous), replacement: clone(replacement), relation: [...relations.values()].find((item) => item.from === replacement.id && item.to === previous.id && item.relation === 'supersedes') ?? null };
    if (['superseded', 'archived'].includes(previous.status) || ['superseded', 'archived', 'abandoned', 'stale'].includes(replacement.status)) throw new Error('Supersession would create an invalid decision chain');
    assertJournalCapacity(3);
    touchMutableObject(previous);
    touchMutableObject(replacement);
    previous.status = 'superseded'; previous.supersededBy = replacement.id; previous.updatedAt = now();
    replacement.supersedes = [...new Set([...(replacement.supersedes ?? []), previous.id])]; replacement.updatedAt = now();
    const relation = link({ from: replacement.id, to: previous.id, relation: 'supersedes' });
    event('decision.superseded', { recordId: previous.id, replacementId: replacement.id });
    const cause = appendJournal({ type: 'decision.superseded', entityKind: 'decision', entityId: previous.id, project: previous.project, payload: clone(previous), provenance: writeProvenance(previous) });
    appendJournal({ type: 'decision.recorded', entityKind: 'decision', entityId: replacement.id, project: replacement.project, payload: clone(replacement), provenance: writeProvenance(replacement), causationId: cause.id });
    return { previous: clone(previous), replacement: clone(replacement), relation };
  }

  function updateDecisionStatus(decisionId, status) {
    const record = records.get(decisionId); if (!record || record.kind !== 'decision') throw new Error('Decision not found');
    // G3: accept FORMATTING aliases only (case, hyphen/underscore) and store the
    // canonical value, so search({status}) matches what was written. There are no
    // SEMANTIC aliases: `archived` is not `abandoned`, `active` is not `executed`.
    const canonical = normalizeDecisionStatus(status);
    if (!canonical) throw new Error(`Invalid decision status: ${status}`);
    const from = record.status;
    if (canonical === 'stale') throw new Error('Decision status stale is system-owned and can only be produced by maintain()');
    if (canonical === 'superseded') throw new Error('Decision status superseded is system-owned and can only be produced by supersedeDecision()');
    if (canonical === from) return clone(record);
    if (!(DECISION_TRANSITIONS[from] ?? []).includes(canonical)) {
      throw new Error(`Illegal decision status transition: ${from} -> ${canonical}`);
    }
    assertJournalCapacity(1);
    touchMutableObject(record);
    record.status = canonical; record.updatedAt = now();
    event('decision.status', { recordId: decisionId, status: canonical });
    appendJournal({ type: 'decision.status_changed', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record), provenance: writeProvenance(record) });
    journal[journal.length - 1].transition = { from: from ?? null, to: canonical };
    return clone(record);
  }

  function setOutcome(decisionId, outcome) {
    const record = records.get(decisionId); if (!record || record.kind !== 'decision') throw new Error('Decision not found');
    if (!OUTCOME_STATUSES.includes(outcome?.status)) throw new Error('Outcome status must be successful, mixed, failed, or unknown');
    // G2/G8: an outcome's own provenance is a CLAIM. It weights the confidence move
    // but never sets a verification status anywhere.
    const outcomeProvenance = normalizeSourceClass(outcome.sourceClass ?? outcome.source);
    const observedAt = outcome.observedAt ?? now();
    const normalizedOutcome = { ...clone(outcome), sourceClass: outcomeProvenance.sourceClass, observedAt };
    const updatedAt = now();
    const contribution = {
      key: `outcome:${record.id}`,
      kind: 'outcome',
      outcomeStatus: outcome.status,
      direction: outcome.status === 'successful' ? 1 : outcome.status === 'failed' ? -1 : outcome.status === 'mixed' ? -0.5 : 0,
      sourceClass: outcomeProvenance.sourceClass,
      reason: `Outcome: ${outcome.status}`,
      provenance: writeProvenance(record),
      at: observedAt
    };
    const confidenceProbe = clone(record.confidence);
    const changesConfidence = setOutcomeContribution(confidenceProbe, contribution);
    assertJournalCapacity(changesConfidence ? 2 : 1);

    touchMutableObject(record);
    record.outcome = normalizedOutcome;
    record.updatedAt = updatedAt;
    event('decision.outcome', { recordId: decisionId, status: outcome.status });
    const cause = appendJournal({ type: 'outcome.recorded', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record), provenance: writeProvenance(record) });
    // G8: deterministic, single-slot. A decision has ONE outcome, so it carries ONE
    // outcome contribution: re-recording REPLACES it rather than stacking a second.
    // The old key embedded observedAt, so the same outcome written twice in
    // different milliseconds double-counted. See setOutcomeContribution.
    const changed = setOutcomeContribution(record.confidence, contribution);
    if (changed) {
      appendJournal({ type: 'confidence.changed', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record), provenance: writeProvenance(record), causationId: cause.id });
    }
    return clone(record);
  }

  // G8: record evidence for or against a decision without inventing an outcome.
  function addConfidenceEvidence(input = {}) {
    const record = records.get(input.decisionId);
    if (!record || record.kind !== 'decision') throw new Error('Decision not found');
    const direction = input.supports === false ? -1 : 1;
    const provenance = normalizeSourceClass(input.sourceClass ?? input.source);
    if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('Confidence evidence requires a non-empty reason');
    // P1-9: `key` is REQUIRED. The previous default embedded now() in the dedupe
    // key, so the same evidence submitted twice across a clock tick produced two
    // different keys and was counted twice — retry-idempotency that only held
    // inside a single millisecond. Rather than invent a stable key from content
    // (which would silently merge two genuinely distinct observations that happen
    // to share a reason), the caller must supply one. No stable key, no
    // idempotency claim.
    if (typeof input.key !== 'string' || !input.key.trim()) {
      throw new Error('Confidence evidence requires a stable `key` so a retry cannot double-count');
    }
    const at = input.observedAt ?? now();
    const key = input.key;
    const contribution = {
      key, kind: 'evidence', direction, sourceClass: provenance.sourceClass,
      reason: input.reason, provenance: writeProvenance(input), at
    };
    const confidenceProbe = clone(record.confidence);
    // Legacy records may have a current value without a contribution basis. Use
    // that unexplained value as the explicit baseline for the first new policy
    // contribution; never silently reset it to the older initial value.
    if (confidenceProbe.migratedFromLegacyCurrent && !confidenceProbe.basis) {
      confidenceProbe.initial = confidenceProbe.current;
      confidenceProbe.migratedFromLegacyCurrent = false;
    }
    const changesConfidence = applyContribution(confidenceProbe, contribution);
    assertJournalCapacity(changesConfidence ? 1 : 0);

    touchMutableObject(record);
    if (record.confidence.migratedFromLegacyCurrent && !record.confidence.basis) {
      record.confidence.initial = record.confidence.current;
      record.confidence.migratedFromLegacyCurrent = false;
    }
    const changed = applyContribution(record.confidence, contribution);
    record.updatedAt = now();
    if (changed) {
      appendJournal({ type: 'confidence.changed', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record), provenance: writeProvenance(input) });
    }
    return clone(record);
  }

  function ruleMatches(rule, value) {
    if (typeof rule === 'string') return value === true || value === rule;
    if (!rule || typeof rule !== 'object') return false;
    if (rule.operator === 'equals') return value === rule.value;
    if (rule.operator === 'not_equals') return value !== rule.value;
    if (rule.operator === 'contains') return Array.isArray(value) ? value.includes(rule.value) : String(value).includes(String(rule.value));
    if (rule.operator === 'greater_than') return Number(value) > Number(rule.value);
    if (rule.operator === 'less_than') return Number(value) < Number(rule.value);
    return false;
  }

  // G1: reconsideration must work from persisted state, not only from facts the
  // caller happens to re-supply. Projects one project's ACTIVE facts into the same
  // { key: value } shape review({ facts }) already accepts, so stored and supplied
  // facts share a single matching path. Project-scoped; superseded/expired skipped.
  function storedFactValues(project, asOf) {
    const candidates = new Map();
    for (const fact of facts.values()) {
      if ((fact.project ?? 'default') !== project) continue;
      const temporal = fact.temporal;
      if (temporal) {
        if (temporal.validFrom && compareInstants(temporal.validFrom, asOf) > 0) continue;
        if (temporal.validTo && compareInstants(temporal.validTo, asOf) <= 0) continue;
      } else if (fact.status !== 'active') continue;
      if (!candidates.has(fact.key)) candidates.set(fact.key, []);
      candidates.get(fact.key).push(fact);
    }
    const values = {};
    for (const [key, matches] of candidates) {
      const winner = [...matches].sort((left, right) => {
        const byValidFrom = compareInstants(right.temporal?.validFrom ?? right.observedAt, left.temporal?.validFrom ?? left.observedAt);
        return byValidFrom !== 0 ? byValidFrom : String(right.id).localeCompare(String(left.id));
      })[0];
      values[key] = winner.value;
    }
    return values;
  }

  function review(context = {}) {
    const prepared = validateReviewInput(context);
    const project = prepared.project;
    const changed = new Set(prepared.changedFacts); const due = [];
    const reviewAt = prepared.asOf ?? now();
    for (const record of records.values()) {
      if (record.kind !== 'decision') continue;
      if (['archived', 'superseded', 'abandoned'].includes(record.status)) continue;
      if (project !== undefined && record.project !== project) continue;
      const matches = [];
      const reconsider = new Set();
      // Precedence: caller-supplied `facts` override stored facts of the same key,
      // preserving the pre-existing call-argument contract. String rules keep
      // matching `changedFacts` only: that list is an ephemeral "these just
      // changed" signal, whereas facts are durable state, so feeding state into it
      // would make every decision due forever.
      const knownFacts = { ...storedFactValues(record.project ?? 'default', reviewAt), ...prepared.facts };
      for (const alternative of record.alternatives) for (const rule of alternative.reopenWhen) {
        if (typeof rule === 'string' && changed.has(rule)) { matches.push(rule); reconsider.add(alternative.label); }
        else if (rule && Object.prototype.hasOwnProperty.call(knownFacts, rule.key) && ruleMatches(rule, knownFacts[rule.key])) { matches.push(rule.key); reconsider.add(alternative.label); }
      }
      if (record.reviewAfter && compareInstants(record.reviewAfter, reviewAt) <= 0) matches.push('review date reached');
      if (record.outcome?.status === 'failed') matches.push('decision outcome failed');
      if (matches.length) due.push({ decisionId: record.id, title: record.title, reason: [...new Set(matches)].join(', '), alternativesToReconsider: reconsider.size ? [...reconsider] : record.alternatives.map((item) => item.label) });
    }
    for (const item of due) {
      const key = reviewSignalKey(item.decisionId, item.reason);
      if (!reviewSignals.has(key)) reviewSignals.set(key, { id: id('review'), kind: 'review', ...clone(item), status: 'open', createdAt: now() });
    }
    return due;
  }

  function maintain(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('maintain input must be an object');
    validateTemporalFields(input, ['now']);
    const at = input.now ?? now();
    validateTemporalFields({ now: at }, ['now']);
    // P1-4: review is the final stage of maintenance but owns caller-controlled
    // changedFacts/facts validation. Validate that complete input before staling a
    // decision, expiring a fact, emitting an event, or appending a journal entry.
    const reviewInput = validateReviewInput({
      changedFacts: input.changedFacts ?? [],
      facts: input.facts ?? {},
      asOf: at
    });
    const decisionsToStale = [...records.values()].filter((record) => (
      record.kind === 'decision'
      && record.reviewAfter
      && compareInstants(record.reviewAfter, at) <= 0
      && CURRENT_DECISION_STATUSES.includes(record.status)
    ));
    const factsToExpire = [...facts.values()].filter((fact) => {
      const expirationBoundary = effectiveFactExpirationBoundary(fact);
      return fact.status === 'active' && expirationBoundary && compareInstants(expirationBoundary, at) <= 0;
    });
    assertJournalCapacity(decisionsToStale.length + factsToExpire.length);

    const staleDecisionIds = [];
    for (const record of decisionsToStale) {
      const from = record.status;
      touchMutableObject(record);
      record.status = 'stale'; record.updatedAt = at; staleDecisionIds.push(record.id);
      const entry = appendJournal({ type: 'decision.staled', entityKind: 'decision', entityId: record.id, project: record.project, payload: clone(record) });
      entry.transition = { from, to: 'stale', actor: 'maintain' };
    }
    for (const fact of factsToExpire) {
      const expirationBoundary = effectiveFactExpirationBoundary(fact);
      touchMutableObject(fact);
      fact.status = 'expired'; fact.verificationStatus = 'expired';
      fact.temporal = {
        validFrom: fact.temporal?.validFrom ?? fact.observedAt ?? null,
        validTo: earliestBoundary(fact.temporal?.validTo ?? fact.validTo ?? null, expirationBoundary),
        recordedAt: fact.temporal?.recordedAt ?? fact.observedAt ?? null,
        invalidatedAt: at
      };
      appendJournal({ type: 'fact.expired', entityKind: 'fact', entityId: fact.id, project: fact.project, payload: clone(fact) });
    }
    const due = review(reviewInput);
    return { at, staleDecisionIds, agedDecisionIds: [...staleDecisionIds], reviewSignals: [...reviewSignals.values()].map(clone), due };
  }

  function getReviewSignals(input = {}) { const project = input.project === undefined ? undefined : normalizeProject(input.project); return [...reviewSignals.values()].filter((item) => (project === undefined || records.get(item.decisionId)?.project === project) && (!input.status || item.status === input.status)).map(clone); }
  function acknowledgeReview(signalId) { const item = [...reviewSignals.values()].find((candidate) => candidate.id === signalId); if (!item) throw new Error('Review signal not found'); touchMutableObject(item); item.status = 'acknowledged'; item.acknowledgedAt = now(); return clone(item); }

  function redact(input = {}) {
    const project = input.project === undefined ? undefined : normalizeProject(input.project);
    const patterns = (input.patterns ?? ['password', 'secret', 'token', 'api[-_]?key', 'authorization', 'private[-_]?key']).map((item) => new RegExp(String(item), 'i'));
    const replacement = input.replacement ?? '[REDACTED]';
    const transform = (value, key = '') => {
      if (key === 'idempotencyKey' || key === 'evidenceReference' || key === 'signature' || patterns.some((pattern) => pattern.test(key))) return replacement;
      if (typeof value === 'string') return value.replace(/(Bearer\s+)[^\s]+/gi, `$1${replacement}`).replace(/(https?:\/\/[^\s]*)(token|secret|key)[^\s]*/gi, replacement);
      if (Array.isArray(value)) return value.map((item) => transform(item, key));
      if (value && typeof value === 'object') {
        const sensitiveValue = patterns.some((pattern) => pattern.test(String(value.key ?? '')));
        return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, ['value', 'text'].includes(childKey) && sensitiveValue ? replacement : transform(item, childKey)]));
      }
      return value;
    };
    const data = exportData();
    data.idempotency = data.idempotency.map((item) => ({ ...item, key: replacement }));
    if (project) {
      data.records = data.records.filter((item) => item.project === project);
      data.facts = data.facts.filter((item) => item.project === project);
      data.idempotency = data.idempotency.filter((item) => item.value?.project === project);
      const recordIds = new Set(data.records.map((item) => item.id));
      const decisionIds = new Set(data.records.filter((item) => item.kind === 'decision').map((item) => item.id));
      const ids = new Set([...recordIds, ...data.facts.map((item) => item.id)]);
      data.reviewSignals = data.reviewSignals.filter((item) => decisionIds.has(item.decisionId));
      data.relations = data.relations.filter((item) => ids.has(item.from) && ids.has(item.to));
      data.events = data.events.filter((item) => item.project === project && (!item.relationId || data.relations.some((relation) => relation.id === item.relationId)));
      data.journal = data.journal.filter((item) => item.project === project);
    }
    // B-4: the journal payload is redacted like every other surface. A secret must
    // not survive in the audit trail just because it was also written there.
    const baselineKey = (entry) => JSON.stringify([entry?.id ?? null, entry?.seq ?? null]);
    const baselineCollections = (entry) => JSON.stringify([
      entry?.payload?.records ?? [], entry?.payload?.facts ?? [],
      entry?.payload?.relations ?? [], entry?.payload?.idempotency ?? []
    ]);
    const originalBaselineCollections = new Map(data.journal
      .filter((entry) => entry?.type === 'projection.baseline')
      .map((entry) => [baselineKey(entry), baselineCollections(entry)]));
    const transformed = transform(data);
    for (const entry of transformed.journal) {
      if (entry?.type !== 'projection.baseline') continue;
      const original = originalBaselineCollections.get(baselineKey(entry));
      if (original !== undefined && original !== baselineCollections(entry)) sanitizeRewrittenBaseline(entry);
    }
    return transformed;
  }

  function projectSummary(project) {
    if (typeof project !== 'string' || !project.trim()) throw new Error('A project name is required');
    const recordsForProject = [...records.values()].filter((item) => item.project === project);
    const ids = new Set(recordsForProject.map((item) => item.id));
    for (const record of recordsForProject) for (const alternative of record.alternatives ?? []) ids.add(alternative.id);
    for (const fact of facts.values()) if (fact.project === project) ids.add(fact.id);
    return { project, records: recordsForProject.length, facts: [...facts.values()].filter((item) => item.project === project).length, relations: [...relations.values()].filter((item) => ids.has(item.from) || ids.has(item.to)).length, events: events.filter((item) => item.project === project || ids.has(item.recordId) || ids.has(item.factId)).length, journal: journal.filter((item) => item.project === project).length };
  }

  // G5: `mode` defaults to a LOGICAL purge. Content is removed and an auditable
  // skeleton remains, so a rebuild does not resurrect purged data and the history
  // that a purge happened survives. `hard` physically removes journal entries,
  // which creates a seq gap — declared by validate(), never hidden. This is why
  // the journal is documented as append-ORIENTED, never append-only.
  function purgeProject(project, purgeOptions = {}) {
    const mode = purgeOptions.mode ?? (purgeOptions.hard === true ? 'hard' : 'logical');
    if (!['logical', 'hard'].includes(mode)) throw new Error('Purge mode must be logical or hard');
    const summary = projectSummary(project);
    const projectRecords = [...records.values()].filter((item) => item.project === project);
    const removed = new Set(projectRecords.map((item) => item.id));
    for (const record of projectRecords) for (const alternative of record.alternatives ?? []) removed.add(alternative.id);
    for (const fact of facts.values()) if (fact.project === project) removed.add(fact.id);
    const removedRelationIds = new Set([...relations]
      .filter(([, relation]) => removed.has(relation.from) || removed.has(relation.to))
      .map(([relationId]) => relationId));
    const idempotencyKeysToRemove = [...idempotency]
      .filter(([, value]) => value?.project === project || removed.has(value?.id))
      .map(([key]) => key);
    const eventsToRemove = new Set(events.filter((item) => (
      item.project === project
      || removed.has(item.recordId)
      || removed.has(item.factId)
      || (item.relationId && (removedRelationIds.has(item.relationId) || !relations.has(item.relationId)))
    )));

    // Stage every journal rewrite and fully validate the marker before touching any
    // live collection. In particular, sequence overflow must leave records, facts,
    // relations, events, idempotency, and the original journal byte-for-byte equal.
    const stagedJournal = clone(journal);
    let journalEntriesRedacted = 0;
    let journalEntriesRemoved = 0;
    const removedJournalSequences = mode === 'hard'
      ? stagedJournal
        .filter((item) => item.type === 'project.purged' && item.project === project && item.payload?.mode === 'hard')
        .flatMap((item) => Array.isArray(item.payload?.removedJournalSequences) ? item.payload.removedJournalSequences.filter(Number.isInteger) : [])
      : [];
    if (mode === 'hard') {
      for (let index = stagedJournal.length - 1; index >= 0; index -= 1) {
        const item = stagedJournal[index];
        if (item.project === project || removed.has(item.entityId) || removedRelationIds.has(item.entityId)) {
          if (Number.isInteger(item.seq)) removedJournalSequences.push(item.seq);
          stagedJournal.splice(index, 1);
          journalEntriesRemoved += 1;
        }
      }
    } else {
      for (const item of stagedJournal) {
        if (item.type === 'project.purged' && item.project === project && item.payload?.mode === 'hard') continue;
        if (item.project === project || removed.has(item.entityId) || removedRelationIds.has(item.entityId)) {
          if (item.payload !== null || item.redacted !== true) journalEntriesRedacted += 1;
          scrubLogicalPurgeSkeleton(item);
        }
      }
    }
    for (const item of stagedJournal) rewriteBaselineForProjectPurge(item, project, removed, removedRelationIds);
    const uniqueRemovedJournalSequences = [...new Set(removedJournalSequences)].sort((left, right) => left - right);
    const purgeEntry = prebuildJournalEntry({
      type: 'project.purged', entityKind: 'project', entityId: null, project,
      payload: { project, mode, removed: removed.size, removedJournalSequences: uniqueRemovedJournalSequences }
    }, journalSeq + 1);
    stagedJournal.push(purgeEntry);
    const stagedJournalEpoch = journalEpoch ?? purgeEntry.seq;
    const purgeArtifactIssue = stagedJournal.map((entry) => schema5PurgeArtifactIssue(entry, SCHEMA_VERSION)).find(Boolean);
    if (purgeArtifactIssue) throw new Error(`Refusing purge with noncanonical schema 5 purge artifact: ${purgeArtifactIssue}`);
    assertJournalBaselinePlacement(stagedJournal, {
      journalEpoch: stagedJournalEpoch,
      sourceSchemaVersion: SCHEMA_VERSION
    });
    assertHardPurgeGapLedgers(stagedJournal, {
      journalEpoch: stagedJournalEpoch,
      sourceSchemaVersion: SCHEMA_VERSION
    });

    for (const [recordId, record] of records) if (record.project === project) records.delete(recordId);
    for (const [scopeKey, memory] of currentMemories) if (memory.project === project) currentMemories.delete(scopeKey);
    for (const [factId, fact] of facts) if (fact.project === project) facts.delete(factId);
    for (const relationId of removedRelationIds) relations.delete(relationId);
    for (const [key, fact] of currentFacts) if (removed.has(fact.id)) currentFacts.delete(key);
    for (const [key, signal] of reviewSignals) if (removed.has(signal.decisionId)) reviewSignals.delete(key);
    for (const key of idempotencyKeysToRemove) idempotency.delete(key);
    filterInPlace(events, (item) => !eventsToRemove.has(item));
    journal.splice(0, journal.length, ...stagedJournal);
    journalSeq = purgeEntry.seq;
    journalEpoch = stagedJournalEpoch;

    return {
      ...summary,
      removed: removed.size,
      mode,
      journalEntriesRedacted,
      journalEntriesRemoved,
      removedJournalSequences: uniqueRemovedJournalSequences,
      idempotencyRemoved: idempotencyKeysToRemove.length,
      journalEntryId: purgeEntry.id
    };
  }

  // Diagnostics distinguish three different problems (see api-reference.md):
  //   error       — genuinely invalid data that code produced wrongly
  //   legacy      — older data that is readable but pre-dates a contract
  //   unsupported — data from a newer/unknown schema this build cannot interpret
  function validate() {
    const issues = [];
    const push = (severity, code, extra) => issues.push({ code, severity, ...extra });
    for (const relation of relations.values()) {
      if (!entity(relation.from)) push('error', 'missing_relation_source', { relationId: relation.id, entityId: relation.from });
      if (!entity(relation.to)) push('error', 'missing_relation_target', { relationId: relation.id, entityId: relation.to });
    }
    for (const record of records.values()) if (record.kind === 'decision') {
      if (record.supersededBy === record.id) push('error', 'self_supersession', { recordId: record.id });
      const current = record.confidence?.current;
      if (!Number.isFinite(current) || current < 0 || current > 1) push('error', 'invalid_confidence', { recordId: record.id });
      if (record.status === undefined || record.status === null) push('legacy', 'legacy_missing_decision_status', { recordId: record.id, status: null });
      else if (!DECISION_STATUSES.includes(record.status)) push('error', 'unknown_decision_status', { recordId: record.id, status: record.status });
      if (record.confidence && !record.confidence.basis) push('legacy', 'legacy_confidence_without_basis', { recordId: record.id });
      if (record.confidence?.policy && record.confidence.policy !== CONFIDENCE_POLICY) push('unsupported', 'unsupported_confidence_policy', { recordId: record.id, policy: record.confidence.policy });
      if (record.confidence?.basis?.policy && record.confidence.basis.policy !== record.confidence.policy) push('error', 'confidence_policy_mismatch', { recordId: record.id, policy: record.confidence.policy, basisPolicy: record.confidence.basis.policy });
    }
    for (const fact of facts.values()) {
      if (!SOURCE_CLASSES.includes(fact.sourceClass)) push('legacy', 'legacy_fact_source_class', { recordId: fact.id, sourceClass: fact.sourceClass ?? null });
      if (!VERIFICATION_STATUSES.includes(fact.verificationStatus)) push('error', 'unknown_verification_status', { recordId: fact.id, verificationStatus: fact.verificationStatus ?? null });
      const intervalIssue = factEffectiveExpirationIntervalIssue(fact);
      if (intervalIssue) push('error', 'contradictory_fact_interval', { recordId: fact.id, detail: intervalIssue });
    }
    for (const entry of journal) {
      const sequenceIssue = journalEntrySequenceIssue(entry, { allowLegacyMetadata: true });
      if (sequenceIssue) {
        push('error', 'invalid_journal_sequence', {
          entryId: entry?.id ?? null,
          seq: entry?.seq ?? null,
          type: entry?.type ?? null,
          detail: sequenceIssue
        });
        continue;
      }
      if (entry.seq === undefined) {
        if (entry.schemaVersion === undefined && entry.type !== 'legacy_metadata_event') {
          // Unversioned compatibility arrays remain readable/rebuild-declared, but
          // validate cannot prove which legacy envelope admitted them.
          push('error', 'journal_entry_without_sequence', { entryId: entry.id ?? null, type: entry.type ?? null });
        } else {
          push('legacy', 'legacy_metadata_without_sequence', { entryId: entry.id ?? null, type: entry.type ?? null });
        }
        continue;
      }
      const purgeArtifactIssue = schema5PurgeArtifactIssue(entry, SCHEMA_VERSION);
      if (purgeArtifactIssue) push('error', 'noncanonical_schema5_purge_artifact', { entryId: entry.id ?? null, seq: entry.seq ?? null, detail: purgeArtifactIssue });
      const journalFacts = entry.type === 'projection.baseline' ? (entry.payload?.facts ?? []) : entry.payload?.kind === 'fact' ? [entry.payload] : [];
      for (const fact of journalFacts) {
        const intervalIssue = factEffectiveExpirationIntervalIssue(fact);
        if (intervalIssue) push('error', 'contradictory_journal_fact_interval', { entryId: entry.id ?? null, seq: entry.seq ?? null, recordId: fact.id ?? null, detail: intervalIssue });
      }
      if (!JOURNAL_ENTRY_TYPES.includes(entry.type)) push('unsupported', 'unsupported_journal_entry', { entryId: entry.id, seq: entry.seq ?? null, type: entry.type ?? null });
      else if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion > SCHEMA_VERSION) push('unsupported', 'unsupported_journal_schema_version', { entryId: entry.id, seq: entry.seq, schemaVersion: entry.schemaVersion });
    }
    for (const issue of journalBaselinePlacementIssues(journal, {
      journalEpoch,
      sourceSchemaVersion: SCHEMA_VERSION
    })) {
      push('error', issue.code, { seq: issue.seq, type: issue.type, placement: issue.placement, detail: issue.detail });
    }
    // P2-12: a repeated `seq` cannot be totally ordered, so the fold's outcome
    // would depend on file order. That is an error, not an advisory.
    for (const duplicate of duplicateSequences(journal)) push('error', 'duplicate_journal_sequence', duplicate);
    // P2-14: live records/facts written by a NEWER build. They are preserved
    // verbatim (never downgraded) and reported so a caller knows this build
    // cannot fully interpret them.
    for (const record of records.values()) {
      if (Number.isInteger(record.schemaVersion) && record.schemaVersion > SCHEMA_VERSION) push('unsupported', 'unsupported_record_schema_version', { recordId: record.id, schemaVersion: record.schemaVersion });
    }
    for (const fact of facts.values()) {
      if (Number.isInteger(fact.schemaVersion) && fact.schemaVersion > SCHEMA_VERSION) push('unsupported', 'unsupported_fact_schema_version', { recordId: fact.id, schemaVersion: fact.schemaVersion });
    }
    // P2-15: the invariant is ONE active fact per (project, key). More than one is
    // corrupt data: import applies a deterministic recency rule so behaviour is
    // stable, but the ambiguity is still declared rather than hidden.
    const activeScopes = new Map();
    for (const fact of facts.values()) {
      if (fact.status !== 'active') continue;
      const scope = `${fact.project ?? 'default'}::${fact.key}`;
      activeScopes.set(scope, (activeScopes.get(scope) ?? 0) + 1);
    }
    for (const [scope, count] of activeScopes) if (count > 1) push('error', 'duplicate_active_fact_scope', { scope, count });
    const activeMemoryScopes = new Map();
    for (const record of records.values()) {
      if (record.kind !== 'memory' || record.status !== 'active') continue;
      const scope = memoryScopeKey(record);
      activeMemoryScopes.set(scope, (activeMemoryScopes.get(scope) ?? 0) + 1);
    }
    for (const [scope, count] of activeMemoryScopes) if (count > 1) push('error', 'duplicate_active_memory_scope', { scope, count });
    for (const gap of journalGaps(journal)) push('info', 'journal_gap', gap);
    // `valid` is false for genuine errors AND for data this build cannot
    // interpret. Saying "valid" while holding an unsupported schema would be a
    // claim we cannot support. `legacy` and `info` do NOT invalidate: readable
    // older data is not broken data.
    const severityCount = (name) => issues.filter((issue) => issue.severity === name).length;
    return {
      valid: !issues.some((issue) => issue.severity === 'error' || issue.severity === 'unsupported'),
      issues,
      counts: { error: severityCount('error'), legacy: severityCount('legacy'), unsupported: severityCount('unsupported'), info: severityCount('info') }
    };
  }

  function repairPlan() { return { apply: false, actions: validate().issues.map((issue) => issue.code.startsWith('missing_relation_') ? { action: 'remove_relation', relationId: issue.relationId, reason: issue.code } : { action: 'manual_review', ...issue }) }; }

  // ---- G6 / G7 read paths -------------------------------------------------
  function matchesFilters(record, options) {
    if (options.project && record.project !== options.project) return false;
    if (options.status && record.status !== options.status) return false;
    if (options.kind && record.kind !== options.kind) return false;
    if (options.sourceClass && record.sourceClass !== options.sourceClass) return false;
    if (options.minConfidence !== undefined && (record.confidence?.current ?? 0) < options.minConfidence) return false;
    return true;
  }

  function appliedFilters(options) {
    return Object.fromEntries(SEARCH_FILTERS.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));
  }

  function rank(query = '', options = {}) {
    if (options.project !== undefined) normalizeProject(options.project);
    const memoryProject = normalizeProject(options.project);
    const memoryScope = normalizeMemoryScope(options.scope);
    const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const record of records.values()) {
      if (!matchesFilters(record, options)) continue;
      if (record.kind === 'memory' && (record.project !== memoryProject || !sameMemoryScopeValues(record.scope, memoryScope))) continue;
      // G7: a term must match a DECLARED CONTENT FIELD. Schema keys and internal
      // metadata are not content, so `search('confidence')` no longer matches a
      // record merely because it has a confidence field.
      const perTerm = terms.map((term) => matchFields(record, term));
      if (terms.length && perTerm.some((fields) => fields.length === 0)) continue;
      const matched = [...new Set(perTerm.flat())];
      hits.push({
        record: clone(record),
        score: terms.length ? score(record, terms) : 0,
        matched,
        reason: terms.length ? `Matched ${matched.join(', ')}` : 'Matched filters only',
        matchedBy: terms.length ? 'content' : 'filter',
        filters: appliedFilters(options)
      });
    }
    return hits.sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)));
  }

  function search(query = '', options = {}) {
    const hits = rank(query, options);
    return paginate(hits, options, { project: options.project ?? 'all', query: String(query), filters: appliedFilters(options) }, { contentFields: [...CONTENT_SEARCH_FIELDS] });
  }

  function retrieve(query = '', options = {}) {
    const hits = rank(query, options);
    const memoryProject = normalizeProject(options.project);
    const memoryScope = normalizeMemoryScope(options.scope);
    const directIds = new Set(hits.map((item) => item.record.id));
    const results = hits.map((item) => ({ ...item, graphBoost: 0, reasons: [item.reason] }));
    for (const relation of relations.values()) {
      const relatedId = directIds.has(relation.from) ? relation.to : directIds.has(relation.to) ? relation.from : null;
      const related = relatedId && entity(relatedId);
      if (related && related.kind !== 'alternative' && (!options.project || related.project === options.project) && (related.kind !== 'memory' || (related.project === memoryProject && sameMemoryScopeValues(related.scope, memoryScope))) && !directIds.has(relatedId)) {
        results.push({ record: clone(related), score: 1, graphBoost: 1, matched: ['relationship'], matchedBy: 'graph', reason: `Related by ${relation.relation}`, reasons: [`Related by ${relation.relation}`], filters: appliedFilters(options) });
        directIds.add(relatedId);
      }
    }
    const sorted = results.sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)));
    return paginate(sorted, options, { project: options.project ?? 'all', query: String(query), filters: appliedFilters(options) }, { includesGraphNeighbours: true, contentFields: [...CONTENT_SEARCH_FIELDS] });
  }

  function recall(query = '', options = {}) {
    validateTemporalFields(options, ['asOf', 'currentAt']);
    const recallOptions = { ...options, project: normalizeProject(options.project), scope: normalizeMemoryScope(options.scope), currentAt: options.currentAt ?? (options.asOf ? null : now()) };
    const result = hybridSearch(exportData(), query, recallOptions);
    const envelope = paginate(
      result.items,
      recallOptions,
      { project: recallOptions.project, scope: recallOptions.scope, query: String(query), asOf: options.asOf ?? null },
      { signals: result.signals, ranking: result.ranking }
    );
    return { ...envelope, signals: result.signals, ranking: result.ranking };
  }

  // context() returns several collections. Each one declares its own total and
  // whether it was truncated, so a caller can never be silently short-changed.
  function context(input = {}) {
    const project = normalizeProject(input.project);
    const limit = input.limit;
    const collect = (items) => {
      const page = resolvePage({ limit, offset: 0 }, items.length);
      return { items: items.slice(0, page.limit), total: items.length, returned: Math.min(page.limit, items.length), hasMore: page.limit < items.length };
    };
    const activeDecisions = collect([...records.values()].filter((x) => x.kind === 'decision' && x.project === project && CURRENT_DECISION_STATUSES.includes(x.status)).map(clone));
    const staleAssumptions = collect([...facts.values()].filter((x) => x.project === project && x.status !== 'active').map(clone));
    const failedAttemptsToAvoid = collect([...records.values()].filter((x) => x.kind === 'attempt' && x.project === project && /fail|regression|error/i.test(x.result)).map(clone));
    const openReviews = collect(review({ project, changedFacts: input.changedFacts ?? [], facts: input.facts ?? {} }));
    const suggestedQuestions = collect([...records.values()].filter((x) => x.kind === 'decision' && x.project === project && (x.confidence?.current ?? 0) < 0.5).map((x) => `What evidence could change the decision: ${x.title}?`));
    const groups = { activeDecisions, staleAssumptions, failedAttemptsToAvoid, openReviews, suggestedQuestions };
    return {
      project,
      activeDecisions: activeDecisions.items,
      staleAssumptions: staleAssumptions.items,
      failedAttemptsToAvoid: failedAttemptsToAvoid.items,
      openReviews: openReviews.items,
      suggestedQuestions: suggestedQuestions.items,
      completeness: {
        scope: { project },
        complete: Object.values(groups).every((group) => !group.hasMore),
        limitSource: limit === undefined ? 'default' : 'caller',
        losslessItems: true,
        collections: Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { returned: group.returned, total: group.total, hasMore: group.hasMore, omitted: group.total - group.returned }]))
      }
    };
  }

  function exportData() {
    return {
      schemaVersion: SCHEMA_VERSION, revision,
      records: [...records.values()].map(clone), facts: [...facts.values()].map(clone),
      relations: [...relations.values()].map(clone), reviewSignals: [...reviewSignals.values()].map(clone),
      idempotency: [...idempotency.entries()].map(([key, value]) => ({ key, value: clone(canonicalIdempotencyValue(value)) })),
      events: clone(events), journal: clone(journal), journalSeq, journalEpoch
    };
  }

  // P0-2: ATOMIC. The previous implementation cleared every map and THEN parsed
  // the incoming data, so a malformed payload — or a throw anywhere in migration —
  // destroyed the live graph and left nothing to fall back to. That is the worst
  // possible failure mode for a recovery path (`restore`, revision-conflict
  // reload), because the operation that runs when something is already wrong was
  // itself capable of losing everything.
  //
  // Now the data is built into an INDEPENDENT staging graph and checked first.
  // Nothing in this graph is touched until the staged result is known good, so a
  // failed replace leaves the current state exactly as it was.
  function replaceData(data = []) {
    const staging = createShadowGraph({ now, verifier });
    // Any parse/migration failure throws HERE, before a single live map is cleared.
    try {
      staging.importData(data);
    } catch (cause) {
      const error = new Error(`Refusing to replace data: ${cause.message}`);
      if (cause.code !== undefined) error.code = cause.code;
      if (cause.issues !== undefined) error.issues = cause.issues;
      error.cause = cause;
      throw error;
    }
    const check = staging.validate();
    const blocking = check.issues.filter((issue) => issue.severity === 'error');
    if (blocking.length) {
      const error = new Error(`Refusing to replace data: ${blocking.length} blocking issue(s) — ${[...new Set(blocking.map((issue) => issue.code))].join(', ')}`);
      error.issues = blocking;
      throw error;
    }
    // The staged snapshot is already migrated and validated, so this import cannot
    // fail. Only now is the live state discarded.
    const staged = staging.exportData();
    records.clear(); currentMemories.clear(); facts.clear(); currentFacts.clear(); relations.clear(); reviewSignals.clear(); idempotency.clear();
    events.length = 0; journal.length = 0; revision = 0; journalSeq = 0; journalEpoch = null;
    return importData(staged);
  }

  function importData(data = []) {
    const source = Array.isArray(data) ? { records: data } : data;
    if (source === null || typeof source !== 'object') throw new Error('Import data must be an object or an array of records');
    // P0-2 / P2-14: the ENVELOPE schemaVersion describes the shape of the whole
    // payload, so a version this build does not know is not something to downgrade
    // silently or half-read — the fields we would ignore might be the ones that
    // change the meaning of the fields we do read. Refuse it.
    //
    // This throw is also what makes replaceData() atomic: it fires inside the
    // staging graph, before a single live map has been cleared.
    //
    // Note the asymmetry with individual records/facts, which are PRESERVED
    // verbatim at their own future version and reported by validate(). A future
    // envelope means "this file is unreadable"; a future record means "one entity
    // came from a newer build" and losing it would be worse than keeping it.
    if (source.schemaVersion !== undefined && !Number.isInteger(source.schemaVersion)) {
      throw new Error('Data schemaVersion must be an integer when provided');
    }
    if (Number.isInteger(source.schemaVersion) && !SUPPORTED_SCHEMA_VERSIONS.includes(source.schemaVersion)) {
      const error = new Error(`Unsupported data schemaVersion ${source.schemaVersion}: this build supports ${SUPPORTED_SCHEMA_VERSIONS.join(', ')}`);
      error.code = 'unsupported_schema_version';
      error.schemaVersion = source.schemaVersion;
      throw error;
    }
    validateImportShape(source);
    // Preflight every migration and clone before changing any live collection.
    // Direct import is intentionally merge-oriented, but a malformed entity must
    // never leave a partially merged graph behind.
    const importedRecords = (source.records ?? []).map((item) => migrateRecord(item));
    const importedFacts = (source.facts ?? []).map((fact, index, allFacts) => {
      const factId = fact.id ?? legacyFactId(fact, index, allFacts);
      return migrateFact({ ...fact, id: factId });
    });
    const trustedValidationInstant = verifier && importedFacts.some((fact) => fact.verification) ? now() : null;
    for (const fact of importedFacts) {
      if (fact.verification) {
        if (verifier?.validateStored?.(fact, { trustedValidationInstant })) {
          if (fact.status === 'active') fact.verificationStatus = 'verified';
        }
        else if (verifier) throw new Error(`Persisted fact verification is invalid or expired at the trusted validation instant: ${fact.id}`);
        else {
          if (fact.status === 'active') fact.verificationStatus = 'unverified';
          fact.verificationUntrustedReason = 'verifier_not_configured';
        }
      } else if (fact.verificationStatus === 'verified') {
        fact.legacyVerificationStatus = 'verified';
        fact.verificationStatus = 'unverified';
      }
    }
    const importedRelations = (source.relations ?? []).map((relation) => clone(relation));
    const importedJournal = Array.isArray(source.journal) ? source.journal.map((item) => clone(item)) : [];
    const importedSignals = (source.reviewSignals ?? []).map((signal) => clone(signal));
    const importedIdempotency = (source.idempotency ?? []).map((item) => ({ key: importIdempotencyKey(item.key, item.value), value: clone(item.value) }));
    const importedEvents = (source.events ?? []).map((item) => clone(item));
    let pendingMigrationBaseline = null;
    let pendingJournalEntries = [];
    let pendingJournalSequence = null;
    let pendingJournalEpoch = null;
    let pendingIdempotencyUpdates = importedIdempotency;
    const candidateJournal = [...journal, ...importedJournal];
    let candidateMinimumSequence = null;
    for (const entry of candidateJournal) if (Number.isSafeInteger(entry?.seq)) {
      if (candidateMinimumSequence === null || entry.seq < candidateMinimumSequence) candidateMinimumSequence = entry.seq;
    }
    const candidateJournalEpoch = importedJournal.length
      ? (Number.isInteger(source.journalEpoch) ? source.journalEpoch : candidateMinimumSequence)
      : journalEpoch;
    migrateLegacyPurgeArtifacts({
      sourceSchemaVersion: source.schemaVersion,
      existingJournal: journal,
      importedJournal,
      importedRecords,
      importedFacts,
      importedRelations,
      importedSignals,
      importedIdempotency,
      importedEvents,
      journalEpoch: candidateJournalEpoch
    });
    const canonicalIdempotencyKeys = new Set();
    for (const item of importedIdempotency) {
      if (canonicalIdempotencyKeys.has(item.key)) throw new Error(`Duplicate canonical idempotency key ${item.key}`);
      canonicalIdempotencyKeys.add(item.key);
    }
    const legacyIdRemaps = new Map();
    if (!Number.isInteger(source.schemaVersion) || source.schemaVersion < GLOBAL_ENTITY_NAMESPACE_SCHEMA_VERSION) {
      const existingImportedIds = new Set([...importedRecords, ...importedFacts].map((item) => item.id));
      for (const item of importedIdempotency) {
        const value = item.value;
        if (!value?.id || existingImportedIds.has(value.id) || records.has(value.id) || facts.has(value.id)) continue;
        if (value.kind === 'fact') {
          const migrated = migrateFact(value);
          importedFacts.push(migrated);
          item.value = clone(migrated);
        } else if (['decision', 'attempt', 'memory'].includes(value.kind)) {
          const migrated = migrateRecord(value);
          importedRecords.push(migrated);
          item.value = clone(migrated);
        }
        else continue;
        existingImportedIds.add(value.id);
      }

      // Schemas 1–3 had collection-local ids. Schema 4 has one global entity
      // namespace, so ambiguous legacy collisions receive stable migrated ids
      // rather than silently overwriting one another or becoming backend-specific.
      const used = new Set();
      for (const [index, record] of importedRecords.entries()) {
        if (used.has(record.id)) {
          const previousId = record.id;
          record.id = legacyCollisionId(record.kind, record, index, used);
          legacyIdRemaps.set(`${record.kind}:${previousId}`, record.id);
        }
        used.add(record.id);
        for (const [alternativeIndex, alternative] of (record.alternatives ?? []).entries()) {
          if (used.has(alternative.id)) {
            const previousId = alternative.id;
            alternative.id = legacyCollisionId('alternative', alternative, alternativeIndex, used);
            legacyIdRemaps.set(`alternative:${previousId}`, alternative.id);
          }
          used.add(alternative.id);
        }
      }
      for (const [index, fact] of importedFacts.entries()) {
        if (used.has(fact.id)) {
          const previousId = fact.id;
          fact.id = legacyCollisionId('fact', fact, index, used);
          legacyIdRemaps.set(`fact:${previousId}`, fact.id);
        }
        used.add(fact.id);
      }
      for (const [index, relation] of importedRelations.entries()) {
        if (used.has(relation.id)) {
          const previousId = relation.id;
          relation.id = legacyCollisionId('relation', relation, index, used);
          legacyIdRemaps.set(`relation:${previousId}`, relation.id);
        }
        used.add(relation.id);
      }
      for (const item of importedIdempotency) {
        const remapped = legacyIdRemaps.get(`${item.value?.kind}:${item.value?.id}`);
        if (remapped) item.value.id = remapped;
      }
      for (const entry of importedJournal) {
        const kind = entry.entityKind ?? entry.payload?.kind;
        const remapped = legacyIdRemaps.get(`${kind}:${entry.entityId ?? entry.payload?.id}`);
        if (!remapped) continue;
        entry.entityId = remapped;
        if (entry.payload?.id !== undefined) entry.payload.id = remapped;
      }
    }
    {
      const importedAlternatives = importedRecords.flatMap((record) => record.alternatives ?? []);
      assertUniqueEntityIds(importedRecords, importedAlternatives, importedFacts, importedRelations);
      const existingAlternativeOwners = new Map();
      for (const record of records.values()) for (const alternative of record.alternatives ?? []) existingAlternativeOwners.set(alternative.id, record.id);
      for (const record of importedRecords) {
        const existingRecord = records.get(record.id);
        if (existingRecord && (existingRecord.kind !== record.kind || existingRecord.project !== record.project)) throw new Error(`Existing entity id ${record.id} cannot change kind or project`);
        if (existingRecord?.kind === 'memory' && memoryScopeKey(existingRecord) !== memoryScopeKey(record)) throw new Error(`Existing memory id ${record.id} cannot change scope, type, or key`);
        if (facts.has(record.id) || relations.has(record.id) || (existingAlternativeOwners.has(record.id) && existingAlternativeOwners.get(record.id) !== record.id)) throw new Error(`Entity id already exists: ${record.id}`);
        for (const alternative of record.alternatives ?? []) {
          const existingOwner = existingAlternativeOwners.get(alternative.id);
          if (records.has(alternative.id) || facts.has(alternative.id) || relations.has(alternative.id) || (existingOwner && existingOwner !== record.id)) throw new Error(`Entity id already exists: ${alternative.id}`);
        }
      }
      for (const fact of importedFacts) {
        if (records.has(fact.id) || relations.has(fact.id) || existingAlternativeOwners.has(fact.id)) throw new Error(`Entity id already exists: ${fact.id}`);
        const existingFact = facts.get(fact.id);
        if (existingFact && existingFact.project !== fact.project) throw new Error(`Existing entity id ${fact.id} cannot change kind or project`);
      }
      for (const relation of importedRelations) {
        if (records.has(relation.id) || facts.has(relation.id) || existingAlternativeOwners.has(relation.id)) throw new Error(`Entity id already exists: ${relation.id}`);
        const existingRelation = relations.get(relation.id);
        if (existingRelation && (existingRelation.project !== relation.project || existingRelation.from !== relation.from || existingRelation.to !== relation.to || existingRelation.relation !== relation.relation)) throw new Error(`Existing relation id ${relation.id} cannot change identity`);
      }
      const availableEntityIds = new Set([...records.keys(), ...facts.keys()]);
      const overwrittenRecordIds = new Set(importedRecords.map((record) => record.id));
      for (const [alternativeId, ownerId] of existingAlternativeOwners) if (!overwrittenRecordIds.has(ownerId)) availableEntityIds.add(alternativeId);
      for (const record of importedRecords) {
        availableEntityIds.add(record.id);
        for (const alternative of record.alternatives ?? []) availableEntityIds.add(alternative.id);
      }
      for (const fact of importedFacts) availableEntityIds.add(fact.id);
      if (Number.isInteger(source.schemaVersion) && source.schemaVersion >= GLOBAL_ENTITY_NAMESPACE_SCHEMA_VERSION) {
        for (const relation of importedRelations) {
          if (!availableEntityIds.has(relation.from) || !availableEntityIds.has(relation.to)) throw new Error('Relation endpoints must exist before import');
        }
        const finalRelations = new Map(relations);
        for (const relation of importedRelations) finalRelations.set(relation.id, relation);
        for (const relation of finalRelations.values()) {
          if (!availableEntityIds.has(relation.from) || !availableEntityIds.has(relation.to)) throw new Error('Relation endpoints must exist after import');
        }
      }
      const liveJournalIds = new Set(journal.map((entry) => entry.id));
      const liveJournalSequences = new Set(journal.filter((entry) => Number.isInteger(entry.seq)).map((entry) => entry.seq));
      for (const entry of importedJournal) {
        if (liveJournalIds.has(entry.id) || (Number.isInteger(entry.seq) && liveJournalSequences.has(entry.seq))) throw new Error('Journal id or sequence already exists');
      }
      assertJournalBaselinePlacement(candidateJournal, {
        journalEpoch: candidateJournalEpoch,
        sourceSchemaVersion: source.schemaVersion
      });
      assertHardPurgeGapLedgers(candidateJournal, {
        journalEpoch: candidateJournalEpoch,
        sourceSchemaVersion: source.schemaVersion
      });
      const liveEventIds = new Set(events.map((item) => item.id));
      for (const eventItem of importedEvents) if (liveEventIds.has(eventItem.id)) throw new Error(`Event id already exists: ${eventItem.id}`);
      const finalRecords = new Map(records);
      const finalFacts = new Map(facts);
      for (const record of importedRecords) finalRecords.set(record.id, record);
      for (const fact of importedFacts) finalFacts.set(fact.id, fact);
      const reviewOwners = new Map([...reviewSignals.values()].map((signal) => [signal.id, reviewSignalKey(signal.decisionId, signal.reason)]));
      const incomingReviewIds = new Set();
      const existingReviewIdentities = new Map([...reviewSignals.values()].map((signal) => [reviewSignalKey(signal.decisionId, signal.reason), signal.id]));
      const incomingReviewIdentities = new Set();
      for (const signal of importedSignals) {
        if (!signal || typeof signal.id !== 'string' || !signal.id || typeof signal.decisionId !== 'string' || !signal.decisionId || typeof signal.reason !== 'string' || !signal.reason) throw new Error('Review signal is malformed');
        if (incomingReviewIds.has(signal.id)) throw new Error(`Duplicate review signal id ${signal.id}`);
        incomingReviewIds.add(signal.id);
        const ownerKey = reviewSignalKey(signal.decisionId, signal.reason);
        if (incomingReviewIdentities.has(ownerKey) || (existingReviewIdentities.has(ownerKey) && existingReviewIdentities.get(ownerKey) !== signal.id)) throw new Error(`Duplicate review signal identity ${ownerKey}`);
        incomingReviewIdentities.add(ownerKey);
        if (reviewOwners.has(signal.id) && reviewOwners.get(signal.id) !== ownerKey) throw new Error(`Duplicate review signal id ${signal.id}`);
        const decision = finalRecords.get(signal.decisionId);
        if (!decision || decision.kind !== 'decision') throw new Error('Review signal must reference an existing decision');
      }
      for (const item of importedIdempotency) {
        const value = item.value;
        const entity = value?.kind === 'fact' ? finalFacts.get(value.id) : finalRecords.get(value?.id);
        if (typeof item.key !== 'string' || !value || typeof value !== 'object' || typeof value.id !== 'string' || !entity) throw new Error('Idempotency entry must reference an existing entity');
        const scope = value?.scope ?? {};
        const expectedKeyPrefix = value?.kind === 'memory'
          ? `memory:${value.project}:${JSON.stringify([scope.userId ?? null, scope.agentId ?? null, scope.runId ?? null, value.memoryType ?? null, value.key ?? null])}:`
          : `${value?.kind}:${value?.project}:`;
        if (entity.kind !== value.kind || entity.project !== value.project || !item.key.startsWith(expectedKeyPrefix)) throw new Error('Idempotency entry identity does not match its entity');
        if (value.kind === 'memory' && memoryScopeKey(entity) !== memoryScopeKey(value)) throw new Error('Idempotency entry identity does not match its entity');
        const migratedValue = value.kind === 'fact' ? migrateFact(value) : migrateRecord(value);
        if (!idempotencySemanticallyMatches(migratedValue, entity)) throw new Error(`Idempotency entry semantic mismatch with canonical entity ${value.id}`);
        item.value = clone(entity);
      }
    }
    if (!(Array.isArray(source.journal) && source.journal.length) && (importedRecords.length || importedFacts.length || importedRelations.length || importedIdempotency.length)) {
      const sameSnapshot = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
      const finalRecords = new Map(records);
      const finalFacts = new Map(facts);
      const finalRelations = new Map(relations);
      for (const item of importedRecords) finalRecords.set(item.id, item);
      for (const item of importedFacts) finalFacts.set(item.id, item);
      for (const item of importedRelations) finalRelations.set(item.id, item);

      const finalEntity = (value) => value?.kind === 'fact'
        ? finalFacts.get(value.id)
        : finalRecords.get(value?.id);
      const importedEntityIds = new Set([...importedRecords, ...importedFacts].map((item) => item.id));
      const finalIdempotency = new Map();
      for (const [key, value] of idempotency) {
        const currentValue = canonicalIdempotencyValue(value);
        const canonicalFinal = importedEntityIds.has(value?.id) ? finalEntity(value) : currentValue;
        if (!canonicalFinal) throw new Error('Idempotency entry must reference an existing entity');
        finalIdempotency.set(key, clone(canonicalFinal));
      }
      for (const item of importedIdempotency) finalIdempotency.set(item.key, clone(item.value));
      pendingIdempotencyUpdates = [...finalIdempotency.entries()].map(([key, value]) => ({ key, value: clone(value) }));

      const changedEntities = [];
      for (const item of importedRecords) {
        const previous = records.get(item.id);
        if (!previous || !sameSnapshot(previous, item)) changedEntities.push({ item, previous });
      }
      for (const item of importedFacts) {
        const previous = facts.get(item.id);
        if (!previous || !sameSnapshot(previous, item)) changedEntities.push({ item, previous });
      }
      for (const item of importedRelations) {
        const previous = relations.get(item.id);
        if (!previous || !sameSnapshot(previous, item)) changedEntities.push({ item, previous });
      }

      const changedMappings = [];
      for (const [key, value] of finalIdempotency) {
        const previous = idempotency.has(key) ? canonicalIdempotencyValue(idempotency.get(key)) : null;
        if (!previous || !sameSnapshot(previous, value)) changedMappings.push({ key, value, previous });
      }
      const overwritesExistingState = changedEntities.some(({ previous }) => Boolean(previous))
        || changedMappings.some(({ key }) => idempotency.has(key));
      const addsUnseenEntity = changedEntities.some(({ previous }) => !previous);
      const alreadyHasBaseline = journal.some((entry) => entry.type === 'projection.baseline' && entry.replayable !== false);
      const useMigrationBaseline = !overwritesExistingState && addsUnseenEntity && !alreadyHasBaseline;

      let nextSequence = Math.max(journalSeq, Number.isSafeInteger(source.journalSeq) ? source.journalSeq : 0);
      const reserveSequence = () => {
        if (nextSequence >= Number.MAX_SAFE_INTEGER) throw new Error('Journal sequence overflow while prebuilding a journal-less merge');
        nextSequence += 1;
        return nextSequence;
      };
      const prebuilt = [];
      const prebuildLegacyEvents = () => {
        for (const legacyEvent of importedEvents) {
          const entry = prebuildJournalEntry({
            id: legacyEvent.id,
            type: 'legacy_metadata_event',
            at: legacyEvent.at ?? null,
            project: legacyEvent.project ?? null,
            entityKind: null,
            entityId: legacyEvent.recordId ?? legacyEvent.factId ?? null,
            schemaVersion: 2,
            payload: null,
            provenance: { actor: null, client: null, sessionId: null }
          }, reserveSequence());
          entry.replayable = false;
          entry.originalType = legacyEvent.type;
          prebuilt.push(entry);
        }
      };

      const endpointProject = (entityId) => finalRecords.get(entityId)?.project ?? finalFacts.get(entityId)?.project ?? null;
      const snapshotType = (item, previous) => {
        if (item.kind === 'memory') {
          if (item.status === 'invalidated') return 'memory.invalidated';
          if (item.status === 'superseded') return 'memory.superseded';
          return 'memory.recorded';
        }
        if (item.kind === 'fact') {
          if (item.status === 'expired') return 'fact.expired';
          if (item.status === 'superseded') return 'fact.superseded';
          if (item.verificationStatus === 'verified' && item.verification) return 'fact.verified';
          return 'fact.observed';
        }
        if (item.kind === 'decision') return 'decision.recorded';
        if (item.kind === 'attempt') return 'attempt.recorded';
        if (item.kind === 'relation') return 'relation.created';
        throw new Error(`Cannot journal imported entity kind ${item.kind}`);
      };
      const originalEntity = (item) => item.kind === 'fact'
        ? facts.get(item.id)
        : item.kind === 'relation'
          ? relations.get(item.id)
          : records.get(item.id);
      const prebuildSnapshot = (item, idempotencyKey) => prebuilt.push(prebuildJournalEntry({
        type: snapshotType(item, originalEntity(item)),
        entityKind: item.kind,
        entityId: item.id,
        project: item.project ?? (item.kind === 'relation' ? (endpointProject(item.from) ?? endpointProject(item.to)) : null),
        payload: item,
        provenance: writeProvenance(item),
        idempotencyKey
      }, reserveSequence()));

      if (changedEntities.length || changedMappings.length) {
        prebuildLegacyEvents();
        if (useMigrationBaseline) {
          pendingMigrationBaseline = {
            records: [...finalRecords.values()].map(clone),
            facts: [...finalFacts.values()].map(clone),
            relations: [...finalRelations.values()].map(clone),
            idempotency: [...finalIdempotency.entries()].map(([key, value]) => ({ key, value: clone(value) }))
          };
          const baseline = prebuildJournalEntry({
            type: 'projection.baseline', entityKind: null, entityId: null, project: null,
            payload: pendingMigrationBaseline,
            provenance: { actor: null, client: null, sessionId: null }
          }, reserveSequence());
          baseline.derivedFrom = 'live_state_at_migration';
          prebuilt.push(baseline);
        } else {
          const mappingsByEntity = new Map();
          for (const mapping of changedMappings) {
            if (!mappingsByEntity.has(mapping.value.id)) mappingsByEntity.set(mapping.value.id, []);
            mappingsByEntity.get(mapping.value.id).push(mapping);
          }
          const consumedMappingKeys = new Set();
          for (const { item } of changedEntities) {
            const mapping = mappingsByEntity.get(item.id)?.[0];
            if (mapping) consumedMappingKeys.add(mapping.key);
            prebuildSnapshot(item, mapping?.key);
          }
          for (const mapping of changedMappings) {
            if (consumedMappingKeys.has(mapping.key)) continue;
            const item = finalEntity(mapping.value);
            if (!item) throw new Error('Idempotency entry must reference an existing entity');
            prebuildSnapshot(item, mapping.key);
          }
        }
      }

      if (prebuilt.length) {
        const generatedEpoch = journalEpoch ?? prebuilt.find((entry) => REPLAYABLE_ENTRY_TYPES.includes(entry.type) && entry.replayable !== false)?.seq ?? null;
        const combinedJournal = [...journal, ...prebuilt];
        const seenJournalIds = new Set();
        for (const entry of combinedJournal) {
          if (seenJournalIds.has(entry.id)) throw new Error(`Duplicate journal id ${entry.id}`);
          seenJournalIds.add(entry.id);
        }
        assertJournalBaselinePlacement(combinedJournal, {
          journalEpoch: generatedEpoch,
          sourceSchemaVersion: SCHEMA_VERSION
        });
        assertHardPurgeGapLedgers(combinedJournal, {
          journalEpoch: generatedEpoch,
          sourceSchemaVersion: SCHEMA_VERSION
        });
        const lifecycleIssues = journalFactLifecycleIssues(combinedJournal, {
          journalEpoch: generatedEpoch,
          sourceSchemaVersion: SCHEMA_VERSION
        });
        if (lifecycleIssues.length) {
          const first = lifecycleIssues[0];
          throw new Error(`Journal fact lifecycle is non-monotonic at sequence ${first.seq}: ${first.detail}`);
        }

        if (!useMigrationBaseline) {
          // Overwrite deltas promise exact current projection parity. Legacy
          // baseline migration remains permissive for declared-invalid artifacts
          // such as a dangling relation that old readers retained but traversal
          // already ignored; replace/restore validation continues to reject it.
          const sortById = (items) => [...items].sort((left, right) => String(left.id).localeCompare(String(right.id)));
          const sortIdempotency = (items) => [...items].sort((left, right) => left.key.localeCompare(right.key));
          const expectedProjection = {
            records: sortById([...finalRecords.values()].map(clone)),
            facts: sortById([...finalFacts.values()].map(clone)),
            relations: sortById([...finalRelations.values()].map(clone)),
            idempotency: sortIdempotency([...finalIdempotency.entries()].map(([key, value]) => ({ key, value: clone(value) })))
          };
          const rebuilt = rebuildProjection(combinedJournal, { journalEpoch: generatedEpoch }).projection;
          const rebuiltProjection = {
            records: sortById(rebuilt.records), facts: sortById(rebuilt.facts),
            relations: sortById(rebuilt.relations), idempotency: sortIdempotency(rebuilt.idempotency)
          };
          if (!sameSnapshot(rebuiltProjection, expectedProjection)) {
            throw new Error('Journal-less merge snapshot deltas do not reproduce the final live projection');
          }
        }
        pendingJournalEntries = prebuilt;
        pendingJournalSequence = nextSequence;
        pendingJournalEpoch = generatedEpoch;
      }
    }
    revision = Number.isInteger(source.revision) ? Math.max(revision, source.revision) : revision;
    for (const item of importedRecords) records.set(item.id, item);
    currentMemories.clear();
    const memoryScopeCandidates = new Map();
    for (const item of records.values()) {
      if (item.kind !== 'memory' || item.status !== 'active') continue;
      const scope = memoryScopeKey(item);
      if (!memoryScopeCandidates.has(scope)) memoryScopeCandidates.set(scope, []);
      memoryScopeCandidates.get(scope).push(item);
    }
    for (const [scope, candidates] of memoryScopeCandidates) {
      const winner = [...candidates].sort((left, right) => {
        const byVersion = (right.version ?? 1) - (left.version ?? 1);
        if (byVersion !== 0) return byVersion;
        const byValidFrom = compareInstants(right.temporal?.validFrom, left.temporal?.validFrom);
        if (byValidFrom !== 0) return byValidFrom;
        const byRecordedAt = compareInstants(right.temporal?.recordedAt, left.temporal?.recordedAt);
        return byRecordedAt !== 0 ? byRecordedAt : String(right.id).localeCompare(String(left.id));
      })[0];
      currentMemories.set(scope, winner);
    }
    for (const fact of importedFacts) facts.set(fact.id, fact);
    currentFacts.clear();
    // P2-15: two ACTIVE facts can share a (project, key) scope in imported data.
    // Picking whichever arrived last made the winner depend on array order, so the
    // same file reordered produced a different current fact — and therefore
    // different reconsideration results. Recency is now a stable rule:
    // latest `observedAt`, and `id` as the tie-break so it is total. Ambiguity is
    // still reported by validate() rather than hidden.
    const scopeCandidates = new Map();
    for (const fact of facts.values()) {
      if (fact.status !== 'active') continue;
      const scope = JSON.stringify([fact.project ?? 'default', fact.key]);
      if (!scopeCandidates.has(scope)) scopeCandidates.set(scope, []);
      scopeCandidates.get(scope).push(fact);
    }
    for (const [scope, candidates] of scopeCandidates) {
      const winner = [...candidates].sort((left, right) => {
        const byObserved = compareInstants(right.observedAt, left.observedAt);
        return byObserved !== 0 ? byObserved : String(right.id ?? '').localeCompare(String(left.id ?? ''));
      })[0];
      currentFacts.set(scope, winner);
    }
    for (const relation of importedRelations) relations.set(relation.id, relation);
    for (const signal of importedSignals) reviewSignals.set(reviewSignalKey(signal.decisionId, signal.reason), signal);
    for (const item of pendingIdempotencyUpdates) idempotency.set(item.key, item.value);
    for (const importedEvent of importedEvents) events.push(importedEvent);

    if (importedJournal.length) {
      for (const importedEntry of importedJournal) journal.push(importedEntry);
      let minimumSequence = null;
      let maximumSequence = 0;
      for (const item of journal) if (Number.isInteger(item.seq)) {
        if (minimumSequence === null || item.seq < minimumSequence) minimumSequence = item.seq;
        if (item.seq > maximumSequence) maximumSequence = item.seq;
      }
      journalSeq = Math.max(journalSeq, Number.isInteger(source.journalSeq) ? source.journalSeq : 0, maximumSequence);
      // P2-11: Math.min(...[]) is Infinity. A journal whose entries carry no `seq`
      // at all must not silently produce an Infinity epoch that then excludes
      // every entry from the replay range while still reporting success.
      // journalEpoch stays null; rebuild derives its own start and reports the
      // unnumbered entries as non-replayable legacy.
      journalEpoch = Number.isInteger(source.journalEpoch) ? source.journalEpoch : minimumSequence;
    } else {
      // Preserve a declared high-water mark even when the journal was compacted
      // or intentionally exported empty. Otherwise the next append can reuse a
      // sequence number that was already issued before the empty snapshot.
      if (!pendingJournalEntries.length && Number.isInteger(source.journalSeq)) journalSeq = Math.max(journalSeq, source.journalSeq);
      // A journal-less merge does not own the destination's replay boundary. An
      // epoch from an actually empty initial envelope is retained for compatibility;
      // existing history keeps its original epoch.
      if (!pendingJournalEntries.length && journal.length === 0 && journalEpoch === null && Number.isInteger(source.journalEpoch)) journalEpoch = source.journalEpoch;
    }
    if (pendingJournalEntries.length) {
      // Every entry was fully built and validated against the combined journal
      // before any live map changed. Publish the exact batch as the final mutation.
      journal.push(...pendingJournalEntries);
      journalSeq = pendingJournalSequence;
      if (journalEpoch === null) journalEpoch = pendingJournalEpoch;
    }
    return records.size + facts.size + relations.size;
  }

  function getJournal(options = {}) {
    const project = options.project === undefined ? undefined : normalizeProject(options.project);
    const entries = journal.filter((entry) => project === undefined || entry.project === project);
    return paginate(entries.map(clone), options, { project: project ?? 'all' }, { journalEpoch, journalSeq, gaps: journalGaps(journal) });
  }

  // Rebuild a projection from this graph's own journal, then pass the exposed
  // projection through the same schema migration and verifier policy as a normal
  // import. The raw journal remains immutable audit evidence inside this graph.
  function rebuild(options = {}) {
    const report = rebuildProjection(clone(journal), {
      ...options,
      journalEpoch,
      sourceSchemaVersion: SCHEMA_VERSION
    });
    const versions = [...report.projection.records, ...report.projection.facts, ...report.projection.relations]
      .map((item) => item?.schemaVersion)
      .filter((value) => Number.isInteger(value) && SUPPORTED_SCHEMA_VERSIONS.includes(value));
    const envelope = {
      schemaVersion: versions.length ? Math.min(...versions) : SCHEMA_VERSION,
      records: report.projection.records,
      facts: report.projection.facts,
      relations: report.projection.relations,
      idempotency: report.projection.idempotency
    };
    const normalizeProjection = (policyVerifier) => {
      const staging = createShadowGraph({ now, verifier: policyVerifier });
      staging.importData(envelope);
      const validation = staging.validate();
      const blocking = validation.issues.filter((issue) => issue.severity === 'error' || issue.severity === 'unsupported');
      if (blocking.length) throw new Error(`Rebuilt projection has ${blocking.length} blocking validation issue(s)`);
      const normalized = staging.exportData();
      const preserveAuditKeyOrder = (item, rawById) => {
        const raw = rawById.get(item.id);
        if (!raw) return item;
        const ordered = {};
        for (const key of Object.keys(raw)) if (Object.hasOwn(item, key)) ordered[key] = item[key];
        for (const key of Object.keys(item)) if (!Object.hasOwn(ordered, key)) ordered[key] = item[key];
        return ordered;
      };
      const normalizeCollection = (items, rawItems) => {
        const rawById = new Map(rawItems.map((item) => [item.id, item]));
        return items.map((item) => preserveAuditKeyOrder(item, rawById));
      };
      return {
        schemaVersion: SCHEMA_VERSION,
        records: normalizeCollection(normalized.records, report.projection.records),
        facts: normalizeCollection(normalized.facts, report.projection.facts),
        relations: normalizeCollection(normalized.relations, report.projection.relations),
        idempotency: normalized.idempotency
      };
    };

    try {
      return { ...report, projection: normalizeProjection(verifier) };
    } catch (error) {
      let safeProjection;
      try { safeProjection = normalizeProjection(null); }
      catch { safeProjection = { schemaVersion: SCHEMA_VERSION, records: [], facts: [], relations: [], idempotency: [] }; }
      return {
        ...report,
        rebuildable: false,
        reason: 'journal projection is invalid under configured verification or schema policy',
        projection: safeProjection,
        skipped: [...report.skipped, {
          seq: null,
          type: null,
          why: 'invalid_exposed_projection_verification',
          detail: error.message
        }]
      };
    }
  }

  function stats() {
    const all = [...records.values()];
    return { schemaVersion: SCHEMA_VERSION, total: all.length, decisions: all.filter((x) => x.kind === 'decision').length, attempts: all.filter((x) => x.kind === 'attempt').length, facts: facts.size, relations: relations.size, reviewSignals: reviewSignals.size, events: events.length, journal: journal.length };
  }

  return {
    // Only direct public mutation entry points receive a transaction boundary.
    // Internal composition (applyMemoryPlan -> remember, supersedeDecision ->
    // link, maintain/context -> review, replaceData -> importData) stays inside
    // the outer transaction instead of recursively snapshotting or publishing a
    // partial nested operation. Read-only paths pay no snapshot cost.
    setRevision: transactional('setRevision', setRevision, { mode: 'none' }),
    replaceData: transactional('replaceData', replaceData, { mode: 'snapshot' }),
    addDecision: transactional('addDecision', addDecision),
    addAttempt: transactional('addAttempt', addAttempt),
    remember: transactional('remember', remember),
    applyMemoryPlan: transactional('applyMemoryPlan', applyMemoryPlan),
    memoryHistory,
    addFact: transactional('addFact', addFact),
    verifyFact: transactional('verifyFact', verifyFact),
    setOutcome: transactional('setOutcome', setOutcome),
    addConfidenceEvidence: transactional('addConfidenceEvidence', addConfidenceEvidence),
    updateDecisionStatus: transactional('updateDecisionStatus', updateDecisionStatus),
    supersedeDecision: transactional('supersedeDecision', supersedeDecision),
    link: transactional('link', link),
    traverse,
    redact,
    projectSummary,
    purgeProject: transactional('purgeProject', purgeProject, { mode: 'snapshot' }),
    review: transactional('review', review),
    maintain: transactional('maintain', maintain),
    getReviewSignals,
    acknowledgeReview: transactional('acknowledgeReview', acknowledgeReview),
    search,
    retrieve,
    recall,
    validate,
    repairPlan,
    context: transactional('context', context),
    exportData,
    importData: transactional('importData', importData),
    getJournal,
    rebuild,
    stats
  };
}

function normalizeRules(rules) { return rules.map((rule) => typeof rule === 'string' ? rule : { key: rule.key, operator: rule.operator ?? 'equals', value: rule.value }); }

function normalizeProject(value) {
  if (value === undefined || value === null) return 'default';
  if (typeof value !== 'string' || !value.trim()) throw new Error('project must be a non-empty string');
  return value;
}

function normalizeMemoryScope(scope = {}) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) throw new Error('Memory scope must be an object');
  const allowed = new Set(['userId', 'agentId', 'runId']);
  for (const name of Object.keys(scope)) if (!allowed.has(name)) throw new Error(`Memory scope contains unknown field ${name}`);
  const value = {};
  for (const name of ['userId', 'agentId', 'runId']) {
    if (scope[name] !== undefined && scope[name] !== null && typeof scope[name] !== 'string') throw new Error(`Memory scope ${name} must be a string or null`);
    value[name] = scope[name] ?? null;
  }
  return value;
}

function reviewSignalKey(decisionId, reason) {
  return JSON.stringify([decisionId, reason]);
}

function sameMemoryScopeValues(left, right) {
  const a = normalizeMemoryScope(left);
  const b = normalizeMemoryScope(right);
  return a.userId === b.userId && a.agentId === b.agentId && a.runId === b.runId;
}

function memoryScopeKey(input) {
  const scope = normalizeMemoryScope(input.scope);
  return JSON.stringify([normalizeProject(input.project), scope.userId, scope.agentId, scope.runId, input.memoryType ?? null, input.key ?? null]);
}

function normalizeEmbedding(value) {
  if (value === undefined || value === null) return null;
  const values = Array.isArray(value) ? value : value?.values;
  if (!Array.isArray(values) || values.length === 0 || values.some((item) => typeof item !== 'number' || !Number.isFinite(item))) {
    throw new Error('Memory embedding must contain a finite non-empty numeric vector');
  }
  if (Array.isArray(value)) return [...values];
  if (value.model !== undefined && typeof value.model !== 'string') throw new Error('Memory embedding model must be a string');
  return { model: value.model ?? null, values: [...values] };
}

function validateTemporalFields(input, names) {
  for (const name of names) {
    const value = input?.[name];
    if (value !== undefined && value !== null && typeof value !== 'string') throw new Error(`${name} must be a string or null`);
    if (typeof value === 'string' && !isValidTimestamp(value)) throw new Error(`${name} must be a valid timestamp`);
  }
}

function validateReviewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('review input must be an object');
  validateTemporalFields(input, ['asOf']);
  const project = input.project === undefined ? undefined : normalizeProject(input.project);
  if (input.changedFacts !== undefined && (!Array.isArray(input.changedFacts) || input.changedFacts.some((item) => typeof item !== 'string'))) {
    throw new Error('changedFacts must be an array of strings');
  }
  if (input.facts !== undefined && (!input.facts || typeof input.facts !== 'object' || Array.isArray(input.facts))) {
    throw new Error('facts must be an object');
  }
  // clone() is the lossless plain-JSON boundary. Run it here, before review can
  // insert a persistent signal (and before maintain can mutate lifecycle state).
  const facts = clone(input.facts ?? {});
  return {
    ...(project === undefined ? {} : { project }),
    changedFacts: [...(input.changedFacts ?? [])],
    facts,
    ...(input.asOf === undefined ? {} : { asOf: input.asOf })
  };
}

function isValidTimestamp(value) {
  if (!Number.isFinite(Date.parse(value))) return false;
  const iso = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!iso) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, zone] = iso;
  const year = Number(yearText); const month = Number(monthText); const day = Number(dayText);
  const hour = Number(hourText); const minute = Number(minuteText); const second = Number(secondText);
  if (month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) return false;
  if (hour > 23 || minute > 59 || second > 59) return false;
  if (zone !== 'Z') {
    const [zoneHour, zoneMinute] = zone.slice(1).split(':').map(Number);
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }
  return true;
}

function instantMs(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function compareInstants(left, right) {
  return (instantMs(left) ?? Number.NEGATIVE_INFINITY) - (instantMs(right) ?? Number.NEGATIVE_INFINITY);
}

function sameInstant(left, right) {
  if ((left === undefined || left === null) && (right === undefined || right === null)) return true;
  return instantMs(left) === instantMs(right);
}

function validateMemoryInterval(validFrom, validTo) {
  if (validTo && compareInstants(validTo, validFrom) <= 0) throw new Error('Memory validTo must be later than validFrom');
}

function validateStoredMemoryInterval(validFrom, validTo) {
  if (validTo && compareInstants(validTo, validFrom) < 0) throw new Error('Stored memory validTo must not precede validFrom');
}

function earliestBoundary(existing, candidate) {
  if (!existing) return candidate ?? null;
  if (!candidate) return existing;
  return compareInstants(existing, candidate) <= 0 ? existing : candidate;
}

// G3: resolve a caller-supplied decision status to its canonical form, or undefined
// if unrecognised. Only FORMATTING variance is absorbed (whitespace, case,
// hyphen-vs-underscore) because MCP clients commonly send `in-progress`. Meaning is
// never remapped.
function normalizeDecisionStatus(raw) {
  if (typeof raw !== 'string') return undefined;
  const candidate = raw.trim().toLowerCase().replaceAll('-', '_');
  return DECISION_STATUSES.includes(candidate) ? candidate : undefined;
}

// G2: map a claimed source label onto an official class. Unknown or non-canonical
// labels downgrade to `agent_claimed` rather than being rejected, because a label is
// a description of origin and discarding a real fact over a labelling problem loses
// data. The raw label is preserved for audit whenever it differs from the resolved
// class (security doc: "preserve the original source label for audit").
function normalizeSourceClass(raw) {
  if (raw == null) return { sourceClass: 'agent_claimed' };
  const label = String(raw);
  const candidate = label.trim().toLowerCase().replaceAll('-', '_');
  const sourceClass = SOURCE_CLASSES.includes(candidate) ? candidate : 'agent_claimed';
  return sourceClass === label ? { sourceClass } : { sourceClass, sourceRaw: label };
}

function provenanceString(value, name) {
  if (value == null) return null;
  if (typeof value !== 'string') throw new Error(`${name} must be a string when provided`);
  return value;
}

// G2: plain JSON provenance only — no live objects, so everything survives
// exportData() -> importData() unchanged.
function provenanceFields(input) {
  return {
    ...normalizeSourceClass(input.sourceClass ?? input.source),
    actor: provenanceString(input.actor, 'actor'),
    client: provenanceString(input.client, 'client'),
    sessionId: provenanceString(input.sessionId, 'sessionId')
  };
}

function normalizeEvidence(item, clock = () => new Date().toISOString()) {
  const base = typeof item === 'string' ? { source: item } : (item ?? {});
  const { sourceClass, sourceRaw } = normalizeSourceClass(base.sourceClass ?? base.type ?? base.source);
  return {
    source: base.source ?? 'unknown', type: base.type ?? 'unknown',
    sourceClass, ...(sourceRaw ? { sourceRaw } : {}),
    confidence: base.confidence ?? 0.5, observedAt: base.observedAt ?? clock(), detail: base.detail ?? ''
  };
}

function validateImportShape(source) {
  const array = (name) => {
    if (source[name] !== undefined && !Array.isArray(source[name])) throw new Error(`${name} must be an array`);
    return source[name] ?? [];
  };
  if (source.journalSeq !== undefined && (!Number.isSafeInteger(source.journalSeq) || source.journalSeq < 0)) throw new Error('journalSeq must be a non-negative safe integer');
  if (source.journalEpoch !== undefined && source.journalEpoch !== null && (!Number.isSafeInteger(source.journalEpoch) || source.journalEpoch <= 0)) throw new Error('journalEpoch must be a positive safe integer or null');
  for (const [index, item] of array('records').entries()) {
    if (!item || typeof item !== 'object' || !['decision', 'attempt', 'memory'].includes(item.kind)) throw new Error(`records[${index}] is malformed`);
    if (typeof item.id !== 'string' || !item.id) throw new Error(`records[${index}].id must be a non-empty string`);
    if (Number.isInteger(source.schemaVersion) && source.schemaVersion >= GLOBAL_ENTITY_NAMESPACE_SCHEMA_VERSION) {
      try { normalizeProject(item.project); }
      catch { throw new Error(`records[${index}].project must be a non-empty string`); }
    }
    validateTemporalFields(item, ['createdAt', 'updatedAt', 'reviewAfter']);
    if (item.kind === 'decision') {
      if (typeof item.title !== 'string' || typeof item.chosen !== 'string') throw new Error(`records[${index}] decision requires title and chosen strings`);
      if (item.alternatives !== undefined && !Array.isArray(item.alternatives)) throw new Error(`records[${index}].alternatives must be an array`);
      for (const [alternativeIndex, alternative] of (item.alternatives ?? []).entries()) {
        if (!alternative || typeof alternative !== 'object' || typeof alternative.label !== 'string') throw new Error(`records[${index}].alternatives[${alternativeIndex}] is malformed`);
        if (Number.isInteger(source.schemaVersion) && source.schemaVersion >= GLOBAL_ENTITY_NAMESPACE_SCHEMA_VERSION && (typeof alternative.id !== 'string' || !alternative.id)) throw new Error(`records[${index}].alternatives[${alternativeIndex}] id must be a non-empty string`);
        if (alternative.reopenWhen !== undefined && !Array.isArray(alternative.reopenWhen)) throw new Error(`records[${index}].alternatives[${alternativeIndex}].reopenWhen must be an array`);
      }
    }
    if (item.kind === 'memory') {
      if (!MEMORY_TYPES.includes(item.memoryType) || typeof item.key !== 'string' || !item.key.trim() || typeof item.text !== 'string' || !item.text.trim()) throw new Error(`records[${index}] memory requires memoryType, key, and text`);
      normalizeMemoryScope(item.scope);
      if (item.project !== undefined && typeof item.project !== 'string') throw new Error(`records[${index}].project must be a string`);
      if (item.metadata !== undefined && (!item.metadata || typeof item.metadata !== 'object' || Array.isArray(item.metadata))) throw new Error(`records[${index}].metadata must be an object`);
      if (item.tags !== undefined && (!Array.isArray(item.tags) || item.tags.some((tag) => typeof tag !== 'string'))) throw new Error(`records[${index}].tags must be an array of strings`);
      normalizeEmbedding(item.embedding);
      if (item.version !== undefined && (!Number.isInteger(item.version) || item.version < 1)) throw new Error(`records[${index}].version must be a positive integer`);
      if (item.status !== undefined && !MEMORY_STATUSES.includes(item.status)) throw new Error(`records[${index}].status is invalid`);
      if (item.temporal !== undefined) {
        if (!item.temporal || typeof item.temporal !== 'object' || Array.isArray(item.temporal)) throw new Error(`records[${index}].temporal must be an object`);
        validateTemporalFields(item.temporal, ['validFrom', 'validTo', 'recordedAt', 'invalidatedAt']);
        validateStoredMemoryInterval(item.temporal.validFrom ?? item.createdAt ?? item.temporal.recordedAt ?? '', item.temporal.validTo ?? null);
      }
    }
  }
  for (const [index, fact] of array('facts').entries()) {
    if (!fact || typeof fact !== 'object' || (fact.id !== undefined && typeof fact.id !== 'string') || typeof fact.key !== 'string' || (fact.kind !== undefined && fact.kind !== 'fact')) throw new Error(`facts[${index}] is malformed`);
    if (Number.isInteger(source.schemaVersion) && source.schemaVersion >= GLOBAL_ENTITY_NAMESPACE_SCHEMA_VERSION && !fact.id) throw new Error(`facts[${index}].id must be a non-empty string`);
    if (Number.isInteger(source.schemaVersion) && source.schemaVersion >= GLOBAL_ENTITY_NAMESPACE_SCHEMA_VERSION) {
      try { normalizeProject(fact.project); }
      catch { throw new Error(`facts[${index}].project must be a non-empty string`); }
    }
    validateTemporalFields(fact, ['recordedAt', 'observedAt', 'validFrom', 'validTo', 'expiresAt']);
    if (fact.temporal !== undefined) {
      if (!fact.temporal || typeof fact.temporal !== 'object' || Array.isArray(fact.temporal)) throw new Error(`facts[${index}].temporal must be an object`);
      validateTemporalFields(fact.temporal, ['recordedAt', 'validFrom', 'validTo', 'invalidatedAt']);
    }
    const factValidFrom = fact.temporal?.validFrom ?? fact.validFrom ?? fact.observedAt ?? null;
    const factValidTo = fact.temporal?.validTo ?? fact.validTo ?? null;
    if (factValidFrom && factValidTo && compareInstants(factValidTo, factValidFrom) < 0) throw new Error('Stored fact validTo must not precede validFrom');
    const intervalIssue = factEffectiveExpirationIntervalIssue(fact);
    if (intervalIssue) throw new Error(`facts[${index}] ${intervalIssue}`);
    const factSchemaVersion = Number.isInteger(fact.schemaVersion) ? fact.schemaVersion : source.schemaVersion;
    if (factSchemaVersion === SCHEMA_VERSION) {
      const validityIssue = factValidityPolicyIssue(fact, { required: true });
      if (validityIssue) throw new Error(`facts[${index}] ${validityIssue}`);
      if (!['active', 'expired', 'superseded'].includes(fact.status)) throw new Error(`facts[${index}] has invalid fact lifecycle status`);
      if (fact.status === 'active') {
        if (fact.verificationStatus === 'expired') throw new Error(`facts[${index}] active fact cannot have expired verificationStatus`);
        if (fact.temporal?.invalidatedAt != null) throw new Error(`facts[${index}] active fact cannot have an invalidatedAt lifecycle boundary`);
      }
      if (fact.status === 'expired') {
        const expirationBoundary = effectiveFactExpirationBoundary(fact);
        if (fact.verificationStatus !== 'expired' || !expirationBoundary || !isValidIsoInstant(fact.temporal?.validTo) || !isValidIsoInstant(fact.temporal?.invalidatedAt)) {
          throw new Error(`facts[${index}] expired fact has contradictory lifecycle state`);
        }
        if (compareInstants(fact.temporal.validTo, expirationBoundary) > 0 || compareInstants(fact.temporal.invalidatedAt, expirationBoundary) < 0) {
          throw new Error(`facts[${index}] expired fact contradicts its effective expiration boundary`);
        }
      }
      if (fact.status === 'superseded') {
        if (fact.verificationStatus === 'expired' || typeof fact.supersededBy !== 'string' || !fact.supersededBy || !fact.temporal?.validTo || !fact.temporal?.invalidatedAt) {
          throw new Error(`facts[${index}] superseded fact has contradictory lifecycle state`);
        }
      }
    }
  }
  for (const [index, relation] of array('relations').entries()) {
    if (!relation || typeof relation !== 'object' || typeof relation.from !== 'string' || typeof relation.to !== 'string' || typeof relation.relation !== 'string') throw new Error(`relations[${index}] is malformed`);
    if (typeof relation.id !== 'string' || !relation.id) throw new Error(`relations[${index}].id must be a non-empty string`);
    validateTemporalFields(relation, ['recordedAt', 'createdAt', 'validFrom', 'validTo']);
    if (relation.temporal !== undefined) {
      if (!relation.temporal || typeof relation.temporal !== 'object' || Array.isArray(relation.temporal)) throw new Error(`relations[${index}].temporal must be an object`);
      validateTemporalFields(relation.temporal, ['recordedAt', 'validFrom', 'validTo', 'invalidatedAt']);
    }
    const relationValidFrom = relation.temporal?.validFrom ?? relation.validFrom ?? relation.createdAt ?? null;
    const relationValidTo = relation.temporal?.validTo ?? relation.validTo ?? null;
    if (relationValidFrom && relationValidTo && compareInstants(relationValidTo, relationValidFrom) < 0) throw new Error('Stored relation validTo must not precede validFrom');
  }
  const journalEntries = array('journal');
  // Sequence identity is the primary ordering invariant. Check it before journal
  // ids or type semantics so same-id and different-id collisions share one stable
  // diagnostic in every supported source schema.
  assertUniqueJournalSequences(journalEntries);
  const journalIds = new Set();
  for (const [index, entry] of journalEntries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`journal[${index}] is malformed`);
    assertJournalEntrySequence(entry, {
      path: `journal[${index}]`,
      sourceSchemaVersion: source.schemaVersion,
      allowLegacyMetadata: true
    });

    const purgeArtifactIssue = schema5PurgeArtifactIssue(entry, source.schemaVersion);
    if (purgeArtifactIssue) throw new Error(`journal[${index}] has noncanonical schema 5 purge artifact: ${purgeArtifactIssue}`);
    const expectedEntityKind = JOURNAL_TYPE_ENTITY_KIND[entry.type];
    if (expectedEntityKind && entry.entityKind != null && entry.entityKind !== expectedEntityKind) throw new Error(`journal[${index}] type ${entry.type} requires entityKind ${expectedEntityKind}`);
    if (source.schemaVersion >= 3) {
      if (typeof entry.id !== 'string' || !entry.id) throw new Error(`journal[${index}].id must be a non-empty string`);
      if (journalIds.has(entry.id)) throw new Error(`Duplicate journal id ${entry.id}`);
      journalIds.add(entry.id);
      if (entry.payload?.id !== undefined && entry.entityId !== entry.payload.id) throw new Error(`journal[${index}] entityId must match payload.id`);
      if (entry.payload?.project !== undefined && entry.project !== entry.payload.project) throw new Error(`journal[${index}] project must match payload.project`);
      if (entry.payload?.kind !== undefined && entry.entityKind !== entry.payload.kind) throw new Error(`journal[${index}] entityKind must match payload.kind`);
    }
    const postconditionIssue = journalEntryPostconditionIssue(entry);
    if (postconditionIssue) throw new Error(`journal[${index}] ${entry.type} postcondition failed: ${postconditionIssue}`);
    const journalFacts = entry.type === 'projection.baseline' ? (entry.payload?.facts ?? []) : entry.payload?.kind === 'fact' ? [entry.payload] : [];
    for (const fact of journalFacts) {
      const intervalIssue = factEffectiveExpirationIntervalIssue(fact);
      if (intervalIssue) throw new Error(`journal[${index}] ${entry.type} ${intervalIssue}`);
    }
    if (entry.payload?.kind === 'fact' && Number.isInteger(entry.schemaVersion) && entry.schemaVersion >= 5) {
      const validityIssue = factValidityPolicyIssue(entry.payload, { required: true });
      if (validityIssue) throw new Error(`journal[${index}] ${entry.type} has invalid fact validity: ${validityIssue}`);
    }
  }
  assertJournalBaselinePlacement(journalEntries, {
    journalEpoch: source.journalEpoch,
    sourceSchemaVersion: source.schemaVersion
  });
  const hardPurgeMarkers = array('journal').filter((entry) => entry?.type === 'project.purged' && entry?.payload?.mode === 'hard');
  if (hardPurgeMarkers.length && hardPurgeMarkers.every((entry) => Object.hasOwn(entry.payload, 'removedJournalSequences'))) {
    assertHardPurgeGapLedgers(array('journal'), {
      journalEpoch: source.journalEpoch,
      sourceSchemaVersion: source.schemaVersion
    });
  }
  const lifecycleIssues = journalFactLifecycleIssues(array('journal'), {
    journalEpoch: source.journalEpoch,
    sourceSchemaVersion: source.schemaVersion
  });
  if (lifecycleIssues.length) {
    const first = lifecycleIssues[0];
    throw new Error(`Journal fact lifecycle is non-monotonic at sequence ${first.seq}: ${first.detail}`);
  }
  for (const [index, signal] of array('reviewSignals').entries()) if (!signal || typeof signal !== 'object' || Array.isArray(signal) || typeof signal.id !== 'string' || typeof signal.decisionId !== 'string' || typeof signal.reason !== 'string') throw new Error(`reviewSignals[${index}] is malformed`);
  const idempotencyKeys = new Set();
  for (const [index, item] of array('idempotency').entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.key !== 'string' || !item.key || !item.value || typeof item.value !== 'object' || Array.isArray(item.value)) throw new Error(`idempotency[${index}] is malformed`);
    if (idempotencyKeys.has(item.key)) throw new Error(`Duplicate idempotency key ${item.key}`);
    idempotencyKeys.add(item.key);
  }
  const eventIds = new Set();
  for (const [index, eventItem] of array('events').entries()) {
    if (!eventItem || typeof eventItem !== 'object' || Array.isArray(eventItem) || typeof eventItem.id !== 'string' || typeof eventItem.type !== 'string') throw new Error(`events[${index}] is malformed`);
    if (eventIds.has(eventItem.id)) throw new Error(`Duplicate event id ${eventItem.id}`);
    eventIds.add(eventItem.id);
  }
}

function assertUniqueEntityIds(...collections) {
  const seen = new Set();
  for (const collection of collections) {
    for (const item of collection) {
      if (!item?.id) continue;
      if (seen.has(item.id)) throw new Error(`Duplicate entity id ${item.id} appears more than once in schema 4`);
      seen.add(item.id);
    }
  }
}

function migrateRecord(item) {
  if (item.kind === 'memory') {
    const source = clone(item);
    const recordedAt = source.temporal?.recordedAt ?? source.createdAt ?? null;
    return {
      schemaVersion: SCHEMA_VERSION,
      project: source.project ?? 'default',
      ...source,
      scope: normalizeMemoryScope(source.scope),
      version: Number.isInteger(source.version) && source.version > 0 ? source.version : 1,
      status: source.status ?? 'active',
      verificationStatus: source.verificationStatus ?? 'unverified',
      temporal: {
        validFrom: source.temporal?.validFrom ?? source.createdAt ?? null,
        validTo: source.temporal?.validTo ?? null,
        recordedAt,
        invalidatedAt: source.temporal?.invalidatedAt ?? null
      }
    };
  }
  if (item.kind !== 'decision') return { schemaVersion: SCHEMA_VERSION, project: 'default', ...clone(item) };
  const source = clone(item);
  const migratesLegacyStatus = !Number.isInteger(source.schemaVersion) || source.schemaVersion < 5;
  const legacyDecisionStatus = migratesLegacyStatus && ['active', 'aging'].includes(source.status) ? source.status : null;
  const migratedDecisionStatus = source.status === 'active' ? 'proposed' : source.status === 'aging' ? 'stale' : source.status;
  const numeric = typeof source.confidence === 'number' ? source.confidence : source.confidence?.current ?? 0.5;
  const initial = typeof source.confidence === 'object' ? source.confidence.initial ?? numeric : numeric;
  const history = source.confidence?.history ?? [];
  // G8: legacy confidence had no basis. Reconstruct one from what is present
  // WITHOUT inventing contributions — an unbasis'd history yields an empty
  // contribution list, and validate() reports it as legacy rather than pretending.
  const contributions = (source.confidence?.basis?.contributions ?? []).map((entry) => ({ ...entry }));
  const policy = source.confidence?.policy ?? source.confidence?.basis?.policy ?? CONFIDENCE_POLICY;
  const hasBasis = Boolean(source.confidence?.basis);
  const confidence = policy === CONFIDENCE_POLICY ? (hasBasis ? {
    initial, current: contributions.length ? computeConfidence(initial, contributions) : numeric,
    basis: summarizeBasis(contributions, { declaredEvidence: (source.evidence ?? []).length }),
    history, policy
  } : {
    initial, current: numeric, history, policy,
    migratedFromLegacyCurrent: true
  }) : { ...clone(source.confidence), initial, current: numeric, policy, ...(source.confidence?.basis ? { basis: clone(source.confidence.basis) } : {}) };
  if (!source.confidence?.basis) delete confidence.basis;
  return {
    // P2-14: never silently DOWNGRADE a record written by a newer build. Claiming
    // schemaVersion 3 for data we cannot interpret would erase the only evidence
    // that this build does not understand it. The original version is preserved
    // and validate() reports it as `unsupported`.
    ...source,
    schemaVersion: Number.isInteger(source.schemaVersion) && source.schemaVersion > SCHEMA_VERSION ? source.schemaVersion : SCHEMA_VERSION,
    project: source.project ?? 'default', confidence,
    ...(legacyDecisionStatus ? {
      status: migratedDecisionStatus,
      migration: { ...(source.migration ?? {}), legacyDecisionStatus }
    } : {}),
    evidence: (source.evidence ?? []).map((entry) => normalizeEvidence(entry)),
    alternatives: (source.alternatives ?? []).map((a, index) => ({ ...a, id: a.id ?? `alternative_${source.id}_${index}`, reopenWhen: normalizeRules(a.reopenWhen ?? []) }))
  };
}

// B-5: a legacy fact carried `source:'unknown'` and no sourceClass at all, so
// anything reading sourceClass got undefined. Backfill the class from the stored
// label, keep the original verbatim, and NEVER raise verification (contract §6).
function migrateFact(fact) {
  const source = clone(fact);
  // P2-14: a fact written by a NEWER build keeps its own schemaVersion rather than
  // being relabelled as one this build understands. validate() reports it as
  // `unsupported` so the caller learns we cannot fully interpret it.
  const future = Number.isInteger(source.schemaVersion) && source.schemaVersion > SCHEMA_VERSION;
  const imported = { project: 'default', confidence: 0.5, status: 'active', ...source, schemaVersion: future ? source.schemaVersion : SCHEMA_VERSION };
  if (!SOURCE_CLASSES.includes(imported.sourceClass)) {
    const { sourceClass, sourceRaw } = normalizeSourceClass(imported.sourceClass ?? imported.source);
    imported.sourceClass = sourceClass;
    if (sourceRaw !== undefined) imported.sourceRaw = imported.sourceRaw ?? sourceRaw;
    else if (imported.source !== undefined && imported.source !== sourceClass) imported.sourceRaw = imported.sourceRaw ?? String(imported.source);
  }
  if (imported.source === undefined) imported.source = imported.sourceClass;
  if (!VERIFICATION_STATUSES.includes(imported.verificationStatus)) imported.verificationStatus = 'unverified';
  if (!future && (!Number.isInteger(source.schemaVersion) || source.schemaVersion < 5) && imported.validityPolicy === undefined) {
    const declaredExpiresAt = imported.expiresAt ?? null;
    const declaredValidTo = imported.temporal?.validTo ?? imported.validTo ?? null;
    imported.validityPolicy = {
      declaredExpiresAt,
      declaredValidTo,
      effectiveExpirationBoundary: effectiveFactExpirationBoundary({
        ...imported,
        validityPolicy: { declaredExpiresAt, declaredValidTo, effectiveExpirationBoundary: null }
      })
    };
  }
  if (imported.actor === undefined) imported.actor = null;
  if (imported.client === undefined) imported.client = null;
  if (imported.sessionId === undefined) imported.sessionId = null;
  return imported;
}

// G7: the declared content surface. Anything not listed here is metadata, not
// content, and must not satisfy a free-text query.
function matchFields(record, needle) {
  const fields = [];
  const has = (value) => String(value ?? '').toLowerCase().includes(needle);
  if (has(record.title)) fields.push('title');
  if (has(record.goal)) fields.push('goal');
  if (has(record.chosen)) fields.push('chosen');
  if ((record.assumptions ?? []).some(has)) fields.push('assumption');
  if ((record.evidence ?? []).some((entry) => has(entry?.source) || has(entry?.detail))) fields.push('evidence');
  if ((record.alternatives ?? []).some((entry) => has(entry?.label) || has(entry?.reasonRejected))) fields.push('alternative');
  if (has(record.solution)) fields.push('attempt solution');
  if (has(record.result)) fields.push('attempt result');
  if (has(record.reason)) fields.push('attempt reason');
  if (has(record.environment)) fields.push('environment');
  return fields;
}

const FIELD_WEIGHT = { title: 5, chosen: 3, goal: 3 };
function score(record, terms) {
  let total = 0;
  for (const term of terms) {
    for (const field of matchFields(record, term)) total += FIELD_WEIGHT[field] ?? 2;
    total += 1;
  }
  return total;
}
