# ShadowGraph — short announcement copy

Ready-to-post variants. Every one of them leads with the **problem**, not the technology.

The core message, in one line:

> Agents shouldn't just remember what they decided. They should remember *why* — and know when that
> decision deserves another look.

**No superiority claims anywhere**: no faster, cheaper, lower-token, more accurate, better than any
named alternative, or "best". No comparative benchmark has been measured.

---

## X / Twitter

**Primary (single post):**

> Your agent made a good call last month.
>
> Today it remembers the answer — but not why. Not what it rejected, not the reason, not what
> already failed.
>
> So you re-argue settled decisions, and old ones quietly outlive their assumptions.
>
> ShadowGraph is local-first decision memory for agents:
> github.com/LiLara-AI/shadowgraph

**Thread version:**

> 1/ Your AI agent made a good decision last month. Today it remembers the answer — but not why.

> 2/ Ask it why the project uses SQLite. It'll tell you the project uses SQLite. Gone: that
> PostgreSQL was rejected, that the reason was "single-user deployment", and that someone already
> tried one-file-per-user and broke reporting.

> 3/ So you re-argue decisions that were already settled. The same approach fails twice. And when
> the deployment goes multi-user, nothing notices that the reason for the original choice just
> evaporated.

> 4/ ShadowGraph stores the decision instead of the conversation: what was chosen, what was
> rejected, why, the assumptions, what failed, the outcome — and what should make you look again.

> 5/ You record the trigger when you decide:
> reopenWhen: deployment == "multi-user"
>
> Months later the fact changes. Run `review` and ShadowGraph checks stored facts against stored
> rules, and hands the decision back with PostgreSQL flagged.

> 6/ Local-first: local storage on your machine. No cloud, no account, no telemetry. MCP, CLI, HTTP, JS.
> Node 20+, MIT.
>
> Technical Preview — install from GitHub, schema may still change, and no comparative benchmark has
> been measured.
>
> github.com/LiLara-AI/shadowgraph

**Compact (under 280 chars):**

> Your agent remembers what it decided. Not why, not what it rejected, not what already failed.
>
> ShadowGraph is local-first decision memory for agents. Run `review` and it surfaces the decisions
> worth revisiting. Technical Preview:
> github.com/LiLara-AI/shadowgraph

---

## LinkedIn

> **Your AI agent made a good decision last month. Today it remembers the answer — but not why.**
>
> If you have worked with AI agents for any length of time, this will be familiar. You ask why a
> project made a particular choice, and you get the choice back. What you actually needed is gone:
> which alternatives were considered, why they were rejected, what assumptions the decision rested
> on, and what had already been tried and failed.
>
> The cost shows up as ordinary friction. The same design discussion happens three times, because
> the reasoning was never written down. The same approach gets retried, because failure was never
> recorded as failure. Each new session starts from an incomplete picture and sounds confident
> anyway.
>
> And the expensive version: a decision outlives its own assumptions. A team picks SQLite because
> the deployment is single-user and local, and PostgreSQL is rejected for exactly that reason.
> Months later the deployment becomes multi-user. The original reasoning no longer holds — but
> nothing anywhere notices, so the decision quietly stays in place until someone trips over it.
>
> That is the problem I have been working on. ShadowGraph is local-first decision memory for AI
> agents. Alongside the decision, it keeps the rejected alternatives and the reasons for rejecting
> them, the assumptions and evidence, the attempts that failed, the outcome, and — importantly — the
> conditions that should make the decision worth revisiting. When you run a review, ShadowGraph
> checks stored facts against those stored conditions and surfaces the decisions worth revisiting —
> across restarts and sessions, without you re-supplying what changed.
>
> In practice that means settled decisions stop getting re-argued, failed approaches are easier to
> avoid because the previous failure and lesson are preserved, and decisions whose assumptions have
> changed can be found instead of rotting unnoticed.
>
> It runs entirely on your machine — no cloud service, no account, no telemetry — and works through
> MCP, a CLI, a local HTTP API, or a JavaScript API.
>
> This is a Technical Preview, and I want to be precise about that: the schema may still change, it
> installs from GitHub rather than npm, and no comparative benchmark has been measured, so I am
> making no claim that it outperforms any other memory system.
>
> If you build with agents and you have watched one confidently re-propose something that already
> failed, I would genuinely value your feedback.
>
> github.com/LiLara-AI/shadowgraph (MIT)
>
> #AI #AIAgents #MCP #OpenSource #LocalFirst

---

## Reddit intro

*Suitable for r/LocalLLaMA, r/mcp, r/AI_Agents, r/programming. Adjust the first line per subreddit.*

