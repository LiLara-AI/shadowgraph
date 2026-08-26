# ShadowGraph — Confidence Contract (G8)

**Status:** implemented. Applies to `src/confidence.js`, policy id **`evidence_weighted_bounded_v1`**.

> **These weights are a DECLARED POLICY, not a measured calibration.** Nothing in this document claims empirical calibration. See §7 for what would be required to earn that claim.

---

## 1. Confidence is not verification

Two separate axes, never conflated:

| | Question it answers | Set by |
| --- | --- | --- |
| `verificationStatus` | Has ShadowGraph independently confirmed this? | Never by caller input (provenance contract §2) |
| `confidence` | How much does the accumulated evidence support this decision? | Evidence contributions, weighted by claimed source class |

A `human_confirmed` source class **raises confidence** but **never sets `verified`**. A provenance class is a claim about origin, so it can inform a degree of belief while never constituting proof. Reversing that — letting a strong claim mint verification — was the G2 defect.

## 2. Shape

```jsonc
"confidence": {
  "initial": 0.5,
  "current": 0.6,
  "policy": "evidence_weighted_bounded_v1",
  "basis": {
    "supportingEvidence": 1, "contradictingEvidence": 0,
    "successfulOutcomes": 1, "failedOutcomes": 0,
    "mixedOutcomes": 0, "unknownOutcomes": 0,
    "humanConfirmations": 0, "productionVerifications": 0,
    "declaredEvidence": 0,
    "policy": "evidence_weighted_bounded_v1",
    "contributions": [ … ]
  },
  "history": [ { "key", "kind", "delta", "from", "to", "reason", "sourceClass", "provenance", "at" } ]
}
```

`basis` counts are **derived from `contributions` on every write**, never stored independently, so they cannot drift from the underlying list. `history` explains each move with its own provenance, so every number is attributable.

## 3. The model

```
delta = BASE_STEP × classWeight(sourceClass) × direction
current = clamp(initial + Σ deltas, 0, 1)
```

| Parameter | Value | Rationale |
| --- | --- | --- |
| `BASE_STEP` | `0.2` | A full-strength observation moves confidence one fifth of the range |
| `agent_claimed` | `0.5` | The unconfirmed baseline |
| `tool_observed` | `0.7` | Stronger claimed origin |
| `human_confirmed` | `0.85` | Stronger still |
| `production_verified` | `1.0` | Strongest claimed origin |
| `successful` | `+1` | |
| `mixed` | `−0.5` | Partial success is weak negative evidence |
| `failed` | `−1` | |
| `unknown` | `0` | **"We do not know" is not evidence** and must move nothing |

No weight is zero for a *known* class: because nothing can currently reach `verified` (U-1), most real evidence is `agent_claimed`, and a scale that treated that as ~0 would freeze confidence at its initial value forever. An unrecognised class falls back to the `agent_claimed` weight rather than throwing.

## 4. Purity — why it is recomputed, not mutated

`computeConfidence(initial, contributions)` is a **pure fold**. `current` is recomputed from the whole contribution list on every change rather than incrementally adjusted.

This is what makes a **superseded or removed contribution leave no residue**. An incremental `current += delta` model cannot undo a contribution without a compensating entry, and compensating entries drift from the truth over time.

## 5. Double-counting prevention

Every contribution carries a stable `key`. `applyContribution` refuses a key already present, so a retried tool call, a replayed journal entry, or a duplicate outcome cannot inflate confidence. This is the mechanism, not a convention — dedupe is enforced in code and asserted by tests.

A zero-delta contribution (an `unknown` outcome) is deliberately **not** recorded in `basis.contributions`: it moves nothing, so recording it would add audit entries that explain no change. The operation is still recorded on the record and in the journal, so nothing is lost.

## 6. Absent evidence

With no contributions, `current === initial` and `basis` counts are all zero. Confidence never decays on its own — time passing is not evidence. Staleness is handled by the **lifecycle** (`aging` via `maintain()`) and by **reconsideration** (`reopenWhen`), which are separate mechanisms on purpose.

## 7. Calibration status — explicitly NOT established

Calibration means predicted confidence matches observed outcome frequency. Establishing it requires ground-truth outcomes at volume, which this project does not have.

**What is implemented:** a deterministic, explainable, auditable, dedupe-safe update rule.

**What is NOT implemented or claimed:** Brier score, ECE, reliability buckets, or any evidence that `0.7` means "right about 70% of the time".

Doing that honestly needs: a corpus of decisions with recorded real outcomes; a no-memory baseline; a benchmark that does **not** feed the answer through call arguments (the flaw that made G1's original review path untestable); and adversarial provenance cases. Until then, any calibration figure would have to be labelled **preliminary and synthetic** — and a synthetic score measures the generator, not the model.

**Open dependency:** U-1. While nothing can reach `verified`, the `human_confirmed` and `production_verified` weights are exercised only by *claimed* provenance, so their empirical justification is untestable.
