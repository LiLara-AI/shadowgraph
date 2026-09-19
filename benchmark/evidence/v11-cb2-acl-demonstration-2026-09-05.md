# ShadowGraph v1.1 CB2: Cognee Access-Control Demonstration

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Commit:** `dc1f901`
- **Official run status:** **NOT STARTED**
- **Status:** the CB2 result stands. Everything this record says about the
  *rest* of the tree was true on 2026-09-05 and has since been overtaken -
  see the note below.

> **Overtaken in part.** This record's CB2 finding - Cognee 1.5.3 enforcing
> its native per-user ACL under the pinned backend pairing - is unchanged and
> is what `v11-preflight` still consumes. Four of its surrounding claims are
> no longer true of the tree: `cognee_adapter.py` no longer refuses a
> user-scoped request (it resolves the benchmark's user to a Cognee principal,
> and refuses a namespace *without* one); Mem0's and Cognee's client factories
> exist and both arms execute; LB2a and LB2b are cleared in
> `CANDIDATE-STATUS.md`; and a run given its runtime flags binds rather than
> refusing at `RUNTIME_UNAVAILABLE`. The current state is
> `v11-runtime-binding-2026-09-05.md` and
> `v11-adversarial-review-2026-09-05.md`.

## Decision

CB2 is cleared. With this demonstration and the service record from
`v11-service-readiness-2026-09-05.md` both presented, `v11-preflight` reports
**READY with zero blockers** for the first time in the v1.1 candidate's history.

Read that carefully. Readiness means the harness may start a run. It does not
mean a run would measure anything, and this record does not claim it would.
Three of the four Python arms still refuse at their client factory, which is
LB2b in `v11-adapter-runtime-blockers-2026-09-05.md`, and an attempted run
refuses at `RUNTIME_UNAVAILABLE` and writes no artifact.

## What the precondition turned out to be

The registry records that Cognee has a native user namespace whose use is
conditional on a *pinned backend access-control configuration*. That phrase had
never been resolved to anything a person could configure or check.

It resolves to a real, named posture in the product. Cognee 1.5.3 announces it
on import: multi-user access control is on by default, and is disabled with
`ENABLE_BACKEND_ACCESS_CONTROL=false`. The posture is not free-standing - the
library refuses it unless the configured stores can physically carry per-dataset
isolation, and it names which ones can. The supported file-backed pairing is
`lancedb` for vectors and `ladybug` for the graph.

Both are already present in the runtime built from `python-wheels.lock.json`, so
the configuration needs **no service beyond the common endpoint that is already
provisioned**. The alternative Neo4j path was examined and rejected: Cognee's own
Neo4j handler states multi-database management is Enterprise and Aura only, and
its community handler would run one container and one volume per dataset, images
that appear nowhere in `benchmark/service-images.json`.

## Why the demonstration is shaped the way it is

A refusal on its own proves very little. A misconfigured store, an absent
dataset or a mistyped identifier all produce a refusal, and none of them is an
access-control boundary. So every negative in this demonstration is paired with
a positive, and the decisive pair is the last one: the same call, by the same
user, against the same dataset, before and after an explicit grant. Only the
permission changed, so only the permission explains the difference.

`benchmark/lib/v11-precondition-evidence.mjs` enforces that as a contract rather
than trusting the probe to have done it. The required-step set is committed, and
a record missing any step establishes nothing - there is a test per omitted step
proving it, including the one that removes only the refusal.

## Observed

Run by `v11-precondition-probe` inside the pinned `python:3.12.11-slim` image
against the runtime mount, with `cognee` 1.5.3, `lancedb` vectors, `ladybug`
graph, `sqlite` relational, and `ENABLE_BACKEND_ACCESS_CONTROL=true`.

| Step | Observation |
| --- | --- |
| `posture` | `backend_access_control_enabled()` returned `True` under the file-backed pairing |
| `users` | two distinct principals created |
| `ingest` | both users ingested into a dataset named `shadowgraph-acl-probe` |
| `identical-name-distinct-datasets` | one name resolved to two different dataset ids |
| `positive-control-own-dataset` | the owner read its own dataset, 1 row |
| `cross-user-read-refused` | user A reading user B's dataset raised `PermissionDeniedError` |
| `listing-omits-other-dataset` | user A's dataset listing did not contain user B's dataset |
| `grant` | user B granted user A read permission on its dataset |
| `cross-user-read-allowed-after-grant` | the identical call then returned 1 row |
| `per-dataset-stores` | two `dataset_database` rows with distinct vector and graph store names |

Isolation here is physical rather than a filter: each dataset carries its own
`.lance.db` and `.lbug` store, named by dataset id under the owner's directory.

## The flag that used to stand in for this

`--preconditions` is now **refused by name** on both `v11-preflight` and
`v11-run`, with a message pointing at the probe. Removing it silently would have
left every script that passes it quietly weaker than it was, with no signal that
the guarantee had changed. The library-level `satisfiedPreconditions` parameter
remains for tests that drive applicability directly and is never populated by
the CLI.

## Stated limits

- This check cannot establish that the demonstration was ever performed. The
  record is a file, and a file can be written by hand. That limit is reported in
  the verification note, exactly as the service and immutable-prerequisite gates
  report theirs, and it is why the harness runs the probe itself.
- The demonstration proves the ACL Cognee enforces. It does **not** prove the
  benchmark would exercise that ACL: `cognee_adapter.py` refuses every
  user-scoped request outright, so the arm never reaches the boundary
  demonstrated here. CB2 was necessary for readiness; it is not sufficient for a
  measurement.
- The evidence expires. Six hours after the recorded instant it stops clearing
  anything, because the configuration a run executes under has to be the
  configuration that was demonstrated.
- Nothing here measures Cognee, or compares it to anything.

## Blocker state after this record

| ID | Blocker | State |
| --- | --- | --- |
| CB1 | Graphiti declared isolation the product lacks | Cleared, Amendment 003 |
| CB2 | Cognee pinned backend access-control configuration | **Cleared, this record** |
| CB3 | Graphiti required services | Cleared, service evidence |
| CB4 | Cognee required service | Cleared, service evidence |
| LB1 | Unconditional required-service blockers | Cleared |
| LB2a | `v11RuntimeDependencies()` unimplemented | Open |
| LB2b | Mem0, Graphiti and Cognee client factories refuse | Open |
| LB2c | Basic Memory storage attribution deferred | Open |
| LB2d | Pinned Python runtime | Cleared |
| LB2e | Container execution wiring | Cleared |
| LB2f | Graphiti exact group driver | Open, owner decision recorded |
| LB2g | No control or node-mcp runtime host | Cleared, commit `2a62d0e` |
| LB3 | Implementation lock needs a clean tree | Cleared |

`v11-preflight` is READY. The run path is not.

## Cleanup and state

- The demonstration writes into an operator-named working root outside the
  repository and leaves it there for inspection. It holds two probe users and
  two probe datasets, and nothing else depends on it.
- No credential was written into any repository file. The demonstration
  generates the probe passwords and the local API key at runtime.
- No push, merge, rebase, tag, publication, history rewrite or worktree deletion
  was performed. Version remains `0.40.0` and `private` remains `true`.
