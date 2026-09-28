// Plan v1.4.4 §17 and the accepted P0 G-5 specification
// (docs/contracts/compact-tier-contract.md), PR-25: the T1 compact tier. A T1
// line is a claim line derived from one record on every read, by a versioned
// deterministic template with no model call. It is never canonical and never
// stored. Pure: what it renders is exactly t1Inputs(record, { asOf, visible }),
// where the record is the one a boundary-scoped public read returned.
import { createHash } from 'node:crypto';
import { effectiveFactExpirationBoundary, isValidIsoInstant } from './fact-validity.js';
import { negationsIn } from './verification.js';

export const T1_DERIVATION_VERSION = 't1-line-v1';
// G-5 §2.2: the byte ceiling of `line`, set by measurement over the
// repository's corpora (contract annex A4). A line that cannot carry every
// decisive part within it names what it left out (§3.4).
export const T1_LINE_CEILING = 512;

// Weakest first: a line is only as sure as its least-supported part, and a
// part no verifier classified is weaker than any class.
const CLAIM_CLASS_ORDER = ['not_classified', 'unsupported', 'ambiguous', 'entailed', 'quoted'];
const VERIFIED_CLASSES = new Set(['quoted', 'entailed']);
// The fields that link a record to others; derivation version 1 renders only
// the ids, and only those the caller says are inside the request's boundary.
const LINK_FIELDS = ['supersededBy', 'supersedes', 'relatedTo', 'failedAttempts'];
// The kernel's own vocabularies for the values a line renders bare. A value
// outside them is text a writer supplied, and is read for negation like any
// other text. test/compact-tier.test.js holds these to the kernel's exports.
export const T1_VOCABULARY = Object.freeze({
  status: Object.freeze(['proposed', 'planned', 'in_progress', 'executed', 'validated', 'failed', 'reconsidered', 'superseded', 'abandoned', 'stale', 'archived', 'active', 'aging', 'expired', 'invalidated']),
  resultClass: Object.freeze(['failed', 'succeeded', 'inconclusive']),
  verificationStatus: Object.freeze(['unverified', 'verified', 'contradicted', 'expired']),
  sourceClass: Object.freeze(['agent_claimed', 'tool_observed', 'human_confirmed', 'production_verified']),
  outcomeStatus: Object.freeze(['successful', 'mixed', 'failed', 'unknown']),
  outcomeEvidenceState: Object.freeze(['observed', 'absent', 'not_applicable']),
  causeState: Object.freeze(['recorded', 'unknown', 'not_recorded', 'legacy_freetext'])
});
const outsideVocabulary = (kind, value) => value != null && !T1_VOCABULARY[kind].includes(value);

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
};
// Every value a caller or a legacy writer supplied is written as JSON, so its
// text can never read as part of the template; JSON leaves some characters
// raw that break or reorder a line (C1 controls, DEL, line and paragraph
// separators, bidirectional controls), so those are escaped too. The kernel's
// own vocabulary (statuses, classes, identifiers, instants) is written bare
// when it has its expected form, and as JSON when it does not.
const show = (value) => JSON.stringify(value === undefined ? null : value)
  .replace(/[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/gu, (character) => `\\u${character.codePointAt(0).toString(16).padStart(4, '0')}`);
const vocab = (value) => (typeof value === 'string' && /^[a-z][a-z0-9_]*$/.test(value) ? value : show(value));
const ident = (value) => (typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_:.-]*$/.test(value) ? value : show(value));
const instant = (value) => (isValidIsoInstant(value) ? value : show(value));
const given = (value) => (typeof value === 'string' ? value.trim() !== '' : value != null);
// A field stored as one value where a list is expected is carried, not dropped.
const listOf = (value) => (Array.isArray(value) ? value : value == null ? [] : [value]);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
// A rule as stored: a missing operator or operand is said to be missing, never supplied.
const ruleText = (rule) => (isObject(rule)
  ? [show(rule.key), rule.operator == null ? 'no recorded operator' : vocab(rule.operator), rule.value !== undefined ? show(rule.value) : 'no recorded value', ...(rule.unit != null ? [show(rule.unit)] : [])].join(' ')
  : show(rule));
const verbatim = (value) => (typeof value === 'string' ? value : show(value));
const hiddenLink = () => false;

