# ShadowGraph — Session Log

Chronological, one block per session. Practical record only: what was asked, what was inspected, what changed, what was verified, what remains.

---

## Session 2026-08-25 (part 1) · Hermes Agent (claude-opus-5, Hermes desktop)

### User request

Continue ShadowGraph as PM + Software Architect + AI Memory Systems Engineer. Read the 8 brief docs in order; verify the brief's claims against reality; run **independent, current** web research rather than trusting prior notes; write a research summary, an ADR, and implementation/migration/rollback/benchmark plans; **do not rewrite code before those are delivered**. Create `docs/handoffs/` with seven named living documents so any other agent (Claude, Codex, …) can continue without chat history.

### What was inspected

- All 8 brief documents, in the requested order.
- Located the real repository — **`C:\Users\aelkh\AI Projects\test deepseek`** (git, remote `LiLara-AI/shadowgraph`, `main` @ `1dde968`). Discovered `AI Projects\ShadowGraph` is a **stale, non-git, docs-only copy** (all 8 files byte-identical; `IDEA.md` duplicates the vision doc).
- Full source read: `shadowgraph.js` (273), `server.js` (113), `mcp.js` (93), `sqlite-storage.js` (91), `cli.js` (52), `storage.js` (38), `backup.js` (23), `revision-store.js` (13).
- `package.json`, `package-lock.json` (dependency count), 13 test files (566 lines).

### Verified by execution

`npm test` → **41/41 pass**. `npm run check` → exit 0. `npm audit --omit=dev` → **0 vulnerabilities** (trivially: **zero runtime dependencies**, lockfile has 1 package). `git diff --check` → clean. `git status -sb` → `main...origin/main`, only untracked `docs/`. Node **v24.18.0**.

Every factual claim in the brief about version, commit, branch, test count, and audit status **checked out true**. The brief's *architectural* self-assessment did not.

### Substantive finding

A temporary read-only probe (deleted after; tree verified clean) proved **8 gaps**, 3 contradicting stated non-negotiable principles: **G1** reconsideration ignores stored facts (stored → 0 signals, argument → 1); **G2** provenance self-assertable (`human-confirmed` auto-verifies; decisions have no provenance fields); **G6** `context()`/`search()` unbounded with no completeness metadata; **G4** events carry no payload, rebuild yields 0 decisions; **G5** `purgeProject` splices events so the log is not append-only; **G3** 5 of 9 documented lifecycle states rejected; **G7** search matches schema key names; **G8** confidence has no evidence basis.

### Research attempt 1 — failed and discarded

Five parallel research streams were delegated to subagents. **All 5 failed** with a tool-argument corruption fault and returned training-memory reports, self-labelled unverified, with guessed version numbers and star counts. **All output discarded; none used.** Research was then performed directly with working tools.

### What changed on disk

No source code. Four handoff documents created: `current-status.md`, `test-and-benchmark-log.md`, `issues-and-risks.md`, `session-log.md`.

---

## Session 2026-08-25 (part 2) · same agent, user directives applied

### User request

Nine directives before accepting any ADR or touching code: (1) do **not** rename `test deepseek` or delete/rename the `ShadowGraph` copy — record the latter as stale docs-only; (2) adopt purge = logical/tombstone default + separate explicit hard purge, document it as an erasure exception, stop claiming append-only, add independent tests for tombstone/hard/rebuild-after-each; (3) do **not** implement full event sourcing — official recommendation is a simple journal/transactional history with projections/snapshots only where required; (4) before accepting the MCP claim, add direct source links + access dates, verify the current version and the presence/absence of the `initialize` handshake and `server/discover`, separate official spec from draft, and record an unpublished/future version as an unconfirmed claim — compare with what the repo implements but **do not modify MCP code**; (5) no tool-token/accuracy/star numbers in ADRs without a verifiable primary source; distinguish independent measurement from vendor claims from the failed subagent reports, and state that all five were discarded; (6) keep ADRs `proposed` but update each per specific instructions, and avoid "moat" language; (7) update the seven files, add a G1–G8 → test/decision/phase table, add an "Unresolved assumptions and verification required" section, and add a primary source list with access dates; (8) **no commit** — leave `docs/` uncommitted, don't touch `src/`/`test/`/`package.json`; (9) run the four verification commands.

