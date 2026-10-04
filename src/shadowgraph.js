// ShadowGraph: an explainable, outcome-aware decision graph.
//
// Contracts (docs/contracts/):
//   provenance-contract.md  — source classes, why nothing can be `verified`
//   lifecycle-contract.md   — the 13 decision statuses and their classification
//   journal-contract.md     — append-oriented journal + rebuildable projections
//   completeness-contract.md— pagination / no-silent-omission on every read path
//   search-contract.md      — content fields vs filters
//   confidence-contract.md  — evidence-weighted bounded confidence

import { CREATION_ENTRY_TYPES, HARD_GAP_EVIDENCE_TYPES, assertHardPurgeGapLedgers, assertJournalBaselinePlacement, assertJournalEntrySequence, assertUniqueJournalSequences, rebuildProjection, journalGaps, duplicateSequences, journalBaselinePlacementIssues, journalEntryPostconditionIssue, journalEntrySequenceIssue, journalFactLifecycleIssues, replayedEntity, reattributeIdempotency, schema5PurgeArtifactIssue, ATTRIBUTED_ENTITY_KINDS, ATTRIBUTION_ENTRY_KINDS, JOURNAL_ENTRY_TYPES, JOURNAL_TYPE_ENTITY_KIND, READABLE_JOURNAL_SCHEMA_VERSION, REPLAYABLE_ENTRY_TYPES } from './journal.js';
import { createConfidence, applyContribution, setOutcomeContribution, computeConfidence, summarizeBasis, CONFIDENCE_POLICY } from './confidence.js';
import { hybridSearch, foldText } from './hybrid-search.js';
import { effectiveFactExpirationBoundary, factValidityPolicyIssue, isValidIsoInstant } from './fact-validity.js';
import { evaluateRule, isSupportedOperator, isSupportedUnit, ruleOperandIssue } from './condition-eval.js';
import { privilegedSnapshot, privilegedValidate, registerPrivileged } from './internal/snapshot.js';
import { extraCollections, refusePublicExport, NATIVE_STORE_KEYS, PUBLIC_EXPORT_KIND, REDACTION_EXPORT_KIND } from './internal/collections.js';
import { isLegacyOwned, resolveScope, sameOrigin, usableOriginId } from './scope.js';
import { createHash, randomUUID } from 'node:crypto';
import { extractionSupersession } from './internal/extraction-supersession.js';
import { accessScopeContains, validateAccess, intersectAccessScope, accessDiagnostics, reconcileAccessLedger } from './access.js';
import { createAccessLifecycle } from './internal/access-lifecycle.js';
import { assertCreationInput } from './internal/creation-id.js';
import { EXTRACTION_RECIPE } from './internal/extraction-contract.js';
import { attemptOutcome } from './internal/outcome.js';
import { RUNTIME_MISSES, missReachedBy, runtimeMissLedgerIssue, withFallbackMisses } from './internal/miss-ledger.js';
import { supersessionOrder, temporalEvidence, versionTimes } from './internal/temporal-evidence.js';
import { T1_DERIVATION_VERSION, t1Digest, t1Inputs, t1Line } from './compact-tier.js';
import { SELF_SIGNALS, stripDeliveredBlocks } from './internal/capture-source.js';
import { CAPTURE_COLLECTIONS, CAPTURE_CONTENT, CAPTURE_ENTRY_TYPES, CAPTURE_EVENT_IDENTITY, CAPTURE_IMPORT_TYPE, CAPTURE_KIND, CAPTURE_SESSIONS, CAPTURE_TRANSITIONS, captureCollectionIssue, captureEntryReachedBy, captureEventIssue, captureItemIssue, captureObservationIssue, CAPTURE_LIMIT_EVENT, CAPTURE_REFUSED_EVENT, OTHER_OWNER } from './internal/capture.js';
import { TRANSCRIPT_ANCHOR_BYTES, TRANSCRIPT_GAP_REASONS, TRANSCRIPT_TRIGGERS, cursorBlock, cursorShape, digest, lastLineEnd, matchKey, transcriptEntry, transcriptLines } from './internal/transcript.js';
import { CREDENTIAL_WITHHELD, captureWithheld, redactText, redactValue, withholdFlagged } from './internal/redaction.js';
import { RAW_EXPIRED, RAW_RETENTION_DAYS, captureRawExpired, effectiveCaptureExpiry, hasCaptureRetentionState } from './internal/capture-retention.js';
import { invalidatedCaptureTokens } from './internal/capture-generation.js';
import { sessionJournalEntries, workerReason } from './internal/extraction-session.js';
import { DELETION_INTENT, DELETION_VIEW, IDEMPOTENCY_KEY_WITHHELD, PURGE_AWARE_RESTORE_UNSUPPORTED, PURGE_BACKUPS_STATEMENT, SCOPE_KEY_WITHHELD, SESSION_WITHHELD, deletionError, journalHead } from './internal/deletion-knowledge.js';

// PUBLIC API. These vocabularies are part of the supported surface (see
// docs/api-reference.md) and are frozen so a consumer cannot mutate validation
// behaviour at a distance.
//
// SCHEMA_VERSION is what this build WRITES; SUPPORTED_SCHEMA_VERSIONS is what it
// reads. The reader is widened before the writer (plan v1.4.4 §9.2): PR-20 read 7
// while writing 6 and is the floor for every store this build saves; PR-21
// writes 7. Entities and journal entries share the one readable bound.
export const SCHEMA_VERSION = 7;
export const SUPPORTED_SCHEMA_VERSIONS = Object.freeze([1, 2, 3, 4, 5, 6, 7]);
const READABLE_SCHEMA_VERSION = READABLE_JOURNAL_SCHEMA_VERSION;
const GLOBAL_ENTITY_NAMESPACE_SCHEMA_VERSION = 4;
// The last schema whose entities carry no attribution. Import keeps a legacy
// entity at this version rather than stamping it 6 without saying whose it is;
// only a write or the attribution migration makes an entity schema 6.
const PRE_ATTRIBUTION_SCHEMA_VERSION = 5;

// Schema 6 records say whose they are (plan v1.4.4 §9.3, §10.3): a named
// project, one capture origin and no project (`unattributed`, project null), or
// one of the two legacy states the attribution migration assigns.
const ATTRIBUTIONS = Object.freeze(['project', 'unattributed', 'legacy_ambiguous', 'legacy_unattributed']);

function attributionIssue(entity) {
  if (entity.originId !== undefined && usableOriginId(entity.originId) === null) return 'originId must be a non-empty string';
  if (entity.attribution === undefined) return null;
  if (!ATTRIBUTIONS.includes(entity.attribution)) return `unknown attribution ${JSON.stringify(entity.attribution)}`;
  if (entity.attribution === 'unattributed') {
    if (entity.project !== null && entity.project !== undefined) return 'an unattributed entity belongs to no project';
    if (usableOriginId(entity.originId) === null) return 'an unattributed entity requires its originId';
  }
  if (['project', 'legacy_ambiguous'].includes(entity.attribution) && (typeof entity.project !== 'string' || !entity.project.trim())) {
    return `a ${entity.attribution} entity requires a project`;
  }
  return null;
}

// The claim-evidence model of schema 7 (plan v1.4.4 §9.4, §14). Checked: the
// closed vocabularies and cross-field rules, and the shape each stored claim's
// class needs (plan v1.4.4 PR-22): its text and sourceRef, a verifierVersion, a
// rule if entailed, readings if ambiguous, and a well-formed span if it has one.
// Values are checked for presence and shape, not against this build's verifier,
// so a later verifier's output stays readable. Every other field -- checks,
// captureRef, and any field a later build adds -- is carried verbatim. A stored
// record never carries an unsupported claim: that stays in a capture item's
// extraction output.
const CLAIM_CLASSES = Object.freeze(['quoted', 'entailed', 'ambiguous', 'unsupported']);
const CAUSAL_STATES = Object.freeze(['recorded', 'unknown', 'not_recorded', 'legacy_freetext']);
const OUTCOME_EVIDENCE_STATES = Object.freeze(['observed', 'absent', 'not_applicable']);
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const named = (value) => typeof value === 'string' && value.trim() !== '';
// Capture's admission limits (§22.6.1; the values are the activation's), and
// the states an item holds until it is understood (§24.1).
const ADMISSION_LIMITS = Object.freeze(['maxStoreBytes', 'maxQueueDepth', 'maxItemBytes', 'maxItemsPerSession']);
// What one capture adds to the store besides its material, estimated for the
// store-bytes limit: the item, its journal entry and its retry value.
const CAPTURE_ITEM_ALLOWANCE = 6 * 1024;
const UNEXTRACTED_STATES = Object.freeze(['pending', 'processing', 'failed', 'blocked']);
// A session keeps its newest transcript gaps and counts the rest.
const TRANSCRIPT_GAPS_KEPT = 8;

// Plan v1.4.4 §9.4 (PR-23, VAR-08): an attempt's cause, attributed apart from
// the observation it explains (PC-04). A reason recorded now is the caller's
// own claim, agent_claimed whatever the attempt's sourceClass says; its
// statement is the reason itself, kept verbatim and not copied. A reason an
// earlier build stored is legacy free text, never classed and never evidenced:
// derived on the way out (publicValue) and never stored. No reason, or a blank
// one, is not recorded. Only the extractor records a cause as unknown.
function causalClaimFor(reason, { legacy = false } = {}) {
  const given = typeof reason === 'string' ? reason.trim() !== '' : reason != null;
  if (!given) return { state: 'not_recorded' };
  return legacy ? { state: 'legacy_freetext' } : { state: 'recorded', sourceClass: 'agent_claimed', evidence: [] };
}

// The entity erasureToken of schema 7: a non-empty string, carried only by a
// decision, attempt, memory or fact that names its kind and id, so every public
// result can be stripped of it by what the entity says it is.
function erasureTokenIssue(entity) {
  if (entity.erasureToken === undefined) return null;
  if (typeof entity.erasureToken !== 'string' || !entity.erasureToken) return 'erasureToken must be a non-empty string';
  if (!ATTRIBUTED_ENTITY_KINDS.includes(entity.kind) || typeof entity.id !== 'string' || !entity.id) return 'erasureToken is carried only by a decision, attempt, memory or fact that names its kind and id';
  return null;
}

function captureCollectionError(issue) {
  const error = new Error(`A capture collection is malformed (capture_collection_malformed): ${issue}`);
  error.code = 'capture_collection_malformed';
  return error;
}

// A capture item is no claim-bearing record: its own frozen shape governs it
// wherever it is stored (PR-33).
function storedEntityIssue(entity) {
  if (entity?.kind !== CAPTURE_KIND) return claimModelIssue(entity);
  const issue = captureItemIssue(entity);
  return issue && `it is not a well-formed capture item (${issue})`;
}

function claimModelIssue(entity) {
  const tokenIssue = erasureTokenIssue(entity);
  if (tokenIssue) return tokenIssue;
  if (entity.claims !== undefined) {
    if (!Array.isArray(entity.claims)) return 'claims must be a list';
    for (const [index, claim] of entity.claims.entries()) {
      if (!isPlainObject(claim) || !CLAIM_CLASSES.includes(claim.class)) return `claims[${index}].class must be one of ${CLAIM_CLASSES.join(', ')}`;
      if (claim.class === 'unsupported') return `claims[${index}] is unsupported, which a stored record never carries`;
      if (!named(claim.verifierVersion)) return `claims[${index}] carries no verifierVersion: a claim's class comes from the claim verifier`;
      if (!named(claim.text) || !named(claim.sourceRef)) return `claims[${index}] names no text or sourceRef`;
      if (claim.class === 'entailed' && !named(claim.rule)) return `claims[${index}] is entailed and names no rule`;
      if (claim.class === 'ambiguous' && (!Array.isArray(claim.readings) || !claim.readings.length || !claim.readings.every(named))) return `claims[${index}] is ambiguous and records no readings`;
      if (claim.span !== undefined && !(isPlainObject(claim.span) && Number.isSafeInteger(claim.span.start) && Number.isSafeInteger(claim.span.end) && claim.span.start >= 0 && claim.span.start < claim.span.end)) return `claims[${index}].span must be a start before an end`;
    }
  }
  if (entity.causalClaim !== undefined) {
    const cause = entity.causalClaim;
    if (!isPlainObject(cause) || !CAUSAL_STATES.includes(cause.state)) return `causalClaim.state must be one of ${CAUSAL_STATES.join(', ')}`;
    if (cause.class !== undefined && (!CLAIM_CLASSES.includes(cause.class) || cause.class === 'unsupported')) return 'causalClaim.class must be quoted, entailed or ambiguous';
    if (cause.class !== undefined && !named(cause.verifierVersion)) return 'causalClaim carries a class but no verifierVersion: a class comes from the claim verifier';
    if (cause.state === 'legacy_freetext') {
      if (['quoted', 'entailed'].includes(cause.class)) return 'legacy free-text cause is never quoted or entailed';
      if (cause.evidence !== undefined && (!Array.isArray(cause.evidence) || cause.evidence.length > 0)) return 'legacy free-text cause carries no evidence';
    }
  }
  if (entity.outcomeEvidence !== undefined) {
    const outcome = entity.outcomeEvidence;
    if (!isPlainObject(outcome) || !OUTCOME_EVIDENCE_STATES.includes(outcome.state)) return `outcomeEvidence.state must be one of ${OUTCOME_EVIDENCE_STATES.join(', ')}`;
    // A null resultClass declares no class, as it does everywhere else.
    if (outcome.state === 'observed' && !ATTEMPT_RESULT_CLASSES.includes(entity.resultClass)) return `observed outcome evidence requires a resultClass of ${ATTEMPT_RESULT_CLASSES.join(', ')}`;
    if (outcome.state !== 'observed' && entity.resultClass != null) return `${outcome.state} outcome evidence means resultClass is omitted`;
  }
  return null;
}

// Who owns an entity, for keys that must never merge two owners: an
// unattributed entity belongs to its origin, never to a project, so its key is
// an array a project name can never equal. An unattributed entity without a
// usable origin is invalid (validate() says so) and is keyed by its own id, so
// two absent origins never share a bucket. Legacy data in "default" -- stored
// there or stored with no project -- belongs to no project anyone can name
// (OD-1): before its attribution migration and after it, as legacy_ambiguous
// or legacy_unattributed, it shares the one legacy key it always shared with
// its own kind, which the real project called "default" never equals.
// Everything else keeps the project key it always had.
function ownerKey(entity, projectOf) {
  if (entity?.attribution === 'unattributed') return ['origin', usableOriginId(entity.originId) ?? ['unowned', entity.id ?? null]];
  if (isLegacyOwned(entity)) return ['legacy'];
  return projectOf(entity?.project);
}

function ownedByProject(entity, project) {
  return entity?.project === project && entity?.attribution !== 'unattributed' && !isLegacyOwned(entity);
}

// What a purge's commit point writes (PR-37d design §1, §2.1): the ledger
// tombstone, the registry's lineage anchors and the marker's identity, built
// from values purgeLive already holds, after staging validation and before the
// first mutation. It reads nothing but its arguments and does no I/O.
// `journal` and `epoch` are the unspliced journal and its epoch, before the
// marker; `entities` the records, captures and facts the purge removes, W's
// included; `absorbed` the intents of the earlier markers a hard re-purge
// splices (§2.4), whose tokens and move-in it takes over.
const MOVE_IN_ORDER = ['none', 'some', 'unknown'];
function purgeIntent({ project, mode, marker, entities, journal, epoch, absorbed }) {
  const tokens = new Set(absorbed.flatMap((intent) => intent.tombstone.tokens));
  for (const entity of entities) if (typeof entity.erasureToken === 'string' && entity.erasureToken) tokens.add(entity.erasureToken);
  // §1.3, per removed entity (V-4): its naming entries, by hold()'s predicate.
  // None of a creation type: its history before some point is not here.
  // Otherwise an attribution into the project among them: it moved in.
  const naming = new Map(entities.map((entity) => [entity.id, []]));
  for (const entry of journal) for (const id of new Set([entry?.entityId, replayedEntity(entry)?.id])) naming.get(id)?.push(entry);
  const histories = [...naming.values()];
  let moveIn = 'none';
  if (histories.some((entries) => !entries.some((entry) => CREATION_ENTRY_TYPES.includes(entry.type)))) moveIn = 'unknown';
  else if (histories.some((entries) => entries.some((entry) => entry.type === 'entity.attributed' && entry.project === project))) moveIn = 'some';
  for (const intent of absorbed) if (MOVE_IN_ORDER.indexOf(intent.tombstone.moveIn) > MOVE_IN_ORDER.indexOf(moveIn)) moveIn = intent.tombstone.moveIn;
  // §1.4: the epoch entry (the marker itself when the journal was empty; null
  // when a hard purge spliced it, filled at the commit point), the head before
  // the marker, and the marker.
  const epochEntryId = epoch === null ? marker.id : journal.find((entry) => entry?.seq === epoch)?.id ?? null;
  return {
    tombstone: { kind: 'project', purgedProject: project, mode, at: marker.at, seq: marker.seq, tokens: [...tokens].sort(), moveIn },
    lineage: { epochEntryId, headEntryId: journalHead({ journal }), markerEntryId: marker.id },
    marker: { id: marker.id, at: marker.at, seq: marker.seq }
  };
}

// An entity written by a newer build than this one reads: kept as it arrived,
// reported by validate() as unsupported, and given no meaning here.
function isFutureEntity(entity) {
  return Number.isInteger(entity?.schemaVersion) && entity.schemaVersion > READABLE_SCHEMA_VERSION;
}

// Read, but written by a newer writer than this one: a writer here that restamps
// an entity never touches it, so nothing it carries is relabelled or lost.
function isNewerThanWriter(entity) {
  return Number.isInteger(entity?.schemaVersion) && entity.schemaVersion > SCHEMA_VERSION;
}

// The order the attribution migration takes entities in, and the legacy
// attribution review lists them in: by kind, then id.
function attributionOrder(left, right) {
  return ATTRIBUTED_ENTITY_KINDS.indexOf(left.kind) - ATTRIBUTED_ENTITY_KINDS.indexOf(right.kind) || String(left.id).localeCompare(String(right.id));
}

// The top-level list of legacy entities stored with no project that are still
// waiting for the attribution migration (see `projectlessLegacy`). It is
// deliberately not one of the NATIVE_STORE_KEYS: the storage backends, and
// every earlier build that reads schema 6, carry it with the generic top-level
// carrier byte for byte (axis A-5), and no restore parity check compares it,
// so a rollback to the reader floor neither loses it nor trips over it.
const STORED_WITHOUT_PROJECT = 'storedWithoutProject';

const sameOwnerKey = (left, right) => JSON.stringify(ownerKey(left, (project) => project ?? 'default')) === JSON.stringify(ownerKey(right, (project) => project ?? 'default'));

// Caller idempotency keys are at most 200 characters (validateIdempotencyKey).
// A retry stored beside another owner's key carries this after the caller's
// key, so its text after the owner prefix is longer than any key a request can
// send: no request can name it, and the prefix still binds it to its owner.
const BESIDE_ANOTHER_OWNER = '#'.repeat(200);

// The prefix an idempotency key must carry for the entity it maps to. An
// unattributed entity's keys live under its origin (`kind@"origin":`), a
// namespace no project-scoped key (`kind:project:`) can reach.
function idempotencyKeyPrefix(value) {
  const scope = value?.scope ?? {};
  const identity = value?.kind === 'memory'
    ? `${JSON.stringify([scope.userId ?? null, scope.agentId ?? null, scope.runId ?? null, value.memoryType ?? null, value.key ?? null])}:`
    : '';
  const owner = value?.attribution === 'unattributed' ? `@${JSON.stringify(value.originId ?? null)}:` : `:${value?.project}:`;
  return `${value?.kind}${owner}${identity}`;
}

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
// The stated policy threshold: a decision whose recorded confidence is below it
// is reported as such by the default read (PC-01(b)).
const LOW_CONFIDENCE_THRESHOLD = 0.5;

export const OUTCOME_STATUSES = Object.freeze(['successful', 'mixed', 'failed', 'unknown']);
// Deliberately NOT called an outcome. `outcome` here is a decision-only,
// single-slot concept that weights confidence and writes an `outcome.recorded`
// journal entry; none of that applies to an attempt, and reusing the word would
// import those semantics by implication. This only classifies what an attempt's
// free-text `result` already says.
export const ATTEMPT_RESULT_CLASSES = Object.freeze(['failed', 'succeeded', 'inconclusive']);
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

// A stored record carries the fields of its kind; a summary that only names
// one ({ id, kind, ... }) does not. A legacy fact or relation may carry no kind.
const RECORD_FIELDS = new Map([['decision', ['title', 'chosen', 'goal']], ['attempt', ['solution', 'result', 'reason']], ['memory', ['text', 'key']], ['fact', ['key', 'value']]]);
const isRecord = (value) => typeof value.id === 'string' && (value.kind === undefined || (RECORD_FIELDS.get(value.kind) ?? []).some((field) => Object.hasOwn(value, field)));
// Where a public result holds a caller's own value, or an entry as it was
// written: a journal payload, or a retry value (an idempotency entry's value).
const AS_STORED_KEYS = new Set(['payload', 'value', 'expected', 'observed']);

// Every public result -- a read, a write's echo, a journal entry's payload --
// passes through here; only the privileged snapshot does not.
// - Plan rev6 §3.2 (DP-1): an entity's erasureToken is internal and is removed.
// - PR-23: an attempt stored before causes were has no causalClaim, and none is
//   stored for it: an older build replays its journal entry, which has none,
//   and must find the live record equal to it. Its cause is derived here, as
//   legacy free text, on the record itself only: never inside another record,
//   whose content is its writer's, a journal payload, which is shown as it was
//   written, or a caller's value.
// Copies are made only along a path that changes, so stored state is never
// touched.
function publicValue(value, derive = true) {
  if (Array.isArray(value)) {
    let copy = null;
    value.forEach((item, index) => {
      const next = publicValue(item, derive);
      if (next !== item) (copy ??= [...value])[index] = next;
    });
    return copy ?? value;
  }
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  let copy = null;
  if (Object.hasOwn(value, 'erasureToken') && (typeof value.kind === 'string' || Object.hasOwn(value, 'id'))) {
    const { erasureToken, ...rest } = value;
    copy = rest;
  }
  const record = isRecord(value);
  if (derive && record && value.kind === 'attempt' && value.causalClaim === undefined && !isFutureEntity(value)) {
    copy = { ...(copy ?? value), causalClaim: causalClaimFor(value.reason, { legacy: true }) };
  }
  for (const [key, item] of Object.entries(copy ?? value)) {
    const next = publicValue(item, derive && !record && !AS_STORED_KEYS.has(key));
    if (next !== item) (copy ??= { ...value })[key] = next;
  }
  return copy ?? value;
}

function tokenFreeApi(api) {
  return Object.fromEntries(Object.entries(api).map(([name, member]) => [name, typeof member !== 'function' ? member : (...args) => {
    const result = member(...args);
    return result && typeof result.then === 'function' ? result.then((value) => publicValue(value)) : publicValue(result);
  }]));
}

// Detach one value on its way into a response. clone() is the established JSON
// boundary, but it cannot be applied to a whole condition detail: a detail may
// legitimately carry `observed: undefined` ("no fact recorded for this key"),
// and a JSON round-trip would drop that field rather than report it. Primitives
// need no copy, so only objects and arrays pay for one.
function detachValue(value) {
  return value === null || typeof value !== 'object' ? value : clone(value);
}

// Detach every own field of a caller-visible detail object.
//
// Naming the fields that "can" hold an object is not safe: write-time validation
// rejects an object `operator` or `unit`, but import is deliberately lenient and
// preserves stored records verbatim, so a rule written by another build can
// carry an object anywhere. This walks the object's own keys instead of a
// hand-kept list.
//
// It is a field-by-field walk rather than one clone() of the whole detail
// because a detail may legitimately carry `observed: undefined` ("no fact
// recorded for this key"); a JSON round-trip would drop that key rather than
// report it, and callers read key presence. detachValue() leaves `undefined`
// alone, so the key survives.
function detachDetail(detail) {
  for (const key of Object.keys(detail)) detail[key] = detachValue(detail[key]);
  return detail;
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
  const keep = (value) => !removed.has(value?.id);
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

// Deletion can remove the only additions in a midstream migration baseline.
// Drop its replay effect only when every surviving member and retry mapping is
// already identical in the surviving prefix. Keep initial/useful baselines and
// let the normal validators refuse every other malformed placement.
function normalizeRewrittenPurgeBaselines(entries, rewritten, modeFor) {
  const removedSequences = [];
  let skeletons = 0;
  for (const entry of [...entries]) {
    if (!rewritten.has(entry.seq) || entry.type !== 'projection.baseline'
      || entry.derivedFrom !== 'live_state_at_migration' || !entry.payload || entry.redacted === true) continue;
    const prefix = entries.filter(item => item.seq < entry.seq);
    if (!prefix.some(item => REPLAYABLE_ENTRY_TYPES.includes(item.type) && item.replayable !== false)) continue;
    // A staged hard deletion may have gaps whose marker is appended afterwards.
    // They do not change the fold; every other diagnostic still refuses this
    // optimization, and the final complete journal must prove all gap coverage.
    const report = rebuildProjection(prefix, { sourceSchemaVersion: SCHEMA_VERSION });
    if (report.skipped.length || (!report.rebuildable && report.reason !== 'journal contains unexplained sequence gaps inside the replay range')) continue;
    const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
    const redundant = ['records', 'facts', 'relations', 'idempotency'].every(name => {
      const key = name === 'idempotency' ? 'key' : 'id';
      const previous = new Map(report.projection[name].map(item => [item[key], item]));
      return (entry.payload[name] ?? []).every(item => previous.has(item[key]) && same(previous.get(item[key]), item));
    });
    if (!redundant) continue;
    if (modeFor(entry) === 'hard') {
      entries.splice(entries.indexOf(entry), 1);
      removedSequences.push(entry.seq);
    } else {
      scrubLogicalPurgeSkeleton(entry);
      skeletons += 1;
    }
  }
  return { removedSequences, skeletons };
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
  // Schema 5 introduced canonical purge markers; only older sources need this.
  if (Number.isInteger(sourceSchemaVersion) && sourceSchemaVersion >= 5) return;
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
  // A capture's retry value names one occurrence: what it observed never
  // changes, whatever state the item has since reached (PR-34).
  if (value.kind === 'capture') return canonical({
    ...common, originId: value.originId ?? null, source: value.source ?? null,
    observedAt: value.observedAt ?? null, occurrenceSeq: value.occurrenceSeq ?? null
  });
  if (value.kind === 'attempt') {
    const semantic = clone(value);
    // Storage version and attribution are assigned by migration, not by the
    // write a retry repeats; the cause follows from the reason (PR-23), and a
    // public result shows one for an attempt that stores none.
    delete semantic.schemaVersion;
    delete semantic.attribution;
    delete semantic.causalClaim;
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

function severityCounts(issues) {
  const count = (name) => issues.filter((issue) => issue.severity === name).length;
  return { error: count('error'), legacy: count('legacy'), unsupported: count('unsupported'), info: count('info') };
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

// Completeness is relative to this request's known candidates, never a claim
// of total semantic recall. An exact origin can read its unattributed records
// while the project is still unresolved. A grant augments only the read set.
// When the store holds capture state, the scope's capture status comes with it
// (plan v1.4.4 §24.1, M-9). Captured material this scope has not yet had
// understood means the view is not complete. Capture refusing material -- at a
// store limit now, or in a gap it declares -- is said too, without making the
// view incomplete: what was refused was never a candidate any read can find.
// What deletion records withhold as possibly purged, and a restore that has
// not finished, make it incomplete and are said (PR-37c design §9.3): the
// quarantined count is exact, and the pending note covers what the restore
// has not yet settled, in every state of its record.
function scopeCompleteness(scope, current = { complete: true }, signals = []) {
  const partial = signals.some((signal) => signal.limitation?.code === 'scoped_coverage');
  const capture = scope.capture ?? null;
  const backlog = capture ? UNEXTRACTED_STATES.reduce((sum, state) => sum + capture[state], 0) : 0;
  const details = [current.limitation?.detail];
  if (scope.state === 'project_unresolved') details.push(scope.grant
    ? 'No project was resolved. The explicit wider grant augmented any permitted origin-owned content; project identity remains unresolved.'
    : scope.originId === null
    ? 'No project or usable origin was resolved. No project content was searched.'
    : 'No project was resolved. Only unattributed content belonging to the presented origin was searched.');
  if (partial) details.push('Some own signals have historical detail outside this scope. Only their identity and lifecycle are shown.');
  if (scope.grantLimitation) details.push(`Wider access was refused (${scope.grantLimitation}); permitted own-scope access is retained.`);
  const scoped = details.length > 1;
  if (backlog) details.push(`${backlog} captured ${backlog === 1 ? 'item is' : 'items are'} not yet understood in this scope: captured is not stored experience.`);
  if (capture?.limited.length) details.push(`Capture is at a limit (${capture.limited.map((entry) => entry.limit).join(', ')}): new material is refused, and nothing accepted is removed.`);
  const refused = [...new Set((capture?.gaps ?? []).map((entry) => entry.reason).filter((reason) => reason !== RAW_EXPIRED && !TRANSCRIPT_GAP_REASONS.includes(reason)))];
  const unread = [...new Set((capture?.gaps ?? []).map((entry) => entry.reason).filter((reason) => TRANSCRIPT_GAP_REASONS.includes(reason)))];
  if (refused.length) details.push(`Capture refused material (${refused.join(', ')}); what it refused is not here.`);
  if (unread.length) details.push(`Capture did not read part of a session's transcript (${unread.join(', ')}); what it did not read is not here.`);
  if (capture?.gaps.some((entry) => entry.reason === RAW_EXPIRED)) details.push('Capture raw has reached its retention deadline and is unavailable for re-extraction.');
  if (capture?.gaps.some((entry) => entry.reason === RAW_EXPIRED && entry.sessions > 0)) details.push('Transcript capture remains blocked for affected sessions because expired Stop material cannot safely reconcile delayed transcript copies; direct hook capture can continue.');
  const quarantined = scope.quarantined ?? 0;
  if (quarantined) details.push(`${quarantined} ${quarantined === 1 ? 'item of this scope is' : 'items of this scope are'} withheld as possibly purged; only the owner can release or purge them.`);
  if (scope.restorePending) details.push('A restore has not finished; material it may remove or quarantine is withheld until the next write completes it.');
  return {
    ...current,
    scope: { ...current.scope, project: scope.project, requestState: scope.state, originPresented: scope.originId !== null, grant: scope.grant ?? null },
    complete: current.complete === true && scope.state === 'project_selected' && !partial && !scope.grantLimitation && !backlog && !quarantined && !scope.restorePending,
    ...(capture ? { capture: { ...capture, limited: capture.limited.map((entry) => ({ ...entry })), gaps: capture.gaps.map((entry) => ({ ...entry })) } } : {}),
    ...(quarantined ? { quarantined } : {}),
    ...(partial ? { losslessItems: false } : {}),
    ...(details.some(Boolean) ? { limitation: { ...current.limitation, code: current.limitation?.code ?? (scoped ? 'scoped_coverage' : backlog ? 'capture_pending' : capture?.limited.length ? 'capture_limited' : refused.length || unread.length || !(quarantined || scope.restorePending) ? 'capture_gap' : quarantined ? 'quarantine_withheld' : 'restore_pending'), detail: details.filter(Boolean).join(' ') } } : {})
  };
}

function scopedResult(result, boundary, signals = []) {
  return { ...result, completeness: scopeCompleteness(boundary.scope, result.completeness ?? { complete: true, ...(result.limitation ? { limitation: result.limitation } : {}) }, signals) };
}

function scopedPage(items, options, boundary, scope, extra = {}) {
  return scopedResult(paginate(items, options, scope, extra), boundary);
}

function scopedItems(items, boundary, signals = []) {
  return scopedResult({ items, completeness: { returned: items.length, total: items.length, omitted: 0, complete: true, losslessItems: true } }, boundary, signals);
}

// The pointer from the default-path read to the operation that took over its
// old evaluate-and-persist behaviour (plan v1.4.4 §13.2). It is declared,
// non-canonical interface metadata, names the replacement, and names no
// release: when it is withdrawn is a release decision.
function contextNotice() {
  return {
    code: 'context_does_not_persist',
    detail: 'context is a read and persists no review signal. reviewContext evaluates and persists: MCP shadowgraph_review_context, CLI review-context, HTTP POST /review-context.',
    replacement: { kernel: 'reviewContext', mcp: 'shadowgraph_review_context', cli: 'review-context', http: 'POST /review-context' }
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
  // Capture items (PR-33): stored in `records[]`, held apart here so no read of
  // records ever meets one. Only persistence, import, purge and id allocation
  // look in this map.
  const captures = new TransactionMap();
  const currentMemories = new TransactionMap();
  const facts = new TransactionMap();
  const currentFacts = new TransactionMap();
  const events = new TransactionArray();
  const journal = new TransactionArray();
  const relations = new TransactionMap();
  const reviewSignals = new TransactionMap();
  const idempotency = new TransactionMap();
  // Top-level collections this build does not understand, carried verbatim
  // through import and the privileged snapshot (axis A-5). They are never
  // interpreted, and never part of a public read.
  const extras = new TransactionMap();
  // Deletion knowledge (PR-37a; design §2, §11, §12): the store control
  // ledger's view a load hands the import, under 'view', and the withheld set W
  // it names, under 'held'. Values here are replaced whole, never changed in
  // place, so a transaction can undo them.
  const deletion = new TransactionMap();
  let readOperation = null;
  const authority = createAccessLifecycle({
    now,
    read: () => ({ access: extras.get('access'), accessRevocations: extras.get('accessRevocations'), events }),
    write: payload => {
      if (payload.access !== undefined) extras.set('access', clone(payload.access));
      if (payload.accessRevocations !== undefined) extras.set('accessRevocations', clone(payload.accessRevocations));
      const previous = [...events];
      if (transactionContext?.mode === 'undo') transactionContext.undo.push(() => { events.length = 0; Array.prototype.push.apply(events, previous); });
      events.length = 0; Array.prototype.push.apply(events, clone(payload.events));
    }
  });

  function bindProject(input = {}) {
    if (!['worktree', 'shared_repository'].includes(input.type) || typeof input.path !== 'string' || !input.path.trim() || typeof input.project !== 'string' || !input.project.trim()) throw new Error('Binding requires explicit mapping type, resolved path and project');
    const current = extras.get('projectBindings') ?? { entries: [] };
    if (!Array.isArray(current.entries)) throw new Error('Project bindings are malformed');
    const binding = { type: input.type, path: input.path, project: input.project, confirmed: true, confirmedAt: now() };
    extras.set('projectBindings', { entries: [...current.entries.filter(item => !(item.type === input.type && item.path === input.path)), binding] });
    event('project.bound', { mode: 'confirmation', activationSignal: 'local_binding_file', mappingType: binding.type, path: binding.path, boundProject: binding.project, reason: input.reason ?? null, surface: input.surface ?? 'local-owner' });
    return clone(binding);
  }
  function resolveProjectBinding({ worktreeRoot, commonDir } = {}) {
    const entries = extras.get('projectBindings')?.entries;
    if (!Array.isArray(entries)) return null;
    const found = entries.find(item => item.confirmed === true && item.type === 'worktree' && item.path === worktreeRoot)
      ?? entries.find(item => item.confirmed === true && item.type === 'shared_repository' && item.path === commonDir);
    return found ? { project: found.project, confirmed: true } : null;
  }

  // The capture writer (plan v1.4.4 PR-34, §12; the shape PR-33 froze). It is
  // privileged: nothing registered calls it yet -- no verb, hook or worker --
  // and nothing it writes is shown on a public read.
  //
  // A capture belongs to the origin that observed it and to its session's
  // owner, fixed at the session's first capture so a binding change never
  // splits a session. Its ordinal is the session's next, allocated inside this
  // write -- past both the session record's mark and every ordinal a live
  // capture of the session holds, so a stale or damaged record can never hand
  // one out twice -- and a write that never lands allocates nothing. Identity
  // follows the source contract (CAPTURE_EVENT_IDENTITY): the host identifier
  // the event's row names makes a re-delivery the same occurrence, a SessionEnd
  // is one per session, and otherwise every call is a new occurrence (F-11b).
  // The identity key is a digest of the origin, session, event and that
  // identifier or ordinal: never content. The raw text goes into
  // captureContent under a random key, never into the journal.
  //
  // Admission (plan v1.4.4 §22.6.1, M-11; PR-36b) is checked here, inside the
  // write: the caller passes the limits and the store's bytes on disk, and the
  // item's bytes, the session's items, the queue (items not yet extracted) and
  // the store are measured against them. A crossing writes no item: it returns
  // the refusal, and only the first refusal of a store or session limit writes
  // anything -- the start of its capture_limited episode; an accepted item ends
  // the episodes it shows no longer bind. Nothing accepted is ever evicted, and
  // no limit is raised here. A session one project owns never takes another
  // project's capture: that is refused, not filed under the first project.
  // An item identified only by its ordinal whose material repeats the session's
  // previous item of the same event is marked possibleDuplicateOf it (F-11a).
  const retentionPolicy = () => deletion.get('view')?.retentionOverrides ?? [];
  const rawExpired = (item, at = now()) => {
    const restoreAt = deletion.get('view')?.retentionAt;
    return captureRawExpired(item, retentionPolicy(), isValidIsoInstant(restoreAt) && Date.parse(restoreAt) > Date.parse(at) ? restoreAt : at);
  };

  function recordCapture(input = {}, { keyBlock = null, withhold = false } = {}) {
    if (!isPlainObject(input)) throw new Error('A capture needs an input object');
    const originId = usableOriginId(input.originId);
    if (originId === null || originId !== input.originId) throw new Error('A capture names the originId that observed it');
    const source = input.source;
    if (!isPlainObject(source) || !Object.hasOwn(CAPTURE_EVENT_IDENTITY, source.event)) throw new Error(`A capture source names an event the source contract covers: ${Object.keys(CAPTURE_EVENT_IDENTITY).join(', ')}`);
    if (!named(source.sessionId)) throw new Error('A capture source names its sessionId');
    if (input.text !== undefined && typeof input.text !== 'string') throw new Error('A capture text is a string');
    if (input.observedAt !== undefined && !isValidIsoInstant(input.observedAt)) throw new Error('A capture observedAt is an ISO 8601 instant');
    const admission = input.admission;
    if (!isPlainObject(admission) || !isPlainObject(admission.limits) || !ADMISSION_LIMITS.every((name) => Number.isSafeInteger(admission.limits[name]) && admission.limits[name] > 0) || !Number.isSafeInteger(admission.storeBytes) || admission.storeBytes < 0) {
      throw new Error(`A capture names its admission: the limits ${ADMISSION_LIMITS.join(', ')}, each a positive integer, and the store's bytes`);
    }
    const observationIssue = input.observation === undefined ? null : captureObservationIssue(input.observation);
    if (observationIssue) throw new Error(`A capture ${observationIssue}`);
    // A project named as null is no project named, as it is when left out.
    const project = input.project ?? undefined;
    if (project !== undefined && (typeof project !== 'string' || !project.trim())) throw new Error('A capture names its project as a non-empty string, or none');
    const { sessions, session, held, owner, ownedBy, withheld } = captureSession(originId, source.sessionId, project);
    // A session W holds is never minted again, nor written to (design §12 C1).
    if (withheld) return { refused: { reason: SESSION_WITHHELD }, changed: false };
    const observed = {
      event: source.event, sessionId: source.sessionId, role: source.role ?? null,
      hostEventId: source.hostEventId ?? null, toolCallId: source.toolCallId ?? null, turnIndex: source.turnIndex ?? null
    };
    const identifiedBy = CAPTURE_EVENT_IDENTITY[observed.event];
    const hostIdentity = identifiedBy === 'session' ? ['session']
      : identifiedBy !== null && observed[identifiedBy] !== null ? [identifiedBy, observed[identifiedBy]] : null;
    const occurrenceSeq = held + 1;
    const identityKey = createHash('sha256').update(JSON.stringify([originId, observed.sessionId, observed.event, ...(hostIdentity ?? ['occurrence', occurrenceSeq])])).digest('hex');
    let slot;
    try { slot = retrySlot({ ...owner, idempotencyKey: identityKey }, CAPTURE_KIND, owner); }
    catch (error) { if (error.code === IDEMPOTENCY_KEY_WITHHELD) return { refused: { reason: IDEMPOTENCY_KEY_WITHHELD }, changed: false }; throw error; }
    if (idempotency.has(slot)) {
      if (hostIdentity) return clone(canonicalIdempotencyValue(idempotency.get(slot)));
      throw new Error('Capture refused: its occurrence is already held');
    }
    const at = now();
    if (ownedBy?.attribution === 'project' && project !== undefined && project !== ownedBy.project) return refuseOtherOwner(project, at);
    // ShadowGraph's own delivered blocks never become raw material; each one
    // removed is counted as a tool-target self-event (§16.4; PR-35).
    const stripped = input.text === undefined ? { text: undefined, removed: 0 } : stripDeliveredBlocks(input.text);
    // Redaction at capture, before the write (§21.2 M-2; PR-37b): after the
    // blocks are stripped, whose closing lines are matched by their bytes, and
    // before anything is measured, hashed or kept. Text more than twice what an
    // item may hold is refused unredacted, as the transcript read does. What
    // the checker still flags is withheld: the item is kept, blocked, with no
    // content. The transcript read carries a private key's state across the
    // entries it records (revision 2 R6), and withholds every entry of a run
    // whose joined text the checker flags (review F1).
    if (stripped.text !== undefined && Buffer.byteLength(stripped.text) > 2 * admission.limits.maxItemBytes) {
      return refuseAdmission({ limit: 'maxItemBytes', ceiling: admission.limits.maxItemBytes, scope: 'item' }, session, sessions, at);
    }
    const redacted = stripped.text === undefined ? undefined : keyBlock ? redactValue(stripped.text, keyBlock) : redactText(stripped.text);
    const withheldText = redacted !== undefined && (withhold || captureWithheld(redacted));
    const text = withheldText ? undefined : redacted;
    const observation = input.observation === undefined ? undefined : withholdFlagged(redactValue(input.observation));
    const crossing = admissionCrossing(admission, text, originId, observed.sessionId, [observation ?? null, observed], at);
    if (crossing) return refuseAdmission(crossing, session, sessions, at);
    const contentHash = text === undefined ? null : createHash('sha256').update(text).digest('hex');
    const item = {
      id: allocateEntityId(CAPTURE_KIND), kind: CAPTURE_KIND, schemaVersion: SCHEMA_VERSION,
      project: owner.project, attribution: owner.attribution, originId,
      state: withheldText ? 'blocked' : 'pending', source: observed, observedAt: input.observedAt ?? at, occurrenceSeq,
      sourceIdentity: input.sourceIdentity ?? 'unattributed_observer',
      contentRef: text === undefined ? null : `content_${randomUUID()}`,
      contentHash,
      lease: null, attempts: 0, lastError: null, blockedReason: withheldText ? CREDENTIAL_WITHHELD : null, producedRecordIds: [], receipts: [],
      erasureToken: allocateErasureToken(), cancelRequested: false, supersededResults: [],
      possibleDuplicateOf: withheldText ? null : hostIdentity === null ? previousRepeat(originId, observed, contentHash, at) : observed.event === 'Transcript' ? assistantRepeat(originId, observed.sessionId, contentHash, at) : null,
      expiresAt: null, createdAt: at, updatedAt: at,
      ...(observation === undefined ? {} : { observation })
    };
    item.expiresAt = effectiveCaptureExpiry(item, retentionPolicy());
    const issue = captureItemIssue(item);
    if (issue) throw new Error(`Capture refused: ${issue}`);
    assertJournalCapacity(1);
    captures.set(item.id, item);
    const next = { ...(session ?? newCaptureSession(originId, observed.sessionId, owner)), project: owner.project, attribution: owner.attribution, occurrenceSeqHighWater: occurrenceSeq, updatedAt: at };
    if (stripped.removed) next.selfEvents = countSelfEvent(next.selfEvents, 'S-1', observed.event, stripped.removed);
    // An accepted item shows the store's limits and this session's no longer bind.
    if (next.limited?.since) next.limited = { ...next.limited, since: null, lastPeriod: { from: next.limited.since, to: at } };
    endStoreLimits(at);
    extras.set(CAPTURE_SESSIONS, session ? sessions.map((entry) => (entry === session ? next : entry)) : [...sessions, next]);
    if (item.contentRef) extras.set(CAPTURE_CONTENT, [...(extras.get(CAPTURE_CONTENT) ?? []), { contentRef: item.contentRef, project: owner.project, attribution: owner.attribution, originId, text }]);
    appendJournal({ type: 'capture.recorded', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, payload: item, idempotencyKey: slot });
    idempotency.set(slot, clone(item));
    return clone(item);
  }

  // A capture session and its owner: its record's, else that of the captures
  // it already has (a session whose record is gone keeps its owner), else the
  // write's. A record that holds only self-event counters has no owner yet, so
  // ShadowGraph's own traffic never decides whose work follows: the session's
  // first capture, or its transcript cursor (PR-36), gives it one. Its count
  // is past the record's mark and every ordinal a live capture of the session
  // holds.
  function captureSession(originId, sessionId, project) {
    const sessions = extras.get(CAPTURE_SESSIONS) ?? [];
    const session = sessions.find((entry) => entry.originId === originId && entry.sessionId === sessionId);
    // ponytail: a scan of every capture per write; an index by session if capture volume grows.
    let held = Number.isSafeInteger(session?.occurrenceSeqHighWater) && session.occurrenceSeqHighWater > 0 ? session.occurrenceSeqHighWater : 0;
    let earlier = null;
    for (const item of captures.values()) {
      if (item.originId !== originId || item.source?.sessionId !== sessionId || !Number.isSafeInteger(item.occurrenceSeq)) continue;
      held = Math.max(held, item.occurrenceSeq);
      earlier ??= item;
    }
    // A capture W holds keeps its ordinal (PR-37a).
    for (const item of withheldCaptures()) if (item.originId === originId && item.source?.sessionId === sessionId && Number.isSafeInteger(item.occurrenceSeq)) held = Math.max(held, item.occurrenceSeq);
    const owned = session && (session.occurrenceSeqHighWater > 0 || earlier || isPlainObject(session.cursor)) ? session : null;
    const resolved = owned ?? earlier ?? writeOwner({ project, originId });
    return { sessions, session, held, owner: { project: resolved.project, attribution: resolved.attribution, originId }, ownedBy: owned ?? earlier, withheld: sessionWithheld(originId, sessionId) };
  }

  // The first admission limit an item crosses, or null (§22.6.1): its own
  // bytes (a transient refusal, never an episode), then its session's items
  // (every item the session holds), the queue of items not yet extracted, and
  // the store's bytes on disk with the item's own stored size estimated -- its
  // escaped material once, what it describes (its observation and source) three
  // times, as the item, its journal entry and its retry value each hold it, and
  // a fixed allowance for the rest.
  function admissionCrossing({ limits, storeBytes }, text, originId, sessionId, described, at) {
    const bytes = text === undefined ? 0 : Buffer.byteLength(text);
    if (bytes > limits.maxItemBytes) return { limit: 'maxItemBytes', ceiling: limits.maxItemBytes, scope: 'item' };
    let sessionItems = 0;
    let queued = 0;
    for (const item of captures.values()) {
      if (rawExpired(item, at)) continue;
      if (item.state !== 'extracted') queued += 1;
      if (item.originId === originId && item.source?.sessionId === sessionId) sessionItems += 1;
    }
    if (sessionItems >= limits.maxItemsPerSession) return { limit: 'maxItemsPerSession', ceiling: limits.maxItemsPerSession, scope: 'session' };
    if (queued >= limits.maxQueueDepth) return { limit: 'maxQueueDepth', ceiling: limits.maxQueueDepth, scope: 'store' };
    if (storeBytes + storedEstimate(text, described) > limits.maxStoreBytes) return { limit: 'maxStoreBytes', ceiling: limits.maxStoreBytes, scope: 'store' };
    return null;
  }
  const storedEstimate = (text, described) => (text === undefined ? 0 : Buffer.byteLength(JSON.stringify(text))) + 3 * Buffer.byteLength(JSON.stringify(described)) + CAPTURE_ITEM_ALLOWANCE;

  // A refused capture. The first refusal of a store limit opens its episode in
  // the events carrier (one entry per limit, updated in place, holding no
  // project, session or content), and of the session limit on the session's
  // record; a refusal while the episode is open writes nothing. `changed` says
  // whether anything was written, so a caller saves only then.
  function refuseAdmission(crossing, session, sessions, at) {
    const refused = { limit: crossing.limit, ceiling: crossing.ceiling };
    if (crossing.scope === 'store') {
      const index = events.findIndex((entry) => entry?.type === CAPTURE_LIMIT_EVENT && entry.limit === crossing.limit);
      const held = index === -1 ? null : events[index];
      if (held?.since) return { refused, changed: false };
      replaceEvent(index, { id: held?.id ?? id('capture_limit'), type: CAPTURE_LIMIT_EVENT, at, limit: crossing.limit, ceiling: crossing.ceiling, since: at, lastPeriod: held?.lastPeriod ?? null, periods: (held?.periods ?? 0) + 1 });
      return { refused, changed: true };
    }
    if (crossing.scope === 'session' && session && !session.limited?.since) {
      const limited = { limit: crossing.limit, ceiling: crossing.ceiling, since: at, lastPeriod: session.limited?.lastPeriod ?? null, periods: (session.limited?.periods ?? 0) + 1 };
      extras.set(CAPTURE_SESSIONS, sessions.map((entry) => (entry === session ? { ...entry, limited, updatedAt: at } : entry)));
      return { refused, changed: true };
    }
    return { refused, changed: false };
  }

  // A capture refused because another project owns its session (D-6). The
  // first such refusal for a project leaves one entry in the events carrier,
  // labelled with that project -- so its reads declare the gap and a purge of
  // it takes the entry along -- naming no session, other project or material.
  function refuseOtherOwner(project, at) {
    const held = events.some((entry) => entry?.type === CAPTURE_REFUSED_EVENT && entry.project === project && entry.reason === OTHER_OWNER);
    if (!held) events.push({ id: id('capture_refused'), type: CAPTURE_REFUSED_EVENT, at, project, reason: OTHER_OWNER, since: at });
    return { refused: { reason: OTHER_OWNER }, changed: !held };
  }

  // Ends every open store-limit episode, keeping the period it covered.
  function endStoreLimits(at) {
    events.forEach((entry, index) => {
      if (entry?.type === CAPTURE_LIMIT_EVENT && entry.since) replaceEvent(index, { ...entry, at, since: null, lastPeriod: { from: entry.since, to: at } });
    });
  }

  // One events-carrier entry replaced in place, or appended; undone with the
  // write that made it.
  function replaceEvent(index, value) {
    if (index === -1) {
      events.push(value);
      return;
    }
    const previous = events[index];
    if (transactionContext?.mode === 'undo') transactionContext.undo.push(() => { events[index] = previous; });
    events[index] = value;
  }

  // The session's latest item of the same event, when its material is the
  // same -- none, for an event that carries none, repeats none.
  function previousRepeat(originId, observed, contentHash, at) {
    let latest = null;
    for (const item of captures.values()) {
      if (item.originId === originId && item.source?.sessionId === observed.sessionId && item.source?.event === observed.event && (latest === null || item.occurrenceSeq > latest.occurrenceSeq)) latest = item;
    }
    // Withheld material is no repeat of anything, whatever it held (PR-37b
    // R14): both hashes are null, and the texts were different.
    return latest !== null && !rawExpired(latest, at) && latest.blockedReason !== CREDENTIAL_WITHHELD && latest.contentHash === contentHash ? latest.id : null;
  }

  // The newest assistant item of the session -- a Stop's final message or
  // transcript text -- holding the same material (PR-36 rule 3; §12.2.1 row 5):
  // what a transcript item repeats, marked and never removed.
  function assistantRepeat(originId, sessionId, contentHash, at) {
    if (contentHash === null) return null;
    let latest = null;
    for (const item of captures.values()) {
      if (item.originId === originId && item.source?.sessionId === sessionId && ['Stop', 'Transcript'].includes(item.source?.event) && !rawExpired(item, at) && item.contentHash === contentHash && (latest === null || item.occurrenceSeq > latest.occurrenceSeq)) latest = item;
    }
    return latest?.id ?? null;
  }

  // OD-2 removes eligible uncited raw, including raw held in quarantine.
  // The view is reapplied after the operation: expiry never releases it.
  // Canonical records, authority and deletion knowledge are not mutated.
  function expireCapture({ maxItems = 64, maxSessions = 64, mayContinue = () => true, endLimits = false } = {}) {
    if (![maxItems, maxSessions].every((value) => Number.isSafeInteger(value) && value > 0) || typeof mayContinue !== 'function') throw new Error('Capture expiry requires positive work bounds');
    const result = { changed: false, expired: 0, keptCited: 0, sessionsRemoved: 0, more: false };
    if (!mayContinue()) return { ...result, more: true };
    if (deletion.has('held')) {
      unhold();
      try { return expireCapture({ maxItems, maxSessions, mayContinue, endLimits }); } finally { hold(); }
    }
    const at = now();
    const cited = new Set();
    // Unsupported extraction output has its own seven-day lifetime, even
    // when accepted records require the raw citation to remain. Scrub every
    // persisted copy so replay cannot recover expired unsupported text.
    const outputExpired = new Set();
    for (const item of captures.values()) {
      if (!mayContinue()) { result.more = true; break; }
      if (item.extractionOutput?.unsupported?.length && isValidIsoInstant(item.extractionOutput.expiresAt)
        && Date.parse(item.extractionOutput.expiresAt) <= Date.parse(at)) {
        if (outputExpired.size >= maxItems) { result.more = true; break; }
        outputExpired.add(item.id);
      }
    }
    const expireOutput = value => {
      if (!value || typeof value !== 'object') return;
      if (value.kind === CAPTURE_KIND && outputExpired.has(value.id) && value.extractionOutput) {
        value.extractionOutput = { ...value.extractionOutput, unsupported: [], expired: true };
      } else for (const child of Object.values(value)) expireOutput(child);
    };
    if (outputExpired.size) {
      for (const item of captures.values()) expireOutput(item);
      for (const value of idempotency.values()) expireOutput(value);
      for (const entry of journal) expireOutput(entry.payload);
      result.changed = true;
      result.outputsExpired = outputExpired.size;
    }
    // Typed source links only; keep the complete source entry when cited span
    // and context cannot safely be separated. Held canonical records count.
    for (const entity of [...records.values(), ...facts.values()]) {
      if (!mayContinue()) return { ...result, more: true };
      if (typeof entity.captureRef === 'string') cited.add(entity.captureRef);
      for (const claim of entity.claims ?? []) if (typeof claim?.sourceRef === 'string') cited.add(claim.sourceRef);
    }
    const selected = new Map();
    for (const item of captures.values()) {
      if (!mayContinue()) { result.more = true; break; }
      if (!rawExpired(item, at)) continue;
      if (cited.has(item.id) || cited.has(item.contentRef)) { result.keptCited += 1; continue; }
      const expiry = effectiveCaptureExpiry(item, retentionPolicy());
      if (item.contentRef === null && item.contentHash === null && item.possibleDuplicateOf === null && item.expiresAt === expiry && !['pending', 'failed'].includes(item.state)) continue;
      if (selected.size >= maxItems) { result.more = true; break; }
      selected.set(item.id, { item, expiry });
    }
    const refs = new Set([...selected.values()].map(({ item }) => item.contentRef).filter(Boolean));
    const states = [...selected.values()].filter(({ item }) => ['pending', 'failed'].includes(item.state));
    assertJournalCapacity(states.length);
    // Redact raw pointers/hashes in every known capture copy, keeping the
    // historical state each entry witnessed. New state changes are journaled.
    const scrub = (item) => {
      if (item?.kind !== CAPTURE_KIND || item.schemaVersion !== SCHEMA_VERSION) return;
      const selectedItem = selected.get(item.id);
      if (selectedItem) {
        item.contentRef = null;
        item.contentHash = null;
        item.possibleDuplicateOf = null;
        item.expiresAt = selectedItem.expiry;
      } else if (selected.has(item.possibleDuplicateOf)) item.possibleDuplicateOf = null;
    };
    if (selected.size) {
      for (const item of captures.values()) scrub(item);
      for (const value of idempotency.values()) scrub(value);
      for (const entry of journal) {
        if (entry.type === 'projection.baseline') for (const item of entry.payload?.records ?? []) scrub(item);
        else scrub(entry.payload);
      }
      const content = extras.get(CAPTURE_CONTENT) ?? [];
      const kept = content.filter((entry) => !refs.has(entry.contentRef));
      if (kept.length) extras.set(CAPTURE_CONTENT, kept);
      else extras.delete(CAPTURE_CONTENT);
      for (const { item } of states) {
        const next = { ...item, state: 'blocked', blockedReason: RAW_EXPIRED, updatedAt: at };
        captures.set(item.id, next);
        appendJournal({ type: 'capture.state_changed', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, payload: next });
      }
      result.changed = true;
      result.expired = selected.size;
    }
    // Session-only metadata has its own finite lifetime. A represented session
    // keeps its ordinal and cursor, including the expired Stop refusal.
    const represented = new Set([...captures.values()].map((item) => JSON.stringify([item.originId, item.source.sessionId])));
    const sessions = extras.get(CAPTURE_SESSIONS) ?? [];
    for (const session of sessions) {
      if (!session.limited?.since) continue;
      const count = [...captures.values()].filter((item) => item.originId === session.originId && item.source.sessionId === session.sessionId && !rawExpired(item, at)).length;
      if (count < session.limited.ceiling) {
        session.limited = { ...session.limited, since: null, lastPeriod: { from: session.limited.since, to: at } };
        result.changed = true;
      }
    }
    let changedSessions = 0;
    const keptSessions = sessions.filter((session) => {
      // A refusal is a privacy/exclusion barrier, not orphaned raw metadata.
      // Dropping it could ingest a delayed old transcript copy after deletion.
      if (session.cursor?.blocked) return true;
      if (represented.has(JSON.stringify([session.originId, session.sessionId]))) return true;
      if (!mayContinue()) { result.more = true; return true; }
      const last = [session.updatedAt, session.cursor?.advancedAt, session.cursor?.blocked?.at, session.startedAt, ...(Array.isArray(session.gaps) ? session.gaps.flatMap((gap) => [gap?.from, gap?.to]) : [])].filter(isValidIsoInstant).sort(compareInstants).at(-1);
      const days = session.attribution === 'project' ? retentionPolicy().find((entry) => entry.project === session.project)?.days ?? RAW_RETENTION_DAYS : RAW_RETENTION_DAYS;
      if (last && Date.parse(last) + days * 86_400_000 > Date.parse(at)) return true;
      // Stable recent metadata must not consume every mutation slot forever.
      if (changedSessions >= maxSessions) { result.more = true; return true; }
      changedSessions += 1;
      if (!last) { session.updatedAt = at; result.changed = true; return true; }
      result.changed = true;
      result.sessionsRemoved += 1;
      return false;
    });
    if (keptSessions.length !== sessions.length) {
      if (keptSessions.length) extras.set(CAPTURE_SESSIONS, keptSessions);
      else extras.delete(CAPTURE_SESSIONS);
    }
    if (endLimits && events.some((entry) => entry?.type === CAPTURE_LIMIT_EVENT && entry.since)) result.changed = true;
    if (result.expired || endLimits) endStoreLimits(at);
    else {
      // Even contentless/cited expired items stop contributing to admission.
      const queued = [...captures.values()].filter((item) => item.state !== 'extracted' && !rawExpired(item, at)).length;
      events.forEach((entry, index) => {
        if (entry?.type === CAPTURE_LIMIT_EVENT && entry.limit === 'maxQueueDepth' && entry.since && queued < entry.ceiling) {
          replaceEvent(index, { ...entry, at, since: null, lastPeriod: { from: entry.since, to: at } });
          result.changed = true;
        }
      });
    }
    return result;
  }

  // CLI-only lifecycle access uses exactly its owner, never a grant that
  // widens experience reads. Quarantined captures are absent from this map.
  function captureOwner(input = {}) {
    const scope = resolveScope({ project: input.project, originId: input.originId, binding: input.binding });
    const owns = (item) => item && (scope.state === 'project_selected'
      ? item.attribution === 'project' && item.project === scope.project
      : item.attribution === 'unattributed' && sameOrigin(item.originId, scope.originId));
    return { scope, owns };
  }

  function inspectCapture(input = {}) {
    const { scope, owns } = captureOwner(input);
    const items = [...captures.values()].filter((item) => owns(item) && (input.id === undefined || input.id === item.id));
    if (input.id !== undefined && !items.length) throw Object.assign(new Error('Capture item not found in this scope'), { code: 'capture_item_not_found' });
    const at = now();
    return { revision, scope, items: items.map((item) => {
      // Only explicit metadata is projected: future/unknown fields and raw
      // carriers must never leak through a spread of the persisted item.
      const produced = item.producedRecordIds.map((id) => records.get(id) ?? facts.get(id));
      const referenced = new Set();
      // The frozen capture contract permits record references as string
      // values in receipts and carried fields, not only producedRecordIds.
      const collect = (value) => {
        if (typeof value === 'string') {
          const entity = records.get(value) ?? facts.get(value);
          if (owns(entity)) referenced.add(entity);
        } else if (value && typeof value === 'object') for (const child of Object.values(value)) collect(child);
      };
      collect(item);
      const invalidated = [...produced, ...referenced].some((entity) => !owns(entity)
        || ['superseded', 'invalidated', 'reconsidered', 'stale', 'archived'].includes(entity.status)
        || (isValidIsoInstant(entity.updatedAt) && compareInstants(entity.updatedAt, item.updatedAt) > 0));
      const expired = rawExpired(item, at);
      const rawAvailable = !expired && item.contentRef !== null && (extras.get(CAPTURE_CONTENT) ?? []).some((entry) => entry.contentRef === item.contentRef);
      const recipeChanges = item.state === 'extracted'
        ? Object.keys(EXTRACTION_RECIPE).filter(key => item.receipts.at(-1)?.[key] !== EXTRACTION_RECIPE[key]) : [];
      const lastReprocessing = item.receipts.at(-1)?.reprocessing;
      const reprocessOutcome = lastReprocessing && typeof lastReprocessing === 'object' ? {
        ...Object.fromEntries(['preservedCorrections', 'skippedProposals'].filter(key => Number.isSafeInteger(lastReprocessing[key]) && lastReprocessing[key] >= 0).map(key => [key, lastReprocessing[key]])),
        ...(typeof lastReprocessing.retainedPriorEvidence === 'boolean' ? { retainedPriorEvidence: lastReprocessing.retainedPriorEvidence } : {})
      } : undefined;
      const projectFields = (value, names) => Object.fromEntries(names.filter((name) => value?.[name] !== undefined).map((name) => [name, clone(value[name])]));
      return {
        ...projectFields(item, ['id', 'kind', 'schemaVersion', 'project', 'attribution', 'originId', 'state', 'occurrenceSeq', 'observedAt', 'createdAt', 'updatedAt', 'blockedReason', 'attempts', 'sourceIdentity']),
        source: projectFields(item.source, ['event', 'sessionId', 'role', 'hostEventId', 'toolCallId', 'turnIndex']),
        observation: projectFields(item.observation, ['host', 'hostVersion', 'toolName', 'outcome']),
        expiresAt: effectiveCaptureExpiry(item, retentionPolicy()), rawAvailable,
        ...(item.extractionOutput ? { extractionOutput: {
          unsupported: isValidIsoInstant(item.extractionOutput.expiresAt) && Date.parse(item.extractionOutput.expiresAt) > Date.parse(at)
            ? clone(item.extractionOutput.unsupported ?? []) : [],
          expiresAt: item.extractionOutput.expiresAt,
          expired: !isValidIsoInstant(item.extractionOutput.expiresAt) || Date.parse(item.extractionOutput.expiresAt) <= Date.parse(at)
        } } : {}),
        producedRecords: produced.filter(owns).map((entity) => projectFields(entity, ['id', 'kind', 'status', 'updatedAt'])),
        derivedInvalidated: invalidated, recipeChanged: recipeChanges.length > 0,
        ...(reprocessOutcome ? { lastReprocessing: reprocessOutcome } : {}),
        reprocessReasons: [...recipeChanges, ...(invalidated ? ['derivedInvalidated'] : [])],
        reprocessable: (invalidated || recipeChanges.length > 0) && rawAvailable,
        reprocessingUnavailableReason: expired ? RAW_EXPIRED : rawAvailable ? null : 'raw_unavailable'
      };
    }) };
  }

  function requestReprocess(input = {}) {
    const item = captures.get(input.id), at = now();
    if (!captureOwner(input).owns(item)) throw Object.assign(new Error('Capture item not found in this scope'), { code: 'capture_item_not_found' });
    if (rawExpired(item, at)) throw Object.assign(new Error('Expired raw cannot be re-extracted'), { code: RAW_EXPIRED });
    if (item.contentRef === null || !(extras.get(CAPTURE_CONTENT) ?? []).some(entry => entry.contentRef === item.contentRef)) {
      throw Object.assign(new Error('Capture raw is unavailable for re-extraction'), { code: 'raw_unavailable' });
    }
    const retryReprocess = item.reprocessRequest && ['failed', 'blocked'].includes(item.state);
    if (isNewerThanWriter(item) || (!['extracted', 'processing'].includes(item.state) && !retryReprocess) || item.cancelRequested) {
      throw Object.assign(new Error('Capture is not eligible for a reprocess request'), { code: 'capture_reprocess_state_refused' });
    }
    assertJournalCapacity(1);
    const next = { ...clone(item), state: 'pending', lease: null, blockedReason: null, lastError: null, updatedAt: at,
      reprocessRequest: { id: randomUUID(), at, actor: 'owner', surface: 'cli' } };
    captures.set(item.id, next);
    appendJournal({ type: 'capture.state_changed', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, payload: next });
    return { id: item.id, state: 'pending', requestId: next.reprocessRequest.id };
  }

  function cancelCapture(input = {}) {
    const item = captures.get(input.id);
    if (!captureOwner(input).owns(item)) throw Object.assign(new Error('Capture item not found in this scope'), { code: 'capture_item_not_found' });
    if (isNewerThanWriter(item) || !['pending', 'processing', 'failed', 'blocked'].includes(item.state)) throw Object.assign(new Error('Only uncompleted capture can be cancelled'), { code: 'capture_cancel_state_refused' });
    if (item.state === 'blocked' && item.blockedReason === 'capture_cancelled') return { id: item.id, changed: false, state: 'blocked' };
    assertJournalCapacity(1);
    const next = { ...item, state: 'blocked', blockedReason: 'capture_cancelled', cancelRequested: true, lease: null, updatedAt: now() };
    captures.set(item.id, next);
    appendJournal({ type: 'capture.state_changed', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, payload: next });
    return { id: item.id, changed: true, state: 'blocked' };
  }

  function preserveDeletedCaptureSession(item, at) {
    // Restored deletion knowledge must retain the same replay barrier as a
    // direct deletion, even when the backup never had a transcript cursor.
    if (typeof item.originId !== 'string' || typeof item.source?.sessionId !== 'string') return;
    const { sessions, session, held } = captureSession(item.originId, item.source.sessionId, item.project);
    const nextSession = {
      ...(session ?? newCaptureSession(item.originId, item.source.sessionId, item)), occurrenceSeqHighWater: held, updatedAt: at,
      cursor: { ...(session?.cursor ?? {}), anchor: null, blocked: session?.cursor?.blocked ?? { reason: 'capture_deleted', at } }
    };
    extras.set(CAPTURE_SESSIONS, session ? sessions.map((entry) => entry === session ? nextSession : entry) : [...sessions, nextSession]);
  }

  function deleteCapture(input = {}, { recovery = false } = {}) {
    const item = captures.get(input.id);
    if (!item || (!recovery && !captureOwner(input).owns(item))) throw Object.assign(new Error('Capture item not found in this scope'), { code: 'capture_item_not_found' });
    if (isNewerThanWriter(item) || !['pending', 'failed', 'blocked'].includes(item.state)) throw Object.assign(new Error('Only pending, failed or blocked capture can be deleted before extraction'), { code: 'capture_delete_state_refused' });
    if (recovery && (item.erasureToken !== input.token || input.marker.seq !== journalSeq + 1)) throw Object.assign(new Error('Capture deletion recovery identity differs'), { code: 'capture_delete_identity_refused' });
    assertJournalCapacity(1);
    const at = recovery ? input.marker.at : now();
    const headEntryId = journalHead({ journal });
    const epochEntryId = journal.find((entry) => entry.seq === journalEpoch)?.id ?? null;
    const marker = appendJournal({ type: 'capture.state_changed', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, at,
      ...(recovery ? { id: input.marker.id } : {}), payload: { ...item, state: 'blocked', blockedReason: 'capture_deleted', updatedAt: at } });
    reapplyDeletion({ remove: [{ id: item.id, mode: 'logical' }] }, { journal: false, captureDeleted: true });
    const { erasureToken: token } = item;
    deletion.set('intents', [...(deletion.get('intents') ?? []), {
      tombstone: { kind: 'item', mode: 'logical', at, seq: marker.seq, tokens: [item.erasureToken], moveIn: 'none' },
      lineage: { epochEntryId: epochEntryId ?? marker.id, headEntryId, markerEntryId: marker.id },
      marker: { id: marker.id, at, seq: marker.seq }, item: { id: item.id, token }
    }]);
    endStoreLimits(at);
    return { removed: 1, mode: 'logical', backups: PURGE_BACKUPS_STATEMENT };
  }

  // What capture holds for one read's scope (plan v1.4.4 §24.1, M-9; PR-36b),
  // or null when the store holds no capture state at all, so a store without
  // capture reads exactly as it did. The counts are over the captures the
  // scope owns -- its project's, or with no project its origin's unattributed
  // ones -- never another project's; an item of a later schema is carried and
  // never counted. `limited` is the store limits refusing material as far as
  // the store knows (the queue checked against its items now, the store's
  // bytes until an item is accepted or a purge runs, the next capture checking
  // afresh): limit, ceiling and
  // start only. `gaps` declares what capture refused, bounded: each store
  // limit's last closed period, the scope's sessions that reached their limit
  // (counted, never named, from the earliest refusal each records), and material refused because another project owned
  // its session. Availability is a non-persistent host configuration projection.
  function captureStatus(scope) {
    const sessions = extras.get(CAPTURE_SESSIONS) ?? [];
    const entries = events.filter((entry) => entry?.type === CAPTURE_LIMIT_EVENT || entry?.type === CAPTURE_REFUSED_EVENT);
    if (captures.size === 0 && sessions.length === 0 && entries.length === 0) return null;
    const owns = (entry) => (scope.state === 'project_selected' ? entry.attribution === 'project' && entry.project === scope.project : entry.attribution === 'unattributed' && sameOrigin(entry.originId, scope.originId));
    const status = { pending: 0, processing: 0, failed: 0, blocked: 0, oldestPendingAt: null, extractionAvailable: false, limited: [], gaps: [] };
    const at = now();
    let expiredFrom = null;
    let queued = 0;
    for (const item of captures.values()) {
      if (item.state !== 'extracted' && !rawExpired(item, at)) queued += 1;
      if (item.schemaVersion > SCHEMA_VERSION || !UNEXTRACTED_STATES.includes(item.state) || !owns(item)) continue;
      if (rawExpired(item, at)) {
        status.expired = (status.expired ?? 0) + 1;
        const expiry = effectiveCaptureExpiry(item, retentionPolicy());
        if (expiredFrom === null || compareInstants(expiry, expiredFrom) < 0) expiredFrom = expiry;
        continue;
      }
      status[item.state] += 1;
      if (item.state === 'pending' && (status.oldestPendingAt === null || compareInstants(item.createdAt, status.oldestPendingAt) < 0)) status.oldestPendingAt = item.createdAt;
    }
    // One entry per store limit, however many a merge left behind.
    for (const limit of ['maxQueueDepth', 'maxStoreBytes']) {
      const held = entries.filter((entry) => entry.type === CAPTURE_LIMIT_EVENT && entry.limit === limit);
      const open = held.filter((entry) => entry.since).sort((left, right) => compareInstants(left.since, right.since))[0];
      const binding = open && (limit !== 'maxQueueDepth' || queued >= open.ceiling);
      if (binding) status.limited.push({ limit, ceiling: open.ceiling, since: open.since });
      else if (open) status.gaps.push({ reason: limit, from: open.since, to: null });
      const closed = held.filter((entry) => entry.lastPeriod).sort((left, right) => compareInstants(right.lastPeriod.to, left.lastPeriod.to))[0];
      if (closed) status.gaps.push({ reason: limit, from: closed.lastPeriod.from, to: closed.lastPeriod.to });
    }
    if (expiredFrom !== null) status.gaps.push({ reason: RAW_EXPIRED, from: expiredFrom, to: null });
    const limitedSessions = sessions.filter((session) => owns(session) && (session.limited?.since || session.limited?.lastPeriod));
    if (limitedSessions.length) {
      const starts = limitedSessions.map((session) => session.limited.lastPeriod?.from ?? session.limited.since).sort(compareInstants);
      const ends = limitedSessions.map((session) => (session.limited.since ? null : session.limited.lastPeriod.to));
      status.gaps.push({ reason: 'maxItemsPerSession', sessions: limitedSessions.length, from: starts[0], to: ends.includes(null) ? null : ends.sort(compareInstants).at(-1) });
    }
    for (const entry of entries) {
      if (entry.type === CAPTURE_REFUSED_EVENT && scope.state === 'project_selected' && entry.project === scope.project) status.gaps.push({ reason: entry.reason, from: entry.since, to: null });
    }
    // What the transcript cursor did not read (PR-36): the scope's sessions
    // whose transcript stopped being read, and the periods their records keep,
    // each reason counted by session and never named.
    const periods = new Map();
    const sessionGapReasons = [...TRANSCRIPT_GAP_REASONS, RAW_EXPIRED, 'capture_deleted', 'extraction_unknown_period'];
    for (const session of sessions) {
      if (!owns(session)) continue;
      const stopped = isPlainObject(session.cursor?.blocked) ? [{ reason: session.cursor.blocked.reason, from: session.cursor.blocked.at, to: null }] : [];
      for (const gap of [...stopped, ...(Array.isArray(session.gaps) ? session.gaps : [])]) {
        if (!sessionGapReasons.includes(gap?.reason) || !isValidIsoInstant(gap.from) || !(gap.to === null || isValidIsoInstant(gap.to))) continue;
        const period = periods.get(gap.reason) ?? { sessions: new Set(), from: [], to: [] };
        period.sessions.add(session);
        period.from.push(gap.from);
        period.to.push(gap.to);
        periods.set(gap.reason, period);
      }
    }
    for (const [reason, period] of [...periods].sort(([left], [right]) => sessionGapReasons.indexOf(left) - sessionGapReasons.indexOf(right))) {
      status.gaps.push({ reason, sessions: period.sessions.size, from: period.from.sort(compareInstants)[0], to: period.to.includes(null) ? null : period.to.sort(compareInstants).at(-1) });
    }
    const errors = sessions.filter(session => owns(session) && session.extraction?.state === 'blocked' && isValidIsoInstant(session.extraction.at));
    if (errors.length) status.workerErrors = [...new Set(errors.map(session => workerReason(session.extraction.reason)))].map(reason => ({ reason, at: errors.filter(session => workerReason(session.extraction.reason) === reason).map(session => session.extraction.at).sort(compareInstants)[0] }));
    if (!errors.length && typeof options.extractionAvailable === 'function') status.extractionAvailable = options.extractionAvailable(scope) === true;
    return status;
  }

  // A session records when it was opened, so a project tombstone withholds
  // only the sessions opened before it (PR-37c design §1.3, R9).
  function newCaptureSession(originId, sessionId, owner) {
    return { id: `capsession_${randomUUID()}`, originId, sessionId, project: owner.project, attribution: owner.attribution, startedAt: now() };
  }

  // A session's self-event counters (§16.3): one count per signal and event,
  // a fixed set however many arrive.
  function countSelfEvent(counters, signal, event, by = 1) {
    const held = isPlainObject(counters) ? counters : {};
    const bySignal = isPlainObject(held[signal]) ? held[signal] : {};
    const count = Number.isSafeInteger(bySignal[event]) && bySignal[event] >= 0 ? bySignal[event] : 0;
    return { ...held, [signal]: { ...bySignal, [event]: count + by } };
  }

  // A ShadowGraph self-event (PR-35; §16.3, AC-065): counted on its session,
  // and nothing else -- no capture item, record, journal entry or retry key,
  // and no ordinal. A session it opens is owned for now by the write's owner,
  // until its first capture.
  function recordSelfEvent(input = {}) {
    if (!isPlainObject(input)) throw new Error('A self-event needs an input object');
    const originId = usableOriginId(input.originId);
    if (originId === null || originId !== input.originId) throw new Error('A self-event names the originId that observed it');
    if (!SELF_SIGNALS.includes(input.signal)) throw new Error(`A self-event names its signal: ${SELF_SIGNALS.join(', ')}`);
    const source = input.source;
    if (!isPlainObject(source) || !Object.hasOwn(CAPTURE_EVENT_IDENTITY, source.event)) throw new Error(`A self-event names an event the source contract covers: ${Object.keys(CAPTURE_EVENT_IDENTITY).join(', ')}`);
    if (!named(source.sessionId)) throw new Error('A self-event names its sessionId');
    const { sessions, session, held, owner, withheld } = captureSession(originId, source.sessionId, input.project);
    if (withheld) return { refused: { reason: SESSION_WITHHELD }, changed: false };
    const base = session ?? { ...newCaptureSession(originId, source.sessionId, owner), occurrenceSeqHighWater: held };
    const next = { ...base, selfEvents: countSelfEvent(base.selfEvents, input.signal, source.event), updatedAt: now() };
    extras.set(CAPTURE_SESSIONS, session ? sessions.map((entry) => (entry === session ? next : entry)) : [...sessions, next]);
    return clone(next.selfEvents);
  }

  // The transcript cursor (plan v1.4.4 §12.2, §12.2.1, §22.7; PR-36 design
  // revision 2): the assistant text no hook delivers, read from the session's
  // transcript through a durable per-session cursor on its captureSessions
  // record. Privileged: the capture hook is its one caller, inside the same
  // hold of the store's fence as the event's own item, passing the transcript
  // as synchronous callbacks it may block on.
  //
  // It reads nothing from before the cursor was anchored -- at the session's
  // first capture, at each re-activation of capture, at each new generation of
  // the file -- so nothing outside the owner's enablement is ever read (OD-3).
  // It reads only while the event's project, the session's owner and the
  // project the cursor was made for agree; an event from anywhere else stops
  // it for good (session_left_project), so no project's text is filed under
  // another's (D-6). ShadowGraph's own sessions -- a correlation-marked prompt,
  // a worker's -- are never read (§16). An unrecognised line blocks the
  // session's transcript reading (§12.2). Only Stop, PreCompact and SessionEnd
  // read; any other event only anchors and checks the project.
  //
  // Text is reconciled (§8): an entry whose uuid an item holds is skipped; a
  // run of assistant text, or one entry, matching a Stop's final message
  // recorded in this hold or the previous read is that Stop's copy and is
  // skipped; anything else is a new Transcript item, marked
  // possibleDuplicateOf the newest assistant item of the same material. A
  // tool call the transcript shows but no capture holds is an unknown period
  // (§22.7). Everything it writes is on the session record, and the items go
  // through recordCapture's own admission, ordinal, journal and identity.
  function recordTranscript(input = {}) {
    if (!isPlainObject(input)) throw new Error('A transcript read needs an input object');
    const originId = usableOriginId(input.originId);
    if (originId === null || originId !== input.originId) throw new Error('A transcript read names the originId that observed it');
    const sessionId = input.sessionId;
    if (!named(sessionId)) throw new Error('A transcript read names its sessionId');
    if (input.project !== null && !named(input.project)) throw new Error('A transcript read names its project, or null when none is resolved and covered');
    if (!isValidIsoInstant(input.activatedAt)) throw new Error('A transcript read names the capture activation it runs under');
    if (input.trigger !== null && !TRANSCRIPT_TRIGGERS.includes(input.trigger)) throw new Error(`A transcript read is triggered by ${TRANSCRIPT_TRIGGERS.join(', ')}, or by nothing`);
    const file = input.transcript ?? null;
    if (file !== null && !(isPlainObject(file) && named(file.ref) && (file.missing === true || (typeof file.size === 'function' && typeof file.read === 'function')))) throw new Error('A transcript is null, { ref, missing: true } or { ref, size, read }');
    if (input.trigger !== null && !isPlainObject(input.admission)) throw new Error('A transcript read that reads names its admission');
    const mayContinue = typeof input.mayContinue === 'function' ? () => Boolean(input.mayContinue()) : () => true;
    const result = { changed: false, anchored: false, reanchored: false, bumped: false, blocked: null, read: 0, ingested: 0, reconciled: 0, refused: 0, gaps: [] };

    const sessions = extras.get(CAPTURE_SESSIONS) ?? [];
    const session = sessions.find((entry) => entry.originId === originId && entry.sessionId === sessionId);
    // ShadowGraph's own sessions -- a worker's (S-3), or one whose prompt
    // carried its correlation mark (S-2) -- are never read, and nothing is
    // written for them; an S-2 mark in a tool's input marks that call, not the
    // user's session (§16).
    if (sessionWithheld(originId, sessionId)) return { ...result, withheld: SESSION_WITHHELD };
    const counted = (signal, event) => Object.entries(isPlainObject(session?.selfEvents?.[signal]) ? session.selfEvents[signal] : {}).some(([name, count]) => (event === undefined || name === event) && count > 0);
    if (counted('S-3') || counted('S-2', 'UserPromptSubmit')) return result;
    const at = now();
    const cursor = isPlainObject(session?.cursor) ? session.cursor : null;
    const { held, ownedBy } = captureSession(originId, sessionId, input.project ?? undefined);
    let gaps = Array.isArray(session?.gaps) ? session.gaps : [];
    let gapsDropped = Number.isSafeInteger(session?.gapsDropped) ? session.gapsDropped : 0;
    const addGap = (reason, from = cursor.advancedAt) => {
      const gap = { reason, from, to: at, generation: cursor.transcriptGeneration };
      result.gaps.push(gap);
      gaps = [...gaps, gap];
      if (gaps.length > TRANSCRIPT_GAPS_KEPT) { gapsDropped += gaps.length - TRANSCRIPT_GAPS_KEPT; gaps = gaps.slice(-TRANSCRIPT_GAPS_KEPT); }
    };
    // A cursor makes its session record its project's own (captureSession): a
    // record it is created on takes the cursor's project, so a later capture
    // from elsewhere is refused (D-6) and a purge of that project removes it.
    const write = (next) => {
      const current = extras.get(CAPTURE_SESSIONS) ?? [];
      const index = current.findIndex((entry) => entry.originId === originId && entry.sessionId === sessionId);
      const owner = cursor ? {} : { project: input.project, attribution: 'project' };
      const record = { ...(index === -1 ? newCaptureSession(originId, sessionId, { project: input.project, attribution: 'project' }) : current[index]), ...owner, cursor: next, gaps, gapsDropped, updatedAt: at };
      extras.set(CAPTURE_SESSIONS, index === -1 ? [...current, record] : current.map((entry, at) => (at === index ? record : entry)));
      result.changed = true;
      return result;
    };

    // A cursor a merge or a hand edit left malformed is never read: its
    // position could point anywhere, before the anchor included (C-1).
    if (cursor && !cursorBlock(cursor.blocked) && !cursorShape(cursor)) {
      result.blocked = 'transcript_unrecognised';
      return write({ ...cursor, blocked: { reason: 'transcript_unrecognised', detail: 'cursor_malformed', at } });
    }
    const agrees = input.project !== null && (!ownedBy || ownedBy.project === input.project) && (!cursor || cursor.project === input.project);
    if (cursor && !cursor.blocked && !agrees) {
      result.blocked = 'session_left_project';
      return write({ ...cursor, blocked: { reason: 'session_left_project', at } });
    }
    // A self-event only checks the project.
    if (input.selfEvent === true || !agrees || cursor?.blocked || file === null) return result;

    // A Stop's transcript copy can arrive after any current EOF or stopMark.
    // Once its raw expires there is no safe text reconciliation, including for
    // withheld Stops. Persist the session refusal before reading any bytes;
    // direct hook capture remains available, but this cursor never resumes.
    const sessionItems = [...captures.values(), ...withheldCaptures()].filter((item) => item.originId === originId && item.source?.sessionId === sessionId);
    if (sessionItems.some((item) => item.source.event === 'Stop' && rawExpired(item, at))) {
      result.blocked = RAW_EXPIRED;
      return write({ ...cursor, blocked: { reason: RAW_EXPIRED, at } });
    }

    // The file, read only through these: a callback that throws is a read
    // that returned nothing, and whatever needed it does not happen.
    let failed = false;
    const read = (start, length) => {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0) return Buffer.alloc(0);
      try {
        const bytes = file.read(start, length);
        if (Buffer.isBuffer(bytes)) return bytes;
      } catch { /* treated as a failed read */ }
      failed = true;
      return Buffer.alloc(0);
    };
    let size = 0;
    if (!file.missing) {
      try { size = file.size(); } catch { return result; }
      if (!Number.isSafeInteger(size) || size < 0) return result;
    }
    // The anchor: a digest of the bytes just before a position (never the
    // bytes), so a file rewritten under the cursor is found even before it
    // has read anything -- at an anchoring those bytes are from before it,
    // and only their digest is kept (contract review R-1). Null when they
    // cannot be read.
    const anchorAt = (position) => {
      const from = Math.max(0, position - TRANSCRIPT_ANCHOR_BYTES);
      const bytes = read(from, position - from);
      return failed ? null : digest(bytes);
    };
    const lineEnd = () => {
      const end = size === 0 ? 0 : lastLineEnd({ read, size, mayContinue });
      return failed ? null : end;
    };
    const anchored = (end, generation, gap) => {
      const anchor = anchorAt(end);
      if (anchor === null) return result;
      if (gap) addGap(gap);
      return write({
        transcriptRef: file.ref, transcriptGeneration: generation, base: end, position: end, anchor, skipping: false,
        project: input.project, activatedAt: input.activatedAt, advancedAt: at, lastIngestedOccurrence: cursor?.lastIngestedOccurrence ?? null,
        stopMark: held, blocked: null, ends: (cursor?.ends ?? 0) + (input.trigger === 'SessionEnd' ? 1 : 0), oversized: cursor?.oversized ?? 0
      });
    };
    if (!cursor) {
      const end = lineEnd();
      if (end !== null) anchored(end, 1, null);
      result.anchored = result.changed;
      return result;
    }
    // A file gone after the cursor was made changes nothing: whatever appears
    // there next is anchored where it is found, never read from its start,
    // since it may carry history from before the session's first capture (C-2).
    if (file.missing) return result;
    if (cursor.activatedAt !== input.activatedAt) {
      const end = lineEnd();
      if (end !== null) anchored(end, cursor.transcriptGeneration + 1, 'transcript_reanchored');
      result.reanchored = result.changed;
      return result;
    }
    const intact = (() => {
      if (file.ref !== cursor.transcriptRef || size < cursor.position) return false;
      // An anchor a failed read could not take proves nothing: a new generation.
      if (cursor.anchor === null) return false;
      const anchor = anchorAt(cursor.position);
      return anchor === null ? null : anchor === cursor.anchor;
    })();
    if (intact === null) return result;
    if (!intact) {
      const end = lineEnd();
      if (end !== null) anchored(end, cursor.transcriptGeneration + 1, 'transcript_rewritten');
      result.bumped = result.changed;
      return result;
    }
    if (input.trigger === null) return result;

    // W's captures count as held, so what they hold is never captured again
    // (PR-37a); nothing here names one.
    const ingestedUuids = new Set(sessionItems.filter((item) => item.source.event === 'Transcript').map((item) => item.source.hostEventId));
    const heldCalls = new Set(sessionItems.filter((item) => ['PostToolUse', 'PostToolUseFailure'].includes(item.source.event)).map((item) => item.source.toolCallId));
    const usableRefs = new Set(sessionItems.filter((item) => !rawExpired(item, at)).map((item) => item.contentRef));
    const texts = new Map([...(extras.get(CAPTURE_CONTENT) ?? []), ...(deletion.get('held')?.collections[CAPTURE_CONTENT]?.items.map(([, entry]) => entry) ?? [])].filter((entry) => usableRefs.has(entry.contentRef)).map((entry) => [entry.contentRef, entry.text]));
    const stopItems = sessionItems.filter((item) => item.source.event === 'Stop');
    const stops = stopItems.filter((item) => texts.has(item.contentRef)).map((item) => ({ seq: item.occurrenceSeq, key: matchKey(texts.get(item.contentRef)) })).sort((left, right) => left.seq - right.seq);
    // A Stop withheld for a credential has no text to match its copy, which
    // may still be arriving: a trailing run waits for it as for any Stop, so
    // the run is judged whole (PR-37b re-review NF-3).
    const withheldStops = stopItems.filter((item) => item.blockedReason === CREDENTIAL_WITHHELD && !rawExpired(item, at)).map((item) => item.occurrenceSeq);
    const priorStop = stopItems.filter((item) => item.id !== input.triggerItemId).reduce((top, item) => Math.max(top, item.occurrenceSeq), 0);
    let stopMark = cursor.stopMark;
    // The store's bytes as measured before this hold, plus the event's own
    // item accepted in it (M-11), plus each item this read adds.
    const trigger = input.triggerItemId ? captures.get(input.triggerItemId) : undefined;
    let storeBytes = input.admission?.storeBytes + (trigger ? storedEstimate(texts.get(trigger.contentRef), [trigger.observation ?? null, trigger.source]) : 0);
    const itemLimit = input.admission?.limits?.maxItemBytes ?? Infinity;
    let lastIngested = cursor.lastIngestedOccurrence;
    // Rule 2: the oldest Stop still reconcilable with this material; a
    // reconciled Stop retires every Stop before it. A key is computed only
    // while some Stop could take it.
    const reconcile = (keyOf) => {
      if (!stops.some((candidate) => candidate.seq > stopMark)) return false;
      const key = keyOf();
      const stop = stops.find((candidate) => candidate.seq > stopMark && candidate.key === key);
      if (!stop) return false;
      stopMark = stop.seq;
      result.reconciled += 1;
      return true;
    };
    // Rules 1 and 3. A private key split across the entries recorded is
    // redacted whole (PR-37b R6).
    const keyBlock = { open: false };
    const ingest = (entry, withhold = false) => {
      if (ingestedUuids.has(entry.uuid)) return;
      const recorded = recordCapture({
        originId, project: input.project, text: entry.text, observation: input.observation,
        source: { event: 'Transcript', sessionId, role: 'assistant', hostEventId: entry.uuid },
        admission: { limits: input.admission?.limits, storeBytes }
      }, { keyBlock, withhold });
      if (recorded.refused) {
        result.refused += 1;
        if (recorded.changed) result.changed = true;
        return;
      }
      ingestedUuids.add(entry.uuid);
      storeBytes += storedEstimate(entry.text, [recorded.observation ?? null, recorded.source]);
      lastIngested = recorded.occurrenceSeq;
      result.ingested += 1;
    };
    // A run: consecutive assistant text, judged whole first and then entry by
    // entry. A user entry, a tool call, an unparsed line or text too long to
    // be an item ends it. A run holding an entry already ingested was judged
    // in part before, so it is judged entry by entry. Time is checked before
    // each item is recorded: when it runs short, the rest of the run is left
    // for the next read and the position goes back to its first entry (C-3).
    let run = [];
    let cut = null;
    const keyOf = (entry) => () => (entry.key ??= matchKey(redactText(entry.stripped)));
    // The run's text, joined as a Stop's final message is and redacted once.
    const runText = () => (run.redacted ??= redactText(run.map((entry) => entry.stripped).join('\n\n')));
    const runKey = () => matchKey(runText());
    const closeRun = () => {
      const whole = run.length > 1 && run.every((entry) => !ingestedUuids.has(entry.uuid)) && reconcile(runKey);
      if (!whole) {
        // A credential the checker finds only across the run's entries is
        // withheld in each of them, as its Stop's would be (PR-37b).
        const withhold = run.length > 1 && captureWithheld(runText());
        for (const entry of run) {
          if (!ingestedUuids.has(entry.uuid) && reconcile(keyOf(entry))) continue;
          if (!ingestedUuids.has(entry.uuid) && !mayContinue()) {
            // A run being withheld is read again from its start, so the rest
            // is judged with the part already recorded (re-review NF-3).
            cut = withhold ? run[0].start : entry.start;
            break;
          }
          ingest(entry, withhold);
        }
      }
      run = [];
      return cut === null;
    };

    const lines = transcriptLines({ read, size, position: cursor.position, skipping: cursor.skipping, mayContinue });
    let position = cursor.position;
    let skipping = cursor.skipping;
    let oversized = cursor.oversized;
    let blocked = null;
    const toolUses = [];
    const toolResults = new Set();
    for (const line of lines) {
      // Only a line still to be judged costs time; an unparsed one is consumed.
      if (line.text !== undefined && !mayContinue()) break;
      if (line.skipping) {
        if (closeRun()) [position, skipping] = [line.end, true];
        break;
      }
      if (line.oversized) {
        if (!closeRun()) break;
        oversized += 1;
        addGap('transcript_line_oversized');
        [position, skipping] = [line.end, false];
        continue;
      }
      if (line.text.trim()) {
        const facts = transcriptEntry(line.text);
        if (facts.drift) {
          blocked = { reason: 'transcript_unrecognised', detail: facts.drift, at };
          break;
        }
        // Text is measured as a Stop's is, after ShadowGraph's own delivered
        // blocks are removed and the rest redacted; text more than twice what
        // an item holds is not even stripped (declared: a Stop's final message
        // quoting that much of them is recorded again, marked
        // possibleDuplicateOf).
        const stripped = facts.text === null || Buffer.byteLength(facts.text) > 2 * itemLimit ? null : stripDeliveredBlocks(facts.text).text;
        const tooLong = facts.text !== null && (stripped === null || Buffer.byteLength(redactText(stripped)) > itemLimit);
        if ((facts.type === 'user' || facts.toolUses.length || tooLong) && !closeRun()) break;
        if (facts.type === 'assistant' && facts.text !== null) {
          const entry = { start: line.start, uuid: facts.uuid, text: facts.text, stripped, key: null };
          // Text beside a tool call is never a turn's final message, nor is
          // text no item can hold (a Stop's would have been refused too).
          if (facts.toolUses.length || tooLong) ingest(entry);
          else run.push(entry);
        }
        toolUses.push(...facts.toolUses);
        for (const id of facts.toolResults) toolResults.add(id);
      }
      [position, skipping] = [line.end, false];
    }
    // A run at the end of the window may still be growing -- the host's lag,
    // or a read its budget or time cut short -- and so may be a Stop's final
    // message half-written: at a Stop, or with no time left, while a Stop is
    // still reconcilable, it is held and judged by the next read, unless a
    // Stop already takes it, the session is blocked, or it began the window
    // (judged, so a run that fills every window cannot hold the cursor for
    // ever). With no Stop to wait for, a part judged now loses nothing. It is
    // held from its first entry not yet ingested, so the next read can still
    // match what remains whole.
    const eligible = (key) => stops.some((stop) => stop.seq > stopMark && (key === undefined || stop.key === key))
      || (key === undefined && withheldStops.some((seq) => seq > stopMark));
    const holdAt = (run.find((entry) => !ingestedUuids.has(entry.uuid)) ?? run[0])?.start;
    const growing = cut === null && run.length > 0 && !blocked && holdAt > cursor.position && (input.trigger === 'Stop' || !mayContinue())
      && eligible() && !eligible(runKey()) && !run.some((entry) => eligible(keyOf(entry)()));
    if (growing) {
      [position, skipping] = [holdAt, false];
      run = [];
    } else if (cut === null) closeRun();
    if (cut !== null) [position, skipping] = [cut, false];

    const missing = toolUses.filter((use) => {
      if (!toolResults.has(use.id) || heldCalls.has(use.id)) return false;
      try { return !input.isSelfTool?.(use.name, use.input); } catch { return true; }
    });
    if (missing.length) addGap('tool_calls_not_captured');
    let ends = Number.isSafeInteger(cursor.ends) ? cursor.ends : 0;
    if (input.trigger === 'SessionEnd') {
      ends += 1;
      if (!blocked && (position < size || skipping)) addGap('transcript_incomplete_at_end');
    }
    if (blocked) result.blocked = blocked.reason;
    stopMark = Math.max(stopMark, priorStop);
    const next = { ...cursor, position, skipping, oversized, stopMark, ends, blocked, lastIngestedOccurrence: lastIngested };
    result.read = position - cursor.position;
    if (JSON.stringify(next) === JSON.stringify(cursor) && !result.gaps.length && !result.changed) return result;
    failed = false;
    return write({ ...next, anchor: anchorAt(position), advancedAt: at });
  }

  // One §12.5 edge (CAPTURE_TRANSITIONS): what it needs, and the one type it
  // journals. Anything else -- another edge, a missing field, 'excluded' -- is
  // refused before anything changes.
  function transitionCapture(input = {}) {
    const item = captures.get(input?.id);
    if (!item) throw new Error(`Capture item not found: ${input?.id}`);
    if (isNewerThanWriter(item)) throw new Error('A capture item of a future schema is not moved by this build');
    if (rawExpired(item)) throw Object.assign(new Error('Capture raw is expired and cannot be used for re-extraction'), { code: 'capture_raw_expired' });
    const move = `${item.state}->${input.to}`;
    const edge = Object.hasOwn(CAPTURE_TRANSITIONS, move) ? CAPTURE_TRANSITIONS[move] : null;
    if (!edge) throw new Error(`Illegal capture transition ${move}`);
    const next = { ...clone(item), state: input.to, updatedAt: now() };
    if (edge.requires) {
      if (input[edge.requires] == null) throw new Error(`The capture transition ${move} requires ${edge.requires}`);
      next[edge.requires] = clone(input[edge.requires]);
    }
    if (edge.releases) { next.lease = null; next.attempts += 1; }
    const issue = captureItemIssue(next);
    if (issue) throw new Error(`Capture transition refused: ${issue}`);
    assertJournalCapacity(1);
    captures.set(item.id, next);
    appendJournal({ type: edge.type, entityKind: CAPTURE_KIND, entityId: item.id, project: next.project, payload: next });
    return clone(next);
  }

  function claimCapture(input) {
    const item = captures.get(input.id), at = now();
    if (!captureOwner(input).owns(item) || isNewerThanWriter(item) || rawExpired(item, at) || item.cancelRequested
      || !(item.state === 'pending' || (item.state === 'processing' && Date.parse(item.lease?.leaseExpiresAt) <= Date.parse(at)))) return null;
    if (item.state === 'processing') {
      const sessions = extras.get(CAPTURE_SESSIONS) ?? [];
      extras.set(CAPTURE_SESSIONS, sessions.map(session => {
        if (session.originId !== item.originId || session.sessionId !== item.source.sessionId) return session;
        const gaps = session.gaps ?? [], prior = gaps.filter(gap => gap.reason === 'extraction_unknown_period');
        return { ...session, gaps: [...gaps.filter(gap => gap.reason !== 'extraction_unknown_period'),
          { reason: 'extraction_unknown_period', from: [item.updatedAt, ...prior.map(gap => gap.from)].sort(compareInstants)[0], to: at }] };
      }));
    }
    const next = { ...clone(item), state: 'processing', lease: clone(input.lease), updatedAt: at };
    if (captureItemIssue(next)) throw new Error('Invalid extraction lease');
    assertJournalCapacity(1); captures.set(item.id, next);
    appendJournal({ type: 'capture.state_changed', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, payload: next });
    return clone(next);
  }

  // Compare with the canonical witness at the producing extraction, not
  // timestamps: an owner can correct a record within the same clock tick.
  // Missing provenance is not permission to overwrite imported experience.
  const extractionRecordHash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
  function reprocessingPrior(item) {
    if (!item.reprocessRequest) return { replaceable: [], protected: [] };
    const result = { replaceable: [], protected: [] }, owner = captureOwner(item);
    for (const recordId of new Set(item.producedRecordIds)) {
      const record = records.get(recordId);
      // Later skipped/no-op runs retain this ID but cannot adopt a manual
      // correction as extraction-owned content. Its first production wins.
      const completion = journal.find(entry => entry.type === 'extraction.completed' && entry.entityId === item.id
        && entry.payload?.producedRecordIds?.includes(recordId));
      let witness = completion && [...journal].reverse().find(entry => entry.seq < completion.seq && entry.entityId === recordId
        && entry.payload?.kind === record?.kind)?.payload;
      // A reused decision may gain history links from this writer itself.
      // Advance only through an explicit before/after hash chain tied to the
      // completed extraction and canonical journal witness. Never adopt the
      // latest arbitrary snapshot, which could be an owner's correction.
      if (witness?.kind === 'decision') for (const finished of journal) {
        if (finished.seq <= completion.seq || finished.type !== completion.type || finished.entityId !== item.id) continue;
        const result = finished.payload?.receipts?.at(-1)?.reprocessing;
        if (!result?.requestId || result.requestId !== finished.payload?.reprocessRequest?.id) continue;
        for (const update of Array.isArray(result.linkageUpdates) ? result.linkageUpdates : []) {
          if (update?.before !== extractionRecordHash(witness)) continue;
          const entry = journal.find(value => value.id === update.entryId && value.entityId === recordId
            && value.type === 'decision.recorded' && value.seq > completion.seq && value.seq < finished.seq);
          const cause = entry && journal.find(value => value.id === entry.causationId && value.type === 'decision.superseded'
            && value.seq > completion.seq && value.seq < entry.seq && value.payload?.captureRef === item.id
            && value.payload?.supersededBy === recordId);
          const withoutLinks = value => Object.fromEntries(Object.entries(value).filter(([key]) => !['supersedes', 'updatedAt'].includes(key)));
          if (!cause || entry.payload?.kind !== 'decision' || update.after !== extractionRecordHash(entry.payload)
            || extractionRecordHash(withoutLinks(entry.payload)) !== extractionRecordHash(withoutLinks(witness))
            || !Array.isArray(entry.payload.supersedes) || !(witness.supersedes ?? []).every(id => entry.payload.supersedes.includes(id))) continue;
          witness = entry.payload;
        }
      }
      const corrected = !record || !witness || !owner.owns(record) || record.captureRef !== item.id || isNewerThanWriter(record)
        || ['superseded', 'invalidated', 'archived', 'abandoned'].includes(record.status)
        || [...relations.values()].some(edge => edge.to === recordId && edge.relation === 'supersedes')
        || JSON.stringify(canonical(record)) !== JSON.stringify(canonical(witness));
      result[corrected ? 'protected' : 'replaceable'].push({ record, witness, recordId });
    }
    return result;
  }

  function sameExtractionFields(record, proposed) {
    const fields = { memory: ['text'], decision: ['title', 'chosen', 'goal'], attempt: ['solution', 'result', 'reason'] };
    return record.kind === proposed.kind && fields[record.kind].every(key => (record[key] ?? '') === (proposed.values[key] ?? ''))
      && (record.kind !== 'decision' || JSON.stringify((record.alternatives ?? []).map(value => value.label)) === JSON.stringify(proposed.alternatives.map(value => value.label)));
  }

  // A replacement is a new representation of this capture, possibly split,
  // merged or reclassified. Canonical experience is retained as linked history.
  function supersedeExtractionRecord(previous, replacement, at) {
    if (previous.kind === 'attempt') return; // reader derives it from relations
    if (previous.status === 'superseded') return; // remember already linked it
    if (previous.kind === 'decision' && replacement.kind === 'decision') {
      supersedeDecision({ project: previous.project, originId: previous.originId, decisionId: previous.id, replacementId: replacement.id });
      return;
    }
    touchMutableObject(previous);
    previous.status = 'superseded'; previous.supersededBy = replacement.id; previous.updatedAt = at;
    if (previous.kind === 'memory') {
      previous.temporal = { ...previous.temporal, validTo: earliestBoundary(previous.temporal?.validTo, at), invalidatedAt: at };
      if (currentMemories.get(memoryScopeKey(previous))?.id === previous.id) currentMemories.delete(memoryScopeKey(previous));
    }
    appendJournal({ type: `${previous.kind}.superseded`, entityKind: previous.kind, entityId: previous.id, project: previous.project,
      payload: clone(previous), provenance: writeProvenance(replacement) });
  }

  // Only the fenced worker calls this with locally verified fields. Canonical
  // IDs and confidence/trust stay owned by the existing builders. Decoration
  // reaches each new journal/idempotency copy before this transaction commits.
  function completeExtraction(input) {
    const item = captures.get(input.id), at = now();
    if (!item || item.state !== 'processing' || item.lease?.leaseId !== input.leaseId || item.cancelRequested
      || rawExpired(item, at) || Date.parse(item.lease.leaseExpiresAt) <= Date.parse(at)) throw new Error('Extraction lease is no longer usable');
    const prior = reprocessingPrior(item), producedRecordIds = [], reused = new Set(), usedMemoryKeys = new Set();
    const overlaps = (a, b) => a.sourceRef === b.sourceRef && a.span?.start < b.span?.end && b.span?.start < a.span?.end;
    // A proposal overlapping an owner-corrected claim cannot quietly revive
    // it under another ID or kind. Without its original source witness, skip
    // the proposal conservatively. No model judgement overrides this check.
    const proposals = input.prepared.records.filter(proposed => !prior.protected.some(({ witness }) =>
      !witness?.claims?.length || proposed.claims.some(claim => witness.claims.some(old => overlaps(claim, old)))));
    // Reserve all identical identities before a changed proposal can consume
    // their memory keys. Output order must not silently retire retained output.
    const identicalMatches = proposals.map(proposed => {
      const match = prior.replaceable.find(({ record }) => !reused.has(record.id) && sameExtractionFields(record, proposed));
      if (match) {
        reused.add(match.record.id);
        if (match.record.kind === 'memory') usedMemoryKeys.add(match.record.key);
      }
      return match;
    });
    const linkageBefore = new Map(prior.replaceable.filter(({ record }) => reused.has(record.id) && record.kind === 'decision')
      .map(({ record }) => [record.id, extractionRecordHash(record)]));
    const decorate = (value, id, fields) => {
      if (!value || typeof value !== 'object') return;
      if (value.id === id && value.kind !== CAPTURE_KIND) Object.assign(value, clone(fields));
      else for (const child of Object.values(value)) decorate(child, id, fields);
    };
    for (const [index, proposed] of proposals.entries()) {
      const identical = identicalMatches[index];
      if (identical) {
        producedRecordIds.push(identical.record.id);
        continue;
      }
      const sourceClass = item.source.role === 'tool' ? 'tool_observed' : 'agent_claimed';
      const args = { ...proposed.values, project: item.project, originId: item.originId, sourceClass,
        observedAt: item.observedAt, sessionId: item.source.sessionId,
        idempotencyKey: `${input.key}:${index}` };
      let record;
      if (proposed.kind === 'decision') record = addDecision({ ...args, alternatives: proposed.alternatives });
      else if (proposed.kind === 'attempt') record = addAttempt(args);
      else {
        const predecessor = prior.replaceable.find(({ record: old }) => old.kind === 'memory' && !usedMemoryKeys.has(old.key) && !reused.has(old.id));
        const key = predecessor?.record.key ?? `${input.key}:${index}`;
        usedMemoryKeys.add(key);
        record = remember({ ...args, memoryType: 'episode', key }).memory;
      }
      const fields = { captureRef: item.id, claims: proposed.claims, verificationStatus: 'unverified' };
      if (proposed.kind === 'attempt') {
        fields.outcomeEvidence = clone(item.observation?.outcome?.outcomeEvidence ?? { state: 'absent' });
        if (fields.outcomeEvidence.state === 'observed') fields.resultClass = fields.outcomeEvidence.exitStatus === 0 ? 'succeeded' : 'failed';
        if (!proposed.reason) fields.causalClaim = { state: 'unknown' };
        else {
          const { class: claimClass, verifierVersion, checks, rule, readings, span, sourceRef, evidence } = proposed.reason;
          fields.causalClaim = { statement: args.reason, state: 'recorded', sourceClass, class: claimClass, verifierVersion, ...(checks ? { checks } : {}),
            ...(rule ? { rule } : {}), ...(readings ? { readings } : {}),
            evidence: [{ sourceRef, span, text: evidence }] };
        }
      }
      decorate(records.get(record.id), record.id, fields);
      for (const entry of journal) decorate(entry.payload, record.id, fields);
      for (const value of idempotency.values()) decorate(value, record.id, fields);
      producedRecordIds.push(record.id);
    }
    if (producedRecordIds.length) {
      for (const { record: previous } of prior.replaceable) {
        if (producedRecordIds.includes(previous.id)) continue;
        const replacements = producedRecordIds.map(id => records.get(id));
        const primary = replacements.find(record => record.kind === previous.kind) ?? replacements[0];
        supersedeExtractionRecord(previous, primary, at);
        for (const replacement of replacements) {
          if (![...relations.values()].some(edge => edge.from === replacement.id && edge.to === previous.id && edge.relation === 'supersedes')) {
            addRelation({ from: replacement.id, to: previous.id, relation: 'supersedes' }, item.project);
          }
        }
      }
      producedRecordIds.push(...prior.protected.map(value => value.recordId));
    } else if (item.reprocessRequest) producedRecordIds.push(...item.producedRecordIds);
    const linkageUpdates = [...linkageBefore].flatMap(([recordId, before]) => {
      const after = extractionRecordHash(records.get(recordId));
      if (before === after) return [];
      const entry = [...journal].reverse().find(value => value.entityId === recordId && value.type === 'decision.recorded');
      // The before hash already binds the canonical record ID. Do not carry
      // that ID again as a receipt reference: inspection treats such IDs as
      // cited experience, whereas this is internal historical linkage proof.
      return [{ before, after, entryId: entry.id }];
    });
    const reprocessing = item.reprocessRequest ? { requestId: item.reprocessRequest.id, preservedCorrections: prior.protected.length, linkageUpdates,
      skippedProposals: input.prepared.records.length - proposals.length, retainedPriorEvidence: proposals.length === 0 } : undefined;
    const next = { ...clone(item), state: 'extracted', lease: null, attempts: item.attempts + (input.attemptCount ?? 1),
      producedRecordIds, updatedAt: at, receipts: [...item.receipts, { ...clone(input.receipt), ...(reprocessing ? { reprocessing } : {}) }],
      extractionOutput: { unsupported: clone(input.prepared.unsupported), createdAt: at, expiresAt: new Date(Date.parse(at) + 7 * 86_400_000).toISOString() } };
    assertJournalCapacity(1); captures.set(item.id, next);
    appendJournal({ type: 'extraction.completed', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, payload: next });
    if (input.journalCeiling !== undefined && sessionJournalEntries(journal, item) > input.journalCeiling) throw Object.assign(new Error('session_journal'), { code: 'session_journal' });
    return { status: 'committed', produced: producedRecordIds.length, unsupported: input.prepared.unsupported.length };
  }

  function extractionStatus(input) {
    const owner = captureOwner(input), at = now(), sessions = extras.get(CAPTURE_SESSIONS) ?? [];
    let changed = false;
    extras.set(CAPTURE_SESSIONS, sessions.map(session => {
      if (!owner.owns(session)) return session;
      changed = true;
      return { ...session, extraction: { state: input.reason ? 'blocked' : 'idle', ...(input.reason ? { reason: workerReason(input.reason) } : {}), at } };
    }));
    return changed;
  }

  function settleExtraction(input) {
    if (!['superseded_result', 'schema_invalid', 'executor_blocked', 'executor_failed', 'worker_blocked'].includes(input.reason)) throw new Error('Invalid extraction terminal reason');
    const at = now(), item = captures.get(input.id);
    if (input.reason === 'superseded_result') {
      // No purged/quarantined identity, source, project or result is recreated.
      // One bounded diagnostic remains valid even when the item has vanished.
      const index = events.findIndex(value => value.type === 'extraction.superseded');
      replaceEvent(index, { id: events[index]?.id ?? id('event'), type: 'extraction.superseded', at, count: Math.min(Number.MAX_SAFE_INTEGER, (events[index]?.count ?? 0) + 1) });
    }
    if (!item || item.state !== 'processing' || item.lease?.leaseId !== input.leaseId) return { status: input.reason };
    const superseded = input.reason === 'superseded_result', workerBlocked = input.reason === 'worker_blocked';
    const next = { ...clone(item), state: workerBlocked ? 'pending' : superseded ? item.cancelRequested ? 'blocked' : 'pending' : input.reason === 'schema_invalid' ? 'failed' : 'blocked',
      lease: null, attempts: item.attempts + (input.attemptCount ?? 1), updatedAt: at,
      lastError: superseded ? item.lastError : input.reason,
      blockedReason: workerBlocked ? workerReason(input.blockedReason) : superseded ? item.cancelRequested ? 'capture_invalidated' : null : input.reason === 'schema_invalid' ? null : input.reason,
      supersededResults: superseded ? [...item.supersededResults.slice(-15), { at, reason: input.reason }] : item.supersededResults };
    assertJournalCapacity(1); captures.set(item.id, next);
    appendJournal({ type: superseded ? 'capture.state_changed' : 'extraction.failed', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, payload: next });
    return { status: input.reason };
  }

  // One aggregate per public delivery, even when it composes multiple reads.
  // Failed operations roll back canonical effects before a separate refusal
  // audit commit. Transports persist that committed rejection before delivery.
  function auditedRead(name, operation) {
    return (...args) => {
      const previous = readOperation;
      const current = { boundary: null };
      try {
        return transactional(name, () => {
          readOperation = current;
          const result = operation(...args), boundary = current.boundary;
          if (boundary?.requestedAccess) {
            const ids = new Set();
            const visit = value => {
              if (!value || typeof value !== 'object') return;
              // A T1 line (PR-26) names its record as recordId and carries a
              // decision's alternatives whole, so it counts as the record does.
              const lined = value.derived === true && typeof value.recordId === 'string' ? rawEntity(value.recordId) : undefined;
              const carried = lined ? [value.recordId, ...(lined.kind === 'decision' && Array.isArray(lined.alternatives) ? lined.alternatives.map((alternative) => alternative?.id) : [])] : [];
              for (const id of [value.id, value.decisionId, ...carried]) if (typeof id === 'string' && rawEntity(id) && boundary.visible(rawEntity(id))) ids.add(id);
              for (const item of Object.values(value)) if (typeof item === 'object') visit(item);
            };
            visit(result);
            if (boundary.widerRead || boundary.scope.grantLimitation) authority.aggregate({ accessId: boundary.accessId, surface: boundary.surface, reason: boundary.scope.grantLimitation ?? null, used: Boolean(boundary.scope.grant), recordsReturned: ids.size, resolvedScope: boundary.scope, grantScope: boundary.provenance?.scope });
            if (name !== 'redact' && boundary.provenance && result && typeof result === 'object') result.readProvenance = clone(boundary.provenance);
          }
          return result;
        })();
      } catch (error) {
        const boundary = current.boundary;
        if (boundary?.requestedAccess && boundary.scope.grantLimitation) {
          transactional('accessRefusal', () => authority.aggregate({ accessId: boundary.accessId, surface: boundary.surface, reason: boundary.scope.grantLimitation, recordsReturned: 0, resolvedScope: boundary.scope }))();
          Object.defineProperty(error, COMMITTED_REJECTION, { value: true });
        }
        throw error;
      } finally { readOperation = previous; }
    };
  }
  // The entity whose owner an integrity issue belongs to, for the issues that
  // name an owner only inside a composite key (duplicate fact and memory scopes).
  const issueOwners = new WeakMap();
  // Legacy entities stored with no project at all. Import files them under
  // "default", as every build before schema 6 did, but the attribution
  // migration must map them to legacy_unattributed, not legacy_ambiguous (WS-11
  // mapping iii). So the absence is kept: here by id, and in the privileged
  // snapshot as the top-level STORED_WITHOUT_PROJECT list of those still
  // waiting for the migration. A save after an entity's migration no longer
  // lists it. Evidence an older save already discarded is not recreated.
  const projectlessLegacy = new TransactionMap();
  // Only while the entity still sits unmigrated in the "default" it was filed
  // under, so a listed id can never demote an entity with a real project.
  function isStoredWithoutProject(entity) {
    return projectlessLegacy.has(entity.id) && entity.attribution === undefined && (entity.project ?? 'default') === 'default';
  }
  // ---- Deletion knowledge (PR-37a; design §2, §11, §12) -------------------
  //
  // W is the installed view's withheld set: the entities whose erasure token
  // a tombstone or quarantine entry names, their relations, review signals,
  // retry entries, events, runtime-miss entries, capture content and journal
  // entries, and a tombstoned project's own entries that name no entity and
  // predate its tombstone. W is held apart from every live map, as capture
  // items are from records, so no read, write, search, traversal or count
  // meets it. Its journal entries are logical skeletons in the live journal
  // and the live baseline is rewritten without it, so the live graph is exactly
  // what a logical purge of W would leave. Only the persistence snapshot puts W
  // back, in place: the store never changes.
  const byId = (item) => item?.id;
  const WITHHELD_EXTRAS = { [RUNTIME_MISSES]: (item) => item?.missId, [CAPTURE_CONTENT]: (item) => item?.contentRef, [CAPTURE_SESSIONS]: byId };
  const sessionKey = (originId, sessionId) => JSON.stringify([originId, sessionId]);

  function withheldId(entityId) {
    const held = deletion.get('held');
    return Boolean(held && (held.ids.has(entityId) || held.relationIds.has(entityId)));
  }

  // A new token is never one a tombstone, quarantine entry or W already names.
  function withheldToken(token) {
    return Boolean(deletion.get('held')?.tokens.has(token) || deletion.get('view')?.tokens.has(token));
  }

  // The original of a live journal entry W replaced: its skeleton, or the
  // baseline rewritten without W, sits at the original's id and sequence.
  function heldOriginal(held, entry) {
    const original = held?.journal.get(entry?.id);
    return original !== undefined && original.seq === entry.seq ? original : undefined;
  }

  function withheldRecords() {
    return deletion.get('held')?.collections.records?.items.map(([, item]) => item) ?? [];
  }

  function withheldCaptures() {
    return deletion.get('held')?.collections.captures?.items.map(([, item]) => item) ?? [];
  }

  // What is quarantined (PR-37c design §9): the held entities whose token a
  // quarantine entry names and no tombstone does. They are withheld as
  // possibly purged, counted on every read of their scope, and only the owner
  // releases or purges them.
  function quarantinedEntities() {
    const quarantine = deletion.get('view')?.quarantine;
    if (!quarantine?.size) return [];
    const held = deletion.get('held')?.collections ?? {};
    return ['records', 'captures', 'facts'].flatMap((name) => held[name]?.items.map(([, item]) => item) ?? []).filter((entity) => quarantine.has(entity.erasureToken));
  }

  // The owner's view of it, by identity only (`shadowgraph quarantine list`,
  // V-7): no content field and no token.
  function quarantined() {
    return quarantinedEntities().map((entity) => ({
      id: entity.id, kind: entity.kind, project: entity.project, attribution: entity.attribution,
      ...(entity.attribution === 'unattributed' ? { originId: entity.originId } : {}), createdAt: entity.createdAt
    }));
  }

  function sessionWithheld(originId, sessionId) {
    return deletion.get('held')?.sessions.has(sessionKey(originId, sessionId)) ?? false;
  }

  // A write never duplicates a key or scope W holds (design §11 R-3): the next
  // save would hold both.
  function refuseWithheldRetry(key) {
    if (deletion.get('held')?.retryKeys.has(key)) throw deletionError(IDEMPOTENCY_KEY_WITHHELD, 'Refusing the write: its idempotency key is held by deletion records this build honours');
  }

  function refuseWithheldScope(held) {
    if (held) throw deletionError(SCOPE_KEY_WITHHELD, 'Refusing the write: its memory or fact scope is held by deletion records this build honours');
  }

  // Replaces an array's contents, undoably inside an ordinary write.
  function replaceContents(target, items) {
    const previous = [...target];
    if (transactionContext?.mode === 'undo') transactionContext.undo.push(() => { target.length = 0; Array.prototype.push.apply(target, previous); });
    target.length = 0;
    Array.prototype.push.apply(target, items);
  }

  function holdsData() {
    return Boolean(records.size || captures.size || facts.size || relations.size || reviewSignals.size || idempotency.size || events.length || journal.length || extras.size || deletion.has('held'));
  }

  // Whether a merge into this graph needs deletion semantics this build lacks
  // (design §11 R-6): the installed view or the incoming one has knowledge; a
  // registry tombstone applies to the incoming payload; the graph's journal
  // holds a purge marker; or the merge would replace a transcript cursor the
  // graph holds (K-2).
  function mergeNeedsDeletionSemantics(data) {
    const incoming = data?.[DELETION_VIEW];
    if (retentionPolicy().length || incoming?.retentionOverrides?.length || hasCaptureRetentionState(data) || hasCaptureRetentionState({ records: [...captures.values(), ...withheldCaptures()] })) return true;
    if (deletion.get('view')?.knowledge || incoming?.knowledge || incoming?.registryApplies) return true;
    if (journal.some((entry) => ['project.purged', 'origin.purged'].includes(entry?.type))) return true;
    const cursors = new Set((extras.get(CAPTURE_SESSIONS) ?? []).filter((session) => isPlainObject(session?.cursor)).map(byId));
    return Array.isArray(data?.captureSessions) && data.captureSessions.some((session) => cursors.has(session?.id));
  }

  // The data with a view attached, for a staging graph's import.
  function withView(data, view) {
    if (!view || data === null || typeof data !== 'object') return data;
    return Object.defineProperty(Array.isArray(data) ? { records: data } : { ...data }, DELETION_VIEW, { value: view });
  }

  // W taken out of the live graph (design §2.2, §2.3, §11 R-3, R-10, §12 C5).
  function hold() {
    const view = deletion.get('view');
    if (!view || (!view.tokens.size && !view.projects.length && !view.origins?.length && !view.ids?.size) || deletion.has('held')) return;
    // By its token, or by its id when a committed restore waits for its
    // post-step and the entity has no token yet (PR-37c design §1.4, §8.1); or
    // whole, tokenless included, when a purge of its project waits for the
    // next write: exactly what the purge's selection removes (PR-37d design
    // §4.1).
    const withheldEntity = (entity) => (entity?.erasureToken !== undefined && view.tokens.has(entity.erasureToken)) || Boolean(view.ids?.has(entity?.id))
      || (view.purging?.has(entity?.project) === true && ownedByProject(entity, entity.project));
    const heldRecords = [...records.values()].filter(withheldEntity);
    const heldCaptures = [...captures.values()].filter(withheldEntity);
    const heldFacts = [...facts.values()].filter(withheldEntity);
    const ids = new Set();
    for (const entity of [...heldRecords, ...heldCaptures, ...heldFacts]) {
      ids.add(entity.id);
      for (const alternative of entity.alternatives ?? []) ids.add(alternative.id);
    }
    const heldRelations = [...relations.values()].filter((relation) => ids.has(relation.from) || ids.has(relation.to));
    const relationIds = new Set(heldRelations.map(byId));
    // Item 8: a project tombstone withholds the project's own entries that name
    // no entity and predate it, whether or not it names tokens; one with no
    // valid instant predates it. Access and authority entries never are.
    const predates = (project, at) => typeof project === 'string'
      && view.projects.some((tombstone) => tombstone.project === project && !(isValidIsoInstant(at) && compareInstants(at, tombstone.at) >= 0));
    const originPredates = (owner, at) => owner?.attribution === 'unattributed'
      && (view.origins ?? []).some(tombstone => tombstone.originId === owner.originId && !(isValidIsoInstant(at) && compareInstants(at, tombstone.at) >= 0));
    const entityKeys = ['recordId', 'factId', 'replacementId'];
    const namesNothing = (item) => ![...entityKeys, 'relationId'].some((key) => item?.[key] !== undefined && item?.[key] !== null);
    const heldEvents = events.filter((item) => entityKeys.some((key) => ids.has(item?.[key])) || relationIds.has(item?.relationId)
      || (namesNothing(item) && !String(item?.type).startsWith('access.') && (predates(item?.project, item?.at) || originPredates(item, item?.at))));
    const heldSignals = [...reviewSignals.values()].filter((signal) => ids.has(signal.decisionId));
    const heldRetries = [...idempotency.entries()].filter(([, value]) => ids.has(value?.id)).map(([key, value]) => ({ key, value: canonicalIdempotencyValue(value) }));
    const extra = (name) => (Array.isArray(extras.get(name)) ? extras.get(name) : []);
    const heldMisses = extra(RUNTIME_MISSES).filter((entry) => ids.has(entry?.recordId) || predates(entry?.scope?.project, entry?.at)
      || (entry?.scope?.requestState === 'project_unresolved' && entry.scope.project === null
        && originPredates({ attribution: 'unattributed', originId: entry.scope.originId }, entry.at)));
    const contentRefs = new Set(heldCaptures.map((item) => item.contentRef).filter(Boolean));
    const heldContent = extra(CAPTURE_CONTENT).filter((entry) => contentRefs.has(entry?.contentRef));
    // A session opened after the tombstone captures; one with no valid start
    // predates it, which fails closed (PR-37c design §1.3, R9).
    const heldSessions = extra(CAPTURE_SESSIONS).filter((session) => (session?.attribution === 'project' && predates(session.project, session.startedAt)) || originPredates(session, session.startedAt));
    if (![heldRecords, heldCaptures, heldFacts, heldEvents, heldMisses, heldSessions].some((list) => list.length)) return;
    // W's journal entries become logical skeletons and the baseline is
    // rewritten without W, as a logical purge leaves them; the originals are
    // kept by id for the persistence snapshot.
    const originals = new Map();
    const entryHeld = (entry) => {
      const payload = replayedEntity(entry);
      return ids.has(entry.entityId) || relationIds.has(entry.entityId) || ids.has(payload?.id) || relationIds.has(payload?.id)
        || (entry.type === 'relation.created' && (ids.has(entry.payload?.from) || ids.has(entry.payload?.to)));
    };
    const liveJournal = journal.map((entry) => {
      if (typeof entry?.id !== 'string') return entry;
      if (entry.type === 'projection.baseline') {
        const rewritten = clone(entry);
        if (!rewriteBaselineForProjectPurge(rewritten, null, ids, relationIds)) return entry;
        originals.set(entry.id, entry);
        return rewritten;
      }
      if (!entryHeld(entry)) return entry;
      originals.set(entry.id, entry);
      return scrubLogicalPurgeSkeleton(clone(entry), entry.redacted === true && entry.redactedReason === 'capture_deleted' ? 'capture_deleted' : undefined);
    });
    // Each held item keeps its place: its index among what the collection held
    // at this moment.
    const collections = {};
    const take = (name, live, keyOf, heldItems) => {
      if (!heldItems.length) return;
      const order = new Map(live.map((item, index) => [keyOf(item), index]));
      collections[name] = { order, items: heldItems.map((item) => [order.get(keyOf(item)), item]) };
    };
    take('records', [...records.values()], byId, heldRecords);
    take('captures', [...captures.values()], byId, heldCaptures);
    take('facts', [...facts.values()], byId, heldFacts);
    take('relations', [...relations.values()], byId, heldRelations);
    take('reviewSignals', [...reviewSignals.values()], byId, heldSignals);
    take('idempotency', [...idempotency.keys()].map((key) => ({ key })), (item) => item.key, heldRetries);
    take('events', events, byId, heldEvents);
    take(RUNTIME_MISSES, extra(RUNTIME_MISSES), WITHHELD_EXTRAS[RUNTIME_MISSES], heldMisses);
    take(CAPTURE_CONTENT, extra(CAPTURE_CONTENT), WITHHELD_EXTRAS[CAPTURE_CONTENT], heldContent);
    take(CAPTURE_SESSIONS, extra(CAPTURE_SESSIONS), byId, heldSessions);
    const held = {
      ids, relationIds, collections, journal: originals,
      tokens: new Set([...heldRecords, ...heldCaptures, ...heldFacts].map((entity) => entity.erasureToken).filter((token) => token !== undefined)),
      entities: new Map([...heldRecords, ...heldFacts].map((entity) => [entity.id, entity])),
      retryKeys: new Set(heldRetries.map((item) => item.key)),
      memoryScopes: new Set(heldRecords.filter((item) => item.kind === 'memory' && item.status === 'active').map(memoryScopeKey)),
      factScopes: new Set(heldFacts.filter((fact) => fact.status === 'active').map((fact) => JSON.stringify([ownerKey(fact, (project) => project ?? 'default'), fact.key]))),
      sessions: new Set(heldSessions.map((session) => sessionKey(session.originId, session.sessionId)))
    };
    for (const item of heldRecords) records.delete(item.id);
    for (const item of heldCaptures) captures.delete(item.id);
    for (const item of heldFacts) facts.delete(item.id);
    for (const item of heldRelations) relations.delete(item.id);
    for (const [key, signal] of reviewSignals) if (ids.has(signal.decisionId)) reviewSignals.delete(key);
    for (const { key } of heldRetries) idempotency.delete(key);
    const heldEventSet = new Set(heldEvents);
    replaceContents(events, events.filter((item) => !heldEventSet.has(item)));
    replaceContents(journal, liveJournal);
    for (const [name, heldItems] of [[RUNTIME_MISSES, heldMisses], [CAPTURE_CONTENT, heldContent], [CAPTURE_SESSIONS, heldSessions]]) {
      const heldSet = new Set(heldItems);
      if (heldItems.length) extras.set(name, extra(name).filter((entry) => !heldSet.has(entry)));
    }
    deletion.set('held', held);
    recomputeCurrentMemories();
    recomputeCurrentFacts();
  }

  // W put back in place: the graph is then the store exactly as it is, with
  // no view applied. A purge reaches W this way.
  function unhold() {
    if (!deletion.has('held')) return;
    const whole = snapshot();
    clearLive();
    importPayload(whole);
  }

  // W re-emitted in place (design §2.3): each held item goes back before the
  // first live item that came after it when it was held, and before anything
  // written since, so the live order is kept exactly.
  function reemit(live, keyOf, held) {
    if (!held) return live;
    const out = [];
    let next = 0;
    const flush = (limit) => { while (next < held.items.length && held.items[next][0] < limit) out.push(held.items[next++][1]); };
    for (const item of live) {
      flush(held.order.get(keyOf(item)) ?? Infinity);
      out.push(item);
    }
    flush(Infinity);
    return out;
  }

  // How much W holds, by collection: counts only, never an id (downgrade
  // reports these; design §6).
  function withheldCounts() {
    const held = deletion.get('held');
    if (!held) return {};
    const counts = Object.fromEntries(Object.entries(held.collections).map(([name, { items }]) => [name, items.length]));
    const skeletons = [...held.journal.values()].filter((entry) => entry.type !== 'projection.baseline').length;
    if (skeletons) counts.journal = skeletons;
    return counts;
  }

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
      captures: [...captures],
      currentMemories: [...currentMemories],
      facts: [...facts],
      currentFacts: [...currentFacts],
      events,
      journal,
      relations: [...relations],
      reviewSignals: [...reviewSignals],
      idempotency: [...idempotency],
      extras: [...extras],
      deletion: [...deletion],
      projectlessLegacy: [...projectlessLegacy],
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
    restoreMap(captures, snapshot.captures);
    restoreMap(currentMemories, snapshot.currentMemories);
    restoreMap(facts, snapshot.facts);
    restoreMap(currentFacts, snapshot.currentFacts);
    restoreMap(relations, snapshot.relations);
    restoreMap(reviewSignals, snapshot.reviewSignals);
    restoreMap(idempotency, snapshot.idempotency);
    restoreMap(extras, snapshot.extras);
    restoreMap(deletion, snapshot.deletion);
    restoreMap(projectlessLegacy, snapshot.projectlessLegacy);
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
        // A graph with no active claim pays no snapshot cost. Every ordinary
        // mutation, including import/attribution and asynchronous verification,
        // marks the affected claim before its outer transaction can publish.
        const generationBefore = mode !== 'none' && [...captures.values()].some(item => item.state === 'processing' && !item.cancelRequested)
          ? snapshot() : null;
        const cancelInvalidated = () => {
          if (!generationBefore) return;
          const tokens = new Set(invalidatedCaptureTokens(generationBefore, snapshot()));
          const affected = [...captures.values()].filter(item => item.state === 'processing' && !item.cancelRequested && tokens.has(item.erasureToken));
          assertJournalCapacity(affected.length);
          for (const item of affected) {
            const next = { ...clone(item), cancelRequested: true, updatedAt: now() };
            captures.set(item.id, next);
            appendJournal({ type: 'capture.state_changed', entityKind: CAPTURE_KIND, entityId: item.id, project: item.project, payload: next });
          }
        };
        const value = operation(...args);
        if (value && typeof value.then === 'function') {
          return Promise.resolve(value).then(
            (result) => {
              try { cancelInvalidated(); } catch (error) { return rollback(error); }
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
        cancelInvalidated();
        transactionContext = null;
        activeMutation = null;
        return value;
      } catch (error) {
        return rollback(error);
      }
    };
  }

  function setRevision(value) { if (Number.isInteger(value) && value >= revision) revision = value; }
  function allocateEntityId(prefix, reserved = new Set()) {
    // Entity IDs share one namespace, including nested alternatives. Retry
    // internally; neither a collided candidate nor occupancy leaves this API.
    for (let attempt = 0; attempt < 128; attempt += 1) {
      const candidate = id(prefix);
      if (records.has(candidate) || captures.has(candidate) || facts.has(candidate) || relations.has(candidate) || reserved.has(candidate) || withheldId(candidate)) continue;
      if ([...records.values()].some((record) => (record.alternatives ?? []).some((alternative) => alternative.id === candidate))) continue;
      reserved.add(candidate);
      return candidate;
    }
    const error = new Error('Unable to allocate an entity ID');
    error.code = 'entity_id_allocation_failed';
    throw error;
  }

  function id(prefix) {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }

  // Plan rev6 §3.2: the random, content-free handle a purge tombstone names an
  // entity by. Never derived from the entity, and never shared by two.
  function allocateErasureToken() {
    for (;;) {
      const token = randomUUID();
      if (!withheldToken(token) && ![...records.values(), ...captures.values(), ...facts.values()].some((entity) => entity.erasureToken === token)) return token;
    }
  }

  // An entity's retry values carry its token too; nothing else in them changes.
  function tokenRetryValues(entity) {
    for (const [key, value] of idempotency) {
      if (value?.id === entity.id && value.erasureToken !== entity.erasureToken) idempotency.set(key, { ...value, erasureToken: entity.erasureToken });
    }
  }

  // Plan rev6 §3.2: the first write to a tokenless decision, attempt, memory or
  // fact gives it its token, on that write's own journal entry. Only a write
  // does: a load, read, import or restore never reaches here. A fact that names
  // no kind cannot carry one, and an entity of a newer writer is not this
  // build's to change.
  function withFirstWriteToken(input) {
    if (!ATTRIBUTED_ENTITY_KINDS.includes(input.entityKind) || !isPlainObject(input.payload)) return input;
    const live = (input.entityKind === 'fact' ? facts : records).get(input.entityId);
    if (!live || !ATTRIBUTED_ENTITY_KINDS.includes(live.kind) || isNewerThanWriter(live)) return input;
    if (live.erasureToken === undefined) {
      touchMutableObject(live);
      live.erasureToken = allocateErasureToken();
      tokenRetryValues(live);
    }
    return input.payload.erasureToken === live.erasureToken ? input : { ...input, payload: { ...input.payload, erasureToken: live.erasureToken } };
  }

  // Legacy breadcrumb trail. Kept verbatim for backward compatibility; the journal
  // is the rebuildable record.
  function event(type, payload) {
    const data = clone(payload);
    let project = data.project;
    const refId = data.recordId ?? data.factId;
    if (!project && refId) project = rawEntity(refId)?.project;
    if (!project && data.relationId) {
      const relation = relations.get(data.relationId);
      project = rawEntity(relation?.from)?.project ?? rawEntity(relation?.to)?.project;
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
    if (['entity.attributed', 'entity.token_assigned'].includes(entry.type) && !ATTRIBUTED_ENTITY_KINDS.includes(entry.entityKind)) throw new Error(`${entry.type} requires entityKind ${ATTRIBUTED_ENTITY_KINDS.join(', ')}`);
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
    const entry = prebuildJournalEntry(withFirstWriteToken(input), journalSeq + 1);
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

  // Who owns a new record (plan v1.4.4 §10.3; P1 reconciliation F-03). A
  // selected project owns it -- the literal "default" included, as a real
  // project of that name (owner decision OD-1). With no project, a presented
  // origin owns it and no project does. With neither there is no owner, and the
  // write is refused rather than stored under one nobody chose. The refusal
  // blocks only ShadowGraph's own storage, never the caller's work (PC-15).
  function writeOwner(input) {
    const scope = resolveScope({ project: input?.project, originId: input?.originId, binding: input?.binding });
    if (scope.state === 'project_selected') return { project: scope.project, attribution: 'project', ...(scope.originId ? { originId: scope.originId } : {}) };
    if (scope.originId) return { project: null, attribution: 'unattributed', originId: scope.originId };
    const error = new Error('Write refused (write_scope_unresolved): no project was selected and no origin id was presented, so nothing would own this record. Pass a project, or an originId.');
    error.code = 'write_scope_unresolved';
    error.reason = 'no_project_and_no_origin';
    throw error;
  }

  // The boundary of a change to an entity that already exists (P1 findings
  // F-16 and F-30): the write's own project, or its own origin, exactly what a
  // new record would be written for. Nothing that widens a read widens it.
  // With neither, the change is refused before any id is resolved, so an id
  // that exists and one that does not are refused alike.
  function writeBoundary(input) {
    return readBoundary(writeOwner(input));
  }

  function decisionIn(boundary, decisionId) {
    const found = entity(decisionId, boundary);
    return found?.kind === 'decision' ? found : undefined;
  }

  function scopedIdempotencyKey(input, action, owner = writeOwner(input)) {
    const scope = action === 'memory' ? normalizeMemoryScope(input.scope) : null;
    return `${idempotencyKeyPrefix({ kind: action, ...owner, scope, memoryType: input.memoryType, key: input.key })}${input.idempotencyKey}`;
  }

  function idempotent(input, action) {
    if (!input?.idempotencyKey) return undefined;
    validateIdempotencyKey(input.idempotencyKey);
    // A retry matches only within its own owner. With no owner there is nothing
    // to match; the write itself is refused once its content is validated.
    let owner;
    try { owner = writeOwner(input); }
    catch (error) { if (error.code === 'write_scope_unresolved') return undefined; throw error; }
    const existing = idempotency.get(retrySlot(input, action, owner));
    if (existing) return clone(canonicalIdempotencyValue(existing));
    // Legacy key forms predate origins; only a project-owned retry can match one.
    if (owner.attribution !== 'project') return undefined;
    // Legacy keys did not include project (all actions) or exact memory identity.
    // Reuse one only when the entity it names has this write's owner -- never a
    // legacy "default" record, whose owner is not the real project "default"
    // (OD-1) -- and, for a memory, the exact same scope/type/key; otherwise it
    // would leak another owner's retry result.
    const legacyKeys = [`${action}:${owner.project}:${input.idempotencyKey}`, `${action}:${input.idempotencyKey}`];
    for (const key of legacyKeys) {
      const legacy = idempotency.get(key);
      if (!legacy || !sameOwnerKey(idempotencyHolder(legacy), owner)) continue;
      if (action === 'memory' && memoryScopeKey(legacy) !== memoryScopeKey({ ...input, ...owner })) continue;
      return clone(canonicalIdempotencyValue(legacy));
    }
    return undefined;
  }

  function idempotencyHolder(value) {
    return (value?.kind === 'fact' ? facts.get(value.id) : value?.kind === CAPTURE_KIND ? captures.get(value.id) : records.get(value?.id)) ?? value;
  }

  // Where a write's retry is stored and looked up. A key another owner already
  // holds -- a legacy "default" record's, presented again by the real project
  // called "default" -- stays with its holder, and this owner's retry is kept
  // beside it rather than matched to it or written over it.
  function retrySlot(input, action, owner = writeOwner(input)) {
    const key = scopedIdempotencyKey(input, action, owner);
    refuseWithheldRetry(key);
    const held = idempotency.get(key);
    if (!held || sameOwnerKey(idempotencyHolder(held), owner)) return key;
    const beside = `${key}${BESIDE_ANOTHER_OWNER}`;
    refuseWithheldRetry(beside);
    const alsoHeld = idempotency.get(beside);
    if (alsoHeld && !sameOwnerKey(idempotencyHolder(alsoHeld), owner)) throw new Error('Idempotency key is already held by other owners');
    return beside;
  }

  function rememberIdempotency(input, action, value) {
    if (input?.idempotencyKey) idempotency.set(retrySlot({ ...input, ...value }, action), clone(value));
  }

  function canonicalIdempotencyValue(value) {
    const current = value?.kind === 'fact' ? facts.get(value.id) : value?.kind === CAPTURE_KIND ? captures.get(value.id) : records.get(value?.id);
    if (!current) throw new Error('Idempotency entry must reference an existing entity');
    if (!idempotencySemanticallyMatches(value, current)) {
      throw new Error(`Idempotency entry semantic mismatch with canonical entity ${value.id}`);
    }
    return current;
  }

  function addDecision(input) {
    assertCreationInput('decision', input);
    const existing = idempotent(input, 'decision'); if (existing) return existing;
    if (!input || typeof input !== 'object' || typeof input.title !== 'string' || !input.title.trim() || typeof input.chosen !== 'string' || !input.chosen.trim()) throw new Error('A decision requires non-empty title and chosen strings');
    validateTemporalFields(input, ['createdAt', 'reviewAfter']);
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Decision confidence must be a number between 0 and 1');
    const alternatives = input.alternatives ?? [];
    if (!Array.isArray(alternatives) || alternatives.some((item) => !item || typeof item.label !== 'string' || !item.label.trim())) throw new Error('Decision alternatives must have non-empty label strings');
    const owner = writeOwner(input);
    const evidence = (input.evidence ?? []).map((item) => normalizeEvidence(item, now));
    const reservedIds = new Set();
    const record = {
      id: allocateEntityId('decision', reservedIds), kind: 'decision', schemaVersion: SCHEMA_VERSION, erasureToken: allocateErasureToken(),
      ...owner, title: input.title, goal: input.goal ?? '', chosen: input.chosen,
      // G2: provenance travels with the decision. Plain JSON values only.
      ...provenanceFields(input),
      // G8: confidence carries an auditable basis, not a bare number.
      confidence: createConfidence(confidence, evidence.length), status: 'proposed',
      assumptions: strings(input.assumptions, 'assumptions'), evidence,
      alternatives: alternatives.map((item) => ({ id: allocateEntityId('alternative', reservedIds), label: item.label, reasonRejected: item.reasonRejected ?? item.reason ?? '', reopenWhen: normalizeRules(item.reopenWhen ?? [], { strict: true }), status: 'rejected' })),
      failedAttempts: [...(input.failedAttempts ?? [])], outcome: input.outcome ?? null,
      reviewAfter: input.reviewAfter ?? null, createdAt: input.createdAt ?? now(), updatedAt: now()
    };
    clone(record);
    assertJournalCapacity(1);
    records.set(record.id, record);
    event('decision.recorded', { recordId: record.id });
    appendJournal({ type: 'decision.recorded', entityKind: 'decision', entityId: record.id, project: record.project, payload: record, provenance: writeProvenance(record), idempotencyKey: input.idempotencyKey ? retrySlot(input, 'decision', owner) : undefined });
    const result = clone(record); rememberIdempotency(input, 'decision', result); return result;
  }

  function addAttempt(input) {
    assertCreationInput('attempt', input);
    const existing = idempotent(input, 'attempt'); if (existing) return existing;
    if (!input || typeof input !== 'object' || typeof input.solution !== 'string' || !input.solution.trim() || typeof input.result !== 'string' || !input.result.trim()) throw new Error('An attempt requires non-empty solution and result strings');
    if (input.resultClass !== undefined && !ATTEMPT_RESULT_CLASSES.includes(input.resultClass)) {
      throw new Error('Attempt resultClass must be failed, succeeded, or inconclusive');
    }
    validateTemporalFields(input, ['createdAt']);
    const owner = writeOwner(input);
    const attempt = { id: allocateEntityId('attempt'), kind: 'attempt', schemaVersion: SCHEMA_VERSION, erasureToken: allocateErasureToken(), ...owner, ...provenanceFields(input), solution: input.solution, result: input.result, environment: input.environment ?? '', ...(input.resultClass === undefined ? {} : { resultClass: input.resultClass }), reason: input.reason ?? '', causalClaim: causalClaimFor(input.reason), reusableWhen: normalizeRules(input.reusableWhen ?? [], { strict: true }), relatedTo: input.relatedTo ?? [], createdAt: input.createdAt ?? now() };
    clone(attempt);
    assertJournalCapacity(1);
    records.set(attempt.id, attempt);
    event('attempt.recorded', { recordId: attempt.id });
    appendJournal({ type: 'attempt.recorded', entityKind: 'attempt', entityId: attempt.id, project: attempt.project, payload: attempt, provenance: writeProvenance(attempt), idempotencyKey: input.idempotencyKey ? retrySlot(input, 'attempt', owner) : undefined });
    const result = clone(attempt); rememberIdempotency(input, 'attempt', result); return result;
  }

  // Scoped memory covers profile and continuity use cases without flattening
  // decisions, alternatives, evidence, and outcomes into generic text.
  function remember(input) {
    assertCreationInput('memory', input);
    const existingRetry = idempotent(input, 'memory');
    if (existingRetry) return { operation: 'NOOP', memory: existingRetry };
    if (!input || typeof input !== 'object') throw new Error('A memory requires an input object');
    if (!MEMORY_TYPES.includes(input.memoryType)) throw new Error(`Memory type must be one of: ${MEMORY_TYPES.join(', ')}`);
    if (typeof input.key !== 'string' || !input.key.trim()) throw new Error('A memory requires a non-empty key');
    if (typeof input.text !== 'string' || !input.text.trim()) throw new Error('A memory requires non-empty text');
    if (input.metadata !== undefined && (!input.metadata || typeof input.metadata !== 'object' || Array.isArray(input.metadata))) throw new Error('Memory metadata must be an object');
    validateTemporalFields(input, ['recordedAt', 'createdAt', 'validFrom', 'validTo']);
    const owner = writeOwner(input);
    const project = owner.project;
    const scope = normalizeMemoryScope(input.scope);
    const tags = strings(input.tags, 'tags');
    const metadata = clone(input.metadata ?? {});
    const embedding = normalizeEmbedding(input.embedding);
    const scopeKey = memoryScopeKey({ ...owner, scope, memoryType: input.memoryType, key: input.key });
    refuseWithheldScope(deletion.get('held')?.memoryScopes.has(scopeKey));
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
      id: allocateEntityId('memory'), kind: 'memory', schemaVersion: SCHEMA_VERSION, erasureToken: allocateErasureToken(),
      ...owner, scope, memoryType: input.memoryType, key: input.key, text: input.text,
      // Versions count past W's too, as they would with no view (review C-4);
      // nothing else here looks at W (re-review R2-2).
      version: Math.max(latest?.version ?? 0, ...withheldRecords().filter((record) => record.kind === 'memory' && memoryScopeKey(record) === scopeKey).map((record) => record.version ?? 1)) + 1,
      metadata, tags, embedding, ...provenance, verificationStatus: 'unverified', status: 'active',
      temporal: { validFrom, validTo, recordedAt, invalidatedAt: null },
      createdAt: input.createdAt ?? recordedAt, updatedAt: recordedAt,
      ...(previous ? { supersedes: previous.id } : {})
    };
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
    appendJournal({ type: 'memory.recorded', entityKind: 'memory', entityId: memory.id, project, payload: memory, provenance: writeProvenance(memory), idempotencyKey: input.idempotencyKey ? retrySlot({ ...input, ...memory }, 'memory') : undefined });
    rememberIdempotency(input, 'memory', memory);
    return { operation: previous ? 'UPDATE' : 'ADD', memory: clone(memory), ...(previous ? { previous: clone(previous) } : {}) };
  }

  // Every version of one memory identity, inside the read boundary (P1
  // reconciliation F-17): with no project and no origin it is empty, never the
  // legacy "default" bucket.
  function memoryHistory(input = {}) {
    const boundary = readBoundary(input);
    const scope = normalizeMemoryScope(input.scope);
    const items = [...records.values()]
      .filter((record) => record.kind === 'memory' && boundary.visible(record) && sameMemoryScopeValues(record.scope, scope) && record.memoryType === input.memoryType && record.key === input.key)
      .sort((left, right) => (left.version ?? 1) - (right.version ?? 1) || compareInstants(left.temporal?.validFrom ?? left.createdAt, right.temporal?.validFrom ?? right.createdAt) || String(left.id).localeCompare(String(right.id)))
      .map(clone);
    return scopedPage(items, input, boundary, { scope, memoryType: input.memoryType, key: input.key }, { historical: true });
  }

  function applyMemoryPlan(input = {}) {
    assertCreationInput('memoryPlan', input);
    if (!Array.isArray(input.operations)) throw new Error('Memory plan operations must be an array');
    // One owner for the whole plan; each written memory inherits it.
    const owner = writeOwner(input);
    const project = owner.project;
    const defaultScope = normalizeMemoryScope(input.scope);
    const actions = new Set(['ADD', 'UPDATE', 'DELETE', 'NOOP']);
    const simulatedValidFrom = new Map([...currentMemories].map(([key, memory]) => [key, memory.temporal?.validFrom ?? null]));
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
      for (const name of ['actor', 'client', 'sessionId']) provenanceString(raw[name] ?? input[name], name);
      const recordedAt = ['ADD', 'UPDATE'].includes(action) ? (raw.recordedAt ?? now()) : raw.recordedAt;
      const identityKey = memoryScopeKey({ ...owner, scope, memoryType: raw.memoryType, key: raw.key });
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
      const scopeKey = memoryScopeKey({ ...owner, scope: operation.scope, memoryType: operation.memoryType, key: operation.key });
      const current = simulatedMemories.get(scopeKey);
      if (operation.action === 'NOOP' || (operation.action === 'DELETE' && !current)) continue;
      if (operation.action === 'DELETE') {
        requiredJournalEntries += 1;
        simulatedMemories.delete(scopeKey);
        continue;
      }

      const operationInput = { ...operation, project, originId: owner.originId, scope: operation.scope };
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
          id: `reserved-memory-${simulatedMemories.size}`,
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
      const scopeKey = memoryScopeKey({ ...owner, scope: operation.scope, memoryType: operation.memoryType, key: operation.key });
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
        originId: owner.originId,
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
    assertCreationInput('fact', input);
    if (!input || typeof input.key !== 'string' || !input.key.trim()) throw new Error('A fact requires a non-empty key');
    validateTemporalFields(input, ['recordedAt', 'observedAt', 'validFrom', 'validTo', 'expiresAt']);
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) throw new Error('Fact confidence must be a number between 0 and 1');
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
    // Ownership is decided once the content is known to be valid, so a caller
    // learns what is wrong with the fact before learning it has no owner.
    const owner = writeOwner(input);
    const factScope = JSON.stringify([ownerKey(owner, (project) => project), input.key]);
    refuseWithheldScope(deletion.get('held')?.factScopes.has(factScope));
    const previous = currentFacts.get(factScope);
    const existing = idempotent(input, 'fact'); if (existing) return existing;
    if (previous?.temporal?.validFrom && compareInstants(validFrom, previous.temporal.validFrom) < 0) {
      throw new Error('Facts for one scope must be recorded in non-decreasing validFrom order');
    }
    const fact = {
      id: allocateEntityId('fact'), kind: 'fact', schemaVersion: SCHEMA_VERSION, erasureToken: allocateErasureToken(),
      ...owner, key: input.key, value: input.value,
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
    appendJournal({ type: 'fact.observed', entityKind: 'fact', entityId: fact.id, project: fact.project, payload: fact, provenance: writeProvenance(fact), idempotencyKey: input.idempotencyKey ? retrySlot(input, 'fact', owner) : undefined });
    const result = clone(fact); rememberIdempotency(input, 'fact', result); return result;
  }

  // The attribution migration (plan v1.4.4 §9.6 step 3, WS-11), under owner
  // decision OD-1, option B. Every entity written before schema 6 gets its
  // attribution, and each change is journalled as entity.attributed with reason
  // `migration`, so a rebuild reproduces it:
  //   project "default"  -> legacy_ambiguous: kept inspectable and reassignable,
  //                         never treated as a real project named "default"
  //   no project stored  -> legacy_unattributed
  //   any other project  -> project, kept exactly as it was
  // No project is rewritten, none is inferred from content, nothing is deleted.
  // Idempotent per entity and resumable: an entity that already has an
  // attribution is skipped, so an interrupted run continues where it stopped.
  // `limit` bounds one batch; the caller persists between batches. The last
  // migrated id is the high-water mark, and the journal entry that records it
  // is persisted with the batch.
  function migrateAttribution(input = {}) {
    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Attribution migration limit must be a positive integer');
    const pending = [...records.values(), ...facts.values()]
      .filter((entity) => entity.attribution === undefined && !isNewerThanWriter(entity))
      .sort(attributionOrder);
    const batch = pending.slice(0, limit);
    assertJournalCapacity(batch.length);
    const counts = { project: 0, legacy_ambiguous: 0, legacy_unattributed: 0 };
    for (const entity of batch) {
      const { previousProject, attribution } = migrationMapping(entity);
      touchMutableObject(entity);
      entity.schemaVersion = SCHEMA_VERSION;
      entity.attribution = attribution;
      counts[attribution] += 1;
      appendJournal({
        type: 'entity.attributed', entityKind: entity.kind, entityId: entity.id, project: entity.project ?? null,
        payload: { ...clone(entity), attributionChange: { previousProject, previousAttribution: null, reason: 'migration' } }
      });
    }
    const remaining = pending.length - batch.length;
    return { migrated: batch.length, attributions: counts, remaining, complete: remaining === 0, highWaterMark: batch.at(-1)?.id ?? null };
  }

  // Plan rev6 §3.2: the only token backfill, run by migrate. Bounded, resumable
  // and idempotent: each tokenless decision, attempt, memory or fact gets one
  // entity.token_assigned entry that adds the token and changes nothing else,
  // and its retry values carry it too. A fact that names no kind cannot carry a
  // token; it is reported, and no kind is inferred for it.
  function backfillErasureTokens(input = {}) {
    const limit = input.limit ?? Number.MAX_SAFE_INTEGER;
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('Token backfill limit must be a positive integer');
    const tokenless = [...records.values(), ...facts.values()]
      .filter((entity) => entity.erasureToken === undefined && !isNewerThanWriter(entity))
      .sort(attributionOrder);
    // A reader replays an assignment onto the entity's last journal snapshot,
    // which load normalisation may since have reshaped; the entry carries that
    // snapshot with the token added, never the live form. An entity the journal
    // cannot replay gets its token on its next write instead, and is reported.
    const priorOf = replayedEntities();
    const skipReason = (entity) => tokenSkipReason(entity, priorOf);
    const pending = tokenless.filter((entity) => !skipReason(entity));
    const skipped = tokenless.filter(skipReason).map((entity) => ({ id: entity.id, reason: skipReason(entity) }));
    const batch = pending.slice(0, limit);
    assertJournalCapacity(batch.length);
    for (const entity of batch) {
      touchMutableObject(entity);
      entity.erasureToken = allocateErasureToken();
      tokenRetryValues(entity);
      appendJournal(tokenAssignment(entity, priorOf));
    }
    const remaining = pending.length - batch.length;
    return { assigned: batch.length, remaining, complete: remaining === 0, highWaterMark: batch.at(-1)?.id ?? null, skipped };
  }

  // Each entity's last journal snapshot, by id: what an assignment carries.
  function replayedEntities() {
    const replayed = rebuildProjection(journal, { journalEpoch }).projection;
    return new Map([...replayed.records, ...replayed.facts].map((entity) => [entity.id, entity]));
  }

  // Why a tokenless entity cannot take a token by assignment, or null: the
  // eligibility the backfill and a restore's quarantine share (PR-37c design
  // §4.6, §6.4). A record the attribution migration has not reached gets its
  // token on its attribution entry; one whose snapshot an entry of this schema
  // cannot carry gets it on its next write.
  function tokenSkipReason(entity, priorOf) {
    if (!ATTRIBUTED_ENTITY_KINDS.includes(entity.kind)) return 'fact_without_kind';
    if (entity.attribution === undefined) return 'not_attributed';
    const prior = priorOf.get(entity.id);
    if (!prior || prior.erasureToken !== undefined) return 'not_replayable';
    return prior.kind === 'fact' && factValidityPolicyIssue(prior, { required: true }) ? 'not_replayable' : null;
  }

  // The entry that gives an entity the token it now holds: its replayed
  // snapshot with the token added, and nothing else changed. The one writer of
  // the type in this build.
  function tokenAssignment(entity, priorOf) {
    const prior = priorOf.get(entity.id);
    return { type: 'entity.token_assigned', entityKind: entity.kind, entityId: entity.id, project: prior.project ?? null, payload: { ...clone(prior), erasureToken: entity.erasureToken } };
  }

  // The attribution the migration gives an entity written before schema 6,
  // decided only from what is stored and the recorded absence of a project.
  function migrationMapping(entity) {
    const previousProject = isStoredWithoutProject(entity) ? null : entity.project ?? null;
    const attribution = previousProject === null
      ? 'legacy_unattributed'
      : previousProject === 'default' ? 'legacy_ambiguous' : 'project';
    return { previousProject, attribution };
  }

  // Explicit local-owner administration. A grant is read authority and cannot
  // select or widen this mutation. Attribution changes ownership only; the
  // original origin, time, source, trust, and provenance remain byte-for-byte.
  function attribute(input = {}) {
    const named = Object.hasOwn(input, 'ids');
    const origin = Object.hasOwn(input, 'originId');
    if (named === origin) throw new Error('Attribution requires exactly one of ids or originId');
    if (typeof input.targetProject !== 'string' || !input.targetProject.trim()) throw new Error('Attribution requires a non-empty targetProject');
    if (typeof input.reason !== 'string' || !input.reason.trim()) throw new Error('Attribution requires an explicit reason');
    if (input.surface !== undefined && (typeof input.surface !== 'string' || !input.surface.trim())) throw new Error('Attribution surface must be non-empty');
    if (['grant', 'grantId', 'accessId', 'scope', 'binding'].some((key) => Object.hasOwn(input, key))) throw new Error('Read authority cannot authorize attribution');
    if (named && (!Array.isArray(input.ids) || !input.ids.length || input.ids.some((value) => typeof value !== 'string' || !value.trim()) || new Set(input.ids).size !== input.ids.length)) throw new Error('Attribution ids must be distinct non-empty entity ids');
    if (origin && usableOriginId(input.originId) === null) throw new Error('Attribution requires a named originId');
    const selected = named ? input.ids.map((entityId) => {
      const entity = records.get(entityId) ?? facts.get(entityId);
      if (!entity) throw new Error(`Attribution entity not found: ${entityId}`);
      return entity;
    }) : [...records.values(), ...facts.values()].filter((entity) => entity.attribution === 'unattributed' && entity.originId === input.originId);
    // PR-33: this build reads capture and never attributes it. An origin that
    // holds a capture, or a record a capture names anywhere (as one it
    // produced, in a receipt or a superseded result), stays where it is: moved
    // apart, a purge of one owner would leave the other naming what it removed.
    const namedByCapture = new Set();
    const collect = (value) => {
      if (typeof value === 'string') namedByCapture.add(value);
      else if (value && typeof value === 'object') for (const item of Object.values(value)) collect(item);
    };
    for (const { id: ownId, ...item } of captures.values()) collect(item);
    const capturesName = (entity) => namedByCapture.has(entity.id) || (entity.alternatives ?? []).some((alternative) => namedByCapture.has(alternative?.id));
    if ((origin && [...captures.values()].some((item) => item.attribution === 'unattributed' && item.originId === input.originId)) || selected.some(capturesName)) {
      const error = new Error('Attribution of capture material is not supported by this build: the origin holds a capture item, or a capture names a selected record');
      error.code = 'attribution_capture_unsupported';
      throw error;
    }
    if (!selected.length) throw new Error('Attribution origin has no unattributed material');
    if (selected.some(isNewerThanWriter)) throw new Error('Attribution cannot change an entity of a future schema this build does not write');
    const changed = selected.filter((entity) => !ownedByProject(entity, input.targetProject));
    assertJournalCapacity(changed.length);
    const candidate = snapshot();
    let retries = new Map(candidate.idempotency.map((item) => [item.key, item.value]));
    for (const previous of changed) {
      const next = { ...clone(previous), schemaVersion: SCHEMA_VERSION, project: input.targetProject, attribution: 'project' };
      if (next.erasureToken === undefined && ATTRIBUTED_ENTITY_KINDS.includes(next.kind)) next.erasureToken = allocateErasureToken();
      const collection = next.kind === 'fact' ? candidate.facts : candidate.records;
      collection[collection.findIndex((entity) => entity.id === next.id)] = next;
      retries = reattributeIdempotency(retries, next);
      candidate.journal.push(prebuildJournalEntry({
        type: 'entity.attributed', entityKind: next.kind, entityId: next.id, project: next.project,
        payload: { ...next, attributionChange: { previousProject: isStoredWithoutProject(previous) ? null : previous.project ?? null, previousAttribution: previous.attribution ?? null, reason: 'user' } },
        provenance: writeProvenance(previous)
      }, ++candidate.journalSeq));
      candidate.events.push({
        id: id('event'), type: 'attribution.changed', at: now(), project: next.project,
        [next.kind === 'fact' ? 'factId' : 'recordId']: next.id,
        previousProject: isStoredWithoutProject(previous) ? null : previous.project ?? null,
        previousAttribution: previous.attribution ?? null, targetProject: next.project,
        reason: input.reason, surface: input.surface ?? 'local-owner',
        ...(previous.originId ? { originId: previous.originId } : {})
      });
    }
    // A move cannot silently supersede or merge another owner's active identity.
    const moved = new Set(changed.map((entity) => entity.id));
    for (const collection of [candidate.records.filter((item) => item.kind === 'memory'), candidate.facts]) {
      const active = collection.filter((item) => item.status === 'active');
      const key = (item) => item.kind === 'memory' ? memoryScopeKey(item) : JSON.stringify([ownerKey(item, (project) => project ?? 'default'), item.key]);
      for (const entity of active.filter((item) => moved.has(item.id))) if (active.some((other) => other.id !== entity.id && key(other) === key(entity))) throw new Error('Attribution would collide with an active memory or fact identity');
    }
    candidate.idempotency = [...retries].map(([key, value]) => ({ key, value }));
    if (candidate[STORED_WITHOUT_PROJECT]) candidate[STORED_WITHOUT_PROJECT] = candidate[STORED_WITHOUT_PROJECT].filter((entityId) => !moved.has(entityId));
    if (changed.length) replaceData(candidate);
    return { attributed: changed.length, targetProject: input.targetProject, ids: changed.map((entity) => entity.id) };
  }

  // Legacy attribution review (P1 finding F-27; OD-1 option B, plan v1.4.4
  // §10.3). The records no project owns -- legacy "default" data
  // (legacy_ambiguous) and data stored with no project (legacy_unattributed)
  // -- are in no project's read, and this is where they can be inspected
  // before anyone chooses where they belong. It is an administrative view,
  // not a project: no read scope reaches these records, and it reaches nothing
  // else. A record the migration has not reached yet is shown with the
  // attribution the migration's own mapping gives it. An entity from a newer
  // writer's schema is never listed: the migration skips it and attribution
  // refuses it, so its legacy meaning is not this build's to give. Each entry
  // carries the canonical record, and no project is inferred. It writes
  // nothing; reassignment is a separate, explicit action.
  function legacyAttributionReview(options = {}) {
    const items = [...records.values(), ...facts.values()]
      .filter((entity) => !isNewerThanWriter(entity) && isLegacyOwned(entity))
      .sort(attributionOrder)
      .map((entity) => ({
        id: entity.id,
        kind: entity.kind,
        attribution: entity.attribution ?? migrationMapping(entity).attribution,
        migrated: entity.attribution !== undefined,
        assignedProject: null,
        entity: clone(entity)
      }));
    return paginate(items, options, { view: 'legacy_attribution' });
  }

  async function verifyFact(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Fact verification requires an input object');
    const allowed = new Set(['factId', 'evidencePath', 'project', 'originId']);
    if (Object.keys(input).some((name) => !allowed.has(name))) throw new Error('Fact verification only accepts factId, evidencePath, project and originId');
    if (typeof input.factId !== 'string' || !input.factId) throw new Error('Fact verification requires a non-empty factId');
    if (typeof input.evidencePath !== 'string' || !input.evidencePath.trim()) throw new Error('Fact verification requires a non-empty evidencePath');
    if (!verifier || typeof verifier.verify !== 'function' || typeof verifier.validateStored !== 'function') {
      throw new Error('Fact verification is unavailable: configure a separate trusted verifier');
    }
    const boundary = writeBoundary(input);
    const factInScope = () => { const found = entity(input.factId, boundary); return found?.kind === 'fact' ? found : undefined; };
    const fact = factInScope();
    if (!fact) throw new Error('Fact not found');
    if (fact.status !== 'active') throw new Error('Only an active fact can be verified');
    const attestation = await verifier.verify({ fact: clone(fact), evidencePath: input.evidencePath });
    // Evidence verification may perform filesystem I/O. The commit decision must
    // use a fresh trusted clock sample after that await, never the pre-I/O instant.
    const trustedValidationInstant = now();
    const current = factInScope();
    if (!current) throw new Error('Fact not found');
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
        const entry = prebuildJournalEntry(withFirstWriteToken({
          type: 'fact.expired', entityKind: 'fact', entityId: current.id,
          project: current.project, at: trustedValidationInstant, payload: expired
        }), journalSeq + 1);
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
    const entry = prebuildJournalEntry(withFirstWriteToken({
      type: 'fact.verified', entityKind: 'fact', entityId: current.id,
      project: current.project, at: trustedValidationInstant, payload: candidate,
      provenance: { actor: next.verifierIdentity, client: 'local-evidence-verifier', sessionId: null }
    }), journalSeq + 1);
    touchMutableObject(current);
    Object.assign(current, candidate);
    journalSeq = entry.seq;
    if (journalEpoch === null) journalEpoch = entry.seq;
    journal.push(entry);
    return { operation: 'VERIFIED', fact: clone(current) };
  }

  // An id resolved with no boundary at all. Internal, never exported and never
  // returned: the kernel uses it only to label its own breadcrumbs and to check
  // the whole store's references. Every by-id read goes through entity().
  function rawEntity(entityId) {
    if (records.has(entityId)) return records.get(entityId);
    if (facts.has(entityId)) return facts.get(entityId);
    for (const record of records.values()) {
      const alternative = record.kind === 'decision' && record.alternatives?.find((item) => item.id === entityId);
      if (alternative) return { ...alternative, kind: 'alternative', project: record.project, decisionId: record.id };
    }
    return undefined;
  }

  // The by-id chokepoint (plan v1.4.4 §10.5). An id resolves only inside the
  // boundary of the request that names it, and an alternative only where its
  // decision does. Outside it -- another project, legacy data, another origin
  // -- there is no entity, exactly as for an id that exists nowhere, so no
  // by-id answer can tell the two apart. The boundary is required.
  function entity(entityId, boundary) {
    if (typeof boundary?.visible !== 'function') throw new Error('entity() requires the boundary of the request it serves');
    const found = rawEntity(entityId);
    return found && boundary.visible(found.kind === 'alternative' ? records.get(found.decisionId) : found) ? found : undefined;
  }

  // A new relation joins two entities of the one project -- or the one origin
  // -- it is written for (P1 reconciliation F-16, as corrected by the owner).
  // Its boundary comes from the write's own project or origin alone, so nothing
  // that widens a read, a wider-read grant included, ever widens a write. An
  // endpoint outside it is refused exactly as one that does not exist.
  // Relations stored across projects before this rule are kept as they are;
  // scoped reads do not cross them.
  function link(input) {
    assertCreationInput('relation', input);
    if (!input || typeof input.from !== 'string' || typeof input.to !== 'string' || typeof input.relation !== 'string' || !input.relation.trim()) throw new Error('A relationship requires from, to, and relation');
    const boundary = writeBoundary(input);
    const from = entity(input.from, boundary);
    const to = entity(input.to, boundary);
    if (!from || !to) throw new Error('Relation endpoints must exist in the scope the relation is written for');
    return addRelation(input, from.project ?? to.project ?? null);
  }

  function addRelation(input, project) {
    validateTemporalFields(input, ['recordedAt', 'createdAt', 'validFrom', 'validTo']);
    const recordedAt = input.recordedAt ?? now();
    const createdAt = input.createdAt ?? recordedAt;
    const validFrom = input.validFrom ?? createdAt;
    const validTo = input.validTo ?? null;
    if (validTo && compareInstants(validTo, validFrom) <= 0) throw new Error('Relation validTo must be later than validFrom');
    const relation = {
      id: allocateEntityId('relation'), kind: 'relation', schemaVersion: SCHEMA_VERSION,
      from: input.from, to: input.to, relation: input.relation, createdAt,
      temporal: { validFrom, validTo, recordedAt, invalidatedAt: null }
    };
    assertJournalCapacity(1);
    relations.set(relation.id, relation);
    event('relation.created', { relationId: relation.id });
    appendJournal({ type: 'relation.created', entityKind: 'relation', entityId: relation.id, project, payload: relation });
    return clone(relation);
  }

  // A by-id read, and the walk from it, inside the boundary of the request
  // (plan v1.4.4 §10.5). The root and every node reached resolve through
  // entity(), so the walk never enters another project, legacy data or
  // another origin -- not even to come back. A root outside the boundary, or
  // outside the requested memory scope, is answered exactly as a root that does
  // not exist: no node, no relation, and one notice that names nothing. Input
  // is checked before any id is resolved, so a bad request fails the same way
  // for every id.
  function traverse(input = {}) {
    if (typeof input?.id !== 'string' || !input.id) throw new Error('A traversal requires an id');
    const memoryScope = normalizeMemoryScope(input.scope);
    const direction = input.direction ?? 'both';
    if (!['in', 'out', 'both'].includes(direction)) throw new Error('Traversal direction must be in, out, or both');
    const depth = input.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 1 || depth > 10) throw new Error('Traversal depth must be an integer between 1 and 10');
    const boundary = readBoundary(input);
    const reach = (entityId) => {
      const found = entity(entityId, boundary);
      return found && (found.kind !== 'memory' || sameMemoryScopeValues(found.scope, memoryScope)) ? found : undefined;
    };
    const root = reach(input.id);
    if (!root) return scopedResult({ root: input.id, direction, depth, nodes: [], relations: [], limitation: { code: 'scoped_coverage', detail: 'No record with this id is visible in the scope of this traversal.' } }, boundary);
    const seen = new Set([input.id]); const nodes = [clone(extractionView(root, memoryScope))]; const edges = []; let frontier = [input.id];
    for (let level = 0; level < depth && frontier.length; level += 1) {
      const next = [];
      for (const relation of relations.values()) {
        if (input.relation && relation.relation !== input.relation) continue;
        const fromMatch = direction !== 'in' && frontier.includes(relation.from);
        const toMatch = direction !== 'out' && frontier.includes(relation.to);
        if (!fromMatch && !toMatch) continue;
        const targetId = fromMatch ? relation.to : relation.from;
        const target = reach(targetId);
        if (!target) continue;
        if (!edges.some((item) => item.id === relation.id)) edges.push(clone(relation));
        if (!seen.has(targetId)) { seen.add(targetId); next.push(targetId); nodes.push(clone(extractionView(target, memoryScope))); }
      }
      frontier = next;
    }
    return scopedResult({ root: input.id, direction, depth, nodes, relations: edges }, boundary);
  }

  // Both decisions resolve inside the one boundary of this write, so they
  // share an owner; another owner's decision is refused exactly as one that
  // does not exist (P1 finding F-30).
  function supersedeDecision(input = {}) {
    const boundary = writeBoundary(input);
    const previous = decisionIn(boundary, input.decisionId); const replacement = decisionIn(boundary, input.replacementId);
    if (!previous || !replacement) throw new Error('Supersession requires two existing decisions');
    if (previous.id === replacement.id) throw new Error('A decision cannot supersede itself');
    if (previous.status === 'superseded' && previous.supersededBy === replacement.id) return { previous: clone(previous), replacement: clone(replacement), relation: [...relations.values()].find((item) => item.from === replacement.id && item.to === previous.id && item.relation === 'supersedes') ?? null };
    if (['superseded', 'archived'].includes(previous.status) || ['superseded', 'archived', 'abandoned', 'stale'].includes(replacement.status)) throw new Error('Supersession would create an invalid decision chain');
    assertJournalCapacity(3);
    touchMutableObject(previous);
    touchMutableObject(replacement);
    previous.status = 'superseded'; previous.supersededBy = replacement.id; previous.updatedAt = now();
    replacement.supersedes = [...new Set([...(replacement.supersedes ?? []), previous.id])]; replacement.updatedAt = now();
    const relation = addRelation({ from: replacement.id, to: previous.id, relation: 'supersedes' }, replacement.project ?? previous.project ?? null);
    event('decision.superseded', { recordId: previous.id, replacementId: replacement.id });
    const cause = appendJournal({ type: 'decision.superseded', entityKind: 'decision', entityId: previous.id, project: previous.project, payload: clone(previous), provenance: writeProvenance(previous) });
    appendJournal({ type: 'decision.recorded', entityKind: 'decision', entityId: replacement.id, project: replacement.project, payload: clone(replacement), provenance: writeProvenance(replacement), causationId: cause.id });
    return { previous: clone(previous), replacement: clone(replacement), relation };
  }

  // A change named by id acts only inside the write's own boundary (P1 finding
  // F-30); `scope` carries its project or origin.
  function updateDecisionStatus(decisionId, status, scope = {}) {
    const record = decisionIn(writeBoundary(scope), decisionId); if (!record) throw new Error('Decision not found');
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

  function setOutcome(decisionId, outcome, scope = {}) {
    const record = decisionIn(writeBoundary(scope), decisionId); if (!record) throw new Error('Decision not found');
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
    const record = decisionIn(writeBoundary(input), input.decisionId);
    if (!record) throw new Error('Decision not found');
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

  // Delegates to the shared three-valued evaluator. The old body returned a bare
  // boolean, so an unknown operator, a non-numeric value and an unreadable unit
  // all read as `false` -- the same answer as "checked, and this decision is
  // fine". `unknown` is now a distinct verdict that review() reports instead of
  // discarding. See src/condition-eval.js.
  function ruleVerdict(rule, value) {
    return evaluateRule(rule, value);
  }

  // G1: reconsideration must work from persisted state, not only from facts the
  // caller happens to re-supply. Projects one owner's ACTIVE facts into the same
  // { key: value } shape review({ facts }) already accepts, so stored and supplied
  // facts share a single matching path. `inScope` says which facts are that
  // owner's; superseded/expired skipped.
  function storedFactValues(inScope, asOf) {
    const candidates = new Map();
    for (const fact of facts.values()) {
      if (!inScope(fact)) continue;
      // Expiry is a property of the fact, not of whether housekeeping has run
      // yet. maintain() is what flips `status` to expired and stamps validTo,
      // and it may not have run since the boundary passed -- so read-time
      // evaluation asks the canonical policy directly. Without this, context()
      // reported an attempt reusable and the same call after maintain() did not,
      // from identical evidence. The boundary instant itself is already past:
      // `expiresAt` is when the fact stops holding, matching maintain().
      const boundary = effectiveFactExpirationBoundary(fact);
      if (boundary && compareInstants(boundary, asOf) <= 0) continue;
      const temporal = fact.temporal;
      if (temporal) {
        if (temporal.validFrom && compareInstants(temporal.validFrom, asOf) > 0) continue;
        if (temporal.validTo && compareInstants(temporal.validTo, asOf) <= 0) continue;
      } else if (fact.status !== 'active') continue;
      if (!candidates.has(fact.key)) candidates.set(fact.key, []);
      candidates.get(fact.key).push(fact);
    }
    const values = {};
    const sources = {};
    const conflicts = {};
    for (const [key, matches] of candidates) {
      const ordered = [...matches].sort((left, right) => {
        const byValidFrom = compareInstants(right.temporal?.validFrom ?? right.observedAt, left.temporal?.validFrom ?? left.observedAt);
        return byValidFrom !== 0 ? byValidFrom : String(right.id).localeCompare(String(left.id));
      });
      const winner = ordered[0];
      values[key] = winner.value;
      // Provenance of the fact the verdict was actually computed from. Only
      // fields the fact really carries are emitted -- nothing is synthesised.
      sources[key] = factReference(winner);
      // The winner is deterministic and storage behaviour is unchanged, but when
      // several equally applicable facts disagree the winner must not pass
      // itself off as settled evidence. Record the disagreement so a verdict
      // built on it can be reported as contested.
      const disagreeing = ordered.filter((fact) => !Object.is(fact.value, winner.value));
      if (disagreeing.length) conflicts[key] = ordered.map((fact) => factReference(fact));
    }
    return { values, sources, conflicts };
  }

  // A fact reference carries only what the fact actually recorded. Absent fields
  // are omitted rather than defaulted, so a reader can never mistake a filled-in
  // blank for an observation.
  function factReference(fact) {
    const reference = { factId: fact.id, value: fact.value };
    const observedAt = fact.observedAt ?? fact.temporal?.recordedAt;
    if (observedAt != null) reference.observedAt = observedAt;
    if (fact.temporal?.validFrom != null) reference.validFrom = fact.temporal.validFrom;
    if (fact.sourceClass != null) reference.sourceClass = fact.sourceClass;
    if (fact.verificationStatus != null) reference.verificationStatus = fact.verificationStatus;
    return reference;
  }

  // One evaluated condition, explained. Used for both breaches and unresolved
  // conditions so a caller reads the same shape either way.
  //
  // Every field is detached on the way out by detachDetail(). `expected`,
  // `operator`, `key` and `unit` come from the stored rule and
  // `observed`/`evidence`/`conflictingEvidence` from the stored fact, so without
  // this a caller holding a returned detail could reach straight into a rule or
  // a fact and edit it -- with no journal entry, and with a rebuild silently
  // putting the old value back.
  function conditionDetail(record, alternative, rule, evaluation, stored, callerSupplied) {
    const detail = {
      decisionId: record.id,
      alternativeId: alternative.id,
      alternativeLabel: alternative.label,
      key: rule.key ?? null,
      operator: evaluation.operator,
      expected: evaluation.expected,
      observed: evaluation.actual,
      verdict: evaluation.verdict,
      reason: evaluation.reason
    };
    if (rule.unit != null) detail.unit = rule.unit;
    if (callerSupplied) detail.evidence = { source: 'caller_supplied' };
    else if (stored.sources[rule.key]) detail.evidence = { source: 'stored_fact', ...stored.sources[rule.key] };
    if (!callerSupplied && stored.conflicts[rule.key]) detail.conflictingEvidence = stored.conflicts[rule.key];
    return detachDetail(detail);
  }

  // Find a pre-coverage signal on this decision whose recorded breaches
  // reconstruct to exactly `coverage`. Returns null when none does, which is the
  // answer whenever history is missing, partial, ambiguous, or a different set.
  //
  // The signal is returned, not moved or modified: it keeps its stored key, id,
  // status and acknowledgedAt, so the historical record stays intact and a later
  // reconstruction reaches the same conclusion. Candidates are ordered by id so
  // the choice does not depend on import order.
  function legacySignalCovering(decisionId, coverage) {
    const candidates = [...reviewSignals.values()]
      .filter((signal) => signal.decisionId === decisionId && signal.coverage === undefined)
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    return candidates.find((signal) => sameCoverage(reconstructedCoverage(signal), coverage)) ?? null;
  }

  // Evaluates every current decision and returns both the decisions that are due
  // for review AND the conditions that could not be settled.
  //
  // The second half matters as much as the first: a decision with only unknown
  // or contested conditions produces no `due` entry and therefore no review
  // signal, so before this existed that uncertainty was indistinguishable from
  // a clean pass. `diagnostics` carries it out instead. A diagnostic is NOT a
  // review signal -- it claims neither a breach nor a confirmed-safe decision.
  // The two options below are INTERNAL. Neither is routed through
  // validateReviewInput(), so review()'s accepted input, its return shape, and
  // the diagnostics context()/maintain() publish are untouched by their
  // existence.
  //
  //   onlyDecisionId  restrict the pass to one decision, so a focused
  //                   reconsider() cannot raise a review signal for a decision
  //                   the caller did not ask about.
  //   collectGrounded also keep what this pass already computes and then drops:
  //                   the conditions that were genuinely FALSE, and the matches
  //                   with no structured rule behind them. Off by default, so
  //                   review(), context() and maintain() pay nothing for it and
  //                   publish nothing new.
  //   visible         REQUIRED. The read boundary of the request: only the
  //                   decisions and facts it admits are evaluated, so no
  //                   review, reconsideration, maintenance or context ever
  //                   reviews, or cites the facts of, another owner (P1
  //                   findings F-06, F-31).
  function evaluateReview(context = {}, { onlyDecisionId, collectGrounded = false, visible, persistSignals = true } = {}) {
    if (typeof visible !== 'function') throw new Error('evaluateReview() requires the boundary of the request it serves');
    const prepared = validateReviewInput(context);
    const changed = new Set(prepared.changedFacts); const due = []; const diagnostics = []; const explained = [];
    const reviewAt = prepared.asOf ?? now();
    // The stored facts the request can see, and the facts known with the
    // caller's on top, are the same for every decision it reviews: they are
    // built once, on the first decision, not once each.
    let stored, knownFacts;
    for (const record of records.values()) {
      if (record.kind !== 'decision') continue;
      if (onlyDecisionId !== undefined && record.id !== onlyDecisionId) continue;
      if (['archived', 'superseded', 'abandoned'].includes(record.status)) continue;
      if (!visible(record)) continue;
      const matches = [];
      // Renamed from `reconsider` so it cannot be misread as the public
      // reconsider() defined below. It holds alternative labels, nothing else.
      const reconsiderLabels = new Set();
      const violatedConditions = [];
      const unresolved = [];
      // Populated only under collectGrounded. `settled` holds the conditions
      // that definitely did NOT fire, and `unruled` the causes that are not
      // rules at all, so a caller can be shown WHY nothing changed instead of
      // being handed an empty list that proves nothing.
      const settled = [];
      const unruled = [];
      // What this decision's review signal would actually cover. `matches` is a
      // human-readable reason list and collapses duplicates -- two thresholds on
      // one fact key both read as that key -- so it cannot serve as identity.
      const coverage = new Set();
      // Precedence: caller-supplied `facts` override stored facts of the same key,
      // preserving the pre-existing call-argument contract. String rules keep
      // matching `changedFacts` only: that list is an ephemeral "these just
      // changed" signal, whereas facts are durable state, so feeding state into it
      // would make every decision due forever.
      stored ??= storedFactValues(visible, reviewAt);
      knownFacts ??= { ...stored.values, ...prepared.facts };
      for (const alternative of record.alternatives) for (const rule of alternative.reopenWhen) {
        if (typeof rule === 'string') {
          if (changed.has(rule)) {
            matches.push(rule); reconsiderLabels.add(alternative.label);
            coverage.add(conditionCoverageId(rule, null));
            if (collectGrounded) unruled.push({ cause: rule, kind: 'changed_fact_token', alternativeId: alternative.id, alternativeLabel: alternative.label });
          } else {
            // NOT a pass. A token rule matches `changedFacts` only -- durable
            // facts are deliberately never fed into that list -- so when the
            // caller supplies nothing, there is no evidence either way. This
            // was the last silent path on the reopen side: the condition
            // produced neither a breach nor a diagnostic, which is
            // indistinguishable from "checked, and this decision is fine". The
            // text is reported verbatim and never interpreted, exactly as
            // reusableWhen already treats legacy free text. It stays out of
            // `matches` and `coverage`, so it raises no review signal and
            // changes no signal identity.
            unresolved.push(conditionDetail(record, alternative, { key: null }, {
              operator: null, expected: rule, actual: undefined, verdict: 'unknown',
              reason: 'Legacy string condition this evaluator cannot settle from stored facts'
            }, stored, false));
          }
          continue;
        }
        if (!rule || typeof rule !== 'object') continue;
        const callerSupplied = Object.prototype.hasOwnProperty.call(prepared.facts, rule.key);
        if (!Object.prototype.hasOwnProperty.call(knownFacts, rule.key)) {
          // No evidence for this key at all. Not a breach, and not a pass.
          unresolved.push(conditionDetail(record, alternative, rule,
            { operator: rule.operator ?? 'equals', expected: rule.value, actual: undefined, verdict: 'unknown', reason: 'No fact recorded for this key' },
            stored, callerSupplied));
          continue;
        }
        const evaluation = ruleVerdict(rule, knownFacts[rule.key]);
        const detail = conditionDetail(record, alternative, rule, evaluation, stored, callerSupplied);
        if (evaluation.verdict === 'true') {
          matches.push(rule.key); reconsiderLabels.add(alternative.label);
          coverage.add(conditionCoverageId(alternative, rule));
          violatedConditions.push(detail);
          // A breach still fires when the evidence behind it is contested --
          // suppressing it would hide the very thing worth looking at -- but the
          // contest travels with it.
          if (detail.conflictingEvidence) unresolved.push(detail);
        } else if (evaluation.verdict === 'unknown') {
          unresolved.push(detail);
        } else {
          if (detail.conflictingEvidence) {
            // A "no review needed" resting on facts that disagree is exactly the
            // silent pass this reports.
            unresolved.push(detail);
          }
          // A genuinely false condition. The review path drops it, because
          // review() reports breaches; it is kept here so that `unchanged` can
          // be shown to rest on something rather than on an empty list.
          //
          // Contested evidence is excluded deliberately. A false verdict whose
          // facts disagree is already reported as contested, and listing it
          // here as well would describe disputed evidence as a grounded
          // negative -- the same condition counted once as "we checked, and it
          // is fine" and once as "we cannot settle this". It is one or the
          // other, never both.
          if (collectGrounded && !detail.conflictingEvidence) settled.push(detail);
        }
      }
      if (record.reviewAfter && compareInstants(record.reviewAfter, reviewAt) <= 0) {
        matches.push('review date reached');
        coverage.add(conditionCoverageId('review date reached', null));
        if (collectGrounded) unruled.push({ cause: 'review date reached', kind: 'review_date' });
      }
      if (record.outcome?.status === 'failed') {
        matches.push('decision outcome failed');
        coverage.add(conditionCoverageId('decision outcome failed', null));
        if (collectGrounded) unruled.push({ cause: 'decision outcome failed', kind: 'outcome_failed' });
      }
      if (matches.length) {
        // detachDetail() covers the wrapper too: `title` and the alternative
        // labels are stored record fields, and a lenient import can have made
        // either of them an object. `violatedConditions` holds details that are
        // already detached, so it is left alone rather than cloned twice.
        const entry = detachDetail({
          decisionId: record.id, title: record.title,
          reason: [...new Set(matches)].join(', '),
          alternativesToReconsider: reconsiderLabels.size ? [...reconsiderLabels] : record.alternatives.map((item) => item.label),
          coverage: [...coverage].sort()
        });
        entry.violatedConditions = violatedConditions;
        due.push(entry);
      }
      if (unresolved.length) {
        const entry = detachDetail({ decisionId: record.id, title: record.title });
        entry.conditions = unresolved;
        diagnostics.push(entry);
      }
      // One bundle per decision in scope, whether or not anything fired, so a
      // decision with nothing to report is visibly present rather than absent
      // for an unstated reason. `unruled` is detached because its causes carry
      // stored record text; `conditions` holds details conditionDetail() has
      // already detached.
      if (collectGrounded) {
        const entry = detachDetail({ decisionId: record.id, title: record.title, unruled });
        entry.conditions = settled;
        explained.push(entry);
      }
    }
    for (const item of due) {
      // Signal identity is (decisionId, reason, coverage). An acknowledgement
      // survives re-evaluation of the SAME breach set, and a breach set that
      // grows -- a second, stricter alternative on the same fact key starting to
      // fire -- gets its own open signal rather than inheriting the old one.
      //
      // Backward compatibility, explicitly: a signal persisted before coverage
      // existed carries no `coverage` field, so its scope is not stated. It is
      // left exactly as stored -- never rewritten, never re-keyed, never
      // deleted -- and is matched to a current breach set only when its own
      // recorded `violatedConditions` reconstruct to precisely that set. See
      // reconstructedCoverage().
      //
      // An earlier version stamped the CURRENT coverage onto such a signal so
      // the new lookup would find it. That silently widened the acknowledgement:
      // an ack of `lag >= 500` alone came to cover `lag >= 1000` as well the
      // moment the stricter alternative started breaching. An acknowledgement
      // may only cover what it can be shown to have covered; where history is
      // missing, partial or ambiguous the current breach set is OPEN and visible.
      const key = reviewSignalKey(item.decisionId, item.reason, item.coverage);
      let signal = reviewSignals.get(key);
      if (!signal) signal = legacySignalCovering(item.decisionId, item.coverage);
      if (!signal && persistSignals) {
        signal = { id: id('review'), kind: 'review', ...clone(item), status: 'open', createdAt: now() };
        reviewSignals.set(key, signal);
      }
      // The identifier travels with the entry. A compact client lists reviews
      // through context() and has no other advertised route to the signal, so
      // without this it could reach the acknowledge tool but never name what to
      // acknowledge. `status` comes along because `due` is recomputed from
      // current evidence on every call and does not drop an acknowledged item,
      // so a caller needs to see which ones are already handled.
      if (signal) { item.reviewSignalId = signal.id; item.reviewSignalStatus = signal.status; }
      else item.reviewSignalStatus = 'unpersisted';
      // Coverage is signal identity, and it is persisted on the signal where a
      // caller can read it through shadowgraph_review_signals. On a due entry it
      // would be redundant with violatedConditions and pure wire weight, so it
      // does not travel there.
      delete item.coverage;
    }
    return { due, diagnostics, explained };
  }

  function evaluateForRead(input, boundary, { persistSignals = true, ...options } = {}) {
    // Own-scope evaluation persists unless the caller asks for a pure read (the
    // default-path read, plan v1.4.4 §13.1). A wider evaluation can read more
    // evidence, but never persists signals, even for an own decision using
    // newly granted foreign evidence.
    if (persistSignals && boundary.scope.grant) evaluateReview(input, { ...options, visible: boundary.baseVisible });
    return evaluateReview(input, { ...options, visible: boundary.visible, persistSignals: persistSignals && !boundary.scope.grant });
  }

  // Due entries keep their content; the serializable envelope declares the
  // request boundary even when no decision can be evaluated.
  function review(context = {}) {
    const boundary = readBoundary(context);
    const due = evaluateForRead(context, boundary).due;
    return scopedItems(due, boundary, referencedSignals(boundary, due));
  }

  // What an operation that evaluated nothing says about itself (P1 finding
  // F-06): it had no project and no origin, so it read and changed nothing.
  function reachesNothing(boundary) {
    return boundary.scope.state !== 'project_selected' && boundary.scope.originId === null && !boundary.scope.grant;
  }
  const UNRESOLVED_OPERATION = Object.freeze({ code: 'scoped_coverage', detail: 'No project and no origin was given, so nothing was evaluated or changed.' });

  // Which observations a verdict was computed from, named once each. A detail
  // already carries its evidence inline; this lifts it to the decision so a
  // caller can see the whole basis without walking every condition. Caller
  // supplied values carry no fact id, so they are keyed by the rule key they
  // answered.
  function factsConsideredFrom(details) {
    const seen = new Map();
    for (const detail of details) {
      if (detail.evidence?.source === 'stored_fact') {
        if (!seen.has(detail.evidence.factId)) seen.set(detail.evidence.factId, { key: detail.key, ...detail.evidence });
      } else if (detail.evidence?.source === 'caller_supplied') {
        // A supplied value has no fact id, so it is named by the rule key it
        // answered. The prefix keeps it from colliding with a stored fact id.
        const suppliedName = `caller_supplied:${detail.key}`;
        if (!seen.has(suppliedName)) seen.set(suppliedName, { key: detail.key, source: 'caller_supplied', value: detail.observed });
      }
      // The verdict was computed from the winner, but every disagreeing
      // observation is part of what was considered and is named as such.
      for (const conflict of detail.conflictingEvidence ?? []) {
        if (!seen.has(conflict.factId)) seen.set(conflict.factId, { key: detail.key, source: 'stored_fact', ...conflict });
      }
    }
    return [...seen.values()];
  }

  /**
   * Reconsideration: a PROJECTION of evaluateReview(), never a second
   * evaluation.
   *
   * review() and reconsider() cannot disagree about whether a stored rule
   * fires, does not fire, or cannot be evaluated, because there is one pass,
   * one evaluator (src/condition-eval.js) and one set of verdicts. A second
   * operator table here is the specific defect this design exists to make
   * impossible: a rule using an operator one side understood and the other did
   * not would report `unchanged` with complete confidence on one route while
   * the other reported a breach.
   *
   * What this adds is the reading a caller needs in order to act -- a top-level
   * verdict, whether the evaluation was complete, and the evidence behind all
   * three outcomes, including the conditions that were genuinely false so that
   * `unchanged` is grounded rather than vacuous.
   *
   * It writes no decision status, no confidence and no lifecycle state. It can
   * open a review signal, by exactly the path and identity review() uses, so
   * calling it twice settles on one signal rather than two.
   */
  function reconsider(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('reconsider input must be an object');
    const boundary = readBoundary(input);
    let onlyDecisionId;
    if (input.decisionId !== undefined && input.decisionId !== null) {
      // Fail closed. An unaddressable decision must never read as a grounded
      // negative: an empty `unchanged` / `complete` for a typo'd id, or for an
      // id outside the request's scope, is indistinguishable from "checked,
      // and this decision is fine" -- the exact confusion three-valued
      // evaluation exists to prevent. So each of these is an error, never a
      // quiet empty result. An id outside the scope -- another project's,
      // legacy data's, another origin's, or any id when no scope was given --
      // is refused exactly as one that exists nowhere (P1 finding F-31).
      if (typeof input.decisionId !== 'string' || !input.decisionId.trim()) throw new Error('decisionId must be a non-empty string');
      const record = decisionIn(boundary, input.decisionId);
      if (!record) throw new Error('Decision not found');
      if (['archived', 'superseded', 'abandoned'].includes(record.status)) throw new Error(`Decision is not open for reconsideration (status ${record.status})`);
      onlyDecisionId = record.id;
    }
    const evaluated = evaluateForRead({
      ...(input.changedFacts === undefined ? {} : { changedFacts: input.changedFacts }),
      ...(input.facts === undefined ? {} : { facts: input.facts }),
      ...(input.asOf === undefined ? {} : { asOf: input.asOf })
    }, boundary, { onlyDecisionId, collectGrounded: true });

    const byDecision = new Map();
    const entryFor = (decisionId, title) => {
      let entry = byDecision.get(decisionId);
      if (!entry) {
        entry = {
          decisionId, title,
          verdict: 'unchanged', evaluationCompleteness: 'complete',
          triggeredRules: [], triggeredBy: [], groundedConditions: [],
          rulesNotEvaluated: [], contestedConditions: [],
          affectedAlternatives: [], factsConsidered: []
        };
        byDecision.set(decisionId, entry);
      }
      return entry;
    };
    // Seed from `explained` first: it carries every decision in scope, so one
    // that neither fired nor raised a diagnostic is still visibly present
    // rather than absent for an unstated reason.
    for (const item of evaluated.explained) {
      const entry = entryFor(item.decisionId, item.title);
      entry.groundedConditions = item.conditions;
      entry.triggeredBy = item.unruled;
    }
    for (const item of evaluated.due) {
      const entry = entryFor(item.decisionId, item.title);
      entry.triggeredRules = item.violatedConditions;
      entry.affectedAlternatives = item.alternativesToReconsider;
      entry.reviewSignalId = item.reviewSignalId;
      entry.reviewSignalStatus = item.reviewSignalStatus;
    }
    for (const item of evaluated.diagnostics) {
      const entry = entryFor(item.decisionId, item.title);
      entry.rulesNotEvaluated = item.conditions.filter((condition) => condition.verdict === 'unknown');
      // Decided, but on observations that disagree. Reported apart from
      // `rulesNotEvaluated` because the evaluator DID reach a verdict here, and
      // calling that unevaluated would overstate it. It still withholds
      // completeness: a pass resting on contested facts is exactly the silent
      // pass the review-conditions contract exists to prevent.
      entry.contestedConditions = item.conditions.filter((condition) => condition.conflictingEvidence && condition.verdict !== 'unknown');
    }
    for (const entry of byDecision.values()) {
      entry.factsConsidered = factsConsideredFrom([
        ...entry.triggeredRules, ...entry.groundedConditions, ...entry.rulesNotEvaluated, ...entry.contestedConditions
      ]);
      const incomplete = entry.rulesNotEvaluated.length > 0 || entry.contestedConditions.length > 0;
      entry.evaluationCompleteness = incomplete ? 'partial' : 'complete';
      // A definite trigger outranks uncertainty: the mixed case is
      // `review_recommended` AND `partial`, so neither the breach nor the
      // unevaluated condition is hidden by the other.
      entry.verdict = entry.triggeredRules.length || entry.triggeredBy.length
        ? 'review_recommended'
        : incomplete ? 'manual_review' : 'unchanged';
    }
    const decisions = [...byDecision.values()];
    // With no project and no origin nothing was evaluated, and that must not
    // read as "unchanged, complete" -- the same silent pass failing closed
    // exists to prevent. It is reported as not settled, and why.
    if (reachesNothing(boundary)) {
      return scopedResult({ verdict: 'manual_review', evaluationCompleteness: 'partial', scope: { project: null, decisionId: null }, decisions, limitation: { ...UNRESOLVED_OPERATION } }, boundary);
    }
    return scopedResult({
      verdict: decisions.some((item) => item.verdict === 'review_recommended') ? 'review_recommended'
        : decisions.some((item) => item.verdict === 'manual_review') ? 'manual_review'
          : 'unchanged',
      evaluationCompleteness: decisions.some((item) => item.evaluationCompleteness === 'partial') ? 'partial' : 'complete',
      scope: { project: boundary.scope.project, decisionId: onlyDecisionId ?? null },
      decisions
    }, boundary, referencedSignals(boundary, decisions));
  }

  // Evaluates `attempts[].reusableWhen`, the field that has been normalised and
  // persisted since schema 4 with nothing ever reading it.
  //
  // Combination is ALL, not any: "this may be worth trying again" is a positive
  // claim about every precondition, unlike reopenWhen where any single breach is
  // reason enough to look again. An unresolved or contested condition blocks the
  // claim outright -- uncertainty must never read as permission to retry.
  //
  // A satisfied condition means the attempt MAY be reconsidered. It does not
  // erase the recorded failure, and it does not authorise a retry.
  function evaluateAttemptReuse(inScope, reviewAt, suppliedFacts) {
    const stored = storedFactValues(inScope, reviewAt);
    const knownFacts = { ...stored.values, ...suppliedFacts };
    const reusable = []; const diagnostics = [];
    for (const record of records.values()) {
      if (record.kind !== 'attempt' || !inScope(record) || extractionView(record).derivationState === 'superseded') continue;
      // An attempt whose outcome is undetermined (PR-24) is not a failure that
      // may be reconsidered: it is in no collection and is only counted.
      if (attemptOutcome(record) === 'undetermined') continue;
      // Every stored condition counts, including the legacy free-text form.
      // Filtering those out made an ALL decision over a SUBSET: an attempt with
      // one unprovable prose condition and one satisfied structured condition
      // read as fully reusable, which is the opposite of what the text says.
      // The text is never interpreted and never rewritten -- this evaluator has
      // no way to settle it, so it says so.
      const rules = record.reusableWhen ?? [];
      if (!rules.length) continue;
      const satisfied = []; const unresolved = [];
      for (const rule of rules) {
        if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
          unresolved.push(attemptConditionDetail(record, { key: null }, {
            operator: null, expected: rule, actual: undefined, verdict: 'unknown',
            reason: 'Legacy free-text condition this evaluator cannot verify'
          }, stored, false));
          continue;
        }
        const callerSupplied = Object.prototype.hasOwnProperty.call(suppliedFacts, rule.key);
        const evaluation = Object.prototype.hasOwnProperty.call(knownFacts, rule.key)
          ? ruleVerdict(rule, knownFacts[rule.key])
          : { operator: rule.operator ?? 'equals', expected: rule.value, actual: undefined, verdict: 'unknown', reason: 'No fact recorded for this key' };
        const detail = attemptConditionDetail(record, rule, evaluation, stored, callerSupplied);
        if (evaluation.verdict === 'true') satisfied.push(detail);
        if (evaluation.verdict !== 'false' || detail.conflictingEvidence) {
          if (evaluation.verdict !== 'true' || detail.conflictingEvidence) unresolved.push(detail);
        }
      }
      if (satisfied.length === rules.length && !unresolved.length) {
        const entry = detachDetail({ attemptId: record.id, solution: record.solution, resultClass: record.resultClass ?? null });
        entry.satisfiedConditions = satisfied;
        reusable.push(entry);
      }
      if (unresolved.length) diagnostics.push({ attemptId: record.id, conditions: unresolved });
    }
    return { reusable, diagnostics };
  }

  // Detached on the way out for the same reason conditionDetail() is.
  function attemptConditionDetail(attempt, rule, evaluation, stored, callerSupplied) {
    const detail = {
      attemptId: attempt.id,
      key: rule.key ?? null,
      operator: evaluation.operator,
      expected: evaluation.expected,
      observed: evaluation.actual,
      verdict: evaluation.verdict,
      reason: evaluation.reason
    };
    if (rule.unit != null) detail.unit = rule.unit;
    if (callerSupplied) detail.evidence = { source: 'caller_supplied' };
    else if (stored.sources[rule.key]) detail.evidence = { source: 'stored_fact', ...stored.sources[rule.key] };
    if (!callerSupplied && stored.conflicts[rule.key]) detail.conflictingEvidence = stored.conflicts[rule.key];
    return detachDetail(detail);
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
    // Maintenance ages, expires and reviews only what the request's scope owns
    // (P1 finding F-06), so time-based ageing happens per project, when that
    // project is maintained. With no project and no origin it changes nothing.
    const boundary = readBoundary(input);
    if (reachesNothing(boundary)) return scopedResult({ at, staleDecisionIds: [], agedDecisionIds: [], reviewSignals: [], due: [], diagnostics: [], limitation: { ...UNRESOLVED_OPERATION } }, boundary);
    const decisionsToStale = [...records.values()].filter((record) => (
      record.kind === 'decision'
      && boundary.baseVisible(record)
      && record.reviewAfter
      && compareInstants(record.reviewAfter, at) <= 0
      && CURRENT_DECISION_STATUSES.includes(record.status)
    ));
    const factsToExpire = [...facts.values()].filter((fact) => {
      const expirationBoundary = effectiveFactExpirationBoundary(fact);
      return boundary.baseVisible(fact) && fact.status === 'active' && expirationBoundary && compareInstants(expirationBoundary, at) <= 0;
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
    const { due, diagnostics } = evaluateForRead(reviewInput, boundary);
    const signals = scopedView(boundary).reviewSignals.map(clone);
    return scopedResult({ at, staleDecisionIds, agedDecisionIds: [...staleDecisionIds], reviewSignals: signals, due, diagnostics }, boundary, signals);
  }

  // The review signals of the request's scope (P1 reconciliation F-04).
  function reviewSignalView(signal, boundary) {
    const decision = decisionIn(boundary, signal.decisionId);
    if (!decision || !['superseded', 'archived', 'abandoned'].includes(decision.status)) return clone(signal);
    const replacement = decision.supersededBy && decisionIn(boundary, decision.supersededBy);
    return { ...clone(signal), historical: true, decisionState: decision.status, ...(replacement ? { supersededBy: replacement.id } : {}) };
  }

  function getReviewSignals(input = {}) {
    const boundary = readBoundary(input);
    const items = scopedView(boundary).reviewSignals.filter((item) => !input.status || item.status === input.status).map(item => reviewSignalView(item, boundary));
    return scopedItems(items, boundary, items);
  }

  function referencedSignals(boundary, items) {
    const ids = new Set(items.map((item) => item.reviewSignalId));
    return scopedView(boundary).reviewSignals.filter((signal) => ids.has(signal.id));
  }
  // A signal's own fields: its decision's and its lifecycle's. Its conditions
  // carry the facts it was evaluated on.
  const SIGNAL_OWN_FIELDS = ['id', 'kind', 'decisionId', 'title', 'reason', 'alternativesToReconsider', 'coverage', 'status', 'createdAt', 'acknowledgedAt'];

  function acknowledgeReview(signalId, scope = {}) {
    const boundary = writeBoundary(scope);
    const item = [...reviewSignals.values()].find((candidate) => candidate.id === signalId && decisionIn(boundary, candidate.decisionId));
    if (!item) throw new Error('Review signal not found');
    touchMutableObject(item); item.status = 'acknowledged'; item.acknowledgedAt = now();
    // The decision is the caller's, so the acknowledgement is too; the answer is
    // a read. A build before PR-10 chose review evidence by project label, so a
    // stored signal can cite a fact outside the decision's boundary; its
    // conditions are then not returned, and what is stored stays as it was
    // (P1 findings F-16, F-30).
    if (scopedView(boundary).reviewSignals.includes(item)) return clone(item);
    return {
      ...Object.fromEntries(SIGNAL_OWN_FIELDS.filter((key) => item[key] !== undefined).map((key) => [key, clone(item[key])])),
      limitation: { code: 'scoped_coverage', detail: 'This signal cites evidence outside this scope, so its conditions are not shown. It is acknowledged; what is stored is unchanged.' }
    };
  }

  function redact(input = {}) {
    const boundary = readBoundary(input);
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
    // Redaction must see everything it could have to redact, so its input is the
    // privileged snapshot (plan v1.4.4 §11.2 step 3); only its output is a read.
    // What the output holds is chosen by the request's boundary, exactly as for
    // every other read (scopedView): with no project and no origin it holds
    // nothing, and it never names an id outside the scope (P1 reconciliation
    // F-16). The caller's rules never see an erasureToken.
    const data = publicValue(liveSnapshot());
    const view = scopedView(boundary);
    const chosen = (items) => new Set(items.map((item) => item.id));
    const [recordIds, factIds, relationIds] = [view.records, view.facts, view.relations].map(chosen);
    // The snapshot's events and journal are copies of the live arrays, in order.
    const [eventsKept, entriesKept] = [new Set(view.events), new Set(view.journal)];
    data.records = data.records.filter((item) => recordIds.has(item.id));
    data.facts = data.facts.filter((item) => factIds.has(item.id));
    data.relations = data.relations.filter((item) => relationIds.has(item.id));
    data.reviewSignals = view.reviewSignals.map(clone);
    data.idempotency = data.idempotency.filter((item) => recordIds.has(item.value?.id) || factIds.has(item.value?.id)).map((item) => ({ ...item, key: replacement }));
    data.events = data.events.filter((item, index) => eventsKept.has(events[index]));
    data.journal = data.journal.filter((item, index) => entriesKept.has(journal[index]));
    // B-4: the journal payload is redacted like every other surface. A secret must
    // not survive in the audit trail just because it was also written there. A
    // projection baseline holds the whole store, so no scoped view carries one,
    // and redaction has no baseline to rewrite.
    const transformed = transform(data);
    // The output is a read: collections this build cannot interpret stay out of
    // it (plan v1.4.4 §10.9.6).
    for (const key of Object.keys(transformed)) if (!NATIVE_STORE_KEYS.includes(key)) delete transformed[key];
    // And it says so, stamped after every pattern and replacement has run, so
    // none can remove or alter it: no import, save or restore takes a scoped
    // redaction for a store (finding F-36).
    for (const key of ['revision', 'journalSeq', 'journalEpoch']) delete transformed[key];
    const result = scopedResult({ exportKind: REDACTION_EXPORT_KIND, ...transformed, completeness: {
      complete: true, losslessItems: false,
      limitation: { code: 'scoped_coverage', detail: 'Only a redacted view of this scope. This transformed output is not a complete store and cannot be imported, saved or restored.' }
    } }, boundary, view.reviewSignals);
    // Coverage describes the real boundary, but a redacted view must not echo
    // its label after the body policy has run (including collection masking).
    // Withhold it explicitly; neither null nor a replacement selects a scope.
    result.completeness.scope.project = null;
    result.completeness.scope.projectLabelWithheld = boundary.scope.state === 'project_selected';
    return result;
  }

  function projectPurgeSelection(project) {
    if (typeof project !== 'string' || !project.trim()) throw new Error('A project name is required');
    const recordsForProject = [...records.values()].filter((item) => ownedByProject(item, project));
    const capturesForProject = [...captures.values()].filter((item) => ownedByProject(item, project));
    const factsForProject = [...facts.values()].filter((item) => ownedByProject(item, project));
    const ids = new Set(recordsForProject.map((item) => item.id));
    for (const record of recordsForProject) for (const alternative of record.alternatives ?? []) ids.add(alternative.id);
    for (const fact of factsForProject) ids.add(fact.id);
    for (const item of capturesForProject) ids.add(item.id);
    const relationIds = new Set([...relations.values()].filter((item) => ids.has(item.from) || ids.has(item.to)).map((item) => item.id));
    const referencesRemoved = (item) => {
      const entityId = item.entityId ?? item.recordId ?? item.factId;
      const relationId = item.relationId ?? (item.entityKind === 'relation' ? entityId : null);
      if (relationId) return relationIds.has(relationId) || (!relations.has(relationId) && item.project === project && project !== 'default');
      if (entityId) {
        if (ids.has(entityId)) return true;
        if (rawEntity(entityId) || captures.has(entityId)) return false;
      }
      if (item.type === 'project.purged') return item.project === project;
      // Capture's refusal entry names its project and nothing else, and only
      // this build writes it: it is never a legacy breadcrumb (PR-36b).
      if (item.type === CAPTURE_REFUSED_EVENT) return item.project === project;
      // An unreferenced legacy "default" breadcrumb cannot establish ownership.
      return item.payload ? ownedByProject(item.payload, project) : item.project === project && project !== 'default';
    };
    const removedEvents = new Set(events.filter(referencesRemoved));
    // The runtime miss ledger's entries recorded in the project, or naming an
    // entity it removes, go with it (PR-28a).
    const misses = Array.isArray(extras.get(RUNTIME_MISSES)) ? extras.get(RUNTIME_MISSES) : [];
    const removedEntityIds = new Set([...ids, ...relationIds]);
    const reachesMiss = (entry) => missReachedBy(entry, project, removedEntityIds);
    // Capture's own collections: the entries the project owns, and the content
    // a capture it removes names (PR-33).
    const removedContentRefs = new Set(capturesForProject.map((item) => item.contentRef).filter(Boolean));
    const reachesCaptureEntry = (entry) => captureEntryReachedBy(entry, project, removedContentRefs);
    // Capture's counts, of live memory as every other count is (PR-37d design
    // §6.1, FND-P6-02); and apart from them the project's records, captures and
    // facts deletion records hold out of it, which a purge removes too (R5 L1
    // VS1): counts only, never in the marker.
    const reached = (name) => (Array.isArray(extras.get(name)) ? extras.get(name) : []).filter(reachesCaptureEntry).length;
    const held = deletion.get('held')?.collections ?? {};
    const withheld = ['records', 'captures', 'facts'].flatMap((name) => held[name]?.items ?? []).filter(([, item]) => ownedByProject(item, project)).length;
    // `entities`: what a purge's tombstone names by token (PR-37d design §1.2).
    return { ids, relationIds, removedEvents, referencesRemoved, reachesMiss, reachesCaptureEntry, entities: [...recordsForProject, ...capturesForProject, ...factsForProject], summary: { project, records: recordsForProject.length, facts: factsForProject.length, relations: relationIds.size, events: removedEvents.size, journal: journal.filter(referencesRemoved).length, runtimeMisses: misses.filter(reachesMiss).length, captures: capturesForProject.length, captureContent: reached(CAPTURE_CONTENT), captureSessions: reached(CAPTURE_SESSIONS), withheld } };
  }

  function projectSummary(project) {
    return projectPurgeSelection(project).summary;
  }

  // G5: `mode` defaults to a LOGICAL purge. Content is removed and an auditable
  // skeleton remains, so a rebuild does not resurrect purged data and the history
  // that a purge happened survives. `hard` physically removes journal entries,
  // which creates a seq gap — declared by validate(), never hidden. This is why
  // the journal is documented as append-ORIENTED, never append-only.
  // A purge reaches W too (PC-14; design §11 R-10): W is put back, the purge
  // runs on the store as it would with no view, and W is held again from what
  // is left. Its result and its marker count what it removed from live memory
  // (review K-2, C-6); only a hard purge's journal positions, which its marker
  // must name for the store's gaps to be explained, include W's (declared).
  function purgeProject(project, purgeOptions = {}) {
    if (!deletion.has('held')) return purgeLive(project, purgeOptions);
    const live = projectPurgeSelection(project);
    const idempotencyRemoved = [...idempotency.values()].filter((value) => live.ids.has(value?.id)).length;
    // What a logical purge of the live graph alone redacts: W's entries are
    // skeletons there already.
    const journalEntriesRedacted = journal.filter((item) => !(item.type === 'project.purged' && item.project === project && item.payload?.mode === 'hard')
      && live.referencesRemoved(item) && (item.payload !== null || item.redacted !== true)).length;
    unhold();
    const result = purgeLive(project, purgeOptions);
    journal.find((entry) => entry.id === result.journalEntryId).payload.removed = live.ids.size;
    hold();
    return { ...result, ...live.summary, removed: live.ids.size, idempotencyRemoved, ...(result.mode === 'logical' ? { journalEntriesRedacted } : {}) };
  }

  function purgeLive(project, purgeOptions = {}) {
    const mode = purgeOptions.mode ?? (purgeOptions.hard === true ? 'hard' : 'logical');
    if (!['logical', 'hard'].includes(mode)) throw new Error('Purge mode must be logical or hard');
    const { summary, ids: removed, relationIds: removedRelationIds, removedEvents: eventsToRemove, referencesRemoved, reachesMiss, reachesCaptureEntry, entities } = projectPurgeSelection(project);
    const idempotencyKeysToRemove = [...idempotency]
      .filter(([, value]) => removed.has(value?.id))
      .map(([key]) => key);

    // Stage every journal rewrite and fully validate the marker before touching any
    // live collection. In particular, sequence overflow must leave records, facts,
    // relations, events, idempotency, and the original journal byte-for-byte equal.
    const stagedJournal = clone(journal);
    let journalEntriesRedacted = 0;
    let journalEntriesRemoved = 0;
    // The earlier markers of the project a hard purge splices (PR-37d §2.4).
    const splicedMarkers = new Set();
    const removedJournalSequences = mode === 'hard'
      ? stagedJournal
        .filter((item) => item.type === 'project.purged' && item.project === project && item.payload?.mode === 'hard')
        .flatMap((item) => Array.isArray(item.payload?.removedJournalSequences) ? item.payload.removedJournalSequences.filter(Number.isInteger) : [])
      : [];
    if (mode === 'hard') {
      for (let index = stagedJournal.length - 1; index >= 0; index -= 1) {
        const item = stagedJournal[index];
        if (referencesRemoved(item)) {
          if (Number.isInteger(item.seq)) removedJournalSequences.push(item.seq);
          if (item.type === 'project.purged') splicedMarkers.add(item.id);
          stagedJournal.splice(index, 1);
          journalEntriesRemoved += 1;
        }
      }
    } else {
      for (const item of stagedJournal) {
        if (item.type === 'project.purged' && item.project === project && item.payload?.mode === 'hard') continue;
        if (referencesRemoved(item)) {
          if (item.payload !== null || item.redacted !== true) journalEntriesRedacted += 1;
          // A deleted capture's skeleton keeps saying so.
          scrubLogicalPurgeSkeleton(item, item.redacted === true && item.redactedReason === 'capture_deleted' ? 'capture_deleted' : undefined);
        }
      }
    }
    const rewrittenBaselines = new Set();
    for (const item of stagedJournal) if (rewriteBaselineForProjectPurge(item, project, removed, removedRelationIds)) rewrittenBaselines.add(item.seq);
    const normalized = normalizeRewrittenPurgeBaselines(stagedJournal, rewrittenBaselines, () => mode);
    removedJournalSequences.push(...normalized.removedSequences);
    journalEntriesRemoved += normalized.removedSequences.length;
    journalEntriesRedacted += normalized.skeletons;
    const uniqueRemovedJournalSequences = [...new Set(removedJournalSequences)].sort((left, right) => left - right);
    // Only the completion of a pending purge forces the marker's id and instant
    // (PR-37d design §2.5): the public registration never passes one.
    const purgeEntry = prebuildJournalEntry({
      type: 'project.purged', entityKind: 'project', entityId: null, project, id: purgeOptions.marker?.id, at: purgeOptions.marker?.at,
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
    // The intent, from the journal and epoch before the marker (PR-37d design
    // §2.1); an earlier intent whose marker this purge splices is absorbed.
    const intents = deletion.get('intents') ?? [];
    const absorbed = intents.filter((item) => splicedMarkers.has(item.marker.id));
    const intent = purgeIntent({ project, mode, marker: purgeEntry, entities, journal, epoch: journalEpoch, absorbed });

    for (const recordId of removed) { records.delete(recordId); captures.delete(recordId); }
    for (const [scopeKey, memory] of currentMemories) if (removed.has(memory.id)) currentMemories.delete(scopeKey);
    for (const factId of removed) facts.delete(factId);
    for (const relationId of removedRelationIds) relations.delete(relationId);
    for (const [key, fact] of currentFacts) if (removed.has(fact.id)) currentFacts.delete(key);
    for (const [key, signal] of reviewSignals) if (removed.has(signal.decisionId)) reviewSignals.delete(key);
    for (const key of idempotencyKeysToRemove) idempotency.delete(key);
    filterInPlace(events, (item) => !eventsToRemove.has(item));
    journal.splice(0, journal.length, ...stagedJournal);
    journalSeq = purgeEntry.seq;
    journalEpoch = stagedJournalEpoch;
    deletion.set('intents', [...intents.filter((item) => !absorbed.includes(item)), intent]);
    authority.purge(project);
    // In both modes the miss-ledger entries the purge reaches are removed, and
    // the last entries take the collection with them (PR-28a).
    if (summary.runtimeMisses) {
      const kept = extras.get(RUNTIME_MISSES).filter((entry) => !reachesMiss(entry));
      if (kept.length) extras.set(RUNTIME_MISSES, kept);
      else extras.delete(RUNTIME_MISSES);
    }
    // So do capture's collections, in both modes (PR-33).
    for (const name of CAPTURE_COLLECTIONS) {
      const entries = extras.get(name) ?? [];
      const kept = entries.filter((entry) => !reachesCaptureEntry(entry));
      if (kept.length === entries.length) continue;
      if (kept.length) extras.set(name, kept);
      else extras.delete(name);
    }
    // The store is smaller: its limit episodes end, and the next capture checks
    // them afresh.
    endStoreLimits(now());

    return {
      ...summary,
      removed: removed.size,
      mode,
      journalEntriesRedacted,
      journalEntriesRemoved,
      removedJournalSequences: uniqueRemovedJournalSequences,
      idempotencyRemoved: idempotencyKeysToRemove.length,
      journalEntryId: purgeEntry.id,
      // Every purge says so, one that removes nothing included (PR-37d design §6.2).
      backups: PURGE_BACKUPS_STATEMENT
    };
  }

  // A restore's post-step, and `quarantine purge` (PR-37c design §6.4), on a
  // graph that holds what the store holds. Each `plan.remove` entity goes with
  // its decision's alternatives and what names it -- relations, review
  // signals, retry values, events, misses, a capture's content -- its journal
  // entries becoming skeletons under `logical` and spliced under `hard`, hard
  // winning where an entry names both, and baselines losing it. Each tokenless
  // `plan.quarantine` entity takes a token by one entity.token_assigned entry:
  // the one given (an overlap's), the one `tokens` holds at its place (a
  // resolution assigns what ledger step 1 recorded, §8.4), or a new one; a
  // tokened one changes nothing here, its token joining the ledger's
  // quarantine instead. A capture left naming a removed one as its possible
  // duplicate names none, history included (V-12). Everything is staged and
  // checked before anything changes, as purgeLive does, and a candidate that
  // cannot take a token stops it first, with its counts by cause (§4.6). It
  // never purges authority and never appends project.purged (rev6:397); with
  // `journal` it appends restore.reapplied, the logical entry first, with C4's
  // four counts only.
  function reapplyDeletion(plan, { journal: reapplied = true, tokens = [], captureDeleted = false } = {}) {
    // A held W is put back and held again from what is left, as a purge
    // reaches it (`shadowgraph quarantine purge`, on a viewed graph).
    if (deletion.has('held')) {
      unhold();
      try { return reapplyDeletion(plan, { journal: reapplied, tokens, captureDeleted }); } finally { hold(); }
    }
    const entityOf = (entityId) => records.get(entityId) ?? captures.get(entityId) ?? facts.get(entityId);
    const modes = new Map();
    for (const { id: entityId, mode } of plan.remove ?? []) {
      const entity = entityOf(entityId);
      if (!entity) continue;
      for (const member of [entity.id, ...(entity.alternatives ?? []).map(byId)]) {
        if (modes.get(member) !== 'hard') modes.set(member, mode === 'logical' ? 'logical' : 'hard');
      }
    }
    const removed = new Set(modes.keys());
    const relationModes = new Map();
    for (const relation of relations.values()) {
      const ends = [relation.from, relation.to].filter((end) => removed.has(end));
      if (ends.length) relationModes.set(relation.id, ends.some((end) => modes.get(end) === 'hard') ? 'hard' : 'logical');
    }
    const removedRelationIds = new Set(relationModes.keys());
    const removedCaptures = [...removed].map((entityId) => captures.get(entityId)).filter(Boolean);
    const removedCaptureIds = new Set(removedCaptures.map(byId));
    const contentRefs = new Set(removedCaptures.map((item) => item.contentRef).filter(Boolean));
    const priorOf = replayedEntities();
    const assigning = (plan.quarantine ?? []).map((entry) => ({ ...entry, entity: entityOf(entry.id) }))
      .filter(({ entity }) => entity !== undefined && entity.erasureToken === undefined);
    const untokenable = {};
    for (const { entity } of assigning) {
      const reason = isNewerThanWriter(entity) ? 'not_replayable' : tokenSkipReason(entity, priorOf);
      if (reason) untokenable[reason] = (untokenable[reason] ?? 0) + 1;
    }
    if (Object.keys(untokenable).length) throw Object.assign(new Error('An item to withhold cannot take an erasure token'), { untokenable });

    // The entries naming a removed entity or relation, by hold()'s predicate.
    const entryMode = (entry) => {
      if (typeof entry?.id !== 'string' || entry.type === 'projection.baseline') return null;
      const found = [entry.entityId, replayedEntity(entry)?.id].flatMap((named) => [modes.get(named), relationModes.get(named)]);
      if (entry.type === 'relation.created') found.push(modes.get(entry.payload?.from), modes.get(entry.payload?.to));
      return found.includes('hard') ? 'hard' : found.includes('logical') ? 'logical' : null;
    };
    const stagedJournal = clone(journal);
    const spliced = [];
    let skeletons = 0;
    for (let index = stagedJournal.length - 1; index >= 0; index -= 1) {
      const entry = stagedJournal[index];
      const mode = entryMode(entry);
      if (mode === 'hard') {
        spliced.push(entry.seq);
        stagedJournal.splice(index, 1);
      } else if (mode === 'logical') {
        if (entry.payload !== null || entry.redacted !== true) skeletons += 1;
        // A deleted capture's skeleton keeps saying so.
        scrubLogicalPurgeSkeleton(entry, (captureDeleted && entry.entityKind === CAPTURE_KIND) || (entry.redacted === true && entry.redactedReason === 'capture_deleted') ? 'capture_deleted' : undefined);
      }
    }
    const rewrittenBaselines = new Set();
    for (const entry of stagedJournal) {
      if (rewriteBaselineForProjectPurge(entry, null, removed, removedRelationIds)) rewrittenBaselines.add(entry.seq);
      for (const item of entry?.type === 'projection.baseline' ? entry.payload?.records ?? [] : [entry?.payload]) {
        if (removedCaptureIds.has(item?.possibleDuplicateOf)) item.possibleDuplicateOf = null;
      }
    }
    const normalized = normalizeRewrittenPurgeBaselines(stagedJournal, rewrittenBaselines, entry => {
      const original = journal.find(item => item.seq === entry.seq)?.payload;
      const reached = [...(original?.records ?? []), ...(original?.facts ?? []), ...(original?.relations ?? []), ...(original?.idempotency ?? []).map(item => item.value)];
      return reached.some(item => modes.get(item?.id) === 'hard' || relationModes.get(item?.id) === 'hard') ? 'hard' : 'logical';
    });
    spliced.push(...normalized.removedSequences);
    skeletons += normalized.skeletons;
    let sequence = journalSeq;
    const assigned = assigning.map(({ token }, index) => token ?? tokens[index] ?? allocateErasureToken());
    const appended = assigning.map(({ entity }, index) => prebuildJournalEntry(tokenAssignment({ ...entity, erasureToken: assigned[index] }, priorOf), ++sequence));
    const logical = [...modes.values()].filter((mode) => mode === 'logical').length;
    const hard = removed.size - logical;
    const marker = (payload) => prebuildJournalEntry({ type: 'restore.reapplied', payload }, ++sequence);
    if (reapplied && (logical || assigning.length)) appended.push(marker({ mode: 'logical', removedJournalSequences: [], removed: logical, quarantined: assigning.length, skeletons }));
    if (reapplied && (hard || spliced.length)) {
      appended.push(marker({ mode: 'hard', removedJournalSequences: [...new Set(spliced.filter(Number.isSafeInteger))].sort((left, right) => left - right), removed: hard, spliced: spliced.length }));
    }
    const nextJournal = [...stagedJournal, ...appended];
    const nextEpoch = journalEpoch ?? appended[0]?.seq ?? null;
    assertJournalBaselinePlacement(nextJournal, { journalEpoch: nextEpoch, sourceSchemaVersion: SCHEMA_VERSION });
    assertHardPurgeGapLedgers(nextJournal, { journalEpoch: nextEpoch, sourceSchemaVersion: SCHEMA_VERSION });

    for (const item of removedCaptures) preserveDeletedCaptureSession(item, now());
    for (const entityId of removed) { records.delete(entityId); captures.delete(entityId); facts.delete(entityId); }
    for (const relationId of removedRelationIds) relations.delete(relationId);
    for (const [key, signal] of reviewSignals) if (removed.has(signal.decisionId)) reviewSignals.delete(key);
    for (const [key, value] of [...idempotency]) if (removed.has(value?.id)) idempotency.delete(key);
    filterInPlace(events, (item) => !(['recordId', 'factId', 'replacementId'].some((key) => removed.has(item?.[key])) || removedRelationIds.has(item?.relationId)));
    const removedEntityIds = new Set([...removed, ...removedRelationIds]);
    const prune = (name, keep) => {
      const entries = extras.get(name);
      if (!Array.isArray(entries)) return;
      const kept = entries.filter(keep);
      if (kept.length === entries.length) return;
      if (kept.length) extras.set(name, kept);
      else extras.delete(name);
    };
    prune(RUNTIME_MISSES, (entry) => !removedEntityIds.has(entry?.recordId));
    prune(CAPTURE_CONTENT, (entry) => !contentRefs.has(entry?.contentRef));
    journal.splice(0, journal.length, ...nextJournal);
    journalSeq = sequence;
    journalEpoch = nextEpoch;
    assigning.forEach(({ entity }, index) => {
      touchMutableObject(entity);
      entity.erasureToken = assigned[index];
      tokenRetryValues(entity);
    });
    for (const item of captures.values()) if (removedCaptureIds.has(item.possibleDuplicateOf)) item.possibleDuplicateOf = null;
    for (const [key, value] of idempotency) if (removedCaptureIds.has(value?.possibleDuplicateOf)) idempotency.set(key, { ...value, possibleDuplicateOf: null });
    recomputeCurrentMemories();
    recomputeCurrentFacts();
    return { counts: { removed: removed.size, quarantined: assigning.length, skeletons, spliced: spliced.length }, assignedTokens: assigned, payload: snapshot() };
  }

  // Diagnostics distinguish three different problems (see api-reference.md):
  //   error       — genuinely invalid data that code produced wrongly
  //   legacy      — older data that is readable but pre-dates a contract
  //   unsupported — data from a newer/unknown schema this build cannot interpret
  //
  // This is the store-wide check, and it is privileged (P1 reconciliation
  // F-17): replaceData staging, rebuild normalisation and restore validation
  // refuse a store that is broken anywhere. The public validate() below
  // reports its verdict and lists only the issues about the request's scope.
  function integrity() {
    const issues = [];
    const push = (severity, code, extra) => { const issue = { code, severity, ...extra }; issues.push(issue); return issue; };
    for (const relation of relations.values()) {
      if (!rawEntity(relation.from)) push('error', 'missing_relation_source', { relationId: relation.id, entityId: relation.from });
      if (!rawEntity(relation.to)) push('error', 'missing_relation_target', { relationId: relation.id, entityId: relation.to });
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
      else if (Number.isInteger(entry.schemaVersion) && entry.schemaVersion > READABLE_SCHEMA_VERSION) push('unsupported', 'unsupported_journal_schema_version', { entryId: entry.id, seq: entry.seq, schemaVersion: entry.schemaVersion });
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
    for (const record of [...records.values(), ...captures.values()]) {
      if (Number.isInteger(record.schemaVersion) && record.schemaVersion > READABLE_SCHEMA_VERSION) push('unsupported', 'unsupported_record_schema_version', { recordId: record.id, schemaVersion: record.schemaVersion });
    }
    for (const fact of facts.values()) {
      if (Number.isInteger(fact.schemaVersion) && fact.schemaVersion > READABLE_SCHEMA_VERSION) push('unsupported', 'unsupported_fact_schema_version', { recordId: fact.id, schemaVersion: fact.schemaVersion });
    }
    for (const entity of [...records.values(), ...facts.values()]) {
      const detail = attributionIssue(entity);
      if (detail) push('error', 'invalid_attribution', { recordId: entity.id, detail });
    }
    // P2-15: the invariant is ONE active fact per (owner, key). More than one is
    // corrupt data: import applies a deterministic recency rule so behaviour is
    // stable, but the ambiguity is still declared rather than hidden.
    const activeScopes = new Map();
    for (const fact of facts.values()) {
      if (fact.status !== 'active') continue;
      const key = JSON.stringify([ownerKey(fact, (project) => project ?? 'default'), fact.key]);
      const scope = fact.attribution === 'unattributed' ? `origin:${fact.originId}::${fact.key}` : `${fact.project ?? 'default'}::${fact.key}`;
      activeScopes.set(key, { scope, count: (activeScopes.get(key)?.count ?? 0) + 1, owner: fact });
    }
    for (const { scope, count, owner } of activeScopes.values()) if (count > 1) issueOwners.set(push('error', 'duplicate_active_fact_scope', { scope, count }), owner);
    // A legacy id collision left these references pointing at an id that now
    // belongs to a different entity. The link still resolves, which is what makes
    // it dangerous, so it is declared rather than left to look healthy.
    for (const relation of relations.values()) {
      const endpoints = relation.migration?.ambiguousLegacyEndpoints;
      if (Array.isArray(endpoints) && endpoints.length) push('error', 'ambiguous_legacy_relation_endpoint', { relationId: relation.id, endpoints });
    }
    for (const record of records.values()) {
      const fields = record.migration?.ambiguousLegacyReferences;
      if (Array.isArray(fields) && fields.length) push('error', 'ambiguous_legacy_reference', { recordId: record.id, fields });
    }
    const activeMemoryScopes = new Map();
    for (const record of records.values()) {
      if (record.kind !== 'memory' || record.status !== 'active') continue;
      const scope = memoryScopeKey(record);
      activeMemoryScopes.set(scope, { count: (activeMemoryScopes.get(scope)?.count ?? 0) + 1, owner: record });
    }
    for (const [scope, { count, owner }] of activeMemoryScopes) if (count > 1) issueOwners.set(push('error', 'duplicate_active_memory_scope', { scope, count }), owner);
    for (const gap of journalGaps(journal)) push('info', 'journal_gap', gap);
    for (const issue of accessDiagnostics({ access: extras.get('access'), accessRevocations: extras.get('accessRevocations'), events }, now())) push('info', issue.code, { accessId: issue.accessId });
    // `valid` is false for genuine errors AND for data this build cannot
    // interpret. Saying "valid" while holding an unsupported schema would be a
    // claim we cannot support. `legacy` and `info` do NOT invalidate: readable
    // older data is not broken data.
    return {
      valid: !issues.some((issue) => issue.severity === 'error' || issue.severity === 'unsupported'),
      issues,
      counts: severityCounts(issues)
    };
  }

  // Public integrity (P1 reconciliation F-17). `valid` is the verdict on the
  // whole store, which names nothing in it. The issues listed are only those
  // about records, facts and relations the request's scope owns; an issue
  // about the journal, or about anything outside the scope, is counted in the
  // verdict and not listed. With no project and no origin nothing is listed.
  function validate(options = {}) {
    const boundary = readBoundary(options);
    const report = integrity();
    const view = scopedView(boundary);
    const ids = new Set([...view.records, ...view.facts].map((item) => item.id));
    for (const record of view.records) for (const alternative of record.alternatives ?? []) ids.add(alternative.id);
    // A relation's issue is the scope's when every endpoint that exists is in it.
    const relationInScope = (relationId) => {
      const relation = relations.get(relationId);
      const endpoints = relation ? [relation.from, relation.to] : [];
      return endpoints.some((id) => ids.has(id)) && endpoints.every((id) => ids.has(id) || !rawEntity(id));
    };
    const listed = (issue) => {
      if (issueOwners.has(issue)) return boundary.visible(issueOwners.get(issue));
      if (issue.entryId !== undefined || issue.seq !== undefined || issue.code === 'journal_gap') return false;
      if (issue.relationId !== undefined) return relationInScope(issue.relationId);
      return issue.recordId !== undefined && ids.has(issue.recordId);
    };
    const issues = report.issues.filter(listed);
    return scopedResult({
      valid: report.valid,
      issues,
      counts: severityCounts(issues),
      limitation: { code: 'scoped_coverage', detail: 'valid is the verdict on the whole store. Only the issues about this scope\'s own records, facts and relations are listed and counted.' }
    }, boundary);
  }

  function repairPlan(options = {}) {
    const report = validate(options);
    return { apply: false, actions: report.issues.map((issue) => issue.code.startsWith('missing_relation_') ? { action: 'remove_relation', relationId: issue.relationId, reason: issue.code } : { action: 'manual_review', ...issue }), completeness: report.completeness, limitation: report.limitation };
  }

  // ---- G6 / G7 read paths -------------------------------------------------
  // The boundary one read works in (plan v1.4.4 §10.2, §10.5). A selected
  // project sees what that project owns; with no project, a presented origin
  // sees its own unattributed records; with neither, the read sees nothing --
  // never every project, and never the shared "default" bucket. Owners follow
  // the owner model the writes use, so legacy data in "default", or stored with
  // no project, belongs to no project a caller can name (OD-1).
  function readBoundary(options = {}) {
    const inherited = options.readProvenance;
    const request = inherited === undefined ? options : inherited?.version === 1 && inherited.request && typeof inherited.request === 'object' ? inherited.request : {};
    const scope = { ...resolveScope({ project: request.project, originId: request.originId, binding: inherited === undefined ? options.binding : undefined }) };
    // The scope's capture status (M-9), read once for this read and never
    // spread into an answer: completeness carries it where it applies.
    Object.defineProperty(scope, 'capture', { value: captureStatus(scope), enumerable: false });
    const baseVisible = (item) => {
      if (!item) return false;
      if (scope.state === 'project_selected') return ownerKey(item, (project) => project) === scope.project;
      return item.attribution === 'unattributed' && sameOrigin(item.originId, scope.originId);
    };
    // What deletion records withhold from this scope, disclosed the same way
    // (PR-37c design §9.3): the quarantined items the scope itself owns,
    // counted by identity, never across scopes nor through a grant's wider
    // read; and whether a restore waits for its post-step, which holds what it
    // will remove or quarantine before the count can see it. A waiting purge
    // makes no read incomplete: what it holds is what it will remove (PR-37d
    // design §4.1, V-5).
    Object.defineProperty(scope, 'quarantined', { value: quarantinedEntities().filter(baseVisible).length, enumerable: false });
    Object.defineProperty(scope, 'restorePending', { value: deletion.get('view')?.pending === true && !deletion.get('view').purging, enumerable: false });
    const accessId = inherited === undefined ? options.accessId ?? options.grantId : inherited?.accessId;
    const requestedAccess = accessId !== undefined && accessId !== null || inherited !== undefined;
    const surface = options.surface ?? 'cli';
    let authorizedScope = null, provenance = null;
    if (requestedAccess) {
      const decision = inherited === undefined && options.accessId !== undefined && options.grantId !== undefined && options.accessId !== options.grantId
        ? { ok: false, reason: 'grant_identity_conflict' }
        : validateAccess({ access: extras.get('access'), accessRevocations: extras.get('accessRevocations'), events }, accessId, { now: now(), surface });
      if (decision.ok && (inherited === undefined || (inherited.version === 1 && Array.isArray(inherited.surfaces) && inherited.surfaces.includes(surface) && isValidIsoInstant(inherited.expiresAt) && compareInstants(now(), inherited.expiresAt) < 0))) {
        authorizedScope = inherited === undefined ? decision.entry.scope : intersectAccessScope(decision.entry.scope, inherited.scope);
        scope.grant = { accessId, expiresAt: inherited === undefined || compareInstants(decision.entry.expiresAt, inherited.expiresAt) < 0 ? decision.entry.expiresAt : inherited.expiresAt, surface };
        provenance = { version: 1, request: { project: scope.project, originId: scope.originId }, accessId, scope: clone(authorizedScope), surfaces: inherited === undefined ? [...decision.entry.surfaces] : decision.entry.surfaces.filter(value => inherited.surfaces.includes(value)), expiresAt: scope.grant.expiresAt };
      } else scope.grantLimitation = decision.reason ?? 'grant_provenance_refused';
    }
    const visible = item => {
      if (!item) return false;
      if (baseVisible(item)) return true;
      const allowed = authorizedScope !== null && accessScopeContains(authorizedScope, isStoredWithoutProject(item) ? { ...item, attribution: 'legacy_unattributed' } : item);
      if (allowed) boundary.widerRead = true;
      return allowed;
    };
    // Whether an id -- a relation endpoint, say -- resolves inside it.
    const boundary = { scope, visible, baseVisible, accessId, surface, requestedAccess, provenance, widerRead: false, reaches: (entityId) => entity(entityId, boundary) !== undefined };
    if (readOperation && requestedAccess) readOperation.boundary ??= boundary;
    return boundary;
  }

  // What one request may see of the store (plan v1.4.4 §10.5, §11): the
  // entities its boundary owns, the relations joining two of them, and the
  // review signals, breadcrumbs and journal entries that name nothing else.
  // The public export, getJournal, stats, review signals and redact's output
  // all come from here, so they cannot disagree, and none of them starts from
  // the privileged snapshot. A relation stored across the boundary stays in
  // the store and out of the view, together with its journal entry and
  // breadcrumb, so no answer in the boundary names an id outside it (P1
  // reconciliation F-16). A relation joins two of the view's own records or
  // facts -- as redaction always required -- so one ending on an alternative
  // nested in a decision is left out too. Live objects; callers clone what
  // they return.
  function scopedView(boundary) {
    const inRecords = [...records.values()].filter(boundary.visible);
    const inFacts = [...facts.values()].filter(boundary.visible);
    const ids = new Set([...inRecords, ...inFacts].map((item) => item.id));
    const inRelations = [...relations.values()].filter((relation) => ids.has(relation.from) && ids.has(relation.to));
    const relationIds = new Set(inRelations.map((relation) => relation.id));
    // Something that names no entity is placed by its project label alone --
    // and a "default" label written before schema 6 is legacy, which no
    // project owns (OD-1).
    const labelled = (item, schemaVersion) => boundary.scope.state === 'project_selected' && item.project === boundary.scope.project
      && !(item.project === 'default' && !(schemaVersion > PRE_ATTRIBUTION_SCHEMA_VERSION));
    const named = (item, keys) => keys.map((key) => item[key]).filter((value) => value !== undefined && value !== null);
    const eventVisible = (event) => {
      // Capture's own entries are declared by the capture status, never listed.
      if (event?.type === CAPTURE_LIMIT_EVENT || event?.type === CAPTURE_REFUSED_EVENT) return false;
      const entities = named(event, ['recordId', 'factId', 'replacementId']);
      const relationsNamed = named(event, ['relationId']);
      if (!entities.length && !relationsNamed.length) return labelled(event);
      return entities.every((id) => ids.has(id)) && relationsNamed.every((id) => relationIds.has(id));
    };
    const entryVisible = (entry) => {
      if (heldOriginal(deletion.get('held'), entry)) return false;
      // A baseline holds the whole store at one point in time. A capture entry,
      // even a skeleton, is never stored experience (PC-14, PC-16(b); PR-33).
      if (entry?.type === 'projection.baseline' || CAPTURE_ENTRY_TYPES.includes(entry?.type) || entry?.entityKind === CAPTURE_KIND) return false;
      const payload = replayedEntity(entry);
      if (payload?.kind === CAPTURE_KIND) return false;
      if (entry.type === 'relation.created' && payload) return ids.has(payload.from) && ids.has(payload.to);
      if (payload && typeof payload === 'object' && ATTRIBUTED_ENTITY_KINDS.includes(payload.kind)) return boundary.visible(payload);
      if (entry.entityId !== null && entry.entityId !== undefined) return ids.has(entry.entityId);
      return labelled(entry, entry.schemaVersion);
    };
    // A signal cites the facts its conditions were evaluated on.
    const cited = (signal) => (signal.violatedConditions ?? []).flatMap((detail) => [detail?.evidence?.factId, ...(detail?.conflictingEvidence ?? []).map((item) => item?.factId)]).filter((id) => id !== undefined && id !== null);
    return {
      records: inRecords,
      facts: inFacts,
      relations: inRelations,
      reviewSignals: [...reviewSignals.values()].filter((signal) => ids.has(signal.decisionId)).map((signal) => {
        if (cited(signal).every((id) => ids.has(id))) return signal;
        // Older evaluators could match facts by label across today's boundary.
        // Even coverage/reason can contain historical condition text. Expose
        // only the owner's signal identity and lifecycle; never rewrite it.
        return {
          ...Object.fromEntries(['id', 'kind', 'decisionId', 'status', 'createdAt', 'acknowledgedAt'].filter((key) => signal[key] !== undefined).map((key) => [key, clone(signal[key])])),
          limitation: { code: 'scoped_coverage', detail: 'Historical detail cites evidence outside this scope. Only this own signal\'s identity and lifecycle are shown.' }
        };
      }),
      events: events.filter(eventVisible),
      journal: journal.filter(entryVisible)
    };
  }

  // The gaps a scoped journal read positions: only those its own hard purges
  // explain (P1 reconciliation F-09). Sequence numbers are global, so the gaps
  // between one scope's entries are other scopes' entries, not integrity gaps;
  // store-wide integrity is the privileged check's to report.
  function explainedGaps(entries) {
    const present = new Set(journal.map((entry) => entry.seq));
    const removed = [...new Set(entries
      .filter((entry) => entry.type === 'project.purged' && entry.payload?.mode === 'hard' && Array.isArray(entry.payload.removedJournalSequences))
      .flatMap((entry) => entry.payload.removedJournalSequences)
      .filter((seq) => Number.isSafeInteger(seq) && !present.has(seq)))].sort((left, right) => left - right);
    const gaps = [];
    for (const seq of removed) {
      const last = gaps.at(-1);
      if (last && last.to === seq - 1) last.to = seq;
      else gaps.push({ from: seq, to: seq });
    }
    return gaps;
  }

  function matchesFilters(record, options, boundary) {
    if (!boundary.visible(record)) return false;
    if (options.status && record.status !== options.status) return false;
    if (options.kind && record.kind !== options.kind) return false;
    if (options.sourceClass && record.sourceClass !== options.sourceClass) return false;
    if (options.minConfidence !== undefined && (record.confidence?.current ?? 0) < options.minConfidence) return false;
    return true;
  }

  function appliedFilters(options) {
    return Object.fromEntries(SEARCH_FILTERS.filter((name) => options[name] !== undefined).map((name) => [name, options[name]]));
  }

  function rank(query = '', options = {}, boundary = readBoundary(options)) {
    const memoryScope = normalizeMemoryScope(options.scope);
    // Folded on both sides, or the match is one-directional: an unaccented query
    // would find an accented record but not the reverse.
    const terms = foldForMatch(query).split(/\s+/).filter(Boolean);
    // The same query with only case folded away, positionally aligned with
    // `terms`. Matching uses the folded form; ranking uses this to prefer a
    // record that holds the word the caller actually typed.
    const rawTerms = String(query).toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const hits = [];
    for (const record of records.values()) {
      if (!matchesFilters(record, options, boundary)) continue;
      if (record.kind === 'memory' && !sameMemoryScopeValues(record.scope, memoryScope)) continue;
      // G7: a term must match a DECLARED CONTENT FIELD. Schema keys and internal
      // metadata are not content, so `search('confidence')` no longer matches a
      // record merely because it has a confidence field.
      const perTerm = terms.map((term) => matchFields(record, term));
      if (terms.length && perTerm.some((fields) => fields.length === 0)) continue;
      const matched = [...new Set(perTerm.flat())];
      hits.push({
        record: clone(extractionView(record, memoryScope)),
        score: terms.length ? score(record, terms, rawTerms) : 0,
        matched,
        reason: terms.length ? `Matched ${matched.join(', ')}` : 'Matched filters only',
        matchedBy: terms.length ? 'content' : 'filter',
        filters: appliedFilters(options)
      });
    }
    return hits.sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)));
  }

  function search(query = '', options = {}) {
    const boundary = readBoundary(options);
    const hits = rank(query, options, boundary);
    return scopedPage(hits, options, boundary, { query: String(query), filters: appliedFilters(options) }, { contentFields: [...CONTENT_SEARCH_FIELDS] });
  }

  function retrieve(query = '', options = {}) {
    const boundary = readBoundary(options);
    const hits = rank(query, options, boundary);
    const memoryScope = normalizeMemoryScope(options.scope);
    const directIds = new Set(hits.map((item) => item.record.id));
    const results = hits.map((item) => ({ ...item, graphBoost: 0, reasons: [item.reason] }));
    // A neighbour joins only from inside the same boundary as the hits.
    for (const relation of relations.values()) {
      const relatedId = directIds.has(relation.from) ? relation.to : directIds.has(relation.to) ? relation.from : null;
      const related = relatedId && entity(relatedId, boundary);
      if (related && related.kind !== 'alternative' && (related.kind !== 'memory' || sameMemoryScopeValues(related.scope, memoryScope)) && !directIds.has(relatedId)) {
        results.push({ record: clone(extractionView(related, memoryScope)), score: 1, graphBoost: 1, matched: ['relationship'], matchedBy: 'graph', reason: `Related by ${relation.relation}`, reasons: [`Related by ${relation.relation}`], filters: appliedFilters(options) });
        directIds.add(relatedId);
      }
    }
    const sorted = results.sort((a, b) => b.score - a.score || String(a.record.id).localeCompare(String(b.record.id)));
    return scopedPage(sorted, options, boundary, { query: String(query), filters: appliedFilters(options) }, { includesGraphNeighbours: true, contentFields: [...CONTENT_SEARCH_FIELDS] });
  }

  // Whether an id resolves inside the read boundary and, when it is a memory,
  // in the memory scope read: another scope's memory never rides along, in a
  // walk as in a traversal (docs/unified-memory.md).
  const scopedReach = (boundary, memoryScope) => (entityId) => {
    const found = entity(entityId, boundary);
    return found !== undefined && (found.kind !== 'memory' || sameMemoryScopeValues(found.scope, memoryScope));
  };

  // What ranking may read: the entities inside the read boundary and the
  // relations joining two of them that the memory scope may reach. recall()
  // and the default read's relevance rank this one view.
  function rankingView(boundary, memoryScope) {
    const reach = scopedReach(boundary, memoryScope);
    return {
      records: [...records.values()].filter(boundary.visible).map(record => extractionView(record, memoryScope)),
      facts: [...facts.values()].filter(boundary.visible),
      relations: [...relations.values()].filter((relation) => reach(relation.from) && reach(relation.to))
    };
  }

  function recall(query = '', options = {}) {
    validateTemporalFields(options, ['asOf', 'currentAt']);
    const boundary = readBoundary(options);
    const recallOptions = { ...options, project: boundary.scope.grant ? null : boundary.scope.project, scope: normalizeMemoryScope(options.scope), currentAt: options.currentAt ?? (options.asOf ? null : now()) };
    // Ranking only READS the graph, but this used to hand it `exportData()`,
    // which deep-clones every record, fact, relation, review signal, idempotency
    // entry, event and the entire journal -- on every call. Ranking reads three
    // of those. Measured with scripts/context-size.mjs on a 70-record corpus,
    // about 89% of recall() was that copy (2.05 ms) rather than the ranking it
    // paid for (0.26 ms), and the journal grows without bound.
    //
    // So rank over live entities and clone only the page actually returned. No
    // caller receives a reference into live state, which is the property the
    // wholesale clone was really providing.
    //
    // Only what lies inside the read boundary is ranked, and the graph signal
    // walks only relations between such entities: it cannot pass through
    // another project, and a focus outside the boundary reaches nothing, just
    // as one that does not exist.
    const result = hybridSearch(rankingView(boundary, recallOptions.scope), query, recallOptions);
    const envelope = scopedPage(
      result.items,
      recallOptions,
      boundary,
      { project: recallOptions.project, scope: recallOptions.scope, query: String(query), asOf: options.asOf ?? null },
      { signals: result.signals, ranking: result.ranking }
    );
    return {
      ...envelope,
      items: envelope.items.map((item) => ({ ...item, record: clone(item.record) })),
      signals: result.signals,
      ranking: result.ranking
    };
  }

  // context() returns several collections. Each one declares its own total and
  // whether it was truncated, so a caller can never be silently short-changed.
  // Everything context() reads, evaluates or cites -- decisions, facts,
  // attempts and the review signals it may raise -- lies inside one read
  // boundary; a context with no project selected evaluates nothing and
  // reports no project.
  //
  // context() is the default-path read (plan v1.4.4 §13.1-13.2, PC-25): the
  // working set is evaluated without persisting any review signal, so reading
  // it changes no canonical truth. Signals already persisted are still
  // reported. The notice is declared interface metadata, not memory: it tells
  // a caller that relied on the old implicit persist where that moved.
  //
  // It names each collection for what it holds (§13.4, E03): failedAttempts,
  // firedConditions with affectedAlternatives, and belowConfidenceThreshold,
  // the fact the generated suggestedQuestions was built from. Every record is
  // kept.
  //
  // With a query or a focalId it also returns `relevant`, ahead of the working
  // set (PR-26; relevanceBlock()).
  function context(input = {}) {
    return { ...buildContext(input, { persistSignals: false, factual: true }), notice: contextNotice() };
  }

  // Explicit evaluation (§13.2): the evaluate-and-persist working set that
  // context() used to return, in its original shape, review-named because it
  // may raise and store review signals.
  function reviewContext(input = {}) {
    return buildContext(input, { persistSignals: true, factual: false });
  }

  function buildContext(input, { persistSignals, factual }) {
    const relevance = factual && (input.query != null || input.focalId != null);
    if (relevance) validateRelevanceInput(input);
    const boundary = readBoundary(input);
    const project = boundary.scope.project;
    const inScope = boundary.visible;
    const limit = input.limit;
    const collect = (items) => {
      const page = resolvePage({ limit, offset: 0 }, items.length);
      return { items: items.slice(0, page.limit), total: items.length, returned: Math.min(page.limit, items.length), hasMore: page.limit < items.length };
    };
    const current = [...records.values()].filter((x) => x.kind === 'decision' && inScope(x) && CURRENT_DECISION_STATUSES.includes(x.status));
    const stale = [...facts.values()].filter((x) => inScope(x) && x.status !== 'active');
    const activeDecisions = collect(current.map(clone));
    const staleAssumptions = collect(stale.map(clone));
    // Only a failure is collected (PR-24). An attempt whose outcome is
    // undetermined -- captured, with no declared class -- is in no collection,
    // is never implied to have succeeded, and is counted on this one.
    const attemptsInScope = [...records.values()].filter((x) => x.kind === 'attempt' && inScope(x) && extractionView(x).derivationState !== 'superseded');
    const failed = attemptsInScope.filter((x) => attemptOutcome(x) === 'failed');
    const failedAttemptsToAvoid = {
      ...collect(failed.map(record => clone(extractionView(record)))),
      undetermined: attemptsInScope.filter((x) => attemptOutcome(x) === 'undetermined').length
    };
    const evaluated = evaluateForRead({ changedFacts: input.changedFacts ?? [], facts: input.facts ?? {} }, boundary, { persistSignals });
    const openReviews = collect(evaluated.due);
    // Conditions that could not be settled travel as their own collection, so
    // they are bounded and declared by the same completeness contract as every
    // other collection here rather than riding along unbounded.
    const reuse = evaluateAttemptReuse(inScope, now(), input.facts ?? {});
    const reusableAttempts = collect(reuse.reusable);
    const conditionDiagnostics = collect([...evaluated.diagnostics, ...reuse.diagnostics]);
    // A decision of any status whose recorded confidence is below the policy
    // threshold. The review-named shape turns each into a generated question.
    // Values are copies, as recorded: a legacy writer may have left no status,
    // one this build does not recognise, or a confidence that is not a number.
    const lowConfidence = [...records.values()].filter((x) => x.kind === 'decision' && inScope(x) && (x.confidence?.current ?? 0) < LOW_CONFIDENCE_THRESHOLD);
    const belowThreshold = collect(factual
      ? lowConfidence.map((x) => ({ decisionId: x.id, title: clone(x.title ?? null), status: clone(x.status ?? null), confidence: clone(x.confidence?.current ?? null), threshold: LOW_CONFIDENCE_THRESHOLD }))
      : lowConfidence.map((x) => `What evidence could change the decision: ${x.title}?`));
    const fired = factual
      ? { ...openReviews, items: openReviews.items.map((entry) => Object.fromEntries(Object.entries(entry).map(([key, value]) => [key === 'alternativesToReconsider' ? 'affectedAlternatives' : key, value]))) }
      : openReviews;
    const groups = factual
      ? { activeDecisions, staleAssumptions, failedAttempts: failedAttemptsToAvoid, firedConditions: fired, belowConfidenceThreshold: belowThreshold, conditionDiagnostics, reusableAttempts }
      : { activeDecisions, staleAssumptions, failedAttemptsToAvoid, openReviews, suggestedQuestions: belowThreshold, conditionDiagnostics, reusableAttempts };
    const workingSet = [...current, ...failed, ...reuse.reusable.map((entry) => records.get(entry.attemptId)), ...stale];
    return {
      project,
      ...(relevance ? { relevant: relevanceBlock(input, boundary, workingSet) } : {}),
      ...Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, group.items])),
      completeness: scopeCompleteness(boundary.scope, {
        scope: { project },
        complete: Object.values(groups).every((group) => !group.hasMore),
        limitSource: limit === undefined ? 'default' : 'caller',
        losslessItems: true,
        collections: Object.fromEntries(Object.entries(groups).map(([name, group]) => [name, { returned: group.returned, total: group.total, hasMore: group.hasMore, omitted: group.total - group.returned, ...(group.undetermined === undefined ? {} : { undetermined: group.undetermined }) }]))
      }, referencedSignals(boundary, openReviews.items))
    };
  }

  // Whether text names a stored entity's id: the whole text, a word of it, or
  // a piece of a word, compared without regard to case or Unicode form. The ids
  // are gathered once, so the cost is linear in the store and the text.
  function namesEntity(text) {
    const fold = (value) => String(value).normalize('NFC').toLowerCase();
    const ids = new Set([...facts.keys(), ...relations.keys(), ...captures.keys()].map(fold));
    for (const record of records.values()) {
      ids.add(fold(record.id));
      for (const alternative of Array.isArray(record.alternatives) ? record.alternatives : []) if (typeof alternative?.id === 'string') ids.add(fold(alternative.id));
    }
    const folded = fold(text);
    const tokens = folded.split(/\s+/);
    const candidates = new Set([
      folded.trim(), ...tokens, ...tokens.map((token) => token.replace(/^[^\p{L}\p{N}_]+|[^\p{L}\p{N}_]+$/gu, '')),
      ...folded.split(/[^\p{L}\p{N}_:-]+/u), ...folded.split(/[^\p{L}\p{N}_]+/u)
    ]);
    return [...candidates].some((candidate) => candidate && ids.has(candidate));
  }

  // PR-26 (plan v1.4.4 §17; G-5 §9; AC-063): relevance on the default read.
  // Every record inside the read boundary -- memories of the project-wide scope
  // only, as every read without a memory scope -- is ranked on the canonical
  // record itself (T0) by the hybrid engine, over the view recall() ranks; a
  // T1 line is only the form a ranked record is delivered in. A record is relevant when the
  // lexical, semantic or graph signal ranked it -- recency orders, it never
  // selects; a lexical rank counts only for a record that shares a content word
  // with the query, so one that shares nothing but "the" or "is" is not relevant
  // to it, while every term still orders the hits (PR-26 corrective); the head's
  // lexical signal counts content words -- and no reusableWhen, reviewAfter or
  // status gates it (§17.4). The
  // semantic signal has no query vector here: no request text is sent to an
  // embedding endpoint on the default path. When no signal establishes
  // relevance, the working set is delivered in full rather than nothing (§9);
  // so is any record whose line cannot carry its decisive meaning. A full
  // record (T2) is the canonical record: the embedding, a derived index, is left
  // out, as it is from a line's digest. The head precedes the items (§17.2).
  function relevanceBlock(input, boundary, workingSet) {
    const asOf = input.asOf ?? null;
    const memoryScope = normalizeMemoryScope();
    const currentAt = asOf ? null : now();
    const ranked = hybridSearch(rankingView(boundary, memoryScope), input.query ?? '', {
      project: boundary.scope.grant ? null : boundary.scope.project, focalId: input.focalId, asOf, currentAt
    });
    const content = ranked.lexicalContent;
    const hits = ranked.items.filter(({ record, ranks }) => (ranks.lexical !== null && content.matched.has(record.id)) || ranks.semantic !== null || ranks.graph !== null);
    const signals = { ...ranked.signals, lexical: { available: content.terms.length > 0, matched: content.matched.size } };
    const established = hits.length > 0;
    const candidates = established ? hits : [...new Map(workingSet.map((record) => [record.id, { record, score: null, ranks: null }])).values()];
    const page = resolvePage({ limit: input.limit, offset: 0 }, candidates.length);
    const lineContext = { asOf, scope: lineScope(boundary), derivedAt: now(), visible: scopedReach(boundary, memoryScope) };
    // §17.5 (PR-29): each delivered record's temporal evidence at the read's
    // instant, from the supersession links, named on either side, that the read
    // may reach. Links are gathered for the delivered records only.
    const reach = lineContext.visible;
    const delivered = candidates.slice(0, page.limit).map(({ record }) => record);
    const onPage = new Set(delivered.map((record) => record.id));
    const linked = { successors: new Map(), predecessors: new Map() };
    const link = (side, id, other) => {
      if (!onPage.has(id) || other.id === id || !reach(other.id)) return;
      const found = linked[side].get(id);
      if (found) found.add(other);
      else linked[side].set(id, new Set([other]));
    };
    // In id order, so the evidence named under its cap does not depend on how
    // the store was loaded.
    const linksOf = (side, id) => [...(linked[side].get(id) ?? [])].sort((left, right) => String(left.id).localeCompare(String(right.id)));
    const entityOf = (id) => records.get(id) ?? facts.get(id);
    for (const entity of [...records.values(), ...facts.values()]) {
      for (const id of linkIds(entity.supersededBy)) link('predecessors', id, entity);
      for (const id of linkIds(entity.supersedes)) link('successors', id, entity);
    }
    for (const record of delivered) {
      for (const id of linkIds(record.supersededBy)) if (entityOf(id)) link('successors', record.id, entityOf(id));
      for (const id of linkIds(record.supersedes)) if (entityOf(id)) link('predecessors', record.id, entityOf(id));
    }
    const evidenceOf = (record) => temporalEvidence(extractionView(record), {
      kind: facts.get(record.id) === record ? 'fact' : record.kind,
      successors: linksOf('successors', record.id), predecessors: linksOf('predecessors', record.id),
      at: asOf ?? currentAt, asOf
    });
    let shortened = false;
    const items = candidates.slice(0, page.limit).map(({ record, score, ranks }) => {
      const shown = canonicalRecord(record);
      const line = established && input.compact === true ? t1Line(shown, lineContext) : null;
      if (line?.decisiveOmitted.length) shortened = true;
      const evidence = evidenceOf(record);
      return line && !line.decisiveOmitted.length ? { tier: 'T1', line, score, ranks, temporalEvidence: evidence } : { tier: 'T2', record: shown, score, ranks, temporalEvidence: evidence };
    });
    const byKind = { decision: 0, attempt: 0, memory: 0, fact: 0 };
    // A legacy fact may be stored with no kind; it is still a fact.
    for (const { record } of candidates) {
      const kind = facts.get(record.id) === record ? 'fact' : record.kind ?? 'unknown';
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
    const hasMore = page.limit < candidates.length;
    const head = scopeCompleteness(boundary.scope, {
      scope: {},
      relevance: { established, signals: Object.fromEntries(Object.entries(signals).map(([name, signal]) => [name, { available: signal.available, matched: signal.matched }])) },
      fallback: { used: !established || shortened, reason: !established ? 'relevance_not_established' : shortened ? 'decisive_meaning_omitted' : null },
      byKind, total: candidates.length, returned: items.length, omitted: candidates.length - items.length, hasMore,
      complete: established && !hasMore,
      limitSource: input.limit === undefined ? 'default' : 'caller',
      limitation: established
        ? { code: 'semantic_unavailable', detail: 'Relevance rests on the lexical and graph signals over the records themselves, with recency only ordering them. The semantic signal is unavailable on this path, so the counts cover what those signals found, not every record related in meaning alone.' }
        : { code: 'relevance_not_established', detail: 'No lexical, semantic or graph signal found a relevant record, so the working set is delivered in full instead of nothing. The semantic signal is unavailable on this path.' },
      // How many delivered records have no stored event time, so no as-of
      // placement beyond their recording (§17.5).
      temporal: {
        asOf,
        eventTimeUnknown: items.filter((item) => item.temporalEvidence.eventTime.state === 'unknown').length,
        recordingOrderOnly: items.filter((item) => item.temporalEvidence.currentState?.basis === 'recording_order_only').length
      },
      // The claim class of each delivered line, in item order, where a
      // truncated payload still carries it (§17.2).
      lines: items.filter(({ tier }) => tier === 'T1').map(({ line }) => ({ recordId: line.recordId, claimClass: line.claimClass, requiresExpansion: line.requiresExpansion })),
      // What capture holds for this scope, from the same status the
      // completeness funnel declares (M-9); as it always was without capture.
      processing: boundary.scope.capture ? { ...boundary.scope.capture, limited: boundary.scope.capture.limited.map((entry) => ({ ...entry })), gaps: boundary.scope.capture.gaps.map((entry) => ({ ...entry })) } : { pending: 0, failed: 0, blocked: 0, oldestPendingAt: null, extractionAvailable: false },
      expansion: { operation: 'shadowgraph_expand', available: true }
    });
    // §9, §6.2(a): what the fallback delivered, no signal having ranked it, is a
    // runtime miss (PR-28). It is kept in memory: this read saves nothing
    // (PR-17's budget), and the process's next save writes it. A read without
    // query text -- none, or blank -- records none, its only query being a focal
    // entity id; nor does one whose query names a stored entity's id, whose
    // digest would outlive that entity's purge.
    if (!established && typeof input.query === 'string' && input.query.trim() !== '' && !namesEntity(input.query)) {
      const ledger = Array.isArray(extras.get(RUNTIME_MISSES)) ? extras.get(RUNTIME_MISSES) : [];
      const recorded = withFallbackMisses(ledger, { query: input.query, scope: boundary.scope, signals: head.relevance.signals, recordIds: items.map(({ record }) => record.id), at: now() });
      if (recorded !== ledger) extras.set(RUNTIME_MISSES, recorded);
    }
    return { ...head, items };
  }

  // A full record (T2) as a read delivers it: the public record, the embedding
  // (a derived index) left out.
  function extractionView(record, memoryScope = normalizeMemoryScope()) {
    return extractionSupersession(record, records, relations, other => other.kind !== 'memory' || sameMemoryScopeValues(other.scope, memoryScope));
  }

  function canonicalRecord(record) {
    const { embedding, ...shown } = publicValue(clone(extractionView(record)));
    return shown;
  }

  // PR-27 (plan v1.4.4 §17.3; G-5 §7-§8; AC-018): a line's handle expanded to
  // the full record inside the boundary of the read that produced the line --
  // its project and grant, the grant re-checked now. The live record is
  // derived exactly as a line is (the public record, the handle's as-of
  // instant, the project-wide memory scope's reach), so an equal digest means
  // the line came from this very revision, and a different one serves the
  // current record, saying so, never as the revision the line came from. A
  // record the boundary does not reach -- absent, purged, another project's or
  // another memory scope's, an alternative -- answers alike: `purged` when the
  // first purge of the read's project recorded after the line was derived was
  // logical, `unavailable` otherwise. The id decides nothing, so no
  // existence leaks (§8, plan §10.5). No ranking, no model call, no clock: the
  // same handle over the same store gives the same bytes.
  function expand(input = {}) {
    validateExpandInput(input);
    const boundary = readBoundary(input);
    const reach = scopedReach(boundary, normalizeMemoryScope());
    const { recordId } = input;
    const boundRevision = { recordId, digest: input.digest };
    const stored = records.get(recordId) ?? facts.get(recordId);
    if (!stored || !reach(recordId)) {
      const reason = purgedSince(boundary, input.derivedAt) ? 'purged' : 'unavailable';
      return {
        recordId, status: reason, revisionChanged: null, boundRevision, currentRevision: null, record: null, investigation: null,
        completeness: scopeCompleteness(boundary.scope, { scope: {}, complete: false, limitation: { code: 'expansion_unavailable', reason, recordId, detail: reason === 'purged'
          ? 'A logical purge of this read\'s project was recorded after the line was derived. No record with this id is served, and nothing stands in for one.'
          : 'No record with this id is inside the scope of this read.' } })
      };
    }
    const lineContext = { asOf: input.asOf ?? null, scope: lineScope(boundary), derivedAt: input.derivedAt ?? null, visible: reach };
    const record = canonicalRecord(stored);
    const digest = t1Digest(t1Inputs(record, lineContext));
    const current = (input.derivationVersion ?? T1_DERIVATION_VERSION) === T1_DERIVATION_VERSION && input.digest === digest;
    const investigation = investigate(stored, lineContext, input.maxExpansions ?? DEFAULT_EXPANSIONS, reach);
    const exhausted = investigation.budget.outcome === 'exhausted';
    const limitation = !current
      ? { code: 'revision_changed', detail: 'The record, or what this read reaches of its links, changed after the line was derived. This is the current record, not the revision the line came from.' }
      : exhausted ? { code: 'investigation_budget_exhausted', detail: 'The expansion budget ran out before every counterpart was fetched in full. Each listed counterpart not fetched is marked uninvestigated, with its line; the rest are counted as omitted.' }
      : investigation.unreachableLinks ? { code: 'links_unavailable', detail: 'Supersession links of this record name records this read cannot reach, or that do not exist; they are counted in investigation.unreachableLinks.' }
      : null;
    return {
      recordId, status: current ? 'current' : 'revision_changed', revisionChanged: !current, boundRevision, currentRevision: { recordId, digest },
      record, investigation,
      completeness: scopeCompleteness(boundary.scope, { scope: {}, complete: limitation === null, ...(limitation ? { limitation } : {}) })
    };
  }

  // The handle scope a line carries: the read's project and grant, and its
  // origin when no project was resolved, so an origin-scoped read's line can be
  // expanded from its own handle.
  function lineScope(boundary) {
    return {
      project: boundary.scope.project, grantId: boundary.scope.grant?.accessId ?? null,
      ...(boundary.scope.project == null && boundary.scope.originId != null ? { originId: boundary.scope.originId } : {})
    };
  }

  // Whether the purge that removed a record behind a line was logical: the
  // first canonical project.purged marker of the read's project recorded after
  // the line was derived (G-5 §8); a hard purge answers unavailable. A later
  // logical purge scrubs the earlier logical markers of its project to
  // skeletons, so the first marker counts as logical unless it is recorded
  // hard. A purge narrows every grant so that it no longer covers the purged
  // project, so a granted project's purge is never covered: it answers
  // unavailable, closed. The store's ledger is asked too (PR-37c design §11):
  // a restore of a pre-purge backup wipes the marker from the journal and
  // lifts it into a project tombstone that keeps its instant and mode. The
  // earliest of either after the line decides; a tombstone counts as logical
  // only when it says so, and on a tie anything not logical wins, closed.
  function purgedSince(boundary, instant) {
    const { project } = boundary.scope;
    if (!project || !isValidIsoInstant(instant)) return false;
    const later = [
      ...journal.filter((entry) => entry.type === 'project.purged' && entry.project === project).map((entry) => ({ at: entry.at, logical: entry.payload?.mode !== 'hard' })),
      ...(deletion.get('view')?.projects ?? []).filter((tombstone) => tombstone.project === project).map((tombstone) => ({ at: tombstone.at, logical: tombstone.mode === 'logical' }))
    ].filter((entry) => isValidIsoInstant(entry.at) && compareInstants(entry.at, instant) > 0);
    if (!later.length) return false;
    const earliest = later.reduce((first, entry) => (compareInstants(entry.at, first) < 0 ? entry.at : first), later[0].at);
    return later.every((entry) => entry.logical || compareInstants(entry.at, earliest) !== 0);
  }

  // AC-031/AC-032: the structural counterparts of an expanded record -- facts
  // of the same key in its project, the records its supersession links name --
  // each investigated within the budget: resolved on a stated basis,
  // investigated and unresolved, or, past the budget, not investigated. Both
  // positions are always delivered: the counterpart's line, and its full record
  // once investigated. A contradiction stated only in free text is not
  // detected, and the result says so.
  function investigate(stored, lineContext, maxExpansions, reach) {
    const { counterparts, unreachableLinks } = counterpartsOf(stored, reach);
    // Positions are bounded too: at least the budget, and never fewer than
    // MIN_POSITIONS; the rest are counted as omitted.
    const listed = counterparts.slice(0, Math.max(maxExpansions, MIN_POSITIONS));
    let used = 0;
    const pairs = listed.map(({ record, relation }) => {
      const shown = canonicalRecord(record);
      const position = t1Line(shown, lineContext);
      if (used >= maxExpansions) return { recordId: record.id, relation, state: 'uninvestigated', basis: [], position };
      used += 1;
      const basis = basisOf(stored, record);
      return { recordId: record.id, relation, state: basis.length ? 'resolved' : 'unresolved', basis, position, record: shown };
    });
    return {
      budget: { maxExpansions, used, outcome: used < counterparts.length ? 'exhausted' : 'within_budget' },
      total: counterparts.length, omitted: counterparts.length - listed.length, unreachableLinks,
      pairs,
      limitation: { code: 'structural_only', detail: 'Counterparts are found by structure alone: facts of the same key and supersession links. A contradiction stated only in free text is not detected.' }
    };
  }

  // The counterparts inside the read's reach, current rivals first (not
  // superseded, then the most recent), and the number of supersession links
  // that name a record outside the reach or none at all, counted alike.
  function counterpartsOf(stored, reach) {
    stored = extractionView(stored);
    const found = [];
    const unreachable = new Set();
    const push = (record, relation) => { if (record.id !== stored.id && !found.some((item) => item.record.id === record.id)) found.push({ record: extractionView(record), relation }); };
    if (facts.get(stored.id) === stored) {
      for (const fact of facts.values()) if (fact.key === stored.key && fact.project === stored.project && reach(fact.id)) push(fact, 'same_key');
    }
    for (const [ids, relation] of [[linkIds(stored.supersedes), 'supersedes'], [linkIds(stored.supersededBy), 'superseded_by']]) {
      for (const id of ids) {
        const record = records.get(id) ?? facts.get(id);
        if (record && reach(id)) push(record, relation);
        else if (id !== stored.id) unreachable.add(id);
      }
    }
    const recency = (record) => instantMs(record.temporal?.validFrom ?? record.validFrom ?? record.createdAt) ?? Number.NEGATIVE_INFINITY;
    const superseded = (record) => (record.supersededBy == null ? 0 : 1);
    found.sort((a, b) => superseded(a.record) - superseded(b.record) || recency(b.record) - recency(a.record) || String(a.record.id).localeCompare(String(b.record.id)));
    return { counterparts: found, unreachableLinks: unreachable.size };
  }

  // What resolves an apparent conflict between two records, from their own
  // fields: an explicit supersession, validity windows that do not overlap,
  // or, for facts, the same value.
  //
  // A same-key write supersedes the earlier fact or memory and closes its window
  // at the new one's start. When only the recording order tells two versions
  // apart -- their event times unknown or equal, and no end the earlier one's
  // writer declared by the later one's start -- neither that supersession nor
  // that closed window decides anything, linked or not (§17.5, PR-29).
  function basisOf(left, right) {
    const basis = [];
    const links = (from, to) => linkIds(from.supersededBy).includes(to.id) || linkIds(from.supersedes).includes(to.id);
    const kindOf = (record) => (facts.get(record.id) === record ? 'fact' : record.kind);
    const kind = kindOf(left);
    const linked = links(left, right) || links(right, left);
    const startOf = (record) => instantMs(versionTimes(record, kind).validFrom) ?? Number.NEGATIVE_INFINITY;
    const leftFirst = linked ? linkIds(left.supersededBy).includes(right.id) || linkIds(right.supersedes).includes(left.id) : startOf(left) <= startOf(right);
    const [earlier, later] = leftFirst ? [left, right] : [right, left];
    const byRecordingOrder = kind === kindOf(right) && ['fact', 'memory'].includes(kind) && supersessionOrder(earlier, later, kind) === 'recording_order_only';
    if (linked && !byRecordingOrder) basis.push('explicit_supersession');
    if (facts.get(left.id) === left && facts.get(right.id) === right) {
      const [a, b] = [validityWindow(left), validityWindow(right)];
      const before = (earlier, later) => earlier.to !== null && later.from !== null && compareInstants(earlier.to, later.from) <= 0;
      if (!byRecordingOrder && (before(a, b) || before(b, a))) basis.push('different_times');
      if (JSON.stringify(canonical(left.value)) === JSON.stringify(canonical(right.value))) basis.push('same_value');
    }
    return basis;
  }

  function nativeCollections(held = null) {
    const back = (name, live, keyOf = byId) => reemit(live, keyOf, held?.collections[name]);
    return {
      schemaVersion: SCHEMA_VERSION, revision,
      records: [...back('records', [...records.values()]), ...back('captures', [...captures.values()])].map(clone), facts: back('facts', [...facts.values()]).map(clone),
      relations: back('relations', [...relations.values()]).map(clone), reviewSignals: back('reviewSignals', [...reviewSignals.values()]).map(clone),
      idempotency: back('idempotency', [...idempotency.entries()].map(([key, value]) => ({ key, value: canonicalIdempotencyValue(value) })), (item) => item.key).map(({ key, value }) => ({ key, value: clone(value) })),
      events: clone(back('events', events)), journal: clone(held ? journal.map((entry) => heldOriginal(held, entry) ?? entry) : journal), journalSeq, journalEpoch
    };
  }

  // The privileged snapshot (plan v1.4.4 §11): the complete, unscoped store --
  // every project and collection, the journal, idempotency and revision, and
  // every top-level collection this build does not understand. It is the
  // persistence primitive, reachable only through src/internal/snapshot.js, and
  // it is not a read of the memory product.
  //
  // With deletion knowledge (PR-37a, design §11 R-2) it is the persistence
  // form: W is put back in place, so the store a graph saves is exactly the
  // store it would save with no view. The live form beside it is what the
  // graph holds with W apart; redaction, the Markdown pull lookup and
  // downgrade read that one.
  //
  // It carries the graph's purge intents to a store's commit point, under a
  // non-enumerable symbol (PR-37d design §2.2); the live form never does.
  function snapshot() {
    const payload = storeSnapshot(deletion.get('held') ?? null);
    const intents = deletion.get('intents');
    return intents?.length ? Object.defineProperty(payload, DELETION_INTENT, { value: structuredClone(intents) }) : payload;
  }

  function liveSnapshot() {
    return storeSnapshot(null);
  }

  function storeSnapshot(held) {
    const pending = [...projectlessLegacy.keys()].filter((id) => {
      const entity = records.get(id) ?? facts.get(id) ?? held?.entities.get(id);
      return entity !== undefined && isStoredWithoutProject(entity);
    }).sort();
    const extra = (key, value) => (held?.collections[key] ? reemit(value, WITHHELD_EXTRAS[key], held.collections[key]) : value);
    return {
      ...nativeCollections(held),
      ...(pending.length ? { [STORED_WITHOUT_PROJECT]: pending } : {}),
      ...Object.fromEntries([...extras].map(([key, value]) => [key, clone(extra(key, value))])),
      ...Object.fromEntries(Object.keys(WITHHELD_EXTRAS).filter((key) => held?.collections[key] && !extras.has(key)).map((key) => [key, clone(extra(key, []))]))
    };
  }

  // The public export (`GET /records`, the `list` verb, markdown push): a read
  // like any other, of one scope (P1 reconciliation F-01). It holds the
  // records, facts, relations, review signals and breadcrumbs that scope may
  // see, and nothing of the store itself -- no journal, idempotency, revision
  // or sequence, and no collection this build cannot interpret, the authority
  // collections among them -- and it says what it is, so no import, save or
  // restore takes it for a store.
  function exportData(options = {}) {
    const boundary = readBoundary(options);
    const view = scopedView(boundary);
    return {
      exportKind: PUBLIC_EXPORT_KIND,
      schemaVersion: SCHEMA_VERSION,
      records: view.records.map(clone), facts: view.facts.map(clone), relations: view.relations.map(clone),
      reviewSignals: view.reviewSignals.map(clone), events: view.events.map(clone),
      completeness: scopeCompleteness(boundary.scope, {
        complete: true,
        losslessItems: true,
        limitation: { code: 'scoped_coverage', detail: 'Only what this scope may read. A public export is not a store: it has no journal, and nothing imports, saves or restores it.' }
      }, view.reviewSignals)
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
    // The view the data brings, or else the one installed (PR-37a, R-4):
    // a reload brings a fresh one, and a rollback keeps the current one.
    const view = data?.[DELETION_VIEW] ?? deletion.get('view');
    // Any parse/migration failure throws HERE, before a single live map is cleared.
    try {
      staging.importData(withView(data, view));
    } catch (cause) {
      const error = new Error(`Refusing to replace data: ${cause.message}`);
      if (cause.code !== undefined) error.code = cause.code;
      if (cause.issues !== undefined) error.issues = cause.issues;
      error.cause = cause;
      throw error;
    }
    const check = privilegedValidate(staging);
    const blocking = check.issues.filter((issue) => issue.severity === 'error');
    if (blocking.length) {
      const error = new Error(`Refusing to replace data: ${blocking.length} blocking issue(s) — ${[...new Set(blocking.map((issue) => issue.code))].join(', ')}`);
      error.issues = blocking;
      throw error;
    }
    // The staged snapshot is already migrated and validated, so this import cannot
    // fail. Only now is the live state discarded.
    const staged = privilegedSnapshot(staging);
    // The purge intents the data carries, or none (PR-37d design §2.2): a
    // rollback to a privileged snapshot puts back exactly the ones it had, and
    // a reload, whose payload carries none, drops them.
    const intents = data?.[DELETION_INTENT];
    clearLive();
    if (intents?.length) deletion.set('intents', structuredClone(intents));
    else deletion.delete('intents');
    return importWithView(staged, view);
  }

  // The purge intents stay: unhold() clears through here (PR-37d design §2.2).
  function clearLive() {
    records.clear(); captures.clear(); currentMemories.clear(); facts.clear(); currentFacts.clear(); relations.clear(); reviewSignals.clear(); idempotency.clear(); extras.clear(); projectlessLegacy.clear();
    deletion.delete('held');
    events.length = 0; journal.length = 0; revision = 0; journalSeq = 0; journalEpoch = null;
  }

  // A public import (design §4, §11 R-6). Into a graph that holds anything --
  // W included -- it is a merge, and a merge that deletion knowledge applies
  // to is refused: this build cannot merge it. A load into an empty graph, and
  // replaceData's own import, are not merges.
  function importData(data = []) {
    if ((holdsData() || retentionPolicy().length) && mergeNeedsDeletionSemantics(data)) {
      throw deletionError(PURGE_AWARE_RESTORE_UNSUPPORTED, 'Refusing to import: deletion records apply to this merge, and this build cannot honour them in a merge; a later ShadowGraph build is needed');
    }
    return importWithView(data, data?.[DELETION_VIEW]);
  }

  // The import, then W held apart under the view: the one installed, or the
  // one the data brings (design §2.1).
  function importWithView(data, view) {
    if (view) deletion.set('view', view);
    const imported = importPayload(data);
    hold();
    return imported;
  }

  function importPayload(data = []) {
    const source = Array.isArray(data) ? { records: data } : data;
    if (source === null || typeof source !== 'object') throw new Error('Import data must be an object or an array of records');
    refusePublicExport(source);
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
    // A capture item has no legacy form to migrate from: it is kept as it came.
    const importedRecords = (source.records ?? []).map((item) => (item.kind === CAPTURE_KIND ? clone(item) : migrateRecord(item)));
    const importedFacts = (source.facts ?? []).map((fact, index, allFacts) => {
      const factId = fact.id ?? legacyFactId(fact, index, allFacts);
      return migrateFact({ ...fact, id: factId });
    });
    // Legacy entities stored with no project, which the migrations above placed
    // in "default". Held by object, so the legacy id remapping below cannot lose
    // track of them. The list an earlier save kept names the rest.
    const storedWithoutProject = (item) => typeof item?.attribution !== 'string' && (item?.project === undefined || item?.project === null);
    const projectless = [
      ...(source.records ?? []).map((item, index) => storedWithoutProject(item) && importedRecords[index]),
      ...(source.facts ?? []).map((item, index) => storedWithoutProject(item) && importedFacts[index])
    ].filter((entity) => entity?.project === 'default');
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
    const importedExtras = extraCollections(source).filter(([key]) => key !== STORED_WITHOUT_PROJECT).map(([key, value]) => [key, clone(value)]);
    // Capture's collections merge by key, as records do: an import never
    // drops another capture's raw text or session (PR-33).
    for (const extra of importedExtras) {
      const [key, value] = extra;
      if (!CAPTURE_COLLECTIONS.includes(key)) continue;
      const keyName = key === CAPTURE_CONTENT ? 'contentRef' : 'id';
      const held = new Map((extras.get(key) ?? []).map((item) => [item[keyName], item]));
      const owner = (item) => JSON.stringify([item?.attribution, item?.project, item?.originId, key === CAPTURE_CONTENT ? null : item?.sessionId]);
      const moved = value.findIndex((item) => held.has(item?.[keyName]) && owner(held.get(item[keyName])) !== owner(item));
      if (moved !== -1) throw captureCollectionError(`${key} entry ${moved} would change the owner of an entry the store holds`);
      const incoming = new Set(value.map((item) => item[keyName]));
      extra[1] = [...(extras.get(key) ?? []).filter((item) => !incoming.has(item[keyName])), ...value];
      const issue = captureCollectionIssue(key, extra[1]);
      if (issue) throw captureCollectionError(issue);
    }
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
      const used = new Set(importedRecords.filter((record) => record.kind === CAPTURE_KIND).map((record) => record.id));
      for (const [index, record] of importedRecords.entries()) {
        if (record.kind === CAPTURE_KIND) continue;
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

      // A legacy collision renames the LATER entity, so the old id survives on the
      // earlier one. Any reference still holding that id therefore resolves to a
      // different entity than it may have meant -- and it resolves silently,
      // because the endpoint still exists. Schemas 1-3 ids were collection-local
      // and carry no kind, so which entity was intended is genuinely unknowable.
      // Rebinding would be inventing a link, so the ambiguity is marked here and
      // reported by validate(), the same way a duplicate active fact scope is
      // declared rather than resolved by rule.
      const ambiguousLegacyIds = new Set([...legacyIdRemaps.keys()].map((key) => key.slice(key.indexOf(':') + 1)));
      if (ambiguousLegacyIds.size) {
        for (const relation of importedRelations) {
          const endpoints = ['from', 'to'].filter((side) => ambiguousLegacyIds.has(relation[side]));
          if (endpoints.length) relation.migration = { ...(relation.migration ?? {}), ambiguousLegacyEndpoints: endpoints };
        }
        for (const record of importedRecords) {
          if (record.kind === CAPTURE_KIND) continue;
          const fields = ['supersedes', 'supersededBy', 'relatedTo', 'failedAttempts'].filter((field) => {
            const value = record[field];
            return Array.isArray(value) ? value.some((item) => ambiguousLegacyIds.has(item)) : ambiguousLegacyIds.has(value);
          });
          if (fields.length) record.migration = { ...(record.migration ?? {}), ambiguousLegacyReferences: fields };
        }
      }
    }
    {
      const importedAlternatives = importedRecords.flatMap((record) => record.alternatives ?? []);
      assertUniqueEntityIds(importedRecords, importedAlternatives, importedFacts, importedRelations);
      const existingAlternativeOwners = new Map();
      for (const record of records.values()) for (const alternative of record.alternatives ?? []) existingAlternativeOwners.set(alternative.id, record.id);
      // Plan rev6 §3.2: the erasureToken is internal, so a merged entity that
      // names none -- one built from a public result -- keeps the one it has. A
      // merge never changes or drops a token.
      const journalless = !(Array.isArray(source.journal) && source.journal.length);
      const liveTokenHolders = new Map([...records.values(), ...captures.values(), ...facts.values()].filter((entity) => entity.erasureToken !== undefined).map((entity) => [entity.erasureToken, entity.id]));
      const keepErasureToken = (existing, item) => {
        if (existing?.erasureToken !== undefined && item.erasureToken !== existing.erasureToken) {
          if (item.erasureToken !== undefined || !journalless) throw new Error(`Existing entity id ${item.id} cannot change or drop its erasureToken`);
          item.erasureToken = existing.erasureToken;
        }
        const holder = liveTokenHolders.get(item.erasureToken);
        if (item.erasureToken !== undefined && holder !== undefined && holder !== item.id) throw new Error(`${item.id} would share an erasureToken with ${holder}`);
      };
      for (const record of importedRecords) {
        const existingRecord = records.get(record.id) ?? captures.get(record.id);
        if (existingRecord && (existingRecord.kind !== record.kind || existingRecord.project !== record.project || !sameOwnerKey(existingRecord, record))) throw new Error(existingRecord.kind !== record.kind || existingRecord.project !== record.project
          ? `Existing entity id ${record.id} cannot change kind or project` : `Existing entity id ${record.id} cannot change owner`);
        keepErasureToken(existingRecord, record);
        // PR-23: a legacy attempt's cause is shown, not stored, so one merged
        // back from a public result keeps none.
        if (journalless && existingRecord?.kind === 'attempt' && existingRecord.causalClaim === undefined && !isFutureEntity(record) && JSON.stringify(record.causalClaim) === JSON.stringify(causalClaimFor(record.reason, { legacy: true }))) delete record.causalClaim;
        if (existingRecord?.kind === 'memory' && memoryScopeKey(existingRecord) !== memoryScopeKey(record)) throw new Error(`Existing memory id ${record.id} cannot change scope, type, or key`);
        if (facts.has(record.id) || relations.has(record.id) || (existingAlternativeOwners.has(record.id) && existingAlternativeOwners.get(record.id) !== record.id)) throw new Error(`Entity id already exists: ${record.id}`);
        for (const alternative of record.alternatives ?? []) {
          const existingOwner = existingAlternativeOwners.get(alternative.id);
          if (records.has(alternative.id) || captures.has(alternative.id) || facts.has(alternative.id) || relations.has(alternative.id) || (existingOwner && existingOwner !== record.id)) throw new Error(`Entity id already exists: ${alternative.id}`);
        }
      }
      const importedCaptureIds = new Set(importedRecords.filter((record) => record.kind === CAPTURE_KIND).map((record) => record.id));
      for (const fact of importedFacts) {
        if (records.has(fact.id) || captures.has(fact.id) || relations.has(fact.id) || existingAlternativeOwners.has(fact.id)) throw new Error(`Entity id already exists: ${fact.id}`);
        const existingFact = facts.get(fact.id);
        if (existingFact && (existingFact.project !== fact.project || !sameOwnerKey(existingFact, fact))) throw new Error(existingFact.project !== fact.project
          ? `Existing entity id ${fact.id} cannot change kind or project` : `Existing entity id ${fact.id} cannot change owner`);
        keepErasureToken(existingFact, fact);
      }
      for (const relation of importedRelations) {
        if (records.has(relation.id) || captures.has(relation.id) || facts.has(relation.id) || existingAlternativeOwners.has(relation.id)) throw new Error(`Entity id already exists: ${relation.id}`);
        if ([relation.from, relation.to].some((endpoint) => captures.has(endpoint) || importedCaptureIds.has(endpoint))) throw new Error('Relation endpoints must exist before import, and a capture item is never one');
        const existingRelation = relations.get(relation.id);
        if (existingRelation && (existingRelation.project !== relation.project || !sameOwnerKey(existingRelation, relation) || existingRelation.from !== relation.from || existingRelation.to !== relation.to || existingRelation.relation !== relation.relation)) throw new Error(`Existing relation id ${relation.id} cannot change identity`);
      }
      // Nor may a relation the store holds come to name one.
      for (const relation of relations.values()) if (importedCaptureIds.has(relation.from) || importedCaptureIds.has(relation.to)) throw new Error('Relation endpoints must exist before import, and a capture item is never one');
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
      const finalRecords = new Map([...records, ...captures]);
      const finalFacts = new Map(facts);
      for (const record of importedRecords) finalRecords.set(record.id, record);
      for (const fact of importedFacts) finalFacts.set(fact.id, fact);
      const reviewOwners = new Map([...reviewSignals.values()].map((signal) => [signal.id, reviewSignalKey(signal.decisionId, signal.reason, signal.coverage)]));
      const incomingReviewIds = new Set();
      const existingReviewIdentities = new Map([...reviewSignals.values()].map((signal) => [reviewSignalKey(signal.decisionId, signal.reason, signal.coverage), signal.id]));
      const incomingReviewIdentities = new Set();
      for (const signal of importedSignals) {
        if (!signal || typeof signal.id !== 'string' || !signal.id || typeof signal.decisionId !== 'string' || !signal.decisionId || typeof signal.reason !== 'string' || !signal.reason) throw new Error('Review signal is malformed');
        if (incomingReviewIds.has(signal.id)) throw new Error(`Duplicate review signal id ${signal.id}`);
        incomingReviewIds.add(signal.id);
        const ownerKey = reviewSignalKey(signal.decisionId, signal.reason, signal.coverage);
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
        // A retry value built from a public result omits the erasure token, and so carries its entity's.
        if (value.erasureToken === undefined && entity.erasureToken !== undefined && !(Array.isArray(source.journal) && source.journal.length)) value.erasureToken = entity.erasureToken;
        // The value is checked in the migrated form its entity has, as the
        // semantic check below always was. A legacy entity stored with no
        // project is filed under "default" by migration; so is a retry value
        // that stores no project, which is what a rebuild replays from that
        // entity's own journal entry (F-26). Owners are compared by the one
        // owner model, so a legacy retry value never names a real-"default"
        // entity, nor a real-"default" value a legacy one.
        const migratedValue = value.kind === 'fact' ? migrateFact(value) : migrateRecord(value);
        const sameOwner = entity.project === migratedValue.project && sameOwnerKey(entity, migratedValue)
          && (entity.attribution === 'unattributed') === (value.attribution === 'unattributed')
          && (value.attribution !== 'unattributed' || (usableOriginId(value.originId) !== null && entity.originId === value.originId));
        if (entity.kind !== value.kind || !sameOwner || !item.key.startsWith(idempotencyKeyPrefix(migratedValue))) throw new Error('Idempotency entry identity does not match its entity');
        if (value.kind === 'memory' && memoryScopeKey(entity) !== memoryScopeKey(value)) throw new Error('Idempotency entry identity does not match its entity');
        if (!idempotencySemanticallyMatches(migratedValue, entity)) throw new Error(`Idempotency entry semantic mismatch with canonical entity ${value.id}`);
        item.value = clone(entity);
      }
    }
    if (!(Array.isArray(source.journal) && source.journal.length) && (importedRecords.length || importedFacts.length || importedRelations.length || importedIdempotency.length)) {
      const sameSnapshot = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
      const finalRecords = new Map([...records, ...captures]);
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
        const previous = records.get(item.id) ?? captures.get(item.id);
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
        // An item of a newer schema is carried under a plain state change.
        if (item.kind === CAPTURE_KIND) return Object.hasOwn(CAPTURE_IMPORT_TYPE, item.state) ? CAPTURE_IMPORT_TYPE[item.state] : CAPTURE_IMPORT_TYPE.processing;
        throw new Error(`Cannot journal imported entity kind ${item.kind}`);
      };
      const originalEntity = (item) => item.kind === 'fact'
        ? facts.get(item.id)
        : item.kind === 'relation'
          ? relations.get(item.id)
          : records.get(item.id) ?? captures.get(item.id);
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
    for (const item of importedRecords) (item.kind === CAPTURE_KIND ? captures : records).set(item.id, item);
    recomputeCurrentMemories();
    for (const fact of importedFacts) facts.set(fact.id, fact);
    recomputeCurrentFacts();
    for (const relation of importedRelations) relations.set(relation.id, relation);
    for (const signal of importedSignals) reviewSignals.set(reviewSignalKey(signal.decisionId, signal.reason, signal.coverage), signal);
    for (const item of pendingIdempotencyUpdates) idempotency.set(item.key, item.value);
    for (const importedEvent of importedEvents) events.push(importedEvent);
    for (const [key, value] of importedExtras) extras.set(key, value);
    if (extras.has('access')) extras.set('access', reconcileAccessLedger(extras.get('access'), extras.get('accessRevocations')));
    for (const entity of projectless) projectlessLegacy.set(entity.id, true);
    for (const id of source[STORED_WITHOUT_PROJECT] ?? []) projectlessLegacy.set(id, true);

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

  function recomputeCurrentMemories() {
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
  }

  function recomputeCurrentFacts() {
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
      const scope = JSON.stringify([ownerKey(fact, (project) => project ?? 'default'), fact.key]);
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
  }

  // The journal entries of the request's scope (P1 reconciliation F-09, F-16):
  // none with no project and no origin, never an entry that names an id
  // outside the scope, and only the gaps the scope's own purges left.
  function getJournal(options = {}) {
    const boundary = readBoundary(options);
    const entries = scopedView(boundary).journal;
    return scopedPage(entries.map(clone), options, boundary, {}, {
      gaps: explainedGaps(entries),
      limitation: { code: 'scoped_coverage', detail: 'Only entries that name nothing outside this scope, and only the gaps this scope\'s own purges left; journal integrity outside this scope is not reported.' }
    });
  }

  // Rebuild a projection from this graph's own journal, then pass the exposed
  // projection through the same schema migration and verifier policy as a normal
  // import. The raw journal remains immutable audit evidence inside this graph.
  //
  // This is the whole-store replay, and it is privileged (P1 reconciliation
  // F-17): restore validation compares it with the whole live store. The
  // public rebuild() below reports the same fold, of the request's scope only.
  function replay(options = {}) {
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
      const validation = privilegedValidate(staging);
      const blocking = validation.issues.filter((issue) => issue.severity === 'error' || issue.severity === 'unsupported');
      if (blocking.length) throw new Error(`Rebuilt projection has ${blocking.length} blocking validation issue(s)`);
      const normalized = privilegedSnapshot(staging);
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

  // The public replay (P1 reconciliation F-17): whether the journal folds is a
  // verdict on the whole store and names nothing, but the projection holds only
  // the request's scope and the entry-level diagnostics only its own entries.
  // With no project and no origin the projection is empty.
  function rebuild(options = {}) {
    const boundary = readBoundary(options);
    const report = replay(options);
    const recordsInScope = report.projection.records.filter((item) => item.kind !== CAPTURE_KIND && boundary.visible(item));
    const factsInScope = report.projection.facts.filter(boundary.visible);
    const ids = new Set([...recordsInScope, ...factsInScope].map((item) => item.id));
    // A diagnostic is listed unless it names something outside the scope: an
    // entry by sequence (the scope's only when every entry carrying it is), a
    // legacy entry by id, or a relation. One about the fold itself names nothing.
    const view = scopedView(boundary);
    const entries = new Set(view.journal);
    const entryIds = new Set(view.journal.map((entry) => entry?.id));
    const relationIds = new Set(view.relations.map((relation) => relation.id));
    const ownSequences = new Map();
    for (const entry of journal) ownSequences.set(entry?.seq, (ownSequences.get(entry?.seq) ?? true) && entries.has(entry));
    const own = (items) => items.filter((item) => {
      if (Number.isInteger(item?.seq)) return ownSequences.get(item.seq) === true;
      if (item?.id !== undefined && item?.id !== null) return entryIds.has(item.id);
      if (item?.relationId !== undefined) return relationIds.has(item.relationId);
      return true;
    });
    return scopedResult({
      ok: report.ok, rebuildable: report.rebuildable,
      // Preserve the whole-store verdict without global sequence diagnostics.
      reason: report.reason?.startsWith('journal contains duplicate sequence numbers (') ? 'The journal contains duplicate sequence numbers, so entry order is ambiguous.' : report.reason,
      projection: {
        schemaVersion: report.projection.schemaVersion,
        records: recordsInScope,
        facts: factsInScope,
        relations: report.projection.relations.filter((relation) => ids.has(relation.from) && ids.has(relation.to)),
        idempotency: report.projection.idempotency.filter((item) => ids.has(item?.value?.id))
      },
      skipped: own(report.skipped).map((item) => item.why === 'invalid_exposed_projection_verification'
        ? { ...item, detail: 'Whole-store projection validation failed. Its unscoped diagnostics are not exposed by this read.' }
        : item),
      legacy: own(report.legacy),
      duplicates: own(report.duplicates),
      completeness: { complete: report.rebuildable, limitation: { code: 'scoped_coverage', detail: 'Whether the journal rebuilds is the verdict on the whole store. The projection and the entry diagnostics hold only this scope; an unsuccessful rebuild does not establish complete projection coverage.' } },
      limitation: { code: 'scoped_coverage', detail: 'Whether the journal rebuilds is the verdict on the whole store. The projection and the entry diagnostics hold only this scope.' }
    }, boundary);
  }

  // Counts of what the request's scope may see (plan v1.4.4 PR-10): with no
  // project and no origin, all zero.
  function stats(options = {}) {
    const boundary = readBoundary(options);
    const view = scopedView(boundary);
    return scopedResult({ schemaVersion: SCHEMA_VERSION, total: view.records.length, decisions: view.records.filter((x) => x.kind === 'decision').length, attempts: view.records.filter((x) => x.kind === 'attempt').length, facts: view.facts.length, relations: view.relations.length, reviewSignals: view.reviewSignals.length, events: view.events.length, journal: view.journal.length }, boundary, view.reviewSignals);
  }

  return registerPrivileged(tokenFreeApi({
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
    memoryHistory: auditedRead('memoryHistory', memoryHistory),
    addFact: transactional('addFact', addFact),
    migrateAttribution: transactional('migrateAttribution', migrateAttribution),
    backfillErasureTokens: transactional('backfillErasureTokens', backfillErasureTokens),
    attribute: transactional('attribute', attribute, { mode: 'snapshot' }),
    legacyAttributionReview,
    verifyFact: transactional('verifyFact', verifyFact),
    setOutcome: transactional('setOutcome', setOutcome),
    addConfidenceEvidence: transactional('addConfidenceEvidence', addConfidenceEvidence),
    updateDecisionStatus: transactional('updateDecisionStatus', updateDecisionStatus),
    supersedeDecision: transactional('supersedeDecision', supersedeDecision),
    link: transactional('link', link),
    traverse: auditedRead('traverse', traverse),
    expand: auditedRead('expand', expand),
    redact: auditedRead('redact', redact),
    projectSummary,
    // No caller forces a marker (PR-37d design §2.5): only the mode reaches it.
    purgeProject: transactional('purgeProject', (project, options) => purgeProject(project, { mode: options?.mode, hard: options?.hard }), { mode: 'snapshot' }),
    review: auditedRead('review', review),
    reconsider: auditedRead('reconsider', reconsider),
    maintain: auditedRead('maintain', maintain),
    getReviewSignals: auditedRead('getReviewSignals', getReviewSignals),
    acknowledgeReview: transactional('acknowledgeReview', acknowledgeReview),
    search: auditedRead('search', search),
    retrieve: auditedRead('retrieve', retrieve),
    recall: auditedRead('recall', recall),
    validate: auditedRead('validate', validate),
    repairPlan: auditedRead('repairPlan', repairPlan),
    context: auditedRead('context', context),
    reviewContext: auditedRead('reviewContext', reviewContext),
    exportData: auditedRead('exportData', exportData),
    importData: transactional('importData', importData),
    getJournal: auditedRead('getJournal', getJournal),
    rebuild: auditedRead('rebuild', rebuild),
    stats: auditedRead('stats', stats),
    requestAccess: transactional('requestAccess', authority.request),
    issueAccess: transactional('issueAccess', authority.issue),
    revokeAccess: transactional('revokeAccess', authority.revoke),
    discardAccess: transactional('discardAccess', authority.discard)
  }), { snapshot, liveSnapshot, withheldCounts, validate: integrity, rebuild: replay,
    issueAccess: transactional('ownerIssueAccess', authority.issueOwner), inspectAccess: authority.inspect,
    accessRefusal: transactional('accessRefusal', authority.transportRefusal),
    bindProject: transactional('bindProject', bindProject), resolveProjectBinding,
    recordCapture: transactional('recordCapture', recordCapture), transitionCapture: transactional('transitionCapture', transitionCapture),
    claimCapture: transactional('claimCapture', claimCapture), completeExtraction: transactional('completeExtraction', completeExtraction, { mode: 'snapshot' }),
    settleExtraction: transactional('settleExtraction', settleExtraction),
    extractionStatus: transactional('extractionStatus', extractionStatus),
    expireCapture: transactional('expireCapture', expireCapture, { mode: 'snapshot' }),
    inspectCapture, requestReprocess: transactional('requestReprocess', requestReprocess), cancelCapture: transactional('cancelCapture', cancelCapture),
    deleteCapture: transactional('deleteCapture', deleteCapture, { mode: 'snapshot' }),
    completeCaptureDelete: transactional('completeCaptureDelete', (input) => deleteCapture(input, { recovery: true }), { mode: 'snapshot' }),
    recordSelfEvent: transactional('recordSelfEvent', recordSelfEvent), recordTranscript: transactional('recordTranscript', recordTranscript),
    reapplyDeletion: transactional('reapplyDeletion', reapplyDeletion, { mode: 'snapshot' }), quarantined,
    completePurge: transactional('completePurge', (project, options) => purgeProject(project, { mode: options.mode, marker: options.marker }), { mode: 'snapshot' }) });
}

// `strict` is for caller writes, where a typo should fail loudly instead of
// becoming a condition that can never fire. Stored records go through the
// lenient path: an operator this build does not recognise is PRESERVED verbatim
// and reported by validate(), never rewritten onto a meaning we guessed. That is
// the same envelope-vs-entity asymmetry used for schema versions -- a future or
// unknown entity is kept and flagged, because losing it is worse.
function normalizeRules(rules, { strict = false } = {}) {
  return rules.map((rule) => {
    if (typeof rule === 'string') return rule;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      if (strict) throw new Error('A reopen/reuse rule must be a string or an object');
      return rule;
    }
    const operator = rule.operator ?? 'equals';
    if (strict) {
      if (typeof rule.key !== 'string' || !rule.key.trim()) throw new Error('A structured rule requires a non-empty key');
      if (!isSupportedOperator(operator)) throw new Error(`Unsupported rule operator ${String(operator)}`);
      if (rule.unit != null && !isSupportedUnit(rule.unit)) throw new Error(`Unsupported rule unit ${String(rule.unit)}`);
      // Already rejected, but only as a side effect of clone() refusing an
      // `undefined` field, which reported "Values must be plain JSON data" and
      // named neither the rule nor the missing operand.
      if (!Object.hasOwn(rule, 'value') || rule.value === undefined) throw new Error(`A structured rule requires a value for operator ${operator}`);
    }
    // Only write `value` when the rule actually carries one. Writing
    // `value: undefined` for a rule with no operand made every later clone() of
    // the record throw, so one such rule arriving through the lenient import
    // path poisoned exportData() and context() for the whole graph. The rule is
    // preserved as stored -- it is never given an operand it did not have.
    const normalized = Object.hasOwn(rule, 'value') && rule.value !== undefined
      ? { key: rule.key, operator, value: rule.value }
      : { key: rule.key, operator };
    // The unit was previously dropped here, so a caller could declare one and
    // have it silently discarded before any comparison saw it.
    if (rule.unit != null) normalized.unit = rule.unit;
    return normalized;
  });
}

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

// Signal identity. `coverage` names the exact set of breached conditions the
// signal stands for, so a decision whose second, stricter alternative starts
// breaching raises its own signal instead of inheriting the acknowledgement of
// the first.
//
// `reason` is deliberately NOT part of the identity. It is a human-readable
// cause list built in stored-rule order, so exporting a decision and re-importing
// it with its alternatives in a different order turned `lag, load` into
// `load, lag` and reopened an acknowledged review covering exactly the same
// breaches. Coverage is a sorted set that already distinguishes everything
// `reason` distinguishes and more, so dropping `reason` costs no discrimination
// and removes the ordering sensitivity. `reason` itself is left exactly as
// built -- canonicalising it would misreport the order the rules are stored in.
//
// Omitting `coverage` reproduces the pre-coverage key byte for byte, which is
// what a signal persisted before coverage existed is still stored under. The two
// forms cannot collide: the second element is a string there and an array here.
function reviewSignalKey(decisionId, reason, coverage) {
  return coverage === undefined
    ? JSON.stringify([decisionId, reason])
    : JSON.stringify([decisionId, [...coverage].sort()]);
}

// A stable name for one breached condition. The alternative's id is assigned at
// write and persists through export, import and rebuild, and the rule is named
// by content rather than by position so reordering `reopenWhen` does not reopen
// a settled review. Matches with no structured rule behind them (a changed-fact
// token, a review date, a failed outcome) carry their own text.
// Reconstruct the coverage a pre-coverage signal actually recorded, or null when
// it cannot be established from what the signal stores.
//
// A signal's `violatedConditions` are a clone of the breaches that raised it, and
// each one names the alternative that carried the rule plus the rule's `key`,
// `operator`, `expected` value and `unit`. That is exactly the input
// conditionCoverageId() needs, so a signal carrying them can be placed precisely.
//
// Two properties make this safe to trust:
//
//   - it can only ever UNDER-state history. `violatedConditions` records rule
//     breaches and nothing else, so a historical match with no rule behind it (a
//     changedFacts token, `review date reached`, `decision outcome failed`) is
//     absent from the reconstruction. The derived set is therefore always a
//     subset of what was really acknowledged, never a superset.
//   - a rule that has since been edited or removed reconstructs to an id that is
//     simply not in today's coverage, so the sets do not match and the caller
//     falls through to a new open signal.
//
// Anything missing, malformed, or empty returns null -- unknown history is not
// evidence of an acknowledgement.
function reconstructedCoverage(signal) {
  const conditions = signal?.violatedConditions;
  if (!Array.isArray(conditions) || conditions.length === 0) return null;
  const derived = [];
  for (const condition of conditions) {
    if (!condition || typeof condition !== 'object' || Array.isArray(condition)) return null;
    if (typeof condition.alternativeId !== 'string' || !condition.alternativeId) return null;
    if (typeof condition.key !== 'string' || !condition.key) return null;
    // Fail closed on anything that does not pin down the historical rule's
    // semantics. An unsupported or non-string operator, an unreadable unit, or a
    // missing operand all mean the old breach cannot be identified -- and an
    // absent operand is especially dangerous here, because JSON.stringify drops
    // an `undefined` field, so the identity would silently shrink to a shorter
    // shape and could collide with a rule that genuinely states no operand.
    if (!isSupportedOperator(condition.operator)) return null;
    if (condition.unit != null && !isSupportedUnit(condition.unit)) return null;
    const rule = Object.hasOwn(condition, 'expected') && condition.expected !== undefined
      ? { key: condition.key, operator: condition.operator, value: condition.expected }
      : { key: condition.key, operator: condition.operator };
    if (condition.unit != null) rule.unit = condition.unit;
    if (ruleOperandIssue(rule)) return null;
    derived.push(conditionCoverageId({ id: condition.alternativeId }, rule));
  }
  return [...new Set(derived)].sort();
}

function sameCoverage(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((item, index) => item === right[index]);
}

function conditionCoverageId(alternative, rule) {
  return rule === null
    ? JSON.stringify(['match', alternative])
    : JSON.stringify(['rule', alternative.id, canonical(rule)]);
}

function sameMemoryScopeValues(left, right) {
  const a = normalizeMemoryScope(left);
  const b = normalizeMemoryScope(right);
  return a.userId === b.userId && a.agentId === b.agentId && a.runId === b.runId;
}

function memoryScopeKey(input) {
  const scope = normalizeMemoryScope(input.scope);
  return JSON.stringify([ownerKey(input, normalizeProject), scope.userId, scope.agentId, scope.runId, input.memoryType ?? null, input.key ?? null]);
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

// The expansion budget (AC-032): counterparts fetched in full per expansion,
// and the fewest counterpart positions an expansion lists.
const DEFAULT_EXPANSIONS = 5;
const MAX_EXPANSIONS = 50;
const MIN_POSITIONS = 10;
// A link field as a list of ids: a memory stores one id, a decision a list.
const linkIds = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]).filter((id) => typeof id === 'string');

function validateExpandInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('expand input must be an object');
  for (const name of ['recordId', 'digest']) if (typeof input[name] !== 'string' || !input[name]) throw new Error(`${name} must be a non-empty string`);
  if (input.derivationVersion !== undefined && typeof input.derivationVersion !== 'string') throw new Error('derivationVersion must be a string');
  if (input.maxExpansions !== undefined && !(Number.isInteger(input.maxExpansions) && input.maxExpansions >= 0 && input.maxExpansions <= MAX_EXPANSIONS)) {
    throw new Error(`maxExpansions must be an integer from 0 to ${MAX_EXPANSIONS}`);
  }
  validateTemporalFields(input, ['asOf', 'derivedAt']);
}

// A fact's validity window: from its declared start (or observation) to the
// kernel's effective expiration boundary; either end may be unknown.
function validityWindow(fact) {
  const from = fact.temporal?.validFrom ?? fact.validFrom ?? fact.observedAt ?? null;
  const to = effectiveFactExpirationBoundary(fact) ?? null;
  return { from: isValidIsoInstant(from) ? from : null, to: isValidIsoInstant(to) ? to : null };
}

function validateRelevanceInput(input) {
  for (const name of ['query', 'focalId']) if (input[name] != null && typeof input[name] !== 'string') throw new Error(`${name} must be a string`);
  if (input.compact !== undefined && typeof input.compact !== 'boolean') throw new Error('compact must be a boolean');
  validateTemporalFields(input, ['asOf']);
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

// A stored item keeps the raw label it was recorded with. Re-deriving it from
// the already-resolved sourceClass dropped it on every load, so the next save
// removed it. A caller recording evidence still cannot set it directly.
function normalizeEvidence(item, clock = () => new Date().toISOString(), { stored = false } = {}) {
  const base = typeof item === 'string' ? { source: item } : (item ?? {});
  const derived = normalizeSourceClass(base.sourceClass ?? base.type ?? base.source);
  const sourceClass = derived.sourceClass;
  const sourceRaw = stored && typeof base.sourceRaw === 'string' ? base.sourceRaw : derived.sourceRaw;
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
  if (array(STORED_WITHOUT_PROJECT).some((id) => typeof id !== 'string' || !id)) throw new Error(`${STORED_WITHOUT_PROJECT} must be an array of entity ids`);
  // PR-28a: the runtime miss ledger's shape is frozen; import and restore
  // refuse anything else.
  if (source[RUNTIME_MISSES] !== undefined) {
    const issue = runtimeMissLedgerIssue(source[RUNTIME_MISSES]);
    if (issue) {
      const error = new Error(`The runtime miss ledger is malformed (runtime_miss_ledger_malformed): ${issue}`);
      error.code = 'runtime_miss_ledger_malformed';
      throw error;
    }
  }
  // PR-33: so do capture's own collections.
  for (const name of CAPTURE_COLLECTIONS) {
    if (source[name] === undefined) continue;
    const issue = captureCollectionIssue(name, source[name]);
    if (issue) throw captureCollectionError(issue);
  }
  for (const [index, item] of array('records').entries()) {
    if (!item || typeof item !== 'object' || !['decision', 'attempt', 'memory', CAPTURE_KIND].includes(item.kind)) throw new Error(`records[${index}] is malformed`);
    if (typeof item.id !== 'string' || !item.id) throw new Error(`records[${index}].id must be a non-empty string`);
    if (item.kind === CAPTURE_KIND) {
      // A store that carries capture says its schema. A legacy one may be the
      // fold of an older store (replay() imports at its lowest entity
      // version); its migrations never rename a capture, and no relation may
      // name one.
      if (!Number.isInteger(source.schemaVersion)) throw new Error(`records[${index}] is a capture item, which only a store that declares its schemaVersion carries`);
      if (item.project !== null && (typeof item.project !== 'string' || !item.project.trim())) throw new Error(`records[${index}].project must be a non-empty string or null`);
      const captureIssue = isFutureEntity(item) ? null : captureItemIssue(item);
      if (captureIssue) throw new Error(`records[${index}] is not a well-formed capture item: ${captureIssue}`);
      continue;
    }
    const recordClaimIssue = isFutureEntity(item) ? null : claimModelIssue(item);
    if (recordClaimIssue) throw new Error(`records[${index}] violates the claim model: ${recordClaimIssue}`);
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
      const ownerless = item.project === null && ['unattributed', 'legacy_unattributed'].includes(item.attribution);
      if (item.project !== undefined && typeof item.project !== 'string' && !ownerless) throw new Error(`records[${index}].project must be a string`);
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
    const factClaimIssue = isFutureEntity(fact) ? null : claimModelIssue(fact);
    if (factClaimIssue) throw new Error(`facts[${index}] violates the claim model: ${factClaimIssue}`);
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
    if (factSchemaVersion >= 5 && factSchemaVersion <= READABLE_SCHEMA_VERSION) {
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
    const relationTokenIssue = isFutureEntity(relation) ? null : erasureTokenIssue(relation);
    if (relationTokenIssue) throw new Error(`relations[${index}] violates the claim model: ${relationTokenIssue}`);
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
    // A future entry of either type is carried, never judged (FND-P3-03). A
    // capture's attribution is read as any entity's is (PR-33).
    const attributableKinds = entry.type === 'entity.attributed' ? ATTRIBUTION_ENTRY_KINDS : ATTRIBUTED_ENTITY_KINDS;
    if (['entity.attributed', 'entity.token_assigned'].includes(entry.type) && !isFutureEntity(entry) && entry.entityKind != null && !attributableKinds.includes(entry.entityKind)) throw new Error(`journal[${index}] type ${entry.type} requires entityKind ${attributableKinds.join(', ')}`);
    const entryClaimIssue = isPlainObject(entry.payload) && entry.type !== 'projection.baseline' && entry.payload.kind !== CAPTURE_KIND && !isFutureEntity(entry) && !isFutureEntity(entry.payload) ? claimModelIssue(entry.payload) : null;
    if (entryClaimIssue) throw new Error(`journal[${index}] payload violates the claim model: ${entryClaimIssue}`);
    if (entry.type === 'projection.baseline' && !isFutureEntity(entry)) {
      const baselineEntities = [...(entry.payload?.records ?? []), ...(entry.payload?.facts ?? []), ...(entry.payload?.relations ?? []), ...(entry.payload?.idempotency ?? []).map((item) => item?.value)];
      const baselineIssue = baselineEntities.filter((entity) => isPlainObject(entity) && !isFutureEntity(entity)).map(storedEntityIssue).find(Boolean);
      if (baselineIssue) throw new Error(`journal[${index}] projection.baseline payload violates the claim model: ${baselineIssue}`);
    }
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
  const hardPurgeMarkers = array('journal').filter((entry) => HARD_GAP_EVIDENCE_TYPES.includes(entry?.type) && entry?.payload?.mode === 'hard');
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
    const valueClaimIssue = isFutureEntity(item.value) ? null : storedEntityIssue(item.value);
    if (valueClaimIssue) throw new Error(`idempotency[${index}].value violates the claim model: ${valueClaimIssue}`);
  }
  // A purge tombstone names exactly one entity by its token.
  const tokenHolders = new Map();
  for (const entity of [...array('records'), ...array('facts')]) {
    if (isFutureEntity(entity) || entity.erasureToken === undefined) continue;
    const holder = tokenHolders.get(entity.erasureToken);
    if (holder !== undefined && holder !== entity.id) throw new Error(`${holder} and ${entity.id} share an erasureToken`);
    tokenHolders.set(entity.erasureToken, entity.id);
  }
  const eventIds = new Set();
  for (const [index, eventItem] of array('events').entries()) {
    if (!eventItem || typeof eventItem !== 'object' || Array.isArray(eventItem) || typeof eventItem.id !== 'string' || typeof eventItem.type !== 'string') throw new Error(`events[${index}] is malformed`);
    const captureIssue = captureEventIssue(eventItem);
    if (captureIssue) throw new Error(`events[${index}] ${captureIssue}`);
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

// A schema-6 entity already says whose it is. Its project is kept exactly as
// stored -- null for an unattributed one -- and never defaulted to "default",
// which would hand it to a project it does not belong to.
function keepAttributedProject(migrated, source) {
  if (typeof source.attribution === 'string') migrated.project = source.project ?? null;
  return migrated;
}

function migrateRecord(item) {
  return keepAttributedProject(migrateRecordFields(item), item);
}

function migrateRecordFields(item) {
  if (item.kind === 'memory') {
    const source = clone(item);
    const recordedAt = source.temporal?.recordedAt ?? source.createdAt ?? null;
    return {
      schemaVersion: PRE_ATTRIBUTION_SCHEMA_VERSION,
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
  if (item.kind !== 'decision') return { schemaVersion: PRE_ATTRIBUTION_SCHEMA_VERSION, project: 'default', ...clone(item) };
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
    schemaVersion: Number.isInteger(source.schemaVersion) && source.schemaVersion > PRE_ATTRIBUTION_SCHEMA_VERSION ? source.schemaVersion : PRE_ATTRIBUTION_SCHEMA_VERSION,
    project: source.project ?? 'default', confidence,
    ...(legacyDecisionStatus ? {
      status: migratedDecisionStatus,
      migration: { ...(source.migration ?? {}), legacyDecisionStatus }
    } : {}),
    evidence: (source.evidence ?? []).map((entry) => normalizeEvidence(entry, undefined, { stored: true })),
    alternatives: (source.alternatives ?? []).map((a, index) => ({ ...a, id: a.id ?? `alternative_${source.id}_${index}`, reopenWhen: normalizeRules(a.reopenWhen ?? []) }))
  };
}

// B-5: a legacy fact carried `source:'unknown'` and no sourceClass at all, so
// anything reading sourceClass got undefined. Backfill the class from the stored
// label, keep the original verbatim, and NEVER raise verification (contract §6).
function migrateFact(fact) {
  return keepAttributedProject(migrateFactFields(fact), fact);
}

function migrateFactFields(fact) {
  const source = clone(fact);
  // P2-14: a fact written by a NEWER build keeps its own schemaVersion rather than
  // being relabelled as one this build understands. validate() reports it as
  // `unsupported` so the caller learns we cannot fully interpret it.
  const future = Number.isInteger(source.schemaVersion) && source.schemaVersion > PRE_ATTRIBUTION_SCHEMA_VERSION;
  const imported = { project: 'default', confidence: 0.5, status: 'active', ...source, schemaVersion: future ? source.schemaVersion : PRE_ATTRIBUTION_SCHEMA_VERSION };
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
// The same fold the recall() tokenizer uses, deliberately shared rather than
// reimplemented: two search paths with two different ideas of what counts as the
// same character is how they drift apart.
//
// Substring matching is preserved exactly. This only widens what counts as the
// same character, so `cach` still matches `cache` and the declared-content-field
// rule is untouched. It can only add matches, never remove one.
export const foldForMatch = foldText;

// Same declared content fields, but compared on the stored text with only case
// folded away -- no diacritic or orthographic folding. Used for ranking, never
// for deciding whether a record matches, so it cannot narrow a result set.
function matchFieldsExact(record, needle) {
  return matchFieldsWith(record, needle, (value) => String(value ?? '').toLocaleLowerCase().includes(needle));
}

function matchFields(record, needle) {
  return matchFieldsWith(record, needle, (value) => foldForMatch(value).includes(needle));
}

function matchFieldsWith(record, needle, has) {
  const fields = [];
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
// Folding decides WHETHER a record matches; this decides what ranks first among
// those that do.
//
// Folding is what makes an Arabic record findable at all, but it also collapses
// real minimal pairs -- على with علي, آمن with امن -- and once collapsed, a
// record holding the word the caller actually typed scored exactly the same as
// one holding only its near-twin. The distinction was not just widened, it was
// erased from the ordering.
//
// So a match on the caller's ORIGINAL, unfolded text outranks a match that only
// survived folding. Case is still ignored, because case was never the
// distinction in question. This changes order only: it admits no new record and
// excludes none, stored text is untouched, and identifiers -- which are matched
// literally and therefore always exact -- can only be reinforced by it.
const EXACT_TERM_BONUS = 4;
function score(record, terms, rawTerms) {
  let total = 0;
  for (const [index, term] of terms.entries()) {
    for (const field of matchFields(record, term)) total += FIELD_WEIGHT[field] ?? 2;
    const raw = rawTerms?.[index];
    if (raw && matchFieldsExact(record, raw).length) total += EXACT_TERM_BONUS;
    total += 1;
  }
  return total;
}
