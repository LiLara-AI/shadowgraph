# Product cycle — checkpoint

Branch `feat/decision-review-and-retrieval`, cut from verified `origin/main`
@ `2d932919df397158281b20dbc1ed76dde8a1a90f` (confirmed by fetch, not assumed).
Local commits only. No push, no merge to main. Arabic summary: `docs/handoff/summary-ar.md`.

## Environment and baseline

| Item | Value |
| --- | --- |
| Node | v24.18.0 (>= 22.5, so `node:sqlite` is live and SQLite tests do not skip) |
| Runtime deps | zero — `package-lock.json` has one entry, the root; no dependency field in `package.json`; every `src/` import is relative or `node:` |
| Baseline suite | **2149 tests, 2108 pass, 1 fail, 40 skipped, ~141 s** |
| Final suite, clean checkout | **2212 tests, 2172 pass, 0 fail, 40 skipped** (+63 tests) |
| Final suite, working checkout | 2212 / 2170 pass / **1 environmental fail** (see below) |

**Two pre-existing problems, neither caused nor fixed here:**

1. `npm run check` dies at `benchmark:check:python`. The `python3` on PATH is the Microsoft Store
   alias stub (`WindowsApps/python3`) — it exists as a file, so `command -v` finds it, but it errors
   on execution. The check is **unavailable on this host, not passing**. Every `node --check` before
   it passes; the JS half was run separately across 61 files and passes.
2. `test/benchmark-v11-definition.test.js:693` asserts no benchmark artifacts exist on disk, but the
   working checkout has `benchmark/results/` holding two dated run directories from 2026-08-27 —
   historical benchmark evidence, gitignored, **left untouched**. In a clean clone that directory
   does not exist and the guard passes, which is why the clean run is 0 fail. The guard was never
   suppressed.

## Git repair performed

A local Git worktree configuration issue was corrected after an external backup. Repository
content was unchanged.

- `.git/config` carried a `core.worktree` key pointing at a path the local Git client could not
  resolve, which made every git command fail. `git config --unset core.worktree` repaired the
  checkout.
- The original config was backed up outside the repository before the change, at
  `<local-backup-path>`. No config contents were copied into the repository.
- Sanitized before/after: the `[core]` section carried one extra key, `worktree`. After the repair
  that single line is gone; every other key in the file is byte-identical, and no other section
  changed.
- Rollback: restore the external backup over `.git/config`, or re-add the single `worktree` line.
- Of the registered worktrees, those with resolvable gitdirs resolve; the rest report `prunable`
  and **were not pruned**. Nothing outside this repository was modified.

## Commits

**Verified commit: `fd8aa3227d00e65d5ce7e8c27f8351236d260cda`** — every gate below was run against it in a
clean checkout. **Ten commits** ahead of `origin/main` at that point (an earlier draft of this
document said six, which was wrong); the closeout documentation commit that follows it changes no
code.

| # | SHA | What |
| --- | --- | --- |
| 1 | `ad3f045` | Three-valued condition evaluation; `conditionDiagnostics` / `maintain().diagnostics`; conflict exposure; strict-vs-stored rule validation |
| 2 | `e5c6630` | MCP output schemas for condition evidence; structured-tier budget raised with the measurement recorded |
| 3 | `c7b6600` | Attempt `resultClass`; `reusableWhen` evaluated with ALL-semantics |
| 4 | `a2ecac9` | Legacy id-collision references declared ambiguous rather than silently rebound |
| 5 | `7f536dc` | `recall()` ranks over live entities; `scripts/context-size.mjs` |
| 6 | `99e40ce` | Shared `foldText()` — Arabic and accented records findable; `scripts/retrieval-eval.mjs` |
| 7 | `052419f` | Checkpoint and plain-Arabic summary (docs) |
| 8 | `51b3ac4` | Folding precision cost disclosed; stale collection counts corrected (review findings) |
| 9 | `94e31fc` | Review outcome recorded; counts synced (docs) |
| 10 | `fd8aa32` | Compact review acknowledgement path; exact-original-text ranking preference |

## Status by workstream

- **A — review conditions: implemented and tested.** `src/condition-eval.js`, integrated into
  `review()`, `maintain()`, `context()`, `normalizeRules()`. Contract:
  `docs/contracts/review-conditions-contract.md`.
- **B — failure memory: implemented and tested.** `resultClass` with legacy fallback,
  `reusableWhen` evaluated, legacy-collision references declared. `redact()` deliberately
  unchanged — it was already on the safe side.
- **C — context efficiency: measured, then optimized.** The `recall()` core call went 2.31 → 0.70 ms.
  That figure is the **in-process operation measured in isolation**. It is not an end-to-end agent
  latency claim, and no end-to-end latency was measured at any point in this cycle. **No cache was
  added; the measurement did not justify one.**
