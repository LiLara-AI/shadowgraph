import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { startProviderMeter } from '../benchmark/lib/provider-meter.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const execFileAsync = promisify(execFile);

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  t.after(() => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections?.();
  }));
  return `http://127.0.0.1:${server.address().port}`;
}

const CORRELATION = Object.freeze({
  runId: 'run-python-bridge-1',
  attemptId: 'attempt-python-bridge-1',
  armId: 'cognee',
  scenarioId: 'ACC_BRIDGE_1',
  repetition: 0,
  phase: 'A',
  requestClass: 'embedding',
  rootOperation: 'persist',
  rootInvocationId: 'root-python-bridge-1',
  planSlot: 'adapter-embedding',
  identityMode: 'dynamic'
});

test('Python meter bridge declares, sends, and closes one real dynamic plan', {
  skip: process.platform === 'win32'
    ? 'the Python bridge proof runs in the POSIX benchmark runtime'
    : false
}, async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-python-bridge-');
  const ledgerPath = path.join(directory, 'provider.ndjson');
  let upstreamCalls = 0;
  const upstream = await listen(t, async (request, response) => {
    upstreamCalls += 1;
    assert.equal(request.headers['x-shadowgraph-dispatch-alias'], undefined);
    for await (const chunk of request) { void chunk; }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      model: 'nomic-embed-text:v1.5',
      usage: { input_tokens: 1, total_tokens: 1 },
      data: []
    }));
  });
  const meter = await startProviderMeter({
    listenerUrl: 'http://127.0.0.1:0',
    upstreamBaseUrl: `${upstream}/v1`,
    upstreamAuthorization: null,
    ledgerPath,
    upstreamTimeoutMs: 5_000
  }, {
    requireRootOperation: true,
    requireDispatchPlans: true
  });
  t.after(() => meter.close());
  const route = await meter.bindPlannedEndpoint(CORRELATION);
  const adapterDirectory = path.resolve('benchmark/adapters');
  const script = String.raw`
import asyncio
import json
import sys
from http.client import HTTPConnection
from urllib.parse import urlsplit

sys.path.insert(0, sys.argv[2])
import cognee_adapter

async def main():
    endpoint = sys.argv[1]
    identity = await cognee_adapter._meter_declare(endpoint)
    parsed = urlsplit(endpoint)
    connection = HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    try:
        connection.request(
            'POST',
            parsed.path + '/embeddings',
            body=b'{"model":"nomic-embed-text:v1.5","input":["one"]}',
            headers={
                'Content-Type': 'application/json',
                'X-Shadowgraph-Dispatch-Alias': identity['alias']
            }
        )
        response = connection.getresponse()
        response.read()
        status = response.status
    finally:
        connection.close()
    await cognee_adapter._meter_close(endpoint, identity)
    print(json.dumps({'status': status, 'identity': identity}))

asyncio.run(main())
`;
  const { stdout, stderr } = await execFileAsync('python3', ['-B', '-c', script, route.endpoint, adapterDirectory], {
    maxBuffer: 128 * 1024
  });
  assert.equal(stderr, '');
  const result = JSON.parse(stdout);
  assert.equal(result.status, 200);
  assert.match(result.identity.alias, /^[a-f0-9]{48}$/u);
  assert.match(result.identity.plannedDispatchId, /^[a-f0-9]{48}$/u);
  assert.equal(upstreamCalls, 1);

  const plans = (await readFile(`${ledgerPath}.plans.ndjson`, 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line));
  const events = (await readFile(ledgerPath, 'utf8'))
    .trimEnd().split('\n').map((line) => JSON.parse(line));
  assert.equal(plans.filter((row) => row.event === 'root_plan').length, 1);
  assert.equal(plans.filter((row) => row.event === 'dispatch_plan').length, 1);
  assert.equal(plans.filter((row) => row.event === 'dispatch_closed').length, 1);
  assert.equal(events.length, 1);
  assert.equal(events[0].rootInvocationId, CORRELATION.rootInvocationId);
  assert.equal(events[0].plannedDispatchId, result.identity.plannedDispatchId);
  assert.equal(events[0].dispatchAlias, result.identity.alias);
});

test('Cognee adapter instrumentation invokes each native and transport original exactly once', async () => {
  const adapterDirectory = path.resolve('benchmark/adapters');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const script = String.raw`
import asyncio
import json
import sys

sys.path.insert(0, sys.argv[1])
import cognee_adapter

class NativeLiteLLMAdapter:
    def __init__(self):
        self.calls = 0
    async def acreate_structured_output(self, value):
        self.calls += 1
        return value

class OpenAICompatibleEmbeddingEngine:
    def __init__(self):
        self.calls = 0
    async def embed_text(self, value):
        self.calls += 1
        return value

class Request:
    def __init__(self, url):
        self.url = url
        self.headers = {}

class Client:
    calls = 0
    def send(self, request, *args, **kwargs):
        type(self).calls += 1
        return 'sync-original'

class AsyncClient:
    calls = 0
    async def send(self, request, *args, **kwargs):
        type(self).calls += 1
        return 'async-original'

class Httpx:
    Client = Client
    AsyncClient = AsyncClient

async def main():
    declared = []
    closed = []
    async def declare(request_class, endpoint):
        declared.append((request_class, endpoint))
        return {'alias': 'a' * 48, 'plannedDispatchId': 'b' * 48}
    async def close(request_class, identity):
        closed.append((request_class, identity['alias']))
    native = NativeLiteLLMAdapter()
    embedding = OpenAICompatibleEmbeddingEngine()
    routes = {'internal_memory_llm': 'http://127.0.0.1:12345/provider-meter/v1/llm', 'embedding': 'http://127.0.0.1:12345/provider-meter/v1/route'}
    cognee_adapter._install_cognee_dispatch_roots(
        routes,
        native_litellm_adapter=native,
        embedding_engine=embedding,
        declare=declare,
        close=close,
    )
    native_result = await native.acreate_structured_output('native-original')
    embedding_result = await embedding.embed_text('embedding-original')
    observed = []
    cognee_adapter._count_metered_requests(
        Httpx,
        {'embedding': 'http://127.0.0.1:12345/provider-meter/v1/route'},
        observed.append,
        require_dispatch_identity=False,
    )
    sync_result = Client().send(Request('http://127.0.0.1:12345/provider-meter/v1/route/embeddings'))
    async_result = await AsyncClient().send(Request('http://127.0.0.1:12345/provider-meter/v1/route/embeddings'))
    print(json.dumps({
        'nativeResult': native_result,
        'nativeCalls': native.calls,
        'embeddingResult': embedding_result,
        'embeddingCalls': embedding.calls,
        'declared': len(declared),
        'closed': len(closed),
        'syncResult': sync_result,
        'asyncResult': async_result,
        'syncCalls': Client.calls,
        'asyncCalls': AsyncClient.calls,
        'metered': observed,
    }, sort_keys=True))

asyncio.run(main())
`;
  const { stdout, stderr } = await execFileAsync(python, ['-B', '-c', script, adapterDirectory], {
    maxBuffer: 128 * 1024
  });
  assert.equal(stderr, '');
  assert.deepEqual(JSON.parse(stdout), {
    asyncCalls: 1,
    asyncResult: 'async-original',
    closed: 2,
    declared: 2,
    embeddingCalls: 1,
    embeddingResult: 'embedding-original',
    metered: ['embedding', 'embedding'],
    nativeCalls: 1,
    nativeResult: 'native-original',
    syncCalls: 1,
    syncResult: 'sync-original'
  });
});
