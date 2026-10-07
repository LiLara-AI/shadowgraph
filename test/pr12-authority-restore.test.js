import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { NODE_SQLITE_NOT_APPLICABLE_REASON } from '../src/runtime-capabilities.js';

const NOW = '2026-09-26T12:00:00.000Z';
const CREATED = '2026-09-01T00:00:00.000Z';
const EXPIRES = '2026-10-26T00:00:00.000Z';
let mergeAuthorityRestore, validateAccess, reconcileAccessLedger;
try { ({ mergeAuthorityRestore } = await import('../src/authority-restore.js')); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
try { ({ validateAccess, reconcileAccessLedger } = await import('../src/access.js')); } catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }

const scope = (...projects) => ({ projects, originIds: [], legacyAttributions: [] });
function entry(accessId, fields = {}) {
  return { accessId, type: 'grant', state: 'active', scope: scope('alpha', 'beta'), surfaces: ['cli', 'mcp', 'http'], reason: 'fixture', createdAt: CREATED, expiresAt: EXPIRES, revokedAt: null, suspendedAt: null, suspendedReason: null, issuedBy: 'owner_confirmation', issuanceEventId: `issued-${accessId}`, derivedFrom: null, issuedInLineage: 'L', terminalReason: null, restoreProvenance: null, ...fields };
}
function witness(value) {
  return { id: value.issuanceEventId, type: 'access.issued', at: value.createdAt, accessId: value.accessId, authorityType: value.type, issuedBy: value.issuedBy, scope: structuredClone(value.scope), surfaces: [...value.surfaces], expiresAt: value.expiresAt };
}
function snapshot(label, entries = [], { access = true, lineage = 'L', seq = 10 } = {}) {
  const graph = createShadowGraph({ now: () => NOW });
  for (const project of ['alpha', 'beta']) graph.addDecision({ project, title: `${label}-${project}`, chosen: label });
  const result = { ...privilegedSnapshot(graph), futureCollection: { from: label } };
  if (access) {
    result.access = { lineageId: lineage, entries: structuredClone(entries) };
    result.accessRevocations = { lineageId: lineage, ledgerSeq: seq, entries: [] };
    result.events.push(...entries.filter(value => value.type !== 'request').map(witness));
  }
  return result;
}
function ready() {
  assert.equal(typeof mergeAuthorityRestore, 'function', 'PR12 must provide the shared authority restore merge');
  assert.equal(typeof validateAccess, 'function', 'PR12 must provide the actual current authority predicate');
}
function capabilities(payload) {
  const permitted = [];
  for (const value of payload.access?.entries ?? []) for (const surface of ['cli', 'mcp', 'http']) {
    const operation = value.type === 'delegation' ? 'issue' : 'read';
    const allowed = validateAccess(payload, value.accessId, { now: NOW, surface, operation });
    if (allowed.ok) for (const key of ['projects', 'originIds', 'legacyAttributions']) for (const token of allowed.entry.scope[key] ?? []) {
      permitted.push(`${value.accessId}:${operation}:${surface}:${key}:${token}`);
    }
  }
  return new Set(permitted);
}
function subset(after, before) {
  const previous = capabilities(before);
  for (const operation of capabilities(after)) assert.ok(previous.has(operation), `restore activated ${operation}`);
  for (const value of after.access?.entries ?? []) for (const surface of ['cli', 'mcp', 'http']) {
    const operation = value.type === 'delegation' ? 'issue' : 'read';
    if (!validateAccess(after, value.accessId, { now: NOW, surface, operation }).ok) continue;
    const prior = validateAccess(before, value.accessId, { now: NOW, surface, operation });
    assert.equal(prior.ok, true, `restore activated ${value.accessId}:${surface}:${operation}`);
    assert.ok(Date.parse(value.expiresAt) <= Date.parse(prior.entry.expiresAt), 'usable expiry cannot extend');
    if (operation === 'issue') {
      assert.ok(value.issuanceConsumed >= prior.entry.issuanceConsumed, 'usable budget cannot refund consumption');
      assert.ok(value.issuanceLimit <= prior.entry.issuanceLimit, 'usable budget cannot raise limit');
    }
  }
}
const get = (payload, id) => payload.access.entries.find(value => value.accessId === id);

