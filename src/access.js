// Current-state authority predicates (plan 10.7/10.9, R16 rev2).
// No event replay, clock cache, memory mutation, or lineage freshness inference.
import { isLegacyOwned } from './scope.js';
import { isValidIsoInstant } from './fact-validity.js';
import { READABLE_JOURNAL_SCHEMA_VERSION as READABLE_SCHEMA_VERSION } from './journal.js';

export const ACCESS_SURFACES = Object.freeze(['cli', 'http', 'mcp']);
export const ACCESS_STATES = Object.freeze(['requested', 'active', 'expired', 'exhausted', 'suspended', 'discarded', 'revoked']);
export const ACCESS_AUDIT_POLICY = Object.freeze({ retainedDays: 30, keysPerDay: 256, sampleLimit: 3 });
const selectors = ['projects', 'originIds', 'legacyAttributions'];
const legacyKinds = ['legacy_ambiguous', 'legacy_unattributed'];
const text = value => typeof value === 'string' && value.trim().length > 0;
const unique = values => [...new Set(values)].sort();

function scopeArrays(scope, allowEmpty = false) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope) || Object.keys(scope).some(key => !selectors.includes(key))) throw new Error('Access scope requires explicit owner selectors');
  const result = {};
  for (const key of selectors) {
    const values = scope[key] ?? [];
    if (!Array.isArray(values) || values.some(value => !text(value))) throw new Error(`Invalid access scope ${key}`);
    if (key === 'legacyAttributions' && values.some(value => !legacyKinds.includes(value))) throw new Error('Invalid legacy attribution selector');
    result[key] = unique(values);
  }
  if (!allowEmpty && selectors.every(key => !result[key].length)) throw new Error('Access scope must name at least one owner');
  return result;
}
export const normalizeAccessScope = scope => scopeArrays(scope);
export function normalizeSurfaces(surfaces) {
  if (!Array.isArray(surfaces) || !surfaces.length || surfaces.some(surface => !ACCESS_SURFACES.includes(surface))) throw new Error('Access surfaces must explicitly name cli, mcp or http');
  return unique(surfaces);
}
export function scopeSubset(narrow, broad) {
  try {
    const a = scopeArrays(narrow, true), b = scopeArrays(broad, true);
    return selectors.every(key => a[key].every(value => b[key].includes(value)));
  } catch { return false; }
}
export function intersectAccessScope(left, right) {
  const empty = { projects: [], originIds: [], legacyAttributions: [] };
  try {
    const a = scopeArrays(left, true), b = scopeArrays(right, true);
    return Object.fromEntries(selectors.map(key => [key, a[key].filter(value => b[key].includes(value))]));
  } catch { return empty; }
}
export function accessScopeContains(scope, entity) {
  if (!entity || (Number.isInteger(entity.schemaVersion) && entity.schemaVersion > READABLE_SCHEMA_VERSION)) return false;
  if (entity.attribution === 'unattributed') return text(entity.originId) && (scope.originIds ?? []).includes(entity.originId);
  if (isLegacyOwned(entity)) {
    const kind = entity.attribution ?? (entity.project == null ? 'legacy_unattributed' : 'legacy_ambiguous');
    return (scope.legacyAttributions ?? []).includes(kind);
  }
  return (scope.projects ?? []).includes(entity.project);
}

function entries(payload) {
  const value = payload?.access;
  return value && !Array.isArray(value) && Array.isArray(value.entries) ? value.entries : [];
}
function lookup(payload, accessId) {
  const found = entries(payload).filter(entry => entry?.accessId === accessId);
  return found.length === 1 ? found[0] : null;
}
function witnessValid(payload, entry) {
  const witnesses = (Array.isArray(payload.events) ? payload.events : []).filter(event => event?.id === entry.issuanceEventId);
  if (witnesses.length !== 1) return false;
  const witness = witnesses[0];
  try { normalizeAccessScope(witness.scope); normalizeSurfaces(witness.surfaces); } catch { return false; }
  return witness.type === 'access.issued' && witness.accessId === entry.accessId && witness.authorityType === entry.type
    && witness.issuedBy === entry.issuedBy && isValidIsoInstant(witness.at) && witness.at === entry.createdAt
    && scopeSubset(entry.scope, witness.scope) && Array.isArray(witness.surfaces) && entry.surfaces.every(surface => witness.surfaces.includes(surface))
    && isValidIsoInstant(witness.expiresAt) && Date.parse(entry.expiresAt) <= Date.parse(witness.expiresAt);
}
function blockingReason(payload, entry, { now, allowParentExpiry = false }) {
  if (!entry || !['grant', 'delegation'].includes(entry.type)) return 'grant_not_found_or_not_authority';
  const ledger = payload?.accessRevocations;
  if (!ledger || Array.isArray(ledger) || !Array.isArray(ledger.entries)) return 'grant_revocation_state_invalid';
  if (ledger.entries.some(item => item?.accessId === entry.accessId)) return 'grant_revoked';
  if (entry.revokedAt !== null || entry.state === 'revoked' || entry.state === 'discarded') return 'grant_revoked';
  if (entry.suspendedAt !== null || entry.state === 'suspended') return 'grant_suspended';
  if (!(entry.state === 'active' || (allowParentExpiry && ['expired', 'exhausted'].includes(entry.state)))) return `grant_${ACCESS_STATES.includes(entry.state) ? entry.state : 'invalid_state'}`;
  if (!isValidIsoInstant(entry.createdAt) || !isValidIsoInstant(entry.expiresAt) || Date.parse(entry.expiresAt) <= Date.parse(entry.createdAt)) return 'grant_expiry_invalid';
  if (Date.parse(entry.createdAt) > Date.parse(now)) return 'grant_not_yet_issued';
  if (!allowParentExpiry && Date.parse(now) >= Date.parse(entry.expiresAt)) return 'grant_expired';
  try { normalizeAccessScope(entry.scope); normalizeSurfaces(entry.surfaces); } catch { return 'grant_bounds_invalid'; }
  if (entry.type === 'delegation' && (!Number.isSafeInteger(entry.issuanceLimit) || entry.issuanceLimit < 1 || !Number.isSafeInteger(entry.issuanceConsumed) || entry.issuanceConsumed < 0)) return 'delegation_budget_invalid';
  if (!text(entry.issuanceEventId) || !witnessValid(payload, entry)) return 'grant_issuance_unverified';
  return null;
}

