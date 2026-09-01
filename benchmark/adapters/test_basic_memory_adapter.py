from __future__ import annotations

import asyncio
import copy
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import basic_memory_adapter
import python_runtime
from envelope import ContractError

from test_support import DECISION_SHA256, python_config, request_for


BASIC_REF = "df8bfcf3fb8f56f2e8144f81e6db609ffa86190e3534f99393e85d687016ac6e"
BASIC_ALT_REF = "45a5242b2a57d067616a55782a2170fda7bcf519fba3a4dbd179f634a52b5db6"


class FakeBasicMemory:
    def __init__(self, backend, *, fail_on=None, default_project=None):
        self.backend = backend
        self.fail_on = fail_on
        self.calls = []
        self.default_project = default_project

    async def list_memory_projects(self, *, output_format="text", context=None):
        self.calls.append(("list_memory_projects", output_format, context))
        if self.fail_on == "list_memory_projects":
            raise RuntimeError("list projects failed")
        return {
            "projects": [
                {"name": project, "path": details.get("__project_path__")}
                for project, details in sorted(self.backend.items())
            ]
        }

    async def delete_project(self, project_name, *, delete_notes=False, workspace=None):
        self.calls.append(("delete_project", project_name, delete_notes, workspace))
        if self.fail_on == "delete_project":
            raise RuntimeError("delete failed")
        if project_name not in self.backend:
            raise ValueError("project not found")
        if len(self.backend) == 1:
            # Matches basic-memory 0.23.2, which refuses to remove the last
            # project in a configuration.
            raise ValueError(
                "Cannot delete default project '%s'. This is the only project "
                "in your configuration." % project_name
            )
        if project_name == getattr(self, "default_project", None):
            # A second, independent product rule, observed with two projects
            # present: the default cannot be deleted whatever the count.
            raise ValueError(
                "Cannot delete default project '%s'. Set another project as "
                "default first." % project_name
            )
        self.backend.pop(project_name)

    async def create_memory_project(self, project_name, project_path, *, set_default=False, workspace=None, output_format="text"):
        self.calls.append(("create_memory_project", project_name, project_path, set_default, workspace, output_format))
        if set_default or not self.backend:
            # A fresh store promotes its first project to default.
            self.default_project = project_name
        if self.fail_on == "create_memory_project":
            raise RuntimeError("create failed")
        if not isinstance(project_path, str) or not os.path.isabs(project_path):
            raise ValueError("project_path must be absolute")
        if not Path(project_path).is_dir() or Path(project_path).is_symlink():
            raise ValueError("project_path must already be an owned real directory")
        self.backend.setdefault(project_name, {})["__project_path__"] = project_path

    async def search_notes(self, query=None, *, project=None, project_id=None, search_all_projects=False, output_format="text", search_type=None, **_kwargs):
        self.calls.append(("search_notes", query, project, project_id, search_all_projects, output_format, search_type))
        if self.fail_on == "search_notes":
            raise RuntimeError("search failed private/path")
        if search_type != "text":
            # Basic Memory 0.23.2 defaults to embedding-backed hybrid retrieval,
            # which reaches a provider. An arm declaring no request classes must
            # name the local index rather than inherit that default.
            raise ValueError(
                "search_type must be 'text'; the default performs hybrid retrieval"
            )
        results = []
        for title, note in sorted(self.backend.get(project, {}).items()):
            if title.startswith("__"):
                continue
            # Product-shaped hit: carries the body, but its metadata holds no
            # shadowgraph frontmatter, so it cannot become a logical record.
            results.append({
                "title": title,
                "permalink": note.get("permalink"),
                "content": note.get("content"),
                "metadata": {"note_type": "note"},
                "score": -1e-06,
                "type": "entity",
            })
        return {"results": results, "total": len(results)}

    async def write_note(self, title, content, directory, *, project=None, project_id=None, metadata=None, overwrite=None, output_format="text", **_kwargs):
        self.calls.append(("write_note", title, content, directory, project, project_id, copy.deepcopy(metadata), overwrite, output_format))
        if self.fail_on == "write_note":
            raise RuntimeError("write failed")
        note = {
            "title": title,
            "permalink": f"memory://{project}/{directory}/{title}",
            "content": content,
            "metadata": copy.deepcopy(metadata),
        }
        self.backend.setdefault(project, {})[title] = note
        return copy.deepcopy(note)

    async def read_note(self, identifier, *, project=None, project_id=None, output_format="text", include_frontmatter=False, **_kwargs):
        self.calls.append(("read_note", identifier, project, project_id, output_format, include_frontmatter))
        if self.fail_on == "read_note":
            raise RuntimeError("read failed")
        return copy.deepcopy(self.backend.get(project, {}).get(identifier))


class BasicMemoryAdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.backend = {}
        self.clients = []
        self.fail_on = None
        self.configs = []
        self.state_directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.state_directory.cleanup)
        self.state_root = str(Path(self.state_directory.name).resolve())
        self.environment = patch.dict(
            os.environ,
            {"SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT": self.state_root},
        )
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def factory(self, config, provider_call):
        self.configs.append(copy.deepcopy(config))
        self.assert_no_provider_callback(provider_call)
        client = FakeBasicMemory(self.backend, fail_on=self.fail_on)
        self.clients.append(client)
        return client

    def assert_no_provider_callback(self, provider_call):
        self.assertIsNotNone(provider_call)

    def request(self, operation, **overrides):
        return request_for(
            operation,
            arm_id="basic-memory",
            project_id="project-1",
            user_id=None,
            namespace_ref=BASIC_REF,
            **overrides,
        )

    def execute(self, operation, **overrides):
        return asyncio.run(
            basic_memory_adapter.execute(
                self.request(operation, **overrides),
                python_config(llm=None, embedding=None),
                client_factory=self.factory,
                version_getter=lambda name: "0.23.2" if name == "basic-memory" else None,
            )
        )

    def test_reset_is_idempotent_and_uses_only_an_owned_persistent_project_path(self) -> None:
        first = self.execute("reset")
        self.assertEqual(first["status"], "SUCCEEDED")
        # The anchor project is created before the arm project, so the arm
        # project is never the only one and the product permits its deletion.
        self.assertEqual(
            [call[0] for call in self.clients[0].calls],
            ["list_memory_projects", "create_memory_project", "create_memory_project"],
        )
        self.assertEqual(self.clients[0].calls[1][1], "shadowgraph-benchmark-reset-anchor")
        create_call = self.clients[0].calls[2]
        self.assertEqual(create_call[1], "project-1")
        self.assertTrue(os.path.isabs(create_call[2]))
        self.assertEqual(os.path.commonpath([self.state_root, create_call[2]]), self.state_root)
        self.assertEqual(create_call[3:], (False, None, "json"))
        self.assertEqual(first["operations"]["memoryReadOperations"], 1)
        self.assertEqual(first["operations"]["memoryWriteOperations"], 2)

        self.execute("persist")
        verified = self.execute(
            "verify",
            alternate_namespace={"projectId": "project-alt", "userId": None},
            alternate_namespace_ref=BASIC_ALT_REF,
        )
        self.assertEqual(verified["status"], "SUCCEEDED")

        second = self.execute("reset")
        self.assertEqual(second["status"], "SUCCEEDED")
        self.assertEqual(
            [call[0] for call in self.clients[-1].calls],
            ["list_memory_projects", "delete_project", "create_memory_project"],
        )
        self.assertEqual(self.clients[-1].calls[1][1:], ("project-1", True, None))
        self.assertEqual(self.clients[-1].calls[2][2], create_call[2])
        self.assertEqual(second["operations"]["memoryReadOperations"], 1)
        self.assertEqual(second["operations"]["memoryWriteOperations"], 2)

    def test_persist_and_fresh_verify_use_deterministic_title_exact_content_and_project_isolation(self) -> None:
        persisted = self.execute("persist")
        self.assertEqual(persisted["status"], "SUCCEEDED")
        note = next(
            value
            for key, value in self.backend["project-1"].items()
            if key != "__project_path__"
        )
        self.assertEqual(note["metadata"]["shadowgraph_content_sha256"], DECISION_SHA256)
        self.assertIn("Use the reversible option.", note["content"])
        verified = self.execute(
            "verify",
            alternate_namespace={"projectId": "project-alt", "userId": None},
            alternate_namespace_ref=BASIC_ALT_REF,
        )
        self.assertEqual(verified["status"], "SUCCEEDED")
        self.assertEqual(len(self.clients), 2)
        self.assertEqual(verified["operations"]["persistenceVerificationOperations"], 2)
        self.assertTrue(verified["result"]["isolationEvidence"]["verified"])

    def test_retrieve_is_project_scoped_local_and_uses_no_provider_or_outer_call(self) -> None:
        response = self.execute("retrieve")
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
        self.assertEqual(response["operations"]["embeddingCalls"], 0)
        self.assertEqual(response["operations"]["outerDecisionModelCalls"], 0)
        # The search names the local text index. The product default is
        # embedding-backed hybrid retrieval, which reaches a provider, so an arm
        # declaring no request classes must not inherit it.
        call = self.clients[0].calls[0]
        self.assertEqual(
            call,
            ("search_notes", "Choose the safe option.", "project-1", None, False, "json", "text"),
        )
        self.assertEqual(self.configs[0]["force_local"], True)
        self.assertEqual(self.configs[0]["auto_update"], False)
        self.assertEqual(self.configs[0]["logfire"], False)

    def test_user_namespace_is_rejected_not_synthetically_concatenated(self) -> None:
        bad = request_for(
            "retrieve",
            arm_id="basic-memory",
            project_id="project-1",
            user_id="user-1",
            namespace_ref="75204071178f4f86859625dbd29d6a233e9481b1203a048c8bdf23b848301041",
        )
        response = asyncio.run(
            basic_memory_adapter.execute(
                bad,
                python_config(llm=None, embedding=None),
                client_factory=self.factory,
                version_getter=lambda _name: "0.23.2",
            )
        )
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(self.clients, [])

    def test_storage_is_not_available_pending_a_task8_attribution_method(self) -> None:
        response = self.execute("persist")
        self.assertEqual(response["storage"]["status"], "NOT_AVAILABLE")
        self.assertIsNone(response["storage"]["bytes"])
        self.assertIsNone(response["storage"]["method"])
        self.assertNotIn("supplied", response["storage"]["reason"].lower())
        self.assertIn("Task 8", response["storage"]["reason"])

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symlink support")
    def test_project_path_rejects_an_interior_symlink_without_outside_writes(self) -> None:
        outside = Path(self.state_root).parent / f"{Path(self.state_root).name}-outside"
        outside.mkdir()
        self.addCleanup(lambda: __import__("shutil").rmtree(outside, ignore_errors=True))
        (Path(self.state_root) / "basic-memory-projects").symlink_to(
            outside,
            target_is_directory=True,
        )

        response = self.execute("reset")

        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
        self.assertEqual(list(outside.iterdir()), [])
        self.assertEqual(self.clients, [])

    def test_failed_native_call_is_counted_once_without_retry_or_path_leak(self) -> None:
        self.fail_on = "search_notes"
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "FAILED")
        self.assertEqual(response["operations"]["memoryReadOperations"], 1)
        self.assertEqual(len(self.clients[0].calls), 1)
        self.assertNotIn("private/path", str(response))