const cases = [
  ['T1 intersection and actual permission subset', () => {
    const destination = snapshot('OLD', [entry('g', { expiresAt: '2026-10-01T00:00:00.000Z' })]);
    const backup = snapshot('NEW', [entry('g', { scope: scope('alpha', 'gamma'), surfaces: ['cli', 'http'] })]);
    const originalWitness = witness(entry('g', { scope: scope('alpha', 'beta', 'gamma') }));
    for (const payload of [destination, backup]) payload.events[payload.events.findIndex(value => value.id === 'issued-g')] = structuredClone(originalWitness);
    return { destination, backup, check(after) { assert.deepEqual(get(after, 'g').scope, scope('alpha')); assert.deepEqual(get(after, 'g').surfaces, ['cli', 'http']); assert.equal(get(after, 'g').expiresAt, '2026-10-01T00:00:00.000Z'); assert.equal(validateAccess(after, 'g', { now: NOW, surface: 'cli' }).ok, true); } };
  }],
  ['T2 unreadable destination authority', () => {
    const destination = snapshot('OLD'); destination.access = { broken: true };
    return { destination, backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(get(after, 'g').state, 'suspended'); assert.equal(get(after, 'g').suspendedReason, 'no_destination_authority_state'); } };
  }],
  ['T3 unrelated destination never gains backup authority', () => ({ destination: snapshot('OLD', [], { lineage: 'other' }), backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(get(after, 'g').suspendedReason, 'absent_from_destination'); } })],
  ['T3a destination revocation wins', () => ({ destination: snapshot('OLD', [entry('g', { state: 'revoked', revokedAt: CREATED, terminalReason: 'revoked' })]), backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(get(after, 'g').state, 'revoked'); assert.ok(after.accessRevocations.entries.some(value => value.accessId === 'g')); } })],
  ['T4 terminal backup entries survive without destination authority', () => ({ destination: snapshot('OLD', [], { access: false }), backup: snapshot('NEW', [entry('g', { state: 'discarded', terminalReason: 'discarded' })]), check(after) { assert.equal(get(after, 'g').state, 'discarded'); assert.ok(after.accessRevocations.entries.some(value => value.accessId === 'g' && value.terminalReason === 'discarded')); } })],
  ['T6 discard and destination-only terminal restrictions survive', () => ({ destination: snapshot('OLD', [entry('g', { state: 'discarded', terminalReason: 'discarded' }), entry('only-d', { state: 'revoked', revokedAt: CREATED, terminalReason: 'revoked' })]), backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(get(after, 'g').state, 'discarded'); assert.equal(get(after, 'only-d').state, 'revoked'); } })],
  ['T8 delegation budget never refunds', () => ({ destination: snapshot('OLD', [entry('d', { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 7 })]), backup: snapshot('NEW', [entry('d', { type: 'delegation', issuanceLimit: 20, issuanceConsumed: 0 })]), check(after) { assert.equal(get(after, 'd').issuanceConsumed, 7); assert.equal(get(after, 'd').issuanceLimit, 10); assert.equal(validateAccess(after, 'd', { now: NOW, surface: 'cli', operation: 'issue' }).ok, true); } })],
  ['spent delegation budget does not revoke its previously issued grant', () => { const d = entry('d', { type: 'delegation', state: 'exhausted', issuanceLimit: 1, issuanceConsumed: 1 }), g = entry('g', { issuedBy: 'delegation:d' }); return { destination: snapshot('OLD', [d, g]), backup: snapshot('NEW', [entry('d', { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 0 }), g]), check(after) { assert.equal(get(after, 'd').state, 'exhausted'); assert.equal(validateAccess(after, 'd', { now: NOW, operation: 'issue' }).ok, false); assert.equal(validateAccess(after, 'g', { now: NOW }).ok, true); } }; }],
  ['missing issuance witness cannot be repaired into usable authority', () => { const destination = snapshot('OLD', [entry('g')]); destination.events = destination.events.filter(value => value.type !== 'access.issued'); return { destination, backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(get(after, 'g').state, 'suspended'); assert.ok(after.events.some(value => value.id === 'issued-g')); } }; }],
  ['missing issuance witness id cannot be filled from backup', () => { const destination = snapshot('OLD', [entry('g')]); delete get(destination, 'g').issuanceEventId; return { destination, backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(get(after, 'g').state, 'suspended'); } }; }],
  ['delegation relationship repair cannot activate derived grant', () => { const g = entry('g', { issuedBy: 'delegation:d' }); return { destination: snapshot('OLD', [g]), backup: snapshot('NEW', [entry('d', { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 1 }), g]), check(after) { assert.equal(get(after, 'g').state, 'suspended'); assert.equal(get(after, 'd').state, 'suspended'); } }; }],
  ['request identity cannot become grant', () => ({ destination: snapshot('OLD', [entry('g', { type: 'request', state: 'requested' })]), backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(validateAccess(after, 'g', { now: NOW, surface: 'cli' }).ok, false); } })],
  ['orphan tombstone narrows backup authority', () => { const destination = snapshot('OLD', [entry('g')]); destination.accessRevocations.entries.push({ accessId: 'g', revokedAt: CREATED, terminalReason: 'revoked', eventId: 'lost-revocation' }); return { destination, backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(get(after, 'g').state, 'revoked'); } }; }],
  ['earliest suspension and disjoint owner restrictions survive', () => ({ destination: snapshot('OLD', [entry('g', { state: 'suspended', suspendedAt: CREATED, suspendedReason: 'already_suspended', scope: { projects: ['default'], originIds: ['origin-a'], legacyAttributions: ['legacy_ambiguous'] } })]), backup: snapshot('NEW', [entry('g', { suspendedAt: NOW, suspendedReason: 'newer', scope: { projects: ['default', 'origin-a'], originIds: ['origin-a'], legacyAttributions: ['legacy_ambiguous', 'legacy_unattributed'] } })]), check(after) { assert.equal(get(after, 'g').suspendedAt, CREATED); assert.equal(get(after, 'g').suspendedReason, 'already_suspended'); assert.deepEqual(get(after, 'g').scope, { projects: ['default'], originIds: ['origin-a'], legacyAttributions: ['legacy_ambiguous'] }); } })],
  ['expired and exhausted authority cannot be reset by active backup', () => ({ destination: snapshot('OLD', [entry('g', { state: 'expired' }), entry('d', { type: 'delegation', state: 'exhausted', issuanceLimit: 3, issuanceConsumed: 3 })]), backup: snapshot('NEW', [entry('g'), entry('d', { type: 'delegation', issuanceLimit: 8, issuanceConsumed: 0 })]), check(after) { assert.equal(get(after, 'g').state, 'expired'); assert.equal(get(after, 'd').state, 'exhausted'); assert.equal(get(after, 'd').issuanceConsumed, 3); assert.equal(get(after, 'd').issuanceLimit, 3); } })],
  ['backup cannot repair missing destination revocation state', () => { const destination = snapshot('OLD', [entry('g')]); delete destination.accessRevocations; return { destination, backup: snapshot('NEW', [entry('g')]), check(after) { assert.equal(get(after, 'g').state, 'suspended'); } }; }],
  ['T-E requests restore as requests without authority', () => ({ destination: snapshot('OLD', [], { access: false }), backup: snapshot('NEW', [entry('r', { type: 'request', state: 'requested' })]), check(after) { assert.equal(get(after, 'r').type, 'request'); assert.equal(get(after, 'r').state, 'requested'); assert.equal(validateAccess(after, 'r', { now: NOW, surface: 'cli' }).ok, false); } })],
  ['T-FORK equal-sequence stale fork retains only already-usable authority', () => ({ destination: snapshot('OLD', [entry('g')], { seq: 10 }), backup: snapshot('NEW', [entry('g')], { seq: 10 }), check(after) { assert.equal(validateAccess(after, 'g', { now: NOW, surface: 'cli' }).ok, true); assert.equal(after.accessRevocations.ledgerSeq, 10); } })],
  ['T-FORK-ADV higher sequence cannot activate backup-only authority', () => ({ destination: snapshot('OLD', [entry('g')], { seq: 12 }), backup: snapshot('NEW', [entry('g'), entry('backup-only')], { seq: 10 }), check(after) { assert.equal(validateAccess(after, 'g', { now: NOW, surface: 'cli' }).ok, true); assert.equal(get(after, 'backup-only').state, 'suspended'); assert.equal(after.accessRevocations.ledgerSeq, 12); assert.ok(after.events.find(value => value.type === 'access.restored').anomalies.some(value => value.code === 'authority_ledger_sequence_difference')); } })],
  ['diagnostic issuedInLineage differences do not decide permission', () => ({ destination: snapshot('OLD', [entry('g', { issuedInLineage: 'destination-diagnostic' })], { lineage: 'destination', seq: 2 }), backup: snapshot('NEW', [entry('g', { issuedInLineage: 'backup-diagnostic' })], { lineage: 'backup', seq: 20 }), check(after) { assert.equal(get(after, 'g').issuedInLineage, 'destination-diagnostic'); assert.equal(validateAccess(after, 'g', { now: NOW, surface: 'cli' }).ok, true); assert.equal(after.accessRevocations.ledgerSeq, 20); assert.ok(after.events.find(value => value.type === 'access.restored').anomalies.some(value => value.code === 'authority_lineage_mismatch')); } })],
  ['T2 absent destination authority blocks grants and delegations', () => ({ destination: snapshot('OLD', [], { access: false }), backup: snapshot('NEW', [entry('g'), entry('d', { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 0 })]), check(after) { for (const id of ['g', 'd']) { assert.equal(get(after, id).state, 'suspended'); assert.equal(get(after, id).suspendedReason, 'no_destination_authority_state'); } } })],
  ['T4 backup-only revoked entry retains terminal reason and tombstone', () => ({ destination: snapshot('OLD'), backup: snapshot('NEW', [entry('g', { state: 'revoked', revokedAt: CREATED, terminalReason: 'revoked' })]), check(after) { assert.equal(get(after, 'g').state, 'revoked'); assert.equal(get(after, 'g').terminalReason, 'revoked'); assert.ok(after.accessRevocations.entries.some(value => value.accessId === 'g' && value.terminalReason === 'revoked')); } })],
  ['destination-only unusable grant remains blocked when backup repairs its witness', () => { const destination = snapshot('OLD', [entry('g')]), backup = snapshot('NEW'); backup.events.push(witness(entry('g'))); destination.events = destination.events.filter(value => value.type !== 'access.issued'); return { destination, backup, check(after) { assert.equal(get(after, 'g').state, 'suspended'); assert.ok(after.events.some(value => value.id === 'issued-g')); } }; }],
  ['revoked delegation tombstone cascades through destination-only derived grants', () => { const d = entry('d', { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 1 }), g = entry('g', { issuedBy: 'delegation:d' }); const destination = snapshot('OLD', [d, g]), backup = snapshot('NEW'); backup.accessRevocations.entries.push({ accessId: 'd', revokedAt: CREATED, terminalReason: 'revoked', eventId: 'revoke-d' }); return { destination, backup, check(after) { assert.equal(get(after, 'd').state, 'revoked'); assert.equal(get(after, 'g').state, 'revoked'); assert.ok(after.accessRevocations.entries.some(value => value.accessId === 'g' && value.cascadedFrom === 'd')); } }; }],
  ['destination-only usable authority retains its required audit evidence', () => { const destination = snapshot('OLD', [entry('g'), entry('gone', { state: 'revoked', terminalReason: 'revoked', revokedAt: CREATED })]); destination.accessRevocations.entries.push({ accessId: 'gone', revokedAt: CREATED, eventId: 'revoke-gone', terminalReason: 'revoked' }); destination.events.push({ id: 'revoke-gone', type: 'access.revoked', at: CREATED, accessId: 'gone' }); return { destination, backup: snapshot('NEW'), check(after) { assert.equal(validateAccess(after, 'g', { now: NOW, surface: 'cli' }).ok, true); assert.ok(after.events.some(value => value.id === 'issued-g')); assert.ok(after.events.some(value => value.id === 'revoke-gone')); } }; }],
  ['conflicting backup witness identity blocks authority without losing memory', () => { const destination = snapshot('OLD', [entry('g')]), backup = snapshot('NEW', [entry('g')]); backup.events.find(value => value.id === 'issued-g').reason = 'conflicting audit payload'; return { destination, backup, check(after) { assert.equal(get(after, 'g').state, 'suspended'); assert.equal(get(after, 'g').suspendedReason, 'authority_audit_identity_conflict'); assert.equal(after.events.find(value => value.id === 'issued-g').reason, 'conflicting audit payload'); assert.ok(after.events.find(value => value.type === 'access.restored').anomalies.some(value => value.code === 'authority_audit_identity_conflict')); } }; }]
];

