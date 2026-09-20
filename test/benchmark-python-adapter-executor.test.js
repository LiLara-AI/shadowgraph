import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createAdapterRequest } from '../benchmark/lib/adapter-protocol.mjs';
import {
  PYTHON_ADAPTER_SPECS,
  PythonAdapterExecutorError,
  createPythonAdapterExecutor
} from '../benchmark/lib/python-adapter-executor.mjs';
import { providerModelsFor } from '../benchmark/lib/v11-provider-models.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

// The real lock, not a fixture. What crosses this protocol has to be the
// model the benchmark actually pins, and a test that invented its own ids
// would keep passing if the wiring quietly stopped reading the lock.
const MODEL_WEIGHTS = JSON.parse(readFileSync(
  new URL('../benchmark/model-weights.lock.json', import.meta.url),
  'utf8'
));

function decisionContent() {
  return {
    choiceId: 'choice-python-1',
    recalledAlternativeIds: [],
    recalledRejectionReasonIds: [],
    constraintIdsAddressed: [],
    evidenceIdsCited: [],
    riskIdsRecognized: [],
    reviewTriggerIds: [],
    recommendation: 'Use the bounded option.',
    failedAttemptIdsAvoided: [],
    failedAttemptReasonIdsCited: [],
    memoryProjectId: 'project-python-1',
    memoryUserId: 'user-python-1'
  };
}

function requestFor(operation = 'retrieve', overrides = {}) {
  const correlation = {
    runId: overrides.runId ?? 'run-python-1',
    attemptId: overrides.attemptId ?? `attempt-${operation}`,
    phase: overrides.phase ?? 'A',
    armId: overrides.armId ?? 'mem0-oss',
    scenarioId: overrides.scenarioId ?? 'scenario-python-1',
    repetition: overrides.repetition ?? 0
  };
  const namespace = overrides.namespace ?? { projectId: 'project-python-1', userId: 'user-python-1' };
  const payload = operation === 'reset'
    ? {}
    : operation === 'persist'
      ? {
          record: {
            id: 'decision-python-1',
            type: 'decision',
            content: decisionContent()
          }
        }
      : { query: { scenarioId: correlation.scenarioId, task: 'Choose a safe migration.' } };
  return createAdapterRequest({ operation, correlation, namespace, payload });
}

function successHostSource({ adapterId = 'mem0-oss', mutate = '', assertions = '' } = {}) {
  return String.raw`import json
import os
import sys

raw = sys.stdin.buffer.read()
wrapper = json.loads(raw.decode("utf-8"))
assert set(wrapper) == {"schemaVersion", "adapterId", "request", "providerRoutes", "providerModels"}
assert wrapper["schemaVersion"] == 2
assert wrapper["adapterId"] == ${JSON.stringify(adapterId)}
${assertions}
request = wrapper["request"]
response = {
    "schemaVersion": 1,
    "operation": request["operation"],
    "runId": request["runId"],
    "attemptId": request["attemptId"],
    "phase": request["phase"],
    "armId": request["armId"],
    "scenarioId": request["scenarioId"],
    "repetition": request["repetition"],
    "status": "SUCCEEDED",
    "result": {"nativeContext": [], "persistenceEvidence": None, "isolationEvidence": None},
    "failure": None,
    "operations": {
        "memoryReadOperations": 0,
        "memoryWriteOperations": 0,
        "mcpToolCalls": 0,
        "outerDecisionModelCalls": 0,
        "internalMemoryModelCalls": 0,
        "embeddingCalls": 0,
        "persistenceVerificationOperations": 0,
    },
    "storage": {
        "status": "NOT_AVAILABLE",
        "bytes": None,
        "scope": "Fake Python native scope",
        "method": None,
        "reason": "No exact attributable byte scope",
        "blockedClaims": ["storage bytes"],
    },
}
${mutate}
sys.stdout.write(json.dumps(response, separators=(",", ":")) + "\n")
`;
}

async function makeHost(t, source) {
  const directory = await scratchDirectory(t, 'shadowgraph-python-executor-test-');
  const hostPath = path.join(directory, 'fake_host.py');
  await writeFile(hostPath, source, { encoding: 'utf8', mode: 0o644 });
  await chmod(hostPath, 0o644);
  return { directory, hostPath };
}

function endpointFactory(calls) {
  let sequence = 0;
  return async (requestClass, correlation) => {
    sequence += 1;
    calls.push({ requestClass, correlation: structuredClone(correlation), sequence });
    return `http://127.0.0.1:43100/provider-meter/v1/${String(sequence).padStart(48, 'a')}`;
  };
}

function pinnedModelsFor(armId) {
  return providerModelsFor(MODEL_WEIGHTS, PYTHON_ADAPTER_SPECS[armId].requestClasses);
}

function executorOptions(hostPath, overrides = {}) {
  const armId = overrides.armId ?? 'mem0-oss';
  return {
    adapterId: overrides.adapterId ?? 'mem0-oss',
    armId,
    pythonExecutable: overrides.pythonExecutable ?? 'python3',
    hostPath,
    stateRoot: overrides.stateRoot ?? path.join(path.dirname(hostPath), 'persistent-state'),
    providerEndpointFor: overrides.providerEndpointFor,
    providerModels: 'providerModels' in overrides ? overrides.providerModels : pinnedModelsFor(armId),
    spawnProcess: overrides.spawnProcess,
    container: overrides.container,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    maxRequestBytes: overrides.maxRequestBytes,
    maxOutputBytes: overrides.maxOutputBytes
  };
}