### What was verified against primary sources (all accessed 2026-08-25)

Direct `web_extract` of the specification, not search snippets:

- **S1** `modelcontextprotocol.io/docs/learn/versioning` — *"The **current** protocol version is **2026-07-28**."* Same page defines **Draft / Current / Final**, which settles directive 4's draft-vs-official question: `2026-07-28` is **Current**, not a draft, proposal, or future version.
- **S5** GitHub releases — tag `2026-07-28`, *"stable release"*, 28 Jul 2026, commit `5f5440b`, GPG-verified, preceded by a separate `2026-07-28 RC` tag.
- **S2** `/specification/2026-07-28/basic/versioning` — *"**There is no negotiation handshake.**"*; *"Servers **MUST** implement `server/discover`"*; error code `-32022`; defines **Modern / Legacy / Dual-era**.
- **S3** changelog — *"remove the `initialize`/`notifications/initialized` handshake."*
- **S14** `nodejs.org/api/sqlite.html` — `node:sqlite` is **Stability 1.2 Release Candidate**, contradicting a secondary source that claimed "stable in Node 24". Primary wins.

### Corrections made to my own earlier claims

- 🔻 **"Near-breaking" MCP framing — overstated.** S1 explicitly points to backward compatibility for handshake-based revisions (`2025-11-25` and earlier) and the spec defines a `Dual-era` category. Reclassified as **scheduled maintenance**. Limit stated: the backward-compatibility section's normative content was **not read** (X-6) and **no client was tested** (X-1).
- 🔻 **"Five revisions behind" → four.** The earlier count wrongly included `2024-10-07`, which precedes ShadowGraph's own `2024-11-05`.
- 🔻 **"Tool count harms accuracy" — withdrawn.** It rested entirely on unverified Opus figures from YouTube descriptions.
- 🔻 **Removed from all ADRs:** "85%", "98.7%", "37%", "77k→8.7k", "Cloudflare 2,500+→2 tools", "30–40% latency", all Opus accuracy numbers, and every star count. Replaced with 🟦 S6 (*"58 tools consuming approximately 55K tokens before the conversation even starts"*), 🟦 S7 (+11% / −24% input tokens), 🟨 S9 (independent: 78.5% fewer input tokens, ~15,400 vs ~3,300 tool-def tokens/call).

### What changed on disk

**No source code, no commit.** All seven handoff files now updated:

| File | Change |
| --- | --- |
| `research-log.md` | Rewritten with a 6-level evidence taxonomy, verbatim primary quotes, per-source retrieval method (direct vs snippet), recorded retrieval failures, and a 22-entry source register (Appendix A) |
| `decision-log.md` | All five ADRs revised per directives; ADR-0001 now mandates journal-not-ES + the purge decision; 0002/0004 marked preliminary with explicit limits; 0003 explains why compacting is the wrong lever and scopes out client-side techniques; 0005 narrowed to two claims; "moat" removed |
| `current-status.md` | Folder directive recorded; **G1–G8 → test/decision/phase table** added; **"Unresolved assumptions and verification required"** section added (X-1…X-6 + withdrawn claims); primary source register with access dates; ADR status table |
| `next-actions.md` | Phase 0 defined as the only approved next step, with per-gap assertions; resolved directives recorded; purge tests specified |
| `issues-and-risks.md` | Purge question marked resolved; P-7 partially resolved; new §D "Claims withdrawn or corrected" |
| `test-and-benchmark-log.md` | Research-verification commands added alongside the T1–T6 evidence |
| `session-log.md` | This entry |

### Decisions that became concrete

1. **No full event sourcing.** Simple append-oriented journal for audit-critical entities; projections compared for equivalence; snapshots only if X-2 fails; no CQRS. Basis: Microsoft's *"costly to migrate to or from… apply it selectively"* (S10).
2. **Purge:** tombstone default (auditable, rebuildable) + separate explicit non-default hard purge (true erasure). Terminology fixed to **"append-oriented with documented deletion semantics"**; five tests specified.
3. **MCP:** four revisions behind, Legacy era, `server/discover` absent — but backward compatibility is specified, so scheduled maintenance. **No code touched.** Client-side techniques out of scope this release; the one in-scope item is improving tool names/descriptions, since S8 confirms tool search matches those fields.
4. **Differentiation narrowed to two claims:** deterministic reconsideration over stored state (contingent on fixing G1) and first-class `reopenWhen` falsification conditions.
5. **Benchmarking:** baseline-only, never against competitors, not LoCoMo.

