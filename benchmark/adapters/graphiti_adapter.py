"""Pinned Graphiti 0.29.3/httpx 0.28.1 group-scoped benchmark adapter."""

from __future__ import annotations

import asyncio
import copy
from datetime import datetime, timezone
import http.client
import json
import re
import urllib.parse

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
    require_models,
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
UNUSED_API_KEY = "not-a-secret"

DISPATCH_ALIAS_HEADER = "x-shadowgraph-dispatch-alias"
_DISPATCH_ALIAS = re.compile(r"^[a-f0-9]{48}$")


def _valid_dispatch_identity(value) -> bool:
    return (
        isinstance(value, dict)
        and _DISPATCH_ALIAS.fullmatch(value.get("alias", "")) is not None
        and _DISPATCH_ALIAS.fullmatch(value.get("plannedDispatchId", "")) is not None
    )


def _meter_post(endpoint: str, suffix: str, *, alias: str | None = None, expected_status: int) -> bytes:
    parsed = urllib.parse.urlsplit(endpoint)
    if parsed.scheme != "http" or not parsed.hostname or parsed.port is None:
        raise RuntimeUnavailable("Graphiti meter endpoint URI is invalid")
    connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=5)
    try:
        headers = {"Content-Length": "0"}
        if alias is not None:
            if _DISPATCH_ALIAS.fullmatch(alias) is None:
                raise RuntimeUnavailable("Graphiti meter close identity is invalid")
            headers[DISPATCH_ALIAS_HEADER] = alias
        path = parsed.path.rstrip("/") + suffix
        connection.request("POST", path, body=b"", headers=headers)
        response = connection.getresponse()
        body = response.read(2049)
        if response.status != expected_status or len(body) > 2048:
            raise RuntimeUnavailable("Graphiti meter request was refused")
        return body
    except (OSError, ValueError) as error:
        raise RuntimeUnavailable("Graphiti meter request could not be completed") from error
    finally:
        connection.close()


def _meter_declare_sync(endpoint: str) -> dict:
    body = _meter_post(endpoint, "/__shadowgraph/declare", expected_status=201)
    try:
        identity = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise RuntimeUnavailable("Graphiti meter declaration was invalid") from error
    if set(identity) != {"alias", "plannedDispatchId"} or not _valid_dispatch_identity(identity):
        raise RuntimeUnavailable("Graphiti meter declaration was invalid")
    return identity


async def _meter_declare(endpoint: str) -> dict:
    return await asyncio.to_thread(_meter_declare_sync, endpoint)


async def _meter_close(endpoint: str, identity: dict) -> None:
    if not _valid_dispatch_identity(identity):
        raise RuntimeUnavailable("Graphiti meter close identity is invalid")
    await asyncio.to_thread(
        _meter_post,
        endpoint,
        "/__shadowgraph/close",
        alias=identity["alias"],
        expected_status=204,
    )


def _runtime_config(routes: dict, models: dict) -> dict:
    return {
        "packages": copy.deepcopy(PINNED_PACKAGES),
        "llm_endpoint": routes["internal_memory_llm"],
        "llm_model": models["internal_memory_llm"]["modelId"],
        "embedding_endpoint": routes["embedding"],
        "embedding_model": models["embedding"]["modelId"],
        "embedding_dimension": models["embedding"]["embeddingDimension"],
        "graph_database_uri": "bolt://127.0.0.1:7687",
        "graph_database_name": "neo4j",
        "graph_database_auth": "none",
        "max_retries": 0,
        "automatic_retries": 0,
        "retry_proof": "task8_runtime_meter_required",
        "database_scope_gate": "driver_for_group_required",
        "store_raw_episode_content": True,
    }


class _NativeGroupNodeType:
    def __init__(self, clear_data):
        self._clear_data = clear_data

    async def delete_by_group_id(self, driver, group_id):
        await self._clear_data(driver, [group_id])


class _NativeGroupEpisodeType:
    def __init__(self, episodic_node):
        self._episodic_node = episodic_node

    async def get_by_group_ids(self, driver, group_ids, **kwargs):
        return await self._episodic_node.get_by_group_ids(driver, group_ids, **kwargs)


class _NativeGraphitiClient:
    def __init__(self, native, runtime):
        self._native = native
        self.driver = native.driver
        self.EpisodeType = runtime["EpisodeType"]
        self.node_type = _NativeGroupNodeType(runtime["clear_data"])
        self.episodic_node_type = _NativeGroupEpisodeType(runtime["EpisodicNode"])

    def driver_for_group(self, group_id):
        del group_id
        return self.driver

    async def search(self, *args, **kwargs):
        return await self._native.search(*args, **kwargs)

    async def add_episode(self, *args, **kwargs):
        return await self._native.add_episode(*args, **kwargs)


