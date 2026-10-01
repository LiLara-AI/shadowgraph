// The deletion knowledge this build reads (DP-1 reader floor, PR-37a; plan
// rev6 §3.8): the store control ledger `<store>.control.json` beside a store,
// and the per-user deletion registry. Both are content-free: tokens, project
// and origin names, instants, modes and lineage ids, never an id or content of
// what was purged.
//
// The ledger is written only through writeLedger (PR-37c design §2), which
// carries every member it does not change as a value, and the registry never
// (PR-37d writes it). Only what this build acts on is validated, and a file
// that fails is refused, never read as "no knowledge"; a backup copies the
// ledger as bytes.
//
// INTERNAL: package.json "exports" does not map this file.
import { lstat, open, readFile, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isValidIsoInstant } from '../fact-validity.js';
import { CREATION_ENTRY_TYPES, replayedEntity } from '../journal.js';

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
export const pendingUnsupported = () => deletionError(DELETION_PENDING_UNSUPPORTED, 'The store has a deletion this build cannot complete; a later ShadowGraph build is needed to open or copy it');
// A restore record the store is in no state of (PR-37c design §8.4).
export const restoreUnresolvable = () => deletionError(DELETION_PENDING_UNSUPPORTED, 'A pending restore cannot be resolved: the store is not in a state the record describes; put back one of the restore\'s retained files, or restore a backup into a fresh path');
const refusedWrite = (what) => deletionError(CONTROL_LEDGER_MALFORMED, `Refusing to write the deletion records: ${what}`);
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

// What is wrong with a tombstone, as the field to name, or null.
function tombstoneIssue(tombstone) {
  if (!isObject(tombstone)) return '';
  if (tombstone.tokens !== null && !(Array.isArray(tombstone.tokens) && tombstone.tokens.every(named))) return '.tokens';
  if (tombstone.kind === 'project' && tombstone.purgedProject !== undefined && !(named(tombstone.purgedProject) && isValidIsoInstant(tombstone.at))) return '.purgedProject';
  return null;
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
    const issue = tombstoneIssue(tombstone);
    if (issue !== null) throw malformed(`tombstones[${index}]${issue}`);
  });
  const quarantine = ledger ? list('quarantine') : [];
  quarantine.forEach((entry, index) => { if (!isObject(entry) || !named(entry.token)) throw malformed(`quarantine[${index}].token`); });
  const pending = ledger ? list('pending') : [];
  // Downgrade's flag disables the token proof (PR-37c design §1.1, §6.2).
  return { tombstones, quarantine, pending, tokensStripped: value.tokensStripped, members: Object.keys(value) };
}

// A value as text with its object keys sorted at every depth: the equality the
// writer and the tombstone dedupe use (PR-37c design §1.1).
export const canonical = (value) => JSON.stringify(value, (key, item) => (isObject(item) ? Object.fromEntries(Object.keys(item).sort().map((name) => [name, item[name]])) : item));

