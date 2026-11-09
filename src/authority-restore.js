// R16 revision 2: restore may narrow current authority, never create it.
// The merge is detached and side-effect free; the caller owns the destination
// fence and installs this complete candidate in its existing atomic restore.
import { createHash } from 'node:crypto';
import { ACCESS_STATES, ACCESS_SURFACES, intersectAccessScope, reconcileAccessLedger, validateAccess } from './access.js';
import { isValidIsoInstant } from './fact-validity.js';

const authorityKeys = ['access', 'accessRevocations'];
const immutable = ['accessId', 'type', 'createdAt', 'issuedBy', 'derivedFrom'];
const terminal = entry => ['revoked', 'discarded'].includes(entry?.state);
const readable = value => value && typeof value === 'object' && !Array.isArray(value) && Array.isArray(value.entries);
const usableId = value => typeof value === 'string' && value.trim().length > 0;
const clone = value => structuredClone(value);
const rank = state => ACCESS_STATES.indexOf(state);
const stricter = (a, b) => rank(a) >= rank(b) ? a : b;
const instant = value => isValidIsoInstant(value) ? Date.parse(value) : null;
function earliest(a, b) {
  if (a == null) return b ?? null;
  if (b == null) return a;
  if (instant(a) === null) return a;
  if (instant(b) === null) return b;
  return instant(a) <= instant(b) ? a : b;
}
function suspend(entry, reason, now) {
  if (terminal(entry)) return;
  entry.state = stricter('suspended', entry.state);
  entry.suspendedAt = earliest(entry.suspendedAt, now);
  entry.suspendedReason ||= reason;
}
function allowedSurfaces(payload, entry, now) {
  const operation = entry.type === 'delegation' ? 'issue' : 'read';
  return ACCESS_SURFACES.filter(surface => {
    try { return validateAccess(payload, entry.accessId, { now, surface, operation }).ok; }
    catch { return false; } // Unreadable current authority confers nothing.
  });
}
function indexEntries(collection) {
  const index = new Map();
  for (const entry of readable(collection) ? collection.entries : []) {
    if (!entry || typeof entry !== 'object' || !usableId(entry.accessId)) continue;
    const found = index.get(entry.accessId);
    if (found) {
      found.duplicate = true;
      if (rank(entry.state) > rank(found.entry.state)) found.entry = entry;
    }
    else index.set(entry.accessId, { entry, duplicate: false });
  }
  return index;
}
function mergedEntry(destination, backup, now) {
  const entry = { ...clone(backup), ...clone(destination) };
  entry.state = stricter(destination.state, backup.state);
  entry.revokedAt = earliest(destination.revokedAt, backup.revokedAt);
  entry.suspendedAt = earliest(destination.suspendedAt, backup.suspendedAt);
  entry.suspendedReason = (entry.suspendedAt === backup.suspendedAt ? backup.suspendedReason : destination.suspendedReason) ?? null;
  entry.terminalReason = (terminal(destination) ? destination.terminalReason : backup.terminalReason ?? destination.terminalReason) ?? null;
  entry.scope = intersectAccessScope(destination.scope, backup.scope);
  entry.surfaces = ACCESS_SURFACES.filter(surface => Array.isArray(destination.surfaces) && destination.surfaces.includes(surface) && Array.isArray(backup.surfaces) && backup.surfaces.includes(surface));
  entry.expiresAt = (instant(destination.expiresAt) === null ? destination.expiresAt : instant(backup.expiresAt) === null ? backup.expiresAt : earliest(destination.expiresAt, backup.expiresAt)) ?? null;
  if (entry.type === 'delegation') {
    const validBudget = [destination.issuanceLimit, backup.issuanceLimit].every(value => Number.isSafeInteger(value) && value >= 1)
      && [destination.issuanceConsumed, backup.issuanceConsumed].every(value => Number.isSafeInteger(value) && value >= 0);
    if (validBudget) {
      entry.issuanceLimit = Math.min(destination.issuanceLimit, backup.issuanceLimit);
      entry.issuanceConsumed = Math.max(destination.issuanceConsumed, backup.issuanceConsumed);
      if (entry.issuanceConsumed >= entry.issuanceLimit) entry.state = stricter(entry.state, 'exhausted');
    } else suspend(entry, 'invalid_destination_or_backup_budget', now);
  }
  if (immutable.some(key => (destination[key] ?? null) !== (backup[key] ?? null))) suspend(entry, 'authority_identity_conflict', now);
  if (rank(destination.state) < 0 || rank(backup.state) < 0) suspend(entry, 'invalid_authority_state', now);
  return entry;
}
function mergeLedger(destination, backup, entries, now) {
  const ledger = new Map();
  for (const collection of [destination, backup]) for (const item of readable(collection) ? collection.entries : []) {
    if (!item || !usableId(item.accessId)) continue;
    // Retain every distinct tombstone, including ids absent from access.entries.
    const key = JSON.stringify([item.accessId, item.eventId ?? null, item.terminalReason ?? 'revoked']);
    const previous = ledger.get(key);
    ledger.set(key, previous ? { ...clone(item), ...previous, revokedAt: earliest(previous.revokedAt, item.revokedAt) } : clone(item));
  }
  for (const entry of entries) {
    const tombstones = [...ledger.values()].filter(item => item.accessId === entry.accessId);
    for (const item of tombstones) {
      const state = item.terminalReason === 'discarded' ? 'discarded' : 'revoked';
      entry.state = stricter(entry.state, state);
      entry.terminalReason ||= state;
      if (state === 'revoked') entry.revokedAt = earliest(entry.revokedAt, item.revokedAt ?? now);
    }
    if (entry.revokedAt != null && !terminal(entry)) { entry.state = 'revoked'; entry.terminalReason = 'revoked'; }
    if (terminal(entry) && !tombstones.length) {
      entry.terminalReason ||= entry.state;
      const item = { accessId: entry.accessId, revokedAt: entry.revokedAt ?? now, eventId: null, cascadedFrom: null, terminalReason: entry.terminalReason };
      ledger.set(JSON.stringify([entry.accessId, null, item.terminalReason]), item);
    }
  }
  const seq = value => Number.isSafeInteger(value) && value >= 0 ? value : 0;
  return { lineageId: destination?.lineageId ?? backup?.lineageId ?? null, ledgerSeq: Math.max(seq(destination?.ledgerSeq), seq(backup?.ledgerSeq)), entries: [...ledger.values()] };
}
function aggregateKey(event) {
  if (!['access.used', 'access.refused', 'access.audit_overflow'].includes(event?.type)) return null;
  const day = event.day ?? event.utcDay ?? event.window ?? event.firstAt?.slice(0, 10) ?? event.at?.slice(0, 10);
  if (!day) return null;
  if (event.type === 'access.audit_overflow') return JSON.stringify([event.type, event.aggregateKey ?? event.surface, day]);
  return JSON.stringify([event.type, event.accessId ?? event.requestId, event.surface, event.type === 'access.refused' ? event.reason : null, day]);
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
}
function mergeEvents(backupEvents, destinationEvents, restoreEvent, entries, ledger, now) {
  const events = clone(Array.isArray(backupEvents) ? backupEvents : []);
  const byId = new Map(events.map(event => [event.id, event]));
  const retainedIds = new Set(entries.map(entry => entry.accessId));
  const witnessIds = new Set(entries.map(entry => entry.issuanceEventId).filter(usableId));
  const terminalEventIds = new Set(ledger.entries.map(item => item.eventId).filter(usableId));
  for (const event of Array.isArray(destinationEvents) ? destinationEvents : []) {
    const required = event?.type === 'access.issued' && witnessIds.has(event.id)
      || ['access.revoked', 'access.discarded'].includes(event?.type) && (terminalEventIds.has(event.id) || retainedIds.has(event.accessId))
      || event?.type === 'access.scope_narrowed' && retainedIds.has(event.accessId)
      || event?.type === 'access.requested' && entries.some(entry => entry.type === 'request' && entry.accessId === event.accessId);
    if (!required) continue;
    const existing = byId.get(event.id);
    if (!existing) { const retained = clone(event); events.push(retained); byId.set(event.id, retained); continue; }
    if (JSON.stringify(stable(existing)) === JSON.stringify(stable(event))) continue;
    // A duplicate event id cannot enter a valid store. Keep the recovered
    // memory event at its original id and preserve the conflicting destination
    // evidence in the restore audit, with affected authority durably blocked.
    restoreEvent.anomalies.push({ code: 'authority_audit_identity_conflict', eventId: event.id, destinationEvent: clone(event) });
    for (const entry of entries) if (entry.type !== 'request' && (entry.issuanceEventId === event.id || entry.accessId === event.accessId)) suspend(entry, 'authority_audit_identity_conflict', now);
  }
  const aggregates = new Map(events.map((event, index) => [aggregateKey(event), index]).filter(([key]) => key !== null));
  for (const event of Array.isArray(destinationEvents) ? destinationEvents : []) {
    const key = aggregateKey(event); if (key === null) continue;
    if (!aggregates.has(key)) { aggregates.set(key, events.length); events.push(clone(event)); continue; }
    const target = events[aggregates.get(key)];
    for (const field of ['count', 'usedCount', 'refusedCount', 'recordsReturnedTotal']) {
      if (target[field] !== undefined || event[field] !== undefined) target[field] = Math.max(Number(target[field]) || 0, Number(event[field]) || 0);
    }
    target.firstAt = earliest(target.firstAt, event.firstAt);
    if (instant(event.lastAt) !== null && (instant(target.lastAt) === null || instant(event.lastAt) > instant(target.lastAt))) target.lastAt = event.lastAt;
  }
  for (const index of aggregates.values()) {
    events[index].boundary = 'restored'; events[index].restoreEventId = restoreEvent.id;
    events[index].precision = 'lower_bound_restored';
  }
  events.push(restoreEvent);
  return events;
}

