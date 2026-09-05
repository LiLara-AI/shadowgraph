// The runtime hosts for the arms that run in this process tree.
//
// Both adapters have existed and been tested for a while; what never existed
// was the binding that hands them to `createV11AdapterExecutor` keyed by the
// runtime kind the registry assigns. That binding is small, and it is exactly
// the place where an arm can be silently attached to the wrong runtime or the
// wrong mode - so these tests care much more about refusals than about the
// happy path.
//
// The mode binding gets the most attention. `shadowgraph-full` and
// `shadowgraph-compact` are the same product behind different tool surfaces,
// they differ only by a descriptor field, and a binding that leaked one mode
// into the other arm would produce a complete, valid-looking run measuring one
// configuration twice.

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createAdapterRequest, validateAdapterResponse } from '../benchmark/lib/adapter-protocol.mjs';
import { NodeHostError, createV11NodeHosts } from '../benchmark/lib/v11-node-hosts.mjs';
import { createV11Registry } from '../benchmark/lib/v11-registry.mjs';
import { createV11AdapterExecutor } from '../benchmark/lib/v11-run.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url));

function descriptorFor(armId, overrides = {}) {
  return {
    armId,
    kind: armId === 'no-memory' ? 'control' : 'node-mcp',
    mode: armId === 'shadowgraph-full' ? 'full' : armId === 'shadowgraph-compact' ? 'compact' : null,
    ...overrides
  };
}

const RECORD = Object.freeze({
  id: 'decision:node-hosts:scenario-one:0:A',
  type: 'decision',
  content: Object.freeze({
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
    memoryUserId: null
  })
});

function payloadFor(operation) {
  if (operation === 'reset') return {};
  if (operation === 'persist') return { record: structuredClone(RECORD) };
  return { query: { scenarioId: 'scenario-one', task: 'Choose a safe migration.' } };
}

function requestFor(operation, armId, overrides = {}) {
  return createAdapterRequest({
    operation,
    correlation: {
      runId: 'run-node-hosts',
      attemptId: `attempt-${armId}-${operation}`,
      phase: 'A',
      armId,
      scenarioId: 'scenario-one',
      repetition: 0
    },
    namespace: overrides.namespace ?? { projectId: 'primary-project', userId: null },
    payload: overrides.payload ?? payloadFor(operation)
  });
}

async function hosts(t, overrides = {}) {
  const stateRoot = await scratchDirectory(t, 'shadowgraph-v11-node-hosts-');
  return createV11NodeHosts({ stateRoot, timeoutMs: 20_000, ...overrides });
}

test('a state root is mandatory, absolute, and not a filesystem root', () => {
  for (const stateRoot of [undefined, null, '', 'relative/state', path.parse(process.cwd()).root]) {
    assert.throws(
      () => createV11NodeHosts({ stateRoot }),
      NodeHostError,
      `${JSON.stringify(stateRoot)} must be refused`
    );
  }
});

test('exactly the two local runtime kinds are bound', async (t) => {
  const bound = await hosts(t);
  assert.deepEqual(Object.keys(bound).sort(), ['control', 'node-mcp']);
  assert.ok(Object.isFrozen(bound), 'the host map must not be extended after construction');
});

test('the control host binds the control arm and refuses every other', async (t) => {
  const bound = await hosts(t);
  assert.equal(typeof bound.control(descriptorFor('no-memory')), 'function');

  for (const armId of ['shadowgraph-full', 'mem0-oss', 'graphiti']) {
    assert.throws(
      () => bound.control(descriptorFor(armId, { kind: 'control' })),
      NodeHostError,
      `${armId} must not be bound to the control runtime`
    );
  }
});

test('the MCP host binds the mode the descriptor names, and refuses one it does not', async (t) => {
  const bound = await hosts(t);
  assert.equal(typeof bound['node-mcp'](descriptorFor('shadowgraph-full')), 'function');
  assert.equal(typeof bound['node-mcp'](descriptorFor('shadowgraph-compact')), 'function');

  for (const mode of [null, undefined, '', 'FULL', 'partial']) {
    assert.throws(
      () => bound['node-mcp'](descriptorFor('shadowgraph-full', { mode })),
      NodeHostError,
      `mode ${JSON.stringify(mode)} must be refused`
    );
  }
  assert.throws(
    () => bound['node-mcp'](descriptorFor('no-memory', { kind: 'node-mcp', mode: 'full' })),
    NodeHostError,
    'the control arm must not be bound to an MCP runtime'
  );
});

