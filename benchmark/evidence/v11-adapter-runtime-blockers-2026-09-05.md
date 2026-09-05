# ShadowGraph v1.1 Adapter Runtime Blockers (LB2b)

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Scope:** the three pinned Python adapters that refuse at their client factory
- **Official run status:** **NOT STARTED**

## Decision

**No real client factory can be written for Mem0, Graphiti or Cognee against the
pinned versions without either an owner decision or a methodology amendment.**

This is a result, not a pause. Every claim below was verified by reading the
pinned library source and by running read-only probes inside the pinned image
against the runtime built from `benchmark/python-wheels.lock.json`. No adapter
was changed, and nothing was written to make an arm appear runnable.

The companion record `v11-service-readiness-2026-09-05.md` closed LB2d and LB2e:
the runtime exists and adapters execute inside the pinned image. What that
exposed is that the three refusals are not placeholders waiting to be filled in.
Each one sits on a capability the pinned library does not have.

## What a factory has to satisfy

`client = await await_native(client_factory(runtime_config, provider_calls))`.
The returned object must expose exactly the members its adapter calls, and it
must drive `provider_calls(request_class)` once per real outbound request,
because the envelope's `internalMemoryModelCalls` and `embeddingCalls` are read
from those counters. Per operation the adapters assert:

| Arm | reset | retrieve | persist | verify |
| --- | --- | --- | --- | --- |
| `mem0-oss` | zero both | embedding >= 1, LLM == 0 | embedding >= 1, LLM == 0 | zero both |
| `graphiti` | zero both | embedding >= 1, LLM == 0 | both >= 1 | zero both |
| `cognee` | zero both | embedding >= 1, LLM == 0 | both >= 1 | zero both |

`require_zero` is the demanding half. A counter that cannot observe a request
the library issued and then failed cannot support it.

## Mem0 - BLOCKED

Everything about the *data* path is real and was measured, not assumed. A live
`add(infer=False)` then `get_all` cycle inside the pinned image returned the
encoded record byte-identical, kept all three benchmark metadata keys, and
returned zero rows under the alternate `{agent_id, user_id}` scope. Mem0's two
native scopes are a genuine intersection, so nothing about its isolation would
have to be manufactured. Every method the adapter calls exists with the exact
signature it uses.

The blockers are in the transport, and they are structural:

| # | Blocker | Evidence |
| --- | --- | --- |
| M1 | No per-request notification seam on the embedder. `OpenAIEmbedding.__init__` builds `OpenAI(api_key, base_url)` with no `http_client` and no callback | `mem0/embeddings/openai.py:35` |
| M2 | No supported extension point on the side that carries the traffic. `LlmFactory` exposes a provider registry; `EmbedderFactory` exposes only `create` and a plain class dict | `mem0/utils/factory.py:152-168` |
| M3 | No retry control. Both clients run at the OpenAI SDK default of two retries, and no config field reaches it. The adapter's own `_runtime_config` declares `automatic_retries: 0` | pinned library; `mem0_adapter.py` runtime config |
| M4 | The Qdrant store lazily loads `fastembed` BM25 weights from a hardcoded external host on the write path, unmetered, and swallows failure into a warning | `mem0/vector_stores/qdrant.py:93-108` |
| M4 (closed) | Closed 2026-09-05 by the loopback-only network fence and the offline gates in `python_host`, demonstrated by `v11-fence-probe`. M4 turned out to be one of four such paths, one of them in basic-memory | `v11-unpinned-model-fence-2026-09-05.md` |

M4 deserves emphasis because it fails *soft*. The benchmark would record a run
in which an arm silently fetched model weights from a host that appears in
neither `providerRoutes` nor `model-weights.lock.json`, and nothing in the
harness would notice.

**The one decision that would unblock Mem0** is whether a factory may rebind
`memory.llm.client` and `memory.embedding_model.client` after construction to
equivalent SDK clients carrying `max_retries=0` and a counting transport. That
is real HTTP through the real SDK on the real mem0 code path - it is not a stub
- but it depends on undocumented internals, and it is a capability the pinned
library does not offer. It is recorded here as an owner decision rather than
taken as configuration.

## Graphiti - BLOCKED

Confirms and sharpens LB2f. Five of the six members a factory must return can be
bound to real pinned symbols: `EntityNode`, `EpisodicNode` and `EpisodeType` all
exist with the classmethod signatures the adapter uses.

The sixth cannot. `graphiti_adapter.py` refuses without a callable
`driver_for_group(group_id)`, and its own test poisons the shared driver with
the name `unscoped-default-must-not-be-used`, so the requirement is that the
driver handed to a group operation reaches exactly that group.

| Fact | Evidence |
| --- | --- |
| `GraphDriver.clone(database)` returns `self` - the identity function - and `Neo4jDriver` does not override it | pinned `graphiti_core.driver.driver` |
| `GraphDriver.with_database(database)` returns a shallow copy with a private field changed, reusing the same connection | pinned `graphiti_core.driver.driver` |
| `neo4j:5.20` is Community edition and refuses `CREATE DATABASE` with `Neo.ClientError.Statement.UnsupportedAdministrationCommand` | live probe against the provisioned container |
| Cognee's own Neo4j handler states multi-database management is Enterprise and Aura only | pinned `cognee` Neo4j dataset database handler |

