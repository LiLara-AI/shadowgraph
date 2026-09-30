// Automatic capture's enrolment, store and hook (plan v1.4.4 §12, §21.3,
// §22.6.1; OD-3; programme plan revision 6 PR-36a, PR-36c). Capture is off
// until the owner turns it on with `activate capture`, which records the
// private store it writes, the origin its captures carry, the projects it
// covers (all of them unless the owner narrows it) and its frozen admission
// limits. Reads are never affected. `capture --hook` then records each
// event's immediate material into that store (runCapture), silently.
import { lstat, readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { activationFile } from './delivery.js';
import { createShadowGraph, SCHEMA_VERSION } from './shadowgraph.js';
import { createStorage } from './storage.js';
import { accessContext, discoverWorkspace, projectBindingFile } from './internal/access-transport.js';
import { captureArtefacts, classifyCaptureSource, soleProgram } from './internal/capture-source.js';
import { outcomeFromExitStatus } from './internal/outcome.js';
import { canonicalPath } from './internal/owner-files.js';
import { privilegedRecordCapture, privilegedRecordSelfEvent, privilegedSnapshot } from './internal/snapshot.js';
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

// The git repository a store path lies in, or null (§21.3, VAR-14): any
// directory above it holding a `.git` entry (a repository, or a worktree's
// pointer file), or a `.git` directory itself, walked from the path as the
// file system resolves it now, so a link or junction placed since activation
// is followed. No subprocess, so the hook can ask it on every event. A working
// tree whose git directory lies elsewhere (`core.worktree`, as dotfiles set-ups
// use) leaves no trace on this path and is not detected: a declared limit.
export async function storeRepository(file) {
  for (let directory = dirname(await canonicalPath(file)); ; directory = dirname(directory)) {
    if (basename(directory) === '.git') return directory;
    // Only an entry that is not there is absent; any other answer (access
    // denied, a path too long) counts as one, so the check fails closed.
    if (await lstat(join(directory, '.git')).then(() => true, (error) => !['ENOENT', 'ENOTDIR'].includes(error.code))) return directory;
    if (dirname(directory) === directory) return null;
  }
}

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

// The events whose immediate material the hook captures (plan §12.1; PR-36c):
// a prompt, a tool call's result or failure, and the assistant's final reply
// at a stop. PreCompact and SessionEnd carry none: they are flush triggers
// for the transcript cursor (PR-36), and until then are not captured.
export const CAPTURED_EVENTS = Object.freeze(['UserPromptSubmit', 'PostToolUse', 'PostToolUseFailure', 'Stop']);

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
const STORE_SIDE_FILES = Object.freeze(['-wal', '-shm', '-journal']);
const named = (value) => typeof value === 'string' && value.trim() !== '';

// A tool call as text (design review D-12): its name, then every leaf of its
// input, its response and a failure's error, labelled by path. A string keeps
// its own line breaks, so a delivered block inside one is found and stripped
// as in plain text; any other value is written as JSON. Walked without
// recursion.
export function renderToolMaterial({ toolName, toolInput, toolResponse, error }) {
  const lines = [`tool: ${toolName}`];
  const pending = [['error', error], ['response', toolResponse], ['input', toolInput]].filter(([, value]) => value !== undefined);
  while (pending.length) {
    const [path, value] = pending.pop();
    if (typeof value === 'string') lines.push(`${path}:`, value);
    else if (isObject(value) || (Array.isArray(value) && value.length)) {
      const entries = Array.isArray(value) ? value.map((item, index) => [`${path}[${index}]`, item]) : Object.entries(value).map(([key, item]) => [`${path}.${key}`, item]);
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
// working directory, the material, and what identifies it. No field is
// inferred from another; an absent one is null.
export function observedEvent(payload) {
  if (!isObject(payload) || !CAPTURED_EVENTS.includes(payload.hook_event_name) || !named(payload.session_id)) return null;
  const event = payload.hook_event_name;
  const base = { event, sessionId: payload.session_id, cwd: named(payload.cwd) ? payload.cwd : null, role: null, hostEventId: null, toolCallId: null, toolName: null, toolInput: null, prompt: null, outcome: null };
  if (event === 'UserPromptSubmit') return named(payload.prompt) ? { ...base, role: 'user', hostEventId: named(payload.message_id) ? payload.message_id : null, prompt: payload.prompt, text: payload.prompt } : null;
  if (event === 'Stop') return named(payload.last_assistant_message) ? { ...base, role: 'assistant', text: payload.last_assistant_message } : null;
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
export async function storeFootprint(file) {
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

// One capture (plan §12.1; PR-36c): the event's material written into the
// private store the capture record names, under one hold of its fence with no
// revision retries (design review D-2), or nothing at all. Nothing is written
// for a store inside a repository (§21.3), for a project not resolved from a
// worktree binding the store itself recorded (D-5) or not covered (OD-3), for
// a refusal that changes nothing, or when too little time is left to finish
// the commit (D-3). A ShadowGraph self-event is counted and nothing else. A
// host re-delivery of an item already held writes nothing. `post` tells the
// thread keeping the deadline when the store is entered and left. Resolves to
// what happened, for tests; `now` is a test seam.
export async function runCapture({ capture, input, deadline, record = null, home = homedir(), cwd = process.cwd(), post = () => {}, now = Date.now }) {
  let event;
  try { event = observedEvent(JSON.parse(input.charCodeAt(0) === 0xfeff ? input.slice(1) : input)); } catch { return 'unreadable'; }
  if (event === null) return 'not_captured';
  const file = capture.store.file;
  if (await storeRepository(file)) return 'store_inside_repository';
  const workspace = await discoverWorkspace(cwd, { timeout: Math.max(1, Math.min(GIT_TIMEOUT_MS, deadline - now())) });
  const lockTimeoutMs = deadline - now() - COMMIT_MARGIN_MS;
  if (lockTimeoutMs <= 0) return 'out_of_time';
  const markerFiles = [projectBindingFile(workspace, 'worktree'), ...(workspace.commonDir ? [projectBindingFile(workspace, 'shared_repository')] : [])];
  let outcome = 'written';
  const skip = (why) => { outcome = why; return null; };
  let store;
  post('enter');
  try {
    store = await createStorage({ type: capture.store.storage, file, lockTimeoutMs, staleLockMs: CAPTURE_STALE_LOCK_MS });
    await store.update(async (current) => {
      const entered = now();
      if (!isObject(current) || current.schemaVersion > SCHEMA_VERSION) return skip('newer_schema');
      // Measured under the fence, so a burst of writers cannot each see the
      // store below its ceiling (PR-36b amendment).
      const storeBytes = await storeFootprint(file);
      const held = new Set((current.records ?? []).filter((record) => record?.kind === 'capture').map((record) => record.id));
      const graph = createShadowGraph({ now: () => new Date(now()).toISOString() });
      graph.importData(current);
      const project = accessContext(graph, {}, 'cli', workspace, { confirmedByStore: true }).binding?.project ?? null;
      if (project === null) return skip('project_unresolved');
      if (!covered(capture.coverage, project)) return skip('not_covered');
      const classified = classifyCaptureSource(
        { event: event.event, sessionId: event.sessionId, cwd: event.cwd, toolName: event.toolName, toolInput: event.toolInput, prompt: event.prompt },
        { ...captureArtefacts({ storeFile: file, runtimeDirectory: capture.runtime?.path ?? null, activationFile: record, markerFiles }), home, mcpServerNames: capture.mcpServerNames ?? ['shadowgraph'], correlationTokens: [], workerSessionIds: [] }
      );
      const source = { event: event.event, sessionId: event.sessionId };
      if (classified.selfEvent) {
        privilegedRecordSelfEvent(graph, { project, originId: capture.originId, signal: classified.signal, source });
        outcome = 'self_event';
      } else {
        const result = privilegedRecordCapture(graph, {
          project, originId: capture.originId, text: event.text, sourceIdentity: classified.sourceIdentity,
          source: { ...source, role: event.role, hostEventId: event.hostEventId, toolCallId: event.toolCallId },
          observation: { host: 'claude-code', hostVersion: null, toolName: event.toolName, cwd: event.cwd, outcome: event.outcome },
          admission: { limits: admissionLimits(capture.limits), storeBytes }
        });
        if (result.refused) {
          if (!result.changed) return skip('refused');
          outcome = 'refused';
        // A host re-delivery returns the item the store already held.
        } else if (held.has(result.id)) return skip('already_held');
      }
      if (now() + Math.max(COMMIT_MARGIN_MS, 2 * (now() - entered)) > deadline) return skip('out_of_time');
      return privilegedSnapshot(graph);
    });
    return outcome;
  } finally {
    store?.close?.();
    post('leave');
  }
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