test('PR12 authority merge is available and leaves no-authority payloads unchanged', () => {
  ready(); const backup = snapshot('NEW', [], { access: false });
  assert.deepEqual(mergeAuthorityRestore(backup, snapshot('OLD', [], { access: false }), { now: NOW }), backup);
});

for (const [name, fixture] of cases) test(`R16 pure: ${name}`, () => {
  ready(); const { backup, destination, check } = fixture(); const before = structuredClone({ backup, destination });
  const after = mergeAuthorityRestore(backup, destination, { now: NOW }); check(after); subset(after, destination);
  assert.deepEqual({ backup, destination }, before, 'pure merge must not mutate either input');
  assert.deepEqual(after.records, backup.records); assert.deepEqual(after.journal, backup.journal); assert.deepEqual(after.futureCollection, backup.futureCollection);
  assert.equal(after.events.filter(value => value.type === 'access.restored').length, 1);
});

test('T5/T12 repeated and chained restore retains every safety field and suspension', () => {
  ready(); const backup = snapshot('NEW', [entry('g')]);
  const once = mergeAuthorityRestore(backup, snapshot('OLD', [], { access: false }), { now: NOW });
  const twice = mergeAuthorityRestore(backup, once, { now: '2026-09-27T12:00:00.000Z' });
  assert.deepEqual(get(twice, 'g'), get(once, 'g'));
  const chained = mergeAuthorityRestore(snapshot('OTHER', [entry('g', { scope: scope('alpha', 'beta', 'gamma'), expiresAt: '2027-01-01T00:00:00.000Z' })]), twice, { now: NOW });
  subset(chained, twice); assert.equal(get(chained, 'g').state, 'suspended');
});

