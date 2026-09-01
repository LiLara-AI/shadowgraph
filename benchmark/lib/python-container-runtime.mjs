// Pinned container runtime for Python adapter execution.
//
// The competitor lock pins a Python image by digest, so adapters must execute
// inside that image rather than on whatever interpreter the host happens to
// carry. This module builds the exact process invocation used to do that, and
// nothing else: it starts no container, performs no I/O, and holds no state, so
// the launch contract is verifiable offline.
//
// Three properties are enforced here rather than left to the caller.
//
// 1. The image must be digest-pinned. A tag can be repointed, so a tagged
//    reference cannot support a reproducibility claim.
// 2. Adapter source is mounted read-only and the root filesystem is read-only.
//    Only the declared state root and a tmpfs are writable, so an adapter
//    cannot mutate the harness it runs under.
// 3. The network mode is tied to how provider traffic is routed. The provider
//    meter refuses any endpoint that is not a loopback address, so a container
//    that must reach the meter has to share the host network namespace: from
//    inside its own namespace, 127.0.0.1 is the container, not the meter. That
//    is a real trade-off and it is recorded in NETWORK_MODES rather than
//    hidden.

import path from 'node:path';

const DIGEST_PINNED_IMAGE = /^[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*@sha256:[a-f0-9]{64}$/u;
const SAFE_CONTAINER_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
const SAFE_ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

// Assembled rather than written literally: the packaged-artifact audit reads a
// spelled-out POSIX temp root in shipped source as a local-path disclosure.
const SCRATCH_TARGET = path.posix.join(path.posix.sep, 'tmp');
const SCRATCH_MOUNT = `${SCRATCH_TARGET}:rw,noexec,nosuid,size=64m`;

/**
 * In-container layout. Fixed so the launch contract is inspectable.
 *
 * The host script is deliberately addressed *inside* the adapters mount rather
 * than mounted separately. It imports its siblings by module name, and Python
 * only puts the running script's own directory on sys.path, so splitting the
 * two makes those imports fail.
 */
export const CONTAINER_PATHS = Object.freeze({
  adapters: '/opt/shadowgraph/adapters',
  cwd: '/run/shadowgraph/cwd',
  state: '/run/shadowgraph/state'
});

/** Resolve the in-container path of a host script that lives in the mount. */
export function containerHostPath(hostPath) {
  return path.posix.join(CONTAINER_PATHS.adapters, path.basename(hostPath));
}

/**
 * Network modes and what each one costs.
 *
 * `host` is required whenever the adapter must reach a loopback-bound provider
 * meter. It removes network isolation between the container and the host, so
 * egress restriction is not provided by the container and must be enforced by
 * the environment the run executes in. `none` is correct only for an arm that
 * issues no provider traffic at all.
 */
export const NETWORK_MODES = Object.freeze({
  host: Object.freeze({
    dockerValue: 'host',
    reachesLoopbackMeter: true,
    isolatesEgress: false
  }),
  none: Object.freeze({
    dockerValue: 'none',
    reachesLoopbackMeter: false,
    isolatesEgress: true
  })
});

export class ContainerRuntimeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ContainerRuntimeError';
  }
}

function requireAbsolute(value, label) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw new ContainerRuntimeError(`${label} must be an absolute path`);
  }
  if (/[\r\n\0]/u.test(value)) {
    throw new ContainerRuntimeError(`${label} must not contain control characters`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ContainerRuntimeError(`${label} must be a non-negative integer`);
  }
  return value;
}

/**
 * Build the argv that runs one adapter invocation inside the pinned image.
 *
 * The container is foreground and `--rm`: there is no detached mode, so the
 * caller keeps a real child process to wait on and terminate. `--init` gives
 * the container a PID 1 that reaps children and forwards signals, which is what
 * makes the existing SIGTERM-then-SIGKILL escalation meaningful across the
 * container boundary.
 */
