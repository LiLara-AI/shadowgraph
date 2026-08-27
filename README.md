# ShadowGraph v0.40.0 (unified memory review candidate)

ShadowGraph is a local-first, vendor-neutral learning layer for AI agents. It is not merely generic chat memory: its core remains an explainable decision graph that tracks what an agent chose, what it rejected, the assumptions and evidence behind it, what happened afterward, and when the decision should be reopened.

> ShadowGraph remembers not only what an agent chose, but what it rejected, why it rejected it, and what evidence should make it think again.

## What it does

When an AI agent starts an important task, ShadowGraph gives it relevant working context. During the task, the agent can save decisions, assumptions, evidence, rejected alternatives, failed attempts, observed facts, and scoped user/agent/run memory. After implementation, the agent records the outcome. ShadowGraph updates confidence, preserves superseded temporal history, and creates review signals when an old decision may no longer fit the current situation.

The normal learning loop is:

```text
1. Context: load active decisions, stale facts, failed attempts, and open reviews.
2. Decide: record the chosen approach, assumptions, evidence, and rejected alternatives.
3. Work: record failed or informative attempts and link related graph entities.
4. Observe: record project-scoped facts with `sourceClass` provenance claims. Agent/tool input cannot create `verified`.
5. Evaluate: record a successful, mixed, failed, or unknown outcome.
6. Reconsider: persist the fact, then call `review({ project })` or `context({ project })` after restart; do not pass the triggering fact again.
```

This lets an agent remember the reasoning behind work instead of blindly repeating old answers.

## v0.40.0 status

Version 0.40.0 is an unreleased review candidate. It preserves the v0.31 decision journal and adds scoped general memory, bi-temporal facts/relations, explainable lexical/vector/graph/temporal RRF retrieval, a localhost-first embedding adapter, and conflict-aware Markdown push/pull. JSON and SQLite restart parity, journal rebuild, canonical purge non-resurrection, CLI, HTTP, and MCP workflows are covered by the local suite. Confidence weights are still a declared policy rather than an empirically calibrated model; no tool input can create `verified` in this build.

## Unified memory kernel

- `remember()` stores `preference`, `profile`, `goal`, `instruction`, `procedure`, `episode`, or `note` memory under a non-empty project plus optional `userId`, `agentId`, and `runId` scope. Omitted recall project/scope means the `default` project plus all-null scope, never all projects or users.
- Reusing a scope/type/key with identical content is `NOOP`; changed content is `UPDATE`, with the previous version retained and journalled. Explicit plans may also `DELETE` by invalidating rather than silently erasing history.
- `recall()` unions lexical, optional vector, graph-distance, and temporal candidates, then applies weighted Reciprocal Rank Fusion. Results expose raw signal scores/ranks and state when a signal was unavailable; valid-time recall keeps a prior value visible until a future-effective replacement starts.
- Markdown is an inspectable projection and validated write surface. `markdown-sync` uses stable identity paths, hashes, atomic writes, and refuses two-sided conflicts. Exported plaintext copies must be deleted separately after a canonical purge.
- Embeddings are derived data, never canonical truth. No endpoint is configured by default; localhost works when explicitly configured, and remote endpoints require a separate privacy opt-in.

See [the unified-memory guide](docs/unified-memory.md) and [ADR-0006](docs/adr/0006-unified-memory-kernel.md).

## Requirements

- Node.js 20+ (SQLite backend requires Node 22.5+ with `node:sqlite`)
- v0.40.0 is an unreleased review candidate; schema 4 imports schemas 1-4
- No runtime npm dependencies
- Python 3.10+ only for the optional Hermes wrapper

## Install and run

```bash
npm install
npm run check
npm test
npm start
```

The API listens on `http://127.0.0.1:8787` and stores a versioned JSON graph in `.shadowgraph/data.json`. Set `SHADOWGRAPH_FILE` to choose another location. Set `SHADOWGRAPH_STORAGE=sqlite` on Node 22.5+ to use the WAL-backed relational SQLite adapter. JSON and SQLite restore use mandatory domain/journal consistency validation on direct JavaScript, HTTP, CLI, and MCP paths. SQLite `backup` creates an atomic snapshot; SQLite `restore` additionally retains standalone source/rollback snapshots of committed WAL state and confirms the replacement through open/prepare/load/validation before cleanup. Recovery inspects candidates read-only before a write-capable reopen. Caught failures are rolled back and reopened; cleanup and recovery failures report retained artifacts honestly. HTTP rejects writes and mutating context requests before graph change while restore owns persistence. This is process-level rollback safety, not crash or power-loss durability. JSON restore remains available only for JSON storage.

For a shared local deployment, enable optional authentication:

```bash
SHADOWGRAPH_API_TOKEN="use-a-random-token-at-least-16-characters" npm start
```

Then send this header with every HTTP request:

```text
Authorization: Bearer use-a-random-token-at-least-16-characters
```

## How the graph works

The graph contains:

