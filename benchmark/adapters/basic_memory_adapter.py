"""Pinned Basic Memory 0.23.2 local-project benchmark adapter."""

from __future__ import annotations

import hashlib
import os
import stat

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


ADAPTER_ID = "basic-memory"
PINNED_PACKAGES = {"basic-memory": "0.23.2"}
DIRECTORY = "shadowgraph-benchmark"
STORAGE = not_available_storage(
    "Basic Memory exact local project scope",
    "Task 8 must lock an exact native byte-attribution method for the owned project leaf",
)


def _persistent_state_root() -> str:
    configured = os.environ.get("SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT")
    if not isinstance(configured, str) or not configured or not os.path.isabs(configured):
        raise ContractError("Basic Memory requires an owned persistent state root")
    normalized = os.path.abspath(configured)
    if os.path.realpath(normalized) != normalized:
        raise ContractError("Basic Memory persistent state root is unsafe")
    return normalized


# Basic Memory declines to delete the only project in a configuration, and a
# fresh store contains none, so the arm project would always be the only one and
# RESET could never delete it. This is a second genuine native project held for
# no other purpose: it keeps the count above one so the product permits the
# delete. It never carries benchmark records and is never the arm namespace, so
# no isolation is manufactured by it.
RESET_ANCHOR_PROJECT = "shadowgraph-benchmark-reset-anchor"

# Basic Memory defaults to embedding-backed hybrid retrieval, which reaches a
# provider. This arm declares no request classes, so retrieval names the local
# text index explicitly rather than inheriting whatever the product default
# happens to be.
LOCAL_SEARCH_TYPE = "text"


def _project_path(state_root: str, project: str) -> str:
    digest = hashlib.sha256(
        b"shadowgraph:basic-memory-project:v1\0" + project.encode("utf-8")
    ).hexdigest()
    project_root = _ensure_real_direct_directory(state_root, "basic-memory-projects")
    resolved = _ensure_real_direct_directory(project_root, digest)
    if os.path.commonpath((state_root, resolved)) != state_root:
        raise ContractError("Basic Memory project path escaped its state root")
    return resolved


def _ensure_real_direct_directory(parent: str, name: str) -> str:
    if (
        not isinstance(name, str)
        or not name
        or os.path.basename(name) != name
        or name in {".", ".."}
    ):
        raise ContractError("Basic Memory owned directory name is invalid")
    parent = os.path.abspath(parent)
    try:
        parent_metadata = os.lstat(parent)
    except OSError as error:
        raise ContractError("Basic Memory owned directory parent is unavailable") from error
    if (
        not stat.S_ISDIR(parent_metadata.st_mode)
        or stat.S_ISLNK(parent_metadata.st_mode)
        or os.path.realpath(parent) != parent
    ):
        raise ContractError("Basic Memory owned directory parent is unsafe")
    directory = os.path.abspath(os.path.join(parent, name))
    if os.path.dirname(directory) != parent:
        raise ContractError("Basic Memory owned directory escaped its parent")
    try:
        os.mkdir(directory, mode=0o700)
    except FileExistsError:
        pass
    except OSError as error:
        raise ContractError("Basic Memory owned directory could not be created") from error
    try:
        metadata = os.lstat(directory)
        parent_after = os.lstat(parent)
    except OSError as error:
        raise ContractError("Basic Memory owned directory could not be verified") from error
    if (
        not stat.S_ISDIR(metadata.st_mode)
        or stat.S_ISLNK(metadata.st_mode)
        or not stat.S_ISDIR(parent_after.st_mode)
        or stat.S_ISLNK(parent_after.st_mode)
        or os.path.realpath(parent) != parent
        or os.path.realpath(directory) != directory
        or os.path.dirname(directory) != parent
    ):
        raise ContractError("Basic Memory owned directory is unsafe")
    return directory


def _runtime_config(state_root: str) -> dict:
    return {
        "package": {"name": "basic-memory", "version": "0.23.2"},
        "force_local": True,
        "auto_update": False,
        "logfire": False,
        "config_dir_source": "BASIC_MEMORY_CONFIG_DIR",
        "persistent_state_root": state_root,
        "project_root": os.path.join(state_root, "basic-memory-projects"),
        "automatic_retries": 0,
        "retry_proof": "task8_runtime_meter_required",
    }


class _PinnedBasicMemoryClient:
    """The six product calls this adapter makes, and nothing else.

    Basic Memory exposes its operations as MCP tool objects. The callable is on
    their `fn` attribute, so it is unwrapped once here rather than at every call
    site. Only these six are exposed: an adapter that could reach further would
    be able to do more to the product than the contract describes.
    """

    __slots__ = ("_tools",)

    def __init__(self, tools):
        self._tools = tools

    def __getattr__(self, name):
        tool = self._tools.get(name)
        if tool is None:
            raise ContractError("Basic Memory adapter has no such native operation")
        return tool


