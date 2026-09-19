"""Offline loopback proof for pinned Cognee embedding transport behavior.

This is a diagnostic-only fault injection, not a benchmark unit. It drives one
selected OpenAI-compatible embedding root operation against a 127.0.0.1 HTTP
server under Docker --network none. It never contacts a provider or starts a
benchmark service.
"""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import sys
from datetime import datetime, timezone
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, "/runtime/site")
sys.path.insert(0, "/opt/shadowgraph/adapters")

EXPECTED_EMBEDDING_MODEL = "nomic-embed-text:v1.5"
AMENDMENT_006_SHA256 = "3bc9308a19e44ecc06d15dc0144239aa907b49cf897a11f9fab7cfe116966760"


def _headers(lines: list[str]) -> dict[str, str]:
    return {
        line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip()
        for line in lines[1:]
        if ":" in line
    }


async def demonstrate() -> dict:
    import cognee_adapter
    from cognee.infrastructure.databases.vector.embeddings.OpenAICompatibleEmbeddingEngine import (
        OpenAICompatibleEmbeddingEngine,
    )

    requests: list[dict] = []
    outer_retry_scheduled = False

    async def handler(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        try:
            lines = (await reader.readuntil(b"\r\n\r\n")).decode("iso-8859-1").split("\r\n")
            headers = _headers(lines)
            content_length = int(headers["content-length"])
            body = json.loads((await reader.readexactly(content_length)).decode("utf-8"))
            requests.append({
                "path": lines[0].split(" ")[1],
                "retryOrdinal": int(headers.get("x-stainless-retry-count", "0")),
                "body": body,
            })
            response = json.dumps({
                "error": {"message": "offline transient fault", "type": "server_error"}
            }).encode("utf-8")
            writer.write(
                b"HTTP/1.1 500 Internal Server Error\r\n"
                b"content-type: application/json\r\n"
                + f"content-length: {len(response)}\r\n\r\n".encode("ascii")
                + response
            )
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    server = await asyncio.start_server(handler, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    try:
        runtime = cognee_adapter._runtime_config(
            {
                "internal_memory_llm": "http://127.0.0.1:1/v1",
                "embedding": f"http://127.0.0.1:{port}/v1",
            },
            {
                "internal_memory_llm": {"modelId": "qwen2.5:7b"},
                "embedding": {"modelId": EXPECTED_EMBEDDING_MODEL, "embeddingDimension": 768},
            },
            "cognee-embedding-taxonomy-state",
        )
        selected = runtime["embedding_config"]
        with patch.object(
            OpenAICompatibleEmbeddingEngine,
            "get_tokenizer",
            lambda _self: SimpleNamespace(count_tokens=lambda _text: 1),
        ):
            engine = OpenAICompatibleEmbeddingEngine(
                model=selected["model"],
                dimensions=selected["dimensions"],
                endpoint=selected["endpoint"],
                api_key="",
            )

        async def abort_outer_sleep(_delay: float) -> None:
            nonlocal outer_retry_scheduled
            outer_retry_scheduled = True
            raise asyncio.CancelledError()

        try:
            with patch.object(engine.embed_text.retry, "sleep", abort_outer_sleep):
                await engine.embed_text(["offline fault injection"])
        except BaseException:
            pass

        assert importlib.metadata.version("cognee") == "1.5.3"
        assert type(engine).__name__ == "OpenAICompatibleEmbeddingEngine"
        assert "max_retries" not in engine.__init__.__code__.co_varnames
        assert selected["model"] == EXPECTED_EMBEDDING_MODEL
        assert selected["dimensions"] == 768
        assert selected["endpoint"] == f"http://127.0.0.1:{port}/v1"
        assert len(requests) == 3
        assert [request["path"] for request in requests] == ["/v1/embeddings"] * 3
        assert [request["retryOrdinal"] for request in requests] == [0, 1, 2]
        assert [request["body"].get("model") for request in requests] == [EXPECTED_EMBEDDING_MODEL] * 3
        assert outer_retry_scheduled is True

        return {
            "schema": "shadowgraph.v11.native-attempt-loopback-report",
            "version": 1,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "amendment006Sha256": AMENDMENT_006_SHA256,
            "armId": "cognee",
            "requestClass": "embedding",
            "category": "B",
            "package": {"name": "cognee", "version": "1.5.3"},
            "modelId": EXPECTED_EMBEDDING_MODEL,
            "network": "loopback-only",
            "rootOperationInvocations": 1,
            "wireAttempts": [
                {
                    "ordinal": index + 1,
                    "path": request["path"],
                    "outcome": "FAILED",
                    "modelId": EXPECTED_EMBEDDING_MODEL,
                    "retryOrdinal": request["retryOrdinal"],
                    "responseFormat": None,
                }
                for index, request in enumerate(requests)
            ],
            "taxonomy": {"A": False, "B": True, "C": False, "D": False, "E": False},
            "allAttemptsMetered": True,
            "providerUsageAccounting": "metered-complete-or-fail-closed",
            "modelEndpointPinned": True,
            "harnessOperationReruns": 0,
        }
    finally:
        server.close()
        await server.wait_closed()


def main() -> int:
    print(json.dumps(asyncio.run(demonstrate()), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