// The closure (VAR-09): derivation version 1 renders only the record's own
// fields -- a linked record by its id alone, and only when the caller's
// `visible` says it is inside the request's boundary (no link is, unless the
// caller says so) -- so what a line is derived from is the record as the
// boundary-scoped read returned it, with every link outside the boundary taken
// out, and the as-of instant. The embedding is left out: it is derived from the
// record's text, which the digest covers. An erasure token is never part of
// what a reader sees.
export function t1Inputs(record, { asOf = null, visible = hiddenLink } = {}) {
  if (asOf !== null && !isValidIsoInstant(asOf)) throw new TypeError('asOf must be null or an ISO 8601 instant string');
  const { embedding, erasureToken, ...rest } = record;
  for (const field of LINK_FIELDS) {
    if (!Object.hasOwn(rest, field)) continue;
    if (Array.isArray(rest[field])) rest[field] = rest[field].filter((id) => visible(id));
    else if (rest[field] != null && !visible(rest[field])) delete rest[field];
  }
  return { derivationVersion: T1_DERIVATION_VERSION, asOf: asOf === null ? null : new Date(asOf).toISOString(), record: rest };
}
export const t1Digest = (inputs) => createHash('sha256').update(JSON.stringify(canonical(inputs))).digest('hex');

function preconditionsOf(record) {
  const decisive = [];
  for (const alternative of listOf(record.alternatives)) {
    if (!isObject(alternative)) continue;
    for (const rule of listOf(alternative.reopenWhen)) decisive.push({ kind: 'reopenWhen', alternative: alternative.label ?? null, text: ruleText(rule) });
  }
  for (const rule of listOf(record.reusableWhen)) decisive.push({ kind: 'reusableWhen', alternative: null, text: ruleText(rule) });
  for (const assumption of listOf(record.assumptions)) decisive.push({ kind: 'assumption', alternative: null, text: verbatim(assumption) });
  return { count: decisive.length, decisive };
}

// The window in which a fact or memory applies. A fact's end is the kernel's
// effective expiration boundary: the earliest of its declared expiry and
// validity ends.
function applicabilityOf(record) {
  if (record.kind !== 'fact' && record.kind !== 'memory') return null;
  const validFrom = record.temporal?.validFrom ?? record.validFrom ?? null;
  const validTo = record.kind === 'fact' ? effectiveFactExpirationBoundary(record) ?? record.temporal?.validTo ?? record.validTo ?? record.expiresAt ?? null : record.temporal?.validTo ?? null;
  return validFrom == null && validTo == null ? null : { validFrom, validTo };
}
const recordedAtOf = (record) => record.createdAt ?? record.temporal?.recordedAt ?? record.observedAt;
const memoryScopeOf = (record) => (isObject(record.scope) && Object.values(record.scope).some((value) => value != null) ? record.scope : null);

// The decisive values of a record, as { field, text, outcome } with the text
// verbatim (JSON for a value that is not a string), for the negation check.
// `outcome` marks the text of an outcome or a state itself. A class or status
// is read only when it is not the kernel's own vocabulary.
function decisiveTexts(record) {
  const texts = [];
  const add = (field, value, outcome = false) => { if (given(value)) texts.push({ field, text: verbatim(value), outcome }); };
  const unlessVocabulary = (field, kind, value) => { if (outsideVocabulary(kind, value)) add(field, value, true); };
  unlessVocabulary('status', 'status', record.status);
  unlessVocabulary('verificationStatus', 'verificationStatus', record.verificationStatus);
  unlessVocabulary('sourceClass', 'sourceClass', record.sourceClass);
  if (record.kind === 'decision') {
    add('title', record.title); add('chosen', record.chosen); add('goal', record.goal);
    listOf(record.alternatives).forEach((alternative, index) => {
      if (!isObject(alternative)) return add(`alternatives[${index}]`, alternative);
      add(`alternatives[${index}].label`, alternative.label); add(`alternatives[${index}].reasonRejected`, alternative.reasonRejected);
      listOf(alternative.reopenWhen).forEach((rule, ruleIndex) => add(`alternatives[${index}].reopenWhen[${ruleIndex}]`, ruleText(rule)));
    });
    listOf(record.assumptions).forEach((assumption, index) => add(`assumptions[${index}]`, assumption));
    if (isObject(record.outcome)) {
      const { status, ...rest } = record.outcome;
      unlessVocabulary('outcome.status', 'outcomeStatus', status);
      if (Object.keys(rest).length) add('outcome', rest, true);
    } else add('outcome', record.outcome, true);
  } else if (record.kind === 'attempt') {
    add('solution', record.solution); add('environment', record.environment); add('result', record.result, true); add('reason', record.reason);
    unlessVocabulary('resultClass', 'resultClass', record.resultClass);
    unlessVocabulary('outcomeEvidence.state', 'outcomeEvidenceState', record.outcomeEvidence?.state);
    unlessVocabulary('causalClaim.state', 'causeState', record.causalClaim?.state);
    listOf(record.reusableWhen).forEach((rule, index) => add(`reusableWhen[${index}]`, ruleText(rule)));
  } else if (record.kind === 'memory') {
    add('key', record.key); add('text', record.text);
  } else {
    add('key', record.key); add('value', record.value);
  }
  return texts;
}

