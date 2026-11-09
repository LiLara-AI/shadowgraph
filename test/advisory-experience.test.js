import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createShadowGraph } from '../src/shadowgraph.js';
import { resolveDefaultProject, resolveStoragePath } from '../src/storage.js';
import { formatRuleCompact, normalizeOperator, parseConditionString } from '../src/condition-eval.js';
import { expandSearchTokens, extractKeywords, stemArabicToken } from '../src/hybrid-search.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

function startMcpProcess({ cwd, env }) {
  const mcpEntry = join(process.cwd(), 'src', 'mcp.js');
  const child = spawn(process.execPath, [mcpEntry], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  const pending = new Map();
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    const lines = stdout.split(/\r?\n/);
    stdout = lines.pop();
    for (const line of lines.filter((candidate) => candidate.trim())) {
      const response = JSON.parse(line);
      const waiter = pending.get(JSON.stringify(response.id));
      if (!waiter) continue;
      pending.delete(JSON.stringify(response.id));
      waiter.resolve(response);
    }
  });
  child.on('exit', (code) => {
    for (const waiter of pending.values()) waiter.reject(new Error(`MCP exited ${code}: ${stderr}`));
    pending.clear();
  });
  return {
    call(request) {
      return new Promise((resolveCall, rejectCall) => {
        const key = JSON.stringify(request.id);
        const timer = setTimeout(() => {
          pending.delete(key);
          rejectCall(new Error(`MCP call timed out: ${stderr}`));
        }, 15_000);
        pending.set(key, {
          resolve(value) { clearTimeout(timer); resolveCall(value); },
          reject(error) { clearTimeout(timer); rejectCall(error); }
        });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    },
    async stop() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  };
}

test('Q1: smart storage path resolution and default project naming', async (t) => {
  const dir = await scratchDirectory(t, 'shadowgraph-storage-resolve-');
  const fakeHome = join(dir, 'home');
  const repoWithLocal = join(dir, 'repo-local');
  const repoWithoutLocal = join(dir, 'repo-global');
  await mkdir(join(repoWithLocal, '.shadowgraph'), { recursive: true });
  await mkdir(repoWithoutLocal, { recursive: true });
  const localDataPath = join(repoWithLocal, '.shadowgraph', 'data.json');
  await writeFile(localDataPath, '{}', 'utf8');

  // 1. Explicit file wins
  assert.equal(resolveStoragePath('/custom/store.json', { cwd: repoWithLocal, homedir: fakeHome }), '/custom/store.json');

  // 2. Repo-local ./.shadowgraph/data.json is respected when it exists
  assert.equal(
    resolveStoragePath(undefined, { env: {}, cwd: repoWithLocal, homedir: fakeHome }),
    localDataPath
  );

  // 3. Otherwise falls back to unified ~/.shadowgraph/data.json
  assert.equal(
    resolveStoragePath(undefined, { env: {}, cwd: repoWithoutLocal, homedir: fakeHome }),
    join(fakeHome, '.shadowgraph', 'data.json')
  );

  // 4. Default project naming uses explicit -> env -> cwd basename -> default
  assert.equal(resolveDefaultProject('explicit-proj', { env: { SHADOWGRAPH_PROJECT: 'env-proj' }, cwd: repoWithoutLocal }), 'explicit-proj');
  assert.equal(resolveDefaultProject(undefined, { env: { SHADOWGRAPH_PROJECT: 'env-proj' }, cwd: repoWithoutLocal }), 'env-proj');
  assert.equal(resolveDefaultProject(undefined, { env: {}, cwd: repoWithoutLocal }), 'repo-global');
});

test('Q1 & Q4: cross-project isolation in context() with advisory crossProjectExperience, userMemories, successfulApproaches, relevantToTask, and visibility control', () => {
  const graph = createShadowGraph();

  // Record a user preference and profile in project-a (global by default) and a note (project-scoped by default)
  graph.remember({
    project: 'project-a',
    memoryType: 'preference',
    key: 'code-style',
    text: 'Always use ESM imports and strict assertions'
  });
  graph.remember({
    project: 'project-a',
    memoryType: 'profile',
    key: 'role',
    text: 'Principal Distributed Systems Architect'
  });
  graph.remember({
    project: 'project-a',
    memoryType: 'note',
    key: 'secret-internal',
    text: 'Project-A internal port is 9001'
  });

  // Record a decision in project-a (should NOT appear in project-b activeDecisions)
  const decA = graph.addDecision({
    project: 'project-a',
    title: 'Database engine for project A',
    chosen: 'PostgreSQL',
    status: 'validated'
  });

  // Record a failed attempt in project-a with a retry condition
  const failedAttemptA = graph.addAttempt({
    project: 'project-a',
    task: 'Bulk CSV import',
    solution: 'Parallel worker batch import',
    result: 'failed: rate limit exceeded on API',
    resultClass: 'failed',
    reason: 'API rate limit was 100 rpm',
    environment: 'node-22',
    reusableWhen: ['apiRateLimitPerMin >= 600']
  });

  // Record a private failed attempt in project-a (visibility: project)
  graph.addAttempt({
    project: 'project-a',
    solution: 'Private project-a workaround',
    result: 'failed',
    resultClass: 'failed',
    visibility: 'project'
  });

  // Record a successful attempt in project-a
  const successAttemptA = graph.addAttempt({
    project: 'project-a',
    task: 'Cache warming',
    solution: 'Preload Redis keys from snapshot stream',
    result: 'succeeded with 4x faster startup',
    resultClass: 'succeeded',
    environment: 'node-22'
  });

  // Record a decision in project-b
  const decB = graph.addDecision({
    project: 'project-b',
    title: 'Queue transport for project B',
    chosen: 'Redis Streams'
  });

  // Evaluate context for project-b with a task query
  const ctxB = graph.context({ project: 'project-b', task: 'Bulk import worker' });

  // Anti-hallucination: activeDecisions and failedAttemptsToAvoid in project-b only contain project-b items
  assert.deepEqual(ctxB.activeDecisions.map((d) => d.id), [decB.id]);
  assert.deepEqual(ctxB.failedAttemptsToAvoid, []);

  // User preference and profile from project-a surface in userMemories with sourceProject & crossProject labels,
  // while default project-scoped 'note' memory is excluded
  assert.equal(ctxB.userMemories.length, 2);
  assert.deepEqual(ctxB.userMemories.map((m) => m.key).sort(), ['code-style', 'role']);
  assert.ok(ctxB.userMemories.every((m) => m.sourceProject === 'project-a' && m.crossProject === true));

  // relevantToTask surfaces cross-project matching attempt from project-a
  assert.ok(ctxB.relevantToTask.some((item) => item.id === failedAttemptA.id && item.sourceProject === 'project-a' && item.crossProject === true));

  // Successful approaches include validated decision and succeeded attempt from project-a
  assert.ok(ctxB.successfulApproaches.some((item) => item.id === successAttemptA.id && item.sourceProject === 'project-a'));
  assert.ok(ctxB.successfulApproaches.some((item) => item.id === decA.id && item.sourceProject === 'project-a'));

  // Cross-project experience includes failedAttemptA and decA, but NOT the visibility: 'project' attempt
  assert.ok(ctxB.crossProjectExperience.some((item) => item.id === failedAttemptA.id && item.reusableNow === false));
  assert.ok(!ctxB.crossProjectExperience.some((item) => item.solution === 'Private project-a workaround'));

  // Digest is present and compact
  assert.equal(ctxB.digest.project, 'project-b');
  assert.equal(ctxB.digest.task, 'Bulk import worker');
  assert.equal(ctxB.digest.counts.activeDecisions, 1);
  assert.equal(ctxB.digest.counts.userMemories, 2);
  assert.ok(ctxB.digest.counts.relevantToTask >= 1);
});

test('Q2 & Q3: flexible symbolic conditions and cross-project fact evaluation excluding contradicted facts', () => {
  // Symbolic operator parsing and formatting
  assert.equal(normalizeOperator('>='), 'gte');
  assert.equal(normalizeOperator('<='), 'lte');
  assert.equal(normalizeOperator('=='), 'equals');
  assert.equal(normalizeOperator('!='), 'not_equals');
  assert.equal(normalizeOperator('>'), 'greater_than');
  assert.equal(normalizeOperator('<'), 'less_than');

  const parsed = parseConditionString('apiRateLimitPerMin >= 600');
  assert.deepEqual(parsed, { key: 'apiRateLimitPerMin', operator: 'gte', value: 600 });
  assert.equal(formatRuleCompact(parsed), 'apiRateLimitPerMin >= 600');

  // Natural language condition strings are preserved without throwing
  assert.equal(parseConditionString('when the vendor upgrades the sandbox tier'), null);

  const graph = createShadowGraph();
  const attempt = graph.addAttempt({
    project: 'proj-1',
    solution: 'Parallel batch uploader',
    result: 'failed due to quota',
    resultClass: 'failed',
    reusableWhen: [
      'apiRateLimitPerMin >= 600',
      { key: 'region', operator: '==', value: 'eu-west-1' }
    ]
  });

  // Stored rules normalized symbolic operators cleanly
  assert.equal(attempt.reusableWhen[0].operator, 'gte');
  assert.equal(attempt.reusableWhen[1].operator, 'equals');

  // Contradicted fact must NOT satisfy conditions
  graph.addFact({
    project: 'proj-1',
    key: 'apiRateLimitPerMin',
    value: 1000,
    verificationStatus: 'contradicted'
  });
  graph.addFact({
    project: 'proj-1',
    key: 'region',
    value: 'eu-west-1'
  });

  let ctx1 = graph.context({ project: 'proj-1' });
  assert.equal(ctx1.reusableAttempts.length, 0, 'contradicted fact must not satisfy reusableWhen');
  assert.equal(ctx1.failedAttemptsToAvoid[0].reusableNow, false);

  // Now record a valid non-contradicted fact in proj-1
  graph.addFact({
    project: 'proj-1',
    key: 'apiRateLimitPerMin',
    value: 800,
    sourceClass: 'tool_observed'
  });
  ctx1 = graph.context({ project: 'proj-1' });
  assert.equal(ctx1.reusableAttempts.length, 1);
  assert.equal(ctx1.failedAttemptsToAvoid[0].reusableNow, true);
  assert.deepEqual(ctx1.failedAttemptsToAvoid[0].conditionSummary, [
    'apiRateLimitPerMin >= 600',
    'region == eu-west-1'
  ]);

  // If proj-2 records a contradicted fact for apiRateLimitPerMin, it must block fallback to proj-1's 800
  graph.addFact({
    project: 'proj-2',
    key: 'apiRateLimitPerMin',
    value: 800,
    verificationStatus: 'contradicted'
  });
  const ctx2Contradicted = graph.context({ project: 'proj-2' });
  const crossAttemptContradicted = ctx2Contradicted.crossProjectExperience.find((x) => x.id === attempt.id);
  assert.equal(crossAttemptContradicted.reusableNow, false, 'contradicted local fact in proj-2 must block fallback to proj-1 fact');
  assert.ok(Array.isArray(crossAttemptContradicted.conditionEvaluations));

  // Cross-project condition evaluation in proj-2 uses proj-2 facts first, falling back to proj-1 facts
  graph.addFact({
    project: 'proj-2',
    key: 'apiRateLimitPerMin',
    value: 200
  });
  const ctx2Blocked = graph.context({ project: 'proj-2' });
  const crossAttemptBlocked = ctx2Blocked.crossProjectExperience.find((x) => x.id === attempt.id);
  assert.equal(crossAttemptBlocked.reusableNow, false, 'proj-2 local fact (200 < 600) overrides proj-1 fact (800)');

  graph.addFact({
    project: 'proj-2',
    key: 'apiRateLimitPerMin',
    value: 900
  });
  const ctx2Ready = graph.context({ project: 'proj-2' });
  const crossAttemptReady = ctx2Ready.crossProjectExperience.find((x) => x.id === attempt.id);
  assert.equal(crossAttemptReady.reusableNow, true, 'proj-2 local fact (900 >= 600) + fallback region fact satisfies condition');
});

test('Q5: historical evolution attaches changeSummary, supports chronological backfill, and recall(includeHistory: true) returns full timeline', () => {
  const graph = createShadowGraph({ now: () => '2026-08-01T00:00:00.000Z' });

  // 1. Memory evolution + historical backfill across 3 chronological versions
  const vMid = graph.remember({
    project: 'app',
    memoryType: 'preference',
    key: 'test-runner',
    text: 'Use Jest for unit tests',
    validFrom: '2026-06-01T00:00:00.000Z'
  });
  const updatedMem = graph.remember({
    project: 'app',
    memoryType: 'preference',
    key: 'test-runner',
    text: 'Use node:test for zero-dependency tests',
    reason: 'eliminates external test runner dependency',
    validFrom: '2026-08-01T00:00:00.000Z'
  });
  assert.equal(updatedMem.operation, 'UPDATE');
  assert.match(updatedMem.memory.changeSummary, /Changed from "Use Jest for unit tests" to "Use node:test for zero-dependency tests" because eliminates external test runner dependency/);

  // Backfill an even earlier memory version (2026-01-01) with allowHistorical: true
  const backfilledMem = graph.remember({
    project: 'app',
    memoryType: 'preference',
    key: 'test-runner',
    text: 'Use Mocha for legacy tests',
    validFrom: '2026-01-01T00:00:00.000Z',
    allowHistorical: true
  });
  assert.equal(backfilledMem.operation, 'ADD');
  assert.equal(backfilledMem.backfilled, true);
  assert.equal(backfilledMem.memory.status, 'superseded');
  assert.equal(backfilledMem.memory.supersededBy, vMid.memory.id, 'backfilled version links to immediate chronological successor');
  assert.equal(backfilledMem.memory.temporal.validTo, '2026-06-01T00:00:00.000Z');

  // 2. Fact evolution + historical backfill
  const fMid = graph.addFact({ project: 'app', key: 'nodeVersion', value: '18.x', validFrom: '2026-06-01T00:00:00.000Z' });
  const updatedFact = graph.addFact({ project: 'app', key: 'nodeVersion', value: '22.x', reason: 'LTS upgrade', validFrom: '2026-08-01T00:00:00.000Z' });
  assert.match(updatedFact.changeSummary, /Changed from "18\.x" to "22\.x" because LTS upgrade/);
  const fEarly = graph.addFact({ project: 'app', key: 'nodeVersion', value: '16.x', validFrom: '2026-01-01T00:00:00.000Z', allowHistorical: true });
  assert.equal(fEarly.status, 'superseded');
  assert.equal(fEarly.supersededBy, fMid.id);
  assert.equal(fEarly.temporal.validTo, '2026-06-01T00:00:00.000Z');

  // 3. Decision evolution via inline supersedes on addDecision
  const firstDec = graph.addDecision({
    project: 'app',
    title: 'Primary datastore',
    chosen: 'SQLite'
  });
  const secondDec = graph.addDecision({
    project: 'app',
    title: 'Primary datastore',
    chosen: 'PostgreSQL',
    supersedes: [firstDec.id, firstDec.id],
    reason: 'multi-node write concurrency'
  });
  assert.equal(secondDec.supersedes.includes(firstDec.id), true);
  assert.match(secondDec.changeSummary, /Changed from "SQLite" to "PostgreSQL" because multi-node write concurrency/);

  // Validate graph integrity after historical backfills and deduplicated supersession
  assert.equal(graph.validate({ project: 'app' }).valid, true);

  // Only the new decision is active in context()
  const ctx = graph.context({ project: 'app' });
  assert.deepEqual(ctx.activeDecisions.map((d) => d.id), [secondDec.id]);

  // Default recall() returns only active items
  const activeRecall = graph.recall('datastore', { project: 'app' });
  assert.equal(activeRecall.items.some((i) => i.record.id === firstDec.id), false);
  assert.equal(activeRecall.items.some((i) => i.record.id === secondDec.id), true);

  // recall() with includeHistory: true returns full timeline and attaches historyChain
  const historyRecall = graph.recall('datastore', { project: 'app', includeHistory: true });
  assert.equal(historyRecall.items.some((i) => i.record.id === firstDec.id), true);
  const activeItemWithChain = historyRecall.items.find((i) => i.record.id === secondDec.id);
  assert.ok(Array.isArray(activeItemWithChain.historyChain));
  assert.equal(activeItemWithChain.historyChain.length, 2);
  assert.equal(activeItemWithChain.historyChain[0].id, firstDec.id);
  assert.equal(activeItemWithChain.historyChain[1].id, secondDec.id);

  // Memory recall with includeHistory: true has 3 chronological versions in historyChain
  const memHistoryRecall = graph.recall('test-runner', { project: 'app', includeHistory: true });
  const activeMemItem = memHistoryRecall.items.find((i) => i.record.id === updatedMem.memory.id);
  assert.equal(activeMemItem.historyChain.length, 3);
  assert.deepEqual(
    activeMemItem.historyChain.map((item) => item.id),
    [backfilledMem.memory.id, vMid.memory.id, updatedMem.memory.id]
  );
});

test('Q6: Arabic stemming, bilingual synonym expansion, keyword tags, outcome lessons indexing, and partial matching', () => {
  assert.ok(stemArabicToken('الاختبارات').includes('اختبار'));
  assert.ok(stemArabicToken('التخزين').includes('تخزين'));
  assert.ok(expandSearchTokens('ذاكرة').includes('memory'));
  assert.ok(expandSearchTokens('cache').includes('كاش'));
  assert.ok(extractKeywords('Redis caching latency optimization').includes('redis'));

  const graph = createShadowGraph();
  const dec = graph.addDecision({
    project: 'search-proj',
    title: 'تحسين التخزين المؤقت',
    chosen: 'Redis cluster',
    status: 'executed'
  });
  graph.setOutcome(dec.id, {
    status: 'successful',
    lessons: ['Connection pooling prevented socket exhaustion under burst traffic'],
    autoTransition: true
  }, { project: 'search-proj' });

  const attempt = graph.addAttempt({
    project: 'search-proj',
    task: 'Fix authentication token refresh race condition',
    solution: 'Mutex lock around refresh call',
    result: 'succeeded',
    resultClass: 'succeeded'
  });

  // 1. Decision automatically transitioned to 'validated' via autoTransition, and both decision & attempt auto-extracted tags
  const updatedDec = graph.exportData({ project: 'search-proj' }).records.find((r) => r.id === dec.id);
  assert.equal(updatedDec.status, 'validated');
  assert.ok(Array.isArray(updatedDec.tags) && updatedDec.tags.length > 0);
  assert.ok(Array.isArray(attempt.tags) && attempt.tags.includes('mutex'));

  // 2. Search finds decision via outcome.lessons
  const byLesson = graph.search('socket exhaustion', { project: 'search-proj' });
  assert.equal(byLesson.items.length, 1);
  assert.equal(byLesson.items[0].record.id, dec.id);

  // 3. Search finds attempt via attempt.task
  const byTask = graph.search('refresh race condition', { project: 'search-proj' });
  assert.equal(byTask.items.length, 1);
  assert.equal(byTask.items[0].record.id, attempt.id);

  // 4. Arabic morphological stem match ('تخزين' matches 'التخزين')
  const byArabicStem = graph.search('تخزين', { project: 'search-proj' });
  assert.equal(byArabicStem.items.length, 1);
  assert.equal(byArabicStem.items[0].record.id, dec.id);

  // 5. Partial match fallback when 1 term of a multi-term query is absent
  const partialHit = graph.search('Mutex lock nonexistentword123', { project: 'search-proj' });
  assert.equal(partialHit.items.length, 1);
  assert.equal(partialHit.items[0].record.id, attempt.id);
  assert.equal(partialHit.items[0].partialMatch, true);
});

test('Q7: compact mode lifecycle ergonomics (failedAttempts & relatedTo graph links walked by retrieve and traverse)', () => {
  const graph = createShadowGraph();

  const attempt1 = graph.addAttempt({
    project: 'ergo',
    task: 'Zero-downtime schema migration',
    solution: 'Lock table during alter',
    result: 'failed: blocked production writes',
    resultClass: 'failed'
  });

  const decision = graph.addDecision({
    project: 'ergo',
    title: 'Schema migration strategy',
    chosen: 'Expand-and-contract pattern',
    status: 'in_progress',
    failedAttempts: [attempt1.id]
  });

  const attempt2 = graph.addAttempt({
    project: 'ergo',
    task: 'Backfill new column',
    solution: 'Batched background backfill',
    result: 'succeeded',
    resultClass: 'succeeded',
    relatedTo: [decision.id]
  });

  // Initial status was set on addDecision
  assert.equal(decision.status, 'in_progress');

  // Graph relations were automatically created for both failedAttempts and relatedTo
  const traversed = graph.traverse({ project: 'ergo', id: decision.id, depth: 1 });
  const reachedIds = traversed.nodes.map((n) => n.id);
  assert.ok(reachedIds.includes(attempt1.id), 'failedAttempts creates a walkable graph relation');
  assert.ok(reachedIds.includes(attempt2.id), 'relatedTo creates a walkable graph relation');

  // retrieve() walks those implicit relations to surface neighbour attempts
  const retrieved = graph.retrieve('Expand-and-contract', { project: 'ergo' });
  const retrievedIds = retrieved.items.map((i) => i.record.id);
  assert.ok(retrievedIds.includes(decision.id));
  assert.ok(retrievedIds.includes(attempt1.id));
  assert.ok(retrievedIds.includes(attempt2.id));
});

test('Q1 & Q6 MCP end-to-end: multi-process unified store auto-project isolation + fail-open HTTP embeddings across all 4 entity kinds', async (t) => {
  const dir = await scratchDirectory(t, 'shadowgraph-mcp-multiprocess-');
  const fakeHome = join(dir, 'home');
  const alphaDir = join(dir, 'alpha-service');
  const betaDir = join(dir, 'beta-service');
  await mkdir(alphaDir, { recursive: true });
  await mkdir(betaDir, { recursive: true });

  let shouldFailEmbeddings = false;
  let embedCalls = 0;
  const embedServer = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      embedCalls += 1;
      if (shouldFailEmbeddings) {
        res.writeHead(503, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'service unavailable' }));
        return;
      }
      const parsed = JSON.parse(body || '{}');
      const text = String(parsed.input ?? '');
      const vec = text.toLowerCase().includes('redis') ? [0.9, 0.1, 0.0] : [0.1, 0.9, 0.0];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ embedding: vec }] }));
    });
  });
  embedServer.listen(0, '127.0.0.1');
  await once(embedServer, 'listening');
  t.after(() => embedServer.close());
  const embeddingUrl = `http://127.0.0.1:${embedServer.address().port}/v1`;

  // Start two MCP servers in different working directories with SHADOWGRAPH_FILE unset
  // and SHADOWGRAPH_EMBEDDING_MODEL omitted (testing default model fallback).
  const baseEnv = {
    SHADOWGRAPH_HOME: fakeHome,
    SHADOWGRAPH_MCP_COMPACT: '1',
    SHADOWGRAPH_EMBEDDING_URL: embeddingUrl,
    SHADOWGRAPH_EMBEDDING_TIMEOUT_MS: '1500'
  };
  delete baseEnv.SHADOWGRAPH_FILE;
  delete baseEnv.SHADOWGRAPH_PROJECT;
  delete baseEnv.SHADOWGRAPH_EMBEDDING_MODEL;

  const alphaMcp = startMcpProcess({ cwd: alphaDir, env: baseEnv });
  const betaMcp = startMcpProcess({ cwd: betaDir, env: baseEnv });
  t.after(async () => {
    await alphaMcp.stop();
    await betaMcp.stop();
  });

  // 1. Record decision, attempt, fact, and user preference in alpha-service without specifying project
  const decRes = await alphaMcp.call({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: {
      name: 'shadowgraph_record_decision',
      arguments: { title: 'Distributed cache', chosen: 'Redis cluster', status: 'validated' }
    }
  });
  assert.equal(decRes.error, undefined);
  const recordedDec = JSON.parse(decRes.result.content[0].text);
  assert.equal(recordedDec.project, 'alpha-service');
  assert.ok(recordedDec.embedding, 'decision received automatic embedding');

  const attRes = await alphaMcp.call({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'shadowgraph_record_attempt',
      arguments: {
        task: 'Redis failover test',
        solution: 'Client-side sentinel retry',
        result: 'failed: timeout too short',
        resultClass: 'failed',
        reusableWhen: ['sentinelTimeoutMs >= 2000']
      }
    }
  });
  assert.equal(attRes.error, undefined);
  const recordedAtt = JSON.parse(attRes.result.content[0].text);
  assert.equal(recordedAtt.project, 'alpha-service');
  assert.ok(recordedAtt.embedding, 'attempt received automatic embedding');

  const factRes = await alphaMcp.call({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: {
      name: 'shadowgraph_record_fact',
      arguments: { key: 'sentinelTimeoutMs', value: 2500, visibility: 'global' }
    }
  });
  assert.equal(factRes.error, undefined);
  const recordedFact = JSON.parse(factRes.result.content[0].text);
  assert.equal(recordedFact.project, 'alpha-service');
  assert.ok(recordedFact.embedding, 'fact received automatic embedding');

  const memRes = await alphaMcp.call({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: {
      name: 'shadowgraph_remember',
      arguments: { memoryType: 'preference', key: 'lang', text: 'Respond in concise English for engineering tasks' }
    }
  });
  assert.equal(memRes.error, undefined);
  const recordedMem = JSON.parse(memRes.result.content[0].text);
  assert.equal(recordedMem.memory.project, 'alpha-service');
  assert.ok(recordedMem.memory.embedding, 'memory received automatic embedding');
  assert.ok(embedCalls >= 4);

  // 2. beta-service automatically syncs from the unified store and scopes its own context to 'beta-service'
  const betaCtxRes = await betaMcp.call({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: {
      name: 'shadowgraph_context',
      arguments: { task: 'Redis sentinel failover' }
    }
  });
  assert.equal(betaCtxRes.error, undefined);
  const betaCtx = JSON.parse(betaCtxRes.result.content[0].text);
  assert.equal(betaCtx.project, 'beta-service');
  assert.deepEqual(betaCtx.activeDecisions, [], 'alpha-service active decisions do not leak into beta-service activeDecisions');
  assert.equal(betaCtx.userMemories.length, 1, 'global user preference from alpha-service surfaces in beta-service');
  assert.equal(betaCtx.userMemories[0].sourceProject, 'alpha-service');
  assert.ok(betaCtx.crossProjectExperience.some((x) => x.id === recordedAtt.id && x.reusableNow === true));
  assert.ok(betaCtx.relevantToTask.some((x) => x.sourceProject === 'alpha-service' && x.crossProject === true));

  // 3. Fail-open behavior when the embedding endpoint returns HTTP 503
  shouldFailEmbeddings = true;
  const betaDecRes = await betaMcp.call({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: {
      name: 'shadowgraph_record_decision',
      arguments: { title: 'Beta API gateway', chosen: 'Envoy proxy' }
    }
  });
  assert.equal(betaDecRes.error, undefined, 'recording succeeds fail-open when embedding server errors');
  const betaDec = JSON.parse(betaDecRes.result.content[0].text);
  assert.equal(betaDec.project, 'beta-service');
});

