// The runtime host for the four arms that execute inside the pinned Python image.
//
// `createV11AdapterExecutor` routes every arm to `hosts[descriptor.kind]`, and
// until this module existed the `python-container` kind had no entry at all: a
// preflight could report READY and four of the seven arms still had nowhere to
// run. So the first thing these tests care about is that the binding exists,
// names exactly the arms the pinned specs name, and refuses everything else -
// an arm attached to the wrong runtime produces a complete run whose numbers
// describe a configuration nobody chose.
//
// The defect this suite exists to catch, though, is quieter than that, and it
// is the one in the middle of the file: **the two host kinds report failure in
// opposite directions.** A node adapter returns a FAILED envelope carrying its
// cause. The Python executor *throws*, and the cause rides on `.adapterCause` -
// a property the runner's `thrownFailure` never reads. `thrownFailure` walks
// `error.cause` chains and error codes, finds nothing it recognises on a
// `PythonAdapterExecutorError`, and falls through to `CONTRACT_FAILURE`. An
// adapter that hit its deadline, or that an operator interrupted, would
// therefore be written into the run record as a contract failure of the
// benchmark's own making - the harness blaming the product's software for the
// harness's own clock, or the reverse. Nothing crashes when that translation is
// missing or partial. The run completes, the report is well formed, and one
// arm's failures are attributed to the wrong thing. Only a test that forces
// each cause across the boundary and reads the envelope on the other side can
// see it.
//
// Nothing here starts a container, reaches a network, or invokes a real docker.
// Every failure is forced through a seam the module already exposes: the
// descriptor it is handed, the provider endpoint source it is constructed with,
// the abort signal it forwards, and the container executable it is told to use.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

import { createAdapterRequest, validateAdapterResponse } from '../benchmark/lib/adapter-protocol.mjs';
import {
  PYTHON_ADAPTER_SPECS,
  PythonAdapterExecutorError
} from '../benchmark/lib/python-adapter-executor.mjs';
import { NETWORK_MODES } from '../benchmark/lib/python-container-runtime.mjs';
import {
  PYTHON_RUNTIME_KIND,
  PythonHostError,
  createV11PythonHosts
} from '../benchmark/lib/v11-python-hosts.mjs';
import { createV11Registry } from '../benchmark/lib/v11-registry.mjs';
import { scratchDirectory } from '../tools/scratch-directory.js';

// The real locks, not fixtures. The image a descriptor carries and the models a
// metered arm is handed have to be the ones this benchmark actually pins; a
// test that invented its own would keep passing if the wiring quietly stopped
// reading them.
const COMPETITOR_LOCK = JSON.parse(readFileSync(
  new URL('../benchmark/competitors.lock.json', import.meta.url),
  'utf8'
));
const MODEL_WEIGHTS = JSON.parse(readFileSync(
  new URL('../benchmark/model-weights.lock.json', import.meta.url),
  'utf8'
));
const PINNED_IMAGE = COMPETITOR_LOCK.pythonImage;

// The same digest with the tag removed, and the reason it has to exist here is
// a defect in the modules under and beside this one rather than anything about
// the test.
//
// The lock records `python:3.12.11-slim@sha256:<64 hex>` - the tag-plus-digest
// The image the competitor lock pins carries a tag before its digest:
// `python:3.12.11-slim@sha256:...`. Writing this suite found that
// `buildContainerInvocation` refused exactly that spelling - its
// `DIGEST_PINNED_IMAGE` allowed no tag - while the registry, this module and
// every probe command accepted it and handed it straight to `docker run`, where
// it works. Nothing caught it because the two sides had never been composed:
// the executor's own tests all use a tagless image.
//
// The consequence was not a crash. The refusal became a
// PythonAdapterExecutorError, this host faithfully translated it into a FAILED
// envelope, and all four container arms would have been recorded as contract
// failures of the products. The regex now permits the optional tag OCI allows,
// and the digest still decides which image runs.
const LAUNCHABLE_IMAGE = PINNED_IMAGE;

// The executor refuses to construct at all without POSIX process-group
// isolation, so every test that builds one - as opposed to testing a refusal
// that happens before one is built - can only run where the runtime could.
function processGroupTest(name, fn) {
  return test(name, {
    skip: process.platform === 'win32'
      ? 'the pinned Python runtime requires POSIX process-group isolation'
      : false
  }, fn);
}

