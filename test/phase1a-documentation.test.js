import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync, rmSync } from 'node:fs';

import { join } from 'node:path';
import { resolveStoragePath, isPlaceholderPath, createStorage } from '../src/storage.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

test('copy-ready stdio templates omit SHADOWGRAPH_FILE placeholder by default for safe user-home fallback', () => {
  for (const path of [
    'integrations/claude-code.mcp.json',
    'integrations/cursor.mcp.json',
    'integrations/codex.mcp.toml',
    'integrations/hermes.mcp.yaml'
  ]) {
    const content = read(path);
    assert.ok(!content.includes('SHADOWGRAPH_FILE'), `${path} must omit SHADOWGRAPH_FILE by default`);
    assert.ok(!content.includes('/absolute/path/to/'), `${path} must not contain placeholder path`);
  }
});

test('storage path resolution detects placeholders and safely falls back to user-home storage', () => {
  const fakeHome = join(process.cwd(), 'fake-home');
  const fallbackHomeData = join(fakeHome, '.shadowgraph', 'data.json');

  // isPlaceholderPath detects various placeholder shapes on POSIX and Windows
  assert.equal(isPlaceholderPath('/absolute/path/to/shared-shadowgraph/data.json'), true);
  assert.equal(isPlaceholderPath('C:\\absolute\\path\\to\\shared-shadowgraph\\data.json'), true);
  assert.equal(isPlaceholderPath('<path-to-store>'), true);

  // Additional placeholder shapes (Finding 1 remediation)
  assert.equal(isPlaceholderPath('<absolute-path-to-data.json>'), true);
  assert.equal(isPlaceholderPath('<path-to-data.json>'), true);
  assert.equal(isPlaceholderPath('${SHADOWGRAPH_FILE}'), true);

  // isPlaceholderPath returns false for genuine paths (never substring over-matching)
  assert.equal(isPlaceholderPath('/custom/storage/store.json'), false);
  assert.equal(isPlaceholderPath('C:\\custom-storage\\store.json'), false);
  assert.equal(isPlaceholderPath('./local/store.json'), false);
  assert.equal(isPlaceholderPath('C:\\' + 'Users' + '\\me\\shared-shadowgraph\\data.json'), false);
  assert.equal(isPlaceholderPath('D:\\Work [2026]\\sg.json'), false);
  assert.equal(isPlaceholderPath('/' + 'home' + '/me/placeholder-tests/data.json'), false);
  assert.equal(isPlaceholderPath('/srv/app/path/to/data.json'), false);
  assert.equal(isPlaceholderPath('[path-to-store]'), false);
  assert.equal(isPlaceholderPath('[absolute-path]'), false);
  assert.equal(isPlaceholderPath('placeholder-path'), false);
  assert.equal(isPlaceholderPath('/path/to/data.json'), false);
  assert.equal(isPlaceholderPath('shared-shadowgraph/data.json'), false);

  // resolveStoragePath falls back to user home when env.SHADOWGRAPH_FILE has placeholder
  assert.equal(
    resolveStoragePath(undefined, {
      env: { SHADOWGRAPH_FILE: '/absolute/path/to/shared-shadowgraph/data.json' },
      homedir: fakeHome
    }),
    fallbackHomeData
  );

  // resolveStoragePath falls back to user home on Windows placeholder path
  assert.equal(
    resolveStoragePath(undefined, {
      env: { SHADOWGRAPH_FILE: 'C:\\absolute\\path\\to\\shared-shadowgraph\\data.json' },
      homedir: fakeHome
    }),
    fallbackHomeData
  );

  // resolveStoragePath falls back to user home when explicitFile is a placeholder
  assert.equal(
    resolveStoragePath('/absolute/path/to/shared-shadowgraph/data.json', {
      homedir: fakeHome
    }),
    fallbackHomeData
  );

  // resolveStoragePath preserves genuine explicit path
  assert.equal(
    resolveStoragePath('/real/custom/store.json', { homedir: fakeHome }),
    '/real/custom/store.json'
  );

  // resolveStoragePath preserves genuine env path
  assert.equal(
    resolveStoragePath(undefined, {
      env: { SHADOWGRAPH_FILE: '/real/custom/store.json' },
      homedir: fakeHome
    }),
    '/real/custom/store.json'
  );

  // resolveStoragePath falls back to user home when env has documented README placeholder
  assert.equal(
    resolveStoragePath(undefined, {
      env: { SHADOWGRAPH_FILE: '<absolute-path-to-data.json>' },
      homedir: fakeHome
    }),
    fallbackHomeData
  );

  // resolveStoragePath falls back to user home when explicitFile is documented README placeholder
  assert.equal(
    resolveStoragePath('<absolute-path-to-data.json>', {
      homedir: fakeHome
    }),
    fallbackHomeData
  );

  // resolveStoragePath falls back to user home when env has variable placeholder
  assert.equal(
    resolveStoragePath(undefined, {
      env: { SHADOWGRAPH_FILE: '${SHADOWGRAPH_FILE}' },
      homedir: fakeHome
    }),
    fallbackHomeData
  );
});

