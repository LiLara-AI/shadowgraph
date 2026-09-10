import { readFile, writeFile, mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { createServer } from 'node:http';
import { startProviderMeter } from '../benchmark/lib/provider-meter.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { canonicalJson } from '../benchmark/lib/v11-contract.mjs';
import { assertRestrictedCampaignExecutionPolicy, claimCampaignContinuation, createCampaignBudget, openCampaignBudget, verifyCampaignPolicyLineage } from '../benchmark/lib/v11-campaign-budget.mjs';

const policy = {
  campaignId: 'offline-only', implementationLockHash: 'a'.repeat(64),
  maxRequests: 2, maxSessions: 2, maxRecoveryAttempts: 1,
  deadline: '2099-01-01T00:00:00.000Z',
  limits: { outer_decision_llm: 1, internal_memory_llm: 1, embedding: 1 }
};

test('restricted execution mode refuses campaign continuation policies', () => {
  const continuation = {
    ...policy,
    campaignId: 'unsupported-successor',
    implementationLockHash: 'b'.repeat(64),
    campaignLineageId: 'offline-only',
    continuation: {
      predecessorLedgerPath: '/tmp/predecessor/campaign.ndjson',
      predecessorLedgerSha256: 'a'.repeat(64),
      predecessorReceiptId: 'offline-only:1',
      predecessorReceiptSha256: 'b'.repeat(64),
      continuityRegistryPath: '/tmp/registry.ndjson',
      continuityRegistryGenesisSha256: 'c'.repeat(64),
      registryClaimId: 'unsupported-claim'
    }
  };
  assert.throws(() => assertRestrictedCampaignExecutionPolicy(continuation), /continuation.*unsupported/u);
});

test('stateful campaign APIs refuse a structurally valid continuation before roots or registry effects', async (t) => {
  const directory = await scratchDirectory(t, 'restricted-continuation-api-');
  const continuation = {
    ...policy,
    campaignId: 'restricted-api-successor',
    implementationLockHash: 'b'.repeat(64),
    campaignLineageId: policy.campaignId,
    continuation: {
      predecessorLedgerPath: path.join(directory, 'predecessor', 'campaign.ndjson'),
      predecessorLedgerSha256: 'a'.repeat(64),
      predecessorReceiptId: `${policy.campaignId}:1`,
      predecessorReceiptSha256: 'b'.repeat(64),
      continuityRegistryPath: path.join(directory, 'registry.ndjson'),
      continuityRegistryGenesisSha256: 'c'.repeat(64),
      registryClaimId: 'restricted-api-claim'
    }
  };
  const root = path.join(directory, 'successor');
  const exists = async (candidate) => import('node:fs/promises')
    .then(({ lstat }) => lstat(candidate).then(() => true, () => false));
  for (const invoke of [
    () => createCampaignBudget(root, continuation),
    () => openCampaignBudget(root, continuation),
    () => claimCampaignContinuation(continuation, root)
  ]) {
    await assert.rejects(invoke(), /Campaign continuation is unsupported in restricted execution mode/u);
  }
  assert.equal(await exists(root), false);
  assert.equal(await exists(continuation.continuation.continuityRegistryPath), false);
});

test('campaign reservations survive fresh sessions and count in-flight calls without refunds', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-budget-'), 'campaign');
  await createCampaignBudget(root, policy);
  const first = await openCampaignBudget(root, policy);
  await assert.rejects(openCampaignBudget(root, policy), /locked/);
  await first.beginSession('probe-1');
  const results = await Promise.all([first.reserve('embedding'), first.reserve('embedding')]);
  assert.deepEqual(results, [true, false]);
  await first.close();
  const next = await openCampaignBudget(root, policy);
  await next.beginSession('fresh-run');
  assert.equal(await next.reserve('outer_decision_llm'), true);
  assert.equal(await next.reserve('internal_memory_llm'), false);
  await assert.rejects(next.beginSession('another-run'), /session/);
  await next.close();
});

