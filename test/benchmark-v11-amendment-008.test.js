import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const AMENDMENT_PATH = fileURLToPath(
  new URL('../benchmark/preregistration-amendment-008.json', import.meta.url)
);
const SIDECAR_PATH = fileURLToPath(
  new URL('../benchmark/preregistration-amendment-008.sha256', import.meta.url)
);
const AMENDMENT_006 = '3bc9308a19e44ecc06d15dc0144239aa907b49cf897a11f9fab7cfe116966760';

test('Amendment 008 is a prospective meter-plan and cumulative-campaign contract', async () => {
  const bytes = await readFile(AMENDMENT_PATH);
  const amendment = JSON.parse(bytes.toString('utf8'));

  assert.equal(amendment.amendmentId, 'amendment-008');
  assert.equal(amendment.status, 'AUTHORIZED_PROSPECTIVE_REMEDIATION_PENDING_PINNED_LOOPBACK');
  assert.equal(amendment.supersedes.amendment006Sha256, AMENDMENT_006);
  const sidecar = await readFile(SIDECAR_PATH, 'utf8');
  const actualHash = createHash('sha256').update(bytes).digest('hex');
  assert.equal(sidecar, `${actualHash}  benchmark/preregistration-amendment-008.json\n`);
  assert.deepEqual(amendment.invariants, {
    scored: false,
    scenariosChanged: false,
    seedsChanged: false,
    repetitionsChanged: false,
    armSetChanged: false,
    frozenSourcesChanged: false,
    comparativeClaimsEnabled: false,
    scoringRulesChanged: false,
    responseSchemaChanged: false,
    applicabilityMatrixChanged: false,
    providerModelsChanged: false,
    providerEndpointsChanged: false,
    providerBudgetsRelaxed: false,
    timeoutsChanged: false
  });
  const protocol = amendment.prospectiveAttributionAndCampaignContract;
  assert.equal(protocol.planAuthority, 'meter-issued durable pre-dispatch root and dispatch plans');
  assert.deepEqual(protocol.forbiddenAuthoritySubstitutes, [
    'request-body-or-HMAC-identity',
    'ContextVar-only-identity',
    'caller-supplied-header-identity'
  ]);
  assert.equal(protocol.dynamicChildRule, 'declare each data-dependent child before its native root enters provider send');
  assert.equal(protocol.staticPlanRule, 'one declared provider send; later reuse is denied before upstream dispatch');
  assert.equal(protocol.aggregateCapRule, 'rootInvocationId plus requestClass caps are independent of plan slots and aliases');
  assert.equal(protocol.campaignRule, 'one durable campaign ledger spans probe and acceptance sessions; every admitted provider send carries one durable reservation receipt');
  assert.equal(protocol.pinnedCogneeLoopbackGate, 'required before any fresh non-scored acceptance; pending infrastructure is not proof');
  assert.equal(amendment.prospectiveEffect.rewriteHistoricalArtifacts, false);
  assert.equal(amendment.prospectiveEffect.rescoreExistingRuns, false);
  assert.equal(amendment.prospectiveEffect.resumeHistoricalRuns, false);
});

test('the benchmark gates include Amendment 008 and attribution vertical coverage', async () => {
  const packageJson = JSON.parse(await readFile(
    fileURLToPath(new URL('../package.json', import.meta.url)),
    'utf8'
  ));
  const suite = packageJson.scripts['benchmark:test:js'];
  for (const name of [
    'benchmark-v11-amendment-008.test.js',
    'benchmark-v11-dispatch-plan.test.js',
    'benchmark-v11-dispatch-plan-reconciliation.test.js',
    'benchmark-v11-provider-evidence-loader.test.js',
    'benchmark-v11-python-meter-bridge.integration.test.js'
  ]) assert.match(suite, new RegExp(`test/${name.replace(/[.]/gu, '\\.')}`, 'u'));
  assert.match(packageJson.scripts['benchmark:check'], /benchmark\/lib\/v11-provider-evidence-loader\.mjs/u);
});
