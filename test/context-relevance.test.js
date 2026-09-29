import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedSnapshot, privilegedIssueAccess } from '../src/internal/snapshot.js';
import { historicalRelation } from '../tools/historical-relation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// Plan v1.4.4 PR-26 (§17.2-17.4; G-5 §9; AC-063, AC-020, AC-035): the default
// read ranks relevant history through the hybrid engine over the read boundary,
// delivers it head first, and falls back to the working set, declared, when no
// signal establishes relevance.
const NOW = '2026-03-01T00:00:00.000Z';
const idOf = (item) => item.record?.id ?? item.line?.recordId;
const mcpPath = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
// A relation across a project boundary, as a store written before such relations were refused holds it.
const importHistoricalRelation = (graph, relation) => graph.importData(historicalRelation({ ...relation, seq: privilegedSnapshot(graph).journalSeq + 1, at: NOW }));
const auditedRecords = (graph) => privilegedSnapshot(graph).events.filter((event) => event.type === 'access.used').map((event) => event.recordsReturnedTotal);

function fixture() {
  const graph = createShadowGraph({ now: () => NOW });
  // AC-063, one fixture each: a rejected approach whose reasons still hold, a
  // recorded success, a failure with environment and evidence but no
  // conditions, and a condition that evaluates to unknown.
  const queue = graph.addDecision({
    project: 'alpha', title: 'message queue', chosen: 'postgres outbox',
    alternatives: [{ label: 'kafka cluster', reasonRejected: 'operational cost for a two-person team', reopenWhen: [{ key: 'team_size', operator: 'greater_than', value: 10 }] }]
  });
  graph.addFact({ project: 'alpha', key: 'team_size', value: 2 });
  const success = graph.addAttempt({ project: 'alpha', solution: 'blue-green deploy behind health gates', result: 'zero downtime release', resultClass: 'succeeded' });
  const failure = graph.addAttempt({ project: 'alpha', solution: 'bulk backfill in one transaction', result: 'failed: lock timeout', resultClass: 'failed', reason: 'table locks held too long', environment: 'staging postgres 15' });
  const unknown = graph.addAttempt({ project: 'alpha', solution: 'connection pooling with pgbouncer', result: 'inconclusive under load', resultClass: 'inconclusive', reusableWhen: [{ key: 'pool_size', operator: 'gte', value: 50 }] });
  // Another project's lexical twin.
  const twin = graph.addAttempt({ project: 'beta', solution: 'blue-green deploy behind health gates', result: 'zero downtime release', resultClass: 'succeeded' });
  return { graph, queue, success, failure, unknown, twin };
}

test('AC-063: each kind of relevant history is ranked and delivered for a matching query', () => {
  const { graph, queue, success, failure, unknown } = fixture();
  for (const [query, id] of [['kafka', queue.id], ['blue-green deploy', success.id], ['backfill lock timeout', failure.id], ['pgbouncer pooling', unknown.id]]) {
    for (const compact of [false, true]) {
      const { relevant } = graph.context({ project: 'alpha', query, compact });
      assert.equal(relevant.relevance.established, true, query);
      assert.deepEqual(relevant.fallback, { used: false, reason: null }, query);
      const item = relevant.items.find((entry) => idOf(entry) === id);
      assert.ok(item, `${query} delivers ${id}`);
      assert.equal(item.tier, compact ? 'T1' : 'T2');
      assert.ok(item.ranks.lexical >= 1, query);
    }
  }
  // The rejected approach is delivered as recorded history, reason and all.
  const line = graph.context({ project: 'alpha', query: 'kafka', compact: true }).relevant.items[0].line;
  assert.match(line.line, /rejected "kafka cluster", recorded reason "operational cost for a two-person team"/);
  // Without a query, the working set holds neither the recorded success nor the
  // attempt whose condition is unknown as a record.
  const plain = graph.context({ project: 'alpha' });
  const delivered = new Set([...plain.activeDecisions, ...plain.failedAttempts, ...plain.staleAssumptions].map((record) => record.id));
  assert.equal(delivered.has(success.id), false);
  assert.equal(delivered.has(unknown.id), false);
});

