// Tests for the public-repository hygiene guard.
//
// Every "leak" here is assembled at runtime from harmless fragments and handed
// straight to an exported detector, so no forbidden value exists in this file's
// tracked source. Nothing here is a real path, account, or credential.
//
// This file is deliberately NOT allowlisted, and there is no marker or magic
// comment to exempt a line: a real path pasted anywhere in it is still reported.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ALLOWED, commitViolations, isAllowed, treeLineCategories, treePathCategories } from '../scripts/check-public-hygiene.mjs';

// Every forbidden-looking fixture is assembled at runtime from harmless
// fragments, so no literal machine path exists in this file's source. That is
// what keeps the tracked tree clean here: no magic comment, no allowlist entry,
// nothing for a reviewer to take on trust.
const BACKSLASH = String.fromCharCode(92);
const winHome = ['C:', BACKSLASH, 'Users', BACKSLASH, 'fixture-person', BACKSLASH].join('');
const windowsPath = (...parts) => ['C:', 'Users', ...parts].join(BACKSLASH);
const posixHome = (...parts) => ['', 'home', ...parts].join('/');
const wslMount = (drive, ...parts) => ['', 'mnt', drive, ...parts].join('/');
const toolState = (tool, ...parts) => [`.${tool}`, ...parts].join('/');
const generatedWith = (name, url) => `Generated with [${name}](${url})`;
const privateKeyHeader = `-----BEGIN ${'PRIVATE'} KEY-----`;

const categories = (line, path = 'docs/example.md') => treeLineCategories(line, path);

// --- it catches what it must ------------------------------------------------

test('a Windows home path is caught', () => {
  assert.ok(categories(`backed up at ${winHome}project\\notes.md`).includes('absolute-windows-profile-path'));
});

test('a WSL user-home path is caught', () => {
  assert.ok(categories(`worktree at ${wslMount('c', 'work', 'fixture-repo')}`).includes('wsl-mount-path'));
  assert.ok(categories(`see ${wslMount('d', 'Users', 'fixture-person', 'notes.md')}`).includes('wsl-mount-path'));
});

test('a Linux home path is caught', () => {
  assert.ok(categories(`config at ${posixHome('fixture-person', '.config', 'tool.json')}`).includes('absolute-posix-profile-path'));
});

test('a local assistant backup or scratch path is caught', () => {
  for (const fragment of [toolState('claude', 'backups', 'project', 'config.bak'), toolState('codex', 'sessions', 'run.json'), toolState('cursor', 'cache', 'index'), toolState('serena', 'state', 'memory')]) {
    assert.ok(
      categories(`stored at ${fragment}`).includes('local-assistant-path'),
      `${fragment} must be caught`
    );
  }
});

test('an assistant path under a real home directory is caught twice over', () => {
  const found = categories(`${winHome}.claude\\backups\\project\\config.bak`);
  assert.ok(found.includes('absolute-windows-profile-path'));
  assert.ok(found.includes('local-assistant-path'));
});

test('private-key material is caught, in tests as well as elsewhere', () => {
  assert.ok(categories(privateKeyHeader).includes('credential-literal'));
  assert.ok(
    treeLineCategories(privateKeyHeader, 'test/example.test.js').includes('credential-literal'),
    'the test surface is not exempt from key material'
  );
});

test('assistant attribution and session metadata in tracked content are caught', () => {
  assert.ok(categories('Co-Authored-By: Some Assistant <bot@example.invalid>').includes('assistant-attribution'));
  assert.ok(categories('Generated-By: some-tool').includes('assistant-attribution'));
  assert.ok(categories(generatedWith('Some Tool', 'https://example.invalid/tool')).includes('assistant-attribution'));
  assert.ok(categories('Session-Id: abc-123').includes('session-metadata'));
});