def _default_client_factory(config, _provider_call):
    """Bind the pinned Basic Memory package to this run's persistent state root.

    Basic Memory resolves its store from the environment, so the state root has
    to be in place before the package is imported: it reads configuration at
    import time and would otherwise bind to the invoking user home directory,
    putting benchmark records outside the measured state root.

    No provider callback is used. Measured under `--network none`, the six
    operations below complete entirely against a local store, which is what
    makes this arm free of the request classes the executor spec declares empty.
    """
    project_root = config["project_root"]
    if not isinstance(project_root, str) or not os.path.isabs(project_root):
        raise ContractError("Basic Memory requires an absolute project root")
    os.makedirs(project_root, exist_ok=True)

    # Set before import, for the reason above.
    os.environ["BASIC_MEMORY_HOME"] = project_root

    try:
        from basic_memory.mcp import tools as basic_memory_tools
    except Exception as error:  # noqa: BLE001
        raise RuntimeUnavailable(
            "Basic Memory pinned package is not importable in this runtime"
        ) from error

    exposed = {}
    for name in (
        "list_memory_projects",
        "create_memory_project",
        "delete_project",
        "write_note",
        "read_note",
        "search_notes",
    ):
        tool = getattr(basic_memory_tools, name, None)
        if tool is None:
            raise RuntimeUnavailable(
                "Basic Memory pinned package does not expose a required operation"
            )
        exposed[name] = getattr(tool, "fn", tool)

    return _PinnedBasicMemoryClient(exposed)


def _search_hit_identifier(hit) -> str:
    """The identifier a search hit can be read back by.

    Persist writes the record id as the note title, so a hit's title is the
    same identifier verify reads with. The permalink is accepted as a fallback
    for hits that omit it.
    """
    if not isinstance(hit, dict):
        raise ContractError("Basic Memory search returned an invalid result item")
    for field in ("title", "entity", "permalink"):
        value = hit.get(field)
        if isinstance(value, str) and value.strip():
            return value
    raise ContractError("Basic Memory search result exposes no readable identifier")


def _native_records(value) -> list[dict]:
    return [logical_record(item) for item in result_items(value)]


def _normalized_note(value):
    """Map a Basic Memory note onto the shape logical_record expects.

    Measured against basic-memory 0.23.2, `read_note(output_format="json")`
    returns `{title, permalink, file_path, content, frontmatter}`. Three things
    differ from what logical_record looks for, and all three have to be bridged
    here rather than by loosening the shared contract:

    - the record metadata is under `frontmatter`, not `metadata`
    - the identifier is `title`, not `name` or `id`
    - the body is returned with a leading newline the writer did not supply

    Whitespace is stripped from the body because the product adds it. That is
    safe to do blind: the frontmatter carries the content digest, so
    logical_record rejects the record if stripping ever changed its meaning.
    """
    if not isinstance(value, dict):
        return value
    frontmatter = value.get("frontmatter")
    if not isinstance(frontmatter, dict):
        return value
    content = value.get("content")
    return {
        "name": frontmatter.get("shadowgraph_record_id") or value.get("title"),
        "content": content.strip() if isinstance(content, str) else content,
        "metadata": frontmatter,
    }


def _one_native_record(value) -> list[dict]:
    if value is None:
        return []
    return [logical_record(_normalized_note(value))]


def _project_exists(value, project: str) -> bool:
    if not isinstance(value, dict) or not isinstance(value.get("projects"), list):
        raise ContractError("Basic Memory project listing is invalid")
    names = []
    for item in value["projects"]:
        if not isinstance(item, dict) or not isinstance(item.get("name"), str):
            raise ContractError("Basic Memory project listing is invalid")
        names.append(item["name"])
    return project in names


