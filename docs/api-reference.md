# ShadowGraph — API Reference

**Version:** 0.40.0 · **Schema version:** 5 · **Supported import schemas:** 1, 2, 3, 4, 5

Authoritative contracts: [provenance](contracts/provenance-contract.md) · [lifecycle](contracts/lifecycle-contract.md) · [journal](contracts/journal-contract.md) · [completeness](contracts/completeness-contract.md) · [search](contracts/search-contract.md) · [confidence](contracts/confidence-contract.md) · [SQLite restore](contracts/sqlite-restore-contract.md)

---

## 1. Module exports — `src/shadowgraph.js`

### Factory

```js
import { createShadowGraph } from './src/shadowgraph.js';
const graph = createShadowGraph({ now });   // `now` is an injectable clock, used by tests
```

### Vocabulary constants — intended public API, all frozen

| Export | Value |
| --- | --- |
| `SCHEMA_VERSION` | `5` |
| `SUPPORTED_SCHEMA_VERSIONS` | `[1, 2, 3, 4, 5]` |
| `SOURCE_CLASSES` | `agent_claimed`, `tool_observed`, `human_confirmed`, `production_verified` |
| `VERIFICATION_STATUSES` | `unverified`, `verified`, `contradicted`, `expired` |
| `DOCUMENTED_DECISION_STATUSES` | the nine execution states |
| `LEGACY_DECISION_STATUSES` | `active`, `aging`, `stale`, `archived` |
| `DECISION_STATUSES` | all thirteen |
| `OUTCOME_STATUSES` | `successful`, `mixed`, `failed`, `unknown` |
| `MEMORY_TYPES` | `preference`, `profile`, `goal`, `instruction`, `procedure`, `episode`, `note` |
| `CONTENT_SEARCH_FIELDS` | the ten searchable content fields |
| `SEARCH_FILTERS` | `project`, `status`, `minConfidence`, `sourceClass`, `kind` |
| `DEFAULT_PAGE_LIMIT` / `MAX_PAGE_LIMIT` | `50` / `1000` |
| `CONFIDENCE_POLICY` | `evidence_weighted_bounded_v1` |

**These are deliberately public** (resolving review items E-1/E-2): MCP schemas generate their enums from them, so a schema cannot drift from what the core enforces. All are `Object.freeze`d, so a consumer cannot corrupt validation by mutating one (resolving E-3).

### Journal functions

`rebuildProjection(entries, options?)` · `journalGaps(entries)` — both re-exported from `src/journal.js`, both pure.

## 2. Instance methods

### Writing

| Method | Notes |
| --- | --- |
| `addDecision(input)` | Records a decision with alternatives, assumptions, evidence, provenance. Alternatives are part of the decision, not independent entities. |
| `addAttempt(input)` | Records an attempt and its lesson. |
| `remember(input)` | Reconciles one exact `(project, scope, memoryType, key)` identity and returns `ADD`, `UPDATE`, or `NOOP`; update retains the previous version. Idempotency is isolated by that full identity. |
| `applyMemoryPlan(input)` | Preflights and applies explicit `ADD` / `UPDATE` / `DELETE` / `NOOP` operations. Delete invalidates rather than erasing historical payloads. |
| `addFact(input)` | **Rejects `verificationStatus: 'verified'` / `'expired'`.** Unknown `sourceClass` downgrades to `agent_claimed` with `sourceRaw` retained. Supersedes any prior fact for the same `(project, key)`. |
| `setOutcome(id, outcome)` | Records an outcome and applies one evidence-weighted confidence contribution. |
| `addConfidenceEvidence(input)` | Applies a keyed contribution. Re-applying the same key is a no-op — this is the double-count guard. |
| `updateDecisionStatus(id, status)` | Accepts any of the thirteen states plus formatting aliases; stores the canonical form. Throws `Invalid decision status: <raw>` otherwise. |
| `supersedeDecision(input)` | Same-project supersession with a persisted `supersedes` relation. |
| `link(input)` | Explainable relationship; both endpoints must exist and the new relation ID must be unused in the global schema-4 entity namespace before mutation. |

### Reading — all return `{ items, page, completeness }`

`search(query, options)` · `retrieve(query, options)` · `recall(query, options)` · `memoryHistory(options)` · `getJournal(options)`

