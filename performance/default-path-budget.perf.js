// The delivery-budget performance cases (Plan v1.4.4 PR-17, §13.1, §13.3;
// PC-25(b); AC-059 clauses 2-3), moved out of the suite into their own CI step
// (owner decision, PR #12): `npm run test:performance` runs this file once per
// required job, before the suite, so no suite process competes with it, and
// fails unless every case here ran and passed. Nothing about the measurement
// changed: the 250 ms elapsed added latency per delivery with all of its I/O,
// the cold workload (a fresh store each measurement, its first save included),
// every sample and every functional and growth assertion. This file is not named
// for node's test discovery, so `npm test` does not run it a second time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { CONTEXT_DELIVERY_BUDGET } from '../src/mcp-tools.js';
import { checkWriteBudget, measureWrites } from '../scripts/context-size.mjs';
import { RUNTIME_MISSES_PER_READ } from '../src/internal/miss-ledger.js';

// Per-delivery evidence: which delivery was slow, and its saves, each split by
// phase (content-free; scripts/context-size.mjs). A failure message carries it;
// every measurement also prints it as a diagnostic.
const timings = (report) => JSON.stringify({ grantAdded: report.grant.addedMsMax, nullReferenceAdded: report.nullReference.addedMsMax, own: report.ownScope.deliveryMs, grant: report.grant.deliveryMs, grantSaves: report.grant.saveMs, nullReference: report.nullReference.deliveryMs, nullReferenceSaves: report.nullReference.saveMs, grantPhases: report.grant.phases, nullReferencePhases: report.nullReference.phases });

// Structural I/O, in addition to the elapsed-time budget and never instead of
// it, from the content-free phase records (PR #12).
// - The effectful operations are exact: per save, one lock acquisition, one
//   temporary write and one committed rename; outside a save, none.
// - The calls per file role are at most those measured on Windows and Linux,
//   Node 20, 22 and 24. Fewer is fine; more fails, so an extra read, write,
//   rename, lock or probe through node:fs/promises or a handle it opens is
//   seen. The synchronous node:fs API is not observed (scripts/context-size.mjs):
//   the save and lock paths make no such call, and a delivery's read of a
//   workspace binding file is not counted.
// - Where the temporary directory is reached through an alias (an 8.3 short
//   name on Windows), the store checks its control file under the name it was
//   given and under its canonical name: one more "other" call per check,
//   measured on Windows Node 24. The bound follows the path form in use.
// - A lock wait or rename retry the runner forces is counted apart, reported
//   with its error code, and its time stays inside the elapsed budget above.
const ALIASED = realpathSync.native(tmpdir()) !== tmpdir();
const SAVE_CALLS_AT_MOST = { lock: 6, store: 9, temp: 2, other: ALIASED ? 5 : 4 };
const FENCED_DELIVERY_CALLS_AT_MOST = { lock: 0, store: 5, temp: 0, other: ALIASED ? 3 : 2 };
const OWN_DELIVERY_CALLS_AT_MOST = { lock: 0, store: 0, temp: 0, other: 0 };
const atMost = (calls, limits) => Object.keys(limits).every((role) => calls[role] <= limits[role]);
function assertStructure(report, label = '') {
  for (const tier of ['ownScope', 'grant', 'nullReference']) {
    report[tier].phases.forEach(({ delivery, saves }, index) => {
      const why = (what) => `${label} ${tier} delivery ${index} ${what}: ${JSON.stringify({ delivery, saves })}`.trim();
      assert.ok(atMost(delivery.calls, tier === 'ownScope' ? OWN_DELIVERY_CALLS_AT_MOST : FENCED_DELIVERY_CALLS_AT_MOST), why('calls outside its save'));
      assert.equal(saves.length, tier === 'ownScope' ? 0 : 1, why('saves'));
      for (const save of saves) {
        assert.deepEqual([save.lock.acquired, save.writes, save.rename.committed], [1, 1, 1], why('one lock, one temporary write, one rename'));
        const forced = { lock: save.lock.contentionCalls, temp: save.rename.attempts - save.rename.committed };
        assert.ok(atMost({ ...save.calls, lock: save.calls.lock - forced.lock, temp: save.calls.temp - forced.temp }, SAVE_CALLS_AT_MOST), why(`calls (forced by the runner, counted apart: ${JSON.stringify(forced)})`));
      }
    });
  }
}

