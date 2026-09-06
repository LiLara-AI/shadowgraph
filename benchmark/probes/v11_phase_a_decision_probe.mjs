/**
 * Re-measure F2: does the pinned decision model return a decision the frozen
 * schema accepts?
 *
 * F2 was recorded from four Phase A attempts, all rejected, with
 * `failedAttemptIdsAvoided` arriving as `null` where the schema says
 * `string[]`. It was the reason a READY harness was not yet a meaningful run:
 * Phase A is the first thing every unit does, so a Phase A that cannot pass
 * fails all 288 measured units at the outer model.
 *
 * F2 was cleared on 2026-09-06 by pinning `qwen2.5:7b`, which this probe
 * accepts 6 of 6. It is kept because the preregistration allows the decision
 * LLM identity to be filled in only from a successful capability probe, so
 * this is the check any future change of that identity has to pass first.
 *
 * This probe measures rather than argues. It uses the shipped
 * `buildV11Prompt` and `requestOuterDecision` - not a re-implementation - with
 * the preregistration's frozen parameters and the committed model lock, over
 * every scenario at every frozen seed. It writes what came back, including the
 * exact validation message, and decides nothing: nothing here clears F2.
 *
 *   node benchmark/probes/v11_phase_a_decision_probe.mjs \
 *     --endpoint http://127.0.0.1:11434/v1 --out <path>
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { requestOuterDecision } from '../lib/outer-model.mjs';
import { loadV11AcceptanceDefinition } from '../lib/v11-definition.mjs';
import { buildV11Prompt } from '../lib/v11-prompts.mjs';

const benchmarkRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function option(name, fallback = null) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new Error(`--${name} requires a value`);
  return value;
}

const endpoint = option('endpoint', 'http://127.0.0.1:11434/v1');
const outPath = option('out', join(benchmarkRoot, 'probe-records', 'phase-a-decision-evidence.json'));
const limit = Number.parseInt(option('limit', '0'), 10);

// Through the loader, not by reading the file: it gates the four frozen
// sources and the scenario document by SHA-256, so a probe that reported on
// scenarios the definition does not pin would be reporting on nothing.
const [loaded, preregistration, modelWeights] = await Promise.all([
  loadV11AcceptanceDefinition({ repositoryRoot: join(benchmarkRoot, '..') }),
  readFile(join(benchmarkRoot, 'preregistration.json'), 'utf8').then(JSON.parse),
  readFile(join(benchmarkRoot, 'model-weights.lock.json'), 'utf8').then(JSON.parse)
]);

const execution = preregistration.commonExecution;
const lockedModel = modelWeights.models.find((model) => model.kind === 'decision_llm');
if (lockedModel === undefined) throw new Error('the model weight lock pins no decision_llm');
// `--model` measures a *candidate* without touching the lock. The
// preregistration froze the decision LLM identity as null and allows a later
// run to fill it "only from a successful capability probe"; this probe is that
// capability probe, and it stays a measurement - choosing what the acceptance
// run pins is the owner's, and is made by editing model-weights.lock.json.
const candidate = option('model', null);
const decisionModel = candidate === null
  ? lockedModel
  : { ...lockedModel, modelId: candidate, weightsDigest: null };

const selected = limit > 0 ? loaded.scenarios.slice(0, limit) : loaded.scenarios;

const attempts = [];
for (const scenario of selected) {
  for (const seed of execution.randomSeeds) {
    // The same call the runner makes, through the same two functions.
    const request = buildV11Prompt({ phase: 'A', scenario, nativeContext: [] });
    const correlation = {
      runId: 'probe-phase-a',
      attemptId: `probe-${scenario.id}-${seed}`,
      armId: 'no-memory',
      scenarioId: scenario.id,
      repetition: 1,
      phase: 'A',
      requestClass: 'outer_decision_llm'
    };
    const config = {
      endpoint,
      apiKey: null,
      model: decisionModel.modelId,
      seed,
      temperature: execution.temperature,
      maxOutputTokens: execution.maxOutputTokens,
      timeoutMs: execution.requestTimeoutMs
    };

    const startedAt = Date.now();
    try {
      const result = await requestOuterDecision({ fetchImpl: fetch, config, correlation, request });
      attempts.push({
        scenarioId: scenario.id,
        seed,
        outcome: 'ACCEPTED',
        elapsedMs: Date.now() - startedAt,
        providerModel: result.providerModel,
        decisionKeys: Object.keys(result.decision).sort()
      });
      process.stdout.write(`ACCEPTED ${scenario.id} seed=${seed}\n`);
    } catch (error) {
      // What the schema rejected, verbatim. The whole point of F2 is the exact
      // field and the exact shape it arrived in.
      attempts.push({
        scenarioId: scenario.id,
        seed,
        outcome: 'REJECTED',
        elapsedMs: Date.now() - startedAt,
        error: error?.message ?? String(error),
        code: error?.code ?? null,
        status: error?.status ?? null
      });
      process.stdout.write(`REJECTED ${scenario.id} seed=${seed}: ${error?.message ?? error}\n`);
    }
  }
}

const accepted = attempts.filter((attempt) => attempt.outcome === 'ACCEPTED').length;
const record = {
  schema: 'shadowgraph.v11.phase-a-decision-probe',
  version: 1,
  observedAt: new Date().toISOString(),
  endpoint,
  model: decisionModel.modelId,
  modelIsLocked: candidate === null,
  lockedModel: lockedModel.modelId,
  modelWeightsDigest: decisionModel.weightsDigest ?? null,
  frozenParameters: {
    temperature: execution.temperature,
    maxOutputTokens: execution.maxOutputTokens,
    requestTimeoutMs: execution.requestTimeoutMs,
    randomSeeds: execution.randomSeeds
  },
  scenarios: selected.length,
  attempts: attempts.length,
  accepted,
  rejected: attempts.length - accepted,
  // A tally of distinct rejection messages, because "0 of N" says nothing about
  // whether one defect or several are in the way.
  rejectionReasons: Object.fromEntries(
    Object.entries(
      attempts
        .filter((attempt) => attempt.outcome === 'REJECTED')
        .reduce((counts, attempt) => {
          counts[attempt.error] = (counts[attempt.error] ?? 0) + 1;
          return counts;
        }, {})
    ).sort((left, right) => right[1] - left[1])
  ),
  results: attempts
};

await writeFile(outPath, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
process.stdout.write(`${JSON.stringify({
  observedAt: record.observedAt,
  model: record.model,
  modelIsLocked: record.modelIsLocked,
  scenarios: record.scenarios,
  attempts: record.attempts,
  accepted: record.accepted,
  rejected: record.rejected,
  rejectionReasons: record.rejectionReasons,
  outputPath: outPath
}, null, 2)}\n`);
