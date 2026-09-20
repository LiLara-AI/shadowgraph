// Reconsideration across the surfaces a client actually reaches, plus the
// runtime session provenance that arrived with it.
//
// End-to-end through the real servers rather than the core API, because what is
// asserted here are surface properties: whether the tool is advertised in
// compact mode at all, whether a caller-supplied sessionId is still accepted,
// and whether HTTP and CLI carry the same answer. A core-level test would pass
// while any of those were broken.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

function client(file, env = {}) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    env: { ...process.env, SHADOWGRAPH_FILE: file, ...env },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const resolve = pending.get(message.id);
      if (resolve) { pending.delete(message.id); resolve(message); }
    }
  });
  let nextId = 1;
  const send = (method, params) => new Promise((resolve, reject) => {
    const id = nextId += 1;
    pending.set(id, resolve);
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`timed out: ${method}`)); }, 10_000);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const call = async (name, args = {}) => {
    const message = await send('tools/call', { name, arguments: args });
    assert.ok(!message.error, `${name} failed: ${JSON.stringify(message.error)}`);
    return JSON.parse(message.result.content[0].text);
  };
  return { child, send, call, stop: () => child.kill() };
}

const decision = {
  project: 'p',
  title: 'Serve reads from the local replica',
  chosen: 'local-replica',
  alternatives: [{
    label: 'primary-only',
    reasonRejected: 'replica latency was acceptable',
    reopenWhen: [{ key: 'replicaLagMs', operator: 'greater_than', value: 500, unit: 'ms' }]
  }]
};

// --- M: the tool exists on both surfaces and carries the contract ----------

test('compact mode advertises reconsideration and answers with a verdict and its evidence', async (t) => {
  const directory = await scratchDirectory(t, 'reconsider-compact-');
  const rpc = client(join(directory, 'data.json'), { SHADOWGRAPH_MCP_COMPACT: '1' });
  t.after(() => rpc.stop());

  const listed = await rpc.send('tools/list', {});
  const names = listed.result.tools.map((tool) => tool.name);
  assert.ok(names.includes('shadowgraph_reconsider'), 'a compact client can reach reconsideration');
  assert.ok(names.includes('shadowgraph_ack_review'), 'and can still close what it raises');

  await rpc.call('shadowgraph_record_decision', decision);

  // No evidence yet: uncertainty, never a clean pass.
  const unevaluated = await rpc.call('shadowgraph_reconsider', { project: 'p' });
  assert.equal(unevaluated.verdict, 'manual_review');
  assert.equal(unevaluated.evaluationCompleteness, 'partial');
  assert.equal(unevaluated.decisions[0].rulesNotEvaluated.length, 1);

  await rpc.call('shadowgraph_record_fact', { project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'tool_observed' });

  const recommended = await rpc.call('shadowgraph_reconsider', { project: 'p' });
  assert.equal(recommended.verdict, 'review_recommended');
  assert.equal(recommended.evaluationCompleteness, 'complete');
  assert.equal(recommended.decisions[0].triggeredRules[0].key, 'replicaLagMs');

  // The signal it raises is nameable and closable from compact alone.
  const signalId = recommended.decisions[0].reviewSignalId;
  assert.ok(signalId, 'the entry names the signal a client must acknowledge');
  const acknowledged = await rpc.call('shadowgraph_ack_review', { id: signalId });
  assert.equal(acknowledged.status, 'acknowledged');

  const settled = await rpc.call('shadowgraph_reconsider', { project: 'p' });
  assert.equal(settled.decisions[0].reviewSignalId, signalId, 'a repeat raises no second signal');
  assert.equal(settled.decisions[0].reviewSignalStatus, 'acknowledged');
});

