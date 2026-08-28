import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createSqliteStore } from '../src/sqlite-storage.js';
import { createJsonFileStore } from '../src/storage.js';

const MODERN_PROTOCOL = '2026-07-28';
const LEGACY_PROTOCOL = '2024-11-05';
const PROTOCOL_VERSION_META = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META = 'io.modelcontextprotocol/clientCapabilities';

function modernParams(values = {}, { clientInfo } = {}) {
  const _meta = {
    [PROTOCOL_VERSION_META]: MODERN_PROTOCOL,
    [CLIENT_CAPABILITIES_META]: {}
  };
  if (clientInfo !== undefined) _meta[CLIENT_INFO_META] = clientInfo;
  return { ...values, _meta };
}

async function startMcp(t, extraEnv = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shadowgraph-followup-mcp-'));
  const file = join(directory, 'data.json');
  const configuredEnv = typeof extraEnv === 'function'
    ? await extraEnv({ directory, file })
    : extraEnv;
  const child = spawn(process.execPath, ['src/mcp.js'], {
    cwd: process.cwd(),
    env: { ...process.env, SHADOWGRAPH_FILE: file, ...configuredEnv },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');

  let stdoutBuffer = '';
  let stderr = '';
  const responses = [];
  const waiters = [];

  function deliver(response) {
    responses.push(response);
    const index = waiters.findIndex((waiter) => waiter.predicate(response));
    if (index < 0) return;
    const [waiter] = waiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.resolve(response);
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) deliver(JSON.parse(line));
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  function waitFor(predicate, label, timeoutMs = 8000) {
    const existing = responses.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
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

  return {
    child,
    directory,
    file,
    responses,
    get stderr() { return stderr; },
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    sendRaw(line) { child.stdin.write(`${line}\n`); },
    call(request) {
      assert.ok(Object.hasOwn(request, 'id'), 'call() requires a request id');
      const pending = waitFor((response) => Object.hasOwn(response, 'id') && response.id === request.id, `response id ${String(request.id)}`);
      child.stdin.write(`${JSON.stringify(request)}\n`);
      return pending;
    },
    waitFor,
    stop
  };
}

function assertRpcCode(response, expected) {
  assert.ok(response.error, `expected JSON-RPC error, got ${JSON.stringify(response)}`);
  assert.equal(typeof response.error.code, 'number');
  assert.equal(Number.isFinite(response.error.code), true);
  assert.equal(Number.isInteger(response.error.code), true);
  if (expected !== undefined) assert.equal(response.error.code, expected);
}

function toolRequest(id, name, arguments_, { modern = false } = {}) {
  const values = { name, arguments: arguments_ };
  return {
    jsonrpc: '2.0', id, method: 'tools/call',
    params: modern ? modernParams(values) : values
  };
}

const PRIVATE_ERROR_KEYS = new Set([
  'stack', 'cause', 'recoveryCause', 'reconciliationCause',
  'persistenceError', 'reconciliationError',
  'retainedArtifacts', 'unknownArtifacts', 'artifactCleanup',
  'rollbackArtifact', 'recoveryArtifact', 'temporaryArtifact',
  'stagedArtifact', 'displacedArtifact', 'lockPath', 'path'
]);

function collectPrivateErrorKeys(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_ERROR_KEYS.has(key)) found.push(key);
    collectPrivateErrorKeys(child, found);
  }
  return found;
}

function assertSafeToolFailure(response, {
  modern = false,
  code = -32000,
  message = 'Tool execution failed',
  data,
  forbidden = []
} = {}) {
  if (modern) {
    assert.equal(response.error, undefined, JSON.stringify(response.error));
    assert.equal(response.result?.isError, true, JSON.stringify(response));
    assert.equal(response.result?.resultType, 'complete');
    assert.equal(response.result?.content?.length, 1);
    assert.equal(response.result.content[0].type, 'text');
    assert.equal(response.result.content[0].text, message);
  } else {
    assertRpcCode(response, code);
    assert.equal(response.error.message, message);
    if (data === undefined) assert.equal(Object.hasOwn(response.error, 'data'), false, JSON.stringify(response.error.data));
    else assert.deepEqual(response.error.data, data);
  }
  assert.deepEqual(collectPrivateErrorKeys(response), [], `private error fields escaped: ${JSON.stringify(response)}`);
  const serialized = JSON.stringify(response);
  for (const value of forbidden) {
    assert.equal(serialized.includes(String(value)), false, `private value escaped: ${String(value)}`);
  }
  assert.equal(/\b(?:ENOENT|EACCES|EPERM|SQLITE_[A-Z_]+)\b/.test(serialized), false, `OS/storage message escaped: ${serialized}`);
}

function emptyRestorePayload(schemaVersion = 4) {
  return {
    schemaVersion,
    revision: 0,
    records: [],
    facts: [],
    relations: [],
    reviewSignals: [],
    idempotency: [],
    events: [],
    journal: [],
    journalSeq: 0,
    journalEpoch: null
  };
}

function decisionFixture(id, overrides = {}) {
  return {
    id,
    kind: 'decision',
    schemaVersion: 4,
    project: 'followup-private-errors',
    title: 'Private error fixture',
    chosen: 'reject disclosure',
    status: 'active',
    alternatives: [],
    confidence: 0.5,
    ...overrides
  };
}

function privateRestoreScenarios() {
  const at = '2026-08-28T12:00:00.000Z';
  const scenarios = [];
  const add = (label, sentinel, mutate) => {
    const payload = emptyRestorePayload();
    mutate(payload, sentinel);
    scenarios.push({ label, sentinel, payload });
  };

  add('duplicate record ids', 'PRIVATE-DUPLICATE-RECORD-ID-f91a', (payload, sentinel) => {
    payload.records = [decisionFixture(sentinel), decisionFixture(sentinel, { title: 'Second private record' })];
  });
  add('duplicate fact ids', 'PRIVATE-DUPLICATE-FACT-ID-a72b', (payload, sentinel) => {
    const fact = { id: sentinel, kind: 'fact', schemaVersion: 4, project: 'followup-private-errors', key: 'private-fact' };
    payload.facts = [fact, { ...fact, key: 'second-private-fact' }];
  });
  add('duplicate relation ids', 'PRIVATE-DUPLICATE-RELATION-ID-c83d', (payload, sentinel) => {
    const relation = { id: sentinel, kind: 'relation', schemaVersion: 4, from: 'private-left', to: 'private-right', relation: 'private-edge' };
    payload.relations = [relation, { ...relation, relation: 'second-private-edge' }];
  });
  add('duplicate event ids', 'PRIVATE-DUPLICATE-EVENT-ID-d94e', (payload, sentinel) => {
    payload.events = [{ id: sentinel, type: 'private.event' }, { id: sentinel, type: 'private.second' }];
  });
  add('duplicate journal ids', 'PRIVATE-DUPLICATE-JOURNAL-ID-e05f', (payload, sentinel) => {
    const entry = (seq) => ({
      id: sentinel, seq, type: 'legacy_metadata_event', at,
      project: null, entityKind: null, entityId: null,
      schemaVersion: 4, payload: null, replayable: false,
      originalType: 'private.event',
      provenance: { actor: null, client: null, sessionId: null }
    });
    payload.journal = [entry(1), entry(2)];
    payload.journalSeq = 2;
    payload.journalEpoch = 1;
  });
  add('duplicate review ids', 'PRIVATE-DUPLICATE-REVIEW-ID-f16a', (payload, sentinel) => {
    const decision = decisionFixture('private-review-owner');
    payload.records = [decision];
    payload.reviewSignals = [
      { id: sentinel, decisionId: decision.id, reason: 'first private reason', status: 'open' },
      { id: sentinel, decisionId: decision.id, reason: 'second private reason', status: 'open' }
    ];
  });
  add('duplicate idempotency keys', 'PRIVATE-DUPLICATE-IDEMPOTENCY-KEY-071b', (payload, sentinel) => {
    payload.idempotency = [
      { key: sentinel, value: { id: 'private-left' } },
      { key: sentinel, value: { id: 'private-right' } }
    ];
  });
  add('malformed project', 'PRIVATE-MALFORMED-PROJECT-182c', (payload, sentinel) => {
    payload.records = [decisionFixture('private-project-record', { project: { sentinel } })];
  });
  add('malformed status', 'PRIVATE-MALFORMED-STATUS-293d', (payload, sentinel) => {
    payload.records = [{
      id: 'private-memory-status', kind: 'memory', schemaVersion: 4,
      project: 'followup-private-errors', memoryType: 'note', key: 'private-key',
      text: 'private text', status: sentinel
    }];
  });
  add('malformed temporal field', 'PRIVATE-MALFORMED-TEMPORAL-3a4e', (payload, sentinel) => {
    payload.records = [decisionFixture('private-temporal-record', { createdAt: sentinel })];
  });
  return scenarios;
}

test('modern request metadata permits omitted clientInfo but validates it when present', async (t) => {
  const rpc = await startMcp(t);

  const omitted = await rpc.call({
    jsonrpc: '2.0', id: 'discover-anonymous', method: 'server/discover', params: modernParams()
  });
  assert.equal(omitted.error, undefined, omitted.error?.message);
  assert.deepEqual(omitted.result.supportedVersions, [MODERN_PROTOCOL, LEGACY_PROTOCOL]);
  assert.equal(omitted.result.resultType, 'complete');
  assert.equal(Object.hasOwn(omitted.result, 'serverInfo'), false, 'modern server identity belongs only in result metadata');
  assert.deepEqual(Object.keys(omitted.result.capabilities).sort(), ['prompts', 'resources', 'tools']);
  assert.equal(omitted.result._meta['io.modelcontextprotocol/serverInfo'].name, 'shadowgraph');

  const present = await rpc.call({
    jsonrpc: '2.0', id: 'discover-identified', method: 'server/discover',
    params: modernParams({}, { clientInfo: { name: 'followup-test', version: '1.0.0' } })
  });
  assert.equal(present.error, undefined, present.error?.message);

  const missingCapabilities = await rpc.call({
    jsonrpc: '2.0', id: 'discover-missing-capabilities', method: 'server/discover',
    params: { _meta: { [PROTOCOL_VERSION_META]: MODERN_PROTOCOL } }
  });
  assertRpcCode(missingCapabilities, -32602);

  const malformedCapabilities = await rpc.call({
    jsonrpc: '2.0', id: 'discover-malformed-capabilities', method: 'server/discover',
    params: { _meta: { [PROTOCOL_VERSION_META]: MODERN_PROTOCOL, [CLIENT_CAPABILITIES_META]: [] } }
  });
  assertRpcCode(malformedCapabilities, -32602);

  const unsupported = await rpc.call({
    jsonrpc: '2.0', id: 'discover-unsupported', method: 'server/discover',
    params: {
      _meta: {
        [PROTOCOL_VERSION_META]: '2099-01-01',
        [CLIENT_CAPABILITIES_META]: {}
      }
    }
  });
  assertRpcCode(unsupported, -32022);
  assert.deepEqual(unsupported.error.data, {
    supported: [MODERN_PROTOCOL, LEGACY_PROTOCOL],
    requested: '2099-01-01'
  });

  const privateUnsupported = await rpc.call({
    jsonrpc: '2.0', id: 'discover-private-unsupported', method: 'server/discover',
    params: {
      _meta: {
        [PROTOCOL_VERSION_META]: 'PRIVATE_UNSUPPORTED_VERSION_SENTINEL',
        [CLIENT_CAPABILITIES_META]: {}
      }
    }
  });
  assertRpcCode(privateUnsupported, -32022);
  assert.deepEqual(privateUnsupported.error.data, {
    supported: [MODERN_PROTOCOL, LEGACY_PROTOCOL]
  });
  assert.equal(JSON.stringify(privateUnsupported).includes('PRIVATE_UNSUPPORTED_VERSION_SENTINEL'), false);

  for (const [label, clientInfo] of [
    ['null', null],
    ['array', []],
    ['empty object', {}],
    ['empty name', { name: '', version: '1.0.0' }],
    ['missing version', { name: 'followup-test' }],
    ['numeric version', { name: 'followup-test', version: 1 }]
  ]) {
    const response = await rpc.call({
      jsonrpc: '2.0', id: `malformed-${label}`, method: 'server/discover',
      params: modernParams({}, { clientInfo })
    });
    assertRpcCode(response, -32602);
  }
});

test('modern tool execution failures use CallToolResult while malformed calls remain numeric protocol errors', async (t) => {
  const rpc = await startMcp(t);
  const privateSentinel = 'PRIVATE-MISSING-RESTORE-PATH-7f8c';
  const missingSource = join(rpc.directory, privateSentinel, 'missing.json');

  const failedRestore = await rpc.call({
    jsonrpc: '2.0', id: 'modern-restore-failure', method: 'tools/call',
    params: modernParams({
      name: 'shadowgraph_restore',
      arguments: { source: missingSource }
    })
  });
  assert.equal(failedRestore.error, undefined, JSON.stringify(failedRestore.error));
  assert.equal(failedRestore.result.isError, true);
  assert.equal(failedRestore.result.resultType, 'complete');
  assert.equal(JSON.stringify(failedRestore).includes(privateSentinel), false, 'tool failure must not disclose a private source path');

  const malformed = await rpc.call({
    jsonrpc: '2.0', id: 'modern-malformed-call', method: 'tools/call',
    params: modernParams({ name: 'shadowgraph_validate', arguments: [] })
  });
  assertRpcCode(malformed, -32602);

  const unknown = await rpc.call({
    jsonrpc: '2.0', id: 'modern-unknown-tool', method: 'tools/call',
    params: modernParams({ name: 'shadowgraph_missing', arguments: {} })
  });
  assertRpcCode(unknown, -32602);
});

test('initialize selects legacy semantics, accepts omitted optional fields, and rejects malformed fields when present', async (t) => {
  const rpc = await startMcp(t);

  const empty = await rpc.call({ jsonrpc: '2.0', id: 'init-empty', method: 'initialize', params: {} });
  assert.equal(empty.error, undefined, empty.error?.message);
  assert.equal(empty.result.protocolVersion, LEGACY_PROTOCOL);

  const missingClientInfo = await rpc.call({
    jsonrpc: '2.0', id: 'init-anonymous', method: 'initialize',
    params: { protocolVersion: MODERN_PROTOCOL, capabilities: {} }
  });
  assert.equal(missingClientInfo.error, undefined, missingClientInfo.error?.message);
  assert.equal(missingClientInfo.result.protocolVersion, LEGACY_PROTOCOL, 'initialize always selects the documented legacy era');

  const presentClientInfo = await rpc.call({
    jsonrpc: '2.0', id: 'init-identified', method: 'initialize',
    params: {
      protocolVersion: LEGACY_PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'followup-test', version: '1.0.0' }
    }
  });
  assert.equal(presentClientInfo.error, undefined, presentClientInfo.error?.message);

  for (const [label, clientInfo] of [
    ['null', null],
    ['array', []],
    ['empty object', {}],
    ['empty version', { name: 'followup-test', version: '' }]
  ]) {
    const response = await rpc.call({
      jsonrpc: '2.0', id: `init-malformed-${label}`, method: 'initialize',
      params: { clientInfo }
    });
    assertRpcCode(response, -32602);
  }

  for (const [label, capabilities] of [['null', null], ['array', []], ['string', 'tools']]) {
    const response = await rpc.call({
      jsonrpc: '2.0', id: `init-capabilities-${label}`, method: 'initialize',
      params: { capabilities }
    });
    assertRpcCode(response, -32602);
  }
});

