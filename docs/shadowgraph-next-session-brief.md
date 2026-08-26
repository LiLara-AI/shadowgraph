# ShadowGraph Next-Session Brief

> **Historical handoff snapshot — v0.30 baseline; not the current implementation contract.** Use `docs/handoffs/current-status.md` and `docs/api-reference.md` for current v0.31 behavior.

## Purpose

Continue ShadowGraph as a permanent, local-first, portable decision-memory system for AI agents. The system must remember not only what was chosen, but what was rejected, why it was rejected, which assumptions and evidence supported the choice, what failed, what happened afterward, how trustworthy each claim is, and when a decision should be reconsidered.

## Current public state

- Version: v0.30.0.
- Public GitHub branch: `main`.
- Latest verified public commit before this handoff: `1dde968 Add compact lossless MCP mode`.
- npm remains private; do not publish npm without a separate explicit decision.
- Current local suite reached 41 passing tests and zero audit vulnerabilities in the preceding work.
- Current storage: compatible JSON plus normalized relational SQLite with legacy-envelope migration, transactions, revision conflicts, backup/restore, and multi-process tests.
- Interfaces: JavaScript core, CLI, HTTP, MCP stdio, Python Hermes adapter, dashboard.

## Product truth

ShadowGraph is not generic chat memory. It is a decision ledger and reconsideration system. Full-fidelity storage is mandatory. Compact views may reduce prompt overhead only when they are lossless, paginated, explainable, and explicit about omitted pages. Never silently summarize away facts, alternatives, rejection reasons, evidence, failed attempts, outcomes, or provenance.

## Recent empirical findings

- A single initial MCP recording session can cost more tokens than a plain Claude answer because tool schemas and tool turns are expensive.
- This does not prove ShadowGraph is more expensive for a complete repeated-work lifecycle. The correct benchmark must compare first decision, restart recall, changed-fact reconsideration, failed-attempt avoidance, and total work cost.
- Claude CLI occasionally refuses synthetic recording prompts or stops early. Treat tool results and persisted files as evidence, not the assistant's prose.
- Real Claude testing found and fixed MCP project schema support, `reason` → `reasonRejected` compatibility, and `human-confirmed` source normalization.

## Required next work

1. Redesign contracts before deleting working behavior.
2. Define a canonical event/decision ledger and rebuildable projections.
3. Make execution lifecycle explicit. The **nine documented execution states** are: proposed, planned, in_progress, executed, validated, failed, reconsidered, superseded, abandoned. Storage also holds four states that are retained but are **not** part of the same ladder — `active` (validity state, current default for new decisions, load-bearing), `aging` (derived, produced only by `maintain()`), and `stale`/`archived` (legacy, deprecated, no producer today). Thirteen accepted states, one canonical form each, **not** one transition ladder. See `docs/handoffs/lifecycle-contract.md`.
4. Make provenance mandatory and distinguish agent-claimed, tool-observed, human-confirmed, and production-verified evidence.
5. Add deterministic `reconsider` analysis for changed facts.
6. Keep full storage and provide compact workflow MCP as an additional compatibility surface.
7. Benchmark warm-task economics, not only first-run token cost.

## Safety rules

- Do not expose secrets or user data.
- Do not publish npm automatically.
- Do not push architectural changes without tests and audit.
- Preserve migration and backward compatibility until replacement behavior is proven.
- Prefer evidence from isolated clean installs and persisted state.
