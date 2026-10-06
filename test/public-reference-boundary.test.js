import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { privilegedSnapshot, privilegedIssueAccess, privilegedRebuild } from '../src/internal/snapshot.js';
import { historicalIds } from '../tools/historical-ids.js';
import { createShadowGraphServer } from '../src/server.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';

const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const backendSkip = (type) => (type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {});

const NOW = '2026-01-01T00:00:00.000Z', END = '2026-02-01T00:00:00.000Z';
const fields = ['failedAttempts', 'relatedTo', 'supersedes', 'supersededBy'];
function fixture({ historical = false, retry = true } = {}) {
  let clock = NOW;
  const graph = createShadowGraph({ now: () => clock });
  const own = graph.addAttempt({ project: 'alpha', solution: 'queue experiment', result: 'failed', resultClass: 'failed' });
  const foreign = graph.addAttempt({ project: 'beta', solution: 'PRIVATE_BETA_BODY', result: 'failed', resultClass: 'failed' });
  const local = graph.addDecision({ project: 'alpha', title: 'queue design', chosen: 'bounded queue', failedAttempts: [own.id, foreign.id], ...(retry ? { idempotencyKey: 'queue-design' } : {}) });
  if (historical) {
    // A detached pre-policy store, including its journal/retry echo: existing
    // stored links must survive restore and privileged replay byte for byte.
    const data = privilegedSnapshot(graph);
    const amend = value => {
      if (!value || typeof value !== 'object') return;
      if (value.id === local.id) {
        Object.assign(value, { relatedTo: [own.id, foreign.id, 'unknown-reference'], supersedes: foreign.id, supersededBy: own.id });
        value.metadata = { relatedTo: ['literal user content'], value: { supersedes: 'literal user content' } };
      } else for (const item of Object.values(value)) amend(item);
    };
    amend(data); graph.replaceData(data);
  }
  return { graph, own, foreign, local, tick: at => { clock = at; } };
}
function grant(graph) {
  return privilegedIssueAccess(graph, { scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: END, reason: 'synthetic project-wide comparison' }).entry.accessId;
}
function expandInput(graph, options, id) {
  const line = graph.context({ ...options, query: 'queue design', compact: true }).relevant.items.find(x => x.line?.recordId === id).line;
  const { operation, scope, ...handle } = line.expansion;
  return { ...handle, ...options };
}
const readers = {
  search: (g, o) => g.search('', o), retrieve: (g, o) => g.retrieve('', o), recall: (g, o) => g.recall('', o),
  context: (g, o) => g.context({ ...o, query: 'queue design' }), reviewContext: (g, o) => g.reviewContext({ ...o, query: 'queue design' }),
  exportData: (g, o) => g.exportData(o), getJournal: (g, o) => g.getJournal(o), rebuild: (g, o) => g.rebuild(o),
  traverse: (g, o, id) => g.traverse({ ...o, id }),
  expand: (g, o, id) => g.expand(expandInput(g, o, id)),
  redact: (g, o) => g.redact({ ...o, patterns: [] })
};
for (const [name, read] of Object.entries(readers)) test(`${name} withholds historical foreign reference IDs and retains authorized relationships`, () => {
  const { graph, own, foreign, local } = fixture({ historical: true });
  const before = privilegedSnapshot(graph);
  const options = { project: 'alpha', limit: 100 };
  const narrow = read(graph, options, local.id);
  assert.ok(JSON.stringify(narrow).includes(local.id), 'positive control: local decision returned');
  assert.ok(JSON.stringify(narrow).includes(own.id), 'positive control: own relationship retained');
  assert.equal(JSON.stringify(narrow).includes(foreign.id), false, 'foreign reference withheld');
  assert.equal(JSON.stringify(narrow).includes('unknown-reference'), false, 'unresolvable reference withheld');
  const accessId = grant(graph);
  const wide = read(graph, { ...options, accessId }, local.id);
  assert.ok(JSON.stringify(wide).includes(foreign.id), 'an explicit project grant retains the relationship');
  graph.revokeAccess({ accessId });
  assert.equal(JSON.stringify(read(graph, { ...options, accessId }, local.id)).includes(foreign.id), false, 'revocation rechecked');
  for (const key of ['records', 'facts', 'relations', 'idempotency']) assert.deepEqual(privilegedSnapshot(graph)[key], before[key], key);
});