test('restored terminal authority equals the authority activated by ledger reconciliation', () => {
  ready(); const backup = snapshot('NEW', [entry('g', { state: 'discarded', terminalReason: 'discarded' })]);
  const after = mergeAuthorityRestore(backup, snapshot('OLD'), { now: NOW });
  assert.deepEqual(after.access, reconcileAccessLedger(after.access, after.accessRevocations));
});

test('usage aggregates retain maxima and mark the restored boundary', () => {
  ready(); const destination = snapshot('OLD', [entry('g')]), backup = snapshot('NEW', [entry('g')]);
  const aggregate = { id: 'used', type: 'access.used', accessId: 'g', surface: 'cli', day: '2026-09-26', count: 2, recordsReturnedTotal: 3, firstAt: '2026-09-26T01:00:00.000Z', lastAt: '2026-09-26T02:00:00.000Z', precision: 'exact_within_lineage' };
  backup.events.push(aggregate); destination.events.push({ ...aggregate, count: 9, recordsReturnedTotal: 12, lastAt: '2026-09-26T03:00:00.000Z' });
  const result = mergeAuthorityRestore(backup, destination, { now: NOW }); const used = result.events.find(value => value.id === 'used');
  assert.equal(used.count, 9); assert.equal(used.recordsReturnedTotal, 12); assert.equal(used.lastAt, '2026-09-26T03:00:00.000Z'); assert.equal(used.boundary, 'restored');
  assert.equal(used.precision, 'lower_bound_restored');
});

