import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedIssueAccess, privilegedSnapshot } from '../src/internal/snapshot.js';

const STRUCTURED_PROTOCOL = '2025-11-25';
const PROJECT = 'boundary-challenge';
const T0 = '2030-01-01T00:00:00.000Z';
const at = (minutes) => new Date(Date.parse(T0) + minutes * 60_000).toISOString();

async function startMcpServer(t, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-boundary-'));
  const storeDirectory = join(directory, 'store');
  await mkdir(storeDirectory, { recursive: true });
  const file = join(storeDirectory, 'data.json');
  const clockFile = join(directory, 'clock.txt');
  await writeFile(clockFile, T0, 'utf8');

  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], {
    cwd: directory,
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_STORAGE: 'json',
      SHADOWGRAPH_EMBEDDING_URL: '',
      SHADOWGRAPH_MCP_COMPACT: '0',
      NODE_ENV: 'test',
      SHADOWGRAPH_TEST_CLOCK_FILE: clockFile,
      SHADOWGRAPH_HOME: join(directory, 'home'),
      ...extraEnv
    },
    stdio: ['pipe', 'pipe', 'inherit']
  });

  let buffer = '';
  const pending = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/u);
    buffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) pending.shift()?.resolve(JSON.parse(line));
    }
  });
  child.on('error', (error) => pending.shift()?.reject(error));

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    try {
      await rm(directory, { recursive: true, force: true });
    } catch {}
  }
  t.after(stop);

  let nextId = 1;
  const rpc = {
    directory,
    file,
    call(method, params, timeoutMs = 20_000) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${method}`)), timeoutMs);
        pending.push({
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    async initialize() {
      const response = await rpc.call('initialize', {
        protocolVersion: STRUCTURED_PROTOCOL,
        capabilities: {},
        clientInfo: { name: 'boundary-challenger', version: '1.0.0' }
      });
      return response.result;
    },
    async ok(name, args = {}) {
      const response = await rpc.call('tools/call', { name, arguments: args });
      if (response.error) {
        console.error(`${name} error details:`, JSON.stringify(response.error, null, 2));
      }
      assert.equal(response.error, undefined, `${name} failed: ${JSON.stringify(response.error)}`);
      return JSON.parse(response.result.content[0].text);
    },
    async fails(name, args = {}) {
      const response = await rpc.call('tools/call', { name, arguments: args });
      assert.equal(response.result, undefined, `${name} unexpectedly succeeded`);
      return response.error;
    },
    setClock(iso) { return writeFile(clockFile, iso, 'utf8'); }
  };

  await rpc.initialize();
  return rpc;
}

async function readStore(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { revision: 0, records: [], facts: [], relations: [], reviewSignals: [], events: [] };
  }
}

test('CHALLENGE 1: shadowgraph_search vs shadowgraph_retrieve boundaries and side effects', async (t) => {
  const rpc = await startMcpServer(t);

  // 1. Seed records in PROJECT
  const d1 = await rpc.ok('shadowgraph_record_decision', {
    project: PROJECT,
    title: 'Redis timeout mitigation strategy',
    goal: 'Prevent database socket exhaustion',
    chosen: 'Increase redis connection timeout pool',
    confidence: 0.9,
    alternatives: [{ label: 'fail-fast', reopenWhen: [] }]
  });

  const d2 = await rpc.ok('shadowgraph_record_decision', {
    project: PROJECT,
    title: 'Redis connection pool sizing',
    goal: 'Optimize throughput',
    chosen: 'Max 50 active instances',
    confidence: 0.8,
    alternatives: [{ label: 'dynamic-scaling', reopenWhen: [] }]
  });

  const d3 = await rpc.ok('shadowgraph_record_decision', {
    project: PROJECT,
    title: 'Postgres network socket timeout',
    goal: 'Handle slow queries',
    chosen: 'Statement timeout 30s',
    confidence: 0.85,
    alternatives: [{ label: 'connection-kill', reopenWhen: [] }]
  });

  const d4 = await rpc.ok('shadowgraph_record_decision', {
    project: PROJECT,
    title: 'Circuit breaker pattern',
    goal: 'Fast failure on downstream outage',
    chosen: 'Hystrix-style bulkheading',
    confidence: 0.75,
    alternatives: [{ label: 'exponential-backoff', reopenWhen: [] }]
  });

  // Link d1 to d4 (d4 contains NEITHER 'redis' NOR 'timeout')
  await rpc.ok('shadowgraph_link', {
    project: PROJECT,
    from: d1.id,
    to: d4.id,
    relation: 'mitigates'
  });

  // Seed d5 linked to d4 (d5 is 2 hops away from d1)
  const d5 = await rpc.ok('shadowgraph_record_decision', {
    project: PROJECT,
    title: 'Downstream logging sink',
    goal: 'Audit circuit breaker events',
    chosen: 'Async journal worker',
    confidence: 0.7,
    alternatives: []
  });
  await rpc.ok('shadowgraph_link', {
    project: PROJECT,
    from: d4.id,
    to: d5.id,
    relation: 'notifies'
  });

  // --- Sub-challenge 1.1: Literal every-term matching in search ---
  // Query with both 'redis' and 'timeout'
  const searchBoth = await rpc.ok('shadowgraph_search', { project: PROJECT, query: 'redis timeout' });
  const searchBothIds = searchBoth.items.map((item) => item.record.id);
  assert.ok(searchBothIds.includes(d1.id), 'd1 must match because it contains both "redis" and "timeout"');
  assert.equal(searchBothIds.includes(d2.id), false, 'd2 must NOT match because it lacks "timeout"');
  assert.equal(searchBothIds.includes(d3.id), false, 'd3 must NOT match because it lacks "redis"');
  assert.equal(searchBothIds.includes(d4.id), false, 'd4 must NOT match because it lacks both');
  assert.equal(searchBothIds.includes(d5.id), false, 'd5 must NOT match because it lacks both');

  // Query with single term 'redis'
  const searchRedis = await rpc.ok('shadowgraph_search', { project: PROJECT, query: 'redis' });
  const searchRedisIds = searchRedis.items.map((item) => item.record.id);
  assert.ok(searchRedisIds.includes(d1.id), 'd1 matches "redis"');
  assert.ok(searchRedisIds.includes(d2.id), 'd2 matches "redis"');
  assert.equal(searchRedisIds.includes(d3.id), false, 'd3 does not match "redis"');

  // Query with empty query: matches filters only
  const searchEmpty = await rpc.ok('shadowgraph_search', { project: PROJECT, query: '' });
  assert.equal(searchEmpty.items.length >= 4, true, 'empty query returns active records in scope');
  for (const item of searchEmpty.items) {
    assert.equal(item.matchedBy, 'filter');
    assert.equal(item.reason, 'Matched filters only');
  }

  // --- Sub-challenge 1.2: Retrieve includes graph neighbours via single-pass ordered expansion ---
  const retrieveBoth = await rpc.ok('shadowgraph_retrieve', { project: PROJECT, query: 'redis timeout' });
  const retrieveBothIds = retrieveBoth.items.map((item) => item.record.id);
  assert.ok(retrieveBothIds.includes(d1.id), 'd1 must match as a direct seed');
  assert.ok(retrieveBothIds.includes(d4.id), 'd4 MUST be included in retrieve as an ordered graph neighbour of d1');
  assert.equal(searchBothIds.includes(d4.id), false, 'CONFIRMED: search excluded d4 while retrieve included d4');

  // Single-pass ordered expansion:
  // retrieve evaluates relations in store insertion order and mutates directIds in-place
  // (shadowgraph.js:5458). Because relation d1->d4 precedes d4->d5, d4 is added to directIds
  // when d1->d4 is evaluated, allowing downstream relation d4->d5 to match and pull in d5
  // within the same single pass.
  const forwardExpandsDownstream = retrieveBothIds.includes(d5.id);
  assert.ok(
    forwardExpandsDownstream,
    'CONFIRMED: forward relation order (d1->d4 then d4->d5) includes downstream neighbour d5'
  );

  const d1Item = retrieveBoth.items.find((item) => item.record.id === d1.id);
  const d4Item = retrieveBoth.items.find((item) => item.record.id === d4.id);
  assert.equal(d1Item.matchedBy, 'content', 'd1 matchedBy must be content');
  assert.equal(d4Item.matchedBy, 'graph', 'd4 matchedBy must be graph');
  assert.equal(d4Item.graphBoost, 1, 'd4 graphBoost must be 1');
  assert.match(d4Item.reason, /Related by mitigates/, 'd4 reason must state relationship');
  assert.equal(searchBothIds.includes(d4.id), false, 'CONFIRMED: search excluded d4 while retrieve included d4');

  // --- Sub-challenge 1.2b: Reverse relation order excludes upstream neighbours in single-pass expansion ---
  // In reverse relation order (B->C created before A->B), an A-only query returns A and B, but NOT C,
  // confirming that single-pass ordered expansion does not perform full transitive closure.
  const REV_PROJECT = 'boundary-rev-order';
  const rA = await rpc.ok('shadowgraph_record_decision', {
    project: REV_PROJECT,
    title: 'Seed Node A',
    goal: 'Test single-pass ordered expansion',
    chosen: 'Approach A',
    confidence: 0.8
  });
  const rB = await rpc.ok('shadowgraph_record_decision', {
    project: REV_PROJECT,
    title: 'Bridge Node B',
    goal: 'Test single-pass ordered expansion',
    chosen: 'Approach B',
    confidence: 0.8
  });
  const rC = await rpc.ok('shadowgraph_record_decision', {
    project: REV_PROJECT,
    title: 'Leaf Node C',
    goal: 'Test single-pass ordered expansion',
    chosen: 'Approach C',
    confidence: 0.8
  });

  // Link B -> C FIRST in relation store order
  await rpc.ok('shadowgraph_link', {
    project: REV_PROJECT,
    from: rB.id,
    to: rC.id,
    relation: 'connects'
  });
  // Link A -> B SECOND in relation store order
  await rpc.ok('shadowgraph_link', {
    project: REV_PROJECT,
    from: rA.id,
    to: rB.id,
    relation: 'connects'
  });

  const revRetrieve = await rpc.ok('shadowgraph_retrieve', {
    project: REV_PROJECT,
    query: 'Seed Node A'
  });
  const revRetrieveIds = revRetrieve.items.map((item) => item.record.id);

  assert.ok(revRetrieveIds.includes(rA.id), 'Seed node A must match as direct content hit');
  assert.ok(revRetrieveIds.includes(rB.id), 'Bridge node B must be included as graph neighbour of A');
  assert.equal(
    revRetrieveIds.includes(rC.id),
    false,
    'CONFIRMED: reverse relation order (B->C before A->B) excludes upstream relation neighbour C'
  );

  // --- Sub-challenge 1.3: Access grant durable audit write in search ---
  // A) Own-scope search without access grant
  const storeBeforeOwn = await readStore(rpc.file);
  const revBeforeOwn = storeBeforeOwn.revision;
  const eventsCountBeforeOwn = (storeBeforeOwn.events ?? []).length;

  await rpc.ok('shadowgraph_search', { project: PROJECT, query: 'redis' });

  const storeAfterOwn = await readStore(rpc.file);
  assert.equal(storeAfterOwn.revision, revBeforeOwn, 'Own-scope search must NOT increment revision');
  assert.equal((storeAfterOwn.events ?? []).length, eventsCountBeforeOwn, 'Own-scope search must NOT write audit events');

  // B) Search with an access grant covering another project
  const owner = createShadowGraph({ now: () => at(10) });
  owner.importData(await readStore(rpc.file));
  // Add a decision in 'other-proj' that matches 'redis'
  owner.addDecision({
    project: 'other-proj',
    title: 'Remote redis replication cluster',
    goal: 'Cross-region read cache',
    chosen: 'Sentinel replica'
  });
  const issued = privilegedIssueAccess(owner, {
    type: 'grant',
    scope: { projects: ['other-proj'] },
    surfaces: ['mcp'],
    expiresAt: '2099-01-01T00:00:00.000Z',
    reason: 'boundary test audit grant'
  });
  await createJsonFileStore(rpc.file).save(privilegedSnapshot(owner));

  // Advance MCP server's clock to at(11) so grant issued at at(10) is active
  await rpc.setClock(at(11));

  const storeBeforeGrant = await readStore(rpc.file);
  const revBeforeGrant = storeBeforeGrant.revision;
  const eventsCountBeforeGrant = (storeBeforeGrant.events ?? []).length;

  const grantSearchResult = await rpc.ok('shadowgraph_search', {
    project: PROJECT,
    query: 'redis',
    accessId: issued.entry.accessId
  });
  assert.ok(grantSearchResult.items.length > 0, 'Grant search returned matches');
  const foundOther = grantSearchResult.items.some((item) => item.record.project === 'other-proj');
  assert.ok(foundOther, 'Wider read returned record from granted other-proj');

  const storeAfterGrant = await readStore(rpc.file);
  assert.equal(storeAfterGrant.revision, revBeforeGrant + 1, 'Search with accessId MUST increment revision');
  assert.ok(
    (storeAfterGrant.events ?? []).length > eventsCountBeforeGrant,
    'Search with accessId MUST persist a durable audit event'
  );
  const auditEvent = storeAfterGrant.events.find(
    (e) => e.type === 'access.used' && e.accessId === issued.entry.accessId
  );
  assert.ok(auditEvent, 'Durable audit entry "access.used" for access grant must be present in events');
  assert.equal(auditEvent.surface, 'mcp');
});

test('CHALLENGE 2: shadowgraph_context vs shadowgraph_review_context side-effect guarantees', async (t) => {
  const rpc = await startMcpServer(t);

  // Seed decision with condition: db_latency_ms > 100
  const decision = await rpc.ok('shadowgraph_record_decision', {
    project: PROJECT,
    title: 'Database connection configuration',
    goal: 'Keep latency under SLA',
    chosen: 'Single shared pool',
    confidence: 0.9,
    alternatives: [
      {
        label: 'dedicated-pools',
        reopenWhen: [{ key: 'db_latency_ms', operator: 'greater_than', value: 100 }]
      }
    ]
  });

  // Seed fact: db_latency_ms = 250 (causes condition to fire)
  await rpc.ok('shadowgraph_record_fact', {
    project: PROJECT,
    key: 'db_latency_ms',
    value: 250
  });

  // --- Sub-challenge 2.1: shadowgraph_context is pure in-memory evaluation ---
  const storeBeforeCtx = await readStore(rpc.file);
  const revBeforeCtx = storeBeforeCtx.revision;
  const signalsBeforeCtx = (storeBeforeCtx.reviewSignals ?? []).length;

  const ctxResult = await rpc.ok('shadowgraph_context', { project: PROJECT });

  // Verify response
  assert.equal(ctxResult.firedConditions.length, 1, 'Condition must fire in context response');
  assert.equal(ctxResult.firedConditions[0].decisionId, decision.id);
  assert.equal(
    ctxResult.firedConditions[0].reviewSignalStatus,
    'unpersisted',
    'reviewSignalStatus in shadowgraph_context MUST be "unpersisted"'
  );
  assert.equal(ctxResult.firedConditions[0].reviewSignalId, undefined, 'No reviewSignalId should be minted');

  // Verify durable state on disk
  const storeAfterCtx = await readStore(rpc.file);
  assert.equal(storeAfterCtx.revision, revBeforeCtx, 'shadowgraph_context must NOT increment revision');
  assert.equal(
    (storeAfterCtx.reviewSignals ?? []).length,
    signalsBeforeCtx,
    'shadowgraph_context must NOT persist review signals to disk'
  );

  const savedSignalsAfterCtx = await rpc.ok('shadowgraph_review_signals', { project: PROJECT });
  assert.equal(savedSignalsAfterCtx.items.length, 0, 'No signals stored in database after context()');

  // --- Sub-challenge 2.2: shadowgraph_review_context persists signals and commits revision ---
  const revBeforeReviewCtx = storeAfterCtx.revision;

  const reviewCtxResult = await rpc.ok('shadowgraph_review_context', { project: PROJECT });

  // Verify response
  assert.equal(reviewCtxResult.openReviews.length, 1, 'Review breach must be present in openReviews');
  assert.equal(reviewCtxResult.openReviews[0].decisionId, decision.id);
  assert.equal(
    reviewCtxResult.openReviews[0].reviewSignalStatus,
    'open',
    'reviewSignalStatus in shadowgraph_review_context MUST be "open"'
  );
  assert.ok(
    typeof reviewCtxResult.openReviews[0].reviewSignalId === 'string' &&
    reviewCtxResult.openReviews[0].reviewSignalId.startsWith('review_'),
    'A valid review signal ID must be minted and returned'
  );
  const signalId = reviewCtxResult.openReviews[0].reviewSignalId;

  // Verify durable state on disk
  const storeAfterReviewCtx = await readStore(rpc.file);
  assert.equal(
    storeAfterReviewCtx.revision,
    revBeforeReviewCtx + 1,
    'shadowgraph_review_context MUST commit a new revision'
  );
  assert.equal(
    (storeAfterReviewCtx.reviewSignals ?? []).length,
    1,
    'shadowgraph_review_context MUST persist the review signal to disk'
  );
  assert.equal(storeAfterReviewCtx.reviewSignals[0].id, signalId);
  assert.equal(storeAfterReviewCtx.reviewSignals[0].status, 'open');

  // Verify review_signals read sees the persisted signal
  const savedSignalsAfterReviewCtx = await rpc.ok('shadowgraph_review_signals', { project: PROJECT });
  assert.equal(savedSignalsAfterReviewCtx.items.length, 1);
  assert.equal(savedSignalsAfterReviewCtx.items[0].id, signalId);
  assert.equal(savedSignalsAfterReviewCtx.items[0].status, 'open');
});

test('CHALLENGE 3: shadowgraph_ack_review mutates signal status only, leaving decision status and confidence unchanged', async (t) => {
  const rpc = await startMcpServer(t);

  const initialConfidence = 0.88;
  const decision = await rpc.ok('shadowgraph_record_decision', {
    project: PROJECT,
    title: 'Cache eviction policy',
    goal: 'Maintain high hit-rate',
    chosen: 'LRU 1000 items',
    confidence: initialConfidence,
    alternatives: [
      {
        label: 'LFU',
        reopenWhen: [{ key: 'cache_miss_rate', operator: 'greater_than', value: 0.2 }]
      }
    ]
  });

  await rpc.ok('shadowgraph_update_status', {
    project: PROJECT,
    decisionId: decision.id,
    status: 'planned'
  });

  await rpc.ok('shadowgraph_record_fact', {
    project: PROJECT,
    key: 'cache_miss_rate',
    value: 0.45
  });

  // Generate and persist the review signal
  const reviewCtx = await rpc.ok('shadowgraph_review_context', { project: PROJECT });
  assert.equal(reviewCtx.openReviews.length, 1);
  const signalId = reviewCtx.openReviews[0].reviewSignalId;
  assert.equal(reviewCtx.openReviews[0].reviewSignalStatus, 'open');

  // Verify decision status and confidence BEFORE ack
  const searchBeforeAck = await rpc.ok('shadowgraph_search', { project: PROJECT, query: 'Cache eviction' });
  const dBefore = searchBeforeAck.items.find((item) => item.record.id === decision.id).record;
  assert.equal(dBefore.status, 'planned', 'Decision status before ack must be planned');
  assert.equal(dBefore.confidence.current, initialConfidence, 'Decision confidence before ack must match initial');

  // Boundary check: acknowledging without project or origin is refused (write_scope_unresolved)
  const ackWithoutProjectError = await rpc.fails('shadowgraph_ack_review', { id: signalId });
  assert.equal(ackWithoutProjectError.code, -32000);

  // Boundary check: acknowledging non-existent signal fails with error
  const ackNonexistentError = await rpc.fails('shadowgraph_ack_review', { project: PROJECT, id: 'review_nonexistent' });
  assert.equal(ackNonexistentError.code, -32000);

  // Execute acknowledgement with write boundary (project)
  const ackResult = await rpc.ok('shadowgraph_ack_review', { project: PROJECT, id: signalId });
  assert.equal(ackResult.id, signalId);
  assert.equal(ackResult.status, 'acknowledged', 'Signal status MUST mutate to "acknowledged"');
  assert.ok(ackResult.acknowledgedAt, 'acknowledgedAt timestamp must be set');

  // Verify signal status in review signals
  const signalsAfterAck = await rpc.ok('shadowgraph_review_signals', { project: PROJECT });
  const signalRecord = signalsAfterAck.items.find((s) => s.id === signalId);
  assert.ok(signalRecord, 'Signal must still exist in review signals');
  assert.equal(signalRecord.status, 'acknowledged');

  // CRITICAL BOUNDARY CHECK: Did ack_review touch the decision's status or confidence?
  const searchAfterAck = await rpc.ok('shadowgraph_search', { project: PROJECT, query: 'Cache eviction' });
  const dAfter = searchAfterAck.items.find((item) => item.record.id === decision.id).record;
  assert.equal(
    dAfter.status,
    'planned',
    'CRITICAL: Decision lifecycle status MUST remain "planned" after ack_review'
  );
  assert.equal(
    dAfter.confidence.current,
    initialConfidence,
    'CRITICAL: Decision confidence MUST remain completely unchanged after ack_review'
  );

  // Verify context reflection
  const ctxAfterAck = await rpc.ok('shadowgraph_context', { project: PROJECT });
  const firedCondition = ctxAfterAck.firedConditions.find((c) => c.decisionId === decision.id);
  assert.ok(firedCondition, 'Fired condition is still detected because fact is still in breach');
  assert.equal(
    firedCondition.reviewSignalStatus,
    'acknowledged',
    'reviewSignalStatus in context now reflects "acknowledged"'
  );
});

test('CHALLENGE 4: shadowgraph_recall scope omission selects explicit null rather than wildcard', async (t) => {
  const rpc = await startMcpServer(t);

  // Store memory with explicit user/agent/run scope
  await rpc.ok('shadowgraph_remember', {
    project: PROJECT,
    memoryType: 'preference',
    key: 'user_alice_pref',
    text: 'Alice prefers detailed markdown summaries and dark mode theme',
    scope: { userId: 'alice_123', agentId: 'agent_coder', runId: 'run_456' }
  });

  // Store memory with different explicit scope
  await rpc.ok('shadowgraph_remember', {
    project: PROJECT,
    memoryType: 'preference',
    key: 'user_bob_pref',
    text: 'Bob prefers concise bullet points and light mode theme',
    scope: { userId: 'bob_789', agentId: 'agent_coder', runId: 'run_789' }
  });

  // Store memory with explicit project-wide null scope
  await rpc.ok('shadowgraph_remember', {
    project: PROJECT,
    memoryType: 'preference',
    key: 'org_default_pref',
    text: 'Project default preference is balanced summaries with system theme',
    scope: { userId: null, agentId: null, runId: null }
  });

  // --- Sub-challenge 4.1: shadowgraph_recall with OMITTED scope ---
  const recallOmittedScope = await rpc.ok('shadowgraph_recall', {
    project: PROJECT,
    query: 'prefers summaries and theme'
  });

  const recalledKeysOmitted = recallOmittedScope.items.map((item) => item.record.key);

  // If omitted scope were a wildcard, it would return alice and bob's scoped memories.
  // Because omitted scope strictly selects explicit null { userId: null, agentId: null, runId: null }:
  assert.ok(
    recalledKeysOmitted.includes('org_default_pref'),
    'Omitted scope MUST match project-wide null-scope memory "org_default_pref"'
  );
  assert.equal(
    recalledKeysOmitted.includes('user_alice_pref'),
    false,
    'Omitted scope must NOT match alice-scoped memory (omitted scope is NOT a wildcard)'
  );
  assert.equal(
    recalledKeysOmitted.includes('user_bob_pref'),
    false,
    'Omitted scope must NOT match bob-scoped memory (omitted scope is NOT a wildcard)'
  );

  // --- Sub-challenge 4.2: shadowgraph_recall with explicit alice scope ---
  const recallAliceScope = await rpc.ok('shadowgraph_recall', {
    project: PROJECT,
    query: 'prefers summaries and theme',
    scope: { userId: 'alice_123', agentId: 'agent_coder', runId: 'run_456' }
  });

  const recalledKeysAlice = recallAliceScope.items.map((item) => item.record.key);
  assert.ok(recalledKeysAlice.includes('user_alice_pref'), 'Explicit alice scope matches alice memory');
  assert.equal(recalledKeysAlice.includes('user_bob_pref'), false, 'Explicit alice scope excludes bob memory');
  assert.equal(recalledKeysAlice.includes('org_default_pref'), false, 'Explicit alice scope excludes null-scoped memory');

  // --- Sub-challenge 4.3: shadowgraph_recall with partial scope (userId only) ---
  // When agentId and runId are omitted in caller scope, they normalize to null.
  // A memory with agentId != null will NOT match.
  const recallPartialAlice = await rpc.ok('shadowgraph_recall', {
    project: PROJECT,
    query: 'prefers summaries and theme',
    scope: { userId: 'alice_123' }
  });
  const recalledKeysPartialAlice = recallPartialAlice.items.map((item) => item.record.key);
  assert.equal(
    recalledKeysPartialAlice.includes('user_alice_pref'),
    false,
    'Partial scope { userId: alice } defaults agentId and runId to null, so it does not match memory with agentId="agent_coder"'
  );

  // --- Sub-challenge 4.4: shadowgraph_recall with explicit scope: null and scope: {} ---
  // Explicit scope: null throws validation error because normalizeMemoryScope strictly requires an object
  const nullScopeError = await rpc.fails('shadowgraph_recall', {
    project: PROJECT,
    query: 'prefers summaries and theme',
    scope: null
  });
  assert.equal(nullScopeError.code, -32000);

  const recallEmptyScope = await rpc.ok('shadowgraph_recall', {
    project: PROJECT,
    query: 'prefers summaries and theme',
    scope: {}
  });
  const recalledKeysEmpty = recallEmptyScope.items.map((item) => item.record.key);
  assert.ok(recalledKeysEmpty.includes('org_default_pref'), 'Explicit scope: {} matches null-scoped memory');
  assert.equal(recalledKeysEmpty.includes('user_alice_pref'), false, 'Explicit scope: {} excludes alice memory');
});
