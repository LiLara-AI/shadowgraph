import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const STATE_FILE = '.shadowgraph-sync.json';

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function hash(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex');
}

function normalizedScope(scope = {}) {
  return { userId: scope?.userId ?? null, agentId: scope?.agentId ?? null, runId: scope?.runId ?? null };
}

function memoryHash(memory) {
  return hash({
    project: memory.project,
    scope: normalizedScope(memory.scope),
    memoryType: memory.memoryType,
    key: memory.key,
    text: memory.text,
    tags: memory.tags ?? [],
    metadata: memory.metadata ?? {},
    temporal: memory.temporal ?? null,
    status: memory.status
  });
}

function jsonLine(name, value) {
  return `${name}: ${JSON.stringify(value)}`;
}

export function renderMemoryMarkdown(memory) {
  if (!memory || memory.kind !== 'memory') throw new Error('Only memory records can be rendered as Markdown');
  const scope = normalizedScope(memory.scope);
  return [
    '---',
    jsonLine('shadowgraph_id', memory.id),
    jsonLine('project', memory.project ?? 'default'),
    jsonLine('memory_type', memory.memoryType),
    jsonLine('key', memory.key),
    jsonLine('user_id', scope.userId),
    jsonLine('agent_id', scope.agentId),
    jsonLine('run_id', scope.runId),
    jsonLine('status', memory.status ?? 'active'),
    jsonLine('valid_from', memory.temporal?.validFrom ?? null),
    jsonLine('valid_to', memory.temporal?.validTo ?? null),
    jsonLine('tags', memory.tags ?? []),
    jsonLine('metadata', memory.metadata ?? {}),
    '---',
    '',
    String(memory.text ?? '').trimEnd(),
    ''
  ].join('\n');
}

export function parseMemoryMarkdown(content) {
  if (typeof content !== 'string') throw new Error('Markdown content must be a string');
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  if (lines[0] !== '---') throw new Error('ShadowGraph Markdown requires frontmatter');
  const end = lines.indexOf('---', 1);
  if (end < 0) throw new Error('ShadowGraph Markdown frontmatter is not closed');
  const fields = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new Error(`Malformed frontmatter line: ${line}`);
    const name = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    try { fields[name] = JSON.parse(raw); }
    catch { throw new Error(`Frontmatter field ${name} must use JSON-compatible YAML`); }
  }
  for (const name of ['shadowgraph_id', 'project', 'memory_type', 'key']) {
    if (typeof fields[name] !== 'string' || !fields[name]) throw new Error(`Frontmatter field ${name} is required`);
  }
  if (!Array.isArray(fields.tags) || fields.tags.some((item) => typeof item !== 'string')) throw new Error('Frontmatter tags must be an array of strings');
  if (!fields.metadata || typeof fields.metadata !== 'object' || Array.isArray(fields.metadata)) throw new Error('Frontmatter metadata must be an object');
  const text = lines.slice(end + 1).join('\n').replace(/^\n/, '').trimEnd();
  if (!text) throw new Error('Markdown memory body must not be empty');
  return {
    id: fields.shadowgraph_id,
    project: fields.project,
    memoryType: fields.memory_type,
    key: fields.key,
    scope: { userId: fields.user_id ?? null, agentId: fields.agent_id ?? null, runId: fields.run_id ?? null },
    status: fields.status ?? 'active',
    validFrom: fields.valid_from ?? null,
    validTo: fields.valid_to ?? null,
    tags: fields.tags,
    metadata: fields.metadata,
    text
  };
}

function safeSegment(value, maxLength = 80) {
  let cleaned = String(value ?? 'default').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  cleaned = cleaned.replace(/[. ]+$/g, '_');
  if (!cleaned || /^\.+$/.test(cleaned)) cleaned = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(cleaned)) cleaned = `_${cleaned}`;
  return [...cleaned].slice(0, maxLength).join('') || 'default';
}

