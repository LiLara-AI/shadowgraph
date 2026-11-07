import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { buildToolCatalog, COMPACT_TOOL_NAMES, WORKFLOW_TOOL_NAMES } from '../src/mcp-tools.js';

// ---------------------------------------------------------------------------
// Advanced Adversarial Stress Suite for Milestone 3 (Features 11–14)
// Challenger: challenger_m3_2
// Focus: Boundary attacks, payload fuzzing, edge condition matrix
// ---------------------------------------------------------------------------

const MODERN_PROTOCOL = '2026-07-28';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta(clientInfo = { name: 'challenger-m3-stress', version: '1.0.0' }) {
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
  const directory = await scratchDirectory(t, 'challenger-stress-mcp-');
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
// STRESS TEST 1: ADVANCED PATH DELIMITER & SECRET FUZZING (Feature 11)
// ============================================================================

test('Stress M3: Path sanitizer blocks Windows drive paths and POSIX absolute system paths', async (t) => {
  const mcp = await startMcpHarness(t);

  const adversarialPaths = [
    'C:\\Windows\\System32\\drivers\\etc\\hosts',
    ['C:', 'Users', 'root', 'AppData', 'Local', 'Temp'].join('/'),
    'D:\\Sensitive\\Store\\data.sqlite',
    ['', 'home', 'runner', 'work', 'secret.key'].join('/'),
    '/tmp/root_secret_file.txt',
    '/var/run/secrets/kubernetes.io/serviceaccount',
    '/etc/ssl/certs/private.pem',
    '/usr/local/bin/malicious_entry'
  ];

  for (const p of adversarialPaths) {
    const res = await mcp.callTool('shadowgraph_record_decision', {
      title: 'Adversarial Path Fuzz',
      chosen: 'Choice',
      status: `status_with_${p}`
    });

    const errorStr = JSON.stringify(res.error ?? res.result ?? {});
    assert.ok(res.error || res.result?.isError, `Adversarial path payload must be rejected: ${p}`);
    assert.equal(errorStr.includes('C:\\'), false, `Must not leak C:\\ for ${p}`);
    assert.equal(errorStr.includes('Users'), false, `Must not leak Users directory for ${p}`);
    assert.equal(errorStr.includes('/home/'), false, `Must not leak /home/ for ${p}`);
    assert.equal(errorStr.includes('/tmp/'), false, `Must not leak /tmp/ for ${p}`);
    assert.equal(errorStr.includes('/etc/'), false, `Must not leak /etc/ for ${p}`);
    assert.equal(errorStr.includes('/var/'), false, `Must not leak /var/ for ${p}`);
    assert.equal(errorStr.includes('/usr/'), false, `Must not leak /usr/ for ${p}`);
    assert.match(errorStr, /Tool execution failed/i, `Must safely fall back for ${p}`);
  }
});

test('Stress M3: Secret sanitizer detects varied casing and formatting of credentials', async (t) => {
  const mcp = await startMcpHarness(t);

  const credentialPatterns = [
    'PASSWORD=Hunter2!',
    'pAsSwOrD_99999',
    'bearer   eyJhbGciOiJIUzI1NiJ9',
    'Bearer   token-xyz',
    'API-KEY: abcdef0123456789',
    'api_key_live_99887766',
    ['private_key:', '-----BEGIN', 'RSA', 'PRIVATE', 'KEY-----'].join(' ')
  ];

  for (const cred of credentialPatterns) {
    const res = await mcp.callTool('shadowgraph_record_decision', {
      title: 'Adversarial Credential Fuzz',
      chosen: 'Choice',
      status: `invalid_${cred}`
    });

    const errorStr = JSON.stringify(res.error ?? res.result ?? {});
    assert.ok(res.error || res.result?.isError);
    assert.equal(errorStr.includes('Hunter2'), false);
    assert.equal(errorStr.includes('abcdef0123456789'), false);
    assert.equal(errorStr.includes('BEGIN RSA'), false);
    assert.match(errorStr, /Tool execution failed/i);
  }
});

test('Stress M3: Valid domain messages WITHOUT paths or secrets pass through cleanly with normalized operators', async (t) => {
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: 'clean-domain-proj' }
  });

  // Test 1: Unsupported operator
  const resOp = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Valid Operator Error Test',
    chosen: 'Choice',
    reopenWhen: [{ key: 'cpu', operator: 'unsupported_op_foo', value: 50 }]
  });
  const resOpText = resOp.result?.content?.[0]?.text;
  assert.equal(resOpText, 'Unsupported rule operator unsupported_op_foo', 'Safe domain error must be preserved');

  // Test 2: Structured rule requires non-empty key
  const resKey = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Empty Key Error Test',
    chosen: 'Choice',
    reopenWhen: [{ key: '', operator: '>', value: 50 }]
  });
  const resKeyText = resKey.result?.content?.[0]?.text;
  assert.equal(resKeyText, 'A structured rule requires a non-empty key', 'Safe domain error must be preserved');

  // Test 3: Structured rule requires value for operator (normalized to canonical name)
  const resVal = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Missing Value Error Test',
    chosen: 'Choice',
    reopenWhen: [{ key: 'cpu', operator: '>' }]
  });
  const resValText = resVal.result?.content?.[0]?.text;
  assert.match(resValText, /^A structured rule requires a value for operator (?:>|greater_than)/);
});

// ============================================================================
// STRESS TEST 2: PROFILE PRECEDENCE & ERROR GUIDANCE EDGE CASES (Feature 12)
// ============================================================================

