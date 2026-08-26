# ShadowGraph — Test and Benchmark Log

Chronological historical log; newest session at the bottom. This wording concerns this handoff document, not the ShadowGraph journal contract. Record the exact command, the real output, and what it proves.

---

## Session 2026-08-25 (part 1) — Hermes Agent (claude-opus-5): verification of brief claims

### Environment

```
Host:  Windows 11, git-bash (MSYS)
Node:  v24.18.0
Repo:  C:\Users\aelkh\AI Projects\test deepseek
```

### T1 — Repository identity

```bash
cd "/c/Users/aelkh/AI Projects/ShadowGraph" && git log --oneline -8
```
```
fatal: not a git repository (or any of the parent directories): .git
```

```bash
cd "/c/Users/aelkh/AI Projects/test deepseek" && git log --oneline -4 && git remote -v
```
```
1dde968 Add compact lossless MCP mode
32432c6 Normalize MCP memory field aliases
817aaff Fix MCP project-scoped recording
166dd83 Release ShadowGraph v0.30 relational storage
origin  https://github.com/LiLara-AI/shadowgraph.git (fetch)
origin  https://github.com/LiLara-AI/shadowgraph.git (push)
```

Doc-folder comparison — all 8 files byte-identical:
```
IDENTICAL: shadowgraph-next-session-brief.md
IDENTICAL: shadowgraph-vision-scope.md
IDENTICAL: shadowgraph-product-manager-current.md
IDENTICAL: shadowgraph-security-and-safety.md
IDENTICAL: shadowgraph-redesign-proposal.md
IDENTICAL: shadowgraph-benchmark-plan.md
IDENTICAL: shadowgraph-competitor-research-notes.md
IDENTICAL: shadowgraph-session-start.md
```

**Proves:** the real repo is `test deepseek`; `ShadowGraph/` is a stale docs-only copy, not version-controlled. Per user directive both folders remain in place unchanged.

### T2 — Full test suite

```bash
npm test
```
```
ℹ tests 41
ℹ suites 0
ℹ pass 41
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1668.9218
```

**Proves:** the brief's "41 passing tests" claim is accurate. Exit code 0.

### T3 — Syntax check

```bash
npm run check
```
Exit 0. All 8 `node --check` invocations clean (`shadowgraph.js`, `storage.js`, `sqlite-storage.js`, `server.js`, `cli.js`, `mcp.js`, `backup.js`, `revision-store.js`).

### T4 — Security audit

```bash
npm audit --omit=dev
```
```
found 0 vulnerabilities
```

```bash
node -e "const l=require('./package-lock.json');console.log('lockfile packages:',Object.keys(l.packages||{}).length)"
```
```
lockfile packages: 1
```

**Proves:** zero vulnerabilities is real, and trivially so — the project has **zero runtime dependencies**. A genuine architectural strength worth preserving.

### T5 — Whitespace/diff check

```bash
git diff --check
```
Clean.

### T6 — Architecture gap probe (read-only, temporary, deleted after run)

A throwaway `.probe-audit.mjs` was written, executed against `src/shadowgraph.js` in memory only (no storage writes), then removed. `git status` confirmed clean afterwards. Verbatim output:

```
P1 stored-fact triggers review (no args): 0
P1 caller must re-supply fact: 1
P1 decisionId: decision_178...
P2 source: human_confirmed
P2 verificationStatus: verified
P2 arbitrary source accepted: totally_made_up_source
P2 decision has provenance fields: []
P3 proposed: accepted
P3 planned: REJECTED
P3 in_progress: REJECTED
P3 executed: REJECTED
P3 validated: accepted
P3 failed: accepted
P3 reconsidered: REJECTED
P3 superseded: accepted
P3 abandoned: REJECTED
P4 event count: 2
P4 event keys: ["id","type","at","project","recordId"]
P4 event carries full payload?: false
P4 rebuild-from-events-only decisions: 0
P5 events before purge: 1
P5 events after purge: 0
P6 retrieve() no-limit type: bare Array (no total/hasMore)
P6 retrieve() with-limit keys: ["items","page"]
P6 search() type: bare Array (no pagination possible)
P6 context() has page/completeness: false
P6 context() keys: ["project","activeDecisions","staleAssumptions","failedAttemptsToAvoid","openReviews","suggestedQuestions"]
P7 query "title" matches unrelated record: 1
P7 query "schemaVersion" matches: 1
P7 query "confidence" matches: 1
P8 confidence keys: ["initial","current","history"]
P8 has basis object: false
```

