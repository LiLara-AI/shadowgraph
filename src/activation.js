// Activation (plan §26; programme plan revision 6 §3.4 PR-32 and §5): an
// explicit, logged local action turns an integrated capability on for real
// data after its gate passes, and `deactivate` turns it off again as the first
// step of any rollback. The record is `<SHADOWGRAPH_HOME or ~/.shadowgraph>/
// activation.json`, in exactly the shape delivery reads (src/delivery.js), with
// an append-only history. It holds configuration and evidence references,
// never memory. Only `delivery` exists before capture (P6) and extraction (P7).
import { execFile } from 'node:child_process';
import { lstat, readFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { activationFile, DELIVERY_CAP_BYTES, DELIVERY_DEADLINE_MS, readStoreForDelivery } from './delivery.js';
import { defaultSettingsPath, HOOK_TEMPLATE_URL, installedCommands, pinnedRuntime, runtimeHookCommand } from './host-hooks.js';
import { confirmOwnerAction } from './internal/owner-confirmation.js';
import { credentialLiteralIn } from './internal/credential-literal.js';
import { canonicalPath, isScratchFile, readText, writeJsonAtomically } from './internal/owner-files.js';

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

// `activate delivery`: the gate's evidence reference and the store the hook
// reads are required; the store must be readable as the kind declared. The
// reference is a pointer, so one the credential check flags is refused. With
// a pinned runtime, hooks already installed must run it. Outside a scratch
// location the owner confirms the exact configuration at a terminal, and the
// record must still hold what was read when they answered.
// `afterConfirmation` is a test seam only.
export async function activateDelivery({ env = process.env, evidence, store, storage = 'json', hostVersion, settings = defaultSettingsPath(), runtime, surface = 'cli', afterConfirmation } = {}) {
  if (typeof evidence !== 'string' || !evidence.trim()) throw new Error('activation_requires_evidence');
  if (credentialLiteralIn(evidence) || credentialLiteralIn(`evidence=${evidence}`)) throw new Error('activation_evidence_holds_a_credential');
  if (hostVersion !== undefined && !/^(?:\d+\.\d+\.\d+|unknown)$/u.test(hostVersion)) throw new Error('activation_host_version_malformed');
  if (typeof store !== 'string' || !store.trim()) throw new Error('activation_requires_store');
  if (!['json', 'sqlite'].includes(storage)) throw new Error('activation_storage_unsupported');
  const storeFile = await canonicalPath(store);
  if (!(await lstat(storeFile).catch(() => null))?.isFile()) throw new Error(`activation_store_not_found (${storeFile})`);
  const read = await readStoreForDelivery({ file: storeFile, storage });
  if (read.unavailable && read.unavailable !== 'busy') throw new Error(`activation_store_unreadable (${read.unavailable}: ${storeFile})`);
  const { path, text, record } = await recordAt(env);
  const { verifiedVersion } = JSON.parse(await readFile(COVERAGE_MANIFEST_URL, 'utf8'));
  const template = JSON.parse(await readFile(HOOK_TEMPLATE_URL, 'utf8'));
  const version = hostVersion ?? await claudeVersion();
  const settingsFile = await canonicalPath(settings);
  const commands = await installedCommands(settingsFile);
  // The pinned runtime the hooks run, checked again here (programme plan
  // revision 6 §5); none when the hooks run an installed binary.
  const pinned = runtime ? await pinnedRuntime(runtime) : null;
  if (pinned && commands.some((command) => command !== runtimeHookCommand(pinned.path))) throw new Error(`activation_hooks_run_another_runtime (${settingsFile})`);
  const at = new Date().toISOString();
  const delivery = {
    state: 'active', changedAt: at, evidence,
    store: { file: storeFile, storage },
    host: { name: 'claude-code', version, verifiedVersion, verified: version === verifiedVersion },
    deadlineMs: DELIVERY_DEADLINE_MS, capBytes: DELIVERY_CAP_BYTES, hookTimeoutSeconds: template.hooks.SessionStart[0].hooks[0].timeout,
    settings: settingsFile, hooksInstalled: commands.length > 0, runtime: pinned, surface
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
  await writeJsonAtomically(path, next);
  return { capability: 'delivery', state: 'active', file: path, record: next, ...warning };
}

// `deactivate delivery`: never asks, since it only turns delivery off, and
// always leaves a record saying so; the history keeps the entry. With nothing
// active nothing is written. A record whose content is unreadable is kept
// beside the new one, renamed, never deleted; one the system cannot read for
// now (another process holding it) fails the command and stays as it is.
export async function deactivateDelivery({ env = process.env, surface = 'cli' } = {}) {
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
  if (!keptAside && record?.capabilities?.delivery?.state !== 'active') return { capability: 'delivery', state: 'deactivated', changed: false, file: path };
  const at = new Date().toISOString();
  const next = {
    version: RECORD_VERSION,
    capabilities: { ...(record.capabilities ?? {}), delivery: { ...(record.capabilities?.delivery ?? {}), state: 'deactivated', changedAt: at } },
    history: [...(Array.isArray(record.history) ? record.history : []), { at, capability: 'delivery', state: 'deactivated', surface, ...(keptAside ? { replacedUnreadableRecord: keptAside } : {}) }]
  };
  await writeJsonAtomically(path, next);
  return { capability: 'delivery', state: 'deactivated', changed: true, file: path, record: next, ...(keptAside ? { keptAside } : {}) };
}
