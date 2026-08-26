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

1. Require a regular source file and open it read-only.
2. Load and domain-validate the source payload.
3. Run `VACUUM INTO` from the source into a staged standalone database.
4. Close the restore-owned source handle in a `finally` path.
5. Open, load, and domain-validate the staged snapshot.
6. Run `VACUUM INTO` from the live handle into a rollback snapshot; open and read it before continuing.
7. Close the live handle.
8. Remove stale live sidecars, move the old main file aside, and rename the staged snapshot into the configured path.
9. Open the replacement with `DatabaseSync`, run schema preparation, load its payload, and domain-validate it.
10. Only after step 9 succeeds, make the replacement handle active and remove rollback/displacement artifacts.

The source, staged snapshot, and installed replacement are all validated. The shared domain validator is mandatory for direct JavaScript, HTTP, CLI, and MCP SQLite restores and rejects malformed imports plus both `error` and `unsupported` findings. It also rejects corrupt skipped journal entries and compares the rebuilt records/facts/relations/idempotency projection with the imported live state; documented legacy entries and hard-purge gaps remain accepted when the surviving projection is consistent. A direct JavaScript caller may supply an additional validator, but cannot disable the built-in one.

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

Ordinary successful restore and confirmed rollback leave no restore artifacts. If cleanup itself fails, the returned result or thrown error names `retainedArtifacts`; cleanup failure is never silently swallowed.

## Server serialization

The HTTP server places restore on the same persistence queue as ordinary writes. It sets a restore guard synchronously before enqueueing the operation, waits for already-queued persistence to finish, and rejects later mutating requests—including `/context`, which can generate review signals—before they touch the in-memory graph. Reads that are actually side-effect-free remain available from the existing graph. The guard is released after success or failure. This prevents an HTTP operation from mutating the graph and then failing at the store boundary while restore owns the database.

## Guarantee boundaries

| Property | Guarantee |
| --- | --- |
| Source/replacement validation atomicity | **Yes.** Invalid or unsupported payloads are rejected before commit. |
| Process-level rollback safety | **Yes for caught failures** covered by the restore state machine, including rename, replacement `DatabaseSync`, preparation, load, and validation failures. A successful recovery is reopened and payload-compared. |
| In-memory graph consistency | **Yes for the server path.** The graph reload occurs only after `store.restore()` succeeds; a rolled-back error leaves the existing graph unchanged. |
| Crash consistency | **Not guaranteed.** A process/OS crash between filesystem operations may require manual use of a retained `.rollback` or `.old` artifact. Startup does not yet auto-discover artifacts. |
| Filesystem/power-loss durability | **Not guaranteed.** No directory `fsync` protocol is implemented; atomic-rename and persistence behavior remain filesystem-dependent. |
| Concurrent external writers | **Not guaranteed.** Restore serializes operations through its own store instance, but does not coordinate with another process writing the same database path. Stop other writers before restore. |
| Recovery when the filesystem itself keeps failing | **Not claimed.** The operation returns `sqlite_restore_recovery_unconfirmed` and preserves the rollback snapshot where possible. |

## Test-only fault seams

The direct JavaScript factory accepts internal filesystem/open/prepare/close seams used by `test/sqlite-restore-failure.test.js`. `createStorage`, HTTP, MCP, CLI, and Python integrations pass only a file path and cannot set those hooks. No request parameter exposes fault injection.

Coverage includes malformed direct/HTTP/CLI/MCP validation, corrupt-journal rejection (missing payload, contradictory replayability, and impossible epoch), journal/live-parity rejection, pre-replacement and post-close failures, live-displacement and replacement rename failures (including move-then-throw), post-rename failure, an actual `DatabaseSync` constructor failure, an actual SQLite error during replacement preparation, installed-replacement read and validation failures, source-handle closure, source and live WAL folding, sidecar-operation failure, ordinary cleanup, explicit retained-artifact reporting when cleanup fails, exact artifact inventory when recovery is unconfirmed, proof that recovery inspection does not create a missing destination, confirmed rollback, HTTP graph/store and durable-reopen consistency, HTTP `500` reporting for unconfirmed recovery, rejection of concurrent HTTP write and mutating-context operations before graph change, and an MCP success regression proving restore does not perform a second post-commit save or revision increment.
