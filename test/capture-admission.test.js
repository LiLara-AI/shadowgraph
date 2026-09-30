// Capture admission and visibility (plan v1.4.4 §22.6.1 M-11, §24.1 M-9, §12.2.2 F-11a; programme plan revision 6
// PR-36b): the four admission limits checked inside the write, capture_limited episodes that record a start and an
// end, a session another project owns refusing its capture, the possible-duplicate marker, the observation an item
// carries, and the capture status every completeness-bearing view and the delivery head declare.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createShadowGraph } from '../src/shadowgraph.js';
import { createJsonFileStore } from '../src/storage.js';
import { runDeliver } from '../src/delivery.js';
import { CAPTURE_LIMITS } from '../src/capture-hook.js';
import { downgradeToSchema5, downgradeToSchema6 } from '../src/schema-conversion.js';
import { privilegedIssueAccess, privilegedRecordCapture, privilegedRecordSelfEvent, privilegedSnapshot, privilegedTransitionCapture } from '../src/internal/snapshot.js';
import { outcomeFromExitStatus } from '../src/internal/outcome.js';
import { validateRestorePayload } from '../src/restore-validation.js';
import { scratchDirectory } from '../tools/scratch-directory.js';

let clock = Date.parse('2026-01-01T00:00:00.000Z');
const now = () => new Date(clock += 1000).toISOString();
const bytes = (value) => JSON.stringify(value);
const WIDE = { maxStoreBytes: 2 ** 40, maxQueueDepth: 2 ** 30, maxItemBytes: 2 ** 40, maxItemsPerSession: 2 ** 30 };
const admission = (limits = {}, storeBytes = 0) => ({ limits: { ...WIDE, ...limits }, storeBytes });
let texts = 0;
const capture = (graph, fields = {}) => privilegedRecordCapture(graph, {
  project: 'alpha', originId: 'origin-a', text: `material ${texts += 1}`, admission: admission(), ...fields,
  source: { event: 'UserPromptSubmit', sessionId: 'session-1', ...(fields.source ?? {}) }
});
const limitEvents = (graph) => privilegedSnapshot(graph).events.filter((entry) => entry.type === 'capture.limited');
const captureItems = (graph) => privilegedSnapshot(graph).records.filter((item) => item.kind === 'capture');
const sessionOf = (graph, sessionId, originId = 'origin-a') => privilegedSnapshot(graph).captureSessions.find((entry) => entry.sessionId === sessionId && entry.originId === originId);
const status = (graph, scope = { project: 'alpha' }) => graph.search('', scope).completeness;
const LEASE = { leaseId: 'lease-1', ownerId: 'worker-1', ownerBootId: 'boot-1', leaseExpiresAt: '2027-01-01T00:00:00.000Z' };
const move = (graph, id, ...states) => {
  for (const to of states) privilegedTransitionCapture(graph, { id, to, ...(to === 'processing' ? { lease: LEASE } : to === 'extracted' ? { producedRecordIds: ['dec_x'] } : to === 'failed' ? { lastError: 'x' } : to === 'blocked' ? { blockedReason: 'x' } : {}) });
};
const extract = (graph, id) => move(graph, id, 'processing', 'extracted');

test('an item over the per-item limit is refused, and nothing at all is written', () => {
  const graph = createShadowGraph({ now });
  capture(graph);
  const before = bytes(privilegedSnapshot(graph));
  const refused = capture(graph, { text: 'x'.repeat(65), admission: admission({ maxItemBytes: 64 }) });
  assert.deepEqual(refused, { refused: { limit: 'maxItemBytes', ceiling: 64 }, changed: false });
  assert.equal(bytes(privilegedSnapshot(graph)), before, 'no item, no episode, no ordinal: a transient refusal');
  assert.equal(capture(graph, { text: 'x'.repeat(64), admission: admission({ maxItemBytes: 64 }) }).occurrenceSeq, 2, 'at the limit is inside it, and the refusal took no ordinal');
  // Bytes, not characters.
  assert.deepEqual(capture(graph, { text: 'é'.repeat(33), admission: admission({ maxItemBytes: 64 }) }).refused, { limit: 'maxItemBytes', ceiling: 64 });
});

