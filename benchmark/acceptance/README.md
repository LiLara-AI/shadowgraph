# ShadowGraph v1.1 candidate-acceptance definition

This directory contains only the frozen, non-scored candidate-acceptance definition and offline fixtures used by mock/unit tests.

It does **not** contain a real acceptance run, benchmark result, readiness determination, provider execution, ranking, score, or product claim. The presence of these files must not be interpreted as evidence that any arm passed acceptance or that an official benchmark may run.

`definition.json` binds the two `ACC_` scenarios, the seven-arm order, the eleven-phase lifecycle, applicability, two repetitions, two seeds, frozen methodology source hashes, and mechanical expected counts. `scenarios.json` supplies public neutral decision inputs; it contains no expected answer or scoring oracle.

Runner/CLI integration, live services, provider metering, immutable model-weight digests, and real non-scored acceptance remain separate gates.
