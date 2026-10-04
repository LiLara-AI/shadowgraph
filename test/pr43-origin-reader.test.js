import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedLiveSnapshot, privilegedRecordCapture } from '../src/internal/snapshot.js';
import { withFallbackMisses } from '../src/internal/miss-ledger.js';
import { rebuildProjection, schema5PurgeArtifactIssue, hardPurgeGapLedgerReport, journalFactLifecycleIssues } from '../src/journal.js';
import { attachLedgerView, ledgerPath, readLedger, markerMatches, restoreRecordValid, originRestorePending } from '../src/internal/deletion-knowledge.js';
import { createStorage } from '../src/storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-10-04T00:00:00.000Z';
const now = () => NOW;
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
test('origin recovery guard accepts omitted ordinary tombstones and still checks added origin knowledge', () => {
  assert.equal(originRestorePending({ kind: 'restore', add: { tombstones: [] } }), false);
  assert.equal(originRestorePending({ kind: 'restore', add: { tombstones: [{ kind: 'origin' }] } }), true);
  assert.equal(originRestorePending({ kind: 'restore', add: { tombstones: [{ kind: 'project' }] } }), false);
});

test('origin deletion skeleton reader accepts its explicit reason without carrying identity', () => {
  const skeleton = { id: 'synthetic-origin-skeleton', seq: 1, type: 'decision.recorded', at: NOW,
    project: null, entityKind: 'decision', entityId: null, schemaVersion: 7, payload: null,
    redacted: true, redactedReason: 'origin_purged', provenance: { actor: null, client: null, sessionId: null } };
  assert.equal(schema5PurgeArtifactIssue(skeleton, 7), null);
  assert.equal(rebuildProjection([skeleton], { journalEpoch: 1, sourceSchemaVersion: 7 }).rebuildable, true);
  for (const changed of [{ ...skeleton, entityId: 'private' }, { ...skeleton, originId: 'private' },
    { ...skeleton, redactedReason: 'origin_purged_typo' }]) assert.notEqual(schema5PurgeArtifactIssue(changed, 7), null);
});
function fixture() {
  const graph = createShadowGraph({ now });
  graph.addDecision({ originId: 'origin-a', title: 'Remove', chosen: 'Remove', idempotencyKey: 'origin-retry' });
  graph.addFact({ originId: 'origin-a', key: 'latency', value: 1 });
  graph.addDecision({ project: 'p', originId: 'origin-a', title: 'Keep project', chosen: 'Keep' });
  graph.addFact({ project: 'p', originId: 'origin-a', key: 'latency', value: 2 });
  graph.addDecision({ originId: 'origin-b', title: 'Keep other origin', chosen: 'Keep' });
  const snapshot = privilegedSnapshot(graph);
  const marker = { id: 'synthetic-origin-purge-marker', seq: snapshot.journalSeq + 1, type: 'origin.purged', at: NOW,
    project: null, entityKind: 'origin', entityId: null, schemaVersion: 7,
    payload: { originId: 'origin-a', mode: 'logical', removed: 2, removedJournalSequences: [] }, provenance: { actor: null, client: null, sessionId: null } };
  return { snapshot, marker };
}
test('origin marker reader folds only unattributed ownership and keeps project provenance peers', () => {
  const { snapshot, marker } = fixture();
  assert.equal(schema5PurgeArtifactIssue(marker, 7), null);
  const report = rebuildProjection([...snapshot.journal, marker], { journalEpoch: snapshot.journalEpoch, sourceSchemaVersion: 7 });
  assert.equal(report.rebuildable, true, report.reason);
  assert.deepEqual(report.skipped, []);
  for (const collection of ['records', 'facts']) assert.deepEqual(report.projection[collection].map(x => x.id).sort(), snapshot[collection].filter(x => x.attribution !== 'unattributed' || x.originId !== 'origin-a').map(x => x.id).sort());
  assert.deepEqual(report.projection.idempotency, []);
  const tombstone = { kind: 'origin', purgedOrigin: 'origin-a', at: NOW, seq: marker.seq, tokens: [], mode: 'logical' };
  assert.equal(markerMatches(tombstone, marker), true);
  assert.equal(markerMatches({ ...tombstone, kind: 'project', purgedProject: 'origin-a' }, marker), false);
  assert.equal(markerMatches({ ...tombstone, purgedOrigin: 'origin-b' }, marker), false);
});

