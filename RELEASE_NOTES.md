# ShadowGraph release notes

## Unreleased — Phase 1A

The **16-tool compact**, 20-tool workflow, and 35-tool full inventories remain unchanged. New MCP attempt writes require `resultClass`; CLI and JavaScript callers and older stored attempts retain the wording-based fallback when it is absent. MCP fact writes require fact `value`, and every decision alternative requires an alternative `label`, matching the existing runtime contracts. Structured condition schemas now describe canonical `key`/`value` fields and the `target`/`expected` aliases without dropping legacy or symbolic string rules.

Caller-safe MCP errors keep their era-specific locations: legacy JSON-RPC responses use `error.data`, while modern `CallToolResult` responses use `result._meta['shadowgraph/error']`. Unknown failures, including non-Error throws and non-string messages, retain the generic safe response.

## 0.44.0 — MCP Tool Disambiguation, Usability & Lifecycle Exposure

This release delivers comprehensive MCP tool disambiguation, full schema exposure of underlying engine lifecycle functions, safe domain error recovery, enhanced CLI ergonomics, and extensive visual documentation, while strictly maintaining the fixed 3-profile inventory invariants (Compact 16, Workflow 20, Full 35 / 36 with verifier).

## Key Highlights & Features

### 1. Complete MCP Schema Exposure & Function Alignment
Exposed previously hidden lifecycle, retry, search, and memory management capabilities directly across MCP schemas:
- `shadowgraph_record_attempt`: Expose `reusableWhen`, `relatedTo`, `task`, `tags`, and `visibility` in input schema; optional `task`, `tags`, `visibility` in attempt record output schema.
- `shadowgraph_record_decision`: Expose `status`, `supersedes`, `reviewAfter`, `failedAttempts`, `reason`, `changeSummary`, `task`, `tags`, and `visibility` in input schema; optional fields in record output schema.
- `shadowgraph_record_outcome`: Expose `autoTransition`, `decisionStatus`, and `lifecycleStatus` both inside the `outcome` object schema and as top-level MCP aliases.
- `shadowgraph_recall`: Expose inputs `includeHistory`, `includeCrossProject`, and `expandSynonyms`; expose `historyChain` on recall hit schema.
- `shadowgraph_context`: Expose `includeCrossProject` input on default context input schema; enrich `advisoryItemSchema` with optional fields (`sourceProject`, `crossProject`, `reusableNow`, `conditionSummary`, `changeSummary`, `summary`, `detail`, `score`, `title`, `chosen`, `solution`, `result`, `text`, `key`, `tags`).
- `shadowgraph_remember` & `shadowgraph_record_fact`: Expose `visibility`, `reason`, `changeSummary`, `allowHistorical`, and `backfill` (`validFrom`, `validTo`, `observedAt`, `tags`) with optional `visibility` and `changeSummary` on record schemas. Enforce `value` as required on `shadowgraph_record_fact`. Expose optional `reason` and `changeSummary` on `shadowgraph_supersede`.
- `shadowgraph_search` & `shadowgraph_retrieve`: Expose inputs `matchMode` (`'all' | 'partial' | 'any'`) and `expandSynonyms`; expose outputs `partialMatch`, `matchedTermCount`, `totalQueryTerms` on search hit schema.

### 2. Fixed Profile Invariants
- Preserved exact tool counts across all tiers: Compact 16, Workflow 20, Full 35 (36 with verifier).

### 3. Tool Description Alignment
- Synchronized tool descriptions with actual engine execution semantics:
  - Documented Arabic root/stemming support, 3+-term partial match fallback, and the role of `shadowgraph_recall`.
  - Documented symbolic condition operators (`>=`, `<=`, `==`, `!=`, `>`, `<`) and plain `changedFacts` keys for `reopenWhen` and `reusableWhen`.
  - Documented that decision lifecycle status remains unchanged unless `autoTransition` or `decisionStatus`/`lifecycleStatus` is supplied.

### 4. AI Error Recovery & Ergonomics
- **Safe Domain Error Recovery**: Replaced generic `Tool execution failed` with sanitized domain messages (`publicErrorDetails` / `PUBLIC_DOMAIN_MESSAGES`), strictly preventing leakage of filesystem paths and store internals.
- **Profile-Hidden Tool Guidance**: Provided structured guidance when tools outside the active Compact or Workflow profile are called, retaining JSON-RPC code -32601.
- **Consistent Project Defaulting**: Auto-defaults the `project` parameter across follow-up tools (`shadowgraph_record_outcome`, `shadowgraph_update_status`, `shadowgraph_confidence_evidence`, `shadowgraph_supersede`, `shadowgraph_link`, `shadowgraph_ack_review`, `shadowgraph_reconsider`, `shadowgraph_review_context`).
- **Parameter Aliases**: Accepted `reviewSignalId` as an alias for `id` in `shadowgraph_ack_review`, and accepted `target`/`expected` as aliases for `key`/`value` in rule conditions (rejecting conflicting definitions).

