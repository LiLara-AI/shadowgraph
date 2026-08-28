# ShadowGraph v0.40.0 (pre-Beta release candidate)

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

## v0.40.0 pre-Beta status

Version 0.40.0 is an unreleased pre-Beta candidate; it is **not Beta**. It preserves the v0.31 decision journal and adds scoped general memory, bi-temporal facts/relations, explainable lexical/vector/graph/temporal RRF retrieval, a localhost-first embedding adapter, and conflict-aware Markdown push/pull. The npm name `shadowgraph-unified-plugin` returned 404 from the live registry on 2026-08-27, but names are not reserved by a lookup and must be rechecked immediately before publication. The package deliberately remains `private: true` until an independent security review and an actual preregistered comparative measurement are complete and approved. The current seven-arm run could not measure any arm because no common local/free LLM and embedding endpoint was available; dependency import probes are setup evidence, not benchmark wins. The word `best` and equivalent comparative-superiority wording are prohibited for the current evidence. See [the benchmark report](docs/benchmark-report.md) and <https://github.com/LiLara-AI/shadowgraph/blob/main/RELEASE_CHECKLIST.md>. No npm publication, tag, or GitHub release is claimed.

> Comparative benchmark infrastructure was executed, but no arm was measured because no common local/free LLM and embedding endpoint was available. No comparative performance, quality, token, cost, or 'best' claim is supported.

## Unified memory kernel

- `remember()` stores `preference`, `profile`, `goal`, `instruction`, `procedure`, `episode`, or `note` memory under a non-empty project plus optional `userId`, `agentId`, and `runId` scope. Omitted recall project/scope means the `default` project plus all-null scope, never all projects or users.
- Reusing a scope/type/key with identical content is `NOOP`; changed content is `UPDATE`, with the previous version retained and journalled. Explicit plans may also `DELETE` by invalidating rather than silently erasing history.
- `recall()` unions lexical, optional vector, graph-distance, and temporal candidates, then applies weighted Reciprocal Rank Fusion. Results expose raw signal scores/ranks and state when a signal was unavailable; valid-time recall keeps a prior value visible until a future-effective replacement starts.
- Markdown is an inspectable projection and validated write surface. `markdown-sync` uses stable identity paths, hashes, atomic writes, and refuses two-sided conflicts. Exported plaintext copies must be deleted separately after a canonical purge.
- Embeddings are derived data, never canonical truth. No endpoint is configured by default; localhost works when explicitly configured, and remote endpoints require a separate privacy opt-in.

See [the unified-memory guide](docs/unified-memory.md) and [ADR-0006](docs/adr/0006-unified-memory-kernel.md).

## Requirements

- Node.js 20+ (SQLite backend requires Node 22.5+ with `node:sqlite`)
- v0.40.0 is an unreleased review candidate; schema 5 imports schemas 1-5
- No runtime npm dependencies
- Python 3.10+ only for the optional Hermes wrapper

## Quick Start from a clean directory

After the public beta is approved and published, these commands are copy-ready:

```bash
mkdir shadowgraph-beta
cd shadowgraph-beta
npm init -y
npm install shadowgraph-unified-plugin@0.40.0
npx shadowgraph setup
npx shadowgraph doctor
npx shadowgraph remember '{"project":"demo","memoryType":"note","key":"hello","text":"ShadowGraph survives restarts"}'
npx shadowgraph recall '{"project":"demo","query":"what survives restarts?"}'
```

Before publication, a reviewer can use the exact same flow by replacing the package spec with the absolute path to a built `shadowgraph-unified-plugin-0.40.0.tgz`. `setup` initializes storage without rewriting an existing store. `doctor` checks Node compatibility, storage readability/writability, graph validity, and the installed MCP entry point; its failures say what to fix.

Start the local HTTP API and inspect its health:

```bash
npx shadowgraph serve
curl http://127.0.0.1:8787/health
```