test('ordinary creation, grant expiry and wrong surfaces obey the same reference boundary', () => {
  const { graph, own, foreign, local, tick } = fixture();
  const accessId = grant(graph);
  const read = options => graph.context({ project: 'alpha', ...options }).activeDecisions.find(x => x.id === local.id);
  assert.deepEqual(read({}).failedAttempts, [own.id]);
  assert.deepEqual(read({ accessId }).failedAttempts, [own.id, foreign.id]);
  assert.deepEqual(read({ accessId, surface: 'http' }).failedAttempts, [own.id]);
  tick(END);
  assert.deepEqual(read({ accessId }).failedAttempts, [own.id]);
});

test('projection changes only named record references and precedes caller redaction transforms', () => {
  const { graph, own, foreign, local } = fixture({ historical: true });
  const stored = privilegedSnapshot(graph).records.find(x => x.id === local.id);
  const shown = graph.exportData({ project: 'alpha' }).records.find(x => x.id === local.id);
  assert.deepEqual(shown.failedAttempts, [own.id]);
  assert.deepEqual(shown.relatedTo, [own.id]);
  assert.equal(shown.supersedes, undefined);
  assert.equal(shown.supersededBy, own.id);
  assert.deepEqual(shown.metadata, stored.metadata, 'arbitrary user content is not interpreted as links');
  const redacted = graph.redact({ project: 'alpha', patterns: ['^id$'], replacement: 'MASK' });
  const decision = redacted.records.find(x => x.title === 'queue design');
  assert.equal(decision.id, 'MASK');
  assert.deepEqual(decision.failedAttempts, [own.id], 'masking record identity must not erase an allowed link');
  assert.equal(JSON.stringify(redacted).includes(foreign.id), false);
});

test('record references cannot bypass the requested memory scope', () => {
  const { graph, local } = fixture();
  const scoped = graph.remember({ project: 'alpha', scope: { userId: 'alice' }, memoryType: 'note', key: 'queue', text: 'scoped queue' }).memory;
  const data = privilegedSnapshot(graph);
  for (const item of data.records) if (item.id === local.id) item.relatedTo = [scoped.id];
  graph.replaceData(data);
  for (const name of ['search', 'retrieve', 'recall', 'context', 'expand', 'traverse']) {
    assert.equal(JSON.stringify(readers[name](graph, { project: 'alpha' }, local.id)).includes(scoped.id), false, name);
  }
  for (const name of ['search', 'retrieve', 'recall', 'traverse']) {
    assert.ok(JSON.stringify(readers[name](graph, { project: 'alpha', scope: { userId: 'alice' } }, local.id)).includes(scoped.id), name);
  }
});

test('historical fact and memory references are projected without rewriting stable IDs or empty/null fields', () => {
  const { graph, own, foreign } = fixture();
  const fact = graph.addFact({ project: 'alpha', key: 'queue-latency', value: 12 });
  const memory = graph.remember({ project: 'alpha', memoryType: 'note', key: 'queue', text: 'queue observation' }).memory;
  const data = privilegedSnapshot(graph);
  const amend = item => {
    if (!item || typeof item !== 'object') return;
    if ([fact.id, memory.id].includes(item.id)) {
      Object.assign(item, { relatedTo: [own.id, foreign.id], supersedes: foreign.id, supersededBy: null, failedAttempts: [] });
      if (item.id === fact.id) { delete item.kind; delete item.erasureToken; }
    } else for (const child of Object.values(item)) amend(child);
  };
  amend(data);
  graph.replaceData(historicalIds(data, { 'historical-fact-alpha': fact.id, 'historical-memory-alpha': memory.id }));
  const before = privilegedSnapshot(graph);
  const shownFact = graph.exportData({ project: 'alpha' }).facts.find(x => x.id === 'historical-fact-alpha');
  const shownMemory = graph.memoryHistory({ project: 'alpha', memoryType: 'note', key: 'queue' }).items.find(x => x.id === 'historical-memory-alpha');
  for (const record of [shownFact, shownMemory]) {
    assert.deepEqual(record.relatedTo, [own.id]);
    assert.equal(Object.hasOwn(record, 'supersedes'), false);
    assert.equal(record.supersededBy, null);
    assert.deepEqual(record.failedAttempts, []);
  }
  assert.deepEqual(privilegedSnapshot(graph), before);
});

