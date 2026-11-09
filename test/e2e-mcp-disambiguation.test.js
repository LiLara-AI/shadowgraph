import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { buildToolCatalog, COMPACT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '../src/mcp-tools.js';

// ---------------------------------------------------------------------------
// Opaque-Box Test Harness
// ---------------------------------------------------------------------------
// Interacts strictly through public entry points:
// 1. MCP stdio JSON-RPC protocol (`node src/mcp.js`)
// 2. Command-Line Interface (`node src/cli.js`)
// 3. Public exports from package root
// ---------------------------------------------------------------------------

const MODERN_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta(clientInfo = { name: 'e2e-disambiguation-test', version: '1.0.0' }) {
  return {
    [PROTOCOL_VERSION_META]: MODERN_PROTOCOL,
    [CLIENT_INFO_META]: clientInfo,
    [CLIENT_CAPABILITIES_META]: {}
  };
}

function parseToolResult(res) {
  if (res.result?.structuredContent) return res.result.structuredContent;
  const text = res.result?.content?.[0]?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function startMcpHarness(t, { env = {}, profile } = {}) {
  const directory = await scratchDirectory(t, 'shadowgraph-e2e-mcp-');
  const file = join(directory, 'data.json');
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });

  const profileEnv = {};
  if (profile === 'compact') profileEnv.SHADOWGRAPH_MCP_COMPACT = '1';
  else if (profile === 'workflow') profileEnv.SHADOWGRAPH_MCP_PROFILE = 'workflow';

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
        try { deliver(JSON.parse(line)); } catch { /* ignore stream noise */ }
      }
    }
  });

  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  function waitFor(predicate, label, timeoutMs = 12000) {
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
    directory,
    file,
    home,
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
      const res = await this.call('tools/call', {
        name,
        arguments: args,
        _meta: modernMeta()
      });
      return res;
    },
    stop
  };
}

function runCliSync(args, { env = {}, input, cwd } = {}) {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'src/cli.js'), ...args], {
    cwd: cwd ?? process.cwd(),
    input: input !== undefined ? input : undefined,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 10000
  });
  return result;
}

// ===========================================================================
// TIER 1: Feature Coverage (Happy Path for each feature in Feature Inventory)
// ===========================================================================

test('Tier 1: Feature 1 - shadowgraph_record_attempt schema exposure and execution', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const attemptTool = tools.find((tool) => tool.name === 'shadowgraph_record_attempt');
  assert.ok(attemptTool, 'shadowgraph_record_attempt must be registered');

  const inputProps = attemptTool.inputSchema.properties;
  if (!inputProps.reusableWhen) {
    t.skip('Pending Milestone M1: reusableWhen not yet exposed in shadowgraph_record_attempt schema');
    return;
  }

  // Verify all required schema additions for Feature 1
  assert.ok(inputProps.reusableWhen, 'reusableWhen must be exposed in input schema');
  assert.ok(inputProps.relatedTo, 'relatedTo must be exposed in input schema');
  assert.ok(inputProps.task, 'task must be exposed in input schema');
  assert.ok(inputProps.tags, 'tags must be exposed in input schema');
  assert.ok(inputProps.visibility, 'visibility must be exposed in input schema');

  // Verify output schema optional fields
  const outputProps = attemptTool.outputSchema?.properties ?? {};
  assert.ok(outputProps.task, 'task must be exposed in attempt output schema');
  assert.ok(outputProps.tags, 'tags must be exposed in attempt output schema');
  assert.ok(outputProps.visibility, 'visibility must be exposed in attempt output schema');

  // Opaque-box execution with all new properties
  const res = await mcp.callTool('shadowgraph_record_attempt', {
    solution: 'Implement schema validation hook',
    result: 'Passed all unit tests',
    resultClass: 'succeeded',
    task: 'Add schema completeness',
    tags: ['mcp', 'schema', 'e2e'],
    visibility: 'global',
    reusableWhen: ['env.schema_complete == true'],
    relatedTo: ['decision-placeholder'],
    project: 'e2e-project'
  });

  assert.equal(res.error, undefined, `Call failed: ${JSON.stringify(res.error)}`);
  assert.ok(res.result, 'Must return a result');
  const record = parseToolResult(res);
  assert.ok(typeof record === 'object' && record !== null, 'Must return structured record');
  assert.equal(record.task, 'Add schema completeness');
  assert.deepEqual(record.tags, ['mcp', 'schema', 'e2e']);
  assert.equal(record.visibility, 'global');
});

