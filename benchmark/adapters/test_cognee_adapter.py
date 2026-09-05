from __future__ import annotations

import asyncio
import copy
import unittest
from enum import Enum
from uuid import UUID, uuid4, uuid5

import cognee_adapter

from test_support import DECISION_SHA256, models_for, python_config, python_models, request_for


COGNEE_REF = "b72f98aea2a794c87f25b3c65d1643224c3666380e9d5bbcf03ce59f11f883a7"
COGNEE_ALT_REF = "2cf7dd566405472a39d399f63526e54a4e9022d9565e77524f4a3f2dc96e7449"
# The id this adapter used to compute for "project-1", kept so a test can
# assert it is never used. Cognee derives its own from the dataset name, the
# owning user and the tenant, and reads a supplied id as a reference to an
# existing dataset the caller may write to - against the real library the
# computed id raised PermissionDeniedError and created nothing.
ADAPTER_INVENTED_DATASET_ID = UUID("f68d9708-304c-57b8-80a7-09ef1e12a274")
LIBRARY_NAMESPACE = UUID("6ba7b811-9dad-11d1-80b4-00c04fd430c8")


def library_dataset_id(name: str) -> UUID:
    """The id Cognee assigns, modelled as one this adapter cannot compute."""
    return uuid5(LIBRARY_NAMESPACE, f"cognee-library:{name}")


COGNEE_DATASET_ID = library_dataset_id("project-1")


class FakeSearchType(str, Enum):
    GRAPH_COMPLETION = "GRAPH_COMPLETION"


class FakeDataItem:
    def __init__(self, data, label=None, external_metadata=None, system_metadata=None, data_id=None):
        self.data = data
        self.label = label
        self.external_metadata = copy.deepcopy(external_metadata)
        self.system_metadata = copy.deepcopy(system_metadata)
        self.data_id = data_id


class FakeDataset:
    def __init__(self, dataset_id, name):
        self.id = dataset_id
        self.name = name


class FakeDataRow:
    __slots__ = ("id", "dataset_id", "raw_data_location", "external_metadata")

    def __init__(self, data_id, dataset_id, raw_data_location, external_metadata):
        self.id = data_id
        self.dataset_id = dataset_id
        self.raw_data_location = raw_data_location
        self.external_metadata = copy.deepcopy(external_metadata)


class FakeSearchResult:
    def __init__(self, search_result, dataset_id=None, dataset_name=None):
        self.search_result = copy.deepcopy(search_result)
        self.dataset_id = dataset_id
        self.dataset_name = dataset_name


class FakeRawFile:
    def __init__(self, content):
        self.content = content

    async def read(self):
        return self.content


class FakeOpenDataFile:
    def __init__(self, content):
        self.content = content

    async def __aenter__(self):
        return FakeRawFile(self.content)

    async def __aexit__(self, _error_type, _error, _traceback):
        return False


class FakeDatasets:
    def __init__(self, owner):
        self.owner = owner

    async def list_datasets(self, user=None):
        self.owner.calls.append(("list_datasets", user))
        if self.owner.fail_on == "list_datasets":
            raise RuntimeError("dataset resolution failed")
        return [
            FakeDataset(dataset_id, value["name"])
            for dataset_id, value in sorted(
                self.owner.backend.items(), key=lambda item: str(item[0])
            )
        ]

    async def empty_dataset(self, dataset_id, user=None):
        self.owner.calls.append(("empty_dataset", dataset_id, user))
        if self.owner.fail_on == "empty_dataset":
            raise RuntimeError("dataset reset failed")
        if dataset_id not in self.owner.backend:
            raise ValueError("dataset does not exist")
        for row in self.owner.backend[dataset_id]["rows"]:
            self.owner.raw_files.pop(row.raw_data_location, None)
        self.owner.backend.pop(dataset_id)

    async def list_data(self, dataset_id, user=None):
        self.owner.calls.append(("list_data", dataset_id, user))
        if self.owner.fail_on == "list_data":
            raise RuntimeError("dataset list failed")
        if dataset_id not in self.owner.backend:
            raise ValueError("dataset does not exist")
        return copy.deepcopy(self.owner.backend[dataset_id]["rows"])