**Title:** Your agent remembers what it decided, but not why — so I built decision memory for it

> Three months into a project, ask your agent why the service uses SQLite. It'll tell you the service
> uses SQLite. Technically correct, completely useless.
>
> What's gone is everything that made it a decision: that PostgreSQL was considered and rejected,
> that the reason was "single-user local deployment, not worth running a server", that nobody wrote
> down what would change that answer, and that "one SQLite file per user" was already tried and
> broke cross-user reporting.
>
> So you get the failure modes everyone building with agents knows:
>
> - the same design argument, three times, because the reasoning was never stored;
> - the same failed approach retried, because failure was never recorded as failure;
> - decisions that outlive their assumptions with nothing to flag them;
> - new sessions starting from an incomplete picture, confidently.
>
> Summarisation makes it worse. A summary keeps the conclusion and drops the reasoning, which is
> exactly backwards here.
>
> **ShadowGraph stores the decision instead of the conversation** — what was chosen, what was
> rejected *with the reason*, the assumptions and evidence, what already failed, the outcome, and the
> conditions that should trigger another look.
>
> The part I actually care about. When the decision is made, you attach the trigger:
>
> ```
> reopenWhen: deployment == "multi-user"
> ```
>
> Then weeks later, in a completely different session:
>
> ```bash
> shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"multi-user","sourceClass":"human_confirmed"}'
> shadowgraph review '{"project":"checkout-service"}'
> ```
>
> ```json
> [{"decisionId":"decision_...","title":"Choose the datastore","reason":"deployment","alternativesToReconsider":["PostgreSQL"]}]
> ```
>
> The `review` call is never told what changed. It matches stored conditions against stored facts, so
> it works cold, in a fresh process, long after everyone forgot the rule existed.
>
> Local-first: local storage on your machine, no cloud, no account, no telemetry, no outbound request
> unless you configure one. MCP, CLI, local HTTP API, and a JavaScript API. Node 20+, no runtime
> dependencies, MIT.
>
> **Technical Preview caveats, up front:** schema and interfaces may still change; it installs from
> GitHub rather than npm; and **no comparative benchmark has been measured**, so I'm making no claim
> about being faster, cheaper, or better than anything else in this space. That measurement is
> deferred and the preregistration is frozen and hashed in the repo so it can't be quietly rewritten
> later.
>
> I'd especially like to hear about install problems, MCP clients that don't behave, and cases where
> recalled memory didn't actually change what your agent did.
>
> https://github.com/LiLara-AI/shadowgraph

---

## Discord / Slack developer communities

**Short drop-in:**

> Anyone else hit this — your agent remembers *what* it decided but not *why*? No record of what it
> rejected, why it rejected it, or what already failed. So the same discussion happens three times
> and old decisions hang around after their assumptions stop being true.
>
> Been building **ShadowGraph** for it: local-first decision memory for agents. It keeps the rejected
> alternatives and reasons, and you attach a condition when you decide — change the fact months later
> and `review` hands the decision back with the alternative flagged. Works cold after a restart.
>
> Local storage on your machine, no telemetry. MCP + CLI + HTTP + JS, Node 20+, MIT.
>
> Technical Preview — from GitHub, not npm, and no comparative benchmark measured yet. Feedback on
> install and MCP client compatibility very welcome: <https://github.com/LiLara-AI/shadowgraph>

**One-liner:**

> Your agent remembers the answer, not why. ShadowGraph is local-first decision memory for agents —
> keeps the rejected option and the reason, and surfaces decisions worth revisiting when you run a
> review. Technical Preview, MIT: <https://github.com/LiLara-AI/shadowgraph>

---

## Wording rules for any new variant

**Lead with the problem.** The reader should recognise their own week in the first two sentences
before ShadowGraph is named. Never open with architecture, tooling, test counts, CI, or security.

**Never write:** better than · faster than · cheaper · lower-token · more accurate · outperforms ·
beats [any named product] · the best · production-ready · stable · Beta · "available on npm".

**Never discuss** how the project was built, what tooling was used to build or review it, or
security-review internals. Security posture belongs in `SECURITY.md`, not in launch copy.

**Always keep:** Technical Preview / Early Access · install from GitHub · local-first, no telemetry ·
MIT · no comparative benchmark measured (brief, and below the main message).

If a benchmark claim is ever needed, the only approved sentence is:

> Comparative benchmark infrastructure was executed, but no arm was measured because no common
> local/free LLM and embedding endpoint was available. No comparative performance, quality, token,
> cost, or 'best' claim is supported.
