"""One-shot, allowlisted host for the v1.1 Python competitor adapters."""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import io
import ipaddress
import json
import os
import re
import socket
import sys
from urllib.parse import urlsplit

from envelope import (
    ContractError,
    build_envelope,
    empty_operations,
    not_available_storage,
    validate_request,
    validate_response,
)


PINNED_MODEL_ID = re.compile(r"\A[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}\Z")
MAX_INPUT_BYTES = 1_048_576
MAX_OUTPUT_BYTES = 1_048_576
ADAPTER_MODULES = {
    "mem0-oss": "mem0_adapter",
    "basic-memory": "basic_memory_adapter",
    "graphiti": "graphiti_adapter",
    "cognee": "cognee_adapter",
}
PROVIDER_ARMS = {"mem0-oss", "graphiti", "cognee"}
GATES = {
    "MEM0_TELEMETRY": "false",
    "GRAPHITI_TELEMETRY_ENABLED": "false",
    "TELEMETRY_DISABLED": "1",
    "BASIC_MEMORY_FORCE_LOCAL": "true",
    "BASIC_MEMORY_MODE": "local",
    "COGNEE_TRACING_ENABLED": "false",
    "OTEL_SDK_DISABLED": "true",
    # No arm may reach a model the benchmark has not pinned. Each of these
    # closes a path that fetches weights or reference data at measure time,
    # outside the provider meter:
    #
    #   Basic Memory turns semantic search on by default whenever `fastembed`
    #   and `sqlite_vec` are importable, then embeds and searches with its own
    #   `bge-small-en-v1.5`. Both are importable here - Basic Memory itself
    #   requires fastembed, and all four arms share one runtime - so the arm
    #   the definition records as making no provider call would have been
    #   embedding every note with an unpinned model.
    #
    #   LiteLLM downloads its model-cost map at import unless told to use the
    #   copy in the wheel.
    #
    #   HuggingFace Hub is how Mem0's Qdrant store reaches `Qdrant/bm25` and
    #   how Cognee resolves an embedding tokenizer. Offline mode makes both
    #   fail where they are already written to degrade.
    #
    # The frozen rules require this rather than merely permit it: provider
    # metering says internal LLM and embedding calls must go through the local
    # proxy, and sameConfigurationRule says every measured arm uses the same
    # embedding id. An arm embedding locally with its own model satisfies
    # neither.
    "BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED": "false",
    "BASIC_MEMORY_RERANKER_ENABLED": "false",
    "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    "HF_HUB_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
}
LOOPBACK_FAMILIES = (socket.AF_INET, socket.AF_INET6)

# Every entry point in `socket` by which an address or a name can leave this
# process. Named once, because the saved originals, the guards that replace
# them and the restore all read from this list: an entry point added to one
# of the three and forgotten in the others is the shape of the hole this
# fence has already had. A `socket.` prefix means the method on the socket
# type; everything else is a module-level function.
FENCED_ENTRY_POINTS = (
    "socket.connect",
    "socket.connect_ex",
    "socket.sendto",
    "socket.sendmsg",
    "create_connection",
    "getaddrinfo",
    "gethostbyname",
    "gethostbyname_ex",
    "gethostbyaddr",
    "getnameinfo",
)


def _fence_owner(name):
    owner, _, attribute = name.rpartition(".")
    return (socket.socket if owner == "socket" else socket), attribute


def _entry_point(name):
    """The callable a fenced name currently resolves to."""
    owner, attribute = _fence_owner(name)
    return getattr(owner, attribute)



class NetworkFenceError(OSError):
    """An adapter attempted to reach an address outside loopback."""


def _loopback_host(host) -> bool:
    if isinstance(host, bytes):
        try:
            host = host.decode("ascii")
        except UnicodeDecodeError:
            return False
    if not isinstance(host, str) or not host:
        return False
    if host in ("localhost", "localhost.localdomain"):
        return True
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


