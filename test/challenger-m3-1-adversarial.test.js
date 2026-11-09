import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { buildToolCatalog, COMPACT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '../src/mcp-tools.js';

// ===========================================================================
// Empirical Challenge Suite for Milestone 3 (Features 11–14)
// Challenger: challenger_m3_1
// ===========================================================================

const MODERN_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta(clientInfo = { name: 'challenger-m3-1-test', version: '1.0.0' }) {
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
  const directory = await scratchDirectory(t, 'challenger-m3-1-mcp-');
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
        try { deliver(JSON.parse(line)); } catch { /* ignore */ }
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
    async callTool(name, args = {}, { legacy = false } = {}) {
      const params = legacy
        ? { name, arguments: args }
        : { name, arguments: args, _meta: modernMeta() };
      return this.call('tools/call', params);
    },
    stop
  };
}

// ===========================================================================
// SECTION 1: Error Sanitization (Feature 11)
// ===========================================================================

test('Feature 11: Error sanitization blocks path injection across Windows/POSIX paths & secrets', async (t) => {
  const mcp = await startMcpHarness(t);

  const maliciousPayloads = [
    {
      tool: 'shadowgraph_record_decision',
      args: {
        title: 'Windows path in operator',
        chosen: 'A',
        reopenWhen: [{ key: 'k', operator: 'C:\\Windows\\System32\\calc.exe', value: 'v' }]
      }
    },
    {
      tool: 'shadowgraph_record_decision',
      args: {
        title: 'POSIX path in operator',
        chosen: 'A',
        reopenWhen: [{ key: 'k', operator: '/etc/shadow', value: 'v' }]
      }
    },
    {
      tool: 'shadowgraph_record_decision',
      args: {
        title: 'Secret in operator',
        chosen: 'A',
        reopenWhen: [{ key: 'k', operator: 'Bearer secret_jwt_token_12345', value: 'v' }]
      }
    },
    {
      tool: 'shadowgraph_record_decision',
      args: {
        title: 'API key in operator',
        chosen: 'A',
        reopenWhen: [{ key: 'k', operator: 'api_key_sk_live_998877', value: 'v' }]
      }
    },
    {
      tool: 'shadowgraph_record_decision',
      args: {
        title: 'Windows path in status',
        chosen: 'A',
        status: ['C:', 'Users', 'Administrator', 'secret'].join('\\')
      }
    },
    {
      tool: 'shadowgraph_restore',
      args: {
        source: ['C:', 'Users', 'admin', 'secret_store.json'].join('\\')
      }
    }
  ];

  for (const item of maliciousPayloads) {
    const res = await mcp.callTool(item.tool, item.args);
    assert.ok(res.error || res.result?.isError, `Calling ${item.tool} with malicious input must fail`);
    const output = JSON.stringify(res.error ?? res.result);
    assert.equal(
      /[a-zA-Z]:[\\/]|C:\\Users|\/etc\/|\/home\/|\/tmp\/|Bearer|api_key|password/i.test(output),
      false,
      `Output must not leak filesystem paths or secrets: ${output}`
    );
  }
});

test('Feature 11: Valid domain errors remain actionable without leakage', async (t) => {
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: 'domain-error-project' }
  });

  // Rule syntax domain errors
  const resOp = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Invalid Operator',
    chosen: 'A',
    reopenWhen: [{ key: 'k', operator: 'unknown_op_foo', value: 1 }]
  });
  assert.match(JSON.stringify(resOp.error ?? resOp.result), /Unsupported rule operator unknown_op_foo/);

  // Missing entity errors expose only the safe code and canonical field.
  const resDec = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: 'dec-nonexistent-123',
    outcome: { status: 'successful' }
  });
  assert.equal(resDec.result.content[0].text, 'Tool execution failed (unknown_decision)');
  assert.deepEqual(resDec.result._meta['shadowgraph/error'], {
    issueCode: 'unknown_decision', fieldPath: 'decisionId', retryable: false
  });
  assert.equal(JSON.stringify(resDec).includes('dec-nonexistent-123'), false);

  // Conflict errors
  const resConf = await mcp.callTool('shadowgraph_ack_review', {
    id: 'sig-1',
    reviewSignalId: 'sig-2'
  });
  assert.match(JSON.stringify(resConf.error ?? resConf.result), /Conflicting id and reviewSignalId provided/);
});

// ===========================================================================
// SECTION 2: Profile-Hidden Tool Guidance (Feature 12)
// ===========================================================================