**What each result proves** (gap IDs map to `current-status.md` §4):

- **P1 → G1.** A fact stored via `addFact({key:'deployment', value:'multi-user'})` matching an alternative's `reopenWhen` rule produced **0** review results. The identical fact passed as a *call argument* produced 1. Reconsideration does not consult stored state. Defeats "changed facts reopen decisions" across a restart.
- **P2 → G2.** `source` is free text (`totally_made_up_source` accepted). An agent writing `source:'human-confirmed'` gets `verificationStatus:'verified'` automatically — it can manufacture human confirmation. Decisions have no provenance fields.
- **P3 → G3.** 5 of the 9 brief-mandated lifecycle states are rejected. Implemented set is `proposed|active|aging|stale|validated|failed|superseded|archived` — a *different* vocabulary from the documented one.
- **P4 → G4.** Events are metadata-only pointers. Alternatives, rejection reasons, and assumptions appear nowhere in the event. Rebuilding from `{events}` alone yields 0 decisions. There is no ledger.
- **P5 → G5.** `purgeProject` removed the event. The array is mutable, not append-only.
- **P6 → G6.** `context()` (the primary pre-task entry point) and `search()` return unbounded bare arrays with no completeness metadata. Only `retrieve()` *with an explicit `limit`* returns `{items, page}`.
- **P7 → G7.** Because `search()` does `JSON.stringify(record).toLowerCase().includes(term)`, schema key names are matchable. `confidence` and `schemaVersion` return records containing neither word in their content.
- **P8 → G8.** Confidence deltas are hardcoded constants (+0.1/−0.2) with no evidence basis, no source-class weighting, no contradiction accounting.

---

## Session 2026-08-25 (part 2) — research verification and doc revision

### T7 — Primary-source verification of MCP claims (user directive 4)

Not a test of the repo — a verification of claims *about* the repo's environment. Method: `web_extract` (direct page retrieval), all accessed **2026-08-25**.

| Target | Source | Result |
| --- | --- | --- |
| Current protocol version | `modelcontextprotocol.io/docs/learn/versioning` | *"The **current** protocol version is **2026-07-28**."* — and the page's own **Draft / Current / Final** vocabulary confirms it is **Current**, not draft/proposal/future |
| Stable release confirmation | `github.com/.../modelcontextprotocol/releases` | tag `2026-07-28`, *"stable release"*, 28 Jul 2026, commit `5f5440b`, GPG-verified; separate earlier `2026-07-28 RC` tag |
| `initialize` handshake | `/specification/2026-07-28/basic/versioning` | *"**There is no negotiation handshake.**"* Changelog: *"remove the `initialize`/`notifications/initialized` handshake."* |
| `server/discover` | same | *"Servers **MUST** implement `server/discover`."* Clients **MAY** call it |
| Legacy interop | `docs/learn/versioning` | Points to Backward Compatibility for *"handshake-based protocol revisions (`2025-11-25` and earlier)"*; spec defines a **Dual-era** category |
| `node:sqlite` maturity | `nodejs.org/api/sqlite.html` | **Stability 1.2 — Release Candidate**; added v22.5.0; RC at v25.7.0. Contradicts a secondary source claiming "stable in Node 24" — primary wins |

**Repository comparison (code read, nothing modified):** `src/mcp.js:80` hardcodes `protocolVersion: '2024-11-05'`, implements the removed handshake, and does not implement `server/discover`. Distance: **four** revisions (`2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`).

**Corrections this produced:** the earlier "near-breaking" framing was **overstated** (backward compatibility is explicitly specified → scheduled maintenance); "five revisions behind" was a **miscount** → four.

**Retrieval failures, recorded not filled:** `anthropic.com/engineering/code-execution-with-mcp` → `web_extract` 403 (keyless backend); two `web_search` calls (Zep/Graphiti bi-temporal paper; event-sourcing criticism) → 403. The Zep paper was therefore **never opened**; its arXiv ID and schema details remain unverified.

