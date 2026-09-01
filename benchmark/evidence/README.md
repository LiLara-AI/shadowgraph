# v1.1 candidate evidence

Offline, read-only evidence captured while repairing the v1.1 methodology. These
files record what was observed. They are **not** a benchmark result, an
acceptance outcome, a readiness determination, a score, or a ranking, and nothing
here authorises an official run.

## Offline-capability probe (Basic Memory)

`probe-basic-memory-0.23.2.json`. The executor spec declares
`requestClasses: []` for `basic-memory`, i.e. that the arm issues no provider
traffic at all. That claim needed testing rather than trusting, because the
package **declares `openai>=1.100.2` as a dependency** — if any adapter
operation reached it, the spec would be false and the traffic would go
unmetered.

Ran the adapter's own operation sequence inside the pinned image with
`--network none`, so any provider call would fail rather than succeed
silently:

| Operation | Result |
| --- | --- |
| `create_memory_project` | succeeded |
| `write_note` | succeeded |
| `search_notes` | succeeded |
| `list_memory_projects` | succeeded |
| `delete_project` | **failed** — see below |

**That table was wrong, and the conclusion drawn from it was wrong.** It is kept
here because the mistake matters more than the tidy version.

`search_notes` does not raise on failure — it returns a *rendered error string*.
The probe recorded "succeeded" for a call that had actually failed, because it
measured "did not throw" rather than "worked". Re-run with the returned text
inspected for failure markers:

| search type | outbound call attempted | result |
| --- | --- | --- |
| **default — what the adapter used** | **yes** | `Connection failed (ConnectError: Temporary failure in name resolution)` |
| `hybrid` | yes | same failure |
| `text` | **no** | `total: 1`, the written note returned |

Basic Memory defaults to **embedding-backed hybrid retrieval**, which reaches a
provider. So `requestClasses: []` was **false for the adapter as written**: a
real run would have emitted provider traffic the spec says this arm does not
have — therefore unmetered — or failed every retrieve once metering was
enforced.

Fixed at the source: retrieval now names `search_type="text"` explicitly rather
than inheriting a product default. With that, `create`, `write`, `read`, `list`
and `search` all complete under `--network none`, and the empty declaration
becomes true. `write_note` and `read_note` were never network-dependent.

### A defect this exposed, confirmed against the adapter's own call shape

`delete_project` failed with *"Cannot delete default project … This is the only
project in your configuration."* That is the call the adapter makes during
**RESET**.

