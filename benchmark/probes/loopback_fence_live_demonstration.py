"""Does the loopback fence still let a real adapter do its real work?

Runs inside the pinned image with the pinned 227-package runtime and the real
`python_host`, on `--network host` - which is what the three metered arms get,
and therefore the configuration in which this fence is the only barrier.

The fence was widened from four entry points to ten after a review demonstrated
that a datagram and `gethostbyname` both left the process. Widening a fence that
sits in the execution path of four arms is exactly the change that can break a
measurement silently, so it is checked in both directions against the real
libraries rather than against a stub: every loopback path a metered arm actually
uses must still work, and every non-loopback path must still be refused.

Not a run. No plan, no ledger, no lock, no artifact - one process, no adapter.
"""
import os
import socket
import sys
import traceback

sys.path.insert(0, "/opt/shadowgraph/adapters")

import python_host  # noqa: E402

OLLAMA = "http://127.0.0.1:11434/api/tags"
results = []


def check(name, fn, expect_fenced=False):
    try:
        value = fn()
    except python_host.NetworkFenceError as error:
        results.append((name, "FENCED" if expect_fenced else "WRONGLY-FENCED", str(error)[:70]))
        return
    except Exception as error:  # noqa: BLE001
        results.append((name, "ERROR", f"{type(error).__name__}: {str(error)[:70]}"))
        return
    results.append((name, "REFUSED-NOTHING" if expect_fenced else "OK", str(value)[:70]))


with python_host._loopback_only_network():
    # 1. The loopback traffic a metered arm actually makes.
    def httpx_to_ollama():
        import httpx

        with httpx.Client(timeout=10) as client:
            response = client.get(OLLAMA)
            return f"httpx {response.status_code} models={len(response.json().get('models', []))}"

    check("httpx -> pinned ollama on 127.0.0.1", httpx_to_ollama)

    def openai_sdk_to_ollama():
        import openai

        client = openai.OpenAI(base_url="http://127.0.0.1:11434/v1", api_key="not-a-secret")
        models = client.models.list()
        return f"openai sdk models={len(models.data)}"

    check("openai sdk -> pinned ollama", openai_sdk_to_ollama)

    def litellm_embedding():
        import litellm

        response = litellm.embedding(
            model="openai/nomic-embed-text:v1.5",
            input=["a decision the benchmark recorded"],
            api_base="http://127.0.0.1:11434/v1",
            api_key="not-a-secret",
        )
        return f"litellm embedding dims={len(response.data[0]['embedding'])}"

    check("litellm embedding -> pinned ollama", litellm_embedding)

    def neo4j_bolt():
        # Graphiti's store. Bolt on loopback, which the fence must not touch.
        connection = socket.create_connection(("127.0.0.1", 7687), timeout=5)
        connection.close()
        return "bolt 127.0.0.1:7687 connected"

    check("bolt -> pinned neo4j on 127.0.0.1", neo4j_bolt)

    # 2. Every resolution shape a library might use for loopback.
    check("getaddrinfo('localhost')", lambda: socket.getaddrinfo("localhost", 80)[0][4])
    check("gethostbyname('localhost')", lambda: socket.gethostbyname("localhost"))
    check("gethostbyname_ex('localhost')", lambda: socket.gethostbyname_ex("localhost")[0])
    check("getnameinfo(('127.0.0.1', 80))", lambda: socket.getnameinfo(("127.0.0.1", 80), 0))
    check("gethostbyaddr('127.0.0.1')", lambda: socket.gethostbyaddr("127.0.0.1")[0])

    # 3. A connected datagram socket: sendto with one argument, and send().
    def connected_datagram():
        handle = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        handle.connect(("127.0.0.1", 9))
        sent = handle.send(b"connected")
        again = handle.sendto(b"connected", ("127.0.0.1", 9))
        handle.close()
        return f"send={sent} sendto={again}"

    check("connected loopback datagram", connected_datagram)

    def unix_socket():
        if not hasattr(socket, "AF_UNIX"):
            return "no AF_UNIX"
        handle = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            handle.connect("/run/shadowgraph/state/no-such-socket")
        except OSError as error:
            return f"AF_UNIX reached the kernel: {type(error).__name__}"
        finally:
            handle.close()
        return "connected"

    check("AF_UNIX is not a network call", unix_socket)

    # 4. And the things that must still be refused.
    check("connect -> 192.0.2.1:80", lambda: socket.create_connection(("192.0.2.1", 80), timeout=2), True)
    check("sendto -> 192.0.2.1:9", lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM).sendto(b"x", ("192.0.2.1", 9)), True)
    check("getaddrinfo('huggingface.co')", lambda: socket.getaddrinfo("huggingface.co", 443), True)
    check("gethostbyname('huggingface.co')", lambda: socket.gethostbyname("huggingface.co"), True)

width = max(len(name) for name, _, _ in results)
bad = 0
for name, verdict, detail in results:
    if verdict in ("WRONGLY-FENCED", "REFUSED-NOTHING", "ERROR"):
        bad += 1
    print(f"{name.ljust(width)}  {verdict:16} {detail}")
print()
print(f"{len(results) - bad} of {len(results)} as required")
sys.exit(1 if bad else 0)
