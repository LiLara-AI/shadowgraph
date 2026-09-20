"""Behavioural demonstration that Cognee assigns dataset ids, and this arm adopts them.

The Cognee adapter used to compute the id of its own dataset:
`uuid5(COGNEE_DATASET_UUID_NAMESPACE, f"{arm}:{project}")`, held the store to
that value, and refused any dataset whose name matched but whose id did not.

Cognee does not work that way, and the difference is not cosmetic.
`create_dataset` derives the id from `get_unique_dataset_id`, which namespaces
the dataset name by the owning user and the tenant, and a UUID handed to `add`
is read as a reference to a dataset that already exists and that the caller
holds write permission on.

This is the demonstration that settled D3, kept as a probe rather than as a
sentence in a record, because "the library assigns its own ids" is the kind of
claim that ages and should be re-runnable against the pinned wheel.

It is paired. The negative half shows the computed id is not the library's and
that supplying it is refused outright. The positive half shows the same add
succeeding by name, the store carrying the library's id, and the adapter's own
resolver finding that dataset and adopting it - so the arm addresses its dataset
by the one thing it owns, the name.

Nothing is mocked. The resolver under test is imported from `cognee_adapter`
rather than restated.
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
import traceback
from datetime import datetime, timezone
from uuid import UUID, uuid5

import cognee
from cognee.modules.data.methods import get_unique_dataset_id
from cognee.modules.users.methods import get_default_user
from cognee.tasks.ingestion.data_item import DataItem

import cognee_adapter
from python_runtime import deterministic_native_uuid

SCHEMA = "shadowgraph.v11.precondition-evidence"
VERSION = 1
ARM_ID = "cognee"
PRECONDITION = "the Cognee arm addresses its dataset by name and adopts the id Cognee assigned"

DATASET_NAME = "shadowgraph-dataset-identity-probe"
# The scheme the adapter used to carry, reproduced here so the demonstration
# does not depend on a helper that has been deleted.
RETIRED_NAMESPACE = UUID("f266d968-ec78-5e9b-b767-b78eb418b156")
RETIRED_ID = uuid5(RETIRED_NAMESPACE, f"{ARM_ID}:{DATASET_NAME}")

STEPS: list[dict] = []


def step(name: str, passed: bool, detail: str) -> None:
    STEPS.append({"step": name, "outcome": "PASS" if passed else "FAIL", "detail": detail})
    print(f"[{'PASS' if passed else 'FAIL'}] {name}: {detail}", file=sys.stderr)


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} must be set for the demonstration to run")
    return value


def item_for(label: str) -> DataItem:
    return DataItem(
        "a decision the benchmark recorded",
        label=label,
        external_metadata={"shadowgraph_record_id": label},
        system_metadata=None,
        data_id=UUID(deterministic_native_uuid(ARM_ID, label)),
    )


def configure() -> dict:
    """Point Cognee at the pinned service, the way the ACL demonstration does.

    `add` runs a pipeline that tests the LLM connection before it will ingest
    anything, so even a question about dataset identity needs a model endpoint
    to reach the code that answers it. The provider prefix on the completion
    model and its absence on the embedding model are the same asymmetry the
    adapter's runtime config carries, for the same reason.
    """
    endpoint = required_environment("SHADOWGRAPH_MODEL_ENDPOINT")
    # The endpoint authenticates nothing; Cognee refuses to configure without a
    # value in the slot.
    unused = secrets.token_urlsafe(16)
    cognee.config.set_llm_provider("openai")
    cognee.config.set_llm_endpoint(endpoint)
    cognee.config.set_llm_model(f"openai/{required_environment('SHADOWGRAPH_LLM_MODEL')}")
    cognee.config.set_llm_api_key(unused)
    cognee.config.set_embedding_provider("openai_compatible")
    cognee.config.set_embedding_endpoint(endpoint)
    cognee.config.set_embedding_model(required_environment("SHADOWGRAPH_EMBEDDING_MODEL"))
    cognee.config.set_embedding_api_key(unused)
    return {"modelEndpoint": endpoint}


async def demonstrate() -> dict:
    from cognee.modules.engine.operations.setup import setup as cognee_setup

    configured = configure()
    await cognee_setup()
    user = await get_default_user()

    assigned = await get_unique_dataset_id(DATASET_NAME, user)
    report = {
        "schema": SCHEMA,
        "version": VERSION,
        "armId": ARM_ID,
        "precondition": PRECONDITION,
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "datasetName": DATASET_NAME,
        "retiredComputedId": str(RETIRED_ID),
        "libraryAssignedId": str(assigned),
        **configured,
    }
    step(
        "the-id-this-adapter-used-to-compute-is-not-the-one-cognee-assigns",
        str(RETIRED_ID) != str(assigned),
        f"computed {RETIRED_ID}, library {assigned}",
    )

    refused = None
    try:
        await cognee.add(
            item_for("record-refused"),
            dataset_name=DATASET_NAME,
            dataset_id=RETIRED_ID,
            user=None,
            incremental_loading=True,
        )
    except Exception as error:  # noqa: BLE001 - the refusal is the observation
        refused = f"{type(error).__name__}: {error}"
    before = await cognee.datasets.list_datasets(user=None)
    report["addWithComputedId"] = {
        "error": refused,
        "datasetsAfter": [{"id": str(row.id), "name": row.name} for row in before],
    }
    step(
        "supplying-the-computed-id-is-refused-and-creates-nothing",
        refused is not None and not before,
        f"{refused}; {len(before)} dataset(s) exist",
    )

    await cognee.add(
        item_for("record-1"),
        dataset_name=DATASET_NAME,
        user=None,
        incremental_loading=True,
    )
    after = await cognee.datasets.list_datasets(user=None)
    report["datasetsAfterAddByName"] = [{"id": str(row.id), "name": row.name} for row in after]
    step(
        "adding-by-name-creates-the-dataset-under-the-library-s-id",
        len(after) == 1
        and after[0].name == DATASET_NAME
        and str(after[0].id) == str(assigned),
        f"{len(after)} dataset(s); "
        + (f"{after[0].name} at {after[0].id}" if after else "none"),
    )

    # The resolver the adapter actually uses, not a restatement of it.
    resolved = cognee_adapter._resolve_dataset(after, DATASET_NAME)
    resolved_id = None if resolved is None else cognee_adapter._dataset_id_of(resolved)
    report["adapterResolvedId"] = None if resolved_id is None else str(resolved_id)
    step(
        "the-adapter-finds-it-by-name-and-adopts-that-id",
        resolved_id is not None and str(resolved_id) == str(assigned),
        f"resolver returned {resolved_id}",
    )

    await cognee.add(
        item_for("record-2"),
        dataset_name=DATASET_NAME,
        user=None,
        incremental_loading=True,
    )
    again = await cognee.datasets.list_datasets(user=None)
    report["datasetsAfterSecondAdd"] = [{"id": str(row.id), "name": row.name} for row in again]
    step(
        "a-second-add-under-the-same-name-reuses-the-same-dataset",
        len(again) == 1 and str(again[0].id) == str(assigned),
        f"{len(again)} dataset(s) after a second add",
    )

    rows = await cognee.datasets.list_data(assigned, user=None)
    report["rowCount"] = len(rows)
    step(
        "both-records-landed-in-that-one-dataset",
        len(rows) == 2,
        f"{len(rows)} row(s) under {assigned}",
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
