import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { buildToolCatalog, COMPACT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '../src/mcp-tools.js';

// ---------------------------------------------------------------------------
// Adversarial Empirical Challenge Suite for Milestone 3 (Features 11–14)
// Challenger: challenger_m3_2
// ---------------------------------------------------------------------------

const MODERN_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta(clientInfo = { name: 'challenger-m3-test', version: '1.0.0' }) {
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
  const directory = await scratchDirectory(t, 'challenger-m3-mcp-');
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
// SUITE 1: STRESS TEST ERROR SANITIZATION (Feature 11)
// ============================================================================

test('Challenger M3: Error sanitization blocks path injection via invalid decision status', async (t) => {
  const mcp = await startMcpHarness(t);

  const pathPayloads = [
    'C:\\Windows\\System32\\cmd.exe',
    ['C:', 'Users', 'Administrator', 'secret.key'].join('/'),
    'D:\\Sensitive\\Store\\data.sqlite',
    ['', 'home', 'runner', 'workspace', 'id_rsa'].join('/'),
    '/tmp/root_secret_file.txt',
    '/var/log/private_syslog.log',
    'E:\\Data\\passwords.csv'
  ];

  for (const payload of pathPayloads) {
    const res = await mcp.callTool('shadowgraph_record_decision', {
      title: 'Path Leak Test Decision',
      chosen: 'Test',
      status: payload
    });

    const combined = JSON.stringify(res.error ?? res.result ?? {});
    assert.ok(res.error || res.result?.isError, `Calling with invalid status ${payload} must error`);
    assert.equal(combined.includes('C:\\'), false, `Response must not contain C:\\ for payload: ${payload}`);
    assert.equal(combined.includes('/home/'), false, `Response must not contain /home/ for payload: ${payload}`);
    assert.equal(combined.includes('/tmp/'), false, `Response must not contain /tmp/ for payload: ${payload}`);
    assert.equal(combined.includes('/var/'), false, `Response must not contain /var/ for payload: ${payload}`);
    assert.equal(combined.includes('secret.key'), false, `Response must not echo back secret payload: ${payload}`);
  }
});

test('Challenger M3: Error sanitization blocks secret token injection in status & condition fields', async (t) => {
  const mcp = await startMcpHarness(t);

  const secretPayloads = [
    'bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
    'password_12345_supersecret',
    'api-key-998877665544332211',
    'private-key-material-here'
  ];

  for (const secret of secretPayloads) {
    const res = await mcp.callTool('shadowgraph_record_decision', {
      title: 'Secret Leak Test Decision',
      chosen: 'Test',
      status: `invalid_${secret}`
    });

    const combined = JSON.stringify(res.error ?? res.result ?? {});
    assert.ok(res.error || res.result?.isError, 'Must fail on invalid status');
    assert.equal(combined.includes(secret), false, `Response must not contain raw secret: ${secret}`);
    assert.match(combined, /Tool execution failed/i, 'Should fall back to safe generic execution failed');
  }
});

test('Challenger M3: Error sanitization blocks path injection in rule condition operator and unit', async (t) => {
  const mcp = await startMcpHarness(t);

  const resOperator = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Condition Operator Path Test',
    chosen: 'Test',
    reopenWhen: [{ key: 'db.latency', operator: ['C:', 'Users', 'admin', 'operator'].join('\\'), value: 10 }]
  });
  const resOpStr = JSON.stringify(resOperator.error ?? resOperator.result ?? {});
  assert.equal(resOpStr.includes('C:' + '\\Users'), false, 'Operator error must not leak C:\\Users');

  const resUnit = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Condition Unit Path Test',
    chosen: 'Test',
    reopenWhen: [{ key: 'db.latency', operator: '>', unit: ['', 'home', 'runner', 'exploit_unit'].join('/'), value: 10 }]
  });
  const resUnitStr = JSON.stringify(resUnit.error ?? resUnit.result ?? {});
  assert.equal(resUnitStr.includes('/home' + '/runner'), false, 'Unit error must not leak target path');
});

