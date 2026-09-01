"""Pinned Graphiti 0.29.3/httpx 0.28.1 group-scoped benchmark adapter."""

from __future__ import annotations

import copy
from datetime import datetime, timezone

from envelope import ContractError, build_envelope, empty_operations, not_available_storage, record_content_sha256, validate_request
from python_runtime import (
    ProviderCalls,
    RuntimeUnavailable,
    await_native,
    classify_native_error,
    encode_content,
    failed_response,
    installed_version,
    logical_record,
    require_routes,
    require_versions,
    result_items,
    verification_evidence,
)


ADAPTER_ID = "graphiti"
PINNED_PACKAGES = {"graphiti-core": "0.29.3", "httpx": "0.28.1"}
STORAGE = not_available_storage(
    "Graphiti exact group scope in external Neo4j",
    "No exact attributable Neo4j database byte scope is available",
)
REFERENCE_TIME = datetime(1970, 1, 1, tzinfo=timezone.utc)


def _runtime_config(routes: dict) -> dict:
    return {
        "packages": copy.deepcopy(PINNED_PACKAGES),
        "llm_endpoint": routes["internal_memory_llm"],
        "embedding_endpoint": routes["embedding"],
        "max_retries": 0,
        "automatic_retries": 0,
        "retry_proof": "task8_runtime_meter_required",
        "database_scope_gate": "driver_for_group_required",
        "store_raw_episode_content": True,
    }


def _default_client_factory(_config, _provider_call):
    raise RuntimeUnavailable(
        "Graphiti real runtime requires the Task 8 Neo4j image and model lock"
    )


def _episode_record(item) -> dict:
    if isinstance(item, dict):
        raw = copy.deepcopy(item)
    else:
        raw = {
            field: getattr(item, field)
            for field in ("uuid", "name", "group_id", "content", "source_description")
            if hasattr(item, field)
        }
    source_description = raw.get("source_description")
    record_type = (
        source_description.split(":", 1)[1]
        if isinstance(source_description, str)
        and source_description.startswith("shadowgraph-benchmark:")
        else "decision"
    )
    raw["metadata"] = {
        "shadowgraph_record_id": raw.get("name") or raw.get("uuid"),
        "shadowgraph_record_type": record_type,
    }
    return logical_record(raw, text_fields=("content",))


def _native_records(value) -> list[dict]:
    return [_episode_record(item) for item in result_items(value)]


EDGE_CONTEXT_FIELDS = (
    "uuid",
    "fact",
    "name",
    "group_id",
    "source_node_uuid",
    "target_node_uuid",
)


def _retrieval_edge(item) -> dict:
    if isinstance(item, dict):
        raw = item
    else:
        raw = {
            field: getattr(item, field)
            for field in EDGE_CONTEXT_FIELDS
            if hasattr(item, field)
        }
    edge = {}
    for field in EDGE_CONTEXT_FIELDS:
        value = raw.get(field)
        if value is None:
            continue
        if not isinstance(value, str) or not value.strip():
            raise ContractError("Graphiti retrieval edge fields must be non-empty strings")
        edge[field] = value
    if "uuid" not in edge or "fact" not in edge:
        raise ContractError("Graphiti retrieval requires EntityEdge uuid and fact fields")
    return edge


def _retrieval_edges(value) -> list[dict]:
    return [_retrieval_edge(item) for item in result_items(value)]


async def _driver_for_group(client, group_id: str):
    factory = getattr(client, "driver_for_group", None)
    if not callable(factory):
        raise ContractError("Graphiti requires an audited exact group driver")
    driver = await await_native(factory(group_id))
    if driver is None:
        raise ContractError("Graphiti exact group driver is unavailable")
    return driver


def _text_episode_type(client):
    episode_type = getattr(getattr(client, "EpisodeType", None), "text", None)
    if episode_type is None:
        raise ContractError("Graphiti EpisodeType.text is unavailable")
    return episode_type


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
            raise ContractError("Graphiti adapter requires the exact graphiti arm")
        namespace = request["namespace"]
        if not isinstance(namespace["projectId"], str) or not namespace["projectId"].strip():
            raise ContractError("Graphiti requires a native group id")
        if namespace["userId"] is not None:
            raise ContractError("Graphiti has no native user namespace")
        require_routes(config, required=True)
        require_versions(PINNED_PACKAGES, version_getter)
        client = await await_native(client_factory(_runtime_config(config), provider_calls))
        group_id = namespace["projectId"]
        operation = request["operation"]
        if operation == "reset":
            group_driver = await _driver_for_group(client, group_id)
            operations["memoryWriteOperations"] += 1
            await await_native(client.node_type.delete_by_group_id(group_driver, group_id))
        elif operation == "retrieve":
            operations["memoryReadOperations"] += 1
            raw = await await_native(
                client.search(request["payload"]["query"]["task"], group_ids=[group_id])
            )
            provider_calls.require_zero("internal_memory_llm")
            provider_calls.require_traffic("embedding")
            provider_calls.apply(operations)
            return build_envelope(
                request,
                native_context=_retrieval_edges(raw),
                operations=operations,
                storage=STORAGE,
            )
        elif operation == "persist":
            record = request["payload"]["record"]
            source = _text_episode_type(client)
            operations["memoryWriteOperations"] += 1
            await await_native(
                client.add_episode(
                    record["id"],
                    encode_content(record["content"]),
                    f"shadowgraph-benchmark:{record['type']}",
                    REFERENCE_TIME,
                    source=source,
                    group_id=group_id,
                )
            )
        else:
            group_driver = await _driver_for_group(client, group_id)
            operations["persistenceVerificationOperations"] += 1
            primary_raw = await await_native(
                client.episodic_node_type.get_by_group_ids(group_driver, [group_id])
            )
            primary = _native_records(primary_raw)
            alternate = None
            if request["payload"]["alternateNamespace"] is not None:
                alternate_namespace = request["payload"]["alternateNamespace"]
                if alternate_namespace["userId"] is not None:
                    raise ContractError("Graphiti alternate user namespace is unsupported")
                alternate_group_id = alternate_namespace["projectId"]
                alternate_driver = await _driver_for_group(client, alternate_group_id)
                operations["persistenceVerificationOperations"] += 1
                alternate_raw = await await_native(
                    client.episodic_node_type.get_by_group_ids(
                        alternate_driver, [alternate_group_id]
                    )
                )
                alternate = _native_records(alternate_raw)
            persistence, isolation, verified = verification_evidence(
                request, primary, alternate
            )
            provider_calls.require_zero()
            provider_calls.apply(operations)
            if not verified:
                return failed_response(
                    request,
                    "OPERATION_FAILED",
                    "Exact Graphiti persistence or isolation verification failed",
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
            "Pinned Graphiti runtime or external service is not available",
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
            "Graphiti adapter contract failed closed",
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
