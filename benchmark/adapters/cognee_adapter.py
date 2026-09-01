"""Pinned Cognee 1.5.3 dataset-scoped benchmark adapter."""

from __future__ import annotations

import copy
import math
from uuid import UUID

from envelope import ContractError, build_envelope, empty_operations, not_available_storage, record_content_sha256, validate_request
from python_runtime import (
    ProviderCalls,
    RuntimeUnavailable,
    await_native,
    classify_native_error,
    deterministic_dataset_uuid,
    deterministic_native_uuid,
    encode_content,
    failed_response,
    installed_version,
    logical_record,
    require_routes,
    require_versions,
    result_items,
    verification_evidence,
)


ADAPTER_ID = "cognee"
PINNED_PACKAGES = {"cognee": "1.5.3"}
STORAGE = not_available_storage(
    "Cognee exact dataset scope",
    "No exact attributable Cognee storage byte scope is available",
)


def _runtime_config(routes: dict) -> dict:
    llm = {
        "provider": "openai",
        "endpoint": routes["internal_memory_llm"],
        "max_retries": 0,
    }
    embedding = {
        "provider": "openai",
        "endpoint": routes["embedding"],
        "max_retries": 0,
    }
    return {
        "package": {"name": "cognee", "version": "1.5.3"},
        "mode": "openai_compatible",
        "llm_config": llm,
        "embedding_config": embedding,
        "automatic_retries": 0,
        "retry_proof": "task8_runtime_meter_required",
        "native_acl_gate": "task8_required_for_user_scope",
    }


def _default_client_factory(_config, _provider_call):
    raise RuntimeUnavailable(
        "Cognee real runtime requires the Task 8 ACL, service, and model lock"
    )


def _dataset_identity(item) -> tuple[UUID, str]:
    if isinstance(item, dict):
        dataset_id = item.get("id")
        dataset_name = item.get("name")
    else:
        dataset_id = getattr(item, "id", None)
        dataset_name = getattr(item, "name", None)
    if not isinstance(dataset_id, UUID) or not isinstance(dataset_name, str) or not dataset_name:
        raise ContractError("Cognee dataset listing is invalid")
    return dataset_id, dataset_name


def _resolve_dataset(value, expected_id: UUID, expected_name: str):
    exact = []
    for item in result_items(value):
        dataset_id, dataset_name = _dataset_identity(item)
        if dataset_id == expected_id or dataset_name == expected_name:
            if dataset_id != expected_id or dataset_name != expected_name:
                raise ContractError("Cognee dataset identity is contradictory")
            exact.append(item)
    if len(exact) > 1:
        raise ContractError("Cognee dataset identity is ambiguous")
    return exact[0] if exact else None


def _safe_json_value(value, *, depth=0):
    if depth > 16:
        raise ContractError("Cognee search context is too deeply nested")
    if value is None or isinstance(value, (str, bool, int)):
        return value
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ContractError("Cognee search context contains a non-finite number")
        return value
    if isinstance(value, UUID):
        return str(value)
    if isinstance(value, (list, tuple)):
        return [_safe_json_value(item, depth=depth + 1) for item in value]
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise ContractError("Cognee search context keys must be strings")
        return {
            key: _safe_json_value(item, depth=depth + 1)
            for key, item in value.items()
        }
    raise ContractError("Cognee search context is not safely serializable")


def _search_context(value, dataset_id: UUID, dataset_name: str) -> list[dict]:
    context = []
    for item in result_items(value):
        if isinstance(item, dict):
            if "search_result" not in item:
                raise ContractError("Cognee SearchResult is missing search_result")
            search_result = item["search_result"]
            result_dataset_id = item.get("dataset_id")
            result_dataset_name = item.get("dataset_name")
        else:
            if not hasattr(item, "search_result"):
                raise ContractError("Cognee SearchResult is missing search_result")
            search_result = item.search_result
            result_dataset_id = getattr(item, "dataset_id", None)
            result_dataset_name = getattr(item, "dataset_name", None)
        mapped = {"search_result": _safe_json_value(search_result)}
        if result_dataset_id is not None:
            if not isinstance(result_dataset_id, UUID) or result_dataset_id != dataset_id:
                raise ContractError("Cognee SearchResult dataset id is contradictory")
            mapped["dataset_id"] = str(result_dataset_id)
        if result_dataset_name is not None:
            if not isinstance(result_dataset_name, str) or result_dataset_name != dataset_name:
                raise ContractError("Cognee SearchResult dataset name is contradictory")
            mapped["dataset_name"] = result_dataset_name
        context.append(mapped)
    return context


