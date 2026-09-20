"""Behavioural demonstration that no measured arm can reach an unpinned model.

The benchmark pins two model weights by digest and meters every internal call
through a loopback proxy. Neither fact was true of the runtime the arms actually
run in. Four paths reach a model the lock does not name, and the meter cannot
see any of them:

  * Basic Memory sets `semantic_search_enabled` by default to whether `fastembed`
    and `sqlite_vec` are importable. Both are, because Basic Memory itself
    requires fastembed and all four arms share one site-packages. So the arm the
    definition records as making no provider call embeds and searches every note
    with its own `bge-small-en-v1.5`, downloaded on first use.
  * Mem0's Qdrant store creates a `bm25` sparse slot on every new collection and
    pulls `Qdrant/bm25` on the write path, swallowing failure into a warning.
  * LiteLLM downloads its model-cost map at import.
  * Cognee resolves an embedding tokenizer from HuggingFace, and its documented
    fallback resolves one from tiktoken's CDN.

Two frozen rules already forbid this. `providerMetering.rule` requires internal
LLM and embedding calls to be metered through the local proxy, and
`commonExecution.sameConfigurationRule` makes a result MEASURED only when every
arm used the same embedding id. An arm embedding locally with a model of its own
satisfies neither, so this is conformance work and not an amendment.

The demonstration is paired, for the same reason the ACL one is: a refusal alone
proves very little, because a probe that never reached the fetch would look
exactly like one that was correctly stopped. So each negative is shown against
its positive. First, with the gate absent, the arm is shown to *want* the
unpinned model - Basic Memory reporting semantic search on, and the BM25 encoder
reaching for a non-loopback address. Then, with the production gate applied, the
same calls are shown to fail with nothing on the wire, while a loopback listener
still answers and Mem0 still writes.

Nothing here is mocked in the library. The gate under test is imported from
`python_host` rather than restated, so what is demonstrated is what the harness
actually applies. The socket recorder wraps the real socket layer to observe
attempts, and refuses non-loopback addresses itself so that a negative control
cannot become a download.
"""

from __future__ import annotations

import contextlib
import ipaddress
import json
import os
import socket
import sys
import traceback
from datetime import datetime, timezone

import python_host

SCHEMA = "shadowgraph.v11.precondition-evidence"
VERSION = 1
ARM_ID = "all-python-arms"
PRECONDITION = "no measured arm can reach an unpinned model"

BM25_MODEL = "Qdrant/bm25"
BASIC_MEMORY_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5"

STEPS: list[dict] = []


def step(name: str, passed: bool, detail: str) -> None:
    STEPS.append({"step": name, "outcome": "PASS" if passed else "FAIL", "detail": detail})
    print(f"[{'PASS' if passed else 'FAIL'}] {name}: {detail}", file=sys.stderr)


def required_environment(name: str) -> str:
    value = os.environ.get(name)
    if not value:
        raise RuntimeError(f"{name} must be set for the demonstration to run")
    return value


def _loopback(host) -> bool:
    if isinstance(host, bytes):
        try:
            host = host.decode("ascii")
        except UnicodeDecodeError:
            return False
    if not isinstance(host, str) or not host:
        return False
    if host in ("localhost", "localhost.localdomain"):
        return True
    try:
        return ipaddress.ip_address(host.split("%", 1)[0]).is_loopback
    except ValueError:
        return False