async function readOptional(path) {
  try { return await readFile(path, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function atomicWrite(path, content) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, content, 'utf8');
  await rename(temporary, path);
}

async function loadState(directory) {
  const content = await readOptional(join(directory, STATE_FILE));
  if (!content) return { version: 1, files: {} };
  const state = JSON.parse(content);
  if (state?.version !== 1 || !state.files || typeof state.files !== 'object') throw new Error('Unsupported Markdown sync state');
  return state;
}

async function saveState(directory, state, dryRun) {
  if (!dryRun) await atomicWrite(join(directory, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

async function markdownFiles(directory) {
  const output = [];
  async function visit(path) {
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    for (const entry of entries) {
      if (entry.name === STATE_FILE) continue;
      const absolute = join(path, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) output.push(absolute);
    }
  }
  await visit(directory);
  return output.sort((left, right) => left.localeCompare(right));
}

function identity(memory) {
  const scope = normalizedScope(memory.scope);
  return JSON.stringify([memory.project ?? 'default', scope.userId, scope.agentId, scope.runId, memory.memoryType, memory.key]);
}

function memoryRelativePath(memory) {
  const stable = hash(identity(memory)).slice(0, 12);
  const name = `${safeSegment(memory.memoryType)}-${safeSegment(memory.key)}-${stable}.md`;
  return `${safeSegment(memory.project)}/${name}`;
}

async function push({ graph, directory, state, project, dryRun }) {
  const memories = graph.exportData().records
    .filter((record) => record.kind === 'memory' && record.status === 'active' && (!project || record.project === project))
    .sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const files = [];
  const conflicts = [];
  let written = 0;
  let unchanged = 0;
  for (const memory of memories) {
    // The path is stable across supersession versions. Using memory.id here would
    // create a second file after every edit and silently bypass conflict checks.
    const relativePath = memoryRelativePath(memory);
    const path = join(directory, ...relativePath.split('/'));
    const desired = renderMemoryMarkdown(memory);
    const desiredHash = hash(desired);
    const current = await readOptional(path);
    const currentHash = current === null ? null : hash(current);
    const prior = state.files[relativePath];
    if (current !== null && !prior && currentHash !== desiredHash) {
      conflicts.push({ path, reason: 'untracked_file_exists' });
      continue;
    }
    if (prior && currentHash !== prior.baseHash && currentHash !== desiredHash) {
      const reason = memoryHash(memory) !== prior.memoryHash ? 'both_file_and_memory_changed' : 'file_changed_since_last_sync';
      conflicts.push({ path, reason });
      continue;
    }
    if (currentHash === desiredHash) unchanged += 1;
    else {
      written += 1;
      if (!dryRun) await atomicWrite(path, desired);
    }
    state.files[relativePath] = { baseHash: desiredHash, memoryHash: memoryHash(memory), memoryId: memory.id };
    files.push({ path, relativePath, memoryId: memory.id });
  }
  return { written, unchanged, files, conflicts };
}

async function pull({ graph, directory, state, project, dryRun }) {
  const paths = await markdownFiles(directory);
  const snapshot = graph.exportData();
  const allMemoriesById = new Map(snapshot.records.filter((record) => record.kind === 'memory').map((memory) => [memory.id, memory]));
  const active = snapshot.records.filter((record) => record.kind === 'memory' && record.status === 'active');
  const byIdentity = new Map(active.map((memory) => [identity(memory), memory]));
  const files = [];
  const conflicts = [];
  const results = [];
  let imported = 0;
  let unchanged = 0;
  for (const path of paths) {
    const relativePath = relative(directory, path).replaceAll('\\', '/');
    const content = await readFile(path, 'utf8');
    let parsed;
    try { parsed = parseMemoryMarkdown(content); }
    catch (error) {
      conflicts.push({ path, reason: 'invalid_markdown', message: error.message });
      continue;
    }
    if (project && parsed.project !== project) continue;
    const fileHash = hash(content);
    const prior = state.files[relativePath];
    const baselineMemory = prior ? allMemoriesById.get(prior.memoryId) : null;
    if (prior && !baselineMemory) {
      conflicts.push({ path, reason: 'canonical_memory_missing' });
      continue;
    }
    if (baselineMemory && (parsed.id !== prior.memoryId || identity(parsed) !== identity(baselineMemory))) {
      conflicts.push({ path, reason: 'identity_changed' });
      continue;
    }
    const current = byIdentity.get(identity(parsed));
    const currentHash = current ? memoryHash(current) : null;
    if (prior && fileHash === prior.baseHash) {
      unchanged += 1;
      files.push({ path, relativePath, memoryId: current?.id ?? prior.memoryId });
      continue;
    }
    if (prior && currentHash && currentHash !== prior.memoryHash && fileHash !== prior.baseHash) {
      conflicts.push({ path, reason: 'both_file_and_memory_changed' });
      continue;
    }
    if (baselineMemory && parsed.status !== baselineMemory.status) {
      conflicts.push({ path, reason: 'unsupported_status_edit' });
      continue;
    }
    if (dryRun) {
      imported += 1;
      files.push({ path, relativePath, memoryId: current?.id ?? parsed.id });
      continue;
    }
    const result = graph.remember({
      project: parsed.project,
      scope: parsed.scope,
      memoryType: parsed.memoryType,
      key: parsed.key,
      text: parsed.text,
      tags: parsed.tags,
      metadata: parsed.metadata,
      validFrom: parsed.validFrom ?? undefined,
      validTo: parsed.validTo ?? undefined,
      sourceClass: 'tool_observed',
      client: 'markdown-sync'
    });
    results.push(result);
    if (result.operation !== 'NOOP') imported += 1;
    state.files[relativePath] = { baseHash: fileHash, memoryHash: memoryHash(result.memory), memoryId: result.memory.id };
    byIdentity.set(identity(result.memory), result.memory);
    files.push({ path, relativePath, memoryId: result.memory.id });
  }
  return { imported, unchanged, files, conflicts, results };
}

export async function syncMarkdownWorkspace(options = {}) {
  if (!options.graph || typeof options.graph.exportData !== 'function' || typeof options.graph.remember !== 'function') throw new Error('Markdown sync requires a ShadowGraph instance');
  if (typeof options.directory !== 'string' || !options.directory.trim()) throw new Error('Markdown sync directory is required');
  if (options.persist !== undefined && typeof options.persist !== 'function') throw new Error('Markdown sync persist must be a function');
  if (options.loadPersisted !== undefined && typeof options.loadPersisted !== 'function') throw new Error('Markdown sync loadPersisted must be a function');
  if (options.persist && !options.loadPersisted) throw new Error('Markdown sync persist requires loadPersisted for durable reconciliation');
  const mode = options.mode ?? 'push';
  if (!['push', 'pull'].includes(mode)) throw new Error('Markdown sync mode must be push or pull');
  const directory = resolve(options.directory);
  await mkdir(directory, { recursive: true });
  const state = await loadState(directory);
  const graphSnapshot = mode === 'pull' && options.dryRun !== true ? options.graph.exportData() : null;
  const stateSnapshot = JSON.parse(JSON.stringify(state));
  let canonicalPersisted = false;
  let persistenceAttempted = false;
  try {
    const result = mode === 'push'
      ? await push({ ...options, directory, state })
      : await pull({ ...options, directory, state });
    if (mode === 'pull' && options.dryRun !== true && result.conflicts.length) {
      if (graphSnapshot) options.graph.replaceData(graphSnapshot);
      for (const key of Object.keys(state)) delete state[key];
      Object.assign(state, stateSnapshot);
      return { mode, dryRun: false, ...result, imported: 0, results: [], rolledBack: true };
    }
    if (mode === 'pull' && options.dryRun !== true && options.persist) {
      persistenceAttempted = true;
      await options.persist(options.graph.exportData());
      options.graph.replaceData(await options.loadPersisted());
      canonicalPersisted = true;
    }
    await saveState(directory, state, options.dryRun === true);
    return { mode, dryRun: options.dryRun === true, ...result };
  } catch (error) {
    if (graphSnapshot && !canonicalPersisted) {
      if (persistenceAttempted && options.loadPersisted) {
        try { options.graph.replaceData(await options.loadPersisted()); }
        catch { options.graph.replaceData(graphSnapshot); }
      } else options.graph.replaceData(graphSnapshot);
    }
    for (const key of Object.keys(state)) delete state[key];
    Object.assign(state, stateSnapshot);
    throw error;
  }
}
