"""Strict Python mirror of the ShadowGraph benchmark v1.1 adapter contract."""

from __future__ import annotations

import hashlib
import json
import math
import re
from typing import Any


REQUEST_FIELDS = (
    "schemaVersion",
    "operation",
    "runId",
    "attemptId",
    "phase",
    "armId",
    "scenarioId",
    "repetition",
    "namespace",
    "namespaceRef",
    "payload",
)
CORRELATION_FIELDS = ("runId", "attemptId", "phase", "armId", "scenarioId", "repetition")
OPERATIONS = ("reset", "retrieve", "persist", "verify")
OPERATION_FIELDS = (
    "memoryReadOperations",
    "memoryWriteOperations",
    "mcpToolCalls",
    "outerDecisionModelCalls",
    "internalMemoryModelCalls",
    "embeddingCalls",
    "persistenceVerificationOperations",
)
ENVELOPE_FIELDS = (
    "schemaVersion",
    "operation",
    "runId",
    "attemptId",
    "phase",
    "armId",
    "scenarioId",
    "repetition",
    "status",
    "result",
    "failure",
    "operations",
    "storage",
)
ADAPTER_STATUSES = ("SUCCEEDED", "FAILED", "NOT_APPLICABLE")
FAILURE_CAUSES = (
    "ENDPOINT_UNAVAILABLE",
    "ADAPTER_INVALID",
    "INFRASTRUCTURE_FAILURE",
    "CONTRACT_FAILURE",
    "OPERATOR_INTERRUPTION",
    "TIMEOUT",
    "OPERATION_FAILED",
)
DECISION_SCHEMA = {
    "decisionId": "string|null",
    "choiceId": "string|null",
    "recalledAlternativeIds": "string[]",
    "recalledRejectionReasonIds": "string[]",
    "constraintIdsAddressed": "string[]",
    "evidenceIdsCited": "string[]",
    "riskIdsRecognized": "string[]",
    "reviewTriggerIds": "string[]",
    "changedFactDetected": "boolean|null",
    "changedFactId": "string|null",
    "recommendation": "string",
    "failedAttemptIdsAvoided": "string[]",
    "failedAttemptReasonIdsCited": "string[]",
    "memoryProjectId": "string|null",
    "memoryUserId": "string|null",
}
FORBIDDEN_KEYS = {
    "apikey",
    "applicability",
    "authorization",
    "credential",
    "expectedanswer",
    "expectedchoice",
    "fixture",
    "key",
    "messages",
    "model",
    "outerdecisionmodelcalls",
    "outermodel",
    "password",
    "permission",
    "prompt",
    "requestclass",
    "retries",
    "retry",
    "score",
    "scored",
    "secret",
    "token",
    "usage",
}
SHA256 = re.compile(r"^[a-f0-9]{64}$")
OUTER_INSTRUCTION = re.compile(
    r"\b(?:call|invoke|contact)\s+(?:the\s+)?(?:(?:common|central)\s+)?outer\s+(?:decision\s+)?model\b",
    re.IGNORECASE,
)
MAX_SAFE_INTEGER = 9_007_199_254_740_991


class ContractError(ValueError):
    """A sanitized adapter-contract failure."""


def _is_object(value: Any) -> bool:
    return isinstance(value, dict)


def _is_non_empty_string(value: Any) -> bool:
    return isinstance(value, str) and bool(value.strip())


def _safe_integer(value: Any, *, minimum: int = 0) -> bool:
    return (
        isinstance(value, int)
        and not isinstance(value, bool)
        and minimum <= value <= MAX_SAFE_INTEGER
    )


def _exact_keys(value: Any, expected: tuple[str, ...] | list[str] | set[str], label: str) -> None:
    if not _is_object(value):
        raise ContractError(f"{label} must be an object")
    expected_set = set(expected)
    actual = set(value)
    if actual != expected_set:
        raise ContractError(f"{label} fields do not match the exact contract")