test('Stress M3: Server startup fail-fast rejects conflicting workflow and compact env flags', () => {
  // If both SHADOWGRAPH_MCP_PROFILE=workflow and SHADOWGRAPH_MCP_COMPACT=1 are supplied,
  // the server intentionally fails fast at startup with a descriptive error.
  const result = spawnSync(process.execPath, [join(process.cwd(), 'src/mcp.js')], {
    env: {
      ...process.env,
      SHADOWGRAPH_MCP_PROFILE: 'workflow',
      SHADOWGRAPH_MCP_COMPACT: '1'
    },
    encoding: 'utf8',
    timeout: 5000
  });

  assert.notEqual(result.status, 0, 'Must exit with non-zero status on conflicting profile env flags');
  assert.match(
    result.stderr,
    /SHADOWGRAPH_MCP_PROFILE=workflow conflicts with SHADOWGRAPH_MCP_COMPACT=1/i,
    'Must fail fast with clear conflict message on stderr'
  );
});

test('Stress M3: Profile guidance with legacy/non-modern protocol request retains -32601', async (t) => {
  const mcp = await startMcpHarness(t, { profile: 'compact' });

  // Call without modern _meta (legacy protocol)
  const res = await mcp.call('tools/call', {
    name: 'shadowgraph_link',
    arguments: {}
  });

  assert.ok(res.error);
  assert.equal(res.error.code, -32601, 'Legacy callers must also receive RPC error code -32601');
  assert.match(res.error.message, /compact profile/i);
});

// ============================================================================
// STRESS TEST 3: PROJECT DEFAULTING EDGE CASES & BOUNDARIES (Feature 13)
// ============================================================================

test('Stress M3: Project defaulting handles originId isolation (originId prevents project default)', async (t) => {
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: 'default-env-project' }
  });

  // When an explicit originId is provided on a call, withDefaultProject must not inject project!
  const origin = 'custom-origin-id-12345';
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Origin Scoped Decision',
    chosen: 'Origin Choice',
    originId: origin
  });
  assert.equal(decRes.error, undefined);
  const decision = parseToolResult(decRes);
  assert.equal(decision.originId, origin);
  assert.equal(decision.project, null, 'originId scoped entity should not be assigned default project');
});

test('Stress M3: Project defaulting fallback to workspace project when SHADOWGRAPH_PROJECT is whitespace', async (t) => {
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: '   ' }
  });

  // When SHADOWGRAPH_PROJECT is whitespace, it falls back to resolving the local workspace project
  const decRes = await mcp.callTool('shadowgraph_record_decision', {
    title: 'Workspace Fallback Scope Test',
    chosen: 'Choice'
  });

  assert.equal(decRes.error, undefined);
  const decision = parseToolResult(decRes);
  assert.ok(decision.project, 'Decision must receive a resolved project name from workspace fallback');
  assert.equal(typeof decision.project, 'string');
  assert.ok(decision.project.length > 0);
});

// ============================================================================
// STRESS TEST 4: PARAMETER ALIASES & CROSS-PROJECT ISOLATION (Feature 14)
// ============================================================================

test('Stress M3: Cross-project isolation: reviewSignalId cannot be hijacked by mismatched explicit project', async (t) => {
  const mcp = await startMcpHarness(t);

  // 1. Create a decision in project A
  const projA = 'project-alpha-secure';
  const projB = 'project-beta-adversary';

  await mcp.callTool('shadowgraph_record_decision', {
    title: 'Secure Decision Alpha',
    chosen: 'Alpha Choice',
    reopenWhen: [{ target: 'breach.level', expected: 1, operator: '>=' }],
    project: projA
  });
  await mcp.callTool('shadowgraph_record_fact', {
    key: 'breach.level',
    value: 5,
    project: projA
  });
  const revRes = await mcp.callTool('shadowgraph_review', { project: projA });
  const items = parseToolResult(revRes)?.items ?? [];
  assert.ok(items.length > 0);
  const signalId = items[0].reviewSignalId;

  // 2. An attacker in project B tries to acknowledge Alpha's signal by explicitly providing project: projB
  const hijackRes = await mcp.callTool('shadowgraph_ack_review', {
    reviewSignalId: signalId,
    project: projB
  });

  // Must fail because signal belongs to Alpha, and caller scoped to Beta
  assert.ok(hijackRes.result?.isError, 'Acknowledging cross-project signal with wrong project must fail');
  assert.equal(hijackRes.result.content[0].text, 'Review signal not found', 'Must fail closed with not found');
});

test('Stress M3: shadowgraph_ack_review input edge cases (missing params, nulls, empty strings)', async (t) => {
  const mcp = await startMcpHarness(t, {
    env: { SHADOWGRAPH_PROJECT: 'ack-edge-cases-proj' }
  });

  // Empty parameters
  const resEmpty = await mcp.callTool('shadowgraph_ack_review', {});
  assert.ok(resEmpty.result?.isError, 'Calling without id or reviewSignalId must fail');

  // Both empty strings
  const resEmptyStr = await mcp.callTool('shadowgraph_ack_review', {
    id: '',
    reviewSignalId: ''
  });
  assert.ok(resEmptyStr.result?.isError);

  // One empty string, one valid id
  const resOneEmpty = await mcp.callTool('shadowgraph_ack_review', {
    id: 'sig-valid',
    reviewSignalId: ''
  });
  // '' and 'sig-valid' are conflicting non-identical values
  assert.ok(resOneEmpty.result?.isError);
  assert.match(resOneEmpty.result.content[0].text, /Conflicting id and reviewSignalId provided/i);
});