test('campaign reservations durably join a prospective session to one dispatch plan', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-lineage-'), 'campaign');
  await createCampaignBudget(root, policy);
  const campaign = await openCampaignBudget(root, policy);
  await campaign.beginSession('probe-lineage-1', {
    kind: 'probe',
    runId: 'probe-run-1',
    attemptId: 'probe-attempt-1'
  });
  const reservation = await campaign.reserve({
    requestClass: 'embedding',
    runId: 'probe-run-1',
    attemptId: 'probe-attempt-1',
    armId: 'cognee',
    scenarioId: 'ACC_PLAN_1',
    repetition: 0,
    phase: 'A',
    rootOperation: 'persist',
    rootInvocationId: 'root-probe-1',
    plannedDispatchId: 'a'.repeat(48),
    planSlot: 'adapter-embedding:child:1',
    disposition: 'data-dependent-child'
  });
  await campaign.close();

  assert.match(reservation.reservationId, /^offline-only:[1-9]\d*$/u);
  const rows = (await readFile(path.join(root, 'campaign.ndjson'), 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(rows[1], {
    event: 'session', id: 'probe-lineage-1', recovery: false,
    kind: 'probe', runId: 'probe-run-1', attemptId: 'probe-attempt-1'
  });
  assert.deepEqual(rows[2], {
    event: 'reservation', reservationId: reservation.reservationId,
    session: 'probe-lineage-1', requestClass: 'embedding',
    runId: 'probe-run-1', attemptId: 'probe-attempt-1', armId: 'cognee',
    scenarioId: 'ACC_PLAN_1', repetition: 0, phase: 'A', rootOperation: 'persist',
    rootInvocationId: 'root-probe-1', plannedDispatchId: 'a'.repeat(48),
    planSlot: 'adapter-embedding:child:1', disposition: 'data-dependent-child'
  });
});

test('a prospective receipt ledger reopens with its receipt sequence intact', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-reopen-receipt-'), 'campaign');
  const bounded = {
    ...policy,
    maxRequests: 2,
    limits: { outer_decision_llm: 0, internal_memory_llm: 0, embedding: 2 }
  };
  const reservation = (runId, attemptId, plannedDispatchId) => ({
    requestClass: 'embedding', runId, attemptId, armId: 'cognee',
    scenarioId: 'receipt-reopen', repetition: 0, phase: 'probe', rootOperation: 'persist',
    rootInvocationId: `${runId}-root`, plannedDispatchId, planSlot: `${runId}:slot`, disposition: 'root-initial'
  });
  await createCampaignBudget(root, bounded);
  const first = await openCampaignBudget(root, bounded);
  await first.beginSession('receipt-session-1', { kind: 'probe', runId: 'receipt-run-1', attemptId: 'receipt-attempt-1' });
  assert.deepEqual(await first.reserve(reservation('receipt-run-1', 'receipt-attempt-1', 'a'.repeat(48))), {
    reservationId: 'offline-only:1'
  });
  await first.close();

  const resumed = await openCampaignBudget(root, bounded);
  try {
    await resumed.beginSession('receipt-session-2', { kind: 'probe', runId: 'receipt-run-2', attemptId: 'receipt-attempt-2' });
    assert.deepEqual(await resumed.reserve(reservation('receipt-run-2', 'receipt-attempt-2', 'b'.repeat(48))), {
      reservationId: 'offline-only:2'
    });
  } finally {
    await resumed.close();
  }
});

test('a structurally valid successor remains diagnostic-only and cannot create a campaign root', async (t) => {
  const directory = await scratchDirectory(t, 'campaign-successor-refusal-');
  const successorRoot = path.join(directory, 'successor');
  const successor = {
    ...policy,
    campaignId: 'successor-physical-policy',
    implementationLockHash: 'b'.repeat(64),
    campaignLineageId: policy.campaignId,
    continuation: {
      predecessorLedgerPath: path.join(directory, 'predecessor', 'campaign.ndjson'),
      predecessorLedgerSha256: 'a'.repeat(64),
      predecessorReceiptId: `${policy.campaignId}:1`,
      predecessorReceiptSha256: 'b'.repeat(64),
      continuityRegistryPath: path.join(directory, 'registry.ndjson'),
      continuityRegistryGenesisSha256: 'c'.repeat(64),
      registryClaimId: 'valid-successor-claim'
    }
  };
  await assert.rejects(createCampaignBudget(successorRoot, successor), /Campaign continuation is unsupported in restricted execution mode/u);
  await assert.rejects(openCampaignBudget(successorRoot, successor), /Campaign continuation is unsupported in restricted execution mode/u);
  await assert.rejects(claimCampaignContinuation(successor, successorRoot), /Campaign continuation is unsupported in restricted execution mode/u);
  await assert.rejects(import('node:fs/promises').then(({ lstat }) => lstat(successorRoot)), { code: 'ENOENT' });
});

