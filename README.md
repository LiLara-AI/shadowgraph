# ShadowGraph

[![CI](https://github.com/YOUR_GITHUB_USER/shadowgraph/actions/workflows/ci.yml/badge.svg)](https://github.com/YOUR_GITHUB_USER/shadowgraph/actions/workflows/ci.yml)

ShadowGraph is a local-first, vendor-neutral learning layer for AI agents. It combines decision memory, rejected alternatives, failed attempts, assumptions, evidence, and review triggers in one durable store.

> ShadowGraph remembers not only what an agent chose, but what it rejected, why it rejected it, and when it should think again.

## Status

This is the first public release candidate (`0.1.0`). The core, persistence, CLI, HTTP API, MCP server, integration templates, and CI workflow are included. Claude should perform an independent integration and behavior review before this is treated as production-ready.

## Requirements

- Node.js 20+
- No runtime npm dependencies
- Python 3.10+ only for the optional Hermes wrapper

## Install and run

```bash
npm install
npm run check
npm test
npm start
```

The API listens only on `http://127.0.0.1:8787` and stores records in `.shadowgraph/data.json`. Set `SHADOWGRAPH_FILE` to use a different file.

## Interfaces

### JavaScript core

```js
import { createShadowGraph } from './src/shadowgraph.js';
const graph = createShadowGraph();
```

### CLI

```bash
node src/cli.js stats
node src/cli.js list
node src/cli.js search database
node src/cli.js review '{"changedFacts":["local-single-user"]}'
node src/cli.js decision '{"title":"Choose a database","chosen":"PostgreSQL"}'
node src/cli.js attempt '{"solution":"Rewrite everything","result":"Regression"}'
```

### HTTP API

```text
GET  /health
GET  /stats
GET  /records
GET  /search?q=database
POST /decisions
POST /attempts
POST /review
```

### MCP

```bash
npm run mcp
```

The MCP server exposes:

- `shadowgraph_record_decision`
- `shadowgraph_record_attempt`
- `shadowgraph_review`
- `shadowgraph_search`

## AI tool integrations

Copy-ready templates live in `integrations/`:

- Claude Code: `integrations/claude-code.mcp.json`
- Cursor: `integrations/cursor.mcp.json`
- Codex: `integrations/codex.mcp.json`
- Hermes Agent: `integrations/hermes-agent.py`
- OpenClaw: `integrations/openclaw-tool.example.json`
- Antigravity: `integrations/antigravity-tool.example.json`

Replace `ABSOLUTE_PATH_TO_SHADOWGRAPH` in MCP templates. Native settings paths and import screens are product/version-specific, so the templates intentionally provide the standard transport body rather than claiming a universal path.

Recommended agent instruction:

> Before a consequential task, search ShadowGraph and review changed assumptions. After making an architectural decision, record the decision and rejected alternatives. After a failed approach, record the attempt and lesson. Reopen old decisions when their assumptions change.

## Data model

A decision contains:

- selected approach;
- goal;
- confidence;
- assumptions;
- evidence;
- rejected alternatives;
- reason for rejection;
- facts that should reopen each alternative;
- optional review date.

An attempt contains the approach, result, environment, reason, and conditions under which it may be useful again.

## Security and privacy

The HTTP server has no authentication in this release. Keep it bound to `127.0.0.1`; do not expose it publicly. Do not store secrets or sensitive transcripts unless your local storage policy permits it. See `SECURITY.md`.

## Development and release checks

```bash
npm run check
npm test
python -m py_compile integrations/hermes-agent.py
npm pack --dry-run
```

GitHub Actions runs syntax checks, tests, and JSON-template validation on Node 20 and 22.

## Contributing

See `CONTRIBUTING.md`. ShadowGraph must remain vendor-neutral and local-first.

## License

MIT. See `LICENSE`.