test('legacy JSON-RPC parse, request, method, params, primitive, and domain errors stay numeric and distinguishable', async (t) => {
  const rpc = await startMcp(t);

  const parsePending = rpc.waitFor((response) => response.id === null, 'parse error');
  rpc.sendRaw('{not-json');
  const parse = await parsePending;

  const invalidRequest = await rpc.call({ jsonrpc: '1.0', id: 'invalid-request', method: 'tools/list' });
  const unknownMethod = await rpc.call({ jsonrpc: '2.0', id: 'unknown-method', method: 'shadowgraph/missing' });
  const invalidParams = await rpc.call({ jsonrpc: '2.0', id: 'invalid-params', method: 'tools/list', params: [] });
  const unknownTool = await rpc.call({
    jsonrpc: '2.0', id: 'unknown-tool', method: 'tools/call',
    params: { name: 'shadowgraph_missing', arguments: {} }
  });
  const unknownResource = await rpc.call({
    jsonrpc: '2.0', id: 'unknown-resource', method: 'resources/read',
    params: { uri: 'shadowgraph://missing' }
  });
  const unknownPrompt = await rpc.call({
    jsonrpc: '2.0', id: 'unknown-prompt', method: 'prompts/get',
    params: { name: 'shadowgraph_missing' }
  });
  const domainFailure = await rpc.call({
    jsonrpc: '2.0', id: 'domain-failure', method: 'tools/call',
    params: {
      name: 'shadowgraph_update_status',
      arguments: { decisionId: 'missing-decision', status: 'planned' }
    }
  });

  for (const [label, response, code, message] of [
    ['parse', parse, -32700, /Parse error/],
    ['invalid request', invalidRequest, -32600, /Invalid Request/],
    ['unknown method', unknownMethod, -32601, /Method not found/],
    ['invalid params', invalidParams, -32602, /Invalid params/],
    ['unknown tool', unknownTool, -32601, /Unknown tool/],
    ['unknown resource', unknownResource, -32602, /Unknown resource URI/],
    ['unknown prompt', unknownPrompt, -32602, /Unknown prompt/],
    ['domain failure', domainFailure, -32000, /Decision not found/]
  ]) {
    assertRpcCode(response, code);
    assert.match(response.error.message, message, label);
    assert.deepEqual(Object.keys(response.error).filter((key) => !['code', 'message', 'data'].includes(key)), [], `${label} must not expose internal error fields`);
  }

  const signatures = [parse, invalidRequest, unknownMethod, invalidParams, unknownTool, unknownResource, unknownPrompt, domainFailure]
    .map((response) => `${response.error.code}:${response.error.message}`);
  assert.equal(new Set(signatures).size, signatures.length, 'each failure category remains distinguishable by numeric code plus public message');
});

