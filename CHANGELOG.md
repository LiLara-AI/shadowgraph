# Changelog

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