function processGroupTest(name, fn) {
  return test(name, {
    skip: process.platform === 'win32'
      ? 'Python adapter execution requires POSIX process-group isolation'
      : false
  }, fn);
}

test('public adapter specs bind four exact ids, arms, versions, and provider requirements', () => {
  assert.deepEqual(PYTHON_ADAPTER_SPECS, {
    'mem0-oss': {
      armId: 'mem0-oss',
      packages: { mem0ai: '2.0.19' },
      requestClasses: ['internal_memory_llm', 'embedding'],
      dispatchIdentityMode: 'static'
    },
    'basic-memory': {
      armId: 'basic-memory',
      packages: { 'basic-memory': '0.23.2' },
      requestClasses: [],
      dispatchIdentityMode: 'static'
    },
    graphiti: {
      armId: 'graphiti',
      packages: { 'graphiti-core': '0.29.3', httpx: '0.28.1' },
      requestClasses: ['internal_memory_llm', 'embedding'],
      dispatchIdentityMode: 'dynamic'
    },
    cognee: {
      armId: 'cognee',
      packages: { cognee: '1.5.3' },
      requestClasses: ['internal_memory_llm', 'embedding'],
      dispatchIdentityMode: 'dynamic'
    }
  });
});

test('competitor ids are exactly compatible with the frozen preregistration and legacy mem0 is rejected', async () => {
  const preregistration = JSON.parse(await readFile(
    new URL('../benchmark/preregistration.json', import.meta.url),
    'utf8'
  ));
  const frozenCompetitors = preregistration.arms
    .map(({ id }) => id)
    .filter((id) => ['mem0-oss', 'basic-memory', 'graphiti', 'cognee'].includes(id));
  assert.deepEqual(Object.keys(PYTHON_ADAPTER_SPECS), frozenCompetitors);
  assert.equal(Object.hasOwn(PYTHON_ADAPTER_SPECS, 'mem0'), false);
  assert.throws(() => createPythonAdapterExecutor({
    adapterId: 'mem0',
    armId: 'mem0',
    stateRoot: path.resolve('unused-state-root')
  }), PythonAdapterExecutorError);
});

if (process.platform === 'win32') {
  test('executor fails closed when POSIX process-group isolation is unavailable', () => {
    assert.throws(() => createPythonAdapterExecutor(executorOptions(path.resolve('unused-host.py'))), (error) => {
      assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
      assert.match(error.message, /process-group isolation/u);
      return true;
    });
  });
}

processGroupTest('executor validates request, binds exact arm, obtains fresh correlation routes, and validates response', async (t) => {
  const calls = [];
  const { hostPath } = await makeHost(t, successHostSource({
    assertions: String.raw`assert wrapper["providerRoutes"]["internal_memory_llm"].startswith("http://127.")
assert wrapper["providerRoutes"]["embedding"].startswith("http://127.")
assert "SHADOWGRAPH_TEST_AMBIENT_SECRET" not in os.environ
assert "OPENAI_API_KEY" not in os.environ
assert "AWS_SHARED_CREDENTIALS_FILE" not in os.environ
assert "NODE_OPTIONS" not in os.environ
assert os.environ["MEM0_TELEMETRY"] == "false"
assert os.environ["GRAPHITI_TELEMETRY_ENABLED"] == "false"
assert os.environ["TELEMETRY_DISABLED"] == "1"
assert os.environ["BASIC_MEMORY_FORCE_LOCAL"] == "true"
assert os.environ["PYTHONNOUSERSITE"] == "1"
assert os.path.realpath(os.getcwd()) != os.path.realpath(os.environ["HOME"])
assert os.path.realpath(os.environ["HOME"]).startswith(os.path.realpath(os.environ["SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT"]) + os.sep)
assert os.path.realpath(os.environ["XDG_CONFIG_HOME"]).startswith(os.path.realpath(os.environ["SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT"]) + os.sep)
assert os.path.realpath(os.environ["TEMP"]).startswith(os.path.dirname(os.path.realpath(os.getcwd())) + os.sep)`
  }));
  const oldSecret = process.env.SHADOWGRAPH_TEST_AMBIENT_SECRET;
  const oldOpenAi = process.env.OPENAI_API_KEY;
  const oldAwsConfig = process.env.AWS_SHARED_CREDENTIALS_FILE;
  const oldNodeOptions = process.env.NODE_OPTIONS;
  process.env.SHADOWGRAPH_TEST_AMBIENT_SECRET = 'must-not-cross-boundary';
  process.env.OPENAI_API_KEY = 'must-not-cross-boundary';
  process.env.AWS_SHARED_CREDENTIALS_FILE = '/private/credentials';
  process.env.NODE_OPTIONS = '--require=/private/hook.js';
  t.after(() => {
    if (oldSecret === undefined) delete process.env.SHADOWGRAPH_TEST_AMBIENT_SECRET;
    else process.env.SHADOWGRAPH_TEST_AMBIENT_SECRET = oldSecret;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAi;
    if (oldAwsConfig === undefined) delete process.env.AWS_SHARED_CREDENTIALS_FILE;
    else process.env.AWS_SHARED_CREDENTIALS_FILE = oldAwsConfig;
    if (oldNodeOptions === undefined) delete process.env.NODE_OPTIONS;
    else process.env.NODE_OPTIONS = oldNodeOptions;
  });
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory(calls)
  }));
  const firstRequest = requestFor('retrieve');
  const first = await executor.execute(firstRequest);
  const secondRequest = requestFor('retrieve', { attemptId: 'attempt-retrieve-2' });
  const second = await executor.execute(secondRequest);
  assert.equal(first.attemptId, firstRequest.attemptId);
  assert.equal(second.attemptId, secondRequest.attemptId);
  assert.equal(calls.length, 4);
  assert.equal(new Set(calls.map(({ sequence }) => sequence)).size, 4);
  assert.deepEqual(calls.map(({ requestClass }) => requestClass), [
    'internal_memory_llm',
    'embedding',
    'internal_memory_llm',
    'embedding'
  ]);
  for (const call of calls) {
    assert.equal(call.correlation.armId, 'mem0-oss');
    assert.equal(call.correlation.requestClass, call.requestClass);
    assert.equal(call.correlation.rootOperation, 'retrieve');
    assert.equal(Object.hasOwn(call.correlation, 'operation'), false);
  }
  assert.doesNotMatch(JSON.stringify(first), /provider-meter|43100/u);
});

