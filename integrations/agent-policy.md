# ShadowGraph agent policy

Use ShadowGraph as a decision ledger, not as unquestioned truth.

## Before consequential work

1. Call `shadowgraph_context` for the project.
2. Call `shadowgraph_retrieve` for the task and inspect related facts, failed attempts, and superseded decisions.
3. Treat `model_inferred` and `unverified` facts as hypotheses.

## During work

1. Record a decision with its chosen approach, assumptions, evidence, and rejected alternatives.
2. Record each failed or informative attempt and its lesson.
3. Record facts with provenance, verification status, expiry, and project.
4. Use relationships to connect decisions, facts, attempts, and evidence.
5. Supply an idempotency key when retrying a tool call.

## After work

1. Record the outcome.
2. Update the decision status.
3. Call `shadowgraph_maintain` when facts or time-sensitive conditions changed.
4. Review and acknowledge open review signals; do not silently continue from a stale decision.

## Privacy and integrity

- Never store secrets or full sensitive transcripts unless explicitly permitted.
- Use `shadowgraph_redact` for exports.
- Use project purge only after a dry-run or backup and explicit confirmation.
- Call `shadowgraph_validate` when importing or recovering data.