test('modern notifications with omitted clientInfo execute when applicable and never emit responses', async (t) => {
  const rpc = await startMcp(t);

  rpc.send({ jsonrpc: '2.0', method: 'server/discover', params: modernParams() });
  rpc.send({ jsonrpc: '2.0', method: 'notifications/initialized', params: modernParams() });
  rpc.send({ jsonrpc: '2.0', method: 'notifications/unknown', params: modernParams({ reason: 'ignored' }) });
  rpc.send({
    jsonrpc: '2.0', method: 'tools/call',
    params: modernParams({
      name: 'shadowgraph_record_decision',
      arguments: { id: 'notification-decision', project: 'followup', title: 'Notification write', chosen: 'keep' }
    })
  });

  const after = await rpc.call({
    jsonrpc: '2.0', id: 'after-notifications', method: 'tools/call',
    params: modernParams({
      name: 'shadowgraph_search',
      arguments: { project: 'followup', query: 'Notification write' }
    })
  });
  assert.equal(after.error, undefined, after.error?.message);
  assert.equal(after.result.isError, false);
  const search = JSON.parse(after.result.content[0].text);
  assert.equal(search.page.total, 1, 'the no-id tool call must execute before the later queued search');
  assert.deepEqual(rpc.responses.map((response) => response.id), ['after-notifications'], 'no no-id message may emit id:null or any other response');

  const explicitNull = await rpc.call({
    jsonrpc: '2.0', id: null, method: 'notifications/initialized', params: {}
  });
  assert.deepEqual(explicitNull, { jsonrpc: '2.0', id: null, result: {} }, 'an explicit null id remains a request, not a notification');
});

