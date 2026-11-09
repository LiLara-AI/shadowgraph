import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import {
  buildToolCatalog,
  selectTools,
  COMPACT_TOOL_NAMES,
  WORKFLOW_TOOL_NAMES,
  METADATA_TIER,
  projectTool
} from '../src/mcp-tools.js';
import { createShadowGraph } from '../src/shadowgraph.js';

// ---------------------------------------------------------------------------
// Adversarial & Edge Case Test Suite for Milestone 1
// ---------------------------------------------------------------------------

test('Adversarial M1-1: Profile inventory invariants and environment variable validation', () => {
  const catalogWithoutVerifier = buildToolCatalog({ verifier: false });
  const catalogWithVerifier = buildToolCatalog({ verifier: true });

  // Baseline tool counts
  assert.equal(catalogWithoutVerifier.length, 35, 'Full profile without verifier must have 35 tools');
  assert.equal(catalogWithVerifier.length, 36, 'Full profile with verifier must have 36 tools');
  assert.equal(COMPACT_TOOL_NAMES.length, 16, 'Compact tool names must contain exactly 16 tools');
  assert.equal(WORKFLOW_TOOL_NAMES.length, 20, 'Workflow tool names must contain exactly 20 tools');

  // Exact profile tool selections
  const fullSelected = selectTools(catalogWithoutVerifier);
  assert.equal(fullSelected.length, 35, 'selectTools default returns 35 tools');

  const compactSelected = selectTools(catalogWithoutVerifier, { compact: true });
  assert.equal(compactSelected.length, 16, 'selectTools compact:true returns 16 tools');
  const compactNames = compactSelected.map((t) => t.name);
  assert.deepEqual(compactNames.sort(), [...COMPACT_TOOL_NAMES].sort(), 'Compact tools must match COMPACT_TOOL_NAMES');

  const workflowSelected = selectTools(catalogWithoutVerifier, { profile: 'workflow' });
  assert.equal(workflowSelected.length, 20, 'selectTools profile:workflow returns 20 tools');
  const workflowNames = workflowSelected.map((t) => t.name);
  assert.deepEqual(workflowNames.sort(), [...WORKFLOW_TOOL_NAMES].sort(), 'Workflow tools must match WORKFLOW_TOOL_NAMES');

  // Hierarchy invariant: compact is a strict subset of workflow, and workflow is a strict subset of full
  for (const name of COMPACT_TOOL_NAMES) {
    assert.ok(WORKFLOW_TOOL_NAMES.includes(name), `Compact tool ${name} must be included in Workflow`);
    assert.ok(fullSelected.some((t) => t.name === name), `Compact tool ${name} must be included in Full`);
  }
  for (const name of WORKFLOW_TOOL_NAMES) {
    assert.ok(fullSelected.some((t) => t.name === name), `Workflow tool ${name} must be included in Full`);
  }

  // Adversarial edge cases on profile parameters:
  // 1. Conflict: profile=workflow and compact=true together must throw
  assert.throws(
    () => selectTools(catalogWithoutVerifier, { compact: true, profile: 'workflow' }),
    /conflicts with SHADOWGRAPH_MCP_COMPACT=1/i,
    'Conflicting compact=true and profile=workflow must be rejected'
  );

  // 2. Unsupported profiles must be rejected
  for (const invalidProfile of ['compact', 'full', 'admin', 'custom', 'WORKFLOW', '1']) {
    assert.throws(
      () => selectTools(catalogWithoutVerifier, { profile: invalidProfile }),
      /Unknown SHADOWGRAPH_MCP_PROFILE; supported value: workflow/i,
      `Profile ${invalidProfile} must be rejected with informative error`
    );
  }
});

