import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../benchmark/cli.mjs', import.meta.url));

async function runCli(args) {
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [cli, ...args], {
      cwd: repositoryRoot,
      maxBuffer: 8 * 1024 * 1024
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

test('v11-preflight reports the candidate without contacting a service or scoring it', async () => {
  const { code, stdout } = await runCli(['v11-preflight']);
  const report = JSON.parse(stdout);

  assert.equal(report.schema, 'shadowgraph.v11.preflight');
  assert.equal(report.scored, false, 'preflight must never present itself as a scored result');
  assert.match(report.containerImage, /@sha256:[a-f0-9]{64}$/u);

  // No score, ranking or comparative claim may appear anywhere in the output.
  const serialized = stdout.toLowerCase();
  for (const forbidden of ['winner', 'ranking', 'outperform', 'faster than', 'best ']) {
    assert.equal(serialized.includes(forbidden), false, forbidden);
  }

  // The candidate is not ready, and the exit code says so rather than only the
  // text: a readiness check that exits zero while reporting blockers would let
  // an operator proceed on a green shell result.
  assert.equal(report.readiness, 'NOT READY');
  assert.notEqual(code, 0);
});

test('every frozen arm is bound to a runtime and its observed isolation', async () => {
  const { stdout } = await runCli(['v11-preflight']);
  const report = JSON.parse(stdout);

  assert.deepEqual(report.arms.map((arm) => arm.armId), [
    'no-memory',
    'shadowgraph-full',
    'shadowgraph-compact',
    'mem0-oss',
    'graphiti',
    'basic-memory',
    'cognee'
  ]);

  const byId = Object.fromEntries(report.arms.map((arm) => [arm.armId, arm]));
  assert.equal(byId['no-memory'].kind, 'control');
  assert.equal(byId['shadowgraph-full'].kind, 'node-mcp');
  assert.equal(byId.graphiti.kind, 'python-container');

  // Isolation is reported as observed. Graphiti has a project scope and no user
  // scope; nothing fabricates one for it.
  assert.equal(byId.graphiti.nativeProjectNamespace, 'group_id');
  assert.equal(byId.graphiti.nativeUserNamespace, null);
  assert.equal(byId['mem0-oss'].nativeUserNamespace, 'user_id');
});

test('the declared applicability contradiction is surfaced as a blocker', async () => {
  const { stdout } = await runCli(['v11-preflight']);
  const report = JSON.parse(stdout);

  assert.equal(report.applicability.status, 'INCONSISTENT');
  const graphiti = report.blockers.find((blocker) => (
    blocker.kind === 'applicability' && blocker.armId === 'graphiti'
  ));
  assert.equal(graphiti.code, 'DECLARED_ISOLATION_UNAVAILABLE');
  assert.equal(graphiti.declared, 'SUPPORTED');

  // Cognee is a different case and must not be collapsed into the same one: the
  // capability exists but its configuration is not pinned.
  const cognee = report.blockers.find((blocker) => (
    blocker.kind === 'applicability' && blocker.armId === 'cognee'
  ));
  assert.equal(cognee.code, 'DECLARED_ISOLATION_PRECONDITION_UNMET');
});

test('counts are derived and compared rather than asserted from the definition alone', async () => {
  const { stdout } = await runCli(['v11-preflight']);
  const report = JSON.parse(stdout);

  // The definition currently declares the A002 matrix, so the derived counts
  // agree with it. The disagreement is in the matrix itself, which is reported
  // separately: conflating the two would hide which one is wrong.
  assert.deepEqual(report.derivedCounts, report.declaredCounts);
  assert.equal(report.derivedCounts.totalUnits, 308);
  assert.equal(
    report.derivedCounts.measuredUnits - report.derivedCounts.resetUnits,
    report.derivedCounts.outerDecisionCalls
  );
  assert.equal(
    report.blockers.some((blocker) => blocker.kind === 'expected-counts'),
    false
  );
});

test('services that are not provisioned are named as blockers, not assumed present', async () => {
  const { stdout } = await runCli(['v11-preflight']);
  const report = JSON.parse(stdout);
  const services = report.blockers.filter((blocker) => blocker.kind === 'required-service');
  assert.deepEqual(services.map((blocker) => blocker.armId).sort(), ['cognee', 'graphiti']);
});

test('a satisfied precondition clears only its own blocker', async () => {
  const { stdout } = await runCli([
    'v11-preflight',
    '--preconditions=pinned backend access-control configuration'
  ]);
  const report = JSON.parse(stdout);

  assert.equal(
    report.blockers.some((blocker) => blocker.code === 'DECLARED_ISOLATION_PRECONDITION_UNMET'),
    false
  );
  // Graphiti has no precondition to satisfy: its capability is absent, so the
  // blocker must survive.
  assert.ok(report.blockers.some((blocker) => blocker.code === 'DECLARED_ISOLATION_UNAVAILABLE'));
  assert.equal(report.readiness, 'NOT READY');
});

test('the existing command surface still resolves', async () => {
  const { code, stderr } = await runCli(['definitely-not-a-command']);
  assert.notEqual(code, 0);
  assert.match(stderr, /Unknown benchmark command/u);

  const usage = await runCli([]);
  assert.match(usage.stderr, /v11-preflight/u);
});

test('authenticated immutable prerequisites clear their own gates', async () => {
  // Real prerequisite evidence is now committed. Readiness must still remain
  // blocked by the independent Graphiti applicability contradiction.
  const { stdout } = await runCli(['v11-preflight']);
  const report = JSON.parse(stdout);

  const requirements = report.blockers
    .filter((blocker) => blocker.kind === 'immutable-prerequisite')
    .map((blocker) => blocker.requirement)
    .sort();

  assert.deepEqual(requirements, []);
  assert.ok(report.blockers.some((blocker) => blocker.code === 'DECLARED_ISOLATION_UNAVAILABLE'));
  assert.equal(report.readiness, 'NOT READY');
});

test('clearing every applicability precondition still leaves Graphiti blocked', async () => {
  // Cognee's ACL precondition and the immutable prerequisites are satisfied, but
  // Graphiti's declared native user isolation is still unavailable.
  const { stdout } = await runCli([
    'v11-preflight',
    '--preconditions=pinned backend access-control configuration'
  ]);
  const report = JSON.parse(stdout);
  assert.equal(report.readiness, 'NOT READY');
  assert.equal(report.blockers.some((blocker) => blocker.kind === 'immutable-prerequisite'), false);
  assert.ok(report.blockers.some((blocker) => blocker.code === 'DECLARED_ISOLATION_UNAVAILABLE'));
});

test('v11-preflight reports exactly the four current blockers', async () => {
  const { code, stdout } = await runCli(['v11-preflight']);
  const report = JSON.parse(stdout);

  assert.notEqual(code, 0);
  assert.equal(report.readiness, 'NOT READY');
  assert.deepEqual(
    report.blockers.map((blocker) => {
      if (blocker.kind === 'applicability') {
        return `${blocker.kind}:${blocker.code}:${blocker.armId}`;
      }
      return `${blocker.kind}:${blocker.armId}:${blocker.service}`;
    }).sort(),
    [
      'applicability:DECLARED_ISOLATION_PRECONDITION_UNMET:cognee',
      'applicability:DECLARED_ISOLATION_UNAVAILABLE:graphiti',
      'required-service:cognee:common LLM and embedding endpoint',
      'required-service:graphiti:Neo4j-compatible graph database plus common LLM and embedding endpoint'
    ].sort()
  );
});
