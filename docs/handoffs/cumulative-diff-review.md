# ShadowGraph — Cumulative Diff Review (Phases 1–3)

> **Historical review snapshot — not the current implementation contract.** The findings below describe the pre-fix Phase 1–3 tree. A-1, A-2, A-3, B-4, and B-5 were subsequently resolved; consult `current-status.md`, `CHANGELOG.md`, and the current source.

**Reviewed:** 2026-08-25 at the pre-G4 gate.
**Range:** `1dde968` → working tree. Two tracked files modified (`src/shadowgraph.js` +127/−10, `test/v030.test.js` +13/−1), one untracked test file, `docs/` untracked.
**Nothing was changed as a result of this review.** Findings are recorded; fixes need approval.

---

## 1. Unintended public API / behaviour changes

### 🔴 A-1 — `fact.source` default changed value, and a shipped doc still names the old one

Pre-G2, `addFact()` with no `source` produced `source: 'model_inferred'`. It now produces `'agent_claimed'`.

`integrations/agent-policy.md:9` still reads:
> *"Treat `model_inferred` and `unverified` facts as hypotheses."*

**`model_inferred` can no longer be produced by any code path.** The policy file instructs agents to key off a value that no longer exists. This is a live doc-vs-behaviour contradiction in a *shipped integration file*, not a handoff note.

**Options:** (a) update the policy text to `agent_claimed`; (b) accept `model_inferred` as a recognised alias that downgrades to `agent_claimed` (it already does — it lands in `sourceRaw`), and say so in the policy. **Recommendation: (a)**, one-line doc edit, plus a note that pre-existing stored facts may still carry `model_inferred` in `source`.

### 🟠 A-2 — `addFact()` now throws where it previously accepted

`verificationStatus: 'verified'` and `'expired'` were accepted before and now throw. This is the **intended** G2 fix, but it is a **breaking input contract change** on a public method, and it is currently recorded only in the provenance contract and the handoff files. It is **not** in `CHANGELOG.md`, and `package.json` is still `0.30.0`.

**Recommendation:** CHANGELOG entry + a minor version bump when the checkpoint is committed. Not done — versioning is the user's call.

### 🟠 A-3 — `validate()` can now report `valid: false` on data that previously validated clean

New issue code `unknown_decision_status`. A v0.1 legacy record with **no** `status` field now yields `{valid: false, issues:[{code:'unknown_decision_status', status: null}]}`, where it previously returned `valid: true`.

