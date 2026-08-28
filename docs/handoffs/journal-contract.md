# ShadowGraph — Journal Contract (G4/G5)

**Status:** implemented. Applies to `appendJournal()` in `src/shadowgraph.js` and to `src/journal.js`. Project-scoped idempotency keys are canonical; legacy unscoped cache keys are migrated only when their payload identifies the project.
**Authority:** ADR-0001 and ADR-0007 (`accepted`). ADR-0007 defines the canonical baseline-placement invariant missing from the original design. This document describes what the code does; where they disagree, the code is the bug.

> **Terminology, stated once and used consistently:** the journal is **append-oriented with documented deletion semantics**. It is **not append-only** — an explicit hard purge deletes entries. Any doc that says "append-only" is wrong.

---

## 1. What this is not

Not event sourcing, not CQRS. There is no command bus, no separate read model, and no aggregate rehydration on the write path. Live state remains the canonical operational store; the journal is an audit-and-rebuild record written in the same transaction. Rationale and rejected alternatives: ADR-0001.

## 2. Entry shape

Every entry is produced by exactly one function, `appendJournal()`:

```jsonc
{
  "id": "jentry_<ts><rand>",
  "seq": 7,                  // monotonic integer — THE ordering key
  "type": "fact.observed",
  "at": "2026-08-25T…Z",     // temporal/human field, NOT the sort key
  "project": "default",
  "entityKind": "fact",      // decision | attempt | fact | memory | relation | project
  "entityId": "fact_…",
  "schemaVersion": 4,
  "payload": { … },          // complete post-operation snapshot, or null if redacted
  "provenance": { "actor": null, "client": null, "sessionId": null },
  "idempotencyKey": "…",     // present only when the operation carried one
  "causationId": "jentry_…"  // present only when caused by another entry
}
```

`idempotencyKey` and `causationId` are **conditionally present** — omitted rather than set to `null` — so their presence itself carries meaning.

## 3. Ordering: `seq`, never `at`

`at` cannot order entries, for three independent reasons: `now()` is injectable and tests pin it to a constant, so many entries legitimately share one `at`; millisecond ties occur naturally; and `id()` is `Date.now()` plus random suffix, so it is not monotonic either.

`seq` is a per-graph integer assigned at append time, persisted, and restored on import as `max(seq)`. It is unique and total, so **ties are impossible by construction**. `rebuildProjection` sorts by `seq` and ignores `at` entirely.

## 4. Payload: complete post-operation snapshot

Chosen over two alternatives:

| Option | Rejected because |
| --- | --- |
| Command/operation replay | `id()`/`now()` are non-deterministic so replay cannot reproduce ids or timestamps; and replaying an `addFact` command through *future* code could produce a different verification outcome — **re-opening the G2 bypass by the back door**. Disqualifying. |
| State delta | An entry is unreadable alone; rebuild needs a correct base plus every intervening delta; one corrupt delta poisons everything after it. |
| **Complete snapshot** ✅ | Rebuild is a **fold**, not a re-execution: deterministic, self-describing, version-independent, and a corrupt entry damages one entity instead of the chain. |

Cost, stated honestly: storage grows with `entity size × mutation count`, not with change size. Measured numbers and the snapshot/compaction threshold are in `benchmark-report.md`.

## 5. Entry types

`REPLAYABLE_ENTRY_TYPES` (17) — `projection.baseline`, `decision.recorded`, `decision.status_changed`, `decision.superseded`, `decision.aged`, `attempt.recorded`, `fact.observed`, `fact.superseded`, `fact.expired`, `outcome.recorded`, `confidence.changed`, `relation.created`, `memory.recorded`, `memory.indexed`, `memory.superseded`, `memory.invalidated`, `project.purged`.

`NON_REPLAYABLE_ENTRY_TYPES` (1) — `legacy_metadata_event`.

**Every listed type is produced by real code.** No aspirational types. `appendJournal()` throws `Unknown journal entry type: <type>` on anything else, so a typo cannot silently create a new type.

**Alternatives deliberately have no entry type.** They have no independent mutation API — they are created inside `addDecision` and read by `review()` — so giving them entries would imply an editing capability that does not exist. They ride inside the decision snapshot. This is a documented design decision, not an omission.

## 6. Rebuild

`rebuildProjection(entries, options?)` in `src/journal.js` is **pure**: no clock, no filesystem, no randomness, no domain logic, no id generation. It returns a report rather than throwing:

```jsonc
{ ok, rebuildable, reason, projection, journalEpoch,
  replayedFrom, replayedTo, applied, skipped[], legacy[] }
```

Fold rule: entries sorted by `seq`; for each ordinary snapshot, `entity[entityId] = payload`. **Last writer per entity wins.** `project.purged` derives deletion structurally from the project entities accumulated by the fold, includes nested alternative IDs, and removes relations whose endpoint was deleted. New purge markers therefore need no raw entity-ID list. Raw schema-1–4 markers remain readable at the pure-fold boundary, but import migrates them before removing `purgedEntityIds`: referenced pre-marker entity/relation snapshots are payload-tombstoned, referenced baseline members and idempotency payloads are removed, and the pre/post folds plus gap evidence must be equivalent or import fails. Unrelated newer markers are not globally rewritten. A redacted skeleton carries no `entityId`; the following project marker performs the structural deletion, so a rebuild after a logical purge does not resurrect purged data.

### Baseline placement (ADR-0007)

`projection.baseline` is a replay boundary, not an ordinary last-writer mutation. There is at most one replayable baseline. Canonically it is the first replayable entry and its `seq` equals the declared `journalEpoch`; pre-epoch `legacy_metadata_event` entries may precede it because they are explicitly non-replayable.

Compatibility has two bounded forms. A schema-1–3 baseline may be the first surviving replayable entry after an older epoch because no replayable state precedes it. A single migration baseline (`derivedFrom: 'live_state_at_migration'`, or schema 1–3) may extend an existing replay range only when a prefix fold proves it is monotonic: it cannot rewrite an existing entity or idempotency value, resurrect a removed entity, or replace an expired/superseded fact; an existing epoch is never advanced. A sanitized schema-1–3 purge baseline may become empty. Lifecycle validation merges through this extension and never clears prior per-fact state.

A baseline is selectively canonicalized whenever legacy purge migration, logical purge, hard purge, or a redacted export actually changes one of its `records`, `facts`, `relations`, or `idempotency` collections. The rewritten payload then contains exactly those four collections. Its envelope retains only journal identity, sequence/order, type/time, project/entity classification, schema, `derivedFrom`, optional replayability, payload, and null `{actor, client, sessionId}` provenance. Caller-linked `causationId`, `idempotencyKey`, request/user/agent/run identifiers, and unknown envelope or payload metadata are removed. A purge or redaction that does not change any baseline collection does **not** sanitize that baseline, preserving untouched audit data and placement.

Every other duplicate, midstream, rewind, wrong-epoch, or baseline-after-terminal form is blocking code `invalid_projection_baseline_placement`. Pure rebuild skips the invalid baseline and returns `rebuildable:false`, reason `journal contains invalid projection baseline placement`, plus the stable code in `skipped[].why`; it never folds the forged snapshot into trusted output. Direct import/replacement and JSON/SQLite restore reject before destination mutation, and CLI/HTTP/MCP preserve the same code.

`reviewSignals` are **not** replayed — they are regenerated by calling `review()` on the rebuilt projection. That is what makes them a projection rather than state.

Because rebuild is a fold over snapshots and runs no domain logic, **it cannot mint trust**. It can faithfully carry a `verified` fact that a legacy import already contained (U-3), but it can never create one. Invalid baseline placement is skipped and makes the report non-rebuildable rather than allowing a copied genuine signature to reactivate an expired or superseded fact.

## 7. Unknown and unsupported entries

| Situation | Behaviour |
| --- | --- |
| Unknown `type` | `skipped[]` with `why: 'unknown_entry_type'`, and `rebuildable: false` |
| `schemaVersion` newer than supported | `skipped[]` with `why: 'unsupported_schema_version'`, and `rebuildable: false` |
| No `seq` (pre-journal metadata event) | `legacy[]` with `why: 'metadata_only_no_seq'` |
| `legacy_metadata_event` | `legacy[]` with `why: 'non_replayable_type'` |
| Not an object | `skipped[]` with `why: 'not_an_object'` |

**Never dropped silently, never thrown.** Dropping is data loss; throwing makes a newer file unopenable. `validate()` reports the same conditions as `unsupported_journal_entry` / `unsupported_journal_schema_version`.