test('G-5 §9 and G5-8 (fallback half): a query no signal answers delivers the working set, declared, never an empty complete result', () => {
  const { graph, queue, failure } = fixture();
  for (const compact of [false, true]) {
    const { relevant } = graph.context({ project: 'alpha', query: 'zebra quantum', compact });
    assert.equal(relevant.relevance.established, false);
    assert.deepEqual(relevant.fallback, { used: true, reason: 'relevance_not_established' });
    assert.equal(relevant.complete, false);
    assert.equal(relevant.limitation.code, 'relevance_not_established');
    assert.deepEqual(relevant.items.map(idOf), [queue.id, failure.id]);
    assert.ok(relevant.items.every((item) => item.tier === 'T2' && item.score === null && item.ranks === null));
    assert.equal(relevant.total, 2);
  }
  // Recency orders every candidate once asOf is set; it never establishes relevance (annex A9).
  const recent = graph.context({ project: 'alpha', query: 'zebra', asOf: NOW }).relevant;
  assert.equal(recent.relevance.signals.temporal.available, true);
  assert.deepEqual([recent.relevance.established, recent.fallback.reason, recent.complete, recent.items.length], [false, 'relevance_not_established', false, 2]);
  // Nor does an empty query, which matches no term.
  const empty = graph.context({ project: 'alpha', query: '' }).relevant;
  assert.deepEqual([empty.relevance.signals.lexical.available, empty.relevance.established, empty.fallback.used], [false, false, true]);
});

test('the fallback delivers the whole working set once: current decisions, failed and reusable attempts, stale facts', () => {
  const { graph, queue, failure } = fixture();
  const failedReusable = graph.addAttempt({ project: 'alpha', solution: 'nightly vacuum', result: 'failed: bloat', resultClass: 'failed', reusableWhen: [{ key: 'team_size', operator: 'less_than', value: 5 }] });
  const reusable = graph.addAttempt({ project: 'alpha', solution: 'retry with jitter', result: 'inconclusive', resultClass: 'inconclusive', reusableWhen: [{ key: 'team_size', operator: 'less_than', value: 5 }] });
  graph.addFact({ project: 'alpha', key: 'team_size', value: 3 });
  const stale = privilegedSnapshot(graph).facts.find((fact) => fact.key === 'team_size' && fact.status !== 'active');
  const { relevant } = graph.context({ project: 'alpha', query: 'zebra' });
  assert.deepEqual(relevant.items.map(idOf), [queue.id, failure.id, failedReusable.id, reusable.id, stale.id]);
  assert.deepEqual([relevant.total, relevant.byKind], [5, { decision: 1, attempt: 3, memory: 0, fact: 1 }]);
});

test('G-5 §9: a line that cannot carry its decisive meaning is delivered as the full record, declared', () => {
  const { graph } = fixture();
  const long = graph.addDecision({ project: 'alpha', title: `retention ${'window '.repeat(90)}`, chosen: 'thirty days' });
  const { relevant } = graph.context({ project: 'alpha', query: 'retention', compact: true });
  assert.equal(relevant.relevance.established, true);
  const item = relevant.items.find((entry) => idOf(entry) === long.id);
  assert.equal(item.tier, 'T2');
  assert.equal(item.record.title, long.title);
  assert.deepEqual(relevant.fallback, { used: true, reason: 'decisive_meaning_omitted' });
  assert.equal(relevant.lines.some((entry) => entry.recordId === long.id), false, 'lines lists the delivered lines only');
});