test('Adversarial M1-2: shadowgraph_record_fact requires value in schema and rejects missing value at runtime', () => {
  const catalog = buildToolCatalog({ verifier: true });
  const factTool = catalog.find((t) => t.name === 'shadowgraph_record_fact');
  assert.ok(factTool, 'shadowgraph_record_fact tool must exist');

  // Schema verification
  assert.deepEqual(factTool.inputSchema.required, ['key', 'value'], 'Schema must require both key and value');
  assert.ok(factTool.inputSchema.properties.value, 'Schema properties must declare value');

  // Runtime engine verification
  const graph = createShadowGraph();

  // Missing value (undefined) must throw
  assert.throws(
    () => graph.addFact({ key: 'config.timeout', project: 'adversarial-proj' }),
    /Values must be plain JSON data|A fact requires/i,
    'addFact without value must be rejected'
  );

  // Falsy but valid JSON values must all be accepted
  const validFalsyValues = [
    null,
    false,
    0,
    '',
    [],
    {}
  ];

  for (let i = 0; i < validFalsyValues.length; i++) {
    const val = validFalsyValues[i];
    const fact = graph.addFact({
      key: `config.falsy.${i}`,
      value: val,
      project: 'adversarial-proj'
    });
    assert.ok(fact.id, `Fact with value ${JSON.stringify(val)} must be created`);
    assert.deepEqual(fact.value, val, `Stored fact value must match input ${JSON.stringify(val)}`);
  }
});

test('Adversarial M1-3: shadowgraph_record_attempt schema validation and edge case handling', () => {
  const catalog = buildToolCatalog({ verifier: true });
  const attemptTool = catalog.find((t) => t.name === 'shadowgraph_record_attempt');

  // Schema declarations
  assert.ok(attemptTool.inputSchema.properties.reusableWhen, 'reusableWhen declared in inputSchema');
  assert.ok(attemptTool.inputSchema.properties.visibility, 'visibility declared in inputSchema');
  assert.deepEqual(attemptTool.inputSchema.properties.visibility.enum, ['project', 'global'], 'visibility enum');
  assert.ok(attemptTool.inputSchema.properties.tags, 'tags declared in inputSchema');
  assert.ok(attemptTool.inputSchema.properties.task, 'task declared in inputSchema');

  const graph = createShadowGraph();

  // Valid attempt with all new M1 fields
  const attempt = graph.addAttempt({
    solution: 'Adversarial Solution',
    result: 'Success under stress',
    task: 'Stress testing M1',
    tags: ['m1', 'adversarial', 'stress'],
    visibility: 'global',
    reusableWhen: ['db.status == "healthy"', 'api.version >= "2.0"'],
    relatedTo: ['dec-123'],
    project: 'adversarial-proj'
  });

  assert.ok(attempt.id, 'Attempt must be created');
  assert.equal(attempt.task, 'Stress testing M1');
  assert.deepEqual(attempt.tags, ['m1', 'adversarial', 'stress']);
  assert.equal(attempt.visibility, 'global');
  assert.equal(attempt.reusableWhen.length, 2);

  // Adversarial: Invalid visibility must be rejected
  assert.throws(
    () => graph.addAttempt({
      solution: 'Test',
      result: 'Success',
      visibility: 'public',
      project: 'adversarial-proj'
    }),
    /visibility must be "project" or "global"/i,
    'Invalid visibility must throw'
  );

  // Adversarial: Non-array tags must be rejected
  assert.throws(
    () => graph.addAttempt({
      solution: 'Test',
      result: 'Success',
      tags: 'not-an-array',
      project: 'adversarial-proj'
    }),
    /tags must be an array of strings/i,
    'Non-array tags must throw'
  );

  // Adversarial: Tags with non-string elements must be rejected
  assert.throws(
    () => graph.addAttempt({
      solution: 'Test',
      result: 'Success',
      tags: ['valid', 12345],
      project: 'adversarial-proj'
    }),
    /tags must be an array of strings/i,
    'Tags with numbers must throw'
  );

  // Adversarial: Malformed reusableWhen (not an array)
  assert.throws(
    () => graph.addAttempt({
      solution: 'Test',
      result: 'Success',
      reusableWhen: 'not-an-array',
      project: 'adversarial-proj'
    }),
    /rules\.map is not a function|Rules must be an array/i,
    'Non-array reusableWhen must throw'
  );
});

