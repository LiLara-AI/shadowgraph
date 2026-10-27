// Automatic capture's enrolment, store and hook (plan v1.4.4 §12, §21.3,
// §22.6.1; OD-3; programme plan revision 6 PR-36a, PR-36c). Capture is off
// until the owner turns it on with `activate capture`, which records the
// private store it writes, the origin its captures carry, the projects it
// covers (all of them unless the owner narrows it) and its frozen admission
// limits. Reads are never affected. `capture --hook` then records each
// event's immediate material into that store (runCapture), silently.
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { lstat, readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { activationFile } from './delivery.js';
import { createShadowGraph, SCHEMA_VERSION } from './shadowgraph.js';
import { createStorage } from './storage.js';
import { accessContext, discoverWorkspace, projectBindingFile } from './internal/access-transport.js';
import { captureArtefacts, classifyCaptureSource, soleProgram } from './internal/capture-source.js';
import { outcomeFromExitStatus } from './internal/outcome.js';
import { canonicalPath as fencePath, registryFile } from './internal/deletion-knowledge.js';
import { canonicalPath, repositoryOf as storeRepository } from './internal/owner-files.js';
import { redactToolStructure, renderToolMaterial } from './internal/tool-material.js';
import { captureWithheld, redactValue } from './internal/redaction.js';
import { privilegedExpireCapture, privilegedRecordCapture, privilegedRecordSelfEvent, privilegedRecordTranscript, privilegedSnapshot } from './internal/snapshot.js';
import { TRANSCRIPT_TRIGGERS } from './internal/transcript.js';
import { activeExtraction, workerFenceFile, settlementFile } from './internal/extraction-state.js';
import { extractionBinding, sessionProfileSelected } from './internal/extraction-provenance.js';
import { accountEmailDigest } from './internal/extraction-contract.js';
import { usageFile } from './internal/extraction-budget.js';
import { requestFile } from './internal/extraction-trigger.js';
import { createDestinationFence, fenceLockPath } from './revision-store.js';
import { usableOriginId } from './scope.js';
import { readInvocationContext, identityFile } from './internal/extraction-identity.js';
import { dropSpoolEntry, droppedDirectory, expireSpool, failSpoolEntry, readSpoolEntry, recordDropped, settleSpoolEntry, spoolDirectory, spoolEntries, spoolEvent } from './internal/capture-spool.js';

// Conservative admission limits, frozen until measured figures replace them
// through a gate (§22.6.3). Crossing one refuses new items; it is never raised
// to clear the condition, and nothing accepted is evicted (§22.6.1). Every
// capture rewrites the whole store, so the store's ceiling is kept where a
// burst of writes still fits the hook's deadline (PR-36 design review D-2).
// Before extraction exists (AG-3) the queue only grows, so capture_limited is
// the expected state once it fills: declared, never cleared by raising it.
export const CAPTURE_LIMITS = Object.freeze({ maxStoreBytes: 16 * 1024 * 1024, maxQueueDepth: 2000, maxItemBytes: 64 * 1024, maxItemsPerSession: 1000 });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const projectNames = (value) => Array.isArray(value) && value.every((name) => typeof name === 'string' && name.trim() && name === name.trim()) && new Set(value).size === value.length;

// What is wrong with a capture record's coverage, or null: all projects less
// those excluded, or only those named (§21.4 enrolment; OD-3).
export function coverageIssue(coverage) {
  if (!isObject(coverage)) return 'coverage is an object';
  if (coverage.projects === 'all') return projectNames(coverage.exclude) ? null : 'coverage.exclude names distinct projects';
  if (coverage.projects === 'only') return projectNames(coverage.include) && coverage.include.length > 0 ? null : 'coverage.include names at least one project, each once';
  return 'coverage.projects is all or only';
}

// What is wrong with a capture record's limits, or null.
export const limitsIssue = (limits) => (isObject(limits) && Object.keys(CAPTURE_LIMITS).every((name) => Number.isSafeInteger(limits[name]) && limits[name] > 0) ? null : `limits name ${Object.keys(CAPTURE_LIMITS).join(', ')}, each a positive integer`);

// The walk lives in owner-files.js, which the deletion registry's location
// check shares (PR-37d design §7.2, V-7); it keeps its name here.
export { storeRepository };

// The active capture record, or null: inert unless the record says capture is
// active for an absolute JSON store, with its origin, coverage and limits well
// formed. The record must be a regular file, as for delivery. A SQLite store
// is not captured into: delivery reports it busy while a capture writes it, so
// every delivery at a captured prompt would be lost (PR-36c review C-3).
export async function activeCapture(env = process.env) {
  const file = activationFile(env);
  if (!file) return null;
  try {
    if (!(await lstat(file)).isFile()) return null;
    const capture = JSON.parse(await readFile(file, 'utf8'))?.capabilities?.capture;
    if (capture?.state !== 'active' || typeof capture.store?.file !== 'string' || !isAbsolute(capture.store.file) || capture.store.storage !== 'json') return null;
    if (usableOriginId(capture.originId) !== capture.originId || coverageIssue(capture.coverage) || limitsIssue(capture.limits)) return null;
    if (capture.mcpServerNames !== undefined && !projectNames(capture.mcpServerNames)) return null;
    return capture;
  } catch {
    return null;
  }
}

// The events the hook takes (plan §12.1; PR-36c, PR-36): a prompt, a tool
// call's result or failure and the assistant's final reply at a stop, as
// immediate material; and a stop, the host's compaction and the session's end
// as the transcript cursor's triggers. PreCompact and SessionEnd carry no
// material of their own.
export const CAPTURED_EVENTS = Object.freeze(['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop', 'PreCompact', 'SessionEnd']);

// The hook's own deadline, below the template's 10-second timeout (PR-36
// design review D-1); SHADOWGRAPH_CAPTURE_DEADLINE_MS can only shorten it. A
// write already inside the store may run past it to the hard cap, still below
// the timeout, rather than be killed there (D-3).
export const CAPTURE_DEADLINE_MS = 5000;
export const CAPTURE_HARD_CAP_MS = 8000;
export function captureDeadlineMs(env = process.env) {
  const requested = Number(env.SHADOWGRAPH_CAPTURE_DEADLINE_MS);
  return requested > 0 ? Math.min(requested, CAPTURE_DEADLINE_MS) : CAPTURE_DEADLINE_MS;
}
// A commit starts only with at least this long left, and at least twice what
// the store has taken so far (D-3).
const COMMIT_MARGIN_MS = 250;
// A lock whose owner has died is taken over after this long; a live owner
// keeps its lock fresh, so this is safe short (D-3).
const CAPTURE_STALE_LOCK_MS = 2000;
const GIT_TIMEOUT_MS = 3000;
const STORE_SIDE_FILES = Object.freeze(['-wal', '-shm', '-journal', '.control.json']);
const named = (value) => typeof value === 'string' && value.trim() !== '';
export { renderToolMaterial };

// What the host observed of a tool call's outcome (design review D-13), scoped
// to that call: observed only as a success, from a Bash or PowerShell call's
// own `exit_code` of 0 when the command is a single simple command -- no
// pipeline, list or substitution, whose status is another program's. Any
// other status is absent: a non-zero exit is not a failure by itself (PR-24's
// untrusted-status rule, applied here as src/internal/outcome.js asks) --
// grep, diff, robocopy or a wrapper such as sudo or timeout use it for other
// results -- and no program list can tell them apart. A call with no
// tool_use_id has nothing to scope an outcome to, and records none.
export function toolOutcome({ event, toolCallId, toolName, toolInput, toolResponse }) {
  if (!named(toolCallId)) return null;
  // soleProgram reads only a Bash or PowerShell command; any other tool has none.
  const succeeded = isObject(toolResponse) && toolResponse.exit_code === 0 && soleProgram(toolInput?.command, toolName) !== null;
  return outcomeFromExitStatus(succeeded ? 0 : undefined, { event, toolCallId, toolName });
}

// A host event as capture takes it (plan §12.1; the host's documented fields,
// confirmed at AG-2), or null when it carries nothing to capture: its session,
// working directory, the material, what identifies it, and its transcript's
// path when that is an absolute path to a .jsonl file. No field is inferred
// from another; an absent one is null. PreCompact, SessionEnd and a Stop with
// no final message carry no material of their own: they come back without
// text, as the transcript cursor's triggers (PR-36).
export function observedEvent(payload) {
  if (!isObject(payload) || !CAPTURED_EVENTS.includes(payload.hook_event_name) || !named(payload.session_id)) return null;
  const event = payload.hook_event_name;
  const transcriptPath = named(payload.transcript_path) && isAbsolute(payload.transcript_path) && payload.transcript_path.toLowerCase().endsWith('.jsonl') ? payload.transcript_path : null;
  const base = { event, sessionId: payload.session_id, cwd: named(payload.cwd) ? payload.cwd : null, role: null, hostEventId: null, toolCallId: null, toolName: null, toolInput: null, prompt: null, outcome: null, transcriptPath };
  if (event === 'UserPromptSubmit') return named(payload.prompt) ? { ...base, role: 'user', hostEventId: named(payload.message_id) ? payload.message_id : null, prompt: payload.prompt, text: payload.prompt } : null;
  if (event === 'Stop') return named(payload.last_assistant_message) ? { ...base, role: 'assistant', text: payload.last_assistant_message } : base;
  if (event === 'PreCompact' || event === 'SessionEnd') return base;
  if (!named(payload.tool_name)) return null;
  const tool = { ...base, toolName: payload.tool_name, toolInput: payload.tool_input ?? null, toolCallId: named(payload.tool_use_id) ? payload.tool_use_id : null };
  return {
    ...tool,
    outcome: toolOutcome({ ...tool, toolResponse: payload.tool_response }),
    text: renderToolMaterial({ toolName: tool.toolName, toolInput: payload.tool_input, toolResponse: payload.tool_response, error: event === 'PostToolUseFailure' ? payload.error : undefined })
  };
}

// The store's bytes on disk (design review D-2, D-3): the file, its SQLite side
// files, and any save's temporary file beside it, which a writer killed
// mid-save may have left.
export async function storeFootprint(given) {
  // The file a save writes, which a link names (re-review N-3).
  const file = await canonicalPath(given).catch(() => given);
  const size = async (path) => (await lstat(path).catch(() => null))?.size ?? 0;
  let total = await size(file);
  for (const suffix of STORE_SIDE_FILES) total += await size(`${file}${suffix}`);
  const prefix = `.${basename(file)}.`;
  for (const name of await readdir(dirname(file)).catch(() => [])) if (name.startsWith(prefix) && name.endsWith('.tmp')) total += await size(join(dirname(file), name));
  return total;
}

// The record's limits, none above the build's own (design review D-18): a
// hand edit of the record can lower a limit, never raise one.
export const admissionLimits = (limits) => Object.fromEntries(Object.entries(CAPTURE_LIMITS).map(([name, ceiling]) => [name, Math.min(limits[name], ceiling)]));

const covered = (coverage, project) => (coverage.projects === 'all' ? !coverage.exclude.includes(project) : coverage.include.includes(project));

// The session's transcript, opened once for reading (PR-36 design §11): null
// when it cannot be read -- no path, an unreadable one, or anything but a
// regular file, which is never opened -- and { ref, missing: true } when it
// does not exist yet. `ref` is the digest of its canonical path (its folder's
// real path and its name, lower-cased on Windows), the same whether or not
// the file exists; no path is stored.
export async function openTranscript(path) {
  if (!named(path)) return null;
  let ref;
  try {
    const canonical = join(await canonicalPath(dirname(path)), basename(path));
    ref = createHash('sha256').update(process.platform === 'win32' ? canonical.toLowerCase() : canonical).digest('hex');
  } catch { return null; }
  try {
    if (!(await stat(path)).isFile()) return null;
  } catch (error) {
    return error?.code === 'ENOENT' ? { ref, missing: true } : null;
  }
  let fd;
  try {
    // Non-blocking where the platform has it, so a FIFO swapped in after the
    // check cannot hold the hook until its deadline.
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    if (!fstatSync(fd).isFile()) throw new Error('not a regular file');
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    return error?.code === 'ENOENT' ? { ref, missing: true } : null;
  }
  return {
    ref,
    size: () => fstatSync(fd).size,
    // Only at a named offset: readSync takes a null or negative position as
    // "where the file's own position is".
    read: (start, length) => {
      if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length <= 0) return Buffer.alloc(0);
      const bytes = Buffer.alloc(length);
      return bytes.subarray(0, readSync(fd, bytes, 0, length, start));
    },
    close: () => closeSync(fd)
  };
}

