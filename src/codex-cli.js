#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { setupCodex, loadCodexSetup, runCodexSession, changeCodexSharing, pauseCodex } from './codex-host.js';

const [command, ...args] = process.argv.slice(2);
function option(name, fallback) { const at = args.indexOf(name); return at < 0 ? fallback : args[at + 1]; }
const home = resolve(option('--home', resolve(homedir(), '.shadowgraph', 'codex')));
const show = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');
try {
  if (command === 'setup') {
    const file = option('--config'); if (!file) throw new Error('setup requires --config <JSON file> with executable and projects [{project,cwd}]');
    show(await setupCodex({ ...JSON.parse(await readFile(resolve(file), 'utf8')), home }));
  } else if (command === 'status') {
    const config = await loadCodexSetup(home);
    show({ provider: config.provider, model: config.executor.model, projects: config.projects, capture: config.capture, sharing: config.sharing, paused: config.paused, store: config.store });
  } else if (command === 'share') {
    show(await changeCodexSharing({ home, mode: option('--mode', 'project'), projects: option('--projects', '').split(',').filter(Boolean), exclude: option('--exclude', '').split(',').filter(Boolean) }));
  } else if (['pause', 'resume'].includes(command)) show(await pauseCodex({ home, paused: command === 'pause' }));
  else if (command === 'run') {
    const controller = new AbortController(), stop = () => controller.abort();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    const prompt = option('--prompt');
    let terminal;
    const prompts = prompt === undefined ? (terminal = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY === true })) : [prompt];
    try {
      const result = await runCodexSession({ home, prompts, maxCalls: Number(option('--max-calls', '12')), maxTurns: Number(option('--max-turns', '4')),
        deadlineMs: Number(option('--deadline-ms', '900000')), signal: controller.signal,
        onResult: result => { process.stdout.write(result.answer + '\n'); process.stderr.write(`ShadowGraph: ${result.captureIds.length} captures; ${result.extraction.completed} extracted; ${result.contextBytes} context bytes.\n`); } });
      process.stderr.write(`Session evidence: ${result.runDirectory}\n`);
    } finally { terminal?.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } else throw new Error('Usage: shadowgraph-codex setup --config <file> | status | run [--prompt <text>] | share --mode project|selected|all-permitted [--projects p1,p2] [--exclude p3] | pause | resume. All commands accept --home <private directory>. Run bounds: --max-calls 1..12 --max-turns 1..8 --deadline-ms 1..900000.');
} catch (error) { process.stderr.write(`ShadowGraph Codex: ${error.code ?? error.message}\n`); process.exitCode = 1; }
