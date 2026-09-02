import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createAdapterRequest } from '../benchmark/lib/adapter-protocol.mjs';
import {
  PYTHON_ADAPTER_SPECS,
  PythonAdapterExecutorError,
  createPythonAdapterExecutor
} from '../benchmark/lib/python-adapter-executor.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

function decisionContent() {
  return {
    decisionId: 'decision-python-1',
    choiceId: 'choice-python-1',
    recalledAlternativeIds: [],
    recalledRejectionReasonIds: [],
    constraintIdsAddressed: [],
    evidenceIdsCited: [],
    riskIdsRecognized: [],
    reviewTriggerIds: [],
    changedFactDetected: false,
    changedFactId: null,
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
assert set(wrapper) == {"schemaVersion", "adapterId", "request", "providerRoutes"}
assert wrapper["schemaVersion"] == 1
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

function executorOptions(hostPath, overrides = {}) {
  return {
    adapterId: overrides.adapterId ?? 'mem0-oss',
    armId: overrides.armId ?? 'mem0-oss',
    pythonExecutable: overrides.pythonExecutable ?? 'python3',
    hostPath,
    stateRoot: overrides.stateRoot ?? path.join(path.dirname(hostPath), 'persistent-state'),
    providerEndpointFor: overrides.providerEndpointFor,
    spawnProcess: overrides.spawnProcess,
    timeoutMs: overrides.timeoutMs ?? 2_000,
    maxRequestBytes: overrides.maxRequestBytes,
    maxOutputBytes: overrides.maxOutputBytes
  };
}

test('public adapter specs bind four exact ids, arms, versions, and provider requirements', () => {
  assert.deepEqual(PYTHON_ADAPTER_SPECS, {
    'mem0-oss': {
      armId: 'mem0-oss',
      packages: { mem0ai: '2.0.19' },
      requestClasses: ['internal_memory_llm', 'embedding']
    },
    'basic-memory': {
      armId: 'basic-memory',
      packages: { 'basic-memory': '0.23.2' },
      requestClasses: []
    },
    graphiti: {
      armId: 'graphiti',
      packages: { 'graphiti-core': '0.29.3', httpx: '0.28.1' },
      requestClasses: ['internal_memory_llm', 'embedding']
    },
    cognee: {
      armId: 'cognee',
      packages: { cognee: '1.5.3' },
      requestClasses: ['internal_memory_llm', 'embedding']
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

test('executor validates request, binds exact arm, obtains fresh correlation routes, and validates response', async (t) => {
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
    assert.equal(Object.hasOwn(call.correlation, 'operation'), false);
  }
  assert.doesNotMatch(JSON.stringify(first), /provider-meter|43100/u);
});

test('basic-memory launches with both provider routes null and never invokes route callback', async (t) => {
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

test('wrong arm and invalid requests fail before provider lookup or child spawn', async (t) => {
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

test('missing, cloud, credentialed, queried, and reused provider routes fail before spawn', async (t) => {
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
  test(`executor rejects ${fixture.name} without exposing output`, async (t) => {
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

test('stderr and nonzero exit are sanitized with no path, body, endpoint, or credential leak', async (t) => {
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

test('the same absolute lifecycle deadline covers provider route allocation before spawn', async (t) => {
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

test('successful execution removes only its isolated invocation cwd and temp tree', async (t) => {
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

test('persistent runtime state crosses fresh Python processes while cwd and temp remain ephemeral', async (t) => {
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

test('persistent state root is mandatory, absolute, owned, and cannot be a symlink', async (t) => {
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

test('state-root creation rejects a symlinked ancestor before any outside write', async (t) => {
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

test('absolute timeout terminates and reaps the child process tree within the configured lifecycle budget', async (t) => {
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

test('abort signal terminates the child and reports operator interruption once', async (t) => {
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

test('absolute lifecycle deadline settles even when a child seam never emits close', async (t) => {
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

test('request and output limits fail closed and every created source file stays non-executable', async (t) => {
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