test('the per-session limit opens one episode on the session record, never evicts, and other sessions carry on', () => {
  const graph = createShadowGraph({ now });
  const limits = { maxItemsPerSession: 2 };
  const first = capture(graph, { admission: admission(limits) });
  capture(graph, { admission: admission(limits) });
  // The limit is on what the session holds: an item already understood still counts.
  extract(graph, first.id);
  const accepted = bytes(captureItems(graph));
  const refused = capture(graph, { admission: admission(limits) });
  assert.deepEqual(refused, { refused: { limit: 'maxItemsPerSession', ceiling: 2 }, changed: true });
  const opened = sessionOf(graph, 'session-1').limited;
  assert.deepEqual({ ...opened, since: typeof opened.since }, { limit: 'maxItemsPerSession', ceiling: 2, since: 'string', lastPeriod: null, periods: 1 });
  const held = bytes(privilegedSnapshot(graph));
  assert.deepEqual(capture(graph, { admission: admission(limits) }), { refused: { limit: 'maxItemsPerSession', ceiling: 2 }, changed: false }, 'a refusal inside an open episode writes nothing');
  assert.equal(bytes(privilegedSnapshot(graph)), held);
  assert.equal(bytes(captureItems(graph)), accepted, 'accepted items stay byte-equal: nothing is evicted');
  assert.equal(limitEvents(graph).length, 0, 'a session limit is not a store limit');
  // Another session of the same project is not limited, and does not end this session's episode.
  assert.equal(capture(graph, { admission: admission(limits), source: { sessionId: 'session-2' } }).state, 'pending');
  assert.equal(sessionOf(graph, 'session-1').limited.since, opened.since);
  // The session's scope declares a gap, counting its sessions at their limit and naming none; nothing is at a store limit.
  const alpha = status(graph);
  assert.deepEqual([alpha.capture.limited, alpha.capture.gaps], [[], [{ reason: 'maxItemsPerSession', sessions: 1, from: opened.since, to: null }]]);
  assert.match(alpha.limitation.detail, /Capture refused material \(maxItemsPerSession\); what it refused is not here\./u);
  assert.doesNotMatch(bytes(alpha), /session-1/u);
  assert.deepEqual(status(graph, { project: 'beta' }).capture.gaps, [], 'project B sees none of A\'s sessions');
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(privilegedSnapshot(graph)), { now }));
  // A deliberate configuration change that raises the limit lets the session capture again; the item ends its episode.
  const resumed = capture(graph, { admission: admission({ maxItemsPerSession: 5 }) });
  const ended = { limit: 'maxItemsPerSession', ceiling: 2, since: null, lastPeriod: { from: opened.since, to: resumed.createdAt }, periods: 1 };
  assert.deepEqual(sessionOf(graph, 'session-1').limited, ended);
  assert.deepEqual(status(graph).capture.gaps, [{ reason: 'maxItemsPerSession', sessions: 1, from: opened.since, to: resumed.createdAt }], 'the closed period stays declared');
  // A later crossing reopens the episode and keeps the period before it.
  assert.equal(capture(graph, { admission: admission({ maxItemsPerSession: 3 }) }).changed, true);
  const reopened = sessionOf(graph, 'session-1').limited;
  assert.deepEqual([reopened.ceiling, reopened.periods, reopened.lastPeriod], [3, 2, ended.lastPeriod]);
  // A second session at its limit is counted with the first, from the earliest start.
  capture(graph, { admission: admission({ maxItemsPerSession: 1 }), source: { sessionId: 'session-2' } });
  assert.deepEqual(status(graph).capture.gaps, [{ reason: 'maxItemsPerSession', sessions: 2, from: opened.since, to: null }]);
  // A gap alone never makes a view incomplete: what was refused is no candidate any read can find.
  for (const item of captureItems(graph)) if (item.state === 'pending') extract(graph, item.id);
  const understood = status(graph);
  assert.deepEqual([understood.complete, understood.limitation.code], [true, 'capture_gap']);
});

test('the session limit is the one reported when the queue binds too, and the queue holds every item not yet extracted', () => {
  const graph = createShadowGraph({ now });
  capture(graph);
  assert.deepEqual(capture(graph, { admission: admission({ maxItemsPerSession: 1, maxQueueDepth: 1 }) }).refused, { limit: 'maxItemsPerSession', ceiling: 1 }, 'item, then session, then queue, then store');
  const queued = createShadowGraph({ now });
  move(queued, capture(queued, { source: { sessionId: 's-a' } }).id, 'processing', 'failed');
  move(queued, capture(queued, { source: { sessionId: 's-b' } }).id, 'processing', 'failed', 'blocked');
  move(queued, capture(queued, { source: { sessionId: 's-c' } }).id, 'processing');
  assert.deepEqual(capture(queued, { admission: admission({ maxQueueDepth: 3 }), source: { sessionId: 's-d' } }).refused, { limit: 'maxQueueDepth', ceiling: 3 }, 'failed, blocked and processing items are in the queue');
});

test('a session is its origin\'s: another origin\'s session of the same id is neither limited nor compared', () => {
  const graph = createShadowGraph({ now });
  const limits = admission({ maxItemsPerSession: 1 });
  capture(graph, { project: undefined, admission: limits, text: 'the same answer', source: { event: 'Stop', sessionId: 'shared' } });
  const other = capture(graph, { project: undefined, originId: 'origin-b', admission: limits, text: 'the same answer', source: { event: 'Stop', sessionId: 'shared' } });
  assert.equal(other.state, 'pending', 'origin-b\'s session is not at origin-a\'s limit');
  assert.equal(other.possibleDuplicateOf, null, 'never marked against another origin\'s item');
  // An unattributed session's gap is declared to its origin, and to no one else.
  capture(graph, { project: undefined, admission: limits, source: { sessionId: 'shared' } });
  const since = sessionOf(graph, 'shared').limited.since;
  assert.deepEqual(status(graph, { originId: 'origin-a' }).capture.gaps, [{ reason: 'maxItemsPerSession', sessions: 1, from: since, to: null }]);
  assert.deepEqual(status(graph, { originId: 'origin-b' }).capture.gaps, []);
  assert.deepEqual(status(graph).capture.gaps, []);
});

