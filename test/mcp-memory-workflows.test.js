import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

function startJsonRpcChild(file, embeddingUrl, compact = true) {
  const child = spawn(process.execPath, ['src/mcp.js'], {
    env: {
      ...process.env,
      SHADOWGRAPH_FILE: file,
      SHADOWGRAPH_MCP_COMPACT: compact ? '1' : '0',
      ...(embeddingUrl ? {
        SHADOWGRAPH_EMBEDDING_URL: embeddingUrl,
        SHADOWGRAPH_EMBEDDING_MODEL: 'test-embedding'
      } : {})
    },
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let buffer = '';
  const pending = [];
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines.filter(Boolean)) pending.shift()?.(JSON.parse(line));
  });
  return {
    child,
    call(request) {
      const response = new Promise((resolve) => pending.push(resolve));
      child.stdin.write(`${JSON.stringify(request)}\n`);
      return response;
    }
  };
}

test('MCP exposes simple remember/recall workflows and uses an explicit local embedder', async (t) => {
  const embeddingRequests = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body);
      embeddingRequests.push(payload);
      if (payload.input === 'boutique hotels') {
        response.writeHead(503, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'embedder unavailable' }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ data: [{ embedding: [1, 0] }] }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const address = server.address();
  const directory = await scratchDirectory(t, 'shadowgraph-mcp-memory-');
  const rpc = startJsonRpcChild(join(directory, 'data.json'), `http://127.0.0.1:${address.port}/v1`);
  t.after(() => rpc.child.kill());

  const listed = await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const names = listed.result.tools.map((tool) => tool.name);
  assert.equal(names.includes('shadowgraph_remember'), true);
  assert.equal(names.includes('shadowgraph_recall'), true);
  assert.equal(names.length, 16);
  assert.equal(Object.hasOwn(listed.result.tools.find((tool) => tool.name === 'shadowgraph_recall'), 'annotations'), false);

  const remembered = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'shadowgraph_remember',
      arguments: {
        project: 'trip', scope: { userId: 'alice' }, memoryType: 'preference',
        key: 'hotel-style', text: 'Prefers quiet boutique hotels'
      }
    }
  });
  const rememberPayload = JSON.parse(remembered.result.content[0].text);
  assert.equal(rememberPayload.operation, 'ADD');
  assert.deepEqual(rememberPayload.memory.embedding, { model: 'test-embedding', values: [1, 0] });

  const recalled = await rpc.call({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'shadowgraph_recall',
      arguments: { project: 'trip', scope: { userId: 'alice' }, query: 'lodging taste', limit: 5 }
    }
  });
  const recallPayload = JSON.parse(recalled.result.content[0].text);
  assert.equal(recallPayload.items[0].record.text, 'Prefers quiet boutique hotels');
  assert.equal(recallPayload.signals.semantic.available, true);
  const fallback = await rpc.call({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'shadowgraph_recall',
      arguments: { project: 'trip', scope: { userId: 'alice' }, query: 'boutique hotels', limit: 5 }
    }
  });
  const fallbackPayload = JSON.parse(fallback.result.content[0].text);
  assert.equal(fallbackPayload.items[0].record.text, 'Prefers quiet boutique hotels');
  assert.equal(fallbackPayload.signals.semantic.available, false);
  assert.match(fallbackPayload.signals.semantic.reason, /Configured embedding provider failed/);
  assert.deepEqual(embeddingRequests.map((request) => request.input), ['Prefers quiet boutique hotels', 'lodging taste', 'boutique hotels']);
});