def _normalized_key(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", value.lower())


def _forbidden_key(value: str) -> bool:
    normalized = _normalized_key(value)
    return (
        normalized in FORBIDDEN_KEYS
        or "outermodel" in normalized
        or normalized.endswith("apikey")
        or normalized.endswith("password")
        or normalized.endswith("secret")
        or normalized.endswith("credential")
        or normalized.endswith("accesstoken")
        or normalized.endswith("bearertoken")
        or normalized.endswith("token")
    )


def _validate_json(value: Any, label: str, *, forbid_authority: bool = False) -> None:
    if value is None or isinstance(value, (bool, str)):
        if forbid_authority and isinstance(value, str) and OUTER_INSTRUCTION.search(value):
            raise ContractError(f"{label} contains forbidden outer-model instructions")
        return
    if isinstance(value, int) and not isinstance(value, bool):
        if abs(value) > MAX_SAFE_INTEGER:
            raise ContractError(f"{label} contains an unsafe integer")
        return
    if isinstance(value, float):
        if not math.isfinite(value):
            raise ContractError(f"{label} contains a non-finite number")
        return
    if isinstance(value, list):
        for index, item in enumerate(value):
            _validate_json(item, f"{label}[{index}]", forbid_authority=forbid_authority)
        return
    if _is_object(value):
        for key, item in value.items():
            if not isinstance(key, str):
                raise ContractError(f"{label} keys must be strings")
            if forbid_authority and _forbidden_key(key):
                raise ContractError(f"{label} contains a forbidden field")
            _validate_json(item, f"{label}.{key}", forbid_authority=forbid_authority)
        return
    raise ContractError(f"{label} must contain JSON-compatible data")


def canonical_json(value: Any) -> str:
    _validate_json(value, "canonical JSON")
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _domain_sha256(domain: str, value: Any) -> str:
    digest = hashlib.sha256()
    digest.update(domain.encode("utf-8"))
    digest.update(b"\0")
    digest.update(canonical_json(value).encode("utf-8"))
    return digest.hexdigest()


def record_content_sha256(content: dict) -> str:
    return _domain_sha256("shadowgraph:v1.1:record-content:v1", content)


def _validate_namespace(namespace: Any, label: str = "adapter request.namespace") -> None:
    _exact_keys(namespace, ("projectId", "userId"), label)
    for field in ("projectId", "userId"):
        value = namespace[field]
        if value is not None and not _is_non_empty_string(value):
            raise ContractError(f"{label}.{field} must be null or a non-empty string")


def namespace_ref_for(correlation: dict, namespace: dict) -> str:
    _exact_keys(correlation, ("runId", "armId", "scenarioId", "repetition", "phase"), "namespace correlation")
    for field in ("runId", "armId", "scenarioId", "phase"):
        if not _is_non_empty_string(correlation[field]):
            raise ContractError(f"namespace correlation.{field} must be a non-empty string")
    if not _safe_integer(correlation["repetition"]):
        raise ContractError("namespace correlation.repetition must be a non-negative safe integer")
    _validate_namespace(namespace, "namespace")
    return _domain_sha256(
        "shadowgraph:v1.1:namespace-ref:v1",
        {"correlation": correlation, "namespace": namespace},
    )


def _namespace_correlation(request: dict) -> dict:
    return {
        "runId": request["runId"],
        "armId": request["armId"],
        "scenarioId": request["scenarioId"],
        "repetition": request["repetition"],
        "phase": request["phase"],
    }


def _validate_decision(content: Any) -> None:
    _exact_keys(content, tuple(DECISION_SCHEMA), "decision response")
    for field, kind in DECISION_SCHEMA.items():
        value = content[field]
        if kind == "string" and not isinstance(value, str):
            raise ContractError(f"decision response.{field} must be a string")
        if kind == "string|null" and value is not None and not isinstance(value, str):
            raise ContractError(f"decision response.{field} must be a string or null")
        if kind == "boolean|null" and value is not None and not isinstance(value, bool):
            raise ContractError(f"decision response.{field} must be a boolean or null")
        if kind == "string[]" and (
            not isinstance(value, list) or not all(isinstance(item, str) for item in value)
        ):
            raise ContractError(f"decision response.{field} must be an array of strings")


def _validate_record_reference(value: Any, label: str) -> None:
    _exact_keys(value, ("id", "type", "contentSha256"), label)
    if not _is_non_empty_string(value["id"]) or not _is_non_empty_string(value["type"]):
        raise ContractError(f"{label} id and type must be non-empty strings")
    if not isinstance(value["contentSha256"], str) or not SHA256.fullmatch(value["contentSha256"]):
        raise ContractError(f"{label}.contentSha256 must be a lowercase SHA-256 digest")


def validate_request(request: Any) -> None:
    _exact_keys(request, REQUEST_FIELDS, "adapter request")
    if request["schemaVersion"] != 1:
        raise ContractError("adapter request.schemaVersion must equal 1")
    if request["operation"] not in OPERATIONS:
        raise ContractError("adapter request operation is invalid")
    for field in ("runId", "attemptId", "phase", "armId", "scenarioId"):
        if not _is_non_empty_string(request[field]):
            raise ContractError(f"adapter request.{field} must be a non-empty string")
    if not _safe_integer(request["repetition"]):
        raise ContractError("adapter request.repetition must be a non-negative safe integer")
    _validate_namespace(request["namespace"])
    expected_ref = namespace_ref_for(_namespace_correlation(request), request["namespace"])
    if request["namespaceRef"] != expected_ref:
        raise ContractError("adapter request namespace reference does not match")

    payload = request["payload"]
    operation = request["operation"]
    if operation == "reset":
        _exact_keys(payload, (), "reset payload")
    elif operation == "retrieve":
        _exact_keys(payload, ("query",), "retrieve payload")
        _exact_keys(payload["query"], ("scenarioId", "task"), "retrieve query")
        if payload["query"]["scenarioId"] != request["scenarioId"]:
            raise ContractError("retrieve scenario correlation does not match")
        if not _is_non_empty_string(payload["query"]["task"]):
            raise ContractError("retrieve task must be non-empty text")
        try:
            decoded = json.loads(payload["query"]["task"])
        except (json.JSONDecodeError, TypeError):
            decoded = None
        if isinstance(decoded, (dict, list)):
            raise ContractError("retrieve task must be plain text")
    elif operation == "persist":
        _exact_keys(payload, ("record",), "persist payload")
        record = payload["record"]
        _exact_keys(record, ("id", "type", "content"), "persist record")
        if not _is_non_empty_string(record["id"]):
            raise ContractError("persist record id must be a non-empty string")
        if record["type"] == "decision":
            _validate_decision(record["content"])
        elif record["type"] == "failed_attempt":
            _exact_keys(record["content"], ("id", "approachId", "reasonId", "reason"), "failed attempt")
            if any(not _is_non_empty_string(record["content"][field]) for field in record["content"]):
                raise ContractError("failed attempt fields must be non-empty strings")
            if record["id"] != record["content"]["id"]:
                raise ContractError("failed attempt id must match its content")
        else:
            raise ContractError("persist record type is invalid")
    else:
        _exact_keys(
            payload,
            ("expectedRecord", "alternateNamespace", "alternateNamespaceRef", "expectedAbsentRecord"),
            "verify payload",
        )
        _validate_record_reference(payload["expectedRecord"], "verify expected record")
        if payload["alternateNamespace"] is None:
            if payload["alternateNamespaceRef"] is not None or payload["expectedAbsentRecord"] is not None:
                raise ContractError("verify isolation fields must all be null")
        else:
            _validate_namespace(payload["alternateNamespace"], "verify alternate namespace")
            _validate_record_reference(payload["expectedAbsentRecord"], "verify absent record")
            alternate_ref = namespace_ref_for(
                _namespace_correlation(request), payload["alternateNamespace"]
            )
            if payload["alternateNamespaceRef"] != alternate_ref or alternate_ref == request["namespaceRef"]:
                raise ContractError("verify alternate namespace reference does not match")
    _validate_json(payload, "adapter request.payload", forbid_authority=True)


def empty_operations(**overrides: int) -> dict:
    if any(field not in OPERATION_FIELDS for field in overrides):
        raise ContractError("operation counter override is unknown")
    operations = {field: overrides.get(field, 0) for field in OPERATION_FIELDS}
    _validate_operations(operations)
    return operations


def not_available_storage(scope: str, reason: str) -> dict:
    if not _is_non_empty_string(scope) or not _is_non_empty_string(reason):
        raise ContractError("unavailable storage requires a scope and reason")
    return {
        "status": "NOT_AVAILABLE",
        "bytes": None,
        "scope": scope,
        "method": None,
        "reason": reason,
        "blockedClaims": ["storage bytes"],
    }


def measured_storage(bytes_count: int, scope: str, method: str) -> dict:
    storage = {
        "status": "MEASURED",
        "bytes": bytes_count,
        "scope": scope,
        "method": method,
        "reason": None,
        "blockedClaims": [],
    }
    _validate_storage(storage)
    return storage


def _validate_operations(operations: Any) -> None:
    _exact_keys(operations, OPERATION_FIELDS, "adapter operations")
    for field, value in operations.items():
        if not _safe_integer(value):
            raise ContractError(f"adapter operation {field} must be a non-negative safe integer")
    if operations["outerDecisionModelCalls"] != 0:
        raise ContractError("adapter outerDecisionModelCalls must be zero")


def _validate_storage(storage: Any) -> None:
    _exact_keys(storage, ("status", "bytes", "scope", "method", "reason", "blockedClaims"), "storage")
    if storage["status"] == "MEASURED":
        if not _safe_integer(storage["bytes"]):
            raise ContractError("measured storage bytes must be a non-negative safe integer")
        if not _is_non_empty_string(storage["scope"]) or not _is_non_empty_string(storage["method"]):
            raise ContractError("measured storage requires scope and method")
        if storage["reason"] is not None or storage["blockedClaims"] != []:
            raise ContractError("measured storage may not have a reason or blocked claims")
        return
    if storage["status"] != "NOT_AVAILABLE":
        raise ContractError("storage status is invalid")
    if storage["bytes"] is not None or storage["method"] is not None:
        raise ContractError("unavailable storage bytes and method must be null")
    if not _is_non_empty_string(storage["scope"]) or not _is_non_empty_string(storage["reason"]):
        raise ContractError("unavailable storage requires scope and reason")
    if not isinstance(storage["blockedClaims"], list) or not storage["blockedClaims"] or not all(
        _is_non_empty_string(value) for value in storage["blockedClaims"]
    ):
        raise ContractError("unavailable storage requires blocked claims")


def _validate_persistence(value: Any) -> None:
    if value is None:
        return
    _exact_keys(
        value,
        ("verified", "expectedRecord", "matchedRecordIds", "observedContentSha256", "namespaceRef"),
        "persistence evidence",
    )
    if not isinstance(value["verified"], bool):
        raise ContractError("persistence verified must be boolean")
    _validate_record_reference(value["expectedRecord"], "persistence expected record")
    if not isinstance(value["matchedRecordIds"], list) or not all(
        _is_non_empty_string(item) for item in value["matchedRecordIds"]
    ):
        raise ContractError("persistence matched ids must be strings")
    observed = value["observedContentSha256"]
    if observed is not None and (not isinstance(observed, str) or not SHA256.fullmatch(observed)):
        raise ContractError("persistence observed hash is invalid")
    if not isinstance(value["namespaceRef"], str) or not SHA256.fullmatch(value["namespaceRef"]):
        raise ContractError("persistence namespace reference is invalid")
    if value["verified"] and (
        value["matchedRecordIds"] != [value["expectedRecord"]["id"]]
        or observed != value["expectedRecord"]["contentSha256"]
    ):
        raise ContractError("verified persistence evidence is not exact")


def _validate_isolation(value: Any) -> None:
    if value is None:
        return
    _exact_keys(
        value,
        (
            "verified",
            "expectedAbsentRecord",
            "alternateNamespaceRef",
            "matchingRecordIdCount",
            "matchingContentCount",
        ),
        "isolation evidence",
    )
    if not isinstance(value["verified"], bool):
        raise ContractError("isolation verified must be boolean")
    _validate_record_reference(value["expectedAbsentRecord"], "isolation absent record")
    if not isinstance(value["alternateNamespaceRef"], str) or not SHA256.fullmatch(
        value["alternateNamespaceRef"]
    ):
        raise ContractError("isolation namespace reference is invalid")
    for field in ("matchingRecordIdCount", "matchingContentCount"):
        if not _safe_integer(value[field]):
            raise ContractError(f"isolation {field} must be a non-negative safe integer")
    if value["verified"] and (
        value["matchingRecordIdCount"] != 0 or value["matchingContentCount"] != 0
    ):
        raise ContractError("verified isolation requires zero matches")


def build_envelope(
    request: dict,
    *,
    status: str = "SUCCEEDED",
    native_context: list[dict] | None = None,
    persistence_evidence: dict | None = None,
    isolation_evidence: dict | None = None,
    failure: dict | None = None,
    operations: dict | None = None,
    storage: dict | None = None,
) -> dict:
    validate_request(request)
    if operations is None:
        operation_overrides = {}
    elif _is_object(operations):
        operation_overrides = operations
    else:
        raise ContractError("operation counter overrides must be an object")
    counters = empty_operations(**operation_overrides)
    response = {
        "schemaVersion": 1,
        "operation": request["operation"],
        "runId": request["runId"],
        "attemptId": request["attemptId"],
        "phase": request["phase"],
        "armId": request["armId"],
        "scenarioId": request["scenarioId"],
        "repetition": request["repetition"],
        "status": status,
        "result": {
            "nativeContext": [] if native_context is None else native_context,
            "persistenceEvidence": persistence_evidence,
            "isolationEvidence": isolation_evidence,
        },
        "failure": failure,
        "operations": counters,
        "storage": storage
        if storage is not None
        else not_available_storage(
            "Unspecified native storage scope",
            "Exact attributable bytes are unavailable",
        ),
    }
    validate_response(request, response)
    return response


def validate_response(request: dict, response: Any) -> None:
    validate_request(request)
    _exact_keys(response, ENVELOPE_FIELDS, "adapter response")
    if response["schemaVersion"] != 1 or response["operation"] not in OPERATIONS:
        raise ContractError("adapter response schema or operation is invalid")
    for field in ("operation",) + CORRELATION_FIELDS:
        if response[field] != request[field]:
            raise ContractError("adapter response correlation does not match")
    if response["status"] not in ADAPTER_STATUSES:
        raise ContractError("adapter response status is invalid")
    result = response["result"]
    _exact_keys(result, ("nativeContext", "persistenceEvidence", "isolationEvidence"), "adapter result")
    if not isinstance(result["nativeContext"], list) or not all(_is_object(item) for item in result["nativeContext"]):
        raise ContractError("adapter native context must be an array of objects")
    _validate_json(result["nativeContext"], "adapter native context", forbid_authority=True)
    _validate_persistence(result["persistenceEvidence"])
    _validate_isolation(result["isolationEvidence"])
    if response["status"] == "FAILED":
        _exact_keys(response["failure"], ("cause", "message"), "adapter failure")
        if response["failure"]["cause"] not in FAILURE_CAUSES or not _is_non_empty_string(
            response["failure"]["message"]
        ):
            raise ContractError("adapter failure is invalid")
    elif response["failure"] is not None:
        raise ContractError("successful adapter response must have null failure")
    _validate_operations(response["operations"])
    _validate_storage(response["storage"])
    if request["operation"] != "retrieve" and result["nativeContext"]:
        raise ContractError("native context is only valid for retrieve")
    if request["operation"] != "verify" and (
        result["persistenceEvidence"] is not None or result["isolationEvidence"] is not None
    ):
        raise ContractError("adapter evidence is only valid for verify")
    if response["status"] == "NOT_APPLICABLE" and (
        result["nativeContext"]
        or result["persistenceEvidence"] is not None
        or result["isolationEvidence"] is not None
    ):
        raise ContractError("not-applicable response must be empty")
    persistence = result["persistenceEvidence"]
    isolation = result["isolationEvidence"]
    if persistence is not None and persistence["namespaceRef"] != request["namespaceRef"]:
        raise ContractError("persistence evidence namespace does not match")
    if request["operation"] == "verify":
        expected = request["payload"]["expectedRecord"]
        alternate = request["payload"]["alternateNamespace"]
        if persistence is not None and persistence["expectedRecord"] != expected:
            raise ContractError("persistence expected record does not match")
        if alternate is None and isolation is not None:
            raise ContractError("unrequested isolation evidence is forbidden")
        if alternate is not None and isolation is not None:
            if isolation["alternateNamespaceRef"] != request["payload"]["alternateNamespaceRef"]:
                raise ContractError("isolation namespace does not match")
            if isolation["expectedAbsentRecord"] != request["payload"]["expectedAbsentRecord"]:
                raise ContractError("isolation absent record does not match")
        persistence_verified = (
            persistence is not None
            and persistence["verified"] is True
            and persistence["matchedRecordIds"] == [expected["id"]]
            and persistence["observedContentSha256"] == expected["contentSha256"]
        )
        isolation_verified = alternate is None or (
            isolation is not None
            and isolation["verified"] is True
            and isolation["matchingRecordIdCount"] == 0
            and isolation["matchingContentCount"] == 0
        )
        if response["status"] == "SUCCEEDED" and not (persistence_verified and isolation_verified):
            raise ContractError("successful verification evidence is incomplete")
        if response["status"] == "FAILED" and persistence_verified and isolation_verified:
            raise ContractError("failed verification contradicts exact evidence")