for (const type of ['json', 'sqlite']) test(`${type} save/load and privileged replay preserve all historical links after public reads`, backendSkip(type), async t => {
  const { graph, local } = fixture({ historical: true });
  const before = privilegedSnapshot(graph);
  const dir = await mkdtemp(join(tmpdir(), 'sg-reference-roundtrip-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const read of Object.values(readers)) read(graph, { project: 'alpha' }, local.id);
  const store = await createStorage({ type, file: join(dir, 'store') });
  try {
    await store.save(privilegedSnapshot(graph));
    const restored = createShadowGraph({ now: () => NOW });
    restored.replaceData(await store.load());
    const record = privilegedSnapshot(restored).records.find(x => x.id === local.id);
    const replay = privilegedRebuild(restored);
    assert.equal(replay.rebuildable, true);
    for (const field of fields) {
      const expected = before.records.find(x => x.id === local.id)[field];
      assert.deepEqual(record[field], expected, field);
      assert.deepEqual(replay.projection.records.find(x => x.id === local.id)[field], expected, `replay ${field}`);
    }
    assert.throws(() => restored.replaceData(graph.exportData({ project: 'alpha' })), /scoped|public/i);
  } finally { await store.close(); }
});

test('unchanged status and other public mutation echoes cannot bypass reference visibility', () => {
  const operations = {
    unchangedStatus: f => f.graph.updateDecisionStatus(f.local.id, 'proposed', { project: 'alpha' }),
    outcome: f => f.graph.setOutcome(f.local.id, { status: 'mixed' }, { project: 'alpha' }),
    evidence: f => f.graph.addConfidenceEvidence({ project: 'alpha', decisionId: f.local.id, key: 'evidence', reason: 'synthetic observation' }),
    retry: f => f.graph.addDecision({ project: 'alpha', idempotencyKey: 'queue-design' }),
    create: f => f.graph.addDecision({ project: 'alpha', title: 'second queue', chosen: 'queue', failedAttempts: [f.own.id, f.foreign.id] }),
    supersede: f => {
      const next = f.graph.addDecision({ project: 'alpha', title: 'replacement queue', chosen: 'queue' });
      return f.graph.supersedeDecision({ project: 'alpha', decisionId: f.local.id, replacementId: next.id });
    }
  };
  for (const [name, operation] of Object.entries(operations)) {
    const f = fixture(); const before = privilegedSnapshot(f.graph);
    const result = operation(f);
    assert.ok(JSON.stringify(result).includes(f.own.id), name);
    assert.equal(JSON.stringify(result).includes(f.foreign.id), false, name);
    assert.deepEqual(privilegedSnapshot(f.graph).records.find(x => x.id === f.local.id).failedAttempts, [f.own.id, f.foreign.id], name);
    if (name === 'unchangedStatus') assert.deepEqual(privilegedSnapshot(f.graph), before);
  }
});

test('HTTP unchanged-status response filters stored references without changing persistence', async t => {
  const f = fixture();
  const dir = await mkdtemp(join(tmpdir(), 'sg-reference-http-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'store'); const store = await createStorage({ type: 'json', file });
  await store.save(privilegedSnapshot(f.graph)); await store.close();
  const app = await createShadowGraphServer({ file, storage: 'json' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'alpha', decisionId: f.local.id, status: 'proposed' })
    });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.deepEqual(result.failedAttempts, [f.own.id]);
  } finally { await new Promise(resolve => app.server.close(resolve)); }
  const saved = await createStorage({ type: 'json', file });
  try { assert.deepEqual((await saved.load()).records.find(x => x.id === f.local.id).failedAttempts, [f.own.id, f.foreign.id]); }
  finally { await saved.close(); }
});

test('journal-only historical records use the current target boundary in journal, rebuild and redaction', () => {
  const { graph, own, foreign, local } = fixture({ historical: true });
  const data = privilegedSnapshot(graph);
  data.records = data.records.filter(x => x.id !== local.id);
  data.idempotency = data.idempotency.filter(x => x.value.id !== local.id);
  graph.replaceData(data);
  const before = privilegedSnapshot(graph);
  for (const name of ['getJournal', 'rebuild', 'redact']) {
    const result = readers[name](graph, { project: 'alpha' });
    assert.ok(JSON.stringify(result).includes(local.id), name);
    assert.ok(JSON.stringify(result).includes(own.id), name);
    assert.equal(JSON.stringify(result).includes(foreign.id), false, name);
  }
  assert.deepEqual(privilegedSnapshot(graph), before);
});

test('nested historical alternatives retain permitted links consistently with direct traversal and T1 expansion', () => {
  const { graph, own, foreign } = fixture();
  const decision = graph.addDecision({ project: 'alpha', title: 'historical queue alternative', chosen: 'queue', alternatives: [{ label: 'other queue' }] });
  const data = privilegedSnapshot(graph);
  const amend = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === decision.id) Object.assign(value.alternatives[0], { relatedTo: [own.id, foreign.id], supersedes: foreign.id });
    else for (const child of Object.values(value)) amend(child);
  };
  amend(data); graph.replaceData(data);
  const before = privilegedSnapshot(graph);
  const read = options => graph.context({ project: 'alpha', ...options }).activeDecisions.find(x => x.id === decision.id).alternatives[0];
  assert.deepEqual(read({}).relatedTo, [own.id]);
  assert.equal(read({}).supersedes, undefined);
  assert.deepEqual(graph.traverse({ project: 'alpha', id: decision.alternatives[0].id }).nodes[0].relatedTo, [own.id]);
  const input = expandInput(graph, { project: 'alpha' }, decision.id);
  assert.equal(graph.expand(input).status, 'current');
  assert.deepEqual(graph.expand(input).record.alternatives[0].relatedTo, [own.id]);
  const accessId = grant(graph);
  assert.deepEqual(read({ accessId }).relatedTo, [own.id, foreign.id]);
  graph.revokeAccess({ accessId });
  assert.deepEqual(read({ accessId }).relatedTo, [own.id]);
  assert.deepEqual(privilegedSnapshot(graph).records, before.records);
  assert.deepEqual(privilegedSnapshot(graph).journal, before.journal);
});