test('a store limit opens one episode in the events carrier, and the next accepted item ends it with its bounds', () => {
  const graph = createShadowGraph({ now });
  const limits = { maxQueueDepth: 2 };
  const one = capture(graph, { admission: admission(limits) });
  capture(graph, { admission: admission(limits), source: { sessionId: 'session-2' } });
  assert.deepEqual(capture(graph, { admission: admission(limits), source: { sessionId: 'session-3' } }), { refused: { limit: 'maxQueueDepth', ceiling: 2 }, changed: true });
  const [opened] = limitEvents(graph);
  assert.deepEqual({ ...opened, id: typeof opened.id, at: typeof opened.at, since: opened.since === opened.at }, { id: 'string', type: 'capture.limited', at: 'string', limit: 'maxQueueDepth', ceiling: 2, since: true, lastPeriod: null, periods: 1 });
  assert.doesNotMatch(bytes(opened), /alpha|session|origin|material/u, 'a store episode names no project, session, origin or content');
  const held = bytes(privilegedSnapshot(graph));
  assert.equal(capture(graph, { admission: admission(limits) }).changed, false, 'one start, not one write per refusal');
  assert.equal(bytes(privilegedSnapshot(graph)), held);
  // Every scope sees a store limit: it is the store's, and names nothing of anyone's.
  for (const scope of [{ project: 'alpha' }, { project: 'beta' }, {}]) assert.deepEqual(status(graph, scope).capture.limited, [{ limit: 'maxQueueDepth', ceiling: 2, since: opened.since }], JSON.stringify(scope));
  assert.equal(status(graph).capture.oldestPendingAt, one.createdAt, 'the oldest item waiting, while the limit binds');
  // A limit binding with nothing waiting in scope is declared, and leaves the view complete.
  const beta = status(graph, { project: 'beta' });
  assert.deepEqual([beta.complete, beta.limitation.code], [true, 'capture_limited']);
  assert.match(beta.limitation.detail, /^Capture is at a limit \(maxQueueDepth\): new material is refused, and nothing accepted is removed\.$/u);
  // The queue is checked against its items now: drained, the limit no longer binds, and its open period is a gap.
  extract(graph, one.id);
  assert.deepEqual([status(graph).capture.limited, status(graph).capture.gaps], [[], [{ reason: 'maxQueueDepth', from: opened.since, to: null }]]);
  // The accepted item ends the episode and keeps the period it covered.
  const resumed = capture(graph, { admission: admission(limits) });
  assert.equal(resumed.state, 'pending');
  const [ended] = limitEvents(graph);
  assert.deepEqual([ended.id, ended.at, ended.since, ended.lastPeriod, ended.periods], [opened.id, resumed.createdAt, null, { from: opened.since, to: resumed.createdAt }, 1]);
  assert.deepEqual([status(graph).capture.limited, status(graph).capture.gaps], [[], [{ reason: 'maxQueueDepth', from: opened.since, to: resumed.createdAt }]]);
  // A later crossing reopens the same entry: the carrier holds one entry per limit, however often it binds.
  assert.equal(capture(graph, { admission: admission(limits) }).changed, true);
  assert.deepEqual([limitEvents(graph).length, limitEvents(graph)[0].periods, limitEvents(graph)[0].lastPeriod], [1, 2, ended.lastPeriod]);
  assert.doesNotThrow(() => validateRestorePayload(structuredClone(privilegedSnapshot(graph)), { now }));
});

test('the store\'s bytes are a store limit, with the item\'s stored size estimated; a purge ends it', () => {
  // The escaped material once, what the item describes (its observation and source) three times -- the item, its
  // journal entry and its retry value each hold it -- and a 6 KiB allowance for the rest.
  const text = 'a"b';
  const { source } = capture(createShadowGraph({ now }), { text });
  const size = Buffer.byteLength(JSON.stringify(text)) + 3 * Buffer.byteLength(JSON.stringify([null, source])) + 6 * 1024;
  const graph = createShadowGraph({ now });
  assert.deepEqual(capture(graph, { text, admission: admission({ maxStoreBytes: 10_000 }, 10_000 - size + 1) }), { refused: { limit: 'maxStoreBytes', ceiling: 10_000 }, changed: true });
  const [opened] = limitEvents(graph);
  assert.deepEqual(status(graph).capture.limited, [{ limit: 'maxStoreBytes', ceiling: 10_000, since: opened.since }], 'known until an item is accepted or a purge runs');
  assert.equal(capture(graph, { text, admission: admission({ maxStoreBytes: 10_000 }, 10_000 - size) }).state, 'pending', 'at the ceiling is inside it');
  assert.equal(limitEvents(graph)[0].since, null);
  // A long observation weighs three times over.
  const observation = { host: 'claude-code', hostVersion: '2.1.270', toolName: 'Bash', cwd: `/${'x'.repeat(2000)}`, outcome: null };
  assert.equal(capture(createShadowGraph({ now }), { text, admission: admission({ maxStoreBytes: 20_000 }, 10_000) }).state, 'pending');
  assert.deepEqual(capture(createShadowGraph({ now }), { text, observation, admission: admission({ maxStoreBytes: 20_000 }, 10_000) }).refused, { limit: 'maxStoreBytes', ceiling: 20_000 });
  const purged = createShadowGraph({ now });
  capture(purged);
  capture(purged, { admission: admission({ maxStoreBytes: 1 }), source: { sessionId: 'session-2' } });
  purged.purgeProject('alpha', { mode: 'hard' });
  const [freed] = limitEvents(purged);
  assert.deepEqual([freed.since, freed.lastPeriod.to], [null, freed.at], 'a purge frees room: the episode ends when it ran');
});

