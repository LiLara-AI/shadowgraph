// PR-37c: T-10, the R16 restore suite with the restore wrapper around it (briefs/PR37c-design.md §13.1, §13.2).
// The primitives stay byte for byte as they were (the region hash); pr12's own two suites run unchanged against the
// primitives alone (their .mjs copies, below); and every case of pr12's authority table runs through every restore
// entry with no deletion knowledge, with unrelated knowledge, and with an unrelated registry, each compared with a
// primitive-only twin. Each test makes its own ShadowGraph home under its scratch directory.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { createSqliteStore, exportSqlitePayload } from '../src/sqlite-storage.js';
import { backupFile, restoreFile, restoreJsonPrimitive } from '../src/backup.js';
import { buildToolCatalog } from '../src/mcp-tools.js';
import { createShadowGraphServer } from '../src/server.js';
import { getRuntimeCapabilities } from '../src/runtime-capabilities.js';
import { privilegedLiveSnapshot, privilegedSnapshot } from '../src/internal/snapshot.js';
import { ledgerPath, registryFile } from '../src/internal/deletion-knowledge.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const NOW = '2026-09-26T12:00:00.000Z';
const sqlite = (await getRuntimeCapabilities()).nodeSqlite;
const SQLITE = sqlite.available ? {} : { skip: sqlite.reason };
const BACKENDS = [['json', {}], ['sqlite', SQLITE]];
const execute = promisify(execFile);
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const testRoot = new URL('./', import.meta.url);
const repoRoot = new URL('../', import.meta.url);
const cliPath = fileURLToPath(new URL('src/cli.js', repoRoot));
const mcpPath = fileURLToPath(new URL('src/mcp.js', repoRoot));
const RESTORE_SCHEMA = buildToolCatalog().find((entry) => entry.name === 'shadowgraph_restore').outputSchema;

// ---------------------------------------------------------------------------
// The primitive-only runs of both pr12 files (§13.1, research G-13). Each is copied as .mjs into a scratch directory
// (a .js file there has no "type": "module") with its `restoreFile` binding taken from the JSON primitive and every
// relative specifier, static and dynamic, made absolute; the pr12 files themselves are never edited (rev6:587).
// Importing a copy registers its own tests in this run; the raw `createSqliteStore(...).restore` they use on SQLite
// is the primitive already.
// ---------------------------------------------------------------------------

const SPECIFIER = /(\bfrom\s*|\bimport\s*\(\s*)'([^']*)'/g;
const BINDING = /import\s*\{([^}]*)\}\s*from\s*'([^']*)'/g;
const PRIMITIVE_BINDING = 'restoreJsonPrimitive as restoreFile';
// Made, and the copies imported, before any test is registered: a root `after` hook, or one a test registers,
// runs as soon as the tests registered so far have finished, even while this module still awaits.
const copies = mkdtempSync(join(tmpdir(), 'shadowgraph-r16-copies-'));
process.on('exit', () => rmSync(copies, { recursive: true, force: true }));

function primitiveCopy(name, appended = '') {
  const original = readFileSync(new URL(name, testRoot), 'utf8');
  const bindings = [...original.matchAll(BINDING)].filter(([, names]) => names.split(',').some((item) => item.trim() === 'restoreFile'));
  assert.deepEqual(bindings.map(([, , from]) => from), ['../src/backup.js'], `${name} imports restoreFile once, from ../src/backup.js`);
  const absolute = new Map();
  let text = original.replace(SPECIFIER, (all, lead, specifier) => {
    if (!specifier.startsWith('.')) return all;
    const href = new URL(specifier, testRoot).href;
    absolute.set(href, specifier);
    return `${lead}'${href}'`;
  });
  const [[statement, , from]] = bindings;
  const rewritten = statement.replace(`'${from}'`, `'${new URL(from, testRoot).href}'`);
  text = text.replace(rewritten, rewritten.replace(/\brestoreFile\b/, PRIMITIVE_BINDING));
  // The guard: undoing the specifiers and the one binding gives the source back, byte for byte.
  let undone = text.replace(PRIMITIVE_BINDING, 'restoreFile');
  for (const [href, specifier] of absolute) undone = undone.replaceAll(`'${href}'`, `'${specifier}'`);
  assert.equal(undone, original, `${name}: the copy differs only in its specifiers and the restoreFile binding`);
  assert.equal(text.split(PRIMITIVE_BINDING).length, 2, `${name}: one binding rewritten`);
  const path = join(copies, name.replace(/\.js$/, '.mjs'));
  writeFileSync(path, text + appended);
  return { path, text: text + appended };
}

