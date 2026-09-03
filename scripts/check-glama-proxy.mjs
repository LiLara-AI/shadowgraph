// Reproduces what Glama's inspection actually sees.
//
// Glama's generated container does not talk to this server directly: it runs
// `mcp-proxy` in front of `node ./src/cli.js mcp` and scans over HTTP. What the
// proxy requests at `initialize`, what this server negotiates with it, and
// whether the tool list survives the hop are therefore properties of that pair,
// not of this server alone, and none of them can be checked by pointing a
// different client at the server. This gate spawns that same entry point, not
// `src/mcp.js` directly, so whatever the CLI does before handing over is under
// test too.
//
// So this gate starts the exact pinned proxy through `npx`, with no dependency
// added to the package, on the loopback interface only, and puts a transparent
// recorder between the proxy and the server. It then behaves as the scanner
// does, over streamable HTTP, and asserts the recording and the HTTP replies
// against each other.
//
// Two modes in one file, because the recorder has to be a program the proxy can
// spawn:
//   node scripts/check-glama-proxy.mjs                        run the gate
//   node scripts/check-glama-proxy.mjs --record F -- CMD ARGS  tee stdio to F
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The proxy version Glama's generated container installs. Verify against this
// exact version: a newer one is not a substitute, and when Glama moves, this
// constant and the expectations below move with it.
const MCP_PROXY_VERSION = '6.4.3';
// What that proxy's bundled SDK client requests, and what this server must
// therefore negotiate with it. Asserted by equality so a silent fall-back to an
// older revision fails here instead of quietly shrinking what Glama can see.
const PROXY_REQUESTED_PROTOCOL_VERSION = '2025-11-25';
const EXPECTED_NEGOTIATED_PROTOCOL_VERSION = '2025-11-25';
const EXPECTED_TOOL_COUNT = 27;
// These two return a bare JSON array, so they cannot carry an object-rooted
// output schema. See src/mcp-tools.js and docs/mcp-compatibility.md.
const OUTPUT_SCHEMA_OMITTED = new Set(['shadowgraph_review', 'shadowgraph_review_signals']);
const ANNOTATION_HINTS = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint'];

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const READY_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 250;
const HTTP_TIMEOUT_MS = 30_000;
const SHUTDOWN_GRACE_MS = 5_000;
const START_ATTEMPTS = 3;

class GateError extends Error {}
class EnvironmentError extends Error {}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- recorder mode ---------------------------------------------------------

// Appends whole lines, tagged by direction, without altering the bytes that
// pass through. Split multi-byte characters and CRLF endings both survive.
function lineRecorder(recordFile, tag) {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const write = (text) => {
    const lines = (pending + text).split('\n');
    pending = lines.pop();
    for (const line of lines) {
      const clean = line.endsWith('\r') ? line.slice(0, -1) : line;
      if (clean) appendFileSync(recordFile, `${tag} ${clean}\n`);
    }
  };
  return {
    onData: (chunk) => write(decoder.write(chunk)),
    onEnd: () => {
      write(decoder.end());
      if (pending) {
        appendFileSync(recordFile, `${tag} ${pending}\n`);
        pending = '';
      }
    }
  };
}

