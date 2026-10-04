// Activation (plan §26; programme plan revision 6 §3.4 PR-32 and §5): an
// explicit, logged local action turns an integrated capability on for real
// data after its gate passes, and `deactivate` turns it off again as the first
// step of any rollback. The record is `<SHADOWGRAPH_HOME or ~/.shadowgraph>/
// activation.json`, in exactly the shape delivery reads (src/delivery.js), with
// an append-only history. It holds configuration and evidence references,
// never memory. Delivery, capture and extraction share this record fence.
import { randomUUID } from 'node:crypto';
import { createDestinationFence } from './revision-store.js';
import { execFile } from 'node:child_process';
import { lstat, readFile, rename } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { promisify } from 'node:util';
import { CAPTURE_LIMITS, activeCapture, expireCaptureStore, storeRepository } from './capture-hook.js';
import { activationFile, DELIVERY_CAP_BYTES, DELIVERY_DEADLINE_MS, readStoreForDelivery } from './delivery.js';
import { defaultSettingsPath, HOOK_TEMPLATE_URL, installedHandlers, pinnedRuntime, runtimeHookCommand } from './host-hooks.js';
import { confirmOwnerAction } from './internal/owner-confirmation.js';
import { credentialLiteralIn } from './internal/credential-literal.js';
import { DELETION_VIEW } from './internal/deletion-knowledge.js';
import { canonicalPath, isScratchFile, readText, writeJsonAtomically } from './internal/owner-files.js';
import { mintOriginId, usableOriginId } from './scope.js';

export const COVERAGE_MANIFEST_URL = new URL('../integrations/claude-code.coverage.json', import.meta.url);
const RECORD_VERSION = 1;
const run = promisify(execFile);

async function recordAt(env) {
  const file = activationFile(env);
  if (!file) throw new Error('activation_home_not_absolute');
  const path = await canonicalPath(file);
  const text = await readText(path);
  if (text === null) return { path, text, record: null };
  try {
    const record = JSON.parse(text);
    if (record && typeof record === 'object' && !Array.isArray(record)) return { path, text, record };
  } catch {}
  const error = new Error(`activation_record_unreadable (${path})`);
  error.code = 'activation_record_unreadable';
  error.path = path;
  throw error;
}

// Confirm and probe outside the short record fence. Compare the exact approved
// record again inside it so another capability cannot be restored by a stale write.
async function saveActivation(path, expected, next) {
  return createDestinationFence(path).run(async () => {
    if (await readText(path) !== expected) throw new Error('activation_record_changed_while_confirming');
    await writeJsonAtomically(path, next);
  });
}

