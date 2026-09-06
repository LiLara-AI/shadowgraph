from __future__ import annotations

import asyncio
import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import mem0_adapter

from python_runtime import ContractError, RuntimeUnavailable, encode_content
from test_support import DECISION_CONTENT, DECISION_SHA256, models_for, python_config, python_models, request_for


class FakeMem0:
    def __init__(self, backend, provider_call, *, fail_on=None):
        self.backend = backend
        self.provider_call = provider_call
        self.fail_on = fail_on
        self.calls = []

    def _scope(self, filters):
        return (filters["agent_id"], filters["user_id"])

    def delete_all(self, *, user_id=None, agent_id=None, run_id=None):
        self.calls.append(("delete_all", user_id, agent_id, run_id))
        self.backend[(agent_id, user_id)] = []
        if self.fail_on == "delete_all":
            raise RuntimeError("native reset failed")
        return {"message": "deleted"}

    def search(self, query, *, filters):
        self.calls.append(("search", query, copy.deepcopy(filters)))
        self.provider_call("embedding")
        if self.fail_on == "search":
            raise RuntimeError("native search failed secret-value")
        return {"results": copy.deepcopy(self.backend.get(self._scope(filters), []))}

    def add(self, messages, *, user_id=None, agent_id=None, run_id=None, metadata=None, infer=True):
        self.calls.append(
            ("add", copy.deepcopy(messages), user_id, agent_id, run_id, copy.deepcopy(metadata), infer)
        )
        if infer:
            self.provider_call("internal_memory_llm")
        self.provider_call("embedding")
        if self.fail_on == "add":
            raise RuntimeError("native add failed")
        self.backend.setdefault((agent_id, user_id), []).append(
            {
                "id": f"native-{len(self.backend.get((agent_id, user_id), [])) + 1}",
                "memory": messages[-1]["content"],
                "metadata": copy.deepcopy(metadata),
            }
        )
        return {"results": [{"id": self.backend[(agent_id, user_id)][-1]["id"]}]}

    def get_all(self, *, filters, top_k=20):
        self.calls.append(("get_all", copy.deepcopy(filters), top_k))
        if self.fail_on == "get_all":
            raise RuntimeError("native list failed")
        return {"results": copy.deepcopy(self.backend.get(self._scope(filters), []))}


