// Regression tests for the INTERFACE findings of the independent review
// (2026-08-25): P1-3 version drift, P1-4 HTTP query typing, P1-5 JSON-RPC error
// codes, P1-6 notification handling, P1-7 resource/prompt validation.
//
// Each test fails on the pre-fix behaviour. Core findings live in
// test/review-findings.test.js.

import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createShadowGraphServer } from '../src/server.js';
import { VERSION } from '../src/version.js';

async function startServer(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-review-http-'));
  const app = await createShadowGraphServer({ file: join(directory, 'data.json'), ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const { port } = app.server.address();
  return { app, base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => app.server.close(resolve)) };
}

// ---------------------------------------------------------------------------
// P1-3 — one version, not three
// ---------------------------------------------------------------------------
// WAS BROKEN: /health returned a hardcoded '0.30.0' while package.json and
// src/mcp.js each carried their own literal. A version a client reads over HTTP
// is a contract, so a stale copy misreports which build is running.

test('P1-3: /health version matches package.json exactly', async () => {
  const packaged = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const { base, close } = await startServer();
  try {
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.version, packaged, 'health must not carry its own copy of the version');
    assert.equal(health.version, VERSION);
    assert.notEqual(health.version, '0.30.0', 'the stale hardcoded literal is gone');
    assert.equal(health.name, 'shadowgraph');
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// P1-4 — GET query parameters are typed at the transport boundary
// ---------------------------------------------------------------------------
// WAS BROKEN: a query string is all strings, so `?limit=2` reached the core as
// "2". Number.isInteger('2') is false, so a perfectly valid request FAILED — and
// an untyped minConfidence would have silently compared a string to a number.

test('P1-4: GET /search?limit=2 is honoured instead of rejected', async () => {
  const { base, close } = await startServer();
  try {
    for (let index = 0; index < 5; index += 1) {
      await fetch(`${base}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'p', title: `D${index}`, chosen: 'c' }) });
    }
    const response = await fetch(`${base}/search?project=p&limit=2`);
    assert.equal(response.status, 200, 'a valid paged GET must not 400');
    const body = await response.json();
    assert.equal(body.items.length, 2);
    assert.equal(body.page.limit, 2, 'limit arrived as a NUMBER');
    assert.equal(body.page.total, 5);
    assert.equal(body.page.hasMore, true);
    assert.equal(body.completeness.limitSource, 'caller');
  } finally {
    await close();
  }
});

test('P1-4: GET /journal?limit=2 pages the journal', async () => {
  const { base, close } = await startServer();
  try {
    for (let index = 0; index < 4; index += 1) {
      await fetch(`${base}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ project: 'p', title: `D${index}`, chosen: 'c' }) });
    }
    const body = await (await fetch(`${base}/journal?limit=2`)).json();
    assert.equal(body.items.length, 2);
    assert.equal(body.page.limit, 2);
    assert.ok(body.page.total >= 4);
    assert.equal(body.page.hasMore, true);
  } finally {
    await close();
  }
});

test('P1-4: offset and minConfidence are coerced to numbers', async () => {
  const { base, close } = await startServer();
  try {
    const post = (body) => fetch(`${base}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await post({ project: 'p', title: 'Low', chosen: 'c', confidence: 0.2 });
    await post({ project: 'p', title: 'High', chosen: 'c', confidence: 0.9 });

    const offsetPage = await (await fetch(`${base}/search?project=p&limit=1&offset=1`)).json();
    assert.equal(offsetPage.page.offset, 1, 'offset arrived as a number');
    assert.equal(offsetPage.items.length, 1);

    const filtered = await (await fetch(`${base}/search?project=p&minConfidence=0.5`)).json();
    assert.equal(filtered.page.total, 1, 'minConfidence compared numerically, not as a string');
    assert.equal(filtered.items[0].record.title, 'High');
  } finally {
    await close();
  }
});

test('P1-4: an uncoercible query parameter is a clear 400, never a silent guess', async () => {
  const { base, close } = await startServer();
  try {
    for (const query of ['limit=abc', 'limit=1.5', 'offset=xyz', 'minConfidence=high']) {
      const response = await fetch(`${base}/search?${query}`);
      assert.equal(response.status, 400, query);
      const body = await response.json();
      assert.match(body.error, /Query parameter (limit|offset|minConfidence) must be/, query);
    }
  } finally {
    await close();
  }
});

test('P1-4: an invalid page limit from the core still surfaces as 400', async () => {
  // Coercible but out of contract: 0 is an integer, so the transport passes it
  // and the CORE rejects it. Both layers must refuse, not one silently clamp.
  const { base, close } = await startServer();
  try {
    const response = await fetch(`${base}/search?limit=0`);
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /Page limit must be an integer/);
  } finally {
    await close();
  }
});

// ---------------------------------------------------------------------------
// MCP stdio harness
// ---------------------------------------------------------------------------
function spawnMcp(label) {
  return spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: join(tmpdir(), `shadowgraph-review-${label}-${Date.now()}.json`) }
  });
}

function collect(child, expected, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const responses = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Timed out waiting for ${expected} MCP responses, got ${responses.length}`)); }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        responses.push(JSON.parse(line));
        if (responses.length >= expected) { clearTimeout(timer); resolve(responses); }
      }
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

