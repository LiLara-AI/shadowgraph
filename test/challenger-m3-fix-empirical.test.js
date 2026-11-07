import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { resolveRuleAliases } from '../src/condition-eval.js';

// ---------------------------------------------------------------------------
// Challenger M3 Fix 2 - Empirical Boundary & Stress Challenge Test Suite
// Verifies:
// 1. shadowgraph_purge_preview conformance & RPC execution
// 2. Condition aliases (target & expected) with falsy and conflicting values
// 3. Project defaulting across all 8 follow-up tools under SHADOWGRAPH_PROJECT
// 4. End-to-end auto-scoping of shadowgraph_ack_review via reviewSignalId
// 5. UNC, Windows, and POSIX path error sanitization
// ---------------------------------------------------------------------------

const MODERN_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta(clientInfo = { name: 'challenger-m3-fix-2', version: '1.0.0' }) {
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
  const directory = await scratchDirectory(t, 'challenger-m3-fix-mcp-');
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
        timer: setTimeout(() => {
          const idx = waiters.indexOf(waiter);
          if (idx >= 0) waiters.splice(idx, 1);
          reject(new Error(`Timed out waiting for ${label}. Stderr: ${stderr}`));
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
    async callTool(name, args = {}) {
      return this.call('tools/call', {
        name,
        arguments: args,
        _meta: modernMeta()
      });
    },
    stop
  };
}

// ============================================================================
// TEST 1: shadowgraph_purge_preview Conformance & Execution
// ============================================================================

test('Challenger M3 Fix: shadowgraph_purge_preview executes cleanly via MCP JSON-RPC', async (t) => {
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: 'preview-proj' }
  });

  // Record some data
  await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision For Preview',
    chosen: 'Chosen Option',
    project: 'preview-proj'
  });
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'test_key',
    value: 'test_val',
    project: 'preview-proj'
  });

  // Call shadowgraph_purge_preview with explicit project
  const resExplicit = await mcp.callTool('shadowgraph_purge_preview', { project: 'preview-proj' });
  assert.equal(resExplicit.error, undefined, 'RPC error must be undefined');
  assert.equal(resExplicit.result?.isError, false, 'Tool execution must not be an error');
  const summaryExplicit = parseToolResult(resExplicit);
  assert.ok(summaryExplicit, 'Must return summary payload');
  assert.equal(typeof summaryExplicit.records, 'number');
  assert.ok(summaryExplicit.records >= 1, 'Summary must reflect recorded decisions');

  // Call shadowgraph_purge_preview with non-existent project
  const resEmptyProj = await mcp.callTool('shadowgraph_purge_preview', { project: 'non-existent-preview-proj' });
  assert.equal(resEmptyProj.error, undefined);
  assert.equal(resEmptyProj.result?.isError, false);
  const summaryEmpty = parseToolResult(resEmptyProj);
  assert.equal(summaryEmpty.records, 0);
  assert.equal(summaryEmpty.facts, 0);
});

// ============================================================================
// TEST 2: Condition Normalization Aliases (target & expected) Falsy & Conflict
// ============================================================================

test('Challenger M3 Fix: resolveRuleAliases correctly handles falsy operands and rejects conflicts', () => {
  // Falsy number 0
  const zeroAlias = resolveRuleAliases({ target: 'errors', expected: 0 });
  assert.equal(zeroAlias.key, 'errors');
  assert.equal(zeroAlias.value, 0);
  assert.equal(zeroAlias.hasValue, true);

  // Both key/target and value/expected provided with identical falsy 0
  const zeroBoth = resolveRuleAliases({ key: 'errors', target: 'errors', value: 0, expected: 0 });
  assert.equal(zeroBoth.key, 'errors');
  assert.equal(zeroBoth.value, 0);
  assert.equal(zeroBoth.hasValue, true);

  // Falsy boolean false
  const boolBoth = resolveRuleAliases({ key: 'enabled', target: 'enabled', value: false, expected: false });
  assert.equal(boolBoth.key, 'enabled');
  assert.equal(boolBoth.value, false);
  assert.equal(boolBoth.hasValue, true);

  // Falsy empty string ""
  const strBoth = resolveRuleAliases({ key: 'prefix', target: 'prefix', value: '', expected: '' });
  assert.equal(strBoth.key, 'prefix');
  assert.equal(strBoth.value, '');
  assert.equal(strBoth.hasValue, true);

  // Null operand
  const nullBoth = resolveRuleAliases({ key: 'status', target: 'status', value: null, expected: null });
  assert.equal(nullBoth.key, 'status');
  assert.equal(nullBoth.value, null);
  assert.equal(nullBoth.hasValue, true);

  // Array operands (non-conflicting deep equal)
  const arrayBoth = resolveRuleAliases({ key: 'tags', target: 'tags', value: ['a', 'b'], expected: ['a', 'b'] });
  assert.deepEqual(arrayBoth.value, ['a', 'b']);

  // Conflict: 0 vs 1
  assert.throws(() => {
    resolveRuleAliases({ key: 'errors', target: 'errors', value: 0, expected: 1 });
  }, /Conflicting condition aliases: value and expected must not conflict/i);

  // Conflict: false vs true
  assert.throws(() => {
    resolveRuleAliases({ key: 'flag', value: false, expected: true });
  }, /Conflicting condition aliases: value and expected must not conflict/i);

  // Conflict: '' vs 'something'
  assert.throws(() => {
    resolveRuleAliases({ key: 'prefix', value: '', expected: 'something' });
  }, /Conflicting condition aliases: value and expected must not conflict/i);

  // Conflict: key 'alpha' vs target 'beta'
  assert.throws(() => {
    resolveRuleAliases({ key: 'alpha', target: 'beta', value: 10 });
  }, /Conflicting condition aliases: key and target must not conflict/i);
});

