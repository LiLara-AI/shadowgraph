# ADR-0006 — Unified Memory Kernel: decision depth plus general, temporal, searchable memory

- **Status:** `accepted` (2026-08-27)
- **Scope:** additive redesign for the next ShadowGraph schema; preserve all v0.31 decision, journal, restore, pagination, provenance, and purge guarantees.
- **Implementation rule:** independently implement public product ideas; do not copy competitor source. This matters especially for Basic Memory, whose repository is AGPL-3.0 while ShadowGraph is MIT.[2]

## Context

ShadowGraph already has the deeper domain model: decisions, rejected alternatives, reasons, evidence, outcomes, failed attempts, provenance, and deterministic `reopenWhen` reconsideration. Its gaps are the everyday memory experience around that model.

The official MCP Memory server demonstrates the value of a very small mental model: entities, directed relations, atomic observations, and nine direct tools.[1]

Basic Memory demonstrates a human-readable Markdown surface, two-way file workflows, local semantic indexing, optional per-project sync, and hybrid search.[2][3][4]

Mem0's current V3 product demonstrates user/agent/run scoping, additive fact extraction, scoped retrieval, exact deduplication, and explicit update/delete/history operations.[9][10]

Older Mem0 documentation and the 2025 paper describe an automatic `ADD`/`UPDATE`/`DELETE`/`NOOP` reconciliation pipeline; ShadowGraph does **not** attribute that older behavior to current V3 and instead adopts an explicit, auditable operation plan as its own design.[5][6]

Graphiti demonstrates bi-temporal facts, episodes as provenance, invalidation rather than deletion, and hybrid semantic + BM25 + graph retrieval fused/reranked without making summaries canonical.[7][8]

Mem0 has published an evaluation and reports strong latency/token and recall results, but those are evidence about Mem0's evaluated configuration—not evidence that ShadowGraph has achieved parity.[6] ShadowGraph will benchmark its own behavior against a no-memory baseline and will not inherit vendor claims.

## Decision

Build one **Unified Memory Kernel** around the existing canonical decision journal:

```text
Canonical structured journal and entities
  ├─ Decision projection (existing differentiator)
  ├─ Scoped memory projection (user / agent / session / project)
  ├─ Temporal projection (valid-time + recorded-time history)
  ├─ Markdown workspace projection/import surface
  └─ Hybrid retrieval index (lexical + vector + graph + temporal)
```

### 1. One additive scoped-memory envelope

Add a `memory` entity, without flattening decisions into generic notes:

```json
{
  "id": "memory_...",
  "kind": "memory",
  "memoryType": "preference|profile|goal|instruction|procedure|episode|note",
  "project": "default",
  "scope": {"userId": null, "agentId": null, "runId": null},
  "key": "stable-caller-key",
  "text": "full memory text",
  "metadata": {},
  "tags": [],
  "temporal": {
    "validFrom": null,
    "validTo": null,
    "recordedAt": "...",
    "invalidatedAt": null
  },
  "embedding": null,
  "sourceClass": "agent_claimed"
}
```

A write is reconciled by `(project, scope, memoryType, key)`:

- same content → deterministic no-op/deduplication;
- changed content → previous memory is superseded and retained; a new memory is appended;
- explicit remove from an extraction plan → invalidate/tombstone, never silently erase history;
- every result reports the operation (`ADD`, `UPDATE`, `DELETE`, `NOOP`) and affected IDs.

### 2. LLM extraction is a replaceable edge, not trusted core logic

The kernel accepts and validates a memory operation plan. An optional extractor may produce that plan from messages, but the core never treats LLM output as verified truth and never lets an extractor bypass provenance, scope, idempotency, or purge rules. No hosted LLM is a default dependency.

### 3. Bi-temporal truth without replacing decision semantics

Facts, relations, and general memories carry:

- **valid time:** when the claim is/was true (`validFrom`, `validTo`);
- **record time:** when ShadowGraph learned or invalidated it (`recordedAt`, `invalidatedAt`).

Supersession closes the old validity interval and keeps the prior payload. `asOf` retrieval filters by valid time; journal/timeline reads retain record time. Decisions continue to use lifecycle plus falsification conditions because a decision is not merely a temporal fact.