// Collect everything that arrives within a window. Used to prove a response was
// NOT sent — an assertion that cannot be made by waiting for a fixed count.
function collectFor(child, windowMs = 1200) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const responses = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      for (const line of lines) if (line.trim()) responses.push(JSON.parse(line));
    });
    child.on('error', reject);
    setTimeout(() => resolve(responses), windowMs);
  });
}

const send = (child, message) => child.stdin.write(JSON.stringify(message) + '\n');

// ---------------------------------------------------------------------------
// P1-5 — JSON-RPC error codes are preserved
// ---------------------------------------------------------------------------
// WAS BROKEN: the catch block rebuilt a plain object and hardcoded -32000, so
// every distinct failure flattened into one opaque code. A client could not tell
// "no such tool" from a genuine internal error.

test('P1-5: an unknown TOOL returns -32601 (method not found)', async () => {
  const child = spawnMcp('unknown-tool');
  try {
    send(child, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'shadowgraph_does_not_exist', arguments: {} } });
    const [response] = await collect(child, 1);
    assert.equal(response.id, 1);
    assert.equal(response.error.code, -32601, 'must not be flattened to -32000');
    assert.match(response.error.message, /Unknown tool/);
  } finally {
    child.kill();
  }
});

test('P1-5: an unknown METHOD returns -32601, not an empty result', async () => {
  const child = spawnMcp('unknown-method');
  try {
    send(child, { jsonrpc: '2.0', id: 2, method: 'totally/unknown' });
    const [response] = await collect(child, 1);
    assert.equal(response.id, 2);
    assert.equal(response.error.code, -32601);
    assert.equal(response.result, undefined, 'an unknown method must not answer with {}');
  } finally {
    child.kill();
  }
});

test('P1-5: malformed params return -32602 (invalid params)', async () => {
  const child = spawnMcp('invalid-params');
  try {
    // params must be an object, arguments must be an object, tools/call needs params.
    send(child, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: [] });
    send(child, { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shadowgraph_validate', arguments: [] } });
    send(child, { jsonrpc: '2.0', id: 5, method: 'tools/call' });
    const responses = await collect(child, 3);
    for (const id of [3, 4, 5]) {
      const response = responses.find((item) => item.id === id);
      assert.ok(response, `no response for id ${id}`);
      assert.equal(response.error.code, -32602, `id ${id} must be -32602`);
    }
  } finally {
    child.kill();
  }
});

test('P1-5: a genuine tool failure stays distinguishable from a protocol error', async () => {
  const child = spawnMcp('tool-failure');
  try {
    send(child, { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'shadowgraph_update_status', arguments: { decisionId: 'nope', status: 'validated' } } });
    const [response] = await collect(child, 1);
    assert.equal(response.id, 6);
    assert.equal(response.error.code, -32000, 'application errors keep the generic code');
    assert.match(response.error.message, /Decision not found/);
  } finally {
    child.kill();
  }
});

