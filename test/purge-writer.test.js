// PR-37d: the DP-1 purge tombstone writers (briefs/PR37d-design.md, revision 3). These are the design's red tests
// (§9.2), each written before what it pins: the tombstone a purge writes and how it travels to the store (§1, §2), the
// commit point -- its order, its refusals and the record it leaves (§3) --, the registry writer and its lock (§3.7,
// §3.8), what a purge discloses (§6), the rollback floors (§4.6), the registry's location, hard links and S-1 (§7.1-
// §7.3), and the test isolation every test file now runs under (§7.4). Every test makes its own home under its scratch directory and passes it to the stores and children it makes
// (d37c §13.2); an HTTP server takes a store made with it. Fixtures that model a purge by a build before PR-37d save a
// copy of the snapshot, so no intent travels (§2.2).
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs, { existsSync, readdirSync, realpathSync } from 'node:fs';
import { appendFile, link, mkdir, readdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir, userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { exportSqlitePayload } from '../src/sqlite-storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { createShadowGraphServer } from '../src/server.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { runDeliver } from '../src/delivery.js';
import { CAPTURE_LIMITS, runCapture } from '../src/capture-hook.js';
import { mintOriginId } from '../src/scope.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { fenceLockPath } from '../src/revision-store.js';
import * as knowledge from '../src/internal/deletion-knowledge.js';
import * as quarantine from '../src/internal/quarantine.js';
import { privilegedBindProject, privilegedLiveSnapshot, privilegedRecordCapture, privilegedRecordSelfEvent, privilegedRecordTranscript, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const { ledgerPath, registryFile } = knowledge;
const SENTINEL = 'purge-writer-sentinel-7e2a';
const RECORDED = 'The purge is recorded and completes at the next write to this store.';
// rev6:401, verbatim (§6.2).
const BACKUPS = 'Earlier backups still contain the purged material.';
const DESTINATION = 'deletion_file_destination_refused';
const PENDING = 'deletion_pending_unsupported_at_this_build';
const ADMISSION = Object.freeze({ limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 }, storeBytes: 0 });
const ZERO = Object.freeze({ removed: 0, quarantined: 0, skeletons: 0, spliced: 0 });
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE = sqlite.available ? {} : { skip: sqlite.reason };
const BACKENDS = [['json', {}], ['sqlite', SQLITE]];
const WINDOWS = process.platform === 'win32';
const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mcpPath = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const fileHash = async (path) => (existsSync(path) ? sha256(await readFile(path)) : null);
const extensionOf = (backend) => (backend === 'sqlite' ? 'db' : 'json');
const folded = (path) => (WINDOWS ? path.toLowerCase() : path);
const git = (args) => execFileSync('git', args, { stdio: ['ignore', 'pipe', 'pipe'] });
let gitAvailable = true;
try { git(['--version']); } catch { gitAvailable = false; }

async function until(condition, what, timeoutMs = 20_000) {
  for (const started = Date.now(); !(await condition()); await delay(20)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
  }
}

// ---------------------------------------------------------------------------
// Stores, homes and payloads.
// ---------------------------------------------------------------------------

// A scratch directory and a home inside it, which no other test shares.
async function scratch(t) {
  const dir = await scratchDirectory(t, 'purge-writer-');
  return { dir, env: { SHADOWGRAPH_HOME: join(dir, 'home') } };
}

// A store holding `payload`, saved as a copy, as a build before PR-37d would save it (§2.2).
async function storeAt(t, backend, payload, { dir, env, name } = {}) {
  const base = dir ?? (await scratch(t)).dir;
  await mkdir(base, { recursive: true });
  const home = env ?? { SHADOWGRAPH_HOME: join(base, 'home') };
  const file = join(base, name ?? `store.${extensionOf(backend)}`);
  const store = await createStorage({ type: backend, file, env: home });
  try { await store.save(structuredClone(payload)); } finally { store.close?.(); }
  return { dir: base, file, backend, env: home };
}

async function withStore(state, step, extra = {}) {
  const store = await createStorage({ type: state.backend, file: state.file, env: state.env, ...extra });
  try { return await step(store); } finally { store.close?.(); }
}

// A clock that never reads the same instant twice, so a second read of it is never the first (P1).
let lastInstant = 0;
const ticking = () => new Date(lastInstant = Math.max(lastInstant + 1, Date.now())).toISOString();

function graphOf(payload) {
  const graph = createShadowGraph({ now: ticking });
  graph.importData(payload);
  return graph;
}

// Loads the store into a graph, changes it, and saves its persistence snapshot through the store: the direct-JS
// entry (§8).
function write(state, change, extra = {}) {
  return withStore(state, async (store) => {
    const graph = graphOf(await store.load());
    const result = await change(graph);
    graph.setRevision(await store.save(privilegedSnapshot(graph)));
    return result;
  }, extra);
}
const purge = (state, project, mode = 'logical', extra) => write(state, (graph) => graph.purgeProject(project, { mode }), extra);
// A purge by a build before PR-37d: its snapshot saved as a copy, so only its marker reaches the store.
const purgeByMarker = (state, project, mode = 'logical') => withStore(state, async (store) => {
  const graph = graphOf(await store.load());
  graph.purgeProject(project, { mode });
  await store.save(structuredClone(privilegedSnapshot(graph)));
});

// The payload as the store holds it, with no view. SQLite is read immutable, so nothing is left beside it.
async function stored({ file, backend }) {
  if (backend === 'json') return JSON.parse(await readFile(file, 'utf8'));
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
  try { return exportSqlitePayload(database); } finally { database.close(); }
}
const storeHash = async (state) => (existsSync(state.file) ? sha256(state.backend === 'json' ? await readFile(state.file) : JSON.stringify(await stored(state))) : null);
const readJson = async (path) => (existsSync(path) ? JSON.parse(await readFile(path, 'utf8')) : null);
const ledgerOf = (state) => readJson(ledgerPath(state.file));
const registryOf = (env) => readJson(registryFile(env));
const load = (state) => withStore(state, (store) => store.load());
const markerOf = (payload, project) => payload.journal.filter((entry) => entry.type === 'project.purged' && entry.project === project).at(-1);
const entitiesOf = (payload) => [...(payload.records ?? []), ...(payload.facts ?? [])];
const tokenOf = (payload, id) => entitiesOf(payload).find((entity) => entity.id === id)?.erasureToken;
const tokensIn = (payload, project) => entitiesOf(payload).filter((entity) => entity.project === project && typeof entity.erasureToken === 'string').map((entity) => entity.erasureToken).sort();
const headOf = (payload) => [...payload.journal].sort((left, right) => right.seq - left.seq)[0]?.id ?? null;
const epochOf = (payload) => payload.journal.find((entry) => entry.seq === payload.journalEpoch)?.id ?? null;
const visible = (payload) => {
  const live = privilegedLiveSnapshot(graphOf(payload));
  return new Set(entitiesOf(live).map((entity) => entity.id));
};
const temporaries = async (dir) => (await readdir(dir)).filter((name) => name.endsWith('.tmp'));
const withoutLineage = ({ lineage, ...tombstone }) => tombstone;
// The files under `dir`, at any depth, whose bytes hold `text`.
async function filesHolding(dir, text) {
  const found = [];
  for (const name of await readdir(dir, { recursive: true })) if (fs.statSync(join(dir, name)).isFile() && (await readFile(join(dir, name))).includes(text)) found.push(name);
  return found;
}

// A backup of the store at `name` beside it, through its backend's entry, sidecar included.
async function backupOf(state, name) {
  const file = join(state.dir, `${name}.${extensionOf(state.backend)}`);
  await withStore(state, (store) => backupFile(state.file, file, { env: state.env, ...(state.backend === 'sqlite' ? { store } : {}) }));
  return { ...state, file };
}
// A fresh store path in its own folder, with the home given.
const freshAt = (state, name) => ({ dir: join(state.dir, name), file: join(state.dir, name, `store.${extensionOf(state.backend)}`), backend: state.backend, env: state.env });

// A restore of `source` into `destination` through its backend's direct entry: restoreFile, or a `./storage` store.
async function restoreInto(destination, source, extra = {}) {
  await mkdir(dirname(destination.file), { recursive: true });
  if (destination.backend === 'json') return restoreFile(source.file, destination.file, { env: destination.env, ...extra });
  return withStore(destination, (store) => store.restore(source.file, extra));
}

// Strips an entity's token from every copy of it in a payload: tokenless legacy material, still rebuildable.
function stripToken(payload, id) {
  const strip = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (value.id === id) delete value.erasureToken;
    Object.values(value).forEach(strip);
  };
  strip(payload);
  return payload;
}

// In p: two decisions (one carrying the sentinel), a memory, a fact, and a capture with its content and session; in
// q a decision nothing purges.
function projectGraph() {
  const graph = createShadowGraph();
  const ids = {
    hidden: graph.addDecision({ project: 'p', title: `hidden ${SENTINEL}`, chosen: 'h' }).id,
    second: graph.addDecision({ project: 'p', title: 'second', chosen: 's' }).id,
    memory: graph.remember({ project: 'p', memoryType: 'note', key: 'k', text: `memory ${SENTINEL}` }).memory.id,
    fact: graph.addFact({ project: 'p', key: 'f', value: `fact ${SENTINEL}` }).id,
    capture: privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: `capture ${SENTINEL}`, admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user' } }).id
  };
  const kept = graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' }).id;
  return { graph, ids, kept };
}

// Spies on the files the deletion records go through: each temporary file opened, synced and renamed (D1).
function spyOnFiles() {
  const log = [];
  const original = { open: fs.promises.open, rename: fs.promises.rename };
  fs.promises.open = async (path, flags, mode) => {
    const handle = await original.open(path, flags, mode);
    if (String(path).endsWith('.tmp')) {
      log.push({ step: 'open', path: String(path), flags, mode });
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { log.push({ step: 'sync', path: String(path) }); return sync(); };
    }
    return handle;
  };
  fs.promises.rename = async (from, to) => { log.push({ step: 'rename', path: String(from), to: String(to) }); return original.rename(from, to); };
  syncBuiltinESMExports();
  return { log, restore: () => { Object.assign(fs.promises, original); syncBuiltinESMExports(); } };
}

function assertWrittenSafely(log, suffix, label) {
  const renamed = log.findIndex((entry) => entry.step === 'rename' && entry.to.toLowerCase().endsWith(suffix));
  assert.ok(renamed >= 0, `${label}: ${suffix} renamed into place`);
  const temporary = log[renamed].path;
  const opened = log.find((entry) => entry.step === 'open' && entry.path === temporary);
  assert.deepEqual([opened?.flags, opened?.mode], ['wx', 0o600], `${label}: ${suffix}'s temporary file is new and owner-only`);
  assert.ok(log.findIndex((entry) => entry.step === 'sync' && entry.path === temporary) < renamed && log.some((entry) => entry.step === 'sync' && entry.path === temporary), `${label}: ${suffix} synced before its rename`);
}

// ---------------------------------------------------------------------------
// The surfaces: CLI, MCP and HTTP.
// ---------------------------------------------------------------------------

async function cli(state, args, home = state.env.SHADOWGRAPH_HOME) {
  const env = { ...process.env, SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: state.backend, SHADOWGRAPH_API_TOKEN: '' };
  try {
    const { stdout, stderr } = await execute(process.execPath, [cliPath, ...args], { cwd: state.dir, env });
    return { code: 0, stdout, stderr };
  } catch (error) { return { code: error.code ?? 1, stdout: `${error.stdout ?? ''}`, stderr: `${error.stderr ?? ''}` }; }
}

async function mcp(t, state, calls, home = state.env.SHADOWGRAPH_HOME, extra = {}) {
  const env = { ...process.env, SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: state.backend, SHADOWGRAPH_API_TOKEN: '', SHADOWGRAPH_MCP_COMPACT: '0', SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '', ...extra };
  const child = spawn(process.execPath, [mcpPath], { cwd: state.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const responses = [];
  child.stdout.on('data', (data) => { buffer += data; const lines = buffer.split('\n'); buffer = lines.pop(); responses.push(...lines.filter(Boolean).map((line) => JSON.parse(line))); });
  const rpc = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let waited = 0; waited < 20_000; waited += 20) {
      const found = responses.find((item) => item.id === id);
      if (found) return found;
      await delay(20);
    }
    throw new Error('MCP timeout');
  };
  await rpc(1, 'initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  const texts = [];
  let id = 2;
  for (const [name, args] of calls) texts.push(JSON.stringify(await rpc(id++, 'tools/call', { name, arguments: args })));
  child.kill();
  await exited;
  return texts;
}

// An HTTP server over a store made with the state's home (and `extra` store options); `request` gets a URL builder.
async function http(state, request, { home = state.env.SHADOWGRAPH_HOME, extra = {} } = {}) {
  const store = await createStorage({ type: state.backend, file: state.file, env: { SHADOWGRAPH_HOME: home }, ...extra });
  try {
    const app = await createShadowGraphServer({ file: state.file, storage: state.backend, cwd: state.dir, apiToken: '', store });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try { return await request((path) => `http://127.0.0.1:${app.server.address().port}${path}`); }
    finally { await new Promise((done) => app.server.close(done)); }
  } finally { store.close?.(); }
}

// ---------------------------------------------------------------------------
// §1, §2: the tombstone, its dedupe key, its tokens and its move-in.
// ---------------------------------------------------------------------------

for (const [backend, options] of BACKENDS) test(`D1 ${backend}: a purge writes one ledger tombstone and one registry entry, of its marker's instant and seq, naming every removed token, W's included, and nothing identifying (P1, P9, P10)`, options, async (t) => {
  for (const mode of ['logical', 'hard']) {
    const { graph, ids } = projectGraph();
    ids.withheld = graph.addDecision({ project: 'p', title: `withheld ${SENTINEL}`, chosen: 'w' }).id;
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    const before = await stored(state);
    const quarantined = [{ token: tokenOf(before, ids.withheld), at: '2026-01-01T00:00:00.000Z' }];
    await writeFile(ledgerPath(state.file), JSON.stringify({ version: 1, quarantine: quarantined }));
    const spy = spyOnFiles();
    try { await purge(state, 'p', mode); } finally { spy.restore(); }
    const after = await stored(state);
    const marker = markerOf(after, 'p');
    const tombstone = { kind: 'project', purgedProject: 'p', mode, at: marker.at, seq: marker.seq, tokens: tokensIn(before, 'p'), moveIn: 'none' };
    assert.equal(tombstone.tokens.length, 6, `${mode}: two decisions, the memory, the fact, the capture and W`);
    assert.deepEqual(await ledgerOf(state), { version: 1, quarantine: quarantined, tombstones: [tombstone] }, `${mode}: no lineage, no pending member`);
    assert.deepEqual(await registryOf(state.env), { version: 1, tombstones: [{ ...tombstone, lineage: { epochEntryId: epochOf(before), headEntryId: headOf(before), markerEntryId: marker.id } }] }, mode);
    for (const path of [ledgerPath(state.file), registryFile(state.env)]) {
      const text = await readFile(path, 'utf8');
      for (const id of Object.values(ids)) assert.equal(text.includes(id), false, `${mode}: ${basename(path)} names a removed id`);
      assert.equal(text.includes(SENTINEL), false, `${mode}: ${basename(path)} holds content`);
    }
    assertWrittenSafely(spy.log, '.control.json', mode);
    assertWrittenSafely(spy.log, 'deletion-registry.json', mode);
  }
  // Through an alias of the store file's own name, the ledger lands beside its final name only (d37c R3-1). The name is
  // no 8.3 name on either backend, so a volume that keeps 8.3 names gives it one (review finding 11).
  const aliases = [];
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph), { name: `memory-store.${extensionOf(backend)}` });
  if (WINDOWS) {
    let short = null;
    try { short = execSync(`cmd /c for %I in ("${state.file}") do @echo %~sI`, { encoding: 'utf8' }).trim(); } catch { /* none */ }
    if (short && basename(short).toLowerCase() !== basename(state.file).toLowerCase()) aliases.push(['8.3 file name', short]);
    else t.diagnostic('D1: 8.3 file-name variant skipped: the volume keeps no 8.3 names');
  }
  try { await symlink(state.file, join(state.dir, `link-${basename(state.file)}`), 'file'); aliases.push(['symbolic link to the file', join(state.dir, `link-${basename(state.file)}`)]); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('D1: symbolic-link variant skipped'); }
  for (const [index, [label, alias]] of aliases.entries()) {
    await rm(ledgerPath(state.file), { force: true });
    await write({ ...state, file: alias }, (loaded) => loaded.addDecision({ project: `alias-${index}`, title: 'x', chosen: 'x' }));
    await purge({ ...state, file: alias }, `alias-${index}`);
    assert.equal(existsSync(ledgerPath(state.file)), true, `${label}: beside the final name`);
    assert.deepEqual((await readdir(state.dir)).filter((name) => name.endsWith('.control.json')), [basename(ledgerPath(state.file))], `${label}: nothing beside the alias`);
  }
});

for (const [backend, options] of BACKENDS) test(`D2 ${backend}: a backup of a purged store, restored into it and into a fresh path, lifts nothing and withholds nothing (the dedupe key, P1)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  await purge(state, 'p');
  const copy = await backupOf(state, 'backup');
  const ids = entitiesOf(await stored(copy)).map((entity) => entity.id);
  assert.ok(ids.length > 0);
  const ledger = await fileHash(ledgerPath(state.file));
  const into = await restoreInto(state, copy);
  assert.deepEqual([into.deletionKnowledge, into.reapplied], ['present', ZERO]);
  assert.equal(await fileHash(ledgerPath(state.file)), ledger, 'nothing lifted: the ledger is byte-equal');
  const seen = visible(await load(state));
  assert.deepEqual(ids.filter((id) => !seen.has(id)), []);
  const fresh = freshAt(state, 'fresh');
  const elsewhere = await restoreInto(fresh, copy);
  assert.deepEqual([elsewhere.deletionKnowledge, elsewhere.reapplied], ['present', ZERO]);
  assert.equal((await ledgerOf(fresh)).tombstones.some((tombstone) => tombstone.tokens === null), false, 'nothing lifted');
  const there = visible(await load(fresh));
  assert.deepEqual(ids.filter((id) => !there.has(id)), []);
});

for (const [backend, options] of BACKENDS) test(`D3 ${backend}: an empty purge writes one tombstone naming no token, and one registry entry, and says backups still hold material; a later restore of an unrelated backup quarantines nothing (P2, P33)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  assert.equal((await purge(state, 'empty')).backups, BACKUPS, 'the backups statement, on a purge that removes nothing (P33)');
  const marker = markerOf(await stored(state), 'empty');
  assert.deepEqual((await ledgerOf(state)).tombstones, [{ kind: 'project', purgedProject: 'empty', mode: 'logical', at: marker.at, seq: marker.seq, tokens: [], moveIn: 'none' }]);
  assert.equal((await registryOf(state.env)).tombstones.length, 1);
  const unrelated = createShadowGraph();
  unrelated.addDecision({ project: 'u', title: 'unrelated', chosen: 'u' });
  const other = await storeAt(t, backend, privilegedSnapshot(unrelated));
  const result = await restoreInto(state, await backupOf(other, 'unrelated'));
  assert.equal(result.reapplied.quarantined, 0);
});

// D: p purged by a build before PR-37d (only its marker); B: in p a tokened decision and memory, and a legacy
// decision with no token; in q a decision. B restored into D quarantines B's p material (PR-37c's lift).
function preBuildPayloads() {
  const purged = createShadowGraph();
  purged.addDecision({ project: 'p', title: 'd own', chosen: 'o' });
  purged.addDecision({ project: 'q', title: 'd q', chosen: 'q' });
  purged.purgeProject('p', { mode: 'logical' });
  const graph = createShadowGraph();
  const ids = {
    hidden: graph.addDecision({ project: 'p', title: `hidden ${SENTINEL}`, chosen: 'h' }).id,
    memory: graph.remember({ project: 'p', memoryType: 'note', key: 'k', text: `memory ${SENTINEL}` }).memory.id,
    legacy: graph.addDecision({ project: 'p', title: `legacy ${SENTINEL}`, chosen: 'l' }).id,
    kept: graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' }).id
  };
  const payload = stripToken(privilegedSnapshot(graph), ids.legacy);
  return { destination: structuredClone(privilegedSnapshot(purged)), backup: payload, ids };
}

