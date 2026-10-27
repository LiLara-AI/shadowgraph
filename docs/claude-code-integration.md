# Claude Code CLI: automatic experience memory

This guide covers ShadowGraph's native Claude Code hooks on **Windows, Claude Code CLI 2.x (2.1.288 or later)**. After a one-time setup:
- ordinary sessions are captured;
- captured work is extracted into decisions, attempts and memories by a separate, owner-selected Claude model;
- fresh sessions receive that experience at start and with relevant prompts.

Claude Desktop, the interactive TUI's resume flows and other platforms are outside what this guide's evidence covers. See [Support and evidence](#support-and-evidence).

## How it works

| Step | What runs | Notes |
| --- | --- | --- |
| Capture | `capture --hook` on UserPromptSubmit, PostToolUse, PostToolUseFailure, Stop, PreCompact and SessionEnd | Each event is redacted and kept in an owner-only spool before the store is touched (see below). |
| Extraction | Spawned after Stop or SessionEnd as a detached one-shot worker | It runs `claude -p` as a **separate executor**, with no tools, MCP servers, hooks, skills or settings, on the model you selected. It never shares the host session's process. |
| Delivery | `deliver --hook` on SessionStart and UserPromptSubmit | SessionStart delivers the project's working set, each record as its line (the full record only when the line would drop a decisive part). A prompt receives what is relevant to it. |
| Sharing | `shadowgraph sharing …` | Project-only by default. |

The host assistant and the extractor are separate roles. The host can be any model you use. The extractor model is chosen once, at activation.

### Durable capture

A hook that meets a busy store (another writer, the extraction worker, a long delivery read) no longer loses the event:
1. The hook redacts the event's material fields and writes the event to `<SHADOWGRAPH_HOME>\capture-spool\` before it asks for the store. A tool's input and response are redacted by the same credential rules the stored text uses. The spool is owner-only and is never written inside a repository, however its path resolves. Each entry also names the store and origin it was kept for.
2. One hook at a time holds the drain. It writes every waiting event oldest first, its own included, so a session's events reach the store in order. A hook that finds the drain taken leaves its event to the drainer, which lists the spool again before it stops.
3. When the store stays busy, the events wait for the next hook. An entry kept for another store or origin (after a re-activation) is never written; it is dropped with a marker.
4. An entry leaves the spool only once the store has decided it: written, already held, refused, or not capturable.
5. Contention never counts as a failure. Other failures count attempts, and an entry is dropped after 8 attempts or 7 days. A content-free marker in `capture-dropped\` records when, why, which event and which session.
6. Delivery reports `capture_input_waiting` (with `inputWaiting` and `oldestInputAt`) and `capture_input_dropped` (with `inputDropped`) in its `processing` line.
7. Host events with identifiers (prompts, tool calls, session end) are written once however often they are replayed. A Stop replayed after a crash between write and removal is marked `possibleDuplicateOf`, not removed.
8. A tool call that touches the spool or the drop markers is ShadowGraph's own traffic and is not captured.

### Extraction on current hosts

Two host profiles exist:
- **Pinned** (2.1.288, and the traced 2.1.292 binary with its host-validation receipt). These run as before, with `claude-opus-5[1m]`.
- **Runtime evidence** (`claude-code-runtime-evidence-v1`). Every other 2.x host from 2.1.288 on runs on this profile, with a model you select explicitly: `claude-haiku-5-5`, `claude-sonnet-5-5` or `claude-opus-5-5`. Every invocation streams the host's own account of the session (`--output-format stream-json --verbose`). The output is used only when:
  - the init event lists no tool but `StructuredOutput`, and no MCP server, slash command, skill or non-builtin plugin;
  - `apiKeySource` is `none`;
  - the model and host version are the ones checked;
  - no hook ran;
  - no tool but `StructuredOutput` was called;
  - every usage entry is `firstParty`.

  Anything else is `runtime_confinement_unverified`, and nothing is recorded. The host may update in place; the executable path, model and account stay bound to the activation.

Managed policy is never bypassed:
- A system `managed-settings` file or folder, or a registry policy, refuses extraction (`managed_policy_present`).
- So does a remote policy cache larger than 5 bytes, unless the pinned 2.1.292 profile applies.
- A cache of at most 5 bytes can hold no setting (at most `{}`), so it is not counted. The host writes such a cache for accounts it reports ineligible for remote managed settings. Only its size is read; the file is never opened.

The runtime-evidence profile runs the quoted recipe with corrections:
- Fields quote the source exactly.
- A later user message that explicitly corrects an earlier user decision proposes a correction. The kernel then supersedes the earlier decision and keeps its history. This also holds when the earlier decision was kept verbatim as the user's message.

### Which sessions are extracted

- A Claude Code CLI session names no account in its hooks. Its material is bound to the extraction activation only when all of these hold:
  - it runs under your default profile, with no `CLAUDE_CONFIG_DIR` or `CLAUDE_CODE_OAUTH_TOKEN`;
  - it has no provider-route variables (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_*`);
  - the CLI's current sign-in, as its `.claude.json` names it, is the account bound at activation. A keyed digest is compared and nothing is kept.

  A session after switching the default login to another account stays unbound. The activation also checks its account with `claude auth status` before every model call.