This is deliberate (report-don't-rewrite, G3 contract §4.5) and is covered by an acceptance test. But any consumer that treats `validate().valid` as a health gate will start seeing failures after importing old data. **Recommendation:** document in CHANGELOG under a "validation is stricter" heading.

### 🟢 A-4 — Additive field changes (low risk)

Facts gain `sourceClass`, `actor`, `client`, `sessionId` (and `sourceRaw` conditionally). Decisions gain the same four. All plain JSON, all survive round-trip. The legacy `source` field is retained as a mirror of `sourceClass`, which is what keeps `test/v02.test.js` green.

**One asymmetry worth noting:** `sourceRaw` is **conditionally present** — absent when the input was already canonical. Consumers doing `Object.keys()` comparisons or strict schema validation will see two different fact shapes. Deliberate (avoids storing a redundant duplicate), but it is a shape inconsistency.

---

## 2. `importData()` backward compatibility

### ✅ B-5 — legacy fact import concern resolved in the current tree

The pre-fix review read `importData()` as defaulting imported facts to:

```js
{ schemaVersion, project: 'default', source: 'unknown', confidence: 0.5, status: 'active', ...clone(fact) }
```

`'unknown'` is **not** one of the four canonical source classes, and `sourceClass` is **never backfilled** on import. So a legacy fact ends up with `source: 'unknown'` and `sourceClass: undefined`, while a new fact has both set and agreeing.

Consequences:
- anything reading `fact.sourceClass` gets `undefined` for legacy facts;
- `validate()` does **not** check fact source, so this is silent — unlike the decision-status case, which G3 made visible.

The current implementation backfills `sourceClass`, preserves the raw legacy label, and generates a fact ID when absent. This is covered by `test/final-review.test.js`; the old recommendation below is retained only as historical review context.

> **Historical verification caveat:** the original probe was not executed at the pre-G4 gate. The current behavior has since been exercised by regression tests.

### 🟢 B-6 — decision import is consistent

`migrateRecord()` does not inject provenance fields, so legacy decisions simply lack `sourceClass`/`actor`/`client`/`sessionId`. Absent-vs-null is a mild shape asymmetry (new decisions get explicit `null`), but nothing reads these yet, so no consumer breaks.

---

## 3. Exports: intended public API or implementation detail?

| Constant | Used in `src/` | Used in `test/` | Any other consumer | Verdict |
| --- | --- | --- | --- | --- |
| `SOURCE_CLASSES` | ✅ `normalizeSourceClass` | ❌ | ❌ none | **Should not be exported** |
| `VERIFICATION_STATUSES` | ✅ `addFact` | ❌ | ❌ none | **Should not be exported** |
| `DOCUMENTED_DECISION_STATUSES` | ✅ builds `DECISION_STATUSES` | ✅ 3 uses | ❌ | test-only export |
| `LEGACY_DECISION_STATUSES` | ✅ builds `DECISION_STATUSES` | ✅ 4 uses | ❌ | test-only export |
| `DECISION_STATUSES` | ✅ `validate`, `normalizeDecisionStatus` | ✅ 4 uses | ❌ | test-only export |

**Decision (recorded, not applied):**

- **`SOURCE_CLASSES` and `VERIFICATION_STATUSES` are exported by mistake.** Nothing outside the module references them — not even a test. They were exported for symmetry while writing G2. They are **implementation details**.
- **The three `*_DECISION_STATUSES` are implementation details that were promoted to exports purely to serve tests.** That is exactly the anti-pattern the directive names.

**Why I am not changing them now:** the directive says change only if keeping them exported is a clear error *and* no real consumer depends on them. Two of the five qualify — but `SCHEMA_VERSION` is already exported and consumed by `test/v02.test.js`, so this module has an established precedent of exporting vocabulary. Un-exporting is a public-API decision that deserves its own ruling rather than being slipped into a review gate.

**Proposed alternative to test-driven exports** (needs approval):

The lifecycle vocabulary is a **contract**, so the test should assert against an **independent literal** rather than importing the implementation's own list. A test that reads `DECISION_STATUSES` from `src/` cannot detect "someone changed the vocabulary" — both sides move together. Today only the `.length === 13` / `=== 9` assertions catch that, which is a weak tripwire.

Concretely: keep all five constants **module-private**, and in the test file declare the expected vocabulary as a literal:

```js
const EXPECTED_DOCUMENTED = ['proposed','planned','in_progress','executed','validated',
                             'failed','reconsidered','superseded','abandoned'];
const EXPECTED_LEGACY = ['active','aging','stale','archived'];
```

then drive the loops from those. The test becomes a genuine specification: changing the code's vocabulary breaks it, which is the point. If a *real* external consumer later needs the vocabulary, expose it deliberately as a function (`listDecisionStatuses()`) with a documented stability promise — not as a mutable array reference.

**Note:** exported arrays are also mutable — `DECISION_STATUSES.push('anything')` from outside would corrupt validation for the process lifetime. If any of these stay exported, they should be frozen.

---

## 4. Tests coupled to implementation details

| Coupling | Severity | Note |
| --- | --- | --- |
| 3 constants imported from `src/` | 🟠 | See §3 — the drift guard's `.length` asserts partly compensate |
| `graph.exportData().records[0]` positional indexing | 🟢 | Used in several G3 tests; fine at n=1, would be brittle at n>1 |
| `events.filter(type==='decision.status').pop()` | 🟢 | Reasonable — asserts the latest event, not a fixed index |
| Error-message regex matching (`/cannot set fact verificationStatus to verified/`) | 🟠 | Couples tests to message wording. Deliberate for the pre-existing `Invalid fact verificationStatus` / `Invalid decision status` shapes (a compatibility guarantee), but the two **new** messages are now effectively frozen too |
| `Object.prototype.hasOwnProperty.call(fact,'sourceRaw') === false` | 🟢 | Asserts the conditional-presence contract from §A-4 — intentional |

No test reaches into closures or private functions. No test monkey-patches. Acceptable overall.

---

## 5. Comments and docs contradicting actual behaviour

| Location | Contradiction | Status |
| --- | --- | --- |
| `integrations/agent-policy.md:9` | names `model_inferred`, unproducible since G2 | 🔴 **open** — see A-1 |
| `docs/shadowgraph-vision-scope.md:33` | listed 9 states, omitted the 4 real ones | ✅ **fixed at this gate** |
| `docs/shadowgraph-next-session-brief.md:32` | same | ✅ **fixed at this gate** |
| `docs/shadowgraph-product-manager-current.md:25` | "Records facts with source normalization and verification status" — still true, but reads as though verification is achievable | 🟠 minor; should note nothing can reach `verified` |
| `docs/shadowgraph-redesign-proposal.md:57` | diagrams `proposed → planned → …` as if normative; code enforces no transitions | 🟠 open as **L-2** |
| `src/shadowgraph.js` header comment | "an explainable, outcome-aware decision graph" | 🟢 fine |
| `CHANGELOG.md` | no entry for any Phase 1–3 change | 🔴 **open** — see A-2 |

---

## 6. TODO clarity

19 `it.todo` entries. **5** are labelled `BLOCKED ON <id>` — these correctly name the blocker (U-1, L-1, L-2, L-5). **12** are labelled `AFTER FIX:` which does **not** distinguish:

- *deferred* (we know how, not scheduled yet) — e.g. the G6 completeness todos;
- *blocked* (needs a decision first) — e.g. the G5 purge todos depend on ADR-0001 acceptance;
- *future acceptance contract* (the spec for a phase not yet designed) — e.g. the G4 journal todos.

**Recommendation (not applied):** relabel to `DEFERRED (G6):` / `BLOCKED ON <id>:` / `CONTRACT (G4-C):`. This is a test-string-only change with zero production impact, but it is still a code edit, so it waits for approval.

The two remaining `AFTER FIX` in the G8 block are additionally **blocked on U-1** and do not say so — the most misleading of the twelve.

---

## 7. Summary of new items raised by this review

| ID | Item | Severity |
| --- | --- | --- |
| **A-1** | `integrations/agent-policy.md` names the unproducible `model_inferred` | 🔴 |
| **A-2** | No CHANGELOG entry / version bump for a breaking input-contract change | 🔴 |
| **A-3** | `validate()` stricter on legacy data — undocumented | 🟠 |
| **A-4** | `sourceRaw` conditional presence creates two fact shapes | 🟢 |
| **B-4** | `redact()` does not cover journal `payload` (raised in ADR-0001 D14) | 🔴 (pre-G4) |
| **B-5** | Historical legacy-fact import concern; current import backfills canonical provenance and generates missing IDs | ✅ resolved |
| **B-6** | Legacy decisions lack provenance fields (absent vs null) | 🟢 |
| **E-1** | `SOURCE_CLASSES`/`VERIFICATION_STATUSES` exported with zero consumers | 🟠 |
| **E-2** | 3 lifecycle constants exported only to serve tests | 🟠 |
| **E-3** | Exported arrays are mutable and unfrozen | 🟠 |
| **T-1** | 12 `AFTER FIX` todos don't distinguish deferred/blocked/contract | 🟠 |
