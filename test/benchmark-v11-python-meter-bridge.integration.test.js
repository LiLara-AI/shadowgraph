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