- A Desktop-hosted session names its account (`CLAUDE_CODE_USER_EMAIL`), and only the bound account's sessions are bound.
- Sessions under another profile are refused before capture. Sessions on their own provider route are captured but stay unbound and are not extracted.

### Budgets and throughput

Extraction makes one model call per capture item, within the frozen worker budgets: 4 items and 4 calls per drain, 12 calls per rolling hour, and a 240 s wall time per worker. A worker that stops at its per-drain limit, or sees a trigger that arrived while it ran, runs another bounded round, so no trigger is lost.

A short coding session produces about 10 items, so roughly one such session per hour is extracted promptly. Under heavier use the queue lags, and the delivery `processing` line shows the backlog (`pending`, `oldestPendingAt`).

## One-time setup

All commands use the pinned runtime's `src\cli.js`. The pinned runtime is installed from a reviewed commit with `node scripts\install-runtime.mjs --commit <sha>`. Outside a scratch location, each command that changes configuration asks you to confirm at a terminal.

```powershell
$rt = "$env:USERPROFILE\.shadowgraph\runtime\<commit>\src\cli.js"
$store = "$env:LOCALAPPDATA\ShadowGraph\memory.json"   # private, outside every repository
$env:SHADOWGRAPH_FILE = $store
node $rt setup
node $rt install-hooks --runtime (Split-Path (Split-Path $rt))
node $rt install-hooks --capture --runtime (Split-Path (Split-Path $rt))
node $rt activate delivery --evidence <note> --store $store --runtime (Split-Path (Split-Path $rt))
node $rt activate capture  --evidence <note> --store $store --runtime (Split-Path (Split-Path $rt)) [--only <project,...>]
# In each project you want captured, once:
node $rt bind '{\"project\":\"<name>\"}'          # answer: worktree, then confirm
node $rt activate extraction --evidence <note> --store $store --runtime (Split-Path (Split-Path $rt)) `
  --executable "$env:USERPROFILE\.local\bin\claude.exe" --model claude-haiku-5-5 --no-overage-confirmed true