@contextlib.contextmanager
def _loopback_only_network():
    """Refuse every outbound datagram, connection and lookup that is not loopback.

    The environment gates above close the paths that are known today. This
    closes the ones a library adds tomorrow, by taking the `socket` module's
    egress and resolution surface rather than by naming the libraries: an
    adapter that cannot address a non-loopback peer cannot make an unmetered
    call, whatever it intended.

    It is an enumeration, and calling it anything else was the defect. The
    first version of this fence guarded `connect`, `connect_ex`,
    `create_connection` and `getaddrinfo` and described itself as closing
    egress 'by construction'. It did not: a datagram needs no connection, so
    `sock.sendto(payload, ("192.0.2.1", 9))` left the process untouched, and
    `socket.gethostbyname` resolves without going through `getaddrinfo` at all
    - both demonstrated against this module. What follows is every entry point
    in `socket` by which an address or a name can leave this process, and the
    honest description of the fence is that list. `send` and `sendall` are
    absent deliberately: reaching them requires a `connect` this fence refuses.

    The container's own network namespace is the part that *is* by
    construction, and it is the stronger guarantee - but it is available only
    to an arm that meters nothing (`--network none`). A metered arm shares the
    host namespace precisely so the provider meter, the pinned model endpoint
    and the pinned graph database are reachable on 127.0.0.1, and for that arm
    this fence is the barrier.

    Loopback is the whole of what a measured unit legitimately needs, so the
    fence costs the benchmark nothing and costs an unpinned fetch everything.

    Name resolution is fenced for its own reason. Refusing the connection but
    allowing the lookup would still put the hostname on the wire, and a
    resolver query is an observation of what this process is doing that the
    benchmark did not sanction.
    """
    originals = {name: _entry_point(name) for name in FENCED_ENTRY_POINTS}

    def permitted(family, address) -> bool:
        if family not in LOOPBACK_FAMILIES:
            # AF_UNIX and the rest never leave the machine.
            return True
        if not isinstance(address, tuple) or not address:
            return False
        return _loopback_host(address[0])

    def refuse_address():
        raise NetworkFenceError("Adapter network access is limited to loopback")

    def refuse_name():
        raise NetworkFenceError("Adapter name resolution is limited to loopback")

    def guarded_connect(self, address):
        if not permitted(self.family, address):
            refuse_address()
        return originals["socket.connect"](self, address)

    def guarded_connect_ex(self, address):
        if not permitted(self.family, address):
            refuse_address()
        return originals["socket.connect_ex"](self, address)

    def guarded_sendto(self, *args):
        # sendto(data, address) and sendto(data, flags, address): the peer is
        # always the last argument, and a datagram needs no connection - which
        # is how the first version of this fence let one out.
        if len(args) >= 2 and not permitted(self.family, args[-1]):
            refuse_address()
        return originals["socket.sendto"](self, *args)

    def guarded_sendmsg(self, *args):
        # sendmsg(buffers[, ancdata[, flags[, address]]]): the address is the
        # fourth argument, and present only when the socket is unconnected.
        if len(args) >= 4 and args[3] is not None and not permitted(self.family, args[3]):
            refuse_address()
        return originals["socket.sendmsg"](self, *args)

    def guarded_create_connection(address, *args, **kwargs):
        if not (isinstance(address, tuple) and address and _loopback_host(address[0])):
            refuse_address()
        return originals["create_connection"](address, *args, **kwargs)

    def name_guard(key):
        # gethostbyname and its siblings do not route through getaddrinfo, so
        # fencing that one alone still left a resolver query on the wire.
        def guarded(host, *args, **kwargs):
            if not _loopback_host(host):
                refuse_name()
            return originals[key](host, *args, **kwargs)

        return guarded

    def guarded_getnameinfo(sockaddr, *args, **kwargs):
        if not (isinstance(sockaddr, tuple) and sockaddr and _loopback_host(sockaddr[0])):
            refuse_name()
        return originals["getnameinfo"](sockaddr, *args, **kwargs)

    fenced = {
        "socket.connect": guarded_connect,
        "socket.connect_ex": guarded_connect_ex,
        "socket.sendto": guarded_sendto,
        "socket.sendmsg": guarded_sendmsg,
        "create_connection": guarded_create_connection,
        "getaddrinfo": name_guard("getaddrinfo"),
        "gethostbyname": name_guard("gethostbyname"),
        "gethostbyname_ex": name_guard("gethostbyname_ex"),
        "gethostbyaddr": name_guard("gethostbyaddr"),
        "getnameinfo": guarded_getnameinfo,
    }
    # Every saved original is replaced and every replacement is restored: the
    # two tables share one key set, so an entry point added to one and
    # forgotten in the other is a failure here rather than a hole at runtime.
    if set(fenced) != set(originals):
        raise RuntimeError("the loopback fence must guard exactly the entry points it saved")

    def install(table):
        for key, value in table.items():
            owner, attribute = _fence_owner(key)
            setattr(owner, attribute, value)

    install(fenced)
    try:
        yield
    finally:
        install(originals)