test('plan §17.2: the head declares scope, counts, completeness, limitation, processing and expansion before any item', () => {
  const { graph } = fixture();
  graph.remember({ project: 'alpha', memoryType: 'procedure', key: 'deploy checklist', text: 'the deploy checklist lives in the runbook' });
  const result = graph.context({ project: 'alpha', query: 'deploy', compact: true });
  assert.deepEqual(Object.keys(result).slice(0, 2), ['project', 'relevant']);
  const { relevant } = result;
  assert.deepEqual(Object.keys(relevant), ['scope', 'relevance', 'fallback', 'byKind', 'total', 'returned', 'omitted', 'hasMore', 'complete', 'limitSource', 'limitation', 'lines', 'processing', 'expansion', 'items']);
  // The claim class of each delivered line, in item order, where truncation still leaves it.
  assert.deepEqual(relevant.lines, relevant.items.map(({ line }) => ({ recordId: line.recordId, claimClass: line.claimClass, requiresExpansion: line.requiresExpansion })));
  assert.equal(relevant.lines.length, 2);
  assert.deepEqual(graph.context({ project: 'alpha', query: 'deploy' }).relevant.lines, [], 'full records are not lines');
  // Real values: a line whose claim a verifier quoted, and an unsettled negation that asks for the full record.
  const classed = createShadowGraph({ now: () => NOW });
  classed.importData({ records: [{ id: 'decision-classed', kind: 'decision', project: 'alpha', title: 'cache policy', chosen: 'lru', status: 'proposed',
    claims: [{ text: 'lru', class: 'quoted', sourceRef: 'capture:c1', span: { start: 0, end: 3 }, verifierVersion: 'claim-verifier-v1' }] }] });
  const negated = classed.addDecision({ project: 'alpha', title: 'retry policy', chosen: 'never retry payment captures' });
  const head = classed.context({ project: 'alpha', query: 'cache retry', compact: true }).relevant.lines;
  assert.deepEqual(head.find((entry) => entry.recordId === 'decision-classed'), { recordId: 'decision-classed', claimClass: 'quoted', requiresExpansion: false });
  assert.deepEqual(head.find((entry) => entry.recordId === negated.id), { recordId: negated.id, claimClass: 'not_classified', requiresExpansion: true });
  assert.deepEqual(relevant.scope, { project: 'alpha', requestState: 'project_selected', originPresented: false, grant: null });
  assert.deepEqual(relevant.byKind, { decision: 0, attempt: 1, memory: 1, fact: 0 });
  assert.deepEqual([relevant.total, relevant.returned, relevant.omitted, relevant.hasMore, relevant.complete, relevant.limitSource], [2, 2, 0, false, true, 'default']);
  assert.deepEqual(relevant.processing, { pending: 0, failed: 0, blocked: 0, oldestPendingAt: null, extractionAvailable: false });
  assert.deepEqual(relevant.expansion, { operation: 'shadowgraph_expand', available: true });
  // Each delivered line carries its own claim class and bound revision.
  for (const item of relevant.items) {
    assert.equal(item.tier, 'T1');
    assert.equal(typeof item.line.claimClass, 'string');
    assert.equal(item.line.boundRevision.recordId, item.line.recordId);
    assert.equal(item.line.expansion.asOf, null);
    assert.equal(item.line.expansion.derivedAt, NOW);
  }
});

test('AC-020: the semantic signal is named unavailable, and complete describes the counted candidates', () => {
  const { graph } = fixture();
  const query = 'deploy backfill pgbouncer kafka';
  const all = graph.context({ project: 'alpha', query }).relevant;
  assert.deepEqual(all.relevance.signals.semantic, { available: false, matched: 0 });
  assert.equal(all.relevance.signals.lexical.available, true);
  assert.equal(all.limitation.code, 'semantic_unavailable');
  assert.match(all.limitation.detail, /semantic signal is unavailable/);
  assert.deepEqual([all.total, all.complete], [4, true]);
  assert.ok(all.items.every((item, index) => index === 0 || all.items[index - 1].score >= item.score), 'best first');
  const page = graph.context({ project: 'alpha', query, limit: 1 }).relevant;
  assert.deepEqual([page.returned, page.omitted, page.hasMore, page.complete, page.limitSource], [1, 3, true, false, 'caller']);
  assert.equal(page.total, page.returned + page.omitted);
  assert.equal(Object.values(page.byKind).reduce((sum, count) => sum + count, 0), page.total);
});

test('the strongest match comes first', () => {
  const { graph, success, failure } = fixture();
  const { items } = graph.context({ project: 'alpha', query: 'deploy backfill lock timeout' }).relevant;
  assert.deepEqual(items.map(idOf), [failure.id, success.id]);
  assert.ok(items[0].score > items[1].score);
});

