# Reprocessing reader and recovery floor

An attempt is an event. Replacing an extraction representation does not erase
the event or change its recorded outcome. A `supersedes` relation between
records from the same capture and the same project/origin identifies the old
attempt representation as historical. Both endpoints must also be visible in
the read's memory scope before either status or links are derived. Other links,
cross-owner links, hidden scoped successors, and links without the same capture
provenance do not have this meaning.

Readers derive `supersededBy`, `supersedes` and `derivationState` from these
relations. Search and recall retain historical evidence with its links;
context does not present a superseded representation as a current failure or
reuse candidate. Compact handles change when these links change, and expansion
reports the new revision. These projections do not change canonical records,
snapshots or journal replay. An as-of read does not invent when the underlying
attempt occurred.

The reprocessing reader change is the operational reader/recovery floor for
stores carrying these relations. PR-41 can preserve their bytes but ignores
their meaning in delivery and attempt reuse; it is not a supported delivery
rollback for a reprocessed store. Disabling extraction alone does not make
that rollback safe. Never reconnect an incompatible runtime to such a store.

The reader-floor worker also refuses a queued `reprocessRequest` before a model
call. Only the subsequent reprocessing writer/worker may execute it. Keep
extraction deactivated when rolling back to this reader floor. Existing
retention, deletion and authority recovery floors still apply. A rollback does
not undo a purge or retention deletion, and it does not authorize restoring old
activation bytes, deleting backups or deleting interrupted-restore recovery
files.