// One capture (plan §12.1, §12.2; PR-36c, PR-36): the event's material, and
// what the transcript cursor reads, written into the private store the
// capture record names, under one hold of its fence with no revision retries
// (design review D-2), or nothing at all. Nothing is written for a store
// inside a repository (§21.3), for a project not resolved from a worktree
// binding the store itself recorded (D-5) or not covered (OD-3) -- except that
// a session's transcript stops being read once an event comes from there --
// for a refusal that changes nothing, or when too little time is left to
// finish the commit (D-3). A ShadowGraph self-event is counted and nothing
// else. A host re-delivery of an item already held writes nothing new. `post`
// tells the thread keeping the deadline when the store is entered and left.
// Resolves to what happened, for tests; `now` and `registry` are test seams.
export async function runCapture({ capture, input, deadline, record = null, registry = registryFile(), home = homedir(), cwd = process.cwd(), post = () => {}, now = Date.now, env = process.env, report = {} }) {
  if (sessionProfileSelected(env)) return 'session_profile_selected';
  const extraction = await activeExtraction(env);
  const sessionEmail = Object.entries(env).find(([name]) => name.toUpperCase() === 'CLAUDE_CODE_USER_EMAIL')?.[1];
  const bound = extraction?.executor.accountEmailFingerprint;
  if (extraction && sessionEmail && (!bound || accountEmailDigest(extraction.executor.accountSalt, sessionEmail) !== bound)) return 'session_account_differs';
  let event;
  let payload;
  try {
    payload = JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input);
    event = observedEvent(payload);
  } catch { return 'unreadable'; }
  if (event === null) return 'not_captured';
  // The account the session's material belongs to, judged by this event's own
  // hook. A host that names its session's account (Desktop) was compared with
  // the bound one above. A CLI session names none: without a profile selector
  // (refused above) or a provider route of its own it runs under the default
  // profile's current sign-in, which the CLI's own configuration names; only
  // when that is the bound account is the material bound (a digest compared,
  // nothing kept). Any other session's capture stays local and unbound.
  const claude = extraction && (extraction.executor.provider ?? 'claude') === 'claude';
  const boundBy = claude && (sessionEmail || (!providerRouteSelected(env) && await defaultProfileIsBound(extraction, home))) ? extraction.activationId : null;
  const common = { capture, deadline, record, registry, home, post, now, env };
  if (record === null) return captureEvent({ ...common, payload, event, cwd, boundBy });
  const spool = spoolDirectory(record);
  const transcriptSize = event.transcriptPath ? (await stat(event.transcriptPath).catch(() => null))?.size ?? null : null;
  // Nothing unredacted is kept anywhere (PR-37b M-2): the material fields are
  // redacted -- a tool's input and response by the renderer's own credential
  // rules first -- before the spool sees them, and a payload the checker still
  // flags is never spooled; it takes the direct path alone.
  const safe = { ...payload };
  for (const name of SPOOLED_MATERIAL) if (Object.hasOwn(safe, name)) safe[name] = redactValue(redactToolStructure(safe[name]));
  const safeInput = JSON.stringify(safe);
  const destination = { store: capture.store.file, originId: capture.originId };
  const kept = captureWithheld(safeInput) ? { kept: false, reason: 'material_withheld' } : await spoolEvent({ spool, input: safeInput, cwd, transcript: transcriptSize, boundBy, destination, now });
  if (!kept.kept) {
    // No durable copy: the direct path as before, and a loss it cannot avoid
    // is recorded, never silent.
    let outcome;
    try { outcome = await captureEvent({ ...common, payload, event, cwd, boundBy }); }
    catch (error) { outcome = error?.code === 'storage_lock_timeout' ? 'store_busy' : 'store_failed'; }
    if (['store_busy', 'store_failed', 'out_of_time'].includes(outcome)) await recordDropped({ spool, reason: `${kept.reason}:${outcome}`, input, at: now() });
    return outcome;
  }
  return drainSpool({ ...common, spool, own: kept.entry, destination, report });
}

