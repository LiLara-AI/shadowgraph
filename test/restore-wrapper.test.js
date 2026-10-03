// PR-37c: the DP-1 restore wrapper (briefs/PR37c-design.md, revision 3 with the R3-1..R3-7 corrections). These are
// the design's red tests (§13.3), each written before what it pins. They start with what the wrapper stands on: the
// ledger writer (§2), one store fence however the store's path is spelled, and the restore lock (§3.1), the
// restore-pending record as loads, delivery and the capture hook read it (§1.2, §8.1, §8.2, §8.5), no SQLite store
// recreated while a record waits (§3.3), and the capture-session time (§1.3); then the wrapper itself: the pre-step,
// activation, the post-step, discard and resolution (§4-§8, §12); and last the owner's quarantine verbs, what every
// read discloses, the expand lookup and the downgrade flag (§4.7, §9-§11). Records the wrapper did not write are
// hand-written, in the shape it writes them.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync, execSync, spawn, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import fs, { existsSync } from 'node:fs';
import { link, lstat, mkdir, readdir, readFile, rename, rm, stat, symlink, unlink, utimes, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore, createStorage } from '../src/storage.js';
import { createSqliteStore, exportSqlitePayload } from '../src/sqlite-storage.js';
import { backupFile, restoreFile } from '../src/backup.js';
import { downgradeStore, migrateStore } from '../src/schema-conversion.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { readStoreForDelivery, runDeliver } from '../src/delivery.js';
import { CAPTURE_LIMITS, runCapture, storeFootprint } from '../src/capture-hook.js';
import { createShadowGraphServer } from '../src/server.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { mintOriginId } from '../src/scope.js';
import * as fences from '../src/revision-store.js';
import * as knowledge from '../src/internal/deletion-knowledge.js';
import * as quarantine from '../src/internal/quarantine.js';
import { captureArtefacts, classifyCaptureSource } from '../src/internal/capture-source.js';
import { privilegedBindProject, privilegedIssueAccess, privilegedLiveSnapshot, privilegedRecordCapture, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { mergeAuthorityRestore } from '../src/authority-restore.js';
import { createFactAttestation, createLocalEvidenceVerifier } from '../src/verification.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-09-30T12:00:00.000Z';
const BEFORE = '2026-09-10T00:00:00.000Z';
const TOMBSTONE_AT = '2026-09-20T00:00:00.000Z';
const AFTER = '2026-09-25T00:00:00.000Z';
const SENTINEL = 'restore-wrapper-sentinel-5d1c';
const PENDING = 'deletion_pending_unsupported_at_this_build';
const ADMISSION = Object.freeze({ limits: { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 }, storeBytes: 0 });
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE = sqlite.available ? {} : { skip: sqlite.reason };
const BACKENDS = [['json', {}], ['sqlite', SQLITE]];
const WINDOWS = process.platform === 'win32' ? {} : { skip: 'Windows path spellings' };
const execute = promisify(execFile);
const cliPath = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const mcpPath = fileURLToPath(new URL('../src/mcp.js', import.meta.url));
const srcRoot = fileURLToPath(new URL('../src/', import.meta.url));
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const blocked = (code) => Object.assign(new Error('blocked'), { code });

function deferred() {
  let resolveIt;
  const promise = new Promise((done) => { resolveIt = done; });
  return { promise, resolve: resolveIt };
}

async function until(condition, what, timeoutMs = 15_000) {
  for (const started = Date.now(); !(await condition()); await delay(20)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${what}`);
  }
}

// A seam's first call, paused until the test lets it go; a seam that is never reached fails the test, not the run.
function pauseOnce(stage) {
  const reached = deferred();
  const go = deferred();
  let first = true;
  return {
    seam: async (name) => { if (name === stage && first) { first = false; reached.resolve(); await go.promise; } },
    reached: () => Promise.race([reached.promise, delay(10_000).then(() => { throw new Error(`the read never paused at ${stage}`); })]),
    release: () => go.resolve()
  };
}

// ---------------------------------------------------------------------------
// Spellings (check R3-1): only an alias of the store file's own name -- its 8.3 name, or a symbolic link to it --
// reaches another lock or ledger file. Folder aliases reach the same ones and are regression cases only.
// ---------------------------------------------------------------------------

// The 8.3 name of a file on win32, when the volume keeps one whose final component differs from the file's own.
function shortName(path) {
  if (process.platform !== 'win32') return null;
  try {
    const short = execSync(`cmd /c for %I in ("${path}") do @echo %~sI`, { encoding: 'utf8' }).trim();
    return short && basename(short).toLowerCase() !== basename(path).toLowerCase() ? short : null;
  } catch { return null; }
}

// A symbolic link to a file, or null where this process may not make one.
async function fileLink(target, path) {
  try { await symlink(target, path, 'file'); return path; }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) return null; throw error; }
}

// The aliases of a file's own name that a named mutant may be credited to, each skipped with a diagnostic where the
// volume or the process cannot give one.
async function fileAliases(t, label, file, { link: linked = true } = {}) {
  const found = [];
  if (process.platform === 'win32') {
    const short = shortName(file);
    if (short) found.push(['8.3 file name', short]);
    else t.diagnostic(`${label}: 8.3 file-name variant skipped: the volume keeps no 8.3 names`);
  }
  if (linked) {
    const path = await fileLink(file, join(dirname(file), `link-${basename(file)}`));
    if (path) found.push(['symbolic link to the file', path]);
    else t.diagnostic(`${label}: symbolic-link variant skipped: this process may not make symbolic links`);
  }
  return found;
}

// A junction (win32) or symbolic link (POSIX) to a store's folder, and the store's name through it.
async function folderAlias(t, file) {
  const folder = `${dirname(file)}-alias`;
  await symlink(dirname(file), folder, process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rm(folder, { force: true }));
  return join(folder, basename(file));
}

// ---------------------------------------------------------------------------
// Stores, payloads and records.
// ---------------------------------------------------------------------------

const storeName = (backend) => (backend === 'sqlite' ? 'livestore.db' : 'livestore.json');

// Saved as a copy: a payload that purged models a purge by a build before PR-37d, whose marker alone reaches the
// store, which is what these tests lift (PR-37d design §2.2, §9.3).
async function storeOf(t, backend, payload, prefix = 'restore-wrapper-') {
  const dir = await scratchDirectory(t, prefix);
  const file = join(dir, storeName(backend));
  const store = await createStorage({ type: backend, file });
  try { await store.save(structuredClone(payload)); } finally { store.close?.(); }
  return { dir, file, backend };
}

// The payload as the store holds it, with no view. SQLite is opened immutable, so no log or lock file appears beside
// it and a later delivery read is not made busy by this one.
async function stored({ file, backend }) {
  if (backend === 'json') return JSON.parse(await readFile(file, 'utf8'));
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
  try { return exportSqlitePayload(database); } finally { database.close(); }
}

// What a store and its ledger hold: the JSON file's bytes or the SQLite payload, and the ledger's bytes.
async function hashes(state) {
  const ledger = knowledge.ledgerPath(state.file);
  return [state.backend === 'json' ? sha256(await readFile(state.file)) : sha256(JSON.stringify(await stored(state))), existsSync(ledger) ? sha256(await readFile(ledger)) : null];
}

async function load(state, options = {}) {
  const store = await createStorage({ type: state.backend, file: state.file, ...options });
  try { return await store.load(); } finally { store.close?.(); }
}

function graphOf(payload) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData(payload);
  return graph;
}

const visible = (payload) => {
  const live = privilegedLiveSnapshot(graphOf(payload));
  return new Set([...live.records, ...live.facts].map((item) => item.id));
};

// B, as a restore installs it: in p a decision and a memory, and a legacy decision with no token, each carrying the
// sentinel; in q a decision nothing withholds. The legacy decision's token is stripped from every copy, journal
// entries and retry values included, so the store stays rebuildable.
function backup({ bind } = {}) {
  const graph = createShadowGraph({ now: () => NOW });
  if (bind) privilegedBindProject(graph, { type: 'worktree', path: resolve(bind), project: 'q', reason: 'restore wrapper test', surface: 'cli' });
  const hidden = graph.addDecision({ project: 'p', title: `hidden ${SENTINEL}`, chosen: 'h' });
  const memory = graph.remember({ project: 'p', memoryType: 'note', key: 'k', text: `memory ${SENTINEL}` }).memory;
  const legacy = graph.addDecision({ project: 'p', title: `legacy ${SENTINEL}`, chosen: 'l' });
  const kept = graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const payload = privilegedSnapshot(graph);
  const strip = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (value.id === legacy.id) delete value.erasureToken;
    Object.values(value).forEach(strip);
  };
  strip(payload);
  const token = (id) => payload.records.find((item) => item.id === id).erasureToken;
  return { payload, ids: { hidden: hidden.id, memory: memory.id, legacy: legacy.id, kept: kept.id }, tokens: { hidden: token(hidden.id), memory: token(memory.id) } };
}

const headOf = (payload) => [...(payload.journal ?? [])].filter((entry) => Number.isSafeInteger(entry?.seq)).sort((left, right) => right.seq - left.seq)[0]?.id ?? null;
const identityOf = (payload) => ({ revision: payload.revision ?? 0, head: headOf(payload) });

// The marker a restore lifts from D's journal (§1.1): a logical purge of p with clean move-in evidence.
const LIFTED = Object.freeze({ kind: 'project', purgedProject: 'p', mode: 'logical', at: TOMBSTONE_AT, seq: 4, tokens: null, moveIn: 'none' });

// A restore-pending record (§1.2) that the store, at `identity`, is in `state` of: pre, committed, post, or unknown
// (the expected revision with another head, M26). It merges the lifted marker of p, so in the committed state every
// p entity of B is held.
function record(identity, state, overrides = {}) {
  const at = (revision, head) => ({ revision: Math.max(0, revision), head });
  const shapes = {
    pre: { pre: { ...identity, existed: true }, expected: at(identity.revision + 3, 'jentry_0_expected') },
    committed: { pre: { ...at(identity.revision - 1, 'jentry_0_pre'), existed: true }, expected: identity },
    post: { pre: { ...at(identity.revision - 2, 'jentry_0_pre'), existed: true }, expected: at(identity.revision - 1, 'jentry_0_expected'), post: identity, minted: [] },
    unknown: { pre: { ...at(identity.revision - 1, 'jentry_0_pre'), existed: true }, expected: { revision: identity.revision, head: 'jentry_0_another' } }
  };
  return {
    kind: 'restore', ...shapes[state],
    add: { tombstones: [LIFTED], quarantine: [] },
    inputs: { live: [], descent: false, descentMode: null, overlap: [], postdated: [] },
    ...overrides
  };
}

const writeLedgerFile = (state, ledger) => writeFile(knowledge.ledgerPath(state.file), JSON.stringify(ledger));
const ledgerOf = async (state) => (existsSync(knowledge.ledgerPath(state.file)) ? JSON.parse(await readFile(knowledge.ledgerPath(state.file), 'utf8')) : null);
const withRecord = (state, value) => writeLedgerFile(state, { version: 1, pending: [value] });

// The post-step's result as it lands under a reader (§6.6), by hand: the legacy decision quarantined by a token
// assignment at the next revision, the tokened p material quarantined by token, and the record cleared.
function postStep(raw, b) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData(structuredClone(raw));
  graph.backfillErasureTokens({});
  const payload = { ...privilegedSnapshot(graph), revision: raw.revision + 1 };
  const minted = payload.records.find((item) => item.id === b.ids.legacy).erasureToken;
  assert.equal(typeof minted, 'string');
  return { payload, ledger: { version: 1, tombstones: [LIFTED], quarantine: [b.tokens.hidden, b.tokens.memory, minted].map((token) => ({ token, at: NOW })) } };
}

const writePayload = (file, payload) => writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);

async function mcpCalls(t, state, calls, extraEnv = {}) {
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: state.backend, SHADOWGRAPH_API_TOKEN: '', SHADOWGRAPH_MCP_COMPACT: '0', SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '', ...extraEnv };
  const child = spawn(process.execPath, [mcpPath], { cwd: state.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  t.after(async () => { child.kill(); await exited; });
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const responses = [];
  child.stdout.on('data', (data) => { buffer += data; const lines = buffer.split('\n'); buffer = lines.pop(); responses.push(...lines.filter(Boolean).map((line) => JSON.parse(line))); });
  const rpc = async (id, method, params) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let waited = 0; waited < 15000; waited += 20) {
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

// ---------------------------------------------------------------------------
// The ledger writer (§2).
// ---------------------------------------------------------------------------

for (const [backend, options] of BACKENDS) test(`PR-37c writer ${backend}: a first write through an alias of the store file's own name lands beside its final name, and a load through that name honours it (M29)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, b.payload);
  const ledger = knowledge.ledgerPath(state.file);
  for (const [label, alias] of await fileAliases(t, `writer M29 ${backend}`, state.file)) {
    await rm(ledger, { force: true });
    await knowledge.writeLedger(alias, (value) => { value.tombstones = [{ kind: 'item', mode: 'logical', at: TOMBSTONE_AT, tokens: [b.tokens.hidden], moveIn: 'none' }]; });
    assert.equal(existsSync(ledger), true, `${label}: beside the final name`);
    assert.equal(existsSync(knowledge.ledgerPath(alias)), false, `${label}: nothing beside the spelling given`);
    assert.equal(visible(await load(state)).has(b.ids.hidden), false, label);
  }
});

test('PR-37c writer: an existing ledger is rewritten in place through any spelling of the store (regression cases of the dev:ino lookup)', async (t) => {
  const state = await storeOf(t, 'json', backup().payload);
  const ledger = knowledge.ledgerPath(state.file);
  const spellings = [['folder alias', await folderAlias(t, state.file)]];
  if (process.platform === 'win32') {
    spellings.push(['namespace', `\\\\?\\${resolve(state.file)}`], ['case variant', join(state.dir, basename(state.file).toUpperCase())]);
    const short = shortName(state.file);
    if (short) spellings.push(['8.3 file name', short]);
    else t.diagnostic('writer regression: 8.3 file-name variant skipped: the volume keeps no 8.3 names');
  }
  await writeLedgerFile(state, { version: 1 });
  const tombstones = [];
  for (const [label, spelling] of spellings) {
    const tombstone = { kind: 'item', mode: 'logical', at: TOMBSTONE_AT, tokens: [`token-${tombstones.length}`] };
    tombstones.push(tombstone);
    await knowledge.writeLedger(spelling, (value) => { value.tombstones = [...(value.tombstones ?? []), tombstone]; });
    assert.deepEqual(JSON.parse(await readFile(ledger, 'utf8')).tombstones, tombstones, label);
    assert.deepEqual((await readdir(state.dir)).filter((name) => name.toLowerCase().endsWith('.control.json')), [basename(ledger)], `${label}: one ledger`);
  }
});

test('PR-37c writer: two different ledgers beside one store\'s names refuse the write, and neither changes', async (t) => {
  const state = await storeOf(t, 'json', backup().payload);
  const aliases = await fileAliases(t, 'writer two ledgers', state.file);
  for (const [label, alias] of aliases) {
    await writeLedgerFile(state, { version: 1, laterBuildState: 'final' });
    await writeFile(knowledge.ledgerPath(alias), JSON.stringify({ version: 1, laterBuildState: 'given' }));
    const before = await Promise.all([readFile(knowledge.ledgerPath(state.file)), readFile(knowledge.ledgerPath(alias))]);
    await assert.rejects(knowledge.writeLedger(alias, (value) => { value.tombstones = [LIFTED]; }), { code: 'control_ledger_malformed' }, label);
    assert.deepEqual(await Promise.all([readFile(knowledge.ledgerPath(state.file)), readFile(knowledge.ledgerPath(alias))]), before, label);
    await rm(knowledge.ledgerPath(alias));
  }
});

test('PR-37c writer: a store with another hard link and no ledger, or named as a ledger, is refused before any write', async (t) => {
  const state = await storeOf(t, 'json', backup().payload);
  await link(state.file, join(state.dir, 'other-name.json'));
  await assert.rejects(knowledge.writeLedger(state.file, (value) => { value.tombstones = [LIFTED]; }), { code: 'control_ledger_malformed' });
  assert.deepEqual((await readdir(state.dir)).filter((name) => name.endsWith('.control.json')), []);
  const named = join(state.dir, 'other.control.json');
  await writeFile(named, '{}');
  await assert.rejects(knowledge.writeLedger(named, (value) => { value.tombstones = [LIFTED]; }), { code: 'deletion_file_destination_refused' });
  assert.equal(existsSync(knowledge.ledgerPath(named)), false);
});

test('PR-37c writer: unknown members, the version, every tombstone and tokensStripped survive a write; a change that drops or edits any of them, or writes what the reader refuses, throws before writing (M27, M28, M53)', async (t) => {
  const state = await storeOf(t, 'json', backup().payload);
  const ledger = knowledge.ledgerPath(state.file);
  // A new ledger starts at version 1.
  await knowledge.writeLedger(state.file, (value) => { value.tombstones = [LIFTED]; });
  assert.deepEqual(JSON.parse(await readFile(ledger, 'utf8')), { version: 1, tombstones: [LIFTED] });
  const item = { kind: 'item', tokens: ['a'], at: TOMBSTONE_AT, mode: 'logical', laterField: { b: 2, a: 1 } };
  const original = {
    version: 1, laterBuildState: { nested: [1, { b: 2, a: 1 }] }, tombstones: [item, LIFTED],
    quarantine: [{ token: 'q1', at: NOW, reason: 'carried' }], tokensStripped: { at: BEFORE }, futureRetentionControls: [{ anything: true }]
  };
  await writeLedgerFile(state, original);
  const origin = { kind: 'origin', purgedOrigin: 'o', tokens: ['b'], at: NOW };
  await knowledge.writeLedger(state.file, (value) => { value.tombstones.push(origin); value.quarantine.push({ token: 'q2', at: NOW }); });
  assert.deepEqual(JSON.parse(await readFile(ledger, 'utf8')), { ...original, tombstones: [item, LIFTED, origin], quarantine: [...original.quarantine, { token: 'q2', at: NOW }] });
  // Its postdated indices name positions in the ledger's three tombstones and the record's one new one (LIFTED is
  // already there): four in all.
  const valid = record({ revision: 3, head: 'jentry_3_b' }, 'committed', {
    add: { tombstones: [LIFTED, { ...LIFTED, seq: 5 }], quarantine: [{ token: 'q3', at: NOW }] },
    inputs: { live: ['some-id'], descent: false, descentMode: null, overlap: [{ id: 'other-id', token: null }], postdated: [0, 3] }
  });
  const refused = [
    ['drops tokensStripped', (value) => { delete value.tokensStripped; }],
    ['edits tokensStripped', (value) => { value.tokensStripped.at = NOW; }],
    ['drops a tombstone', (value) => { value.tombstones.splice(1, 1); }],
    ['reorders the tombstones', (value) => { value.tombstones.reverse(); }],
    ['edits a tombstone', (value) => { value.tombstones[0].laterField.a = 3; }],
    ['raises the version', (value) => { value.version = 2; }],
    ['drops an unknown member', (value) => { delete value.laterBuildState; }],
    ['edits an unknown member', (value) => { value.futureRetentionControls.push({ more: true }); }],
    ['writes a lifted tombstone with no project', (value) => { value.tombstones.push({ ...LIFTED, purgedProject: '' }); }],
    ['writes a record of another kind', (value) => { value.pending = [{ kind: 'purge' }]; }],
    ['writes a record with a member this build does not write', (value) => { value.pending = [{ ...valid, later: true }]; }],
    ['writes a record whose postdated index is past the merged tombstones', (value) => { value.pending = [{ ...valid, inputs: { ...valid.inputs, postdated: [4] } }]; }],
    ['writes a record whose postdated indices are not increasing', (value) => { value.pending = [{ ...valid, inputs: { ...valid.inputs, postdated: [3, 0] } }]; }],
    ['writes a record without existed', (value) => { value.pending = [{ ...valid, pre: { revision: 1, head: null } }]; }],
    ['writes two records', (value) => { value.pending = [valid, valid]; }]
  ];
  const bytes = await readFile(ledger);
  for (const [label, change] of refused) {
    await assert.rejects(knowledge.writeLedger(state.file, change), (error) => typeof error.code === 'string', label);
    assert.deepEqual(await readFile(ledger), bytes, label);
  }
  assert.deepEqual((await readdir(state.dir)).filter((name) => name.endsWith('.tmp')), [], 'no temporary file is left');
  // This build's own record is written, its postdated indices bounded by the merged, deduplicated tombstone list.
  await knowledge.writeLedger(state.file, (value) => { value.pending = [valid]; });
  assert.deepEqual(JSON.parse(await readFile(ledger, 'utf8')).pending, [valid]);
});

test('PR-37c writer: the temporary file is opened owner-only and synced before it is renamed over the ledger', async (t) => {
  const state = await storeOf(t, 'json', backup().payload);
  const events = [];
  const { open: originalOpen, rename: originalRename } = fs.promises;
  fs.promises.open = async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    if (String(path).endsWith('.tmp')) {
      events.push(['open', basename(String(path)).startsWith('.livestore.json.control.json.'), flags, mode]);
      const sync = handle.sync.bind(handle);
      handle.sync = async () => { events.push(['sync']); return sync(); };
    }
    return handle;
  };
  fs.promises.rename = async (from, to) => { events.push(['rename', basename(String(to))]); return originalRename(from, to); };
  syncBuiltinESMExports();
  try { await knowledge.writeLedger(state.file, (value) => { value.tombstones = [LIFTED]; }); }
  finally { Object.assign(fs.promises, { open: originalOpen, rename: originalRename }); syncBuiltinESMExports(); }
  assert.deepEqual(events, [['open', true, 'wx', 0o600], ['sync'], ['rename', 'livestore.json.control.json']]);
});

test('PR-37c writer: a rename or unlink a reader blocks is retried, and one that stays blocked fails, leaving the ledger as it was and no temporary file (M65)', async (t) => {
  const state = await storeOf(t, 'json', backup().payload);
  const ledger = knowledge.ledgerPath(state.file);
  const temporaries = async () => (await readdir(state.dir)).filter((name) => name.endsWith('.tmp'));
  // A seam that fails `failures` times with `code`, then does the real step; `calls` counts every attempt.
  const flaky = (code, failures, real) => {
    const calls = { count: 0 };
    return [async (...args) => { calls.count += 1; if (calls.count <= failures) throw blocked(code); return real(...args); }, calls];
  };
  let [step, calls] = flaky('EBUSY', 2, rename);
  await knowledge.writeLedger(state.file, (value) => { value.tombstones = [LIFTED]; }, { rename: step });
  assert.equal(calls.count, 3);
  assert.deepEqual(JSON.parse(await readFile(ledger, 'utf8')).tombstones, [LIFTED]);
  const written = await readFile(ledger);
  [step, calls] = flaky('EPERM', Infinity, rename);
  await assert.rejects(knowledge.writeLedger(state.file, (value) => { value.quarantine = [{ token: 't', at: NOW }]; }, { rename: step }), { code: 'EPERM' });
  assert.equal(calls.count, 5, 'the fifth attempt is the last');
  assert.deepEqual(await readFile(ledger), written);
  assert.deepEqual(await temporaries(), []);
  // Putting prior bytes back retries the same way.
  const prior = Buffer.from('{"version":1,"laterBuildState":1}\n');
  [step, calls] = flaky('EPERM', Infinity, rename);
  await assert.rejects(knowledge.restoreLedgerBytes(ledger, written.toString('utf8'), prior, 0o600, { rename: step }), { code: 'EPERM' });
  assert.equal(calls.count, 5);
  assert.deepEqual(await readFile(ledger), written);
  assert.deepEqual(await temporaries(), []);
  [step, calls] = flaky('EBUSY', 2, rename);
  assert.equal(await knowledge.restoreLedgerBytes(ledger, written.toString('utf8'), prior, 0o600, { rename: step }), true);
  assert.equal(calls.count, 3);
  assert.deepEqual(await readFile(ledger), prior);
  // So does the record-only unlink.
  const recordOnly = `${JSON.stringify({ version: 1, pending: [record({ revision: 1, head: null }, 'pre')] }, null, 2)}\n`;
  await writeFile(ledger, recordOnly);
  [step, calls] = flaky('EPERM', Infinity, unlink);
  await assert.rejects(knowledge.unlinkLedgerIfRecordOnly(ledger, recordOnly, { unlink: step }), { code: 'EPERM' });
  assert.equal(calls.count, 5);
  assert.equal(await readFile(ledger, 'utf8'), recordOnly);
  [step, calls] = flaky('EBUSY', 2, unlink);
  assert.equal(await knowledge.unlinkLedgerIfRecordOnly(ledger, recordOnly, { unlink: step }), true);
  assert.equal(calls.count, 3);
  assert.equal(existsSync(ledger), false);
});