test('case E restores an existing request as backup data rather than merging it as authority', () => {
  ready(); const destination = snapshot('OLD', [entry('r', { type: 'request', state: 'requested', reason: 'old proposal' })]);
  const backup = snapshot('NEW', [entry('r', { type: 'request', state: 'requested', reason: 'restored proposal', scope: scope('gamma') })]);
  const result = mergeAuthorityRestore(backup, destination, { now: NOW });
  assert.equal(get(result, 'r').reason, 'restored proposal'); assert.deepEqual(get(result, 'r').scope, scope('gamma'));
});

test('duplicate identities retain a terminal restriction even when it is not the first entry', () => {
  ready(); const destination = snapshot('OLD', [entry('g'), entry('g', { state: 'discarded', terminalReason: 'discarded' })]);
  const result = mergeAuthorityRestore(snapshot('NEW', [entry('g')]), destination, { now: NOW });
  assert.equal(get(result, 'g').state, 'discarded'); assert.ok(result.accessRevocations.entries.some(item => item.accessId === 'g' && item.terminalReason === 'discarded'));
});

test('bounded audit overflow aggregates retain each counter without duplicate events', () => {
  ready(); const backup = snapshot('NEW', [entry('g')]), destination = snapshot('OLD', [entry('g')]);
  const overflow = { id: 'overflow', type: 'access.audit_overflow', aggregateKey: 'overflow:2026-09-26', window: '2026-09-26', count: 3, usedCount: 1, refusedCount: 2, recordsReturnedTotal: 4, firstAt: CREATED, lastAt: CREATED, precision: 'aggregate_overflow', samples: [] };
  backup.events.push(overflow); destination.events.push({ ...overflow, count: 9, usedCount: 6, refusedCount: 3, recordsReturnedTotal: 20, lastAt: NOW });
  const result = mergeAuthorityRestore(backup, destination, { now: NOW });
  const merged = result.events.filter(event => event.type === 'access.audit_overflow');
  assert.equal(merged.length, 1); assert.equal(merged[0].count, 9); assert.equal(merged[0].usedCount, 6); assert.equal(merged[0].refusedCount, 3); assert.equal(merged[0].recordsReturnedTotal, 20); assert.equal(merged[0].lastAt, NOW); assert.equal(merged[0].boundary, 'restored');
  assert.equal(merged[0].precision, 'lower_bound_restored');
});

