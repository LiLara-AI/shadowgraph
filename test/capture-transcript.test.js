// The transcript cursor (plan v1.4.4 §12.2, §12.2.1, §12.2.2, §22.7; programme plan revision 6 PR-36; PR-36 cursor
// design revision 2 and its round-2 conditions): the assistant text no hook delivers, read from the session's
// transcript through a durable cursor on the session record, reconciled with what the hooks already captured, and
// failing closed. Every transcript here is synthetic, held in memory; no real transcript is read and no host binary
// runs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createStorage } from '../src/storage.js';
import { CAPTURE_LIMITS, openTranscript, runCapture } from '../src/capture-hook.js';
import { mintOriginId } from '../src/scope.js';
import { privilegedBindProject, privilegedRecordCapture, privilegedRecordSelfEvent, privilegedRecordTranscript, privilegedSnapshot, privilegedValidate } from '../src/internal/snapshot.js';
import { TRANSCRIPT_GAP_REASONS, TRANSCRIPT_LINE_BYTES, lastLineEnd, transcriptEntry, transcriptLines } from '../src/internal/transcript.js';
import { DELIVERY_FRAME, deliveryEndLine } from '../src/internal/delivery-marker.js';
import { attachLedgerView } from '../src/internal/deletion-knowledge.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

const ACTIVATED = '2026-01-01T00:00:00.000Z';
const WIDE = { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 };
const admission = (limits = {}) => ({ limits: { ...WIDE, ...limits }, storeBytes: 0 });

// The transcript's lines, in the shape the reader recognises (a hypothesis AG-2 confirms).
const line = (value) => `${JSON.stringify(value)}\n`;
const say = (uuid, ...texts) => line({ type: 'assistant', uuid, message: { role: 'assistant', content: texts.map((text) => ({ type: 'text', text })) } });
const use = (uuid, id, { name = 'Bash', input = { command: 'ls' }, text } = {}) => line({ type: 'assistant', uuid, message: { content: [...(text ? [{ type: 'text', text }] : []), { type: 'tool_use', id, name, input }] } });
const result = (uuid, id) => line({ type: 'user', uuid, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const ask = (uuid, text) => line({ type: 'user', uuid, message: { role: 'user', content: text } });
const think = (uuid) => line({ type: 'assistant', uuid, message: { content: [{ type: 'thinking', thinking: 'hidden reasoning' }, { type: 'redacted_thinking', data: 'x' }] } });

// A transcript in memory: the callbacks the hook passes, over bytes a test can grow, rewrite or break.
function transcript(text = '', ref = 'ref-a') {
  const file = {
    ref, bytes: Buffer.from(text), reads: 0, failAfter: Infinity,
    size: () => file.bytes.length,
    read: (start, length) => {
      if ((file.reads += 1) > file.failAfter) throw new Error('read failed');
      return file.bytes.subarray(start, start + length);
    },
    append: (more) => { file.bytes = Buffer.concat([file.bytes, Buffer.from(more)]); },
    replace: (next) => { file.bytes = Buffer.from(next); }
  };
  return file;
}

function kernel() {
  let clock = Date.parse('2026-02-01T00:00:00.000Z');
  const graph = createShadowGraph({ now: () => new Date(clock += 1000).toISOString() });
  const step = (file, fields = {}) => privilegedRecordTranscript(graph, {
    originId: 'origin-a', sessionId: 'session-1', project: 'alpha', activatedAt: ACTIVATED, trigger: null, triggerItemId: null,
    transcript: file, admission: admission(), ...fields
  });
  const read = (file, trigger = 'PreCompact', fields = {}) => step(file, { trigger, ...fields });
  const hook = (event, fields = {}) => privilegedRecordCapture(graph, {
    project: 'alpha', originId: 'origin-a', admission: admission(), ...fields, source: { sessionId: 'session-1', event, ...(fields.source ?? {}) }
  });
  const stop = (text) => hook('Stop', { text, source: { role: 'assistant' } });
  const snapshot = () => privilegedSnapshot(graph);
  const session = (sessionId = 'session-1') => (snapshot().captureSessions ?? []).find((entry) => entry.sessionId === sessionId);
  const items = (event) => snapshot().records.filter((item) => item.kind === 'capture' && (event === undefined || item.source.event === event));
  const textOf = (item) => snapshot().captureContent.find((entry) => entry.contentRef === item.contentRef)?.text;
  const transcribed = () => items('Transcript').map(textOf);
  return { graph, step, read, hook, stop, snapshot, session, items, textOf, transcribed };
}

for (const withheld of [false, true]) for (const arrival of ['complete', 'partial', 'delayed', 'retired']) test(`retention reader: expired Stop permanently blocks transcript reconciliation (${withheld ? 'quarantined' : 'live'}, ${arrival})`, () => {
  const k = kernel();
  const file = transcript();
  k.hook('UserPromptSubmit', { text: 'start', source: { hostEventId: 'prompt' } });
  k.step(file);
  const stop = k.stop('Repeated material.');
  const payload = k.snapshot();
  const expire = (value) => {
    if (value === null || typeof value !== 'object') return;
    if (value.kind === 'capture' && value.id === stop.id) value.expiresAt = '2026-01-31T00:00:00.000Z';
    for (const child of Object.values(value)) expire(child);
  };
  expire(payload);
  if (arrival === 'retired') payload.captureSessions[0].cursor.stopMark = stop.occurrenceSeq;
  k.graph.replaceData(withheld ? attachLedgerView(payload, { quarantine: [{ token: stop.erasureToken }] }) : payload);
  const delayed = say('a1', 'Repeated material.');
  file.append(ask('u1', 'new turn'));
  if (arrival === 'complete' || arrival === 'retired') file.append(delayed);
  if (arrival === 'partial') file.append(delayed.slice(0, -1));
  const reads = file.reads;
  const result = k.read(file);
  assert.deepEqual([result.ingested, result.reconciled, result.blocked], [0, 0, 'raw_expired']);
  assert.equal(k.session().cursor.blocked.reason, 'raw_expired');
  assert.equal(file.reads, reads, 'refusal consumes no transcript bytes');
  assert.equal(k.items('Transcript').length, 0, 'expired raw cannot return under a fresh transcript id');
  const completeness = k.graph.search('', { project: 'alpha' }).completeness;
  const gap = completeness.capture.gaps.find((entry) => entry.reason === 'raw_expired' && entry.sessions === 1);
  assert.deepEqual(gap, { reason: 'raw_expired', sessions: 1, from: k.session().cursor.blocked.at, to: null }, 'session refusal is disclosed without held item identity');
  assert.match(JSON.stringify(completeness), /Transcript capture remains blocked/);
  assert.equal(k.graph.search('', { project: 'beta' }).completeness.capture.gaps.some((entry) => entry.reason === 'raw_expired'), false);
  if (arrival === 'partial') file.append('\n');
  if (arrival === 'delayed') file.append(delayed);
  file.append(`${ask('u2', 'another turn')}${say('a2', 'Repeated material.')}`);
  k.graph.replaceData(k.snapshot());
  const fresh = k.read(file);
  assert.equal(fresh.ingested, 0, 'delayed bytes cannot escape a persisted refusal');
  assert.equal(file.reads, reads);
  assert.equal(k.items('Transcript').length, 0);
  const direct = k.stop('Fresh direct hook material.');
  assert.equal(k.textOf(direct), 'Fresh direct hook material.', 'direct hook capture remains available');
  if (!withheld) assert.equal(k.textOf(stop), 'Repeated material.', 'reader preserves persistence bytes for the later lifecycle sweep');
});

test('the reader recognises its hypothesis and nothing more, and fails closed on anything else', () => {
  assert.deepEqual(transcriptEntry(say('a1', 'one', '  ', 'two').trim()), { type: 'assistant', uuid: 'a1', text: 'one\n\ntwo', toolUses: [], toolResults: [] }, 'text blocks joined by a blank line; a blank block is no text');
  assert.equal(transcriptEntry(line({ type: 'assistant', uuid: 'a1', message: { content: 'plain' } })).text, 'plain', 'a string content is one text block');
  assert.deepEqual(transcriptEntry(think('a2')), { type: 'assistant', uuid: 'a2', text: null, toolUses: [], toolResults: [] }, 'hidden reasoning is never text');
  assert.deepEqual(transcriptEntry(use('a3', 't1', { text: 'Checking.' })).toolUses, [{ id: 't1', name: 'Bash', input: { command: 'ls' } }]);
  assert.deepEqual(transcriptEntry(result('u1', 't1')).toolResults, ['t1']);
  assert.deepEqual(transcriptEntry(ask('u2', 'a prompt')), { type: 'user', uuid: null, text: null, toolUses: [], toolResults: [] }, 'a user entry is never text');
  assert.equal(transcriptEntry(line({ type: 'summary', summary: 'anything' })).text, null, 'another type is skipped');
  for (const [value, drift] of [
    ['not json', 'line_not_json'], ['[1]', 'line_not_json'], ['{"no":"type"}', 'line_not_json'],
    [line({ type: 'assistant', message: { content: [] } }), 'entry_unrecognised'],
    [line({ type: 'assistant', uuid: 'a', message: { content: 7 } }), 'entry_unrecognised'],
    [line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'text', text: 7 }] } }), 'entry_unrecognised'],
    [line({ type: 'assistant', uuid: 'a', message: { content: [{ type: 'tool_use', name: 'Bash' }] } }), 'entry_unrecognised'],
    [line({ type: 'assistant', uuid: 'a', message: { content: ['text'] } }), 'entry_unrecognised'],
    [line({ type: 'user', message: { content: [{ type: 'tool_result' }] } }), 'entry_unrecognised']
  ]) assert.deepEqual(transcriptEntry(value), { drift }, value);
});

test('lines are read whole, a partial last line is held, and a BOM or line boundary is respected', () => {
  const text = `${String.fromCharCode(0xfeff)}${say('a1', 'one')}${say('a2', 'two')}{"type":"assis`;
  const file = transcript(text);
  const lines = transcriptLines({ read: file.read, size: file.size(), position: 0, mayContinue: () => true });
  assert.deepEqual(lines.map((entry) => transcriptEntry(entry.text).uuid), ['a1', 'a2'], 'the BOM is removed and the partial line held');
  assert.equal(lines.at(-1).end, Buffer.byteLength(text) - Buffer.byteLength('{"type":"assis'));
  assert.equal(lastLineEnd({ read: file.read, size: file.size(), mayContinue: () => true }), lines.at(-1).end, 'anchoring lands after the last newline');
  assert.equal(lastLineEnd({ read: file.read, size: 5, mayContinue: () => true }), 0, 'no newline at all: the start');
  assert.equal(lastLineEnd({ read: file.read, size: file.size(), mayContinue: () => false }), null, 'out of time: nothing');
  assert.equal(transcriptLines({ read: file.read, size: file.size(), position: 0, mayContinue: () => true, budget: 1 }).length, 1, 'no new line past the budget');
});