class Mem0AdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = {}
        self.clients = []
        self.fail_on = None
        self.runtime_configs = []
        # Mem0 now keeps a real local store, so the adapter demands the owned
        # root the executor prepares per unit before it will build a client.
        self.state_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.state_directory.cleanup)
        self.state_root = str(Path(self.state_directory.name).resolve())
        self.environment = patch.dict(
            os.environ,
            {"SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT": self.state_root},
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_a_unit_without_an_owned_state_root_never_reaches_the_library(self) -> None:
        # The store is on disk now. An arm that persisted outside the leaf the
        # executor prepared would be measured on state the harness did not
        # create and cannot reset between units.
        self.environment.stop()
        self.addCleanup(self.environment.start)
        with patch.dict(os.environ, {}, clear=True):
            response = asyncio.run(
                mem0_adapter.execute(
                    request_for("retrieve"),
                    python_config(),
                    models_for(python_config()),
                    client_factory=self.factory,
                    version_getter=lambda _name: "2.0.19",
                )
            )
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(self.clients, [])

    def factory(self, config, provider_call):
        self.runtime_configs.append(copy.deepcopy(config))
        client = FakeMem0(self.backend, provider_call, fail_on=self.fail_on)
        self.clients.append(client)
        return client

    def execute(self, operation, **request_overrides):
        return asyncio.run(
            mem0_adapter.execute(
                request_for(operation, **request_overrides),
                python_config(),
                models_for(python_config()),
                client_factory=self.factory,
                version_getter=lambda name: "2.0.19" if name == "mem0ai" else None,
            )
        )

    def test_reset_uses_exact_project_user_scope_and_never_global_reset(self) -> None:
        self.backend[("project-1", "user-1")] = [{"id": "old"}]
        response = self.execute("reset")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(self.backend[("project-1", "user-1")], [])
        self.assertEqual(self.clients[0].calls, [("delete_all", "user-1", "project-1", None)])
        self.assertEqual(response["operations"]["memoryWriteOperations"], 1)

    def test_retrieve_uses_native_filters_and_one_metered_embedding_call(self) -> None:
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual(response["operations"]["embeddingCalls"], 1)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(self.clients[0].calls[0][0], "search")
        self.assertEqual(
            self.clients[0].calls[0][2],
            {"agent_id": "project-1", "user_id": "user-1"},
        )

    def test_persist_stores_only_the_standard_record_with_deterministic_logical_id(self) -> None:
        response = self.execute("persist")
        self.assertEqual(response["status"], "SUCCEEDED")
        stored = self.backend[("project-1", "user-1")][0]
        self.assertEqual(
            stored["metadata"],
            {
                "shadowgraph_record_id": "decision:8:mem0-oss:10:scenario-1:1:0:1:A",
                "shadowgraph_record_type": "decision",
                "shadowgraph_content_sha256": DECISION_SHA256,
            },
        )
        self.assertEqual(stored["memory"], encode_content(DECISION_CONTENT))
        self.assertIs(self.clients[0].calls[0][6], False)
        self.assertEqual(response["operations"]["memoryWriteOperations"], 1)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["embeddingCalls"], 1)

    def test_verify_uses_a_fresh_client_and_exact_id_content_hash_and_both_native_scopes(self) -> None:
        self.execute("persist")
        response = self.execute(
            "verify",
            alternate_namespace={"projectId": "project-alt", "userId": "user-alt"},
            alternate_namespace_ref="03f6e6fa2af8f3c13413716f3e69753171c31da7c9d9d18028d073918ed76559",
        )
        self.assertEqual(len(self.clients), 2)
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(response["result"]["persistenceEvidence"]["observedContentSha256"], DECISION_SHA256)
        self.assertTrue(response["result"]["isolationEvidence"]["verified"])
        self.assertEqual(response["operations"]["persistenceVerificationOperations"], 2)
        self.assertEqual([call[0] for call in self.clients[1].calls], ["get_all", "get_all"])

    def test_failed_provider_operation_is_counted_once_and_never_retried_or_leaked(self) -> None:
        self.fail_on = "search"
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual(response["operations"]["embeddingCalls"], 1)
        self.assertEqual(len(self.clients[0].calls), 1)
        self.assertNotIn("secret-value", str(response))

    def test_success_requires_provider_traffic_but_preserves_multiple_legitimate_calls(self) -> None:
        class BadMeterMem0(FakeMem0):
            def __init__(self, backend, provider_call, count):
                super().__init__(backend, provider_call)
                self.count = count

            def search(self, query, *, filters):
                self.calls.append(("search", query, copy.deepcopy(filters)))
                for _index in range(self.count):
                    self.provider_call("embedding")
                return {"results": []}

        for count, expected_status in ((0, "FAILED"), (2, "SUCCEEDED")):
            with self.subTest(provider_request_count=count, expected_status=expected_status):
                response = asyncio.run(
                    mem0_adapter.execute(
                        request_for("retrieve"),
                        python_config(),
                        models_for(python_config()),
                        client_factory=lambda _config, provider_call: BadMeterMem0(
                            self.backend, provider_call, count
                        ),
                        version_getter=lambda _name: "2.0.19",
                    )
                )
                self.assertEqual(response["status"], expected_status)
                self.assertEqual(response["operations"]["embeddingCalls"], count)
                if expected_status == "FAILED":
                    self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")

    def test_runtime_config_is_pinned_zero_retry_and_routes_are_per_execution(self) -> None:
        self.execute("retrieve")
        config = self.runtime_configs[0]
        self.assertEqual(config["package"], {"name": "mem0ai", "version": "2.0.19"})
        self.assertEqual(config["llm"]["config"]["openai_base_url"], "http://127.0.0.1:43100/llm-a")
        self.assertEqual(config["embedder"]["config"]["openai_base_url"], "http://127.0.0.1:43100/embed-a")
        # Unset, mem0 2.0.19 asks for gpt-5-mini and text-embedding-3-small and
        # sizes its vector collection to the latter's 1536 dimensions. The
        # pinned Ollama serves neither, and returns 768-wide vectors.
        self.assertEqual(config["llm"]["config"]["model"], "qwen2.5:7b")
        self.assertEqual(config["embedder"]["config"]["model"], "nomic-embed-text:v1.5")
        self.assertEqual(config["embedder"]["config"]["embedding_dims"], 768)
        self.assertNotIn("max_retries", config["llm"]["config"])
        self.assertNotIn("max_retries", config["embedder"]["config"])
        self.assertEqual(config["automatic_retries"], 0)
        self.assertEqual(config["retry_proof"], "task8_runtime_meter_required")
        # Mem0's own default store, in the mode that needs no service, under the
        # leaf the executor owns.
        self.assertEqual(config["vector_store"]["provider"], "qdrant")
        self.assertEqual(
            config["vector_store"]["config"]["path"], os.path.join(self.state_root, "qdrant")
        )
        self.assertEqual(config["vector_store"]["config"]["embedding_model_dims"], 768)
        self.assertEqual(config["history_db_path"], os.path.join(self.state_root, "history.db"))
        # And what the library is handed is derived from that declaration rather
        # than kept beside it, so the two cannot drift.
        library = mem0_adapter._memory_config(config)
        self.assertEqual(set(library), {"llm", "embedder", "vector_store", "history_db_path"})
        self.assertEqual(library["llm"], config["llm"])
        self.assertEqual(library["embedder"], config["embedder"])


    def test_routes_without_their_pinned_models_never_reach_the_library(self) -> None:
        # Left to itself this library picks a default model, so the failure is
        # not an error - it is a measurement of other weights. It has to be
        # refused before a client is ever constructed.
        for models in (
            python_models(llm=None),
            python_models(embedding=None),
            python_models(dimension=None),
            {"internal_memory_llm": None, "embedding": None},
            {},
            None,
        ):
            with self.subTest(models=models):
                response = asyncio.run(
                    mem0_adapter.execute(
                        request_for("retrieve"),
                        python_config(),
                        models,
                        client_factory=self.factory,
                        version_getter=lambda name: {"mem0ai": "2.0.19"}.get(name),
                    )
                )
                self.assertEqual(response["status"], "FAILED")
                self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(self.clients, [])

    def test_legacy_mem0_arm_is_rejected_before_client_creation(self) -> None:
        response = asyncio.run(
            mem0_adapter.execute(
                request_for(
                    "retrieve",
                    arm_id="mem0",
                    namespace_ref="0b356d5be525189d430e9f07061153bc2da9545ddad22f960934a940b99d13ba",
                ),
                python_config(),
                models_for(python_config()),
                client_factory=self.factory,
                version_getter=lambda _name: "2.0.19",
            )
        )
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(self.clients, [])

    def test_version_mismatch_fails_closed_before_client_creation(self) -> None:
        response = asyncio.run(
            mem0_adapter.execute(
                request_for("retrieve"),
                python_config(),
                models_for(python_config()),
                client_factory=self.factory,
                version_getter=lambda _name: "2.0.18",
            )
        )
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "ENDPOINT_UNAVAILABLE")
        self.assertEqual(self.clients, [])


