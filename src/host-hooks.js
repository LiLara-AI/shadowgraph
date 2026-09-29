import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { isDeepStrictEqual } from 'node:util';
import { confirmOwnerAction } from './internal/owner-confirmation.js';

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

// The file a path reaches, whatever name reaches it: a short (8.3) name, a
// junction or a link resolves to the file's own path, through its nearest
// existing parent when the file does not exist yet. Checks and writes use it,
// so a link stays a link and its target is what changes.
async function canonicalPath(path) {
  const missing = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(await realpath(at), ...missing.reverse());
    } catch (error) {
      if (error.code !== 'ENOENT' || dirname(at) === at) throw error;
      missing.push(basename(at));
    }
  }
}

// Every change asks the owner to type `confirm` at a terminal, except for a
// scratch file: one under the system's temporary directory, in no `.claude`
// directory, and under no name Claude Code reads. This guards host settings
// against an accidental change; a process that can write the file itself is
// not stopped.
async function isScratchFile(path) {
  const temporary = await realpath(tmpdir()).catch(() => null);
  if (temporary === null) return false;
  const inside = relative(temporary, path);
  return inside !== '' && !inside.startsWith('..') && !isAbsolute(inside)
    && !path.split(/[\\/]/u).some((segment) => segment.toLowerCase() === '.claude')
    && !/^(?:\.claude|(?:managed-)?settings(?:\.[^.]+)?|hooks)\.json$/iu.test(basename(path));
}

const readText = (path) => readFile(path, 'utf8').catch((error) => {
  if (error.code === 'ENOENT') return null;
  throw error;
});

async function readSettings(path) {
  const text = await readText(path);
  if (text === null) return { text, settings: null };
  let settings;
  try { settings = JSON.parse(text); } catch { throw new Error('settings_not_a_json_object'); }
  if (!isObject(settings)) throw new Error('settings_not_a_json_object');
  if (settings.hooks !== undefined && (!isObject(settings.hooks) || !Object.values(settings.hooks).every(Array.isArray))) throw new Error('settings_hooks_not_recognised');
  return { text, settings };
}

// A temporary file renamed over the settings, with the file's permission bits
// where the platform keeps them (a new file's are the owner's only). A rename
// the host briefly blocks on Windows is tried a few times; a failed write
// leaves no temporary copy behind.
async function writeSettings(path, settings) {
  await mkdir(dirname(path), { recursive: true });
  const mode = await stat(path).then((found) => found.mode & 0o777, () => 0o600);
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(settings, null, 2)}\n`, { mode, flag: 'wx' });
    for (let attempt = 1; ; attempt += 1) {
      try {
        await rename(temporary, path);
        return;
      } catch (error) {
        if (attempt >= 5 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
        await delay(50 * attempt);
      }
    }
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

// Install or uninstall ShadowGraph's hooks in one settings file. Nothing is
// written when nothing would change; otherwise the owner is asked (see
// isScratchFile), and the file must still hold what was read.
// `afterConfirmation` is a test seam only.
export async function changeHookSettings(requested, action, { afterConfirmation } = {}) {
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
    next = withShadowGraphHooks(settings ?? {}, template);
    const changed = settings === null || !isDeepStrictEqual(handlersByEvent(settings), handlersByEvent(next));
    result = { settings: path, changed, events: Object.keys(template.hooks), note: 'Installed hooks deliver nothing until delivery is activated.' };
    if (!changed) return result;
  }
  const title = `${action === 'install' ? 'Install' : 'Remove'} ShadowGraph's hooks`;
  if (!(await isScratchFile(path)) && !await confirmOwnerAction(title, { settings: path, action })) throw new Error(`hook_settings_require_owner_confirmation (${path})`);
  await afterConfirmation?.();
  if (await readText(path) !== text) throw new Error('settings_changed_while_confirming');
  await writeSettings(path, next);
  return result;
}