test('a development-process filename is caught in any tracked directory', () => {
  for (const path of [
    // The directories the rule used to be limited to.
    'test/codex-review-regressions.test.js',
    'test/chatgpt-notes.test.js',
    'src/claude-session-notes.js',
    'scripts/codex-findings.mjs',
    // Everywhere else, which is what the scope gap missed.
    'docs/codex-notes.md',
    'docs/claude-review.md',
    'benchmark/agent-session-notes.md',
    'docs/contracts/gemini-rereview.md',
    'benchmark/evidence/copilot-transcript.md',
    'claude-handoff.md',
    'assistant-scratch.json',
    'docs/gpt-reproduction.md',
    'tools/aider-prompt-log.txt'
  ]) {
    assert.ok(treePathCategories(path).includes('process-trace-filename'), `${path} must be caught`);
  }
});

test('legitimate product and integration filenames are still allowed', () => {
  for (const path of [
    // A provider or tool name alone is never enough.
    'integrations/claude-code.mcp.json',
    'integrations/codex.mcp.toml',
    'integrations/cursor.mcp.json',
    'integrations/agent-policy.md',
    'integrations/hermes-agent.py',
    'integrations/openclaw-tool.example.json',
    // Product vocabulary that happens to use a process word.
    'docs/handoff/cycle-status.md',
    'src/revision-store.js',
    'test/review-conditions.test.js',
    'test/review-safety-regressions.test.js',
    'docs/contracts/review-conditions-contract.md',
    'benchmark/CANDIDATE-STATUS.md'
  ]) {
    assert.deepEqual(treePathCategories(path), [], `${path} must be allowed`);
  }
});

test('every tracked filename carrying a tool name is classified deliberately', () => {
  // The five that exist today are all integration product surface.
  for (const path of ['integrations/agent-policy.md', 'integrations/claude-code.mcp.json', 'integrations/codex.mcp.toml', 'integrations/cursor.mcp.json', 'integrations/hermes-agent.py']) {
    assert.deepEqual(treePathCategories(path), [], `${path} is product surface`);
  }
});

test('an accidental result, database or log artifact is caught', () => {
  for (const path of ['benchmark/results/run-1/aggregate.json', 'data/graph.db', 'data/graph.sqlite-wal', 'logs/server.log', '.env', 'config/.env.local', '.claude/settings.json']) {
    assert.ok(treePathCategories(path).includes('forbidden-tracked-artifact'), `${path} must be caught`);
  }
});

// --- it allows what it must -------------------------------------------------

test('ordinary source paths and content are allowed', () => {
  assert.deepEqual(categories("import { createShadowGraph } from '../src/shadowgraph.js';", 'src/cli.js'), []);
  assert.deepEqual(categories("const directory = await scratchDirectory(t, 'review-ack-parity-');", 'test/x.test.js'), []);
  assert.deepEqual(treePathCategories('src/condition-eval.js'), []);
  assert.deepEqual(treePathCategories('test/rule-operand-regressions.test.js'), []);
  assert.deepEqual(treePathCategories('test/review-acknowledgement-regressions.test.js'), []);
});

test('sanitized placeholders are allowed', () => {
  assert.deepEqual(categories('backed up outside the repository at `<local-backup-path>`'), []);
  assert.deepEqual(categories('- **Worktree:** `<repo-root>` (dedicated benchmark worktree)'), []);
  assert.deepEqual(categories('copy the template into `<user-home>`'), []);
});

test('supported-client documentation is allowed', () => {
  assert.deepEqual(categories('Copy `cursor.mcp.json` to project `.cursor/mcp.json` or user `~/.cursor/mcp.json`:'), []);
  assert.deepEqual(categories('Or append `codex.mcp.toml` to `~/.codex/config.toml`:'), []);
  assert.deepEqual(treePathCategories('integrations/claude-code.mcp.json'), [], 'a client template is product surface');
  assert.deepEqual(treePathCategories('integrations/agent-policy.md'), [], 'a product policy doc is not a process trace');
});

