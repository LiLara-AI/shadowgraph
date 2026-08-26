# ShadowGraph — Warm-Task Benchmark Plan

## Goal

Measure whether ShadowGraph creates value over a complete work lifecycle, not whether its first MCP call is cheaper than a plain answer.

## Arms

- Baseline Claude: no memory plugin.
- Current ShadowGraph full MCP.
- Current ShadowGraph compact MCP.
- Future redesigned ledger/reconsideration MCP.

Use clean, isolated data per arm. Do not put private data or secrets in benchmark fixtures.

## Ten matched scenarios

Use ten domains such as database choice, deployment, caching, API errors, migration, authentication, testing, performance, changed deployment constraints, and release/backup. Keep user task text and model settings identical; vary only memory availability and required tool surface.

## Five phases per scenario

### A — Fresh decision

Record chosen approach, two rejected alternatives with reasons, assumptions, evidence, lifecycle state, and initial confidence.

### B — Restart recall

Start a new CLI/MCP process. Ask for the prior decision and score recall of title, choice, alternatives, reasons, assumptions, evidence, and project.

### C — Repeated task

Ask the same or equivalent task. Score repeated-work avoided, consistency, contradiction, token usage, tool calls, latency, and cost.

### D — Changed fact

Add a grounded changed fact. Ask whether the earlier decision should be reconsidered. Score relevant trigger detection, false positives, evidence citation, recommendation, and confidence impact.

### E — Failed attempt

Record a real failed attempt, then ask for the task again. Score whether the agent avoids repeating the approach and cites the failure accurately.

## Metrics

### Economics

- input tokens;
- output tokens;
- cache read/write tokens if exposed;
- cost;
- number of turns and tool calls;
- elapsed time;
- total lifecycle cost across A–E.

### Memory fidelity

- decision persistence;
- alternative recall;
- rejection-reason recall;
- assumption/evidence recall;
- fact freshness and supersession;
- failed-attempt recall;
- project isolation;
- complete pagination behavior;
- validation status.

### Decision quality

Use a predeclared 0–2 rubric per criterion:

- constraint fit;
- evidence quality;
- alternative coverage;
- rejection rationale;
- risk recognition;
- reversibility/review trigger;
- changed-fact response;
- avoidance of known failure.

Do not score a decision higher merely because it matches the plugin's prior choice. Score against the task constraints and evidence.

### Confidence calibration (future; not implemented or measured in 0.31.0)

Record initial/current confidence, history, evidence basis, outcomes, contradictions, and whether later verified outcomes support the numeric value. Report mean calibration error once enough grounded outcomes exist; do not infer calibration from prose alone.

## Validity rules

- A session is valid only if its output JSON parses and persisted state confirms tool operations.
- A Claude refusal of synthetic history is not a product failure; replace the fixture with a grounded event.
- Never claim token savings from output length alone when usage metadata is available.
- Never compare a memory warm task against a baseline that was given extra context.
- Report incomplete sessions separately; never silently drop them.

## Deliverables

- Raw per-session JSON with usage metadata.
- Sanitized persisted-state assertions.
- Paired metric table.
- Quality rubric table.
- Failure/omission log.
- Recommendation: keep, redesign, or stop.
