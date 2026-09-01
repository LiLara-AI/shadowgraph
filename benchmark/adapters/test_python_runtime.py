from __future__ import annotations

import unittest
from uuid import UUID

from envelope import ContractError
from python_runtime import (
    ENCODING_PREFIX,
    classify_native_error,
    decode_content,
    deterministic_dataset_uuid,
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

    def test_cognee_dataset_uuid_uses_a_distinct_typed_deterministic_domain(self) -> None:
        dataset_id = deterministic_dataset_uuid("cognee", "project-1")
        self.assertIsInstance(dataset_id, UUID)
        self.assertEqual(str(dataset_id), "f68d9708-304c-57b8-80a7-09ef1e12a274")
        self.assertNotEqual(
            str(dataset_id),
            deterministic_native_uuid("cognee", "project-1"),
        )

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
