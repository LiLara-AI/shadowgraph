"""Behavioural demonstration that the Mem0 arm executes a real benchmark unit.

Mem0 has never executed anything. Its client factory raised `RuntimeUnavailable`
by construction, and `v11-adapter-runtime-blockers` records why: Mem0 2.0.19
builds `OpenAI(api_key, base_url)` directly inside `OpenAILLM.__init__` and
`OpenAIEmbedding.__init__`, with no `http_client` argument and no retry setting
reachable from configuration. So nothing could observe a request, the SDK's
default of two retries stood, and the adapter's declared `automatic_retries: 0`
described nothing. That was D1: may a factory rebind the constructed clients?

This demonstrates the answer working. Not with a fake: the real pinned Mem0,
against the real pinned Ollama, through a real loopback proxy that counts what
crosses it, running the real adapter through the real `python_host` wrapper with
its gates and its network fence applied.

The structure is the one the ACL demonstration established, because a success on
its own proves very little. Every claim is paired with the thing that would look
identical if it were false:

  * The count the adapter reports is checked against an *independent* count taken
    at the proxy. A ledger taken at the call site would agree with itself by
    construction; two counts that can disagree are the only kind worth taking.
  * Persistence is verified from a process that did not write it, because a
    store read back in the writing process proves memory, not persistence.
  * Isolation is checked against a namespace that was never written, because a
    retrieval that finds nothing proves nothing unless the same call in the
    owning namespace finds something.
  * Retry control is checked by counting requests, not by reading configuration:
    `max_retries=0` in a config object is a claim, and one request per call on
    the wire is an observation.

Each operation runs in its own forked process, which is what the executor does -
one container per invocation - and is what makes the verify step meaningful. It
is also required rather than merely faithful: qdrant-client's local mode holds a
file lock for the life of the client, so two clients on one store in one process
would collide.
"""

from __future__ import annotations

import copy
import http.server
import io
import json
import os
import socket
import sys
import threading
import traceback
import urllib.request
from datetime import datetime, timezone

import python_host
from envelope import namespace_ref_for, record_content_sha256

SCHEMA = "shadowgraph.v11.precondition-evidence"
VERSION = 1
ARM_ID = "mem0-oss"
PRECONDITION = "the Mem0 arm executes a metered, retry-free benchmark unit"

RUN_ID = "demonstration-run"
SCENARIO_ID = "scenario-1"
PHASE = "A"
PROJECT_ID = "project-1"
USER_ID = "user-1"
ALTERNATE = {"projectId": "project-1", "userId": "user-2"}
RECORD_ID = f"decision:{len(ARM_ID)}:{ARM_ID}:10:{SCENARIO_ID}:1:0:{len(PHASE)}:{PHASE}"

DECISION_CONTENT = {
    "decisionId": "decision-a",
    "choiceId": "choice-a",
    "recalledAlternativeIds": ["alternative-a"],
    "recalledRejectionReasonIds": ["reason-a"],
    "constraintIdsAddressed": ["constraint-a"],
    "evidenceIdsCited": ["evidence-a"],
    "riskIdsRecognized": ["risk-a"],
    "reviewTriggerIds": ["trigger-a"],
    "changedFactDetected": False,
    "changedFactId": None,
    "recommendation": "Use the reversible option.",
    "failedAttemptIdsAvoided": [],
    "failedAttemptReasonIdsCited": [],
    "memoryProjectId": PROJECT_ID,
    "memoryUserId": USER_ID,
}

STEPS: list[dict] = []


def step(name: str, passed: bool, detail: str) -> None:
    STEPS.append({"step": name, "outcome": "PASS" if passed else "FAIL", "detail": detail})
    print(f"[{'PASS' if passed else 'FAIL'}] {name}: {detail}", file=sys.stderr)


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} must be set for the demonstration to run")
    return value


# --------------------------------------------------------------------- meter

class _Meter(http.server.BaseHTTPRequestHandler):
    """The provider meter, reduced to what this demonstration needs of it.

    A loopback proxy that forwards to the pinned model service and counts every
    request per route. It is not the harness's meter and does not pretend to be;
    it is a second, independent observer, which is the only thing that makes the
    adapter's own count worth reporting.
    """

    upstream = ""
    counts: dict = {}
    lock = threading.Lock()

    def log_message(self, *_args) -> None:  # noqa: D102 - silence the default access log
        return

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler's spelling
        route, _, tail = self.path.lstrip("/").partition("/")
        with _Meter.lock:
            _Meter.counts[route] = _Meter.counts.get(route, 0) + 1
        body = self.rfile.read(int(self.headers.get("content-length") or 0))
        request = urllib.request.Request(
            f"{_Meter.upstream}/{tail}",
            data=body,
            headers={"content-type": "application/json"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=180) as answer:
                payload = answer.read()
                status = answer.status
        except Exception as error:  # noqa: BLE001 - reported to the caller as a body
            payload = json.dumps({"error": {"message": str(error)}}).encode("utf-8")
            status = 502
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def start_meter(upstream: str) -> tuple[http.server.ThreadingHTTPServer, int]:
    _Meter.upstream = upstream.rstrip("/")
    _Meter.counts = {}
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Meter)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def metered_counts() -> dict:
    with _Meter.lock:
        return dict(_Meter.counts)


