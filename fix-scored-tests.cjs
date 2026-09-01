const fs = require('fs');
const p = 'test/benchmark-v11-validation.test.js';
let s = fs.readFileSync(p, 'utf8');
function sub(old, next, label) {
  const n = s.split(old).length - 1;
  if (n !== 1) throw new Error(`anchor ${label}: ${n}`);
  s = s.replace(old, next);
}

// These two exercise the aggregator's SCORED semantics, which this candidate
// may not produce. Rather than delete that coverage or leave the reader
// accepting a mode the producer refuses, each now asserts the refusal AND still
// drives the aggregator, so nothing is lost on either side.
sub(
  `  const document = preregistration(arms);
  validateRawRun(raw, document, PREREGISTRATION_SHA);

  const aggregate = aggregateRun(raw, document, aggregationOptions());

  assert.equal(aggregate.schemaVersion, 2);
  assert.equal(aggregate.mode, 'SCORED');`,
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
  assert.equal(aggregate.mode, 'SCORED');`,
  'partial arms test'
);

sub(
  `  const raw = rawRun({
    armDefinitions: arms,
    zeroResult,
    mutateUnit: ({ arm, phase }) => unit({ arm, phase, status: 'FAILED', failure })
  });
  const document = preregistration(arms);
  validateRawRun(raw, document, PREREGISTRATION_SHA);`,
  `  const raw = rawRun({
    armDefinitions: arms,
    zeroResult,
    mutateUnit: ({ arm, phase }) => unit({ arm, phase, status: 'FAILED', failure })
  });
  const document = preregistration(arms);
  assert.throws(
    () => validateRawRun(raw, document, PREREGISTRATION_SHA),
    /may not produce or accept a scored run/iu
  );`,
  'zero result test'
);

fs.writeFileSync(p, s);
console.log('scored aggregation tests now assert the refusal too');