test('a cursor is anchored at the first capture: nothing already in the transcript is read, and a partial line is read once complete', () => {
  const k = kernel();
  const contemporary = say('a2', 'written as the session was first captured');
  const file = transcript(`${ask('u0', 'before')}${say('a0', 'from before capture was on')}${contemporary.slice(0, 20)}`);
  k.hook('UserPromptSubmit', { text: 'first prompt', source: { hostEventId: 'm1', role: 'user' } });
  assert.equal(k.step(file).anchored, true);
  const cursor = k.session().cursor;
  assert.equal(cursor.position, Buffer.byteLength(`${ask('u0', 'before')}${say('a0', 'from before capture was on')}`), 'on a line boundary, not inside the partial line');
  assert.deepEqual([cursor.transcriptGeneration, cursor.project, cursor.activatedAt, cursor.blocked, cursor.skipping], [1, 'alpha', ACTIVATED, null, false]);
  file.append(`${contemporary.slice(20)}${say('a3', 'later')}`);
  k.read(file);
  assert.deepEqual(k.transcribed(), ['written as the session was first captured', 'later']);
});

test('only a missing file anchors at the start; any other failure creates nothing', () => {
  const k = kernel();
  assert.equal(k.step({ ref: 'ref-a', missing: true }).anchored, true);
  assert.equal(k.session().cursor.position, 0);
  k.read(transcript(say('a1', 'the file appeared')));
  assert.deepEqual(k.transcribed(), ['the file appeared'], 'everything written after the anchor is read');
  const other = kernel();
  const failing = transcript(say('a1', 'x'));
  failing.size = () => { throw new Error('EACCES'); };
  assert.equal(other.step(failing).changed, false);
  failing.size = () => 10;
  failing.failAfter = 0;
  assert.equal(other.step(failing).changed, false, 'a read that fails anchors nothing');
  failing.size = () => failing.bytes.length;
  failing.failAfter = failing.reads + 1;
  assert.equal(other.step(failing).changed, false, 'nor does one whose anchor digest cannot be taken');
  assert.equal(other.step(null).changed, false, 'no transcript: nothing');
  assert.equal(other.session(), undefined);
});

test('one turn yields one item per piece of material: the Stop\'s final message is reconciled, whether its entry lags or not', () => {
  const k = kernel();
  const file = transcript();
  k.hook('UserPromptSubmit', { text: 'Fix the build', source: { hostEventId: 'm1', role: 'user' } });
  k.step(file);
  file.append(`${ask('u1', 'Fix the build')}${use('a1', 't1', { text: 'Let me look at the log.' })}${result('u2', 't1')}${think('a2')}`);
  k.hook('PostToolUse', { text: 'tool: Bash', source: { toolCallId: 't1' } });
  // The Stop's own read: its final entry is not written yet (the host's lag).
  const first = k.stop('The build is fixed.');
  const lagging = k.read(file, 'Stop', { triggerItemId: first.id });
  assert.deepEqual([lagging.ingested, lagging.reconciled], [1, 0]);
  file.append(`${say('a3', 'The build is fixed.')}${ask('u3', 'Thanks')}${say('a4', 'You are welcome.')}`);
  const second = k.stop('You are welcome.');
  const caughtUp = k.read(file, 'Stop', { triggerItemId: second.id });
  assert.deepEqual([caughtUp.ingested, caughtUp.reconciled], [0, 2], 'the lagging final message and the current one are both the Stops\' copies');
  assert.deepEqual(k.transcribed(), ['Let me look at the log.'], 'intermediate text is the only transcript item');
  assert.deepEqual(k.items().map((item) => item.source.event), ['UserPromptSubmit', 'PostToolUse', 'Stop', 'Transcript', 'Stop']);
  assert.deepEqual(caughtUp.gaps, [], 'every tool call is held: no gap');
});

test('a final message split over several entries is reconciled as a run, whatever whitespace the host joins it with', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u1', 'Summarise')}${say('a1', 'Part one.')}${think('a2')}${say('a3', 'Part two.')}`);
  const stop = k.stop('Part one.\nPart two.');
  const read = k.read(file, 'Stop', { triggerItemId: stop.id });
  assert.deepEqual([read.ingested, read.reconciled], [0, 1]);
  assert.deepEqual(k.transcribed(), []);
  // A prompt ends a run, and text beside a tool call is never offered as a Stop's final message.
  const broken = kernel();
  const other = transcript();
  broken.step(other);
  other.append(`${say('a1', 'Part one.')}${ask('u1', 'go on')}${say('a2', 'Part two.')}`);
  const across = broken.stop('Part one. Part two.');
  assert.equal(broken.read(other, 'Stop', { triggerItemId: across.id }).reconciled, 0, 'no run spans a prompt');
  const beside = kernel();
  const third = transcript();
  beside.step(third);
  third.append(`${ask('u1', 'x')}${use('a1', 't1', { text: 'Running the tests.' })}${result('u2', 't1')}`);
  const claimed = beside.stop('Running the tests.');
  beside.read(third, 'Stop', { triggerItemId: claimed.id, isSelfTool: () => false });
  assert.deepEqual(beside.transcribed(), ['Running the tests.'], 'recorded, and marked as a possible repeat instead');
  assert.equal(beside.items('Transcript')[0].possibleDuplicateOf, claimed.id);
});

test('a Stop is reconciled once: a second copy of its final message is recorded and marked', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u1', 'x')}${say('a1', 'Once.')}${ask('u2', 'y')}${say('a2', 'Once.')}`);
  const stop = k.stop('Once.');
  const read = k.read(file, 'Stop', { triggerItemId: stop.id });
  assert.deepEqual([read.reconciled, read.ingested], [1, 1]);
  assert.equal(k.items('Transcript')[0].possibleDuplicateOf, stop.id);
});

test('a content-less Stop\'s turn is captured from the transcript, in the Stop\'s own read', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u1', 'Which option?')}${say('a1', 'Option B: it keeps the cache warm.')}`);
  k.read(file, 'Stop');
  assert.deepEqual(k.transcribed(), ['Option B: it keeps the cache warm.'], 'no Stop can claim it, so it is not held');
});

test('a trailing run that may still be growing is held at a Stop, and judged by the next read', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u1', 'Go')}${say('a1', 'Working on it.')}`);
  const stop = k.stop('Final answer.');
  assert.equal(k.read(file, 'Stop', { triggerItemId: stop.id }).ingested, 0, 'the run is held');
  assert.equal(k.session().cursor.position, Buffer.byteLength(ask('u1', 'Go')), 'the position stays before the run');
  file.append(say('a2', 'Final answer.'));
  const judged = k.read(file, 'PreCompact');
  assert.deepEqual([judged.ingested, judged.reconciled], [1, 1]);
  assert.deepEqual(k.transcribed(), ['Working on it.']);
  // A run that begins the window is judged, so it cannot hold the cursor for ever -- even while a Stop could still
  // claim it.
  file.append(say('a3', 'Still going.'));
  const waiting = k.stop('A different final message.');
  assert.equal(k.read(file, 'Stop', { triggerItemId: waiting.id }).ingested, 1);
  assert.deepEqual(k.transcribed(), ['Working on it.', 'Still going.']);
});

test('an entry read again is skipped before any Stop is offered it, so it never takes a later Stop\'s copy', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const entry = say('a1', 'Done.');
  file.append(`${ask('u1', 'x')}${entry}`);
  k.read(file, 'Stop');
  // The host writes the same entry again, then the final message of a turn whose Stop says the same words.
  file.append(`${ask('u2', 'y')}${entry}${ask('u3', 'z')}${say('a2', 'Done.')}`);
  const stop = k.stop('Done.');
  const read = k.read(file, 'Stop', { triggerItemId: stop.id });
  assert.deepEqual([read.reconciled, read.ingested], [1, 0], 'the Stop takes its own copy, not the repeated entry');
  assert.deepEqual(k.items('Transcript').map((item) => item.source.hostEventId), ['a1']);
});

test('a Stop is reconcilable only by its own read and the next: later it never swallows a genuine repeat', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const stop = k.stop('Done.');
  k.read(file, 'Stop', { triggerItemId: stop.id });
  k.read(file, 'PreCompact');
  file.append(`${ask('u1', 'Again?')}${say('a1', 'Done.')}`);
  k.read(file, 'PreCompact');
  const [repeat] = k.items('Transcript');
  assert.equal(k.textOf(repeat), 'Done.', 'recorded, not taken for the Stop\'s copy');
  assert.equal(repeat.possibleDuplicateOf, stop.id, 'and marked as a possible repeat of it');
  // Anchoring retires every earlier Stop.
  const fresh = kernel();
  const before = fresh.stop('Done.');
  const other = transcript();
  fresh.step(other);
  other.append(say('a1', 'Done.'));
  fresh.read(other, 'PreCompact');
  assert.equal(fresh.items('Transcript')[0].possibleDuplicateOf, before.id);
});