- **D — retrieval: shipped, deterministic only.** Diacritic + Arabic orthographic folding.
  **No semantic component shipped or evaluated** — no inference was authorised, and that negative
  result is recorded in `docs/retrieval-decision-2026-09-13.md`.

## Implemented / deferred / not executed

**Implemented and tested**

- Three-valued condition evaluation with units, ranges, dates, categorical sets; write-time strict
  validation and lenient preservation of stored rules.
- Unresolved and contested conditions surfaced via `context().conditionDiagnostics` and
  `maintain().diagnostics`, bounded by the existing completeness contract.
- Attempt `resultClass` with the legacy wording heuristic as fallback; `reusableWhen` evaluated
  with ALL-semantics.
- Legacy id-collision references declared ambiguous by `validate()` instead of silently rebound.
- `recall()` ranks over live entities; returned page deep-cloned; isolation asserted directly.
- Shared `foldText()` diacritic and Arabic orthographic folding, plus exact-original-text ranking
  preference for the known collisions.
- Compact review acknowledgement path, proven end-to-end through the real server.
- Two measurement scripts: `scripts/context-size.mjs`, `scripts/retrieval-eval.mjs`.

**Deferred, with the reason**

- Semantic / embedding retrieval — no inference was authorised this cycle. `createEmbeddingClient`
  is untouched and its benefit for this product is **untested and unclaimed**.
- `Intl.Segmenter` tokenizer — viable and measured faster, but `small-icu` behaviour unverified, so
  it needs a capability guard. Not attempted.
- FTS5 for `recall()`'s lexical leg — available in `node:sqlite`, but it has no substring match and
  inherits the same harakat defect; deferred until in-memory scan is measured as the bottleneck.
- Arabic stemming / clitic handling (`كاش` vs `الكاش`) — not attempted.
- Exact-match preference inside `recall()`'s RRF fusion — deliberately not done; it needs a second
  token stream and a re-weighting, which is a retrieval-subsystem change.
- Review signals are still not journalled, so an acknowledgement does not survive `rebuild()`
  (pre-existing; `rebuild()` is a journal replay, distinct from the process restart proven below).
- Multi-tenant / separate-user isolation — out of scope for this cycle by the brief.

**Tests and checks NOT executed**

- `benchmark:check:python` — **unavailable**, not passing. The `python3` on PATH is the Microsoft
  Store alias stub at `WindowsApps/python3`; it exists as a file but errors on execution
  (`command -v` finds it, which is a false positive). So `npm run check` exits 49. The JS half of
  that chain was run separately and passes across all 61 files.
- No benchmark run of any kind, and no competitor comparison. Historical artifacts untouched.
- No inference calls, so no model-dependent behaviour was exercised.
- Linux and macOS paths untested — everything here ran on Windows 11 / Node v24.18.0 only.
- No end-to-end agent latency measured, so no such claim is made.
- 40 tests report as skipped by the suite itself; SQLite was **not** among them (proven below).

## Gates run on the integrated candidate