function descriptorFor(armId, overrides = {}) {
  return {
    armId,
    kind: PYTHON_RUNTIME_KIND,
    containerImage: PINNED_IMAGE,
    requestClasses: [...(PYTHON_ADAPTER_SPECS[armId]?.requestClasses ?? [])],
    ...overrides
  };
}

function payloadFor(operation) {
  if (operation === 'reset') return {};
  if (operation === 'persist') {
    return {
      record: {
        id: 'decision:python-hosts:scenario-one:0:A',
        type: 'decision',
        content: {
          decisionId: 'model-decision-a',
          choiceId: 'choice-a',
          recalledAlternativeIds: [],
          recalledRejectionReasonIds: [],
          constraintIdsAddressed: [],
          evidenceIdsCited: [],
          riskIdsRecognized: [],
          reviewTriggerIds: [],
          changedFactDetected: false,
          changedFactId: null,
          recommendation: 'Use the reversible migration.',
          failedAttemptIdsAvoided: [],
          failedAttemptReasonIdsCited: [],
          memoryProjectId: 'primary-project',
          memoryUserId: 'primary-user'
        }
      }
    };
  }
  return { query: { scenarioId: 'scenario-one', task: 'Choose a safe migration.' } };
}

function requestFor(operation, armId, overrides = {}) {
  return createAdapterRequest({
    operation,
    correlation: {
      runId: 'run-python-hosts',
      attemptId: `attempt-${armId}-${operation}`,
      phase: 'A',
      armId,
      scenarioId: 'scenario-one',
      repetition: 0
    },
    namespace: overrides.namespace ?? { projectId: 'primary-project', userId: 'primary-user' },
    payload: overrides.payload ?? payloadFor(operation)
  });
}

// Distinct loopback capabilities, because the executor refuses to reuse one.
function endpointFactory() {
  let sequence = 0;
  return async () => {
    sequence += 1;
    return `http://127.0.0.1:43100/provider-meter/v1/${String(sequence).padStart(48, 'b')}`;
  };
}

async function hosts(t, overrides = {}) {
  const stateRoot = await scratchDirectory(t, 'shadowgraph-v11-python-hosts-state-');
  const runtimeRoot = await scratchDirectory(t, 'shadowgraph-v11-python-hosts-site-');
  return createV11PythonHosts({
    stateRoot,
    runtimeRoot,
    providerEndpointFor: endpointFactory(),
    modelWeights: MODEL_WEIGHTS,
    timeoutMs: 20_000,
    ...overrides
  });
}

/**
 * A stand-in for the container executable that records the argv it was handed
 * and then fails.
 *
 * This is the only way to see what the module decided about the container from
 * outside it: the launch options are passed to `createPythonAdapterExecutor` and
 * never exposed again, so the argv the executor builds and the wrapper it writes
 * to stdin are the sole observables. The stdin capture is the load-bearing half:
 * the argv says which image and which network, and only the wrapper says which
 * *models* the arm was told to use - and replacing the pinned ids with a
 * library's own defaults passed this entire suite until it was kept. Nothing is
 * pulled, started, or connected to - the script writes both files and exits
 * non-zero.
 */
async function recordingContainerExecutable(t) {
  const directory = await scratchDirectory(t, 'shadowgraph-v11-python-hosts-docker-');
  const executable = path.join(directory, 'recording-container-executable');
  const record = path.join(directory, 'invocations.txt');
  const requests = path.join(directory, 'requests.ndjson');
  await writeFile(executable, [
    '#!/bin/sh',
    'for argument in "$@"',
    'do',
    `  printf '%s\\n' "$argument" >> '${record}'`,
    'done',
    `printf '%s\\n' '--end-of-invocation--' >> '${record}'`,
    `cat >> '${requests}'`,
    'exit 3',
    ''
  ].join('\n'), { encoding: 'utf8', mode: 0o755 });

  return {
    executable,
    invocations() {
      let text;
      try {
        text = readFileSync(record, 'utf8');
      } catch {
        return [];
      }
      const invocations = [];
      let current = [];
      for (const line of text.split('\n').slice(0, -1)) {
        if (line === '--end-of-invocation--') {
          invocations.push(current);
          current = [];
          continue;
        }
        current.push(line);
      }
      return invocations;
    },
    /** The protocol wrappers the executor wrote to the container's stdin. */
    requests() {
      let text;
      try {
        text = readFileSync(requests, 'utf8');
      } catch {
        return [];
      }
      return text
        .split(String.fromCharCode(10))
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line));
    }
  };
}

