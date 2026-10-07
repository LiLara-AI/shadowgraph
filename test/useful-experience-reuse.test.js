import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { privilegedSnapshot, privilegedIssueAccess } from '../src/internal/snapshot.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';

const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const backendSkip = (type) => (type === 'sqlite' && !sqlite.available ? { skip: sqlite.reason } : {});

// Synthetic observations, not measured SQLite results or a sharing policy.
// The point is to retain context/evidence and expose the actual grant width.
function example() {
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  const failed = graph.addAttempt({ project: 'beta', solution: 'SQLite WAL: eight concurrent writer workers',
    result: 'Synthetic run: SQLITE_BUSY in 12 of 100 transactions', resultClass: 'failed',
    reason: 'Writer contention was suspected; this observation does not isolate a cause',
    environment: 'Single host, SQLite WAL, eight workers, 50 ms busy timeout', sourceClass: 'tool_observed',
    reusableWhen: [{ key: 'writerConcurrency', operator: 'equals', value: 1 }] });
  const succeeded = graph.addAttempt({ project: 'beta', solution: 'SQLite bounded single-writer queue',
    result: 'Synthetic rerun: 100 of 100 transactions completed', resultClass: 'succeeded',
    reason: 'Serialized writes avoided the observed contention in this workload only',
    environment: 'Same single host, WAL, one writer, queue capacity 100', sourceClass: 'tool_observed', relatedTo: [failed.id] });
  const choice = graph.addDecision({ project: 'beta', title: 'SQLite ingestion design', chosen: 'Use the bounded writer queue',
    goal: 'Complete this single-host ingestion workload', confidence: 0.7, assumptions: ['One host; workload fits bounded queue'],
    failedAttempts: [failed.id], evidence: [{ source: 'synthetic://sqlite/run-1-and-run-2', sourceClass: 'tool_observed',
      confidence: 0.7, detail: 'Fixture observations: 12 busy failures, then zero; no multi-host evidence' }] });
  const policy = graph.addDecision({ project: 'beta', title: 'Beta private deployment constraint', chosen: 'EU-only hosting for Beta contract',
    goal: 'Meet Beta local contract', assumptions: ['Applies to Beta only'], sourceClass: 'human_confirmed' });
  const local = graph.addDecision({ project: 'alpha', title: 'Alpha SQLite investigation', chosen: 'Evaluate evidence for Alpha workload', failedAttempts: [failed.id] });
  const accessId = privilegedIssueAccess(graph, { scope: { projects: ['beta'] }, surfaces: ['cli', 'http', 'mcp'],
    expiresAt: '2099-01-01T00:00:00.000Z', reason: 'Synthetic owner-approved project-wide comparison' }).entry.accessId;
  return { graph, failed, succeeded, choice, policy, local, accessId };
}

test('explicit authorized retrieval preserves useful technical experience, conditions, evidence and local policy attribution', () => {
  const { graph, failed, succeeded, choice, policy, accessId } = example();
  const options = { project: 'alpha', accessId, limit: 100 };
  const hidden = graph.retrieve('SQLite', { project: 'alpha' });
  assert.equal(JSON.stringify(hidden).includes(failed.id), false);
  const read = graph.retrieve('SQLite', options);
  const records = read.items.map(x => x.record);
  const failure = records.find(x => x.id === failed.id), success = records.find(x => x.id === succeeded.id);
  assert.equal(failure.result, 'Synthetic run: SQLITE_BUSY in 12 of 100 transactions');
  assert.equal(failure.reason, 'Writer contention was suspected; this observation does not isolate a cause');
  assert.equal(failure.environment, 'Single host, SQLite WAL, eight workers, 50 ms busy timeout');
  assert.deepEqual(failure.reusableWhen, [{ key: 'writerConcurrency', operator: 'equals', value: 1 }]);
  assert.equal(failure.sourceClass, 'tool_observed');
  assert.equal(failure.causalClaim.sourceClass, 'agent_claimed', 'an observed outcome does not prove its proposed cause');
  assert.deepEqual(failure.causalClaim.evidence, []);
  assert.equal(success.resultClass, 'succeeded');
  assert.deepEqual(success.relatedTo, [failed.id]);
  const decision = records.find(x => x.id === choice.id);
  assert.equal(decision.project, 'beta');
  assert.equal(decision.confidence.initial, 0.7);
  assert.equal(decision.confidence.current, 0.7);
  assert.deepEqual(decision.assumptions, ['One host; workload fits bounded queue']);
  assert.equal(decision.evidence[0].source, 'synthetic://sqlite/run-1-and-run-2');
  assert.equal(decision.evidence[0].detail, 'Fixture observations: 12 busy failures, then zero; no multi-host evidence');
  // The grant covers the source project, including its private local choice.
  // Query relevance is not lesson-only authorization.
  const localChoice = graph.search('deployment constraint', options).items.find(x => x.record.id === policy.id).record;
  assert.equal(localChoice.project, 'beta');
  assert.equal(localChoice.chosen, 'EU-only hosting for Beta contract');
  assert.deepEqual(localChoice.assumptions, ['Applies to Beta only']);
  assert.equal(read.readProvenance.request.project, 'alpha');
  assert.equal(read.completeness.scope.grant.accessId, accessId);
  const lessonOnly = privilegedIssueAccess(graph, { scope: { recordIds: [failed.id] }, surfaces: ['cli'],
    expiresAt: '2099-01-01T00:00:00.000Z', reason: 'unsupported lesson selector' });
  assert.equal(lessonOnly.ok, false);
});

