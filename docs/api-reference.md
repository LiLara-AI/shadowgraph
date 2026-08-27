# ShadowGraph — API Reference

**Version:** 0.40.0 · **Schema version:** 4 · **Supported import schemas:** 1, 2, 3, 4

Authoritative contracts: [provenance](handoffs/provenance-contract.md) · [lifecycle](handoffs/lifecycle-contract.md) · [journal](handoffs/journal-contract.md) · [completeness](handoffs/completeness-contract.md) · [search](handoffs/search-contract.md) · [confidence](handoffs/confidence-contract.md) · [SQLite restore](handoffs/sqlite-restore-contract.md)

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
| `SCHEMA_VERSION` | `4` |
| `SUPPORTED_SCHEMA_VERSIONS` | `[1, 2, 3, 4]` |
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
| `addConfidenceEvidence(id, evidence)` | Applies a keyed contribution. Re-applying the same key is a no-op — this is the double-count guard. |
| `updateDecisionStatus(id, status)` | Accepts any of the thirteen states plus formatting aliases; stores the canonical form. Throws `Invalid decision status: <raw>` otherwise. |
| `supersedeDecision(previousId, replacement)` | Same-project supersession with a persisted `supersedes` relation. |
| `link(from, to, relation)` | Explainable relationship; both endpoints must exist and the new relation ID must be unused in the global schema-4 entity namespace before mutation. |

### Reading — all return `{ items, page, completeness }`

`search(query, options)` · `retrieve(query, options)` · `recall(query, options)` · `memoryHistory(options)` · `getJournal(options)`

`recall()` unions lexical, vector, graph-distance, and temporal candidate lists and applies weighted RRF. It returns response-level `signals`/`ranking` plus per-hit `ranks`, raw `scores`, and reasons. A missing or model/dimension-incompatible vector is declared with `semantic.available=false`. Omitted project/scope matches only the `default` project and all-null scope; supplied projects must be non-empty strings, scope accepts only string/null `userId`/`agentId`/`runId`, and `asOf`/`currentAt` must be valid timestamp strings/null. Valid-time selection and temporal ranking compare parsed instants, so timezone-offset forms do not change ordering. `search()` and `retrieve()` retain legacy cross-project behavior for decisions/facts when project is omitted, but memory records default to the `default` project and always require exact scope matching. `traverse()` likewise hides memory nodes outside its requested/default project and scope.

`context(input)` returns named collections at their original keys plus a `completeness.collections` breakdown (backward compatible). It may create review signals; CLI, HTTP, MCP tools, and the MCP context resource persist those signals before returning success.

`traverse(id, options)` · `projectSummary(project)` · `stats()` · `getReviewSignals()`

### Reconsideration

`review(context)` — evaluates `reopenWhen` rules against **stored** facts, so it works after a restart. Caller-supplied `facts` override stored facts of the same key; string-form rules match `changedFacts` only.

`maintain(options)` · `acknowledgeReview(id)`

### Integrity and lifecycle

| Method | Notes |
| --- | --- |
| `validate()` | Returns `{ valid, issues, counts }`. `valid` is false for errors and unsupported data; legacy and info diagnostics remain readable. Unknown confidence policies are preserved without v1 recalculation and reported as unsupported. |
| `repairPlan()` | Always `apply: false`. Unknown statuses route to `manual_review`, never automatic mutation. |
| `rebuild(options?)` | Replays this graph's own journal through `rebuildProjection`. |
| `purgeProject(project, options?)` | **Logical/tombstone by default.** `{ mode: 'hard' }` physically deletes and creates a declared `seq` gap. |
| `redact(options?)` | Privacy-safe export; covers journal payloads. |
| `exportData()` / `importData(data)` | Round-trip stable. Import preserves stored values and **never elevates trust**; legacy facts get `sourceClass` backfilled and collection-local ID remaps propagate through journal/idempotency dependencies. Direct import preflights final relation endpoints, journal type/identity/sequence, event IDs, review identities, idempotency namespaces, and plain-JSON values before mutation. Legacy orphaned idempotency payloads become explicit canonical entities rather than hidden cache-only state. Merge import cannot lower the live revision or journal high-water mark. |
## 3. `validate()` diagnostics — four severities

| Severity | Meaning | Affects `valid` |
| --- | --- | --- |
| `error` | Genuinely invalid data | **Yes** |
| `legacy` | Readable, but pre-dates a contract | No |
| `unsupported` | From a newer/unknown schema or policy this build cannot interpret | **Yes** |
| `info` | Declared discontinuity, e.g. a hard-purge `journal_gap` | No |

Codes include `missing_relation_source`, `missing_relation_target`, `self_supersession`, `invalid_confidence`, `unknown_decision_status`, `unknown_verification_status`, `confidence_policy_mismatch`, `duplicate_active_fact_scope`, `duplicate_active_memory_scope` (errors) · `legacy_missing_decision_status`, `legacy_confidence_without_basis`, `legacy_fact_source_class` (legacy) · `unsupported_journal_entry`, `unsupported_journal_schema_version`, `unsupported_record_schema_version`, `unsupported_fact_schema_version`, `unsupported_confidence_policy` (unsupported) · `journal_gap` (info).

