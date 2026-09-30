// Who produced an event (plan v1.4.4 §16.2-§16.4; PR-35). Capture asks who
// produced what it observed, not who is looking at it. Three signals mark
// ShadowGraph's own traffic:
//   S-1 tool target: a call to its MCP server; a run of its binary or of its
//       installed runtime's entry points (the program a command runs, never a
//       read, edit or `cd` of files beside them); a touch of its store with
//       its lock, SQLite and restore side files, of its activation record or
//       of its marker files. Only a tool's path fields and the words of a Bash
//       or PowerShell command, read by that shell's own quoting rules, are
//       looked at -- never a file or folder merely named "shadowgraph", and
//       never quoted prose, a here-document, a here-string or a comment;
//   S-2 a correlation mark that ShadowGraph minted into its own invocation,
//       found in the event's arguments (tool input or prompt), not its output;
//   S-3 worker attribution: a session its own worker recorded as its own.
// Process ancestry is not used: no host is known to supply it. An event with no
// signal is captured and marked unattributed_observer; absence never excludes,
// so a user developing ShadowGraph itself is captured like anyone else. What
// S-1 does not see is captured, never excluded: a command inside a quoted
// `sh -c` or `node -e`, a run behind `sudo`, `time` or `xargs`, `yarn <bin>`
// or `pnpm <bin>` without exec, a Grep or Glob of the store's folder,
// symlinked or short-name paths, another casing of the MCP server's name.
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { DELIVERY_CAP_BYTES, DELIVERY_FRAME } from './delivery-marker.js';

export const SELF_SIGNALS = Object.freeze(['S-1', 'S-2', 'S-3']);
export const UNATTRIBUTED_OBSERVER = 'unattributed_observer';
export const mintCorrelationToken = () => `sgcorr_${randomUUID()}`;

const MCP_SERVERS = Object.freeze(['shadowgraph']);
const BINARIES = Object.freeze(['shadowgraph']);
const RUNTIME_ENTRY_POINTS = Object.freeze([['src', 'cli.js'], ['src', 'mcp.js']]);
// Runners take the program next, past their flags and the flags' values;
// package managers run one only after an exec verb, since otherwise the next
// word is a script or a subcommand.
const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const PACKAGE_MANAGERS = new Set(['npm', 'pnpm', 'yarn', 'bun']);
const EXEC_VERBS = new Set(['exec', 'dlx', 'x']);
const STORE_SIDE_FILES = Object.freeze(['.lock', '-wal', '-shm', '-journal']);
const PATH_FIELDS = Object.freeze(['file_path', 'path', 'notebook_path']);
const SHELLS = Object.freeze({ Bash: 'bash', PowerShell: 'powershell' });
const WIN32 = process.platform === 'win32';

const comparable = (path) => (WIN32 ? resolve(path).toLowerCase() : resolve(path));
// A program's name as the platform finds it: on Windows any case and with its
// launcher extension; elsewhere exactly. A package version is not the name,
// and another scope's package is not this one.
const programName = (word) => {
  const scoped = /^@[^/\\]+\/[^@/\\]+/.exec(word);
  const name = scoped ? scoped[0] : basename(word).replace(/@[^@]*$/, '');
  return WIN32 ? name.replace(/\.(?:cmd|exe|ps1|bat)$/i, '').toLowerCase() : name;
};
const texts = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string') : []);

// The artefacts S-1 matches, from what the runtime resolved: its store (with
// its lock, SQLite and restore side files), its installed runtime's entry
// points, its activation record and the marker files it reads.
export function captureArtefacts({ storeFile, runtimeDirectory, activationFile, markerFiles = [] } = {}) {
  const files = [];
  if (storeFile) files.push(storeFile, ...STORE_SIDE_FILES.map((suffix) => `${storeFile}${suffix}`));
  if (activationFile) files.push(activationFile);
  files.push(...markerFiles);
  return {
    artefactPaths: files,
    storeFiles: storeFile ? [storeFile] : [],
    runtimeEntryPoints: runtimeDirectory ? RUNTIME_ENTRY_POINTS.map((parts) => join(runtimeDirectory, ...parts)) : []
  };
}