// Whether the default profile's current sign-in, as the CLI's own
// configuration names it, is the account extraction bound: a keyed digest of
// its e-mail compared with the one activation kept. Unreadable, absent or
// different is not bound.
async function defaultProfileIsBound(extraction, home) {
  const bound = extraction.executor.accountEmailFingerprint;
  if (!bound) return false;
  try {
    const file = join(home, '.claude.json');
    if ((await stat(file)).size > 16 * 1024 * 1024) return false;
    const email = JSON.parse(await readFile(file, 'utf8'))?.oauthAccount?.emailAddress;
    return accountEmailDigest(extraction.executor.accountSalt, email) === bound;
  } catch { return false; }
}

// The hook payload's material fields; the rest identifies the event.
const SPOOLED_MATERIAL = Object.freeze(['prompt', 'last_assistant_message', 'tool_input', 'tool_response', 'error']);

// The variables that put a session on a provider route of its own, apart from
// the default profile's sign-in.
const PROVIDER_ROUTE = /^(?:ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|ANTHROPIC_BASE_URL|CLAUDE_CODE_USE_[A-Z_]+)$/iu;
export const providerRouteSelected = (env) => Object.entries(env).some(([name, value]) => PROVIDER_ROUTE.test(name) && typeof value === 'string' && value !== '');