test('multiple structurally valid successors cannot claim or create separate campaign roots', async (t) => {
  const directory = await scratchDirectory(t, 'campaign-successor-fork-refusal-');
  const successor = (campaignId, claimId) => ({
    ...policy,
    campaignId,
    implementationLockHash: 'b'.repeat(64),
    campaignLineageId: policy.campaignId,
    continuation: {
      predecessorLedgerPath: path.join(directory, 'predecessor', 'campaign.ndjson'),
      predecessorLedgerSha256: 'a'.repeat(64),
      predecessorReceiptId: `${policy.campaignId}:1`,
      predecessorReceiptSha256: 'b'.repeat(64),
      continuityRegistryPath: path.join(directory, 'registry.ndjson'),
      continuityRegistryGenesisSha256: 'c'.repeat(64),
      registryClaimId: claimId
    }
  });
  const first = successor('first-successor-policy', 'first-claim');
  const fork = successor('fork-successor-policy', 'fork-claim');
  for (const [root, candidate] of [
    [path.join(directory, 'first-successor'), first],
    [path.join(directory, 'fork-successor'), fork]
  ]) {
    await assert.rejects(createCampaignBudget(root, candidate), /Campaign continuation is unsupported in restricted execution mode/u);
    await assert.rejects(claimCampaignContinuation(candidate, root), /Campaign continuation is unsupported in restricted execution mode/u);
    await assert.rejects(import('node:fs/promises').then(({ lstat }) => lstat(root)), { code: 'ENOENT' });
  }
  await assert.rejects(import('node:fs/promises').then(({ lstat }) => lstat(path.join(directory, 'registry.ndjson'))), { code: 'ENOENT' });
});

test('lineage verification refuses an already-claimed predecessor before campaign-root creation', async (t) => {
  const directory = await scratchDirectory(t, 'campaign-registry-conflict-');
  const predecessorRoot = path.join(directory, 'predecessor');
  const lineageId = 'registry-conflict-lineage';
  const predecessor = {
    campaignId: lineageId,
    implementationLockHash: 'a'.repeat(64),
    maxRequests: 2,
    maxSessions: 2,
    maxRecoveryAttempts: 0,
    deadline: '2099-01-01T00:00:00.000Z',
    limits: { outer_decision_llm: 0, internal_memory_llm: 0, embedding: 2 }
  };
  await createCampaignBudget(predecessorRoot, predecessor);
  const original = await openCampaignBudget(predecessorRoot, predecessor);
  await original.beginSession('registry-parent-session', { kind: 'probe', runId: 'registry-parent-run', attemptId: 'registry-parent-attempt' });
  await original.reserve({
    requestClass: 'embedding', runId: 'registry-parent-run', attemptId: 'registry-parent-attempt', armId: 'cognee',
    scenarioId: 'registry-conflict', repetition: 0, phase: 'probe', rootOperation: 'persist',
    rootInvocationId: 'registry-parent-root', plannedDispatchId: 'a'.repeat(48), planSlot: 'registry:slot', disposition: 'root-initial'
  });
  await original.close();
  const predecessorLedgerPath = path.join(predecessorRoot, 'campaign.ndjson');
  const predecessorLedgerText = await readFile(predecessorLedgerPath, 'utf8');
  const terminal = predecessorLedgerText.trimEnd().split('\n').map(JSON.parse).at(-1);
  const sha256 = async (value) => (await import('node:crypto')).createHash('sha256').update(value, 'utf8').digest('hex');
  const predecessorLedgerSha256 = await sha256(predecessorLedgerText);
  const predecessorReceiptSha256 = await sha256(canonicalJson(terminal));
  const registryPath = path.join(directory, 'registry.ndjson');
  const genesis = {
    event: 'genesis', campaignLineageId: lineageId, predecessorLedgerSha256,
    predecessorReceiptId: terminal.reservationId, predecessorReceiptSha256
  };
  const conflictingClaim = {
    event: 'claim',
    claimId: 'other-claim',
    campaignLineageId: lineageId,
    predecessorLedgerSha256,
    predecessorReceiptId: terminal.reservationId,
    predecessorReceiptSha256,
    successorCampaignId: 'other-successor',
    successorImplementationLockHash: 'b'.repeat(64),
    successorPolicySha256: 'c'.repeat(64),
    campaignRoot: path.join(directory, 'other-root')
  };
  await writeFile(registryPath, `${JSON.stringify(genesis)}\n${JSON.stringify(conflictingClaim)}\n`);
  const successor = {
    ...predecessor,
    campaignId: 'wanted-successor',
    implementationLockHash: 'd'.repeat(64),
    campaignLineageId: lineageId,
    continuation: {
      predecessorLedgerPath,
      predecessorLedgerSha256,
      predecessorReceiptId: terminal.reservationId,
      predecessorReceiptSha256,
      continuityRegistryPath: registryPath,
      continuityRegistryGenesisSha256: await sha256(canonicalJson(genesis)),
      registryClaimId: 'wanted-claim'
    }
  };
  const futureRoot = path.join(directory, 'future-root');
  await assert.rejects(
    verifyCampaignPolicyLineage(successor, { currentLedgerPath: path.join(futureRoot, 'campaign.ndjson') }),
    /predecessor receipt is already claimed/u
  );
  assert.equal(await import('node:fs/promises').then(({ lstat }) => lstat(futureRoot).then(() => true, () => false)), false);
});

