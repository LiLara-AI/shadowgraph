import test from 'node:test';
import assert from 'node:assert/strict';
import { createShadowGraph, rebuildProjection } from '../src/shadowgraph.js';
import { validateRestorePayload } from '../src/restore-validation.js';

test('scoped memory reconciliation adds, deduplicates, and supersedes without losing history', () => {
  const times = [
    '2026-08-27T09:00:00.000Z',
    '2026-08-27T09:05:00.000Z',
    '2026-08-27T09:10:00.000Z'
  ];
  let clock = 0;
  const graph = createShadowGraph({ now: () => times[Math.min(clock++, times.length - 1)] });
  const scope = { userId: 'alice', agentId: 'planner', runId: null };

  const added = graph.remember({
    project: 'trip',
    scope,
    memoryType: 'preference',
    key: 'hotel-style',
    text: 'Prefers boutique hotels',
    sourceClass: 'human_confirmed'
  });
  assert.equal(added.operation, 'ADD');
  assert.equal(added.memory.kind, 'memory');
  assert.deepEqual(added.memory.scope, scope);
  assert.equal(added.memory.status, 'active');
  assert.equal(added.memory.temporal.validTo, null);
  assert.equal(added.memory.verificationStatus, 'unverified');

  const duplicate = graph.remember({
    project: 'trip',
    scope,
    memoryType: 'preference',
    key: 'hotel-style',
    text: 'Prefers boutique hotels',
    sourceClass: 'human_confirmed'
  });
  assert.equal(duplicate.operation, 'NOOP');
  assert.equal(duplicate.memory.id, added.memory.id);

  const updated = graph.remember({
    project: 'trip',
    scope,
    memoryType: 'preference',
    key: 'hotel-style',
    text: 'Prefers quiet boutique hotels',
    validFrom: '2026-09-01T00:00:00.000Z',
    sourceClass: 'human_confirmed'
  });
  assert.equal(updated.operation, 'UPDATE');
  assert.notEqual(updated.memory.id, added.memory.id);
  assert.equal(updated.previous.id, added.memory.id);
  assert.equal(updated.previous.status, 'superseded');
  assert.equal(updated.previous.temporal.validTo, '2026-09-01T00:00:00.000Z');
  assert.equal(updated.memory.supersedes, added.memory.id);

  const history = graph.memoryHistory({
    project: 'trip',
    scope,
    memoryType: 'preference',
    key: 'hotel-style'
  });
  assert.equal(history.items.length, 2);
  assert.deepEqual(history.items.map((item) => item.status), ['superseded', 'active']);
  assert.equal(history.completeness.complete, true);

  const journalTypes = graph.getJournal({ limit: 20 }).items.map((entry) => entry.type);
  assert.deepEqual(journalTypes, ['memory.recorded', 'memory.superseded', 'memory.recorded']);
});

test('a validated memory plan invalidates in-scope state without partial writes or cross-scope leakage', () => {
  const graph = createShadowGraph({ now: () => '2026-08-27T10:00:00.000Z' });
  const alice = { userId: 'alice' };
  const bob = { userId: 'bob' };

  const seed = graph.applyMemoryPlan({
    project: 'app',
    scope: alice,
    operations: [
      { action: 'ADD', memoryType: 'preference', key: 'theme', text: 'Prefers dark mode' },
      { action: 'ADD', memoryType: 'goal', key: 'release', text: 'Ship version one' }
    ]
  });
  assert.deepEqual(seed.results.map((item) => item.operation), ['ADD', 'ADD']);
  graph.remember({ project: 'app', scope: bob, memoryType: 'preference', key: 'theme', text: 'Prefers light mode' });

  const beforeInvalidPlan = graph.exportData();
  assert.throws(() => graph.applyMemoryPlan({
    project: 'app',
    scope: alice,
    operations: [
      { action: 'ADD', memoryType: 'note', key: 'must-not-land', text: 'partial write' },
      { action: 'ERASE', memoryType: 'goal', key: 'release' }
    ]
  }), /Memory plan action must be ADD, UPDATE, DELETE, or NOOP/);
  assert.deepEqual(graph.exportData(), beforeInvalidPlan);

  const removed = graph.applyMemoryPlan({
    project: 'app',
    scope: alice,
    operations: [{ action: 'DELETE', memoryType: 'preference', key: 'theme', validAt: '2026-09-01T00:00:00.000Z' }]
  });
  assert.equal(removed.results[0].operation, 'DELETE');
  assert.equal(removed.results[0].memory.status, 'invalidated');
  assert.equal(removed.results[0].memory.temporal.validTo, '2026-09-01T00:00:00.000Z');

  const aliceHistory = graph.memoryHistory({ project: 'app', scope: alice, memoryType: 'preference', key: 'theme' });
  const bobHistory = graph.memoryHistory({ project: 'app', scope: bob, memoryType: 'preference', key: 'theme' });
  assert.deepEqual(aliceHistory.items.map((item) => item.text), ['Prefers dark mode']);
  assert.deepEqual(aliceHistory.items.map((item) => item.status), ['invalidated']);
  assert.deepEqual(bobHistory.items.map((item) => item.text), ['Prefers light mode']);
  assert.deepEqual(bobHistory.items.map((item) => item.status), ['active']);
  assert.equal(graph.getJournal({ limit: 20 }).items.at(-1).type, 'memory.invalidated');
});

test('recall fuses lexical, semantic, graph, and temporal signals while declaring unavailable semantics', () => {
  const graph = createShadowGraph({ now: () => '2026-09-10T00:00:00.000Z' });
  const alice = { userId: 'alice' };
  const bob = { userId: 'bob' };

  const oldHotel = graph.remember({
    project: 'trip', scope: alice, memoryType: 'preference', key: 'hotel-style',
    text: 'Previously preferred large resorts', validFrom: '2026-08-01T00:00:00.000Z', embedding: [0.9, 0.1]
  }).memory;
  const currentHotel = graph.remember({
    project: 'trip', scope: alice, memoryType: 'preference', key: 'hotel-style',
    text: 'Prefers quiet boutique hotels', validFrom: '2026-09-01T00:00:00.000Z', embedding: [1, 0]
  }).memory;
  graph.remember({
    project: 'trip', scope: alice, memoryType: 'preference', key: 'flight-time',
    text: 'Avoids early morning flights', embedding: [0, 1]
  });
  graph.remember({
    project: 'trip', scope: bob, memoryType: 'preference', key: 'hotel-style',
    text: 'Bob also likes boutique hotels', embedding: [1, 0]
  });
  const decision = graph.addDecision({ project: 'trip', title: 'Travel booking policy', chosen: 'Respect saved preferences' });
  graph.link({ from: decision.id, to: currentHotel.id, relation: 'uses_preference' });

  const fused = graph.recall('lodging taste', {
    project: 'trip', scope: alice, queryEmbedding: [0.99, 0.01], focalId: decision.id,
    asOf: '2026-09-15T00:00:00.000Z', limit: 10
  });
  assert.equal(fused.items[0].record.id, currentHotel.id);
  assert.equal(fused.signals.semantic.available, true);
  assert.equal(fused.signals.graph.available, true);
  assert.equal(fused.signals.temporal.available, true);
  assert.equal(fused.items[0].ranks.semantic, 1);
  assert.equal(fused.items[0].ranks.graph, 1);
  assert.equal(fused.items.some((item) => item.record.text === 'Bob also likes boutique hotels'), false);

  const historical = graph.recall('resorts', {
    project: 'trip', scope: alice, asOf: '2026-08-15T00:00:00.000Z', limit: 10
  });
  assert.equal(historical.items[0].record.id, oldHotel.id);
  assert.equal(historical.items.some((item) => item.record.id === currentHotel.id), false);

  const lexicalOnly = graph.recall('boutique', { project: 'trip', scope: alice, limit: 10 });
  assert.equal(lexicalOnly.items[0].record.id, currentHotel.id);
  assert.equal(lexicalOnly.signals.semantic.available, false);
  assert.match(lexicalOnly.signals.semantic.reason, /queryEmbedding/);
});

test('facts and relations preserve bi-temporal history for point-in-time recall', () => {
  const graph = createShadowGraph({ now: () => '2026-09-02T12:00:00.000Z' });
  const oldFact = graph.addFact({
    id: 'fact-old', project: 'deploy', key: 'deployment-mode', value: 'single-user',
    validFrom: '2026-08-01T00:00:00.000Z', observedAt: '2026-08-02T00:00:00.000Z'
  });
  const newFact = graph.addFact({
    id: 'fact-new', project: 'deploy', key: 'deployment-mode', value: 'multi-user',
    validFrom: '2026-09-01T00:00:00.000Z', observedAt: '2026-09-02T00:00:00.000Z'
  });
  const storedOld = graph.exportData().facts.find((fact) => fact.id === oldFact.id);
  assert.equal(storedOld.status, 'superseded');
  assert.equal(storedOld.temporal.validTo, '2026-09-01T00:00:00.000Z');
  assert.equal(storedOld.temporal.invalidatedAt, '2026-09-02T12:00:00.000Z');
  assert.equal(newFact.temporal.validFrom, '2026-09-01T00:00:00.000Z');
  assert.equal(newFact.temporal.recordedAt, '2026-09-02T12:00:00.000Z');

  const decision = graph.addDecision({ project: 'deploy', title: 'Deployment architecture', chosen: 'Choose by active mode' });
  const relation = graph.link({
    from: decision.id,
    to: newFact.id,
    relation: 'depends_on',
    validFrom: '2026-09-01T00:00:00.000Z'
  });
  assert.deepEqual(relation.temporal, {
    validFrom: '2026-09-01T00:00:00.000Z',
    validTo: null,
    recordedAt: '2026-09-02T12:00:00.000Z',
    invalidatedAt: null
  });

  const august = graph.recall('single-user', {
    project: 'deploy', asOf: '2026-08-15T00:00:00.000Z', focalId: decision.id, limit: 10
  });
  assert.equal(august.items.some((item) => item.record.id === oldFact.id), true);
  assert.equal(august.items.some((item) => item.record.id === newFact.id), false);
  assert.equal(august.signals.graph.available, false);

  const september = graph.recall('multi-user', {
    project: 'deploy', asOf: '2026-09-15T00:00:00.000Z', focalId: decision.id, limit: 10
  });
  assert.equal(september.items.some((item) => item.record.id === oldFact.id), false);
  assert.equal(september.items.some((item) => item.record.id === newFact.id), true);
  assert.equal(september.signals.graph.available, true);
});

