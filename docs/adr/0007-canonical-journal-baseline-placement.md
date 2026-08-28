# ADR-0007 — Canonical journal baseline placement cannot reset replay history

- **Status:** `accepted` (2026-08-28)
- **Scope:** `projection.baseline` generation, import/replace, restore validation, rebuild diagnostics, migration, hard purge, and fact lifecycle replay.
- **Related:** ADR-0001 D9/D14 and ADR-0006 migration guarantees. This ADR fills a placement invariant that those accepted decisions assumed but did not state.

## Context

`projection.baseline` is a reconstruction boundary, not an ordinary last-writer snapshot. Fact lifecycle validation previously called `states.clear()` for every baseline. A forged backup could therefore retain genuine `fact.observed → fact.verified → fact.expired|fact.superseded` entries, append a higher-sequence baseline copied from the earlier active signed fact, make the live projection match that baseline, and pass import/restore projection equivalence. Rebuild then exposed an active verified fact without re-running the signing channel.

Per-entry signatures and postconditions do not solve this: the copied active snapshot and signature are individually genuine. Placement and ordered lifecycle are the missing invariants.

## Decision

### Canonical placement

A journal contains **at most one replayable `projection.baseline`**.

The canonical form places it at the first replayable sequence and, when `journalEpoch` is declared, at exactly that epoch. Pre-epoch `legacy_metadata_event` entries remain non-replayable and may precede it physically.

The stable blocking issue code is:

```text
invalid_projection_baseline_placement
```

Duplicate, ordinary midstream, pre-epoch rewind, wrong-epoch, and terminal-lifecycle rewrite forms fail with that code in direct import, replacement, restore validation, JSON/SQLite restore, and CLI/HTTP/MCP restore surfaces. Rejected writes leave the destination unchanged.

### Narrow migration compatibility

Two migration shapes remain accepted because their safety can be proved without clearing history:

1. A schema-1–3 baseline may be the first surviving replayable entry after its older declared epoch. No replayable state precedes it, so it cannot reset a known lifecycle.
2. A single baseline explicitly marked `derivedFrom: "live_state_at_migration"` (or a schema-1–3 migration baseline) may extend an existing replay range only when a prefix fold proves it is monotonic: it cannot rewrite any existing entity or idempotency value, cannot resurrect a removed entity, and cannot replace an expired or superseded fact. It may add previously unseen projection state. A sanitized schema-1–3 purge baseline may be empty after migration.

A migration extension never advances an existing `journalEpoch`. Earlier replayable entries remain in range. Fact lifecycle state is merged through the extension; it is never cleared. Baseline idempotency values are generated from the final canonical entities rather than stale cache clones.

These are placement exceptions, not count exceptions: a second replayable baseline is always invalid.

### Journal-less merge representation

A journal-less import is not permission to reset an established replay range. Initial imports still receive one honest `projection.baseline`, and a baseline-free range may still receive the proven monotonic unseen-state migration extension above. A merge that changes an existing entity or idempotency mapping instead appends complete post-merge entity snapshots using only the existing replay vocabulary:

- `memory.recorded`, `memory.superseded`, or `memory.invalidated` according to the final memory status;
- `fact.observed`, `fact.verified`, `fact.superseded`, or `fact.expired` according to the fact lifecycle transition;
- `decision.recorded`, `attempt.recorded`, or `relation.created` for the other entity kinds.

When an idempotency mapping is new or changes, its canonical key is attached as `idempotencyKey` to the corresponding complete entity snapshot. Existing mappings that reference an overwritten entity are refreshed to that final canonical entity, so replay and retries cannot retain a stale private payload. No generic import, update, or unknown journal type is introduced.

The entire generated batch is built before mutation. Sequence allocation (including overflow), entry type/payload postconditions, baseline placement, hard-purge gap evidence, ordered fact lifecycle, and the fold's equality with the proposed final records/facts/relations/idempotency projection are checked against the combined old-plus-generated journal. Only that exact prebuilt batch is then appended. The destination `journalEpoch` and all prior entries remain unchanged.

Some state rewrites have no honest transition in the existing vocabulary. In particular, a journal-less merge cannot turn an expired or superseded verified fact back into an active verified fact. Combined lifecycle preflight rejects that resurrection atomically rather than encoding it as a snapshot reset.

### Rebuild behavior

Pure rebuild does not throw. It reports:

- `rebuildable: false`;
- `reason: "journal contains invalid projection baseline placement"`;
- one or more `skipped[]` entries with `why: "invalid_projection_baseline_placement"` and a placement classification.

An invalid baseline is not folded. Prior terminal snapshots remain authoritative, so an incomplete rebuild never presents the forged active verified resurrection as trusted state.

### Hard purge

A baseline, when present, remains at its canonical boundary and is scrubbed in place by purge. Baseline-free journals may retain leading hard-purge gaps when the surviving `removedJournalSequences` ledger proves them. A forged later baseline cannot use that gap ledger as permission to reset history.

## Consequences

- Matching live state is necessary but no longer sufficient for restore; journal placement must also be canonical.
- Journal-less merge overwrite is append-only at this boundary: it preserves the old replay range and represents the new projection with typed complete-snapshot deltas.
- Signed evidence remains audit evidence on expired/superseded facts, but copied evidence cannot move a terminal fact back to active.
- Schemas 1–5, baseline-only snapshots, schema-1–3 purge migration, hard-purge leading gaps, sequence high-water marks, and verifier/no-verifier downgrade behavior remain supported.
- The validator performs bounded work over surviving entries and baseline payloads; it does not expand journal gaps.

## Regression evidence

`test/eighth-review-baseline-regressions.test.js` covers expired and superseded signed facts, copied valid signatures, matching live facts, idempotency and relations, duplicate/midstream/rewind/wrong-epoch placement, atomic import/replace/restore, JSON/SQLite, CLI/HTTP/MCP, schema 1–5 baselines, baseline-only snapshots, monotonic migration extension, typed journal-less memory/decision/attempt/fact/relation/idempotency overwrite deltas, multiple-entity batches, sequence/postcondition preflight, terminal-fact resurrection rejection, repeated rebuild/restart, hard-purge leading gaps, and verifier downgrade rules.