### 5. CLI Help, Wire Budgets & Visual Documentation
- **CLI Ergonomics**: Added `shadowgraph --help`, `-h`, and `help` commands (exiting code 0 on stdout); added helpful JSON parse error formatting; documented `SHADOWGRAPH_MCP_PROFILE=workflow` in `doctor`.
- **Wire Budgets**: Added `workflow` profile measurement to `scripts/mcp-wire-size.mjs`; re-calibrated `WIRE_BUDGETS` and `DESCRIPTION_TOTALS` in test metadata with ~2% measured headroom.
- **Visual Documentation**: Enhanced GitHub visual presentation with Mermaid diagrams for engine architecture, profile hierarchy, decision-to-attempt lifecycle loops, and consequential work patterns across `README.md`, `docs/mcp-compatibility.md`, and `integrations/agent-policy.md`.

## Verification & Compatibility

- All verification suites pass 100%: unit tests (`npm test`), E2E suite (`node --test test/e2e-mcp-disambiguation.test.js`), wire budgets (`npm run size:mcp`), MCP and Glama checks (`npm run check:mcp`, `npm run check:glama`), integration policies (`npm run check:integrations`), and clean package installation smoke (`npm run smoke:package`).
- The package remains `private: true`, unpublished to npm.

## Previous 0.43.4 release

# ShadowGraph 0.43.4 — MCP Interface & Usability Technical Preview

Tool descriptions in the MCP catalog now resolve the `shadowgraph_repair_plan`
unlink boundary, describe `shadowgraph_retrieve`'s single-pass ordered graph
expansion faithfully (`ordered graph neighbours` / `follows graph links in order`
without promising one-hop-only or complete transitive closure), and standardize
the advertised catalog on `review signals`. Opening clauses state upfront that
`shadowgraph_context` evaluates without saving signals and that
`shadowgraph_ack_review`, `shadowgraph_record_outcome` and
`shadowgraph_confidence_evidence` do not transition decision lifecycle status.

All functionality is retained: Full 35 (36 with a verifier), Compact 16 and
Workflow 20, with unchanged public names, schemas, handlers, permissions, wire
and character budgets (`11,670 / 11,700` Full, `6,722 / 7,000` Compact,
`12,019 / 12,050` Verifier) and truthful `destructiveHint` annotations. Automatic
capture, extraction, correction, sharing, schema 7 and declared host support are
unchanged. The package stays `private: true`, unpublished to npm. No new
live-memory or model-selection experiment is claimed, and no TDQS increase is
promised.

Stop every writer and privately back up the complete store and integration home
before upgrading. Follow the existing [migration and recovery guide](docs/migration.md).
Existing runtime/account setup boundaries and unsupported mixed Windows/WSL or
cross-host writers still apply. Earlier accepted tags and downloads are retained.

Glama's display label and MCP runtime version are independent. Verify the actual
build checkout, tree, runtime and advertised tools before treating a new listing
label as a runtime upgrade. See [MCP compatibility](docs/mcp-compatibility.md).

## Previous 0.43.3 release

# ShadowGraph 0.43.3 — MCP Guidance Technical Preview

Handshake MCP clients now receive the navigation and effect instructions that
modern discovery clients receive. Review tool definitions lead with the user's
intent and distinguish reading saved reminders from reevaluating conditions and
persisting signals. Acknowledgement guidance explicitly maps a returned
`reviewSignalId` to the required `id` argument.

All functionality is retained: Full 35 (36 with a verifier), Compact 16 and
Workflow 20, with unchanged public names, schemas, handlers, permissions and
truthful effect annotations. Reevaluation still commits a revision on repeats;
reads with an access key still persist their bounded audit. Automatic capture,
extraction, correction, sharing, schema 7 and declared host support are unchanged.
The package stays `private: true`, unpublished to npm. No new live-memory or
model-selection experiment is claimed, and no TDQS increase is promised.

Stop every writer and privately back up the complete store and integration home
before upgrading. Follow the existing [migration and recovery guide](docs/migration.md).
Existing runtime/account setup boundaries and unsupported mixed Windows/WSL or
cross-host writers still apply. The accepted v0.43.2 tag and downloads are retained.

Glama's display label and MCP runtime version are independent. Verify the actual
build checkout, tree, runtime and advertised tools before treating a new listing
label as a runtime upgrade. See [MCP compatibility](docs/mcp-compatibility.md).