class _StubTransport:
    """Stands in for httpx.HTTPTransport, recording what was sent."""

    def __init__(self, retries=None):
        self.retries = retries
        self.sent = []

    def handle_request(self, request):
        self.sent.append(request)
        return ("response", request)


class _StubHttpx:
    HTTPTransport = _StubTransport

    def __init__(self):
        self.clients = []

    def Timeout(self, seconds):  # noqa: N802 - httpx's spelling
        return ("timeout", seconds)

    def Client(self, *, transport, timeout):  # noqa: N802 - httpx's spelling
        built = {"transport": transport, "timeout": timeout}
        self.clients.append(built)
        return built


class _StubOpenAIClient:
    def __init__(self, *, api_key, base_url, max_retries, http_client):
        self.api_key = api_key
        self.base_url = base_url
        self.max_retries = max_retries
        self.http_client = http_client


class _Holder:
    def __init__(self, client=None):
        if client is not None:
            self.client = client


class Mem0MeteredClientTests(unittest.TestCase):
    """The seam D1 turns on, tested where a real runtime is not available.

    The first version of this shipped with the OpenAI *class* passed where the
    module was expected, so every construction raised AttributeError and every
    operation came back OPERATION_FAILED. Nothing in the suite touched it,
    because the only caller is the default factory and every adapter test
    injects a fake. These are the tests that would have caught it.
    """

    def bind(self, holder, **overrides):
        self.httpx = _StubHttpx()
        self.calls = []
        return mem0_adapter._bind_metered_client(
            overrides.get("openai_client", _StubOpenAIClient),
            self.httpx,
            holder,
            overrides.get("endpoint", "http://127.0.0.1:43100/llm-a"),
            self.calls.append,
            overrides.get("request_class", "internal_memory_llm"),
        )

    def test_the_constructed_client_is_replaced_with_a_retry_free_one(self) -> None:
        holder = _Holder(client="the client mem0 built")
        client = self.bind(holder)
        self.assertIs(holder.client, client)
        self.assertEqual(client.base_url, "http://127.0.0.1:43100/llm-a")
        # Zero, not "not two": the adapter declares automatic_retries 0 and the
        # frozen rule forbids a transparent retry during a measured unit.
        self.assertEqual(client.max_retries, 0)
        self.assertEqual(client.api_key, mem0_adapter.UNUSED_API_KEY)

    def test_the_slot_the_sdk_insists_on_is_not_a_credential(self) -> None:
        # Mem0 builds both clients during construction and the OpenAI client
        # refuses to exist without a key, while the host strips every real one
        # from the environment before an adapter is imported.
        self.assertEqual(mem0_adapter.UNUSED_API_KEY, "not-a-secret")
        # The spelling is the package scanner's, not a preference: it keeps a
        # list of values that are demonstrably not credentials, and a value it
        # does not recognise fails the packaging gate. So the gate that exists
        # to catch a real key in the tarball also holds this constant.

    def test_every_request_the_client_sends_is_counted_once(self) -> None:
        holder = _Holder(client="the client mem0 built")
        client = self.bind(holder, request_class="embedding")
        transport = client.http_client["transport"]
        self.assertEqual(transport.retries, 0)
        self.assertEqual(self.calls, [])

        # Counting at the transport rather than at the call site is the point:
        # a retry is a second request for one call, and a ledger taken where the
        # call is made could never see the difference.
        transport.handle_request("first")
        transport.handle_request("second")
        self.assertEqual(self.calls, ["embedding", "embedding"])
        self.assertEqual(transport.sent, ["first", "second"])

    def test_a_counter_that_refuses_stops_the_request(self) -> None:
        holder = _Holder(client="the client mem0 built")
        self.httpx = _StubHttpx()

        def refuse(_request_class):
            raise ContractError("Native client reported an unbound provider call")

        client = mem0_adapter._bind_metered_client(
            _StubOpenAIClient,
            self.httpx,
            holder,
            "http://127.0.0.1:43100/llm-a",
            refuse,
            "internal_memory_llm",
        )
        transport = client.http_client["transport"]
        with self.assertRaises(ContractError):
            transport.handle_request("first")
        self.assertEqual(transport.sent, [])

    def test_a_library_that_stopped_keeping_a_client_there_is_refused(self) -> None:
        with self.assertRaises(RuntimeUnavailable):
            self.bind(_Holder())

    def test_a_client_that_did_not_take_the_retry_setting_is_refused(self) -> None:
        class _IgnoresRetries(_StubOpenAIClient):
            def __init__(self, **kwargs):
                super().__init__(**kwargs)
                self.max_retries = 2

        with self.assertRaises(RuntimeUnavailable):
            self.bind(_Holder(client="the client mem0 built"), openai_client=_IgnoresRetries)

    def test_an_unimportable_runtime_is_reported_as_unavailable_not_as_a_crash(self) -> None:
        # The default factory is what the host reaches when nothing is injected,
        # and mem0 is not installed alongside these tests.
        with self.assertRaises(RuntimeUnavailable):
            mem0_adapter._default_client_factory(
                mem0_adapter._runtime_config(
                    python_config(), models_for(python_config()), self.state_root
                ),
                lambda _request_class: None,
            )

    def setUp(self) -> None:
        self.state_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.state_directory.cleanup)
        self.state_root = str(Path(self.state_directory.name).resolve())


if __name__ == "__main__":
    unittest.main()