test('Adversarial M1-4: shadowgraph_record_decision schema exposure and edge cases', () => {
  const catalog = buildToolCatalog({ verifier: true });
  const decTool = catalog.find((t) => t.name === 'shadowgraph_record_decision');

  const inputProps = decTool.inputSchema.properties;
  assert.deepEqual(
    inputProps.status.enum,
    ['proposed', 'planned', 'in_progress', 'executed', 'validated', 'failed', 'reconsidered', 'abandoned', 'archived'],
    'status enum matches allowed user statuses'
  );
  assert.deepEqual(inputProps.visibility.enum, ['project', 'global'], 'visibility enum');

  const graph = createShadowGraph();

  // Create decision with explicit initial status and M1 fields
  const dec1 = graph.addDecision({
    title: 'Decision 1',
    chosen: 'Architecture A',
    goal: 'Scalability',
    task: 'TASK-101',
    status: 'planned',
    tags: ['arch', 'v1'],
    visibility: 'global',
    project: 'adversarial-proj'
  });

  assert.equal(dec1.status, 'planned', 'Initial status must be planned');
  assert.equal(dec1.task, 'TASK-101');
  assert.deepEqual(dec1.tags, ['arch', 'v1']);
  assert.equal(dec1.visibility, 'global');

  // Supersede dec1 with dec2 using supersedes parameter and reason/changeSummary
  const dec2 = graph.addDecision({
    title: 'Decision 2',
    chosen: 'Architecture B',
    goal: 'Scalability',
    task: 'TASK-101',
    supersedes: [dec1.id],
    reason: 'Architecture A was too complex',
    changeSummary: 'Replaced Architecture A with B for simplicity',
    project: 'adversarial-proj'
  });

  assert.ok(dec2.id);
  assert.equal(dec2.changeSummary, 'Replaced Architecture A with B for simplicity');

  // Adversarial: Invalid status string
  assert.throws(
    () => graph.addDecision({
      title: 'Invalid Status Decision',
      chosen: 'Choice',
      status: 'non_existent_status',
      project: 'adversarial-proj'
    }),
    /Invalid decision status/i,
    'Invalid decision status must throw'
  );

  // Adversarial: System-owned statuses (stale, superseded) cannot be set initially
  assert.throws(
    () => graph.addDecision({
      title: 'Stale Decision',
      chosen: 'Choice',
      status: 'stale',
      project: 'adversarial-proj'
    }),
    /Decision status stale is system-owned/i,
    'status: stale must be rejected'
  );

  assert.throws(
    () => graph.addDecision({
      title: 'Superseded Decision',
      chosen: 'Choice',
      status: 'superseded',
      project: 'adversarial-proj'
    }),
    /Decision status superseded is system-owned/i,
    'status: superseded must be rejected'
  );

  // Adversarial: Malformed reviewAfter (not valid ISO date)
  assert.throws(
    () => graph.addDecision({
      title: 'Bad Date Decision',
      chosen: 'Choice',
      reviewAfter: 'next tuesday',
      project: 'adversarial-proj'
    }),
    /must be a valid timestamp|Invalid ISO 8601/i,
    'Malformed reviewAfter date must be rejected'
  );
});

