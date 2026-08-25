# Changelog

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