test('admission is every capture\'s, with positive integer limits and the store\'s bytes', () => {
  const graph = createShadowGraph({ now });
  const before = bytes(privilegedSnapshot(graph));
  for (const [label, value] of [
    ['none', undefined],
    ['no limits', { storeBytes: 0 }],
    ['a zero limit', admission({ maxQueueDepth: 0 })],
    ['a fractional limit', admission({ maxItemsPerSession: 1.5 })],
    ['a missing limit', { limits: { ...WIDE, maxItemBytes: undefined }, storeBytes: 0 }],
    ['negative store bytes', admission({}, -1)],
    ['fractional store bytes', admission({}, 1.5)]
  ]) assert.throws(() => capture(graph, { admission: value }), /admission/u, label);
  assert.equal(bytes(privilegedSnapshot(graph)), before);
});

test('an unattributed session takes a later project\'s capture as its owner\'s; a project\'s session refuses another\'s, and says so', () => {
  const graph = createShadowGraph({ now });
  capture(graph, { project: undefined, source: { sessionId: 'loose' } });
  const later = capture(graph, { project: 'alpha', source: { sessionId: 'loose' } });
  assert.deepEqual([later.project, later.attribution, later.occurrenceSeq], [null, 'unattributed', 2], 'a binding made mid-session files nothing under another project');
  capture(graph, { project: 'alpha', source: { sessionId: 'owned' } });
  assert.deepEqual(capture(graph, { project: 'beta', source: { sessionId: 'owned' } }), { refused: { reason: 'session_in_another_project' }, changed: true });
  const held = bytes(privilegedSnapshot(graph));
  assert.deepEqual(capture(graph, { project: 'beta', source: { sessionId: 'owned' } }), { refused: { reason: 'session_in_another_project' }, changed: false }, 'one entry per project, not one per refusal');
  assert.equal(bytes(privilegedSnapshot(graph)), held);
  // The refused project's reads declare the gap; no other scope sees it, and it names no session or owner.
  const [entry] = privilegedSnapshot(graph).events.filter((item) => item.type === 'capture.refused');
  assert.deepEqual(status(graph, { project: 'beta' }).capture.gaps, [{ reason: 'session_in_another_project', from: entry.since, to: null }]);
  assert.doesNotMatch(bytes(entry), /alpha|owned|origin/u);
  assert.deepEqual(status(graph).capture.gaps, []);
  // A capture naming no project -- left out or null -- stays with the session's owner.
  assert.equal(capture(graph, { source: { sessionId: 'owned' }, project: undefined }).project, 'alpha');
  assert.equal(capture(graph, { source: { sessionId: 'owned' }, project: null }).project, 'alpha');
  // A project that is not a name is refused before anything is written, owned session or not.
  const before = bytes(privilegedSnapshot(graph));
  for (const value of ['', '   ', 42, { name: 'beta' }, ['beta'], true]) {
    for (const sessionId of ['owned', 'fresh']) assert.throws(() => capture(graph, { project: value, source: { sessionId } }), /project/u, `${JSON.stringify(value)} ${sessionId}`);
  }
  assert.equal(bytes(privilegedSnapshot(graph)), before);
  // D-6 is decided before admission: another project's capture at a limit is refused as D-6, and opens no episode.
  assert.deepEqual(capture(graph, { project: 'gamma', admission: admission({ maxQueueDepth: 1 }), source: { sessionId: 'owned' } }), { refused: { reason: 'session_in_another_project' }, changed: true });
  assert.equal(limitEvents(graph).length, 0);
  // A purge of the refused project takes its entry along -- `default` too, a project like any other.
  capture(graph, { project: 'default', source: { sessionId: 'owned' } });
  graph.purgeProject('beta', { mode: 'hard' });
  graph.purgeProject('gamma', { mode: 'logical' });
  assert.deepEqual(privilegedSnapshot(graph).events.filter((item) => item.type === 'capture.refused').map((item) => item.project), ['default']);
  graph.purgeProject('default', { mode: 'logical' });
  assert.equal(privilegedSnapshot(graph).events.some((item) => item.type === 'capture.refused'), false);
  assert.deepEqual(status(graph, { project: 'default' }).capture.gaps, []);
});

