"""Loopback-only taxonomy probe for pinned Cognee 1.5.3.

This is an offline adversarial probe, not a benchmark unit and not provider
traffic.  It drives the selected adapter configuration into Cognee's public
configuration API, returns malformed structured output from a local OpenAI-like
loopback endpoint, and reports the exact request multiplicity seen on the wire.
"""

from __future__ import annotations

import asyncio
import importlib
import importlib.metadata
import json
import sys
from datetime import datetime, timezone
from unittest.mock import patch

sys.path.insert(0, "/opt/shadowgraph/adapters")

from python_host import _loopback_only_network, _sanitized_environment
from python_runtime import ProviderCalls

import cognee_adapter


EXPECTED_MODEL = "openai/qwen2.5:7b"
EXPECTED_WIRE_MODEL = "qwen2.5:7b"
EXPECTED_EMBEDDING_MODEL = "nomic-embed-text:v1.5"
AMENDMENT_006_SHA256 = "3bc9308a19e44ecc06d15dc0144239aa907b49cf897a11f9fab7cfe116966760"


async def _http_handler(reader, writer, requests):
    try:
        header_bytes = await reader.readuntil(b"\r\n\r\n")
        headers = header_bytes.decode("iso-8859-1").split("\r\n")
        header_map = {
            line.split(":", 1)[0].strip().lower(): line.split(":", 1)[1].strip()
            for line in headers[1:]
            if ":" in line
        }
        content_length = next(
            int(line.split(":", 1)[1].strip())
            for line in headers[1:]
            if line.lower().startswith("content-length:")
        )
        requests.append({
            "path": headers[0].split(" ")[1],
            "retryOrdinal": int(header_map.get("x-stainless-retry-count", "0")),
            "body": json.loads((await reader.readexactly(content_length)).decode("utf-8")),
        })
        body = json.dumps({"choices": [{"message": {"content": "{}"}}]}).encode("utf-8")
        writer.write(
            b"HTTP/1.1 200 OK\r\n"
            + b"content-type: application/json\r\n"
            + f"content-length: {len(body)}\r\n\r\n".encode("ascii")
            + body
        )
        await writer.drain()
    finally:
        writer.close()
        await writer.wait_closed()


async def demonstrate() -> dict:
    requests = []
    outer_retry_scheduled = False
    server = await asyncio.start_server(
        lambda reader, writer: _http_handler(reader, writer, requests),
        "127.0.0.1",
        0,
    )
    port = server.sockets[0].getsockname()[1]
    try:
        models = {
            "internal_memory_llm": {"modelId": "qwen2.5:7b"},
            "embedding": {"modelId": EXPECTED_EMBEDDING_MODEL, "embeddingDimension": 768},
        }
        routes = {
            "internal_memory_llm": f"http://127.0.0.1:{port}/v1",
            "embedding": "http://127.0.0.1:1/embed",
        }
        runtime = cognee_adapter._runtime_config(routes, models, "/tmp/cognee-retry-taxonomy")
        setup_module = importlib.import_module("cognee.modules.engine.operations.setup")

        async def no_database_setup():
            return None

        provider_calls = ProviderCalls(routes)
        with patch.object(setup_module, "setup", no_database_setup):
            await cognee_adapter._default_client_factory(runtime, provider_calls)

        import cognee
        import litellm
        from cognee.infrastructure.llm.config import get_llm_config
        from cognee.infrastructure.llm.structured_output_framework.litellm_native.get_native_client import (
            get_native_client,
        )
        from pydantic import BaseModel

        class RequiredValue(BaseModel):
            value: str

        effective = get_llm_config()
        client = get_native_client()
        retry = getattr(client.acreate_structured_output, "retry", None)
        if retry is None:
            raise AssertionError("selected native structured-output client has no observable retry wrapper")

        async def abort_outer_sleep(_delay):
            nonlocal outer_retry_scheduled
            outer_retry_scheduled = True
            raise asyncio.CancelledError()

        try:
            with patch.object(retry, "sleep", abort_outer_sleep):
                await client.acreate_structured_output("offline", "offline", RequiredValue)
        except (asyncio.CancelledError, Exception):
            pass

        request_models = [request["body"].get("model") for request in requests]
        fallback = {
            "fallback_model": effective.fallback_model,
            "fallback_api_key": effective.fallback_api_key,
            "fallback_endpoint": effective.fallback_endpoint,
        }
        assert importlib.metadata.version("cognee") == "1.5.3"
        assert effective.structured_output_framework == "litellm_native"
        assert client.model == EXPECTED_MODEL
        assert client.llm_args.get("num_retries") == 0
        assert fallback == {"fallback_model": "", "fallback_api_key": "", "fallback_endpoint": ""}
        assert litellm.supports_response_schema(EXPECTED_MODEL) is False
        assert len(requests) == 3
        assert request_models == [EXPECTED_WIRE_MODEL] * 3
        assert all(request["path"] == "/v1/chat/completions" for request in requests)
        assert provider_calls.counts == {"internal_memory_llm": 3, "embedding": 0}
        assert outer_retry_scheduled is True
        return {
            "schema": "shadowgraph.v11.native-attempt-loopback-report",
            "version": 1,
            "observedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "amendment006Sha256": AMENDMENT_006_SHA256,
            "armId": "cognee",
            "requestClass": "internal_memory_llm",
            "category": "C",
            "package": {"name": "cognee", "version": "1.5.3"},
            "modelId": EXPECTED_WIRE_MODEL,
            "network": "loopback-only",
            "rootOperationInvocations": 1,
            "wireAttempts": [
                {
                    "ordinal": index + 1,
                    "path": request["path"],
                    "outcome": "SUCCEEDED",
                    "modelId": EXPECTED_WIRE_MODEL,
                    "retryOrdinal": request["retryOrdinal"],
                    "responseFormat": "json_object",
                }
                for index, request in enumerate(requests)
            ],
            "taxonomy": {"A": False, "B": False, "C": True, "D": False, "E": False},
            "allAttemptsMetered": True,
            "providerUsageAccounting": "metered-complete-or-fail-closed",
            "modelEndpointPinned": True,
            "harnessOperationReruns": 0,
        }
    finally:
        server.close()
        await server.wait_closed()


def main() -> int:
    with _sanitized_environment(), _loopback_only_network():
        print(json.dumps(asyncio.run(demonstrate()), sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