- **Decision** — selected approach, goal, project, confidence, assumptions, alternatives, evidence, outcome.
- **Alternative** — rejected proposal, rejection reason, and structured reopen rules.
- **Fact** — observed value with `sourceClass` provenance claim, confidence, timestamp, project scope, and status. Current tool input cannot create `verified`; legacy verified values are preserved only for compatibility.
- **Evidence** — source, type, confidence, timestamp, and optional detail.
- **Attempt** — approach, result, environment, lesson/reason, and relationships.
- **Outcome** — successful, mixed, failed, or unknown result with lessons and confidence update.
- **Relationship** — explainable link such as `depends_on`, `supports`, `tested_by`, or `supersedes`.
- **Journal entry** — append-**oriented** record of a graph change, carrying a complete post-operation snapshot. Not append-only: an explicit hard purge deletes entries, which is why the term is "append-oriented with documented deletion semantics" (see `docs/handoffs/journal-contract.md`).

Confidence has an initial value, a current value, a history of evidence-weighted updates, and a `basis` that counts supporting and contradicting evidence by source class. `sourceClass` is one of exactly four values — `agent_claimed`, `tool_observed`, `human_confirmed`, `production_verified` — and it records **what was claimed** about an observation's origin, never proof of it. Unrecognised labels downgrade to `agent_claimed` with the original string preserved in `sourceRaw` for audit only. **Nothing reaches `verificationStatus: 'verified'` from tool input in this build**, and passing `verified` explicitly is rejected; see `docs/handoffs/provenance-contract.md`.

Example decision:

```js
import { createShadowGraph } from './src/shadowgraph.js';
const graph = createShadowGraph();
const decision = graph.addDecision({
  project: 'my-app',
  title: 'Choose a database',
  chosen: 'PostgreSQL',
  confidence: 0.8,
  evidence: [{ source: 'load-test', type: 'tool_observed', confidence: 0.9 }],
  alternatives: [{
    label: 'SQLite',
    reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'local' }]
  }]
});
graph.addFact({ project: 'my-app', key: 'deployment', value: 'local', sourceClass: 'human_confirmed', confidence: 1 });
// After exporting/saving and loading this graph in a new process, call without
// passing the triggering fact again. review() reads the project-scoped stored fact.
console.log(graph.review({ project: 'my-app' }));
```

## Interfaces

### CLI

```bash
node src/cli.js stats
node src/cli.js list
node src/cli.js search '{"query":"database","project":"my-app","status":"validated","minConfidence":0.7}'
node src/cli.js remember '{"project":"my-app","scope":{"userId":"alice"},"memoryType":"preference","key":"editor","text":"Prefers VS Code"}'
node src/cli.js recall '{"project":"my-app","scope":{"userId":"alice"},"query":"development environment"}'
node src/cli.js markdown-sync '{"directory":"./memory-notes","mode":"push"}'
node src/cli.js context '{"project":"my-app","facts":{"deployment":"local"}}'
node src/cli.js review '{"changedFacts":["local-single-user"]}'
node src/cli.js fact '{"key":"deployment","value":"local","source":"human_confirmed","confidence":1}'
node src/cli.js decision '{"project":"my-app","title":"Choose a database","chosen":"PostgreSQL"}'
node src/cli.js outcome '{"decisionId":"DECISION_ID","outcome":{"status":"failed","lessons":["Assumption was wrong"]}}'
node src/cli.js status '{"decisionId":"DECISION_ID","status":"validated"}'
node src/cli.js link '{"from":"DECISION_ID","to":"FACT_ID","relation":"depends_on"}'
node src/cli.js traverse '{"id":"DECISION_ID","depth":2,"direction":"out"}'
node src/cli.js supersede '{"decisionId":"OLD_ID","replacementId":"NEW_ID"}'
node src/cli.js redact '{"project":"my-app"}'
node src/cli.js purge '{"project":"my-app"}'
node src/cli.js attempt '{"solution":"Rewrite everything","result":"Regression"}'
```

### HTTP API

```text
GET  /health
GET  /stats
GET  /records
GET  /search?q=database&project=my-app
GET  /review-signals
POST /decisions
POST /attempts
POST /memories
POST /recall
POST /facts
POST /outcomes
POST /review
POST /context
POST /status
POST /relationships
POST /traverse
POST /redact
POST /supersede
POST /maintain
POST /review-signals/ack
POST /retrieve
GET  /validate
POST /repair-plan
POST /backup
POST /restore
POST /confidence-evidence
GET  /journal
POST /rebuild
POST /projects/purge-preview
DELETE /projects
```

`/redact` is read-only and returns a privacy-safe export. `/review` evaluates rules and persists deduplicated review signals; use `/review-signals` to read them and `/review-signals/ack` to acknowledge them. `/repair-plan` is always non-destructive and returns `{apply:false, actions:[...]}`. `/projects/purge-preview` shows deletion counts without changing storage. `DELETE /projects` performs a logical/tombstone purge by default: project content is removed from the live projection and the auditable purge skeleton remains. Use `{ "mode": "hard" }` only for explicit physical journal deletion; hard purge creates a declared journal gap and cannot be undone. The server returns `401` when token authentication is enabled and missing, `403` for disallowed browser origins, `404` for missing decisions or routes, and `413` for oversized request bodies.