for (const [backend, options] of BACKENDS) test(`D4 ${backend}: a purge of a project names its quarantined items' tokens; their entries stay, list no longer shows them, and the backup that held them is then removed by token (R5 L1 VS1, P3)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  const { destination, backup, ids } = preBuildPayloads();
  const state = await storeAt(t, backend, destination, { dir: join(dir, 'd'), env });
  const source = await storeAt(t, backend, backup, { dir: join(dir, 'b'), env });
  await restoreInto(state, source);
  const hidden = tokenOf(await stored(state), ids.hidden);
  assert.ok(new Set((await ledgerOf(state)).quarantine.map((entry) => entry.token)).has(hidden), 'quarantined by the restore');
  await purge(state, 'p');
  const ledger = await ledgerOf(state);
  assert.equal(ledger.tombstones.at(-1).tokens.includes(hidden), true, 'the tombstone names the quarantined token');
  assert.equal(ledger.quarantine.some((entry) => entry.token === hidden), true, 'its quarantine entry is kept (V-3)');
  const listed = await withStore(state, (store) => quarantine.quarantineSelection(store, 'list', {}));
  assert.equal(listed.entries.some((entry) => entry.id === ids.hidden), false);
  const result = await restoreInto(state, source);
  assert.equal(result.reapplied.quarantined, 0);
  assert.ok(result.reapplied.removed >= 1);
  assert.equal(JSON.stringify(await stored(state)).includes(ids.hidden), false, 'removed, not quarantined');
});

for (const [backend, options] of BACKENDS) test(`D5 ${backend}: a pre-purge backup holding p's captures, content and sessions, restored into the purged store, brings none of them back (P4)`, options, async (t) => {
  const { graph, ids } = projectGraph();
  const repeat = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: `capture ${SENTINEL}`, admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user' } });
  privilegedRecordTranscript(graph, { originId: 'origin-a', sessionId: 'session-1', project: 'p', activatedAt: '2020-01-01T00:00:00.000Z', trigger: null, triggerItemId: null, transcript: { ref: 'ref-p', size: () => 0, read: () => Buffer.alloc(0) }, admission: ADMISSION });
  const prePurge = privilegedSnapshot(graph);
  assert.ok(prePurge.captureSessions.some((session) => session.project === 'p' && session.cursor), 'a session with a cursor');
  const state = await storeAt(t, backend, prePurge);
  const source = await backupOf(state, 'pre-purge');
  await purge(state, 'p');
  const removed = new Set([...Object.values(ids), repeat.id]);
  await restoreInto(state, source);
  const live = privilegedLiveSnapshot(graphOf(await load(state)));
  assert.deepEqual(live.records.filter((item) => item.kind === 'capture' && item.project === 'p'), []);
  assert.deepEqual((live.captureContent ?? []).filter((entry) => entry.project === 'p'), []);
  assert.equal(JSON.stringify(live.captureContent ?? []).includes(SENTINEL), false);
  assert.deepEqual((live.captureSessions ?? []).filter((session) => session.project === 'p'), []);
  assert.deepEqual(live.idempotency.filter((item) => removed.has(item.value?.id)), []);
  assert.deepEqual([...live.records, ...live.idempotency.map((item) => item.value)].filter((item) => removed.has(item?.possibleDuplicateOf)), []);
  for (const path of [state.file, `${state.file}-wal`]) if (existsSync(path)) assert.equal((await readFile(path)).includes(SENTINEL), false, basename(path));
});

// ---------------------------------------------------------------------------
// §1.3: move-in, decided per removed entity from the unspliced journal (V-4).
// ---------------------------------------------------------------------------

// A fork of the store's history (a write D never saw, so no descent is proven), holding `stripped` tokenless and a
// tokenless probe of its own in a project the purge never reaches.
function forkOf(payload, stripped = []) {
  const fork = graphOf(structuredClone(payload));
  const probe = fork.addDecision({ project: 'elsewhere', title: 'probe', chosen: 'p' }).id;
  const forked = privilegedSnapshot(fork);
  for (const id of [probe, ...stripped]) stripToken(forked, id);
  return { payload: forked, probe };
}

for (const [backend, options] of BACKENDS) test(`D6 ${backend}: moveIn is none, some or unknown per removed entity, persisted exactly in the ledger and the registry, and a fork's tokenless material is quarantined under some and unknown only; rev6:417 with a real tombstone (P5, P6, P7, P8)`, options, async (t) => {
  const cases = [];
  // none: p created and purged.
  { const graph = createShadowGraph(); graph.addDecision({ project: 'p', title: 'native', chosen: 'n' }); cases.push(['none', 'logical', graph, []]); }
  // some: a decision moved into p from another project, then p purged, logical and hard (P5: computed after the splice).
  for (const mode of ['logical', 'hard']) {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'native', chosen: 'n' });
    const moved = graph.addDecision({ project: 'r', title: `moved ${SENTINEL}`, chosen: 'm' }).id;
    cases.push(['some', mode, graph, [moved], (live) => live.attribute({ ids: [moved], targetProject: 'p', reason: 'moved in' })]);
  }
  // unknown: a migrated store whose p entities predate its baseline.
  {
    const original = createShadowGraph();
    original.addDecision({ project: 'p', title: 'old', chosen: 'o' });
    original.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
    const graph = createShadowGraph();
    graph.importData({ ...privilegedSnapshot(original), journal: [], journalSeq: 0, journalEpoch: null });
    assert.ok(privilegedSnapshot(graph).journal.some((entry) => entry.type === 'projection.baseline'));
    cases.push(['unknown', 'logical', graph, []]);
  }
  // Precision (P8): an entity moved into p and on to q before p's purge is not removed by it.
  {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'p', title: 'native', chosen: 'n' });
    const passing = graph.addDecision({ project: 'r', title: 'passing', chosen: 'p' }).id;
    graph.attribute({ ids: [passing], targetProject: 'p', reason: 'in' });
    graph.attribute({ ids: [passing], targetProject: 'q', reason: 'on' });
    cases.push(['none', 'logical', graph, [], null, 'precision']);
  }
  for (const [moveIn, mode, graph, stripped, move, label = `${moveIn} ${mode}`] of cases) {
    const before = privilegedSnapshot(graph);
    const state = await storeAt(t, backend, before);
    if (move) await write(state, move);
    await purge(state, 'p', mode);
    assert.equal((await ledgerOf(state)).tombstones.at(-1).moveIn, moveIn, `${label}: the ledger`);
    assert.equal((await registryOf(state.env)).tombstones.at(-1).moveIn, moveIn, `${label}: the registry`);
    if (label === 'precision') continue;
    const fork = forkOf(before, stripped);
    const source = await storeAt(t, backend, fork.payload, { dir: join(state.dir, `fork-${mode}`), env: state.env });
    const result = await restoreInto(state, source);
    const seen = visible(await load(state));
    for (const id of [fork.probe, ...stripped]) assert.equal(seen.has(id), moveIn === 'none', `${label}: ${id === fork.probe ? 'the probe' : 'the moved entity'} ${moveIn === 'none' ? 'visible' : 'quarantined'}`);
    if (moveIn !== 'some' || mode !== 'logical') continue;
    // rev6:417 (R5 L0 VS1 (5)): the fork again quarantines the moved entity again and adds no tombstone; after the
    // owner purges it from quarantine, a third restore keeps it hidden.
    assert.ok(result.reapplied.quarantined >= 2, label);
    const tombstones = (await ledgerOf(state)).tombstones;
    const again = await restoreInto(state, source);
    assert.ok(again.reapplied.quarantined >= 1, `${label}: quarantined again`);
    assert.deepEqual((await ledgerOf(state)).tombstones, tombstones, `${label}: no tombstone added`);
    assert.equal(visible(await load(state)).has(stripped[0]), false);
    await withStore(state, (store) => quarantine.applyQuarantine(store, 'purge', [stripped[0]], {}));
    await restoreInto(state, source);
    assert.equal(visible(await load(state)).has(stripped[0]), false, `${label}: hidden after quarantine purge`);
  }
});

// ---------------------------------------------------------------------------
// §3.4: the record a failure leaves, and what the error says.
// ---------------------------------------------------------------------------

const fault = (stage) => {
  const thrown = Object.assign(new Error(`injected ${stage}`), { code: 'injected_fault' });
  return { thrown, saveFault: (at) => { if (at === stage) throw thrown; } };
};

for (const [backend, options] of BACKENDS) test(`D8 ${backend}: a fault after the payload commit leaves the store purged and its record waiting, and says so; a JSON afterCommit fault, after the clear, leaves none and says nothing (P37, P59, P63)`, options, async (t) => {
  for (const mode of ['logical', 'hard']) {
    const { graph, ids } = projectGraph();
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    const { thrown, saveFault } = fault('beforeRecordCleared');
    // The record is there while the payload commits (P37: a clear before the commit).
    let atCommit;
    const seam = (stage) => {
      if (stage === 'beforeCommit') atCommit = JSON.parse(fs.readFileSync(ledgerPath(state.file), 'utf8')).pending;
      saveFault(stage);
    };
    await assert.rejects(purge(state, 'p', mode, { saveFault: seam }), (error) => error === thrown && error.message.endsWith(RECORDED));
    assert.deepEqual(atCommit?.map((record) => record.kind), ['purge'], `${mode}: the record waits at beforeCommit`);
    const after = await stored(state);
    const marker = markerOf(after, 'p');
    assert.ok(marker, `${mode}: the payload is committed`);
    assert.equal(JSON.stringify(after.records).includes(ids.hidden), false, mode);
    const ledger = await ledgerOf(state);
    assert.deepEqual(ledger.pending, [{ kind: 'purge', purges: [{ project: 'p', mode, marker: { id: marker.id, at: marker.at, seq: marker.seq } }] }], mode);
    assert.equal(ledger.tombstones.length, 1, mode);
    assert.equal((await registryOf(state.env)).tombstones.length, 1, mode);
    // The next write clears the record only (§4.3 step 3; P19): the resolution writes no payload, so the write does
    // not conflict, and no second marker or tombstone appears.
    await write(state, (live) => live.addDecision({ project: 'q', title: 'next', chosen: 'n' }));
    const next = await stored(state);
    assert.equal(next.revision, after.revision + 1, `${mode}: the revision not moved by the resolution`);
    assert.deepEqual(next.journal.filter((entry) => entry.type === 'project.purged').map((entry) => entry.id), [marker.id], `${mode}: one marker`);
    assert.deepEqual(await ledgerOf(state), { version: 1, tombstones: ledger.tombstones }, `${mode}: no second tombstone, no record`);
  }
  if (backend !== 'json') return;
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const { thrown, saveFault } = fault('afterCommit');
  await assert.rejects(purge(state, 'p', 'logical', { saveFault }), (error) => error === thrown && !error.message.includes(RECORDED));
  assert.equal((await ledgerOf(state)).pending, undefined, 'the clear ran before the afterCommit seam');
});

for (const [backend, options] of BACKENDS) test(`D9 ${backend}: the ledger is written before the registry: a fault between them leaves the tombstone and the record, the registry and the store as they were, no temporary payload file, and says so (P12, P49, P59)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  await mkdir(state.env.SHADOWGRAPH_HOME, { recursive: true });
  await writeFile(registryFile(state.env), JSON.stringify({ version: 1, tombstones: [] }));
  const before = [await storeHash(state), await fileHash(registryFile(state.env))];
  const { thrown, saveFault } = fault('deletionLedgerWritten');
  await assert.rejects(purge(state, 'p', 'logical', { saveFault }), (error) => error === thrown && error.message.endsWith(RECORDED));
  const ledger = await ledgerOf(state);
  assert.equal(ledger.tombstones.length, 1);
  assert.deepEqual(ledger.pending.map((record) => record.kind), ['purge']);
  assert.deepEqual([await storeHash(state), await fileHash(registryFile(state.env))], before);
  assert.deepEqual(await temporaries(state.dir), []);
  // The next write completes the purge, and then conflicts once (V-9); the registry then holds the entry.
  await assert.rejects(write(state, (live) => live.addDecision({ project: 'q', title: 'next', chosen: 'n' })), { name: 'RevisionConflictError' });
  const { tombstones } = await registryOf(state.env);
  assert.deepEqual(tombstones.map(withoutLineage), ledger.tombstones);
  assert.equal(tombstones[0].lineage.markerEntryId, ledger.pending[0].purges[0].marker.id);
  assert.deepEqual([(await ledgerOf(state)).pending, markerOf(await stored(state), 'p')?.id], [undefined, ledger.pending[0].purges[0].marker.id]);
});

test('D9 json: a purge\'s write first removes the temporary payload files killed saves left beside the store, which may hold what it purges, and no other temporary file; SQLite writes none (review finding 7)', async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, 'json', privilegedSnapshot(graph));
  const name = basename(state.file);
  // A killed save's copy of the store, named as commit() names its own; a ledger's and another store's temporary files.
  const left = join(state.dir, `.${name}.99999.${Date.now() - 60_000}.abc.tmp`);
  await writeFile(left, await readFile(state.file));
  const others = [`.${name}.control.json.99999.${Date.now()}.abc.tmp`, `.b0.json.99999.${Date.now()}.abc.tmp`].map((other) => join(state.dir, other));
  for (const other of others) await writeFile(other, 'kept');
  await purge(state, 'p', 'hard');
  assert.equal(existsSync(left), false, 'the killed save\'s copy is removed');
  for (const other of others) assert.equal(await readFile(other, 'utf8'), 'kept', basename(other));
  assert.deepEqual(await filesHolding(state.dir, SENTINEL), [], 'no file beside the store holds what the purge removed');
});

test('D9 json: the sweep takes only commit()\'s own temporary-file shape: a dated or numbered backup\'s temporary file beside the store is kept, and so is the JSON restore\'s own beside a store whose file is named restore (re-review new finding 1)', async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, 'json', privilegedSnapshot(graph));
  const name = basename(state.file);
  const ms = Date.now() - 60_000;
  // commit()'s own shape, then a backup's into `store.json.20261002` and into `store.json.1`, which backup.js names
  // `.<destination>.<pid>.<ms>.tmp`.
  const left = join(state.dir, `.${name}.4321.${ms}.k3j4.tmp`);
  const backups = [`.${name}.20261002.4321.${ms}.tmp`, `.${name}.1.4321.${ms}.tmp`].map((other) => join(state.dir, other));
  for (const path of [left, ...backups]) await writeFile(path, 'planted');
  await purge(state, 'p', 'hard');
  assert.equal(existsSync(left), false, 'a killed save\'s temporary file is removed');
  for (const path of backups) assert.equal(existsSync(path) && await readFile(path, 'utf8'), 'planted', `${basename(path)} is kept`);
  // The JSON restore primitive names its own `.restore.<pid>.<ms>.<random>.tmp`, commit()'s shape for a store named
  // `restore`. Refuse before recording a purge rather than silently retaining
  // what could also be an ordinary save's copy of the purged material.
  const restore = await storeAt(t, 'json', privilegedSnapshot(projectGraph().graph), { name: 'restore' });
  const restoring = join(restore.dir, `.restore.4321.${ms}.k3j4.tmp`);
  await writeFile(restoring, 'planted');
  const before = await hashesOf(restore);
  await assert.rejects(purge(restore, 'p', 'hard'), { code: DESTINATION });
  assert.deepEqual(await hashesOf(restore), before, 'ambiguous residue refuses before any deletion write');
  assert.equal(existsSync(restoring) && await readFile(restoring, 'utf8'), 'planted', 'beside a store named restore');
});

for (const name of ['restore', 'RESTORE']) test(`D9 corrective json ${name}: historical and current save-shaped residue refuses before deletion records, preserves recovery files, and does not prevent an ordinary save`, async (t) => {
  const state = await storeAt(t, 'json', privilegedSnapshot(projectGraph().graph), { name });
  const files = [
    `.restore.1234.1700000000000.abc.tmp`,
    `.${name}.${process.pid}.${Date.now()}.xyz.tmp`,
    '.restore.1234.1700000000000.abc.rollback',
    '.restore.1234.1700000000000.abc.recovery'
  ];
  for (const file of files) await writeFile(join(state.dir, file), SENTINEL);
  for (const mode of ['logical', 'hard']) {
    const before = await hashesOf(state);
    await assert.rejects(purge(state, 'p', mode), (error) => error.code === DESTINATION && !error.message.includes(RECORDED) && !error.message.includes(state.dir));
    assert.deepEqual(await hashesOf(state), before, mode);
    for (const file of files) assert.equal(await readFile(join(state.dir, file), 'utf8'), SENTINEL, file);
  }
  await write(state, (graph) => graph.addDecision({ project: 'q', title: 'ordinary save remains supported', chosen: 'q' }));
  assert.equal(await ledgerOf(state), null);
  assert.equal(await registryOf(state.env), null);
});

test('D9 corrective json: retained committed intents do not turn a later ordinary save into a purge', async (t) => {
  const state = await storeAt(t, 'json', privilegedSnapshot(projectGraph().graph), { name: 'restore' });
  await withStore(state, async (store) => {
    const graph = graphOf(await store.load());
    graph.purgeProject('p', { mode: 'hard' });
    graph.setRevision(await store.save(privilegedSnapshot(graph)));
    const before = await hashesOf(state);
    const left = join(state.dir, '.restore.1234.1700000000000.abc.tmp');
    await writeFile(left, SENTINEL);
    graph.addDecision({ project: 'q', title: 'ordinary save with retained intent', chosen: 'q' });
    graph.setRevision(await store.save(privilegedSnapshot(graph)));
    const after = await hashesOf(state);
    assert.notEqual(after[0], before[0]);
    assert.deepEqual(after.slice(1), before.slice(1), 'ordinary save does not touch deletion knowledge');
    assert.equal(await readFile(left, 'utf8'), SENTINEL);
    graph.purgeProject('q', { mode: 'hard' });
    await assert.rejects(store.save(privilegedSnapshot(graph)), { code: DESTINATION });
    assert.deepEqual(await hashesOf(state), after, 'a fresh intent still refuses beside retained ones');
  });
});

test('D9 corrective json: an unambiguous restore-named store can purge while genuine rollback and recovery files remain untouched', async (t) => {
  const state = await storeAt(t, 'json', privilegedSnapshot(projectGraph().graph), { name: 'restore' });
  const files = ['.restore.1234.1700000000000.abc.rollback', '.restore.1234.1700000000000.abc.recovery'];
  for (const file of files) await writeFile(join(state.dir, file), SENTINEL);
  await purge(state, 'p', 'hard');
  assert.equal((await readFile(state.file, 'utf8')).includes(SENTINEL), false);
  for (const file of files) assert.equal(await readFile(join(state.dir, file), 'utf8'), SENTINEL);
});

test('D9 corrective json: the ordinary-save sweep precedes the payload commit even when commit fails', async (t) => {
  const state = await storeAt(t, 'json', privilegedSnapshot(projectGraph().graph));
  const left = join(state.dir, `.${basename(state.file)}.1234.1700000000000.abc.tmp`);
  await writeFile(left, await readFile(state.file));
  const { thrown, saveFault } = fault('beforeCommit');
  await assert.rejects(purge(state, 'p', 'hard', { saveFault }), (error) => error === thrown);
  assert.equal(existsSync(left), false, 'swept before the failed payload commit');
  assert.equal((await ledgerOf(state)).pending[0].kind, 'purge');
});

for (const position of ['uncommitted', 'committed', 'absent', 'empty']) test(`D9 corrective json ${position}: ambiguous residue refuses pending purge completion through save, backup and restore without changing any durable file`, async (t) => {
  const state = await storeAt(t, 'json', privilegedSnapshot(projectGraph().graph), { name: 'restore' });
  const source = await backupOf(state, 'before-purge');
  await crashWindow(t, 'json', { state, stage: position === 'committed' ? 'beforeRecordCleared' : 'deletionLedgerWritten' });
  if (position === 'absent') await rm(state.file);
  if (position === 'empty') await writeFile(state.file, JSON.stringify(privilegedSnapshot(createShadowGraph())));
  const left = join(state.dir, '.restore.1234.1700000000000.abc.tmp');
  await writeFile(left, SENTINEL);
  const before = await hashesOf(state);
  for (const [entry, act] of [
    ['save', () => write(state, (graph) => graph.addDecision({ project: 'q', title: 'next', chosen: 'q' }))],
    ['backup', () => backupOf(state, 'refused-copy')],
    ['restore', () => restoreInto(state, source)]
  ]) {
    await assert.rejects(act(), { code: DESTINATION }, entry);
    assert.deepEqual(await hashesOf(state), before, entry);
    assert.equal(await readFile(left, 'utf8'), SENTINEL, entry);
  }
});

test('D9 corrective json: a purge through a store alias refuses ambiguity at the canonical name before any write', async (t) => {
  const state = await storeAt(t, 'json', privilegedSnapshot(projectGraph().graph), { name: 'restore' });
  const alias = join(state.dir, 'alias.json');
  try { await symlink(state.file, alias, 'file'); }
  catch (error) { if (error.code === 'EPERM') return t.skip('file symlinks unavailable'); throw error; }
  const left = join(state.dir, '.restore.1234.1700000000000.abc.tmp');
  await writeFile(left, SENTINEL);
  const before = await hashesOf(state);
  await assert.rejects(purge({ ...state, file: alias }, 'p', 'hard'), { code: DESTINATION });
  assert.deepEqual(await hashesOf(state), before);
  assert.equal(await readFile(left, 'utf8'), SENTINEL);
});

for (const arrival of ['before save', 'between save and resolution']) test(`D9 corrective json: ambiguity arriving ${arrival} prevents a fresh purge from settling an earlier restore record`, async (t) => {
  const state = await storeAt(t, 'json', privilegedSnapshot(projectGraph().graph), { name: 'restore' });
  const source = await backupOf(state, 'before-purge');
  await purge(state, 'p');
  const result = await restoreInto(state, source, { restoreFault: (stage) => { if (stage === 'beforePostStep') throw new Error('interrupt post-step'); } });
  assert.equal(result.completion, 'pending');
  assert.equal((await ledgerOf(state)).pending[0].kind, 'restore');
  const left = join(state.dir, '.restore.1234.1700000000000.abc.tmp');
  const original = fs.promises.unlink;
  let planted = false;
  if (arrival === 'before save') await writeFile(left, SENTINEL);
  else {
    const lockPath = await fenceLockPath(state.file);
    fs.promises.unlink = async (path, ...args) => {
      const result = await original(path, ...args);
      if (!planted && String(path) === lockPath) {
        planted = true;
        await writeFile(left, SENTINEL);
      }
      return result;
    };
    syncBuiltinESMExports();
  }
  const before = await hashesOf(state);
  try { await assert.rejects(purge(state, 'q', 'hard'), { code: DESTINATION }); }
  finally { fs.promises.unlink = original; syncBuiltinESMExports(); }
  if (arrival !== 'before save') assert.equal(planted, true, 'the initial save released its fence before ambiguity appeared');
  assert.deepEqual(await hashesOf(state), before, 'the existing restore record is not resolved on the way to refusal');
  assert.equal(await readFile(left, 'utf8'), SENTINEL);
});

test('D9 json: a purge that faults before its record is cleared has already removed the killed saves\' temporary files, so none holds what it purged (re-review new finding 6)', async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, 'json', privilegedSnapshot(graph));
  const left = join(state.dir, `.${basename(state.file)}.4321.${Date.now() - 60_000}.k3j4.tmp`);
  await writeFile(left, await readFile(state.file));
  const { thrown, saveFault } = fault('beforeRecordCleared');
  await assert.rejects(purge(state, 'p', 'hard', { saveFault }), (error) => error === thrown && error.message.endsWith(RECORDED));
  assert.equal(existsSync(left), false, 'removed before the payload commit, not after the clear');
  assert.deepEqual(await filesHolding(state.dir, SENTINEL), [], 'no file beside the store holds what the purge removed');
});

// ---------------------------------------------------------------------------
// §2.2-§2.5: how the intent travels, and who may force a marker.
// ---------------------------------------------------------------------------

for (const [backend, options] of BACKENDS) test(`D12 ${backend}: a hard re-purge in one unsaved graph absorbs the first purge's tokens, and a pre-purge backup then loses the first purge's material (P27)`, options, async (t) => {
  const graph = createShadowGraph();
  const first = graph.addDecision({ project: 'p', title: `first ${SENTINEL}`, chosen: 'f' }).id;
  graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const source = await backupOf(state, 'pre-purge');
  const firstToken = tokenOf(await stored(state), first);
  await write(state, (live) => {
    live.purgeProject('p', { mode: 'logical' });
    live.addDecision({ project: 'p', title: 'second', chosen: 's' });
    live.purgeProject('p', { mode: 'hard' });
  });
  const { tombstones } = await ledgerOf(state);
  assert.equal(tombstones.length, 1);
  assert.equal(tombstones[0].tokens.includes(firstToken), true, 'the first purge\'s token');
  assert.equal(tombstones[0].tokens.length, 2);
  await restoreInto(state, source);
  assert.equal(visible(await load(state)).has(first), false);
  assert.equal(JSON.stringify(await stored(state)).includes(first), false, 'removed by its token');
});

for (const [backend, options] of BACKENDS) test(`D13 ${backend}: a committed intent stays quiet: an unrelated save from the same graph, and a logical re-purge's save, write it again nowhere (P26)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  // The record the ledger holds as each payload commits: a committed intent never makes one again.
  const pending = [];
  const saveFault = (stage) => {
    if (stage === 'beforeCommit') pending.push(JSON.parse(fs.readFileSync(ledgerPath(state.file), 'utf8')).pending?.flatMap((record) => record.purges.map((purge) => purge.marker.id)));
  };
  await withStore(state, async (store) => {
    const live = graphOf(await store.load());
    live.purgeProject('p');
    live.setRevision(await store.save(privilegedSnapshot(live)));
    const files = [ledgerPath(state.file), registryFile(state.env)];
    const before = await Promise.all(files.map(fileHash));
    live.addDecision({ project: 'q', title: 'unrelated', chosen: 'u' });
    live.setRevision(await store.save(privilegedSnapshot(live)));
    assert.deepEqual(await Promise.all(files.map(fileHash)), before, 'an unrelated save');
    const [ledger, registry] = [await ledgerOf(state), await registryOf(state.env)];
    const first = markerOf(privilegedSnapshot(live), 'p').id;
    live.purgeProject('p', { mode: 'logical' });
    live.setRevision(await store.save(privilegedSnapshot(live)));
    const [nextLedger, nextRegistry] = [await ledgerOf(state), await registryOf(state.env)];
    assert.deepEqual(pending, [[first], undefined, [markerOf(privilegedSnapshot(live), 'p').id]], 'a record only for the purge each save commits');
    assert.deepEqual(nextLedger.tombstones.slice(0, -1), ledger.tombstones, 'only the re-purge\'s own tombstone');
    assert.deepEqual(nextRegistry.tombstones.slice(0, -1), registry.tombstones);
    assert.deepEqual([nextLedger.tombstones.length, nextRegistry.tombstones.length, nextLedger.pending], [2, 2, undefined]);
  }, { saveFault });
});