test('createStorage redirects placeholder file paths to user-home storage and prevents root pollution', async () => {
  const fakeHome = join(process.cwd(), 'fake-home-create-storage');
  const fallbackHomeData = join(fakeHome, '.shadowgraph', 'data.json');
  const rootAbsoluteDir = process.platform === 'win32' ? 'C:\\absolute' : '/absolute';
  const rootExistedBefore = existsSync(rootAbsoluteDir);

  try {
    // 1. Invoking createStorage with placeholder path safely falls back to user-home storage
    const store = await createStorage({
      file: '/absolute/path/to/shared-shadowgraph/data.json',
      homedir: fakeHome
    });

    // 2. Saving records must write to the fallback location, not C:\absolute
    await store.save([{
      id: 'test-root-safety',
      kind: 'decision',
      title: 'root pollution prevention test',
      chosen: 'safe',
      project: 'test',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }]);

    // 3. Confirm fallback location received data
    assert.equal(existsSync(fallbackHomeData), true, 'Fallback data.json must exist in fakeHome');
    const loaded = await store.load();
    assert.equal(loaded.records.length, 1);
    assert.equal(loaded.records[0].id, 'test-root-safety');

    // 4. Confirm zero drive root pollution
    if (!rootExistedBefore) {
      assert.equal(existsSync(rootAbsoluteDir), false, `Root directory ${rootAbsoluteDir} must not be created`);
    }

    // 5. Also verify README placeholder <absolute-path-to-data.json> with createStorage
    const readmeStore = await createStorage({
      file: '<absolute-path-to-data.json>',
      homedir: fakeHome
    });
    const readmeLoaded = await readmeStore.load();
    assert.equal(readmeLoaded.records.length, 1);
    assert.equal(readmeLoaded.records[0].id, 'test-root-safety');
  } finally {
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    if (!rootExistedBefore && existsSync(rootAbsoluteDir)) {
      try { rmSync(rootAbsoluteDir, { recursive: true, force: true }); } catch {}
    }
  }
});


test('the failed-attempt demo declares its class, project, reason, and environment', () => {
  const demo = read('docs/decision-memory-demo.md');
  for (const fragment of [
    '"project":"checkout-service"',
    '"resultClass":"failed"',
    '"reason":"No shared transactional view"',
    '"environment":"Single-user local checkout prototype"'
  ]) assert.ok(demo.includes(fragment), `demo is missing ${fragment}`);
  assert.match(demo, /acknowledg\w* means seen, not resolved/i);
});

test('retry and scope guidance starts before the first write', () => {
  const policy = read('integrations/agent-policy.md');
  assert.match(policy, /before the first write/i);
  assert.match(policy, /same project and scope/i);
  assert.match(policy, /run-scoped memory does not automatically survive across runs/i);
});