test('research citations and bare environment variable names are allowed', () => {
  assert.deepEqual(categories('### Anthropic contextual retrieval — out of scope'), []);
  assert.deepEqual(categories("  'ANTHROPIC_API_KEY',", 'benchmark/lib/capabilities.mjs'), []);
  assert.deepEqual(categories('Set `SHADOWGRAPH_MCP_COMPACT=1` to advertise the compact tool set.'), []);
});

test('the test surface keeps its synthetic credential fixtures', () => {
  // Credential NAME/VALUE heuristics are the part of the package classifier the
  // fixture corpus legitimately trips; they stay on the published surface.
  assert.deepEqual(treeLineCategories("  endpointPassword: 'FIXTURE_SENTINEL_0000',", 'test/x.test.js'), []);
  assert.deepEqual(treeLineCategories("  ['AWS access key', 'AKIA1234567890ABCDEF', 'CREDENTIAL'],", 'test/x.test.js'), []);
  assert.deepEqual(treeLineCategories("    hostPath: '/repo/benchmark/adapters/host.py',", 'test/x.test.js'), [], 'a container mount is not a home path');
});

// --- an ordinary test file is NOT exempt from machine paths -----------------
//
// The earlier guard exempted all of test/ from the reused classifier, so a real
// engineer's home directory pasted into an ordinary regression test was silently
// accepted. These pin that it is not.

const ordinaryTest = 'test/some-feature-regressions.test.js';

test('an ordinary test file still reports a Windows user-home path', () => {
  assert.ok(
    treeLineCategories(`const root = '${winHome}private-repo';`, ordinaryTest).includes('absolute-windows-profile-path')
  );
});

test('an ordinary test file still reports a Linux user-home path', () => {
  assert.ok(
    treeLineCategories(`const root = '${posixHome('actual-engineer', 'private-repo')}';`, ordinaryTest).includes('absolute-posix-profile-path')
  );
});

test('an ordinary test file still reports a WSL mounted user-home path', () => {
  assert.ok(
    treeLineCategories(`const root = '${wslMount('c', 'Users', 'actual-engineer', 'private-repo')}';`, ordinaryTest).includes('wsl-mount-path')
  );
});

test('an ordinary test file still reports a local assistant state path', () => {
  assert.ok(
    treeLineCategories(`const backup = '${toolState('claude', 'backups', 'project', 'config.bak')}';`, ordinaryTest).includes('local-assistant-path')
  );
});

test('no trailing comment can switch the detectors off', () => {
  const leak = `const root = '${winHome}private-repo';`;
  for (const suffix of ['', ' // synthetic', ' // test fixture', ' // not a real path', ' // ignore']) {
    assert.ok(
      treeLineCategories(leak + suffix, ordinaryTest).length > 0,
      `a comment must not exempt the line: ${JSON.stringify(suffix)}`
    );
  }
});

// --- no text in authored content may switch the detectors off ---------------
//
// An earlier revision skipped any line containing a marker substring, which meant
// a directory merely NAMED like the marker, or an unrelated comment on the same
// line, disabled every detector -- in src/, docs/, scripts/ and ordinary tests
// alike.

const MARKER = ['hygiene', 'fixture'].join('-');

test('a path segment named like the fixture marker is still detected', () => {
  const surfaces = ['src/thing.js', 'docs/guide.md', 'scripts/tool.mjs', 'test/some-feature-regressions.test.js'];
  const cases = [
    ['absolute-posix-profile-path', posixHome('private-user', MARKER, 'work')],
    ['absolute-windows-profile-path', windowsPath('private-user', MARKER, 'work')],
    ['wsl-mount-path', wslMount('c', 'Users', 'private-user', MARKER, 'work')]
  ];
  for (const surface of surfaces) {
    for (const [expected, value] of cases) {
      assert.ok(
        treeLineCategories(`const root = '${value}';`, surface).includes(expected),
        `${surface}: ${expected} must survive a path segment named ${MARKER}`
      );
    }
  }
});

