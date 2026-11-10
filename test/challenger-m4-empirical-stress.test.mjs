import { spawnSync } from 'node:child_process';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { measureAll } from '../scripts/mcp-wire-size.mjs';

const cliPath = join(process.cwd(), 'src/cli.js');

function run(args, env = {}) {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return { status: res.status, stdout: res.stdout || '', stderr: res.stderr || '' };
}

console.log('--- 1. EMPIRICAL CLI HELP INVOCATIONS ---');
const helpCases = [
  { name: '--help', args: ['--help'] },
  { name: '-h', args: ['-h'] },
  { name: 'help', args: ['help'] },
  { name: 'help decision', args: ['help', 'decision'] },
  { name: 'decision --help', args: ['decision', '--help'] },
  { name: 'decision -h', args: ['decision', '-h'] },
  { name: 'doctor --help', args: ['doctor', '--help'] },
  { name: 'mcp --help', args: ['mcp', '--help'] },
  { name: 'setup --help', args: ['setup', '--help'] },
  { name: '--help with unknown option', args: ['--help', '--unknown'] }
];

let helpPassCount = 0;
for (const c of helpCases) {
  const res = run(c.args);
  const statusOk = res.status === 0;
  const stdoutOk = /Usage:\s+shadowgraph/i.test(res.stdout);
  const stderrOk = res.stderr.trim() === '';
  if (statusOk && stdoutOk && stderrOk) {
    helpPassCount++;
    console.log(`[PASS] ${c.name} -> status: 0, stdout: Usage found, stderr: clean`);
  } else {
    console.error(`[FAIL] ${c.name} -> status: ${res.status}, stdout: ${res.stdout.slice(0, 100)}, stderr: ${res.stderr.slice(0, 100)}`);
  }
}
assert.equal(helpPassCount, helpCases.length, 'All help cases must pass');

console.log('\n--- 2. EMPIRICAL MALFORMED JSON INPUTS TO --args / -a ---');
const malformedCases = [
  {
    name: 'trailing comma in object',
    args: ['decision', '--args', '{"title": "Test", "chosen": "Option A",}']
  },
  {
    name: 'unquoted keys',
    args: ['decision', '-a', '{title: "Test", chosen: "Option A"}']
  },
  {
    name: 'truncated brackets',
    args: ['decision', '--args', '{"title": "Test", "chosen": ["A", "B"']
  },
  {
    name: 'single quotes instead of double quotes',
    args: ['decision', '-a', "{'title': 'Test'}"]
  },
  {
    name: 'bare string not valid JSON',
    args: ['decision', '--args', 'just a raw string']
  },
  {
    name: 'empty string for args',
    args: ['decision', '--args', '']
  },
  {
    name: 'whitespace only for args',
    args: ['decision', '-a', '   ']
  },
  {
    name: 'very long malformed string to test snippet truncation',
    args: ['decision', '--args', '{"bad": ' + 'X'.repeat(200) + '}']
  }
];

let jsonPassCount = 0;
for (const c of malformedCases) {
  const res = run(c.args);
  const exitCodeOk = res.status === 1;
  const noRawStack = !res.stderr.includes('at JSON.parse') && !res.stderr.includes('SyntaxError:');
  const actionableMsg = res.stderr.includes('Invalid JSON argument:') || res.stderr.includes('Expected a JSON argument');
  const outputCombined = res.stdout + res.stderr;
  const noUnhandledCrash = !outputCombined.includes('unhandledRejection') && !outputCombined.includes('uncaughtException');

  if (exitCodeOk && noRawStack && actionableMsg && noUnhandledCrash) {
    jsonPassCount++;
    console.log(`[PASS] ${c.name} -> status: 1, message: "${res.stderr.trim()}"`);
  } else {
    console.error(`[FAIL] ${c.name} -> status: ${res.status}, stderr: "${res.stderr.trim()}", noRawStack: ${noRawStack}, actionable: ${actionableMsg}`);
  }
}
assert.equal(jsonPassCount, malformedCases.length, 'All malformed JSON cases must pass');

console.log('\n--- 3. EMPIRICAL WIRE SIZE CEILINGS & HEADROOM VERIFICATION ---');
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
  compact: 6375
};

