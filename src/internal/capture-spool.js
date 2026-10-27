// Durable capture input (independent review 2026-10-26 §5). The hook keeps an
// event's payload on disk before it seeks the store's fence, so a store another
// writer holds delays the event instead of losing it. Each later hook replays
// what is waiting, oldest first and within its own deadline; an entry leaves
// the spool only when the store has decided it (written, already held, refused
// or not capturable). What can be neither kept nor replayed is never dropped
// silently: a content-free marker records that it was lost and why, and
// delivery reports the count.
//
// The spool lives beside the activation record, in the owner's private
// ShadowGraph home, never in a repository; entries are owner-only. An entry
// holds the host's raw payload, which the host's own transcript already holds
// on the same disk: redaction happens when the store records it, as for a
// direct capture. Nothing here reads or writes the store.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, open, readdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const SPOOL_LIMITS = Object.freeze({
  maxEntries: 512, maxEntryBytes: 1024 * 1024, maxBytes: 64 * 1024 * 1024,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, maxAttempts: 8, maxDropMarkers: 4096
});
const ENTRY = /^(\d{15})-([0-9a-f]{32})-(\d+)\.json$/u;
const MARKER = /^(\d{15})-([0-9a-f]{32})\.json$/u;

export const spoolDirectory = (record) => join(dirname(record), 'capture-spool');
// Beside the spool, not in it: a spool that cannot be written can still have
// its losses recorded.
export const droppedDirectory = (spool) => join(dirname(spool), 'capture-dropped');
const digest = (value) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const nameOf = ({ at, key, attempts }) => `${String(at).padStart(15, '0')}-${key}-${attempts}.json`;

async function writeOwnerOnly(directory, name, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.${name}.${randomUUID()}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(`${JSON.stringify(value)}\n`); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, join(directory, name));
  } finally { await unlink(temporary).catch(() => {}); }
}

