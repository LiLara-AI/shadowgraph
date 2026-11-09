import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedIssueAccess, privilegedSnapshot } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { buildToolCatalog, selectTools, projectTool, METADATA_TIER, COMPACT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '../src/mcp-tools.js';

const additions = ['shadowgraph_confidence_evidence', 'shadowgraph_review_signals', 'shadowgraph_supersede', 'shadowgraph_update_status'];
const constraints = v => Array.isArray(v) ? v.map(constraints) : v && typeof v === 'object'
  ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'description').map(([k, x]) => [k, constraints(x)])) : v;

for (const verifier of [false, true]) test(`opt-in workflow preserves existing contracts and defaults, verifier=${verifier}`, () => {
  const catalog = buildToolCatalog({ verifier });
  const original = JSON.stringify(catalog);
  assert.equal(selectTools(catalog).length, verifier ? 36 : 35);
  assert.deepEqual(selectTools(catalog, { compact: true }).map(x => x.name), COMPACT_TOOL_NAMES);
  const workflow = selectTools(catalog, { profile: 'workflow' });
  assert.equal(workflow.length, 20);
  assert.deepEqual(workflow.map(x => x.name), WORKFLOW_TOOL_NAMES);
  assert.deepEqual(workflow.filter(x => !COMPACT_TOOL_NAMES.includes(x.name)).map(x => x.name).sort(), additions);
  for (const tool of workflow) {
    const full = catalog.find(x => x.name === tool.name);
    for (const tier of Object.values(METADATA_TIER)) assert.deepEqual(constraints(projectTool(tool, tier)), constraints(projectTool(full, tier)));
    assert.equal(tool.persists, full.persists);
    assert.equal(tool.persistsWithAccess, full.persistsWithAccess);
    assert.ok(tool.description.length <= 550, tool.name);
    const walk = v => {
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        if (k === 'description' && typeof x === 'string') for (const m of x.matchAll(/shadowgraph_[a-z_]+/gu)) {
          if (!WORKFLOW_TOOL_NAMES.includes(m[0])) assert.ok(x.slice(m.index + m[0].length).startsWith(' (full mode only)'), `${tool.name}: ${m[0]}`);
          else assert.ok(!x.slice(m.index + m[0].length).startsWith(' (full mode only)'), `available target: ${m[0]}`);
        } else walk(x);
      }
    };
    walk(projectTool(tool, METADATA_TIER.STRUCTURED));
  }
  assert.equal(JSON.stringify(catalog), original);
  assert.deepEqual(selectTools(workflow, { profile: 'workflow' }), workflow);
  assert.throws(() => selectTools(catalog, { profile: 'typo' }), /Unknown SHADOWGRAPH_MCP_PROFILE/u);
  assert.throws(() => selectTools(catalog, { compact: true, profile: 'workflow' }), /conflicts/u);
});

async function client(t, mode, seed) {
  const dir = await scratchDirectory(t, 'mcp-workflow-profile-');
  const file = join(dir, 'data.json');
  if (seed) { const store = createJsonFileStore(file); await store.save(seed); }
  const clock = join(dir, 'clock');
  await writeFile(clock, '2030-01-01T00:00:00.000Z');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], {
    cwd: dir, windowsHide: true,
    env: { ...process.env, SHADOWGRAPH_FILE: file, SHADOWGRAPH_STORAGE: 'json', SHADOWGRAPH_HOME: join(dir, 'home'), SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '',
      SHADOWGRAPH_MCP_COMPACT: mode === 'compact' ? '1' : '0', SHADOWGRAPH_MCP_PROFILE: mode === 'workflow' ? 'workflow' : '', NODE_ENV: 'test', SHADOWGRAPH_TEST_CLOCK_FILE: clock },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let stderr = ''; child.stderr.on('data', c => { stderr += c; });
  const closed = once(child, 'close'); const pending = new Map(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { if (line.trim()) { const response = JSON.parse(line); pending.get(response.id)?.(response); } });
  t.after(async () => { child.stdin.end(); const timer = setTimeout(() => child.kill(), 2000); await closed; clearTimeout(timer); lines.close(); });
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const key = ++id; const timer = setTimeout(() => { pending.delete(key); reject(Error(`${method} timeout: ${stderr}`)); }, 10000);
    pending.set(key, value => { clearTimeout(timer); pending.delete(key); resolve(value); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });
  const call = async (name, args = {}, fail = false) => {
    const response = await rpc('tools/call', { name: `shadowgraph_${name}`, arguments: args });
    if (fail) { assert.ok(response.error, `expected refusal: ${name}`); return response.error; }
    assert.equal(response.error, undefined, JSON.stringify(response.error)); return response.result.structuredContent;
  };
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'workflow-regression', version: '1' } });
  return { call, rpc, file, snapshot: async () => JSON.parse(await readFile(file, 'utf8')), bytes: () => readFile(file, 'utf8') };
}