// Outcomes that leave an entry waiting for a later hook: the store was busy,
// the deadline came first, or the store is newer than this runtime.
const RETRY_LATER = new Set(['store_busy', 'out_of_time', 'newer_schema']);
// The outcomes after which a Stop or SessionEnd asks for extraction (extraction-trigger.js).
const EXTRACTION_ELIGIBLE = new Set(['written', 'nothing_new', 'already_held', 'transcript', 'refused']);

// One spooled entry into the store. The entry leaves the spool once the store
// has decided it; otherwise it waits, and a failure that is not contention
// counts an attempt (capture-spool.js). An entry kept for another store or
// origin is never written here: it is dropped with a marker. { outcome, stop }:
// stop when the store cannot take more now.
async function replayEntry({ spool, entry, destination, ...common }) {
  let value, payload, event;
  try {
    value = await readSpoolEntry(spool, entry);
    payload = JSON.parse(value.input.charCodeAt(0) === 0xfeff ? value.input.slice(1) : value.input);
    event = observedEvent(payload);
  } catch (error) {
    if (error?.code === 'ENOENT') return { outcome: 'replayed' };
    await dropSpoolEntry(spool, entry, 'spool_entry_unreadable');
    return { outcome: 'dropped' };
  }
  if (value.destination?.store !== destination.store || value.destination?.originId !== destination.originId) {
    await dropSpoolEntry(spool, entry, 'capture_destination_changed');
    return { outcome: 'dropped' };
  }
  if (event === null) { await settleSpoolEntry(spool, entry); return { outcome: 'not_captured' }; }
  let outcome;
  try {
    outcome = await captureEvent({ ...common, payload, event, cwd: value.cwd, transcriptSize: value.transcriptSize ?? null, boundBy: value.boundBy ?? null });
  } catch (error) {
    if (error?.code !== 'storage_lock_timeout') {
      await failSpoolEntry(spool, entry, error?.code ?? 'capture_failed');
      return { outcome: 'store_failed' };
    }
    outcome = 'store_busy';
  }
  if (RETRY_LATER.has(outcome)) return { outcome, stop: true };
  await settleSpoolEntry(spool, entry);
  return { outcome, terminal: ['Stop', 'SessionEnd'].includes(event.event) };
}

