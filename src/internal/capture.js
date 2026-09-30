// The capture kind (plan v1.4.4 §9.5, §12, §22; plan rev6 §3.5 PR-33). A
// capture item is what ShadowGraph observed of one host event, waiting to be
// understood: a `records[]` entry of kind 'capture', so a build that predates
// the kind refuses its store instead of loading it and never purging it. The
// raw text lives outside the item, in the captureContent collection under the
// item's contentRef, and each capture session keeps its own record in
// captureSessions.
//
// The reader (PR-33) lands before any writer and gives all of this no meaning:
// it fixes the shape, carries it, purges it with its owner and shows it on no
// public read. What the states and fields do arrives with the writers (PR-34
// onwards), which write what this reader -- the floor they can all be rolled
// back to -- already understands. There is no `generation` on an item: it
// lives in the store's control ledger from PR-39 (VAR-18).
import { isValidIsoInstant } from '../fact-validity.js';
import { usableOriginId } from '../scope.js';

export const CAPTURE_KIND = 'capture';
// The first schema a capture item can have.
export const CAPTURE_SCHEMA_VERSION = 7;
// `excluded` is not a state: a self-event is counted, never written (§16.3).
export const CAPTURE_STATES = Object.freeze(['pending', 'processing', 'extracted', 'failed', 'blocked']);

// The four capture journal types and the states each may leave an item in.
// Recording makes it pending, or blocked where it is refused as it is written;
// a state change claims, releases, blocks or unblocks it; an extraction either
// completes or fails -- back to pending within its retry ceiling, failed, or
// blocked. Only a completed extraction leaves an item extracted, and only a
// failed one leaves it failed.
export const CAPTURE_ENTRY_STATES = Object.freeze({
  'capture.recorded': Object.freeze(['pending', 'blocked']),
  'capture.state_changed': Object.freeze(['pending', 'processing', 'blocked']),
  'extraction.completed': Object.freeze(['extracted']),
  'extraction.failed': Object.freeze(['pending', 'failed', 'blocked'])
});
export const CAPTURE_ENTRY_TYPES = Object.freeze(Object.keys(CAPTURE_ENTRY_STATES));
// The writer's moves (plan §12.5; PR-34): each edge, what it needs, whether it
// releases the lease and counts an attempt, and the one type it journals.
export const CAPTURE_TRANSITIONS = Object.freeze({
  'pending->processing': Object.freeze({ type: 'capture.state_changed', requires: 'lease' }),
  'processing->extracted': Object.freeze({ type: 'extraction.completed', requires: 'producedRecordIds', releases: true }),
  'processing->failed': Object.freeze({ type: 'extraction.failed', requires: 'lastError', releases: true }),
  'failed->pending': Object.freeze({ type: 'capture.state_changed' }),
  'failed->blocked': Object.freeze({ type: 'capture.state_changed', requires: 'blockedReason' })
});
// The source contract (plan §12.1): the events capture covers, and what
// identifies one occurrence of each where the host supplies it. Without it an
// occurrence is identified by its ordinal. A SessionEnd is one per session. An
// event not listed is not captured.
export const CAPTURE_EVENT_IDENTITY = Object.freeze({
  UserPromptSubmit: 'hostEventId',
  PostToolUse: 'toolCallId',
  PostToolUseFailure: 'toolCallId',
  Stop: 'turnIndex',
  PreCompact: null,
  SessionEnd: 'session'
});
// The entry a journal-less import writes for an item, by the state it is in.
export const CAPTURE_IMPORT_TYPE = Object.freeze({
  pending: 'capture.recorded', processing: 'capture.state_changed', extracted: 'extraction.completed',
  failed: 'extraction.failed', blocked: 'capture.state_changed'
});

export const CAPTURE_CONTENT = 'captureContent';
export const CAPTURE_SESSIONS = 'captureSessions';
export const CAPTURE_COLLECTIONS = Object.freeze([CAPTURE_CONTENT, CAPTURE_SESSIONS]);

// Every item carries each of these; any other field is carried verbatim.
const ITEM_FIELDS = Object.freeze([
  'id', 'kind', 'schemaVersion', 'project', 'attribution', 'originId', 'state', 'source', 'observedAt',
  'occurrenceSeq', 'sourceIdentity', 'contentRef', 'contentHash', 'lease', 'attempts', 'lastError',
  'blockedReason', 'producedRecordIds', 'receipts', 'erasureToken', 'cancelRequested', 'supersededResults',
  'possibleDuplicateOf', 'expiresAt', 'createdAt', 'updatedAt'
]);
const SHA256 = /^[0-9a-f]{64}$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const nonEmpty = (value) => typeof value === 'string' && value !== '';
const named = (value) => typeof value === 'string' && value.trim() !== '';
const nullOr = (check) => (value) => value === null || check(value);
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const listOf = (check) => (value) => Array.isArray(value) && value.every(check);

// Capture is new, so nothing it holds is legacy: it belongs to a named project
// or to its origin alone, and always says which origin observed it.
function ownerIssue(value) {
  if (value.originId == null || usableOriginId(value.originId) !== value.originId) return 'originId is a non-empty string';
  if (value.attribution === 'project') return named(value.project) ? null : 'a project attribution names its project';
  if (value.attribution === 'unattributed') return value.project === null ? null : 'an unattributed entry belongs to no project';
  return "attribution is 'project' or 'unattributed'";
}

function sourceIssue(source) {
  if (!isObject(source) || !named(source.event) || !named(source.sessionId)) return 'source names its event and sessionId';
  for (const key of ['role', 'hostEventId', 'toolCallId']) if (source[key] !== undefined && !nullOr(named)(source[key])) return `source.${key} is null or a non-empty string`;
  if (source.turnIndex !== undefined && !nullOr(count)(source.turnIndex)) return 'source.turnIndex is null or a non-negative integer';
  return null;
}