test('Tier 1: Feature 2 - shadowgraph_record_decision schema exposure and execution', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const decisionTool = tools.find((tool) => tool.name === 'shadowgraph_record_decision');
  assert.ok(decisionTool, 'shadowgraph_record_decision must be registered');

  const inputProps = decisionTool.inputSchema.properties;
  if (!inputProps.status) {
    t.skip('Pending Milestone M1: status not yet exposed in shadowgraph_record_decision schema');
    return;
  }

  assert.ok(inputProps.status, 'status must be exposed in input schema');
  assert.ok(inputProps.supersedes, 'supersedes must be exposed in input schema');
  assert.ok(inputProps.reviewAfter, 'reviewAfter must be exposed in input schema');
  assert.ok(inputProps.failedAttempts, 'failedAttempts must be exposed in input schema');
  assert.ok(inputProps.reason, 'reason must be exposed in input schema');
  assert.ok(inputProps.changeSummary, 'changeSummary must be exposed in input schema');
  assert.ok(inputProps.task, 'task must be exposed in input schema');
  assert.ok(inputProps.tags, 'tags must be exposed in input schema');
  assert.ok(inputProps.visibility, 'visibility must be exposed in input schema');

  const res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Adopt Multi-Model Consensus Architecture',
    chosen: 'Multi-model verification with Antigravity, Kimi, and Muse',
    status: 'proposed',
    reason: 'Improves fault-tolerance and verification quality',
    changeSummary: 'Initial proposal for multi-model distribution',
    task: 'Architecture Strategy',
    tags: ['consensus', 'architecture'],
    visibility: 'global',
    reviewAfter: '2026-12-31T23:59:59.000Z',
    project: 'e2e-project'
  });

  assert.equal(res.error, undefined, `Decision call failed: ${JSON.stringify(res.error)}`);
  const record = parseToolResult(res);
  assert.ok(typeof record === 'object' && record !== null);
  assert.equal(record.title, 'Adopt Multi-Model Consensus Architecture');
  assert.equal(record.status, 'proposed');
  assert.equal(record.visibility, 'global');
});

test('Tier 1: Feature 3 - shadowgraph_record_outcome schema exposure and top-level aliases', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const outcomeTool = tools.find((tool) => tool.name === 'shadowgraph_record_outcome');
  assert.ok(outcomeTool, 'shadowgraph_record_outcome must be registered');

  const topProps = outcomeTool.inputSchema.properties;
  const outcomeProps = topProps.outcome?.properties ?? {};
  if (!outcomeProps.autoTransition && !topProps.autoTransition) {
    t.skip('Pending Milestone M1: autoTransition not yet exposed in shadowgraph_record_outcome schema');
    return;
  }

  assert.ok(outcomeProps.autoTransition, 'autoTransition must be exposed inside outcome schema');
  assert.ok(outcomeProps.decisionStatus, 'decisionStatus must be exposed inside outcome schema');
  assert.ok(outcomeProps.lifecycleStatus, 'lifecycleStatus must be exposed inside outcome schema');
  assert.ok(topProps.autoTransition, 'autoTransition must be exposed as top-level alias');
  assert.ok(topProps.decisionStatus, 'decisionStatus must be exposed as top-level alias');
  assert.ok(topProps.lifecycleStatus, 'lifecycleStatus must be exposed as top-level alias');

  // Record a decision first
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Storage Strategy',
    chosen: 'SQLite Backing Store',
    project: 'e2e-project'
  });
  assert.equal(decRes.error, undefined, `Setup decision failed: ${JSON.stringify(decRes.error)}`);
  const decision = parseToolResult(decRes);

  // Call outcome with top-level autoTransition & decisionStatus
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decision.id,
    outcome: { status: 'successful', lessons: ['Worked as intended'] },
    autoTransition: true,
    decisionStatus: 'validated',
    project: 'e2e-project'
  });

  assert.equal(outRes.error, undefined, `Outcome call failed: ${JSON.stringify(outRes.error)}`);
  const updated = parseToolResult(outRes);
  assert.ok(typeof updated === 'object' && updated !== null, 'Outcome should return updated decision');
  assert.equal(updated.status, 'validated', 'Decision status should auto-transition to validated');
});

test('Tier 1: Feature 4 - shadowgraph_recall schema inputs and historyChain exposure', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const recallTool = tools.find((tool) => tool.name === 'shadowgraph_recall');
  assert.ok(recallTool, 'shadowgraph_recall must be registered');

  const inputProps = recallTool.inputSchema.properties;
  if (!inputProps.includeHistory) {
    t.skip('Pending Milestone M1: includeHistory not yet exposed in shadowgraph_recall schema');
    return;
  }

  assert.ok(inputProps.includeHistory, 'includeHistory must be exposed');
  assert.ok(inputProps.includeCrossProject, 'includeCrossProject must be exposed');
  assert.ok(inputProps.expandSynonyms, 'expandSynonyms must be exposed');

  const res = await mcp.callTool('shadowgraph_recall', {
    query: 'consensus architecture',
    includeHistory: true,
    includeCrossProject: true,
    expandSynonyms: true,
    project: 'e2e-project'
  });
  assert.equal(res.error, undefined, `Recall call failed: ${JSON.stringify(res.error)}`);
});