// The same behavior case runs in the old full surface and the opt-in surface.
// All mutations go through the real MCP guard, scope checks and persistence.
for (const mode of ['full', 'workflow']) test(`${mode}: review to evidence, lifecycle, correction and acknowledgement`, async t => {
  const c = await client(t, mode);
  const old = await c.call('record_decision', { project: 'p', title: 'Cache routing', chosen: 'local', alternatives: [{ label: 'remote', reopenWhen: [{ key: 'ready', value: true }] }] });
  const replacement = await c.call('record_decision', { project: 'p', title: 'Replacement', chosen: 'remote' });
  const foreign = await c.call('record_decision', { project: 'other', title: 'Private', chosen: 'foreign' });
  await c.call('record_fact', { project: 'p', key: 'ready', value: true });
  let before = await c.bytes();
  const context = await c.call('context', { project: 'p' });
  assert.equal(context.firedConditions[0].reviewSignalStatus, 'unpersisted');
  assert.equal(await c.bytes(), before);
  const due = await c.call('review', { project: 'p' });
  const signal = due.items[0].reviewSignalId; assert.ok(signal);
  const first = await c.snapshot();
  const reconsider = await c.call('reconsider', { project: 'p', decisionId: old.id });
  assert.equal(reconsider.verdict, 'review_recommended');
  assert.equal(reconsider.evaluationCompleteness, 'complete');
  assert.equal((await c.snapshot()).revision, first.revision + 1);
  const reviewed = await c.call('review_context', { project: 'p' });
  assert.equal(reviewed.openReviews[0].reviewSignalId, signal);
  assert.equal((await c.snapshot()).reviewSignals.length, 1);
  assert.equal((await c.snapshot()).records.find(x => x.id === old.id).status, old.status);
  before = await c.bytes();
  assert.equal((await c.call('review_signals', { project: 'p', status: 'open' })).items[0].id, signal);
  assert.equal((await c.call('review_signals', { project: 'other' })).items.length, 0);
  assert.equal((await c.call('review_signals')).items.length, 0, 'no implicit cross-project scope');
  assert.equal(await c.bytes(), before, 'inspection does not reevaluate or commit');
  await c.call('ack_review', { project: 'other', id: signal }, true);
  await c.call('update_status', { project: 'other', decisionId: old.id, status: 'planned' }, true);
  await c.call('confidence_evidence', { project: 'other', decisionId: old.id, key: 'e', reason: 'contradiction' }, true);
  await c.call('supersede', { project: 'p', decisionId: old.id, replacementId: foreign.id, grantId: 'not-write-authority' }, true);
  await c.call('supersede', { decisionId: old.id, replacementId: replacement.id }, true);
  assert.equal(await c.bytes(), before, 'refused writes cannot mutate or commit');
  const updated = await c.call('update_status', { project: 'p', decisionId: old.id, status: 'planned' });
  assert.equal(updated.status, 'planned');
  await c.call('update_status', { project: 'p', decisionId: old.id, status: 'superseded' }, true);
  const evidenceArgs = { project: 'p', decisionId: old.id, key: 'benchmark-1', reason: 'Synthetic measurement', supports: true };
  const evidence = await c.call('confidence_evidence', evidenceArgs);
  assert.deepEqual((await c.call('confidence_evidence', evidenceArgs)).confidence, evidence.confidence, 'same evidence is not counted twice');
  const result = await c.call('supersede', { project: 'p', decisionId: old.id, replacementId: replacement.id });
  assert.equal(result.previous.status, 'superseded');
  assert.equal((await c.snapshot()).records.filter(x => [old.id, replacement.id].includes(x.id)).length, 2);
  assert.ok(!(await c.call('context', { project: 'p' })).activeDecisions.some(x => x.id === old.id));
  assert.equal((await c.call('ack_review', { project: 'p', id: signal })).status, 'acknowledged');
  assert.equal((await c.call('review_signals', { project: 'p', status: 'acknowledged' })).items[0].id, signal);
});

