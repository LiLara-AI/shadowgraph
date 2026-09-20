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

# What every gate must be, written out rather than read back from the
# dictionary under test.
#
# Two defects live here and only both assertions together close them. The
# first version sampled six fixed names, so six gates could be declared and
# never applied. Replacing the sample with `tuple(GATES)` fixed that and
# opened the other: the expectation then came from the same dictionary as
# the value, so inverting MEM0_TELEMETRY to `true` or TELEMETRY_DISABLED to
# `0` passed. These are literals, and the key set is asserted against GATES
# so a gate added there and forgotten here is a failure rather than a hole.
REQUIRED_GATES = {
    "MEM0_TELEMETRY": "false",
    "GRAPHITI_TELEMETRY_ENABLED": "false",
    "TELEMETRY_DISABLED": "1",
    "BASIC_MEMORY_FORCE_LOCAL": "true",
    "BASIC_MEMORY_MODE": "local",
    "COGNEE_TRACING_ENABLED": "false",
    "OTEL_SDK_DISABLED": "true",
    "BASIC_MEMORY_SEMANTIC_SEARCH_ENABLED": "false",
    "BASIC_MEMORY_RERANKER_ENABLED": "false",
    "LITELLM_LOCAL_MODEL_COST_MAP": "True",
    "HF_HUB_OFFLINE": "1",
    "HF_DATASETS_OFFLINE": "1",
    "TRANSFORMERS_OFFLINE": "1",
}
_SAMPLED_ENVIRONMENT = tuple(REQUIRED_GATES) + (
    "OPENAI_API_KEY",
    "OTEL_EXPORTER_OTLP_HEADERS",
)
_FENCED_ENTRY_POINTS = python_host.FENCED_ENTRY_POINTS

from test_support import models_for, python_config, python_models, request_for


