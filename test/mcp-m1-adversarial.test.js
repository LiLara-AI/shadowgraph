import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { buildToolCatalog, selectTools, COMPACT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '../src/mcp-tools.js';
import { createShadowGraph } from '../src/shadowgraph.js';

// ---------------------------------------------------------------------------
// Helper: MCP Stdio Client Harness
// ---------------------------------------------------------------------------
async function createMcpHarness(t, { env = {}, profile } = {}) {
  const dir = await scratchDirectory(t, 'mcp-m1-adversarial-');
  const file = join(dir, 'data.json');
  const home = join(dir, 'home');
  mkdirSync(home, { recursive: true });

  const profileEnv = {};
  if (profile === 'compact') profileEnv.SHADOWGRAPH_MCP_COMPACT = '1';
  else if (profile === 'workflow') profileEnv.SHADOWGRAPH_MCP_PROFILE = 'workflow';
  else if (profile === 'full') {
    profileEnv.SHADOWGRAPH_MCP_COMPACT = '0';
    profileEnv.SHADOWGRAPH_MCP_PROFILE = '';
  }

  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.js', import.meta.url))], {
    cwd: dir,
    windowsHide: true,
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_HOME: home,
      SHADOWGRAPH_STORAGE: 'json',
      NODE_ENV: 'test',
      ...profileEnv,
      ...env
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let stderr = '';
  child.stderr.on('data', (c) => { stderr += c; });

  const closed = once(child, 'close');
  const pending = new Map();
  let idCounter = 1;

  const lines = createInterface({ input: child.stdout });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    try {
      const response = JSON.parse(line);
      if (response && response.id !== undefined) {
        pending.get(response.id)?.(response);
      }
    } catch {
      // ignore
    }
  });

  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }, 2000);
    await closed;
    clearTimeout(timer);
    lines.close();
  });

  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const key = idCounter++;
    const timer = setTimeout(() => {
      pending.delete(key);
      reject(new Error(`${method} timed out. stderr: ${stderr}`));
    }, 15000);
    pending.set(key, (res) => {
      clearTimeout(timer);
      pending.delete(key);
      resolve(res);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: key, method, params }) + '\n');
  });

  const initRes = await rpc('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'm1-adversarial', version: '1.0.0' }
  });
  assert.equal(initRes.error, undefined, `Init failed: ${JSON.stringify(initRes.error)}`);

  const callTool = async (name, args = {}) => {
    const res = await rpc('tools/call', {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': { name: 'm1-adversarial', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {}
      }
    });
    return res;
  };

  const listTools = async () => {
    const res = await rpc('tools/list', {});
    assert.equal(res.error, undefined, `tools/list failed: ${JSON.stringify(res.error)}`);
    return res.result?.tools ?? [];
  };

  return { child, dir, file, rpc, callTool, listTools, getStderr: () => stderr };
}

// ===========================================================================
// SECTION 1: Profile Inventories Under Environment Configurations
// ===========================================================================

test('Profile Inventories: compact, workflow, and full tool catalogs', async (t) => {
  // 1. Full Mode
  const fullMcp = await createMcpHarness(t, { profile: 'full' });
  const fullTools = await fullMcp.listTools();
  assert.equal(fullTools.length, 35, 'Full profile must advertise exactly 35 tools');

  // 2. Compact Mode via SHADOWGRAPH_MCP_COMPACT=1
  const compactMcp = await createMcpHarness(t, { profile: 'compact' });
  const compactTools = await compactMcp.listTools();
  assert.equal(compactTools.length, 16, 'Compact profile must advertise exactly 16 tools');
  assert.deepEqual(compactTools.map((x) => x.name), COMPACT_TOOL_NAMES);

  // 3. Workflow Mode via SHADOWGRAPH_MCP_PROFILE=workflow
  const workflowMcp = await createMcpHarness(t, { profile: 'workflow' });
  const workflowTools = await workflowMcp.listTools();
  assert.equal(workflowTools.length, 20, 'Workflow profile must advertise exactly 20 tools');
  assert.deepEqual(workflowTools.map((x) => x.name), WORKFLOW_TOOL_NAMES);
});