class FakeCognee:
    DataItem = FakeDataItem
    SearchType = FakeSearchType

    def __init__(self, backend, raw_files, provider_call, *, fail_on=None, provider_counts=None, search_results=None):
        self.backend = backend
        self.raw_files = raw_files
        self.provider_call = provider_call
        self.fail_on = fail_on
        self.provider_counts = provider_counts or {"internal_memory_llm": 1, "embedding": 1}
        self.search_results = search_results or []
        self.calls = []
        self.datasets = FakeDatasets(self)

    def open_data_file(self, file_path, mode="rb", encoding=None):
        self.calls.append(("open_data_file", file_path, mode, encoding))
        if self.fail_on == "open_data_file":
            raise RuntimeError("raw content read failed")
        if mode != "rb" or encoding is not None or file_path not in self.raw_files:
            raise ValueError("invalid owned raw content request")
        return FakeOpenDataFile(self.raw_files[file_path])

    async def search(self, *, query_text, query_type, user=None, datasets=None, dataset_ids=None, top_k=15, only_context=False, llm_config=None, embedding_config=None):
        if query_type.value != "GRAPH_COMPLETION":
            raise AssertionError("query_type must be the pinned SearchType member")
        self.calls.append(("search", query_text, query_type, user, datasets, list(dataset_ids or []), top_k, only_context, copy.deepcopy(llm_config), copy.deepcopy(embedding_config)))
        for _index in range(self.provider_counts["embedding"]):
            self.provider_call("embedding")
        if not only_context:
            for _index in range(self.provider_counts["internal_memory_llm"]):
                self.provider_call("internal_memory_llm")
        if self.fail_on == "search":
            raise RuntimeError("cognee search failed secret-cognee")
        return copy.deepcopy(self.search_results)

    async def add(self, data, *, dataset_name="main_dataset", user=None, dataset_id=None, incremental_loading=True, llm_config=None, embedding_config=None, **_kwargs):
        self.calls.append(("add", data, dataset_name, dataset_id, user, incremental_loading, copy.deepcopy(llm_config), copy.deepcopy(embedding_config)))
        for _index in range(self.provider_counts["internal_memory_llm"]):
            self.provider_call("internal_memory_llm")
        for _index in range(self.provider_counts["embedding"]):
            self.provider_call("embedding")
        if self.fail_on == "add":
            raise RuntimeError("cognee add failed")
        # Cognee reads a supplied dataset id as a reference to a dataset that
        # already exists and that the caller holds write permission on. Against
        # the real library an id the store had never seen raised
        # PermissionDeniedError and created nothing at all, so this refuses it
        # rather than quietly creating one under the caller's id.
        if dataset_id is not None and dataset_id not in self.backend:
            raise PermissionError(
                "Request owner does not have necessary permission: [write] for all datasets requested"
            )
        resolved = dataset_id
        if resolved is None:
            resolved = next(
                (key for key, value in self.backend.items() if value["name"] == dataset_name),
                library_dataset_id(dataset_name),
            )
        dataset = self.backend.setdefault(resolved, {"name": dataset_name, "rows": []})
        if dataset["name"] != dataset_name:
            raise ValueError("dataset identity contradiction")
        location = f"file:///owned/{data.data_id}.txt"
        self.raw_files[location] = data.data.encode("utf-8")
        dataset["rows"].append(FakeDataRow(data.data_id, resolved, location, data.external_metadata))

    async def cognify(self, *, datasets=None, user=None, llm_config=None, embedding_config=None, **_kwargs):
        self.calls.append(("cognify", list(datasets or []), user, copy.deepcopy(llm_config), copy.deepcopy(embedding_config)))
        for _index in range(self.provider_counts["internal_memory_llm"]):
            self.provider_call("internal_memory_llm")
        for _index in range(self.provider_counts["embedding"]):
            self.provider_call("embedding")
        if self.fail_on == "cognify":
            raise RuntimeError("cognee cognify failed")


class CogneeAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = {}
        self.raw_files = {}
        self.clients = []
        self.configs = []
        self.fail_on = None
        self.provider_counts = {"internal_memory_llm": 1, "embedding": 1}
        self.search_results = []

    def factory(self, config, provider_call):
        self.configs.append(copy.deepcopy(config))
        client = FakeCognee(self.backend, self.raw_files, provider_call, fail_on=self.fail_on, provider_counts=self.provider_counts, search_results=self.search_results)
        self.clients.append(client)
        return client

    def request(self, operation, **overrides):
        return request_for(operation, arm_id="cognee", project_id="project-1", user_id=None, namespace_ref=COGNEE_REF, **overrides)

    def execute(self, operation, **overrides):
        return asyncio.run(cognee_adapter.execute(self.request(operation, **overrides), python_config(), models_for(python_config()), client_factory=self.factory, version_getter=lambda name: "1.5.3" if name == "cognee" else None))

    def test_first_reset_is_idempotent_when_exact_dataset_is_absent(self) -> None:
        response = self.execute("reset")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(self.clients[0].calls, [("list_datasets", None)])
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual(response["operations"]["memoryWriteOperations"], 0)

    def test_reset_empties_only_an_exact_resolved_dataset_uuid(self) -> None:
        self.backend[COGNEE_DATASET_ID] = {"name": "project-1", "rows": []}
        response = self.execute("reset")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(self.clients[0].calls, [("list_datasets", None), ("empty_dataset", COGNEE_DATASET_ID, None)])
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual(response["operations"]["memoryWriteOperations"], 1)

    def test_the_arm_adopts_the_id_cognee_assigned_and_never_computes_one(self) -> None:
        # The name is the arm's; the id is the library's. A dataset carrying the
        # id this adapter used to compute is not the arm's dataset, and one
        # carrying the arm's name is, whatever id it has.
        self.assertNotEqual(COGNEE_DATASET_ID, ADAPTER_INVENTED_DATASET_ID)
        self.backend[ADAPTER_INVENTED_DATASET_ID] = {"name": "someone-elses", "rows": []}
        self.backend[COGNEE_DATASET_ID] = {"name": "project-1", "rows": []}
        response = self.execute("reset")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(
            self.clients[0].calls,
            [("list_datasets", None), ("empty_dataset", COGNEE_DATASET_ID, None)],
        )

    def test_a_dataset_under_another_name_is_not_the_arm_s_dataset(self) -> None:
        self.backend[uuid4()] = {"name": "wrong-project", "rows": []}
        response = self.execute("reset")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual([call[0] for call in self.clients[0].calls], ["list_datasets"])
        self.assertEqual(response["operations"]["memoryWriteOperations"], 0)

    def test_two_datasets_sharing_the_arm_s_name_are_ambiguous_not_a_choice(self) -> None:
        self.backend[uuid4()] = {"name": "project-1", "rows": []}
        self.backend[uuid4()] = {"name": "project-1", "rows": []}
        response = self.execute("reset")
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual([call[0] for call in self.clients[0].calls], ["list_datasets"])

    def test_retrieve_before_anything_is_persisted_searches_nothing_and_says_so(self) -> None:
        # Naming the dataset to Cognee's search would create it, and inventing
        # an embedding call to satisfy the traffic contract would be worse than
        # reporting what happened.
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(response["result"]["nativeContext"], [])
        self.assertEqual(response["operations"]["embeddingCalls"], 0)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual([call[0] for call in self.clients[0].calls], ["list_datasets"])

    def test_retrieve_maps_search_result_context_and_skips_internal_llm_in_context_mode(self) -> None:
        self.backend[COGNEE_DATASET_ID] = {"name": "project-1", "rows": []}
        self.search_results = [FakeSearchResult({"fact": "Use the reversible option."}, COGNEE_DATASET_ID, "project-1")]
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(response["operations"]["memoryReadOperations"], 2)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["embeddingCalls"], 1)
        self.assertEqual(response["result"]["nativeContext"], [{"search_result": {"fact": "Use the reversible option."}, "dataset_id": str(COGNEE_DATASET_ID), "dataset_name": "project-1"}])
        config = self.configs[0]
        self.assertEqual(config["mode"], "openai_compatible")
        self.assertEqual(config["llm_config"]["endpoint"], "http://127.0.0.1:43100/llm-a")
        self.assertEqual(config["embedding_config"]["endpoint"], "http://127.0.0.1:43100/embed-a")
        # Cognee's completion path goes through litellm, which needs the
        # provider prefix to resolve a model it has not seen; the embedding path
        # uses the OpenAI-compatible engine directly and takes the bare id. The
        # ACL demonstration established both against the live service.
        self.assertEqual(config["llm_config"]["model"], "openai/qwen2.5:0.5b")
        self.assertEqual(config["embedding_config"]["model"], "nomic-embed-text:v1.5")
        self.assertEqual(config["embedding_config"]["dimensions"], 768)
        self.assertEqual(config["llm_config"]["max_retries"], 0)
        self.assertEqual(config["embedding_config"]["max_retries"], 0)
        self.assertEqual(config["automatic_retries"], 0)
        self.assertEqual(config["retry_proof"], "task8_runtime_meter_required")
        self.assertNotIn("ollama", str(config).lower())
        search_call = self.clients[0].calls[1]
        self.assertIs(search_call[2], FakeSearchType.GRAPH_COMPLETION)
        self.assertIsNone(search_call[4])
        self.assertEqual(search_call[5], [COGNEE_DATASET_ID])
        self.assertIs(search_call[7], True)

    def test_persist_adds_deterministic_data_item_then_cognifies_without_fixture_preload(self) -> None:
        response = self.execute("persist")
        self.assertEqual(response["status"], "SUCCEEDED")
        # The listing between the two writes is how the id is adopted: Cognee
        # assigns it while handling the add, and nothing before that call can
        # know it.
        self.assertEqual(
            [call[0] for call in self.clients[0].calls], ["add", "list_datasets", "cognify"]
        )
        item = self.clients[0].calls[0][1]
        self.assertIsInstance(item.data_id, UUID)
        self.assertEqual(str(item.data_id), "2c06c6a7-6772-5711-8f12-054e8b4c4a6b")
        self.assertEqual(item.external_metadata["shadowgraph_content_sha256"], DECISION_SHA256)
        self.assertIn("Use the reversible option.", item.data)
        # By name only. An id here would be a reference to an existing dataset.
        self.assertIsNone(self.clients[0].calls[0][3])
        self.assertEqual(self.clients[0].calls[0][2], "project-1")
        self.assertEqual(self.clients[0].calls[2][1], [COGNEE_DATASET_ID])
        self.assertNotIn(ADAPTER_INVENTED_DATASET_ID, self.backend)
        self.assertEqual(response["operations"]["memoryWriteOperations"], 2)
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 2)
        self.assertEqual(response["operations"]["embeddingCalls"], 2)

    def test_multiple_legitimate_cognee_provider_calls_are_preserved(self) -> None:
        self.backend[COGNEE_DATASET_ID] = {"name": "project-1", "rows": []}
        self.provider_counts = {"internal_memory_llm": 2, "embedding": 3}
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["embeddingCalls"], 3)

    def test_fresh_verification_reads_realistic_rows_through_open_data_file(self) -> None:
        self.execute("persist")
        row = self.backend[COGNEE_DATASET_ID]["rows"][0]
        self.assertFalse(hasattr(row, "data"))
        response = self.execute("verify", alternate_namespace={"projectId": "project-alt", "userId": None}, alternate_namespace_ref=COGNEE_ALT_REF)
        self.assertEqual(len(self.clients), 2)
        self.assertEqual(response["status"], "SUCCEEDED")
        self.assertEqual(response["result"]["persistenceEvidence"]["observedContentSha256"], DECISION_SHA256)
        self.assertTrue(response["result"]["isolationEvidence"]["verified"])
        self.assertEqual(response["operations"]["persistenceVerificationOperations"], 3)
        self.assertEqual([call[0] for call in self.clients[1].calls], ["list_datasets", "list_data", "open_data_file"])
        self.assertEqual(self.clients[1].calls[1][1], COGNEE_DATASET_ID)
        self.assertEqual(self.clients[1].calls[2][2:], ("rb", None))

    def test_native_user_acl_is_a_task8_gate_not_a_synthetic_namespace(self) -> None:
        bad = request_for("retrieve", arm_id="cognee", project_id="project-1", user_id="user-1", namespace_ref="f9e9c35ee8ababe775bc20289baaebd4f4be29d3b52e7130a4642d517ca6dccf")
        response = asyncio.run(cognee_adapter.execute(bad, python_config(), models_for(python_config()), client_factory=self.factory, version_getter=lambda _name: "1.5.3"))
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(self.clients, [])


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
                    cognee_adapter.execute(
                        self.request("retrieve"),
                        python_config(),
                        models,
                        client_factory=self.factory,
                        version_getter=lambda name: {"cognee": "1.5.3"}.get(name),
                    )
                )
                self.assertEqual(response["status"], "FAILED")
                self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(self.clients, [])

    def test_storage_is_not_available_and_no_usage_or_applicability_is_invented(self) -> None:
        response = self.execute("persist")
        self.assertEqual(response["storage"]["status"], "NOT_AVAILABLE")
        self.assertIsNone(response["storage"]["bytes"])
        serialized = str(response).lower()
        self.assertNotIn("usage", serialized)
        self.assertNotIn("applicability", serialized)

    def test_failed_search_counts_embedding_traffic_but_no_skipped_llm_call(self) -> None:
        self.backend[COGNEE_DATASET_ID] = {"name": "project-1", "rows": []}
        self.fail_on = "search"
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(len(self.clients[0].calls), 2)
        self.assertEqual(response["operations"]["memoryReadOperations"], 2)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["embeddingCalls"], 1)
        self.assertNotIn("secret-cognee", str(response))

    def test_wrong_cognee_version_fails_before_dotenv_import_or_client_creation(self) -> None:
        response = asyncio.run(cognee_adapter.execute(self.request("retrieve"), python_config(), models_for(python_config()), client_factory=self.factory, version_getter=lambda _name: "1.5.2"))
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "ENDPOINT_UNAVAILABLE")
        self.assertEqual(self.clients, [])


if __name__ == "__main__":
    unittest.main()
