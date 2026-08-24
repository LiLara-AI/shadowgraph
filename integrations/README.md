# ShadowGraph integrations

These files are copy-ready templates for the portable ShadowGraph MCP server. Replace `ABSOLUTE_PATH_TO_SHADOWGRAPH` with the absolute path to this repository. Do not paste the placeholder literally.

## MCP-compatible clients

The following templates use the common MCP stdio shape:

- `claude-code.mcp.json`
- `cursor.mcp.json`
- `codex.mcp.json`

The exact location and filename of each product's configuration can vary by release. Treat these as configuration bodies, not claims about a vendor's current file path. Use the product's own MCP settings/import UI when available.

Run target:

```text
node ABSOLUTE_PATH_TO_SHADOWGRAPH/src/mcp.js
```

On Windows, use escaped backslashes in JSON or forward slashes in the path.

## Generic local-tool clients

- `http-client.example.json` documents the stable HTTP contract.
- `hermes-agent.py` is a dependency-free Python client for agents that can call Python tools.
- `openclaw-tool.example.json` and `antigravity-tool.example.json` describe the same HTTP actions as tool manifests. Their schemas are intentionally generic because those products may expose different extension APIs.

## Recommended agent policy

Give the model this short instruction in its system/developer prompt:

> Before a consequential task, search ShadowGraph and review changed assumptions. After making an architectural decision, record the decision and rejected alternatives. After a failed approach, record the attempt and the lesson. Do not treat an old decision as permanent when its assumptions changed.

## Security

ShadowGraph is local by default. Keep the HTTP server bound to `127.0.0.1`; do not expose it publicly without authentication. MCP receives local process input and writes the configured JSON file, so only connect trusted clients.