test('persistence conflicts remain numeric in legacy mode and become private tool failures in modern mode', async (t) => {
  const rpc = await startMcp(t);
  const privateSentinel = 'PRIVATE-PERSISTED-TITLE-2d91';

  const seeded = await rpc.call({
    jsonrpc: '2.0', id: 'seed', method: 'tools/call',
    params: {
      name: 'shadowgraph_record_decision',
      arguments: { id: 'seed-decision', project: 'followup', title: privateSentinel, chosen: 'keep' }
    }
  });
  assert.equal(seeded.error, undefined, seeded.error?.message);

  const external = createJsonFileStore(rpc.file);
  t.after(() => external.close());
  const revisionOne = await external.load();
  assert.equal(revisionOne.revision, 1);
  await external.save(revisionOne);

  const legacyConflict = await rpc.call({
    jsonrpc: '2.0', id: 'legacy-conflict', method: 'tools/call',
    params: {
      name: 'shadowgraph_record_decision',
      arguments: { id: 'legacy-conflict-write', project: 'followup', title: 'Must roll back', chosen: 'reject' }
    }
  });
  assertSafeToolFailure(legacyConflict, {
    message: 'Storage revision conflict',
    forbidden: [privateSentinel, 'expected 1', 'found 2']
  });

  const revisionTwo = await external.load();
  assert.equal(revisionTwo.revision, 2);
  await external.save(revisionTwo);

  const modernConflict = await rpc.call({
    jsonrpc: '2.0', id: 'modern-conflict', method: 'tools/call',
    params: modernParams({
      name: 'shadowgraph_record_decision',
      arguments: { id: 'modern-conflict-write', project: 'followup', title: 'Must also roll back', chosen: 'reject' }
    })
  });
  assertSafeToolFailure(modernConflict, {
    modern: true,
    message: 'Storage revision conflict',
    forbidden: [privateSentinel, 'expected 2', 'found 3']
  });
});

