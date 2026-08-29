import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const checkerSource = join(projectRoot, 'scripts', 'check-package.mjs');
const requiredFixtureFiles = [
  'README.md',
  'SECURITY.md',
  'RELEASE_NOTES.md',
  'dashboard/index.html',
  'docs/api-reference.md',
  'docs/benchmark-report.md',
  'docs/mcp-compatibility.md',
  'docs/shadowgraph-benchmark-plan.md',
  'docs/unified-memory.md',
  'benchmark/cli.mjs',
  'benchmark/competitors.lock.json',
  'benchmark/lib/adapters.mjs',
  'benchmark/lib/aggregate.mjs',
  'benchmark/lib/capabilities.mjs',
  'benchmark/lib/journal-validation.mjs',
  'benchmark/lib/preregistration.mjs',
  'benchmark/lib/scoring.mjs',
  'benchmark/lib/validate.mjs',
  'benchmark/preregistration.json',
  'benchmark/preregistration.sha256',
  'integrations/claude-code.mcp.json',
  'integrations/codex.mcp.toml',
  'integrations/cursor.mcp.json',
  'integrations/hermes.mcp.yaml',
  'scripts/check-integrations.mjs',
  'scripts/check-package.mjs',
  'scripts/bench-journal.mjs',
  'scripts/smoke-package.mjs',
  'scripts/validate-bench-journal.mjs',
  'src/cli.js',
  'src/mcp.js',
  'src/restore-validation.js'
];

