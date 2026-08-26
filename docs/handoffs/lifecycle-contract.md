# ShadowGraph — Decision Lifecycle Contract (G3)

**Status:** implemented in Phase 3 (2026-08-25). Applies to `updateDecisionStatus()` and `validate()` in `src/shadowgraph.js`.
**Scope:** G3 only. Does **not** change provenance/verification (G2), reconsideration (G1), event payloads, purge, search, pagination, or confidence.

---

## 1. What was actually wrong

The docs and the code used two **different vocabularies**, and neither was a superset of the other.

`docs/shadowgraph-vision-scope.md:33` and `docs/shadowgraph-next-session-brief.md:32` promise nine states. `src/shadowgraph.js` accepted eight — of which **four were undocumented** and **five of the promised nine were rejected outright**.

Reading every producer and consumer of `record.status` revealed that the four undocumented states are *not all the same kind of thing*, which is why a naive "just merge both lists" would have been wrong.

## 2. Vocabularies that are NOT decision lifecycle (untouched)

`status` is an overloaded field name in this codebase. Only **decision** `status` is in scope.

| Entity | `status` values | Where |
| --- | --- | --- |
| **Alternative** | `rejected` | `addDecision()` |
| **Fact** | `active` · `superseded` · `expired` | `addFact()`, `maintain()` |
| **Review signal** | `open` · `acknowledged` | `review()`, `acknowledgeReview()` |
| **Outcome** | `successful` · `mixed` · `failed` · `unknown` | `setOutcome()` |

None of these were changed. Note that `failed` appears in both the outcome vocabulary and the decision vocabulary with **different meanings** — an outcome describes what happened, a decision status describes the decision's own state.

## 3. Classification of every state

Determined by reading producers and consumers, not by guessing.

### 3.1 Core execution-lifecycle states (the documented nine)

| State | Accepted before? | Producer | Consumer | Notes |
| --- | --- | --- | --- | --- |
| `proposed` | ✅ | caller only | `search({status})` | |
| `planned` | ❌ **rejected** | caller only | `search({status})` | **added** |
| `in_progress` | ❌ **rejected** | caller only | `search({status})` | **added** |
| `executed` | ❌ **rejected** | caller only | `search({status})` | **added** |
| `validated` | ✅ | caller only | `maintain()` aging candidate · `search({status})` | load-bearing — `test/v025.test.js` |
| `failed` | ✅ | caller only | `search({status})` | load-bearing — `test/interfaces.test.js` |
| `reconsidered` | ❌ **rejected** | caller only | `search({status})` | **added** |
| `superseded` | ✅ | `supersedeDecision()` | `supersedeDecision()` chain guard · `search({status})` | load-bearing — `test/v027.test.js` |
| `abandoned` | ❌ **rejected** | caller only | `search({status})` | **added** |

### 3.2 `active` — a VALIDITY state, not an execution state

**This is the key finding.** `active` is not a missing rung on the execution ladder; it is a different axis entirely — "this decision is currently in force and not superseded/filed".

- **Producers:** `addDecision()` (hardcoded default) and `supersedeDecision()` (sets the replacement to `active`).
- **Consumers:** `context().activeDecisions` filters `status === 'active'`; `maintain()` treats `active` as an aging candidate; `search({status})`.
- **Verdict:** **canonical, retained, and now documented.** It cannot be aliased onto any of the nine without changing what `context()` returns and breaking `test/v02.test.js` and `test/v030.test.js`.

### 3.3 `aging` — a DERIVED state

- **Producer:** `maintain()` only, when `reviewAfter <= now` and status is `active` or `validated`.
- **Consumer:** `search({status})`.
- **Verdict:** **canonical, retained, documented as derived.** Callers may set it, but the system also computes it. It is a review signal expressed as a status, not a step an agent walks through.

### 3.4 `stale` and `archived` — caller-only, no producer

- **Producers:** **none.** Nothing in `src/` ever sets either one.
- **Consumers:** `search({status})` only.
- **Verdict:** **canonical, retained, marked DEPRECATED.** They stay accepted because stored data or existing callers may use them, and the directive requires backward compatibility absent a documented reason to break it. `archived` overlaps `abandoned` semantically but is **not** aliased onto it — see §5.

## 4. The contract

### 4.1 Canonical stored states — 13