test('legacy restore filesystem and malformed-data failures use numeric codes without disclosing paths or payloads', async (t) => {
  const rpc = await startMcp(t);
  const privatePathSentinel = 'PRIVATE-LEGACY-RESTORE-PATH-a4e2';
  const missingSource = join(rpc.directory, privatePathSentinel, 'missing.json');

  const missing = await rpc.call({
    jsonrpc: '2.0', id: 'legacy-restore-missing', method: 'tools/call',
    params: { name: 'shadowgraph_restore', arguments: { source: missingSource } }
  });
  assertSafeToolFailure(missing, {
    forbidden: [privatePathSentinel, missingSource, rpc.directory]
  });

  const privatePayloadSentinel = 'PRIVATE-MALFORMED-RESTORE-CONTENT-b51d';
  const malformedSource = join(rpc.directory, 'malformed.json');
  await writeFile(malformedSource, privatePayloadSentinel, 'utf8');
  const malformed = await rpc.call({
    jsonrpc: '2.0', id: 'legacy-restore-malformed', method: 'tools/call',
    params: { name: 'shadowgraph_restore', arguments: { source: malformedSource } }
  });
  assertSafeToolFailure(malformed, {
    message: 'Tool execution failed: invalid JSON data',
    forbidden: [privatePayloadSentinel, malformedSource, rpc.directory]
  });
  assert.notEqual(missing.error.message, malformed.error.message, 'filesystem and data-format failures remain distinguishable');
});