test('D14: the public purge cannot force a marker (P28)', () => {
  const graph = createShadowGraph();
  graph.addDecision({ project: 'p', title: 'x', chosen: 'x' });
  const forged = { id: 'jentry_forged', at: '2000-01-01T00:00:00.000Z' };
  const started = new Date().toISOString();
  graph.purgeProject('p', { marker: forged });
  const marker = markerOf(privilegedSnapshot(graph), 'p');
  assert.notEqual(marker.id, forged.id);
  assert.ok(marker.at >= started, 'the graph\'s own clock');
});

for (const [backend, options] of BACKENDS) test(`D15 ${backend}: a rollback to a privileged snapshot keeps an uncommitted intent, and a reload drops it (P29)`, options, async (t) => {
  const { graph, ids } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  await write(state, (live) => {
    live.purgeProject('p');
    live.replaceData(privilegedSnapshot(live));
  });
  assert.equal((await ledgerOf(state)).tombstones.length, 1, 'written after a rollback');
  const other = await storeAt(t, backend, privilegedSnapshot(graph));
  await withStore(other, async (store) => {
    const live = graphOf(await store.load());
    live.purgeProject('p');
    live.replaceData(await store.load());
    await store.save(privilegedSnapshot(live));
  });
  assert.deepEqual([await ledgerOf(other), await registryOf(other.env)], [null, null], 'a reload drops it');
  assert.equal(visible(await load(other)).has(ids.hidden), true, 'and the store is not purged');
});

for (const [backend, options] of BACKENDS) test(`D41 ${backend}: the intent is a non-enumerable symbol: a spread snapshot carries none, and its save writes no deletion record (P47)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  await withStore(state, async (store) => {
    const live = graphOf(await store.load());
    live.purgeProject('p');
    const snapshot = privilegedSnapshot(live);
    assert.equal(Object.getOwnPropertySymbols(snapshot).includes(knowledge.DELETION_INTENT), true);
    assert.deepEqual(Object.keys(snapshot), Object.keys(JSON.parse(JSON.stringify(snapshot))), 'no key, and no byte, is added');
    assert.deepEqual(Object.getOwnPropertySymbols({ ...snapshot }), []);
    await store.save({ ...snapshot });
  });
  assert.deepEqual([await ledgerOf(state), await registryOf(state.env)], [null, null]);
});

for (const [backend, options] of BACKENDS) test(`D43 ${backend}: a graph that imports a purged graph's snapshot adopts no intent (P50)`, options, async (t) => {
  const { graph } = projectGraph();
  graph.purgeProject('p');
  const copy = createShadowGraph();
  copy.importData(privilegedSnapshot(graph));
  const { dir, env } = await scratch(t);
  const state = { dir, file: join(dir, `store.${extensionOf(backend)}`), backend, env };
  await withStore(state, (store) => store.save(privilegedSnapshot(copy)));
  assert.deepEqual([await ledgerOf(state), await registryOf(env)], [null, null]);
});

for (const [backend, options] of BACKENDS) test(`D33 ${backend}: two purges on a held graph, saved once, write both tombstones and both entries (P30)`, options, async (t) => {
  const graph = createShadowGraph();
  const a = graph.addDecision({ project: 'a', title: `a ${SENTINEL}`, chosen: 'a' }).id;
  const b = graph.addDecision({ project: 'b', title: `b ${SENTINEL}`, chosen: 'b' }).id;
  const held = graph.addDecision({ project: 'q', title: 'held', chosen: 'h' }).id;
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const source = await backupOf(state, 'pre-purge');
  await writeFile(ledgerPath(state.file), JSON.stringify({ version: 1, quarantine: [{ token: tokenOf(await stored(state), held), at: '2026-01-01T00:00:00.000Z' }] }));
  await write(state, (live) => {
    assert.equal(privilegedLiveSnapshot(live).records.some((item) => item.id === held), false, 'the graph holds W apart');
    live.purgeProject('a');
    live.purgeProject('b');
  });
  assert.deepEqual((await ledgerOf(state)).tombstones.map((tombstone) => tombstone.purgedProject), ['a', 'b']);
  assert.deepEqual((await registryOf(state.env)).tombstones.map((tombstone) => tombstone.purgedProject), ['a', 'b']);
  await restoreInto(state, source);
  const seen = visible(await load(state));
  assert.deepEqual([seen.has(a), seen.has(b)], [false, false]);
});

// ---------------------------------------------------------------------------
// §3.2 item 3, §3.3: the hook never writes deletion records; refusals before any write.
// ---------------------------------------------------------------------------

for (const [backend, options] of BACKENDS) test(`D37 ${backend}: a purged snapshot through update -- the capture hook's write -- refuses, and nothing is written (P43)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const before = [await storeHash(state), await fileHash(ledgerPath(state.file)), await fileHash(registryFile(state.env))];
  await withStore(state, async (store) => {
    const live = graphOf(await store.load());
    live.purgeProject('p');
    await assert.rejects(store.update(() => privilegedSnapshot(live)), { code: 'control_ledger_malformed' });
  });
  assert.deepEqual([await storeHash(state), await fileHash(ledgerPath(state.file)), await fileHash(registryFile(state.env))], before);
});

// The remedies the refusals before any write name (§3.3).
const UNUSABLE = /the deletion registry's folder cannot be used; set SHADOWGRAPH_HOME to an absolute private folder/u;
const IN_TREE = /would be written inside a working tree; set SHADOWGRAPH_HOME to a private folder outside every repository/u;
// Each case readies a store and its home, and gives the code it refuses with and, where it has one, the remedy its
// message names; `inProcess` cases are only reachable in this process (a spy), `absent` ones must leave the home
// missing.
const REFUSALS = [
  ['a second hard link, a version-only ledger beside the store\'s name', DESTINATION, async (state) => {
    await writeFile(ledgerPath(state.file), JSON.stringify({ version: 1 }));
    await link(state.file, join(state.dir, `linked-${basename(state.file)}`));
  }, { remedy: /remove the other link/u }],
  ['SHADOWGRAPH_HOME relative', DESTINATION, async (state) => { state.home = 'relative-home'; }, { remedy: UNUSABLE }],
  ['SHADOWGRAPH_HOME an existing file', DESTINATION, async (state) => { await rm(state.home, { recursive: true }); await writeFile(state.home, 'not a folder'); }, { remedy: UNUSABLE }],
  ['SHADOWGRAPH_HOME inside a git init repository', DESTINATION, async (state) => {
    git(['init', '-q', join(state.dir, 'repo')]);
    state.home = join(state.dir, 'repo', 'home');
    await mkdir(state.home);
  }, { git: true, remedy: IN_TREE }],
  ['SHADOWGRAPH_HOME inside a git worktree add tree', DESTINATION, async (state) => {
    const repo = join(state.dir, 'repo');
    git(['init', '-q', repo]);
    git(['-C', repo, '-c', 'user.name=purge-writer', '-c', 'user.email=purge-writer@invalid', 'commit', '-q', '--allow-empty', '-m', 'init']);
    git(['-C', repo, 'worktree', 'add', '-q', join(state.dir, 'tree')]);
    state.home = join(state.dir, 'tree', 'home');
    await mkdir(state.home);
  }, { git: true, remedy: IN_TREE }],
  ['SHADOWGRAPH_HOME under a folder whose .git cannot be examined', DESTINATION, async (state) => {
    state.home = join(state.dir, 'deny', 'home');
    await mkdir(state.home, { recursive: true });
  }, { inProcess: true, remedy: IN_TREE }],
  ['SHADOWGRAPH_HOME missing, inside a git init repository', DESTINATION, async (state) => {
    git(['init', '-q', join(state.dir, 'repo')]);
    state.home = join(state.dir, 'repo', 'missing');
  }, { git: true, absent: true, remedy: IN_TREE }],
  ['a malformed registry', 'control_ledger_malformed', async (state) => { await writeFile(registryFile({ SHADOWGRAPH_HOME: state.home }), '{'); }],
  ['a newer registry', 'control_ledger_newer_version', async (state) => { await writeFile(registryFile({ SHADOWGRAPH_HOME: state.home }), JSON.stringify({ version: 2 })); }],
  ['the registry lock held by a live holder', 'storage_lock_timeout', async (state) => {
    await writeFile(await fenceLockPath(registryFile({ SHADOWGRAPH_HOME: state.home })), `${process.pid}:${Date.now()}:holder`);
  }]
];

// A spy that makes `<scratch>/deny/.git` impossible to examine (PR-37b's technique).
function denyGit(t) {
  const original = fs.promises.lstat;
  fs.promises.lstat = async (path, ...rest) => {
    if (String(path).endsWith(`${sep}deny${sep}.git`)) throw Object.assign(new Error('denied'), { code: 'EACCES' });
    return original(path, ...rest);
  };
  syncBuiltinESMExports();
  const restore = () => { fs.promises.lstat = original; syncBuiltinESMExports(); };
  t.after(restore);
  return restore;
}

const SURFACES = ['direct', 'cli', 'mcp', 'http'];

for (const [backend, options] of BACKENDS) test(`D16 ${backend}: every refusal comes before any write, through direct JS, CLI, MCP and HTTP: its code crosses, no message names a path, nothing is written and no temporary file is left (P22, P23, P24, P49, P56)`, options, async (t) => {
  for (const [label, code, setup, { git: needsGit = false, inProcess = false, absent = false, remedy = null } = {}] of REFUSALS) {
    if (needsGit && !gitAvailable) { t.diagnostic(`D16 ${label}: skipped, git is not available`); continue; }
    for (const surface of SURFACES) {
      if (inProcess && !['direct', 'http'].includes(surface)) continue;
      const { graph } = projectGraph();
      const state = await storeAt(t, backend, privilegedSnapshot(graph));
      state.home = state.env.SHADOWGRAPH_HOME;
      await mkdir(state.home, { recursive: true });
      await setup(state);
      const restoreSpy = inProcess ? denyGit(t) : () => {};
      const files = () => [ledgerPath(state.file), ...(isAbsolute(state.home) ? [registryFile({ SHADOWGRAPH_HOME: state.home })] : [])];
      const before = [await storeHash(state), ...(await Promise.all(files().map(fileHash)))];
      const where = `${label}, ${surface}`;
      const named = (text) => [basename(state.dir), 'relative-home'].filter((part) => text.includes(part));
      const lock = { lockTimeoutMs: 300 };
      try {
        if (surface === 'direct') {
          await assert.rejects(purge({ ...state, env: { SHADOWGRAPH_HOME: state.home } }, 'p', 'logical', lock), (error) => {
            assert.equal(error.code, code, `${where}: ${error.message}`);
            assert.deepEqual(named(error.message), [], `${where}: ${error.message}`);
            // Each refusal names its own remedy (§3.3): a home that is a file is unusable, not inside a repository.
            if (remedy) assert.match(error.message, remedy, where);
            return true;
          });
        } else if (surface === 'cli') {
          const result = await cli(state, ['purge', JSON.stringify({ project: 'p', mode: 'logical' })], state.home);
          assert.notEqual(result.code, 0, where);
          assert.match(result.stderr, new RegExp(`\\(${code}\\)`), `${where}: ${result.stderr}`);
          assert.deepEqual(named(result.stderr), [], `${where}: ${result.stderr}`);
        } else if (surface === 'mcp') {
          const [text] = await mcp(t, state, [['shadowgraph_purge', { project: 'p', mode: 'logical' }]], state.home);
          const answer = JSON.parse(text);
          assert.equal(answer.error?.data?.issueCode ?? (answer.result?.isError && code), code, `${where}: ${text}`);
          assert.deepEqual(named(text), [], `${where}: ${text}`);
        } else {
          const response = await http(state, (url) => fetch(url('/projects'), { method: 'DELETE', body: JSON.stringify({ project: 'p', mode: 'logical' }) }), { home: state.home, extra: lock });
          const text = await response.text();
          assert.equal(response.status, 400, `${where}: ${text}`);
          assert.equal(JSON.parse(text).code, code, `${where}: ${text}`);
          assert.deepEqual(named(text), [], `${where}: ${text}`);
        }
      } finally { restoreSpy(); }
      assert.deepEqual([await storeHash(state), ...(await Promise.all(files().map(fileHash)))], before, `${where}: nothing written`);
      assert.deepEqual(await temporaries(state.dir), [], `${where}: no temporary file`);
      if (absent) assert.equal(existsSync(state.home), false, `${where}: the missing home is not made`);
    }
  }
});

for (const [backend, options] of BACKENDS) test(`D16 ${backend}: a store at the registry's own name is refused by a plain save and a purge, and on SQLite at creation, however it is spelled; the registry is left as it was (V-17, P56)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const registry = registryFile(env);
  await writeFile(registry, `${JSON.stringify({ version: 1, tombstones: [] }, null, 2)}\n`);
  const before = await fileHash(registry);
  const spellings = [registry, ...(WINDOWS ? [join(dirname(registry), basename(registry).toUpperCase())] : [])];
  for (const file of spellings) {
    const state = { dir, file, backend, env };
    if (backend === 'sqlite') {
      await assert.rejects(createStorage({ type: 'sqlite', file, env }), (error) => error.code === DESTINATION && !error.message.includes(basename(dir)));
      continue;
    }
    await assert.rejects(withStore(state, async (store) => store.save(await store.load())), { code: DESTINATION }, `${file}: a plain save`);
    await assert.rejects(purge(state, 'p'), (error) => error.code === DESTINATION && !error.message.includes(basename(dir)), `${file}: a purge`);
  }
  assert.equal(await fileHash(registry), before);
  assert.deepEqual(await temporaries(dirname(registry)), []);
  assert.equal(existsSync(`${registry}.lock`), false);
});

