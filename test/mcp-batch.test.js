// JSON-RPC batch receiving on stdio.
//
// The 2025-03-26 base protocol says implementations "MAY support sending
// JSON-RPC batches, but MUST support receiving JSON-RPC batches". 2024-11-05
// never defined batching and 2025-06-18 removed it, so acceptance follows the
// revision `initialize` negotiated rather than being on for everyone.
//
// Initialization is always its own message here: it must be the first
// interaction, so a batch is never used as a negotiation sequence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const BATCHING_PROTOCOL = '2025-03-26';
const MODERN_PROTOCOL = '2026-07-28';

function modernParams(values = {}) {
  return {
    ...values,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MODERN_PROTOCOL,
      'io.modelcontextprotocol/clientInfo': { name: 'shadowgraph-batch', version: '1.0.0' },
      'io.modelcontextprotocol/clientCapabilities': {}
    }
  };
}

// Collects whole stdout lines as parsed JSON, keeping arrays as arrays: a batch
// reply is one line carrying one array, and that is exactly what is asserted.
async function startMcp(t, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-batch-'));
  const file = join(directory, 'data.json');
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file, ...extraEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let buffer = '';
  let stderr = '';
  const lines = [];
  const waiters = [];

  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const parts = buffer.split(/\r?\n/u);
    buffer = parts.pop();
    for (const part of parts) {
      if (!part.trim()) continue;
      const value = JSON.parse(part);
      lines.push(value);
      const index = waiters.findIndex((waiter) => waiter.predicate(value));
      if (index < 0) continue;
      const [waiter] = waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(value);
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function waitFor(predicate, label, timeoutMs = 8000) {
    const existing = lines.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        timer: setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error(`Timed out waiting for ${label}; stderr=${stderr}`));
        }, timeoutMs)
      };
      waiters.push(waiter);
    });
  }

  let stopped = false;
  async function stop() {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null) child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    await rm(directory, { recursive: true, force: true });
  }
  t.after(stop);

  let handshakes = 0;
  const rpc = {
    directory,
    file,
    lines,
    get stderr() { return stderr; },
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    sendRaw(line) { child.stdin.write(`${line}\n`); },
    // Writes bytes exactly as given, so a test can put two messages in one chunk
    // and see them delivered by a single readline flush.
    writeRaw(text) { child.stdin.write(text); },
    call(request) {
      const pending = waitFor((value) => !Array.isArray(value) && value.id === request.id, `response id ${String(request.id)}`);
      rpc.send(request);
      return pending;
    },
    // One ordinary initialize message. Initialization is the first interaction,
    // never a batch member. Ids are unique per call so a renegotiation is never
    // satisfied by the response to an earlier one.
    async negotiate(protocolVersion) {
      handshakes += 1;
      const response = await rpc.call({
        jsonrpc: '2.0', id: `init-${handshakes}-${protocolVersion}`, method: 'initialize',
        params: { protocolVersion, capabilities: {}, clientInfo: { name: 'shadowgraph-batch', version: '1.0.0' } }
      });
      assert.equal(response.error, undefined, response.error?.message);
      return response.result.protocolVersion;
    },
    // Matched by position, not merely by being an array: a session that already
    // received one batch reply would otherwise resolve against that one, and the
    // ids cannot disambiguate because an invalid member answers with id null.
    sendBatch(members) {
      const from = lines.length;
      const pending = waitFor((value) => Array.isArray(value) && lines.indexOf(value) >= from, 'a batch response array');
      rpc.sendRaw(JSON.stringify(members));
      return pending;
    },
    waitFor,
    stop
  };
  return rpc;
}

const idsOf = (batch) => batch.map((response) => response.id);
const INVALID_REQUEST = { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } };

test('a session negotiated at 2025-03-26 answers a batch as one array, in member order', async (t) => {
  const rpc = await startMcp(t);
  assert.equal(await rpc.negotiate(BATCHING_PROTOCOL), BATCHING_PROTOCOL);

  const batch = await rpc.sendBatch([
    { jsonrpc: '2.0', id: 'b1', method: 'tools/list', params: {} },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 'b2', method: 'tools/call', params: { name: 'shadowgraph_validate', arguments: {} } }
  ]);

  // The notification carries no id and so contributes no member to the reply.
  assert.deepEqual(idsOf(batch), ['b1', 'b2']);
  assert.equal(batch[0].result.tools.length, 27);
  assert.equal(batch[1].result.content[0].type, 'text');
  assert.equal(Object.hasOwn(batch[1].result, 'structuredContent'), false, '2025-03-26 defines annotations, not structured content');

  // A single message on its own line still answers as an object, not an array.
  const single = await rpc.call({ jsonrpc: '2.0', id: 'single', method: 'tools/list', params: {} });
  assert.equal(Array.isArray(single), false);
  assert.equal(single.result.tools.length, 27);
});

