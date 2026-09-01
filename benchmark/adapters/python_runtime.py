"""Shared fake-driven runtime helpers for pinned Python benchmark adapters."""

from __future__ import annotations

import copy
import errno
import importlib.metadata
import inspect
import ipaddress
import json
import uuid
from typing import Any, Callable
from urllib.parse import urlsplit

from envelope import ContractError, build_envelope, canonical_json, record_content_sha256


ENCODING_PREFIX = "shadowgraph-benchmark-record:v2:"
BENCHMARK_UUID_NAMESPACE = uuid.UUID("2533a762-6523-53c2-bbd9-6f533c197a44")
COGNEE_DATASET_UUID_NAMESPACE = uuid.UUID("f266d968-ec78-5e9b-b767-b78eb418b156")
ENDPOINT_ERRNOS = {
    errno.ECONNREFUSED,
    errno.ECONNRESET,
    errno.EHOSTUNREACH,
    errno.ENETDOWN,
    errno.ENETUNREACH,
    errno.ENOENT,
    errno.EPIPE,
}


class RuntimeUnavailable(RuntimeError):
    """Pinned native runtime or an immutable service gate is unavailable."""


def classify_native_error(error: Exception) -> tuple[str, str]:
    if isinstance(error, TimeoutError):
        return "TIMEOUT", "Native adapter operation timed out"
    if isinstance(error, ConnectionError) or (
        isinstance(error, OSError) and error.errno in ENDPOINT_ERRNOS
    ):
        return "ENDPOINT_UNAVAILABLE", "Native adapter endpoint is unavailable"
    return "OPERATION_FAILED", "Native adapter operation failed"


def installed_version(distribution: str) -> str | None:
    try:
        return importlib.metadata.version(distribution)
    except importlib.metadata.PackageNotFoundError:
        return None


def require_versions(expected: dict[str, str], getter: Callable[[str], str | None]) -> None:
    for distribution, pinned in expected.items():
        if getter(distribution) != pinned:
            raise RuntimeUnavailable("Pinned Python competitor runtime is not available")


def _is_literal_loopback_endpoint(value: Any) -> bool:
    if not isinstance(value, str) or not value:
        return False
    try:
        parsed = urlsplit(value)
        address = ipaddress.ip_address(parsed.hostname or "")
        parsed.port
    except (TypeError, ValueError):
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


def require_routes(config: Any, *, required: bool) -> None:
    if not isinstance(config, dict) or set(config) != {"internal_memory_llm", "embedding"}:
        raise ContractError("Python adapter provider route config is invalid")
    values = (config["internal_memory_llm"], config["embedding"])
    if required and (
        not all(_is_literal_loopback_endpoint(value) for value in values)
        or len(set(values)) != len(values)
    ):
        raise ContractError("Python adapter requires two distinct metered provider routes")
    if not required and values != (None, None):
        raise ContractError("This Python adapter does not accept provider routes")


class ProviderCalls:
    def __init__(self, routes: dict):
        self.routes = copy.deepcopy(routes)
        self.counts = {"internal_memory_llm": 0, "embedding": 0}

    def __call__(self, request_class: str) -> None:
        if request_class not in self.counts or not self.routes.get(request_class):
            raise ContractError("Native client reported an unbound provider call")
        self.counts[request_class] += 1

    def apply(self, operations: dict) -> None:
        operations["internalMemoryModelCalls"] = self.counts["internal_memory_llm"]
        operations["embeddingCalls"] = self.counts["embedding"]

    def _validated_classes(self, request_classes: tuple[str, ...]) -> tuple[str, ...]:
        selected = request_classes or tuple(self.counts)
        if len(set(selected)) != len(selected) or any(
            request_class not in self.counts for request_class in selected
        ):
            raise ContractError("Native provider request class is invalid")
        return selected

    def require_traffic(self, *request_classes: str) -> None:
        for request_class in self._validated_classes(request_classes):
            if self.counts[request_class] < 1:
                raise ContractError("Required native provider traffic was not observed")

    def require_zero(self, *request_classes: str) -> None:
        for request_class in self._validated_classes(request_classes):
            if self.counts[request_class] != 0:
                raise ContractError("Unexpected native provider traffic was observed")