for (const [backend, options] of BACKENDS) test(`D16 ${backend}: a store at the registry lock's name is refused by a plain save and a purge, and on SQLite at creation, however it is spelled, so the lock's stale reclaim never removes a store (review finding 8)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const registry = registryFile(env);
  await writeFile(registry, `${JSON.stringify({ version: 1, tombstones: [] }, null, 2)}\n`);
  const before = await fileHash(registry);
  const lock = `${registry}.lock`;
  const spellings = [lock, ...(WINDOWS ? [join(dirname(lock), basename(lock).toUpperCase())] : [])];
  for (const file of spellings) {
    const state = { dir, file, backend, env };
    if (backend === 'sqlite') {
      await assert.rejects(createStorage({ type: 'sqlite', file, env }), (error) => error.code === DESTINATION && !error.message.includes(basename(dir)));
      continue;
    }
    await assert.rejects(withStore(state, async (store) => store.save(await store.load())), { code: DESTINATION }, `${file}: a plain save`);
    await assert.rejects(purge(state, 'p'), (error) => error.code === DESTINATION && !error.message.includes(basename(dir)), `${file}: a purge`);
  }
  assert.equal(existsSync(lock), false, 'no store is made at the lock\'s name');
  assert.equal(await fileHash(registry), before);
  assert.deepEqual(await temporaries(dirname(registry)), []);
});

for (const [backend, options] of BACKENDS) test(`D16 ${backend}: a store an earlier build saved at the registry lock's name is refused by a save through any spelling, and an unrelated purge under the same home refuses rather than reclaim it as a stale lock, leaving it byte for byte (re-review new finding 3)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const lock = await fenceLockPath(registryFile(env));
  // As an earlier build saved it: a store's own bytes at that name, last written two minutes ago, past the fence's
  // stale age.
  const earlier = await storeAt(t, backend, privilegedSnapshot(projectGraph().graph));
  await writeFile(lock, await readFile(earlier.file));
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  const before = await fileHash(lock);
  // The file exists, so only its identity refuses it.
  const spellings = [lock, ...(WINDOWS ? [join(dirname(lock), basename(lock).toUpperCase())] : [])];
  for (const file of spellings) {
    if (backend === 'sqlite') await assert.rejects(createStorage({ type: 'sqlite', file, env }), { code: DESTINATION }, `${file}: at creation`);
    else await assert.rejects(withStore({ dir, file, backend, env }, async (store) => store.save(await store.load())), { code: DESTINATION }, `${file}: a plain save`);
  }
  const other = await storeAt(t, backend, privilegedSnapshot(projectGraph().graph), { dir: join(dir, 'other'), env });
  await assert.rejects(purge(other, 'p'), (error) => error.code === DESTINATION && !error.message.includes(basename(dir)), 'an unrelated purge');
  assert.equal(await fileHash(lock), before, 'the store at the lock\'s name is as it was');
});

// ---------------------------------------------------------------------------
// §3.7, §3.8: the registry lock and the registry writer.
// ---------------------------------------------------------------------------

// A child that purges p from its store and saves, pausing once it reads the registry under its own registry lock.
const PAUSING_PURGER = `
import fs, { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [src, file, home, paused, go] = process.argv.slice(2);
const from = (path) => import(pathToFileURL(join(src, path)).href);
const { createShadowGraph } = await from('shadowgraph.js');
const { createStorage } = await from('storage.js');
const { privilegedSnapshot } = await from(join('internal', 'snapshot.js'));
const store = await createStorage({ file, env: { SHADOWGRAPH_HOME: home }, lockTimeoutMs: 30000 });
const graph = createShadowGraph();
graph.importData(await store.load());
graph.purgeProject('p');
const original = fs.promises.readFile;
const lockOf = (path) => join(realpathSync.native(dirname(path)), basename(path)) + '.lock';
let done = false;
fs.promises.readFile = async (path, ...rest) => {
  const outcome = await original(path, ...rest).then((value) => ({ value }), (error) => ({ error }));
  if (!done && String(path).endsWith('deletion-registry.json') && existsSync(lockOf(String(path))) && readFileSync(lockOf(String(path)), 'utf8').startsWith(process.pid + ':')) {
    done = true;
    writeFileSync(paused, String(Date.now()));
    while (!existsSync(go)) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (outcome.error) throw outcome.error;
  return outcome.value;
};
syncBuiltinESMExports();
await store.save(privilegedSnapshot(graph));
`;

test('D17: two processes purging two stores under one home serialise on the registry lock, and the registry ends with both entries (P25)', async (t) => {
  const { dir, env } = await scratch(t);
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const script = join(dir, 'purger.mjs');
  await writeFile(script, PAUSING_PURGER);
  const children = [];
  for (const name of ['a', 'b']) {
    const { graph } = projectGraph();
    const state = await storeAt(t, 'json', privilegedSnapshot(graph), { dir: join(dir, name), env });
    const paths = { paused: join(dir, `paused-${name}`), go: join(dir, `go-${name}`) };
    const child = spawn(process.execPath, [script, srcRoot, state.file, env.SHADOWGRAPH_HOME, paths.paused, paths.go], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = once(child, 'exit');
    t.after(async () => { child.kill(); await exited; });
    children.push({ name, paths, exited, stderr: () => stderr, child });
  }
  await until(() => children.some(({ paths }) => existsSync(paths.paused)) || children.some(({ child }) => child.exitCode !== null), 'a purger to hold the registry lock');
  const first = children.find(({ paths }) => existsSync(paths.paused));
  assert.ok(first, children.map((child) => child.stderr()).join('\n'));
  const second = children.find((child) => child !== first);
  await delay(500);
  assert.equal(existsSync(second.paths.paused), false, 'the second waits on the registry lock');
  const released = Date.now();
  await writeFile(first.paths.go, 'go');
  await until(() => existsSync(second.paths.paused) || second.child.exitCode !== null, 'the second purger');
  assert.ok(Number(await readFile(second.paths.paused, 'utf8')) >= released, second.stderr());
  await writeFile(second.paths.go, 'go');
  for (const { exited, stderr } of children) assert.equal((await exited)[0], 0, stderr());
  assert.deepEqual((await registryOf(env)).tombstones.map((tombstone) => tombstone.purgedProject), ['p', 'p']);
});

test('D18: the registry writer keeps unknown members and the version, refuses to drop, edit or move an entry or to append one without lineage, and renames through the bounded retry', async (t) => {
  const { env } = await scratch(t);
  await mkdir(env.SHADOWGRAPH_HOME, { recursive: true });
  const registry = registryFile(env);
  const entry = (seq) => ({ kind: 'project', purgedProject: 'p', mode: 'logical', at: '2026-01-01T00:00:00.000Z', seq, tokens: [], moveIn: 'none', lineage: { epochEntryId: 'jentry_epoch', headEntryId: null, markerEntryId: `jentry_${seq}` } });
  await knowledge.writeRegistry((next) => { next.tombstones = [entry(1)]; }, { env });
  assert.deepEqual(await registryOf(env), { version: 1, tombstones: [entry(1)] }, 'a new registry is version 1');
  await writeFile(registry, JSON.stringify({ version: 1, tombstones: [entry(1)], laterBuildState: { kept: true } }));
  await knowledge.writeRegistry((next) => { next.tombstones.push(entry(2)); }, { env });
  assert.deepEqual(await registryOf(env), { version: 1, tombstones: [entry(1), entry(2)], laterBuildState: { kept: true } });
  const bytes = await readFile(registry);
  const refused = {
    drop: (next) => { next.tombstones = [entry(1)]; },
    edit: (next) => { next.tombstones[0].seq = 9; },
    move: (next) => { next.tombstones.reverse(); },
    version: (next) => { next.version = 2; },
    member: (next) => { next.laterBuildState = null; },
    'no lineage': (next) => { next.tombstones.push(withoutLineage(entry(3))); },
    'a lineage of another shape': (next) => { next.tombstones.push({ ...entry(3), lineage: { epochEntryId: 7 } }); }
  };
  for (const [label, change] of Object.entries(refused)) {
    await assert.rejects(knowledge.writeRegistry(change, { env }), { code: 'control_ledger_malformed' }, label);
    assert.deepEqual(await readFile(registry), bytes, label);
  }
  let calls = 0;
  await knowledge.writeRegistry((next) => { next.tombstones.push(entry(3)); }, { env, rename: async (from, to) => {
    calls += 1;
    if (calls <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return rename(from, to);
  } });
  assert.equal(calls, 3);
  assert.equal((await registryOf(env)).tombstones.length, 3);
  const settled = await readFile(registry);
  calls = 0;
  await assert.rejects(knowledge.writeRegistry((next) => { next.tombstones.push(entry(4)); }, { env, rename: async () => { calls += 1; throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }), { code: 'EPERM' });
  assert.equal(calls, 5);
  assert.deepEqual(await readFile(registry), settled);
  assert.deepEqual(await temporaries(env.SHADOWGRAPH_HOME), []);
});

for (const [backend, options] of BACKENDS) test(`D42 ${backend}: a plain purge save takes the store fence, then the registry lock, releases it before the payload commit, and writes no payload file before the deletion records (P48, P49)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const lock = await fenceLockPath(registryFile(state.env));
  const opened = [];
  const seen = {};
  const original = fs.promises.open;
  fs.promises.open = async (path, flags, ...rest) => {
    if (flags === 'wx' && String(path).endsWith('.lock')) opened.push(basename(String(path)));
    return original(path, flags, ...rest);
  };
  syncBuiltinESMExports();
  try {
    await purge(state, 'p', 'logical', { saveFault: (stage) => {
      if (stage === 'deletionLedgerWritten') seen.temporaries = readdirSync(state.dir).filter((name) => name.endsWith('.tmp') && !name.includes('.control.json'));
      if (stage === 'beforeCommit') seen.registryLock = existsSync(lock);
    } });
  } finally { fs.promises.open = original; syncBuiltinESMExports(); }
  assert.deepEqual(opened.slice(-2), [`${basename(state.file)}.lock`, 'deletion-registry.json.lock'], 'the store fence, then the registry lock');
  assert.equal(opened.filter((name) => name === 'deletion-registry.json.lock').length, 1);
  assert.deepEqual(seen, { temporaries: [], registryLock: false });
});

// ---------------------------------------------------------------------------
// §1.4, §2.4: real registries, lineage, and the earlier markers a hard purge splices.
// ---------------------------------------------------------------------------

for (const [backend, options] of BACKENDS) test(`D22 ${backend}: a pre-purge backup restored into a new path, a recreated folder and another store under one home loses p's tokened material and quarantines its tokenless material through the real registry; with no registry, Corner 1; a post-purge copy is postdated by its marker anchor (rev6:418-423, P11)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  const graph = createShadowGraph();
  const hidden = graph.addDecision({ project: 'p', title: `hidden ${SENTINEL}`, chosen: 'h' }).id;
  const legacy = graph.addDecision({ project: 'p', title: `legacy ${SENTINEL}`, chosen: 'l' }).id;
  const kept = graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' }).id;
  const state = await storeAt(t, backend, stripToken(privilegedSnapshot(graph), legacy), { dir: join(dir, 's'), env });
  const b0 = { ...(await backupOf(state, 'b0')) };
  const outside = { ...b0, file: join(dir, `b0.${extensionOf(backend)}`) };
  await rename(b0.file, outside.file);
  assert.equal((await purge(state, 'p')).backups, BACKUPS, 'the purge said earlier backups still hold its material (Corner 1)');
  const [tombstone] = (await ledgerOf(state)).tombstones;
  const unrelated = createShadowGraph();
  unrelated.addDecision({ project: 'q', title: 'other store', chosen: 'o' });
  const other = await storeAt(t, backend, privilegedSnapshot(unrelated), { dir: join(dir, 'o'), env, name: `other.${extensionOf(backend)}` });
  const destinations = [['a new path', async () => ({ ...state, dir: join(dir, 'n'), file: join(dir, 'n', basename(state.file)) })], ['the deleted and recreated folder', async () => {
    await rm(state.dir, { recursive: true, force: true });
    await mkdir(state.dir);
    return state;
  }], ['another store under the same home', async () => other]];
  for (const [label, destinationOf] of destinations) {
    const destination = await destinationOf();
    const result = await restoreInto(destination, outside);
    assert.equal(result.deletionKnowledge, 'present', label);
    const restored = await stored(destination);
    assert.equal(JSON.stringify(restored).includes(hidden), false, `${label}: tokened material removed`);
    const seen = visible(await load(destination));
    assert.deepEqual([seen.has(legacy), seen.has(kept)], [false, true], `${label}: tokenless material quarantined`);
    assert.equal(entitiesOf(restored).some((entity) => entity.id === legacy), true, `${label}: quarantined, not removed`);
    assert.equal((await ledgerOf(destination)).tombstones.some((item) => knowledge.canonical(item) === knowledge.canonical(tombstone)), true, `${label}: merged with its lineage stripped`);
  }
  // Corner 1 (rev6:465-466): the registry deleted, and no sidecar.
  await rm(registryFile(env));
  const corner = { ...state, dir: join(dir, 'c'), file: join(dir, 'c', basename(state.file)) };
  assert.equal((await restoreInto(corner, outside)).deletionKnowledge, 'none');
  assert.equal(visible(await load(corner)).has(hidden), true);
  // P11: a post-purge copy with its sidecar removed is postdated only by the registry entry's marker anchor.
  const moving = createShadowGraph();
  const moved = moving.addDecision({ originId: 'origin-a', title: 'moved', chosen: 'm' }).id;
  moving.attribute({ ids: [moved], targetProject: 'p', reason: 'moved in' });
  const elsewhere = moving.addDecision({ project: 'r', title: 'elsewhere', chosen: 'e' }).id;
  const second = await storeAt(t, backend, stripToken(privilegedSnapshot(moving), elsewhere), { dir: join(dir, 's2'), env });
  await purge(second, 'p');
  assert.equal((await registryOf(env)).tombstones.at(-1).moveIn, 'some');
  const b1 = await backupOf(second, 'b1');
  await rm(ledgerPath(b1.file));
  const fresh = { ...second, dir: join(dir, 'f'), file: join(dir, 'f', basename(second.file)) };
  const result = await restoreInto(fresh, b1);
  assert.deepEqual([result.deletionKnowledge, result.reapplied], ['present', ZERO]);
  assert.equal(visible(await load(fresh)).has(elsewhere), true);
});

for (const [backend, options] of BACKENDS) test(`D23 ${backend}: another lineage's intact backup disproves the real registry entry and restores as with no registry; a gapped one does not, as declared (rev6:424, P10, P53)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph), { dir: join(dir, 's'), env });
  await purge(state, 'p');
  for (const gapped of [false, true]) {
    const other = createShadowGraph();
    const legacy = other.addDecision({ project: 'p', title: 'their p', chosen: 'u' }).id;
    other.addDecision({ project: 'q', title: 'their q', chosen: 'q' });
    if (gapped) {
      other.addDecision({ project: 'g', title: 'gone', chosen: 'g' });
      other.purgeProject('g', { mode: 'hard' });
    }
    const label = gapped ? 'gapped' : 'intact';
    const u = await storeAt(t, backend, stripToken(structuredClone(privilegedSnapshot(other)), legacy), { dir: join(dir, `u-${label}`), env });
    const backup = await backupOf(u, 'backup');
    const twin = { ...u, dir: join(dir, `twin-${label}`), file: join(dir, `twin-${label}`, basename(u.file)), env: { SHADOWGRAPH_HOME: join(dir, 'empty-home') } };
    await restoreInto(twin, backup);
    const destination = { ...u, dir: join(dir, `d-${label}`), file: join(dir, `d-${label}`, basename(u.file)) };
    const result = await restoreInto(destination, backup);
    if (!gapped) {
      assert.equal(result.deletionKnowledge, 'none', label);
      assert.equal(existsSync(ledgerPath(destination.file)), false, label);
      assert.deepEqual(await stored(destination), await stored(twin), `${label}: as with no registry`);
      assert.equal(visible(await load(destination)).has(legacy), true, label);
    } else {
      assert.equal(result.deletionKnowledge, 'present', `${label}: declared (N2)`);
      assert.equal(visible(await load(destination)).has(legacy), false, `${label}: quarantined, as declared`);
    }
  }
});

for (const [backend, options] of BACKENDS) test(`D23 ${backend}: a purge of a store whose journal is empty anchors its registry entry's epoch on its own marker, so an unrelated intact backup disproves it and restores with no deletion knowledge (§1.4; review finding 9)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  const state = await storeAt(t, backend, privilegedSnapshot(createShadowGraph()), { dir: join(dir, 's'), env });
  assert.deepEqual((await stored(state)).journal, [], 'an empty journal');
  await purge(state, 'p');
  const marker = markerOf(await stored(state), 'p').id;
  assert.deepEqual((await registryOf(env)).tombstones.map((tombstone) => tombstone.lineage), [{ epochEntryId: marker, headEntryId: null, markerEntryId: marker }]);
  const unrelated = createShadowGraph();
  unrelated.addDecision({ project: 'p', title: 'their p', chosen: 'u' });
  const u = await storeAt(t, backend, privilegedSnapshot(unrelated), { dir: join(dir, 'u'), env });
  assert.equal((await restoreInto(freshAt(u, 'restored'), await backupOf(u, 'backup'))).deletionKnowledge, 'none');
});

// B: p written between q entries, so a splice leaves a gap inside the journal (the PR-37c rev6:427 shape).
function betweenGraph() {
  const graph = createShadowGraph();
  graph.addDecision({ project: 'q', title: 'first', chosen: 'f' });
  graph.addDecision({ project: 'p', title: `between ${SENTINEL}`, chosen: 'b' });
  graph.remember({ project: 'p', memoryType: 'note', key: 'k', text: `memory ${SENTINEL}` });
  graph.addDecision({ project: 'q', title: 'last', chosen: 'l' });
  return graph;
}

// A restore of `source` into `state` through an entry: the direct one, CLI, MCP or HTTP.
async function restoreThrough(t, entry, state, source) {
  if (entry === 'direct') return restoreInto(state, source);
  if (entry === 'cli') {
    const result = await cli(state, ['restore', source.file]);
    assert.equal(result.code, 0, result.stderr);
    return JSON.parse(result.stdout);
  }
  if (entry === 'mcp') {
    const [text] = await mcp(t, state, [['shadowgraph_restore', { source: source.file }]]);
    const parsed = JSON.parse(text).result;
    assert.notEqual(parsed?.isError, true, text);
    return parsed.structuredContent ?? JSON.parse(parsed.content[0].text);
  }
  const saved = process.env.SHADOWGRAPH_HOME;
  process.env.SHADOWGRAPH_HOME = state.env.SHADOWGRAPH_HOME;
  try {
    const app = await createShadowGraphServer({ file: state.file, storage: state.backend, cwd: state.dir, apiToken: '' });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try {
      const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, { method: 'POST', body: JSON.stringify({ source: source.file }) });
      const text = await response.text();
      assert.equal(response.status, 200, text);
      return JSON.parse(text);
    } finally { await new Promise((done) => app.server.close(done)); }
  } finally { process.env.SHADOWGRAPH_HOME = saved; }
}