test('Adversarial M1-5: shadowgraph_record_outcome top-level vs nested precedence and autoTransition', () => {
  const graph = createShadowGraph();

  // Scenario 1: autoTransition: true on success transitions proposed -> validated
  const dec1 = graph.addDecision({
    title: 'Outcome AutoTransition Success Test',
    chosen: 'Path 1',
    project: 'adversarial-proj'
  });
  assert.equal(dec1.status, 'proposed');

  // Call setOutcome directly simulating MCP propagation:
  // When top-level autoTransition: true is passed, MCP merges it into outcome
  const dec1Updated = graph.setOutcome(dec1.id, {
    status: 'successful',
    autoTransition: true
  }, { project: 'adversarial-proj' });

  assert.equal(dec1Updated.status, 'validated', 'Successful outcome with autoTransition:true must transition status to validated');

  // Scenario 2: autoTransition: true on failed transitions proposed -> failed
  const dec2 = graph.addDecision({
    title: 'Outcome AutoTransition Failure Test',
    chosen: 'Path 2',
    project: 'adversarial-proj'
  });
  assert.equal(dec2.status, 'proposed');

  const dec2Updated = graph.setOutcome(dec2.id, {
    status: 'failed',
    autoTransition: true
  }, { project: 'adversarial-proj' });

  assert.equal(dec2Updated.status, 'failed', 'Failed outcome with autoTransition:true must transition status to failed');

  // Scenario 3: autoTransition: true on mixed or unknown does NOT transition status
  const dec3 = graph.addDecision({
    title: 'Outcome AutoTransition Mixed Test',
    chosen: 'Path 3',
    project: 'adversarial-proj'
  });
  const dec3Updated = graph.setOutcome(dec3.id, {
    status: 'mixed',
    autoTransition: true
  }, { project: 'adversarial-proj' });
  assert.equal(dec3Updated.status, 'proposed', 'Mixed outcome with autoTransition:true must not alter lifecycle status');

  // Scenario 4: Nested decisionStatus takes precedence over autoTransition
  const dec4 = graph.addDecision({
    title: 'Precedence Test: decisionStatus vs autoTransition',
    chosen: 'Path 4',
    project: 'adversarial-proj'
  });
  const dec4Updated = graph.setOutcome(dec4.id, {
    status: 'successful',
    autoTransition: true,
    decisionStatus: 'executed'
  }, { project: 'adversarial-proj' });
  assert.equal(dec4Updated.status, 'executed', 'Explicit decisionStatus must take precedence over autoTransition');

  // Scenario 5: lifecycleStatus alias functions identically to decisionStatus
  const dec5 = graph.addDecision({
    title: 'lifecycleStatus alias test',
    chosen: 'Path 5',
    project: 'adversarial-proj'
  });
  const dec5Updated = graph.setOutcome(dec5.id, {
    status: 'successful',
    lifecycleStatus: 'executed'
  }, { project: 'adversarial-proj' });
  assert.equal(dec5Updated.status, 'executed', 'lifecycleStatus alias must successfully set target status');

  // Scenario 6: Illegal status transition throws
  assert.throws(
    () => graph.setOutcome(dec1Updated.id, {
      status: 'successful',
      decisionStatus: 'stale'
    }, { project: 'adversarial-proj' }),
    /Decision status stale is system-owned/i,
    'Attempting to set system-owned stale status via outcome must be rejected'
  );
});

test('Adversarial M1-6: remember, supersede, and fact backfill historical intervals', () => {
  const graph = createShadowGraph();

  // Test fact backfill
  const f1 = graph.addFact({
    key: 'service.latency',
    value: 150,
    validFrom: '2026-06-01T00:00:00.000Z',
    project: 'backfill-proj'
  });

  // Attempting earlier validFrom without allowHistorical/backfill must throw
  assert.throws(
    () => graph.addFact({
      key: 'service.latency',
      value: 200,
      validFrom: '2026-05-01T00:00:00.000Z',
      project: 'backfill-proj'
    }),
    /non-decreasing validFrom order/i,
    'Earlier validFrom without allowHistorical must throw'
  );

  // With allowHistorical: true, earlier validFrom is accepted
  const fBackfill = graph.addFact({
    key: 'service.latency',
    value: 200,
    validFrom: '2026-05-01T00:00:00.000Z',
    allowHistorical: true,
    reason: 'Backfilling baseline latency from benchmark',
    project: 'backfill-proj'
  });
  assert.ok(fBackfill.id, 'Historical fact backfill must succeed with allowHistorical:true');

  // With backfill: true alias, it also succeeds
  const fBackfill2 = graph.addFact({
    key: 'service.latency',
    value: 250,
    validFrom: '2026-04-01T00:00:00.000Z',
    backfill: true,
    reason: 'Backfilling Q1 latency',
    project: 'backfill-proj'
  });
  assert.ok(fBackfill2.id, 'Historical fact backfill must succeed with backfill:true');

  // Test supersedeDecision reason and changeSummary
  const dOld = graph.addDecision({
    title: 'Old Decision',
    chosen: 'A',
    project: 'backfill-proj'
  });
  const dNew = graph.addDecision({
    title: 'New Decision',
    chosen: 'B',
    project: 'backfill-proj'
  });

  const supResult = graph.supersedeDecision({
    decisionId: dOld.id,
    replacementId: dNew.id,
    reason: 'Performance bottlenecks in Option A',
    changeSummary: 'Migrated from A to B with lower overhead',
    project: 'backfill-proj'
  });

  assert.equal(supResult.previous.status, 'superseded');
  assert.equal(supResult.replacement.id, dNew.id);
});

