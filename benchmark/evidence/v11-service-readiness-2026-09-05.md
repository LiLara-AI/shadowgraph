# ShadowGraph v1.1 Service Readiness Record

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Baseline commit:** `1ba20a86c392e1fedcf82b41830fd5a60a4cebd5`
- **Commits recorded here:** `ae8570003e8cedcf093f12c75daf3b6eb2ce6e0f`, `6e7fb54`
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
| LB2 | Official runtime hosts unimplemented | Open | **Partly open** | Scope enlarged and enumerated below; LB2d and LB2e cleared by commit `6e7fb54` |
| LB3 | Implementation lock requires a clean committed tree | Open | **Cleared** | Tree is clean at `6e7fb54` |

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
| LB2d | **Cleared by `6e7fb54`.** Nothing installed the pinned wheel set into the pinned Python image. The executor spawned an interpreter with `PYTHONPATH` set empty against a bare `python:3.12.11-slim`, so every Python arm would fail at import | `benchmark/lib/python-adapter-executor.mjs` |
| LB2e | **Cleared by `6e7fb54`.** `benchmark/lib/python-container-runtime.mjs` was imported only by its own unit test. The executor did not route through `buildContainerInvocation`, so adapters would have run on the host interpreter rather than inside the pinned image | grep across `benchmark/` and `test/` |
| LB2f | Graphiti's adapter requires an audited exact group driver (`driver_for_group`) that pinned `graphiti-core` 0.29.3 does not expose | `benchmark/adapters/graphiti_adapter.py` |
| LB2g | No host is bound for the `control` or `node-mcp` runtime kinds, though `node-adapter-host.mjs` supplies the pieces one would be built from | `benchmark/lib/v11-run.mjs`, `benchmark/lib/node-adapter-host.mjs` |

## The Python Runtime, Built and Executed

LB2d and LB2e were closed the same day, in commit `6e7fb54`. What follows was
observed, not designed on paper.

`benchmark/cli.mjs v11-python-runtime` renders the committed wheel lock into a
`--require-hashes` requirement set and installs it inside the pinned image. The
result is verified symmetrically against the lock - a missing distribution and
an undeclared extra are both findings - and the recorded import probes must
pass, because a present distribution does not imply a working import.

Observed on 2026-09-05:

- 227 distributions installed, matching the lock exactly. No missing
  distribution, no version drift, nothing extra.
- All four Python arms' import probes passed: `mem0ai` 2.0.19,
  `graphiti-core` 0.29.3, `basic-memory` 0.23.2, `cognee` 1.5.3.

  **This sentence was wrong when first written, and the correction is worth
  stating.** As originally built, the probe ran only the competitor lock's
  `importProbe` string, which is `importlib.metadata.version(...)`. That
  resolves a `.dist-info` directory and never executes the package, so it could
  not have observed an import failure at all - least of all the Graphiti case
  this record went on to cite as the one that mattered, where the wheel installs
  `httpx2` and no `httpx` and the first clean import raises
  `ModuleNotFoundError` while the metadata resolves perfectly. The record
  claimed a property the harness did not check.

  The probe now imports the arm's module before reading its version, and the
  four results above are from that corrected probe, re-run in full. The
  distribution-to-module mapping is declared in `v11-python-runtime.mjs` and
  pinned by a test against the lock, because `mem0ai` imports `mem0` and
  `graphiti-core` imports `graphiti_core` and neither is derivable.
- All four adapters then executed **inside the pinned image**, importing from
  the read-only runtime mount, and returned well-formed protocol envelopes.

The runtime is installed beside the image rather than baked into a derived one.
A derived image would carry a local id and no registry digest, so it could not
satisfy the digest-pinned reference the container runtime requires, and it would
replace the interpreter the competitor lock names.

### A defect only a real invocation could find

`buildContainerInvocation` omitted `--interactive`. Docker gives a container no
stdin without it, so the host script read EOF and every real invocation failed.
Because the module had never been called by anything but its own unit test, this
had never surfaced - and when it did, it surfaced as an adapter fault rather
than as the launch defect it was. Fixed, with the reason recorded in a
regression test.

### What those envelopes actually said

The four responses were `FAILED`, correctly and for their own reasons. This is
LB2b, LB2c and LB2f, which the runtime work does not touch:

| Arm | Recorded failure |
| --- | --- |
| `mem0-oss` | `ENDPOINT_UNAVAILABLE` - "Pinned Mem0 runtime is not available" |
| `graphiti` | `CONTRACT_FAILURE` - "Graphiti adapter contract failed closed" |
| `cognee` | `CONTRACT_FAILURE` - "Cognee adapter contract failed closed" |
| `basic-memory` | `CONTRACT_FAILURE` - "Basic Memory adapter contract failed closed" |

Nothing in that table is a measurement, and none of it says anything about how
any product behaves. It says the transport works and the adapters refuse.

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
  pinned Python image, contains exactly what the lock names, and all four arms
  import from it - observed by a probe that performs the import, after the
  original metadata-only probe was corrected.
- All four Python adapters execute inside the pinned image against that runtime
  and return well-formed protocol envelopes.
- Frozen methodology files are byte-unchanged: `preregistration.json`,
  amendments 001-003, `acceptance/definition.json`, `acceptance/scenarios.json`.
- 2219 Node tests and 86 Python adapter tests pass, 0 failed, 0 skipped, 0 todo.

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
