import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { createAdapterRequest, validateAdapterResponse } from '../benchmark/lib/adapter-protocol.mjs';
import { namespaceRefFor, OPERATION_FIELDS, recordContentSha256 } from '../benchmark/lib/v11-contract.mjs';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcpEntry = path.join(repositoryRoot, 'src', 'mcp.js');

function mcpEnvironment(file, storage = 'json', extra = {}) {
  const inherited = Object.fromEntries(
    ['HOME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'TZ']
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])
  );
  return {
    ...inherited,
    SHADOWGRAPH_FILE: file,
    SHADOWGRAPH_STORAGE: storage,
    ...extra
  };
}

async function runMcp({ file, storage = 'json', requests, env = {} }) {
  const child = spawn(process.execPath, [mcpEntry], {
    cwd: repositoryRoot,
    env: mcpEnvironment(file, storage, env),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  for (const request of requests) child.stdin.write(`${JSON.stringify(request)}\n`);
  child.stdin.end();
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function initialize(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'benchmark-contract-test', version: '1' }
    }
  };
}

function toolCall(id, name, args) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args }
  };
}

function toolPayload(response) {
  return JSON.parse(response.result.content[0].text);
}

function decisionContent(overrides = {}) {
  return {
    decisionId: 'model-decision-a',
    choiceId: 'choice-a',
    recalledAlternativeIds: ['alternative-a'],
    recalledRejectionReasonIds: ['reason-a'],
    constraintIdsAddressed: ['constraint-a'],
    evidenceIdsCited: ['evidence-a'],
    riskIdsRecognized: ['risk-a'],
    reviewTriggerIds: ['trigger-a'],
    changedFactDetected: false,
    changedFactId: null,
    recommendation: 'Use the reversible migration.',
    failedAttemptIdsAvoided: [],
    failedAttemptReasonIdsCited: [],
    memoryProjectId: 'primary-project',
    memoryUserId: null,
    ...overrides
  };
}

function requestFor(operation, overrides = {}) {
  const phase = overrides.phase ?? 'A';
  const correlation = {
    runId: overrides.runId ?? 'run-one',
    attemptId: overrides.attemptId ?? `attempt-${operation}-${phase}`,
    phase,
    armId: overrides.armId ?? 'shadowgraph-full',
    scenarioId: overrides.scenarioId ?? 'scenario-one',
    repetition: overrides.repetition ?? 0
  };
  const namespace = overrides.namespace ?? { projectId: 'primary-project', userId: null };
  const record = overrides.record ?? {
    id: 'decision:shadowgraph:scenario-one:0:A',
    type: 'decision',
    content: decisionContent()
  };
  let payload;
  if (operation === 'reset') payload = {};
  else if (operation === 'retrieve') payload = { query: { scenarioId: correlation.scenarioId, task: 'Choose a safe migration.' } };
  else if (operation === 'persist') payload = { record };
  else {
    const expectedRecord = {
      id: record.id,
      type: record.type,
      contentSha256: recordContentSha256(record.content)
    };
    payload = {
      expectedRecord,
      alternateNamespace: null,
      alternateNamespaceRef: null,
      expectedAbsentRecord: null,
      ...(overrides.payload ?? {})
    };
  }
  return createAdapterRequest({ operation, correlation, namespace, payload });
}

test('MCP schemas expose optional non-empty explicit ids for v1.1 records', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-schema-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const responses = await runMcp({
    file: path.join(directory, 'state.json'),
    requests: [
      initialize(),
      { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    ]
  });
  const tools = responses.find((response) => response.id === 2).result.tools;
  const decision = tools.find((tool) => tool.name === 'shadowgraph_record_decision').inputSchema;
  const attempt = tools.find((tool) => tool.name === 'shadowgraph_record_attempt').inputSchema;

  assert.deepEqual(decision.properties.id, { type: 'string', minLength: 1 });
  assert.deepEqual(decision.properties.alternatives.items.properties.id, { type: 'string', minLength: 1 });
  assert.deepEqual(attempt.properties.id, { type: 'string', minLength: 1 });
  assert.equal(decision.required.includes('id'), false);
  assert.equal(attempt.required.includes('id'), false);
});