test('PC-13(a): ranking stays inside the read boundary, and an out-of-scope focalId reads as a nonexistent one', () => {
  const { graph, success, failure, twin } = fixture();
  const { relevant } = graph.context({ project: 'alpha', query: 'blue-green deploy' });
  assert.ok(relevant.items.every((item) => item.record.project === 'alpha'));
  assert.equal(relevant.items.some((item) => item.record.id === twin.id), false);
  // A graph walk from inside the boundary reaches a related record.
  graph.link({ project: 'alpha', from: success.id, to: failure.id, relation: 'related_to' });
  const walked = graph.context({ project: 'alpha', query: '', focalId: success.id }).relevant;
  assert.deepEqual(walked.items.map((item) => [item.record.id, item.ranks.graph]), [[failure.id, 1]]);
  // One from outside it reaches nothing, byte for byte like an unknown id.
  const rollout = graph.addDecision({ project: 'beta', title: 'rollout', chosen: 'canary' });
  graph.link({ project: 'beta', from: twin.id, to: rollout.id, relation: 'related_to' });
  // Even a stored relation from it into this project does not carry it across.
  importHistoricalRelation(graph, { id: 'relation:twin-success', from: twin.id, to: success.id, relation: 'related_to', project: 'beta' });
  assert.equal(JSON.stringify(graph.context({ project: 'alpha', query: 'deploy', focalId: twin.id })), JSON.stringify(graph.context({ project: 'alpha', query: 'deploy', focalId: 'attempt:missing' })));
});

test('PC-13(a): a graph walk never passes through another project to come back', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const start = graph.addDecision({ project: 'alpha', title: 'start', chosen: 'a' });
  const across = graph.addDecision({ project: 'beta', title: 'across', chosen: 'b' });
  const back = graph.addDecision({ project: 'alpha', title: 'back', chosen: 'c' });
  importHistoricalRelation(graph, { id: 'relation:start-across', from: start.id, to: across.id, relation: 'related_to', project: 'alpha' });
  importHistoricalRelation(graph, { id: 'relation:across-back', from: across.id, to: back.id, relation: 'related_to', project: 'beta' });
  const { relevant } = graph.context({ project: 'alpha', focalId: start.id });
  assert.deepEqual([relevant.relevance.established, relevant.relevance.signals.graph.matched], [false, 0]);
});

test('an unresolved project ranks nothing, and a grant widens to its own projects only', () => {
  const { graph, twin } = fixture();
  const unresolved = graph.context({ query: 'blue-green deploy' }).relevant;
  assert.deepEqual([unresolved.scope.requestState, unresolved.relevance.established, unresolved.items.length, unresolved.complete], ['project_unresolved', false, 0, false]);
  const gamma = graph.addAttempt({ project: 'gamma', solution: 'blue-green deploy behind health gates', result: 'zero downtime release', resultClass: 'succeeded' });
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'relevance fixture' }).entry;
  const ids = graph.context({ project: 'alpha', accessId: grant.accessId, query: 'blue-green deploy' }).relevant.items.map(idOf);
  assert.ok(ids.includes(twin.id));
  assert.equal(ids.includes(gamma.id), false);
});

test('a graph walk never passes through another memory scope\'s memory, and such a focalId reads as an unknown one', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const start = graph.addDecision({ project: 'alpha', title: 'start', chosen: 'a' });
  const alice = graph.remember({ project: 'alpha', scope: { userId: 'alice' }, memoryType: 'note', key: 'k', text: 'alice only' }).memory;
  const beyond = graph.addDecision({ project: 'alpha', title: 'beyond', chosen: 'b' });
  graph.link({ project: 'alpha', from: start.id, to: alice.id, relation: 'related_to' });
  graph.link({ project: 'alpha', from: alice.id, to: beyond.id, relation: 'related_to' });
  assert.deepEqual(graph.context({ project: 'alpha', focalId: start.id }).relevant.relevance.signals.graph, { available: false, matched: 0 });
  assert.equal(JSON.stringify(graph.context({ project: 'alpha', focalId: alice.id })), JSON.stringify(graph.context({ project: 'alpha', focalId: 'memory:missing' })));
  // recall ranks the same view: the project-wide scope does not walk through alice's memory; alice's own scope does.
  assert.equal(graph.recall('', { project: 'alpha', focalId: start.id }).signals.graph.matched, 0);
  assert.equal(graph.recall('', { project: 'alpha', scope: { userId: 'alice' }, focalId: start.id }).signals.graph.matched, 2);
});

