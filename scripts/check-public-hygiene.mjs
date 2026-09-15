// Public-repository hygiene guard.
//
// `check-package.mjs` already audits the PUBLISHED tarball. That is not enough:
// a file can be tracked in a public repository and never be packaged --
// `docs/handoff/` is exactly that -- so machine paths, assistant-tool
// directories and development-process traces can reach a public clone while
// every packaging gate stays green. This guard audits the TRACKED TREE instead,
// and at release time the COMMIT RANGE that is about to become public history.
//
// Two modes, deliberately separate:
//
//   node scripts/check-public-hygiene.mjs
//       TREE mode. Part of `npm run check`. Depends only on the tracked files,
//       so it is deterministic on any clone.
//
//   node scripts/check-public-hygiene.mjs --history-base <ref> [--identity "Name <email>"]
//       HISTORY mode. Release/merge time only. Depends on git topology and on a
//       base ref existing, so it is deliberately NOT in `npm run check`.
//
// Zero runtime dependencies. Line-level credential and absolute-path detection
// is REUSED from check-package.mjs rather than reimplemented, so the two gates
// cannot drift apart; this file adds only what tree auditing needs on top.

import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { lineViolationCategories } from './check-package.mjs';

const execFileAsync = promisify(execFile);
const defaultRoot = fileURLToPath(new URL('..', import.meta.url));
const textDecoder = new TextDecoder('utf-8', { fatal: true });

// --- what tree mode looks for, beyond the reused classifier -----------------

// WSL mounts: /mnt/c/..., /mnt/d/... . check-package.mjs catches /home and
// /Users profile paths but not these, and they name a real machine layout.
const wslMountPattern = /(?:^|[^A-Za-z0-9_./-])\/mnt\/[a-z](?:\/[^\s"'`<>|]*)?/u;

// Local assistant / agent tool STATE, which is what actually leaked:
// `...\.claude\backups\shadowgraph\git-config.<timestamp>.bak`. The directory
// alone is deliberately NOT enough — `.npmignore` lists `.claude/` precisely to
// exclude it, and the README documents `~/.cursor/mcp.json` and
// `~/.codex/config.toml` for genuinely supported clients. Requiring a state
// subdirectory keeps those legitimate references clean while still catching the
// shape that matters. An assistant path under a real home directory is caught
// independently by the reused profile-path patterns.
const assistantStatePattern = new RegExp(
  String.raw`(?:^|[^A-Za-z0-9_.-])\.(?:claude|codex|cursor|serena|hermes|aider|continue)[\\/]`
  + String.raw`(?:backups?|sessions?|history|logs?|cache|transcripts?|scratch|todos|projects|shell-snapshots|statsig|state)(?:[\\/]|$)`,
  'iu'
);

// Tracked paths that should never exist in a public product repository.
const forbiddenTrackedPathPattern = new RegExp(
  String.raw`(^|/)\.(?:claude|codex|cursor|serena|hermes)(/|$)`
  + String.raw`|(^|/)\.env(\.|$)`
  + String.raw`|(^|/)\.env$`
  + String.raw`|(^|/)benchmark/results(/|$)`
  + String.raw`|(^|/)\.local-handoff(/|$)`
  + String.raw`|\.(?:db|sqlite)(?:[-.][^/]*)?$`
  + String.raw`|\.(?:log|tmp|bak|core|dmp)$`,
  'iu'
);

// Regression tests, and every other authored file, are named after the
// behaviour or subject they cover -- not the agent, person or tool involved in
// producing them. See CONTRIBUTING.md.
//
// Applies to the WHOLE tracked tree. An earlier revision limited it to
// test/, src/ and scripts/, which let `docs/codex-notes.md` through.
//
// A tool name ALONE is never enough: `integrations/claude-code.mcp.json`,
// `codex.mcp.toml` and `agent-policy.md` are product surface for clients
// ShadowGraph genuinely supports. A process word alone is not enough either:
// `review-conditions.test.js` and `docs/handoff/` are product vocabulary. What
// identifies a development artefact is the two TOGETHER in one basename --
// `codex-notes`, `claude-review`, `agent-session-notes` -- so that is the rule,
// and it is applied to the basename only, so a directory such as
// `docs/handoff/` never colours the files beneath it.
const ASSISTANT_NAME_SEGMENTS = new Set([
  'codex', 'chatgpt', 'claude', 'gpt', 'gpt4', 'gpt5', 'copilot', 'gemini', 'cursor',
  'devin', 'aider', 'opus', 'sonnet', 'haiku', 'llm', 'agent', 'assistant', 'bot', 'ai'
]);
const PROCESS_WORD_SEGMENTS = new Set([
  'review', 'reviews', 'rereview', 'rereviews', 'finding', 'findings', 'note', 'notes',
  'session', 'sessions', 'transcript', 'transcripts', 'promptlog', 'prompt', 'scratch',
  'handoff', 'handoffs', 'reproduction', 'repro', 'output', 'dump', 'conversation',
  'chat', 'thread', 'log', 'logs', 'trace', 'traces'
]);

// Automated-assistant attribution inside tracked file CONTENT. A trailer only
// counts at the start of a line, which keeps ordinary prose about co-authorship
// from tripping it.
const attributionTrailerPattern = /^\s*(?:Co-Authored-By|Generated-By|Signed-Off-By-Agent)\s*:/iu;
const generatedWithPattern = /Generated with \[[^\]]*\]\(https?:\/\/[^)]*\)/u;
const sessionTrailerPattern = /^\s*(?:Session-Id|Agent-Session|Thread-Id|Conversation-Id)\s*:/iu;

