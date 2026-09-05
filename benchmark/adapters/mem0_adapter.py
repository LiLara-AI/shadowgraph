"""Pinned Mem0 2.0.19 benchmark adapter behind a narrow native-client seam."""

from __future__ import annotations

import atexit
import copy
import os

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
    persistent_state_root,
    require_models,
    require_routes,
    require_versions,
    result_items,
    verification_evidence,
)


ADAPTER_ID = "mem0-oss"
PINNED_PACKAGES = {"mem0ai": "2.0.19"}
COLLECTION_NAME = "shadowgraph_benchmark"
HTTP_TIMEOUT_SECONDS = 120.0
UNUSED_API_KEY = "not-a-secret"
STORAGE = not_available_storage(
    "Mem0 exact project/user scope",
    "No exact attributable native storage byte scope is available",
)


def _filters(namespace: dict) -> dict:
    return {"agent_id": namespace["projectId"], "user_id": namespace["userId"]}


def _runtime_config(routes: dict, models: dict, state_root: str) -> dict:
    embedding = models["embedding"]
    return {
        "package": {"name": "mem0ai", "version": "2.0.19"},
        "llm": {
            "provider": "openai",
            "config": {
                "openai_base_url": routes["internal_memory_llm"],
                # Left unset, mem0 2.0.19 asks for "gpt-5-mini", which the pinned
                # Ollama does not serve.
                "model": models["internal_memory_llm"]["modelId"],
                # Mem0 builds both SDK clients during construction, and the
                # OpenAI client refuses to exist without a key. The endpoint is
                # the benchmark's own metered proxy and authenticates nothing,
                # so this fills the slot and is never a credential - the host
                # strips every real one from the environment before an adapter
                # is imported, which is why the slot has to be filled here.
                "api_key": UNUSED_API_KEY,
            },
        },
        "embedder": {
            "provider": "openai",
            "config": {
                "openai_base_url": routes["embedding"],
                # And here it asks for "text-embedding-3-small" and, more
                # quietly, sizes its vector collection to that model's 1536
                # dimensions. The pinned embedder returns 768: unset, the
                # collection is built the wrong width for the vectors that will
                # be written into it.
                "model": embedding["modelId"],
                "embedding_dims": embedding["embeddingDimension"],
                "api_key": UNUSED_API_KEY,
            },
        },
        # Mem0's own default store, in the mode that needs no service: a local
        # path, which qdrant-client commits to SQLite on every write. It was the
        # subject of D2, and the answer was that the store was never the
        # problem - the runtime was not closed, and `python_host` closes it.
        "vector_store": {
            "provider": "qdrant",
            "config": {
                "collection_name": COLLECTION_NAME,
                "path": os.path.join(state_root, "qdrant"),
                "embedding_model_dims": embedding["embeddingDimension"],
                "on_disk": True,
            },
        },
        "history_db_path": os.path.join(state_root, "history.db"),
        "automatic_retries": 0,
        "retry_proof": "task8_runtime_meter_required",
    }


def _memory_config(config: dict) -> dict:
    """The subset of the runtime config Mem0 itself accepts.

    The runtime config is the adapter's declaration of what it is running, and
    it says more than Mem0's own model can hold - the pinned package, the retry
    proof. Deriving the library config from it rather than keeping a second one
    means what a test asserts about the declaration is what the library is
    actually handed.
    """
    return {
        "llm": copy.deepcopy(config["llm"]),
        "embedder": copy.deepcopy(config["embedder"]),
        "vector_store": copy.deepcopy(config["vector_store"]),
        "history_db_path": config["history_db_path"],
    }


