# Changelog

## 0.40.0 (unreleased — pre-Beta release candidate)

This release keeps ShadowGraph's decision-first model and adds the everyday memory capabilities needed for user personalization, temporal recall, hybrid retrieval, and human-readable Markdown workflows. The implementation is independent; no competitor source code was copied.

### Breaking

- **`SCHEMA_VERSION` is now `5`** and imports schemas 1–5. Schema 4 added memory records; schema 5 adds the canonical lifecycle and signed-verification migration boundary.
- Compact MCP mode now advertises **12** workflow tools (previously 10), adding `shadowgraph_remember` and `shadowgraph_recall`. Full mode advertises 27 tools.

### Added

- Scoped memory for project plus `userId` / `agentId` / `runId`, with `preference`, `profile`, `goal`, `instruction`, `procedure`, `episode`, and `note` types.
- Deterministic reconciliation outcomes: `ADD`, `UPDATE`, `DELETE`, and `NOOP`; previous versions are retained and journalled rather than overwritten.
- Validated memory operation plans that preflight the complete batch before mutation.
- Bi-temporal validity and record-time fields for memory, facts, and relations; point-in-time `asOf` recall.
- Explainable hybrid candidate union over BM25-style lexical rank, optional cosine vector rank, graph distance, and temporal rank, fused with weighted RRF. Every response declares unavailable signals.
- Localhost-first OpenAI-compatible embedding adapter. Remote embedding endpoints require `allowRemote=true` / `SHADOWGRAPH_ALLOW_REMOTE_EMBEDDINGS=1`.
- Deterministic Markdown rendering and explicit push/pull synchronization with atomic writes, stable identity paths, Unicode round trips, content hashes, dry-run support, and conflict refusal.
- JavaScript, CLI (`remember`, `recall`, `markdown-sync`), HTTP (`POST /memories`, `POST /recall`), and MCP workflow surfaces.
- JSON/SQLite restart parity and journal rebuild coverage for scoped memories.
- Architecture decision record with grounded competitor research: `docs/adr/0006-unified-memory-kernel.md`.
- Canonical replay-baseline placement ADR: `docs/adr/0007-canonical-journal-baseline-placement.md`.
- Frozen seven-arm/ten-scenario benchmark preregistration, deterministic validation/aggregation harness, and measured 1k/10k/100k local journal evidence. Comparative lifecycle values remain unavailable because the common local/free LLM-and-embedding prerequisite was absent; dependency import probes are not performance evidence.
- Installed-package commands: `shadowgraph setup`, `shadowgraph doctor`, `shadowgraph serve`, and `shadowgraph mcp`.
- Real-tarball clean-install smoke coverage for paths containing spaces, including installed CLI, MCP full/compact, HTTP health, dashboard, and restart persistence workflows.
- Copy-ready Claude Code, Cursor, Codex, and Hermes MCP configurations, with compact mode recommended and full mode preserved.

### Fixed