test('Challenger M3: Error sanitization blocks stack trace exposure on internal errors', async (t) => {
  const mcp = await startMcpHarness(t);

  // Call record_outcome on non-existent decision
  const res = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: 'dec-nonexistent-123456789',
    outcome: { status: 'failed' }
  });

  const combined = JSON.stringify(res.error ?? res.result ?? {});
  assert.equal(combined.includes('.js:'), false, 'Response must not contain JS stack trace line pointers');
  assert.equal(combined.includes('node:internal'), false, 'Response must not contain node:internal stack traces');
  assert.equal(combined.includes('    at '), false, 'Response must not contain formatted stack frames');
});

test('Challenger M3: Error sanitization blocks internal code leakage on illegal lifecycle transitions', async (t) => {
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: 'lifecycle-leak-proj' }
  });

  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Lifecycle Leak Test',
    chosen: 'Option A'
  });
  const dec = parseToolResult(decRes);

  // Illegal jump: proposed -> validated directly via update_status
  const illegalRes = await mcp.callTool('shadowgraph_update_status', {
    decisionId: dec.id,
    status: 'validated'
  });
  assert.ok(illegalRes.result?.isError, 'Illegal lifecycle jump must return error');
  const errText = illegalRes.result.content[0].text;
  assert.equal(errText, 'Tool execution failed', 'Internal transition error must be masked by safe generic failure');
});

// ============================================================================
// SUITE 2: STRESS TEST PROFILE-HIDDEN TOOL GUIDANCE (Feature 12)
// ============================================================================

test('Challenger M3: Profile guidance in compact profile (16 tools) returns code -32601 for ALL 19 full-mode tools', async (t) => {
  const mcp = await startMcpHarness(t, { profile: 'compact' });

  const tools = await mcp.listTools();
  assert.equal(tools.length, 16, 'Compact profile must expose exactly 16 tools');

  const fullCatalog = buildToolCatalog({ verifier: false });
  const hiddenInCompact = fullCatalog.map((t) => t.name).filter((name) => !COMPACT_TOOL_NAMES.includes(name));
  assert.equal(hiddenInCompact.length, 19, 'Exactly 19 tools must be hidden in compact profile');

  for (const toolName of hiddenInCompact) {
    const res = await mcp.callTool(toolName, {});
    assert.ok(res.error, `Calling hidden tool ${toolName} under compact profile must return error`);
    assert.equal(res.error.code, -32601, `Error code must be -32601 for ${toolName}`);
    assert.match(
      res.error.message,
      /compact profile \(16 tools\)/i,
      `Message must mention compact profile (16 tools) for ${toolName}`
    );
    assert.match(
      res.error.message,
      /SHADOWGRAPH_MCP_COMPACT=0/i,
      `Message must provide actionable guidance (SHADOWGRAPH_MCP_COMPACT=0) for ${toolName}`
    );
  }

  // Non-existent tool must NOT return profile guidance; must return Unknown tool
  const fakeRes = await mcp.callTool('shadowgraph_completely_made_up_tool', {});
  assert.ok(fakeRes.error, 'Calling fake tool must error');
  assert.match(fakeRes.error.message, /^Unknown tool$/i, 'Non-existent tool must return Unknown tool without profile guidance');
});

test('Challenger M3: Profile guidance in workflow profile (20 tools) returns code -32601 for ALL 15 full-mode tools', async (t) => {
  const mcp = await startMcpHarness(t, { profile: 'workflow' });

  const tools = await mcp.listTools();
  assert.equal(tools.length, 20, 'Workflow profile must expose exactly 20 tools');

  const fullCatalog = buildToolCatalog({ verifier: false });
  const hiddenInWorkflow = fullCatalog.map((t) => t.name).filter((name) => !WORKFLOW_TOOL_NAMES.includes(name));
  assert.equal(hiddenInWorkflow.length, 15, 'Exactly 15 tools must be hidden in workflow profile');

  for (const toolName of hiddenInWorkflow) {
    const res = await mcp.callTool(toolName, {});
    assert.ok(res.error, `Calling hidden tool ${toolName} under workflow profile must return error`);
    assert.equal(res.error.code, -32601, `Error code must be -32601 for ${toolName}`);
    assert.match(
      res.error.message,
      /workflow profile \(20 tools\)/i,
      `Message must mention workflow profile (20 tools) for ${toolName}`
    );
    assert.match(
      res.error.message,
      /unset SHADOWGRAPH_MCP_PROFILE/i,
      `Message must advise unsetting SHADOWGRAPH_MCP_PROFILE for ${toolName}`
    );
  }

  // Non-existent tool must return Unknown tool
  const fakeRes = await mcp.callTool('shadowgraph_not_in_any_catalog', {});
  assert.ok(fakeRes.error);
  assert.match(fakeRes.error.message, /^Unknown tool$/i);
});