test('a registry genesis must bind the actual lineage origin receipt', async (t) => {
  const directory = await scratchDirectory(t, 'campaign-registry-origin-');
  const predecessorRoot = path.join(directory, 'predecessor');
  const lineageId = 'registry-origin-lineage';
  const predecessor = {
    campaignId: lineageId,
    implementationLockHash: 'a'.repeat(64),
    maxRequests: 2,
    maxSessions: 2,
    maxRecoveryAttempts: 0,
    deadline: '2099-01-01T00:00:00.000Z',
    limits: { outer_decision_llm: 0, internal_memory_llm: 0, embedding: 2 }
  };
  await createCampaignBudget(predecessorRoot, predecessor);
  const original = await openCampaignBudget(predecessorRoot, predecessor);
  await original.beginSession('origin-parent-session', { kind: 'probe', runId: 'origin-parent-run', attemptId: 'origin-parent-attempt' });
  await original.reserve({
    requestClass: 'embedding', runId: 'origin-parent-run', attemptId: 'origin-parent-attempt', armId: 'cognee',
    scenarioId: 'registry-origin', repetition: 0, phase: 'probe', rootOperation: 'persist',
    rootInvocationId: 'origin-parent-root', plannedDispatchId: 'a'.repeat(48), planSlot: 'origin:slot', disposition: 'root-initial'
  });
  await original.close();
  const predecessorLedgerPath = path.join(predecessorRoot, 'campaign.ndjson');
  const predecessorLedgerText = await readFile(predecessorLedgerPath, 'utf8');
  const terminal = predecessorLedgerText.trimEnd().split('\n').map(JSON.parse).at(-1);
  const sha256 = async (value) => (await import('node:crypto')).createHash('sha256').update(value, 'utf8').digest('hex');
  const predecessorLedgerSha256 = await sha256(predecessorLedgerText);
  const predecessorReceiptSha256 = await sha256(canonicalJson(terminal));
  const registryPath = path.join(directory, 'registry.ndjson');
  const forgedGenesis = {
    event: 'genesis', campaignLineageId: lineageId,
    predecessorLedgerSha256: 'e'.repeat(64),
    predecessorReceiptId: `${lineageId}:1`,
    predecessorReceiptSha256: 'f'.repeat(64)
  };
  await writeFile(registryPath, `${JSON.stringify(forgedGenesis)}\n`);
  const successor = {
    ...predecessor,
    campaignId: 'origin-successor',
    implementationLockHash: 'b'.repeat(64),
    campaignLineageId: lineageId,
    continuation: {
      predecessorLedgerPath,
      predecessorLedgerSha256,
      predecessorReceiptId: terminal.reservationId,
      predecessorReceiptSha256,
      continuityRegistryPath: registryPath,
      continuityRegistryGenesisSha256: await sha256(canonicalJson(forgedGenesis)),
      registryClaimId: 'origin-claim'
    }
  };
  await assert.rejects(
    verifyCampaignPolicyLineage(successor, { currentLedgerPath: path.join(directory, 'future', 'campaign.ndjson') }),
    /registry genesis does not bind the lineage origin/u
  );
});

