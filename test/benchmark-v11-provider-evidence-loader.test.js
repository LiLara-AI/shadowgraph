import assert from 'node:assert/strict';
import test from 'node:test';

import { reconcileProviderEvidenceFiles } from '../benchmark/lib/v11-provider-evidence-loader.mjs';

test('run evidence loading passes the paired plans ledger to strict reconciliation', async () => {
  const ledgerPath = '/evidence/attempt-1.provider-requests.ndjson';
  const reads = [];
  const seen = [];
  const report = Object.freeze({ status: 'RECONCILED' });
  const result = await reconcileProviderEvidenceFiles({
    ledgerPath,
    raw: { units: [] },
    attemptId: 'attempt-1',
    pinnedModels: { embedding: {}, internal_memory_llm: {} },
    nativeAttemptPolicy: { policies: [] },
    providerBudget: { limits: {} },
    campaignLedgerPath: '/campaign/campaign.ndjson',
    readFile: async (path, encoding) => {
      reads.push([path, encoding]);
      return {
        [ledgerPath]: 'provider-events\n',
        [`${ledgerPath}.attempts.ndjson`]: 'attempt-evidence\n',
        [`${ledgerPath}.plans.ndjson`]: 'plan-evidence\n',
        '/campaign/campaign.ndjson': 'campaign-evidence\n'
      }[path];
    },
    reconcile: (input) => {
      seen.push(input);
      return report;
    }
  });

  assert.equal(result, report);
  assert.deepEqual(reads, [
    [ledgerPath, 'utf8'],
    [`${ledgerPath}.attempts.ndjson`, 'utf8'],
    [`${ledgerPath}.plans.ndjson`, 'utf8'],
    ['/campaign/campaign.ndjson', 'utf8']
  ]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].ledgerText, 'provider-events\n');
  assert.equal(seen[0].attemptLedgerText, 'attempt-evidence\n');
  assert.equal(seen[0].planLedgerText, 'plan-evidence\n');
  assert.equal(seen[0].campaignLedgerText, 'campaign-evidence\n');
  assert.equal(seen[0].requireDispatchPlans, true);
  assert.equal(seen[0].requireCampaignReservations, true);
});