test('unconfirmed restore and its degraded latch use distinct finite numeric server errors without exposing stored content', async (t) => {
  const rpc = await startMcp(t, {
    NODE_ENV: 'test',
    SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'afterReplacementRename,beforeRollbackInstall'
  });
  const privateSentinel = 'PRIVATE-RESTORE-PAYLOAD-84c6';

  const seeded = await rpc.call({
    jsonrpc: '2.0', id: 'degraded-seed', method: 'tools/call',
    params: {
      name: 'shadowgraph_record_decision',
      arguments: { id: 'degraded-seed', project: 'followup', title: privateSentinel, chosen: 'keep' }
    }
  });
  assert.equal(seeded.error, undefined, seeded.error?.message);
  const source = join(rpc.directory, 'restore-source.json');
  await writeFile(source, await readFile(rpc.file));

  const restore = await rpc.call({
    jsonrpc: '2.0', id: 'unconfirmed-restore', method: 'tools/call',
    params: { name: 'shadowgraph_restore', arguments: { source } }
  });
  assertSafeToolFailure(restore, {
    message: 'Tool execution failed (json_restore_recovery_unconfirmed)',
    data: {
      issueCode: 'json_restore_recovery_unconfirmed',
      recoveryCode: 'json_restore_recovery_unconfirmed'
    },
    forbidden: [privateSentinel, source, rpc.directory, 'afterReplacementRename', 'beforeRollbackInstall']
  });

  const blockedTool = await rpc.call({
    jsonrpc: '2.0', id: 'degraded-tool', method: 'tools/call',
    params: { name: 'shadowgraph_search', arguments: { query: privateSentinel } }
  });
  assertSafeToolFailure(blockedTool, {
    code: -32001,
    message: 'Persistent storage unavailable',
    data: { recoveryCode: 'json_restore_recovery_unconfirmed' },
    forbidden: [privateSentinel, source, rpc.directory]
  });

  const blockedResource = await rpc.call({
    jsonrpc: '2.0', id: 'degraded-resource', method: 'resources/read',
    params: { uri: 'shadowgraph://context' }
  });
  assertRpcCode(blockedResource, -32001);
  assert.equal(blockedResource.error.message, 'Persistent storage unavailable');
  assert.equal(blockedResource.error.data.recoveryCode, 'json_restore_recovery_unconfirmed');
  assert.deepEqual(blockedResource.error.data, { recoveryCode: 'json_restore_recovery_unconfirmed' });
  assert.deepEqual(collectPrivateErrorKeys(blockedResource), []);

  const diagnostics = await rpc.call({ jsonrpc: '2.0', id: 'degraded-diagnostics', method: 'tools/list' });
  assert.equal(diagnostics.error, undefined, diagnostics.error?.message);
  assert.equal(diagnostics.result.tools.length, 27, 'non-stateful protocol diagnostics remain available');
  assert.notEqual(restore.error.code, blockedTool.error.code, 'initial restore failure and fail-closed latch remain distinguishable');
});

for (const modern of [false, true]) {
  const era = modern ? 'modern' : 'legacy';
  for (const scenario of privateRestoreScenarios()) {
    test(`${era} JSON restore keeps ${scenario.label} private`, async (t) => {
      const rpc = await startMcp(t);
      const source = join(rpc.directory, `${era}-${scenario.label.replaceAll(' ', '-')}.json`);
      await writeFile(source, `${JSON.stringify(scenario.payload)}\n`, 'utf8');
      const response = await rpc.call(toolRequest(
        `${era}-${scenario.label}`,
        'shadowgraph_restore',
        { source },
        { modern }
      ));
      assertSafeToolFailure(response, {
        modern,
        forbidden: [scenario.sentinel, source, rpc.directory, 'Duplicate ', 'records[', 'facts[', 'relations[', 'journal[', 'reviewSignals[', 'idempotency[', 'events[']
      });
    });
  }
}

for (const modern of [false, true]) {
  const era = modern ? 'modern' : 'legacy';
  test(`${era} direct tool validation keeps project, status, and temporal payloads private`, async (t) => {
    const rpc = await startMcp(t);
    const projectSentinel = 'PRIVATE-DIRECT-PROJECT-4b5f';
    const temporalSentinel = 'PRIVATE-DIRECT-TEMPORAL-5c60';
    const statusSentinel = 'PRIVATE-DIRECT-STATUS-6d71';

    const malformedProject = await rpc.call(toolRequest(
      `${era}-malformed-project`,
      'shadowgraph_record_decision',
      { id: 'direct-project', project: { sentinel: projectSentinel }, title: 'Private project', chosen: 'reject' },
      { modern }
    ));
    assertSafeToolFailure(malformedProject, { modern, forbidden: [projectSentinel, 'project must be'] });

    const malformedTemporal = await rpc.call(toolRequest(
      `${era}-malformed-temporal`,
      'shadowgraph_record_decision',
      { id: 'direct-temporal', title: 'Private temporal', chosen: 'reject', createdAt: temporalSentinel },
      { modern }
    ));
    assertSafeToolFailure(malformedTemporal, { modern, forbidden: [temporalSentinel, 'createdAt must be'] });

    const seed = await rpc.call(toolRequest(
      `${era}-status-seed`,
      'shadowgraph_record_decision',
      { id: `${era}-status-owner`, title: 'Status owner', chosen: 'keep' },
      { modern }
    ));
    assert.equal(seed.error, undefined, seed.error?.message);
    const malformedStatus = await rpc.call(toolRequest(
      `${era}-malformed-status`,
      'shadowgraph_update_status',
      { decisionId: `${era}-status-owner`, status: statusSentinel },
      { modern }
    ));
    assertSafeToolFailure(malformedStatus, { modern, forbidden: [statusSentinel, 'Invalid decision status'] });
  });
}

