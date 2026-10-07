// PR39 / VAR18. Generation is control data, never a capture-item field.
// These pure calculations perform no I/O; callers hold the destination fence.
import { captureRawExpired } from './capture-retention.js';
import { accessScopeContains, validateAccess } from '../access.js';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const canonical = value => JSON.stringify(value, (key, child) => object(child)
  ? Object.fromEntries(Object.keys(child).sort().map(name => [name, child[name]])) : child);
const fail = () => { throw Object.assign(new Error('Capture generation is invalid or exhausted'), { code: 'capture_generation_invalid' }); };
const sum = (...values) => { const result = values.reduce((a, b) => a + b, 0); if (!count(result)) fail(); return result; };

export function generationIssue(value) {
  if (!object(value)) return 'generation';
  if (value.generationBase !== undefined && !count(value.generationBase)) return 'generationBase';
  if (value.generationCounters === undefined) return null;
  if (!Array.isArray(value.generationCounters)) return 'generationCounters';
  const seen = new Set();
  for (const entry of value.generationCounters) {
    if (!object(entry) || typeof entry.token !== 'string' || !entry.token || !count(entry.counter) || seen.has(entry.token)) return 'generationCounters';
    seen.add(entry.token);
  }
  return null;
}

export function joinGenerations(...states) {
  let generationBase = 0;
  const counters = new Map();
  for (const state of states) {
    if (state == null) continue;
    if (generationIssue(state)) fail();
    generationBase = Math.max(generationBase, state.generationBase ?? 0);
    for (const entry of state.generationCounters ?? []) {
      const prior = counters.get(entry.token);
      counters.set(entry.token, { ...structuredClone(entry), ...prior, counter: Math.max(prior?.counter ?? 0, entry.counter) });
    }
  }
  return { generationBase, generationCounters: [...counters.values()].sort((a, b) => a.token < b.token ? -1 : a.token > b.token ? 1 : 0) };
}

export function restoreGeneration(destination, backup) {
  const joined = joinGenerations(destination, backup);
  joined.generationBase = sum(joined.generationBase, 1);
  return joined;
}

// Only authority actually used by the claim is a covering grant. Historical
// unrelated grants cannot mask a later expiry by making this Boolean true.
export function claimAuthorityInvalid(item, payload, instant) {
  const accessId = item.lease?.accessId;
  if (accessId === undefined || accessId === null) return false;
  const result = validateAccess(payload, accessId, { now: instant, surface: 'cli' });
  return !result.ok || !accessScopeContains(result.entry.scope, item);
}

export function effectiveGeneration(item, ledger, payload, instant) {
  if (generationIssue(ledger ?? {})) fail();
  return sum(ledger?.generationBase ?? 0,
    ledger?.generationCounters?.find(entry => entry.token === item.erasureToken)?.counter ?? 0,
    Number(captureRawExpired(item, ledger?.retentionOverrides ?? [], instant)),
    Number(claimAuthorityInvalid(item, payload, instant)));
}

const captures = payload => (payload?.records ?? []).filter(item => item?.kind === 'capture');
const owner = item => item.attribution === 'project' ? ['project', item.project] : [item.attribution, item.originId];
const sharesOwner = (a, b) => canonical(owner(a)) === canonical(owner(b));
const material = (payload, item) => (payload?.captureContent ?? []).filter(entry => entry.contentRef === item.contentRef);
const invalidatingFields = item => Object.fromEntries([
  'project', 'attribution', 'originId', 'source', 'observation', 'contentRef', 'contentHash', 'expiresAt', 'cancelRequested', 'reprocessRequest'
].map(name => [name, item[name]]));

// Store commit points compare the persisted old/new values. This also covers
// import/rebuild/migration paths that do not call an ordinary graph mutator.
// Lease, attempts, receipts and new independent records do not invalidate raw.
export function invalidatedCaptureTokens(current, next) {
  const live = new Map(captures(next).map(item => [item.erasureToken, item]));
  const entities = payload => [...(payload?.records ?? []), ...(payload?.facts ?? []), ...(payload?.relations ?? [])].filter(item => item.kind !== 'capture');
  const after = new Map(entities(next).map(item => [item.id, item]));
  const changed = entities(current).filter(item => canonical(item) !== canonical(after.get(item.id)));
  const authorityChanged = canonical([current?.access, current?.accessRevocations]) !== canonical([next?.access, next?.accessRevocations]);
  return captures(current).filter(item => {
    const found = live.get(item.erasureToken);
    return !found || canonical(invalidatingFields(item)) !== canonical(invalidatingFields(found))
      || canonical(material(current, item)) !== canonical(material(next, found))
      || (found.blockedReason === 'capture_cancelled' && item.blockedReason !== found.blockedReason)
      || authorityChanged
      || changed.some(entity => sharesOwner(item, entity) || sharesOwner(item, after.get(entity.id) ?? entity)
        || item.producedRecordIds?.includes(entity.id));
  }).map(item => item.erasureToken).filter((token, index, all) => typeof token === 'string' && all.indexOf(token) === index).sort();
}

export function hookExpiryOnly(current, next, tokens) {
  const canonicalEntities = payload => [(payload?.records ?? []).filter(item => item.kind !== 'capture'), payload?.facts ?? [], payload?.relations ?? [], payload?.access, payload?.accessRevocations];
  if (canonical(canonicalEntities(current)) !== canonical(canonicalEntities(next))) return false;
  return tokens.every(token => {
    const before = captures(current).find(item => item.erasureToken === token), after = captures(next).find(item => item.erasureToken === token);
    if (!before || !after || after.contentRef !== null || after.contentHash !== null || typeof after.expiresAt !== 'string') return false;
    return canonical(['project', 'attribution', 'originId', 'source', 'observation'].map(key => before[key]))
      === canonical(['project', 'attribution', 'originId', 'source', 'observation'].map(key => after[key]));
  });
}
