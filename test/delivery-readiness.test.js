// What a session is told when memory is empty, too large or corrected: the
// session start says why nothing is delivered, a record too large for the
// payload is delivered as its line, a stored attempt reason is shown as what it
// is, and a correction travels with the record it corrects.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, realpath, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore, createStorage } from '../src/storage.js';
import { privilegedBindProject, privilegedRecordCapture, privilegedSnapshot } from '../src/internal/snapshot.js';
import { CAPTURE_LIMITS } from '../src/capture-hook.js';
import { RAW_RETENTION_DAYS } from '../src/internal/capture-retention.js';
import { FROZEN_WORKER_BUDGETS } from '../src/internal/extraction-budget.js';
import { extractionBinding } from '../src/internal/extraction-provenance.js';
import { claimCapture, commitCapture } from '../src/internal/extraction-worker.js';
import { QUOTED_RECIPE } from '../src/internal/extraction-contract.js';
import { DELIVERY_CAP_BYTES } from '../src/delivery.js';
import { t1Line } from '../src/compact-tier.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const CLI = resolve('src/cli.js');
const MODEL = 'claude-sonnet-5-5';
// A host version and model the executor profile accepts (test/extraction-activation.test.js).
const HOST_MODEL = 'claude-opus-5[1m]';
const bytes = (text) => Buffer.byteLength(text, 'utf8');
const idOf = (item) => item.expansion?.recordId ?? item.record?.id;

// A workspace bound to `app`, its store outside it, and a per-user home.
async function workspace(t) {
  const root = await realpath(await scratchDirectory(t, 'shadowgraph-readiness-'));
  const cwd = join(root, 'work'), home = join(root, 'sg-home');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  await mkdir(home);
  await mkdir(join(root, 'store'));
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'app', confirmed: true }));
  return { root, cwd, home, file: join(root, 'store', 'memory.json') };
}

async function save(w, build, options = {}) {
  const graph = createShadowGraph(options);
  privilegedBindProject(graph, { type: 'worktree', path: resolve(w.cwd), project: 'app', reason: 'readiness test', surface: 'cli' });
  build?.(graph);
  await createJsonFileStore(w.file).save(privilegedSnapshot(graph));
  return graph;
}

function deliver(w, event, prompt, args = ['--hook']) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SHADOWGRAPH_')));
  const env = { ...base, SHADOWGRAPH_HOME: w.home, ...(args.length ? {} : { SHADOWGRAPH_FILE: w.file }) };
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [CLI, 'deliver', ...args], { cwd: w.cwd, env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', fail);
    child.on('close', (code) => {
      assert.deepEqual([code, stderr], [0, '']);
      if (!stdout) return done(null); // the hook delivered nothing
      const text = JSON.parse(stdout).hookSpecificOutput.additionalContext;
      const lines = text.split('\n');
      const field = (name) => JSON.parse(lines.find((line) => line.startsWith(`${name}: `)).slice(name.length + 2));
      done({ text, head: field('head'), processing: field('processing'), items: lines.filter((line) => line.startsWith('item: ')).map((line) => JSON.parse(line.slice(6))) });
    });
    child.stdin.end(JSON.stringify({ session_id: 's-1', hook_event_name: event, ...(prompt === undefined ? {} : { prompt }) }));
  });
}

// The per-user activation record: delivery and capture of this store, and
// extraction when asked, all on one runtime.
async function activate(w, { extraction = false } = {}) {
  const store = { file: w.file, storage: 'json' };
  const runtime = { path: join(w.root, 'runtime'), commit: 'a'.repeat(40), extraction: true };
  const capture = { state: 'active', store, runtime, originId: 'origin-readiness', coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS } };
  const executor = { ok: true, executable: join(w.root, 'claude.exe'), binarySha256: 'b'.repeat(64), hostVersion: '2.1.288', model: HOST_MODEL,
    restrictions: Object.fromEntries(Array.from({ length: 10 }, (unused, index) => [`E-${index + 1}`, true])), accountFingerprint: 'f'.repeat(64), accountSalt: 'e'.repeat(32) };
  const active = extraction ? { state: 'active', activationId: randomUUID(), changedAt: new Date().toISOString(), store, runtime, noOverageConfirmed: true, budgets: { ...FROZEN_WORKER_BUDGETS }, model: HOST_MODEL, executor } : null;
  await writeFile(join(w.home, 'activation.json'), JSON.stringify({ version: 1, capabilities: { delivery: { state: 'active', store, runtime }, capture, ...(active ? { extraction: active } : {}) }, history: [] }));
  return active;
}