test('Challenger M3: Full profile exposes all 35 tools and does not trigger profile guidance', async (t) => {
  const mcp = await startMcpHarness(t); // default full profile

  const tools = await mcp.listTools();
  assert.equal(tools.length, 35, 'Full profile must expose 35 tools');

  // Completely unknown tool
  const fakeRes = await mcp.callTool('shadowgraph_definitely_unknown', {});
  assert.ok(fakeRes.error);
  assert.match(fakeRes.error.message, /^Unknown tool$/i);
});

// ============================================================================
// SUITE 3: STRESS TEST PROJECT DEFAULTING ACROSS ALL 8 FOLLOW-UP TOOLS (Feature 13)
// ============================================================================

test('Challenger M3: Project defaulting across ALL 8 follow-up tools under SHADOWGRAPH_PROJECT', async (t) => {
  const defaultProject = 'challenger-def-proj';
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: defaultProject }
  });

  // Base decisions & setup
  const d1Res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Follow-up Test Decision 1',
    chosen: 'Option 1'
  });
  assert.equal(d1Res.error, undefined, 'Base decision 1 creation must succeed');
  const dec1 = parseToolResult(d1Res);
  assert.equal(dec1.project, defaultProject, 'Decision 1 must inherit default project');

  const d2Res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Follow-up Test Decision 2',
    chosen: 'Option 2'
  });
  assert.equal(d2Res.error, undefined);
  const dec2 = parseToolResult(d2Res);
  assert.equal(dec2.project, defaultProject);

  const d3Res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Follow-up Test Decision 3',
    chosen: 'Option 3'
  });
  const dec3 = parseToolResult(d3Res);

  const d4Res = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Follow-up Test Decision 4',
    chosen: 'Option 4'
  });
  const dec4 = parseToolResult(d4Res);

  // 1. Follow-up tool: shadowgraph_record_outcome (no project arg)
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: dec1.id,
    outcome: { status: 'successful', lessons: ['Completed successfully'] }
  });
  assert.equal(outRes.error, undefined, 'shadowgraph_record_outcome should succeed with defaulted project');
  assert.equal(outRes.result?.isError, false);
  const outDec = parseToolResult(outRes);
  assert.ok(outDec && outDec.outcome, 'Outcome must be recorded');

  // 2. Follow-up tool: shadowgraph_update_status (no project arg, legal transition: proposed -> planned)
  const statRes = await mcp.callTool('shadowgraph_update_status', {
    decisionId: dec2.id,
    status: 'planned'
  });
  assert.equal(statRes.error, undefined, 'shadowgraph_update_status should succeed with defaulted project');
  assert.equal(statRes.result?.isError, false);
  const statDec = parseToolResult(statRes);
  assert.equal(statDec.status, 'planned');

  // 3. Follow-up tool: shadowgraph_confidence_evidence (no project arg)
  const evRes = await mcp.callTool('shadowgraph_confidence_evidence', {
    decisionId: dec1.id,
    reason: 'Empirical verification passed',
    key: 'ev-empirical-1'
  });
  assert.equal(evRes.error, undefined, 'shadowgraph_confidence_evidence should succeed with defaulted project');
  assert.equal(evRes.result?.isError, false);

  // 4. Follow-up tool: shadowgraph_supersede (no project arg)
  const supRes = await mcp.callTool('shadowgraph_supersede', {
    decisionId: dec1.id,
    replacementId: dec2.id,
    reason: 'Superseded by improved option'
  });
  assert.equal(supRes.error, undefined, 'shadowgraph_supersede should succeed with defaulted project');
  assert.equal(supRes.result?.isError, false);

  // 5. Follow-up tool: shadowgraph_link (no project arg)
  const linkRes = await mcp.callTool('shadowgraph_link', {
    from: dec3.id,
    to: dec4.id,
    relation: 'relates_to'
  });
  assert.equal(linkRes.error, undefined, 'shadowgraph_link should succeed with defaulted project');
  assert.equal(linkRes.result?.isError, false);

  // 6. Follow-up tool: shadowgraph_reconsider (no project arg)
  const reconRes = await mcp.callTool('shadowgraph_reconsider', {
    decisionId: dec3.id
  });
  assert.equal(reconRes.error, undefined, 'shadowgraph_reconsider should succeed with defaulted project');
  assert.equal(reconRes.result?.isError, false);

  // Setup review signal for tools 7 & 8:
  const reopenDecRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Review Signal Decision',
    chosen: 'Sentinel',
    reopenWhen: [{ target: 'drift.score', expected: 80, operator: '>=' }]
  });
  const reopenDec = parseToolResult(reopenDecRes);

  await mcp.callTool('shadowgraph_record_fact', {
    key: 'drift.score',
    value: 95
  });

  const revRes = await mcp.callTool('shadowgraph_review', {});
  const revItems = parseToolResult(revRes)?.items ?? [];
  assert.ok(revItems.length > 0, 'Review signal must be generated by shadowgraph_review with default project');
  const signalId = revItems[0].reviewSignalId;

  // 7. Follow-up tool: shadowgraph_review_context (no project arg)
  const revCtxRes = await mcp.callTool('shadowgraph_review_context', {});
  assert.equal(revCtxRes.error, undefined, 'shadowgraph_review_context should succeed with defaulted project');
  assert.equal(revCtxRes.result?.isError, false);

  // 8. Follow-up tool: shadowgraph_ack_review (no project arg)
  const ackRes = await mcp.callTool('shadowgraph_ack_review', {
    id: signalId
  });
  assert.equal(ackRes.error, undefined, 'shadowgraph_ack_review should succeed with defaulted project');
  assert.equal(ackRes.result?.isError, false);
});

