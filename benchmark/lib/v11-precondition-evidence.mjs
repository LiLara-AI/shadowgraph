// Verified evidence for a declared isolation precondition.
//
// The registry records that Cognee has a native user namespace whose use is
// conditional on a pinned backend access-control configuration. Until now the
// only way to say that condition held was `--preconditions` on the command
// line, and the v1.1 blocker matrix said plainly what that is worth: an input,
// not proof. This module is the replacement.
//
// What it verifies is a record of a behavioural demonstration, checked against
// the two committed statements that can contradict it - the precondition string
// the registry declares, and the package version the competitor lock pins.
//
// The rule that carries the weight is the required-step set. A demonstration
// that recorded only a refusal would satisfy a naive check while proving almost
// nothing: a misconfigured store, a missing dataset or a typo all produce a
// refusal too. So the record must contain the positive control, the refusal,
// and the grant that turns that same refusal into a success. Only the
// permission changed between the last two, so only the permission explains the
// difference - and a record missing any of those three establishes nothing.
//
// What this cannot do is establish that the demonstration ever ran. The record
// is a file. That limit is stated in `note` rather than implied away, and it is
// why `v11-precondition-probe` exists: the harness runs the demonstration
// inside the pinned image and writes the record itself.

export const PRECONDITION_EVIDENCE_SCHEMA = 'shadowgraph.v11.precondition-evidence';
export const PRECONDITION_EVIDENCE_VERSION = 1;

/**
 * How long a demonstration stays good for.
 *
 * The same window the service evidence uses, for the same reason: the
 * configuration a run executes under has to be the configuration that was
 * demonstrated, and a record kept from last week describes a machine that may
 * since have been reconfigured.
 */
export const PRECONDITION_EVIDENCE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

export const PRECONDITION_EVIDENCE_NOTE =
  'shape, freshness, and agreement with the declared precondition and the pinned '
  + 'package only; this check cannot establish that the recorded demonstration was '
  + 'actually performed against the described product';

/**
 * The steps a demonstration must contain, per arm.
 *
 * Not a summary of what the probe happens to emit - a contract. Each entry is
 * here because its absence would let a weaker demonstration pass:
 *
 *   posture                              - the precondition itself, resolved
 *   users, ingest                        - two principals, one dataset name
 *   identical-name-distinct-datasets     - the name is not the scope
 *   positive-control-own-dataset         - the store works at all
 *   cross-user-read-refused              - the boundary exists
 *   listing-omits-other-dataset          - it holds on the listing path too
 *   grant                                - the permission changed, nothing else
 *   cross-user-read-allowed-after-grant  - so the refusal was the permission
 *   per-dataset-stores                   - and the isolation is physical
 */
