import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { confirmOwnerAction } from './internal/owner-confirmation.js';
import { canonicalPath, isScratchFile, readText, writeJsonAtomically } from './internal/owner-files.js';
import { tarEntries } from './internal/tar.js';

// The Claude Code hook block (plan §18.1, §18.5): command handlers at
// SessionStart and UserPromptSubmit only, running `shadowgraph deliver --hook`,
// which stays silent until delivery is activated. Installing is not activating.
export const HOOK_TEMPLATE_URL = new URL('../integrations/claude-code.hooks.json', import.meta.url);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// A handler is ShadowGraph's when it is a command running ShadowGraph's
// `deliver --hook`, whichever path or runtime launches it; so an upgrade
// replaces every earlier generation.
export function isShadowGraphHandler(handler) {
  return isObject(handler) && handler.type === 'command' && typeof handler.command === 'string'
    && /\bdeliver\s+--hook\b/u.test(handler.command) && /shadowgraph/iu.test(handler.command);
}

// ShadowGraph's handlers, event by event.
const handlersByEvent = (settings) => Object.fromEntries(Object.entries(settings?.hooks ?? {})
  .map(([event, groups]) => [event, groups.flatMap((group) => (isObject(group) && Array.isArray(group.hooks) ? group.hooks.filter(isShadowGraphHandler) : []))])
  .filter(([, handlers]) => handlers.length > 0));