test('a comment mentioning the fixture marker does not suppress a real path beside it', () => {
  for (const surface of ['src/thing.js', 'docs/guide.md', 'scripts/tool.mjs', 'test/some-feature-regressions.test.js']) {
    assert.ok(
      treeLineCategories(`const root = '${posixHome('private-user', 'work')}'; // ${MARKER}`, surface)
        .includes('absolute-posix-profile-path'),
      `${surface}: a comment must not switch the detectors off`
    );
  }
});

test('prose containing the fixture marker does not suppress detection', () => {
  assert.ok(
    treeLineCategories(`see ${posixHome('private-user', 'work')} <!-- ${MARKER} -->`, 'docs/guide.md')
      .includes('absolute-posix-profile-path')
  );
});

test('the allowlist exempts an exact path for exact categories, and nothing else', () => {
  // Same class of defect as the marker: an entry must never switch off a
  // category it did not name.
  assert.ok(isAllowed('.gitignore', 'local-hermes-path'), 'the named category is exempt');
  for (const category of ['absolute-posix-profile-path', 'absolute-windows-profile-path', 'wsl-mount-path', 'credential-literal', 'local-assistant-path']) {
    assert.equal(isAllowed('.gitignore', category), false, `${category} is not exempt in .gitignore`);
  }
  assert.equal(isAllowed('src/shadowgraph.js', 'absolute-posix-profile-path'), false, 'product source is never exempt');
  assert.equal(isAllowed('test/some-feature-regressions.test.js', 'absolute-posix-profile-path'), false, 'an ordinary test is never exempt');
  assert.equal(isAllowed('scripts/check-package.mjs', 'local-hermes-path'), false, 'a file needing no exemption has none');
});

test('every allowlist entry names its categories and its reason', () => {
  assert.ok(ALLOWED.length > 0);
  for (const entry of ALLOWED) {
    assert.equal(typeof entry.path, 'string');
    assert.ok(Array.isArray(entry.categories) && entry.categories.length > 0, `${entry.path} must name at least one category`);
    assert.ok(entry.reason && entry.reason.length > 10, `${entry.path} must say why`);
    assert.ok(!entry.categories.includes('*'), 'no wildcard category');
  }
  assert.ok(!ALLOWED.some((entry) => entry.path.startsWith('src/')), 'no product source is allowlisted');
});

test('synthetic detector fixtures are testable without tracking a real violation', () => {
  // Constructed at runtime and handed straight to the exported detector: the
  // value exists only while the test runs, so the tracked source stays clean.
  const value = posixHome('private-user', 'work');
  assert.ok(treeLineCategories(value, 'src/thing.js').includes('absolute-posix-profile-path'));
  assert.deepEqual(treeLineCategories(`const home = posixHome('private-user', 'work');`, 'src/thing.js'), [],
    'the builder call itself carries no path');
});

test('neutral technical test content is still allowed', () => {
  for (const line of [
    "const store = createJsonFileStore(join(directory, 'graph.json'));",
    "const directory = await scratchDirectory(t, 'operand-parity-');",
    "assert.equal(graph.context({ project: 'p' }).openReviews.length, 0);",
    '// Regressions protecting rule-operand handling.'
  ]) {
    assert.deepEqual(treeLineCategories(line, ordinaryTest), [], line);
  }
});

// --- history mode -----------------------------------------------------------

const commit = (body, author = 'LiLara-AI <253868849+LiLara-AI@users.noreply.github.com>') => ({
  sha: '0'.repeat(40), author, committer: author, body
});

test('history mode catches an assistant co-author trailer', () => {
  const found = commitViolations(commit('Improve retrieval\n\nCo-Authored-By: Some Assistant <bot@example.invalid>'));
  assert.deepEqual(found.map((item) => item.category), ['assistant-attribution-trailer']);
});

test('history mode catches generated-by and session metadata', () => {
  assert.equal(commitViolations(commit('x\n\nGenerated-By: some-tool')).length, 1);
  assert.equal(commitViolations(commit('x\n\nSession-Id: abc-123'))[0].category, 'session-metadata');
  assert.equal(commitViolations(commit(`x\n\n${generatedWith('Some Tool', 'https://example.invalid/t')}`)).length, 1);
});