### T8 — Post-revision verification run

Commands run after all seven handoff documents were rewritten. See the "Verification results" block below for verbatim output.

---

## Session 2026-08-25 (part 3) — Phase 0: characterization tests

### T9 — `test/gap-regressions.test.js` created (418 lines, 8 describe blocks, no dependencies)

```bash
node --test --test-concurrency=1 test/gap-regressions.test.js
```
```
ℹ tests 45
ℹ suites 8
ℹ pass 26
ℹ fail 0
ℹ todo 19
ℹ duration_ms 116.7888
```

Full suite: `tests 86 / pass 67 / fail 0 / todo 19`.

**Proves:** all 26 characterization assertions matched the behaviour predicted in the T6 probe. **No assumption in the report was wrong; no test needed correcting; no production code was touched.**

### T10 — Two NEW defects discovered while writing the tests

1. **Second G2 self-assertion bypass:** `addFact({ source:'agent_claimed', verificationStatus:'verified' })` is accepted verbatim — `src/shadowgraph.js` line ~80 uses `input.verificationStatus ?? …`, so a caller can set the verification status directly regardless of source. Closing only the `human-confirmed` path would leave provenance forgeable.
2. **`production_verified` is not a recognised class:** documented as the strongest provenance class, it yields `verificationStatus: 'unverified'`.

Also confirmed: **`test/v030.test.js:13–15` asserts the G2 bug as desired behaviour**, so the G2 fix must update that existing test or the suite will fail on a correct fix.

---

## Session 2026-08-25 (part 4) — Phase 1: G1 fix

### T11 — Production change

`src/shadowgraph.js` only, **+25 / −1**. Added `storedFactValues(project)`; `review()` now matches object-form `reopenWhen` rules against `{ ...storedFacts, ...callerFacts }`. No public API change, no new dependency, no other `src/` file touched.

### T12 — G1 acceptance tests (converted from characterization)

```bash
node --test --test-concurrency=1 test/gap-regressions.test.js
```
```
▶ G1 (S1) — FIXED: reconsideration reads facts that are already stored
  ✔ ACCEPTANCE: a stored fact matching reopenWhen produces a review signal with no arguments (2.7533ms)
  ✔ ACCEPTANCE (regression guard): call-argument facts keep working exactly as before (0.1853ms)
  ✔ ACCEPTANCE: reconsideration survives persist + reload (JSON backend) (18.0841ms)
  ✔ ACCEPTANCE: reconsideration survives a real SQLite store close + reopen (28.0356ms)
  ✔ ACCEPTANCE (false-positive guard): an irrelevant stored fact produces NO signal (0.3995ms)
  ✔ ACCEPTANCE (false-positive guard): a stored fact with a non-matching VALUE produces NO signal (0.2383ms)
  ✔ ACCEPTANCE (project scoping): a stored fact in project A never reopens a decision in project B (0.2326ms)
  ✔ ACCEPTANCE (superseded facts): a stale fact does not keep a decision permanently due (0.2244ms)
  ✔ ACCEPTANCE (documented precedence): caller-supplied facts OVERRIDE stored facts of the same key (0.2649ms)
  ✔ ACCEPTANCE (documented semantics): string-form rules still match changedFacts only, not stored facts (0.3927ms)
✔ G1 (S1) — FIXED: reconsideration reads facts that are already stored (52.0056ms)
```

**10/10 pass**, including a genuine SQLite backend restart (`store.close()` → `createSqliteStore(file)` → `importData(load())`).

### T13 — Full suite after the fix

```bash
npm test
```
```
ℹ tests 90
ℹ suites 8
ℹ pass 74
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 16
ℹ duration_ms 1751.5904
```

Delta from Phase 0 (`86 / 67 / 0 / 19`): 3 G1 characterization tests and 3 G1 `it.todo` markers were replaced by 10 acceptance tests → `+4` total, `+7` pass, `−3` todo.

**Zero regressions.** None of the 41 pre-existing tests changed behaviour, and none was modified. Specifically unaffected: `shadowgraph.test.js` "reopens it when facts change" (string rule + `changedFacts`), `v02-regressions.test.js` "only alternatives whose rules matched" (string rules), `v02.test.js` "explainable search results and context" (object rule + caller-supplied facts, no stored fact of that key), `v030.test.js` "maintenance ages decisions" (string rule).

