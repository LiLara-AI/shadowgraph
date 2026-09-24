// The top-level store keys this build handles natively, shared by the kernel
// and the SQLite backend so the two cannot drift (plan v1.4.4 §10.9.8).
//
// Any other top-level collection is one this build does not understand -- a
// newer build's collection, or the authority collections before their
// semantics exist. It is carried through load and save byte for byte rather
// than dropped, because a rollback target that deletes what it does not
// understand is a data-loss path, not a rollback target (§9.2, axis A-5).
export const NATIVE_STORE_KEYS = Object.freeze([
  'schemaVersion', 'revision', 'records', 'facts', 'relations', 'reviewSignals',
  'idempotency', 'events', 'journal', 'journalSeq', 'journalEpoch'
]);

// `expectedRevision` is a save-time instruction, never stored data.
const CONTROL_KEYS = new Set(['expectedRevision']);

export function isExtraCollectionKey(key) {
  return !NATIVE_STORE_KEYS.includes(key) && !CONTROL_KEYS.has(key);
}

// [key, value] pairs of the collections a payload carries beyond the native
// set, in payload order.
export function extraCollections(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return [];
  return Object.entries(payload).filter(([key, value]) => isExtraCollectionKey(key) && value !== undefined);
}