async def _data_records(client, value, dataset_id: UUID, operations: dict) -> list[dict]:
    opener = getattr(client, "open_data_file", None)
    if not callable(opener):
        raise ContractError("Cognee audited open_data_file seam is unavailable")
    records = []
    for item in result_items(value):
        if isinstance(item, dict):
            raw_id = item.get("id")
            raw_dataset_id = item.get("dataset_id")
            raw_location = item.get("raw_data_location")
            metadata = item.get("external_metadata")
        else:
            raw_id = getattr(item, "id", None)
            raw_dataset_id = getattr(item, "dataset_id", None)
            raw_location = getattr(item, "raw_data_location", None)
            metadata = getattr(item, "external_metadata", None)
        if (
            not isinstance(raw_id, UUID)
            or not isinstance(raw_dataset_id, UUID)
            or raw_dataset_id != dataset_id
            or not isinstance(raw_location, str)
            or not raw_location
            or not isinstance(metadata, dict)
        ):
            raise ContractError("Cognee data row is invalid or outside the exact dataset")
        logical_id = metadata.get("shadowgraph_record_id")
        if (
            not isinstance(logical_id, str)
            or raw_id != UUID(deterministic_native_uuid(ADAPTER_ID, logical_id))
        ):
            raise ContractError("Cognee data row native id is not benchmark deterministic")
        operations["persistenceVerificationOperations"] += 1
        context = await await_native(opener(raw_location, mode="rb", encoding=None))
        try:
            async with context as raw_file:
                reader = getattr(raw_file, "read", None)
                if not callable(reader):
                    raise ContractError("Cognee raw data reader is invalid")
                raw_content = await await_native(reader())
        except ContractError:
            raise
        if not isinstance(raw_content, (bytes, bytearray)):
            raise ContractError("Cognee owned raw data must be returned as bytes")
        try:
            content = bytes(raw_content).decode("utf-8")
        except UnicodeDecodeError as error:
            raise ContractError("Cognee owned raw data is not UTF-8") from error
        records.append(
            logical_record(
                {
                    "id": str(raw_id),
                    "data": content,
                    "external_metadata": copy.deepcopy(metadata),
                }
            )
        )
    return records


