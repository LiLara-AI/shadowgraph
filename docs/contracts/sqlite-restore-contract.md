# SQLite Restore Contract

**Status:** accepted for the v0.32 hardening branch
**Scope:** `createSqliteStore().restore()` and the HTTP restore path
**Runtime:** Node 22.5+ with `node:sqlite`; JSON remains the supported Node 20 fallback

## Decision

ShadowGraph uses **backup-and-rollback** for SQLite restore.

Two designs were evaluated:

1. **Backup-and-rollback — selected.** Keep the configured database path and current storage interface. Before replacing it, create and verify a complete standalone snapshot of the live database. Keep that snapshot until the replacement has opened, prepared, loaded, and passed domain validation. A caught failure after replacement restores and verifies the old payload before returning an error.
2. **Active pointer/manifest — not selected for this hardening change.** Versioned database files plus an atomically switched manifest can make activation and crash recovery stronger, but every opener must resolve the pointer, existing fixed-path deployments need migration, backup/restore paths change, and orphan/version cleanup becomes a new subsystem. That is a larger storage-contract redesign, not a focused repair.

The selected design is the smallest compatible change that closes the proven post-replacement failure window. It does not claim the crash guarantees of a pointer design.

## Restore sequence

0. Acquire the configured destination's cross-handle/process fence. SQLite create, load, save, backup, and restore all use that fence and open the configured path only for the duration of the operation. Each operation closes its handle before releasing the fence, so no idle handle can retain the destination or its WAL/SHM sidecars across replacement.
1. Require a regular source file and open it read-only.
2. Load and domain-validate the source payload, including its non-negative safe-integer revision. A missing legacy revision has high-water mark `0`.
3. Read the current destination revision while the fence is still held and compute the installed concurrency token as `max(destinationRevision, sourceRevision) + 1`. Reject with `revision_overflow` before replacement when no greater safe integer exists.
4. Run `VACUUM INTO` from the source into a staged standalone database, write only the staged copy's revision metadata to the fresh token, and leave the source backup bytes unchanged.
5. Close the restore-owned source handle in a `finally` path.
6. Open, load, and domain-validate the staged snapshot with the fresh revision.
7. Run `VACUUM INTO` from the live handle into a rollback snapshot; open and read it before continuing.
8. Close the live handle.
9. Remove stale live sidecars, move the old main file aside, and rename the staged snapshot into the configured path.
10. Open the replacement with `DatabaseSync`, run schema preparation, load its payload, and domain-validate it.
11. Only after step 10 succeeds, activate that exact replacement payload in memory and remove rollback/displacement artifacts.

The source, staged snapshot, and installed replacement are all validated. Restore means semantic content restoration, not source-token reuse: records, facts, relations, review signals, idempotency, events, journal entries, journal sequence, and journal epoch retain source semantics, while the installed revision is a new concurrency token strictly above both source and destination high-water marks. The active graph and every fresh reopen expose the same installed token. This prevents ABA: a payload retained before restore remains stale, raises `RevisionConflictError`, and cannot erase a legitimate post-restore write. A same-path restore remains unchanged and does not mint a token.

The shared domain validator is mandatory for direct JavaScript, HTTP, CLI, and MCP SQLite restores and rejects malformed imports plus both `error` and `unsupported` findings. It also rejects corrupt skipped journal entries and compares the rebuilt records/facts/relations/idempotency projection with the imported live state. Every sequence gap must be enumerated by a surviving hard-purge marker's `removedJournalSequences` ledger; an unrelated or empty marker cannot authorize the gap. Documented legacy entries remain accepted when their state/journal relationship is verifiable. A direct JavaScript caller may supply an additional verifier-aware validator, but cannot disable the built-in one.

## WAL, SHM, and rollback state

A byte copy of a WAL-mode main file is not a complete backup. Both source staging and live rollback therefore use SQLite `VACUUM INTO` while their database handles are open. The output is a standalone database containing the committed state visible to that connection, including committed changes that were still represented by WAL.

The rollback snapshot—not the displaced main file plus sidecars—is the authoritative old state. The final in-process live connection is closed before replacement, and stale `-wal`, `-shm`, and `-journal` files are not paired with a different main file. Restore/recovery cleanup treats those sidecars as part of every temporary artifact.

## Failure recovery

For a caught failure after the live handle closes:

- close any replacement, staging, source, or recovery handle that was opened;
- if the unchanged old main file may still be present, require a regular file and inspect/compare it read-only before any write-capable open; only then reopen, prepare, load, and compare it again with the verified rollback payload; this inspection cannot create an empty destination;
- otherwise copy the rollback snapshot to a separate recovery path while preserving the original rollback artifact;
- open and load the recovery copy before installing it;
- replace the failed destination with the recovery copy;
- reopen the restored live database, run preparation, load it, and compare it with the verified old payload;
- remove temporary, rollback, displacement, recovery, and associated sidecar files after confirmation.