for (const storage of ['json', 'sqlite']) {
  test(`explicit decision, alternative, and attempt ids survive ${storage} MCP restart`, async (t) => {
    if (storage === 'sqlite' && !(await getRuntimeCapabilities()).nodeSqlite.available) {
      t.skip((await getRuntimeCapabilities()).nodeSqlite.reason);
      return;
    }
    const directory = await mkdtemp(path.join(os.tmpdir(), `shadowgraph-v11-${storage}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const file = path.join(directory, storage === 'sqlite' ? 'state.sqlite' : 'state.json');
    const first = await runMcp({
      file,
      storage,
      requests: [
        initialize(),
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        toolCall(2, 'shadowgraph_record_decision', {
          id: 'harness-decision-id',
          title: 'scenario-one',
          chosen: 'safe-choice',
          project: 'primary-project',
          alternatives: [{ id: 'harness-alternative-id', label: 'other-choice' }]
        }),
        toolCall(3, 'shadowgraph_record_attempt', {
          id: 'harness-attempt-id',
          solution: 'unsafe-choice',
          result: 'failed',
          project: 'primary-project'
        })
      ]
    });
    assert.equal(toolPayload(first.find((response) => response.id === 2)).id, 'harness-decision-id');
    assert.equal(toolPayload(first.find((response) => response.id === 2)).alternatives[0].id, 'harness-alternative-id');
    assert.equal(toolPayload(first.find((response) => response.id === 3)).id, 'harness-attempt-id');

    const restarted = await runMcp({
      file,
      storage,
      requests: [
        initialize(),
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        toolCall(2, 'shadowgraph_search', { query: '', project: 'primary-project', kind: 'decision', limit: 1000 }),
        toolCall(3, 'shadowgraph_search', { query: '', project: 'primary-project', kind: 'attempt', limit: 1000 })
      ]
    });
    const decisions = toolPayload(restarted.find((response) => response.id === 2)).items;
    const attempts = toolPayload(restarted.find((response) => response.id === 3)).items;
    assert.equal(decisions[0].record.id, 'harness-decision-id');
    assert.equal(decisions[0].record.alternatives[0].id, 'harness-alternative-id');
    assert.equal(attempts[0].record.id, 'harness-attempt-id');
  });
}

test('node adapter host negotiates legacy MCP and enforces exact full and compact tool surfaces', async (t) => {
  const { withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-host-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const full = await withMcpSession({
    file: path.join(directory, 'full.json'),
    storage: 'json',
    compact: false
  }, async ({ tools }) => tools.map(({ name }) => name));
  const compact = await withMcpSession({
    file: path.join(directory, 'compact.json'),
    storage: 'json',
    compact: true
  }, async ({ tools }) => tools.map(({ name }) => name));
  assert.equal(full.length, 27);
  assert.equal(compact.length, 12);
  assert.equal(full.includes('shadowgraph_verify_fact'), false);
  assert.equal(compact.includes('shadowgraph_verify_fact'), false);
});

test('ShadowGraph adapter binds each exact arm to its explicitly configured MCP mode before state or process effects', async (t) => {
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const { COMPACT_TOOL_NAMES, FULL_TOOL_NAMES, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-arm-mode-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entryPath = await writeMcpFixture(directory, 'mode-probe', `
    import { writeFileSync } from 'node:fs';
    import { createInterface } from 'node:readline';
    const compact = process.env.SHADOWGRAPH_MCP_COMPACT === '1';
    writeFileSync(process.env.SHADOWGRAPH_FILE + '.mode', compact ? 'compact' : 'full');
    const tools = (compact ? ${JSON.stringify(COMPACT_TOOL_NAMES)} : ${JSON.stringify(FULL_TOOL_NAMES)})
      .map((name) => ({ name }));
    const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
    createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') send(request.id, {
        protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' }
      });
      else if (request.method === 'tools/list') send(request.id, { tools });
      else if (request.method === 'tools/call') {
        const { offset, limit } = request.params.arguments;
        send(request.id, { content: [{ type: 'text', text: JSON.stringify({
          items: [],
          page: { offset, limit, total: 0, hasMore: false },
          completeness: { losslessItems: true, total: 0, returned: 0 }
        }) }] });
      }
    });
  `);

  for (const [mode, armId, expectedProbe] of [
    ['full', 'shadowgraph-full', 'full'],
    ['compact', 'shadowgraph-compact', 'compact']
  ]) {
    const stateRoot = path.join(directory, `${mode}-state`);
    const adapter = createShadowGraphAdapter({
      stateRoot,
      backend: 'json',
      mode,
      mcpEntry: entryPath,
      timeoutMs: 2_000
    });
    const reset = requestFor('reset', { armId, phase: 'SETUP' });
    assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
    const retrieve = requestFor('retrieve', { armId, phase: 'A' });
    assert.equal((await adapter.execute(retrieve, {})).status, 'SUCCEEDED');
    const paths = await statePaths({ stateRoot, backend: 'json', request: reset });
    assert.equal(await readFile(`${paths.file}.mode`, 'utf8'), expectedProbe);
  }

  const mismatchRoot = path.join(directory, 'mismatch-must-not-exist');
  const mismatchAdapter = createShadowGraphAdapter({
    stateRoot: mismatchRoot,
    backend: 'json',
    mode: 'full',
    mcpEntry: entryPath,
    timeoutMs: 2_000
  });
  const wrongReset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  const wrongResetResponse = await mismatchAdapter.execute(wrongReset, {});
  assert.equal(wrongResetResponse.status, 'FAILED');
  assert.equal(wrongResetResponse.failure.cause, 'CONTRACT_FAILURE');
  await assert.rejects(lstat(mismatchRoot), { code: 'ENOENT' });

  const preparedRoot = path.join(directory, 'prepared-state');
  const preparedAdapter = createShadowGraphAdapter({
    stateRoot: preparedRoot,
    backend: 'json',
    mode: 'full',
    mcpEntry: entryPath,
    timeoutMs: 2_000
  });
  const preparedReset = requestFor('reset', { armId: 'shadowgraph-full', phase: 'SETUP' });
  assert.equal((await preparedAdapter.execute(preparedReset, {})).status, 'SUCCEEDED');
  const preparedPaths = await statePaths({ stateRoot: preparedRoot, backend: 'json', request: preparedReset });
  const wrongRetrieve = requestFor('retrieve', { armId: 'shadowgraph-compact', phase: 'A' });
  const wrongRetrieveResponse = await preparedAdapter.execute(wrongRetrieve, {});
  assert.equal(wrongRetrieveResponse.status, 'FAILED');
  assert.equal(wrongRetrieveResponse.failure.cause, 'CONTRACT_FAILURE');
  await assert.rejects(lstat(`${preparedPaths.file}.mode`), { code: 'ENOENT' });

  const unspecified = createShadowGraphAdapter({ stateRoot: path.join(directory, 'unspecified'), backend: 'json' });
  const unspecifiedResponse = await unspecified.execute(
    requestFor('reset', { armId: 'shadowgraph-full', phase: 'SETUP' }),
    {}
  );
  assert.equal(unspecifiedResponse.status, 'FAILED');
  assert.equal(unspecifiedResponse.failure.cause, 'CONTRACT_FAILURE');
  await assert.rejects(lstat(path.join(directory, 'unspecified')), { code: 'ENOENT' });
});

test('no-memory adapter is exact, private, and reports only truthful zero measurements', async () => {
  const { execute } = await import('../benchmark/adapters/no-memory.mjs');
  for (const operation of ['reset', 'retrieve', 'persist', 'verify']) {
    const request = requestFor(operation, { armId: 'no-memory', namespace: { projectId: null, userId: null } });
    const response = await execute(request, {});
    validateAdapterResponse({ request, response });
    assert.equal(response.status, ['persist', 'verify'].includes(operation) ? 'NOT_APPLICABLE' : 'SUCCEEDED');
    assert.deepEqual(response.result, {
      nativeContext: [],
      persistenceEvidence: null,
      isolationEvidence: null
    });
    assert.deepEqual(response.operations, Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0])));
    assert.deepEqual(response.storage, {
      status: 'MEASURED',
      bytes: 0,
      scope: 'no-memory control retains no product state',
      method: 'fixed control accounting: no persistence implementation exists',
      reason: null,
      blockedClaims: []
    });
    assert.equal(JSON.stringify(response).includes('primary-project'), false);
  }
});

test('no-memory adapter rejects every non-control arm before claiming success or non-applicability', async () => {
  const { execute } = await import('../benchmark/adapters/no-memory.mjs');
  for (const operation of ['reset', 'retrieve', 'persist']) {
    const request = requestFor(operation, {
      armId: 'shadowgraph-full',
      namespace: { projectId: null, userId: null }
    });
    const response = await execute(request, {});
    validateAdapterResponse({ request, response });
    assert.equal(response.status, 'FAILED', operation);
    assert.deepEqual(response.failure, {
      cause: 'CONTRACT_FAILURE',
      message: 'No-memory adapter requires the exact no-memory arm'
    });
    assert.deepEqual(response.result, {
      nativeContext: [],
      persistenceEvidence: null,
      isolationEvidence: null
    });
    assert.deepEqual(response.operations, Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0])));
  }
});

function alternateReference(request, namespace) {
  return namespaceRefFor({
    runId: request.runId,
    armId: request.armId,
    scenarioId: request.scenarioId,
    repetition: request.repetition,
    phase: request.phase
  }, namespace);
}

for (const backend of ['json', 'sqlite']) {
  test(`ShadowGraph ${backend} adapter uses one opaque leaf and verifies fresh native persistence and isolation`, async (t) => {
    if (backend === 'sqlite' && !(await getRuntimeCapabilities()).nodeSqlite.available) {
      t.skip((await getRuntimeCapabilities()).nodeSqlite.reason);
      return;
    }
    const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
    const { measureStateLeaf, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
    const { createStorage } = await import('../src/storage.js');
    const directory = await mkdtemp(path.join(os.tmpdir(), `shadowgraph-v11-adapter-${backend}-`));
    const stateRoot = path.join(directory, 'owned-state');
    t.after(() => rm(directory, { recursive: true, force: true }));
    const adapter = createShadowGraphAdapter({ stateRoot, backend, mode: 'full', timeoutMs: 10_000 });

    const reset = requestFor('reset', { phase: 'SETUP' });
    const resetResponse = await adapter.execute(reset, {});
    validateAdapterResponse({ request: reset, response: resetResponse });
    assert.equal(resetResponse.status, 'SUCCEEDED');
    assert.equal(resetResponse.storage.bytes, 0);
    assert.deepEqual(resetResponse.operations, Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0])));

    const emptyRetrieve = requestFor('retrieve', { phase: 'A' });
    const emptyResponse = await adapter.execute(emptyRetrieve, {});
    assert.equal(emptyResponse.status, 'SUCCEEDED');
    assert.deepEqual(emptyResponse.result.nativeContext, []);
    assert.equal(emptyResponse.operations.memoryReadOperations, 2);
    assert.equal(emptyResponse.operations.mcpToolCalls, 2);

    const decisionRecord = {
      id: 'harness-decision-phase-a',
      type: 'decision',
      content: decisionContent({
        decisionId: 'outer-decision-phase-a',
        recalledAlternativeIds: ['remembered-alternative-a', 'remembered-alternative-b']
      })
    };
    const persist = requestFor('persist', { phase: 'A', record: decisionRecord });
    const persistResponse = await adapter.execute(persist, {});
    validateAdapterResponse({ request: persist, response: persistResponse });
    assert.equal(persistResponse.status, 'SUCCEEDED');
    assert.equal(persistResponse.operations.memoryWriteOperations, 1);
    assert.equal(persistResponse.operations.mcpToolCalls, 1);
    assert.ok(persistResponse.storage.bytes > 0);

    const restartedRetrieve = await adapter.execute(emptyRetrieve, {});
    assert.deepEqual(restartedRetrieve.result.nativeContext, [{
      id: decisionRecord.id,
      type: decisionRecord.type,
      content: decisionRecord.content
    }]);

    const verify = requestFor('verify', { phase: 'A', record: decisionRecord });
    const verifyResponse = await adapter.execute(verify, {});
    validateAdapterResponse({ request: verify, response: verifyResponse });
    assert.equal(verifyResponse.status, 'SUCCEEDED');
    assert.deepEqual(verifyResponse.result.persistenceEvidence.matchedRecordIds, [decisionRecord.id]);
    assert.equal(
      verifyResponse.result.persistenceEvidence.observedContentSha256,
      recordContentSha256(decisionRecord.content)
    );
    assert.equal(verifyResponse.operations.persistenceVerificationOperations, verifyResponse.operations.mcpToolCalls);
    assert.ok(verifyResponse.operations.mcpToolCalls >= 1);

    const attemptRecord = {
      id: 'harness-failed-attempt-phase-b',
      type: 'failed_attempt',
      content: {
        id: 'harness-failed-attempt-phase-b',
        approachId: 'unsafe-approach',
        reasonId: 'failure-reason',
        reason: 'The unsafe approach failed deterministically.'
      }
    };
    const persistAttempt = requestFor('persist', { phase: 'B', record: attemptRecord });
    const attemptResponse = await adapter.execute(persistAttempt, {});
    assert.equal(attemptResponse.status, 'SUCCEEDED');
    const retrieveAttempts = requestFor('retrieve', { phase: 'B' });
    const attemptContext = await adapter.execute(retrieveAttempts, {});
    assert.deepEqual(attemptContext.result.nativeContext.find(({ id }) => id === attemptRecord.id), attemptRecord);

    const alternateNamespace = { projectId: 'alternate-project', userId: null };
    const alternateRetrieve = requestFor('retrieve', {
      phase: 'ISOLATION_PROJECT',
      namespace: alternateNamespace
    });
    const alternateContext = await adapter.execute(alternateRetrieve, {});
    assert.equal(alternateContext.status, 'SUCCEEDED');
    assert.deepEqual(alternateContext.result.nativeContext, []);

    const isolationRecord = {
      id: 'harness-decision-isolation-project',
      type: 'decision',
      content: decisionContent({ decisionId: 'outer-decision-isolation' })
    };
    const persistIsolation = requestFor('persist', {
      phase: 'ISOLATION_PROJECT',
      namespace: { projectId: 'primary-project', userId: null },
      record: isolationRecord
    });
    assert.equal((await adapter.execute(persistIsolation, {})).status, 'SUCCEEDED');
    const isolationVerifyBase = requestFor('verify', {
      phase: 'ISOLATION_PROJECT',
      namespace: { projectId: 'primary-project', userId: null },
      record: isolationRecord
    });
    const isolationVerify = requestFor('verify', {
      phase: 'ISOLATION_PROJECT',
      namespace: { projectId: 'primary-project', userId: null },
      record: isolationRecord,
      payload: {
        alternateNamespace,
        alternateNamespaceRef: alternateReference(isolationVerifyBase, alternateNamespace),
        expectedAbsentRecord: {
          id: decisionRecord.id,
          type: decisionRecord.type,
          contentSha256: recordContentSha256(decisionRecord.content)
        }
      }
    });
    const isolationResponse = await adapter.execute(isolationVerify, {});
    validateAdapterResponse({ request: isolationVerify, response: isolationResponse });
    assert.equal(isolationResponse.status, 'SUCCEEDED');
    assert.deepEqual(isolationResponse.result.isolationEvidence, {
      verified: true,
      expectedAbsentRecord: isolationVerify.payload.expectedAbsentRecord,
      alternateNamespaceRef: isolationVerify.payload.alternateNamespaceRef,
      matchingRecordIdCount: 0,
      matchingContentCount: 0
    });
    assert.equal(JSON.stringify(isolationResponse.result.persistenceEvidence).includes('primary-project'), false);
    assert.equal(JSON.stringify(isolationResponse.result.isolationEvidence).includes('alternate-project'), false);

    const paths = await statePaths({ stateRoot, backend, request: reset });
    assert.match(path.basename(paths.leaf), /^[a-f0-9]{64}$/u);
    assert.equal(path.dirname(paths.leaf), path.resolve(stateRoot));
    assert.equal(paths.leaf, (await statePaths({ stateRoot, backend, request: alternateRetrieve })).leaf);
    const measured = await measureStateLeaf(paths.leaf);
    assert.equal(isolationResponse.storage.bytes, measured.bytes);
    const store = await createStorage({ file: paths.file, type: backend });
    const direct = await store.load();
    await store.close();
    const nativeDecision = direct.records.find(({ id }) => id === decisionRecord.id);
    assert.ok(nativeDecision);
    assert.deepEqual(
      nativeDecision.alternatives.map(({ id }) => id),
      [`${decisionRecord.id}:alternative:0`, `${decisionRecord.id}:alternative:1`]
    );
    assert.equal(direct.records.some(({ project }) => project === alternateNamespace.projectId), false);

    const finalReset = await adapter.execute(reset, {});
    assert.equal(finalReset.status, 'SUCCEEDED');
    assert.equal(finalReset.storage.bytes, 0);
    assert.deepEqual(await readdir(paths.leaf), []);
  });
}

test('ShadowGraph adapter rejects user namespaces and invalid requests before creating state', async (t) => {
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-preflight-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'must-not-exist');
  const adapter = createShadowGraphAdapter({ stateRoot, backend: 'json', mode: 'full' });
  const userRequest = requestFor('reset', {
    namespace: { projectId: 'primary-project', userId: 'unsupported-user' }
  });
  const response = await adapter.execute(userRequest, {});
  assert.equal(response.status, 'FAILED');
  assert.equal(response.failure.cause, 'CONTRACT_FAILURE');
  await assert.rejects(readFile(path.join(stateRoot, '.shadowgraph-benchmark-state-v1')), { code: 'ENOENT' });

  const invalid = { ...requestFor('reset'), unexpected: true };
  await assert.rejects(adapter.execute(invalid, {}), /Unknown adapter request field/u);
  await assert.rejects(readFile(path.join(stateRoot, '.shadowgraph-benchmark-state-v1')), { code: 'ENOENT' });
});

for (const backend of ['json', 'sqlite']) {
  test(`ShadowGraph ${backend} rejects an exact product-file symlink before MCP can touch its target`, async (t) => {
    if (backend === 'sqlite' && !(await getRuntimeCapabilities()).nodeSqlite.available) {
      t.skip((await getRuntimeCapabilities()).nodeSqlite.reason);
      return;
    }
    const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
    const { statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
    const directory = await mkdtemp(path.join(os.tmpdir(), `shadowgraph-v11-state-symlink-${backend}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const stateRoot = path.join(directory, 'owned-state');
    const adapter = createShadowGraphAdapter({ stateRoot, backend, mode: 'full', timeoutMs: 10_000 });
    const reset = requestFor('reset', { armId: 'shadowgraph-full', phase: 'SETUP' });
    assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
    const paths = await statePaths({ stateRoot, backend, request: reset });
    const outsideTarget = path.join(directory, `outside-${backend}-must-not-exist`);
    await symlink(outsideTarget, paths.file, 'file');

    const persist = requestFor('persist', {
      armId: 'shadowgraph-full',
      phase: 'A',
      record: { id: `symlink-${backend}-record`, type: 'decision', content: decisionContent() }
    });
    const response = await adapter.execute(persist, {});
    validateAdapterResponse({ request: persist, response });
    assert.equal(response.status, 'FAILED');
    assert.equal(response.failure.cause, 'CONTRACT_FAILURE');
    assert.deepEqual(response.operations, Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0])));
    await assert.rejects(lstat(outsideTarget), { code: 'ENOENT' });
    assert.equal((await lstat(paths.file)).isSymbolicLink(), true);
  });
}