test('Profile Invariant: selectTools rejects invalid or conflicting configurations', () => {
  const catalog = buildToolCatalog({ verifier: false });

  // Conflict: compact=true and profile='workflow'
  assert.throws(
    () => selectTools(catalog, { compact: true, profile: 'workflow' }),
    /conflicts with SHADOWGRAPH_MCP_COMPACT=1/
  );

  // Unsupported profile strings: 'compact', 'full', 'admin', 'custom'
  assert.throws(
    () => selectTools(catalog, { profile: 'compact' }),
    /Unknown SHADOWGRAPH_MCP_PROFILE; supported value: workflow/
  );
  assert.throws(
    () => selectTools(catalog, { profile: 'full' }),
    /Unknown SHADOWGRAPH_MCP_PROFILE; supported value: workflow/
  );
  assert.throws(
    () => selectTools(catalog, { profile: 'admin' }),
    /Unknown SHADOWGRAPH_MCP_PROFILE; supported value: workflow/
  );
});

// ===========================================================================
// SECTION 2: shadowgraph_record_fact - Required Value & Boundary Validation
// ===========================================================================

test('Feature 6 & Boundary: shadowgraph_record_fact strictly enforces required value', async (t) => {
  const mcp = await createMcpHarness(t);

  // 1. Missing value entirely -> rejected by engine
  const resMissing = await mcp.callTool('shadowgraph_record_fact', {
    key: 'system.node_version',
    project: 'adv-project'
  });
  assert.ok(resMissing.error || resMissing.result?.isError, 'Missing value must fail');

  // 2. Value is null -> allowed in plain JSON
  const resNull = await mcp.callTool('shadowgraph_record_fact', {
    key: 'system.nullable_flag',
    value: null,
    project: 'adv-project'
  });
  assert.equal(resNull.error, undefined, 'null is a valid JSON value');
  assert.equal(resNull.result?.structuredContent?.value, null);

  // 3. Value is false (boolean falsy) -> must not be treated as missing
  const resFalse = await mcp.callTool('shadowgraph_record_fact', {
    key: 'system.is_debug',
    value: false,
    project: 'adv-project'
  });
  assert.equal(resFalse.error, undefined, 'false is a valid JSON value');
  assert.equal(resFalse.result?.structuredContent?.value, false);

  // 4. Value is 0 (numeric falsy) -> must not be treated as missing
  const resZero = await mcp.callTool('shadowgraph_record_fact', {
    key: 'system.retry_count',
    value: 0,
    project: 'adv-project'
  });
  assert.equal(resZero.error, undefined, '0 is a valid JSON value');
  assert.equal(resZero.result?.structuredContent?.value, 0);

  // 5. Value is empty string "" (string falsy) -> must not be treated as missing
  const resEmptyStr = await mcp.callTool('shadowgraph_record_fact', {
    key: 'system.prefix',
    value: '',
    project: 'adv-project'
  });
  assert.equal(resEmptyStr.error, undefined, 'empty string is a valid JSON value');
  assert.equal(resEmptyStr.result?.structuredContent?.value, '');
});

test('Feature 6: shadowgraph_record_fact backfill and temporal ordering rejection', async (t) => {
  const mcp = await createMcpHarness(t);

  // Record an initial fact at T2
  const f1 = await mcp.callTool('shadowgraph_record_fact', {
    key: 'cluster.leader',
    value: 'node-2',
    validFrom: '2026-06-01T00:00:00.000Z',
    project: 'adv-project'
  });
  assert.equal(f1.error, undefined);

  // Attempting to write an earlier validFrom WITHOUT allowHistorical / backfill must throw
  const fEarlierRejected = await mcp.callTool('shadowgraph_record_fact', {
    key: 'cluster.leader',
    value: 'node-1',
    validFrom: '2026-01-01T00:00:00.000Z',
    project: 'adv-project'
  });
  assert.ok(
    fEarlierRejected.error || fEarlierRejected.result?.isError,
    'Non-decreasing validFrom must be rejected without backfill'
  );

  // Writing earlier validFrom WITH backfill: true must succeed
  const fEarlierAllowed = await mcp.callTool('shadowgraph_record_fact', {
    key: 'cluster.leader',
    value: 'node-1',
    validFrom: '2026-01-01T00:00:00.000Z',
    backfill: true,
    reason: 'Retroactive audit data',
    changeSummary: 'Backfilled leader for H1',
    project: 'adv-project'
  });
  assert.equal(fEarlierAllowed.error, undefined);
  assert.equal(fEarlierAllowed.result?.structuredContent?.value, 'node-1');
  assert.equal(fEarlierAllowed.result?.structuredContent?.changeSummary, 'Backfilled leader for H1');
});

