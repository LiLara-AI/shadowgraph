# ShadowGraph v1.1 D1: The Mem0 Arm Executes

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Official run status:** **NOT STARTED**

## Decision

D1 is answered: a factory may rebind Mem0's constructed SDK clients to set
`max_retries=0` and count real requests. It is implemented, and it works.

**For the first time in this candidate's history, an arm has executed a
benchmark unit end to end** - reset, persist, verify, retrieve - against the
real pinned service, with the real pinned library, through the real adapter
contract, metered.

Read the scope carefully, because it is narrow. This is not a run. No artifact
exists and nothing was scored. What is now true is that the blocker that said
Mem0 *cannot* execute is false.

**Superseded, in this record's own terms.** When this was written the run path
had no provider meter and no bound Python hosts, and this paragraph said so.
Two later commits in the same range bound both - see
`v11-runtime-binding-2026-09-05.md` - so `v11-run` no longer refuses at
`RUNTIME_UNAVAILABLE` for that reason, and Cognee has since executed too. The
sentences are corrected rather than deleted because a record that quietly
reads as current when it is not is the failure mode this candidate keeps
finding in itself.

## What the blocker was

`v11-adapter-runtime-blockers-2026-09-05.md` records three transport blockers,
and they were accurate:

| # | Blocker |
| --- | --- |
| M1 | No per-request notification seam on the embedder. `OpenAIEmbedding.__init__` builds `OpenAI(api_key, base_url)` with no `http_client` and no callback |
| M2 | No supported extension point on the side that carries the traffic |
| M3 | No retry control. Both clients run at the OpenAI SDK default of two retries, and no config field reaches it |

M3 mattered most. The adapter's `_runtime_config` declared `automatic_retries: 0`
and nothing enforced it, so a declaration the harness would have recorded as a
property of the run described nothing at all - and the frozen retry rule forbids
exactly the thing that leaves no trace:

> "No transparent retry during measured units. Diagnostic retries are separately
> identified and never substituted."

## What the factory does

It builds `Memory.from_config` with Mem0's own default local store, then
replaces the two constructed clients:

```
OpenAI(api_key=<unused slot>, base_url=<metered route>, max_retries=0,
       http_client=httpx.Client(transport=<counting transport>))
```

Three things are worth stating precisely.

**Nothing about memory behaviour changes.** Same class, same base URL, same
model, same store. What changes is the retry count the adapter already declared,
and that a counter now sits on the wire.

**The count is taken at the transport, not at the call site.** A retry is a
second request for one call. A ledger taken where the call is made would agree
with the meter by construction and could never observe the thing it exists to
observe.

**The credential slot is filled with a non-credential.** Mem0 builds both
clients during construction and the OpenAI SDK refuses to exist without a key,
while `python_host` strips every real one from the environment before an adapter
is imported. The endpoint is the benchmark's own metered proxy and authenticates
nothing.

The store is Mem0's own default: local Qdrant in `path=` mode under the state
leaf the executor owns, which needs no service. That was D2, answered in
`v11-unpinned-model-fence-2026-09-05.md`.

## The demonstration

`benchmark/probes/mem0_execution_demonstration.py`, run by
`benchmark/cli.mjs v11-arm-probe --arm mem0-oss` against the pinned image, the
pinned 227-package runtime and the pinned Ollama. Every operation runs in its own
forked process, which is what the container executor does - and is required, not
merely faithful, because qdrant-client's local mode holds a file lock for the
life of a client.

| Step | Outcome | What it observed |
| --- | --- | --- |
| `reset-succeeds-against-the-real-store` | PASS | SUCCEEDED |
| `persist-succeeds-and-really-embeds` | PASS | SUCCEEDED with **1** embedding request seen at the proxy |
| `the-adapter-ledger-agrees-with-an-independent-count` | PASS | adapter 1 embedding / 0 chat; proxy 1 / 0 |
| `no-transparent-retry-reaches-the-endpoint` | PASS | one request per reported call |
| `persist-with-infer-false-asks-no-chat-model` | PASS | 0 chat requests |
| `a-process-that-did-not-write-it-finds-the-record` | PASS | persistence verified from a different process |
| `the-other-user-namespace-does-not-see-it` | PASS | isolation verified against `user-2` |
| `retrieve-returns-the-stored-decision-through-a-real-search` | PASS | 1 native record, 1 embedding request |
| `retrieve-ledger-also-agrees-with-the-proxy` | PASS | adapter 1/0, proxy 1/0 |

Each claim is paired with what would look identical if it were false. The
adapter's count is checked against one taken by a proxy the adapter did not
write. Persistence is read by a process that did not write it, because a store
read back in the writing process demonstrates memory. Isolation is checked
against a namespace that was never written, and is only meaningful because the
owning namespace found the record in the step above. Retry control is checked by
counting requests rather than by reading a config field, because
`max_retries=0` in an object is a claim and one request per call on the wire is
an observation - the SDK default of two retries would have made those two
numbers disagree.

## Two things this cost, recorded because they are the useful part

**The seam shipped with a bug and no test could have caught it.** The factory
passed the OpenAI *class* where the module was expected, so every construction
raised `AttributeError`, the adapter classified it as `OPERATION_FAILED`, and
the demonstration reported four red steps. Nothing in the suite touched
`_bind_metered_client`, because its only caller is the default factory and every
adapter test injects a fake. There are now seven tests on that seam, and nine
mutations - including that exact one - are caught.

**The probe's own first version reported three green steps under four red
ones.** The count comparisons were satisfied by `0 == 0`, so an arm that never
ran passed them most easily of all. Every count step is now conditioned on the
operation having succeeded and on the count being non-zero. This is the third
time on this branch that a check has been found to pass for a reason unrelated
to what it claimed, and it is worth naming the pattern rather than just fixing
the instance: a comparison between two things that are both absent is not
evidence.

**And a third, observed by accident.** A diagnostic run outside `python_host` -
so without the gates and without the network fence - downloaded eighteen files
from HuggingFace mid-write, which is the BM25 fetch that
`v11-unpinned-model-fence-2026-09-05.md` documents as U2. It is one thing to
read that in a source file and another to watch it happen during a write that
was otherwise succeeding. The fenced runs make no such request.

## What this does not claim

- **No run was executed and no artifact exists.** `v11-run` refuses without
  its runtime flags and evidence records; given both it binds, and F2 is why
  a run would still measure nothing.
- **Nothing here is a measurement.** The scenario content is a fixture, one
  record, one namespace pair. Nothing about Mem0's quality, latency or cost is
  observed or implied.
- **Only Graphiti has never executed.** When this was written the other three
  had not either; Basic Memory and Cognee have since executed a real operation
  in the pinned container. Graphiti is held by LB2f - the exact group driver,
  an open owner decision - not by its backend: the pinned Neo4j is running and
  the arm reaches its runtime and refuses there.
- **This is not the harness's meter.** The proxy is a second observer built for
  the demonstration. Wiring the real meter into the run path was open when this
  was written and is done: `v11RuntimeDependencies` starts the real meter, and
  the run reconciles its own ledger against its own record.
- **One embedding request per operation is what this configuration produced**,
  not a general property. Mem0's `search` was called at its library defaults.

## Reproduce

```
node benchmark/cli.mjs v11-arm-probe --arm mem0-oss \
  --runtime <runtime-site> \
  --work <writable-root> \
  --model-endpoint http://127.0.0.1:11434/v1
```

The models come from `model-weights.lock.json`, not from the command line. Exit
status is non-zero when any step fails. The record is written to
`benchmark/probe-records/mem0-oss-execution-evidence.json`, which is untracked.
