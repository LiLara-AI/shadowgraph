# ShadowGraph v1.1 Service Readiness Record

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Baseline commit:** `1ba20a86c392e1fedcf82b41830fd5a60a4cebd5`
- **Commit recorded here:** `ae8570003e8cedcf093f12c75daf3b6eb2ce6e0f`
- **Product version:** `0.40.0`
- **Official run status:** **NOT STARTED**

## Decision

The official v1.1 acceptance run is still blocked. Do not start it and do not
report a comparative result, ranking, or "best" claim. No benchmark unit has
been executed, so this document contains no measured result.

This record supersedes nothing in
`benchmark/evidence/v11-blocker-matrix-2026-09-03.md`, which remains the
historical statement of that date. It records what has since been cleared, what
has not, and two implementation blockers that the earlier matrix did not
enumerate because they sit below the level it examined.

## Blocker Movement Since 2026-09-03

| ID | Blocker | State on 2026-09-03 | State now | Cleared by |
| --- | --- | --- | --- | --- |
| CB1 | Graphiti declared user isolation the product does not have | Open | **Cleared** | Owner-approved Amendment 003, commit `1ba20a8` |
| CB2 | Cognee pinned backend access-control configuration unproven | Open | **Open** | Nothing; see below |
| CB3 | Graphiti required services unprovisioned | Open | **Cleared** | Verified service evidence, this record |
| CB4 | Cognee required service unprovisioned | Open | **Cleared** | Verified service evidence, this record |
| LB1 | `required-service` blockers emitted unconditionally | Open | **Cleared** | Commit `ae85700` |
| LB2 | Official runtime hosts unimplemented | Open | **Open** | Nothing; scope enlarged, see below |
| LB3 | Implementation lock requires a clean committed tree | Open | **Cleared** | Tree is clean at `ae85700` |

`node benchmark/cli.mjs v11-preflight` with no evidence presented still reports
three blockers. With the evidence recorded below presented, it reports exactly
one:

```text
readiness: NOT READY
verified services: neo4j, ollama
blockers:
  - applicability DECLARED_ISOLATION_PRECONDITION_UNMET cognee
    precondition: pinned backend access-control configuration
```

`node benchmark/cli.mjs v11-run --service-evidence <path>` with the same
evidence returns `REFUSED` and writes no artifact.

## What LB1 Now Requires

Readiness clears a required service only when an operator presents a probe
record that survives verification against the files this repository already
commits. The verification is in `benchmark/lib/v11-service-evidence.mjs` and
covers: the recorded image reference must equal `benchmark/service-images.json`
byte-for-byte; the resolved digest must be a well-formed `sha256:` reference;
every recorded check must have outcome `PASS`; the record and every check must
be within a six-hour freshness window and not future-dated; and any service that
claims to serve models must serve every model in
`benchmark/model-weights.lock.json` with a digest that matches the lock exactly.

Absence verifies nothing. There is no default path a record is read from - the
operator must name one with `--service-evidence` - and no flag that overrides a
blocker.

**Stated limit.** This check cannot establish that the recorded probe was ever
performed. The record is a file and a file can be written by hand. That is the
same limit the three immutable-prerequisite gates carry, it is reported in each
blocker's `note`, and it is why `v11-service-probe` exists: the harness writes
the record from probes it performs, so the available path is to produce evidence
rather than compose it.

## Captured Evidence

Both services were provisioned from the amd64 manifest digests recorded on
2026-09-03, and both digests resolved and pulled unchanged.

| Item | Captured value | Method |
| --- | --- | --- |
| Neo4j service | `neo4j:5.20`, digest `sha256:99a767ef6f5573cd72d6d7f32c5266233af3c58efdc71577349a7c251d8ecb3b` | Pulled by digest; container `shadowgraph-v11-neo4j` |
| Ollama service | `ollama/ollama:0.33.2`, digest `sha256:9e7d782e99880c70f9563c51633da875ca605518a8f8d95c2532bda70a027b7a` | Pulled by digest; container `shadowgraph-v11-ollama` |
| Neo4j HTTP | HTTP 200 at the root interface | `v11-service-probe`, check `http-status` |
| Neo4j Cypher | `RETURN 1 AS ok` returned 1 over an authenticated session | `v11-service-probe`, check `cypher-statement` |
| Common endpoint chat | HTTP 200 from `/v1/chat/completions` for `qwen2.5:0.5b` | `v11-service-probe`, check `openai-chat-completions` |
| Common endpoint embeddings | HTTP 200 from `/v1/embeddings`, 768 dimensions, for `nomic-embed-text:v1.5` | `v11-service-probe`, check `openai-embeddings` |
| Decision LLM weights | `sha256:c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515` | Read from the serving container's own model manifest; matches `model-weights.lock.json` |
| Embedding weights | `sha256:970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6` | Read from the serving container's own model manifest; matches `model-weights.lock.json` |
| Image identity | Both containers run the layer chains their committed tags resolve to | `v11-service-probe`, check `image-identity` |
| Pinned wheel set | All 227 packages install into the pinned Python image under `--require-hashes`, including `graphiti-core==0.29.3`, `cognee==1.5.3`, `mem0ai==2.0.19`, `basic-memory==0.23.2`, `httpx==0.28.1` | `pip install --require-hashes` from `python-wheels.lock.json` |

The probe record and the endpoint description are operator run evidence and are
not committed. Their hashes at capture time:

```text
service-evidence.json:
bdbc3b173d482ced002bd1be020fedda3ed20a22b14696c92154ef26485eb92f

service-endpoints.json:
cdf4e5c851e6b0aae1b0318ecad880ba5d01d436331a213eb13eaa27f677ac7e
```