### MCP

```bash
npm run mcp
```

For lower prompt overhead without losing stored fidelity, set `SHADOWGRAPH_MCP_COMPACT=1`. Compact mode advertises 12 workflow tools while the full relational graph, memories, facts, events, alternatives, and outcomes remain stored unchanged. Retrieval supports `limit`/`offset` only as explicit pagination and returns `{items,page:{total,hasMore}}`; no records are silently summarized or discarded.

To let MCP generate semantic vectors through a local OpenAI-compatible server (Ollama, llama.cpp, LM Studio, or equivalent), configure both values:

```bash
SHADOWGRAPH_EMBEDDING_URL="http://127.0.0.1:11434/v1" \
SHADOWGRAPH_EMBEDDING_MODEL="nomic-embed-text" \
npm run mcp
```

Remote URLs are rejected unless `SHADOWGRAPH_ALLOW_REMOTE_EMBEDDINGS=1` is also set. That opt-in means memory/query text leaves the machine. Without an embedder or caller-supplied vectors, recall remains lexical/graph/temporal and explicitly returns `semantic.available=false`.

MCP tools:

- `shadowgraph_record_decision` (supports `project`)
- `shadowgraph_record_attempt` (supports `project`)
- `shadowgraph_review`
- `shadowgraph_search`
- `shadowgraph_context`
- `shadowgraph_remember`
- `shadowgraph_recall`
- `shadowgraph_record_fact`
- `shadowgraph_record_outcome`
- `shadowgraph_update_status`
- `shadowgraph_link`
- `shadowgraph_traverse`
- `shadowgraph_supersede`
- `shadowgraph_redact`
- `shadowgraph_purge`
- `shadowgraph_maintain`
- `shadowgraph_retrieve`
- `shadowgraph_validate`
- `shadowgraph_review_signals`
- `shadowgraph_purge_preview`
- `shadowgraph_ack_review`
- `shadowgraph_repair_plan`
- `shadowgraph_backup`
- `shadowgraph_restore`

MCP exposes 27 tools by default (12 in compact mode) and also advertises a `shadowgraph://context` resource and a consequential-task prompt. Reading that context may generate review signals, so the MCP server serializes and persists it like a mutation. Search, retrieve, recall, context, and journal responses declare pagination and completeness; confidence evidence requires a stable caller-supplied `key`.

Recommended agent policy:

> Before a consequential task, call ShadowGraph context for the project. Search relevant decisions and failed attempts. Record decisions with assumptions, evidence, and rejected alternatives. Record outcomes after implementation. Treat every fact as a hypothesis unless `verificationStatus` is `verified` — and note that nothing reaches `verified` from tool input, so a strong `sourceClass` is a strong claim, not a warrant.

## AI tool setup

Copy-ready templates are in `integrations/` for Claude Code, Cursor, and Codex MCP configuration, plus HTTP/Python examples for Hermes Agent, OpenClaw, and Antigravity.

For MCP clients, replace `ABSOLUTE_PATH_TO_SHADOWGRAPH` in the relevant JSON file and register the command:

```text
node ABSOLUTE_PATH_TO_SHADOWGRAPH/src/mcp.js
```

The exact settings location varies by product and version. Use the product's MCP import/settings UI when available. ShadowGraph communicates through standard local MCP stdio or HTTP; it does not depend on a vendor-private API.

## Migration and storage

The JSON store accepts both the v0.1 array format and later graph envelopes. Current exports use schema 4:

```json
{
  "schemaVersion": 4,
  "records": [],
  "facts": [],
  "relations": [],
  "events": [],
  "journal": []
}
```

Schemas 1, 2, and 3 remain importable. An unsupported future envelope schema is rejected before replacing live state; individual future entities are preserved and reported by validation. JSON is the zero-dependency portable default. v0.40.0 stores a monotonic revision and can reject stale `expectedRevision` saves to prevent lost updates; callers should reload and retry after a revision conflict. SQLite is selectable through `SHADOWGRAPH_STORAGE=sqlite` on Node 22.5+ and uses normalized relational tables with WAL, a busy timeout, transactional replacement, legacy envelope migration, and revision checks. Do not assume revision checks replace application-level conflict handling when multiple processes mutate stale in-memory graphs.

## Security and privacy

The HTTP server binds to `127.0.0.1` by default and rejects non-local browser origins. Set `SHADOWGRAPH_API_TOKEN` for Bearer authentication in shared local deployments. This is defense in depth, not a public internet security model. Do not expose the API publicly without TLS, rate limiting, and a deployment threat model. Do not store secrets or sensitive transcripts unless your local storage policy permits it. See `SECURITY.md`.

## Checks

```bash
npm run check
npm test
npm audit --omit=dev
python -m py_compile integrations/hermes-agent.py
npm pack --dry-run
```

GitHub Actions runs the checks on Ubuntu and Windows with Node 20 and 22.

## License

MIT. See `LICENSE`.
