// The Claude Code hook template and `install-hooks` / `uninstall-hooks`. Every CLI run here points HOME and
// USERPROFILE at a scratch directory and runs from it, so no test can reach the real ~/.claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, symlinkSync } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { scratchDirectory } from '../tools/scratch-directory.js';
import { changeHookSettings, isShadowGraphHandler, runtimeHookCommand, shadowGraphHookKind, withoutShadowGraphHooks, withShadowGraphHooks } from '../src/host-hooks.js';

const CLI = resolve('src/cli.js');
const template = JSON.parse(readFileSync('integrations/claude-code.hooks.json', 'utf8'));
const COMMAND = 'shadowgraph deliver --hook';
const handler = template.hooks.SessionStart[0].hooks[0];
const formatted = (value) => `${JSON.stringify(value, null, 2)}\n`;
// The file's own path, as the verbs report it (the temporary directory may itself be reached through a link).
const real = (path) => join(existsSync(dirname(path)) ? realpathSync.native(dirname(path)) : real(dirname(path)), basename(path));

function run(args, home, env = {}) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: home, env: { ...process.env, HOME: home, USERPROFILE: home, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end();
    child.on('close', (code) => settle({ code, stdout, stderr }));
  });
}

const ours = (settings) => Object.values(settings.hooks ?? {}).flat().flatMap((group) => group.hooks ?? []).filter(isShadowGraphHandler);
const unrelated = () => ({
  model: 'opus',
  permissions: { allow: ['Bash(npm test)'] },
  hooks: {
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo prompt', timeout: 5 }] }],
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'lint-guard' }] }]
  }
});

test('the template holds only command handlers at SessionStart and UserPromptSubmit, each with a timeout', () => {
  assert.deepEqual(Object.keys(template), ['hooks']);
  assert.deepEqual(Object.keys(template.hooks).sort(), ['SessionStart', 'UserPromptSubmit']);
  for (const groups of Object.values(template.hooks)) {
    assert.equal(groups.length, 1);
    assert.deepEqual(Object.keys(groups[0]), ['hooks']);
    assert.deepEqual(groups[0].hooks, [handler]);
  }
  assert.deepEqual(Object.keys(handler), ['type', 'command', 'timeout']);
  assert.deepEqual([handler.type, handler.command], ['command', COMMAND]);
  assert.ok(Number.isInteger(handler.timeout) && handler.timeout > 0);
});

test('install keeps every unrelated setting and hook, and leaves exactly one ShadowGraph handler per event', () => {
  const before = unrelated();
  const frozen = structuredClone(before);
  const installed = withShadowGraphHooks(before, template);
  assert.deepEqual(before, frozen, 'the input is not changed');
  assert.deepEqual(withoutShadowGraphHooks(installed), before);
  for (const event of ['SessionStart', 'UserPromptSubmit']) {
    assert.equal(installed.hooks[event].flatMap((group) => group.hooks).filter(isShadowGraphHandler).length, 1, event);
  }
  assert.deepEqual(installed.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.deepEqual(installed.hooks.UserPromptSubmit[0], before.hooks.UserPromptSubmit[0]);
  // A list or map that was empty before an install is not kept by the uninstall (the same settings in effect).
  assert.deepEqual(withoutShadowGraphHooks(withShadowGraphHooks({ hooks: {} }, template)), {});
});

test('install twice, or over an older generation, leaves one generation and no duplicate', () => {
  const twice = withShadowGraphHooks(withShadowGraphHooks(unrelated(), template), template);
  assert.deepEqual(ours(twice), [handler, handler]);
  const older = unrelated();
  older.hooks.SessionStart = [{ hooks: [{ type: 'command', command: 'shadowgraph deliver --hook --legacy', timeout: 3 }] }];
  older.hooks.UserPromptSubmit[0].hooks.push({ type: 'command', command: 'node /opt/shadowgraph/src/cli.js deliver --hook', timeout: 3 });
  const upgraded = withShadowGraphHooks(older, template);
  assert.deepEqual(ours(upgraded), [handler, handler]);
  assert.deepEqual(upgraded.hooks.UserPromptSubmit[0].hooks, [{ type: 'command', command: 'echo prompt', timeout: 5 }], 'an unrelated handler sharing a group keeps its place');
  assert.ok(!isShadowGraphHandler({ type: 'command', command: 'echo deliver --hook' }), 'a command that is not ShadowGraph is not taken');
  assert.ok(!isShadowGraphHandler({ type: 'mcp_tool', command: COMMAND }));
});

test('install then uninstall gives back the settings file byte for byte, and a hooks key it added is removed', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-hooks-');
  for (const original of [unrelated(), { model: 'opus' }]) {
    const settings = join(home, 'host-hooks-fixture.json');
    await writeFile(settings, formatted(original));
    const installed = await run(['install-hooks', '--settings', settings], home);
    assert.equal(installed.code, 0, installed.stderr);
    const result = JSON.parse(installed.stdout);
    assert.deepEqual([result.settings, result.changed, result.events], [real(settings), true, ['SessionStart', 'UserPromptSubmit']]);
    assert.equal(ours(JSON.parse(await readFile(settings, 'utf8'))).length, 2);
    const removed = await run(['uninstall-hooks', '--settings', settings], home);
    assert.equal(removed.code, 0, removed.stderr);
    assert.deepEqual(JSON.parse(removed.stdout), { settings: real(settings), changed: true, removed: 2 });
    assert.equal(await readFile(settings, 'utf8'), formatted(original));
  }
});

