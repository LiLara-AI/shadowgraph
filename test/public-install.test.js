import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createShadowGraphServer } from '../src/server.js';

const exec = promisify(execFile);

async function runCli(args, env) {
  return exec(process.execPath, ['src/cli.js', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env }
  });
}

function readOneResponse(child) {
  return new Promise((resolveResponse, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Timed out waiting for MCP response')), 5000);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      resolveResponse(JSON.parse(buffer.slice(0, newline)));
    });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
  });
}

test('CLI setup initializes a clean store and doctor reports actionable health', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph public install '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state folder', 'data.json');
  const env = { SHADOWGRAPH_FILE: file };

  const first = JSON.parse((await runCli(['setup'], env)).stdout);
  assert.deepEqual(first, {
    ok: true,
    command: 'setup',
    created: true,
    storage: { type: 'json', path: resolve(file) },
    next: 'Run `shadowgraph doctor`, then `shadowgraph remember <JSON>`.'
  });
  const payload = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(payload.schemaVersion, 5);
  assert.equal(payload.revision, 1);

  const doctor = JSON.parse((await runCli(['doctor'], env)).stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.command, 'doctor');
  assert.match(doctor.version, /^0\.40\.0$/);
  assert.equal(doctor.node.supported, true);
  assert.deepEqual(doctor.storage, { type: 'json', path: resolve(file), initialized: true, readable: true, writable: true });
  assert.equal(doctor.graph.valid, true);
  assert.equal(doctor.mcp.available, true);
  assert.equal(doctor.mcp.recommendedMode, 'compact');

  const second = JSON.parse((await runCli(['setup'], env)).stdout);
  assert.equal(second.created, false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 1, 'setup must not rewrite an existing store');
});

test('CLI setup rejects an unsupported storage selector with a fix', async () => {
  await assert.rejects(
    runCli(['setup'], { SHADOWGRAPH_STORAGE: 'postgres', SHADOWGRAPH_FILE: 'unused.json' }),
    (error) => {
      assert.match(error.stderr, /Unsupported SHADOWGRAPH_STORAGE "postgres"/);
      assert.match(error.stderr, /Use "json" or "sqlite"/);
      return true;
    }
  );
});

test('CLI mcp launches the compact stdio server used by client configurations', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph cli mcp '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ['src/cli.js', 'mcp'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: join(directory, 'data.json'),
      SHADOWGRAPH_MCP_COMPACT: '1'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  const response = readOneResponse(child);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`);
  assert.equal((await response).result.tools.length, 12);
});

test('dashboard is served locally, explains token handling, and does not bypass API auth', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph dashboard '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const app = await createShadowGraphServer({
    file: join(directory, 'data.json'),
    apiToken: '1234567890123456'
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise((resolveClose) => app.server.close(resolveClose)));
  const base = `http://127.0.0.1:${app.server.address().port}`;

  const dashboard = await fetch(`${base}/dashboard`);
  assert.equal(dashboard.status, 200);
  assert.match(dashboard.headers.get('content-type'), /^text\/html/);
  assert.equal(dashboard.headers.get('cache-control'), 'no-store');
  const html = await dashboard.text();
  assert.match(html, /local-only/i);
  assert.match(html, /not persisted/i);
  assert.match(html, /type="password"/i);
  assert.match(html, /Authorization/);

  assert.equal((await fetch(`${base}/health`)).status, 401);
  const health = await fetch(`${base}/health`, {
    headers: { authorization: 'Bearer 1234567890123456' }
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});