test('MCP rolls live memory back when ordinary persistence fails', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-mcp-persist-fail-');
  const file = join(directory, 'data.json');
  const rpc = startJsonRpcChild(file);
  t.after(() => rpc.child.kill());

  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const baseline = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'shadowgraph_remember',
      arguments: { project: 'app', memoryType: 'note', key: 'baseline', text: 'Durable baseline' }
    }
  });
  assert.equal(JSON.parse(baseline.result.content[0].text).operation, 'ADD');
  await unlink(file);
  await mkdir(file);

  const failed = await rpc.call({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'shadowgraph_remember',
      arguments: { project: 'app', memoryType: 'note', key: 'transient', text: 'Must roll back' }
    }
  });
  assert.equal(failed.result, undefined, 'legacy tool failures use the numeric JSON-RPC error form');
  assert.deepEqual(failed.error, { code: -32000, message: 'Tool execution failed' });
  const publicFailure = JSON.stringify(failed);
  for (const privateValue of [file, 'transient', 'Must roll back']) {
    assert.equal(publicFailure.includes(privateValue), false, `persistence failure disclosed ${privateValue}`);
  }
  assert.doesNotMatch(publicFailure, /rename|directory|EPERM|EISDIR|storage/i, 'persistence failure disclosed an OS/storage diagnostic');

  const recalled = await rpc.call({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'shadowgraph_recall', arguments: { project: 'app', query: '' }
    }
  });
  const keys = JSON.parse(recalled.result.content[0].text).items.map((item) => item.record.key);
  assert.deepEqual(keys, ['baseline']);
});

test('MCP context persists review signals that it creates', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-mcp-context-');
  const file = join(directory, 'data.json');
  const seed = createShadowGraph({ now: () => '2026-08-27T00:00:00.000Z' });
  seed.addDecision({
    id: 'due-decision', project: 'app', title: 'Due review', chosen: 'A',
    reviewAfter: '2026-01-01T00:00:00.000Z'
  });
  await writeFile(file, JSON.stringify(seed.exportData()), 'utf8');
  const rpc = startJsonRpcChild(file);
  t.after(() => rpc.child.kill());

  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const response = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'shadowgraph_context', arguments: { project: 'app' }
    }
  });
  const payload = JSON.parse(response.result.content[0].text);
  assert.equal(payload.openReviews.length, 1);
  const durable = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(durable.reviewSignals.length, 1);
  assert.equal(durable.reviewSignals[0].decisionId, 'due-decision');
});

test('MCP context resource persists review signals that it creates', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-mcp-resource-context-');
  const file = join(directory, 'data.json');
  const seed = createShadowGraph({ now: () => '2026-08-27T00:00:00.000Z' });
  seed.addDecision({
    id: 'resource-due', project: 'default', title: 'Resource due review', chosen: 'A',
    reviewAfter: '2026-01-01T00:00:00.000Z'
  });
  await writeFile(file, JSON.stringify(seed.exportData()), 'utf8');
  const rpc = startJsonRpcChild(file);
  t.after(() => rpc.child.kill());

  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
  const response = await rpc.call({
    jsonrpc: '2.0', id: 2, method: 'resources/read', params: { uri: 'shadowgraph://context' }
  });
  const payload = JSON.parse(response.result.contents[0].text);
  assert.equal(payload.openReviews.length, 1);
  const durable = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(durable.reviewSignals.length, 1);
  assert.equal(durable.reviewSignals[0].decisionId, 'resource-due');
});

test('MCP serializes restore with a concurrent acknowledged memory write', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-mcp-restore-race-');
  const file = join(directory, 'data.json');
  const sourceFile = join(directory, 'source.json');
  const empty = createShadowGraph();
  await writeFile(file, JSON.stringify(empty.exportData()), 'utf8');
  const source = createShadowGraph({ now: () => '2026-08-27T00:00:00.000Z' });
  for (let index = 0; index < 2500; index += 1) {
    source.addDecision({ id: `restored-${index}`, project: 'restored', title: `Restored ${index}`, chosen: 'A' });
  }
  await writeFile(sourceFile, JSON.stringify(source.exportData()), 'utf8');
  const rpc = startJsonRpcChild(file, undefined, false);
  t.after(() => rpc.child.kill());
  await rpc.call({ jsonrpc: '2.0', id: 1, method: 'tools/list' });

  const restoring = rpc.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'shadowgraph_restore', arguments: { source: sourceFile }
    }
  });
  const remembering = rpc.call({
    jsonrpc: '2.0', id: 3, method: 'tools/call', params: {
      name: 'shadowgraph_remember', arguments: { project: 'app', memoryType: 'note', key: 'concurrent', text: 'Must survive' }
    }
  });
  const [restoreResponse, rememberResponse] = await Promise.all([restoring, remembering]);
  assert.equal(restoreResponse.error, undefined);
  assert.equal(rememberResponse.error, undefined);

  const recalled = await rpc.call({
    jsonrpc: '2.0', id: 4, method: 'tools/call', params: {
      name: 'shadowgraph_recall', arguments: { project: 'app', query: '' }
    }
  });
  const keys = JSON.parse(recalled.result.content[0].text).items.map((item) => item.record.key);
  assert.deepEqual(keys, ['concurrent']);
});