test('nothing to change writes nothing: an absent file stays absent, and a second install or uninstall leaves the file untouched', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-hooks-');
  const absent = join(home, 'absent-fixture.json');
  const none = await run(['uninstall-hooks', '--settings', absent], home);
  assert.equal(none.code, 0, none.stderr);
  assert.deepEqual(JSON.parse(none.stdout), { settings: real(absent), changed: false, removed: 0 });
  assert.equal(existsSync(absent), false);
  const settings = join(home, 'host-hooks-fixture.json');
  await writeFile(settings, formatted({ model: 'opus' }));
  const untouched = statSync(settings).mtimeMs;
  assert.equal(JSON.parse((await run(['uninstall-hooks', '--settings', settings], home)).stdout).changed, false);
  assert.equal(statSync(settings).mtimeMs, untouched);
  await run(['install-hooks', '--settings', settings], home);
  // The current generation already in place, even ahead of a later group, is left as it is.
  const reordered = JSON.parse(await readFile(settings, 'utf8'));
  reordered.hooks.SessionStart.push({ matcher: 'compact', hooks: [{ type: 'command', command: 'echo compacted' }] });
  await writeFile(settings, formatted(reordered));
  const stamp = statSync(settings).mtimeMs;
  assert.equal(JSON.parse((await run(['install-hooks', '--settings', settings], home)).stdout).changed, false);
  assert.equal(statSync(settings).mtimeMs, stamp);
  assert.equal(await readFile(settings, 'utf8'), formatted(reordered));
});

test('settings that are not a JSON object, or hooks it does not recognise, are refused with the file unchanged', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-hooks-');
  const settings = join(home, 'host-hooks-fixture.json');
  for (const text of ['{ "model": ', '[]', 'null', '"text"', formatted({ hooks: [] }), formatted({ hooks: { SessionStart: {} } })]) {
    await writeFile(settings, text);
    for (const verb of ['install-hooks', 'uninstall-hooks']) {
      const result = await run([verb, '--settings', settings], home);
      assert.equal(result.code, 1, `${verb} ${text}`);
      assert.match(result.stderr, new RegExp(`ShadowGraph ${verb} failed: settings_`));
      assert.equal(await readFile(settings, 'utf8'), text);
    }
  }
});