// The installed host's version, read once at activation (a bounded call); a
// host that later updates stays recorded as it was until the next activation.
async function claudeVersion() {
  try {
    // No shell, so no command file is looked for in the working directory; a
    // host installed only as a command script reads as unknown.
    const { stdout } = await run('claude', ['--version'], { timeout: 5000, windowsHide: true });
    return /\d+\.\d+\.\d+/u.exec(stdout)?.[0] ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

// The git working tree a path lies in, if any (a bounded call).
async function workingTree(path) {
  try {
    return (await run('git', ['rev-parse', '--show-toplevel'], { cwd: dirname(path), timeout: 3000, windowsHide: true })).stdout.trim() || null;
  } catch {
    return null;
  }
}

// The pinned runtime the hooks run, checked again here (programme plan
// revision 6 §5); none when the hooks run an installed binary. Every installed
// ShadowGraph handler, of either kind, must run it with its own kind's verb, so
// one runtime serves both hooks (PR-36 design review D-24).
async function hooksRunning(settingsFile, runtime) {
  const handlers = await installedHandlers(settingsFile);
  const pinned = runtime ? await pinnedRuntime(runtime) : null;
  if (pinned && handlers.some(({ kind, command }) => command !== runtimeHookCommand(pinned.path, undefined, kind))) throw new Error(`activation_hooks_run_another_runtime (${settingsFile})`);
  return { handlers, pinned };
}

// What every activation checks first: the gate's evidence reference (a
// pointer, so one the credential check flags is refused), the host version
// when given, and a store that exists and reads as the kind declared. It
// returns the store's path, and what it read (none when another process
// holds the store).
async function checkedActivation({ evidence, store, storage, hostVersion }) {
  if (typeof evidence !== 'string' || !evidence.trim()) throw new Error('activation_requires_evidence');
  if (credentialLiteralIn(evidence) || credentialLiteralIn(`evidence=${evidence}`)) throw new Error('activation_evidence_holds_a_credential');
  if (hostVersion !== undefined && !/^(?:\d+\.\d+\.\d+|unknown)$/u.test(hostVersion)) throw new Error('activation_host_version_malformed');
  if (typeof store !== 'string' || !store.trim()) throw new Error('activation_requires_store');
  if (!['json', 'sqlite'].includes(storage)) throw new Error('activation_storage_unsupported');
  const storeFile = await canonicalPath(store);
  if (!(await lstat(storeFile).catch(() => null))?.isFile()) throw new Error(`activation_store_not_found (${storeFile})`);
  const read = await readStoreForDelivery({ file: storeFile, storage });
  if (read.unavailable && read.unavailable !== 'busy') throw new Error(`activation_store_unreadable (${read.unavailable}: ${storeFile})`);
  return { storeFile, payload: read.payload ?? null };
}

// Whether a store holds capture state -- an item, a session record or
// captured content -- or may (a store another process held when read).
const holdsCapture = (payload) => payload === null
  || (Array.isArray(payload.records) && payload.records.some((record) => record?.kind === 'capture'))
  || ['captureSessions', 'captureContent'].some((name) => Array.isArray(payload[name]) && payload[name].length > 0);

// `activate delivery`: the gate's evidence reference and the store the hook
// reads are required. With a pinned runtime, hooks already installed must run
// it. Outside a scratch location the owner confirms the exact configuration at
// a terminal, and the record must still hold what was read when they answered.
// `afterConfirmation` is a test seam only.
export async function activateDelivery({ env = process.env, evidence, store, storage = 'json', hostVersion, settings = defaultSettingsPath(), runtime, surface = 'cli', afterConfirmation } = {}) {
  const { storeFile, payload } = await checkedActivation({ evidence, store, storage, hostVersion });
  const { path, text, record } = await recordAt(env);
  const { verifiedVersion } = JSON.parse(await readFile(COVERAGE_MANIFEST_URL, 'utf8'));
  const template = JSON.parse(await readFile(HOOK_TEMPLATE_URL, 'utf8'));
  const version = hostVersion ?? await claudeVersion();
  const settingsFile = await canonicalPath(settings);
  const { handlers, pinned } = await hooksRunning(settingsFile, runtime);
  // A build before the capture reader refuses a store holding capture, so it
  // would deliver nothing from it (FND-P6-06, FND-P6-10).
  if (pinned && !pinned.captures && holdsCapture(payload)) throw new Error(`activation_runtime_cannot_read_capture (${pinned.path} is ${pinned.commit}, a build that cannot read the capture ${storeFile} holds or may hold; install a later runtime)`);
  if (pinned && !pinned.retentionReader && (holdsCapture(payload) || payload?.[DELETION_VIEW]?.retentionOverrides?.length)) throw new Error(`activation_runtime_cannot_read_retention (${pinned.path} does not enforce capture retention; install a compatible runtime)`);
  sharedWith(record?.capabilities?.capture, 'capture', storeFile, storage, pinned);
  sharedWith(record?.capabilities?.extraction, 'extraction', storeFile, storage, pinned);
  const at = new Date().toISOString();
  const delivery = {
    state: 'active', changedAt: at, evidence,
    store: { file: storeFile, storage },
    host: { name: 'claude-code', version, verifiedVersion, verified: version === verifiedVersion },
    deadlineMs: DELIVERY_DEADLINE_MS, capBytes: DELIVERY_CAP_BYTES, hookTimeoutSeconds: template.hooks.SessionStart[0].hooks[0].timeout,
    settings: settingsFile, hooksInstalled: handlers.some(({ kind }) => kind === 'deliver'), runtime: pinned, surface
  };
  // The owner sees the warning before confirming, as well as after.
  const tree = await workingTree(storeFile);
  const warning = tree ? { warning: `The pinned store lies in the git working tree ${tree}; what that repository ships can change it.` } : {};
  if (!(await isScratchFile(path)) && !await confirmOwnerAction('Activate delivery', { record: path, ...warning, ...delivery })) throw new Error(`activation_requires_owner_confirmation (${path})`);
  await afterConfirmation?.();
  if (await readText(path) !== text) throw new Error('activation_record_changed_while_confirming');
  const next = {
    version: RECORD_VERSION,
    capabilities: { ...(record?.capabilities ?? {}), delivery },
    history: [...(Array.isArray(record?.history) ? record.history : []), { at, capability: 'delivery', state: 'active', evidence, surface, hostVersion: version, store: storeFile, runtimeCommit: pinned?.commit ?? null }]
  };
  await saveActivation(path, text, next);
  return { capability: 'delivery', state: 'active', file: path, record: next, ...warning };
}

// The projects a flag names: comma-separated, each once.
function projectList(value, flag) {
  const names = value.split(',').map((name) => name.trim());
  if (names.some((name) => !name) || new Set(names).size !== names.length) throw new Error(`activation_projects_malformed (${flag})`);
  return names;
}

// `activate capture` (OD-3): the owner's one explicit enablement. Capture then
// covers every project unless `exclude` narrows it or `only` names the ones it
// covers; reads are never affected. The store must be private: a store inside
// a git repository or working tree is refused, with no flag, variable or key
// that permits it (§21.3, VAR-14). Its origin is minted once and kept by every
// later activation, so the captures of one installation share it. The frozen
// admission limits are recorded here, and the history keeps each activation's
// coverage and limits, so an earlier value is never lost (§22.6.1). As for
// delivery, the owner confirms at a terminal outside a scratch location. A
// pinned runtime must be able to capture (FND-P6-10), and every installed
// handler must run it. `mcpServers` names the MCP servers ShadowGraph is
// registered as, so its own tool calls are recognised (PR-35 S-1; default
// `shadowgraph`). Capture stays inert until AG-2 approves it on the real host.
export async function activateCapture({ env = process.env, evidence, store, storage = 'json', only, exclude, mcpServers, hostVersion, settings = defaultSettingsPath(), runtime, surface = 'cli', afterConfirmation } = {}) {
  if (only !== undefined && exclude !== undefined) throw new Error('activation_coverage_only_or_exclude');
  const coverage = only !== undefined ? { projects: 'only', include: projectList(only, '--only') } : { projects: 'all', exclude: exclude === undefined ? [] : projectList(exclude, '--exclude') };
  const mcpServerNames = mcpServers === undefined ? ['shadowgraph'] : projectList(mcpServers, '--mcp-servers');
  const { storeFile } = await checkedActivation({ evidence, store, storage, hostVersion });
  // Delivery reports a SQLite store busy while a capture writes it, so a
  // shared SQLite store would lose the delivery at every captured prompt.
  if (storage !== 'json') throw new Error(`capture_store_sqlite_unsupported (${storeFile}: capture writes a JSON store only, since delivery would report a SQLite store busy at every captured prompt)`);
  const repository = await storeRepository(storeFile) ?? await gitRepository(storeFile);
  if (repository) throw new Error(`capture_store_inside_repository (${storeFile} lies in ${repository}; plan section 21.3 and source-of-truth section 7: private material is never written inside a repository, even temporarily, and nothing permits it)`);
  const { path, text, record } = await recordAt(env);
  const version = hostVersion ?? await claudeVersion();
  const settingsFile = await canonicalPath(settings);
  const { handlers, pinned } = await hooksRunning(settingsFile, runtime);
  if (pinned && !pinned.captures) throw new Error(`activation_runtime_cannot_capture (${pinned.path} is ${pinned.commit}, a build without the capture verb and reader; install a later runtime)`);
  if (pinned && !pinned.captureLifecycle) throw new Error(`activation_runtime_cannot_capture_lifecycle (${pinned.path} does not declare the required capture lifecycle; install a compatible runtime)`);
  sharedWith(record?.capabilities?.delivery, 'delivery', storeFile, storage, pinned);
  sharedWith(record?.capabilities?.extraction, 'extraction', storeFile, storage, pinned);
  // The origin: the capability's own, else the latest one the history kept.
  const history = Array.isArray(record?.history) ? record.history : [];
  const kept = [record?.capabilities?.capture?.originId, ...history.filter((entry) => entry?.capability === 'capture').map((entry) => entry.originId).reverse()];
  const at = new Date().toISOString();
  const capture = {
    state: 'active', changedAt: at, evidence,
    store: { file: storeFile, storage },
    originId: kept.map(usableOriginId).find(Boolean) ?? mintOriginId(),
    coverage, limits: { ...CAPTURE_LIMITS }, mcpServerNames,
    // No host version is verified for capture until AG-2 records one.
    host: { name: 'claude-code', version, verifiedVersion: null, verified: false },
    settings: settingsFile, hooksInstalled: handlers.some(({ kind }) => kind === 'capture'), runtime: pinned, surface
  };
  const note = { note: 'Capture records what you and the assistant do in every covered project into this private store. Reads are unaffected.' };
  if (!(await isScratchFile(path)) && !await confirmOwnerAction('Activate capture', { record: path, ...note, ...capture })) throw new Error(`activation_requires_owner_confirmation (${path})`);
  await afterConfirmation?.();
  if (await readText(path) !== text) throw new Error('activation_record_changed_while_confirming');
  const next = {
    version: RECORD_VERSION,
    capabilities: { ...(record?.capabilities ?? {}), capture },
    history: [...history, { at, capability: 'capture', state: 'active', evidence, surface, hostVersion: version, store: storeFile, originId: capture.originId, coverage, limits: capture.limits, runtimeCommit: pinned?.commit ?? null }]
  };
  await saveActivation(path, text, next);
  return { capability: 'capture', state: 'active', file: path, record: next };
}

// Delivery and capture work on one private store (plan §21.4, row 1: the
// automated store holds records and capture items alike), so what is captured
// is what delivery reads and declares. While both are active they name the
// same store and the same runtime, so one runtime serves both hooks. A re-pin
// therefore turns capture off first, re-activates delivery on the new runtime,
// then activates capture on it again. (That the pinned runtime can read a
// store holding capture, FND-P6-06, is checked with the capture hooks, PR-36b.)
function sharedWith(other, name, storeFile, storage, pinned) {
  if (other?.state !== 'active') return;
  if (other.store?.file !== storeFile || other.store?.storage !== storage) throw new Error(`activation_store_differs_from_${name} (${name} is active for ${other.store?.file}; one store serves both)`);
  if ((other.runtime?.path ?? null) !== (pinned?.path ?? null) || (other.runtime?.commit ?? null) !== (pinned?.commit ?? null)) throw new Error(`activation_runtime_differs_from_${name} (${name} runs ${other.runtime?.commit ?? 'an installed binary'}; one runtime serves both: to re-pin, deactivate capture, re-activate delivery on the new runtime, then activate capture on it)`);
}

// The git repository a path lies in by git's own answer (a bounded call):
// asked with every GIT_* variable removed, and again with the invoking
// environment's GIT_DIR or GIT_WORK_TREE when either is set, since either can
// make a directory a working tree. Any answer but "not a git repository" -- a
// timeout, git missing, an ownership refusal -- refuses too: the check fails
// closed.
async function gitRepository(path) {
  const plain = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^GIT_/iu.test(name)));
  const placed = process.env.GIT_DIR || process.env.GIT_WORK_TREE ? [process.env] : [];
  for (const env of [plain, ...placed]) {
    try {
      return (await run('git', ['rev-parse', '--absolute-git-dir'], { cwd: dirname(path), timeout: 3000, windowsHide: true, env: { ...env, LC_ALL: 'C' } })).stdout.trim() || dirname(path);
    } catch (error) {
      if (!/not a git repository/iu.test(String(error.stderr ?? ''))) return `a repository git could not rule out (${String(error.stderr || error.code || error.message).trim()})`;
    }
  }
  return null;
}

