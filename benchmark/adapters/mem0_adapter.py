"""Pinned Mem0 2.0.19 benchmark adapter behind a narrow native-client seam."""

from __future__ import annotations

import copy

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


ADAPTER_ID = "mem0-oss"
PINNED_PACKAGES = {"mem0ai": "2.0.19"}
STORAGE = not_available_storage(
    "Mem0 exact project/user scope",
    "No exact attributable native storage byte scope is available",
)


def _filters(namespace: dict) -> dict:
    return {"agent_id": namespace["projectId"], "user_id": namespace["userId"]}


def _runtime_config(routes: dict) -> dict:
    return {
        "package": {"name": "mem0ai", "version": "2.0.19"},
        "llm": {
            "provider": "openai",
            "config": {"openai_base_url": routes["internal_memory_llm"]},
        },
        "embedder": {
            "provider": "openai",
            "config": {"openai_base_url": routes["embedding"]},
        },
        "automatic_retries": 0,
        "retry_proof": "task8_runtime_meter_required",
    }


def _default_client_factory(_config, _provider_call):
    raise RuntimeUnavailable(
        "Mem0 real runtime requires the Task 8 immutable service and model lock"
    )


def _native_records(value) -> list[dict]:
    return [logical_record(item) for item in result_items(value)]


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
            raise ContractError("Mem0 adapter requires the exact mem0-oss arm")
        namespace = request["namespace"]
        if not isinstance(namespace["projectId"], str) or not namespace["projectId"].strip():
            raise ContractError("Mem0 requires a native project scope")
        if not isinstance(namespace["userId"], str) or not namespace["userId"].strip():
            raise ContractError("Mem0 requires a native user scope")
        require_routes(config, required=True)
        require_versions(PINNED_PACKAGES, version_getter)
        client = await await_native(client_factory(_runtime_config(config), provider_calls))
        operation = request["operation"]
        if operation == "reset":
            operations["memoryWriteOperations"] += 1
            await await_native(
                client.delete_all(
                    user_id=namespace["userId"],
                    agent_id=namespace["projectId"],
                    run_id=None,
                )
            )
        elif operation == "retrieve":
            operations["memoryReadOperations"] += 1
            raw = await await_native(
                client.search(request["payload"]["query"]["task"], filters=_filters(namespace))
            )
            native_context = _native_records(raw)
            provider_calls.require_traffic("embedding")
            provider_calls.require_zero("internal_memory_llm")
            provider_calls.apply(operations)
            return build_envelope(
                request,
                native_context=native_context,
                operations=operations,
                storage=STORAGE,
            )
        elif operation == "persist":
            record = request["payload"]["record"]
            operations["memoryWriteOperations"] += 1
            await await_native(
                client.add(
                    [{"role": "assistant", "content": encode_content(record["content"])}],
                    user_id=namespace["userId"],
                    agent_id=namespace["projectId"],
                    run_id=None,
                    metadata={
                        "shadowgraph_record_id": record["id"],
                        "shadowgraph_record_type": record["type"],
                        "shadowgraph_content_sha256": record_content_sha256(record["content"]),
                    },
                    infer=False,
                )
            )
        else:
            expected_namespace = request["namespace"]
            operations["persistenceVerificationOperations"] += 1
            primary_raw = await await_native(
                client.get_all(filters=_filters(expected_namespace), top_k=1000)
            )
            primary = _native_records(primary_raw)
            alternate = None
            if request["payload"]["alternateNamespace"] is not None:
                alternate_namespace = request["payload"]["alternateNamespace"]
                if not isinstance(alternate_namespace["projectId"], str) or not isinstance(
                    alternate_namespace["userId"], str
                ):
                    raise ContractError("Mem0 isolation requires native project and user scopes")
                operations["persistenceVerificationOperations"] += 1
                alternate_raw = await await_native(
                    client.get_all(filters=_filters(alternate_namespace), top_k=1000)
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
                    "Exact native persistence or isolation verification failed",
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
            provider_calls.require_traffic("embedding")
            provider_calls.require_zero("internal_memory_llm")
        else:
            provider_calls.require_zero()
        provider_calls.apply(operations)
        return build_envelope(request, operations=operations, storage=STORAGE)
    except RuntimeUnavailable:
        provider_calls.apply(operations)
        return failed_response(
            request,
            "ENDPOINT_UNAVAILABLE",
            "Pinned Mem0 runtime is not available",
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
            "Mem0 adapter contract failed closed",
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