**Why no regression:** the string-rule path was left untouched, and no pre-existing test stores a fact whose key collides with an object-form `reopenWhen` rule.

---

## Session 2026-08-25 (part 5) — Phase 2: G2 fix (provenance and verification)

### T14 — Contract written BEFORE code

`docs/handoffs/provenance-contract.md` created first, per directive. It answers each required question: the four official classes; what `verified` means; the distinction between classes; what a "verifiable reference" would be; whether an evidence mechanism exists (**it does not**); what happens to an unknown source; and reject-vs-downgrade.

### T15 — Behavioural probe before touching tests (temporary, deleted after run)

A throwaway `.g2-probe.mjs` exercised every contract rule against the patched core, then was removed (`git status` verified clean). Verbatim output:

```
human-confirmed  -> human_confirmed | unverified | raw: human-confirmed | source: human_confirmed
tool_observed    -> tool_observed | unverified | raw: undefined
production_verif -> production_verified | unverified
unknown          -> agent_claimed | unverified | raw: totally_made_up
omitted          -> agent_claimed | unverified | raw: undefined
DIRECT verified  -> THROWS: A caller cannot set fact verificationStatus to verified
expired          -> THROWS: A caller cannot set fact verificationStatus to expired
contradicted     -> contradicted
bogus            -> THROWS: Invalid fact verificationStatus
fact prov        -> {"a":"claude","c":"claude-cli","s":"s1"}
decision prov    -> {"sc":"tool_observed","a":"claude","c":"cli","s":"s2"}
bad actor        -> THROWS: actor must be a string when provided
roundtrip fact   -> {"sc":"tool_observed","a":"claude","c":"claude-cli","s":"s1","v":"unverified"}
roundtrip decis  -> {"sc":"tool_observed","a":"claude","c":"cli","s":"s2"}
legacy verified  -> verified
```

**Third bypass discovered here:** the pre-fix code auto-verified **`tool_observed`** as well as `human_confirmed`. The Phase 0 report had identified only two bypasses; there were three.

### T16 — G2 acceptance tests

```bash
node --test --test-concurrency=1 test/gap-regressions.test.js
```
```
▶ G2 (S1) — FIXED: provenance is a claim, and trust cannot be self-asserted
  ✔ ACCEPTANCE: self-asserted human-confirmed does NOT yield verified (0.2591ms)
  ✔ ACCEPTANCE: self-asserted production_verified does NOT yield verified (0.1049ms)
  ✔ ACCEPTANCE: self-asserted tool_observed does NOT yield verified (was ALSO a bypass) (0.0849ms)
  ✔ ACCEPTANCE: a caller CANNOT force verified via verificationStatus (0.4597ms)
  ✔ ACCEPTANCE: a caller CANNOT set expired (owned by maintain) (0.0969ms)
  ✔ ACCEPTANCE: contradicted IS accepted because it lowers trust (0.0807ms)
  ✔ ACCEPTANCE (regression guard): an unknown verificationStatus still throws the original error (0.0957ms)
  ✔ ACCEPTANCE: an unknown source gets no more trust than agent_claimed, and the raw label is kept (0.0859ms)
  ✔ ACCEPTANCE: a near-miss label cannot sneak into a trusted class (0.0894ms)
  ✔ ACCEPTANCE: an omitted source defaults to agent_claimed with no raw label (0.07ms)
  ✔ ACCEPTANCE: fact provenance metadata is stored as plain JSON (0.1284ms)
  ✔ ACCEPTANCE: decision provenance metadata is stored (0.1265ms)
  ✔ ACCEPTANCE: non-string provenance values are rejected (no live objects stored) (0.1426ms)
  ✔ ACCEPTANCE: provenance survives exportData / importData (0.291ms)
  ✔ ACCEPTANCE: provenance survives a JSON store persist + reload (22.7294ms)
  ✔ ACCEPTANCE: provenance survives a real SQLite close + reopen (26.6374ms)
  ✔ ACCEPTANCE (documented residual risk): import PRESERVES a stored verified status without elevating it (0.2593ms)
  ✔ ACCEPTANCE (regression guard): the legacy `source` field still mirrors the class (0.1156ms)
  ✔ BLOCKED ON U-1: define how a fact can ever legitimately become `verified` … # TODO
  ✔ BLOCKED ON U-1: accept a re-checkable evidence reference … # TODO
✔ G2 (S1) — FIXED: provenance is a claim, and trust cannot be self-asserted (52.418ms)
```

