// Private operational attribution, never raw material or a memory backup.
// Writers register before invocation. Readers never lock, create or repair it.
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { createDestinationFence } from '../revision-store.js';
import { isValidIsoInstant } from '../fact-validity.js';
import { canonicalPath, repositoryOf } from './owner-files.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = code => { throw Object.assign(new Error(code), { code }); };
export function identityFile(env = process.env) {
  const root = env.SHADOWGRAPH_HOME || join(homedir(), '.shadowgraph');
  if (!isAbsolute(root)) fail('worker_identity_location');
  return join(root, 'extraction-invocations.json');
}
function valid(row) {
  return row && Object.keys(row).sort().join() === 'correlationToken,from,invocationId,leaseId,to'
    && UUID.test(row.invocationId) && UUID.test(row.leaseId)
    && typeof row.correlationToken === 'string' && row.correlationToken.startsWith('sgcorr_') && UUID.test(row.correlationToken.slice(7))
    && isValidIsoInstant(row.from) && isValidIsoInstant(row.to)
    && Date.parse(row.to) > Date.parse(row.from) && Date.parse(row.to) - Date.parse(row.from) <= 300000;
}
async function location(env) {
  const file = identityFile(env);
  if (await repositoryOf(file)) fail('worker_identity_location');
  return join(await canonicalPath(dirname(file)), 'extraction-invocations.json');
}
async function load(file) {
  let handle;
  try {
    const before = await lstat(file);
    if (!before.isFile() || before.nlink !== 1 || before.size > 65536) fail('worker_identity_unavailable');
    const actual = resolve(await realpath(file)), expected = resolve(file);
    if ((process.platform === 'win32' ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected)) fail('worker_identity_unavailable');
    handle = await open(file, 'r'); const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || stat.ino !== before.ino || stat.dev !== before.dev || stat.size > 65536) fail('worker_identity_unavailable');
    const bytes = Buffer.alloc(65537), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 65536) fail('worker_identity_unavailable');
    const data = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
    if (data?.version !== 1 || Object.keys(data).sort().join() !== 'invocations,version' || !Array.isArray(data.invocations)
      || data.invocations.length > 128 || !data.invocations.every(valid)
      || new Set(data.invocations.map(row => row.invocationId)).size !== data.invocations.length) fail('worker_identity_unavailable');
    return data.invocations;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    fail('worker_identity_unavailable');
  } finally { await handle?.close(); }
}
function clock(options) {
  const at = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(at) || at < 0) fail('worker_identity_invalid');
  return at;
}
export async function registerInvocation(row, options = {}) {
  const at = clock(options);
  if (!valid(row) || Date.parse(row.from) > at || Date.parse(row.to) <= at) fail('worker_identity_invalid');
  const file = await location(options.env);
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  return createDestinationFence(file, { lockTimeoutMs: options.lockTimeoutMs ?? 0 }).run(async () => {
    const prior = await load(file);
    if (prior.some(item => item.invocationId === row.invocationId)) fail('worker_identity_duplicate');
    const invocations = prior.filter(item => Date.parse(item.to) > at);
    if (invocations.length >= 128) fail('worker_identity_full');
    invocations.push(structuredClone(row));
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(temporary, 'wx', 0o600);
      try { await handle.writeFile(`${JSON.stringify({ version: 1, invocations })}\n`); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  });
}
export async function readInvocationContext(options = {}) {
  try {
    const at = clock(options), rows = await load(await location(options.env));
    const workerInvocations = rows.filter(row => Date.parse(row.from) <= at && at < Date.parse(row.to));
    return { available: true, observedAt: new Date(at).toISOString(), workerInvocations, correlationTokens: [...new Set(workerInvocations.map(row => row.correlationToken))] };
  } catch { return { available: false, workerInvocations: [], correlationTokens: [] }; }
}