// A ledger's tombstones and a record's, each canonical duplicate after the
// first dropped, in order: the index space of a record's `inputs.postdated`
// and the knowledge a committed restore merges (PR-37c design §1.2, re-review
// NF-3).
export function mergedTombstones(...lists) {
  const seen = new Set();
  return lists.flat().filter((tombstone) => {
    const key = canonical(tombstone);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// A payload's journal head: the id of its entry with the greatest integer
// seq, or null (PR-37c design §1.2).
export function journalHead(payload) {
  let head = null;
  for (const entry of Array.isArray(payload?.journal) ? payload.journal : []) {
    if (Number.isSafeInteger(entry?.seq) && (head === null || entry.seq > head.seq)) head = entry;
  }
  return head?.id ?? null;
}

// The restore-pending record this build writes, validated strictly (PR-37c
// design §1.2): another kind, a missing or unknown member, or a postdated
// index past the merged tombstones is not this build's to resolve. `within`:
// an object with no member beyond `names`; each one required is checked by type.
const within = (value, names) => isObject(value) && Object.keys(value).every((name) => names.includes(name));
const bindingValid = (value, names = ['revision', 'head']) => within(value, names) && Number.isSafeInteger(value.revision) && value.revision >= 0 && (value.head === null || named(value.head));
export function restoreRecordValid(record, ledgerTombstones) {
  if (!within(record, ['kind', 'pre', 'expected', 'post', 'add', 'inputs', 'minted']) || record.kind !== 'restore') return false;
  if (!bindingValid(record.pre, ['revision', 'head', 'existed']) || typeof record.pre.existed !== 'boolean' || !bindingValid(record.expected)) return false;
  // `post` and `minted` are written together, by ledger step 1 (§6.6).
  if (('post' in record) !== ('minted' in record)) return false;
  if ('post' in record && !(bindingValid(record.post) && Array.isArray(record.minted) && record.minted.every(named))) return false;
  const { add, inputs } = record;
  if (!within(add, ['tombstones', 'quarantine', 'tokensStripped']) || !Array.isArray(add.tombstones) || !Array.isArray(add.quarantine)) return false;
  if (add.tombstones.some((tombstone) => tombstoneIssue(tombstone) !== null) || add.quarantine.some((entry) => !isObject(entry) || !named(entry.token))) return false;
  if ('tokensStripped' in add && !isObject(add.tokensStripped)) return false;
  if (!within(inputs, ['live', 'descent', 'descentMode', 'overlap', 'postdated'])) return false;
  if (!Array.isArray(inputs.live) || !inputs.live.every((id) => typeof id === 'string')) return false;
  if (typeof inputs.descent !== 'boolean' || !['logical', 'hard', null].includes(inputs.descentMode)) return false;
  if (!Array.isArray(inputs.overlap) || !inputs.overlap.every((entry) => within(entry, ['id', 'token']) && typeof entry.id === 'string' && (entry.token === null || named(entry.token)))) return false;
  const bound = mergedTombstones(ledgerTombstones, add.tombstones).length;
  return Array.isArray(inputs.postdated)
    && inputs.postdated.every((index, at) => Number.isSafeInteger(index) && index >= 0 && index < bound && (at === 0 || index > inputs.postdated[at - 1]));
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
  // Quarantine tokens are held like the rest, and the ones no tombstone names
  // are kept apart for the counts: what is quarantined, not purged (PR-37c
  // design §1.4, §9.3).
  const quarantine = new Set((ledger?.quarantine ?? []).map((entry) => entry.token).filter((token) => !tokens.has(token)));
  for (const entry of ledger?.quarantine ?? []) tokens.add(entry.token);
  return {
    tokens,
    quarantine,
    // Project tombstones bound the project's non-entity entries that predate
    // them, whether or not they name tokens (design §12 C5).
    projects: (ledger?.tombstones ?? []).filter((tombstone) => tombstone.kind === 'project' && named(tombstone.purgedProject)).map((tombstone) => ({ project: tombstone.purgedProject, at: tombstone.at, mode: tombstone.mode ?? null })),
    // Tokenless entities held by id, only while a committed restore waits for
    // its post-step (PR-37c design §8.1).
    ids: new Set(),
    // Any tombstone or quarantine entry: the store has deletion knowledge.
    knowledge: Boolean(ledger?.tombstones.length || ledger?.quarantine.length),
    pending: false,
    registryApplies: false
  };
}

// A ledger's view attached to a payload no store loaded: what a restore's
// activation hands its caller, the ledger as it will stand once the post-step
// has run (PR-37c design §7).
export function attachLedgerView(payload, ledger) {
  const view = viewOf({ tombstones: ledger?.tombstones ?? [], quarantine: ledger?.quarantine ?? [] });
  return Object.defineProperty(payload, DELETION_VIEW, { value: view, enumerable: false, configurable: true });
}

// Which state of a restore a stored payload is in (PR-37c design §8.2). The
// revision and the journal head are compared together, since a committed
// revision can equal what an ordinary save would give. An absent store binds
// `pre` only when it was absent when the record was written; anything else is
// unknown, which fails closed.
export function restoreBinding(record, payload, { absent = false } = {}) {
  if (absent) return record.pre.existed ? 'unknown' : 'pre';
  const at = (bound) => bound !== undefined && (payload?.revision ?? 0) === bound.revision && journalHead(payload) === bound.head;
  if (record.pre.existed && at(record.pre)) return 'pre';
  if (at(record.expected)) return 'committed';
  if (at(record.post)) return 'post';
  return 'unknown';
}

// What a restore does to each entity of the payload it installed (PR-37c
// design §6.1-§6.3), from the knowledge it merges -- `tombstones` M, the
// `quarantine` entries, the `tokensStripped` flag -- and the record's inputs
// only: `remove` with a mode, `quarantine`, or nothing (visible). Pure, so the
// dry run, activation, a load in the committed state and resolution agree.
// Each entry names the entity's own token, or, quarantined under overlap, the
// token D's copy holds; null when there is none.
export function classifyRestore(payload, { tombstones = [], quarantine = [], tokensStripped } = {}, inputs) {
  // M': M without the tombstones B postdates, which still remove by token (§4.3).
  const postdated = new Set(inputs.postdated);
  const counted = tombstones.filter((tombstone, index) => !postdated.has(index));
  const covering = new Map();
  for (const tombstone of tombstones) {
    if (!Array.isArray(tombstone.tokens)) continue;
    for (const token of tombstone.tokens) covering.set(token, [...(covering.get(token) ?? []), tombstone.mode]);
  }
  const quarantined = new Set(quarantine.map((entry) => entry.token));
  const nullTokens = counted.some((tombstone) => tombstone.tokens === null);
  const projects = new Set(counted.filter((tombstone) => tombstone.kind === 'project' && named(tombstone.purgedProject)).map((tombstone) => tombstone.purgedProject));
  const origins = new Set(counted.filter((tombstone) => tombstone.kind === 'origin' && named(tombstone.purgedOrigin)).map((tombstone) => tombstone.purgedOrigin));
  // A missing or unrecognised moveIn reads as "unknown" (§4.5).
  const moveRisk = counted.some((tombstone) => tombstone.moveIn !== 'none');
  const stripped = tokensStripped !== undefined;
  // The entries of B's journal that name each entity (`hold()`'s predicate),
  // and the first of them by seq.
  const naming = new Map();
  const first = new Map();
  for (const entry of (Array.isArray(payload?.journal) ? payload.journal : []).filter(isObject)) {
    for (const id of new Set([entry.entityId, replayedEntity(entry)?.id])) {
      if (typeof id !== 'string') continue;
      if (!naming.has(id)) naming.set(id, []);
      naming.get(id).push(entry);
      if (Number.isSafeInteger(entry.seq) && !(first.get(id)?.seq <= entry.seq)) first.set(id, entry);
    }
  }
  // Tokened at creation, proven by its own creation entry, with no tokens:null
  // tombstone counted and no downgrade's flag (§6.2).
  const exempt = (entity) => named(entity.erasureToken) && !nullTokens && !stripped
    && CREATION_ENTRY_TYPES.includes(first.get(entity.id)?.type) && first.get(entity.id).payload?.erasureToken === entity.erasureToken;
  // Rules (a) and (b): the entity's own owner, or an owner its journal entries name.
  const owned = (project, attribution, originId) => projects.has(project) || (attribution === 'unattributed' && origins.has(originId));
  const reached = (entity) => owned(entity.project, entity.attribution, entity.originId)
    || (naming.get(entity.id) ?? []).some((entry) => projects.has(entry.project) || owned(entry.payload?.project, entry.payload?.attribution, entry.payload?.originId)
      || projects.has(entry.payload?.attributionChange?.previousProject));
  const live = new Set(inputs.live);
  const overlap = new Map(inputs.overlap.map((entry) => [entry.id, entry.token]));
  // `candidates`: the entities that reach rule 3 or later, the set the
  // record's `live` is cut to (§6.2, V-10).
  const result = { remove: [], quarantine: [], candidates: [] };
  const entities = [...(payload?.records ?? []), ...(payload?.facts ?? [])].filter(isObject)
    .sort((left, right) => String(left.kind).localeCompare(String(right.kind)) || String(left.id).localeCompare(String(right.id)));
  // The first rule that holds, in the order of §6.1's table.
  for (const entity of entities) {
    const { id } = entity;
    const own = named(entity.erasureToken) ? entity.erasureToken : null;
    // Under overlap, D's copy's token when B's copy has none (§4.5).
    const token = overlap.get(id) ?? own;
    if (!covering.has(own) && !quarantined.has(own) && !exempt(entity)) result.candidates.push(id);
    // 1: hard if any tombstone naming the token is, a missing mode included (§6.3).
    if (covering.has(own)) result.remove.push({ id, token, mode: covering.get(own).some((mode) => mode !== 'logical') ? 'hard' : 'logical' });
    else if (quarantined.has(own)) continue;
    else if (overlap.has(id)) result.quarantine.push({ id, token });
    else if (exempt(entity) || live.has(id)) continue;
    else if (inputs.descent && inputs.descentMode !== null) result.remove.push({ id, token, mode: inputs.descentMode });
    // 6 with no newer marker, and 7: quarantine, never delete on doubt.
    else if (inputs.descent || moveRisk || reached(entity)) result.quarantine.push({ id, token });
  }
  return result;
}

// The view a ledger gives a payload (PR-37c design §8.1). With no record it
// is the ledger's. A restore record in the `pre` or `post` state gives the
// ledger's own view; in the `committed` state, the merged knowledge's, plus
// what the post-step will remove or quarantine, held by token or, with none,
// by id. Any other record, a second one, or `pending: 'refuse'` throws.
function viewFor(payload, ledger, { pending, absent }) {
  if (!ledger?.pending.length) return viewOf(ledger);
  const [record] = ledger.pending;
  if (pending === 'refuse' || ledger.pending.length > 1 || !restoreRecordValid(record, ledger.tombstones)) throw pendingUnsupported();
  const state = restoreBinding(record, payload, { absent });
  if (state === 'unknown') throw restoreUnresolvable();
  if (state !== 'committed') return { ...viewOf(ledger), pending: true };
  const merged = { tombstones: mergedTombstones(ledger.tombstones, record.add.tombstones), quarantine: [...ledger.quarantine, ...record.add.quarantine] };
  const view = { ...viewOf(merged), pending: true, knowledge: true };
  const { remove, quarantine } = classifyRestore(payload, { ...merged, tokensStripped: ledger.tokensStripped ?? record.add.tokensStripped }, record.inputs);
  const own = new Map([...(payload?.records ?? []), ...(payload?.facts ?? [])].filter(isObject).map((entity) => [entity.id, entity.erasureToken]));
  for (const { id } of [...remove, ...quarantine]) {
    if (named(own.get(id))) view.tokens.add(own.get(id));
    else view.ids.add(id);
  }
  return view;
}

// A stored payload's identity for the bracket below: its revision and journal
// head, or "absent" (PR-37c design §8.1).
const storeIdentity = (payload, absent) => (absent ? 'absent' : JSON.stringify([payload?.revision ?? 0, journalHead(payload)]));
const IDENTITY_MOVED = Symbol('the stored payload moved under an unfenced read');

// Reads the ledger beside a store after its payload, and attaches what the
// graph honours (design §2.1). A ledger that is malformed, unreadable or
// newer, or holds a record this build cannot serve (§8.1), fails closed;
// `pending: 'refuse'` refuses every record. With `registry`, whether a
// registry tombstone applies to the payload is noted too, for the
// merge-import refusal only: a registry read never fails a load (§12 C2), and
// a failed one notes that it applies. `absent` says the store file was not
// there. `reread` is the bracket of an unfenced read (PR-37c design §8.1): the
// payload's identity read again after the ledger, which must equal the one
// read before it, or the read starts again; a view error stands only then.
export async function attachDeletionView(payload, file, { registry = false, env = process.env, pending = 'suppress', absent = false, reread } = {}) {
  let view;
  let failure;
  try {
    view = viewFor(payload, await readLedger(file), { pending, absent });
    if (registry) view.registryApplies = await registryAppliesTo(payload, env).catch(() => true);
  } catch (error) { failure = error; }
  if (reread && (await reread().catch(() => null)) !== storeIdentity(payload, absent)) throw IDENTITY_MOVED;
  if (failure) throw failure;
  if (payload !== null && typeof payload === 'object') Object.defineProperty(payload, DELETION_VIEW, { value: view, enumerable: false, configurable: true });
  return payload;
}

// A read with no store fence held (PR-37c design §8.1): the JSON load and
// JSON delivery. `read` gives `{ text, payload }`, `text` null for an absent
// store. The view stands only when the payload's identity held across the
// ledger read: equal text at once, other text with an equal revision and
// head. Otherwise the read starts again, 3 attempts in all, 20 ms × attempt
// apart, as commitFile waits; null after the last, which its caller reports
// as busy. Every payload write moves the identity forward but a rollback,
// which puts D's own bytes back, and any ledger seen beside D's own payload
// belongs with it (§8.1), so a byte re-check of the ledger is never needed --
// nor enough, as step 5 can leave its bytes as they were.
export async function readUnfenced(file, read, { afterPayloadRead, ...options } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) await delay(20 * (attempt - 1));
    const first = await read();
    await afterPayloadRead?.();
    const identity = storeIdentity(first.payload, first.text === null);
    const reread = async () => {
      const again = await read();
      return again.text === first.text ? identity : storeIdentity(again.payload, again.text === null);
    };
    try { return await attachDeletionView(first.payload, file, { ...options, absent: first.text === null, reread }); }
    catch (error) { if (error !== IDENTITY_MOVED) throw error; }
  }
  return null;
}

// An absent SQLite store is never made again while a restore record waits
// (PR-37c design §3.3, re-review NF-5): an empty store made there could bind
// as the record's `pre` state and be discarded. Run inside the store fence,
// before every open that creates the file, outside the restore primitive.
export async function refuseAbsentWithRecord(file) {
  try { await stat(file); return; } catch (error) { if (error.code !== 'ENOENT') return; }
  const ledger = await readLedger(file);
  if (!ledger?.pending.length) return;
  throw ledger.pending.length === 1 && restoreRecordValid(ledger.pending[0], ledger.tombstones) ? restoreUnresolvable() : pendingUnsupported();
}

// Whether a payload B disproves a tombstone's lineage (review K-12): B holds
// an intact journal from its epoch (every sequence from the epoch on, none
// before it), with its epoch entry, and none of the tombstone's lineage ids,
// the epoch entry's included, is among B's journal entries. A tombstone with
// no usable lineage is never disproved.
export function lineageDisproved(tombstone, payload) {
  const lineage = tombstone?.lineage;
  if (!isObject(lineage) || !named(lineage.epochEntryId)) return false;
  const journal = Array.isArray(payload?.journal) ? payload.journal : [];
  const epoch = payload?.journalEpoch;
  const sequences = journal.map((entry) => entry?.seq).filter(Number.isSafeInteger).sort((left, right) => left - right);
  const intact = Number.isSafeInteger(epoch) && sequences.length > 0 && sequences.every((seq, index) => seq === epoch + index);
  if (!intact) return false;
  const ids = new Set(journal.map((entry) => entry?.id));
  return !LINEAGE_IDS.some((name) => named(lineage[name]) && ids.has(lineage[name]));
}

// Whether B holds one of the tokens a tombstone names: a random token proves
// lineage on its own.
export function holdsToken(tombstone, payload) {
  if (!Array.isArray(tombstone?.tokens)) return false;
  const held = new Set([...(payload?.records ?? []), ...(payload?.facts ?? [])].map((entity) => entity?.erasureToken).filter(named));
  return tombstone.tokens.some((token) => held.has(token));
}

// A registry tombstone applies to a payload B (design §1.2): one naming tokens
// always does; any other applies unless B disproves lineage. The merge-import
// refusal asks this.
export function tombstoneAppliesTo(tombstone, payload) {
  if (Array.isArray(tombstone?.tokens)) return true;
  return !lineageDisproved(tombstone, payload);
}

// Whether a restore merges a registry tombstone into the store B is restored
// into (PR-37c design §4.2, review finding 17), in this order: one naming a
// token B holds always does; one scoped to a project or origin does unless B
// disproves its lineage, whatever tokens it names, since either may reach
// that scope's tokenless material; an unscoped one naming tokens B lacks never
// does (the token filter); an unscoped `tokens: null` one always does. Defined
// on its own: tombstoneAppliesTo takes any token array as applying before it
// looks at lineage.
export function mergeAppliesTo(tombstone, payload) {
  if (holdsToken(tombstone, payload)) return true;
  if (named(tombstone?.purgedProject) || named(tombstone?.purgedOrigin)) return !lineageDisproved(tombstone, payload);
  return !Array.isArray(tombstone?.tokens);
}

// Whether a tombstone records a `project.purged` journal entry (PR-37c design
// §1.1): a project tombstone of the marker's project, both absent counting as
// equal, at its seq and its instant. A marker with no valid instant is lifted
// with the restore's own, so it is keyed on its project and seq alone (review
// finding 16); otherwise every later restore would lift it again.
export function markerMatches(tombstone, marker) {
  const project = marker?.payload?.project ?? marker?.project;
  return tombstone?.kind === 'project' && (tombstone.purgedProject ?? null) === (project ?? null)
    && tombstone.seq === marker?.seq && (tombstone.at === marker?.at || !isValidIsoInstant(marker?.at));
}

// Whether any registry tombstone applies to the payload. An unusable root, or
// a registry that is unreadable, malformed or newer, throws.
export async function registryAppliesTo(payload, env = process.env) {
  const registry = await readRegistry(env);
  return Boolean(registry?.tombstones.some((tombstone) => tombstoneAppliesTo(tombstone, payload)));
}

// The registry as this build reads it, or null when there is none. An
// unusable root, or a registry that is unreadable, malformed or newer, throws
// (d37a R-9). PR-37d is its first writer.
export async function readRegistry(env = process.env) {
  const file = registryFile(env);
  if (!file) throw malformed('registry root');
  return readKnowledge(file, { ledger: false });
}

// A store's ledger as a restore's pre-step reads it (PR-37c design §4.2, §2
// step 5): parsed, with the path it was found by, and its bytes and mode, which
// a discard puts back; all null when there is none. Two different ledgers
// beside one store's names, or one that is malformed, unreadable or newer,
// throw.
export async function ledgerSnapshot(file) {
  const files = await ledgerFiles(file);
  if (files.length > 1) throw malformed('two ledgers for one store');
  if (!files.length) return { ledger: null, path: null, bytes: null, mode: null };
  let bytes;
  let info;
  try { [bytes, info] = await Promise.all([readFile(files[0]), stat(files[0])]); }
  catch { throw malformed('unreadable'); }
  return { ledger: parseKnowledge(bytes.toString('utf8'), { ledger: true }), path: files[0], bytes, mode: info.mode & 0o777 };
}

// How many names a file has, or 0 when it is not there.
export async function linkCount(path) {
  return (await identity(path))?.links ?? 0;
}

// The I/O a restore and a resolver run a store's payload through (PR-37c
// design §3.6): kept here, as a graph's primitives are kept in snapshot.js, so
// the store object itself carries no key, symbol or method that exposes it.
const storeIoRegistry = new WeakMap();

export function registerStoreIo(store, io) {
  storeIoRegistry.set(store, io);
  return store;
}

export function storeIo(store) {
  const io = store !== null && typeof store === 'object' ? storeIoRegistry.get(store) : undefined;
  if (!io) throw new TypeError('storeIo requires a store created by createStorage');
  return io;
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

// On Windows a process reading a file -- host delivery reads the store and its
// ledger at every prompt -- can briefly block a rename or an unlink of it
// (FND-P5-01). The step is tried up to 5 times, 20 ms × attempt apart, on
// those codes only; any other error, or the fifth, stands (PR-37c design §2
// step 4, re-review NF-4).
const BUSY_CODES = ['EPERM', 'EACCES', 'EBUSY'];
export async function retryBusy(step) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await step(); }
    catch (error) {
      if (attempt >= 5 || !BUSY_CODES.includes(error.code)) throw error;
      await delay(20 * attempt);
    }
  }
}