The rule that matters: **a partial projection is never returned as if it were complete.** `rebuildable: false` plus a `reason` is the honest answer.

## 8. Migration boundary — history is never fabricated

Pre-existing events carry `{id, type, at, project, recordId}` and **no payload**. They cannot be replayed. Claiming retroactive rebuildability would be fabrication.

`journalEpoch` is the first replayable boundary, persisted in `exportData()` and restored on import. Rebuild replays `seq >= journalEpoch`. A migration extension never advances an existing epoch. A leading hard-purge gap may leave the first surviving sequence greater than the epoch only when the purge ledger proves every missing sequence. With `options.requireFullHistory`, a journal containing pre-epoch metadata-only entries returns `rebuildable: false, reason: 'pre-epoch metadata-only entries are not replayable'`.

`projection.baseline` carries a full projection snapshot for migrated stores. It is a **reconstruction from live state at migration time**, and is labelled as such — not as replayed history.

## 9. Purge

**Logical (default).** `purgeProject(project)` or `{ mode: 'logical' }`. Entities are removed from live state; matching journal entries are reduced to an allowlisted audit skeleton: `id`, `seq`, `type`, `at`, `project`, `entityKind`, `entityId: null`, `schemaVersion`, optional replay classification, `payload: null`, redaction flags, and `provenance: { actor: null, client: null, sessionId: null }`. Caller-linked fields such as `idempotencyKey`, `causationId`, transition metadata, request/scope identities, and unknown extra fields are removed. Matching compatibility events and idempotency payloads are deleted. A `project.purged` entry is appended with project, mode, counts, null provenance, and no raw `purgedEntityIds`. **`seq` stays contiguous**; the non-identifying skeleton remains auditable and the marker drives structural replay deletion. Returns `journalEntriesRedacted`.

**Hard (explicit, never default).** `{ mode: 'hard' }` or `{ hard: true }`. Entries are spliced out. This **creates a `seq` gap** — declared, not hidden: `journalGaps()` reports the missing ranges and `validate()` surfaces them as `journal_gap` at severity `info`. The surviving purge marker contains no raw entity IDs; it carries only the exact transitive `removedJournalSequences` ledger needed as irreversible gap evidence, and later hard/logical purges preserve that evidence. The shared direct-import/replace and JSON/SQLite restore validator requires every ledger value to be a positive safe integer, unique in its marker, an actual missing sequence in the replay range, and strictly earlier than the marker that claims it. A missing sequence is accepted only when a later surviving hard marker covers it; duplicate, future/early, present/unrelated, and incomplete claims fail closed through JavaScript, CLI, HTTP, and MCP. Coverage uses sorted ranges and cursors, never materializes a missing range, and therefore rejects enormous forged gaps with bounded work. Returns `journalEntriesRemoved`.

Both modes remove relations pointing at purged entities, so referential integrity holds after either.

**Right to erasure vs auditability:** hard purge is the deliberate exception. It satisfies erasure at the cost of a discontinuous journal, which is why the sequence gap is reported rather than concealed, and why "append-only" is not claimed anywhere.

## 10. Atomicity — by co-location, not protocol

The journal lives **inside the same payload as the state** and is written by the same operation. JSON: `exportData()` serializes both, `save()` does one temp-write plus `rename()`. SQLite: `save()` runs `BEGIN IMMEDIATE` → replace → `COMMIT`. State and journal therefore **cannot** diverge on a failed write.

**Binding rule for future work:** never persist the journal through a separate file, table write, or transaction. Doing so voids this guarantee and makes a two-phase protocol mandatory.

The residual failure mode is benign and different: a crash between an in-memory mutation and the next `save()` loses the state change **and** its entry together — consistent, not divergent.

## 11. Idempotency

`idempotent()` short-circuits before any mutation, so a replayed call appends no entry. `idempotencyKey` is recorded on the entry that first performed the operation, and rebuild reconstructs the map from it — so idempotency survives a rebuild without journalling the cache as its own entity.

## 12. Security

1. Entry `provenance` describes **who performed the write**. It is not evidence about the claim and never elevates `verificationStatus`.
2. An entry claiming `sourceClass: 'human_confirmed'` yields a fact that is still `unverified`. A journal file is caller input, and the provenance contract §2 applies to it identically.
3. Rebuild cannot newly mint `verified` (§6).
4. `redact()` covers journal payloads. Secrets must not survive redaction inside an entry.
