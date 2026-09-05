// Every arm, bound to the runtime the lock names for it, executing one real
// operation.
//
// LB2a was the blocker that said `v11RuntimeDependencies()` was unimplemented:
// a preflight could reach READY and there was still nowhere to send an arm. It
// is implemented now, and this demonstrates the half of it that unit tests
// cannot - that the seven descriptors the registry produces resolve to seven
// working executors, that the four container arms actually launch the pinned
// image, and that a metered arm's provider call arrives at the meter with the
// correlation the harness will attribute it by.
//
// It is deliberately NOT a run. It starts no progress ledger, computes no
// implementation lock, writes no artifact, and executes one `reset` per arm
// rather than a plan. The candidate has produced no benchmark result and this
// does not change that. What it establishes is narrower and was, until now,
// entirely unestablished: the binding works.
//
// A reset is the right operation to demonstrate with. It is the only one every
// arm must implement, it is what a run does first, and for the arms whose client
// factories still refuse it exercises exactly the path that refuses - so the
// three arms that are still blocked are visible here as blocked, in their own
// words, rather than absent.

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAdapterRequest } from '../lib/adapter-protocol.mjs';
import { startProviderMeter } from '../lib/provider-meter.mjs';
import { loadV11AcceptanceDefinition } from '../lib/v11-definition.mjs';
import { createV11NodeHosts } from '../lib/v11-node-hosts.mjs';
import { createV11PythonHosts } from '../lib/v11-python-hosts.mjs';
import { parseProviderLedger } from '../lib/v11-provider-reconciler.mjs';
import { createV11Registry } from '../lib/v11-registry.mjs';
import { createV11AdapterExecutor } from '../lib/v11-run.mjs';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));
const benchmarkRoot = path.join(repositoryRoot, 'benchmark');

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${name} must be set for the demonstration to run`);
  }
  return value;
}

const runtimeSite = required('SHADOWGRAPH_PYTHON_RUNTIME_SITE');
const providerUpstream = required('SHADOWGRAPH_PROVIDER_UPSTREAM');

const competitorLock = JSON.parse(await readFile(path.join(benchmarkRoot, 'competitors.lock.json'), 'utf8'));
const modelWeights = JSON.parse(await readFile(path.join(benchmarkRoot, 'model-weights.lock.json'), 'utf8'));
const registry = createV11Registry({ competitorLock, containerImage: competitorLock.pythonImage });
const { definition, scenarios } = await loadV11AcceptanceDefinition({ repositoryRoot });

const workspace = await mkdtemp(path.join(tmpdir(), 'shadowgraph-binding-'));
const nodeStateRoot = path.join(workspace, 'node-state');
const pythonStateRoot = path.join(workspace, 'python-state');
const ledgerPath = path.join(workspace, 'provider-ledger.ndjson');

const meter = await startProviderMeter({
  listenerUrl: 'http://127.0.0.1:0',
  upstreamBaseUrl: providerUpstream,
  upstreamAuthorization: null,
  ledgerPath,
  upstreamTimeoutMs: 120_000
});

const report = { arms: [], observedAt: new Date().toISOString() };
try {
  const executeAdapter = createV11AdapterExecutor({
    registry,
    hosts: {
      ...createV11NodeHosts({ stateRoot: nodeStateRoot }),
      ...createV11PythonHosts({
        stateRoot: pythonStateRoot,
        runtimeRoot: runtimeSite,
        providerEndpointFor: (_requestClass, correlation) => meter.bindEndpoint({ ...correlation }),
        modelWeights
      })
    }
  });

  const scenario = scenarios[0];
  for (const { id: armId, applicability } of definition.arms) {
    const namespace = {
      projectId: `binding-${armId}`,
      userId: applicability.userIsolation.status === 'SUPPORTED' ? 'binding-user' : null
    };
    const request = createAdapterRequest({
      operation: 'reset',
      correlation: {
        runId: 'binding-demonstration',
        attemptId: `binding-${armId}`,
        phase: 'RESET',
        armId,
        scenarioId: scenario.id,
        repetition: 0
      },
      namespace,
      payload: {}
    });

    const started = Date.now();
    let entry;
    try {
      const envelope = await executeAdapter(request, { signal: undefined });
      entry = {
        armId,
        kind: registry.descriptorFor(armId).kind,
        elapsedMs: Date.now() - started,
        status: envelope.status,
        failureCause: envelope.failure?.cause ?? null,
        storageStatus: envelope.storage.status,
        operations: envelope.operations
      };
    } catch (error) {
      entry = {
        armId,
        kind: registry.descriptorFor(armId).kind,
        elapsedMs: Date.now() - started,
        status: 'THREW',
        error: `${error.name}: ${error.message}`
      };
    }
    report.arms.push(entry);
    process.stderr.write(`${armId}: ${entry.status}${entry.failureCause ? ` (${entry.failureCause})` : ''}\n`);
  }
} finally {
  await meter.close();
}

const { events, malformed } = parseProviderLedger(await readFile(ledgerPath, 'utf8'));
report.providerLedger = {
  events: events.length,
  malformed: malformed.length,
  byArm: [...events.reduce((counts, event) => counts.set(event.armId, (counts.get(event.armId) ?? 0) + 1), new Map())]
    .map(([armId, count]) => ({ armId, count }))
};
report.bound = report.arms.length;
report.reachedTheirRuntime = report.arms.filter((arm) => arm.status !== 'THREW').length;

console.log(JSON.stringify(report, null, 2));
await rm(workspace, { recursive: true, force: true });
process.exit(report.reachedTheirRuntime === report.bound ? 0 : 1);