```
Core lifecycle (9, documented):
  proposed · planned · in_progress · executed · validated
  failed · reconsidered · superseded · abandoned

Validity (1):        active     ← default for new decisions
Derived (1):         aging      ← set by maintain()
Deprecated (2):      stale · archived   ← accepted, never produced
```

### 4.2 Accepted aliases — formatting only

Normalization is `trim()` → `toLowerCase()` → `-` becomes `_`. So `IN_PROGRESS`, `in-progress`, and ` In-Progress ` all resolve to `in_progress`.

This mirrors the alias rule already established for provenance in G2 (`normalizeSourceClass`), and it exists because MCP clients commonly send hyphenated or title-cased enums.

**No semantic aliases exist.** `archived` does not map to `abandoned`; `active` does not map to `executed`. See §5.

### 4.3 Canonical on read — yes

`updateDecisionStatus()` stores and returns the **canonical** form. A caller passing `in-progress` gets back `in_progress`, and that is what persists and what `search({status: 'in_progress'})` will match.

### 4.4 Unknown status — throws, never silent

`updateDecisionStatus()` throws `Invalid decision status: <raw>` — the **pre-existing message shape**, so any caller matching on it keeps working. The raw (un-normalized) value is echoed so the caller sees what it actually sent.

### 4.5 Import — preserves data, reports rather than rewrites

`importData()` **does not** validate or rewrite `status`. Legacy data carrying `active` / `aging` / `stale` / `archived` — or even a status from outside the vocabulary — loads unchanged.

Rationale, consistent with the G2 import decision: import is a migration/restore path, not an agent assertion. Rewriting stored values would break `exportData`/`importData` round-trip stability (which runs on every persist and reload) and violates the security doc's *"do not rewrite user data in place"*.

**But it is not silent.** `validate()` now reports an `unknown_decision_status` issue for any stored status outside the canonical 13. This makes the problem discoverable and fixable without destroying data. `repairPlan()` routes it to `manual_review` (its existing default for non-relation issues), so nothing is auto-mutated.

## 5. Deliberately NOT done — these need product decisions

Each of these was reachable but would have required inventing semantics. Per the directive, they are recorded instead of guessed.

- **L-1 — the entry state disagrees with the documented diagram.** `docs/shadowgraph-redesign-proposal.md:57` shows `proposed → planned → …`, implying new decisions start at `proposed`. `addDecision()` hardcodes `active`. Changing the default would alter what `context().activeDecisions` returns and break `test/v02.test.js` (expects 1 active decision) and `test/v030.test.js` (aging needs `active`/`validated`). **Left as `active`.** Needs a product decision: is `proposed` the entry state, and if so does `context()` surface proposed decisions?
- **L-2 — transitions are not enforced.** The documented diagram implies an ordering; the code allows any state → any state. Enforcing it would break `test/v025.test.js` (`active` → `validated` directly) and `test/interfaces.test.js` (`active` → `failed` directly). **No transition graph was added.** Needs a decision on whether the diagram is normative or illustrative.
- **L-3 — `maintain()` aging candidates were not extended.** It ages only `active` and `validated`. Arguably `executed` should also age, but `maintain()` calls `review()`, so changing it changes review-signal generation — explicitly out of scope for G3.
- **L-4 — `search({status})` does not normalize its filter.** `search('x', {status: 'IN_PROGRESS'})` will not match stored `in_progress`. Fixing it means touching search semantics, which G3 is forbidden from doing. Callers must pass canonical values.
- **L-5 — `stale` and `archived` have no producer and no documented meaning.** They are retained for compatibility only. Needs a decision: give them meaning, formally deprecate with a migration, or drop them in a future schema version.
- **L-6 — `addDecision()` still ignores a caller-supplied `status`.** Unchanged from before; every new decision is `active`. Related to L-1.

## 6. Docs that now need updating (not done in this phase)

`docs/shadowgraph-vision-scope.md:33` and `docs/shadowgraph-next-session-brief.md:32` list nine states and omit `active`, `aging`, `stale`, `archived`. Those four are real, stored, and in two cases load-bearing. The docs are therefore **incomplete**, not merely aspirational. Updating the public-facing vision/brief text is left for a docs pass so this phase's diff stays confined to G3 code plus this contract.
