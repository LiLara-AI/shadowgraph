import { randomUUID, createHash } from 'node:crypto';
import { isValidIsoInstant } from '../fact-validity.js';
import { normalizeAccessScope, normalizeSurfaces, scopeSubset, validateAccess, accessDiagnostics, ACCESS_AUDIT_POLICY, ACCESS_SURFACES } from '../access.js';

const nonempty = value => typeof value === 'string' && value.trim().length > 0;
const copy = value => structuredClone(value);
const issued = entry => ['grant', 'delegation'].includes(entry.type);

// Private owner operations are registered alongside the persistence primitive.
// No public request-body value selects ownerConfirmation.
export function createAccessLifecycle({ read, write, now }) {
  function state({ initialize = false } = {}) {
    const source = read();
    const access = source.access === undefined && initialize ? { lineageId: randomUUID(), entries: [] } : copy(source.access);
    if (!access || Array.isArray(access) || !Array.isArray(access.entries)) throw new Error('Current access state is not writable; recover it before issuing authority');
    const ledger = source.accessRevocations === undefined && initialize ? { lineageId: access.lineageId, ledgerSeq: 0, entries: [] } : copy(source.accessRevocations);
    if (!ledger || Array.isArray(ledger) || !Array.isArray(ledger.entries) || !Number.isSafeInteger(ledger.ledgerSeq) || ledger.ledgerSeq < 0) throw new Error('Current revocation state is not writable');
    return { access, accessRevocations: ledger, events: copy(source.events ?? []) };
  }
  function auditEvent(type, fields, at = now()) { return { id: `access_event_${randomUUID()}`, type, at, ...copy(fields) }; }
  function bounds(input, at) {
    const value = { scope: normalizeAccessScope(input.scope), surfaces: normalizeSurfaces(input.surfaces), expiresAt: input.expiresAt, reason: input.reason };
    if (!nonempty(value.reason)) throw new Error('Access requires an explicit reason');
    if (!isValidIsoInstant(value.expiresAt) || Date.parse(value.expiresAt) <= Date.parse(at)) throw new Error('Access expiry must be a future ISO instant');
    return value;
  }
  function aggregate({ accessId, surface = 'cli', reason = null, recordsReturned = 0, used = false, resolvedScope, grantScope }) {
    const payload = read(), at = now(), day = at.slice(0, 10);
    surface = ACCESS_SURFACES.includes(surface) ? surface : 'invalid';
    const cutoff = Date.parse(at) - ACCESS_AUDIT_POLICY.retainedDays * 86400000;
    const type = used ? 'access.used' : 'access.refused';
    // Invalid id objects are never serialized into audit state. Long unknown ids
    // are hashed, and adversarial cardinality has a daily overflow bucket.
    const identity = typeof accessId === 'string' ? accessId : null;
    const known = Array.isArray(payload.access?.entries) && payload.access.entries.some(entry => entry?.accessId === identity);
    const safeId = known ? identity : identity ? `unknown:${createHash('sha256').update(identity).digest('hex')}` : null;
    const events = copy(payload.events ?? []).filter(event => !['access.used', 'access.refused', 'access.audit_overflow'].includes(event.type) || !Number.isFinite(Date.parse(event.lastAt)) || Date.parse(event.lastAt) >= cutoff);
    const key = JSON.stringify([type, safeId, surface, reason, day]);
    let event = events.find(item => item.aggregateKey === key);
    const daily = events.filter(item => ['access.used', 'access.refused'].includes(item.type) && item.window === day && item.aggregateKey !== `overflow:${day}`);
    if (!event && daily.length >= ACCESS_AUDIT_POLICY.keysPerDay) {
      event = events.find(item => item.aggregateKey === `overflow:${day}`);
      if (!event) {
        event = auditEvent('access.audit_overflow', { aggregateKey: `overflow:${day}`, accessId: null, surface: 'mixed', reason: 'audit_key_overflow', window: day, count: 0, usedCount: 0, refusedCount: 0, recordsReturnedTotal: 0, firstAt: at, lastAt: at, samples: [], precision: 'aggregate_overflow' }, at);
        events.push(event);
      }
    } else if (!event) {
      event = auditEvent(type, { aggregateKey: key, accessId: safeId, surface, reason, window: day, count: 0, recordsReturnedTotal: 0, firstAt: at, lastAt: at, samples: [], precision: 'exact_within_lineage' }, at);
      events.push(event);
    }
    event.count += 1; event.recordsReturnedTotal += recordsReturned;
    if (Date.parse(at) < Date.parse(event.firstAt)) event.firstAt = at;
    if (Date.parse(at) > Date.parse(event.lastAt)) event.lastAt = at;
    if (event.type === 'access.audit_overflow') event[used ? 'usedCount' : 'refusedCount'] += 1;
    const boundedLabel = value => typeof value !== 'string' ? null : Buffer.byteLength(value) <= 128 ? value : `sha256:${createHash('sha256').update(value).digest('hex')}`;
    const sampleScope = resolvedScope ? { resolvedScope: { state: resolvedScope.state === 'project_selected' ? 'project_selected' : 'project_unresolved', project: boundedLabel(resolvedScope.project), originId: boundedLabel(resolvedScope.originId) } } : {};
    const fingerprint = grantScope ? { grantScopeHash: createHash('sha256').update(JSON.stringify(grantScope)).digest('hex') } : {};
    event.samples = [...event.samples, { at, recordsReturned, ...sampleScope, ...fingerprint, ...(event.type === 'access.audit_overflow' ? { type, surface, reason } : {}) }].slice(-ACCESS_AUDIT_POLICY.sampleLimit);
    write({ ...payload, events });
  }
  function refuse(input, reason) { aggregate({ accessId: input.delegationId ?? input.accessId ?? input.requestId, surface: input.surface ?? 'cli', reason }); return { ok: false, reason }; }
  function transportRefusal(input = {}) {
    if (!['grant_requires_owner_confirmation', 'grant_bounds_invalid', 'access_request_not_available', 'delegation_budget_invalid', 'issuance_surface_unavailable'].includes(input.reason)) throw new Error('Unsupported access refusal');
    return refuse(input, input.reason);
  }
  function request(input = {}) {
    const at = now(), normalized = bounds(input, at), payload = state({ initialize: true });
    const entry = { accessId: `access_${randomUUID()}`, type: 'request', state: 'requested', ...normalized, createdAt: at, revokedAt: null, suspendedAt: null, suspendedReason: null, terminalReason: null, issuedBy: null, issuanceEventId: null, derivedFrom: null };
    payload.access.entries.push(entry);
    payload.events.push(auditEvent('access.requested', { accessId: entry.accessId, scope: entry.scope, surfaces: entry.surfaces, expiresAt: entry.expiresAt, reason: entry.reason }, at));
    write(payload); return copy(entry);
  }
  function issue(input = {}, ownerConfirmation = false) {
    if (!ownerConfirmation && !nonempty(input.delegationId)) return refuse(input, 'grant_requires_owner_confirmation');
    const at = now();
    let normalized;
    try { normalized = bounds(input, at); } catch { return refuse(input, 'grant_bounds_invalid'); }
    const type = input.type ?? 'grant';
    if (!['grant', 'delegation'].includes(type) || (!ownerConfirmation && type !== 'grant')) return refuse(input, 'delegation_cannot_delegate');
    if (type === 'delegation' && (!Number.isSafeInteger(input.issuanceLimit) || input.issuanceLimit < 1)) return refuse(input, 'delegation_budget_invalid');
    const payload = state({ initialize: ownerConfirmation });
    const issuedBy = ownerConfirmation ? 'owner_confirmation' : `delegation:${input.delegationId}`;
    if (input.idempotencyKey !== undefined && !nonempty(input.idempotencyKey)) return refuse(input, 'issuance_retry_key_invalid');
    const previous = input.idempotencyKey && payload.access.entries.find(entry => entry.issuedBy === issuedBy && entry.issuanceKey === input.idempotencyKey);
    if (previous) {
      const same = previous.type === type && JSON.stringify(previous.scope) === JSON.stringify(normalized.scope) && JSON.stringify(previous.surfaces) === JSON.stringify(normalized.surfaces) && previous.expiresAt === normalized.expiresAt && previous.derivedFrom === (input.requestId ?? null);
      // A retry returns the already committed receipt, never creates new authority
      // or refunds budget. Its terminal state remains visible in the receipt.
      return same ? { ok: true, entry: copy(previous), replayed: true } : refuse(input, 'issuance_retry_mismatch');
    }
    let delegation;
    if (!ownerConfirmation) {
      const decision = validateAccess(payload, input.delegationId, { now: at, surface: input.surface ?? 'cli', operation: 'issue' });
      if (!decision.ok) return refuse(input, decision.reason);
      delegation = payload.access.entries.find(entry => entry.accessId === input.delegationId);
      if (!scopeSubset(normalized.scope, delegation.scope) || !normalized.surfaces.every(surface => delegation.surfaces.includes(surface)) || Date.parse(normalized.expiresAt) > Date.parse(delegation.expiresAt)) return refuse(input, 'delegation_bounds_exceeded');
    }
    if (input.requestId !== undefined) {
      const proposed = payload.access.entries.filter(entry => entry.accessId === input.requestId);
      if (proposed.length !== 1 || proposed[0].type !== 'request' || proposed[0].state !== 'requested') return refuse(input, 'access_request_not_available');
      if (!scopeSubset(normalized.scope, proposed[0].scope) || !normalized.surfaces.every(surface => proposed[0].surfaces.includes(surface)) || Date.parse(normalized.expiresAt) > Date.parse(proposed[0].expiresAt)) return refuse(input, 'request_bounds_exceeded');
    }
    const entry = { accessId: `access_${randomUUID()}`, type, state: 'active', ...normalized, createdAt: at, revokedAt: null, suspendedAt: null, suspendedReason: null, terminalReason: null,
      issuedBy, issuedInLineage: payload.access.lineageId, derivedFrom: input.requestId ?? null,
      ...(input.idempotencyKey ? { issuanceKey: input.idempotencyKey } : {}),
      ...(type === 'delegation' ? { issuanceLimit: input.issuanceLimit, issuanceConsumed: 0 } : {}) };
    const witness = auditEvent('access.issued', { accessId: entry.accessId, authorityType: type, issuedBy, scope: entry.scope, surfaces: entry.surfaces, expiresAt: entry.expiresAt }, at);
    entry.issuanceEventId = witness.id;
    if (delegation) { delegation.issuanceConsumed += 1; if (delegation.issuanceConsumed >= delegation.issuanceLimit) delegation.state = 'exhausted'; }
    payload.access.entries.push(entry); payload.events.push(witness);
    write(payload); return { ok: true, entry: copy(entry), replayed: false };
  }
  function terminal(input = {}, discard = false) {
    const payload = state(), at = now();
    const found = payload.access.entries.filter(entry => entry.accessId === input.accessId);
    if (found.length !== 1) return { ok: false, reason: 'access_not_found' };
    const root = found[0];
    const affected = [root, ...(root.type === 'delegation' ? payload.access.entries.filter(entry => entry.issuedBy === `delegation:${root.accessId}`) : [])];
    for (const entry of affected) {
      if (payload.accessRevocations.entries.some(item => item.accessId === entry.accessId)) continue;
      const state = discard && entry === root ? 'discarded' : 'revoked';
      const event = auditEvent(state === 'discarded' ? 'access.discarded' : 'access.revoked', { accessId: entry.accessId, reason: input.reason ?? state, cascadedFrom: entry === root ? null : root.accessId }, at);
      entry.state = state; entry.terminalReason = state; entry.revokedAt = entry.revokedAt ?? at;
      if (state === 'discarded') entry.discardedAt = at;
      payload.accessRevocations.ledgerSeq += 1;
      payload.accessRevocations.entries.push({ accessId: entry.accessId, revokedAt: entry.revokedAt, eventId: event.id, cascadedFrom: event.cascadedFrom, terminalReason: state });
      payload.events.push(event);
    }
    write(payload); return { ok: true, entry: copy(root) };
  }
  function purge(project) {
    const payload = copy(read()), terminalIds = [];
    let changed = false;
    for (const entry of Array.isArray(payload.access?.entries) ? payload.access.entries : []) {
      if (!issued(entry) || !entry.scope?.projects?.includes(project)) continue;
      entry.scope.projects = entry.scope.projects.filter(value => value !== project);
      changed = true;
      if (!entry.scope.projects.length && !entry.scope.originIds?.length && !entry.scope.legacyAttributions?.length) terminalIds.push(entry.accessId);
      else payload.events.push(auditEvent('access.scope_narrowed', { accessId: entry.accessId, reason: 'project_purged', removedProject: project }));
    }
    if (changed) write(payload);
    for (const accessId of terminalIds) terminal({ accessId, reason: 'last_project_purged' });
  }
  function inspect() {
    const payload = read();
    return { view: 'privileged_authority', access: copy(payload.access ?? null), accessRevocations: copy(payload.accessRevocations ?? null),
      events: copy((payload.events ?? []).filter(event => typeof event.type === 'string' && event.type.startsWith('access.'))), issues: accessDiagnostics(payload, now()), auditPolicy: ACCESS_AUDIT_POLICY,
      trustResidual: 'Local filesystem writers can modify state and witnesses. This is not an external owner identity guarantee.' };
  }
  return { request, issue: input => issue(input, false), issueOwner: input => issue(input, true), revoke: input => terminal(input), discard: input => terminal(input, true), aggregate, transportRefusal, inspect, purge };
}
