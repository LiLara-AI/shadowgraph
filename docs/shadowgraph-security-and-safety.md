# ShadowGraph — Security, Safety, and Data-Integrity Requirements

## Threat model

ShadowGraph stores potentially sensitive project decisions, assumptions, facts, failures, and evidence locally. The primary risks are accidental exposure, fabricated history, cross-project leakage, corruption, unsafe restore, stale concurrent writes, and misleading confidence.

## Data boundaries

- Default to local-only binding and local filesystem storage.
- Never send memory to a hosted service unless a future feature explicitly opts in and documents consent.
- Never log tokens, secrets, bearer values, or full private records unnecessarily.
- Keep project scoping explicit on reads and writes.
- Reject or redact secrets and sensitive fields where the existing redaction policy applies.
- Make purge and backup operations explicit and auditable.

## Provenance and truth safety

Every canonical claim should carry, directly or through an immutable event:

- source class: `agent_claimed`, `tool_observed`, `human_confirmed`, or `production_verified`;
- actor/client/session identifier where available;
- created/observed time;
- project scope;
- supporting or contradicting evidence;
- derivation links when the claim was inferred from earlier records.

Never promote an agent assertion to a verified fact merely because it is repeated. Never create synthetic outcomes, attempts, or human confirmations for a benchmark.

## Retrieval safety

- Storage is full fidelity.
- Retrieval limits are explicit, validated, and accompanied by total/offset/hasMore metadata.
- A compact response must identify what it contains and what remains available.
- No silent summaries, silent truncation, or lossy projection may become the source of truth.
- Project-scoped exports/redaction must filter records, facts, relations, events, journal, idempotency payloads, and review signals to the requested project.
- Full record expansion must be deterministic and testable.
- Search/ranking must not hide contradictory evidence without declaring the ranking scope.

## Persistence integrity

- Use atomic temporary writes and rename for JSON.
- Use transactions and revision checks for SQLite.
- Read the SQLite revision inside the write lock.
- Preserve a verified standalone rollback snapshot until an SQLite replacement opens, prepares, loads, and validates.
- Inspect a possible existing recovery destination as a regular file and read-only database before any write-capable open; inspection must not create an empty destination.
- Reject corrupt journal folds and any records/facts/relations/idempotency projection that disagrees with live restored state. A sequence gap requires a persisted `project.purged` entry whose payload records `mode: 'hard'`; otherwise restore rejects it as unexplained. Documented legacy semantics remain accepted.
- On a caught post-replacement failure, restore and reopen the old payload; report `sqlite_restore_recovery_unconfirmed` rather than claiming safety if recovery itself fails, and latch the HTTP process degraded so it cannot serve or mutate potentially divergent graph state before restart/manual recovery.
- Treat SQLite restore as process-level rollback safety only: it does not guarantee crash consistency, filesystem durability, or coordination with external writers.
- Validate backups and restored files before replacing live data.
- Serialize persistence queues, reject graph-mutating routes such as `/context` while restore owns persistence, and reload after conflict recovery.
- Test process concurrency and stale-writer rejection.

## Access control and network safety

- Keep HTTP server local-only by default.
- Support optional bearer authentication without exposing the token.
- Reject disallowed browser origins and oversized request bodies.
- Do not add wildcard CORS.
- Do not start a replacement server for the existing GUI without an explicit request.
- MCP stdio should not perform network access unless a separately reviewed capability requires it.

## Lifecycle safety

Every timer, handler, event listener, tool, file write, HTTP route, and UI registration must be reversible on stop/update/undefine when implemented as a dynamic plugin. For repository code, provide cleanup/error paths and avoid leaving temporary files.

## Confidence safety

Confidence must be explainable and monotonic only under explicit policy. Record the basis for every change. Separate decision confidence from fact verification and outcome certainty. A successful model-reported outcome is not automatically production verification. Contradicting facts and failed outcomes must be able to lower confidence or open review.

## Migration safety

- Never remove old tables until conversion succeeds.
- Keep old interface aliases during migration.
- Add fixture-based round-trip tests.
- Test interruption/failure paths, not only successful migrations.
- Do not rewrite user data in place without a backup or transactional protection.

## Release gates

Before merge/push:

1. Full tests pass.
2. Syntax/check passes.
3. Audit reports zero vulnerabilities or every exception is documented.
4. Diff check passes.
5. No secrets or temporary data are committed.
6. Public README/changelog matches behavior.
7. Clean-install integration passes.
8. Backup/restore and project-isolation tests pass.
9. Benchmark artifacts contain no private memory.
10. npm remains unpublished unless explicitly approved.