test('a batch of notifications alone writes nothing, yet every member still runs', async (t) => {
  const rpc = await startMcp(t);
  await rpc.negotiate(BATCHING_PROTOCOL);
  const before = rpc.lines.length;

  // Both lines in ONE write, so readline delivers them from a single chunk, as a
  // client that flushes a batch and its follow-up together would. A batch that
  // yielded between members would let this search reach the shared call queue
  // ahead of the write it depends on, and find nothing.
  const batch = JSON.stringify([
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    {
      jsonrpc: '2.0', method: 'tools/call',
      params: { name: 'shadowgraph_record_decision', arguments: { id: 'batch-decision', project: 'batching', title: 'Batch member', chosen: 'execute' } }
    }
  ]);
  const search = JSON.stringify({
    jsonrpc: '2.0', id: 'after-batch', method: 'tools/call',
    params: { name: 'shadowgraph_search', arguments: { query: 'Batch member', project: 'batching' } }
  });
  const searched = rpc.waitFor((value) => !Array.isArray(value) && value.id === 'after-batch', 'the search after the batch');
  rpc.writeRaw(`${batch}\n${search}\n`);

  const hits = JSON.parse((await searched).result.content[0].text);
  assert.equal(rpc.lines.length, before + 1, `unexpected output: ${JSON.stringify(rpc.lines.slice(before))}`);
  assert.equal(hits.items.length, 1, 'the notification member must have executed, and before the line that followed it');
  assert.equal(hits.items[0].record.id, 'batch-decision');
});

test('a message sent in the same chunk as a batch cannot overtake its members', async (t) => {
  const rpc = await startMcp(t);
  await rpc.negotiate(BATCHING_PROTOCOL);

  // The batch records a decision; the line flushed with it moves that decision
  // on. If the second line were dispatched between the batch members, the status
  // change would run against a decision that did not exist yet.
  const batch = JSON.stringify([
    { jsonrpc: '2.0', id: 'noop', method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0', id: 'write', method: 'tools/call',
      params: { name: 'shadowgraph_record_decision', arguments: { id: 'chunk-decision', project: 'chunking', title: 'Chunked', chosen: 'first' } }
    }
  ]);
  const dependent = JSON.stringify({
    jsonrpc: '2.0', id: 'dependent', method: 'tools/call',
    params: { name: 'shadowgraph_update_status', arguments: { decisionId: 'chunk-decision', status: 'planned' } }
  });
  const batched = rpc.waitFor((value) => Array.isArray(value), 'the batch response array');
  const followed = rpc.waitFor((value) => !Array.isArray(value) && value.id === 'dependent', 'the dependent call');
  rpc.writeRaw(`${batch}\n${dependent}\n`);

  assert.deepEqual(idsOf(await batched), ['noop', 'write']);
  const response = await followed;
  assert.equal(response.error, undefined, response.error?.message);
  assert.equal(JSON.parse(response.result.content[0].text).status, 'planned');
});

test('an initialize with no id negotiates nothing, because nothing was agreed', async (t) => {
  const rpc = await startMcp(t);
  assert.equal(await rpc.negotiate(BATCHING_PROTOCOL), BATCHING_PROTOCOL);
  const accepted = await rpc.sendBatch([{ jsonrpc: '2.0', id: 'first', method: 'tools/list', params: {} }]);
  assert.deepEqual(idsOf(accepted), ['first']);

  // A handshake is an exchange: with no id there is no response, so the client
  // never learns what was agreed and the session must not move.
  const before = rpc.lines.length;
  rpc.send({
    jsonrpc: '2.0', method: 'initialize',
    params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'shadowgraph-batch', version: '1.0.0' } }
  });
  const probe = await rpc.call({ jsonrpc: '2.0', id: 'probe', method: 'tools/list', params: {} });
  assert.equal(rpc.lines.length, before + 1, 'a notification is never answered');
  // 2025-03-26 was negotiated, so annotations but no output schema, and batches
  // are still accepted: the silent 2025-11-25 changed neither.
  const tool = probe.result.tools.find((candidate) => candidate.name === 'shadowgraph_validate');
  assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema', 'annotations']);
  const still = await rpc.sendBatch([{ jsonrpc: '2.0', id: 'second', method: 'tools/list', params: {} }]);
  assert.deepEqual(idsOf(still), ['second']);
});

