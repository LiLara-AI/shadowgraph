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

// The public export is a read of one scope, not a store: it holds only what
// that scope may see, and no journal. Taken for a store it would silently
// drop every other project, so no import, replace, save or restore accepts
// one (P1 reconciliation F-01).
export const PUBLIC_EXPORT_KIND = 'public_scoped';

export function refusePublicExport(payload) {
  if (payload?.exportKind !== PUBLIC_EXPORT_KIND) return;
  const error = new Error('Refusing a public export (public_export_not_a_store): it is a read of one scope, not a store, so it cannot be imported, saved or restored');
  error.code = 'public_export_not_a_store';
  throw error;
}
