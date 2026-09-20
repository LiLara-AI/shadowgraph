import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  CONTAINER_PATHS,
  ContainerRuntimeError,
  NETWORK_MODES,
  buildContainerInvocation,
  buildContainerKillInvocation,
  containerHostPath
} from '../benchmark/lib/python-container-runtime.mjs';

const PINNED_IMAGE = 'python@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f';

function options(overrides = {}) {
  return {
    image: PINNED_IMAGE,
    containerName: 'shadowgraph-v11-adapter-0001',
    hostPath: '/repo/benchmark/adapters/python_host.py',
    adaptersDirectory: '/repo/benchmark/adapters',
    invocationRoot: '/state/invocation',
    stateRoot: '/state/persistent',
    uid: 1000,
    gid: 1000,
    ...overrides
  };
}

function flagValues(args, flag) {
  const values = [];
  for (let index = 0; index < args.length - 1; index += 1) {
    if (args[index] === flag) values.push(args[index + 1]);
  }
  return values;
}

test('the invocation runs the pinned image in the foreground and removes itself', () => {
  const { command, args } = buildContainerInvocation(options());
  assert.equal(command, 'docker');
  assert.equal(args[0], 'run');
  assert.ok(args.includes('--rm'), 'container must not outlive the invocation');
  assert.ok(args.includes('--init'), 'PID 1 must reap children and forward signals');
  assert.equal(args.includes('-d'), false, 'detached mode would break process supervision');
  assert.equal(args.includes('--detach'), false);

  // The image and entrypoint are the final positional arguments, so no later
  // flag can be smuggled past them.
  assert.deepEqual(args.slice(-3), [
    PINNED_IMAGE,
    'python',
    containerHostPath('/repo/benchmark/adapters/python_host.py')
  ]);
});

test('the host script is addressed inside the adapters mount so sibling imports resolve', () => {
  // Mounting the host script at its own path put it outside the adapters
  // directory. Python only adds the running script's directory to sys.path, so
  // the script then failed with ModuleNotFoundError on its own siblings.
  assert.equal(
    containerHostPath('/repo/benchmark/adapters/python_host.py'),
    `${CONTAINER_PATHS.adapters}/python_host.py`
  );

  const { args } = buildContainerInvocation(options());
  const mounts = flagValues(args, '--mount');
  assert.equal(
    mounts.filter((mount) => mount.includes('python_host.py')).length,
    0,
    'the host script must not carry a second mount of its own'
  );

  assert.throws(
    () => buildContainerInvocation(options({ hostPath: '/elsewhere/python_host.py' })),
    ContainerRuntimeError,
    'a host script outside the adapters mount must be refused'
  );
});

test('only a digest-pinned image is accepted', () => {
  for (const image of [
    'python:3.12.11-slim',
    'python',
    'python@sha256:tooshort',
    'python@md5:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f',
    ''
  ]) {
    assert.throws(
      () => buildContainerInvocation(options({ image })),
      ContainerRuntimeError,
      `tagged or malformed reference accepted: ${image}`
    );
  }
  assert.doesNotThrow(() => buildContainerInvocation(options()));
});

test('adapter source is read-only and only declared state is writable', () => {
  const { args } = buildContainerInvocation(options());
  assert.ok(args.includes('--read-only'), 'container root filesystem must be read-only');

  const mounts = flagValues(args, '--mount');
  const readonly = mounts.filter((mount) => mount.endsWith(',readonly'));
  const writable = mounts.filter((mount) => !mount.endsWith(',readonly'));

  assert.deepEqual(readonly, [
    `type=bind,source=/repo/benchmark/adapters,target=${CONTAINER_PATHS.adapters},readonly`
  ]);

  // Exactly two writable surfaces: the invocation cwd and the state root.
  assert.equal(writable.length, 2);
  assert.ok(writable.some((mount) => mount.endsWith(`target=${CONTAINER_PATHS.state}`)));
  assert.ok(writable.some((mount) => mount.endsWith(`target=${CONTAINER_PATHS.cwd}`)));

  const tmpfs = flagValues(args, '--tmpfs');
  assert.equal(tmpfs.length, 1);
  assert.match(tmpfs[0], /^\/tmp:rw,noexec,nosuid,size=\d+m$/u);
});

test('the adapter runs as the invoking user and drops privileges', () => {
  const { args } = buildContainerInvocation(options({ uid: 1001, gid: 1002 }));
  assert.deepEqual(flagValues(args, '--user'), ['1001:1002']);
  assert.deepEqual(flagValues(args, '--cap-drop'), ['ALL']);
  assert.deepEqual(flagValues(args, '--security-opt'), ['no-new-privileges']);
});

test('network mode records whether the loopback meter is reachable', () => {
  // The provider meter rejects any non-loopback endpoint, so an adapter that
  // must reach it has to share the host network namespace. That removes egress
  // isolation, and the trade-off is declared rather than implied.
  assert.equal(NETWORK_MODES.host.reachesLoopbackMeter, true);
  assert.equal(NETWORK_MODES.host.isolatesEgress, false);
  assert.equal(NETWORK_MODES.none.reachesLoopbackMeter, false);
  assert.equal(NETWORK_MODES.none.isolatesEgress, true);

  assert.deepEqual(flagValues(buildContainerInvocation(options()).args, '--network'), ['host']);
  assert.deepEqual(
    flagValues(buildContainerInvocation(options({ networkMode: 'none' })).args, '--network'),
    ['none']
  );
  assert.throws(
    () => buildContainerInvocation(options({ networkMode: 'bridge' })),
    ContainerRuntimeError
  );
});

