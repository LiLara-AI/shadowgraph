import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createShadowGraphServer } from '../src/server.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const exec = promisify(execFile);
const MODERN_PROTOCOL = '2026-07-28';

function modernParams(values = {}) {
  return {
    ...values,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
      'io.modelcontextprotocol/clientInfo': { name: 'lifecycle-test', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    }
  };
}

test('lifecycle CLI accepts legal transitions and rejects illegal transitions without a durable write', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-lifecycle-cli-');
  const file = join(directory, 'data.json');
  const env = { ...process.env, SHADOWGRAPH_FILE: file };
  const run = async (command, payload) => {
    const { stdout } = await exec(process.execPath, ['src/cli.js', command, JSON.stringify(payload)], { cwd: process.cwd(), env });
    return JSON.parse(stdout);
  };
  const decision = await run('decision', { project: 'app', title: 'CLI lifecycle', chosen: 'A' });
  assert.equal(decision.status, 'proposed');
  assert.equal((await run('status', { decisionId: decision.id, status: 'planned' })).status, 'planned');
  const before = await readFile(file, 'utf8');
  await assert.rejects(
    run('status', { decisionId: decision.id, status: 'validated' }),
    (error) => /Illegal decision status transition: planned -> validated/.test(error.stderr)
  );
  assert.equal(await readFile(file, 'utf8'), before);
});

test('lifecycle HTTP rejects before state, event, journal, or durable mutation', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-lifecycle-http-');
  const app = await createShadowGraphServer({ file: join(directory, 'data.json') });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const decision = await (await post('/decisions', { project: 'app', title: 'HTTP lifecycle', chosen: 'A' })).json();
  assert.equal((await (await post('/status', { decisionId: decision.id, status: 'planned' })).json()).status, 'planned');
  const before = await (await fetch(`${base}/records`)).json();
  const rejected = await post('/status', { decisionId: decision.id, status: 'validated' });
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /Illegal decision status transition: planned -> validated/);
  assert.deepEqual(await (await fetch(`${base}/records`)).json(), before);
});

test('lifecycle MCP modern tool errors preserve the durable graph exactly', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-lifecycle-mcp-');
  const file = join(directory, 'data.json');
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: file }, stdio: ['pipe', 'pipe', 'inherit']
  });
  t.after(() => child.kill());
  let buffer = '';
  const pending = [];
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) pending.shift()?.(JSON.parse(line));
  });
  const call = (id, name, args) => new Promise((resolve) => {
    pending.push(resolve);
    child.stdin.write(`${JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: modernParams({ name, arguments: args })
    })}\n`);
  });
  const recorded = await call(1, 'shadowgraph_record_decision', { project: 'app', title: 'MCP lifecycle', chosen: 'A' });
  const decision = JSON.parse(recorded.result.content[0].text);
  const planned = await call(2, 'shadowgraph_update_status', { decisionId: decision.id, status: 'planned' });
  assert.equal(JSON.parse(planned.result.content[0].text).status, 'planned');
  const before = await readFile(file, 'utf8');
  const rejected = await call(3, 'shadowgraph_update_status', { decisionId: decision.id, status: 'validated' });
  assert.equal(rejected.error, undefined, 'modern tool failures use CallToolResult, not JSON-RPC error');
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.result.resultType, 'complete');
  assert.deepEqual(rejected.result.content, [{ type: 'text', text: 'Tool execution failed' }]);
  const publicFailure = JSON.stringify(rejected);
  assert.equal(publicFailure.includes(decision.id), false, 'modern tool failure disclosed the decision id');
  assert.equal(publicFailure.includes('Illegal decision status transition: planned -> validated'), false, 'modern tool failure disclosed the raw lifecycle diagnostic');
  assert.equal(await readFile(file, 'utf8'), before);
});
