# ShadowGraph Unified Memory Kernel

**Version:** 0.40.0 review candidate · **Data schema:** 4

This guide documents implemented behavior. Research and architecture rationale live in [ADR-0006](adr/0006-unified-memory-kernel.md).

## Design boundary

ShadowGraph now supports general scoped memory, but decisions remain a richer, separate domain object. Do not store a consequential choice as a plain preference/note when alternatives, rejection reasons, assumptions, evidence, outcomes, or reconsideration conditions matter.

The canonical source remains the structured graph plus append-oriented journal. Embeddings and Markdown files are rebuildable/inspectable projections; they are never allowed to silently replace canonical history.

## Memory envelope

```json
{
  "kind": "memory",
  "project": "travel",
  "scope": {
    "userId": "alice",
    "agentId": "planner",
    "runId": null
  },
  "memoryType": "preference",
  "key": "hotel-style",
  "text": "Prefers quiet boutique hotels",
  "tags": ["travel"],
  "metadata": {"priority": 2},
  "temporal": {
    "validFrom": "2026-09-01T00:00:00.000Z",
    "validTo": null,
    "recordedAt": "2026-09-02T00:00:00.000Z",
    "invalidatedAt": null
  },
  "embedding": null,
  "sourceClass": "agent_claimed",
  "verificationStatus": "unverified"
}
```

### Types

- `preference` — user or agent preference
- `profile` — durable profile fact
- `goal` — desired future state
- `instruction` — operating preference or constraint
- `procedure` — reusable steps
- `episode` — an event/source unit worth recalling
- `note` — general durable knowledge

### Scope identity

A memory identity is the exact tuple:

```text
(project, userId, agentId, runId, memoryType, key)
```

This exactness prevents a run-specific memory from leaking into a broader user-only read. A supplied project must be a non-empty string on every write and filtered read path. Scope must be an object containing only string/null `userId`, `agentId`, and `runId`; unknown keys and malformed selectors are rejected rather than collapsed to all-null. For memory records, omitted project/scope means the `default` project and explicit all-null scope across recall, search, retrieval, and graph traversal; it never means “all projects/users.” Shared decisions/facts retain their documented project-query behavior, while another project/user's scoped memory never rides along.

## Reconciliation

```js
const result = graph.remember({
  project: 'travel',
  scope: { userId: 'alice' },
  memoryType: 'preference',
  key: 'hotel-style',
  text: 'Prefers quiet boutique hotels'
});
```

Result operations:

- `ADD` — no active memory existed at that identity;
- `NOOP` — active content was identical;
- `UPDATE` — previous memory was superseded and retained, then a new version was written;
- `DELETE` — explicit operation-plan invalidation; payload remains historical until an explicit project purge.

If identical content arrives with a different explicit embedding, the result remains `NOOP` with `indexUpdated: true`: the derived index is refreshed and journalled as `memory.indexed` without inventing a new semantic memory version. Re-adding an invalidated identity continues its prior version number.

For extraction or batch workflows, submit an explicit plan:

```js
graph.applyMemoryPlan({
  project: 'travel',
  scope: { userId: 'alice' },
  operations: [
    { action: 'ADD', memoryType: 'goal', key: 'trip', text: 'Visit Tokyo' },
    { action: 'DELETE', memoryType: 'preference', key: 'old-airline' }
  ]
});
```

The complete plan is validated before the first mutation. This includes retry keys, caller-owned entity IDs, temporal ordering, embeddings, metadata, scope, and provenance strings. Extractor output cannot set verification, bypass provenance, or turn an invalid operation into a partial successful batch.

## Point-in-time history

Memories, facts, and new relations carry both:

- **valid time** — when the assertion was true in the modeled world;
- **record time** — when ShadowGraph learned or invalidated it.

