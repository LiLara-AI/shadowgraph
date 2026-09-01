"""One-shot, allowlisted host for the v1.1 Python competitor adapters."""

from __future__ import annotations

import asyncio
import contextlib
import importlib
import io
import ipaddress
import json
import os
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
}


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
    }:
        raise ContractError("Python host wrapper fields are invalid")
    return wrapper


def _validate_wrapper(wrapper: dict) -> tuple[str, dict, dict]:
    if wrapper["schemaVersion"] != 1:
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
    return adapter_id, request, routes


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
        adapter_id, request, routes = _validate_wrapper(wrapper)
    except Exception:
        return 2

    response = None
    with _sanitized_environment():
        sink = _BoundedSink()
        try:
            with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
                module = importlib.import_module(ADAPTER_MODULES[adapter_id])
                operation = module.execute(request, routes)
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
