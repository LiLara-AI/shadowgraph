# ShadowGraph integrations

ShadowGraph is a local decision ledger for AI agents. It stores choices, rejected alternatives, assumptions, evidence, facts, failed attempts, outcomes, relationships, review signals, and supersession history.

## v0.30 local status

The v0.30 build in this workspace is intentionally not published. It adds idempotency, verification and expiry, automatic maintenance, graph-aware retrieval, integrity validation, backup/restore helpers, MCP resources/prompts, a dashboard, and revision conflict detection. Do not treat this local build as a released package until separately approved.

## Agent loop

```text
Before work: context + retrieve.
During work: record decisions, evidence, alternatives, facts, attempts, and links.
After work: record outcome and status.
When conditions change: maintain and review signals.
```

See `agent-policy.md` for the copy-ready policy.

## MCP clients

Templates:

- `claude-code.mcp.json`
- `cursor.mcp.json`
- `codex.mcp.json`

Register:

```text
node ABSOLUTE_PATH_TO_SHADOWGRAPH/src/mcp.js
```

The local v0.30 MCP server exposes tools for recording, traversal, supersession, redaction, purge, maintenance, retrieval, validation, and review signals. It also advertises a context resource and a consequential-task prompt.

## HTTP and CLI

Start locally with `npm start`, then use the HTTP routes in the root README. CLI commands include `maintain`, `signals`, `retrieve`, `validate`, `repair-plan`, `backup`, and `restore` in addition to the v0.27 commands.

The optional dashboard is `dashboard/index.html`; it is a static local read-only view of `/stats`, `/review-signals`, and `/records`.

## Security

Keep HTTP bound to `127.0.0.1`. Use `SHADOWGRAPH_API_TOKEN` for shared local connections. Do not store secrets or sensitive transcripts unless permitted. Use redacted export and backup before destructive operations.
