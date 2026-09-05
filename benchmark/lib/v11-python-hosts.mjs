// Runtime hosts for the four arms that execute inside the pinned Python image.
//
// `createV11AdapterExecutor` routes each arm to `hosts[descriptor.kind]`. Two
// kinds were bound - `control` and `node-mcp`, in `v11-node-hosts.mjs` - and the
// third, `python-container`, had no binding at all. Without it a preflight could
// report READY and four of the seven arms still had nowhere to run.
//
// This is the same small, refusing binding as its sibling, with one thing that
// is genuinely different and load-bearing.
//
// **The two host kinds report failure in opposite directions.** A node adapter
// returns a FAILED envelope carrying its cause. The Python executor *throws* a
// `PythonAdapterExecutorError`, and the cause lives on `.adapterCause`, which
// the runner's `thrownFailure` does not read - it walks `error.cause` chains and
// error codes, finds nothing it recognises, and records `CONTRACT_FAILURE`. So
// an adapter that timed out, or that was interrupted by an operator, would be
// written into the run record as a contract failure of the benchmark's own
// making. Every one of those four causes is already a member of
// `ADAPTER_FAILURE_CAUSES`; they simply have to be carried across the boundary
// rather than dropped at it. That translation is this module's real work.
//
// The network mode is decided per arm rather than set once. An arm the
// definition records as making no provider call is given a container with no
// network at all, so the claim is enforced by the runtime instead of being
// checked after the fact.

import path from 'node:path';

import { adapterEnvelope, emptyOperations } from './node-adapter-host.mjs';
import { DIGEST_PINNED_IMAGE } from './python-container-runtime.mjs';
import {
  PYTHON_ADAPTER_SPECS,
  createPythonAdapterExecutor
} from './python-adapter-executor.mjs';
import { providerModelsFromLock } from './v11-provider-models.mjs';

/** The runtime kind this module binds. */
export const PYTHON_RUNTIME_KIND = 'python-container';

export class PythonHostError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PythonHostError';
  }
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

/**
 * The storage a unit has when its adapter never got far enough to measure one.
 *
 * Stated here rather than borrowed, because it means something specific: not
 * "this arm cannot attribute bytes" - which is a standing property of the arms
 * with shared stores - but "this particular invocation failed before any byte
 * scope existed".
 */
function unmeasuredStorage() {
  return {
    status: 'NOT_AVAILABLE',
    bytes: null,
    scope: 'pinned Python adapter state leaf',
    method: null,
    reason: 'the adapter failed before a byte scope could be measured',
    blockedClaims: ['storage bytes']
  };
}

/**
 * Bind the pinned Python container runtime to the four arms that use it.
 *
 * `stateRoot` must be separate from the node arms' root. The Python executor
 * adopts its root by writing an ownership marker and refuses a non-empty root
 * that does not carry one, while the node adapters write no marker - so sharing
 * one root makes whichever runs second refuse.
 *
 * `runtimeRoot` is the *site* directory the wheel lock was installed into, not
 * the directory it was installed under. It is mounted read-only and named by
 * PYTHONPATH; pointing it one level too high yields an importable-looking mount
 * with nothing on the path, and every Python arm fails at import for a reason
 * that looks like a packaging problem.
 */
