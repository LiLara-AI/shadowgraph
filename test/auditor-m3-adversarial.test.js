import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';

const MODERN_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta() {
  return {
    [PROTOCOL_VERSION_META]: MODERN_PROTOCOL,
    [CLIENT_INFO_META]: { name: 'auditor-m3-test', version: '1.0.0' },
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
  const directory = await scratchDirectory(t, 'shadowgraph-auditor-m3-');
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

  function waitFor(predicate, label, timeoutMs = 12000) {
    const existing = responses.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for ${label}`));
      }, timeoutMs);
      waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async function request(method, params) {
    const id = reqCounter++;
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    return waitFor((m) => m.id === id, `${method}#${id}`);
  }

  t.after(() => {
    child.kill();
  });

  // Handshake
  await request('initialize', {
    protocolVersion: MODERN_PROTOCOL,
    capabilities: {},
    clientInfo: { name: 'auditor-m3-test', version: '1.0.0' }
  });

  return {
    callTool: (name, args = {}) => request('tools/call', { name, arguments: args, _meta: modernMeta() }),
    listTools: async () => {
      const res = await request('tools/list', { _meta: modernMeta() });
      return res.result?.tools ?? [];
    }
  };
}

test('Auditor Adversarial 1: Error masking preserves domain validation messages without path leakage', async (t) => {
  const mcp = await startMcpHarness(t);

  // 1. Invalid fact verificationStatus
  const res1 = await mcp.callTool('shadowgraph_record_fact', {
    key: 'status',
    value: 123,
    verificationStatus: 'verified',
    project: 'auditor-p1'
  });
  const err1 = res1.result?.isError ? res1.result.content[0].text : res1.error?.message;
  assert.match(err1, /A caller cannot set fact verificationStatus to verified/);

  // 2. Fact missing key
  const res2 = await mcp.callTool('shadowgraph_record_fact', {
    value: 'something',
    project: 'auditor-p1'
  });
  const err2 = res2.result?.isError ? res2.result.content[0].text : res2.error?.message;
  assert.match(err2, /A fact requires a non-empty key/);

  // 3. Structured rule pattern: unsupported operator
  const res3 = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision with Bad Operator',
    chosen: 'Choice A',
    reopenWhen: [{ key: 'cpu', operator: 'bogus_op', value: 50 }],
    project: 'auditor-p1'
  });
  const err3 = res3.result?.isError ? res3.result.content[0].text : res3.error?.message;
  assert.match(err3, /Unsupported rule operator bogus_op/);

  // 4. Structured rule pattern: missing value for operator
  const res4 = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision with Missing Value',
    chosen: 'Choice B',
    reopenWhen: [{ key: 'cpu', operator: 'equals' }],
    project: 'auditor-p1'
  });
  const err4 = res4.result?.isError ? res4.result.content[0].text : res4.error?.message;
  assert.match(err4, /A structured rule requires a value for operator equals/);

  // 5. Existing decision updated with invalid decision status transition
  const decInit = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision for Status Test',
    chosen: 'Choice C',
    project: 'auditor-p1'
  });
  const dec = parseToolResult(decInit);
  const res5 = await mcp.callTool('shadowgraph_update_status', {
    decisionId: dec.id,
    status: 'invalid_status_xyz',
    project: 'auditor-p1'
  });
  const err5 = res5.result?.isError ? res5.result.content[0].text : res5.error?.message;
  assert.match(err5, /Invalid decision status: invalid_status_xyz/);

  // 6. Nonexistent decision returns sanitized domain message 'Decision not found'
  const res6 = await mcp.callTool('shadowgraph_update_status', {
    decisionId: 'dec-nonexistent',
    status: 'approved',
    project: 'auditor-p1'
  });
  const err6 = res6.result?.isError ? res6.result.content[0].text : res6.error?.message;
  assert.match(err6, /Decision not found/);

  // Verify none of these leaked platform path or credentials
  for (const msg of [err1, err2, err3, err4, err5, err6]) {
    assert.equal(/[a-zA-Z]:[\\/]|(?:\/Users\/|\/home\/|\/tmp\/)/i.test(msg), false, `Error must not leak paths: ${msg}`);
  }
});