const captureOf = (graph, text, sessionId, binding = null) => privilegedRecordCapture(graph, {
  project: 'app', originId: 'origin-readiness', text, source: { event: 'UserPromptSubmit', sessionId, role: 'user', hostEventId: `${sessionId}-${text.length}` },
  observation: { host: 'claude-code', hostVersion: null, toolName: null, cwd: null, outcome: null, extractionBinding: binding },
  admission: { limits: { ...CAPTURE_LIMITS }, storeBytes: 0 }
});

test('SessionStart with nothing extracted says capture runs without extraction, that raw text expires, and how to turn extraction on', async (t) => {
  const w = await workspace(t);
  let at = new Date(Date.now() - (RAW_RETENTION_DAYS + 1) * 86_400_000).toISOString();
  await save(w, (graph) => {
    captureOf(graph, 'We will use csv-parse because quoted fields contain commas.', 'old');
    at = new Date().toISOString();
    captureOf(graph, 'Keep the column mapping in config/columns.json.', 'new');
  }, { now: () => at });
  await activate(w);
  const { head, processing, items } = await deliver(w, 'SessionStart');
  assert.deepEqual([head.total, items.length, processing.capture, processing.extraction], [0, 0, 'active', 'not_active']);
  assert.equal(head.limitation.code, 'extraction_not_active');
  assert.match(head.limitation.detail, /captured work is never turned into records/u);
  assert.match(head.limitation.detail, new RegExp(`expires after the retention period \\(${RAW_RETENTION_DAYS} days by default\\)`, 'u'));
  assert.match(head.limitation.detail, /1 captured item has already expired unread/u);
  assert.match(head.limitation.detail, /`shadowgraph activate extraction`/u);
});

test('SessionStart with extraction active and items still pending says they are not yet processed', async (t) => {
  const w = await workspace(t);
  const extraction = await activate(w, { extraction: true });
  await save(w, (graph) => {
    captureOf(graph, 'We will use csv-parse because quoted fields contain commas.', 's1', extractionBinding(extraction));
    captureOf(graph, 'Keep the column mapping in config/columns.json.', 's1', extractionBinding(extraction));
  });
  const { head, processing } = await deliver(w, 'SessionStart');
  assert.deepEqual([head.total, processing.extraction, processing.pending], [0, 'active', 2]);
  assert.equal(head.limitation.code, 'extraction_pending');
  assert.match(head.limitation.detail, /2 captured items of this project are not yet processed by extraction/u);
});

test('SessionStart with records keeps the session start\'s own limitation', async (t) => {
  const w = await workspace(t);
  await save(w, (graph) => graph.addDecision({ project: 'app', title: 'Parser', chosen: 'csv-parse' }));
  await activate(w);
  assert.equal((await deliver(w, 'SessionStart')).head.limitation.code, 'relevance_not_assessed');
});

// A decision whose full record can never fit the payload: its line holds the
// choice, the rejected alternative and its reason, and leaves out a long assumption.
async function longDecision(t) {
  const w = await workspace(t);
  const graph = await save(w, (g) => g.addDecision({ project: 'app', title: 'Reconcile deposits', chosen: 'use a two-pass matcher',
    alternatives: [{ label: 'a single greedy pass', reasonRejected: 'the greedy pass matched one deposit to two invoices', status: 'rejected' }],
    assumptions: [`Bank feeds settle one business day late: ${'branch settlement detail '.repeat(100)}`],
    evidence: Array.from({ length: 12 }, (unused, index) => `Measured on feed ${index}: ${'deposit matched by amount then reference '.repeat(16)}`) }));
  const [record] = privilegedSnapshot(graph).records.filter((row) => row.kind === 'decision');
  assert.ok(bytes(JSON.stringify(record)) > DELIVERY_CAP_BYTES, 'the full record alone exceeds the cap');
  return { w, graph, record };
}

const asLine = (item, record) => {
  assert.equal(item.tier, 'T1');
  assert.equal(item.expansion.recordId, record.id);
  assert.match(item.line, /chose "use a two-pass matcher"/u);
  assert.match(item.line, /rejected "a single greedy pass", recorded reason "the greedy pass matched one deposit to two invoices"/u);
  assert.deepEqual(item.omitted, ['assumptions[0]']);
  assert.equal(item.requiresExpansion, true);
};