test('legacy administrative review preserves links within its declared view and withholds project-owned targets', () => {
  const { graph, own, foreign, local } = fixture({ retry: false });
  const data = privilegedSnapshot(graph);
  const amend = value => {
    if (!value || typeof value !== 'object') return;
    if ([own.id, local.id].includes(value.entityId) && value.payload) value.project = 'default';
    if ([own.id, local.id].includes(value.id)) { value.project = 'default'; value.attribution = 'legacy_ambiguous'; }
    else for (const child of Object.values(value)) amend(child);
  };
  amend(data); graph.replaceData(data);
  const before = privilegedSnapshot(graph);
  const record = graph.legacyAttributionReview().items.find(x => x.id === local.id).entity;
  assert.deepEqual(record.failedAttempts, [own.id]);
  assert.equal(JSON.stringify(graph.legacyAttributionReview()).includes(foreign.id), false);
  assert.deepEqual(privilegedSnapshot(graph), before);
});

test('mutation echoes keep origin ownership and exact memory scope without widening through a grant', () => {
  const graph = createShadowGraph({ now: () => NOW });
  const own = graph.addAttempt({ originId: 'origin-a', solution: 'own origin', result: 'failed' });
  const other = graph.addAttempt({ originId: 'origin-b', solution: 'other origin', result: 'failed' });
  const decision = graph.addDecision({ originId: 'origin-a', title: 'origin queue', chosen: 'queue', failedAttempts: [own.id, other.id] });
  assert.deepEqual(decision.failedAttempts, [own.id]);
  assert.deepEqual(graph.updateDecisionStatus(decision.id, 'proposed', { originId: 'origin-a' }).failedAttempts, [own.id]);
  const scoped = graph.remember({ project: 'alpha', scope: { userId: 'alice' }, memoryType: 'note', key: 'queue', text: 'scoped observation' }).memory;
  const global = graph.addAttempt({ project: 'alpha', solution: 'project queue', result: 'failed', relatedTo: [scoped.id] });
  assert.deepEqual(global.relatedTo, []);
  assert.deepEqual(privilegedSnapshot(graph).records.find(x => x.id === global.id).relatedTo, [scoped.id]);
  const f = fixture(); const accessId = grant(f.graph);
  assert.deepEqual(f.graph.updateDecisionStatus(f.local.id, 'proposed', { project: 'alpha', accessId }).failedAttempts, [f.own.id]);
  assert.ok(f.graph.context({ project: 'alpha', accessId }).activeDecisions.find(x => x.id === f.local.id).failedAttempts.includes(f.foreign.id));
});