test('revocation removes explicit reuse and rechecks a previously issued expansion handle', () => {
  const { graph, failed, accessId, local } = example();
  const options = { project: 'alpha', accessId };
  const context = graph.context({ ...options, query: 'SQLite', compact: true, limit: 100 });
  const line = context.relevant.items.find(x => x.line?.recordId === failed.id).line;
  const { operation, scope, ...handle } = line.expansion;
  const input = { ...handle, ...options };
  assert.equal(graph.expand(input).record.id, failed.id);
  assert.ok(graph.context(options).activeDecisions.find(x => x.id === local.id).failedAttempts.includes(failed.id));
  // Merely seeing a failure is not permission to retry it: condition unknown.
  assert.equal(graph.context(options).reusableAttempts.some(x => x.attemptId === failed.id), false);
  graph.revokeAccess({ accessId });
  for (const method of ['search', 'retrieve', 'recall']) {
    const result = graph[method]('SQLite', { ...options, readProvenance: context.readProvenance });
    assert.equal(JSON.stringify(result).includes(failed.id), false, method);
  }
  assert.equal(graph.expand(input).status, 'unavailable');
  assert.deepEqual(graph.context(options).activeDecisions.find(x => x.id === local.id).failedAttempts, []);
});

for (const type of ['json', 'sqlite']) test(`${type}: an existing project grant permits explicit CLI retrieval but does not widen automatic SessionStart delivery`, backendSkip(type), async t => {
  const f = example();
  const root = await mkdtemp(join(tmpdir(), 'sg-useful-reuse-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'workspace'), home = join(root, 'home'), file = join(root, 'store');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true }); await mkdir(home);
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: cwd, project: 'alpha', confirmed: true }));
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^(SHADOWGRAPH_|ANTHROPIC_|CLAUDE_|OPENAI_)/.test(key) || key === 'NODE_OPTIONS') delete env[key];
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SHADOWGRAPH_HOME']) env[key] = home;
  env.SHADOWGRAPH_FILE = file; env.SHADOWGRAPH_STORAGE = type;
  const store = await createStorage({ type, file, env });
  await store.save(privilegedSnapshot(f.graph)); await store.close();
  const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
  const run = (args, input = '') => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, input, encoding: 'utf8', timeout: 20000 });
    assert.equal(result.status, 0, result.stderr || result.stdout); return JSON.parse(result.stdout);
  };
  const explicit = run(['retrieve', JSON.stringify({ project: 'alpha', accessId: f.accessId, query: 'SQLite', limit: 100 })]);
  assert.ok(JSON.stringify(explicit).includes(f.failed.id));
  assert.ok(JSON.stringify(explicit).includes('12 of 100 transactions'));
  const automatic = run(['deliver', '--file', file, '--storage', type], JSON.stringify({ hook_event_name: 'SessionStart' })).hookSpecificOutput.additionalContext;
  assert.ok(automatic.includes('Alpha SQLite investigation'));
  for (const id of [f.failed.id, f.succeeded.id, f.choice.id, f.policy.id]) assert.equal(automatic.includes(id), false, id);
  assert.equal(automatic.includes('EU-only hosting'), false);
});