test('registry integrity rejects duplicate claim IDs even outside the current parent tuple', async (t) => {
  const directory = await scratchDirectory(t, 'campaign-registry-duplicate-');
  const predecessorRoot = path.join(directory, 'predecessor');
  const lineageId = 'registry-duplicate-lineage';
  const predecessor = {
    campaignId: lineageId,
    implementationLockHash: 'a'.repeat(64),
    maxRequests: 2,
    maxSessions: 2,
    maxRecoveryAttempts: 0,
    deadline: '2099-01-01T00:00:00.000Z',
    limits: { outer_decision_llm: 0, internal_memory_llm: 0, embedding: 2 }
  };
  await createCampaignBudget(predecessorRoot, predecessor);
  const original = await openCampaignBudget(predecessorRoot, predecessor);
  await original.beginSession('duplicate-parent-session', { kind: 'probe', runId: 'duplicate-parent-run', attemptId: 'duplicate-parent-attempt' });
  await original.reserve({
    requestClass: 'embedding', runId: 'duplicate-parent-run', attemptId: 'duplicate-parent-attempt', armId: 'cognee',
    scenarioId: 'registry-duplicate', repetition: 0, phase: 'probe', rootOperation: 'persist',
    rootInvocationId: 'duplicate-parent-root', plannedDispatchId: 'a'.repeat(48), planSlot: 'duplicate:slot', disposition: 'root-initial'
  });
  await original.close();
  const predecessorLedgerPath = path.join(predecessorRoot, 'campaign.ndjson');
  const predecessorLedgerText = await readFile(predecessorLedgerPath, 'utf8');
  const terminal = predecessorLedgerText.trimEnd().split('\n').map(JSON.parse).at(-1);
  const sha256 = async (value) => (await import('node:crypto')).createHash('sha256').update(value, 'utf8').digest('hex');
  const predecessorLedgerSha256 = await sha256(predecessorLedgerText);
  const predecessorReceiptSha256 = await sha256(canonicalJson(terminal));
  const registryPath = path.join(directory, 'registry.ndjson');
  const genesis = {
    event: 'genesis', campaignLineageId: lineageId, predecessorLedgerSha256,
    predecessorReceiptId: terminal.reservationId, predecessorReceiptSha256
  };
  const duplicateClaim = (suffix, hash) => ({
    event: 'claim', claimId: 'duplicate-claim', campaignLineageId: lineageId,
    predecessorLedgerSha256: hash, predecessorReceiptId: `${lineageId}:1`, predecessorReceiptSha256: hash,
    successorCampaignId: `duplicate-successor-${suffix}`, successorImplementationLockHash: hash,
    successorPolicySha256: hash, campaignRoot: path.join(directory, `duplicate-root-${suffix}`)
  });
  await writeFile(registryPath, `${JSON.stringify(genesis)}\n${JSON.stringify(duplicateClaim('one', 'b'.repeat(64)))}\n${JSON.stringify(duplicateClaim('two', 'c'.repeat(64)))}\n`);
  const successor = {
    ...predecessor,
    campaignId: 'duplicate-wanted-successor', implementationLockHash: 'd'.repeat(64), campaignLineageId: lineageId,
    continuation: {
      predecessorLedgerPath, predecessorLedgerSha256, predecessorReceiptId: terminal.reservationId, predecessorReceiptSha256,
      continuityRegistryPath: registryPath, continuityRegistryGenesisSha256: await sha256(canonicalJson(genesis)), registryClaimId: 'wanted-claim'
    }
  };
  await assert.rejects(
    verifyCampaignPolicyLineage(successor, { currentLedgerPath: path.join(directory, 'future', 'campaign.ndjson') }),
    /duplicate claim ID/u
  );
});

test('a successor chain cannot begin because each continuation policy is unsupported', async (t) => {
  const directory = await scratchDirectory(t, 'campaign-successor-chain-refusal-');
  const policyFor = (campaignId, claimId) => ({
    ...policy,
    campaignId,
    implementationLockHash: 'b'.repeat(64),
    campaignLineageId: policy.campaignId,
    continuation: {
      predecessorLedgerPath: path.join(directory, 'predecessor', 'campaign.ndjson'),
      predecessorLedgerSha256: 'a'.repeat(64),
      predecessorReceiptId: `${policy.campaignId}:1`,
      predecessorReceiptSha256: 'b'.repeat(64),
      continuityRegistryPath: path.join(directory, 'registry.ndjson'),
      continuityRegistryGenesisSha256: 'c'.repeat(64),
      registryClaimId: claimId
    }
  });
  for (const [root, successor] of [
    [path.join(directory, 'first'), policyFor('chain-successor-1', 'chain-claim-1')],
    [path.join(directory, 'second'), policyFor('chain-successor-2', 'chain-claim-2')]
  ]) {
    await assert.rejects(createCampaignBudget(root, successor), /Campaign continuation is unsupported in restricted execution mode/u);
    await assert.rejects(openCampaignBudget(root, successor), /Campaign continuation is unsupported in restricted execution mode/u);
    await assert.rejects(import('node:fs/promises').then(({ lstat }) => lstat(root)), { code: 'ENOENT' });
  }
});