### 4. Honest hybrid retrieval

Add a separate retrieval module that ranks candidates through independently inspectable signals:

1. BM25-style lexical rank;
2. cosine vector rank when stored/query embeddings are available;
3. graph-distance rank from an optional focal entity;
4. temporal/currentness rank when requested;
5. Reciprocal Rank Fusion (RRF) over available lists.

Every hit returns per-signal ranks/scores and the response declares which signals were available. If no embedder is configured, ShadowGraph says `semantic.available=false`; it must not rename lexical search as semantic search. Embeddings are derived indexes, never source-of-truth data.

The built-in adapter targets an explicitly configured OpenAI-compatible endpoint. Localhost is allowed by default; sending memory to a remote endpoint requires a separate opt-in.

### 5. Markdown workspace as an inspectable projection and controlled write surface

Provide deterministic Markdown export/import for scoped memories:

- YAML-compatible frontmatter for stable identity, scope, type, tags, and temporal fields;
- the body is the memory text;
- atomic writes;
- content hashes and explicit conflict outcomes;
- explicit push and pull modes with dry-run;
- no watcher or cloud process is required for correctness.

The canonical journal remains authoritative. A human Markdown edit becomes a normal validated memory operation with provenance and history; it never mutates database rows behind the journal. The files are suitable for Git, Syncthing, rclone, Obsidian, or an optional future sync transport.

### 6. Product surface

Keep all existing tools. Add two high-level workflow tools:

- `shadowgraph_remember` — add/reconcile scoped memories or apply an extraction plan;
- `shadowgraph_recall` — hybrid scoped/temporal retrieval with complete pagination and explanations.

Expose explicit Markdown push/pull through CLI after the core behavior is proven. Bidirectional one-command and HTTP file sync are deferred below because their cross-file/canonical commit boundary needs a separate transaction contract. MCP schemas must mark destructive/idempotent/read-only behavior only when the negotiated protocol supports those annotations.

**Amendment, 2026-09-03.** An earlier amendment read this sentence as permitting *declared-capability
gating*, where the revision a client asked for selected the optional members it received. That was
wrong: a requested revision is a client's preference, not an agreed contract, and it let an
unimplemented value such as `2099-01-01` unlock members no peer had agreed on. The sentence above is
now satisfied literally. `initialize` genuinely negotiates one of `2024-11-05`, `2025-03-26`,
`2025-06-18`, or `2025-11-25` — echoing the requested revision when this server implements it and
otherwise answering `2025-11-25`, the latest it implements — and optional tool members follow that
**negotiated** revision: `annotations` from `2025-03-26`, `outputSchema` and `structuredContent` from
`2025-06-18`, and both for modern `2026-07-28` `_meta` requests. A session negotiated at `2024-11-05`
keeps the top-level member set of every tool object, the tool names and counts, and the serialized
text result; descriptions and input-schema descriptions were improved for every revision, which
changes how the tools are described rather than what they accept or return. See
[MCP compatibility §4](../mcp-compatibility.md).

## Rejected alternatives

| Alternative | Decision | Reason |
| --- | --- | --- |
| Replace decisions with generic entities/observations | `rejected` | Loses ShadowGraph's differentiation and audit depth. |
| Make Markdown and the database simultaneous silent sources of truth | `rejected` | Creates split-brain/conflict ambiguity. Markdown edits must enter through validated operations. |
| Default to a hosted embedding or extraction API | `rejected` | Violates local-first privacy and makes ordinary reads network-dependent. |
| Call keyword overlap “semantic search” | `rejected` | Misleading; semantic availability must be declared and tested. |
| Copy Basic Memory implementation | `rejected` | License mismatch and unnecessary; only public behavior and design ideas are used.[2] |
| Delete superseded user memories | `rejected` | Breaks temporal history, provenance, and reconsideration. |
| Full event sourcing/CQRS rewrite | `rejected` | Existing ADR-0001 remains accepted; the audit-critical append-oriented journal is sufficient. |

## Migration and compatibility

