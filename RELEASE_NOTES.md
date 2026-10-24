# ShadowGraph 0.42.1 — unreleased candidate

This is a local release proposal, not a published release or a readiness declaration.
The existing v0.42.0 tag and npm-unpublished policy remain unchanged (`private: true`).

- Include the extraction activation/recovery guide in the packed artifact and enforce its presence.
- Document a publicly obtainable, checksum-pinned Windows Claude Code executor without replacing
  the interactive host's default executable or bypassing its account/billing checks.
- Provide a credential-free, non-root MCP container definition. Local container discovery is
  separate from Glama's configured build, remote indexing, and real Desktop automatic memory.

The new optional `shadowgraph-codex` wrapper uses the existing ChatGPT subscription through
Codex CLI 0.161.0 with explicit `gpt-6.1-sol` selection. Installed text-work episodes have shown
automatic capture, extraction, fresh-session delivery, mixed Arabic/English source handling,
selected-project reuse, revocation, and a task change inside a wrapper session. No manual
capture/extraction or evaluator memory injection is required. See the packaged
[setup, coverage and limitations guide](docs/codex-integration.md).

The Windows workspace path now also has a real command-failure → repair → passing-check
trace and fresh-session use of that specific experience before acting. Completed answers
are displayed independently of extraction. Delayed/failed memory permits subsequent work;
accepted captures remain pending and recover automatically on the same setup. A real timeout
and the earlier failed reuse gate remain recorded failures, not retroactive passes.

Fresh provenance now separates captures by provider/account/setup; unknown and legacy captures
are held. User corrections can carry a model-proposed relationship to a prior decision, preserving
both quotations and history. Superseded source decisions invalidate dependent answer copies.
Field interpretation and correction relationships are not independently verified semantic facts.

Named host gaps: Codex desktop UI is not observed by this integration; fresh Claude Desktop acceptance remains
pending. No new Claude allowance was consumed for this work. Historical L8 remains FAIL.
There is no comparative cost, speed or generalized superiority claim. Local package, MCP and
container results do not establish remote Glama indexing. Publication and standing extraction
require a separate final owner decision; `private: true` and v0.42.0 remain unchanged.

## Previous public release: 0.42.0 — Technical Preview / Early Access

> Technical Preview / Early Access only — not Beta, not stable. Install from GitHub:
> `npm install --global github:LiLara-AI/shadowgraph#v0.42.0`. The package remains `private: true` and
> is **not published to npm**. The 0.41.0 notes are in this file at the
> [`v0.41.0` tag](https://github.com/LiLara-AI/shadowgraph/blob/v0.41.0/RELEASE_NOTES.md).

ShadowGraph is local-first decision memory for AI agents: what was decided, what was rejected and
why, failed attempts, outcomes, and the conditions that should reopen a decision, stored as
structured data on your machine.

## What is in this release

**Supported (CI on Node 20/22/24, Ubuntu and Windows; clean-install smoke test):**

- The decision memory core on JSON or SQLite, through the CLI, MCP and a local HTTP API.
- MCP: 16 tools in compact mode (recommended) and 35 in full mode, plus `shadowgraph_verify_fact`
  in full mode when a verifier is configured. Full mode's `shadowgraph_bind` and `shadowgraph_attribute` only
  propose; the owner applies them at the CLI.
- Project-scoped memory: every write names a project, a workspace binding or a capture origin, and
  reads return only the selected project. Access grants and delegations, deletion records, purge-aware
  restore, and schema 7 with `migrate` and `downgrade`.

**Optional Claude Code integration (owner-activated, inert until then):**

- **Delivery** at `SessionStart` and `UserPromptSubmit`: relevant records from one activated store,
  for projects whose binding that store recorded. Relevance is lexical.
- **Capture** (experimental) of prompts, tool calls and assistant text, redacted by pattern, into the
  same store.
- **Extraction** (experimental) of decisions, attempts and memories from captures, through the
  subscription route of a profiled Claude Code host: Windows only, Claude Code 2.1.288, or the one
  profiled 2.1.292 binary with a host-validation receipt whose identity ShadowGraph checks (not the
  validation itself), two host turns per call, four calls
  per drain and twelve per hour. On 2.1.292 a remote-settings cache that the host itself reports as
  not applicable no longer blocks extraction; every other policy source still does. On every host,
  extraction runs only when the host's `doctor` reports remote settings as not fetched because the
  subscription is not Enterprise or Team.

## What has been demonstrated, and what has not

- CI and a clean-install smoke test cover the core, MCP (pinned MCP Inspector and the `mcp-proxy`
  hop Glama uses) and the hook templates.
- One synthetic end-to-end run on Windows with Claude Code 2.1.292 captured a failed tool call,
  extracted it into an `attempt` record, and delivered it to a fresh session. That session cited the
  failure in its answer, but not in the exact form the run had fixed in advance, so the run is
  recorded as partial. It is one controlled run, not a measure of usefulness.
- **No comparative benchmark has been measured.** ShadowGraph makes no claim of being faster,
  cheaper, lower-token, more accurate or better than any other memory system.
- **No independent security review** covers anything after commit `4a5e076` (before 0.41.0),
  including scoping, deletion, the hooks, capture and extraction. No human audit has been done.

## Known limitations

- Delivery, capture and extraction have been exercised (one synthetic run) only with Claude Code on
  Windows; no other host has been tried.
- Extraction checks the host, account route and policy before every call, but the account can still
  change between that check and the call.
- Redaction is pattern-based. The session transcript format is read as an unconfirmed hypothesis.
- Turning ordinary conversations into decision memory automatically remains a goal, not a finished
  capability. Record consequential decisions explicitly.
- Interfaces and the storage schema may still change.

## Upgrading from 0.41.0

1. Take a backup: `shadowgraph backup <file>`. 0.42.0 saves schema 7, which 0.41.0 cannot open;
   `downgrade` forks an older copy without changing the store.
2. `npm install --global github:LiLara-AI/shadowgraph#v0.42.0`
3. Writes now need a project, a binding (`shadowgraph bind`) or an origin. Records 0.41.0 stored in
   `default` are not returned until you `attribute` them to a project. `review` returns
   `{ items, completeness }`, and `context()` collections were renamed. The
   [changelog](CHANGELOG.md) lists every breaking change, and the README's
   [Moving between 0.41.0 and 0.42.0](README.md#moving-between-0410-and-0420) explains the details.
4. Hook users: use one store for everything, set `SHADOWGRAPH_FILE` to it for `bind`, `doctor` and
   the MCP server (`bind` refuses any other store while hooks are active), and follow the
   [integrations guide](integrations/README.md).

## Checks for this release

`npm test`, `npm run check` (including public hygiene), `check:package`, `check:integrations`,
`smoke:package` and the delivery-budget performance step on every required CI job for the release
commit (Ubuntu and Windows × Node 20/22/24), and `check:mcp` on the Node 24 jobs.