for (const mode of ['full', 'compact', 'workflow']) test(`${mode}: temporary rule inputs, uncertainty, attempts and outcomes keep their distinct effects`, async t => {
  const c = await client(t, mode);
  const d = await c.call('record_decision', { project: 'p', title: 'Two rules', chosen: 'current', alternatives: [{ label: 'object alternative', reopenWhen: [{ key: 'ready', value: true }] }, { label: 'string alternative', reopenWhen: ['budget'] }] });
  const unknown = await c.call('reconsider', { project: 'p', decisionId: d.id });
  assert.equal(unknown.verdict, 'manual_review'); assert.equal(unknown.evaluationCompleteness, 'partial');
  const beforeFacts = (await c.snapshot()).facts;
  const due = await c.call('review', { project: 'p', facts: { ready: true }, changedFacts: ['budget'] });
  assert.deepEqual(new Set(due.items[0].alternativesToReconsider), new Set(['object alternative', 'string alternative']));
  assert.deepEqual((await c.snapshot()).facts, beforeFacts, 'overrides do not create facts');
  const a = await c.call('record_attempt', { project: 'p', solution: 'retry', result: 'timeout persisted', resultClass: 'failed' });
  assert.equal(a.kind, 'attempt');
  const outcome = await c.call('record_outcome', { project: 'p', decisionId: d.id, outcome: { status: 'failed' } });
  assert.equal(outcome.status, d.status, 'outcome does not transition the decision');
  assert.ok(outcome.confidence.current < d.confidence.current);
  assert.ok((await c.call('context', { project: 'p' })).failedAttempts.some(x => x.id === a.id));
});

for (const mode of ['compact', 'workflow']) test(`${mode}: unavailable operations fail without a store write`, async t => {
  const c = await client(t, mode);
  await c.call('record_decision', { project: 'p', title: 'Preserved', chosen: 'local' });
  const before = await c.bytes();
  const absent = ['restore', 'purge', 'backup', 'repair_plan', 'rebuild', 'bind', 'request_wider_access', ...(mode === 'compact' ? ['supersede', 'update_status', 'confidence_evidence', 'review_signals'] : [])];
  for (const name of absent) assert.equal((await c.call(name, { project: 'p' }, true)).code, -32601);
  assert.equal(await c.bytes(), before);
  const names = (await c.rpc('tools/list', {})).result.tools.map(x => x.name);
  assert.equal(names.length, mode === 'compact' ? 16 : 20);
});

for (const mode of ['full', 'workflow']) test(`${mode}: a real read grant cannot widen added workflow writes`, async t => {
  const graph = createShadowGraph();
  const old = graph.addDecision({ project: 'foreign', title: 'Foreign old', chosen: 'A', alternatives: [{ label: 'B', reopenWhen: ['changed'] }] });
  const replacement = graph.addDecision({ project: 'foreign', title: 'Foreign new', chosen: 'B' });
  const signal = graph.review({ project: 'foreign', changedFacts: ['changed'] }).items[0].reviewSignalId;
  const grant = privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['foreign'] }, surfaces: ['mcp'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'synthetic read grant' });
  const c = await client(t, mode, privilegedSnapshot(graph));
  const scope = { project: 'p', grantId: grant.entry.accessId };
  const beforeRead = await c.snapshot();
  const signals = await c.call('review_signals', scope);
  assert.ok(signals.items.some(x => x.id === signal), 'valid grant widens inspection');
  assert.equal((await c.snapshot()).revision, beforeRead.revision + 1, 'grant inspection audits with a revision');
  const before = await c.bytes();
  await c.call('update_status', { ...scope, decisionId: old.id, status: 'planned' }, true);
  await c.call('confidence_evidence', { ...scope, decisionId: old.id, key: 'foreign', reason: 'no write authority' }, true);
  await c.call('supersede', { ...scope, decisionId: old.id, replacementId: replacement.id }, true);
  await c.call('ack_review', { ...scope, id: signal }, true);
  assert.equal(await c.bytes(), before, 'read authority never becomes write authority');
});