const authorityCopy = primitiveCopy('pr12-authority-restore.test.js', '\nexport { cases, snapshot, entry, subset, memoryRecovered };\n');
const validationCopy = primitiveCopy('pr12-restore-validation.test.js');
const { cases, memoryRecovered } = await import(pathToFileURL(authorityCopy.path).href);
await import(pathToFileURL(validationCopy.path).href);

// ---------------------------------------------------------------------------
// The region hash (§13.1): the two primitive bodies and authority-restore.js, normalised to LF, against the values
// pinned from d9b0003 (the same at 210f009).
// ---------------------------------------------------------------------------

const PINNED = Object.freeze({
  'restoreJsonFileFenced (src/backup.js)': '76a089143ff433b2a5aa4753e87325a443781619eeee28c2e1adc2b1b0d580b6',
  'the SQLite restore method (src/sqlite-storage.js)': 'de18121ed53424f2d2b3895bc9f3d11784d0a90d304942dede2726ced9cd31e5',
  'src/authority-restore.js': '48cb2a55c38fe331e13520246e5f169445bd006a3e95e9509dd5911acd1516a9'
});

const sourceText = (path) => readFileSync(new URL(path, repoRoot), 'utf8').replace(/\r\n/g, '\n');

// From the line that starts with `first` through the first later line that `last` matches.
function region(text, first, last) {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.startsWith(first));
  assert.notEqual(start, -1, first);
  const end = lines.findIndex((line, index) => index > start && last.test(line));
  assert.notEqual(end, -1, `${first}: closing line`);
  return lines.slice(start, end + 1).join('\n');
}

test('PR-37c T-10 region hash: the R16 primitives and the authority merge are byte for byte as at d9b0003', () => {
  const regions = {
    'restoreJsonFileFenced (src/backup.js)': region(sourceText('src/backup.js'), 'async function restoreJsonFileFenced(', /^\}$/),
    'the SQLite restore method (src/sqlite-storage.js)': region(sourceText('src/sqlite-storage.js'), '    async restore(source, restoreOptions = {}) {', /^ {4}\}/),
    'src/authority-restore.js': sourceText('src/authority-restore.js')
  };
  assert.deepEqual(Object.fromEntries(Object.entries(regions).map(([name, text]) => [name, sha256(text)])), PINNED);
});

test('PR-37c T-10 copies: every specifier left in the pr12 copies is absolute, so a module that fails to load is an error, never a silent skip', () => {
  for (const { path, text } of [authorityCopy, validationCopy]) {
    const relative = [...text.matchAll(SPECIFIER)].map(([, , specifier]) => specifier).filter((specifier) => !/^(?:node|file):/.test(specifier));
    assert.deepEqual(relative, [], path);
  }
  assert.equal(cases.length > 0, true);
});

// ---------------------------------------------------------------------------
// T-10 at the verb level (§13.2; rev6:414-415). Every case of pr12's table, through every restore entry, in
// configurations (a) no knowledge, (b) unrelated knowledge in D's ledger and (b, lifted) a real purge of an unrelated
// project in D's journal, and (c) an unrelated registry, each with memoryOnly false and true. No surface takes a
// clock, so each run is compared with a twin: the same pair built again and restored through the primitive at the
// instant of the surface's one access.restored event.
// ---------------------------------------------------------------------------

// Tombstones of a project B does not hold, naming tokens B lacks, with clean move-in evidence (configuration (b)).
const UNRELATED = Object.freeze([
  { kind: 'project', purgedProject: 'zeta', mode: 'logical', at: '2026-09-20T00:00:00.000Z', seq: 98, tokens: ['token-zeta-logical'], moveIn: 'none' },
  { kind: 'project', purgedProject: 'zeta', mode: 'hard', at: '2026-09-20T00:00:00.000Z', seq: 99, tokens: ['token-zeta-hard'], moveIn: 'none' }
]);
const itemTombstone = (tokens) => ({ kind: 'item', mode: 'logical', at: '2026-09-20T00:00:00.000Z', tokens, moveIn: 'none' });
const CONFIGURATIONS = ['a', 'b', 'b lifted', 'c'];
const SURFACES = { json: ['restoreFile', 'cli', 'mcp', 'http'], sqlite: ['./storage', 'cli', 'mcp', 'http'] };