test('Challenger M3: Explicit project override is not clobbered by default project', async (t) => {
  const defaultProject = 'default-scope-proj';
  const customProject = 'explicit-custom-proj';
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: defaultProject }
  });

  // Create decision with explicit custom project
  const dRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Custom Scoped Decision',
    chosen: 'Custom Choice',
    project: customProject
  });
  assert.equal(dRes.error, undefined);
  const decision = parseToolResult(dRes);
  assert.equal(decision.project, customProject, 'Explicit project must take precedence over default');

  // Call follow-up with explicit project
  const outRes = await mcp.callTool('shadowgraph_record_outcome', {
    decisionId: decision.id,
    outcome: { status: 'successful' },
    project: customProject
  });
  assert.equal(outRes.error, undefined);
  const updated = parseToolResult(outRes);
  assert.equal(updated.project, customProject);
});

// ============================================================================
// SUITE 4: STRESS TEST PARAMETER ALIASES FOR shadowgraph_ack_review (Feature 14)
// ============================================================================

test('Challenger M3: shadowgraph_ack_review accepts id, reviewSignalId, identical pair, and rejects conflicts', async (t) => {
  const mcp = await startMcpHarness(t);

  // Helper to trigger review signals
  async function triggerSignal(tag) {
    const proj = `proj-${tag}-${Date.now()}`;
    await mcp.callTool('shadowgraph_record_decision', {
      title: `Trigger Decision ${tag}`,
      chosen: 'Test',
      reopenWhen: [{ target: `condition.${tag}`, expected: 10, operator: '>=' }],
      project: proj
    });
    await mcp.callTool('shadowgraph_record_fact', {
      key: `condition.${tag}`,
      value: 20,
      project: proj
    });
    await mcp.callTool('shadowgraph_review', { project: proj });
    const sigRes = await mcp.callTool('shadowgraph_review_signals', { project: proj });
    const items = parseToolResult(sigRes)?.items ?? [];
    assert.ok(items.length > 0, `Signal must be generated for ${tag}`);
    return { signal: items[0], project: proj };
  }

  // 1. Invocation using only id (legacy parameter)
  const { signal: s1, project: p1 } = await triggerSignal('id-only');
  const ack1 = await mcp.callTool('shadowgraph_ack_review', {
    id: s1.id,
    project: p1
  });
  assert.equal(ack1.error, undefined, 'Ack via id only must succeed');

  // 2. Invocation using only reviewSignalId (alias)
  const { signal: s2, project: p2 } = await triggerSignal('alias-only');
  const ack2 = await mcp.callTool('shadowgraph_ack_review', {
    reviewSignalId: s2.id,
    project: p2
  });
  assert.equal(ack2.error, undefined, 'Ack via reviewSignalId only must succeed');

  // 3. Invocation using identical id and reviewSignalId
  const { signal: s3, project: p3 } = await triggerSignal('identical');
  const ack3 = await mcp.callTool('shadowgraph_ack_review', {
    id: s3.id,
    reviewSignalId: s3.id,
    project: p3
  });
  assert.equal(ack3.error, undefined, 'Ack with identical id and reviewSignalId must succeed');

  // 4. Invocation with conflicting id and reviewSignalId
  const { signal: s4 } = await triggerSignal('conflict');
  const ackConflict = await mcp.callTool('shadowgraph_ack_review', {
    id: s4.id,
    reviewSignalId: 'completely-different-signal-id'
  });
  assert.ok(ackConflict.error || ackConflict.result?.isError, 'Conflicting IDs must be rejected');
  const errStr = JSON.stringify(ackConflict.error ?? ackConflict.result ?? {});
  assert.match(errStr, /Conflicting id and reviewSignalId provided|conflict/i, 'Error message must state conflict');

  // 5. Direct ShadowGraph engine conflict validation
  const graph = createShadowGraph();
  assert.throws(
    () => {
      graph.acknowledgeReview({ id: 'sig-alpha', reviewSignalId: 'sig-beta' });
    },
    /Conflicting id and reviewSignalId provided/,
    'Engine must throw descriptive error on conflicting IDs'
  );
  assert.throws(
    () => {
      graph.acknowledgeReview('sig-alpha', { reviewSignalId: 'sig-beta' });
    },
    /Conflicting id and reviewSignalId provided/,
    'Engine must throw descriptive error on conflicting positional string and option object'
  );
});

