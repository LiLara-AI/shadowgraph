"""Shared literal fixtures and fake-native helpers for benchmark adapter tests."""

from __future__ import annotations

import copy


DECISION_CONTENT = {
    "decisionId": "decision-a",
    "choiceId": "choice-a",
    "recalledAlternativeIds": ["alternative-a"],
    "recalledRejectionReasonIds": ["reason-a"],
    "constraintIdsAddressed": ["constraint-a"],
    "evidenceIdsCited": ["evidence-a"],
    "riskIdsRecognized": ["risk-a"],
    "reviewTriggerIds": ["trigger-a"],
    "changedFactDetected": False,
    "changedFactId": None,
    "recommendation": "Use the reversible option.",
    "failedAttemptIdsAvoided": [],
    "failedAttemptReasonIdsCited": [],
    "memoryProjectId": "project-1",
    "memoryUserId": "user-1",
}

DECISION_SHA256 = "ddec3f40f4bea882331edbe4136277f5776fc695b31e84e04647a29b357f7665"
MEM0_NAMESPACE_REF = "3de23f4d9b785c784a30a772fc5a7587ca3b274957d8aaf46f47d360366f311d"


def request_for(
    operation: str,
    *,
    arm_id: str = "mem0-oss",
    project_id: str = "project-1",
    user_id: str | None = "user-1",
    phase: str = "A",
    namespace_ref: str = MEM0_NAMESPACE_REF,
    alternate_namespace: dict | None = None,
    alternate_namespace_ref: str | None = None,
) -> dict:
    record_id = f"decision:{len(arm_id)}:{arm_id}:10:scenario-1:1:0:{len(phase)}:{phase}"
    request = {
        "schemaVersion": 1,
        "operation": operation,
        "runId": "run-1",
        "attemptId": f"attempt-{operation}",
        "phase": phase,
        "armId": arm_id,
        "scenarioId": "scenario-1",
        "repetition": 0,
        "namespace": {"projectId": project_id, "userId": user_id},
        "namespaceRef": namespace_ref,
        "payload": {},
    }
    if operation == "retrieve":
        request["payload"] = {
            "query": {"scenarioId": "scenario-1", "task": "Choose the safe option."}
        }
    elif operation == "persist":
        request["payload"] = {
            "record": {
                "id": record_id,
                "type": "decision",
                "content": copy.deepcopy(DECISION_CONTENT),
            }
        }
    elif operation == "verify":
        request["payload"] = {
            "expectedRecord": {
                "id": record_id,
                "type": "decision",
                "contentSha256": DECISION_SHA256,
            },
            "alternateNamespace": copy.deepcopy(alternate_namespace),
            "alternateNamespaceRef": alternate_namespace_ref,
            "expectedAbsentRecord": (
                {
                    "id": record_id,
                    "type": "decision",
                    "contentSha256": DECISION_SHA256,
                }
                if alternate_namespace is not None
                else None
            ),
        }
    return request


def python_config(*, llm: str | None = "http://127.0.0.1:43100/llm-a", embedding: str | None = "http://127.0.0.1:43100/embed-a") -> dict:
    return {
        "internal_memory_llm": llm,
        "embedding": embedding,
    }


class ProviderCounter:
    def __init__(self) -> None:
        self.calls = []

    def __call__(self, request_class: str) -> None:
        self.calls.append(request_class)