// ===========================================================================
// SECTION 3: shadowgraph_record_outcome - autoTransition & Status Aliases
// ===========================================================================

test('Feature 3: autoTransition inside outcome transitions decision lifecycle', async (t) => {
  const mcp = await createMcpHarness(t);

  // Setup decision
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Deployment Strategy',
    chosen: 'Blue-Green',
    project: 'adv-project'
  });
  assert.equal(decRes.error, undefined);
  const decId = decRes.result?.structuredContent?.id;

  // Outcome with autoTransition: true inside outcome object
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decId,
    outcome: {
      status: 'successful',
      autoTransition: true
    },
    project: 'adv-project'
  });
  assert.equal(outRes.error, undefined);
  assert.equal(outRes.result?.structuredContent?.status, 'validated');
});

test('Feature 3: autoTransition top-level alias transitions decision lifecycle', async (t) => {
  const mcp = await createMcpHarness(t);

  // Setup decision
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Canary Rollout',
    chosen: '5% Canary',
    project: 'adv-project'
  });
  assert.equal(decRes.error, undefined);
  const decId = decRes.result?.structuredContent?.id;

  // Outcome with top-level autoTransition: true and top-level id alias
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    id: decId,
    outcome: {
      status: 'failed'
    },
    autoTransition: true,
    project: 'adv-project'
  });
  assert.equal(outRes.error, undefined);
  assert.equal(outRes.result?.structuredContent?.status, 'failed');
});

test('Feature 3: decisionStatus top-level and lifecycleStatus inside outcome', async (t) => {
  const mcp = await createMcpHarness(t);

  // 1. Top-level decisionStatus
  const d1 = await mcp.callTool('shadowgraph_record_decision', {
    title: 'DB Indexing',
    chosen: 'BTree index',
    project: 'adv-project'
  });
  const id1 = d1.result?.structuredContent?.id;

  const out1 = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: id1,
    outcome: { status: 'successful' },
    decisionStatus: 'executed',
    project: 'adv-project'
  });
  assert.equal(out1.error, undefined);
  assert.equal(out1.result?.structuredContent?.status, 'executed');

  // 2. Inside outcome: lifecycleStatus
  const d2 = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Cache Policy',
    chosen: 'LRU',
    project: 'adv-project'
  });
  const id2 = d2.result?.structuredContent?.id;

  const out2 = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: id2,
    outcome: {
      status: 'successful',
      lifecycleStatus: 'executed'
    },
    project: 'adv-project'
  });
  assert.equal(out2.error, undefined);
  assert.equal(out2.result?.structuredContent?.status, 'executed');
});

test('Feature 3: Precedence - outcome-internal decisionStatus overrides top-level alias', async (t) => {
  const mcp = await createMcpHarness(t);

  const dec = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Load Balancer',
    chosen: 'HAProxy',
    project: 'adv-project'
  });
  const decId = dec.result?.structuredContent?.id;

  // Pass outcome.decisionStatus: 'executed' AND top-level decisionStatus: 'validated'
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decId,
    outcome: {
      status: 'successful',
      decisionStatus: 'executed'
    },
    decisionStatus: 'validated',
    project: 'adv-project'
  });
  assert.equal(outRes.error, undefined);
  // outcome.decisionStatus takes precedence over top-level fallback
  assert.equal(outRes.result?.structuredContent?.status, 'executed');
});