test('capture\'s events-carrier entries are never an event a read shows, a copy carries, or an import takes malformed', () => {
  const graph = createShadowGraph({ now });
  capture(graph);
  capture(graph, { admission: admission({ maxQueueDepth: 1 }), source: { sessionId: 'session-2' } });
  capture(graph, { project: 'beta' });
  const snapshot = privilegedSnapshot(graph);
  const carried = snapshot.events.filter((entry) => entry.type.startsWith('capture.'));
  assert.deepEqual(carried.map((entry) => entry.type).sort(), ['capture.limited', 'capture.refused']);
  for (const scope of [{ project: 'alpha' }, { project: 'beta' }, {}]) assert.equal(graph.exportData(scope).events.some((entry) => entry.type.startsWith('capture.')), false, JSON.stringify(scope));
  // A schema-6 copy leaves them out with the capture they belong to, and says so.
  const { payload, report } = downgradeToSchema6(snapshot, { now });
  assert.equal(payload.events.some((entry) => entry.type.startsWith('capture.')), false);
  assert.deepEqual(report.excluded.filter((entry) => entry.collection === 'events').map((entry) => entry.id).sort(), carried.map((entry) => entry.id).sort());
  // So does a schema-5 copy, should a schema-6 store ever hold them.
  const five = downgradeToSchema5({ ...payload, events: [...payload.events, ...structuredClone(carried)] }, { now });
  assert.equal(five.payload.events.some((entry) => entry.type.startsWith('capture.')), false);
  assert.deepEqual(five.report.excluded.filter((entry) => entry.collection === 'events').map((entry) => entry.id).sort(), carried.map((entry) => entry.id).sort());
  // A malformed entry or session limit is refused at import.
  for (const [label, edit, pattern] of [
    ['an item limit in the carrier', (copy) => { copy.events.find((entry) => entry.type === 'capture.limited').limit = 'maxItemBytes'; }, /capture limit entry/u],
    ['a zero ceiling', (copy) => { copy.events.find((entry) => entry.type === 'capture.limited').ceiling = 0; }, /capture limit entry/u],
    ['no count', (copy) => { delete copy.events.find((entry) => entry.type === 'capture.limited').periods; }, /capture limit entry/u],
    ['a last period with no end', (copy) => { copy.events.find((entry) => entry.type === 'capture.limited').lastPeriod = { from: '2026-01-01T00:00:00.000Z' }; }, /capture limit entry/u],
    ['a refusal with no project', (copy) => { delete copy.events.find((entry) => entry.type === 'capture.refused').project; }, /capture refusal entry/u],
    ['a refusal for another reason', (copy) => { copy.events.find((entry) => entry.type === 'capture.refused').reason = 'maxQueueDepth'; }, /capture refusal entry/u],
    ['a refusal with no start', (copy) => { delete copy.events.find((entry) => entry.type === 'capture.refused').since; }, /capture refusal entry/u],
    ['a session limit naming a store limit', (copy) => { copy.captureSessions[0].limited = { limit: 'maxQueueDepth', ceiling: 1, since: null, lastPeriod: null, periods: 1 }; }, /session limit/u]
  ]) {
    const copy = structuredClone(snapshot);
    edit(copy);
    assert.throws(() => createShadowGraph({ now }).importData(copy), pattern, label);
  }
});

test('a store holding two entries for one limit (a merge) declares the earliest start still open and the latest closed period', () => {
  const graph = createShadowGraph({ now });
  capture(graph);
  const at = (second) => `2026-02-01T00:00:${String(second).padStart(2, '0')}.000Z`;
  const entry = (id, since, lastPeriod) => ({ id, type: 'capture.limited', at: since, limit: 'maxStoreBytes', ceiling: 100, since, lastPeriod, periods: 1 });
  const payload = privilegedSnapshot(graph);
  payload.events.push(entry('capture_limit_a', at(20), { from: at(1), to: at(5) }), entry('capture_limit_b', at(10), { from: at(6), to: at(9) }));
  const merged = createShadowGraph({ now });
  merged.importData(payload);
  assert.deepEqual([status(merged).capture.limited, status(merged).capture.gaps], [[{ limit: 'maxStoreBytes', ceiling: 100, since: at(10) }], [{ reason: 'maxStoreBytes', from: at(6), to: at(9) }]]);
});

test('an item identified only by its ordinal that repeats the session\'s previous material of the same event is marked', () => {
  const graph = createShadowGraph({ now });
  const stop = (text, sessionId = 'session-1') => capture(graph, { text, source: { event: 'Stop', sessionId, role: 'assistant' } });
  const first = stop('The final answer.');
  const again = stop('The final answer.');
  assert.deepEqual([first.possibleDuplicateOf, again.possibleDuplicateOf, again.occurrenceSeq], [null, first.id, 2], 'both recorded, the second marked (F-11a)');
  assert.equal(stop('Another answer.').possibleDuplicateOf, null);
  assert.equal(stop('The final answer.').possibleDuplicateOf, null, 'only the previous item of that event is compared');
  assert.equal(stop('The final answer.', 'session-2').possibleDuplicateOf, null, 'never across sessions');
  assert.equal(capture(graph, { text: 'The final answer.', source: { sessionId: 'session-2' } }).possibleDuplicateOf, null, 'never across events');
  // A host identifier decides identity: a re-delivery is the same item, and distinct identifiers are never marked.
  const prompt = (hostEventId) => capture(graph, { text: 'same words', source: { hostEventId } });
  const a = prompt('msg-1');
  assert.deepEqual(prompt('msg-1'), a);
  assert.equal(prompt('msg-2').possibleDuplicateOf, null);
  // A prompt with no host identifier is identified by its ordinal, and marked like any other.
  const bare = capture(graph, { text: 'same words', source: { sessionId: 'session-3' } });
  assert.equal(capture(graph, { text: 'same words', source: { sessionId: 'session-3' } }).possibleDuplicateOf, bare.id);
  // Two flushes that carry no material in a row repeat each other.
  const flush = () => capture(graph, { text: undefined, source: { event: 'PreCompact' } });
  const flushed = flush();
  assert.equal(flush().possibleDuplicateOf, flushed.id);
});