async def await_native(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


def encode_content(content: dict) -> str:
    if not isinstance(content, dict):
        raise ContractError("Benchmark record content must be an object")
    owned_record = {
        "content": copy.deepcopy(content),
        "contentSha256": record_content_sha256(content),
    }
    return ENCODING_PREFIX + canonical_json(owned_record)


def deterministic_native_uuid(adapter_id: str, logical_record_id: str) -> str:
    if not isinstance(adapter_id, str) or not adapter_id or not isinstance(logical_record_id, str) or not logical_record_id:
        raise ContractError("Native UUID inputs must be non-empty strings")
    return str(uuid.uuid5(BENCHMARK_UUID_NAMESPACE, f"{adapter_id}:{logical_record_id}"))


def deterministic_dataset_uuid(adapter_id: str, project_id: str) -> uuid.UUID:
    if not isinstance(adapter_id, str) or not adapter_id or not isinstance(project_id, str) or not project_id:
        raise ContractError("Dataset UUID inputs must be non-empty strings")
    return uuid.uuid5(COGNEE_DATASET_UUID_NAMESPACE, f"{adapter_id}:{project_id}")


def decode_content(value: Any) -> dict:
    if not isinstance(value, str) or not value.startswith(ENCODING_PREFIX):
        raise ContractError("Native record content is not benchmark-owned canonical data")
    raw = value[len(ENCODING_PREFIX) :]
    if not raw:
        raise ContractError("Native record content encoding is invalid")
    try:
        owned_record = json.loads(raw)
    except (TypeError, ValueError) as error:
        raise ContractError("Native record content encoding is invalid") from error
    if (
        not isinstance(owned_record, dict)
        or set(owned_record) != {"content", "contentSha256"}
        or not isinstance(owned_record["content"], dict)
        or not isinstance(owned_record["contentSha256"], str)
        or canonical_json(owned_record) != raw
    ):
        raise ContractError("Native record content is not canonical")
    content = owned_record["content"]
    if owned_record["contentSha256"] != record_content_sha256(content):
        raise ContractError("Native record content integrity check failed")
    return content


def logical_record(raw: Any, *, text_fields=("memory", "content", "data"), metadata_fields=("metadata", "external_metadata")) -> dict:
    if not isinstance(raw, dict):
        raw = {
            name: getattr(raw, name)
            for name in ("id", "uuid", "name", "memory", "content", "data", "metadata", "external_metadata")
            if hasattr(raw, name)
        }
    metadata = next((raw.get(field) for field in metadata_fields if isinstance(raw.get(field), dict)), {})
    record_id = metadata.get("shadowgraph_record_id") or raw.get("name") or raw.get("label") or raw.get("id") or raw.get("uuid")
    record_type = metadata.get("shadowgraph_record_type", "decision")
    encoded = next((raw.get(field) for field in text_fields if isinstance(raw.get(field), str)), None)
    if not isinstance(record_id, str) or not record_id or not isinstance(record_type, str) or encoded is None:
        raise ContractError("Native record does not expose an exact benchmark logical record")
    content = decode_content(encoded)
    expected_hash = metadata.get("shadowgraph_content_sha256")
    observed_hash = record_content_sha256(content)
    if expected_hash is not None and expected_hash != observed_hash:
        raise ContractError("Native record metadata contradicts its canonical content")
    return {"id": record_id, "type": record_type, "content": content}


def result_items(value: Any) -> list:
    if isinstance(value, list):
        return value
    if isinstance(value, dict):
        for field in ("results", "items", "memories", "data"):
            if isinstance(value.get(field), list):
                return value[field]
    if value is None:
        return []
    raise ContractError("Native client returned an invalid record collection")


def verification_evidence(request: dict, primary: list[dict], alternate: list[dict] | None) -> tuple[dict, dict | None, bool]:
    expected = request["payload"]["expectedRecord"]
    id_matches = [record for record in primary if record["id"] == expected["id"]]
    observed_hash = record_content_sha256(id_matches[0]["content"]) if len(id_matches) == 1 else None
    persistence = {
        "verified": len(id_matches) == 1 and observed_hash == expected["contentSha256"],
        "expectedRecord": copy.deepcopy(expected),
        "matchedRecordIds": [record["id"] for record in id_matches],
        "observedContentSha256": observed_hash,
        "namespaceRef": request["namespaceRef"],
    }
    isolation = None
    isolation_ok = True
    if alternate is not None:
        absent = request["payload"]["expectedAbsentRecord"]
        matching_ids = sum(record["id"] == absent["id"] for record in alternate)
        matching_content = sum(record_content_sha256(record["content"]) == absent["contentSha256"] for record in alternate)
        isolation_ok = matching_ids == 0 and matching_content == 0
        isolation = {
            "verified": isolation_ok,
            "expectedAbsentRecord": copy.deepcopy(absent),
            "alternateNamespaceRef": request["payload"]["alternateNamespaceRef"],
            "matchingRecordIdCount": matching_ids,
            "matchingContentCount": matching_content,
        }
    return persistence, isolation, persistence["verified"] and isolation_ok


def failed_response(request: dict, cause: str, message: str, operations: dict, storage: dict, *, persistence=None, isolation=None) -> dict:
    return build_envelope(
        request,
        status="FAILED",
        failure={"cause": cause, "message": message},
        operations=operations,
        storage=storage,
        persistence_evidence=persistence,
        isolation_evidence=isolation,
    )
