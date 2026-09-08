// One persistent campaign spans probes and separately identified fresh runs.
// A crashed owner leaves its lock in place: recovery requires explicit inspection,
// never automatic lock stealing or resetting consumed reservations.
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJson, REQUEST_CLASSES } from './v11-contract.mjs';

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
    const sessions = new Set();
    let total = 0;
    let recoveries = 0;
    for (const row of rows.slice(1)) {
      if (row.event === 'session' && typeof row.id === 'string' && !sessions.has(row.id)
        && typeof row.recovery === 'boolean') {
        sessions.add(row.id);
        if (row.recovery) recoveries += 1;
      }
      else if (row.event === 'reservation' && REQUEST_CLASSES.includes(row.requestClass) && sessions.has(row.session)) {
        counts[row.requestClass] += 1; total += 1;
      } else throw new Error('Invalid campaign journal');
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
      beginSession(id, { recovery = false } = {}) {
        return enqueue(async () => {
          if (Date.now() >= Date.parse(policy.deadline)) throw new Error('Campaign expired');
          if (typeof id !== 'string' || !/^[A-Za-z0-9._:-]+$/.test(id) || sessions.has(id) || sessions.size >= policy.maxSessions) throw new Error('Campaign session refused');
          if (typeof recovery !== 'boolean' || (recovery && recoveries >= policy.maxRecoveryAttempts)) throw new Error('Campaign recovery refused');
          await append({ event: 'session', id, recovery });
          if (recovery) recoveries += 1;
          sessions.add(id); currentSession = id;
        });
      },
      reserve(requestClass) {
        return enqueue(async () => {
          if (!REQUEST_CLASSES.includes(requestClass)) throw new Error('Invalid campaign request class');
          if (!currentSession || Date.now() >= Date.parse(policy.deadline)
            || total >= policy.maxRequests || counts[requestClass] >= policy.limits[requestClass]) return false;
          // Durable reservation precedes permission to dispatch. No refunds:
          // failure, in-flight requests and crashes consume this same slot.
          await append({ event: 'reservation', session: currentSession, requestClass });
          total += 1; counts[requestClass] += 1;
          return true;
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