// --- allowlist --------------------------------------------------------------
//
// Every entry names a file that must legitimately contain something the patterns
// above match, and says why. Kept explicit and small: a wildcard here would
// quietly re-open the hole this guard exists to close.
//
// Each entry is keyed by EXACT path and EXACT categories, and never disables a
// category it did not name -- so a Linux home path pasted into a file
// allowlisted for `local-hermes-path` is still reported. There is no path-level
// "skip this file" switch and no marker an author can write into source.
// `check-package.mjs` is deliberately absent: it needs no exemption at all.
export const ALLOWED = Object.freeze([
  {
    path: 'scripts/check-public-hygiene.mjs',
    categories: ['local-assistant-path', 'wsl-mount-path'],
    reason: 'the detector source states the shapes it looks for'
  },
  // Scanner tests assert on synthetic leak strings. Verified synthetic: no real
  // account names and no real credentials.
  {
    path: 'test/check-package.test.js',
    categories: ['absolute-posix-profile-path', 'absolute-windows-profile-path'],
    reason: 'synthetic home-path fixtures for the package scanner'
  },
  {
    path: 'test/followup-public-artifacts.test.js',
    categories: ['absolute-posix-profile-path', 'absolute-windows-profile-path', 'credential-literal'],
    reason: 'synthetic home-path and key-material fixtures for the artifact scanner'
  },
  {
    path: 'test/benchmark-v11-definition.test.js',
    categories: ['absolute-posix-profile-path', 'absolute-windows-profile-path', 'wsl-mount-path'],
    reason: 'synthetic path fixtures for the redaction scanner'
  },
  {
    path: 'test/benchmark-v11-prompts.test.js',
    categories: ['absolute-posix-profile-path', 'absolute-windows-profile-path', 'wsl-mount-path'],
    reason: 'synthetic path fixtures for the redaction scanner'
  },
  // Ignore files exist to NAME the directories that must stay out. Listing a
  // local tool directory there is the fix, not the leak.
  { path: '.npmignore', categories: ['local-hermes-path'], reason: 'ignore rules naming excluded local tool directories' },
  { path: '.gitignore', categories: ['local-hermes-path'], reason: 'ignore rules naming excluded local tool directories' }
]);