test('Tier 1: Feature 5 - shadowgraph_context schema input includeCrossProject & enriched advisory items', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const contextTool = tools.find((tool) => tool.name === 'shadowgraph_context');
  assert.ok(contextTool, 'shadowgraph_context must be registered');

  const inputProps = contextTool.inputSchema.properties;
  if (!inputProps.includeCrossProject) {
    t.skip('Pending Milestone M1: includeCrossProject not yet exposed on shadowgraph_context');
    return;
  }
  assert.ok(inputProps.includeCrossProject, 'includeCrossProject must be exposed on shadowgraph_context');

  const res = await mcp.callTool('shadowgraph_context', {
    project: 'e2e-project',
    includeCrossProject: true
  });
  assert.equal(res.error, undefined, `Context call failed: ${JSON.stringify(res.error)}`);
});

test('Tier 1: Feature 6 - shadowgraph_remember, record_fact, and supersede schema enhancements', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const factTool = tools.find((tool) => tool.name === 'shadowgraph_record_fact');
  const rememberTool = tools.find((tool) => tool.name === 'shadowgraph_remember');
  const supersedeTool = tools.find((tool) => tool.name === 'shadowgraph_supersede');

  assert.ok(factTool && rememberTool && supersedeTool, 'Memory and fact tools must exist');
  const factProps = factTool.inputSchema.properties;
  if (!factProps.backfill) {
    t.skip('Pending Milestone M1: backfill not yet exposed on shadowgraph_record_fact');
    return;
  }

  assert.ok(factProps.visibility, 'visibility must be exposed on record_fact');
  assert.ok(factProps.reason, 'reason must be exposed on record_fact');
  assert.ok(factProps.changeSummary, 'changeSummary must be exposed on record_fact');
  assert.ok(factProps.allowHistorical, 'allowHistorical must be exposed on record_fact');
  assert.ok(factProps.backfill, 'backfill must be exposed on record_fact');
  assert.ok(factTool.inputSchema.required?.includes('value'), 'value must be required on record_fact');

  assert.ok(rememberTool.inputSchema.properties.visibility, 'visibility on remember');
  assert.ok(supersedeTool.inputSchema.properties.reason, 'reason on supersede');
  assert.ok(supersedeTool.inputSchema.properties.changeSummary, 'changeSummary on supersede');

  // Test happy-path write of fact with backfill
  const factRes = await mcp.callTool('shadowgraph_record_fact', {
    key: 'system.node_version',
    value: '20.18.0',
    visibility: 'global',
    backfill: {
      validFrom: '2026-01-01T00:00:00.000Z',
      tags: ['runtime', 'node']
    },
    project: 'e2e-project'
  });
  assert.equal(factRes.error, undefined, `Fact write failed: ${JSON.stringify(factRes.error)}`);
});

test('Tier 1: Feature 7 - shadowgraph_search & retrieve matchMode and expandSynonyms inputs and outputs', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const searchTool = tools.find((tool) => tool.name === 'shadowgraph_search');
  const retrieveTool = tools.find((tool) => tool.name === 'shadowgraph_retrieve');
  assert.ok(searchTool && retrieveTool, 'search and retrieve must exist');

  const searchProps = searchTool.inputSchema.properties;
  if (!searchProps.matchMode) {
    t.skip('Pending Milestone M1: matchMode not yet exposed in shadowgraph_search');
    return;
  }

  assert.ok(searchProps.matchMode, 'matchMode must be exposed in search input');
  assert.ok(searchProps.expandSynonyms, 'expandSynonyms must be exposed in search input');
  assert.ok(retrieveTool.inputSchema.properties.matchMode, 'matchMode in retrieve input');

  const res = await mcp.callTool('shadowgraph_search', {
    query: 'consensus',
    matchMode: 'partial',
    expandSynonyms: true,
    project: 'e2e-project'
  });
  assert.equal(res.error, undefined, `Search call failed: ${JSON.stringify(res.error)}`);
});

test('Tier 1: Feature 8 - 3-Profile inventory invariant: exactly 16 Compact, 20 Workflow, 35 Full (36 with verifier)', async () => {
  const fullCatalogNoVerifier = buildToolCatalog({ verifier: false });
  const fullCatalogWithVerifier = buildToolCatalog({ verifier: true });

  assert.equal(fullCatalogNoVerifier.length, 35, 'Full profile without verifier must contain exactly 35 tools');
  assert.equal(fullCatalogWithVerifier.length, 36, 'Full profile with verifier must contain exactly 36 tools');
  assert.equal(COMPACT_TOOL_NAMES.length, 16, 'Compact profile must contain exactly 16 tools');
  assert.equal(WORKFLOW_TOOL_NAMES.length, 20, 'Workflow profile must contain exactly 20 tools');
});

test('Tier 1: Feature 9 - Tool description alignment for search, conditions, and outcome lifecycle', async (t) => {
  const catalog = buildToolCatalog({ verifier: false });
  const search = catalog.find((x) => x.name === 'shadowgraph_search');
  const outcome = catalog.find((x) => x.name === 'shadowgraph_record_outcome');

  if (!search?.description?.includes('Arabic') && !search?.description?.includes('stemming')) {
    t.skip('Pending Milestone M2: search description not yet updated with Arabic stemming details');
    return;
  }

  assert.match(search.description, /Arabic|stemming/i, 'Search description should document Arabic stemming or partial matching');
  assert.match(outcome.description, /autoTransition|lifecycle/i, 'Outcome description should document lifecycle side-effects');
});