test('reconsideration does not consume a future-valid fact before its valid time', () => {
  let current = '2026-08-15T00:00:00.000Z';
  const graph = createShadowGraph({ now: () => current });
  const decision = graph.addDecision({
    project: 'deploy', title: 'Single-user architecture', chosen: 'SQLite',
    alternatives: [{
      label: 'Postgres', reasonRejected: 'Not multi-user yet',
      reopenWhen: [{ key: 'deployment-mode', operator: 'equals', value: 'multi-user' }]
    }]
  });
  graph.addFact({ project: 'deploy', key: 'deployment-mode', value: 'single-user', validFrom: '2026-08-01T00:00:00.000Z' });
  graph.addFact({ project: 'deploy', key: 'deployment-mode', value: 'multi-user', validFrom: '2026-09-01T00:00:00.000Z' });

  assert.equal(graph.review({ project: 'deploy' }).some((item) => item.decisionId === decision.id), false);
  current = '2026-09-02T00:00:00.000Z';
  assert.equal(graph.review({ project: 'deploy' }).some((item) => item.decisionId === decision.id), true);
});

test('out-of-order fact backfills are rejected before corrupting temporal intervals', () => {
  const graph = createShadowGraph({ now: () => '2026-09-10T00:00:00.000Z' });
  graph.addFact({ project: 'deploy', key: 'mode', value: 'multi-user', validFrom: '2026-09-01T00:00:00.000Z' });
  const before = graph.exportData();
  assert.throws(() => graph.addFact({
    project: 'deploy', key: 'mode', value: 'single-user', validFrom: '2026-08-01T00:00:00.000Z'
  }), /Facts for one scope must be recorded in non-decreasing validFrom order/);
  assert.deepEqual(graph.exportData(), before);
});

test('logical purge clears scoped memory indexes and rebuild cannot resurrect purged payloads', () => {
  const graph = createShadowGraph({ now: () => '2026-09-20T00:00:00.000Z' });
  const first = graph.remember({
    project: 'private', scope: { userId: 'alice' }, memoryType: 'profile', key: 'email',
    text: 'alice@example.test', idempotencyKey: 'profile-email'
  });
  assert.equal(first.operation, 'ADD');

  const purged = graph.purgeProject('private');
  assert.equal(purged.mode, 'logical');
  assert.equal(graph.exportData().records.some((record) => record.project === 'private'), false);
  assert.equal(JSON.stringify(graph.exportData()).includes('alice@example.test'), false);

  const replacement = graph.remember({
    project: 'private', scope: { userId: 'alice' }, memoryType: 'profile', key: 'email',
    text: 'new@example.test', idempotencyKey: 'profile-email'
  });
  assert.equal(replacement.operation, 'ADD');
  assert.equal(replacement.previous, undefined);

  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true);
  assert.equal(rebuilt.projection.records.some((record) => record.text === 'alice@example.test'), false);
  assert.equal(rebuilt.projection.records.some((record) => record.text === 'new@example.test'), true);
});

test('duplicate active memory scopes resolve deterministically and remain declared invalid', () => {
  const older = {
    id: 'memory-older', kind: 'memory', schemaVersion: 4, project: 'app',
    scope: { userId: 'alice', agentId: null, runId: null }, memoryType: 'preference', key: 'theme',
    text: 'Dark', version: 1, status: 'active', verificationStatus: 'unverified',
    temporal: { validFrom: '2026-01-01T00:00:00.000Z', validTo: null, recordedAt: '2026-01-01T00:00:00.000Z', invalidatedAt: null }
  };
  const newer = {
    ...older, id: 'memory-newer', text: 'Light', version: 2,
    temporal: { ...older.temporal, validFrom: '2026-02-01T00:00:00.000Z', recordedAt: '2026-02-01T00:00:00.000Z' }
  };

  for (const records of [[newer, older], [older, newer]]) {
    const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
    graph.importData({ schemaVersion: 4, records });
    assert.equal(graph.validate().issues.some((issue) => issue.code === 'duplicate_active_memory_scope'), true);
    const result = graph.remember({
      project: 'app', scope: { userId: 'alice' }, memoryType: 'preference', key: 'theme', text: 'System'
    });
    assert.equal(result.operation, 'UPDATE');
    assert.equal(result.previous.id, 'memory-newer');
    assert.equal(result.memory.version, 3);
  }
});

test('invalid memory intervals are rejected before direct or planned writes mutate state', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  assert.throws(() => graph.remember({
    project: 'app', memoryType: 'goal', key: 'deadline', text: 'Ship',
    validFrom: '2026-05-01T00:00:00.000Z', validTo: '2026-04-01T00:00:00.000Z'
  }), /Memory validTo must be later than validFrom/);
  assert.equal(graph.exportData().records.length, 0);

  const before = graph.exportData();
  assert.throws(() => graph.applyMemoryPlan({
    project: 'app',
    operations: [
      { action: 'ADD', memoryType: 'note', key: 'would-be-partial', text: 'Must not land' },
      {
        action: 'ADD', memoryType: 'goal', key: 'bad-window', text: 'Invalid',
        validFrom: '2026-06-01T00:00:00.000Z', validTo: '2026-05-01T00:00:00.000Z'
      }
    ]
  }), /Memory validTo must be later than validFrom/);
  assert.deepEqual(graph.exportData(), before);

  graph.remember({
    project: 'app', memoryType: 'goal', key: 'ordered', text: 'Initial',
    validFrom: '2026-05-01T00:00:00.000Z'
  });
  const beforeBackfill = graph.exportData();
  assert.throws(() => graph.applyMemoryPlan({
    project: 'app',
    operations: [
      { action: 'UPDATE', memoryType: 'goal', key: 'ordered', text: 'Later', validFrom: '2026-06-01T00:00:00.000Z' },
      { action: 'UPDATE', memoryType: 'goal', key: 'ordered', text: 'Backfill', validFrom: '2026-04-01T00:00:00.000Z' }
    ]
  }), /Memories for one identity must be recorded in non-decreasing validFrom order/);
  assert.deepEqual(graph.exportData(), beforeBackfill);

  const beforeDeleteBackfill = graph.exportData();
  assert.throws(() => graph.applyMemoryPlan({
    project: 'app',
    operations: [
      { action: 'DELETE', memoryType: 'goal', key: 'ordered', validAt: '2026-06-01T00:00:00.000Z' },
      { action: 'ADD', memoryType: 'goal', key: 'ordered', text: 'Historical backfill', validFrom: '2026-04-01T00:00:00.000Z' }
    ]
  }), /Memories for one identity must be recorded in non-decreasing validFrom order/);
  assert.deepEqual(graph.exportData(), beforeDeleteBackfill);
});

test('memory plan preflights retry keys before the first operation mutates state', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const before = graph.exportData();
  assert.throws(() => graph.applyMemoryPlan({
    project: 'app',
    operations: [
      { action: 'ADD', memoryType: 'note', key: 'first', text: 'Must not land' },
      { action: 'ADD', memoryType: 'note', key: 'second', text: 'Invalid retry', idempotencyKey: 42 }
    ]
  }), /idempotencyKey must be a string/);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.applyMemoryPlan({
    project: 'app',
    operations: [
      { action: 'ADD', memoryType: 'note', key: 'first', text: 'Must not land' },
      { action: 'ADD', memoryType: 'note', key: 'second', text: 'Invalid time', createdAt: { attacker: true } }
    ]
  }), /createdAt must be a string or null/);
  assert.deepEqual(graph.exportData(), before);
});

test('current recall excludes an ended validity window while historical recall includes it', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const memory = graph.remember({
    project: 'app', memoryType: 'instruction', key: 'seasonal-rule', text: 'Use winter routing',
    validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-03-01T00:00:00.000Z'
  }).memory;
  const current = graph.recall('winter routing', { project: 'app' });
  assert.equal(current.items.some((item) => item.record.id === memory.id), false);
  const historical = graph.recall('winter routing', { project: 'app', asOf: '2026-02-01T00:00:00.000Z' });
  assert.equal(historical.items.some((item) => item.record.id === memory.id), true);
});

