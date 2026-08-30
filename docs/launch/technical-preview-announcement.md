# ShadowGraph — Technical Preview announcement

Long-form announcement for GitHub, Reddit, or Hacker News. Developer-focused. No superiority claims.

Suggested titles:

- **Show HN: ShadowGraph — local-first decision memory for AI agents (Technical Preview)**
- **ShadowGraph: my agent forgets *why* it chose things, so I built a decision graph for it**
- **[Technical Preview] ShadowGraph — remember what an agent rejected, and why, not just what it chose**

---

## The problem

Agent memory today is mostly chat memory: store the conversation, embed it, retrieve something
similar later. That works for "what did we talk about". It does badly at the thing that actually
costs you time.

Three months into a project, ask an agent why the service uses SQLite.

If you are lucky, a summary somewhere says "we chose SQLite". What is gone is everything that made
that a *decision*:

- **PostgreSQL was considered and rejected** — that is missing entirely.
- **Why it was rejected** — "single-user local deployment, not worth running a server" — gone.
- **What would change the answer** — nobody wrote down that going multi-user should reopen it.
- **What was already tried and failed** — "one SQLite file per user" broke cross-user reporting.
  The agent will happily suggest it again.

So the deployment goes multi-user, and nothing anywhere notices that the reason for the original
choice just evaporated. The decision quietly becomes wrong and stays wrong until a human trips over
it.

Summarisation makes this worse, not better. A summary keeps the conclusion and drops the reasoning,
which is exactly backwards for this problem.

## What ShadowGraph does

ShadowGraph is a local-first **decision** store for AI agents. Not a transcript store.

It records, as structured data:

- what was decided, and the confidence attached to it
- what alternatives were rejected, and **the reason each was rejected**
- the assumptions and evidence behind the choice
- failed attempts, with the result and the lesson
- outcomes (successful / mixed / failed / unknown), which feed back into confidence
- provenance for every claim
- and **the conditions under which a decision should be reconsidered**

That last one is the point. You attach a rule when you decide:

```json
{
  "label": "PostgreSQL",
  "reasonRejected": "Single-user local deployment does not justify running a server",
  "reopenWhen": [{ "key": "deployment", "operator": "equals", "value": "multi-user" }]
}
```

Later — different session, different process, nobody remembers this exists — a fact changes:

```bash
shadowgraph fact '{"project":"checkout-service","key":"deployment","value":"multi-user","sourceClass":"human_confirmed","confidence":1}'
```

And then:

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

Note what is *not* in that `review` call: the fact that changed. `review` evaluates the stored rules
against stored facts, so it works after a restart with no help from the caller. That is the whole
product in one command.

## Why decision memory is not chat memory

| | Chat memory | Decision memory |
| --- | --- | --- |
| Unit | messages / chunks | decisions, alternatives, facts, attempts, outcomes |
| Keeps the rejected option | rarely | always, with its reason |
| Reacts when the world changes | no | `reopenWhen` rules evaluated against stored facts |
| "We already tried that" | maybe, if it embeds well | explicit attempt records with lessons |
| Provenance | usually none | `sourceClass` on every claim |
| Failure mode | plausible-sounding recall | declares what it does not know |

They are complementary. ShadowGraph does not try to be your transcript store, and it will not
extract memories from your conversation on its own — it records what you tell it to record.

## Local-first

Everything is a local file. No cloud service, no account, no telemetry, no analytics. ShadowGraph
makes no outbound network request unless you explicitly configure one, and the two things that could
send data off the machine are both off by default:

- embeddings — no endpoint configured; localhost works once configured; a remote endpoint needs a
  separate explicit opt-in, because that means your memory and query text leave the machine
- Markdown export — plaintext copies you create and control

The HTTP server binds to `127.0.0.1`, rejects non-local browser origins, and supports an optional
Bearer token for shared local use. Storage is a plain versioned JSON file (or SQLite on Node 22.5+).
You can read it, back it up, migrate it, and delete it. Project purge is previewable, logical by
default, with an explicitly irreversible hard mode.

## Interfaces

- **MCP** (stdio) — works with Claude Code, Cursor, Codex, and Hermes Agent. Compact mode advertises
  12 workflow tools; full mode has 27. Compact is a tool-advertisement choice, not lossy storage.
- **CLI** — every command is a separate process that reopens the store, so restart behaviour is not
  something you have to take on faith.
- **HTTP API** on `127.0.0.1`, plus a read-only local dashboard.
- **JavaScript API** with no runtime dependencies.

## Try it

```bash
npm install --global github:LiLara-AI/shadowgraph
mkdir shadowgraph-demo && cd shadowgraph-demo
shadowgraph setup
shadowgraph doctor
```

Then the five-minute quick start and the full worked demo:
<https://github.com/LiLara-AI/shadowgraph#quick-start--5-minutes>

Node 20+. No build step, no runtime npm dependencies.

**Windows users:** the CLI takes one JSON argument, so quoting differs. PowerShell needs
`'{\"project\":\"demo\"}'` and `cmd.exe` needs `"{\"project\":\"demo\"}"`. Both are documented, and
all three shell forms are tested.

## Honest limitations

This is a **Technical Preview / Early Access** release. Not Beta, not stable.

- **Interfaces and the storage schema may still change.** Do not put data you cannot reproduce in it.
- **It is not on npm.** The package is deliberately `private: true`. No npm publication, no Git tag,
  and no GitHub release exists — install from GitHub.
- **No comparative benchmark has been measured.** Comparative benchmark infrastructure was executed,
  but no arm was measured because no common local/free LLM and embedding endpoint was available. No
  comparative performance, quality, token, cost, or 'best' claim is supported. I am not claiming
  ShadowGraph is faster, cheaper, lower-token, more accurate, or better than Mem0, Graphiti, or
  anything else. That measurement is deferred, and the preregistration is frozen and hashed in the
  repo so it cannot be quietly rewritten afterwards.
- **Security review:** an AI-assisted independent security review (Antigravity Assistant, Gemini 3.7
  Flash) of the release commit passed with no unresolved findings. **No human third-party security
  audit has been performed.** Treat it as a control, not an audit.
- **No automatic extraction.** No background watcher, no default extractor, no hosted sync. It
  records what you tell it to.
- **Single maintainer.** No paid support, no patch SLA, no bug bounty.

What *is* verified: 1204 tests passing, CI green on Ubuntu and Windows across Node 20/22/24, the
strict official MCP Inspector gate in both modes, and a real clean-install smoke test from a packed
tarball.

## What I want feedback on

This is a preview because I want to find out where it breaks for other people. Most useful:

- **Installation problems** — anything between `npm install --global` and a green `doctor`.
- **MCP client compatibility** — which client, which mode, what it discovered or did not.
- **Memory usefulness** — did recalled context actually change what your agent did? If it did not,
  that is the most useful report of all.
- **Confusing workflows** — where the docs or a command shape sent you the wrong way.
- **Missing decision-memory use cases** — decisions you wanted to store and could not express.
- **Performance** — where it felt slow, and roughly how big the store was.

There is no telemetry, so a report from you is the only signal there is.

- Bugs and features: <https://github.com/LiLara-AI/shadowgraph/issues>
- Questions, ideas, "is this useful?": <https://github.com/LiLara-AI/shadowgraph/discussions>
- Security: <https://github.com/LiLara-AI/shadowgraph/security/advisories/new> (private, never a
  public issue)

Repository: <https://github.com/LiLara-AI/shadowgraph> · MIT