async def execute(
    request: dict,
    config: dict,
    *,
    client_factory=_default_client_factory,
    version_getter=installed_version,
) -> dict:
    validate_request(request)
    operations = empty_operations()
    provider_calls = ProviderCalls({"internal_memory_llm": None, "embedding": None})
    persistence = None
    isolation = None
    try:
        if request["armId"] != ADAPTER_ID:
            raise ContractError("Basic Memory adapter requires the exact basic-memory arm")
        namespace = request["namespace"]
        if not isinstance(namespace["projectId"], str) or not namespace["projectId"].strip():
            raise ContractError("Basic Memory requires a native project")
        if namespace["userId"] is not None:
            raise ContractError("Basic Memory has no native user namespace")
        require_routes(config, required=False)
        require_versions(PINNED_PACKAGES, version_getter)
        state_root = _persistent_state_root()
        project = namespace["projectId"]
        project_path = _project_path(state_root, project)
        client = await await_native(client_factory(_runtime_config(state_root), provider_calls))
        operation = request["operation"]
        if operation == "reset":
            if project == RESET_ANCHOR_PROJECT:
                raise ContractError("Basic Memory reset anchor is not a usable arm namespace")
            operations["memoryReadOperations"] += 1
            projects = await await_native(
                client.list_memory_projects(output_format="json", context=None)
            )
            if not _project_exists(projects, RESET_ANCHOR_PROJECT):
                operations["memoryWriteOperations"] += 1
                await await_native(
                    client.create_memory_project(
                        RESET_ANCHOR_PROJECT,
                        _project_path(state_root, RESET_ANCHOR_PROJECT),
                        set_default=False,
                        workspace=None,
                        output_format="json",
                    )
                )
            if _project_exists(projects, project):
                operations["memoryWriteOperations"] += 1
                await await_native(
                    client.delete_project(project, delete_notes=True, workspace=None)
                )
            project_path = _project_path(state_root, project)
            operations["memoryWriteOperations"] += 1
            await await_native(
                client.create_memory_project(
                    project,
                    project_path,
                    set_default=False,
                    workspace=None,
                    output_format="json",
                )
            )
        elif operation == "retrieve":
            operations["memoryReadOperations"] += 1
            raw = await await_native(
                client.search_notes(
                    request["payload"]["query"]["task"],
                    project=project,
                    project_id=None,
                    search_all_projects=False,
                    output_format="json",
                    search_type=LOCAL_SEARCH_TYPE,
                )
            )
            # A search hit is an entity reference carrying no note body, so it
            # cannot be turned into a logical record on its own. Read each hit
            # back through the same call verify uses, so retrieve and verify
            # agree on what a stored record is.
            native_context = []
            for hit in result_items(raw):
                operations["memoryReadOperations"] += 1
                note = await await_native(
                    client.read_note(
                        _search_hit_identifier(hit),
                        project=project,
                        project_id=None,
                        output_format="json",
                        include_frontmatter=False,
                    )
                )
                native_context.extend(_one_native_record(note))
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
                client.write_note(
                    record["id"],
                    encode_content(record["content"]),
                    DIRECTORY,
                    project=project,
                    project_id=None,
                    metadata={
                        "shadowgraph_record_id": record["id"],
                        "shadowgraph_record_type": record["type"],
                        "shadowgraph_content_sha256": record_content_sha256(record["content"]),
                    },
                    overwrite=True,
                    output_format="json",
                )
            )
        else:
            expected = request["payload"]["expectedRecord"]
            operations["persistenceVerificationOperations"] += 1
            primary_raw = await await_native(
                client.read_note(
                    expected["id"],
                    project=project,
                    project_id=None,
                    output_format="json",
                    include_frontmatter=False,
                )
            )
            primary = _one_native_record(primary_raw)
            alternate = None
            if request["payload"]["alternateNamespace"] is not None:
                alternate_namespace = request["payload"]["alternateNamespace"]
                if alternate_namespace["userId"] is not None:
                    raise ContractError("Basic Memory alternate user namespace is unsupported")
                operations["persistenceVerificationOperations"] += 1
                alternate_raw = await await_native(
                    client.read_note(
                        request["payload"]["expectedAbsentRecord"]["id"],
                        project=alternate_namespace["projectId"],
                        project_id=None,
                        output_format="json",
                        include_frontmatter=False,
                    )
                )
                alternate = _one_native_record(alternate_raw)
            persistence, isolation, verified = verification_evidence(
                request, primary, alternate
            )
            if not verified:
                return failed_response(
                    request,
                    "OPERATION_FAILED",
                    "Exact Basic Memory persistence or isolation verification failed",
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
        return build_envelope(request, operations=operations, storage=STORAGE)
    except RuntimeUnavailable:
        return failed_response(
            request,
            "ENDPOINT_UNAVAILABLE",
            "Pinned Basic Memory runtime is not available",
            operations,
            STORAGE,
            persistence=persistence,
            isolation=isolation,
        )
    except ContractError:
        return failed_response(
            request,
            "CONTRACT_FAILURE",
            "Basic Memory adapter contract failed closed",
            operations,
            STORAGE,
            persistence=persistence,
            isolation=isolation,
        )
    except Exception as error:
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
