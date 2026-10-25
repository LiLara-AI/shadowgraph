#!/usr/bin/env node
// Isolated check of the automatic memory workflow, end to end, with no model
// and no account: the packed runtime of one commit is installed into a scratch
// home, its hooks are installed into a scratch settings file and activated once,
// and the harness then plays a host. It runs each hook command exactly as the
// settings file lists it, with a hook's environment, and never runs `extract`
// itself: any extraction must be the one the Stop hook requests. The executor
// calls fake-host.exe (fake-host.cs, fake-host.mjs) as its Claude program.
//
// Whether a real host runs these hooks, lets the detached worker survive, and
// whether a real model's output passes verification is live evidence; this
// does not stand in for it.
//
// usage: node tools/automatic-e2e/run.mjs --commit <revision> [--terminal-env] [--out <receipt.json>] [--keep]
//   TEMP and TMP must name a directory outside the user profile: activation
//   skips the owner's terminal confirmation only for such scratch locations.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir, userInfo } from 'node:os';
import { dirname, join, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url)), repo = join(here, '..', '..');
const args = process.argv.slice(2), option = name => { const at = args.indexOf(name); return at === -1 ? undefined : args[at + 1]; };
const commit = option('--commit') ?? 'HEAD', out = option('--out'), keep = args.includes('--keep'), terminalEnv = args.includes('--terminal-env');
if (process.platform !== 'win32') throw new Error('The executor runs on Windows only.');
const temporary = await realpath(tmpdir()), profile = await realpath(userInfo().homedir);
const within = (parent, child) => { const path = relative(parent, child); return path !== '' && !path.startsWith('..') && !isAbsolute(path); };
if (within(profile, temporary)) throw new Error('Set TEMP and TMP to a directory outside the user profile.');

const root = await mkdtemp(join(temporary, 'shadowgraph-auto-e2e-'));
const p = { home: join(root, 'home'), sgHome: join(root, 'sg-home'), store: join(root, 'private', 'memory.json'), settings: join(root, 'home', 'host-config.json'),
  work: join(root, 'work', 'config-loader'), host: join(root, 'host') };
for (const directory of [p.home, dirname(p.store), p.work, p.host]) await mkdir(directory, { recursive: true });
const owner = { SystemRoot: process.env.SystemRoot, PATH: process.env.PATH, TEMP: temporary, TMP: temporary, USERPROFILE: p.home, HOME: p.home,
  APPDATA: join(p.home, 'AppData', 'Roaming'), LOCALAPPDATA: join(p.home, 'AppData', 'Local'), SHADOWGRAPH_HOME: p.sgHome, SHADOWGRAPH_FILE: p.store, SHADOWGRAPH_STORAGE: 'json' };
// What a desktop host adds to every hook it runs (names as observed in a
// Claude Code desktop session; the values here are placeholders).
const hookEnv = terminalEnv ? owner : { ...owner, ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_SIMPLE: '1', CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'claude-desktop', CLAUDE_CODE_SESSION_ID: 'host-session', CLAUDE_CODE_MESSAGING_TOKEN: 'placeholder',
  CLAUDE_CODE_ACCOUNT_UUID: 'placeholder', CLAUDE_CODE_ORGANIZATION_UUID: 'placeholder', CLAUDE_CODE_USER_EMAIL: 'Synthetic-Owner@example.invalid' };