processGroupTest('Cognee planned routes share one root invocation and use dynamic dispatch mode', async (t) => {
  const calls = [];
  const { hostPath } = await makeHost(t, successHostSource({
    adapterId: 'cognee',
    assertions: String.raw`assert wrapper["providerRoutes"]["internal_memory_llm"].startswith("http://127.")
assert wrapper["providerRoutes"]["embedding"].startswith("http://127.")`
  }));
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    adapterId: 'cognee',
    armId: 'cognee',
    providerEndpointFor: async (requestClass, correlation, plan) => {
      calls.push({ requestClass, correlation: structuredClone(correlation), plan: structuredClone(plan) });
      return {
        endpoint: `http://127.0.0.1:43100/provider-meter/v1/${String(calls.length).padStart(48, 'a')}`
      };
    }
  }));
  await executor.execute(requestFor('persist', { armId: 'cognee' }));

  assert.deepEqual(calls.map(({ requestClass }) => requestClass), [
    'internal_memory_llm',
    'embedding'
  ]);
  assert.equal(new Set(calls.map(({ plan }) => plan.rootInvocationId)).size, 1);
  assert.match(calls[0].plan.rootInvocationId, /^[0-9a-f]{8}-[0-9a-f-]{27}$/u);
  assert.deepEqual(calls.map(({ plan }) => plan.identityMode), ['dynamic', 'dynamic']);
  assert.deepEqual(calls.map(({ plan }) => plan.planSlot), [
    'adapter-internal_memory_llm',
    'adapter-embedding'
  ]);
  for (const call of calls) {
    assert.equal(call.correlation.rootOperation, 'persist');
    assert.equal(call.plan.rootOperation, 'persist');
  }
});

processGroupTest('basic-memory launches with both provider routes null and never invokes route callback', async (t) => {
  const request = requestFor('retrieve', {
    armId: 'basic-memory',
    namespace: { projectId: 'project-python-1', userId: null }
  });
  const { hostPath } = await makeHost(t, successHostSource({
    adapterId: 'basic-memory',
    assertions: 'assert wrapper["providerRoutes"] == {"internal_memory_llm": None, "embedding": None}'
  }));
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    adapterId: 'basic-memory',
    armId: 'basic-memory',
    providerEndpointFor: () => { throw new Error('must not be called'); }
  }));
  const response = await executor.execute(request);
  assert.equal(response.armId, 'basic-memory');
});

processGroupTest('wrong arm and invalid requests fail before provider lookup or child spawn', async (t) => {
  const marker = path.join((await makeHost(t, '')).directory, 'spawned');
  const { hostPath } = await makeHost(t, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("spawned")\n`);
  let providerCalls = 0;
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: () => {
      providerCalls += 1;
      return 'http://127.0.0.1:43100/capability';
    }
  }));
  const wrongArm = requestFor('retrieve', {
    armId: 'graphiti',
    namespace: { projectId: 'project-python-1', userId: null }
  });
  await assert.rejects(() => executor.execute(wrongArm), (error) => {
    assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
    return true;
  });
  const invalid = requestFor('retrieve');
  invalid.outerModel = { endpoint: 'https://forbidden.invalid' };
  await assert.rejects(() => executor.execute(invalid), PythonAdapterExecutorError);
  assert.equal(providerCalls, 0);
  await assert.rejects(() => stat(marker), { code: 'ENOENT' });
});

processGroupTest('missing, cloud, credentialed, queried, and reused provider routes fail before spawn', async (t) => {
  const marker = path.join((await makeHost(t, '')).directory, 'spawned');
  const { hostPath } = await makeHost(t, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("spawned")\n`);
  const routes = [
    undefined,
    'https://provider.example/v1',
    'http://localhost:43100/capability',
    'http://user:pass@127.0.0.1:43100/capability',
    'http://127.0.0.1:43100/capability?secret=value'
  ];
  for (const route of routes) {
    const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
      providerEndpointFor: async () => route
    }));
    await assert.rejects(() => executor.execute(requestFor()), (error) => {
      assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
      assert.doesNotMatch(error.message, /provider\.example|user|pass|secret/u);
      return true;
    });
  }
  let endpoint = 'http://127.0.0.1:43100/provider-meter/v1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const reused = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: async () => endpoint
  }));
  await assert.rejects(() => reused.execute(requestFor()), /fresh/u);
  assert.equal((await readFile(marker, 'utf8').catch(() => null)), null);
});

