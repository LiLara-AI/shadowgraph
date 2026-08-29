# ShadowGraph — Vision and Product Principles

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

## Deliberately out of scope

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