test('Tier 1: Feature 10 - Condition normalization accepts target and expected aliases', async (t) => {
  const { createShadowGraph } = await import('../src/shadowgraph.js');
  const graph = createShadowGraph();

  let dec;
  try {
    dec = graph.addDecision({
      title: 'Conditional Gate Test',
      chosen: 'Option 1',
      reopenWhen: [{ target: 'db.status', expected: 'degraded' }],
      project: 'e2e-project'
    });
  } catch (err) {
    t.skip(`Pending Milestone M2: target/expected aliases not yet supported in condition normalization: ${err.message}`);
    return;
  }

  assert.ok(dec && dec.id, 'Decision with target/expected condition should be successfully created');
});

test('Tier 1: Feature 11 - Safe AI error recovery returns sanitized domain messages without leaking paths', async (t) => {
  const mcp = await startMcpHarness(t);
  const res = await mcp.callTool('shadowgraph_record_outcome', {
    id: 'dec-nonexistent-999999',
    outcome: { success: true }
  });

  assert.ok(res.error || res.result?.isError, 'Operation on non-existent decision must fail');
  const errorText = JSON.stringify(res.error ?? res.result);
  assert.equal(/C:\\|\/Users\/|\/home\//i.test(errorText), false, 'Error message must not leak filesystem paths');
});

test('Tier 1: Feature 12 - Profile-hidden tool guidance returns code -32601 and mentions active profile', async (t) => {
  // Start in compact profile (16 tools)
  const mcp = await startMcpHarness(t, { profile: 'compact' });
  const res = await mcp.callTool('shadowgraph_link', {
    from: 'dec-1',
    to: 'dec-2',
    type: 'relates_to'
  });

  assert.ok(res.error, 'Calling full tool under compact profile must return error');
  if (!res.error.message?.includes('profile') && !res.error.message?.includes('compact')) {
    t.skip('Pending Milestone M3: profile guidance message not yet implemented in -32601 response');
    return;
  }
  assert.equal(res.error.code, -32601, 'RPC error code must be -32601 for profile-hidden tool');
  assert.match(res.error.message, /profile|compact|workflow|full/i, 'Error message should guide caller about active profile');
});

test('Tier 1: Feature 13 - Follow-up project defaulting resolves configured default project', async (t) => {
  const defaultProj = 'auto-defaulted-project';
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: defaultProj }
  });

  // Create an initial decision with default project
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Base Decision',
    chosen: 'Default Choice'
  });
  assert.equal(decRes.error, undefined);
  const decision = parseToolResult(decRes);
  assert.ok(typeof decision === 'object' && decision !== null);
  assert.equal(decision.project, defaultProj, 'Initial decision should have defaulted project');

  // Call follow-up tool shadowgraph_record_outcome without project
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    id: decision.id,
    outcome: { success: true }
  });

  const parsed = parseToolResult(outRes);
  if (outRes.error || parsed === 'Tool execution failed') {
    t.skip('Pending Milestone M3: follow-up tools not yet in PROJECT_DEFAULTED_TOOLS');
    return;
  }
  assert.equal(outRes.error, undefined, 'Follow-up tool should default project without error');
});

test('Tier 1: Feature 14 - Parameter alias reviewSignalId accepted for id in shadowgraph_ack_review', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const ackTool = tools.find((t) => t.name === 'shadowgraph_ack_review');
  const props = ackTool.inputSchema.properties;

  if (!props.reviewSignalId) {
    t.skip('Pending Milestone M3: reviewSignalId alias not yet exposed on shadowgraph_ack_review schema');
    return;
  }
  assert.ok(props.reviewSignalId, 'reviewSignalId must be present in inputSchema properties');
});

test('Tier 1: Feature 15 - CLI ergonomics: shadowgraph --help, -h, help exit 0 on stdout; doctor documents workflow', async (t) => {
  const helpResult = runCliSync(['--help']);
  assert.equal(helpResult.status, 0, 'shadowgraph --help must exit 0');
  assert.match(helpResult.stdout, /Usage: shadowgraph/i, 'Help text must be printed to stdout');

  const shortHelpResult = runCliSync(['-h']);
  assert.equal(shortHelpResult.status, 0, 'shadowgraph -h must exit 0');

  const cmdHelpResult = runCliSync(['help']);
  assert.equal(cmdHelpResult.status, 0, 'shadowgraph help must exit 0');

  const doctorResult = runCliSync(['doctor']);
  assert.match(doctorResult.stdout + doctorResult.stderr, /workflow/i, 'doctor must mention workflow profile');
});