test('full mode advertises reconsideration and fails closed on an unaddressable decision', async (t) => {
  const directory = await scratchDirectory(t, 'reconsider-full-');
  const rpc = client(join(directory, 'data.json'));
  t.after(() => rpc.stop());

  const listed = await rpc.send('tools/list', {});
  assert.ok(listed.result.tools.some((tool) => tool.name === 'shadowgraph_reconsider'));

  const recorded = await rpc.call('shadowgraph_record_decision', decision);
  await rpc.call('shadowgraph_record_decision', { ...decision, project: 'other' });

  // An unknown id, and an id belonging to another project, are errors rather
  // than an empty result that would read as "checked, and this is fine".
  const unknown = await rpc.send('tools/call', { name: 'shadowgraph_reconsider', arguments: { project: 'p', decisionId: 'decision_missing' } });
  assert.ok(unknown.error || unknown.result?.isError, 'an unknown decision id must not answer unchanged');

  const crossProject = await rpc.send('tools/call', { name: 'shadowgraph_reconsider', arguments: { project: 'other', decisionId: recorded.id } });
  assert.ok(crossProject.error || crossProject.result?.isError, 'a cross-project decision id must not answer unchanged');
});

// --- N: session provenance the runtime knows, legacy sessionId accepted ----

test('an MCP write carries the runtime session, and a caller-supplied sessionId is still accepted', async (t) => {
  const directory = await scratchDirectory(t, 'reconsider-session-');
  const file = join(directory, 'data.json');
  const rpc = client(file);
  t.after(() => rpc.stop());

  // A legacy client that still sends its own sessionId must not be rejected.
  const fact = await rpc.call('shadowgraph_record_fact', {
    project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'tool_observed',
    sessionId: 'legacy-caller-session', actor: 'legacy-client'
  });
  assert.ok(fact.id, 'the legacy argument is accepted, not an error');

  const second = await rpc.call('shadowgraph_record_fact', { project: 'p', key: 'region', value: 'eu-west', sourceClass: 'tool_observed' });

  // Runtime provenance is authoritative: it supersedes the asserted value, and
  // every write in one process shares it.
  const graph = createShadowGraph();
  graph.importData(JSON.parse(await readFile(file, 'utf8')));
  const stored = graph.exportData().facts;
  const first = stored.find((item) => item.id === fact.id);
  const other = stored.find((item) => item.id === second.id);

  assert.match(first.sessionId, /^mcp_/, 'the runtime session is recorded');
  assert.notEqual(first.sessionId, 'legacy-caller-session', 'asserted provenance does not outrank observed provenance');
  assert.equal(first.sessionId, other.sessionId, 'every write in one MCP process shares one session');
  assert.equal(first.actor, 'legacy-client', 'other caller-owned provenance is untouched');
});

// --- O: HTTP and CLI carry the same answer --------------------------------

test('the HTTP surface exposes reconsideration with the same verdict as the core', async (t) => {
  const directory = await scratchDirectory(t, 'reconsider-http-');
  const app = await createShadowGraphServer({ file: join(directory, 'data.json') });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  t.after(() => app.server.close());
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const post = async (path, body) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
    });
    return { status: response.status, body: await response.json() };
  };

  assert.equal((await post('/decisions', decision)).status, 200);
  assert.equal((await post('/facts', { project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'tool_observed' })).status, 200);

  const reconsidered = await post('/reconsider', { project: 'p' });
  assert.equal(reconsidered.status, 200);
  assert.equal(reconsidered.body.verdict, 'review_recommended');
  assert.equal(reconsidered.body.evaluationCompleteness, 'complete');
  assert.equal(reconsidered.body.decisions[0].triggeredRules[0].key, 'replicaLagMs');
});

test('the CLI exposes reconsideration and prints the same verdict', async (t) => {
  const directory = await scratchDirectory(t, 'reconsider-cli-');
  const file = join(directory, 'data.json');

  const run = (command, input) => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['src/cli.js', command, ...(input ? [input] : [])], {
      env: { ...process.env, SHADOWGRAPH_FILE: file },
      stdio: ['ignore', 'pipe', 'inherit']
    });
    let out = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${command} exited ${code}`))));
  });

  await run('decision', JSON.stringify(decision));
  await run('fact', JSON.stringify({ project: 'p', key: 'replicaLagMs', value: '900ms', sourceClass: 'tool_observed' }));

  const output = JSON.parse(await run('reconsider', JSON.stringify({ project: 'p' })));
  assert.equal(output.verdict, 'review_recommended');
  assert.equal(output.evaluationCompleteness, 'complete');
  assert.equal(output.decisions[0].affectedAlternatives[0], 'primary-only');
});