test('Challenger M3 Fix: Engine stores and evaluates decisions with target & expected aliases', () => {
  const graph = createShadowGraph();

  // Create decision using target and expected aliases with operator '<=' and falsy expected value 0
  const dec = graph.addDecision({
    title: 'Zero Defect Policy',
    chosen: 'Enforce zero defects',
    project: 'qa-project',
    reopenWhen: [
      { target: 'defect_count', operator: '>', expected: 0 }
    ]
  });

  assert.ok(dec.id);
  assert.ok(dec.alternatives?.[0]?.reopenWhen?.[0]);
  const storedRule = dec.alternatives[0].reopenWhen[0];
  assert.equal(storedRule.key, 'defect_count');
  assert.equal(storedRule.operator, 'greater_than');
  assert.equal(storedRule.value, 0);

  // 1. Initial review: defect_count is 0 -> condition not breached
  graph.addFact({
    key: 'defect_count',
    value: 0,
    project: 'qa-project'
  });

  const rev1 = graph.review({ project: 'qa-project' });
  assert.equal(rev1.items.length, 0, 'Condition defect_count > 0 should not fire when defect_count is 0');

  // 2. Fact updated: defect_count is 3 -> condition breached!
  graph.addFact({
    key: 'defect_count',
    value: 3,
    project: 'qa-project'
  });

  const rev2 = graph.review({ project: 'qa-project' });
  assert.equal(rev2.items.length, 1, 'Condition defect_count > 0 must fire when defect_count is 3');
  assert.equal(rev2.items[0].decisionId, dec.id);
});

// ============================================================================
// TEST 3: Project Defaulting Matrix across ALL 8 Follow-up Tools
// ============================================================================

test('Challenger M3 Fix: All 8 follow-up tools successfully resolve default project without arguments', async (t) => {
  const defaultProj = 'matrix-default-corp';
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: defaultProj }
  });

  // Setup baseline entities in default project
  const decARes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision Alpha',
    chosen: 'Choice Alpha'
  });
  const decA = parseToolResult(decARes);
  assert.equal(decA.project, defaultProj);

  const decBRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Decision Beta',
    chosen: 'Choice Beta'
  });
  const decB = parseToolResult(decBRes);
  assert.equal(decB.project, defaultProj);

  // 1. shadowgraph_record_outcome (without project)
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    id: decA.id,
    outcome: { status: 'successful' }
  });
  assert.equal(outRes.error, undefined);
  assert.equal(outRes.result?.isError, false);
  const outPayload = parseToolResult(outRes);
  assert.equal(outPayload.project, defaultProj);

  // 2. shadowgraph_update_status (without project)
  const statRes = await mcp.callTool('shadowgraph_update_status', {
    decisionId: decA.id,
    status: 'planned'
  });
  assert.equal(statRes.error, undefined);
  assert.equal(statRes.result?.isError, false);
  const statPayload = parseToolResult(statRes);
  assert.equal(statPayload.status, 'planned');
  assert.equal(statPayload.project, defaultProj);

  // 3. shadowgraph_confidence_evidence (without project)
  const confRes = await mcp.callTool('shadowgraph_confidence_evidence', {
    decisionId: decA.id,
    key: 'ev-test-1',
    reason: 'field benchmark evidence',
    supports: true
  });
  assert.equal(confRes.error, undefined);
  assert.equal(confRes.result?.isError, false);
  const confPayload = parseToolResult(confRes);
  assert.equal(confPayload.project, defaultProj);

  // 4. shadowgraph_supersede (without project)
  const supRes = await mcp.callTool('shadowgraph_supersede', {
    decisionId: decA.id,
    replacementId: decB.id
  });
  assert.equal(supRes.error, undefined);
  assert.equal(supRes.result?.isError, false);
  const supPayload = parseToolResult(supRes);
  assert.equal(supPayload.previous.status, 'superseded');
  assert.equal(supPayload.replacement.id, decB.id);

  // 5. shadowgraph_link (without project)
  const linkRes = await mcp.callTool('shadowgraph_link', {
    from: decB.id,
    to: decA.id,
    relation: 'informs'
  });
  assert.equal(linkRes.error, undefined);
  assert.equal(linkRes.result?.isError, false);
  const linkPayload = parseToolResult(linkRes);
  assert.equal(linkPayload.from, decB.id);
  assert.equal(linkPayload.to, decA.id);

  // 6. shadowgraph_reconsider (without project)
  const reconRes = await mcp.callTool('shadowgraph_reconsider', {
    decisionId: decB.id
  });
  assert.equal(reconRes.error, undefined);
  assert.equal(reconRes.result?.isError, false);

  // 7. shadowgraph_review_context (without project)
  const revCtxRes = await mcp.callTool('shadowgraph_review_context', {});
  assert.equal(revCtxRes.error, undefined);
  assert.equal(revCtxRes.result?.isError, false);
  const revCtxPayload = parseToolResult(revCtxRes);
  assert.equal(revCtxPayload.completeness?.scope?.project, defaultProj);

  // 8. shadowgraph_ack_review (without project on non-existent id)
  // Scopes to default project and cleanly returns 'Review signal not found'
  const ackRes = await mcp.callTool('shadowgraph_ack_review', {
    id: 'signal_non_existent'
  });
  assert.ok(ackRes.result?.isError, 'Non-existent signal must return error');
  assert.equal(ackRes.result.content[0].text, 'Review signal not found');
});