A superseding write closes the previous `[validFrom, validTo)` interval without extending an interval that had already ended. Temporal fields must parse as real timestamps and are compared by instant, so equivalent timezone-offset forms cannot reorder visibility. Current and historical recall select by a validated instant, not merely the projection status: a prior value remains current until a future-effective replacement's `validFrom`, while `asOf` selects historical time. Deleting a future-effective memory closes it at `validFrom`, producing a safe zero-length interval rather than an inverted interval. Direct memory writes for one identity and direct fact writes for one `(project, key)` must arrive in non-decreasing `validFrom` order; an out-of-order backfill is rejected before mutation rather than corrupting intervals. Equal boundaries represent an instantaneous correction: the old payload remains in `memoryHistory()`/the journal but has no valid-time instant:

```js
graph.recall('deployment mode', {
  project: 'app',
  asOf: '2026-08-15T00:00:00.000Z'
});
```

`memoryHistory()` returns all versions in deterministic version order.

## Hybrid recall

`recall()` builds independent candidate rankings:

1. BM25-style lexical rank over declared human content;
2. cosine vector rank when query/stored model identity and dimensions match;
3. graph-distance rank when `focalId` is provided;
4. temporal recency rank when `asOf` or `preferRecent` is supplied.

It unions candidates before fusion, then applies weighted Reciprocal Rank Fusion. A semantic threshold cannot hide a keyword or graph candidate. Every hit includes:

```json
{
  "score": 0.04,
  "ranks": {"lexical": 2, "semantic": 1, "graph": 1, "temporal": null},
  "scores": {"lexical": 1.21, "semantic": 0.97, "graph": 1, "temporal": null},
  "reasons": ["lexical rank 2", "semantic rank 1", "graph rank 1"]
}
```

The response-level `signals` object is authoritative. If no valid query vector/provider exists, it returns `semantic.available=false` with a reason. ShadowGraph does not call lexical overlap “semantic.”

## Embeddings

The JavaScript API accepts `embedding` on `remember()` and `queryEmbedding` on `recall()`.

MCP can generate them automatically through an OpenAI-compatible endpoint:

```bash
SHADOWGRAPH_EMBEDDING_URL="http://127.0.0.1:11434/v1" \
SHADOWGRAPH_EMBEDDING_MODEL="nomic-embed-text" \
node src/mcp.js
```

Security rules:

- localhost is accepted by default;
- a remote host requires `SHADOWGRAPH_ALLOW_REMOTE_EMBEDDINGS=1`;
- API keys are read from `SHADOWGRAPH_EMBEDDING_API_KEY` and are not persisted;
- embedding responses must contain a finite, non-empty numeric vector and cannot declare a model different from the requested one;
- model-tagged vectors rank only against the same model tag; dimension equality alone is insufficient;
- an MCP query-provider failure returns lexical/graph/temporal results with `semantic.available=false` rather than aborting recall;
- embeddings are stored as derived metadata and never grant verification.

## Markdown workspace

Push canonical active memories to readable files:

```bash
node src/cli.js markdown-sync '{"directory":"./memory-notes","mode":"push"}'
```

Pull human edits through normal validation/journalling:

```bash
node src/cli.js markdown-sync '{"directory":"./memory-notes","mode":"pull"}'
```

Files use JSON-compatible YAML frontmatter and a Markdown body. Paths derive from stable memory identity rather than version ID, so updating a memory updates one file instead of creating a version-file pile.

Safety behavior:

- file and sync-state writes are atomic temp-write + rename;
- content and memory hashes detect drift;
- an untracked existing path is not overwritten;
- if file and graph both changed, the operation reports `both_file_and_memory_changed` and mutates neither side;
- frontmatter ID/scope/type/key identity changes and status edits are refused instead of silently cloning or desynchronizing a memory;
- a tracked file whose canonical memory was purged reports `canonical_memory_missing` and cannot resurrect it;
- any parse, identity, two-sided, canonical-missing, or status conflict rolls back otherwise valid edits in that pull batch and returns `rolledBack: true`; a thrown domain/pre-persistence failure also restores the original graph;
- callers such as the CLI can provide paired `persist` and `loadPersisted` callbacks; sync state advances only after persistence succeeds, a thrown post-commit acknowledgment is reconciled by durable read-back, and a later state-file failure never rolls live memory behind the already durable snapshot;
- `dryRun: true` reports work without writing state/files or changing the graph;
- sync is additive; it does not mirror-delete files.

