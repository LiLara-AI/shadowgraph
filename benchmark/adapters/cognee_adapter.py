"""Pinned Cognee 1.5.3 dataset-scoped benchmark adapter."""

from __future__ import annotations

import copy
import os
import secrets
import math
from uuid import UUID

from envelope import ContractError, build_envelope, empty_operations, not_available_storage, record_content_sha256, validate_request
from python_runtime import (
    ProviderCalls,
    RuntimeUnavailable,
    await_native,
    classify_native_error,
    deterministic_native_uuid,
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


ADAPTER_ID = "cognee"
PINNED_PACKAGES = {"cognee": "1.5.3"}
STORAGE = not_available_storage(
    "Cognee exact dataset scope",
    "No exact attributable Cognee storage byte scope is available",
)


def _runtime_config(routes: dict, models: dict, state_root: str) -> dict:
    llm = {
        "provider": "openai",
        "endpoint": routes["internal_memory_llm"],
        # Cognee sends completions through litellm, which needs the provider
        # prefix to resolve a model it has not seen before; the embedding path
        # uses the OpenAI-compatible engine directly and takes the bare id. Both
        # are derived here from the one pinned id, so the prefix stays a fact
        # about this library rather than something the protocol has to carry.
        "model": "openai/" + models["internal_memory_llm"]["modelId"],
        # Pinned Cognee forwards llm_args to LiteLLM. `max_retries` at this
        # adapter layer was never consumed by the selected configuration path;
        # `num_retries` is the public LiteLLM transport control that is.
        "structured_output_framework": "litellm_native",
        "llm_args": {"num_retries": 0},
        # Pinned Cognee only enters fallback-model handling when these values
        # are all present. State every empty value rather than inheriting one.
        "fallback_model": "",
        "fallback_api_key": "",
        "fallback_endpoint": "",
    }
    embedding = {
        "provider": "openai",
        "endpoint": routes["embedding"],
        "model": models["embedding"]["modelId"],
        "dimensions": models["embedding"]["embeddingDimension"],
    }
    return {
        "package": {"name": "cognee", "version": "1.5.3"},
        "mode": "openai_compatible",
        # The pinned backend pairing and the roots it writes into, stated here
        # rather than inherited from the environment: the pairing *is* the
        # precondition CB2 demonstrated the native ACL under, and a run under a
        # different one would be a run nobody has evidence for.
        "backend": dict(COGNEE_BACKEND),
        "system_root": os.path.join(state_root, "system"),
        "data_root": os.path.join(state_root, "data"),
        "llm_config": llm,
        "embedding_config": embedding,
        # This means retry A only. Amendment 005 governs visible native attempts
        # separately, so a library request is never silently called a rerun.
        "automatic_retries": 0,
        "harness_operation_retries": 0,
        "native_attempt_policy": "amendment-006-arm-neutral-meter-trace",
        "native_acl_gate": "task8_required_for_user_scope",
    }


# The pinned backend pairing, which is the precondition itself.
#
# CB2 demonstrated Cognee 1.5.3 enforcing its native per-user ACL, and what made
# that possible was not a flag but a pairing: LanceDB and Ladybug are both
# file-backed and both able to carry per-dataset isolation, which is what
# `multi_user_support_possible()` checks before it will enable access control at
# all. Naming the pairing here rather than inheriting whatever the environment
# happens to hold is the difference between running under the configuration the
# demonstration covered and running under one nobody has evidence for.
COGNEE_BACKEND = {
    "ENABLE_BACKEND_ACCESS_CONTROL": "true",
    "VECTOR_DB_PROVIDER": "lancedb",
    "VECTOR_DATASET_DATABASE_HANDLER": "lancedb",
    "GRAPH_DATABASE_PROVIDER": "ladybug",
    "GRAPH_DATASET_DATABASE_HANDLER": "ladybug",
}

# Cognee refuses to configure without a value in the key slot, and the endpoint
# it is given is the benchmark's own metered proxy, which authenticates nothing.
# The spelling is the package scanner's own for a value that is demonstrably not
# a credential, so the gate that catches a real key in the tarball holds this too.
UNUSED_API_KEY = "not-a-secret"

# Reserved by RFC 2606 for documentation and examples, so a principal named this
# way cannot be mistaken for a person or reach one. `.invalid` would say that
# more plainly and is refused: Cognee validates the address with pydantic's
# email validator, which rejects special-use names outright.
BENCHMARK_USER_DOMAIN = "example.com"
BENCHMARK_USER_PREFIX = "shadowgraph-benchmark"


def _count_metered_requests(httpx_module, routes: dict, provider_call) -> None:
    """Count every request this process sends to a metered route.

    Mem0 exposes its SDK clients, so its adapter rebinds them and counts on a
    transport it owns. Cognee does not: completions go through litellm and
    embeddings through its own engine, each building its own client, and neither
    is reachable from the public API. What both paths do share is httpx.

    So the count is taken there, which is the same place and the same principle
    as Mem0's - requests on the wire, not calls into a library, because a retry
    is a second request for one call and a ledger that could not tell them apart
    would have nothing to reconcile against the meter.

    This patches the module rather than an instance, and does not undo it. That
    is safe here for a specific reason and not in general: the executor gives
    each invocation its own container and its own interpreter, which exits after
    one operation. A request to anything other than a metered route is left
    entirely alone - and cannot happen anyway, since the host fences this
    process to loopback.
    """
    metered = {endpoint: request_class for request_class, endpoint in routes.items() if endpoint}
    original_send = httpx_module.Client.send
    original_async_send = httpx_module.AsyncClient.send

    def request_class_for(url) -> str | None:
        text = str(url)
        for endpoint, request_class in metered.items():
            if text.startswith(endpoint):
                return request_class
        return None

    def send(self, request, *args, **kwargs):
        request_class = request_class_for(request.url)
        if request_class is not None:
            provider_call(request_class)
        return original_send(self, request, *args, **kwargs)

    async def async_send(self, request, *args, **kwargs):
        request_class = request_class_for(request.url)
        if request_class is not None:
            provider_call(request_class)
        return await original_async_send(self, request, *args, **kwargs)

    httpx_module.Client.send = send
    httpx_module.AsyncClient.send = async_send


class _CogneeClient:
    """The narrow seam this adapter drives Cognee through.

    Everything here is Cognee's own public API. The class exists so the adapter
    has one object to hold - and so `user_for` has somewhere to live, since
    resolving a benchmark user id to a Cognee principal is the one thing the
    module does not offer directly.
    """

    def __init__(self, module, data_item, opener, create_user, get_user_by_email):
        self._module = module
        self._opener = opener
        self._create_user = create_user
        self._get_user_by_email = get_user_by_email
        self.DataItem = data_item
        self.SearchType = module.SearchType
        self.datasets = module.datasets

    async def user_for(self, user_id):
        """Resolve a benchmark user id to the Cognee principal that owns its data.

        Idempotent by lookup-then-create, because a unit is one process and a
        scenario is many units: the second process must find the principal the
        first one made, or every unit would own a different dataset and the
        isolation the definition declares would be measured against a store that
        had just been created empty.
        """
        if user_id is None:
            return None
        email = f"{BENCHMARK_USER_PREFIX}-{user_id}@{BENCHMARK_USER_DOMAIN}"
        existing = await self._get_user_by_email(email)
        if existing is not None:
            return existing
        return await self._create_user(email, secrets.token_urlsafe(24))

    def open_data_file(self, file_path, mode="rb", encoding=None):
        return self._opener(file_path, mode=mode, encoding=encoding)

    async def add(self, data, **kwargs):
        return await self._module.add(data, **self._without_call_config(kwargs))

    async def search(self, **kwargs):
        return await self._module.search(**self._without_call_config(kwargs))

    async def cognify(self, **kwargs):
        return await self._module.cognify(**self._without_call_config(kwargs))

    @staticmethod
    def _without_call_config(kwargs: dict) -> dict:
        """Drop the per-call model configuration, which is already applied.

        The adapter states its model configuration on every call, and that
        statement is what its runtime config records. Cognee takes the same
        settings globally, through `cognee.config`, and they are set once at
        construction from exactly those values - so passing them again per call
        would be handing the same fact to the library twice, in a shape its own
        signature does not accept.

        This is only equivalent because of how the executor runs an adapter: one
        container, one interpreter, one operation, one arm. Global and per-call
        are the same scope here, and a process that hosted two arms would need
        this reconsidered rather than reused.
        """
        return {key: value for key, value in kwargs.items()
                if key not in ("llm_config", "embedding_config")}


async def _default_client_factory(config, provider_call):
    """The real pinned Cognee, on its file-backed stores, with its ACL active."""
    # A configuration this factory cannot use is a runtime it cannot provide,
    # and it says so in those terms: the caller is deciding whether the arm can
    # execute, not debugging a dictionary.
    try:
        backend = config["backend"]
        llm = config["llm_config"]
        embedding = config["embedding_config"]
        system_root = config["system_root"]
        data_root = config["data_root"]
    except (TypeError, KeyError, IndexError) as error:
        raise RuntimeUnavailable(
            "Cognee runtime configuration does not describe a usable pinned runtime"
        ) from error

    # Set before Cognee is imported: the access-control posture is read from the
    # environment when its context is first built, and a later assignment would
    # be a setting nobody applied.
    for name, value in backend.items():
        os.environ[name] = value

    try:
        import httpx
        import cognee
        from cognee.context_global_variables import backend_access_control_enabled
        from cognee.infrastructure.files.utils.open_data_file import open_data_file
        from cognee.modules.engine.operations.setup import setup as cognee_setup
        from cognee.modules.users.methods import create_user, get_user_by_email
        from cognee.tasks.ingestion.data_item import DataItem
    except ImportError as error:
        raise RuntimeUnavailable(
            "Cognee 1.5.3 and its file-backed stores are not importable from the pinned runtime"
        ) from error

    # Cognee resolves these paths but does not create them.
    os.makedirs(os.path.join(system_root, "databases"), exist_ok=True)
    os.makedirs(data_root, exist_ok=True)

    try:
        cognee.config.system_root_directory(system_root)
        cognee.config.data_root_directory(data_root)
        cognee.config.set_vector_db_provider(backend["VECTOR_DB_PROVIDER"])
        cognee.config.set_graph_database_provider(backend["GRAPH_DATABASE_PROVIDER"])
        cognee.config.set_llm_provider(llm["provider"])
        cognee.config.set_llm_endpoint(llm["endpoint"])
        cognee.config.set_llm_model(llm["model"])
        cognee.config.set_llm_api_key(UNUSED_API_KEY)
        fallback_config = {
            name: llm[name]
            for name in ("fallback_model", "fallback_api_key", "fallback_endpoint")
        }
        cognee.config.set_llm_config({
            "structured_output_framework": llm["structured_output_framework"],
            "llm_args": llm["llm_args"],
            **fallback_config,
        })
        cognee.config.set_embedding_provider("openai_compatible")
        cognee.config.set_embedding_endpoint(embedding["endpoint"])
        cognee.config.set_embedding_model(embedding["model"])
        cognee.config.set_embedding_dimensions(embedding["dimensions"])
        cognee.config.set_embedding_api_key(UNUSED_API_KEY)
        await cognee_setup()
    except Exception as error:
        raise RuntimeUnavailable(
            "Cognee could not be configured against the pinned stores and metered routes"
        ) from error

    # The precondition, checked rather than assumed. CB2 demonstrated the ACL
    # under this pairing; if the posture is off, this arm's declared user
    # isolation would be measured against a store that does not enforce it, and
    # every isolation result would be a false negative.
    if not backend_access_control_enabled():
        raise RuntimeUnavailable(
            "Cognee backend access control is not active under the pinned stores"
        )

    _count_metered_requests(
        httpx,
        {"internal_memory_llm": llm["endpoint"], "embedding": embedding["endpoint"]},
        provider_call,
    )
    return _CogneeClient(cognee, DataItem, open_data_file, create_user, get_user_by_email)


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


def _resolve_dataset(value, expected_name: str):
    """Find the arm's dataset by name and adopt whatever id Cognee gave it.

    This adapter used to compute the id itself, with a uuid5 of the arm and the
    project. Cognee does not work that way, and the difference is not cosmetic.
    `create_dataset` derives the id from `get_unique_dataset_id`, which
    namespaces the name by the owning user and tenant, and a UUID handed to
    `add` is read as a reference to an *existing* dataset the caller must
    already hold write permission on. Against the real library the invented id
    produced `PermissionDeniedError` and created nothing at all.

    So the name is the arm's, and the id is the library's. Two datasets sharing
    the name would make "the arm's dataset" ambiguous, which is a refusal
    rather than a choice.
    """
    matches = [item for item in result_items(value) if _dataset_identity(item)[1] == expected_name]
    if len(matches) > 1:
        raise ContractError("Cognee dataset identity is ambiguous")
    return matches[0] if matches else None


def _dataset_id_of(item) -> UUID:
    return _dataset_identity(item)[0]


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
            raise ContractError("Cognee adapter requires the exact cognee arm")
        namespace = request["namespace"]
        if not isinstance(namespace["projectId"], str) or not namespace["projectId"].strip():
            raise ContractError("Cognee requires a native dataset namespace")
        # The definition declares this arm `userIsolation: SUPPORTED`, so the
        # runner always names a user. A namespace without one is a namespace
        # this arm's declared shape does not produce, and synthesizing a default
        # principal for it would measure a different isolation than the one
        # declared.
        if not isinstance(namespace["userId"], str) or not namespace["userId"].strip():
            raise ContractError("Cognee requires a native user scope")
        require_routes(config, required=True)
        require_models(models, required=True)
        require_versions(PINNED_PACKAGES, version_getter)
        runtime = _runtime_config(config, models, persistent_state_root("Cognee"))
        client = await await_native(client_factory(runtime, provider_calls))
        # The arm's user, as Cognee knows one.
        #
        # This adapter used to refuse a user namespace outright, on the grounds
        # that Cognee's ACL was not locked for benchmark execution. That was
        # true when it was written and is not any more: CB2 demonstrated Cognee
        # 1.5.3 enforcing its native per-user ACL under the pinned backend
        # configuration. Meanwhile the acceptance definition declares this arm
        # `userIsolation: SUPPORTED`, so the runner hands it a user - and the
        # refusal was failing every unit before the client factory was reached,
        # for a precondition that had since been met.
        #
        user = await await_native(client.user_for(namespace["userId"]))
        dataset_name = namespace["projectId"]
        operation = request["operation"]
        if operation == "reset":
            operations["memoryReadOperations"] += 1
            datasets = await await_native(client.datasets.list_datasets(user=user))
            existing = _resolve_dataset(datasets, dataset_name)
            if existing is not None:
                operations["memoryWriteOperations"] += 1
                await await_native(
                    client.datasets.empty_dataset(_dataset_id_of(existing), user=user)
                )
        elif operation == "retrieve":
            operations["memoryReadOperations"] += 1
            datasets = await await_native(client.datasets.list_datasets(user=user))
            existing = _resolve_dataset(datasets, dataset_name)
            if existing is None:
                # Nothing to search. Naming the dataset to Cognee's search would
                # create it, and inventing an embedding call to satisfy the
                # traffic contract would be worse than reporting the truth: no
                # dataset, no search, no provider call, no context.
                provider_calls.require_zero()
                provider_calls.apply(operations)
                return build_envelope(
                    request,
                    native_context=[],
                    operations=operations,
                    storage=STORAGE,
                )
            dataset_id = _dataset_id_of(existing)
            operations["memoryReadOperations"] += 1
            raw = await await_native(
                client.search(
                    query_text=request["payload"]["query"]["task"],
                    query_type=client.SearchType.GRAPH_COMPLETION,
                    user=user,
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
            # By name only. A dataset id here is a reference to one that already
            # exists and that the caller may write to, not a request to use it.
            await await_native(
                client.add(
                    item,
                    dataset_name=dataset_name,
                    user=user,
                    incremental_loading=True,
                    llm_config=runtime["llm_config"],
                    embedding_config=runtime["embedding_config"],
                )
            )
            operations["memoryReadOperations"] += 1
            datasets = await await_native(client.datasets.list_datasets(user=user))
            written = _resolve_dataset(datasets, dataset_name)
            if written is None:
                raise ContractError("Cognee did not record the dataset the record was added to")
            operations["memoryWriteOperations"] += 1
            await await_native(
                client.cognify(
                    datasets=[_dataset_id_of(written)],
                    user=user,
                    llm_config=runtime["llm_config"],
                    embedding_config=runtime["embedding_config"],
                )
            )
        else:
            operations["persistenceVerificationOperations"] += 1
            datasets = await await_native(client.datasets.list_datasets(user=user))
            primary = []
            existing = _resolve_dataset(datasets, dataset_name)
            if existing is not None:
                dataset_id = _dataset_id_of(existing)
                operations["persistenceVerificationOperations"] += 1
                primary_raw = await await_native(
                    client.datasets.list_data(dataset_id, user=user)
                )
                primary = await _data_records(client, primary_raw, dataset_id, operations)
            alternate = None
            if request["payload"]["alternateNamespace"] is not None:
                alternate_namespace = request["payload"]["alternateNamespace"]
                if not isinstance(alternate_namespace["projectId"], str) or not isinstance(
                    alternate_namespace["userId"], str
                ):
                    raise ContractError("Cognee isolation requires native dataset and user scopes")
                alternate_user = await await_native(
                    client.user_for(alternate_namespace["userId"])
                )
                alternate = []
                # A second listing, made as the other principal. Reusing the
                # primary's listing would answer the isolation question with the
                # primary's own view, which is the one view guaranteed to show
                # the record - and Cognee namespaces a dataset id by its owner,
                # so the same project name is a different dataset here.
                operations["persistenceVerificationOperations"] += 1
                alternate_datasets = await await_native(
                    client.datasets.list_datasets(user=alternate_user)
                )
                alternate_existing = _resolve_dataset(
                    alternate_datasets, alternate_namespace["projectId"]
                )
                if alternate_existing is not None:
                    alternate_dataset_id = _dataset_id_of(alternate_existing)
                    operations["persistenceVerificationOperations"] += 1
                    alternate_raw = await await_native(
                        client.datasets.list_data(alternate_dataset_id, user=alternate_user)
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