// A lease names its owner and expiry; anything a later worker adds is carried.
const leased = (lease) => isObject(lease)
  && ['leaseId', 'ownerId', 'ownerBootId'].every((key) => named(lease[key])) && isValidIsoInstant(lease.leaseExpiresAt);

// What is wrong with one capture item this build reads, or null. A caller
// passes an item of a newer schema by, carried and never judged.
export function captureItemIssue(item) {
  if (!isObject(item) || item.kind !== CAPTURE_KIND) return 'a capture item has kind capture';
  const missing = ITEM_FIELDS.find((field) => !Object.hasOwn(item, field));
  if (missing) return `a capture item carries ${missing}`;
  if (Object.hasOwn(item, 'generation')) return 'a capture item carries no generation: it lives in the control ledger';
  if (!nonEmpty(item.id)) return 'id is a non-empty string';
  if (!Number.isSafeInteger(item.schemaVersion) || item.schemaVersion < CAPTURE_SCHEMA_VERSION) return `schemaVersion is ${CAPTURE_SCHEMA_VERSION} or later`;
  const owner = ownerIssue(item);
  if (owner) return owner;
  if (!CAPTURE_STATES.includes(item.state)) return `state is one of ${CAPTURE_STATES.join(', ')}`;
  const source = sourceIssue(item.source);
  if (source) return source;
  if (!isValidIsoInstant(item.observedAt)) return 'observedAt is an ISO 8601 instant';
  if (!count(item.occurrenceSeq)) return 'occurrenceSeq is a non-negative integer';
  if (!named(item.sourceIdentity)) return 'sourceIdentity is a non-empty string';
  if (!nullOr(nonEmpty)(item.contentRef)) return 'contentRef is null or a non-empty string';
  if (!nullOr((value) => typeof value === 'string' && SHA256.test(value))(item.contentHash)) return 'contentHash is null or a lower-case SHA-256 hex digest';
  if (!nullOr(leased)(item.lease)) return 'lease is null or names its leaseId, ownerId, ownerBootId and leaseExpiresAt';
  if (!count(item.attempts)) return 'attempts is a non-negative integer';
  if (!nullOr(named)(item.lastError)) return 'lastError is null or a non-empty string';
  if (!nullOr(named)(item.blockedReason)) return 'blockedReason is null or a non-empty string';
  if (!listOf(nonEmpty)(item.producedRecordIds) || new Set(item.producedRecordIds).size !== item.producedRecordIds.length) return 'producedRecordIds is a list of distinct record ids';
  if (!listOf(isObject)(item.receipts)) return 'receipts is a list of objects';
  if (!nonEmpty(item.erasureToken)) return 'erasureToken is a non-empty string';
  if (typeof item.cancelRequested !== 'boolean') return 'cancelRequested is true or false';
  if (!listOf(isObject)(item.supersededResults)) return 'supersededResults is a list of objects';
  if (!nullOr(nonEmpty)(item.possibleDuplicateOf) || item.possibleDuplicateOf === item.id) return 'possibleDuplicateOf is null or another item id';
  if (!nullOr(isValidIsoInstant)(item.expiresAt)) return 'expiresAt is null or an ISO 8601 instant';
  if (!isValidIsoInstant(item.createdAt) || !isValidIsoInstant(item.updatedAt)) return 'createdAt and updatedAt are ISO 8601 instants';
  if (item.state === 'failed' && item.lastError === null) return 'a failed item says why in lastError';
  if (item.state === 'blocked' && item.blockedReason === null) return 'a blocked item says why in blockedReason';
  return null;
}

// What is wrong with a capture entry's payload, or null. The caller has
// already passed future entries and payloads by.
export function captureEntryIssue(type, payload) {
  const issue = captureItemIssue(payload);
  if (issue) return `${type} carries no well-formed capture item: ${issue}`;
  const states = CAPTURE_ENTRY_STATES[type];
  return states.includes(payload.state) ? null : `${type} leaves an item ${states.join(' or ')}, not ${payload.state}`;
}

// What is wrong with a capture collection, or null. Positions only.
export function captureCollectionIssue(name, value) {
  if (!Array.isArray(value)) return `${name} is an array of entries`;
  const keyName = name === CAPTURE_CONTENT ? 'contentRef' : 'id';
  const keys = new Set();
  const sessions = new Set();
  for (const [index, entry] of value.entries()) {
    if (!isObject(entry)) return `${name} entry ${index} is an object`;
    if (!nonEmpty(entry[keyName])) return `${name} entry ${index} names its ${keyName}`;
    if (keys.has(entry[keyName])) return `${name} entry ${index} repeats an earlier ${keyName}`;
    keys.add(entry[keyName]);
    const owner = ownerIssue(entry);
    if (owner) return `${name} entry ${index}: ${owner}`;
    if (name === CAPTURE_SESSIONS) {
      if (!named(entry.sessionId)) return `${name} entry ${index} names its sessionId`;
      const session = JSON.stringify([entry.originId, entry.sessionId]);
      if (sessions.has(session)) return `${name} entry ${index} repeats an earlier origin session`;
      sessions.add(session);
    }
  }
  return null;
}

// Whether a purge of `project` reaches a collection entry: one the project
// owns, or content a capture the purge removes names, whoever it says owns it.
export const captureEntryReachedBy = (entry, project, removedContentRefs) => (entry?.attribution === 'project' && entry.project === project)
  || removedContentRefs.has(entry?.contentRef);