The API listens on `http://127.0.0.1:8787` and stores a versioned JSON graph in `.shadowgraph/data.json`. Set `SHADOWGRAPH_FILE` to choose another location. Set `SHADOWGRAPH_STORAGE=sqlite` on Node 22.5+ to use the WAL-backed relational SQLite adapter. JSON and SQLite restore use mandatory domain/journal consistency validation on direct JavaScript, HTTP, CLI, and MCP paths. Every save and restore for a destination shares the same cross-handle/process `.lock` fence: an overlapping writer waits and is revision-checked against restored state, or fails explicitly with a revision/lock/busy outcome; an acknowledged write cannot silently disappear. Lock waits are bounded, abandoned locks are recovered after a stale interval, and validation/activation callback reentry fails immediately rather than deadlocking. SQLite `backup` creates an atomic snapshot; SQLite `restore` additionally retains standalone source/rollback snapshots of committed WAL state and confirms the replacement through open/prepare/load/validation before cleanup. Recovery inspects candidates read-only before a write-capable reopen. Caught failures are rolled back and reopened; cleanup and recovery failures report retained artifacts honestly. HTTP rejects writes and mutating context requests before graph change while restore owns persistence. This is process-level rollback safety, not crash or power-loss durability. JSON restore remains available only for JSON storage.

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
- **Fact** — observed value with `sourceClass` provenance claim, confidence, timestamp, project scope, and status. Ordinary tool input cannot create `verified`; an optional separately configured Ed25519 verifier can verify signed local evidence. Legacy unsigned `verified` values migrate to an untrusted audit marker.
- **Evidence** — source, type, confidence, timestamp, and optional detail.
- **Attempt** — approach, result, environment, lesson/reason, and relationships.
- **Outcome** — successful, mixed, failed, or unknown result with lessons and confidence update.
- **Relationship** — explainable link such as `depends_on`, `supports`, `tested_by`, or `supersedes`.
- **Journal entry** — append-**oriented** record of a graph change, carrying a complete post-operation snapshot. Not append-only: an explicit hard purge deletes entries, which is why the term is "append-oriented with documented deletion semantics" (see `docs/handoffs/journal-contract.md`). A replayable migration baseline is a guarded boundary, not a normal mutation: duplicate or history-resetting placement fails closed as `invalid_projection_baseline_placement` ([ADR-0007](docs/adr/0007-canonical-journal-baseline-placement.md)).

Confidence has an initial value, a current value, a history of evidence-weighted updates, and a `basis` that counts supporting and contradicting evidence by source class. `sourceClass` is one of exactly four values — `agent_claimed`, `tool_observed`, `human_confirmed`, `production_verified` — and it records **what was claimed** about an observation's origin, never proof of it. Unrecognised labels downgrade to `agent_claimed` with the original string preserved in `sourceRaw` for audit only. Passing `verificationStatus: 'verified'` through an ordinary write is rejected. Verification requires a server-owned trust configuration plus a matching Ed25519-signed local attestation; see `docs/api-reference.md`.

Example decision:

```js
import { createShadowGraph } from 'shadowgraph-unified-plugin';
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

### Complete restart and reconsideration example

Every command below opens the installed store in a new process, so the recall and review steps exercise a real restart boundary:

```bash
# 1. Remember.
npx shadowgraph remember '{"project":"release-demo","scope":{"userId":"alice"},"memoryType":"preference","key":"editor","text":"Alice prefers VS Code"}'

# 2. Restart (the prior CLI process has exited), then recall stored memory.
npx shadowgraph recall '{"project":"release-demo","scope":{"userId":"alice"},"query":"editor preference"}'

# 3. Record a decision and its durable reconsideration rule.
npx shadowgraph decision '{"project":"release-demo","title":"Choose deployment database","chosen":"SQLite","alternatives":[{"label":"PostgreSQL","reasonRejected":"Single-user deployment","reopenWhen":[{"key":"deployment","operator":"equals","value":"multi-user"}]}]}'
npx shadowgraph fact '{"project":"release-demo","key":"deployment","value":"single-user","sourceClass":"human_confirmed"}'

