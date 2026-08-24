# ShadowGraph v0.27

ShadowGraph is a local-first, vendor-neutral learning layer for AI agents. It is not generic chat memory: it is an explainable decision graph that tracks what an agent chose, what it rejected, the assumptions and evidence behind it, what happened afterward, and when the decision should be reopened.

> ShadowGraph remembers not only what an agent chose, but what it rejected, why it rejected it, and what evidence should make it think again.

## What it does

When an AI agent starts an important task, ShadowGraph gives it relevant working context. During the task, the agent can save decisions, assumptions, evidence, rejected alternatives, failed attempts, and observed facts. After implementation, the agent records the outcome. ShadowGraph updates confidence, marks replaced facts as superseded, and creates review signals when an old decision may no longer fit the current situation.

The normal learning loop is:

```text
1. Context: load active decisions, stale facts, failed attempts, and open reviews.
2. Decide: record the chosen approach, assumptions, evidence, and rejected alternatives.
3. Work: record failed or informative attempts and link related graph entities.
4. Observe: record facts and their provenance as human, tool, model, or imported evidence.
5. Evaluate: record a successful, mixed, failed, or unknown outcome.
6. Reconsider: review decisions whose assumptions, facts, confidence, or outcomes changed.
```

This lets an agent remember the reasoning behind work instead of blindly repeating old answers.

## v0.27 status

Version 0.27 builds on the v0.26 hardening release. It adds bounded graph traversal, explicit decision supersession, privacy-safe redacted exports, project purge, stronger multi-term explainable search, and matching HTTP, CLI, and MCP capabilities. It preserves selectable storage, optional API authentication, relationship persistence, scoped facts, migration compatibility, and the v0.26 graph envelope.

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

The API listens on `http://127.0.0.1:8787` and stores a versioned JSON graph in `.shadowgraph/data.json`. Set `SHADOWGRAPH_FILE` to choose another location. Set `SHADOWGRAPH_STORAGE=sqlite` on Node 22.5+ to use the WAL-backed SQLite adapter.

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
- **Fact** — observed value with source, confidence, timestamp, project scope, and status.
- **Evidence** — source, type, confidence, timestamp, and optional detail.
- **Attempt** — approach, result, environment, lesson/reason, and relationships.
- **Outcome** — successful, mixed, failed, or unknown result with lessons and confidence update.
- **Relationship** — explainable link such as `depends_on`, `supports`, `tested_by`, or `supersedes`.
- **Event** — append-only record of important graph changes.

Confidence has an initial value, current value, and history of outcome-driven changes. Sources can be labeled `human_confirmed`, `tool_observed`, `model_inferred`, `imported`, or `unknown`; inferred memory should not automatically be treated as verified truth.

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
graph.addFact({ key: 'deployment', value: 'local', source: 'human_confirmed', confidence: 1 });
console.log(graph.context({ project: 'my-app', facts: { deployment: 'local' } }));
```

## Interfaces

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
POST /decisions
POST /attempts
POST /facts
POST /outcomes
POST /review
POST /context
POST /status
POST /relationships
POST /traverse
POST /redact
POST /supersede
DELETE /projects
```

`/redact` is read-only and returns a privacy-safe export. `DELETE /projects` permanently removes the selected project's records, facts, and attached relationships. Responses are JSON. `/redact` returns a filtered, redacted export without changing storage. `DELETE /projects` permanently removes the selected project's records, facts, events, and attached relationships; this cannot be undone. The server returns `401` when token authentication is enabled and missing, `403` for disallowed browser origins, `404` for missing decisions or routes, and `413` for oversized request bodies.

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
- `shadowgraph_traverse`
- `shadowgraph_supersede`
- `shadowgraph_redact`
- `shadowgraph_purge`

Recommended agent policy:

> Before a consequential task, call ShadowGraph context for the project. Search relevant decisions and failed attempts. Record decisions with assumptions, evidence, and rejected alternatives. Record outcomes after implementation. Treat model-inferred facts as unverified until supported by a human or tool observation.

## AI tool setup

Copy-ready templates are in `integrations/` for Claude Code, Cursor, and Codex MCP configuration, plus HTTP/Python examples for Hermes Agent, OpenClaw, and Antigravity.

For MCP clients, replace `ABSOLUTE_PATH_TO_SHADOWGRAPH` in the relevant JSON file and register the command:

```text
node ABSOLUTE_PATH_TO_SHADOWGRAPH/src/mcp.js
```

The exact settings location varies by product and version. Use the product's MCP import/settings UI when available. ShadowGraph communicates through standard local MCP stdio or HTTP; it does not depend on a vendor-private API.

## Migration and storage

The JSON store accepts both the v0.1 array format and the v0.26 graph envelope. v0.26 exports:

```json
{
  "schemaVersion": 2,
  "records": [],
  "facts": [],
  "relations": [],
  "events": []
}
```

JSON is the zero-dependency portable default. SQLite is selectable through `SHADOWGRAPH_STORAGE=sqlite` on Node 22.5+ and uses WAL mode with a busy timeout for concurrent local writers. Do not run multiple writers against the same JSON file concurrently; use SQLite for that deployment shape.

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
