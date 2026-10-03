// The host's session transcript as capture reads it (plan v1.4.4 §12.2,
// §12.2.1; PR-36). The host documents only where the transcript is and that
// it holds one JSON object per line; its entry format is internal to the host
// and changes between versions. What follows is therefore a shape hypothesis,
// checked on the owner's installed host at AG-2, and it fails closed: a line
// it does not recognise is drift, which blocks the session's transcript
// reading with a named reason instead of guessing. It reads only what capture
// needs -- assistant text, and for the §22.7 check each tool call's id, name
// and input (the name and input only to tell ShadowGraph's own calls apart,
// never stored) and each result's id -- and nothing else of an entry: no timestamps, message ids, parents or working
// directories, and no field inferred from another. Hidden reasoning
// (`thinking`, `redacted_thinking`) and any other block type are skipped.

import { createHash } from 'node:crypto';
import { isValidIsoInstant } from '../fact-validity.js';

// A read starts no new line past this many bytes (PR-36 design §5), since it
// runs under the store's lock, and stops sooner when time runs short; a line
// of up to TRANSCRIPT_LINE_BYTES is read whole, and a longer one is skipped
// unread, across reads if need be. A session writing more than this between
// two reads falls behind (declared; AG-2 measures the lock's hold).
export const TRANSCRIPT_READ_BYTES = 4 * 1024 * 1024;
export const TRANSCRIPT_LINE_BYTES = 8 * 1024 * 1024;
// The bytes before the cursor's position whose digest (never the bytes) says
// the file below it is unchanged (§6): at an anchoring, bytes from before it.
export const TRANSCRIPT_ANCHOR_BYTES = 64;
// The events at which the cursor reads: a turn's end, the host's compaction
// and the session's end. Any other event only anchors it.
export const TRANSCRIPT_TRIGGERS = Object.freeze(['Stop', 'PreCompact', 'SessionEnd']);
// Why part of a transcript was not read (§12.2, §22.7): the first two stop a
// session's reading for good; the rest are periods a session's record keeps.
export const TRANSCRIPT_GAP_REASONS = Object.freeze([
  'transcript_unrecognised', 'session_left_project', 'transcript_rewritten', 'transcript_reanchored',
  'transcript_incomplete_at_end', 'transcript_line_oversized', 'tool_calls_not_captured'
]);
const CHUNK_BYTES = 256 * 1024;
const NEWLINE = 0x0a;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const named = (value) => typeof value === 'string' && value.trim() !== '';
const count = (value) => Number.isSafeInteger(value) && value >= 0;
export const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');

// Why a session's transcript stopped being read for good, and when.
const BLOCK_REASONS = Object.freeze(['transcript_unrecognised', 'session_left_project', 'raw_expired']);
export const cursorBlock = (blocked) => isObject(blocked) && BLOCK_REASONS.includes(blocked.reason) && isValidIsoInstant(blocked.at);
// Whether a cursor has the shape this build writes (PR-36 design §4). One a
// merge or a hand edit left otherwise is never read: its position could point
// anywhere, before its anchor included.
export function cursorShape(cursor) {
  return isObject(cursor) && named(cursor.transcriptRef) && Number.isSafeInteger(cursor.transcriptGeneration) && cursor.transcriptGeneration > 0
    && count(cursor.base) && count(cursor.position) && cursor.position >= cursor.base && (cursor.skipping !== true || cursor.position > cursor.base)
    && (cursor.anchor === null || (typeof cursor.anchor === 'string' && /^[0-9a-f]{64}$/.test(cursor.anchor)))
    && typeof cursor.skipping === 'boolean' && named(cursor.project) && isValidIsoInstant(cursor.activatedAt) && isValidIsoInstant(cursor.advancedAt)
    && (cursor.lastIngestedOccurrence === null || (Number.isSafeInteger(cursor.lastIngestedOccurrence) && cursor.lastIngestedOccurrence > 0))
    && count(cursor.stopMark) && count(cursor.ends) && count(cursor.oversized) && (cursor.blocked === null || cursorBlock(cursor.blocked));
}

// What two texts are compared by when a Stop's final message is reconciled
// with its transcript copy (§8): the text with its whitespace runs collapsed
// to one space and trimmed, so a host joining blocks with other whitespace
// still matches.
export const matchKey = (text) => digest(text.replace(/\s+/g, ' ').trim());

