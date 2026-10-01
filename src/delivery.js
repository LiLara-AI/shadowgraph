// Plan v1.4.4 §18.2-§18.4, §22.7 and §23 F-2/F-4/F-16 (PR-30; programme plan
// revision 6 §3.4, VAR-11): host delivery. `shadowgraph deliver` reads the
// hook's JSON on stdin and writes one `hookSpecificOutput.additionalContext`
// line on stdout: the store's relevant experience, head first, within 8 000
// bytes, redacted before it reaches stdout and framed as data. It is strictly
// write-free: the store is read as it is, whatever its schema version, with no
// save, lock, stamp, migration or runtime-miss persistence, so a hook can never
// change what it reads. It never exits non-zero, never writes to stderr and
// never emits a field that could block or steer the host (§18.4, PC-15).
import { lstat, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { activeCapture, storeRepository } from './capture-hook.js';
import { createShadowGraph, MAX_PAGE_LIMIT, SCHEMA_VERSION } from './shadowgraph.js';
import { show, t1Line } from './compact-tier.js';
import { accessContext, discoverWorkspace } from './internal/access-transport.js';
import { DELIVERY_CAP_BYTES, DELIVERY_FRAME, deliveryEndLine } from './internal/delivery-marker.js';
import { attachDeletionView, DELETION_PENDING_UNSUPPORTED, DELETION_VIEW, readUnfenced } from './internal/deletion-knowledge.js';
import { fenceLockPath } from './revision-store.js';
import { flaggedText, jsonLiterals, redactText, redactValue } from './internal/redaction.js';

export { DELIVERY_CAP_BYTES, DELIVERY_FRAME, redactText, redactValue };
const PROCESSING = 'processing: {"capture":"not_active","extraction":"not_active"}';
// With capture active, or capture state in the store, the line says so and
// carries the scope's capture status (plan v1.4.4 §24.1, M-9; PR-36b); without
// either it is the constant it always was.
const processingLine = (processing, redact = redactValue) => (processing === undefined ? PROCESSING : `processing: ${show(redact(processing))}`);
const SERVED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const HOOK_INPUT_LIMIT_BYTES = 1024 * 1024;
const HOOK_INPUT_WAIT_MS = 3000;
const GIT_TIMEOUT_MS = 3000;
// Below this, no item line can fit; the rest are not redacted or scanned. Past
// this many, no further item is examined: a few thousand bytes hold far fewer.
const SMALLEST_ITEM_BYTES = 64;
const MOST_ITEMS_EXAMINED = 200;
const bytes = (text) => Buffer.byteLength(text, 'utf8');

function flagged(line, item) {
  if (flaggedText(line)) return true;
  const strings = [];
  const collect = (value) => {
    if (typeof value === 'string') strings.push(value);
    else if (value && typeof value === 'object') for (const [key, entry] of Object.entries(value)) { strings.push(key); collect(entry); }
  };
  collect(item);
  return strings.some((value) => flaggedText(value) || jsonLiterals(value).some((literal) => {
    try { return flaggedText(JSON.parse(literal)); } catch { return false; }
  }));
}

// The closing self-check line: the byte count of everything before it. A
// verification aid, not runtime truncation detection (§18.2).
function framed(lines) {
  const body = `${lines.join('\n')}\n`;
  return `${body}${deliveryEndLine(bytes(body))}`;
}

// §18.2 order: the head (scope, request state, completeness, limitation), the
// processing block, the items in order, then the expansion pointer. Every line
// is JSON with line and paragraph separators, C1 and bidirectional controls
// escaped, so no delivered text can start a line of its own (AC-043). Items
// are taken in order while they fit; one that does not is left out whole and
// the next is tried, and the head counts every one left out (§23 F-4).
export function assemblePayload({ head, items, capBytes = DELIVERY_CAP_BYTES, redact = redactValue, processing }) {
  const total = head.total ?? items.length;
  let withheld = 0;
  let examined = 0;
  const render = (kept) => {
    const delivered = kept.length;
    const shown = { ...head, complete: head.complete === true && delivered === items.length && withheld === 0, delivered, omitted: total - delivered, omittedForSize: examined - delivered - withheld, withheld, notExamined: items.length - examined };
    return framed([
      DELIVERY_FRAME, `head: ${show(redact(shown))}`, processingLine(processing, redact), ...kept,
      `expansion: ${show({ operation: 'shadowgraph_expand', notDelivered: total - delivered, fullRead: 'shadowgraph_context' })}`
    ]);
  };
  // The room for items: the cap, less the payload without them, less a margin
  // that covers every way the head and the byte count can grow as items are
  // taken (a digit or two, and `complete` turning true).
  // (`notExamined` shrinks as `examined` grows, so it widens nothing.)
  let room = capBytes - bytes(render([])) - 16;
  const kept = [];
  for (const [index, item] of items.entries()) {
    if (room < SMALLEST_ITEM_BYTES || index >= MOST_ITEMS_EXAMINED) break;
    examined += 1;
    const shown = redact(item);
    const line = `item: ${show(shown)}`;
    if (flagged(line, shown)) {
      withheld += 1;
      continue;
    }
    if (bytes(line) + 1 <= room) {
      kept.push(line);
      room -= bytes(line) + 1;
    }
  }
  // Whatever the lines hold together, the checker must pass the whole payload,
  // as delivered and as escaped on stdout: first without the items, and then,
  // if the head itself is the reason, with a head that holds only counts.
  const passes = (text) => !flaggedText(text) && !flaggedText(JSON.stringify(text));
  let text = render(kept);
  if (!passes(text)) {
    withheld += kept.length;
    kept.length = 0;
    text = render(kept);
  }
  const reduced = (code, detail) => framed([DELIVERY_FRAME, `head: ${show({ trigger: head.trigger, store: head.store, complete: false, limitation: { code, detail }, total, delivered: 0, omitted: total })}`, processingLine(processing, redact)]);
  if (!passes(text)) text = reduced('head_withheld', 'The head held something the credential check flags, so it is shortened and no record is delivered.');
  else if (bytes(text) > capBytes) {
    kept.length = 0;
    text = reduced('head_too_large', 'The head alone exceeded the payload cap, so it is shortened and no record is delivered.');
  }
  return { text, delivered: kept.length, omittedForSize: examined - kept.length - withheld, withheld, notExamined: items.length - examined };
}

// §22.7, §23 F-2: a store that is missing, unreadable, in use, newer than this
// build or not readable by this runtime is reported unavailable, never empty
// and complete. This payload has its own reduced shape: no scope was resolved
// and nothing was counted, so its head says why and there is no pointer.
const UNAVAILABLE_DETAIL = {
  not_initialized: 'No ShadowGraph store exists here yet. Nothing was read, and none was created.',
  unreadable: 'The ShadowGraph store could not be read. Nothing was delivered from it.',
  busy: 'Another ShadowGraph process had the store open (its journal or lock was present, or the file changed while it was read). It was not read, so nothing torn or stale is delivered.',
  newer_schema: 'The ShadowGraph store was written by a newer build than this one, which does not read it. Nothing was delivered from it.',
  sqlite_unavailable: 'This runtime cannot read the SQLite store. Nothing was delivered from it.',
  unsupported_storage: 'The configured storage type is not supported. Nothing was read.'
};

function unavailablePayload(trigger, reason, processing) {
  const head = { trigger, store: 'unavailable', reason, complete: false, limitation: { code: 'memory_unavailable', detail: UNAVAILABLE_DETAIL[reason] } };
  return framed([DELIVERY_FRAME, `head: ${show(head)}`, processingLine(processing)]);
}

async function present(path) {
  try { await stat(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// Another process at the store: a journal beside the database, or the store's
// own destination fence held. The fence's lock is looked for by its one name,
// beside the store's canonical path, so a read through an alias of the store
// sees a fence held through any spelling (PR-37c design §3.1); SQLite keeps its
// journals beside the name it was given.
const inUse = async (file, lock) => (await present(`${file}-wal`)) || (await present(`${file}-journal`)) || (await present(lock));
const fingerprint = async (file) => { const { size, mtimeMs } = await stat(file); return `${size}:${mtimeMs}`; };

// The store as it is. JSON is read whole; SQLite is opened immutable and
// read-only, so no schema, pragma, sidecar or lock is created. A SQLite store
// another process has open -- a journal or the fence present before or after
// the read, or the file changed while it was read -- is busy rather than read.
// `afterRead` lets a test act between the read and the check that follows it;
// `afterPayloadRead`, between the payload read and the ledger read.
export async function readStoreForDelivery({ file, storage, afterRead, afterPayloadRead }) {
  if (!['json', 'sqlite'].includes(storage)) return { unavailable: 'unsupported_storage' };
  try {
    if (!(await present(file))) return { unavailable: 'not_initialized' };
    // The payload, then the deletion records beside it, which the graph
    // honours; records it cannot honour leave memory unavailable (PR-37a). The
    // per-user registry is never read here. No fence is held, so the ledger
    // read is bracketed by the payload's identity, and a read that keeps
    // losing that race is busy (PR-37c design §8.1, §8.5).
    if (storage === 'json') {
      const payload = await readUnfenced(file, async () => {
        const text = await readFile(file, 'utf8');
        return { text, payload: JSON.parse(text) };
      }, { afterPayloadRead });
      return payload === null ? { unavailable: 'busy' } : { payload };
    }
    const lock = await fenceLockPath(file);
    if (await inUse(file, lock)) return { unavailable: 'busy' };
    let DatabaseSync, exportSqlitePayload;
    try { ({ DatabaseSync } = await import('node:sqlite')); ({ exportSqlitePayload } = await import('./sqlite-storage.js')); }
    catch { return { unavailable: 'sqlite_unavailable' }; }
    const before = await fingerprint(file);
    let database, legacy, payload = null;
    try {
      database = new DatabaseSync(new URL(`${pathToFileURL(file).href}?immutable=1`), { readOnly: true });
      const table = (name) => database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
      // A single-payload store not yet converted to tables: the live store
      // converts it on its next open, and the payload wins, so it is read here.
      legacy = table('shadowgraph_state') ? database.prepare('SELECT payload FROM shadowgraph_state WHERE id = 1').get()?.payload : undefined;
      if (legacy === undefined && table('shadowgraph_entities')) payload = exportSqlitePayload(database, { tolerant: true });
    } finally {
      database?.close();
    }
    await afterPayloadRead?.();
    // The ledger is read before the check below, which is this branch's
    // bracket: a commit after the fingerprint was taken changes the file or
    // leaves a journal or the fence's lock, so a view pairing this payload
    // with a later ledger is never served, and a view error stands only when
    // the check passes (PR-37c design §8.5, re-review NF-6 (c)).
    let viewed = null;
    if (legacy !== undefined || payload !== null) {
      try { viewed = { value: await attachDeletionView(legacy === undefined ? payload : JSON.parse(legacy), file) }; }
      catch (error) { viewed = { error }; }
    }
    await afterRead?.();
    if ((await inUse(file, lock)) || (await fingerprint(file)) !== before) return { unavailable: 'busy' };
    if (viewed === null) return { unavailable: (await stat(file)).size === 0 ? 'not_initialized' : 'unreadable' };
    if (viewed.error) throw viewed.error;
    return { payload: viewed.value };
  } catch (error) {
    // A pending deletion record is named, for the capture line (PR-37b).
    return { unavailable: 'unreadable', ...(error?.code === DELETION_PENDING_UNSUPPORTED ? { pending: true } : {}) };
  }
}

// The per-user activation record (plan §26; programme plan revision 6 §5):
// `<SHADOWGRAPH_HOME, or ~/.shadowgraph>/activation.json`, written by
// `shadowgraph activate` (src/activation.js). A relative root is never trusted.
export function activationFile(env = process.env) {
  const root = env.SHADOWGRAPH_HOME || join(homedir(), '.shadowgraph');
  return isAbsolute(root) ? join(root, 'activation.json') : null;
}

// The delivery capability, when the record is a regular file saying delivery
// is active and naming the store it pins by absolute path; otherwise null,
// which leaves the hook path inert.
export async function activeDelivery(env = process.env) {
  try {
    const file = activationFile(env);
    if (!file || !(await lstat(file)).isFile()) return null;
    const delivery = JSON.parse(await readFile(file, 'utf8'))?.capabilities?.delivery;
    const pinned = delivery?.state === 'active' && typeof delivery.store?.file === 'string' && isAbsolute(delivery.store.file) && ['json', 'sqlite'].includes(delivery.store.storage);
    return pinned ? delivery : null;
  } catch {
    return null;
  }
}

// The hook's deadline, below the template's 10-second hook timeout (§18.4):
// past it the hook prints nothing and exits 0. SHADOWGRAPH_DELIVERY_DEADLINE_MS
// can only shorten it.
export const DELIVERY_DEADLINE_MS = 5000;
export function deliveryDeadlineMs(env = process.env) {
  const requested = Number(env.SHADOWGRAPH_DELIVERY_DEADLINE_MS);
  return requested > 0 ? Math.min(requested, DELIVERY_DEADLINE_MS) : DELIVERY_DEADLINE_MS;
}

// The hook's input: one JSON object, a leading byte-order mark allowed. Reading
// stops as soon as it parses, at the size limit, or after a short wait, so a
// host that leaves stdin open never holds the hook.
const unmarked = (text) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
export function readHookInput(stream = process.stdin, { limit = HOOK_INPUT_LIMIT_BYTES, waitMs = HOOK_INPUT_WAIT_MS } = {}) {
  if (stream.isTTY) return Promise.resolve('');
  return new Promise((done) => {
    const chunks = [];
    let size = 0, settled = false;
    const finish = (text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.removeAllListeners('data');
      stream.destroy();
      done(unmarked(text));
    };
    const timer = setTimeout(() => finish(Buffer.concat(chunks).toString('utf8')), waitMs);
    stream.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) return finish('');
      chunks.push(chunk);
      const text = Buffer.concat(chunks).toString('utf8');
      try { JSON.parse(unmarked(text)); finish(text); } catch {}
    });
    stream.on('end', () => finish(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => finish(''));
  });
}

// A line is rendered again from the redacted record, so its text never holds
// what redaction removed; its handle stays the read's own, bound to the record
// as stored, so expansion finds the very revision.
function itemOf({ tier, line, record, temporalEvidence }, records) {
  const time = { eventTime: temporalEvidence?.eventTime?.state ?? null, currentState: temporalEvidence?.currentState ? { state: temporalEvidence.currentState.state, basis: temporalEvidence.currentState.basis } : null };
  if (tier !== 'T1') return { tier, record, ...time };
  const full = records.get(line.recordId);
  if (!full) return null;
  // The one link a line renders is shown exactly when the read's own line
  // showed it; a part the redacted line cannot hold is declared, and the line
  // then asks for expansion.
  const rendered = t1Line(redactValue(full), {
    asOf: line.expansion.asOf, scope: line.expansion.scope, derivedAt: line.expansion.derivedAt,
    visible: (id) => id === line.status?.supersededBy
  });
  const omitted = rendered.decisiveOmitted;
  return { tier, line: rendered.line, claimClass: line.claimClass, requiresExpansion: line.requiresExpansion || omitted.length > 0, ...(omitted.length ? { omitted } : {}), ...time, expansion: line.expansion };
}

// No prompt at SessionStart: the working set, newest first within each kind and
// the kinds taken in turn, so neither the oldest decisions nor one kind fill
// the payload.
const recordedAt = (record) => String(record.temporal?.recordedAt ?? record.createdAt ?? record.recordedAt ?? record.observedAt ?? '');
function sessionOrder(items) {
  const byKind = new Map();
  for (const item of items) {
    const kind = item.record?.kind ?? 'fact';
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(item);
  }
  const queues = [...byKind.values()].map((queue) => queue.sort((left, right) => recordedAt(right.record).localeCompare(recordedAt(left.record))));
  const ordered = [];
  while (queues.some((queue) => queue.length)) for (const queue of queues) if (queue.length) ordered.push(queue.shift());
  return ordered;
}

const PROJECT_UNRESOLVED = { code: 'project_unresolved', detail: 'No project was resolved for this workspace, so no project memory was searched.' };
const NOT_ASSESSED = { code: 'relevance_not_assessed', detail: `No prompt has been given yet, so relevance was not assessed: the working set follows, newest first and mixed by kind among its first ${MAX_PAGE_LIMIT} records (current decisions, failed and reusable attempts, then stale facts), as far as the payload cap allows. The semantic signal is unavailable on this path.` };

// SessionStart delivers the working set, the read's declared fallback when no
// signal can establish relevance (G-5 §9), and says what state memory is in:
// available, unavailable, or unresolved for this workspace. UserPromptSubmit
// ranks the prompt and delivers only what is relevant; otherwise it delivers
// nothing, the state having been said at the session's start (§18.4: degraded
// status is data, not a repeated alert; PC-09: no history dump).
//
// With `--hook` the capability must be active, and the store it pins is the
// one read, whatever SHADOWGRAPH_FILE or the workspace holds; a workspace
// binding then selects a project only when that store has recorded it too, so
// files a cloned repository ships choose nothing (FND-P5-07). Nothing is
// printed once the deadline has passed.
export async function runDeliver({ args = [], readInput = () => '', file, storage = 'json', env = process.env, deadline = Infinity, write }) {
  let trigger = null, emitted = false, quiet;
  const emit = (text) => {
    if (Date.now() >= deadline) return;
    emitted = true;
    write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: trigger, additionalContext: text } })}\n`);
  };
  try {
    const pinned = args.includes('--hook') ? await activeDelivery(env) : null;
    if (args.includes('--hook') && !pinned) return;
    // Whether capture is on comes from the activation record, not the store,
    // and only on the hook path, for the store it pins: capture is said to be
    // active only when it writes the store delivered here.
    const capture = pinned ? await activeCapture(env) : null;
    const capturing = Boolean(capture) && capture.store.file === pinned.store.file && capture.store.storage === pinned.store.storage;
    // Capture on but unable to write its store says so, and why (PR-37b): a
    // store inside a repository, never written there (§21.3), or one the hook
    // cannot load. Found without any write.
    let refusal = capturing ? await storeRepository(capture.store.file).then((repository) => (repository ? 'store_inside_repository' : null), () => 'store_inside_repository') : null;
    const captureState = () => (refusal ? { capture: 'unavailable', reason: refusal } : { capture: 'active' });
    quiet = capturing ? { ...captureState(), extraction: 'not_active' } : undefined;
    let event;
    try { event = JSON.parse(unmarked(await readInput())); } catch { return; }
    if (!SERVED_EVENTS.has(event?.hook_event_name)) return;
    trigger = event.hook_event_name;
    const session = trigger === 'SessionStart';
    const prompt = session ? '' : typeof event.prompt === 'string' ? event.prompt : '';
    if (!session && !prompt.trim()) return;
    const read = await readStoreForDelivery(pinned ? pinned.store : { file, storage });
    const unavailable = read.unavailable ?? (read.payload?.schemaVersion > SCHEMA_VERSION ? 'newer_schema' : null);
    const cannotLoad = (reason) => {
      if (!capturing || refusal) return;
      refusal = reason;
      quiet = { ...captureState(), extraction: 'not_active' };
    };
    if (unavailable === 'newer_schema') cannotLoad('newer_schema');
    else if (unavailable === 'unreadable') cannotLoad(read.pending ? 'deletion_pending' : 'store_unreadable');
    // A restore record the read could serve still stops the hook writing, so
    // the line says so while memory is served (PR-37c design §8.5).
    else if (!unavailable && read.payload?.[DELETION_VIEW]?.pending) cannotLoad('deletion_pending');
    if (unavailable) return session ? emit(unavailablePayload(trigger, unavailable, quiet)) : undefined;
    const graph = createShadowGraph();
    try { graph.importData(read.payload); }
    catch {
      cannotLoad('store_unreadable');
      return session ? emit(unavailablePayload(trigger, 'unreadable', quiet)) : undefined;
    }
    const workspace = await discoverWorkspace(process.cwd(), { timeout: GIT_TIMEOUT_MS });
    // At SessionStart the whole working set, up to the largest page, is read,
    // so the order below chooses among all of it.
    const input = accessContext(graph, { query: prompt, compact: true, ...(session ? { limit: MAX_PAGE_LIMIT } : {}) }, 'cli', workspace, { confirmedByStore: Boolean(pinned) });
    const relevant = graph.context(input).relevant;
    const unresolved = relevant.scope.requestState !== 'project_selected';
    if (!session && (unresolved || !relevant.relevance.established)) return;
    // The records behind the lines, in this scope and as a read shows them,
    // looked up by id.
    const exported = session ? null : graph.exportData(input);
    const records = new Map(exported ? [...exported.records, ...exported.facts].map((record) => [record.id, record]) : []);
    const head = {
      trigger, store: 'available', scope: relevant.scope, complete: relevant.complete,
      limitation: unresolved ? PROJECT_UNRESOLVED : session ? NOT_ASSESSED : relevant.limitation ?? null,
      // What deletion records withhold from this scope as possibly purged,
      // counted as every read counts it (PR-37c design §9.3): the session
      // start's own limitation leaves the read's detail out, never the count.
      ...(relevant.quarantined ? { quarantined: relevant.quarantined } : {}),
      relevance: session ? 'not_assessed' : 'established',
      total: relevant.total, hasMore: relevant.hasMore, limitSource: relevant.limitSource, byKind: relevant.byKind,
      temporal: { eventTimeUnknown: relevant.temporal.eventTimeUnknown, recordingOrderOnly: relevant.temporal.recordingOrderOnly },
      // The host version recorded at activation; one other than the verified
      // version is said to be unverified (§18.1, F-23).
      ...(pinned?.host ? { host: pinned.host } : {})
    };
    const items = relevant.items.map((item) => itemOf(item, records)).filter(Boolean);
    // The status in brief, bounded whatever the store holds: counts, and the
    // names of the limits and gaps the reads declare.
    const status = relevant.capture;
    const processing = capturing || status ? {
      ...(capturing ? captureState() : { capture: 'not_active' }), extraction: 'not_active',
      ...(status ? { pending: status.pending, processing: status.processing, failed: status.failed, blocked: status.blocked, oldestPendingAt: status.oldestPendingAt, extractionAvailable: status.extractionAvailable, limited: status.limited.map((entry) => entry.limit), gaps: [...new Set(status.gaps.map((entry) => entry.reason))] } : {})
    } : undefined;
    emit(assemblePayload({ head, items: session ? sessionOrder(items) : items, processing }).text);
  } catch {
    // Degraded, never blocking: nothing on stderr and no exit code (§18.4). A
    // session start that failed after the read still says memory is unavailable.
    try { if (trigger === 'SessionStart' && !emitted) emit(unavailablePayload(trigger, 'unreadable', quiet)); } catch {}
  }
}
