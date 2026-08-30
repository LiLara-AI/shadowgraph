# ShadowGraph 0.40.0 — Technical Preview release notes

> Technical Preview / Early Access only — not Beta, not stable. Install from GitHub; the package remains `private: true`, and no npm publication, Git tag, or GitHub release has been created.

ShadowGraph 0.40.0 keeps the decision-first graph and adds scoped temporal memory, explainable hybrid recall, durable reconsideration, compact/full MCP modes, and inspectable Markdown workflows.

## Public-install workflow

During the Technical Preview, install from GitHub:

```bash
npm install --global github:LiLara-AI/shadowgraph
shadowgraph setup
shadowgraph doctor
shadowgraph stats
```

The npm command below becomes valid only once the remaining gates in [`RELEASE_CHECKLIST.md`](https://github.com/LiLara-AI/shadowgraph/blob/main/RELEASE_CHECKLIST.md) are approved and the package is published:

```bash
npm install --global shadowgraph-unified-plugin@0.40.0   # NOT YET AVAILABLE — returns E404
```

For a pre-publication review, replace the registry spec with the absolute path to the built `.tgz` file:

```bash
npm install --global /absolute/path/to/shadowgraph-unified-plugin-0.40.0.tgz
shadowgraph setup
shadowgraph doctor
```

The exact unscoped name `shadowgraph-unified-plugin` returned HTTP 404 from the live npm registry on 2026-08-27 and was accepted by `npm pack`; availability must be rechecked immediately before publication because registry names are first-come, first-served.

## Highlights

- Project/user/agent/run-scoped `remember` and `recall` workflows with retained versions and explicit `ADD`, `UPDATE`, `DELETE`, and `NOOP` outcomes.
- Bi-temporal memories, facts, and relations with historical `asOf` recall.
- Explainable lexical/vector/graph/temporal candidate union and weighted RRF; unavailable semantic signals are declared rather than relabelled.
- Durable remember → restart → recall and changed-fact → restart → review workflows through CLI, HTTP, JSON/SQLite, and MCP.
- MCP stdio entry point through `shadowgraph mcp`; compact mode is recommended with `SHADOWGRAPH_MCP_COMPACT=1` (12 tools), while full mode remains available (27 tools without the optional verifier).
- `shadowgraph setup`, `shadowgraph doctor`, and `shadowgraph serve` for an installed package.
- Local dashboard at `http://127.0.0.1:8787/dashboard`, with optional token entry kept only in page memory.
- Logical project purge by default and explicit irreversible hard purge. Canonical purge cannot delete external Markdown exports, Git history, cloud copies, or backups.

## Compatibility

- Node.js 20, 22, and 24 are targeted on Windows and Linux.
- SQLite is optional and requires a Node release that provides `node:sqlite` (Node 22.5+); JSON remains the zero-dependency default.
- No runtime npm dependencies.
- MIT license.

## Honest limits

- The current seven-arm comparative run measured zero arms because no common local/free LLM and embedding endpoint was available. Dependency import probes are setup evidence only, not benchmark wins. This candidate makes no competitor-parity, answer-quality, cost, latency, token, ranking, `best`, or equivalent overall-superiority claim.
- No default extractor, background watcher, hosted sync, or public-internet deployment model is included.
- Remote embeddings require an explicit privacy opt-in because memory and query text leave the machine.
- An AI-assisted independent security review (Antigravity Assistant, Gemini 3.7 Flash) of commit `4a5e076` / tree `62c1918e` completed on 2026-08-30 with a PASS result and no unresolved findings. **No human third-party security audit has been performed**; the AI-assisted review is a control, not a substitute. See [`SECURITY.md`](https://github.com/LiLara-AI/shadowgraph/blob/main/SECURITY.md#security-review-status).
- This remains a Technical Preview with `private: true` until the actual preregistered comparative measurement and the human third-party security audit are complete and approved. The measured local journal benchmark does not replace either gate.

The only preregistered marketing text allowed for the current benchmark evidence is:

> Comparative benchmark infrastructure was executed, but no arm was measured because no common local/free LLM and embedding endpoint was available. No comparative performance, quality, token, cost, or 'best' claim is supported.
