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

// Each transport forwards explicit write scope. Omitting it still refuses the
// mutation before resolving the ID, and invalid transitions preserve state.
test('lifecycle CLI forwards explicit scope and preserves durable state on refused transitions', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-lifecycle-cli-');
  const file = join(directory, 'data.json');
  const env = { ...process.env, SHADOWGRAPH_FILE: file };
  const run = async (command, payload) => {
    const { stdout } = await exec(process.execPath, ['src/cli.js', command, JSON.stringify(payload)], { cwd: process.cwd(), env });
    return JSON.parse(stdout);
  };
  const decision = await run('decision', { project: 'app', title: 'CLI lifecycle', chosen: 'A' });
  assert.equal(decision.status, 'proposed');
  const before = await readFile(file, 'utf8');
  for (const status of ['planned', 'validated']) {
    await assert.rejects(
      run('status', { decisionId: decision.id, status }),
      (error) => /write_scope_unresolved/.test(error.stderr)
    );
  }
  assert.equal(await readFile(file, 'utf8'), before);
  const planned = await run('status', { project: 'app', decisionId: decision.id, status: 'planned' });
  assert.equal(planned.id, decision.id);
  assert.equal(planned.status, 'planned');
  const afterPlanned = await readFile(file, 'utf8');
  assert.equal(JSON.parse(afterPlanned).records[0].status, 'planned');
  await assert.rejects(
    run('status', { project: 'app', decisionId: decision.id, status: 'validated' }),
    (error) => /Illegal decision status transition/.test(error.stderr)
  );
  assert.equal(await readFile(file, 'utf8'), afterPlanned);
});

test('lifecycle HTTP scopes successful status changes and keeps refusals atomic', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-lifecycle-http-');
  const file = join(directory, 'data.json');
  const app = await createShadowGraphServer({ file });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise((resolve) => app.server.close(resolve)));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = (path, body) => fetch(`${base}${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  });
  const decision = await (await post('/decisions', { project: 'app', title: 'HTTP lifecycle', chosen: 'A' })).json();
  const before = await (await fetch(`${base}/records?project=app`)).json();
  const beforeBytes = await readFile(file);
  assert.deepEqual(before.records.map((record) => record.status), ['proposed']);
  for (const status of ['planned', 'validated']) {
    const rejected = await post('/status', { decisionId: decision.id, status });
    assert.equal(rejected.status, 400);
    assert.equal((await rejected.json()).code, 'write_scope_unresolved');
  }
  assert.deepEqual(await (await fetch(`${base}/records?project=app`)).json(), before);
  assert.deepEqual(await readFile(file), beforeBytes);
  const plannedResponse = await post('/status', { project: 'app', decisionId: decision.id, status: 'planned' });
  assert.equal(plannedResponse.status, 200);
  const planned = await plannedResponse.json();
  assert.equal(planned.id, decision.id);
  assert.equal(planned.status, 'planned');
  const afterPlanned = await readFile(file);
  const plannedView = await (await fetch(`${base}/records?project=app`)).json();
  assert.deepEqual(plannedView.records.map((record) => record.status), ['planned']);
  const illegal = await post('/status', { project: 'app', decisionId: decision.id, status: 'validated' });
  assert.equal(illegal.status, 400);
  assert.match((await illegal.json()).error, /Illegal decision status transition/);
  assert.deepEqual(await (await fetch(`${base}/records?project=app`)).json(), plannedView);
  assert.deepEqual(await readFile(file), afterPlanned);
});

test('lifecycle MCP forwards explicit scope and modern tool errors preserve the durable graph exactly', async (t) => {
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
  const before = await readFile(file, 'utf8');
  for (const [index, status] of ['planned', 'validated'].entries()) {
    const unscoped = await call(2 + index, 'shadowgraph_update_status', { decisionId: decision.id, status });
    assert.equal(unscoped.error, undefined);
    assert.equal(unscoped.result.isError, true);
    assert.deepEqual(unscoped.result.content, [{ type: 'text', text: 'Tool execution failed' }]);
    assert.equal(await readFile(file, 'utf8'), before);
  }
  const planned = await call(4, 'shadowgraph_update_status', { project: 'app', decisionId: decision.id, status: 'planned' });
  assert.equal(planned.result.isError, false);
  const plannedDecision = JSON.parse(planned.result.content[0].text);
  assert.equal(plannedDecision.id, decision.id);
  assert.equal(plannedDecision.status, 'planned');
  const afterPlanned = await readFile(file, 'utf8');
  assert.equal(JSON.parse(afterPlanned).records[0].status, 'planned');
  const rejected = await call(5, 'shadowgraph_update_status', { project: 'app', decisionId: decision.id, status: 'validated' });
  assert.equal(rejected.error, undefined, 'modern tool failures use CallToolResult, not JSON-RPC error');
  assert.equal(rejected.result.isError, true);
  assert.equal(rejected.result.resultType, 'complete');
  assert.deepEqual(rejected.result.content, [{ type: 'text', text: 'Tool execution failed' }]);
  const publicFailure = JSON.stringify(rejected);
  assert.equal(publicFailure.includes(decision.id), false, 'modern tool failure disclosed the decision id');
  assert.equal(publicFailure.includes('write_scope_unresolved'), false, 'modern tool failure disclosed the raw refusal');
  assert.equal(publicFailure.includes('Illegal decision status transition'), false);
  assert.equal(await readFile(file, 'utf8'), afterPlanned);
});
