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

Basic Memory served all of these from a local ASGI client over SQLite. **The
`requestClasses: []` declaration is truthful**: the `openai` dependency is
declared but not exercised on any path this adapter uses. So this arm needs no
provider endpoint and no external service, and is not blocked by B2.

### A defect this exposed

`delete_project` failed with *"Cannot delete default project 'acc-probe'. This
is the only project in your configuration."* That is the call the adapter makes
during **RESET**, so a reset against a single-project store cannot succeed as
currently written. It is a product constraint rather than a network failure, and
it has to be handled before this arm can complete a lifecycle — most likely by
resetting note content within the project rather than deleting the project
itself.

`search_notes` also returned no hit for a term present in the note just written,
which may be indexing latency or a query-shape mismatch. Recorded as unresolved;
it does not affect the provider-traffic conclusion.

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
