# ShadowGraph — G4 Implementation Plan (G4-A … G4-G)

> **Historical pre-implementation plan — superseded by the implemented journal contract.** Do not use this file as the current API or status authority; see `journal-contract.md` and `current-status.md`.

**Status:** 🔴 **NOT APPROVED — do not start.** Blocked on user acceptance of ADR-0001 (including its appended G4 design, D1–D14) and of this phase split.
**Design reference:** `decision-log.md` → ADR-0001 → "G4 DETAILED DESIGN".
**Prerequisite rulings:** J-1, J-2, J-3 (ADR-0001), and blocker **B-4** (`redact()` must cover journal `payload`) must be resolved before G4-B writes any payload.

Guiding rule for every sub-phase: **the existing `events` array and all current behaviour stay untouched until G4-E**, and every sub-phase leaves `npm test` green.

---

## G4-A — Journal contract, fixtures, and acceptance contracts

**Goal:** freeze the target shape and the equivalence baseline before any production code exists.

| | |
| --- | --- |
| **Files** | **new** `docs/handoffs/journal-contract.md`; **new** `test/fixtures/projection-baseline.json`; **modify** `test/gap-regressions.test.js` (G4 block: relabel the 2 `AFTER FIX` todos to `CONTRACT (G4-C)` and add the full journal acceptance contract as `it.todo`) |
| **Production code** | **none** |
| **Public API impact** | none |
| **Backward compat** | none at risk |
| **Tests** | Freeze current `exportData()` for a representative graph (decisions + alternatives + facts + attempts + outcomes + relations + supersession + idempotency) as a committed fixture. Add one *passing* test asserting the fixture still matches today's `exportData()` — this is the X-3 baseline and will catch accidental shape drift during G4-B…D. |
| **Acceptance** | fixture committed; baseline test passes; every D1–D14 rule has a named `it.todo`; suite green |
| **Rollback** | delete the fixture + todos; zero production impact |
| **Own commit?** | ✅ yes — pure specification, safe to land early |

---

## G4-B — Write complete journal entries; live state stays canonical

**Goal:** emit payload-complete entries alongside every mutation, without anything reading them yet.

| | |
| --- | --- |
| **Files** | `src/shadowgraph.js` (new `appendJournalEntry()` + `seq` counter; call sites in `addDecision`, `addFact`, `addAttempt`, `setOutcome`, `updateDecisionStatus`, `supersedeDecision`, `link`, `maintain`); `src/storage.js` + `src/sqlite-storage.js` (carry a `journal` array in the payload — **same** write/transaction as state, per D6) |
| **Production code** | yes — additive only, behind `SHADOWGRAPH_JOURNAL=1`, **default off** |
| **Public API impact** | `exportData()` gains a `journal: []` key **only when the flag is on**. Flag off ⇒ byte-identical output |
| **Backward compat** | old files load unchanged (no `journal` key ⇒ empty journal). `events` array continues to be written exactly as today |
| **Tests** | one entry per operation with the D3 schema; `seq` strictly increasing across ops; `seq` survives export→import as `max+1`; entries carry write-provenance; `causationId` set on the `confidence.changed` that follows an `outcome.recorded`; **flag-off produces byte-identical `exportData()`** (the rollback guarantee, asserted); **D14 rule 2** — a journal entry claiming `human_confirmed` still yields `unverified` |
| **Acceptance** | all above pass; JSON **and** SQLite both carry the journal in one atomic write; suite green with flag off *and* on |
| **Rollback** | flag defaults off; revert this commit alone |
| **Own commit?** | ✅ yes — the largest single step; keep it isolated |

---

## G4-C — Pure replay / rebuild function

**Goal:** turn entries back into a projection, deterministically.

| | |
| --- | --- |
| **Files** | **new** `src/journal.js` exporting `rebuildProjection(entries, options?)`; **new** `test/journal-rebuild.test.js` |
| **Production code** | yes — a new module, **not wired into anything** |
| **Public API impact** | new module, additive. Whether `rebuildProjection` is public API or internal: **decide at this point**, following whatever ruling E-1/E-2 gets |
| **Backward compat** | not at risk — nothing calls it |
| **Tests** | fold semantics (last writer per entity wins); pure (same input ⇒ same output; no clock/random/IO); empty journal ⇒ empty projection; out-of-order input sorted by `seq`; `seq` gaps tolerated (D11); unknown `type` ⇒ `skipped[]` + `rebuildable:false`, never a throw; pre-epoch replay ⇒ `rebuildable:false` with a reason (D9 rule 5 — the anti-fabrication assertion); `reviewSignals` **not** produced by replay |
| **Acceptance** | rebuild reproduces decisions/alternatives/facts/attempts/relations/idempotency from a journal alone; refuses honestly where it cannot |
| **Rollback** | delete the module; nothing depends on it |
| **Own commit?** | ✅ yes |

---

## G4-D — Projection equivalence on JSON and SQLite (**the X-3 gate**)

**Goal:** prove rebuild output equals live state, or prove ADR-0001 wrong.

| | |
| --- | --- |
| **Files** | **new** `test/journal-equivalence.test.js`; possibly a `canonicalize()` test helper |
| **Production code** | **none** (unless a real divergence demands a fix — then that fix is its own commit) |
| **Public API impact** | none |
| **Backward compat** | none at risk |
| **Tests** | canonical-JSON compare `rebuildProjection(journal).projection` vs `exportData()` (excluding `events`/`reviewSignals`/`revision`) across: a fresh graph; every operation type; supersession chains; superseded facts; idempotent replays; multi-project graphs; **after JSON persist+reload**; **after real SQLite close+reopen**. Plus **D14 rule 3**: no rebuilt fact is `verified` unless the live fact is too |
| **Acceptance** | byte-equal canonical projections on both backends |
| **⚠️ Failure protocol** | **Do not force it.** If divergence is irreconcilable, stop, write the divergence up, and **supersede ADR-0001** with a new ADR. That is the pre-registered falsifier for X-3 |
| **Rollback** | tests only |
| **Own commit?** | ✅ yes — this commit is the go/no-go record |