export function createV11PythonHosts(options = {}) {
  const {
    stateRoot,
    runtimeRoot,
    providerEndpointFor,
    modelWeights,
    timeoutMs,
    dockerExecutable
  } = options;

  if (!isNonEmptyString(stateRoot) || !path.isAbsolute(stateRoot)) {
    throw new PythonHostError('a mandatory absolute Python adapter state root is required');
  }
  const resolvedStateRoot = path.resolve(stateRoot);
  if (resolvedStateRoot === path.parse(resolvedStateRoot).root) {
    throw new PythonHostError('the Python adapter state root must not be a filesystem root');
  }
  if (!isNonEmptyString(runtimeRoot) || !path.isAbsolute(runtimeRoot)) {
    throw new PythonHostError('a mandatory absolute pinned Python runtime site is required');
  }
  if (typeof providerEndpointFor !== 'function') {
    throw new PythonHostError('the Python runtime requires a metered provider endpoint source');
  }
  if (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new PythonHostError('the adapter timeout must be a positive integer of milliseconds');
  }
  if (dockerExecutable !== undefined && !isNonEmptyString(dockerExecutable)) {
    throw new PythonHostError('the container executable must be a non-empty string');
  }
  // Read here rather than when the first metered arm is bound. Left until then,
  // a missing or malformed model-weight lock binds cleanly, lets the one arm
  // that meters nothing through, and fails three times in the middle of a run
  // as an error type the caller was not guarding for.
  let pinnedModels;
  try {
    pinnedModels = providerModelsFromLock(modelWeights);
  } catch (error) {
    throw new PythonHostError(`the pinned model weights are unusable: ${error.message}`);
  }

  function pythonHost(descriptor) {
    if (descriptor === null || typeof descriptor !== 'object' || !isNonEmptyString(descriptor.armId)) {
      throw new PythonHostError('a runtime host requires an arm descriptor');
    }
    const { armId } = descriptor;
    const spec = Object.hasOwn(PYTHON_ADAPTER_SPECS, armId) ? PYTHON_ADAPTER_SPECS[armId] : undefined;
    if (spec === undefined) {
      throw new PythonHostError(`the pinned Python runtime executes no arm named ${armId}`);
    }
    // The same rule the launch path applies. Checking a weaker one here meant a
    // mis-pinned image was refused per invocation, as a failure of the arm,
    // instead of at binding, where it is still recognisable as a configuration
    // error.
    if (!isNonEmptyString(descriptor.containerImage) || !DIGEST_PINNED_IMAGE.test(descriptor.containerImage)) {
      throw new PythonHostError(
        `arm ${armId} must be bound to a digest-pinned container image, not ${JSON.stringify(descriptor.containerImage ?? null)}`
      );
    }
    // The registry and the executor each carry this arm's metered request
    // classes. A disagreement is a registry defect, and resolving it here by
    // preferring one side would hide it - and would decide, silently, whether
    // this arm gets a network.
    const declared = [...(descriptor.requestClasses ?? [])];
    const expected = [...spec.requestClasses];
    if (declared.length !== expected.length || declared.some((value, index) => value !== expected[index])) {
      throw new PythonHostError(
        `arm ${armId} disagrees about its metered request classes: the registry says ${JSON.stringify(declared)} and the adapter spec says ${JSON.stringify(expected)}`
      );
    }

    const metered = expected.length > 0;
    const executor = createPythonAdapterExecutor({
      adapterId: armId,
      armId,
      stateRoot: resolvedStateRoot,
      providerEndpointFor,
      providerModels: Object.fromEntries(
        Object.keys(pinnedModels).map((requestClass) => [
          requestClass,
          expected.includes(requestClass) ? pinnedModels[requestClass] : null
        ])
      ),
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
      container: {
        image: descriptor.containerImage,
        runtimeRoot,
        // An arm with no metered request class has nothing to reach. Giving it
        // no network makes "this arm issues no provider call" a property of the
        // container rather than a claim checked afterwards.
        networkMode: metered ? 'host' : 'none',
        ...(dockerExecutable === undefined ? {} : { dockerExecutable })
      }
    });

    return async function execute(request, executeOptions) {
      try {
        return await executor.execute(request, executeOptions);
      } catch (error) {
        // Only this executor's own failures are translated. Anything else is a
        // fault in the harness rather than in the arm, and flattening it into a
        // unit failure would attribute the harness's bug to the product.
        if (error?.name !== 'PythonAdapterExecutorError' || !isNonEmptyString(error.adapterCause)) {
          throw error;
        }
        return adapterEnvelope(request, {
          status: 'FAILED',
          result: { nativeContext: [], persistenceEvidence: null, isolationEvidence: null },
          failure: {
            cause: error.adapterCause,
            message: 'Pinned Python adapter operation failed'
          },
          operations: emptyOperations(),
          storage: unmeasuredStorage()
        });
      }
    };
  }

  return Object.freeze({ [PYTHON_RUNTIME_KIND]: pythonHost });
}