test('SessionStart: a record too large for the payload is delivered as its line, the omitted part declared', async (t) => {
  const { w, graph, record } = await longDecision(t);
  await activate(w);
  const { head, items } = await deliver(w, 'SessionStart');
  assert.deepEqual([head.total, head.delivered, head.omittedForSize], [1, 1, 0]);
  asLine(items[0], record);
  // The line names the revision the read's own handle names, and expands as current.
  const [read] = graph.context({ project: 'app', query: '', compact: true, limit: 1000 }).relevant.items;
  assert.equal(items[0].expansion.digest, read.expansion.digest);
  const { operation, scope, ...handle } = items[0].expansion;
  assert.equal(graph.expand({ ...handle, project: scope.project }).status, 'current');
});

test('UserPromptSubmit: a matching record too large for the payload is delivered as its line, the omitted part declared', async (t) => {
  const { w, record } = await longDecision(t);
  await activate(w);
  const { head, items } = await deliver(w, 'UserPromptSubmit', 'How should deposits be reconciled with the two-pass matcher?');
  assert.deepEqual([head.total, head.delivered, head.omittedForSize], [1, 1, 0]);
  asLine(items[0], record);
  // The same words in the host's own message (a subagent's report arrives as a
  // prompt) are not the user asking: the records are not delivered again.
  assert.equal(await deliver(w, 'UserPromptSubmit', '<agent-message from="a1b2">\nHow should deposits be reconciled with the two-pass matcher?\n</agent-message>'), null);
});

test('an attempt reason the extractor kept without a verified cause is shown, labelled model-proposed; none stays unknown', () => {
  const attempt = { id: 'attempt_x', kind: 'attempt', project: 'app', solution: 'Splitting each CSV line on commas', result: 'row 14 produced 9 columns', createdAt: '2026-11-01T00:00:00.000Z',
    reason: 'The payee field "ACME, Inc." is quoted and contains a comma', causalClaim: { state: 'unknown' } };
  const line = t1Line(attempt, { ceiling: 2048 });
  assert.match(line.line, /; reason "The payee field \\"ACME, Inc.\\" is quoted and contains a comma" \(model-proposed, not verified\);/u);
  assert.doesNotMatch(line.line, /reason unknown/u);
  assert.deepEqual([line.outcome.reasonState, line.claimClass], ['unknown', 'not_classified']);
  assert.match(t1Line({ ...attempt, reason: '' }, { ceiling: 2048 }).line, /; reason unknown;/u);
  assert.match(t1Line({ ...attempt, reason: '  ' }, { ceiling: 2048 }).line, /; reason unknown;/u);
});

// Through the extraction commit path: a user's decision, then a later message
// correcting it whose fields the claim checks do not establish, kept verbatim
// as a memory that links the decision without closing it.
async function correctedDecision(t) {
  const w = await workspace(t);
  const binding = { provider: 'claude', accountFingerprint: 'a'.repeat(64), setupId: randomUUID() };
  const options = { type: 'json', file: w.file, env: { SHADOWGRAPH_HOME: w.home }, project: 'app', recipe: QUOTED_RECIPE, model: MODEL, extractionBinding: binding };
  const receipt = { invocationStarted: true, model: MODEL };
  const load = async () => { const store = await createStorage(options); try { return await store.load(); } finally { store.close(); } };
  const commit = async (text, sessionId, record) => {
    const graph = createShadowGraph(); graph.importData(await load());
    captureOf(graph, text, sessionId, binding);
    const store = await createStorage(options); await store.save(privilegedSnapshot(graph)); store.close();
    const claim = await claimCapture(options);
    const value = { records: [record(claim)] };
    assert.equal((await commitCapture(options, claim, { status: 'success', receipt, value })).status, 'committed');
  };
  await save(w);
  const field = (claim, name, text) => ({ name, text, sourceRef: claim.id });
  await commit('We will use webpack instead of rollup because the team already knows its configuration.', 's1', (claim) => ({ kind: 'decision',
    fields: [field(claim, 'chosen', 'use webpack'), field(claim, 'alternative', 'rollup'), field(claim, 'reason', 'because the team already knows its configuration')] }));
  const decision = (await load()).records.find((row) => row.kind === 'decision');
  const correction = 'This replaces the webpack decision. We will use esbuild instead of webpack because webpack builds took 48 seconds and esbuild takes under one second.';
  await commit(correction, 's2', (claim) => {
    const candidate = claim.correctionCandidates.find((entry) => entry.recordId === decision.id);
    assert.ok(candidate, 'the decision is offered as the correction\'s target');
    return { kind: 'decision', fields: [field(claim, 'chosen', 'use esbuild'), field(claim, 'alternative', 'webpack'), field(claim, 'reason', 'because webpack builds took 48 seconds and esbuild takes under one second')],
      correction: { recordId: candidate.recordId, priorChosen: candidate.priorChosen, statement: 'This replaces the webpack decision.' } };
  });
  const data = await load();
  const memory = data.records.find((row) => row.correction?.recordId === decision.id);
  assert.equal(memory?.kind, 'memory', 'the correction is kept verbatim as a memory');
  assert.equal(memory.correction.applied, false);
  assert.equal(data.records.find((row) => row.id === decision.id).status, decision.status, 'the decision is not closed');
  await activate(w);
  return { w, decision, memory };
}

