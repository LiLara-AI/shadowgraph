import { runProviderReconciliation } from './v11-provider-reconciler.mjs';

async function readTextOrNull(readFile, path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return null;
  }
}

export async function reconcileProviderEvidenceFiles(input = {}) {
  const {
    readFile,
    ledgerPath,
    raw,
    attemptId,
    pinnedModels,
    nativeAttemptPolicy,
    providerBudget,
    campaignLedgerPath = null,
    reconcile = runProviderReconciliation
  } = input;
  if (typeof readFile !== 'function' || typeof reconcile !== 'function') {
    throw new Error('provider evidence loading requires read and reconciliation functions');
  }
  const ledgerText = await readTextOrNull(readFile, ledgerPath);
  const attemptLedgerText = await readTextOrNull(readFile, `${ledgerPath}.attempts.ndjson`);
  const planLedgerText = await readTextOrNull(readFile, `${ledgerPath}.plans.ndjson`);
  const campaignLedgerText = typeof campaignLedgerPath === 'string'
    ? await readTextOrNull(readFile, campaignLedgerPath)
    : null;
  return reconcile({
    ledgerText,
    ledgerPath,
    raw,
    attemptId,
    pinnedModels,
    nativeAttemptPolicy,
    providerBudget,
    attemptLedgerText,
    planLedgerText,
    campaignLedgerText,
    requireDispatchPlans: true,
    requireCampaignReservations: true
  });
}