async function persistedPair(t, backend, backup, destination) {
  validateRestorePayload(backup); validateRestorePayload(destination);
  const directory = await scratchDirectory(t, 'pr12-authority-'); const source = join(directory, `source.${backend === 'sqlite' ? 'db' : 'json'}`); const saved = join(directory, `backup.${backend === 'sqlite' ? 'db' : 'json'}`); const target = join(directory, `target.${backend === 'sqlite' ? 'db' : 'json'}`);
  let load, saveDestination, saveBackup, restore;
  if (backend === 'sqlite') {
    try { await import('node:sqlite'); } catch { t.skip(NODE_SQLITE_NOT_APPLICABLE_REASON); return null; }
    const original = await createSqliteStore(source); t.after(() => original.close());
    const store = await createSqliteStore(target); t.after(() => store.close());
    load = () => store.load();
    saveDestination = async payload => store.save({ ...payload, revision: (await store.load()).revision });
    saveBackup = async payload => { await original.save({ ...payload, revision: (await original.load()).revision }); await original.backup(saved); };
    restore = options => store.restore(saved, { now: NOW, ...options });
  } else {
    load = async () => JSON.parse(await readFile(target));
    saveDestination = payload => writeFile(target, JSON.stringify(payload));
    saveBackup = async payload => { await writeFile(source, JSON.stringify(payload)); await backupFile(source, saved); };
    restore = options => restoreFile(saved, target, { now: NOW, ...options });
  }
  await saveBackup(backup); await saveDestination(destination);
  return { load, saveDestination, saveBackup, restore, saved, target };
}

function memoryRecovered(after, backup) {
  for (const key of Object.keys(backup).filter(key => !['access', 'accessRevocations', 'events', 'revision'].includes(key))) assert.deepEqual(after[key], backup[key], key);
  for (const event of backup.events.filter(value => !['access.used', 'access.refused', 'access.audit_overflow'].includes(value.type))) assert.ok(after.events.some(value => JSON.stringify(value) === JSON.stringify(event)), `memory event ${event.id} must recover`);
}

for (const backend of ['json', 'sqlite']) for (const [name, fixture] of cases) test(`R16 ${backend}: ${name}`, async t => {
  ready(); const { backup, destination, check } = fixture();
  const pair = await persistedPair(t, backend, backup, destination); if (!pair) return;
  const beforeBytes = await readFile(pair.saved); let activated;
  await pair.restore({ afterReplace: payload => { const graph = createShadowGraph({ now: () => NOW }); graph.importData(payload); activated = privilegedSnapshot(graph); } });
  const after = await pair.load();
  check(after); subset(after, destination); assert.deepEqual(activated, after);
  memoryRecovered(after, backup); assert.deepEqual(await readFile(pair.saved), beforeBytes);
  assert.equal(after.events.filter(value => value.type === 'access.restored').length, 1);
});