# ------------------------------------------------------------------ requests

def correlation() -> dict:
    return {
        "runId": RUN_ID,
        "armId": ARM_ID,
        "scenarioId": SCENARIO_ID,
        "repetition": 0,
        "phase": PHASE,
    }


def request_for(operation: str) -> dict:
    namespace = {"projectId": PROJECT_ID, "userId": USER_ID}
    request = {
        "schemaVersion": 1,
        "operation": operation,
        "runId": RUN_ID,
        "attemptId": f"attempt-{operation}",
        "phase": PHASE,
        "armId": ARM_ID,
        "scenarioId": SCENARIO_ID,
        "repetition": 0,
        "namespace": namespace,
        "namespaceRef": namespace_ref_for(correlation(), namespace),
        "payload": {},
    }
    if operation == "retrieve":
        request["payload"] = {
            "query": {"scenarioId": SCENARIO_ID, "task": "Choose the safe option."}
        }
    elif operation == "persist":
        request["payload"] = {
            "record": {
                "id": RECORD_ID,
                "type": "decision",
                "content": copy.deepcopy(DECISION_CONTENT),
            }
        }
    elif operation == "verify":
        request["payload"] = {
            "expectedRecord": {
                "id": RECORD_ID,
                "type": "decision",
                "contentSha256": record_content_sha256(DECISION_CONTENT),
            },
            "alternateNamespace": copy.deepcopy(ALTERNATE),
            "alternateNamespaceRef": namespace_ref_for(correlation(), ALTERNATE),
            "expectedAbsentRecord": {
                "id": RECORD_ID,
                "type": "decision",
                "contentSha256": record_content_sha256(DECISION_CONTENT),
            },
        }
    return request


# ------------------------------------------------------------------ execution

def run_operation(operation: str, routes: dict, models: dict, state_root: str) -> dict:
    """Run one operation in its own process, the way the executor does.

    A fork rather than a thread, and a fresh process rather than a reused
    client, because that is what the container executor gives each invocation -
    and because a store read back by the process that wrote it would demonstrate
    memory rather than persistence.
    """
    read_fd, write_fd = os.pipe()
    child = os.fork()
    if child == 0:  # pragma: no cover - the child never returns
        code = 3
        try:
            os.close(read_fd)
            os.environ["SHADOWGRAPH_PYTHON_ADAPTER_STATE_ROOT"] = state_root
            wrapper = {
                "schemaVersion": 2,
                "adapterId": ARM_ID,
                "request": request_for(operation),
                "providerRoutes": routes,
                "providerModels": models,
            }
            output = io.StringIO()
            code = python_host.process_stream(
                io.StringIO(json.dumps(wrapper) + "\n"), output
            )
            with os.fdopen(write_fd, "w", encoding="utf-8") as handle:
                handle.write(output.getvalue())
            write_fd = -1
        except BaseException:  # noqa: BLE001
            traceback.print_exc()
        finally:
            if write_fd != -1:
                os.close(write_fd)
            os._exit(0 if code == 0 else 4)

    os.close(write_fd)
    with os.fdopen(read_fd, "r", encoding="utf-8") as handle:
        raw = handle.read()
    _, status = os.waitpid(child, 0)
    if os.WEXITSTATUS(status) != 0 or not raw.strip():
        raise RuntimeError(f"{operation} produced no envelope (exit {os.WEXITSTATUS(status)})")
    return json.loads(raw)


