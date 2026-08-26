# ShadowGraph — Product Manager Baseline

## Product identity

**Name:** ShadowGraph

**Category:** local-first AI decision-memory and reconsideration system.

**Primary users:** developers, technical leads, researchers, agents, and multi-agent workflows making decisions that need to survive sessions and be audited later.

**Clients:** Claude, Codex, Cursor, Antigravity, Hermes Agent, OpenClaw, HTTP clients, CLI users, and JavaScript integrations.

> **Historical baseline — not the current implementation contract.** This PM document records the v0.30 planning baseline. For current version, capabilities, test state, and deferred decisions, use `README.md`, `docs/api-reference.md`, and `docs/handoffs/current-status.md`.

## Current product state (historical v0.30 baseline)

- Version 0.30.0 (historical baseline; current implementation is 0.31.0 review candidate).
- Public GitHub repository: `https://github.com/LiLara-AI/shadowgraph`.
- Latest known pushed commit in this work: `1dde968 Add compact lossless MCP mode`.
- `package.json` remains private; npm publication is intentionally disabled.
- No runtime dependency requirement beyond Node.js >=20; SQLite uses built-in `node:sqlite` where available.

## Current capabilities

### Core graph

- Records decisions with chosen option, goal, assumptions, evidence, alternatives, rejection reasons, reopen conditions, project, status, confidence, and outcomes.
- Records facts with source normalization and verification status; ordinary agent input cannot create `verified`.
- Records attempts and failed attempts to avoid.
- Records outcomes and confidence history.
- Supports relations, traversal, search, retrieval, context, review signals, maintenance, validation, redaction, purge, idempotency, and migrations.

### Storage

- JSON storage with atomic temp-write/rename, serialized save queue, a cross-instance lock, revisions, and conflict detection.
- Normalized SQLite tables for metadata, entities, relations, reviews, idempotency, and events.
- WAL and busy timeout for SQLite.
- Transactional legacy migration from the old single-payload table.
- Safe SQLite backup via temporary `VACUUM INTO` snapshot.
- Validated SQLite restore with reopen-on-failure safety.

### Interfaces

- JavaScript core.
- CLI.
- Local HTTP API with local binding, optional bearer auth, origin checks, body limits, persistence queues, and backend-aware restore/backup.
- MCP stdio server.
- Hermes adapter and integration examples.
- Static local dashboard.

### MCP

- Full mode advertises the complete tool surface for compatibility.
- Compact mode is enabled with `SHADOWGRAPH_MCP_COMPACT=1` and advertises ten core workflow tools.
- Retrieval supports explicit `limit`/`offset` paging and returns page metadata rather than silently truncating.

## Proven acceptance evidence

- Real Claude CLI sessions were run in clean isolated installations.
- Five-session persistence cycle verified decisions, alternatives, facts, failed attempts, outcomes, confidence, retrieval, review, and validation.
- Ten-pair initial decision comparison showed full MCP first-run overhead can be high; it did not measure warm repeated-work economics correctly yet.
- Full local suite reached 41 passing tests after compact mode regression coverage.
- `npm run check` passed.
- `npm audit --omit=dev` reported zero vulnerabilities.
- `git diff --check` passed.

## Known product limitations

1. First-run MCP token cost can be much higher than a plain Claude answer.
2. A complete ten-pair compact-mode token benchmark has not yet been run.
3. Existing context/retrieval behavior needs a formal completeness contract and benchmark for all paging paths.
4. The event collection exists but is not yet the complete canonical rebuildable ledger for every state transition.
5. Decision lifecycle states need explicit execution metadata, not only active/outcome combinations.
6. Reconsideration needs a first-class API and same-project changed-fact benchmark.
7. Confidence needs a richer basis: evidence classes, successful/failed outcomes, contradictions, and source strength.
8. Claude may refuse synthetic history; tests must use grounded events and inspect persisted data directly.

## Product metrics for the next program

- Full-fidelity event persistence rate.
- Restart recall of decisions, alternatives, reasons, facts, and failed attempts.
- Relevant changed-fact detection precision/recall.
- Repeated failed-attempt rate.
- First-run tokens, warm recall tokens, reconsideration tokens, total lifecycle tokens.
- Tool-call count, latency, and total cost.
- Decision rubric score and consistency.
- Confidence calibration against verified outcomes.
- Migration, backup, restore, and project-isolation correctness.

## Product-manager guardrails

Do not approve a redesign solely because it lowers the first prompt token count. Do not approve a summary that drops facts. Require a paired warm-task benchmark, migration plan, compatibility story, and persisted-state assertions before removing a current capability.
