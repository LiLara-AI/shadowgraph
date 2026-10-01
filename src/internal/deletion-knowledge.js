// The deletion knowledge this build reads (DP-1 reader floor, PR-37a; plan
// rev6 §3.8): the store control ledger `<store>.control.json` beside a store,
// and the per-user deletion registry. Both are content-free: tokens, project
// and origin names, instants, modes and lineage ids, never an id or content of
// what was purged.
//
// This build never writes, renames or deletes either file; PR-37 writes them.
// Only what this build acts on is validated, and a file that fails is refused,
// never read as "no knowledge". Everything else in them -- unknown members, a
// later build's state -- is carried by never rewriting the files, and a backup
// copies the ledger as bytes.
//
// INTERNAL: package.json "exports" does not map this file.
import { lstat, open, readFile, realpath, rename, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { isValidIsoInstant } from '../fact-validity.js';

// The view a load attaches to the payload it returns. A symbol is never
// serialised, so the payload's bytes are unchanged. A caller holding a loaded
// payload can see it; a view built by hand matters only to a graph that
// imports a payload no store loaded, which bypasses the ledger anyway
// (declared, F18).
export const DELETION_VIEW = Symbol('shadowgraph.deletionView');

export const CONTROL_LEDGER_MALFORMED = 'control_ledger_malformed';
export const CONTROL_LEDGER_NEWER_VERSION = 'control_ledger_newer_version';
export const DELETION_PENDING_UNSUPPORTED = 'deletion_pending_unsupported_at_this_build';
export const PURGE_AWARE_RESTORE_UNSUPPORTED = 'purge_aware_restore_unsupported_at_this_build';
export const DELETION_FILE_DESTINATION_REFUSED = 'deletion_file_destination_refused';
export const BACKUP_CONTROL_LEDGER_STALE = 'backup_control_ledger_stale';
export const SCOPE_KEY_WITHHELD = 'scope_key_withheld';
export const IDEMPOTENCY_KEY_WITHHELD = 'idempotency_key_withheld';
export const SESSION_WITHHELD = 'session_withheld';
export const DELETION_CODES = Object.freeze([
  CONTROL_LEDGER_MALFORMED, CONTROL_LEDGER_NEWER_VERSION, DELETION_PENDING_UNSUPPORTED, PURGE_AWARE_RESTORE_UNSUPPORTED,
  DELETION_FILE_DESTINATION_REFUSED, BACKUP_CONTROL_LEDGER_STALE, SCOPE_KEY_WITHHELD, IDEMPOTENCY_KEY_WITHHELD, SESSION_WITHHELD
]);

// The newest ledger and registry format this build reads. A later build adds
// members; it never raises this (carried obligation for PR-39 and PR-43).
const KNOWLEDGE_VERSION = 1;
const CONTROL_SUFFIX = '.control.json';
const LINEAGE_IDS = ['epochEntryId', 'headEntryId', 'markerEntryId'];

// Messages name a field at most: never a project, path or token (F16).
export function deletionError(code, message) {
  const error = new Error(`${message} (${code})`);
  error.code = code;
  return error;
}
const malformed = (what) => deletionError(CONTROL_LEDGER_MALFORMED, `The deletion records are malformed or unreadable: ${what}`);
const pendingUnsupported = () => deletionError(DELETION_PENDING_UNSUPPORTED, 'The store has a deletion this build cannot complete; a later ShadowGraph build is needed to open or copy it');
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const named = (value) => typeof value === 'string' && value.length > 0;

export function ledgerPath(file) {
  return `${file}${CONTROL_SUFFIX}`;
}

// Resolved as activationFile() resolves its root; a relative root, or no home
// to resolve, gives none, which counts as an unreadable registry.
export function registryFile(env = process.env) {
  let root = env.SHADOWGRAPH_HOME;
  if (!root) {
    try { root = join(homedir(), '.shadowgraph'); } catch { return null; }
  }
  return isAbsolute(root) ? join(root, 'deletion-registry.json') : null;
}

// The fields this build acts on, validated (design §1, F13). An unknown kind,
// mode or moveIn is present knowledge, never "none".
function parseKnowledge(text, { ledger }) {
  let value;
  try { value = JSON.parse(text); } catch { throw malformed('not JSON'); }
  if (!isObject(value)) throw malformed('not an object');
  if (!Number.isSafeInteger(value.version) || value.version < 1) throw malformed('version');
  if (value.version > KNOWLEDGE_VERSION) throw deletionError(CONTROL_LEDGER_NEWER_VERSION, 'The deletion records were written by a newer ShadowGraph build');
  const list = (name) => {
    if (value[name] === undefined) return [];
    if (!Array.isArray(value[name])) throw malformed(name);
    return value[name];
  };
  const tombstones = list('tombstones');
  tombstones.forEach((tombstone, index) => {
    if (!isObject(tombstone)) throw malformed(`tombstones[${index}]`);
    if (tombstone.tokens !== null && !(Array.isArray(tombstone.tokens) && tombstone.tokens.every(named))) throw malformed(`tombstones[${index}].tokens`);
    if (tombstone.kind === 'project' && tombstone.purgedProject !== undefined && !(named(tombstone.purgedProject) && isValidIsoInstant(tombstone.at))) throw malformed(`tombstones[${index}].purgedProject`);
  });
  const quarantine = ledger ? list('quarantine') : [];
  quarantine.forEach((entry, index) => { if (!isObject(entry) || !named(entry.token)) throw malformed(`quarantine[${index}].token`); });
  const pending = ledger ? list('pending') : [];
  return { tombstones, quarantine, pending, members: Object.keys(value) };
}

async function readKnowledge(file, { ledger }) {
  let text;
  try { text = await readFile(file, 'utf8'); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw malformed('unreadable');
  }
  return parseKnowledge(text, { ledger });
}

const folded = (path) => (process.platform === 'win32' ? path.toLowerCase() : path);

// What a path names, however it is spelled (review K-1, C-1, C-2): the final
// path of an existing file -- 8.3 short names, the namespace prefix, junctions
// and symbolic links resolved -- or, for a file not there yet, the final path
// of its nearest folder that is there and the names after it. A hard link
// keeps the name it was given. With `followLink: false` -- the path a copy is
// written to -- a symbolic link is itself the file: a copy replaces the link,
// never the file it points to (re-review R2-4).
export async function canonicalPath(path, { followLink = true } = {}) {
  const given = resolve(String(path));
  const link = !followLink && await lstat(given).then((info) => info.isSymbolicLink(), () => false);
  if (!link) {
    try { return await realpath(given); } catch { /* not there */ }
  }
  const after = [basename(given)];
  for (let folder = dirname(given); ; folder = dirname(folder)) {
    try { return join(await realpath(folder), ...after); }
    catch {
      if (dirname(folder) === folder) return given;
      after.unshift(basename(folder));
    }
  }
}

// A file's identity and link count, or null when it is not there.
async function identity(path) {
  try {
    const info = await stat(path, { bigint: true });
    return { id: `${info.dev}:${info.ino}`, links: Number(info.nlink) };
  } catch { return null; }
}

// The ledger paths a store's names give it: beside its final name, and beside
// the name it was given when that differs.
async function ledgerPaths(file) {
  const paths = [ledgerPath(await canonicalPath(file)), ledgerPath(resolve(String(file)))];
  return paths.filter((path, index) => paths.findIndex((other) => folded(other) === folded(path)) === index);
}

// The distinct ledger files a store's names give it -- one file reached by
// two names is one ledger.
async function ledgerFiles(file) {
  const files = [];
  const seen = new Set();
  for (const path of await ledgerPaths(file)) {
    let id;
    try { const info = await stat(path, { bigint: true }); id = `${info.dev}:${info.ino}`; }
    catch (error) { if (error.code === 'ENOENT') continue; throw malformed('unreadable'); }
    if (seen.has(id)) continue;
    seen.add(id);
    files.push(path);
  }
  return files;
}

// Every ledger a store's names give it.
async function readLedgers(file) {
  const found = [];
  for (const path of await ledgerFiles(file)) found.push(await readKnowledge(path, { ledger: true }));
  return found.filter(Boolean);
}

// A store's ledger, or null when there is none. Malformed, unreadable or
// newer throws, and so do two different ledgers beside a store's names: which
// one holds is not this build's to decide (re-review R2-1).
export async function readLedger(file) {
  const ledgers = await readLedgers(file);
  if (ledgers.length > 1) throw malformed('two ledgers for one store');
  return ledgers[0] ?? null;
}

function viewOf(ledger) {
  const tokens = new Set();
  for (const tombstone of ledger?.tombstones ?? []) if (Array.isArray(tombstone.tokens)) for (const token of tombstone.tokens) tokens.add(token);
  for (const entry of ledger?.quarantine ?? []) tokens.add(entry.token);
  return {
    tokens,
    // Project tombstones bound the project's non-entity entries that predate
    // them, whether or not they name tokens (design §12 C5).
    projects: (ledger?.tombstones ?? []).filter((tombstone) => tombstone.kind === 'project' && named(tombstone.purgedProject)).map((tombstone) => ({ project: tombstone.purgedProject, at: tombstone.at })),
    // Any tombstone or quarantine entry: the store has deletion knowledge.
    knowledge: Boolean(ledger?.tombstones.length || ledger?.quarantine.length),
    registryApplies: false
  };
}

// Reads the ledger beside a store after its payload, and attaches what the
// graph honours (design §2.1). A ledger that is malformed, unreadable or newer,
// or holds a pending record, fails closed. With `registry`, whether a registry
// tombstone applies to the payload is noted too, for the merge-import refusal
// only: a registry read never fails a load (§12 C2), and a failed one notes
// that it applies.
export async function attachDeletionView(payload, file, { registry = false, env = process.env } = {}) {
  const ledger = await readLedger(file);
  if (ledger?.pending.length) throw pendingUnsupported();
  const view = viewOf(ledger);
  if (registry) view.registryApplies = await registryAppliesTo(payload, env).catch(() => true);
  if (payload !== null && typeof payload === 'object') Object.defineProperty(payload, DELETION_VIEW, { value: view, enumerable: false, configurable: true });
  return payload;
}

// A registry tombstone applies to a payload B (design §1.2): one naming tokens
// always does; any other applies unless B disproves lineage -- B holds an
// intact journal from its epoch (every sequence from the epoch on, none before
// it; review K-12), with its epoch entry, and none of the tombstone's lineage
// ids, the epoch entry's included, is among B's journal entries.
export function tombstoneAppliesTo(tombstone, payload) {
  if (Array.isArray(tombstone?.tokens)) return true;
  const lineage = tombstone?.lineage;
  if (!isObject(lineage) || !named(lineage.epochEntryId)) return true;
  const journal = Array.isArray(payload?.journal) ? payload.journal : [];
  const epoch = payload?.journalEpoch;
  const sequences = journal.map((entry) => entry?.seq).filter(Number.isSafeInteger).sort((left, right) => left - right);
  const intact = Number.isSafeInteger(epoch) && sequences.length > 0 && sequences.every((seq, index) => seq === epoch + index);
  if (!intact) return true;
  const ids = new Set(journal.map((entry) => entry?.id));
  return LINEAGE_IDS.some((name) => named(lineage[name]) && ids.has(lineage[name]));
}

// Whether any registry tombstone applies to the payload. An unusable root, or
// a registry that is unreadable, malformed or newer, throws.
export async function registryAppliesTo(payload, env = process.env) {
  const file = registryFile(env);
  if (!file) throw malformed('registry root');
  const registry = await readKnowledge(file, { ledger: false });
  return Boolean(registry?.tombstones.some((tombstone) => tombstoneAppliesTo(tombstone, payload)));
}

const holdsPurgeMarker = (payload) => Array.isArray(payload?.journal) && payload.journal.some((entry) => entry?.type === 'project.purged');
const holdsCursor = (payload) => Array.isArray(payload?.captureSessions) && payload.captureSessions.some((session) => isObject(session?.cursor));

// Whether a restore of B into D needs deletion semantics this build lacks
// (design §4, §11 R-1, R-9): D's ledger has knowledge, a pending record, or
// cannot be read; B's sidecar holds anything but its version, or cannot be
// read; a registry tombstone applies to B, or the registry cannot be read; D
// holds a transcript cursor; or D's journal holds a purge marker.
//
// A store's ledger is looked for beside each of its names; a file with another
// hard link and no ledger beside either name may have one beside a name this
// cannot find, so it refuses too (review C-2). A destination that is there but
// cannot be read refuses (C-9).
async function restoreNeedsDeletionSemantics({ source, destination, payload, readDestination, env }) {
  try {
    const ledgers = await readLedgers(destination);
    if (ledgers.some((ledger) => ledger.tombstones.length || ledger.quarantine.length || ledger.pending.length)) return true;
    if (!ledgers.length && (await identity(destination))?.links > 1) return true;
  } catch { return true; }
  try {
    const sidecars = await readLedgers(source);
    if (sidecars.some((sidecar) => sidecar.members.some((name) => name !== 'version'))) return true;
    if (!sidecars.length && (await identity(source))?.links > 1) return true;
  } catch { return true; }
  try { if (await registryAppliesTo(payload, env)) return true; } catch { return true; }
  let current;
  try { current = await readDestination(); } catch { return 'unreadable'; }
  return holdsCursor(current) || holdsPurgeMarker(current);
}

// The refusal, as the validate hook both unchanged restore primitives call
// inside the destination fence before any write (R16 §7.2 pattern). The
// verdict is taken at the first call, on the source payload, and kept for the
// later ones (R-5); then the caller's own validator runs.
export function deletionRestoreHook({ source, destination, readDestination, env = process.env, validate }) {
  let verdict = null;
  return async (payload) => {
    verdict ??= restoreNeedsDeletionSemantics({ source, destination, payload, readDestination, env });
    const refused = await verdict;
    // A destination that cannot be read cannot rule them out; a fresh path can (re-review R2-T6).
    if (refused === 'unreadable') throw deletionError(PURGE_AWARE_RESTORE_UNSUPPORTED, 'Refusing to restore: the destination cannot be read, so deletion records it may hold cannot be ruled out; restore into a fresh path instead');
    if (refused) throw deletionError(PURGE_AWARE_RESTORE_UNSUPPORTED, 'Refusing to restore: deletion records apply to this restore, and this build cannot honour them on restore; a later ShadowGraph build is needed');
    if (typeof validate === 'function') await validate(payload);
  };
}

// No copy ever lands on a ledger or the registry (R-8), by what the
// destination names, not how it is spelled (review K-1, C-1): its final name
// is not a ledger's, it is not the registry's file, and, where neither is
// there yet, it is not the registry's name in the registry's folder. Names
// are compared without case on every platform, as a volume may fold case
// where the platform does not (re-review R2-T3). Resolves to the
// destination's final path, which the copy is written to.
export async function refuseDeletionFileDestination(destination, env = process.env) {
  const target = await canonicalPath(destination, { followLink: false });
  const registry = registryFile(env);
  const name = basename(target).toLowerCase();
  let refused = name.endsWith(CONTROL_SUFFIX);
  if (!refused && registry) {
    const [file, record] = await Promise.all([identity(target), identity(registry)]);
    if (file && record) refused = file.id === record.id;
    else if (!file && name === basename(registry)) {
      const [folder, home] = await Promise.all([identity(dirname(target)), identity(dirname(registry))]);
      refused = folder && home ? folder.id === home.id : folded(dirname(target)) === folded(await canonicalPath(dirname(registry)));
    }
  }
  if (refused) throw deletionError(DELETION_FILE_DESTINATION_REFUSED, 'Refusing to write a copy over a deletion record file');
  return target;
}

// The ledger bytes a backup of `file` at `destination` carries, or null when
// the store has none (rev6 §3.8 item 1). A store with a pending record is not
// copied, as pending records are never backed up (§12 C3). A sidecar already
// beside the destination is never replaced by different bytes, nor left beside
// a copy it does not belong to: tombstones are never deleted.
// The same bytes already there are not written again, so a backup onto the
// store's own path never renames its ledger (review C-5): null then.
export async function backupSidecar(file, destination, env = process.env) {
  const target = await refuseDeletionFileDestination(destination, env);
  const read = async (path) => {
    try { return await readFile(path); }
    catch (error) { if (error.code === 'ENOENT') return null; throw malformed('unreadable'); }
  };
  const files = await ledgerFiles(file);
  if (files.length > 1) throw malformed('two ledgers for one store');
  const bytes = files.length ? await read(files[0]) : null;
  if (bytes !== null && parseKnowledge(bytes.toString('utf8'), { ledger: true }).pending.length) throw pendingUnsupported();
  const existing = await read(ledgerPath(target));
  if (existing !== null && (bytes === null || !existing.equals(bytes))) {
    throw deletionError(BACKUP_CONTROL_LEDGER_STALE, 'Refusing the copy: a deletion record file beside the destination would be replaced or left beside a copy it does not describe');
  }
  return existing === null ? bytes : null;
}

// Writes the sidecar a backup carries, before the payload it describes lands
// (R-8): a crash between them leaves at worst a newer sidecar beside an older
// payload, which withholds more, never less.
// It is synced to disk before it is renamed into place (review K-11).
export async function writeSidecar(destination, bytes) {
  if (bytes === null) return;
  const target = ledgerPath(await canonicalPath(destination, { followLink: false }));
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
