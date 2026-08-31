import { validateAdapterRequest } from '../lib/adapter-protocol.mjs';
import { adapterEnvelope, emptyOperations } from '../lib/node-adapter-host.mjs';

const STORAGE = Object.freeze({
  status: 'MEASURED',
  bytes: 0,
  scope: 'no-memory control retains no product state',
  method: 'fixed control accounting: no persistence implementation exists',
  reason: null,
  blockedClaims: Object.freeze([])
});

/** Execute one v1.1 no-memory control operation without retaining any state. */
export async function execute(request, { signal } = {}) {
  validateAdapterRequest(request);
  if (request.armId !== 'no-memory') {
    return adapterEnvelope(request, {
      status: 'FAILED',
      failure: {
        cause: 'CONTRACT_FAILURE',
        message: 'No-memory adapter requires the exact no-memory arm'
      },
      operations: emptyOperations(),
      storage: { ...STORAGE, blockedClaims: [] }
    });
  }
  if (signal?.aborted) {
    return adapterEnvelope(request, {
      status: 'FAILED',
      failure: { cause: 'OPERATOR_INTERRUPTION', message: 'Adapter operation was interrupted' },
      operations: emptyOperations(),
      storage: { ...STORAGE, blockedClaims: [] }
    });
  }
  return adapterEnvelope(request, {
    status: ['persist', 'verify'].includes(request.operation) ? 'NOT_APPLICABLE' : 'SUCCEEDED',
    operations: emptyOperations(),
    storage: { ...STORAGE, blockedClaims: [] }
  });
}

export default { execute };
