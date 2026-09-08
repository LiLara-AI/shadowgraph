"""Behavioural demonstration that Cognee 1.5.3 enforces its native user ACL.

The v1.1 registry records that Cognee has a native user namespace whose use is
conditional on a *pinned backend access-control configuration*. Until now that
condition could only be asserted on the command line, which is an input and not
a proof. This is the proof: it configures the condition, then makes the product
demonstrate the boundary and demonstrate that the boundary is the ACL.

The structure is deliberate. A refusal on its own proves very little - a
misconfigured store, an absent dataset or a typo also produce a refusal. So the
demonstration pairs every negative with a positive: the owner can read its own
dataset, the other user cannot, and after an explicit grant the same call by the
same user succeeds. Only the permission changed between the last two, so only
the permission can explain the difference.

Nothing here is mocked, patched or stubbed. Every assertion goes through
Cognee's own public API against real per-dataset stores on disk, and the record
this writes reports what happened, including failure.

Configuration arrives through the environment because that is what the
condition *is*: `ENABLE_BACKEND_ACCESS_CONTROL` plus a backend pairing that can
physically carry per-dataset isolation. The caller supplies it; this script
records what it resolved to rather than asserting what it should have been.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import traceback
from datetime import datetime, timezone

import cognee
from cognee.context_global_variables import backend_access_control_enabled
from cognee.modules.users.methods import create_user
from cognee.modules.users.permissions.methods import authorized_give_permission_on_datasets

SCHEMA = "shadowgraph.v11.precondition-evidence"
VERSION = 1
ARM_ID = "cognee"
PRECONDITION = "pinned backend access-control configuration"

# One name, two users. The point of the demonstration is that this single name
# does not name a single dataset.
DATASET_NAME = "shadowgraph-acl-probe"
# The local benchmark endpoint authenticates nothing, but pinned Cognee rejects
# an empty OpenAI-provider key before it can test the endpoint. This designated
# placeholder fills that syntactic slot; it is not a credential.
UNUSED_API_KEY = "not-a-secret"

STEPS: list[dict] = []


def step(name: str, passed: bool, detail: str) -> None:
    STEPS.append({"step": name, "outcome": "PASS" if passed else "FAIL", "detail": detail})
    print(f"[{'PASS' if passed else 'FAIL'}] {name}: {detail}", file=sys.stderr)


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} must be set for the demonstration to run")
    return value


async def dataset_id_for(user, name: str):
    from cognee.modules.data.methods import get_unique_dataset_id

    return await get_unique_dataset_id(name, user)


async def demonstrate() -> dict:
    report: dict = {
        "schema": SCHEMA,
        "version": VERSION,
        "armId": ARM_ID,
        "precondition": PRECONDITION,
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "package": {"name": "cognee", "version": cognee.get_cognee_version()},
    }

    from cognee.infrastructure.databases.graph.config import get_graph_config
    from cognee.infrastructure.databases.relational.config import get_relational_config
    from cognee.infrastructure.databases.vector.config import get_vectordb_config

    vector = get_vectordb_config()
    graph = get_graph_config()
    relational = get_relational_config()
    report["configuration"] = {
        "enableBackendAccessControl": os.environ.get("ENABLE_BACKEND_ACCESS_CONTROL"),
        "vectorProvider": vector.vector_db_provider,
        "vectorDatasetDatabaseHandler": vector.vector_dataset_database_handler,
        "graphProvider": graph.graph_database_provider,
        "graphDatasetDatabaseHandler": graph.graph_dataset_database_handler,
        "relationalProvider": relational.db_provider,
    }

    # The common endpoint is recorded, not claimed. Cognee validates its model
    # configuration before it will ingest anything, so the demonstration runs
    # against the same endpoint the benchmark declares rather than against a
    # stand-in.
    api_key = UNUSED_API_KEY
    cognee.config.set_llm_provider("openai")
    cognee.config.set_llm_endpoint(required_environment("SHADOWGRAPH_LLM_ENDPOINT"))
    cognee.config.set_llm_model(required_environment("SHADOWGRAPH_LLM_MODEL"))
    cognee.config.set_llm_api_key(api_key)
    cognee.config.set_embedding_provider("openai_compatible")
    cognee.config.set_embedding_endpoint(required_environment("SHADOWGRAPH_EMBEDDING_ENDPOINT"))
    cognee.config.set_embedding_model(required_environment("SHADOWGRAPH_EMBEDDING_MODEL"))
    cognee.config.set_embedding_api_key(api_key)
    report["commonEndpoint"] = {
        "llmEndpoint": os.environ["SHADOWGRAPH_LLM_ENDPOINT"],
        "llmModel": os.environ["SHADOWGRAPH_LLM_MODEL"],
        "embeddingEndpoint": os.environ["SHADOWGRAPH_EMBEDDING_ENDPOINT"],
        "embeddingModel": os.environ["SHADOWGRAPH_EMBEDDING_MODEL"],
    }

    # Cognee resolves its relational store path but does not create it.
    os.makedirs(relational.db_path, exist_ok=True)
    from cognee.modules.engine.operations.setup import setup as cognee_setup

    await cognee_setup()

    enabled = backend_access_control_enabled()
    report["backendAccessControlEnabled"] = bool(enabled)
    step("posture", bool(enabled), f"backend_access_control_enabled() returned {enabled}")
    if not enabled:
        return report

    user_a = await create_user("acl-probe-a@example.com", secrets.token_urlsafe(24))
    user_b = await create_user("acl-probe-b@example.com", secrets.token_urlsafe(24))
    report["users"] = {"a": str(user_a.id), "b": str(user_b.id)}
    step("users", user_a.id != user_b.id, "two distinct principals were created")

    await cognee.add("Alpha owns this record.", dataset_name=DATASET_NAME, user=user_a)
    await cognee.add("Bravo owns this record.", dataset_name=DATASET_NAME, user=user_b)
    step("ingest", True, f"both users ingested into a dataset named {DATASET_NAME}")

    dataset_a = await dataset_id_for(user_a, DATASET_NAME)
    dataset_b = await dataset_id_for(user_b, DATASET_NAME)
    report["datasets"] = {"a": str(dataset_a), "b": str(dataset_b)}
    step(
        "identical-name-distinct-datasets",
        dataset_a != dataset_b,
        "one dataset name resolves to different ids for different users",
    )

    # Positive control. Without it, a refusal below could be a broken store.
    own = await cognee.datasets.list_data(dataset_a, user=user_a)
    step("positive-control-own-dataset", own is not None, f"owner read its own dataset, {len(own)} row(s)")

    refusal = None
    try:
        await cognee.datasets.list_data(dataset_b, user=user_a)
    except Exception as error:  # noqa: BLE001 - the exception type is the evidence
        refusal = type(error).__name__
    report["refusalBeforeGrant"] = refusal
    step(
        "cross-user-read-refused",
        refusal == "PermissionDeniedError",
        f"user A reading user B's dataset raised {refusal}",
    )

    listed = await cognee.datasets.list_datasets(user=user_a)
    visible = sorted({str(getattr(entry, "id", entry)) for entry in listed})
    report["datasetsVisibleToA"] = visible
    step(
        "listing-omits-other-dataset",
        str(dataset_b) not in visible,
        "user A's dataset listing does not contain user B's dataset",
    )

    await authorized_give_permission_on_datasets(user_a.id, [dataset_b], "read", user_b.id)
    step("grant", True, "user B granted user A read permission on its dataset")

    granted = None
    granted_error = None
    try:
        granted = await cognee.datasets.list_data(dataset_b, user=user_a)
    except Exception as error:  # noqa: BLE001
        granted_error = f"{type(error).__name__}: {error}"
    report["readAfterGrant"] = None if granted is None else len(granted)
    step(
        "cross-user-read-allowed-after-grant",
        granted is not None,
        f"the same call now returned {len(granted)} row(s)" if granted is not None
        else f"still refused: {granted_error}",
    )

    # Isolation here is physical, not a filter. Record it.
    from sqlalchemy import select

    from cognee.infrastructure.databases.relational import get_relational_engine
    from cognee.modules.users.models.DatasetDatabase import DatasetDatabase

    engine = get_relational_engine()
    async with engine.get_async_session() as session:
        rows = (await session.execute(select(DatasetDatabase))).scalars().all()
    report["datasetDatabases"] = [
        {
            "ownerId": str(row.owner_id),
            "datasetId": str(row.dataset_id),
            "vectorDatabaseName": row.vector_database_name,
            "graphDatabaseName": row.graph_database_name,
            "vectorProvider": row.vector_database_provider,
            "graphProvider": row.graph_database_provider,
        }
        for row in rows
    ]
    pairs = {(row["vectorDatabaseName"], row["graphDatabaseName"]) for row in report["datasetDatabases"]}
    step(
        "per-dataset-stores",
        len(pairs) == len(report["datasetDatabases"]) >= 2,
        f"{len(report['datasetDatabases'])} dataset store row(s), {len(pairs)} distinct store pair(s)",
    )

    return report


def main() -> int:
    output_path = required_environment("SHADOWGRAPH_DEMONSTRATION_OUTPUT")
    try:
        report = asyncio.run(demonstrate())
    except Exception:  # noqa: BLE001 - a failed demonstration is a recorded outcome
        traceback.print_exc()
        report = {
            "schema": SCHEMA,
            "version": VERSION,
            "armId": ARM_ID,
            "precondition": PRECONDITION,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "package": {"name": "cognee", "version": cognee.get_cognee_version()},
            "backendAccessControlEnabled": bool(backend_access_control_enabled()),
            "fatal": True,
        }
    report["steps"] = STEPS
    report["outcome"] = (
        "PASS"
        if STEPS and all(entry["outcome"] == "PASS" for entry in STEPS) and not report.get("fatal")
        else "FAIL"
    )
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["outcome"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