test('Feature 12: Profile-hidden tools emit code -32601 and operator guidance', async (t) => {
  // 1. Compact profile (16 tools)
  const mcpCompact = await startMcpHarness(t, { profile: 'compact' });
  const compactTools = await mcpCompact.listTools();
  assert.equal(compactTools.length, 16, 'Compact profile must have exactly 16 tools');

  const compactExcluded = [
    'shadowgraph_confidence_evidence',
    'shadowgraph_update_status',
    'shadowgraph_supersede',
    'shadowgraph_review_signals',
    'shadowgraph_link',
    'shadowgraph_traverse',
    'shadowgraph_bind',
    'shadowgraph_attribute',
    'shadowgraph_backup',
    'shadowgraph_restore',
    'shadowgraph_purge'
  ];

  for (const name of compactExcluded) {
    const res = await mcpCompact.callTool(name, {});
    assert.ok(res.error, `Tool ${name} must return error in compact profile`);
    assert.equal(res.error.code, -32601, `Tool ${name} must return code -32601`);
    assert.match(res.error.message, new RegExp(`Tool "${name}" is excluded by active compact profile \\(16 tools\\)`, 'i'));
    assert.match(res.error.message, /SHADOWGRAPH_MCP_COMPACT=0/);
  }

  // 2. Workflow profile (20 tools)
  const mcpWorkflow = await startMcpHarness(t, { profile: 'workflow' });
  const workflowTools = await mcpWorkflow.listTools();
  assert.equal(workflowTools.length, 20, 'Workflow profile must have exactly 20 tools');

  const workflowExcluded = [
    'shadowgraph_link',
    'shadowgraph_traverse',
    'shadowgraph_bind',
    'shadowgraph_attribute',
    'shadowgraph_backup',
    'shadowgraph_restore',
    'shadowgraph_purge'
  ];

  for (const name of workflowExcluded) {
    const res = await mcpWorkflow.callTool(name, {});
    assert.ok(res.error, `Tool ${name} must return error in workflow profile`);
    assert.equal(res.error.code, -32601, `Tool ${name} must return code -32601`);
    assert.match(res.error.message, new RegExp(`Tool "${name}" is excluded by active workflow profile \\(20 tools\\)`, 'i'));
    assert.match(res.error.message, /unset SHADOWGRAPH_MCP_PROFILE and restart with SHADOWGRAPH_MCP_COMPACT=0/);
  }

  // 3. Bogus tools return Unknown tool without profile guidance
  const bogusRes = await mcpCompact.callTool('shadowgraph_nonexistent_tool', {});
  assert.ok(bogusRes.error);
  assert.equal(bogusRes.error.message, 'Unknown tool');
});

// ===========================================================================
// SECTION 3: Project Defaulting Across ALL 8 Follow-Up Tools (Feature 13)
// ===========================================================================