`recall()` unions lexical, vector, graph-distance, and temporal candidate lists and applies weighted RRF. It returns response-level `signals`/`ranking` plus per-hit `ranks`, raw `scores`, and reasons. A missing or model/dimension-incompatible vector is declared with `semantic.available=false`. Omitted project/scope matches only the `default` project and all-null scope; supplied projects must be non-empty strings, scope accepts only string/null `userId`/`agentId`/`runId`, and `asOf`/`currentAt` must be valid timestamp strings/null. Valid-time selection and temporal ranking compare parsed instants, so timezone-offset forms do not change ordering. `search()` and `retrieve()` retain legacy cross-project behavior for decisions/facts when project is omitted, but memory records default to the `default` project and always require exact scope matching. `traverse()` likewise hides memory nodes outside its requested/default project and scope.

`context(input)` returns named collections at their original keys plus a `completeness.collections` breakdown (backward compatible). It may create review signals; CLI, HTTP, MCP tools, and the MCP context resource persist those signals before returning success.

`traverse(input)` · `projectSummary(project)` · `stats()` · `getReviewSignals()`

### Reconsideration

`review(context)` — evaluates `reopenWhen` rules against **stored** facts, so it works after a restart. Caller-supplied `facts` override stored facts of the same key; string-form rules match `changedFacts` only. `context`, `project`, `asOf`, `changedFacts`, `facts`, and nested fact values are preflight-validated before a review signal can be inserted.

`maintain(options)` preflights its object shape, `now`, `changedFacts`, `facts`, and the complete delegated review input before staling decisions, expiring facts, or appending journal entries. A rejected core or MCP maintain call leaves state, review signals, journal sequence, revision, and durable state unchanged. MCP restores the pre-call graph snapshot on any domain-operation exception before persistence. · `acknowledgeReview(id)`

### Integrity and lifecycle

| Method | Notes |
| --- | --- |
| `validate()` | Returns `{ valid, issues, counts }`. `valid` is false for errors and unsupported data; legacy and info diagnostics remain readable. Unknown confidence policies are preserved without v1 recalculation and reported as unsupported. |
| `repairPlan()` | Always `apply: false`. Unknown statuses route to `manual_review`, never automatic mutation. |
| `rebuild(options?)` | Replays this graph's own journal through `rebuildProjection`. Invalid baseline placement is skipped and returns `rebuildable:false` with stable issue code `invalid_projection_baseline_placement`; an incomplete fold is never presented as trusted. |
| `purgeProject(project, options?)` | **Logical/tombstone by default.** `{ mode: 'hard' }` physically deletes and creates a declared `seq` gap. |
| `redact(options?)` | Privacy-safe export; covers journal payloads. |
| `exportData()` / `importData(data)` | Round-trip stable. Import preserves stored values and **never elevates trust**; legacy facts get `sourceClass` backfilled and collection-local ID remaps propagate through journal/idempotency dependencies. Direct import preflights final relation endpoints, journal type/identity/sequence/baseline placement, event IDs, review identities, idempotency namespaces, and plain-JSON values before mutation. Legacy orphaned idempotency payloads become explicit canonical entities rather than hidden cache-only state. Merge import cannot lower the live revision, journal high-water mark, or existing replay epoch. |

## 3. `validate()` diagnostics — four severities

| Severity | Meaning | Affects `valid` |
| --- | --- | --- |
| `error` | Genuinely invalid data | **Yes** |
| `legacy` | Readable, but pre-dates a contract | No |
| `unsupported` | From a newer/unknown schema or policy this build cannot interpret | **Yes** |
| `info` | Declared discontinuity, e.g. a hard-purge `journal_gap` | No |

Codes include `missing_relation_source`, `missing_relation_target`, `self_supersession`, `invalid_confidence`, `unknown_decision_status`, `unknown_verification_status`, `confidence_policy_mismatch`, `duplicate_active_fact_scope`, `duplicate_active_memory_scope`, `invalid_projection_baseline_placement` (errors) · `legacy_missing_decision_status`, `legacy_confidence_without_basis`, `legacy_fact_source_class` (legacy) · `unsupported_journal_entry`, `unsupported_journal_schema_version`, `unsupported_record_schema_version`, `unsupported_fact_schema_version`, `unsupported_confidence_policy` (unsupported) · `journal_gap` (info).

This three-way split is the answer to "don't let legacy data fail silently and don't guess-repair it": legacy data is **named as legacy**, reported, and left alone.

## 4. Storage

```js
import { createJsonFileStore, createStorage } from './src/storage.js';
import { createSqliteStore } from './src/sqlite-storage.js';
```