test('current recall keeps the prior value until a future-effective replacement starts', () => {
  const graph = createShadowGraph({ now: () => '2026-08-15T00:00:00.000Z' });
  const oldMemory = graph.remember({
    project: 'app', memoryType: 'preference', key: 'theme', text: 'Use light theme',
    validFrom: '2026-08-01T00:00:00.000Z'
  }).memory;
  const newMemory = graph.remember({
    project: 'app', memoryType: 'preference', key: 'theme', text: 'Use dark theme',
    validFrom: '2026-09-01T00:00:00.000Z'
  }).memory;
  const oldFact = graph.addFact({ project: 'app', key: 'region', value: 'eu', validFrom: '2026-08-01T00:00:00.000Z' });
  const newFact = graph.addFact({ project: 'app', key: 'region', value: 'us', validFrom: '2026-09-01T00:00:00.000Z' });

  const currentIds = new Set(graph.recall('', { project: 'app' }).items.map((item) => item.record.id));
  assert.equal(currentIds.has(oldMemory.id), true);
  assert.equal(currentIds.has(newMemory.id), false);
  assert.equal(currentIds.has(oldFact.id), true);
  assert.equal(currentIds.has(newFact.id), false);
});

test('recall rejects malformed temporal selectors instead of exposing scheduled state', () => {
  const graph = createShadowGraph({ now: () => '2026-08-15T00:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'future', text: 'Scheduled secret', validFrom: '2026-09-01T00:00:00.000Z' });
  assert.throws(() => graph.recall('', { project: 'app', asOf: { not: 'a timestamp' } }), /asOf must be a string or null/);
  assert.throws(() => graph.recall('', { project: 'app', currentAt: ['bad'] }), /currentAt must be a string or null/);
  assert.throws(() => graph.recall('', { project: 'app', asOf: 'definitely-not-an-instant' }), /asOf must be a valid timestamp/);

  const offsetGraph = createShadowGraph({ now: () => '2026-08-31T15:30:00.000Z' });
  const offsetMemory = offsetGraph.remember({
    project: 'app', memoryType: 'note', key: 'offset', text: 'Already active',
    validFrom: '2026-08-31T16:00:00.000+01:00'
  }).memory;
  assert.equal(offsetGraph.recall('', { project: 'app' }).items.some((item) => item.record.id === offsetMemory.id), true);
});

test('temporal ranking orders timezone offsets by instant', () => {
  const graph = createShadowGraph({ now: () => '2026-09-01T00:00:00.000Z' });
  graph.remember({
    project: 'app', memoryType: 'note', key: 'older', text: 'Older',
    validFrom: '2026-08-31T16:00:00.000+01:00'
  });
  const newer = graph.remember({
    project: 'app', memoryType: 'note', key: 'newer', text: 'Newer',
    validFrom: '2026-08-31T15:30:00.000Z'
  }).memory;
  const result = graph.recall('', { project: 'app', preferRecent: true });
  assert.equal(result.items[0].record.id, newer.id);
  assert.equal(result.items[0].ranks.temporal, 1);
});

test('empty hybrid recall retains timeless decision candidates', () => {
  const graph = createShadowGraph({ now: () => '2026-09-01T00:00:00.000Z' });
  const decision = graph.addDecision({ project: 'app', title: 'Timeless decision', chosen: 'A' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'recent', text: 'Recent memory' });
  const result = graph.recall('', { project: 'app', preferRecent: true });
  assert.equal(result.items.some((item) => item.record.id === decision.id), true);
});

test('deleting a future-effective memory closes it at its validFrom boundary', () => {
  const graph = createShadowGraph({ now: () => '2026-08-15T00:00:00.000Z' });
  const scheduled = graph.remember({
    project: 'app', memoryType: 'note', key: 'scheduled', text: 'Future', validFrom: '2026-09-01T00:00:00.000Z'
  }).memory;
  graph.applyMemoryPlan({
    project: 'app', operations: [{ action: 'DELETE', memoryType: 'note', key: 'scheduled' }]
  });
  const stored = graph.exportData().records.find((record) => record.id === scheduled.id);
  assert.equal(stored.temporal.validTo, '2026-09-01T00:00:00.000Z');
  assert.equal(graph.validate().valid, true);
});

test('redaction removes sensitive scoped-memory text from live and journal exports', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  graph.remember({
    project: 'private', scope: { userId: 'alice' }, memoryType: 'profile',
    key: 'api-key', text: 'super-secret-value'
  });
  const redacted = graph.redact({ project: 'private' });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes('super-secret-value'), false);
  assert.equal(redacted.records[0].text, '[REDACTED]');
  assert.equal(redacted.journal[0].payload.text, '[REDACTED]');
});

test('memory idempotency retries are isolated by exact scope identity', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const alice = graph.remember({
    project: 'app', scope: { userId: 'alice' }, memoryType: 'profile',
    key: 'email', text: 'alice@example.test', idempotencyKey: 'profile-email'
  });
  const bob = graph.remember({
    project: 'app', scope: { userId: 'bob' }, memoryType: 'profile',
    key: 'email', text: 'bob@example.test', idempotencyKey: 'profile-email'
  });

  assert.equal(alice.operation, 'ADD');
  assert.equal(bob.operation, 'ADD');
  assert.equal(bob.memory.scope.userId, 'bob');
  assert.equal(graph.exportData().records.filter((record) => record.kind === 'memory').length, 2);
  assert.equal(graph.rebuild().projection.idempotency.length, 2);
});

test('project-only recall cannot expose memories from any scoped identity', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const shared = graph.remember({ project: 'app', memoryType: 'note', key: 'shared', text: 'Shared project note' }).memory;
  const alice = graph.remember({ project: 'app', scope: { userId: 'alice' }, memoryType: 'profile', key: 'private', text: 'Alice private' }).memory;
  const bob = graph.remember({ project: 'app', scope: { userId: 'bob' }, memoryType: 'profile', key: 'private', text: 'Bob private' }).memory;

  const projectOnly = graph.recall('', { project: 'app' });
  assert.deepEqual(projectOnly.items.map((item) => item.record.id), [shared.id]);
  const aliceOnly = graph.recall('', { project: 'app', scope: { userId: 'alice' } });
  assert.deepEqual(aliceOnly.items.map((item) => item.record.id), [alice.id]);
  assert.equal(projectOnly.items.some((item) => item.record.id === bob.id), false);
});

test('project-only search and retrieve cannot expose scoped memories', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const shared = graph.remember({ project: 'app', memoryType: 'note', key: 'shared', text: 'Shared project note' }).memory;
  const alice = graph.remember({ project: 'app', scope: { userId: 'alice' }, memoryType: 'profile', key: 'private', text: 'Alice private' }).memory;
  const bob = graph.remember({ project: 'app', scope: { userId: 'bob' }, memoryType: 'profile', key: 'private', text: 'Bob private' }).memory;
  const defaultShared = graph.remember({ memoryType: 'note', key: 'default-shared', text: 'Default shared' }).memory;
  graph.remember({ project: 'other', memoryType: 'note', key: 'other-shared', text: 'Other shared' });
  const decision = graph.addDecision({ project: 'app', title: 'Public decision', chosen: 'A' });
  graph.link({ from: decision.id, to: alice.id, relation: 'personalized_by' });
  graph.link({ from: decision.id, to: bob.id, relation: 'personalized_by' });

  const projectSearchMemories = graph.search('', { project: 'app' }).items.filter((item) => item.record.kind === 'memory');
  const projectRetrieveMemories = graph.retrieve('', { project: 'app' }).items.filter((item) => item.record.kind === 'memory');
  assert.deepEqual(projectSearchMemories.map((item) => item.record.id), [shared.id]);
  assert.deepEqual(projectRetrieveMemories.map((item) => item.record.id), [shared.id]);

  const omittedProjectSearch = graph.search('', {}).items.filter((item) => item.record.kind === 'memory');
  const omittedProjectRetrieve = graph.retrieve('', {}).items.filter((item) => item.record.kind === 'memory');
  assert.deepEqual(omittedProjectSearch.map((item) => item.record.id), [defaultShared.id]);
  assert.deepEqual(omittedProjectRetrieve.map((item) => item.record.id), [defaultShared.id]);

  const aliceSearchMemories = graph.search('', { project: 'app', scope: { userId: 'alice' } }).items.filter((item) => item.record.kind === 'memory');
  const aliceRetrieveMemories = graph.retrieve('', { project: 'app', scope: { userId: 'alice' } }).items.filter((item) => item.record.kind === 'memory');
  assert.deepEqual(aliceSearchMemories.map((item) => item.record.id), [alice.id]);
  assert.deepEqual(aliceRetrieveMemories.map((item) => item.record.id), [alice.id]);
  assert.equal(aliceSearchMemories.some((item) => item.record.id === bob.id), false);

  const unscopedTraversal = graph.traverse({ id: decision.id });
  assert.equal(unscopedTraversal.nodes.some((node) => node.id === alice.id || node.id === bob.id), false);
  const aliceTraversal = graph.traverse({ id: decision.id, project: 'app', scope: { userId: 'alice' } });
  assert.equal(aliceTraversal.nodes.some((node) => node.id === alice.id), true);
  assert.equal(aliceTraversal.nodes.some((node) => node.id === bob.id), false);
  assert.throws(() => graph.traverse({ id: alice.id }), /outside the requested memory scope/);
});

