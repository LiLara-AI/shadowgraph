# Upgrade and rollback

## Moving to 0.43.0

Stop active wrappers/workers and back up each store before upgrading. For a manual store, use `shadowgraph backup <backup-file>` with that store selected. For the Codex wrapper, stop it and preserve its entire private home (configuration, memory, pending outbox and usage receipts) in a private location. Do not publish these backups.

Install the version-pinned release tarball or GitHub tag. Source, executor or account identity changes require owner setup again. Re-setup preserves memory and usage but holds older pending captures with different setup provenance; it does not silently reassign them. Inspect status before deciding what to do with any held work.

0.43.0 retains schema 7. For Claude Code CLI extraction, items left pending under an earlier extraction setup are reported as `priorSetup`, not as pending work, and are not extracted by a new activation. Keep a pre-upgrade backup for rollback; an older runtime is not a safe processor for new integration state. For older schema transitions, use the guidance below.

### Moving between 0.41.0 and 0.42.0

- **Take a backup before upgrading.** `shadowgraph backup [<file>]` copies the store: a JSON store
  byte for byte, a SQLite store table by table. A backup taken before this build first saves the
  store is still a schema-5 store that 0.41.0 opens. (Opening a SQLite store, this build adds a table
  of its own to it; 0.41.0 still reads the store.) Once this build has saved the store, its backups are schema-7 stores; to use one with
  0.41.0, restore it into a fresh path with this build and fork a schema-5 copy as below.
- **Upgrading.** 0.42.0 reads every store 0.41.0 wrote (schemas 1 through 5) and writes schema 7 on
  its next save. What changes for you:
  - A write that names no project is refused (`write_scope_unresolved`). Pass `project`, or bind the
    workspace to a project with `shadowgraph bind`.
  - Records 0.41.0 stored in `default` -- written without a project, which 0.41.0 put there, or
    naming `default` -- are legacy material whose owner this build treats as uncertain: no read
    returns them, not even with `"project":"default"`.
    They are not deleted. The JavaScript API's `legacyAttributionReview()` lists them, and
    `shadowgraph attribute '{"ids":["<id>"],"targetProject":"<project>","reason":"<why>"}'`, which
    you confirm at a terminal, moves named records into a project. To note their ids before
    upgrading, run 0.41.0's `shadowgraph list`, which prints every record, and keep the ids of those
    with `"project": "default"`. If you rely on such records
    and do not want to move them, stay on 0.41.0.
  - Some results changed shape; for example, `review` returns `{"items": [...], "completeness": {...}}`
    instead of an array. The [changelog](../CHANGELOG.md) lists every breaking change.
- **Going back to 0.41.0.** 0.41.0 reads schemas 1 through 5 only and refuses a store this build has
  saved. Fork a schema-5 copy with `shadowgraph downgrade '{"output":"<new file>"}'`. It first writes
  a verified preservation copy beside the store (`<store>.preservation-<time>`), then the copy, and
  never changes the store. `<output>.report.json` names what schema 5 cannot hold, such as record
  attribution, erasure tokens, claim evidence and capture state, and the copy's journal history is
  replaced by one baseline entry. Point 0.41.0 only at the copy: given a schema-7 SQLite store, 0.41.0 can
  set the file's journal mode before it refuses it.
- **What 0.41.0 does not have.** 0.41.0 has none of this build's project isolation or deletion
  records: there, a read that names no project returns every project's records, and restoring a
  backup taken before a purge brings the purged material back.
- **Hooks, capture, delivery and extraction.** 0.41.0 has no hook, capture, delivery or extraction
  commands. Before switching to it, run with this build `shadowgraph deactivate extraction`,
  `shadowgraph deactivate capture`, `shadowgraph deactivate delivery`,
  `shadowgraph uninstall-hooks --capture` and `shadowgraph uninstall-hooks`, and check that
  extraction's cleanup did not report `deferred` (see
  [deactivate, uninstall and recover](extraction.md#deactivate-uninstall-and-recover)).