for (const modern of [false, true]) {
  const era = modern ? 'modern' : 'legacy';
  for (const [label, issueCode, payload] of [
    ['duplicate journal sequence', 'duplicate_journal_sequence', (() => {
      const value = emptyRestorePayload();
      value.journal = [
        { id: 'safe-sequence-left', seq: 1, type: 'legacy_metadata_event', schemaVersion: 4, payload: null, replayable: false },
        { id: 'safe-sequence-right', seq: 1, type: 'legacy_metadata_event', schemaVersion: 4, payload: null, replayable: false }
      ];
      value.journalSeq = 1;
      value.journalEpoch = 1;
      return value;
    })()],
    ['unsupported schema version', 'unsupported_schema_version', emptyRestorePayload(999)]
  ]) {
    test(`${era} preserves allowlisted ${label} code without its private diagnostic`, async (t) => {
      const rpc = await startMcp(t);
      const source = join(rpc.directory, `${era}-${label.replaceAll(' ', '-')}.json`);
      await writeFile(source, `${JSON.stringify(payload)}\n`, 'utf8');
      const response = await rpc.call(toolRequest(`${era}-${label}`, 'shadowgraph_restore', { source }, { modern }));
      assertSafeToolFailure(response, {
        modern,
        message: `Tool execution failed (${issueCode})`,
        data: modern ? undefined : { issueCode },
        forbidden: [source, rpc.directory, 'sequence 1', 'schemaVersion 999']
      });
    });
  }
}

test('protocol errors keep allowlisted categories but never echo method, tool, resource, prompt, or requested-version payloads', async (t) => {
  const rpc = await startMcp(t);
  const sentinels = {
    method: 'PRIVATE-METHOD-NAME-7e82',
    tool: 'PRIVATE-TOOL-NAME-8f93',
    resource: 'shadowgraph://PRIVATE-RESOURCE-9a04',
    prompt: 'PRIVATE-PROMPT-ab15',
    version: 'PRIVATE-VERSION-bc26'
  };
  const cases = [
    [{ jsonrpc: '2.0', id: 'private-method', method: sentinels.method }, -32601, 'Method not found', sentinels.method],
    [toolRequest('private-tool', sentinels.tool, {}), -32601, 'Unknown tool', sentinels.tool],
    [{ jsonrpc: '2.0', id: 'private-resource', method: 'resources/read', params: { uri: sentinels.resource } }, -32602, 'Unknown resource URI', sentinels.resource],
    [{ jsonrpc: '2.0', id: 'private-prompt', method: 'prompts/get', params: { name: sentinels.prompt } }, -32602, 'Unknown prompt', sentinels.prompt],
    [{
      jsonrpc: '2.0', id: 'private-version', method: 'server/discover',
      params: {
        _meta: {
          [PROTOCOL_VERSION_META]: sentinels.version,
          [CLIENT_CAPABILITIES_META]: {}
        }
      }
    }, -32022, 'Unsupported protocol version', sentinels.version]
  ];

  for (const [request, code, message, sentinel] of cases) {
    const response = await rpc.call(request);
    assertRpcCode(response, code);
    assert.equal(response.error.message, message);
    assert.equal(JSON.stringify(response).includes(sentinel), false);
    assert.deepEqual(collectPrivateErrorKeys(response), []);
  }

  const invalidParams = await rpc.call({ jsonrpc: '2.0', id: 'safe-invalid-params', method: 'tools/list', params: [] });
  assertRpcCode(invalidParams, -32602);
  assert.equal(invalidParams.error.message, 'Invalid params: params must be an object');
});