export function validateAccess(payload, accessId, { now, surface = 'cli', operation = 'read' } = {}) {
  const entry = text(accessId) ? lookup(payload, accessId) : null;
  const refuse = reason => ({ ok: false, reason, entry });
  if (!isValidIsoInstant(now) || !ACCESS_SURFACES.includes(surface)) return refuse('grant_context_invalid');
  const reason = blockingReason(payload, entry, { now });
  if (reason) return refuse(reason);
  if (!entry.surfaces.includes(surface)) return refuse('grant_surface_refused');
  if (operation === 'issue') {
    if (entry.type !== 'delegation' || entry.issuedBy !== 'owner_confirmation') return refuse('delegation_required');
    if (entry.issuanceConsumed >= entry.issuanceLimit) return refuse('delegation_exhausted');
  } else if (operation !== 'read' || entry.type !== 'grant') return refuse('grant_required');
  if (entry.issuedBy !== 'owner_confirmation') {
    if (entry.type !== 'grant' || typeof entry.issuedBy !== 'string' || !entry.issuedBy.startsWith('delegation:')) return refuse('grant_issuance_unverified');
    const parent = lookup(payload, entry.issuedBy.slice('delegation:'.length));
    const parentReason = blockingReason(payload, parent, { now, allowParentExpiry: true });
    if (parentReason || parent?.type !== 'delegation' || parent.issuedBy !== 'owner_confirmation') return refuse('grant_delegation_unusable');
    if (!scopeSubset(entry.scope, parent.scope) || !entry.surfaces.every(value => parent.surfaces.includes(value)) || Date.parse(entry.expiresAt) > Date.parse(parent.expiresAt)) return refuse('grant_delegation_bounds');
    if (Date.parse(entry.createdAt) < Date.parse(parent.createdAt) || Date.parse(entry.createdAt) >= Date.parse(parent.expiresAt)) return refuse('grant_delegation_bounds');
  }
  return { ok: true, reason: null, entry };
}

export function accessDiagnostics(payload, now) {
  const issues = [];
  for (const entry of entries(payload)) {
    if (entry?.type === 'request') continue;
    const reason = blockingReason(payload, entry, { now, allowParentExpiry: true });
    if (reason && !['grant_revoked', 'grant_suspended', 'grant_expired', 'grant_exhausted'].includes(reason)) issues.push({ code: reason, accessId: entry?.accessId ?? null, severity: 'warning' });
  }
  const ids = new Set(entries(payload).map(entry => entry?.accessId));
  for (const tombstone of Array.isArray(payload?.accessRevocations?.entries) ? payload.accessRevocations.entries : []) if (!ids.has(tombstone?.accessId)) issues.push({ code: 'authority_tombstone_without_entry', accessId: tombstone?.accessId ?? null, severity: 'warning' });
  return issues;
}

// Load reconciliation narrows current state from retained tombstones only. It
// never reconstructs issuance, scope or any permission from audit events.
export function reconcileAccessLedger(access, ledger) {
  if (!access || Array.isArray(access) || !Array.isArray(access.entries) || !Array.isArray(ledger?.entries)) return access;
  let changed = false;
  const result = structuredClone(access);
  for (const entry of result.entries) {
    if (!entry || !['request', 'grant', 'delegation'].includes(entry.type)) continue;
    const tombstones = ledger.entries.filter(item => item?.accessId === entry.accessId);
    if (!tombstones.length) continue;
    const times = [entry.revokedAt, ...tombstones.map(item => item.revokedAt)].filter(isValidIsoInstant).sort((a, b) => Date.parse(a) - Date.parse(b));
    entry.revokedAt = times[0] ?? entry.revokedAt ?? null;
    entry.state = entry.state === 'revoked' || tombstones.some(item => item.terminalReason !== 'discarded') ? 'revoked' : 'discarded';
    entry.terminalReason = entry.state;
    changed = true;
  }
  return changed ? result : access;
}
