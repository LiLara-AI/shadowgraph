from __future__ import annotations

import copy
import io
import json
import os
import unittest
from unittest.mock import patch

import python_host

from test_support import python_config, request_for


class _FakeAdapterModule:
    observed_environment = None
    calls = 0

    @classmethod
    async def execute(cls, request, config):
        from envelope import build_envelope, not_available_storage

        cls.calls += 1
        cls.observed_environment = {
            name: os.environ.get(name)
            for name in (
                "MEM0_TELEMETRY",
                "GRAPHITI_TELEMETRY_ENABLED",
                "TELEMETRY_DISABLED",
                "BASIC_MEMORY_MODE",
                "OPENAI_API_KEY",
                "OTEL_EXPORTER_OTLP_HEADERS",
            )
        }
        return build_envelope(
            request,
            storage=not_available_storage("Fake native scope", "No exact byte scope"),
        )


class PythonHostTests(unittest.TestCase):
    def setUp(self) -> None:
        _FakeAdapterModule.calls = 0
        _FakeAdapterModule.observed_environment = None

    def wrapper(self, adapter_id="mem0-oss", request=None, routes=None):
        return {
            "schemaVersion": 1,
            "adapterId": adapter_id,
            "request": request or request_for("retrieve"),
            "providerRoutes": routes or python_config(),
        }

    def test_dispatches_one_allowlisted_adapter_after_telemetry_is_disabled(self) -> None:
        output = io.StringIO()
        with patch.dict(
            os.environ,
            {
                "OPENAI_API_KEY": "fake",
                "OTEL_EXPORTER_OTLP_HEADERS": "authorization=fake",
            },
            clear=False,
        ), patch.object(python_host.importlib, "import_module", return_value=_FakeAdapterModule):
            code = python_host.process_stream(
                io.StringIO(json.dumps(self.wrapper()) + "\n"),
                output,
            )
        self.assertEqual(code, 0)
        self.assertEqual(_FakeAdapterModule.calls, 1)
        self.assertEqual(
            _FakeAdapterModule.observed_environment,
            {
                "MEM0_TELEMETRY": "false",
                "GRAPHITI_TELEMETRY_ENABLED": "false",
                "TELEMETRY_DISABLED": "1",
                "BASIC_MEMORY_MODE": "local",
                "OPENAI_API_KEY": None,
                "OTEL_EXPORTER_OTLP_HEADERS": None,
            },
        )
        self.assertEqual(output.getvalue().count("\n"), 1)
        response = json.loads(output.getvalue())
        self.assertEqual(response["attemptId"], "attempt-retrieve")

    def test_rejects_unknown_adapter_or_route_shape_before_import(self) -> None:
        cases = [
            self.wrapper(adapter_id="unknown"),
            self.wrapper(
                adapter_id="mem0",
                request=request_for(
                    "retrieve",
                    arm_id="mem0",
                    namespace_ref="0b356d5be525189d430e9f07061153bc2da9545ddad22f960934a940b99d13ba",
                ),
            ),
            self.wrapper(routes={"internal_memory_llm": "https://cloud.invalid", "embedding": None}),
            self.wrapper(
                routes={
                    "internal_memory_llm": "http://127.0.0.1:41001/same",
                    "embedding": "http://127.0.0.1:41001/same",
                }
            ),
            {**self.wrapper(), "extra": True},
        ]
        for wrapper in cases:
            with self.subTest(wrapper=wrapper):
                with patch.object(python_host.importlib, "import_module") as importer:
                    output = io.StringIO()
                    code = python_host.process_stream(io.StringIO(json.dumps(wrapper) + "\n"), output)
                self.assertNotEqual(code, 0)
                importer.assert_not_called()
                self.assertEqual(output.getvalue(), "")

    def test_rejects_multiple_trailing_or_oversized_input_records(self) -> None:
        valid = json.dumps(self.wrapper())
        for raw in (f"{valid}\n{valid}\n", f"{valid}\ntrailing", "x" * (1_048_576 + 1)):
            with self.subTest(length=len(raw)):
                output = io.StringIO()
                self.assertNotEqual(python_host.process_stream(io.StringIO(raw), output), 0)
                self.assertEqual(output.getvalue(), "")

    def test_valid_correlation_turns_adapter_failure_into_sanitized_failure_envelope(self) -> None:
        class BrokenAdapter:
            @staticmethod
            async def execute(_request, _config):
                raise RuntimeError("secret-token /private/path")

        output = io.StringIO()
        with patch.object(python_host.importlib, "import_module", return_value=BrokenAdapter):
            code = python_host.process_stream(
                io.StringIO(json.dumps(self.wrapper()) + "\n"), output
            )
        self.assertEqual(code, 0)
        response = json.loads(output.getvalue())
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "INFRASTRUCTURE_FAILURE")
        self.assertNotIn("secret-token", output.getvalue())
        self.assertNotIn("private/path", output.getvalue())

    def test_basic_memory_requires_no_provider_routes_and_model_arms_require_both(self) -> None:
        basic_request = request_for(
            "retrieve",
            arm_id="basic-memory",
            project_id="project-1",
            user_id=None,
            namespace_ref="df8bfcf3fb8f56f2e8144f81e6db609ffa86190e3534f99393e85d687016ac6e",
        )
        basic = self.wrapper(
            adapter_id="basic-memory",
            request=basic_request,
            routes={"internal_memory_llm": None, "embedding": None},
        )
        with patch.object(python_host.importlib, "import_module", return_value=_FakeAdapterModule):
            self.assertEqual(
                python_host.process_stream(io.StringIO(json.dumps(basic) + "\n"), io.StringIO()),
                0,
            )
        missing = self.wrapper(routes={"internal_memory_llm": None, "embedding": None})
        with patch.object(python_host.importlib, "import_module") as importer:
            self.assertNotEqual(
                python_host.process_stream(io.StringIO(json.dumps(missing) + "\n"), io.StringIO()),
                0,
            )
        importer.assert_not_called()


if __name__ == "__main__":
    unittest.main()