const allowedCategories = new Map(ALLOWED.map((entry) => [entry.path, new Set(entry.categories)]));

/** True when this exact path is approved for this exact category. */
export function isAllowed(path, category) {
  return allowedCategories.get(path)?.has(category) ?? false;
}

// Binary and vendored content is not authored project text.
const skippedPathPattern = /(^|\/)(?:node_modules|coverage|__pycache__)(\/|$)|\.(?:png|jpg|jpeg|gif|webp|ico|pdf|zip|gz|tgz|wasm|woff2?|ttf|otf|mp4|mp3)$/iu;

function fail(message) {
  process.exitCode = 1;
  console.error(`check-public-hygiene: ${message}`);
}

// What to do about a finding, in neutral wording. This gate REPORTS: it never
// deletes, moves, sanitizes or backs up anything, and it never rewrites
// history, so what happens to the raw material stays the developer's decision.
// Raw development data is worth keeping; it simply does not belong in a public
// repository. Only the path, line and category are ever echoed -- printing the
// matched value would copy the thing being reported into another log.
export const REMEDIATION = [
  'Raw and internal development data is meant to be preserved, not deleted. Keep the full-fidelity',
  'copy outside the repository and track only a sanitized public version:',
  '  npm run local:workspace:init     create the external local workspace',
  '  npm run local:workspace:status   show where it resolves (read-only)',
  'See CONTRIBUTING.md, "Public repository hygiene". This check only reports; it changes nothing.'
].join('\n');

async function git(args, cwd) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}

function decodeText(buffer) {
  if (buffer.includes(0)) return null;
  try {
    return textDecoder.decode(buffer);
  } catch {
    return null;
  }
}

// `test/` is NARROWED, not exempted.
//
// The suite's subject is leak scanning, so it deliberately carries synthetic
// credential names and values, sentinel tokens and container mount paths.
// Running the whole package classifier over it reported ~160 fixtures as leaks,
// which only trains everyone to ignore this gate. But a REAL machine path pasted
// into an ordinary regression test must never escape, so the home-directory
// classes stay on everywhere. Only the credential name/value heuristics and the
// repository/temp path classes -- the ones the fixture corpus legitimately
// trips -- are limited to the published surface, where check-package.mjs
// enforces them against the tarball in any case.
const testScopePattern = /^test\//u;
const HOME_PATH_CATEGORIES = new Set(['absolute-windows-profile-path', 'absolute-posix-profile-path']);
const privateKeyPattern = /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/u;

/**
 * Hygiene categories for one line of tracked text. Pure, so tests can call it.
 *
 * `path` selects the surface. Omit it to get the strictest published-surface set.
 *
 * There is deliberately NO marker, magic comment or opt-out substring. An
 * earlier revision skipped any line containing a marker word, which meant a
 * directory merely NAMED like the marker, or an unrelated comment on the same
 * line, switched every detector off -- in src/, docs/, scripts/ and ordinary
 * tests alike. A detector that arbitrary authored text can disable is not a
 * detector. Tests that need a forbidden-looking value assemble it at runtime
 * from harmless fragments and hand it straight to this function, so the value
 * never exists in tracked source and nothing has to be exempted.
 */
export function treeLineCategories(line, path = '') {
  const publishedSurface = !testScopePattern.test(path);
  const reused = lineViolationCategories(line);
  const categories = new Set(publishedSurface ? reused : reused.filter((item) => HOME_PATH_CATEGORIES.has(item)));
  if (!publishedSurface && privateKeyPattern.test(line)) categories.add('credential-literal');
  if (wslMountPattern.test(line)) categories.add('wsl-mount-path');
  if (assistantStatePattern.test(line)) categories.add('local-assistant-path');
  if (attributionTrailerPattern.test(line) || generatedWithPattern.test(line)) categories.add('assistant-attribution');
  if (sessionTrailerPattern.test(line)) categories.add('session-metadata');
  return [...categories];
}