// `deactivate delivery` and `deactivate capture`: never ask, since they only
// turn a capability off, and always leave a record saying so; the history
// keeps the entry. With nothing active nothing is written. A record whose
// content is unreadable is kept beside the new one, renamed, never deleted;
// one the system cannot read for now (another process holding it) fails the
// command and stays as it is.
export const deactivateDelivery = (options) => deactivate('delivery', options);
export async function deactivateExtraction(options = {}) {
  const result = await deactivate('extraction', options);
  const { waitForExtractionStop } = await import('./internal/extraction-state.js');
  // Even an already disabled record may have a worker still settling.
  return { ...result, cleanup: await waitForExtractionStop(options) };
}
export async function deactivateCapture(options = {}) {
  // Disabling capture is durable before cleanup starts. A locked, unreadable
  // or pending store cannot re-enable capture or masquerade as cleaned up.
  const result = await deactivate('capture', options);
  if (!result.changed) return result;
  let cleanup;
  try { cleanup = await expireCaptureStore({ env: options.env, timeoutMs: options.cleanupTimeoutMs, endLimits: true }); }
  catch (error) { cleanup = { status: 'deferred', reason: error.code ?? 'capture_cleanup_failed', changed: false, expired: 0 }; }
  return { ...result, cleanup };
}