// The end of the file's last complete line (just past its last newline), or 0
// when it has none: where a cursor is anchored, so it never starts inside a
// line (§4.1). Scanned back from the end; null when time runs out first.
export function lastLineEnd({ read, size, mayContinue }) {
  for (let end = size; end > 0;) {
    if (!mayContinue()) return null;
    const from = Math.max(0, end - CHUNK_BYTES);
    const at = read(from, end - from).lastIndexOf(NEWLINE);
    if (at !== -1) return from + at + 1;
    end = from;
  }
  return 0;
}

// The complete lines from `position` (§5), in order: { start, end, text } for
// a line (a BOM at offset 0 removed), { start, end, oversized: true } for a
// line over TRANSCRIPT_LINE_BYTES that ended, and last { start, end, skipping:
// true } when the read stops inside one, whose bytes it has consumed. A final
// line with no newline is held: it yields nothing. The read stops at the end
// of the file, when mayContinue() says so between chunks, or once a line ends
// past `budget` bytes.
export function transcriptLines({ read, size, position, skipping = false, mayContinue, budget = TRANSCRIPT_READ_BYTES }) {
  const lines = [];
  let start = position;
  let parts = [];
  let held = 0;
  let next = position;
  reading: while (next < size && mayContinue()) {
    const bytes = read(next, Math.min(CHUNK_BYTES, size - next));
    if (!bytes.length) break;
    for (let from = 0; from < bytes.length;) {
      const at = bytes.indexOf(NEWLINE, from);
      const until = at === -1 ? bytes.length : at + 1;
      if (!skipping) {
        parts.push(bytes.subarray(from, until));
        held += until - from;
      }
      if (at !== -1) {
        const end = next + until;
        // A line over the limit is unparsed wherever its end falls (its
        // newline is not counted).
        if (skipping || held - 1 > TRANSCRIPT_LINE_BYTES) lines.push({ start, end, oversized: true });
        else {
          const text = Buffer.concat(parts).toString('utf8');
          lines.push({ start, end, text: start === 0 && text.charCodeAt(0) === 0xfeff ? text.slice(1) : text });
        }
        start = end;
        parts = [];
        held = 0;
        skipping = false;
        if (end - position >= budget) break reading;
      } else if (!skipping && held > TRANSCRIPT_LINE_BYTES) {
        skipping = true;
        parts = [];
        held = 0;
      }
      from = until;
    }
    next += bytes.length;
  }
  if (skipping && next > start) lines.push({ start, end: next, skipping: true });
  return lines;
}

// One complete line's facts: { type, uuid, text, toolUses, toolResults },
// where text is an assistant entry's non-blank text blocks joined by a blank
// line (null when it has none), or { drift } naming why the line is not
// recognised.
export function transcriptEntry(line) {
  let entry;
  try { entry = JSON.parse(line); } catch { return { drift: 'line_not_json' }; }
  if (!isObject(entry) || typeof entry.type !== 'string') return { drift: 'line_not_json' };
  const facts = { type: entry.type, uuid: null, text: null, toolUses: [], toolResults: [] };
  const content = isObject(entry.message) ? entry.message.content : undefined;
  if (entry.type === 'assistant') {
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    if (!named(entry.uuid) || !Array.isArray(blocks) || !blocks.every((block) => isObject(block) && typeof block.type === 'string')) return { drift: 'entry_unrecognised' };
    const texts = [];
    for (const block of blocks) {
      if (block.type === 'text') {
        if (typeof block.text !== 'string') return { drift: 'entry_unrecognised' };
        if (block.text.trim()) texts.push(block.text);
      } else if (block.type === 'tool_use') {
        if (!named(block.id) || !named(block.name)) return { drift: 'entry_unrecognised' };
        facts.toolUses.push({ id: block.id, name: block.name, input: block.input ?? null });
      }
    }
    return { ...facts, uuid: entry.uuid, text: texts.length ? texts.join('\n\n') : null };
  }
  if (entry.type === 'user' && Array.isArray(content)) {
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result') continue;
      if (!named(block.tool_use_id)) return { drift: 'entry_unrecognised' };
      facts.toolResults.push(block.tool_use_id);
    }
  }
  return facts;
}