test('a continuation is refused before tampered ancestry or relaxed ceilings can create roots', async (t) => {
  const directory = await scratchDirectory(t, 'campaign-successor-tamper-');
  const predecessorRoot = path.join(directory, 'predecessor');
  const lineageId = 'tamper-lineage';
  const predecessor = {
    campaignId: lineageId,
    implementationLockHash: 'a'.repeat(64),
    maxRequests: 2,
    maxSessions: 2,
    maxRecoveryAttempts: 0,
    deadline: '2099-01-01T00:00:00.000Z',
    limits: { outer_decision_llm: 0, internal_memory_llm: 0, embedding: 2 }
  };
  await createCampaignBudget(predecessorRoot, predecessor);
  const predecessorCampaign = await openCampaignBudget(predecessorRoot, predecessor);
  await predecessorCampaign.beginSession('tamper-predecessor-session', {
    kind: 'probe', runId: 'tamper-predecessor-run', attemptId: 'tamper-predecessor-attempt'
  });
  await predecessorCampaign.reserve({
    requestClass: 'embedding', runId: 'tamper-predecessor-run', attemptId: 'tamper-predecessor-attempt', armId: 'cognee',
    scenarioId: 'tamper-continuity', repetition: 0, phase: 'probe', rootOperation: 'persist',
    rootInvocationId: 'tamper-predecessor-root', plannedDispatchId: 'a'.repeat(48), planSlot: 'tamper:slot', disposition: 'root-initial'
  });
  await predecessorCampaign.close();
  const predecessorLedgerPath = path.join(predecessorRoot, 'campaign.ndjson');
  const predecessorLedger = await readFile(predecessorLedgerPath, 'utf8');
  const predecessorRows = predecessorLedger.trimEnd().split('\n').map(JSON.parse);
  const terminalReceipt = predecessorRows.at(-1);
  const sha256 = async (value) => (await import('node:crypto')).createHash('sha256').update(value, 'utf8').digest('hex');
  const predecessorLedgerSha256 = await sha256(predecessorLedger);
  const predecessorReceiptSha256 = await sha256(canonicalJson(terminalReceipt));
  const registryPath = path.join(directory, 'continuity-registry.ndjson');
  const genesis = {
    event: 'genesis',
    campaignLineageId: lineageId,
    predecessorLedgerSha256,
    predecessorReceiptId: terminalReceipt.reservationId,
    predecessorReceiptSha256
  };
  await writeFile(registryPath, `${JSON.stringify(genesis)}\n`);
  const successor = {
    ...predecessor,
    campaignId: 'tamper-successor',
    campaignLineageId: lineageId,
    implementationLockHash: 'b'.repeat(64),
    continuation: {
      predecessorLedgerPath,
      predecessorLedgerSha256,
      predecessorReceiptId: terminalReceipt.reservationId,
      predecessorReceiptSha256,
      continuityRegistryPath: registryPath,
      continuityRegistryGenesisSha256: await sha256(canonicalJson(genesis)),
      registryClaimId: 'tamper-successor-claim'
    }
  };
  const exists = async (candidate) => import('node:fs/promises').then(({ lstat }) => lstat(candidate).then(() => true, () => false));
  const hashMismatchRoot = path.join(directory, 'hash-mismatch');
  await assert.rejects(
    createCampaignBudget(hashMismatchRoot, {
      ...successor,
      continuation: { ...successor.continuation, predecessorLedgerSha256: '0'.repeat(64) }
    }),
    /Campaign continuation is unsupported in restricted execution mode/u
  );
  assert.equal(await exists(hashMismatchRoot), false);

  const relaxedRoot = path.join(directory, 'relaxed');
  await assert.rejects(
    createCampaignBudget(relaxedRoot, { ...successor, maxRequests: 3 }),
    /Campaign continuation is unsupported in restricted execution mode/u
  );
  assert.equal(await exists(relaxedRoot), false);
});