- Replay baselines can no longer reset fact lifecycle history. Duplicate, ordinary midstream, rewind, wrong-epoch, and terminal-rewriting baselines reject atomically as `invalid_projection_baseline_placement`; pure rebuild skips them and reports incomplete instead of reactivating an expired or superseded signed fact. Schema 1–5 migration baselines, proven monotonic migration extensions, baseline-only snapshots, and hard-purge leading gaps remain supported.
- Scoped recall now fails closed: omitted project/scope means only the `default` project and all-null scope, never every project/user/agent/run. Supplied memory projects must be non-empty strings. Memory idempotency keys include the full scope/type/key identity.
- Schema-4 runtime writes/imports enforce globally unique record/fact/relation/alternative IDs so JSON and SQLite accept the same graph; new links reject missing endpoints; direct merge import rebuilds current-memory/current-fact indexes instead of retaining overwritten payload objects.
- Memory plans preflight retry keys, IDs, temporal ordering, and invalidation bounds. Re-adding an invalidated identity continues its monotonic version history.
- Same-content writes validate explicit temporal changes; temporal fields must be strings/null; supersession, deletion, and fact replacement never extend an interval that had already ended. Current recall keeps the prior value until a future-effective replacement starts. Fact expiry closes valid time before reconsideration.
- Derived embeddings can be refreshed without creating a semantic version, are journalled as `memory.indexed`, require model+dimension compatibility, reject redirects, and fall back honestly when a configured MCP query embedder fails.
- Schema-4 persisted memory/fact/relation envelopes receive full temporal validation, globally unique IDs are enforced, and journal-bearing schemas 1–3 are compared after symmetric migration during restore.
- Hard purge now persists an exact `removedJournalSequences` ledger; an unrelated or empty hard-purge marker can no longer excuse arbitrary restore gaps.
- Project purge clears the in-memory scoped-memory index; a later write cannot accidentally supersede or re-journal a purged payload. A tracked stale Markdown file cannot resurrect a purged memory.
- Markdown paths use stable bounded identity segments; immutable IDs and frontmatter identity edits are rejected. Pull rolls back the whole graph on a later-file error and advances sync state only after an optional canonical persistence callback succeeds.
- The MCP stdio server supports legacy `2024-11-05` initialization and modern `2026-07-28` per-request metadata/discovery semantics without falsely advertising one contract as the other.
- CLI/HTTP/MCP context paths now persist generated review signals. HTTP and MCP mutators reconcile live state to the last readable durable snapshot after ordinary persistence failures.
- MCP serializes complete tool/restore calls, preventing concurrent acknowledged writes from being erased by restore or conflict recovery.
- Schema-4 imports reject malformed projects/scopes/IDs before merge, reject collisions against live collections, validate stored fact/relation intervals and journal identity, and preserve nested-alternative links through rebuild.
- Markdown persistence callbacks now require durable read-back, resolving both pre-commit failures and commit-then-throw ambiguity.
- Explicit empty projects fail closed across search, retrieval, review, journal, redaction, and context instead of becoming cross-project wildcards.
- Temporal strings are validated as real timestamps and compared by instant, including equivalent timezone-offset representations.
- Restore/import validates review-signal references and IDs, idempotency references/namespaces, and schema-3/4 journal identities; legacy collection-local ID collisions migrate to deterministic schema-4 IDs.
- Direct writes preflight lossless plain-JSON serializability, large journal imports avoid argument-spread limits, and merge imports cannot decrease live revision or journal sequence high-water marks.
- Memory isolation now applies consistently to recall, search, retrieve, and traverse; omitted project/scope resolves to the default/all-null memory scope.
- Merge/restore validation covers final relation endpoints, duplicate review/idempotency semantic identities, journal type/entity consistency in both import and direct replay, strict calendar timestamps, and bounded hard-purge gap arithmetic.
- Review identities use tuple encoding rather than delimiter concatenation, and legacy idempotency keys are collision-checked again after canonicalization.
- Review/maintenance inputs are fully preflighted before mutation, and MCP restores its pre-call graph snapshot for domain-operation exceptions so a later write cannot persist rejected state.
- Logical and hard purge markers no longer retain caller-controlled entity IDs. Logical replay derives project/entity/relation deletion structurally; hard markers retain only sequence-gap evidence. JSON/SQLite restart and restore preserve erasure.
- Every valid no-id JSON-RPC message is response-suppressed after execution, including successful `initialize`, `tools/list`, and `tools/call`; explicit `id:null` requests and parse errors still respond.
- JSON and SQLite saves/restores now share one destination lock domain across store handles and processes. A writer overlapping restore waits and is revision-checked against the installed state or fails explicitly; it can no longer return success and disappear after replacement. The fence has bounded timeout, heartbeat-backed stale-lock recovery, and immediate same-chain reentry errors for validation/activation callbacks.

### Honest limits

- Semantic retrieval is available only when embeddings are supplied or an embedding endpoint is explicitly configured; lexical fallback is never labelled semantic.
- No default LLM extractor, background file watcher, hosted cloud sync, competitor-parity claim, or measured comparative token/cost/answer-quality result is included. All seven preregistered arms are `NOT_MEASURED` in the retained comparative run because no common local/free LLM and embedding endpoint was available.
- Dependency installation/import success is setup evidence only and must not be described as a benchmark win. The word `best` and equivalent overall-superiority wording are prohibited for the current evidence.
- Confidence calibration remains unresolved. Optional verification is restricted to a separately configured local Ed25519 trust boundary and is not a general remote attestation system.
- Version 0.40.0 remains pre-Beta and `private: true`. Independent security review and actual preregistered comparative measurement remain release gates; package/install hardening and the measured local journal run do not satisfy either gate.