test('Feature 3: Malformed & Invalid decisionStatus transitions are rejected', async (t) => {
  const mcp = await createMcpHarness(t);

  const dec = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Testing Illegal Transitions',
    chosen: 'Option X',
    project: 'adv-project'
  });
  const decId = dec.result?.structuredContent?.id;

  // 1. Non-existent status name
  const resBadStatus = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decId,
    outcome: { status: 'successful' },
    decisionStatus: 'super_validated_bogus',
    project: 'adv-project'
  });
  assert.ok(resBadStatus.error || resBadStatus.result?.isError, 'Bad status string must be rejected');

  // 2. System-owned status 'stale' cannot be set by outcome
  const resStale = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decId,
    outcome: { status: 'successful' },
    decisionStatus: 'stale',
    project: 'adv-project'
  });
  assert.ok(resStale.error || resStale.result?.isError, 'System-owned status stale must be rejected');

  // 3. System-owned status 'superseded' cannot be set by outcome
  const resSuperseded = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decId,
    outcome: { status: 'successful' },
    decisionStatus: 'superseded',
    project: 'adv-project'
  });
  assert.ok(resSuperseded.error || resSuperseded.result?.isError, 'System-owned status superseded must be rejected');
});

// ===========================================================================
// SECTION 4: Malformed and Unexpected Types for Newly Exposed Fields
// ===========================================================================

test('Malformations: visibility validation rejects invalid scopes', async (t) => {
  const mcp = await createMcpHarness(t);

  // 1. visibility: 'private' (not 'project' or 'global')
  const resAttempt = await mcp.callTool('shadowgraph_record_attempt', {
    solution: 'Adversarial visibility test',
    result: 'Failed',
    resultClass: 'failed',
    visibility: 'private',
    project: 'adv-project'
  });
  assert.ok(resAttempt.error || resAttempt.result?.isError, 'visibility must be project or global');

  // 2. visibility: 12345 (number)
  const resFact = await mcp.callTool('shadowgraph_record_fact', {
    key: 'invalid.visibility.type',
    value: 'test',
    visibility: 12345,
    project: 'adv-project'
  });
  assert.ok(resFact.error || resFact.result?.isError, 'numeric visibility must be rejected');

  // 3. visibility: omitted is undefined on record; null is normalized to fallback 'project'
  const resOmitted = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Valid Omitted Visibility',
    chosen: 'Default',
    project: 'adv-project'
  });
  assert.equal(resOmitted.error, undefined);
  assert.equal(resOmitted.result?.structuredContent?.visibility, undefined);

  const resExplicitProject = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Explicit Project Visibility',
    chosen: 'Default',
    visibility: 'project',
    project: 'adv-project'
  });
  assert.equal(resExplicitProject.error, undefined);
  assert.equal(resExplicitProject.result?.structuredContent?.visibility, 'project');

  const resNullProject = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Null Visibility Normalized',
    chosen: 'Default',
    visibility: null,
    project: 'adv-project'
  });
  assert.equal(resNullProject.error, undefined);
  assert.equal(resNullProject.result?.structuredContent?.visibility, 'project');
});

test('Malformations: matchMode validation in search and retrieve', async (t) => {
  const mcp = await createMcpHarness(t);

  // Valid matchModes: 'all', 'partial', 'any'
  for (const mode of ['all', 'partial', 'any']) {
    const res = await mcp.callTool('shadowgraph_search', {
      query: 'test query',
      matchMode: mode,
      project: 'adv-project'
    });
    assert.equal(res.error, undefined, `matchMode ${mode} must be accepted`);
  }

  // Retrieve valid matchModes
  for (const mode of ['all', 'partial', 'any']) {
    const res = await mcp.callTool('shadowgraph_retrieve', {
      query: 'test query',
      matchMode: mode,
      project: 'adv-project'
    });
    assert.equal(res.error, undefined, `retrieve matchMode ${mode} must be accepted`);
  }
});

// ===========================================================================
// SECTION 5: Feature 1 & 2 - shadowgraph_record_attempt & record_decision
// ===========================================================================

