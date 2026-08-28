import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

const INSPECTOR_VERSION = '2.4.0';
const expected = [
  { name: 'Full', count: 27, env: [] },
  { name: 'Compact', count: 12, env: ['SHADOWGRAPH_MCP_COMPACT=1'] }
];
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
    console.log(`MCP Inspector ${mode.name}: tools=${tools.length} errors=0 warnings=0`);
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