let wireCeilingsChecked = 0;
for (const [path, tiers] of Object.entries(WIRE_BUDGETS)) {
  const [build, mode] = path.split('.');
  for (const [tier, ceiling] of Object.entries(tiers)) {
    const measured = report[build][mode].tiers[tier].total;
    const headroomBytes = ceiling - measured;
    const headroomPct = (headroomBytes / ceiling) * 100;
    assert.ok(headroomBytes > 0, `Headroom must be positive for ${path} ${tier}`);
    // Check that headroom is roughly 2% (between 1.5% and 3.5%)
    assert.ok(headroomPct >= 1.5 && headroomPct <= 3.5, `Headroom must be roughly 2% for ${path} ${tier}, got ${headroomPct.toFixed(2)}%`);
    wireCeilingsChecked++;
    console.log(`[PASS] ${path} ${tier}: measured=${measured}B, ceiling=${ceiling}B, headroom=${headroomBytes}B (${headroomPct.toFixed(2)}%)`);
  }
}
assert.equal(wireCeilingsChecked, 18, 'All 18 wire budget tiers must be verified');

let descCeilingsChecked = 0;
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
  assert.ok(headroomChars > 0, `Description headroom must be positive for ${mode}`);
  assert.ok(headroomPct >= 1.5 && headroomPct <= 3.5, `Description headroom must be roughly 2% for ${mode}, got ${headroomPct.toFixed(2)}%`);
  descCeilingsChecked++;
  console.log(`[PASS] ${mode} descriptions: measured=${measured} chars, ceiling=${ceiling} chars, headroom=${headroomChars} chars (${headroomPct.toFixed(2)}%)`);
}
assert.equal(descCeilingsChecked, 4, 'All 4 description totals must be verified');

console.log('\n--- 4. EMPIRICAL MERMAID DIAGRAM SYNTAX & CONTENT VALIDATION ---');
const docFiles = ['README.md', 'docs/mcp-compatibility.md', 'integrations/agent-policy.md'];
let totalMermaidBlocks = 0;

for (const relPath of docFiles) {
  const fullPath = join(process.cwd(), relPath);
  const content = readFileSync(fullPath, 'utf8');
  const matches = [...content.matchAll(/```mermaid\s*\n([\s\S]*?)```/g)];
  assert.ok(matches.length > 0, `${relPath} must contain at least one mermaid diagram`);
  console.log(`File ${relPath}: found ${matches.length} mermaid block(s)`);

  for (let i = 0; i < matches.length; i++) {
    totalMermaidBlocks++;
    const code = matches[i][1].trim();
    // Validate diagram type declaration
    const firstLine = code.split('\n')[0].trim();
    const validDiagramTypes = [
      'graph', 'flowchart', 'sequenceDiagram', 'classDiagram',
      'stateDiagram', 'stateDiagram-v2', 'erDiagram', 'journey',
      'gantt', 'pie', 'quadrantChart', 'requirementDiagram',
      'gitGraph', 'C4Context', 'mindmap', 'timeline'
    ];
    const hasValidType = validDiagramTypes.some((type) => firstLine.startsWith(type));
    assert.ok(hasValidType, `Mermaid block #${i+1} in ${relPath} must start with a recognized diagram type, got: "${firstLine}"`);

    // Verify brackets and quotes are balanced in diagram
    const openBrackets = (code.match(/\[/g) || []).length;
    const closeBrackets = (code.match(/\]/g) || []).length;
    assert.equal(openBrackets, closeBrackets, `Mermaid block #${i+1} in ${relPath} has unbalanced square brackets [${openBrackets} vs ${closeBrackets}]`);

    const openParens = (code.match(/\(/g) || []).length;
    const closeParens = (code.match(/\)/g) || []).length;
    assert.equal(openParens, closeParens, `Mermaid block #${i+1} in ${relPath} has unbalanced parentheses (${openParens} vs ${closeParens})`);

    const openBraces = (code.match(/\{/g) || []).length;
    const closeBraces = (code.match(/\}/g) || []).length;
    assert.equal(openBraces, closeBraces, `Mermaid block #${i+1} in ${relPath} has unbalanced curly braces {${openBraces} vs ${closeBraces}}`);

    console.log(`  [PASS] Block #${i+1}: Type "${firstLine}", ${code.split('\n').length} lines, syntax verified.`);
  }
}
console.log(`Total verified Mermaid diagrams: ${totalMermaidBlocks}`);

console.log('\n=============================================');
console.log('ALL EMPIRICAL CHALLENGER STRESS TESTS PASSED!');
console.log('=============================================');