test('a line renders no link outside the read boundary', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData({ records: [
    { id: 'decision-beta', kind: 'decision', project: 'beta', title: 'successor', chosen: 'b', status: 'proposed' },
    { id: 'decision-alpha', kind: 'decision', project: 'alpha', title: 'predecessor plan', chosen: 'a', status: 'superseded', supersededBy: 'decision-beta' }
  ] });
  const [item] = graph.context({ project: 'alpha', query: 'predecessor', compact: true }).relevant.items;
  assert.equal(item.tier, 'T1');
  assert.equal(JSON.stringify(item.line).includes('decision-beta'), false);
  // Nor a link to another memory scope's memory in the same project.
  const alice = graph.remember({ project: 'alpha', scope: { userId: 'alice' }, memoryType: 'note', key: 'k', text: 'alice only' }).memory;
  graph.importData({ records: [{ id: 'decision-linked', kind: 'decision', project: 'alpha', title: 'linked rollout', chosen: 'a', status: 'superseded', supersededBy: alice.id }] });
  const [linked] = graph.context({ project: 'alpha', query: 'linked', compact: true }).relevant.items;
  assert.equal(JSON.stringify(linked.line).includes(alice.id), false);
  // The full record is the record as stored, its links with it, as every read of a full record returns it.
  assert.equal(graph.context({ project: 'alpha', query: 'predecessor' }).relevant.items[0].record.supersededBy, 'decision-beta');
});

test('a grant widens the ranked set and names itself in each line handle', () => {
  const { graph, twin } = fixture();
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'relevance fixture' }).entry;
  const { relevant } = graph.context({ project: 'alpha', accessId: grant.accessId, query: 'blue-green deploy', compact: true });
  const item = relevant.items.find((entry) => idOf(entry) === twin.id);
  assert.ok(item, 'the granted project ranks');
  assert.deepEqual(item.line.expansion.scope, { project: 'alpha', grantId: grant.accessId });
  assert.equal(relevant.scope.grant.accessId, grant.accessId);
});

test('a granted relevance read audits every record it delivers, as lines or as records', () => {
  const counts = [false, true].map((compact) => {
    const { graph } = fixture();
    const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'relevance fixture' }).entry;
    graph.context({ project: 'alpha', accessId: grant.accessId, query: 'blue-green deploy', compact });
    return auditedRecords(graph);
  });
  // The success and its twin in the relevant block; the queue decision, its rejected alternative and the failure in the working set.
  assert.deepEqual(counts, [[5], [5]]);
  // A superseded decision, outside the working set, with its two alternatives: a line carries them as the record
  // does. The fourth record is its replacement, current and so in the granted working set.
  const lined = [false, true].map((compact) => {
    const graph = createShadowGraph({ now: () => NOW });
    const replaced = graph.addDecision({ project: 'beta', title: 'ingest pipeline', chosen: 'batch', alternatives: [{ label: 'stream', reasonRejected: 'cost' }, { label: 'hybrid', reasonRejected: 'complexity' }] });
    const replacement = graph.addDecision({ project: 'beta', title: 'successor', chosen: 'stream' });
    graph.supersedeDecision({ project: 'beta', decisionId: replaced.id, replacementId: replacement.id });
    const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'relevance fixture' }).entry;
    graph.context({ project: 'alpha', accessId: grant.accessId, query: 'pipeline', compact });
    return auditedRecords(graph);
  });
  assert.deepEqual(lined, [[4], [4]]);
});

test('a delivered record is a copy', () => {
  const { graph } = fixture();
  const read = () => graph.context({ project: 'alpha', query: 'kafka' }).relevant.items[0].record;
  const first = read();
  first.alternatives[0].label = 'changed';
  first.title = 'changed';
  assert.deepEqual([read().title, read().alternatives[0].label], ['message queue', 'kafka cluster']);
});