test('PR-37c writer: prior bytes go back, with their mode, only over the text the pre-step wrote; the record-only ledger is the one ever unlinked', async (t) => {
  const state = await storeOf(t, 'json', backup().payload);
  const ledger = knowledge.ledgerPath(state.file);
  const prior = Buffer.from(JSON.stringify({ version: 1, tombstones: [LIFTED], laterBuildState: 'kept' }));
  await writeFile(ledger, prior, { mode: 0o640 });
  const priorMode = (await stat(ledger)).mode & 0o777;
  const { text } = await knowledge.writeLedger(state.file, (value) => { value.pending = [record({ revision: 1, head: null }, 'pre')]; });
  assert.equal(await readFile(ledger, 'utf8'), text);
  assert.equal(await knowledge.restoreLedgerBytes(ledger, 'other text', prior, priorMode), false);
  assert.equal(await readFile(ledger, 'utf8'), text, 'other bytes are never replaced');
  assert.equal(await knowledge.restoreLedgerBytes(ledger, text, prior, priorMode), true);
  assert.deepEqual(await readFile(ledger), prior);
  assert.equal((await stat(ledger)).mode & 0o777, priorMode);
  // Only a ledger holding nothing but its version and the record, byte-equal, is unlinked.
  assert.equal(await knowledge.unlinkLedgerIfRecordOnly(ledger, prior.toString('utf8')), false, 'it holds a tombstone');
  assert.equal(existsSync(ledger), true);
  await rm(ledger);
  const created = await knowledge.writeLedger(state.file, (value) => { value.pending = [record({ revision: 1, head: null }, 'pre')]; });
  assert.equal(await knowledge.unlinkLedgerIfRecordOnly(ledger, `${created.text} `), false, 'other bytes');
  assert.equal(await knowledge.unlinkLedgerIfRecordOnly(ledger, created.text), true);
  assert.equal(existsSync(ledger), false);
});

// ---------------------------------------------------------------------------
// One store fence, however the store is spelled (§3.1; check R3-1, R3-4).
// ---------------------------------------------------------------------------

// Runs `operation` under `fence` from the test's own async context, and resolves once it holds.
async function holding(fence) {
  const entered = deferred();
  const done = deferred();
  const run = fence.run(async () => { entered.resolve(); await done.promise; });
  await Promise.race([entered.promise, run]);
  return async () => { done.resolve(); await run; };
}

test('PR-37c fence: a fence through an alias of the store file\'s own name and one through its own name exclude each other, and nested either way throw at once (M62 fence clause)', async (t) => {
  const dir = await scratchDirectory(t, 'restore-wrapper-fence-');
  const file = join(dir, 'livestore.json');
  await writeFile(file, '{}');
  const aliases = await fileAliases(t, 'fence M62', file);
  if (!aliases.length) t.diagnostic('fence M62: no alias of the file name on this volume and process');
  for (const [label, alias] of aliases) {
    for (const [holder, waiter] of [[file, alias], [alias, file]]) {
      const release = await holding(fences.createDestinationFence(holder));
      try { await assert.rejects(fences.createDestinationFence(waiter, { lockTimeoutMs: 100, lockPollIntervalMs: 10 }).run(async () => {}), { code: 'storage_lock_timeout' }, label); }
      finally { await release(); }
      await fences.createDestinationFence(holder).run(async () => {
        await assert.rejects(fences.createDestinationFence(waiter, { lockTimeoutMs: 5000 }).run(async () => {}), { code: 'storage_lock_reentrant' }, label);
      });
    }
  }
});

test('PR-37c fence: the lock path is derived at every run, never cached from the first (M68)', async (t) => {
  const dir = await scratchDirectory(t, 'restore-wrapper-fence-cache-');
  const file = join(dir, 'livestore.json');
  // A spelling that names nothing on its first run and the store on its second: a dangling link, or the 8.3 name of
  // a store deleted and made again under the same short name.
  let spelling = await fileLink(file, join(dir, 'link-livestore.json'));
  let made = async () => writeFile(file, '{}');
  if (!spelling) {
    t.diagnostic('fence M68: symbolic-link variant skipped: this process may not make symbolic links');
    await writeFile(file, '{}');
    spelling = shortName(file);
    if (!spelling) { t.diagnostic('fence M68: 8.3 file-name variant skipped: the volume keeps no 8.3 names'); return; }
    await rm(file);
    made = async () => {
      await writeFile(file, '{}');
      if (shortName(file) !== spelling) return false;
      return true;
    };
  }
  const fence = fences.createDestinationFence(spelling, { lockTimeoutMs: 100, lockPollIntervalMs: 10 });
  await fence.run(async () => {});
  if ((await made()) === false) { t.diagnostic('fence M68: 8.3 file-name variant skipped: the store came back under another short name'); return; }
  const release = await holding(fences.createDestinationFence(file));
  try { await assert.rejects(fence.run(async () => {}), { code: 'storage_lock_timeout' }); }
  finally { await release(); }
});

test('PR-37c fence: for a store not there yet, a case variant nested inside its own name throws at once (M69)', WINDOWS, async (t) => {
  const dir = await scratchDirectory(t, 'restore-wrapper-fence-case-');
  const file = join(dir, 'absent-store.json');
  const variant = join(dir, 'ABSENT-STORE.JSON');
  await fences.createDestinationFence(file).run(async () => {
    const started = Date.now();
    await assert.rejects(fences.createDestinationFence(variant, { lockTimeoutMs: 1000 }).run(async () => {}), { code: 'storage_lock_reentrant' });
    assert.ok(Date.now() - started < 1000, 'at once, not after the timeout');
  });
});

test('PR-37c fence: the restore lock is one file beside the store\'s canonical path, however the store is spelled', async (t) => {
  const dir = await scratchDirectory(t, 'restore-wrapper-restore-lock-');
  const file = join(dir, 'livestore.json');
  await writeFile(file, '{}');
  const canonical = await knowledge.canonicalPath(file);
  const seen = [];
  await fences.restoreLock(file).run(async () => { seen.push((await readdir(dir)).filter((name) => name.endsWith('.lock'))); });
  assert.deepEqual(seen, [[`${basename(canonical)}.restore.lock`]]);
  assert.equal(await fences.fenceLockPath(file), `${canonical}.lock`);
  for (const [label, alias] of [...await fileAliases(t, 'restore lock', file), ['folder alias', await folderAlias(t, file)]]) {
    const release = await holding(fences.restoreLock(file));
    try { await assert.rejects(fences.restoreLock(alias, { lockTimeoutMs: 100, lockPollIntervalMs: 10 }).run(async () => {}), { code: 'storage_lock_timeout' }, label); }
    finally { await release(); }
    // The restore lock and the store fence are two locks: one never waits on the other.
    await fences.restoreLock(alias).run(() => fences.createDestinationFence(file).run(async () => {}));
  }
});

test('PR-37c delivery: a SQLite delivery read through an alias of the store file\'s own name is busy while the store\'s fence is held (M62 delivery clause)', SQLITE, async (t) => {
  const state = await storeOf(t, 'sqlite', backup().payload);
  const aliases = await fileAliases(t, 'delivery M62', state.file);
  for (const [label, alias] of aliases) {
    assert.ok((await readStoreForDelivery({ file: alias, storage: 'sqlite' })).payload, `${label}: served while nothing holds the store`);
    const release = await holding(fences.createDestinationFence(state.file));
    try { assert.deepEqual(await readStoreForDelivery({ file: alias, storage: 'sqlite' }), { unavailable: 'busy' }, label); }
    finally { await release(); }
  }
});

// ---------------------------------------------------------------------------
// A purge through another spelling is never undone by a restore (re-review NF-1; check R3-1; M62).
// ---------------------------------------------------------------------------

// X: opens the store through the spelling it is given, purges p and saves, pausing inside the save just after its
// in-fence ledger lookup, so it has passed its record check and holds its store fence. It writes `checked` there,
// then waits for `go`.
const PURGER = `
import fs, { existsSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const [src, backend, spelling, checked, go] = process.argv.slice(2);
const from = (path) => import(pathToFileURL(join(src, path)).href);
const { createShadowGraph } = await from('shadowgraph.js');
const { privilegedSnapshot } = await from(join('internal', 'snapshot.js'));
const store = backend === 'sqlite' ? await (await from('sqlite-storage.js')).createSqliteStore(spelling) : (await from('storage.js')).createJsonFileStore(spelling);
const graph = createShadowGraph();
graph.importData(await store.load());
graph.purgeProject('p', { mode: 'logical' });
const original = fs.promises.stat;
let paused = false;
fs.promises.stat = async (path, ...rest) => {
  const outcome = await original(path, ...rest).then((value) => ({ value }), (error) => ({ error }));
  if (!paused && String(path).endsWith('.control.json')) {
    paused = true;
    writeFileSync(checked, 'checked');
    while (!existsSync(go)) await new Promise((done) => setTimeout(done, 20));
  }
  if (outcome.error) throw outcome.error;
  return outcome.value;
};
syncBuiltinESMExports();
await store.save(privilegedSnapshot(graph));
store.close?.();
`;

// The spellings X goes through: [kind, credited]. Aliases of the file's own name are credited; folder aliases and
// the namespace reach the same lock file and are regression cases. JSON's symbolic-link save is review finding 3's
// own test.
const PURGE_SPELLINGS = {
  json: [['8.3 file name', true], ['namespace', false], ['folder alias', false]],
  sqlite: [['8.3 file name', true], ['symbolic link to the file', true], ['folder alias', false]]
};

async function spellingFor(t, kind, file) {
  if (kind === '8.3 file name') {
    if (process.platform !== 'win32') return null;
    const short = shortName(file);
    if (!short) t.diagnostic(`purge M62: 8.3 file-name variant skipped: the volume keeps no 8.3 names`);
    return short;
  }
  if (kind === 'symbolic link to the file') {
    const path = await fileLink(file, join(dirname(file), `link-${basename(file)}`));
    if (!path) t.diagnostic('purge M62: symbolic-link variant skipped: this process may not make symbolic links');
    return path;
  }
  if (kind === 'namespace') return process.platform === 'win32' ? `\\\\?\\${resolve(file)}` : null;
  return folderAlias(t, file);
}

for (const [backend, options] of BACKENDS) test(`PR-37c NF-1 ${backend}: a purge through another spelling of the store survives a restore of a pre-purge backup, or the restore refuses and writes nothing (M62)`, options, async (t) => {
  let credited = 0;
  for (const [kind, killing] of PURGE_SPELLINGS[backend]) {
    const b = backup();
    const state = await storeOf(t, backend, b.payload);
    // B: the pre-purge backup, at a revision above the store's, so a commit inside the restore would be absorbed.
    const source = await storeOf(t, backend, b.payload);
    const advance = await createStorage({ type: backend, file: source.file });
    try { for (let step = 0; step < 2; step += 1) await advance.save(await advance.load()); } finally { advance.close?.(); }
    assert.ok((await stored(source)).revision > (await stored(state)).revision);
    const spelling = await spellingFor(t, kind, state.file);
    if (!spelling) continue;
    if (killing) credited += 1;
    let release = async () => {};
    const restoreFs = { [backend === 'json' ? 'readFile' : 'unlink']: async (...args) => { await release(); return (backend === 'json' ? readFile : unlink)(...args); } };
    // The ./storage object is made first: making it takes the store's fence, which X will hold.
    const restoring = backend === 'sqlite' ? await createStorage({ type: 'sqlite', file: state.file, restoreFs, lockTimeoutMs: 1000 }) : null;
    const script = join(state.dir, 'purger.mjs');
    await writeFile(script, PURGER);
    const checked = join(state.dir, 'checked');
    const go = join(state.dir, 'go');
    // X's purge writes its registry entry into a home of this test's own (PR-37d design §9.3).
    const child = spawn(process.execPath, [script, srcRoot, backend, spelling, checked, go], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SHADOWGRAPH_HOME: join(state.dir, 'home') } });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const exited = once(child, 'exit');
    t.after(async () => { child.kill(); await exited; });
    await until(() => existsSync(checked) || child.exitCode !== null, 'X to pass its record check');
    assert.ok(existsSync(checked), `${kind}: ${stderr}`);
    // X is released from the primitive's own read of D (JSON) or its sidecar removal (SQLite), or once the restore
    // settles, and the restore goes on only after X has exited.
    let released = null;
    release = () => (released ??= writeFile(go, 'go').then(() => exited));
    let outcome;
    try { outcome = backend === 'json' ? await restoreFile(source.file, state.file, { restoreFs, lockTimeoutMs: 1000 }) : await restoring.restore(source.file); }
    catch (error) { outcome = error; }
    finally { restoring?.close(); }
    const [code] = await release();
    assert.equal(code, 0, `${kind}: ${stderr}`);
    const label = `${kind}: ${outcome instanceof Error ? outcome.code : 'restored'}`;
    // A JSON save renames over the store's final name, however it was spelled (review finding 3), so X's purge lands
    // in D's own file. The purge holds through every name: P's material is in no read, and X's spelling reads the
    // marker.
    for (const name of [state.file, spelling].filter((path) => existsSync(path))) {
      assert.equal(JSON.stringify(graphOf(await load({ ...state, file: name })).exportData({ project: 'p' })).includes(SENTINEL), false, `${label}: the purge was undone through ${name === state.file ? 'D\'s own name' : 'X\'s spelling'}`);
    }
    assert.ok((await load({ ...state, file: spelling })).journal.some((entry) => entry.type === 'project.purged'), `${label}: the purge's marker is gone`);
  }
  if (!credited) t.diagnostic(`purge M62 ${backend}: no credited spelling ran here; the fence unit test kills M62 on this platform`);
});

// ---------------------------------------------------------------------------
// The binding, read side (§8.1, §8.2).
// ---------------------------------------------------------------------------

for (const [backend, options] of BACKENDS) test(`PR-37c binding ${backend}: a load serves each state of a record; an unknown state, a record this build does not write and two records refuse it, an update refuses every record, and a save completes a committed one and then conflicts (M26)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, b.payload);
  const raw = await stored(state);
  const identity = identityOf(raw);
  const withheld = [b.ids.hidden, b.ids.memory, b.ids.legacy];
  // pre and post: the store's own view, the record named.
  for (const name of ['pre', 'post']) {
    await withRecord(state, record(identity, name));
    const loaded = await load(state);
    assert.equal(loaded[knowledge.DELETION_VIEW]?.pending, true, name);
    const live = visible(loaded);
    assert.deepEqual(withheld.filter((id) => !live.has(id)), [], name);
  }
  // committed: what the post-step will remove or quarantine is held, by its token, or by its id when it has none.
  await withRecord(state, record(identity, 'committed'));
  const loaded = await load(state);
  assert.equal(loaded[knowledge.DELETION_VIEW]?.pending, true);
  assert.equal(loaded[knowledge.DELETION_VIEW]?.knowledge, true);
  const live = visible(loaded);
  assert.deepEqual(withheld.filter((id) => live.has(id)), []);
  assert.equal(live.has(b.ids.kept), true);
  assert.equal(JSON.stringify(graphOf(loaded).exportData({})).includes(SENTINEL), false);
  // An update (the capture hook's write) refuses every record before anything is written (§8.3).
  const store = await createStorage({ type: backend, file: state.file });
  t.after(() => store.close?.());
  const before = await hashes(state);
  await assert.rejects(store.update(() => structuredClone(raw)), { code: PENDING });
  assert.deepEqual(await hashes(state), before);
  // A save completes the record from its persisted inputs, then conflicts once: the post-step moved the revision.
  await assert.rejects(store.save(structuredClone(raw)), { name: 'RevisionConflictError' });
  assert.equal((await ledgerOf(state)).pending, undefined);
  const completed = await stored(state);
  assert.equal(completed.revision, raw.revision + 1);
  assert.equal(typeof completed.records.find((item) => item.id === b.ids.legacy).erasureToken, 'string', 'the legacy decision was quarantined by a token assignment');
  const seen = visible(await load(state));
  assert.deepEqual(withheld.filter((id) => seen.has(id)), []);
  // Unknown: the expected revision with another head (M26); a member this build does not write; two records. None is
  // this build's to complete, so a save refuses it too.
  const now = identityOf(completed);
  const refusing = [
    [record(now, 'unknown')],
    [{ ...record(now, 'committed'), later: true }],
    [record(now, 'committed'), record(now, 'pre')]
  ];
  for (const pending of refusing) {
    await writeLedgerFile(state, { version: 1, pending });
    await assert.rejects(load(state), (error) => error.code === PENDING && !error.message.includes(state.dir), JSON.stringify(pending).slice(0, 80));
    await assert.rejects(store.save(structuredClone(raw)), { code: PENDING });
  }
  // A restore over the unknown state refuses with the restore's one code (§5.1) and writes nothing.
  await withRecord(state, record(now, 'unknown'));
  const source = await storeOf(t, backend, backup().payload);
  const unchanged = await hashes(state);
  const restoring = backend === 'json' ? restoreFile(source.file, state.file) : store.restore(source.file);
  await assert.rejects(restoring, { code: 'purge_aware_restore_unsupported_at_this_build' });
  assert.deepEqual(await hashes(state), unchanged);
});

test('PR-37c binding: an absent JSON store binds pre only when the record says it was absent at the pre-step (M47)', async (t) => {
  const b = backup();
  const state = await storeOf(t, 'json', b.payload);
  const identity = identityOf(await stored(state));
  await withRecord(state, record(identity, 'committed'));
  await rm(state.file);
  await assert.rejects(load(state), { code: PENDING }, 'a store that existed and has vanished is unknown');
  await withRecord(state, record(identity, 'committed', { pre: { revision: 0, head: null, existed: false } }));
  const loaded = await load(state);
  assert.equal(loaded[knowledge.DELETION_VIEW]?.pending, true);
  assert.deepEqual(loaded.records, []);
  assert.equal(existsSync(state.file), false, 'a load writes nothing');
});

test('PR-37c rev6:425 NF-5: SQLite store objects already open never recreate an absent store while a record waits, and neither does a new one (M64)', SQLITE, async (t) => {
  const b = backup();
  const state = await storeOf(t, 'sqlite', b.payload);
  const identity = identityOf(await stored(state));
  const shared = await createStorage({ type: 'sqlite', file: state.file });
  const raw = await createSqliteStore(state.file);
  t.after(() => { shared.close(); raw.close(); });
  await withRecord(state, record(identity, 'committed'));
  const ledger = await readFile(knowledge.ledgerPath(state.file));
  for (const path of [state.file, `${state.file}-wal`, `${state.file}-shm`, `${state.file}-journal`]) await rm(path, { force: true });
  for (const [label, store] of [['./storage', shared], ['raw', raw]]) {
    const attempts = [['load', () => store.load()], ['save', () => store.save(structuredClone(b.payload))], ['update', () => store.update((current) => current)], ['backup', () => store.backup(join(state.dir, 'copy.db'))]];
    for (const [name, attempt] of attempts) {
      await assert.rejects(attempt(), { code: PENDING }, `${label} ${name}`);
      assert.equal(existsSync(state.file), false, `${label} ${name}: no store was made`);
    }
  }
  await assert.rejects(createStorage({ type: 'sqlite', file: state.file }), { code: PENDING });
  await assert.rejects(createSqliteStore(state.file), { code: PENDING });
  assert.equal(existsSync(state.file), false);
  assert.deepEqual(await readFile(knowledge.ledgerPath(state.file)), ledger, 'the record is kept');
});

// ---------------------------------------------------------------------------
// Unfenced readers bracket their ledger read by the payload's identity (§8.1; review finding 1; M45).
// ---------------------------------------------------------------------------

for (const surface of ['load', 'delivery']) test(`PR-37c unfenced ${surface}: paused after reading B, it retries when the post-step lands, and holds what the post-step quarantined (M45)`, async (t) => {
  const b = backup();
  const state = await storeOf(t, 'json', b.payload);
  const raw = await stored(state);
  await withRecord(state, record(identityOf(raw), 'committed'));
  const after = postStep(raw, b);
  const pause = pauseOnce('afterPayloadRead');
  const reading = surface === 'load'
    ? createJsonFileStore(state.file, { loadFault: pause.seam }).load()
    : readStoreForDelivery({ file: state.file, storage: 'json', afterPayloadRead: () => pause.seam('afterPayloadRead') }).then((read) => read.payload ?? assert.fail(JSON.stringify(read)));
  await pause.reached();
  await writePayload(state.file, after.payload);
  await writeLedgerFile(state, after.ledger);
  pause.release();
  const payload = await reading;
  assert.equal(payload.revision, after.payload.revision);
  const live = visible(payload);
  assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.legacy].filter((id) => live.has(id)), []);
});

test('PR-37c unfenced load: an ABA ledger -- a removal-only restore leaves its bytes as they were -- still makes a paused load retry (M45)', async (t) => {
  const b = backup();
  const state = await storeOf(t, 'json', b.payload);
  const raw = await stored(state);
  const before = JSON.stringify({ version: 1, tombstones: [{ kind: 'item', mode: 'logical', at: TOMBSTONE_AT, tokens: ['unrelated-token'], moveIn: 'none' }] });
  await writeFile(knowledge.ledgerPath(state.file), before);
  // Proven descent removes B's candidates not live in D: the legacy decision, held by its id until the post-step.
  const pending = record(identityOf(raw), 'committed', { add: { tombstones: [], quarantine: [] }, inputs: { live: [], descent: true, descentMode: 'logical', overlap: [], postdated: [] } });
  await writeLedgerFile(state, { ...JSON.parse(before), pending: [pending] });
  assert.equal(visible(await load(state)).has(b.ids.legacy), false, 'the committed state holds it');
  const removed = graphOf(structuredClone(raw));
  removed.purgeProject('p', { mode: 'logical' });
  const pause = pauseOnce('afterPayloadRead');
  const reading = createJsonFileStore(state.file, { loadFault: pause.seam }).load();
  await pause.reached();
  await writePayload(state.file, { ...privilegedSnapshot(removed), revision: raw.revision + 1 });
  await writeFile(knowledge.ledgerPath(state.file), before);
  pause.release();
  const payload = await reading;
  assert.equal(payload.revision, raw.revision + 1);
  assert.equal(JSON.stringify(graphOf(payload).exportData({})).includes(SENTINEL), false);
});

test('PR-37c unfenced load: paused after reading B while the primitive rolls back and the record is discarded, it retries and serves D (M45)', async (t) => {
  const own = createShadowGraph({ now: () => NOW });
  own.addDecision({ project: 'q', title: 'own decision', chosen: 'own' });
  const state = await storeOf(t, 'json', privilegedSnapshot(own));
  const d = await readFile(state.file);
  const dPayload = JSON.parse(d.toString('utf8'));
  const b = backup();
  const installed = { ...b.payload, revision: dPayload.revision + 1 };
  await writePayload(state.file, installed);
  await withRecord(state, record(identityOf(installed), 'committed', { pre: { ...identityOf(dPayload), existed: true } }));
  const pause = pauseOnce('afterPayloadRead');
  const reading = createJsonFileStore(state.file, { loadFault: pause.seam }).load();
  await pause.reached();
  await writeFile(state.file, d);
  await rm(knowledge.ledgerPath(state.file));
  pause.release();
  const payload = await reading;
  assert.deepEqual(payload.records.map((item) => item.id), dPayload.records.map((item) => item.id));
  assert.equal(JSON.stringify(payload).includes(SENTINEL), false);
});

test('PR-37c unfenced readers: a payload that changes on every attempt ends in storage_lock_timeout for a load and busy for delivery (M45)', async (t) => {
  const state = await storeOf(t, 'json', backup().payload);
  let attempts = 0;
  const bump = async () => {
    attempts += 1;
    const payload = await stored(state);
    await writePayload(state.file, { ...payload, revision: payload.revision + 1 });
  };
  await assert.rejects(createJsonFileStore(state.file, { loadFault: (stage) => (stage === 'afterPayloadRead' ? bump() : undefined) }).load(), { code: 'storage_lock_timeout' });
  assert.equal(attempts, 3);
  attempts = 0;
  assert.deepEqual(await readStoreForDelivery({ file: state.file, storage: 'json', afterPayloadRead: bump }), { unavailable: 'busy' });
  assert.equal(attempts, 3);
});

test('PR-37c unfenced SQLite delivery: paused after its payload read while the store commits and the record clears, it is busy, never the old payload with the new ledger (M45)', SQLITE, async (t) => {
  const b = backup();
  const state = await storeOf(t, 'sqlite', b.payload);
  const raw = await stored(state);
  await withRecord(state, record(identityOf(raw), 'committed'));
  const after = postStep(raw, b);
  let paused = false;
  const read = await readStoreForDelivery({
    file: state.file, storage: 'sqlite',
    afterPayloadRead: async () => {
      paused = true;
      const { DatabaseSync } = await import('node:sqlite');
      const database = new DatabaseSync(state.file);
      try { database.prepare("UPDATE shadowgraph_meta SET value = ? WHERE key = 'revision'").run(String(raw.revision + 1)); } finally { database.close(); }
      await writeLedgerFile(state, after.ledger);
    }
  });
  assert.equal(paused, true, 'the read paused after its payload read');
  assert.deepEqual(read, { unavailable: 'busy' });
});

// ---------------------------------------------------------------------------
// rev6:429, read half: a crash-left record is read, never resolved (§8.5; M23, M24).
// ---------------------------------------------------------------------------

// A store bound for capture, an activation record naming it for delivery and capture, and a working directory bound
// to q (as capture-redaction's setup does).
async function activated(t, backend) {
  const dir = await scratchDirectory(t, 'restore-wrapper-hooks-');
  const cwd = join(dir, 'work');
  const home = join(dir, 'home');
  const sgHome = join(dir, 'sg-home');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  await mkdir(home);
  await mkdir(sgHome);
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'q', confirmed: true }));
  const b = backup({ bind: cwd });
  const file = join(dir, storeName(backend));
  const store = await createStorage({ type: backend, file });
  try { await store.save(b.payload); } finally { store.close?.(); }
  const capture = { state: 'active', changedAt: '2026-01-01T00:00:00.000Z', evidence: 'synthetic', store: { file, storage: backend }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'] };
  const activation = join(sgHome, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { delivery: { state: 'active', store: { file, storage: backend } }, capture } }));
  const capturing = (prompt) => runCapture({ capture, input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', prompt, message_id: prompt, session_id: 'session-1', cwd: '/work', transcript_path: join(dir, 'none.jsonl') }), deadline: Date.now() + 10_000, record: activation, home, cwd });
  const delivering = async () => {
    let text = '';
    await runDeliver({ args: ['--hook'], readInput: () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'session-1' }), env: { SHADOWGRAPH_HOME: sgHome }, write: (out) => { text += out; } });
    const lines = JSON.parse(text).hookSpecificOutput.additionalContext.split('\n');
    const line = (prefix) => JSON.parse(lines.find((entry) => entry.startsWith(prefix)).slice(prefix.length));
    return { text, head: line('head: '), processing: line('processing: ') };
  };
  return { dir, file, backend, b, capturing, delivering };
}

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:429 read half ${backend}: with a crash-left record in each state, loads, delivery, CLI, MCP and HTTP reads and a capture write nothing, and delivery serves memory saying capture cannot write (M23, M24)`, options, async (t) => {
  const s = await activated(t, backend);
  const identity = identityOf(await stored(s));
  const env = { ...process.env, SHADOWGRAPH_FILE: s.file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_API_TOKEN: '' };
  for (const name of ['pre', 'committed', 'post']) {
    await withRecord(s, record(identity, name));
    const before = await hashes(s);
    const texts = [JSON.stringify(graphOf(await load(s)).exportData({ project: 'p' }))];
    const delivered = await s.delivering();
    texts.push(delivered.text);
    assert.equal(delivered.head.store, 'available', `${name}: memory is served`);
    // Capture is active only for a JSON store (the private automated store); the hook's own write is refused on
    // either backend below.
    assert.deepEqual([delivered.processing.capture, delivered.processing.reason], backend === 'json' ? ['unavailable', 'deletion_pending'] : ['not_active', undefined], name);
    for (const args of [['list', JSON.stringify({ project: 'p' })], ['search', JSON.stringify({ project: 'p', query: 'hidden' })]]) texts.push((await execute(process.execPath, [cliPath, ...args], { cwd: s.dir, env })).stdout);
    texts.push(...await mcpCalls(t, s, [['shadowgraph_search', { query: 'hidden decision', project: 'p' }], ['shadowgraph_journal', { project: 'p' }]]));
    const app = await createShadowGraphServer({ file: s.file, storage: backend, cwd: s.dir, apiToken: '' });
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    try { for (const path of ['/records?project=p', '/search?project=p&q=hidden']) texts.push(await (await fetch(`http://127.0.0.1:${app.server.address().port}${path}`)).text()); }
    finally { await new Promise((done) => app.server.close(done)); }
    await assert.rejects(s.capturing(`prompt ${name}`), { code: PENDING }, `${name}: the hook refuses`);
    assert.deepEqual(await hashes(s), before, `${name}: nothing wrote the store or its ledger`);
    if (name === 'committed') for (const text of texts) assert.equal(text.includes(SENTINEL), false, `${name}: ${text.slice(0, 160)}`);
  }
  // The same capture with no record writes: the refusals above were the record's.
  await rm(knowledge.ledgerPath(s.file));
  assert.equal(await s.capturing('prompt after'), 'written');
});