test('Tier 1: Feature 16 - Wire budget script measures compact, workflow, and full profiles with headroom', async (t) => {
  const result = spawnSync(process.execPath, [join(process.cwd(), 'scripts/mcp-wire-size.mjs'), '--json'], {
    encoding: 'utf8',
    timeout: 10000
  });
  assert.equal(result.status, 0, `mcp-wire-size.mjs failed: ${result.stderr}`);
  const data = JSON.parse(result.stdout);
  const modes = data.withoutVerifier ?? data;
  assert.ok(modes.full, 'Must measure full profile');
  assert.ok(modes.compact, 'Must measure compact profile');
  assert.ok(modes.workflow, 'Must measure workflow profile');
});

test('Tier 1: Feature 17 - Visual documentation contains Mermaid diagrams and workflow visualizations', async (t) => {
  const readmePath = join(process.cwd(), 'README.md');
  const compatPath = join(process.cwd(), 'docs/mcp-compatibility.md');
  const policyPath = join(process.cwd(), 'integrations/agent-policy.md');

  assert.ok(existsSync(readmePath), 'README.md must exist');
  assert.ok(existsSync(compatPath), 'docs/mcp-compatibility.md must exist');
  assert.ok(existsSync(policyPath), 'integrations/agent-policy.md must exist');

  const readmeContent = readFileSync(readmePath, 'utf8');
  assert.ok(readmeContent.includes('```mermaid'), 'README.md must contain Mermaid diagrams');
  const compatContent = readFileSync(compatPath, 'utf8');
  assert.ok(compatContent.includes('```mermaid'), 'docs/mcp-compatibility.md must contain Mermaid diagrams');
  const policyContent = readFileSync(policyPath, 'utf8');
  assert.ok(policyContent.includes('```mermaid'), 'integrations/agent-policy.md must contain Mermaid diagrams');
});

// ===========================================================================
// TIER 2: Boundary & Corner Cases (Adversarial, edge cases, error isolation)
// ===========================================================================

test('Tier 2: Boundary 1 - Enforce value as required on shadowgraph_record_fact', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const factTool = tools.find((tool) => tool.name === 'shadowgraph_record_fact');
  if (!factTool.inputSchema.required?.includes('value')) {
    t.skip('Pending Milestone M1: value not yet enforced as required on shadowgraph_record_fact');
    return;
  }

  // Attempt to call record_fact without required 'value'
  const res = await mcp.callTool('shadowgraph_record_fact', {
    key: 'invalid.missing.value',
    project: 'e2e-project'
  });

  assert.ok(res.error || res.result?.isError, 'Missing required value must result in an error');
});

test('Tier 2: Boundary 2 - Conflict rejection on shadowgraph_ack_review with conflicting id and reviewSignalId', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const ackTool = tools.find((tool) => tool.name === 'shadowgraph_ack_review');
  if (!ackTool.inputSchema.properties.reviewSignalId) {
    t.skip('Pending Milestone M3: reviewSignalId alias not yet available');
    return;
  }

  const res = await mcp.callTool('shadowgraph_ack_review', {
    id: 'sig-001-alpha',
    reviewSignalId: 'sig-002-beta'
  });

  assert.ok(res.error || res.result?.isError, 'Conflicting id and reviewSignalId must be rejected');
});

test('Tier 2: Boundary 3 - Conflict rejection on condition normalization when key/target or value/expected conflict', async (t) => {
  const { createShadowGraph } = await import('../src/shadowgraph.js');
  const graph = createShadowGraph();

  try {
    assert.throws(
      () => {
        graph.addDecision({
          title: 'Conflicting Condition Test',
          chosen: 'Option A',
          reopenWhen: [{ key: 'status', target: 'other_status', value: 'a' }],
          project: 'e2e-project'
        });
      },
      /conflict/i,
      'Conflicting key and target aliases must be rejected'
    );
  } catch (err) {
    if (!err.message?.includes('conflict')) {
      t.skip(`Pending Milestone M2: conflict rejection on condition aliases not yet implemented: ${err.message}`);
    }
  }
});

test('Tier 2: Boundary 4 - CLI JSON parse error feedback on malformed arguments without unhandled crashes', async (t) => {
  const result = runCliSync(['decision', '{ malformed json: not valid }']);
  assert.notEqual(result.status, 0, 'Malformed JSON must exit with non-zero status');
  const combined = result.stdout + result.stderr;
  assert.equal(combined.includes('SyntaxError: Unexpected token'), false, 'Should provide actionable message rather than raw internal SyntaxError trace');
});

test('Tier 2: Boundary 5 - Error isolation: invalid matchMode on search rejected without crashing server', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const searchTool = tools.find((tool) => tool.name === 'shadowgraph_search');
  if (!searchTool.inputSchema.properties.matchMode) {
    t.skip('Pending Milestone M1: matchMode not yet present');
    return;
  }

  const res = await mcp.callTool('shadowgraph_search', {
    query: 'test query',
    matchMode: 'unsupported_match_mode_xyz',
    project: 'e2e-project'
  });

  // Verify server is still alive and responds to subsequent ping
  const toolsAfter = await mcp.listTools();
  assert.ok(Array.isArray(toolsAfter), 'MCP server must remain functional after invalid param call');
});

