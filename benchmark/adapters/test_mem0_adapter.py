from __future__ import annotations

import asyncio
import copy
import unittest

import mem0_adapter

from python_runtime import encode_content
from test_support import DECISION_CONTENT, DECISION_SHA256, python_config, request_for


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
        self.assertNotIn("max_retries", config["llm"]["config"])
        self.assertNotIn("max_retries", config["embedder"]["config"])
        self.assertEqual(config["automatic_retries"], 0)
        self.assertEqual(config["retry_proof"], "task8_runtime_meter_required")

    def test_legacy_mem0_arm_is_rejected_before_client_creation(self) -> None:
        response = asyncio.run(
            mem0_adapter.execute(
                request_for(
                    "retrieve",
                    arm_id="mem0",
                    namespace_ref="0b356d5be525189d430e9f07061153bc2da9545ddad22f960934a940b99d13ba",
                ),
                python_config(),
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
                client_factory=self.factory,
                version_getter=lambda _name: "2.0.18",
            )
        )
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "ENDPOINT_UNAVAILABLE")
        self.assertEqual(self.clients, [])


if __name__ == "__main__":
    unittest.main()
