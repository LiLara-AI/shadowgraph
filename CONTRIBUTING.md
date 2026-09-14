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

- Public commits must not include local usernames, absolute machine paths, backup locations,
  session transcripts, scratch artifacts or secrets.
- Internal operational handoffs and debug notes containing machine information stay **outside** the
  repository, or in an ignored local directory such as `.local-handoff/`. Only sanitized,
  product-relevant handoff information is tracked under `docs/`.
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