## Previous 0.43.2 release

# ShadowGraph 0.43.2 — Closeout Technical Preview

This patch addresses reproduced remaining readiness defects. Schema 7, supported
Windows Codex wrapper and Claude CLI print-mode paths, privacy controls and tool
inventories are preserved. No new live-model evidence or workspace activation is
claimed. The package stays `private: true`, unpublished to npm.

## Closeout changes

- Require a locally supported user correction statement related to the accepted
  new choice. Fragment-only and unrelated proposals cannot retire an old decision;
  genuine corrections and history remain. This is not perfect semantic proof.
- Retry transient lock-release and JSON/SQLite backup/restore rename errors.
  Exhausted release errors preserve completed-operation results; original
  operation failures remain primary. Sync JSON candidates before replacement,
  without claiming directory or physical power-cut immunity.
- Retain valid spool input after I/O failures, record unreadable hook input with
  content-free gaps, and report loss-marker saturation as a lower bound. Unowned
  temporary files are ignored for capacity and preserved.
- Reject an explicitly configured empty HTTP token while keeping documented local
  optional-auth mode and Host/Origin protections.
- Keep acknowledgement's accurate Destructive hint. Existing-state replacements
  are potentially destructive even when journalled; no capability was removed or
  behavior changed to hide a warning. Full/Compact/Workflow remain 35 (36 with a
  verifier)/16/20.

Start with the [Windows beginner path](README.md#quick-start-windows-codex).
Existing users must stop every writer and privately back up the complete store
and integration home; follow [upgrade and recovery](docs/migration.md#moving-to-0432).
Changed runtime/account identity still needs owner setup; prior-setup captures
are held, never silently rebound. Local hard-link-capable storage is required;
mixed Windows/WSL, runtime versions and cross-host writers are unsupported.

Documented deterministic maintenance time and future-effective fact ordering are
retained. Confinement-proof refusals remain bounded to two attempts per item and
the existing usage budget; persistent host incompatibility can leave work pending.
Memory delivery does not guarantee model obedience. Desktop, interactive/resume
and other-platform parity remain unverified. The older fast-uri embedded in the
pinned gate SDK remains upstream-tracked: observed gates use local synthetic
schemas, and no consuming exploit was demonstrated. Earlier public tags and
assets are preserved. Verify Glama build/source/runtime identity independently;
the previously read-back 0.42.5 -> 0.43.1 mapping describes the earlier build.

## Previous 0.43.1 release

This patch verifies and repairs PR #50's destination-lock and capture-retry paths.
It includes the already-merged PR #50 redaction protection unchanged and the
accepted PR #51 MCP gate tooling maintenance. The package stays `private: true`,
unpublished to npm, and Technical Preview. Earlier tags and assets are preserved.

## Reliability changes

- A lock's PID token is complete before its exclusive publication. A writer paused
  during token creation cannot enter beside the next owner. PID liveness protects
  long-running owners without a heartbeat.
- Stale store locks are reclaimed one at a time with token-identity checking.
  Reclaim guards are not expired by age. A crashed reclaimer's orphan guard fails
  closed and needs recovery with every writer stopped.
- One hook tracks each spool key across all drain rounds, even when another hook
  renames that input after a failure. At most one failed attempt is counted for
  that input per hook. The eight-attempt bound, pending-work durability, restart
  replay, duplicate suppression and content-free loss reporting remain in place.

## Install and support

```powershell
npm install --global https://github.com/LiLara-AI/shadowgraph/releases/download/v0.43.1/shadowgraph-unified-plugin-0.43.1.tgz
```

Verify the package against `SHA256SUMS.txt` on the
[GitHub Release](https://github.com/LiLara-AI/shadowgraph/releases/tag/v0.43.1).
Stop every writer and back up private state first. Schema 7 is unchanged.
Local filesystems must support exclusive hard links; network/cross-host stores,
mixed Windows/WSL access and simultaneous old/new runtime writers are unsupported.
See [locking/retry limits and orphan-guard recovery](README.md#store-locking-and-retry-limits-0431)
and [upgrade guidance](docs/migration.md). Existing Windows Codex and Claude Code
print-mode support limits below remain unchanged. Linux CI tests do not establish
new live host/model support. No new live memory or model experiment was performed.

The MCP Full (35/36), Compact (16) and Workflow (20) definitions are unchanged.
Glama's credential-free Workflow container does not observe a user's host work;
its display label and the MCP runtime version are separate values.

## Deferred

Audit findings 4–18 and the previously declared bundled dependency follow-up are
outside this patch. Preserved redaction tests are regression checks, not a new
security audit or universal secret-removal guarantee.

## Previous release: 0.43.0 — Technical Preview

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
