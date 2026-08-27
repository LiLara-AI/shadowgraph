# ShadowGraph — Current Status

**Last updated:** 2026-08-27
**Version:** 0.40.0 (unreleased unified-memory review candidate) · **Schema:** 4 · **Branch:** `main` with an uncommitted review tree.
**Phase:** The v0.31 decision-first contracts remain; v0.40 adds scoped general memory, temporal/hybrid recall, localhost-first embeddings, Markdown push/pull, and JavaScript/CLI/HTTP/MCP surfaces. ADR-0006 is accepted. Older review tables below are retained as historical evidence, not the current release summary.

## Suite state

    npm test              -> 372 tests / 367 pass / 0 fail / 0 skipped / 5 todo
    npm run check         -> exit 0
    npm run check:package -> exit 0 (62 files)
    npm audit --omit=dev  -> 0 vulnerabilities
    git diff --check      -> exit 0; one existing LF→CRLF warning for test/compact-mcp.test.js
    ADR citation verify   -> strict pass
    retrieval benchmark  -> not run / not measured

The current suite has 372 tests, including the existing restore/fault/interface coverage plus unified-memory reconciliation, temporal handoff, scoped isolation across recall/search/retrieve/traverse, JSON/SQLite parity, Markdown atomicity/read-back reconciliation, embedding safety, bounded hard-purge evidence validation, delimiter-safe review identities, canonical idempotency collision checks, journal type/entity consistency, legacy namespace migration, large-journal import safety, and CLI/HTTP/MCP concurrency/durability regressions.

The 5 remaining `todo` entries are all labelled `BLOCKED ON <id>` and name a real open decision (U-1 x2, L-1, L-2, L-5). **No characterization test for known-bad behaviour remains** — the only surviving mention of the word is a methodology comment explaining why such a test must fail once its gap is fixed.

## Historical v0.31 independent review findings — all 18 closed

| ID | Finding | Regression tests |
| --- | --- | --- |
| **P0-1** | `purgeProject()` left the idempotency cache intact. It holds **cloned payloads**, so a purged decision's content survived in `exportData().idempotency` and replaying its key **returned the deleted entity**. | `review-findings` x7 |
| **P0-2** | `replaceData()` cleared every map *before* parsing, so a malformed payload destroyed the live graph. Also: the **envelope `schemaVersion` was never checked at all**, so an unknown future payload was silently half-read. | `review-findings` x7 |
| **P1-3** | `/health` returned a hardcoded `0.30.0` while `package.json` and `src/mcp.js` each held their own literal. | `review-interfaces` x1 |
| **P1-4** | GET query params arrived as strings, so `?limit=2` was rejected as a non-integer and `minConfidence` compared a string. | `review-interfaces` x5 |
| **P1-5** | Every MCP failure flattened to `-32000`. | `review-interfaces` x5 |
| **P1-6** | Notifications received `{"id":null,"result":{}}`. | `review-interfaces` x2 |
| **P1-7** | `resources/read` served context for ANY uri; `prompts/get` served policy for ANY name. | `review-interfaces` x4 |
| **P1-8** | Confidence clamped per step, making the result depend on evidence arrival order. | `review-findings` x6 |
| **P1-9** | An omitted evidence `key` was timestamp-synthesised, so a retry ms later double-counted. | `review-findings` x4 |
| **P1-10** | No SQLite/JSON parity proof for the nested confidence structure. | `review-findings` x3 |
| **P2-11** | `Math.min(...[])` produced an `Infinity` epoch that excluded every entry while reporting success. | `review-findings` x3 |
| **P2-12** | Duplicate `seq` made the fold order-dependent. | `review-findings` x4 |
| **P2-13** | `isReplayable()` was written but never called. | `review-findings` x3 |
| **P2-14** | Future record/fact schemas were silently downgraded. | `review-findings` x4 |
| **P2-15** | Duplicate active fact scopes resolved by array order. | `review-findings` x4 |
| **P2-16** | `completeness-contract.md` contradicted the code on invalid limits. | doc |
| **P2-17** | `npm run bench -- --sizes=...` equals form was rejected. | both forms verified |
| **P2-18** | Benchmark report mixed journal performance with confidence calibration. | doc |

The two P0 findings were the serious ones — both were **data-loss** bugs. P0-1 resurrected purged data through a cache nobody had thought of as storage. P0-2 destroyed the live graph on a failed recovery-path import: the operation that runs when something is *already* wrong was itself capable of losing everything.

## Historical v0.31 gap status