The first probe used `set_default=True`, which the adapter does not, so the
result could have been an artifact of an unfaithful test. It was re-run with the
adapter's exact call shape — `create_memory_project(project, path,
set_default=False, workspace=None, output_format="json")` then
`delete_project(project, delete_notes=True, workspace=None)` — and the failure
reproduced, on the first reset and again on a second cycle.

The reason it always reproduces: a fresh store reports
`{'projects': [], 'default_project': 'main'}`, i.e. **no projects at all**. The
arm's project is therefore always the only project, so the product always
refuses to delete it. RESET could never establish a clean namespace for this
arm.

Fixed at the source rather than worked around per-call: reset now ensures a
second genuine native project — `shadowgraph-benchmark-reset-anchor` — exists
before deleting the arm project, so the arm project is never the last one
standing. The anchor is a real product project, never an arm namespace, and
never carries benchmark records, so it manufactures no isolation.

**Why the existing tests missed it:** the fake client in
`test_basic_memory_adapter.py` deleted unconditionally, so it accepted a call
the product refuses. A fake more permissive than the product cannot catch a
sequence the product would reject. The fake now enforces the same constraint,
and the reset path has regression cover.

### The full lifecycle now completes

`reset -> persist -> retrieve -> reset` succeeds against the real product under
`--network none`, with `embeddingCalls: 0` and `internalMemoryModelCalls: 0`,
and retrieve returns the persisted decision record with its content intact.

Two further mismatches had to be bridged to get there, both hidden by a fake
that was shaped more conveniently than the product.

**A search hit is not a record.** A hit carries `content`, `entity`,
`entity_id`, `external_id`, `file_path`, `metadata`, `permalink`, `score`,
`title`, `type` and `updated_at` — so it *does* include the note body. What it
lacks is the shadowgraph frontmatter: its `metadata` is only
`{"note_type": "note"}`, with no record id, type or digest. A hit therefore
cannot become a logical record however much body it carries. Retrieve reads each
hit back through the same call verify uses, so retrieve and verify agree on what
a stored record is.

**A note is not shaped like a logical record.**
`read_note(output_format="json", include_frontmatter=False)` returns
`{title, permalink, file_path, content, frontmatter}`. Three things differ from
what `logical_record` looks for: the metadata sits under `frontmatter` rather
than `metadata`, the identifier is `title` rather than `name`, and the body
comes back with a leading newline the writer never supplied. Until these were
mapped, **every retrieve and every verify failed `CONTRACT_FAILURE` against the
real product while passing against the fake** — so the verify path was broken
too, not only retrieve.

The body is stripped blind because the product adds the whitespace. That is only
safe because the frontmatter carries the content digest, so a strip that ever
changed meaning is rejected by `logical_record` rather than silently accepted.
There is a test for exactly that.

### The arm was not provider-free until the vector index was closed

The claim that the empty declaration "becomes true" once retrieval names the
text index was **wrong**, and only surfaced when independent review instrumented
`socket.getaddrinfo` rather than checking whether operations succeeded.

Basic Memory maintains a local vector index whose sync scheduler fetches an
embedding model from `huggingface.co` on the **write** path — so
`search_type="text"` does not prevent it. Under `--network none` the fetch fails
and is swallowed as a background-task failure, which is why every operation
still reported SUCCEEDED and the adapter's own counters stayed at zero. It is a
model *download*, not a metered inference call, so the counters were honest and
useless here.

Two things made this worth closing rather than declaring. With a network
available — which a real run needs for the other arms — the fetch succeeds and
nothing accounts for it. And once the model lands, local vector sync starts
working and behaviour diverges between networked and isolated runs, which is
precisely the reproducibility hazard B3 exists for.

The factory now sets `BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED=false` before import.
Measured over a full `reset -> persist -> retrieve -> reset` cycle with a
`getaddrinfo` guard counting every outbound attempt:

| Configuration | Outbound attempts | Lifecycle | Records retrieved |
| --- | --- | --- | --- |
| Semantic index enabled | **2** to `huggingface.co:443` | all SUCCEEDED | 1 |
| Disabled by the factory | **0** | all SUCCEEDED | 1 |

Only now is `requestClasses: []` true, and it is true by measurement rather than
by inference.

Requirement 6 is therefore **closed for `basic-memory`**, making four of the
seven arms real: the three that need no external service by construction, plus
this one.

## Native user-isolation probe (assumptions A1 and A2)

`benchmark/preregistration-amendment-002.json` declares `userIsolation: SUPPORTED`
for both `graphiti` and `cognee`, while both adapters reject any non-null
`userId`:

- `benchmark/adapters/graphiti_adapter.py` — *"Graphiti has no native user namespace"*
- `benchmark/adapters/cognee_adapter.py` — *"Cognee user ACL is not locked for benchmark execution"*

That contradiction had to be settled by observation before any count could be
called truthful, because the applicability matrix determines how many
`ISOLATION_USER` units are EXCLUDED.

### Method

Read-only introspection inside the pinned runtime, which is the container the
competitor lock names — not the host interpreter:

```
docker pull python@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f
```

Confirmed `Python 3.12.11`, matching `competitors.lock.json.pythonImage`. The
host interpreter is 3.14.4 and must not be used to run adapters.

No graph or vector service was contacted, no credential was supplied, and
nothing was written. The probes inspect signatures, model fields and module
members only.

### A1 — Graphiti 0.29.3: CONFIRMED, no native user-scoped record API

`probe-graphiti-0.29.3.json`, with `graphiti-core==0.29.3` and the pinned
`httpx==0.28.1` support package:

- `methods_accepting_user_scope` is **empty**.
- `methods_accepting_group_scope` covers `add_episode`, `add_episode_bulk`,
  `build_communities`, `retrieve_episodes`, `search`, `search_` — every one via
  `group_id` / `group_ids` only.
- `EntityNode_user_fields` and `EpisodicNode_user_fields` are both **empty**.
  `EpisodicNode` scopes solely by `group_id`.

Graphiti offers a project namespace and no user namespace. The only way to
express a user would be to encode one into `group_id`, which is exactly the
manufactured isolation the methodology forbids. **The adapter is correct and the
A002 matrix entry for `graphiti` is not.**

Scope of the claim: this covers the public `Graphiti` class surface and the
episodic/entity node models at this pinned version.

### A2 — Cognee 1.5.3: REFUTED, a native user ACL does exist

`probe-cognee-1.5.3.json`, with `cognee==1.5.3`:

- `add`, `cognify` and `search` each accept a `user` argument.
- A `User` model exists with columns `email`, `hashed_password`, `id`,
  `is_active`, `is_superuser`, `is_verified`, `parent_user_id`, `tenant_id`.
- `create_user(email, password, is_superuser, is_active, is_verified,
  auto_login, parent_user_id)` creates a user programmatically, so pinning a
  specific user needs no interactive authentication.
- Eighteen permission methods are available, including
  `give_permission_on_dataset`, `check_permission_on_dataset`,
  `get_permitted_dataset_ids` and `authorized_get_principal_datasets`.
- Cognee reports its own posture on import:
  `authentication=required, multi_tenant=enabled`, and documents
  `ENABLE_BACKEND_ACCESS_CONTROL=false` as the way to disable it.

Native user isolation is therefore available and lockable. The adapter's refusal
records that **this harness has not yet pinned that ACL**, not that the product
lacks the capability. **The A002 matrix entry for `cognee` is achievable; the
adapter is what is incomplete.**

### Consequence

The two arms resolve differently, so the applicability correction is a split, not
a uniform downgrade:

| Arm | A002 says | Observed | Action |
| --- | --- | --- | --- |
| `graphiti` | SUPPORTED | no native user API | methodology must change |
| `cognee` | SUPPORTED | native user ACL present | adapter must be implemented |

With `graphiti` alone moving to `NOT_APPLICABLE`, five of seven arms have no
native user namespace (`no-memory`, `shadowgraph-full`, `shadowgraph-compact`,
`graphiti`, `basic-memory`), giving:

| Count | A002 declares | Observed-truthful |
| --- | --- | --- |
| Total units | 308 | 308 |
| EXCLUDED | 16 | **20** |
| MEASURED | 292 | **288** |
| RESET | 28 | 28 |
| Outer decision calls | 264 | **260** |

The delta is exactly Graphiti's four `ISOLATION_USER` units
(2 scenarios x 2 repetitions).

**Status: proposed, not adopted.** Changing a declared applicability entry
requires an amendment reviewed under the methodology. `preregistration.json` and
both existing amendments remain byte-identical and are not edited. Until an
amendment 003 is reviewed and accepted, the acceptance definition continues to
carry the A002 counts, and no acceptance execution may claim either set.
