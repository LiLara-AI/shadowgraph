import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { buildToolCatalog } from '../src/mcp-tools.js';

const MODERN_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta(clientInfo = { name: 'challenger-m3-deep-audit', version: '1.0.0' }) {
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
  const directory = await scratchDirectory(t, 'challenger-m3-audit-');
  const file = join(directory, 'data.json');
  const home = join(directory, 'home');
  mkdirSync(home, { recursive: true });

  const profileEnv = {};
  if (profile === 'compact') profileEnv.SHADOWGRAPH_MCP_COMPACT = '1';
  else if (profile === 'workflow') profileEnv.SHADOWGRAPH_MCP_PROFILE = 'workflow';
  else {
    profileEnv.SHADOWGRAPH_MCP_COMPACT = '0';
    profileEnv.SHADOWGRAPH_MCP_PROFILE = '';
  }

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
          reject(new Error(`Timeout waiting for ${label}. Stderr: ${stderr}`));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  }

  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + '\n');
  }

  async function callTool(name, args = {}, meta = modernMeta()) {
    const id = reqCounter++;
    send({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: meta
      }
    });
    return waitFor((msg) => msg.id === id, `tool call ${name}`);
  }

  t.after(async () => {
    try {
      child.stdin.end();
      child.kill('SIGTERM');
    } catch { /* ignore */ }
  });

  return { callTool, send, waitFor };
}

// ---------------------------------------------------------------------------
// TEST 1: acknowledgeReview engine auto-scoping and absence of ReferenceError
// ---------------------------------------------------------------------------
test('Deep Audit 1: Engine acknowledgeReview with reviewSignalId auto-scopes without ReferenceError', () => {
  const graph = createShadowGraph();
  const proj = 'deep-audit-proj-alpha';

  // Record decision with reopen condition
  const dec = graph.addDecision({
    title: 'Engine Auto-Scope Decision',
    chosen: 'Option Alpha',
    reopenWhen: [{ target: 'memory.pressure', expected: 80, operator: '>=' }],
    project: proj
  });

  // Record fact that satisfies reopen condition
  graph.addFact({
    key: 'memory.pressure',
    value: 90,
    project: proj
  });

  // Evaluate review
  const reviewResult = graph.review({ project: proj });
  assert.ok(reviewResult.items.length > 0, 'Review must produce review item');
  const signalId = reviewResult.items[0].reviewSignalId;
  assert.ok(signalId, 'Item must possess reviewSignalId');

  // Verify acknowledgeReview with { reviewSignalId } and NO project:
  // Must NOT throw ReferenceError: decisions is not defined.
  // Must auto-scope project from dec.project and return acknowledged signal.
  const ack = graph.acknowledgeReview({ reviewSignalId: signalId });
  assert.equal(ack.id, signalId, 'Acknowledged item ID matches signal ID');
  assert.equal(ack.status, 'acknowledged', 'Status must transition to acknowledged');
  assert.ok(typeof ack.acknowledgedAt === 'number' || typeof ack.acknowledgedAt === 'string', 'acknowledgedAt must be populated');
  assert.equal(ack.decisionId, dec.id, 'decisionId matches the source decision');

  // Verify cross-project isolation: caller specifying an incorrect explicit project fails boundary check
  assert.throws(
    () => {
      graph.acknowledgeReview({ reviewSignalId: signalId, project: 'mismatched-foreign-project' });
    },
    /Review signal not found/,
    'Explicit foreign project must not allow acknowledging a signal from another project'
  );
});