# 4. The fact changes in another process.
npx shadowgraph fact '{"project":"release-demo","key":"deployment","value":"multi-user","sourceClass":"human_confirmed"}'

# 5. Restart again and review only stored project state. Do not resend the fact.
npx shadowgraph review '{"project":"release-demo"}'
```

The final result lists the database decision and `PostgreSQL` under `alternativesToReconsider`.

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

Preview and delete projects explicitly:

```bash
npx shadowgraph purge-preview '{"project":"release-demo"}'
npx shadowgraph purge '{"project":"release-demo"}'                 # logical default
npx shadowgraph purge '{"project":"another-project","mode":"hard"}' # irreversible physical journal deletion
```

**External Markdown exports are not automatically deleted.** Logical and hard purge remove canonical project data according to their documented journal semantics, but ShadowGraph cannot discover plaintext exports in arbitrary workspaces, Git history, cloud sync, backups, or removable media. Delete every external copy separately.

### MCP

```bash
shadowgraph mcp
```

For lower prompt overhead without losing stored fidelity, set `SHADOWGRAPH_MCP_COMPACT=1`. Compact mode advertises 12 workflow tools while the full relational graph, memories, facts, events, alternatives, and outcomes remain stored unchanged. Retrieval supports `limit`/`offset` only as explicit pagination and returns `{items,page:{total,hasMore}}`; no records are silently summarized or discarded.

The stdio server is dual-era: legacy clients negotiate `2024-11-05` through `initialize`; modern clients use `2026-07-28` per-request `_meta` and `server/discover`. Any valid JSON-RPC message without an `id` is a notification: it executes normally but emits no success or error response, regardless of method name. Explicit `id:null` requests and parse errors still receive `id:null` responses. Tools, resources, prompts, notifications, and JSON-RPC errors are covered in both contracts. `npm run check:mcp` runs the pinned official Inspector in strict mode and requires 27 full tools, 12 compact tools, and zero findings.

To let MCP generate semantic vectors through a local OpenAI-compatible server (Ollama, llama.cpp, LM Studio, or equivalent), configure both values:

```bash
SHADOWGRAPH_EMBEDDING_URL="http://127.0.0.1:11434/v1" \
SHADOWGRAPH_EMBEDDING_MODEL="nomic-embed-text" \
npm run mcp
```

Remote URLs are rejected unless `SHADOWGRAPH_ALLOW_REMOTE_EMBEDDINGS=1` is also set. That opt-in means memory/query text leaves the machine. Without an embedder or caller-supplied vectors, recall remains lexical/graph/temporal and explicitly returns `semantic.available=false`.

Optional signed offline fact verification is enabled only when `SHADOWGRAPH_VERIFIER_CONFIG` names a local JSON configuration containing an allowed evidence root and trusted Ed25519 public keys. Full mode then advertises `shadowgraph_verify_fact` as tool 28; compact mode remains exactly 12 tools. The caller supplies only `factId` and an evidence path inside the configured root—never verifier identity, key, signature, method, or target status.

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
- `shadowgraph_journal`
- `shadowgraph_rebuild`
- `shadowgraph_review_signals`
- `shadowgraph_purge_preview`
- `shadowgraph_ack_review`
- `shadowgraph_repair_plan`
- `shadowgraph_backup`
- `shadowgraph_restore`
- `shadowgraph_confidence_evidence`

MCP exposes 27 tools by default (12 in compact mode) and also advertises a `shadowgraph://context` resource and a consequential-task prompt. Reading that context may generate review signals, so the MCP server serializes and persists it like a mutation. Search, retrieve, recall, context, and journal responses declare pagination and completeness; confidence evidence requires a stable caller-supplied `key`.

Recommended agent policy:

> Before a consequential task, call ShadowGraph context for the project. Search relevant decisions and failed attempts. Record decisions with assumptions, evidence, and rejected alternatives. Record outcomes after implementation. Treat every fact as a hypothesis unless it carries a verifier-checked signed attestation; a strong `sourceClass` is a strong claim, not a warrant.

