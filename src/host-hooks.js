import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { gunzipSync } from 'node:zlib';
import { confirmOwnerAction } from './internal/owner-confirmation.js';
import { canonicalPath, isScratchFile, readText, writeJsonAtomically } from './internal/owner-files.js';
import { tarEntries } from './internal/tar.js';

// The Claude Code hook blocks, one per kind of handler; installing is not
// activating. Delivery (plan §18.1, §18.5): command handlers at SessionStart
// and UserPromptSubmit running `shadowgraph deliver --hook`, silent until
// delivery is activated. Capture (plan §12.1; PR-36c): synchronous command
// handlers at UserPromptSubmit, PostToolUse, PostToolUseFailure and Stop
// running `shadowgraph capture --hook`, which captures nothing until capture
// is activated.
export const HOOK_TEMPLATE_URL = new URL('../integrations/claude-code.hooks.json', import.meta.url);
export const CAPTURE_HOOK_TEMPLATE_URL = new URL('../integrations/claude-code.capture-hooks.json', import.meta.url);
export const HOOK_KINDS = Object.freeze({ deliver: HOOK_TEMPLATE_URL, capture: CAPTURE_HOOK_TEMPLATE_URL });

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// The kind of a ShadowGraph handler -- a command running ShadowGraph's
// `deliver --hook` or `capture --hook`, whichever path or runtime launches
// it, so an upgrade replaces every earlier generation -- or null.
export function shadowGraphHookKind(handler) {
  if (!isObject(handler) || handler.type !== 'command' || typeof handler.command !== 'string' || !/shadowgraph/iu.test(handler.command)) return null;
  return /\b(deliver|capture)\s+--hook\b/u.exec(handler.command)?.[1] ?? null;
}

// Whether a handler is ShadowGraph's, of either kind.
export const isShadowGraphHandler = (handler) => shadowGraphHookKind(handler) !== null;
// Whether it is ShadowGraph's of the kind named, or of either.
const ofKind = (handler, kind) => {
  const found = shadowGraphHookKind(handler);
  return found !== null && (kind === undefined || found === kind);
};

// ShadowGraph's handlers (of one kind, or of either), event by event.
const handlersByEvent = (settings, kind) => Object.fromEntries(Object.entries(settings?.hooks ?? {})
  .map(([event, groups]) => [event, groups.flatMap((group) => (isObject(group) && Array.isArray(group.hooks) ? group.hooks.filter((handler) => ofKind(handler, kind)) : []))])
  .filter(([, handlers]) => handlers.length > 0));

// The settings without ShadowGraph's handlers of one kind, or of either. A
// group, an event's list or the `hooks` key that this leaves empty goes too,
// so a list or map that was empty before an install is not kept by the
// uninstall that follows.
export function withoutShadowGraphHooks(settings, kind) {
  const next = structuredClone(settings);
  if (!isObject(settings.hooks)) return next;
  const hooks = {};
  for (const [event, groups] of Object.entries(next.hooks)) {
    const kept = groups.flatMap((group) => {
      if (!isObject(group) || !Array.isArray(group.hooks)) return [group];
      const handlers = group.hooks.filter((handler) => !ofKind(handler, kind));
      if (handlers.length === group.hooks.length) return [group];
      return handlers.length > 0 ? [{ ...group, hooks: handlers }] : [];
    });
    if (kept.length > 0 || groups.length === 0) hooks[event] = kept;
  }
  if (Object.keys(hooks).length > 0 || Object.keys(next.hooks).length === 0) next.hooks = hooks;
  else delete next.hooks;
  return next;
}