for (const [backend, options] of BACKENDS) test(`D24 ${backend}: a real hard purge's tombstone re-applied through every entry splices p's material, explained by restore.reapplied, valid and rebuildable; a logical one keeps skeletons (rev6:427)`, options, async (t) => {
  for (const entry of ['direct', 'cli', 'mcp', 'http']) for (const mode of ['hard', 'logical']) {
    const label = `${entry} ${mode}`;
    const state = await storeAt(t, backend, privilegedSnapshot(betweenGraph()));
    const source = await backupOf(state, 'pre-purge');
    await purge(state, 'p', mode);
    const result = await restoreThrough(t, entry, state, source);
    assert.equal(result.deletionKnowledge, 'present', label);
    assert.equal(result.reapplied.quarantined, 0, label);
    assert.ok(result.reapplied.removed > 0, label);
    const after = await stored(state);
    const reapplied = after.journal.filter((item) => item.type === 'restore.reapplied');
    assert.deepEqual(reapplied.map((item) => item.payload.mode), [mode], label);
    const skeletons = after.journal.filter((item) => item.redacted === true && item.type !== 'project.purged').length;
    if (mode === 'hard') {
      assert.equal(skeletons, 0, `${label}: no skeleton of the material`);
      assert.ok(reapplied[0].payload.spliced > 0, label);
      assert.equal(reapplied[0].payload.removedJournalSequences.length, reapplied[0].payload.spliced, label);
      assert.ok(privilegedValidate(graphOf(after)).issues.some((issue) => issue.code === 'journal_gap' && issue.severity === 'info'), `${label}: validate reports the gap`);
    } else assert.equal(skeletons, reapplied[0].payload.skeletons, label);
    assert.doesNotThrow(() => validateRestorePayload(structuredClone(after)), `${label}: rebuild parity`);
    assert.equal(JSON.stringify(after).includes(SENTINEL), false, label);
    const copy = await backupOf(state, 'after');
    await restoreInto(freshAt(state, 'again'), copy);
  }
});

for (const [backend, options] of BACKENDS) test(`D25 ${backend}: a line derived before a real purge expands to purged, or unavailable after a hard one, once a pre-purge restore wiped the marker (G5-6)`, options, async (t) => {
  for (const [mode, reason] of [['logical', 'purged'], ['hard', 'unavailable']]) {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'alpha', title: 'message queue', chosen: 'postgres outbox', alternatives: [{ label: 'kafka cluster', reasonRejected: 'operational cost' }] });
    graph.addDecision({ project: 'beta', title: 'kept', chosen: 'k' });
    const { operation, scope, ...handle } = graph.context({ project: 'alpha', query: 'kafka', compact: true }).relevant.items[0].line.expansion;
    const input = { ...handle, project: scope.project };
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    const prePurge = await backupOf(state, 'pre-purge');
    await delay(5);
    await purge(state, 'alpha', mode);
    await restoreInto(state, prePurge);
    const restored = graphOf(await load(state));
    assert.equal(privilegedSnapshot(restored).journal.some((entry) => entry.type === 'project.purged'), false, `${mode}: the marker is gone`);
    assert.equal(restored.expand(input).status, reason, mode);
    assert.equal(restored.expand({ ...input, derivedAt: new Date(Date.now() + 86_400_000).toISOString() }).status, 'unavailable', mode);
  }
});

for (const [backend, options] of BACKENDS) test(`D31 ${backend}: a hard purge that splices an earlier marker no tombstone records writes one lifted form keyed on its own marker; the pre-purge material stays out where the store's ledger reaches, a post-purge backup is untouched, and the declared reaches hold (R1, N1, N3, P51, P60, P62)`, options, async (t) => {
  for (const gapped of [false, true]) {
    const label = gapped ? 'gapped' : 'plain';
    const graph = createShadowGraph();
    const x = graph.addDecision({ project: 'P', title: `x ${SENTINEL}`, chosen: 'x' }).id;
    const q = graph.addDecision({ project: 'Q', title: 'q', chosen: 'q' }).id;
    if (gapped) graph.addDecision({ project: 'R', title: 'r', chosen: 'r' });
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    if (gapped) await purge(state, 'R', 'hard');
    const b0 = await backupOf(state, 'b0');
    await purgeByMarker(state, 'P');
    await write(state, (live) => live.addDecision({ project: 'P', title: 'y', chosen: 'y' }));
    const before = await ledgerOf(state);
    await purge(state, 'P', 'hard');
    const k1 = markerOf(await stored(state), 'P');
    const ledger = await ledgerOf(state);
    const added = ledger.tombstones.slice(before?.tombstones.length ?? 0);
    assert.deepEqual(added[0], { kind: 'project', purgedProject: 'P', mode: 'hard', at: k1.at, seq: k1.seq, tokens: null, moveIn: gapped ? 'unknown' : 'none' }, `${label}: the lifted form, keyed on K1`);
    assert.deepEqual([added.length, added[1].tokens.length, added[1].at, added[1].seq], [2, 1, k1.at, k1.seq], `${label}: then K1's own tombstone`);
    assert.equal((await registryOf(state.env)).tombstones.some((tombstone) => tombstone.tokens === null), false, `${label}: no registry entry for the form`);
    // B0 into a copy of the store carrying its ledger: X removed.
    const copy = await backupOf(state, 'copy-k1');
    const into = await restoreInto(copy, b0);
    assert.ok(into.reapplied.removed >= 1, label);
    assert.equal(JSON.stringify(await stored(copy)).includes(x), false, `${label}: X is not in the store`);
    assert.equal(JSON.stringify(graphOf(await load(copy)).exportData({ project: 'P' })).includes(SENTINEL), false, `${label}: nor in the export`);
    // A backup taken after K1 restored into a fresh path: nothing quarantined.
    const ids = await write(state, (live) => [live.addDecision({ project: 'P', title: 'z', chosen: 'z' }).id, live.addDecision({ project: 'Q', title: 'w', chosen: 'w' }).id]);
    const b1 = await backupOf(state, 'b1');
    const fresh = await restoreInto(freshAt(state, `f1-${label}`), b1);
    assert.equal(fresh.reapplied?.quarantined ?? 0, 0, `${label}: N1`);
    const seen = visible(await load(freshAt(state, `f1-${label}`)));
    assert.deepEqual([q, ...ids].filter((id) => !seen.has(id)), [], `${label}: every entity visible`);
    // Declared (N3, Corner 1): B0 into a fresh path shows X, reached by K1's registry entry.
    const corner = await restoreInto(freshAt(state, `f2-${label}`), b0);
    assert.equal(corner.deletionKnowledge, 'present', label);
    assert.equal(visible(await load(freshAt(state, `f2-${label}`))).has(x), true, `${label}: declared`);
    // Declared (the orphan residual): K2 splices K1's marker; a later backup into a fresh path, then into the store.
    await purge(state, 'P', 'hard');
    const [z2, w2] = await write(state, (live) => [live.addDecision({ project: 'P', title: 'z2', chosen: 'z' }).id, live.addDecision({ project: 'Q', title: 'w2', chosen: 'w' }).id]);
    assert.equal((await ledgerOf(state)).tombstones.filter((tombstone) => tombstone.tokens === null).length, 1, `${label}: K2 writes no new form`);
    const b2 = await backupOf(state, 'b2');
    await restoreInto(freshAt(state, `f3-${label}`), b2);
    const orphaned = visible(await load(freshAt(state, `f3-${label}`)));
    const all = [q, ids[1], z2, w2];
    assert.deepEqual(all.filter((id) => !orphaned.has(id)), gapped ? all : [z2], `${label}: declared reach`);
    const own = await restoreInto(state, b2);
    assert.equal(own.reapplied?.quarantined ?? 0, 0, `${label}: into the store`);
  }
});

for (const [backend, options] of BACKENDS) test(`D32 ${backend}: when a hard purge spliced the epoch entry, a later purge's registry entry takes the epoch from the same lineage's entry, so an unrelated intact backup disproves it; null only when nothing names one (R2, N2, P53)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  const build = () => {
    const graph = createShadowGraph();
    graph.addDecision({ project: 'E', title: 'first', chosen: 'e' });
    const moved = graph.addDecision({ originId: 'origin-a', title: 'moved', chosen: 'm' }).id;
    graph.attribute({ ids: [moved], targetProject: 'G', reason: 'moved in' });
    graph.addDecision({ project: 'Q', title: 'kept', chosen: 'k' });
    return privilegedSnapshot(graph);
  };
  const payload = build();
  assert.equal(payload.journal.find((entry) => entry.seq === payload.journalEpoch).project, 'E');
  const state = await storeAt(t, backend, payload, { dir: join(dir, 's'), env });
  const before = await backupOf(state, 'before');
  await purge(state, 'E', 'hard');
  const [e] = (await registryOf(env)).tombstones;
  assert.equal(e.lineage.epochEntryId, epochOf(payload));
  const afterSplice = await backupOf(state, 'after');
  await purge(state, 'G');
  const g = (await registryOf(env)).tombstones[1];
  assert.deepEqual([g.moveIn, g.lineage.epochEntryId], ['some', e.lineage.epochEntryId]);
  // An unrelated store, intact or gapped, holding a tokenless entity of another project than G.
  for (const gapped of [false, true]) {
    const unrelated = createShadowGraph();
    const tokenless = unrelated.addDecision({ project: 'U', title: 'unrelated', chosen: 'u' }).id;
    if (gapped) {
      unrelated.addDecision({ project: 'H', title: 'gone', chosen: 'h' });
      unrelated.purgeProject('H', { mode: 'hard' });
    }
    const label = gapped ? 'gapped' : 'intact';
    const u = await storeAt(t, backend, stripToken(structuredClone(privilegedSnapshot(unrelated)), tokenless), { dir: join(dir, `u-${label}`), env });
    const destination = freshAt(u, `restored-${label}`);
    const result = await restoreInto(destination, await backupOf(u, 'backup'));
    assert.equal(result.deletionKnowledge, gapped ? 'present' : 'none', label);
    assert.equal(visible(await load(destination)).has(tokenless), !gapped, label);
  }
  // The store's own backups, before and after E's splice, are not disproved: G's entry merges into both.
  for (const [label, source] of [['before', before], ['after', afterSplice]]) {
    const destination = freshAt(state, `own-${label}`);
    assert.equal((await restoreInto(destination, source)).deletionKnowledge, 'present', label);
    assert.equal((await ledgerOf(destination)).tombstones.some((tombstone) => tombstone.purgedProject === 'G'), true, label);
  }
  // Declared: E purged by a copy save, so no registry entry names the epoch: G's anchor is null.
  const { env: otherHome } = await scratch(t);
  const variant = await storeAt(t, backend, build(), { env: otherHome });
  await purgeByMarker(variant, 'E', 'hard');
  await purge(variant, 'G');
  assert.equal((await registryOf(otherHome)).tombstones[0].lineage.epochEntryId, null);
});

for (const [backend, options] of BACKENDS) test(`D32 ${backend}: with another lineage's entry, naming an epoch, already in the registry, G's entry still takes its epoch from E's, so the store's own pre-purge backup restored into a fresh path merges G and withholds G's tokenless entity (review finding 4)`, options, async (t) => {
  const { dir, env } = await scratch(t);
  // Another store under the same home purges first: an entry of another lineage, with an epoch of its own.
  const another = createShadowGraph();
  for (const project of ['Z', 'K']) another.addDecision({ project, title: project, chosen: project });
  await purge(await storeAt(t, backend, privilegedSnapshot(another), { dir: join(dir, 'x'), env }), 'Z');
  // D32's store, its decision moved into G tokenless, so only G's lineage reaches it.
  const graph = createShadowGraph();
  graph.addDecision({ project: 'E', title: 'first', chosen: 'e' });
  const moved = graph.addDecision({ originId: 'origin-a', title: 'moved', chosen: 'm' }).id;
  graph.attribute({ ids: [moved], targetProject: 'G', reason: 'moved in' });
  graph.addDecision({ project: 'Q', title: 'kept', chosen: 'k' });
  const state = await storeAt(t, backend, stripToken(privilegedSnapshot(graph), moved), { dir: join(dir, 's'), env });
  const before = await backupOf(state, 'before');
  await purge(state, 'E', 'hard');
  await purge(state, 'G');
  const [z, e, g] = (await registryOf(env)).tombstones;
  assert.deepEqual([z.purgedProject, e.purgedProject, g.purgedProject], ['Z', 'E', 'G']);
  assert.notEqual(z.lineage.epochEntryId, e.lineage.epochEntryId, 'two lineages');
  assert.equal(g.lineage.epochEntryId, e.lineage.epochEntryId, 'G\'s epoch is its own lineage\'s');
  const destination = freshAt(state, 'own-before');
  assert.equal((await restoreInto(destination, before)).deletionKnowledge, 'present');
  assert.equal((await ledgerOf(destination)).tombstones.some((tombstone) => tombstone.purgedProject === 'G'), true, 'G\'s entry merges');
  assert.equal(visible(await load(destination)).has(moved), false, 'G\'s tokenless entity is withheld');
});

for (const [backend, options] of BACKENDS) test(`D32 ${backend}: one save that hard-purges the epoch's project and then purges another names an epoch in both registry entries, the second's from the first's entry of the same commit (review finding 6)`, options, async (t) => {
  const graph = createShadowGraph();
  for (const project of ['E', 'Q', 'K']) graph.addDecision({ project, title: project, chosen: project });
  const payload = privilegedSnapshot(graph);
  const state = await storeAt(t, backend, payload);
  await write(state, (live) => {
    live.purgeProject('E', { mode: 'hard' });
    live.purgeProject('Q');
  });
  assert.deepEqual((await registryOf(state.env)).tombstones.map((tombstone) => [tombstone.purgedProject, tombstone.lineage.epochEntryId]), [['E', epochOf(payload)], ['Q', epochOf(payload)]]);
});

for (const [backend, options] of BACKENDS) test(`D32 ${backend}: with an unsaved entry before them, one save that hard-purges E and then purges Q, uninterrupted or completed after a crash, names an epoch in every registry entry, so an unrelated store's backup restores with no deletion knowledge and its tokenless Q decision visible (re-review new finding 2)`, options, async (t) => {
  for (const crashed of [false, true]) {
    const label = crashed ? 'completed after a crash' : 'uninterrupted';
    const graph = createShadowGraph();
    for (const project of ['E', 'Q', 'K']) graph.addDecision({ project, title: project, chosen: project });
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    // The unsaved entry is the head before both purges, so neither purge's head nor marker is in the stored journal.
    const batch = (live) => {
      live.addDecision({ project: 'Z', title: 'unsaved', chosen: 'z' });
      live.purgeProject('E', { mode: 'hard' });
      live.purgeProject('Q');
    };
    if (!crashed) await write(state, batch);
    else {
      const { thrown, saveFault } = fault('beforeCommit');
      await assert.rejects(write(state, batch, { saveFault }), (error) => error === thrown);
      await assert.rejects(write(state, (live) => live.addDecision({ project: 'K', title: 'next', chosen: 'n' })), { name: 'RevisionConflictError' });
      assert.equal((await ledgerOf(state)).pending, undefined, label);
    }
    const entries = (await registryOf(state.env)).tombstones;
    assert.deepEqual(entries.filter((entry) => !entry.lineage.epochEntryId).map((entry) => entry.purgedProject), [], `${label}: every entry names an epoch`);
    // An unrelated store under the same home, its Q decision tokenless.
    const unrelated = createShadowGraph();
    unrelated.addDecision({ project: 'K2', title: 'k', chosen: 'k' });
    const tokenless = unrelated.addDecision({ project: 'Q', title: 'unrelated q', chosen: 'u' }).id;
    const u = await storeAt(t, backend, stripToken(privilegedSnapshot(unrelated), tokenless), { dir: join(state.dir, 'u'), env: state.env });
    const destination = freshAt(u, 'restored');
    assert.equal((await restoreInto(destination, await backupOf(u, 'backup'))).deletionKnowledge, 'none', label);
    assert.equal(visible(await load(destination)).has(tokenless), true, `${label}: the unrelated decision is visible`);
  }
});

// ---------------------------------------------------------------------------
// §4: a purge record -- load suppression, and completion by the next write only.
// ---------------------------------------------------------------------------

// A purge of p whose save fails at `stage`, after its deletion records were written (§3.9): the crash window.
async function crashWindow(t, backend, { stage = 'beforeCommit', mode = 'logical', project = 'p', payload, state: given } = {}) {
  const state = given ?? await storeAt(t, backend, payload ?? privilegedSnapshot(projectGraph().graph));
  const { thrown, saveFault } = fault(stage);
  await assert.rejects(purge(state, project, mode, { saveFault }), (error) => error === thrown);
  const ledger = await ledgerOf(state);
  return { state, ledger, record: ledger.pending[0], marker: ledger.pending[0].purges[0].marker };
}

const hashesOf = async (state) => [await storeHash(state), await fileHash(ledgerPath(state.file)), await fileHash(registryFile(state.env))];
const conflicting = (state) => assert.rejects(write(state, (live) => live.addDecision({ project: 'q', title: 'next', chosen: 'n' })), { name: 'RevisionConflictError' });
const say = (uuid, text) => `${JSON.stringify({ type: 'assistant', uuid, message: { role: 'assistant', content: [{ type: 'text', text }] } })}\n`;
const removedIn = (text, ids) => Object.values(ids).filter((id) => text.includes(id));
// A payload's shape for comparing two runs of one purge: its records and facts, its journal with the marker's own id
// and instant left out, and the size of every collection.
const shapeOf = (payload) => ({
  records: payload.records, facts: payload.facts,
  journal: payload.journal.map(({ id, at, ...entry }) => (entry.type === 'project.purged' ? entry : { id, at, ...entry })),
  counts: Object.fromEntries(Object.entries(payload).filter(([, value]) => Array.isArray(value)).map(([name, value]) => [name, value.length]))
});

