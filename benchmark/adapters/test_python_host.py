from __future__ import annotations

import copy
import io
import json
import os
import socket
import tempfile
import unittest
from unittest.mock import patch

import python_host

from test_support import models_for, python_config, python_models, request_for


class _FakeAdapterModule:
    observed_environment = None
    calls = 0

    @classmethod
    async def execute(cls, request, config, models):
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


class _RecordingAdapterModule:
    observed_models = None

    @classmethod
    async def execute(cls, request, config, models):
        from envelope import build_envelope, not_available_storage

        cls.observed_models = copy.deepcopy(models)
        return build_envelope(
            request,
            storage=not_available_storage("Fake native scope", "No exact byte scope"),
        )


class PythonHostTests(unittest.TestCase):
    def setUp(self) -> None:
        _FakeAdapterModule.calls = 0
        _FakeAdapterModule.observed_environment = None
        _RecordingAdapterModule.observed_models = None

    def wrapper(self, adapter_id="mem0-oss", request=None, routes=None, models=None):
        resolved_routes = python_config() if routes is None else routes
        return {
            "schemaVersion": 2,
            "adapterId": adapter_id,
            "request": request or request_for("retrieve"),
            "providerRoutes": resolved_routes,
            "providerModels": models_for(resolved_routes) if models is None else models,
        }

    def test_a_metered_route_without_its_pinned_model_never_reaches_an_adapter(self) -> None:
        # The failure this refuses is silent by construction: mem0 defaults to
        # gpt-5-mini and text-embedding-3-small at 1536 dimensions, so an arm
        # handed routes and no models does not error, it measures other weights
        # against a collection of the wrong width.
        for models in (
            python_models(llm=None),
            python_models(embedding=None),
            python_models(dimension=None),
            python_models(llm="qwen 2.5"),
            {"internal_memory_llm": None, "embedding": None},
            {"internal_memory_llm": "qwen2.5:0.5b", "embedding": "nomic-embed-text:v1.5"},
            {"internal_memory_llm": {"modelId": "qwen2.5:0.5b"}, "embedding": None},
        ):
            record = self.wrapper(models=models)
            with patch.object(python_host.importlib, "import_module") as importer:
                self.assertNotEqual(
                    python_host.process_stream(
                        io.StringIO(json.dumps(record) + "\n"), io.StringIO()
                    ),
                    0,
                    repr(models),
                )
            importer.assert_not_called()

    def test_an_unmetered_arm_that_is_handed_a_model_is_refused(self) -> None:
        basic_request = request_for(
            "retrieve",
            arm_id="basic-memory",
            project_id="project-1",
            user_id=None,
            namespace_ref="df8bfcf3fb8f56f2e8144f81e6db609ffa86190e3534f99393e85d687016ac6e",
        )
        record = self.wrapper(
            adapter_id="basic-memory",
            request=basic_request,
            routes={"internal_memory_llm": None, "embedding": None},
            models=python_models(),
        )
        with patch.object(python_host.importlib, "import_module") as importer:
            self.assertNotEqual(
                python_host.process_stream(io.StringIO(json.dumps(record) + "\n"), io.StringIO()),
                0,
            )
        importer.assert_not_called()

    def test_the_previous_wrapper_version_is_refused_rather_than_defaulted(self) -> None:
        record = self.wrapper()
        del record["providerModels"]
        record["schemaVersion"] = 1
        with patch.object(python_host.importlib, "import_module") as importer:
            self.assertNotEqual(
                python_host.process_stream(io.StringIO(json.dumps(record) + "\n"), io.StringIO()),
                0,
            )
        importer.assert_not_called()

    def test_the_pinned_models_reach_the_adapter_unaltered(self) -> None:
        with patch.object(
            python_host.importlib, "import_module", return_value=_RecordingAdapterModule
        ):
            code = python_host.process_stream(
                io.StringIO(json.dumps(self.wrapper()) + "\n"), io.StringIO()
            )
        self.assertEqual(code, 0)
        self.assertEqual(_RecordingAdapterModule.observed_models, python_models())

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


