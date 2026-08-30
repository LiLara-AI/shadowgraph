# ShadowGraph — short announcement copy

Ready-to-post variants. **No superiority claims anywhere**: no faster, cheaper, lower-token, more
accurate, better than Mem0/Graphiti, or "best". No comparative benchmark has been measured.

Every variant must keep three things true: Technical Preview, install from GitHub (not npm), and no
comparative claim.

---

## X / Twitter

**Primary (single post):**

> Your agent remembers it chose SQLite.
> It does not remember it rejected PostgreSQL, why, or that "single-user" was the reason.
>
> ShadowGraph is local-first decision memory: what was chosen, what was rejected, why, and when to
> reconsider. When the deployment goes multi-user, it reopens the decision.
>
> Technical Preview, MIT, no telemetry:
> github.com/LiLara-AI/shadowgraph

**Thread version:**

> 1/ Agent memory is mostly chat memory. Good at "what did we talk about". Bad at "why did we decide
> this, and does it still hold?"

> 2/ Three months later: the choice survives in a summary. The rejected alternative, the reason, and
> the failed attempts are gone. So the agent re-suggests the thing that already broke.

> 3/ ShadowGraph stores the decision as data: chosen option, rejected alternatives *with reasons*,
> assumptions, evidence, failed attempts, outcomes, provenance — and rules for when to reconsider.

> 4/ You attach the rule when you decide:
> reopenWhen: deployment == "multi-user"
>
> Months later the fact changes. `shadowgraph review` returns the decision and names PostgreSQL as
> the alternative to revisit. You never pass the fact back in — it reads stored state.

> 5/ Local-first: one file on your machine. No cloud, no account, no telemetry. MCP + CLI + HTTP.
> Node 20+, zero runtime deps.

> 6/ Technical Preview, so: schema may change, not on npm (install from GitHub), and no comparative
> benchmark has been measured — I'm making no claim about being better than any other memory system.
>
> github.com/LiLara-AI/shadowgraph

**Compact (under 280 chars):**

> ShadowGraph: local-first decision memory for AI agents. Remembers what was rejected and why, and
> reopens the decision when the facts change. MCP + CLI + HTTP, no telemetry, MIT.
> Technical Preview: github.com/LiLara-AI/shadowgraph

---

## LinkedIn

> **Why does your AI agent forget its own reasoning?**
>
> Most agent memory stores the conversation. That answers "what did we discuss". It does not answer
> the question that actually costs teams time: *why did we decide this, and does that reason still
> hold?*
>
> A concrete case. An agent picks SQLite over PostgreSQL because the deployment is single-user and
> local. Three months later the deployment goes multi-user. The original choice is now wrong — and
> nothing anywhere notices, because the rejected alternative and the reason for rejecting it were
> never stored as data.
>
> I've been building ShadowGraph to close that gap. It's a local-first decision memory for AI agents.
> Alongside the decision, it records what was rejected, why, the assumptions and evidence, the
> attempts that failed, the outcome, and the conditions that should trigger a rethink. When a stored
> fact later matches one of those conditions, the decision comes back for review — across restarts,
> with no prompting from the caller.
>
> It runs entirely on your machine: no cloud service, no account, no telemetry. It speaks MCP, so it
> plugs into Claude Code, Cursor, Codex, and similar clients, and it also has a CLI and a local HTTP
> API.
>
> This is a Technical Preview / Early Access release, and I want to be precise about what that means:
> the schema may still change, it is installed from GitHub rather than npm, and **no comparative
> benchmark has been measured** — I am making no claim that it outperforms any other memory system.
> What is verified is 1204 tests passing and CI green on Linux and Windows across Node 20, 22, and 24.
>
> If you're building agents and you've watched one confidently re-propose something that already
> failed, I'd genuinely like your feedback.
>
> github.com/LiLara-AI/shadowgraph (MIT)
>
> #AI #AIAgents #MCP #OpenSource #LocalFirst

---

## Reddit intro

*Suitable for r/LocalLLaMA, r/mcp, r/AI_Agents, r/programming. Adjust the first line per subreddit.*

