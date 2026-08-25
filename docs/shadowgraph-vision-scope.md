# ShadowGraph — Vision, Scope, and Product Principles

## Vision

ShadowGraph is a permanent, portable, local-first decision memory for AI agents. It preserves the reasoning trail behind consequential work so Claude, Codex, Cursor, Antigravity, Hermes Agent, OpenClaw, and future clients can recall decisions, rejected alternatives, assumptions, evidence, failed attempts, outcomes, confidence, and reconsideration triggers across sessions.

The product promise is not "make every answer smarter." It is: **make important decisions durable, explainable, reviewable, and resistant to repeated mistakes.**

## Problem

Chat transcripts are poor decision memory:

- important decisions are buried in prose;
- rejected alternatives and their reasons disappear;
- facts change without triggering reconsideration;
- failed attempts are repeated;
- confidence is not tied to evidence or outcomes;
- a new agent session starts without portable local history;
- summaries can silently lose the facts they were meant to preserve.

## Product thesis

The source of truth must be full-fidelity and local. Retrieval may be compact for token economy, but it must never silently omit or falsify. Every compact response must be explicit about scope, completeness, pagination, provenance, and expansion paths.

> **Planning/history document:** the original scope below was written for the v0.30 redesign. It is not authoritative for current v0.31 implementation status; see `README.md`, `docs/api-reference.md`, and `docs/handoffs/current-status.md`.

## In scope for v0.30 / next redesign (historical planning scope)

- Decision-first memory model.
- Decisions, alternatives, rejection reasons, assumptions, evidence, facts, attempts, outcomes, confidence history, review signals, relations, events, projects, and idempotency.
- JSON and normalized SQLite persistence.
- Atomic backup/restore and revision-conflict safety.
- MCP stdio, HTTP, CLI, JavaScript core, Hermes adapter, integrations, and local dashboard.
- Full-fidelity storage with compact workflow-oriented MCP access.
- Explicit decision lifecycle. The **nine documented execution states** are: proposed, planned, in_progress, executed, validated, failed, reconsidered, superseded, abandoned. Four further states exist in storage and are **retained**, but they are *not* rungs on the same ladder: `active` is a **validity** state ("in force, not superseded") and is currently the default for new decisions and load-bearing in `context()` and `maintain()`; `aging` is **derived** and produced only by `maintain()`; `stale` and `archived` are **legacy/deprecated** and have no producer in the codebase today. All thirteen are accepted and stored canonically, but they do **not** form a single transition ladder. Canonical vocabulary and rationale: `docs/handoffs/lifecycle-contract.md`.
- Provenance separating agent claims, tool observations, human confirmation, and production verification.
- Deterministic reconsideration when facts change.
- Warm-task benchmarks that measure total work economics, not only first-run tokens.

## Out of scope unless separately approved

- npm publication.
- Hosted/cloud data storage as the default.
- Sending private memory to third-party services.
- Silent automatic deletion or lossy summarization.
- Replacing a full audit trail with embeddings or opaque ranking.
- Claiming that a higher confidence number means truth without evidence.

## Non-negotiable principles

1. **Truth before brevity:** storage is canonical and complete.
2. **No silent omission:** bounded retrieval declares total, pages, and omitted scope.
3. **Provenance is data:** who/what/when/source must travel with claims.
4. **Decisions are not facts:** a chosen option, an observed fact, and a model inference have different semantics.
5. **Reconsideration is first-class:** changed facts can reopen decisions deterministically.
6. **Local-first portability:** a user can inspect, back up, migrate, and delete their own data.
7. **Evidence-calibrated confidence:** confidence changes only through explicit evidence/outcomes/review events.
8. **Compatibility while redesigning:** old interfaces remain until the replacement is proven and migrated.
9. **Measure complete workflows:** first-run overhead is only one metric.
10. **Safety over synthetic history:** do not fabricate events merely to make a demo look complete.

## Success criteria

- 100% persistence of accepted canonical events.
- 0 silent omissions in retrieval.
- Project isolation and restart recall verified.
- Changed-fact reconsideration detects relevant contradictions and ignores irrelevant facts.
- Failed-attempt avoidance is measurable.
- Confidence has an explainable basis and history.
- Warm repeated work has lower total cost or clearly higher decision quality than baseline.
- Full test, syntax, security, migration, and backup suites remain green.