def demonstrate() -> dict:
    upstream = required_environment("SHADOWGRAPH_MODEL_ENDPOINT")
    state_root = os.path.realpath(required_environment("SHADOWGRAPH_STATE_ROOT"))
    os.makedirs(state_root, exist_ok=True)
    llm_model = required_environment("SHADOWGRAPH_LLM_MODEL")
    embedding_model = required_environment("SHADOWGRAPH_EMBEDDING_MODEL")
    embedding_dimension = int(required_environment("SHADOWGRAPH_EMBEDDING_DIMENSION"))

    server, port = start_meter(upstream)
    routes = {
        "internal_memory_llm": f"http://127.0.0.1:{port}/llm",
        "embedding": f"http://127.0.0.1:{port}/embed",
    }
    models = {
        "internal_memory_llm": {"modelId": llm_model, "embeddingDimension": None},
        "embedding": {"modelId": embedding_model, "embeddingDimension": embedding_dimension},
    }
    report = {
        "schema": SCHEMA,
        "version": VERSION,
        "armId": ARM_ID,
        "precondition": PRECONDITION,
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "models": models,
        "operations": {},
    }

    try:
        before = metered_counts()
        reset = run_operation("reset", routes, models, state_root)
        report["operations"]["reset"] = reset
        step(
            "reset-succeeds-against-the-real-store",
            reset["status"] == "SUCCEEDED",
            reset["status"]
            + ("" if reset["failure"] is None else f": {reset['failure']['cause']}"),
        )

        before = metered_counts()
        persist = run_operation("persist", routes, models, state_root)
        after = metered_counts()
        embedded = after.get("embed", 0) - before.get("embed", 0)
        chatted = after.get("llm", 0) - before.get("llm", 0)
        report["operations"]["persist"] = persist
        report["meteredOnPersist"] = {"embedding": embedded, "internal_memory_llm": chatted}
        step(
            "persist-succeeds-and-really-embeds",
            persist["status"] == "SUCCEEDED" and embedded > 0,
            f"{persist['status']} with {embedded} embedding request(s) observed at the proxy"
            + ("" if persist["failure"] is None else f": {persist['failure']['cause']}"),
        )
        # Each of these is conditioned on the operation having succeeded. Nought
        # equals nought, so a comparison of counts is satisfied most easily by an
        # arm that never ran - which is exactly what the first version of this
        # probe reported when the factory refused: three green steps under four
        # red ones.
        step(
            "the-adapter-ledger-agrees-with-an-independent-count",
            persist["status"] == "SUCCEEDED"
            and embedded > 0
            and persist["operations"]["embeddingCalls"] == embedded
            and persist["operations"]["internalMemoryModelCalls"] == chatted,
            f"adapter reported {persist['operations']['embeddingCalls']} embedding and "
            f"{persist['operations']['internalMemoryModelCalls']} chat call(s); the proxy saw "
            f"{embedded} and {chatted}",
        )
        step(
            "no-transparent-retry-reaches-the-endpoint",
            persist["status"] == "SUCCEEDED"
            and embedded > 0
            and embedded == persist["operations"]["embeddingCalls"],
            "one request on the wire per reported call; the SDK default of two retries "
            "would have made these disagree",
        )
        step(
            "persist-with-infer-false-asks-no-chat-model",
            persist["status"] == "SUCCEEDED" and chatted == 0,
            f"{chatted} chat request(s) observed, and the adapter requires zero",
        )

        verify = run_operation("verify", routes, models, state_root)
        report["operations"]["verify"] = verify
        evidence = verify["result"]["persistenceEvidence"]
        isolation = verify["result"]["isolationEvidence"]
        step(
            "a-process-that-did-not-write-it-finds-the-record",
            verify["status"] == "SUCCEEDED"
            and evidence is not None
            and evidence["verified"] is True,
            f"{verify['status']}; persistence "
            + ("verified" if evidence and evidence["verified"] else "not verified")
            + ("" if verify["failure"] is None else f": {verify['failure']['cause']}"),
        )
        step(
            "the-other-user-namespace-does-not-see-it",
            isolation is not None and isolation["verified"] is True,
            "isolation "
            + ("verified" if isolation and isolation["verified"] else "not verified")
            + f" against {ALTERNATE}",
        )

        before = metered_counts()
        retrieve = run_operation("retrieve", routes, models, state_root)
        after = metered_counts()
        report["operations"]["retrieve"] = retrieve
        report["meteredOnRetrieve"] = {
            "embedding": after.get("embed", 0) - before.get("embed", 0),
            "internal_memory_llm": after.get("llm", 0) - before.get("llm", 0),
        }
        context = retrieve["result"]["nativeContext"]
        step(
            "retrieve-returns-the-stored-decision-through-a-real-search",
            retrieve["status"] == "SUCCEEDED" and len(context) > 0,
            f"{retrieve['status']} with {len(context)} native record(s), "
            f"{report['meteredOnRetrieve']['embedding']} embedding request(s)"
            + ("" if retrieve["failure"] is None else f": {retrieve['failure']['cause']}"),
        )
        step(
            "retrieve-ledger-also-agrees-with-the-proxy",
            retrieve["status"] == "SUCCEEDED"
            and report["meteredOnRetrieve"]["embedding"] > 0
            and retrieve["operations"]["embeddingCalls"]
            == report["meteredOnRetrieve"]["embedding"]
            and retrieve["operations"]["internalMemoryModelCalls"]
            == report["meteredOnRetrieve"]["internal_memory_llm"],
            f"adapter {retrieve['operations']['embeddingCalls']}/"
            f"{retrieve['operations']['internalMemoryModelCalls']}, proxy "
            f"{report['meteredOnRetrieve']['embedding']}/"
            f"{report['meteredOnRetrieve']['internal_memory_llm']}",
        )
    finally:
        server.shutdown()
        server.server_close()

    report["meteredTotals"] = metered_counts()
    return report


def main() -> int:
    output_path = required_environment("SHADOWGRAPH_DEMONSTRATION_OUTPUT")
    try:
        report = demonstrate()
    except Exception:  # noqa: BLE001 - a failed demonstration is a recorded outcome
        traceback.print_exc()
        report = {
            "schema": SCHEMA,
            "version": VERSION,
            "armId": ARM_ID,
            "precondition": PRECONDITION,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "fatal": True,
        }
    report["steps"] = STEPS
    report["outcome"] = (
        "PASS"
        if STEPS and all(entry["outcome"] == "PASS" for entry in STEPS) and not report.get("fatal")
        else "FAIL"
    )
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")
    print(json.dumps(report, indent=2, sort_keys=True))
    return 0 if report["outcome"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