test('ShadowGraph rejects SQLite sidecar symlinks and hard-linked leaf entries before spawning MCP', async (t) => {
  if (!(await getRuntimeCapabilities()).nodeSqlite.available) {
    t.skip((await getRuntimeCapabilities()).nodeSqlite.reason);
    return;
  }
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const { statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-state-entries-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const adapter = createShadowGraphAdapter({ stateRoot, backend: 'sqlite', mode: 'full', timeoutMs: 10_000 });
  const reset = requestFor('reset', { armId: 'shadowgraph-full', phase: 'SETUP' });
  assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
  const paths = await statePaths({ stateRoot, backend: 'sqlite', request: reset });
  const outsideSidecar = path.join(directory, 'outside-sidecar-must-not-exist');
  const sidecar = `${paths.file}-wal`;
  await symlink(outsideSidecar, sidecar, 'file');
  const persist = requestFor('persist', {
    armId: 'shadowgraph-full',
    phase: 'A',
    record: { id: 'sidecar-symlink-record', type: 'decision', content: decisionContent() }
  });
  const sidecarResponse = await adapter.execute(persist, {});
  assert.equal(sidecarResponse.status, 'FAILED');
  assert.equal(sidecarResponse.failure.cause, 'CONTRACT_FAILURE');
  assert.deepEqual(sidecarResponse.operations, Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0])));
  await assert.rejects(lstat(outsideSidecar), { code: 'ENOENT' });

  await rm(sidecar, { force: true });
  const outsideHardLink = path.join(directory, 'outside-hard-link-sentinel');
  await writeFile(outsideHardLink, 'outside hard-link sentinel\n', 'utf8');
  const hardLinkedEntry = path.join(paths.leaf, 'unexpected-product-entry');
  await link(outsideHardLink, hardLinkedEntry);
  const retrieve = requestFor('retrieve', { armId: 'shadowgraph-full', phase: 'A' });
  const hardLinkResponse = await adapter.execute(retrieve, {});
  assert.equal(hardLinkResponse.status, 'FAILED');
  assert.equal(hardLinkResponse.failure.cause, 'CONTRACT_FAILURE');
  assert.deepEqual(hardLinkResponse.operations, Object.fromEntries(OPERATION_FIELDS.map((field) => [field, 0])));
  assert.equal(await readFile(outsideHardLink, 'utf8'), 'outside hard-link sentinel\n');
  assert.equal((await lstat(hardLinkedEntry)).nlink, 2);
});

