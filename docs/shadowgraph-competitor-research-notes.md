# ShadowGraph — Competitor Research Notes

Research snapshot used only to inform design, not to copy implementation.

## Mem0

Repository: https://github.com/mem0ai/mem0

Observed positioning: universal memory layer, multi-level user/session/agent state, memory extraction, retrieval evaluation, and token-efficiency research. Lesson for ShadowGraph: evaluate memory on recall and total work, but do not replace decision evidence with a lossy extracted summary.

## Graphiti

Repository: https://github.com/getzep/graphiti

Observed positioning: real-time temporal context graphs, relationships, temporal awareness, and an MCP server. Lesson for ShadowGraph: temporal facts, event ordering, and explainable graph relationships matter. ShadowGraph remains decision-first rather than generic entity memory.

## Letta

Repository: https://github.com/letta-ai/letta

Observed positioning: stateful agents with persistent memory that can learn and improve. Lesson for ShadowGraph: continuity and explicit state management matter. ShadowGraph must additionally preserve rejected alternatives, reasons, outcomes, and reconsideration triggers.

## MCP server ecosystem

Repository: https://github.com/modelcontextprotocol/servers

Observed positioning: interoperable tool servers for agents. Lesson for ShadowGraph: tool surface design strongly affects prompt overhead; workflow-oriented tools can reduce schema cost, but every operation still needs a complete durable contract.

## Synthesis

Do not copy any product. The independent ShadowGraph design target is:

```text
full-fidelity decision/event ledger
+ explicit provenance
+ failed-attempt memory
+ evidence-calibrated confidence
+ deterministic changed-fact reconsideration
+ local-first portable persistence
+ compact but lossless MCP workflows
+ warm-task economics benchmark
```