// D with a real logical purge of a project B does not hold: the pre-step lifts its marker with move-in `none`.
function withUnrelatedPurge(destination) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData(structuredClone(destination));
  graph.addDecision({ project: 'zeta', title: 'unrelated', chosen: 'z' });
  graph.purgeProject('zeta', { mode: 'logical' });
  const purged = privilegedSnapshot(graph);
  return { ...structuredClone(destination), journal: purged.journal, journalSeq: purged.journalSeq };
}

// pr12's pair, as persistedPair builds it (pr12-authority-restore:168-188), from one fixture's payloads, in its own
// scratch directory and home, with the configuration's knowledge laid beside it.
async function pairOf(t, backend, built, configuration, registry) {
  const [backup, destination] = [structuredClone(built.backup), structuredClone(built.destination)];
  const dir = await scratchDirectory(t, 'restore-wrapper-r16-');
  const home = join(dir, 'home');
  await mkdir(home);
  const env = { ...process.env, SHADOWGRAPH_HOME: home };
  const extension = backend === 'sqlite' ? 'db' : 'json';
  const [source, saved, target] = ['source', 'backup', 'target'].map((name) => join(dir, `${name}.${extension}`));
  const d = configuration === 'b lifted' ? withUnrelatedPurge(destination) : destination;
  if (backend === 'sqlite') {
    const original = await createSqliteStore(source);
    try { await original.save({ ...backup, revision: (await original.load()).revision }); await original.backup(saved); } finally { original.close(); }
    const store = await createSqliteStore(target);
    try { await store.save({ ...d, revision: (await store.load()).revision }); } finally { store.close(); }
  } else {
    await writeFile(source, JSON.stringify(backup));
    await backupFile(source, saved, { env });
    await writeFile(target, JSON.stringify(d));
  }
  if (configuration.startsWith('b')) await writeFile(ledgerPath(target), JSON.stringify({ version: 1, tombstones: UNRELATED }));
  if (configuration === 'c') await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: [itemTombstone(['token-absent'])] }));
  if (registry) await writeFile(registryFile(env), JSON.stringify({ version: 1, tombstones: registry(backup) }));
  const marker = (d.journal ?? []).find((entry) => entry.type === 'project.purged') ?? null;
  return { dir, home, env, backend, saved, target, backup, marker };
}

const readLedger = (pair) => (existsSync(ledgerPath(pair.target)) ? readFile(ledgerPath(pair.target), 'utf8') : null);
const readRegistry = (pair) => (existsSync(registryFile(pair.env)) ? readFile(registryFile(pair.env), 'utf8') : null);

async function stored({ backend, target }) {
  if (backend === 'json') return JSON.parse(await readFile(target, 'utf8'));
  const { DatabaseSync } = await import('node:sqlite');
  const database = new DatabaseSync(new URL(`${pathToFileURL(target).href}?immutable=1`), { readOnly: true });
  try { return exportSqlitePayload(database); } finally { database.close(); }
}

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

// The ids a read of each project returns, keyed by project.
const PROJECTS = ['alpha', 'beta'];
function visibleIds(payload) {
  const graph = createShadowGraph({ now: () => NOW });
  graph.importData(structuredClone(payload));
  const live = privilegedLiveSnapshot(graph);
  return Object.fromEntries(PROJECTS.map((project) => [project, live.records.filter((item) => item.project === project).map((item) => item.id).sort()]));
}