async function deactivate(capability, { env = process.env, surface = 'cli' } = {}) {
  const file = activationFile(env);
  if (!file) throw new Error('activation_home_not_absolute');
  return createDestinationFence(await canonicalPath(file)).run(async () => {
    let path, record, keptAside = null;
    try {
      ({ path, record } = await recordAt(env));
    } catch (error) {
      if (error.code !== 'activation_record_unreadable') throw error;
      ({ path } = error);
      keptAside = `${path}.unreadable-${new Date().toISOString().replace(/[:.]/gu, '-')}`;
      await rename(path, keptAside);
      record = { history: [] };
    }
    if (!keptAside && record?.capabilities?.[capability]?.state !== 'active') return { capability, state: 'deactivated', changed: false, file: path };
    const at = new Date().toISOString();
    const next = {
      version: RECORD_VERSION,
      capabilities: { ...(record.capabilities ?? {}), [capability]: { ...(record.capabilities?.[capability] ?? {}), state: 'deactivated', changedAt: at } },
      history: [...(Array.isArray(record.history) ? record.history : []), { at, capability, state: 'deactivated', surface, ...(keptAside ? { replacedUnreadableRecord: keptAside } : {}) }]
    };
    await writeJsonAtomically(path, next);
    return { capability, state: 'deactivated', changed: true, file: path, record: next, ...(keptAside ? { keptAside } : {}) };
  });
}

