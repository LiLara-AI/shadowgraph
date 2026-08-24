# ShadowGraph v0.26

ShadowGraph is a local-first, vendor-neutral learning layer for AI agents. It is not generic chat memory: it is an explainable decision graph that tracks what an agent chose, what it rejected, the assumptions and evidence behind it, what happened afterward, and when the decision should be reopened.

> ShadowGraph remembers not only what an agent chose, but what it rejected, why it rejected it, and what evidence should make it think again.

## v0.26 status

Version 0.26 is the final hardening release built on the v0.25 decision graph. It adds selectable storage, optional API authentication, complete relationship persistence, scoped facts, retrieval filters, and release-grade interface checks. It preserves import compatibility with v0.1 records and adds project scopes, facts, evidence provenance, outcomes, confidence history, event history, explainable retrieval, and a context tool for agents.

## Requirements

- Node.js 20+ (SQLite backend requires Node 22.5+ with `node:sqlite`)
- No runtime npm dependencies
- Python 3.10+ only for the optional Hermes wrapper

## Install and run

```bash
npm install
npm run check
npm test
npm start
```

The API listens on `http://127.0.0.1:8787` and stores a versioned JSON graph in `.shadowgraph/data.json`. Set `SHADOWGRAPH_FILE` to choose another location. Set `SHADOWGRAPH_STORAGE=sqlite` on Node 22.5+ to use the WAL-backed SQLite adapter. For shared local deployments, set `SHADOWGRAPH_API_TOKEN` to a random value of at least 16 characters and send `Authorization: Bearer <token>`.

## v0.2 data model

The graph contains:

- **Decision** — selected approach, goal, project, confidence, assumptions, alternatives, evidence, outcome.
- **Alternative** — rejected proposal, rejection reason, and structured reopen rules.
- **Fact** — observed value with source, confidence, timestamp, and status.
- **Evidence** — source, type, confidence, timestamp, and optional detail.
- **Attempt** — approach, result, environment, lesson/reason, and relationships.
- **Outcome** — successful, mixed, failed, or unknown result with lessons and confidence update.
- **Event** — append-only record of important graph changes.

Confidence has an initial value, current value, and history of outcome-driven changes. Sources can be labeled `human_confirmed`, `tool_observed`, `model_inferred`, `imported`, or `unknown`; inferred memory should not automatically be treated as verified truth.

## Interfaces

### JavaScript core

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
graph.addFact({ key: 'deployment', value: 'local', source: 'human_confirmed', confidence: 1 });
console.log(graph.context({ project: 'my-app', facts: { deployment: 'local' } }));
```

### CLI

```bash
node src/cli.js stats
node src/cli.js list
node src/cli.js search '{"query":"database","project":"my-app","status":"validated","minConfidence":0.7}'
node src/cli.js context '{"project":"my-app","facts":{"deployment":"local"}}'
node src/cli.js review '{"changedFacts":["local-single-user"]}'
node src/cli.js fact '{"key":"deployment","value":"local","source":"human_confirmed","confidence":1}'
node src/cli.js decision '{"project":"my-app","title":"Choose a database","chosen":"PostgreSQL"}'
node src/cli.js outcome '{"decisionId":"DECISION_ID","outcome":{"status":"failed","lessons":["Assumption was wrong"]}}'
node src/cli.js attempt '{"solution":"Rewrite everything","result":"Regression"}'
```

### HTTP API

```text
GET  /health
GET  /stats
GET  /records
GET  /search?q=database&project=my-app
POST /decisions
POST /attempts
POST /facts
POST /outcomes
POST /review
POST /context
POST /status
POST /relationships

Set `SHADOWGRAPH_API_TOKEN` to enable Bearer authentication on the HTTP API. Use `Authorization: Bearer <token>` with every request.

### MCP

```bash
npm run mcp
```

MCP tools:

- `shadowgraph_record_decision`
- `shadowgraph_record_attempt`
- `shadowgraph_review`
- `shadowgraph_search`
- `shadowgraph_context`
- `shadowgraph_record_fact`
- `shadowgraph_record_outcome`
- `shadowgraph_update_status`
- `shadowgraph_link`

Recommended agent policy:

> Before a consequential task, call ShadowGraph context for the project. Search relevant decisions and failed attempts. Record decisions with assumptions, evidence, and rejected alternatives. Record outcomes after implementation. Treat model-inferred facts as unverified until supported by a human or tool observation.

## Migration and storage

The JSON store accepts both the v0.1 array format and the v0.2 graph envelope. v0.2 exports:

```json
{
  "schemaVersion": 2,
  "records": [],
  "facts": [],
  "relations": [],
  "events": []
}
```

The current local store remains JSON for zero-dependency portability. v0.26 also includes an optional `src/sqlite-storage.js` adapter for Node 22.5+ runtimes exposing `node:sqlite`; Node 20 users should continue using JSON storage. Do not run multiple writers against the same JSON file concurrently; use the SQLite adapter for transactional multi-process storage.

## Integration

Copy-ready templates remain in `integrations/` for Claude Code, Cursor, Codex, Hermes Agent, OpenClaw, and Antigravity. They use the stable MCP/HTTP surfaces rather than vendor-specific internals.

## Security and privacy

The HTTP server has no authentication. Keep it bound to `127.0.0.1`; do not expose it publicly. Browser origins other than localhost are rejected as defense in depth. Do not store secrets or sensitive transcripts unless your local storage policy permits it. See `SECURITY.md`.

## Checks

```bash
npm run check
npm test
npm audit --omit=dev
python -m py_compile integrations/hermes-agent.py
npm pack --dry-run
```

## License

MIT. See `LICENSE`.
