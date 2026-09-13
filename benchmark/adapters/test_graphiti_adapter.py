from __future__ import annotations

import asyncio
import copy
from enum import Enum
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import threading
import unittest
from unittest.mock import patch

import graphiti_adapter

from test_support import DECISION_SHA256, models_for, python_config, python_models, request_for


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
        if not isinstance(driver, FakeDriver) or driver.database != "neo4j":
            raise AssertionError("delete must use the configured Neo4j driver")
        self.owner.calls.append(("delete_by_group_id", driver, group_id))
        self.owner.backend[group_id] = []
        if self.owner.fail_on == "delete_by_group_id":
            raise RuntimeError("graph reset failed")


class FakeEpisodeType:
    def __init__(self, owner):
        self.owner = owner

    async def get_by_group_ids(self, driver, group_ids, **kwargs):
        if len(group_ids) != 1 or not isinstance(driver, FakeDriver) or driver.database != "neo4j":
            raise AssertionError("episode verification must use the configured Neo4j driver")
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
        self.driver = FakeDriver("neo4j")
        self.driver_requests = []
        self.node_type = FakeNodeType(self)
        self.episodic_node_type = FakeEpisodeType(self)

    def driver_for_group(self, group_id):
        self.driver_requests.append(group_id)
        return self.driver

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
                models_for(python_config()),
                client_factory=self.factory,
                version_getter=lambda name: {
                    "graphiti-core": "0.29.3",
                    "httpx": "0.28.1",
                }.get(name),
            )
        )

    def test_runtime_config_carries_the_pinned_models_and_the_embedding_width(self) -> None:
        self.execute("retrieve")
        config = self.configs[0]
        self.assertEqual(config["llm_endpoint"], "http://127.0.0.1:43100/llm-a")
        self.assertEqual(config["embedding_endpoint"], "http://127.0.0.1:43100/embed-a")
        self.assertEqual(config["llm_model"], "qwen2.5:7b")
        self.assertEqual(config["embedding_model"], "nomic-embed-text:v1.5")
        self.assertEqual(config["embedding_dimension"], 768)
        self.assertEqual(config["graph_database_uri"], "bolt://127.0.0.1:7687")
        self.assertEqual(config["graph_database_name"], "neo4j")
        self.assertEqual(config["graph_database_auth"], "none")

    def test_default_factory_constructs_the_pinned_native_graphiti_clients(self) -> None:
        constructed = {}

        class Config:
            def __init__(self, **values):
                self.values = values

        class EmbedderConfig(Config):
            pass

        class LlmClient:
            def __init__(self, config, **options):
                constructed["llm"] = (config.values, options)

        class Embedder:
            def __init__(self, config, **options):
                constructed["embedder"] = (config.values, options)

        class Reranker:
            def __init__(self, config, **options):
                constructed["reranker"] = (config.values, options)

        class Driver:
            def __init__(self, database="neo4j"):
                self.database = database

            def clone(self, *, database):
                raise AssertionError("Neo4j group scope must not select a project database")

        class AsyncTransport:
            def __init__(self, **options):
                self.options = options
                constructed.setdefault("transports", []).append(self)

            async def handle_async_request(self, request):
                constructed.setdefault("transport_sends", 0)
                constructed["transport_sends"] += 1
                return request

        class AsyncClient:
            def __init__(self, **options):
                self.options = options

        class AsyncOpenAI:
            def __init__(self, **options):
                self.options = options
                self.max_retries = options["max_retries"]
                constructed.setdefault("openai", []).append(self)

        class NativeGraphiti:
            def __init__(self, **options):
                constructed["graphiti"] = options
                self.driver = Driver()

            async def search(self, *args, **kwargs):
                return []

            async def add_episode(self, *args, **kwargs):
                return None

        runtime = {
            "Graphiti": NativeGraphiti,
            "EpisodeType": FakeEpisodeSource,
            "EpisodicNode": object(),
            "LLMConfig": Config,
            "OpenAIGenericClient": LlmClient,
            "OpenAIEmbedderConfig": EmbedderConfig,
            "OpenAIEmbedder": Embedder,
            "OpenAIRerankerClient": Reranker,
            "clear_data": object(),
            "httpx": type(
                "Httpx",
                (),
                {
                    "AsyncHTTPTransport": AsyncTransport,
                    "AsyncClient": AsyncClient,
                    "Timeout": staticmethod(lambda seconds: seconds),
                },
            ),
            "AsyncOpenAI": AsyncOpenAI,
        }
        config = {
            "llm_endpoint": "http://127.0.0.1:43100/llm-a",
            "embedding_endpoint": "http://127.0.0.1:43100/embed-a",
            "llm_model": "qwen2.5:7b",
            "embedding_model": "nomic-embed-text:v1.5",
            "embedding_dimension": 768,
            "graph_database_uri": "bolt://127.0.0.1:7687",
            "graph_database_name": "neo4j",
            "graph_database_auth": "none",
            "store_raw_episode_content": True,
        }

        provider_classes = []
        client = graphiti_adapter._default_client_factory(
            config,
            provider_classes.append,
            runtime=runtime,
        )
        llm_values = {
            key: value for key, value in constructed["llm"][0].items() if not key.endswith("_key")
        }
        embedder_values = {
            key: value for key, value in constructed["embedder"][0].items() if not key.endswith("_key")
        }

        self.assertEqual(
            llm_values,
            {
                "model": "qwen2.5:7b",
                "base_url": "http://127.0.0.1:43100/llm-a",
                "temperature": 0,
            },
        )
        self.assertEqual(constructed["llm"][1]["cache"], False)
        self.assertIs(constructed["llm"][1]["client"], constructed["openai"][0])
        self.assertEqual(
            embedder_values,
            {
                "embedding_model": "nomic-embed-text:v1.5",
                "embedding_dim": 768,
                "base_url": "http://127.0.0.1:43100/embed-a",
            },
        )
        self.assertIs(constructed["embedder"][1]["client"], constructed["openai"][1])
        self.assertEqual(constructed["reranker"][0], constructed["llm"][0])
        self.assertIs(constructed["reranker"][1]["client"], constructed["openai"][0])
        self.assertEqual(len(constructed["openai"]), 2)
        self.assertTrue(all(client.max_retries == 0 for client in constructed["openai"]))
        self.assertEqual([transport.options for transport in constructed["transports"]], [{"retries": 0}, {"retries": 0}])
        self.assertEqual(
            [client.options["http_client"].options["timeout"] for client in constructed["openai"]],
            [120, 120],
        )
        graphiti_options = constructed["graphiti"]
        self.assertEqual(graphiti_options["uri"], "bolt://127.0.0.1:7687")
        self.assertIsNone(graphiti_options["user"])
        self.assertIsNone(graphiti_options["password"])
        self.assertTrue(graphiti_options["store_raw_episode_content"])
        self.assertIs(client.driver_for_group("project-1"), client.driver)
        self.assertIs(client.EpisodeType, FakeEpisodeSource)

        async def fake_declare(endpoint):
            return {"alias": "a" * 48, "plannedDispatchId": "b" * 48}

        async def fake_close(endpoint, identity):
            return None

        with (
            patch.object(graphiti_adapter, "_meter_declare", fake_declare),
            patch.object(graphiti_adapter, "_meter_close", fake_close),
        ):
            asyncio.run(
                constructed["openai"][0].options["http_client"].options["transport"].handle_async_request(
                    object()
                )
            )
            asyncio.run(
                constructed["openai"][1].options["http_client"].options["transport"].handle_async_request(
                    object()
                )
            )
        self.assertEqual(constructed["transport_sends"], 2)
        self.assertEqual(provider_classes, ["internal_memory_llm", "embedding"])

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
                    graphiti_adapter.execute(
                        self.request("retrieve"),
                        python_config(),
                        models,
                        client_factory=self.factory,
                        version_getter=lambda name: {"graphiti-core": "0.29.3", "httpx": "0.28.1"}.get(name),
                    )
                )
                self.assertEqual(response["status"], "FAILED")
                self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(self.clients, [])

    def test_reset_uses_native_delete_by_exact_group_and_not_global_clear(self) -> None:
        response = self.execute("reset")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(self.clients[0].calls[0][0], "delete_by_group_id")
        self.assertEqual(self.clients[0].calls[0][1].database, "neo4j")
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

    def test_valid_zero_entity_persist_does_not_require_embedding_traffic(self) -> None:
        self.provider_counts = {"internal_memory_llm": 2, "embedding": 0}
        persisted = self.execute("persist")
        self.assertEqual(persisted["status"], "SUCCEEDED")
        self.assertEqual(persisted["operations"]["internalMemoryModelCalls"], 2)
        self.assertEqual(persisted["operations"]["embeddingCalls"], 0)

        verified = self.execute("verify")
        self.assertEqual(verified["status"], "SUCCEEDED")
        self.assertTrue(verified["result"]["persistenceEvidence"]["verified"])

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
            ["neo4j", "neo4j"],
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
                models_for(python_config()),
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
                models_for(python_config()),
                client_factory=self.factory,
                version_getter=lambda name: {"graphiti-core": "0.29.3", "httpx": "0.28.0"}.get(name),
            )
        )
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "ENDPOINT_UNAVAILABLE")
        self.assertEqual(self.clients, [])


