# ShadowGraph — Issues and Risks

> **Historical risk ledger.** Resolved findings are preserved with their original evidence; `current-status.md` is authoritative for current blockers and deferred items.

**Last updated:** 2026-08-25 by Hermes Agent (claude-opus-5)

Severity: **S1** = contradicts a stated non-negotiable principle · **S2** = significant correctness/product gap · **S3** = quality, debt, or hygiene.

Gap IDs G1–G8 map to required tests, architecture decisions, and implementation phases in `current-status.md` §4.

---

## A. Confirmed issues — proven by execution (`test-and-benchmark-log.md` T6)

### ✅ S1-1 — RESOLVED in Phase 1 (2026-08-25): reconsideration now consults stored facts *(G1)*

**Was:** `review()` and `context()` evaluated `reopenWhen` rules **only** against facts passed as call arguments. A fact already persisted via `addFact` that matched a rule produced zero review signals (`review({})` → **0**; same fact as an argument → **1**).

**Fix:** `src/shadowgraph.js` gained a `storedFactValues(project)` helper that projects one project's **active** facts into the `{ key: value }` shape `review({ facts })` already consumed. `review()` now matches object-form rules against `{ ...storedFacts, ...callerFacts }`. 25 insertions, 1 deletion, one file. No public API change.

**Semantics locked by 10 acceptance tests:** caller-supplied facts keep **precedence** over stored facts of the same key; only the decision's own project is consulted; superseded/expired facts are ignored; string-form rules still match `changedFacts` only (deliberate boundary — see below); the pre-existing call-argument path is regression-guarded.

**Verified across both backends:** JSON persist→reload, and a real SQLite `close()` → `createSqliteStore()` reopen (skips cleanly on Node < 22.5 using the same guard as `test/sqlite.test.js`).

**Design boundary deliberately NOT crossed:** string-form rules (`reopenWhen: ['local']`) continue to match only `changedFacts`, not stored facts. `changedFacts` is an ephemeral "these just changed" signal; facts are durable state. Feeding state into that list would leave every decision permanently due. This is asserted as a documented-semantics test, not left implicit.

**Residual:** principle 5 ("Reconsideration is first-class") is now satisfied at the core level. `context()` inherits the fix automatically since it delegates to `review()`. **Not** verified through the MCP or HTTP surface.

### ✅ S1-2 — RESOLVED in Phase 2 (2026-08-25): provenance is a claim; trust cannot be self-asserted *(G2)*

**Was:** `source` was free text. `source:'human-confirmed'` **and `source:'tool_observed'`** both auto-set `verificationStatus:'verified'`. A caller could also write `verificationStatus:'verified'` directly. Decisions carried no provenance fields at all.

**Third bypass found during Phase 2:** `tool_observed` auto-verified too — not just `human_confirmed`. The original G2 report named only one path; the code had two, plus the direct write. All three are now closed.

**Fix:** `src/shadowgraph.js` — exported `SOURCE_CLASSES` / `VERIFICATION_STATUSES`; added `normalizeSourceClass()`, `provenanceString()`, `provenanceFields()`; rewrote the verification branch of `addFact()`; spread provenance into `addDecision()`.

