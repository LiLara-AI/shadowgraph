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