**18/18 acceptance pass**, both backends covered.

### T17 — Full suite after the G2 fix

```bash
npm test
```
```
ℹ tests 101
ℹ suites 8
ℹ pass 86
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 15
ℹ duration_ms 1829.1439
```

Delta from Phase 1 (`90 / 74 / 0 / 16`): +11 tests, +12 pass, −1 todo (6 G2 characterization + 3 todo → 18 acceptance + 2 todo).

**One existing test intentionally updated:** `test/v030.test.js` "normalizes common MCP aliases…" — its `assert.equal(fact.verificationStatus, 'verified')` pinned the G2 defect as desired behaviour. Now asserts `'unverified'` plus `sourceClass`/`sourceRaw`, with an in-file comment recording what changed and why. The alias normalization it was really testing is unchanged.

**No other existing test changed behaviour.** `test/v02.test.js` still passes because the legacy `source` field mirrors `sourceClass`.

---

## Session 2026-08-25 (part 6) — Phase 3: G3 fix (decision lifecycle)

### T18 — Contract written BEFORE code

`docs/handoffs/lifecycle-contract.md`. Classification came from reading every producer and consumer of `record.status`, which revealed the four undocumented states are **not the same kind of thing** — so merging the two lists naively would have been wrong.

### T19 — Probe before writing tests (temporary, deleted after run)

`.g3-probe.mjs`, removed after use. Verbatim output:

```
canonical count: 13 | documented: 9 | legacy: 4
documented rejected/mismatched: NONE — all 9 accepted
legacy rejected: NONE — all 4 accepted
alias "IN_PROGRESS" -> in_progress
alias "in-progress" -> in_progress
alias " In-Progress " -> in_progress
alias "In_Progress" -> in_progress
archived stays archived: archived
unknown "bogus" -> THROWS: Invalid decision status: bogus
unknown "in progress" -> THROWS: Invalid decision status: in progress
unknown "" -> THROWS: Invalid decision status:
unknown "ACTIVE!" -> THROWS: Invalid decision status: ACTIVE!
unknown 123 -> THROWS: Invalid decision status: 123
unknown null -> THROWS: Invalid decision status: null
unknown undefined -> THROWS: Invalid decision status: undefined
addDecision default status: active
event status canonical: in_progress
imported legacy count: 4 | statuses: active,aging,stale,archived
validate after legacy import: {"valid":true,"issues":[]}
unknown stored status preserved: totally_bogus
validate flags it: {"valid":false,"issues":[{"code":"unknown_decision_status","recordId":"weird","status":"totally_bogus"}]}
repairPlan action: {"apply":false,"actions":[{"action":"manual_review","code":"unknown_decision_status","recordId":"weird","status":"totally_bogus"}]}
missing status -> undefined | validate: {"valid":false,"issues":[{"code":"unknown_decision_status","recordId":"old","status":null}]}
roundtrip status: in_progress | validate: true
search canonical matches: 1
```

### T20 — The intended failure, then the fix

Immediately after the production change, the full suite showed **exactly one failure**:

```
✖ CHARACTERIZATION (current, defective): 5 of the 9 documented states throw
  AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal
ℹ tests 101  ℹ pass 85  ℹ fail 1  ℹ todo 15
```

That is the Phase 0 design working as intended: the characterization test asserted the bug, so fixing the bug broke it. It was then converted to acceptance tests rather than deleted.

### T21 — G3 acceptance tests

**15/15 pass** (`all 9 documented states` · `the 5 previously-rejected states` · `the 4 legacy states` · `formatting aliases` · `NO semantic aliases` · `stored value is canonical / search matches` · `event carries canonical` · `unknown rejected, nothing written` · `default entry state still active` · `legacy import intact` · `unknown STORED status preserved but reported` · `v0.1 record with NO status reported not guessed` · `export/import preserves canonical` · `JSON persist+reload` · `drift guard`), plus 3 `todo` blocked on L-1/L-2/L-5.

