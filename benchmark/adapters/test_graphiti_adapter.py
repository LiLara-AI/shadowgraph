from __future__ import annotations

import asyncio
import copy
import unittest
from enum import Enum

import graphiti_adapter

from test_support import DECISION_SHA256, python_config, request_for


GRAPHITI_REF = "664420cbcbeafd7fb0ea677738f75786c24b40bb47def18120fc87197270528c"
GRAPHITI_ALT_REF = "6895034a9401768607c6d8acf279c803c7a543cedb537c330bbae64f79d2d166"


class FakeEpisodeSource(str, Enum):
    text = "text"


class FakeDriver:
    def __init__(self, database):
        self.database = database


class FakeNodeType:
    def __init__(self, owner):
        self.owner = owner

    async def delete_by_group_id(self, driver, group_id):
        if not isinstance(driver, FakeDriver) or driver.database != group_id:
            raise AssertionError("delete must use the exact group database driver")
        self.owner.calls.append(("delete_by_group_id", driver, group_id))
        self.owner.backend[group_id] = []
        if self.owner.fail_on == "delete_by_group_id":
            raise RuntimeError("graph reset failed")


class FakeEpisodeType:
    def __init__(self, owner):
        self.owner = owner

    async def get_by_group_ids(self, driver, group_ids, **kwargs):
        if len(group_ids) != 1 or not isinstance(driver, FakeDriver) or driver.database != group_ids[0]:
            raise AssertionError("episode verification must use the exact group database driver")
        self.owner.calls.append(("get_by_group_ids", driver, list(group_ids), copy.deepcopy(kwargs)))
        if self.owner.fail_on == "get_by_group_ids":
            raise RuntimeError("graph read failed")
        records = []
        for group_id in group_ids:
            records.extend(copy.deepcopy(self.owner.backend.get(group_id, [])))
        return records


class FakeGraphiti:
    EpisodeType = FakeEpisodeSource

    def __init__(self, backend, provider_call, *, fail_on=None, search_results=None, provider_counts=None):
        self.backend = backend
        self.provider_call = provider_call
        self.fail_on = fail_on
        self.search_results = search_results
        self.provider_counts = provider_counts or {"internal_memory_llm": 1, "embedding": 1}
        self.calls = []
        self.driver = FakeDriver("unscoped-default-must-not-be-used")
        self.driver_requests = []
        self.node_type = FakeNodeType(self)
        self.episodic_node_type = FakeEpisodeType(self)

    def driver_for_group(self, group_id):
        self.driver_requests.append(group_id)
        return FakeDriver(group_id)

    async def search(self, query, *, group_ids, **kwargs):
        self.calls.append(("search", query, list(group_ids), copy.deepcopy(kwargs)))
        for _index in range(self.provider_counts["embedding"]):
            self.provider_call("embedding")
        if self.fail_on == "search":
            raise RuntimeError("graph search failed secret-graph")
        if self.search_results is not None:
            return copy.deepcopy(self.search_results)
        results = []
        for group_id in group_ids:
            results.extend(copy.deepcopy(self.backend.get(group_id, [])))
        return results

    async def add_episode(
        self,
        name,
        episode_body,
        source_description,
        reference_time,
        *,
        source,
        group_id=None,
        **kwargs,
    ):
        if source is not self.EpisodeType.text:
            raise AssertionError("source must be the pinned EpisodeType.text member")
        self.calls.append(
            (
                "add_episode",
                name,
                episode_body,
                source_description,
                reference_time,
                source,
                group_id,
                copy.deepcopy(kwargs),
            )
        )
        for _index in range(self.provider_counts["internal_memory_llm"]):
            self.provider_call("internal_memory_llm")
        for _index in range(self.provider_counts["embedding"]):
            self.provider_call("embedding")
        if self.fail_on == "add_episode":
            raise RuntimeError("graph write failed")
        self.backend.setdefault(group_id, []).append(
            {
                "uuid": f"native-episode-{len(self.backend.get(group_id, [])) + 1}",
                "name": name,
                "group_id": group_id,
                "content": episode_body,
                "source_description": source_description,
            }
        )


class GraphitiAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = {}
        self.clients = []
        self.configs = []
        self.fail_on = None
        self.search_results = []
        self.provider_counts = {"internal_memory_llm": 1, "embedding": 1}

    def factory(self, config, provider_call):
        self.configs.append(copy.deepcopy(config))
        client = FakeGraphiti(
            self.backend,
            provider_call,
            fail_on=self.fail_on,
            search_results=self.search_results,
            provider_counts=self.provider_counts,
        )
        self.clients.append(client)
        return client

    def request(self, operation, **overrides):
        return request_for(
            operation,
            arm_id="graphiti",
            project_id="project-1",
            user_id=None,
            namespace_ref=GRAPHITI_REF,
            **overrides,
        )

    def execute(self, operation, **overrides):
        return asyncio.run(
            graphiti_adapter.execute(
                self.request(operation, **overrides),
                python_config(),
                client_factory=self.factory,
                version_getter=lambda name: {
                    "graphiti-core": "0.29.3",
                    "httpx": "0.28.1",
                }.get(name),
            )
        )

    def test_reset_uses_native_delete_by_exact_group_and_not_global_clear(self) -> None:
        response = self.execute("reset")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(self.clients[0].calls[0][0], "delete_by_group_id")
        self.assertEqual(self.clients[0].calls[0][1].database, "project-1")
        self.assertEqual(self.clients[0].calls[0][2], "project-1")
        self.assertEqual(self.clients[0].driver_requests, ["project-1"])
        self.assertEqual(response["operations"]["memoryWriteOperations"], 1)

    def test_retrieve_is_exact_group_scoped_and_default_search_uses_embedding_only(self) -> None:
        response = self.execute("retrieve")
        self.assertEqual(self.clients[0].calls[0][0:3], ("search", "Choose the safe option.", ["project-1"]))
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["embeddingCalls"], 1)
        self.assertEqual(self.configs[0]["automatic_retries"], 0)
        self.assertEqual(self.configs[0]["retry_proof"], "task8_runtime_meter_required")
        self.assertEqual(self.configs[0]["max_retries"], 0)

    def test_retrieve_maps_real_entity_edges_without_episode_content_decoding(self) -> None:
        class EntityEdge:
            uuid = "edge-object"
            fact = "The object edge is relevant."
            name = "SUPPORTS"
            group_id = "project-1"
            source_node_uuid = "node-source"
            target_node_uuid = "node-target"

        self.search_results = [
            {
                "uuid": "edge-dict",
                "fact": "The dictionary edge is relevant.",
                "group_id": "project-1",
            },
            EntityEdge(),
        ]
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(
            response["result"]["nativeContext"],
            [
                {
                    "uuid": "edge-dict",
                    "fact": "The dictionary edge is relevant.",
                    "group_id": "project-1",
                },
                {
                    "uuid": "edge-object",
                    "fact": "The object edge is relevant.",
                    "name": "SUPPORTS",
                    "group_id": "project-1",
                    "source_node_uuid": "node-source",
                    "target_node_uuid": "node-target",
                },
            ],
        )

    def test_multiple_legitimate_graphiti_embedding_calls_are_preserved(self) -> None:
        self.provider_counts = {"internal_memory_llm": 2, "embedding": 3}
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["embeddingCalls"], 3)

    def test_persist_omits_backend_uuid_and_uses_logical_name_with_exact_canonical_content(self) -> None:
        response = self.execute("persist")
        self.assertEqual(response["status"], "SUCCEEDED")
        call = self.clients[0].calls[0]
        self.assertEqual(call[0], "add_episode")
        self.assertEqual(call[1], "decision:8:graphiti:10:scenario-1:1:0:1:A")
        self.assertEqual(call[6], "project-1")
        self.assertEqual(call[7], {})
        self.assertIs(call[5], FakeEpisodeSource.text)
        self.assertIn("Use the reversible option.", call[2])
        self.assertEqual(response["operations"]["memoryWriteOperations"], 1)

    def test_fresh_episode_read_verifies_exact_id_hash_and_alternate_group_absence(self) -> None:
        self.execute("persist")
        response = self.execute(
            "verify",
            alternate_namespace={"projectId": "project-alt", "userId": None},
            alternate_namespace_ref=GRAPHITI_ALT_REF,
        )
        self.assertEqual(len(self.clients), 2)
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(response["result"]["persistenceEvidence"]["observedContentSha256"], DECISION_SHA256)
        self.assertTrue(response["result"]["isolationEvidence"]["verified"])
        self.assertEqual(response["operations"]["persistenceVerificationOperations"], 2)
        self.assertEqual(self.clients[1].driver_requests, ["project-1", "project-alt"])
        self.assertEqual(
            [call[1].database for call in self.clients[1].calls],
            ["project-1", "project-alt"],
        )

    def test_neo4j_storage_is_truthfully_not_available(self) -> None:
        response = self.execute("persist")
        self.assertEqual(response["storage"]["status"], "NOT_AVAILABLE")
        self.assertIsNone(response["storage"]["bytes"])
        self.assertIn("Neo4j", response["storage"]["scope"])

    def test_user_namespace_and_database_clone_without_gate_fail_closed_before_client(self) -> None:
        bad = request_for(
            "retrieve",
            arm_id="graphiti",
            project_id="project-1",
            user_id="user-1",
            namespace_ref="b4a8d3b77da7a6f65ef5e1368ecd6e5d27d14a289a9f47aa4cec15d3161729dd",
        )
        response = asyncio.run(
            graphiti_adapter.execute(
                bad,
                python_config(),
                client_factory=self.factory,
                version_getter=lambda name: {"graphiti-core": "0.29.3", "httpx": "0.28.1"}.get(name),
            )
        )
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(self.clients, [])

    def test_failure_is_counted_once_and_graphiti_retry_loop_is_not_entered(self) -> None:
        self.fail_on = "search"
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(len(self.clients[0].calls), 1)
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["embeddingCalls"], 1)
        self.assertNotIn("secret-graph", str(response))

    def test_both_pinned_versions_are_required_before_client_creation(self) -> None:
        response = asyncio.run(
            graphiti_adapter.execute(
                self.request("retrieve"),
                python_config(),
                client_factory=self.factory,
                version_getter=lambda name: {"graphiti-core": "0.29.3", "httpx": "0.28.0"}.get(name),
            )
        )
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "ENDPOINT_UNAVAILABLE")
        self.assertEqual(self.clients, [])


if __name__ == "__main__":
    unittest.main()