### Still to do

**Phase 0 only** — regression tests for G1–G8 asserting *current* behaviour, no production change, then present the diff and real test output. Do not fix G1 or alter design before that review.

### Honest statement of proof

**Proven:** repo identity; 41/41 tests; 0 vulnerabilities; zero dependencies; clean syntax/diff; the 8 gaps (verbatim output in T6); the MCP spec facts above (direct extraction, quoted).

**Not proven:** any token/cost/latency measurement (**no benchmark run**); the prior "first MCP session is more expensive" finding; compact-vs-full savings; confidence calibration; clean-install integration; whether any client still accepts `2024-11-05` (X-1); the normative backward-compatibility requirements (X-6); whether any competitor actually works (README self-description only); the Zep bi-temporal paper (never opened); the Horner & Atwood page numbers (secondary reference list).

---

## Session 2026-08-25 (part 3) · Phase 0 — characterization tests

### User request

Phase 0 only: characterization/regression tests for G1–G8 with no production change. One `describe` per gap; name them clearly as characterization tests of *current* behaviour; pair each with the desired post-fix behaviour; use `test.todo` where appropriate without hiding that the current test pins a live bug; minimal data per scenario; no reliance on unguaranteed ordering; specific coverage required for G1 (stored fact → restart → reconsideration without passing the answer), G2 (no self-asserted human-confirmed), G6 (completeness/pagination), G4 (rebuild limits); no dependencies; no commit; if a test fails because the report was wrong, fix the test or record the gap as untestable — never change production code.

### What was done

Created `test/gap-regressions.test.js` — 418 lines, 8 `describe` blocks, using only built-in `node:test` (`describe`/`it`/`it.todo`). Every defect assertion is named `CHARACTERIZATION (current, defective):` and paired with an `it.todo` stating the post-fix contract. Working controls are named `CONTROL (current, works):`.

**Result: 45 tests, 26 pass, 0 fail, 19 todo.** Full suite `86 / 67 / 0 / 19`. Every assumption from the T6 probe held — **no test needed correcting and no gap was untestable**.

### Two new defects found while writing the tests

1. **A second G2 self-assertion bypass** — `addFact({source:'agent_claimed', verificationStatus:'verified'})` is accepted verbatim (`input.verificationStatus ?? …`). Closing only the `human-confirmed` path would leave provenance forgeable.
2. **`production_verified` is unrecognised** — the strongest documented class yields `unverified`.

Also confirmed `test/v030.test.js:13–15` asserts the G2 bug as *desired* behaviour, so the G2 fix must update that existing test. Logged with dated markers in `issues-and-risks.md` S1-2 and `next-actions.md` A2 — the only handoff edits made in Phase 0.

### Coverage limits recorded

G5's target behaviour has no implementation to test (tombstone/hard purge exist only as `it.todo`); G2's "verifiable reference" gate cannot be tested because no evidence mechanism exists yet; the MCP/HTTP surfaces are not exercised (G6 verified at core level only); the G1 reload test used JSON only.

---

## Session 2026-08-25 (part 4) · Phase 1 — G1 fix

### User request

Fix G1 only: make `review()` use stored facts when evaluating `reopenWhen`. Requirements: works after `exportData()`/`importData()` and after a real backend restart; stored facts match with the same semantics as call-argument facts; explicitly-passed facts unchanged in behaviour; keep the existing call-argument precedence on conflict and document it in a test; respect project scoping; no false positives; no public API change unless necessary. Convert the relevant G1 tests to acceptance tests. Do not touch G2 tests or `test/v030.test.js`. Test both backends if possible without widening scope. No ledger/payload/purge/MCP redesign. No dependencies. No commit.

### Investigation before editing