class Recorder:
    """Observes every outbound attempt, and lets none of them leave.

    Installed *under* whatever is being demonstrated. In the negative control it
    is the only thing standing between the library and a real download, so it
    refuses as well as records: the point is to observe that the attempt was
    made, never to make it.
    """

    def __init__(self) -> None:
        self.attempts: list[str] = []

    @contextlib.contextmanager
    def installed(self):
        original_connect = socket.socket.connect
        original_create_connection = socket.create_connection
        original_getaddrinfo = socket.getaddrinfo

        def record(where: str, host) -> None:
            rendered = f"{where}:{host!r}"
            if not _loopback(host):
                self.attempts.append(rendered)

        def guarded_connect(self_socket, address):
            host = address[0] if isinstance(address, tuple) and address else address
            record("connect", host)
            if not _loopback(host):
                raise OSError("recorder refused a non-loopback connection")
            return original_connect(self_socket, address)

        def guarded_create_connection(address, *args, **kwargs):
            host = address[0] if isinstance(address, tuple) and address else address
            record("create_connection", host)
            if not _loopback(host):
                raise OSError("recorder refused a non-loopback connection")
            return original_create_connection(address, *args, **kwargs)

        def guarded_getaddrinfo(host, *args, **kwargs):
            record("getaddrinfo", host)
            if not _loopback(host):
                raise OSError("recorder refused a non-loopback lookup")
            return original_getaddrinfo(host, *args, **kwargs)

        socket.socket.connect = guarded_connect
        socket.create_connection = guarded_create_connection
        socket.getaddrinfo = guarded_getaddrinfo
        try:
            yield self
        finally:
            socket.socket.connect = original_connect
            socket.create_connection = original_create_connection
            socket.getaddrinfo = original_getaddrinfo


@contextlib.contextmanager
def environment(values: dict, *, remove: tuple = ()):
    previous = {}
    for name in remove:
        previous[name] = os.environ.pop(name, None)
    for name, value in values.items():
        previous.setdefault(name, os.environ.get(name))
        os.environ[name] = value
    try:
        yield
    finally:
        for name, value in previous.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def basic_memory_configuration() -> dict:
    """Resolve Basic Memory's own configuration from the current environment."""
    import importlib

    module = importlib.import_module("basic_memory.config_models")
    module = importlib.reload(module)
    config = module.BasicMemoryConfig()
    return {
        "semanticSearchEnabled": bool(config.semantic_search_enabled),
        "semanticEmbeddingProvider": config.semantic_embedding_provider,
        "semanticEmbeddingModel": config.semantic_embedding_model,
        "rerankerEnabled": bool(config.reranker_enabled),
    }