for (const fixture of [
  { name: 'malformed JSON', source: 'import sys\nsys.stdin.buffer.read()\nsys.stdout.write("{bad}\\n")\n' },
  { name: 'unterminated output', source: 'import sys\nsys.stdin.buffer.read()\nsys.stdout.write("{}")\n' },
  {
    name: 'trailing output',
    source: `${successHostSource()}sys.stdout.write("trailing\\n")\n`
  },
  {
    name: 'multiple output records',
    source: `${successHostSource()}sys.stdout.write("{}\\n")\n`
  },
  {
    name: 'extra response field',
    source: successHostSource({ mutate: 'response["usage"] = {"total_tokens": 1}' })
  },
  {
    name: 'wrong correlation',
    source: successHostSource({ mutate: 'response["attemptId"] = "wrong-attempt"' })
  },
  {
    name: 'encoded provider capability',
    source: successHostSource({
      mutate: 'response["result"]["nativeContext"] = [{"encoded": __import__("base64").urlsafe_b64encode(wrapper["providerRoutes"]["embedding"].encode()).decode().rstrip("=")}]'
    })
  }
]) {
  processGroupTest(`executor rejects ${fixture.name} without exposing output`, async (t) => {
    const { hostPath } = await makeHost(t, fixture.source);
    const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
      providerEndpointFor: endpointFactory([])
    }));
    await assert.rejects(() => executor.execute(requestFor()), (error) => {
      assert.equal(error instanceof PythonAdapterExecutorError, true);
      assert.match(error.adapterCause, /CONTRACT_FAILURE|INFRASTRUCTURE_FAILURE/u);
      assert.doesNotMatch(error.message, /bad|trailing|wrong-attempt|total_tokens/u);
      return true;
    });
  });
}

processGroupTest('stderr and nonzero exit are sanitized with no path, body, endpoint, or credential leak', async (t) => {
  const { hostPath } = await makeHost(t, String.raw`import sys
sys.stdin.buffer.read()
sys.stderr.write("Bearer secret-token /private/profile/path http://127.0.0.1:43100/private-route")
raise SystemExit(9)
`);
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([])
  }));
  await assert.rejects(() => executor.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'INFRASTRUCTURE_FAILURE');
    assert.doesNotMatch(
      `${error.message} ${JSON.stringify(error)}`,
      /secret-token|private\/profile|private-route|Bearer|fake_host/u
    );
    return true;
  });
});

processGroupTest('the same absolute lifecycle deadline covers provider route allocation before spawn', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-python-route-timeout-');
  const marker = path.join(directory, 'spawned');
  const { hostPath } = await makeHost(t, `from pathlib import Path\nPath(${JSON.stringify(marker)}).write_text("spawned")\n`);
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: () => new Promise(() => {}),
    timeoutMs: 150
  }));
  const started = performance.now();
  await assert.rejects(() => executor.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'TIMEOUT');
    return true;
  });
  assert.ok(performance.now() - started < 1_000);
  await assert.rejects(() => stat(marker), { code: 'ENOENT' });
});

// This test repoints TMPDIR at its own directory and then asserts that nothing
// remains there, so no scratch directory may be created while that is in force:
// tools/scratch-directory.js reads os.tmpdir() at call time, and would put a
// root of its own inside tempParent.
processGroupTest('successful execution removes only its isolated invocation cwd and temp tree', async (t) => {
  const tempParent = await scratchDirectory(t, 'shadowgraph-python-cleanup-test-');
  const { hostPath } = await makeHost(t, successHostSource());
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = tempParent;
  t.after(() => {
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  });
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([])
  }));
  await executor.execute(requestFor());
  assert.deepEqual(await readdir(tempParent), []);
});

processGroupTest('persistent runtime state crosses fresh Python processes while cwd and temp remain ephemeral', async (t) => {
  const { directory, hostPath } = await makeHost(t, successHostSource({
    adapterId: 'basic-memory',
    assertions: String.raw`from pathlib import Path
persistent_paths = [
    Path(os.environ["HOME"]) / "synthetic-home-record",
    Path(os.environ["XDG_CONFIG_HOME"]) / "synthetic-config-record",
    Path(os.environ["XDG_DATA_HOME"]) / "synthetic-data-record",
]
audit_path = Path(os.environ["XDG_DATA_HOME"]) / "synthetic-paths.json"
if wrapper["request"]["operation"] == "persist":
    for state_path in persistent_paths:
        state_path.write_text("persisted", encoding="utf-8")
    audit_path.write_text(json.dumps({"cwd": os.getcwd(), "temp": os.environ["TEMP"], "home": os.environ["HOME"], "config": os.environ["XDG_CONFIG_HOME"]}), encoding="utf-8")
elif wrapper["request"]["operation"] == "retrieve":
    assert [state_path.read_text(encoding="utf-8") for state_path in persistent_paths] == ["persisted"] * 3`,
    mutate: String.raw`if request["operation"] == "persist":
    response["operations"]["memoryWriteOperations"] = 1
elif request["operation"] == "retrieve":
    response["operations"]["memoryReadOperations"] = 1
    response["result"]["nativeContext"] = [{"kind": "synthetic", "value": "persisted"}]`
  }));
  const stateRoot = path.join(directory, 'caller-owned-persistent-state');
  const options = {
    adapterId: 'basic-memory',
    armId: 'basic-memory',
    stateRoot,
    providerEndpointFor: () => { throw new Error('must not be called'); }
  };
  const persistExecutor = createPythonAdapterExecutor(executorOptions(hostPath, options));
  await persistExecutor.execute(requestFor('persist', {
    armId: 'basic-memory',
    namespace: { projectId: 'project-python-1', userId: null }
  }));
  const retrieveExecutor = createPythonAdapterExecutor(executorOptions(hostPath, options));
  const response = await retrieveExecutor.execute(requestFor('retrieve', {
    armId: 'basic-memory',
    namespace: { projectId: 'project-python-1', userId: null },
    attemptId: 'attempt-retrieve-after-process-boundary',
    phase: 'B'
  }));
  assert.deepEqual(response.result.nativeContext, [{ kind: 'synthetic', value: 'persisted' }]);

  const entries = await readdir(stateRoot);
  const leafName = entries.find((name) => /^[a-f0-9]{64}$/u.test(name));
  assert.ok(leafName);
  const dataRoot = path.join(stateRoot, leafName, 'data');
  assert.equal(await readFile(path.join(stateRoot, leafName, 'home', 'synthetic-home-record'), 'utf8'), 'persisted');
  assert.equal(await readFile(path.join(stateRoot, leafName, 'config', 'synthetic-config-record'), 'utf8'), 'persisted');
  assert.equal(await readFile(path.join(dataRoot, 'synthetic-data-record'), 'utf8'), 'persisted');
  const audit = JSON.parse(await readFile(path.join(dataRoot, 'synthetic-paths.json'), 'utf8'));
  await stat(audit.home);
  await stat(audit.config);
  await assert.rejects(() => stat(audit.cwd), { code: 'ENOENT' });
  await assert.rejects(() => stat(audit.temp), { code: 'ENOENT' });
});