test('host settings, whatever name reaches them, change only after the owner confirms at a terminal', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-hooks-');
  const refusedAt = async (args, file, env) => {
    const result = await run(args, home, env);
    assert.equal(result.code, 1, args.join(' '));
    assert.ok(result.stderr.includes('hook_settings_require_owner_confirmation') && result.stderr.includes(real(file)), result.stderr);
  };
  const defaultPath = join(home, '.claude', 'settings.json');
  await refusedAt(['install-hooks'], defaultPath);
  assert.equal(existsSync(join(home, '.claude')), false, 'nothing was created');
  await mkdir(join(home, '.claude'));
  await writeFile(defaultPath, formatted({ model: 'opus' }));
  // The same file through a junction, and through its short (8.3) name where the volume keeps one.
  symlinkSync(join(home, '.claude'), join(home, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await refusedAt(['install-hooks', '--settings', join(home, 'linked', 'settings.json')], defaultPath);
  if (process.platform === 'win32') {
    const short = execFileSync('cmd', ['/d', '/c', `for %A in ("${defaultPath}") do @echo %~sA`], { encoding: 'utf8' }).trim();
    if (short !== defaultPath) await refusedAt(['install-hooks', '--settings', short], defaultPath);
  }
  assert.equal(await readFile(defaultPath, 'utf8'), formatted({ model: 'opus' }));
  // A file not there yet is found through its nearest parent, so the junction leads into .claude as well.
  await refusedAt(['install-hooks', '--settings', join(home, 'linked', 'absent-fixture.json')], join(home, '.claude', 'absent-fixture.json'));
  assert.equal(existsSync(join(home, '.claude', 'absent-fixture.json')), false);
  // Outside the temporary directory every file asks, whatever its name (here the child's temporary directory is moved).
  const temporary = join(home, 'temporary');
  await mkdir(temporary);
  const outside = join(home, 'outside-fixture.json');
  await refusedAt(['install-hooks', '--settings', outside], outside, { TMP: temporary, TEMP: temporary, TMPDIR: temporary });
  assert.equal(existsSync(outside), false);
  // Inside it, a name Claude Code reads still asks; and a temporary directory that cannot be found makes nothing scratch.
  for (const name of ['managed-settings.json', 'settings.json', 'settings.local.json', 'hooks.json', '.claude.json']) {
    await refusedAt(['install-hooks', '--settings', join(home, name)], join(home, name), { TMP: home, TEMP: home, TMPDIR: home });
    assert.equal(existsSync(join(home, name)), false, name);
  }
  const gone = join(home, 'no-such-temporary');
  await refusedAt(['install-hooks', '--settings', join(home, 'scratch-fixture.json')], join(home, 'scratch-fixture.json'), { TMP: gone, TEMP: gone, TMPDIR: gone });
  for (const other of [join(home, '.claude', 'plugins', 'p', 'hooks', 'hooks.json'), join(home, 'project', '.claude', 'settings.local.json'), join(home, '.claude.json')]) {
    await refusedAt(['install-hooks', '--settings', other], other);
    assert.equal(existsSync(other), false, other);
  }
  // Removing needs the confirmation too; with nothing to remove there is nothing to confirm.
  const hooked = formatted(withShadowGraphHooks({ model: 'opus' }, template));
  await writeFile(defaultPath, hooked);
  await refusedAt(['uninstall-hooks'], defaultPath);
  assert.equal(await readFile(defaultPath, 'utf8'), hooked);
  await writeFile(defaultPath, formatted({ model: 'opus' }));
  assert.equal((await run(['uninstall-hooks'], home)).code, 0);
});

test('a link to a settings file stays a link: the file it reaches is the one that changes', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-hooks-');
  await mkdir(join(home, 'real'));
  await writeFile(join(home, 'real', 'host-hooks-fixture.json'), formatted({ model: 'opus' }));
  symlinkSync(join(home, 'real'), join(home, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  const result = await run(['install-hooks', '--settings', join(home, 'link', 'host-hooks-fixture.json')], home);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).settings, real(join(home, 'real', 'host-hooks-fixture.json')));
  assert.ok(lstatSync(join(home, 'link')).isSymbolicLink());
  assert.equal(ours(JSON.parse(await readFile(join(home, 'real', 'host-hooks-fixture.json'), 'utf8'))).length, 2);
});

test('a settings file changed while the owner decides is not overwritten', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-hooks-');
  const settings = join(home, 'host-hooks-fixture.json');
  await writeFile(settings, formatted({ model: 'opus' }));
  const meanwhile = formatted({ model: 'sonnet' });
  await assert.rejects(changeHookSettings(settings, 'install', { afterConfirmation: () => writeFile(settings, meanwhile) }), /settings_changed_while_confirming/u);
  assert.equal(await readFile(settings, 'utf8'), meanwhile);
});

test('the verbs take only --settings <path>, and a flag without its path touches nothing', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-hooks-');
  for (const args of [['install-hooks', '--settings'], ['install-hooks', 'extra'], ['install-hooks', 'extra', '--settings'], ['install-hooks', '--settings', '--settings'], ['uninstall-hooks', '--settings', join(home, 'a.json'), 'extra']]) {
    const result = await run(args, home);
    assert.equal(result.code, 1, args.join(' '));
    assert.match(result.stderr, /Usage: shadowgraph (?:un)?install-hooks \[--capture\] \[--settings <path>\]/u);
  }
  assert.equal(existsSync(join(home, '.claude')), false);
  assert.equal(existsSync(join(home, 'a.json')), false);
  assert.equal(existsSync(join(home, '--settings')), false);
});