test('an item carries what was observed of its event, never inferred; a malformed observation is refused and never imported', () => {
  const graph = createShadowGraph({ now });
  const observation = (fields = {}) => ({ host: 'claude-code', hostVersion: '2.1.270', toolName: 'Bash', cwd: '/work/app', outcome: outcomeFromExitStatus(0, 'host_exit_status'), ...fields });
  const observed = capture(graph, { observation: observation(), source: { event: 'PostToolUse', toolCallId: 'toolu_1' } });
  assert.deepEqual(observed.observation, observation());
  assert.deepEqual(capture(graph, { observation: observation({ outcome: outcomeFromExitStatus(1, 'host_exit_status') }), source: { event: 'PostToolUse', toolCallId: 'toolu_2' } }).observation.outcome, { resultClass: 'failed', outcomeEvidence: { state: 'observed', source: 'host_exit_status', exitStatus: 1 } });
  assert.deepEqual(capture(graph, { observation: observation({ outcome: outcomeFromExitStatus(undefined, 'host_exit_status') }), source: { event: 'PostToolUse', toolCallId: 'toolu_3' } }).observation.outcome, { outcomeEvidence: { state: 'absent', source: 'host_exit_status' } });
  assert.equal(capture(graph, { observation: observation({ toolName: null, outcome: null }) }).observation.toolName, null, 'absent is recorded as absent');
  assert.equal(capture(graph, { observation: { ...observation(), hostSession: 'later' } }).observation.hostSession, 'later', 'a field a later build adds is carried');
  const scoped = { event: 'PostToolUse', toolCallId: 'toolu_5', toolName: 'Bash' };
  assert.deepEqual(capture(graph, { observation: observation({ outcome: outcomeFromExitStatus(0, scoped) }), source: { event: 'PostToolUse', toolCallId: 'toolu_5' } }).observation.outcome.outcomeEvidence.source, scoped, 'an outcome scoped to the command it came from (D-13)');
  assert.equal(Object.hasOwn(capture(graph), 'observation'), false, 'an item without an observation is read as it always was');
  // The stored observation is a copy of the one given.
  const given = observation();
  const copied = capture(graph, { observation: given, source: { event: 'PostToolUse', toolCallId: 'toolu_4' } });
  given.cwd = '/elsewhere';
  assert.equal(captureItems(graph).find((item) => item.id === copied.id).observation.cwd, '/work/app');
  const before = bytes(privilegedSnapshot(graph));
  for (const [label, value] of [
    ['a missing field', (({ cwd, ...rest }) => rest)(observation())],
    ['an empty host', observation({ host: '' })],
    ['an empty hostVersion', observation({ hostVersion: '' })],
    ['a numeric cwd', observation({ cwd: 42 })],
    ['an observed outcome with no exit status', observation({ outcome: { resultClass: 'succeeded', outcomeEvidence: { state: 'observed', source: 'host_exit_status' } } })],
    ['a fractional exit status', observation({ outcome: { resultClass: 'failed', outcomeEvidence: { state: 'observed', source: 'host_exit_status', exitStatus: 1.5 } } })],
    ['an observed outcome whose class contradicts its status', observation({ outcome: { resultClass: 'succeeded', outcomeEvidence: { state: 'observed', source: 'host_exit_status', exitStatus: 1 } } })],
    ['an absent outcome with a class', observation({ outcome: { resultClass: 'failed', outcomeEvidence: { state: 'absent', source: 'host_exit_status' } } })],
    ['an unknown evidence state', observation({ outcome: { outcomeEvidence: { state: 'not_applicable', source: 'host_exit_status' } } })],
    ['an outcome with no source', observation({ outcome: { outcomeEvidence: { state: 'absent' } } })],
    ['an outcome whose source names nothing', observation({ outcome: { outcomeEvidence: { state: 'absent', source: {} } } })],
    ['an outcome whose source names no tool', observation({ outcome: { outcomeEvidence: { state: 'absent', source: { event: 'PostToolUse', toolCallId: 'toolu_6' } } } })]
  ]) assert.throws(() => capture(graph, { observation: value }), /observation|outcome/u, label);
  assert.throws(() => capture(graph, { observation: (({ outcome, ...rest }) => rest)(observation()) }), /observation names host, hostVersion, toolName, cwd, outcome/u, 'every field is named, even when absent');
  // Checked before admission: a malformed observation is never reported as a limit.
  assert.throws(() => capture(graph, { observation: observation({ host: '' }), admission: admission({ maxQueueDepth: 1 }) }), /observation/u);
  assert.equal(bytes(privilegedSnapshot(graph)), before);
  const payload = structuredClone(privilegedSnapshot(graph));
  payload.records.find((item) => item.id === observed.id).observation.toolName = '';
  assert.throws(() => createShadowGraph({ now }).importData(payload), /observation\.toolName/u);
  assert.throws(() => validateRestorePayload(payload, { now }), /observation\.toolName/u);
});