test('omitted project recall is confined to the default project', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const defaultMemory = graph.remember({ memoryType: 'note', key: 'default', text: 'Default project' }).memory;
  graph.remember({ project: 'alpha', memoryType: 'note', key: 'private', text: 'Alpha private' });
  graph.remember({ project: 'beta', memoryType: 'note', key: 'private', text: 'Beta private' });

  const recalled = graph.recall('', {});
  assert.deepEqual(recalled.items.map((item) => item.record.id), [defaultMemory.id]);
  assert.equal(recalled.completeness.scope.project, 'default');
});

test('memory project must be a non-empty string on writes, plans, and recall', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const before = graph.exportData();
  assert.throws(() => graph.remember({
    project: { tenant: 'a' }, memoryType: 'note', key: 'bad-project', text: 'Bad', idempotencyKey: 'same'
  }), /project must be a non-empty string/);
  assert.throws(() => graph.applyMemoryPlan({
    project: { tenant: 'b' }, operations: [{ action: 'ADD', memoryType: 'note', key: 'bad-plan', text: 'Bad' }]
  }), /project must be a non-empty string/);
  assert.throws(() => graph.recall('', { project: { tenant: 'c' } }), /project must be a non-empty string/);
  assert.deepEqual(graph.exportData(), before);
});

test('memory scope rejects non-objects, unknown keys, and non-string identifiers', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  graph.remember({ project: 'app', memoryType: 'note', key: 'shared', text: 'Shared' });
  const before = graph.exportData();
  assert.throws(() => graph.recall('', { project: 'app', scope: 'alice' }), /Memory scope must be an object/);
  assert.throws(() => graph.recall('', { project: 'app', scope: { tenantId: 'a' } }), /unknown field tenantId/);
  assert.throws(() => graph.remember({
    project: 'app', scope: { userId: 42 }, memoryType: 'note', key: 'bad', text: 'Bad'
  }), /userId must be a string or null/);
  assert.deepEqual(graph.exportData(), before);
});

test('all runtime entity writes require a non-empty string project', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const before = graph.exportData();
  assert.throws(() => graph.addDecision({ project: { tenant: 'a' }, title: 'Bad', chosen: 'A' }), /project must be a non-empty string/);
  assert.throws(() => graph.addAttempt({ project: '', solution: 'Bad', result: 'failed' }), /project must be a non-empty string/);
  assert.throws(() => graph.addFact({ project: 42, key: 'bad', value: true }), /project must be a non-empty string/);
  assert.deepEqual(graph.exportData(), before);
});

test('runtime writes reject non-JSON values before mutating canonical state', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const before = graph.exportData();
  assert.throws(() => graph.addFact({ id: 'bigint-fact', project: 'app', key: 'bad', value: 1n }), /serialize a BigInt/);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.addFact({ id: 'nan-fact', project: 'app', key: 'bad', value: Number.NaN }), /Non-finite numbers are not JSON-serializable/);
  assert.deepEqual(graph.exportData(), before);
  assert.throws(() => graph.addFact({ id: 'infinite-fact', project: 'app', key: 'bad', value: Number.POSITIVE_INFINITY }), /Non-finite numbers are not JSON-serializable/);
  assert.deepEqual(graph.exportData(), before);
  assert.throws(() => graph.addFact({
    id: 'lossy-fact', project: 'app', key: 'bad',
    value: { missing: undefined, when: new Date('2026-01-01T00:00:00.000Z'), map: new Map([['x', 1]]) }
  }), /plain JSON data/);
  assert.deepEqual(graph.exportData(), before);

  const cyclic = {};
  cyclic.self = cyclic;
  assert.throws(() => graph.addFact({ id: 'cyclic-fact', project: 'app', key: 'bad', value: cyclic }), /circular structure/i);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.addDecision({
    id: 'bigint-decision', project: 'app', title: 'Bad', chosen: 'A', failedAttempts: [{ payload: 1n }]
  }), /serialize a BigInt/);
  assert.deepEqual(graph.exportData(), before);
});

test('empty project identifiers never become cross-project read wildcards', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  graph.addDecision({ project: 'alpha', title: 'Alpha', chosen: 'A', reviewAfter: '2020-01-01T00:00:00.000Z' });
  graph.addDecision({ project: 'beta', title: 'Beta', chosen: 'B', reviewAfter: '2020-01-01T00:00:00.000Z' });
  const before = graph.exportData();
  const calls = [
    () => graph.search('', { project: '' }),
    () => graph.retrieve('', { project: '' }),
    () => graph.getJournal({ project: '' }),
    () => graph.review({ project: '' }),
    () => graph.getReviewSignals({ project: '' }),
    () => graph.redact({ project: '' }),
    () => graph.context({ project: '' })
  ];
  for (const call of calls) assert.throws(call, /project must be a non-empty string/);
  assert.deepEqual(graph.exportData(), before);
});

test('caller-owned memory ids cannot overwrite an existing graph entity', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const decision = graph.addDecision({ id: 'shared-id', project: 'app', title: 'Keep this decision', chosen: 'A' });
  const before = graph.exportData();

  assert.throws(() => graph.remember({
    id: decision.id, project: 'app', memoryType: 'note', key: 'collision', text: 'Must not overwrite'
  }), /Entity id already exists/);
  assert.deepEqual(graph.exportData(), before);
});

test('memory plan reserves caller-owned ids before applying any operation', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  graph.addDecision({ id: 'reserved-id', project: 'app', title: 'Existing', chosen: 'A' });
  const before = graph.exportData();
  assert.throws(() => graph.applyMemoryPlan({
    project: 'app',
    operations: [
      { action: 'ADD', id: 'new-id', memoryType: 'note', key: 'first', text: 'Must not land' },
      { action: 'ADD', id: 'reserved-id', memoryType: 'note', key: 'second', text: 'Collision' }
    ]
  }), /Entity id already exists/);
  assert.deepEqual(graph.exportData(), before);
});

test('re-adding an invalidated memory continues its version history', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const first = graph.remember({ project: 'app', memoryType: 'note', key: 'rule', text: 'First' });
  graph.applyMemoryPlan({ project: 'app', operations: [{ action: 'DELETE', memoryType: 'note', key: 'rule' }] });
  const second = graph.remember({
    project: 'app', memoryType: 'note', key: 'rule', text: 'Second', validFrom: '2026-05-01T00:00:00.000Z'
  });

  assert.equal(first.memory.version, 1);
  assert.equal(second.memory.version, 2);
  assert.deepEqual(graph.memoryHistory({ project: 'app', memoryType: 'note', key: 'rule' }).items.map((item) => item.version), [1, 2]);
});

test('same-content retries can refresh a derived embedding without creating a memory version', () => {
  const graph = createShadowGraph({ now: () => '2026-04-01T00:00:00.000Z' });
  const added = graph.remember({ project: 'app', memoryType: 'note', key: 'route', text: 'Use trains', embedding: [1, 0] });
  const refreshed = graph.remember({ project: 'app', memoryType: 'note', key: 'route', text: 'Use trains', embedding: [0, 1] });

  assert.equal(refreshed.operation, 'NOOP');
  assert.equal(refreshed.indexUpdated, true);
  assert.deepEqual(refreshed.memory.embedding, [0, 1]);
  assert.equal(refreshed.memory.id, added.memory.id);
  assert.equal(graph.memoryHistory({ project: 'app', memoryType: 'note', key: 'route' }).items.length, 1);
  assert.equal(graph.recall('', { project: 'app', queryEmbedding: [0, 1] }).items[0].scores.semantic, 1);
  assert.deepEqual(graph.rebuild().projection.records.find((record) => record.id === added.memory.id).embedding, [0, 1]);
});

test('maintenance closes an expired fact interval before review and recall', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  const decision = graph.addDecision({
    project: 'app', title: 'Single-user mode', chosen: 'SQLite',
    alternatives: [{ label: 'Postgres', reasonRejected: 'No multi-user need', reopenWhen: [{ key: 'multi-user', value: true }] }]
  });
  const fact = graph.addFact({
    project: 'app', key: 'multi-user', value: true,
    validFrom: '2026-01-01T00:00:00.000Z', expiresAt: '2026-02-01T00:00:00.000Z'
  });

  const maintenance = graph.maintain({ at: '2026-03-01T00:00:00.000Z' });
  const expired = graph.exportData().facts.find((item) => item.id === fact.id);
  assert.equal(maintenance.due.some((item) => item.decisionId === decision.id), false);
  assert.equal(expired.temporal.validTo, '2026-02-01T00:00:00.000Z');
  assert.equal(expired.temporal.invalidatedAt, '2026-03-01T00:00:00.000Z');
  assert.equal(graph.recall('multi user', { project: 'app', asOf: '2026-01-15T00:00:00.000Z' }).items.some((item) => item.record.id === fact.id), true);
  assert.equal(graph.recall('multi user', { project: 'app', asOf: '2026-03-01T00:00:00.000Z' }).items.some((item) => item.record.id === fact.id), false);
});