test('a host id already ingested is skipped, and identical content under another id is marked possibleDuplicateOf', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${say('a1', 'Same words.')}${say('a1', 'Same words.')}${ask('u1', 'x')}${say('a2', 'Same words.')}`);
  k.read(file);
  const items = k.items('Transcript');
  assert.deepEqual(items.map((item) => item.source.hostEventId), ['a1', 'a2'], 'the repeated uuid is one occurrence');
  assert.deepEqual(items.map((item) => item.possibleDuplicateOf), [null, items[0].id]);
  assert.ok(items.every((item) => item.source.role === 'assistant' && item.source.turnIndex === null));
  // Only the assistant's own items are compared: the user saying the same words is no repeat.
  const other = kernel();
  const second = transcript();
  other.hook('UserPromptSubmit', { text: 'Same words.', source: { hostEventId: 'm1' } });
  other.step(second);
  second.append(say('a1', 'Same words.'));
  other.read(second);
  assert.equal(other.items('Transcript')[0].possibleDuplicateOf, null);
});

test('an unrecognised line blocks the session\'s transcript for good, keeps what came before it and records a gap', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${say('a1', 'Before the drift.')}not json at all\n${say('a2', 'After it.')}`);
  assert.equal(k.read(file).blocked, 'transcript_unrecognised');
  const cursor = k.session().cursor;
  assert.deepEqual([cursor.blocked.reason, cursor.blocked.detail], ['transcript_unrecognised', 'line_not_json']);
  assert.equal(cursor.position, Buffer.byteLength(say('a1', 'Before the drift.')), 'at the bad line');
  assert.deepEqual(k.transcribed(), ['Before the drift.']);
  file.append(say('a3', 'Later.'));
  assert.equal(k.read(file).changed, false, 'never read again');
  assert.deepEqual(k.graph.search('', { project: 'alpha' }).completeness.capture.gaps.filter((gap) => gap.reason === 'transcript_unrecognised'), [{ reason: 'transcript_unrecognised', sessions: 1, from: cursor.blocked.at, to: null }]);
  // An assistant entry without its uuid is drift too.
  const other = kernel();
  const second = transcript();
  other.step(second);
  second.append(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } }));
  assert.equal(other.read(second).blocked, 'transcript_unrecognised');
  assert.equal(other.session().cursor.blocked.detail, 'entry_unrecognised');
});

test('a changed transcript ref starts a new generation at its end: the old position is retired, the gap bounded, nothing re-scanned and the ordinal continued', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'Generation one.'));
  k.read(file);
  const before = k.session();
  const moved = transcript(`${say('b0', 'history in the new file')}${say('b1', 'also history')}`, 'ref-b');
  assert.equal(k.step(moved).bumped, true);
  const cursor = k.session().cursor;
  assert.deepEqual([cursor.transcriptGeneration, cursor.transcriptRef, cursor.position], [2, 'ref-b', moved.size()]);
  assert.deepEqual(k.session().gaps.map((gap) => [gap.reason, gap.from, gap.generation]), [['transcript_rewritten', before.cursor.advancedAt, 1]]);
  moved.append(say('b2', 'Generation two.'));
  k.read(moved);
  assert.deepEqual(k.transcribed(), ['Generation one.', 'Generation two.'], 'the new file\'s history is never read');
  assert.deepEqual(k.items('Transcript').map((item) => item.occurrenceSeq), [1, 2]);
});

test('a rewrite is found by a shorter file, a changed anchor or a line boundary gone, and each starts a new generation', () => {
  for (const [label, rewrite] of [
    ['shorter', (file) => file.replace(say('x', 'short'))],
    ['changed bytes', (file) => file.replace(file.bytes.toString().replace('Second.', 'Altered'))],
    ['boundary gone', (file) => { const text = file.bytes.toString(); file.replace(`${text.slice(0, -1)} ${say('z', 'more')}`); }]
  ]) {
    const k = kernel();
    const file = transcript();
    k.step(file);
    file.append(`${say('a1', 'First.')}${say('a2', 'Second.')}`);
    k.read(file);
    rewrite(file);
    assert.equal(k.step(file).bumped, true, label);
    assert.equal(k.session().cursor.transcriptGeneration, 2, label);
  }
});

test('R-1: an anchor keeps a digest of the bytes before it, so a rewrite is found before anything is read', () => {
  const k = kernel();
  const before = say('a0', 'before the anchor');
  const file = transcript(before);
  k.step(file);
  const tail = Buffer.from(before).subarray(-64);
  assert.equal(k.session().cursor.anchor, createHash('sha256').update(tail).digest('hex'), 'the digest of the 64 bytes before the anchor, never the bytes');
  assert.ok(!JSON.stringify(k.session()).includes('before the anchor'));
  // The host rewrites the file in place: same length and the same newline before the anchor, other bytes, and then
  // history that was never captured.
  file.replace(`${say('b0', 'rewritten history')}${say('b1', 'older history, never captured')}`.slice(0, before.length - 1) + '\n');
  file.append(say('b2', 'older history, never captured'));
  assert.equal(k.read(file, 'Stop').bumped, true, 'a rewrite is found though the newline before the anchor survives');
  assert.deepEqual(k.transcribed(), []);
  // And a newline gone before the anchor is found as before.
  const other = kernel();
  const second = transcript(before);
  other.step(second);
  second.replace(`${before.slice(0, -1)} ${say('a1', 'x')}`);
  assert.equal(other.step(second).bumped, true, 'the newline before the anchor is gone');
});

test('each session keeps its newest 8 transcript gaps and counts the rest', () => {
  const k = kernel();
  k.step(transcript('', 'ref-0'));
  for (let index = 1; index <= 10; index += 1) k.step(transcript('', `ref-${index}`));
  const session = k.session();
  assert.deepEqual([session.gaps.length, session.gapsDropped, session.gaps[0].generation, session.gaps.at(-1).generation], [8, 2, 3, 10]);
});

test('re-activating capture re-anchors the cursor: nothing written while capture was off is read', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'While capture was on.'));
  k.read(file);
  file.append(say('a2', 'While capture was off.'));
  const reactivated = '2026-03-01T00:00:00.000Z';
  assert.equal(k.read(file, 'Stop', { activatedAt: reactivated }).reanchored, true);
  file.append(say('a3', 'After re-activation.'));
  k.read(file, 'Stop', { activatedAt: reactivated });
  assert.deepEqual(k.transcribed(), ['While capture was on.', 'After re-activation.']);
  assert.deepEqual(k.session().gaps.map((gap) => gap.reason), ['transcript_reanchored']);
  assert.equal(k.session().cursor.activatedAt, reactivated);
});

test('a session that leaves its project stops being read for good, and a cursor never reads under another project', () => {
  for (const elsewhere of ['beta', null]) {
    const k = kernel();
    const file = transcript();
    k.hook('UserPromptSubmit', { text: 'in alpha', source: { hostEventId: 'm1' } });
    k.step(file);
    file.append(say('a1', 'Work in beta or in no project.'));
    const left = k.step(elsewhere === null ? null : file, { project: elsewhere });
    assert.deepEqual([left.blocked, left.changed], ['session_left_project', true], String(elsewhere));
    file.append(say('a2', 'Back in alpha.'));
    assert.equal(k.read(file, 'Stop').changed, false);
    assert.deepEqual(k.transcribed(), []);
    const gaps = k.graph.search('', { project: 'alpha' }).completeness.capture.gaps;
    assert.deepEqual(gaps.map((gap) => [gap.reason, gap.sessions, gap.to]), [['session_left_project', 1, null]]);
    assert.ok(!JSON.stringify(gaps).includes('beta'), 'the gap names no project');
  }
  // A session another project owns never gets a cursor for this one.
  const k = kernel();
  k.hook('UserPromptSubmit', { text: 'in beta', project: 'beta', source: { hostEventId: 'm1' } });
  assert.equal(k.step(transcript()).changed, false);
  assert.equal(k.session().cursor, undefined);
});

test('ShadowGraph\'s own sessions are never read, a self-event only checks the project, and an S-2 mark in a tool call marks that call only', () => {
  const worker = kernel();
  privilegedRecordSelfEvent(worker.graph, { project: 'alpha', originId: 'origin-a', signal: 'S-3', source: { event: 'Stop', sessionId: 'session-1' } });
  assert.equal(worker.step(transcript(say('a1', 'worker output'))).changed, false, 'a worker\'s session gets no cursor');
  const marked = kernel();
  privilegedRecordSelfEvent(marked.graph, { project: 'alpha', originId: 'origin-a', signal: 'S-2', source: { event: 'UserPromptSubmit', sessionId: 'session-1' } });
  assert.equal(marked.step(transcript()).changed, false, 'a correlation-marked prompt makes the session ShadowGraph\'s own');
  const tool = kernel();
  privilegedRecordSelfEvent(tool.graph, { project: 'alpha', originId: 'origin-a', signal: 'S-2', source: { event: 'PostToolUse', sessionId: 'session-1' } });
  assert.equal(tool.step(transcript()).anchored, true, 'a marked tool call leaves the user\'s session readable');
  const self = kernel();
  const file = transcript();
  self.step(file);
  file.append(say('a1', 'x'));
  assert.equal(self.step(file, { selfEvent: true, trigger: 'Stop' }).changed, false, 'a self-event reads nothing');
  assert.equal(self.step(null, { selfEvent: true, project: 'beta' }).blocked, 'session_left_project', 'but its project is checked');
});

test('a tool call the transcript shows but no capture holds is an unknown period with bounds (§22.7)', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const from = k.session().cursor.advancedAt;
  k.hook('PostToolUse', { text: 'tool: Bash', source: { toolCallId: 'held' } });
  file.append([
    use('a1', 'held'), result('u1', 'held'),
    use('a2', 'lost'), result('u2', 'lost'),
    use('a3', 'mine', { name: 'mcp__shadowgraph__search', input: {} }), result('u3', 'mine'),
    use('a4', 'split')
  ].join(''));
  const read = k.read(file, 'Stop', { isSelfTool: (name) => name.startsWith('mcp__shadowgraph__') });
  assert.deepEqual(read.gaps.map((gap) => [gap.reason, gap.from, gap.generation]), [['tool_calls_not_captured', from, 1]]);
  assert.ok(read.gaps[0].to > from);
  file.append(result('u4', 'split'));
  assert.deepEqual(k.read(file, 'Stop').gaps, [], 'a call whose use and result fall in different reads is not checked');
  const conservative = kernel();
  const other = transcript();
  conservative.step(other);
  other.append(`${use('a1', 't')}${result('u1', 't')}`);
  assert.equal(conservative.read(other, 'Stop', { isSelfTool: () => { throw new Error('x'); } }).gaps.length, 1, 'a classification that fails counts the call as missing');
  // Each condition on its own: a held call, ShadowGraph's own call and a call not yet answered are not missing.
  for (const [label, lines, held] of [
    ['held', `${use('a1', 'kept')}${result('u1', 'kept')}`, 'kept'],
    ['own', `${use('a1', 'mine', { name: 'mcp__shadowgraph__search', input: {} })}${result('u1', 'mine')}`, null],
    ['unanswered', use('a1', 'open'), null]
  ]) {
    const alone = kernel();
    const file = transcript();
    alone.step(file);
    if (held) alone.hook('PostToolUse', { text: 'tool: Bash', source: { toolCallId: held } });
    file.append(lines);
    assert.deepEqual(alone.read(file, 'Stop', { isSelfTool: (name) => name.startsWith('mcp__shadowgraph__') }).gaps, [], label);
  }
});