## 0.31.0 (unreleased — review candidate)

Closes the eight architectural gaps G1–G8 proven by the 2026-08-25 audit. Versioning note: this project is `0.x` and `private: true`, so per semver's pre-1.0 allowance the breaking input-contract change below ships as a **minor** bump rather than a major one, consistent with the project's existing 0.26 → 0.27 → 0.30 feature-bump history.

### Breaking

- **`addFact()` now rejects caller-supplied `verificationStatus: 'verified'` and `'expired'`** with an error. Previously both were accepted verbatim, and `source: 'human-confirmed'` or `'tool_observed'` silently auto-promoted a fact to `verified`. Trust is no longer self-assertable from tool input. `'contradicted'` is still accepted because it lowers trust. `'expired'` is owned by `maintain()`.
  **Migration:** stop passing `verificationStatus`. A fact's trust is now derived, not declared. If you relied on auto-verification, note that **nothing in this build reaches `verified` from tool input** — see `docs/handoffs/provenance-contract.md` §2 and open question U-1.
- **The no-source default changed from `model_inferred` to `agent_claimed`.** `model_inferred` is no longer producible. Unrecognised labels now downgrade to `agent_claimed` with the original string preserved in `sourceRaw` (audit only, not evidence).
  **Migration:** read `sourceClass`, not `source`. Stored legacy facts are backfilled on import; `source` is retained as a mirror for compatibility.
- **`SCHEMA_VERSION` is now `3`** (was `2`). v1 and v2 files still import — `SUPPORTED_SCHEMA_VERSIONS` is `[1, 2, 3]`.
- **`validate()` is stricter and returns severity-classified issues.** Legacy records with an unknown or missing decision `status` now surface as issues instead of validating clean. Data is **reported, never silently rewritten**.
- **Read paths return envelopes instead of bare arrays.** `search()`, `retrieve()`, and `context()` now return `{ items, page, completeness }`. See `docs/handoffs/completeness-contract.md`.
- **`addConfidenceEvidence()` now REQUIRES a `key`.** Previously an omitted key was synthesised from a timestamp, which silently defeated the documented retry-idempotency: the same observation retried a few milliseconds later got a different key and was counted twice.
  **Migration:** pass a stable `key` identifying the observation (e.g. `ci-run-4821`). Reuse it for retries of the same observation; use a new key for a genuinely new one. The MCP schema marks it required.
- **`importData()` now refuses an envelope `schemaVersion` outside `SUPPORTED_SCHEMA_VERSIONS`.** Previously an unknown future version was silently half-read. Individual future *records/facts* are still preserved verbatim and reported by `validate()` — only the whole-file envelope is refused.
- **Legacy facts without IDs now receive deterministic content-derived IDs.** Re-importing the same legacy payload preserves restart parity; an occurrence ordinal keeps identical duplicate facts distinct.
- **MCP behaviour changes a strict client may notice:** `resources/read` with an unknown URI and `prompts/get` with an unknown name now return `-32602` instead of the default context/policy payload; unknown methods return `-32601` instead of `{}`; notifications receive no response at all.

### Added

- Append-**oriented** journal carrying complete post-operation snapshots, plus a pure `rebuildProjection()` replay (`src/journal.js`). Rebuild is a fold over snapshots — it runs no domain logic, so a replay cannot mint trust.
- `journalEpoch` migration boundary. Pre-existing metadata-only events are retained and marked non-replayable rather than being claimed as replayable history.
- Logical/tombstone purge as the **default**, with hard purge as a separate explicit operation. Hard purge creates sequence gaps, which `journalGaps()` and `validate()` **declare** rather than hide.
- Evidence-weighted bounded confidence model with an auditable `basis` (`src/confidence.js`), replacing hardcoded ±0.1/−0.2 deltas.
- Declared-content-field search. Schema key names and internal metadata no longer match as content, and every hit cites the real field that matched.
- `shadowgraph_journal` MCP tool; provenance, pagination, and completeness surfaced across MCP/HTTP/CLI.

