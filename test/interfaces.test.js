import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createShadowGraphServer } from '../src/server.js';
import { createJsonFileStore } from '../src/storage.js';

async function startServer(options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-http-'));
  const app = await createShadowGraphServer({ file: join(directory, 'data.json'), ...options });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const { port } = app.server.address();
  return { app, base: `http://127.0.0.1:${port}` };
}

test('HTTP API records and reviews decisions without wildcard CORS', async () => {
  const { app, base } = await startServer();
  try {
    const create = await fetch(`${base}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Database', chosen: 'PostgreSQL', alternatives: [{ label: 'SQLite', reopenWhen: ['local'] }] }) });
    assert.equal(create.status, 200);
    assert.equal(create.headers.get('access-control-allow-origin'), null);
    const review = await fetch(`${base}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ changedFacts: ['local'] }) });
    assert.equal((await review.json()).length, 1);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('HTTP API enforces optional bearer authentication', async () => {
  const { app, base } = await startServer({ apiToken: '1234567890123456' });
  try {
    assert.equal((await fetch(`${base}/health`)).status, 401);
    assert.equal((await fetch(`${base}/health`, { headers: { authorization: 'Bearer 1234567890123456' } })).status, 200);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('HTTP API returns a useful status for unknown decisions', async () => {
  const { app, base } = await startServer();
  try {
    const response = await fetch(`${base}/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ decisionId: 'missing', status: 'failed' }) });
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: 'decision not found' });
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('HTTP API preserves Unicode request text', async () => {
  const { app, base } = await startServer();
  try {
    const response = await fetch(`${base}/decisions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'قرار عربي 🚀', chosen: 'حل محلي' }) });
    assert.equal((await response.json()).title, 'قرار عربي 🚀');
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('HTTP API exposes traversal, supersession, redaction, and project purge', async () => {
  const { app, base } = await startServer();
  try {
    const post = async (path, body, method = 'POST') => fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = await (await post('/decisions', { project: 'private', title: 'Old', chosen: 'Bearer private-token' })).json();
    const second = await (await post('/decisions', { project: 'private', title: 'New', chosen: 'Safe' })).json();
    assert.equal((await post('/supersede', { decisionId: first.id, replacementId: second.id })).status, 200);
    const traversal = await (await post('/traverse', { id: second.id })).json();
    assert.equal(traversal.nodes.length, 2);
    const redacted = await (await post('/redact', { project: 'private' })).json();
    assert.equal(redacted.records.some((item) => item.chosen === 'Bearer [REDACTED]'), true);
    const purged = await (await post('/projects', { project: 'private' }, 'DELETE')).json();
    assert.equal(purged.removed, 2);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('HTTP API rejects oversized request bodies', async () => {
  const { app, base } = await startServer();
  try {
    const response = await fetch(`${base}/attempts`, { method: 'POST', body: 'x'.repeat(1024 * 1024 + 1) });
    assert.equal(response.status, 413);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

test('CLI persists a decision and reports stats', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-cli-'));
  const file = join(directory, 'data.json');
  const env = { ...process.env, SHADOWGRAPH_FILE: file };
  const run = (args) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', ...args], { cwd: process.cwd(), env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(stderr)));
  });
  await run(['decision', JSON.stringify({ title: 'Testing', chosen: 'Node' })]);
  const stats = await run(['stats']);
  assert.deepEqual(stats, { schemaVersion: 2, total: 1, decisions: 1, attempts: 0, facts: 0, relations: 0, reviewSignals: 0, events: 1 });
  assert.equal((await readFile(file, 'utf8')).includes('Testing'), true);
});

test('HTTP API rejects disallowed browser origins', async () => {
  const { app, base } = await startServer();
  try {
    const response = await fetch(`${base}/health`, { headers: { origin: 'https://evil.example' } });
    assert.equal(response.status, 403);
  } finally {
    await new Promise((resolve) => app.server.close(resolve));
  }
});

function readMcpResponses(child, expected) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const responses = [];
    const timer = setTimeout(() => { child.kill(); reject(new Error('Timed out waiting for MCP responses')); }, 5000);
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

test('MCP correlates validation errors to request ids', async () => {
  const child = spawn(process.execPath, ['src/mcp.js'], { cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: join(tmpdir(), 'shadowgraph-mcp-validation.json') } });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'shadowgraph_record_decision', arguments: { title: '' } } }) + '\n');
  const [response] = await readMcpResponses(child, 1);
  child.kill();
  assert.equal(response.id, 9);
  assert.equal(response.error.code, -32000);
});

test('MCP lists tools and returns parse errors', async () => {
  const child = spawn(process.execPath, ['src/mcp.js'], { cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: join(tmpdir(), 'shadowgraph-mcp-test.json') } });
  child.stdin.write('{bad json\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  const responses = await readMcpResponses(child, 2);
  child.kill();
  assert.equal(responses.some((item) => item.error?.code === -32700), true);
  assert.equal(responses.some((item) => item.result?.tools?.length === 22), true);
});
