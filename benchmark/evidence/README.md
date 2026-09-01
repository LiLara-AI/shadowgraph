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

### Still open: retrieve does not complete

With a real client factory in place, the adapter now runs
`reset -> persist -> reset` successfully under `--network none`. **Retrieve
still fails**, with `CONTRACT_FAILURE` / "Basic Memory adapter contract failed
closed".

The cause is a shape mismatch rather than a network or reset problem. Basic
Memory's search returns *entity references* — `title`, `type`, `score`,
`entity`, `external_id` — not note content, so mapping a hit to a logical record
needs a follow-up read per result. The adapter does not do that yet.

Until it does, this arm cannot complete a lifecycle, so requirement 6 is **not**
closed for `basic-memory` even though it is no longer blocked: the factory is
real, reset is repeatable, and the provider-traffic declaration is now true, but
retrieve is unimplemented.

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