test('PC-25: relevance reads write nothing; a refused grant adds only its declared audit, as it does without a query', () => {
  const { graph } = fixture();
  const before = JSON.stringify(privilegedSnapshot(graph));
  for (let index = 0; index < 5; index += 1) graph.context({ project: 'alpha', query: 'deploy backfill', compact: true, asOf: NOW });
  graph.context({ project: 'alpha', query: 'zebra' });
  assert.equal(JSON.stringify(privilegedSnapshot(graph)), before);
  const canonical = () => {
    const { events, ...rest } = privilegedSnapshot(graph);
    return JSON.stringify({ ...rest, events: events.filter((event) => !event.type.startsWith('access.')) });
  };
  const settled = canonical();
  graph.context({ project: 'alpha', query: 'deploy', accessId: 'access:none' });
  assert.equal(canonical(), settled);
});

test('AC-035: an unrelated fact changes no line, rank or state of a failed attempt, and adds no field', () => {
  const { graph, failure } = fixture();
  const read = () => graph.context({ project: 'alpha', query: 'backfill lock timeout', compact: true }).relevant;
  const before = read();
  graph.addFact({ project: 'alpha', key: 'weather', value: 'sunny' });
  const after = read();
  const pick = (block) => block.items.find((item) => idOf(item) === failure.id);
  assert.deepEqual(pick(after), pick(before));
  assert.deepEqual(after.items.map(idOf), before.items.map(idOf));
  assert.deepEqual(Object.keys(after), Object.keys(before));
});

test('as of an instant, facts are selected by valid time and the recency signal ranks the later one first', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addFact({ project: 'alpha', key: 'region', value: 'eu', validFrom: '2025-01-01T00:00:00.000Z', validTo: '2025-06-01T00:00:00.000Z' });
  const { relevant: then } = graph.context({ project: 'alpha', query: 'region', asOf: '2025-03-01T00:00:00.000Z', compact: true });
  assert.deepEqual(then.items.map((item) => item.line.kind), ['fact']);
  assert.equal(then.items[0].line.expansion.asOf, '2025-03-01T00:00:00.000Z');
  assert.equal(then.relevance.signals.temporal.available, true);
  const { relevant: now } = graph.context({ project: 'alpha', query: 'region' });
  assert.equal(now.relevance.established, false);
  // The recency signal ranks the later fact first. It orders; it never selects (see the fallback test).
  const earlier = graph.addFact({ project: 'alpha', key: 'primary_region', value: 'eu', validFrom: '2025-01-01T00:00:00.000Z' });
  const later = graph.addFact({ project: 'alpha', key: 'backup_region', value: 'us', validFrom: '2025-02-01T00:00:00.000Z' });
  const items = graph.context({ project: 'alpha', query: 'primary backup', asOf: '2025-03-01T00:00:00.000Z' }).relevant.items;
  const rankOf = (id) => items.find((item) => idOf(item) === id).ranks.temporal;
  assert.deepEqual(items.map(idOf).sort(), [earlier.id, later.id].sort());
  assert.ok(rankOf(later.id) < rankOf(earlier.id));
});

test('a legacy fact stored with no kind is counted and rendered as a fact, status and validity kept', () => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData({ facts: [{ id: 'legacy-fact', key: 'region', value: 'eu', project: 'alpha', status: 'superseded', validTo: '2025-01-01T00:00:00.000Z' }] });
  // Valid then: matched by its text, counted and rendered as the fact it is.
  const { relevant } = graph.context({ project: 'alpha', query: 'region', compact: true, asOf: '2024-06-01T00:00:00.000Z' });
  assert.equal(relevant.relevance.established, true);
  assert.deepEqual(relevant.byKind, { decision: 0, attempt: 0, memory: 0, fact: 1 });
  const [item] = relevant.items;
  assert.equal(item.line.kind, null);
  assert.match(item.line.line, /^Fact "region"; value "eu"; status superseded; verification [^;]+; valid from an unrecorded time until 2025-01-01T00:00:00\.000Z; /);
  // No longer valid now: not relevant, but still delivered with the working set as it was stored.
  const { relevant: now } = graph.context({ project: 'alpha', query: 'region' });
  assert.equal(now.relevance.established, false);
  assert.deepEqual(now.byKind, { decision: 0, attempt: 0, memory: 0, fact: 1 });
  assert.equal(Object.hasOwn(now.items[0].record, 'kind'), false);
});