def _load_native_runtime():
    import httpx
    from openai import AsyncOpenAI
    from graphiti_core import Graphiti
    from graphiti_core.cross_encoder.openai_reranker_client import OpenAIRerankerClient
    from graphiti_core.embedder.openai import OpenAIEmbedder, OpenAIEmbedderConfig
    from graphiti_core.graphiti import EpisodeType
    from graphiti_core.llm_client.config import LLMConfig
    from graphiti_core.llm_client.openai_generic_client import OpenAIGenericClient
    from graphiti_core.nodes import EpisodicNode
    from graphiti_core.utils.maintenance.graph_data_operations import clear_data

    return {
        "Graphiti": Graphiti,
        "EpisodeType": EpisodeType,
        "EpisodicNode": EpisodicNode,
        "LLMConfig": LLMConfig,
        "OpenAIGenericClient": OpenAIGenericClient,
        "OpenAIEmbedderConfig": OpenAIEmbedderConfig,
        "OpenAIEmbedder": OpenAIEmbedder,
        "OpenAIRerankerClient": OpenAIRerankerClient,
        "clear_data": clear_data,
        "httpx": httpx,
        "AsyncOpenAI": AsyncOpenAI,
    }


def _metered_openai(runtime, endpoint, provider_call, request_class):
    httpx = runtime["httpx"]

    class _MeteredAsyncTransport(httpx.AsyncHTTPTransport):
        async def handle_async_request(self, request):
            identity = await _meter_declare(endpoint)
            headers = getattr(request, "headers", None)
            if headers is not None:
                headers[DISPATCH_ALIAS_HEADER] = identity["alias"]
            provider_call(request_class)
            try:
                return await super().handle_async_request(request)
            finally:
                await _meter_close(endpoint, identity)

    http_client = httpx.AsyncClient(
        transport=_MeteredAsyncTransport(retries=0),
        timeout=httpx.Timeout(120),
    )
    return runtime["AsyncOpenAI"](
        api_key=UNUSED_API_KEY,
        base_url=endpoint,
        max_retries=0,
        http_client=http_client,
    )


def _default_client_factory(config, provider_call, *, runtime=None):
    if config.get("graph_database_auth") != "none" or config.get("graph_database_name") != "neo4j":
        raise RuntimeUnavailable("Graphiti requires the pinned local Neo4j configuration")
    runtime = _load_native_runtime() if runtime is None else runtime
    llm_config = runtime["LLMConfig"](
        api_key=UNUSED_API_KEY,
        model=config["llm_model"],
        base_url=config["llm_endpoint"],
        temperature=0,
    )
    llm_openai = _metered_openai(
        runtime,
        config["llm_endpoint"],
        provider_call,
        "internal_memory_llm",
    )
    embedding_openai = _metered_openai(
        runtime,
        config["embedding_endpoint"],
        provider_call,
        "embedding",
    )
    llm_client = runtime["OpenAIGenericClient"](
        llm_config,
        cache=False,
        client=llm_openai,
        structured_output_mode="json_object",
    )
    embedder = runtime["OpenAIEmbedder"](
        runtime["OpenAIEmbedderConfig"](
            api_key=UNUSED_API_KEY,
            embedding_model=config["embedding_model"],
            embedding_dim=config["embedding_dimension"],
            base_url=config["embedding_endpoint"],
        ),
        client=embedding_openai,
    )
    reranker = runtime["OpenAIRerankerClient"](llm_config, client=llm_openai)
    native = runtime["Graphiti"](
        uri=config["graph_database_uri"],
        user=None,
        password=None,
        llm_client=llm_client,
        embedder=embedder,
        cross_encoder=reranker,
        store_raw_episode_content=config["store_raw_episode_content"],
    )
    return _NativeGraphitiClient(native, runtime)


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
            raise ContractError("Graphiti adapter requires the exact graphiti arm")
        namespace = request["namespace"]
        if not isinstance(namespace["projectId"], str) or not namespace["projectId"].strip():
            raise ContractError("Graphiti requires a native group id")
        if namespace["userId"] is not None:
            raise ContractError("Graphiti has no native user namespace")
        require_routes(config, required=True)
        require_models(models, required=True)
        require_versions(PINNED_PACKAGES, version_getter)
        client = await await_native(
            client_factory(_runtime_config(config, models), provider_calls)
        )
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
            provider_calls.require_traffic("internal_memory_llm")
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