if __name__ == "__main__":
    unittest.main()


class BasicMemoryResetAnchorTests(BasicMemoryAdapterTests):
    """Regression cover for a defect the previous fake could not express.

    A fresh Basic Memory store holds no projects, so without an anchor the arm
    project is always the only one and the product refuses to delete it.
    Measured against basic-memory 0.23.2 under --network none: the delete failed
    on the first reset and again on the second.
    """

    def test_reset_deletes_an_arm_project_that_would_otherwise_be_the_only_one(self) -> None:
        self.assertEqual(self.execute("reset")["status"], "SUCCEEDED")

        # A second reset must genuinely delete and recreate rather than skip.
        self.clients[0].calls.clear()
        second = self.execute("reset")
        self.assertEqual(second["status"], "SUCCEEDED")
        performed = [call[0] for call in self.clients[-1].calls]
        self.assertIn("delete_project", performed)
        self.assertEqual(performed[-1], "create_memory_project")

    def test_the_anchor_holds_no_records(self) -> None:
        self.execute("reset")
        self.assertIn("shadowgraph-benchmark-reset-anchor", self.backend)
        anchor = dict(self.backend["shadowgraph-benchmark-reset-anchor"])
        anchor.pop("__project_path__", None)
        self.assertEqual(anchor, {}, "the anchor must never carry benchmark records")