test('every completeness-bearing view declares the scope\'s capture status, and a store without capture declares nothing', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  const plain = status(graph);
  assert.equal(Object.hasOwn(plain, 'capture'), false);
  assert.equal(plain.complete, true);
  assert.deepEqual(graph.context({ project: 'alpha', query: 'cache' }).relevant.processing, { pending: 0, failed: 0, blocked: 0, oldestPendingAt: null, extractionAvailable: false }, 'the relevance head as it always was');
  // Counters alone are capture state, and leave nothing to understand.
  privilegedRecordSelfEvent(graph, { project: 'alpha', originId: 'origin-a', signal: 'S-1', source: { event: 'PostToolUse', sessionId: 'session-9' } });
  const idle = status(graph);
  assert.deepEqual([idle.complete, idle.capture], [true, { pending: 0, processing: 0, failed: 0, blocked: 0, oldestPendingAt: null, extractionAvailable: false, limited: [], gaps: [] }]);
  const a = capture(graph, { project: 'alpha' });
  capture(graph, { project: 'alpha', source: { sessionId: 'session-2' } });
  capture(graph, { project: 'beta', source: { sessionId: 'session-3' } });
  capture(graph, { project: undefined, originId: 'origin-b', source: { sessionId: 'session-4' } });
  const alpha = { pending: 2, processing: 0, failed: 0, blocked: 0, oldestPendingAt: a.createdAt, extractionAvailable: false, limited: [], gaps: [] };
  for (const [label, completeness] of [
    ['search', graph.search('', { project: 'alpha' }).completeness],
    ['recall', graph.recall('cache', { project: 'alpha' }).completeness],
    ['context', graph.context({ project: 'alpha' }).completeness],
    ['relevance head', graph.context({ project: 'alpha', query: 'cache' }).relevant],
    ['export', graph.exportData({ project: 'alpha' }).completeness],
    ['stats', graph.stats({ project: 'alpha' }).completeness]
  ]) {
    assert.deepEqual(completeness.capture, alpha, label);
    assert.equal(completeness.complete, false, label);
    assert.match(completeness.limitation.detail, /2 captured items are not yet understood in this scope/u, label);
  }
  assert.deepEqual(graph.context({ project: 'alpha', query: 'cache' }).relevant.processing, alpha, 'the relevance head\'s processing is the same status');
  assert.equal(status(graph).limitation.code, 'capture_pending', 'the only reason is capture');
  assert.deepEqual(status(graph, { project: 'beta' }).capture, { ...alpha, pending: 1, oldestPendingAt: status(graph, { project: 'beta' }).capture.oldestPendingAt }, 'project B sees its own count, none of A\'s');
  assert.equal(status(graph, { originId: 'origin-b' }).capture.pending, 1, 'an origin sees its own unattributed captures');
  assert.equal(status(graph, {}).capture.pending, 0, 'no project and no origin sees none');
  // Every state not yet extracted is backlog, counted by state; the oldest waiting is the oldest still pending.
  move(graph, a.id, 'processing', 'failed');
  const failed = status(graph).capture;
  assert.deepEqual([failed.pending, failed.failed, failed.oldestPendingAt], [1, 1, captureItems(graph).find((item) => item.project === 'alpha' && item.state === 'pending').createdAt]);
  assert.equal(status(graph).complete, false);
  move(graph, a.id, 'blocked');
  assert.match(status(graph).limitation.detail, /2 captured items are not yet understood/u);
  for (const item of captureItems(graph)) if (item.project === 'alpha' && item.state === 'pending') extract(graph, item.id);
  assert.deepEqual([status(graph).capture.blocked, status(graph).complete], [1, false]);
});

test('an item of a later schema is carried and never counted', () => {
  const graph = createShadowGraph({ now });
  const later = capture(graph);
  capture(graph, { source: { sessionId: 'session-2' } });
  const loaded = createShadowGraph({ now });
  loaded.importData({ schemaVersion: 7, records: captureItems(graph).map((item) => (item.id === later.id ? { ...item, schemaVersion: 8 } : item)) });
  assert.equal(status(loaded).capture.pending, 1);
});

test('capture state never masks another reason a view is incomplete, and a grant never widens the count', () => {
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'gamma', title: 'One', chosen: 'a' });
  graph.addDecision({ project: 'gamma', title: 'Two', chosen: 'b' });
  graph.addDecision({ project: 'beta', title: 'Three', chosen: 'c' });
  extract(graph, capture(graph, { project: 'gamma' }).id);
  const whole = status(graph, { project: 'gamma' });
  assert.deepEqual([whole.capture.pending, whole.complete, Object.hasOwn(whole, 'limitation')], [0, true, false], 'nothing waiting and nothing refused: complete, and nothing to say');
  const paged = status(graph, { project: 'gamma', limit: 1 });
  assert.deepEqual([paged.capture.pending, paged.complete], [0, false], 'a page with more to come is still incomplete');
  const refused = status(graph, { project: 'gamma', accessId: 'access_unknown' });
  assert.equal(refused.complete, false, 'a refused grant is still a limitation');
  capture(graph, { project: 'beta', source: { sessionId: 'session-beta' } });
  const grant = privilegedIssueAccess(graph, { scope: { projects: ['beta'] }, surfaces: ['cli'], expiresAt: '2026-12-31T00:00:00.000Z', reason: 'synthetic review test' }).entry;
  const widened = status(graph, { project: 'gamma', accessId: grant.accessId });
  assert.equal(widened.capture.pending, 0, 'beta\'s pending capture is not gamma\'s, grant or not');
});