Both expose `load()` / `save(data)` / `close()`. State and journal are written in **one** atomic operation — `rename()` for JSON, `BEGIN IMMEDIATE`…`COMMIT` for SQLite — so they cannot diverge. Revisions are non-negative safe-integer concurrency tokens; a save or restore that cannot mint a strictly greater safe integer rejects with `revision_overflow` instead of rounding or wrapping. HTTP serializes graph mutation with persistence; MCP serializes complete tool calls including restore. HTTP and MCP reload the last durable snapshot (or the pre-mutation snapshot if storage cannot be read) after an ordinary save failure. Markdown pull accepts a persistence callback only with a paired durable read-back callback, reloads the committed snapshot so live revision/state match storage before sync-state write, and therefore resolves commit-then-throw ambiguity. JSON saves/restores and SQLite create/load/save/backup/restore operations use the same per-destination atomic `.lock` fence across handles and processes. A writer that overlaps restore waits and is checked against the installed revision, or fails explicitly; timeout is `storage_lock_timeout`, stale abandoned locks are recovered, and same-async-chain callback reentry is `storage_lock_reentrant` rather than a deadlock. SQLite opens the configured path per operation and closes it before releasing the fence, so no idle handle can pin the destination or WAL/SHM sidecars and a post-restore operation always opens the installed file. `createSqliteStore` requires a Node build with `node:sqlite` (stability 1.2, Release Candidate) and throws a clear error otherwise; tests skip on `/requires Node/`.

JSON and SQLite restore apply the shared domain validator even for direct JavaScript calls; callers may add validation but cannot disable the built-in checks. The same validator is used by direct import/replacement and the CLI/HTTP/MCP restore surfaces. Duplicate, ordinary midstream, rewind, wrong-epoch, and terminal-rewriting baselines reject as `invalid_projection_baseline_placement` before replacement; the narrowly compatible migration forms are defined by [ADR-0007](adr/0007-canonical-journal-baseline-placement.md). A restore copies the source's **semantic content**—records, facts, relations, review state, idempotency, events, and journal—but does not reuse the backup's concurrency token. While holding the destination fence, restore validates the source revision (a missing legacy revision means `0`), reads the current destination revision, and installs `max(destinationRevision, sourceRevision) + 1`. The source backup bytes are never rewritten. The activated in-memory graph and a fresh durable reopen expose that exact installed revision, so every payload captured before restore remains stale and raises `RevisionConflictError`; it cannot become valid again after a post-restore write. Same-path restore remains unchanged. If either high-water mark is `Number.MAX_SAFE_INTEGER`, restore rejects with `revision_overflow` before replacement.

Hard-purge `removedJournalSequences` values must be positive safe integers, unique per marker, actual replay-range gaps, and strictly earlier than their surviving marker; every gap needs a later marker, and coverage uses bounded sorted-range arithmetic rather than expanding absent sequences. SQLite additionally uses verified `VACUUM INTO` snapshots for both the source and the live rollback state, so committed WAL contents are folded into standalone files, and rejects corrupt journal folds or a records/facts/relations/idempotency projection that differs from live state. The rollback snapshot remains until the installed replacement has opened, prepared, loaded, and passed validation. Recovery inspects an existing candidate read-only before any write-capable reopen, so checking a missing destination cannot create an empty database. Caught post-replacement failures restore, reopen, and payload-compare the old state, including its exact old revision; JSON recovery restores the exact old destination bytes. An unconfirmed recovery is reported explicitly, retains its rollback artifact, and latches the HTTP server degraded so every authenticated non-health route request returns `503` until restart/manual recovery. HTTP restore is serialized with persistence and rejects concurrent mutating requests—including `/context`, which can generate review signals—before graph mutation. External save/restore overlap is also serialized by the destination fence. This is **process-level rollback safety**, not a claim of crash consistency or directory-`fsync` durability. Full contract: [SQLite restore](contracts/sqlite-restore-contract.md).

JSON restore inventories `.rollback`, `.recovery`, and `.tmp` paths without replacing the primary restore outcome when `stat` itself fails. `json_restore_recovery_unconfirmed` always remains the error code; `retainedArtifacts` lists files confirmed present, while `unknownArtifacts` contains `{ path, code }` entries whose existence could not be determined. HTTP and MCP latch every graph read/write closed before accepting a later operation; authenticated HTTP health and MCP error diagnostics carry the same inventory. The intentionally public static dashboard never includes recovery diagnostics.