test('a native-proof continuity gate cannot accept a legacy genesis policy', async () => {
  await assert.rejects(
    verifyCampaignPolicyLineage(policy, { requireContinuation: true }),
    /continuation evidence is required/u
  );
});

test('campaign reopen rejects a receipt record without dispatch lineage', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-tampered-lineage-'), 'campaign');
  await createCampaignBudget(root, policy);
  const ledgerPath = path.join(root, 'campaign.ndjson');
  await writeFile(ledgerPath, [
    { event: 'policy', policy },
    {
      event: 'session', id: 'probe-tampered-1', recovery: false,
      kind: 'probe', runId: 'probe-run-1', attemptId: 'probe-attempt-1'
    },
    {
      event: 'reservation', reservationId: 'offline-only:1', session: 'probe-tampered-1',
      requestClass: 'embedding'
    }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');

  await assert.rejects(openCampaignBudget(root, policy), /Invalid campaign journal/);
});

test('campaign reopen rejects a legacy reservation inside a prospective session', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-mixed-lineage-'), 'campaign');
  await createCampaignBudget(root, policy);
  await writeFile(path.join(root, 'campaign.ndjson'), [
    { event: 'policy', policy },
    {
      event: 'session', id: 'probe-mixed-1', recovery: false,
      kind: 'probe', runId: 'probe-run-1', attemptId: 'probe-attempt-1'
    },
    { event: 'reservation', session: 'probe-mixed-1', requestClass: 'embedding' }
  ].map((row) => JSON.stringify(row)).join('\n') + '\n');

  await assert.rejects(openCampaignBudget(root, policy), /Invalid campaign journal/);
});

test('campaign identity cannot be recreated or limits raised on reopen', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-identity-'), 'campaign');
  await createCampaignBudget(root, policy);
  await assert.rejects(createCampaignBudget(root, policy));
  await assert.rejects(openCampaignBudget(root, { ...policy, maxRequests: 100 }), /policy/);
});

test('campaign policy refuses a different official implementation identity before opening its ledger', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-lock-'), 'campaign');
  await createCampaignBudget(root, policy);
  await assert.rejects(openCampaignBudget(root, policy, { implementationLockHash: 'b'.repeat(64) }), /implementation lock/i);
});

test('meter denies dispatch when a shared campaign reservation is exhausted', async (t) => {
  const dir = await scratchDirectory(t, 'campaign-meter-');
  let received = 0;
  const server = createServer(async (req, res) => {
    for await (const chunk of req) { void chunk; }
    received += 1; res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture', usage: { total_tokens: 1 } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const meter = await startProviderMeter({ listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: `http://127.0.0.1:${server.address().port}/v1`, upstreamAuthorization: null,
    ledgerPath: path.join(dir, 'provider.ndjson'), upstreamTimeoutMs: 1000 }, {
    campaignReserve: async () => false
  });
  t.after(() => meter.close());
  const endpoint = meter.bindEndpoint({ runId: 'fixture', attemptId: 'fixture-1', armId: 'no-memory',
    scenarioId: 'fixture', repetition: 0, phase: 'A', requestClass: 'outer_decision_llm' });
  const response = await fetch(`${endpoint}/chat/completions`, { method: 'POST', body: '{"model":"fixture"}' });
  await response.text();
  assert.equal(response.status, 403);
  assert.equal(received, 0);
});

test('recovery authorization is exhausted durably without refunding prior reservations', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-recovery-'), 'campaign');
  const bounded = { ...policy, maxSessions: 4 };
  await createCampaignBudget(root, bounded);
  const first = await openCampaignBudget(root, bounded);
  await first.beginSession('initial');
  assert.equal(await first.reserve('embedding'), true);
  await first.beginSession('recovery-1', { recovery: true });
  await first.close();
  const next = await openCampaignBudget(root, bounded);
  try {
    await assert.rejects(next.beginSession('recovery-2', { recovery: true }), /recovery/i);
    await next.beginSession('separate-probe');
    assert.equal(await next.reserve('embedding'), false);
  } finally { await next.close(); }
});