test('malformed persisted memory envelopes are rejected atomically', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.remember({ project: 'safe', memoryType: 'note', key: 'keep', text: 'Keep me' });
  const before = graph.exportData();
  assert.throws(() => graph.replaceData({ schemaVersion: '4', records: [] }), /schemaVersion must be an integer/);
  assert.deepEqual(graph.exportData(), before);
  const base = {
    id: 'bad-memory', kind: 'memory', schemaVersion: 4, project: 'bad',
    scope: { userId: null, agentId: null, runId: null }, memoryType: 'note',
    key: 'key', text: 'text', version: 1, status: 'active', metadata: {}, tags: [],
    embedding: null, temporal: {
      validFrom: '2026-01-01T00:00:00.000Z', validTo: null,
      recordedAt: '2026-01-01T00:00:00.000Z', invalidatedAt: null
    }
  };
  const invalid = [
    { ...base, key: '' },
    { ...base, metadata: [] },
    { ...base, tags: [42] },
    { ...base, version: 0 },
    { ...base, status: 'mystery' },
    { ...base, temporal: { ...base.temporal, validTo: '2025-12-01T00:00:00.000Z' } }
  ];

  for (const memory of invalid) {
    assert.throws(() => graph.replaceData({ schemaVersion: 4, records: [memory] }));
    assert.deepEqual(graph.exportData(), before);
  }
});

test('schema 4 restore rejects orphaned review signals', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'kept-decision', project: 'A', title: 'Keep', chosen: 'A' });
  const before = graph.exportData();
  const payload = {
    ...before,
    reviewSignals: [{ id: 'orphan-review', kind: 'review', decisionId: 'missing-decision', reason: 'orphan', status: 'open' }]
  };
  assert.throws(() => graph.replaceData(payload), /Review signal must reference an existing decision/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 restore rejects duplicate review signal ids', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'kept-decision', project: 'A', title: 'Keep', chosen: 'A' });
  const before = graph.exportData();
  const payload = {
    ...before,
    reviewSignals: [
      { id: 'same-review-id', kind: 'review', decisionId: 'kept-decision', reason: 'one', status: 'open' },
      { id: 'same-review-id', kind: 'review', decisionId: 'kept-decision', reason: 'two', status: 'open' }
    ]
  };
  assert.throws(() => graph.replaceData(payload), /Duplicate review signal id/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 restore rejects duplicate review signal identities', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'reviewed-decision', project: 'A', title: 'Keep', chosen: 'A' });
  const before = graph.exportData();
  const payload = {
    ...before,
    reviewSignals: [
      { id: 'review-one', kind: 'review', decisionId: 'reviewed-decision', reason: 'same', status: 'open' },
      { id: 'review-two', kind: 'review', decisionId: 'reviewed-decision', reason: 'same', status: 'acknowledged' }
    ]
  };
  assert.throws(() => graph.replaceData(payload), /Duplicate review signal identity/);
  assert.deepEqual(graph.exportData(), before);
});

test('review signal identity cannot collide across delimiter-bearing values', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'x:y', project: 'app', title: 'First', chosen: 'A', alternatives: [{ label: 'B', reopenWhen: ['z'] }] });
  graph.addDecision({ id: 'x', project: 'app', title: 'Second', chosen: 'A', alternatives: [{ label: 'B', reopenWhen: ['y:z'] }] });

  const due = graph.review({ project: 'app', changedFacts: ['z', 'y:z'] });
  assert.equal(due.length, 2);
  assert.equal(graph.getReviewSignals({ project: 'app' }).length, 2);
  assert.equal(graph.exportData().reviewSignals.length, 2);
});

test('schema 4 restore rejects duplicate compatibility event ids', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'kept-decision', project: 'A', title: 'Keep', chosen: 'A' });
  const before = graph.exportData();
  const duplicate = structuredClone(before.events[0]);
  const payload = { ...before, events: [before.events[0], duplicate] };
  assert.throws(() => graph.replaceData(payload), /Duplicate event id/);
  assert.deepEqual(graph.exportData(), before);
});

test('all supported schemas reject duplicate idempotency keys', () => {
  for (const schemaVersion of [1, 2, 3, 4]) {
    const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
    const first = graph.addDecision({ id: `idem-first-${schemaVersion}`, project: 'app', title: 'First', chosen: 'A' });
    const second = graph.addDecision({ id: `idem-second-${schemaVersion}`, project: 'app', title: 'Second', chosen: 'B' });
    const before = graph.exportData();
    const payload = {
      ...before,
      schemaVersion,
      idempotency: [
        { key: 'decision:app:retry', value: first },
        { key: 'decision:app:retry', value: second }
      ]
    };
    assert.throws(() => graph.replaceData(payload), /Duplicate idempotency key/);
    assert.deepEqual(graph.exportData(), before);
  }
});

test('legacy idempotency keys cannot collide after canonicalization', () => {
  for (const schemaVersion of [1, 2, 3]) {
    const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
    const first = graph.addDecision({ id: `legacy-idem-first-${schemaVersion}`, project: 'app', title: 'First', chosen: 'A' });
    const second = graph.addDecision({ id: `legacy-idem-second-${schemaVersion}`, project: 'app', title: 'Second', chosen: 'B' });
    const before = graph.exportData();
    const payload = {
      ...before,
      schemaVersion,
      idempotency: [
        { key: 'decision:retry', value: first },
        { key: 'decision:app:retry', value: second }
      ]
    };
    assert.throws(() => graph.replaceData(payload), /Duplicate canonical idempotency key/);
    assert.deepEqual(graph.exportData(), before);
  }
});

test('schema 4 restore rejects idempotency entries for missing entities', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'kept-decision', project: 'A', title: 'Keep', chosen: 'A' });
  const before = graph.exportData();
  const payload = {
    ...before,
    idempotency: [{
      key: 'decision:A:retry',
      value: { id: 'ghost', kind: 'decision', project: 'B', title: 'Secret', chosen: 'B' }
    }]
  };
  assert.throws(() => validateRestorePayload(payload, { now: () => '2026-03-01T00:00:00.000Z' }), /Idempotency entry must reference an existing entity/);
  assert.throws(() => graph.replaceData(payload), /Idempotency entry must reference an existing entity/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 restore rejects memory idempotency keys for a different scope', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  const memory = graph.remember({
    id: 'alice-memory', project: 'app', scope: { userId: 'alice' },
    memoryType: 'note', key: 'k', text: 'Alice secret'
  }).memory;
  const before = graph.exportData();
  const payload = {
    ...before,
    idempotency: [{
      key: 'memory:app:["bob",null,null,"note","k"]:retry',
      value: memory
    }]
  };
  assert.throws(() => graph.replaceData(payload), /Idempotency entry identity does not match its entity/);
  assert.deepEqual(graph.exportData(), before);
});

test('merge import never decreases the live revision', () => {
  const graph = createShadowGraph();
  graph.setRevision(10);
  graph.importData({ schemaVersion: 4, revision: 1, records: [] });
  assert.equal(graph.exportData().revision, 10);
});

test('merge import never regresses a declared journal sequence high-water mark', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.importData({ schemaVersion: 4, journal: [], journalSeq: 100 });
  graph.importData({
    schemaVersion: 4,
    journal: [{
      id: 'older-journal-entry', seq: 50, type: 'legacy_metadata_event', schemaVersion: 4,
      project: null, entityKind: null, entityId: null, payload: null
    }],
    journalSeq: 50,
    journalEpoch: 50
  });
  graph.addFact({ project: 'app', key: 'after-high-water', value: true });
  assert.equal(graph.exportData().journal.at(-1).seq, 101);
  assert.equal(graph.exportData().journalSeq, 101);
});

test('persisted entity ids must be unique within the records collection', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.remember({ project: 'safe', memoryType: 'note', key: 'keep', text: 'Keep me' });
  const before = graph.exportData();
  const decision = {
    id: 'duplicate-id', kind: 'decision', schemaVersion: 4, project: 'app',
    title: 'Decision', chosen: 'A', alternatives: []
  };
  const memory = {
    id: 'duplicate-id', kind: 'memory', schemaVersion: 4, project: 'app',
    scope: { userId: null, agentId: null, runId: null }, memoryType: 'note',
    key: 'same-id', text: 'Must not overwrite', version: 1, status: 'active'
  };

  assert.throws(() => graph.replaceData({ schemaVersion: 4, records: [decision, memory] }), /Duplicate entity id/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 entity ids are globally unique so JSON and SQLite accept the same graph', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addFact({ id: 'shared-id', project: 'app', key: 'mode', value: 'safe' });
  const before = graph.exportData();
  assert.throws(() => graph.remember({
    id: 'shared-id', project: 'app', memoryType: 'note', key: 'collision', text: 'Must not land'
  }), /Entity id already exists/);
  assert.deepEqual(graph.exportData(), before);

  const reverse = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  reverse.remember({ id: 'record-id', project: 'app', memoryType: 'note', key: 'record', text: 'Record' });
  const reverseBefore = reverse.exportData();
  assert.throws(() => reverse.addFact({ id: 'record-id', project: 'app', key: 'fact', value: true }), /Entity id already exists/);
  assert.deepEqual(reverse.exportData(), reverseBefore);

  reverse.addDecision({ id: 'from-id', project: 'app', title: 'From', chosen: 'A' });
  reverse.addDecision({ id: 'to-id', project: 'app', title: 'To', chosen: 'B' });
  const beforeRelation = reverse.exportData();
  assert.throws(() => reverse.link({ id: 'record-id', from: 'from-id', to: 'to-id', relation: 'supports' }), /Entity id already exists/);
  assert.deepEqual(reverse.exportData(), beforeRelation);

  const memory = {
    id: 'cross-id', kind: 'memory', schemaVersion: 4, project: 'app',
    scope: { userId: null, agentId: null, runId: null }, memoryType: 'note',
    key: 'memory', text: 'Memory', version: 1, status: 'active'
  };
  const fact = { id: 'cross-id', kind: 'fact', schemaVersion: 4, project: 'app', key: 'fact', value: true };
  assert.throws(() => graph.replaceData({ schemaVersion: 4, records: [memory], facts: [fact] }), /Duplicate entity id/);
  assert.deepEqual(graph.exportData(), before);
});