// Every spooled event is written by the one hook that holds the drain, oldest
// first, so a session's events reach the store in their order and its first
// transcript cursor is anchored by its first event. A hook that finds the drain
// taken leaves its entry to the drainer, which lists the spool again before it
// stops; one that arrives after that waits for the next hook, reported as
// waiting input. Resolves the hook's own entry's outcome, or 'spooled'.
async function drainSpool({ spool, own, destination, deadline, now, report, ...common }) {
  const context = { ...common, spool, destination, deadline, now };
  let result = 'spooled';
  try {
    await createDestinationFence(join(spool, 'drain'), { lockTimeoutMs: 0, staleLockMs: CAPTURE_STALE_LOCK_MS }).run(async () => {
      // Entries age by the file system's clock, not the injected one.
      await expireSpool(spool);
      const tried = new Set();
      for (let pass = 0; pass < 4; pass += 1) {
        const waiting = (await spoolEntries(spool)).filter((entry) => !tried.has(entry.name));
        if (!waiting.length) return;
        for (const entry of waiting) {
          if (now() + 2 * COMMIT_MARGIN_MS >= deadline) {
            // The deadline stops the drain; an own entry not reached waits for that reason.
            if (!tried.has(own.name) && result === 'spooled') result = 'out_of_time';
            return;
          }
          tried.add(entry.name);
          const replayed = await replayEntry({ ...context, entry });
          // A Stop or SessionEnd written here asks for extraction, whichever hook drained it.
          if (replayed.terminal && EXTRACTION_ELIGIBLE.has(replayed.outcome)) report.terminalWritten = true;
          // The own entry, or one ahead of it that stopped the drain: its outcome is the own entry's too.
          if (entry.key === own.key || (replayed.stop && entry.at <= own.at)) result = replayed.outcome;
          if (replayed.stop) return;
        }
      }
    });
  } catch {}
  return result;
}

