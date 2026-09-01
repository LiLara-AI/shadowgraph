from __future__ import annotations

import copy
import unittest

from envelope import (
    ContractError,
    build_envelope,
    empty_operations,
    namespace_ref_for,
    not_available_storage,
    record_content_sha256,
    validate_request,
    validate_response,
)
from test_support import DECISION_CONTENT, DECISION_SHA256, MEM0_NAMESPACE_REF, request_for


class EnvelopeContractTests(unittest.TestCase):
    def test_hashes_match_committed_javascript_contract_literals(self) -> None:
        self.assertEqual(record_content_sha256(DECISION_CONTENT), DECISION_SHA256)
        self.assertEqual(
            namespace_ref_for(
                {
                    "runId": "run-1",
                    "armId": "mem0-oss",
                    "scenarioId": "scenario-1",
                    "repetition": 0,
                    "phase": "A",
                },
                {"projectId": "project-1", "userId": "user-1"},
            ),
            MEM0_NAMESPACE_REF,
        )

    def test_success_envelope_has_only_the_exact_shared_fields(self) -> None:
        request = request_for("retrieve")
        response = build_envelope(
            request,
            native_context=[{"id": "native-1", "type": "decision", "content": {"safe": True}}],
            operations={"memoryReadOperations": 1, "embeddingCalls": 1},
            storage=not_available_storage("Mem0 exact scope", "No exact attributable byte scope"),
        )
        validate_response(request, response)
        self.assertEqual(
            set(response),
            {
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
            },
        )
        serialized = str(response).lower()
        for forbidden in ("usage", "applicability", "retry", "outermodel", "score"):
            self.assertNotIn(forbidden, serialized)

    def test_all_seven_operation_counters_are_present_and_failed_calls_are_counted(self) -> None:
        request = request_for("retrieve")
        response = build_envelope(
            request,
            status="FAILED",
            failure={"cause": "OPERATION_FAILED", "message": "Native memory operation failed"},
            operations={"memoryReadOperations": 1, "embeddingCalls": 1},
            storage=not_available_storage("Mem0 exact scope", "No exact attributable byte scope"),
        )
        self.assertEqual(
            response["operations"],
            {
                "memoryReadOperations": 1,
                "memoryWriteOperations": 0,
                "mcpToolCalls": 0,
                "outerDecisionModelCalls": 0,
                "internalMemoryModelCalls": 0,
                "embeddingCalls": 1,
                "persistenceVerificationOperations": 0,
            },
        )
        validate_response(request, response)

    def test_request_validation_rejects_unknown_outer_authority_and_bad_namespace_hash(self) -> None:
        for mutation in (
            lambda value: value.update({"outerModel": {"endpoint": "https://example.invalid"}}),
            lambda value: value.__setitem__("namespaceRef", "0" * 64),
        ):
            request = request_for("retrieve")
            mutation(request)
            with self.assertRaises(ContractError):
                validate_request(request)

    def test_response_validation_rejects_unknown_claims_correlation_and_outer_calls(self) -> None:
        request = request_for("retrieve")
        base = build_envelope(
            request,
            storage=not_available_storage("Mem0 exact scope", "No exact attributable byte scope"),
        )
        mutations = []
        extra = copy.deepcopy(base)
        extra["usage"] = {"total_tokens": 1}
        mutations.append(extra)
        wrong = copy.deepcopy(base)
        wrong["attemptId"] = "different-attempt"
        mutations.append(wrong)
        outer = copy.deepcopy(base)
        outer["operations"]["outerDecisionModelCalls"] = 1
        mutations.append(outer)
        generic = copy.deepcopy(base)
        generic["operations"]["toolCalls"] = 1
        mutations.append(generic)
        for response in mutations:
            with self.subTest(response=response):
                with self.assertRaises(ContractError):
                    validate_response(request, response)

    def test_not_available_storage_keeps_bytes_and_method_null(self) -> None:
        storage = not_available_storage("Neo4j exact group scope", "No attributable database byte scope")
        self.assertEqual(
            storage,
            {
                "status": "NOT_AVAILABLE",
                "bytes": None,
                "scope": "Neo4j exact group scope",
                "method": None,
                "reason": "No attributable database byte scope",
                "blockedClaims": ["storage bytes"],
            },
        )

    def test_empty_operations_rejects_unknown_or_negative_overrides(self) -> None:
        with self.assertRaises(ContractError):
            empty_operations(toolCalls=1)
        with self.assertRaises(ContractError):
            empty_operations(memoryReadOperations=-1)

    def test_builder_does_not_coerce_explicit_invalid_values_to_defaults(self) -> None:
        request = request_for("retrieve")
        for kwargs in (
            {"native_context": False},
            {"operations": []},
            {"storage": {}},
        ):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(ContractError):
                    build_envelope(request, **kwargs)


if __name__ == "__main__":
    unittest.main()