## AI tool setup

Install the package globally before configuring a GUI/agent client so `shadowgraph` is on that client's `PATH`:

```bash
npm install --global shadowgraph-unified-plugin@0.40.0
shadowgraph doctor
```

Compact mode is recommended because it advertises the 12 workflow tools while preserving full-fidelity storage. Full mode remains available: remove `SHADOWGRAPH_MCP_COMPACT` or set it to `0`.

**Claude Code** (user scope):

```bash
claude mcp add --scope user --env SHADOWGRAPH_MCP_COMPACT=1 --transport stdio shadowgraph -- shadowgraph mcp
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

```json
{"mcpServers":{"shadowgraph":{"type":"stdio","command":"shadowgraph","args":["mcp"],"env":{"SHADOWGRAPH_MCP_COMPACT":"1"}}}}
```

**Codex**:

```bash
codex mcp add shadowgraph --env SHADOWGRAPH_MCP_COMPACT=1 -- shadowgraph mcp
```

**Hermes Agent** (prefer the CLI rather than hand-editing config):

```bash
hermes mcp add shadowgraph --command shadowgraph --connect-timeout 30 --env SHADOWGRAPH_MCP_COMPACT=1 --args mcp
```

Verified file forms are in `integrations/`: Claude/Cursor stdio JSON, Codex `config.toml`, and Hermes `config.yaml`. `npm run check:integrations` validates their launch fields; the real-tarball smoke launches that installed command in full and compact modes. Set an absolute `SHADOWGRAPH_FILE` in the client environment when one stable store is required across working directories.

## Migration and storage

The JSON store accepts both the v0.1 array format and later graph envelopes. Current exports use schema 5:

```json
{
  "schemaVersion": 5,
  "records": [],
  "facts": [],
  "relations": [],
  "events": [],
  "journal": []
}
```

Schemas 1 through 4 remain importable. Schema 4's global entity-ID, relation-integrity, and project invariants remain enforced during migration; `active` migrates to `proposed` and `aging` to system-owned `stale` with an explicit migration marker. An unsupported future envelope schema is rejected before replacing live state; individual future entities are preserved and reported by validation. JSON is the zero-dependency portable default. v0.40.0 stores a monotonic revision and can reject stale `expectedRevision` saves to prevent lost updates; callers should reload and retry after a revision conflict. SQLite is selectable through `SHADOWGRAPH_STORAGE=sqlite` on Node 22.5+ and uses normalized relational tables with WAL, a busy timeout, transactional replacement, legacy envelope migration, and revision checks. Do not assume revision checks replace application-level conflict handling when multiple processes mutate stale in-memory graphs.

## Security and privacy

The HTTP server binds to `127.0.0.1` by default and rejects non-local browser origins. Set `SHADOWGRAPH_API_TOKEN` for Bearer authentication in shared local deployments. The read-only dashboard is served at `http://127.0.0.1:8787/dashboard`; the static page itself can load without the token, but every data request still receives `401` until the token is entered. The password field keeps the token only in page memory and never writes it to cookies, local storage, or ShadowGraph data. The dashboard reads the same local origin only. This is defense in depth, not a public internet security model. Do not expose the API publicly without TLS, rate limiting, and a deployment threat model. Do not store secrets or sensitive transcripts unless your local storage policy permits it. See `SECURITY.md`.

## Checks

```bash
npm run check
npm test
npm run check:integrations
npm run check:mcp
npm audit --omit=dev
python -m py_compile integrations/hermes-agent.py
npm run check:package
npm pack --dry-run --json
npm run smoke:package
```

GitHub Actions covers Ubuntu and Windows with Node 20, 22, and 24. SQLite-specific gates run only on Node 22/24 where `node:sqlite` exists. The strict Inspector runs full and compact gates on Node 24 for both operating systems; the package smoke runs from a real clean install in every matrix cell.

## License

MIT. See `LICENSE`.
