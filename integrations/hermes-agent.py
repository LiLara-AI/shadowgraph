"""Minimal Hermes-style Python tool wrapper around ShadowGraph's local HTTP API.

Use the functions as tools in an agent that supports Python callables.
"""
import json
from urllib.parse import urlencode
from urllib.request import Request, urlopen

BASE_URL = "http://127.0.0.1:8787"


def _request(method, path, payload=None):
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = Request(BASE_URL + path, data=data, method=method,
                      headers={"content-type": "application/json"})
    with urlopen(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


def shadowgraph_search(query="", project=None, limit=None, offset=None):
    """Search decisions and attempts before starting consequential work."""
    params = {"q": query}
    if project is not None:
        params["project"] = project
    if limit is not None:
        params["limit"] = limit
    if offset is not None:
        params["offset"] = offset
    return _request("GET", "/search?" + urlencode(params))


def shadowgraph_context(project="default"):
    """Load project context, including review signals from stored state."""
    return _request("POST", "/context", {"project": project})


def shadowgraph_retrieve(query="", project=None, limit=None, offset=None):
    """Retrieve complete decision records with an explicit completeness envelope."""
    payload = {"query": query}
    if project is not None:
        payload["project"] = project
    if limit is not None:
        payload["limit"] = limit
    if offset is not None:
        payload["offset"] = offset
    return _request("POST", "/retrieve", payload)


def shadowgraph_review(project="default", changed_facts=None):
    """Review stored facts; changed_facts is optional and only for ephemeral signals."""
    payload = {"project": project}
    if changed_facts is not None:
        payload["changedFacts"] = changed_facts
    return _request("POST", "/review", payload)


def shadowgraph_record_decision(title, chosen, goal="", assumptions=None, alternatives=None,
                                project="default", source_class="agent_claimed", actor=None,
                                client=None, session_id=None, idempotency_key=None):
    """Record a project-scoped decision and its rejected alternatives."""
    payload = {"title": title, "chosen": chosen, "goal": goal,
               "assumptions": assumptions or [], "alternatives": alternatives or [],
               "project": project, "sourceClass": source_class}
    if actor is not None: payload["actor"] = actor
    if client is not None: payload["client"] = client
    if session_id is not None: payload["sessionId"] = session_id
    if idempotency_key is not None: payload["idempotencyKey"] = idempotency_key
    return _request("POST", "/decisions", payload)


def shadowgraph_record_fact(key, value, project="default", source_class="agent_claimed",
                            actor=None, client=None, session_id=None, idempotency_key=None):
    """Record a project-scoped fact; source_class is a claim, never proof."""
    payload = {"key": key, "value": value, "project": project, "sourceClass": source_class}
    if actor is not None: payload["actor"] = actor
    if client is not None: payload["client"] = client
    if session_id is not None: payload["sessionId"] = session_id
    if idempotency_key is not None: payload["idempotencyKey"] = idempotency_key
    return _request("POST", "/facts", payload)


def shadowgraph_record_outcome(decision_id, status, lessons=None, source_class="agent_claimed"):
    """Record a decision outcome and its confidence contribution."""
    return _request("POST", "/outcomes", {"decisionId": decision_id,
        "outcome": {"status": status, "lessons": lessons or [], "sourceClass": source_class}})


def shadowgraph_record_attempt(solution, result, reason="", environment="", project="default",
                                actor=None, client=None, session_id=None, idempotency_key=None):
    """Record a project-scoped attempt so the agent can avoid repeating a known failure."""
    payload = {"solution": solution, "result": result, "reason": reason,
               "environment": environment, "project": project}
    if actor is not None: payload["actor"] = actor
    if client is not None: payload["client"] = client
    if session_id is not None: payload["sessionId"] = session_id
    if idempotency_key is not None: payload["idempotencyKey"] = idempotency_key
    return _request("POST", "/attempts", payload)


def shadowgraph_update_status(decision_id, status):
    """Persist a canonical decision lifecycle status."""
    return _request("POST", "/status", {"decisionId": decision_id, "status": status})


def shadowgraph_maintain(project=None, changed_facts=None):
    """Age decisions, expire facts, and create stored review signals."""
    payload = {}
    if project is not None:
        payload["project"] = project
    if changed_facts is not None:
        payload["changedFacts"] = changed_facts
    return _request("POST", "/maintain", payload)


def shadowgraph_confidence_evidence(decision_id, key, reason, supports=True,
                                    source_class="agent_claimed", observed_at=None):
    """Add keyed confidence evidence; key must remain stable across retries."""
    payload = {"decisionId": decision_id, "key": key, "reason": reason,
               "supports": supports, "sourceClass": source_class}
    if observed_at is not None:
        payload["observedAt"] = observed_at
    return _request("POST", "/confidence-evidence", payload)