async function writeMcpFixture(directory, name, source) {
  const fixture = path.join(directory, `${name}.mjs`);
  await writeFile(fixture, source, 'utf8');
  return fixture;
}

async function captureRejection(operation) {
  try {
    await operation();
  } catch (error) {
    return error;
  }
  assert.fail('Expected operation to reject');
}

function fixtureServerSource(toolNames, toolHandler, setup = '', closeHandler = '') {
  return `
import { createInterface } from 'node:readline';
${setup}
const tools = ${JSON.stringify(toolNames)}.map((name) => ({ name }));
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.method === 'initialize') send(request.id, { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } });
  else if (request.method === 'notifications/initialized') {}
  else if (request.method === 'tools/list') send(request.id, { tools });
  else if (request.method === 'tools/call') { ${toolHandler} }
});
${closeHandler}
`;
}

test('host correlates concurrent MCP responses by id rather than FIFO order', async (t) => {
  const { COMPACT_TOOL_NAMES, withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-correlation-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entryPath = await writeMcpFixture(directory, 'out-of-order', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `
      pending.push(request);
      if (pending.length === 2) {
        for (const item of pending.reverse()) {
          send(item.id, { content: [{ type: 'text', text: JSON.stringify({ token: item.params.arguments.token }) }] });
        }
      }
    `,
    'const pending = [];'
  ));
  const values = await withMcpSession({
    file: path.join(directory, 'unused.json'),
    storage: 'json',
    compact: true,
    entryPath,
    timeoutMs: 2_000
  }, async (client) => Promise.all([
    client.callTool('shadowgraph_search', { token: 'first' }),
    client.callTool('shadowgraph_search', { token: 'second' })
  ]));
  assert.deepEqual(values, [{ token: 'first' }, { token: 'second' }]);
});