processGroupTest('persistent state root is mandatory, absolute, owned, and cannot be a symlink', async (t) => {
  const { directory, hostPath } = await makeHost(t, successHostSource());
  const missing = executorOptions(hostPath, { providerEndpointFor: endpointFactory([]) });
  delete missing.stateRoot;
  assert.throws(() => createPythonAdapterExecutor(missing), PythonAdapterExecutorError);
  assert.throws(() => createPythonAdapterExecutor(executorOptions(hostPath, {
    stateRoot: 'relative-state',
    providerEndpointFor: endpointFactory([])
  })), PythonAdapterExecutorError);

  const nonEmptyRoot = path.join(directory, 'non-empty-state');
  await mkdir(nonEmptyRoot);
  await writeFile(path.join(nonEmptyRoot, 'caller-data'), 'do-not-adopt');
  const nonEmpty = createPythonAdapterExecutor(executorOptions(hostPath, {
    stateRoot: nonEmptyRoot,
    providerEndpointFor: endpointFactory([])
  }));
  await assert.rejects(() => nonEmpty.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
    return true;
  });

  const outside = path.join(directory, 'outside-state');
  const linked = path.join(directory, 'linked-state');
  await mkdir(outside);
  await symlink(outside, linked, 'dir');
  const symlinked = createPythonAdapterExecutor(executorOptions(hostPath, {
    stateRoot: linked,
    providerEndpointFor: endpointFactory([])
  }));
  await assert.rejects(() => symlinked.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
    return true;
  });
});

processGroupTest('state-root creation rejects a symlinked ancestor before any outside write', async (t) => {
  const { directory, hostPath } = await makeHost(t, successHostSource());
  const outside = path.join(directory, 'outside-ancestor');
  const linkedAncestor = path.join(directory, 'linked-ancestor');
  await mkdir(outside);
  await symlink(outside, linkedAncestor, 'dir');
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    stateRoot: path.join(linkedAncestor, 'must-not-create', 'state-root'),
    providerEndpointFor: endpointFactory([])
  }));

  await assert.rejects(() => executor.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
    return true;
  });
  assert.deepEqual(await readdir(outside), []);
});

processGroupTest('absolute timeout terminates and reaps the child process tree within the configured lifecycle budget', async (t) => {
  const directory = await scratchDirectory(t, 'shadowgraph-python-timeout-test-');
  const pidPath = path.join(directory, 'pid');
  const grandchildPidPath = path.join(directory, 'grandchild-pid');
  const { hostPath } = await makeHost(t, String.raw`import os
import pathlib
import subprocess
import sys
import time
sys.stdin.buffer.read()
pathlib.Path(${JSON.stringify(pidPath)}).write_text(str(os.getpid()))
grandchild = subprocess.Popen([
    sys.executable,
    "-c",
    'import pathlib, os, time; pathlib.Path(${JSON.stringify(grandchildPidPath)}).write_text(str(os.getpid())); time.sleep(3)',
])
while not pathlib.Path(${JSON.stringify(grandchildPidPath)}).exists():
    time.sleep(0.01)
time.sleep(3)
`);
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    timeoutMs: 250
  }));
  const started = performance.now();
  await assert.rejects(() => executor.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'TIMEOUT');
    return true;
  });
  assert.ok(performance.now() - started < 1_500);
  const pid = Number(await readFile(pidPath, 'utf8'));
  const grandchildPid = Number(await readFile(grandchildPidPath, 'utf8'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
});

processGroupTest('abort signal terminates the child and reports operator interruption once', async (t) => {
  const { hostPath } = await makeHost(t, 'import sys, time\nsys.stdin.buffer.read()\ntime.sleep(30)\n');
  const controller = new AbortController();
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    timeoutMs: 2_000
  }));
  const operation = executor.execute(requestFor(), { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(() => operation, (error) => {
    assert.equal(error.adapterCause, 'OPERATOR_INTERRUPTION');
    return true;
  });
});