test('alternative ids share the schema 4 entity namespace and cannot target another project', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.remember({ id: 'shared-alternative-id', project: 'project-b', memoryType: 'note', key: 'protected', text: 'Protected' });
  const before = graph.exportData();
  assert.throws(() => graph.addDecision({
    id: 'decision-a', project: 'project-a', title: 'Decision A', chosen: 'A',
    alternatives: [{ id: 'shared-alternative-id', label: 'B', reasonRejected: 'No' }]
  }), /Entity id already exists/);
  assert.deepEqual(graph.exportData(), before);

  const source = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  const importedMemory = source.remember({ id: 'import-shared-id', project: 'project-b', memoryType: 'note', key: 'protected', text: 'Protected' }).memory;
  const importedDecision = source.addDecision({
    id: 'import-decision', project: 'project-a', title: 'Decision A', chosen: 'A',
    alternatives: [{ id: 'initial-alternative-id', label: 'B', reasonRejected: 'No' }]
  });
  const payload = source.exportData();
  payload.records.find((record) => record.id === importedDecision.id).alternatives[0].id = importedMemory.id;
  assert.throws(() => graph.replaceData(payload), /Duplicate entity id/);
  assert.deepEqual(graph.exportData(), before);
});

test('direct link refuses missing endpoints before journaling or persistence', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'present', project: 'app', title: 'Present', chosen: 'A' });
  const before = graph.exportData();
  assert.throws(() => graph.link({ from: 'present', to: 'missing', relation: 'supports' }), /Relation endpoints must exist/);
  assert.deepEqual(graph.exportData(), before);
});

test('journal rebuild preserves relations whose endpoint is a nested alternative', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  const decision = graph.addDecision({
    id: 'decision-with-alt', project: 'app', title: 'Choose', chosen: 'A',
    alternatives: [{ id: 'alternative-b', label: 'B', reasonRejected: 'No' }]
  });
  graph.link({ id: 'alt-link', from: decision.id, to: 'alternative-b', relation: 'rejects' });
  const rebuilt = graph.rebuild();
  assert.equal(rebuilt.rebuildable, true);
  assert.equal(rebuilt.projection.relations.some((relation) => relation.id === 'alt-link'), true);
});

test('schema 4 merge cannot remove an alternative used by a live relation', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({
    id: 'decision-with-used-alt', project: 'app', title: 'Choose', chosen: 'A',
    alternatives: [{ id: 'used-alternative', label: 'B', reasonRejected: 'No' }]
  });
  graph.link({ id: 'used-alt-link', from: 'decision-with-used-alt', to: 'used-alternative', relation: 'rejects' });
  const before = graph.exportData();
  const changed = { ...before.records.find((record) => record.id === 'decision-with-used-alt'), alternatives: [] };
  assert.throws(() => graph.importData({ schemaVersion: 4, records: [changed] }), /Relation endpoints must exist after import/);
  assert.deepEqual(graph.exportData(), before);
});

test('temporal inputs must be strings before any memory or fact write', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  const before = graph.exportData();
  assert.throws(() => graph.remember({
    project: 'app', memoryType: 'note', key: 'bad-time', text: 'Bad', validFrom: { attacker: true }
  }), /validFrom must be a string or null/);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.applyMemoryPlan({
    project: 'app',
    operations: [{ action: 'ADD', memoryType: 'note', key: 'bad-plan-time', text: 'Bad', validFrom: { attacker: true } }]
  }), /validFrom must be a string or null/);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.addFact({
    project: 'app', key: 'bad-fact-time', value: true, validFrom: { attacker: true }
  }), /validFrom must be a string or null/);
  assert.deepEqual(graph.exportData(), before);
});

test('decision and attempt timestamps are validated before runtime mutation', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  const before = graph.exportData();
  assert.throws(() => graph.addDecision({ project: 'app', title: 'Bad', chosen: 'A', reviewAfter: 'not-a-timestamp' }), /reviewAfter must be a valid timestamp/);
  assert.deepEqual(graph.exportData(), before);
  assert.throws(() => graph.addAttempt({ project: 'app', solution: 'Bad', result: 'failed', createdAt: 'not-a-timestamp' }), /createdAt must be a valid timestamp/);
  assert.deepEqual(graph.exportData(), before);
  assert.throws(() => graph.remember({ project: 'app', memoryType: 'note', key: 'bad-calendar', text: 'Bad', validFrom: '2026-02-30T00:00:00.000Z' }), /validFrom must be a valid timestamp/);
  assert.deepEqual(graph.exportData(), before);
  assert.throws(() => graph.remember({ project: 'app', memoryType: 'note', key: 'implementation-date', text: 'Bad', validFrom: 'March 1, 2026' }), /validFrom must be a valid timestamp/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 restore rejects non-timestamp memory temporal strings', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.remember({ project: 'safe', memoryType: 'note', key: 'keep', text: 'Keep me' });
  const before = graph.exportData();
  const memory = {
    id: 'bad-time-memory', kind: 'memory', schemaVersion: 4, project: 'app',
    scope: { userId: null, agentId: null, runId: null }, memoryType: 'note',
    key: 'bad-time', text: 'Bad', status: 'active', version: 1,
    temporal: { validFrom: 'not-a-timestamp', validTo: null, recordedAt: 'also-bad', invalidatedAt: null }
  };
  assert.throws(() => graph.replaceData({ schemaVersion: 4, records: [memory] }), /validFrom must be a valid timestamp/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 restore rejects malformed fact and relation temporal fields atomically', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.remember({ project: 'safe', memoryType: 'note', key: 'keep', text: 'Keep me' });
  const before = graph.exportData();

  assert.throws(() => graph.replaceData({
    schemaVersion: 4,
    facts: [{ id: 'bad-fact', kind: 'fact', schemaVersion: 4, project: 'app', key: 'mode', value: true, temporal: { validFrom: { attacker: true } } }]
  }), /validFrom must be a string or null/);
  assert.deepEqual(graph.exportData(), before);

  const records = [
    { id: 'from', kind: 'decision', schemaVersion: 4, project: 'app', title: 'From', chosen: 'A', alternatives: [] },
    { id: 'to', kind: 'decision', schemaVersion: 4, project: 'app', title: 'To', chosen: 'B', alternatives: [] }
  ];
  assert.throws(() => graph.replaceData({
    schemaVersion: 4,
    records,
    relations: [{ id: 'bad-relation', kind: 'relation', schemaVersion: 4, from: 'from', to: 'to', relation: 'supports', temporal: { validFrom: { attacker: true } } }]
  }), /validFrom must be a string or null/);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.replaceData({
    schemaVersion: 4,
    facts: [{
      id: 'reversed-fact', kind: 'fact', schemaVersion: 4, project: 'app', key: 'mode', value: true,
      temporal: { validFrom: '2026-09-01T00:00:00.000Z', validTo: '2026-08-01T00:00:00.000Z' }
    }]
  }), /Stored fact validTo must not precede validFrom/);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.replaceData({
    schemaVersion: 4,
    records,
    relations: [{
      id: 'reversed-relation', kind: 'relation', schemaVersion: 4, from: 'from', to: 'to', relation: 'supports',
      temporal: { validFrom: '2026-09-01T00:00:00.000Z', validTo: '2026-08-01T00:00:00.000Z' }
    }]
  }), /Stored relation validTo must not precede validFrom/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 import rejects malformed projects and alternative ids before merge', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'keep', project: 'safe', title: 'Keep', chosen: 'A' });
  const before = graph.exportData();
  const decision = {
    id: 'bad-decision', kind: 'decision', schemaVersion: 4, project: { tenant: 'bad' },
    title: 'Bad', chosen: 'A', alternatives: [], status: 'active', confidence: { initial: 0.5, current: 0.5, history: [] }
  };
  const badAlternative = {
    ...decision, id: 'bad-alternative-decision', project: 'app',
    alternatives: [{ id: { attacker: true }, label: 'Bad alternative', reopenWhen: [] }]
  };
  const badFact = { id: 'bad-fact-project', kind: 'fact', schemaVersion: 4, project: '', key: 'bad', value: true };
  const emptyRecordId = { ...decision, id: '', project: 'app' };

  for (const payload of [
    { schemaVersion: 4, records: [decision] },
    { schemaVersion: 4, records: [badAlternative] },
    { schemaVersion: 4, records: [emptyRecordId] },
    { schemaVersion: 4, facts: [badFact] }
  ]) {
    assert.throws(() => graph.importData(payload), /project must be a non-empty string|id must be a non-empty string/i);
    assert.deepEqual(graph.exportData(), before);
  }
});