test('origin markers have a closed scope shape and exact hard-gap proof', () => {
  const { snapshot, marker } = fixture();
  for (const changed of [
    { ...marker, project: 'p' }, { ...marker, entityKind: 'project' },
    { ...marker, payload: { ...marker.payload, originId: '' } },
    { ...marker, payload: { ...marker.payload, project: 'p' } },
    { ...marker, payload: { ...marker.payload, rawEntityIds: ['private'] } }
  ]) assert.notEqual(schema5PurgeArtifactIssue(changed, 7), null);
  const selected = snapshot.journal.filter(x => x.payload?.attribution === 'unattributed' && x.payload.originId === 'origin-a');
  const hard = { ...marker, payload: { ...marker.payload, mode: 'hard', removedJournalSequences: selected.map(x => x.seq) } };
  const remaining = snapshot.journal.filter(x => !selected.includes(x));
  assert.equal(hardPurgeGapLedgerReport([...remaining, hard], { journalEpoch: snapshot.journalEpoch }).valid, true);
  assert.equal(hardPurgeGapLedgerReport([...remaining, { ...hard, payload: { ...hard.payload, removedJournalSequences: [] } }], { journalEpoch: snapshot.journalEpoch }).valid, false);
});

test('origin markers never inherit legacy project raw-identity exceptions', () => {
  const { snapshot, marker } = fixture();
  const peer = snapshot.records.find(x => x.project === 'p');
  for (const version of [undefined, 1, 2, 3, 4, 5, 6, 7]) {
    const changed = { ...marker, schemaVersion: version, payload: { ...marker.payload, purgedEntityIds: [peer.id] } };
    assert.notEqual(schema5PurgeArtifactIssue(changed, version), null);
    const report = rebuildProjection([...snapshot.journal, changed], { journalEpoch: snapshot.journalEpoch, sourceSchemaVersion: version });
    assert.equal(report.rebuildable, false);
    assert.ok(report.projection.records.some(x => x.id === peer.id));
  }
});

test('origin marker schema labels never select unrelated null-project relations', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ originId: 'origin-a', title: 'Remove', chosen: 'Remove' });
  const b = graph.addDecision({ originId: 'origin-b', title: 'B', chosen: 'Keep' });
  const c = graph.addDecision({ originId: 'origin-b', title: 'C', chosen: 'Keep' });
  const relation = graph.link({ originId: 'origin-b', from: b.id, to: c.id, relation: 'depends_on' });
  const snapshot = privilegedSnapshot(graph);
  for (const schemaVersion of [undefined, 1, 2, 3, 4, 5, 6, 7]) {
    const marker = { ...fixture().marker, schemaVersion, seq: snapshot.journalSeq + 1 };
    const report = rebuildProjection([...snapshot.journal, marker], { journalEpoch: snapshot.journalEpoch, sourceSchemaVersion: 7 });
    assert.equal(report.rebuildable, true, report.reason);
    assert.deepEqual(report.skipped, []);
    assert.deepEqual(report.projection.relations, snapshot.relations);
    assert.ok(report.projection.relations.some(x => x.id === relation.id));
  }
});

test('fact lifecycle origin selection follows explicit attribution and preserves other owners', () => {
  const { snapshot, marker } = fixture();
  const first = snapshot.journal.find(x => x.type === 'fact.observed' && x.payload.attribution === 'unattributed');
  const moved = { ...structuredClone(first), id: 'synthetic-attribution', seq: marker.seq, type: 'entity.attributed',
    payload: { ...first.payload, originId: 'origin-b', attributionChange: { previousProject: null, previousAttribution: 'unattributed', reason: 'Explicit synthetic move' } } };
  const purge = { ...marker, seq: marker.seq + 1, payload: { ...marker.payload, originId: 'origin-b' } };
  const later = { ...structuredClone(first), id: 'synthetic-later-observation', seq: marker.seq + 2, payload: { ...first.payload, originId: 'origin-b' } };
  assert.deepEqual(journalFactLifecycleIssues([...snapshot.journal, moved, purge, later], { journalEpoch: snapshot.journalEpoch, sourceSchemaVersion: 7 }), []);
  const wrongScope = { ...purge, payload: { ...purge.payload, originId: 'origin-a' } };
  assert.ok(journalFactLifecycleIssues([...snapshot.journal, moved, wrongScope, later], { journalEpoch: snapshot.journalEpoch, sourceSchemaVersion: 7 }).length > 0);
});