test('Adversarial M1-7: search and retrieve matchMode parameter enforcement', () => {
  const catalog = buildToolCatalog({ verifier: true });

  for (const toolName of ['shadowgraph_search', 'shadowgraph_retrieve']) {
    const tool = catalog.find((t) => t.name === toolName);
    const modeProp = tool.inputSchema.properties.matchMode;
    assert.deepEqual(modeProp.enum, ['all', 'partial', 'any'], `${toolName} matchMode enum must be ['all', 'partial', 'any']`);
    assert.ok(tool.inputSchema.properties.expandSynonyms, `${toolName} expandSynonyms must be declared`);
  }

  const graph = createShadowGraph();

  // Populate records with specific terms
  graph.addDecision({
    title: 'Database PostgreSQL Migration',
    chosen: 'PostgreSQL 16',
    goal: 'Reliable relational storage and ACID compliance',
    project: 'search-proj'
  });

  // matchMode: 'all' requires all terms
  const searchAll = graph.search('Database PostgreSQL Relational', {
    project: 'search-proj',
    matchMode: 'all'
  });
  assert.equal(searchAll.items.length, 1, 'All matching terms must return result');

  // matchMode: 'all' requires all terms for 1-2 terms (no partial fallback)
  const searchAllMiss = graph.search('Database Redis', {
    project: 'search-proj',
    matchMode: 'all'
  });
  assert.equal(searchAllMiss.items.length, 0, 'Unmatched 2-term query with matchMode:all must return 0 results');

  // With 3+ terms, engine's built-in 3+-term partial fallback activates when 0 exact hits occur
  const searchAllFallback = graph.search('Database PostgreSQL Redis', {
    project: 'search-proj',
    matchMode: 'all'
  });
  assert.equal(searchAllFallback.items.length, 1, '3-term query with 1 miss triggers partial fallback');
  assert.equal(searchAllFallback.items[0].partialMatch, true, 'Fallback hit must declare partialMatch:true');

  // matchMode: 'any' matches if at least one term is present
  const searchAny = graph.search('Database Redis Oracle', {
    project: 'search-proj',
    matchMode: 'any'
  });
  assert.equal(searchAny.items.length, 1, 'Single matching term with matchMode:any must return result');

  // matchMode: 'partial' allows term subset
  const searchPartial = graph.search('Database PostgreSQL Redis', {
    project: 'search-proj',
    matchMode: 'partial'
  });
  assert.equal(searchPartial.items.length, 1, 'Partial match with 3 terms must return matching subset');
  assert.equal(searchPartial.items[0].partialMatch, true, 'partialMatch property must be true on hit');
  assert.equal(searchPartial.items[0].matchedTermCount, 2, 'matchedTermCount must be 2');
  assert.equal(searchPartial.items[0].totalQueryTerms, 3, 'totalQueryTerms must be 3');
});

