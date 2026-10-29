# ShadowGraph 0.43.0 — Technical Preview

This release adds automatic experience memory for the **Claude Code CLI on Windows**,
evaluated in print mode (`claude -p`). After a one-time setup, ordinary Claude Code
CLI sessions are captured durably, extracted in the background by a separate,
owner-selected Claude model, and delivered to fresh sessions at start and with
relevant prompts. This is a pre-release, not stable/GA. The package remains
`private: true` and unpublished to npm. Earlier tags and assets (v0.41.0 to v0.42.3)
are preserved. The Windows Codex workflow and the MCP Full, Compact and Workflow
profiles are unchanged.

## Changes

- Durable capture spool for Claude Code hooks: input is kept while the store is busy,
  replayed oldest first, and losses are recorded as content-free markers that
  delivery reports.
- Runtime-evidence extraction profile for Claude Code 2.x: each invocation's own
  session account must show the confined session before its output is used; the
  owner chooses the extraction model at activation (`--model`).
- Corrections on the Claude route: a user's correction supersedes the user's earlier
  decision; a decision kept verbatim as a memory is linked to the correction
  (`applied: false`) and marked `correctedBy`, not closed.
- `shadowgraph sharing project|selected|all-permitted`: owner-confirmed, revocable
  delivery grants.
- Delivery puts lines before full records at SessionStart and UserPromptSubmit, so one
  large record no longer crowds out the decision that says what was rejected and why.
- An extraction output refused by the executor's own checks is asked once more,
  within the frozen budgets (4 calls per drain, 12 per rolling hour).
- A decision organized from a whole message keeps its choice and alternatives when
  the proposed reason names none of them; the reason stays in the quoted source.
- Captures from an earlier extraction setup are reported as `priorSetup` with a
  `prior_setup` gap, not as pending work. They are not extracted by a new activation.

The full list is in the [changelog](CHANGELOG.md).

## Install

```powershell
npm install --global https://github.com/LiLara-AI/shadowgraph/releases/download/v0.43.0/shadowgraph-unified-plugin-0.43.0.tgz
```