// One event into the store: what a capture was before the spool.
async function captureEvent({ capture, payload, event, deadline, record, registry, home, cwd, post, now, env, boundBy = null, transcriptSize = null }) {
  const extraction = boundBy ? await activeExtraction(env) : null;
  // Bound only under the activation the event's own hook judged it by.
  const provenance = extraction && extraction.activationId === boundBy ? { extractionBinding: extractionBinding(extraction) } : {};
  const file = capture.store.file;
  if (await storeRepository(file)) return 'store_inside_repository';
  const workspace = await discoverWorkspace(cwd, { timeout: Math.max(1, Math.min(GIT_TIMEOUT_MS, deadline - now())) });
  const markerFiles = [projectBindingFile(workspace, 'worktree'), ...(workspace.commonDir ? [projectBindingFile(workspace, 'shared_repository')] : [])];
  // Canonical as the registry lock's fence names it (PR-37d design §7.3).
  const registryCanonical = registry && await fencePath(registry);
  // Opened before the store's lock is taken, so the lock is never held while
  // the file is found, and after anything else here that can throw.
  const invocationContext = await readInvocationContext({ env, now });
  const workerFiles = (await Promise.all([identityFile(env), usageFile(env), workerFenceFile(env), settlementFile(env), requestFile(env)].map(async file => [await canonicalPath(file), await fenceLockPath(file)]))).flat();
  const artefactDirectories = record ? await Promise.all([spoolDirectory(record), droppedDirectory(spoolDirectory(record))].map((path) => canonicalPath(path).catch(() => path))) : [];
  const transcript = await openTranscript(event.transcriptPath);
  // A replayed event anchors a session's first cursor where the transcript
  // ended when the event arrived; a cursor already made reads on as usual
  // (a size below it would read as a rewritten transcript).
  const transcriptFor = (session) => (transcript && !transcript.missing && Number.isSafeInteger(transcriptSize) && transcriptSize >= 0 && !session?.cursor
    ? { ...transcript, size: () => Math.min(transcript.size(), transcriptSize) } : transcript);
  const lockTimeoutMs = deadline - now() - COMMIT_MARGIN_MS;
  if (lockTimeoutMs <= 0) {
    transcript?.close?.();
    return 'out_of_time';
  }
  let outcome = 'written';
  const skip = (why) => { outcome = why; return null; };
  let store;
  post('enter');
  try {
    // Owner-only, whatever mode the store had (FND-P6-11; PR-37b R3).
    store = await createStorage({ type: capture.store.storage, file, lockTimeoutMs, staleLockMs: CAPTURE_STALE_LOCK_MS, mode: 0o600, env });
    await store.update(async (current) => {
      const entered = now();
      // The commit's cost is estimated from the work before the transcript is
      // read, which does not make the store slower to write; the read stops
      // while a commit still fits, with one more margin for its last line (D-3).
      let basis = null;
      const commitCost = () => Math.max(COMMIT_MARGIN_MS, 2 * (basis ?? now() - entered));
      const mayContinue = () => now() + commitCost() + COMMIT_MARGIN_MS <= deadline;
      if (!isObject(current) || current.schemaVersion > SCHEMA_VERSION) return skip('newer_schema');
      // Measured under the fence, so a burst of writers cannot each see the
      // store below its ceiling (PR-36b amendment).
      const storeBytes = await storeFootprint(file);
      const held = new Set((current.records ?? []).filter((record) => record?.kind === 'capture').map((record) => record.id));
      const session = (current.captureSessions ?? []).find((entry) => entry?.originId === capture.originId && entry?.sessionId === event.sessionId);
      const graph = createShadowGraph({ now: () => new Date(now()).toISOString() });
      graph.importData(current);
      let changed = privilegedExpireCapture(graph, { mayContinue }).changed;
      const bound = accessContext(graph, {}, 'cli', workspace, { confirmedByStore: true }).binding?.project ?? null;
      const project = bound !== null && covered(capture.coverage, bound) ? bound : null;
      const workerInvocations = invocationContext.workerInvocations.filter(row => Date.parse(row.from) <= entered && entered < Date.parse(row.to));
      const context = { ...captureArtefacts({ storeFile: file, runtimeDirectory: capture.runtime?.path ?? null, activationFile: record, markerFiles, registryFile: registryCanonical, workerFiles, artefactDirectories }), home, mcpServerNames: capture.mcpServerNames ?? ['shadowgraph'], workerInvocations, observedAt: new Date(entered).toISOString(), correlationTokens: workerInvocations.map(row => row.correlationToken) };
      // The transcript cursor's step; a throw is undone by its own transaction
      // and never costs the event's own item.
      const cursor = (step) => {
        basis ??= now() - entered;
        try {
          return privilegedRecordTranscript(graph, {
            originId: capture.originId, sessionId: event.sessionId, project, activatedAt: capture.changedAt,
            trigger: null, triggerItemId: null, transcript: null, mayContinue,
            observation: { host: 'claude-code', hostVersion: null, toolName: null, cwd: null, outcome: null, ...provenance },
            admission: { limits: admissionLimits(capture.limits), storeBytes },
            isSelfTool: (toolName, toolInput) => classifyCaptureSource({ event: 'PostToolUse', sessionId: event.sessionId, cwd: event.cwd, toolName, toolInput, prompt: null }, context).selfEvent,
            ...step
          });
        } catch { return null; }
      };
      if (project === null) {
        changed = Boolean(cursor({})?.changed) || changed;
        if (!changed) return skip(bound === null ? 'project_unresolved' : 'not_covered');
        outcome = 'transcript_stopped';
      } else {
        const classified = classifyCaptureSource({ event: event.event, sessionId: event.sessionId, cwd: event.cwd, toolName: event.toolName, toolInput: event.toolInput, prompt: event.prompt }, context);
        const source = { event: event.event, sessionId: event.sessionId };
        if (classified.selfEvent) {
          // A session deletion records withhold is never written to (PR-37a).
          const counted = privilegedRecordSelfEvent(graph, { project, originId: capture.originId, signal: classified.signal, source });
          changed = Boolean(cursor({ selfEvent: true })?.changed) || !counted?.refused || changed;
          outcome = 'self_event';
          if (!changed) return skip(outcome);
        } else {
          let item = null;
          if (event.text === undefined) outcome = 'nothing_new';
          else {
            const toolEvent = event.event === 'PostToolUse' || event.event === 'PostToolUseFailure';
            const result = privilegedRecordCapture(graph, {
              project, originId: capture.originId, text: event.text, sourceIdentity: classified.sourceIdentity,
              source: { ...source, role: event.role, hostEventId: event.hostEventId, toolCallId: event.toolCallId },
              observation: { host: 'claude-code', hostVersion: null, toolName: event.toolName, cwd: event.cwd, outcome: event.outcome, ...provenance },
              admission: { limits: admissionLimits(capture.limits), storeBytes },
              // The writer's split is rendered from these fields. They are not stored.
              ...(toolEvent ? { toolCall: { toolName: payload.tool_name, toolInput: payload.tool_input, toolResponse: payload.tool_response, error: payload.error } } : {})
            });
            if (result.refused) {
              changed = result.changed || changed;
              outcome = 'refused';
            // A host re-delivery returns the item the store already held.
            } else if (held.has(result.id)) outcome = 'already_held';
            else [item, changed] = [result, true];
          }
          const read = cursor({ trigger: TRANSCRIPT_TRIGGERS.includes(event.event) ? event.event : null, triggerItemId: item?.id ?? null, transcript: transcriptFor(session) });
          if (read?.changed) {
            changed = true;
            if (outcome === 'nothing_new' || outcome === 'already_held') outcome = 'transcript';
          }
          if (!changed) return skip(outcome);
        }
      }
      if (now() + commitCost() > deadline) return skip('out_of_time');
      return privilegedSnapshot(graph);
    });
    return outcome;
  } finally {
    store?.close?.();
    transcript?.close?.();
    post('leave');
  }
}

