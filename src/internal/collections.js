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

// The public export and a redaction are reads of one scope, not stores: they
// hold only what that scope may see. Taken for a store either would silently
// drop every other project, so each says what it is in `exportKind`, and no
// import, replace, save or restore accepts a payload that declares any kind
// (P1 reconciliation F-01, finding F-36). A store never carries the key.
export const PUBLIC_EXPORT_KIND = 'public_scoped';
export const REDACTION_EXPORT_KIND = 'scoped_redaction';

export function refusePublicExport(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.exportKind === undefined) return;
  const error = new Error(`Refusing a public export (public_export_not_a_store): ${JSON.stringify(payload.exportKind)} is a read of one scope, not a store, so it cannot be imported, saved or restored`);
  error.code = 'public_export_not_a_store';
  throw error;
}