### T22 — Full suite after the G3 fix

```
ℹ tests 116
ℹ suites 8
ℹ pass 99
ℹ fail 0
ℹ todo 17
ℹ duration_ms 1619.5732
```

Delta from Phase 2 (`101 / 86 / 0 / 15`): +15 tests, +13 pass, +2 todo (2 G3 characterization + 1 todo → 15 acceptance + 3 todo).

**G1 (10) and G2 (18) acceptance blocks both still pass.** No existing test file was modified in Phase 3.

---

## Not yet measured — do NOT claim any of these

- ❌ **No token, cost, latency, or tool-call benchmark has ever been run.**
- ❌ No warm-lifecycle (A–E) benchmark.
- ❌ No compact-vs-full MCP token comparison — implemented, never measured.
- ❌ No confidence-calibration measurement (requires grounded outcomes that do not exist; methodology also unverified — no ECE/Brier/beta-binomial source confirmed).
- ❌ No clean-install integration test.
- ❌ Whether any MCP client still accepts `2024-11-05` from ShadowGraph (**X-1**).
- ❌ What the normative backward-compatibility section requires of a legacy server (**X-6**).
- ❌ Whether any surveyed competitor actually works — README self-description only, nothing installed.
- ❌ SQLite full-rewrite-per-save cost at scale (**X-4**, suspected P-1).
- ❌ Journal rebuild performance (**X-2**), projection equivalence (**X-3**).

The brief's claim that "a single initial MCP recording session can cost more tokens than a plain Claude answer" was **not re-verified**. It is carried forward as an unverified prior finding.

---

## UPDATE 2026-08-25 (part 9) — what has since been measured

The list above is superseded on three points. X-2, X-3 and X-4 are now **measured**, not suspected:

| Was | Now |
| --- | --- |
| ❌ X-2 journal rebuild performance | ✅ rebuild p95 **7.01 ms at 10k entries** vs a 250 ms pre-declared threshold |
| ❌ X-3 projection equivalence | ✅ **passed** — canonical equivalence on JSON and SQLite after repeated restarts |
| ❌ X-4 SQLite full-rewrite-per-save | ✅ **confirmed and quantified** — SQLite save ~2.6× JSON at 10k (273 ms vs 103 ms) |

Full numbers, invocation, and the argument-parsing proof: `docs/benchmark-report.md`.

**Still not measured, still not claimed:** token cost, cost per work lifecycle, latency, tool-call counts (the ADR-0004 warm-task benchmark is unimplemented), and confidence calibration (no Brier, no ECE, no reliability buckets — the weights are a declared policy, not a fitted model).

### Suite growth across the delivery

| Point | tests | pass | fail | todo |
| --- | --- | --- | --- | --- |
| Baseline at `1dde968` | 41 | 41 | 0 | 0 |
| Phase 0 characterization | 86 | 67 | 0 | 19 |
| After G1 | 90 | 74 | 0 | 16 |
| After G2 | 101 | 86 | 0 | 15 |
| After G3 | 116 | 99 | 0 | 17 |
| After G4–G8 + adversarial | 154 | 149 | 0 | 5 |
| **After independent-review fixes** | **217** | **212** | **0** | **5** |

The 5 remaining `todo` entries all carry a `BLOCKED ON <id>` label naming a real open decision (U-1 ×2, L-1, L-2, L-5). No characterization test for known-bad behaviour remains.

### Commands re-run at the end of part 9

    Historical snapshot: `npm test` -> 217 / 212 pass / 0 fail / 0 skipped / 5 todo (5530 ms). Current status is recorded in `current-status.md`.
    npm run check                                              -> exit 0, 11 files
    npm audit --omit=dev                                       -> found 0 vulnerabilities
    git diff --check                                           -> clean
    node scripts/bench-journal.mjs --sizes 1000,10000 --runs 5 --json   -> breaches: []
    npm run bench -- --sizes=1000,10000 --runs=5 --json                -> echoed sizes [1000,10000], runs 5
