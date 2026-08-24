# Changelog

## 0.27.0

- Added bounded relationship traversal with direction, depth, and relation filters.
- Added explicit same-project decision supersession with persisted `supersedes` relationships.
- Added privacy-safe redacted exports and permanent project purge controls across HTTP, CLI, and MCP.
- Added multi-term explainable search and matching HTTP, CLI, and MCP surfaces.

## 0.26.0

- Rewrote the user-facing README and integration guide to explain the context, decision, work, observe, evaluate, and reconsider workflow.
- Added practical setup guidance for MCP clients, HTTP clients, JSON/SQLite storage, and optional Bearer authentication.
- Added optional Bearer-token authentication for shared local HTTP deployments.
- Added constant-time token comparison and SQLite WAL verification.
- Added project-scoped fact supersession, localhost port compatibility, no-store headers, and CLI search filters.
- Added final release hardening and v0.26 documentation parity.

## 0.25.0

- Added selectable JSON/SQLite storage through `SHADOWGRAPH_STORAGE`, including WAL mode and a 5-second busy timeout for concurrent SQLite writers.
- Added decision lifecycle statuses, relationships, retrieval filters, and expanded MCP tools.
- Added concurrency-safe JSON saves and broader integration tests.

## 0.2.0 - 2026-08-24

- Redesigned the core as a versioned decision graph.
- Added project scopes, structured facts, evidence provenance, outcomes, confidence history, and event history.
- Added explainable search and the `shadowgraph_context` MCP tool.
- Added migration compatibility for v0.1 decision records.
- Added fact, outcome, context, and review HTTP/CLI surfaces.
- Added an optional Node 22.5+ `node:sqlite` storage adapter; JSON remains the zero-dependency default.

## 0.1.0 - 2026-01-01

- Added unified decision and rejected-alternative graph.
- Added persistent JSON storage.
- Added CLI, local HTTP API, and MCP stdio server.
- Added integration templates for MCP and generic HTTP clients.