test('the module binds exactly one runtime kind - python-container - and freezes the map', async (t) => {
  const bound = await hosts(t);

  assert.equal(PYTHON_RUNTIME_KIND, 'python-container');
  assert.deepEqual(Object.keys(bound), [PYTHON_RUNTIME_KIND]);
  assert.equal(typeof bound[PYTHON_RUNTIME_KIND], 'function');
  // The local kinds belong to the sibling module. A binding that answered for
  // them too would let a `control` arm be routed into a container.
  assert.equal(bound.control, undefined);
  assert.equal(bound['node-mcp'], undefined);
  assert.ok(Object.isFrozen(bound), 'the host map must not be extended after construction');
});

test('construction refuses every option that would put the runtime somewhere nobody chose', async (t) => {
  const stateRoot = await scratchDirectory(t, 'shadowgraph-v11-python-hosts-state-');
  const runtimeRoot = await scratchDirectory(t, 'shadowgraph-v11-python-hosts-site-');
  const valid = {
    stateRoot,
    runtimeRoot,
    providerEndpointFor: endpointFactory(),
    modelWeights: MODEL_WEIGHTS
  };

  // The Python executor adopts its state root by writing an ownership marker
  // and refuses a non-empty root that carries none, so a relative root resolved
  // against whatever cwd the runner happened to have is not a cosmetic defect:
  // it is a root that works once and refuses on the next invocation from a
  // different directory. A filesystem root is worse - it would adopt the disk.
  for (const badStateRoot of [undefined, null, '', 'relative/state', path.parse(process.cwd()).root]) {
    assert.throws(
      () => createV11PythonHosts({ ...valid, stateRoot: badStateRoot }),
      PythonHostError,
      `state root ${JSON.stringify(badStateRoot)} must be refused`
    );
  }

  // The runtime site is mounted read-only and named by PYTHONPATH. A relative
  // one names a directory inside the container that does not exist, and every
  // Python arm then fails at import for a reason that reads as a packaging bug.
  for (const badRuntimeRoot of [undefined, null, '', 'relative/site', 'site-packages']) {
    assert.throws(
      () => createV11PythonHosts({ ...valid, runtimeRoot: badRuntimeRoot }),
      PythonHostError,
      `runtime site ${JSON.stringify(badRuntimeRoot)} must be refused`
    );
  }

  // Three of the four arms meter provider traffic. Without a source of metered
  // endpoints they would reach a provider the meter never saw.
  for (const badSource of [undefined, null, {}, 'http://127.0.0.1:43100/', []]) {
    assert.throws(
      () => createV11PythonHosts({ ...valid, providerEndpointFor: badSource }),
      PythonHostError,
      `provider endpoint source ${JSON.stringify(badSource)} must be refused`
    );
  }

  for (const badTimeout of [0, -1, -20_000, 1.5, Number.NaN, '20000']) {
    assert.throws(
      () => createV11PythonHosts({ ...valid, timeoutMs: badTimeout }),
      PythonHostError,
      `timeout ${JSON.stringify(badTimeout)} must be refused`
    );
  }

  // The positive control: without it every refusal above would be satisfied by
  // a constructor that threw unconditionally.
  assert.equal(typeof createV11PythonHosts(valid), 'object');
  assert.equal(typeof createV11PythonHosts({ ...valid, timeoutMs: 20_000 }), 'object');
});