class NetworkFenceTests(unittest.TestCase):
    """The fence that keeps a measured unit from reaching an unpinned model.

    Every arm in this runtime has a path to model weights the benchmark does not
    pin and the provider meter cannot see. Basic Memory enables semantic search
    whenever fastembed is importable - which it is, because Basic Memory itself
    requires it and all four arms share one runtime - and then downloads
    bge-small-en-v1.5 to embed every note locally. Mem0's Qdrant store always
    creates a bm25 sparse slot and pulls Qdrant/bm25 on the write path, swallowing
    failure into a warning. LiteLLM fetches its model-cost map at import. Cognee
    resolves an embedding tokenizer from HuggingFace and, when that fails, from
    tiktoken's CDN.

    The environment gates close the paths that are known. This closes the rest,
    by construction: loopback is the whole of what a measured unit needs, because
    the container shares the host network namespace precisely so the provider
    meter and the pinned services answer on 127.0.0.1.
    """

    def test_a_connection_outside_loopback_is_refused(self) -> None:
        # NetworkFenceError specifically, not OSError. A weaker assertion passes
        # on a connection that was attempted and merely failed - a timeout, a
        # refused port, an unresolvable name - so a fence that had stopped
        # fencing would still look green on any machine without a route out.
        # Asserting the fence's own error means only the fence can satisfy it.
        for address in (
            ("huggingface.co", 443),
            ("140.82.121.4", 443),
            ("0.0.0.0", 80),
            ("::", 80),
            ("2606:4700:4700::1111", 443),
            (b"huggingface.co", 443),
            ("", 443),
            "not-a-tuple",
            None,
        ):
            with self.subTest(address=address):
                with python_host._loopback_only_network():
                    handle = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    handle.settimeout(0.25)
                    self.addCleanup(handle.close)
                    with self.assertRaises(python_host.NetworkFenceError):
                        handle.connect(address)
                    with self.assertRaises(python_host.NetworkFenceError):
                        handle.connect_ex(address)
                    with self.assertRaises(python_host.NetworkFenceError):
                        socket.create_connection(address, timeout=0.25)

    def test_loopback_still_reaches_the_meter_and_the_pinned_services(self) -> None:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.addCleanup(listener.close)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]

        with python_host._loopback_only_network():
            for host in ("127.0.0.1", "localhost"):
                with self.subTest(host=host):
                    client = socket.create_connection((host, port), timeout=2)
                    client.close()
                    accepted, _ = listener.accept()
                    accepted.close()

            # The whole 127/8 block and ::1 are loopback, not just the one
            # address a service happens to bind. Nothing listens here, so the
            # refusal must come from the kernel rather than from the fence.
            for host in ("127.0.0.53", "127.9.9.9", "::1"):
                with self.subTest(host=host):
                    with self.assertRaises(OSError) as caught:
                        socket.create_connection((host, port), timeout=2)
                    self.assertNotIsInstance(
                        caught.exception, python_host.NetworkFenceError, host
                    )

    def test_name_resolution_is_fenced_so_a_hostname_never_reaches_a_resolver(self) -> None:
        # Refusing the connection but allowing the lookup would still put the
        # hostname on the wire.
        with python_host._loopback_only_network():
            with self.assertRaises(python_host.NetworkFenceError):
                socket.getaddrinfo("huggingface.co", 443)
            self.assertTrue(socket.getaddrinfo("127.0.0.1", 80))
            self.assertTrue(socket.getaddrinfo("localhost", 80))

    def test_a_unix_socket_is_not_a_network_call(self) -> None:
        # AF_UNIX never leaves the machine, and SQLite, LanceDB and Kuzu are all
        # file-backed: fencing it would break local storage for no gain.
        if not hasattr(socket, "AF_UNIX"):  # pragma: no cover - POSIX only
            self.skipTest("AF_UNIX is unavailable on this platform")
        with tempfile.TemporaryDirectory() as directory:
            absent = os.path.join(directory, "shadowgraph-no-such-socket")
            with python_host._loopback_only_network():
                handle = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                self.addCleanup(handle.close)
                with self.assertRaises(OSError) as caught:
                    handle.connect(absent)
        self.assertNotIsInstance(caught.exception, python_host.NetworkFenceError)

    def test_the_fence_is_lifted_even_when_the_adapter_raises(self) -> None:
        before = (
            socket.socket.connect,
            socket.socket.connect_ex,
            socket.create_connection,
            socket.getaddrinfo,
        )
        with self.assertRaises(RuntimeError):
            with python_host._loopback_only_network():
                self.assertIsNot(socket.getaddrinfo, before[3])
                raise RuntimeError("adapter failed")
        self.assertEqual(
            (
                socket.socket.connect,
                socket.socket.connect_ex,
                socket.create_connection,
                socket.getaddrinfo,
            ),
            before,
        )

    def test_the_gates_close_every_unpinned_model_path_that_has_an_environment_switch(self) -> None:
        self.assertEqual(python_host.GATES["BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED"], "false")
        self.assertEqual(python_host.GATES["BASIC_MEMORY_RERANKER_ENABLED"], "false")
        self.assertEqual(python_host.GATES["LITELLM_LOCAL_MODEL_COST_MAP"], "True")
        self.assertEqual(python_host.GATES["HF_HUB_OFFLINE"], "1")
        self.assertEqual(python_host.GATES["HF_DATASETS_OFFLINE"], "1")
        self.assertEqual(python_host.GATES["TRANSFORMERS_OFFLINE"], "1")

    def test_the_fence_is_actually_applied_around_the_adapter_call(self) -> None:
        # The obvious version of this test - let the adapter reach out, assert a
        # FAILED envelope - proves nothing, and a mutation showed it: with the
        # fence removed the connection succeeds and the adapter raises anyway, or
        # fails some other way, and the host turns every one of those into the
        # same INFRASTRUCTURE_FAILURE. Identical green either way.
        #
        # So the adapter records the exception *type* it saw and returns a
        # successful envelope. NetworkFenceError can only come from the fence:
        # an unfenced call gets a real connection, a gaierror or a timeout, none
        # of which satisfy this.
        class _ReachingAdapterModule:
            observed = None

            @classmethod
            async def execute(cls, request, config, models):
                from envelope import build_envelope, not_available_storage

                try:
                    socket.create_connection(("huggingface.co", 443), timeout=0.25).close()
                    cls.observed = "connected"
                except BaseException as error:  # noqa: BLE001 - the type is the observation
                    cls.observed = type(error).__name__
                return build_envelope(
                    request,
                    storage=not_available_storage("Fake native scope", "No exact byte scope"),
                )

        record = {
            "schemaVersion": 2,
            "adapterId": "mem0-oss",
            "request": request_for("retrieve"),
            "providerRoutes": python_config(),
            "providerModels": python_models(),
        }
        output = io.StringIO()
        with patch.object(
            python_host.importlib, "import_module", return_value=_ReachingAdapterModule
        ):
            code = python_host.process_stream(io.StringIO(json.dumps(record) + "\n"), output)
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(output.getvalue())["status"], "SUCCEEDED")
        self.assertEqual(_ReachingAdapterModule.observed, "NetworkFenceError")

    def test_a_name_lookup_inside_the_adapter_call_is_fenced_too(self) -> None:
        class _ResolvingAdapterModule:
            observed = None

            @classmethod
            async def execute(cls, request, config, models):
                from envelope import build_envelope, not_available_storage

                try:
                    socket.getaddrinfo("huggingface.co", 443)
                    cls.observed = "resolved"
                except BaseException as error:  # noqa: BLE001
                    cls.observed = type(error).__name__
                return build_envelope(
                    request,
                    storage=not_available_storage("Fake native scope", "No exact byte scope"),
                )

        record = {
            "schemaVersion": 2,
            "adapterId": "mem0-oss",
            "request": request_for("retrieve"),
            "providerRoutes": python_config(),
            "providerModels": python_models(),
        }
        with patch.object(
            python_host.importlib, "import_module", return_value=_ResolvingAdapterModule
        ):
            python_host.process_stream(io.StringIO(json.dumps(record) + "\n"), io.StringIO())
        self.assertEqual(_ResolvingAdapterModule.observed, "NetworkFenceError")


if __name__ == "__main__":
    unittest.main()
