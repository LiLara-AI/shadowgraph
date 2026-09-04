# ShadowGraph v1.1 Benchmark Blocker Matrix

- **Date:** 2026-09-03
- **Operator:** Hermes Agent
- **Worktree:** `/mnt/c/benchmark-engineering/worktrees/shadowgraph-v1.1`
- **Branch:** `benchmark/v1.1-methodology-repair-glama-sync`
- **Baseline commit:** `c918aba54627ee095538f3df9a846c07d9334317`
- **Product version:** `0.40.0`
- **Official run status:** **NOT STARTED**

## Decision

The official v1.1 acceptance run is blocked. Do not start it and do not report a comparative result, ranking, or "best" claim. No benchmark unit has been executed, so this document contains no measured result.

`v11-preflight` currently reports four blockers: the Graphiti isolation contradiction, the Cognee ACL precondition, Graphiti's required services, and Cognee's required services. The decisive one is the frozen-methodology/product contradiction: Graphiti 0.29.3 is declared to support user isolation, but recorded introspection proves it has no native user namespace. Encoding a user identifier into `group_id` would manufacture isolation and is prohibited.

Separate later implementation blockers are recorded in their own section below so they are never counted among the four current preflight blockers.

## Captured Evidence

| Item | Captured value | Status |
| --- | --- | --- |
| Graphiti version | `0.29.3` | Captured from `benchmark/competitors.lock.json` and probe evidence |
| Graphiti user methods | None | Captured in `benchmark/evidence/probe-graphiti-0.29.3.json` |
| Graphiti node user fields | None | Captured in `benchmark/evidence/probe-graphiti-0.29.3.json` |
| Graphiti usable scope | `group_id` / `group_ids` only | Captured in probe evidence |
| Qwen model weight layer | `sha256:c5396e06af294bd101b30dce59131a76d2b773e76950acc870eda801d3ab0515` | Captured from the local Ollama model manifest |
| Nomic embedding weight layer | `sha256:970aa74c0a90ef7482477cf803618e776e173c007bf957f635f1015bfcfef0e6` | Captured from the local Ollama model manifest |
| Ollama image | `ollama/ollama@sha256:020e4134285e2ef4d8fd801234176de3b4faadc992a3eb06c8e66a2f9d4c4ba2` | Captured by Docker image inspection |
| Neo4j image | `neo4j@sha256:52d3dec8d45585b21edeca8517d752b2512e52aa94f80fc36a5788c88c95f8e4` | Captured by Docker image inspection |
| Python adapter image | `python@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f` | Captured by Docker image inspection; matches competitor lock |
| Common model endpoint | Docker Ollama `/v1/chat/completions` and `/v1/embeddings` returned HTTP 200 | Captured during temporary local provisioning |
| Cognee ACL capability | Native user ACL exists; exact harness precondition is `pinned backend access-control configuration` | Captured from `benchmark/evidence/probe-cognee-1.5.3.json` and registry |
| Wheel resolution | 227 packages, 3,885 SHA-256 entries | Captured from `uv pip compile --python-version 3.12 --generate-hashes` |

## Lock Files Written

| File | SHA-256 | Contents |
| --- | --- | --- |
| `benchmark/service-images.json` | `338e52faa1e8b16009b48f5c00531c508bac90da8971357d15a358add28eb592` | Canonical digest-pinned service manifest: Neo4j 5.20 and Ollama |
| `benchmark/model-weights.lock.json` | `73ba075195e769e5ba0c198548a03ca8917d056bab47b132ed7e379e1a9379bd` | Full LLM and embedding model weight-layer identities |
| `benchmark/python-wheels.lock.json` | `8ea4a19d0d8fe3736be2793dc8603a2843f30cad48d83928b74a3ac0f1f4cc86` | 3,885 wheel hashes from the 227-package resolver output |

## Current v11-preflight Blockers

`node benchmark/cli.mjs v11-preflight` exits non-zero and reports exactly these four blockers. No fifth blocker is currently reported, and none of the four is omitted here.

