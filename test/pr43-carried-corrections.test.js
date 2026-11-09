import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { privilegedSnapshot, privilegedRebuild, privilegedReapplyDeletion } from '../src/internal/snapshot.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { createJsonFileStore } from '../src/storage.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { hardPurgeGapLedgerReport, journalBaselinePlacementIssues, rebuildProjection } from '../src/journal.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const now = () => '2026-10-04T00:00:00.000Z';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const ordered = values => [...values].sort((a, b) => String(a.id ?? a.key).localeCompare(String(b.id ?? b.key)));
function parity(graph) {
  const snapshot = privilegedSnapshot(graph), report = privilegedRebuild(graph);
  if (!report.rebuildable) {
    assert.ok(['journal epoch is outside the available sequence range', 'journal contains unexplained sequence gaps inside the replay range'].includes(report.reason), report.reason);
    assert.equal(hardPurgeGapLedgerReport(snapshot.journal, { journalEpoch: snapshot.journalEpoch }).valid, true);
  }
  assert.deepEqual(report.skipped, []);
  for (const name of ['records', 'facts', 'relations', 'idempotency']) assert.deepEqual(ordered(report.projection[name]), ordered(snapshot[name]), name);
  validateRestorePayload(snapshot, { now });
  return snapshot;
}
function add(graph, kind, owner, keyed) {
  const input = { ...owner, ...(keyed ? { idempotencyKey: 'synthetic-retry' } : {}) };
  if (kind === 'decision') return graph.addDecision({ ...input, title: 'Synthetic decision', chosen: 'Keep' });
  if (kind === 'attempt') return graph.addAttempt({ ...input, solution: 'Synthetic attempt', result: 'failed' });
  if (kind === 'fact') return graph.addFact({ ...input, key: 'synthetic-fact', value: 4 });
  return graph.remember({ ...input, memoryType: 'note', key: 'synthetic-memory', text: 'Synthetic memory' }).memory;
}

for (const kind of ['decision', 'attempt', 'fact', 'memory']) for (const keyed of [false, true]) {
  test(`journal-less ${kind} merge cannot silently change origin, keyed=${keyed}`, () => {
    const graph = createShadowGraph({ now });
    const entity = add(graph, kind, { originId: 'synthetic-origin-a' }, keyed);
    const before = parity(graph), collection = kind === 'fact' ? 'facts' : 'records';
    const changed = { ...before[collection].find(x => x.id === entity.id), originId: 'synthetic-origin-b' };
    const other = createShadowGraph({ now });
    const fresh = other.addDecision({ project: 'unrelated', title: 'New', chosen: 'Keep' });
    const imported = { schemaVersion: 7, records: [privilegedSnapshot(other).records.find(x => x.id === fresh.id)] };
    imported[collection] = [...(imported[collection] ?? []), changed];
    assert.throws(() => graph.importData(imported), /cannot change.*(owner|scope|project)/i);
    assert.deepEqual(privilegedSnapshot(graph), before, 'refusal must include the otherwise valid new entity');
  });
}

test('project-owned provenance may change while its owner and retry identity remain stable', () => {
  const graph = createShadowGraph({ now });
  const entity = add(graph, 'decision', { project: 'p', originId: 'synthetic-origin-a' }, false);
  const before = privilegedSnapshot(graph);
  graph.importData({ schemaVersion: 7, records: [{ ...before.records.find(x => x.id === entity.id), originId: 'synthetic-origin-b' }] });
  assert.equal(parity(graph).records.find(x => x.id === entity.id).originId, 'synthetic-origin-b');
});

function migration({ keptAddition = false, keptRetry = false } = {}) {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'p', title: 'Remove original', chosen: 'Remove' });
  const kept = graph.addDecision({ project: 'q', title: 'Keep original', chosen: 'Keep', idempotencyKey: 'keep' });
  const incoming = createShadowGraph({ now });
  incoming.addDecision({ project: 'p', title: 'Remove imported', chosen: 'Remove', idempotencyKey: 'import-remove' });
  if (keptAddition) incoming.addDecision({ project: 'q', title: 'Keep imported', chosen: 'Keep', idempotencyKey: 'import-keep' });
  const source = privilegedSnapshot(incoming);
  if (keptRetry) source.idempotency.push({ key: 'decision:q:additional-retry', value: privilegedSnapshot(graph).records.find(x => x.id === kept.id) });
  graph.importData({ schemaVersion: 7, records: source.records, idempotency: source.idempotency });
  const before = parity(graph);
  assert.equal(before.journal.filter(x => x.type === 'projection.baseline').length, 1);
  return { graph, before, kept };
}