// The settings without ShadowGraph's handlers. A group, an event's list or the
// `hooks` key that this leaves empty goes too, so a list or map that was empty
// before an install is not kept by the uninstall that follows.
export function withoutShadowGraphHooks(settings) {
  const next = structuredClone(settings);
  if (!isObject(settings.hooks)) return next;
  const hooks = {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    const kept = groups.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks.filter((handler) => !isShadowGraphHandler(handler));
      if (handlers.length === group.hooks.length) return [group];
      return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
    });
    if (kept.length > 0 || groups.length === 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length > 0 || Object.keys(next.hooks).length === 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

// The settings with exactly one generation of ShadowGraph's handlers: every
// earlier one removed, the template's groups appended to their events.
export function withShadowGraphHooks(settings, template) {
  const next = withoutShadowGraphHooks(settings);
  next.hooks = { ...(next.hooks ?? {}) };
  for (const [event, groups] of Object.entries(template.hooks)) next.hooks[event] = [...(next.hooks[event] ?? []), ...structuredClone(groups)];
  return next;
}

export const defaultSettingsPath = () => join(homedir(), '.claude', 'settings.json');

// A pinned runtime (programme plan revision 6 §5): a directory holding a gate
// commit's packed build, `runtime.json` naming its commit, tree and tarball
// digest, and the tarball itself. Checked again here: the tarball against its
// digest, and every file the hook runs against the tarball, byte for byte,
// with none missing and none added. Its path names ShadowGraph, so the handler
// that runs it is recognised as ShadowGraph's.
export async function pinnedRuntime(directory) {
  const path = await canonicalPath(directory);
  const refused = () => new Error(`runtime_not_verified (${path})`);
  let manifest;
  try { manifest = JSON.parse(await readFile(join(path, 'runtime.json'), 'utf8')); } catch { throw new Error(`runtime_not_found (${path})`); }
  const tarball = await readFile(join(path, 'package.tgz'));
  const digest = createHash('sha256').update(tarball).digest('hex');
  if (!/shadowgraph/iu.test(path) || !/^[0-9a-f]{40}$/u.test(manifest?.commit ?? '') || !/^[0-9a-f]{40}$/u.test(manifest?.tree ?? '') || manifest.tarballSha256 !== digest) throw refused();
  const packed = new Map();
  try {
    for (const { name, type, body } of tarEntries(gunzipSync(tarball))) if (type === '0') packed.set(name.split('/').slice(1).join('/'), body);
  } catch { throw refused(); }
  const present = (await readdir(path, { recursive: true, withFileTypes: true }))
    .filter((entry) => !entry.isDirectory())
    .map((entry) => relative(path, join(entry.parentPath ?? entry.path, entry.name)).split(sep).join('/'))
    .filter((name) => name !== 'package.tgz' && name !== 'runtime.json');
  if (present.length !== packed.size || present.some((name) => !packed.has(name))) throw refused();
  for (const [name, body] of packed) if (!(await readFile(join(path, name))).equals(body)) throw refused();
  return { path, commit: manifest.commit, tree: manifest.tree, tarballSha256: digest };
}

// The command a hook runs for a pinned runtime: this Node binary and the
// runtime's own CLI, with forward slashes, which both shells a host may use
// read the same way. A path either shell could expand (a quote, `$`, a
// backquote, `%`, `!` or a control character) is refused.
export function runtimeHookCommand(runtime, node = process.execPath) {
  const paths = [node, join(runtime, 'src', 'cli.js')].map((path) => path.replaceAll('\\', '/'));
  if (paths.some((path) => /["$`%!\p{Cc}]/u.test(path))) throw new Error(`runtime_path_unsafe_in_a_command (${paths.join(', ')})`);
  return `"${paths[0]}" "${paths[1]}" deliver --hook`;
}

async function readSettings(path) {
  const text = await readText(path);
  if (text === null) return { text, settings: null };
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error('settings_not_a_json_object'); }
  if (!isObject(settings)) throw new Error('settings_not_a_json_object');
  if (settings.hooks !== undefined && (!isObject(settings.hooks) || !Object.values(settings.hooks).every(Array.isArray))) throw new Error('settings_hooks_not_recognised');
  return { text, settings };
}

// The commands of the ShadowGraph handlers a settings file holds (read only;
// an absent or unreadable file holds none).
export async function installedCommands(path) {
  try {
    return Object.values(handlersByEvent((await readSettings(await canonicalPath(path))).settings)).flat().map((handler) => handler.command);
  } catch {
    return [];
  }
}

// Install or uninstall ShadowGraph's hooks in one settings file. Nothing is
// written when nothing would change; otherwise the owner is asked unless the
// file is a scratch file (src/internal/owner-files.js), and the file must
// still hold what was read. `command` replaces the template's, for a pinned
// runtime. `afterConfirmation` is a test seam only.
export async function changeHookSettings(requested, action, { command, afterConfirmation } = {}) {
  const path = await canonicalPath(requested);
  const { text, settings } = await readSettings(path);
  let next;
  let result;
  if (action === 'uninstall') {
    const removed = Object.values(handlersByEvent(settings)).flat().length;
    if (removed === 0) return { settings: path, changed: false, removed: 0 };
    next = withoutShadowGraphHooks(settings);
    result = { settings: path, changed: true, removed };
  } else {
    const template = JSON.parse(await readFile(HOOK_TEMPLATE_URL, 'utf8'));
    if (command !== undefined) for (const groups of Object.values(template.hooks)) for (const group of groups) for (const handler of group.hooks) handler.command = command;
    next = withShadowGraphHooks(settings ?? {}, template);
    const changed = settings === null || !isDeepStrictEqual(handlersByEvent(settings), handlersByEvent(next));
    result = { settings: path, changed, events: Object.keys(template.hooks), note: 'Installed hooks deliver nothing until delivery is activated.' };
    if (!changed) return result;
  }
  const title = `${action === 'install' ? 'Install' : 'Remove'} ShadowGraph's hooks`;
  if (!(await isScratchFile(path)) && !await confirmOwnerAction(title, { settings: path, action })) throw new Error(`hook_settings_require_owner_confirmation (${path})`);
  await afterConfirmation?.();
  if (await readText(path) !== text) throw new Error('settings_changed_while_confirming');
  await writeJsonAtomically(path, next);
  return result;
}