test('Challenger M3: Auto-scoping reviewSignalId via SHADOWGRAPH_PROJECT', async (t) => {
  const isolatedProj = 'auto-scoped-review-project';
  const mcp = await startMcpHarness(t, { env: { SHADOWGRAPH_PROJECT: isolatedProj } });

  // Create scoped decision and trigger signal
  await mcp.callTool('shadowgraph_record_decision', {
    title: 'Auto-Scope Signal Decision',
    chosen: 'Scoped Choice',
    reopenWhen: [{ target: 'latency.alert', expected: 50, operator: '>=' }],
    project: isolatedProj
  });
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'latency.alert',
    value: 100,
    project: isolatedProj
  });
  await mcp.callTool('shadowgraph_review', { project: isolatedProj });
  const sigRes = await mcp.callTool('shadowgraph_review_signals', { project: isolatedProj });
  const items = parseToolResult(sigRes)?.items ?? [];
  assert.ok(items.length > 0, 'Signal must exist in isolated project');
  const signal = items[0];

  // Acknowledge via reviewSignalId with NO explicit project argument; defaulted by SHADOWGRAPH_PROJECT
  const ackRes = await mcp.callTool('shadowgraph_ack_review', {
    reviewSignalId: signal.id
  });
  assert.equal(ackRes.error, undefined, 'Acknowledge via reviewSignalId should auto-resolve project scope without error');
});