test('a fresh retry key cannot mask rebinding an existing key to another entity', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'p', title: 'A', chosen: 'A', idempotencyKey: 'original' });
  const b = graph.addDecision({ project: 'p', title: 'B', chosen: 'B' });
  const snapshot = privilegedSnapshot(graph), value = snapshot.records.find(x => x.id === b.id);
  const baseline = { id: 'synthetic-retry-baseline', seq: snapshot.journalSeq + 1, type: 'projection.baseline',
    derivedFrom: 'live_state_at_migration', at: now(), schemaVersion: 7, project: null, entityKind: null, entityId: null,
    payload: { records: snapshot.records, facts: [], relations: [], idempotency: [
      { key: snapshot.idempotency[0].key, value }, { key: 'decision:p:additional', value }
    ] }, provenance: { actor: null, client: null, sessionId: null } };
  const options = { journalEpoch: snapshot.journalEpoch, sourceSchemaVersion: 7 };
  assert.ok(journalBaselinePlacementIssues([...snapshot.journal, baseline], options).some(x => /rewrite idempotency/.test(x.detail)));
  assert.equal(rebuildProjection([...snapshot.journal, baseline], options).rebuildable, false);
  baseline.payload.idempotency[0] = snapshot.idempotency[0];
  assert.deepEqual(journalBaselinePlacementIssues([...snapshot.journal, baseline], options), []);
});

for (const mode of ['hard', 'logical']) test(`${mode} purge preserves a migration baseline's unique surviving retry mapping`, () => {
  const { graph, before } = migration({ keptRetry: true });
  const baseline = before.journal.find(x => x.type === 'projection.baseline');
  graph.purgeProject('p', { mode });
  const after = parity(graph);
  assert.ok(after.journal.find(x => x.id === baseline.id)?.payload.idempotency.some(x => x.key === 'decision:q:additional-retry'));
  assert.ok(after.idempotency.some(x => x.key === 'decision:q:additional-retry'));
});

test('mixed reapplication does not splice a redundant baseline reached only by logical removal', () => {
  const { graph, before } = migration();
  const outside = graph.addDecision({ project: 'outside', title: 'Hard only outside baseline', chosen: 'Remove' });
  const baseline = before.journal.find(x => x.type === 'projection.baseline');
  privilegedReapplyDeletion(graph, { remove: [...before.records.filter(x => x.project === 'p').map(x => ({ id: x.id, mode: 'logical' })), { id: outside.id, mode: 'hard' }], quarantine: [] });
  const after = parity(graph);
  assert.equal(after.journal.find(x => x.id === baseline.id)?.redacted, true);
  assert.equal(after.journal.some(x => x.payload?.removedJournalSequences?.includes(baseline.seq)), false);
});

for (const backend of ['json', 'sqlite']) for (const mode of ['hard', 'logical']) for (const operation of ['purge', 'reapply']) {
  test(`${backend} ${mode} ${operation} normalizes only redundant rewritten migration baseline`, backend === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {}, async t => {
    for (const keptAddition of [false, true]) {
      const { graph, before, kept } = migration({ keptAddition });
      const baseline = before.journal.find(x => x.type === 'projection.baseline');
      if (operation === 'purge') graph.purgeProject('p', { mode });
      else privilegedReapplyDeletion(graph, { remove: before.records.filter(x => x.project === 'p').map(x => ({ id: x.id, mode })), quarantine: [] });
      const after = parity(graph);
      assert.deepEqual(after.records.find(x => x.id === kept.id), before.records.find(x => x.id === kept.id));
      assert.equal(after.records.some(x => x.project === 'p'), false);
      const rewritten = after.journal.find(x => x.id === baseline.id);
      if (keptAddition) assert.ok(rewritten?.payload.records.some(x => x.title === 'Keep imported'));
      else if (mode === 'logical') {
        assert.equal(rewritten.seq, baseline.seq);
        assert.equal(rewritten.payload, null);
        assert.equal(rewritten.redacted, true);
      } else {
        assert.equal(rewritten, undefined);
        assert.ok(after.journal.some(x => x.payload?.removedJournalSequences?.includes(baseline.seq)));
      }
      assert.equal(after.journalEpoch, before.journalEpoch);
      for (const removed of before.records.filter(x => x.project === 'p')) assert.equal(JSON.stringify(after).includes(removed.id), false);
      const dir = await scratchDirectory(t, 'pr43-corrective-');
      const store = backend === 'json' ? createJsonFileStore(join(dir, 'store.json')) : await createSqliteStore(join(dir, 'store.db'));
      try {
        await store.save(after);
        const restored = createShadowGraph({ now }); restored.importData(await store.load());
        parity(restored);
        restored.addDecision({ project: 'q', title: 'Later', chosen: 'Keep' });
        parity(restored);
      } finally { await store.close(); }
    }
  });
}
