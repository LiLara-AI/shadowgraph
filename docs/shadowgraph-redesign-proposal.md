# ShadowGraph — Redesign Proposal (Start Here, Do Not Implement Blindly)

> **Proposal/history document — not the current implementation contract.** Implemented v0.31 behavior is defined by `README.md`, `docs/api-reference.md`, and the contracts under `docs/handoffs/`. Diagrams and candidate event names below remain proposals unless those current documents say otherwise.

## Design decision

Do not blindly preserve the current internals, and do not delete working capabilities merely to copy another product's token strategy. Preserve the product identity and user-visible compatibility while introducing a stronger canonical model behind it. Remove old internals only after migration, benchmark, and rollback evidence.

## Target architecture

```text
Canonical Decision/Event Ledger
        ↓ rebuildable projections
Current context | timelines | reviews | failed attempts | confidence views
        ↓ explicit retrieval contracts
Full MCP compatibility | compact workflow MCP | HTTP | CLI | adapters
```

## Canonical ledger

Every meaningful mutation becomes an immutable, append-oriented event with:

- eventId, type, entityId, project, actor, client, sessionId, timestamp;
- source/provenance;
- payload containing the full fact/decision/attempt/outcome data;
- causation and derivation links;
- schema version.

Candidate event types:

```text
decision.created
alternative.rejected
fact.observed
fact.superseded
attempt.recorded
attempt.failed
outcome.recorded
confidence.changed
decision.planned
decision.started
decision.executed
decision.validated
decision.reconsidered
decision.superseded
decision.abandoned
review.opened
review.acknowledged
relation.created
```

The ledger is not a lossy transcript. It is structured, validated data. Projections can be rebuilt from it.

## Decision lifecycle

Replace ambiguous combinations such as active + null outcome with explicit state and execution metadata:

```text
proposed → planned → in_progress → executed → validated
                         ↓             ↓
                      abandoned       failed → reconsidered
```

A decision can also become superseded. Keep backward-compatible `status`/`outcome` aliases during migration.

Suggested execution object:

```json
{
  "state": "not_started",
  "reason": "waiting for production evidence",
  "plannedAt": null,
  "startedAt": null,
  "completedAt": null
}
```

## Provenance model

Do not mix model inference with observed truth:

```json
{
  "sourceClass": "tool_observed",
  "actor": "claude",
  "client": "claude-cli",
  "sessionId": "...",
  "observedAt": "...",
  "confidence": 0.8,
  "derivation": ["event-id"]
}
```

Normalize source aliases, but preserve the original source label for audit.

## Reconsideration API

Add a first-class operation that evaluates a decision against changed facts:

```json
{
  "project": "project-a",
  "decisionId": "decision-123",
  "changedFacts": [{
    "key": "deployment",
    "oldValue": "single-user",
    "newValue": "multi-user",
    "sourceClass": "human_confirmed"
  }]
}
```

Return:

- full decision;
- triggered reopen conditions;
- contradicting facts;
- supporting evidence;
- affected alternatives;
- confidence impact with basis;
- recommendation: keep, reopen, supersede, or manual_review;
- event IDs and reasons explaining every conclusion.

## Retrieval contract

Never make a summary the canonical record. Offer explicit views:

- `context`: complete current decision/fact/attempt items needed for a project, with provenance.
- `decision`: one complete decision including alternatives, reasons, assumptions, evidence, lifecycle, outcomes, and confidence history.
- `timeline`: complete ordered events for a project/entity.
- `reconsideration`: complete analysis plus all cited evidence.

For bounded responses:

```json
{
  "items": [],
  "page": {"offset": 0, "limit": 20, "total": 101, "hasMore": true},
  "completeness": {"scope": "project-a", "losslessItems": true}
}
```

No omitted facts without an explicit page or a caller-requested scope.

## MCP strategy

Keep current full MCP tools for compatibility. Build a workflow surface separately, ideally:

```text
shadowgraph_context
shadowgraph_record
shadowgraph_retrieve
shadowgraph_reconsider
shadowgraph_validate
shadowgraph_maintain
```

The compact surface should have schemas that express workflows, not expose every internal operation. It must still be able to record every canonical event and request expansion. Measure schema/tool-turn savings after implementation; do not assume them.

## Confidence redesign

Store a value plus basis:

```json
{
  "value": 0.62,
  "basis": {
    "supportingEvidence": 2,
    "contradictingEvidence": 1,
    "successfulOutcomes": 1,
    "failedOutcomes": 0,
    "humanConfirmations": 0,
    "productionVerifications": 0
  },
  "history": [],
  "policy": "conservative"
}
```

Do not choose a new formula until real outcomes and calibration tests exist.

## Benchmark before removing anything

For each of ten matched scenarios, run:

1. Fresh decision.
2. Restart recall.
3. Same task repeated.
4. Changed-fact reconsideration.
5. Failed-attempt avoidance.

Compare baseline, current ShadowGraph, and redesigned ShadowGraph on:

- input/output tokens and cost;
- tool calls and latency;
- decision rubric score;
- decision consistency;
- recall of alternatives/reasons/facts;
- contradiction detection;
- repeated failure rate;
- confidence calibration;
- total lifecycle economics.

A first-run token increase can be acceptable only if warm-task total cost or decision quality demonstrates value.

## Migration plan

1. Freeze and document current export schema.
2. Introduce event schema and dual-write behind a feature flag.
3. Compare projection output with current graph output on fixtures.
4. Add rebuild-from-ledger and interruption tests.
5. Add reconsideration API and same-project changed-fact tests.
6. Add compact workflow MCP and compatibility tests.
7. Run clean-install warm benchmark.
8. Migrate existing data transactionally with backup.
9. Keep legacy read aliases for at least one release.
10. Remove old internals only after rollback evidence.

## Non-goals

- Copying Mem0, Graphiti, or Letta.
- Lossy summaries.
- Embeddings as the only source of truth.
- Automatic fabricated history.
- Cloud dependency.