test('schema 4 merge import rejects cross-collection ids already present in live state', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'live-id', project: 'safe', title: 'Live', chosen: 'A' });
  const before = graph.exportData();
  assert.throws(() => graph.importData({
    schemaVersion: 4,
    facts: [{ id: 'live-id', kind: 'fact', schemaVersion: 4, project: 'safe', key: 'collision', value: true }]
  }), /Entity id already exists/);
  assert.deepEqual(graph.exportData(), before);

  const collidingMemory = {
    id: 'live-id', kind: 'memory', schemaVersion: 4, project: 'safe',
    scope: { userId: null, agentId: null, runId: null }, memoryType: 'note', key: 'collision', text: 'Collision', version: 1, status: 'active'
  };
  assert.throws(() => graph.importData({ schemaVersion: 4, records: [collidingMemory] }), /Existing entity id live-id cannot change kind or project/);
  assert.deepEqual(graph.exportData(), before);

  const movedDecision = { ...before.records.find((record) => record.id === 'live-id'), project: 'other', title: 'Moved' };
  assert.throws(() => graph.importData({ schemaVersion: 4, records: [movedDecision] }), /Existing entity id live-id cannot change kind or project/);
  assert.deepEqual(graph.exportData(), before);

  const existingEntry = before.journal[0];
  assert.throws(() => graph.importData({ schemaVersion: 4, journal: [{ ...existingEntry }] }), /Journal id or sequence already exists/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 merge import cannot change an existing memory identity', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.remember({
    id: 'immutable-memory', project: 'app', scope: { userId: 'alice' },
    memoryType: 'profile', key: 'email', text: 'Alice secret'
  });
  const before = graph.exportData();
  const changed = {
    ...before.records.find((record) => record.id === 'immutable-memory'),
    scope: { userId: 'bob', agentId: null, runId: null }
  };
  assert.throws(() => graph.importData({ schemaVersion: 4, records: [changed] }), /Existing memory id immutable-memory cannot change scope, type, or key/);
  assert.deepEqual(graph.exportData(), before);
});

test('schema 4 merge import rejects dangling relations before mutation', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'present-import-node', project: 'safe', title: 'Present', chosen: 'A' });
  const before = graph.exportData();
  assert.throws(() => graph.importData({
    schemaVersion: 4,
    relations: [{ id: 'dangling-import', kind: 'relation', schemaVersion: 4, from: 'missing-a', to: 'missing-b', relation: 'supports' }]
  }), /Relation endpoints must exist before import/);
  assert.deepEqual(graph.exportData(), before);
});

test('large schema 4 journal import avoids call-stack failure and partial mutation', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'keep-large-import', project: 'safe', title: 'Keep', chosen: 'A' });
  const journal = Array.from({ length: 150000 }, (_, index) => ({
    id: `large-journal-${index}`, seq: index + 2, type: 'legacy_metadata_event',
    schemaVersion: 4, project: null, entityKind: null, entityId: null, payload: null
  }));
  assert.doesNotThrow(() => graph.importData({ schemaVersion: 4, journal, journalSeq: journal.length + 1, journalEpoch: 1 }));
  assert.equal(graph.exportData().journal.length, journal.length + 1);
  assert.equal(graph.exportData().records.some((record) => record.id === 'keep-large-import'), true);
});

test('schema 4 direct import rejects duplicate incoming journal sequences atomically', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addDecision({ id: 'keep-sequence', project: 'safe', title: 'Keep', chosen: 'A' });
  const before = graph.exportData();
  const entry = {
    type: 'legacy_metadata_event', schemaVersion: 4, seq: 2,
    project: null, entityKind: null, entityId: null, payload: null
  };
  assert.throws(() => graph.importData({
    schemaVersion: 4,
    journal: [{ ...entry, id: 'incoming-seq-a' }, { ...entry, id: 'incoming-seq-b' }],
    journalSeq: 2, journalEpoch: 2
  }), /Duplicate journal sequence/);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.importData({
    schemaVersion: 4,
    journal: [{ ...entry, id: 'unsafe-seq', seq: Number.MAX_SAFE_INTEGER + 1 }],
    journalSeq: 2,
    journalEpoch: 1
  }), /seq must be a positive safe integer/);
  assert.deepEqual(graph.exportData(), before);

  assert.throws(() => graph.importData({ schemaVersion: 4, journal: [], journalSeq: Number.MAX_SAFE_INTEGER + 1 }), /journalSeq must be a non-negative safe integer/);
  assert.deepEqual(graph.exportData(), before);
});

test('merge import rebuilds the current-memory index instead of retaining overwritten private payloads', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.remember({
    id: 'same-memory-id', project: 'app', scope: { userId: 'alice' },
    memoryType: 'profile', key: 'email', text: 'old-secret@example.test',
    validFrom: '2026-01-01T00:00:00.000Z'
  });
  graph.importData({
    schemaVersion: 4,
    records: [{
      id: 'same-memory-id', kind: 'memory', schemaVersion: 4, project: 'app',
      scope: { userId: 'alice', agentId: null, runId: null }, memoryType: 'profile',
      key: 'email', text: 'invalidated placeholder', version: 1, status: 'invalidated',
      metadata: {}, tags: [], embedding: null,
      temporal: {
        validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z',
        recordedAt: '2026-01-01T00:00:00.000Z', invalidatedAt: '2026-02-01T00:00:00.000Z'
      }
    }]
  });

  const journalLengthAfterImport = graph.exportData().journal.length;
  const result = graph.remember({
    project: 'app', scope: { userId: 'alice' }, memoryType: 'profile', key: 'email',
    text: 'new@example.test', validFrom: '2026-03-01T00:00:00.000Z'
  });
  const after = graph.exportData();
  assert.equal(result.operation, 'ADD');
  assert.equal(after.records.some((record) => record.text === 'old-secret@example.test'), false);
  assert.equal(JSON.stringify(after.journal.slice(journalLengthAfterImport)).includes('old-secret@example.test'), false);
});

test('supersession and invalidation never extend an already-ended validity interval', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  const memory = graph.remember({
    project: 'app', memoryType: 'note', key: 'season', text: 'Winter',
    validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z'
  }).memory;
  graph.remember({
    project: 'app', memoryType: 'note', key: 'season', text: 'Spring',
    validFrom: '2026-03-01T00:00:00.000Z'
  });
  assert.equal(graph.memoryHistory({ project: 'app', memoryType: 'note', key: 'season' }).items.find((item) => item.id === memory.id).temporal.validTo, '2026-02-01T00:00:00.000Z');

  const deleted = graph.remember({
    project: 'app', memoryType: 'note', key: 'ended', text: 'Ended',
    validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z'
  }).memory;
  graph.applyMemoryPlan({ project: 'app', operations: [{ action: 'DELETE', memoryType: 'note', key: 'ended', validAt: '2026-03-01T00:00:00.000Z' }] });
  assert.equal(graph.memoryHistory({ project: 'app', memoryType: 'note', key: 'ended' }).items.find((item) => item.id === deleted.id).temporal.validTo, '2026-02-01T00:00:00.000Z');

  const fact = graph.addFact({
    project: 'app', key: 'mode', value: 'winter',
    validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z'
  });
  graph.addFact({ project: 'app', key: 'mode', value: 'spring', validFrom: '2026-03-01T00:00:00.000Z' });
  assert.equal(graph.exportData().facts.find((item) => item.id === fact.id).temporal.validTo, '2026-02-01T00:00:00.000Z');
});

test('same-content memory writes still validate and apply explicit temporal changes', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  const first = graph.remember({
    project: 'app', memoryType: 'note', key: 'policy', text: 'Same text',
    validFrom: '2026-01-01T00:00:00.000Z'
  });
  const beforeInvalid = graph.exportData();
  assert.throws(() => graph.remember({
    project: 'app', memoryType: 'note', key: 'policy', text: 'Same text',
    validFrom: '2026-04-01T00:00:00.000Z', validTo: '2026-02-01T00:00:00.000Z'
  }), /Memory validTo must be later than validFrom/);
  assert.deepEqual(graph.exportData(), beforeInvalid);

  const reasserted = graph.remember({
    project: 'app', memoryType: 'note', key: 'policy', text: 'Same text',
    validFrom: '2026-04-01T00:00:00.000Z'
  });
  assert.equal(reasserted.operation, 'UPDATE');
  assert.equal(reasserted.memory.version, 2);
  assert.equal(reasserted.previous.id, first.memory.id);
});

test('semantic recall requires embedding model compatibility, not dimension alone', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.remember({
    project: 'app', memoryType: 'note', key: 'route', text: 'Use trains',
    embedding: { model: 'model-a', values: [1, 0] }
  });

  const mismatch = graph.recall('', {
    project: 'app', queryEmbedding: { model: 'model-b', values: [1, 0] }
  });
  assert.equal(mismatch.signals.semantic.available, false);
  assert.match(mismatch.signals.semantic.reason, /model and dimension/);
  assert.equal(mismatch.items.length, 0);

  const compatible = graph.recall('', {
    project: 'app', queryEmbedding: { model: 'model-a', values: [1, 0] }
  });
  assert.equal(compatible.signals.semantic.available, true);
  assert.equal(compatible.items[0].scores.semantic, 1);
});