test('a rejected initialize leaves both the tier and batch acceptance alone', async (t) => {
  const rpc = await startMcp(t);
  assert.equal(await rpc.negotiate(BATCHING_PROTOCOL), BATCHING_PROTOCOL);

  for (const params of [
    { capabilities: {} },
    { protocolVersion: '', capabilities: {} },
    { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: null }
  ]) {
    const rejected = await rpc.call({ jsonrpc: '2.0', id: `rejected-${JSON.stringify(params)}`, method: 'initialize', params });
    assert.equal(rejected.error.code, -32602);
  }

  const probe = await rpc.call({ jsonrpc: '2.0', id: 'probe', method: 'tools/list', params: {} });
  const tool = probe.result.tools.find((candidate) => candidate.name === 'shadowgraph_validate');
  assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema', 'annotations'], 'the negotiated tier survives a rejected handshake');
  const accepted = await rpc.sendBatch([{ jsonrpc: '2.0', id: 'still-batching', method: 'tools/list', params: {} }]);
  assert.deepEqual(idsOf(accepted), ['still-batching']);
});

test('an empty batch is a single invalid request, not an empty array', async (t) => {
  const rpc = await startMcp(t);
  await rpc.negotiate(BATCHING_PROTOCOL);
  const pending = rpc.waitFor((value) => !Array.isArray(value) && value.id === null, 'the empty-batch error');
  rpc.sendRaw('[]');
  const response = await pending;
  assert.equal(Array.isArray(response), false);
  assert.deepEqual(response, INVALID_REQUEST);
});

test('every member of a batch is answered, including the invalid ones, in order', async (t) => {
  const rpc = await startMcp(t);
  await rpc.negotiate(BATCHING_PROTOCOL);

  const batch = await rpc.sendBatch([
    1,
    { jsonrpc: '2.0', id: 'ok', method: 'tools/list', params: {} },
    'not-an-object',
    null,
    [],
    { jsonrpc: '1.0', id: 'bad-version', method: 'tools/list' }
  ]);

  assert.equal(batch.length, 6);
  assert.deepEqual(idsOf(batch), [null, 'ok', null, null, null, 'bad-version']);
  for (const index of [0, 2, 3, 4]) {
    assert.deepEqual(batch[index], INVALID_REQUEST, `member ${index}`);
  }
  assert.equal(batch[1].result.tools.length, 27);
  assert.equal(batch[5].error.code, -32600);
  assert.equal(batch[5].error.message, 'Invalid Request: jsonrpc must be 2.0');
});

test('batch members are handled in order even when one of them is asynchronous', async (t) => {
  const rpc = await startMcp(t);
  await rpc.negotiate(BATCHING_PROTOCOL);

  // The second member can only succeed if the first has already been applied.
  const batch = await rpc.sendBatch([
    {
      jsonrpc: '2.0', id: 'write', method: 'tools/call',
      params: { name: 'shadowgraph_record_decision', arguments: { id: 'ordered-decision', project: 'ordering', title: 'Ordered', chosen: 'first' } }
    },
    {
      jsonrpc: '2.0', id: 'depends', method: 'tools/call',
      params: { name: 'shadowgraph_update_status', arguments: { decisionId: 'ordered-decision', status: 'planned' } }
    },
    { jsonrpc: '2.0', id: 'list', method: 'tools/list', params: {} }
  ]);

  assert.deepEqual(idsOf(batch), ['write', 'depends', 'list']);
  assert.equal(batch[1].error, undefined, batch[1].error?.message);
  assert.equal(JSON.parse(batch[1].result.content[0].text).status, 'planned');
});

test('a modern per-request member keeps its own contract inside a batch', async (t) => {
  const rpc = await startMcp(t);
  await rpc.negotiate(BATCHING_PROTOCOL);

  const batch = await rpc.sendBatch([
    { jsonrpc: '2.0', id: 'discover', method: 'server/discover', params: modernParams() },
    { jsonrpc: '2.0', id: 'handshake-list', method: 'tools/list', params: {} }
  ]);

  assert.deepEqual(idsOf(batch), ['discover', 'handshake-list']);
  assert.equal(batch[0].result.resultType, 'complete');
  assert.deepEqual(batch[0].result.supportedVersions, [MODERN_PROTOCOL, '2025-11-25', '2025-06-18', BATCHING_PROTOCOL, '2024-11-05']);
  // The handshake member is unaffected by the modern one beside it.
  assert.equal(Object.hasOwn(batch[1].result, 'resultType'), false);
  const tool = batch[1].result.tools.find((candidate) => candidate.name === 'shadowgraph_validate');
  assert.deepEqual(Object.keys(tool), ['name', 'description', 'inputSchema', 'annotations']);
});