test('PreCompact and SessionEnd flush the cursor and record no item; a session end with material left records the gap', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'Before compaction.'));
  k.read(file, 'PreCompact');
  assert.deepEqual(k.transcribed(), ['Before compaction.']);
  file.append(`${say('a2', 'Last words.')}{"type":"assistant","uuid":"a3","mess`);
  const end = k.read(file, 'SessionEnd');
  assert.deepEqual(end.gaps.map((gap) => gap.reason), ['transcript_incomplete_at_end']);
  assert.equal(k.session().cursor.ends, 1);
  k.read(file, 'SessionEnd');
  assert.equal(k.session().cursor.ends, 2, 'a resumed session\'s later end is counted');
  assert.deepEqual(k.items().map((item) => item.source.event), ['Transcript', 'Transcript'], 'the flush triggers record no item');
});

test('a read stops when time runs short and resumes exactly; a failing read keeps what it consumed', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append([ask('u1', 'x'), say('a1', 'One.'), ask('u2', 'y'), say('a2', 'Two.'), ask('u3', 'z'), say('a3', 'Three.')].join(''));
  let checks = 0;
  assert.equal(k.read(file, 'PreCompact', { mayContinue: () => (checks += 1) <= 4 }).changed, true);
  const position = k.session().cursor.position;
  assert.ok(position > 0 && position < file.size(), 'a partial position');
  k.read(file, 'PreCompact');
  assert.deepEqual(k.transcribed(), ['One.', 'Two.', 'Three.'], 'nothing lost or repeated');
});

test('a read that fails part way keeps the lines it consumed, anchors on them, and the next read resumes after them', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const long = 'y'.repeat(300 * 1024); // its line spans two 256 KiB chunks
  file.append(`${say('a1', 'Readable.')}${say('a2', long)}`);
  // The second chunk's read fails once; the anchor's read after it succeeds.
  const read = file.read;
  const failOn = file.reads + 2;
  file.read = (start, length) => {
    if (file.reads + 1 === failOn) { file.reads += 1; throw new Error('once'); }
    return read(start, length);
  };
  const first = k.read(file);
  assert.deepEqual([first.changed, first.ingested], [true, 1]);
  const cursor = k.session().cursor;
  assert.equal(cursor.position, Buffer.byteLength(say('a1', 'Readable.')), 'at the end of the consumed line');
  assert.notEqual(cursor.anchor, null, 'the failure before the anchor\'s own read does not spoil it');
  assert.equal(k.read(file).bumped, false);
  assert.deepEqual(k.transcribed(), ['Readable.', long], 'a line spanning two chunks is read whole');
});

test('an anchor a failed read could not take makes the next check start a new generation, never read on blind', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'Readable.'));
  file.failAfter = file.reads + 1; // the chunk is read; the anchor's read fails
  k.read(file);
  assert.equal(k.session().cursor.anchor, null);
  file.failAfter = Infinity;
  file.append(say('a2', 'After.'));
  const next = k.read(file);
  assert.equal(next.bumped, true);
  assert.deepEqual(k.session().gaps.map((gap) => gap.reason), ['transcript_rewritten']);
  assert.deepEqual(k.transcribed(), ['Readable.']);
});

test('an oversized line is skipped unread, across reads if need be, then counted with a gap', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  // Past the limit by more than a read's chunk, so no chunk holds both the overflow and the line's end.
  file.append(`${say('a1', 'x'.repeat(TRANSCRIPT_LINE_BYTES + 512 * 1024))}${say('a2', 'After the big line.')}`);
  // Tied to the read's 256 KiB chunk (review T-8): 34 chunks pass the line's 8 MiB limit, and stop short of its end.
  let chunks = 0;
  k.read(file, 'PreCompact', { mayContinue: () => (chunks += 1) <= 34 });
  assert.equal(k.session().cursor.skipping, true, 'part way through the line');
  k.read(file, 'PreCompact');
  const session = k.session();
  assert.deepEqual([session.cursor.skipping, session.cursor.oversized], [false, 1]);
  assert.deepEqual(session.gaps.map((gap) => gap.reason), ['transcript_line_oversized']);
  assert.deepEqual(k.transcribed(), ['After the big line.']);
});

test('the store-bytes limit is checked against every item a read adds, not one measurement', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${say('a1', 'first')}${say('a2', 'second')}`);
  const read = k.read(file, 'PreCompact', { admission: { limits: { ...WIDE, maxStoreBytes: 8 * 1024 }, storeBytes: 0 } });
  assert.deepEqual([read.ingested, read.refused], [1, 1]);
  assert.equal(k.session().cursor.position, file.size(), 'a refused item is passed over');
});

test('transcript text is stripped of delivered blocks, no path is stored, and a purge removes the cursor', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const body = `${DELIVERY_FRAME}\nhead: {}\n`;
  const block = `${body}${deliveryEndLine(Buffer.byteLength(body))}`;
  file.append(say('a1', `Quoting memory:\n${block}\nThen my own words.`));
  k.read(file);
  assert.equal(k.transcribed()[0], 'Quoting memory:\n\nThen my own words.');
  assert.deepEqual(k.session().selfEvents, { 'S-1': { Transcript: 1 } });
  k.graph.purgeProject('alpha', { mode: 'hard' });
  assert.equal(k.session(), undefined);
});

test('the capture status declares each transcript gap by reason, counted by session, only in the owning scope', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${use('a1', 't')}${result('u1', 't')}`);
  k.read(file, 'Stop');
  k.step(transcript('', 'ref-other'), { sessionId: 'session-2' });
  k.step(null, { sessionId: 'session-2', project: 'beta' });
  const gaps = k.graph.search('', { project: 'alpha' }).completeness.capture.gaps;
  assert.deepEqual(gaps.map((gap) => [gap.reason, gap.sessions]), [['session_left_project', 1], ['tool_calls_not_captured', 1]]);
  assert.ok(gaps.every((gap) => TRANSCRIPT_GAP_REASONS.includes(gap.reason)));
  assert.ok(!JSON.stringify(gaps).includes('session-'), 'no session is named');
  assert.deepEqual(k.graph.search('', { project: 'beta' }).completeness.capture.gaps, [], 'another project sees none of it');
});

test('a store the cursor wrote is read, validated and carried by the build before it (PR-36c), so no reader change is needed', async (t) => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'Carried.'));
  k.read(file);
  // Everything the cursor keeps: a missing call's gap, more gaps than are kept, and a stopped cursor.
  file.append(`${use('a2', 'lost')}${result('u1', 'lost')}${say('a3', 'Carried too.')}`);
  k.read(file, 'Stop');
  for (let index = 1; index <= 9; index += 1) k.step(transcript('', `ref-${index}`));
  k.read(transcript('not json\n', 'ref-9'));
  const kept = k.session();
  assert.deepEqual([kept.gaps.length, kept.gapsDropped > 0, kept.cursor.blocked.reason], [8, true, 'transcript_unrecognised']);
  const store = k.snapshot();
  const fresh = createShadowGraph();
  fresh.importData(store);
  assert.equal(privilegedValidate(fresh).valid, true);
  assert.deepEqual(privilegedSnapshot(fresh).captureSessions, store.captureSessions, 'this build carries it');
  let tree;
  try { tree = execFileSync('git', ['ls-tree', '-r', '--name-only', '6e3a014', 'src'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().split('\n'); } catch { tree = null; }
  if (!tree) { t.skip('the history does not hold 6e3a014'); return; }
  const root = await scratchDirectory(t, 'shadowgraph-pr36c-');
  for (const path of tree) {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), execFileSync('git', ['show', `6e3a014:${path}`]));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const earlier = await import(pathToFileURL(join(root, 'src', 'shadowgraph.js')).href);
  const snapshots = await import(pathToFileURL(join(root, 'src', 'internal', 'snapshot.js')).href);
  const graph = earlier.createShadowGraph();
  graph.importData(store);
  assert.equal(snapshots.privilegedValidate(graph).valid, true);
  const carried = snapshots.privilegedSnapshot(graph);
  assert.deepEqual(carried.captureSessions, store.captureSessions, 'the cursor and its gaps are carried verbatim');
  assert.deepEqual(carried.records.filter((item) => item.kind === 'capture'), store.records.filter((item) => item.kind === 'capture'));
  // Its writer keeps the cursor through its session-record spread.
  snapshots.privilegedRecordCapture(graph, { project: 'alpha', originId: 'origin-a', text: 'later', admission: admission(), source: { event: 'UserPromptSubmit', sessionId: 'session-1', hostEventId: 'm9' } });
  assert.deepEqual(snapshots.privilegedSnapshot(graph).captureSessions[0].cursor, store.captureSessions[0].cursor);
});

// ---------------------------------------------------------------------------
// The review round (briefs/PR36-review-correctness.md, -contract.md, -tests.md).
// ---------------------------------------------------------------------------

test('K-1: a cursor makes its session record its project\'s own, so a purge of that project leaves nothing behind', () => {
  for (const mode of ['logical', 'hard']) {
    // A first event in alpha that records no item (a content-less Stop, a flush, a refused prompt) creates the cursor.
    const k = kernel();
    k.step(transcript());
    assert.equal(k.session().project, 'alpha');
    const refused = k.hook('UserPromptSubmit', { project: 'beta', text: 'in beta', source: { hostEventId: 'm1' } });
    assert.ok(refused.refused, 'beta\'s capture is refused, not filed under alpha\'s session (D-6)');
    assert.deepEqual(k.items(), [], 'the session stays alpha\'s');
    assert.equal(k.step(null, { project: 'beta' }).blocked, 'session_left_project');
    assert.ok(!(k.graph.search('', { project: 'beta' }).completeness.capture?.gaps ?? []).some((gap) => gap.reason === 'session_left_project'), 'beta sees nothing of alpha\'s transcript');
    k.graph.purgeProject('alpha', { mode });
    assert.ok((k.snapshot().captureSessions ?? []).every((entry) => entry.project !== 'alpha' && entry.cursor?.project !== 'alpha'), `${mode}: no session record or cursor names the purged project`);
    // A session a self-event opened in beta takes alpha, the project its cursor was made for.
    const opened = kernel();
    privilegedRecordSelfEvent(opened.graph, { project: 'beta', originId: 'origin-a', signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'session-1' } });
    opened.step(transcript());
    assert.equal(opened.session().project, 'alpha');
    opened.graph.purgeProject('alpha', { mode });
    assert.equal(opened.session(), undefined, `${mode}: the record goes with alpha`);
  }
});