// The state of an attempt's cause: stored, or, for an attempt shown without
// one, what a public read derives (PR-23).
const causeStateOf = (record) => record.causalClaim?.state ?? (given(record.reason) ? 'legacy_freetext' : 'not_recorded');
function reasonPart(record) {
  const state = causeStateOf(record);
  if (state === 'recorded') return `reason ${show(record.reason)} (recorded, ${vocab(record.causalClaim?.sourceClass ?? 'agent_claimed')})`;
  if (state === 'legacy_freetext') return `reason ${show(record.reason)} (legacy free text)`;
  if (state === 'unknown') return 'reason unknown';
  if (state === 'not_recorded') return 'reason not recorded';
  return `reason ${show(record.reason)} (cause state ${show(state)})`;
}

// Every decisive part of a record's line, in the order the line carries them:
// [{ name, text }]. Each is rendered whole and is never cut. The record is the
// one t1Inputs gives, so a link outside the boundary is never rendered.
export function t1Parts(record) {
  const parts = [];
  const add = (name, text) => parts.push({ name, text });
  if (record.kind === 'decision') {
    add('title', `Decision ${show(record.title)}`);
    add('chosen', `chose ${show(record.chosen)}`);
    if (given(record.goal)) add('goal', `goal ${show(record.goal)}`);
    add('status', `status ${record.status == null ? 'not recorded' : vocab(record.status)}`);
    listOf(record.alternatives).forEach((alternative, index) => {
      if (!isObject(alternative)) return add(`alternatives[${index}]`, `rejected alternative as stored ${show(alternative)}`);
      add(`alternatives[${index}]`, `rejected ${show(alternative.label)}${given(alternative.reasonRejected) ? `, recorded reason ${show(alternative.reasonRejected)}` : ''}`);
      listOf(alternative.reopenWhen).forEach((rule, ruleIndex) => add(`alternatives[${index}].reopenWhen[${ruleIndex}]`, `recorded reopen condition for ${show(alternative.label)}: ${ruleText(rule)}`));
    });
    listOf(record.assumptions).forEach((assumption, index) => add(`assumptions[${index}]`, `recorded assumption ${show(assumption)}`));
    if (record.outcome != null) add('outcome', `outcome ${isObject(record.outcome) ? vocab(record.outcome.status) : show(record.outcome)}`);
  } else if (record.kind === 'attempt') {
    add('solution', `Attempt ${show(record.solution)}`);
    if (given(record.environment)) add('environment', `in ${show(record.environment)}`);
    add('result', `result ${show(record.result)}`);
    add('resultClass', record.resultClass != null ? `result class ${vocab(record.resultClass)}` : record.outcomeEvidence?.state != null ? `outcome evidence ${vocab(record.outcomeEvidence.state)}, no result class` : 'no result class');
    add('reason', reasonPart(record));
    listOf(record.reusableWhen).forEach((rule, index) => add(`reusableWhen[${index}]`, `recorded reuse condition: ${ruleText(rule)}`));
  } else if (record.kind === 'memory') {
    add('key', `Memory (${vocab(record.memoryType)}) ${show(record.key)}`);
    add('text', `text ${show(record.text)}`);
    const memoryScope = memoryScopeOf(record);
    if (memoryScope) add('memoryScope', `for ${show(memoryScope)}`);
  } else {
    add('key', `Fact ${show(record.key)}`);
    add('value', `value ${show(record.value)}`);
  }
  if (record.kind === 'memory' || record.kind === 'fact') {
    add('status', `status ${record.status == null ? 'not recorded' : vocab(record.status)}`);
    add('verification', `verification ${record.verificationStatus == null ? 'not recorded' : vocab(record.verificationStatus)}`);
    const window = applicabilityOf(record);
    if (window) add('validity', `valid from ${window.validFrom == null ? 'an unrecorded time' : instant(window.validFrom)} until ${window.validTo == null ? 'no recorded end' : instant(window.validTo)}`);
  }
  if (record.supersededBy != null) add('supersededBy', `superseded by ${ident(record.supersededBy)}`);
  const recordedAt = recordedAtOf(record);
  add('attribution', `recorded ${recordedAt == null ? 'at an unrecorded time' : instant(recordedAt)} by ${record.actor == null ? 'an unnamed actor' : show(record.actor)} (${record.sourceClass == null ? 'unclassified source' : vocab(record.sourceClass)})`);
  return parts;
}