async function mcpSession(pair) {
  const env = { ...pair.env, SHADOWGRAPH_FILE: pair.target, SHADOWGRAPH_STORAGE: pair.backend, SHADOWGRAPH_API_TOKEN: '', SHADOWGRAPH_MCP_COMPACT: '0', SHADOWGRAPH_EMBEDDING_URL: '', SHADOWGRAPH_VERIFIER_CONFIG: '' };
  const child = spawn(process.execPath, [mcpPath], { cwd: pair.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  child.stdout.setEncoding('utf8');
  let buffer = '';
  const responses = [];
  child.stdout.on('data', (data) => { buffer += data; const lines = buffer.split('\n'); buffer = lines.pop(); responses.push(...lines.filter(Boolean).map((line) => JSON.parse(line))); });
  let id = 0;
  const rpc = async (method, params) => {
    const own = ++id;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: own, method, params })}\n`);
    for (let waited = 0; waited < 30_000; waited += 10) {
      const found = responses.find((item) => item.id === own);
      if (found) return found;
      await delay(10);
    }
    throw new Error('MCP timeout');
  };
  await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
  return { call: (name, args) => rpc('tools/call', { name, arguments: args }), close: async () => { child.kill(); await exited; } };
}

let httpTurn = Promise.resolve();
function oneHttpAtATime(operation) {
  const turn = httpTurn.then(operation);
  httpTurn = turn.catch(() => {});
  return turn;
}

// One restore of the pair through `surface`: its result, the caller activations a spy saw (in-process entries), and
// the ids a later read through the same entry returns (MCP and HTTP).
async function restoreThrough(surface, pair, memoryOnly) {
  if (surface === 'restoreFile' || surface === './storage') {
    const calls = [];
    const options = { memoryOnly, afterReplace: (payload) => { calls.push(payload); } };
    if (surface === 'restoreFile') return { result: await restoreFile(pair.saved, pair.target, { ...options, env: pair.env }), calls };
    const store = await createStorage({ type: 'sqlite', file: pair.target, env: pair.env });
    try { return { result: await store.restore(pair.saved, options), calls }; } finally { store.close(); }
  }
  if (surface === 'cli') {
    const env = { ...pair.env, SHADOWGRAPH_FILE: pair.target, SHADOWGRAPH_STORAGE: pair.backend, SHADOWGRAPH_API_TOKEN: '' };
    const { stdout } = await execute(process.execPath, [cliPath, 'restore', pair.saved, ...(memoryOnly ? ['--memory-only'] : [])], { cwd: pair.dir, env });
    return { result: JSON.parse(stdout) };
  }
  if (surface === 'mcp') {
    const session = await mcpSession(pair);
    try {
      const response = await session.call('shadowgraph_restore', { source: pair.saved, memoryOnly });
      const result = response.result?.structuredContent;
      assert.ok(result && !response.result.isError, JSON.stringify(response));
      assert.deepEqual(schemaErrors(RESTORE_SCHEMA, result), [], JSON.stringify(result));
      const reads = {};
      for (const project of PROJECTS) {
        const found = await session.call('shadowgraph_search', { project, query: '' });
        reads[project] = found.result.structuredContent.items.map((item) => item.record.id).sort();
      }
      return { result, reads };
    } finally { await session.close(); }
  }
  return oneHttpAtATime(async () => {
    // HTTP in process: the server reads the home from process.env, swapped for this run (--test-concurrency=1, and one
    // HTTP run at a time within this file).
    const saved = process.env.SHADOWGRAPH_HOME;
    process.env.SHADOWGRAPH_HOME = pair.home;
    try {
      const app = await createShadowGraphServer({ file: pair.target, storage: pair.backend, cwd: pair.dir, apiToken: '' });
      app.server.listen(0, '127.0.0.1');
      await once(app.server, 'listening');
      try {
        const url = (path) => `http://127.0.0.1:${app.server.address().port}${path}`;
        const response = await fetch(url('/restore'), { method: 'POST', body: JSON.stringify({ source: pair.saved, memoryOnly }) });
        const text = await response.text();
        assert.equal(response.status, 200, text);
        const reads = {};
        for (const project of PROJECTS) reads[project] = (await (await fetch(url(`/records?project=${project}`))).json()).records.map((item) => item.id).sort();
        return { result: JSON.parse(text), reads };
      } finally { await new Promise((done) => app.server.close(done)); }
    } finally { process.env.SHADOWGRAPH_HOME = saved; }
  });
}

// The twin: the same pair, restored through the primitive alone at `now`.
async function twinOf(t, backend, built, configuration, memoryOnly, now) {
  const pair = await pairOf(t, backend, built, configuration);
  const calls = [];
  const options = { memoryOnly, ...(now ? { now } : {}), afterReplace: (payload) => { calls.push(structuredClone(payload)); } };
  if (backend === 'json') await restoreJsonPrimitive(pair.saved, pair.target, options);
  else {
    const store = await createSqliteStore(pair.target);
    try { await store.restore(pair.saved, options); } finally { store.close(); }
  }
  return { payload: await stored(pair), installed: calls };
}