Read `review()`, `addFact()`, `importData()`/`exportData()`, plus every call site of `review` (`cli.js`, `server.js`, `mcp.js`, `maintain()`, `context()`) and every existing test touching `reopenWhen`/`changedFacts`. Key finding that shaped the fix: **`reopenWhen` has two rule dialects.** String rules match `changedFacts` (an ephemeral "just changed" signal); object rules `{key, operator, value}` match `context.facts` (fact-shaped state). Only the object dialect has stored-fact semantics, so the merge belongs there. Extending string rules to stored facts would make every decision permanently due.

Confirmed no pre-existing test combines an object-form rule with a stored fact of the same key — so the change was predicted to be non-breaking, and was.

### Change made

`src/shadowgraph.js` only, **+25 / −1**:
- new `storedFactValues(project)` — projects a project's **active** facts from `currentFacts` into the `{key: value}` shape `review({facts})` already consumed;
- `review()` builds `knownFacts = { ...storedFactValues(record.project), ...context.facts }` and matches object rules against it.

No public API change. No new dependency. `context()` inherits the fix automatically because it delegates to `review()`.

**Documented rationale (in code comments):** stored and supplied facts share one matching path so there is no second rule dialect; caller arguments keep precedence, preserving the prior contract; only the decision's own project is consulted; non-active (superseded/expired) facts are skipped so a stale fact cannot pin a decision open.

### Verification

10 G1 acceptance tests pass, including a **real SQLite close + reopen** (skips cleanly below Node 22.5 via the same guard as `test/sqlite.test.js`). Full suite **90 / 74 pass / 0 fail / 16 todo** — zero regressions, no existing test file modified. `npm run check` exit 0, `npm audit --omit=dev` 0 vulnerabilities, `git diff --check` clean.

### Still to do

G2–G8 remain. **G2 is now known to need three changes, not one:** close the `human-confirmed` auto-verify path, close the direct `verificationStatus` bypass, and update `test/v030.test.js`. Nothing committed; `src/shadowgraph.js` is modified in the working tree only.

---

## Session 2026-08-25 (part 5) · Phase 2 — G2 fix (provenance and verification)

### User request

Fix G2 only. Read the current `addFact()`, source normalization, `verificationStatus` computation, `addDecision()`, export/import, `test/v030.test.js`, and the provenance/security docs **first**. Then write an explicit contract answering: official source classes; what `verified` means; how the four classes differ; what a "verifiable reference" is; whether an evidence mechanism exists; what happens on unknown source; reject-vs-downgrade. Do not invent a verification mechanism that claims human confirmation. Close both known bypasses, handle unknown classes, add provenance metadata as plain JSON, and update `test/v030.test.js` (which pinned the bug) without deleting it. Test JSON and SQLite. No dependencies, no commit, no G1 rework, no changes to `review()`/lifecycle/search/purge/event payload/MCP, no confidence work. If evidence/reference design turns out to need a separate architectural decision, stop before building it and record what is safe now, what needs a decision, and the safe interim behaviour.

### Investigation before editing

Read `addFact()` (lines 79–83 pre-fix), `addDecision()`, `importData`/`exportData`, `normalizeEvidence()`, `test/v030.test.js`, and grepped every `source:` / `verificationStatus` usage across `src/` and `test/`.

**Two findings that changed the plan:**
1. **`tool_observed` also auto-verified.** Pre-fix line 80 read `normalizedSource === 'human_confirmed' || normalizedSource === 'tool_observed' ? 'verified' : 'unverified'`. The report had named one auto-verify path; there were two, plus the direct write — **three bypasses**.
2. **No evidence mechanism exists anywhere.** Facts have no evidence field at all. Decision `evidence[]` is free text reshaped by `normalizeEvidence()` with zero validation. So "require a verifiable reference" was **not implementable** in this phase.

### Contract decided (full text: `docs/handoffs/provenance-contract.md`)

