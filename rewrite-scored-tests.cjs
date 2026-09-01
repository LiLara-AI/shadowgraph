const fs = require('fs');
const p = 'test/benchmark-v11-validation.test.js';
let s = fs.readFileSync(p, 'utf8');
function sub(old, next, label) {
  const n = s.split(old).length - 1;
  if (n !== 1) throw new Error(`anchor ${label}: ${n}`);
  s = s.replace(old, next);
}

// aggregateV11Run calls validateV11RawRun first, so refusing SCORED in the
// validator closes the whole reader side in one place - and makes the scored
// aggregation path genuinely unreachable. These two tests asserted that path.
// They now assert the refusal at both entry points, and keep the ACCEPTANCE-mode
// structural coverage that still applies. The scored assertions are not
// preserved anywhere: that is a real coverage loss and is recorded rather than
// hidden, because tests passing against a path the code refuses would imply a
// capability this candidate does not have.
sub(
  `  const document = preregistration(arms);
  // The reader refuses this mode, symmetric to the producer refusing to emit
  // it. The aggregator's scored behaviour is still exercised below, because it
  // has to keep working for whenever a scored run is authorised - it is simply
  // unreachable through a validated artifact today.
  assert.throws(
    () => validateRawRun(raw, document, PREREGISTRATION_SHA),
    /may not produce or accept a scored run/iu
  );

  const aggregate = aggregateRun(raw, document, aggregationOptions());

  assert.equal(aggregate.schemaVersion, 2);
  assert.equal(aggregate.mode, 'SCORED');
  assert.deepEqual(aggregate.rankEligibleArms, ['arm-na']);
  assert.deepEqual(aggregate.armResults.map((result) => result.armId), ['arm-na']);
  assert.equal(aggregate.armResults[0].rankEligible, true);
  assert.equal(aggregate.armResults[0].metrics.userIsolation, null);
  assert.equal(aggregate.armResults[0].economics.meanOuterDecisionTokens, 108);
  assert.equal(
    aggregate.armResults[0].economics.meanLifecycleTokens,
    null,
    'outer-only usage must not be mislabeled as total lifecycle tokens'
  );
  assert.equal(aggregate.armResults.some((result) => result.armId === 'arm-partial'), false);
  assert.equal(aggregate.bestClaimAllowed, false);`,
  `  const document = preregistration(arms);
  validateRawRun(raw, document, PREREGISTRATION_SHA);

  const aggregate = aggregateRun(raw, document, aggregationOptions());

  assert.equal(aggregate.schemaVersion, 2);
  assert.equal(aggregate.mode, 'ACCEPTANCE');
  assert.deepEqual(aggregate.armResults.map((result) => result.armId), ['arm-na']);
  assert.equal(aggregate.armResults[0].metrics.userIsolation, null);
  assert.equal(aggregate.armResults[0].economics.meanOuterDecisionTokens, 108);
  assert.equal(
    aggregate.armResults[0].economics.meanLifecycleTokens,
    null,
    'outer-only usage must not be mislabeled as total lifecycle tokens'
  );
  assert.equal(aggregate.armResults.some((result) => result.armId === 'arm-partial'), false);

  // The reader refuses SCORED, symmetric to the producer refusing to emit it.
  // aggregateV11Run validates first, so one refusal covers both entry points -
  // which also means the scored aggregation path (rankEligibleArms,
  // bestClaimAllowed, allowedMarketingText) is unreachable and therefore
  // untested while this candidate is in this state. That is a real coverage
  // loss, recorded here rather than papered over: tests green against a path
  // the code refuses would imply a capability the candidate does not have.
  const scoredRaw = { ...structuredClone(raw), mode: 'SCORED' };
  assert.throws(
    () => validateRawRun(scoredRaw, document, PREREGISTRATION_SHA),
    /may not produce or accept a scored run/iu
  );
  assert.throws(
    () => aggregateRun(scoredRaw, document, aggregationOptions()),
    /may not produce or accept a scored run/iu
  );`,
  'partial arms test'
);

sub(
  `  // Validated as ACCEPTANCE, which is the only mode this candidate may produce
  // or accept. The aggregator is then driven over the same units in SCORED mode
  // to exercise the marketing-text path, which exists only there - reachable in
  // a test, unreachable through a validated artifact.
  assert.doesNotThrow(() => validateRawRun(raw, document, PREREGISTRATION_SHA));
  const scoredRaw = { ...structuredClone(raw), mode: 'SCORED' };
  assert.throws(
    () => validateRawRun(scoredRaw, document, PREREGISTRATION_SHA),
    /may not produce or accept a scored run/iu
  );
  const aggregate = aggregateRun(scoredRaw, document, aggregationOptions());
  assert.deepEqual(aggregate.zeroResult, zeroResult);
  assert.equal(aggregate.allowedMarketingText, 'No measured result is available. Recorded causes: TIMEOUT.');
  assert.doesNotMatch(aggregate.allowedMarketingText, /endpoint/iu);`,
  `  assert.doesNotThrow(() => validateRawRun(raw, document, PREREGISTRATION_SHA));
  const aggregate = aggregateRun(raw, document, aggregationOptions());
  assert.deepEqual(aggregate.zeroResult, zeroResult);
  // allowedMarketingText is a scored-mode field and is absent here, which is
  // the point: an acceptance aggregate carries no marketing claim at all.
  assert.equal(Object.hasOwn(aggregate, 'allowedMarketingText'), false);`,
  'zero result test'
);

fs.writeFileSync(p, s);
console.log('scored tests rewritten around the refusal');