test('SessionStart: a decision a later message corrects says so in words, and the correction follows it directly', async (t) => {
  const { w, decision, memory } = await correctedDecision(t);
  const { head, items } = await deliver(w, 'SessionStart');
  assert.deepEqual([head.total, head.byKind.decision, head.byKind.memory, head.delivered], [2, 1, 1, 2]);
  const at = items.findIndex((item) => idOf(item) === decision.id);
  assert.ok(at >= 0, 'the corrected decision is delivered');
  assert.equal(idOf(items[at + 1]), memory.id, 'its correction directly after it');
  assert.deepEqual(items[at].correctedBy, [memory.id]);
  assert.match(items[at].corrected, /a later message corrects this record/iu);
  assert.match(items[at].corrected, /nothing was closed automatically/u);
  assert.match(items[at].corrected, /not verified/u);
  const line = items[at + 1].line;
  assert.match(line, /Model-proposed correction relationship, not independently verified/u);
  assert.match(line, new RegExp(`this later message corrects "${decision.id}", which nothing closed automatically, so it is still marked current`, 'u'));
  assert.doesNotMatch(line, /stays current, marked as corrected/u);
});

test('the line of a correction kept unapplied says the later message corrects the record, without claiming it was applied', () => {
  const memory = { id: 'memory_x', kind: 'memory', project: 'app', memoryType: 'note', key: 'k', text: 'This replaces the webpack decision.', status: 'active', createdAt: '2026-11-01T00:00:00.000Z',
    correction: { status: 'model_proposed', recordId: 'decision_y', statement: 'This replaces the webpack decision.', applied: false } };
  const { line } = t1Line(memory, { ceiling: 2048 });
  assert.match(line, /^Model-proposed correction relationship, not independently verified; this later message corrects "decision_y", which nothing closed automatically, so it is still marked current; source statement "This replaces the webpack decision."/u);
  assert.doesNotMatch(line, /applied:|stays current/u);
});

test('SessionStart: the correction follows the record it corrects, not the place its kind and age give it', async (t) => {
  const { w, decision, memory } = await correctedDecision(t);
  const options = { type: 'json', file: w.file, env: { SHADOWGRAPH_HOME: w.home } };
  const store = await createStorage(options);
  const graph = createShadowGraph(); graph.importData(await store.load());
  graph.addDecision({ project: 'app', title: 'Runtime', chosen: 'Node 24' });
  graph.addDecision({ project: 'app', title: 'Formatter', chosen: 'prettier' });
  await store.save(privilegedSnapshot(graph)); store.close();
  const ids = (await deliver(w, 'SessionStart')).items.map(idOf);
  assert.equal(ids.length, 4);
  // Newest first within a kind and the kinds in turn would put the one memory second.
  assert.deepEqual(ids.slice(2), [decision.id, memory.id]);
});

test('SessionStart with nothing captured names no extraction cause, whatever else the store holds', async (t) => {
  const w = await workspace(t);
  await save(w, (graph) => graph.remember({ project: 'app', memoryType: 'note', key: 'port', text: 'The service listens on 9001.' }));
  await activate(w);
  const { head } = await deliver(w, 'SessionStart');
  assert.deepEqual([head.total, head.limitation.code], [0, 'relevance_not_assessed']);
});