---

## G4-E — Migration boundary for legacy data

**Goal:** make rebuildability start at an honest, explicit epoch.

| | |
| --- | --- |
| **Files** | `src/shadowgraph.js` (`SCHEMA_VERSION` → 3; `projection.baseline` emission; retype old events as `legacy_metadata_event`, `replayable:false`); `src/storage.js`/`src/sqlite-storage.js` (`journalEpoch` in metadata); `test/journal-migration.test.js` |
| **Production code** | yes — **the first step that touches existing user data on load** |
| **Public API impact** | `SCHEMA_VERSION` becomes 3 — **`test/v02.test.js` asserts `data.schemaVersion === SCHEMA_VERSION`** (imported, so it follows automatically), but `test/interfaces.test.js:107` asserts a literal `schemaVersion: 2` in the CLI stats payload and **will need updating**. `test/v030-storage.test.js` and `sqlite.test.js` also use literal `schemaVersion: 2` payloads |
| **Backward compat** | ⚠️ **highest-risk sub-phase.** v2 files must open, migrate once, and never lose an event. Requires: backup before migrate, idempotent migration (running twice is a no-op), and an interrupted-migration test |
| **Tests** | v2 file opens and gains exactly one baseline at the epoch; old events retained verbatim and marked non-replayable; baseline labelled `derivedFrom:'live_state_at_migration'`; replay across the epoch returns `rebuildable:false`; migration is idempotent; interrupted migration leaves the file readable; the three literal-`schemaVersion` tests updated |
| **Acceptance** | no event lost, no history fabricated, migration idempotent, all backends |
| **Rollback** | ⚠️ **the only sub-phase that is not cleanly revertible** once a user file is migrated. Mitigation: mandatory automatic backup before first migration, and a documented downgrade note. **Land this commit last among B–E** |
| **Own commit?** | ✅ yes — and it should be the one requiring the most review |

---

## G4-F — Tombstone / hard-purge journal integration

**Goal:** define journal behaviour for erasure — **shape only**.

| | |
| --- | --- |
| **Files** | `src/shadowgraph.js` (`validate()` gains `journal_gap`; `redact()` extended to cover `payload` — **fixes blocker B-4**); tests |
| **Production code** | yes, small |
| **Public API impact** | two new `validate()` issue codes |
| **Backward compat** | additive |
| **Tests** | `journal_gap` reported with the missing range; `redact()` masks secrets inside `payload`; rebuild tolerates gaps |
| **Acceptance** | gaps declared not hidden; no secret survives redaction in a payload |
| **Rollback** | revert commit |
| **Own commit?** | ✅ yes |
| **⚠️ Recommendation** | **Defer G4-F wholesale into G5.** Purge *behaviour* (tombstone vs hard) is G5's subject, and splitting its journal half into G4 invites a half-specified purge. The single exception worth pulling forward is the **`redact()` payload fix (B-4)** — it is a security gap the moment G4-B writes payloads, so it belongs in **G4-B**, not here |

---

## G4-G — Measure rebuild cost; report whether snapshots are needed

**Goal:** settle X-2 with numbers, not intuition.

| | |
| --- | --- |
| **Files** | **new** `scripts/bench-journal.mjs` (not part of `npm test`); results appended to `test-and-benchmark-log.md` |
| **Production code** | **none** |
| **Public API impact** | none |
| **Backward compat** | none at risk |
| **Tests** | not a test — a benchmark. Generate 1k/10k/100k entries; measure `rebuildProjection` wall time (p50/p95 over ≥5 runs) and journal bytes vs projection bytes |
| **Acceptance** | numbers recorded against the **pre-declared D13 thresholds** (>250 ms @10k, >1 s @100k, or >10× size @10k). Verdict stated plainly: snapshots needed or not |
| **Rollback** | delete the script |
| **Own commit?** | ✅ yes |
| **Rule** | **no snapshotting is implemented in G4 regardless of the result** — a breach triggers a new ADR, not an ad-hoc addition |

---

## Recommended order and gates

```
G4-A ──► G4-B ──► G4-C ──► G4-D ──► [X-3 GATE] ──► G4-E ──► G4-G
 spec     write     replay   equivalence            migrate   measure
                                    │
                                    └── fails ⇒ STOP, supersede ADR-0001
```

- **G4-F folded into G5**, except the `redact()` payload fix which moves into **G4-B**.
- **G4-E lands last** among the code phases because it is the only one that mutates user files.
- **G4-D is the decision point.** Everything after it is conditional on equivalence holding.

## Total scope estimate

7 sub-phases → **6 commits** (F folded away), touching `src/shadowgraph.js`, `src/storage.js`, `src/sqlite-storage.js`, one new `src/journal.js`, four new test files, one fixture, one bench script. Four existing tests need `schemaVersion` updates in G4-E.

## Do NOT do during G4

Snapshots/compaction (D13) · CQRS or read-model separation (ADR-0001) · purge behaviour (G5) · completeness contracts (G6) · search changes (G7) · confidence basis (G8) · MCP protocol work (ADR-0003) · resolving U-1/U-2/U-3 or L-1…L-6 · echoing caller input into entries (D4 sub-decision).
