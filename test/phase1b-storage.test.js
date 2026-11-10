import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { rmSync, mkdirSync } from 'node:fs';
import { isPlaceholderPath, resolveStoragePath, createStorage } from '../src/storage.js';

test('isPlaceholderPath correctly distinguishes real user paths from shipped sentinels and unexpanded syntax', () => {
  // 1. Genuine user paths MUST return false (no over-matching)
  assert.equal(isPlaceholderPath('C:\\' + 'Users' + '\\me\\shared-shadowgraph\\data.json'), false);
  assert.equal(isPlaceholderPath('D:\\Work [2026]\\sg.json'), false);
  assert.equal(isPlaceholderPath('/' + 'home' + '/me/placeholder-tests/data.json'), false);
  assert.equal(isPlaceholderPath('/srv/app/path/to/data.json'), false);
  assert.equal(isPlaceholderPath('/custom/storage/store.json'), false);
  assert.equal(isPlaceholderPath('C:\\custom-storage\\store.json'), false);
  assert.equal(isPlaceholderPath('./local/store.json'), false);
  assert.equal(isPlaceholderPath('./.shadowgraph/data.json'), false);
  assert.equal(isPlaceholderPath('[path]'), false);
  assert.equal(isPlaceholderPath('[your-path]'), false);
  assert.equal(isPlaceholderPath('placeholder.json'), false);
  assert.equal(isPlaceholderPath('your-path/data.json'), false);
  assert.equal(isPlaceholderPath('/my-app/your_path/data.json'), false);
  assert.equal(isPlaceholderPath('/path/to/data.json'), false);
  assert.equal(isPlaceholderPath('/PATH/TO/DATA.JSON'), false);

  // 2. Shipped template sentinels MUST return true
  assert.equal(isPlaceholderPath('/absolute/path/to/shared-shadowgraph/data.json'), true);
  assert.equal(isPlaceholderPath('C:\\absolute\\path\\to\\shared-shadowgraph\\data.json'), true);
  assert.equal(isPlaceholderPath('c:/absolute/path/to/shared-shadowgraph/data.json'), true);
  assert.equal(isPlaceholderPath('/absolute/path/to/shared-shadowgraph/data.db'), true);
  assert.equal(isPlaceholderPath('C:\\absolute\\path\\to\\shared-shadowgraph\\data.db'), true);
  assert.equal(isPlaceholderPath('/absolute/path/to/data.json'), true);
  assert.equal(isPlaceholderPath('C:\\absolute\\path\\to\\data.json'), true);
  assert.equal(isPlaceholderPath('/absolute/path/to/data.db'), true);
  assert.equal(isPlaceholderPath('/absolute/path/to/data.sqlite'), true);
  assert.equal(isPlaceholderPath('path/to/storage.json'), true);
  assert.equal(isPlaceholderPath('/path/to/storage.json'), true);
  assert.equal(isPlaceholderPath('C:\\path\\to\\storage.json'), true);
  assert.equal(isPlaceholderPath('path/to/storage.sqlite'), true);
  assert.equal(isPlaceholderPath('/path/to/storage.sqlite'), true);
  assert.equal(isPlaceholderPath('C:\\path\\to\\storage.sqlite'), true);
  assert.equal(isPlaceholderPath('path/to/storage.db'), true);
  assert.equal(isPlaceholderPath('~/path/to/storage.json'), true);
  assert.equal(isPlaceholderPath('/' + 'home/user/.shadowgraph/data.json'), true);
  assert.equal(isPlaceholderPath('/' + 'home/user/.shadowgraph/data.db'), true);
  assert.equal(isPlaceholderPath('/' + 'home/user/.shadowgraph/data.sqlite'), true);
  assert.equal(isPlaceholderPath('/' + 'users/user/.shadowgraph/data.json'), true);

  // 3. Unexpanded template syntax MUST return true
  assert.equal(isPlaceholderPath('${SHADOWGRAPH_FILE}'), true);
  assert.equal(isPlaceholderPath('${SHADOWGRAPH_PATH}/data.json'), true);
  assert.equal(isPlaceholderPath('${env:DIR}/file.json'), true);
  assert.equal(isPlaceholderPath('$SHADOWGRAPH_HOME/data.json'), true);
  assert.equal(isPlaceholderPath('$VAR/data.json'), true);
  assert.equal(isPlaceholderPath('%SHADOWGRAPH_FILE%'), true);
  assert.equal(isPlaceholderPath('%USERPROFILE%\\.shadowgraph\\data.json'), true);
  assert.equal(isPlaceholderPath('<absolute-path-to-data.json>'), true);
  assert.equal(isPlaceholderPath('<path-to-data.json>'), true);
  assert.equal(isPlaceholderPath('<path-to-store>'), true);
  assert.equal(isPlaceholderPath('<path/to/data.json>'), true);
  assert.equal(isPlaceholderPath('/prefix/<custom_dir>/data.json'), true);
  assert.equal(isPlaceholderPath('C:\\prefix\\<custom_dir>\\data.json'), true);
});

