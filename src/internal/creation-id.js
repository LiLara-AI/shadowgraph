// Ordinary creation never accepts canonical identities from its caller. This
// preflight is deliberately independent of storage, ownership and retry state.
// Import/restore/replay retain their separate historical identity contract.
function refuseId(input) {
  if (input !== null && (typeof input === 'object' || typeof input === 'function') && 'id' in input) {
    const error = new Error('Caller-supplied creation IDs are not supported');
    error.code = 'creation_id_not_allowed';
    throw error;
  }
}

export function assertCreationInput(kind, input) {
  refuseId(input);
  if (kind === 'decision' && Array.isArray(input?.alternatives)) {
    for (const alternative of input.alternatives) refuseId(alternative);
  }
  if (kind === 'memoryPlan' && Array.isArray(input?.operations)) {
    // All operation IDs are unsupported, including DELETE/NOOP: their target
    // is the scoped memory identity (type/key/scope), never an entity ID.
    for (const operation of input.operations) refuseId(operation);
  }
}

const creationTools = new Map([
  ['shadowgraph_record_decision', 'decision'], ['shadowgraph_record_attempt', 'attempt'],
  ['shadowgraph_remember', 'memoryPlan'], ['shadowgraph_record_fact', 'fact'],
  ['shadowgraph_link', 'relation']
]);

export function assertToolCreationInput(name, input) {
  const kind = creationTools.get(name);
  if (kind) assertCreationInput(kind, input);
}