test('C-1: a malformed cursor is never read: it is stopped with a declared gap', () => {
  for (const [label, change] of [
    ['a null position', { position: null }], ['a negative position', { position: -1 }], ['a position below its base', { position: 0, base: 5 }],
    ['a string position', { position: '12' }], ['no project', { project: null }], ['a malformed anchor', { anchor: 'x' }]
  ]) {
    const k = kernel();
    const file = transcript(say('a0', 'history from before the first capture'));
    k.step(file);
    const store = k.snapshot();
    store.captureSessions[0].cursor = { ...store.captureSessions[0].cursor, ...change };
    const merged = createShadowGraph({ now: () => '2026-02-02T00:00:00.000Z' });
    merged.importData(store);
    file.append(say('a1', 'later'));
    const read = privilegedRecordTranscript(merged, { originId: 'origin-a', sessionId: 'session-1', project: 'alpha', activatedAt: ACTIVATED, trigger: 'Stop', triggerItemId: null, transcript: file, admission: admission() });
    assert.equal(read.blocked, 'transcript_unrecognised', label);
    const snapshot = privilegedSnapshot(merged);
    assert.equal(snapshot.captureSessions[0].cursor.blocked.detail, 'cursor_malformed', label);
    assert.deepEqual(snapshot.records.filter((item) => item.kind === 'capture'), [], `${label}: nothing read`);
  }
});

test('C-1: every cursor field this build writes is checked, a stop included', () => {
  for (const [label, change] of [
    ['generation 0', { transcriptGeneration: 0 }], ['a null base', { base: null }], ['a string skipping', { skipping: 'no' }],
    ['an advancedAt that is no instant', { advancedAt: 'soon' }], ['a null stop mark', { stopMark: null }], ['a negative end count', { ends: -1 }],
    ['a string oversized count', { oversized: '1' }], ['a stop of no known reason', { blocked: { reason: 'other', at: '2026-02-01T00:00:00.000Z' } }],
    ['a stop with no instant', { blocked: { reason: 'session_left_project', at: 'x' } }], ['skipping at its base (S06)', { skipping: true }]
  ]) {
    const k = kernel();
    const file = transcript(say('a0', 'history from before the first capture'));
    k.step(file);
    const store = k.snapshot();
    store.captureSessions[0].cursor = { ...store.captureSessions[0].cursor, ...change };
    const merged = createShadowGraph({ now: () => '2026-02-02T00:00:00.000Z' });
    merged.importData(store);
    file.append(say('a1', 'later'));
    const read = privilegedRecordTranscript(merged, { originId: 'origin-a', sessionId: 'session-1', project: 'alpha', activatedAt: ACTIVATED, trigger: 'Stop', triggerItemId: null, transcript: file, admission: admission() });
    assert.equal(read.blocked, 'transcript_unrecognised', label);
    assert.equal(privilegedSnapshot(merged).captureSessions[0].cursor.blocked.detail, 'cursor_malformed', label);
    assert.ok(merged.search('', { project: 'alpha' }).completeness.capture.gaps.some((gap) => gap.reason === 'transcript_unrecognised'), `${label}: declared`);
  }
});

test('C-1: a cursor already stopped is left as it is, whatever else is wrong with it', () => {
  const k = kernel();
  k.step(transcript());
  k.step(null, { project: 'beta' });
  const store = k.snapshot();
  store.captureSessions[0].cursor = { ...store.captureSessions[0].cursor, position: null };
  const merged = createShadowGraph({ now: () => '2026-02-02T00:00:00.000Z' });
  merged.importData(store);
  const read = privilegedRecordTranscript(merged, { originId: 'origin-a', sessionId: 'session-1', project: 'alpha', activatedAt: ACTIVATED, trigger: 'Stop', triggerItemId: null, transcript: transcript(), admission: admission() });
  assert.equal(read.changed, false);
  assert.equal(privilegedSnapshot(merged).captureSessions[0].cursor.blocked.reason, 'session_left_project');
});

test('C-3: an oversized line after a cut is left for the next read and counted once', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u0', 'x')}${say('a1', 'One.')}${say('a2', 'Two.')}${say('a3', 'x'.repeat(TRANSCRIPT_LINE_BYTES + 512 * 1024))}${say('a4', 'After.')}`);
  const recorded = () => privilegedSnapshot(k.graph).records.filter((item) => item.kind === 'capture').length;
  k.read(file, 'PreCompact', { mayContinue: () => recorded() < 1 });
  for (let index = 0; index < 3; index += 1) k.read(file, 'PreCompact');
  assert.deepEqual([k.session().cursor.oversized, k.session().gaps.map((gap) => gap.reason)], [1, ['transcript_line_oversized']]);
  assert.deepEqual(k.transcribed(), ['One.', 'Two.', 'After.']);
});

test('C-3: after a cut nothing later in the read is recorded or judged', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u0', 'x')}${say('a1', 'One.')}${say('a2', 'Two.')}${use('a3', 't1', { text: 'Checking.' })}${result('u1', 't1')}`);
  const recorded = () => privilegedSnapshot(k.graph).records.filter((item) => item.kind === 'capture').length;
  k.read(file, 'PreCompact', { mayContinue: () => recorded() < 1 });
  assert.deepEqual(k.transcribed(), ['One.'], 'the text beside the tool call waits for time, like the rest');
  k.read(file, 'PreCompact');
  assert.deepEqual(k.transcribed(), ['One.', 'Two.', 'Checking.']);
});

test('C-3: text of exactly maxItemBytes is still compared with the Stop, and so is text over it before stripping', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const text = 'w'.repeat(1024);
  file.append(`${ask('u1', 'x')}${say('a1', text)}`);
  const stop = k.stop(text);
  const read = k.read(file, 'Stop', { triggerItemId: stop.id, admission: admission({ maxItemBytes: 1024 }) });
  assert.deepEqual([read.ingested, read.reconciled], [0, 1]);
  // A final message that quotes a delivered block fits once the block is removed, as the Stop's did (review R2-a).
  const quoting = kernel();
  const second = transcript();
  quoting.step(second);
  const body = `${DELIVERY_FRAME}\n${'m'.repeat(600)}\n`;
  const final = `${'q'.repeat(700)}\n${body}${deliveryEndLine(Buffer.byteLength(body))}\nEnd.`;
  second.append(`${ask('u1', 'x')}${say('a1', final)}`);
  const quoted = quoting.hook('Stop', { text: final, admission: admission({ maxItemBytes: 1024 }), source: { role: 'assistant' } });
  assert.equal(quoted.refused, undefined, 'the Stop fits once stripped');
  const matched = quoting.read(second, 'Stop', { triggerItemId: quoted.id, admission: admission({ maxItemBytes: 1024 }) });
  assert.deepEqual([matched.ingested, matched.reconciled], [0, 1]);
});

test('T-2: the event\'s own item is counted with its text and its observation', () => {
  for (const [label, text, observation, maxStoreBytes] of [
    ['its text', 'w'.repeat(4096), undefined, 15 * 1024],
    ['its observation', 'Final.', { host: 'claude-code', hostVersion: null, toolName: null, cwd: `/${'c'.repeat(2000)}`, outcome: null }, 16 * 1024]
  ]) {
    const k = kernel();
    const file = transcript();
    k.step(file);
    file.append(`${ask('u0', 'x')}${say('a1', 'Intermediate.')}${say('a2', text)}`);
    const stop = k.hook('Stop', { text, ...(observation ? { observation } : {}), source: { role: 'assistant' } });
    const read = k.read(file, 'Stop', { triggerItemId: stop.id, admission: { limits: { ...WIDE, maxStoreBytes }, storeBytes: 0 } });
    assert.deepEqual([read.refused, read.reconciled], [1, 1], label);
  }
});

test('C-2: a re-activation that finds the file gone changes nothing, and history that appears later is not read', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'Consumed.'));
  k.read(file);
  const later = '2026-03-01T00:00:00.000Z';
  assert.equal(k.read({ ref: 'ref-a', missing: true }, 'Stop', { activatedAt: later }).changed, false);
  const reappeared = transcript(say('h1', 'history from while capture was off'));
  k.step(reappeared, { activatedAt: later });
  reappeared.append(say('a2', 'New.'));
  k.read(reappeared, 'PreCompact', { activatedAt: later });
  assert.deepEqual(k.transcribed(), ['Consumed.', 'New.']);
});

test('the result reports the bytes a read consumed', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'Once.'));
  assert.equal(k.read(file).read, Buffer.byteLength(say('a1', 'Once.')));
});

test('S18: a held run is held from its first entry not yet ingested, so the next read can still match it whole', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const first = say('a1', 'Earlier words.');
  file.append(`${ask('u0', 'x')}${first}`);
  k.read(file, 'PreCompact');
  const stop = k.stop('Final answer.');
  file.append(`${ask('u1', 'y')}${first}${say('a2', 'Final')}${say('a3', 'answer.')}`);
  let lines = 0; // the chunk, then u1, a1 again and a2: out of time before a3 (tied to the checks a line costs)
  k.read(file, 'PreCompact', { triggerItemId: stop.id, mayContinue: () => (lines += 1) <= 4 });
  const judged = k.read(file, 'PreCompact');
  assert.deepEqual([judged.ingested, judged.reconciled], [0, 1]);
});

test('a run that begins the window with an entry already ingested is still held from its first new entry', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const first = say('a1', 'Earlier words.');
  file.append(`${ask('u0', 'x')}${first}`);
  k.read(file, 'PreCompact');
  file.append(`${first}${say('a2', 'Final')}`);
  const stop = k.stop('Final answer.');
  assert.equal(k.read(file, 'Stop', { triggerItemId: stop.id }).ingested, 0, 'held from a2, not judged half-written');
  file.append(say('a3', 'answer.'));
  const judged = k.read(file, 'PreCompact');
  assert.deepEqual([judged.ingested, judged.reconciled], [0, 1]);
});