test('recognized origin tombstones validate scope and time without rewriting unknown members', async t => {
  const dir = await scratchDirectory(t, 'pr43-origin-reader-'), path = ledgerPath(join(dir, 'store.json'));
  const valid = { version: 1, tombstones: [{ kind: 'origin', purgedOrigin: 'origin-a', at: NOW, tokens: [], future: { preserved: true } }] };
  await writeFile(path, JSON.stringify(valid)); const before = await readFile(path);
  assert.equal((await readLedger(join(dir, 'store.json'))).tombstones[0].future.preserved, true);
  assert.deepEqual(await readFile(path), before);
  for (const change of [{ purgedOrigin: '' }, { at: 'not-an-instant' }]) {
    await writeFile(path, JSON.stringify({ ...valid, tombstones: [{ ...valid.tombstones[0], ...change }] }));
    await assert.rejects(readLedger(join(dir, 'store.json')), { code: 'control_ledger_malformed' });
  }
});

test('origin tombstones hide predated non-entity events but preserve project peers and access audit', () => {
  const { snapshot } = fixture();
  snapshot.events = [
    { id: 'origin-event', type: 'synthetic', project: null, attribution: 'unattributed', originId: 'origin-a', at: '2026-10-03T00:00:00.000Z' },
    { id: 'project-event', type: 'synthetic', project: 'p', attribution: 'project', originId: 'origin-a', at: '2026-10-03T00:00:00.000Z' },
    { id: 'audit-event', type: 'access.synthetic', project: null, attribution: 'unattributed', originId: 'origin-a', at: '2026-10-03T00:00:00.000Z' },
    { id: 'later-event', type: 'synthetic', project: null, attribution: 'unattributed', originId: 'origin-a', at: '2026-10-05T00:00:00.000Z' }
  ];
  attachLedgerView(snapshot, { tombstones: [{ kind: 'origin', purgedOrigin: 'origin-a', at: NOW, tokens: [], mode: 'logical' }] });
  const graph = createShadowGraph({ now }); graph.importData(snapshot);
  assert.deepEqual(privilegedLiveSnapshot(graph).events.map(x => x.id), ['project-event', 'audit-event', 'later-event']);
  assert.deepEqual(privilegedSnapshot(graph).events, snapshot.events, 'pure view must preserve persisted evidence');
});

test('origin suppression covers only its predated sessions and unresolved-scope miss receipts', () => {
  const graph = createShadowGraph({ now: () => '2026-10-03T00:00:00.000Z' });
  const admission = { limits: { maxStoreBytes: 2 ** 30, maxQueueDepth: 100, maxItemBytes: 65536, maxItemsPerSession: 10 }, storeBytes: 0 };
  for (const [sessionId, owner] of [['origin-session', { originId: 'origin-a' }], ['project-session', { originId: 'origin-a', project: 'p' }]]) {
    assert.equal(privilegedRecordCapture(graph, { ...owner, text: 'Synthetic capture', admission, source: { event: 'UserPromptSubmit', sessionId, role: 'user' } }).kind, 'capture');
  }
  const snapshot = privilegedSnapshot(graph);
  const signals = Object.fromEntries(['lexical', 'semantic', 'graph', 'temporal'].map(key => [key, { available: false, matched: 0 }]));
  let misses = [];
  for (const scope of [{ state: 'project_unresolved', project: null, originId: 'origin-a' }, { state: 'project_selected', project: 'p', originId: 'origin-a' }]) {
    misses = withFallbackMisses(misses, { query: 'Synthetic', scope, signals, recordIds: ['synthetic-historical-target'], at: '2026-10-03T00:00:00.000Z' });
  }
  snapshot.runtimeMisses = misses;
  attachLedgerView(snapshot, { tombstones: [{ kind: 'origin', purgedOrigin: 'origin-a', at: NOW, tokens: [], mode: 'logical' }] });
  const viewed = createShadowGraph({ now }); viewed.importData(snapshot);
  const live = privilegedLiveSnapshot(viewed);
  assert.deepEqual(live.captureSessions.map(x => x.sessionId), ['project-session']);
  assert.deepEqual(live.runtimeMisses.map(x => x.scope.project), ['p']);
  assert.deepEqual(privilegedSnapshot(viewed).runtimeMisses, misses);
  assert.deepEqual(privilegedSnapshot(viewed).captureSessions, snapshot.captureSessions);
});