test('current-facing guidance preserves the v0.44 profile inventories', () => {
  assert.match(read('integrations/README.md'), /SHADOWGRAPH_MCP_COMPACT=1`: 16 workflow tools/);
  assert.match(read('integrations/README.md'), /verifies 35 full and 16 compact tools/);
  assert.match(read('docs/unified-memory.md'), /Compact mode includes both workflows and remains exactly 16 tools\./);
  assert.match(read('docs/api-reference.md'), /SHADOWGRAPH_MCP_COMPACT=1` advertises 16 tools instead of 35\./);
  assert.match(read('.github/workflows/ci.yml'), /Strict MCP Inspector \(35 full \/ 16 compact \/ 20 workflow\)/);
});

test('Phase 1A release notes disclose the compatibility boundary', () => {
  for (const path of ['CHANGELOG.md', 'RELEASE_NOTES.md']) {
    const document = read(path);
    const start = document.indexOf('## 0.44.1');
    assert.notEqual(start, -1, `${path} needs a 0.44.1 entry`);
    const next = document.indexOf('\n## ', start + 1);
    const entry = document.slice(start, next === -1 ? undefined : next);
    assert.match(entry, /Phase 1A/);
    assert.match(entry, /16-tool compact/);
    assert.match(entry, /resultClass/);
    assert.match(entry, /CLI and JavaScript callers/);
    assert.match(entry, /older stored attempts/);
    assert.match(entry, /wording-based fallback/);
    assert.match(entry, /fact `value`/);
    assert.match(entry, /alternative `label`/);
    assert.ok(entry.includes('error.data'), `${path} must locate legacy error details`);
    assert.ok(entry.includes("result._meta['shadowgraph/error']"), `${path} must locate modern error details`);
  }
});

test('API reference documents optional resultClass with wording fallback', () => {
  assert.match(
    read('docs/api-reference.md'),
    /attempts require `solution` and `result`; facts require `key` and `value`\./
  );
  assert.match(
    read('docs/api-reference.md'),
    /Attempt `resultClass` is optional across all surfaces \(failed, succeeded, inconclusive\); when omitted, callers retain the wording-based fallback\./
  );
});

test('v0.44.3 release notes and documentation disclose all fixes and release metadata', () => {
  for (const path of ['CHANGELOG.md', 'RELEASE_NOTES.md']) {
    const document = read(path);
    const start = document.indexOf('## 0.44.3');
    assert.notEqual(start, -1, `${path} needs a 0.44.3 entry`);
    const next = document.indexOf('\n## ', start + 1);
    const entry = document.slice(start, next === -1 ? undefined : next);
    assert.match(entry, /compact/i);
    assert.match(entry, /resultClass/);
    assert.match(entry, /fieldPath/);
    assert.match(entry, /SHADOWGRAPH_FILE/);
  }

  const notes = read('RELEASE_NOTES.md');
  assert.match(notes, /86431/);
  assert.match(notes, /3758827/);
  assert.match(notes, /local self-estimate/i);

  const policy = read('integrations/agent-policy.md');
  assert.match(policy, /decisionStatus/);
  assert.match(policy, /supersedes/);

  const readme = read('README.md');
  assert.match(readme, /Release-v0\.44\.3-blue/);
  assert.match(readme, /releases\/tag\/v0\.44\.3/);
  assert.match(readme, /releases\/download\/v0\.44\.3\/shadowgraph-unified-plugin-0\.44\.3\.tgz/);
  assert.match(readme, /\*\*Release v0\.44\.3\*\*/);

  const manifest = JSON.parse(read('package.json'));
  assert.equal(manifest.version, '0.44.3');

  const lockfile = JSON.parse(read('package-lock.json'));
  assert.equal(lockfile.version, '0.44.3');
  assert.equal(lockfile.packages?.['']?.version, '0.44.3');
});

