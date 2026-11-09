import { spawnSync } from 'node:child_process';
import assert from 'node:assert';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { measureAll } from '../scripts/mcp-wire-size.mjs';
import { buildToolCatalog, COMPACT_TOOL_NAMES, WORKFLOW_TOOL_NAMES, selectTools } from '../src/mcp-tools.js';

const cliPath = resolve('src/cli.js');

function runCli(args, env = {}) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

console.log('=== TEST 1: WIRE BUDGETS AND DESCRIPTION TOTALS (~2% HEADROOM) ===');
const report = measureAll();

const WIRE_BUDGETS = {
  'withoutVerifier.full': { bare: 77900, annotated: 81600, structured: 378900 },
  'withoutVerifier.workflow': { bare: 62100, annotated: 64300, structured: 304000 },
  'withoutVerifier.compact': { bare: 56100, annotated: 57800, structured: 271300 },
  'withVerifier.full': { bare: 79000, annotated: 82900, structured: 383900 },
  'withVerifier.workflow': { bare: 62100, annotated: 64300, structured: 304000 },
  'withVerifier.compact': { bare: 56100, annotated: 57800, structured: 271300 }
};

const DESCRIPTION_TOTALS = {
  full: 11950,
  verifier: 12300,
  workflow: 7950,
  compact: 6900
};

const headroomResults = [];
for (const [path, tiers] of Object.entries(WIRE_BUDGETS)) {
  const [build, mode] = path.split('.');
  for (const [tier, ceiling] of Object.entries(tiers)) {
    const measured = report[build][mode].tiers[tier].total;
    const headroomBytes = ceiling - measured;
    const headroomPct = (headroomBytes / ceiling) * 100;
    headroomResults.push({ path, tier, measured, ceiling, headroomBytes, headroomPct });

    assert.ok(headroomBytes > 0, `Headroom must be strictly positive for ${path} ${tier}`);
    assert.ok(headroomPct < 10, `Headroom must be < 10% for ${path} ${tier}, got ${headroomPct.toFixed(2)}%`);
    assert.ok(headroomPct >= 1.5 && headroomPct <= 3.5, `Headroom must be ~2% for ${path} ${tier}, got ${headroomPct.toFixed(2)}%`);
    console.log(`[PASS] ${path} ${tier}: measured=${measured}B, ceiling=${ceiling}B, headroom=${headroomBytes}B (${headroomPct.toFixed(2)}%)`);
  }
}
assert.equal(headroomResults.length, 18, 'All 18 wire budget tiers verified');

const descResults = [];
const descMeasured = {
  full: report.withoutVerifier.full.descriptionChars,
  verifier: report.withVerifier.full.descriptionChars,
  workflow: report.withoutVerifier.workflow.descriptionChars,
  compact: report.withoutVerifier.compact.descriptionChars
};

for (const [mode, ceiling] of Object.entries(DESCRIPTION_TOTALS)) {
  const measured = descMeasured[mode];
  const headroomChars = ceiling - measured;
  const headroomPct = (headroomChars / ceiling) * 100;
  descResults.push({ mode, measured, ceiling, headroomChars, headroomPct });

  assert.ok(headroomChars > 0, `Description headroom must be strictly positive for ${mode}`);
  assert.ok(headroomPct < 10, `Description headroom must be < 10% for ${mode}, got ${headroomPct.toFixed(2)}%`);
  assert.ok(headroomPct >= 1.5 && headroomPct <= 3.5, `Description headroom must be ~2% for ${mode}, got ${headroomPct.toFixed(2)}%`);
  console.log(`[PASS] ${mode} descriptions: measured=${measured} chars, ceiling=${ceiling} chars, headroom=${headroomChars} chars (${headroomPct.toFixed(2)}%)`);
}
assert.equal(descResults.length, 4, 'All 4 description totals verified');

console.log('\n=== TEST 2: CLI HELP TEXT COMPLETENESS & ERGONOMICS ===');
const helpRes = runCli(['--help']);
assert.equal(helpRes.status, 0, '--help must exit 0');
assert.equal(helpRes.stderr.trim(), '', '--help stderr must be empty');

const helpText = helpRes.stdout;

// Core subcommands
const requiredSubcommands = [
  'mcp', 'serve', 'setup', 'doctor',
  'remember', 'decision', 'attempt', 'outcome', 'status', 'fact', 'supersede',
  'recall', 'search', 'retrieve', 'context', 'review-context', 'link', 'traverse', 'redact',
  'review', 'reconsider', 'signals', 'ack', 'maintain', 'journal', 'rebuild', 'stats', 'list', 'validate', 'repair-plan',
  'backup', 'restore', 'migrate', 'downgrade', 'markdown-sync', 'purge', 'purge-preview', 'quarantine',
  'deliver', 'capture', 'extract', 'install-hooks', 'uninstall-hooks', 'activate', 'deactivate', 'sharing'
];

for (const subcmd of requiredSubcommands) {
  const regex = new RegExp(`\\b${subcmd}\\b`);
  assert.ok(regex.test(helpText), `Help text must document subcommand: ${subcmd}`);
}
console.log(`[PASS] All ${requiredSubcommands.length} subcommands are documented in help output.`);

// Options and flags
const requiredFlags = ['--help', '-h', '--args', '-a', '--settings', '--runtime', '--memory-only'];
for (const flag of requiredFlags) {
  assert.ok(helpText.includes(flag), `Help text must document flag: ${flag}`);
}
console.log(`[PASS] All ${requiredFlags.length} flags are documented in help output.`);