const receipt = { kind: 'shadowgraph-automatic-e2e', version: 1, at: new Date().toISOString(), node: process.version, hookEnvironment: terminalEnv ? 'terminal' : 'desktop-host', steps: [], checks: {} };
const step = (name, value) => { receipt.steps.push({ name, ...value }); return value; };
// An informational check reports a known limitation and does not decide the result.
const check = (name, pass, detail, informational = false) => { receipt.checks[name] = { pass: Boolean(pass), ...(informational ? { informational } : {}), ...(detail === undefined ? {} : { detail }) }; };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
  // 1. Owner setup, once: runtime, fake host, store, hooks, activation, binding.
  const installed = JSON.parse((await run(process.execPath, [join(repo, 'scripts', 'install-runtime.mjs'), '--commit', commit, '--home', p.sgHome],
    { cwd: repo, env: { ...process.env, TEMP: temporary, TMP: temporary }, maxBuffer: 1 << 26 })).stdout);
  const rt = installed.path, cli = join(rt, 'src', 'cli.js');
  receipt.candidate = { commit: installed.commit, tree: installed.tree, tarballSha256: installed.tarballSha256 };
  const csc = join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  await run(csc, ['/nologo', `/out:${join(p.host, 'claude.exe')}`, join(here, 'fake-host.cs')]);
  await copyFile(join(here, 'fake-host.mjs'), join(p.host, 'fake-host.mjs'));
  await writeFile(join(p.host, 'fake-host.cfg'), `${process.execPath}\n${join(p.host, 'fake-host.mjs')}\n`);
  const load = async name => import(pathToFileURL(join(rt, 'src', name)).href);
  const [{ createStorage }, { createShadowGraph }] = await Promise.all([load('storage.js'), load('shadowgraph.js')]);
  await writeFile(p.settings, '{}\n');
  const shadowgraph = async (cliArgs, env = owner) => {
    try { const { stdout } = await run(process.execPath, [cli, ...cliArgs], { cwd: p.home, env, maxBuffer: 1 << 26 }); return { code: 0, stdout }; }
    catch (error) { return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: String(error.stderr ?? error.message).slice(0, 400) }; }
  };
  const setup = [
    ['setup'],
    ['install-hooks', '--settings', p.settings, '--runtime', rt],
    ['install-hooks', '--capture', '--settings', p.settings, '--runtime', rt],
    ['activate', 'delivery', '--evidence', 'isolated-automatic-e2e', '--store', p.store, '--runtime', rt, '--settings', p.settings, '--host-version', '2.1.288'],
    ['activate', 'capture', '--evidence', 'isolated-automatic-e2e', '--store', p.store, '--runtime', rt, '--settings', p.settings, '--host-version', '2.1.288'],
    ['activate', 'extraction', '--evidence', 'isolated-automatic-e2e', '--store', p.store, '--runtime', rt, '--settings', p.settings, '--executable', join(p.host, 'claude.exe'), '--no-overage-confirmed', 'true']
  ];
  for (const command of setup) {
    const result = await shadowgraph(command);
    step(command.slice(0, 2).join(' '), { exit: result.code, ...(result.stderr ? { stderr: result.stderr } : {}) });
    if (result.code !== 0) throw new Error(`setup failed: ${command.slice(0, 2).join(' ')}: ${result.stderr}`);
  }
  await run('git', ['init', '-q'], { cwd: p.work });
  // `bind` asks at a terminal; this is that answer, given once, in process.
  { const [{ discoverWorkspace, bindWorkspaceProject }] = await Promise.all([load('internal/access-transport.js')]);
    const store = await createStorage({ type: 'json', file: p.store }), graph = createShadowGraph(); graph.importData(await store.load());
    const workspace = await discoverWorkspace(p.work);
    await bindWorkspaceProject(graph, store, workspace, { type: 'worktree', path: workspace.worktreeRoot, project: 'config-loader', reason: 'isolated automatic-memory check', surface: 'cli' });
    store.close?.(); step('bind (owner answer)', { project: 'config-loader' }); }

  // 2. The host's side: every hook the settings file lists for an event, as listed.
  const settings = JSON.parse(await readFile(p.settings, 'utf8'));
  const hook = async (event, input) => {
    const outputs = [];
    for (const group of settings.hooks?.[event] ?? []) for (const handler of group.hooks ?? []) {
      outputs.push(await new Promise(resolve => {
        const child = spawn(handler.command, { shell: true, cwd: p.work, env: hookEnv, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = ''; child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.resume();
        const timer = setTimeout(() => child.kill(), (handler.timeout ?? 60) * 1000);
        child.on('close', code => { clearTimeout(timer); resolve({ code, stdout }); });
        child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: p.work, ...input }));
      }));
    }
    return outputs;
  };
  const context = outputs => outputs.map(o => { try { return JSON.parse(o.stdout).hookSpecificOutput.additionalContext; } catch { return ''; } }).join('\n');
  const storeNow = async () => JSON.parse(await readFile(p.store, 'utf8'));
  const calls = async () => (await readFile(join(p.host, 'calls.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line));
  const worker = async () => JSON.parse(await readFile(join(p.sgHome, 'extraction-worker'), 'utf8').catch(() => 'null'));
  const captures = async () => (await storeNow()).records.filter(r => r.kind === 'capture');
  // Settled: the worker this Stop requested has written its fence after the
  // Stop was sent, stopped, and left nothing processing.
  const settle = async (since, limitMs = 120000) => {
    const started = Date.now();
    while (Date.now() - started < limitMs) {
      const fence = await worker(), open = (await captures()).some(c => c.state === 'processing');
      if (fence && Date.parse(fence.at) >= since && fence.state === 'stopped' && !open) return Date.now() - started;
      await sleep(250);
    }
    return null;
  };
  // A drain the window refuses before any call writes no fence: it waits out `limitMs`.
  const stop = async (session, message, limitMs) => { const since = Date.now(); await hook('Stop', { session_id: session, stop_hook_active: false, last_assistant_message: message }); return settle(since, limitMs); };

  // Session A: a conversational decision with a rejected alternative and its
  // reason, then a real attempted action that fails, then the turn ends.
  const A = randomUUID(), decision = 'For the config loader we will use the streaming tokenizer instead of the per-line regex parser, because the regex parser cannot handle nested quotes.';
  const command = 'node parse-demo.mjs sample.cfg', failure = 'Exit code 1\nSyntaxError: unterminated string at line 3 (nested quote)';
  await hook('SessionStart', { session_id: A, source: 'startup' });
  await hook('UserPromptSubmit', { session_id: A, prompt: decision });
  await hook('PostToolUseFailure', { session_id: A, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'toolu_e2e_1', error: failure });
  const callsBefore = (await calls()).length;
  const settledA = await stop(A, 'The parser failed on line 3 of sample.cfg; the tokenizer plan stands.');
  const afterA = await storeNow(), capA = afterA.records.filter(r => r.kind === 'capture'), callsA = await calls();
  step('session A', { captures: capA.map(c => ({ event: c.source?.event, role: c.source?.role, state: c.state, attribution: c.attribution, project: c.project })), settledMs: settledA, executorCalls: callsA.length - callsBefore, worker: await worker() });
  check('capture_by_hooks', capA.length === 3 && capA.every(c => c.attribution === 'project' && c.project === 'config-loader'), capA.map(c => c.state));
  check('extraction_started_by_stop_hook_only', callsBefore === 0 && callsA.length === 3 && settledA !== null, { callsBeforeStop: callsBefore, callsAfter: callsA.length });
  check('all_captures_processed', capA.every(c => c.state === 'extracted'), capA.map(c => c.state));
  const experience = afterA.records.filter(r => ['decision', 'attempt', 'memory'].includes(r.kind) && r.project === 'config-loader');
  const attempt = experience.find(r => r.kind === 'attempt'), typed = experience.find(r => r.kind === 'decision');
  step('experience', { records: experience.map(r => ({ kind: r.kind, title: r.title, chosen: r.chosen, alternatives: r.alternatives?.map(a => ({ label: a.label, reasonRejected: a.reasonRejected })),
    solution: r.solution, result: r.result, text: r.text, sourceClass: r.sourceClass, verificationStatus: r.verificationStatus, captureRef: r.captureRef, claims: r.claims?.length, resultClass: r.resultClass, outcomeEvidence: r.outcomeEvidence?.state })) });
  check('attempt_recorded_with_evidence', attempt && attempt.solution.endsWith(command) && attempt.result.endsWith(failure) && attempt.claims?.length === 2 && attempt.verificationStatus === 'unverified' && capA.some(c => c.id === attempt.captureRef),
    attempt && { sourceClass: attempt.sourceClass, outcomeEvidence: attempt.outcomeEvidence?.state, resultClass: attempt.resultClass ?? null });
  // The stand-in proposes only the decision's phrases: the record must come from the sentence itself.
  check('typed_decision_with_rejected_alternative_and_reason', typed && typed.verificationStatus === 'unverified' && capA.some(c => c.id === typed.captureRef)
    && typed.chosen === 'the streaming tokenizer' && typed.alternatives?.length === 1 && typed.alternatives[0].label === 'the per-line regex parser'
    && typed.alternatives[0].reasonRejected === 'the regex parser cannot handle nested quotes'
    && typed.claims?.some(c => c.class === 'quoted' && c.evidence === decision.slice(0, -1)) && typed.claims.some(c => c.rule === 'decision-frame-v1'),
  typed ? { title: typed.title, claims: typed.claims?.map(c => c.rule ?? c.class) } : 'no decision record');
  check('extraction_child_isolated', callsA.length > 0 && callsA.every(c => c.hooksDisabled && !c.environmentNames.some(name => /^(SHADOWGRAPH_|ANTHROPIC_|CLAUDE|HTTPS?_PROXY$)/iu.test(name) && !/^CLAUDE_CODE_DISABLE_/u.test(name))), callsA.map(c => c.environmentNames));

  // Repeated and concurrent Stops: no second processing of anything.
  // Two concurrent Stops with new material: it is processed, and once.
  const sinceDup = Date.now();
  await Promise.all([hook('Stop', { session_id: A, stop_hook_active: false, last_assistant_message: 'Done.' }), hook('Stop', { session_id: A, stop_hook_active: false, last_assistant_message: 'Done.' })]);
  await settle(sinceDup);
  const callsDup = await calls(), refs = callsDup.map(c => c.sourceRef);
  check('no_duplicate_processing', refs.length > callsA.length && new Set(refs).size === refs.length && (await captures()).every(c => c.state === 'extracted'), { calls: refs.length, distinct: new Set(refs).size });

  // 3. A fresh session in the same project asks something the memory bears on.
  const B = randomUUID();
  const startB = context(await hook('SessionStart', { session_id: B, source: 'startup' }));
  const promptB = context(await hook('UserPromptSubmit', { session_id: B, prompt: 'I want to parse sample.cfg quickly with a per-line regex. Any reason not to?' }));
  step('session B delivery', { sessionStartBytes: startB.length, promptBytes: promptB.length, promptContext: promptB.slice(0, 4000) });
  check('fresh_session_receives_attempt', promptB.includes('line 3 (nested quote)') || startB.includes('line 3 (nested quote)'));
  check('fresh_session_receives_decision_and_reason', (promptB + startB).includes('the regex parser cannot handle nested quotes'));

  // 4. Budget: more captured work than one window allows stays pending, visibly.
  const C = randomUUID();
  for (let n = 1; n <= 10; n += 1) await hook('UserPromptSubmit', { session_id: C, prompt: `Note ${n}: keep the loader's error messages short, item ${n} of ten.` });
  for (let round = 0; round < 4; round += 1) await stop(C, `Noted round ${round}.`, 30000);
  const usage = JSON.parse(await readFile(join(p.sgHome, 'extraction-usage.json'), 'utf8'));
  const head = context(await hook('SessionStart', { session_id: randomUUID(), source: 'startup' })).split('\n').find(line => line.startsWith('processing: '));
  const processing = head ? JSON.parse(head.slice('processing: '.length)) : null;
  step('budget', { reservations: usage.calls.length, processing });
  // More work than the window allows: the ceiling must be reached, not merely respected.
  check('budget_ceiling_held', usage.calls.length === 12 && (await calls()).length === 12 && !(await captures()).some(c => c.state === 'processing'), { reservations: usage.calls.length, executorCalls: (await calls()).length });
  check('pending_visible_when_budget_limited', processing && processing.pending > 0 && processing.workerErrors?.includes('window_calls'), processing);

  // 5. Restart: a new host process sees the same queue; nothing is lost or redone.
  const pendingBefore = (await captures()).filter(c => c.state === 'pending').length;
  const restartHead = context(await hook('SessionStart', { session_id: randomUUID(), source: 'startup' })).split('\n').find(line => line.startsWith('processing: '));
  check('pending_survives_restart', pendingBefore > 0 && JSON.parse(restartHead.slice('processing: '.length)).pending === pendingBefore, { pendingBefore });
  receipt.result = Object.values(receipt.checks).every(c => c.pass || c.informational) ? 'PASS' : 'FAIL';
} catch (error) {
  receipt.result = 'ERROR'; receipt.error = String(error?.stack ?? error).slice(0, 2000);
} finally {
  const text = `${JSON.stringify(receipt, null, 2)}\n`;
  if (out) await writeFile(out, text);
  process.exitCode = receipt.result === 'PASS' ? 0 : 1;
  process.stdout.write(text);
  if (!keep) await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  else process.stderr.write(`kept ${root}\n`);
}