const counted = (payload, type) => (payload.journal ?? []).filter((entry) => entry.type === type).length;

// One surface's run of one case in one configuration, against its own twin.
async function matchesTwin(t, backend, fixture, configuration, memoryOnly, surface) {
  const label = `${configuration} ${surface} memoryOnly=${memoryOnly}`;
  const built = fixture();
  const pair = await pairOf(t, backend, built, configuration);
  const [ledgerBefore, registryBefore] = [await readLedger(pair), await readRegistry(pair)];
  const run = await restoreThrough(surface, pair, memoryOnly);
  const after = await stored(pair);
  const restored = after.events.filter((event) => event.type === 'access.restored');
  assert.equal(restored.length, memoryOnly ? 0 : 1, label);
  const twin = await twinOf(t, backend, built, configuration, memoryOnly, restored[0]?.at);
  assert.deepEqual(after, twin.payload, `${label}: the stored payload is the primitive's`);
  for (const type of ['entity.token_assigned', 'restore.reapplied']) assert.equal(counted(after, type), counted(pair.backup, type), `${label}: no ${type}`);
  // Knowledge on disk: none made in (a) and (c), D's own unchanged in (b), the lifted marker its one addition.
  const ledgerAfter = await readLedger(pair);
  if (configuration === 'a' || configuration === 'c') assert.equal(ledgerAfter, null, `${label}: no ledger`);
  else if (configuration === 'b') assert.equal(ledgerAfter, ledgerBefore, `${label}: D's ledger byte-equal`);
  else {
    const [before, now] = [JSON.parse(ledgerBefore), JSON.parse(ledgerAfter)];
    assert.deepEqual(now.tombstones.slice(0, -1), before.tombstones, label);
    assert.deepEqual(now.tombstones.at(-1), { kind: 'project', purgedProject: 'zeta', mode: 'logical', at: pair.marker.at, seq: pair.marker.seq, tokens: null, moveIn: 'none' }, `${label}: the lifted marker, move-in none (M61)`);
    assert.deepEqual({ ...now, tombstones: before.tombstones }, before, `${label}: nothing else changes`);
  }
  assert.equal(await readRegistry(pair), registryBefore, `${label}: the registry is never written`);
  if (configuration === 'a') assert.equal(registryBefore, null, label);
  // The result.
  assert.equal(run.result.deletionKnowledge, configuration.startsWith('b') ? 'present' : 'none', label);
  if (configuration.startsWith('b')) assert.deepEqual(run.result.reapplied, { removed: 0, quarantined: 0, skeletons: 0, spliced: 0 }, label);
  else assert.equal(Object.hasOwn(run.result, 'reapplied'), false, label);
  assert.equal(Object.hasOwn(run.result, 'completion'), false, label);
  // Per surface: the in-process caller is activated once with what the primitive installs; a later read through
  // the same server returns the twin's records.
  if (run.calls) {
    assert.equal(run.calls.length, 1, `${label}: one activation`);
    assert.deepEqual(run.calls[0], twin.installed[0], `${label}: the twin's installed payload`);
  }
  if (run.reads) assert.deepEqual(run.reads, visibleIds(twin.payload), `${label}: the activation reached the graph`);
}

// The surfaces of one configuration run side by side: each has its own pair, home and twin, every entry but HTTP is
// given its home explicitly, and only the one HTTP run swaps process.env. A failure in any is the test's.
for (const [backend, options] of BACKENDS) for (const [name, fixture] of cases) test(`PR-37c T-10 ${backend}: ${name}, through every restore entry, equals the primitive alone in configurations (a), (b) and (c), memory-only too`, options, async (t) => {
  for (const configuration of CONFIGURATIONS) {
    const runs = [false, true].flatMap((memoryOnly) => SURFACES[backend].map((surface) => [memoryOnly, surface]));
    const settled = await Promise.allSettled(runs.map(([memoryOnly, surface]) => matchesTwin(t, backend, fixture, configuration, memoryOnly, surface)));
    const failed = settled.find((outcome) => outcome.status === 'rejected');
    if (failed) throw failed.reason;
  }
});