for (const backend of ['json', 'sqlite']) {
  test(`R16 ${backend}: T1 usage, refusal and overflow aggregates merge as restored lower bounds`, async t => {
    ready(); const backup = snapshot('NEW', [entry('g')]), destination = snapshot('OLD', [entry('g')]);
    for (const type of ['access.used', 'access.refused', 'access.audit_overflow']) {
      const event = { id: type, type, accessId: 'g', surface: 'cli', reason: type === 'access.refused' ? 'grant_expired' : null, aggregateKey: type === 'access.audit_overflow' ? 'overflow:2026-09-26' : JSON.stringify([type, 'g', 'cli', null, '2026-09-26']), window: '2026-09-26', count: 3, recordsReturnedTotal: 20, firstAt: '2026-09-26T01:00:00.000Z', lastAt: '2026-09-26T03:00:00.000Z', samples: [], precision: 'exact_within_lineage', ...(type === 'access.audit_overflow' ? { usedCount: 1, refusedCount: 2 } : {}) };
      backup.events.push(event); destination.events.push({ ...event, count: 8, recordsReturnedTotal: 5, firstAt: '2026-09-26T00:00:00.000Z', lastAt: '2026-09-26T02:00:00.000Z', ...(type === 'access.audit_overflow' ? { usedCount: 7, refusedCount: 1 } : {}) });
    }
    const pair = await persistedPair(t, backend, backup, destination); if (!pair) return;
    await pair.restore(); const after = await pair.load(); subset(after, destination); memoryRecovered(after, backup);
    for (const type of ['access.used', 'access.refused', 'access.audit_overflow']) {
      const events = after.events.filter(event => event.type === type); assert.equal(events.length, 1); const [event] = events;
      assert.equal(event.count, 8); assert.equal(event.recordsReturnedTotal, 20); assert.equal(event.firstAt, '2026-09-26T00:00:00.000Z'); assert.equal(event.lastAt, '2026-09-26T03:00:00.000Z'); assert.equal(event.precision, 'lower_bound_restored'); assert.equal(event.boundary, 'restored'); assert.ok(event.restoreEventId);
      if (type === 'access.audit_overflow') { assert.equal(event.usedCount, 7); assert.equal(event.refusedCount, 2); }
    }
  });

  test(`R16 ${backend}: T5 T6 T10 repeated, discarded and chained restore never reactivates`, async t => {
    ready(); const backup = snapshot('NEW', [entry('g'), entry('d', { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 0 })]);
    const pair = await persistedPair(t, backend, backup, snapshot('OLD', [], { access: false })); if (!pair) return;
    await pair.restore(); const once = await pair.load();
    await pair.restore({ now: '2026-09-27T12:00:00.000Z' }); const twice = await pair.load();
    assert.deepEqual(twice.access, once.access); assert.deepEqual(twice.accessRevocations, once.accessRevocations); subset(twice, once); memoryRecovered(twice, backup);
    const discarded = structuredClone(twice); get(discarded, 'g').state = 'discarded'; get(discarded, 'g').terminalReason = 'discarded';
    discarded.accessRevocations.entries.push({ accessId: 'g', revokedAt: NOW, eventId: null, cascadedFrom: null, terminalReason: 'discarded' });
    discarded.accessRevocations.ledgerSeq += 1;
    await pair.saveDestination(discarded); await pair.restore(); const afterDiscard = await pair.load();
    assert.equal(get(afterDiscard, 'g').state, 'discarded'); assert.equal(get(afterDiscard, 'g').terminalReason, 'discarded'); subset(afterDiscard, discarded); memoryRecovered(afterDiscard, backup);
    const wider = snapshot('CHAIN', [entry('g', { scope: scope('alpha', 'beta', 'gamma'), expiresAt: '2027-01-01T00:00:00.000Z' }), entry('d', { type: 'delegation', issuanceLimit: 100, issuanceConsumed: 0 })]);
    await pair.saveBackup(wider); await pair.restore(); const chained = await pair.load();
    assert.equal(get(chained, 'g').state, 'discarded'); assert.equal(get(chained, 'd').state, 'suspended'); assert.equal(get(chained, 'd').issuanceLimit, 10); subset(chained, afterDiscard); memoryRecovered(chained, wider);
  });

  test(`R16 ${backend}: authority and tombstones survive activation failure rollback`, async t => {
    ready(); const destination = snapshot('OLD', [entry('g', { state: 'discarded', terminalReason: 'discarded' })]);
    destination.accessRevocations.entries.push({ accessId: 'orphan', revokedAt: CREATED, terminalReason: 'revoked', eventId: 'orphan-event' });
    const pair = await persistedPair(t, backend, snapshot('NEW', [entry('g')]), destination); if (!pair) return;
    const before = await pair.load(); const sourceBytes = await readFile(pair.saved); const destinationBytes = await readFile(pair.target);
    await assert.rejects(pair.restore({ afterReplace() { throw new Error('activation refused'); } }), /activation refused/);
    assert.deepEqual(await pair.load(), before); assert.deepEqual(await readFile(pair.saved), sourceBytes);
    if (backend === 'json') assert.deepEqual(await readFile(pair.target), destinationBytes);
  });

  test(`R16 ${backend}: T9 ordinary restore never installs backup authority verbatim and memory-only strips it`, async t => {
    ready(); const backup = snapshot('NEW', [entry('g')]), destination = snapshot('OLD');
    const pair = await persistedPair(t, backend, backup, destination); if (!pair) return;
    await pair.restore(); const ordinary = await pair.load();
    assert.equal(get(ordinary, 'g').state, 'suspended'); assert.notDeepEqual(ordinary.access, backup.access); subset(ordinary, destination); memoryRecovered(ordinary, backup);
    await pair.restore({ memoryOnly: true }); const after = await pair.load();
    assert.equal(Object.hasOwn(after, 'access'), false); assert.equal(Object.hasOwn(after, 'accessRevocations'), false); memoryRecovered(after, backup);
  });
}