Markdown `pull` writes `sourceClass: tool_observed` and `client: markdown-sync`. Those are provenance claims, not verification.

## Interfaces

### JavaScript

- `remember(input)`
- `applyMemoryPlan(input)`
- `memoryHistory(input)`
- `recall(query, options)`
- `createEmbeddingClient(options)`
- `renderMemoryMarkdown(memory)` / `parseMemoryMarkdown(text)`
- `syncMarkdownWorkspace(options)`

### CLI

- `remember <JSON>`
- `recall <JSON>`
- `markdown-sync <JSON>`

### HTTP

- `POST /memories`
- `POST /recall`

HTTP accepts caller-supplied vectors but does not make network calls to an embedding provider.

CLI, HTTP, MCP tools, and the MCP context resource persist review signals created by `context()`. HTTP and MCP mutators reload the last readable durable snapshot after an ordinary save failure (or restore the pre-mutation snapshot when storage is unreadable), so an unpersisted mutation cannot remain live and be committed by a later request.

### MCP

- `shadowgraph_remember`
- `shadowgraph_recall`

Compact mode includes both workflows. The server still negotiates MCP `2024-11-05`, so it deliberately omits newer tool-annotation fields instead of advertising a protocol feature it does not implement.

## Persistence and purge

Schema 4 stores memories in the existing `records` collection and SQLite entity table. There is no second canonical database. Records, facts, relations, and nested alternative IDs share one global non-empty entity-ID namespace to match SQLite, including merge imports against existing live state. Legacy collection-local collisions receive deterministic migrated IDs and dependent journal/idempotency references are remapped with them. Legacy idempotency keys are checked again after canonicalization, and review identities use tuple encoding so delimiters inside IDs/reasons cannot collide. Schema-4 merge validates relations against the final replacement state, including alternatives removed by an overwrite. Restore validates review/idempotency semantic identities plus journal type/entity/project/sequence consistency; direct replay uses the same journal type/entity map. Direct runtime writes prove caller-controlled content is lossless plain JSON before changing canonical state; large journal imports avoid argument-spread limits. Journal replay understands `memory.recorded`, `memory.indexed`, `memory.superseded`, and `memory.invalidated`.

Logical and hard project purge cover memory records, current-memory indexes, idempotency payloads, relations, and journal semantics. A purged memory cannot be returned by an old idempotency key or resurrected by journal rebuild. Hard purge records the exact removed journal sequence numbers; later hard/logical purges preserve that ledger transitively, and restore validates gap coverage with bounded range arithmetic instead of expanding every absent sequence.

> **External-copy boundary:** Markdown files are plaintext exports. Core purge cannot discover or retract copies in arbitrary workspaces, Git history, cloud sync, backups, or removable media. Delete those copies separately. A tracked stale file is fail-closed and cannot re-enter canonical state, but it remains readable on disk until its owner removes it.

## Proven and not measured

### Proven by automated tests

- scoped add/dedup/update/delete/no-op behavior;
- preflight rejection without partial plan writes;
- cross-user scope isolation;
- scope-isolated idempotency and schema-4 global entity-ID collision refusal, including nested alternatives;
- point-in-time memory/fact/relation recall, including future-effective replacement handoff;
- lexical/vector/graph/temporal ranking explanations;
- semantic-unavailable declaration;
- localhost/remote embedding privacy boundary;
- Unicode Markdown push/pull and conflict refusal;
- logical purge non-resurrection;
- JSON/SQLite restart parity, journal rebuild, and journal-bearing schema-3 restore migration;
- CLI, HTTP, full MCP, and compact MCP workflows, context-signal persistence, and ordinary-save rollback.

### Not measured

- retrieval quality on a real semantic embedding model;
- extraction quality (there is no default extractor);
- token, latency, cost, or answer-quality improvement;
- background watcher race behavior (no watcher is shipped);
- cloud synchronization (not shipped);
- competitor parity or SOTA performance;
- confidence calibration or a trusted verification channel.