**Contract (full text: `docs/handoffs/provenance-contract.md`):**
- Four official classes: `agent_claimed` · `tool_observed` · `human_confirmed` · `production_verified`. A class records **what was claimed** about origin, never a grant of trust.
- **No caller input can produce `verified`.** Every input arrives through the same untrusted path (the agent's own tool call), so deriving trust from any of it would make `verified` mean only "someone typed something".
- Unknown/non-canonical labels **downgrade** to `agent_claimed`, raw label kept in `sourceRaw` for audit.
- A direct `verificationStatus:'verified'` or `'expired'` write **throws**. `contradicted` is accepted because it *lowers* trust. `expired` stays owned by `maintain()`.
- `actor` / `client` / `sessionId` added to facts and decisions as plain JSON strings-or-null; non-strings throw.
- Legacy `source` field retained as a mirror of `sourceClass` for backward compatibility.

**Verified by 18 acceptance tests**, including JSON persist+reload and a real SQLite close+reopen.

**Honest capability gap (not a defect):** ShadowGraph currently **cannot represent a verified fact**. `verified` remains in the vocabulary for legacy data and a future mechanism, but is unreachable from input. → open question **U-1**, which **blocks G8** (confidence weighting by class is meaningless while no class is verifiable).

**Documented residual risk:** `importData()` preserves a stored `verified` status rather than rewriting it, so someone with filesystem write access can hand-author one. In a local-first single-user threat model they already own the data. → open question **U-3**.

### S1-3 — Silent omission on the primary read paths *(G6)*

`context()` and `search()` return unbounded bare arrays with no `total` / `hasMore` / `completeness`. `retrieve()` returns a bare array unless `limit` is supplied.

- **Evidence:** `context()` completeness-key scan → `false`; `search()` → bare Array; `retrieve()` without `limit` → bare Array; `retrieve(…,{limit})` → `{items, page}`.
- **Why it matters:** breaks principle 2 ("No silent omission"). The v0.30 "compact lossless MCP" claim holds only for `retrieve(…,{limit})`. `shadowgraph_context` — the tool the operating prompt tells agents to call **first** — has no completeness contract.
- **Decision:** ADR-0002 → phase **P1-A3**.

### S2-4 — Events are not a ledger *(G4)*

Events store `{id, type, at, project, recordId}` only. No payload, no actor, no causation, no schema version.

- **Evidence:** rebuild from `{events}` alone → **0** decisions; event JSON contains none of the alternative labels or rejection reasons.
- **Why it matters:** the redesign proposal's foundation ("canonical ledger + rebuildable projections") does not exist. PM baseline item 4 *understates* this as "not yet complete" — rebuild is not partial, it is impossible.
- **Decision:** ADR-0001 (payload-complete **append-oriented journal**, *not* full event sourcing) → phase **P2**.

### S2-5 — Event log is destructively mutated *(G5)*

`purgeProject` splices entries out of `events`.

- **Evidence:** events **1** → **0** after purge.
- **Resolution (was an open question, now decided by user directive):** logical/tombstone purge becomes the default (auditable, rebuildable, retains journal skeleton); a **separate, explicit, non-default hard purge** physically removes data including journal entries. Documentation must state that the journal is **"append-oriented with documented deletion semantics"** — never "append-only" — and that hard purge is an exception serving the right to erasure.
- **Decision:** ADR-0001 → phase **P2**, with four independent tests (tombstone, hard purge, rebuild after each) plus a test that hard purge is unreachable from the default path.

### ✅ S2-6 — RESOLVED in Phase 3 (2026-08-25): lifecycle vocabulary unified *(G3)*

**Was:** the docs promised nine states; the code accepted eight, of which four were undocumented and five of the promised nine threw `Invalid decision status`.

**Key finding from reading every producer/consumer:** the four undocumented states are **not all the same kind of thing**, so a naive "merge both lists" would have been wrong.

- **`active` is a VALIDITY state, not an execution rung.** Produced by `addDecision()` (default) and `supersedeDecision()` (replacement); consumed by `context().activeDecisions` and `maintain()`. **Load-bearing** — aliasing it onto any of the nine would change what `context()` returns and break `test/v02.test.js` / `test/v030.test.js`.
- **`aging` is DERIVED** — only `maintain()` produces it, from `reviewAfter` + clock.
- **`stale` and `archived` have NO producer** — nothing in `src/` ever sets them. Retained for compatibility, marked deprecated.

**Fix:** `src/shadowgraph.js` — exported `DOCUMENTED_DECISION_STATUSES` (9), `LEGACY_DECISION_STATUSES` (4), `DECISION_STATUSES` (13); added `normalizeDecisionStatus()`; `updateDecisionStatus()` now canonicalizes and stores the canonical value; `validate()` reports `unknown_decision_status`.

**Contract (full text: `docs/handoffs/lifecycle-contract.md`):** 13 canonical states; **formatting-only** aliases (case, hyphen/underscore) so `IN-PROGRESS` → `in_progress`; **no semantic aliases** (`archived` is *not* `abandoned`); canonical value stored, returned, and carried on the emitted event; unknown input throws with the pre-existing message shape; `importData()` preserves stored values and `validate()` **reports** rather than rewrites.

**Verified by 15 acceptance tests**, including a JSON persist+reload and a drift guard that fails if a state is added to the code without being classified in the contract.

**Not changed (needs product decisions):** entry state remains `active` (**L-1**); transitions are still unenforced (**L-2**); `maintain()` aging candidates unchanged (**L-3**); `search({status})` does not normalize its filter (**L-4**); `stale`/`archived` still meaningless (**L-5**).

**Docs still to update:** `shadowgraph-vision-scope.md:33` and `shadowgraph-next-session-brief.md:32` list only nine states and omit the four real ones. Left for a docs pass so this phase's diff stayed confined to G3.

### S2-7 — Search matches schema key names *(G7)*

`search()` does `JSON.stringify(record).toLowerCase().includes(term)`, so field names are searchable content.

- **Evidence:** queries `title`, `schemaVersion`, `confidence` each matched a record containing none of those words in its content.
- **Why it matters:** false positives pollute retrieval and make the `reason` string ("Matched record content") unexplainable, breaking the explainable-retrieval promise. Also an O(n) full-JSON stringify per record per query — a scaling floor.
- **Decision:** ADR-0005 (retrieval is a genuine competitive deficit) → phase **P4**. FTS5 deferred: `node:sqlite` is Release Candidate and JSON must retain a working search path.

### S2-8 — Confidence has no auditable basis *(G8)*

`{initial, current, history}` with hardcoded ±0.1 / −0.2 deltas.

- **Evidence:** `basis` key absent; history entry is `{delta, reason, at}`.
- **Why it matters:** breaks principle 7 ("Evidence-calibrated confidence"). A `tool_observed` contradiction and an `agent_claimed` guess move the number identically.
- **Decision:** blocked on ADR-0002/A2 → phase **P5**. Also blocked on calibration methodology, which is **unverified**.

### S3-9 — Repo lives in a misleadingly named directory

Real repo: `AI Projects\test deepseek`. Stale docs-only copy: `AI Projects\ShadowGraph`. Two agents could edit the wrong tree.
- **Status:** ✅ **Resolved by user directive — leave both as-is.** Neither renamed nor deleted. Recorded as stale/non-authoritative in `current-status.md` §1. Residual risk accepted: a future agent must read that section first.

### S3-10 — Extreme line density hurts reviewability

`src/shadowgraph.js` packs 273 lines with many multi-statement lines (`importData` is one ~1,400-character line). Bugs hide in this style and diffs are hard to review.

### S3-11 — Temporary probe hygiene

A `.probe-audit.mjs` was created and deleted this session; `git status` verified clean. Future probes should live under a gitignored path.

---

## B. Potential issues — identified by reading, NOT proven. Do not claim as fact.

## G. Confirmed findings from the v0.32 hardening review

| ID | Severity | Finding | Status |
| --- | --- | --- | --- |
| **P1-11** | high | HTTP JSON restore wrote a syntactically valid but semantically malformed payload over the live file before `replaceData()` validated it; a failed restore could brick the next restart. | fixed with staged validation before atomic rename; regression test added |
| **P1-13** | high | HTTP SQLite restore replaced the database before graph validation; malformed SQLite snapshots could replace valid state even when the request returned 400. | fixed with pre-restore SQLite load/validation; parity regression test added |
| **P1-12** | high | SQLite initialization failed when its configured parent directory did not exist, unlike JSON storage. | fixed by creating the parent directory; parity test added |
| **P2-19** | medium | Project-scoped redaction returned all projects' idempotency entries and did not redact `idempotencyKey`/cache-key values. | fixed with project filtering and key-value redaction; adversarial test added |
| **P2-20** | medium | The documented common storage interface promised `close()` for both backends, but JSON exposed no `close()`. | fixed with an idempotent JSON no-op close; parity test added |

These findings were reproduced by an independent adversarial review against the clean v0.31.0 baseline. No acknowledgment-journaling change was made: current snapshot persistence and non-replayability are internally consistent with the accepted provisional contract, but the product meaning remains decision-sensitive.

| ID | Suspicion | How to verify |
| --- | --- | --- |
| P-1 | **SQLite `save()` rewrites the entire dataset per write** — `replaceRelational` does `DELETE FROM` on every table then re-INSERTs everything. O(total records) per single decision; "normalized relational storage" is really a full-snapshot store with relational shape. | Insert 10k decisions, measure per-write latency growth (assumption **X-4**) |
| P-2 | `VACUUM INTO` interpolates a single-quote-escaped path into SQL. Escaping looks correct (`replaceAll("'","''")`) but it is still string interpolation. | Test destination paths containing quotes, backslashes, unicode |
| P-3 | JSON `save()` re-reads and re-serializes the whole file per write; `exportData()` deep-clones via `JSON.parse(JSON.stringify(...))` on every call. | Profile with a large graph |
| P-4 | `id()` uses `Date.now()` + 6 random base36 chars. Collision risk low but nonzero; not monotonic across processes. | Statistical test; consider ULID/UUIDv7 |
| P-5 | The lost-update window between `exportData()` and `save()` in the HTTP/MCP persist queue may not be covered by the existing concurrency test. | Adversarial interleaving test |
| P-6 | `redact()` patterns default to a fixed list — secrets in *values* with novel shapes pass through. | Fuzz with realistic secret formats |
| P-7 | MCP `initialize` hardcodes `protocolVersion: '2024-11-05'`; current spec is `2026-07-28` and removed that handshake. | **Partially resolved** — spec facts now verified (S1–S5). Client behaviour still unverified (**X-1**), normative backward-compatibility text unread (**X-6**) |
| P-8 | `context()` filters failed attempts with `/fail|regression|error/i` on the `result` string — will miss differently-worded failures and match innocuous text. | Test with varied phrasings |

---

## C. Open risks for the redesign

| Risk | Impact | Mitigation |
| --- | --- | --- |
| **Rewriting a working 41-test system introduces regressions** | High | Additive-only first; Phase 0 encodes current behaviour as tests before anything changes; dual-write behind a default-off flag; never delete a passing path before the replacement is proven |
| **Over-adopting event sourcing** | High | ✅ **Mitigated by directive** — ADR-0001 mandates a simple append-oriented journal; no CQRS; snapshots only if X-2 fails. Primary basis: Microsoft's *"costly to migrate to or from… apply it selectively"* (S10) |
| **Projection equivalence proves impossible** | High | Assumption **X-3**; falsifier defined; ADR-0001 must be superseded rather than forced if it fails |
| **Benchmark cannot support strong claims at n=10** | Medium | Pre-register rubrics; paired deltas + bootstrap CIs; state plainly what n=10 cannot prove; publish negatives |
| **Rubric/judge methodology unresearched** | Medium | Two evaluation-methodology searches failed with backend 403s. **Do not design the rubric from memory** — research it before P6 |
| **Prompt caching confounds token comparisons** | Medium | Capture cache read/write tokens separately; never compare a cached arm against an uncached one |
| **Confidence calibration unmeasurable today** | Medium | Needs grounded verified outcomes that do not exist, plus a calibration methodology that is unverified. Report "unmeasured", never "good" |
| **Scope explosion** — 7 brief workstreams could each be a release | Medium | Sequenced by principle-violation severity; token work last since it has no correctness impact |
| **Agent-generated docs drift from code** | Medium | Already happened (lifecycle G3, provenance G2, append-only G5). Phase 0's G3 test doubles as a docs-vs-code drift guard |
| **Competitor claims taken at face value** | Medium | All competitor evidence is 🟧 README self-description. **Nothing installed or tested. No star counts verified.** Do not repeat their claims as measured facts |
| **Wrong-directory edits** | Low-Medium | Both folders stay per directive; `current-status.md` §1 flags `AI Projects\ShadowGraph` as stale and non-authoritative |

---

## D. Claims withdrawn or corrected this session

Honesty ledger. These were stated earlier by me and are now retracted or corrected.

| Claim | Status | Correction |
| --- | --- | --- |
| "Tool count measurably harms accuracy" | ❌ **Withdrawn** | Rested entirely on unverified Opus 4 / 4.5 figures from YouTube descriptions. No primary source reachable. The only surviving accuracy datum is 🟦 +11% for programmatic tool calling (S7), a different mechanism |
| "ShadowGraph's MCP server is near-breaking" | ❌ **Overstated, corrected** | The spec **explicitly specifies** legacy interop and defines a `Dual-era` category (S1, S2). Reclassified as scheduled maintenance, subject to X-1/X-6 |
| "Five revisions behind" | ❌ **Miscounted, corrected** | Included `2024-10-07`, which precedes ShadowGraph's own `2024-11-05`. Correct figure: **four** (`2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`) |
| Specific token-reduction percentages (85%, 98.7%, 37%, 77k→8.7k, Cloudflare 2,500→2) | ❌ **Removed from all ADRs** | Traced to YouTube descriptions and unattributed blogs. Replaced with 🟦 S6 (58 tools ≈ 55K tokens) and 🟨 S9 (78.5% input reduction, independent) |
| Any GitHub star count | ❌ **Never verified, never reported** | Removed entirely |
| Zep bi-temporal paper details | ❌ **Unverified** | The paper was **never opened**; two searches failed with backend 403s |
| Horner & Atwood citation `CACM 37(1):92–105, 1994` | ⚠️ **Unconfirmed** | Taken from a secondary reference list; original never opened. Verify before any publication |

---

## E. Explicitly NOT verified — do not claim

- Token cost, cost per lifecycle, latency, tool-call counts — **no benchmark has been run**.
- The prior finding that "a single initial MCP recording session costs more tokens than a plain answer" — **carried forward unverified**, not re-tested.
- Compact vs full MCP token savings — implemented, never measured.
- Confidence calibration accuracy — unmeasurable; no grounded outcomes; methodology unverified.
- Clean-install integration on another machine — not attempted.
- Whether any surveyed competitor actually works — README self-description only.
- Whether any MCP client still accepts `2024-11-05` from ShadowGraph (**X-1**).
- What the normative backward-compatibility section requires of a legacy server (**X-6**).
- **B-5 (legacy fact import)** — historical finding. Current import backfills a canonical `sourceClass` and generates an ID when absent; regression coverage is in `test/final-review.test.js`.

---

## F. Raised by the cumulative diff review (2026-08-25 pre-G4 gate)

Full analysis in `cumulative-diff-review.md`. Nothing here was fixed — all need approval.

| ID | Item | Severity |
| --- | --- | --- |
| **A-1** | `integrations/agent-policy.md:9` instructs agents to treat `model_inferred` facts as hypotheses, but **G2 made `model_inferred` unproducible** — a doc-vs-behaviour contradiction in a *shipped integration file* | 🔴 |
| **A-2** | Historical finding: `addFact()` rejected `verificationStatus:'verified'`/`'expired'` before the 0.31.0 changelog/version update | ✅ resolved |
| **A-3** | `validate()` now returns `valid:false` for legacy records with no `status` (new `unknown_decision_status`). Deliberate, but any consumer using `validate().valid` as a health gate will newly fail after importing old data | 🟠 |
| **A-4** | `sourceRaw` is conditionally present, so facts have two possible shapes | 🟢 |
| **B-4** | `redact()` does **not** cover a journal `payload` — becomes a live secret-leak path the moment G4-B writes payloads. **Must be fixed inside G4-B** | 🔴 |
| **B-5** | Legacy fact import yields `source:'unknown'` (not a canonical class) and **never backfills `sourceClass`**, silently — unlike the decision-status case G3 made visible | 🔴 (unverified) |
| **B-6** | Legacy decisions lack provenance fields (absent vs explicit `null`) | 🟢 |
| **E-1** | `SOURCE_CLASSES` and `VERIFICATION_STATUSES` are exported with **zero consumers anywhere** — exported by mistake | 🟠 |
| **E-2** | The three `*_DECISION_STATUSES` constants are implementation details **promoted to exports purely to serve tests** | 🟠 |
| **E-3** | Exported arrays are **mutable and unfrozen** — `DECISION_STATUSES.push(...)` from outside would corrupt validation | 🟠 |
| **T-1** | 12 of 19 `it.todo` entries say `AFTER FIX:` without distinguishing *deferred* / *blocked* / *future contract*; the two G8 ones are additionally blocked on U-1 and don't say so | 🟠 |