// ============================================================================
// TEST 4: Auto-scoping of shadowgraph_ack_review via reviewSignalId
// ============================================================================

test('Challenger M3 Fix: Acknowledge review via reviewSignalId with project parameter', async (t) => {
  const mcp = await startMcpHarness(t);

  const projects = ['proj-alpha-1', 'proj-beta-2', 'proj-gamma-3'];
  const signals = [];

  for (const proj of projects) {
    // 1. Create decision in proj with reopen rule
    await mcp.callTool('shadowgraph_record_decision', {
      title: `Policy in ${proj}`,
      chosen: `Default for ${proj}`,
      project: proj,
      reopenWhen: [{ target: `metric.${proj}`, expected: 10, operator: '>=' }]
    });

    // 2. Breach rule with a fact in proj
    await mcp.callTool('shadowgraph_record_fact', {
      key: `metric.${proj}`,
      value: 99,
      project: proj
    });

    // 3. Review proj to generate review signal
    const revRes = await mcp.callTool('shadowgraph_review', { project: proj });
    const items = parseToolResult(revRes)?.items ?? [];
    assert.ok(items.length > 0, `Project ${proj} must have review signals`);
    signals.push({ proj, signalId: items[0].reviewSignalId });
  }

  // 4. Acknowledge each signal with reviewSignalId and project
  for (const { proj, signalId } of signals) {
    const ackRes = await mcp.callTool('shadowgraph_ack_review', {
      reviewSignalId: signalId,
      project: proj
    });

    assert.equal(ackRes.error, undefined, `RPC error should be undefined for ${proj}`);
    assert.equal(ackRes.result?.isError, false, `Tool execution should succeed for ${proj}`);
    const ackResult = parseToolResult(ackRes);
    assert.equal(ackResult.status, 'acknowledged');
    assert.equal(ackResult.id, signalId);
    assert.ok(ackResult.acknowledgedAt);
  }

  // 5. Re-acknowledging already acknowledged signal stays acknowledged
  const repeatAck = await mcp.callTool('shadowgraph_ack_review', {
    reviewSignalId: signals[0].signalId,
    project: signals[0].proj
  });
  assert.equal(repeatAck.result?.isError, false);
  assert.equal(parseToolResult(repeatAck).status, 'acknowledged');
});

// ============================================================================
// TEST 5: Error Sanitization Across Windows UNC and Backslash Delimiters
// ============================================================================

test('Challenger M3 Fix: Error sanitization blocks Windows UNC and backslash paths', async (t) => {
  const mcp = await startMcpHarness(t);

  const maliciousInputs = [
    '\\\\192.168.1.50\\c$\\secrets\\data.json',
    '\\\\?\\' + ['C:', 'Users', 'Administrator', 'confidential'].join('\\'),
    '..\\..\\..\\Windows\\System32\\cmd.exe',
    'C:\\Program Files\\ShadowGraph\\internal.dat',
    '/var/log/shadowgraph/audit.log',
    'bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.token',
    'PRIVATE_KEY=MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQC3'
  ];

  for (const input of maliciousInputs) {
    // Attempt to inject path or secret into decision status
    const res = await mcp.callTool('shadowgraph_record_decision', {
      title: 'Path Injection Probe',
      chosen: 'Test',
      status: input
    });

    assert.ok(res.result?.isError, `Input "${input}" must be rejected`);
    const errorText = res.result.content[0].text;
    assert.equal(errorText, 'Tool execution failed', `Leakage detected for input "${input}": got "${errorText}"`);
    assert.equal(errorText.includes(input), false, 'Must not echo back the input path/secret');
  }
});