class BasicMemoryProductShapeTests(unittest.TestCase):
    """The note shape the real product returns, not the one the fake returns.

    Measured from basic-memory 0.23.2, `read_note(output_format="json",
    include_frontmatter=False)` returns title/permalink/file_path/content/
    frontmatter. Three things differ from what logical_record looks for: the
    metadata is under `frontmatter` rather than `metadata`, the identifier is
    `title` rather than `name`, and the body comes back with a leading newline
    the writer did not supply. Before this was bridged, every retrieve and every
    verify failed CONTRACT_FAILURE against the real product while passing
    against the fake.
    """

    def product_note(self, record_id, encoded, digest):
        return {
            "title": record_id,
            "permalink": "p1/notes/%s" % record_id.lower(),
            "file_path": "notes/%s.md" % record_id,
            # The product prepends a newline to the stored body.
            "content": "\n%s" % encoded,
            "frontmatter": {
                "title": record_id,
                "type": "note",
                "shadowgraph_record_id": record_id,
                "shadowgraph_record_type": "decision",
                "shadowgraph_content_sha256": digest,
            },
        }

    def test_a_product_shaped_note_becomes_one_logical_record(self) -> None:
        content = {"decisionId": "decision-a", "choiceId": "choice-a"}
        digest = python_runtime.record_content_sha256(content)
        encoded = python_runtime.encode_content(content)

        records = basic_memory_adapter._one_native_record(
            self.product_note("REC-1", encoded, digest)
        )

        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["id"], "REC-1")
        self.assertEqual(records[0]["type"], "decision")
        self.assertEqual(records[0]["content"], content)

    def test_a_body_that_stripping_would_alter_is_rejected_by_its_own_digest(self) -> None:
        # Whitespace is stripped blind because the product adds it. That is only
        # safe because the digest in the frontmatter catches any case where
        # stripping changed the meaning.
        content = {"decisionId": "decision-a"}
        encoded = python_runtime.encode_content(content)
        wrong_digest = "0" * 64

        with self.assertRaises(ContractError):
            basic_memory_adapter._one_native_record(
                self.product_note("REC-1", encoded, wrong_digest)
            )

    def test_a_search_hit_is_read_back_by_its_title(self) -> None:
        # Persist writes the record id as the note title, so that is the
        # identifier a hit is read back with.
        self.assertEqual(
            basic_memory_adapter._search_hit_identifier(
                {"title": "REC-1", "entity": "p1/notes/rec-1"}
            ),
            "REC-1",
        )
        # Falls back to the permalink when a hit omits its title.
        self.assertEqual(
            basic_memory_adapter._search_hit_identifier({"entity": "p1/notes/rec-1"}),
            "p1/notes/rec-1",
        )
        with self.assertRaises(ContractError):
            basic_memory_adapter._search_hit_identifier({"score": 1})


class BasicMemoryRetrieveReadBackTests(BasicMemoryAdapterTests):
    """Retrieve must read each search hit back before it can build a record.

    Measured on basic-memory 0.23.2: a search hit carries the note body but its
    metadata is only `{"note_type": "note"}` - none of the shadowgraph
    frontmatter that identifies a record. So a hit cannot become a logical
    record on its own, however much of the body it happens to carry.

    Nothing covered this until now, because no test persisted a record before
    retrieving one: with an empty store the search returns nothing and the
    read-back loop never runs.
    """

    def test_a_persisted_record_comes_back_through_a_per_hit_read(self) -> None:
        self.execute("reset")
        self.execute("persist")

        self.clients[-1].calls.clear()
        response = self.execute("retrieve")
        self.assertEqual(response["status"], "SUCCEEDED")

        records = response["result"]["nativeContext"]
        self.assertEqual(len(records), 1, "the persisted record must be returned")
        self.assertEqual(records[0]["type"], "decision")
        self.assertIn("decisionId", records[0]["content"])

        # One search plus one read per hit, and the read is what supplies the
        # frontmatter the hit lacks.
        performed = [call[0] for call in self.clients[-1].calls]
        self.assertEqual(performed, ["search_notes", "read_note"])
        self.assertEqual(response["operations"]["memoryReadOperations"], 2)
        self.assertEqual(response["operations"]["embeddingCalls"], 0)
        self.assertEqual(response["operations"]["internalMemoryModelCalls"], 0)