**Title:** ShadowGraph — local-first decision memory for AI agents (Technical Preview, MIT)

> Agent memory is mostly chat memory: store messages, embed, retrieve something similar. That's fine
> for "what did we talk about" and poor at the thing that actually bites.
>
> Three months into a project, ask why the service uses SQLite. A summary might still say "we chose
> SQLite". What's gone is that PostgreSQL was rejected, that the reason was "single-user local
> deployment", that nobody recorded what would change that answer, and that "one SQLite file per
> user" was already tried and broke cross-user reporting. So the deployment goes multi-user and
> nothing notices the original reason evaporated.
>
> ShadowGraph stores the decision instead of the conversation: chosen option, rejected alternatives
> **with their reasons**, assumptions, evidence, failed attempts, outcomes, provenance, and
> `reopenWhen` rules.
>
> The part I actually care about:
>
> ```bash
> # months earlier, the rule was saved with the decision
> shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"multi-user","sourceClass":"human_confirmed"}'
> shadowgraph review '{"project":"checkout-service"}'
> ```
>
> ```json
> [{"decisionId":"decision_...","title":"Choose the datastore","reason":"deployment","alternativesToReconsider":["PostgreSQL"]}]
> ```
>
> The `review` call doesn't get told what changed. It evaluates stored rules against stored facts, so
> it works cold, in a fresh process.
>
> Local-first: one file on your machine, no cloud, no account, no telemetry, no outbound request
> unless you configure one. MCP (12 compact / 27 full tools), CLI, and a local HTTP API. Node 20+,
> zero runtime dependencies, MIT.
>
> **Technical Preview caveats, up front:** schema and interfaces may still change; it's installed
> from GitHub, not npm (`private: true` on purpose); and **no comparative benchmark has been
> measured** — the harness ran but no arm was measurable without a common local LLM+embedding
> endpoint, so I'm making no claim about being faster, cheaper, or better than Mem0, Graphiti, or
> anything else. The preregistration is frozen and hashed in the repo so it can't be quietly
> rewritten later. An AI-assisted security review passed; no human audit has been done.
>
> What's verified: 1204 tests, CI green on Ubuntu + Windows across Node 20/22/24, strict official MCP
> Inspector gate, real clean-install smoke test.
>
> I'd especially like to hear about install problems, MCP clients that don't behave, and cases where
> recalled memory didn't actually change what your agent did.
>
> https://github.com/LiLara-AI/shadowgraph

---

## Discord / Slack developer communities

**Short drop-in:**

> Been working on **ShadowGraph** — local-first decision memory for AI agents. It stores what an
> agent decided *and* what it rejected, why, plus rules for when to reconsider. Change a fact months
> later and `review` hands you back the decision with the rejected alternative to revisit — no
> prompting, works cold after restart.
>
> MCP + CLI + HTTP, one local file, no telemetry, Node 20+, MIT.
>
> Technical Preview — install from GitHub (not on npm), schema may change, and no comparative
> benchmark has been measured so I'm not claiming it beats anything. Would love feedback on install
> and MCP client compatibility: <https://github.com/LiLara-AI/shadowgraph>

**One-liner:**

> ShadowGraph (Technical Preview): local-first decision memory for agents — remembers the rejected
> option and why, and reopens the decision when facts change. MCP/CLI/HTTP, MIT.
> <https://github.com/LiLara-AI/shadowgraph>

---

## Wording rules for any new variant

**Never write:** better than · faster than · cheaper · lower-token · more accurate · outperforms ·
beats Mem0/Graphiti · the best · production-ready · stable · Beta · "available on npm".

**Always keep:** Technical Preview / Early Access · install from GitHub · local-first, no telemetry ·
no comparative benchmark measured.

If a benchmark claim is ever needed, the only approved sentence is:

> Comparative benchmark infrastructure was executed, but no arm was measured because no common
> local/free LLM and embedding endpoint was available. No comparative performance, quality, token,
> cost, or 'best' claim is supported.
