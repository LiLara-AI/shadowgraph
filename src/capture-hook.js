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
import { KEYED_NAMES, KEYED_VALUES, REDACTED, isCredentialName } from './internal/redaction.js';
import { privilegedExpireCapture, privilegedRecordCapture, privilegedRecordSelfEvent, privilegedRecordTranscript, privilegedSnapshot } from './internal/snapshot.js';
import { TRANSCRIPT_TRIGGERS } from './internal/transcript.js';
import { usableOriginId } from './scope.js';

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

// A key or argument naming a credential, by the redactor's names or the short
// ones a tool's input uses, with an argument's leading dashes ignored (PR-37b
// review F4, re-review NF-4).
const SHORT_CREDENTIAL_KEYS = new Set(['pass', 'pw', 'auth', 'cookie', 'cookies', 'set-cookie']);
const credentialKey = (name) => isCredentialName(name) || SHORT_CREDENTIAL_KEYS.has(String(name).toLowerCase().replace(/^-+/u, ''));
// The value after a user flag that carries a password (`-u user:pass`).
const USER_FLAG = /^(?:-u|--user)$/u;

// A tool call as text (design review D-12): its name, then every leaf of its
// input, its response and a failure's error, labelled by path. A string keeps
// its own line breaks, so a delivered block inside one is found and stripped
// as in plain text; any other value is written as JSON. Walked without
// recursion.
export function renderToolMaterial({ toolName, toolInput, toolResponse, error }) {
  const lines = [`tool: ${toolName}`];
  const pending = [['error', error], ['response', toolResponse], ['input', toolInput]].filter(([, value]) => value !== undefined);
  // What a credential names is rendered as one redacted line, whatever it
  // holds (PR-37b R1): the value of a key named for one, the value field of a
  // pair keyed by one, and an array element after one (a header pair, an
  // argument vector's `--password <value>`). An array of one-line strings is
  // one line, as a command is, so the redactor's flag rules apply to it.
  const hides = (item) => item !== null && item !== undefined;
  const follows = (array, index) => index > 0 && typeof array[index - 1] === 'string'
    && (credentialKey(array[index - 1]) || (USER_FLAG.test(array[index - 1]) && typeof array[index] === 'string' && array[index].includes(':')));
  while (pending.length) {
    const [path, value, hidden] = pending.pop();
    if (hidden) lines.push(`${path}: ${REDACTED}`);
    else if (typeof value === 'string') lines.push(`${path}:`, value);
    else if (Array.isArray(value) && value.length && value.every((item) => typeof item === 'string' && !/[\r\n]/u.test(item))) {
      lines.push(`${path}: ${value.map((item, index) => (follows(value, index) ? REDACTED : item)).join(' ')}`);
    } else if (isObject(value) || (Array.isArray(value) && value.length)) {
      const keyed = !Array.isArray(value) && KEYED_NAMES.some((name) => typeof value[name] === 'string' && isCredentialName(value[name]));
      const entries = Array.isArray(value)
        ? value.map((item, index) => [`${path}[${index}]`, item, follows(value, index) && hides(item)])
        : Object.entries(value).map(([key, item]) => [`${path}.${key}`, item, hides(item) && (credentialKey(key) || (keyed && KEYED_VALUES.has(key)))]);
      if (!entries.length) lines.push(`${path}: {}`);
      for (let at = entries.length - 1; at >= 0; at -= 1) pending.push(entries[at]);
    } else lines.push(`${path}: ${JSON.stringify(value)}`);
  }
  return lines.join('\n');
}

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
export async function runCapture({ capture, input, deadline, record = null, registry = registryFile(), home = homedir(), cwd = process.cwd(), post = () => {}, now = Date.now, env = process.env }) {
  let event;
  try { event = observedEvent(JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input)); } catch { return 'unreadable'; }
  if (event === null) return 'not_captured';
  const file = capture.store.file;
  if (await storeRepository(file)) return 'store_inside_repository';
  const workspace = await discoverWorkspace(cwd, { timeout: Math.max(1, Math.min(GIT_TIMEOUT_MS, deadline - now())) });
  const markerFiles = [projectBindingFile(workspace, 'worktree'), ...(workspace.commonDir ? [projectBindingFile(workspace, 'shared_repository')] : [])];
  // Canonical as the registry lock's fence names it (PR-37d design §7.3).
  const registryCanonical = registry && await fencePath(registry);
  // Opened before the store's lock is taken, so the lock is never held while
  // the file is found, and after anything else here that can throw.
  const transcript = await openTranscript(event.transcriptPath);
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
      const graph = createShadowGraph({ now: () => new Date(now()).toISOString() });
      graph.importData(current);
      let changed = privilegedExpireCapture(graph, { mayContinue }).changed;
      const bound = accessContext(graph, {}, 'cli', workspace, { confirmedByStore: true }).binding?.project ?? null;
      const project = bound !== null && covered(capture.coverage, bound) ? bound : null;
      const context = { ...captureArtefacts({ storeFile: file, runtimeDirectory: capture.runtime?.path ?? null, activationFile: record, markerFiles, registryFile: registryCanonical }), home, mcpServerNames: capture.mcpServerNames ?? ['shadowgraph'], correlationTokens: [], workerSessionIds: [] };
      // The transcript cursor's step; a throw is undone by its own transaction
      // and never costs the event's own item.
      const cursor = (step) => {
        basis ??= now() - entered;
        try {
          return privilegedRecordTranscript(graph, {
            originId: capture.originId, sessionId: event.sessionId, project, activatedAt: capture.changedAt,
            trigger: null, triggerItemId: null, transcript: null, mayContinue,
            observation: { host: 'claude-code', hostVersion: null, toolName: null, cwd: null, outcome: null },
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
            const result = privilegedRecordCapture(graph, {
              project, originId: capture.originId, text: event.text, sourceIdentity: classified.sourceIdentity,
              source: { ...source, role: event.role, hostEventId: event.hostEventId, toolCallId: event.toolCallId },
              observation: { host: 'claude-code', hostVersion: null, toolName: event.toolName, cwd: event.cwd, outcome: event.outcome },
              admission: { limits: admissionLimits(capture.limits), storeBytes }
            });
            if (result.refused) {
              changed = result.changed || changed;
              outcome = 'refused';
            // A host re-delivery returns the item the store already held.
            } else if (held.has(result.id)) outcome = 'already_held';
            else [item, changed] = [result, true];
          }
          const read = cursor({ trigger: TRANSCRIPT_TRIGGERS.includes(event.event) ? event.event : null, triggerItemId: item?.id ?? null, transcript });
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
