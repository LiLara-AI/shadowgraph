"""Minimal Hermes-style Python tool wrapper around ShadowGraph's local HTTP API.

Use the functions as tools in an agent that supports Python callables.
"""
import json
from urllib.request import Request, urlopen

BASE_URL = "http://127.0.0.1:8787"


def _request(method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(BASE_URL + path, data=data, method=method,
                      headers={"content-type": "application/json"})
    with urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def shadowgraph_search(query=""):
    """Search decisions and attempts before starting consequential work."""
    return _request("GET", "/search?q=" + query)


def shadowgraph_review(changed_facts=None):
    """Find old decisions that should be reconsidered."""
    return _request("POST", "/review", {"changedFacts": changed_facts or []})


def shadowgraph_record_decision(title, chosen, goal="", assumptions=None, alternatives=None):
    """Record a decision and its rejected alternatives."""
    return _request("POST", "/decisions", {
        "title": title,
        "chosen": chosen,
        "goal": goal,
        "assumptions": assumptions or [],
        "alternatives": alternatives or [],
    })


def shadowgraph_record_attempt(solution, result, reason="", environment=""):
    """Record an attempt so the agent can avoid repeating a known failure."""
    return _request("POST", "/attempts", {
        "solution": solution,
        "result": result,
        "reason": reason,
        "environment": environment,
    })