// Renames a temporary file over its target, with that retry. If the rename
// still fails, the temporary file is removed and the error stands. The one
// definition every save and every ledger write uses; `move` is a test seam.
export async function commitFile(temporaryPath, filePath, move = rename) {
  try { return await retryBusy(() => move(temporaryPath, filePath)); }
  catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

// Writes `bytes` over `target` with `mode`: a temporary file in its folder,
// synced, then renamed over it. No directory sync, as writeSidecar (declared).
async function replaceFile(target, bytes, mode, move) {
  const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    const handle = await open(temporary, 'wx', mode);
    try {
      // The mode exactly as asked, whatever the umask.
      await handle.chmod(mode);
      await handle.writeFile(bytes);
      await handle.sync();
    } finally { await handle.close(); }
    await commitFile(temporary, target, move);
  } finally {
    await unlink(temporary).catch(() => {});
  }
}

const KEPT_AS_WRITTEN = new Set(['tombstones', 'quarantine', 'pending', 'tokensStripped']);

// Writes the ledger beside a store (PR-37c design §2). The caller holds the
// store fence; this never takes it. An existing ledger is rewritten in place,
// through the path it was found by; a new one is made beside the store's
// final name, links followed, so every spelling finds it (R2-5). `change`
// mutates the parsed ledger. The writer never repairs, drops or reorders:
// every tombstone stays, in order; the version, tokensStripped and every
// other member, unknown ones included, stay as they were. What it writes must
// read back: the reader's own checks and the record's. A change that breaks
// any of this throws before anything is written. The ledger is ShadowGraph
// control data, owner-only on every write (FND-P6-11). Resolves to the path
// written and the text, which discard compares against (§2 step 5).
export async function writeLedger(file, change, { env = process.env, rename: move } = {}) {
  await refuseDeletionFileDestination(file, env);
  const store = await canonicalPath(file);
  // Never beside a deletion record file, by its final name too (amend:195).
  if (basename(store).toLowerCase().endsWith(CONTROL_SUFFIX)) throw deletionError(DELETION_FILE_DESTINATION_REFUSED, 'Refusing to write deletion records beside a deletion record file');
  const files = await ledgerFiles(file);
  if (files.length > 1) throw malformed('two ledgers for one store');
  // A ledger may lie beside another hard link's name, which no lookup finds.
  if (!files.length && (await identity(file))?.links > 1) throw malformed('a store with another hard link');
  const target = files[0] ?? ledgerPath(store);
  let text = null;
  try { text = await readFile(target, 'utf8'); }
  catch (error) { if (error.code !== 'ENOENT') throw malformed('unreadable'); }
  const original = text === null ? { version: KNOWLEDGE_VERSION } : (parseKnowledge(text, { ledger: true }), JSON.parse(text));
  const next = structuredClone(original);
  change(next);
  const before = original.tombstones ?? [];
  if (!Array.isArray(next.tombstones ?? []) || before.some((tombstone, index) => canonical(tombstone) !== canonical(next.tombstones[index]))) throw refusedWrite('a tombstone would be dropped, changed or moved');
  if (next.version !== original.version) throw refusedWrite('the version would change');
  if (original.tokensStripped !== undefined && canonical(original.tokensStripped) !== canonical(next.tokensStripped)) throw refusedWrite('the tokensStripped flag would be dropped or changed');
  for (const name of Object.keys(original)) if (!KEPT_AS_WRITTEN.has(name) && canonical(original[name]) !== canonical(next[name])) throw refusedWrite(`${name} would change`);
  const written = `${JSON.stringify(next, null, 2)}\n`;
  const parsed = parseKnowledge(written, { ledger: true });
  if (parsed.pending.length > 1 || parsed.pending.some((record) => !restoreRecordValid(record, parsed.tombstones))) throw refusedWrite('a pending record this build does not write');
  await replaceFile(target, written, 0o600, move);
  return { path: target, text: written };
}

const holds = async (path, text) => (await readFile(path).catch(() => null))?.equals(Buffer.from(text)) === true;

// Puts a ledger's prior bytes back, with their prior mode, for a discard
// (PR-37c design §2 step 5): only over exactly the text the pre-step wrote,
// so nothing written since is replaced. Resolves to whether it did.
export async function restoreLedgerBytes(path, expectedText, priorBytes, priorMode, { rename: move } = {}) {
  if (!(await holds(path, expectedText))) return false;
  await replaceFile(path, priorBytes, priorMode, move);
  return true;
}

// The one delete of a ledger (PR-37c design §2 step 5): a ledger the
// pre-step made, still byte-equal to the text it wrote, holding nothing but
// its version and the record. A ledger holding a tombstone is never removed.
// Resolves to whether it did; `unlink` is a test seam.
export async function unlinkLedgerIfRecordOnly(path, expectedText, { unlink: remove = unlink } = {}) {
  if (!Object.keys(JSON.parse(expectedText)).every((name) => name === 'version' || name === 'pending')) return false;
  if (!(await holds(path, expectedText))) return false;
  await retryBusy(() => remove(path));
  return true;
}