// AG-3 is explicit. No live activation, route discovery or model call occurs
// merely by importing this module. executorCheck/afterConfirmation are test seams.
export async function activateExtraction({ env = process.env, evidence, store, storage = 'json', hostVersion,
  settings = defaultSettingsPath(), runtime, executable, noOverageConfirmed, surface = 'cli', executorCheck, afterConfirmation } = {}) {
  if (noOverageConfirmed !== true && noOverageConfirmed !== 'true') throw new Error('extraction_requires_no_overage_confirmation');
  if (surface !== 'cli' || typeof executable !== 'string' || !isAbsolute(executable)) throw new Error('extraction_requires_explicit_executable');
  const { storeFile, payload } = await checkedActivation({ evidence, store, storage, hostVersion });
  if (!payload) throw new Error('extraction_store_busy');
  if (await storeRepository(storeFile) || await gitRepository(storeFile)) throw new Error('capture_store_inside_repository');
  const { path, text, record } = await recordAt(env);
  const settingsFile = await canonicalPath(settings), { pinned } = await hooksRunning(settingsFile, runtime);
  if (!pinned?.extraction) throw new Error('activation_runtime_cannot_extract');
  if (!await activeCapture(env)) throw new Error('extraction_requires_active_capture');
  for (const name of ['delivery', 'capture']) sharedWith(record?.capabilities?.[name], name, storeFile, storage, pinned);
  const { createExtractor, EXTRACTION_MODEL } = await import('./extractor.js');
  const { validExecutorReceipt, workerSettlement } = await import('./internal/extraction-state.js');
  if (await workerSettlement(env) !== 'clear') throw new Error('worker_settlement_unconfirmed');
  const { FROZEN_WORKER_BUDGETS, initializeUsage } = await import('./internal/extraction-budget.js');
  const checked = await (executorCheck ?? (() => createExtractor({ executable, env }).check()))();
  if (!validExecutorReceipt(checked) || checked.executable !== await canonicalPath(executable)) throw new Error('extraction_executor_unverified');
  // Copy only resolved configuration and bounded metadata, never host diagnostics
  // or auth response fields. The executor repeats all checks on every invocation.
  const executor = Object.fromEntries(['ok', 'executable', 'binarySha256', 'hostVersion', 'model', 'restrictions', 'environmentNames', 'switches', 'configurationProfile']
    .filter(key => checked[key] !== undefined).map(key => [key, structuredClone(checked[key])]));
  const at = new Date().toISOString();
  const extraction = { state: 'active', activationId: randomUUID(), changedAt: at, evidence, store: { file: storeFile, storage },
    runtime: pinned, settings: settingsFile, surface, model: EXTRACTION_MODEL, budgets: { ...FROZEN_WORKER_BUDGETS }, executor, noOverageConfirmed: true };
  if (!(await isScratchFile(path)) && !await confirmOwnerAction('Activate extraction (subscription only; no overage authorized)', { record: path, ...extraction })) throw new Error(`activation_requires_owner_confirmation (${path})`);
  await afterConfirmation?.();
  if (await readText(path) !== text) throw new Error('activation_record_changed_while_confirming');
  await initializeUsage({ env }); // Existing usage must validate and is never reset.
  if (await readText(path) !== text) throw new Error('activation_record_changed_while_confirming');
  const next = { version: RECORD_VERSION, capabilities: { ...(record?.capabilities ?? {}), extraction },
    history: [...(Array.isArray(record?.history) ? record.history : []), { at, capability: 'extraction', state: 'active', evidence, surface,
      activationId: extraction.activationId, store: storeFile, runtimeCommit: pinned.commit, model: extraction.model, budgets: extraction.budgets,
      noOverageConfirmed: true, executor }] };
  await saveActivation(path, text, next);
  return { capability: 'extraction', state: 'active', file: path, record: next };
}
