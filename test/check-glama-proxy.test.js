// Offline cover for the Glama proxy gate's own logic.
//
// The gate itself needs the network, so it runs from `npm run check:mcp` rather
// than from the suite. What is checked here is everything that would otherwise
// only be exercised by that network run: the recorder's byte transparency, the
// event-stream parser, and the two assertion functions, including that they
// reject the failures they exist to catch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHandshake, assertTools, parseRecord, parseSse } from '../scripts/check-glama-proxy.mjs';

const RECORDER = fileURLToPath(new URL('../scripts/check-glama-proxy.mjs', import.meta.url));

function toolFixture(name, { outputSchema = true } = {}) {
  return {
    name,
    description: `${name} description`,
    inputSchema: { type: 'object' },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    ...(outputSchema ? { outputSchema: { type: 'object' } } : {})
  };
}
// 27 tools, two of which legitimately carry no output schema.
const TOOLS = [
  toolFixture('shadowgraph_review', { outputSchema: false }),
  toolFixture('shadowgraph_review_signals', { outputSchema: false }),
  ...Array.from({ length: 25 }, (_, index) => toolFixture(`shadowgraph_tool_${index}`))
];

function recordOf({ requested = '2025-11-25', negotiated = '2025-11-25', tools = TOOLS, initializes = 1, listings = 1 } = {}) {
  const requests = [];
  const responses = [];
  for (let index = 0; index < initializes; index += 1) {
    requests.push({ jsonrpc: '2.0', id: index, method: 'initialize', params: { protocolVersion: requested, clientInfo: { name: 'mcp-proxy', version: '1.0.0' } } });
    responses.push({ jsonrpc: '2.0', id: index, result: { protocolVersion: negotiated, serverInfo: { name: 'shadowgraph', version: '0.40.0' } } });
  }
  requests.push({ jsonrpc: '2.0', method: 'notifications/initialized' });
  for (let index = 0; index < listings; index += 1) {
    requests.push({ jsonrpc: '2.0', id: 100 + index, method: 'tools/list', params: {} });
    responses.push({ jsonrpc: '2.0', id: 100 + index, result: { tools } });
  }
  return { requests, responses };
}