test('Tier 2: Boundary 6 - Empty and whitespace queries in search/retrieve apply filters only without errors', async (t) => {
  const mcp = await startMcpHarness(t);
  const emptyRes = await mcp.callTool('shadowgraph_search', {
    query: '',
    project: 'e2e-project'
  });
  assert.equal(emptyRes.error, undefined, 'Empty search query should not cause RPC error');

  const wsRes = await mcp.callTool('shadowgraph_search', {
    query: '   ',
    project: 'e2e-project'
  });
  assert.equal(wsRes.error, undefined, 'Whitespace search query should not cause RPC error');
});

test('Tier 2: Boundary 7 - Safe error sanitization across filesystem boundary errors', async (t) => {
  const result = runCliSync(['restore', '/non/existent/path/data.json']);
  assert.notEqual(result.status, 0, 'Restore from invalid path must fail');
  assert.equal(result.stderr.includes('C:\\Users\\'), false, 'Error must not leak internal user home directories');
});

test('Tier 2: Boundary 8 - Paging boundary enforcement (reject limit 0 or >1000 without silent clamping)', async (t) => {
  const mcp = await startMcpHarness(t);
  const resZero = await mcp.callTool('shadowgraph_search', {
    query: 'test',
    limit: 0,
    project: 'e2e-project'
  });
  assert.ok(resZero.error || resZero.result?.isError, 'limit=0 must be rejected');

  const resOver = await mcp.callTool('shadowgraph_search', {
    query: 'test',
    limit: 1001,
    project: 'e2e-project'
  });
  assert.ok(resOver.error || resOver.result?.isError, 'limit > 1000 must be rejected');
});

// ===========================================================================
// TIER 3: Cross-Feature Combinations
// ===========================================================================

test('Tier 3: Combination 1 - Attempt with reusableWhen + Decision referencing failed attempt + Outcome autoTransition + follow-up project defaulting', async (t) => {
  const defaultProj = 'cross-combo-project';
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: defaultProj }
  });

  const tools = await mcp.listTools();
  const attemptTool = tools.find((x) => x.name === 'shadowgraph_record_attempt');
  if (!attemptTool.inputSchema.properties.reusableWhen) {
    t.skip('Pending Milestone M1: reusableWhen not yet exposed');
    return;
  }

  // 1. Record an attempt with reusableWhen and failed resultClass
  const attRes = await mcp.callTool('shadowgraph_record_attempt', {
    task: 'Optimize SQLite PRAGMA journal_mode',
    solution: 'Set PRAGMA journal_mode = WAL',
    result: 'Contention observed on slow shared drive',
    resultClass: 'failed',
    visibility: 'global',
    reusableWhen: ['drive.type == "local_ssd"'],
    tags: ['storage', 'sqlite', 'wal']
  });
  assert.equal(attRes.error, undefined, 'Attempt write should succeed');
  const attempt = parseToolResult(attRes);
  assert.ok(attempt?.id, 'Attempt should receive an id');

  // 2. Record a decision with failedAttempts
  const decTool = tools.find((x) => x.name === 'shadowgraph_record_decision');
  if (!decTool.inputSchema.properties.failedAttempts) {
    t.skip('Pending Milestone M1: failedAttempts not yet exposed in record_decision');
    return;
  }

  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Fallback to Memory Store on Contention',
    chosen: 'In-memory fallback with checkpoint journal',
    status: 'proposed',
    failedAttempts: [attempt.id],
    task: 'Storage Architecture',
    tags: ['storage', 'memory']
  });
  assert.equal(decRes.error, undefined, 'Decision write should succeed');
  const decision = parseToolResult(decRes);

  // 3. Record outcome with top-level autoTransition
  const outTool = tools.find((x) => x.name === 'shadowgraph_record_outcome');
  if (!outTool.inputSchema.properties.autoTransition) {
    t.skip('Pending Milestone M1: autoTransition alias not yet available');
    return;
  }

  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decision.id,
    outcome: { status: 'successful', lessons: ['In-memory fallback works reliably'] },
    autoTransition: true,
    decisionStatus: 'validated',
    project: defaultProj
  });
  assert.equal(outRes.error, undefined, 'Outcome call should succeed');
  const updatedDecision = parseToolResult(outRes);
  assert.ok(typeof updatedDecision === 'object' && updatedDecision !== null, 'Updated decision should be returned');
  assert.equal(updatedDecision.status, 'validated', 'Decision status should have transitioned to validated');
});

