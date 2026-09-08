// Operational authorization, not a forecast or an amendment of the methodology.
// No numeric defaults: a budget must come from an explicit operator decision.
import { REQUEST_CLASSES } from './v11-contract.mjs';

function refuse(code, message) {
  throw Object.assign(new Error(message), { code });
}

export function validateProviderBudget(value, expected = {}) {
  if (value === null || value === undefined) {
    refuse('PROVIDER_BUDGET_REQUIRED', 'an explicit finite provider budget is required before dispatch');
  }
  const fields = ['schema', 'version', 'authorizationRef', 'runId', 'attemptId',
    'implementationLockHash', 'maxRetries', 'limits'];
  if (typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join() !== fields.sort().join()
    || value.schema !== 'shadowgraph.v11.provider-budget' || value.version !== 1
    || typeof value.implementationLockHash !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.implementationLockHash)
    || value.maxRetries !== 0
    || ['authorizationRef', 'runId', 'attemptId'].some((key) => (
      typeof value[key] !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value[key])
    ))
    || value.limits === null || typeof value.limits !== 'object' || Array.isArray(value.limits)
    || Object.keys(value.limits).sort().join() !== [...REQUEST_CLASSES].sort().join()
    || REQUEST_CLASSES.some((key) => !Number.isSafeInteger(value.limits[key]) || value.limits[key] < 0)) {
    refuse('PROVIDER_BUDGET_INVALID', 'budget needs exact identity, zero retries, and finite non-negative class ceilings');
  }
  for (const key of ['runId', 'attemptId', 'implementationLockHash']) {
    if (expected[key] !== undefined && value[key] !== expected[key]) {
      refuse('PROVIDER_BUDGET_MISMATCH', `provider budget does not authorize this ${key}`);
    }
  }
  return Object.freeze({ ...value, limits: Object.freeze({ ...value.limits }) });
}

/** Reconcile write-ahead attempts with the unchanged completion ledger.
 * dispatch_intent means the meter was about to dispatch, not provider receipt.
 * Abrupt termination can leave this uncertain; never fabricate a completion.
 */
export function reconcileProviderAttempts({ text, events, expectedBudget = undefined }) {
  const findings = [];
  const counts = Object.fromEntries(REQUEST_CLASSES.map((name) => [name, {
    admitted: 0, denied: 0, dispatchIntents: 0, completed: 0, succeeded: 0, failed: 0, incomplete: 0
  }]));
  const bad = (code) => findings.push(code);
  try {
    if (typeof text !== 'string' || !text.endsWith('\n')) throw new Error('ATTEMPT_LEDGER_UNREADABLE_OR_TRUNCATED');
    const rows = text.trimEnd().split('\n').map((line) => JSON.parse(line));
    if (rows.some((r) => r?.schema !== 'shadowgraph.provider-meter.attempt' || r.version !== 1
      || typeof r.recordedAt !== 'string' || !Number.isFinite(Date.parse(r.recordedAt)))) throw new Error('INVALID_ATTEMPT_RECORD');
    if (rows[0]?.event !== 'authorization') throw new Error('ATTEMPT_AUTHORIZATION_MISSING');
    const budget = validateProviderBudget(rows[0].budget);
    if (expectedBudget !== undefined) {
      const expected = validateProviderBudget(expectedBudget, budget);
      if (expected.authorizationRef !== budget.authorizationRef
        || REQUEST_CLASSES.some((key) => expected.limits[key] !== budget.limits[key])) bad('ATTEMPT_AUTHORIZATION_MISMATCH');
    }
    const attempts = new Map();
    const completions = new Map();
    for (const event of events) {
      if (completions.has(event.requestNumber)) bad('DUPLICATE_COMPLETION');
      completions.set(event.requestNumber, event);
    }
    const linked = new Set();
    for (const row of rows.slice(1)) {
      if (!Number.isSafeInteger(row.attemptNumber) || row.attemptNumber < 1) throw new Error('INVALID_ATTEMPT_NUMBER');
      if (row.event === 'admission') {
        const c = row.correlation;
        if (row.attemptNumber !== attempts.size + 1 || typeof row.admitted !== 'boolean'
          || !c || !REQUEST_CLASSES.includes(c.requestClass)
          || ['runId', 'attemptId', 'armId', 'scenarioId', 'phase'].some((key) => typeof c[key] !== 'string' || !c[key])
          || !Number.isSafeInteger(c.repetition) || c.repetition < 0) throw new Error('INVALID_ADMISSION');
        validateProviderBudget(budget, c);
        attempts.set(row.attemptNumber, { ...row, dispatched: false, completed: false });
        counts[c.requestClass][row.admitted ? 'admitted' : 'denied'] += 1;
        if (!row.admitted) bad('BUDGET_DISPATCH_DENIED');
        continue;
      }
      const attempt = attempts.get(row.attemptNumber);
      if (!attempt) throw new Error('ORPHAN_ATTEMPT_RECORD');
      const count = counts[attempt.correlation.requestClass];
      if (row.event === 'dispatch_intent') {
        if (!attempt.admitted || attempt.dispatched || attempt.completed) throw new Error('INVALID_DISPATCH_INTENT');
        attempt.dispatched = true;
        count.dispatchIntents += 1;
      } else if (row.event === 'completion') {
        const event = completions.get(row.requestNumber);
        if (attempt.completed || linked.has(row.requestNumber) || !event
          || Object.keys(attempt.correlation).some((key) => attempt.correlation[key] !== event[key])
          || row.outcome !== event.outcome || !['SUCCEEDED', 'FAILED'].includes(event.outcome)
          || (event.outcome === 'SUCCEEDED' && !attempt.dispatched)
          || (!attempt.admitted && event.failure?.code !== 'PROVIDER_BUDGET_EXHAUSTED')) throw new Error('INVALID_ATTEMPT_COMPLETION');
        attempt.completed = true;
        linked.add(row.requestNumber);
        count.completed += 1;
        count[event.outcome === 'SUCCEEDED' ? 'succeeded' : 'failed'] += 1;
        if (event.outcome === 'FAILED') bad('FAILED_ATTEMPT');
      } else throw new Error('UNKNOWN_ATTEMPT_EVENT');
    }
    for (const attempt of attempts.values()) {
      if (!attempt.completed) {
        counts[attempt.correlation.requestClass].incomplete += 1;
        bad('INCOMPLETE_ATTEMPT');
      }
    }
    if (linked.size !== events.length) bad('UNLINKED_PROVIDER_COMPLETION');
    for (const name of REQUEST_CLASSES) if (counts[name].admitted > budget.limits[name]) bad('PROVIDER_BUDGET_BREACH');
  } catch (error) {
    // Do not echo arbitrary malformed JSON or credential-bearing input.
    bad('ATTEMPT_EVIDENCE_INVALID');
  }
  return { status: findings.length ? 'BLOCKED' : 'RECONCILED', counts,
    findings: [...new Set(findings)],
    note: 'Dispatch intents are write-ahead evidence, not proof of upstream receipt; incomplete attempts remain unknown.' };
}