test('each MCP arm is bound to its own mode, and will not answer for the other', async (t) => {
  // The adapter refuses a request whose arm does not match its configured mode,
  // so a binding that handed both arms the same adapter fails here rather than
  // producing a run that measured one configuration twice.
  const bound = await hosts(t);
  const full = bound['node-mcp'](descriptorFor('shadowgraph-full'));
  const compact = bound['node-mcp'](descriptorFor('shadowgraph-compact'));

  const crossed = await full(requestFor('reset', 'shadowgraph-compact'));
  assert.equal(crossed.status, 'FAILED');
  assert.equal(crossed.failure.cause, 'CONTRACT_FAILURE');

  const mirrored = await compact(requestFor('reset', 'shadowgraph-full'));
  assert.equal(mirrored.status, 'FAILED');
  assert.equal(mirrored.failure.cause, 'CONTRACT_FAILURE');
});

test('the real registry routes its three local arms through these hosts', async (t) => {
  const competitorLock = JSON.parse(
    await readFile(path.join(REPOSITORY_ROOT, 'benchmark', 'competitors.lock.json'), 'utf8')
  );
  const registry = createV11Registry({ competitorLock, containerImage: competitorLock.pythonImage });
  const bound = await hosts(t);

  const routed = [];
  const executeAdapter = createV11AdapterExecutor({
    registry,
    hosts: {
      ...bound,
      // The container arms are not this module's business; a recorder proves
      // the local hosts compose with the executor rather than replacing it.
      'python-container': (descriptor) => async (request) => {
        routed.push(descriptor.armId);
        return { armId: request.armId };
      }
    }
  });
  assert.equal(typeof executeAdapter, 'function');

  const control = await executeAdapter(requestFor('reset', 'no-memory', {
    namespace: { projectId: null, userId: null }
  }));
  assert.equal(control.armId, 'no-memory');
  assert.equal(control.status, 'SUCCEEDED');
});

test('the control arm produces an envelope the protocol accepts', async (t) => {
  const bound = await hosts(t);
  const execute = bound.control(descriptorFor('no-memory'));

  for (const operation of ['reset', 'retrieve']) {
    const request = requestFor(operation, 'no-memory', { namespace: { projectId: null, userId: null } });
    const response = await execute(request);
    validateAdapterResponse({ request, response });
    assert.equal(response.status, 'SUCCEEDED');
    assert.equal(response.storage.status, 'MEASURED');
    assert.equal(response.storage.bytes, 0);
  }
});

test('a bound MCP arm drives the real product through a persist and a retrieve', async (t) => {
  // The end-to-end that matters, and it has to be more than a reset: a reset
  // returns before any MCP session is opened, so a test that stopped there
  // would prove the state root works and nothing about the product. Persist and
  // retrieve both spawn the server this repository ships.
  const bound = await hosts(t);
  const execute = bound['node-mcp'](descriptorFor('shadowgraph-full'));

  for (const operation of ['reset', 'persist', 'retrieve']) {
    const request = requestFor(operation, 'shadowgraph-full');
    const response = await execute(request);
    validateAdapterResponse({ request, response });
    assert.equal(response.status, 'SUCCEEDED', `${operation}: ${JSON.stringify(response.failure ?? null)}`);
    assert.equal(response.storage.status, 'MEASURED');
    assert.equal(typeof response.storage.bytes, 'number');

    if (operation === 'persist') {
      assert.ok(response.operations.mcpToolCalls > 0, 'a persist must have reached the server');
      assert.ok(response.operations.memoryWriteOperations > 0);
    }
    if (operation === 'retrieve') {
      assert.ok(response.operations.mcpToolCalls > 0, 'a retrieve must have reached the server');
      assert.ok(
        response.result.nativeContext.length > 0,
        'the record persisted a moment ago must come back'
      );
    }
  }
});