// Shared by the CLI lifecycle verbs. The exact activation store is the only
// destination, active or deactivated; environment/manual-store overrides do
// not participate. Callers retain the record bytes for confirmation races.
export async function captureStoreForLifecycle(env = process.env) {
  const refused = (code) => { throw Object.assign(new Error(`Capture cleanup refused (${code})`), { code }); };
  const record = activationFile(env);
  if (!record || !(await lstat(record).catch(() => null))?.isFile()) refused('capture_cleanup_record_unavailable');
  let capture, recordText;
  try { recordText = await readFile(record, 'utf8'); capture = JSON.parse(recordText)?.capabilities?.capture; }
  catch { refused('capture_cleanup_record_unavailable'); }
  const file = capture?.store?.file;
  const type = capture?.store?.storage;
  if (!['active', 'deactivated'].includes(capture?.state) || typeof file !== 'string' || !isAbsolute(file) || !['json', 'sqlite'].includes(type)) refused('capture_cleanup_store_unavailable');
  const repository = await storeRepository(file);
  if (repository) throw Object.assign(new Error(`Capture lifecycle refused: ${file} lies in ${repository}; plan section 21.3 prohibits private capture inside a repository (store_inside_repository)`), { code: 'store_inside_repository' });
  // In particular, opening SQLite must not create a new empty store merely
  // to discover that the activated one no longer exists.
  if (!(await stat(file).catch(() => null))?.isFile()) refused('capture_cleanup_store_unavailable');
  return { file, type, record, recordText };
}