export const REQUIRED_DEMONSTRATION_STEPS = Object.freeze({
  cognee: Object.freeze([
    'posture',
    'users',
    'ingest',
    'identical-name-distinct-datasets',
    'positive-control-own-dataset',
    'cross-user-read-refused',
    'listing-omits-other-dataset',
    'grant',
    'cross-user-read-allowed-after-grant',
    'per-dataset-stores'
  ])
});

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function instantOf(value) {
  if (!isNonEmptyString(value)) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Decide which declared preconditions a demonstration record establishes.
 *
 * `declaredPreconditions` maps an arm id to the precondition string the
 * registry declares for it, or null; `pinnedPackages` maps an arm id to the
 * package and version the competitor lock pins. Both are the committed side of
 * the comparison, and neither is taken from the record.
 */
export function verifyPreconditionEvidence(input) {
  const { evidence, declaredPreconditions, pinnedPackages, now } = input ?? {};
  const empty = (findings) => Object.freeze({
    satisfiedPreconditions: new Set(),
    findings: Object.freeze(findings),
    note: PRECONDITION_EVIDENCE_NOTE
  });

  if (evidence === null || evidence === undefined) {
    return empty([{
      code: 'PRECONDITION_EVIDENCE_ABSENT',
      detail: 'no precondition demonstration was supplied'
    }]);
  }
  if (!Number.isFinite(now)) {
    return empty([{ code: 'PRECONDITION_EVIDENCE_UNTIMED', detail: 'a verification instant is required' }]);
  }
  if (!isPlainRecord(declaredPreconditions) || Object.keys(declaredPreconditions).length === 0) {
    return empty([{
      code: 'DECLARED_PRECONDITIONS_UNUSABLE',
      detail: 'the declared precondition matrix is absent or empty'
    }]);
  }
  if (!isPlainRecord(pinnedPackages) || Object.keys(pinnedPackages).length === 0) {
    return empty([{
      code: 'PINNED_PACKAGES_UNUSABLE',
      detail: 'the pinned package matrix is absent or empty'
    }]);
  }

  if (!isPlainRecord(evidence)
    || evidence.schema !== PRECONDITION_EVIDENCE_SCHEMA
    || evidence.version !== PRECONDITION_EVIDENCE_VERSION
    || !isNonEmptyString(evidence.armId)
    || !Array.isArray(evidence.steps)
    || evidence.steps.length === 0
    || !isPlainRecord(evidence.package)) {
    return empty([{
      code: 'PRECONDITION_EVIDENCE_MALFORMED',
      detail: `evidence must declare schema ${PRECONDITION_EVIDENCE_SCHEMA} version ${PRECONDITION_EVIDENCE_VERSION}, an arm, a package and a non-empty step list`
    }]);
  }

  const armId = evidence.armId;
  const findings = [];

  const observedAt = instantOf(evidence.observedAt);
  if (observedAt === null) {
    return empty([{ code: 'PRECONDITION_EVIDENCE_MALFORMED', detail: 'observedAt is not an instant' }]);
  }
  if (observedAt > now) {
    return empty([{ code: 'PRECONDITION_EVIDENCE_FUTURE_DATED', armId, observedAt: evidence.observedAt }]);
  }
  if (now - observedAt >= PRECONDITION_EVIDENCE_MAX_AGE_MS) {
    return empty([{
      code: 'PRECONDITION_EVIDENCE_STALE',
      armId,
      observedAt: evidence.observedAt,
      maxAgeMs: PRECONDITION_EVIDENCE_MAX_AGE_MS
    }]);
  }

  const declared = declaredPreconditions[armId] ?? null;
  if (declared === null) {
    return empty([{
      code: 'PRECONDITION_ARM_UNDECLARED',
      armId,
      detail: 'the registry declares no isolation precondition for this arm'
    }]);
  }
  if (evidence.precondition !== declared) {
    findings.push({
      code: 'PRECONDITION_MISMATCH',
      armId,
      declared,
      recorded: evidence.precondition ?? null
    });
  }

  const pinned = pinnedPackages[armId] ?? null;
  if (!isPlainRecord(pinned)
    || evidence.package.name !== pinned.name
    || evidence.package.version !== pinned.version) {
    findings.push({
      code: 'PRECONDITION_PACKAGE_MISMATCH',
      armId,
      pinned: pinned === null ? null : { ...pinned },
      recorded: { name: evidence.package.name ?? null, version: evidence.package.version ?? null }
    });
  }

  // The precondition is the posture. A record that demonstrates a boundary
  // while reporting the posture off is describing a different configuration.
  if (evidence.backendAccessControlEnabled !== true) {
    findings.push({
      code: 'PRECONDITION_POSTURE_NOT_ENABLED',
      armId,
      recorded: evidence.backendAccessControlEnabled ?? null
    });
  }

  if (evidence.outcome !== 'PASS') {
    findings.push({ code: 'DEMONSTRATION_FAILED', armId, outcome: evidence.outcome ?? null });
  }

  const observed = new Map();
  for (const entry of evidence.steps) {
    if (!isPlainRecord(entry) || !isNonEmptyString(entry.step)) {
      findings.push({ code: 'PRECONDITION_EVIDENCE_MALFORMED', armId, detail: 'every step needs a name' });
      continue;
    }
    observed.set(entry.step, entry.outcome);
  }
  for (const required of REQUIRED_DEMONSTRATION_STEPS[armId] ?? []) {
    if (!observed.has(required)) {
      findings.push({ code: 'DEMONSTRATION_STEP_MISSING', armId, demonstrationStep: required });
    } else if (observed.get(required) !== 'PASS') {
      findings.push({
        code: 'DEMONSTRATION_STEP_FAILED',
        armId,
        demonstrationStep: required,
        outcome: observed.get(required) ?? null
      });
    }
  }

  if (findings.length > 0) return empty(findings);
  return Object.freeze({
    satisfiedPreconditions: new Set([declared]),
    findings: Object.freeze([]),
    note: PRECONDITION_EVIDENCE_NOTE
  });
}