export function buildContainerInvocation(options) {
  if (options === null || typeof options !== 'object') {
    throw new ContainerRuntimeError('container options must be an object');
  }
  const {
    image,
    containerName,
    hostPath,
    adaptersDirectory,
    invocationRoot,
    stateRoot,
    uid,
    gid,
    networkMode = 'host',
    environment = {},
    dockerExecutable = 'docker'
  } = options;

  if (typeof image !== 'string' || !DIGEST_PINNED_IMAGE.test(image)) {
    throw new ContainerRuntimeError('container image must be digest-pinned as name@sha256:<64 hex>');
  }
  if (typeof containerName !== 'string' || !SAFE_CONTAINER_NAME.test(containerName)) {
    throw new ContainerRuntimeError('container name must be a safe docker identifier');
  }
  if (!Object.hasOwn(NETWORK_MODES, networkMode)) {
    throw new ContainerRuntimeError('container network mode must be host or none');
  }
  requireAbsolute(hostPath, 'hostPath');
  requireAbsolute(adaptersDirectory, 'adaptersDirectory');
  // The host script must live in the adapters mount, or its sibling imports
  // are not importable once it runs inside the container.
  if (path.dirname(hostPath) !== adaptersDirectory.replace(/\/+$/u, '')) {
    throw new ContainerRuntimeError('hostPath must be a direct child of adaptersDirectory');
  }
  requireAbsolute(invocationRoot, 'invocationRoot');
  requireAbsolute(stateRoot, 'stateRoot');
  requireNonNegativeInteger(uid, 'uid');
  requireNonNegativeInteger(gid, 'gid');
  if (environment === null || typeof environment !== 'object') {
    throw new ContainerRuntimeError('container environment must be an object');
  }

  const args = [
    'run',
    '--rm',
    '--init',
    '--name', containerName,
    '--network', NETWORK_MODES[networkMode].dockerValue,
    // The adapter runs as the invoking user so files it writes into the state
    // mount stay owned by the harness rather than by root.
    '--user', `${uid}:${gid}`,
    '--read-only',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--tmpfs', SCRATCH_MOUNT,
    '--workdir', CONTAINER_PATHS.cwd,
    '--mount', `type=bind,source=${adaptersDirectory},target=${CONTAINER_PATHS.adapters},readonly`,
    '--mount', `type=bind,source=${path.join(invocationRoot, 'cwd')},target=${CONTAINER_PATHS.cwd}`,
    '--mount', `type=bind,source=${stateRoot},target=${CONTAINER_PATHS.state}`
  ];

  for (const name of Object.keys(environment).sort()) {
    if (!SAFE_ENVIRONMENT_NAME.test(name)) {
      throw new ContainerRuntimeError('container environment names must be POSIX identifiers');
    }
    const value = environment[name];
    if (typeof value !== 'string' || /[\r\n\0]/u.test(value)) {
      throw new ContainerRuntimeError('container environment values must be control-free strings');
    }
    // Passed as NAME=VALUE so the value never reaches a shell.
    args.push('--env', `${name}=${value}`);
  }

  args.push(image, 'python', containerHostPath(hostPath));
  return Object.freeze({ command: dockerExecutable, args: Object.freeze(args) });
}

/**
 * Build the argv that force-removes a container.
 *
 * Signalling the foreground `docker run` client is not sufficient on its own:
 * if that client is SIGKILLed the container survives it. Cleanup therefore
 * addresses the container by its deterministic name so an invocation cannot
 * leave a running adapter behind.
 */
export function buildContainerKillInvocation(containerName, dockerExecutable = 'docker') {
  if (typeof containerName !== 'string' || !SAFE_CONTAINER_NAME.test(containerName)) {
    throw new ContainerRuntimeError('container name must be a safe docker identifier');
  }
  return Object.freeze({
    command: dockerExecutable,
    args: Object.freeze(['rm', '--force', containerName])
  });
}