A confirmed recovery rejects the restore with code `sqlite_restore_rolled_back`. If any recovery operation fails, restore rejects with `sqlite_restore_recovery_unconfirmed`, includes the original and recovery causes, and inventories the restore files that actually exist (`retainedArtifacts` plus named staged/rollback/displaced/recovery paths). If artifact inspection itself fails, `unknownArtifacts` names the paths whose existence could not be confirmed. It does **not** claim that the live database is usable. The HTTP server latches this condition as degraded: every authenticated non-health route request returns `503`, health reports `ok: false`, and restart/manual artifact recovery is required before serving or mutating graph state.

Ordinary successful restore and confirmed rollback leave no restore artifacts. If cleanup itself fails, the implementation re-inspects the artifact family and reports `retainedArtifacts` only when a file still exists or its existence cannot be confirmed; a delete-that-then-throws does not create a false retained-artifact report. Cleanup failure is never silently swallowed.

## Server serialization

The HTTP server places restore on the same persistence queue as ordinary writes. It sets a restore guard synchronously before enqueueing the operation, waits for already-queued persistence to finish, and rejects later mutating requests—including `/context`, which can generate review signals—before they touch the in-memory graph. Reads that are actually side-effect-free remain available from the existing graph. The guard is released after success or failure. This prevents an HTTP operation from mutating the graph and then failing at the store boundary while restore owns the database. A filesystem destination fence extends serialization to independent store handles and child processes: a waiting reader/writer opens the live path only after restore releases the fence, and a save is revision-checked against that restored state or receives an explicit revision/lock failure.

## Guarantee boundaries

| Property | Guarantee |
| --- | --- |
| Source/replacement validation atomicity | **Yes.** Invalid or unsupported payloads are rejected before commit. |
| Process-level rollback safety | **Yes for caught failures** covered by the restore state machine, including rename, replacement `DatabaseSync`, preparation, load, and validation failures. A successful recovery is reopened and payload-compared. |
| In-memory graph consistency | **Yes for the server path.** Activation receives the already-installed payload, including its fresh revision; a fresh durable reopen exposes the same value. A rolled-back error reloads the exact old destination revision. |
| Crash consistency | **Not guaranteed.** A process/OS crash between filesystem operations may require manual use of a retained `.rollback` or `.old` artifact. Startup does not yet auto-discover artifacts. |
| Filesystem/power-loss durability | **Not guaranteed.** No directory `fsync` protocol is implemented; atomic-rename and persistence behavior remain filesystem-dependent. |
| Concurrent external writers | **Yes for cooperative ShadowGraph stores.** Create/load/save/backup/restore share the destination `.lock` fence across handles/processes and use operation-scoped SQLite handles. Overlapping writers wait and are checked against the installed revision or fail explicitly. A lock timeout is `storage_lock_timeout`; stale abandoned locks recover after the configured interval. Non-ShadowGraph code that ignores the fence remains outside this guarantee. |
| Recovery when the filesystem itself keeps failing | **Not claimed.** The operation returns `sqlite_restore_recovery_unconfirmed` and preserves the rollback snapshot where possible. |

## Test-only fault seams

The direct JavaScript factory accepts internal filesystem/open/prepare/close seams used by `test/sqlite-restore-failure.test.js`. `createStorage`, HTTP, MCP, CLI, and Python integrations pass only a file path and cannot set those hooks. No request parameter exposes fault injection.

Coverage includes malformed and verifier-aware direct/HTTP/CLI/MCP validation, corrupt-journal rejection (missing payload, contradictory replayability, and impossible epoch), journal/live-parity rejection, old/new source revision orderings, zero/missing legacy revisions, `Number.MAX_SAFE_INTEGER` overflow, source-byte immutability, semantic record/fact/relation/journal parity, pre-replacement and post-close failures, exact old-revision rollback, live-displacement and replacement rename failures (including move-then-throw), post-rename failure, an actual `DatabaseSync` constructor failure, an actual SQLite error during replacement preparation, installed-replacement read and validation failures, balanced closure of every create/load/save/backup/restore/recovery handle, source WAL folding, idle WAL/SHM absence and Windows destination removal, sidecar-operation failure, ordinary cleanup, explicit retained-artifact reporting when cleanup fails, exact artifact inventory when recovery is unconfirmed, proof that recovery inspection does not create a missing destination, confirmed rollback, HTTP/MCP graph/store and durable-reopen revision parity, rejection of stale retained payloads across handles/processes, HTTP `500` reporting for unconfirmed recovery, rejection of concurrent HTTP write and mutating-context operations before graph change, MCP success without a second post-commit save/revision increment, and repeated DS-P1-003/004 child-process save-vs-restore ordering, two restores, rollback, ABA, timeout, stale-lock recovery, callback reentry, paths containing spaces, same-path no-op, and fresh reopen.