```

Choose the least costly model that extracts your work adequately. Re-activating with another model is an ordinary owner change.

## Everyday commands

| Command | Purpose |
| --- | --- |
| `shadowgraph extract --status` | Queue counts, blocked reasons and worker status |
| `shadowgraph capture inspect` | Capture items, sessions and retention |
| `shadowgraph sharing status` | Current sharing mode and grant |
| `shadowgraph sharing selected --projects a,b [--expires <ISO>]` | Share these projects' memory with every bound project |
| `shadowgraph sharing all-permitted [--exclude a]` | Share every bound project's memory, less those excluded |
| `shadowgraph sharing project` | Back to project-only; revokes the grant in the store |
| `shadowgraph deactivate extraction\|capture\|delivery` | Turn a capability off; extraction waits for its worker to stop |

Sharing uses one CLI grant with the Codex route's meaning. A revoked or expired grant leaves each project reading only its own memory. Hook reads under a grant are not audited in the store, because delivery never writes. Issue and revocation are audited.

## Troubleshooting

| Reason | Meaning |
| --- | --- |
| `capture_input_waiting` | Events wait in the spool for a busy store. They replay at the next hook. |
| `capture_input_dropped` | Events were lost. Read `capture-dropped\` for when and why. |
| `managed_policy_present` | An administrator policy source exists. Extraction does not run. |
| `model_not_selectable` | The model does not belong to the host's profile. Select a current model on a current host. |
| `restriction_switch_unavailable` | The host lacks a required switch (including `--verbose` on the runtime-evidence profile). |
| `runtime_confinement_unverified` | The host's own stream showed something other than the confined session. The output was discarded. |
| `activated_account_changed` | `auth status` names a different account than the one bound at activation. |

## Known limits

These limits were found by independent review or by the live proof, and are not closed:
- **Account.** A CLI hook carries no session identity. The binding uses the CLI's sign-in when the hook runs, so if the default login is switched back and forth during a running session, the hook judges by the login it sees.
- **Order.** Events are written oldest first by one drainer, with two gaps:
  - an event whose spool write is still in progress, for milliseconds, is not yet visible to a concurrent drain;
  - when the spool itself cannot be written, an event takes the direct path and can land ahead of waiting ones.
- **Waiting input.** A hook that reaches its deadline with entries still in the spool leaves them for the next hook. They are durable and reported as `capture_input_waiting` until then.
- **Destination.** An entry names its store path and origin, not the store's identity. A store deleted and recreated at the same path while entries wait receives them.
- **Sharing.** A crash between issuing a grant and saving the activation record, or a failed rollback, can leave a live grant the record does not name. It expires at its `--expires` time (30 days by default) and is listed by `shadowgraph access status`, where `shadowgraph access revoke <id>` removes it.
- **Hand-off.** A trigger is answered if the running worker exits within 5 seconds of its last check. A worker stalled longer leaves the request to the next trigger. Every Stop sends one.
- **Throughput.** Extraction makes one model call per capture item within 12 calls per hour (see Budgets).
- **Order behind a block.** A session's items are extracted in order. An item whose output is refused twice, or one blocked by the route itself, stays pending, and so do the items after it, until a later trigger (normally the next Stop). Delivery reports them as pending, and the executor's specific reason is reported only as `executor_blocked`.
- **Host exit on Windows (observed, cause not established).** In the live proof, `claude -p` printed its result at Stop but did not exit until the extraction worker it had started finished: about 2 minutes, up to the worker's 4-minute wall time. When no worker could run (its fence held), the host exited at once. Host work is not blocked, but the process can exit late.
- **A user's decision kept as memory.** The extractor may propose a user's decision with fields that the claim verifier cannot establish as exact, unqualified quotations. The decision is then kept as the user's whole message, verbatim, as a memory: faithful, delivered and searchable, but not a decision. This happened to the Arabic decision in the live proof and to a one-sentence English one. The English decision frame does not read Arabic, and a sentence quoting code with dots in it (`Math.round(...)`) can defeat it in English too.
- **Corrections and verbatim decisions.** A user's correction supersedes an earlier user decision, whether it was structured as a decision or kept verbatim as a memory (above). The memory keeps its text; its validity is closed and it links to the correcting decision. An assistant's or a tool's memory is never a correction target.
- **Replay time.** An event that waited in the spool carries the time it was written to the store as `observedAt`, not the time its hook received it. Order is kept.

## Support and evidence

Verified live (2026-10-27) on Windows 11 with Claude Code CLI **2.1.302** in print mode (`claude -p`, stream-json), host model `claude-haiku-5-5`, extractor `claude-haiku-5-5` then `claude-sonnet-5-5`, on synthetic projects and fresh stores:

| Function | Result |
| --- | --- |
| Capture under a held store lock (25 s) and a held worker fence | Host work completed; delivery reported waiting input; every event reached the store once, in order; none dropped |
| Automatic extraction after Stop | Ran without any command; Sonnet kept a decision with the rejected alternative and the reason, quoted; Haiku did so in one of two runs |
| Recovery of pending extraction | Items left pending by a held worker were extracted by the next session's trigger |
| Fresh session receives experience | SessionStart delivered the decision with its rejected alternative to a fresh session (Arabic prompt) |
| Fresh session uses experience | Asked in English what was already decided, a fresh session answered from the delivered records alone. On the Arabic coding task it wrote the right parser first, but never referred to the earlier work, so use there is not shown |
| Correction | An English user correction superseded a user decision, with history. An Arabic decision kept verbatim as memory could not be superseded in the first run; that is fixed, and verified in the second run below |
| Sharing | `selected`, `all-permitted` (with `--exclude`) and `project` changed what another bound project receives; each change revoked the previous grant |

Not verified: Claude Desktop, the interactive TUI, resume flows, macOS and Linux hosts, and languages other than English and Arabic. Desktop support is not inferred from these CLI tests. The review package accompanying the change keeps executed, inferred and untested results apart.