No credential appears in either artifact or in this document. The Neo4j password
was generated for this provisioning, is held outside the repository, and is
supplied to the probe through an environment variable named by the endpoint
description.

### Two container-runtime facts worth recording

1. A digest-pinned pull and a tag pull are **distinct local image entries with
   distinct ids** on this runtime: `neo4j:5.20` resolves to
   `sha256:52d3dec8…` while the amd64 manifest digest inside it is
   `sha256:99a767ef…`. Comparing image ids therefore reports a mismatch between
   a correctly pinned live container and the very tag it was pinned from. The
   identity check compares filesystem layer chains instead, which are identical
   across both reference forms.
2. `competitors.lock.json` pins `pythonImage` as
   `python:3.12.11-slim@sha256:47ae396f…`, which is that runtime's local content
   digest for the tag rather than the registry index digest
   (`sha256:0b29ab9e…`). This has not been changed and is noted only so a future
   reader does not treat the difference as tampering.

## Remaining Blockers

### CB2 - Cognee pinned backend access-control configuration

Unchanged and deliberately untouched. Provisioning hosts does not and must not
clear it: it is a claim about the product's behaviour, not about a host.
`--preconditions` is an input rather than proof, and asserting the precondition
on the command line would manufacture a clearance.

A truthful clearance requires a behavioural artifact: Cognee 1.5.3 running
against a pinned backend with access control configured, and a recorded
demonstration that one user's dataset is not readable by another. That
demonstration cannot be produced before the Cognee runtime exists, which is LB2.

### LB2 - Official runtime hosts, larger than previously recorded

The 2026-09-03 matrix recorded LB2 as "implement real metered hosts". Reading
the adapter layer shows the work is wider than that. Each item below was read
from source, not inferred.

| ID | Blocker | Evidence |
| --- | --- | --- |
| LB2a | `v11RuntimeDependencies()` throws `RUNTIME_UNAVAILABLE` | `benchmark/cli.mjs` |
| LB2b | Three of four Python adapters refuse at their client factory pending "Task 8": Mem0, Graphiti and Cognee each raise `RuntimeUnavailable` from `_default_client_factory` | `benchmark/adapters/mem0_adapter.py`, `graphiti_adapter.py`, `cognee_adapter.py` |
| LB2c | Basic Memory has a real client factory, but its storage measurement is declared not available pending an exact native byte-attribution method | `benchmark/adapters/basic_memory_adapter.py` |
| LB2d | Nothing installs the pinned wheel set into the pinned Python image. The executor spawns an interpreter with `PYTHONPATH` set empty, and the image is bare `python:3.12.11-slim`, so every Python arm would fail at import | `benchmark/lib/python-adapter-executor.mjs` |
| LB2e | `benchmark/lib/python-container-runtime.mjs` is imported only by its own unit test. The executor does not route through `buildContainerInvocation`, so adapters would run on the host interpreter rather than inside the pinned image | grep across `benchmark/` and `test/` |
| LB2f | Graphiti's adapter requires an audited exact group driver (`driver_for_group`) that pinned `graphiti-core` 0.29.3 does not expose | `benchmark/adapters/graphiti_adapter.py` |
| LB2g | No host is bound for the `control` or `node-mcp` runtime kinds, though `node-adapter-host.mjs` supplies the pieces one would be built from | `benchmark/lib/v11-run.mjs`, `benchmark/lib/node-adapter-host.mjs` |

LB2d is the one piece this record can report as *feasible rather than merely
required*: the committed wheel lock resolves and installs cleanly under
`--require-hashes` into the pinned image, so a reproducible Python runtime for
all four arms is buildable from the bytes already committed. Nothing about where
that runtime should be mounted, or how it reaches the pinned image's read-only
filesystem, has been decided or implemented.

## Proven vs. Not Measured

### Proven

- Both required services can be provisioned from their recorded digests, answer
  their protocols, and serve exactly the model weights the lock pins.
- A verified probe record clears CB3 and CB4, and every degraded form of that
  record - absent, stale, future-dated, malformed, image-mismatched,
  digest-mismatched, partially failing, or covering only one service - leaves the
  corresponding blocker standing. Each of those directions has a regression test.
- `v11-preflight` and `v11-run` answer readiness identically when evidence is
  presented, which is asserted by running both commands with the flag.
- The pinned 227-package wheel set installs under `--require-hashes` into the
  pinned Python image.
- Frozen methodology files are byte-unchanged: `preregistration.json`,
  amendments 001-003, `acceptance/definition.json`, `acceptance/scenarios.json`.
- 2193 Node tests and 86 Python adapter tests pass, 0 failed, 0 skipped, 0 todo.

### Not Measured

- No official v1.1 unit executed. No reset evidence exists.
- No quality, latency, token, cost, storage, cleanup, or per-arm metric was
  measured.
- No raw run, aggregate, implementation lock, environment lock, service lock,
  evidence index, review bundle, provider reconciliation, ranking, or
  comparative claim exists.
- Nothing here establishes that Cognee enforces user isolation, or that any
  competitor behaves in any particular way.

## Cleanup and State

- Containers `shadowgraph-v11-neo4j` and `shadowgraph-v11-ollama` and the
  network `shadowgraph-v11` were created for this capture and are still running.
  They hold no benchmark data and can be removed without affecting any recorded
  result.
- `nomic-embed-text:v1.5` was pulled so the immutable tag the weight lock names
  is present. Its weight layer is byte-identical to the `latest` tag already
  present, which is the relationship the 2026-09-03 record describes.
- No credential was written into any repository file.
- No push, merge, rebase, tag, publication, history rewrite, or worktree
  deletion was performed. Version remains `0.40.0` and `private` remains `true`.
