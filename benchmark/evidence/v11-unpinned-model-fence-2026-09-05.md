# ShadowGraph v1.1: The Unpinned-Model Fence

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Official run status:** **NOT STARTED**

## Decision

D2 is answered, and the answer is not the one the question expected.

D2 asked which vector store Mem0 may use, because the pinned Qdrant path makes
an unmetered external fetch. Mem0 may use its own default: local Qdrant in
`path=` mode, which needs no service. That is demonstrated below, writing and
reading a record with the fetch impossible.

The store was never the problem. Investigating it surfaced something larger:
**the pinned runtime is not closed.** Four paths inside the measured arms reach
model weights or reference data the lock does not name, none of them visible to
the provider meter. One of them is in the arm the definition records as making
no provider call at all.

This record documents what was found, what closes it, and what the closure was
demonstrated to do.

## What was found

| # | Arm | Path to an unpinned model | Source |
| --- | --- | --- | --- |
| U1 | basic-memory | `semantic_search_enabled` defaults to *whether `fastembed` and `sqlite_vec` are importable*. Both are. The arm then embeds and searches every note with its own `bge-small-en-v1.5`, downloaded on first use | `basic_memory/config_models.py:64-70, 252-297` |
| U2 | mem0-oss | `create_col` creates a `bm25` sparse slot on every new collection, so the insert path calls `_get_bm25_encoder`, which pulls `Qdrant/bm25` from HuggingFace and swallows failure into a warning | `mem0/vector_stores/qdrant.py:93-108, 144-163, 202-232` |
| U3 | cognee | LiteLLM downloads its model-cost map at import unless told to use the copy in the wheel | `litellm/__init__.py:391, 505` |
| U4 | cognee | Embedding-tokenizer resolution reaches HuggingFace, and the documented fallback reaches tiktoken's CDN | `cognee/infrastructure/llm/tokenizer/resolver.py`; `tiktoken_ext/openai_public.py:19-63` |

U1 is the serious one, and it deserves to be stated plainly rather than
tabulated. Basic Memory does not depend on fastembed by accident of our
packaging - it *requires* it, unconditionally. All four arms share one
site-packages. So the moment the runtime was built to hold every arm, Basic
Memory's own default flipped semantic search on, and the arm whose entire
declared shape is "local files, no model, no provider call" began embedding with
a model that appears in no lock and passes through no meter.

The adapter asserts `provider_calls.require_zero()`, and its test asserts the
arm "uses no provider or outer call". Both statements were true about the
metered seam and false about the process. That is the same shape of defect as
the metadata-only import probe corrected earlier on this branch: a claim the
harness makes that the harness cannot observe.

U2 fails soft, which is worse than failing. A machine with network access
downloads the weights and stores sparse vectors; a machine without gets a
warning and stores none. Same code, same lock, different stored state.

## The frozen rules already forbid this

No amendment is required, and none was made. Two rules that were frozen before
any of this was written settle it:

> `/definitions/providerMetering/rule` - "Product-internal LLM and embedding
> calls must be metered via local proxy or equivalent"

> `/commonExecution/sameConfigurationRule` - "A result is MEASURED only when
> every measured arm uses the exact same LLM id, embedding id, endpoint build,
> temperature, token limits, seeds, machine, scenario text, and repetition
> count."

An arm embedding locally with `bge-small-en-v1.5` while the others embed through
the meter with `nomic-embed-text:v1.5` satisfies neither. The reproducibility
requirements add a third: "full immutable embedding model digest" and "embedding
dimension", which an unpinned fastembed model has neither of.

So this is conformance work. The runtime was not doing what the method already
said it must.

## What closes it

Two layers, because one is not enough.

**Environment gates**, in `python_host.GATES`, applied per invocation before any
adapter is imported: `BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED=false`,
`BASIC_MEMORY_RERANKER_ENABLED=false`, `LITELLM_LOCAL_MODEL_COST_MAP=True`,
`HF_HUB_OFFLINE=1`, `HF_DATASETS_OFFLINE=1`, `TRANSFORMERS_OFFLINE=1`. These
close the four paths named above at the place each library documents.

**A loopback-only network fence**, in the same host, for the duration of the
adapter call. Gates close the paths that are known; the fence closes the ones a
library adds in its next release, by taking the `socket` module's egress and
resolution surface rather than by naming libraries.

**Corrected.** This paragraph originally claimed the fence closed egress "by
construction rather than by enumeration", and listed four entry points:
`socket.socket.connect`, `connect_ex`, `socket.create_connection` and
`socket.getaddrinfo`. It was an enumeration, and an incomplete one. An
adversarial review demonstrated two holes against the production module inside
the pinned image:

- **A datagram needs no connection.** `sock.sendto(payload, ("192.0.2.1", 9))`
  returned the byte count with the fence installed and active, and `sendmsg`
  the same. `dnspython` is in the pinned 227-package runtime and resolves this
  way, so this was not hypothetical.