/**
 * True when a basename names a development artefact: a tool or assistant name
 * AND a process word, as separate segments. Either alone is ordinary naming.
 */
export function isProcessTraceName(path) {
  const basename = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  const segments = basename.split(/[-_.\s]+/u).filter(Boolean);
  return segments.some((segment) => ASSISTANT_NAME_SEGMENTS.has(segment))
    && segments.some((segment) => PROCESS_WORD_SEGMENTS.has(segment));
}

/** Hygiene categories for one tracked path. Pure, so tests can call it. */
export function treePathCategories(path) {
  const categories = [];
  if (forbiddenTrackedPathPattern.test(path)) categories.push('forbidden-tracked-artifact');
  if (isProcessTraceName(path)) categories.push('process-trace-filename');
  return categories;
}

export async function checkTree(root = defaultRoot) {
  const listing = await git(['ls-files', '-z'], root);
  const paths = listing.split('\0').filter(Boolean);
  if (!paths.length) throw new Error('no tracked files found');
  const violations = [];

  for (const path of paths) {
    for (const category of treePathCategories(path)) {
      if (!isAllowed(path, category)) violations.push({ path, line: 0, category });
    }
  }

  for (const path of paths) {
    if (skippedPathPattern.test(path)) continue;
    let buffer;
    try {
      buffer = await readFile(join(root, path));
    } catch {
      continue;
    }
    const text = decodeText(buffer);
    if (text === null) continue;
    const lines = text.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      for (const category of treeLineCategories(lines[index], path)) {
        if (!isAllowed(path, category)) violations.push({ path, line: index + 1, category });
      }
    }
  }

  if (violations.length) {
    violations.sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.line - right.line
      || left.category.localeCompare(right.category)
    ));
    fail(`tracked tree hygiene violations:\n${violations
      .map(({ path, line, category }) => `- ${path}${line ? `:${line}` : ''} [${category}]`)
      .join('\n')}\n\n${REMEDIATION}`);
    return violations;
  }
  console.log(`public hygiene: tracked tree clean (${paths.length} tracked files, ${allowedCategories.size} path(s) allowlisted by category)`);
  return [];
}

// --- history mode -----------------------------------------------------------

// Unit separators, so a commit message containing them is not required to be
// escaped and cannot forge a record boundary.
const RECORD = '';
const FIELD = '';

// Names that identify a development assistant when they appear in an
// ATTRIBUTION position. The same names in subject position are legitimate
// product and research vocabulary, which is why this list is never matched
// against a bare commit line -- only inside the two constructions below.
const assistantIdentityPattern = new RegExp(
  String.raw`\b(?:claude|codex|chatgpt|copilot|gemini|cursor|devin|aider|opus|sonnet|haiku`
  + String.raw`|gpt-?\d|assistant|chatbot|\bbot\b|ai agent|language model)\b`
  + String.raw`|noreply@anthropic\.com|@openai\.com|users\.noreply\.github\.com/(?:copilot)`,
  'iu'
);

// Trailer keys that assert who produced the commit. `Reviewed-by`, `Tested-by`
// and `Reported-by` are deliberately absent: they record process, not authorship.
const attributionKeyPattern = /^\s*(Co-Authored-By|Signed-off-by|Generated-By|Authored-By|Assisted-By|On-Behalf-Of|Committed-By)\s*:\s*(.+)$/iu;

// Generation attribution written as prose rather than a trailer:
// "Generated by Claude Opus 5", "written with Copilot", "co-authored by Codex".
// The verb plus by/with/using is what makes it attribution; "Add Codex
// integration" and "an OpenAI-compatible endpoint" never match.
const generationProsePattern = /\b(?:generated|authored|co-?authored|written|created|produced|drafted|implemented)\s+(?:by|with|using)\s+(?:the\s+|an?\s+)?([^\n.;]{0,60})/giu;