test('a merged record whose cursor names another project is stopped, never read under either', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const store = k.snapshot();
  store.captureSessions[0].cursor = { ...store.captureSessions[0].cursor, project: 'beta' };
  const merged = createShadowGraph({ now: () => '2026-02-02T00:00:00.000Z' });
  merged.importData(store);
  file.append(say('a1', 'Whose?'));
  const read = privilegedRecordTranscript(merged, { originId: 'origin-a', sessionId: 'session-1', project: 'alpha', activatedAt: ACTIVATED, trigger: 'Stop', triggerItemId: null, transcript: file, admission: admission() });
  assert.equal(read.blocked, 'session_left_project');
  assert.deepEqual(privilegedSnapshot(merged).records.filter((item) => item.kind === 'capture'), []);
});

test('a read with nothing new writes nothing', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'Once.'));
  assert.equal(k.read(file).changed, true);
  const before = JSON.stringify(k.snapshot());
  assert.equal(k.read(file).changed, false);
  assert.equal(JSON.stringify(k.snapshot()), before);
});

test('C-2: a transcript gone after it was read changes nothing, and a file that then appears there is anchored at its end', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'Consumed.'));
  k.read(file);
  const before = k.session();
  assert.equal(k.read({ ref: 'ref-a', missing: true }, 'Stop').changed, false);
  assert.deepEqual(k.session(), before);
  // A file at the same path carrying history the session never captured.
  const reappeared = transcript(`${say('h1', 'history one')}${say('h2', 'history two')}${say('h3', 'history three')}`);
  assert.equal(k.step(reappeared).bumped, true);
  assert.equal(k.session().cursor.position, reappeared.size());
  reappeared.append(say('a2', 'New.'));
  k.read(reappeared);
  assert.deepEqual(k.transcribed(), ['Consumed.', 'New.']);
});

test('C-3: time is checked before each item is recorded; a run cut short resumes at its first unrecorded entry', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u0', 'x')}${say('a1', 'One.')}${say('a2', 'Two.')}${say('a3', 'Three.')}${say('a4', 'Four.')}`);
  const recorded = () => privilegedSnapshot(k.graph).records.filter((item) => item.kind === 'capture').length;
  const first = k.read(file, 'PreCompact', { mayContinue: () => recorded() < 2 });
  assert.equal(first.ingested, 2);
  const position = k.session().cursor.position;
  assert.equal(position, Buffer.byteLength(`${ask('u0', 'x')}${say('a1', 'One.')}${say('a2', 'Two.')}`), 'at the first entry not recorded');
  k.read(file, 'PreCompact');
  assert.deepEqual(k.transcribed(), ['One.', 'Two.', 'Three.', 'Four.'], 'nothing lost or repeated');
});

test('C-3: text too long for any item is refused at once, never compared, and ends a run', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u0', 'x')}${say('a1', 'Before.')}${say('a2', 'w'.repeat(2048))}${say('a3', 'After.')}`);
  const stop = k.stop('Before. After.');
  const read = k.read(file, 'Stop', { triggerItemId: stop.id, admission: admission({ maxItemBytes: 1024 }) });
  assert.deepEqual([read.refused, read.reconciled, read.ingested], [1, 0, 1], 'the long text splits the run: neither half is the Stop\'s whole message');
  k.read(file, 'PreCompact', { admission: admission({ maxItemBytes: 1024 }) });
  assert.deepEqual(k.transcribed(), ['Before.', 'After.'], 'the trailing half, held for the Stop, is judged by the next read');
});

test('T-2: a read counts the event\'s own item accepted in the same hold against the store\'s bytes', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u0', 'x')}${say('a1', 'Intermediate.')}${say('a2', 'Final.')}`);
  const stop = k.stop('Final.');
  const read = k.read(file, 'Stop', { triggerItemId: stop.id, admission: { limits: { ...WIDE, maxStoreBytes: 10 * 1024 }, storeBytes: 0 } });
  assert.deepEqual([read.ingested, read.refused], [0, 1], 'the Stop took the room left');
});

test('a re-activation raises the generation and labels its gap with the old one', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  k.read(file, 'Stop', { activatedAt: '2026-03-01T00:00:00.000Z' });
  assert.equal(k.session().cursor.transcriptGeneration, 2);
  assert.deepEqual(k.session().gaps.map((gap) => [gap.reason, gap.generation]), [['transcript_reanchored', 1]]);
});

test('a new generation keeps the end count, the oversized count and the last ingested ordinal', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${say('a0', 'x'.repeat(TRANSCRIPT_LINE_BYTES + 512 * 1024))}${say('a1', 'kept')}`);
  k.read(file, 'PreCompact');
  k.read(file, 'SessionEnd');
  const before = k.session().cursor;
  assert.deepEqual([before.ends, before.oversized, before.lastIngestedOccurrence], [1, 1, 1]);
  k.step(transcript('', 'ref-b'));
  const after = k.session().cursor;
  assert.deepEqual([after.transcriptGeneration, after.ends, after.oversized, after.lastIngestedOccurrence], [2, 1, 1, 1]);
  k.step(transcript('', 'ref-c'), { trigger: 'SessionEnd' });
  assert.equal(k.session().cursor.ends, 2, 'a SessionEnd that starts a new generation is counted too');
});

test('a blank line and an entry of another type neither block nor end a run', () => {
  for (const between of ['\n', '\r\n', line({ type: 'system', content: 'note' })]) {
    const k = kernel();
    const file = transcript();
    k.step(file);
    file.append(`${ask('u1', 'Summarise')}${say('a1', 'Part one.')}${between}${say('a2', 'Part two.')}`);
    const stop = k.stop('Part one. Part two.');
    const read = k.read(file, 'Stop', { triggerItemId: stop.id });
    assert.deepEqual([read.blocked, read.ingested, read.reconciled], [null, 0, 1], JSON.stringify(between));
  }
});

test('an oversized line ends a run, so a held run never rewinds over it', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u0', 'x')}${say('a1', 'Part one.')}${say('a2', 'x'.repeat(TRANSCRIPT_LINE_BYTES + 512 * 1024))}`);
  const stop = k.stop('Something else.');
  k.read(file, 'Stop', { triggerItemId: stop.id });
  k.read(file, 'PreCompact');
  assert.equal(k.session().cursor.oversized, 1, 'skipped and counted once');
  assert.deepEqual(k.transcribed(), ['Part one.']);
});

test('a flush read cut short by time holds a trailing run a Stop may still claim', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const stop = k.stop('Final answer.');
  file.append(`${ask('u1', 'Go')}${say('a1', 'Final')}${say('a2', 'answer.')}`);
  let lines = 0; // the chunk, then u1 and a1: out of time before a2
  k.read(file, 'PreCompact', { triggerItemId: stop.id, mayContinue: () => (lines += 1) <= 3 });
  assert.deepEqual(k.transcribed(), [], 'held, not judged half-written');
  const judged = k.read(file, 'PreCompact');
  assert.deepEqual([judged.ingested, judged.reconciled], [0, 1]);
});

test('a read blocked by drift judges the run before the bad line and stays at that line', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u1', 'x')}${say('a1', 'Working.')}not json\n`);
  const stop = k.stop('Other.');
  k.read(file, 'Stop', { triggerItemId: stop.id });
  assert.deepEqual(k.transcribed(), ['Working.']);
  assert.equal(k.session().cursor.position, Buffer.byteLength(`${ask('u1', 'x')}${say('a1', 'Working.')}`));
});

test('a drifting session end records the stop, not also an incomplete end (S27: the stop already covers the rest)', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`not json\n${say('a1', 'x')}`);
  const end = k.read(file, 'SessionEnd');
  assert.deepEqual([end.blocked, end.gaps], ['transcript_unrecognised', []]);
});

test('a final message quoting delivered memory is reconciled with its Stop', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const body = `${DELIVERY_FRAME}\nhead: {}\n`;
  const final = `Quoting memory:\n${body}${deliveryEndLine(Buffer.byteLength(body))}\nThen my own words.`;
  file.append(`${ask('u1', 'x')}${say('a1', final)}`);
  const stop = k.stop(final);
  const read = k.read(file, 'Stop', { triggerItemId: stop.id });
  assert.deepEqual([read.ingested, read.reconciled], [0, 1]);
});

test('possibleDuplicateOf names the newest assistant repeat of the same session only', () => {
  const k = kernel();
  const file = transcript();
  k.hook('Stop', { text: 'Same.', source: { role: 'assistant', sessionId: 'session-2' } });
  k.step(file);
  file.append(`${say('a1', 'Same.')}${ask('u1', 'x')}${say('a2', 'Same.')}${ask('u2', 'y')}${say('a3', 'Same.')}`);
  k.read(file);
  const items = k.items('Transcript');
  assert.deepEqual(items.map((item) => item.possibleDuplicateOf), [null, items[0].id, items[1].id]);
});

test('a run holding an entry already ingested is judged entry by entry (S12: it was judged in part before)', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const first = say('a1', 'First part.');
  file.append(`${ask('u0', 'x')}${first}`);
  k.read(file, 'PreCompact');
  file.append(`${ask('u1', 'y')}${first}${say('a2', 'Second part.')}`);
  const stop = k.stop('First part. Second part.');
  const read = k.read(file, 'Stop', { triggerItemId: stop.id });
  assert.deepEqual([read.reconciled, read.ingested], [0, 1]);
});

test('a call a PostToolUseFailure holds is captured, and one gap covers every missing call of a read', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  k.hook('PostToolUseFailure', { text: 'tool: Bash', source: { toolCallId: 'failed' } });
  file.append(`${use('a1', 'failed')}${result('u1', 'failed')}`);
  assert.deepEqual(k.read(file, 'Stop').gaps, []);
  file.append(`${use('a2', 'lost-1')}${result('u2', 'lost-1')}${use('a3', 'lost-2')}${result('u3', 'lost-2')}`);
  assert.equal(k.read(file, 'Stop').gaps.length, 1);
});