test('host fails closed on wrong ids, malformed NDJSON, and bounded stdout or stderr', async (t) => {
  const { withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-wire-faults-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const cases = [
    ['wrong-id', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', () => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: 'not-requested', result: {} }) + '\\n');
      });
    `],
    ['malformed', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', () => process.stdout.write('{malformed\\n'));
    `],
    ['unterminated-line', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', () => {
        process.stdout.write('{malformed');
        process.exit(0);
      });
    `],
    ['extra-response-property', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', (line) => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: {}, extra: true }) + '\\n');
      });
    `],
    ['result-and-error', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', (line) => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: request.id, result: {}, error: { code: -32000, message: 'private' }
        }) + '\\n');
      });
    `],
    ['missing-result-and-error', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', (line) => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id }) + '\\n');
      });
    `],
    ['invalid-error-shape', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', (line) => {
        const request = JSON.parse(line);
        process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: request.id, error: { code: -32000, message: 'private', extra: true }
        }) + '\\n');
      });
    `],
    ['duplicate-resolved-response', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', (line) => {
        const request = JSON.parse(line);
        const response = JSON.stringify({
          jsonrpc: '2.0', id: request.id,
          result: { protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fixture', version: '1' } }
        });
        process.stdout.write(response + '\\n' + response + '\\n');
      });
    `],
    ['oversized-stdout', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', () => process.stdout.write('x'.repeat(4096)));
    `],
    ['oversized-stderr', `
      import { createInterface } from 'node:readline';
      createInterface({ input: process.stdin }).once('line', () => process.stderr.write('private-secret '.repeat(512)));
    `]
  ];
  for (const [name, source] of cases) {
    const entryPath = await writeMcpFixture(directory, name, source);
    const error = await captureRejection(() => withMcpSession({
      file: path.join(directory, `${name}.json`),
      storage: 'json',
      compact: true,
      entryPath,
      timeoutMs: 500,
      maxBytes: 1024
    }, async () => null));
    assert.equal(error.adapterCause, 'CONTRACT_FAILURE', name);
    assert.equal(error.message.includes('private-secret'), false, name);
    assert.equal(error.message.includes(entryPath), false, name);
  }
});

test('host rejects trailing unterminated output after all responses have resolved', async (t) => {
  const { COMPACT_TOOL_NAMES, withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-trailing-output-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entryPath = await writeMcpFixture(directory, 'trailing-after-close', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `send(request.id, { content: [{ type: 'text', text: '{}' }] });`,
    '',
    `input.on('close', () => process.stdout.write('unterminated-private-output', () => process.exit(0)));`
  ));
  const error = await captureRejection(() => withMcpSession({
    file: path.join(directory, 'unused.json'),
    storage: 'json',
    compact: true,
    entryPath,
    timeoutMs: 2_000
  }, async ({ tools }) => tools.length));
  assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
  assert.equal(error.message.includes('private'), false);
});

test('host accepts only the exact JSON-RPC error object shape and keeps server detail private', async (t) => {
  const { withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-exact-error-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entryPath = await writeMcpFixture(directory, 'exact-error', `
    import { createInterface } from 'node:readline';
    createInterface({ input: process.stdin }).once('line', (line) => {
      const request = JSON.parse(line);
      process.stdout.write(JSON.stringify({
        jsonrpc: '2.0', id: request.id,
        error: { code: -32000, message: 'private-message', data: { detail: 'private-detail' } }
      }) + '\\n');
    });
  `);
  const error = await captureRejection(() => withMcpSession({
    file: path.join(directory, 'unused.json'),
    storage: 'json',
    compact: true,
    entryPath,
    timeoutMs: 500
  }, async () => null));
  assert.equal(error.adapterCause, 'OPERATION_FAILED');
  assert.equal(error.message.includes('private'), false);
});

test('host rejects a non-zero child exit after an otherwise valid exchange', async (t) => {
  const { COMPACT_TOOL_NAMES, withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-exit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entryPath = await writeMcpFixture(directory, 'nonzero-close', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `send(request.id, { content: [{ type: 'text', text: '{}' }] });`,
    '',
    `input.on('close', () => process.exit(9));`
  ));
  const error = await captureRejection(() => withMcpSession({
    file: path.join(directory, 'unused.json'),
    storage: 'json',
    compact: true,
    entryPath,
    timeoutMs: 2_000
  }, async ({ tools }) => tools.length));
  assert.equal(error.adapterCause, 'INFRASTRUCTURE_FAILURE');
});

test('host enforces one monotonic operation deadline and a non-configurable output ceiling', async (t) => {
  const {
    COMPACT_TOOL_NAMES,
    MAX_NDJSON_BYTES,
    withMcpSession
  } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-deadline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entryPath = await writeMcpFixture(directory, 'slow-each-step', `
    import { createInterface } from 'node:readline';
    const tools = ${JSON.stringify(COMPACT_TOOL_NAMES)}.map((name) => ({ name }));
    const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\\n');
    createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      if (request.method === 'initialize') setTimeout(() => send(request.id, { protocolVersion: '2024-11-05' }), 60);
      else if (request.method === 'tools/list') setTimeout(() => send(request.id, { tools }), 60);
      else if (request.method === 'tools/call') setTimeout(() => send(request.id, { content: [{ type: 'text', text: '{}' }] }), 60);
    });
  `);
  const deadlineError = await captureRejection(() => withMcpSession({
    file: path.join(directory, 'deadline.json'),
    storage: 'json',
    compact: true,
    entryPath,
    timeoutMs: 100
  }, (client) => client.callTool('shadowgraph_search', {})));
  assert.equal(deadlineError.adapterCause, 'TIMEOUT');

  const ceilingError = await captureRejection(() => withMcpSession({
    file: path.join(directory, 'ceiling.json'),
    storage: 'json',
    compact: true,
    entryPath,
    timeoutMs: 2_000,
    maxBytes: MAX_NDJSON_BYTES + 1
  }, async () => null));
  assert.equal(ceilingError.adapterCause, 'CONTRACT_FAILURE');
});

test('host hard timeout bounds normal close, termination grace, and kill wait under one deadline', async (t) => {
  const { COMPACT_TOOL_NAMES, withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-lifecycle-deadline-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entryPath = await writeMcpFixture(directory, 'nonclosing-child', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `send(request.id, { content: [{ type: 'text', text: '{}' }] });`,
    `
      process.on('SIGTERM', () => {});
      setInterval(() => {}, 1_000);
    `
  ));
  const started = performance.now();
  const error = await captureRejection(() => withMcpSession({
    file: path.join(directory, 'unused.json'),
    storage: 'json',
    compact: true,
    entryPath,
    timeoutMs: 50
  }, async ({ tools }) => tools.length));
  const elapsedMs = performance.now() - started;
  assert.equal(error.adapterCause, 'TIMEOUT');
  assert.ok(elapsedMs >= 25, `operation returned suspiciously early in ${elapsedMs}ms`);
  assert.ok(elapsedMs < 500, `operation exceeded its 50ms deadline materially: ${elapsedMs}ms`);
});

for (const mode of ['timeout', 'abort']) {
  test(`host ${mode} terminates, kills, and reaps a noncooperative child`, async (t) => {
    const { COMPACT_TOOL_NAMES, withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
    const directory = await mkdtemp(path.join(os.tmpdir(), `shadowgraph-v11-${mode}-`));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const pidFile = path.join(directory, 'child.pid');
    const entryPath = await writeMcpFixture(directory, mode, mode === 'timeout'
      ? `
        import { writeFileSync } from 'node:fs';
        import { createInterface } from 'node:readline';
        writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        process.on('SIGTERM', () => {});
        createInterface({ input: process.stdin }).on('line', () => {});
      `
      : fixtureServerSource(
          COMPACT_TOOL_NAMES,
          '/* deliberately never respond */',
          `
            import { writeFileSync } from 'node:fs';
            writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
            process.on('SIGTERM', () => {});
          `
        ));
    const controller = new AbortController();
    if (mode === 'abort') setTimeout(() => controller.abort(), 50);
    const error = await captureRejection(() => withMcpSession({
      file: path.join(directory, 'unused.json'),
      storage: 'json',
      compact: true,
      entryPath,
      timeoutMs: mode === 'timeout' ? 50 : 5_000,
      signal: controller.signal
    }, async (client) => client.callTool('shadowgraph_search', {})));
    assert.equal(error.adapterCause, mode === 'timeout' ? 'TIMEOUT' : 'OPERATOR_INTERRUPTION');
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  });
}

test('host child environment is a strict allowlist and excludes ambient credentials and feature controls', async (t) => {
  const { COMPACT_TOOL_NAMES, withMcpSession } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-env-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const entryPath = await writeMcpFixture(directory, 'environment', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `send(request.id, { content: [{ type: 'text', text: JSON.stringify(Object.keys(process.env).sort()) }] });`
  ));
  const forbidden = {
    OPENAI_API_KEY: 'ambient-credential',
    SHADOWGRAPH_EMBEDDING_URL: 'https://example.invalid',
    SHADOWGRAPH_VERIFIER_CONFIG: '/private/verifier.json',
    SHADOWGRAPH_TELEMETRY_ENDPOINT: 'https://telemetry.invalid',
    SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'after-write',
    NODE_ENV: 'test'
  };
  const previous = Object.fromEntries(Object.keys(forbidden).map((key) => [key, process.env[key]]));
  Object.assign(process.env, forbidden);
  try {
    const childKeys = await withMcpSession({
      file: path.join(directory, 'unused.json'),
      storage: 'json',
      compact: true,
      entryPath,
      timeoutMs: 2_000,
      environment: forbidden
    }, (client) => client.callTool('shadowgraph_search', {}));
    for (const key of Object.keys(forbidden)) assert.equal(childKeys.includes(key), false, key);
    assert.equal(childKeys.includes('SHADOWGRAPH_FILE'), true);
    assert.equal(childKeys.includes('SHADOWGRAPH_STORAGE'), true);
    assert.equal(childKeys.includes('SHADOWGRAPH_MCP_COMPACT'), true);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('nested endpoint failures retain only the endpoint-unavailable classification', async () => {
  const { classifyHostError } = await import('../benchmark/lib/node-adapter-host.mjs');
  const nested = Object.assign(new Error('outer private diagnostic', {
    cause: Object.assign(new Error('connect ECONNREFUSED with private endpoint'), { code: 'ECONNREFUSED' })
  }), { code: 'WRAPPER_FAILURE' });
  const classified = classifyHostError(nested);
  assert.equal(classified.adapterCause, 'ENDPOINT_UNAVAILABLE');
  assert.equal(classified.message, 'Adapter endpoint is unavailable');
  assert.equal(classified.message.includes('private'), false);
});

test('ambiguous persist is attempted once, poisons only control state, and is never rerun', async (t) => {
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const { COMPACT_TOOL_NAMES, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-poison-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const callsFile = path.join(directory, 'persist-calls.txt');
  const entryPath = await writeMcpFixture(directory, 'ambiguous-persist', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `
      if (request.params.name === 'shadowgraph_record_decision') {
        appendFileSync(${JSON.stringify(callsFile)}, 'persist\\n');
        process.exit(7);
      }
    `,
    `import { appendFileSync } from 'node:fs';`
  ));
  const adapter = createShadowGraphAdapter({
    stateRoot,
    backend: 'json',
    mode: 'compact',
    entryPath,
    mcpEntry: entryPath,
    timeoutMs: 2_000
  });
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
  const persist = requestFor('persist', {
    armId: 'shadowgraph-compact',
    phase: 'A',
    record: { id: 'ambiguous-record', type: 'decision', content: decisionContent() }
  });
  const first = await adapter.execute(persist, {});
  assert.equal(first.status, 'FAILED');
  assert.equal(first.failure.cause, 'INFRASTRUCTURE_FAILURE');
  assert.equal(first.failure.message.includes('private'), false);
  const second = await adapter.execute(persist, {});
  assert.equal(second.status, 'FAILED');
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 1);
  const paths = await statePaths({ stateRoot, backend: 'json', request: reset });
  assert.deepEqual(await readdir(paths.leaf), []);
  assert.equal((await lstat(paths.poison)).isFile(), true);
  assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
  await assert.rejects(lstat(paths.poison), { code: 'ENOENT' });
});

test('poison control directory cannot be redirected through a parent symlink', async (t) => {
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const { statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-poison-symlink-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const adapter = createShadowGraphAdapter({ stateRoot, backend: 'json', mode: 'full' });
  const reset = requestFor('reset', { armId: 'shadowgraph-full', phase: 'SETUP' });
  assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
  const paths = await statePaths({ stateRoot, backend: 'json', request: reset });
  const poisonDirectory = path.dirname(paths.poison);
  await rm(poisonDirectory, { recursive: true, force: true });
  const outside = path.join(directory, 'outside-owned-root');
  await mkdir(outside);
  const outsideMarker = path.join(outside, path.basename(paths.poison));
  await writeFile(outsideMarker, 'outside sentinel\n', 'utf8');
  await writeFile(path.join(outside, 'unrelated-sentinel'), 'must remain\n', 'utf8');
  await symlink(outside, poisonDirectory, 'dir');

  const response = await adapter.execute(reset, {});
  assert.equal(response.status, 'FAILED');
  assert.equal(response.failure.cause, 'CONTRACT_FAILURE');
  assert.equal(await readFile(outsideMarker, 'utf8'), 'outside sentinel\n');
  assert.equal(await readFile(path.join(outside, 'unrelated-sentinel'), 'utf8'), 'must remain\n');
  assert.equal((await lstat(poisonDirectory)).isSymbolicLink(), true);
});

test('successful persist response followed by nonzero exit poisons and blocks duplicate commit until reset', async (t) => {
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const { COMPACT_TOOL_NAMES, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-post-response-exit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const callsFile = path.join(directory, 'persist-calls.txt');
  const entryPath = await writeMcpFixture(directory, 'post-response-exit', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `
      if (request.params.name === 'shadowgraph_record_decision') {
        appendFileSync(${JSON.stringify(callsFile)}, 'persist\\n');
        const result = { content: [{ type: 'text', text: JSON.stringify({
          id: request.params.arguments.id,
          kind: 'decision'
        }) }] };
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n', () => process.exit(9));
      }
    `,
    `import { appendFileSync } from 'node:fs';`
  ));
  const adapter = createShadowGraphAdapter({
    stateRoot,
    backend: 'json',
    mode: 'compact',
    mcpEntry: entryPath,
    timeoutMs: 2_000
  });
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
  const persist = requestFor('persist', {
    armId: 'shadowgraph-compact',
    phase: 'A',
    record: { id: 'post-response-record', type: 'decision', content: decisionContent() }
  });

  const first = await adapter.execute(persist, {});
  assert.equal(first.status, 'FAILED');
  assert.equal(first.failure.cause, 'INFRASTRUCTURE_FAILURE');
  const second = await adapter.execute(persist, {});
  assert.equal(second.status, 'FAILED');
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 1);
  const paths = await statePaths({ stateRoot, backend: 'json', request: reset });
  assert.equal((await lstat(paths.poison)).isFile(), true);
  assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
  await assert.rejects(lstat(paths.poison), { code: 'ENOENT' });
});

test('a malformed persist result is ambiguous and poisons the leaf without retry', async (t) => {
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const { COMPACT_TOOL_NAMES, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-malformed-persist-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const callsFile = path.join(directory, 'persist-calls.txt');
  const entryPath = await writeMcpFixture(directory, 'malformed-persist', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `
      if (request.params.name === 'shadowgraph_record_decision') {
        appendFileSync(${JSON.stringify(callsFile)}, 'persist\\n');
        send(request.id, { content: [{ type: 'text', text: '{malformed' }] });
      }
    `,
    `import { appendFileSync } from 'node:fs';`
  ));
  const adapter = createShadowGraphAdapter({
    stateRoot,
    backend: 'json',
    mode: 'compact',
    mcpEntry: entryPath,
    timeoutMs: 2_000
  });
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  await adapter.execute(reset, {});
  const persist = requestFor('persist', {
    armId: 'shadowgraph-compact',
    phase: 'A',
    record: { id: 'malformed-result-record', type: 'decision', content: decisionContent() }
  });
  const first = await adapter.execute(persist, {});
  const second = await adapter.execute(persist, {});
  assert.equal(first.status, 'FAILED');
  assert.equal(first.failure.cause, 'CONTRACT_FAILURE');
  assert.equal(second.status, 'FAILED');
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 1);
  const paths = await statePaths({ stateRoot, backend: 'json', request: reset });
  assert.equal((await lstat(paths.poison)).isFile(), true);
});

function fallbackPoisonPath(paths) {
  return path.join(paths.root, `.shadowgraph-benchmark-poison-v1-${paths.digest}`);
}

test('default durability resets JSON state and publishes a poison marker on the host filesystem', async (t) => {
  const { poisonStateLeaf, requireStateLeaf, resetStateLeaf } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-default-durability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  let paths;
  try {
    paths = await resetStateLeaf({ stateRoot, backend: 'json', request: reset });
    await poisonStateLeaf(paths);
  } catch (error) {
    assert.notEqual(error?.code, 'EPERM', 'default directory fsync must be supported on this host');
    throw error;
  }

  const marker = await lstat(paths.poison);
  assert.equal(marker.isFile(), true);
  assert.equal(marker.isSymbolicLink(), false);
  await assert.rejects(
    requireStateLeaf({ stateRoot, backend: 'json', request: reset }),
    (error) => error.adapterCause === 'INFRASTRUCTURE_FAILURE'
  );
  await resetStateLeaf({ stateRoot, backend: 'json', request: reset });
  await assert.rejects(lstat(paths.poison), { code: 'ENOENT' });
});

function durabilityProbe({ beforeDirectorySync = async () => {}, failDirectorySync = () => false } = {}) {
  const events = [];
  return {
    events,
    operations: {
      async openFile(file, flags, mode) {
        events.push(`open:${file}`);
        const handle = await open(file, flags, mode);
        return {
          async writeFile(...args) {
            events.push(`write:${file}`);
            return handle.writeFile(...args);
          },
          async sync() {
            events.push(`file-sync:${file}`);
            return handle.sync();
          },
          async close() {
            events.push(`close:${file}`);
            return handle.close();
          }
        };
      },
      async syncDirectory(directory) {
        events.push(`directory-sync:${directory}`);
        await beforeDirectorySync(directory);
        if (failDirectorySync(directory)) {
          const error = new Error('Injected directory sync failure');
          error.code = 'EIO';
          throw error;
        }
        const handle = await open(directory, process.platform === 'win32' ? 'r+' : 'r');
        try {
          await handle.sync();
        } finally {
          await handle.close();
        }
      }
    }
  };
}

test('poison directory and primary marker are durably published in crash-safe order', async (t) => {
  const { poisonStateLeaf, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-poison-durability-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  let poisonDirectoryExistedAtRootSync = false;
  const probe = durabilityProbe({
    async beforeDirectorySync(candidate) {
      if (candidate === stateRoot) {
        poisonDirectoryExistedAtRootSync = (await lstat(path.join(candidate, '.poison'))).isDirectory();
      }
    }
  });
  const paths = await statePaths({
    stateRoot,
    backend: 'json',
    request: reset,
    durability: probe.operations
  });

  assert.deepEqual(probe.events, [`directory-sync:${paths.root}`]);
  assert.equal(poisonDirectoryExistedAtRootSync, true);
  probe.events.length = 0;
  await poisonStateLeaf(paths);
  assert.deepEqual(probe.events, [
    `directory-sync:${paths.root}`,
    `open:${paths.poison}`,
    `write:${paths.poison}`,
    `file-sync:${paths.poison}`,
    `close:${paths.poison}`,
    `directory-sync:${paths.poisonDirectory}`,
    `directory-sync:${paths.root}`
  ]);
});

test('primary marker directory-sync failure falls back to a root-synced marker', async (t) => {
  const { poisonStateLeaf, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-poison-sync-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  await statePaths({ stateRoot, backend: 'json', request: reset });
  const probe = durabilityProbe({
    failDirectorySync: (candidate) => path.basename(candidate) === '.poison'
  });
  const paths = await statePaths({
    stateRoot,
    backend: 'json',
    request: reset,
    durability: probe.operations
  });

  assert.deepEqual(probe.events, [`directory-sync:${paths.root}`]);
  probe.events.length = 0;
  await poisonStateLeaf(paths);
  assert.deepEqual(probe.events, [
    `directory-sync:${paths.root}`,
    `open:${paths.poison}`,
    `write:${paths.poison}`,
    `file-sync:${paths.poison}`,
    `close:${paths.poison}`,
    `directory-sync:${paths.poisonDirectory}`,
    `open:${paths.fallbackPoison}`,
    `write:${paths.fallbackPoison}`,
    `file-sync:${paths.fallbackPoison}`,
    `close:${paths.fallbackPoison}`,
    `directory-sync:${paths.root}`
  ]);
  assert.equal((await lstat(paths.fallbackPoison)).isFile(), true);
});

test('directory-sync failure for both markers propagates while the in-memory latch stays fail-closed', async (t) => {
  const { poisonStateLeaf, requireStateLeaf, resetStateLeaf, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-poison-sync-latch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  await resetStateLeaf({ stateRoot, backend: 'json', request: reset });
  let failSync = false;
  let probe;
  probe = durabilityProbe({
    failDirectorySync(candidate) {
      if (!failSync) return false;
      if (path.basename(candidate) === '.poison') return true;
      return probe.events.filter((event) => event === `directory-sync:${candidate}`).length > 1;
    }
  });
  const paths = await statePaths({
    stateRoot,
    backend: 'json',
    request: reset,
    durability: probe.operations
  });

  assert.deepEqual(probe.events, [`directory-sync:${paths.root}`]);
  probe.events.length = 0;
  failSync = true;
  await assert.rejects(
    poisonStateLeaf(paths),
    (error) => error.adapterCause === 'INFRASTRUCTURE_FAILURE' && error.ambiguous === true
  );
  assert.deepEqual(probe.events, [
    `directory-sync:${paths.root}`,
    `open:${paths.poison}`,
    `write:${paths.poison}`,
    `file-sync:${paths.poison}`,
    `close:${paths.poison}`,
    `directory-sync:${paths.poisonDirectory}`,
    `open:${paths.fallbackPoison}`,
    `write:${paths.fallbackPoison}`,
    `file-sync:${paths.fallbackPoison}`,
    `close:${paths.fallbackPoison}`,
    `directory-sync:${paths.root}`
  ]);
  await unlink(paths.poison);
  await unlink(paths.fallbackPoison);
  await assert.rejects(
    requireStateLeaf({ stateRoot, backend: 'json', request: reset }),
    (error) => error.adapterCause === 'INFRASTRUCTURE_FAILURE'
  );
});

test('a failed primary poison write preserves the original failure and durable fallback blocks a restarted adapter', async (t) => {
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const { COMPACT_TOOL_NAMES, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-poison-fallback-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const callsFile = path.join(directory, 'persist-calls.txt');
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  const resetAdapter = createShadowGraphAdapter({ stateRoot, backend: 'json', mode: 'compact' });
  assert.equal((await resetAdapter.execute(reset, {})).status, 'SUCCEEDED');
  const paths = await statePaths({ stateRoot, backend: 'json', request: reset });
  const fallback = fallbackPoisonPath(paths);
  const entryPath = await writeMcpFixture(directory, 'fallback-ambiguous-persist', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `
      if (request.params.name === 'shadowgraph_record_decision') {
        appendFileSync(${JSON.stringify(callsFile)}, 'persist\\n');
        mkdirSync(${JSON.stringify(paths.poison)});
        process.exit(7);
      }
    `,
    `import { appendFileSync, mkdirSync } from 'node:fs';`
  ));
  const options = {
    stateRoot,
    backend: 'json',
    mode: 'compact',
    mcpEntry: entryPath,
    timeoutMs: 2_000
  };
  const adapter = createShadowGraphAdapter(options);
  const persist = requestFor('persist', {
    armId: 'shadowgraph-compact',
    phase: 'A',
    record: { id: 'fallback-poison-record', type: 'decision', content: decisionContent() }
  });

  const first = await adapter.execute(persist, {});
  assert.equal(first.status, 'FAILED');
  assert.equal(first.failure.cause, 'INFRASTRUCTURE_FAILURE');
  const fallbackState = await lstat(fallback);
  assert.equal(fallbackState.isFile(), true);
  assert.equal(fallbackState.isSymbolicLink(), false);
  assert.equal(fallbackState.nlink, 1);
  assert.equal(path.dirname(fallback), paths.root);
  await rm(paths.poison, { recursive: true, force: true });

  const restartedAdapter = createShadowGraphAdapter(options);
  const second = await restartedAdapter.execute(persist, {});
  assert.equal(second.status, 'FAILED');
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 1);
  assert.equal((await lstat(fallback)).isFile(), true);
  assert.equal((await restartedAdapter.execute(reset, {})).status, 'SUCCEEDED');
  await assert.rejects(lstat(fallback), { code: 'ENOENT' });
});

test('an in-memory poison latch blocks reuse when both durable marker writes fail and survives a failed reset', async (t) => {
  const { createShadowGraphAdapter } = await import('../benchmark/adapters/shadowgraph.mjs');
  const { COMPACT_TOOL_NAMES, statePaths } = await import('../benchmark/lib/node-adapter-host.mjs');
  const directory = await mkdtemp(path.join(os.tmpdir(), 'shadowgraph-v11-poison-latch-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateRoot = path.join(directory, 'owned-state');
  const callsFile = path.join(directory, 'persist-calls.txt');
  const reset = requestFor('reset', { armId: 'shadowgraph-compact', phase: 'SETUP' });
  const resetAdapter = createShadowGraphAdapter({ stateRoot, backend: 'json', mode: 'compact' });
  assert.equal((await resetAdapter.execute(reset, {})).status, 'SUCCEEDED');
  const paths = await statePaths({ stateRoot, backend: 'json', request: reset });
  const fallback = fallbackPoisonPath(paths);
  const entryPath = await writeMcpFixture(directory, 'latched-ambiguous-persist', fixtureServerSource(
    COMPACT_TOOL_NAMES,
    `
      if (request.params.name === 'shadowgraph_record_decision') {
        appendFileSync(${JSON.stringify(callsFile)}, 'persist\\n');
        mkdirSync(${JSON.stringify(paths.poison)});
        mkdirSync(${JSON.stringify(fallback)});
        process.exit(7);
      }
    `,
    `import { appendFileSync, mkdirSync } from 'node:fs';`
  ));
  const adapter = createShadowGraphAdapter({
    stateRoot,
    backend: 'json',
    mode: 'compact',
    mcpEntry: entryPath,
    timeoutMs: 2_000
  });
  const persist = requestFor('persist', {
    armId: 'shadowgraph-compact',
    phase: 'A',
    record: { id: 'memory-latch-record', type: 'decision', content: decisionContent() }
  });

  const first = await adapter.execute(persist, {});
  assert.equal(first.status, 'FAILED');
  assert.equal(first.failure.cause, 'INFRASTRUCTURE_FAILURE');
  const failedReset = await adapter.execute(reset, {});
  assert.equal(failedReset.status, 'FAILED');
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 1);

  await rm(paths.poison, { recursive: true, force: true });
  await rm(fallback, { recursive: true, force: true });
  await mkdir(paths.leaf);
  const blockedAfterFailedReset = await adapter.execute(persist, {});
  assert.equal(blockedAfterFailedReset.status, 'FAILED');
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 1);

  assert.equal((await adapter.execute(reset, {})).status, 'SUCCEEDED');
  const afterSuccessfulReset = await adapter.execute(persist, {});
  assert.equal(afterSuccessfulReset.status, 'FAILED');
  assert.equal((await readFile(callsFile, 'utf8')).trim().split('\n').length, 2);
});