### Fixed

- **G1:** `review()` now evaluates `reopenWhen` rules against **stored** facts, so reconsideration survives a restart. Previously it only saw facts the caller re-supplied, meaning it worked only when the caller already knew the answer.
- **G7:** `search()` no longer reports `reason: 'Matched record content'` when no content field matched.

### Fixed — independent review findings (2026-08-25)

An independent review of the G1–G8 work found 18 further issues. All are closed, each with a regression test that fails on the pre-fix behaviour (`test/review-findings.test.js`, `test/review-interfaces.test.js`).

- **P0-1 purge left the idempotency cache intact.** `purgeProject()` deleted records, facts, relations, signals and journal payloads but not the idempotency entries — which hold *cloned payloads*. A purged decision's full content survived in `exportData().idempotency`, and replaying its key **returned the deleted entity**. Both `logical` and `hard` modes are fixed; purge now reports `idempotencyRemoved`.
- **P0-2 a failed replace destroyed the live graph.** `replaceData()` cleared every map *before* parsing, so a malformed payload left nothing to fall back on — worst possible behaviour in a recovery path (`restore`, revision-conflict reload). Data is now built in an independent staging graph and validated first. Additionally, the **envelope-level `schemaVersion` was never checked at all**, so a payload from an unknown future build was silently half-read; it is now refused.
- **P1-3** `/health` returned a hardcoded `0.30.0` while `package.json` and `src/mcp.js` each held their own literal. All three now read `src/version.js`.
- **P1-4** GET query parameters arrived as strings, so `?limit=2` was rejected as a non-integer and `minConfidence` would have compared a string. Typed parameters are coerced at the transport boundary; an uncoercible value is a specific `400`.
- **P1-5** every MCP failure was flattened to `-32000`. Codes are preserved: `-32601` unknown tool/method, `-32602` invalid params, `-32700` parse error, `-32000` genuine application errors.
- **P1-6** an unrecognised method replied `{"id":null,"result":{}}` to JSON-RPC *notifications*. Notifications are now never answered.
- **P1-7** `resources/read` returned the real context payload for **any** URI and `prompts/get` returned the policy text for **any** name — telling a client its request succeeded when the server had ignored it. Both validate their target and return `-32602`.
- **P1-8** confidence is `clamp(initial + sum(deltas), 0, 1)` — summed first, clamped **once**. Per-step clamping made the result depend on the order evidence arrived in. Permutation invariance is now tested.
- **P1-9** omitting `key` on confidence evidence synthesised a timestamped key, so a retry milliseconds later counted twice — the documented retry-idempotency was false exactly when it mattered. **`key` is now REQUIRED.**
- **P1-10** SQLite/JSON parity for the whole nested confidence structure (`current`, `initial`, `basis`, `contributions`, `history`, `policy`) is now proven by close/reopen tests on both backends, compared canonically.
- **P1-11** JSON restore now applies mandatory shared domain/journal validation even for direct JavaScript calls; malformed or unsupported input cannot replace the old file.
- **P1-14** SQLite restore no longer destroys the old database when the installed replacement fails to reopen or prepare. Source and live committed WAL state are folded into verified standalone snapshots with `VACUUM INTO`; the old snapshot is retained until replacement open/prepare/load/domain-validation succeeds. Recovery checks an existing destination read-only before any write-capable open, so inspection cannot fabricate an empty database. Corrupt journal folds, unexplained sequence gaps without a persisted hard-purge marker, and journal/live projection divergence are refused. Caught rename, post-rename, `DatabaseSync`, and preparation failures restore and reopen the old payload. Direct JavaScript, HTTP, CLI, and MCP restore all use mandatory shared validation; HTTP blocks writes and mutating context requests before graph change, and MCP no longer performs a second save after restore commits. Cleanup failure re-inspects the artifact family before reporting retained paths, so a delete-that-then-throws does not produce a false retained-artifact claim. Recovery failure is explicit with the rollback artifact preserved, and HTTP latches degraded mode so every authenticated non-health route request returns `503` until restart/manual recovery. This is process-level rollback safety, not crash or power-loss durability.
- **P2-19** project-scoped redaction now excludes other projects' review signals as well as idempotency payloads and secret-like keys.
- **P2-11** an unnumbered journal produced `Math.min(...[]) === Infinity`, an epoch that excluded every entry while reporting success. Now finite-or-null, with entries reported as non-replayable legacy.
- **P2-12** duplicate `seq` values made the fold order-dependent. Detected, `rebuildable: false`, and reported by `validate()` as an error.
- **P2-13** `isReplayable()` existed but was never called, so an entry explicitly marked `replayable: false` was replayed anyway. Now honoured, with diagnostic and status agreeing.
- **P2-14** future *record/fact* schemas are preserved verbatim and reported as `unsupported` — never silently downgraded. (Contrast P0-2: a future *envelope* is refused, because one uninterpretable entity is survivable and an uninterpretable file is not.)
- **P2-15** duplicate active fact scopes resolved by array order, so the same file reordered gave different reconsideration results. Recency is now `observedAt` with `id` as a total tie-break; the ambiguity is still reported.
- **P2-16/17/18** `completeness-contract.md` claimed invalid limits fall back to defaults when the code throws; the benchmark rejected `--sizes=…` equals form; and the report mixed journal performance with confidence calibration. All corrected.