So a per-group database is impossible with the pinned service, and group scope
remains a property filter inside one database. Anything supplied to satisfy the
gate would assert a boundary the deployment does not provision.

The owner reviewed this and chose to leave Graphiti blocked rather than change
the pinned service image or the declared backend. Recorded here as the standing
decision.

## Cognee - BLOCKED, on three independent grounds

### C1. Dataset identity is the library's, not the caller's

The benchmark derives a dataset id itself:
`deterministic_dataset_uuid(adapter_id, project_id)` is
`uuid5(<benchmark namespace>, "cognee:<projectId>")`.

Cognee 1.5.3 derives it from the dataset name **plus the acting user's id and
tenant id**, and its own documentation for that function states that passing a
name resolves to, or creates, a different dataset owned by the caller. A
caller-chosen UUID is therefore unreachable: the id the adapter computes can
never be the id cognee assigns.

This blocks the arm on its own, independently of CB2.

### C2. The adapter refuses every user-scoped request

`cognee_adapter.py` raises `ContractError("Cognee user ACL is not locked for
benchmark execution")` whenever `namespace.userId` is not null. The benchmark
therefore never exercises the ACL that CB2 is about. Clearing CB2 is necessary
for readiness and not sufficient for a measurement.

### C3. Retry floors are not configurable to zero

The embedding engines are wrapped in `stop_after_delay(128)`, and the LLM path
retries on a delay floor as well. The adapter declares `automatic_retries: 0`
and carries a `retry_proof`. A cognee arm run under that declaration would be
recording a retry count the library does not honour.

## CB2 is separately answerable, and cheaper than it looked

Independently of whether the cognee arm can ever run, the blocker that stands in
`v11-preflight` has a concrete answer. In cognee 1.5.3 the "pinned backend
access-control configuration" is a real, named posture, and the library announces
it on import: multi-user access control is on by default and is disabled with
`ENABLE_BACKEND_ACCESS_CONTROL=false`.

Its compatibility gate requires backends that can physically carry per-dataset
isolation. The supported pairings include `lancedb` for vectors and `ladybug` or
`kuzu` for the graph - all file-backed, all present in the built runtime, none
requiring a service beyond the two already provisioned. Isolation is realised as
one vector store and one graph store per dataset, recorded in a relational
`dataset_database` table.

The alternative `neo4j_community` handler manages a Docker container and a
volume **per dataset**, needs a reachable Docker daemon from inside the adapter
container, and would run images that are not in `benchmark/service-images.json`.
That is a new provisioning claim, and it is not free.

A truthful demonstration under the file-backed pairing would: assert the posture
resolves to enabled; create two users; give each a dataset; show the two dataset
ids differ even for an identical name; show one user's search of the other's
dataset raises `PermissionDeniedError`; grant read permission and show the same
search then succeeds; and record the two per-dataset store rows. The refusal is
then provably the ACL and not an accident of configuration.

## What was NOT done

- No adapter was modified. All three factories still refuse.
- No dataset, user, permission or store was created in any product.
- The CB2 demonstration above is a specification, not a result. It has not been
  run, and CB2 remains an open blocker.
- No unit was executed, and no measurement of any kind exists.

## Required next decisions

| # | Decision | Consequence if declined |
| --- | --- | --- |
| D1 | ~~May a factory rebind mem0's constructed SDK clients to set `max_retries=0` and count real requests?~~ **Answered 2026-09-05:** yes, and it is implemented. The arm now executes reset/persist/verify/retrieve against the real service, metered, with one request per call. See `v11-mem0-execution-2026-09-05.md` | resolved |
| D2 | ~~Which vector store may Mem0 use, given the pinned Qdrant path makes an unmetered external fetch?~~ **Answered 2026-09-05:** its own default local Qdrant in `path=` mode. The store was never the problem - the runtime was not closed. See `v11-unpinned-model-fence-2026-09-05.md` | resolved |
| D3 | ~~Does the Cognee arm adopt library-assigned dataset ids, which requires amending the frozen deterministic-uuid scheme?~~ **Answered 2026-09-05:** yes, and no amendment was needed - no frozen file mentions datasets or uuids. The computed id did not merely differ: it made every write fail with a 403 against an empty store. See `v11-cognee-dataset-identity-2026-09-05.md` | resolved |
| D4 | Is a retry floor the library does not let us disable acceptable, or does `automatic_retries: 0` stand? | Cognee, and Mem0 under D1, stay blocked |
| D5 | Should the CB2 demonstration be built and run under the file-backed pairing, to clear the last preflight blocker even though the arm cannot execute? | CB2 stays open and readiness stays NOT READY |

None of these is a decision this record takes.