processGroupTest('absolute lifecycle deadline settles even when a child seam never emits close', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource());
  const kills = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {};
    child.kill = (signal) => {
      kills.push(signal);
      return true;
    };
    return child;
  };
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess,
    timeoutMs: 120
  }));
  const started = performance.now();
  await assert.rejects(() => executor.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'TIMEOUT');
    return true;
  });
  assert.ok(performance.now() - started < 1_000);
  assert.deepEqual(kills, ['SIGTERM', 'SIGKILL', 'SIGKILL']);
});

processGroupTest('request and output limits fail closed and every created source file stays non-executable', async (t) => {
  const hugeOutput = `import sys\nsys.stdin.buffer.read()\nsys.stdout.write("x" * 2048 + "\\n")\n`;
  const { hostPath } = await makeHost(t, hugeOutput);
  const outputBounded = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    maxOutputBytes: 1024
  }));
  await assert.rejects(() => outputBounded.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
    return true;
  });

  const { hostPath: requestHost } = await makeHost(t, successHostSource());
  const requestBounded = createPythonAdapterExecutor(executorOptions(requestHost, {
    providerEndpointFor: endpointFactory([]),
    maxRequestBytes: 256
  }));
  await assert.rejects(() => requestBounded.execute(requestFor()), (error) => {
    assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
    return true;
  });
  assert.equal((await stat(hostPath)).mode & 0o111, 0);
});

// --- pinned-container execution ------------------------------------------
//
// The competitor lock pins an interpreter image so that a recorded number
// describes software somebody can reconstruct. Until now the executor spawned
// whatever `python3` the host carried, and set PYTHONPATH empty against a bare
// image, so no Python arm could have imported its library at all. These tests
// pin the invocation that fixes both.

const PINNED_IMAGE = 'python@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f';

function successResponse(request) {
  return {
    schemaVersion: 1,
    operation: request.operation,
    runId: request.runId,
    attemptId: request.attemptId,
    phase: request.phase,
    armId: request.armId,
    scenarioId: request.scenarioId,
    repetition: request.repetition,
    status: 'SUCCEEDED',
    result: { nativeContext: [], persistenceEvidence: null, isolationEvidence: null },
    failure: null,
    operations: {
      memoryReadOperations: 0,
      memoryWriteOperations: 0,
      mcpToolCalls: 0,
      outerDecisionModelCalls: 0,
      internalMemoryModelCalls: 0,
      embeddingCalls: 0,
      persistenceVerificationOperations: 0
    },
    storage: {
      status: 'NOT_AVAILABLE',
      bytes: null,
      scope: 'Fake Python native scope',
      method: null,
      reason: 'No exact attributable byte scope',
      blockedClaims: ['storage bytes']
    }
  };
}