class _BoundedSink(io.TextIOBase):
    def __init__(self, limit: int = 65_536) -> None:
        self.limit = limit
        self.length = 0

    def writable(self) -> bool:
        return True

    def write(self, value) -> int:
        text = str(value)
        self.length = min(self.limit, self.length + len(text))
        return len(text)


def _sensitive_environment_name(name: str) -> bool:
    normalized = "".join(character for character in name.upper() if character.isalnum())
    return (
        any(marker in normalized for marker in ("APIKEY", "SECRET", "PASSWORD", "AUTHORIZATION", "CREDENTIAL"))
        or normalized.endswith("TOKEN")
        or normalized.startswith(("OPENAI", "ANTHROPIC", "AZUREOPENAI", "LANGFUSE", "OTEL"))
    )


@contextlib.contextmanager
def _sanitized_environment():
    changed = {}
    removed = {}
    for name in list(os.environ):
        if _sensitive_environment_name(name):
            removed[name] = os.environ.pop(name)
    for name, value in GATES.items():
        changed[name] = os.environ.get(name)
        os.environ[name] = value
    if "BASIC_MEMORY_CONFIG_DIR" not in os.environ:
        changed["BASIC_MEMORY_CONFIG_DIR"] = None
        os.environ["BASIC_MEMORY_CONFIG_DIR"] = os.path.join(os.getcwd(), ".basic-memory-config")
    try:
        yield
    finally:
        for name, previous in changed.items():
            if previous is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = previous
        os.environ.update(removed)


def _is_literal_loopback_endpoint(value) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = urlsplit(value)
        address = ipaddress.ip_address(parsed.hostname or "")
    except (ValueError, TypeError):
        return False
    return (
        parsed.scheme == "http"
        and address.is_loopback
        and parsed.username is None
        and parsed.password is None
        and not parsed.query
        and not parsed.fragment
        and bool(parsed.netloc)
        and parsed.path not in ("", "/")
    )


def _read_one_record(input_stream) -> dict:
    raw = input_stream.read(MAX_INPUT_BYTES + 1)
    if isinstance(raw, bytes):
        if len(raw) > MAX_INPUT_BYTES:
            raise ContractError("Python host input exceeded its limit")
        try:
            raw = raw.decode("utf-8", errors="strict")
        except UnicodeDecodeError as error:
            raise ContractError("Python host input is not UTF-8") from error
    elif not isinstance(raw, str):
        raise ContractError("Python host input stream is invalid")
    if len(raw.encode("utf-8")) > MAX_INPUT_BYTES:
        raise ContractError("Python host input exceeded its limit")
    if not raw.endswith("\n") or raw.count("\n") != 1 or "\r" in raw:
        raise ContractError("Python host requires exactly one newline-delimited record")
    try:
        wrapper = json.loads(raw[:-1])
    except json.JSONDecodeError as error:
        raise ContractError("Python host input is malformed") from error
    if not isinstance(wrapper, dict) or set(wrapper) != {
        "schemaVersion",
        "adapterId",
        "request",
        "providerRoutes",
        "providerModels",
    }:
        raise ContractError("Python host wrapper fields are invalid")
    return wrapper