- **`socket.gethostbyname` does not route through `getaddrinfo`.** It resolved
  a public hostname and returned its address while `getaddrinfo` in the same
  block raised `NetworkFenceError`.

The fence now guards ten entry points, named once in `FENCED_ENTRY_POINTS` and
read from that one list by the save, the guard table and the restore:
`socket.connect`, `socket.connect_ex`, `socket.sendto`, `socket.sendmsg`,
`create_connection`, `getaddrinfo`, `gethostbyname`, `gethostbyname_ex`,
`gethostbyaddr` and `getnameinfo`. `send` and `sendall` are deliberately
absent: reaching them requires a `connect` the fence refuses.

The honest description is that list, and the part that *is* by construction is
the container's own network namespace - which is the stronger guarantee, and is
available only to an arm that meters nothing (`--network none`). A metered arm
shares the host namespace so the meter and the pinned endpoints are reachable
on 127.0.0.1, and for that arm this fence is the barrier.

Name resolution is fenced for its own reason. Refusing the connection but
allowing the lookup would still put the hostname on a resolver's wire, which is
an observation of what the process is doing that the benchmark did not
sanction.

The fence costs the benchmark nothing. Loopback is the whole of what a measured
unit needs - the container shares the host network namespace precisely so the
provider meter, the pinned model endpoint and the pinned graph database answer
on 127.0.0.1. AF_UNIX is untouched, because SQLite, LanceDB and Kuzu are
file-backed and fencing them would break local storage for no gain.

## The demonstration

`benchmark/probes/unpinned_model_fence_demonstration.py`, run by
`benchmark/cli.mjs v11-fence-probe` against the pinned image and the pinned
227-package runtime. It imports the gate from `python_host` rather than
restating it, so what is demonstrated is what the harness applies.

It is paired, for the same reason the ACL demonstration is: a refusal on its own
proves very little, because a probe that never reached the fetch looks exactly
like one that was correctly stopped. Every negative is shown against its
positive.

| Step | Outcome | What it observed |
| --- | --- | --- |
| `basic-memory-default-embeds-with-an-unpinned-model` | PASS | semantic search **True** via `fastembed/bge-small-en-v1.5` |
| `without-the-fence-the-bm25-fetch-leaves-the-process` | PASS | 2 recorded attempts to `huggingface.co` |
| `the-gate-turns-basic-memory-semantic-search-off` | PASS | semantic search False, reranker False |
| `the-fence-refuses-the-bm25-fetch-with-nothing-on-the-wire` | PASS | refused; **0** attempts reached the socket layer |
| `the-fence-refuses-the-basic-memory-embedding-fetch-with-nothing-on-the-wire` | PASS | refused; **0** attempts reached the socket layer |
| `loopback-still-answers-inside-the-fence` | PASS | connected to a real loopback listener and was accepted |
| `mem0-writes-locally-under-the-fence-with-bm25-unavailable` | PASS | stored and read back a record with the BM25 encoder unavailable |

The second row is the one that makes the fourth mean something. Without the
fence, the real library really does reach for `huggingface.co` - twice, observed
at the socket layer by a recorder that refuses rather than downloads. With the
fence, the same call against the same library records zero attempts.

The last row is D2's answer in behaviour rather than prose: Mem0's default local
Qdrant works, on disk, with no service, with the unpinned fetch impossible. What
the fence removes is the sparse vector Mem0 itself documents as unavailable
without the `[extras]` install - which is the configuration this runtime's
dependency set actually describes, since Mem0 declares `fastembed` only under
`extra == 'extras'` and no other extras package is installed.

## What this does not claim

- **No run was executed.** No measurement of any kind exists.
- **The fence is not proven against arms that have not run.** Graphiti and
  Cognee have never executed a unit; the fence is demonstrated against the
  libraries and against Mem0's store, not against a completed arm.
- **U3 and U4 are closed by gate, not by demonstration.** The LiteLLM cost map
  and the tokenizer paths are gated and fenced, but no probe yet exercises
  Cognee's tokenizer resolution under the fence. Its own module documents that
  resolution "never raises" and falls back to TikToken, which the fence will
  also refuse; whether that fallback then raises is untested here and is a real
  risk to the Cognee arm. It will surface loudly rather than silently, which is
  the point, but it is not yet known.
- **Nothing here clears a preflight blocker.** The fence is a property of the
  measured runtime, not a gate input.

## Reproduce

```
node benchmark/cli.mjs v11-fence-probe \
  --runtime <runtime-site> \
  --work <writable-root>
```

Exit status is non-zero when any step fails. The record is written to
`benchmark/probe-records/fence-evidence.json`, which is untracked. It is
deliberately not under `benchmark/results/` - the candidate sweeps the working
tree for any directory of that name, because "this candidate has produced no
benchmark result" is a claim a reader should be able to check by looking.