// Every string in a value, walked without recursion and up to a bound: past
// it nothing more is read, so a mark found only there is missed and the event
// is captured -- the conservative direction.
const MOST_VALUES = 10000;
function strings(value) {
  const found = [];
  const pending = [value];
  for (let visited = 0; pending.length && visited < MOST_VALUES; visited += 1) {
    const next = pending.pop();
    if (typeof next === 'string') found.push(next);
    else if (next && typeof next === 'object') for (const item of Object.values(next)) pending.push(item);
  }
  return found;
}

const SEPARATORS = Object.freeze({ bash: new Set([';', '|', '&', '(', ')', '`', '\n']), powershell: new Set([';', '|', '&', '(', ')', '{', '}', '\n']) });
const PLAIN = Object.freeze({ bash: /[^\s;|&()`'"\\<]+/y, powershell: /[^\s;|&(){}`'"@<]+/y });
const HEREDOC = /<<(-?)[ \t]*(?:\\([^\s;|&()<>]+)|'([^'\n]*)'|"([^"\n]*)"|([^\s;|&()<>`'"]+))/y;
const HERE_STRING = /@(['"])[ \t]*\r?\n/y;
// After a runner or an exec verb, a flag takes a value unless it is one of
// these switches (or carries its value, `--opt=value`), so `npx -w shadowgraph
// vitest` runs vitest; an unknown switch before a program makes it a miss.
const SWITCHES = new Set(['-y', '--yes', '--no', '--no-install', '-q', '--quiet', '-s', '--silent']);

// A Bash here-document opener at `at` (never `<<<`): its terminator, whether
// leading tabs are stripped from the terminator line, and where it ends.
function heredocAt(command, at) {
  if (!command.startsWith('<<', at) || command[at + 2] === '<' || command[at - 1] === '<') return null;
  HEREDOC.lastIndex = at;
  const match = HEREDOC.exec(command);
  return match && { terminator: match[2] ?? match[3] ?? match[4] ?? match[5], tabs: match[1] === '-', end: HEREDOC.lastIndex };
}

// Past the bodies of the here-documents a line opened, from the newline that
// ends it: each up to its terminator line or, unterminated, to the end.
function afterHeredocBodies(command, at, heredocs) {
  const pending = [...heredocs];
  let next = at + 1;
  while (pending.length && next < command.length) {
    const stop = command.indexOf('\n', next);
    const line = command.slice(next, stop === -1 ? command.length : stop).replace(/\r$/, '');
    next = stop === -1 ? command.length : stop + 1;
    if ((pending[0].tabs ? line.replace(/^\t+/, '') : line) === pending[0].terminator) pending.shift();
  }
  return pending.length ? command.length : next;
}

// The words of a shell command, split into its simple commands, read by the
// shell's own rules: a quoted string, a Bash here-document body, a PowerShell
// here-string and a comment are data, never commands. Each word records how its
// first character was quoted ('none', 'double' or 'single'; an escape counts as
// single), so a path is expanded only where the shell would expand it. An
// unclosed quote makes the rest of the command one quoted word. Each simple
// command records the separator that opened it (`opener`). One pass, linear in
// the command's length.
function simpleCommands(text, shell) {
  // PowerShell takes typographic quotes as quotes: the same, one for one.
  const command = shell === 'powershell' ? text.replace(/[‘’‚‛]/g, "'").replace(/[“”„]/g, '"') : text;
  const commands = [[]];
  const separators = SEPARATORS[shell];
  const plain = PLAIN[shell];
  let word = null;
  let heredocs = [];
  let at = 0;
  const flush = () => {
    if (word !== null) commands.at(-1).push(word);
    word = null;
  };
  const split = (opener) => {
    flush();
    commands.push(Object.assign([], { opener }));
  };
  const take = (text, quote) => {
    word ??= { text: '', quote };
    word.text += text;
  };
  const rest = (from, quote) => {
    take(command.slice(from), quote);
    at = command.length;
  };
  while (at < command.length) {
    const char = command[at];
    // Bash here-document bodies follow the line that named them.
    if (char === '\n' && heredocs.length) {
      split(char);
      at = afterHeredocBodies(command, at, heredocs);
      heredocs = [];
      continue;
    }
    if (separators.has(char)) {
      split(char);
      at += 1;
      continue;
    }
    if (char === ' ' || char === '\t' || char === '\r') {
      flush();
      at += 1;
      continue;
    }
    if (word === null && char === '#') {
      const stop = command.indexOf('\n', at);
      at = stop === -1 ? command.length : stop;
      continue;
    }
    if (shell === 'powershell') {
      if (word === null && command.startsWith('<#', at)) {
        const stop = command.indexOf('#>', at + 2);
        at = stop === -1 ? command.length : stop + 2;
        continue;
      }
      HERE_STRING.lastIndex = at;
      const opener = HERE_STRING.exec(command);
      if (opener) {
        const quote = opener[1] === "'" ? 'single' : 'double';
        const stop = command.indexOf(`\n${opener[1]}@`, HERE_STRING.lastIndex - 1);
        if (stop === -1) rest(HERE_STRING.lastIndex, quote);
        else {
          take(command.slice(HERE_STRING.lastIndex, stop), quote);
          at = stop + 3;
        }
        continue;
      }
      if (char === "'") {
        let end = command.indexOf("'", at + 1);
        while (end !== -1 && command[end + 1] === "'") end = command.indexOf("'", end + 2);
        if (end === -1) rest(at + 1, 'single');
        else {
          take(command.slice(at + 1, end).replaceAll("''", "'"), 'single');
          at = end + 1;
        }
        continue;
      }
      if (char === '"') {
        let end = at + 1;
        for (; end < command.length; end += 1) {
          if (command[end] === '`') end += 1;
          else if (command[end] === '"') {
            if (command[end + 1] !== '"') break;
            end += 1;
          }
        }
        if (end >= command.length) rest(at + 1, 'double');
        else {
          take(command.slice(at + 1, end).replace(/`([\s\S])/g, '$1').replaceAll('""', '"'), 'double');
          at = end + 1;
        }
        continue;
      }
      if (char === '`') {
        if (command[at + 1] !== '\n') take(command[at + 1] ?? '', 'single');
        at += 2;
        continue;
      }
    } else {
      const heredoc = heredocAt(command, at);
      if (heredoc) {
        flush();
        heredocs.push(heredoc);
        at = heredoc.end;
        continue;
      }
      if (char === "'") {
        const end = command.indexOf("'", at + 1);
        if (end === -1) rest(at + 1, 'single');
        else {
          take(command.slice(at + 1, end), 'single');
          at = end + 1;
        }
        continue;
      }
      if (char === '"') {
        // A here-document opened inside the string, as in `"$(cat <<'EOF'
        // ... EOF)"`, is skipped whole: a quote in its body closes nothing.
        let end = at + 1;
        let inner = [];
        while (end < command.length && command[end] !== '"') {
          const opened = heredocAt(command, end);
          if (opened) {
            inner.push(opened);
            end = opened.end;
          } else if (command[end] === '\n' && inner.length) {
            end = afterHeredocBodies(command, end, inner);
            inner = [];
          } else end += command[end] === '\\' ? 2 : 1;
        }
        if (end >= command.length) rest(at + 1, 'double');
        else {
          take(command.slice(at + 1, end).replace(/\\([\\"$`])/g, '$1'), 'double');
          at = end + 1;
        }
        continue;
      }
      if (char === '\\') {
        if (command[at + 1] !== '\n') take(command[at + 1] ?? '', 'single');
        at += 2;
        continue;
      }
    }
    plain.lastIndex = at;
    const run = plain.exec(command);
    take(run ? run[0] : char, 'none');
    at = run ? plain.lastIndex : at + 1;
  }
  flush();
  return commands;
}

// A candidate path as the event meant it: home in any of its spellings (`~`
// only unquoted, a variable unless single-quoted), a Git Bash drive,
// `--option=<path>` or `NAME=<path>`, or relative to the event's directory. A
// bare word or a multi-line value is no path.
function comparablePath(candidate, known, quote = 'none') {
  if (typeof candidate !== 'string' || !candidate.trim() || /[\r\n]/.test(candidate)) return null;
  let path = candidate.replace(/^(?:--?[\w-]+|[A-Za-z_]\w*)=/, '').replace(/^\\\\\?\\/, '');
  const home = quote === 'single' ? null
    : /^(?:~|\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|\$env:USERPROFILE|%USERPROFILE%)(?=[\\/]|$)/i.exec(path);
  if (home && (home[0] !== '~' || quote === 'none')) {
    if (!known.home) return null;
    path = join(known.home, path.slice(home[0].length));
  } else if (WIN32 && /^\/[a-z](?:\/|$)/i.test(path)) path = `${path[1]}:/${path.slice(3)}`;
  else if (!isAbsolute(path)) {
    if (!/[\\/]/.test(path) || typeof known.cwd !== 'string') return null;
    path = join(known.cwd, path);
  }
  return comparable(path);
}

function isArtefact(candidate, known, quote) {
  const target = comparablePath(candidate, known, quote);
  if (target === null) return false;
  if (known.artefacts.has(target)) return true;
  // A restore's staging, rollback and recovery files, and a save's temporary
  // file, beside the store (backup.js, storage.js, sqlite-storage.js).
  const name = basename(target);
  return known.stores.some((store) => dirname(store) === dirname(target)
    && (/^\.restore\..+\.(?:tmp|rollback|recovery)$/.test(name) || (name.startsWith(`.${basename(store)}.`) && /\.(?:tmp|restore|rollback|old|recovery)$/.test(name))));
}

// The program a simple command runs: past assignments and `env`, and through a
// runner or a package manager's exec verb. Its index, or -1 when there is none.
function programIndex(words) {
  let index = 0;
  const skipFlags = () => {
    while (index < words.length && words[index].startsWith('-')) {
      const flag = words[index];
      index += flag === '--' || flag.includes('=') || SWITCHES.has(flag) ? 1 : 2;
      if (flag === '--') break;
    }
  };
  while (index < words.length && (/^[A-Za-z_]\w*=/.test(words[index]) || programName(words[index]) === 'env')) index += 1;
  const launcher = index < words.length ? programName(words[index]) : '';
  if (RUNNERS.has(launcher)) {
    index += 1;
    skipFlags();
  } else if (PACKAGE_MANAGERS.has(launcher)) {
    index += 1;
    skipFlags();
    if (!EXEC_VERBS.has(words[index])) return -1;
    index += 1;
    skipFlags();
  }
  return index < words.length ? index : -1;
}

// Whether a simple command runs ShadowGraph: its binary, or an entry point of
// its installed runtime, directly or as node's script. A multi-line word is
// never a program, and in PowerShell a quoted one is an expression unless `&`
// or `.` invokes it.
function runsShadowGraph(command, known, shell) {
  const dotted = shell === 'powershell' && command[0]?.text === '.' && command[0].quote === 'none';
  const words = dotted ? command.slice(1) : command;
  const index = programIndex(words.map((word) => word.text));
  if (index === -1) return false;
  const program = words[index];
  if (program.text.includes('\n') || (shell === 'powershell' && program.quote !== 'none' && !dotted && command.opener !== '&')) return false;
  if (known.binaries.includes(programName(program.text))) return true;
  const isEntry = (word) => known.entries.has(comparablePath(word.text, known, word.quote));
  if (isEntry(program)) return true;
  if (programName(program.text) !== 'node') return false;
  const script = words.slice(index + 1).find((word) => !word.text.startsWith('-'));
  return script !== undefined && isEntry(script);
}

const escaped = (name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function targetsShadowGraph(event, context) {
  const servers = Array.isArray(context.mcpServerNames) ? texts(context.mcpServerNames) : MCP_SERVERS;
  // `mcp__<server>__<tool>`, or a plugin's `mcp__plugin_<plugin>_<server>__<tool>`.
  if (typeof event.toolName === 'string' && servers.some((name) => new RegExp(`^mcp__(?:plugin_.+_)?${escaped(name)}(?:__|$)`).test(event.toolName))) return true;
  // What the event is compared against, resolved once per event.
  const known = {
    home: typeof context.home === 'string' ? context.home : null,
    cwd: event.cwd,
    binaries: Array.isArray(context.binaryNames) ? texts(context.binaryNames) : BINARIES,
    artefacts: new Set(texts(context.artefactPaths).map(comparable)),
    stores: texts(context.storeFiles).map(comparable),
    entries: new Set(texts(context.runtimeEntryPoints).map(comparable))
  };
  const input = event.toolInput !== null && typeof event.toolInput === 'object' ? event.toolInput : {};
  if (PATH_FIELDS.some((field) => isArtefact(input[field], known))) return true;
  const shell = Object.hasOwn(SHELLS, event.toolName) ? SHELLS[event.toolName] : null;
  if (shell === null || typeof input.command !== 'string') return false;
  return simpleCommands(input.command, shell).some((words) => runsShadowGraph(words, known, shell) || words.some((word) => isArtefact(word.text, known, word.quote)));
}

// The program a Bash or PowerShell command runs when the command is exactly
// one simple command -- no pipeline, list, subshell or substitution -- named as
// the platform finds it; otherwise null. Capture uses it to judge whether an
// exit status is that program's own outcome (PR-36c, design review D-13).
export function soleProgram(command, toolName) {
  const shell = Object.hasOwn(SHELLS, toolName) ? SHELLS[toolName] : null;
  if (shell === null || typeof command !== 'string') return null;
  const commands = simpleCommands(command, shell).filter((words) => words.length > 0);
  if (commands.length !== 1) return null;
  // The first word past assignments and `env`: the program the shell runs.
  const words = commands[0].map((word) => word.text);
  let index = 0;
  while (index < words.length && (/^[A-Za-z_]\w*=/.test(words[index]) || programName(words[index]) === 'env')) index += 1;
  return index < words.length && !words[index].includes('\n') ? programName(words[index]) : null;
}

// Whether ShadowGraph produced this event, and by which signal; otherwise how
// it is captured. `event` is { event, sessionId, cwd, toolName, toolInput,
// prompt }; `context` is captureArtefacts() plus home, correlationTokens and
// workerSessionIds. S-3 is matched by session until the worker exists (P7).
// Anything malformed in either is ignored, never thrown.
export function classifyCaptureSource(event, context) {
  const observed = event !== null && typeof event === 'object' ? event : {};
  const known = context !== null && typeof context === 'object' ? context : {};
  if (targetsShadowGraph(observed, known)) return { selfEvent: true, signal: 'S-1' };
  const tokens = texts(known.correlationTokens).filter((token) => token.length >= 16);
  if (tokens.length && strings([observed.toolInput, observed.prompt]).some((value) => tokens.some((token) => value.includes(token)))) return { selfEvent: true, signal: 'S-2' };
  if (texts(known.workerSessionIds).includes(observed.sessionId)) return { selfEvent: true, signal: 'S-3' };
  return { selfEvent: false, sourceIdentity: UNATTRIBUTED_OBSERVER };
}

// ShadowGraph's own delivered blocks, removed from text before it is stored
// (§16.4): each runs from its frame to the first closing line after it that
// starts a line, lies within a block's reach, and counts the bytes between
// them -- as delivered, or with CRLF line ends folded to LF. Delivery escapes
// every line break inside an item, so no record can start a line, and a
// closing line quoted inside one ends nothing. A frame with no such closing
// line (a user quoting it, or a block whose bytes changed on the way, such as
// a JSON-escaped transcript) is left in place, and so is everything after it:
// stripping never removes what it cannot prove is a block.
const CLOSING_LINE = /(?<=\n)end: shadowgraph-deliver (\d+) bytes(?=\r?\n|$)/g;
// Every character is at least one byte, and CRLF adds one per line.
const BLOCK_REACH = 2 * DELIVERY_CAP_BYTES;
export function stripDeliveredBlocks(text) {
  const frames = [];
  for (let at = text.indexOf(DELIVERY_FRAME); at !== -1; at = text.indexOf(DELIVERY_FRAME, at + DELIVERY_FRAME.length)) frames.push({ at });
  if (!frames.length) return { text, removed: 0 };
  const closings = [...text.matchAll(CLOSING_LINE)].map((match) => ({ at: match.index, end: match.index + match[0].length, count: Number(match[1]) }));
  // The bytes, and the CRLF pairs, before every mark: one pass in text order.
  let bytes = 0;
  let pairs = 0;
  let from = 0;
  for (const mark of [...frames, ...closings].sort((a, b) => a.at - b.at)) {
    const between = text.slice(from, mark.at);
    bytes += Buffer.byteLength(between);
    pairs += between.split('\r\n').length - 1;
    Object.assign(mark, { bytes, pairs });
    from = mark.at;
  }
  let kept = '';
  let cursor = 0;
  let removed = 0;
  let next = 0;
  for (const frame of frames) {
    if (frame.at < cursor) continue;
    while (next < closings.length && closings[next].at <= frame.at) next += 1;
    let close = null;
    for (let index = next; close === null && index < closings.length && closings[index].at - frame.at <= BLOCK_REACH; index += 1) {
      const candidate = closings[index];
      const span = candidate.bytes - frame.bytes;
      if (span === candidate.count || span - (candidate.pairs - frame.pairs) === candidate.count) close = candidate;
    }
    if (close === null) continue;
    kept += text.slice(cursor, frame.at);
    cursor = close.end;
    removed += 1;
  }
  return { text: kept + text.slice(cursor), removed };
}
