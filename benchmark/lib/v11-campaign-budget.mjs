// One persistent campaign spans probes and separately identified fresh runs.
// A crashed owner leaves its lock in place: recovery requires explicit inspection,
// never automatic lock stealing or resetting consumed reservations.
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, REQUEST_CLASSES } from './v11-contract.mjs';

const SESSION_KINDS = new Set(['probe', 'acceptance']);
const ROOT_OPERATIONS = new Set(['reset', 'retrieve', 'persist', 'verify', 'outer-decision']);
const PLAN_DISPOSITIONS = new Set(['root-initial', 'data-dependent-child', 'recovery']);
const SAFE_ID = /^[A-Za-z0-9._:-]+$/;
const OPAQUE_DISPATCH_ID = /^[a-f0-9]{48}$/;

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

export function validateCampaignPolicy(policy) {
  if (!policy || Object.keys(policy).sort().join() !== ['campaignId', 'deadline', 'limits', 'maxRequests', 'maxSessions', 'maxRecoveryAttempts', 'implementationLockHash'].sort().join()
    || typeof policy.implementationLockHash !== 'string' || !/^[a-f0-9]{64}$/.test(policy.implementationLockHash)
    || typeof policy.campaignId !== 'string' || !/^[a-zA-Z0-9-]+$/.test(policy.campaignId)
    || !Number.isSafeInteger(policy.maxRequests) || policy.maxRequests < 1
    || !Number.isSafeInteger(policy.maxSessions) || policy.maxSessions < 1
    || !Number.isSafeInteger(policy.maxRecoveryAttempts) || policy.maxRecoveryAttempts < 0
    || typeof policy.deadline !== 'string' || !Number.isFinite(Date.parse(policy.deadline))
    || new Date(policy.deadline).toISOString() !== policy.deadline
    || !policy.limits || Object.keys(policy.limits).sort().join() !== [...REQUEST_CLASSES].sort().join()
    || REQUEST_CLASSES.some((key) => !Number.isSafeInteger(policy.limits[key]) || policy.limits[key] < 0)) {
    throw new Error('Invalid campaign policy');
  }
  return JSON.parse(canonicalJson(policy));
}

export async function createCampaignBudget(root, input) {
  const policy = validateCampaignPolicy(input);
  await mkdir(root, { recursive: false, mode: 0o700 }); // parent must already exist
  const ledgerPath = path.join(root, 'campaign.ndjson');
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
    await file.sync();
  } finally { await file.close(); }
}

export async function openCampaignBudget(root, input, expected = {}) {
  const policy = validateCampaignPolicy(input);
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
    const text = await readFile(path.join(root, 'campaign.ndjson'), 'utf8');
    if (!text.endsWith('\n')) throw new Error('Truncated campaign evidence');
    const rows = text.trimEnd().split('\n').map(JSON.parse);
    if (rows[0]?.event !== 'policy' || canonicalJson(rows[0].policy) !== canonicalJson(policy)) throw new Error('Campaign policy mismatch');
    const counts = Object.fromEntries(REQUEST_CLASSES.map((key) => [key, 0]));
    const sessions = new Map();
    const reservationIds = new Set();
    let total = 0;
    let recoveries = 0;
    for (const row of rows.slice(1)) {
      try {
        if (row.event === 'session') {
          const metadata = sessionMetadata(row);
          const expectedFields = metadata === null
            ? ['event', 'id', 'recovery']
            : ['event', 'id', 'recovery', 'kind', 'runId', 'attemptId'];
          if (!isNonEmptyString(row.id) || !SAFE_ID.test(row.id) || sessions.has(row.id)
            || typeof row.recovery !== 'boolean'
            || Object.keys(row).sort().join() !== expectedFields.sort().join()) {
            throw new Error('invalid session');
          }
          sessions.set(row.id, metadata);
          if (row.recovery) recoveries += 1;
          continue;
        }
        if (row.event !== 'reservation' || !sessions.has(row.session)
          || !REQUEST_CLASSES.includes(row.requestClass)) {
          throw new Error('invalid reservation');
        }
        if (Object.hasOwn(row, 'reservationId')) {
          const metadata = sessions.get(row.session);
          if (metadata === null || !CAMPAIGN_RESERVATION_ID.test(row.reservationId)
            || row.reservationId !== `${policy.campaignId}:${total + 1}`
            || reservationIds.has(row.reservationId)) {
            throw new Error('invalid reservation receipt');
          }
          const dispatch = Object.fromEntries(Object.entries(row).filter(([key]) => ![
            'event', 'reservationId', 'session'
          ].includes(key)));
          dispatchReservation(dispatch, metadata);
          reservationIds.add(row.reservationId);
        } else if (sessions.get(row.session) !== null
          || Object.keys(row).sort().join() !== ['event', 'session', 'requestClass'].sort().join()) {
          throw new Error('invalid legacy reservation');
        }
        counts[row.requestClass] += 1; total += 1;
      } catch {
        throw new Error('Invalid campaign journal');
      }
    }
    if (total > policy.maxRequests || sessions.size > policy.maxSessions || recoveries > policy.maxRecoveryAttempts
      || REQUEST_CLASSES.some((key) => counts[key] > policy.limits[key])) throw new Error('Campaign evidence exceeds policy');
    file = await open(path.join(root, 'campaign.ndjson'), 'a', 0o600);
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
          if (typeof recovery !== 'boolean' || (recovery && recoveries >= policy.maxRecoveryAttempts)) throw new Error('Campaign recovery refused');
          await append({ event: 'session', id, recovery, ...(metadata ?? {}) });
          if (recovery) recoveries += 1;
          sessions.set(id, metadata); currentSession = Object.freeze({ id, metadata });
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
          const reservationId = `${policy.campaignId}:${total + 1}`;
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