test('Adversarial M1-8: Required schema fields accept a classified attempt payload', () => {
  const catalog = buildToolCatalog({ verifier: true });

  // New MCP attempt writes classify the result explicitly; other M1 fields stay optional.
  const classifiedAttemptPayload = {
    solution: 'Restarted process',
    result: 'Process recovered',
    resultClass: 'succeeded'
  };
  const attemptTool = catalog.find((t) => t.name === 'shadowgraph_record_attempt');
  assert.ok(attemptTool.inputSchema.required.includes('resultClass'));
  for (const req of attemptTool.inputSchema.required) {
    assert.ok(req in classifiedAttemptPayload, `Classified payload must satisfy required property ${req}`);
  }

  const legacyDecisionPayload = {
    title: 'Use Redis Cache',
    chosen: 'Redis 7'
  };
  const decTool = catalog.find((t) => t.name === 'shadowgraph_record_decision');
  for (const req of decTool.inputSchema.required) {
    assert.ok(req in legacyDecisionPayload, `Legacy payload must satisfy required property ${req}`);
  }

  const legacyFactPayload = {
    key: 'cache.status',
    value: 'active'
  };
  const factTool = catalog.find((t) => t.name === 'shadowgraph_record_fact');
  for (const req of factTool.inputSchema.required) {
    assert.ok(req in legacyFactPayload, `Legacy payload must satisfy required property ${req}`);
  }
});

// ---------------------------------------------------------------------------
// STDIO JSON-RPC Protocol Level Adversarial Harness & Tests
// ---------------------------------------------------------------------------