test('Auditor Adversarial 2: Profile-hidden tool guidance returns code -32601 for compact and workflow', async (t) => {
  // 1. Compact profile
  const mcpCompact = await startMcpHarness(t, { profile: 'compact' });

  // Call full-only tool: shadowgraph_link
  const resLinkCompact = await mcpCompact.callTool('shadowgraph_link', { from: 'a', to: 'b' });
  assert.ok(resLinkCompact.error, 'Full tool in compact mode must return error');
  assert.equal(resLinkCompact.error.code, -32601);
  assert.match(resLinkCompact.error.message, /Tool "shadowgraph_link" is excluded by active compact profile \(16 tools\)/);
  assert.match(resLinkCompact.error.message, /SHADOWGRAPH_MCP_COMPACT=0/);

  // Call workflow tool in compact: shadowgraph_review_signals
  const resSigCompact = await mcpCompact.callTool('shadowgraph_review_signals', {});
  assert.ok(resSigCompact.error, 'Workflow tool in compact mode must return error');
  assert.equal(resSigCompact.error.code, -32601);
  assert.match(resSigCompact.error.message, /Tool "shadowgraph_review_signals" is excluded by active compact profile \(16 tools\)/);

  // Call completely unknown tool
  const resFakeCompact = await mcpCompact.callTool('shadowgraph_completely_unknown_xyz', {});
  assert.ok(resFakeCompact.error);
  assert.equal(resFakeCompact.error.message, 'Unknown tool');

  // 2. Workflow profile
  const mcpWorkflow = await startMcpHarness(t, { profile: 'workflow' });

  // Call full-only tool in workflow: shadowgraph_link
  const resLinkWorkflow = await mcpWorkflow.callTool('shadowgraph_link', { from: 'a', to: 'b' });
  assert.ok(resLinkWorkflow.error);
  assert.equal(resLinkWorkflow.error.code, -32601);
  assert.match(resLinkWorkflow.error.message, /Tool "shadowgraph_link" is excluded by active workflow profile \(20 tools\)/);
  assert.match(resLinkWorkflow.error.message, /unset SHADOWGRAPH_MCP_PROFILE and restart with SHADOWGRAPH_MCP_COMPACT=0/);

  // Call workflow tool in workflow: shadowgraph_review_signals (should be available!)
  const resSigWorkflow = await mcpWorkflow.callTool('shadowgraph_review_signals', { project: 'wf-proj' });
  assert.equal(resSigWorkflow.error, undefined, 'Workflow tool should succeed in workflow profile');

  // Call non-existent tool in workflow
  const resFakeWorkflow = await mcpWorkflow.callTool('shadowgraph_completely_unknown_xyz', {});
  assert.ok(resFakeWorkflow.error);
  assert.equal(resFakeWorkflow.error.message, 'Unknown tool');
});

test('Auditor Adversarial 3: Follow-up project defaulting and explicit overrides', async (t) => {
  const defaultProj = 'auditor-default-p3';
  const mcp = await startMcpHarness(t, { env: { SHADOWGRAPH_PROJECT: defaultProj } });

  // 1. Create decision using default project
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Adversarial Default Test',
    chosen: 'Option Alpha'
  });
  assert.equal(decRes.error, undefined);
  const decision = parseToolResult(decRes);
  assert.equal(decision.project, defaultProj);

  // 2. Call shadowgraph_record_outcome without project
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    id: decision.id,
    outcome: { status: 'successful' }
  });
  assert.equal(outRes.error, undefined);
  const updatedDec = parseToolResult(outRes);
  assert.equal(updatedDec.project, defaultProj);

  // 3. Call shadowgraph_confidence_evidence without project
  const confRes = await mcp.callTool('shadowgraph_confidence_evidence', {
    decisionId: decision.id,
    key: 'bench-result-1',
    reason: 'Observed 10x throughput increase'
  });
  assert.equal(confRes.error, undefined);

  // 4. Call shadowgraph_reconsider without project
  const reconRes = await mcp.callTool('shadowgraph_reconsider', {
    decisionId: decision.id
  });
  assert.equal(reconRes.error, undefined);

  // 5. Test explicit project override is preserved
  const explicitProj = 'custom-explicit-p3';
  const explicitDecRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Explicit Decision',
    chosen: 'Option Beta',
    project: explicitProj
  });
  assert.equal(explicitDecRes.error, undefined);
  const explicitDec = parseToolResult(explicitDecRes);
  assert.equal(explicitDec.project, explicitProj, 'Explicit project must NOT be overridden by default project');
});