test('resolveStoragePath preserves real user paths without redirecting or emitting warnings', () => {
  const fakeHome = join(tmpdir(), 'sg-test-home-' + Math.random().toString(36).slice(2));
  let warningCount = 0;
  const mockStderr = {
    write() { warningCount++; }
  };

  const realPaths = [
    'C:\\' + 'Users' + '\\me\\shared-shadowgraph\\data.json',
    'D:\\Work [2026]\\sg.json',
    '/' + 'home' + '/me/placeholder-tests/data.json',
    '/srv/app/path/to/data.json'
  ];

  for (const p of realPaths) {
    // Explicit file argument
    const resolvedArg = resolveStoragePath(p, { homedir: fakeHome, stderr: mockStderr });
    assert.equal(resolvedArg, p);

    // Environment variable
    const resolvedEnv = resolveStoragePath(undefined, { env: { SHADOWGRAPH_FILE: p }, homedir: fakeHome, stderr: mockStderr });
    assert.equal(resolvedEnv, p);
  }

  assert.equal(warningCount, 0, 'No warning must be emitted for genuine user paths');
});

test('resolveStoragePath falls back and emits clear stderr warning naming the fallback location for placeholders', () => {
  const fakeHome = join(tmpdir(), 'sg-test-home-' + Math.random().toString(36).slice(2));
  const expectedFallback = join(fakeHome, '.shadowgraph', 'data.json');

  const placeholders = [
    '/absolute/path/to/shared-shadowgraph/data.json',
    'path/to/storage.json',
    '/path/to/storage.json',
    'C:\\path\\to\\storage.json',
    'path/to/storage.sqlite',
    '$SHADOWGRAPH_HOME/data.json',
    '$VAR/data.json',
    '%SHADOWGRAPH_FILE%'
  ];

  for (const placeholder of placeholders) {
    let captured = '';
    const mockStderr = {
      write(chunk) { captured += chunk; }
    };

    const resolved = resolveStoragePath(placeholder, { homedir: fakeHome, stderr: mockStderr });

    assert.equal(resolved, expectedFallback);
    assert.match(captured, /\[shadowgraph\] Warning: storage path ".*" is a template placeholder; falling back to/);
    assert.ok(captured.includes(placeholder), `Stderr should mention placeholder: ${placeholder}`);
    assert.ok(captured.includes(expectedFallback), `Stderr should mention fallback: ${expectedFallback}`);
  }
});

test('shadowgraph doctor surfaces placeholder warnings in storage diagnostics for dispatched sentinels and unexpanded variables', (t) => {
  const fakeHome = join(tmpdir(), 'sg-doctor-home-' + Math.random().toString(36).slice(2));
  mkdirSync(fakeHome, { recursive: true });
  t.after(() => {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
  });

  const cliPath = join(process.cwd(), 'src/cli.js');

  // Initialize storage in fallback directory first via setup
  const setupResult = spawnSync(process.execPath, [cliPath, 'setup'], {
    encoding: 'utf8',
    cwd: fakeHome,
    env: { ...process.env, SHADOWGRAPH_HOME: fakeHome, SHADOWGRAPH_FILE: '' }
  });
  assert.equal(setupResult.status, 0, setupResult.stderr);

  const testPlaceholders = [
    '/absolute/path/to/shared-shadowgraph/data.json',
    'path/to/storage.json',
    '/path/to/storage.json',
    'C:\\path\\to\\storage.json',
    'path/to/storage.sqlite',
    '$SHADOWGRAPH_HOME/data.json',
    '$VAR/data.json',
    '%SHADOWGRAPH_FILE%'
  ];

  for (const placeholder of testPlaceholders) {
    const doctorResult = spawnSync(process.execPath, [cliPath, 'doctor'], {
      encoding: 'utf8',
      cwd: fakeHome,
      env: { ...process.env, SHADOWGRAPH_HOME: fakeHome, SHADOWGRAPH_FILE: placeholder }
    });
    assert.equal(doctorResult.status, 0, `doctor must exit 0 for ${placeholder}: ${doctorResult.stderr}`);
    assert.match(doctorResult.stderr, /Warning: storage path ".*" is a template placeholder/);

    const parsed = JSON.parse(doctorResult.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.storage.placeholder, placeholder);
    assert.equal(parsed.storage.path, join(fakeHome, '.shadowgraph', 'data.json'));
    assert.match(parsed.storage.warning, /is a template placeholder/);
  }
});