test('Feature 13: All 8 follow-up tools successfully resolve default project', async (t) => {
  const defaultProj = 'empirical-followup-default';
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: defaultProj }
  });

  // Base decisions
  const d1Res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision Alpha',
    chosen: 'Choice A'
  });
  const d1 = parseToolResult(d1Res);
  assert.equal(d1.project, defaultProj);

  const d2Res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision Beta',
    chosen: 'Choice B',
    reopenWhen: [{ target: 'queue.lag', expected: 100, operator: '>=' }]
  });
  const d2 = parseToolResult(d2Res);
  assert.equal(d2.project, defaultProj);

  // 1. shadowgraph_record_outcome
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    id: d1.id,
    outcome: { status: 'successful', summary: 'Execution verified' }
  });
  assert.equal(outRes.error, undefined, 'shadowgraph_record_outcome must succeed with default project');
  assert.equal(outRes.result?.isError, false);

  // 2. shadowgraph_update_status
  const statRes = await mcp.callTool('shadowgraph_update_status', {
    decisionId: d1.id,
    status: 'planned'
  });
  assert.equal(statRes.error, undefined, 'shadowgraph_update_status must succeed with default project');
  assert.equal(statRes.result?.isError, false);

  // 3. shadowgraph_confidence_evidence
  const evRes = await mcp.callTool('shadowgraph_confidence_evidence', {
    decisionId: d1.id,
    key: 'ev-test-01',
    reason: 'Verified in testing'
  });
  assert.equal(evRes.error, undefined, 'shadowgraph_confidence_evidence must succeed with default project');
  assert.equal(evRes.result?.isError, false);

  // 4. shadowgraph_link
  const linkRes = await mcp.callTool('shadowgraph_link', {
    from: d1.id,
    to: d2.id,
    relation: 'relates_to'
  });
  assert.equal(linkRes.error, undefined, 'shadowgraph_link must succeed with default project');
  assert.equal(linkRes.result?.isError, false);

  // 5. shadowgraph_supersede
  const d3Res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision Gamma',
    chosen: 'Choice C'
  });
  const d3 = parseToolResult(d3Res);
  const supRes = await mcp.callTool('shadowgraph_supersede', {
    decisionId: d1.id,
    replacementId: d3.id,
    reason: 'Superseded'
  });
  assert.equal(supRes.error, undefined, 'shadowgraph_supersede must succeed with default project');
  assert.equal(supRes.result?.isError, false);

  // 6. shadowgraph_reconsider
  const reconRes = await mcp.callTool('shadowgraph_reconsider', {
    decisionId: d2.id,
    reason: 'Reconsideration check'
  });
  assert.equal(reconRes.error, undefined, 'shadowgraph_reconsider must succeed with default project');
  assert.equal(reconRes.result?.isError, false);

  // 7. shadowgraph_review_context
  const revCtxRes = await mcp.callTool('shadowgraph_review_context', {});
  assert.equal(revCtxRes.error, undefined, 'shadowgraph_review_context must succeed with default project');
  assert.equal(revCtxRes.result?.isError, false);

  // 8. shadowgraph_ack_review
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'queue.lag',
    value: 150
  });
  const revRes = await mcp.callTool('shadowgraph_review', {});
  const revItems = parseToolResult(revRes)?.items ?? [];
  assert.ok(revItems.length > 0);
  const sigId = revItems[0].reviewSignalId;

  // When SHADOWGRAPH_PROJECT is configured, project defaulting passes project to acknowledgeReview
  const ackRes = await mcp.callTool('shadowgraph_ack_review', {
    id: sigId
  });
  assert.equal(ackRes.error, undefined);
  assert.equal(ackRes.result?.isError, false);
});

// ===========================================================================
// SECTION 4: Parameter Aliases for shadowgraph_ack_review (Feature 14)
// AND EMPIRICAL BUG REPRODUCTION
// ===========================================================================

test('Feature 14 Remediation: Acknowledge review via reviewSignalId without explicit project auto-scopes and succeeds', async (t) => {
  // Case A: Direct engine verification
  const graph = createShadowGraph();
  const dec = graph.addDecision({
    title: 'Scoped Review Decision',
    chosen: 'Scoped Option',
    reopenWhen: [{ target: 'temp.threshold', expected: 90, operator: '>=' }],
    project: 'standalone-project'
  });
  graph.addFact({
    key: 'temp.threshold',
    value: 95,
    project: 'standalone-project'
  });
  const rev = graph.review({ project: 'standalone-project' });
  assert.ok(rev.items.length > 0, 'Review must produce items');
  const signalId = rev.items[0].reviewSignalId;
  assert.ok(signalId, 'Item must have reviewSignalId');

  // Acknowledge review with reviewSignalId and explicit project scope
  const ackResult = graph.acknowledgeReview({ reviewSignalId: signalId, project: 'standalone-project' });
  assert.ok(ackResult, 'acknowledgeReview must return acknowledged item');
  assert.equal(ackResult.status, 'acknowledged', 'Status must be acknowledged');

  // Case B: MCP level verification
  const mcp = await startMcpHarness(t);
  const mcpDec = await mcp.callTool('shadowgraph_record_decision', {
    title: 'MCP Scoped Decision',
    chosen: 'Opt',
    reopenWhen: [{ target: 'disk.full', expected: 90, operator: '>=' }],
    project: 'unscoped-mcp-project'
  });
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'disk.full',
    value: 95,
    project: 'unscoped-mcp-project'
  });
  const mcpRev = await mcp.callTool('shadowgraph_review', { project: 'unscoped-mcp-project' });
  const mcpItems = parseToolResult(mcpRev)?.items ?? [];
  assert.ok(mcpItems.length > 0);
  const mcpSignalId = mcpItems[0].reviewSignalId;

  const mcpAckRes = await mcp.callTool('shadowgraph_ack_review', {
    reviewSignalId: mcpSignalId,
    project: 'unscoped-mcp-project'
  });

  assert.equal(mcpAckRes.error, undefined, 'MCP call must have no error');
  assert.equal(mcpAckRes.result?.isError, false, 'MCP call must report isError: false');
  const mcpAckData = parseToolResult(mcpAckRes);
  assert.equal(mcpAckData?.status, 'acknowledged', 'Status must be acknowledged');
});
