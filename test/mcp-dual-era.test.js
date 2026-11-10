import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { VERSION } from '../src/version.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const LEGACY_PROTOCOL = '2024-11-05';
const MODERN_PROTOCOL = '2026-07-28';
// Every revision this server implements, newest first, as server/discover and
// the -32022 error data report them.
const SUPPORTED_PROTOCOLS = [MODERN_PROTOCOL, '2025-11-25', '2025-06-18', '2025-03-26', LEGACY_PROTOCOL];

function modernParams(values = {}, protocolVersion = MODERN_PROTOCOL) {
  return {
    ...values,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': protocolVersion,
      'io.modelcontextprotocol/clientInfo': { name: 'shadowgraph-test', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    }
  };
}

async function startMcp(t, extraEnv = {}) {
  const directory = await scratchDirectory(t, 'shadowgraph-dual-era-');
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: join(directory, 'data.json'), ...extraEnv },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  t.after(() => child.kill());
  let buffer = '';
  const pending = [];
  const unsolicited = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      const waiter = pending.shift();
      if (waiter) waiter.resolve(response);
      else unsolicited.push(response);
    }
  });
  child.on('error', (error) => pending.shift()?.reject(error));
  return {
    unsolicited,
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    call(request, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Timed out waiting for MCP response to ${request.method}`)), timeoutMs);
        pending.push({
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); }
        });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    }
  };
}

function assertModernComplete(result) {
  assert.equal(result.resultType, 'complete');
  assert.deepEqual(result._meta['io.modelcontextprotocol/serverInfo'], { name: 'shadowgraph', version: VERSION });
}

test('MCP initialize answers a per-request-only revision with the latest handshake revision it implements', async (t) => {
  const rpc = await startMcp(t);
  const initialized = await rpc.call({
    jsonrpc: '2.0', id: 'legacy-init', method: 'initialize', params: {
      protocolVersion: MODERN_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'legacy-test', version: '1.0.0' }
    }
  });
  // 2026-07-28 removed the handshake, so it is not one this server can negotiate
  // here; the answer is the latest handshake revision it does implement.
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  assert.deepEqual(Object.keys(initialized.result.capabilities).sort(), ['prompts', 'resources', 'tools']);

  const listed = await rpc.call({ jsonrpc: '2.0', id: 'legacy-tools', method: 'tools/list', params: {} });
  assert.equal(listed.result.tools.length, 35);
  assert.equal(Object.hasOwn(listed.result, 'resultType'), false);
  const called = await rpc.call({
    jsonrpc: '2.0', id: 'legacy-call', method: 'tools/call',
    params: { name: 'shadowgraph_validate', arguments: {} }
  });
  assert.equal(Array.isArray(called.result.content), true);
  assert.equal(Object.hasOwn(called.result, 'resultType'), false);
});

test('MCP modern discovery and every advertised primitive use 2026-07-28 result contracts', async (t) => {
  const rpc = await startMcp(t);
  const discovered = await rpc.call({
    jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: modernParams()
  });
  assert.deepEqual(discovered.result.supportedVersions, SUPPORTED_PROTOCOLS);
  assert.deepEqual(Object.keys(discovered.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.equal(discovered.result.cacheScope, 'public');
  assert.equal(discovered.result.ttlMs, 0);
  assert.equal(discovered.result.instructions, [
    'Local-first decision and scoped temporal memory. Session tools/list defines the callable tools, schemas and effect hints.',
    'Naming convention: shadowgraph_record_<entity> creates ledger records (decision, attempt, fact, outcome); verb_noun tools mutate specific state (update_status, ack_review, confidence_evidence); single-verb primitives operate on one distinct artifact (search, retrieve, recall, context, expand, remember, review, reconsider, maintain, validate, supersede).',
    'Read layers (5 orthogonal targets): (1) shadowgraph_search matches decisions, attempts, and facts by every literal query term and structured filters; (2) shadowgraph_retrieve adds one-hop relationship graph neighbours around seed matches; (3) shadowgraph_recall ranks scoped userId/agentId/runId memories by fused lexical, vector, graph, and temporal RRF signals; (4) shadowgraph_context reads the read-only session startup briefing without saving signals; (5) shadowgraph_expand dereferences a recordId and revision digest handle into its full current record and rival records (for direct lookup without a digest handle, shadowgraph_search filters records and shadowgraph_reconsider inspects a decision by decisionId).',
    'Signal and health pipeline (6 orthogonal stages): (1) shadowgraph_maintain runs the clock-driven TTL sweep aging reviewAfter decisions to stale and expiring expiresAt facts; (2) shadowgraph_review scans open decisions against facts to persist due review signals; (3) shadowgraph_review_signals lists queued open/acknowledged signal records without reevaluating rules; (4) shadowgraph_ack_review acknowledges one signal by id or reviewSignalId without changing the decision; (5) shadowgraph_reconsider audits one decision by decisionId to produce a 3-way alternative viability proof table (grounded, contested, unevaluated); (6) shadowgraph_review_context loads the turn check-in briefing with synchronized signal IDs. Evaluation calls commit a revision even on repeats.',
    'Lifecycle and retirement completeness: shadowgraph_record_decision, shadowgraph_record_attempt, shadowgraph_record_fact, and shadowgraph_remember create entities; shadowgraph_confidence_evidence, shadowgraph_record_outcome, shadowgraph_update_status, and shadowgraph_supersede update decisions; shadowgraph_update_status (abandoned/archived) retires decisions non-destructively and shadowgraph_remember (DELETE) invalidates scoped memories; shadowgraph_validate diagnoses record, graph, and journal sequence integrity (while full mode adds shadowgraph_journal, shadowgraph_rebuild, and shadowgraph_repair_plan).',
    'Read-capable tools accepting accessId or grantId can save a bounded audit and revision when a key is presented. A grant widens reads, never write authority. IDs do not supply project/origin scope. Returned completeness and provenance describe the result limits.',
    'Full-only operator capabilities require an operator-selected Full session and reconnect. A named sibling is callable only when advertised. Profiles change advertisement, not stored memory or product capabilities.'
  ].join('\n'));
  assertModernComplete(discovered.result);

  const tools = await rpc.call({ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: modernParams() });
  assert.equal(tools.result.tools.length, 35);
  assert.equal(tools.result.cacheScope, 'public');
  assert.equal(tools.result.ttlMs, 0);
  assertModernComplete(tools.result);

  const call = await rpc.call({
    jsonrpc: '2.0', id: 'call', method: 'tools/call',
    params: modernParams({ name: 'shadowgraph_validate', arguments: {} })
  });
  assert.equal(call.result.isError, false);
  assertModernComplete(call.result);

  const resources = await rpc.call({ jsonrpc: '2.0', id: 'resources', method: 'resources/list', params: modernParams() });
  assert.equal(resources.result.resources.length, 1);
  assert.equal(resources.result.cacheScope, 'public');
  assert.equal(resources.result.ttlMs, 0);
  assertModernComplete(resources.result);

  const resource = await rpc.call({
    jsonrpc: '2.0', id: 'resource', method: 'resources/read',
    params: modernParams({ uri: 'shadowgraph://context' })
  });
  assert.equal(resource.result.contents[0].uri, 'shadowgraph://context');
  assert.equal(resource.result.cacheScope, 'private');
  assert.equal(resource.result.ttlMs, 0);
  assertModernComplete(resource.result);

  const prompts = await rpc.call({ jsonrpc: '2.0', id: 'prompts', method: 'prompts/list', params: modernParams() });
  assert.equal(prompts.result.prompts.length, 1);
  assert.equal(prompts.result.cacheScope, 'public');
  assert.equal(prompts.result.ttlMs, 0);
  assertModernComplete(prompts.result);

  const prompt = await rpc.call({
    jsonrpc: '2.0', id: 'prompt', method: 'prompts/get',
    params: modernParams({ name: 'shadowgraph_consequential_task' })
  });
  assert.equal(prompt.result.messages.length, 1);
  assert.equal(prompt.result.messages[0].content.text, "context returns one project's current decisions, stale facts, failed attempts, fired review conditions and conditions that could not be settled; retrieve returns the records matching a content query with their one-hop graph neighbours. ShadowGraph records decisions, assumptions, evidence, alternatives, attempts, facts and outcomes. A review signal stays open until it is acknowledged. agent_claimed and unverified facts are claims, not confirmations. Without a separately configured verifier nothing in ShadowGraph can be marked verified, so a stored claim is never a confirmation.");
  assertModernComplete(prompt.result);
});

test('MCP modern metadata, version, JSON-RPC, and tool errors remain distinguishable', async (t) => {
  const rpc = await startMcp(t);

  const missingMeta = await rpc.call({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} });
  assert.equal(missingMeta.error.code, -32602);

  const unsupported = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/list', params: modernParams({}, '2099-01-01')
  });
  assert.equal(unsupported.error.code, -32022);
  assert.deepEqual(unsupported.error.data, {
    supported: SUPPORTED_PROTOCOLS, requested: '2099-01-01'
  });

  const invalidRpc = await rpc.call({ jsonrpc: '1.0', id: 3, method: 'tools/list', params: modernParams() });
  assert.equal(invalidRpc.error.code, -32600);

  const unknownMethod = await rpc.call({ jsonrpc: '2.0', id: 30, method: 'unknown/method', params: modernParams() });
  assert.equal(unknownMethod.error.code, -32601);

  const unknownTool = await rpc.call({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: modernParams({ name: 'shadowgraph_missing', arguments: {} })
  });
  assert.equal(unknownTool.error.code, -32602);

  const executionFailure = await rpc.call({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: modernParams({
      name: 'shadowgraph_confidence_evidence',
      arguments: { project: 'p', decisionId: 'missing', reason: 'no such decision', key: 'missing' }
    })
  });
  assert.equal(executionFailure.error, undefined);
  assert.equal(executionFailure.result.isError, true);
  assert.equal(executionFailure.result.content[0].text, 'Tool execution failed (unknown_decision): field "decisionId" refers to an unknown decision');
  assert.deepEqual(executionFailure.result._meta['shadowgraph/error'], {
    issueCode: 'unknown_decision', fieldPath: 'decisionId', retryable: false
  });
  assert.equal(JSON.stringify(executionFailure).includes('missing'), false);
  assertModernComplete(executionFailure.result);
});

test('MCP modern notifications are accepted without any response', async (t) => {
  const rpc = await startMcp(t);
  rpc.send({
    jsonrpc: '2.0', method: 'notifications/cancelled',
    params: modernParams({ requestId: 'already-finished', reason: 'test cancellation' })
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.deepEqual(rpc.unsolicited, []);
  const listed = await rpc.call({ jsonrpc: '2.0', id: 'after-notification', method: 'tools/list', params: modernParams() });
  assert.equal(listed.id, 'after-notification');
  assert.equal(listed.result.tools.length, 35);
});

test('MCP modern compact mode advertises exactly 16 tools', async (t) => {
  const rpc = await startMcp(t, { SHADOWGRAPH_MCP_COMPACT: '1' });
  const listed = await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernParams() });
  assert.equal(listed.result.tools.length, 16);
  assertModernComplete(listed.result);
});