function runRecorder(argv) {
  const [recordFile, separator, command, ...args] = argv;
  if (!recordFile || separator !== '--' || !command) {
    process.stderr.write('usage: check-glama-proxy.mjs --record <file> -- <command> [args...]\n');
    process.exit(2);
  }
  const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });
  appendFileSync(recordFile, `# ${JSON.stringify({ recorderPid: process.pid, serverPid: child.pid })}\n`);

  const requests = lineRecorder(recordFile, '>');
  const responses = lineRecorder(recordFile, '<');
  process.stdin.on('data', requests.onData);
  process.stdin.on('end', requests.onEnd);
  // pipe() ends the child's stdin when this process's stdin ends, and never
  // ends this process's stdout, which is what the proxy is reading.
  process.stdin.pipe(child.stdin);
  child.stdout.on('data', responses.onData);
  child.stdout.on('end', responses.onEnd);
  child.stdout.pipe(process.stdout);

  child.stdin.on('error', () => {});
  // The proxy went away: stop the server rather than leaving it running.
  process.stdout.on('error', () => child.kill());
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => child.kill(signal));
  child.on('error', (error) => {
    process.stderr.write(`recorder could not start the server: ${error.message}\n`);
    process.exit(1);
  });
  child.on('close', (code, signal) => {
    responses.onEnd();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

// --- gate mode -------------------------------------------------------------

function resolveNpx() {
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(join(dirname(process.env.npm_execpath), 'npx-cli.js'));
  candidates.push(join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npx-cli.js'));
  const npxCli = candidates.find((candidate) => existsSync(candidate));
  if (npxCli) return { command: process.execPath, prefix: [npxCli] };
  if (process.platform === 'win32') {
    // npx.cmd cannot be spawned without a shell on current Node versions.
    throw new EnvironmentError('npx-cli.js could not be resolved; run this gate through npm, as `npm run check:glama`');
  }
  return { command: 'npx', prefix: [] };
}

// A configuration variable leaking in from the caller's shell would change the
// surface under test: the tool count, the negotiated revision, or the proxy's
// own options, which it reads from MCP_PROXY_* as well as from its arguments.
function gateEnvironment(storeFile) {
  const environment = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (upper.startsWith('SHADOWGRAPH_') || upper.startsWith('MCP_PROXY')) continue;
    environment[key] = value;
  }
  environment.SHADOWGRAPH_FILE = storeFile;
  return environment;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

function startProxy({ port, recordFile, storeFile }) {
  const npx = resolveNpx();
  const args = [
    ...npx.prefix,
    '-y', '--loglevel=error', `mcp-proxy@${MCP_PROXY_VERSION}`,
    '--host', '127.0.0.1', '--port', String(port), '--server', 'stream',
    // The container's CMD, verbatim: cli.js validates its configuration and
    // prints nothing before handing over, and that has to keep being true.
    '--', process.execPath, SELF, '--record', recordFile, '--', process.execPath, join(REPO_ROOT, 'src', 'cli.js'), 'mcp'
  ];
  const child = spawn(npx.command, args, {
    cwd: REPO_ROOT,
    env: gateEnvironment(storeFile),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32'
  });
  const proxy = { child, stdout: '', stderr: '', exited: false, exitCode: null, spawnError: null };
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { proxy.stdout += chunk; });
  child.stderr.on('data', (chunk) => { proxy.stderr += chunk; });
  child.on('error', (error) => { proxy.spawnError = error; proxy.exited = true; });
  proxy.exit = new Promise((resolve) => {
    child.on('close', (code) => { proxy.exited = true; proxy.exitCode = code; resolve(code); });
  });
  return proxy;
}

function signalGroup(pid, signal) {
  try { process.kill(-pid, signal); }
  catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}

function recordedPids(recordFile) {
  try {
    const header = readFileSync(recordFile, 'utf8').split('\n').find((line) => line.startsWith('# '));
    if (!header) return [];
    const { recorderPid, serverPid } = JSON.parse(header.slice(2));
    return [recorderPid, serverPid].filter((pid) => Number.isInteger(pid));
  } catch { return []; }
}

async function stopProxy(proxy, recordFile) {
  const { child } = proxy;
  if (!proxy.exited && child.pid) {
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      if (killed.error) child.kill();
    } else {
      signalGroup(child.pid, 'SIGTERM');
    }
    await Promise.race([proxy.exit, sleep(SHUTDOWN_GRACE_MS)]);
    if (!proxy.exited) {
      if (process.platform === 'win32') child.kill();
      else signalGroup(child.pid, 'SIGKILL');
      await Promise.race([proxy.exit, sleep(2_000)]);
    }
  }
  // taskkill walks parent pids and can miss a grandchild whose parent already
  // exited, so on Windows the recorder's own header is the backstop. On POSIX the
  // group signal reached every member already, and a pid can have been recycled
  // by then, so nothing further is signalled.
  if (process.platform === 'win32') {
    for (const pid of recordedPids(recordFile)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

// The transport answers with `text/event-stream`, so a reply arrives as one or
// more `data:` payloads. A stream opened for a 2025-11-25 client begins with a
// priming event carrying no data, which is skipped.
export function parseSse(text) {
  const messages = [];
  for (const event of text.replaceAll('\r\n', '\n').split('\n\n')) {
    const data = event.split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /u, ''))
      .join('\n');
    if (!data.trim()) continue;
    messages.push(JSON.parse(data));
  }
  return messages;
}

async function rpcResult(response, id, method) {
  const text = await response.text();
  if (response.status !== 200) throw new GateError(`${method} returned HTTP ${response.status}: ${text.trim()}`);
  const contentType = response.headers.get('content-type') ?? '';
  const messages = contentType.includes('text/event-stream') ? parseSse(text) : [JSON.parse(text)].flat();
  const message = messages.find((candidate) => candidate?.id === id);
  if (!message) throw new GateError(`${method} response carried no JSON-RPC message with id ${id}: ${text.trim()}`);
  if (message.error) throw new GateError(`${method} returned JSON-RPC error ${message.error.code}: ${message.error.message}`);
  return message.result;
}

// Parses the recorded stdio conversation between the proxy and the server.
export function parseRecord(text) {
  const requests = [];
  const responses = [];
  for (const line of text.split('\n')) {
    if (!line.trim() || line.startsWith('# ')) continue;
    const tag = line.slice(0, 2);
    const payload = line.slice(2);
    if (tag === '> ') requests.push(JSON.parse(payload));
    else if (tag === '< ') responses.push(JSON.parse(payload));
    else throw new GateError(`unrecognised line in the stdio recording: ${line.slice(0, 60)}`);
  }
  return { requests, responses };
}

export function assertHandshake({ requests, responses }) {
  const initializes = requests.filter((request) => request.method === 'initialize');
  if (initializes.length !== 1) {
    throw new GateError(`the proxy sent ${initializes.length} initialize requests to the server; expected exactly one`);
  }
  const [initialize] = initializes;
  const requested = initialize.params?.protocolVersion;
  if (requested !== PROXY_REQUESTED_PROTOCOL_VERSION) {
    throw new GateError(`mcp-proxy@${MCP_PROXY_VERSION} requested protocolVersion ${JSON.stringify(requested)}; this gate is pinned to ${PROXY_REQUESTED_PROTOCOL_VERSION}`);
  }
  const clientName = initialize.params?.clientInfo?.name;
  if (clientName !== 'mcp-proxy') {
    throw new GateError(`the recorded handshake came from clientInfo.name ${JSON.stringify(clientName)}, not from the proxy`);
  }
  const answer = responses.find((response) => response.id === initialize.id);
  if (!answer?.result) throw new GateError('the server did not answer the proxy handshake');
  const negotiated = answer.result.protocolVersion;
  if (negotiated !== EXPECTED_NEGOTIATED_PROTOCOL_VERSION) {
    throw new GateError(`the server negotiated ${JSON.stringify(negotiated)} with the proxy; expected ${EXPECTED_NEGOTIATED_PROTOCOL_VERSION}, which is what makes annotations and output schemas visible to Glama`);
  }
  if (answer.result.serverInfo?.name !== 'shadowgraph') {
    throw new GateError(`the handshake identified the server as ${JSON.stringify(answer.result.serverInfo?.name)}`);
  }
  if (!requests.some((request) => request.method === 'notifications/initialized')) {
    throw new GateError('the proxy never completed the handshake with notifications/initialized');
  }
  return { requested, negotiated };
}

export function assertTools(received, { requests, responses }) {
  if (!Array.isArray(received)) throw new GateError('the scanner received no tools array');
  if (received.length !== EXPECTED_TOOL_COUNT) {
    throw new GateError(`the scanner received ${received.length} tools; expected ${EXPECTED_TOOL_COUNT}`);
  }
  const unannotated = received.filter((tool) => ANNOTATION_HINTS.some((hint) => typeof tool.annotations?.[hint] !== 'boolean'));
  if (unannotated.length) {
    throw new GateError(`tools reached the scanner without four boolean annotations: ${unannotated.map((tool) => tool.name).join(', ')}`);
  }
  const missingSchema = received.filter((tool) => !OUTPUT_SCHEMA_OMITTED.has(tool.name) && tool.outputSchema?.type !== 'object');
  if (missingSchema.length) {
    throw new GateError(`tools reached the scanner without an object-rooted output schema: ${missingSchema.map((tool) => tool.name).join(', ')}`);
  }
  const unexpectedSchema = received.filter((tool) => OUTPUT_SCHEMA_OMITTED.has(tool.name) && tool.outputSchema);
  if (unexpectedSchema.length) {
    throw new GateError(`a tool returning a bare array reached the scanner with an output schema: ${unexpectedSchema.map((tool) => tool.name).join(', ')}`);
  }

  const listings = requests.filter((request) => request.method === 'tools/list');
  if (listings.length !== 1) {
    throw new GateError(`the proxy sent ${listings.length} tools/list requests to the server; expected exactly one`);
  }
  const answered = responses.find((response) => response.id === listings[0].id);
  const advertised = answered?.result?.tools;
  if (!Array.isArray(advertised)) throw new GateError('the server did not answer the proxy tools/list');
  // Deep, not byte: the proxy rebuilds each tool through its SDK schema, so key
  // order may differ. What must not differ is any member or value.
  if (JSON.stringify(sortDeep(received)) !== JSON.stringify(sortDeep(advertised))) {
    throw new GateError('the tool list the scanner received differs from the one the server wrote to stdio');
  }
  return received.filter((tool) => !OUTPUT_SCHEMA_OMITTED.has(tool.name)).length;
}

// Key-order-independent comparison: the proxy's schema rebuild may reorder keys.
function sortDeep(value) {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortDeep(value[key])]));
  }
  return value;
}

