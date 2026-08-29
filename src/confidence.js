// ShadowGraph confidence model — see docs/contracts/confidence-contract.md.
//
// Policy id: evidence_weighted_bounded_v1
//
// Design rules that must not be broken:
//  - confidence is NOT verification. A provenance class is a CLAIM about origin,
//    never proof, so no class ever sets verificationStatus (G2 contract §2).
//  - confidence is a PURE FUNCTION of (initial, contributions). It is recomputed
//    from the contribution list, never incrementally mutated, so a removed or
//    superseded contribution cannot leave residue behind.
//  - every contribution carries a stable `key`. Re-applying the same key is a
//    no-op, which is what prevents double counting on retry/replay.

export const CONFIDENCE_MIN = 0;
export const CONFIDENCE_MAX = 1;
export const CONFIDENCE_POLICY = 'evidence_weighted_bounded_v1';

// A full-strength (production_verified) observation moves confidence by BASE_STEP.
// Weaker provenance classes move it proportionally less, but every class still
// moves it meaningfully: because nothing can currently be `verified` (U-1), most
// real evidence is `agent_claimed`, and a scale that made that ~0 would leave
// confidence permanently frozen at its initial value.
// These numbers are a DECLARED POLICY, not a measured calibration.
export const BASE_STEP = 0.2;

export const SOURCE_CLASS_WEIGHT = Object.freeze({
  agent_claimed: 0.5,
  tool_observed: 0.7,
  human_confirmed: 0.85,
  production_verified: 1
});

// Direction an outcome pushes confidence. `unknown` deliberately moves nothing:
// "we do not know" is not evidence.
export const OUTCOME_DIRECTION = Object.freeze({
  successful: 1,
  mixed: -0.5,
  failed: -1,
  unknown: 0
});

function round(value) {
  return Math.round(value * 1e6) / 1e6;
}

function clamp(value) {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, value));
}

export function classWeight(sourceClass) {
  return SOURCE_CLASS_WEIGHT[sourceClass] ?? SOURCE_CLASS_WEIGHT.agent_claimed;
}

export function contributionDelta(contribution) {
  const direction = Number(contribution?.direction ?? 0);
  if (!Number.isFinite(direction) || direction === 0) return 0;
  return round(BASE_STEP * classWeight(contribution.sourceClass) * direction);
}

// Pure: same (initial, contributions) always yields the same number.
//
// CONTRACT: clamp(initial + sum(deltas), 0, 1) — the deltas are summed FIRST and
// the bound is applied ONCE at the end. This is deliberate and is what the
// confidence contract documents.
//
// The alternative (clamping after every step) makes the result depend on the
// ORDER contributions arrive in: three +1 production_verified observations
// followed by one -1 would saturate at 1 and then drop to 0.8, whereas the same
// four in a different order land elsewhere. Order-dependence would mean a rebuilt
// projection could disagree with live state purely because of sequencing, and it
// would make "remove a contribution" non-invertible. Summing first gives
// permutation invariance and exact cancellation.
export function computeConfidence(initial, contributions = []) {
  const base = Number.isFinite(initial) ? initial : 0.5;
  let total = 0;
  for (const contribution of contributions) total += contributionDelta(contribution);
  return round(clamp(base + total));
}

// `basis` is the auditable explanation of the number. Counts are derived, never
// stored independently, so they cannot drift from the contribution list.
export function summarizeBasis(contributions = [], extra = {}) {
  const counts = {
    supportingEvidence: 0,
    contradictingEvidence: 0,
    successfulOutcomes: 0,
    failedOutcomes: 0,
    mixedOutcomes: 0,
    unknownOutcomes: 0,
    humanConfirmations: 0,
    productionVerifications: 0
  };
  for (const contribution of contributions) {
    if (contribution.kind === 'outcome') {
      if (contribution.outcomeStatus === 'successful') counts.successfulOutcomes += 1;
      else if (contribution.outcomeStatus === 'failed') counts.failedOutcomes += 1;
      else if (contribution.outcomeStatus === 'mixed') counts.mixedOutcomes += 1;
      else counts.unknownOutcomes += 1;
    }
    if (contribution.direction > 0) counts.supportingEvidence += 1;
    if (contribution.direction < 0) counts.contradictingEvidence += 1;
    if (contribution.sourceClass === 'human_confirmed') counts.humanConfirmations += 1;
    if (contribution.sourceClass === 'production_verified') counts.productionVerifications += 1;
  }
  return {
    ...counts,
    declaredEvidence: extra.declaredEvidence ?? 0,
    policy: CONFIDENCE_POLICY,
    contributions: contributions.map((item) => ({ ...item }))
  };
}

