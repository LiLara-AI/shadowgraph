import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { VERSION } from '../src/version.js';

const LEGACY_PROTOCOL = '2024-11-05';
const MODERN_PROTOCOL = '2026-07-28';

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
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-dual-era-'));
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

test('MCP legacy initialize negotiates 2024-11-05 while preserving legacy result shapes', async (t) => {
  const rpc = await startMcp(t);
  const initialized = await rpc.call({
    jsonrpc: '2.0', id: 'legacy-init', method: 'initialize', params: {
      protocolVersion: MODERN_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'legacy-test', version: '1.0.0' }
    }
  });
  assert.equal(initialized.result.protocolVersion, LEGACY_PROTOCOL);
  assert.deepEqual(Object.keys(initialized.result.capabilities).sort(), ['prompts', 'resources', 'tools']);

  const listed = await rpc.call({ jsonrpc: '2.0', id: 'legacy-tools', method: 'tools/list', params: {} });
  assert.equal(listed.result.tools.length, 27);
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
  assert.deepEqual(discovered.result.supportedVersions, [MODERN_PROTOCOL, LEGACY_PROTOCOL]);
  assert.deepEqual(Object.keys(discovered.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.equal(discovered.result.cacheScope, 'public');
  assert.equal(discovered.result.ttlMs, 0);
  assertModernComplete(discovered.result);

  const tools = await rpc.call({ jsonrpc: '2.0', id: 'tools', method: 'tools/list', params: modernParams() });
  assert.equal(tools.result.tools.length, 27);
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
    supported: [MODERN_PROTOCOL, LEGACY_PROTOCOL], requested: '2099-01-01'
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
      name: 'shadowgraph_update_status',
      arguments: { decisionId: 'missing', status: 'planned' }
    })
  });
  assert.equal(executionFailure.error, undefined);
  assert.equal(executionFailure.result.isError, true);
  assert.match(executionFailure.result.content[0].text, /Decision not found/);
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
  assert.equal(listed.result.tools.length, 27);
});

test('MCP modern compact mode advertises exactly 12 tools', async (t) => {
  const rpc = await startMcp(t, { SHADOWGRAPH_MCP_COMPACT: '1' });
  const listed = await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: modernParams() });
  assert.equal(listed.result.tools.length, 12);
  assertModernComplete(listed.result);
});
