# ShadowGraph integrations

ShadowGraph is a local decision ledger and unified memory kernel for AI agents. It stores choices, rejected alternatives, assumptions, evidence, scoped user/agent/run memory, temporal facts, failed attempts, outcomes, relationships, review signals, and supersession history.

## v0.40.0 local status

The v0.40.0 build in this workspace is an unreleased review candidate. It preserves v0.31 decision/reconsideration behavior and adds `shadowgraph_remember`, explainable hybrid `shadowgraph_recall`, scoped temporal memory, optional local embeddings, and Markdown push/pull. Do not treat this local build as released until separately approved.

## Agent loop

```text
Before work: context + recall/retrieve.
During work: record decisions, evidence, alternatives, scoped memory, facts, attempts, and links.
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

The local v0.40.0 MCP server exposes 27 tools (12 in compact mode), including high-level remember/recall workflows. It also advertises a context resource and a consequential-task prompt. Retrieval responses use completeness envelopes, and confidence evidence requires a stable `key`.

## HTTP and CLI

Start locally with `npm start`, then use the HTTP routes in the root README. CLI commands include `remember`, `recall`, `markdown-sync`, `maintain`, `signals`, `retrieve`, `validate`, `repair-plan`, `backup`, and `restore`.

The optional dashboard is `dashboard/index.html`; it is a static local read-only view of `/stats`, `/review-signals`, and `/records`.

## Security

Keep HTTP bound to `127.0.0.1`. Use `SHADOWGRAPH_API_TOKEN` for shared local connections. Do not store secrets or sensitive transcripts unless permitted. Use redacted export and backup before destructive operations.
