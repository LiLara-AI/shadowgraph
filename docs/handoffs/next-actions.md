# ShadowGraph — Next Actions

**Last updated:** 2026-08-26 · **State:** G1–G8 and final-review hardening delivered; review branch is pushed and awaiting conditional merge.

Any new agent can pick up from here without reading chat history. Read `current-status.md` first, then the six contracts in this folder.

---

## P0 — Decisions only the user can make

| ID | Question | Blocks | Interim behaviour in force |
| --- | --- | --- | --- |
| **U-1** | How can a fact ever legitimately become `verified`? | Future trusted verification capability | **Unverified-only is accepted for 0.31.0**; nothing reaches `verified` from tool input |
| **L-1** | Should the entry state be `proposed` instead of `active`? | lifecycle semantics | stays `active` (load-bearing in `context()`/`maintain()`) |
| **L-2** | Is the documented transition order normative? | transition enforcement | any→any allowed |
| **L-5** | Give `stale`/`archived` meaning, or migrate them out? | vocabulary cleanup | accepted, deprecated, no producer |
| **Merge** | Merge only after identity, local gates, CI, and post-merge gates pass | version control | conditional final review in progress |

## P1 — Highest-value engineering work remaining

1. **Implement the ADR-0004 warm-task benchmark.** The five phases: first decision → restart recall → repeat task → changed-fact reconsideration → failed-attempt avoidance. Must include a no-memory baseline, must NOT feed the answer through call arguments, must not use LoCoMo. **This is the only way ShadowGraph's core economic claim gets evidence.** Nothing about token or cost is claimable until it exists.
2. **MCP protocol currency (`2026-07-28`).** Needs stateless per-request capability negotiation and real client interop testing. Currently honest but four revisions behind.
3. **Fact-level `sourceClass` validation surface.** `validate()` reports `legacy_fact_source_class`; consider a migration path that upgrades legacy facts on explicit request (never silently).
4. **100k-entry benchmark** if journal size ever becomes a concern — the harness already supports `--sizes 100000`.

## P2 — Cleanup

- Fold `g4-plan.md` and `cumulative-diff-review.md` into an archive subfolder; both are now historical.
- `docs/shadowgraph-redesign-proposal.md` still diagrams a transition ladder as if normative (L-2).
- `AI Projects\ShadowGraph` remains a stale docs-only copy — left untouched by directive.

## Proposed checkpoint (not executed)

Two commits. Per-gap commits are **not** honestly reconstructible: the `src/shadowgraph.js` hunks interleave across G2/G3/G4/G8, and producing them would mean hand-crafting intermediate states that were never tested in that exact form.

```
Commit 1 — docs: research, ADRs, contracts, benchmark report, handoff protocol
  docs/  (26 files)

Commit 2 — feat!: close G1-G8 architectural gaps; journal, provenance, lifecycle,
           completeness, search, confidence
  src/shadowgraph.js src/journal.js src/confidence.js src/mcp.js src/server.js
  src/cli.js src/storage.js src/sqlite-storage.js
  test/ (7 modified + gap-regressions.test.js)
  scripts/bench-journal.mjs
  package.json CHANGELOG.md README.md integrations/agent-policy.md
```

Both pass `npm test` independently. Commit 2 is marked `feat!` because `addFact()` rejects previously-accepted input and read paths return envelopes — both documented in `CHANGELOG.md` with migration steps.