async def execute(
    request: dict,
    config: dict,
    *,
    client_factory=_default_client_factory,
    version_getter=installed_version,
) -> dict:
    validate_request(request)
    operations = empty_operations()
    provider_calls = ProviderCalls(config if isinstance(config, dict) else {})
    persistence = None
    isolation = None
    try:
        if request["armId"] != ADAPTER_ID:
            raise ContractError("Cognee adapter requires the exact cognee arm")
        namespace = request["namespace"]
        if not isinstance(namespace["projectId"], str) or not namespace["projectId"].strip():
            raise ContractError("Cognee requires a native dataset namespace")
        if namespace["userId"] is not None:
            raise ContractError("Cognee user ACL is not locked for benchmark execution")
        require_routes(config, required=True)
        require_versions(PINNED_PACKAGES, version_getter)
        runtime = _runtime_config(config)
        client = await await_native(client_factory(runtime, provider_calls))
        dataset_name = namespace["projectId"]
        dataset_id = deterministic_dataset_uuid(ADAPTER_ID, dataset_name)
        operation = request["operation"]
        if operation == "reset":
            operations["memoryReadOperations"] += 1
            datasets = await await_native(client.datasets.list_datasets(user=None))
            if _resolve_dataset(datasets, dataset_id, dataset_name) is not None:
                operations["memoryWriteOperations"] += 1
                await await_native(client.datasets.empty_dataset(dataset_id, user=None))
        elif operation == "retrieve":
            operations["memoryReadOperations"] += 1
            raw = await await_native(
                client.search(
                    query_text=request["payload"]["query"]["task"],
                    query_type=client.SearchType.GRAPH_COMPLETION,
                    user=None,
                    datasets=None,
                    dataset_ids=[dataset_id],
                    top_k=15,
                    only_context=True,
                    llm_config=runtime["llm_config"],
                    embedding_config=runtime["embedding_config"],
                )
            )
            provider_calls.require_zero("internal_memory_llm")
            provider_calls.require_traffic("embedding")
            provider_calls.apply(operations)
            return build_envelope(
                request,
                native_context=_search_context(raw, dataset_id, dataset_name),
                operations=operations,
                storage=STORAGE,
            )
        elif operation == "persist":
            record = request["payload"]["record"]
            item = client.DataItem(
                encode_content(record["content"]),
                label=record["id"],
                external_metadata={
                    "shadowgraph_record_id": record["id"],
                    "shadowgraph_record_type": record["type"],
                    "shadowgraph_content_sha256": record_content_sha256(record["content"]),
                },
                system_metadata=None,
                data_id=UUID(deterministic_native_uuid(ADAPTER_ID, record["id"])),
            )
            operations["memoryWriteOperations"] += 1
            await await_native(
                client.add(
                    item,
                    dataset_name=dataset_name,
                    dataset_id=dataset_id,
                    user=None,
                    incremental_loading=True,
                    llm_config=runtime["llm_config"],
                    embedding_config=runtime["embedding_config"],
                )
            )
            operations["memoryWriteOperations"] += 1
            await await_native(
                client.cognify(
                    datasets=[dataset_id],
                    user=None,
                    llm_config=runtime["llm_config"],
                    embedding_config=runtime["embedding_config"],
                )
            )
        else:
            operations["persistenceVerificationOperations"] += 1
            datasets = await await_native(client.datasets.list_datasets(user=None))
            primary = []
            if _resolve_dataset(datasets, dataset_id, dataset_name) is not None:
                operations["persistenceVerificationOperations"] += 1
                primary_raw = await await_native(
                    client.datasets.list_data(dataset_id, user=None)
                )
                primary = await _data_records(client, primary_raw, dataset_id, operations)
            alternate = None
            if request["payload"]["alternateNamespace"] is not None:
                alternate_namespace = request["payload"]["alternateNamespace"]
                if alternate_namespace["userId"] is not None:
                    raise ContractError("Cognee alternate user ACL is not locked")
                alternate_dataset_id = deterministic_dataset_uuid(
                    ADAPTER_ID, alternate_namespace["projectId"]
                )
                alternate = []
                if _resolve_dataset(
                    datasets,
                    alternate_dataset_id,
                    alternate_namespace["projectId"],
                ) is not None:
                    operations["persistenceVerificationOperations"] += 1
                    alternate_raw = await await_native(
                        client.datasets.list_data(alternate_dataset_id, user=None)
                    )
                    alternate = await _data_records(
                        client, alternate_raw, alternate_dataset_id, operations
                    )
            persistence, isolation, verified = verification_evidence(
                request, primary, alternate
            )
            provider_calls.require_zero()
            provider_calls.apply(operations)
            if not verified:
                return failed_response(
                    request,
                    "OPERATION_FAILED",
                    "Exact Cognee persistence or isolation verification failed",
                    operations,
                    STORAGE,
                    persistence=persistence,
                    isolation=isolation,
                )
            return build_envelope(
                request,
                persistence_evidence=persistence,
                isolation_evidence=isolation,
                operations=operations,
                storage=STORAGE,
            )
        if operation == "persist":
            provider_calls.require_traffic("internal_memory_llm", "embedding")
        else:
            provider_calls.require_zero()
        provider_calls.apply(operations)
        return build_envelope(request, operations=operations, storage=STORAGE)
    except RuntimeUnavailable:
        provider_calls.apply(operations)
        return failed_response(
            request,
            "ENDPOINT_UNAVAILABLE",
            "Pinned Cognee runtime or service is not available",
            operations,
            STORAGE,
            persistence=persistence,
            isolation=isolation,
        )
    except ContractError:
        provider_calls.apply(operations)
        return failed_response(
            request,
            "CONTRACT_FAILURE",
            "Cognee adapter contract failed closed",
            operations,
            STORAGE,
            persistence=persistence,
            isolation=isolation,
        )
    except Exception as error:
        provider_calls.apply(operations)
        cause, message = classify_native_error(error)
        return failed_response(
            request,
            cause,
            message,
            operations,
            STORAGE,
            persistence=persistence,
            isolation=isolation,
        )
