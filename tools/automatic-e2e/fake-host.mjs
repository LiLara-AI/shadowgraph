// Scripted responder behind fake-host.exe. It answers the executor's probes as
// the supported host profile does and answers an extraction call from the
// prompt it was given, the way the prompt asks: a decision's fields as phrases,
// the whole message as other experience, and a recorded tool call's two sides.
// It is not a model and proves nothing about one; it proves the wiring around it.
import { appendFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.env.FAKE_HOST_ARGV ? Buffer.from(process.env.FAKE_HOST_ARGV, 'base64').toString('utf8').split('\0') : [];
const log = join(dirname(fileURLToPath(import.meta.url)), 'calls.jsonl');
const out = text => process.stdout.write(text);
const FLAGS = ['--safe-mode', '--tools', '--setting-sources', '--settings', '--strict-mcp-config', '--mcp-config', '--disable-slash-commands', '--no-session-persistence', '--session-id', '--json-schema', '--model', '--output-format', '--system-prompt'];

if (args[0] === '--version') out('2.1.288 (Claude Code)\n');
else if (args[0] === '--help') out(`Usage: claude [options]\n${FLAGS.join('\n')}\n`);
else if (args.at(-2) === 'auth' && args.at(-1) === 'status') out(`${JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty' })}\n`);
else if (args.at(-1) === 'doctor') out('Diagnostics\nManaged settings (remote): not fetched — requires an Enterprise or Team subscription\n');
else if (args.includes('-p')) {
  const prompt = readFileSync(0, 'utf8');
  const data = JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1));
  const text = data.untrustedText, ref = data.sourceRef, records = [];
  const field = (name, value) => ({ name, text: value, sourceRef: ref });
  const split = /The first (\d+) characters are the recorded input side/u.exec(prompt);
  if (split) {
    const boundary = Number(split[1]);
    records.push({ kind: 'attempt', fields: [field('solution', text.slice(0, boundary)), field('result', text.slice(boundary + 1))] });
  } else {
    const decided = /\b(use (?:a |the )?[^,.]+?) instead of ((?:a |the )?[^,.]+?)(?:,| because|\.)/iu.exec(text);
    const because = /\bbecause ([^.]+)/iu.exec(text);
    if (decided) records.push({ kind: 'decision', fields: [field('title', decided[1]), field('chosen', decided[1]), field('alternative', decided[2]), ...(because ? [field('reason', because[1])] : [])] });
    if (decided || data.role === 'user') records.push({ kind: 'memory', fields: [field('text', text)] });
  }
  appendFileSync(log, `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, sourceRef: ref, role: data.role, promptSha256: createHash('sha256').update(prompt).digest('hex'),
    hooksDisabled: args.includes('--settings') && JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks === true,
    environmentNames: Object.keys(process.env).filter(name => name !== 'FAKE_HOST_ARGV').sort(), records: records.map(record => record.kind) })}\n`);
  out(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, num_turns: 1,
    modelUsage: { 'claude-opus-5[1m]': { inputTokens: prompt.length, outputTokens: 1 } }, structured_output: { records } }));
} else { process.stderr.write('unsupported fake-host call\n'); process.exitCode = 2; }
