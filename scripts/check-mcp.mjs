import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const INSPECTOR_VERSION = '2.4.0';
const expected = [
  { name: 'Full', count: 27, env: [] },
  { name: 'Compact', count: 12, env: ['SHADOWGRAPH_MCP_COMPACT=1'] }
];
// These two return a bare JSON array, so they cannot carry an object-rooted
// output schema. See src/mcp-tools.js and docs/mcp-compatibility.md.
const outputSchemaOmitted = new Set(['shadowgraph_review', 'shadowgraph_review_signals']);
const annotationHints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

// The Inspector connects through the official SDK and declares a revision that
// defines annotations and output schemas, so this also proves a real client
// accepts and compiles the schemas rather than merely tolerating them.
function assertToolMetadata(modeName, tools) {
  const unannotated = tools.filter((tool) => annotationHints.some((hint) => typeof tool.annotations?.[hint] !== 'boolean'));
  if (unannotated.length) {
    throw new Error(`${modeName} Inspector returned tools without four boolean annotations: ${unannotated.map((tool) => tool.name).join(', ')}`);
  }
  const missingOutputSchema = tools.filter((tool) => !outputSchemaOmitted.has(tool.name) && tool.outputSchema?.type !== 'object');
  if (missingOutputSchema.length) {
    throw new Error(`${modeName} Inspector returned tools without an object-rooted output schema: ${missingOutputSchema.map((tool) => tool.name).join(', ')}`);
  }
  const unexpectedOutputSchema = tools.filter((tool) => outputSchemaOmitted.has(tool.name) && tool.outputSchema);
  if (unexpectedOutputSchema.length) {
    throw new Error(`${modeName} Inspector returned an output schema for a tool that returns a bare array: ${unexpectedOutputSchema.map((tool) => tool.name).join(', ')}`);
  }
  return tools.length - tools.filter((tool) => outputSchemaOmitted.has(tool.name)).length;
}
const directory = mkdtempSync(join(tmpdir(), 'shadowgraph-mcp-inspector-'));
const npxCli = process.env.npm_execpath ? join(dirname(process.env.npm_execpath), 'npx-cli.js') : null;
const useNpxCli = Boolean(npxCli && existsSync(npxCli));
const runner = useNpxCli ? process.execPath : (process.platform === 'win32' ? 'npx.cmd' : 'npx');

try {
  for (const mode of expected) {
    const dataFile = join(directory, `${mode.name.toLowerCase()}.json`);
    const args = [
      ...(useNpxCli ? [npxCli] : []),
      '-y', '--loglevel=error', `@modelcontextprotocol/inspector@${INSPECTOR_VERSION}`, '--cli',
      process.execPath, 'src/mcp.js',
      '--method', 'tools/list', '--strict', '--format', 'json',
      '-e', `SHADOWGRAPH_FILE=${dataFile}`,
      ...mode.env.flatMap((value) => ['-e', value])
    ];
    const run = spawnSync(runner, args, {
      cwd: new URL('..', import.meta.url),
      encoding: 'utf8',
      timeout: 120_000,
      windowsHide: true
    });
    if (run.error) throw run.error;
    const stderr = run.stderr.trim();
    if (run.status !== 0) {
      throw new Error(`${mode.name} Inspector exited ${run.status}: ${stderr || run.stdout.trim()}`);
    }
    if (stderr) throw new Error(`${mode.name} Inspector reported warning/error findings:\n${stderr}`);
    let response;
    try { response = JSON.parse(run.stdout); }
    catch { throw new Error(`${mode.name} Inspector did not emit one JSON response: ${run.stdout.trim()}`); }
    const tools = response?.result?.tools;
    if (!Array.isArray(tools)) throw new Error(`${mode.name} Inspector response did not contain result.tools`);
    if (tools.length !== mode.count) {
      throw new Error(`${mode.name} Inspector returned ${tools.length} tools; expected ${mode.count}`);
    }
    const withOutputSchema = assertToolMetadata(mode.name, tools);
    console.log(`MCP Inspector ${mode.name}: tools=${tools.length} annotated=${tools.length} outputSchemas=${withOutputSchema} errors=0 warnings=0`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
