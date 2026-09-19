# ShadowGraph v1.1 D3: Cognee Assigns Dataset Ids, and This Arm Adopts Them

- **Date:** 2026-09-05
- **Worktree:** `benchmark/v1.1-nonscored-acceptance`
- **Official run status:** **NOT STARTED**

## Decision

D3 asked whether the Cognee arm adopts library-assigned dataset ids, and warned
that doing so might require amending the frozen deterministic-uuid scheme.

It does adopt them, and **no amendment was required**, because no frozen file
mentions datasets or uuids at all. `preregistration.json`,
`preregistration-amendment-001/002/003.json`, `acceptance/definition.json` and
`acceptance/scenarios.json` were each searched: the only hit is the word
"deterministic" in an unrelated sentence in `preregistration.json`. The scheme
lived entirely in adapter code, so this is a code change.

The question turned out to have a sharper answer than "which id is nicer". The
computed id **did not work at all**.

## What was observed

The adapter computed `uuid5(COGNEE_DATASET_UUID_NAMESPACE, f"{arm}:{project}")`,
passed it to `cognee.add(..., dataset_id=...)`, and refused any dataset whose
name matched but whose id did not.

Cognee derives its own id in `create_dataset` via `get_unique_dataset_id`, which
namespaces the dataset name by the owning user and the tenant. A UUID handed to
`add` is not a request to use that id - it is a reference to a dataset that
already exists and that the caller holds write permission on.

Against the real pinned library, with real file-backed stores:

| | |
| --- | --- |
| id the adapter computed | `38c7ac55-f508-54db-8648-7eaa4e86f3de` |
| id Cognee assigns | `2412219d-bd88-5d61-9250-94368aef15a8` |
| result of `add(dataset_id=<computed>)` | `PermissionDeniedError` (403) - "Request owner does not have necessary permission: [write] for all datasets requested" |
| datasets in the store afterwards | **none** |

So the arm would not have been storing under a different id. It would not have
been storing at all, and every persist would have failed with a permission error
against an empty store.

## What changed

The name is the arm's; the id is the library's.

- `_resolve_dataset(datasets, name)` matches by **name only** and returns the
  dataset, whatever id it carries. Two datasets sharing the name make "the arm's
  dataset" ambiguous, which is a refusal rather than a choice.
- `add` is called with `dataset_name` and **no** `dataset_id`.
- Persist then lists datasets and adopts the id Cognee assigned, and hands that
  to `cognify`. The listing sits between the two writes because nothing before
  the add can know the id.
- Reset and verify resolve by name and use the id they find.
- A retrieve with no dataset yet searches nothing and says so: empty context,
  zero provider calls. Naming the dataset to Cognee's search would create it,
  and inventing an embedding call to satisfy the adapter's traffic contract
  would be worse than reporting what happened.
- `deterministic_dataset_uuid` and `COGNEE_DATASET_UUID_NAMESPACE` are deleted
  rather than left for someone to reach for. `deterministic_native_uuid` stays:
  a *record* id is ours to assign, nothing else assigns it, and the adapter
  needs it stable across processes.

## The demonstration

`benchmark/probes/cognee_dataset_identity_demonstration.py`, run by
`benchmark/cli.mjs v11-arm-probe --arm cognee`. It is paired: the negative half
shows the computed id is not the library's and that supplying it is refused
outright; the positive half shows the same add succeeding by name and the
adapter's own resolver - imported, not restated - finding that dataset.

| Step | Outcome |
| --- | --- |
| `the-id-this-adapter-used-to-compute-is-not-the-one-cognee-assigns` | PASS |
| `supplying-the-computed-id-is-refused-and-creates-nothing` | PASS |
| `adding-by-name-creates-the-dataset-under-the-library-s-id` | PASS |
| `the-adapter-finds-it-by-name-and-adopts-that-id` | PASS |
| `a-second-add-under-the-same-name-reuses-the-same-dataset` | PASS |
| `both-records-landed-in-that-one-dataset` | PASS |

Even a question about dataset identity needs a model endpoint, because Cognee's
`add` runs a pipeline that tests the LLM connection before it will ingest
anything. That is why the probe configures the pinned service the way the ACL
demonstration does, with the `openai/` prefix on the completion model and the
bare id on the embedding model - the same asymmetry the adapter's runtime config
carries, for the same reason.

The unit tests were changed to match. The fake now assigns its own dataset id
from the name and refuses a supplied id it has never seen, which is what the
real library does; before this it keyed its store by whatever id the caller
passed, so it agreed with the adapter by construction and could not have
disagreed. Five mutations - matching by id as well as name, resolving two
same-named datasets to the first, naming an id on the add again, never adopting
the assigned id, and searching with no dataset - are all caught.

## What this does not claim

- **Both of the bullets that used to stand here are now false, and that is
  the correction.** When this was written Cognee's client factory raised
  `RuntimeUnavailable` and the adapter refused any `userId`, so this record
  said it was fixing the identity an arm would have used rather than the
  runtime it would have used it in. A later commit in the same range
  implemented the factory and inverted the refusal - a namespace *without* a
  user is what is refused now - and Cognee executes. See
  `v11-runtime-binding-2026-09-05.md` (F3) and the LB2b row in
  `CANDIDATE-STATUS.md`.
- **Nothing here says a unit was measured.** Cognee has executed one `reset`;
  retrieve, persist and verify have not been exercised against it.
- **No run was executed and no artifact exists.**
- **`cognify` was not exercised.** The probe adds and lists; it does not build a
  graph, so nothing here says the ingestion pipeline completes.

## Reproduce

```
node benchmark/cli.mjs v11-arm-probe --arm cognee \
  --runtime <runtime-site> \
  --work <writable-root> \
  --model-endpoint http://127.0.0.1:11434/v1
```

The record is written to
`benchmark/probe-records/cognee-execution-evidence.json`, which is untracked.
