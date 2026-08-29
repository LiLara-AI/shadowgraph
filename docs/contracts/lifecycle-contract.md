# ShadowGraph — Decision Lifecycle Contract (schema 5)

**Status:** accepted and implemented (2026-08-27).
**Applies to:** `addDecision()`, `updateDecisionStatus()`, `supersedeDecision()`, `maintain()`, import/migration, validation, journal rebuild, and JS/CLI/HTTP/MCP surfaces.

## 1. Canonical schema-5 states

Schema 5 stores one explicit disposition state machine:

```text
proposed · planned · in_progress · executed · validated
failed · reconsidered · superseded · abandoned · stale · archived
```

- `proposed` is the default entry state.
- `stale` is system-owned. `maintain()` produces it after `reviewAfter` is due for a current decision.
- `superseded` is system-owned. Only `supersedeDecision()` produces it.
- `archived` is an explicit terminal disposition. It is distinct from the execution outcome `abandoned`.
- `context().activeDecisions` means current/actionable decisions, not the literal old status `active`; it includes `proposed`, `planned`, `in_progress`, `executed`, `validated`, and `reconsidered`.

Fact, memory, review-signal, alternative, and outcome statuses are separate vocabularies and are unchanged by this contract.

## 2. Legal transitions

`updateDecisionStatus()` accepts formatting aliases (case and hyphen/underscore) but never semantic aliases. The legal graph is exported as `DECISION_TRANSITIONS`:

| From | Legal caller transitions |
| --- | --- |
| `proposed` | `planned`, `in_progress`, `abandoned`, `archived` |
| `planned` | `in_progress`, `abandoned`, `archived` |
| `in_progress` | `executed`, `failed`, `abandoned`, `archived` |
| `executed` | `validated`, `failed`, `reconsidered`, `archived` |
| `validated` | `reconsidered`, `archived` |
| `failed` | `reconsidered`, `abandoned`, `archived` |
| `reconsidered` | `planned`, `in_progress`, `abandoned`, `archived` |
| `stale` | `reconsidered`, `archived` |
| `abandoned` | `archived` |
| `superseded` | none |
| `archived` | none |

A same-state update is an idempotent no-op except callers still cannot claim a system-owned state. Illegal transitions throw `Illegal decision status transition: <from> -> <to>`.

## 3. Atomic rejection

Status normalization, system ownership, and the transition graph are checked before changing the decision. A rejected update changes none of:

- the live decision;
- compatibility events;
- journal entries or sequence high-water marks;
- JSON/SQLite durable state.

The same rule is exercised through JavaScript, CLI, HTTP, and MCP. HTTP and MCP persistence rollback remain a second safety boundary for storage failures; they are not needed to undo a domain transition rejection because no domain mutation occurred.

## 4. `stale` and `archived`

`maintain({now})` changes a due current decision to `stale`, records the prior and next state in the journal transition metadata, returns its ID in `staleDecisionIds`, and retains `agedDecisionIds` as a response alias for older callers. Stale decisions are excluded from current context but can generate/open reconsideration signals. A caller cannot directly set `stale`.

`archived` is caller-selected and terminal. Archived decisions remain searchable/auditable but are excluded from current context and automatic review. Archiving does not mean execution failed or was abandoned.

## 5. Schema-4 migration

Schema 4 had overlapping execution/validity values. Schema 5 performs the least-breaking explicit migration:

| Schema-4 stored value | Schema-5 value | Marker |
| --- | --- | --- |
| `active` | `proposed` | `migration.legacyDecisionStatus = 'active'` |
| `aging` | `stale` | `migration.legacyDecisionStatus = 'aging'` |
| `stale` | `stale` | unchanged |
| `archived` | `archived` | unchanged |

Migration is staged before merge/replacement. Schema-4 global entity-ID uniqueness, non-empty project/ID rules, final-state relation integrity, idempotency identity, and journal invariants remain enforced. A failed import/restore leaves records, indexes, revision, events, and journal untouched.

Schemas 1–3 retain their existing legacy collision migration. Unknown stored statuses are preserved for diagnosis and reported by `validate()`; they are never silently mapped onto a known meaning.

## 6. Persistence and rebuild

Current exports and new journal entries use schema version 5. JSON empty state, SQLite metadata defaults, restore validation, and journal projections use the same current version. Schema-4 snapshots migrate identically through JSON and SQLite and remain equivalent after restart and journal rebuild.

## 7. Regression evidence

- core lifecycle acceptance and migration: `test/gap-regressions.test.js`;
- JS/CLI/HTTP/MCP atomic interface rejection: `test/lifecycle-interfaces.test.js`;
- schema-4 → schema-5 JSON/SQLite parity: `test/memory-persistence.test.js`;
- relation/ID/import invariants retained from schema 4: `test/unified-memory.test.js`;
- dual-era MCP schemas and error semantics: `test/mcp-dual-era.test.js`.