test('environment is passed as argv pairs, ordered, and never through a shell', () => {
  const { args } = buildContainerInvocation(options({
    environment: { ZULU: 'last', ALPHA: 'first', SHADOWGRAPH_STATE: '/run/shadowgraph/state' }
  }));
  assert.deepEqual(flagValues(args, '--env'), [
    'ALPHA=first',
    'SHADOWGRAPH_STATE=/run/shadowgraph/state',
    'ZULU=last'
  ]);

  for (const environment of [
    { 'bad name': 'value' },
    { GOOD: 'line\nbreak' },
    { GOOD: 'nul\u0000byte' },
    { GOOD: 42 }
  ]) {
    assert.throws(
      () => buildContainerInvocation(options({ environment })),
      ContainerRuntimeError
    );
  }
});

test('paths must be absolute and control-free', () => {
  for (const field of ['hostPath', 'adaptersDirectory', 'invocationRoot', 'stateRoot']) {
    assert.throws(
      () => buildContainerInvocation(options({ [field]: 'relative/path' })),
      ContainerRuntimeError,
      field
    );
    assert.throws(
      () => buildContainerInvocation(options({ [field]: '/injected\nflag' })),
      ContainerRuntimeError,
      field
    );
  }
});

test('a container is removed by name so a killed client cannot orphan it', () => {
  // Signalling the foreground docker client is not enough: if that client is
  // SIGKILLed the container survives, so cleanup addresses the container
  // itself by its deterministic name.
  const { command, args } = buildContainerKillInvocation('shadowgraph-v11-adapter-0001');
  assert.equal(command, 'docker');
  assert.deepEqual(args, ['rm', '--force', 'shadowgraph-v11-adapter-0001']);

  for (const name of ['', '-leading-dash', 'has space', 'a'.repeat(129)]) {
    assert.throws(() => buildContainerKillInvocation(name), ContainerRuntimeError, name);
  }
});

test('the launch contract is frozen against accidental mutation', () => {
  const invocation = buildContainerInvocation(options());
  assert.ok(Object.isFrozen(invocation));
  assert.ok(Object.isFrozen(invocation.args));
  assert.ok(Object.isFrozen(NETWORK_MODES));
  assert.ok(Object.isFrozen(CONTAINER_PATHS));
});

test('the pinned wheel runtime is mounted read-only, and only when one is supplied', () => {
  // The pinned image is a bare interpreter. Without this mount every Python arm
  // fails at import, and with it writable the arm could rewrite the packages it
  // is being measured on.
  const withoutRuntime = buildContainerInvocation(options());
  assert.ok(
    !withoutRuntime.args.some((argument) => argument.includes(CONTAINER_PATHS.runtime)),
    'no runtime mount unless one is supplied'
  );

  const { args } = buildContainerInvocation(options({ runtimeRoot: '/srv/shadowgraph/runtime' }));
  assert.ok(args.includes(
    `type=bind,source=/srv/shadowgraph/runtime,target=${CONTAINER_PATHS.runtime},readonly`
  ));
});

test('a relative or control-bearing runtime root is refused', () => {
  for (const runtimeRoot of ['relative/runtime', '/injected\nflag', '']) {
    assert.throws(
      () => buildContainerInvocation(options({ runtimeRoot })),
      ContainerRuntimeError,
      `${JSON.stringify(runtimeRoot)} must be refused`
    );
  }
});

test('the container is given stdin, because the adapter protocol arrives on it', () => {
  // Regression: the invocation was written before anything called it, and
  // omitted --interactive. Every real invocation then failed with the host
  // script reading EOF, which surfaces as an adapter fault rather than as the
  // launch defect it is.
  const { args } = buildContainerInvocation(options());
  assert.ok(args.includes('--interactive'), 'stdin must be attached');
  assert.ok(!args.includes('--tty') && !args.includes('-t'), 'a TTY would corrupt the protocol stream');
  assert.ok(args.indexOf('--interactive') < args.indexOf(PINNED_IMAGE), 'flags precede the image');
});


test('the image the competitor lock pins is one this runtime can launch', async () => {
  // The regression test for a defect that survived because the two halves were
  // only ever tested apart. `competitors.lock.json` pins
  // `python:3.12.11-slim@sha256:...`; DIGEST_PINNED_IMAGE forbade the tag; and
  // every case above uses a tagless image, so this runtime and the only image
  // the benchmark has had never met. On a real run all four container arms
  // would have failed at launch, and - because the refusal becomes a
  // PythonAdapterExecutorError that the host binding faithfully translates -
  // been recorded as contract failures of the products.
  //
  // Note what the list above did and did not say: `python:3.12.11-slim` is
  // there, correctly, as a tag with no digest. `tag@digest` was in neither
  // column. It was refused by an accident of the pattern that nothing asserted.
  //
  // Asserting against the lock rather than a literal is the point: a reference
  // format this runtime cannot launch is a defect whichever side changes.
  const lock = JSON.parse(await readFile(
    fileURLToPath(new URL('../benchmark/competitors.lock.json', import.meta.url)),
    'utf8'
  ));
  assert.match(lock.pythonImage, /@sha256:[a-f0-9]{64}$/u, 'the lock must pin by digest');
  const { args } = buildContainerInvocation(options({ image: lock.pythonImage }));
  // The whole reference reaches docker, tag included, exactly as the lock
  // spells it - nothing strips the tag on the way through.
  assert.ok(args.includes(lock.pythonImage));
});

test('permitting the tag did not permit a moving reference', () => {
  // A tag alone names whatever it points at today, which is the thing a lock
  // exists to prevent. The digest still has to be there.
  assert.throws(
    () => buildContainerInvocation(options({ image: 'python:3.12.11-slim' })),
    ContainerRuntimeError
  );
  assert.doesNotThrow(() => buildContainerInvocation(options({
    image: `python:3.12.11-slim@sha256:${'a'.repeat(64)}`
  })));
});