test('journal-bearing schema 3 snapshots remain restorable after schema 4 migration', () => {
  const now = () => '2026-03-01T00:00:00.000Z';
  const legacy = createShadowGraph({ now });
  legacy.addDecision({ id: 'legacy-decision', project: 'app', title: 'Legacy', chosen: 'A' });
  const payload = legacy.exportData();
  payload.schemaVersion = 3;
  payload.records = payload.records.map((record) => ({ ...record, schemaVersion: 3 }));
  payload.journal = payload.journal.map((entry) => ({
    ...entry,
    schemaVersion: 3,
    payload: entry.payload ? { ...entry.payload, schemaVersion: 3 } : entry.payload
  }));

  assert.doesNotThrow(() => validateRestorePayload(payload, { now }));
});

test('an unrelated empty hard-purge marker cannot excuse arbitrary journal gaps', () => {
  const now = () => '2026-03-01T00:00:00.000Z';
  const graph = createShadowGraph({ now });
  const kept = graph.addDecision({ id: 'kept', project: 'kept', title: 'Kept', chosen: 'A' });
  const removed = graph.addDecision({ id: 'removed', project: 'removed', title: 'Removed', chosen: 'B' });
  const payload = graph.exportData();
  payload.records = payload.records.filter((record) => record.id !== removed.id);
  payload.journal = payload.journal.filter((entry) => entry.entityId !== removed.id);
  payload.journal.push({
    id: 'fake-purge', type: 'project.purged', schemaVersion: 5, seq: 3,
    at: '2026-03-01T00:00:00.000Z', entityKind: 'project', entityId: null,
    project: 'unrelated-empty',
    payload: { project: 'unrelated-empty', mode: 'hard', removed: 0, removedJournalSequences: [] },
    provenance: { actor: null, client: null, sessionId: null }
  });
  payload.journalSeq = 3;
  payload.journalEpoch = 1;
  assert.equal(payload.records[0].id, kept.id);

  assert.throws(() => validateRestorePayload(payload, { now }), /hard purge does not explain journal sequence/);
});

test('restore rejects huge hard-purge gaps without expanding every missing sequence', () => {
  const now = () => '2026-03-01T00:00:00.000Z';
  const graph = createShadowGraph({ now });
  graph.addDecision({ id: 'gap-kept', project: 'kept', title: 'Kept', chosen: 'A' });
  const payload = graph.exportData();
  payload.journal.push({
    id: 'huge-gap-marker', seq: 100002, type: 'project.purged', schemaVersion: 5,
    at: '2026-03-01T00:00:00.000Z', project: 'other', entityKind: 'project', entityId: null,
    payload: {
      project: 'other', mode: 'hard', removed: 0,
      removedJournalSequences: [2]
    },
    provenance: { actor: null, client: null, sessionId: null }
  });
  payload.journalSeq = 100002;
  assert.throws(() => validateRestorePayload(payload, { now }), /hard purge ledger cannot cover declared gap/);
});

test('restore rejects journal identity mismatches and duplicate journal ids', () => {
  const now = () => '2026-03-01T00:00:00.000Z';
  const graph = createShadowGraph({ now });
  graph.addDecision({ id: 'journal-record', project: 'app', title: 'Journal', chosen: 'A' });
  const mismatched = graph.exportData();
  mismatched.journal[0].entityId = 'different-entity';
  assert.throws(() => validateRestorePayload(mismatched, { now }), /journal.*entityId.*payload\.id/i);

  const wrongProject = graph.exportData();
  wrongProject.journal[0].project = 'other';
  assert.throws(() => validateRestorePayload(wrongProject, { now }), /journal.*project.*payload\.project/i);

  const wrongKind = graph.exportData();
  wrongKind.journal[0].entityKind = 'attempt';
  wrongKind.journal[0].type = 'attempt.recorded';
  assert.throws(() => validateRestorePayload(wrongKind, { now }), /journal.*entityKind.*payload\.kind/i);

  for (const schemaVersion of [1, 2, 3, 4]) {
    const wrongType = graph.exportData();
    wrongType.schemaVersion = schemaVersion;
    wrongType.journal[0] = { ...wrongType.journal[0], schemaVersion, type: 'attempt.recorded' };
    assert.throws(() => validateRestorePayload(wrongType, { now }), /journal.*type.*entityKind/i);
  }

  const duplicated = graph.exportData();
  const duplicate = structuredClone(duplicated.journal[0]);
  duplicate.seq = 2;
  duplicated.journal.push(duplicate);
  duplicated.journalSeq = 2;
  assert.throws(() => validateRestorePayload(duplicated, { now }), /duplicate journal id/i);

  const schema3Base = graph.exportData();
  const schema3Mismatch = {
    ...schema3Base,
    schemaVersion: 3,
    journal: schema3Base.journal.map((entry) => ({ ...entry, schemaVersion: 3 }))
  };
  schema3Mismatch.journal[0].entityId = 'different-entity';
  assert.throws(() => validateRestorePayload(schema3Mismatch, { now }), /entityId.*payload\.id/i);

  const schema3DuplicateIds = {
    ...schema3Base,
    schemaVersion: 3,
    journal: [
      { ...schema3Base.journal[0], schemaVersion: 3, id: 'duplicate-schema3-journal-id', seq: 1 },
      { ...schema3Base.journal[0], schemaVersion: 3, id: 'duplicate-schema3-journal-id', seq: 2 }
    ],
    journalSeq: 2
  };
  assert.throws(() => validateRestorePayload(schema3DuplicateIds, { now }), /duplicate journal id/i);
});

test('direct journal rebuild rejects type and entity-kind mismatches', () => {
  const report = rebuildProjection([
    { id: 'valid', seq: 1, type: 'decision.recorded', schemaVersion: 4, project: 'app', entityKind: 'decision', entityId: 'decision-one', payload: { id: 'decision-one', kind: 'decision', project: 'app', title: 'Valid', chosen: 'A', alternatives: [] } },
    { id: 'mismatch', seq: 2, type: 'attempt.recorded', schemaVersion: 4, project: 'app', entityKind: 'fact', entityId: 'fact-one', payload: { id: 'fact-one', kind: 'fact', project: 'app', key: 'k', value: true } }
  ], { journalEpoch: 1 });
  assert.equal(report.rebuildable, false);
  assert.equal(report.projection.records.length, 1);
  assert.equal(report.projection.facts.length, 0);
  assert.equal(report.skipped.some((item) => item.why === 'type_entity_kind_mismatch'), true);
});

test('legacy merge import cannot create schema 4 cross-collection id collisions', () => {
  const graph = createShadowGraph({ now: () => '2026-03-01T00:00:00.000Z' });
  graph.addFact({ id: 'legacy-shared-id', project: 'safe', key: 'keep', value: true });
  const before = graph.exportData();
  assert.throws(() => graph.importData({
    schemaVersion: 3,
    records: [{
      id: 'legacy-shared-id', kind: 'memory', project: 'safe',
      scope: { userId: null, agentId: null, runId: null }, memoryType: 'note', key: 'collision', text: 'Must not land', status: 'active', version: 1
    }]
  }), /Entity id already exists|Duplicate entity id/);
  assert.deepEqual(graph.exportData(), before);
});

test('legacy collision migration remaps dependent journal and idempotency identities', () => {
  const now = () => '2026-03-01T00:00:00.000Z';
  const source = createShadowGraph({ now });
  source.addDecision({ id: 'legacy-shared', project: 'app', title: 'Decision', chosen: 'A' });
  source.addFact({ id: 'legacy-fact-original', project: 'app', key: 'mode', value: 'safe', idempotencyKey: 'fact-retry' });
  const payload = source.exportData();
  payload.schemaVersion = 3;
  payload.records = payload.records.map((record) => ({ ...record, schemaVersion: 3 }));
  payload.facts = payload.facts.map((fact) => ({ ...fact, id: 'legacy-shared', schemaVersion: 3 }));
  payload.idempotency = payload.idempotency.map((item) => ({ ...item, value: { ...item.value, id: 'legacy-shared', schemaVersion: 3 } }));
  payload.journal = payload.journal.map((entry) => entry.entityKind === 'fact'
    ? { ...entry, schemaVersion: 3, entityId: 'legacy-shared', payload: { ...entry.payload, id: 'legacy-shared', schemaVersion: 3 } }
    : { ...entry, schemaVersion: 3, payload: entry.payload ? { ...entry.payload, schemaVersion: 3 } : entry.payload });

  assert.doesNotThrow(() => validateRestorePayload(payload, { now }));
  const restored = createShadowGraph({ now });
  restored.replaceData(payload);
  const exported = restored.exportData();
  const migratedFact = exported.facts[0];
  assert.notEqual(migratedFact.id, 'legacy-shared');
  assert.equal(exported.idempotency[0].value.id, migratedFact.id);
  const factJournal = exported.journal.find((entry) => entry.entityKind === 'fact');
  assert.equal(factJournal.entityId, migratedFact.id);
  assert.equal(factJournal.payload.id, migratedFact.id);
});

test('hard-purge sequence evidence survives later hard and logical purges of the same project', () => {
  const now = () => '2026-03-01T00:00:00.000Z';
  for (const secondMode of ['hard', 'logical']) {
    const graph = createShadowGraph({ now });
    graph.addDecision({ id: `gone-${secondMode}`, project: 'gone', title: 'Gone', chosen: 'A' });
    graph.purgeProject('gone', { mode: 'hard' });
    graph.purgeProject('gone', { mode: secondMode });
    assert.doesNotThrow(() => validateRestorePayload(graph.exportData(), { now }));
  }
});