class _FakeAdapterModule:
    observed_environment = None
    calls = 0

    @classmethod
    async def execute(cls, request, config, models):
        from envelope import build_envelope, not_available_storage

        cls.calls += 1
        cls.observed_environment = {
            name: os.environ.get(name) for name in _SAMPLED_ENVIRONMENT
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
            {"internal_memory_llm": "qwen2.5:7b", "embedding": "nomic-embed-text:v1.5"},
            {"internal_memory_llm": {"modelId": "qwen2.5:7b"}, "embedding": None},
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
        # Read out of the environment the adapter was actually given, against
        # literals rather than against the dictionary that produced it: a gate
        # declared and not applied fails here, and so does a gate whose value
        # was changed to the opposite of its intent.
        self.assertEqual(
            _FakeAdapterModule.observed_environment,
            {
                **REQUIRED_GATES,
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
        # Every entry point, read off the fence's own table rather than a list
        # kept here: one added there and forgotten here would be a guard nothing
        # checks is installed or removed.
        before = {name: python_host._entry_point(name) for name in _FENCED_ENTRY_POINTS}
        with self.assertRaises(RuntimeError):
            with python_host._loopback_only_network():
                for name in _FENCED_ENTRY_POINTS:
                    self.assertIsNot(python_host._entry_point(name), before[name], name)
                raise RuntimeError("adapter failed")
        self.assertEqual(
            {name: python_host._entry_point(name) for name in _FENCED_ENTRY_POINTS},
            before,
        )

    def test_a_datagram_needs_no_connection_and_is_fenced_anyway(self) -> None:
        # The hole this closes was real and demonstrated: with only the
        # connection-oriented entry points guarded, `sendto` put bytes on the
        # wire to any address while the fence reported itself installed.
        payload = b"shadowgraph-fence"
        peer = ("192.0.2.1", 9)
        with python_host._loopback_only_network():
            handle = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.addCleanup(handle.close)
            with self.assertRaises(python_host.NetworkFenceError):
                handle.sendto(payload, peer)
            with self.assertRaises(python_host.NetworkFenceError):
                handle.sendto(payload, 0, peer)
            if hasattr(handle, "sendmsg"):  # pragma: no branch - POSIX
                with self.assertRaises(python_host.NetworkFenceError):
                    handle.sendmsg([payload], [], 0, peer)
            # And loopback still works, or the fence would have cost the
            # benchmark the meter it exists to protect. Both directions, because
            # a guard that refuses everything passes a refusal-only test.
            self.assertEqual(handle.sendto(payload, ("127.0.0.1", 9)), len(payload))
            if hasattr(handle, "sendmsg"):  # pragma: no branch - POSIX
                self.assertEqual(
                    handle.sendmsg([payload], [], 0, ("127.0.0.1", 9)), len(payload)
                )

    def test_every_resolver_is_fenced_not_only_getaddrinfo(self) -> None:
        # gethostbyname does not route through getaddrinfo. Fencing that one
        # alone left the lookup - and the hostname - on the wire.
        with python_host._loopback_only_network():
            for resolve in (
                socket.getaddrinfo,
                socket.gethostbyname,
                socket.gethostbyname_ex,
            ):
                with self.subTest(resolve=resolve.__name__):
                    with self.assertRaises(python_host.NetworkFenceError):
                        resolve("huggingface.co")
            with self.assertRaises(python_host.NetworkFenceError):
                socket.gethostbyaddr("93.184.216.34")
            with self.assertRaises(python_host.NetworkFenceError):
                socket.getnameinfo(("93.184.216.34", 80), 0)
            # Loopback resolves, by name and by address.
            self.assertEqual(socket.gethostbyname("localhost"), "127.0.0.1")
            self.assertTrue(socket.getnameinfo(("127.0.0.1", 80), 0))

    def test_the_gates_are_exactly_the_ones_this_benchmark_requires(self) -> None:
        # The declaration itself, against the same literals the applied
        # environment is held to. A gate removed from GATES, added without a
        # decision, or edited to the opposite of its intent fails here.
        self.assertEqual(python_host.GATES, REQUIRED_GATES)

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



class RawSocketFenceTests(unittest.TestCase):
    """The C accelerator is a second spelling of the same calls.

    `socket` wraps `_socket`, and `socket.socket` subclasses `_socket.socket`.
    Guarding only the first left the second open, demonstrated in the pinned
    image: `_socket.socket(AF_INET, SOCK_DGRAM).sendto(payload, ("192.0.2.1", 9))`
    put eleven bytes on the wire while the identical call through `socket.socket`
    was refused.
    """

    def test_the_raw_socket_type_a_caller_reaches_for_is_guarded(self) -> None:
        import _socket

        with python_host._loopback_only_network():
            handle = _socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            self.addCleanup(handle.close)
            with self.assertRaises(python_host.NetworkFenceError):
                handle.sendto(b"shadowgraph-fence", ("192.0.2.1", 9))
            with self.assertRaises(python_host.NetworkFenceError):
                handle.connect(("192.0.2.1", 80))
            with self.assertRaises(python_host.NetworkFenceError):
                handle.connect_ex(("192.0.2.1", 80))
            if hasattr(handle, "sendmsg"):  # pragma: no branch - POSIX
                with self.assertRaises(python_host.NetworkFenceError):
                    handle.sendmsg([b"shadowgraph-fence"], [], 0, ("192.0.2.1", 9))
            # And loopback still works through the same type, on every one of
            # them. A guard tested only in the refusing direction is a guard that
            # can be made to refuse everything without anyone noticing - which is
            # the more expensive failure, because it stops a measured arm.
            self.assertEqual(handle.sendto(b"shadowgraph-fence", ("127.0.0.1", 9)), 17)
            self.assertEqual(handle.connect_ex(("127.0.0.1", 9)), 0)
            if hasattr(handle, "sendmsg"):  # pragma: no branch - POSIX
                self.assertEqual(
                    handle.sendmsg([b"shadowgraph-fence"], [], 0, ("127.0.0.1", 9)), 17
                )
            # `connect` to loopback is permitted - that is the assertion, and it is
            # where this stops. A `send` was asserted here too and had to come out:
            # on a connected datagram socket to an unlistened port the kernel queues
            # the ICMP port-unreachable from one datagram and delivers it to the
            # *next* call, so a repeated send alternates 17, ECONNREFUSED, 17,
            # ECONNREFUSED (reproduced on this host). By the time a `send` ran here
            # three datagrams had already gone to port 9, which makes it a race on
            # what is queued rather than a property. `send` carries no address, so
            # the fence does not guard it and it was never this test's subject.
            handle.connect(("127.0.0.1", 9))

    def test_every_raw_module_resolver_is_guarded(self) -> None:
        # Every `_socket.*` name in FENCED_ENTRY_POINTS, not a sample of it. A
        # sample is what let five of these be listed and exercised by nothing:
        # deleting them from the list is self-consistent, so the list's own
        # save/guard/restore agreement check cannot see it.
        import _socket

        with python_host._loopback_only_network():
            for resolve in (
                _socket.getaddrinfo,
                _socket.gethostbyname,
                _socket.gethostbyname_ex,
            ):
                with self.subTest(resolve=resolve.__name__):
                    with self.assertRaises(python_host.NetworkFenceError):
                        resolve("huggingface.co")
            with self.assertRaises(python_host.NetworkFenceError):
                _socket.gethostbyaddr("93.184.216.34")
            with self.assertRaises(python_host.NetworkFenceError):
                _socket.getnameinfo(("93.184.216.34", 80), 0)

            self.assertEqual(_socket.gethostbyname("localhost"), "127.0.0.1")
            self.assertEqual(_socket.gethostbyname_ex("localhost")[0], "localhost")
            self.assertTrue(_socket.getaddrinfo("127.0.0.1", 80))
            self.assertTrue(_socket.getnameinfo(("127.0.0.1", 80), 0))
            self.assertTrue(_socket.gethostbyaddr("127.0.0.1"))

    def test_the_raw_socket_type_is_restored_exactly(self) -> None:
        # A guarded subclass left bound after the adapter call would make every
        # later socket in this process a different type than the one the runtime
        # ships - including in the harness's own tests.
        import _socket

        before = _socket.socket
        with python_host._loopback_only_network():
            self.assertIsNot(_socket.socket, before)
        self.assertIs(_socket.socket, before)
        # And nothing was left behind on the pure-Python type either: these are
        # inherited, so writing one creates an attribute that outlives the fence.
        self.assertNotIn("connect", vars(socket.socket))
        self.assertNotIn("sendto", vars(socket.socket))

if __name__ == "__main__":
    unittest.main()