/**
 * Hygiene findings for one commit record. Pure, so tests can call it.
 *
 * `identity` is supplied by the release command rather than hardwired, so an
 * ordinary third-party contribution is not rejected by a repository that has no
 * single-identity release policy. Supplying it also turns on owner-only checks:
 * any co-author or sign-off that is not the release identity is reported.
 */
export function commitViolations(commit, identity = null) {
  const findings = [];
  for (const line of commit.body.split(/\r?\n/u)) {
    const trailer = attributionKeyPattern.exec(line);
    if (trailer) {
      const [, key, value] = trailer;
      if (/^Generated-By$/iu.test(key) || assistantIdentityPattern.test(value)) {
        findings.push({ category: 'assistant-attribution-trailer', detail: line.trim() });
      } else if (identity && value.trim() !== identity) {
        // Owner-only history was requested, so a human co-author or sign-off
        // that is not the release identity is still unexpected -- reported
        // under its own category so it reads differently from an assistant.
        findings.push({ category: 'unexpected-attribution-trailer', detail: line.trim() });
      }
      continue;
    }
    if (generatedWithPattern.test(line)) {
      findings.push({ category: 'assistant-attribution-trailer', detail: line.trim() });
      continue;
    }
    if (sessionTrailerPattern.test(line)) {
      findings.push({ category: 'session-metadata', detail: line.trim() });
      continue;
    }
    generationProsePattern.lastIndex = 0;
    for (const match of line.matchAll(generationProsePattern)) {
      if (assistantIdentityPattern.test(match[1])) {
        findings.push({ category: 'assistant-attribution-prose', detail: line.trim() });
        break;
      }
    }
  }
  if (identity) {
    if (commit.author !== identity) findings.push({ category: 'unexpected-author', detail: commit.author });
    if (commit.committer !== identity) findings.push({ category: 'unexpected-committer', detail: commit.committer });
  }
  return findings;
}

export async function checkHistory(base, { identity = null, root = defaultRoot } = {}) {
  if (!base) throw new Error('--history-base <git-ref> is required in history mode');
  const format = ['%H', '%an <%ae>', '%cn <%ce>', '%B'].join(FIELD) + RECORD;
  const stdout = await git(['log', `--format=${format}`, `${base}..HEAD`], root);
  const commits = stdout.split(RECORD).map((chunk) => chunk.replace(/^\r?\n/u, '')).filter((chunk) => chunk.trim())
    .map((chunk) => {
      const [sha, author, committer, ...rest] = chunk.split(FIELD);
      return { sha: sha.trim(), author, committer, body: rest.join(FIELD) };
    });

  const violations = [];
  for (const commit of commits) {
    for (const finding of commitViolations(commit, identity)) violations.push({ sha: commit.sha, ...finding });
  }
  if (violations.length) {
    fail(`commit history hygiene violations in ${base}..HEAD:\n${violations
      .map(({ sha, category, detail }) => `- ${sha.slice(0, 12)} [${category}] ${detail}`)
      .join('\n')}`);
    return violations;
  }
  console.log(`public hygiene: ${commits.length} commit(s) in ${base}..HEAD clean${identity ? ` (identity ${identity})` : ''}`);
  return [];
}

function parseArgs(argv) {
  const options = { historyBase: null, identity: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--history-base') options.historyBase = argv[index + 1] ?? null;
    else if (argv[index] === '--identity') options.identity = argv[index + 1] ?? null;
  }
  return options;
}

// Compare resolved URLs. An earlier `endsWith` on a path slice matched whenever
// argv[1] simply ended in the same character, so importing this module ran a
// full tree scan as a side effect.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const { historyBase, identity } = parseArgs(process.argv.slice(2));
  try {
    if (historyBase) await checkHistory(historyBase, { identity });
    else await checkTree();
  } catch (error) {
    fail(error.message);
  }
}
