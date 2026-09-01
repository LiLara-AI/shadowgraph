"""What the three unprovisioned arms actually do when the harness calls them.

Mem0 OSS, Graphiti and Cognee have no real client factory: each needs a service
and a model lock that do not exist, so ``_default_client_factory`` raises
``RuntimeUnavailable``. That default is not a placeholder nobody reaches - it is
the code path that runs today, on every operation, for three of the seven arms.

Nothing covered it. Every other test in this directory injects a fake client and
therefore never touches it, so a default that crashed the adapter process, or
returned a SUCCEEDED envelope, or counted work it never did, would have passed
the whole suite.

Writing the coverage surfaced the more interesting half. Each of these adapters
refuses, before it ever reaches its runtime, the namespace shape its product
cannot natively honour:

* Mem0 has a native ``user_id``, so a project-only namespace is a contract
  failure - it will not silently widen the scope it was asked for.
* Graphiti has only ``group_id``; a user-scoped request is a contract failure
  rather than a user id folded into the group scope.
* Cognee has a user ACL, but it is not locked for benchmark execution, so a
  user-scoped request is refused rather than run against unpinned access control.

That is the "genuine native namespaces only, never manufacture isolation"
property, observable per arm, and it holds whether or not the runtime exists.
These tests fix the absence of coverage. They do not make the arms available:
the arms stay unavailable until their services and locks exist.
"""

from __future__ import annotations

import asyncio
import unittest

import cognee_adapter
import graphiti_adapter
import mem0_adapter

from envelope import namespace_ref_for
from python_runtime import RuntimeUnavailable
from test_support import python_config, request_for


# Whether the product exposes a native user-scoped record API at its pinned
# version. This mirrors NATIVE_ISOLATION in benchmark/lib/v11-registry.mjs and
# the probe recorded under benchmark/evidence/; it is observed capability, not
# declared applicability, and the two disagree for graphiti today.
UNPROVISIONED_ARMS = (
    ("mem0-oss", mem0_adapter, True),
    ("graphiti", graphiti_adapter, False),
    ("cognee", cognee_adapter, False),
)

OPERATIONS = ("reset", "retrieve", "persist", "verify")


def _request(arm_id: str, operation: str, *, user_id: str | None) -> dict:
    """A request whose namespace reference the adapter will accept.

    The shared fixture carries the Mem0 reference, and the reference is a digest
    over the arm's own correlation and namespace, so it has to be recomputed.
    It is derived with the product's own helper rather than pasted as a literal,
    so this file cannot drift from the derivation it depends on.
    """
    request = request_for(operation, arm_id=arm_id, user_id=user_id)
    request["namespaceRef"] = namespace_ref_for(
        {
            "runId": request["runId"],
            "armId": request["armId"],
            "scenarioId": request["scenarioId"],
            "repetition": request["repetition"],
            "phase": request["phase"],
        },
        request["namespace"],
    )
    return request


def _execute(module, arm_id: str, operation: str, *, user_id: str | None) -> dict:
    return asyncio.run(
        module.execute(_request(arm_id, operation, user_id=user_id), python_config())
    )


def _native_user_id(has_native_user_namespace: bool) -> str | None:
    """The namespace shape the product can natively honour."""
    return "user-1" if has_native_user_namespace else None


def _foreign_user_id(has_native_user_namespace: bool) -> str | None:
    """The namespace shape it cannot."""
    return None if has_native_user_namespace else "user-1"