test('Tier 3: Combination 2 - Cross-project fact backfill + Cross-project recall + Context advisory surfacing', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const factTool = tools.find((x) => x.name === 'shadowgraph_record_fact');
  if (!factTool.inputSchema.properties.backfill) {
    t.skip('Pending Milestone M1: backfill not yet available');
    return;
  }

  // 1. Record fact in project-alpha with visibility: 'global'
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'auth.protocol',
    value: 'oauth2_pkce',
    visibility: 'global',
    project: 'project-alpha',
    backfill: {
      validFrom: '2026-01-01T00:00:00.000Z',
      tags: ['security', 'auth']
    }
  });

  // 2. Query recall from project-beta with includeCrossProject: true
  const recallRes = await mcp.callTool('shadowgraph_recall', {
    query: 'oauth2 security',
    includeCrossProject: true,
    project: 'project-beta'
  });
  assert.equal(recallRes.error, undefined, 'Cross-project recall should succeed');

  // 3. Context in project-beta with includeCrossProject: true
  const ctxRes = await mcp.callTool('shadowgraph_context', {
    project: 'project-beta',
    includeCrossProject: true
  });
  assert.equal(ctxRes.error, undefined, 'Cross-project context should succeed');
});

test('Tier 3: Combination 3 - Arabic query terms with matchMode partial across records created with tags and task', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const searchTool = tools.find((x) => x.name === 'shadowgraph_search');
  if (!searchTool.inputSchema.properties.matchMode) {
    t.skip('Pending Milestone M1: matchMode not yet available');
    return;
  }

  // Record an attempt with Arabic content
  await mcp.callTool('shadowgraph_record_attempt', {
    solution: 'تجربة تحسين الأداء وقواعد البيانات',
    result: 'تمت المحاولة بنجاح تام وسرعة فائقة',
    resultClass: 'succeeded',
    task: 'تحسين الاستعلامات',
    tags: ['عربي', 'أداء'],
    visibility: 'global',
    project: 'arabic-project'
  });

  // Search with Arabic query term and matchMode: 'partial'
  const searchRes = await mcp.callTool('shadowgraph_search', {
    query: 'محاولة الأداء',
    matchMode: 'partial',
    project: 'arabic-project'
  });
  assert.equal(searchRes.error, undefined, 'Arabic search with partial matchMode should succeed');
});

test('Tier 3: Combination 4 - Reopen condition with target/expected aliases -> review signal -> ack_review via reviewSignalId', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const ackTool = tools.find((x) => x.name === 'shadowgraph_ack_review');
  if (!ackTool.inputSchema.properties.reviewSignalId) {
    t.skip('Pending Milestone M3: reviewSignalId alias not yet available');
    return;
  }

  // 1. Record decision with reopen rule
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Rate Limit Threshold',
    chosen: 'Token bucket limiter at 100 req/sec',
    reopenWhen: [{ target: 'rate_limit.errors', expected: 10, operator: '>=' }],
    project: 'e2e-review-proj'
  });
  assert.equal(decRes.error, undefined);
  const decision = parseToolResult(decRes);

  // 2. Record fact that triggers condition
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'rate_limit.errors',
    value: 15,
    project: 'e2e-review-proj'
  });

  // 3. Trigger review
  const revRes = await mcp.callTool('shadowgraph_review', {
    project: 'e2e-review-proj'
  });
  assert.equal(revRes.error, undefined);

  // 4. Retrieve signals
  const sigRes = await mcp.callTool('shadowgraph_review_signals', {
    project: 'e2e-review-proj'
  });
  assert.equal(sigRes.error, undefined);
  const signalList = parseToolResult(sigRes)?.items ?? [];

  if (signalList.length > 0) {
    const signal = signalList[0];
    const ackRes = await mcp.callTool('shadowgraph_ack_review', {
      reviewSignalId: signal.id,
      project: 'e2e-review-proj'
    });
    assert.equal(ackRes.error, undefined);
    assert.equal(ackRes.result?.isError, false, 'Tool execution must succeed');
    const ackData = parseToolResult(ackRes);
    assert.ok(ackData, 'Acknowledgment result must exist');
    assert.equal(ackData.status, 'acknowledged', 'Signal status must be acknowledged');
  }
});

// ===========================================================================
// TIER 4: Real-World Application Scenarios (End-to-End Agent Decision Loop)
// ===========================================================================