test('a tool call is classified with its input', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${use('a1', 't', { input: { command: 'shadowgraph search x' } })}${result('u1', 't')}`);
  assert.deepEqual(k.read(file, 'Stop', { isSelfTool: (name, input) => input?.command?.startsWith('shadowgraph ') === true }).gaps, []);
});

test('a session end inside an unfinished oversized line declares it incomplete', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'x'.repeat(TRANSCRIPT_LINE_BYTES + 512 * 1024)).slice(0, -10));
  const end = k.read(file, 'SessionEnd');
  assert.equal(k.session().cursor.skipping, true);
  assert.deepEqual(end.gaps.map((gap) => gap.reason), ['transcript_incomplete_at_end']);
});

test('a read starts from the store\'s own bytes', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(say('a1', 'first'));
  const read = k.read(file, 'PreCompact', { admission: { limits: { ...WIDE, maxStoreBytes: 8 * 1024 }, storeBytes: 4 * 1024 } });
  assert.deepEqual([read.ingested, read.refused], [0, 1]);
});

test('no cursor is made for an event with no project', () => {
  const k = kernel();
  assert.equal(k.step(transcript(), { project: null }).changed, false);
  assert.equal(k.session(), undefined);
});

test('the status bounds a reason over its sessions: earliest start, latest end, sessions not gaps', () => {
  const k = kernel();
  k.step(transcript('', 'ref-0'));
  k.step(transcript('', 'ref-1'));
  k.step(transcript('', 'ref-2'));
  k.step(transcript('', 'ref-x'), { sessionId: 'session-2' });
  k.step(transcript('', 'ref-y'), { sessionId: 'session-2' });
  const all = [...k.session().gaps, ...k.session('session-2').gaps];
  const [gap] = k.graph.search('', { project: 'alpha' }).completeness.capture.gaps.filter((entry) => entry.reason === 'transcript_rewritten');
  assert.deepEqual(gap, { reason: 'transcript_rewritten', sessions: 2, from: all.map((entry) => entry.from).sort()[0], to: all.map((entry) => entry.to).sort().at(-1) });
  const limitation = k.graph.search('', { project: 'alpha' }).completeness.limitation.detail;
  assert.match(limitation, /Capture did not read part of a session's transcript \(transcript_rewritten\)/u);
  assert.doesNotMatch(limitation, /refused material/u, 'what was not read is not called refused');
});

test('a line of exactly the limit is read whole, one byte more is not, and the budget stops at exactly its bytes', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const exact = say('a1', 'z'.repeat(TRANSCRIPT_LINE_BYTES - (Buffer.byteLength(say('a1', '')) - 1)));
  assert.equal(Buffer.byteLength(exact) - 1, TRANSCRIPT_LINE_BYTES);
  const over = say('a2', 'z'.repeat(TRANSCRIPT_LINE_BYTES - (Buffer.byteLength(say('a2', '')) - 1) + 1));
  file.append(`${exact}${over}`);
  k.read(file, 'PreCompact'); // the exact line fills this read's budget
  k.read(file, 'PreCompact');
  assert.deepEqual([k.session().cursor.oversized, k.items('Transcript').length], [1, 1]);
  const two = transcript(`${say('b1', 'one')}${say('b2', 'two')}`);
  assert.equal(transcriptLines({ read: two.read, size: two.size(), position: 0, mayContinue: () => true, budget: Buffer.byteLength(say('b1', 'one')) }).length, 1);
});

test('a multi-byte character across a chunk edge is decoded whole, and a BOM after the first line is drift', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  const prefix = say('a1', '').indexOf('""') + 1;
  const text = `${'a'.repeat(256 * 1024 - prefix - 1)}é tail`;
  file.append(say('a1', text));
  k.read(file);
  assert.deepEqual(k.transcribed(), [text]);
  file.append(`${String.fromCharCode(0xfeff)}${say('a2', 'x')}`);
  assert.equal(k.read(file).blocked, 'transcript_unrecognised');
});

test('anchoring over a partial last line longer than a chunk lands after the last newline', () => {
  const k = kernel();
  const history = say('a0', 'history');
  const file = transcript(`${history}${say('a1', 'p'.repeat(300 * 1024)).slice(0, -5)}`);
  k.step(file);
  assert.equal(k.session().cursor.position, Buffer.byteLength(history));
});

test('a content-less Stop after a reconciled one captures its turn in its own read', () => {
  const k = kernel();
  const file = transcript();
  k.step(file);
  file.append(`${ask('u1', 'x')}${say('a1', 'Done.')}`);
  const stop = k.stop('Done.');
  assert.equal(k.read(file, 'Stop', { triggerItemId: stop.id }).reconciled, 1);
  file.append(`${ask('u2', 'y')}${say('a2', 'A second turn whose Stop carried no message.')}`);
  assert.equal(k.read(file, 'Stop').ingested, 1, 'no Stop can claim it, so it is not held');
});

// ---------------------------------------------------------------------------
// Through the hook: a scratch private store, a bound working directory, an active capture record, and a transcript
// file the host would write, all under a scratch directory.
// ---------------------------------------------------------------------------
async function hookSetup(t, { record = {} } = {}) {
  const root = await scratchDirectory(t, 'shadowgraph-capture-transcript-');
  const cwd = join(root, 'work');
  const betaCwd = join(root, 'beta-work');
  const home = join(root, 'home');
  const sgHome = join(root, 'sg-home');
  await mkdir(home);
  await mkdir(sgHome);
  await mkdir(join(root, 'private'));
  await mkdir(join(root, 'transcripts'));
  const file = join(root, 'private', 'memory.json');
  const graph = createShadowGraph();
  for (const [directory, project] of [[cwd, 'alpha'], [betaCwd, 'beta']]) {
    await mkdir(join(directory, '.shadowgraph'), { recursive: true });
    await writeFile(join(directory, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(directory), project, confirmed: true }));
    privilegedBindProject(graph, { type: 'worktree', path: resolve(directory), project, reason: 'synthetic transcript test', surface: 'cli' });
  }
  const store = await createStorage({ type: 'json', file });
  await store.save(privilegedSnapshot(graph));
  const capture = { state: 'active', changedAt: ACTIVATED, evidence: 'synthetic', store: { file, storage: 'json' }, originId: mintOriginId(), coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS }, mcpServerNames: ['shadowgraph'], ...record };
  const activation = join(sgHome, 'activation.json');
  await writeFile(activation, JSON.stringify({ version: 1, capabilities: { capture } }));
  const transcriptPath = join(root, 'transcripts', 'session-1.jsonl');
  const load = async () => (await createStorage({ type: 'json', file })).load();
  const run = (payload, options = {}) => runCapture({ capture, input: JSON.stringify({ session_id: 'session-1', cwd, transcript_path: transcriptPath, ...payload }), deadline: Date.now() + 10_000, record: activation, home, cwd, ...options });
  const append = (text) => appendFile(transcriptPath, text);
  const captured = async () => {
    const stored = await load();
    const text = (item) => stored.captureContent.find((entry) => entry.contentRef === item.contentRef)?.text;
    return stored.records.filter((item) => item.kind === 'capture').map((item) => [item.source.event, text(item)]);
  };
  const sessionOf = async () => (await load()).captureSessions?.find((entry) => entry.sessionId === 'session-1');
  const cursorOf = async () => (await sessionOf())?.cursor;
  return { root, cwd, betaCwd, home, sgHome, file, capture, activation, transcriptPath, run, append, load, captured, sessionOf, cursorOf };
}

test('through the hook: a drifting transcript blocks, and the hook material is still captured', async (t) => {
  const h = await hookSetup(t);
  await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'first', message_id: 'm1' });
  await h.append('not json\n');
  assert.equal(await h.run({ hook_event_name: 'Stop', last_assistant_message: 'Done.' }), 'written');
  assert.equal((await h.cursorOf()).blocked.reason, 'transcript_unrecognised');
  assert.equal(await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'second', message_id: 'm2' }), 'written');
  assert.deepEqual(await h.captured(), [['UserPromptSubmit', 'first'], ['Stop', 'Done.'], ['UserPromptSubmit', 'second']]);
});

test('through the hook: ShadowGraph\'s own call in the transcript is no missing call', async (t) => {
  const h = await hookSetup(t);
  await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' });
  await h.append(`${use('a1', 't1', { name: 'mcp__shadowgraph__search', input: {} })}${result('u1', 't1')}`);
  await h.run({ hook_event_name: 'Stop' });
  assert.deepEqual(((await h.sessionOf()).gaps ?? []).map((gap) => gap.reason), []);
});

test('through the hook: a Stop\'s final message written after its own read is reconciled by the next', async (t) => {
  const h = await hookSetup(t);
  await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' });
  await h.run({ hook_event_name: 'Stop', last_assistant_message: 'Late words.' });
  await h.append(`${ask('u1', 'go')}${say('a1', 'Late words.')}`);
  await h.run({ hook_event_name: 'PreCompact' });
  assert.deepEqual(await h.captured(), [['UserPromptSubmit', 'go'], ['Stop', 'Late words.']]);
});

test('through the hook: the ref resolves the folder, and folds case on Windows', async (t) => {
  const h = await hookSetup(t);
  await h.append(say('a1', 'x'));
  const refOf = async (path) => {
    const file = await openTranscript(path);
    try { return file.ref; } finally { file.close?.(); }
  };
  const plain = await refOf(h.transcriptPath);
  assert.equal(await refOf(`${join(h.root, 'transcripts')}${sep}..${sep}transcripts${sep}session-1.jsonl`), plain, 'a path through .. names the same transcript');
  if (process.platform === 'win32') assert.equal(await refOf(h.transcriptPath.replace('session-1.jsonl', 'SESSION-1.JSONL')), plain, 'case is folded on Windows');
});

test('through the hook: a Stop and the transcript items of its read never take the store past maxStoreBytes', async (t) => {
  const h = await hookSetup(t);
  await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' });
  const { size } = await stat(h.file);
  // Room, by the admission estimate (about 7 KiB an item here), for one more item and not two.
  const capture = { ...h.capture, limits: { ...CAPTURE_LIMITS, maxStoreBytes: size + 7.5 * 1024 } };
  await h.append(`${ask('u1', 'go')}${say('a1', 'Intermediate.')}${say('a2', 'Final.')}`);
  await h.run({ hook_event_name: 'Stop', last_assistant_message: 'Final.' }, { capture });
  assert.ok((await stat(h.file)).size <= capture.limits.maxStoreBytes, 'the store stays within its ceiling');
  assert.deepEqual((await h.captured()).map(([event]) => event), ['UserPromptSubmit', 'Stop'], 'the Stop took the room: the transcript item is refused');
});

test('through the hook: a flush read near the ceiling counts the store\'s own bytes', async (t) => {
  const h = await hookSetup(t);
  await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' });
  const { size } = await stat(h.file);
  const capture = { ...h.capture, limits: { ...CAPTURE_LIMITS, maxStoreBytes: size + 3 * 1024 } };
  await h.append(`${ask('u1', 'go')}${say('a1', 'Too much for the room left.')}`);
  await h.run({ hook_event_name: 'PreCompact' }, { capture });
  assert.deepEqual((await h.captured()).map(([event]) => event), ['UserPromptSubmit']);
});

test('through the hook: the commit cost is taken from the work before the read, so a slow read goes as far as that allows', async (t) => {
  const s = await hookSetup(t);
  await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' });
  await s.append(Array.from({ length: 200 }, (_, index) => `${ask(`u${index}`, 'x')}${say(`a${index}`, `step ${index}`)}`).join(''));
  // Every reading of the clock is 10 ms later. Tied to the clock readings a line costs (review T-8): counting the
  // read in the commit's cost stops it within a few lines.
  let clock = Date.now();
  const deadline = clock + 3_000;
  assert.equal(await s.run({ hook_event_name: 'Stop', last_assistant_message: 'All done.' }, { deadline, now: () => (clock += 10) }), 'written');
  const read = (await s.captured()).filter(([event]) => event === 'Transcript').length;
  assert.ok(read >= 30, `${read} transcript items`);
});

test('a FIFO transcript is never opened', { skip: process.platform === 'win32' && 'no FIFOs on Windows' }, async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-fifo-');
  const fifo = join(root, 'session.jsonl');
  execFileSync('mkfifo', [fifo]);
  const module = JSON.stringify(pathToFileURL(resolve('src/capture-hook.js')).href);
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', `import { openTranscript } from ${module}; console.log(JSON.stringify(await openTranscript(${JSON.stringify(fifo)})));`], { encoding: 'utf8', timeout: 10_000 });
  assert.deepEqual([probe.status, probe.stdout.trim()], [0, 'null'], 'an open would wait for a writer');
});

test('through the hook: ShadowGraph\'s own call from another project still stops the session\'s transcript', async (t) => {
  const h = await hookSetup(t);
  await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'in alpha', message_id: 'm1' });
  const own = { hook_event_name: 'PostToolUse', tool_name: 'mcp__shadowgraph__search', tool_input: {}, tool_response: 'x', tool_use_id: 't1' };
  assert.equal(await h.run(own, { cwd: h.betaCwd }), 'self_event');
  assert.equal((await h.cursorOf()).blocked.reason, 'session_left_project');
  await h.append(say('a1', 'Work done in beta.'));
  await h.run({ hook_event_name: 'Stop' });
  assert.deepEqual(await h.captured(), [['UserPromptSubmit', 'in alpha']], 'beta\'s text is never filed under alpha');
});

test('through the hook: one turn yields the prompt, the tool call, the intermediate text and the final message, each once', async (t) => {
  const h = await hookSetup(t);
  await h.append(`${ask('u0', 'a prompt from before capture')}${say('a0', 'an answer from before capture')}`);
  assert.equal(await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'Fix the build', message_id: 'm1' }), 'written');
  assert.equal((await h.cursorOf()).position, (await stat(h.transcriptPath)).size, 'anchored at the first capture');
  await h.append(`${ask('u1', 'Fix the build')}${use('a1', 't1', { text: 'Reading the log.' })}${result('u2', 't1')}`);
  assert.equal(await h.run({ hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'cat build.log' }, tool_response: { stdout: 'error' }, tool_use_id: 't1' }), 'written');
  await h.append(say('a2', 'Fixed: the path was wrong.'));
  assert.equal(await h.run({ hook_event_name: 'Stop', last_assistant_message: 'Fixed: the path was wrong.' }), 'written');
  assert.deepEqual(await h.captured(), [
    ['UserPromptSubmit', 'Fix the build'],
    ['PostToolUse', 'tool: Bash\ninput.command:\ncat build.log\nresponse.stdout:\nerror'],
    ['Stop', 'Fixed: the path was wrong.'],
    ['Transcript', 'Reading the log.']
  ]);
  const stored = await h.load();
  assert.ok(!JSON.stringify(stored).includes('before capture'), 'nothing from before the first capture');
  assert.ok(!JSON.stringify(stored.captureSessions).includes('transcripts'), 'no transcript path is stored');
  const [item] = stored.records.filter((entry) => entry.source?.event === 'Transcript');
  assert.deepEqual(item.observation, { host: 'claude-code', hostVersion: null, toolName: null, cwd: null, outcome: null }, 'nothing is inferred for a transcript entry');
});

test('through the hook: flush triggers write no item, a content-less Stop captures its turn, and nothing new writes nothing', async (t) => {
  const h = await hookSetup(t);
  assert.equal(await h.run({ hook_event_name: 'SessionEnd', reason: 'other' }), 'transcript', 'the cursor is created on a missing file');
  const empty = JSON.stringify(await h.load());
  assert.equal(await h.run({ hook_event_name: 'PreCompact', compaction_trigger: 'auto' }), 'nothing_new');
  assert.equal(JSON.stringify(await h.load()), empty, 'nothing changed: nothing written');
  await h.append(`${ask('u1', 'Which?')}${say('a1', 'Option B.')}`);
  assert.equal(await h.run({ hook_event_name: 'Stop' }), 'transcript');
  await h.append(say('a2', 'Before compaction.'));
  assert.equal(await h.run({ hook_event_name: 'PreCompact', compaction_trigger: 'manual' }), 'transcript');
  assert.deepEqual(await h.captured(), [['Transcript', 'Option B.'], ['Transcript', 'Before compaction.']]);
});

test('through the hook: re-activating capture re-anchors the cursor, and an event from outside the project stops the transcript', async (t) => {
  const h = await hookSetup(t);
  await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'first', message_id: 'm1' });
  await h.append(say('a1', 'While capture was off.'));
  const again = { ...h.capture, changedAt: '2026-06-01T00:00:00.000Z' };
  assert.equal(await h.run({ hook_event_name: 'Stop' }, { capture: again }), 'transcript');
  assert.deepEqual(await h.captured(), [['UserPromptSubmit', 'first']], 'the off period is not read');
  assert.deepEqual((await h.load()).captureSessions[0].gaps.map((gap) => gap.reason), ['transcript_reanchored']);
  // The session's next event comes from a directory no binding covers: its transcript stops being read.
  const elsewhere = join(h.root, 'elsewhere');
  await mkdir(elsewhere);
  const bash = { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'x' };
  assert.equal(await h.run({ ...bash, tool_use_id: 't9' }, { capture: again, cwd: elsewhere }), 'transcript_stopped');
  await h.append(say('a2', 'Back in alpha.'));
  assert.equal(await h.run({ hook_event_name: 'Stop' }, { capture: again }), 'nothing_new');
  assert.equal((await h.cursorOf()).blocked.reason, 'session_left_project');
  assert.equal(await h.run({ ...bash, tool_use_id: 't10' }, { capture: again, cwd: elsewhere }), 'project_unresolved', 'already stopped: nothing more to write');
});

test('through the hook: a refused item still records the cursor, and a slow read stops in time for the commit', async (t) => {
  const h = await hookSetup(t, { record: { limits: { ...CAPTURE_LIMITS, maxItemBytes: 4 } } });
  assert.equal(await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'too long for the limit', message_id: 'm1' }), 'refused');
  assert.ok(await h.cursorOf(), 'the cursor is created even though the item was refused');
  const s = await hookSetup(t);
  await s.run({ hook_event_name: 'UserPromptSubmit', prompt: 'go', message_id: 'm1' });
  await s.append(Array.from({ length: 200 }, (_, index) => `${ask(`u${index}`, 'x')}${say(`a${index}`, `step ${index}`)}`).join(''));
  // Every reading of the clock is 10 ms later: the read must stop while the commit still fits.
  let clock = Date.now();
  const deadline = clock + 3_000;
  assert.equal(await s.run({ hook_event_name: 'Stop', last_assistant_message: 'All done.' }, { deadline, now: () => (clock += 10) }), 'written');
  const cursor = await s.cursorOf();
  const size = (await stat(s.transcriptPath)).size;
  assert.ok(cursor.position > 0 && cursor.position < size, `a partial read: ${cursor.position} of ${size}`);
  assert.ok((await s.captured()).some(([event, text]) => event === 'Stop' && text === 'All done.'), 'the Stop\'s own item is kept');
});

test('through the hook: only a regular .jsonl file is read, and its ref is the same before and after it exists', async (t) => {
  const h = await hookSetup(t);
  const missing = await openTranscript(h.transcriptPath);
  assert.deepEqual(Object.keys(missing), ['ref', 'missing']);
  await h.append(say('a1', 'x'));
  const present = await openTranscript(h.transcriptPath);
  try {
    assert.equal(present.ref, missing.ref);
    assert.equal(present.read(0, 4).toString(), '{"ty');
  } finally { present.close(); }
  const folder = join(h.root, 'transcripts', 'folder.jsonl');
  await mkdir(folder);
  assert.equal(await openTranscript(folder), null, 'a directory is not read');
  assert.equal(await openTranscript(''), null);
});

test('through the CLI: a SessionEnd reads the transcript silently', async (t) => {
  const h = await hookSetup(t);
  await h.run({ hook_event_name: 'UserPromptSubmit', prompt: 'hello', message_id: 'm1' });
  await h.append(say('a1', 'Said at the end.'));
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SHADOWGRAPH_')));
  const outcome = spawnSync(process.execPath, [resolve('src/cli.js'), 'capture', '--hook'], {
    cwd: h.cwd, input: JSON.stringify({ hook_event_name: 'SessionEnd', session_id: 'session-1', cwd: h.cwd, transcript_path: h.transcriptPath, reason: 'other' }),
    env: { ...base, HOME: h.home, USERPROFILE: h.home, SHADOWGRAPH_HOME: h.sgHome }, encoding: 'utf8', timeout: 30_000
  });
  assert.deepEqual([outcome.status, outcome.stdout, outcome.stderr], [0, '', '']);
  assert.deepEqual((await h.captured()).at(-1), ['Transcript', 'Said at the end.']);
  assert.equal((await h.cursorOf()).ends, 1);
});