// ---------------------------------------------------------------------------
// The capture-session time (§1.3, R9; M32).
// ---------------------------------------------------------------------------

test('PR-37c R9: after a tombstone of p, a session opened after it captures twice; one opened before it, or with no start, is withheld (M32)', async (t) => {
  const graph = createShadowGraph({ now: () => BEFORE });
  graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const originId = mintOriginId();
  const payload = privilegedSnapshot(graph);
  payload.captureSessions = [
    { id: 'capsession_old', originId, sessionId: 'session-old', project: 'p', attribution: 'project', startedAt: BEFORE },
    { id: 'capsession_none', originId, sessionId: 'session-none', project: 'p', attribution: 'project' }
  ];
  const state = await storeOf(t, 'json', payload);
  await writeLedgerFile(state, { version: 1, tombstones: [LIFTED] });
  const capture = async (sessionId) => {
    const viewed = createShadowGraph({ now: () => AFTER });
    viewed.importData(await load(state));
    const result = privilegedRecordCapture(viewed, { project: 'p', originId, text: `text ${sessionId}`, admission: ADMISSION, source: { event: 'UserPromptSubmit', sessionId, role: 'user' } });
    if (!result.refused) {
      const store = createJsonFileStore(state.file);
      await store.save(privilegedSnapshot(viewed));
    }
    return result;
  };
  const first = await capture('session-new');
  assert.equal(first.refused, undefined, JSON.stringify(first.refused));
  const second = await capture('session-new');
  assert.equal(second.refused, undefined, 'a session opened after the tombstone captures again');
  assert.equal(second.occurrenceSeq, 2);
  assert.equal((await stored(state)).captureSessions.find((session) => session.sessionId === 'session-new').startedAt, AFTER);
  for (const sessionId of ['session-old', 'session-none']) assert.deepEqual((await capture(sessionId)).refused, { reason: 'session_withheld' }, sessionId);
});

// ---------------------------------------------------------------------------
// The restore (§4-§7). D is a store of its own lineage unless a test says otherwise: nothing of B is live in it.
// ---------------------------------------------------------------------------

// D with project p (and q) written, then p purged in `mode`: its journal holds the marker a restore lifts (§4.4).
function purgedStore(mode = 'logical', project = 'p') {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ project, title: 'd own', chosen: 'o' });
  graph.addDecision({ project: 'q', title: 'd q', chosen: 'q' });
  graph.purgeProject(project, { mode });
  return privilegedSnapshot(graph);
}

// D with nothing purged.
function ownStore() {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ project: 'q', title: 'own', chosen: 'o' });
  return privilegedSnapshot(graph);
}

// A store path nothing is at yet.
async function freshOf(t, backend) {
  const dir = await scratchDirectory(t, 'restore-wrapper-fresh-');
  return { dir, file: join(dir, storeName(backend)), backend };
}

// A restore of `source` into `state` through its backend's entry: restoreFile, or a `./storage` store's restore.
async function restoring(state, source, options = {}, storeOptions = {}) {
  if (state.backend === 'json') return restoreFile(source.file, state.file, { ...storeOptions, ...options });
  const store = await createStorage({ type: 'sqlite', file: state.file, ...storeOptions });
  try { return await store.restore(source.file, options); } finally { store.close(); }
}

async function backupOf(t, backend, payload, sidecar) {
  const state = await storeOf(t, backend, payload, 'restore-wrapper-b-');
  if (sidecar !== undefined) await writeLedgerFile(state, sidecar);
  return state;
}

const tokenOf = (payload, id) => [...payload.records, ...payload.facts].find((item) => item.id === id)?.erasureToken;
const quarantineTokens = (ledger) => new Set((ledger?.quarantine ?? []).map((entry) => entry.token));
const typeCount = (payload, type) => payload.journal.filter((entry) => entry.type === type).length;
const ZERO = Object.freeze({ removed: 0, quarantined: 0, skeletons: 0, spliced: 0 });
const PURGE_AWARE = 'purge_aware_restore_unsupported_at_this_build';
// A hand-written PR-37d-shaped tombstone of another project, naming a token B does not hold, at a seq no marker of B
// has, with a valid instant (re-review NF-6 (a)).
const foreign = (fields = {}) => ({ kind: 'project', purgedProject: 'z', mode: 'hard', at: TOMBSTONE_AT, seq: 99, tokens: ['token-z'], moveIn: 'some', ...fields });
const itemTombstone = (tokens) => ({ kind: 'item', mode: 'logical', at: TOMBSTONE_AT, tokens, moveIn: 'none' });

// Removes a field from every copy of an entity: live, retry values and journal payloads.
function strip(payload, id, ...fields) {
  const walk = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (value.id === id) for (const field of fields) delete value[field];
    Object.values(value).forEach(walk);
  };
  walk(payload);
  return payload;
}

// B with its legacy decision tokened after creation, by the backfill's entity.token_assigned entry.
function backfilled(b) {
  const graph = graphOf(structuredClone(b.payload));
  graph.backfillErasureTokens({});
  return privilegedSnapshot(graph);
}

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:416 ${backend}: under D's lifted marker B's p material is quarantined -- by token, the legacy decision by assignment -- counted, in no read and in no ledger byte; a hard marker's unknown move-in reaches q too (M15, M61)`, options, async (t) => {
  const b = backup();
  for (const mode of ['logical', 'hard']) {
    const state = await storeOf(t, backend, purgedStore(mode));
    const result = await restoring(state, await storeOf(t, backend, b.payload));
    assert.equal(result.deletionKnowledge, 'present');
    assert.deepEqual(result.reapplied, { ...ZERO, quarantined: 1 }, `${mode}: the legacy decision, by assignment (V-23)`);
    assert.equal(result.completion, undefined);
    const ledger = await ledgerOf(state);
    assert.deepEqual(ledger.tombstones.map((item) => [item.purgedProject, item.mode, item.tokens, item.moveIn]), [['p', mode, null, mode === 'logical' ? 'none' : 'unknown']], mode);
    assert.equal(Object.hasOwn(ledger, 'pending'), false);
    const after = await stored(state);
    const assigned = tokenOf(after, b.ids.legacy);
    assert.equal(typeof assigned, 'string');
    const expected = [b.tokens.hidden, b.tokens.memory, assigned, ...(mode === 'hard' ? [tokenOf(after, b.ids.kept)] : [])];
    assert.deepEqual([...quarantineTokens(ledger)].sort(), expected.sort(), mode);
    assert.equal(typeCount(after, 'project.purged'), typeCount(b.payload, 'project.purged'), 'no purge marker is appended (M15)');
    assert.equal(typeCount(after, 'restore.reapplied'), 1);
    const loaded = await load(state);
    const seen = visible(loaded);
    assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.legacy].filter((id) => seen.has(id)), [], mode);
    assert.equal(seen.has(b.ids.kept), mode === 'logical', `${mode}: a clean logical marker's move-in is none (M61)`);
    assert.equal(JSON.stringify(graphOf(loaded).exportData({ project: 'p' })).includes(SENTINEL), false);
    const text = await readFile(knowledge.ledgerPath(state.file), 'utf8');
    for (const id of Object.values(b.ids)) assert.equal(text.includes(id), false, `${mode}: no entity id in the ledger`);
    assert.equal(text.includes(SENTINEL), false);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:416 ${backend}: a tombstone whose move-in is some, or not recorded, quarantines tokenless material of any project, and only that (M4, M5, R5 L1 VS5 (3))`, options, async (t) => {
  const b = backup();
  for (const moveIn of ['some', undefined]) {
    const state = await storeOf(t, backend, ownStore());
    await writeLedgerFile(state, { version: 1, tombstones: [foreign({ moveIn })] });
    const result = await restoring(state, await storeOf(t, backend, b.payload));
    assert.deepEqual(result.reapplied, { ...ZERO, quarantined: 1 }, String(moveIn));
    assert.deepEqual([...quarantineTokens(await ledgerOf(state))], [tokenOf(await stored(state), b.ids.legacy)], String(moveIn));
    const seen = visible(await load(state));
    assert.equal(seen.has(b.ids.legacy), false, `${moveIn}: rule (c) is global and a missing move-in is unknown`);
    assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.kept].filter((id) => !seen.has(id)), [], String(moveIn));
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:416 token proof ${backend}: an entity tokened after creation is quarantined by its token alone -- no entry, no new revision, counted 0 in the result and 1 on its scope's reads -- while a creation-tokened one stays visible, unless tokensStripped is set (M6, M7, quarantine by token)`, options, async (t) => {
  const b = backup();
  const payload = backfilled(b);
  const legacy = tokenOf(payload, b.ids.legacy);
  for (const stripped of [false, true]) {
    const state = await storeOf(t, backend, ownStore());
    await writeLedgerFile(state, { version: 1, tombstones: [foreign()], ...(stripped ? { tokensStripped: { at: BEFORE } } : {}) });
    const source = await storeOf(t, backend, payload);
    const installed = Math.max((await stored(state)).revision, (await stored(source)).revision) + 1;
    const result = await restoring(state, source);
    assert.equal(result.deletionKnowledge, 'present');
    assert.equal(result.reapplied.quarantined, 0, 'quarantine by token is not counted (V-23)');
    const after = await stored(state);
    assert.equal(after.revision, installed, 'no post-step commit');
    assert.equal(typeCount(after, 'restore.reapplied'), 0);
    const tokens = quarantineTokens(await ledgerOf(state));
    assert.equal(tokens.has(legacy), true);
    assert.equal(tokens.has(b.tokens.hidden), stripped);
    const seen = visible(await load(state));
    assert.equal(seen.has(b.ids.legacy), false, 'tokened after creation: no proof');
    assert.equal(seen.has(b.ids.hidden), !stripped, stripped ? 'the flag disables the proof (M7)' : 'proven by its creation entry (M6)');
    // Counted where it matters: on every read of its scope (§9.3, V-23).
    if (!stripped) assert.equal(graphOf(await load(state)).search('', { project: 'p' }).completeness.quarantined, 1, 'the read count of its scope');
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:417 ${backend}: a repeated restore re-quarantines under the same token, adds no quarantine entry, and its record names no id but overlap and live ones (M11, M52)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  const source = await storeOf(t, backend, b.payload);
  await restoring(state, source);
  const first = await ledgerOf(state);
  const token = tokenOf(await stored(state), b.ids.legacy);
  let record = null;
  const result = await restoring(state, source, {}, { restoreFault: async (stage) => { if (stage === 'beforePostStep') record = await readFile(knowledge.ledgerPath(state.file), 'utf8'); } });
  assert.deepEqual(result.reapplied, { ...ZERO, quarantined: 1 });
  assert.equal(tokenOf(await stored(state), b.ids.legacy), token, 'the overlap token, never a new one (M11)');
  assert.deepEqual((await ledgerOf(state)).quarantine, first.quarantine, 'no entry added');
  const [pending] = JSON.parse(record).pending;
  assert.deepEqual(pending.inputs.overlap, [{ id: b.ids.legacy, token }]);
  assert.equal(pending.inputs.descent, false, 'overlap unproves descent');
  const allowed = new Set([...pending.inputs.live, ...pending.inputs.overlap.map((entry) => entry.id)]);
  for (const id of Object.values(b.ids)) if (record.includes(id)) assert.ok(allowed.has(id), id);
  assert.equal(record.includes(SENTINEL), false);
  assert.equal(visible(await load(state)).has(b.ids.legacy), false, 'never visible');
  // An unrelated restore in between, then B again (R5 L0 VS1 item 5): still never visible.
  await restoring(state, await storeOf(t, backend, ownStore()));
  await restoring(state, source);
  assert.equal(visible(await load(state)).has(b.ids.legacy), false, 'never visible after an unrelated restore');
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:417 rule (b) ${backend}: an entity whose only journal entry names p as the project it was moved from is quarantined under p's lifted marker (M41)`, options, async (t) => {
  // B: a decision written in p and held only in the baseline a journal-less import builds (with no breadcrumbs to
  // carry over), then moved to r, so its one entry -- the attribution -- names p only as previousProject.
  const graph = createShadowGraph({ now: () => NOW });
  const moved = graph.addDecision({ project: 'p', title: `moved ${SENTINEL}`, chosen: 'm' });
  graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const migrated = createShadowGraph({ now: () => NOW });
  migrated.importData({ ...privilegedSnapshot(graph), events: [], journal: [], journalSeq: 0, journalEpoch: null });
  migrated.attribute({ ids: [moved.id], targetProject: 'r', reason: 'Explicit move' });
  const payload = privilegedSnapshot(migrated);
  const naming = payload.journal.filter((entry) => entry.entityId === moved.id || entry.payload?.id === moved.id);
  assert.deepEqual(naming.map((entry) => [entry.type, entry.project, entry.payload?.attributionChange?.previousProject]), [['entity.attributed', 'r', 'p']]);
  const state = await storeOf(t, backend, purgedStore('logical'));
  await restoring(state, await storeOf(t, backend, payload));
  assert.equal(visible(await load(state)).has(moved.id), false);
});

for (const [backend, options] of BACKENDS) test(`PR-37c authority ${backend}: a removal-bearing restore leaves access as the primitive's merge leaves it -- the post-step never purges authority (M14)`, options, async (t) => {
  const b = backup();
  const graph = graphOf(structuredClone(b.payload));
  privilegedIssueAccess(graph, { type: 'grant', scope: { projects: ['p'] }, surfaces: ['cli'], expiresAt: '2099-01-01T00:00:00.000Z', reason: 'synthetic grant' });
  const payload = privilegedSnapshot(graph);
  const state = await storeOf(t, backend, payload);
  await writeLedgerFile(state, { version: 1, tombstones: [itemTombstone([b.tokens.hidden])] });
  const source = await storeOf(t, backend, payload);
  const expected = mergeAuthorityRestore(await stored(source), await stored(state), { now: NOW });
  const result = await restoring(state, source, { now: NOW });
  assert.equal(result.reapplied.removed, 1);
  const after = await stored(state);
  for (const key of ['access', 'accessRevocations']) assert.deepEqual(after[key], expected[key], key);
  const authority = (events) => events.filter((event) => String(event.type).startsWith('access.'));
  assert.deepEqual(authority(after.events), authority(expected.events));
});

// A destination whose folder went with its store, ledger and lock files and was made again at the same path (rev6:418-
// 423; R5 L1 VS0's reinitialised directory; review finding 10): a restore there is a restore into a new path.
async function recreatedOf(t, backend) {
  const state = await storeOf(t, backend, purgedStore('logical'));
  await restoring(state, await storeOf(t, backend, backup().payload));
  assert.ok(existsSync(knowledge.ledgerPath(state.file)), 'the folder held a ledger');
  await rm(state.dir, { recursive: true, force: true });
  await mkdir(state.dir);
  return state;
}

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:418-423 ${backend}: a registry tombstone that reaches B's tokens removes them and quarantines its project's tokenless material, into a new path, another store and a recreated directory, merged without its lineage; one naming only tokens B lacks reaches nothing and writes nothing (M1)`, options, async (t) => {
  const b = backup();
  const dir = await scratchDirectory(t, 'restore-wrapper-registry-');
  const env = { ...process.env, SHADOWGRAPH_HOME: join(dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME);
  const source = await storeOf(t, backend, b.payload);
  const epoch = b.payload.journal.find((entry) => entry.seq === b.payload.journalEpoch).id;
  const tombstone = { kind: 'project', purgedProject: 'p', mode: 'logical', at: TOMBSTONE_AT, seq: 7, tokens: [b.tokens.hidden, b.tokens.memory], moveIn: 'none' };
  for (const [registry, applies] of [[[itemTombstone(['token-absent'])], false], [[{ ...tombstone, lineage: { epochEntryId: epoch, markerEntryId: 'jentry_0_absent' } }], true]]) {
    await writeFile(knowledge.registryFile(env), JSON.stringify({ version: 1, tombstones: registry }));
    const registryBytes = await readFile(knowledge.registryFile(env));
    for (const target of ['new path', 'other store', 'recreated directory']) {
      const state = target === 'new path' ? await freshOf(t, backend) : target === 'other store' ? await storeOf(t, backend, ownStore()) : await recreatedOf(t, backend);
      const result = await restoring(state, source, {}, { env });
      const label = `${applies ? 'applies' : 'token filter'}, ${target}`;
      assert.deepEqual(await readFile(knowledge.registryFile(env)), registryBytes, `${label}: the registry is never written`);
      const after = await stored(state);
      if (!applies) {
        assert.equal(result.deletionKnowledge, 'none', label);
        assert.equal(existsSync(knowledge.ledgerPath(state.file)), false, label);
        assert.equal(typeCount(after, 'restore.reapplied'), 0, label);
        continue;
      }
      assert.equal(result.deletionKnowledge, 'present', label);
      assert.equal(result.reapplied.removed, 2, label);
      assert.equal(result.reapplied.quarantined, 1, label);
      const ledger = await ledgerOf(state);
      assert.deepEqual(ledger.tombstones, [tombstone], `${label}: lineage stripped`);
      assert.deepEqual([b.ids.hidden, b.ids.memory].filter((id) => JSON.stringify(after).includes(id)), [], `${label}: removed`);
      assert.equal(quarantineTokens(ledger).has(tokenOf(after, b.ids.legacy)), true, `${label}: quarantined`);
    }
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:424 ${backend}: a registry tombstone of a same-named project whose lineage B disproves reaches nothing, whether it names tokens B lacks or none (M40, M55)`, options, async (t) => {
  const b = backup();
  const dir = await scratchDirectory(t, 'restore-wrapper-lineage-');
  const env = { ...process.env, SHADOWGRAPH_HOME: join(dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME);
  const scoped = { kind: 'project', purgedProject: 'p', mode: 'logical', at: TOMBSTONE_AT, seq: 7, moveIn: 'none', lineage: { epochEntryId: 'another-lineage', headEntryId: 'another-head' } };
  for (const tokens of [['token-absent'], null]) {
    await writeFile(knowledge.registryFile(env), JSON.stringify({ version: 1, tombstones: [{ ...scoped, tokens }] }));
    const state = await freshOf(t, backend);
    const result = await restoring(state, await storeOf(t, backend, b.payload), {}, { env });
    assert.equal(result.deletionKnowledge, 'none', JSON.stringify(tokens));
    assert.equal(existsSync(knowledge.ledgerPath(state.file)), false);
    const after = await stored(state);
    assert.deepEqual(after.records.map((item) => [item.id, item.erasureToken]), b.payload.records.map((item) => [item.id, item.erasureToken]));
    assert.equal(visible(await load(state)).has(b.ids.legacy), true);
  }
});