Run in a **clean verification clone** of `fd8aa32` (a clone, not a worktree, so the original
checkout's git config was untouched), Node v24.18.0, tree reported 0 modified files.

| Gate | Exit | Result |
| --- | --- | --- |
| `npm test` | **0** | **2212 tests, 2172 pass, 0 fail, 40 skipped, 22 suites** |
| `npm run check:mcp` | 0 | full 27 tools, **compact 13**, 0 errors, 0 warnings |
| `npm run check:package` | 0 | 119 files, private=true |
| `npm run check:integrations` | 0 | all four client templates valid |
| `npm run smoke:package` | 0 | clean tarball install, path with spaces, mcpCompactTools=13 |
| `assert-sqlite-coverage` | 0 | 8 pass, **0 skipped** — SQLite genuinely exercised |
| JS syntax, 61 files | 0 | pass |
| `npm run check` | **49** | **FAIL at `benchmark:check:python` — python3 unavailable** |

**The suite is green in a clean checkout.** The single failure reported throughout this cycle
(`test/benchmark-v11-definition.test.js:693`) was environmental: it asserts no benchmark artifacts
exist on disk, and the working checkout has `benchmark/results/` from 2026-08-27. A clean clone has
no such directory, so the guard passes. It was never suppressed, and the historical evidence was
never deleted — the working checkout still fails that one test, correctly.

Also verified by hand: new fields (`unit`, `resultClass`, breach evidence, `reusableAttempts`)
survive a **SQLite** save/load round trip, and `context()` / `maintain()` expose the new
collections through the shared surface, so CLI, HTTP and MCP all carry them.

## Measurements

Metadata bytes and context bytes are measured by **separate** scripts and never inferred from one
another. **No token measurement was taken, so no token claim is made anywhere.**

| Measurement | Before | After |
| --- | --- | --- |
| `recall()` core call, 70 records, in-process only | 2.31 ms | **0.70 ms** |
| tools/list full structured | 156,333 B | 172,527 B (+16,194) |
| tools/list full bare / annotated | 42,166 / 45,000 B | +299 each |
| retrieval eval, dev (15 cases) | search 7, retrieve 7, recall 10 | **11 / 11 / 13** |
| retrieval eval, held-out (10 cases) | not run before | search 7, retrieve 7, recall 9 |

Held-out was run **once, at the end**, after all tuning. Zero cross-project leaks on every engine
in both splits.

## Independent changed-surface review

Run once, on the finished snapshot, by an agent that did not write the code.

**No CRITICAL or HIGH findings.** It read `src/hybrid-search.js` end to end and confirmed
`hybridSearch()` mutates nothing it is handed (every `filter`/`map`/`sort` acts on locally built
arrays, no property assignment onto any record), and that `recall()` deep-clones the returned page
before it leaves. It confirmed scope filtering still precedes ranking in both paths, traced the
three-valued edge cases independently, and reproduced the measured figures — suite counts, the
`context-size` timings, and the exact `mcp-wire-size` byte totals — including that the raised
budgets carry real headroom rather than being padded to hide growth.

Three findings, all acted on in `51b3ac4`:

1. **The Arabic fold's precision cost was undisclosed, and one test mislabelled it.** `ى`→`ي`
   collapses `على` with `علي`, and `آ`→`ا` collapses `آمن` with `امن` — real minimal pairs, not
   spellings of one word. The fold is kept as the standard Arabic IR trade, but it is now stated as
   a trade in the contract, the decision record and the CHANGELOG, with both collisions asserted
   under their real meaning.
2. **`src/mcp-tools.js` still advertised "five named collections"** in an output schema a client
   reads as a contract; this cycle made it seven. Corrected there and in two other documents.
3. **A `unit` on `equals`/`not_equals`/`contains` is silently inert** — only ordered operators and
   `between` convert. Legacy contract held deliberately, now called out where it lives.

## Closeout changes (commit 10)

**Compact acknowledgement — now implemented, previously the one incomplete planned item.** The gap
was two-part: `shadowgraph_ack_review` was not advertised in compact, *and* `context().openReviews`
carried no signal id, so promoting the tool alone would have given a client a tool with no way to
name a target. The only id route was `shadowgraph_maintain`, which also stales decisions and expires
facts — a maintenance write, not a listing route.

Fixed minimally: `due` entries gained additive `reviewSignalId` / `reviewSignalStatus`, and
`shadowgraph_ack_review` was promoted (12 → 13 tools). No new tool was invented; listing reuses
`shadowgraph_context`, which compact already had. `benchmark/lib/node-adapter-host.mjs` mirrors the
inventory and compares it for exact equality against `tools/list`, so that one list had to track the
surface — inventory only, no scenario, scoring or execution change, no historical artifact touched.

Proven in `test/compact-review-ack.test.js`, end-to-end against the real server with
`SHADOWGRAPH_MCP_COMPACT=1`: list → acknowledge → **restart the process against the same file** →
still acknowledged → breach a second decision → new open signal with a different id → close it. A
second test covers the same decision broadening its reason, where the signal key changes and the
narrow acknowledgement correctly does not cover the wider breach.

**Arabic matching precision — review comment accepted.** Exact original-text matches now outrank
fold-only matches. Folding decided *whether* a record matched but nothing about order, so a record
holding the word the caller typed scored identically to one holding only its near-twin. Ranking only:
no record admitted or excluded, stored text untouched, scope isolation unaffected, exact identifiers
only reinforced. Tests assert order with both meanings present, not fold equality.

Budget moved once more, measured and recorded beside the assertion: compact description total
3,997 → 4,338 characters against a 4,300 ceiling, raised to 4,450 — the whole difference being the
promoted tool's own 341-character description, itself under the 350 per-description cap.

## Next development backlog

1. `Intl.Segmenter` behind a `typeof` guard — CJK support, cleaner Arabic segmentation, and measured
   *faster* than the current regex. Its `small-icu` behaviour is unverified.
2. FTS5 for `recall()`'s lexical leg — only once in-memory scan is measured as the bottleneck, and
   only with the fold applied before insert (FTS5's `unicode61` has the identical harakat defect).
3. Revisit embeddings when inference is authorised; the `paraphrase` and `crossLanguage` categories
   are already in the harness and already failing, so there is a target to beat.
4. Arabic stemming / clitic handling — `كاش` still does not match `الكاش`.
5. Exact-match preference inside `recall()`'s RRF fusion, if the asymmetry with `search()` proves to
   matter in practice.
6. Review signals are not journalled, so an acknowledgement does not survive `rebuild()`
   (pre-existing, documented at `docs/api-reference.md:142-144`). Distinct from process restart,
   which is proven to preserve it.
7. Install a real `python3` on the dev host, or make `benchmark:check:python` skip explicitly rather
   than fail, so `npm run check` has an honest exit code.
