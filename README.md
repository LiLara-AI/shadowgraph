# ShadowGraph

[![CI](https://github.com/LiLara-AI/shadowgraph/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LiLara-AI/shadowgraph/actions/workflows/ci.yml)

**Local-first decision memory for AI agents.** ShadowGraph remembers what an agent decided, what it
rejected, why it rejected it, and when that decision should be reconsidered.

> Status: **Technical Preview / Early Access.** Install from GitHub — it is not on npm.
> See [Limitations and Technical Preview status](#limitations-and-technical-preview-status).

## Why it matters

Chat memory remembers the conversation. It loses the decision.

Ask an agent three months later why the project uses SQLite and the useful part is already gone:

- The choice may survive in a summary. **The rejected alternative and the reason for rejecting it do not.**
- A fact changes — the deployment goes from single-user to multi-user — and **nothing reopens the decision.**
- The same approach fails again, because **the failed attempt was never recorded as a failed attempt.**

ShadowGraph stores that reasoning as structured, inspectable data instead of prose: what was chosen,
what was rejected, why, the assumptions and evidence behind it, failed attempts, outcomes,
provenance, confidence history, and the conditions that should trigger a rethink.

The promise is deliberately narrow: **important AI decisions should survive sessions and stay
explainable, reviewable, and reconsiderable.**

**Who it is for:** developers building agents on MCP, a CLI, or a local HTTP API who need
consequential decisions to outlive a session. It is a decision store, not a transcript store, and it
keeps everything on your machine.

## Quick Start — 5 minutes

### Requirements

- Node.js 20+ (the optional SQLite backend needs Node 22.5+ for `node:sqlite`)
- No runtime npm dependencies, no build step, no account, no network calls

### 1. Install

ShadowGraph is **not published to npm**. During the Technical Preview, install it from this
repository. A global install puts `shadowgraph` on your `PATH`, which is what MCP clients need:

```bash
npm install --global github:LiLara-AI/shadowgraph
```

<details>
<summary>Or clone and run from source</summary>

```bash
git clone https://github.com/LiLara-AI/shadowgraph.git
cd shadowgraph
npm install
node src/cli.js setup
node src/cli.js doctor
```

Replace `shadowgraph` with `node src/cli.js` in every command below.
</details>

> `npm install shadowgraph-unified-plugin` does **not** work and fails with `E404`. The package is
> `private: true` and unpublished, and the registry name is not reserved. This README will change if
> publication is ever approved.

### 2. JSON arguments and your shell

Every ShadowGraph command takes a single JSON argument, so **quoting depends on your shell.** Pick
the row for the shell you are actually using — this is the most common reason a first command fails:

| Shell | Form | Example |
| --- | --- | --- |
| bash / zsh / Git Bash (macOS, Linux, WSL) | single quotes, plain JSON | `shadowgraph recall '{"project":"demo"}'` |
| Windows PowerShell | single quotes, `\"` inside | `shadowgraph recall '{\"project\":\"demo\"}'` |
| Windows `cmd.exe` | double quotes, `\"` inside | `shadowgraph recall "{\"project\":\"demo\"}"` |

The examples below use the bash form. All three are tested on every command in this README.

### 3. Initialize a store

```bash
mkdir shadowgraph-demo
cd shadowgraph-demo
shadowgraph setup
shadowgraph doctor
```

`setup` creates `.shadowgraph/data.json` in the current directory, so run it where you want the
store to live. It never rewrites an existing store. `doctor` then checks Node compatibility, storage
readability and writability, graph validity, and the MCP entry point.

Run `setup` **before** `doctor`: on a fresh directory `doctor` reports `Storage is not initialized`
and exits `1` until a store exists. That is expected, not a failed install.

### 4. Record a decision, restart, and get it back

```bash
shadowgraph decision '{"project":"checkout-service","title":"Choose the datastore","chosen":"SQLite","confidence":0.8,"alternatives":[{"label":"PostgreSQL","reasonRejected":"Single-user local deployment does not justify running a server","reopenWhen":[{"key":"deployment","operator":"equals","value":"multi-user"}]}]}'

shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"single-user","sourceClass":"human_confirmed","confidence":1}'

shadowgraph search '{"query":"datastore","project":"checkout-service"}'
```

Each command runs in a new process and reopens the store from disk, so the `search` result comes
back across a real restart, not from in-memory state. You now have a decision that carries its
rejected alternative, the reason it was rejected, and the condition that should reopen it.

## The demo: a decision that reopens itself

This is the whole point of ShadowGraph, in three commands. Continue in the same directory.

**The decision is settled, so there is nothing to reconsider yet:**

```bash
shadowgraph review '{"project":"checkout-service"}'
```

```json
[]
```

**Now the world changes. The deployment becomes multi-user:**

```bash
shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"multi-user","sourceClass":"human_confirmed","confidence":1}'
```

**Restart and ask again — passing only the project, never the triggering fact:**

```bash
shadowgraph review '{"project":"checkout-service"}'
```

```json
[
  {
    "decisionId": "decision_1788079304730_yjawcg",
    "title": "Choose the datastore",
    "reason": "deployment",
    "alternativesToReconsider": [
      "PostgreSQL"
    ]
  }
]
```

ShadowGraph read the stored fact, matched it against the rule saved with the decision, and surfaced
the alternative that had been rejected for a reason that no longer holds. Your decision IDs will
differ; nothing else does.

That is decision memory: not "what did we talk about", but **"what did we decide, what did we rule
out, and does that still hold?"**

For the same story through MCP, the HTTP API, and the JavaScript API — plus recording failed
attempts and outcomes — see the [decision-memory demo](docs/decision-memory-demo.md).

## Key capabilities

**Decision memory.** Decisions carry the chosen approach, rejected alternatives with their reasons,
assumptions, evidence, and structured `reopenWhen` rules. Outcomes (successful, mixed, failed,
unknown) feed back into confidence.

**Reconsideration.** `review()` evaluates reopen rules against *stored* facts, so it works after a
restart without the caller re-supplying what changed. Review signals are persisted and
acknowledgeable.

**Failed-attempt memory.** Attempts record the approach, the result, the environment, and the
lesson, so an agent can discover that something was already tried and why it did not work.

**Provenance you can audit.** Every claim carries a `sourceClass` — `agent_claimed`,
`tool_observed`, `human_confirmed`, or `production_verified` — which records *what was claimed*
about an observation's origin, never proof of it. Ordinary tool input cannot create `verified`; that
requires a separately configured Ed25519 verifier.

**Scoped memory and temporal recall.** `remember()` / `recall()` store preferences, profiles, goals,
instructions, procedures, episodes, and notes under a project plus optional `userId` / `agentId` /
`runId`. Facts, memories, and relations are bi-temporal, so you can ask what was true `asOf` a past
moment. Retrieval fuses lexical, vector, graph-distance, and temporal signals and declares which
signals were unavailable rather than silently degrading.

**Project and scope isolation.** Omitted project and scope mean the `default` project and all-null
scope — never every project or every user. Purge is previewable, logical by default, and explicitly
irreversible in hard mode.

**Explainable retrieval.** Results expose raw scores, ranks, and reasons, and every bounded response
declares its total, pages, and omitted scope. Nothing is silently summarized away.

## Local-first and privacy

Everything is a local file. The HTTP server binds to `127.0.0.1` and rejects non-local browser
origins. There is no cloud service, no account, no telemetry, and no analytics — ShadowGraph makes
no outbound network request unless you explicitly configure one.

The two opt-ins that can send data off the machine are both off by default:

- **Embeddings.** No endpoint is configured. A localhost OpenAI-compatible server works once
  configured; a remote endpoint additionally requires `SHADOWGRAPH_ALLOW_REMOTE_EMBEDDINGS=1`,
  because that means memory and query text leave your machine.
- **Markdown export.** `markdown-sync` writes plaintext copies you control. ShadowGraph cannot find
  or delete those copies later — see [Storage, backup, and deletion](#storage-backup-and-deletion).

For shared local use, set a Bearer token:

```bash
SHADOWGRAPH_API_TOKEN="use-a-random-token-at-least-16-characters" shadowgraph serve
```

Then send `Authorization: Bearer use-a-random-token-at-least-16-characters` with every request. This
is defense in depth for a local deployment, not a public-internet security model. See
[SECURITY.md](SECURITY.md).

## Interfaces

### MCP

```bash
shadowgraph mcp
```

Compact mode is recommended: it advertises 12 workflow tools while the full graph, memories, facts,
alternatives, and outcomes stay stored at full fidelity. Compact mode is a tool-advertisement
choice, not lossy storage.

```bash
SHADOWGRAPH_MCP_COMPACT=1 shadowgraph mcp
```

The 12 compact tools are `shadowgraph_context`, `shadowgraph_remember`, `shadowgraph_recall`,
`shadowgraph_record_decision`, `shadowgraph_record_attempt`, `shadowgraph_record_fact`,
`shadowgraph_record_outcome`, `shadowgraph_retrieve`, `shadowgraph_search`, `shadowgraph_review`,
`shadowgraph_validate`, and `shadowgraph_maintain`. Full mode advertises 27 — see the
[MCP compatibility guide](docs/mcp-compatibility.md) for the complete inventory, both protocol
revisions, and verified client behaviour.

### AI tool setup

Install globally first so the client can find `shadowgraph` on its `PATH`:

```bash
npm install --global github:LiLara-AI/shadowgraph
shadowgraph setup
shadowgraph doctor
```

**Claude Code** (user scope):

```bash
claude mcp add --scope user --env SHADOWGRAPH_MCP_COMPACT=1 --transport stdio shadowgraph -- shadowgraph mcp
```

**Cursor** (`.cursor/mcp.json` or `~/.cursor/mcp.json`):

```json
{"mcpServers":{"shadowgraph":{"type":"stdio","command":"shadowgraph","args":["mcp"],"env":{"SHADOWGRAPH_MCP_COMPACT":"1"}}}}
```

**Codex**:

```bash
codex mcp add shadowgraph --env SHADOWGRAPH_MCP_COMPACT=1 -- shadowgraph mcp
```

**Hermes Agent**:

```bash
hermes mcp add shadowgraph --command shadowgraph --connect-timeout 30 --env SHADOWGRAPH_MCP_COMPACT=1 --args mcp
```

Verified file forms for all four live in [`integrations/`](integrations/README.md). Set an absolute
`SHADOWGRAPH_FILE` in the client environment when one store must be shared across working
directories.

### CLI

The commands you will actually use:

```bash
shadowgraph setup
shadowgraph doctor
shadowgraph context '{"project":"my-app"}'
shadowgraph decision '{"project":"my-app","title":"Choose the datastore","chosen":"SQLite"}'
shadowgraph fact '{"project":"my-app","key":"deployment","value":"local","sourceClass":"human_confirmed"}'
shadowgraph attempt '{"solution":"Rewrite everything","result":"Regression"}'
shadowgraph outcome '{"decisionId":"DECISION_ID","outcome":{"status":"failed","lessons":["Assumption was wrong"]}}'
shadowgraph review '{"project":"my-app"}'
shadowgraph search '{"query":"database","project":"my-app"}'
shadowgraph remember '{"project":"my-app","memoryType":"preference","key":"editor","text":"Prefers VS Code"}'
shadowgraph recall '{"project":"my-app","query":"development environment"}'
```

<details>
<summary>Full command list</summary>

`setup` · `doctor` · `serve` · `mcp` · `stats` · `list` · `search` · `retrieve` · `recall` ·
`remember` · `markdown-sync` · `context` · `review` · `maintain` · `signals` · `ack` · `validate` ·
`repair-plan` · `backup` · `restore` · `decision` · `attempt` · `fact` · `outcome` · `status` ·
`link` · `traverse` · `redact` · `supersede` · `purge-preview` · `purge` · `journal` · `rebuild` ·
`confidence-evidence`

Full argument shapes are in the [API reference](docs/api-reference.md).
</details>

### HTTP API

```bash
shadowgraph serve
curl http://127.0.0.1:8787/health
```

A read-only dashboard is served at `http://127.0.0.1:8787/dashboard`. It talks only to the same
local origin, and a token entered there is kept in page memory only — never in cookies, local
storage, or ShadowGraph data.

<details>
<summary>All HTTP endpoints</summary>

```text
GET  /health                 GET  /stats               GET  /records
GET  /search?q=&project=     GET  /review-signals      GET  /validate
GET  /journal

POST /decisions              POST /attempts            POST /memories
POST /recall                 POST /facts               POST /outcomes
POST /review                 POST /context             POST /status
POST /relationships          POST /traverse            POST /redact
POST /supersede              POST /maintain            POST /retrieve
POST /review-signals/ack     POST /repair-plan         POST /backup
POST /restore                POST /rebuild             POST /confidence-evidence
POST /projects/purge-preview

DELETE /projects
```

`/redact` returns a privacy-safe export and never mutates. `/repair-plan` is always non-destructive
and returns `{apply:false, actions:[...]}`. `/projects/purge-preview` shows deletion counts without
changing storage. The server returns `401` when token auth is enabled and missing, `403` for
disallowed browser origins, `404` for missing decisions or routes, and `413` for oversized bodies.
</details>

### JavaScript

```js
import { createShadowGraph } from 'shadowgraph-unified-plugin';

const graph = createShadowGraph();
graph.addDecision({
  project: 'checkout-service',
  title: 'Choose the datastore',
  chosen: 'SQLite',
  confidence: 0.8,
  alternatives: [{
    label: 'PostgreSQL',
    reasonRejected: 'Single-user local deployment does not justify running a server',
    reopenWhen: [{ key: 'deployment', operator: 'equals', value: 'multi-user' }]
  }]
});
graph.addFact({
  project: 'checkout-service',
  key: 'deployment',
  value: 'multi-user',
  sourceClass: 'human_confirmed',
  confidence: 1
});

// review() reads stored facts, so this also works in a fresh process after an
// export/save and load. Do not pass the triggering fact again.
console.log(graph.review({ project: 'checkout-service' }));
```

The bare-specifier import resolves when ShadowGraph is a dependency of your project
(`npm install github:LiLara-AI/shadowgraph`). With a `--global` install, use the CLI, HTTP, or MCP
surfaces instead, or import from the installed path.

## Storage, backup, and deletion

JSON is the zero-dependency default and stores a versioned graph in `.shadowgraph/data.json`. Set
`SHADOWGRAPH_FILE` to relocate it. Set `SHADOWGRAPH_STORAGE=sqlite` on Node 22.5+ for the WAL-backed
relational adapter. Current exports use schema 5; schemas 1 through 4 remain importable.

State and journal are written in one atomic operation, every save and restore for a destination
shares a cross-process lock fence, and a stale write is rejected with a revision conflict rather
than silently lost. `backup` takes a consistent snapshot; `restore` validates domain and journal
consistency before replacing live state, and rolls back on failure. This is process-level rollback
safety, **not** a claim of crash or power-loss durability. The full guarantees — lock timeouts,
stale-lock recovery, revision arithmetic, and restore artifact reporting — are in the
[API reference](docs/api-reference.md#4-storage) and the
[SQLite restore contract](docs/contracts/sqlite-restore-contract.md).

Deletion is explicit and previewable:

```bash
shadowgraph purge-preview '{"project":"release-demo"}'
shadowgraph purge '{"project":"release-demo"}'
shadowgraph purge '{"project":"another-project","mode":"hard"}'
```

Logical purge (the default) removes project content from the live projection and keeps an auditable,
payload-free purge skeleton. Hard purge physically deletes journal entries, creates a declared gap,
and cannot be undone.

**Purge cannot delete external Markdown exports.** ShadowGraph has no way to find plaintext copies
in arbitrary workspaces, Git history, cloud sync, backups, or removable media. Delete those
separately.

## Limitations and Technical Preview status

ShadowGraph 0.40.0 is a **Technical Preview / Early Access** release. It is not Beta and not stable.

- **Interfaces and the storage schema may still change.** Do not use it for data you cannot
  reproduce.
- **Not on npm.** The package is deliberately `private: true`. No npm publication, Git tag, or
  GitHub release has been created, and none is authorized.
- **No comparative benchmark has been measured.** Comparative benchmark infrastructure was executed,
  but no arm was measured because no common local/free LLM and embedding endpoint was available. No
  comparative performance, quality, token, cost, or 'best' claim is supported. ShadowGraph makes no
  claim of being faster, cheaper, lower-token, more accurate, or better than any other memory
  system. See the [benchmark report](docs/benchmark-report.md).
- **Security review status.** An AI-assisted independent security review of commit `4a5e076` (tree
  `62c1918e`) was completed on 2026-08-30 by Antigravity Assistant (Gemini 3.7 Flash), with a PASS
  result and no unresolved findings. **No human third-party security audit has been performed.** See
  [SECURITY.md](SECURITY.md#security-review-status).
- **No default extractor, background watcher, or hosted sync.** ShadowGraph records what you tell it
  to record.
- **Single maintainer.** No paid support, no patch SLA, and no bug bounty.

## Feedback and support

Technical Preview feedback is the point of this release. Please tell us when something breaks.

| What | Where |
| --- | --- |
| Bug or incorrect behaviour | [Open a bug report](https://github.com/LiLara-AI/shadowgraph/issues/new?template=bug_report.yml) |
| Feature or capability request | [Open a feature request](https://github.com/LiLara-AI/shadowgraph/issues/new?template=feature_request.yml) |
| Security vulnerability | [Report it privately](https://github.com/LiLara-AI/shadowgraph/security/advisories/new) — never in a public issue |
| Questions, ideas, "is this useful?" | [Discussions](https://github.com/LiLara-AI/shadowgraph/discussions) |

During the preview, these reports are the most valuable:

- **Installation problems** — anything between `npm install --global` and a green `doctor`.
- **MCP client compatibility** — which client, which mode, and what it did or did not discover.
- **Memory usefulness** — did recalled context actually change what your agent did?
- **Confusing workflows** — where the docs or a command shape sent you the wrong way.
- **Missing decision-memory use cases** — decisions you wanted to store and could not.
- **Performance** — where it felt slow, and roughly how large the store was.

ShadowGraph has no telemetry and collects nothing automatically, so a report from you is the only
signal there is. When pasting output, redact anything private: decision and memory content is your
data, and `shadowgraph doctor` output is usually enough.

## Documentation

| Document | What it covers |
| --- | --- |
| [Decision-memory demo](docs/decision-memory-demo.md) | The full worked example through CLI, MCP, HTTP, and JavaScript |
| [API reference](docs/api-reference.md) | JavaScript, CLI, HTTP, and MCP surfaces |
| [Unified memory guide](docs/unified-memory.md) | `remember` / `recall`, scoping, temporal recall, Markdown sync |
| [MCP compatibility](docs/mcp-compatibility.md) | Protocol revisions, tool inventory, verified client behaviour |
| [Contracts](docs/contracts) | Authoritative guarantees: provenance, lifecycle, journal, completeness, search, confidence, SQLite restore |
| [Architecture decisions](docs/adr) | ADR-0006 (memory kernel), ADR-0007 (journal baseline placement) |
| [Vision and principles](docs/vision-and-principles.md) | What ShadowGraph is for, and what it deliberately will not do |
| [Benchmark report](docs/benchmark-report.md) | Honest results — no arm was measured; no comparative claim is supported |
| [Security policy](SECURITY.md) | Threat model, review status, and how to report a vulnerability privately |
| [Contributing](CONTRIBUTING.md) | Development setup and pull-request expectations |
| [Changelog](CHANGELOG.md) | Release history |

## Checks

```bash
npm run check
npm test
npm run check:integrations
npm run check:mcp
npm audit --omit=dev
npm run check:package
npm run smoke:package
```

GitHub Actions covers Ubuntu and Windows on Node 20, 22, and 24. SQLite gates run only where
`node:sqlite` exists. The strict official MCP Inspector runs full and compact gates, and the package
smoke test runs from a real clean install in every matrix cell.

## License

MIT. See [LICENSE](LICENSE).