test('check-integrations refuses a hook template with another event, type or command, no timeout, or an async key', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-hooks-');
  await cp('scripts/check-integrations.mjs', join(root, 'scripts', 'check-integrations.mjs'));
  await cp('integrations', join(root, 'integrations'), { recursive: true });
  await cp('src', join(root, 'src'), { recursive: true });
  await cp('package.json', join(root, 'package.json'));
  const check = () => new Promise((settle) => {
    const child = spawn(process.execPath, [join(root, 'scripts', 'check-integrations.mjs')], { stdio: 'ignore' });
    child.on('close', settle);
  });
  assert.equal(await check(), 0, 'the shipped templates pass');
  const variants = [
    { hooks: { ...template.hooks, PreToolUse: template.hooks.SessionStart } },
    { hooks: { ...template.hooks, SessionStart: [{ hooks: [{ ...handler, type: 'mcp_tool' }] }] } },
    { hooks: { ...template.hooks, SessionStart: [{ hooks: [{ ...handler, command: 'shadowgraph deliver' }] }] } },
    { hooks: { ...template.hooks, SessionStart: [{ hooks: [{ type: 'command', command: COMMAND }] }] } },
    { hooks: { ...template.hooks, SessionStart: [{ hooks: [{ ...handler, timeout: 0 }] }] } },
    { hooks: { ...template.hooks, SessionStart: [{ hooks: [{ ...handler, async: true }] }] } }
  ];
  for (const variant of variants) {
    await writeFile(join(root, 'integrations', 'claude-code.hooks.json'), formatted(variant));
    assert.notEqual(await check(), 0, JSON.stringify(variant));
  }
});

test('the delivery and capture kinds install and uninstall independently, and the recogniser knows both', async (t) => {
  const captureTemplate = JSON.parse(readFileSync('integrations/claude-code.capture-hooks.json', 'utf8'));
  const kinds = (settings) => Object.values(settings.hooks ?? {}).flat().flatMap((group) => group.hooks ?? []).map(shadowGraphHookKind).filter(Boolean).sort();
  assert.deepEqual(['shadowgraph deliver --hook', '"C:/n/node.exe" "C:/x/shadowgraph/runtime/abc/src/cli.js" capture --hook', 'echo capture --hook', 'shadowgraph capture'].map((command) => shadowGraphHookKind({ type: 'command', command })), ['deliver', 'capture', null, null]);
  assert.match(runtimeHookCommand('C:/x/shadowgraph/runtime/abc', 'C:/n/node.exe', 'capture'), / capture --hook$/u);
  assert.throws(() => runtimeHookCommand('C:/x/shadowgraph/runtime/abc', 'C:/n/node.exe', 'extract'), /hook_kind_unknown/u);
  const both = withShadowGraphHooks(withShadowGraphHooks(unrelated(), template), captureTemplate, 'capture');
  assert.deepEqual(kinds(both), ['capture', 'capture', 'capture', 'capture', 'deliver', 'deliver']);
  assert.deepEqual(kinds(withShadowGraphHooks(both, template)), kinds(both), 'a delivery reinstall keeps capture\'s handlers (they run in parallel: their order carries nothing)');
  assert.deepEqual(withoutShadowGraphHooks(both, 'capture'), withShadowGraphHooks(unrelated(), template));
  assert.deepEqual(withoutShadowGraphHooks(both), unrelated());
  // Synchronous command handlers only, with a timeout, and no async key (design review D-1).
  for (const [event, groups] of Object.entries(captureTemplate.hooks)) assert.deepEqual(groups, [{ hooks: [{ type: 'command', command: 'shadowgraph capture --hook', timeout: 10 }] }], event);
  // Through the verbs on a scratch settings file.
  const home = await scratchDirectory(t, 'shadowgraph-hooks-');
  const settings = join(home, 'host-hooks-fixture.json');
  await writeFile(settings, formatted(unrelated()));
  assert.equal((await run(['install-hooks', '--settings', settings], home)).code, 0);
  const captured = await run(['install-hooks', '--capture', '--settings', settings], home);
  assert.equal(captured.code, 0, captured.stderr);
  assert.deepEqual([JSON.parse(captured.stdout).kind, JSON.parse(captured.stdout).events], ['capture', ['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']]);
  assert.deepEqual(kinds(JSON.parse(await readFile(settings, 'utf8'))), ['capture', 'capture', 'capture', 'capture', 'deliver', 'deliver']);
  assert.deepEqual(JSON.parse((await run(['uninstall-hooks', '--capture', '--settings', settings], home)).stdout).removed, 4);
  assert.deepEqual(kinds(JSON.parse(await readFile(settings, 'utf8'))), ['deliver', 'deliver'], 'uninstalling capture leaves delivery');
  assert.equal((await run(['install-hooks', '--capture', '--settings', settings], home)).code, 0);
  assert.deepEqual(JSON.parse((await run(['uninstall-hooks', '--settings', settings], home)).stdout).removed, 6, 'uninstall removes both kinds');
  assert.equal(await readFile(settings, 'utf8'), formatted(unrelated()));
});