// Explicit expiry and post-deactivation cleanup have the hook's write
// boundary: update refuses pending purge/restore before the callback, and
// its commit cannot write deletion knowledge.
export async function expireCaptureStore({ env = process.env, now = Date.now, timeoutMs = CAPTURE_DEADLINE_MS, deadline = now() + timeoutMs, endLimits = false } = {}) {
  const deferred = () => ({ status: 'deferred', reason: 'out_of_time', changed: false, expired: 0, keptCited: 0, sessionsRemoved: 0 });
  const refused = (code) => { throw Object.assign(new Error(`Capture cleanup refused (${code})`), { code }); };
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || !Number.isFinite(deadline)) refused('capture_cleanup_invalid_deadline');
  if (now() + COMMIT_MARGIN_MS >= deadline) return deferred();
  const { file, type } = await captureStoreForLifecycle(env);
  const lockTimeoutMs = deadline - now() - COMMIT_MARGIN_MS;
  if (lockTimeoutMs <= 0) return deferred();
  let store;
  let result = deferred();
  try {
    store = await createStorage({ type, file, env, lockTimeoutMs, staleLockMs: CAPTURE_STALE_LOCK_MS, mode: 0o600 });
    await store.update((current) => {
      const entered = now();
      const commitCost = () => Math.max(COMMIT_MARGIN_MS, 2 * (now() - entered));
      const mayContinue = () => now() + commitCost() + COMMIT_MARGIN_MS <= deadline;
      if (!mayContinue()) return null;
      if (!isObject(current) || current.schemaVersion > SCHEMA_VERSION) refused('capture_cleanup_newer_schema');
      const graph = createShadowGraph({ now: () => new Date(now()).toISOString() });
      graph.importData(current);
      const swept = privilegedExpireCapture(graph, { mayContinue, endLimits });
      if (now() + commitCost() >= deadline) return null;
      result = { status: swept.more ? 'partial' : 'complete', ...swept };
      return swept.changed ? privilegedSnapshot(graph) : null;
    });
    return result;
  } finally { store?.close?.(); }
}

// The deadline, kept on a thread the capture work never blocks (design review
// D-3): at the deadline the process exits, unless the worker is inside the
// store -- then it may finish, up to the hard cap, since exiting there would
// leave the store's lock held and a temporary file behind. Resolves when the
// worker exits.
export function superviseCapture(worker, { deadline, hardCap, exit = () => process.exit(0), now = Date.now }) {
  let inside = false;
  let timer = null;
  const arm = (at) => {
    clearTimeout(timer);
    timer = setTimeout(check, Math.max(0, at - now()));
    timer.unref?.();
  };
  const check = () => {
    if (!inside || now() >= hardCap) exit();
    else arm(hardCap);
  };
  worker.on('message', (message) => {
    if (message === 'enter') inside = true;
    if (message === 'leave') {
      inside = false;
      if (now() >= deadline) exit();
    }
  });
  worker.on('error', () => {});
  arm(deadline);
  return new Promise((settle) => worker.once('exit', () => {
    clearTimeout(timer);
    settle();
  }));
}