// Configuration (c) could pass vacuously if the home never reached a surface: beside it, the same registry holding
// a token tombstone that names a token B holds gives `present` and one removal on every surface.
for (const [backend, options] of BACKENDS) test(`PR-37c T-10 positive control ${backend}: a registry token tombstone naming a token B holds reaches every restore entry through the test's own home`, options, async (t) => {
  const [, fixture] = cases[0];
  const registry = (backup) => [itemTombstone(['token-absent']), itemTombstone([backup.records.find((item) => item.project === 'alpha').erasureToken])];
  for (const memoryOnly of [false, true]) for (const surface of SURFACES[backend]) {
    const label = `${surface} memoryOnly=${memoryOnly}`;
    const pair = await pairOf(t, backend, fixture(), 'a', registry);
    const registryBefore = await readRegistry(pair);
    const alpha = pair.backup.records.find((item) => item.project === 'alpha').id;
    const run = await restoreThrough(surface, pair, memoryOnly);
    assert.equal(run.result.deletionKnowledge, 'present', label);
    assert.equal(run.result.reapplied.removed, 1, label);
    assert.equal(JSON.stringify(await stored(pair)).includes(alpha), false, `${label}: removed`);
    if (run.reads) assert.deepEqual(run.reads.alpha, [], label);
    assert.equal(await readRegistry(pair), registryBefore, `${label}: the registry is never written`);
  }
});

// A no-knowledge restore activates the caller with the backup's memory, in memory as in the store (rev6:426).
for (const [backend, options] of BACKENDS) test(`PR-37c T-10 ${backend}: a no-knowledge restore keeps the backup's memory recovered in the running graph`, options, async (t) => {
  const [, fixture] = cases[0];
  for (const memoryOnly of [false, true]) {
    const pair = await pairOf(t, backend, fixture(), 'a');
    const graph = createShadowGraph({ now: () => NOW });
    graph.importData(await stored(pair));
    const options = { memoryOnly, afterReplace: (payload) => graph.replaceData(payload) };
    if (backend === 'json') await restoreFile(pair.saved, pair.target, { ...options, env: pair.env });
    else {
      const store = await createStorage({ type: 'sqlite', file: pair.target, env: pair.env });
      try { await store.restore(pair.saved, options); } finally { store.close(); }
    }
    memoryRecovered(privilegedSnapshot(graph), pair.backup);
  }
});

// ---------------------------------------------------------------------------
// T-10 where no deletion knowledge reaches (the consolidated review's finding 2; rev6:338-340; R4's correctedFix). S
// held alpha's decisions, one of them tokenless, and beta's; B0 is S's backup; alpha was purged in S and B0 restored
// into S, so S's journal holds restore.reapplied and no purge marker. F is S's payload copied without its ledger: no
// ledger, no sidecar beside B0, an empty registry. B0 restored into F through every entry is the primitive alone --
// the twin's bytes and no ledger -- where the descent rule used to remove alpha's tokenless decision and leave a
// ledger behind while reporting `none`.
// ---------------------------------------------------------------------------

async function reappliedCopy(t, backend, mode) {
  const dir = await scratchDirectory(t, 'restore-wrapper-r16-copy-');
  const env = { ...process.env, SHADOWGRAPH_HOME: join(dir, 'home') };
  await mkdir(env.SHADOWGRAPH_HOME);
  const extension = backend === 'sqlite' ? 'db' : 'json';
  const [store, ancestor, copy] = ['store', 'ancestor', 'copy'].map((name) => join(dir, `${name}.${extension}`));
  const graph = createShadowGraph({ now: () => NOW });
  graph.addDecision({ project: 'alpha', title: 'tokened', chosen: 't' });
  const legacy = graph.addDecision({ project: 'alpha', title: 'legacy', chosen: 'l' });
  graph.addDecision({ project: 'beta', title: 'kept', chosen: 'k' });
  const payload = privilegedSnapshot(graph);
  const strip = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (value.id === legacy.id) delete value.erasureToken;
    Object.values(value).forEach(strip);
  };
  strip(payload);
  const s = await createStorage({ type: backend, file: store, env });
  try {
    await s.save(payload);
    await backupFile(store, ancestor, { env, store: backend === 'sqlite' ? s : undefined });
    const purging = createShadowGraph({ now: () => NOW });
    purging.importData(await s.load());
    purging.purgeProject('alpha', { mode });
    await s.save(privilegedSnapshot(purging));
    if (backend === 'json') await restoreFile(ancestor, store, { env });
    else await s.restore(ancestor);
    await backupFile(store, copy, { env, store: backend === 'sqlite' ? s : undefined });
  } finally { s.close?.(); }
  const made = { backend, ancestor: await readFile(ancestor), copy: await readFile(copy), legacy: legacy.id };
  const reapplied = await stored({ backend, target: copy });
  assert.deepEqual([counted(reapplied, 'restore.reapplied'), counted(reapplied, 'project.purged')], [1, 0], `${mode}: S's journal holds the re-application and no marker`);
  assert.equal(reapplied.records.some((item) => item.id === legacy.id), false, `${mode}: S re-applied the purge`);
  assert.deepEqual([existsSync(ledgerPath(ancestor)), existsSync(ledgerPath(copy))], [false, true], `${mode}: B0 has no sidecar; S's ledger is left behind`);
  return made;
}