test('the host refuses an unnamed arm, an unpinned image, and a registry that disagrees about metered classes', async (t) => {
  const bound = await hosts(t);
  const host = bound[PYTHON_RUNTIME_KIND];

  // (1) Arms the pinned specs do not name. The three local arms are the
  // dangerous ones: they are real arm ids, so a host that fell through to a
  // default would run one of them in a container and report the number under
  // the same name.
  for (const armId of ['no-memory', 'shadowgraph-full', 'shadowgraph-compact', 'zep', 'mem0']) {
    assert.throws(
      () => host(descriptorFor(armId, { requestClasses: [] })),
      PythonHostError,
      `${armId} must not be bound to the pinned Python runtime`
    );
  }
  assert.throws(
    () => host(null),
    PythonHostError,
    'a missing descriptor must be refused rather than read for an arm id'
  );

  // (2) A tag can be repointed, so a tagged reference cannot support a
  // reproducibility claim. `null` is the value the registry puts on every arm
  // it does not mark python-container, so it is the exact shape a
  // mis-routed descriptor arrives with.
  const [repository] = PINNED_IMAGE.split('@');
  for (const containerImage of [null, undefined, '', repository, `${repository}:latest`, 'sha256:abc']) {
    assert.throws(
      () => host(descriptorFor('mem0-oss', { containerImage })),
      PythonHostError,
      `image ${JSON.stringify(containerImage)} must be refused as unpinned`
    );
  }

  // (3) The registry and the executor spec each carry the arm's metered request
  // classes, and this binding reads the descriptor's copy to decide whether the
  // container gets a network. Silently preferring one side would both hide the
  // registry defect and decide that network question by accident. The reordered
  // case matters as much as the missing one: two classes in the wrong order is
  // the same set, and a comparison written with `Set` or `includes` would let
  // it through while the executor still meters them positionally.
  for (const requestClasses of [
    undefined,
    [],
    ['embedding'],
    ['embedding', 'internal_memory_llm'],
    ['internal_memory_llm', 'embedding', 'internal_memory_llm']
  ]) {
    assert.throws(
      () => host(descriptorFor('mem0-oss', { requestClasses })),
      PythonHostError,
      `request classes ${JSON.stringify(requestClasses ?? null)} must be refused for mem0-oss`
    );
  }
  // The mirror image: the one arm that meters nothing, declared as metering
  // something. Left unchecked this arm would be handed a network it must not
  // have, and the "issues no provider call" claim would go back to being prose.
  for (const requestClasses of [['embedding'], ['internal_memory_llm', 'embedding']]) {
    assert.throws(
      () => host(descriptorFor('basic-memory', { requestClasses })),
      PythonHostError,
      `request classes ${JSON.stringify(requestClasses)} must be refused for basic-memory`
    );
  }

  // The positive control for all three refusals above. Guarded rather than
  // skipped, because the refusals themselves hold on every platform while the
  // accepted case can only be built where the runtime could run at all.
  if (process.platform !== 'win32') {
    for (const armId of Object.keys(PYTHON_ADAPTER_SPECS)) {
      assert.equal(
        typeof host(descriptorFor(armId)),
        'function',
        `${armId} must be accepted with the descriptor the registry produces`
      );
    }
  }
});

// THE CENTRAL PROPERTY.
//
// Each entry forces one cause out of the real executor through a seam this
// module already exposes, and the test then reads the envelope the module
// returned. The four causes are all members of `ADAPTER_FAILURE_CAUSES`
// already; the whole question is whether they survive the boundary.
const TRANSLATED_CAUSES = [
  {
    cause: 'CONTRACT_FAILURE',
    armId: 'mem0-oss',
    // The executor is built for one arm and refuses a request for another.
    // Nothing is spawned and no state is touched to reach this.
    forced: 'a request whose arm is not the arm the executor was built for',
    requestArmId: 'graphiti'
  },
  {
    cause: 'OPERATOR_INTERRUPTION',
    armId: 'mem0-oss',
    forced: 'an already-aborted signal forwarded through the host',
    executeOptions: () => ({ signal: AbortSignal.abort() })
  },
  {
    cause: 'TIMEOUT',
    armId: 'mem0-oss',
    forced: 'a provider endpoint source that never answers, against a 50 ms deadline',
    async overrides() {
      return { timeoutMs: 50, providerEndpointFor: () => new Promise(() => {}) };
    }
  },
  {
    cause: 'INFRASTRUCTURE_FAILURE',
    armId: 'basic-memory',
    forced: 'a container executable that fails instead of launching',
    containerImage: LAUNCHABLE_IMAGE,
    async overrides(t) {
      const { executable } = await recordingContainerExecutable(t);
      return { dockerExecutable: executable };
    }
  }
];