// ---------------------------------------------------------------------------
// TEST 2: shadowgraph_ack_review MCP schema and tool execution
// ---------------------------------------------------------------------------
test('Deep Audit 2: MCP shadowgraph_ack_review accepts reviewSignalId without schema violation', async (t) => {
  const mcp = await startMcpHarness(t);
  const proj = 'mcp-ack-test-proj';

  // Seed decision, fact, and trigger signal
  await mcp.callTool('shadowgraph_record_decision', {
    title: 'MCP Ack Decision',
    chosen: 'Chosen Alpha',
    reopenWhen: [{ target: 'cpu.temperature', expected: 75, operator: '>=' }],
    project: proj
  });
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'cpu.temperature',
    value: 85,
    project: proj
  });
  const reviewRes = await mcp.callTool('shadowgraph_review', { project: proj });
  const reviewItems = parseToolResult(reviewRes)?.items ?? [];
  assert.ok(reviewItems.length > 0, 'Review items must be produced');
  const signalId = reviewItems[0].reviewSignalId;

  // 1. Call with ONLY reviewSignalId (no id, no project)
  const ackRes = await mcp.callTool('shadowgraph_ack_review', {
    reviewSignalId: signalId
  });
  assert.equal(ackRes.error, undefined, 'Must not return JSON-RPC error');
  assert.equal(ackRes.result?.isError, false, 'isError must be false');
  const ackPayload = parseToolResult(ackRes);
  assert.equal(ackPayload.id, signalId, 'Result id must match signalId');
  assert.equal(ackPayload.status, 'acknowledged', 'Result status must be acknowledged');

  // 2. Schema check: verify inputSchema for shadowgraph_ack_review does not require 'id'
  const catalog = buildToolCatalog({ profile: 'full' });
  const ackTool = catalog.find((tool) => tool.name === 'shadowgraph_ack_review');
  assert.ok(ackTool, 'Tool must be in catalog');
  assert.ok(!ackTool.inputSchema?.required || !ackTool.inputSchema.required.includes('id'),
    'inputSchema must NOT require id');
});

// ---------------------------------------------------------------------------
// TEST 3: UNC network paths and backslash traversals in error sanitization
// ---------------------------------------------------------------------------
test('Deep Audit 3: UNC network paths and backslash path traversals are masked without leaks', async (t) => {
  const mcp = await startMcpHarness(t);

  const adversarialStatuses = [
    '\\\\server\\share\\secrets.txt',
    '\\\\192.168.0.1\\admin$\\config',
    '..\\..\\Windows\\System32',
    'C:\\Windows\\secret.json',
    '\\Windows\\System32\\drivers',
    '\\etc\\passwd',
    '/etc/shadow',
    'Users\\administrator\\id_rsa',
    'bearer secret_token_xyz_123',
    'password=admin12345'
  ];

  // First seed a real decision to test both shadowgraph_record_decision and shadowgraph_update_status
  const seedRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Sanitization Base Decision',
    chosen: 'Chosen Base',
    project: 'sanitization-proj'
  });
  const decisionId = parseToolResult(seedRes)?.id;
  assert.ok(decisionId, 'Decision ID must be created');

  for (const status of adversarialStatuses) {
    // Test via record_decision
    const recRes = await mcp.callTool('shadowgraph_record_decision', {
      title: 'Adversarial Decision',
      chosen: 'Test',
      status,
      project: 'sanitization-proj'
    });
    const parsedRec = parseToolResult(recRes);
    const recMessage = typeof parsedRec === 'string' ? parsedRec : recRes.error?.message ?? recRes.result?.content?.[0]?.text;
    assert.equal(recMessage, 'Tool execution failed',
      `Adversarial record status "${status}" must be masked to generic "Tool execution failed"`);
    assert.ok(!JSON.stringify(recRes).includes(status),
      `record_decision response must NEVER leak payload: ${status}`);

    // Test via update_status
    const updateRes = await mcp.callTool('shadowgraph_update_status', {
      decisionId,
      status,
      project: 'sanitization-proj'
    });
    const parsedUpdate = parseToolResult(updateRes);
    const updateMessage = typeof parsedUpdate === 'string' ? parsedUpdate : updateRes.error?.message ?? updateRes.result?.content?.[0]?.text;
    assert.equal(updateMessage, 'Tool execution failed',
      `Adversarial update status "${status}" must be masked to generic "Tool execution failed"`);
    assert.ok(!JSON.stringify(updateRes).includes(status),
      `update_status response must NEVER leak payload: ${status}`);
  }

  // Confirm legitimate domain errors without paths or secrets are preserved
  const validDomainErrorRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Clean Domain Error Decision',
    chosen: 'Test',
    status: 'completely_custom_status_without_paths',
    project: 'sanitization-proj'
  });
  const validParsed = parseToolResult(validDomainErrorRes);
  const validMessage = typeof validParsed === 'string' ? validParsed : validDomainErrorRes.result?.content?.[0]?.text;
  assert.match(validMessage, /^Invalid decision status: completely_custom_status_without_paths$/,
    'Legitimate domain validation messages must be preserved when clean');

  const validUpdateErrorRes = await mcp.callTool('shadowgraph_update_status', {
    decisionId,
    status: 'clean_nonexistent_status_value',
    project: 'sanitization-proj'
  });
  const validUpdateParsed = parseToolResult(validUpdateErrorRes);
  const validUpdateMessage = typeof validUpdateParsed === 'string' ? validUpdateParsed : validUpdateErrorRes.result?.content?.[0]?.text;
  assert.match(validUpdateMessage, /^Invalid decision status: clean_nonexistent_status_value$/,
    'Legitimate update_status domain validation messages must be preserved when clean');
});