export function mergeAuthorityRestore(backup, destination, { now = new Date().toISOString(), decidedBy = 'restore', eventId } = {}) {
  if (!isValidIsoInstant(now)) throw new Error('Restore requires a valid current instant');
  if (!authorityKeys.some(key => Object.hasOwn(backup ?? {}, key) || Object.hasOwn(destination ?? {}, key))) return backup;
  const result = clone(backup);
  const current = indexEntries(destination?.access), incoming = indexEntries(backup?.access);
  const currentReadable = readable(destination?.access);
  const cases = { A: [], B: [], C: [], D: [], E: [], destinationOnly: [] };
  const entries = [];
  for (const id of new Set([...current.keys(), ...incoming.keys()])) {
    const d = current.get(id), b = incoming.get(id);
    let entry, decision;
    if (!b) { entry = clone(d.entry); decision = 'destinationOnly'; }
    else if (d?.entry.type === 'request' && b.entry.type === 'request') { entry = clone(b.entry); decision = 'E'; }
    else if (d) { entry = mergedEntry(d.entry, b.entry, now); decision = 'A'; }
    else if (b.entry.type === 'request') { entry = clone(b.entry); decision = 'E'; }
    else if (terminal(b.entry)) { entry = clone(b.entry); decision = 'C'; }
    else { entry = clone(b.entry); decision = currentReadable ? 'B' : 'D'; suspend(entry, currentReadable ? 'absent_from_destination' : 'no_destination_authority_state', now); }
    if (d?.duplicate || b?.duplicate) suspend(entry, 'duplicate_authority_identity', now);
    if (entry.type !== 'request') {
      entry.scope = intersectAccessScope(entry.scope, entry.scope);
      if (Array.isArray(entry.surfaces)) entry.surfaces = [...new Set(entry.surfaces)].sort();
    }
    if (d && ['grant', 'delegation'].includes(entry.type) && !terminal(entry)) {
      const allowed = allowedSurfaces(destination, d.entry, now);
      if (!allowed.length && entry.state === 'active') suspend(entry, 'destination_authority_unusable', now);
      // Even a surface-specific predicate must not acquire a newly usable path.
      if (allowed.length && Array.isArray(entry.surfaces)) entry.surfaces = entry.surfaces.filter(surface => allowed.includes(surface));
    }
    if (b) entry.restoreProvenance ??= { fromBackupAt: now, decidedBy, case: decision };
    cases[decision].push(id); entries.push(entry);
  }
  result.access = { lineageId: destination?.access?.lineageId ?? backup?.access?.lineageId ?? null, entries };
  result.accessRevocations = mergeLedger(destination?.accessRevocations, backup?.accessRevocations, entries, now);
  // Revocation of a delegation is terminal for everything it issued, including
  // destination-only grants. Expiry/exhaustion alone deliberately does not cascade.
  for (const entry of entries) {
    if (entry.type !== 'grant' || typeof entry.issuedBy !== 'string' || !entry.issuedBy.startsWith('delegation:')) continue;
    const parentId = entry.issuedBy.slice('delegation:'.length);
    const tombstone = result.accessRevocations.entries.find(item => item.accessId === parentId && item.terminalReason !== 'discarded');
    if (tombstone) {
      entry.state = 'revoked'; entry.terminalReason = 'revoked'; entry.revokedAt = earliest(entry.revokedAt, tombstone.revokedAt ?? now);
      if (!result.accessRevocations.entries.some(item => item.accessId === entry.accessId)) result.accessRevocations.entries.push({ accessId: entry.accessId, revokedAt: entry.revokedAt, eventId: null, cascadedFrom: parentId, terminalReason: 'revoked' });
    }
  }
  const anomalies = [];
  if (destination?.access?.lineageId && backup?.access?.lineageId && destination.access.lineageId !== backup.access.lineageId) anomalies.push({ code: 'authority_lineage_mismatch', destination: destination.access.lineageId, backup: backup.access.lineageId });
  if (destination?.accessRevocations?.ledgerSeq !== backup?.accessRevocations?.ledgerSeq) anomalies.push({ code: 'authority_ledger_sequence_difference', destination: destination?.accessRevocations?.ledgerSeq ?? null, backup: backup?.accessRevocations?.ledgerSeq ?? null });
  const id = eventId ?? `access_restore_${createHash('sha256').update(JSON.stringify([now, destination?.revision, backup?.revision, cases, result.accessRevocations])).digest('hex').slice(0, 24)}`;
  result.events = mergeEvents(backup.events, destination?.events, { id, type: 'access.restored', at: now, decidedBy, cases, anomalies }, entries, result.accessRevocations, now);
  // Install the same terminal state that an ordinary graph load will activate.
  result.access = reconcileAccessLedger(result.access, result.accessRevocations);
  return result;
}
