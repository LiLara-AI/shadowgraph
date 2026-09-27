import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAccess, normalizeAccessScope, scopeSubset, intersectAccessScope, accessScopeContains, normalizeSurfaces } from '../src/access.js';

const NOW = '2026-01-01T00:00:00.000Z';
const END = '2026-02-01T00:00:00.000Z';
const scope = { projects: ['beta'], originIds: [], legacyAttributions: [] };
function fixture(type = 'grant') {
  const entry = { accessId: 'g', type, state: 'active', scope, surfaces: ['cli'], createdAt: NOW, expiresAt: END,
    revokedAt: null, suspendedAt: null, suspendedReason: null, issuedBy: 'owner_confirmation', issuanceEventId: 'w', issuedInLineage: 'lineage', derivedFrom: null,
    ...(type === 'delegation' ? { issuanceLimit: 2, issuanceConsumed: 0 } : {}) };
  return { access: { lineageId: 'lineage', entries: [entry] }, accessRevocations: { lineageId: 'lineage', ledgerSeq: 0, entries: [] },
    events: [{ id: 'w', type: 'access.issued', authorityType: type, accessId: 'g', issuedBy: entry.issuedBy, at: NOW, scope, surfaces: ['cli'], expiresAt: END }] };
}
const check = (payload, extra = {}) => validateAccess(payload, 'g', { now: NOW, surface: 'cli', ...extra });

test('authority selectors keep real default, legacy buckets and origins disjoint', () => {
  assert.deepEqual(normalizeAccessScope({ projects: ['b', 'a', 'b'] }).projects, ['a', 'b']);
  assert.deepEqual(normalizeSurfaces(['http', 'cli', 'cli']), ['cli', 'http']);
  assert.throws(() => normalizeAccessScope({ projects: ['all'], automatic: true }));
  assert.throws(() => normalizeAccessScope({}));
  assert.throws(() => normalizeSurfaces(['filesystem']));
  const named = normalizeAccessScope({ projects: ['default'] });
  for (const entity of [{ project: 'default' }, { project: 'default', attribution: 'legacy_ambiguous' }, { project: null, attribution: 'unattributed', originId: 'o' }]) assert.equal(accessScopeContains(named, entity), false);
  assert.equal(accessScopeContains(named, { project: 'default', attribution: 'project' }), true);
  assert.equal(accessScopeContains(normalizeAccessScope({ originIds: ['o'] }), { project: null, attribution: 'unattributed', originId: 'o' }), true);
  assert.equal(scopeSubset(scope, normalizeAccessScope({ projects: ['beta', 'alpha'] })), true);
  assert.deepEqual(intersectAccessScope(scope, normalizeAccessScope({ projects: ['alpha'] })), { projects: [], originIds: [], legacyAttributions: [] });
});

test('actual authority requires current state, valid bounds and an issuance witness', () => {
  assert.equal(check(fixture()).ok, true);
  const mutations = [
    p => { p.access.entries[0].type = 'request'; p.access.entries[0].state = 'requested'; },
    p => { p.access.entries[0].state = 'revoked'; },
    p => { p.access.entries[0].revokedAt = NOW; },
    p => { p.access.entries[0].suspendedAt = NOW; },
    p => { p.access.entries[0].expiresAt = NOW; },
    p => { p.access.entries[0].expiresAt = 'tomorrow'; },
    p => { p.access.entries[0].scope = { projects: ['alpha'] }; },
    p => { p.access.entries[0].surfaces = ['http']; },
    p => { p.events = []; },
    p => { p.events[0].accessId = 'other'; },
    p => { p.events[0].issuedBy = 'request_body'; },
    p => { p.access.entries.push(structuredClone(p.access.entries[0])); },
    p => { p.accessRevocations.entries.push({ accessId: 'g', revokedAt: NOW }); }
  ];
  for (const mutate of mutations) { const p = fixture(); mutate(p); assert.equal(check(p).ok, false, mutate.toString()); }
  assert.equal(validateAccess(fixture(), { ...fixture().access.entries[0] }, { now: NOW, surface: 'cli' }).ok, false);
});

test('delegation expiry and exhaustion stop issuance; suspension and revocation invalidate children', () => {
  const p = fixture('delegation');
  assert.equal(check(p, { operation: 'issue' }).ok, true);
  const child = { ...structuredClone(p.access.entries[0]), accessId: 'child', type: 'grant', issuedBy: 'delegation:g', issuanceEventId: 'cw' };
  delete child.issuanceLimit; delete child.issuanceConsumed;
  p.access.entries.push(child);
  p.events.push({ ...structuredClone(p.events[0]), id: 'cw', accessId: 'child', authorityType: 'grant', issuedBy: 'delegation:g' });
  const childCheck = () => validateAccess(p, 'child', { now: NOW, surface: 'cli' });
  assert.equal(childCheck().ok, true);
  p.access.entries[0].issuanceConsumed = 2; p.access.entries[0].state = 'exhausted';
  assert.equal(check(p, { operation: 'issue' }).ok, false);
  assert.equal(childCheck().ok, true);
  p.access.entries[0].state = 'expired';
  assert.equal(childCheck().ok, true);
  for (const state of ['suspended', 'revoked', 'discarded']) { p.access.entries[0].state = state; assert.equal(childCheck().ok, false, state); }
});

test('lineage and ledger counters cannot confer or remove permission', () => {
  const p = fixture(); p.access.lineageId = 'different'; p.accessRevocations.lineageId = 'fork'; p.accessRevocations.ledgerSeq = 999;
  assert.equal(check(p).ok, true);
  p.events = []; assert.equal(check(p).ok, false);
});

test('issuance witness bounds must themselves be well formed, including unused surfaces', () => {
  for (const value of [123, null, 'nonexistent-surface']) {
    const payload = fixture(); payload.events[0].surfaces.push(value);
    assert.equal(check(payload).ok, false, String(value));
    assert.equal(check(payload).reason, 'grant_issuance_unverified');
  }
});