// D7's store: p's material, a tokenless legacy decision of p, a read's misses and a capture session, W quarantined in
// p and one item in q; an activation record in a home of its own names the store for delivery and capture, and the
// working directory is bound to q. Its twin, in a home of its own, is purged without a fault.
async function windowStore(t, backend) {
  const { graph, ids } = projectGraph();
  ids.legacy = graph.addDecision({ project: 'p', title: `legacy ${SENTINEL}`, chosen: 'l' }).id;
  ids.withheld = graph.addDecision({ project: 'p', title: `withheld ${SENTINEL}`, chosen: 'w' }).id;
  const other = graph.addDecision({ project: 'q', title: 'quarantined q', chosen: 'o' }).id;
  graph.context({ project: 'p', query: 'zebra crossing' });
  const payload = stripToken(privilegedSnapshot(graph), ids.legacy);
  const { dir, env } = await scratch(t);
  const state = await storeAt(t, backend, payload, { dir, env });
  const twin = await storeAt(t, backend, payload, { dir: join(dir, 'twin'), env: { SHADOWGRAPH_HOME: join(dir, 'twin-home') } });
  const quarantined = [ids.withheld, other].map((id) => ({ token: tokenOf(payload, id), at: '2026-01-01T00:00:00.000Z' }));
  for (const each of [state, twin]) await writeFile(ledgerPath(each.file), JSON.stringify({ version: 1, quarantine: quarantined }));
  const cwd = join(dir, 'work');
  const sgHome = join(dir, 'sg-home');
  const userHome = join(dir, 'user-home');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  await mkdir(sgHome);
  await mkdir(userHome);
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'q', confirmed: true }));
  const capture = { state: 'active', changedAt: '2026-01-01T00:00:00.000Z', evidence: 'synthetic', store: { file: state.file, storage: backend }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'] };
  const activation = join(sgHome, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { delivery: { state: 'active', store: { file: state.file, storage: backend } }, capture } }));
  const capturing = () => runCapture({ capture, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt: 'during', message_id: 'm-window', session_id: 'session-1', cwd, transcript_path: join(dir, 'none.jsonl') }), deadline: Date.now() + 10_000, record: activation, home: userHome, cwd });
  const delivering = async () => {
    let text = '';
    await runDeliver({ args: ['--hook'], readInput: () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-1' }), env: { SHADOWGRAPH_HOME: sgHome }, write: (out) => { text += out; } });
    const lines = JSON.parse(text).hookSpecificOutput.additionalContext.split('\n');
    const line = (prefix) => JSON.parse(lines.find((entry) => entry.startsWith(prefix)).slice(prefix.length));
    return { text, head: line('head: '), processing: line('processing: ') };
  };
  return { state, twin, ids, other, payload, dir, capturing, delivering };
}

for (const [backend, options] of BACKENDS) test(`D7 ${backend}: the crash window (rev6:429): through direct JS, MCP and HTTP the records wait beside an unchanged payload; a load withholds the whole project, every read writes nothing and the hook nothing; the next CLI write completes the purge as an uninterrupted run would, then conflicts once (P13, P14, P16, P17, P18, P21, P34, P40, P41, P52, P59)`, options, async (t) => {
  for (const entry of ['direct', 'mcp', 'http']) {
    const s = await windowStore(t, backend);
    const { state, ids } = s;
    assert.ok(s.payload.runtimeMisses.some((miss) => miss.scope.project === 'p'), 'a read of p left misses');
    assert.ok(s.payload.captureSessions.some((session) => session.project === 'p'), 'p has a capture session');
    const before = await storeHash(state);
    const { thrown, saveFault } = fault('beforeCommit');
    if (entry === 'direct') {
      await assert.rejects(purge(state, 'p', 'logical', { saveFault }), (error) => error === thrown && error.code === 'injected_fault' && error.message.endsWith(RECORDED));
    } else if (entry === 'mcp') {
      const faultFile = join(s.dir, 'save-fault');
      await writeFile(faultFile, 'beforeCommit');
      const [text] = await mcp(t, state, [['shadowgraph_purge', { project: 'p', mode: 'logical' }]], state.env.SHADOWGRAPH_HOME, { NODE_ENV: 'test', SHADOWGRAPH_TEST_SAVE_FAULT_FILE: faultFile });
      assert.equal(await readFile(faultFile, 'utf8'), 'triggered:beforeCommit', text);
    } else {
      const response = await http(state, (url) => fetch(url('/projects'), { method: 'DELETE', body: JSON.stringify({ project: 'p', mode: 'logical' }) }).then(async (answer) => ({ status: answer.status, text: await answer.text() })), { extra: { saveFault } });
      assert.notEqual(response.status, 200, response.text);
    }
    // The records wait beside the payload as it was; nothing identifying is in them, and no temporary file is left.
    const ledger = await ledgerOf(state);
    const { marker } = ledger.pending?.[0]?.purges?.[0] ?? {};
    assert.equal(ledger.tombstones.length, 1, entry);
    assert.deepEqual(ledger.pending, [{ kind: 'purge', purges: [{ project: 'p', mode: 'logical', marker }] }], entry);
    assert.equal((await registryOf(state.env)).tombstones.length, 1, entry);
    assert.equal(await storeHash(state), before, `${entry}: the payload is unchanged`);
    assert.deepEqual(await temporaries(s.dir), [], entry);
    for (const path of [ledgerPath(state.file), registryFile(state.env)]) {
      const text = await readFile(path, 'utf8');
      assert.deepEqual(removedIn(text, ids), [], `${entry}: ${basename(path)}`);
      assert.equal(text.includes(SENTINEL), false, `${entry}: ${basename(path)}`);
    }
    // A load holds the whole project, the tokenless decision included, with its events, misses and sessions (P14, P21).
    const live = privilegedLiveSnapshot(graphOf(await load(state)));
    assert.deepEqual(entitiesOf(live).filter((entity) => entity.project === 'p').map((entity) => entity.id), [], `${entry}: p's entities`);
    assert.deepEqual(live.events.filter((item) => item.project === 'p'), [], `${entry}: p's events`);
    assert.deepEqual((live.runtimeMisses ?? []).filter((miss) => miss.scope?.project === 'p'), [], `${entry}: p's misses`);
    assert.deepEqual((live.captureSessions ?? []).filter((session) => session.project === 'p'), [], `${entry}: p's sessions`);
    if (entry === 'direct') {
      // Every read, the delivery hook, the quarantine selection and the capture hook write nothing (P16, P17, P52).
      const window = await hashesOf(state);
      const texts = [JSON.stringify(graphOf(await load(state)).exportData({ project: 'p' }))];
      const delivered = await s.delivering();
      texts.push(delivered.text);
      assert.equal(delivered.head.store, 'available', 'memory is served');
      assert.deepEqual([delivered.processing.capture, delivered.processing.reason], backend === 'json' ? ['unavailable', 'deletion_pending'] : ['not_active', undefined]);
      for (const args of [['list', JSON.stringify({ project: 'p' })], ['search', JSON.stringify({ project: 'p', query: 'hidden' })]]) {
        const result = await cli(state, args);
        assert.equal(result.code, 0, result.stderr);
        texts.push(result.stdout);
      }
      texts.push(...await mcp(t, state, [['shadowgraph_search', { query: 'hidden decision', project: 'p' }], ['shadowgraph_journal', { project: 'p' }]]));
      texts.push(...await http(state, (url) => Promise.all(['/records?project=p', '/search?project=p&q=hidden'].map(async (path) => (await fetch(url(path))).text()))));
      const listed = await withStore(state, (store) => quarantine.quarantineSelection(store, 'list', {}));
      assert.deepEqual(listed.entries.map((item) => item.id), [s.other], 'the listing shows none of p\'s quarantined items');
      const selection = await withStore(state, (store) => quarantine.quarantineSelection(store, 'release', { ids: [s.other] }));
      assert.deepEqual(selection.ids, [s.other], 'a release selection, its confirmation declined');
      await assert.rejects(s.capturing(), { code: PENDING }, 'the hook refuses');
      assert.deepEqual(await hashesOf(state), window, 'nothing wrote the store, its ledger or the registry');
      for (const text of texts) assert.equal(text.includes(SENTINEL), false, text.slice(0, 160));
      // A read of p is complete and shows nothing of p; a read of q is as it was, with no restore_pending (P34).
      const viewed = graphOf(await load(state));
      const read = viewed.context({ project: 'p', query: 'hidden' });
      assert.deepEqual([read.completeness.complete, read.relevant.items.length], [true, 0], JSON.stringify(read.completeness));
      const other = viewed.context({ project: 'q', query: 'kept' });
      assert.equal(JSON.stringify(other).includes('restore_pending'), false);
      assert.deepEqual(other.relevant.items.map((item) => item.id), graphOf(structuredClone(s.payload)).context({ project: 'q', query: 'kept' }).relevant.items.map((item) => item.id));
    }
    // The next CLI write completes the purge with the record's marker, then conflicts once (V-9; P18, P41).
    const next = await cli(state, ['decision', JSON.stringify({ project: 'q', title: 'after', chosen: 'a' })]);
    assert.notEqual(next.code, 0, entry);
    assert.match(next.stderr, /revision conflict/i, entry);
    const after = await stored(state);
    assert.deepEqual(after.journal.filter((item) => item.type === 'project.purged' && item.project === 'p').map((item) => [item.id, item.at, item.seq]), [[marker.id, marker.at, marker.seq]], `${entry}: one marker, the record's`);
    assert.deepEqual(await ledgerOf(state), { version: 1, quarantine: ledger.quarantine, tombstones: ledger.tombstones }, `${entry}: the one tombstone, no record`);
    assert.equal((await registryOf(state.env)).tombstones.length, 1, `${entry}: the one entry`);
    for (const path of [state.file, `${state.file}-wal`]) {
      if (!existsSync(path)) continue;
      const bytes = (await readFile(path)).toString('latin1');
      assert.deepEqual(removedIn(bytes, ids), [], `${entry}: ${basename(path)} names a removed id`);
      assert.equal(bytes.includes(SENTINEL), false, `${entry}: ${basename(path)} holds content`);
    }
    // It equals the same purge run without the fault, the marker's live count included (K-2; P40).
    await purge(s.twin, 'p');
    assert.deepEqual(shapeOf(after), shapeOf(await stored(s.twin)), entry);
  }
});

// The reads that carry an access reference, each through its surface, giving the code its caller receives and, where
// the surface passes it on, the message: their audit is a save, which refuses while any record waits, as no read
// completes one (rev6:365; review finding 2), saying a write completes it, not that a later build is needed (re-review
// note 9). MCP passes on the code alone.
const READ_REFUSAL = /A deletion or restore on this store completes at its next write, and a read never completes one/u;
const ACCESS_READS = {
  'CLI context': async (t, state) => {
    const { stderr } = await cli(state, ['context', JSON.stringify({ project: 'q', accessId: 'grant_bogus' })]);
    return { code: /\((\w+)\)\s*$/u.exec(stderr)?.[1], message: stderr };
  },
  'MCP context': async (t, state) => ({ code: JSON.parse((await mcp(t, state, [['shadowgraph_context', { project: 'q', accessId: 'grant_bogus' }]]))[0]).error?.data?.issueCode }),
  'MCP search': async (t, state) => ({ code: JSON.parse((await mcp(t, state, [['shadowgraph_search', { query: 'kept', project: 'q', grantId: 'grant_bogus' }]]))[0]).error?.data?.issueCode }),
  'HTTP POST /context': (t, state) => http(state, async (url) => {
    const { code, error } = await (await fetch(url('/context'), { method: 'POST', body: JSON.stringify({ project: 'q', accessId: 'grant_bogus' }) })).json();
    return { code, message: error };
  })
};

for (const [backend, options] of BACKENDS) test(`D7 ${backend}: in the crash window a read carrying an access reference -- CLI context, MCP context and search, HTTP POST /context -- refuses with ${PENDING} and writes nothing; the next write completes the hard purge, and a waiting restore record is left as well (rev6:365; review finding 2)`, options, async (t) => {
  const { state, ledger, marker } = await crashWindow(t, backend, { mode: 'hard' });
  const window = await hashesOf(state);
  for (const [surface, read] of Object.entries(ACCESS_READS)) {
    const { code, message } = await read(t, state);
    assert.equal(code, PENDING, `${surface}: refused`);
    if (message !== undefined) assert.match(message, READ_REFUSAL, `${surface}: says the next write completes it`);
    assert.deepEqual(await hashesOf(state), window, `${surface}: nothing written`);
  }
  assert.deepEqual((await ledgerOf(state)).pending, ledger.pending, 'the record waits');
  await conflicting(state);
  assert.deepEqual([(await ledgerOf(state)).pending, markerOf(await stored(state), 'p')?.id], [undefined, marker.id], 'the next write completes it');
  // A restore record a crash before the post-step left (PR-37c design §8.4) is left by such a read too.
  const restored = await storeAt(t, backend, privilegedSnapshot(projectGraph().graph));
  const b0 = await backupOf(restored, 'b0');
  await purge(restored, 'p');
  const crash = { restoreFault: (stage) => { if (stage === 'beforePostStep') throw new Error('a crash before the post-step'); } };
  const result = backend === 'json' ? await restoreInto(restored, b0, crash) : await withStore(restored, (store) => store.restore(b0.file), crash);
  assert.equal(result.completion, 'pending');
  const waiting = await hashesOf(restored);
  const refusal = await ACCESS_READS['CLI context'](t, restored);
  assert.equal(refusal.code, PENDING, 'a restore record: refused');
  assert.match(refusal.message, READ_REFUSAL, 'a restore record: says the next write completes it');
  assert.deepEqual(await hashesOf(restored), waiting, 'a restore record: nothing written');
  await conflicting(restored);
  assert.equal((await ledgerOf(restored)).pending, undefined, 'the next write completes it');
});

// The access lifecycle operations, each through its surface, giving the code its caller receives, if any, and the entry
// it gets: an access request, which is a write, so its save completes a waiting record and then records the request
// (re-review new finding 7).
const ACCESS_REQUEST = { scope: { projects: ['q'] }, expiresAt: '2099-01-01T00:00:00.000Z', reason: 'D7 lifecycle' };
const ACCESS_LIFECYCLE = {
  'HTTP POST /access-requests': (t, state) => http(state, async (url) => {
    const response = await fetch(url('/access-requests'), { method: 'POST', body: JSON.stringify({ ...ACCESS_REQUEST, surfaces: ['http'] }) });
    const { code, type } = await response.json();
    return [code, type];
  }),
  'MCP shadowgraph_request_wider_access': async (t, state) => {
    const answer = JSON.parse((await mcp(t, state, [['shadowgraph_request_wider_access', { ...ACCESS_REQUEST, surfaces: ['mcp'] }]]))[0]);
    return [answer.error?.data?.issueCode, answer.result?.structuredContent?.type];
  }
};

for (const [backend, options] of BACKENDS) test(`D7 ${backend}: in the crash window an access lifecycle operation -- HTTP POST /access-requests, MCP shadowgraph_request_wider_access -- is a write: it completes the purge record and records its request (re-review new finding 7)`, options, async (t) => {
  for (const [surface, request] of Object.entries(ACCESS_LIFECYCLE)) {
    const { state, marker } = await crashWindow(t, backend);
    assert.deepEqual(await request(t, state), [undefined, 'request'], surface);
    const after = await stored(state);
    assert.deepEqual([(await ledgerOf(state)).pending, markerOf(after, 'p')?.id], [undefined, marker.id], `${surface}: the record is completed`);
    assert.deepEqual(after.access.entries.map((entry) => entry.type), ['request'], `${surface}: the request is recorded`);
  }
});

for (const [backend, options] of BACKENDS) test(`D7 ${backend}: in the crash window each quarantine verb that writes, release and purge, completes the purge record first: the record goes, the registry entry lands and the marker is stored (§4.2, V-19; review finding 10)`, options, async (t) => {
  for (const subcommand of ['release', 'purge']) {
    const { graph } = projectGraph();
    const other = graph.addDecision({ project: 'q', title: 'quarantined q', chosen: 'o' }).id;
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    await writeFile(ledgerPath(state.file), JSON.stringify({ version: 1, quarantine: [{ token: tokenOf(await stored(state), other), at: '2026-01-01T00:00:00.000Z' }] }));
    const { ledger, marker } = await crashWindow(t, backend, { stage: 'deletionLedgerWritten', state });
    assert.equal(await registryOf(state.env), null, `${subcommand}: no registry entry yet`);
    const result = await withStore(state, (store) => quarantine.applyQuarantine(store, subcommand, [other]));
    assert.deepEqual(result.ids, [other], subcommand);
    const after = await ledgerOf(state);
    assert.deepEqual([after.pending, after.tombstones], [undefined, ledger.tombstones], `${subcommand}: the record goes`);
    assert.deepEqual((await registryOf(state.env)).tombstones.map((tombstone) => tombstone.lineage.markerEntryId), [marker.id], `${subcommand}: the entry lands`);
    assert.equal(markerOf(await stored(state), 'p')?.id, marker.id, `${subcommand}: the purge is stored`);
  }
});

for (const [backend, options] of BACKENDS) test(`D10 ${backend}: a purge record over a store deleted in the window: the store is made again, the next save clears the record without re-running the purge, and the registry gets the record's tombstone with lineage { null, null, K } once (V-12, P20, P54)`, options, async (t) => {
  for (const stage of ['deletionLedgerWritten', 'beforeCommit']) {
    const { graph, ids } = projectGraph();
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    const b0 = await backupOf(state, 'b0');
    const { ledger, marker } = await crashWindow(t, backend, { stage, state });
    const registry = (await registryOf(state.env))?.tombstones ?? [];
    assert.equal(registry.length, stage === 'beforeCommit' ? 1 : 0, stage);
    for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${state.file}${suffix}`, { force: true });
    await withStore(state, async (store) => {
      const live = graphOf(await store.load());
      live.addDecision({ project: 'q', title: 'after', chosen: 'a' });
      await store.save(privilegedSnapshot(live));
    });
    assert.equal((await stored(state)).journal.some((entry) => entry.type === 'project.purged'), false, `${stage}: no purge re-run on the empty store`);
    assert.deepEqual(await ledgerOf(state), { version: 1, tombstones: ledger.tombstones }, `${stage}: the tombstone stays, the record goes`);
    const expected = stage === 'beforeCommit' ? registry : [{ ...ledger.tombstones[0], lineage: { epochEntryId: null, headEntryId: null, markerEntryId: marker.id } }];
    assert.deepEqual((await registryOf(state.env)).tombstones, expected, `${stage}: one entry`);
    const fresh = freshAt(state, `fresh-${stage}`);
    await restoreInto(fresh, b0);
    const seen = visible(await load(fresh));
    assert.deepEqual(Object.values(ids).filter((id) => seen.has(id)), [], `${stage}: nothing of p`);
  }
});

// A store holding only p's capture session, which a self-event opened: no record, fact, capture or journal entry. Its
// host session id is a sentinel (review finding 1).
const SESSION = 'purge-writer-session-sentinel-5c1d';
function sessionsOnly() {
  const graph = createShadowGraph();
  privilegedRecordSelfEvent(graph, { project: 'p', originId: 'origin-a', signal: 'S-1', source: { event: 'PostToolUse', sessionId: SESSION } });
  return privilegedSnapshot(graph);
}

for (const [backend, options] of BACKENDS) test(`D10 ${backend}: a purge record over a store holding only p's capture session is no empty store: the next save re-runs the purge as an uninterrupted run would, so no file keeps the session (review finding 1)`, options, async (t) => {
  const payload = sessionsOnly();
  assert.deepEqual([payload.records.length, payload.facts.length, payload.journal.length, payload.captureSessions.map((session) => session.project)], [0, 0, 0, ['p']], 'only p\'s session');
  const { state, ledger, marker } = await crashWindow(t, backend, { payload });
  const twin = await storeAt(t, backend, payload);
  await purge(twin, 'p');
  assert.deepEqual(await filesHolding(twin.dir, SESSION), [], 'an uninterrupted purge keeps the session nowhere');
  // The next unrelated save re-runs the purge on the stored payload, and then conflicts once (V-9).
  const next = await write(state, (live) => live.addDecision({ project: 'q', title: 'next', chosen: 'n' })).then(() => null, (error) => error);
  assert.deepEqual(await filesHolding(state.dir, SESSION), [], 'no file keeps p\'s session');
  assert.equal(next?.name, 'RevisionConflictError', 'the purge re-ran, so the write conflicts once');
  const after = await stored(state);
  assert.deepEqual(after.journal.filter((entry) => entry.type === 'project.purged').map((entry) => entry.id), [marker.id], 'one marker, the record\'s');
  assert.deepEqual(await ledgerOf(state), { version: 1, tombstones: ledger.tombstones }, 'the one tombstone, no record');
  assert.equal((await registryOf(state.env)).tombstones.length, 1, 'the one entry');
  assert.deepEqual(shapeOf(after), shapeOf(await stored(twin)), 'as the uninterrupted run');
});

const dropStore = async (state) => { for (const suffix of ['', '-wal', '-shm', '-journal']) await rm(`${state.file}${suffix}`, { force: true }); };

for (const [backend, options] of BACKENDS) test(`D10 ${backend}: a hard purge record that wrote a lifted form, over a store deleted in the window: the next save gives the registry the record's own token tombstone, never the lifted form, so the pre-purge backup restored into a fresh path loses y (review finding 5)`, options, async (t) => {
  const graph = createShadowGraph();
  graph.addDecision({ project: 'P', title: `x ${SENTINEL}`, chosen: 'x' });
  graph.addDecision({ project: 'Q', title: 'q', chosen: 'q' });
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  await purgeByMarker(state, 'P');
  const y = await write(state, (live) => live.addDecision({ project: 'P', title: 'y', chosen: 'y' }).id);
  const b0 = await backupOf(state, 'b0');
  const { ledger, marker } = await crashWindow(t, backend, { stage: 'deletionLedgerWritten', mode: 'hard', project: 'P', state });
  assert.deepEqual(ledger.tombstones.map((tombstone) => tombstone.tokens?.length ?? null), [null, 1], 'the lifted form, then K1\'s tombstone');
  await dropStore(state);
  await write(state, (live) => live.addDecision({ project: 'Q', title: 'after', chosen: 'a' }));
  assert.deepEqual((await registryOf(state.env)).tombstones, [{ ...ledger.tombstones[1], lineage: { epochEntryId: null, headEntryId: null, markerEntryId: marker.id } }], 'K1\'s token tombstone only');
  const fresh = freshAt(state, 'fresh');
  const { reapplied } = await restoreInto(fresh, b0);
  assert.deepEqual([reapplied.removed > 0, reapplied.spliced > 0], [true, true], JSON.stringify(reapplied));
  assert.equal(JSON.stringify(await stored(fresh)).includes(y), false, 'y is removed and spliced');
});

for (const [backend, options] of BACKENDS) test(`D10 ${backend}: a purge record over a store deleted in the window goes only once its registry entry lands: with the registry lock held, or the registry write failing under it, the save refuses and keeps the record, and the next write lands the entry (review finding 5)`, options, async (t) => {
  const next = (state, extra) => write(state, (live) => live.addDecision({ project: 'q', title: 'after', chosen: 'a' }), extra);
  for (const blocked of ['the registry lock held', 'the registry write failing']) {
    const { state, ledger, marker } = await crashWindow(t, backend, { stage: 'deletionLedgerWritten' });
    await dropStore(state);
    const before = await fileHash(ledgerPath(state.file));
    if (blocked === 'the registry lock held') {
      const lock = await fenceLockPath(registryFile(state.env));
      await writeFile(lock, `${process.pid}:${Date.now()}:holder`);
      await assert.rejects(next(state, { lockTimeoutMs: 300 }), { code: 'storage_lock_timeout' }, blocked);
      await rm(lock);
    } else {
      // The registry's temporary file cannot be made, so the append fails inside the registry lock.
      const original = fs.promises.open;
      fs.promises.open = async (path, ...rest) => {
        if (basename(String(path)).startsWith('.deletion-registry.json.')) throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return original(path, ...rest);
      };
      syncBuiltinESMExports();
      try { await assert.rejects(next(state), { code: 'EACCES' }, blocked); } finally { fs.promises.open = original; syncBuiltinESMExports(); }
    }
    assert.deepEqual([await fileHash(ledgerPath(state.file)), await registryOf(state.env)], [before, null], `${blocked}: the record is kept, and no entry`);
    await next(state);
    assert.equal((await ledgerOf(state)).pending, undefined, blocked);
    assert.deepEqual((await registryOf(state.env)).tombstones, [{ ...ledger.tombstones[0], lineage: { epochEntryId: null, headEntryId: null, markerEntryId: marker.id } }], `${blocked}: the next write lands the entry`);
  }
});

for (const [backend, options] of BACKENDS) test(`D11 ${backend}: a batch save's completion re-runs the purge on the stored payload: its tombstone differs and is appended beside the first, and nothing of p returns through a pre-purge backup (V-1, §10.3)`, options, async (t) => {
  const { graph, ids } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const b0 = await backupOf(state, 'b0');
  const { thrown, saveFault } = fault('beforeCommit');
  await assert.rejects(write(state, (live) => {
    live.addDecision({ project: 'p', title: `batched ${SENTINEL}`, chosen: 'b' });
    live.purgeProject('p');
  }, { saveFault }), (error) => error === thrown);
  const { tombstones: [first], pending: [record] } = await ledgerOf(state);
  await conflicting(state);
  const { tombstones, pending } = await ledgerOf(state);
  assert.equal(pending, undefined);
  assert.deepEqual([tombstones.length, tombstones[0], tombstones[1].seq, tombstones[1].tokens.length], [2, first, first.seq - 1, first.tokens.length - 1], 'the completion\'s own tombstone beside the first');
  const marker = markerOf(await stored(state), 'p');
  assert.deepEqual([marker.id, marker.at, marker.seq], [record.purges[0].marker.id, record.purges[0].marker.at, first.seq - 1]);
  assert.equal((await registryOf(state.env)).tombstones.length, 2);
  for (const destination of [state, freshAt(state, 'fresh')]) {
    await restoreInto(destination, b0);
    const seen = visible(await load(destination));
    assert.deepEqual(Object.values(ids).filter((id) => seen.has(id)), []);
  }
});

for (const [backend, options] of BACKENDS) test(`D16 ${backend}: in a restore's step 0, a waiting purge whose registry would lie inside a repository refuses as itself, never as a restore this build cannot do, and nothing is written (§3.3, §4.5; P45)`, options, async (t) => {
  if (!gitAvailable) { t.skip('git is not available'); return; }
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const b0 = await backupOf(state, 'b0');
  await crashWindow(t, backend, { stage: 'deletionLedgerWritten', state });
  git(['init', '-q', join(state.dir, 'repo')]);
  const inside = { ...state, env: { SHADOWGRAPH_HOME: join(state.dir, 'repo', 'home') } };
  const before = [await storeHash(state), await fileHash(ledgerPath(state.file))];
  await assert.rejects(restoreInto(inside, b0), (error) => error.code === DESTINATION && !error.message.includes(basename(state.dir)));
  assert.deepEqual([await storeHash(state), await fileHash(ledgerPath(state.file))], before);
  assert.equal(existsSync(join(state.dir, 'repo', 'home')), false);
});

for (const [backend, options] of BACKENDS) test(`D26 ${backend}: a purge save while a restore holds the store waits and then conflicts, writing nothing; a backup started while a purge record waits completes it and carries the tombstone and no record (V-9)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const other = createShadowGraph();
  other.addDecision({ project: 'q', title: 'restored', chosen: 'r' });
  const source = await storeAt(t, backend, privilegedSnapshot(other), { dir: join(state.dir, 'b'), env: state.env });
  await withStore(state, async (store) => {
    const live = graphOf(await store.load());
    live.purgeProject('p');
    let release;
    const gate = new Promise((done) => { release = done; });
    let paused = false;
    const restoring = restoreInto(state, source, { validate: async () => { paused = true; await gate; } });
    await until(() => paused, 'the restore to hold the store');
    let settled = false;
    const saving = store.save(privilegedSnapshot(live)).finally(() => { settled = true; });
    saving.catch(() => {});
    await delay(300);
    assert.equal(settled, false, 'the purge save waits');
    release();
    await restoring;
    await assert.rejects(saving, { name: 'RevisionConflictError' });
  });
  assert.deepEqual([await ledgerOf(state), await registryOf(state.env)], [null, null], 'the conflicted purge wrote nothing');
  const window = await crashWindow(t, backend);
  const copy = await backupOf(window.state, 'copy');
  assert.deepEqual(await readJson(ledgerPath(copy.file)), { version: 1, tombstones: window.ledger.tombstones }, 'the sidecar: the tombstone, no record');
  assert.equal((await ledgerOf(window.state)).pending, undefined);
  for (const each of [window.state, copy]) assert.equal(markerOf(await stored(each), 'p')?.id, window.marker.id);
});

for (const [backend, options] of BACKENDS) test(`D39 ${backend}: a restore's step 0 completes a waiting purge before its pre-step, through every restore entry: one marker, the record's, no lifted tombstone, the registry entry written, and p's tokened material removed (P45)`, options, async (t) => {
  for (const entry of ['direct', 'cli', 'mcp', 'http']) {
    const { graph, ids } = projectGraph();
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    const b0 = await backupOf(state, 'b0');
    const { ledger, marker } = await crashWindow(t, backend, { stage: 'deletionLedgerWritten', state });
    let atPreStep = null;
    const result = entry === 'direct'
      ? await restoreInto(state, b0, { validate: async () => { atPreStep ??= await stored(state); } })
      : await restoreThrough(t, entry, state, b0);
    if (entry === 'direct') assert.deepEqual(atPreStep.journal.filter((item) => item.type === 'project.purged').map((item) => [item.id, item.at]), [[marker.id, marker.at]], 'step 0 completed the purge before the pre-step');
    assert.deepEqual([result.deletionKnowledge, result.reapplied.removed > 0], ['present', true], entry);
    const after = await ledgerOf(state);
    assert.deepEqual([after.pending, after.tombstones.filter((tombstone) => tombstone.tokens === null)], [undefined, []], `${entry}: no record, nothing lifted`);
    assert.deepEqual(after.tombstones.slice(0, 1), ledger.tombstones, entry);
    assert.deepEqual((await registryOf(state.env)).tombstones.map((tombstone) => tombstone.lineage.markerEntryId), [marker.id], `${entry}: the completion wrote the registry entry`);
    const { hidden, second, memory, fact, capture } = ids;
    assert.deepEqual(removedIn(JSON.stringify(await stored(state)), { hidden, second, memory, fact, capture }), [], `${entry}: p's tokened material removed`);
  }
});

for (const [backend, options] of BACKENDS) test(`D31 ${backend}: the completion of a hard purge that splices an earlier marker no tombstone records leaves exactly one lifted form (P51)`, options, async (t) => {
  const graph = createShadowGraph();
  graph.addDecision({ project: 'P', title: `x ${SENTINEL}`, chosen: 'x' });
  graph.addDecision({ project: 'Q', title: 'q', chosen: 'q' });
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  await purgeByMarker(state, 'P');
  await write(state, (live) => live.addDecision({ project: 'P', title: 'y', chosen: 'y' }));
  const { ledger, marker } = await crashWindow(t, backend, { stage: 'deletionLedgerWritten', mode: 'hard', project: 'P', state });
  assert.deepEqual(ledger.tombstones.map((tombstone) => tombstone.tokens === null), [true, false], 'the lifted form, then K1\'s tombstone');
  await conflicting(state);
  assert.deepEqual(await ledgerOf(state), { version: 1, tombstones: ledger.tombstones }, 'exactly one lifted form; no record');
  assert.equal(markerOf(await stored(state), 'P').id, marker.id);
  assert.deepEqual((await registryOf(state.env)).tombstones.map(withoutLineage), ledger.tombstones.slice(1), 'K1\'s entry, none for the form');
});

test('D34: an SQLite purge that removes nothing commits its payload and then fails at afterCommit, leaving its record; the next write clears the record only (R9, §3.4)', SQLITE, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, 'sqlite', privilegedSnapshot(graph));
  const { thrown, saveFault } = fault('afterCommit');
  await assert.rejects(purge(state, 'empty', 'logical', { saveFault }), (error) => error === thrown && error.message.endsWith(RECORDED));
  const committed = await stored(state);
  const marker = markerOf(committed, 'empty');
  assert.ok(marker, 'the payload is committed with its marker');
  const ledger = await ledgerOf(state);
  assert.deepEqual(ledger.pending, [{ kind: 'purge', purges: [{ project: 'empty', mode: 'logical', marker: { id: marker.id, at: marker.at, seq: marker.seq } }] }]);
  await write(state, (live) => live.addDecision({ project: 'q', title: 'next', chosen: 'n' }));
  const after = await stored(state);
  assert.equal(after.revision, committed.revision + 1, 'the resolution moved no revision');
  assert.deepEqual(after.journal.filter((entry) => entry.type === 'project.purged').map((entry) => entry.id), [marker.id]);
  assert.deepEqual(await ledgerOf(state), { version: 1, tombstones: ledger.tombstones });
});