test('repeated and replayed deliveries on the HTTP transport stay within the declared budget', async (t) => {
  const report = await measureWrites({ deliveries: 3 });
  t.diagnostic(timings(report));
  assert.deepEqual(checkWriteBudget(report), [], timings(report));
  assertStructure(report);

  const own = report.ownScope;
  assert.equal(own.relevant, null, 'a plain delivery carries no relevant block');
  assert.equal(own.deliveries, 4, 'three reads a minute apart and a replay');
  assert.equal(own.saves, 0);
  assert.equal(own.bytesWritten, 0);
  assert.equal(own.revisionDelta, 0);
  assert.equal(own.journalDelta, 0);
  assert.equal(own.storeChanged, false);
  assert.deepEqual(own.changedKeys, []);
  assert.equal(own.replayIdentical, true, 'an identical delivery at the same instant returns the same payload and writes nothing');

  const grant = report.grant;
  assert.equal(grant.deliveries, 4, 'three deliveries a minute apart and one on the next UTC day');
  assert.equal(grant.saves, 4);
  assert.equal(grant.maxSavesPerDelivery, 1);
  assert.equal(grant.revisionDelta, 4);
  assert.equal(grant.journalDelta, 0);
  assert.equal(grant.canonicalWrites, 0, 'canonical values, non-audit events included, are unchanged');
  assert.deepEqual(grant.changedKeys, ['accessAudit', 'revision'], 'only the declared audit and the store revision change');
  assert.deepEqual(grant.accessUsed, { aggregates: 2, count: 4, days: 2, maxPerDay: 1 }, 'one aggregate per grant, surface, outcome and UTC day');
  assert.equal(grant.rewrite, 'whole_store');

  const nullReference = report.nullReference;
  assert.equal(nullReference.maxSavesPerDelivery, 1, 'a null access key takes the fenced path');
  assert.equal(nullReference.canonicalWrites, 0);
  assert.deepEqual(nullReference.changedKeys, ['revision'], 'and commits a revision with no audit');
});

// PR-26: a relevance read -- ranked, delivered as lines -- is the same
// default-path read, inside the same frozen budget.
test('a relevance read stays within the declared budget and writes nothing in its own scope', async (t) => {
  const report = await measureWrites({ deliveries: 2, request: { query: 'cache region deploy', compact: true } });
  t.diagnostic(timings(report));
  assert.deepEqual(checkWriteBudget(report), [], timings(report));
  assertStructure(report);
  const own = report.ownScope;
  assert.deepEqual(own.relevant, { established: true, tiers: ['T1'] }, 'the measured delivery is a relevance read, delivered as lines');
  assert.deepEqual([own.saves, own.bytesWritten, own.revisionDelta, own.journalDelta, own.storeChanged], [0, 0, 0, 0, false]);
  assert.equal(own.replayIdentical, true, 'the same relevance read at the same instant returns the same bytes');
  assert.equal(report.grant.canonicalWrites, 0);
  assert.deepEqual(report.grant.changedKeys, ['accessAudit', 'revision'], 'a granted relevance read changes only the declared audit');
});

// PR-28: a read the fallback answers records runtime misses. In its own scope
// it still writes nothing -- the misses wait in memory for the next save -- and
// a granted one carries them in the save it already makes, inside the same
// frozen budget. The ledger is declared operational data, not canonical truth.
test('a fallback read records runtime misses inside the same frozen budget', async (t) => {
  const report = await measureWrites({ deliveries: 2, request: { query: 'zebra crossing', compact: true } });
  t.diagnostic(timings(report));
  assert.deepEqual(checkWriteBudget(report), [], timings(report));
  assertStructure(report);
  const own = report.ownScope;
  assert.deepEqual(own.relevant, { established: false, tiers: ['T2'] }, 'the measured delivery is answered by the fallback');
  assert.deepEqual([own.saves, own.bytesWritten, own.revisionDelta, own.journalDelta, own.storeChanged, own.runtimeMissesAdded], [0, 0, 0, 0, false, 0]);
  assert.equal(own.replayIdentical, true);
  assert.equal(report.grant.canonicalWrites, 0);
  assert.deepEqual(report.grant.changedKeys, ['accessAudit', 'revision', 'runtimeMisses'], 'a granted fallback read changes only the declared audit and the ledger');
  assert.equal(report.grant.runtimeMissesAdded, RUNTIME_MISSES_PER_READ * report.grant.deliveries, 'a bounded number per delivery, each repeat going on to what it has not recorded');
});

