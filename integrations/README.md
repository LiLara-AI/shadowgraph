# ShadowGraph integrations

ShadowGraph is a local decision ledger and unified memory kernel for AI agents. The MCP server is stdio-based and ships inside the npm package.

## Install and diagnose

The candidate remains `private: true` until the release checklist's independent security and benchmark gates are approved. For a built review tarball:

```bash
npm install --global /absolute/path/to/shadowgraph-unified-plugin-0.40.0.tgz
shadowgraph setup
shadowgraph doctor
```

After npm publication, the install command becomes:

```bash
npm install --global shadowgraph-unified-plugin@0.40.0
shadowgraph setup
shadowgraph doctor
```

The global install makes the `shadowgraph` binary available to GUI clients that may not launch from a project containing `node_modules/.bin`. If `shadowgraph doctor` is not found, add npm's global bin directory to the environment used by the client and restart it.

All templates recommend `SHADOWGRAPH_MCP_COMPACT=1`: 12 workflow tools with the same full-fidelity stored graph. To use all 27 tools, remove that environment variable or set it to `0`; compact mode is a tool-advertisement choice, not lossy storage.

By default, data is project-local at `.shadowgraph/data.json` under the MCP process working directory. To pin one store across launches, add an absolute `SHADOWGRAPH_FILE` value to the same `env` mapping.

## Claude Code

Copy-ready CLI registration at user scope:

```bash
claude mcp add --scope user --env SHADOWGRAPH_MCP_COMPACT=1 --transport stdio shadowgraph -- shadowgraph mcp
claude mcp list
```

Or copy `claude-code.mcp.json` to a project `.mcp.json`:

```json
{
  "mcpServers": {
    "shadowgraph": {
      "type": "stdio",
      "command": "shadowgraph",
      "args": ["mcp"],
      "env": { "SHADOWGRAPH_MCP_COMPACT": "1" }
    }
  }
}
```

Restart Claude Code after changing the configuration.

## Cursor

Copy `cursor.mcp.json` to project `.cursor/mcp.json` or user `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "shadowgraph": {
      "type": "stdio",
      "command": "shadowgraph",
      "args": ["mcp"],
      "env": { "SHADOWGRAPH_MCP_COMPACT": "1" }
    }
  }
}
```

Enable the server in **Cursor Settings → MCP**, then restart/reload the client if it was already open.

## Codex

Copy-ready CLI registration:

```bash
codex mcp add shadowgraph --env SHADOWGRAPH_MCP_COMPACT=1 -- shadowgraph mcp
codex mcp list
```

Or append `codex.mcp.toml` to `~/.codex/config.toml` (or a trusted project's `.codex/config.toml`):

```toml
[mcp_servers.shadowgraph]
command = "shadowgraph"
args = ["mcp"]
startup_timeout_sec = 30

[mcp_servers.shadowgraph.env]
SHADOWGRAPH_MCP_COMPACT = "1"
```

Restart Codex CLI/IDE after changing `config.toml`.

## Hermes Agent

Prefer the CLI so Hermes writes valid configuration itself:

```bash
hermes mcp add shadowgraph --command shadowgraph --connect-timeout 30 --env SHADOWGRAPH_MCP_COMPACT=1 --args mcp
```

The resulting `mcp_servers` entry (also in `hermes.mcp.yaml`) is:

```yaml
mcp_servers:
  shadowgraph:
    command: "shadowgraph"
    args: ["mcp"]
    env:
      SHADOWGRAPH_MCP_COMPACT: "1"
    connect_timeout: 30
```

Restart Hermes after registration. Hermes exposes discovered tools with its `mcp_shadowgraph_` prefix.

## What was verified

- `scripts/check-integrations.mjs` validates every JSON template and the required Codex TOML/Hermes YAML launch fields.
- `scripts/smoke-package.mjs` builds a real tarball, installs it into a new directory whose path contains spaces, launches `shadowgraph mcp` only from that installed package, verifies 27 full and 12 compact tools, and performs MCP remember/restart/recall.
- `npm run check:mcp` runs pinned official Inspector strict checks in both modes.
- Product config shapes and commands follow the current official Claude Code, Cursor, Codex, and Hermes MCP documentation. A host application still needs to be installed locally to measure its own discovery UI and lifecycle.

## HTTP, dashboard, and optional Python wrapper

Run the local API with `shadowgraph serve`. The dashboard is served only from `http://127.0.0.1:8787/dashboard`; if `SHADOWGRAPH_API_TOKEN` is enabled, enter it in the password field. The page sends it only as an `Authorization` header and never writes it to cookies or local storage.

`hermes-agent.py` remains an optional Python callable wrapper around the same local HTTP API. Other HTTP/OpenClaw/Antigravity examples are included for clients that do not consume stdio MCP.

## Agent loop

```text
Before work: context + recall/retrieve.
During work: record decisions, evidence, alternatives, scoped memory, facts, attempts, and links.
After work: record outcome and status.
When conditions change: persist the changed fact, restart if needed, then review stored state.
```

See `agent-policy.md` for the copy-ready operating policy and the root README for deletion semantics.