class GraphitiMeteredTests(unittest.TestCase):
    def test_meter_declares_and_closes_over_loopback(self) -> None:
        calls = []
        alias = "c" * 48
        dispatch_id = "d" * 48

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                return None

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                calls.append((self.path, dict(self.headers), body))
                if self.path == "/meter/route/__shadowgraph/declare":
                    response = json.dumps({
                        "alias": alias,
                        "plannedDispatchId": dispatch_id,
                    }).encode("utf-8")
                    self.send_response(201)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)
                    return
                if self.path == "/meter/route/__shadowgraph/close":
                    self.send_response(204)
                    self.end_headers()
                    return
                self.send_response(404)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(lambda: server.shutdown())
        endpoint = f"http://127.0.0.1:{server.server_address[1]}/meter/route"

        identity = asyncio.run(graphiti_adapter._meter_declare(endpoint))
        asyncio.run(graphiti_adapter._meter_close(endpoint, identity))

        self.assertEqual(identity, {"alias": alias, "plannedDispatchId": dispatch_id})
        self.assertEqual([item[0] for item in calls], [
            "/meter/route/__shadowgraph/declare",
            "/meter/route/__shadowgraph/close",
        ])

    def test_metered_transport_declares_injects_alias_and_closes(self) -> None:
        calls = []
        alias = "e" * 48
        dispatch_id = "f" * 48

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, _format, *_args):
                return None

            def do_POST(self):
                length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(length)
                calls.append((self.path, dict(self.headers), body))
                if self.path == "/v1/__shadowgraph/declare":
                    response = json.dumps({
                        "alias": alias,
                        "plannedDispatchId": dispatch_id,
                    }).encode("utf-8")
                    self.send_response(201)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(response)))
                    self.end_headers()
                    self.wfile.write(response)
                    return
                if self.path == "/v1/__shadowgraph/close":
                    self.send_response(204)
                    self.end_headers()
                    return
                self.send_response(404)
                self.end_headers()

        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(lambda: server.shutdown())
        endpoint = f"http://127.0.0.1:{server.server_address[1]}/v1"

        provider_calls = []

        class FakeBaseTransport:
            def __init__(self, **_kwargs):
                pass

            async def handle_async_request(self, request):
                calls.append(("upstream", dict(request.headers), b""))
                return "ok"

        runtime = {
            "httpx": type("Httpx", (), {
                "AsyncHTTPTransport": FakeBaseTransport,
                "AsyncClient": lambda **kwargs: kwargs,
                "Timeout": lambda s: s,
            }),
            "AsyncOpenAI": lambda **kwargs: kwargs,
        }

        openai_client = graphiti_adapter._metered_openai(
            runtime,
            endpoint,
            provider_calls.append,
            "internal_memory_llm",
        )
        transport = openai_client["http_client"]["transport"]

        class DummyRequest:
            def __init__(self):
                self.headers = {}

        dummy_req = DummyRequest()
        result = asyncio.run(transport.handle_async_request(dummy_req))

        self.assertEqual(result, "ok")
        self.assertEqual(provider_calls, ["internal_memory_llm"])
        self.assertEqual(dummy_req.headers.get("x-shadowgraph-dispatch-alias"), alias)
        self.assertEqual([item[0] for item in calls], [
            "/v1/__shadowgraph/declare",
            "upstream",
            "/v1/__shadowgraph/close",
        ])


if __name__ == "__main__":
    unittest.main()