class UnprovisionedRuntimeTests(unittest.TestCase):
    def test_the_default_factory_refuses_rather_than_returning_a_client(self) -> None:
        for arm_id, module, _ in UNPROVISIONED_ARMS:
            with self.subTest(arm=arm_id):
                with self.assertRaises(RuntimeUnavailable):
                    module._default_client_factory({}, None)

    def test_a_supported_namespace_reaches_the_runtime_and_reports_it_missing(self) -> None:
        # ENDPOINT_UNAVAILABLE rather than CONTRACT_FAILURE matters: it tells a
        # reviewer the arm is blocked on provisioning, not on its own contract.
        for arm_id, module, native in UNPROVISIONED_ARMS:
            for operation in OPERATIONS:
                with self.subTest(arm=arm_id, operation=operation):
                    response = _execute(
                        module, arm_id, operation, user_id=_native_user_id(native)
                    )
                    self.assertEqual(response["status"], "FAILED")
                    self.assertEqual(response["failure"]["cause"], "ENDPOINT_UNAVAILABLE")

    def test_a_namespace_the_product_cannot_honour_is_refused_not_synthesized(self) -> None:
        for arm_id, module, native in UNPROVISIONED_ARMS:
            for operation in OPERATIONS:
                with self.subTest(arm=arm_id, operation=operation):
                    response = _execute(
                        module, arm_id, operation, user_id=_foreign_user_id(native)
                    )
                    self.assertEqual(response["status"], "FAILED")
                    self.assertEqual(response["failure"]["cause"], "CONTRACT_FAILURE")
                    self.assertIsNone(response["result"]["isolationEvidence"])
                    self.assertIsNone(response["result"]["persistenceEvidence"])

    def test_no_operation_reports_success_in_either_namespace_shape(self) -> None:
        for arm_id, module, native in UNPROVISIONED_ARMS:
            for user_id in (_native_user_id(native), _foreign_user_id(native)):
                for operation in OPERATIONS:
                    with self.subTest(arm=arm_id, operation=operation, user=user_id):
                        response = _execute(module, arm_id, operation, user_id=user_id)
                        self.assertNotEqual(response["status"], "SUCCEEDED")
                        self.assertIsNotNone(response["failure"])
                        self.assertEqual(response["armId"], arm_id)
                        self.assertEqual(response["operation"], operation)

    def test_an_unavailable_runtime_invents_no_evidence(self) -> None:
        # A failed operation that still reported evidence would let a blocked
        # arm look like it had proved something.
        for arm_id, module, native in UNPROVISIONED_ARMS:
            for user_id in (_native_user_id(native), _foreign_user_id(native)):
                for operation in OPERATIONS:
                    with self.subTest(arm=arm_id, operation=operation, user=user_id):
                        result = _execute(module, arm_id, operation, user_id=user_id)["result"]
                        self.assertEqual(result["nativeContext"], [])
                        self.assertIsNone(result["persistenceEvidence"])
                        self.assertIsNone(result["isolationEvidence"])

    def test_no_operation_is_counted_that_never_happened(self) -> None:
        for arm_id, module, native in UNPROVISIONED_ARMS:
            for user_id in (_native_user_id(native), _foreign_user_id(native)):
                for operation in OPERATIONS:
                    with self.subTest(arm=arm_id, operation=operation, user=user_id):
                        operations = _execute(
                            module, arm_id, operation, user_id=user_id
                        )["operations"]
                        self.assertEqual(
                            sorted(operations.values()),
                            [0] * len(operations),
                            "an arm that never reached its runtime counted work it did not do",
                        )

    def test_the_public_message_is_static_and_is_not_the_internal_reason(self) -> None:
        """Non-disclosure, asserted as a property rather than a word list.

        The internal reason names the lock and the service that are missing,
        which is an operator diagnostic and not something a unit result may
        carry. Banning particular words would only catch today's wording. What
        actually has to hold is that the public message is the same static
        string whatever it was asked to do, and that it is not the internal
        reason: a message that varied with the request is a message carrying
        request-derived detail.
        """
        for arm_id, module, native in UNPROVISIONED_ARMS:
            with self.subTest(arm=arm_id):
                try:
                    module._default_client_factory({}, None)
                except RuntimeUnavailable as error:
                    internal = str(error)
                else:
                    self.fail("the default factory returned a client")

                messages = {
                    _execute(module, arm_id, operation, user_id=_native_user_id(native))[
                        "failure"
                    ]["message"]
                    for operation in OPERATIONS
                }
                self.assertEqual(len(messages), 1, "the public message varies with the request")
                message = messages.pop()
                self.assertNotEqual(message, internal)
                self.assertNotIn(internal, message)


if __name__ == "__main__":  # pragma: no cover
    unittest.main()