test('a full record is the canonical record: the embedding, a derived index, is left out', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const memory = graph.remember({ project: 'alpha', memoryType: 'note', key: 'warmup', text: 'warm the cache first', embedding: { model: 'local', values: [0.1, 0.2, 0.3] } }).memory;
  assert.ok(graph.recall('warm', { project: 'alpha' }).items[0].record.embedding, 'recall still returns the stored embedding');
  const { relevant } = graph.context({ project: 'alpha', query: 'warm cache' });
  assert.equal(relevant.items[0].record.id, memory.id);
  assert.equal(Object.hasOwn(relevant.items[0].record, 'embedding'), false);
});

test('without a query or focalId, context() is the P2 read, whatever else is passed', () => {
  const { graph } = fixture();
  const plain = graph.context({ project: 'alpha' });
  assert.equal(Object.hasOwn(plain, 'relevant'), false);
  assert.equal(JSON.stringify(graph.context({ project: 'alpha', compact: true, asOf: NOW, query: null })), JSON.stringify(plain));
  // The review-named read never carries relevance.
  assert.equal(Object.hasOwn(graph.reviewContext({ project: 'alpha', query: 'deploy' }), 'relevant'), false);
});

test('relevance inputs are validated', () => {
  const { graph } = fixture();
  assert.throws(() => graph.context({ project: 'alpha', query: 42 }), /query must be a string/);
  assert.throws(() => graph.context({ project: 'alpha', query: 'x', focalId: 7 }), /focalId must be a string/);
  assert.throws(() => graph.context({ project: 'alpha', query: 'x', asOf: 'yesterday' }), /asOf must be a valid timestamp/);
  assert.throws(() => graph.context({ project: 'alpha', query: 'x', compact: 'yes' }), /compact must be a boolean/);
  assert.throws(() => graph.context({ project: 'alpha', focalId: 7 }), /focalId must be a string/);
});

// Hard stop #4: the default read never sends request text to an embedding
// endpoint, even when the MCP server has one configured for recall.
test('hard stop: the default read sends no request text to a configured embedding endpoint', async (t) => {
  const requests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      requests.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const directory = await scratchDirectory(t, 'shadowgraph-relevance-egress-');
  const file = join(directory, 'store.json');
  await createJsonFileStore(file).save(privilegedSnapshot(fixture().graph));
  const child = spawn(process.execPath, [mcpPath], {
    cwd: directory, stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json', SHADOWGRAPH_MCP_COMPACT: '1', SHADOWGRAPH_EMBEDDING_URL: `http://127.0.0.1:${server.address().port}/v1`, SHADOWGRAPH_EMBEDDING_MODEL: 'test-embedding' }
  });
  t.after(() => child.kill());
  const pending = new Map();
  let buffer = '', nextId = 0;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter((item) => item.trim())) { const message = JSON.parse(line); pending.get(message.id)?.(message); pending.delete(message.id); }
  });
  const call = (name, args) => new Promise((done) => { const id = ++nextId; pending.set(id, done); child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } })}\n`); })
    .then((message) => { assert.equal(message.error, undefined, JSON.stringify(message.error)); return JSON.parse(message.result.content[0].text); });
  for (const compact of [false, true]) {
    const { relevant } = await call('shadowgraph_context', { project: 'alpha', query: 'blue-green deploy', compact });
    assert.equal(relevant.relevance.established, true);
    assert.deepEqual(relevant.relevance.signals.semantic, { available: false, matched: 0 });
  }
  assert.equal(requests.length, 0, 'no request text reached the endpoint');
  // The endpoint was live: recall, which may use it, reaches it.
  await call('shadowgraph_recall', { project: 'alpha', query: 'blue-green deploy' });
  assert.ok(requests.length >= 1, 'the configured endpoint answers recall');
});
