from __future__ import annotations

import unittest
from uuid import UUID

import python_runtime
from envelope import ContractError
from python_runtime import (
    ENCODING_PREFIX,
    classify_native_error,
    decode_content,
    deterministic_native_uuid,
    encode_content,
    require_routes,
)
from test_support import DECISION_CONTENT


class PythonRuntimeTests(unittest.TestCase):
    def test_owned_serialization_is_canonical_readable_and_integrity_checked(self) -> None:
        encoded = encode_content(DECISION_CONTENT)

        self.assertEqual(ENCODING_PREFIX, "shadowgraph-benchmark-record:v2:")
        self.assertTrue(encoded.startswith(ENCODING_PREFIX + "{"))
        self.assertIn("Use the reversible option.", encoded)
        self.assertIn("reason-a", encoded)
        self.assertEqual(decode_content(encoded), DECISION_CONTENT)

        raw = encoded[len(ENCODING_PREFIX) :]
        noncanonical = ENCODING_PREFIX + raw.replace("\":", "\": ", 1)
        tampered = encoded.replace("reversible", "irreversible", 1)
        for invalid in (noncanonical, tampered, raw):
            with self.subTest(invalid=invalid[:80]):
                with self.assertRaises(ContractError):
                    decode_content(invalid)

    def test_failed_attempt_semantics_remain_search_readable(self) -> None:
        content = {
            "id": "attempt-a",
            "approachId": "approach-a",
            "reasonId": "reason-timeout",
            "reason": "The reversible network probe timed out.",
        }
        encoded = encode_content(content)
        self.assertIn("reversible network probe timed out", encoded)
        self.assertEqual(decode_content(encoded), content)

    def test_no_helper_computes_a_dataset_id_this_runtime_does_not_own(self) -> None:
        """Record ids are ours to assign; dataset ids are Cognee's.

        `deterministic_dataset_uuid` computed a uuid5 of the arm and the project
        and the Cognee adapter held the store to it. Cognee derives its own from
        the dataset name, the owning user and the tenant, and reads a supplied
        id as a reference to an existing dataset the caller may write to -
        against the real library the computed id raised PermissionDeniedError
        and created nothing. The adapter now resolves by name and adopts the id
        it finds, and the helper is gone rather than left for someone to reach
        for.

        A record id is a different case and stays: nothing else assigns it, and
        the adapter needs it to be the same across processes.
        """
        self.assertFalse(hasattr(python_runtime, "deterministic_dataset_uuid"))
        self.assertFalse(hasattr(python_runtime, "COGNEE_DATASET_UUID_NAMESPACE"))
        self.assertTrue(callable(python_runtime.deterministic_native_uuid))

    def test_native_failure_classification_preserves_actual_public_cause_without_detail(self) -> None:
        cases = [
            (TimeoutError("secret-timeout"), ("TIMEOUT", "Native adapter operation timed out")),
            (
                ConnectionRefusedError("secret-endpoint"),
                ("ENDPOINT_UNAVAILABLE", "Native adapter endpoint is unavailable"),
            ),
            (RuntimeError("secret-operation"), ("OPERATION_FAILED", "Native adapter operation failed")),
        ]
        for error, expected in cases:
            with self.subTest(error=type(error).__name__):
                self.assertEqual(classify_native_error(error), expected)
                self.assertNotIn("secret", " ".join(classify_native_error(error)))

    def test_provider_routes_require_literal_loopback_opaque_endpoints(self) -> None:
        require_routes(
            {
                "internal_memory_llm": "http://127.0.0.1:43123/opaque-llm",
                "embedding": "http://[::1]:43124/opaque-embedding",
            },
            required=True,
        )
        for endpoint in (
            "https://127.0.0.1:43123/opaque",
            "http://localhost:43123/opaque",
            "http://example.invalid/opaque",
            "".join(("http://", "user@", "127.0.0.1:43123/opaque")),
            "http://127.0.0.1:43123/",
            "http://127.0.0.1:43123/opaque?key=fake",
            "http://127.0.0.1:43123/opaque#fragment",
        ):
            with self.subTest(endpoint=endpoint):
                with self.assertRaises(ContractError):
                    require_routes(
                        {
                            "internal_memory_llm": endpoint,
                            "embedding": "http://127.0.0.1:43124/opaque",
                        },
                        required=True,
                    )
        with self.assertRaises(ContractError):
            require_routes(
                {
                    "internal_memory_llm": "http://127.0.0.1:43123/same",
                    "embedding": "http://127.0.0.1:43123/same",
                },
                required=True,
            )


if __name__ == "__main__":
    unittest.main()