test('PR-37c rev6:425 json: a restore whose recovery is unconfirmed keeps its record; a fresh process withholds the purged tokenless entity; the next save completes the restore (M21)', async (t) => {
  const b = backup();
  const state = await storeOf(t, 'json', purgedStore('logical'));
  const source = await storeOf(t, 'json', b.payload);
  const restoreFault = (stage) => { if (stage === 'afterReplacementRename') throw new Error('injected after the rename'); };
  await assert.rejects(restoreFile(source.file, state.file, { restoreFault, restoreFs: { copyFile: async () => { throw blocked('EIO'); } } }), { code: 'json_restore_recovery_unconfirmed' });
  assert.equal((await ledgerOf(state)).pending.length, 1, 'the record is kept');
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: 'json', SHADOWGRAPH_API_TOKEN: '' };
  const listed = (await execute(process.execPath, [cliPath, 'list', JSON.stringify({ project: 'p' })], { cwd: state.dir, env })).stdout;
  assert.equal(listed.includes(b.ids.legacy), false);
  assert.equal(listed.includes(SENTINEL), false);
  await assert.rejects(createJsonFileStore(state.file).save(structuredClone(await stored(state))), { name: 'RevisionConflictError' });
  assert.equal(Object.hasOwn(await ledgerOf(state), 'pending'), false);
  assert.equal(quarantineTokens(await ledgerOf(state)).has(tokenOf(await stored(state), b.ids.legacy)), true);
});

test('PR-37c rev6:425 sqlite: a recovery left unconfirmed with D installed keeps the record for the next save; with D absent, the record is kept, nothing makes D again -- settle, a resolver, a new store or one already open -- and every entry refuses (M21, M46, M64)', SQLITE, async (t) => {
  const b = backup();
  const source = await storeOf(t, 'sqlite', b.payload);
  const installed = await storeOf(t, 'sqlite', purgedStore('logical'));
  const faults = (stage) => { if (['afterReplacementRename', 'beforeRecoveryCopy'].includes(stage)) throw new Error(`injected at ${stage}`); };
  await assert.rejects(restoring(installed, source, {}, { restoreFault: faults }), { code: 'sqlite_restore_recovery_unconfirmed' });
  assert.equal((await ledgerOf(installed)).pending.length, 1);
  assert.equal(visible(await load(installed)).has(b.ids.legacy), false);
  const store = await createStorage({ type: 'sqlite', file: installed.file });
  t.after(() => store.close());
  await assert.rejects(store.save(structuredClone(await stored(installed))), { name: 'RevisionConflictError' });
  assert.equal(Object.hasOwn(await ledgerOf(installed), 'pending'), false);

  const gone = await storeOf(t, 'sqlite', purgedStore('logical'));
  const opened = [await createStorage({ type: 'sqlite', file: gone.file }), await createSqliteStore(gone.file)];
  t.after(() => { for (const item of opened) item.close(); });
  const restoreFs = { rename: async (from, to) => { if (String(from).endsWith('.recovery')) throw blocked('EIO'); return rename(from, to); } };
  await assert.rejects(restoring(gone, source, {}, { restoreFault: (stage) => { if (stage === 'afterReplacementRename') throw new Error('injected'); }, restoreFs }), { code: 'sqlite_restore_recovery_unconfirmed' });
  assert.equal(existsSync(gone.file), false, 'D is absent, and settle did not make it');
  const ledger = await readFile(knowledge.ledgerPath(gone.file));
  assert.equal(JSON.parse(ledger).pending.length, 1);
  for (const [index, item] of opened.entries()) {
    for (const [name, attempt] of [['load', () => item.load()], ['save', () => item.save(structuredClone(b.payload))], ['update', () => item.update((current) => current)], ['backup', () => item.backup(join(gone.dir, 'copy.db'))]]) {
      await assert.rejects(attempt(), { code: PENDING }, `${index} ${name}`);
      assert.equal(existsSync(gone.file), false, `${index} ${name}`);
    }
  }
  await assert.rejects(opened[0].restore(source.file), { code: PURGE_AWARE }, 'a restore refuses in step 0');
  await assert.rejects(createStorage({ type: 'sqlite', file: gone.file }), { code: PENDING });
  await assert.rejects(createSqliteStore(gone.file), { code: PENDING });
  assert.equal(existsSync(gone.file), false);
  assert.deepEqual(await readFile(knowledge.ledgerPath(gone.file)), ledger, 'the record is kept');
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:426 ${backend}: the caller is activated with the post-step's payload under the ledger it will leave, then once more from the store's load (M19, M20)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  const calls = [];
  await restoring(state, await storeOf(t, backend, b.payload), { afterReplace: (payload) => { calls.push(payload); } });
  assert.equal(calls.length, 2, 'a second activation (M20)');
  const after = await stored(state);
  assert.equal(tokenOf(calls[0], b.ids.legacy), tokenOf(after, b.ids.legacy), 'the post-step payload, never raw B (M19)');
  assert.equal(calls[0].revision, after.revision - 1);
  assert.equal(calls[1].revision, after.revision, 'the second syncs the revision');
  for (const call of calls) {
    const seen = visible(call);
    assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.legacy].filter((id) => seen.has(id)), []);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:426 window ${backend}: an HTTP server paused inside the post-step serves nothing the restore removes or quarantines and keeps /context blocked; then a purge and a pre-purge restore on one server show nothing purged at once (R5 L0 VS3)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  const source = await storeOf(t, backend, b.payload);
  // The server's purge writes the registry: a home of this test's own, for the server's life (PR-37d design §9.3).
  const saved = process.env.SHADOWGRAPH_HOME;
  process.env.SHADOWGRAPH_HOME = join(state.dir, 'home');
  t.after(() => { process.env.SHADOWGRAPH_HOME = saved; });
  const pause = pauseOnce('postStepLedgerWritten');
  // A SQLite server is built over a store that carries the seam (server.js passes one through for JSON only).
  const store = backend === 'sqlite' ? await createStorage({ type: 'sqlite', file: state.file, restoreFault: pause.seam }) : undefined;
  const app = await createShadowGraphServer({ file: state.file, storage: backend, cwd: state.dir, apiToken: '', ...(store ? { store } : { restoreFault: pause.seam }) });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  t.after(() => new Promise((done) => app.server.close(done)));
  const url = (path) => `http://127.0.0.1:${app.server.address().port}${path}`;
  const reads = async (label) => {
    for (const path of ['/records?project=p', '/search?project=p&q=hidden']) assert.equal((await (await fetch(url(path))).text()).includes(SENTINEL), false, `${label} ${path}`);
  };
  const restored = fetch(url('/restore'), { method: 'POST', body: JSON.stringify({ source: source.file }) });
  // Released whatever the reads find, so a failure never leaves the server's restore paused and its close waiting.
  try {
    await pause.reached();
    await reads('paused');
    assert.match(await (await fetch(url('/context'), { method: 'POST', body: JSON.stringify({ project: 'p', query: 'hidden' }) })).text(), /restore is in progress/);
  } finally { pause.release(); }
  const response = await restored;
  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(JSON.parse(await response.text()).deletionKnowledge, 'present');
  await reads('after');
  // R5 L0 VS3: purge p on the running server, then restore the pre-purge backup: nothing purged shows at once.
  const purged = await fetch(url('/projects'), { method: 'DELETE', body: JSON.stringify({ project: 'p', mode: 'logical' }) });
  assert.equal(purged.status, 200, await purged.clone().text());
  const second = await fetch(url('/restore'), { method: 'POST', body: JSON.stringify({ source: source.file }) });
  assert.equal(second.status, 200, await second.clone().text());
  await reads('after a purge and a pre-purge restore');
  const context = await (await fetch(url('/context'), { method: 'POST', body: JSON.stringify({ project: 'p', query: 'hidden' }) })).text();
  assert.equal(context.includes(SENTINEL), false);
  store?.close();
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:427 ${backend}: a pre-purge backup over its own purged store removes p by proven descent: spliced under a hard marker, explained by restore.reapplied, parity and validity kept; skeletons under a logical one (M12)`, options, async (t) => {
  for (const mode of ['hard', 'logical']) {
    // B: p written between q entries, so a splice leaves a gap inside the journal, not only before its first entry.
    const b = backup();
    const base = graphOf(structuredClone(b.payload));
    base.addDecision({ project: 'p', title: `late ${SENTINEL}`, chosen: 'l' });
    base.addDecision({ project: 'q', title: 'final', chosen: 'f' });
    const payload = privilegedSnapshot(base);
    const graph = graphOf(structuredClone(payload));
    graph.purgeProject('p', { mode });
    const state = await storeOf(t, backend, privilegedSnapshot(graph));
    const source = await storeOf(t, backend, payload);
    const result = await restoring(state, source, { now: NOW });
    assert.deepEqual([result.reapplied.removed, result.reapplied.quarantined], [4, 0], mode);
    const after = await stored(state);
    const reapplied = after.journal.filter((entry) => entry.type === 'restore.reapplied');
    assert.deepEqual(reapplied.map((entry) => entry.payload.mode), [mode]);
    const skeletons = after.journal.filter((entry) => entry.redacted === true).length;
    if (mode === 'hard') {
      assert.equal(skeletons, 0, 'no skeleton of the material (M12)');
      assert.equal(reapplied[0].payload.removedJournalSequences.length, reapplied[0].payload.spliced);
      assert.ok(reapplied[0].payload.spliced > 0);
      assert.ok(privilegedValidate(graphOf(after)).issues.some((issue) => issue.code === 'journal_gap' && issue.severity === 'info'), 'validate reports the gap');
    } else assert.equal(skeletons, reapplied[0].payload.skeletons);
    assert.doesNotThrow(() => validateRestorePayload(structuredClone(after)), 'rebuild parity');
    assert.equal(JSON.stringify(after).includes(SENTINEL), false);
    const copy = join(state.dir, `copy-${storeName(backend)}`);
    const store = await createStorage({ type: backend, file: state.file });
    try { await backupFile(state.file, copy, backend === 'sqlite' ? { store } : {}); } finally { store.close?.(); }
    await restoring(await freshOf(t, backend), { file: copy, backend });
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c descent ${backend}: no gap, type or instant proves descent, and descent with no newer marker quarantines (M8, M9, M13)`, options, async (t) => {
  // M9: B's head is a p entry D hard-purged, so D holds no entry at B's head.
  const b = backup();
  const forked = graphOf(structuredClone(b.payload));
  forked.addDecision({ project: 'p', title: `last ${SENTINEL}`, chosen: 'l' });
  const head = privilegedSnapshot(forked);
  const purged = graphOf(structuredClone(head));
  purged.purgeProject('p', { mode: 'hard' });
  const gapped = await storeOf(t, backend, privilegedSnapshot(purged));
  const viaGap = await restoring(gapped, await storeOf(t, backend, head));
  assert.equal(viaGap.reapplied.removed, 0, 'a gap is never a match (M9)');
  assert.equal(JSON.stringify(await stored(gapped)).includes(b.ids.hidden), true, 'quarantined, not removed');
  // M8: the same writes under one fixed clock in two lineages agree on seq, type and instant, never on id.
  const write = () => { const graph = createShadowGraph({ now: () => NOW }); graph.addDecision({ project: 'p', title: `twin ${SENTINEL}`, chosen: 't' }); graph.addDecision({ project: 'q', title: 'twin q', chosen: 'q' }); return graph; };
  const older = privilegedSnapshot(write());
  const newer = write();
  newer.purgeProject('p', { mode: 'logical' });
  const twin = await storeOf(t, backend, privilegedSnapshot(newer));
  const viaTwin = await restoring(twin, await storeOf(t, backend, older));
  assert.equal(viaTwin.reapplied.removed, 0, 'quarantined, never removed (M8)');
  assert.equal(visible(await load(twin)).has(older.records[0].id), false);
  // M13: B's journal is D's, so descent holds, but no marker is newer than B's head: the entity D lacks is quarantined.
  const lacking = structuredClone(b.payload);
  lacking.records = lacking.records.filter((item) => item.id !== b.ids.legacy);
  const descendant = await storeOf(t, backend, lacking);
  await writeLedgerFile(descendant, { version: 1, tombstones: [{ kind: 'project', purgedProject: 'z', mode: 'logical', at: TOMBSTONE_AT, tokens: null, moveIn: 'none' }] });
  const viaDescent = await restoring(descendant, await storeOf(t, backend, b.payload));
  assert.deepEqual([viaDescent.reapplied.removed, viaDescent.reapplied.quarantined], [0, 1], 'no newer marker: quarantine (M13)');
});

for (const [backend, options] of BACKENDS) test(`retention reader rev6:428 ${backend}: nonempty overrides refuse restore until the lifecycle writer can merge stricter, with no change`, options, async (t) => {
  const b = backup();
  const overrides = [{ project: 'p', days: 30 }];
  for (const carried of [[{ project: 'p', days: 365 }], [{ project: 'p', days: 7 }], undefined]) {
    const state = await storeOf(t, backend, purgedStore('logical'));
    await writeLedgerFile(state, { version: 1, retentionOverrides: overrides });
    const before = await hashes(state);
    await assert.rejects(restoring(state, await backupOf(t, backend, b.payload, { version: 1, ...(carried ? { retentionOverrides: carried } : {}) })), { code: 'purge_aware_restore_unsupported_at_this_build' });
    assert.deepEqual(await hashes(state), before, 'reader does not partially adopt or change a policy');
  }
  const fresh = await freshOf(t, backend);
  // SQLite construction materializes its empty store, before restore is
  // invoked. Baseline that existing constructor effect separately.
  if (backend === 'sqlite') (await createStorage({ type: backend, file: fresh.file })).close();
  const before = [existsSync(fresh.file), existsSync(knowledge.ledgerPath(fresh.file))];
  const empty = backend === 'sqlite' ? await hashes(fresh) : null;
  await assert.rejects(restoring(fresh, await backupOf(t, backend, b.payload, { version: 1, tombstones: [itemTombstone([b.tokens.hidden])], retentionOverrides: [{ project: 'p', days: 365 }] })), { code: 'purge_aware_restore_unsupported_at_this_build' });
  assert.deepEqual([existsSync(fresh.file), existsSync(knowledge.ledgerPath(fresh.file))], before, 'refusal creates neither a payload nor a ledger');
  if (empty) assert.deepEqual(await hashes(fresh), empty, 'constructed empty SQLite store remains unchanged');
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:429 write half ${backend}: a record a crash left is completed by the next CLI write, which then conflicts once, and the write after it succeeds (M25)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  const activations = [];
  const result = await restoring(state, await storeOf(t, backend, b.payload), { afterReplace: (payload) => { activations.push(payload); } }, { restoreFault: (stage) => { if (stage === 'beforePostStep') throw new Error('a crash before the post-step'); } });
  assert.equal(result.completion, 'pending');
  assert.equal((await ledgerOf(state)).pending.length, 1);
  // The caller is activated again from the store's load, which suppresses with the record, so it never keeps the
  // post-step's uncommitted payload (§12.3, V-8; review finding 11, X-pending-reactivate).
  const raw = await stored(state);
  assert.equal(activations.length, 2, 'activated again after the post-step failed');
  assert.deepEqual(identityOf(activations[1]), identityOf(raw), 'the stored payload and its revision');
  assert.equal(activations[1][knowledge.DELETION_VIEW].pending, true, 'under the view that suppresses with the record');
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_API_TOKEN: '' };
  const write = () => execute(process.execPath, [cliPath, 'decision', JSON.stringify({ project: 'q', title: 'after', chosen: 'a' })], { cwd: state.dir, env });
  await assert.rejects(write(), (error) => /revision conflict/i.test(error.stderr), 'it conflicts once');
  assert.equal(Object.hasOwn(await ledgerOf(state), 'pending'), false);
  const after = await stored(state);
  assert.equal(typeCount(after, 'restore.reapplied'), 1, 'the post-step is not lost');
  assert.equal(quarantineTokens(await ledgerOf(state)).has(tokenOf(after, b.ids.legacy)), true);
  await write();
});

test('PR-37c binding json: a restore into a fresh path that rolls back leaves it absent with no ledger, and the next restore there proceeds (§8.2, V-17)', async (t) => {
  const b = backup();
  const source = await backupOf(t, 'json', b.payload, { version: 1, tombstones: [itemTombstone([b.tokens.hidden])] });
  const fresh = await freshOf(t, 'json');
  await assert.rejects(restoreFile(source.file, fresh.file, { restoreFault: (stage) => { if (stage === 'afterReplacementRename') throw new Error('injected'); } }), { code: 'json_restore_rolled_back' });
  assert.equal(existsSync(fresh.file), false);
  assert.equal(existsSync(knowledge.ledgerPath(fresh.file)), false, 'the record is discarded with the ledger it made');
  assert.equal((await restoreFile(source.file, fresh.file)).reapplied.removed, 1);
});

for (const [backend, options] of BACKENDS) test(`PR-37c rolled back ${backend}: a fault, or a caller activation that throws, rolls back and discards the record, D's ledger byte- and mode-equal, absent included (M18, M22, M30)`, options, async (t) => {
  const b = backup();
  const prior = '{"version":1,"futureRetentionControls":[{"project":"p","days":30}]}';
  const cases = [
    ['fault', {}, { restoreFault: (stage) => { if (stage === 'afterReplacementRename') throw new Error('injected'); } }],
    ['caller activation', { afterReplace: () => { throw new Error('the caller refuses'); } }, {}]
  ];
  for (const [label, restoreOptions, storeOptions] of cases) for (const withLedger of [true, false]) {
    const state = await storeOf(t, backend, purgedStore('logical'));
    if (withLedger) await writeFile(knowledge.ledgerPath(state.file), prior, { mode: 0o640 });
    const mode = withLedger ? (await stat(knowledge.ledgerPath(state.file))).mode & 0o777 : null;
    const before = await hashes(state);
    await assert.rejects(restoring(state, await storeOf(t, backend, b.payload), restoreOptions, storeOptions), { code: `${backend}_restore_rolled_back` }, label);
    assert.deepEqual(await hashes(state), before, `${label}, ledger ${withLedger}: D and its ledger as they were`);
    if (withLedger) assert.equal((await stat(knowledge.ledgerPath(state.file))).mode & 0o777, mode);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c lift ${backend}: a marker a tombstone records is not lifted, one at another instant is; a marker with no valid instant is lifted once, at the restore's; a skeleton marker lifts as logical; a same-path restore over a marker lifts nothing (M2, M3, M39, M59)`, options, async (t) => {
  const b = backup();
  const d = purgedStore('logical');
  const marker = d.journal.find((entry) => entry.type === 'project.purged');
  const recorded = { kind: 'project', purgedProject: 'p', mode: 'logical', at: marker.at, seq: marker.seq, tokens: [], moveIn: 'none' };
  for (const [label, tombstone, count] of [['recorded', recorded, 1], ['another instant', { ...recorded, at: TOMBSTONE_AT }, 2]]) {
    const state = await storeOf(t, backend, d);
    await writeLedgerFile(state, { version: 1, tombstones: [tombstone] });
    await restoring(state, await storeOf(t, backend, b.payload));
    assert.equal((await ledgerOf(state)).tombstones.length, count, `${label} (M2, M3)`);
  }
  const invalid = structuredClone(d);
  invalid.journal.find((entry) => entry.type === 'project.purged').at = 'not-an-instant';
  const state = await storeOf(t, backend, invalid);
  const own = await storeOf(t, backend, invalid);
  await restoring(state, own, { now: '2026-10-01T00:00:00.000Z' });
  assert.deepEqual((await ledgerOf(state)).tombstones.map((item) => item.at), ['2026-10-01T00:00:00.000Z']);
  await restoring(state, own, { now: '2026-10-02T00:00:00.000Z' });
  assert.equal((await ledgerOf(state)).tombstones.length, 1, 'lifted once (M59)');
  const twice = createShadowGraph({ now: () => NOW });
  twice.addDecision({ project: 'p', title: 'p', chosen: 'p' });
  twice.purgeProject('p', { mode: 'logical' });
  twice.purgeProject('p', { mode: 'logical' });
  const skeleton = await storeOf(t, backend, privilegedSnapshot(twice));
  assert.equal((await stored(skeleton)).journal.filter((entry) => entry.type === 'project.purged' && entry.payload === null).length, 1);
  await restoring(skeleton, await storeOf(t, backend, b.payload));
  assert.deepEqual((await ledgerOf(skeleton)).tombstones.map((item) => [item.purgedProject, item.mode]), [['p', 'logical'], ['p', 'logical']]);
  // Same path: nothing is written, not even and then put back -- the ledger keeps its inode (M39).
  const same = await storeOf(t, backend, d);
  await writeLedgerFile(same, { version: 1, retentionOverrides: [] });
  const inode = (await stat(knowledge.ledgerPath(same.file), { bigint: true })).ino;
  const before = await hashes(same);
  const result = await restoring(same, same);
  assert.deepEqual([result.unchanged, result.deletionKnowledge], [true, 'present'], 'same path (M39)');
  assert.deepEqual(await hashes(same), before);
  assert.equal((await stat(knowledge.ledgerPath(same.file), { bigint: true })).ino, inode, 'never written (M39)');
});

for (const [backend, options] of BACKENDS) test(`PR-37c postdated ${backend}: a backup taken after a purge restores into a fresh path with nothing quarantined, its tokenless post-purge material visible; a creation-tokened entity stays visible beside a foreign tombstone; a pre-purge backup after it never shows p; a backup holding B's own purge lifts nothing (M43a, M43b, M43c, M44)`, options, async (t) => {
  for (const mode of ['logical', 'hard']) {
    const graph = createShadowGraph({ now: () => NOW });
    graph.addDecision({ project: 'p', title: `before ${SENTINEL}`, chosen: 'b' });
    const kept = graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
    const b0 = privilegedSnapshot(graph);
    graph.purgeProject('p', { mode });
    const later = graph.addDecision({ project: 'p', title: 'after the purge', chosen: 'a' });
    const payload = strip(privilegedSnapshot(graph), later.id, 'erasureToken');
    const s = await storeOf(t, backend, payload);
    await restoring(s, await storeOf(t, backend, payload));
    const lifted = (await ledgerOf(s)).tombstones;
    assert.equal(lifted.length, 1, mode);
    const b1 = await freshOf(t, backend);
    const store = await createStorage({ type: backend, file: s.file });
    try { await backupFile(s.file, b1.file, backend === 'sqlite' ? { store } : {}); } finally { store.close?.(); }
    assert.deepEqual((await ledgerOf(b1)).tombstones, lifted);
    const f = await freshOf(t, backend);
    const result = await restoring(f, b1);
    assert.deepEqual(result.reapplied, ZERO, mode);
    assert.equal(Object.hasOwn(await ledgerOf(f), 'quarantine'), false);
    assert.deepEqual((await ledgerOf(f)).tombstones, lifted, 'merged');
    assert.equal(visible(await load(f)).has(later.id), true, `${mode}: no TP (M43a) and no move-in risk (M43c) from a tombstone B postdates`);
    const f2 = await freshOf(t, backend);
    await writeLedgerFile(f2, { version: 1, tombstones: [foreign()] });
    await restoring(f2, b1);
    assert.equal(visible(await load(f2)).has(kept.id), true, `${mode}: no tokens:null from a tombstone B postdates (M43b)`);
    await restoring(f, await storeOf(t, backend, b0));
    assert.equal(JSON.stringify(graphOf(await load(f)).exportData({ project: 'p' })).includes(SENTINEL), false, `${mode}: B0's p material never shows`);
  }
  const own = createShadowGraph({ now: () => NOW });
  own.addDecision({ project: 'p', title: 'old', chosen: 'o' });
  own.purgeProject('p', { mode: 'logical' });
  const again = own.addDecision({ project: 'p', title: 're-created', chosen: 'r' });
  const fresh = await freshOf(t, backend);
  const result = await restoring(fresh, await storeOf(t, backend, privilegedSnapshot(own)));
  assert.equal(result.deletionKnowledge, 'none', 'B\'s markers are never lifted (M44)');
  assert.equal(existsSync(knowledge.ledgerPath(fresh.file)), false);
  assert.equal(visible(await load(fresh)).has(again.id), true);
});

for (const surface of ['load', 'delivery']) test(`PR-37c unfenced json ${surface}: paused after reading the installed B while the post-step commits and clears its record, it reads again and holds what the post-step quarantined (M45)`, async (t) => {
  const b = backup();
  const state = await storeOf(t, 'json', purgedStore('logical'));
  const restorePause = pauseOnce('postStepLedgerWritten');
  const restored = restoreFile((await storeOf(t, 'json', b.payload)).file, state.file, { restoreFault: restorePause.seam });
  await restorePause.reached();
  const readPause = pauseOnce('afterPayloadRead');
  const reading = surface === 'load'
    ? createJsonFileStore(state.file, { loadFault: readPause.seam }).load()
    : readStoreForDelivery({ file: state.file, storage: 'json', afterPayloadRead: () => readPause.seam('afterPayloadRead') }).then((read) => read.payload ?? assert.fail(JSON.stringify(read)));
  await readPause.reached();
  restorePause.release();
  await restored;
  readPause.release();
  const payload = await reading;
  assert.equal(payload.revision, (await stored(state)).revision);
  const seen = visible(payload);
  assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.legacy].filter((id) => seen.has(id)), []);
});