test('the delivery head says capture is on only for the store it delivers, on the hook path, in brief', async (t) => {
  const home = await scratchDirectory(t, 'shadowgraph-capture-delivery-');
  const file = resolve(home, 'memory.json');
  const record = join(home, 'sg-home', 'activation.json');
  await mkdir(join(home, 'sg-home'));
  const env = { SHADOWGRAPH_HOME: join(home, 'sg-home') };
  const deliver = async (args = ['--hook']) => {
    let text = '';
    await runDeliver({ args, readInput: () => JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's-1' }), file, env, write: (line) => { text += line; } });
    return text === '' ? null : JSON.parse(text).hookSpecificOutput.additionalContext.split('\n').find((line) => line.startsWith('processing: '));
  };
  const processing = async (args) => JSON.parse((await deliver(args)).slice('processing: '.length));
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  const stored = createJsonFileStore(file);
  await stored.save(privilegedSnapshot(graph));
  const delivery = { state: 'active', store: { file, storage: 'json' } };
  const active = { state: 'active', store: { file, storage: 'json' }, originId: 'origin-a', coverage: { projects: 'all', exclude: [] }, limits: { ...CAPTURE_LIMITS } };
  const activate = (capabilities) => writeFile(record, JSON.stringify({ version: 1, capabilities }));
  await activate({ delivery });
  assert.equal(await deliver(), 'processing: {"capture":"not_active","extraction":"not_active"}', 'as it always was');
  await activate({ delivery, capture: active });
  assert.equal(await deliver(), 'processing: {"capture":"active","extraction":"not_active"}', 'on, though nothing is captured yet');
  assert.equal(await deliver([]), 'processing: {"capture":"not_active","extraction":"not_active"}', 'off the hook path, the per-user record is never read');
  await activate({ delivery, capture: { ...active, store: { file: resolve(home, 'other.json'), storage: 'json' } } });
  assert.equal((await processing()).capture, 'not_active', 'capture writing another store is not on for this one');
  await activate({ delivery, capture: active });
  capture(graph, { project: undefined, originId: 'origin-a', text: 'a'.repeat(4096), source: { sessionId: 's-1' } });
  capture(graph, { admission: admission({ maxStoreBytes: 1 }), source: { sessionId: 's-2' } });
  capture(graph, { source: { sessionId: 's-3' } });
  capture(graph, { admission: admission({ maxQueueDepth: 2 }), source: { sessionId: 's-4' } });
  await stored.save({ ...privilegedSnapshot(graph), revision: (await stored.load()).revision });
  const line = await processing();
  assert.deepEqual(Object.keys(line), ['capture', 'extraction', 'pending', 'processing', 'failed', 'blocked', 'oldestPendingAt', 'extractionAvailable', 'limited', 'gaps']);
  assert.deepEqual([line.capture, line.pending, line.limited, line.gaps], ['active', 0, ['maxQueueDepth'], ['maxStoreBytes']], 'the unresolved session scope sees no one\'s pending items; the store\'s limits and gaps are named');
  assert.doesNotMatch(await deliver(), /s-\d|origin-a|aaaa/u, 'counts and names of limits: no session, origin or material');
  await activate({ delivery, capture: { ...active, state: 'deactivated' } });
  assert.equal((await processing()).capture, 'not_active', 'off, while the store still holds capture state');
  // A store delivery cannot read, or cannot load, still says capture is on.
  await activate({ delivery, capture: active });
  const malformed = privilegedSnapshot(graph);
  malformed.events.find((entry) => entry.type === 'capture.limited').limit = 'maxItemBytes';
  await writeFile(file, JSON.stringify(malformed));
  assert.equal(await deliver(), 'processing: {"capture":"active","extraction":"not_active"}');
  await writeFile(file, '{not json');
  assert.equal(await deliver(), 'processing: {"capture":"active","extraction":"not_active"}');
});

test('the delivery processing line carries a bound project\'s pending count, and its head is not complete', async (t) => {
  const root = await scratchDirectory(t, 'shadowgraph-capture-bound-');
  const cwd = join(root, 'work');
  await mkdir(join(cwd, '.shadowgraph'), { recursive: true });
  await writeFile(join(cwd, '.shadowgraph', 'project-binding.json'), JSON.stringify({ version: 1, type: 'worktree', path: resolve(cwd), project: 'alpha', confirmed: true }));
  const file = join(root, 'store.json');
  const graph = createShadowGraph({ now });
  graph.addDecision({ project: 'alpha', title: 'Cache', chosen: 'redis' });
  capture(graph);
  capture(graph, { source: { sessionId: 'session-2' } });
  await writeFile(file, JSON.stringify(privilegedSnapshot(graph)));
  const home = join(root, 'home');
  await mkdir(home);
  const base = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('SHADOWGRAPH_')));
  const child = spawn(process.execPath, [resolve('src/cli.js'), 'deliver'], { cwd, env: { ...base, HOME: home, USERPROFILE: home, SHADOWGRAPH_HOME: home, SHADOWGRAPH_FILE: file } });
  let stdout = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stdin.end(JSON.stringify({ session_id: 's-1', hook_event_name: 'SessionStart' }));
  await new Promise((done) => child.on('close', done));
  const lines = JSON.parse(stdout).hookSpecificOutput.additionalContext.split('\n');
  const line = JSON.parse(lines.find((entry) => entry.startsWith('processing: ')).slice('processing: '.length));
  assert.deepEqual([line.capture, line.pending, line.processing], ['not_active', 2, 0]);
  const head = JSON.parse(lines.find((entry) => entry.startsWith('head: ')).slice('head: '.length));
  assert.equal(head.complete, false, 'captured material not yet understood: the head is not complete');
});