// ---------------------------------------------------------------------------
// TEST 4: shadowgraph_purge_preview executes without -32601 and returns summary
// ---------------------------------------------------------------------------
test('Deep Audit 4: shadowgraph_purge_preview executes and returns valid project summary', async (t) => {
  // Test A: Full profile
  const mcpFull = await startMcpHarness(t);
  const proj = 'purge-preview-test-project';

  // Seed sample data in the project
  await mcpFull.callTool('shadowgraph_record_decision', {
    title: 'Purge Preview Decision',
    chosen: 'Purge Preview Choice',
    project: proj
  });
  await mcpFull.callTool('shadowgraph_record_fact', {
    key: 'purge.test.fact',
    value: 'purge_val',
    project: proj
  });

  // Call shadowgraph_purge_preview
  const previewRes = await mcpFull.callTool('shadowgraph_purge_preview', {
    project: proj
  });

  assert.equal(previewRes.error, undefined, 'shadowgraph_purge_preview must NOT fail with RPC error');
  assert.equal(previewRes.result?.isError, false, 'isError must be false');
  const summary = parseToolResult(previewRes);
  assert.ok(summary, 'Must return summary payload');
  assert.equal(typeof summary, 'object', 'Summary must be an object');
  assert.equal(summary.project, proj, 'Summary project must match requested project');
  assert.ok(summary.records >= 1, `Records count (${summary.records}) must reflect seeded decision`);
  assert.ok(summary.facts >= 1, `Facts count (${summary.facts}) must reflect seeded fact`);

  // Test B: Profile restriction in compact mode
  const mcpCompact = await startMcpHarness(t, { profile: 'compact' });
  const compactRes = await mcpCompact.callTool('shadowgraph_purge_preview', {
    project: proj
  });
  assert.ok(compactRes.error, 'Calling purge_preview in compact profile must return error');
  assert.equal(compactRes.error.code, -32601, 'RPC error code must be -32601 (Method not found)');
  assert.match(compactRes.error.message, /excluded by active compact profile/,
    'Error message must provide compact profile operator guidance');

  // Test C: Profile restriction in workflow mode
  const mcpWorkflow = await startMcpHarness(t, { profile: 'workflow' });
  const workflowRes = await mcpWorkflow.callTool('shadowgraph_purge_preview', {
    project: proj
  });
  assert.ok(workflowRes.error, 'Calling purge_preview in workflow profile must return error');
  assert.equal(workflowRes.error.code, -32601, 'RPC error code must be -32601 (Method not found)');
  assert.match(workflowRes.error.message, /excluded by active workflow profile/,
    'Error message must provide workflow profile operator guidance');
});