test('PR-37c unfenced SQLite delivery: paused after its payload read while the post-step commits, it is busy, never raw B under the final ledger; while the post-step holds the fence it is busy at once (M45)', SQLITE, async (t) => {
  const b = backup();
  const state = await storeOf(t, 'sqlite', purgedStore('logical'));
  const restorePause = pauseOnce('beforePostStep');
  const store = await createStorage({ type: 'sqlite', file: state.file, restoreFault: restorePause.seam });
  t.after(() => store.close());
  const restored = store.restore((await storeOf(t, 'sqlite', b.payload)).file);
  await restorePause.reached();
  const readPause = pauseOnce('afterPayloadRead');
  const reading = readStoreForDelivery({ file: state.file, storage: 'sqlite', afterPayloadRead: () => readPause.seam('afterPayloadRead') });
  await readPause.reached();
  restorePause.release();
  await restored;
  readPause.release();
  assert.deepEqual(await reading, { unavailable: 'busy' });
  const second = await storeOf(t, 'sqlite', purgedStore('logical'));
  const committedPause = pauseOnce('postStepCommitted');
  const other = await createStorage({ type: 'sqlite', file: second.file, restoreFault: committedPause.seam });
  t.after(() => other.close());
  const again = other.restore((await storeOf(t, 'sqlite', b.payload)).file);
  await committedPause.reached();
  assert.deepEqual(await readStoreForDelivery({ file: second.file, storage: 'sqlite' }), { unavailable: 'busy' });
  committedPause.release();
  await again;
});

test('PR-37c NF-1 SQLite load: through an alias of the store file\'s own name it waits for the post-step, then returns its payload under the final view; a folder alias is a regression case (M62 load path)', SQLITE, async (t) => {
  const b = backup();
  const source = await storeOf(t, 'sqlite', b.payload);
  let credited = 0;
  for (const [kind, killing] of [['8.3 file name', true], ['symbolic link to the file', true], ['folder alias', false]]) {
    const state = await storeOf(t, 'sqlite', purgedStore('logical'));
    const spelling = await spellingFor(t, kind, state.file);
    if (!spelling) continue;
    if (killing) credited += 1;
    const reader = await createSqliteStore(spelling);
    const pause = pauseOnce('postStepLedgerWritten');
    const restorer = await createStorage({ type: 'sqlite', file: state.file, restoreFault: pause.seam });
    const restored = restorer.restore(source.file);
    await pause.reached();
    let settled = false;
    const loading = reader.load().finally(() => { settled = true; });
    await delay(200);
    assert.equal(settled, false, `${kind}: the load waits on the store's one fence`);
    pause.release();
    await restored;
    const payload = await loading;
    assert.equal(payload.revision, (await stored(state)).revision, kind);
    const seen = visible(payload);
    assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.legacy].filter((id) => seen.has(id)), [], kind);
    reader.close();
    restorer.close();
  }
  if (!credited) t.diagnostic('load M62: no credited spelling ran here; the fence unit test kills M62 on this platform');
});

for (const [backend, options] of BACKENDS) test(`PR-37c content-free record ${backend}: in the committed and post states the ledger names no removed or quarantined id, no content and none of D's own ids, and the record has exactly §1.2's members (M52)`, options, async (t) => {
  const b = backup();
  const d = purgedStore('logical');
  const state = await storeOf(t, backend, d);
  await writeLedgerFile(state, { version: 1, tombstones: [itemTombstone([b.tokens.hidden])] });
  const texts = {};
  const restoreFault = async (stage) => { if (['beforePostStep', 'postStepCommitted'].includes(stage)) texts[stage] = await readFile(knowledge.ledgerPath(state.file), 'utf8'); };
  const result = await restoring(state, await storeOf(t, backend, b.payload), {}, { restoreFault });
  assert.deepEqual([result.reapplied.removed, result.reapplied.quarantined], [1, 1]);
  assert.deepEqual(Object.keys(texts).sort(), ['beforePostStep', 'postStepCommitted']);
  for (const [stage, text] of Object.entries(texts)) {
    for (const id of [...Object.values(b.ids), ...d.records.map((item) => item.id)]) assert.equal(text.includes(id), false, `${stage}: ${id}`);
    assert.equal(text.includes(SENTINEL), false, stage);
    const [record] = JSON.parse(text).pending;
    assert.deepEqual(Object.keys(record).sort(), stage === 'beforePostStep' ? ['add', 'expected', 'inputs', 'kind', 'pre'] : ['add', 'expected', 'inputs', 'kind', 'minted', 'post', 'pre'], stage);
    assert.deepEqual(Object.keys(record.inputs).sort(), ['descent', 'descentMode', 'live', 'overlap', 'postdated']);
  }
});

test('PR-37c SQLite window: a save, or a backup, that meets the record between the primitive and the post-step waits on the restore lock -- through D\'s own name and through an alias of its file name -- then the save conflicts, the backup succeeds and the restore completes (M42, M50, M51)', SQLITE, async (t) => {
  const b = backup();
  const source = await storeOf(t, 'sqlite', b.payload);
  let credited = 0;
  for (const [kind, killing] of [['own name', false], ['8.3 file name', true], ['symbolic link to the file', true], ['folder alias', false]]) {
    const state = await storeOf(t, 'sqlite', purgedStore('logical'));
    const spelling = kind === 'own name' ? state.file : await spellingFor(t, kind, state.file);
    if (!spelling) continue;
    if (killing) credited += 1;
    const writer = await createSqliteStore(spelling);
    const current = await writer.load();
    const pause = pauseOnce('beforePostStep');
    const restorer = await createStorage({ type: 'sqlite', file: state.file, restoreFault: pause.seam });
    const restored = restorer.restore(source.file);
    await pause.reached();
    const settled = new Set();
    const saving = writer.save(structuredClone(current)).then(() => 'saved', (error) => error).finally(() => settled.add('save'));
    const copy = join(state.dir, `copy-${kind.replaceAll(' ', '-')}.db`);
    const backingUp = kind === 'own name' ? backupFile(state.file, copy, { store: writer }).finally(() => settled.add('backup')) : null;
    await delay(200);
    assert.deepEqual([...settled], [], `${kind}: nothing settles while the restore holds its lock`);
    assert.equal((await ledgerOf(state)).pending.length, 1, `${kind}: the record survives the pause (M50)`);
    pause.release();
    const result = await restored;
    assert.equal(result.completion, undefined, `${kind}: the post-step was never blocked (M51)`);
    assert.equal((await saving)?.name, 'RevisionConflictError', kind);
    if (backingUp) {
      await backingUp;
      assert.equal(Object.hasOwn(await ledgerOf({ file: copy }) ?? {}, 'pending'), false, 'the backup carries no record (M42)');
    }
    assert.equal(typeof tokenOf(await stored(state), b.ids.legacy), 'string', `${kind}: the post-step's payload`);
    writer.close();
    restorer.close();
  }
  if (!credited) t.diagnostic('window M50: no credited spelling ran here');
});

for (const [backend, options] of BACKENDS) test(`PR-37c caller hooks ${backend}: a validator that empties its copy and an activation that empties its own change nothing the restore classifies or commits (M48, M49)`, options, async (t) => {
  const b = backup();
  const run = async (restoreOptions) => {
    const state = await storeOf(t, backend, ownStore());
    await writeLedgerFile(state, { version: 1, tombstones: [foreign()] });
    const result = await restoring(state, await storeOf(t, backend, b.payload), restoreOptions);
    const after = await stored(state);
    return {
      knowledge: result.deletionKnowledge, reapplied: result.reapplied,
      records: after.records.map((item) => [item.id, typeof item.erasureToken]).sort(), quarantined: (await ledgerOf(state)).quarantine.length
    };
  };
  // D's own ledger already holds what reaches B, so only the pre-step's own classification of B decides whether
  // anything is written: a validator that changed that copy would change it (M48).
  const inert = await run({ validate: () => {}, afterReplace: () => {} });
  const changing = await run({
    validate: (payload) => { payload.records = []; for (const item of payload.facts ?? []) delete item.erasureToken; },
    afterReplace: (payload) => { payload.records.length = 0; payload.journal.length = 0; }
  });
  assert.deepEqual(changing, inert);
  assert.equal(inert.reapplied.quarantined, 1);
});

// A store a schema-6 build wrote, as far as `ids` go: no token, no attribution, schema 5 entities.
function unattributed(payload, ids) {
  for (const id of ids) strip(payload, id, 'erasureToken', 'attribution', 'causalClaim');
  const lower = (value) => { if (value && typeof value === 'object' && ids.includes(value.id)) value.schemaVersion = 5; };
  for (const item of [...payload.records, ...payload.idempotency.map((entry) => entry.value), ...payload.journal.map((entry) => entry.payload)]) lower(item);
  return payload;
}

for (const [backend, options] of BACKENDS) test(`PR-37c untokenable ${backend}: a kindless or unreplayable fact, or an unattributed record, that would have to be withheld refuses the restore and writes nothing; the remedy is offered only where it works, and following it ends quarantined (M38, M66)`, options, async (t) => {
  const make = (shape) => {
    const graph = createShadowGraph({ now: () => NOW });
    graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
    const fact = graph.addFact({ project: 'q', key: 'k', value: `fact ${SENTINEL}` });
    const decision = graph.addDecision({ project: 'q', title: `legacy ${SENTINEL}`, chosen: 'l' });
    const payload = privilegedSnapshot(graph);
    if (shape.includes('kindless')) strip(payload, fact.id, 'kind', 'erasureToken');
    if (shape.includes('unreplayable')) {
      strip(payload, fact.id, 'validityPolicy', 'erasureToken');
      for (const value of [...payload.facts, ...payload.journal.map((entry) => entry.payload)]) if (value?.id === fact.id) value.schemaVersion = 4;
      for (const entry of payload.journal) if (entry.entityId === fact.id) entry.schemaVersion = 4;
    }
    if (shape.includes('unattributed')) unattributed(payload, [decision.id]);
    return { payload, decision };
  };
  // A SQLite store cannot hold a fact that names no kind: its entity row needs one.
  const cases = [['kindless', { fact_without_kind: 1 }, false], ['unreplayable', { not_replayable: 1 }, false], ['unattributed', { not_attributed: 1 }, true], ['unattributed kindless', { not_attributed: 1, fact_without_kind: 1 }, false]]
    .filter(([shape]) => backend === 'json' || !shape.includes('kindless'));
  for (const [shape, counts, remedy] of cases) {
    const state = await storeOf(t, backend, purgedStore('hard'));
    const before = await hashes(state);
    const error = await restoring(state, await storeOf(t, backend, make(shape).payload)).then(() => assert.fail(`${shape}: restored`), (caught) => caught);
    assert.equal(error.code, PURGE_AWARE, shape);
    assert.deepEqual(error.untokenable, counts, shape);
    // The remedy says what its intermediate store shows (Corner 1; review finding 9).
    assert.match(error.message, remedy ? /run migrate there.*a store of its own: until then, what it shows is decided by the deletion records that reach it there/ : /no remedy/, shape);
    assert.equal(error.message.includes(state.dir), false);
    assert.deepEqual(await hashes(state), before, `${shape}: nothing written`);
  }
  // The remedy, followed: a fresh path, migrate there, back that store up, restore the new backup.
  const { payload, decision } = make('unattributed');
  const fresh = await freshOf(t, backend);
  await restoring(fresh, await storeOf(t, backend, payload));
  const env = { ...process.env, SHADOWGRAPH_FILE: fresh.file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_API_TOKEN: '' };
  await execute(process.execPath, [cliPath, 'migrate', JSON.stringify({ preservationCopy: join(fresh.dir, `kept-${storeName(backend)}`) })], { cwd: fresh.dir, env });
  const migrated = join(fresh.dir, `migrated-${storeName(backend)}`);
  const store = await createStorage({ type: backend, file: fresh.file });
  try { await backupFile(fresh.file, migrated, backend === 'sqlite' ? { store } : {}); } finally { store.close?.(); }
  const state = await storeOf(t, backend, purgedStore('hard'));
  await restoring(state, { file: migrated, backend });
  assert.equal(visible(await load(state)).has(decision.id), false, 'quarantined, not refused');
  // A sidecar alone can reach an unattributed record in a fresh path: no remedy is offered there.
  const sidecarOnly = await backupOf(t, backend, make('unattributed').payload, { version: 1, tombstones: [{ kind: 'project', purgedProject: 'q', mode: 'hard', at: TOMBSTONE_AT, seq: 1, tokens: null, moveIn: 'unknown' }] });
  await assert.rejects(restoring(await freshOf(t, backend), sidecarOnly), (caught) => caught.code === PURGE_AWARE && /no remedy/.test(caught.message));
});

for (const [backend, options] of BACKENDS) test(`PR-37c V-24 ${backend}: a restore into a store file with another hard link refuses through either name, whatever ledger lies beside it, and writes nothing; a same-path restore over it does not refuse (M67)`, options, async (t) => {
  const state = await storeOf(t, backend, ownStore());
  await writeLedgerFile(state, { version: 1 });
  const other = { ...state, file: join(state.dir, `other-${storeName(backend)}`) };
  await link(state.file, other.file);
  const source = await storeOf(t, backend, backup().payload);
  const before = [await hashes(state), sha256(JSON.stringify(await stored(other)))];
  for (const name of [state, other]) {
    await assert.rejects(restoring(name, source), { code: PURGE_AWARE }, name.file);
    assert.deepEqual([await hashes(state), sha256(JSON.stringify(await stored(other)))], before);
  }
  assert.equal((await restoring(state, state)).unchanged, true);
  assert.deepEqual(await hashes(state), before[0]);
});

for (const [backend, options] of BACKENDS) test(`PR-37c crash after ledger step 1 ${backend}: the next save repeats step 1 over its own appends, assigns the minted token, and leaves the ledger and counts an uninterrupted restore leaves (M63)`, options, async (t) => {
  const b = backup();
  const graph = graphOf(structuredClone(b.payload));
  graph.addDecision({ project: 'r', title: 'r', chosen: 'r' });
  graph.purgeProject('r', { mode: 'logical' });
  const payload = privilegedSnapshot(graph);
  const marker = payload.journal.find((entry) => entry.type === 'project.purged');
  const sidecar = { version: 1, tombstones: [{ kind: 'project', purgedProject: 'r', mode: 'logical', at: marker.at, seq: marker.seq, tokens: null, moveIn: 'none' }] };
  const d = purgedStore('logical');
  const runOnce = async (crash) => {
    const state = await storeOf(t, backend, d);
    await writeLedgerFile(state, { version: 1, tombstones: [itemTombstone([b.tokens.hidden])] });
    let seen = null;
    const restoreFault = crash ? async (stage) => { if (stage === 'postStepLedgerWritten') { seen = (await ledgerOf(state)).pending[0]; throw new Error('a crash after ledger step 1'); } } : undefined;
    const result = await restoring(state, await backupOf(t, backend, payload, sidecar), {}, { restoreFault });
    return { state, result, seen };
  };
  const plain = await runOnce(false);
  const crashed = await runOnce(true);
  assert.equal(crashed.result.completion, 'pending');
  assert.deepEqual(crashed.seen.inputs.postdated, [1], 'the sidecar\'s tombstone, which B postdates');
  const store = await createStorage({ type: backend, file: crashed.state.file });
  try { await assert.rejects(store.save(structuredClone(await stored(crashed.state))), { name: 'RevisionConflictError' }); } finally { store.close?.(); }
  const [expected, actual] = [await ledgerOf(plain.state), await ledgerOf(crashed.state)];
  assert.equal(Object.hasOwn(actual, 'pending'), false);
  assert.deepEqual(actual.tombstones, expected.tombstones);
  assert.equal(actual.quarantine.length, expected.quarantine.length);
  assert.equal(quarantineTokens(actual).size, actual.quarantine.length, 'no duplicate');
  const after = await stored(crashed.state);
  assert.deepEqual([tokenOf(after, b.ids.legacy)], crashed.seen.minted);
  const counts = async (state) => (await stored(state)).journal.filter((entry) => entry.type === 'restore.reapplied').map((entry) => entry.payload);
  assert.deepEqual(await counts(crashed.state), await counts(plain.state));
});

for (const [backend, options] of BACKENDS) test(`PR-37c crash-left restore lock ${backend}: a lock a dead process left is reclaimed once stale and the record completed; while it is fresh, the next save times out and writes nothing (§12.2)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, b.payload);
  const raw = await stored(state);
  await withRecord(state, record(identityOf(raw), 'committed'));
  const lock = `${await knowledge.canonicalPath(state.file)}.restore.lock`;
  await writeFile(lock, '999999:0:dead');
  const store = await createStorage({ type: backend, file: state.file, lockTimeoutMs: 300, lockPollIntervalMs: 20 });
  t.after(() => store.close?.());
  const before = await hashes(state);
  await assert.rejects(store.save(structuredClone(raw)), { code: 'storage_lock_timeout' });
  assert.deepEqual(await hashes(state), before);
  const old = new Date(Date.now() - 60_000);
  await utimes(lock, old, old);
  await assert.rejects(store.save(structuredClone(raw)), { name: 'RevisionConflictError' });
  assert.equal(Object.hasOwn(await ledgerOf(state), 'pending'), false);
  assert.equal(existsSync(lock), false);
});

for (const [backend, options] of BACKENDS) test(`PR-37c possibleDuplicateOf ${backend}: a visible capture naming a removed one as its possible duplicate names none, history included, and the removed id is nowhere in the store (M37)`, options, async (t) => {
  const graph = createShadowGraph({ now: () => NOW });
  const source = { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user' };
  const first = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: `capture ${SENTINEL}`, admission: ADMISSION, source });
  const second = privilegedRecordCapture(graph, { project: 'p', originId: 'origin-a', text: `capture ${SENTINEL}`, admission: ADMISSION, source });
  const payload = privilegedSnapshot(graph);
  assert.equal(payload.records.find((item) => item.id === second.id).possibleDuplicateOf, first.id);
  const state = await storeOf(t, backend, ownStore());
  await writeLedgerFile(state, { version: 1, tombstones: [itemTombstone([tokenOf(payload, first.id)])] });
  const result = await restoring(state, await storeOf(t, backend, payload));
  assert.equal(result.reapplied.removed, 1);
  const after = await stored(state);
  assert.equal(JSON.stringify(after).includes(first.id), false, 'scrubbed everywhere');
  assert.equal(after.records.find((item) => item.id === second.id).possibleDuplicateOf, null);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(after)));
});

for (const [backend, options] of BACKENDS) test(`PR-37c empty pending ${backend}: a backup whose sidecar holds an empty pending list restores, and the committed restore leaves no pending member (M60)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, ownStore());
  const result = await restoring(state, await backupOf(t, backend, b.payload, { version: 1, pending: [], tombstones: [itemTombstone([b.tokens.hidden])] }));
  assert.equal(result.reapplied.removed, 1);
  assert.equal(Object.hasOwn(await ledgerOf(state), 'pending'), false);
});

for (const [backend, options] of BACKENDS) test(`PR-37c unrelated knowledge ${backend}: tombstones of a project B does not hold change nothing -- no entry, no revision of the post-step, D's ledger byte-equal -- and a lifted clean marker of one adds only itself (M17, M61)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, ownStore());
  const text = JSON.stringify({ version: 1, tombstones: [foreign({ mode: 'logical', moveIn: 'none' }), foreign({ moveIn: 'none', seq: 100 })] });
  await writeFile(knowledge.ledgerPath(state.file), text);
  const source = await storeOf(t, backend, b.payload);
  const installed = Math.max((await stored(state)).revision, (await stored(source)).revision) + 1;
  const result = await restoring(state, source);
  assert.deepEqual([result.deletionKnowledge, result.reapplied], ['present', ZERO]);
  assert.equal(await readFile(knowledge.ledgerPath(state.file), 'utf8'), text);
  const after = await stored(state);
  assert.equal(after.revision, installed);
  assert.deepEqual([typeCount(after, 'restore.reapplied'), typeCount(after, 'entity.token_assigned')], [0, 0]);
  const lifted = await storeOf(t, backend, purgedStore('logical', 'z'));
  assert.deepEqual((await restoring(lifted, source)).reapplied, ZERO);
  const ledger = await ledgerOf(lifted);
  assert.deepEqual(ledger.tombstones.map((item) => [item.purgedProject, item.moveIn]), [['z', 'none']]);
  assert.equal(Object.hasOwn(ledger, 'quarantine'), false);
  assert.equal(visible(await load(lifted)).has(b.ids.legacy), true);
});

for (const [backend, options] of BACKENDS) test(`PR-37c R5 L2 VS1 ${backend}: a backup taken after a restore that quarantined carries the quarantine to a fresh destination`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  await restoring(state, await storeOf(t, backend, b.payload));
  const copy = await freshOf(t, backend);
  const store = await createStorage({ type: backend, file: state.file });
  try { await backupFile(state.file, copy.file, backend === 'sqlite' ? { store } : {}); } finally { store.close?.(); }
  const fresh = await freshOf(t, backend);
  await restoring(fresh, copy);
  const seen = visible(await load(fresh));
  assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.legacy].filter((id) => seen.has(id)), []);
});

// ---------------------------------------------------------------------------
// Quarantine, disclosure, the expand lookup and the downgrade flag (§4.7, §9-§11, scope item 9).
// ---------------------------------------------------------------------------

const LATER = '2026-10-01T00:00:00.000Z';
const LATEST = '2026-10-02T00:00:00.000Z';
const OWNER_CONFIRMATION = 'quarantine_requires_owner_confirmation';
const NOT_QUARANTINED = 'quarantine_selection_refused';
const MCP_TOOLS = new Map(buildToolCatalog().map((entry) => [entry.name, entry]));
const extensionOf = (backend) => (backend === 'sqlite' ? 'db' : 'json');

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

// D with p purged (logical), after B was restored into it at LATER: B's hidden decision and memory are quarantined by
// token, its legacy decision by assignment, all three in p; q's kept decision stays visible.
async function quarantinedStore(t, backend) {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  const source = await storeOf(t, backend, b.payload);
  await restoring(state, source, { now: LATER });
  return { state, source, b };
}

async function openStore(t, state) {
  const store = await createStorage({ type: state.backend, file: state.file });
  t.after(() => store.close?.());
  return store;
}

// Every completeness-bearing surface's answer for one project: an in-process search, CLI, MCP (its structured output
// checked against the tool's own output schema) and HTTP searches, and delivery's head at SessionStart, run through the
// CLI in a working directory bound to that project. With `prompt`, delivery's head at UserPromptSubmit too.
async function surfaceReads(t, state, project, { prompt } = {}) {
  const query = 'decision kept hidden memory legacy';
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: state.backend, SHADOWGRAPH_API_TOKEN: '' };
  const reads = { graph: graphOf(await load(state)).search(query, { project }).completeness };
  reads.cli = JSON.parse((await execute(process.execPath, [cliPath, 'search', JSON.stringify({ project, query })], { cwd: state.dir, env })).stdout).completeness;
  const [mcp] = await mcpCalls(t, state, [['shadowgraph_search', { project, query }]]);
  const structured = JSON.parse(mcp).result.structuredContent;
  assert.deepEqual(schemaErrors(MCP_TOOLS.get('shadowgraph_search').outputSchema, structured), []);
  reads.mcp = structured.completeness;
  const app = await createShadowGraphServer({ file: state.file, storage: state.backend, cwd: state.dir, apiToken: '' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try { reads.http = (await (await fetch(`http://127.0.0.1:${app.server.address().port}/search?project=${project}&q=${encodeURIComponent(query)}`)).json()).completeness; }
  finally { await new Promise((done) => app.server.close(done)); }
  const cwd = join(state.dir, `work-${project}`);
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project, confirmed: true }));
  const deliver = async (event, text) => {
    const child = spawn(process.execPath, [cliPath, 'deliver'], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stdin.end(JSON.stringify({ session_id: 's-1', hook_event_name: event, ...(text === undefined ? {} : { prompt: text }) }));
    await once(child, 'close');
    const line = JSON.parse(stdout).hookSpecificOutput.additionalContext.split('\n').find((entry) => entry.startsWith('head: '));
    return JSON.parse(line.slice('head: '.length));
  };
  reads.delivery = await deliver('SessionStart');
  if (prompt) reads.prompted = await deliver('UserPromptSubmit', prompt);
  return reads;
}

