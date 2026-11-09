// The runtime miss ledger (plan rev6 PR-28a, VAR-10; G-5 §6.3-§6.4): a
// top-level store collection of derived operational data. Each entry records
// one grounded miss on a read -- a fallback recovery or an explicit
// correction -- with the SHA-256 digest of the query, never its text. It is not
// canonical, not journalled and not rebuilt: every store path carries it, no
// public read returns it, and a project's purge removes the entries recorded in
// the project or naming an entity the purge removes.
//
// The reader floor (PR-28a) freezes the entry shape; the writer (PR-28) records
// what the §9 fallback recovers. A build below the floor would carry the ledger
// as an unknown collection but could never purge it, so conversion to one
// leaves it out and reports only how many entries it held.
import { createHash, randomUUID } from 'node:crypto';
import { isValidIsoInstant } from '../fact-validity.js';
import { REQUEST_STATES, usableOriginId } from '../scope.js';

export const RUNTIME_MISSES = 'runtimeMisses';

const FIELDS = ['missId', 'at', 'source', 'evidence', 'scope', 'queryDigest', 'recordId', 'boundRevision', 'tier', 'stage', 'rank', 'signals', 'reason'];
const EVIDENCE = ['fallback_recovery', 'explicit_correction'];
const TIERS = ['T0', 'T1'];
const STAGES = ['not_ranked', 'ranked_not_delivered', 'delivered_line_without_decisive_meaning'];
const SIGNALS = ['lexical', 'semantic', 'graph', 'temporal'];
// No field holds free text: the id is minted by the writer and the reason is a
// code from the retrieval trace, so neither can carry a query.
const MISS_ID = /^miss_[A-Za-z0-9_-]{1,64}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const exactKeys = (value, keys) => isObject(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const nonEmpty = (value) => typeof value === 'string' && value !== '';
const named = (value) => typeof value === 'string' && value.trim() !== '';
const matches = (pattern, value) => typeof value === 'string' && pattern.test(value);
// An unavailable signal matched nothing.
const signal = (value) => exactKeys(value, ['available', 'matched']) && typeof value.available === 'boolean'
  && Number.isSafeInteger(value.matched) && value.matched >= 0 && (value.available || value.matched === 0);
// As resolveScope makes them: a selected request names its project, an
// unresolved one names none, and an origin is null or a usable id.
const scopeOf = (scope) => exactKeys(scope, ['project', 'originId', 'requestState']) && REQUEST_STATES.includes(scope.requestState)
  && (scope.requestState === 'project_selected' ? named(scope.project) : scope.project === null)
  && usableOriginId(scope.originId) === scope.originId;

// What is wrong with one entry, or null.
export function runtimeMissIssue(entry) {
  if (!exactKeys(entry, FIELDS)) return `an entry has exactly the fields ${FIELDS.join(', ')}`;
  if (!matches(MISS_ID, entry.missId)) return 'missId is a minted id: miss_ and at most 64 letters, digits, _ or -';
  if (!isValidIsoInstant(entry.at)) return 'at is an ISO 8601 instant';
  if (entry.source !== 'runtime') return "source is 'runtime'";
  if (!EVIDENCE.includes(entry.evidence)) return `evidence is one of ${EVIDENCE.join(', ')}`;
  if (!scopeOf(entry.scope)) return 'scope is { project, originId, requestState }: a selected request names its project, an unresolved one names none, and an origin is null or a non-blank id';
  if (!matches(SHA256, entry.queryDigest)) return 'queryDigest is a lower-case SHA-256 hex digest';
  if (!nonEmpty(entry.recordId)) return 'recordId is a non-empty string';
  if (entry.boundRevision !== null && !(exactKeys(entry.boundRevision, ['recordId', 'digest']) && entry.boundRevision.recordId === entry.recordId && matches(SHA256, entry.boundRevision.digest))) {
    return "boundRevision is null or { recordId, digest } of the entry's record";
  }
  if (!TIERS.includes(entry.tier)) return `tier is one of ${TIERS.join(', ')}`;
  if (!STAGES.includes(entry.stage)) return `stage is one of ${STAGES.join(', ')}`;
  if (entry.stage === 'not_ranked' ? entry.rank !== null : !(Number.isSafeInteger(entry.rank) && entry.rank >= 1)) {
    return 'rank is null when the record was not ranked and a positive integer otherwise';
  }
  if (!exactKeys(entry.signals, SIGNALS) || !SIGNALS.every((name) => signal(entry.signals[name]))) return `signals is { ${SIGNALS.join(', ')} }, each { available, matched }, an unavailable one matching nothing`;
  if (!matches(REASON, entry.reason)) return 'reason is a trace code: a lower-case letter, then at most 63 lower-case letters, digits or _';
  return null;
}

// What is wrong with a ledger, or null. Positions only: never an entry's values.
export function runtimeMissLedgerIssue(ledger) {
  if (!Array.isArray(ledger)) return 'the ledger is an array of entries';
  const seen = new Map();
  for (const [index, entry] of ledger.entries()) {
    const issue = runtimeMissIssue(entry);
    if (issue) return `entry ${index}: ${issue}`;
    if (seen.has(entry.missId)) return `entry ${index}: its missId repeats entry ${seen.get(entry.missId)}`;
    seen.set(entry.missId, index);
  }
  return null;
}

// Whether a purge of `project`, removing the entities `removedIds`, reaches the
// entry: one recorded in the project, or one naming a removed entity whatever
// scope recorded it -- a grant-widened read ranks across projects, and a record
// an unresolved read named may later be attributed to one.
export const missReachedBy = (entry, project, removedIds) => entry?.scope?.project === project || removedIds.has(entry?.recordId);

// The writer (PR-28; G-5 §6.2(a), §9; the §6.4 count cap settled by
// measurement, §11). One entry per read, of at most 1 KB serialized -- about
// 1.4 KB in a pretty-printed JSON store -- keeps a granted read, which saves
// once already with its audit aggregate, inside PR-17's 4096-byte growth
// ceiling even beside the largest audit labels; the cap bounds the ledger near
// 140 KB stored.
export const RUNTIME_MISSES_PER_READ = 1;
export const RUNTIME_MISS_ENTRY_BYTES = 1024;
export const RUNTIME_MISS_CAP = 100;

const missKey = (queryDigest, scope, recordId) => JSON.stringify([queryDigest, scope.project, scope.originId, scope.requestState, recordId]);

// The ledger with one fallback read's recovery added, in delivery order: each
// record once per query, scope and record, so a repeated read goes on to a
// record not yet recorded. An entry over the byte bound, which only a very long
// project name or origin makes, is not recorded. Past the cap only the newest
// three quarters stay, so a SQLite store scrubs evictions in batches, not on
// every save.
export function withFallbackMisses(ledger, { query, scope, signals, recordIds, at }) {
  const queryDigest = createHash('sha256').update(query).digest('hex');
  const missScope = { project: scope.project ?? null, originId: scope.originId ?? null, requestState: scope.state };
  const entryOf = (recordId) => ({
    missId: `miss_${randomUUID()}`, at, source: 'runtime', evidence: 'fallback_recovery', scope: { ...missScope }, queryDigest, recordId,
    boundRevision: null, tier: 'T0', stage: 'not_ranked', rank: null, signals: structuredClone(signals), reason: 'relevance_not_established'
  });
  // Only the record id varies, so the rest is measured once.
  const fixedBytes = Buffer.byteLength(JSON.stringify(entryOf('')));
  if (fixedBytes > RUNTIME_MISS_ENTRY_BYTES) return ledger;
  const seen = new Set(ledger.map((entry) => missKey(entry.queryDigest, entry.scope, entry.recordId)));
  const added = [];
  for (const recordId of recordIds) {
    if (added.length === RUNTIME_MISSES_PER_READ) break;
    if (seen.has(missKey(queryDigest, missScope, recordId)) || fixedBytes + Buffer.byteLength(JSON.stringify(recordId)) - 2 > RUNTIME_MISS_ENTRY_BYTES) continue;
    added.push(entryOf(recordId));
  }
  if (!added.length) return ledger;
  const next = [...ledger, ...added];
  return next.length > RUNTIME_MISS_CAP ? next.slice(next.length - RUNTIME_MISS_CAP * 3 / 4) : next;
}