test('P1-5: unparseable JSON returns -32700', async () => {
  const child = spawnMcp('parse-error');
  try {
    child.stdin.write('{not json\n');
    const [response] = await collect(child, 1);
    assert.equal(response.error.code, -32700);
    assert.equal(response.id, null, 'a parse error has no recoverable id');
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------------------
// P1-6 — notifications are never answered
// ---------------------------------------------------------------------------
// WAS BROKEN: an unrecognised method fell through to reply(request.id, {}),
// emitting {"id":null,"result":{}} for a notification. A JSON-RPC notification
// has no `id` and MUST NOT receive a response; a strict client can treat the
// stray message as a protocol violation.

test('P1-6: notifications/initialized receives NO response', async () => {
  const child = spawnMcp('notification');
  try {
    send(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(child, { jsonrpc: '2.0', id: 77, method: 'tools/list' });
    const responses = await collectFor(child);
    assert.equal(responses.length, 1, `expected exactly one response, got ${JSON.stringify(responses.map((item) => item.id))}`);
    assert.equal(responses[0].id, 77, 'the only reply belongs to the request that had an id');
    assert.equal(responses.some((item) => item.id === null), false, 'no id:null message was emitted');
  } finally {
    child.kill();
  }
});

test('P1-6: an UNKNOWN notification is also unanswered', async () => {
  const child = spawnMcp('unknown-notification');
  try {
    send(child, { jsonrpc: '2.0', method: 'notifications/somethingNew' });
    // A method with no id that is not under notifications/ is still a notification.
    send(child, { jsonrpc: '2.0', method: 'totally/unknown' });
    send(child, { jsonrpc: '2.0', id: 88, method: 'tools/list' });
    const responses = await collectFor(child);
    assert.equal(responses.length, 1, `expected one response, got ${JSON.stringify(responses)}`);
    assert.equal(responses[0].id, 88);
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------------------
// P1-7 — resources and prompts validate their target
// ---------------------------------------------------------------------------
// WAS BROKEN: resources/read returned the real context payload for ANY uri, and
// prompts/get returned the policy text for ANY name. That told a client its
// request had succeeded when the server had actually ignored what was asked for.

test('P1-7: resources/read rejects an unknown URI instead of substituting context', async () => {
  const child = spawnMcp('resource-unknown');
  try {
    send(child, { jsonrpc: '2.0', id: 10, method: 'resources/read', params: { uri: 'shadowgraph://not-a-real-resource' } });
    send(child, { jsonrpc: '2.0', id: 11, method: 'resources/read', params: {} });
    const responses = await collect(child, 2);
    const unknown = responses.find((item) => item.id === 10);
    assert.equal(unknown.error.code, -32602);
    assert.match(unknown.error.message, /Unknown resource URI/);
    assert.equal(unknown.result, undefined, 'no context payload for an unknown URI');
    assert.equal(responses.find((item) => item.id === 11).error.code, -32602, 'a missing uri is invalid params');
  } finally {
    child.kill();
  }
});

test('P1-7: resources/read still serves the KNOWN URI', async () => {
  const child = spawnMcp('resource-known');
  try {
    send(child, { jsonrpc: '2.0', id: 12, method: 'resources/read', params: { uri: 'shadowgraph://context' } });
    const [response] = await collect(child, 1);
    assert.equal(response.error, undefined);
    assert.equal(response.result.contents[0].uri, 'shadowgraph://context');
    assert.ok(JSON.parse(response.result.contents[0].text).completeness, 'context still declares completeness');
  } finally {
    child.kill();
  }
});

test('P1-7: prompts/get rejects an unknown prompt name', async () => {
  const child = spawnMcp('prompt-unknown');
  try {
    send(child, { jsonrpc: '2.0', id: 13, method: 'prompts/get', params: { name: 'not_a_prompt' } });
    send(child, { jsonrpc: '2.0', id: 14, method: 'prompts/get', params: {} });
    const responses = await collect(child, 2);
    const unknown = responses.find((item) => item.id === 13);
    assert.equal(unknown.error.code, -32602);
    assert.match(unknown.error.message, /Unknown prompt/);
    assert.equal(unknown.result, undefined, 'no policy text for an unknown prompt');
    assert.equal(responses.find((item) => item.id === 14).error.code, -32602);
  } finally {
    child.kill();
  }
});

test('P1-7: prompts/get still serves the KNOWN prompt, and it tells the truth about verification', async () => {
  const child = spawnMcp('prompt-known');
  try {
    send(child, { jsonrpc: '2.0', id: 15, method: 'prompts/get', params: { name: 'shadowgraph_consequential_task' } });
    const [response] = await collect(child, 1);
    assert.equal(response.error, undefined);
    const text = response.result.messages[0].content.text;
    // G2/U-1: the policy must not imply a fact can be confirmed inside ShadowGraph.
    assert.match(text, /nothing in ShadowGraph can be marked verified/i);
  } finally {
    child.kill();
  }
});

// ---------------------------------------------------------------------------
// P1-3 / protocol honesty at the MCP layer
// ---------------------------------------------------------------------------
test('P1-3/P1-7: initialize never echoes a revision the server does not implement, and reports one version', async () => {
  const packaged = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  const child = spawnMcp('initialize');
  try {
    // A client asking for a revision this server does not implement is answered
    // with the latest one it does, never an echo of the request. 2026-07-28 has no
    // handshake at all, so it can only be reached through per-request metadata.
    send(child, { jsonrpc: '2.0', id: 20, method: 'initialize', params: { protocolVersion: '2026-07-28' } });
    send(child, { jsonrpc: '2.0', id: 21, method: 'initialize', params: { protocolVersion: 42 } });
    const responses = await collect(child, 2);

    const initialized = responses.find((item) => item.id === 20);
    assert.equal(initialized.result.protocolVersion, '2025-11-25', 'no false claim of modern-era support');
    assert.equal(initialized.result.serverInfo.version, packaged, 'one version, from package.json');

    assert.equal(responses.find((item) => item.id === 21).error.code, -32602, 'a non-string protocolVersion is invalid params');
  } finally {
    child.kill();
  }
});