processGroupTest('every cause the Python executor throws is carried into the FAILED envelope unchanged', async (t) => {
  // Why this is the property this module exists for: the executor reports a
  // failure by throwing, and the cause lives on `.adapterCause`. The runner's
  // `thrownFailure` does not read that property - it inspects `error.cause`
  // chains, `error.code`, and HTTP status, and a `PythonAdapterExecutorError`
  // carries none of them. So a thrown TIMEOUT reaching the runner untranslated
  // is recorded as CONTRACT_FAILURE: the benchmark reporting that the product
  // violated a contract when what actually happened is that the harness's own
  // deadline expired. An OPERATOR_INTERRUPTION becomes the same lie in the
  // other direction. The assertion below pins that these errors really do carry
  // the cause nowhere a generic error walker could find it, so the translation
  // is the only thing standing between the executor and a mis-attributed
  // failure.
  for (const cause of ['CONTRACT_FAILURE', 'INFRASTRUCTURE_FAILURE', 'TIMEOUT', 'OPERATOR_INTERRUPTION']) {
    const sample = new PythonAdapterExecutorError(cause, 'sample');
    assert.equal(sample.adapterCause, cause);
    assert.equal(sample.cause, undefined, 'the cause is not on a chain a generic walker would follow');
    assert.equal(sample.code, undefined, 'the cause is not on an error code a generic walker would read');
  }

  const seen = [];
  for (const entry of TRANSLATED_CAUSES) {
    const overrides = entry.overrides === undefined ? {} : await entry.overrides(t);
    const bound = await hosts(t, overrides);
    const execute = bound[PYTHON_RUNTIME_KIND](descriptorFor(entry.armId, {
      ...(entry.containerImage === undefined ? {} : { containerImage: entry.containerImage })
    }));
    const request = requestFor('retrieve', entry.requestArmId ?? entry.armId);

    const response = entry.executeOptions === undefined
      ? await execute(request)
      : await execute(request, entry.executeOptions());

    const label = `${entry.cause} forced by ${entry.forced}`;
    // A throw that escaped would have failed the await above; what has to be
    // checked is that the envelope says the same thing the throw said.
    assert.equal(response.status, 'FAILED', label);
    assert.equal(response.failure.cause, entry.cause, label);
    // The envelope must be one the protocol accepts and one the runner can
    // correlate, or the translation has merely moved the problem.
    validateAdapterResponse({ request, response });
    assert.equal(response.armId, request.armId, label);
    assert.equal(response.attemptId, request.attemptId, label);
    // A failed unit measured nothing, and must not be recorded as having
    // measured zero: zero bytes is a claim, absence of a scope is not.
    assert.equal(response.storage.status, 'NOT_AVAILABLE', label);
    assert.equal(response.storage.bytes, null, label);
    assert.deepEqual(response.storage.blockedClaims, ['storage bytes'], label);
    assert.equal(response.result.nativeContext.length, 0, label);
    assert.equal(response.operations.memoryReadOperations, 0, label);

    seen.push(response.failure.cause);
  }

  // Every distinct cause, not four envelopes that happen to agree - a
  // translation hard-coded to one constant passes each assertion above in
  // isolation and fails here.
  assert.deepEqual(
    [...seen].sort(),
    ['CONTRACT_FAILURE', 'INFRASTRUCTURE_FAILURE', 'OPERATOR_INTERRUPTION', 'TIMEOUT'],
    'each of the four causes must arrive as itself'
  );
});

processGroupTest('an error that is not the executor\'s own propagates untouched instead of becoming a unit failure', async (t) => {
  // The translation above is deliberately narrow, and this is why. A fault in
  // the harness - a runner handing the host a malformed options object, a
  // programming error in the binding itself - is not a fact about the arm. Made
  // into a FAILED envelope it would be counted against the product, silently and
  // permanently, in a run that otherwise looks clean.
  const bound = await hosts(t);
  const execute = bound[PYTHON_RUNTIME_KIND](descriptorFor('mem0-oss'));
  const request = requestFor('retrieve', 'mem0-oss');

  const harnessFault = new RangeError('the harness handed the host a broken options object');
  await assert.rejects(
    () => execute(request, { get signal() { throw harnessFault; } }),
    (error) => {
      // Identity, not shape: the original object has to arrive, unwrapped and
      // unreclassified, so whoever debugs it sees their own stack.
      assert.equal(error, harnessFault, 'the harness fault must propagate as the very same error');
      return true;
    }
  );

  // The same shape a runner could produce by accident rather than on purpose:
  // the executor destructures its options argument, and `null` is not
  // `undefined`.
  await assert.rejects(() => execute(request, null), TypeError);
});