After a successful JSON restore or a confirmed rollback, cleanup attempts and then inspects every artifact path. An anomalous cleanup result/error includes `retainedArtifacts`, `unknownArtifacts`, and `artifactCleanup: { status, errors }`, where `status` is `complete`, `incomplete`, or `unknown` and each cleanup error is `{ path, code }`. Final inspection is authoritative: a delete-that-then-throws is reported as `status: "complete"` with an empty `retainedArtifacts`, never as a retained file. Ordinary clean success keeps the existing `{ source, destination, records }` result shape.

### U-1 — Verification channel

**Status: implemented in schema 5.** Ordinary fact writes still cannot create `verificationStatus: 'verified'`. A graph/server may be constructed with a separate local verifier whose trust store is not caller input. `verifyFact({factId,evidencePath})` accepts only those two fields and verifies a closed-shape Ed25519 attestation inside a configured evidence root. The signed digest binds the canonical fact claim, verifier identity, evidence reference, method, and verification timestamp. Invalid/tampered evidence rejects before fact, event, or journal mutation. Signed verification survives export/import, journal rebuild, and JSON/SQLite restart; expired facts cannot be promoted back to effective verification during import.

MCP exposes `shadowgraph_verify_fact` only in full mode when `SHADOWGRAPH_VERIFIER_CONFIG` is set. The caller never supplies the trust key, verifier identity, signature, method, or target status through tool arguments.

### U-2 — Privileged tool re-verification

**Status: deferred.** Tool-observed claims are stored and weighted only as declared policy inputs; they never verify a fact.

### U-3 — Legacy verified values

**Status: implemented migration.** A schema-1–4 unsigned `verified` value becomes effective `unverified` with `legacyVerificationStatus: 'verified'`. It remains visible for audit but is never trusted as a signed attestation.

### L-1 — Entry state

**Status: implemented.** New decisions enter `proposed`. Current/actionable context is defined by the explicit current-state set rather than a literal `active` value. Schema-4 `active` migrates to `proposed` with `migration.legacyDecisionStatus`.

### L-2 — Transition enforcement

**Status: implemented.** `DECISION_TRANSITIONS` defines every legal caller transition. `stale` and `superseded` are system-owned. Illegal transitions reject before decision/event/journal mutation.

### L-5 — `stale` / `archived`

**Status: implemented.** `maintain()` produces `stale` when a current decision reaches `reviewAfter`; callers cannot self-assign it. `archived` is an explicit terminal disposition, distinct from `abandoned`, and excluded from current context and automatic review.

### Review-signal acknowledgment audit scope

**Status: accepted provisional.** Acknowledgment is persisted in the projection/storage snapshot but is not journalled or replayed. Rebuild therefore reconstructs domain records/facts/relations/confidence/idempotency, not review-signal acknowledgment history. Actor/session audit for acknowledgment is deferred; the product currently requires review signals, not an immutable acknowledgment audit trail.

## 5. Interface entry points

| Surface | Entry point | Notes |
| --- | --- | --- |
| MCP | `shadowgraph mcp` (from a clone: `npm run mcp`) | Dual-era legacy `2024-11-05` plus modern `2026-07-28`; see [MCP compatibility](mcp-compatibility.md). `SHADOWGRAPH_MCP_COMPACT=1` advertises 12 tools instead of 27. |
| HTTP | `shadowgraph serve` (from a clone: `npm start`) | Binds `127.0.0.1`; optional Bearer auth via `SHADOWGRAPH_API_TOKEN`. |
| CLI | `shadowgraph <command>` (from a clone: `node src/cli.js <command>`) | Each invocation is a separate process that reopens the store. |

`npx shadowgraph` does **not** run this project. The package is named
`shadowgraph-unified-plugin`, it is `private: true` and unpublished, and the bare name `shadowgraph`
on the public registry belongs to an unrelated package. Install from GitHub as described in the
[README](../README.md#1-install).

## 6. Errors thrown by input validation

`A caller cannot set fact verificationStatus to verified` · `... to expired` · `Invalid fact verificationStatus` · `Invalid decision status: <raw>` · `Unknown journal entry type: <type>` · `Purge mode must be logical or hard` · `Outcome status must be successful, mixed, failed, or unknown` · `<field> must be a string when provided` · `Decision not found`.

The first four message shapes pre-date this release and are preserved for compatibility.