const MODERN_PROTOCOL = '2026-07-28';
function modernMeta() {
  return {
    'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
    'io.modelcontextprotocol/clientInfo': { name: 'adversarial-m1-test', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {}
  };
}

function parseResult(res) {
  if (res.result?.structuredContent) return res.result.structuredContent;
  const text = res.result?.content?.[0]?.text;
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

async function startMcpServer(t, { env = {}, profile } = {}) {
  const directory = await scratchDirectory(t, 'shadowgraph-adv-mcp-');
  const file = join(directory, 'data.json');
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });

  const profileEnv = {};
  if (profile === 'compact') profileEnv.SHADOWGRAPH_MCP_COMPACT = '1';
  else if (profile === 'workflow') profileEnv.SHADOWGRAPH_MCP_PROFILE = 'workflow';
  else if (profile) profileEnv.SHADOWGRAPH_MCP_PROFILE = profile;

  const child = spawn(process.execPath, [join(process.cwd(), 'src/mcp.js')], {
    cwd: directory,
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_HOME: home,
      ...profileEnv,
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdoutBuffer = '';
  let stderr = '';
  const responses = [];
  const waiters = [];
  let reqCounter = 1;

  function deliver(msg) {
    responses.push(msg);
    const index = waiters.findIndex((w) => w.predicate(msg));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    }
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) {
        try { deliver(JSON.parse(line)); } catch { /* ignore */ }
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  function waitFor(predicate, label, timeoutMs = 8000) {
    const existing = responses.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timeout waiting for ${label}; stderr: ${stderr}`));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          resolve();
        }, 2000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  t.after(stop);

  return {
    child,
    get stderr() { return stderr; },
    call(method, params = {}) {
      const id = reqCounter++;
      const pending = waitFor((r) => r.id === id, `request id ${id}`);
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      return pending;
    },
    async listTools() {
      const res = await this.call('tools/list', { _meta: modernMeta() });
      assert.equal(res.error, undefined, `tools/list failed: ${JSON.stringify(res.error)}`);
      return res.result.tools;
    },
    async callTool(name, args = {}) {
      return this.call('tools/call', {
        name,
        arguments: args,
        _meta: modernMeta()
      });
    }
  };
}

test('Adversarial M1-9: stdio MCP shadowgraph_record_fact missing value is rejected over JSON-RPC', async (t) => {
  const mcp = await startMcpServer(t);

  // Missing value argument over JSON-RPC
  const res = await mcp.callTool('shadowgraph_record_fact', {
    key: 'rpc.missing.value',
    project: 'adversarial-proj'
  });

  assert.ok(res.error || res.result?.isError, 'record_fact without value must return error');
});

test('Adversarial M1-10: stdio MCP shadowgraph_record_outcome autoTransition and aliases over JSON-RPC', async (t) => {
  const mcp = await startMcpServer(t);

  // 1. Create a decision
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'RPC Outcome Test Decision',
    chosen: 'RPC Choice',
    project: 'adversarial-proj'
  });
  assert.equal(decRes.error, undefined);
  const decision = parseResult(decRes);
  assert.ok(decision && decision.id);
  assert.equal(decision.status, 'proposed');

  // 2. Call record_outcome with top-level autoTransition: true
  const out1 = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decision.id,
    autoTransition: true,
    outcome: { status: 'successful' },
    project: 'adversarial-proj'
  });
  assert.equal(out1.error, undefined);
  const updatedDec1 = parseResult(out1);
  assert.equal(updatedDec1.status, 'validated', 'top-level autoTransition:true must transition decision to validated');

  // 3. Call record_outcome using top-level id alias instead of decisionId
  const out2 = await mcp.callTool('shadowgraph_record_outcome', {
    id: decision.id,
    lifecycleStatus: 'executed',
    outcome: { status: 'successful' },
    project: 'adversarial-proj'
  });
  assert.equal(out2.error, undefined);
  const updatedDec2 = parseResult(out2);
  assert.equal(updatedDec2.status, 'executed', 'top-level id alias and lifecycleStatus must transition status to executed');

  // 4. Test precedence: nested outcome.decisionStatus takes precedence over top-level decisionStatus
  const out3 = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decision.id,
    decisionStatus: 'validated',
    outcome: { status: 'successful', decisionStatus: 'in_progress' },
    project: 'adversarial-proj'
  });
  assert.equal(out3.error, undefined);
  const updatedDec3 = parseResult(out3);
  assert.equal(updatedDec3.status, 'in_progress', 'nested outcome.decisionStatus must take precedence over top-level decisionStatus');
});

test('Adversarial M1-11: stdio MCP profile inventory under compact, workflow, and full tiers', async (t) => {
  // Full Profile (default)
  const fullMcp = await startMcpServer(t);
  const fullTools = await fullMcp.listTools();
  assert.equal(fullTools.length, 35, 'Full profile stdio server must list exactly 35 tools');

  // Compact Profile (compact: 1)
  const compactMcp = await startMcpServer(t, { profile: 'compact' });
  const compactTools = await compactMcp.listTools();
  assert.equal(compactTools.length, 16, 'Compact profile stdio server must list exactly 16 tools');

  // Workflow Profile (profile: workflow)
  const workflowMcp = await startMcpServer(t, { profile: 'workflow' });
  const workflowTools = await workflowMcp.listTools();
  assert.equal(workflowTools.length, 20, 'Workflow profile stdio server must list exactly 20 tools');
});

test('Adversarial M1-12: stdio MCP server crash behavior on invalid SHADOWGRAPH_MCP_PROFILE values', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-invalid-profile-');
  const file = join(directory, 'data.json');

  // Test that setting SHADOWGRAPH_MCP_PROFILE=compact fails fast on startup
  const runCompactProfile = spawn(process.execPath, [join(process.cwd(), 'src/mcp.js')], {
    cwd: directory,
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_MCP_PROFILE: 'compact'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const compactExit = await new Promise((resolve) => {
    let stderr = '';
    runCompactProfile.stderr.on('data', (d) => { stderr += d; });
    runCompactProfile.on('exit', (code) => resolve({ code, stderr }));
  });

  assert.notEqual(compactExit.code, 0, 'SHADOWGRAPH_MCP_PROFILE=compact must exit with failure');
  assert.match(compactExit.stderr, /Unknown SHADOWGRAPH_MCP_PROFILE; supported value: workflow/i);

  // Test that setting SHADOWGRAPH_MCP_PROFILE=full fails fast on startup
  const runFullProfile = spawn(process.execPath, [join(process.cwd(), 'src/mcp.js')], {
    cwd: directory,
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_MCP_PROFILE: 'full'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const fullExit = await new Promise((resolve) => {
    let stderr = '';
    runFullProfile.stderr.on('data', (d) => { stderr += d; });
    runFullProfile.on('exit', (code) => resolve({ code, stderr }));
  });

  assert.notEqual(fullExit.code, 0, 'SHADOWGRAPH_MCP_PROFILE=full must exit with failure');
  assert.match(fullExit.stderr, /Unknown SHADOWGRAPH_MCP_PROFILE; supported value: workflow/i);
});
