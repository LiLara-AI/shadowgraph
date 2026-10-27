# ShadowGraph

**Carry useful development experience into the next agent session.**

ShadowGraph records what worked, what failed, and why a decision was made—then supplies relevant experience when you continue working. The demonstrated automatic path is the **Windows Codex terminal wrapper**, after one-time setup in projects you enroll.

[![CI](https://github.com/LiLara-AI/shadowgraph/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LiLara-AI/shadowgraph/actions/workflows/ci.yml)
[![Technical Preview](https://img.shields.io/badge/Technical_Preview-v0.42.3-blue)](https://github.com/LiLara-AI/shadowgraph/releases/tag/v0.42.3)

[Get started](#quick-start-windows-codex) · [Supported workflows](#supported-workflows) · [Release & downloads](https://github.com/LiLara-AI/shadowgraph/releases/tag/v0.42.3) · [Documentation](#documentation)

![Session A works and repairs a failure; capture feeds background extraction through the selected provider; local memory supplies relevant experience to fresh Session B. Foreground work continues and cross-project reuse requires explicit sharing.](https://raw.githubusercontent.com/LiLara-AI/shadowgraph/v0.42.3/docs/assets/workflow.svg)

*After setup, work normally. Memory processes in the background; reuse follows your project and sharing choices. [Editable diagram](docs/assets/workflow.svg).*

## From a failed check to useful experience

In a bounded Windows demonstration, an agent ran a parser check that failed because empty fields were missing. It removed a filtering step and reran the unchanged check successfully. Its explanation included the rejected alternative: reconstructing empty fields later would lose their original positions and add complexity.

The wrapper captured the actual command results and explanation. A fresh session working on a differently delimited reader received the relevant experience automatically, identified it as prior-session evidence **before its first command**, and preserved empty fields in its implementation. Its check passed.

This demonstrates one working path, not perfect recall. Extraction can be delayed: two ordinary tasks completed while earlier memory was still pending, then processing recovered automatically. No memory reminder or manual extraction command was needed.

## Quick start: Windows Codex

### Prerequisites

- Windows x64, **PowerShell 7+**, and Node.js **22.5+** with npm (Node 24 recommended).
- Codex CLI **0.161.0**, signed in through your existing ChatGPT subscription. The adapter explicitly selects **`gpt-6.1-sol`**; other executor versions and API-key/provider overrides are not supported by this profile.
- A project you choose to enroll, and a private directory **outside source control** for memory and configuration.

The Codex executor is a separate prerequisite distributed as `@openai/codex`. ShadowGraph itself is **not published to npm**. Installing ShadowGraph alone does not enable automatic memory.

### 1. Install

Run in PowerShell 7+. The version is pinned; the [release](https://github.com/LiLara-AI/shadowgraph/releases/tag/v0.42.3) includes `SHA256SUMS.txt` for the tarball.

```powershell
npm install --global https://github.com/LiLara-AI/shadowgraph/releases/download/v0.42.3/shadowgraph-unified-plugin-0.42.3.tgz

$executorDir = Join-Path $env:LOCALAPPDATA 'ShadowGraph-Codex-0.161.0'
npm install --prefix $executorDir @openai/codex@0.161.0
$codexExe = (Get-ChildItem (Join-Path $executorDir 'node_modules/@openai') -Filter codex.exe -Recurse | Select-Object -First 1).FullName
& $codexExe --version
& $codexExe login status
```

If needed, use `& $codexExe login` and complete Codex's normal sign-in yourself. Select the native `codex.exe`, not an npm shim. Setup checks its version, binary identity and account route. Do not copy authentication files.

### 2. Enroll your project once

Run this **from the project directory you want to enroll**. Choose a descriptive project name; `demo` is an example.

```powershell
$memoryHome = Join-Path $env:LOCALAPPDATA 'ShadowGraph-Codex-Memory'
$setupFile = Join-Path $env:LOCALAPPDATA 'shadowgraph-codex-setup.json'
@{
  executable = $codexExe
  hostMode = 'workspace'
  projects = @(@{ project = 'demo'; cwd = (Get-Location).Path })
} | ConvertTo-Json -Depth 5 | Set-Content -Encoding utf8 $setupFile

shadowgraph-codex.cmd setup --config $setupFile --home $memoryHome
shadowgraph-codex.cmd status --home $memoryHome
```

Persistent setup asks for genuine owner consent at your terminal. Review the project, executor and provider scope before confirming. Workspace permissions and managed execution rules still apply. PowerShell 7 writes this JSON as UTF-8 without a byte-order mark.

### 3. Work normally

From the enrolled project, launch:

```powershell
$memoryHome = Join-Path $env:LOCALAPPDATA 'ShadowGraph-Codex-Memory'
shadowgraph-codex.cmd run --home $memoryHome
```

Enter ordinary task prompts, one line per turn. Launch the same command again for a fresh session. Relevant memory is supplied before each new turn; you do not need to say “remember” or “search memory.” Only work launched through this wrapper is observed.

Answers appear without waiting for extraction. Pending memory retries while the wrapper is open and on later launches. Closing it stops the bounded worker; **there is no permanent background daemon**. For configuration, pending-state troubleshooting and limits, see the [Codex guide](docs/codex-integration.md).

## What survives a session

| Experience | What stays attached |
| --- | --- |
| Decisions | Chosen approach, alternatives, reasons and conditions for reconsideration |
| Attempts and outcomes | What was tried and the observed result; inferred causes remain distinct |
| Evidence | Source quotations, captured command results and provenance |
| Current state | Corrections and supersession, while retaining history |
| Uncertainty | Model-proposed interpretation, missing conditions and limits of the evidence |

Stored records are inspectable. A model interpretation is not independently verified truth, and a useful lesson is not automatically valid in every project.

## Sharing and control

Memory starts **project-only**. You can explicitly share selected enrolled projects, select all currently permitted projects, exclude sources, revoke wider sharing, or pause the integration. Capture scope and read sharing are separate choices.

```powershell
# From an enrolled project; use the same private home as setup.
shadowgraph-codex.cmd share --home $memoryHome --mode selected --projects demo,shared-library
shadowgraph-codex.cmd share --home $memoryHome --mode all-permitted --exclude confidential-project
shadowgraph-codex.cmd share --home $memoryHome --mode project
shadowgraph-codex.cmd pause --home $memoryHome
shadowgraph-codex.cmd resume --home $memoryHome
```

Replace names with your enrolled projects. Sharing is explicit and revocable, not an automatic permission detector. Corrections retain history; source dependencies prevent copied memory-informed answers from bypassing later revocation. Already displayed information cannot be erased from a transcript or a person's knowledge. [Details and inspection commands](docs/codex-integration.md).

**Local-first, with a configured provider.** Canonical memory stays in your private local store. Automatic extraction and host delivery send selected captured/context data through the configured model provider and require its account and network. Pattern redaction cannot guarantee every secret is removed. There is no hosted sync or telemetry. [Data lifecycle, backup and deletion](docs/data-lifecycle.md).

## MCP interface profiles

Full remains the default (35 tools, or 36 with a configured verifier). Compact
remains 16 tools. The new opt-in Workflow Profile offers 20 tools: Compact plus
stored review signals, keyed confidence evidence, decision status transitions and
explicit supersession, using the existing handlers and access controls.

| Server environment | Inventory |
| --- | ---: |
| Profile unset; compact unset or `0` | Full: 35 / 36 |
| Profile unset; `SHADOWGRAPH_MCP_COMPACT=1` | Compact: 16 |
| `SHADOWGRAPH_MCP_PROFILE=workflow`; compact unset or `0` | Workflow: 20 |

Set the environment on the MCP server process, then restart/reconnect and refresh
`tools/list`. There is no agent-callable mode switch. Workflow does not expose
administrative repair or destructive cleanup. See the [configuration and workflow
guide](docs/mcp-compatibility.md#optional-workflow-profile-complete-the-decision-loop).

## Supported workflows

| Workflow | What this preview establishes |
| --- | --- |
| Windows `shadowgraph-codex run` | Installed command-executing workflow; automatic capture, background extraction, fresh-session delivery and recovery after delay/failure |
| MCP, CLI, HTTP and JavaScript API | Explicit record/read operations; MCP exposes 16 compact or 35 full tools. Tool calls alone do not observe all work |
| Claude Code CLI hooks (Windows) | After one-time setup on Claude Code CLI 2.x (verified on 2.1.302, print mode): durable capture under contention, automatic extraction by an owner-selected model, delivery to fresh sessions, corrections of decisions and revocable sharing. See the [Claude Code guide](docs/claude-code-integration.md#support-and-evidence) for what was verified and its limits. Claude Desktop is not verified |
| Codex Desktop UI or ordinary CLI launched elsewhere | Not observed by this wrapper |
| Glama MCP container | Credential-free MCP surface; cannot capture a user's Windows Codex sessions by itself |

### Preview limits

Each host turn has a 120-second process limit. Background extraction has bounded calls, retries and concurrency; a backlog can remain honestly pending. Native command events and user/assistant text are captured, but not every native tool-event type. Retrieval happens between turns, not inside a running turn.

This is **Technical Preview**, not stable/GA. There are no claims of perfect semantic classification, universal language support, cost or time savings, superiority over native memory, or a human third-party security audit. See [release notes](RELEASE_NOTES.md), [security scope](SECURITY.md) and [benchmark status](docs/benchmark-report.md).

## Upgrade and storage

Stop active work and back up your stores and private integration home before upgrading. v0.42.3 retains schema 7; changed source/executor/account identity requires setup again. Older pending work with different setup provenance is held, not silently reassigned. [Upgrade and rollback guide](docs/migration.md).

### Moving between 0.41.0 and 0.42.0

The historical schema-5/schema-7 migration and downgrade instructions remain in the [migration guide](docs/migration.md#moving-between-0410-and-0420). Preserve a backup made before upgrading.

## Documentation

| Need | Guide |
| --- | --- |
| Automatic Windows setup, sharing, limits and troubleshooting | [Codex integration](docs/codex-integration.md) |
| Manual installation, MCP configuration, CLI/HTTP/JavaScript and storage | [Manual usage](docs/manual-usage.md) |
| Other clients and existing hooks | [Integrations](integrations/README.md) · [Claude extraction](docs/extraction.md) |
| API and protocol details | [API reference](docs/api-reference.md) · [MCP compatibility](docs/mcp-compatibility.md) |
| A decision that reopens when conditions change | [Decision-memory demo](docs/decision-memory-demo.md) |
| Privacy, backups and recovery | [Data lifecycle](docs/data-lifecycle.md) · [Migration](docs/migration.md) |
| Development and feedback | [Contributing](CONTRIBUTING.md) · [Issues](https://github.com/LiLara-AI/shadowgraph/issues) · [Discussions](https://github.com/LiLara-AI/shadowgraph/discussions) |

Please redact private paths, prompts, stores and credentials before reporting an issue. Report security vulnerabilities [privately](https://github.com/LiLara-AI/shadowgraph/security/advisories/new).

[MIT license](LICENSE). No npm publication, paid hosting or standing extraction is implied by installing this preview.
