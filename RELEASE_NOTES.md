# ShadowGraph 0.41.0 — Technical Preview release notes

> Technical Preview / Early Access only — not Beta, not stable. Install from GitHub. The package
> remains `private: true` and is **not published to npm**. A Git tag `v0.41.0` and a GitHub Release
> for this version are maintainer-authorized; npm publication is **not** authorized and has not
> occurred.

ShadowGraph 0.41.0 keeps the decision-first graph and the scoped temporal memory introduced in
0.40.0, and adds first-class explainable reconsideration built on the same condition evaluator
`review()` already uses.

## Public-install workflow

During the Technical Preview, install from GitHub:

```bash
npm install --global github:LiLara-AI/shadowgraph
shadowgraph setup
shadowgraph doctor
shadowgraph stats
```

Installing the `v0.41.0` tag specifically:

```bash
npm install --global github:LiLara-AI/shadowgraph#v0.41.0
```

The npm command below is **not** valid and is not authorized. It becomes valid only once the
remaining gates in [`RELEASE_CHECKLIST.md`](https://github.com/LiLara-AI/shadowgraph/blob/main/RELEASE_CHECKLIST.md)
are approved and the package is published:

```bash
npm install --global shadowgraph-unified-plugin@0.41.0   # NOT AVAILABLE — returns E404
```

For a pre-publication review, replace the registry spec with the absolute path to the built `.tgz`
file:

```bash
npm install --global /path/to/shadowgraph-unified-plugin-0.41.0.tgz
shadowgraph setup
shadowgraph doctor
```

The exact unscoped name `shadowgraph-unified-plugin` returned HTTP 404 from the live npm registry on
2026-08-27 and was accepted by `npm pack`; availability must be rechecked immediately before any
future publication because registry names are first-come, first-served.

## What is new in 0.41.0

### First-class explainable reconsideration

`review()` answered one question — which decisions are due — and said nothing about the decisions it
passed over. A caller could not tell "checked, and nothing fired" from "could not check."

`reconsider()` gives the three readings the product actually needs:

| Verdict | When | Completeness |
| --- | --- | --- |
| `review_recommended` | At least one relevant rule definitely fired | `complete`, or `partial` when something else could not be settled |
| `unchanged` | Evaluation was complete and nothing fired | **always** `complete` |
| `manual_review` | Nothing definitely fired, but something could not be settled | **always** `partial` |

Each decision carries the evidence behind all three outcomes: `triggeredRules`, `triggeredBy`,
`groundedConditions` (the rules that definitely did *not* fire, so `unchanged` rests on stated
evidence rather than on an empty list), `rulesNotEvaluated`, `contestedConditions`,
`affectedAlternatives` and `factsConsidered`.

`decisionId` **fails closed**. An unknown id, an id belonging to another project, and a closed
decision are each an error rather than an empty result, because an empty `unchanged` + `complete`
for a mis-addressed decision reads exactly like a healthy one.

Nothing is written to decision status, confidence or lifecycle state, and no stored rule is
rewritten. A review signal is raised under the identity `review()` already uses, so reconsidering
twice settles on one signal and an acknowledgement holds. Key matching stays **literal**: a
near-miss key is `unknown`, never a match.

### Explicit evaluation completeness

`unchanged` is reported **only** with `evaluationCompleteness: 'complete'`. That pairing is the
contract's promise, and it is why an unevaluable condition can never be mistaken for a healthy
decision.

The **mixed case** — one rule fires while another is unknown — is `review_recommended` **and**
`partial`, with both sets of evidence visible so neither outcome hides the other.

`contestedConditions` is reported apart from `rulesNotEvaluated` because the evaluator did reach a
verdict there; calling that unevaluated would overstate it. It withholds completeness all the same,
since a verdict resting on facts that disagree is exactly the silent pass the review-conditions
contract exists to prevent. A contested condition is never also counted as a grounded negative.

### One shared three-valued condition evaluator

Reconsideration is a **projection of the same pass** `review()` runs, not a second evaluation. One
pass, one evaluator (`src/condition-eval.js`), one set of three-valued verdicts — `true`, `false`,
`unknown` — so the two routes cannot disagree about whether a stored rule fires, does not fire, or
cannot be evaluated.

A separate operator table on the reconsideration side is the specific defect this design exists to
make impossible: a rule using an operator only one route understood would report `unchanged` with
complete confidence on one route and a breach on the other. Agreement is proven operator by
operator, driven from the canonical `RULE_OPERATORS` export rather than a second list that could
drift.

A stored legacy free-text reopen rule that this evaluator cannot settle is now reported `unknown`
with a stated reason, rather than silently producing neither a due entry nor a diagnostic. The text
is preserved verbatim and never interpreted.

### Reconsideration on every surface

`shadowgraph_reconsider` is available in **both** MCP modes, plus `POST /reconsider` and
`shadowgraph reconsider` on the CLI.

Tool counts are derived from the tool catalogue and asserted by `npm run check:mcp`, not restated by
hand:

- **Full mode: 28 tools** (29 with an optional verifier configured).
- **Compact mode: 14 tools** — recommended, with the same full-fidelity stored graph.

Compact mode is a tool-advertisement choice, not lossy storage. To use all 28 tools, remove
`SHADOWGRAPH_MCP_COMPACT` or set it to `0`.

### Runtime-authoritative MCP session provenance

`sessionId` was caller-owned in every direction: two unrelated clients could claim the same one, and
a client that sent none left a `null` where the grouping belonged. The MCP server now mints one id
per process and records it on every write it performs, so writes from one MCP session are
attributable to that session by construction rather than by assertion.

A caller-supplied `sessionId` is still **accepted** — never an error, so no existing client breaks —
but it is superseded rather than merged, because asserted provenance does not outrank observed
provenance. This covers the per-operation `sessionId` inside an `applyMemoryPlan` batch too. `actor`
and `client` are untouched, CLI and HTTP callers are unaffected, and the field's type and default are
unchanged, so no migration is involved.

### Benchmark v1.1 infrastructure and preserved evidence

The v1.1 benchmark harness, its frozen preregistration and amendment chain, adapter and probe
infrastructure, and a sanitized evidence record are tracked in the repository so the methodology can
be read and reproduced. "v1.1" names the **benchmark methodology and candidate only**; it is not a
product release, and it carries no result.

Raw benchmark output is deliberately not tracked: `benchmark/results/**` is ignored, and the test
suite asserts its absence from both the Git index and the working tree.

### Repository hygiene

`npm run local:workspace:init` creates a workspace for raw development material **outside** the
repository, so handoffs, session state, backups, logs and private benchmark material are not one
forced `git add` from publication. `npm run local:workspace:status` reports where it resolves without
touching anything. Placing material there is manual; no repository command copies, moves, deletes or
rewrites raw data.

The public hygiene check now states what to do with a finding — preserve raw data outside the
repository and track only a sanitized copy — instead of leaving the developer to guess. The gate
reports, and never deletes, moves, sanitizes, backs up or rewrites anything.

## Also fixed in 0.41.0

- A rule that states no operand is `unknown` for **every** operator. Previously `not_equals`
  returned `true` against a missing operand, so a stored rule that said nothing read as a genuine
  breach and could raise a review signal.
- An absent operand is no longer persisted as `undefined`, which is not JSON and previously took
  `exportData()` and `context()` down for the whole graph. **Affects existing stored data:** such a
  graph becomes readable again, and that rule now reports `unknown` instead of a verdict.
- Legacy acknowledgement reconstruction fails closed on incomplete history rather than reusing an
  old acknowledgement for a breach it never covered.
- Returned condition details are copies, not aliases into stored state. Mutating a returned value
  previously rewrote canonical state with no journal entry.
- Legacy free-text `reusableWhen` conditions are counted rather than discarded, so an ALL is no
  longer an ALL over a subset. **Affects existing stored data:** an attempt previously reported
  reusable may no longer be.
- Stale MCP tool counts across the documentation and the CI label are corrected to the measured
  28 full / 14 compact.

See [`CHANGELOG.md`](https://github.com/LiLara-AI/shadowgraph/blob/main/CHANGELOG.md) for the
complete list.

## Compatibility

- Node.js 20, 22, and 24 are targeted on Windows and Linux.
- SQLite is optional and requires a Node release that provides `node:sqlite` (Node 22.5+); JSON
  remains the zero-dependency default.
- No runtime npm dependencies.
- MIT license.
- No schema version change in this release. `sessionId`'s type and default are unchanged, and no
  migration is required.

## Honest limits

- **No comparative benchmark result exists.** The retained seven-arm comparative run measured zero
  arms because no common local/free LLM and embedding endpoint was available. No arm was scored, no
  arm was ranked, and no arm is rank-eligible.
- **The non-scored acceptance run is valid for diagnostics only.** One acceptance run was executed
  on 2026-09-06 under an explicit `scored: false, rankings: false` authorization. It supports no
  comparison between arms. Its Phase-D decision-review diagnostic **did not demonstrate a
  decision-quality benefit**, and it is not offered as evidence of one. Its findings include
  negative results — most notably that a substantial share of units the harness recorded as
  measured did not produce a usable measurement under the frozen preregistration text — and those
  stand as recorded.
- **No comparative claim of any kind is made.** This release does not claim that ShadowGraph
  outperformed the control or any other arm, and makes no answer-quality, token, cost, latency,
  ranking, competitor-parity, `best`, or equivalent overall-superiority claim. Dependency
  installation and import probes are setup evidence only, never a benchmark win.
- Semantic retrieval is available only when embeddings are supplied or an embedding endpoint is
  explicitly configured; lexical fallback is never labelled semantic.
- No default LLM extractor, background file watcher, hosted cloud sync, or public-internet
  deployment model is included.
- Remote embeddings require an explicit privacy opt-in because memory and query text leave the
  machine.
- Confidence calibration remains unresolved. Optional verification is restricted to a separately
  configured local Ed25519 trust boundary and is not a general remote attestation system.
- An AI-assisted independent security review (Antigravity Assistant, Gemini 3.7 Flash) of commit
  `4a5e076` / tree `62c1918e` completed on 2026-08-30 with a PASS result and no unresolved findings.
  **No human third-party security audit has been performed**; the AI-assisted review is a control,
  not a substitute. See
  [`SECURITY.md`](https://github.com/LiLara-AI/shadowgraph/blob/main/SECURITY.md#security-review-status).
- **This remains a Technical Preview** with `private: true`. It must not be described as Beta,
  Stable, or Production Ready. The actual preregistered comparative measurement and the human
  third-party security audit remain open gates, and the `v0.41.0` tag and GitHub Release do not
  close either one.

The only preregistered marketing text allowed for the current benchmark evidence is:

> Comparative benchmark infrastructure was executed, but no arm was measured because no common
> local/free LLM and embedding endpoint was available. No comparative performance, quality, token,
> cost, or 'best' claim is supported.
