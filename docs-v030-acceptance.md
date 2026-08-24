# ShadowGraph v0.30 local acceptance criteria

This build is considered the strongest practical local v0.30 decision-memory build when all of the following pass:

- Capture: decisions, assumptions, alternatives, evidence, facts, attempts, outcomes, confidence, events, and relationships.
- Time: fact expiry, decision aging, review dates, maintenance, and persistent open/acknowledged review signals.
- Causality: traversal, supersession chains, replacement protection, and graph-aware retrieval with explanations.
- Trust: provenance, verification states, redacted exports, project-scoped purge preview, permanent purge, and privacy tests.
- Reliability: JSON/SQLite persistence, migration, revision conflict detection, idempotent retries, backup/restore, integrity validation, and repair plans.
- Interfaces: JavaScript core, HTTP, CLI, MCP tools, MCP resource, MCP prompt, dashboard, and agent policy assets expose the same important lifecycle.
- Safety: local-only default, optional token auth, body/origin checks, no accidental publishing, no secrets in tests or fixtures.
- Verification: full local tests, syntax checks, audit, package dry-run, Python validation, and two independent Claude audits with no critical/high/medium findings.

This is a practical v0.30 scope, not a claim that no future research or optimization is possible.