// Applies a contribution in place and returns whether it changed anything.
// Dedupe is by `key`: a retried operation with the same key is ignored, so
// confidence cannot be inflated by replaying the same evidence.
//
// A zero-delta contribution (an `unknown` outcome) is NOT recorded here: it does
// not move confidence, so adding it would put entries in the audit trail that
// explain no change. The operation itself is still recorded on the record and in
// the journal, so nothing is lost.
export function applyContribution(confidence, contribution) {
  const contributions = confidence.basis?.contributions ?? [];
  if (contributions.some((item) => item.key === contribution.key)) return false;
  if (contributionDelta(contribution) === 0) return false;
  const next = [...contributions, contribution];
  const before = confidence.current;
  const after = computeConfidence(confidence.initial, next);
  confidence.basis = summarizeBasis(next, { declaredEvidence: confidence.basis?.declaredEvidence ?? 0 });
  confidence.current = after;
  confidence.history.push({
    key: contribution.key,
    kind: contribution.kind,
    delta: round(after - before),
    from: before,
    to: after,
    reason: contribution.reason,
    sourceClass: contribution.sourceClass,
    provenance: contribution.provenance ?? { actor: null, client: null, sessionId: null },
    at: contribution.at
  });
  return true;
}

// A decision has exactly ONE outcome slot (`record.outcome`), so it must carry
// exactly ONE outcome contribution. Re-recording an outcome REPLACES the previous
// one instead of stacking a second.
//
// This exists because the previous design keyed the outcome contribution on
// `outcome:<id>:<observedAt>:<status>`. That embedded a wall-clock timestamp, so
// writing the SAME outcome twice produced two different keys whenever the two
// calls landed in different milliseconds — silently inflating confidence and
// double-counting `successfulOutcomes`. It passed its unit test only because the
// test's two calls happened to fall inside one millisecond.
//
// Replacement is safe precisely because computeConfidence is a pure fold over the
// contribution list: removing a contribution leaves no residue behind.
export function setOutcomeContribution(confidence, contribution) {
  const contributions = confidence.basis?.contributions ?? [];
  const previous = contributions.find((item) => item.kind === 'outcome');
  // An identical outcome re-recorded changes nothing and appends nothing.
  if (previous && previous.direction === contribution.direction && previous.sourceClass === contribution.sourceClass) return false;
  const others = contributions.filter((item) => item.kind !== 'outcome');
  // A zero-delta outcome ("unknown") is not stored: it explains no change.
  const next = contributionDelta(contribution) === 0 ? others : [...others, contribution];
  const before = confidence.current;
  const after = computeConfidence(confidence.initial, next);
  if (!previous && after === before) return false;
  confidence.basis = summarizeBasis(next, { declaredEvidence: confidence.basis?.declaredEvidence ?? 0 });
  confidence.current = after;
  confidence.history.push({
    key: contribution.key,
    kind: contribution.kind,
    delta: round(after - before),
    from: before,
    to: after,
    reason: previous ? `${contribution.reason} (replaced previous outcome)` : contribution.reason,
    sourceClass: contribution.sourceClass,
    provenance: contribution.provenance ?? { actor: null, client: null, sessionId: null },
    at: contribution.at
  });
  return true;
}

export function createConfidence(initial, declaredEvidence = 0) {
  return {
    initial: round(initial),
    current: round(initial),
    basis: summarizeBasis([], { declaredEvidence }),
    history: [],
    policy: CONFIDENCE_POLICY
  };
}