async function packageFixture(t, auditText) {
  const root = await mkdtemp(join(tmpdir(), 'shadowgraph package audit '));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manifest = {
    name: 'shadowgraph-package-audit-fixture',
    version: '1.2.3',
    private: true,
    type: 'module',
    files: [
      'README.md', 'SECURITY.md', 'RELEASE_NOTES.md', 'dashboard/', 'docs/',
      'benchmark/', 'integrations/', 'scripts/', 'src/'
    ]
  };
  const lockfile = {
    name: manifest.name,
    version: manifest.version,
    lockfileVersion: 3,
    requires: true,
    packages: { '': { name: manifest.name, version: manifest.version } }
  };
  await writeFile(join(root, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(join(root, 'package-lock.json'), `${JSON.stringify(lockfile, null, 2)}\n`, 'utf8');
  for (const relativePath of requiredFixtureFiles) {
    const path = join(root, ...relativePath.split('/'));
    await mkdir(dirname(path), { recursive: true });
    if (relativePath === 'scripts/check-package.mjs') await copyFile(checkerSource, path);
    else await writeFile(path, `harmless fixture for ${relativePath}\n`, 'utf8');
  }
  const auditPath = join(root, 'docs', 'package-text-audit.md');
  await writeFile(auditPath, auditText, 'utf8');
  return root;
}

function runChecker(root, { env: envOverrides = {}, withoutNpmExecpath = false } = {}) {
  const env = { ...process.env, ...envOverrides };
  if (withoutNpmExecpath) {
    delete env.npm_execpath;
    delete env.npm_node_execpath;
  }
  return exec(process.execPath, [join(root, 'scripts', 'check-package.mjs')], {
    cwd: root,
    env,
    maxBuffer: 10 * 1024 * 1024,
    windowsHide: true
  });
}

test('check-package rejects packaged docs containing local profile paths or credential literals without disclosing them', async (t) => {
  const windowsPath = String.raw`C:\\Users\\release-fixture\\AppData\\Local\\private-tool\\venv`;
  const posixPath = '/home/package-fixture-person/.config/private-tool/profile.json';
  const secret = 'sk-live-SUPER-SENSITIVE-PACKAGE-FIXTURE-9081726354';
  const root = await packageFixture(t, [
    '# Package text audit fixture',
    `Captured Windows install: ${windowsPath}`,
    `Captured POSIX install: ${posixPath}`,
    `OPENAI_API_KEY = "${secret}"`,
    'Repository: https://github.com/LiLara-AI/shadowgraph',
    'API docs: https://api.example.test/v1?api-version=2026-08-27&model=harmless-model',
    'Versions: ShadowGraph 0.40.0, Node v24.18.0, npm 11.9.0.',
    ''
  ].join('\n'));

  await assert.rejects(runChecker(root), (error) => {
    const diagnostic = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    assert.match(diagnostic, /packaged text policy violations/i);
    assert.match(diagnostic, /docs\/package-text-audit\.md:2 \[absolute-windows-profile-path\]/);
    assert.match(diagnostic, /docs\/package-text-audit\.md:3 \[absolute-posix-profile-path\]/);
    assert.match(diagnostic, /docs\/package-text-audit\.md:4 \[credential-literal\]/);
    for (const sensitive of [windowsPath, posixPath, secret, 'release-fixture', 'package-fixture-person', 'SUPER-SENSITIVE']) {
      assert.equal(diagnostic.includes(sensitive), false, `diagnostic disclosed ${sensitive}`);
    }
    assert.equal(diagnostic.includes(root), false, 'diagnostic must not disclose the temporary absolute package root');
    return true;
  });
});

test('check-package allows harmless packaged URLs, URL metadata, versions, and image digests', async (t) => {
  const root = await packageFixture(t, [
    '# Harmless package metadata',
    'Repository: https://github.com/LiLara-AI/shadowgraph',
    'Public user guide: https://docs.example.test/Users/public/home/profile',
    'API docs: https://api.example.test/v1?api-version=2026-08-27&model=harmless-model',
    'SHADOWGRAPH_API_TOKEN="use-a-random-token-at-least-16-characters" npm start',
    'Versions: ShadowGraph 0.40.0, Node v24.18.0, npm 11.9.0, Python 3.11.15.',
    'Image: python:3.12.11-slim@sha256:47ae396f09c1303b8653019811a8498470603d7ffefc29cb07c88f1f8cb3d19f',
    ''
  ].join('\n'));

  const result = await runChecker(root);
  assert.match(result.stdout, /package metadata and tarball contents valid/);
  assert.doesNotMatch(result.stderr, /packaged text policy violations/i);
});

test('check-package reports why npm pack failed without disclosing any absolute path', async (t) => {
  const root = await packageFixture(t, '# Harmless diagnosable package\n');
  const missingRoot = await mkdtemp(join(tmpdir(), 'shadowgraph missing npm cli '));
  t.after(() => rm(missingRoot, { recursive: true, force: true }));
  const missingNpmCli = join(missingRoot, 'definitely missing npm-cli.js');

  await assert.rejects(runChecker(root, { env: { npm_execpath: missingNpmCli } }), (error) => {
    const diagnostic = `${error.stdout ?? ''}\n${error.stderr ?? ''}`;
    // The cause has to survive: a bare "npm pack command failed" is what let a
    // packaging failure reach CI with nothing to diagnose it by.
    assert.match(diagnostic, /npm pack command failed: /u);
    assert.match(diagnostic, /(?:exit=\d+|errno=[A-Z]+|signal=)/u);
    assert.match(diagnostic, /MODULE_NOT_FOUND/u);
    // ...but no absolute path may be disclosed while it survives.
    for (const sensitive of [missingNpmCli, missingRoot, root, 'definitely missing npm-cli.js']) {
      assert.equal(diagnostic.includes(sensitive), false, 'diagnostic disclosed a local path');
    }
    assert.doesNotMatch(diagnostic, /[A-Za-z]:[\\/]/u, 'diagnostic disclosed a Windows absolute path');
    for (const line of diagnostic.split(/\r?\n/u)) {
      assert.doesNotMatch(line, /(?:^|[\s"'`(<[])\/[^\s"'`<>|]/u, 'diagnostic disclosed a POSIX absolute path');
    }
    return true;
  });
});

test('check-package npm fallback safely packs metacharacter paths without DEP0190', async (t) => {
  const metacharacterTemp = await mkdtemp(join(tmpdir(), 'shadowgraph npm pack &()!^%-'));
  t.after(() => rm(metacharacterTemp, { recursive: true, force: true }));
  const root = await packageFixture(t, '# Harmless metacharacter-path package\n');
  const metacharacterRoot = join(metacharacterTemp, 'safe repo copy &()!^%');
  await cp(root, metacharacterRoot, { recursive: true });

  let result;
  let failure;
  try {
    result = await runChecker(metacharacterRoot, {
      env: { TEMP: metacharacterTemp, TMP: metacharacterTemp, TMPDIR: metacharacterTemp },
      withoutNpmExecpath: true
    });
  } catch (error) {
    failure = error;
  }
  const settled = result ?? failure;
  const output = `${settled.stdout ?? ''}\n${settled.stderr ?? ''}`;

  // The invariant this test exists for, and it holds on every runtime: the fallback
  // never spawns a shell. A shell would both interpret `&()!^%` and raise DEP0190.
  assert.doesNotMatch(output, /DEP0190/u);
  // Whatever happens, the checker must not disclose the local package root.
  for (const sensitive of [metacharacterRoot, metacharacterTemp]) {
    assert.equal(output.includes(sensitive), false, 'checker disclosed a local path');
  }

  if (result) {
    assert.match(result.stdout, /package metadata and tarball contents valid/u);
    return;
  }

  // npm 10.8, bundled with Node 20, throws `URI malformed` when it turns a package
  // directory containing `%` into a `file:` spec; npm 10.9+ does not. That is an
  // upstream npm limitation which no invocation style avoids, so it is not asserted
  // away and not worked around inside the checker. What ShadowGraph owns is the
  // response: surface the upstream reason cleanly rather than crashing, hanging, or
  // leaking a path. Any OTHER failure still fails this test.
  assert.match(output, /npm pack command failed: [^\n]*URI malformed/u);
});
