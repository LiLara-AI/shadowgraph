// Plan v1.4.4 §17.5 (AC-016, AC-029, AC-030, AC-032; PC-11, PC-12; PR-29):
// what a record's stored times and supersession support saying about when it
// held and whether it holds at the read's instant (asOf, or now). Presentation
// only: it reads what the write stored and changes nothing, and the recording
// order alone never decides between two versions.
//
// A write fills an event time it was not given from the recording time (a
// fact's observedAt and validFrom, a memory's validFrom), so an event time equal
// to the recording time cannot be told from a defaulted one: it is unknown.
// Decisions and attempts store no event time at all.
import { earliestValidIsoInstant, effectiveFactExpirationBoundary, isValidIsoInstant } from '../fact-validity.js';

// Evidence names at most this many records; the rest are counted, and reached
// by expansion.
export const EVIDENCE_LIMIT = 10;
const HAS_EVENT_TIME = new Set(['fact', 'memory']);
// A decision is historical only when something ended it; a due review, a
// failure or a reconsideration does not (AC-030).
const ENDED_DECISION_STATUSES = new Set(['superseded', 'abandoned', 'archived']);
const ENDED_VERSION_STATUSES = new Set(['expired', 'invalidated']);
const iso = (value) => (isValidIsoInstant(value) ? value : null);
const instant = (value) => (isValidIsoInstant(value) ? Date.parse(value) : null);

// Times as the as-of selection reads them (hybrid-search temporalOf): a legacy
// fact stored without `temporal` keeps them at the top level. A decision or an
// attempt has its creation time only.
export function versionTimes(record, kind) {
  if (!HAS_EVENT_TIME.has(kind)) return { recordedAt: iso(record.createdAt), validFrom: null, end: null };
  const legacyFact = kind === 'fact' && !record.temporal;
  const temporal = record.temporal ?? {};
  const recordedAt = iso(temporal.recordedAt) ?? (legacyFact ? iso(record.recordedAt) ?? iso(record.observedAt) : null) ?? iso(record.createdAt);
  const validFrom = iso(temporal.validFrom) ?? (legacyFact ? iso(record.validFrom) ?? iso(record.observedAt) : null);
  const end = kind === 'fact' ? effectiveFactExpirationBoundary(record) : iso(temporal.validTo);
  return { recordedAt, validFrom, end };
}

function eventTimeOf(record, kind) {
  if (!HAS_EVENT_TIME.has(kind)) return { at: null, state: 'unknown' };
  const { recordedAt, validFrom } = versionTimes(record, kind);
  const at = [validFrom, iso(record.observedAt)].find((value) => value !== null && instant(value) !== instant(recordedAt));
  return at === undefined ? { at: null, state: 'unknown' } : { at, state: 'known' };
}

// Whether the earlier version's writer declared it ended by the later one's
// start, which the end a same-key write closed it at cannot show: a fact's
// declared expiry at or before that start, or a validity end, a fact's declared
// one or a memory's requested one, strictly before it -- a same-key write closes
// a window exactly there, and migration and import record a legacy fact's
// closed window as its declared end.
function endedBefore(record, kind, laterStart) {
  const start = instant(laterStart);
  if (start === null) return false;
  const before = (value) => instant(value) !== null && instant(value) < start;
  if (kind !== 'fact') return before(record.temporal?.validTo);
  const expiry = instant(earliestValidIsoInstant(record.validityPolicy?.declaredExpiresAt, record.expiresAt));
  return (expiry !== null && expiry <= start) || before(record.validityPolicy?.declaredValidTo);
}

// Between two versions: a later known event time decides, and so does an end
// the earlier one's writer declared by the later one's start; otherwise only
// the recording order tells them apart.
export function supersessionOrder(earlier, later, kind) {
  const [from, to] = [eventTimeOf(earlier, kind), eventTimeOf(later, kind)];
  if (from.state === 'known' && to.state === 'known' && instant(to.at) > instant(from.at)) return 'validity_window';
  return endedBefore(earlier, kind, versionTimes(later, kind).validFrom) ? 'validity_window' : 'recording_order_only';
}

const idsOf = (records) => records.map((item) => item.id);
const stateOf = (state, basis, ids = []) => ({ state, basis, evidence: ids.slice(0, EVIDENCE_LIMIT), evidenceOmitted: Math.max(0, ids.length - EVIDENCE_LIMIT) });

// `successors` and `predecessors`: the records this one was superseded by and
// superseded, as far as the read may reach them. `at`: the read's instant.
export function temporalEvidence(record, { kind = record.kind, successors = [], predecessors = [], at, asOf = null } = {}) {
  const evidence = { recordedAt: versionTimes(record, kind).recordedAt, eventTime: eventTimeOf(record, kind) };
  // An attempt is an event, not a state.
  if (kind === 'attempt') return { ...evidence, currentState: null };
  const [later, earlier] = [idsOf(successors), idsOf(predecessors)];
  if (kind === 'decision') {
    // No event time places a decision at an earlier instant.
    if (asOf !== null) return { ...evidence, currentState: stateOf('undetermined', null, [...earlier, ...later]) };
    if (later.length) return { ...evidence, currentState: stateOf('historical', 'explicit_supersession', later) };
    if (ENDED_DECISION_STATUSES.has(record.status)) return { ...evidence, currentState: stateOf('historical', null) };
    return { ...evidence, currentState: stateOf('current', earlier.length ? 'explicit_supersession' : null, earlier) };
  }
  // Facts and memories: a same-key write superseded the earlier version. When
  // only the recording order tells this one from a version on either side, the
  // conflict stays unresolved, naming every linked version.
  // A link to a record of another kind, which only an import stores, was
  // stated, not made by a same-key write: only versions of this kind can be
  // told apart by the recording order alone.
  const sameKind = (item) => (item.kind ?? 'fact') === kind;
  const unresolved = successors.some((item) => sameKind(item) && supersessionOrder(record, item, kind) === 'recording_order_only')
    || predecessors.some((item) => sameKind(item) && supersessionOrder(item, record, kind) === 'recording_order_only');
  if (unresolved) return { ...evidence, currentState: stateOf('unresolved', 'recording_order_only', [...earlier, ...later]) };
  // A stated successor decides, as a decision's does; no time places it as of
  // an instant.
  const stated = successors.filter((item) => !sameKind(item));
  if (stated.length) return { ...evidence, currentState: asOf === null ? stateOf('historical', 'explicit_supersession', idsOf(stated)) : stateOf('undetermined', null, [...earlier, ...later]) };
  const point = instant(at);
  const begun = successors.filter((item) => instant(versionTimes(item, kind).validFrom) !== null && instant(versionTimes(item, kind).validFrom) <= point);
  if (begun.length) return { ...evidence, currentState: stateOf('historical', 'validity_window', idsOf(begun)) };
  // The version's own window at the read's instant decides.
  const { validFrom, end } = versionTimes(record, kind);
  if (instant(validFrom) !== null && instant(validFrom) > point) {
    // Before a start that is only the recording time, the placement is unknown.
    return { ...evidence, currentState: instant(validFrom) !== instant(evidence.recordedAt) ? stateOf('not_yet_valid', 'validity_window', earlier) : stateOf('undetermined', null, earlier) };
  }
  if (end !== null ? instant(end) <= point : ENDED_VERSION_STATUSES.has(record.status)) return { ...evidence, currentState: stateOf('historical', 'validity_window') };
  if (record.status === 'superseded' && !successors.length && end === null) return { ...evidence, currentState: stateOf('historical', null) };
  return { ...evidence, currentState: stateOf('current', 'validity_window', earlier) };
}