Verify the tarball against `SHA256SUMS.txt` on the
[GitHub Release](https://github.com/LiLara-AI/shadowgraph/releases/tag/v0.43.0).
Installation alone does not activate automatic memory. Claude Code setup, activation
and its commands are in the [Claude Code guide](docs/claude-code-integration.md).
Stop active work and back up stores and private integration state before upgrading.
Schema 7 is unchanged. See [upgrade and rollback](docs/migration.md).

## Evidence

On Windows 11 with Claude Code CLI 2.1.312 in print mode, a fresh-store run showed
one complete chain: a session failed a real check, repaired it, and kept the decision
with the rejected alternative; extraction ran automatically; a fresh session (Arabic
prompt) received that decision at SessionStart and used the same exact-arithmetic
approach before its first check, where a no-memory control used floating point. That
session still made and repaired a type error. Recovery of pending extraction by the
next ordinary session under the same activation was also shown. The [Claude Code
guide](docs/claude-code-integration.md#support-and-evidence) lists each run.

## Known limits

- Delivered experience is not always applied. In one live run a fresh session
  received an earlier lesson, named it, and implemented only what its own sample
  showed. The cause is not established.
- After extraction is deactivated and activated again, items left pending under the
  earlier setup are not extracted. Status reports them as `priorSetup`; this
  reporting was tested offline and in CI, not in a live run.
- A user's decision may be kept as verbatim memory under strict claim verification.
  The separate `reasonRejected` field can be empty while the reason stays in the
  quoted alternative and source.
- Extraction quality varies by model: Sonnet was reliable in the live runs; Haiku
  once missed the decision.
- With Claude Code 2.1.302 or earlier on Windows, `claude -p` exits only after the
  extraction worker finishes (up to about 4 minutes). Use 2.1.312 or later.
- Not verified: Claude Desktop, the interactive TUI, resume flows, and macOS or Linux
  hosts. No claim of universal model obedience, general bilingual accuracy, cost or
  time savings, or superiority over native memory.
- Automatic extraction sends selected captured data to the configured model
  provider and uses its account. Pattern redaction cannot guarantee every secret is
  removed.
- The credential-free Glama MCP container does not capture or extract a user's
  Claude Code or Codex sessions.

## Previous public release: 0.42.3 — Technical Preview

This release publishes the accepted MCP usability improvements and an optional
20-tool Workflow Profile. Full remains the default (35 tools; 36 with a configured
verifier), and Compact remains 16. This is a pre-release, not stable/GA. The package
remains `private: true` and unpublished to npm. Earlier tags and assets are preserved.

## Changes

- Clarify context/search/retrieval/recall/expansion selection, evaluation versus
  persisted review signals, parameter interactions, and audit/revision effects.
- Add the explicitly selected Workflow Profile: all Compact tools plus existing
  `shadowgraph_review_signals`, `shadowgraph_confidence_evidence`,
  `shadowgraph_update_status` and `shadowgraph_supersede` handlers. This completes
  more ordinary decision/review workflows without advertising administrative repair.
- Preserve existing names, validation constraints, output schemas, effect annotations,
  project restrictions and authorization. No storage or automatic-memory redesign.

## Install and choose a profile

For the documented Windows Codex workflow, use Node 22.5+ and PowerShell 7+:

```powershell
npm install --global https://github.com/LiLara-AI/shadowgraph/releases/download/v0.42.3/shadowgraph-unified-plugin-0.42.3.tgz
```

Verify the tarball using `SHA256SUMS.txt` on the
[GitHub Release](https://github.com/LiLara-AI/shadowgraph/releases/tag/v0.42.3).
Installation alone does not activate automatic memory. Stop active work and back up
stores and private integration state before upgrading. Schema 7 remains unchanged;
changed source/executor/account identity requires owner setup again. Pending captures
with different setup provenance remain held. See [upgrade/rollback](docs/migration.md).

Set environment variables on the MCP server process:

| Profile | Configuration | Tools |
| --- | --- | ---: |
| Full (default) | `SHADOWGRAPH_MCP_PROFILE` unset; compact unset or `0` | 35 / 36 with verifier |
| Compact | Profile unset; `SHADOWGRAPH_MCP_COMPACT=1` | 16 |
| Workflow (opt-in) | `SHADOWGRAPH_MCP_PROFILE=workflow`; compact unset or `0` | 20 |

Restart/reconnect and refresh `tools/list` after changing configuration. There is no
agent-callable mode switch. Workflow plus compact `1` is rejected, not silently
reinterpreted. The [MCP guide](docs/mcp-compatibility.md) documents effects and scope.

## Evidence and limitations

The accepted paired selection evaluation scored 16/16 on both baseline and candidate;
it did not demonstrate improved model selection. Deterministic tests cover the newly
available workflow sequences and refused unauthorized operations. Candidate TDQS was
not measured locally. The prior published Glama score was 3.9/5 on 16 Compact tools;
the 20-tool Workflow inventory is a different assessment surface. A fresh remote score
is a separate observation, not a promised improvement or release acceptance target.

Automatic capture, extraction, recovery, correction, sharing/revocation, provenance,
uncertainty and project boundaries retain their accepted implementation and limits.
No new live automatic-memory demonstration is claimed. The credential-free Glama
MCP container cannot capture a user's Windows sessions. GitHub publication, Glama
remote build/publication and assessment freshness must be verified independently.

## Previous public release: 0.42.2 — Technical Preview

This patch publishes the accepted MCP-definition and mode-navigation corrections.
It preserves the existing tool capabilities and full/compact distinction. It is a
pre-release, not stable/GA. The package remains `private: true` and is not published
to npm; the v0.42.0 and v0.42.1 tags and existing assets remain unchanged.

## Changes

- Qualify full-only tools referenced from compact-mode descriptions, including parameter and output-schema prose, with operator restart guidance. Preserve 35 default full tools, 16 compact tools, and 36 full tools with a configured verifier.
- Clarify tool selection, scoped read/write and review effects, record expansion parameters, maintenance and outcome behavior. Preserve callable names, validation constraints, output schema constraints and effect annotations.
- Correct compatibility documentation and identify the pinned local proxy gate as historical; do not change the proxy implementation.
- This metadata issue does not demonstrate an automatic-memory regression. Automatic-memory implementation and its accepted scope are unchanged; this patch does not repeat live memory validation.
- No new TDQS result is claimed by this release. A fresh Glama assessment, when available, is separate from release and deployment verification.

## Install and upgrade

Use Node 22.5+ and PowerShell 7+ for the documented Windows Codex workflow:

```powershell
npm install --global https://github.com/LiLara-AI/shadowgraph/releases/download/v0.42.2/shadowgraph-unified-plugin-0.42.2.tgz
```

Verify the downloaded tarball against `SHA256SUMS.txt` on the
[GitHub Release](https://github.com/LiLara-AI/shadowgraph/releases/tag/v0.42.2).
The [README](README.md#quick-start-windows-codex) covers the separate executor,
existing subscription and genuine owner consent. Installation alone does not enable
automatic memory. Stop active work and back up stores and the private integration
home before upgrading. Schema 7 is unchanged; changed source/executor/account
identity requires setup again, and older pending captures remain held rather than
being silently reassigned. See [upgrade and rollback](docs/migration.md).

## Scope and limitations

MCP names, validation rules, output schema constraints and effect annotations stay
compatible. Administrative capabilities remain full-only. Clearer prose adds metadata
bytes; this release is not a token-optimization or tool-choice benchmark claim.
The [compatibility guide](docs/mcp-compatibility.md) explains the supported workflows.

Automatic-memory behavior, project/account boundaries, sharing and recovery are
unchanged. The existing Windows Codex demonstration and limitations below remain
historical evidence, not a new live run. The Glama container provides credential-free
MCP; it cannot capture a user's Windows sessions. Publication, remote deployment and
a fresh TDQS assessment are distinct results; no score improvement is promised.

## Previous public release: 0.42.1 — Technical Preview

Automatic experience reuse for the installed **Windows Codex terminal wrapper**.
This is a pre-release, not stable/GA. The existing v0.42.0 tag and npm-unpublished
policy remain unchanged (`private: true`).

## Install and upgrade

Use Node 22.5+ and PowerShell 7+ for the demonstrated Windows workflow:

```powershell
npm install --global https://github.com/LiLara-AI/shadowgraph/releases/download/v0.42.1/shadowgraph-unified-plugin-0.42.1.tgz
```

Verify the downloaded tarball against `SHA256SUMS.txt` on the
[GitHub Release](https://github.com/LiLara-AI/shadowgraph/releases/tag/v0.42.1).
The [README](README.md#quick-start-windows-codex) covers the separate
`@openai/codex@0.161.0` executor, existing ChatGPT subscription, genuine one-time
owner consent and project enrollment. Installation alone does not activate memory.

Stop active work and back up each store and the private integration home before
upgrading. Schema 7 remains in use; changed source/executor/account identity requires
setup again. Older pending captures are held, not silently reassigned.
See [upgrade and rollback](docs/migration.md).

## Changes and demonstrated scope

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

Named host gaps: Codex desktop UI is not observed by this integration; fresh Claude Desktop automatic
coverage remains unproved. Existing Claude integration evidence does not establish full acceptance.
There is no comparative cost, speed or generalized superiority claim. Local package, MCP and
container results do not establish remote Glama indexing. The Glama surface is credential-free MCP;
it cannot capture a user's Windows Codex sessions by itself. Standing extraction requires the user's
separate setup consent; `private: true` and v0.42.0 remain unchanged.

Canonical memory stays local-first; selected capture/context data passes through the configured
provider. Each host turn is bounded to 120 seconds, with bounded background calls and retries.
Closing the wrapper leaves pending work for a later launch, not a permanent extraction daemon.
Native command results and user/assistant text are covered, not every native tool event.
See the [Codex guide](docs/codex-integration.md) and [issue tracker](https://github.com/LiLara-AI/shadowgraph/issues).
Never attach private stores, credentials, transcripts or review archives to public issues.

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