const RETRYABLE_START = /EADDRINUSE/u;
const ENVIRONMENT_FAILURE = /E404|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|npm (?:ERR!|error)/u;

async function scan(url, proxy) {
  const post = (message, headers = {}) => fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(message),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS)
  });

  const initialize = {
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: {
      protocolVersion: PROXY_REQUESTED_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'shadowgraph-glama-gate', version: '1.0.0' }
    }
  };

  // The first successful POST is the handshake, not a throwaway probe.
  const deadline = Date.now() + READY_TIMEOUT_MS;
  let response = null;
  while (!response) {
    if (proxy.spawnError) throw new EnvironmentError(`the proxy could not be started: ${proxy.spawnError.message}`);
    if (proxy.exited) {
      const detail = `${proxy.stderr}${proxy.stdout}`.trim();
      if (RETRYABLE_START.test(detail)) throw new RetryableStart(detail);
      const Kind = ENVIRONMENT_FAILURE.test(detail) ? EnvironmentError : GateError;
      throw new Kind(`the proxy exited with code ${proxy.exitCode} before serving: ${detail || '(no output)'}`);
    }
    try { response = await post(initialize); }
    catch {
      if (Date.now() > deadline) throw new EnvironmentError(`the proxy did not serve on ${url} within ${READY_TIMEOUT_MS / 1000}s: ${(proxy.stderr || proxy.stdout).trim()}`);
      await sleep(POLL_INTERVAL_MS);
    }
  }

  const sessionId = response.headers.get('mcp-session-id');
  const initialized = await rpcResult(response, 1, 'initialize');
  if (!sessionId) throw new GateError('the proxy did not return an mcp-session-id header');
  const session = { 'mcp-session-id': sessionId, 'mcp-protocol-version': initialized.protocolVersion };

  const acknowledged = await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, session);
  if (acknowledged.status !== 202) {
    throw new GateError(`notifications/initialized returned HTTP ${acknowledged.status}: ${(await acknowledged.text()).trim()}`);
  }
  const listed = await rpcResult(await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, session), 2, 'tools/list');
  try {
    await fetch(url, { method: 'DELETE', headers: session, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
  } catch { /* the session closes with the proxy anyway */ }
  return { initialized, tools: listed.tools };
}

class RetryableStart extends Error {}

async function runGate() {
  for (let attempt = 1; attempt <= START_ATTEMPTS; attempt += 1) {
    const directory = mkdtempSync(join(tmpdir(), 'shadowgraph-glama-'));
    const recordFile = join(directory, 'stdio.log');
    const storeFile = join(directory, 'glama.json');
    const port = await freePort();
    const proxy = startProxy({ port, recordFile, storeFile });
    try {
      const scanned = await scan(`http://127.0.0.1:${port}/mcp`, proxy);
      await stopProxy(proxy, recordFile);
      const record = parseRecord(readFileSync(recordFile, 'utf8'));
      const handshake = assertHandshake(record);
      const withOutputSchema = assertTools(scanned.tools, record);
      return [
        `Glama mcp-proxy@${MCP_PROXY_VERSION}:`,
        `requested=${handshake.requested}`,
        `negotiated=${handshake.negotiated}`,
        `http=${scanned.initialized.protocolVersion}`,
        `tools=${scanned.tools.length}`,
        `annotated=${scanned.tools.length}`,
        `outputSchemas=${withOutputSchema}`,
        'forwarded=deep-equal'
      ].join(' ');
    } catch (error) {
      await stopProxy(proxy, recordFile);
      if (error instanceof RetryableStart && attempt < START_ATTEMPTS) continue;
      if (error instanceof RetryableStart) throw new EnvironmentError(`the chosen port was taken on every attempt: ${error.message}`);
      throw error;
    } finally {
      // Retry: on Windows the just-killed processes can hold the record file for
      // a moment, and an EBUSY here would discard a result that had passed.
      rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }
  throw new EnvironmentError('the proxy could not be started');
}

// Importing this file, as the offline tests do, must not start anything: only a
// direct invocation runs a mode.
const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(SELF);
const args = process.argv.slice(2);
if (!invokedDirectly) {
  // Imported for its exported helpers; nothing to run.
} else if (args[0] === '--record') {
  runRecorder(args.slice(1));
} else {
  try {
    process.stdout.write(`${await runGate()}\n`);
  } catch (error) {
    // An environment failure and a failed assertion both exit non-zero: a gate
    // that cannot run must never read as a gate that passed.
    const prefix = error instanceof EnvironmentError ? 'Glama proxy gate could not run' : 'Glama proxy gate failed';
    process.stderr.write(`${prefix}: ${error.message}\n`);
    process.exit(1);
  }
}