def demonstrate() -> dict:
    gates = {name: value for name, value in python_host.GATES.items()}
    report = {
        "schema": SCHEMA,
        "version": VERSION,
        "armId": ARM_ID,
        "precondition": PRECONDITION,
        "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "gates": gates,
    }

    # ---------------------------------------------------------------- negative
    # What the runtime does when nobody stops it.

    ungated = basic_memory_configuration()
    report["basicMemoryWithoutGate"] = ungated
    step(
        "basic-memory-default-embeds-with-an-unpinned-model",
        ungated["semanticSearchEnabled"] is True
        and ungated["semanticEmbeddingProvider"] == "fastembed",
        f"semantic search {ungated['semanticSearchEnabled']} via "
        f"{ungated['semanticEmbeddingProvider']}/{ungated['semanticEmbeddingModel']}, "
        "which model-weights.lock.json does not pin",
    )

    control = Recorder()
    control_error = None
    with control.installed():
        try:
            from fastembed import SparseTextEmbedding

            SparseTextEmbedding(model_name=BM25_MODEL)
        except Exception as error:  # noqa: BLE001 - the attempt is the observation
            control_error = f"{type(error).__name__}: {error}"
    report["negativeControl"] = {
        "model": BM25_MODEL,
        "attempts": control.attempts,
        "error": control_error,
    }
    step(
        "without-the-fence-the-bm25-fetch-leaves-the-process",
        len(control.attempts) > 0,
        f"{len(control.attempts)} non-loopback attempt(s) recorded: {control.attempts[:3]}",
    )

    # ---------------------------------------------------------------- positive
    # The same calls, with the gate the harness actually applies.

    with environment(gates):
        gated = basic_memory_configuration()
    report["basicMemoryWithGate"] = gated
    step(
        "the-gate-turns-basic-memory-semantic-search-off",
        gated["semanticSearchEnabled"] is False and gated["rerankerEnabled"] is False,
        f"semantic search {gated['semanticSearchEnabled']}, reranker {gated['rerankerEnabled']}",
    )

    for label, model, importer in (
        ("bm25", BM25_MODEL, "sparse"),
        ("basic-memory-embedding", BASIC_MEMORY_EMBEDDING_MODEL, "dense"),
    ):
        observer = Recorder()
        refused = None
        with observer.installed(), python_host._loopback_only_network():
            try:
                if importer == "sparse":
                    from fastembed import SparseTextEmbedding

                    SparseTextEmbedding(model_name=model)
                else:
                    from fastembed import TextEmbedding

                    TextEmbedding(model_name=model)
            except Exception as error:  # noqa: BLE001 - refusal is the outcome
                refused = f"{type(error).__name__}: {error}"
        report.setdefault("fenced", {})[label] = {
            "model": model,
            "attempts": observer.attempts,
            "error": refused,
        }
        step(
            f"the-fence-refuses-the-{label}-fetch-with-nothing-on-the-wire",
            refused is not None and not observer.attempts,
            f"refused with {refused}; {len(observer.attempts)} attempt(s) reached the socket layer",
        )

    # The fence has to be a fence and not a power cut: everything a measured unit
    # legitimately needs - the provider meter, the pinned model endpoint, the
    # pinned graph database - answers on loopback.
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    listener.bind(("127.0.0.1", 0))
    listener.listen(1)
    port = listener.getsockname()[1]
    loopback_error = None
    try:
        with python_host._loopback_only_network():
            client = socket.create_connection(("127.0.0.1", port), timeout=5)
            client.close()
            accepted, _ = listener.accept()
            accepted.close()
    except Exception as error:  # noqa: BLE001
        loopback_error = f"{type(error).__name__}: {error}"
    finally:
        listener.close()
    step(
        "loopback-still-answers-inside-the-fence",
        loopback_error is None,
        loopback_error or f"connected to 127.0.0.1:{port} and was accepted",
    )

    # And Mem0 still writes. The BM25 slot is created either way; what the fence
    # removes is the sparse vector that would have been computed with an unpinned
    # model, which is the degradation Mem0 itself documents for an install
    # without `[extras]`.
    mem0_error = None
    mem0_report = {}
    try:
        with environment(gates), python_host._loopback_only_network():
            from mem0.vector_stores.qdrant import Qdrant

            store = Qdrant(
                collection_name="shadowgraph-fence-probe",
                embedding_model_dims=768,
                client=None,
                host=None,
                port=None,
                path=os.path.join(os.getcwd(), "qdrant-fence-probe"),
                url=None,
                api_key=None,
                on_disk=False,
            )
            store.insert(
                vectors=[[0.01] * 768],
                payloads=[{"data": "a decision the benchmark recorded"}],
                ids=["11111111-1111-5111-8111-111111111111"],
            )
            found = store.get(vector_id="11111111-1111-5111-8111-111111111111")
            mem0_report = {
                "hasBm25Slot": bool(store._has_bm25_slot),
                "bm25EncoderAvailable": store._get_bm25_encoder() is not None,
                "storedId": None if found is None else str(found.id),
            }
    except Exception as error:  # noqa: BLE001
        mem0_error = f"{type(error).__name__}: {error}"
        traceback.print_exc()
    report["mem0LocalWrite"] = {"error": mem0_error, **mem0_report}
    step(
        "mem0-writes-locally-under-the-fence-with-bm25-unavailable",
        mem0_error is None
        and mem0_report.get("storedId") is not None
        and mem0_report.get("bm25EncoderAvailable") is False,
        mem0_error
        or f"stored {mem0_report.get('storedId')} with the BM25 encoder unavailable",
    )

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