test('Q7: shadowgraph_context, shadowgraph_review, and shadowgraph_ack_review annotations, outputSchema, and release/policy documentation', async () => {
  const catalog = buildToolCatalog();
  const contextTool = catalog.find((tool) => tool.name === 'shadowgraph_context');
  const reviewTool = catalog.find((tool) => tool.name === 'shadowgraph_review');
  const ackTool = catalog.find((tool) => tool.name === 'shadowgraph_ack_review');
  assert.ok(contextTool, 'shadowgraph_context exists in tool catalog');
  assert.ok(reviewTool, 'shadowgraph_review exists in tool catalog');
  assert.ok(ackTool, 'shadowgraph_ack_review exists in tool catalog');

  assert.equal(contextTool.persists, false, 'own-scope shadowgraph_context does not persist');
  assert.equal(contextTool.persistsWithAccess, true, 'grant-bearing shadowgraph_context declares conditional audit persistence');
  assert.deepEqual(contextTool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  });
  assert.deepEqual(reviewTool.annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false
  });
  assert.deepEqual(ackTool.annotations, {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false
  });

  const props = contextTool.outputSchema.properties;
  assert.equal(props.digest?.type, 'object');
  assert.deepEqual(props.digest?.required, ['project', 'counts', 'highlights']);
  assert.equal(props.userMemories?.type, 'array');
  assert.deepEqual(props.userMemories?.items?.required, ['id', 'kind']);
  assert.equal(props.successfulApproaches?.type, 'array');
  assert.deepEqual(props.successfulApproaches?.items?.required, ['id', 'kind']);
  assert.equal(props.crossProjectExperience?.type, 'array');
  assert.deepEqual(props.crossProjectExperience?.items?.required, ['id', 'kind']);
  assert.equal(props.relevantToTask?.type, 'array');
  assert.deepEqual(props.relevantToTask?.items?.required, ['id', 'kind']);

  const agentPolicy = await readFile(join(process.cwd(), 'integrations', 'agent-policy.md'), 'utf8');
  for (const term of [
    'userMemories',
    'successfulApproaches',
    'crossProjectExperience',
    'relevantToTask',
    'reusableWhen',
    'visibility',
    'changeSummary',
    'includeHistory'
  ]) {
    assert.ok(agentPolicy.includes(term), `integrations/agent-policy.md documents ${term}`);
  }

  const changelog = await readFile(join(process.cwd(), 'CHANGELOG.md'), 'utf8');
  for (const term of ['userMemories', 'crossProjectExperience', 'parseConditionString', 'changeSummary', 'includeHistory']) {
    assert.ok(changelog.includes(term), `CHANGELOG.md documents ${term}`);
  }

  const glama = JSON.parse(await readFile(join(process.cwd(), 'glama.json'), 'utf8'));
  assert.equal(glama.$schema, 'https://glama.ai/mcp/schemas/server.json');
  assert.ok(Array.isArray(glama.maintainers) && glama.maintainers.includes('LiLara-AI'));
});