// The weakest class among the record's stored claims and, for an attempt, its
// cause: a cause no verifier classified caps the line at not_classified.
function claimClassOf(record) {
  const classes = listOf(record.claims).map((claim) => claim?.class).filter((cls) => CLAIM_CLASS_ORDER.includes(cls) && cls !== 'not_classified');
  if (record.kind === 'attempt') {
    const cls = record.causalClaim?.class;
    if (CLAIM_CLASS_ORDER.includes(cls)) classes.push(cls);
    else if (causeStateOf(record) !== 'not_recorded') classes.push('not_classified');
  }
  return classes.length ? CLAIM_CLASS_ORDER.find((cls) => classes.includes(cls)) : 'not_classified';
}
// The same text, ignoring letter case and white space at either end.
const sameText = (left, right) => typeof left === 'string' && typeof right === 'string' && left.trim().toLowerCase() === right.trim().toLowerCase();

// G-5 §2: one T1 line, in the request's context: `scope` ({ project, grantId })
// goes into the expansion handle, never an erasure token; `visible` says which
// linked ids are inside the request's boundary (none, unless it says so);
// `ceiling` bounds `line` only, choosing which whole parts it carries, and
// every part left out is named.
export function t1Line(record, { asOf = null, scope = {}, derivedAt = new Date().toISOString(), ceiling = T1_LINE_CEILING, visible = hiddenLink } = {}) {
  const inputs = t1Inputs(record, { asOf, visible });
  const shown = inputs.record;
  const digest = t1Digest(inputs);
  const kept = [];
  const decisiveOmitted = [];
  let bytes = 0;
  for (const part of t1Parts(shown)) {
    const size = Buffer.byteLength(part.text) + (kept.length ? 2 : 0);
    if (bytes + size <= ceiling) { kept.push(part.text); bytes += size; } else decisiveOmitted.push(part.name);
  }
  const span = decisiveTexts(shown).filter(({ text, outcome }) => negationsIn(text, { outcome }).length).map(({ field, text }) => ({ field, text }));
  const claimClass = claimClassOf(shown);
  // A negation is settled only on a classified line, and only where a verified
  // claim states that very text; every other negated line asks for the full
  // record (§3.1).
  const settled = claimClass !== 'not_classified' && span.every(({ text }) => listOf(shown.claims).some((claim) => VERIFIED_CLASSES.has(claim?.class) && sameText(claim.text, text)));
  return {
    recordId: shown.id, kind: shown.kind,
    line: kept.join('; '),
    claimClass,
    polarity: { negated: span.length > 0, span },
    scope: {
      project: shown.project ?? null,
      memoryScope: shown.kind === 'memory' ? shown.scope ?? null : null,
      environment: shown.kind === 'attempt' && given(shown.environment) ? shown.environment : null,
      applicability: applicabilityOf(shown)
    },
    preconditions: preconditionsOf(shown),
    status: { lifecycle: shown.status ?? null, supersededBy: shown.supersededBy ?? null, verification: shown.verificationStatus ?? null, correctedBy: null },
    ...(shown.kind === 'attempt' ? { outcome: { resultClass: shown.resultClass ?? null, outcomeEvidenceState: shown.outcomeEvidence?.state ?? null, reasonState: causeStateOf(shown) } } : {}),
    provenance: { sourceClass: shown.sourceClass ?? null, sourceRef: shown.captureRef ?? null },
    boundRevision: { recordId: shown.id, digest },
    derived: true, derivationVersion: T1_DERIVATION_VERSION,
    decisiveOmitted,
    requiresExpansion: decisiveOmitted.length > 0 || (span.length > 0 && !settled),
    expansion: { operation: 'shadowgraph_expand', recordId: shown.id, digest, asOf: inputs.asOf, derivationVersion: T1_DERIVATION_VERSION, scope: { project: scope.project ?? null, grantId: scope.grantId ?? null }, derivedAt }
  };
}

// G-5 §5: a line meets the record it names, in the request's context -- its
// as-of instant, scope and boundary, never the line's. The line is derived
// afresh every time, so what is served is never the copy handed in: equal
// digests serve it as current; a changed record serves it rebuilt, naming the
// stale digest, or, when the caller cannot rebuild, reports it stale with no
// content; a record that is gone, or not the one the line names, drops it.
export function t1Current(line, current, { rebuild = true, ...context } = {}) {
  if (!line || !current || current.id !== line.recordId) return { status: 'dropped', line: null };
  const fresh = t1Line(current, context);
  if (fresh.boundRevision.digest === line.boundRevision?.digest) return { status: 'current', line: fresh };
  if (!rebuild) return { status: 'stale', line: null, limitation: { code: 'stale_compact_line', recordId: line.recordId } };
  return { status: 'rebuilt', line: fresh, staleDigest: line.boundRevision?.digest ?? null };
}