// A child that purges p from its store and pauses while it holds the registry lock, after its ledger write, to be
// killed there.
const KILLED_PURGER = `
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [src, file, backend, home, paused] = process.argv.slice(2);
const from = (path) => import(pathToFileURL(join(src, path)).href);
const { createShadowGraph } = await from('shadowgraph.js');
const { createStorage } = await from('storage.js');
const { privilegedSnapshot } = await from(join('internal', 'snapshot.js'));
const store = await createStorage({ type: backend, file, env: { SHADOWGRAPH_HOME: home }, saveFault: async (stage) => {
  if (stage !== 'deletionLedgerWritten') return;
  writeFileSync(paused, 'paused');
  setInterval(() => {}, 1000);
  await new Promise(() => {});
} });
const graph = createShadowGraph();
graph.importData(await store.load());
graph.purgeProject('p');
await store.save(privilegedSnapshot(graph));
`;

for (const [backend, options] of BACKENDS) test(`D35 ${backend}: a purger killed while it holds the registry lock leaves both locks; the next write reclaims them once stale and completes the purge (R10, §3.7)`, options, async (t) => {
  const { graph } = projectGraph();
  const state = await storeAt(t, backend, privilegedSnapshot(graph));
  const script = join(state.dir, 'killed-purger.mjs');
  const paused = join(state.dir, 'paused');
  await writeFile(script, KILLED_PURGER);
  const child = spawn(process.execPath, [script, srcRoot, state.file, backend, state.env.SHADOWGRAPH_HOME, paused], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  await until(() => existsSync(paused) || child.exitCode !== null, 'the purger to pause');
  assert.equal(existsSync(paused), true, stderr);
  child.kill('SIGKILL');
  await exited;
  const locks = [await fenceLockPath(state.file), await fenceLockPath(registryFile(state.env))];
  assert.deepEqual(locks.map((path) => existsSync(path)), [true, true], 'both locks are left');
  await delay(250);
  await assert.rejects(write(state, (live) => live.addDecision({ project: 'q', title: 'next', chosen: 'n' }), { staleLockMs: 200, lockTimeoutMs: 2000 }), { name: 'RevisionConflictError' });
  const ledger = await ledgerOf(state);
  assert.deepEqual([ledger.tombstones.length, ledger.pending, (await registryOf(state.env)).tombstones.length], [1, undefined, 1]);
  assert.ok(markerOf(await stored(state), 'p'));
  assert.deepEqual(locks.map((path) => existsSync(path)), [false, false], 'no lock file is left');
});

for (const [backend, options] of BACKENDS) test(`D36 ${backend}: a purge record without its tombstone, or a bare one, refuses the load, a save and a backup, and nothing is written (P35)`, options, async (t) => {
  const records = [
    ['without its tombstone', [{ kind: 'purge', purges: [{ project: 'p', mode: 'logical', marker: { id: 'jentry_1_k', at: '2026-01-01T00:00:00.000Z', seq: 9 } }] }]],
    ['bare', [{ kind: 'purge' }]]
  ];
  for (const [label, pending] of records) {
    const { graph } = projectGraph();
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    await writeFile(ledgerPath(state.file), JSON.stringify({ version: 1, pending }));
    const before = await hashesOf(state);
    await assert.rejects(load(state), { code: PENDING }, `${label}: load`);
    await assert.rejects(withStore(state, (store) => store.save(privilegedSnapshot(graph))), { code: PENDING }, `${label}: save`);
    await assert.rejects(backupOf(state, 'copy'), { code: PENDING }, `${label}: backup`);
    assert.deepEqual(await hashesOf(state), before, label);
    assert.equal(existsSync(join(state.dir, `copy.${extensionOf(backend)}`)), false, label);
  }
});

for (const [backend, options] of BACKENDS) test(`D38 ${backend}: an unreadable store during the crash window refuses a save and a backup, keeps the record, and the next write after a repair completes the purge (P44)`, options, async (t) => {
  const { state } = await crashWindow(t, backend);
  const bytes = await readFile(state.file);
  const ledger = await fileHash(ledgerPath(state.file));
  await withStore(state, async (store) => {
    await writeFile(state.file, 'not a store');
    if (backend === 'json') await assert.rejects(store.save(privilegedSnapshot(projectGraph().graph)), /invalid or unreadable/);
    await assert.rejects(backupFile(state.file, join(state.dir, `copy.${extensionOf(backend)}`), { env: state.env, ...(backend === 'sqlite' ? { store } : {}) }), { code: PENDING });
  });
  assert.equal(await fileHash(ledgerPath(state.file)), ledger, 'the record is kept');
  await writeFile(state.file, bytes);
  await conflicting(state);
  assert.deepEqual([(await ledgerOf(state)).pending, Boolean(markerOf(await stored(state), 'p'))], [undefined, true]);
});

// D40: purge records this build must refuse, each with the tombstones beside it (§3.5). The first row is valid.
const AT = '2026-01-01T00:00:00.000Z';
const recorded = (overrides = {}) => ({ kind: 'project', purgedProject: 'p', mode: 'logical', at: AT, seq: 3, tokens: [], moveIn: 'none', ...overrides });
const purging = (marker = {}, extra = {}) => ({ project: 'p', mode: 'logical', marker: { id: 'jentry_1_k', at: AT, seq: 3, ...marker }, ...extra });
const RECORD_TABLE = [
  ['valid', [recorded()], [{ kind: 'purge', purges: [purging()] }]],
  ['an extra member', [recorded()], [{ kind: 'purge', purges: [purging()], extra: true }]],
  ['an extra member of a purge', [recorded()], [{ kind: 'purge', purges: [purging({}, { extra: true })] }]],
  ['an extra member of a marker', [recorded()], [{ kind: 'purge', purges: [purging({ extra: true })] }]],
  ['no purges', [recorded()], [{ kind: 'purge', purges: [] }]],
  ['a bad at', [recorded()], [{ kind: 'purge', purges: [purging({ at: 'yesterday' })] }]],
  ['seq 0', [recorded({ seq: 0 })], [{ kind: 'purge', purges: [purging({ seq: 0 })] }]],
  ['an unknown mode', [recorded({ mode: 'soft' })], [{ kind: 'purge', purges: [{ ...purging(), mode: 'soft' }] }]],
  ['duplicate marker ids', [recorded(), recorded({ purgedProject: 'r', seq: 4 })], [{ kind: 'purge', purges: [purging(), { ...purging({ seq: 4 }), project: 'r' }] }]],
  ['a tombstone whose at differs', [recorded({ at: '2026-01-02T00:00:00.000Z' })], [{ kind: 'purge', purges: [purging()] }]],
  ['a tombstone whose seq differs', [recorded({ seq: 4 })], [{ kind: 'purge', purges: [purging()] }]],
  ['only a lifted form', [recorded({ mode: 'hard', tokens: null, moveIn: 'unknown' })], [{ kind: 'purge', purges: [{ ...purging(), mode: 'hard' }] }]],
  ['two records', [recorded(), recorded({ seq: 4 })], [{ kind: 'purge', purges: [purging()] }, { kind: 'purge', purges: [purging({ id: 'jentry_2_k', seq: 4 })] }]]
];

for (const [backend, options] of BACKENDS) test(`D40 ${backend}: purgeRecordValid refuses each malformed purge record at load, by the writer, by refuseAbsentWithRecord and at backup, and accepts the valid one (P46, P61)`, options, async (t) => {
  for (const [label, tombstones, pending] of RECORD_TABLE) {
    const valid = label === 'valid';
    const { graph } = projectGraph();
    const state = await storeAt(t, backend, privilegedSnapshot(graph));
    const contents = JSON.stringify({ version: 1, tombstones, pending });
    await writeFile(ledgerPath(state.file), contents);
    const refused = { code: PENDING };
    if (valid) assert.ok(await load(state), label);
    else await assert.rejects(load(state), refused, `${label}: load`);
    const absent = join(state.dir, `absent.${extensionOf(backend)}`);
    await writeFile(ledgerPath(absent), contents);
    if (valid) await knowledge.refuseAbsentWithRecord(absent);
    else await assert.rejects(knowledge.refuseAbsentWithRecord(absent), refused, `${label}: refuseAbsentWithRecord`);
    const written = join(state.dir, `written.${extensionOf(backend)}`);
    const change = (next) => { next.tombstones = tombstones; next.pending = pending; };
    if (valid) await knowledge.writeLedger(written, change, { env: state.env });
    else await assert.rejects(knowledge.writeLedger(written, change, { env: state.env }), { code: 'control_ledger_malformed' }, `${label}: the writer`);
    assert.equal(existsSync(ledgerPath(written)), valid, label);
    if (valid) continue;
    const before = await hashesOf(state);
    await assert.rejects(backupOf(state, 'copy'), refused, `${label}: backup`);
    assert.deepEqual(await hashesOf(state), before, label);
  }
});

for (const [backend, options] of BACKENDS) test(`D42 ${backend}: on a resolver's path -- a backup completing a waiting purge -- the restore lock, then the store fence, then the registry lock (P48)`, options, async (t) => {
  const { state } = await crashWindow(t, backend);
  const opened = [];
  const original = fs.promises.open;
  fs.promises.open = async (path, flags, ...rest) => {
    if (flags === 'wx' && String(path).endsWith('.lock')) opened.push(basename(String(path)));
    return original(path, flags, ...rest);
  };
  syncBuiltinESMExports();
  try { await backupOf(state, 'copy'); } finally { fs.promises.open = original; syncBuiltinESMExports(); }
  const first = opened.indexOf(`${basename(state.file)}.restore.lock`);
  assert.deepEqual(opened.slice(first, first + 3), [`${basename(state.file)}.restore.lock`, `${basename(state.file)}.lock`, 'deletion-registry.json.lock'], opened.join(', '));
  assert.equal((await ledgerOf(state)).pending, undefined);
});

// An activated capture of a JSON store in a scratch home: its worktree bound to p, and q holding a decision. `run`
// sends one host event through the hook (D19, D28).
async function activated(t) {
  const { dir, env } = await scratch(t);
  const cwd = join(dir, 'work');
  const userHome = join(dir, 'user-home');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  await mkdir(userHome);
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'p', confirmed: true }));
  const graph = createShadowGraph();
  privilegedBindProject(graph, { type: 'worktree', path: resolve(cwd), project: 'p', reason: 'D19', surface: 'cli' });
  graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const state = await storeAt(t, 'json', privilegedSnapshot(graph), { dir, env });
  const capture = { state: 'active', changedAt: '2026-01-01T00:00:00.000Z', evidence: 'synthetic', store: { file: state.file, storage: 'json' }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'] };
  const activation = join(dir, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { capture } }));
  const transcriptPath = join(dir, 'session.jsonl');
  await writeFile(transcriptPath, '');
  const run = (sessionId, payload, extra = {}) => runCapture({ capture, input: JSON.stringify({ session_id: sessionId, cwd, transcript_path: transcriptPath, ...payload }), deadline: Date.now() + 10_000, record: activation, home: userHome, cwd, ...extra });
  return { dir, env, state, capture, transcriptPath, run };
}