// The settings with exactly one generation of ShadowGraph's handlers of one
// kind: every earlier one of that kind removed, the template's groups
// appended to their events. The other kind's handlers stay as they are.
export function withShadowGraphHooks(settings, template, kind = 'deliver') {
  const next = withoutShadowGraphHooks(settings, kind);
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
// that runs it is recognised as ShadowGraph's. It can capture when its build
// ships the capture hook template, and with it the verb and the capture reader
// (FND-P6-10): an earlier build refuses a store holding capture.
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
  return { path, commit: manifest.commit, tree: manifest.tree, tarballSha256: digest, captures: packed.has('integrations/claude-code.capture-hooks.json') };
}

// The command a hook of one kind runs for a pinned runtime: this Node binary
// and the runtime's own CLI, with forward slashes, which both shells a host may
// use read the same way. A path either shell could expand (a quote, `$`, a
// backquote, `%`, `!` or a control character) is refused.
export function runtimeHookCommand(runtime, node = process.execPath, kind = 'deliver') {
  if (!Object.hasOwn(HOOK_KINDS, kind)) throw new Error(`hook_kind_unknown (${kind})`);
  const paths = [node, join(runtime, 'src', 'cli.js')].map((path) => path.replaceAll('\\', '/'));
  if (paths.some((path) => /["$`%!\p{Cc}]/u.test(path))) throw new Error(`runtime_path_unsafe_in_a_command (${paths.join(', ')})`);
  return `"${paths[0]}" "${paths[1]}" ${kind} --hook`;
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

// The ShadowGraph handlers a settings file holds, each with its kind and
// command (read only; an absent or unreadable file holds none).
export async function installedHandlers(path) {
  try {
    return Object.values(handlersByEvent((await readSettings(await canonicalPath(path))).settings)).flat().map((handler) => ({ kind: shadowGraphHookKind(handler), command: handler.command }));
  } catch {
    return [];
  }
}

// Install or uninstall ShadowGraph's hooks in one settings file. An install
// is of one kind (`deliver` unless `kind` says `capture`) and replaces only
// that kind's handlers; an uninstall removes the kind named, or both. Nothing
// is written when nothing would change; otherwise the owner is asked unless
// the file is a scratch file (src/internal/owner-files.js), and the file must
// still hold what was read. `command` replaces the template's, for a pinned
// runtime. `afterConfirmation` is a test seam only.
export async function changeHookSettings(requested, action, { command, kind, afterConfirmation } = {}) {
  if (kind !== undefined && !Object.hasOwn(HOOK_KINDS, kind)) throw new Error(`hook_kind_unknown (${kind})`);
  const path = await canonicalPath(requested);
  const { text, settings } = await readSettings(path);
  let next;
  let result;
  if (action === 'uninstall') {
    const removed = Object.values(handlersByEvent(settings, kind)).flat().length;
    if (removed === 0) return { settings: path, changed: false, removed: 0 };
    next = withoutShadowGraphHooks(settings, kind);
    result = { settings: path, changed: true, removed };
  } else {
    const installing = kind ?? 'deliver';
    const template = JSON.parse(await readFile(HOOK_KINDS[installing], 'utf8'));
    if (command !== undefined) for (const groups of Object.values(template.hooks)) for (const group of groups) for (const handler of group.hooks) handler.command = command;
    next = withShadowGraphHooks(settings ?? {}, template, installing);
    const changed = settings === null || !isDeepStrictEqual(handlersByEvent(settings, installing), handlersByEvent(next, installing));
    result = { settings: path, changed, kind: installing, events: Object.keys(template.hooks), note: installing === 'capture' ? 'Installed hooks capture nothing until capture is activated.' : 'Installed hooks deliver nothing until delivery is activated.' };
    if (!changed) return result;
  }
  const title = `${action === 'install' ? 'Install' : 'Remove'} ShadowGraph's hooks`;
  if (!(await isScratchFile(path)) && !await confirmOwnerAction(title, { settings: path, action })) throw new Error(`hook_settings_require_owner_confirmation (${path})`);
  await afterConfirmation?.();
  if (await readText(path) !== text) throw new Error('settings_changed_while_confirming');
  await writeJsonAtomically(path, next);
  return result;
}
