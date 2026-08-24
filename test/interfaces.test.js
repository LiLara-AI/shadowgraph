import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createShadowGraphServer } from '../src/server.js';
import { createJsonFileStore } from '../src/storage.js';

async function startServer() {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-http-'));
  const app = await createShadowGraphServer({ file: join(directory, 'data.json') });
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
  assert.deepEqual(stats, { schemaVersion: 2, total: 1, decisions: 1, attempts: 0, facts: 0, events: 1 });
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

test('MCP correlates validation errors to request ids', async () => {
  const child = spawn(process.execPath, ['src/mcp.js'], { cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: join(tmpdir(), 'shadowgraph-mcp-validation.json') } });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'shadowgraph_record_decision', arguments: { title: '' } } }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill();
  const response = JSON.parse(output.trim());
  assert.equal(response.id, 9);
  assert.equal(response.error.code, -32000);
});

test('MCP lists tools and returns parse errors', async () => {
  const child = spawn(process.execPath, ['src/mcp.js'], { cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: join(tmpdir(), 'shadowgraph-mcp-test.json') } });
  const lines = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => lines.push(...chunk.trim().split('\n').filter(Boolean)));
  child.stdin.write('{bad json\n');
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  await new Promise((resolve) => setTimeout(resolve, 100));
  child.kill();
  const responses = lines.map((line) => JSON.parse(line));
  assert.equal(responses.some((item) => item.error?.code === -32700), true);
  assert.equal(responses.some((item) => item.result?.tools?.length === 7), true);
});