def _metered_http_client(httpx_module, provider_call, request_class: str):
    """An HTTP client that reports every request it puts on the wire.

    The count has to be of requests sent, not of calls made into the SDK. A
    retry is a second request for one call, and the ledger exists precisely so
    that it can disagree with the meter's when one happens - a count taken at
    the call site would agree by construction and prove nothing.
    """

    class _MeteredTransport(httpx_module.HTTPTransport):
        def handle_request(self, request):
            provider_call(request_class)
            return super().handle_request(request)

    return httpx_module.Client(
        transport=_MeteredTransport(retries=0),
        timeout=httpx_module.Timeout(HTTP_TIMEOUT_SECONDS),
    )


def _bind_metered_client(openai_client, httpx_module, holder, endpoint, provider_call, request_class):
    """Replace a constructed Mem0 SDK client with a metered, retry-free one.

    Mem0 2.0.19 builds `OpenAI(api_key, base_url)` directly in both
    `OpenAILLM.__init__` and `OpenAIEmbedding.__init__`, with no `http_client`
    argument and no retry setting reachable from configuration. So the SDK's
    default of two retries stands, and nothing observes a request - which makes
    the adapter's declared `automatic_retries: 0` a statement about nothing and
    leaves a transparent retry invisible, the one thing the frozen retry rule
    forbids.

    Rebinding the constructed client is what the library leaves available. It
    changes no memory behaviour: the same class, the same base URL, the same
    model. It sets the retry count the adapter already declares, and it puts a
    counter on the wire.
    """
    if not hasattr(holder, "client"):
        raise RuntimeUnavailable("Pinned Mem0 runtime does not expose a rebindable client")
    client = openai_client(
        # The endpoint is the benchmark's own metered proxy and authenticates
        # nothing. The SDK refuses to construct without a key, so this fills the
        # slot and is never a credential.
        api_key=UNUSED_API_KEY,
        base_url=endpoint,
        max_retries=0,
        http_client=_metered_http_client(httpx_module, provider_call, request_class),
    )
    holder.client = client
    if holder.client is not client or client.max_retries != 0:
        raise RuntimeUnavailable("Pinned Mem0 client could not be bound retry-free")
    return client


def _default_client_factory(config, provider_call):
    """The real pinned Mem0, metered and retry-free, on local disk."""
    try:
        import httpx
        from mem0 import Memory
        from openai import OpenAI
    except ImportError as error:
        raise RuntimeUnavailable(
            "Mem0 2.0.19 and its OpenAI transport are not importable from the pinned runtime"
        ) from error

    try:
        memory = Memory.from_config(_memory_config(config))
    except Exception as error:
        raise RuntimeUnavailable(
            "Mem0 could not be constructed from the pinned local store and metered routes"
        ) from error

    _bind_metered_client(
        OpenAI, httpx, memory.llm,
        config["llm"]["config"]["openai_base_url"], provider_call, "internal_memory_llm",
    )
    _bind_metered_client(
        OpenAI, httpx, memory.embedding_model,
        config["embedder"]["config"]["openai_base_url"], provider_call, "embedding",
    )

    # qdrant-client commits each point as it is written, but the collection
    # metadata and the process-wide file lock are released on close. Every
    # invocation is a fresh process that exits after one unit, so releasing at
    # exit is releasing at the right time - and leaving the lock held would make
    # the next unit's process fail to open the store it is supposed to read.
    store = getattr(memory, "vector_store", None)
    inner = getattr(store, "client", None)
    if inner is not None and hasattr(inner, "close"):
        atexit.register(_close_quietly, inner)
    return memory


def _close_quietly(closeable) -> None:
    try:
        closeable.close()
    except Exception:  # noqa: BLE001 - a close failure at exit must not rewrite the outcome
        pass


def _native_records(value) -> list[dict]:
    return [logical_record(item) for item in result_items(value)]


async def execute(
    request: dict,
    config: dict,
    models: dict,
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
        require_models(models, required=True)
        require_versions(PINNED_PACKAGES, version_getter)
        state_root = persistent_state_root("Mem0")
        client = await await_native(
            client_factory(_runtime_config(config, models, state_root), provider_calls)
        )
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
