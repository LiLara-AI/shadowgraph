# Contributing to ShadowGraph

Thank you for helping improve ShadowGraph.

ShadowGraph is in **Technical Preview**, so reports about what is confusing or broken are as
valuable as code.

## Where to send what

| What | Where |
| --- | --- |
| Bug or incorrect behaviour | [Bug report](https://github.com/LiLara-AI/shadowgraph/issues/new?template=bug_report.yml) |
| Feature or capability request | [Feature request](https://github.com/LiLara-AI/shadowgraph/issues/new?template=feature_request.yml) |
| Security vulnerability | [Private advisory](https://github.com/LiLara-AI/shadowgraph/security/advisories/new) — never a public issue. See [SECURITY.md](SECURITY.md). |
| Questions, ideas, usage feedback | [Discussions](https://github.com/LiLara-AI/shadowgraph/discussions) |

Preview feedback that helps most: installation problems, MCP client compatibility, whether recalled
memory actually changed what your agent did, confusing workflows, decision-memory use cases you
could not express, and performance with a store size.

**Redact before pasting.** Decision and memory content is your data. `shadowgraph doctor` output is
usually enough, and never paste tokens or private paths.

## Development

Requirements:

- Node.js 20 or newer (SQLite paths need Node 22.5+ for `node:sqlite`)
- Python 3.10+ only for the optional Hermes adapter check

Install and run checks:

```bash
npm install
npm run check
npm test
```

The project uses Node's built-in test runner and has no runtime dependencies.

Note that every CLI command takes one JSON argument, and quoting differs by shell:

| Shell | Form |
| --- | --- |
| bash / zsh / Git Bash | `node src/cli.js recall '{"project":"demo"}'` |
| Windows PowerShell | `node src/cli.js recall '{\"project\":\"demo\"}'` |
| Windows `cmd.exe` | `node src/cli.js recall "{\"project\":\"demo\"}"` |

## Before opening a pull request

Run the full gate set locally:

```bash
npm run check
npm test
npm run check:integrations
npm run check:mcp
npm audit --omit=dev
npm run check:package
npm run smoke:package
```

`npm run check` includes `check:public-hygiene`, which audits the tracked tree. Run it alone with
`npm run check:public-hygiene`.

## Public repository hygiene

This repository is public. Everything tracked here is readable by anyone, including files that are
never packaged — `npm run check:package` audits the published tarball, so it cannot see them.

The policy is **preserve locally, sanitize publicly, block accidental publication**. Raw internal
data is useful and must not be destroyed to satisfy a gate; it simply belongs outside the
repository. No tool in this repository deletes, moves or rewrites your local material.

- Public commits must not include local usernames, absolute machine paths, backup locations,
  session transcripts, scratch artifacts or secrets.
- Internal operational handoffs and debug notes containing machine information stay **outside** the
  repository, in the local workspace described below. Only sanitized, product-relevant handoff
  information is tracked under `docs/`.
- Tracked documentation uses sanitized placeholders: `<repo-root>`, `<user-home>`,
  `<local-backup-path>`.
- Tracked files anywhere in the repository — tests, docs, scripts, notes — are named after the
  behaviour or subject they cover, not the agent, person or tool involved in producing them:
  `rule-operand-regressions.test.js`, not a tool name; no `docs/<tool>-notes.md` or
  `<tool>-review.md`. The same applies to scratch-directory prefixes and prose. A tool name alone
  is fine where it names real product surface (`integrations/claude-code.mcp.json`), and a process
  word alone is fine (`review-conditions.test.js`); it is the two together in one filename that
  marks a development artefact, and that is what the guard reports.
- Do not add automated-assistant attribution or trailers to public release history unless the
  repository owner explicitly requests it. No `Co-Authored-By` for an assistant, no `Generated-By`,
  and no session metadata in public commit messages.
- A public merge or release requires **both** gates: tree hygiene and history hygiene.
- Legitimate technical references and research citations are not prohibited. Documenting a client
  ShadowGraph genuinely supports, naming an environment variable such as `ANTHROPIC_API_KEY`
  without a value, or citing published research is expected and must not be stripped. This policy
  removes development-process attribution, not product or research references.

Tree hygiene runs in `npm run check`. History hygiene is separate because it depends on a base ref
and on branch topology, so it runs at merge/release time:

```bash
node scripts/check-public-hygiene.mjs --history-base origin/main \
  --identity "LiLara-AI <253868849+LiLara-AI@users.noreply.github.com>"
```

Both modes are **read-only**. They report a path, a line number and a category, and never delete,
move, sanitize or back up a file, and never touch Git history. Acting on a finding is your
decision, and the first step is to keep the raw copy, not to remove it.

## The local workspace

Raw and internal development material lives **outside** the Git repository, in a local workspace
that is never a Git product artifact and is never initialized as a Git repository.

```bash
npm run local:workspace:init      # create the external workspace and its categories
npm run local:workspace:status    # read-only: where it resolves and what exists
```

Where it resolves:

- `SHADOWGRAPH_LOCAL_WORKSPACE`, if set. A relative value is resolved against the working
  directory, and the result must be outside the repository: the repository root itself and any
  path inside it are refused, by canonical path comparison rather than string matching, so a
  symlink cannot smuggle the workspace back in.
- Otherwise the repository's sibling directory `shadowgraph-local`, which is outside the checkout
  on every platform and needs no machine-specific configuration.

Never record the resolved absolute path in a tracked file, a test fixture, a committed log or a
commit message. The commands print it; that is where it stays.

```text
shadowgraph-local/
  handoffs/           raw operational handoffs
  backups/            local backups
  sessions/           tool and session working data
  logs/               debugging logs
  raw-evidence/       full-fidelity evidence
  benchmark-private/  private benchmark working material
  agent-work/         agent scratch state
  machine-notes/      machine-specific notes, local paths and configuration
```

**Putting material there is manual in this release.** Copy it in with your shell or file manager,
into whichever category fits. No command in this repository copies, moves, deletes, renames or
rewrites your material, and nothing keeps an index of it: what is in the workspace is what you put
there. A public copy that needs sanitizing is never a reason to destroy the raw original.

There is deliberately no automated preservation command. Copying a file into an external directory
safely on every supported platform — while the filesystem underneath may be concurrently
substituted — needs machinery out of proportion to a convenience you can get from `cp`, so the
release ships resolution, initialization and reporting instead, and leaves the copy to you.

`init` refuses the repository root and any path inside it by canonical, symlink-resolved comparison,
and checks every directory it would create and the README for a symlink, a Windows junction or a
hardlink **before** it creates anything — so a workspace it refuses is a workspace it did not touch.
It creates only what is missing, never overwrites an existing README, and never creates Git
metadata. Repeating it is safe. `status` only reads.

The local tool and handoff directories named in `.gitignore` stay there: they are a fallback
protection against an accidental `git add`, and nothing already inside them should be deleted. But
an ignored directory **inside** the repository is not the preferred storage architecture — material
kept there is one `git add -f` or one edited ignore rule away from publication. Put raw material in
the external local workspace instead.

## Raw evidence and public evidence

| | Raw / internal evidence | Public evidence |
| --- | --- | --- |
| Where | Outside the repository, in the local workspace | Tracked, only when intentionally public |
| Fidelity | Full, unabridged | Sanitized |
| Machine paths | Allowed | Never: no local usernames, home paths or backup locations |
| Operational metadata | Allowed | Removed |
| Private debugging context | Allowed | Removed |

Measurements and substantive evidence must not be silently altered when a public copy is prepared:
sanitation removes identifying and operational detail, never the finding. And a public copy needing
sanitation is never a reason to destroy the raw original — preserve it, then publish the sanitized
version.

## Agents, tools and handoffs

This policy is tool-neutral and applies to every assistant, agent, editor or script, without
per-tool files or per-tool directories in the repository.

- Raw operational handoffs, scratch state, transcripts and session working data are placed by hand
  in the local workspace (`handoffs/`, `sessions/`, `agent-work/`), not in the repository.
- A handoff is tracked under `docs/` only when it is genuinely useful project documentation, and
  then it must be public-safe and sanitized.
- Do not add tool-specific policy files or tool-specific public handoff directories.

## Pull requests

- Keep the core vendor-neutral.
- Add or update tests for behavior changes. Do not weaken or skip existing tests.
- Do not commit `.shadowgraph/data.json`, credentials, generated files, or `__pycache__`.
- Keep integration templates explicit about assumptions and product-specific behavior.
- Preserve local-only defaults (`127.0.0.1`) unless a change includes authentication and
  threat-model documentation.
- Do not add telemetry, analytics, or any default outbound network call.
- Do not add comparative performance, quality, cost, or superiority claims. No comparative
  benchmark has been measured; see the [benchmark report](docs/benchmark-report.md).