for (const backend of ['json', 'sqlite']) test(`${backend} origin reader preserves completed knowledge and refuses unsupported restore before writes`, backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
  const dir = await scratchDirectory(t, 'pr43-origin-restore-'), file = join(dir, backend === 'json' ? 'store.json' : 'store.db');
  const backup = join(dir, backend === 'json' ? 'backup.json' : 'backup.db');
  const env = { SHADOWGRAPH_HOME: join(dir, 'home') };
  const store = await createStorage({ type: backend, file, env });
  try {
    const { snapshot } = fixture(); await store.save(snapshot);
    const tombstone = { kind: 'origin', purgedOrigin: 'origin-a', at: NOW, tokens: [], mode: 'logical', moveIn: 'none' };
    await writeFile(ledgerPath(file), JSON.stringify({ version: 1, tombstones: [tombstone], future: { preserve: true } }));
    await store.load();
    await backupFile(file, backup, { store });
    const before = await readFile(file), ledgerBefore = await readFile(ledgerPath(file));
    await assert.rejects(backend === 'json' ? restoreFile(backup, file, { env }) : store.restore(backup), { code: 'purge_aware_restore_unsupported_at_this_build' });
    assert.deepEqual(await readFile(file), before);
    assert.deepEqual(await readFile(ledgerPath(file)), ledgerBefore);
    const pending = { kind: 'restore', pre: { revision: snapshot.revision ?? 0, head: null, existed: true }, expected: { revision: 1, head: null },
      add: { tombstones: [tombstone], quarantine: [] }, inputs: { live: [], descent: false, descentMode: null, overlap: [], postdated: [] } };
    assert.equal(restoreRecordValid(pending, []), true, 'structural preservation is not recovery support');
    await writeFile(ledgerPath(file), JSON.stringify({ version: 1, tombstones: [tombstone], pending: [pending] }));
    const pendingBefore = await readFile(ledgerPath(file));
    for (const operation of [() => store.load(), () => store.save(snapshot), () => store.update(current => current)]) {
      await assert.rejects(operation(), { code: 'deletion_pending_unsupported_at_this_build' });
      assert.deepEqual(await readFile(ledgerPath(file)), pendingBefore);
      assert.deepEqual(await readFile(file), before);
    }
  } finally { store.close(); }
});

for (const backend of ['json', 'sqlite']) test(`${backend} origin pending recovery refuses backup in every binding before ledger cleanup`, backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
  const dir = await scratchDirectory(t, 'pr43-origin-pending-');
  const file = join(dir, backend === 'json' ? 'store.json' : 'store.db');
  const env = { SHADOWGRAPH_HOME: join(dir, 'home') };
  const store = await createStorage({ type: backend, file, env });
  try {
    await store.save(fixture().snapshot);
    const current = await store.load(), before = await readFile(file);
    const binding = { revision: current.revision, head: current.journal.at(-1).id };
    const tombstone = { kind: 'origin', purgedOrigin: 'origin-a', at: NOW, tokens: [], mode: 'logical', moveIn: 'none' };
    for (const state of ['pre', 'expected', 'post']) for (const placement of ['existing', 'added']) {
      const pending = { kind: 'restore', pre: { revision: binding.revision + 10, head: 'other-pre', existed: true },
        expected: { revision: binding.revision + 11, head: 'other-expected' }, post: { revision: binding.revision + 12, head: 'other-post' }, minted: [],
        add: { tombstones: placement === 'added' ? [tombstone] : [], quarantine: [] },
        inputs: { live: [], descent: false, descentMode: null, overlap: [], postdated: [] } };
      pending[state] = { ...pending[state], ...binding };
      const tombstones = placement === 'existing' ? [tombstone] : [];
      assert.equal(restoreRecordValid(pending, tombstones), true);
      await writeFile(ledgerPath(file), JSON.stringify({ version: 1, tombstones, pending: [pending] }));
      const ledgerBefore = await readFile(ledgerPath(file));
      await assert.rejects(backupFile(file, join(dir, `${state}-${placement}.backup`), { store, env }), { code: 'deletion_pending_unsupported_at_this_build' });
      assert.deepEqual(await readFile(ledgerPath(file)), ledgerBefore);
      assert.deepEqual(await readFile(file), before);
    }
  } finally { store.close(); }
});
