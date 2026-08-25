# ShadowGraph — Research Log

**Research date / access date for all sources below:** 2026-08-25
**Researcher:** Hermes Agent (claude-opus-5)
**Method:** live web search + primary-source extraction, performed directly by this agent.

---

## 0. Provenance rules for this document

> ### ⚠️ The five delegated research subagents were discarded in full
> A first attempt delegated 5 parallel research streams to subagents. **All 5 failed** with a tool-argument corruption fault (self-reported as "issue #15236"). They returned reports compiled from *training memory*, self-labelled "unverified", containing guessed version numbers, guessed star counts (e.g. "~10k+ stars"), and speculative framing of papers they never opened.
> **None of their output informed any part of this log, any ADR, or any plan.** Every claim below was re-researched directly with working tools.
> This is itself the product thesis in miniature: a fluent agent report is `agent_claimed`, never `tool_observed`.

Every claim is tagged:

| Tag | Meaning |
| --- | --- |
| ✅ **PRIMARY-SPEC** | Read directly from the official specification/standard/documentation page. Quoted verbatim. |
| 🟦 **PRIMARY-VENDOR** | The vendor's own claim about its own product, from the vendor's own page. True as a *claim*, not independently verified as a *result*. |
| 🟨 **INDEPENDENT** | Third-party measurement by someone with no stake. Better evidence of magnitude, weaker on rigour. |
| 🟧 **SELF-DESCRIPTION** | A project's own README describing itself. Primary for "what it claims", not evidence it works. |
| ⚠️ **SECONDARY** | Third-party commentary. Directional only. Never citable as fact in an ADR. |
| ❌ **UNVERIFIED** | Could not confirm. **Must not appear as fact anywhere.** |

**Retrieval caveat:** where a page was reached via a search-result snippet rather than direct extraction, this is stated explicitly. Two `web_extract` calls were blocked by a keyless-backend `403` (`anthropic.com/engineering/code-execution-with-mcp`), and two `web_search` calls failed with the same `403`. Those gaps are recorded as gaps, not filled by guesswork.

---

## 1. MCP specification — verified against primary sources

### 1.1 Current protocol version

✅ **PRIMARY-SPEC** — https://modelcontextprotocol.io/docs/learn/versioning (accessed 2026-08-25), verbatim:

> *"The **current** protocol version is **2026-07-28**."*

The same page defines the revision-state vocabulary, which resolves the user's question about draft-vs-official directly:

> *"Revisions may be marked as: **Draft**: in-progress specifications, not yet ready for consumption. **Current**: the current protocol version, which is ready for use and may continue to receive backwards compatible changes. **Final**: past, complete specifications that will not be changed."*

**Therefore `2026-07-28` is not a draft, not a proposal, and not a future version.** It is the *Current* revision. Corroborating primary evidence:

✅ **PRIMARY-SPEC** — https://github.com/modelcontextprotocol/modelcontextprotocol/releases (accessed 2026-08-25): tag `2026-07-28`, *"This release marks the **stable release** of the `2026-07-28` revision"*, released 28 Jul 2026, commit `5f5440b`, GPG-verified signature. A separate earlier tag `2026-07-28 RC` exists, confirming RC → stable progression completed.

Full published revision lineage (same source): `2024-10-07`, `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25`, `2026-07-28`.

Version format, ✅ **PRIMARY-SPEC** (versioning page): `YYYY-MM-DD` indicating *"the last date backwards incompatible changes were made"*; the version is **not** incremented for backwards-compatible updates.

### 1.2 The `initialize` handshake was removed

✅ **PRIMARY-SPEC** — https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning (accessed 2026-08-25), verbatim:

> *"**There is no negotiation handshake.** Every request carries its protocol version, and the server accepts or rejects each request independently."*

The same page defines era terminology that places ShadowGraph precisely:

> *"**Modern**: protocol versions that convey version, identity, and capabilities as per-request metadata (revision `2026-07-28` and later). **Legacy**: protocol versions that establish a session with an `initialize` handshake (`2025-11-25` and earlier). **Dual-era**: an implementation that supports both modern and legacy versions."*

✅ **PRIMARY-SPEC** — https://modelcontextprotocol.io/specification/2026-07-28/changelog (accessed 2026-08-25), major change 2, verbatim:

> *"Make MCP stateless: remove the `initialize`/`notifications/initialized` handshake. Every request now carries its protocol version and client capabilities in `_meta` (`io.modelcontextprotocol/protocolVersion`, `io.modelcontextprotocol/clientCapabilities`)… Version mismatches return `UnsupportedProtocolVersionError` ([SEP-2575](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2575))."*

✅ **PRIMARY-SPEC** — https://modelcontextprotocol.io/specification/2026-07-28 (accessed 2026-08-25) confirms under *Base Protocol*: *"Stateless, self-contained requests"* and *"Per-request capability negotiation"*.

### 1.3 `server/discover` is mandatory for servers, optional for clients

✅ **PRIMARY-SPEC** — versioning page (`/specification/2026-07-28/basic/versioning`), verbatim:

> *"Servers **MUST** implement [`server/discover`]. Clients **MAY** call it before sending any other requests to learn the server's supported versions up front, but are not required to: a client is free to invoke any RPC inline and handle `UnsupportedProtocolVersionError` if its preferred version is not supported."*

Error shape (same page): JSON-RPC code **`-32022`**, `data.supported` listing supported versions, `data.requested` echoing the rejected one.

### 1.4 🔻 CORRECTION to my earlier report: legacy interop is explicitly specified

My previous summary implied ShadowGraph's MCP server may be near-breaking. **That overstated the risk and is corrected here.**

✅ **PRIMARY-SPEC** — https://modelcontextprotocol.io/docs/learn/versioning, verbatim:

> *"For interoperability with servers and clients that implement the handshake-based protocol revisions (`2025-11-25` and earlier), see Backward Compatibility."*

The spec defines a **Dual-era** implementation category and a dedicated backward-compatibility section (`/specification/2026-07-28/basic/versioning#backward-compatibility-with-initialization-based-versions`). The handshake era is therefore an *explicitly accommodated* legacy path, not an abandoned one.

**Honest limit of this finding:** I confirmed that section **exists and is linked from two primary pages**. I did **not** read its full normative content, so I cannot state what a legacy server must do to remain interoperable, nor whether any specific client still negotiates `2024-11-05`. Recorded as unresolved assumption **X-1**.

### 1.5 Comparison with what the repository implements

| | Repository (verified by reading code) | Current spec (verified primary) |
| --- | --- | --- |
| Advertised `protocolVersion` | **`2024-11-05`** — `src/mcp.js` line 80, hardcoded | `2026-07-28` |
| Era | **Legacy** (handshake-based) | Modern (stateless, per-request `_meta`) |
| `initialize` / `notifications/initialized` | Implemented (lines 80–81) | Removed from core |
| `server/discover` | **Not implemented** | Servers **MUST** implement |
| Version negotiation | None — single hardcoded string | Per-request, with `-32022` on mismatch |