test('Feature 1 & 2: Complex field storage and propagation', async (t) => {
  const mcp = await createMcpHarness(t);

  // Attempt with reusableWhen symbolic conditions and relatedTo
  const attemptRes = await mcp.callTool('shadowgraph_record_attempt', {
    solution: 'Optimistic concurrency control with revision check',
    result: 'Zero conflicts detected under 500 RPS benchmark',
    resultClass: 'succeeded',
    task: 'High-throughput concurrency test',
    tags: ['performance', 'concurrency', 'occ'],
    visibility: 'global',
    reusableWhen: ['concurrency.level >= 100', 'db.mode == "distributed"'],
    project: 'adv-project'
  });
  assert.equal(attemptRes.error, undefined);
  const attempt = attemptRes.result?.structuredContent;
  assert.equal(attempt.task, 'High-throughput concurrency test');
  assert.deepEqual(attempt.tags, ['performance', 'concurrency', 'occ']);
  assert.equal(attempt.visibility, 'global');

  // Decision referencing failed attempts and superseded records
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Concurrency Protocol',
    chosen: 'Optimistic Concurrency Control',
    status: 'planned',
    failedAttempts: [attempt.id],
    reason: 'Pessimistic locking suffered catastrophic deadlock at scale',
    changeSummary: 'Switched from pessimistic lock to OCC',
    task: 'Concurrency Redesign',
    tags: ['architecture', 'locks', 'occ'],
    visibility: 'global',
    project: 'adv-project'
  });
  assert.equal(decRes.error, undefined);
  const decision = decRes.result?.structuredContent;
  assert.equal(decision.status, 'planned');
  assert.equal(decision.visibility, 'global');
  assert.equal(decision.task, 'Concurrency Redesign');
  assert.equal(decision.changeSummary, 'Switched from pessimistic lock to OCC');
});

// ===========================================================================
// SECTION 6: Cross-Project Recall & Context Advisory Surfacing
// ===========================================================================

test('Feature 4 & 5: Cross-project recall and context advisory enrichment', async (t) => {
  const mcp = await createMcpHarness(t);

  // Record a global fact in project Alpha
  const factAlpha = await mcp.callTool('shadowgraph_record_fact', {
    key: 'shared.service.url',
    value: 'https://api.internal.network/v1',
    visibility: 'global',
    project: 'project-alpha'
  });
  assert.equal(factAlpha.error, undefined);

  // Record a global attempt in project Alpha
  const attemptAlpha = await mcp.callTool('shadowgraph_record_attempt', {
    solution: 'Use shared service url with TLS 1.3',
    result: 'Connected successfully with mutual TLS',
    resultClass: 'succeeded',
    visibility: 'global',
    tags: ['shared', 'service', 'tls'],
    project: 'project-alpha'
  });
  assert.equal(attemptAlpha.error, undefined);

  // Query recall from project Beta with includeCrossProject: true
  const recallBeta = await mcp.callTool('shadowgraph_recall', {
    query: 'shared service url',
    includeCrossProject: true,
    includeHistory: true,
    expandSynonyms: true,
    project: 'project-beta'
  });
  assert.equal(recallBeta.error, undefined);
  const hits = recallBeta.result?.structuredContent?.items ?? [];
  assert.ok(hits.length > 0, 'Cross-project global fact should be recalled in project Beta');

  // Query context in project Beta with includeCrossProject: true
  const contextBeta = await mcp.callTool('shadowgraph_context', {
    project: 'project-beta',
    includeCrossProject: true
  });
  assert.equal(contextBeta.error, undefined);
  const ctx = contextBeta.result?.structuredContent;
  assert.ok(ctx, 'Context response must exist');
});

// ===========================================================================
// SECTION 7: Ergonomic Fallbacks, History Chains & Advanced Partial Matching
// ===========================================================================

test('Feature 2 Ergonomics: record_decision falls back to title if chosen is omitted', async (t) => {
  const mcp = await createMcpHarness(t);

  // Calling record_decision without 'chosen', but with 'title'
  const res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Migrate to HTTP/3 Transport',
    project: 'adv-project'
  });
  assert.equal(res.error, undefined, 'Omitting chosen should fallback to title');
  const record = res.result?.structuredContent;
  assert.equal(record.title, 'Migrate to HTTP/3 Transport');
  assert.equal(record.chosen, 'Migrate to HTTP/3 Transport', 'chosen must fall back to title');
});

test('Feature 3 Ergonomics: record_outcome maps outcome.success to status: successful and autoTransitions', async (t) => {
  const mcp = await createMcpHarness(t);

  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Zero Downtime Migration',
    chosen: 'Blue-green proxy cutover',
    project: 'adv-project'
  });
  assert.equal(decRes.error, undefined);
  const decId = decRes.result?.structuredContent?.id;

  // Outcome with success: true and autoTransition: true at top-level
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    id: decId,
    outcome: { success: true },
    autoTransition: true,
    project: 'adv-project'
  });
  assert.equal(outRes.error, undefined);
  const updatedDec = outRes.result?.structuredContent;
  assert.equal(updatedDec.status, 'validated', 'success: true + autoTransition: true must transition to validated');
  assert.equal(updatedDec.outcome?.status, 'successful', 'outcome status must be mapped to successful');
});