// The entries waiting, oldest first: { name, at, key, attempts }. A name that
// is not an entry's is ignored, never read.
export async function spoolEntries(spool) {
  let names;
  try { names = await readdir(spool); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return names.flatMap((name) => {
    const match = ENTRY.exec(name);
    return match ? [{ name, at: Number(match[1]), key: match[2], attempts: Number(match[3]) }] : [];
  }).sort((left, right) => left.at - right.at || (left.name < right.name ? -1 : 1));
}

// Keeps one event's payload, with the activation its own hook judged its
// account bound under (capture-hook.js), if any. The key is the payload and working directory's
// digest, so a host re-delivery while the first copy waits is kept once.
// Resolves { kept, entry } or { kept: false, reason } -- the caller then takes
// the direct path and, failing that, records the loss.
export async function spoolEvent({ spool, input, cwd, transcript = null, boundBy = null, now = Date.now }) {
  try {
    if (Buffer.byteLength(input) > SPOOL_LIMITS.maxEntryBytes) return { kept: false, reason: 'spool_entry_too_large' };
    const key = digest(JSON.stringify([input, cwd]));
    const waiting = await spoolEntries(spool);
    const same = waiting.find((entry) => entry.key === key);
    if (same) return { kept: true, entry: same, duplicate: true };
    if (waiting.length >= SPOOL_LIMITS.maxEntries) return { kept: false, reason: 'spool_full' };
    let bytes = 0;
    for (const entry of waiting) bytes += (await stat(join(spool, entry.name)).catch(() => null))?.size ?? 0;
    if (bytes + Buffer.byteLength(input) > SPOOL_LIMITS.maxBytes) return { kept: false, reason: 'spool_full' };
    const entry = { at: now(), key, attempts: 0 };
    entry.name = nameOf(entry);
    // The transcript's size when the event arrived: a replay anchors a new
    // session's cursor there, not at the end the transcript has reached since.
    await writeOwnerOnly(spool, entry.name, { version: 1, receivedAt: new Date(entry.at).toISOString(), cwd, input, transcriptSize: transcript, boundBy });
    return { kept: true, entry };
  } catch {
    return { kept: false, reason: 'spool_unwritable' };
  }
}

// A hook works on its own entry under a claim: renamed out of the queue, so no
// drain takes it meanwhile. A claim a dead hook left returns to the queue after
// CLAIM_STALE_MS, well past any hook's hard cap.
const CLAIM = '.claim';
export const CLAIM_STALE_MS = 60000;
const fileOf = (entry) => (entry.claimed ? `${entry.name}${CLAIM}` : entry.name);
export async function claimSpoolEntry(spool, entry) {
  try { await rename(join(spool, entry.name), join(spool, `${entry.name}${CLAIM}`)); return { ...entry, claimed: true }; }
  catch { return null; }
}
export async function releaseSpoolEntry(spool, entry) {
  if (!entry.claimed) return entry;
  await rename(join(spool, fileOf(entry)), join(spool, entry.name)).catch(() => {});
  return { ...entry, claimed: false };
}
export async function recoverClaims(spool, now = Date.now()) {
  for (const name of await readdir(spool).catch(() => [])) {
    if (!name.endsWith(CLAIM) || !ENTRY.test(name.slice(0, -CLAIM.length))) continue;
    const modified = (await stat(join(spool, name)).catch(() => null))?.mtimeMs;
    if (Number.isFinite(modified) && now - modified >= CLAIM_STALE_MS) await rename(join(spool, name), join(spool, name.slice(0, -CLAIM.length))).catch(() => {});
  }
}

export async function readSpoolEntry(spool, entry) {
  const value = JSON.parse(await readFile(join(spool, fileOf(entry)), 'utf8')); // ENOENT propagates: replayed elsewhere
  if (value?.version !== 1 || typeof value.input !== 'string' || typeof value.cwd !== 'string') throw Object.assign(new Error('spool entry unreadable'), { code: 'spool_entry_unreadable' });
  return value;
}

// The store decided the entry: it leaves the spool. Already gone is fine --
// another hook replayed it first.
export const settleSpoolEntry = (spool, entry) => unlink(join(spool, fileOf(entry))).catch((error) => { if (error.code !== 'ENOENT') throw error; });

// A failure that was not contention counts as an attempt; past the limit the
// entry is dropped with a marker, so a poisoned entry cannot hold the queue.
export async function failSpoolEntry(spool, entry, reason) {
  entry = await releaseSpoolEntry(spool, entry);
  const attempts = entry.attempts + 1;
  if (attempts >= SPOOL_LIMITS.maxAttempts) return dropSpoolEntry(spool, entry, 'attempts_exhausted', reason);
  const next = { ...entry, attempts };
  next.name = nameOf(next);
  await rename(join(spool, entry.name), join(spool, next.name)).catch(() => {});
  return next;
}

// The content-free record of a loss: when, why, and which event and session,
// never the material.
export async function recordDropped({ spool, reason, input = null, at = Date.now() }) {
  try {
    let event = null, sessionId = null;
    try { const payload = JSON.parse(input); event = typeof payload?.hook_event_name === 'string' ? payload.hook_event_name : null; sessionId = typeof payload?.session_id === 'string' ? payload.session_id : null; } catch {}
    const directory = droppedDirectory(spool);
    const markers = await readdir(directory).catch(() => []);
    if (markers.length >= SPOOL_LIMITS.maxDropMarkers) return false;
    await writeOwnerOnly(directory, `${String(at).padStart(15, '0')}-${digest(randomUUID())}.json`, { version: 1, at: new Date(at).toISOString(), reason, event, sessionId });
    return true;
  } catch { return false; }
}

export async function dropSpoolEntry(spool, entry, reason, detail = null) {
  let input = null;
  try { input = (await readSpoolEntry(spool, entry)).input; } catch {}
  await recordDropped({ spool, reason: detail ? `${reason}:${detail}` : reason, input });
  await settleSpoolEntry(spool, entry);
  return null;
}

// Entries past the age limit are dropped with a marker, the oldest first.
export async function expireSpool(spool, now = Date.now()) {
  let dropped = 0;
  for (const entry of await spoolEntries(spool)) {
    if (now - entry.at < SPOOL_LIMITS.maxAgeMs) break;
    await dropSpoolEntry(spool, entry, 'expired');
    dropped += 1;
  }
  return dropped;
}

// What delivery and `capture inspect` report, read without opening an entry:
// how many wait and since when, and how many were lost.
export async function spoolStatus(spool) {
  // Losses are counted whatever state the spool itself is in.
  const dropped = (await readdir(droppedDirectory(spool)).catch(() => [])).filter((name) => MARKER.test(name)).length;
  const kind = await lstat(spool).catch((error) => (error.code === 'ENOENT' ? null : error));
  if (kind === null) return { pending: 0, oldestAt: null, dropped };
  try {
    if (kind instanceof Error || !kind.isDirectory()) throw kind;
    // Claimed entries wait too: a hook is writing them, or died doing so.
    const claimed = (await readdir(spool)).filter((name) => name.endsWith(CLAIM) && ENTRY.test(name.slice(0, -CLAIM.length)))
      .map((name) => ({ name, at: Number(ENTRY.exec(name.slice(0, -CLAIM.length))[1]) }));
    const waiting = [...await spoolEntries(spool), ...claimed].sort((left, right) => left.at - right.at);
    return { pending: waiting.length, oldestAt: waiting.length ? new Date(waiting[0].at).toISOString() : null, dropped };
  } catch { return { pending: 0, oldestAt: null, dropped, unreadable: true }; }
}
