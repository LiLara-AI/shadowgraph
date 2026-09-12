// One persistent campaign spans probes and separately identified fresh runs.
// A crashed owner leaves its lock in place: recovery requires explicit inspection,
// never automatic lock stealing or resetting consumed reservations.
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, REQUEST_CLASSES } from './v11-contract.mjs';

const SESSION_KINDS = new Set(['probe', 'acceptance', 'scored']);
const ROOT_OPERATIONS = new Set(['reset', 'retrieve', 'persist', 'verify', 'outer-decision']);
const PLAN_DISPOSITIONS = new Set(['root-initial', 'data-dependent-child', 'recovery']);
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const CAMPAIGN_ID = /^[A-Za-z0-9-]+$/;
const SHA256 = /^[a-f0-9]{64}$/u;
const OPAQUE_DISPATCH_ID = /^[a-f0-9]{48}$/;
const CAMPAIGN_RESERVATION_ID = /^[A-Za-z0-9-]+:[1-9]\d*$/u;
const CORE_POLICY_FIELDS = Object.freeze([
  'campaignId', 'deadline', 'limits', 'maxRequests', 'maxSessions', 'maxRecoveryAttempts', 'implementationLockHash'
]);
const FINAL_POLICY_FIELDS = Object.freeze([
  ...CORE_POLICY_FIELDS, 'sessionLimits', 'campaignRegistryPath', 'continuityRegistryPath'
]);
const SUCCESSOR_POLICY_FIELDS = Object.freeze([
  ...CORE_POLICY_FIELDS, 'campaignLineageId', 'continuation'
]);
const FINAL_SUCCESSOR_POLICY_FIELDS = Object.freeze([
  ...SUCCESSOR_POLICY_FIELDS, 'sessionLimits'
]);
const CONTINUATION_FIELDS = Object.freeze([
  'predecessorLedgerPath', 'predecessorLedgerSha256',
  'predecessorReceiptId', 'predecessorReceiptSha256',
  'continuityRegistryPath', 'continuityRegistryGenesisSha256', 'registryClaimId'
]);
const REGISTRY_GENESIS_FIELDS = Object.freeze([
  'event', 'campaignLineageId', 'predecessorLedgerSha256', 'predecessorReceiptId', 'predecessorReceiptSha256'
]);
const REGISTRY_CLAIM_FIELDS = Object.freeze([
  'event', 'claimId', 'campaignLineageId', 'predecessorLedgerSha256', 'predecessorReceiptId',
  'predecessorReceiptSha256', 'successorCampaignId', 'successorImplementationLockHash',
  'successorPolicySha256', 'campaignRoot'
]);

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function sessionMetadata(options) {
  const { kind, runId, attemptId } = options;
  const present = [kind, runId, attemptId].filter((value) => value !== undefined).length;
  if (present === 0) return null;
  if (present !== 3 || !SESSION_KINDS.has(kind)
    || !isNonEmptyString(runId) || !SAFE_ID.test(runId)
    || !isNonEmptyString(attemptId) || !SAFE_ID.test(attemptId)) {
    throw new Error('Campaign session context refused');
  }
  return Object.freeze({ kind, runId, attemptId });
}

function dispatchReservation(value, session = null) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Campaign dispatch reservation is invalid');
  }
  const fields = [
    'requestClass', 'runId', 'attemptId', 'armId', 'scenarioId', 'repetition', 'phase',
    'rootOperation', 'rootInvocationId', 'plannedDispatchId', 'planSlot', 'disposition'
  ];
  if (Object.keys(value).sort().join() !== fields.slice().sort().join()
    || !REQUEST_CLASSES.includes(value.requestClass)
    || !isNonEmptyString(value.runId) || !SAFE_ID.test(value.runId)
    || !isNonEmptyString(value.attemptId) || !SAFE_ID.test(value.attemptId)
    || !isNonEmptyString(value.armId) || !SAFE_ID.test(value.armId)
    || !isNonEmptyString(value.scenarioId) || !SAFE_ID.test(value.scenarioId)
    || !Number.isSafeInteger(value.repetition) || value.repetition < 0
    || !isNonEmptyString(value.phase) || !SAFE_ID.test(value.phase)
    || !ROOT_OPERATIONS.has(value.rootOperation)
    || !isNonEmptyString(value.rootInvocationId) || !SAFE_ID.test(value.rootInvocationId)
    || !OPAQUE_DISPATCH_ID.test(value.plannedDispatchId)
    || !isNonEmptyString(value.planSlot) || !SAFE_ID.test(value.planSlot)
    || !PLAN_DISPOSITIONS.has(value.disposition)
    || (session !== null && (value.runId !== session.runId || value.attemptId !== session.attemptId))) {
    throw new Error('Campaign dispatch reservation is invalid');
  }
  return JSON.parse(canonicalJson(value));
}

function isPlainRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, fields) {
  return isPlainRecord(value)
    && Object.keys(value).length === fields.length
    && fields.every((field) => Object.hasOwn(value, field));
}

function safeAbsolutePath(value) {
  return isNonEmptyString(value)
    && value === value.trim()
    && path.isAbsolute(value)
    && !/[\u0000-\u001F\u007F]/u.test(value);
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function campaignGenesisClaim(policy, root) {
  return {
    event: 'campaign-genesis-claim',
    campaignId: policy.campaignId,
    policySha256: sha256Text(canonicalJson(policy)),
    campaignRoot: path.resolve(root),
    continuityRegistryPath: policy.continuityRegistryPath
  };
}

async function claimCampaignGenesis(policy, root) {
  if (!Object.hasOwn(policy, 'campaignRegistryPath')) return;
  const expected = campaignGenesisClaim(policy, root);
  let file;
  try {
    file = await open(policy.campaignRegistryPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    let existing;
    try { existing = JSON.parse(await readFile(policy.campaignRegistryPath, 'utf8')); }
    catch { throw new Error('Campaign genesis claim is unreadable'); }
    if (canonicalJson(existing) !== canonicalJson(expected)) {
      throw new Error('Campaign id is already claimed by another physical root');
    }
    return;
  }
  try {
    await file.writeFile(`${JSON.stringify(expected)}\n`);
    await file.sync();
  } finally { await file.close(); }
}

async function verifyCampaignGenesis(policy, root) {
  if (!Object.hasOwn(policy, 'campaignRegistryPath')) return;
  let existing;
  try { existing = JSON.parse(await readFile(policy.campaignRegistryPath, 'utf8')); }
  catch { throw new Error('Campaign genesis claim is unreadable'); }
  if (canonicalJson(existing) !== canonicalJson(campaignGenesisClaim(policy, root))) {
    throw new Error('Campaign genesis claim is absent or mismatched');
  }
}

/** The stable receipt namespace; legacy genesis policies use campaignId. */
function campaignLineageId(policy) {
  return policy.campaignLineageId ?? policy.campaignId;
}

export function validateCampaignPolicy(policy) {
  const fields = isPlainRecord(policy) ? Object.keys(policy).sort().join() : '';
  const legacy = fields === [...CORE_POLICY_FIELDS].sort().join();
  const successor = fields === [...SUCCESSOR_POLICY_FIELDS].sort().join();
  const finalGenesis = fields === [...FINAL_POLICY_FIELDS].sort().join();
  const finalSuccessor = fields === [...FINAL_SUCCESSOR_POLICY_FIELDS].sort().join();
  const finalPolicy = finalGenesis || finalSuccessor;
  const invalidSuccessor = (successor || finalSuccessor) && (
    !CAMPAIGN_ID.test(policy.campaignLineageId)
    || !exactKeys(policy.continuation, CONTINUATION_FIELDS)
    || !safeAbsolutePath(policy.continuation.predecessorLedgerPath)
    || !SHA256.test(policy.continuation.predecessorLedgerSha256)
    || !CAMPAIGN_RESERVATION_ID.test(policy.continuation.predecessorReceiptId)
    || !SHA256.test(policy.continuation.predecessorReceiptSha256)
    || !safeAbsolutePath(policy.continuation.continuityRegistryPath)
    || !SHA256.test(policy.continuation.continuityRegistryGenesisSha256)
    || !SAFE_ID.test(policy.continuation.registryClaimId)
  );
  if ((!legacy && !successor && !finalPolicy)
    || typeof policy?.implementationLockHash !== 'string' || !SHA256.test(policy.implementationLockHash)
    || typeof policy.campaignId !== 'string' || !CAMPAIGN_ID.test(policy.campaignId)
    || !Number.isSafeInteger(policy.maxRequests) || policy.maxRequests < 1
    || !Number.isSafeInteger(policy.maxSessions) || policy.maxSessions < 1
    || !Number.isSafeInteger(policy.maxRecoveryAttempts) || policy.maxRecoveryAttempts < 0
    || typeof policy.deadline !== 'string' || !Number.isFinite(Date.parse(policy.deadline))
    || new Date(policy.deadline).toISOString() !== policy.deadline
    || !isPlainRecord(policy.limits) || Object.keys(policy.limits).sort().join() !== [...REQUEST_CLASSES].sort().join()
    || REQUEST_CLASSES.some((key) => !Number.isSafeInteger(policy.limits[key]) || policy.limits[key] < 0)
    || (finalPolicy && (
      !exactKeys(policy.sessionLimits, [...SESSION_KINDS])
      || [...SESSION_KINDS].some((kind) => !Number.isSafeInteger(policy.sessionLimits[kind]) || policy.sessionLimits[kind] < 0)
      || [...SESSION_KINDS].reduce((sum, kind) => sum + policy.sessionLimits[kind], 0) !== policy.maxSessions
    ))
    || (finalGenesis && (
      !safeAbsolutePath(policy.campaignRegistryPath)
      || !safeAbsolutePath(policy.continuityRegistryPath)
      || policy.campaignRegistryPath === policy.continuityRegistryPath
    ))
    || invalidSuccessor) {
    throw new Error('Invalid campaign policy');
  }
  return JSON.parse(canonicalJson(policy));
}

export function assertRestrictedCampaignExecutionPolicy(policy) {
  const validated = validateCampaignPolicy(policy);
  if (Object.hasOwn(validated, 'continuation') && !Object.hasOwn(validated, 'sessionLimits')) {
    throw new Error('Campaign continuation is unsupported in restricted execution mode');
  }
  return validated;
}

function emptyCampaignState(lineageId) {
  return {
    lineageId,
    counts: Object.fromEntries(REQUEST_CLASSES.map((key) => [key, 0])),
    sessions: new Map(),
    reservationIds: new Set(),
    total: 0,
    recoveries: 0,
    receiptBearing: true,
    terminalReceipt: null,
    lineageOrigin: null
  };
}

function cloneCampaignState(state) {
  return {
    lineageId: state.lineageId,
    counts: { ...state.counts },
    sessions: new Map(state.sessions),
    reservationIds: new Set(state.reservationIds),
    total: state.total,
    recoveries: state.recoveries,
    receiptBearing: state.receiptBearing,
    terminalReceipt: state.terminalReceipt === null ? null : { ...state.terminalReceipt },
    lineageOrigin: state.lineageOrigin === null ? null : { ...state.lineageOrigin }
  };
}

function assertCampaignStateWithinPolicy(state, policy) {
  if (state.total > policy.maxRequests || state.sessions.size > policy.maxSessions
    || state.recoveries > policy.maxRecoveryAttempts
    || REQUEST_CLASSES.some((key) => state.counts[key] > policy.limits[key])) {
    throw new Error('Campaign evidence exceeds policy');
  }
  if (Object.hasOwn(policy, 'sessionLimits')) {
    const counts = Object.fromEntries([...SESSION_KINDS].map((kind) => [kind, 0]));
    for (const metadata of state.sessions.values()) {
      if (metadata === null) throw new Error('Final campaign session metadata is missing');
      counts[metadata.kind] += 1;
    }
    if ([...SESSION_KINDS].some((kind) => counts[kind] > policy.sessionLimits[kind])) {
      throw new Error('Campaign evidence exceeds session-kind ceiling');
    }
  }
}

function assertContinuationDoesNotRelax(successor, predecessor) {
  if (successor.maxRequests > predecessor.maxRequests
    || successor.maxSessions > predecessor.maxSessions
    || successor.maxRecoveryAttempts > predecessor.maxRecoveryAttempts
    || Date.parse(successor.deadline) > Date.parse(predecessor.deadline)
    || REQUEST_CLASSES.some((key) => successor.limits[key] > predecessor.limits[key])) {
    throw new Error('Campaign continuation relaxes predecessor ceilings');
  }
  if (Object.hasOwn(successor, 'sessionLimits') !== Object.hasOwn(predecessor, 'sessionLimits')
    || (Object.hasOwn(successor, 'sessionLimits')
      && [...SESSION_KINDS].some((kind) => successor.sessionLimits[kind] > predecessor.sessionLimits[kind]))) {
    throw new Error('Campaign continuation relaxes predecessor session-kind ceilings');
  }
  if (Object.hasOwn(successor, 'sessionLimits')
    && successor.continuation.continuityRegistryPath !== predecessor.continuityRegistryPath) {
    throw new Error('Campaign continuation does not use the predecessor-anchored registry');
  }
}

function campaignRows(text) {
  if (typeof text !== 'string' || !text.endsWith('\n')) throw new Error('Truncated campaign evidence');
  try {
    const rows = text.trimEnd().split('\n').map(JSON.parse);
    if (rows.length === 0) throw new Error('empty');
    return rows;
  } catch {
    throw new Error('Invalid campaign journal');
  }
}

function inheritedSnapshot(state) {
  const sessionCounts = Object.fromEntries([...SESSION_KINDS].map((kind) => [kind, 0]));
  for (const metadata of state.sessions.values()) {
    if (metadata !== null) sessionCounts[metadata.kind] += 1;
  }
  return {
    total: state.total,
    recoveries: state.recoveries,
    sessions: state.sessions.size,
    sessionCounts,
    counts: { ...state.counts }
  };
}

function continuationRecord(policy, inherited) {
  const continuation = policy.continuation;
  return {
    event: 'continuation',
    campaignLineageId: campaignLineageId(policy),
    predecessorLedgerSha256: continuation.predecessorLedgerSha256,
    predecessorReceiptId: continuation.predecessorReceiptId,
    predecessorReceiptSha256: continuation.predecessorReceiptSha256,
    continuityRegistryGenesisSha256: continuation.continuityRegistryGenesisSha256,
    registryClaimId: continuation.registryClaimId,
    inherited: inheritedSnapshot(inherited)
  };
}

function registryRows(text, policy) {
  if (typeof text !== 'string' || !text.endsWith('\n')) throw new Error('Campaign continuity registry is truncated');
  let rows;
  try { rows = text.trimEnd().split('\n').map(JSON.parse); }
  catch { throw new Error('Campaign continuity registry is invalid'); }
  const genesis = rows[0];
  if (!exactKeys(genesis, REGISTRY_GENESIS_FIELDS)
    || genesis.event !== 'genesis'
    || genesis.campaignLineageId !== campaignLineageId(policy)
    || !SHA256.test(genesis.predecessorLedgerSha256)
    || !CAMPAIGN_RESERVATION_ID.test(genesis.predecessorReceiptId)
    || !SHA256.test(genesis.predecessorReceiptSha256)
    || sha256Text(canonicalJson(genesis)) !== policy.continuation.continuityRegistryGenesisSha256) {
    throw new Error('Campaign continuity registry genesis is invalid');
  }
  const claimIds = new Set();
  const claimedPredecessors = new Set();
  for (const row of rows.slice(1)) {
    if (!exactKeys(row, REGISTRY_CLAIM_FIELDS)
      || row.event !== 'claim'
      || !SAFE_ID.test(row.claimId)
      || row.campaignLineageId !== genesis.campaignLineageId
      || !SHA256.test(row.predecessorLedgerSha256)
      || !CAMPAIGN_RESERVATION_ID.test(row.predecessorReceiptId)
      || !SHA256.test(row.predecessorReceiptSha256)
      || !CAMPAIGN_ID.test(row.successorCampaignId)
      || !SHA256.test(row.successorImplementationLockHash)
      || !SHA256.test(row.successorPolicySha256)
      || !safeAbsolutePath(row.campaignRoot)) {
      throw new Error('Campaign continuity registry claim is invalid');
    }
    if (claimIds.has(row.claimId)) throw new Error('Campaign continuity registry contains duplicate claim ID');
    claimIds.add(row.claimId);
    const predecessorKey = `${row.predecessorLedgerSha256}:${row.predecessorReceiptId}:${row.predecessorReceiptSha256}`;
    if (claimedPredecessors.has(predecessorKey)) throw new Error('Campaign continuity registry contains duplicate predecessor receipt');
    claimedPredecessors.add(predecessorKey);
  }
  return rows;
}

async function readContinuationRegistry(policy, { readFileImpl = readFile } = {}) {
  let text;
  try {
    text = await readFileImpl(policy.continuation.continuityRegistryPath, 'utf8');
  } catch {
    throw new Error('Campaign continuity registry is unreadable');
  }
  return registryRows(text, policy);
}

function continuationClaim(policy, campaignRoot) {
  const continuation = policy.continuation;
  return {
    event: 'claim',
    claimId: continuation.registryClaimId,
    campaignLineageId: campaignLineageId(policy),
    predecessorLedgerSha256: continuation.predecessorLedgerSha256,
    predecessorReceiptId: continuation.predecessorReceiptId,
    predecessorReceiptSha256: continuation.predecessorReceiptSha256,
    successorCampaignId: policy.campaignId,
    successorImplementationLockHash: policy.implementationLockHash,
    successorPolicySha256: sha256Text(canonicalJson(policy)),
    campaignRoot: path.resolve(campaignRoot)
  };
}

function sameRecord(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

function assertClaimAvailable(policy, campaignRoot, rows) {
  const expected = continuationClaim(policy, campaignRoot);
  const claims = rows.slice(1);
  const sameParent = claims.filter((row) => (
    row.predecessorLedgerSha256 === expected.predecessorLedgerSha256
      && row.predecessorReceiptId === expected.predecessorReceiptId
      && row.predecessorReceiptSha256 === expected.predecessorReceiptSha256
  ));
  if (sameParent.length > 0 && (sameParent.length !== 1 || !sameRecord(sameParent[0], expected))) {
    throw new Error('Campaign continuation predecessor receipt is already claimed');
  }
  if (claims.some((row) => row.claimId === expected.claimId && !sameRecord(row, expected))) {
    throw new Error('Campaign continuation claim ID is already used');
  }
  return expected;
}

function replayCampaignLedger({ text, policy, inherited }) {
  const rows = campaignRows(text);
  if (rows[0]?.event !== 'policy' || canonicalJson(rows[0].policy) !== canonicalJson(policy)) {
    throw new Error('Campaign policy mismatch');
  }
  const state = cloneCampaignState(inherited);
  let firstEvent = 1;
  if (Object.hasOwn(policy, 'continuation')) {
    if (!sameRecord(rows[1], continuationRecord(policy, inherited))) {
      throw new Error('Campaign continuation record is invalid');
    }
    firstEvent = 2;
  }
  const requiresReceipts = Object.hasOwn(policy, 'continuation') || state.total > 0;
  for (const row of rows.slice(firstEvent)) {
    try {
      if (row.event === 'session') {
        const metadata = sessionMetadata(row);
        const expectedFields = metadata === null
          ? ['event', 'id', 'recovery']
          : ['event', 'id', 'recovery', 'kind', 'runId', 'attemptId'];
        if ((Object.hasOwn(policy, 'sessionLimits') && metadata === null)
          || !isNonEmptyString(row.id) || !SAFE_ID.test(row.id) || state.sessions.has(row.id)
          || typeof row.recovery !== 'boolean'
          || Object.keys(row).sort().join() !== expectedFields.sort().join()) {
          throw new Error('invalid session');
        }
        state.sessions.set(row.id, metadata === null ? null : Object.freeze({ ...metadata, campaignId: policy.campaignId }));
        if (row.recovery) state.recoveries += 1;
        continue;
      }
      if (row.event !== 'reservation' || !state.sessions.has(row.session)
        || !REQUEST_CLASSES.includes(row.requestClass)) {
        throw new Error('invalid reservation');
      }
      if (Object.hasOwn(row, 'reservationId')) {
        const metadata = state.sessions.get(row.session);
        if (metadata === null || !CAMPAIGN_RESERVATION_ID.test(row.reservationId)
          || row.reservationId !== `${state.lineageId}:${state.total + 1}`
          || state.reservationIds.has(row.reservationId)) {
          throw new Error('invalid reservation receipt');
        }
        const dispatch = Object.fromEntries(Object.entries(row).filter(([key]) => ![
          'event', 'reservationId', 'session'
        ].includes(key)));
        dispatchReservation(dispatch, metadata);
        state.reservationIds.add(row.reservationId);
        state.terminalReceipt = {
          id: row.reservationId,
          sha256: sha256Text(canonicalJson(row))
        };
      } else if (requiresReceipts || state.sessions.get(row.session) !== null
        || Object.keys(row).sort().join() !== ['event', 'session', 'requestClass'].sort().join()) {
        throw new Error('invalid legacy reservation');
      } else {
        state.receiptBearing = false;
      }
      state.counts[row.requestClass] += 1;
      state.total += 1;
    } catch {
      throw new Error('Invalid campaign journal');
    }
  }
  if (state.lineageOrigin === null && state.terminalReceipt !== null) {
    state.lineageOrigin = {
      ledgerSha256: sha256Text(text),
      receiptId: state.terminalReceipt.id,
      receiptSha256: state.terminalReceipt.sha256
    };
  }
  assertCampaignStateWithinPolicy(state, policy);
  return state;
}

async function inheritedCampaignState(policy, { readFileImpl = readFile, seenLedgerPaths = new Set() } = {}) {
  if (!Object.hasOwn(policy, 'continuation')) return emptyCampaignState(campaignLineageId(policy));
  const lineageId = campaignLineageId(policy);
  const ledgerPath = path.resolve(policy.continuation.predecessorLedgerPath);
  if (seenLedgerPaths.has(ledgerPath)) throw new Error('Campaign continuation contains a cycle');
  seenLedgerPaths.add(ledgerPath);
  let text;
  try {
    text = await readFileImpl(ledgerPath, 'utf8');
  } catch {
    throw new Error('Campaign continuation ledger is unreadable');
  }
  if (sha256Text(text) !== policy.continuation.predecessorLedgerSha256) {
    throw new Error('Campaign continuation ledger hash mismatch');
  }
  const rows = campaignRows(text);
  let predecessor;
  try {
    predecessor = validateCampaignPolicy(rows[0]?.policy);
  } catch {
    throw new Error('Campaign continuation predecessor policy is invalid');
  }
  if (campaignLineageId(predecessor) !== lineageId || predecessor.campaignId === policy.campaignId) {
    throw new Error('Campaign continuation identity mismatch');
  }
  assertContinuationDoesNotRelax(policy, predecessor);
  const inherited = await inheritedCampaignState(predecessor, { readFileImpl, seenLedgerPaths });
  const state = replayCampaignLedger({ text, policy: predecessor, inherited });
  if (!state.receiptBearing || state.terminalReceipt === null
    || state.terminalReceipt.id !== policy.continuation.predecessorReceiptId
    || state.terminalReceipt.sha256 !== policy.continuation.predecessorReceiptSha256) {
    throw new Error('Campaign continuation predecessor receipt mismatch');
  }
  const registry = await readContinuationRegistry(policy, { readFileImpl });
  const genesis = registry[0];
  if (state.lineageOrigin === null
    || genesis.predecessorLedgerSha256 !== state.lineageOrigin.ledgerSha256
    || genesis.predecessorReceiptId !== state.lineageOrigin.receiptId
    || genesis.predecessorReceiptSha256 !== state.lineageOrigin.receiptSha256) {
    throw new Error('Campaign registry genesis does not bind the lineage origin');
  }
  return state;
}

/** Verify any successor ledger chain before an owner lock or output root exists. */
export async function verifyCampaignPolicyLineage(input, options = {}) {
  const policy = validateCampaignPolicy(input);
  const { requireContinuation = false, currentLedgerPath = null, readFileImpl = readFile } = options;
  if (requireContinuation && !Object.hasOwn(policy, 'continuation')) {
    throw new Error('Campaign continuation evidence is required');
  }
  const seenLedgerPaths = new Set();
  if (currentLedgerPath !== null) seenLedgerPaths.add(path.resolve(currentLedgerPath));
  const inherited = await inheritedCampaignState(policy, { readFileImpl, seenLedgerPaths });
  if (Object.hasOwn(policy, 'continuation') && currentLedgerPath !== null) {
    const registry = await readContinuationRegistry(policy, { readFileImpl });
    assertClaimAvailable(policy, path.dirname(path.resolve(currentLedgerPath)), registry);
  }
  return Object.freeze({
    policy,
    campaignLineageId: campaignLineageId(policy),
    predecessorLedgerPath: policy.continuation?.predecessorLedgerPath ?? null,
    continuityRegistryPath: policy.continuation?.continuityRegistryPath ?? null,
    inherited: Object.freeze({
      total: inherited.total,
      recoveries: inherited.recoveries,
      sessions: inherited.sessions.size,
      counts: Object.freeze({ ...inherited.counts })
    })
  });
}

/** Atomically bind one physical successor root to one predecessor receipt. */
export async function claimCampaignContinuation(input, campaignRoot) {
  assertRestrictedCampaignExecutionPolicy(input);
  const policy = validateCampaignPolicy(input);
  if (!Object.hasOwn(policy, 'continuation') || !safeAbsolutePath(campaignRoot)) {
    throw new Error('Campaign continuation claim is invalid');
  }
  await verifyCampaignPolicyLineage(policy, {
    requireContinuation: true,
    currentLedgerPath: path.join(campaignRoot, 'campaign.ndjson')
  });
  const expected = continuationClaim(policy, campaignRoot);
  const registryPath = policy.continuation.continuityRegistryPath;
  const lockPath = `${registryPath}.owner.lock`;
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error?.code === 'EEXIST') throw new Error('Campaign continuity registry is locked; inspect owner before recovery');
    throw error;
  }
  try {
    const rows = await readContinuationRegistry(policy);
    const claims = rows.slice(1);
    const sameParent = claims.filter((row) => (
      row.predecessorLedgerSha256 === expected.predecessorLedgerSha256
        && row.predecessorReceiptId === expected.predecessorReceiptId
        && row.predecessorReceiptSha256 === expected.predecessorReceiptSha256
    ));
    if (sameParent.length > 0) {
      if (sameParent.length === 1 && sameRecord(sameParent[0], expected)) return expected;
      throw new Error('Campaign continuation predecessor receipt is already claimed');
    }
    if (claims.some((row) => row.claimId === expected.claimId)) {
      throw new Error('Campaign continuation claim ID is already used');
    }
    const file = await open(registryPath, 'a', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(expected)}\n`);
      await file.sync();
    } finally { await file.close(); }
    return expected;
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}

export async function verifyCampaignContinuationClaim(input, campaignRoot) {
  const policy = validateCampaignPolicy(input);
  if (!Object.hasOwn(policy, 'continuation') || !safeAbsolutePath(campaignRoot)) {
    throw new Error('Campaign continuation claim is invalid');
  }
  const expected = continuationClaim(policy, campaignRoot);
  const claims = (await readContinuationRegistry(policy)).slice(1);
  const sameParent = claims.filter((row) => (
    row.predecessorLedgerSha256 === expected.predecessorLedgerSha256
      && row.predecessorReceiptId === expected.predecessorReceiptId
      && row.predecessorReceiptSha256 === expected.predecessorReceiptSha256
  ));
  if (sameParent.length !== 1 || !sameRecord(sameParent[0], expected)) {
    throw new Error('Campaign continuation claim is absent or mismatched');
  }
  return expected;
}
export async function createCampaignBudget(root, input) {
  assertRestrictedCampaignExecutionPolicy(input);
  const policy = validateCampaignPolicy(input);
  const ledgerPath = path.join(root, 'campaign.ndjson');
  await verifyCampaignPolicyLineage(policy, { currentLedgerPath: ledgerPath });
  const inherited = Object.hasOwn(policy, 'continuation')
    ? await inheritedCampaignState(policy, { seenLedgerPaths: new Set([path.resolve(ledgerPath)]) })
    : null;
  if (inherited !== null) await claimCampaignContinuation(policy, root);
  else await claimCampaignGenesis(policy, root);
  await mkdir(root, { recursive: false, mode: 0o700 }); // parent must already exist
  let file;
  try { file = await open(ledgerPath, 'wx', 0o600); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const existing = await readFile(ledgerPath, 'utf8');
    if (!existing.endsWith('\n')) throw new Error('Truncated campaign evidence');
    const first = JSON.parse(existing.split('\n', 1)[0]);
    if (first?.event !== 'policy' || canonicalJson(first.policy) !== canonicalJson(policy)) throw new Error('Campaign policy already exists');
    return;
  }
  try {
    await file.writeFile(`${JSON.stringify({ event: 'policy', policy })}\n`);
    if (inherited !== null) await file.writeFile(`${JSON.stringify(continuationRecord(policy, inherited))}\n`);
    await file.sync();
  } finally { await file.close(); }
}

export async function openCampaignBudget(root, input, expected = {}) {
  assertRestrictedCampaignExecutionPolicy(input);
  const policy = validateCampaignPolicy(input);
  const ledgerPath = path.join(root, 'campaign.ndjson');
  const inherited = await inheritedCampaignState(policy, {
    seenLedgerPaths: new Set([path.resolve(ledgerPath)])
  });
  if (Object.hasOwn(policy, 'continuation')) await verifyCampaignContinuationClaim(policy, root);
  else await verifyCampaignGenesis(policy, root);
  if (expected.implementationLockHash !== undefined && expected.implementationLockHash !== policy.implementationLockHash) {
    throw new Error('Campaign policy was issued for a different official implementation lock');
  }
  const lockPath = path.join(root, 'owner.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw new Error('Campaign locked; inspect owner before recovery');
    throw error;
  }
  let file;
  try {
    const text = await readFile(ledgerPath, 'utf8');
    const state = replayCampaignLedger({ text, policy, inherited });
    const { counts, sessions, reservationIds } = state;
    const lineageId = state.lineageId;
    let { total, recoveries } = state;
    file = await open(ledgerPath, 'a', 0o600);
    let tail = Promise.resolve();
    let failure = null;
    let closed = false;
    let currentSession = null;
    const enqueue = (action) => {
      const pending = tail.then(async () => {
        if (closed || failure) throw failure ?? new Error('Campaign closed');
        return action();
      });
      tail = pending.catch(() => {});
      return pending;
    };
    const append = async (record) => {
      try {
        await file.writeFile(`${JSON.stringify(record)}\n`);
        await file.sync();
      } catch (error) { failure = error; throw error; }
    };
    return {
      beginSession(id, { recovery = false, kind, runId, attemptId } = {}) {
        return enqueue(async () => {
          const metadata = sessionMetadata({ kind, runId, attemptId });
          if (Date.now() >= Date.parse(policy.deadline)) throw new Error('Campaign expired');
          if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(id) || sessions.has(id) || sessions.size >= policy.maxSessions) throw new Error('Campaign session refused');
          if (Object.hasOwn(policy, 'sessionLimits')) {
            if (metadata === null) throw new Error('Campaign session context refused');
            if (metadata.kind === 'acceptance'
              && [...sessions.values()].some((value) => value?.kind === 'acceptance'
                && value.campaignId === policy.campaignId)) {
              throw new Error('Campaign acceptance session already consumed for this candidate');
            }
            const usedForKind = [...sessions.values()].filter((value) => value?.kind === metadata.kind).length;
            if (usedForKind >= policy.sessionLimits[metadata.kind]) {
              throw new Error('Campaign session kind reached its ceiling');
            }
          }
          if (typeof recovery !== 'boolean' || (recovery && recoveries >= policy.maxRecoveryAttempts)) throw new Error('Campaign recovery refused');
          await append({ event: 'session', id, recovery, ...(metadata ?? {}) });
          if (recovery) recoveries += 1;
          const storedMetadata = metadata === null ? null : Object.freeze({ ...metadata, campaignId: policy.campaignId });
          sessions.set(id, storedMetadata); currentSession = Object.freeze({ id, metadata: storedMetadata });
        });
      },
      reserve(input) {
        return enqueue(async () => {
          const dispatch = typeof input === 'string'
            ? null
            : dispatchReservation(input, currentSession?.metadata ?? null);
          const requestClass = dispatch?.requestClass ?? input;
          if (!REQUEST_CLASSES.includes(requestClass)) throw new Error('Invalid campaign request class');
          if (!currentSession || Date.now() >= Date.parse(policy.deadline)
            || total >= policy.maxRequests || counts[requestClass] >= policy.limits[requestClass]) return false;
          if (dispatch !== null && currentSession.metadata === null) {
            throw new Error('Campaign session lacks dispatch context');
          }
          // Durable reservation precedes permission to dispatch. No refunds:
          // failure, in-flight requests and crashes consume this same slot.
          const reservationId = `${lineageId}:${total + 1}`;
          await append({
            event: 'reservation',
            ...(dispatch === null ? {} : { reservationId }),
            session: currentSession.id,
            requestClass,
            ...(dispatch === null ? {} : dispatch)
          });
          total += 1; counts[requestClass] += 1;
          return dispatch === null ? true : Object.freeze({ reservationId });
        });
      },
      async close() {
        if (closed) return;
        closed = true;
        await tail;
        await file.close(); await lock.close(); await unlink(lockPath);
        if (failure) throw failure;
      }
    };
  } catch (error) {
    await file?.close(); await lock.close(); await unlink(lockPath);
    throw error;
  }
}