test('a read batched behind a restore that degrades the server is refused, not served', async (t) => {
  // Both members are dispatched together, so both pass the latch check made
  // while a request is being dispatched. Only a check inside the queue, after
  // the restore has actually failed, can hold the door shut.
  const rpc = await startMcp(t, {
    NODE_ENV: 'test',
    SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'afterReplacementRename,beforeRollbackInstall'
  });
  await rpc.negotiate(BATCHING_PROTOCOL);

  const sentinel = 'PRIVATE-BATCH-LATCH-PAYLOAD-4f21';
  const seeded = await rpc.call({
    jsonrpc: '2.0', id: 'latch-seed', method: 'tools/call',
    params: { name: 'shadowgraph_record_decision', arguments: { id: 'latch-seed', project: 'latch', title: sentinel, chosen: 'keep' } }
  });
  assert.equal(seeded.error, undefined, seeded.error?.message);
  const source = join(rpc.directory, 'restore-source.json');
  await writeFile(source, await readFile(rpc.file));

  const batch = await rpc.sendBatch([
    { jsonrpc: '2.0', id: 'degrading-restore', method: 'tools/call', params: { name: 'shadowgraph_restore', arguments: { source } } },
    { jsonrpc: '2.0', id: 'read-behind-it', method: 'resources/read', params: { uri: 'shadowgraph://context' } }
  ]);

  assert.deepEqual(idsOf(batch), ['degrading-restore', 'read-behind-it']);
  const [restored, read] = batch;
  assert.equal(restored.error.code, -32000);
  assert.equal(restored.error.data.recoveryCode, 'json_restore_recovery_unconfirmed');

  // The read must be refused by the degraded-storage latch, with the same error
  // it would get on its own line, and nothing else.
  assert.equal(read.result, undefined, 'a degraded server must not serve the context resource');
  assert.equal(read.error.code, -32001, 'the latch error, not whatever the graph happened to throw');
  assert.equal(read.error.message, 'Persistent storage unavailable');
  assert.deepEqual(read.error.data, { recoveryCode: 'json_restore_recovery_unconfirmed' });
  // Nothing about the store or the machine may travel with it.
  const serialized = JSON.stringify(read);
  for (const forbidden of [sentinel, source, rpc.directory, 'afterReplacementRename', 'beforeRollbackInstall']) {
    assert.equal(serialized.includes(forbidden), false, `the refusal leaked ${forbidden}`);
  }

  // And the latch stays shut for the request that follows the batch.
  const after = await rpc.call({ jsonrpc: '2.0', id: 'after-latch', method: 'resources/read', params: { uri: 'shadowgraph://context' } });
  assert.equal(after.error.code, -32001);
  assert.deepEqual(after.error.data, { recoveryCode: 'json_restore_recovery_unconfirmed' });
});

test('an unparseable line is one parse error whether or not it looks like a batch', async (t) => {
  const rpc = await startMcp(t);
  await rpc.negotiate(BATCHING_PROTOCOL);
  const before = rpc.lines.length;
  const pending = rpc.waitFor((value) => !Array.isArray(value) && value.error?.code === -32700, 'a parse error');
  rpc.sendRaw('[{"jsonrpc":"2.0"');
  const response = await pending;
  assert.deepEqual(response, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  assert.equal(rpc.lines.length, before + 1);
});

test('a batch is an invalid request in every session that did not negotiate 2025-03-26', async (t) => {
  const rpc = await startMcp(t);
  const batch = [{ jsonrpc: '2.0', id: 'in-batch', method: 'tools/list', params: {} }];

  // Before any handshake.
  const pending = rpc.waitFor((value) => !Array.isArray(value) && value.id === null, 'the pre-handshake rejection');
  rpc.sendRaw(JSON.stringify(batch));
  assert.deepEqual(await pending, INVALID_REQUEST);

  for (const version of ['2024-11-05', '2025-06-18', '2025-11-25']) {
    assert.equal(await rpc.negotiate(version), version);
    const before = rpc.lines.length;
    rpc.sendRaw(JSON.stringify(batch));
    // The single request that follows is answered after the array line was
    // rejected, so the rejection is already recorded once this resolves.
    const probe = await rpc.call({ jsonrpc: '2.0', id: `probe-${version}`, method: 'tools/list', params: {} });
    assert.equal(probe.result.tools.length, 27);
    assert.deepEqual(rpc.lines.slice(before, -1), [INVALID_REQUEST], `negotiated ${version}`);
  }

  // Renegotiating to 2025-03-26 accepts batches again, and away from it stops.
  assert.equal(await rpc.negotiate(BATCHING_PROTOCOL), BATCHING_PROTOCOL);
  const accepted = await rpc.sendBatch(batch);
  assert.deepEqual(idsOf(accepted), ['in-batch']);

  assert.equal(await rpc.negotiate('2025-11-25'), '2025-11-25');
  const before = rpc.lines.length;
  rpc.sendRaw(JSON.stringify(batch));
  const probe = await rpc.call({ jsonrpc: '2.0', id: 'probe-after', method: 'tools/list', params: {} });
  assert.equal(probe.result.tools.length, 27);
  assert.deepEqual(rpc.lines.slice(before, -1), [INVALID_REQUEST]);
});
