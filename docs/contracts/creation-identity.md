# Ordinary creation identity

ShadowGraph generates canonical entity IDs. `addDecision`, its nested
`alternatives`, `addAttempt`, `remember`, `addFact`, and `link` reject any
caller-supplied creation `id` with `creation_id_not_allowed` and the message
`Caller-supplied creation IDs are not supported`. Presence is sufficient:
undefined, null, empty, malformed and inherited IDs are also refused by the
library, without reading their values or looking up occupancy.

`applyMemoryPlan` rejects `id` on its envelope and every operation before any
operation runs. ADD/UPDATE create new versions; DELETE/NOOP select memory by
project/origin, user/agent/run scope, type and key. Their `id` is not a target
reference and is also refused. All alternatives are preflighted before a
decision retry; all plan operations are preflighted before retry or content
NOOP handling. A late policy violation cannot leave partial changes.

Omit creation IDs and retain returned `id`, `memory.id`, or
`results[].memory.id`. Existing reference arguments remain supported: decision
and fact IDs, relationship endpoints, traversal roots, review-signal IDs,
replacement IDs and `relatedTo`. `idempotencyKey` is a separate operation
identity, scoped by owner and operation (and exact identity for memory); it
recovers the original canonical ID without assigning one.

Allocation checks the global entity namespace, including stored alternatives,
and reserves all IDs in one decision. It retries collisions internally up to
128 times per entity. Exhaustion returns `entity_id_allocation_failed` with a
generic message; no candidate or occupancy is exposed. Transaction rollback
also covers exhaustion after an earlier memory-plan operation. Journal/event
identifiers and authority identifiers retain their existing domains.

CLI, HTTP, full MCP and the advertised compact MCP creation tools use this
policy. Compact MCP does not advertise relationship creation. A supported
JSON-RPC batch containing a creation-ID policy violation is refused before any
member is dispatched, including notifications and reads with durable effects.
Legacy replies use a JSON-RPC error; modern tool replies use `isError: true`.
This is creation-policy preflight, not a general transaction over MCP batches.

Stored historical IDs and references remain intact. Import, replacement,
backup/restore, replay and migration retain their existing validated identity
contracts. There is no schema/version bump or storage rewrite for this policy.
Older binaries still accept caller creation IDs and retain the F-33 occupancy
oracle; they are not an F-33-safe operational rollback target. Existing older
binary limitations for scoped views and downgrade attribution loss also remain.

The benchmark adapter stores logical benchmark identity plus exact content in
its native text encoding (v2), separate from the returned `nativeEntityId`.
Fresh retrieval/restart checks decode persisted content and identity; they do
not depend on a sidecar map. Existing v1 records remain readable. Benchmark
prompts, scoring, preregistration and campaign thresholds are unchanged.