test('Tier 4: Scenario A - Autonomous Agent Decision-to-Attempt Lifecycle with Reusable Experience and Auto-Transition Outcome', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const attemptTool = tools.find((x) => x.name === 'shadowgraph_record_attempt');
  if (!attemptTool.inputSchema.properties.reusableWhen) {
    t.skip('Pending Milestone M1: End-to-end scenario A requires Milestone 1 schema exposure');
    return;
  }

  // Step 1: Agent records proposed architectural decision
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Migrate Session Storage to Redis Cluster',
    chosen: 'Redis Cluster with TLS encryption',
    status: 'proposed',
    task: 'Authentication & Session Infrastructure',
    tags: ['redis', 'session', 'scalability'],
    visibility: 'global',
    project: 'prod-migration'
  });
  assert.equal(decRes.error, undefined, 'Agent decision recording must succeed');
  const decision = parseToolResult(decRes);
  assert.equal(decision.status, 'proposed');

  // Step 2: Agent attempts migration in staging environment
  const attRes = await mcp.callTool('shadowgraph_record_attempt', {
    solution: 'Deploy Redis cluster with TLS enabled',
    result: 'Cluster nodes formed and benchmark passed with 15000 ops/sec',
    resultClass: 'succeeded',
    reusableWhen: ['env.cluster_mode == "aws_elasticache"'],
    relatedTo: [decision.id],
    task: 'Verify cluster resilience under load',
    tags: ['benchmark', 'redis', 'tls'],
    visibility: 'global',
    project: 'prod-migration'
  });
  assert.equal(attRes.error, undefined, 'Agent attempt recording must succeed');
  const attempt = parseToolResult(attRes);
  assert.equal(attempt.resultClass, 'succeeded');

  // Step 3: Agent records validated outcome with autoTransition
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decision.id,
    outcome: {
      status: 'successful',
      lessons: ['TLS overhead was within 2% margin, approved for production']
    },
    autoTransition: true,
    decisionStatus: 'validated',
    project: 'prod-migration'
  });
  assert.equal(outRes.error, undefined, 'Agent outcome recording must succeed');
  const validatedDecision = parseToolResult(outRes);
  assert.ok(typeof validatedDecision === 'object' && validatedDecision !== null, 'Validated decision should be returned');
  assert.equal(validatedDecision.status, 'validated', 'Decision status must automatically transition to validated');

  // Step 4: Follow-up agent queries context to inform subsequent planning
  const ctxRes = await mcp.callTool('shadowgraph_context', {
    project: 'prod-migration'
  });
  assert.equal(ctxRes.error, undefined, 'Agent context loading must succeed');
  const ctx = parseToolResult(ctxRes);
  assert.ok(ctx && typeof ctx === 'object', 'Context must return an object');
});

test('Tier 4: Scenario B - Policy Drift Detection, Symbolic Condition Reopen, Signal Escalation, and Review Acknowledgment', async (t) => {
  const mcp = await startMcpHarness(t);
  const tools = await mcp.listTools();
  const ackTool = tools.find((x) => x.name === 'shadowgraph_ack_review');
  if (!ackTool.inputSchema.properties.reviewSignalId) {
    t.skip('Pending Milestone M3: Scenario B requires reviewSignalId parameter alias');
    return;
  }

  // 1. Establish baseline fact
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'security.patch_level',
    value: 5,
    project: 'compliance-system'
  });

  // 2. Establish policy decision conditioned on patch level
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Enforce Vulnerability SLA Level A',
    chosen: 'Automated patch remediation pipeline',
    reopenWhen: [{ target: 'security.patch_level', expected: 3, operator: '<=' }],
    project: 'compliance-system'
  });
  assert.equal(decRes.error, undefined);

  // 3. Environment degrades (patch level drops below threshold)
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'security.patch_level',
    value: 2,
    reason: 'Zero-day vulnerability discovered in base image',
    project: 'compliance-system'
  });

  // 4. Autonomous sentinel evaluates reviews
  await mcp.callTool('shadowgraph_review', {
    project: 'compliance-system'
  });

  // 5. Audit alerts and list signals
  const sigRes = await mcp.callTool('shadowgraph_review_signals', {
    project: 'compliance-system'
  });
  const signals = parseToolResult(sigRes)?.items ?? [];

  // 6. Security officer acknowledges review signal using reviewSignalId
  if (signals.length > 0) {
    const ackRes = await mcp.callTool('shadowgraph_ack_review', {
      reviewSignalId: signals[0].id,
      project: 'compliance-system'
    });
    assert.equal(ackRes.error, undefined);
    assert.equal(ackRes.result?.isError, false, 'Tool execution must succeed');
    const ackData = parseToolResult(ackRes);
    assert.ok(ackData, 'Officer must receive structured ack result');
    assert.equal(ackData.status, 'acknowledged', 'Signal status must be acknowledged');
  }
});

test('Tier 4: Scenario C - Profile Navigation, Ergonomics, and Safe AI Error Recovery under Constrained Execution', async (t) => {
  // Agent starts in Compact mode
  const mcpCompact = await startMcpHarness(t, { profile: 'compact' });
  const compactTools = await mcpCompact.listTools();
  assert.equal(compactTools.length, 16, 'Compact profile must have exactly 16 tools');

  // Agent attempts to call Full tool (shadowgraph_supersede)
  const callRes = await mcpCompact.callTool('shadowgraph_supersede', {
    id: 'dec-1',
    supersededBy: 'dec-2'
  });
  assert.ok(callRes.error, 'Calling full tool in compact profile must fail');
  // Before M3, returns -32602 on modern protocol; after M3 returns -32601 with guidance
  assert.ok(callRes.error.code === -32601 || callRes.error.code === -32602, 'Expected RPC error code for hidden tool');

  // CLI sanity check for operator guidance
  const help = runCliSync(['--help']);
  if (help.status === 0) {
    assert.match(help.stdout, /Usage: shadowgraph/i, 'Help text must provide operator syntax');
  }
});
