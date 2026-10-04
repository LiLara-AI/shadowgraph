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

## Explicit requests and replacement

`shadowgraph extract --status --project <project>` inspects the pinned capture
store without saving or invoking extraction. Use `--origin` for unattributed
captures. Recipe differences in prompt version, schema version or model are
reported as `reprocessReasons`; they never enqueue work. Raw expiry makes
reprocessing unavailable even if cited raw remains for audit.

`shadowgraph extract --reprocess <captureId> --project <project>` displays the
exact store, owner scope and item metadata and requires terminal confirmation.
It queues a request; it does not activate extraction or invoke the model. There
is no MCP or HTTP request route. The request preserves existing records,
receipts and attempt counts, clears the old lease, and advances generation at
the fenced commit. A late result from the earlier generation cannot commit.
Failed or blocked reprocessing can be explicitly requested again; cancellation
and raw expiry still refuse. Budgets and prior usage are never refunded.

The worker requires the explicit request's journal witness. It compares each
previously produced record with its canonical witness at the extraction that
first produced it. A later no-op or skipped run cannot adopt an owner's edit.
For an unchanged decision reused during a merge, the writer records a bounded
linkage witness in its reprocessing receipt: journal IDs and before/after
canonical-record hashes. Only a matching decision supersession entry may advance that
witness, and only history links and their update time may differ. Arbitrary
later snapshots and owner edits never become extraction-owned through this
mechanism. Inspection does not expose these internal receipt members.
Changed, missing, future or insufficiently witnessed records are protected;
proposals overlapping their original claims are skipped. If that evidence is
unavailable, proposals are skipped conservatively. These protections apply
even when an owner correction and extraction have the same timestamp.

A supported replacement is the next representation of the capture. It can
split, merge or change kind. Unchanged representations retain their IDs and
provenance; replaced records remain linked historical evidence. Unchanged
identities and their memory keys are reserved before changed output is written,
so proposal order cannot retire an identity the output explicitly retains.
Memory and decision replacements use their existing lifecycle journal shapes; attempt
history uses `supersedes` relations. Empty supported output preserves prior
canonical evidence and does not erase it. Protected owner corrections remain.
Inspection reports `lastReprocessing` counts and `retainedPriorEvidence`, so a
completed invocation is not presented as proof that every record was replaced.

Markdown push refreshes previously tracked corrected or invalidated memories,
while protecting edited files. Pull cannot revive a non-active tracked memory.
Review-signal reads identify superseded/archived decision history without
rewriting review evidence or acknowledgement. The private miss ledger remains
historical diagnostic data; it is never used to resurrect a current claim.