for (const kind of ['attempt', 'fact']) for (const journalOnly of [false, true]) test(`accepted sparse ${kind}, journal-only=${journalOnly}, cannot leak named references`, () => {
  const { graph, own, foreign } = fixture();
  const sparse = kind === 'attempt'
    ? graph.addAttempt({ project: 'alpha', solution: 'historical sparse', result: 'failed' })
    : graph.addFact({ project: 'alpha', key: 'historical-sparse', value: 1 });
  const data = privilegedSnapshot(graph);
  const amend = value => {
    if (!value || typeof value !== 'object') return;
    if (value.id === sparse.id) {
      Object.assign(value, { relatedTo: [own.id, foreign.id, 'unknown-sparse-reference'], supersedes: foreign.id,
        metadata: { id: 'literal-example', kind: 'attempt', relatedTo: ['literal user content'] } });
      if (kind === 'attempt') { delete value.solution; delete value.result; delete value.reason; }
      else { delete value.kind; delete value.value; delete value.erasureToken; }
    } else for (const child of Object.values(value)) amend(child);
  };
  amend(data);
  if (journalOnly) data[kind === 'fact' ? 'facts' : 'records'] = data[kind === 'fact' ? 'facts' : 'records'].filter(x => x.id !== sparse.id);
  graph.replaceData(data);
  const before = privilegedSnapshot(graph);
  const find = value => {
    if (!value || typeof value !== 'object') return undefined;
    if (value.id === sparse.id && value.relatedTo) return value;
    for (const child of Object.values(value)) { const record = find(child); if (record) return record; }
  };
  const methods = journalOnly ? (kind === 'fact' ? ['rebuild'] : ['getJournal', 'rebuild', 'redact']) : ['getJournal', 'rebuild', 'redact', 'exportData', 'traverse'];
  if (journalOnly && kind === 'fact') for (const name of ['getJournal', 'redact']) {
    assert.equal(find(readers[name](graph, { project: 'alpha' })), undefined, 'existing journal visibility withholds a kind-less fact with no live target');
  }
  const check = (options, expected) => {
    for (const name of methods) {
      const record = find(readers[name](graph, { project: 'alpha', ...options }, sparse.id));
      assert.ok(record, name);
      assert.deepEqual(record.relatedTo, expected, name);
      assert.deepEqual(record.metadata.relatedTo, ['literal user content'], name);
      assert.equal(record.supersedes, expected.length === 2 ? foreign.id : undefined, name);
    }
  };
  check({}, [own.id]);
  const accessId = grant(graph); check({ accessId }, [own.id, foreign.id]);
  graph.revokeAccess({ accessId }); check({ accessId }, [own.id]);
  for (const key of ['records', 'facts', 'journal']) assert.deepEqual(privilegedSnapshot(graph)[key], before[key], key);
});