test('MCP JSON restart persists the complete decision, attempt, and fact workflow', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-mcp-complete-workflow-');
  const file = join(directory, 'data.json');
  const decision = {
    project: 'p', title: 'API import', chosen: 'serial import',
    reviewAfter: '2026-11-09T00:00:00.000Z'
  };
  const first = startJsonRpcChild(file);
  t.after(() => first.child.kill());

  const decisionResponse = await first.call({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'shadowgraph_record_decision', arguments: decision }
  });
  assert.equal(decisionResponse.error, undefined, decisionResponse.error?.message);
  const decisionId = JSON.parse(decisionResponse.result.content[0].text).id;
  const attempt = {
    project: 'p', solution: 'parallel import', result: 'rate limited',
    resultClass: 'failed', relatedTo: [decisionId],
    reusableWhen: [{ key: 'apiRateLimitPerMin', operator: 'gte', value: 600 }]
  };
  const fact = {
    project: 'p', key: 'apiRateLimitPerMin', value: 60,
    observedAt: '2026-11-08T00:00:00.000Z',
    validFrom: '2026-11-08T00:00:00.000Z',
    validTo: null
  };
  const attemptResponse = await first.call({
    jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'shadowgraph_record_attempt', arguments: attempt }
  });
  const factResponse = await first.call({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'shadowgraph_record_fact', arguments: fact }
  });
  assert.equal(attemptResponse.error, undefined, attemptResponse.error?.message);
  assert.equal(factResponse.error, undefined, factResponse.error?.message);
  const attemptId = JSON.parse(attemptResponse.result.content[0].text).id;
  const factId = JSON.parse(factResponse.result.content[0].text).id;

  const firstExit = new Promise((resolve) => first.child.once('exit', resolve));
  first.child.kill();
  await firstExit;

  const second = startJsonRpcChild(file);
  t.after(() => second.child.kill());
  const durable = JSON.parse(await readFile(file, 'utf8'));
  const storedDecision = durable.records.find((record) => record.id === decisionId);
  const storedAttempt = durable.records.find((record) => record.id === attemptId);
  const storedFact = durable.facts.find((record) => record.id === factId);
  assert.deepEqual({
    project: storedDecision.project,
    title: storedDecision.title,
    chosen: storedDecision.chosen,
    reviewAfter: storedDecision.reviewAfter
  }, decision);
  assert.deepEqual({
    project: storedAttempt.project,
    solution: storedAttempt.solution,
    result: storedAttempt.result,
    resultClass: storedAttempt.resultClass,
    relatedTo: storedAttempt.relatedTo,
    reusableWhen: storedAttempt.reusableWhen
  }, attempt);
  assert.deepEqual({
    project: storedFact.project,
    key: storedFact.key,
    value: storedFact.value,
    observedAt: storedFact.observedAt,
    validFrom: storedFact.temporal.validFrom,
    validTo: storedFact.temporal.validTo
  }, fact);

  const maintained = await second.call({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'shadowgraph_maintain', arguments: { now: '2026-11-09T00:00:00.000Z' } }
  });
  assert.equal(maintained.error, undefined, maintained.error?.message);
  assert.deepEqual(JSON.parse(maintained.result.content[0].text).staleDecisionIds, [decisionId]);

  const contextResponse = await second.call({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'shadowgraph_context', arguments: { project: 'p' } }
  });
  assert.equal(contextResponse.error, undefined, contextResponse.error?.message);
  const context = JSON.parse(contextResponse.result.content[0].text);
  assert.equal(context.activeDecisions.some((record) => record.id === decisionId), false);
  assert.deepEqual(context.failedAttemptsToAvoid.map((record) => record.id), [attemptId]);
  assert.deepEqual(context.reusableAttempts, [], 'the stored rate limit does not satisfy reusableWhen');
});
