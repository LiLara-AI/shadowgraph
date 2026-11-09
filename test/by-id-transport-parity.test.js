import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createShadowGraphServer } from '../src/server.js';
import { createJsonFileStore } from '../src/storage.js';
import { privilegedSnapshot } from '../src/internal/snapshot.js';
import { historicalRelation } from '../tools/historical-relation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

// Labels below refer to IDs returned by ordinary creation, never supplied IDs.
const fixtureIds = {};

// PR-09's by-id non-disclosure, observed where callers meet it: the kernel,
// POST /traverse, the MCP shadowgraph_traverse tool and the CLI traverse verb.
// On each, an id that exists outside the caller's scope and an id that does
// not exist must get the same answer -- same status, same structure, same
// notice -- and the only id in either answer is the one the caller sent.
// This covers structured responses and existence, not timing. Every fixture is
// synthetic.

const exec = promisify(execFile);
const NOW = '2026-01-01T00:00:00.000Z';
const ABSENT = 'decision-absent-0000';
const NOTICE = { code: 'scoped_coverage', detail: 'No record with this id is visible in the scope of this traversal.' };
// Everything a caller scoped to alpha, or to nothing, may not learn.
const HIDDEN = () => [fixtureIds['beta-decision'], fixtureIds['default-decision'], 'legacy-default-decision', fixtureIds['origin-decision'], 'relation-hidden-cross', 'HIDDEN', 'beta', 'origin_hidden'].sort();
const CASES = () => [
  { scope: { project: 'alpha' }, hidden: [fixtureIds['beta-decision'], fixtureIds['default-decision'], 'legacy-default-decision', fixtureIds['origin-decision']].sort() },
  { scope: {}, hidden: [fixtureIds['alpha-decision'], fixtureIds['beta-decision'], fixtureIds['origin-decision']].sort() }
];

async function seededStore(t) {
  const directory = await scratchDirectory(t, 'shadowgraph-by-id-parity-');
  const file = join(directory, 'data.json');
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData({ schemaVersion: 5, records: [{ id: 'legacy-default-decision', kind: 'decision', schemaVersion: 5, project: 'default', title: 'Legacy HIDDEN', chosen: 'x' }] });
  fixtureIds['alpha-decision'] = graph.addDecision({ project: 'alpha', title: 'Alpha decision', chosen: 'x' }).id;
  fixtureIds['alpha-attempt'] = graph.addAttempt({ project: 'alpha', solution: 'alpha script', result: 'worked' }).id;
  fixtureIds['relation-alpha-tried'] = graph.link({ project: 'alpha', from: fixtureIds['alpha-decision'], to: fixtureIds['alpha-attempt'], relation: 'tried' }).id;
  fixtureIds['beta-decision'] = graph.addDecision({ project: 'beta', title: 'Beta HIDDEN', chosen: 'x' }).id;
  fixtureIds['default-decision'] = graph.addDecision({ project: 'default', title: 'Real default HIDDEN', chosen: 'x' }).id;
  fixtureIds['origin-decision'] = graph.addDecision({ originId: 'origin_hidden', title: 'Origin HIDDEN', chosen: 'x' }).id;
  graph.importData(historicalRelation({ id: 'relation-hidden-cross', from: fixtureIds['beta-decision'], to: fixtureIds['alpha-decision'], relation: 'related', project: 'beta', seq: privilegedSnapshot(graph).journalSeq + 1, at: NOW }));
  const store = createJsonFileStore(file);
  await store.save(privilegedSnapshot(graph));
  return file;
}

// The caller's own id is the one thing an answer may echo; everything else
// must match.
const normalise = (outcome, id) => JSON.parse(JSON.stringify(outcome).split(id).join('<caller-id>'));

async function assertParity(label, traverse) {
  for (const { scope, hidden } of CASES()) {
    const absent = normalise(await traverse({ ...scope, id: ABSENT }), ABSENT);
    for (const id of hidden) {
      const outside = normalise(await traverse({ ...scope, id }), id);
      assert.deepEqual(outside, absent, `${label}: ${id} under ${JSON.stringify(scope)} answers like an absent id`);
      const text = JSON.stringify(outside);
      for (const name of HIDDEN()) assert.equal(text.includes(name), false, `${label}: the answer for ${id} names ${name}`);
    }
    assert.deepEqual(absent.traversal.limitation, NOTICE, `${label}: the notice`);
    assert.deepEqual([absent.traversal.nodes, absent.traversal.relations], [[], []]);
  }
  // In scope, the same surface does return the record, and still nothing hidden.
  const own = await traverse({ project: 'alpha', id: fixtureIds['alpha-decision'], depth: 3 });
  assert.deepEqual(own.traversal.nodes.map((node) => node.id).sort(), [fixtureIds['alpha-attempt'], fixtureIds['alpha-decision']].sort(), `${label}: in scope`);
  for (const name of HIDDEN()) assert.equal(JSON.stringify(own).includes(name), false, `${label}: the in-scope walk names ${name}`);
}

test('kernel: an out-of-scope id and a missing id get the same traverse answer', async (t) => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData(await createJsonFileStore(await seededStore(t)).load());
  await assertParity('kernel', async (input) => {
    try { return { status: 'returned', traversal: graph.traverse(input) }; }
    catch (error) { return { status: 'threw', error: { name: error.name, message: error.message } }; }
  });
});

test('HTTP: POST /traverse answers an out-of-scope id and a missing id alike', async (t) => {
  const app = await createShadowGraphServer({ file: await seededStore(t) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    await assertParity('HTTP', async (input) => {
      const response = await fetch(`${base}/traverse`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const body = await response.text();
      return {
        status: response.status,
        headers: { contentType: response.headers.get('content-type'), cacheControl: response.headers.get('cache-control') },
        traversal: JSON.parse(body)
      };
    });
  } finally { await new Promise((resolve) => app.server.close(resolve)); }
});

test('MCP: shadowgraph_traverse answers an out-of-scope id and a missing id alike', async (t) => {
  const child = spawn(process.execPath, ['src/mcp.js'], { env: { ...process.env, SHADOWGRAPH_FILE: await seededStore(t) }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map();
  let buffer = '';
  let next = 1;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    for (let index = buffer.indexOf('\n'); index >= 0; index = buffer.indexOf('\n')) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  try {
    await assertParity('MCP', async (input) => {
      const id = next++;
      const reply = new Promise((resolve) => waiting.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'shadowgraph_traverse', arguments: input } })}\n`);
      const { error, result } = await reply;
      // The request id is the client's own; the rest of the reply must match.
      return { error: error ?? null, result, traversal: JSON.parse(result.content[0].text) };
    });
  } finally {
    child.stdin.end();
    child.kill();
    await once(child, 'exit');
  }
});

test('CLI: traverse answers an out-of-scope id and a missing id alike', async (t) => {
  const file = await seededStore(t);
  await assertParity('CLI', async (input) => {
    try {
      const { stdout, stderr } = await exec(process.execPath, ['src/cli.js', 'traverse', JSON.stringify(input)], { cwd: process.cwd(), env: { ...process.env, SHADOWGRAPH_FILE: file } });
      return { exit: 0, stderr, stdout, traversal: JSON.parse(stdout) };
    } catch (error) {
      return { exit: error.code, stderr: error.stderr, stdout: error.stdout, traversal: null };
    }
  });
});