def _is_pinned_model(value, *, embedding: bool) -> bool:
    if not isinstance(value, dict) or set(value) != {"modelId", "embeddingDimension"}:
        return False
    if not isinstance(value["modelId"], str) or not PINNED_MODEL_ID.match(value["modelId"]):
        return False
    dimension = value["embeddingDimension"]
    if embedding:
        return isinstance(dimension, int) and not isinstance(dimension, bool) and dimension > 0
    return dimension is None


def _validate_wrapper(wrapper: dict) -> tuple[str, dict, dict, dict]:
    if wrapper["schemaVersion"] != 2:
        raise ContractError("Python host wrapper version is invalid")
    adapter_id = wrapper["adapterId"]
    if adapter_id not in ADAPTER_MODULES:
        raise ContractError("Python host adapter is not allowlisted")
    request = wrapper["request"]
    validate_request(request)
    if request["armId"] != adapter_id:
        raise ContractError("Python host adapter and arm do not match")
    routes = wrapper["providerRoutes"]
    if not isinstance(routes, dict) or set(routes) != {"internal_memory_llm", "embedding"}:
        raise ContractError("Python host provider route fields are invalid")
    if adapter_id in PROVIDER_ARMS:
        route_values = [routes[field] for field in routes]
        if (
            not all(_is_literal_loopback_endpoint(value) for value in route_values)
            or len(set(route_values)) != len(route_values)
        ):
            raise ContractError("Python host provider routes are invalid")
    elif routes != {"internal_memory_llm": None, "embedding": None}:
        raise ContractError("Basic Memory must not receive provider routes")
    models = wrapper["providerModels"]
    if not isinstance(models, dict) or set(models) != {"internal_memory_llm", "embedding"}:
        raise ContractError("Python host pinned model fields are invalid")
    # An arm is handed a model for a class exactly when it is handed a route for
    # it. Stating the correspondence rather than repeating the arm list is what
    # makes a route added without a model - the case that would silently reach a
    # library default - a refusal here instead of a measurement later.
    for request_class in ("internal_memory_llm", "embedding"):
        metered = routes[request_class] is not None
        model = models[request_class]
        if metered != (model is not None):
            raise ContractError("Python host pinned models do not match the routes")
        if metered and not _is_pinned_model(model, embedding=request_class == "embedding"):
            raise ContractError("Python host pinned model is invalid")
    return adapter_id, request, routes, models


def _failure_response(request: dict, adapter_id: str) -> dict:
    return build_envelope(
        request,
        status="FAILED",
        failure={
            "cause": "INFRASTRUCTURE_FAILURE",
            "message": "Python adapter host failed",
        },
        operations=empty_operations(),
        storage=not_available_storage(
            f"{adapter_id} native storage scope",
            "Python adapter host did not produce attributable storage evidence",
        ),
    )


def _write_response(output_stream, response: dict, routes: dict) -> None:
    serialized = json.dumps(response, ensure_ascii=False, separators=(",", ":")) + "\n"
    if len(serialized.encode("utf-8")) > MAX_OUTPUT_BYTES:
        raise ContractError("Python host response exceeded its limit")
    if any(route is not None and route in serialized for route in routes.values()):
        raise ContractError("Python host response exposed a provider capability")
    output_stream.write(serialized)
    output_stream.flush()


def process_stream(input_stream, output_stream) -> int:
    try:
        wrapper = _read_one_record(input_stream)
        adapter_id, request, routes, models = _validate_wrapper(wrapper)
    except Exception:
        return 2

    response = None
    with _sanitized_environment(), _loopback_only_network():
        sink = _BoundedSink()
        try:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                module = importlib.import_module(ADAPTER_MODULES[adapter_id])
                operation = module.execute(request, routes, models)
                response = asyncio.run(operation)
            validate_response(request, response)
        except Exception:
            response = _failure_response(request, adapter_id)
    try:
        _write_response(output_stream, response, routes)
    except Exception:
        return 3
    return 0


def main() -> int:
    return process_stream(sys.stdin, sys.stdout)


if __name__ == "__main__":
    raise SystemExit(main())