- Four official classes: `agent_claimed` · `tool_observed` · `human_confirmed` · `production_verified`. A class records **what was claimed** about origin — never a grant of trust.
- **No caller input can produce `verified`.** Every input arrives through the same untrusted path (the agent's own tool call), so deriving trust from any of it would make `verified` mean only "someone typed something".
- Unknown/non-canonical labels **downgrade** to `agent_claimed`; raw label kept in `sourceRaw` for audit. Rejecting would discard a real fact over a labelling problem.
- A direct `verificationStatus:'verified'`/`'expired'` write **throws** — that field is a trust write, not an origin description, so a silent downgrade would mislead the caller.
- `contradicted` is accepted because it **lowers** trust. `expired` stays owned by `maintain()`.
- `actor`/`client`/`sessionId` added to facts and decisions as plain JSON string-or-null; non-strings throw.
- Legacy `source` retained as a mirror of `sourceClass`.
- `importData()` **preserves** stored values and never elevates trust.

### Stopped before building (per the directive's escape clause)

**No `evidenceRef` field was added.** A reference ShadowGraph cannot re-check is not evidence, and adding a field that *looks* like proof would later be cited to justify re-enabling auto-verification. Recorded as **U-1**.

### Change made

`src/shadowgraph.js`: exported `SOURCE_CLASSES` and `VERIFICATION_STATUSES`; added `normalizeSourceClass()`, `provenanceString()`, `provenanceFields()`; rewrote the verification branch of `addFact()`; spread provenance into `addDecision()`. No public API removed; no dependency added.

`test/v030.test.js`: the one existing test that pinned the defect now asserts the safe behaviour, with an in-file comment recording the prior assertion and why it changed. Not deleted.

### Verification

18 G2 acceptance tests pass (JSON persist+reload and real SQLite close+reopen included). Suite **101 / 86 pass / 0 fail / 15 todo**. `npm run check` exit 0, audit 0 vulnerabilities, `git diff --check` clean.

### Honest capability gap

**ShadowGraph currently cannot represent a verified fact.** `verified` stays in the vocabulary for legacy data and a future mechanism, but is unreachable from input. This is deliberate and documented, and it **blocks G8** — weighting confidence by source class is meaningless while no class is verifiable.

### Still to do

G3–G8. **U-1 must be decided before G8.** Nothing committed; `src/shadowgraph.js` and `test/v030.test.js` are modified in the working tree only.

---

## Session 2026-08-25 (part 6) · Phase 3 — G3 fix (decision lifecycle)

### User request

Fix G3 only: unify lifecycle states between docs and implementation. Read `updateDecisionStatus()`, every read/write of `status`, `addDecision()`, `importData()`/`exportData()`, every test depending on lifecycle states, and the lifecycle docs **first**. Build a table mapping the 9 documented states and the 4 undocumented implemented states to a target state. Do not invent semantics without reading consumers — classify each state as core lifecycle, backward-compatible alias, or derived/incidental. Choose and document one design before implementing: canonical stored states, accepted aliases, canonical-on-read, legacy importability, unknown-status handling. Keep backward compatibility absent a documented reason. Don't let unknown states pass silently. Don't touch provenance/verification, G1 reconsideration, event payload/journal, purge, search/pagination, confidence. No dependencies, no MCP changes, no commit. If some of the nine aren't logically implementable without a product decision, stop and record the ambiguity rather than guessing.

### Investigation before editing

Read `updateDecisionStatus()`, grepped every `status` occurrence in `src/` (36 hits) and `test/` (15 hits), plus lifecycle mentions across `docs/`. Saved a pre-G3 snapshot of `shadowgraph.js` to temp for reference.

**The finding that determined the design:** `status` is an **overloaded field name**. Alternatives use `rejected`; facts use `active`/`superseded`/`expired`; review signals use `open`/`acknowledged`; outcomes use `successful`/`mixed`/`failed`/`unknown`. Only *decision* status was in scope, and `failed` means different things in the decision and outcome vocabularies.

**The four undocumented states are not the same kind of thing** — so merging both lists naively would have been wrong:
- **`active` is a VALIDITY state**, not an execution rung. Produced by `addDecision()` (default) and `supersedeDecision()`; consumed by `context().activeDecisions` and `maintain()`. **Load-bearing.**
- **`aging` is DERIVED** — only `maintain()` produces it, from `reviewAfter` + clock.
- **`stale` and `archived` have NO producer** — nothing in `src/` ever sets them; only `search({status})` reads them.

### Contract decided (full text: `docs/handoffs/lifecycle-contract.md`)

**13 canonical states:** the 9 documented execution states + `active` (validity) + `aging` (derived) + `stale`/`archived` (deprecated, retained for compatibility).

**Formatting-only aliases** (`trim` → `toLowerCase` → `-`→`_`), matching the G2 precedent, because MCP clients commonly send `in-progress` or `IN_PROGRESS`. **No semantic aliases:** `archived` is *not* rewritten to `abandoned`, `active` is *not* `executed` — that would silently change what a record claims about itself.

**Canonical on read:** `updateDecisionStatus()` stores and returns the canonical form, and the emitted event carries it, so `search({status})` matches what was written.

**Unknown input throws** `Invalid decision status: <raw>` — the pre-existing message shape, with the raw value echoed.

**Import preserves, `validate()` reports.** `importData()` does not validate or rewrite `status` (round-trip stability + the security doc's "do not rewrite user data in place"), but `validate()` now emits `unknown_decision_status` so the problem is discoverable, and `repairPlan()` routes it to `manual_review` — never an automatic mutation.

### Change made

`src/shadowgraph.js` only: exported `DOCUMENTED_DECISION_STATUSES` (9), `LEGACY_DECISION_STATUSES` (4), `DECISION_STATUSES` (13); added `normalizeDecisionStatus()`; rewrote `updateDecisionStatus()`; extended `validate()`. No dependency, no MCP change, no public API removed.

### The intended failure

After the production change the suite showed **exactly one failure** — the Phase 0 G3 characterization test that asserted 5 states throw. That is the mechanism working as designed; it was converted to acceptance tests, not deleted.

### Verification

15 G3 acceptance tests pass, including a JSON persist+reload and a **drift guard** that fails if a state is added to the code without being classified in the contract. Suite **116 / 99 pass / 0 fail / 17 todo**. G1 (10) and G2 (18) both still pass. **No existing test file was modified in Phase 3.**

### Stopped before building (per the directive's escape clause)

Six items recorded rather than guessed: **L-1** entry state (`active` vs documented `proposed`), **L-2** transition enforcement (diagram normative or illustrative?), **L-3** `maintain()` aging candidates, **L-4** `search({status})` filter normalization, **L-5** `stale`/`archived` meaning, **L-6** whether `addDecision()` should honour a caller `status`.

### Docs still to update

`shadowgraph-vision-scope.md:33` and `shadowgraph-next-session-brief.md:32` list only the nine states and omit the four real ones — two of which are load-bearing. The docs are **incomplete**, not merely aspirational. Left for a docs pass so this phase's diff stayed confined to G3.

### Still to do

G4–G8. Nothing committed; `src/shadowgraph.js` and `test/v030.test.js` are modified in the working tree only.

---

## Session 2026-08-25 (part 7) · Pre-G4 gate — docs, review, design (no production change)

### User request

Do **not** start G4 or touch event payload. Execute a documentation/review/design gate instead: (1) close the G3 loop in the source docs that still list only nine states, clarifying `active` (validity, load-bearing), `aging` (derived), `stale`/`archived` (legacy/deprecated, no producer), and that the thirteen do **not** form one transition ladder — without resolving L-1…L-6 or changing defaults, and without touching production code; (2) review the **cumulative** diff since `1dde968` for unintended public API changes, exports added only for tests, `importData()` compatibility, provenance fields breaking consumers, tests coupled to implementation details, docs contradicting behaviour, and TODOs that don't say whether they're blocked/deferred/future-contract; explicitly rule on the five exported constants without changing them unless clearly wrong; (3) make ADR-0001 decision-ready across 14 named design questions, keeping it `proposed`; (4) split G4 into G4-A…G4-G with files, API impact, compat, tests, acceptance, rollback, and commit granularity per phase; (5) propose a checkpoint and commit structure without committing, and without rewriting history.

### What was done

**Docs (G3 loop closed):** `docs/shadowgraph-vision-scope.md:33` and `docs/shadowgraph-next-session-brief.md:32` now state the nine documented execution states *plus* the four retained states with their classifications, and say explicitly that thirteen accepted states are **not** one ladder. Both point at `lifecycle-contract.md`. No production code touched; L-1…L-6 left open.

**Cumulative review** → new `cumulative-diff-review.md`. Eleven findings, four of them 🔴:
- **A-1** `integrations/agent-policy.md:9` still tells agents to treat `model_inferred` facts as hypotheses, but G2 made `model_inferred` **unproducible** — a doc-vs-behaviour contradiction in a *shipped* file, not a handoff note.
- **A-2** was a breaking input-contract change; it is now documented in `CHANGELOG.md` and represented by version 0.31.0.
- **B-4** `redact()` does not cover a journal `payload` — becomes a live secret-leak path the moment G4-B writes payloads.
- **B-5** legacy fact import yields `source:'unknown'` (not canonical) and **never backfills `sourceClass`**, silently. ⚠️ **Unverified by execution** — the confirming probe was blocked without consent and not retried; derived from reading `importData()`.

**Exports ruled on (not changed):** `SOURCE_CLASSES` and `VERIFICATION_STATUSES` have **zero consumers anywhere** — exported by mistake (**E-1**). The three `*_DECISION_STATUSES` are implementation details **promoted to exports purely to serve tests** (**E-2**). All exported arrays are **mutable and unfrozen** (**E-3**). Left in place because `SCHEMA_VERSION` sets an existing precedent for exporting vocabulary, so un-exporting is a public-API decision deserving its own ruling. Proposed alternative: keep all five module-private and have the test declare the expected vocabulary as an **independent literal** — a test importing the implementation's own list cannot detect a vocabulary change, since both sides move together.

**ADR-0001 made decision-ready** (still `proposed`) with D1–D14 appended. Key choices: payload = **complete post-operation snapshot** (command-replay rejected because non-deterministic `id()`/`now()` and, worse, replaying `addFact` through future code could re-open the G2 bypass); **monotonic `seq` required** because `now()` is injectable, ms ties occur, and `id()` is not monotonic; atomicity **by co-location** (journal in the same payload and the same `rename()`/`BEGIN IMMEDIATE` as state) with the binding rule never to persist it separately; migration writes one honestly-labelled `projection.baseline` at a `journalEpoch` and **refuses** to replay across it rather than returning a partial graph. Three sub-decisions left open: **J-1** (is a labelled baseline acceptable), **J-2** (journal clock-derived `aged`/`expired`?), **J-3** (does keeping `reviewSignals` out conflict with "persistent review signals"?).

**G4 plan** → new `g4-plan.md`, G4-A…G4-G with per-phase files/API/compat/tests/acceptance/rollback/commit. Two recommendations: **fold G4-F into G5** (purge behaviour is G5's subject; splitting its journal half invites a half-specified purge) but pull the **`redact()` payload fix into G4-B** as a security prerequisite; and **land G4-E last** among code phases since it is the only sub-phase that mutates user files and the only one not cleanly revertible.

### Verification

`npm test` **116 / 99 pass / 0 fail / 17 todo** — identical to the Phase 3 figure, as expected: **no production code was modified at this gate.**

### Still to do

🔴 **Stopped.** Awaiting acceptance of ADR-0001 + the G4 split before G4-A. Nothing committed.

---

## Session 2026-08-25 (part 8) · G4–G8 delivery + adversarial review

### User request

Act as delivery lead end-to-end; do not stop between phases for approval. Deliver G1–G8 either fixed with acceptance tests or classified as deferred with a real technical reason. No contradictions between code, tests, docs and MCP interfaces.

### What was done

`src/journal.js` (pure replay), `src/confidence.js` (`evidence_weighted_bounded_v1`), journal writes in `appendJournal()`, logical/hard purge, completeness envelopes on every read path, declared-content-field search, six contracts, `docs/api-reference.md`, `docs/mcp-compatibility.md`, `scripts/bench-journal.mjs`. All five ADRs moved off `proposed`. `integrations/agent-policy.md` and README corrected (they still named the unproducible `model_inferred` and called the journal "append-only"). Version 0.30.0 → 0.31.0 with a CHANGELOG.

### Bugs the green suite was hiding (found by adversarial probe, not by tests)

1. **Confidence double-counted across a clock tick.** The outcome contribution key embedded `observedAt`, so recording the same outcome twice in different milliseconds counted it twice (0.6 → 0.7, `successfulOutcomes: 2`). Its unit test passed only because both calls happened to land inside one millisecond. Fixed with single-slot `setOutcomeContribution()`.
2. **Malformed journal entry silently dropped.** An entry with `entityKind`/`entityId` but no `payload` vanished from the projection while `rebuildProjection` still reported `rebuildable: true` — a partial graph presented as complete. Fixed with a `missing_payload` skip forcing `rebuildable: false`.

Also corrected my own `completeness-contract.md`, which claimed invalid limits fall back to defaults; the code throws and the code is right.

### Verification

Historical snapshot: X-2 settled by measurement and X-3 equivalence passed on JSON and SQLite. The suite was 154 / 149 pass / 0 fail at that point.

---

## Session 2026-08-25 (part 9) · Independent review fixes (P0-1 … P2-18)

### User request

An independent review found blockers plus high/medium findings. Fix all 18 end-to-end. Do **not** adjust tests to accept current behaviour: fix production code, add a regression test that fails on the previous behaviour, update contracts/README/CHANGELOG, and leave no characterization test for known-bad behaviour. No commit, push, reset or stash.

### What was verified before changing anything

Ran a probe over all 18 findings rather than trusting fix markers already present in the tree. **17 were genuinely closed in production code; 1 was not.** The suite was still 154 tests, which was the real problem: the fixes existed but the regression tests the review demanded did not.

### The one finding still open — P0-2

`replaceData()` had been made atomic via a staging graph, but the **envelope-level `schemaVersion` was never checked at all**. A payload declaring schema 999 was silently half-read, accepted, and it replaced the live graph. Probe output: `malformed replace threw = false`, `old graph = LOST DATA`.

Fixed in `importData()`: an envelope version outside `SUPPORTED_SCHEMA_VERSIONS` throws before any live map is touched. The asymmetry is deliberate and documented — a future *envelope* is refused (an unreadable file), while a future *record/fact* is preserved verbatim and reported by `validate()` (one uninterpretable entity is survivable).

### Regression tests added (+63)

`test/review-findings.test.js` (45) covers P0-1 purge/idempotency, P0-2 atomicity, P1-8 fold permutation invariance, P1-9 dedupe, P1-10 SQLite/JSON confidence parity, P2-11 Infinity epoch, P2-12 duplicate seq, P2-13 `replayable:false`, P2-14 future schemas, P2-15 reorder invariance.

`test/review-interfaces.test.js` (18) covers P1-3 version drift, P1-4 HTTP query typing, P1-5 JSON-RPC codes, P1-6 notifications never answered, P1-7 resource/prompt validation.

One test failed on first run — my own comparison was too strict (it compared an id-derived dedupe key across two independent runs). The confidence numbers and counts were identical. Fixed the test, not the code.

### Verification

Historical snapshot: Suite **217 / 212 pass / 0 fail / 5 todo**. Current results are maintained in `docs/handoffs/current-status.md`.

### Still to do

At that historical point nothing was committed. The current release follow-up and branch state are recorded below and in `current-status.md`.

---

## Session 2026-08-26 · Final release hardening (current follow-up)

### What was done

- Added project-scoped idempotency isolation and legacy `action:key` cache migration when payload project identity is available.
- Preserved declared `journalSeq` high-water marks, including empty imported journals.
- Preserved legacy confidence current values as the baseline for first new evidence.
- Added indexed import-shape validation and direct-import preflight before live collection mutation.
- Added HTTP idempotency regression coverage and MCP schema coverage for write retry keys.
- Updated package-lock version metadata to 0.31.0 and marked v0.30 planning/review documents as historical or proposal material.

### Verification

The focused release follow-up suite passed **29/29**. The complete suite passed **236 tests / 231 pass / 0 fail / 5 todo** after deterministic legacy fact-ID coverage was added. Remaining TODOs are U-1 (accepted unverified-only), L-1, L-2, and L-5; modern MCP interoperability and warm-task economics remain unverified/deferred.