processGroupTest('an arm that meters nothing is given a container with no network, and a metered arm the host network', async (t) => {
  // The claim "this arm issues no provider call" is enforced by the container
  // rather than checked after the fact - but only if the mode actually reaches
  // the invocation. The launch options are handed to
  // `createPythonAdapterExecutor` and never exposed again, so the argv is the
  // only observable, and a recording stand-in for the container executable is
  // the only way to read it without starting anything.
  const recorder = await recordingContainerExecutable(t);
  const bound = await hosts(t, { dockerExecutable: recorder.executable });

  for (const armId of ['basic-memory', 'mem0-oss']) {
    const execute = bound[PYTHON_RUNTIME_KIND](descriptorFor(armId, { containerImage: LAUNCHABLE_IMAGE }));
    const response = await execute(requestFor('retrieve', armId));
    // The stand-in exits non-zero, so every invocation ends as an
    // infrastructure failure. That is incidental here; the argv is the point.
    assert.equal(response.status, 'FAILED');
    assert.equal(response.failure.cause, 'INFRASTRUCTURE_FAILURE');
  }

  const runs = recorder.invocations().filter((argv) => argv[0] === 'run');
  assert.equal(runs.length, 2, 'both arms must have reached the container executable');

  const networkFor = (argv) => {
    const positions = argv.flatMap((value, index) => (value === '--network' ? [index] : []));
    assert.deepEqual(positions.length, 1, 'the invocation must name exactly one network mode');
    return argv[positions[0] + 1];
  };

  const [unmetered, metered] = runs;
  assert.equal(
    networkFor(unmetered),
    NETWORK_MODES.none.dockerValue,
    'basic-memory meters no request class and must be given no network at all'
  );
  assert.equal(
    networkFor(metered),
    NETWORK_MODES.host.dockerValue,
    'mem0-oss meters provider traffic to a loopback meter, which it cannot reach from its own namespace'
  );

  // Once the two things that are per-invocation by design are normalised - the
  // container's generated name and the state leaf, whose digest is derived from
  // the arm id - the network mode is the only remaining difference. If a second
  // one appeared here, "no network" would have stopped being the single
  // consequence of metering nothing, and this arm would differ from the others
  // in some way nobody declared.
  const withoutNetwork = (argv) => argv.filter((value, index) => (
    value !== '--network' && argv[index - 1] !== '--network'
  ));
  const strip = (argv) => withoutNetwork(argv)
    .map((value) => value.replace(/shadowgraph-v11-[0-9a-f]{32}/gu, '<name>'))
    .map((value) => value.replace(/source=[^,]*,target=/gu, 'source=<host>,target='))
    .map((value) => value.replace(/\/run\/shadowgraph\/state\/[0-9a-f]{64}/gu, '/run/shadowgraph/state/<leaf>'));
  assert.deepEqual(strip(unmetered), strip(metered));

  // And the invocation is the pinned one, not something a default produced.
  assert.ok(unmetered.includes(LAUNCHABLE_IMAGE), 'the digest-pinned image must be the image that is run');
  assert.ok(unmetered.includes('--read-only'), 'the container root filesystem must stay read-only');
});

