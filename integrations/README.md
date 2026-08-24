# ShadowGraph integrations

ShadowGraph gives AI tools one shared decision memory. It is most useful when the agent follows this loop:

```text
Before work: call context/search.
During work: record decisions, facts, evidence, alternatives, and failed attempts.
After work: record an outcome and update the decision status.
When conditions change: call review and reconsider affected alternatives.
```

## MCP clients

Copy-ready configuration bodies:

- `claude-code.mcp.json`
- `cursor.mcp.json`
- `codex.mcp.json`

Replace `ABSOLUTE_PATH_TO_SHADOWGRAPH` with the repository's absolute path. Register this command through the product's MCP settings/import UI:

```text
node ABSOLUTE_PATH_TO_SHADOWGRAPH/src/mcp.js
```

The MCP server exposes nine tools:

```text
shadowgraph_record_decision
shadowgraph_record_attempt
shadowgraph_review
shadowgraph_search
shadowgraph_context
shadowgraph_record_fact
shadowgraph_record_outcome
shadowgraph_update_status
shadowgraph_link
```

The exact configuration file location varies by product and release. These files document the common MCP stdio body; they do not claim one universal vendor path.

## HTTP and Python clients

- `http-client.example.json` documents the stable local HTTP contract.
- `hermes-agent.py` is a dependency-free Python client for agents that call Python functions.
- `openclaw-tool.example.json` and `antigravity-tool.example.json` describe generic HTTP actions because those products may expose different extension APIs.

Start HTTP mode:

```bash
npm start
```

Enable authentication when another local process or shared local tool will connect:

```bash
SHADOWGRAPH_API_TOKEN="use-a-random-token-at-least-16-characters" npm start
```

Send:

```text
Authorization: Bearer use-a-random-token-at-least-16-characters
```

## Agent instruction

Give the model this system/developer instruction:

> Before a consequential task, call ShadowGraph context for the project and search relevant decisions. Record important decisions with assumptions, evidence, and rejected alternatives. Record failed approaches and their lessons. Record observed facts with their source. After implementation, record the outcome and update the decision status. Do not treat old or model-inferred memory as verified when its assumptions changed.

## Storage

JSON is the default and is portable. On Node 22.5+, set `SHADOWGRAPH_STORAGE=sqlite` to use the WAL-backed SQLite adapter for concurrent local writers. Keep the HTTP server on `127.0.0.1`; do not expose it publicly without a proper deployment security model.