test('the recorder passes bytes through untouched and logs both directions as lines', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-recorder-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recordFile = join(directory, 'stdio.log');

  // An echo server stands in for src/mcp.js: whatever arrives comes straight back.
  const child = spawn(process.execPath, [RECORDER, '--record', recordFile, '--', process.execPath, '-e', 'process.stdin.pipe(process.stdout)'], {
    stdio: ['pipe', 'pipe', 'inherit']
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { out += chunk; });

  // A CRLF line, and a multi-byte character split across two writes.
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize"}\r\n');
  const snowman = Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/list","note":"☃"}\n', 'utf8');
  child.stdin.write(snowman.subarray(0, 56));
  await new Promise((resolve) => setTimeout(resolve, 50));
  child.stdin.write(snowman.subarray(56));
  child.stdin.end();

  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(code, 0, 'the recorder exits with the server exit code');
  assert.equal(out, '{"jsonrpc":"2.0","id":1,"method":"initialize"}\r\n{"jsonrpc":"2.0","id":2,"method":"tools/list","note":"☃"}\n', 'stdout must be byte-transparent');

  const recorded = await readFile(recordFile, 'utf8');
  const { requests, responses } = parseRecord(recorded);
  assert.deepEqual(requests.map((request) => request.method), ['initialize', 'tools/list']);
  assert.deepEqual(responses.map((response) => response.method), ['initialize', 'tools/list']);
  assert.equal(requests[1].note, '☃', 'a character split across two writes must survive');
  assert.match(recorded.split('\n')[0], /^# \{"recorderPid":\d+,"serverPid":\d+\}$/u);
});

test('the event-stream parser skips the priming event and keeps the messages', () => {
  const stream = 'id: 5f2\ndata: \n\nevent: message\nid: 5f3\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n';
  assert.deepEqual(parseSse(stream), [{ jsonrpc: '2.0', id: 1, result: { ok: true } }]);
  // CRLF framing, and a payload split across two data lines.
  const wrapped = 'event: message\r\ndata: {"jsonrpc":"2.0",\r\ndata: "id":2}\r\n\r\n';
  assert.deepEqual(parseSse(wrapped), [{ jsonrpc: '2.0', id: 2 }]);
  assert.deepEqual(parseSse(''), []);
});

test('the handshake assertion accepts the pinned exchange and rejects every way it can go wrong', () => {
  assert.deepEqual(assertHandshake(recordOf()), { requested: '2025-11-25', negotiated: '2025-11-25' });

  // The regression this gate exists to catch: the server quietly answering an
  // older revision, which would hide annotations and output schemas from Glama.
  assert.throws(() => assertHandshake(recordOf({ negotiated: '2024-11-05' })), /negotiated "2024-11-05"/u);
  // The proxy asking for something other than the version this gate is pinned to.
  assert.throws(() => assertHandshake(recordOf({ requested: '2025-06-18' })), /requested protocolVersion "2025-06-18"/u);
  assert.throws(() => assertHandshake(recordOf({ initializes: 2 })), /sent 2 initialize requests/u);
  assert.throws(() => assertHandshake(recordOf({ initializes: 0 })), /sent 0 initialize requests/u);

  const withoutAck = recordOf();
  withoutAck.requests = withoutAck.requests.filter((request) => request.method !== 'notifications/initialized');
  assert.throws(() => assertHandshake(withoutAck), /never completed the handshake/u);

  const unanswered = recordOf();
  unanswered.responses = [];
  assert.throws(() => assertHandshake(unanswered), /did not answer the proxy handshake/u);
});

test('the tool assertion compares what the scanner received against what the server wrote', () => {
  const record = recordOf();
  assert.equal(assertTools(TOOLS, record), 25, 'twenty-five of the twenty-seven declare an output schema');

  // Key order may differ across the proxy's schema rebuild; values may not.
  const reordered = TOOLS.map((tool) => Object.fromEntries(Object.entries(tool).reverse()));
  assert.equal(assertTools(reordered, record), 25);

  assert.throws(() => assertTools(TOOLS.slice(1), record), /received 26 tools/u);
  assert.throws(() => assertTools(TOOLS, recordOf({ listings: 2 })), /sent 2 tools\/list requests/u);

  const dropped = TOOLS.map((tool, index) => (index === 5 ? { ...tool, annotations: undefined } : tool));
  assert.throws(() => assertTools(dropped, recordOf({ tools: dropped })), /without four boolean annotations/u);

  const unschematised = TOOLS.map((tool, index) => (index === 6 ? { ...tool, outputSchema: undefined } : tool));
  assert.throws(() => assertTools(unschematised, recordOf({ tools: unschematised })), /without an object-rooted output schema/u);

  const overSchematised = TOOLS.map((tool) => (tool.name === 'shadowgraph_review' ? { ...tool, outputSchema: { type: 'object' } } : tool));
  assert.throws(() => assertTools(overSchematised, recordOf({ tools: overSchematised })), /bare array reached the scanner with an output schema/u);

  // The proxy dropping or rewriting a member in transit.
  const mutated = TOOLS.map((tool, index) => (index === 3 ? { ...tool, description: 'changed in transit' } : tool));
  assert.throws(() => assertTools(mutated, record), /differs from the one the server wrote/u);
});

test('an unrecognised line in a recording is an error, not silently skipped', () => {
  assert.throws(() => parseRecord('! {"jsonrpc":"2.0"}\n'), /unrecognised line/u);
  assert.deepEqual(parseRecord('# {"recorderPid":1,"serverPid":2}\n\n'), { requests: [], responses: [] });
});