test('the arms the pinned specs name are exactly the arms the registry marks python-container', async (t) => {
  // Two independent lists of the same four arms. If they ever drift, the arm
  // that fell out of one of them either has no runtime - a run that cannot
  // start - or has a runtime nothing routes to it, which is a run that starts
  // and quietly measures six arms while reporting seven.
  const registry = createV11Registry({
    competitorLock: COMPETITOR_LOCK,
    containerImage: COMPETITOR_LOCK.pythonImage
  });
  const containerArms = registry.armIds
    .filter((armId) => registry.descriptorFor(armId).kind === PYTHON_RUNTIME_KIND);

  assert.equal(containerArms.length, 4);
  assert.deepEqual([...containerArms].sort(), Object.keys(PYTHON_ADAPTER_SPECS).sort());
  assert.deepEqual(
    registry.armIds.filter((armId) => registry.descriptorFor(armId).kind !== PYTHON_RUNTIME_KIND).sort(),
    ['no-memory', 'shadowgraph-compact', 'shadowgraph-full'],
    'no local arm may be marked for the container runtime'
  );

  // The agreement has to hold on the descriptor the registry actually emits,
  // not on a descriptor this test wrote: the host reads `requestClasses` and
  // `containerImage` off it and refuses a disagreement, so feeding the real
  // ones through is what proves the two modules compose.
  if (process.platform !== 'win32') {
    const bound = await hosts(t);
    for (const armId of containerArms) {
      const descriptor = registry.descriptorFor(armId);
      assert.deepEqual(
        [...descriptor.requestClasses],
        [...PYTHON_ADAPTER_SPECS[armId].requestClasses],
        `${armId} must meter the same classes in the registry and in the adapter spec`
      );
      assert.equal(
        typeof bound[PYTHON_RUNTIME_KIND](descriptor),
        'function',
        `${armId}'s registry descriptor must be one the host accepts unchanged`
      );
    }
  }
});

// The lock's own fields, spelled out rather than read back through the module
// under test. `providerModelsFromLock` is what the host calls; asserting against
// its output would assert only that the host agrees with itself.
const LOCKED_DECISION_MODEL = MODEL_WEIGHTS.models.find((model) => model.kind === 'decision_llm');
const LOCKED_EMBEDDING_MODEL = MODEL_WEIGHTS.models.find((model) => model.kind === 'embedding');

processGroupTest('the models the lock pins are the models that reach the arm', async (t) => {
  // The defect this catches shipped green. Every test in the range checked the
  // *shape* of what the host hands the executor, and the executor validates
  // shape too - so hard-coding mem0's own defaults (gpt-5-mini,
  // text-embedding-3-small at 1536) in place of the narrowing passed 1081 JS
  // tests and 134 Python tests. The wrapper on stdin is the only place the
  // values are observable, and it is also exactly what the container reads.
  const recorder = await recordingContainerExecutable(t);
  const bound = await hosts(t, { dockerExecutable: recorder.executable });
  const execute = bound[PYTHON_RUNTIME_KIND](descriptorFor('mem0-oss', {
    containerImage: LAUNCHABLE_IMAGE
  }));

  const response = await execute(requestFor('reset', 'mem0-oss'));
  assert.equal(response.status, 'FAILED');

  const [wrapper] = recorder.requests();
  assert.notEqual(wrapper, undefined, 'the executor must write its request to the container');
  assert.deepEqual(wrapper.providerModels, {
    internal_memory_llm: {
      modelId: LOCKED_DECISION_MODEL.modelId,
      embeddingDimension: null
    },
    embedding: {
      modelId: LOCKED_EMBEDDING_MODEL.modelId,
      embeddingDimension: LOCKED_EMBEDDING_MODEL.embeddingDimension
    }
  });
  // Not a hypothetical: mem0 sizes its vector collection from this number, and
  // builds a 1536-wide one for 768-wide vectors when it is not told.
  assert.equal(wrapper.providerModels.embedding.embeddingDimension, 768);
});

processGroupTest('an arm that meters nothing is handed no model and no network', async (t) => {
  // The two halves of one decision. The arm the definition records as issuing no
  // provider call must be handed a null for every class *and* a container with
  // no network - and the module derives the second from the first, so a test
  // that checked only one of them would not see them come apart.
  const recorder = await recordingContainerExecutable(t);
  const bound = await hosts(t, { dockerExecutable: recorder.executable });
  const execute = bound[PYTHON_RUNTIME_KIND](descriptorFor('basic-memory', {
    containerImage: LAUNCHABLE_IMAGE
  }));

  await execute(requestFor('reset', 'basic-memory'));

  const [wrapper] = recorder.requests();
  assert.deepEqual(wrapper.providerModels, { internal_memory_llm: null, embedding: null });
  const [invocation] = recorder.invocations();
  assert.ok(invocation.includes('--network'), 'the launch must state a network mode');
  assert.equal(
    invocation[invocation.indexOf('--network') + 1],
    NETWORK_MODES.none.dockerValue
  );
});
