import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export const CHECK_TARGETS = Object.freeze([
  'benchmark/cli.mjs',
  'benchmark/adapters/no-memory.mjs',
  'benchmark/adapters/shadowgraph.mjs',
  'benchmark/lib/preregistration.mjs',
  'benchmark/lib/capabilities.mjs',
  'benchmark/lib/adapters.mjs',
  'benchmark/lib/node-adapter-host.mjs',
  'benchmark/lib/python-adapter-executor.mjs',
  'benchmark/lib/python-container-runtime.mjs',
  'benchmark/lib/scoring.mjs',
  'benchmark/lib/validate.mjs',
  'benchmark/lib/aggregate.mjs',
  'benchmark/lib/journal-validation.mjs',
  'benchmark/lib/v11-contract.mjs',
  'benchmark/lib/v11-registry.mjs',
  'benchmark/lib/v11-mutation-fence.mjs',
  'benchmark/lib/v11-lexical.mjs',
  'benchmark/lib/v11-definition.mjs',
  'benchmark/lib/v11-prompts.mjs',
  'benchmark/lib/adapter-protocol.mjs',
  'benchmark/lib/outer-model.mjs',
  'benchmark/lib/provider-meter.mjs',
  'benchmark/lib/v11-budget.mjs',
  'benchmark/lib/v11-campaign-budget.mjs',
  'benchmark/lib/v11-provider-models.mjs',
  'benchmark/lib/v11-provider-reconciler.mjs',
  'benchmark/lib/v11-native-attempts.mjs',
  'benchmark/lib/v11-native-attempt-evidence.mjs',
  'benchmark/lib/v11-native-attempt-evidence-loader.mjs',
  'benchmark/lib/v11-run-resources.mjs',
  'benchmark/lib/v11-runtime-binding.mjs',
  'benchmark/lib/progress.mjs',
  'benchmark/lib/implementation-lock.mjs',
  'benchmark/lib/v11-evidence-bundle.mjs',
  'benchmark/lib/placeholder.mjs',
  'benchmark/lib/v11-locks.mjs',
  'benchmark/lib/v11-run.mjs',
  'benchmark/lib/v11-runner.mjs',
  'benchmark/lib/v11-environment.mjs',
  'benchmark/lib/v11-node-hosts.mjs',
  'benchmark/lib/v11-outer-transport.mjs',
  'benchmark/lib/v11-python-hosts.mjs',
  'benchmark/lib/v11-precondition-evidence.mjs',
  'benchmark/lib/v11-python-runtime.mjs',
  'benchmark/lib/v11-service-evidence.mjs',
  'benchmark/lib/v11-service-probe.mjs',
  'scripts/bench-journal.mjs',
  'scripts/validate-bench-journal.mjs'
]);

function runNodeCheck(target) {
  const result = spawnSync(process.execPath, ['--check', target], {
    cwd: root,
    encoding: 'utf8',
    shell: false
  });
  if (result.status === 0) return true;
  process.stderr.write(result.stderr || result.stdout || `syntax check failed: ${target}\n`);
  process.exitCode = result.status ?? 1;
  return false;
}

for (const target of CHECK_TARGETS) {
  if (!runNodeCheck(target)) break;
}

if (process.exitCode === undefined) {
  const pythonGate = spawnSync(process.execPath, ['scripts/check-benchmark-python-syntax.mjs'], {
    cwd: root,
    encoding: 'utf8',
    shell: false
  });
  if (pythonGate.status !== 0) {
    process.stderr.write(pythonGate.stderr || pythonGate.stdout || 'benchmark Python syntax check failed\n');
    process.exitCode = pythonGate.status ?? 1;
  } else {
    process.stdout.write(`BENCHMARK_SYNTAX=PASS targets=${CHECK_TARGETS.length}\n`);
  }
}