Distance: **`2024-11-05` is four revisions behind `2026-07-28`** (intervening: `2025-03-26`, `2025-06-18`, `2025-11-25`).
*(An earlier statement of "five revisions behind" counted `2024-10-07`, which precedes ShadowGraph's own version — corrected.)*

**Per user directive, no MCP code was modified.**

### 1.6 Ecosystem context

⚠️ **SECONDARY** — hidekazu-konishi.com/entry/mcp_specification_version_timeline.html (accessed 2026-08-25; first published 2026-07-26, last updated 2026-08-20): MCP donated to the **Agentic AI Foundation** at the Linux Foundation on 2025-12-09 (co-founded with Block and OpenAI); **MCP Apps** shipped 2026-01-26 as the first official extension. *Not load-bearing for any decision; recorded for orientation only.*

✅ **PRIMARY-SPEC** — `/specification/2026-07-28` lists current official extensions: **Tasks**, **Skills over MCP**, **MCP Apps**. Extensions are *"always opt-in and require explicit support from both client and server"*.

---

## 2. Tool-schema token cost — corrected, with unverified numbers removed

My earlier report cited several striking figures drawn from YouTube video descriptions and third-party blog summaries. **Per user directive, those are now demoted to ❌ UNVERIFIED and must not be cited as fact.** What survives:

### 2.1 Citable

🟦 **PRIMARY-VENDOR** — https://anthropic.com/engineering/advanced-tool-use, *"Introducing advanced tool use on the Claude Developer Platform"* (accessed 2026-08-25 via search-result snippet of the primary URL; **direct extraction of the related `code-execution-with-mcp` page was blocked by a keyless-backend 403**). Anthropic's own worked example of tool-definition overhead:

| Server | Tools | Approx. tokens |
| --- | --- | --- |
| GitHub | 35 | ~26K |
| Slack | 11 | ~21K |
| Sentry | 5 | ~3K |
| Grafana | 5 | ~3K |
| Splunk | 2 | ~2K |
| **Total** | **58** | **≈55K** |

Verbatim: *"That's 58 tools consuming approximately 55K tokens before the conversation even starts."*

Mechanism, verbatim: *"The Tool Search Tool lets Claude dynamically discover tools instead of loading all definitions upfront. You provide all your tool definitions to the API, but mark tools with `defer_loading: true`… Deferred tools aren't loaded into Claude's context initially."*

🟦 **PRIMARY-VENDOR** — https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/programmatic-tool-calling (accessed 2026-08-25 via search-result snippet), verbatim:

> *"On agentic search benchmarks like BrowseComp and DeepSearchQA… adding programmatic tool calling on top of basic search tools improved performance by an average of **11%** while using **24% fewer input tokens**."*

🟦 **PRIMARY-VENDOR** — https://console.anthropic.com/docs/en/agents-and-tools/tool-use/tool-search-tool (accessed 2026-08-25 via search-result snippet). **The single most actionable finding in this section:** tool search matches against

> *"tool names, descriptions, argument names, and argument descriptions"*

with two variants — regex (`tool_search_tool_regex_20251119`) and BM25 (`tool_search_tool_bm25_20251119`).

🟨 **INDEPENDENT** — https://aimultiple.com/code-execution-with-mcp (accessed 2026-08-25 via search-result snippet; page not directly extracted). Independent test, GPT-4.1, code-execution vs. regular MCP:

- input tokens **165K vs 771K** → **78.5% fewer**
- output tokens **2.2× higher** (the model writes code)
- **77.4% net** token reduction (175K vs 775K)
- tool definitions per call: **~15,400 (regular) vs ~3,300 (code execution)**
- **100% success rate in both arms**

### 2.2 ❌ UNVERIFIED — do not cite, do not put in ADRs

Every one of these came from a YouTube video description or an unattributed third-party blog. I could not reach a primary source for any of them:

- "77k → 8.7k tokens", "85% reduction", "preserving 95% of context window"
- "Opus 4 improved from 49% to 74%"; "Opus 4.5 went from 79.5% to 88.1%"
- "average token usage dropped from 43,000 to 27,000 / 37% reduction"
- "98.7% reduction"
- "Cloudflare compressed 2,500+ API endpoints to two tools / ~1,000 tokens"
- "30–40% latency improvements"
- "For MCP servers, you can defer entire servers while keeping specific high-use tools loaded" *(plausible and useful if true — but unverified)*

**Consequence for ShadowGraph:** the *direction* is well supported by 🟦 + 🟨 evidence — tool definitions are a material, front-loaded context cost, and the ecosystem's answer is deferred loading and code execution rather than shipping fewer tools. But I can no longer assert a specific percentage, and my earlier claim that tool count measurably harms *accuracy* rested entirely on the unverified Opus figures. **That accuracy claim is withdrawn**; only the 🟦 programmatic-tool-calling `+11% / −24%` figure survives, and it measures a different mechanism.

---

## 3. Competitive landscape — ShadowGraph's niche is occupied

🟧 **SELF-DESCRIPTION** for all of the following (GitHub README text, accessed 2026-08-25). These are primary for *what each project claims*; I did not install or test any of them. **No star counts are reported — I did not verify any.**

**`richardoros/threadline-core`** — *"Local-first continuity memory for AI coding agents. An MCP server that remembers decisions, open loops & findings across sessions. No cloud, evidence-gated, Apache-2.0."* 17 MCP tools; SQLite + FTS5; MCP **2024-11-05** stdio (same legacy era as ShadowGraph); zero outbound calls. Directly relevant to gap G2: *"Each transition… is **evidence-gated**: the server rejects self-assertion with a `ValueError`."* Also ships `mark_decision_outcome`, `get_known_traps` (decisions proven wrong, so agents don't repeat them), `get_evidence`, and automatic PII redaction.

**`Rajwantmishra/agent-logbook`** — *"Local SQLite long-term memory… Every decision logged, nothing erased."* 7 MCP tools. `remember()` *"refuses to write and hands back the conflict instead of silently overwriting"*. `supersede(old_id, new_content)` — *"Nothing is deleted; the old row is marked superseded and linked to the new one"* — plus `memory_history()` walking the chain oldest→newest.

**`oleksiijko/pmb`** — local-first decisions/lessons/facts; SQLite as durable source of truth with **rebuildable** indexes beside it; *"no LLM call on the read path"*; secrets auto-redacted at write time; Apache-2.0. Notably markets *"it tells you **when memory is actually helping**, instead of claiming '+X%'"*.

**`rmanov/sqlite-memory-mcp`** — single SQLite file; WAL for concurrent sessions; FTS5 BM25 **+ optional sqlite-vec fused via Reciprocal Rank Fusion**; *"event/provenance tracking for memory mutations"*; *"reviewable consolidation instead of silent memory rewriting"*; *"application-enforced append-only governance"*.

⚠️ **SECONDARY** — baeseokjae.github.io/posts/agent-memory-comparison-2026 (accessed 2026-08-25) additionally names Déjà Vu, Agent Memory MCP, GBrain, Axio, and characterises Mem0 as cloud-only with an API key at $40–50+/month. *Directional only; not citable.*

**Honest consequence:** ShadowGraph is **not** first at local-first SQLite decision memory over MCP, nor at supersession chains, nor at failed-attempt memory, nor at provenance tracking, nor at "no silent rewriting". Several of these are shipped by others today, and `threadline-core` already enforces the anti-self-assertion rule ShadowGraph currently lacks (G2).

---

## 4. Benchmark methodology — the LoCoMo dispute as a cautionary tale

✅ **PRIMARY-VENDOR/PRIMARY-SPEC mix** — https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ and https://github.com/getzep/zep-papers/issues/5 (both accessed 2026-08-25).

Sequence of events, all from those two pages:

1. Mem0 published arXiv **2504.19413** claiming SOTA on **LoCoMo** (arXiv **2402.17753**).
2. Zep rebutted, alleging (a) LoCoMo is flawed and (b) Mem0's Zep implementation was wrong — incorrect user model (*"assigned the user role to both participants"*), timestamps appended to message text instead of the dedicated `created_at` field, and searches run serially rather than in parallel, penalising latency. Zep's corrected figure: **75.14% ± 0.17 vs Mem0 Graph ~68%**.
3. Zep published a **correction to its own arithmetic** on that very number (verbatim: *"in an earlier version of this article, we erred in how we calculated Zep's LoCoMo score"*).
4. Mem0 counter-alleged in zep-papers issue #5 that Zep's separately-claimed **84%** was actually **58.44%**, because *"the calculation erroneously used a denominator that excluded Category 5 questions while including Category 5 correct answers in the numerator."*
5. Thread **closed due to inactivity**. Unresolved.

**LoCoMo's documented flaws** (per Zep's analysis): conversations average only **16k–26k tokens**, inside a modern context window, so it partly measures context length rather than memory quality; **it does not test knowledge updates**; and there are dataset quality issues. Most damning, from Zep quoting Mem0's own paper: *"Mem0's own results show their system being outperformed by a simple full-context baseline."*

**Direct implications for ShadowGraph (these drive ADR-0004):** a benchmark that cannot measure fact *revision* is unusable for a product whose core is revision. Always include a no-memory/full-context baseline. Never benchmark a competitor's product. And note that both sophisticated parties here published arithmetic errors under public scrutiny — an argument for pre-registration and for publishing the failure log.

LongMemEval is offered by Zep as the better alternative (human-curated, temporal reasoning). ❌ **UNVERIFIED**: its licence, size, and local runnability.

---

## 5. Event sourcing — vendors warn against defaulting to it

✅ **PRIMARY-SPEC** — https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing (accessed 2026-08-25), verbatim:

> *"Event sourcing is a complex pattern that introduces significant trade-offs. It changes how you store data, handle concurrency, evolve schemas, and query state. **It's costly to migrate to or from** an event sourcing solution, and after you adopt the pattern, **it constrains future design decisions** in the parts of the system that use it… **For most systems and most parts of a system, traditional data management is sufficient.**"*

And:

> *"Event sourcing doesn't have to be an all-or-nothing decision for your entire system. **Apply it selectively** to the parts of your system that it benefits the most, such as a payment ledger or order-processing pipeline. Use traditional CRUD for parts when the complexity isn't justified, such as user profile management or application configuration."*

Documented schema-evolution strategies, to be used individually or combined (same page): **tolerant deserialization** (ignore unknown fields, default missing ones — handles additive change with no transformation of stored events), **event versioning** (version id in the envelope or the type name), **upcasting** (chained transformation functions so application code only handles the latest version).

⚠️ **SECONDARY** — https://event-driven.io/en/when_not_to_use_event_sourcing/ (Oskar Dudycz, dated 2021-06-23, accessed 2026-08-25): argues ES suits smaller systems too, but ranks **socio-technical** factors first — notably *"the team is doing well with the current approach"* — and warns of *"enormous"* repetitive boilerplate when ES is applied to essentially dictionary-like configuration data.

**This is the evidentiary basis for the user's directive that ShadowGraph must not implement full event sourcing.** See ADR-0001.

---

## 6. Design-rationale prior art — a 30-year literature with a documented failure mode

⚠️ **SECONDARY** for all of this section (ACM DL abstract at https://dl.acm.org/doi/10.1145/1833335.1833336, Springer chapter *"Redesigning the Rationale for Design Rationale"* at https://link.springer.com/chapter/10.1007/978-3-540-73105-4_2, a survey PDF at ase.in.tum.de, and academia.edu — all accessed 2026-08-25).

The field: **IBIS / gIBIS**, **PHI** (Procedural Hierarchy of Issues), **QOC** (Questions, Options, Criteria — a.k.a. Design Space Analysis), **DRL** (Decision Representation Language, Lee), **RATSpeak**, **Compendium**.

The documented central failure mode, quoted from the ACM DL abstract:

> *"Horner and Atwood describe the inherent limitations to developing systems that can effectively capture and use design rationale. **Recording the reasoning process of design can be very time-consuming and expensive.**"*

And from the Springer chapter abstract:

> *"The dynamic and contextual nature of design and our inability to exhaustively analyze all possible design issues results in **cognitive, capture, retrieval, and usage limitations**. In addition, there are the **organizational limitations** that ensue when systems are deployed."*

⚠️ **Citation caveat:** the reference *Horner, J., Atwood, M.E.: "Design rationale: the rationale and the barriers", Communications of the ACM 37(1), 92–105 (1994)* appears in a **secondary reference list**. I did **not** open the original paper. Volume/issue/pages are therefore **unconfirmed** and must be verified before appearing in any published document.

Theoretical barriers named in this literature: **bounded rationality** (Simon — designers cannot enumerate all alternatives), **wicked problems**, and **situated action** (Schön's *"reflective conversation with the environment"*).

Two findings of direct engineering relevance:

- The **"Reconstruction"** capture method (attributed to Lee): capture rationale raw, restructure later. *"The advantage… is that rationales can be carefully captured and capturing process won't disrupt the designer,"* at the cost of expense and reconstructor bias.
- **Burge & Brown's `InfoRat`** — *"a system that inferences over a design's rationale in order to detect inconsistencies and to assess the impact of changes."* **This is ShadowGraph's `reconsider` feature, prototyped decades earlier.** Study and cite it rather than reinventing it.

### 6.1 ADR practice

✅ **PRIMARY-SPEC** — https://martinfowler.com/bliki/ArchitectureDecisionRecord.html (accessed 2026-08-25), verbatim:

> *"Each ADR has a status. 'proposed' while it is under discussion, 'accepted' once the team accepts it and it is active, 'superseded' once it is significantly modified or replaced - with a link to the superseding ADR. **Once an ADR is accepted, it should never be reopened or changed - instead it should be superseded.**"*

✅ **PRIMARY-SPEC** — https://github.com/thomvaill/log4brains (accessed 2026-08-25), verbatim:

> *"an ADR is immutable. Only its status can change. Thanks to this, your documentation is never out-of-date! Yes, an ADR can be deprecated or superseded by another one, but **it was at least true one day!** And even if it's not the case anymore, it is still a precious piece of information."*

Default template is **MADR**; **Y-Statements** also noted as an alternative.

⚠️ **SECONDARY** — https://contributing.bitwarden.com/architecture/adr (accessed 2026-08-25) adds **Deprecated** as distinct from Superseded: *"The architectural choice has been abandoned… Unlike 'Superseded,' there may not be a direct replacement ADR."* ShadowGraph has no equivalent state (and its documented `abandoned` is rejected by the code — gap G3).

⚠️ **SECONDARY** — https://www.catio.tech/blog/architecture-decision-record (accessed 2026-08-25) surveys tooling (adr-tools by Nat Pryce, Log4brains, ADR Manager) and concludes: *"None of these tools solves the harder problem, which is keeping ADRs connected to the live system they describe."* That gap is arguably ShadowGraph's actual opportunity — a rationale store an agent reads and writes live.

**The reframing this section produces:** rationale capture historically failed because *humans* would not pay the capture cost. An agent already articulating its reasoning drives that cost toward zero. **With the honest corollary** that §2 identifies a *new* capture cost — tool-definition tokens. The barrier moved from human attention to context budget; it did not disappear.

---

## 7. `node:sqlite` — a correction, and a source conflict resolved in favour of the primary

✅ **PRIMARY-SPEC** — https://nodejs.org/api/sqlite.html (accessed 2026-08-25), version history:

- Added in **v22.5.0**
- **v23.4.0, v22.13.0** — *"SQLite is no longer behind `--experimental-sqlite` but still experimental."*
- **v25.7.0** — *"SQLite is now a release candidate."*

✅ **PRIMARY-SPEC** — Node.js stability index (nodejs.org docs, accessed 2026-08-25) lists **`SQLite (1.2) Release candidate`** — *not* Stability 2 (Stable). Stability 1.x carries the explicit warning: *"Non-backward compatible changes or removal may occur in any future release."*

⚠️ **Source conflict, resolved:** a secondary source (releaserun.com/versions/nodejs/24) claims *"SQLite module promoted to stable"* in Node 24. **The primary nodejs.org documentation contradicts this.** Trust the primary: `node:sqlite` is a **Release Candidate**, not stable.

Also ⚠️ **SECONDARY** (reddit.com/r/node thread, accessed 2026-08-25): `TryGhost/node-sqlite3` was deprecated; `better-sqlite3` remains maintained. **Different package** from `node:sqlite` — noted only to explain ecosystem churn.

**Verdict for ShadowGraph:** the existing design is *validated* — `src/sqlite-storage.js` guards the import in a `try/catch` with a clear "requires Node 22.5+" message, and `engines: {node: ">=20"}` keeps JSON as a working fallback. **Keep this.** The risk to carry forward is that a future Node minor may change the RC API (assumption X-5). Local environment: Node **v24.18.0**.

---

## 8. Synthesis — what changed versus the briefs

| Prior belief in `docs/` | Post-research status |
| --- | --- |
| Competitors are Mem0 / Graphiti / Letta; the niche is open | ❌ **Wrong.** ≥4 local-first SQLite MCP decision-memory servers exist; one already enforces anti-self-assertion (G2) |
| Compact MCP mode (23→10 tools) is the token strategy | ⚠️ **Weak lever.** Ecosystem answer is deferred loading / code execution, which are **client-side**. Magnitude supported; specific percentages withdrawn as unverified |
| MCP `2024-11-05` is current enough | ⚠️ **Four revisions behind**, and in the *Legacy* era the current spec explicitly names. **But** backward compatibility is specified, so this is scheduled maintenance, not breakage (X-1) |
| Canonical event ledger + rebuildable projections everywhere | ⚠️ **Over-adoption.** Microsoft: costly to migrate *to or from*, constrains future design, *apply selectively* |
| Benchmark against competitors on known benchmarks | ❌ **Credibility trap.** LoCoMo cannot test knowledge updates; both vendors published arithmetic errors |
| `node:sqlite` is stable | ⚠️ **Release Candidate (1.2)**; existing guard + JSON fallback correct |
| Thesis is "durable decision memory" | ✅ **Sharpen:** rationale capture failed on human capture overhead; agents dissolve it — but tokens are the new capture cost. `InfoRat` is direct prior art for `reconsider` |

### 8.1 Where ShadowGraph can still be first-or-best

Narrowed to two claims that survive scrutiny (see ADR-0005):

1. **Deterministic changed-fact reconsideration over *stored* state** — no surveyed competitor README advertises rule-based automatic reopening from persisted facts. Requires fixing G1, which is currently broken.
2. **`reopenWhen` falsification conditions as first-class data** — a decision that carries the conditions under which it should be revisited. No surveyed competitor advertises this.

Supporting but **not** differentiating: a graded four-class provenance lattice (`threadline-core` already does binary evidence-gating, so this is finer-grained, not novel); and an honest warm-lifecycle benchmark protocol (`pmb` gestures at the same idea).

### 8.2 What to stop claiming

- Zero-dependency Node + JSON/SQLite dual storage — solid engineering, **table stakes** in this cohort.
- "Compact lossless MCP" — not a differentiator.
- Retrieval quality is a genuine **deficit**, not a nit: no FTS5, no BM25, and an `O(n)` full-JSON-stringify search that matches schema key names (G7), while competitors ship FTS5 + BM25 + RRF re-ranking.

---

## Appendix A — Primary source register

All accessed **2026-08-25**. "Direct" = retrieved by `web_extract`; "snippet" = retrieved via search-result content from that URL, direct extraction unavailable.

| # | URL | Used for | Retrieval |
| --- | --- | --- | --- |
| S1 | https://modelcontextprotocol.io/docs/learn/versioning | Current version = `2026-07-28`; Draft/Current/Final vocabulary; legacy interop pointer | Direct |
| S2 | https://modelcontextprotocol.io/specification/2026-07-28/basic/versioning | "No negotiation handshake"; Modern/Legacy/Dual-era; `server/discover` MUST; error `-32022` | Direct |
| S3 | https://modelcontextprotocol.io/specification/2026-07-28/changelog | Six major changes incl. handshake removal | Direct |
| S4 | https://modelcontextprotocol.io/specification/2026-07-28 | Stateless base protocol; per-request negotiation; official extensions | Direct |
| S5 | https://github.com/modelcontextprotocol/modelcontextprotocol/releases | Stable release 2026-07-28, commit `5f5440b`; full revision lineage | Snippet |
| S6 | https://anthropic.com/engineering/advanced-tool-use | 58 tools ≈ 55K tokens; `defer_loading: true` | Snippet |
| S7 | https://docs.anthropic.com/en/docs/agents-and-tools/tool-use/programmatic-tool-calling | +11% performance / −24% input tokens | Snippet |
| S8 | https://console.anthropic.com/docs/en/agents-and-tools/tool-use/tool-search-tool | Search matches names + descriptions + argument names/descriptions | Snippet |
| S9 | https://aimultiple.com/code-execution-with-mcp | Independent: 78.5% fewer input tokens; ~15,400 vs ~3,300 tool-def tokens | Snippet |
| S10 | https://learn.microsoft.com/en-us/azure/architecture/patterns/event-sourcing | ES trade-offs; "apply it selectively"; upcasting/versioning/tolerant deserialization | Snippet |
| S11 | https://event-driven.io/en/when_not_to_use_event_sourcing/ | Socio-technical criteria; boilerplate warning | Snippet |
| S12 | https://blog.getzep.com/lies-damn-lies-statistics-is-mem0-really-sota-in-agent-memory/ | LoCoMo flaws; 75.14% vs ~68%; self-correction notice | Snippet |
| S13 | https://github.com/getzep/zep-papers/issues/5 | Counter-rebuttal: 84% → 58.44%; closed unresolved | Snippet |
| S14 | https://nodejs.org/api/sqlite.html | `node:sqlite` version history; RC status | Snippet |
| S15 | https://martinfowler.com/bliki/ArchitectureDecisionRecord.html | ADR statuses; supersede-never-edit | Snippet |
| S16 | https://github.com/thomvaill/log4brains | ADR immutability; MADR default | Snippet |
| S17 | https://dl.acm.org/doi/10.1145/1833335.1833336 | Horner & Atwood limitations; IBIS/PHI/QOC lineage | Snippet |
| S18 | https://link.springer.com/chapter/10.1007/978-3-540-73105-4_2 | Cognitive/capture/retrieval/usage + organizational limitations | Snippet |
| S19 | https://github.com/richardoros/threadline-core | Evidence-gated transitions; 17 tools | Snippet |
| S20 | https://github.com/Rajwantmishra/agent-logbook | Conflict-refusal; supersession chain | Snippet |
| S21 | https://github.com/oleksiijko/pmb | Rebuildable indexes; no LLM on read path | Snippet |
| S22 | https://github.com/rmanov/sqlite-memory-mcp | FTS5+BM25+RRF; provenance tracking | Snippet |

**Retrieval failures (recorded, not filled by guesswork):** `anthropic.com/engineering/code-execution-with-mcp` — `web_extract` 403; two `web_search` queries (Zep/Graphiti bi-temporal paper; event-sourcing criticism) — backend 403. The Zep arXiv paper *"Zep: A Temporal Knowledge Graph Architecture for Agent Memory"* was therefore **never opened**; its arXiv ID and bi-temporal schema details remain ❌ **UNVERIFIED**.