test('D19: after a purge through the CLI, the same host session and a new one capture again from the transcript\'s end; a restored p session with no start stays withheld (§5, R9; P15)', async (t) => {
  const { dir, env, state, capture, transcriptPath, run } = await activated(t);
  assert.equal(await run('session-1', { hook_event_name: 'UserPromptSubmit', prompt: `before ${SENTINEL}`, message_id: 'm1' }), 'written');
  await appendFile(transcriptPath, say('a1', 'pre-purge words'));
  const purged = await cli(state, ['purge', JSON.stringify({ project: 'p', mode: 'logical' })]);
  assert.equal(purged.code, 0, purged.stderr);
  const { tombstones: [tombstone], pending } = await ledgerOf(state);
  assert.equal(pending, undefined, 'the purge\'s own commit cleared its record');
  // A p session record with no start, restored from a hand-written backup after the purge, is withheld.
  const { revision, ...handWritten } = await stored(state);
  handWritten.captureSessions = [...(handWritten.captureSessions ?? []), { id: 'capsession_handwritten', originId: capture.originId, sessionId: 'session-3', project: 'p', attribution: 'project' }];
  await restoreInto(state, await storeAt(t, 'json', handWritten, { dir: join(dir, 'b'), env }));
  // The same host session and a new one record, without session_withheld, from the transcript's end.
  assert.equal(await run('session-1', { hook_event_name: 'UserPromptSubmit', prompt: 'after', message_id: 'm2' }), 'written');
  assert.equal(await run('session-1', { hook_event_name: 'Stop', last_assistant_message: 'after words' }), 'written');
  assert.equal(await run('session-2', { hook_event_name: 'UserPromptSubmit', prompt: 'second', message_id: 'm3' }), 'written');
  const after = await stored(state);
  const texts = (after.captureContent ?? []).map((entry) => entry.text);
  assert.deepEqual(texts.filter((text) => /pre-purge|before/u.test(text)), [], 'nothing from before the purge is captured');
  assert.ok(texts.includes('after') && texts.includes('second'), texts.join(' | '));
  for (const sessionId of ['session-1', 'session-2']) assert.ok(after.captureSessions.find((item) => item.sessionId === sessionId).startedAt >= tombstone.at, sessionId);
  const withheld = after.captureSessions.find((item) => item.sessionId === 'session-3');
  assert.equal(await run('session-3', { hook_event_name: 'UserPromptSubmit', prompt: 'withheld', message_id: 'm4' }), 'refused');
  assert.deepEqual((await stored(state)).captureSessions.find((item) => item.sessionId === 'session-3'), withheld, 'it stays withheld');
});

// ---------------------------------------------------------------------------
// §6: what a purge discloses.
// ---------------------------------------------------------------------------

const CATALOG = buildToolCatalog();
const outputSchemaOf = (name) => CATALOG.find((entry) => entry.name === name).outputSchema;
const COUNTS = ['records', 'captures', 'captureContent', 'captureSessions', 'withheld'];
const countsOf = (summary) => Object.fromEntries(COUNTS.map((name) => [name, summary[name]]));

// The dependency-free JSON Schema subset test/mcp-tool-conformance.test.js validates structured output with.
function schemaErrors(schema, value, path = '$', errors = []) {
  const fail = (message) => errors.push(`${path}: ${message}`);
  const object = value !== null && typeof value === 'object' && !Array.isArray(value);
  const matches = { object, array: Array.isArray(value), string: typeof value === 'string', integer: Number.isInteger(value), boolean: typeof value === 'boolean', number: Number.isFinite(value), null: value === null };
  if (schema.type !== undefined && !matches[schema.type]) { fail(`expected ${schema.type}`); return errors; }
  if (schema.enum && !schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value))) fail('value not in enum');
  if (object) {
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) fail(`missing required property ${key}`);
    for (const [key, subschema] of Object.entries(schema.properties ?? {})) if (Object.hasOwn(value, key)) schemaErrors(subschema, value[key], `${path}.${key}`, errors);
  }
  if (Array.isArray(value) && schema.items) value.forEach((item, index) => schemaErrors(schema.items, item, `${path}[${index}]`, errors));
  if (schema.anyOf && !schema.anyOf.some((branch) => schemaErrors(branch, value, path, []).length === 0)) fail('no anyOf branch matched');
  return errors;
}

// p holds only captures: two in one host session and one in another; q holds a decision.
function capturesOnly() {
  const graph = createShadowGraph();
  for (const [sessionId, text] of [['session-1', 'one'], ['session-1', 'two'], ['session-2', 'three']]) {
    privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: `${text} ${SENTINEL}`, admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId, role: 'user' } });
  }
  graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  return graph;
}

// The preview and a purge through one surface, each as the caller receives it.
const PREVIEW_AND_PURGE = {
  mcp: async (t, state) => (await mcp(t, state, [['shadowgraph_purge_preview', { project: 'p' }], ['shadowgraph_purge', { project: 'p' }]])).map((text, index) => {
    const name = index ? 'shadowgraph_purge' : 'shadowgraph_purge_preview';
    const value = JSON.parse(text).result?.structuredContent;
    assert.deepEqual(value && schemaErrors(outputSchemaOf(name), value), [], `${name}: ${text}`);
    return value;
  }),
  cli: async (t, state) => {
    const outputs = [];
    for (const command of ['purge-preview', 'purge']) {
      const run = await cli(state, [command, JSON.stringify({ project: 'p' })]);
      assert.equal(run.code, 0, run.stderr);
      outputs.push(JSON.parse(run.stdout));
    }
    return outputs;
  },
  http: (t, state) => http(state, async (url) => [
    await (await fetch(url('/projects/purge-preview'), { method: 'POST', body: JSON.stringify({ project: 'p' }) })).json(),
    await (await fetch(url('/projects'), { method: 'DELETE', body: JSON.stringify({ project: 'p' }) })).json()
  ])
};

for (const [backend, options] of BACKENDS) test(`D20 ${backend}: the preview and the result count p's captures, their content and sessions, and apart from them what deletion records withhold, through every surface; the marker's payload is unchanged (FND-P6-02, R5 L1 VS1; P31, P32, P33, P55)`, options, async (t) => {
  const ONLY = { records: 0, captures: 3, captureContent: 3, captureSessions: 2, withheld: 0 };
  const graph = capturesOnly();
  assert.deepEqual(countsOf(graph.projectSummary('p')), ONLY, 'the preview');
  const result = graph.purgeProject('p');
  assert.deepEqual([countsOf(result), result.removed], [ONLY, 3], 'the result; removed counts the captures');
  assert.deepEqual(Object.keys(markerOf(privilegedSnapshot(graph), 'p').payload).sort(), ['mode', 'project', 'removed', 'removedJournalSequences'], 'no count enters the marker (P32)');
  // Under a view quarantining two of p's decisions and one of its captures: those three are counted apart, and every
  // other count is of live memory (K-2); the tombstone names their tokens all the same (§1.2).
  const viewed = createShadowGraph();
  const ids = Object.fromEntries(['first', 'second', 'live'].map((name) => [name, viewed.addDecision({ project: 'p', title: name, chosen: name }).id]));
  for (const name of ['held', 'kept']) ids[name] = privilegedRecordCapture(viewed, { project: 'p', originId: 'origin-a', text: name, admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user' } }).id;
  const state = await storeAt(t, backend, privilegedSnapshot(viewed));
  const payload = await stored(state);
  await writeFile(ledgerPath(state.file), JSON.stringify({ version: 1, quarantine: ['first', 'second', 'held'].map((name) => ({ token: tokenOf(payload, ids[name]), at: '2026-01-01T00:00:00.000Z' })) }));
  const HELD = { records: 1, captures: 1, captureContent: 1, captureSessions: 1, withheld: 3 };
  assert.deepEqual(countsOf(graphOf(await load(state)).projectSummary('p')), HELD, 'the preview under the view');
  const purged = await purge(state, 'p');
  assert.deepEqual([countsOf(purged), purged.removed], [HELD, 2], 'the result under the view');
  assert.equal(markerOf(await stored(state), 'p').payload.removed, 2, 'the marker counts live memory');
  assert.deepEqual((await ledgerOf(state)).tombstones.at(-1).tokens, tokensIn(payload, 'p'), 'the tombstone names the withheld tokens');
  // Every surface: MCP's structured results validate against schemas that require the new fields; CLI and HTTP carry
  // them.
  for (const name of ['shadowgraph_purge_preview', 'shadowgraph_purge']) {
    const fields = [...COUNTS.slice(1), ...(name === 'shadowgraph_purge' ? ['backups'] : [])];
    assert.deepEqual(fields.filter((field) => !outputSchemaOf(name).required.includes(field)), [], `${name} requires every new field`);
  }
  for (const [surface, through] of Object.entries(PREVIEW_AND_PURGE)) {
    const [preview, done] = await through(t, await storeAt(t, backend, privilegedSnapshot(capturesOnly())));
    assert.deepEqual(countsOf(preview), ONLY, `${surface}: the preview`);
    assert.deepEqual([countsOf(done), done.removed, done.backups], [ONLY, 3, BACKUPS], `${surface}: the result`);
  }
});

for (const [backend, options] of BACKENDS) test(`D21 ${backend}: every purge result, both modes, an empty purge included, says earlier backups still hold the material, through direct JS, CLI, MCP and HTTP; the purge's description no longer calls it irreversible (rev6:401, V-14, V-15; P33, P42)`, options, async (t) => {
  assert.equal(knowledge.PURGE_BACKUPS_STATEMENT, BACKUPS);
  const tool = CATALOG.find((entry) => entry.name === 'shadowgraph_purge');
  assert.equal(tool.description.includes('Irreversible without a backup'), false, tool.description);
  assert.deepEqual([tool.outputSchema.properties.backups.enum, tool.outputSchema.required.includes('backups')], [[BACKUPS], true]);
  const PURGES = [['p', 'logical'], ['q', 'hard'], ['none', 'logical'], ['none', 'hard']];
  const each = async (step) => { const results = []; for (const [project, mode] of PURGES) results.push(await step(project, mode)); return results; };
  const surfaces = {
    direct: (state) => each((project, mode) => purge(state, project, mode)),
    cli: (state) => each(async (project, mode) => {
      const run = await cli(state, ['purge', JSON.stringify({ project, mode })]);
      assert.equal(run.code, 0, run.stderr);
      return JSON.parse(run.stdout);
    }),
    mcp: async (state) => (await mcp(t, state, PURGES.map(([project, mode]) => ['shadowgraph_purge', { project, mode }]))).map((text) => JSON.parse(text).result?.structuredContent ?? text),
    http: (state) => http(state, (url) => each(async (project, mode) => (await fetch(url('/projects'), { method: 'DELETE', body: JSON.stringify({ project, mode }) })).json()))
  };
  for (const [surface, through] of Object.entries(surfaces)) {
    const graph = createShadowGraph();
    for (const project of ['p', 'q']) graph.addDecision({ project, title: project, chosen: project });
    const results = await through(await storeAt(t, backend, privilegedSnapshot(graph)));
    assert.deepEqual(results.map((result) => [result.mode, result.backups]), PURGES.map(([, mode]) => [mode, BACKUPS]), `${surface}: ${JSON.stringify(results)}`);
  }
});

// ---------------------------------------------------------------------------
// §4.6: the rollback floors.
// ---------------------------------------------------------------------------

// A build from this repository's history, its src written to a scratch directory and imported (T-16's pattern,
// test/deletion-knowledge.test.js); null where the history does not hold it.
async function buildAt(t, commit) {
  let tree;
  try { tree = execFileSync('git', ['ls-tree', '-r', '--name-only', commit, 'src'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n'); } catch { return null; }
  const root = await scratchDirectory(t, `purge-writer-floor-${commit}-`);
  for (const path of tree) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), execFileSync('git', ['show', `${commit}:${path}`]));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const module = (name) => import(pathToFileURL(join(root, 'src', name)).href);
  return { commit, storage: await module('storage.js'), kernel: await module('shadowgraph.js') };
}

test('D27: the 210f009 and fffeee5 builds open a PR-37d store, ledger and registry and withhold what this build withholds; each refuses a ledger holding a purge record and writes nothing (§4.6, §1.7; P32)', async (t) => {
  const builds = [];
  for (const commit of ['210f009', 'fffeee5']) {
    const build = await buildAt(t, commit);
    if (!build) { t.skip(`the history does not hold ${commit}`); return; }
    builds.push(build);
  }
  const hashes = async (state) => [await storeHash(state), await fileHash(ledgerPath(state.file)), await fileHash(registryFile(state.env))];
  let opened = 0;
  for (const [backend] of BACKENDS.filter(([, options]) => !options.skip)) {
    // PR-37d stores: S, which purged p, and a new path a pre-purge backup of S was restored into through the
    // registry, which removed p's tokened decision there and withholds its tokenless one.
    const { dir, env } = await scratch(t);
    const graph = createShadowGraph();
    const legacy = graph.addDecision({ project: 'p', title: `legacy ${SENTINEL}`, chosen: 'l' }).id;
    graph.addDecision({ project: 'p', title: `hidden ${SENTINEL}`, chosen: 'h' });
    graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
    const state = await storeAt(t, backend, stripToken(privilegedSnapshot(graph), legacy), { dir: join(dir, 's'), env });
    const b0 = await backupOf(state, 'b0');
    await purge(state, 'p');
    const restored = freshAt(state, 'n');
    await restoreInto(restored, b0);
    assert.equal((await registryOf(env)).tombstones.length, 1, `${backend}: the registry holds the purge's entry`);
    for (const store of [state, restored]) {
      const here = visible(await load(store));
      const withheld = entitiesOf(await stored(store)).map((entity) => entity.id).filter((id) => !here.has(id));
      if (store === restored) assert.deepEqual(withheld, [legacy], `${backend}: this build withholds p's tokenless decision`);
      const before = await hashes(store);
      for (const build of builds) {
        const floorStore = await build.storage.createStorage({ type: backend, file: store.file, env });
        let payload;
        try { payload = await floorStore.load(); } finally { floorStore.close?.(); }
        const floor = build.kernel.createShadowGraph();
        floor.importData(payload);
        const served = JSON.stringify(['p', 'q'].map((project) => floor.exportData({ project })));
        assert.deepEqual([withheld.filter((id) => served.includes(id)), served.includes(SENTINEL), served.includes('kept')], [[], false, true], `${build.commit} ${backend}: withholds what this build withholds`);
        opened += 1;
      }
      assert.deepEqual(await hashes(store), before, `${backend}: the floors wrote nothing`);
    }
    // A crash-left purge record: each floor refuses the load and a save, and writes nothing.
    const waiting = await storeAt(t, backend, privilegedSnapshot(projectGraph().graph), { dir: join(dir, 'w'), env: { SHADOWGRAPH_HOME: join(dir, 'w-home') } });
    const { thrown, saveFault } = fault('beforeCommit');
    await assert.rejects(purge(waiting, 'p', 'logical', { saveFault }), (error) => error === thrown);
    assert.equal((await ledgerOf(waiting)).pending?.[0]?.kind, 'purge');
    const left = await hashes(waiting);
    for (const build of builds) {
      const store = await build.storage.createStorage({ type: backend, file: waiting.file, env: waiting.env });
      try {
        await assert.rejects(store.load(), { code: PENDING }, `${build.commit} ${backend}: load`);
        await assert.rejects(store.save(await stored(waiting)), { code: PENDING }, `${build.commit} ${backend}: save`);
      } finally { store.close?.(); }
    }
    assert.deepEqual(await hashes(waiting), left, `${backend}: nothing written`);
  }
  t.diagnostic(`floors 210f009/fffeee5: ${opened} stores opened`);
});

// ---------------------------------------------------------------------------
// §7.3: the registry joins S-1's artefacts.
// ---------------------------------------------------------------------------

test('D28: the deletion registry and its lock are S-1 artefacts through a home given by a link: a tool call naming either is a self-event, and the listed lock is the fence\'s own (§7.3, P38)', async (t) => {
  const { dir, run } = await activated(t);
  const real = join(dir, 'real-home');
  await mkdir(real);
  const linked = join(dir, 'linked-home');
  try { await symlink(real, linked, WINDOWS ? 'junction' : 'dir'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.skip('no link to a folder can be made here'); return; }
  const registry = registryFile({ SHADOWGRAPH_HOME: linked });
  const lock = await fenceLockPath(registry);
  assert.equal(folded(lock), folded(join(realpathSync.native(real), 'deletion-registry.json.lock')), 'the fence\'s lock, through the link');
  const read = (path, id) => run('session-1', { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: path }, tool_response: 'x', tool_use_id: id }, { registry });
  assert.equal(await read(lock.slice(0, -'.lock'.length), 'toolu_1'), 'self_event', 'the registry');
  assert.equal(await read(lock, 'toolu_2'), 'self_event', 'its lock');
  assert.equal(await read(join(real, 'other.json'), 'toolu_3'), 'written', 'a file beside them is captured');
});

// ---------------------------------------------------------------------------
// §7.4: every test-file process has its own home, and children are isolated too.
// ---------------------------------------------------------------------------

test('D29: the preload gives each test file a fresh home, keeps an inherited one elsewhere, honours only a provable redirect, and reaches children (P39, P57, P58)', async (t) => {
  const { dir } = await scratch(t);
  const printer = `import { registryFile } from ${JSON.stringify(pathToFileURL(join(srcRoot, 'internal', 'deletion-knowledge.js')).href)};\nconsole.log(registryFile());\n`;
  const plain = join(dir, 'probe.mjs');
  const testFile = join(dir, 'probe.test.js');
  await writeFile(plain, printer);
  await writeFile(testFile, printer);
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith('SHADOWGRAPH_')));
  const print = (script, env) => {
    const result = spawnSync(process.execPath, [script], { env: { ...base, ...env }, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const temporary = folded(realpathSync.native(tmpdir()));
  const freshHome = (printed, label) => {
    const home = dirname(printed);
    assert.equal(basename(printed), 'deletion-registry.json', label);
    assert.match(basename(home), /^shadowgraph-test-home-/u, label);
    assert.equal(folded(realpathSync.native(dirname(home)) ?? ''), temporary, `${label}: directly under the temporary directory`);
  };
  const own = userInfo().homedir;
  const spellings = [['the account\'s home', own], ...(WINDOWS ? [['upper-cased', own.toUpperCase()], ['with a trailing separator', `${own}${sep}`]] : [])];
  for (const [label, home] of spellings) freshHome(print(plain, { HOME: home, USERPROFILE: home }), label);
  // A redirect to a folder that is not there cannot be resolved, so it is no proof (review finding 12).
  freshHome(print(plain, { HOME: join(dir, 'missing'), USERPROFILE: join(dir, 'missing') }), 'a missing folder');
  const redirected = join(dir, 'redirected');
  await mkdir(redirected);
  assert.equal(print(plain, { HOME: redirected, USERPROFILE: redirected }), join(redirected, '.shadowgraph', 'deletion-registry.json'));
  const inherited = join(dir, 'inherited');
  assert.equal(print(plain, { SHADOWGRAPH_HOME: inherited }), join(inherited, 'deletion-registry.json'));
  const fromTest = print(testFile, { SHADOWGRAPH_HOME: inherited });
  freshHome(fromTest, 'a test-file process');
  assert.equal(relative(inherited, fromTest).startsWith('..'), true);
  freshHome(registryFile(), 'this test file');
});

after(() => assert.equal(existsSync(registryFile()), false, 'nothing wrote the process-wide registry'));