| Gap | Status | Evidence |
| --- | --- | --- |
| **G1** reconsideration reads stored facts | fixed | 10 acceptance tests incl. JSON reload + real SQLite close/reopen; survives 4 restarts |
| **G2** provenance is a claim, not proof | fixed | 18 acceptance tests; 3 self-assertion bypasses closed |
| **G3** lifecycle unified | fixed | 15 acceptance tests; 13 states classified; drift guard |
| **G4** journal + rebuild | fixed | X-3 equivalence PASSED; P2-11/12/13 hardened the replay contract |
| **G5** purge semantics | fixed | logical default, hard explicit, gaps declared, **P0-1 idempotency hole closed** |
| **G6** completeness/pagination | fixed | envelope everywhere; invalid limits throw; HTTP query typing (P1-4) |
| **G7** search semantics | fixed | declared content fields only; every hit cites a real field |
| **G8** confidence basis | implemented; calibration **NOT** claimed | P1-8 fold, P1-9 dedupe, P1-10 backend parity |

## Honest limits

## Historical v0.32 hardening review status

- **P1-11 fixed:** malformed JSON restore is staged and mandatorily domain-validated on direct JavaScript, HTTP, CLI, and MCP paths before replacing the active file; failed restore preserves the prior valid file.
- **P1-13 fixed:** malformed HTTP SQLite restore is loaded and validated before database replacement; JSON/SQLite restore semantics now match.
- **P1-14 fixed:** SQLite restore keeps verified standalone source and rollback snapshots. A caught failure during rename, post-rename `DatabaseSync` reopen, schema preparation, load, or validation restores and reopens the old payload before returning `sqlite_restore_rolled_back`; failed recovery is explicit and retains its rollback artifact. Recovery inspects a candidate destination read-only before any write-capable open, so a missing path cannot become an empty live database. Source and live committed WAL state are folded with `VACUUM INTO`; restore also rejects corrupt journal folds (including skipped entries and impossible epochs) and journal/live projection divergence. Domain validation is mandatory for direct JavaScript, HTTP, CLI, and MCP restores; HTTP rejects writes and mutating `/context` calls before graph mutation while restore owns persistence; after `sqlite_restore_recovery_unconfirmed`, it latches degraded mode and returns `503` for every authenticated non-health route request until restart, so it cannot serve or further mutate potentially divergent state. MCP does not perform a second save after restore commits. Cleanup failures report retained artifacts. The guarantee is process-level rollback safety, not crash consistency or filesystem durability.
- **P1-12 fixed:** SQLite creates its parent directory before opening a new database, matching JSON deployment behavior.
- **P2-19 fixed:** project-scoped redaction now excludes other projects' idempotency payloads and review signals, and redacts idempotency/cache key values.
- **P2-20 fixed:** JSON and SQLite storage expose the documented `load()` / `save()` / `close()` surface.
- Review acknowledgment remains snapshot-persisted but not journal-replayed, as documented; no product decision was silently invented.

- **Nothing reaches `verificationStatus: 'verified'` from tool input.** Deliberate. **U-1** blocks any change.
- **No token, cost, latency, or tool-call benchmark exists.** Only journal performance is measured.
- **Confidence calibration is not established** and is not claimed anywhere. Weights are a declared policy, not a fitted model.
- **MCP is `2024-11-05`**, four revisions behind current. No newer support claimed; no client interop tested (X-1).
- Storage: ~36 MB persisted at 10k journal entries; SQLite save ~2.6x JSON (X-4, now measured not suspected).

## Deferred, with reason / impact / workaround / test / next action

| Item | Reason | Impact | Workaround | Non-collapse test | Next action |
| --- | --- | --- | --- | --- | --- |
| **U-1** verification channel | No channel exists that the writer does not control | Nothing reaches `verified` | Treat all facts as hypotheses | G2 suite + `R3b` | **Accepted unverified-only for 0.31.0**; revisit only with a separately authorized mechanism |
| **U-2** privileged `tool_observed` re-verify | Needs an execution capability ShadowGraph lacks | Tool reports weigh but never verify | — | G2 suite | Ruling after U-1 |
| **U-3** legacy `verified` on disk | No marker separates pre-fix from future genuine | Preserved, never elevated | — | `R3b`, `P2-14` | Migration marker if U-1 lands |
| **L-1** entry state `active` vs `proposed` | Changing it alters `context()` and breaks 2 tests | Entry state is a validity state | — | G3 drift guard | Product decision |
| **L-2** transition enforcement | Docs diagram may be illustrative | any->any allowed | — | G3 suite | Decide normative or not |
| **L-5** `stale`/`archived` meaning | No producer in code | Accepted, deprecated | — | G3 suite | Give meaning or migrate out |
| **ADR-0004 warm-task benchmark** | Large separate build | No cost/token claim is possible | — | — | Implement the 5-phase benchmark |
| **MCP `2026-07-28`** | Needs real client interop testing | Legacy-era server | Use a legacy/dual-era client | `interfaces`, `compact-mcp`, `review-interfaces` | Scheduled maintenance |
| **100k-entry benchmark** | ~360 MB temp per run; 36x headroom already shown | Unknown at that scale | `--sizes 100000 --runs 3` | — | Run deliberately if needed |