function propertyFixture() {
  const states = ['requested', 'active', 'expired', 'exhausted', 'suspended', 'discarded', 'revoked'];
  const destination = snapshot('OLD'), backup = snapshot('NEW');
  const add = (id, left = {}, right = {}) => {
    const d = JSON.parse(JSON.stringify(entry(id, left))), b = JSON.parse(JSON.stringify(entry(id, right)));
    destination.access.entries.push(d); backup.access.entries.push(b);
    destination.events.push({ ...witness(d), id: `issued-${id}`, expiresAt: EXPIRES }); backup.events.push(witness(b));
  };
  for (const type of ['grant', 'delegation']) for (const d of states) for (const b of states) {
    const bounds = { type, ...(type === 'delegation' ? { issuanceLimit: 10, issuanceConsumed: 3 } : {}) };
    add(`${type}-${d}-${b}`, { ...bounds, state: d }, { ...bounds, state: b });
  }
  add('narrow-bounds', { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 7, scope: { projects: ['alpha', 'default'], originIds: ['same-name'], legacyAttributions: ['legacy_ambiguous'] } }, { type: 'delegation', issuanceLimit: 8, issuanceConsumed: 2, expiresAt: '2026-10-01T00:00:00.000Z', surfaces: ['cli'], scope: { projects: ['alpha', 'same-name'], originIds: ['same-name'], legacyAttributions: ['legacy_unattributed'] } });
  add('offset-times', { state: 'suspended', suspendedAt: '2026-09-01T01:00:00+02:00', suspendedReason: 'earlier' }, { suspendedAt: '2026-09-01T00:00:00Z', suspendedReason: 'later' });
  for (const [name, fields] of Object.entries({ missingExpiry: { expiresAt: undefined }, invalidExpiry: { expiresAt: 'invalid' }, invalidRevocation: { revokedAt: 'invalid' }, invalidSuspension: { suspendedAt: 'invalid' }, futureCreated: { createdAt: '2027-01-01T00:00:00.000Z' }, missingWitness: { issuanceEventId: undefined }, invalidScope: { scope: { projects: ['alpha'], unexpected: true } }, invalidSurfaces: { surfaces: ['cli', 'unknown'] } })) add(name, fields);
  for (const [name, fields] of Object.entries({ negativeConsumed: { issuanceConsumed: -1 }, missingConsumed: { issuanceConsumed: undefined }, missingLimit: { issuanceLimit: undefined }, zeroLimit: { issuanceLimit: 0 } })) add(name, { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 0, ...fields }, { type: 'delegation', issuanceLimit: 10, issuanceConsumed: 0 });
  return { destination, backup, check(after) {
    subset(after, destination);
    for (const d of destination.access.entries) {
      const b = get(backup, d.accessId), a = get(after, d.accessId);
      assert.ok(states.indexOf(a.state) >= states.indexOf(d.state), `${d.accessId} state widened`);
      if (Number.isFinite(Date.parse(d.expiresAt)) && Number.isFinite(Date.parse(b.expiresAt))) assert.ok(Date.parse(a.expiresAt) <= Math.min(Date.parse(d.expiresAt), Date.parse(b.expiresAt)), `${d.accessId} expiry widened`);
      if (d.revokedAt != null) assert.notEqual(a.revokedAt, null);
      if (d.suspendedAt != null) assert.notEqual(a.suspendedAt, null);
      for (const key of ['projects', 'originIds', 'legacyAttributions']) for (const selector of a.scope[key]) assert.ok((d.scope[key] ?? []).includes(selector), `${d.accessId} scope widened`);
      for (const surface of a.surfaces) assert.ok(d.surfaces.includes(surface), `${d.accessId} surfaces widened`);
      if (d.type === 'delegation' && Number.isSafeInteger(d.issuanceLimit) && d.issuanceLimit >= 1 && Number.isSafeInteger(d.issuanceConsumed) && d.issuanceConsumed >= 0) {
        assert.ok(a.issuanceLimit <= d.issuanceLimit, `${d.accessId} limit widened`); assert.ok(a.issuanceConsumed >= d.issuanceConsumed, `${d.accessId} consumption refunded`);
      }
    }
    assert.equal(get(after, 'narrow-bounds').issuanceConsumed, 7); assert.equal(get(after, 'narrow-bounds').issuanceLimit, 8);
    assert.deepEqual(get(after, 'narrow-bounds').scope, { projects: ['alpha'], originIds: ['same-name'], legacyAttributions: [] });
    assert.equal(get(after, 'offset-times').suspendedAt, '2026-09-01T01:00:00+02:00'); assert.equal(get(after, 'offset-times').suspendedReason, 'earlier');
  } };
}

for (const backend of ['pure', 'json', 'sqlite']) test(`R16 ${backend}: T12 state cross-product and malformed-field actual-usability property`, async t => {
  ready(); const { backup, destination, check } = propertyFixture();
  let after;
  if (backend === 'pure') after = mergeAuthorityRestore(backup, destination, { now: NOW });
  else {
    const pair = await persistedPair(t, backend, backup, destination); if (!pair) return;
    await pair.restore(); after = await pair.load(); memoryRecovered(after, backup);
  }
  check(after);
});