test('CLI refuses incomplete campaign configuration before creating run resources', async (t) => {
  const dir = await scratchDirectory(t, 'campaign-cli-');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../benchmark/cli.mjs', import.meta.url));
  for (const command of ['v11-preflight', 'v11-run']) {
    let result;
    try {
      result = await promisify(execFile)(process.execPath, [cli, command,
        '--campaign-root', path.join(dir, 'campaign'), '--out', path.join(dir, 'out')]);
    } catch (error) { result = error; }
    assert.equal(result.code, 1);
    assert.match(result.stderr, /campaign-policy.*campaign-root|campaign-root.*campaign-policy/);
  }
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(dir), []);
});

test('CLI reports a missing campaign policy and root as a v11 run blocker', async (t) => {
  const dir = await scratchDirectory(t, 'campaign-cli-required-');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../benchmark/cli.mjs', import.meta.url));
  let result;
  try {
    result = await promisify(execFile)(process.execPath, [cli, 'v11-run', '--out', path.join(dir, 'out')]);
  } catch (error) { result = error; }
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.readiness.blockers.some((blocker) => (
    blocker.kind === 'campaign' && blocker.code === 'CAMPAIGN_CONFIGURATION_REQUIRED'
  )));
  const { readdir } = await import('node:fs/promises');
  assert.deepEqual(await readdir(dir), []);
});

test('CLI rejects a complete but invalid campaign policy rather than ignoring it', async (t) => {
  const dir = await scratchDirectory(t, 'campaign-cli-invalid-');
  const policyPath = path.join(dir, 'policy.json');
  await writeFile(policyPath, '{}\n');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../benchmark/cli.mjs', import.meta.url));
  for (const command of ['v11-preflight', 'v11-run']) {
    let result;
    try {
      result = await promisify(execFile)(process.execPath, [cli, command,
        '--campaign-policy', policyPath, '--campaign-root', path.join(dir, 'campaign')]);
    } catch (error) { result = error; }
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Invalid campaign policy/);
  }
});

test('CLI rejects an unreadable campaign continuation before emitting preflight readiness', async (t) => {
  const dir = await scratchDirectory(t, 'campaign-cli-continuation-');
  const policyPath = path.join(dir, 'policy.json');
  const predecessorLedgerPath = path.join(dir, 'missing-predecessor.ndjson');
  const continuationPolicy = {
    campaignId: 'successor-policy',
    campaignLineageId: 'stable-lineage',
    implementationLockHash: 'a'.repeat(64),
    maxRequests: 2,
    maxSessions: 2,
    maxRecoveryAttempts: 0,
    deadline: '2099-01-01T00:00:00.000Z',
    limits: { outer_decision_llm: 0, internal_memory_llm: 0, embedding: 2 },
    continuation: {
      predecessorLedgerPath,
      predecessorLedgerSha256: 'a'.repeat(64),
      predecessorReceiptId: 'stable-lineage:1',
      predecessorReceiptSha256: 'b'.repeat(64),
      continuityRegistryPath: path.join(dir, 'missing-registry.ndjson'),
      continuityRegistryGenesisSha256: 'c'.repeat(64),
      registryClaimId: 'cli-continuation-claim'
    }
  };
  await writeFile(policyPath, `${JSON.stringify(continuationPolicy)}\n`);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('../benchmark/cli.mjs', import.meta.url));
  let result;
  try {
    result = await promisify(execFile)(process.execPath, [cli, 'v11-preflight',
      '--campaign-policy', policyPath, '--campaign-root', path.join(dir, 'future-campaign')]);
  } catch (error) { result = error; }
  assert.equal(result.code, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Campaign continuation is unsupported in restricted execution mode/u);
  assert.equal(await import('node:fs/promises').then(({ lstat }) => lstat(path.join(dir, 'future-campaign')).then(() => true, () => false)), false);
});

test('campaign dates reject normalized impossible instants before creating evidence', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-calendar-'), 'campaign');
  await assert.rejects(createCampaignBudget(root, { ...policy, deadline: '2099-02-30T00:00:00.000Z' }), /Invalid campaign policy/);
});

test('expired campaign refuses reservations before dispatch', async (t) => {
  const root = path.join(await scratchDirectory(t, 'campaign-expiry-'), 'campaign');
  const expired = { ...policy, deadline: '2000-01-01T00:00:00.000Z' };
  await createCampaignBudget(root, expired);
  const ledger = await openCampaignBudget(root, expired);
  await assert.rejects(ledger.beginSession('run'), /expired/);
  assert.equal(await ledger.reserve('embedding'), false);
  await ledger.close();
});