// F and B0 in a scratch directory and home of their own: one per restore, and one per twin.
async function copyPair(t, made) {
  const dir = await scratchDirectory(t, 'restore-wrapper-r16-copy-pair-');
  const home = join(dir, 'home');
  await mkdir(home);
  const extension = made.backend === 'sqlite' ? 'db' : 'json';
  const [saved, target] = [join(dir, `ancestor.${extension}`), join(dir, `copy.${extension}`)];
  await writeFile(saved, made.ancestor);
  await writeFile(target, made.copy);
  return { dir, home, env: { ...process.env, SHADOWGRAPH_HOME: home }, backend: made.backend, saved, target };
}

for (const [backend, options] of BACKENDS) test(`PR-37c T-10 review 2 ${backend}: a ledger-less copy of a re-applied store restoring an ancestor backup, logical and hard, is the primitive alone through every restore entry -- the twin's bytes, no ledger, no knowledge reported (X-t10-gate)`, options, async (t) => {
  for (const mode of ['logical', 'hard']) {
    const made = await reappliedCopy(t, backend, mode);
    for (const surface of SURFACES[backend]) {
      const label = `${mode} ${surface}`;
      const pair = await copyPair(t, made);
      const known = new Set((await stored(pair)).events.map((event) => event.id));
      const run = await restoreThrough(surface, pair, false);
      const after = await stored(pair);
      // The store holds no authority, so the primitive's merge adds no access.restored event and takes no clock; an
      // event, if one appears, gives the twin its instant.
      const restored = after.events.filter((event) => event.type === 'access.restored' && !known.has(event.id));
      assert.ok(restored.length <= 1, label);
      const twin = await copyPair(t, made);
      const installed = [];
      const twinOptions = { ...(restored.length ? { now: restored[0].at } : {}), afterReplace: (payload) => { installed.push(structuredClone(payload)); } };
      if (backend === 'json') await restoreJsonPrimitive(twin.saved, twin.target, twinOptions);
      else {
        const raw = await createSqliteStore(twin.target);
        try { await raw.restore(twin.saved, twinOptions); } finally { raw.close(); }
      }
      if (backend === 'json') assert.equal(sha256(await readFile(pair.target)), sha256(await readFile(twin.target)), `${label}: the primitive's bytes`);
      else assert.deepEqual(after, await stored(twin), `${label}: the primitive's payload`);
      assert.equal(after.records.some((item) => item.id === made.legacy), true, `${label}: B0's tokenless decision is restored, as the primitive restores it`);
      assert.equal(existsSync(ledgerPath(pair.target)), false, `${label}: no ledger`);
      assert.equal(existsSync(registryFile(pair.env)), false, `${label}: no registry`);
      assert.equal(run.result.deletionKnowledge, 'none', label);
      assert.deepEqual(['reapplied', 'completion'].filter((name) => Object.hasOwn(run.result, name)), [], label);
      if (run.calls) {
        assert.equal(run.calls.length, 1, `${label}: one activation`);
        assert.deepEqual(run.calls[0], installed[0], `${label}: the twin's installed payload`);
      }
      if (run.reads) assert.deepEqual(run.reads, visibleIds(await stored(twin)), `${label}: the activation reached the graph`);
    }
  }
});

// The process-wide registry is never written: from PR-37d, when purges write it, a test that leaked into the process
// home fails here.
after(() => assert.equal(existsSync(registryFile()), false, 'nothing wrote the process-wide registry'));