### Documentation

- New contracts: provenance, lifecycle, journal, completeness, search, confidence.
- `integrations/agent-policy.md` no longer instructs agents to key off `model_inferred`, which the code cannot produce.
- README no longer describes the journal as "append-only" — hard purge deletes entries.

## 0.30.0 (public repository release candidate)

- Added persistent review signals, maintenance/aging, fact verification and expiry, idempotency, graph-aware retrieval, validation, repair planning, and backup/restore helpers.
- Added normalized relational SQLite tables, transactional legacy-envelope migration, repeated-save revision synchronization, and revision conflict detection for JSON and SQLite saves.
- Added MCP resources/prompts, local dashboard, agent policy assets, and expanded interface parity.
- This version is intentionally not published or pushed as a release.

## 0.27.0

- Added bounded relationship traversal with direction, depth, and relation filters.
- Added explicit same-project decision supersession with persisted `supersedes` relationships.
- Added privacy-safe redacted exports and permanent project purge controls across HTTP, CLI, and MCP.
- Added multi-term explainable search and matching HTTP, CLI, and MCP surfaces.

## 0.26.0

- Rewrote the user-facing README and integration guide to explain the context, decision, work, observe, evaluate, and reconsider workflow.
- Added practical setup guidance for MCP clients, HTTP clients, JSON/SQLite storage, and optional Bearer authentication.
- Added optional Bearer-token authentication for shared local HTTP deployments.
- Added constant-time token comparison and SQLite WAL verification.
- Added project-scoped fact supersession, localhost port compatibility, no-store headers, and CLI search filters.
- Added final release hardening and v0.26 documentation parity.

## 0.25.0

- Added selectable JSON/SQLite storage through `SHADOWGRAPH_STORAGE`, including WAL mode and a 5-second busy timeout for concurrent SQLite writers.
- Added decision lifecycle statuses, relationships, retrieval filters, and expanded MCP tools.
- Added concurrency-safe JSON saves and broader integration tests.

## 0.2.0 - 2026-08-24

- Redesigned the core as a versioned decision graph.
- Added project scopes, structured facts, evidence provenance, outcomes, confidence history, and event history.
- Added explainable search and the `shadowgraph_context` MCP tool.
- Added migration compatibility for v0.1 decision records.
- Added fact, outcome, context, and review HTTP/CLI surfaces.
- Added an optional Node 22.5+ `node:sqlite` storage adapter; JSON remains the zero-dependency default.

## 0.1.0 - 2026-01-01

- Added unified decision and rejected-alternative graph.
- Added persistent JSON storage.
- Added CLI, local HTTP API, and MCP stdio server.
- Added integration templates for MCP and generic HTTP clients.
