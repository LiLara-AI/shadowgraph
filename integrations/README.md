# ShadowGraph integrations

ShadowGraph is a local decision ledger and unified memory kernel for AI agents. The MCP server is stdio-based and ships inside the npm package.

## Install and diagnose

The package remains `private: true` and is not published to npm until the release checklist's independent security and benchmark gates are approved. Install it from the repository, as the [main README](../README.md#1-install) describes:

```bash
npm install --global github:LiLara-AI/shadowgraph
shadowgraph setup
shadowgraph doctor
```

This installs `main`, the development build `0.42.0-dev.0`, which is newer than the 0.41.0 Technical Preview. See [Moving between 0.41.0 and `main`](../README.md#moving-between-0410-and-main) before switching a store between them.

The global install makes the `shadowgraph` binary available to GUI clients that may not launch from a project containing `node_modules/.bin`. If `shadowgraph doctor` is not found, add npm's global bin directory to the environment used by the client and restart it.

All templates recommend `SHADOWGRAPH_MCP_COMPACT=1`: 16 workflow tools with the same full-fidelity stored graph. To use all 35 tools, remove that environment variable or set it to `0`; compact mode is a tool-advertisement choice, not lossy storage.

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

### Claude Code hooks: memory at the moment it matters

`claude-code.hooks.json` is the hook block that lets Claude Code receive relevant memory without a memory command: at `SessionStart` and `UserPromptSubmit` it runs `shadowgraph deliver --hook`, a read that never blocks or steers the host. Add or remove it with:

```bash
shadowgraph install-hooks
shadowgraph uninstall-hooks
```

Both change `~/.claude/settings.json` (or the file `--settings` names, followed through any link to the file itself) only after you type `confirm` at a terminal; only a scratch file under the system's temporary directory is changed without asking. They keep every other setting and hook, and leave exactly one ShadowGraph generation. Run them with no Claude Code session open, since a session may rewrite its settings meanwhile (if the file changes while you decide, nothing is written). **Installing is not activating**: the installed hooks read nothing and print nothing until delivery is activated. A running Claude Code session keeps the hooks it started with until it is restarted.

Activation is a separate, logged step after its gate, naming the one store the hook will read:

```bash
shadowgraph activate delivery --evidence <gate-receipt> --store /absolute/path/to/data.json
```

Only a project whose worktree binding that store has also recorded (`shadowgraph bind`, worktree type) is delivered, so a repository's own `.shadowgraph` files never choose what reaches the model. The hook reads that one store only: memory recorded in any other store, such as the project-local `.shadowgraph/data.json` the MCP server uses when `SHADOWGRAPH_FILE` is not set, is not delivered. So point the MCP server and `shadowgraph bind` at the same store (the same absolute `SHADOWGRAPH_FILE`) before activating. To turn delivery off, **deactivate first, then uninstall**: `shadowgraph deactivate delivery` silences every hook at once, including those running sessions still hold, and `shadowgraph uninstall-hooks` then removes the block. Run `deactivate` with the `SHADOWGRAPH_HOME` Claude Code's hooks see (by default none, so `~/.shadowgraph`), and check the record path it prints. Remove the hooks before uninstalling ShadowGraph, since each hook otherwise runs a command that no longer exists.

For a fixed build rather than whatever `shadowgraph` is on the path, `node scripts/install-runtime.mjs` installs a commit's packed build under `~/.shadowgraph/runtime/<commit>/`, and `install-hooks --runtime <directory>` and `activate delivery --runtime <directory>` name it.

`claude-code.capture-hooks.json` is the capture hook block (`shadowgraph install-hooks --capture`, removed with `uninstall-hooks --capture`): at `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `PreCompact` and `SessionEnd` it runs `shadowgraph capture --hook`, synchronously, which records each event's material, and the assistant's text read from the session's transcript at `Stop`, `PreCompact` and `SessionEnd`, into the private store only after the owner runs `shadowgraph activate capture` for that same store, and stays silent. Capture, too, covers only projects whose worktree binding that store recorded, and writes a JSON store only. To turn it off, `shadowgraph deactivate capture` first, then `uninstall-hooks --capture`.

`claude-code.coverage.json` states, for the Claude Code version it names as verified (`verifiedVersion`, 2.1.288 at this commit), where each of the seven stages of experience lands at each trigger: delivery is covered at a new session's start and at each prompt, unverified at a start after resume, clear or compaction, and not available within a turn, which is a declared gap. Its `capture` block says what capture records at each event and reads from the transcript, how each item is identified, what it never captures, and what it declares -- among them that the transcript's format is a hypothesis the capture gate confirms.

Capture lifecycle controls are documented in [the API reference](../docs/api-reference.md#capture-lifecycle-controls): scoped inspection, terminal-confirmed retention/cancel/delete, and bounded expiry. Deactivation disables capture before cleanup and reports deferred cleanup honestly. Expiry can permanently prevent later re-extraction and transcript reconciliation for affected sessions; it never releases quarantine. Pinned capture activation requires the completed lifecycle build, and delivery over capture data requires the retention reader floor. Prepare and approve any real-host runtime change before installing or activating it.

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

- `scripts/check-integrations.mjs` validates every JSON template and the required Codex TOML/Hermes YAML launch fields, the Claude Code hook block (events, handler type, command, timeout, keys, and a delivery deadline below the timeout), and the coverage manifest (host and exact version, the same-turn gap, all seven stages per trigger, an uncovered trigger).
- The hook lifecycle -- install, activate, deliver, deactivate, uninstall -- runs in the test suite against scratch settings with the home directory redirected, and the clean-install smoke adds and removes the hooks with the installed binary. The host itself is exercised only at the activation gate.
- `scripts/smoke-package.mjs` builds a real tarball, installs it into a new directory whose path contains spaces, launches `shadowgraph mcp` only from that installed package, verifies 35 full and 16 compact tools, and performs MCP remember/restart/recall.
- `npm run check:mcp` runs pinned official Inspector strict checks in both modes, then the pinned Glama `mcp-proxy@6.4.3` gate.
- Product config shapes and commands follow the current official Claude Code, Cursor, Codex, and Hermes MCP documentation. A host application still needs to be installed locally to measure its own discovery UI and lifecycle.

## HTTP, dashboard, and optional Python wrapper

Run the local API with `shadowgraph serve`. The dashboard is served only from `http://127.0.0.1:8787/dashboard`; if `SHADOWGRAPH_API_TOKEN` is enabled, enter it in the password field. The page sends it only as an `Authorization` header and never writes it to cookies or local storage.

`hermes-agent.py` remains an optional Python callable wrapper around the same local HTTP API. Each helper takes `project` (default `"default"`, the project its record helpers write to) and sends it; `project=None` names no project, so reads return nothing and changes are refused. Other HTTP/OpenClaw/Antigravity examples are included for clients that do not consume stdio MCP.

## Agent loop

```text
Before work: context + recall/retrieve.
During work: record decisions, evidence, alternatives, scoped memory, facts, attempts, and links.
After work: record outcome and status.
When conditions change: persist the changed fact, restart if needed, then review stored state.
```

See `agent-policy.md` for the copy-ready operating policy and the root README for deletion semantics.