1. Bump the data schema only when the first `memory` entity is implemented.
2. Continue importing schemas 1–3 unchanged.
3. Store new memory entities in the existing `records` collection and relational entity table; no second canonical database.
4. Extend journal replay with `memory.recorded`, `memory.indexed`, `memory.superseded`, and `memory.invalidated`.
5. Keep current search/retrieve contracts; add `recall()` rather than silently changing the old ranker.
6. Add fixture-based JSON/SQLite restart, rebuild, restore, purge, and project/scope isolation tests.
7. Do not remove a compatibility tool until persisted-state and warm-task evidence exists.

## Acceptance gates

- scoped `ADD/UPDATE/DELETE/NOOP` behavior is deterministic and journalled;
- no cross-user, cross-run, or cross-project leakage;
- old value remains retained in history; current recall keeps it until a future-effective replacement starts, and `asOf` returns it for every non-empty validity interval (an equal-boundary correction is history-only);
- lexical/vector/graph/temporal ranks are independently explainable;
- semantic mode proves a meaning-match with a test embedder and declares unavailable when no embedder exists;
- Markdown push/pull round-trips Unicode and rejects conflicts without data loss;
- journal rebuild equals the live projection for memories;
- JSON and SQLite persist and reload identical memory state;
- schema-4 records, facts, relations, and alternatives share one collision-free ID namespace; current link writes require existing endpoints;
- CLI/HTTP/MCP context reads persist any review signals they create, and ordinary HTTP/MCP save failures cannot leave unpersisted mutations live;
- purge removes memory payloads from live state, idempotency, and the requested journal scope according to logical/hard semantics; stale Markdown sync state cannot resurrect the purged memory;
- full existing tests, syntax checks, package checks, audit, and diff checks pass.

## Deferred with explicit boundaries

| Item | Status | Reason | Impact | Workaround / proof it does not collapse | Next action |
| --- | --- | --- | --- | --- | --- |
| Automatic background file watcher | `deferred` | Adds lifecycle, shutdown, and race complexity | edits require an explicit command | `markdown-sync` push/pull is deterministic; conflict and rollback regressions prove explicit sync fails closed | add only with watcher shutdown/race tests |
| Bidirectional one-command + HTTP Markdown sync | `deferred` | Cross-file/canonical commit ordering needs a transport-level transaction contract | users run pull then push; HTTP clients cannot sync files directly | CLI pull is batch-rollback safe and persists canonical state before sync state; tests cover both failure paths | separate interface ADR, then HTTP auth/path tests |
| Automatic Markdown erasure during project purge | `deferred` | the kernel does not know every exported, Git, cloud, or removable-media copy | exported plaintext remains readable until its owner deletes it | stale tracked files are refused with `canonical_memory_missing` and cannot resurrect canonical data; docs warn that purge cannot retract external copies | design a registered-workspace prune command and erasure report |
| First-party hosted cloud sync | `deferred` | Outside local-first default and requires auth/threat model | no first-party cloud account synchronization | user-managed Git/Syncthing/rclone works on the Markdown projection; canonical journal stays local | separate ADR and security review |
| Default LLM extractor | `deferred` | No trusted/local provider can be assumed | caller supplies memory or operation plan | complete plan preflight + rollback tests prevent malformed plans from partially committing | add a pluggable provider after extraction evaluation fixtures |
| Competitor-parity/SOTA claim | `rejected` | External benchmark claims do not transfer | no parity/performance marketing claim | report only executed ShadowGraph measurements | run the accepted warm-task benchmark before any claim |

## Sources

[1] https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/memory/README.md — MCP Knowledge Graph Memory Server README
[2] https://github.com/basicmachines-co/basic-memory — Basic Memory repository
[3] https://docs.basicmemory.com/raw/concepts/semantic-search.md — Basic Memory semantic search
[4] https://docs.basicmemory.com/raw/cloud/cloud-sync.md — Basic Memory cloud sync
[5] https://docs.mem0.ai/core-concepts/memory-types — Mem0 memory types and update pipeline
[6] https://arxiv.org/pdf/2504.19413 — Mem0 paper
[7] https://help.getzep.com/graphiti/getting-started/overview — Graphiti overview
[8] https://help.getzep.com/graphiti/working-with-data/searching — Graphiti search
[9] https://docs.mem0.ai/core-concepts/how-it-works — Mem0 current architecture
[10] https://docs.mem0.ai/api-reference/memory/add-memories — Mem0 V3 add API
