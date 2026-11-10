import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createShadowGraphServer } from '../src/server.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

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
  const directory = await scratchDirectory(t, 'shadowgraph public install ');
  const file = join(directory, 'state folder', 'data.json');
  const env = { SHADOWGRAPH_FILE: file };

  const first = JSON.parse((await runCli(['setup'], env)).stdout);
  assert.deepEqual(first, {
    ok: true,
    command: 'setup',
    created: true,
    storage: { type: 'json', path: resolve(file) },
    next: 'Run `shadowgraph doctor`, then follow the decision/fact/review demo in docs/manual-usage.md.'
  });
  const payload = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(payload.schemaVersion, 7, 'a new store is written at the schema-7 writer version');
  assert.equal(payload.revision, 1);

  const doctor = JSON.parse((await runCli(['doctor'], env)).stdout);
  assert.equal(doctor.ok, true);
  assert.equal(doctor.command, 'doctor');
  assert.equal(doctor.version, JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version);
  assert.equal(doctor.node.supported, true);
  assert.deepEqual(doctor.storage, { type: 'json', path: resolve(file), initialized: true, readable: true, writable: true });
  assert.equal(doctor.graph.valid, true);
  assert.equal(doctor.graph.scope, 'store');
  assert.equal(doctor.graph.completeness.complete, false);
  assert.equal(doctor.graph.limitation.code, 'scoped_coverage');
  assert.deepEqual(doctor.extraction, {
    platformSupported: process.platform === 'win32',
    detail: process.platform === 'win32'
      ? 'Automatic extraction requires separate activation and a supported Claude Code host.'
      : 'Automatic extraction is unavailable on this platform; use the manual memory tools.'
  });
  assert.equal(doctor.mcp.available, true);
  assert.equal(doctor.mcp.defaultMode, 'full');
  assert.equal(doctor.mcp.recommendedMode, 'compact');
  assert.match(doctor.mcp.fullMode, /35\/36 tools \(default\)/u);

  const second = JSON.parse((await runCli(['setup'], env)).stdout);
  assert.equal(second.created, false);
  assert.equal(JSON.parse(await readFile(file, 'utf8')).revision, 1, 'setup must not rewrite an existing store');
});

test('CLI help and JSON errors explain the memory workflow and shell quoting', async (t) => {
  const help = await runCli(['--help'], {});
  assert.match(help.stdout, /Local-first decision and experience memory/u);
  assert.doesNotMatch(help.stdout, /Adversarial/u);
  assert.match(help.stdout, /full \(35\/36/u);
  assert.match(help.stdout, /Search decisions, attempts, and facts/u);

  const directory = await scratchDirectory(t, 'shadowgraph shell quoting ');
  await assert.rejects(
    runCli(['decision', String.raw`{\"project\":\"demo\"}`], { SHADOWGRAPH_FILE: join(directory, 'data.json') }),
    (error) => {
      assert.match(error.stderr, /Invalid JSON argument/u);
      assert.match(error.stderr, /In bash, wrap the JSON in single quotes/u);
      return true;
    }
  );
});

test('CLI serve warns when the loopback API has no token', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph serve warning ');
  const env = { ...process.env, SHADOWGRAPH_FILE: join(directory, 'data.json'), PORT: '0' };
  delete env.SHADOWGRAPH_API_TOKEN;
  const child = spawn(process.execPath, ['src/cli.js', 'serve'], {
    cwd: process.cwd(),
    env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  await new Promise((resolveListening, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timed out waiting for HTTP server: ${stderr}`)), 5000);
    child.on('error', reject);
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`HTTP server exited ${code}: ${stderr}`)); });
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.includes('ShadowGraph listening')) {
        clearTimeout(timer);
        resolveListening();
      }
    });
  });
  assert.match(stderr, /SHADOWGRAPH_API_TOKEN is not set/u);
  assert.match(stderr, /local processes can read and write/u);
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
  const directory = await scratchDirectory(t, 'shadowgraph cli mcp ');
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
  assert.equal((await response).result.tools.length, 16);
});

test('dashboard is served locally, explains token handling, and does not bypass API auth', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph dashboard ');
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
  assert.match(html, /Alternatives to reconsider/);
  assert.match(html, /id="reconsiderations"/);

  assert.equal((await fetch(`${base}/health`)).status, 401);
  const health = await fetch(`${base}/health`, {
    headers: { authorization: 'Bearer 1234567890123456' }
  });
  assert.equal(health.status, 200);
  assert.equal((await health.json()).ok, true);
});
