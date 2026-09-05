# ShadowGraph v1.1: READY, and What F2 Actually Is

- **Date:** 2026-09-06
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Official run status:** **NOT STARTED**

Two things were observed today, not argued. The readiness gate reported **READY
with zero blockers** for the first time, and **F2 was re-measured** — against
every scenario at every frozen seed, and against two candidate models.

## READY, observed

```json
{
  "schema": "shadowgraph.v11.preflight",
  "scored": false,
  "containerImage": "python:3.12.11-slim@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f",
  "declaredCounts": { "totalUnits": 308, "excludedUnits": 20, "measuredUnits": 288, "resetUnits": 28, "outerDecisionCalls": 260 },
  "derivedCounts":  { "totalUnits": 308, "excludedUnits": 20, "measuredUnits": 288, "resetUnits": 28, "outerDecisionCalls": 260 },
  "readiness": "READY",
  "blockers": []
}
```

Declared and derived counts agree at 20 / 288 / 260, which is Amendment 003's
column. Both evidence records were produced by the harness against the live
stack, minutes before:

| Record | Command | Result |
| --- | --- | --- |
| `service-evidence.json` | `v11-service-probe` | neo4j 3/3 checks PASS, ollama 3/3 PASS, served models `qwen2.5:0.5b` and `nomic-embed-text:v1.5` with weight digests matching the lock |
| `precondition-evidence.json` | `v11-precondition-probe` | Cognee ACL, **10 of 10 steps PASS** — posture, users, ingest, identical-name-distinct-datasets, positive control, cross-user read refused, listing omits the other dataset, grant, cross-user read allowed after grant, per-dataset stores |

Both expire six hours after they were observed, so this is a statement about a
gate that was reached, not a standing state.

### One failure worth recording, because it was mine

The first service probe reported `cypher-statement FAIL, HTTP 400` against
Neo4j, where the same check had passed the day before with the probe code
unchanged. The cause was the credential I supplied, not the service:
`NEO4J_AUTH` in the container is Neo4j's own `user/password` form, and HTTP
Basic needs `user:password`. `serviceAuthorization()` base64-encodes whatever
the named variable holds, verbatim, so the separator has to be converted by
whoever exports it.

Confirmed both ways against the live endpoint: the raw form returns
`400 Neo.ClientError.Request.InvalidFormat, "Invalid authentication header."`,
and the converted form returns `200` with `{"row":[1]}`. The gate refused a run
because of an operator mistake and named it precisely, which is the behaviour it
is for.

## F2, re-measured

`benchmark/probes/v11_phase_a_decision_probe.mjs` runs Phase A through the
shipped `buildV11Prompt` and `requestOuterDecision` — not a re-implementation —
with the preregistration's frozen temperature, token cap, timeout and all three
seeds, over both scenarios loaded through `loadV11AcceptanceDefinition` so the
frozen sources and the scenario document are hash-gated. It decides nothing.

| Decision model | Accepted | Rejected | What the schema said |
| --- | --- | --- | --- |
| **`qwen2.5:0.5b`** (the pinned one) | **0 / 6** | 6 | 3 × `failedAttemptIdsAvoided must be an array of strings`, 3 × `Missing required decision response field: failedAttemptIdsAvoided` |
| `qwen2.5:3b` | **0 / 6** | 6 | 6 × `failedAttemptIdsAvoided must be an array of strings` |
| `qwen2.5:7b` | **6 / 6** | 0 | — |

F2 stands, and is now sharper than the record it replaces. It was filed as "0 of
4 Phase A attempts"; it is 0 of 6 across both scenarios and every frozen seed,
and **every** rejection is the same field. `qwen2.5:0.5b` fails it two different
ways depending on the scenario — wrong shape on `ACC_INCIDENT_HANDOFF`, absent
entirely on `ACC_SENSOR_REVIEW`. It is a capacity limit, not a prompt defect and
not a schema defect: the same prompt and the same schema are satisfied on every
attempt at 7B.

### What this means for the owner decision, and what it does not

The preregistration froze the decision LLM as unavailable:

> `"statusAtFreeze": "NOT_AVAILABLE"`, `"identity": null`,
> *"A later run may fill the identity only from a successful capability probe;
> doing so does not change scoring or thresholds."*

`benchmark/model-weights.lock.json` is where that identity was later filled in,
and it is **not** one of the four hash-gated frozen sources — those are
`preregistration.json` and amendments 001, 002 and 003. So naming a different
decision model appears to be inside the frozen methodology rather than an
amendment to it, provided a capability probe succeeded first. The table above is
that probe.

Weight-layer digests, read out of the serving container the way
`v11-service-probe` reads them (the `0.5b` value matches the committed lock
exactly, which is what says the reader is right):

| Model | Weight-layer digest |
| --- | --- |
| `qwen2.5:0.5b` | `sha256:c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515` |
| `qwen2.5:3b` | `sha256:5ee4f07cdb9beadbbb293e85803c569b01bd37ed059d2715faa7bb405f31caa6` |
| `qwen2.5:7b` | `sha256:2bada8a7450677000f678be90653b85d364de7db25eb5ea54136ada5f3933730` |

`qwen2.5:7b` reports architecture `qwen2`, 7.6B parameters, `Q4_K_M`, context
length 32768.

**The lock is not changed here.** Which model the acceptance run pins decides
what the run measures, and this record is evidence for that decision rather than
the decision itself. Three things would still have to follow it, and none has
been done:

1. `model-weights.lock.json` edited to the chosen model and its digest, which
   changes the implementation lock hash — expected, and recorded by the run.
2. A fresh `v11-service-probe`, because the current service record names
   `qwen2.5:0.5b` as a served model and the gate checks the lock against it.
3. A re-run of this probe against the committed lock, so the record says the
   pinned model passed rather than a candidate did.

## What this does not claim

- **No run was executed. No artifact exists.**
- **Six attempts are not a Phase A pass rate.** They say the schema was
  satisfied on every scenario and seed once. An acceptance run makes 260 outer
  decision calls across five phases; Phase A is the only one measured here.
- **Nothing here says the decisions were good**, only that they were shaped as
  the frozen schema requires. Quality is what a scored run would measure, and
  this acceptance is non-scored.
- **READY is a statement about evidence shape and freshness**, as its own note
  says: it cannot establish that a recorded probe was performed against the
  service it describes.
- **LB2f is untouched.** Graphiti's exact group driver remains blocked by owner
  decision.

## Reproduce

```
node benchmark/cli.mjs v11-service-probe --endpoints <endpoints.json> --out <path>
node benchmark/cli.mjs v11-precondition-probe --runtime <site> --work <root> \
  --llm-endpoint http://127.0.0.1:11434/v1 --embedding-endpoint http://127.0.0.1:11434/v1/embeddings
node benchmark/cli.mjs v11-preflight --service-evidence <path> --precondition-evidence <path>
node benchmark/probes/v11_phase_a_decision_probe.mjs --endpoint http://127.0.0.1:11434/v1
node benchmark/probes/v11_phase_a_decision_probe.mjs --endpoint http://127.0.0.1:11434/v1 --model qwen2.5:7b
```

`SHADOWGRAPH_NEO4J_AUTH` must hold `user:password`, converted from the
container's `user/password`.