test('Feature 4 & 6: Supersession, recall with includeHistory and historyChain', async (t) => {
  const mcp = await createMcpHarness(t);

  // Decision 1
  const d1 = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Database Engine Selection',
    chosen: 'MySQL 8.0 with InnoDB',
    project: 'adv-project'
  });
  assert.equal(d1.error, undefined);
  const id1 = d1.result?.structuredContent?.id;

  // Decision 2 superseding Decision 1 using shadowgraph_supersede with reason and changeSummary
  const d2 = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Database Engine Selection',
    chosen: 'PostgreSQL 16 with pgvector',
    project: 'adv-project'
  });
  assert.equal(d2.error, undefined);
  const id2 = d2.result?.structuredContent?.id;

  const supRes = await mcp.callTool('shadowgraph_supersede', {
    decisionId: id1,
    replacementId: id2,
    reason: 'Vector search requirement',
    changeSummary: 'Migrated from MySQL to PostgreSQL for pgvector support',
    project: 'adv-project'
  });
  assert.equal(supRes.error, undefined);

  // Recall with includeHistory: true
  const recallRes = await mcp.callTool('shadowgraph_recall', {
    query: 'Database Engine Selection',
    includeHistory: true,
    project: 'adv-project'
  });
  assert.equal(recallRes.error, undefined);
  const items = recallRes.result?.structuredContent?.items ?? [];
  assert.ok(items.length > 0, 'Must recall decision hits');
  const activeHit = items.find((x) => x.record?.id === id2);
  assert.ok(activeHit, 'Replacement decision must be recalled');
  assert.ok(Array.isArray(activeHit.historyChain), 'activeHit must carry historyChain array');
  assert.ok(activeHit.historyChain.some((h) => h.id === id1), 'historyChain must include superseded decision id1');
});

test('Feature 7: Search with matchMode partial exposes partialMatch and term counts', async (t) => {
  const mcp = await createMcpHarness(t);

  // Record a decision with 4 distinct keywords
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Quantum Resistant Cryptography Algorithm Selection',
    chosen: 'Kyber lattice encryption',
    task: 'Post-quantum network security upgrade',
    tags: ['quantum', 'lattice', 'crypto', 'kyber'],
    project: 'adv-project'
  });
  assert.equal(decRes.error, undefined);

  // Search with matchMode: 'partial' and 4 terms where 3 match
  const searchRes = await mcp.callTool('shadowgraph_search', {
    query: 'quantum lattice crypto nonmatchingtoken',
    matchMode: 'partial',
    project: 'adv-project'
  });
  assert.equal(searchRes.error, undefined);
  const items = searchRes.result?.structuredContent?.items ?? [];
  assert.ok(items.length > 0, 'Partial search should find the record');
  const hit = items[0];
  assert.equal(hit.partialMatch, true, 'partialMatch flag must be true');
  assert.equal(hit.matchedTermCount, 3, 'matchedTermCount must be 3');
  assert.equal(hit.totalQueryTerms, 4, 'totalQueryTerms must be 4');
});

test('Feature 6: shadowgraph_remember with visibility, backfill, reason, and changeSummary', async (t) => {
  const mcp = await createMcpHarness(t);

  const memRes = await mcp.callTool('shadowgraph_remember', {
    memoryType: 'instruction',
    key: 'coding.style.naming',
    text: 'Use snake_case for python variables and camelCase for typescript',
    visibility: 'global',
    reason: 'Style consistency across microservices',
    changeSummary: 'Initial team naming conventions',
    backfill: true,
    project: 'adv-project'
  });
  assert.equal(memRes.error, undefined);
  const mem = memRes.result?.structuredContent?.memory;
  assert.ok(mem, 'Structured content must contain memory object');
  assert.equal(mem.visibility, 'global');
  assert.equal(mem.changeSummary, 'Initial team naming conventions');
});