test('Auditor Adversarial 4: shadowgraph_ack_review parameter alias, project auto-scoping, and conflict rejection', async (t) => {
  const mcp = await startMcpHarness(t);

  // 1. Setup a decision with a condition
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Security Token Lifetime',
    chosen: 'Short-lived tokens (1 hour)',
    reopenWhen: [{ key: 'threat.level', operator: '>=', value: 3 }],
    project: 'sec-audit-proj'
  });
  assert.equal(decRes.error, undefined);

  // 2. Trip condition with fact
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'threat.level',
    value: 5,
    project: 'sec-audit-proj'
  });

  // 3. Review to generate signal
  await mcp.callTool('shadowgraph_review', { project: 'sec-audit-proj' });
  const sigRes = await mcp.callTool('shadowgraph_review_signals', { project: 'sec-audit-proj' });
  const signals = parseToolResult(sigRes)?.items ?? [];
  assert.ok(signals.length > 0, 'Signal must be generated');
  const signalId = signals[0].id;

  // 4. Conflicting id and reviewSignalId must throw
  const conflictRes = await mcp.callTool('shadowgraph_ack_review', {
    id: signalId,
    reviewSignalId: 'sig-different-id-999'
  });
  assert.ok(conflictRes.error || conflictRes.result?.isError, 'Conflicting IDs must be rejected');
  const conflictErr = conflictRes.result?.isError ? conflictRes.result.content[0].text : conflictRes.error?.message;
  assert.match(conflictErr, /Conflicting id and reviewSignalId provided/);

  // 5. Matching id and reviewSignalId must succeed without error
  const matchingRes = await mcp.callTool('shadowgraph_ack_review', {
    id: signalId,
    reviewSignalId: signalId,
    project: 'sec-audit-proj'
  });
  assert.equal(matchingRes.error, undefined, 'Matching id and reviewSignalId must succeed');

  // 6. Calling with reviewSignalId alone with project must succeed
  // Trigger another signal on another decision
  const decRes2 = await mcp.callTool('shadowgraph_record_decision', {
    title: 'DB Connection Pool',
    chosen: 'Min 10 Max 50',
    reopenWhen: [{ key: 'db.latency', operator: '>=', value: 200 }],
    project: 'sec-audit-proj'
  });
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'db.latency',
    value: 500,
    project: 'sec-audit-proj'
  });
  await mcp.callTool('shadowgraph_review', { project: 'sec-audit-proj' });
  const sigRes2 = await mcp.callTool('shadowgraph_review_signals', { project: 'sec-audit-proj' });
  const signals2 = parseToolResult(sigRes2)?.items ?? [];
  const unackedSignal = signals2.find((s) => s.status !== 'acknowledged');
  assert.ok(unackedSignal, 'Must find unacknowledged signal');

  const aliasOnlyRes = await mcp.callTool('shadowgraph_ack_review', {
    reviewSignalId: unackedSignal.id,
    project: 'sec-audit-proj'
  });
  assert.equal(aliasOnlyRes.error, undefined, 'Calling with reviewSignalId alone with project must succeed');
});
