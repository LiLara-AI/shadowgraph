# ShadowGraph — Technical Preview announcement

Long-form announcement for GitHub, Reddit, or Hacker News. Developer-to-developer. Problem first.

Suggested titles:

- **Show HN: ShadowGraph — your agent remembers the answer, not why (Technical Preview)**
- **ShadowGraph: local-first decision memory for AI agents**
- **Your agent forgets why it decided things. I built a memory for that.**

---

Your AI agent made a good decision last month.

Today it remembers the answer — but not why.

## What that looks like in real work

You are three months into a project. You ask your agent why the service uses SQLite.

It tells you: "the project uses SQLite." Correct, and useless. Because the part you actually needed
is gone:

- **PostgreSQL was considered and rejected.** That never survived.
- **The reason it was rejected** — "single-user local deployment, not worth running a server" — gone.
- **What would change that answer** — nobody wrote down that going multi-user should reopen it.
- **What was already tried and failed** — "one SQLite file per user" broke cross-user reporting. The
  agent will cheerfully suggest it again next week.

So you re-litigate a decision that was already settled, because nobody can remember whether it was
settled *well*. And when the deployment finally goes multi-user, nothing anywhere notices that the
entire reason for the original choice just evaporated. The original decision may no longer fit — but
nothing flags it for another look.

If you have worked with agents for more than a few weeks, you have lived some version of this:

- the same design discussion, three times, because the reasoning was never written down;
- the same failed approach, retried, because failure was never recorded as failure;
- decisions that outlived their assumptions and nobody noticed;
- a new session starting from almost nothing, confidently.

The frustrating part is that the agent is not being stupid. It is being asked to reason from a
record that kept the conclusion and threw away everything that made it a decision.

Summarisation makes this worse, not better. A summary is optimised to keep the conclusion and drop
the reasoning — which is exactly backwards for this problem.

## What ShadowGraph does

ShadowGraph is **local-first decision memory for AI agents**.

Instead of storing the conversation, it stores the decision. Alongside the answer, it keeps:

- **decisions** — what was chosen, and how confident it was
- **rejected alternatives, and why they were rejected**
- **assumptions and evidence** the decision rested on
- **failed attempts**, with what actually happened
- **outcomes** — did it work, partly work, or fail
- **reconsideration conditions** — what would make this worth revisiting

That last one is the part that makes the rest useful. You record the trigger at the moment you
decide, while you still know what it is.

## The example

An agent picks a datastore for a small checkout service.

**It chooses SQLite.** PostgreSQL is rejected, and the reason is recorded with it: the deployment is
single-user and local, so running a database server isn't worth it. And a condition is attached — if
`deployment` ever becomes `multi-user`, look at this again:

```bash
shadowgraph decision '{"project":"checkout-service","title":"Choose the datastore","chosen":"SQLite","alternatives":[{"label":"PostgreSQL","reasonRejected":"Single-user local deployment does not justify running a server","reopenWhen":[{"key":"deployment","operator":"equals","value":"multi-user"}]}]}'

shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"single-user","sourceClass":"human_confirmed"}'
```

Weeks pass. Different sessions, different processes. Nobody remembers this rule exists.

**Then the deployment becomes multi-user:**

```bash
shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"multi-user","sourceClass":"human_confirmed"}'
```

**And the next time `review` runs, the old decision surfaces:**

```bash
shadowgraph review '{"project":"checkout-service"}'
```

```json
[
  {
    "decisionId": "decision_1788079304730_yjawcg",
    "title": "Choose the datastore",
    "reason": "deployment",
    "alternativesToReconsider": ["PostgreSQL"]
  }
]
```

Notice what is *not* in that last command: the fact that changed. When `review` runs, ShadowGraph
checks stored facts against stored reconsideration rules and surfaces decisions worth revisiting.
You call it — it does not run in the background — but you don't have to remember the rule, or
re-supply what changed. It works cold, in a fresh process, long after everyone forgot the rule was
there.

## Why this helps

In plain terms:

- **Decisions stop getting re-argued.** The reasoning is right there, so "why did we do it this way"
  has an actual answer.
- **Failed approaches are easier to avoid** because the previous failure and lesson are
  preserved.
- **Stale decisions are findable.** When the ground shifts, running `review` surfaces the
  decisions that depended on it, instead of leaving them to rot unnoticed.
- **A new session starts informed.** It can load what was decided and what was ruled out, rather
  than reconstructing it from vibes.

The goal is narrow and boring on purpose: important decisions should survive sessions, and stay
explainable and reviewable when they do.

## Try it

```bash
npm install --global github:LiLara-AI/shadowgraph
mkdir shadowgraph-demo && cd shadowgraph-demo
shadowgraph setup
shadowgraph doctor
```

The five-minute quick start and the full worked example:
<https://github.com/LiLara-AI/shadowgraph#quick-start--5-minutes>

Node 20+. No build step, no runtime dependencies, no account.

Everything stays in local storage on your machine. No cloud service, no telemetry, no
analytics, and no outbound request unless you configure one yourself.

You can use it through an **MCP stdio interface**, a **CLI**, a local **HTTP API**, or the
**JavaScript API**. MIT licensed.

**On Windows:** each command takes one JSON argument, so quoting differs. PowerShell wants
`'{\"project\":\"demo\"}'` and `cmd.exe` wants `"{\"project\":\"demo\"}"`. Both are documented.

## What I'd like feedback on

This is a **Technical Preview**, which mostly means I want to find out where it breaks for people
who aren't me. Most useful:

- **Installation problems** — anything between `npm install --global` and a green `doctor`.
- **MCP client compatibility** — which client, and what it did or didn't pick up.
- **Whether the memory is actually useful** — did recalled context change what your agent did? If it
  didn't, that is the most valuable report on this list.
- **Confusing workflows** — where the docs or a command shape sent you the wrong way.
- **Decision-memory cases I've missed** — things you wanted to record and couldn't.

There is no telemetry, so a report from you is the only signal there is.

- Bugs and features: <https://github.com/LiLara-AI/shadowgraph/issues>
- Questions and ideas: <https://github.com/LiLara-AI/shadowgraph/discussions>
- Security: <https://github.com/LiLara-AI/shadowgraph/security/advisories/new> (private, never a
  public issue)

## Honest limitations

Technical Preview / Early Access — not Beta, not stable.

- **Interfaces and the storage schema may still change.** Don't put data in it that you can't
  reproduce.
- **It's not on npm** — install from GitHub. That's deliberate for now.
- **No automatic extraction.** No background watcher, no default extractor. It records what you tell
  it to record.
- **No comparative benchmark has been measured.** I'm making no claim that ShadowGraph is faster,
  cheaper, lower-token, more accurate, or better than any other memory system. That measurement is
  deferred; the preregistration is frozen and hashed in the repo so it can't be quietly rewritten
  afterwards.
- **Single maintainer.** No paid support, no patch SLA, no bug bounty.

For the technically curious: 1204 tests, CI green on Ubuntu and Windows across Node 20, 22, and 24,
the strict official MCP Inspector gate in both tool modes, and a clean-install smoke test from a
packed tarball. Security posture and reporting are documented in
[`SECURITY.md`](https://github.com/LiLara-AI/shadowgraph/blob/main/SECURITY.md).

Repository: <https://github.com/LiLara-AI/shadowgraph> · MIT