This three-way split is the answer to "don't let legacy data fail silently and don't guess-repair it": legacy data is **named as legacy**, reported, and left alone.

## 4. Storage

```js
import { createJsonFileStore, createStorage } from './src/storage.js';
import { createSqliteStore } from './src/sqlite-storage.js';
```

Both expose `load()` / `save(data)` / `close()`. State and journal are written in **one** atomic operation — `rename()` for JSON, `BEGIN IMMEDIATE`…`COMMIT` for SQLite — so they cannot diverge. HTTP serializes graph mutation with persistence; MCP serializes complete tool calls including restore. HTTP and MCP reload the last durable snapshot (or the pre-mutation snapshot if storage cannot be read) after an ordinary save failure. Markdown pull accepts a persistence callback only with a paired durable read-back callback, reloads the committed snapshot so live revision/state match storage before sync-state write, and therefore resolves commit-then-throw ambiguity. JSON saves additionally use an atomic lock file with a bounded wait and stale-lock recovery; a timeout is an explicit error and SQLite is recommended for sustained multi-process writers. `createSqliteStore` requires a Node build with `node:sqlite` (stability 1.2, Release Candidate) and throws a clear error otherwise; tests skip on `/requires Node/`.

JSON and SQLite restore apply the shared domain validator even for direct JavaScript calls; callers may add validation but cannot disable the built-in checks. SQLite additionally uses verified `VACUUM INTO` snapshots for both the source and the live rollback state, so committed WAL contents are folded into standalone files, and rejects corrupt journal folds, sequence gaps not enumerated by a persisted hard-purge `removedJournalSequences` ledger, or a records/facts/relations/idempotency projection that differs from live state. The rollback snapshot remains until the installed replacement has opened, prepared, loaded, and passed validation. Recovery inspects an existing candidate read-only before any write-capable reopen, so checking a missing destination cannot create an empty database. Caught post-replacement failures restore, reopen, and payload-compare the old state; an unconfirmed recovery is reported explicitly, retains its rollback artifact, and latches the HTTP server degraded so every authenticated non-health route request returns `503` until restart/manual recovery. HTTP restore is serialized with persistence and rejects concurrent mutating requests—including `/context`, which can generate review signals—before graph mutation. This is **process-level rollback safety**, not a claim of crash consistency, directory-`fsync` durability, or coordination with another process writing the same path. Full contract: [SQLite restore](handoffs/sqlite-restore-contract.md).

### U-1 — Verification channel

**Status: accepted — unverified-only for 0.31.0.** No agent-accessible trusted writer, authorization boundary, or re-checkable evidence mechanism exists. Therefore:

- tool input cannot create `verificationStatus: 'verified'`;
- legacy imported `verified` values are preserved read-only for compatibility and reported as legacy-compatible data;
- `sourceClass`, `sourceRaw`, confidence, and evidence are claims or policy inputs, not proof;
- confidence calibration is not established.

A future trusted channel requires a separately authorized writer and regression-tested authorization boundary; it is deferred rather than implied by this API.

### U-2 — Privileged tool re-verification

**Status: deferred.** Tool-observed claims are stored and weighted only as declared policy inputs; they never verify a fact.

### U-3 — Legacy verified values

**Status: accepted provisional.** Preserve legacy values during import/export to avoid destructive rewriting, but do not allow ordinary agent writes or replay to mint them. A migration marker is deferred until U-1 is resolved.

### L-1 — Entry state

**Status: deferred.** `active` remains the load-bearing default validity state; changing it would alter context semantics and is outside release scope.

### L-2 — Transition enforcement

**Status: deferred.** Status values are canonicalized, but arbitrary valid-state transitions remain allowed until a normative product transition contract is accepted.

### L-5 — `stale` / `archived`

**Status: deferred.** They remain legacy compatibility states with no producer; no semantic alias or migration is invented.

### Review-signal acknowledgment audit scope

**Status: accepted provisional.** Acknowledgment is persisted in the projection/storage snapshot but is not journalled or replayed. Rebuild therefore reconstructs domain records/facts/relations/confidence/idempotency, not review-signal acknowledgment history. Actor/session audit for acknowledgment is deferred; the product currently requires review signals, not an immutable acknowledgment audit trail.

**MCP** (`npm run mcp`) — protocol `2024-11-05`; see [MCP compatibility](mcp-compatibility.md) for the honest version statement.
**HTTP** (`npm start`) — optional Bearer auth.
**CLI** (`npx shadowgraph`).

## 6. Errors thrown by input validation

`A caller cannot set fact verificationStatus to verified` · `... to expired` · `Invalid fact verificationStatus` · `Invalid decision status: <raw>` · `Unknown journal entry type: <type>` · `Purge mode must be logical or hard` · `Outcome status must be successful, mixed, failed, or unknown` · `<field> must be a string when provided` · `Decision not found`.

The first four message shapes pre-date this release and are preserved for compatibility.