for (const [backend, options] of BACKENDS) test(`PR-37c downgrade flag ${backend}: the output gets a ledger of exactly version and tokensStripped, written before the output; an interrupted downgrade re-runs and keeps its first flag; any other ledger beside the output refuses (M54, check R3-3)`, options, async (t) => {
  const state = await storeOf(t, backend, ownStore());
  const store = await openStore(t, state);
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData(await store.load());
  const at = (name) => join(state.dir, `${name}.${extensionOf(backend)}`);
  const downgrade = (output, preservationCopy, extra) => downgradeStore({ graph, store, file: state.file, storageType: backend, output, preservationCopy, toSchemaVersion: 6, ...extra });
  // Stopped between the flag and the output (M54): the flag is there, no output is.
  const output = at('down');
  await assert.rejects(downgrade(output, at('kept'), { now: () => BEFORE, fault: (stage) => { if (stage === 'afterTokensStripped') throw new Error('stopped after the flag'); } }), /stopped after the flag/);
  assert.equal(existsSync(output), false, 'no output');
  const flag = await readFile(knowledge.ledgerPath(output));
  assert.deepEqual(JSON.parse(flag), { version: 1, tokensStripped: { at: BEFORE } });
  // The re-run, with the converting report out of the way and a new preservation path (re-review NF-6 (b)), under
  // another clock: the first run's flag stays, byte for byte (check R3-3).
  await rm(`${output}.report.json`);
  assert.equal((await downgrade(output, at('kept-again'), { now: () => AFTER })).status, 'complete');
  assert.equal(existsSync(at('kept')), true, 'the first preservation copy is kept');
  assert.deepEqual(await readFile(knowledge.ledgerPath(output)), flag);
  // A downgrade run whole.
  const whole = at('whole');
  await downgrade(whole, at('kept-whole'), { now: () => AFTER });
  assert.deepEqual(JSON.parse(await readFile(knowledge.ledgerPath(whole), 'utf8')), { version: 1, tokensStripped: { at: AFTER } });
  // Any other ledger beside the output refuses before anything is written.
  const others = [['version only', { version: 1 }], ['another member', { version: 1, tokensStripped: { at: BEFORE }, quarantine: [] }], ['an invalid flag', { version: 1, tokensStripped: { at: 'never' } }]];
  for (const [index, [label, ledger]] of others.entries()) {
    const stale = at(`stale-${index}`);
    await writeFile(knowledge.ledgerPath(stale), JSON.stringify(ledger));
    await assert.rejects(downgrade(stale, at(`kept-stale-${index}`)), { code: 'backup_control_ledger_stale' }, label);
    assert.deepEqual([existsSync(stale), existsSync(at(`kept-stale-${index}`))], [false, false], label);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:416 end to end ${backend}: downgrade, re-upgrade, attribute into p and hard-purge p; the pre-downgrade backup restored then quarantines what the purge removed`, options, async (t) => {
  const graph = createShadowGraph({ now: () => NOW });
  const moved = graph.addDecision({ project: 'r', title: `moved ${SENTINEL}`, chosen: 'm' });
  const kept = graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const state = await storeOf(t, backend, privilegedSnapshot(graph));
  const at = (name) => join(state.dir, `${name}.${extensionOf(backend)}`);
  const store = await openStore(t, state);
  await backupFile(state.file, at('pre-downgrade'), backend === 'sqlite' ? { store } : {});
  const loaded = createShadowGraph({ now: () => NOW });
  loaded.importData(await store.load());
  const output = at('down');
  await downgradeStore({ graph: loaded, store, file: state.file, storageType: backend, output, preservationCopy: at('kept'), toSchemaVersion: 6, now: () => NOW });
  // The output re-upgraded: the backfill gives every entity a new token, which the flag beside it disowns.
  const down = { dir: state.dir, file: output, backend };
  // Its hard purge writes p's tombstone beside it and its registry entry into a home of its own (PR-37d design §9.3).
  const downStore = await createStorage({ type: backend, file: output, env: { SHADOWGRAPH_HOME: join(state.dir, 'home') } });
  t.after(() => downStore.close?.());
  const upgraded = createShadowGraph({ now: () => NOW });
  upgraded.importData(await downStore.load());
  await migrateStore({ graph: upgraded, store: downStore, file: output, storageType: backend, preservationCopy: at('kept-up') });
  upgraded.attribute({ ids: [moved.id], targetProject: 'p', reason: 'Explicit move' });
  upgraded.setRevision(await downStore.save(privilegedSnapshot(upgraded)));
  upgraded.purgeProject('p', { mode: 'hard' });
  upgraded.setRevision(await downStore.save(privilegedSnapshot(upgraded)));
  const result = await restoring(down, { file: at('pre-downgrade'), backend });
  assert.equal(result.deletionKnowledge, 'present');
  const ledger = await ledgerOf(down);
  assert.deepEqual(Object.keys(ledger.tokensStripped), ['at']);
  const seen = visible(await load(down));
  assert.deepEqual([seen.has(moved.id), seen.has(kept.id)], [false, true]);
  assert.equal(quarantineTokens(ledger).has(tokenOf(await stored(down), moved.id)), true, 'quarantined by its token');
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:417 ${backend}: two items quarantined, one purged by the owner, then the same backup again: both quarantined and nothing removed, since overlap unproves descent (M10)`, options, async (t) => {
  const graph = createShadowGraph({ now: () => NOW });
  const x = graph.addDecision({ project: 'p', title: `x ${SENTINEL}`, chosen: 'x' });
  const y = graph.addDecision({ project: 'p', title: `y ${SENTINEL}`, chosen: 'y' });
  graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const payload = strip(strip(privilegedSnapshot(graph), x.id, 'erasureToken'), y.id, 'erasureToken');
  const state = await storeOf(t, backend, purgedStore('logical'));
  const source = await storeOf(t, backend, payload);
  assert.deepEqual((await restoring(state, source)).reapplied, { ...ZERO, quarantined: 2 });
  await quarantine.applyQuarantine(await openStore(t, state), 'purge', [y.id], { now: () => NOW });
  assert.deepEqual((await restoring(state, source)).reapplied, { ...ZERO, quarantined: 2 }, 'x under overlap, y by its project: nothing removed');
  const seen = visible(await load(state));
  assert.deepEqual([seen.has(x.id), seen.has(y.id)], [false, false]);
});

for (const [backend, options] of BACKENDS) test(`PR-37c expand G5-6 ${backend}: a line derived before a purge expands to purged, or unavailable after a hard purge, once a pre-purge restore wiped the purge's marker (M33)`, options, async (t) => {
  for (const [mode, reason] of [['logical', 'purged'], ['hard', 'unavailable']]) {
    let clock = NOW;
    const graph = createShadowGraph({ now: () => clock });
    graph.addDecision({ project: 'alpha', title: 'message queue', chosen: 'postgres outbox', alternatives: [{ label: 'kafka cluster', reasonRejected: 'operational cost' }] });
    graph.addDecision({ project: 'beta', title: 'kept', chosen: 'k' });
    const { operation, scope, ...handle } = graph.context({ project: 'alpha', query: 'kafka', compact: true }).relevant.items[0].line.expansion;
    const input = { ...handle, project: scope.project };
    const prePurge = await storeOf(t, backend, privilegedSnapshot(graph), 'restore-wrapper-b-');
    clock = LATER;
    graph.purgeProject('alpha', { mode });
    const state = await storeOf(t, backend, privilegedSnapshot(graph));
    await restoring(state, prePurge);
    const restored = graphOf(await load(state));
    assert.equal(privilegedSnapshot(restored).journal.some((entry) => entry.type === 'project.purged'), false, `${mode}: the marker is gone from the journal`);
    assert.equal(restored.expand(input).status, reason, mode);
    assert.equal(restored.expand({ ...input, recordId: 'decision:missing' }).status, reason, `${mode}: the purge, not the id, decides`);
    assert.equal(restored.expand({ ...input, derivedAt: LATEST }).status, 'unavailable', `${mode}: a line derived after it knows nothing of it`);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c quarantine verbs ${backend}: list gives ids and counts and no content; release makes an item visible and writes no payload; purge removes one, keeps its entry, writes no tombstone, and a later restore of the backup re-quarantines it`, options, async (t) => {
  const { state, source, b } = await quarantinedStore(t, backend);
  const store = await openStore(t, state);
  const before = await hashes(state);
  const listed = await quarantine.quarantineSelection(store, 'list', {});
  assert.deepEqual(listed.entries.map((entry) => entry.id).sort(), [b.ids.hidden, b.ids.memory, b.ids.legacy].sort());
  for (const entry of listed.entries) assert.deepEqual([Object.keys(entry).sort(), entry.project, entry.attribution], [['attribution', 'createdAt', 'id', 'kind', 'project'], 'p', 'project']);
  assert.deepEqual(listed.counts, { p: 3 });
  assert.equal(JSON.stringify(listed).includes(SENTINEL), false, 'no content');
  assert.deepEqual((await quarantine.quarantineSelection(store, 'list', { project: 'q' })).entries, []);
  assert.deepEqual(await hashes(state), before, 'list writes nothing');
  // Release.
  const selected = await quarantine.quarantineSelection(store, 'release', { ids: [b.ids.hidden] });
  assert.deepEqual(selected.ids, [b.ids.hidden]);
  await quarantine.applyQuarantine(store, 'release', selected.ids, { now: () => NOW });
  assert.equal((await hashes(state))[0], before[0], 'release writes no payload');
  assert.equal(visible(await load(state)).has(b.ids.hidden), true);
  assert.equal(tokenOf(await stored(state), b.ids.hidden), b.tokens.hidden, 'it keeps its token');
  assert.equal(quarantineTokens(await ledgerOf(state)).has(b.tokens.hidden), false);
  // Purge.
  const prior = await stored(state);
  const { tombstones } = await ledgerOf(state);
  const registryHash = async () => (existsSync(knowledge.registryFile()) ? sha256(await readFile(knowledge.registryFile())) : null);
  const registryBefore = await registryHash();
  await quarantine.applyQuarantine(store, 'purge', [b.ids.memory], { now: () => NOW });
  const after = await stored(state);
  assert.equal(JSON.stringify(after).includes(b.ids.memory), false, 'removed physically, every reference with it');
  assert.equal(JSON.stringify(after).includes(`memory ${SENTINEL}`), false);
  assert.equal(typeCount(after, 'restore.reapplied'), typeCount(prior, 'restore.reapplied'), 'not a restore');
  assert.deepEqual(privilegedValidate(graphOf(after)).issues.filter((issue) => issue.severity === 'error'), []);
  const ledger = await ledgerOf(state);
  assert.equal(quarantineTokens(ledger).has(b.tokens.memory), true, 'its entry is kept');
  assert.deepEqual(ledger.tombstones, tombstones, 'no tombstone');
  assert.equal(await registryHash(), registryBefore, 'no registry entry');
  assert.deepEqual((await quarantine.quarantineSelection(store, 'list', {})).entries.map((entry) => entry.id), [b.ids.legacy]);
  // A later restore of a backup holding it: hidden again (rev6:417).
  await restoring(state, source, { now: LATEST });
  assert.equal(visible(await load(state)).has(b.ids.memory), false);
  // A token a tombstone names too is purged, not quarantined: out of the list and of every count (§9.3).
  await knowledge.writeLedger(state.file, (value) => { value.tombstones.push(itemTombstone([tokenOf(after, b.ids.legacy)])); });
  assert.deepEqual((await quarantine.quarantineSelection(store, 'list', {})).entries.map((entry) => entry.id), [b.ids.memory]);
  assert.equal(graphOf(await load(state)).search('', { project: 'p' }).completeness.quarantined, 1);
});

for (const [backend, options] of BACKENDS) test(`PR-37c quarantine release ${backend}: a tombstone of the item's project later than its entry refuses release, and an entry with no instant is earlier than every tombstone; an id not quarantined refuses the whole call; nothing is written (M35)`, options, async (t) => {
  const { state, b } = await quarantinedStore(t, backend);
  const store = await openStore(t, state);
  let before = await hashes(state);
  await assert.rejects(quarantine.quarantineSelection(store, 'release', { ids: [b.ids.hidden, b.ids.kept] }), { code: NOT_QUARANTINED });
  // Checked again under the locks: the ids the owner confirmed must still be quarantined.
  await assert.rejects(quarantine.applyQuarantine(store, 'purge', [b.ids.hidden, b.ids.kept], { now: () => NOW }), { code: NOT_QUARANTINED });
  await assert.rejects(quarantine.quarantineSelection(store, 'release', { ids: [b.ids.hidden], project: 'p' }), /exactly one/);
  assert.deepEqual(await hashes(state), before);
  // A tombstone of p recorded after the entries.
  await knowledge.writeLedger(state.file, (ledger) => { ledger.tombstones.push({ kind: 'project', purgedProject: 'p', mode: 'logical', at: LATEST, seq: 77, tokens: null, moveIn: 'none' }); });
  before = await hashes(state);
  await assert.rejects(quarantine.applyQuarantine(store, 'release', [b.ids.legacy], { now: () => NOW }), { code: 'quarantine_release_refused' });
  assert.deepEqual(await hashes(state), before);
  // An entry with no instant, under only the lifted marker of p, which is earlier than every entry's instant.
  const other = await quarantinedStore(t, backend);
  const otherStore = await openStore(t, other.state);
  await quarantine.applyQuarantine(otherStore, 'release', [other.b.ids.hidden], { now: () => NOW });
  await knowledge.writeLedger(other.state.file, (ledger) => { ledger.quarantine = ledger.quarantine.map(({ at, ...entry }) => entry); });
  before = await hashes(other.state);
  await assert.rejects(quarantine.applyQuarantine(otherStore, 'release', [other.b.ids.legacy], { now: () => NOW }), { code: 'quarantine_release_refused' });
  assert.deepEqual(await hashes(other.state), before);
});

for (const [backend, options] of BACKENDS) test(`PR-37c quarantine CLI ${backend}: with stdin piped every subcommand refuses with ${OWNER_CONFIRMATION} and writes nothing (M34)`, options, async (t) => {
  const { state, b } = await quarantinedStore(t, backend);
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: backend };
  const before = await hashes(state);
  for (const args of [['list'], ['release', JSON.stringify({ ids: [b.ids.hidden] })], ['purge', JSON.stringify({ project: 'p' })]]) {
    const run = await execute(process.execPath, [cliPath, 'quarantine', ...args], { cwd: state.dir, env }).then(() => ({ code: 0 }), (error) => error);
    assert.equal(run.code, 1, args[0]);
    assert.match(run.stderr, new RegExp(OWNER_CONFIRMATION), args[0]);
  }
  assert.deepEqual(await hashes(state), before);
});

test('PR-37c quarantine CLI: at a terminal the owner\'s typed confirm releases and purges, and any other answer writes nothing', { skip: process.platform === 'win32' ? 'Real PTY coverage runs on Ubuntu WSL; Python pty is unavailable on Windows' : false }, async (t) => {
  const { state, b } = await quarantinedStore(t, 'json');
  const helper = fileURLToPath(new URL('./helpers/access-cli-pty.py', import.meta.url));
  const pty = (args, answer) => {
    const run = spawnSync('python3', [helper, JSON.stringify({ command: [process.execPath, cliPath, 'quarantine', ...args], cwd: state.dir, env: { SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: 'json' }, answers: [{ prompt: 'Type confirm', answer }] })], { encoding: 'utf8', timeout: 15_000 });
    assert.equal(run.status, 0, run.stderr || run.stdout);
    return JSON.parse(run.stdout);
  };
  const before = await hashes(state);
  for (const answer of ['no', null]) {
    const declined = pty(['release', JSON.stringify({ ids: [b.ids.hidden] })], answer);
    assert.notEqual(declined.status, 0, declined.output);
    assert.match(declined.output, new RegExp(OWNER_CONFIRMATION));
  }
  assert.deepEqual(await hashes(state), before);
  assert.equal(pty(['release', JSON.stringify({ ids: [b.ids.hidden] })], 'confirm').status, 0);
  assert.equal(visible(await load(state)).has(b.ids.hidden), true);
  assert.equal(pty(['purge', JSON.stringify({ ids: [b.ids.memory] })], 'confirm').status, 0);
  assert.equal(JSON.stringify(await stored(state)).includes(b.ids.memory), false);
});

test('PR-37c quarantine scans: cli.js alone imports the verbs, no agent surface names them, a privileged quarantine primitive or a quarantine route, and no tool is named for quarantine', async () => {
  const importers = [];
  for (const name of (await readdir(srcRoot, { recursive: true })).filter((item) => item.endsWith('.js'))) {
    if (/(?:from\s+|import\(\s*)'[^']*quarantine\.js'/.test(await readFile(join(srcRoot, name), 'utf8'))) importers.push(name.replaceAll('\\', '/'));
  }
  assert.deepEqual(importers, ['cli.js']);
  for (const name of ['mcp.js', 'mcp-tools.js', 'server.js', join('internal', 'access-transport.js')]) {
    const text = await readFile(join(srcRoot, name), 'utf8');
    assert.doesNotMatch(text, /privilegedQuarantine|quarantineSelection|applyQuarantine|shadowgraph_quarantine|['"`]\/quarantine/, name);
  }
  assert.deepEqual(buildToolCatalog({ verifier: true }).map((entry) => entry.name).filter((name) => /quarantine/i.test(name)), []);
});

for (const [backend, options] of BACKENDS) test(`PR-37c R5 L1 VS1 ${backend}: a purge of a project through CLI, MCP and HTTP, logical and hard, reaches its quarantined items: gone from the store, valid, no content in the store or its ledger, out of list, and release cannot bring them back`, options, async (t) => {
  for (const surface of ['cli', 'mcp', 'http']) for (const mode of ['logical', 'hard']) {
    const label = `${surface} ${mode}`;
    const { state, b } = await quarantinedStore(t, backend);
    // Each surface's purge writes the registry into a home of this test's own (PR-37d design §9.3).
    const home = join(state.dir, 'home');
    const env = { ...process.env, SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_API_TOKEN: '' };
    if (surface === 'cli') await execute(process.execPath, [cliPath, 'purge', JSON.stringify({ project: 'p', mode })], { cwd: state.dir, env });
    else if (surface === 'mcp') {
      const [text] = await mcpCalls(t, state, [['shadowgraph_purge', { project: 'p', mode }]], { SHADOWGRAPH_HOME: home });
      assert.equal(JSON.parse(text).result?.isError, undefined, text);
    } else {
      const saved = process.env.SHADOWGRAPH_HOME;
      process.env.SHADOWGRAPH_HOME = home;
      try {
        const app = await createShadowGraphServer({ file: state.file, storage: backend, cwd: state.dir, apiToken: '' });
        app.server.listen(0, '127.0.0.1');
        await once(app.server, 'listening');
        try {
          const response = await fetch(`http://127.0.0.1:${app.server.address().port}/projects`, { method: 'DELETE', body: JSON.stringify({ project: 'p', mode }) });
          assert.equal(response.status, 200, await response.text());
        } finally { await new Promise((done) => app.server.close(done)); }
      } finally { process.env.SHADOWGRAPH_HOME = saved; }
    }
    const after = await stored(state);
    for (const id of [b.ids.hidden, b.ids.memory, b.ids.legacy]) assert.equal(JSON.stringify(after).includes(id), false, `${label}: ${id}`);
    assert.deepEqual(privilegedValidate(graphOf(after)).issues.filter((issue) => issue.severity === 'error'), [], label);
    for (const path of [state.file, `${state.file}-wal`, knowledge.ledgerPath(state.file)]) {
      if (existsSync(path)) assert.equal((await readFile(path)).includes(SENTINEL), false, `${label}: ${basename(path)}`);
    }
    const store = await openStore(t, state);
    assert.deepEqual((await quarantine.quarantineSelection(store, 'list', {})).entries, [], label);
    await assert.rejects(quarantine.applyQuarantine(store, 'release', [b.ids.hidden], { now: () => NOW }), { code: NOT_QUARANTINED }, label);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c counts ${backend}: with quarantine present every read surface counts its own scope's quarantined items and is not complete, and another scope counts none (M36)`, options, async (t) => {
  const { state } = await quarantinedStore(t, backend);
  for (const [surface, completeness] of Object.entries(await surfaceReads(t, state, 'p'))) {
    assert.deepEqual([completeness.quarantined, completeness.complete], [3, false], surface);
    if (surface !== 'delivery') {
      assert.equal(completeness.limitation.code, 'quarantine_withheld', surface);
      assert.match(completeness.limitation.detail, /3 items of this scope are withheld as possibly purged; only the owner can release or purge them/, surface);
    }
  }
  for (const [surface, completeness] of Object.entries(await surfaceReads(t, state, 'q'))) {
    assert.equal(completeness.quarantined, undefined, `${surface}: another scope's count (M36)`);
    if (surface !== 'delivery') assert.equal(completeness.complete, true, surface);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c pending disclosure ${backend}: while a committed record waits, every read surface says the view is not complete, with restore_pending, though nothing is quarantined yet (M56)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, b.payload);
  await withRecord(state, record(identityOf(await stored(state)), 'committed'));
  for (const [surface, completeness] of Object.entries(await surfaceReads(t, state, 'q', { prompt: 'kept decision' }))) {
    assert.deepEqual([completeness.complete, completeness.quarantined], [false, undefined], surface);
    // A search has no code of its own, so it says restore_pending; delivery keeps its relevance code first, and at
    // SessionStart says relevance was not assessed.
    if (!['delivery', 'prompted'].includes(surface)) assert.equal(completeness.limitation.code, 'restore_pending', surface);
    if (surface !== 'delivery') assert.match(completeness.limitation.detail, /A restore has not finished; material it may remove or quarantine is withheld until the next write completes it/, surface);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c MCP restore ${backend}: the structured output declares deletionKnowledge, reapplied and, after a post-step fault, completion; the route no longer says a restore recovers purged material`, options, async (t) => {
  const tool = MCP_TOOLS.get('shadowgraph_restore');
  assert.equal(tool.outputSchema.required.includes('deletionKnowledge'), true);
  assert.deepEqual(['deletionKnowledge', 'reapplied', 'completion'].map((name) => Object.hasOwn(tool.outputSchema.properties, name)), [true, true, true]);
  assert.match(tool.description, /Use shadowgraph_backup first\. Material shadowgraph_purge deleted stays out where deletion records reach it\. memoryOnly excludes authority\./);
  assert.doesNotMatch(tool.description, /recovers/);
  for (const fault of [false, true]) {
    const state = await storeOf(t, backend, purgedStore('logical'));
    const source = await storeOf(t, backend, backup().payload);
    const [text] = await mcpCalls(t, state, [['shadowgraph_restore', { source: source.file }]], fault ? { NODE_ENV: 'test', SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: 'postStepLedgerWritten' } : {});
    const structured = JSON.parse(text).result.structuredContent;
    assert.deepEqual(schemaErrors(tool.outputSchema, structured), [], text);
    assert.deepEqual([structured.deletionKnowledge, structured.reapplied, structured.completion], ['present', { ...ZERO, quarantined: 1 }, fault ? 'pending' : undefined]);
  }
});

test('PR-37c S-1: a read of a store\'s ledger or restore lock is ShadowGraph\'s own traffic, and the lock a store activated through a folder alias lists is its fence\'s', async (t) => {
  const home = await scratchDirectory(t, 'restore-wrapper-s1-');
  const file = join(home, 'stores', 'memory.json');
  await mkdir(dirname(file));
  await createJsonFileStore(file).save(privilegedSnapshot(createShadowGraph()));
  const alias = await folderAlias(t, file);
  const verified = JSON.parse(await readFile(fileURLToPath(new URL('../integrations/claude-code.coverage.json', import.meta.url)), 'utf8')).verifiedVersion;
  const env = { ...process.env, HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: join(home, 'sg-home'), SHADOWGRAPH_FILE: '' };
  const { stdout } = await execute(process.execPath, [cliPath, 'activate', 'capture', '--evidence', 'ag2-receipt', '--store', alias, '--host-version', verified, '--settings', join(home, 'settings-fixture.json')], { cwd: home, env });
  const storeFile = JSON.parse(stdout).record.capabilities.capture.store.file;
  const artefacts = captureArtefacts({ storeFile });
  assert.equal(artefacts.artefactPaths.includes(await fences.fenceLockPath(alias)), true, 'the fence the store\'s writers take');
  const context = { ...artefacts, home };
  for (const suffix of ['.lock', '.control.json', '.restore.lock']) {
    const event = { event: 'PostToolUse', sessionId: 'session-1', cwd: home, toolName: 'Read', toolInput: { file_path: `${storeFile}${suffix}` } };
    assert.deepEqual(classifyCaptureSource(event, context), { selfEvent: true, signal: 'S-1' }, suffix);
  }
});

test('PR-37c emitters: entity.token_assigned and restore.reapplied each have one writer in src, in shadowgraph.js', async () => {
  const found = {};
  for (const name of (await readdir(srcRoot, { recursive: true })).filter((item) => item.endsWith('.js'))) {
    const text = await readFile(join(srcRoot, name), 'utf8');
    for (const type of ['entity.token_assigned', 'restore.reapplied']) {
      const count = text.match(new RegExp(`type:\\s*'${type.replace('.', '\\.')}'`, 'g'))?.length ?? 0;
      if (count) (found[type] ??= []).push([name, count]);
    }
  }
  assert.deepEqual(found, { 'entity.token_assigned': [['shadowgraph.js', 1]], 'restore.reapplied': [['shadowgraph.js', 1]] });
});

test('PR-37c no reachable I/O handle: no store object carries an own symbol (M57)', async (t) => {
  const dir = await scratchDirectory(t, 'restore-wrapper-symbols-');
  const stores = [createJsonFileStore(join(dir, 'a.json'))];
  if (sqlite.available) stores.push(await createSqliteStore(join(dir, 'b.db')), await createStorage({ type: 'sqlite', file: join(dir, 'c.db') }));
  for (const store of stores) {
    assert.deepEqual(Object.getOwnPropertySymbols(store), []);
    store.close?.();
  }
});

// ---------------------------------------------------------------------------
// The restore through every entry, the rows the wrapper's own entries left (§13.3), and the rollback floor.
// ---------------------------------------------------------------------------

const ENTRIES = { json: ['restoreFile', 'cli', 'mcp', 'http'], sqlite: ['./storage', 'cli', 'mcp', 'http'] };

// A restore of `source` into `state` through one entry, and its result as the caller gets it. The in-process entries
// take `options`; CLI and MCP are their own processes, and HTTP runs in process.
async function restoreVia(t, entry, state, source, options = {}) {
  if (entry === 'restoreFile' || entry === './storage') return restoring(state, source, options);
  const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: state.backend, SHADOWGRAPH_API_TOKEN: '' };
  if (entry === 'cli') return JSON.parse((await execute(process.execPath, [cliPath, 'restore', source.file], { cwd: state.dir, env })).stdout);
  if (entry === 'mcp') {
    const [text] = await mcpCalls(t, state, [['shadowgraph_restore', { source: source.file }]]);
    const response = JSON.parse(text);
    assert.equal(response.result?.isError, undefined, text);
    return response.result.structuredContent;
  }
  const app = await createShadowGraphServer({ file: state.file, storage: state.backend, cwd: state.dir, apiToken: '' });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  try {
    const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, { method: 'POST', body: JSON.stringify({ source: source.file }) });
    const text = await response.text();
    assert.equal(response.status, 200, text);
    return JSON.parse(text);
  } finally { await new Promise((done) => app.server.close(done)); }
}

// R5 L0 VS4: D is B's own store after p's `moved` decision was moved to r, a decision `late` was added in q, and p was
// hard-purged; B's sidecar holds `held` (in p) as quarantined. Restoring B splices `purged` by proven descent, keeps
// `moved` (live in D) and `held` (quarantined) in p, and the rebuilt journal still matches the live records.
function movedAndQuarantined() {
  const graph = createShadowGraph({ now: () => NOW });
  const moved = graph.addDecision({ project: 'p', title: 'moved', chosen: 'm' });
  const purged = graph.addDecision({ project: 'p', title: `purged ${SENTINEL}`, chosen: 'x' });
  const held = graph.addDecision({ project: 'p', title: `held ${SENTINEL}`, chosen: 'e' });
  const kept = graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const b = privilegedSnapshot(graph);
  graph.attribute({ ids: [moved.id], targetProject: 'r', reason: 'Explicit move' });
  const late = graph.addDecision({ project: 'q', title: 'late', chosen: 'l' });
  graph.purgeProject('p', { mode: 'hard' });
  return { b, d: privilegedSnapshot(graph), sidecar: { version: 1, quarantine: [{ token: tokenOf(b, held.id), at: NOW }] }, ids: { moved: moved.id, purged: purged.id, held: held.id, kept: kept.id, late: late.id } };
}

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:427 R5 L0 VS4 ${backend}: a moved-out live entity and a quarantined one stay in p beside a hard splice, and rebuild parity holds, through every restore entry; the record's live ids are B's candidates only (V-10, M52)`, options, async (t) => {
  for (const entry of ENTRIES[backend]) {
    const fixture = movedAndQuarantined();
    const state = await storeOf(t, backend, fixture.d);
    const source = await backupOf(t, backend, fixture.b, fixture.sidecar);
    let record = null;
    const inProcess = entry === 'restoreFile' || entry === './storage';
    const restoreFault = async (stage) => { if (stage === 'beforePostStep') record = JSON.parse(await readFile(knowledge.ledgerPath(state.file), 'utf8')).pending[0]; };
    const result = inProcess ? await restoring(state, source, {}, { restoreFault }) : await restoreVia(t, entry, state, source);
    assert.deepEqual([result.deletionKnowledge, result.reapplied?.removed, result.reapplied?.quarantined], ['present', 1, 0], entry);
    const after = await stored(state);
    assert.doesNotThrow(() => validateRestorePayload(structuredClone(after)), `${entry}: rebuild parity`);
    assert.deepEqual(privilegedValidate(graphOf(after)).issues.filter((issue) => issue.severity === 'error'), [], entry);
    const [reapplied] = after.journal.filter((item) => item.type === 'restore.reapplied');
    assert.deepEqual([reapplied.payload.mode, reapplied.payload.spliced > 0], ['hard', true], entry);
    assert.equal(JSON.stringify(after).includes(fixture.ids.purged), false, `${entry}: spliced, no skeleton`);
    const inP = after.records.filter((item) => item.project === 'p').map((item) => item.id).sort();
    assert.deepEqual(inP, [fixture.ids.moved, fixture.ids.held].sort(), `${entry}: both stay in p`);
    const seen = visible(await load(state));
    assert.deepEqual([seen.has(fixture.ids.moved), seen.has(fixture.ids.kept), seen.has(fixture.ids.held)], [true, true, false], entry);
    if (inProcess) assert.deepEqual(record.inputs.live, [fixture.ids.moved, fixture.ids.kept].sort(), `${entry}: D's own late decision is no candidate of B (V-10)`);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:426 MCP ${backend}: MCP calls are serialised, so a second process loads the store in each state a restore's window leaves; it and the same server's reads show nothing removed or quarantined, and a failing tool's rollback keeps the view`, options, async (t) => {
  for (const stage of ['beforePostStep', 'postStepLedgerWritten', 'postStepCommitted']) {
    const b = backup();
    const state = await storeOf(t, backend, purgedStore('logical'));
    const source = await storeOf(t, backend, b.payload);
    const texts = await mcpCalls(t, state, [
      ['shadowgraph_restore', { source: source.file }],
      ['shadowgraph_search', { project: 'p', query: 'hidden memory legacy' }],
      ['shadowgraph_update_status', { project: 'q', decisionId: 'decision:missing', status: 'accepted' }],
      ['shadowgraph_search', { project: 'p', query: 'hidden memory legacy' }],
      ['shadowgraph_journal', { project: 'p' }]
    ], { NODE_ENV: 'test', SHADOWGRAPH_TEST_RESTORE_FAULT_STAGES: stage });
    const [restored, , failed] = texts.map((text) => JSON.parse(text));
    assert.equal(restored.result.structuredContent.completion, 'pending', stage);
    assert.ok(failed.error || failed.result?.isError, `${stage}: the tool failed: ${texts[2]}`);
    for (const text of texts) assert.equal(text.includes(SENTINEL), false, `${stage}: ${text.slice(0, 160)}`);
    // The second process, in the state the window left: its reads write nothing and show nothing.
    const before = await hashes(state);
    const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_API_TOKEN: '' };
    for (const args of [['list', JSON.stringify({ project: 'p' })], ['search', JSON.stringify({ project: 'p', query: 'hidden' })]]) {
      assert.equal((await execute(process.execPath, [cliPath, ...args], { cwd: state.dir, env })).stdout.includes(SENTINEL), false, `${stage} ${args[0]}`);
    }
    assert.deepEqual(await hashes(state), before, `${stage}: the reads wrote nothing`);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:424 ${backend}: p material created after a tombstone of p, tokened at its creation, stays visible; D's own lifted marker over an unrelated lineage's p material quarantines and counts it (Option A, declared)`, options, async (t) => {
  const dir = await scratchDirectory(t, 'restore-wrapper-created-after-');
  const env = { ...process.env, SHADOWGRAPH_HOME: join(dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME);
  await writeFile(knowledge.registryFile(env), JSON.stringify({ version: 1, tombstones: [{ kind: 'project', purgedProject: 'p', mode: 'logical', at: TOMBSTONE_AT, seq: 7, tokens: ['token-old'], moveIn: 'none' }] }));
  const graph = createShadowGraph({ now: () => AFTER });
  const created = graph.addDecision({ project: 'p', title: 'created after the tombstone', chosen: 'c' });
  graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const state = await freshOf(t, backend);
  const result = await restoring(state, await storeOf(t, backend, privilegedSnapshot(graph)), {}, { env });
  assert.deepEqual([result.deletionKnowledge, result.reapplied], ['present', ZERO]);
  assert.equal(Object.hasOwn(await ledgerOf(state), 'quarantine'), false);
  assert.equal(visible(await load(state)).has(created.id), true, 'creation-tokened');
  // Declared Option A: D's own marker carries no lineage, so an unrelated lineage's p material is withheld and counted.
  const b = backup();
  const purged = await storeOf(t, backend, purgedStore('logical'));
  assert.equal((await restoring(purged, await storeOf(t, backend, b.payload))).reapplied.quarantined, 1, 'the legacy decision, by assignment');
  const seen = visible(await load(purged));
  assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.legacy].filter((id) => seen.has(id)), []);
  assert.equal(graphOf(await load(purged)).search('', { project: 'p' }).completeness.quarantined, 3, 'counted on its scope\'s reads');
});

for (const [backend, options] of BACKENDS) test(`PR-37c the §4.3 residual ${backend}: a backup taken after a pre-purge restore into its store carries the tombstone but not the marker, so its p material created afterwards is quarantined in a fresh path, as declared`, options, async (t) => {
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ project: 'p', title: `before ${SENTINEL}`, chosen: 'b' });
  const kept = graph.addDecision({ project: 'q', title: 'kept', chosen: 'k' });
  const b0 = privilegedSnapshot(graph);
  graph.purgeProject('p', { mode: 'logical' });
  const s = await storeOf(t, backend, privilegedSnapshot(graph));
  await restoring(s, await storeOf(t, backend, b0));
  assert.equal(typeCount(await stored(s), 'project.purged'), 0, 'the pre-purge restore replaced the journal that held the marker');
  // Material p gains afterwards, tokened at its creation.
  const live = graphOf(await load(s));
  const afterwards = live.addDecision({ project: 'p', title: 'written after the restore', chosen: 'w' });
  const store = await createStorage({ type: backend, file: s.file });
  try {
    await store.save(privilegedSnapshot(live));
    const b2 = await freshOf(t, backend);
    await backupFile(s.file, b2.file, backend === 'sqlite' ? { store } : {});
    assert.deepEqual((await ledgerOf(b2)).tombstones.map((item) => [item.purgedProject, item.tokens]), [['p', null]], 'the sidecar carries the lifted tombstone');
    const f = await freshOf(t, backend);
    await restoring(f, b2);
    const seen = visible(await load(f));
    assert.deepEqual([seen.has(afterwards.id), seen.has(kept.id)], [false, true], 'quarantined, as declared; q stays');
    assert.equal(quarantineTokens(await ledgerOf(f)).has(tokenOf(await stored(f), afterwards.id)), true);
  } finally { store.close?.(); }
});

for (const [backend, options] of BACKENDS) test(`PR-37c R5 L2 VS1 ${backend}: a post-quarantine backup through the CLI, MCP and HTTP backup entries carries the quarantine to a fresh destination`, options, async (t) => {
  for (const entry of ['cli', 'mcp', 'http']) {
    const { state, b } = await quarantinedStore(t, backend);
    const copy = join(state.dir, `copy-${entry}.${extensionOf(backend)}`);
    const env = { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: backend, SHADOWGRAPH_API_TOKEN: '' };
    if (entry === 'cli') await execute(process.execPath, [cliPath, 'backup', copy], { cwd: state.dir, env });
    else if (entry === 'mcp') {
      const [text] = await mcpCalls(t, state, [['shadowgraph_backup', { destination: copy }]]);
      assert.equal(JSON.parse(text).result?.isError, undefined, text);
    } else {
      const app = await createShadowGraphServer({ file: state.file, storage: backend, cwd: state.dir, apiToken: '' });
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      try {
        const response = await fetch(`http://127.0.0.1:${app.server.address().port}/backup`, { method: 'POST', body: JSON.stringify({ destination: copy }) });
        assert.equal(response.status, 200, await response.text());
      } finally { await new Promise((done) => app.server.close(done)); }
    }
    assert.equal(quarantineTokens(await ledgerOf({ file: copy })).size, 3, `${entry}: the sidecar carries the quarantine`);
    const fresh = await freshOf(t, backend);
    await restoring(fresh, { file: copy, backend });
    const seen = visible(await load(fresh));
    assert.deepEqual([b.ids.hidden, b.ids.memory, b.ids.legacy].filter((id) => seen.has(id)), [], entry);
    assert.equal(seen.has(b.ids.kept), true, entry);
  }
});

for (const [backend, options] of BACKENDS) test(`PR-37c rev6:417 fork ${backend}: another fork of the backup, holding the same quarantined item, re-quarantines it under its one token and adds no entry`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  await restoring(state, await storeOf(t, backend, b.payload));
  const token = tokenOf(await stored(state), b.ids.legacy);
  const { quarantine: entries } = await ledgerOf(state);
  const fork = graphOf(structuredClone(b.payload));
  fork.addDecision({ project: 'q', title: 'only in the fork', chosen: 'f' });
  assert.deepEqual((await restoring(state, await storeOf(t, backend, privilegedSnapshot(fork)))).reapplied, { ...ZERO, quarantined: 1 });
  assert.equal(tokenOf(await stored(state), b.ids.legacy), token);
  assert.deepEqual((await ledgerOf(state)).quarantine, entries);
  assert.equal(visible(await load(state)).has(b.ids.legacy), false);
});

// The rollback floor (§1.5; the T-16 pattern, test/deletion-knowledge.test.js:1391). The PR-37a build, loaded from
// history, opens what this build writes and withholds what this build withholds; it refuses a store whose ledger holds
// a record, and writes nothing. The receipt quotes the diagnostic, so a skip for missing history shows as a missing
// receipt line, never as a pass.
for (const [backend, options] of BACKENDS) test(`PR-37c rollback floor ${backend}: the 210f009 build opens the stores and ledgers this build writes, keeps withheld what they withhold, refuses a ledger with a record, and writes nothing`, options, async (t) => {
  let tree;
  try { tree = execFileSync('git', ['ls-tree', '-r', '--name-only', '210f009', 'src'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n'); } catch { tree = null; }
  if (!tree) { t.skip('the history does not hold 210f009'); return; }
  const root = await scratchDirectory(t, 'restore-wrapper-floor-');
  for (const path of tree) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), execFileSync('git', ['show', `210f009:${path}`]));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const floor = (path) => import(pathToFileURL(join(root, 'src', path)).href);
  const [{ createShadowGraph: floorGraph }, { createStorage: floorStorage }, { validateRestorePayload: floorValidate }] = await Promise.all([floor('shadowgraph.js'), floor('storage.js'), floor('restore-validation.js')]);
  const floorLoad = async (state) => {
    const store = await floorStorage({ type: backend, file: state.file });
    try { return await store.load(); } finally { store.close?.(); }
  };
  let opened = 0;
  // Each store as this build leaves it, with the ids it withholds and the ids it shows.
  const opens = async (label, state, withheld, shown) => {
    const before = await hashes(state);
    const graph = floorGraph({ now: () => NOW });
    graph.importData(await floorLoad(state));
    opened += 1;
    const live = new Set([...graph.exportData({ project: 'p' }).records, ...graph.exportData({ project: 'q' }).records, ...graph.exportData({ project: 'r' }).records].map((item) => item.id));
    assert.deepEqual(withheld.filter((id) => live.has(id)), [], `${label}: withheld at the floor too`);
    assert.deepEqual(shown.filter((id) => !live.has(id)), [], `${label}: shown at the floor`);
    assert.deepEqual(graph.validate().issues.filter((issue) => issue.severity === 'error'), [], `${label}: valid`);
    // A hard splice leaves gaps a rebuild declines here too (validate reports them as journal_gap info): the floor's
    // verdict is this build's.
    const verdict = (rebuilt) => [rebuilt.rebuildable, rebuilt.reason];
    assert.deepEqual(verdict(graph.rebuild({})), verdict(graphOf(await stored(state)).rebuild({})), `${label}: the same rebuild verdict`);
    const payload = await stored(state);
    assert.doesNotThrow(() => floorValidate(payload), `${label}: rebuild parity`);
    assert.deepEqual(await hashes(state), before, `${label}: the floor wrote nothing`);
  };
  // Lifted and quarantine: D's own marker lifted, B's p material quarantined, by token and by an
  // entity.token_assigned assignment, under a restore.reapplied entry.
  const b = backup();
  const quarantined = await storeOf(t, backend, purgedStore('logical'));
  await restoring(quarantined, await storeOf(t, backend, b.payload));
  assert.equal(typeCount(await stored(quarantined), 'entity.token_assigned'), 1);
  await opens('lifted and quarantine', quarantined, [b.ids.hidden, b.ids.memory, b.ids.legacy], [b.ids.kept]);
  // Merged: a sidecar tombstone merged into D's ledger, its item removed.
  const merged = await storeOf(t, backend, ownStore());
  const mergedFrom = backup();
  await restoring(merged, await backupOf(t, backend, mergedFrom.payload, { version: 1, tombstones: [itemTombstone([mergedFrom.tokens.hidden])] }));
  await opens('merged', merged, [mergedFrom.ids.hidden], [mergedFrom.ids.memory, mergedFrom.ids.legacy, mergedFrom.ids.kept]);
  // A hard re-application: restore.reapplied with splices, the gaps it explains.
  const fixture = movedAndQuarantined();
  const spliced = await storeOf(t, backend, fixture.d);
  await restoring(spliced, await backupOf(t, backend, fixture.b, fixture.sidecar));
  assert.ok((await stored(spliced)).journal.find((item) => item.type === 'restore.reapplied').payload.spliced > 0);
  await opens('hard re-application', spliced, [fixture.ids.held, fixture.ids.purged], [fixture.ids.moved, fixture.ids.kept]);
  // A scrubbed possibleDuplicateOf history, and capture sessions with startedAt.
  const capturing = createShadowGraph({ now: () => NOW });
  const source = { event: 'UserPromptSubmit', sessionId: 'session-1', role: 'user' };
  const first = privilegedRecordCapture(capturing, { project: 'p', originId: 'origin-a', text: `capture ${SENTINEL}`, admission: ADMISSION, source });
  const second = privilegedRecordCapture(capturing, { project: 'p', originId: 'origin-a', text: `capture ${SENTINEL}`, admission: ADMISSION, source });
  const captures = privilegedSnapshot(capturing);
  const scrubbed = await storeOf(t, backend, ownStore());
  await writeLedgerFile(scrubbed, { version: 1, tombstones: [itemTombstone([tokenOf(captures, first.id)])] });
  await restoring(scrubbed, await storeOf(t, backend, captures));
  const after = await stored(scrubbed);
  assert.equal(after.records.find((item) => item.id === second.id).possibleDuplicateOf, null);
  assert.equal(after.captureSessions.length > 0 && after.captureSessions.every((session) => !Number.isNaN(Date.parse(session.startedAt))), true, 'sessions carry startedAt');
  await opens('scrubbed possibleDuplicateOf, sessions with startedAt', scrubbed, [first.id], []);
  // A ledger with a record: refused, and nothing written.
  const pending = await storeOf(t, backend, b.payload);
  await withRecord(pending, record(identityOf(await stored(pending)), 'committed'));
  const before = await hashes(pending);
  await assert.rejects(floorLoad(pending), { code: PENDING });
  assert.deepEqual(await hashes(pending), before, 'the refusal wrote nothing');
  t.diagnostic(`floor 210f009: ${opened} stores opened`);
});

// ---------------------------------------------------------------------------
// The consolidated review (briefs/PR37c-review.md): a test for each finding, each red before its fix, and one for each
// mutant that survived the staged suite (X-..., scratch/pr37c_mutants.py).
// ---------------------------------------------------------------------------

// An alias of a store file's own name, or null where the volume or the process cannot give one.
const fileAlias = (kind, file) => (kind === '8.3 file name' ? shortName(file) : fileLink(file, join(dirname(file), `link-${basename(file)}`)));
const ALIAS_KINDS = [
  ['symbolic link to the file', 'this process may not make symbolic links'],
  ['8.3 file name', process.platform === 'win32' ? 'the volume keeps no 8.3 names' : '8.3 names are win32 only']
];
// The names in a store's folder, less the side files SQLite keeps beside an open database.
const namesIn = async (state) => (await readdir(state.dir)).filter((name) => !/-(?:wal|shm|journal)$/.test(name)).sort();

// Finding 1: both primitives rename over the name they are given, which replaces a symbolic link with a file of its
// own, or leaves the file under its 8.3 name, either way away from the ledger beside the store's final name; the
// restore reported success with the purged material back. Such a destination now refuses before any write.
for (const [backend, options] of BACKENDS) for (const [kind, missing] of ALIAS_KINDS) test(`PR-37c review 1 ${backend}: a restore through an alias of D's file name (${kind}) refuses before any write, naming no path, and the alias stays as it was (X-alias-restore)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  const source = await storeOf(t, backend, b.payload);
  const alias = await fileAlias(kind, state.file);
  if (!alias) {
    t.diagnostic(`review 1: ${kind} variant skipped: ${missing}`);
    t.skip(missing);
    return;
  }
  // A link may also keep the store file's own name, in another folder: only lstat tells it apart.
  const aliases = [alias];
  if (kind !== '8.3 file name') {
    const elsewhere = await scratchDirectory(t, 'restore-wrapper-alias-');
    aliases.push(await fileLink(state.file, join(elsewhere, basename(state.file))));
  }
  for (const path of aliases) {
    const before = [await hashes(state), await namesIn(state)];
    const restore = async () => {
      if (backend === 'json') return restoreFile(source.file, path);
      const store = await createStorage({ type: 'sqlite', file: path });
      try { return await store.restore(source.file); } finally { store.close(); }
    };
    await assert.rejects(restore(), (error) => error.code === PURGE_AWARE && !error.message.includes(basename(path)) && !error.message.includes(state.dir), path);
    assert.deepEqual([await hashes(state), await namesIn(state)], before, `${path}: nothing written`);
    if (kind !== '8.3 file name') assert.equal((await lstat(path)).isSymbolicLink(), true, `${path}: the link is still a link`);
    assert.equal(graphOf(await load({ ...state, file: path })).exportData({ project: 'p' }).records.length, 0, `${path}: the purge holds through the alias`);
  }
});

// Re-review N-1: where no deletion record reaches the restore, an alias of the store file's own name is no reason to
// refuse; the restore is the primitive alone (T-10 at the verb level).
for (const [backend, options] of BACKENDS) for (const [kind, missing] of ALIAS_KINDS) test(`PR-37c re-review N-1 ${backend}: a restore through an alias of D's file name (${kind}) that no deletion record reaches proceeds as the primitive alone, writing no ledger`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, ownStore());
  const source = await storeOf(t, backend, b.payload);
  const alias = await fileAlias(kind, state.file);
  if (!alias) {
    t.diagnostic(`re-review N-1: ${kind} variant skipped: ${missing}`);
    t.skip(missing);
    return;
  }
  const restore = async () => {
    if (backend === 'json') return restoreFile(source.file, alias);
    const store = await createStorage({ type: 'sqlite', file: alias });
    try { return await store.restore(source.file); } finally { store.close(); }
  };
  assert.equal((await restore()).deletionKnowledge, 'none');
  assert.deepEqual((await readdir(state.dir)).filter((name) => name.toLowerCase().endsWith('.control.json')), [], 'no ledger');
  const restored = graphOf(await load({ ...state, file: alias })).exportData({ project: 'p' }).records.map((item) => item.id).sort();
  assert.deepEqual(restored, b.payload.records.filter((item) => item.project === 'p').map((item) => item.id).sort(), 'the backup\'s memory, as the primitive installs it');
});

// Re-review N-3: a JSON save now writes the file an alias names, so the capture ceiling measures that file and its
// temporary files, not the alias.
for (const [kind, missing] of ALIAS_KINDS) test(`PR-37c re-review N-3: the capture ceiling measures the store a save writes, through an alias of its file name (${kind})`, async (t) => {
  const directory = await scratchDirectory(t, 'restore-wrapper-footprint-');
  const file = join(directory, 'capture-store.json');
  await writeFile(file, 'x'.repeat(100));
  await writeFile(join(directory, '.capture-store.json.1.2.tmp'), 'y'.repeat(50));
  const alias = await fileAlias(kind, file);
  if (!alias) {
    t.diagnostic(`re-review N-3: ${kind} variant skipped: ${missing}`);
    t.skip(missing);
    return;
  }
  assert.equal(await storeFootprint(alias), 150);
});

// Finding 1, its defence (§12.3): a record the post-step cannot find beside the store is never reported as a success,
// and the caller keeps the activation the hook gave it (re-review N-2).
for (const [backend, options] of BACKENDS) test(`PR-37c review 1 defence ${backend}: a restore whose record is no longer beside the store when its post-step runs fails, and never activates the caller again with what a load would no longer suppress (X-missing-record)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, purgedStore('logical'));
  const restoreFault = async (stage) => { if (stage === 'beforePostStep') await rename(knowledge.ledgerPath(state.file), join(state.dir, 'moved-away.json')); };
  let activations = 0;
  await assert.rejects(restoring(state, await storeOf(t, backend, b.payload), { afterReplace: () => { activations += 1; } }, { restoreFault }), { code: PURGE_AWARE });
  assert.equal(activations, 1, 'only the post-step activation the hook gave');
});

// Finding 3: a JSON save renamed over the name it was given: through a symbolic link it replaced the link with a store
// of its own, and through the 8.3 name it left the file under that name, each away from its ledger, so what a restore
// quarantined was shown again. It now writes over the store's final name.
const ALIAS_SAVES = [
  ['symbolic link to the file', process.platform === 'win32' ? 'POSIX: symbolic links to files need a privilege on win32' : false],
  ['8.3 file name', process.platform === 'win32' ? false : '8.3 names are win32 only']
];
for (const [kind, skip] of ALIAS_SAVES) test(`PR-37c review 3 json: after a quarantining restore, a save through an alias of the store file's own name (${kind}) writes over its final name: the alias stays as it was and the quarantined material stays hidden through every name (X-alias-save)`, { skip }, async (t) => {
  const { state, b } = await quarantinedStore(t, 'json');
  const alias = await fileAlias(kind, state.file);
  if (!alias) {
    const missing = kind === '8.3 file name' ? 'the volume keeps no 8.3 names' : 'this process may not make symbolic links';
    t.diagnostic(`review 3: ${kind} variant skipped: ${missing}`);
    t.skip(missing);
    return;
  }
  const held = [b.ids.hidden, b.ids.memory, b.ids.legacy];
  const store = createJsonFileStore(alias);
  const graph = graphOf(await store.load());
  const live = privilegedLiveSnapshot(graph);
  assert.deepEqual(held.filter((id) => live.records.some((item) => item.id === id)), [], 'held through the alias before the save');
  graph.addDecision({ project: 'q', title: 'q later', chosen: 'l' });
  await store.save(privilegedSnapshot(graph));
  const names = (await readdir(state.dir)).map((name) => name.toLowerCase());
  assert.ok(names.includes(basename(state.file).toLowerCase()), 'the store keeps its own name');
  if (kind === '8.3 file name') assert.equal(names.includes(basename(alias).toLowerCase()), false, 'no file is left under the 8.3 name');
  else assert.equal((await lstat(alias)).isSymbolicLink(), true, 'the link is still a link');
  assert.ok((await stored(state)).records.some((item) => item.title === 'q later'), 'the save reached the store');
  for (const name of [state.file, alias].filter((path) => existsSync(path))) {
    const seen = visible(await load({ ...state, file: name }));
    assert.deepEqual(held.filter((id) => seen.has(id)), [], name === state.file ? 'D\'s own name' : 'the alias');
  }
  assert.equal(quarantineTokens(await ledgerOf(state)).has(b.tokens.hidden), true, 'the ledger is the store\'s still');
});

// Finding 4: §4.5's move-in clauses, each through a real logical purge of p in D. B's material outside p is
// tokenless, so only the lifted marker's move-in decides whether it is withheld. `x` is that material.
function moveInCase(clause) {
  const tokenless = (payload, id) => strip(payload, id, 'erasureToken');
  if (clause === 'R5 L0 VS1 fork') {
    // B' is a fork of D taken while x was in r; D then moved x into p and purged p; B' went on alone, so descent is
    // not proven and the attribution, in D's journal only, is what reaches x.
    const graph = createShadowGraph({ now: () => NOW });
    const x = graph.addDecision({ project: 'r', title: `x ${SENTINEL}`, chosen: 'x' });
    graph.addDecision({ project: 'p', title: 'p own', chosen: 'p' });
    const fork = tokenless(privilegedSnapshot(graph), x.id);
    const d = graphOf(structuredClone(fork));
    d.attribute({ ids: [x.id], targetProject: 'p', reason: 'Explicit move' });
    d.purgeProject('p', { mode: 'logical' });
    const b = graphOf(structuredClone(fork));
    b.addDecision({ project: 'q', title: 'only in the fork', chosen: 'f' });
    return { d: privilegedSnapshot(d), b: tokenless(privilegedSnapshot(b), x.id), x: x.id, moveIn: 'some' };
  }
  // D: p written and purged, of a lineage of its own.
  const d = createShadowGraph({ now: () => NOW });
  if (clause === 'baseline before the marker') {
    const old = createShadowGraph({ now: () => NOW });
    old.addDecision({ project: 'q', title: 'old', chosen: 'o' });
    d.importData({ ...privilegedSnapshot(old), events: [], journal: [], journalSeq: 0, journalEpoch: null });
  }
  d.addDecision({ project: 'p', title: 'd own', chosen: 'o' });
  const gone = d.addDecision({ project: 'q', title: 'd q', chosen: 'q' });
  d.purgeProject('p', { mode: 'logical' });
  const destination = privilegedSnapshot(d);
  if (clause === 'gap before the marker') {
    // q's decision and its one entry taken out: the journal is no longer whole from its epoch up to the marker.
    const marker = destination.journal.find((entry) => entry.type === 'project.purged');
    const hole = destination.journal.find((entry) => entry.entityId === gone.id);
    assert.ok(hole.seq > destination.journalEpoch && hole.seq < marker.seq);
    destination.journal = destination.journal.filter((entry) => entry !== hole);
    destination.records = destination.records.filter((item) => item.id !== gone.id);
  }
  // B: tokenless material in r; in the B-journal case, another r decision moved into p in B's journal only.
  const b = createShadowGraph({ now: () => NOW });
  const x = b.addDecision({ project: 'r', title: `x ${SENTINEL}`, chosen: 'x' });
  if (clause === 'attribution in B\'s journal only') {
    const moved = b.addDecision({ project: 'r', title: 'moved', chosen: 'm' });
    b.attribute({ ids: [moved.id], targetProject: 'p', reason: 'Explicit move' });
  }
  return { d: destination, b: tokenless(privilegedSnapshot(b), x.id), x: x.id, moveIn: clause === 'attribution in B\'s journal only' ? 'some' : 'unknown' };
}

const MOVE_IN_CLAUSES = { 'R5 L0 VS1 fork': 'X-movein-never-some', 'gap before the marker': 'X-movein-gap', 'baseline before the marker': 'X-movein-baseline', 'attribution in B\'s journal only': 'X-movein-b-journal' };
for (const [backend, options] of BACKENDS) test(`PR-37c review 4 ${backend}: a lifted logical marker's move-in is read from the journals -- some when D's (the R5 L0 VS1 fork) or B's attributes into p, unknown after a gap or a baseline -- and the material it may have moved in is quarantined (${Object.values(MOVE_IN_CLAUSES).join(', ')})`, options, async (t) => {
  for (const clause of Object.keys(MOVE_IN_CLAUSES)) {
    const fixture = moveInCase(clause);
    const state = await storeOf(t, backend, fixture.d);
    const result = await restoring(state, await storeOf(t, backend, fixture.b));
    assert.equal(result.deletionKnowledge, 'present', clause);
    const ledger = await ledgerOf(state);
    assert.deepEqual(ledger.tombstones.map((item) => [item.purgedProject, item.mode, item.tokens, item.moveIn]), [['p', 'logical', null, fixture.moveIn]], clause);
    assert.equal(quarantineTokens(ledger).has(tokenOf(await stored(state), fixture.x)), true, `${clause}: quarantined by an assigned token`);
    assert.equal(visible(await load(state)).has(fixture.x), false, `${clause}: possibly moved in, so never shown`);
  }
});

// Finding 5: rule 1's mode when a tombstone names the token itself (§6.3, rev6:367): hard, a missing mode included.
for (const [backend, options] of BACKENDS) test(`PR-37c review 5 ${backend}: a hard tombstone naming a token B holds -- in B's sidecar, the registry or D's ledger -- splices the item out with no skeleton, and so does one with no mode (X-token-mode-logical)`, options, async (t) => {
  for (const where of ['sidecar', 'registry', 'ledger']) for (const mode of ['hard', undefined]) {
    const label = `${where}, mode ${mode ?? 'missing'}`;
    const b = backup();
    const tombstone = { kind: 'item', ...(mode ? { mode } : {}), at: TOMBSTONE_AT, tokens: [b.tokens.hidden], moveIn: 'none' };
    const dir = await scratchDirectory(t, 'restore-wrapper-token-mode-');
    const env = { ...process.env, SHADOWGRAPH_HOME: join(dir, 'home') };
    await mkdir(env.SHADOWGRAPH_HOME);
    if (where === 'registry') await writeFile(knowledge.registryFile(env), JSON.stringify({ version: 1, tombstones: [tombstone] }));
    const source = await backupOf(t, backend, b.payload, where === 'sidecar' ? { version: 1, tombstones: [tombstone] } : undefined);
    const state = where === 'ledger' ? await storeOf(t, backend, ownStore()) : await freshOf(t, backend);
    if (where === 'ledger') await writeLedgerFile(state, { version: 1, tombstones: [tombstone] });
    const result = await restoring(state, source, {}, { env });
    assert.deepEqual([result.reapplied.removed, result.reapplied.skeletons, result.reapplied.spliced > 0], [1, 0, true], label);
    const after = await stored(state);
    assert.equal(JSON.stringify(after).includes(b.ids.hidden), false, `${label}: spliced, no skeleton`);
    assert.deepEqual(after.journal.filter((entry) => entry.type === 'restore.reapplied').map((entry) => entry.payload.mode), ['hard'], label);
  }
});

// Finding 6: the downgrade's flag carried in B's sidecar (§4.3, §4.7). With nothing else merged it is the one thing a
// restore may still write (§4.6, review finding 2).
for (const [backend, options] of BACKENDS) test(`PR-37c review 6 ${backend}: a downgrade flag in B's sidecar is carried: into a fresh path D's ledger is its version and the flag alone and no knowledge is reported; beside D's move-in-some tombstone it disables the token proof in that very restore (X-stripped-carried, X-stripped-commit)`, options, async (t) => {
  const b = backup();
  const flag = { at: BEFORE };
  const fresh = await freshOf(t, backend);
  const result = await restoring(fresh, await backupOf(t, backend, b.payload, { version: 1, tokensStripped: flag }));
  assert.equal(result.deletionKnowledge, 'none', 'M and Q are empty');
  assert.deepEqual(await ledgerOf(fresh), { version: 1, tokensStripped: flag });
  assert.equal(typeCount(await stored(fresh), 'restore.reapplied'), 0, 'the plan is empty');
  const state = await storeOf(t, backend, ownStore());
  await writeLedgerFile(state, { version: 1, tombstones: [foreign()] });
  await restoring(state, await backupOf(t, backend, b.payload, { version: 1, tokensStripped: flag }));
  const ledger = await ledgerOf(state);
  assert.deepEqual(ledger.tokensStripped, flag);
  assert.equal(quarantineTokens(ledger).has(tokenOf(b.payload, b.ids.kept)), true, 'tokened at its creation, yet quarantined: the flag disables the proof');
  assert.equal(visible(await load(state)).has(b.ids.kept), false);
});

// Finding 7: with nothing to add no record is written, and the caller's copy still carries D's ledger's view (§7).
for (const [backend, options] of BACKENDS) test(`PR-37c review 7 ${backend}: a restore with nothing to add still hands its caller D's ledger's view, so a graph its afterReplace feeds never shows what D quarantines (X-activation-noview)`, options, async (t) => {
  const b = backup();
  const state = await storeOf(t, backend, ownStore());
  await writeLedgerFile(state, { version: 1, quarantine: [{ token: b.tokens.hidden, at: NOW }] });
  const ledger = await readFile(knowledge.ledgerPath(state.file));
  const graph = createShadowGraph({ now: () => NOW });
  const result = await restoring(state, await storeOf(t, backend, b.payload), { afterReplace: (payload) => graph.replaceData(payload) });
  assert.deepEqual([result.deletionKnowledge, result.reapplied], ['present', ZERO]);
  assert.deepEqual(await readFile(knowledge.ledgerPath(state.file)), ledger, 'no record was written');
  const live = new Set(privilegedLiveSnapshot(graph).records.map((item) => item.id));
  assert.deepEqual([live.has(b.ids.hidden), live.has(b.ids.kept)], [false, true]);
});

// Finding 8: a quarantine call with no terminal is refused before its selection is read, so the refusal says nothing
// of what is quarantined and resolves no record (§9.1).
for (const [backend, options] of BACKENDS) test(`PR-37c review 8 quarantine CLI ${backend}: without a terminal a release gives one refusal for a quarantined, a visible and an unknown id, and no refused call writes, a crash-left record included (X-quarantine-tty)`, options, async (t) => {
  const quarantineCli = (state, args) => execute(process.execPath, [cliPath, 'quarantine', ...args], { cwd: state.dir, env: { ...process.env, SHADOWGRAPH_FILE: state.file, SHADOWGRAPH_STORAGE: backend } }).then(() => ({ code: 0, stderr: '' }), (error) => error);
  const refused = (run, label) => {
    assert.equal(run.code, 1, label);
    assert.match(run.stderr, new RegExp(OWNER_CONFIRMATION), label);
    assert.doesNotMatch(run.stderr, new RegExp(NOT_QUARANTINED), label);
  };
  const { state, b } = await quarantinedStore(t, backend);
  const before = await hashes(state);
  for (const id of [b.ids.hidden, b.ids.kept, 'decision_not_in_this_store']) refused(await quarantineCli(state, ['release', JSON.stringify({ ids: [id] })]), id);
  assert.deepEqual(await hashes(state), before);
  const crashed = await storeOf(t, backend, purgedStore('logical'));
  const result = await restoring(crashed, await storeOf(t, backend, b.payload), {}, { restoreFault: (stage) => { if (stage === 'beforePostStep') throw new Error('a crash before the post-step'); } });
  assert.equal(result.completion, 'pending');
  const waiting = await hashes(crashed);
  for (const args of [['list'], ['release', JSON.stringify({ ids: [b.ids.hidden] })], ['purge', JSON.stringify({ project: 'p' })]]) refused(await quarantineCli(crashed, args), args[0]);
  assert.deepEqual(await hashes(crashed), waiting, 'the record is resolved by no refused call');
  assert.equal((await ledgerOf(crashed)).pending.length, 1);
});

// Finding 11: a registry tombstone B postdates by its lineage's marker id (§4.3, V-19).
for (const [backend, options] of BACKENDS) test(`PR-37c review 11 ${backend}: a registry tombstone whose markerEntryId is B's own purge marker is one B postdates: it still removes by token, and B's tokenless p material made after that purge stays visible (X-anchor-postdated)`, options, async (t) => {
  const graph = createShadowGraph({ now: () => NOW });
  const purged = graph.addDecision({ project: 'p', title: `purged ${SENTINEL}`, chosen: 'x' });
  const token = tokenOf(privilegedSnapshot(graph), purged.id);
  graph.purgeProject('p', { mode: 'logical' });
  const later = graph.addDecision({ project: 'p', title: 'made after the purge', chosen: 'y' });
  const payload = strip(privilegedSnapshot(graph), later.id, 'erasureToken');
  const marker = payload.journal.find((entry) => entry.type === 'project.purged');
  const epoch = payload.journal.find((entry) => entry.seq === payload.journalEpoch).id;
  const dir = await scratchDirectory(t, 'restore-wrapper-anchor-');
  const env = { ...process.env, SHADOWGRAPH_HOME: join(dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME);
  const tombstone = { kind: 'project', purgedProject: 'p', mode: 'logical', at: marker.at, seq: marker.seq, tokens: [token], moveIn: 'none' };
  await writeFile(knowledge.registryFile(env), JSON.stringify({ version: 1, tombstones: [{ ...tombstone, lineage: { epochEntryId: epoch, markerEntryId: marker.id } }] }));
  const state = await freshOf(t, backend);
  const result = await restoring(state, await storeOf(t, backend, payload), {}, { env });
  assert.deepEqual([result.deletionKnowledge, result.reapplied.quarantined], ['present', 0]);
  assert.deepEqual((await ledgerOf(state)).tombstones, [tombstone], 'merged, without its lineage');
  assert.equal(visible(await load(state)).has(later.id), true, 'made after the purge B records');
});

// Finding 11: step 0 of each restore entry, and the JSON backup's resolution, after a post-step crash (§3.3, §3.4,
// §8.4).
for (const [backend, options] of BACKENDS) test(`PR-37c review 11 step 0 ${backend}: after a post-step crash the next restore resolves the record first and proceeds, and a JSON backup resolves it and copies no record (X-json-step0, X-json-backup-resolve)`, options, async (t) => {
  const b = backup();
  const crash = (stage) => { if (stage === 'postStepLedgerWritten') throw new Error('a crash after ledger step 1'); };
  const source = await storeOf(t, backend, b.payload);
  const state = await storeOf(t, backend, purgedStore('logical'));
  assert.equal((await restoring(state, source, {}, { restoreFault: crash })).completion, 'pending');
  assert.equal((await ledgerOf(state)).pending.length, 1);
  const again = await restoring(state, source);
  assert.deepEqual([again.deletionKnowledge, again.completion], ['present', undefined]);
  assert.equal(Object.hasOwn(await ledgerOf(state), 'pending'), false);
  assert.equal(visible(await load(state)).has(b.ids.legacy), false);
  if (backend !== 'json') return;
  const copied = await storeOf(t, 'json', purgedStore('logical'));
  assert.equal((await restoring(copied, source, {}, { restoreFault: crash })).completion, 'pending');
  const copy = join(copied.dir, 'copy.json');
  await backupFile(copied.file, copy);
  assert.equal(Object.hasOwn(await ledgerOf(copied), 'pending'), false, 'resolved before the copy');
  assert.equal(Object.hasOwn(JSON.parse(await readFile(knowledge.ledgerPath(copy), 'utf8')), 'pending'), false, 'no record is copied');
});

// Finding 11: the verifier MCP and HTTP pass to the restore, with which the post-step's staging graph keeps a
// verified fact verified (§3.3, §6.4). The fixture is the one test/eighth-review-baseline-regressions.test.js builds,
// at instants before the real clock the restore reads.
async function verifiedFixture(dir) {
  const keys = generateKeyPairSync('ed25519');
  const evidenceRoot = join(dir, 'evidence');
  await mkdir(evidenceRoot, { recursive: true });
  const verifier = createLocalEvidenceVerifier({ allowedEvidenceRoot: evidenceRoot, trustedVerifiers: { approver: keys.publicKey } });
  const configPath = join(dir, 'verifier.json');
  await writeFile(configPath, JSON.stringify({ allowedEvidenceRoot: evidenceRoot, trustedVerifiers: { approver: keys.publicKey.export({ type: 'spki', format: 'pem' }) } }));
  const [created, verifiedAt] = [2, 1].map((hours) => new Date(Date.now() - hours * 3_600_000).toISOString());
  const graph = createShadowGraph({ verifier, now: () => created });
  const erased = graph.addDecision({ project: 'p', title: 'erased', chosen: 'e' });
  const fact = graph.addFact({ project: 'q', key: 'signed', value: { signed: true }, expiresAt: '2099-01-01T00:00:00.000Z' });
  const evidencePath = join(evidenceRoot, `${fact.id}.json`);
  await writeFile(evidencePath, JSON.stringify(createFactAttestation({ fact, verifierIdentity: 'approver', evidenceReference: `ticket:${fact.id}`, verifiedAt, privateKey: keys.privateKey })));
  await graph.verifyFact({ project: 'q', factId: fact.id, evidencePath });
  const payload = privilegedSnapshot(graph);
  assert.equal(payload.facts.find((item) => item.id === fact.id).verificationStatus, 'verified');
  return { verifier, configPath, payload, fact: fact.id, token: tokenOf(payload, erased.id) };
}

for (const [backend, options] of BACKENDS) test(`PR-37c review 11 verifier ${backend}: an MCP and an HTTP restore that a deletion record reaches keep a verified fact verified, with the verifier each is configured with (X-verifier-mcp, X-verifier-server)`, options, async (t) => {
  for (const entry of ['mcp', 'http']) {
    const fixture = await verifiedFixture(await scratchDirectory(t, 'restore-wrapper-verifier-'));
    const source = await backupOf(t, backend, fixture.payload, { version: 1, tombstones: [itemTombstone([fixture.token])] });
    const state = await freshOf(t, backend);
    let result;
    if (entry === 'mcp') {
      const [text] = await mcpCalls(t, state, [['shadowgraph_restore', { source: source.file }]], { SHADOWGRAPH_VERIFIER_CONFIG: fixture.configPath });
      result = JSON.parse(text).result.structuredContent;
    } else {
      const app = await createShadowGraphServer({ file: state.file, storage: backend, cwd: state.dir, apiToken: '', verifier: fixture.verifier });
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      try {
        const response = await fetch(`http://127.0.0.1:${app.server.address().port}/restore`, { method: 'POST', body: JSON.stringify({ source: source.file }) });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        result = JSON.parse(text);
      } finally { await new Promise((done) => app.server.close(done)); }
    }
    assert.equal(result.reapplied.removed, 1, `${entry}: the post-step wrote its payload`);
    const fact = (await stored(state)).facts.find((item) => item.id === fixture.fact);
    assert.deepEqual([fact.verificationStatus, fact.verificationUntrustedReason], ['verified', undefined], entry);
  }
});

// ---------------------------------------------------------------------------
// Isolation (§13.2, §13.3).
// ---------------------------------------------------------------------------

// The scratch directory is under the home on Windows, so the guard checks the owner's own ShadowGraph folder.
test('PR-37c isolation: no test resolves the deletion registry under the owner\'s home', () => {
  const file = knowledge.registryFile();
  assert.ok(file, 'SHADOWGRAPH_HOME resolves');
  assert.ok(isAbsolute(process.env.SHADOWGRAPH_HOME));
  const inside = relative(join(userInfo().homedir, '.shadowgraph'), file);
  assert.ok(inside.startsWith('..') || isAbsolute(inside), 'the registry is not the owner\'s');
});

after(() => assert.equal(existsSync(knowledge.registryFile()), false, 'nothing wrote the process-wide registry'));