test('plain persistence faults are private in legacy and remain CallToolResult failures in modern mode', async (t) => {
  let faultFile;
  const rpc = await startMcp(t, async ({ directory }) => {
    faultFile = join(directory, 'PRIVATE-SAVE-FAULT-PATH-cd37');
    await writeFile(faultFile, 'beforeCommit', 'utf8');
    return { NODE_ENV: 'test', SHADOWGRAPH_TEST_SAVE_FAULT_FILE: faultFile };
  });
  const sentinel = 'PRIVATE-PERSISTENCE-PAYLOAD-de48';

  const legacy = await rpc.call(toolRequest('legacy-private-persistence', 'shadowgraph_record_decision', {
    id: sentinel, title: sentinel, chosen: 'reject disclosure'
  }));
  assertSafeToolFailure(legacy, { forbidden: [sentinel, faultFile, 'beforeCommit', 'injected MCP persistence fault'] });

  await writeFile(faultFile, 'beforeCommit', 'utf8');
  const modern = await rpc.call(toolRequest('modern-private-persistence', 'shadowgraph_record_decision', {
    id: `${sentinel}-modern`, title: sentinel, chosen: 'reject disclosure'
  }, { modern: true }));
  assertSafeToolFailure(modern, { modern: true, forbidden: [sentinel, faultFile, 'beforeCommit', 'injected MCP persistence fault'] });
});

test('modern nested restore causes and degraded latch stay private CallToolResult failures', async (t) => {
  const rpc = await startMcp(t, {
    NODE_ENV: 'test',
    SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'afterReplacementRename,beforeRollbackInstall',
    SHADOWGRAPH_TEST_RESTORE_STAT_ERROR_SUFFIX: '.rollback',
    SHADOWGRAPH_TEST_RESTORE_STAT_ERROR_CODE: 'EACCES'
  });
  const sentinel = 'PRIVATE-NESTED-RESTORE-PAYLOAD-ef59';
  const seeded = await rpc.call(toolRequest('nested-seed', 'shadowgraph_record_decision', {
    id: 'nested-seed', title: sentinel, chosen: 'keep'
  }));
  assert.equal(seeded.error, undefined, seeded.error?.message);
  const source = join(rpc.directory, 'PRIVATE-NESTED-RESTORE-SOURCE-f06a.json');
  await writeFile(source, await readFile(rpc.file));

  const restore = await rpc.call(toolRequest('modern-nested-restore', 'shadowgraph_restore', { source }, { modern: true }));
  assertSafeToolFailure(restore, {
    modern: true,
    message: 'Tool execution failed (json_restore_recovery_unconfirmed)',
    forbidden: [sentinel, source, rpc.directory, 'afterReplacementRename', 'beforeRollbackInstall', '.rollback']
  });

  const blocked = await rpc.call(toolRequest('modern-degraded', 'shadowgraph_search', { query: sentinel }, { modern: true }));
  assertSafeToolFailure(blocked, {
    modern: true,
    message: 'Persistent storage unavailable',
    forbidden: [sentinel, source, rpc.directory, '.rollback']
  });
});

test('SQLite restore duplicate journal payload ids stay private in legacy and modern modes', async (t) => {
  const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
  if (!sqlite.available) return t.skip(sqlite.reason);

  const rpc = await startMcp(t, ({ directory }) => ({
    SHADOWGRAPH_STORAGE: 'sqlite',
    SHADOWGRAPH_FILE: join(directory, 'live.db')
  }));
  await rpc.call({ jsonrpc: '2.0', id: 'sqlite-ready', method: 'tools/list' });
  const source = join(rpc.directory, 'PRIVATE-SQLITE-RESTORE-SOURCE-017b.db');
  const graph = createShadowGraph({ now: () => '2026-08-28T12:00:00.000Z' });
  graph.addDecision({ id: 'sqlite-private-left', title: 'Left', chosen: 'keep' });
  graph.addDecision({ id: 'sqlite-private-right', title: 'Right', chosen: 'keep' });
  const sourceStore = await createSqliteStore(source);
  await sourceStore.save(graph.exportData());
  sourceStore.close();

  const sentinel = 'PRIVATE-SQLITE-DUPLICATE-JOURNAL-ID-128c';
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(source);
  try {
    const rows = database.prepare('SELECT rowid, payload FROM shadowgraph_journal ORDER BY rowid').all();
    assert.equal(rows.length, 2);
    const update = database.prepare('UPDATE shadowgraph_journal SET payload = ? WHERE rowid = ?');
    for (const row of rows) update.run(JSON.stringify({ ...JSON.parse(row.payload), id: sentinel }), row.rowid);
  } finally {
    database.close();
  }

  for (const modern of [false, true]) {
    const response = await rpc.call(toolRequest(`sqlite-private-${modern ? 'modern' : 'legacy'}`, 'shadowgraph_restore', { source }, { modern }));
    assertSafeToolFailure(response, {
      modern,
      forbidden: [sentinel, source, rpc.directory, 'Duplicate journal id', 'SQLITE']
    });
  }
});