| ID | Preflight kind and code | Arm | Blocker | Captured evidence | Required next action |
| --- | --- | --- | --- | --- | --- |
| CB1 | `applicability` / `DECLARED_ISOLATION_UNAVAILABLE` | `graphiti` | Graphiti 0.29.3 has no native user namespace although Amendment 002 declares user isolation `SUPPORTED` | `probe-graphiti-0.29.3.json`: zero user-scoped methods and zero user fields; `group_id` is the only scope | Owner review and a new amendment only; do not edit frozen Amendment 002 or the acceptance definition, and do not encode a user into `group_id` |
| CB2 | `applicability` / `DECLARED_ISOLATION_PRECONDITION_UNMET` | `cognee` | Cognee 1.5.3 has native user ACL capability, but the pinned backend access-control configuration is not proven | `probe-cognee-1.5.3.json` records real ACL methods; no pinned backend ACL configuration or enforcement evidence exists | Establish and capture a real pinned backend ACL configuration; the CLI `--preconditions` flag is an input, not proof |
| CB3 | `required-service` | `graphiti` | Required service is unprovisioned: Neo4j-compatible graph database plus common LLM and embedding endpoint | Preflight emits the descriptor's `requiredService` string verbatim | Provision and bind a verified Neo4j-compatible database and the common endpoint; do not mark the service satisfied without a health probe |
| CB4 | `required-service` | `cognee` | Required service is unprovisioned: common LLM and embedding endpoint | Preflight emits the descriptor's `requiredService` string verbatim | Provision and bind the verified common endpoint; do not mark the service satisfied without a health probe |

## Later Implementation Blockers (Not Current Preflight Blockers)

These do not appear in the current `v11-preflight` output. They would block an official run after every current preflight blocker is cleared, and they are listed separately so the four blockers above are not inflated.

| ID | Blocker | Evidence | Impact | Required next action |
| --- | --- | --- | --- | --- |
| LB1 | `required-service` blockers are emitted unconditionally, with no provisioning or health input | `benchmark/lib/v11-run.mjs` pushes every descriptor's `requiredService` with no readiness parameter | CB3 and CB4 cannot be cleared by provisioning alone; the harness has no way to record a verified service | Add a verified service-health input after the Graphiti methodology decision; never default it to satisfied |
| LB2 | Official runtime hosts are intentionally unimplemented | `benchmark/cli.mjs` `v11RuntimeDependencies()` throws `RUNTIME_UNAVAILABLE`; `createV11AdapterExecutor` refuses an arm whose runtime kind has no host | Even a READY preflight cannot launch the official run | Implement real metered hosts; preserve the frozen adapter contract and the no-retry policy |
| LB3 | Implementation lock requires a clean committed tree | `benchmark/lib/implementation-lock.mjs`: `Repository must be clean before creating or verifying an implementation lock` | No implementation-lock hash, evidence index, or review bundle can bind an uncommitted tree | Commit approved truthful benchmark changes locally, then generate and verify the implementation lock |

## Count Reconciliation

Frozen Amendment 002 / acceptance definition declares:

- 308 total units
- 16 excluded units
- 292 measured units
- 28 reset units
- 264 outer decision calls

If an owner-approved amendment changes only Graphiti user isolation from `SUPPORTED` to `NOT_APPLICABLE`, the mechanically derived counts become:

- 308 total units
- 20 excluded units
- 288 measured units
- 28 reset units
- 260 outer decision calls

Those replacement counts are **inferred from the frozen plan topology**, not measured results. They are not valid until an owner approves and freezes the amendment.

## Proven vs. Not Measured

### Proven

- The frozen Graphiti declaration conflicts with the pinned product API.
- The common local/free model and embedding endpoint can be served by a digest-pinned Docker Ollama image.
- Model weight layers, Docker images, and Python wheel hashes were captured without fabricating identities.
- The three immutable-prerequisite gates clear when their truthful files are present.
- The service-manifest gate rejects a mutable tag and accepts only `repository@sha256:<64-hex>`, proven by a regression test that failed before the gate change.
- `node --test test/benchmark-v11-cli.test.js test/benchmark-v11-run.test.js`: 21 passed, 0 failed, 0 skipped, 0 todo.
- `npm run benchmark:test`: 908 Node benchmark tests passed and 86 Python adapter tests passed, 0 failed, 0 skipped, 0 todo.

### Not Measured

- No official v1.1 unit executed.
- No reset evidence exists.
- No quality, latency, token, cost, storage, cleanup, or per-arm metric was measured.
- No raw run, aggregate, implementation lock, evidence index, review bundle, ranking, or comparative claim exists.

## Cleanup and State

- Temporary `shadowgraph-ollama` Docker container was removed.
- No temporary Ollama process remains running.
- No credentials were created or stored in repository files.
- No package version changed; it remains `0.40.0`.
- The benchmark prerequisite/evidence work is committed locally on `benchmark/v1.1-methodology-repair-glama-sync` only. No push, merge, rebase, tag, publish, or history rewrite occurred, and no worktree was deleted.
- Frozen methodology files were not edited: `benchmark/preregistration.json`, `benchmark/preregistration-amendment-002.json`, `benchmark/acceptance/definition.json`, and `benchmark/acceptance/scenarios.json` are unchanged.