// Environment variables
const requiredEnvVars = [
  'SHADOWGRAPH_FILE',
  'SHADOWGRAPH_STORAGE',
  'SHADOWGRAPH_PROJECT',
  'SHADOWGRAPH_MCP_PROFILE',
  'SHADOWGRAPH_MCP_COMPACT',
  'PORT'
];
for (const envVar of requiredEnvVars) {
  assert.ok(helpText.includes(envVar), `Help text must document env var: ${envVar}`);
}
console.log(`[PASS] All ${requiredEnvVars.length} environment variables are documented in help output.`);

// Profile options in help text
assert.ok(helpText.includes('compact') && helpText.includes('16'), 'Help must document compact (16)');
assert.ok(helpText.includes('workflow') && helpText.includes('20'), 'Help must document workflow (20)');
assert.ok(helpText.includes('full') && helpText.includes('35'), 'Help must document full (35)');
console.log('[PASS] Help text documents all 3 profiles: compact (16), workflow (20), full (35).');

// Interception permutations
const helpInvocations = [
  ['--help'],
  ['-h'],
  ['help'],
  ['decision', '--help'],
  ['doctor', '-h'],
  ['mcp', '--help'],
  ['--help', 'unknown-command']
];

for (const args of helpInvocations) {
  const res = runCli(args);
  assert.equal(res.status, 0, `Invocation "${args.join(' ')}" must exit 0`);
  assert.ok(/Usage:\s+shadowgraph/i.test(res.stdout), `Invocation "${args.join(' ')}" must print usage`);
  assert.equal(res.stderr.trim(), '', `Invocation "${args.join(' ')}" must have clean stderr`);
}
console.log(`[PASS] All ${helpInvocations.length} help invocation permutations exit 0 on stdout.`);

// Malformed JSON error feedback
const badJsonInputs = [
  '{ not valid json }',
  '{"unclosed": "string',
  '{"key": undefined}',
  '[1, 2, 3,]',
  'bare_word'
];

for (const bad of badJsonInputs) {
  const res = runCli(['decision', '--args', bad]);
  assert.equal(res.status, 1, `Malformed input "${bad}" must exit 1`);
  assert.ok(res.stderr.includes('Invalid JSON argument:'), `Malformed input must output "Invalid JSON argument:", got: ${res.stderr}`);
  assert.ok(!res.stderr.includes('at JSON.parse'), `Malformed input must not show Node stack trace`);
}
console.log(`[PASS] Malformed JSON inputs output clean sanitized errors without Node stack traces.`);

console.log('\n=== TEST 3: MERMAID DIAGRAM SYNTAX & MARKDOWN VALIDATION ===');
function findMarkdownFiles(dir) {
  const results = [];
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findMarkdownFiles(full));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      results.push(full);
    }
  }
  return results;
}

const allMdFiles = findMarkdownFiles(process.cwd());
let totalDiagramsFound = 0;
const validTypes = ['graph', 'flowchart', 'sequenceDiagram', 'stateDiagram-v2', 'stateDiagram', 'classDiagram', 'erDiagram'];

for (const file of allMdFiles) {
  const content = readFileSync(file, 'utf8');
  const matches = [...content.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)];
  if (matches.length === 0) continue;

  console.log(`Checking ${file.replace(process.cwd() + '\\', '')}: ${matches.length} diagram(s)`);
  for (let i = 0; i < matches.length; i++) {
    totalDiagramsFound++;
    const code = matches[i][1].trim();
    const firstLine = code.split('\n')[0].trim();
    const typeOk = validTypes.some((t) => firstLine.startsWith(t));
    assert.ok(typeOk, `Diagram #${i + 1} in ${file} has unrecognized type "${firstLine}"`);

    // Delimiter balance check
    for (const [open, close] of [['[', ']'], ['(', ')'], ['{', '}']]) {
      const openCount = (code.match(new RegExp('\\' + open, 'g')) || []).length;
      const closeCount = (code.match(new RegExp('\\' + close, 'g')) || []).length;
      assert.equal(openCount, closeCount, `Diagram #${i + 1} in ${file} has unbalanced ${open}${close}: ${openCount} vs ${closeCount}`);
    }
  }
}
assert.ok(totalDiagramsFound >= 5, `Must find and validate at least 5 mermaid diagrams, found ${totalDiagramsFound}`);
console.log(`[PASS] Verified ${totalDiagramsFound} Mermaid diagrams across all markdown files.`);

console.log('\n=== TEST 4: PROFILE INVENTORY INVARIANTS ===');
assert.equal(COMPACT_TOOL_NAMES.length, 16, 'COMPACT_TOOL_NAMES must have exactly 16 tools');
assert.equal(WORKFLOW_TOOL_NAMES.length, 20, 'WORKFLOW_TOOL_NAMES must have exactly 20 tools');
assert.equal(buildToolCatalog().length, 35, 'Full catalog without verifier must have 35 tools');
assert.equal(buildToolCatalog({ verifier: true }).length, 36, 'Full catalog with verifier must have 36 tools');

const workflowExtra = WORKFLOW_TOOL_NAMES.filter((t) => !COMPACT_TOOL_NAMES.includes(t));
assert.deepEqual(
  workflowExtra.sort(),
  [
    'shadowgraph_confidence_evidence',
    'shadowgraph_review_signals',
    'shadowgraph_supersede',
    'shadowgraph_update_status'
  ].sort(),
  'Workflow tools must be exactly Compact + 4 lifecycle tools'
);
console.log('[PASS] Profile inventories strictly adhere to 16/20/35 invariants.');

console.log('\n===============================================');
console.log('ALL CHALLENGER EMPIRICAL VERIFICATIONS PASSED!!');
console.log('===============================================');