test('history mode catches generation attribution written as prose', () => {
  for (const body of [
    'Generated by Claude Opus 5',
    'Improve retrieval\n\nWritten with Copilot assistance.',
    'Fix parser\n\nco-authored by Codex',
    'Refactor\n\nDrafted using ChatGPT.',
    'Tidy\n\nImplemented by an AI agent.'
  ]) {
    const found = commitViolations(commit(body)).map((item) => item.category);
    assert.ok(found.includes('assistant-attribution-prose'), `${JSON.stringify(body)} must be caught`);
  }
});

test('history mode catches an assistant sign-off trailer', () => {
  const found = commitViolations(commit('Improve retrieval\n\nSigned-off-by: Claude <noreply@anthropic.com>'));
  assert.deepEqual(found.map((item) => item.category), ['assistant-attribution-trailer']);
});

test('history mode catches assistant attribution across every attribution key', () => {
  for (const key of ['Co-Authored-By', 'Signed-off-by', 'Authored-By', 'Assisted-By', 'On-Behalf-Of', 'Committed-By']) {
    const found = commitViolations(commit(`x\n\n${key}: Claude Opus 5 <noreply@anthropic.com>`));
    assert.deepEqual(found.map((item) => item.category), ['assistant-attribution-trailer'], key);
  }
});

test('history mode does not flag technical subject matter', () => {
  // Naming a provider, model or supported client is product vocabulary. Only an
  // attribution construction counts.
  for (const body of [
    'Add Claude Code integration template',
    'Document the OpenAI-compatible embedding endpoint',
    'Cite Anthropic contextual retrieval research as out of scope',
    'Add Codex CLI configuration to integrations/',
    'Support Gemini and Cursor as MCP clients',
    'Rename ANTHROPIC_API_KEY handling in the capability probe',
    'Explain why the model name is redacted from the provider ledger'
  ]) {
    assert.deepEqual(commitViolations(commit(body)), [], body);
  }
});

test('history mode separates a human co-author from an assistant one', () => {
  const identity = 'LiLara-AI <253868849+LiLara-AI@users.noreply.github.com>';
  const human = commit('Fix parser\n\nCo-Authored-By: Real Person <person@example.invalid>');

  assert.deepEqual(commitViolations(human), [], 'a human co-author is not assistant attribution');
  assert.deepEqual(
    commitViolations(human, identity).map((item) => item.category),
    ['unexpected-attribution-trailer'],
    'but owner-only history still reports it, under its own category'
  );
  assert.deepEqual(
    commitViolations(commit('Fix parser\n\nSigned-off-by: LiLara-AI <253868849+LiLara-AI@users.noreply.github.com>'), identity),
    [],
    'a sign-off matching the release identity passes'
  );
});

test('history mode enforces an identity only when one is supplied', () => {
  const identity = 'LiLara-AI <253868849+LiLara-AI@users.noreply.github.com>';
  const outside = { sha: 'a'.repeat(40), author: 'Contributor <dev@example.invalid>', committer: 'Contributor <dev@example.invalid>', body: 'Fix typo' };

  assert.deepEqual(commitViolations(outside), [], 'a third-party contribution passes when no identity policy is supplied');
  assert.deepEqual(
    commitViolations(outside, identity).map((item) => item.category).sort(),
    ['unexpected-author', 'unexpected-committer']
  );
  assert.deepEqual(commitViolations(commit('Improve decision review and retrieval'), identity), [], 'the release identity passes');
});

test('a clean neutral commit message passes history mode', () => {
  assert.deepEqual(commitViolations(commit('Improve decision review and retrieval')), []);
  assert.deepEqual(
    commitViolations(commit('Fix review coverage\n\nThe co-authored work on this module is described in docs/.')),
    [],
    'prose mentioning co-authorship is not a trailer'
  );
});