// An entry carries the project and origin verbatim, so the writer bounds its
// bytes and records one per read: a long or escaped name or origin, which the
// audit aggregate carries too, still leaves a granted delivery inside the ceiling.
test('a fallback read by a long or escaped project name or origin stays inside the same growth ceiling', async (t) => {
  const control = String.fromCharCode(1);
  const cases = [
    ['a 300-character project', { project: 'p'.repeat(300) }],
    ['a 300-character Arabic project', { project: 'مشروع'.repeat(60) }],
    ['a long origin', { originId: `origin_${'o'.repeat(700)}` }],
    ['escaped quotes in both labels', { project: '"'.repeat(128), originId: '"'.repeat(128) }],
    ['a recorded entry beside escaped labels', { project: '"'.repeat(128), originId: '"'.repeat(60) }],
    ['escaped labels with an entry at the bound', { project: '"'.repeat(128), originId: '"'.repeat(78) }],
    ['control characters in both labels', { project: control.repeat(128), originId: control.repeat(128) }],
    ['control characters with an entry near the bound', { project: control.repeat(128), originId: control.repeat(60) }]
  ];
  for (const [label, { project, originId }] of cases) {
    const report = await measureWrites({ deliveries: 1, ...(project ? { project } : {}), request: { query: 'zebra crossing', compact: true, ...(originId ? { originId } : {}) } });
    t.diagnostic(`${label} ${timings(report)}`);
    assert.deepEqual(checkWriteBudget(report), [], `${label} ${timings(report)}`);
    assertStructure(report, label);
    assert.equal(report.grant.canonicalWrites, 0, label);
  }
});

test('the budget check fails each category it measures rather than adjusting', async (t) => {
  const report = await measureWrites({ deliveries: 1 });
  t.diagnostic(timings(report));
  assert.deepEqual(checkWriteBudget(report), [], timings(report));
  assertStructure(report);
  const { ownScope, grant } = CONTEXT_DELIVERY_BUDGET;
  const cases = [];
  for (const [tier, declared] of [['ownScope', ownScope], ['grant', grant], ['nullReference', grant]]) {
    const deliveries = report[tier].deliveries;
    cases.push(
      [tier, 'canonicalWrites', declared.canonicalWrites + 1, `${tier}.canonicalWrites`],
      [tier, 'journalDelta', (declared.journalEntries + 1) * deliveries, `${tier}.journalEntries`],
      [tier, 'revisionDelta', (declared.revisions + 1) * deliveries, `${tier}.revisions`],
      [tier, 'maxSavesPerDelivery', declared.saves + 1, `${tier}.saves`],
      [tier, 'addedMsMax', declared.addedMs + 1, `${tier}.addedMs`]);
  }
  cases.push(['ownScope', 'bytesWritten', ownScope.bytesWritten + 1, 'ownScope.bytesWritten']);
  for (const tier of ['grant', 'nullReference']) {
    cases.push([tier, 'maxGrowthBytes', grant.growthBytes + 1, `${tier}.growthBytes`]);
    cases.push([tier, 'accessUsed.maxPerDay', grant.newAuditAggregatesPerKeyDay + 1, `${tier}.audit aggregates`]);
  }
  assert.equal(cases.length, 20);
  for (const [tier, field, value, label] of cases) {
    const over = structuredClone(report);
    const path = field.split('.');
    path.slice(0, -1).reduce((node, key) => node[key], over[tier])[path.at(-1)] = value;
    const violations = checkWriteBudget(over);
    assert.equal(violations.length, 1, `${tier}.${field}: ${violations.join('; ')}`);
    assert.ok(violations[0].startsWith(label), violations[0]);
  }
});