/** A spawn seam that records every invocation and answers the first one. */
function recordingSpawn(request, { answer = true } = {}) {
  const calls = [];
  const spawnProcess = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {
      if (!answer || calls.length > 1) return;
      setImmediate(() => {
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(successResponse(request))}\n`, 'utf8'));
        child.emit('close', 0, null);
      });
    };
    child.kill = () => true;
    child.unref = () => {};
    return child;
  };
  return { calls, spawnProcess };
}

function flagValues(args, flag) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === flag) values.push(args[index + 1]);
  }
  return values;
}

function envMap(args) {
  return Object.fromEntries(flagValues(args, '--env').map((entry) => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

processGroupTest('a container-bound executor runs the pinned image, not the host interpreter', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource());
  const request = requestFor();
  const { calls, spawnProcess } = recordingSpawn(request);
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess,
    container: { image: PINNED_IMAGE, runtimeRoot: '/srv/shadowgraph/runtime' }
  }));

  const response = await executor.execute(request);
  assert.equal(response.status, 'SUCCEEDED');

  const [launch] = calls;
  assert.equal(launch.command, 'docker');
  assert.equal(launch.args[0], 'run');
  assert.ok(launch.args.includes(PINNED_IMAGE));
  assert.ok(launch.args.includes('--read-only'));
  assert.deepEqual(flagValues(launch.args, '--network'), ['host']);
});

processGroupTest('the wheel runtime is mounted read-only and named by PYTHONPATH', async (t) => {
  // The two halves have to agree. A mount nobody points PYTHONPATH at, or a
  // PYTHONPATH naming a path nobody mounted, both fail at import - and only one
  // of them looks wrong when you read it.
  const { hostPath } = await makeHost(t, successHostSource());
  const request = requestFor();
  const { calls, spawnProcess } = recordingSpawn(request);
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess,
    container: { image: PINNED_IMAGE, runtimeRoot: '/srv/shadowgraph/runtime' }
  }));
  await executor.execute(request);

  const { args } = calls[0];
  const mounts = flagValues(args, '--mount');
  const runtimeMount = mounts.find((mount) => mount.includes('/srv/shadowgraph/runtime'));
  assert.ok(runtimeMount, 'the runtime must be mounted');
  assert.ok(runtimeMount.endsWith(',readonly'), 'an arm must not rewrite the packages it is measured on');

  const target = runtimeMount.split('target=')[1].split(',')[0];
  assert.equal(envMap(args).PYTHONPATH, target);
});

processGroupTest('the adapter environment travels as arguments and names container paths', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource());
  const request = requestFor();
  const { calls, spawnProcess } = recordingSpawn(request);
  const stateRoot = path.join(path.dirname(hostPath), 'persistent-state');
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess,
    stateRoot,
    container: { image: PINNED_IMAGE, runtimeRoot: '/srv/shadowgraph/runtime' }
  }));
  await executor.execute(request);

  const { args, options } = calls[0];
  const environment = envMap(args);
  const stateLeaf = environment.SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT;
  assert.ok(stateLeaf.startsWith('/run/shadowgraph/state/'), stateLeaf);
  assert.ok(!stateLeaf.includes(stateRoot), 'the adapter must not be handed a host path');
  assert.equal(environment.HOME, `${stateLeaf}/home`);
  assert.equal(environment.BASIC_MEMORY_CONFIG_DIR, `${stateLeaf}/config/basic-memory`);
  assert.equal(environment.TMPDIR, '/tmp');
  assert.equal(environment.PYTHONHASHSEED, '0');

  // The docker client's own environment is not the adapter's. Passing the
  // adapter environment to the client would leak the host's PATH into a run
  // whose whole point is not to depend on the host.
  assert.equal(options.env.SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT, undefined);
  assert.equal(options.env.PYTHONPATH, undefined);
});

processGroupTest('each invocation gets its own container name, and a timeout removes it', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource());
  const request = requestFor();
  const { calls, spawnProcess } = recordingSpawn(request, { answer: false });
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess,
    timeoutMs: 120,
    container: { image: PINNED_IMAGE, runtimeRoot: '/srv/shadowgraph/runtime' }
  }));

  await assert.rejects(() => executor.execute(request), (error) => {
    assert.equal(error.adapterCause, 'TIMEOUT');
    return true;
  });

  const launch = calls[0];
  const containerName = flagValues(launch.args, '--name')[0];
  assert.match(containerName, /^shadowgraph-v11-[0-9a-f]{32}$/u);

  // Signalling the foreground client is not enough: a SIGKILLed client leaves
  // the container running.
  const removal = calls.find((call) => call.args[0] === 'rm');
  assert.ok(removal, 'a timed-out invocation must remove its container by name');
  assert.deepEqual(removal.args, ['rm', '--force', containerName]);
});

processGroupTest('a container image that is not digest-pinned is refused', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource());
  const request = requestFor();
  const { spawnProcess } = recordingSpawn(request);
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess,
    container: { image: 'python:3.12.11-slim' }
  }));
  await assert.rejects(() => executor.execute(request), (error) => {
    assert.equal(error.adapterCause, 'CONTRACT_FAILURE');
    assert.match(error.message, /container invocation is invalid/u);
    return true;
  });
});

test('malformed container options are refused at construction', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource());
  for (const container of [
    'python',
    { runtimeRoot: '/srv/runtime' },
    { image: PINNED_IMAGE, runtimeRoot: 'relative/runtime' },
    { image: PINNED_IMAGE, dockerExecutable: '' }
  ]) {
    assert.throws(
      () => createPythonAdapterExecutor(executorOptions(hostPath, {
        providerEndpointFor: endpointFactory([]),
        container
      })),
      PythonAdapterExecutorError,
      `${JSON.stringify(container)} must be refused`
    );
  }
});

processGroupTest('without container options the executor still runs the host interpreter', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource());
  const request = requestFor();
  const { calls, spawnProcess } = recordingSpawn(request);
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess
  }));
  await executor.execute(request);

  assert.equal(calls[0].command, 'python3');
  assert.deepEqual(calls[0].args, [hostPath]);
  assert.equal(calls[0].options.env.PYTHONPATH, '', 'the host path still blanks PYTHONPATH');
});

processGroupTest('a client killed from outside still has its container removed', async (t) => {
  // Found by review. The timeout and abort paths removed the container, but a
  // client that dies without this harness asking - an operator kill, the OOM
  // killer, a broken attach to a remote daemon - reached the close handler with
  // no failure latched and nothing addressed the container. `--rm` does not
  // help: it fires when the container exits, which is exactly what has not
  // happened, and least of all when the adapter is hung.
  const { hostPath } = await makeHost(t, successHostSource());
  const request = requestFor();
  const calls = [];
  const spawnProcess = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = () => {
      if (calls.length > 1) return;
      // The client is killed; the container it started is not.
      setImmediate(() => child.emit('close', null, 'SIGKILL'));
    };
    child.kill = () => true;
    child.unref = () => {};
    return child;
  };

  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess,
    container: { image: PINNED_IMAGE, runtimeRoot: '/srv/shadowgraph/runtime' }
  }));

  await assert.rejects(() => executor.execute(request));

  const containerName = flagValues(calls[0].args, '--name')[0];
  const removal = calls.find((call) => call.args[0] === 'rm');
  assert.ok(removal, 'a client killed from outside must still remove its container');
  assert.deepEqual(removal.args, ['rm', '--force', containerName]);
});

processGroupTest('two invocations for one unit get two different container names', async (t) => {
  // The previous test performed a single invocation and asserted the name
  // matched a pattern, so deriving the name from the state leaf - which a reset
  // and a persist for one unit share - kept it green while reintroducing the
  // collision the random name exists to prevent.
  const { hostPath } = await makeHost(t, successHostSource());
  const calls = [];
  const spawnProcess = (command, args, options = {}) => {
    calls.push({ command, args: [...args], options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    const index = calls.length;
    child.stdin.end = () => {
      setImmediate(() => {
        const forRequest = index === 1 ? requestFor('reset') : requestFor('persist');
        child.stdout.emit('data', Buffer.from(`${JSON.stringify(successResponse(forRequest))}\n`, 'utf8'));
        child.emit('close', 0, null);
      });
    };
    child.kill = () => true;
    child.unref = () => {};
    return child;
  };

  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([]),
    spawnProcess,
    container: { image: PINNED_IMAGE, runtimeRoot: '/srv/shadowgraph/runtime' }
  }));

  // A reset and a persist for the same unit resolve to the same state leaf.
  await executor.execute(requestFor('reset'));
  await executor.execute(requestFor('persist'));

  const runs = calls.filter((call) => call.args[0] === 'run');
  assert.equal(runs.length, 2);
  const [first, second] = runs.map((call) => flagValues(call.args, '--name')[0]);
  assert.match(first, /^shadowgraph-v11-[0-9a-f]{32}$/u);
  assert.notEqual(first, second, 'two invocations must not contend for one container name');
});


// --------------------------------------------------------------------------
// The pinned models the wrapper carries.
//
// Routes say where an internal call goes. Until the wrapper carried models,
// nothing said what to ask for, so each library used its own default: mem0
// 2.0.19 asks for gpt-5-mini and text-embedding-3-small, and sizes its vector
// collection to the latter's 1536 dimensions. Against the pinned Ollama - which
// serves qwen2.5:7b and a 768-wide nomic-embed-text - the first is a model
// that is not there and the second is a collection the wrong width for the
// vectors written into it. Neither is visible in a route.

processGroupTest('the wrapper carries the locked model and dimension for every metered class', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource({
    assertions: String.raw`assert wrapper["providerModels"] == {
    "internal_memory_llm": {"modelId": "qwen2.5:7b", "embeddingDimension": None},
    "embedding": {"modelId": "nomic-embed-text:v1.5", "embeddingDimension": 768},
}`
  }));
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    providerEndpointFor: endpointFactory([])
  }));
  const response = await executor.execute(requestFor('retrieve'));
  assert.equal(response.status, 'SUCCEEDED');

  // And the literals above are the lock's, not this test's.
  const locked = pinnedModelsFor('mem0-oss');
  assert.equal(locked.internal_memory_llm.modelId, 'qwen2.5:7b');
  assert.equal(locked.embedding.modelId, 'nomic-embed-text:v1.5');
  assert.equal(locked.embedding.embeddingDimension, 768);
});

processGroupTest('an arm that meters nothing is handed no model either', async (t) => {
  const { hostPath } = await makeHost(t, successHostSource({
    adapterId: 'basic-memory',
    assertions: 'assert wrapper["providerModels"] == {"internal_memory_llm": None, "embedding": None}'
  }));
  const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
    adapterId: 'basic-memory',
    armId: 'basic-memory'
  }));
  const response = await executor.execute(requestFor('retrieve', { armId: 'basic-memory' }));
  assert.equal(response.status, 'SUCCEEDED');
});

test('a metered arm without its pinned models cannot be constructed', () => {
  const hostPath = path.resolve('unused-host.py');
  const bad = [
    undefined,
    null,
    'qwen2.5:0.5b',
    {},
    // A model for one class and not the other.
    { internal_memory_llm: { modelId: 'qwen2.5:7b', embeddingDimension: null }, embedding: null },
    // The embedding width missing, which is the half that fails silently.
    {
      internal_memory_llm: { modelId: 'qwen2.5:7b', embeddingDimension: null },
      embedding: { modelId: 'nomic-embed-text:v1.5', embeddingDimension: null }
    },
    // A width on the chat model, which would mean the two were transposed.
    {
      internal_memory_llm: { modelId: 'qwen2.5:7b', embeddingDimension: 768 },
      embedding: { modelId: 'nomic-embed-text:v1.5', embeddingDimension: 768 }
    },
    // Ids that are not ids.
    {
      internal_memory_llm: { modelId: 'qwen 2.5', embeddingDimension: null },
      embedding: { modelId: 'nomic-embed-text:v1.5', embeddingDimension: 768 }
    },
    {
      internal_memory_llm: { modelId: '', embeddingDimension: null },
      embedding: { modelId: 'nomic-embed-text:v1.5', embeddingDimension: 768 }
    }
  ];
  for (const providerModels of bad) {
    assert.throws(
      () => createPythonAdapterExecutor(executorOptions(hostPath, {
        providerEndpointFor: async () => 'http://127.0.0.1:43100/provider-meter/v1/aaaa',
        providerModels
      })),
      PythonAdapterExecutorError,
      `${JSON.stringify(providerModels)} must not construct`
    );
  }
});

processGroupTest('an arm that meters nothing may not be handed a model for something', () => {
  const hostPath = path.resolve('unused-host.py');
  assert.throws(() => createPythonAdapterExecutor(executorOptions(hostPath, {
    adapterId: 'basic-memory',
    armId: 'basic-memory',
    providerModels: pinnedModelsFor('mem0-oss')
  })), PythonAdapterExecutorError);

  // Explicit nulls are the same statement as saying nothing, and both stand.
  for (const providerModels of [
    undefined,
    { internal_memory_llm: null, embedding: null }
  ]) {
    const executor = createPythonAdapterExecutor(executorOptions(hostPath, {
      adapterId: 'basic-memory',
      armId: 'basic-memory',
      providerModels
    }));
    assert.equal(typeof executor.execute, 'function');
  }
});
