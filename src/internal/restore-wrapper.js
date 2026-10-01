// The DP-1 restore wrapper (PR-37c; plan rev6 §3.8; OD-DP1 = Option A): what
// makes a restore honour the deletion records that reach it, around the two
// R16 restore primitives, which stay byte for byte as they are (design §13.1).
// It is composed at the JSON entry, restoreFile, and at the `./storage` SQLite
// entry (§3.3), under the restore lock and then the store fence (§3.2):
//
//   step 0      a restore record an earlier restore left is resolved (§8.4);
//   pre-step    in the validate hook's first call, inside the fence the
//               primitive installs under and before any write: the knowledge
//               that reaches B is merged, D's own purge markers lifted, the
//               post-step dry-run, and a content-free record written (§4);
//   activation  the caller gets the post-step's payload, never raw B (§7);
//   post-step   the ledger, then the payload, then the record cleared (§6.6).
//
// A primitive error is settled before the restore lock is released (§12.1); a
// post-step that fails after the primitive committed leaves its record for the
// next write to complete (§12.3). Loads, delivery and hooks never resolve a
// record (§8.5); restores, backups, saves and the quarantine verbs do.
//
// INTERNAL: package.json "exports" does not map this file.
import { lstat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { createShadowGraph } from '../shadowgraph.js';
import { HARD_GAP_EVIDENCE_TYPES } from '../journal.js';
import { isValidIsoInstant } from '../fact-validity.js';
import { currentRevision, nextRevisionAfter, restoreLock } from '../revision-store.js';
import { requiresLegacyPurgeMigration, validateRestorePayload } from '../restore-validation.js';
import { privilegedReapplyDeletion } from './snapshot.js';
import {
  CONTROL_LEDGER_MALFORMED, CONTROL_LEDGER_NEWER_VERSION, DELETION_PENDING_UNSUPPORTED, PURGE_AWARE_RESTORE_UNSUPPORTED, attachLedgerView, canonical, canonicalPath, classifyRestore, deletionError,
  journalHead, ledgerSnapshot, linkCount, markerMatches, mergeAppliesTo, mergedTombstones, pendingUnsupported, readLedger,
  readRegistry, restoreBinding, restoreLedgerBytes, restoreRecordValid, restoreUnresolvable, unlinkLedgerIfRecordOnly, writeLedger
} from './deletion-knowledge.js';

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const named = (value) => typeof value === 'string' && value.length > 0;
const entitiesOf = (payload) => [...(payload?.records ?? []), ...(payload?.facts ?? [])].filter(isObject);
const journalOf = (payload) => (Array.isArray(payload?.journal) ? payload.journal.filter(isObject) : []);
const markersOf = (payload) => journalOf(payload).filter((entry) => entry.type === 'project.purged');
const holdsCursor = (payload) => Array.isArray(payload?.captureSessions) && payload.captureSessions.some((session) => isObject(session?.cursor));
const firstPerToken = (entries) => {
  const seen = new Set();
  return entries.filter((entry) => !seen.has(entry.token) && seen.add(entry.token));
};
// The primitives' own same-path rule (backup.js, sqlite-storage.js): resolved,
// and without case on win32.
const normalized = (path) => (process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path));
const folded = (name) => (process.platform === 'win32' ? name.toLowerCase() : name);
// The inputs of a restore that merges nothing: no candidate is live, none
// overlaps and nothing descends (review finding 2).
const NO_INPUTS = Object.freeze({ live: [], descent: false, descentMode: null, overlap: [], postdated: [] });
const NO_EFFECT = Object.freeze({ payload: null, counts: Object.freeze({ removed: 0, quarantined: 0, skeletons: 0, spliced: 0 }), minted: Object.freeze([]), quarantine: Object.freeze([]) });

// Every refusal by a restore entry carries one code, before any write, and
// names no path, project or token (§5.1, F16).
function refusal(message, cause) {
  const error = deletionError(PURGE_AWARE_RESTORE_UNSUPPORTED, `Refusing to restore: ${message}`);
  if (cause) error.cause = cause;
  return error;
}
const UNREADABLE_DESTINATION = 'the destination cannot be read, so deletion records it may hold cannot be ruled out; restore into a fresh path instead';
const UNREADABLE_KNOWLEDGE = 'the deletion records that reach it cannot be read, or were written by a newer ShadowGraph build; a later ShadowGraph build is needed';
const PENDING_DELETION = 'the store has a deletion this build cannot complete';

// A destination named through an alias of its file's own name -- a symbolic
// link to the file, or its 8.3 name on win32 -- refuses where deletion records
// reach the restore, before its first write (review finding 1, re-review N-1;
// design §3.1): both primitives rename over the name they are given, which
// replaces the link with a file of its own or leaves the file under its 8.3
// name, either way away from the ledger beside the store's final name, so the
// post-step would find no record. Where none reach it the restore is the
// primitive alone, as T-10 requires. A folder alias keeps the file's own name,
// and a hard link refuses in the pre-step (V-24).
export async function refuseAliasDestination(destination) {
  const given = resolve(String(destination));
  const link = await lstat(given).then((info) => info.isSymbolicLink(), () => false);
  if (link || folded(basename(await canonicalPath(given))) !== folded(basename(given))) {
    throw refusal('the destination is named through another name of the store file -- a symbolic link to it, or its 8.3 name -- which the restore would replace; restore through the name the store file has itself');
  }
}

// ---------------------------------------------------------------------------
// What reaches a restore of B into D (§4.2-§4.5).
// ---------------------------------------------------------------------------

// What D's journal shows of the window before a lifted marker (§4.5): unknown
// when the marker is hard, when the journal is not intact from its epoch up to
// it, or when a baseline comes before it; otherwise `some` when D's or B's
// journal holds an attribution into the project, a skeleton's included, and
// `none` when neither does. A marker naming no project is unknown: no window
// of its can be read.
function moveInOf(marker, mode, project, d, b) {
  const journal = journalOf(d);
  const epoch = d?.journalEpoch;
  if (mode !== 'logical' || !named(project) || !Number.isSafeInteger(marker.seq) || !Number.isSafeInteger(epoch)) return 'unknown';
  const sequences = new Set(journal.map((entry) => entry.seq).filter(Number.isSafeInteger));
  for (let seq = epoch; seq <= marker.seq; seq += 1) if (!sequences.has(seq)) return 'unknown';
  if (journal.some((entry) => entry.type === 'projection.baseline' && entry.seq < marker.seq)) return 'unknown';
  return [...journal, ...journalOf(b)].some((entry) => entry.type === 'entity.attributed' && entry.project === project) ? 'some' : 'none';
}

// D's purge marker as a tombstone (§1.1): its project, a skeleton marker as
// logical and any other mode but logical as hard, its instant or, when that
// is not one, the restore's (V-11), its seq, no tokens, and its move-in
// evidence, which only D's journal has and the primitive replaces.
function liftMarker(marker, d, b, instant) {
  const project = marker.payload?.project ?? marker.project;
  const mode = marker.payload === null || marker.payload?.mode === 'logical' ? 'logical' : 'hard';
  return {
    kind: 'project', ...(named(project) ? { purgedProject: project } : {}), mode,
    at: isValidIsoInstant(marker.at) ? marker.at : instant, seq: marker.seq, tokens: null, moveIn: moveInOf(marker, mode, project, d, b)
  };
}

// The knowledge a restore merges (§4.3): M, the tombstones of D's ledger, B's
// sidecar, the registry entries that apply to B with their lineage removed,
// which backups never carry (rev6:359-361), and D's own purge markers no
// tombstone records (§4.4), each once and in that order; Q, the quarantine of
// D's ledger and B's sidecar, each token once; the downgrade's flag; and the
// positions in M of the tombstones whose purge B's own journal records (§4.3,
// V-19), decided by marker for local ones and by `lineage.markerEntryId` for
// the registry's, before the lineage goes. `own` and `ownQuarantine` count
// what D's ledger already holds, which `add` leaves out.
function mergeKnowledge({ d, b, mine, carried, registry, instant }) {
  const own = mine?.tombstones ?? [];
  const sidecar = carried?.tombstones ?? [];
  const applicable = (registry?.tombstones ?? []).filter((tombstone) => mergeAppliesTo(tombstone, b));
  const withoutLineage = (tombstone) => Object.fromEntries(Object.entries(tombstone).filter(([name]) => name !== 'lineage'));
  const stripped = applicable.map(withoutLineage);
  const known = [...own, ...sidecar, ...stripped];
  const lifted = (d === null ? [] : markersOf(d))
    .filter((marker) => !known.some((tombstone) => markerMatches(tombstone, marker)))
    .map((marker) => liftMarker(marker, d, b, instant));
  const tombstones = mergedTombstones(own, sidecar, stripped, lifted);
  const local = new Set([...own, ...sidecar, ...lifted].map(canonical));
  const anchors = new Map();
  for (const tombstone of applicable) {
    const key = canonical(withoutLineage(tombstone));
    anchors.set(key, [...(anchors.get(key) ?? []), tombstone.lineage?.markerEntryId]);
  }
  const bMarkers = markersOf(b);
  const bIds = new Set(journalOf(b).map((entry) => entry.id));
  const postdated = tombstones.flatMap((tombstone, index) => {
    const key = canonical(tombstone);
    const byMarker = local.has(key) && bMarkers.some((marker) => markerMatches(tombstone, marker));
    const byAnchor = (anchors.get(key) ?? []).some((anchor) => named(anchor) && bIds.has(anchor));
    return byMarker || byAnchor ? [index] : [];
  });
  return {
    tombstones, quarantine: firstPerToken([...(mine?.quarantine ?? []), ...(carried?.quarantine ?? [])]),
    tokensStripped: mine?.tokensStripped ?? carried?.tokensStripped, postdated,
    own: mergedTombstones(own).length, ownQuarantine: firstPerToken(mine?.quarantine ?? []).length
  };
}

// Id-proven descent (R4 L0 VS1): B's journal is whole and numbered, ends at
// its declared head, D holds that head under the same id, and every B entry
// whose seq D holds has the same id there; overlap unproves it. A gap is never
// a match, and neither is a type or an instant.
function provenDescent(b, d, overlap) {
  if (d === null || overlap.length || !Array.isArray(b?.journal) || !b.journal.length || !b.journal.every((entry) => Number.isSafeInteger(entry?.seq))) return false;
  const head = b.journal.reduce((most, entry) => Math.max(most, entry.seq), Number.NEGATIVE_INFINITY);
  if (head !== b.journalSeq) return false;
  const held = new Map(journalOf(d).filter((entry) => Number.isSafeInteger(entry.seq)).map((entry) => [entry.seq, entry.id]));
  if (held.get(head) !== b.journal.find((entry) => entry.seq === head).id) return false;
  return b.journal.every((entry) => !held.has(entry.seq) || held.get(entry.seq) === entry.id);
}

// The strongest mode among D's purge and re-application entries newer than
// B's head, a payload-null skeleton counting as logical (R5 L0 VS4), or null
// when there is none; read from the constant, so no type is named here.
function descentModeOf(b, d) {
  const newer = journalOf(d).filter((entry) => HARD_GAP_EVIDENCE_TYPES.includes(entry.type) && Number.isSafeInteger(entry.seq) && entry.seq > b.journalSeq);
  if (!newer.length) return null;
  return newer.some((entry) => entry.payload !== null && entry.payload?.mode !== 'logical') ? 'hard' : 'logical';
}

// The record's inputs (§4.5), never the removal set (rev6:376): the ids of
// B's candidates live in D (V-10); the candidates D holds quarantined, under
// D's copy's token when B's copy has none; whether descent is proven, and its
// mode; and the positions of the tombstones B postdates.
function restoreInputs(b, d, knowledge, mine) {
  const ownTokens = new Set([
    ...(mine?.tombstones ?? []).flatMap((tombstone) => (Array.isArray(tombstone.tokens) ? tombstone.tokens : [])),
    ...(mine?.quarantine ?? []).map((entry) => entry.token)
  ]);
  const ownQuarantine = new Set((mine?.quarantine ?? []).map((entry) => entry.token));
  const inD = new Map(entitiesOf(d).map((entity) => [entity.id, entity]));
  const inB = new Map(entitiesOf(b).map((entity) => [entity.id, entity]));
  const { candidates } = classifyRestore(b, knowledge, { live: [], descent: false, descentMode: null, overlap: [], postdated: knowledge.postdated });
  const live = candidates.filter((id) => inD.has(id) && !ownTokens.has(inD.get(id).erasureToken)).sort();
  const overlap = candidates.filter((id) => ownQuarantine.has(inD.get(id)?.erasureToken)).map((id) => {
    const token = named(inB.get(id)?.erasureToken) ? null : inD.get(id).erasureToken;
    return { id, token };
  });
  const descent = provenDescent(b, d, overlap);
  return { live, descent, descentMode: descent ? descentModeOf(b, d) : null, overlap, postdated: knowledge.postdated };
}

// The knowledge a record's restore commits: D's ledger as it stands, which
// already holds whatever a crashed step 1 appended, with the record's `add`
// (§1.2; the index space of `inputs.postdated`).
const knowledgeOf = (ledger, record) => ({
  tombstones: mergedTombstones(ledger?.tombstones ?? [], record.add.tombstones),
  quarantine: [...(ledger?.quarantine ?? []), ...record.add.quarantine],
  tokensStripped: ledger?.tokensStripped ?? record.add.tokensStripped
});

// The post-step's effect on a payload (§6.1-§6.5): classified, then applied on
// a staging graph that takes the caller's verifier and the restore's instant
// (review finding 14). `minted` are the tokens a resolution must assign again
// (§8.4). Its payload is null when nothing is removed and no token assigned:
// an empty effect writes nothing (§6.5). `quarantine` holds the ledger entries
// of everything this run quarantines.
function postStepOf(current, record, ledger, { verifier, instant, minted }) {
  const plan = classifyRestore(current, knowledgeOf(ledger, record), record.inputs);
  if (!plan.remove.length && !plan.quarantine.length) return NO_EFFECT;
  const staging = createShadowGraph({ verifier, now: () => instant });
  staging.importData(structuredClone(current));
  const effect = privilegedReapplyDeletion(staging, plan, { tokens: minted ?? [] });
  const written = effect.counts.removed > 0 || effect.counts.quarantined > 0;
  if (written) validateRestorePayload(effect.payload);
  const tokenOf = new Map(entitiesOf(effect.payload).map((entity) => [entity.id, entity.erasureToken]));
  const entry = (token) => ({ token, at: instant });
  return {
    payload: written ? effect.payload : null, counts: effect.counts, minted: effect.assignedTokens,
    quarantine: plan.quarantine.map(({ id }) => tokenOf.get(id)).filter(named).map(entry)
  };
}

// ---------------------------------------------------------------------------
// The pre-step and the hook (§4, §5).
// ---------------------------------------------------------------------------

// What one restore carries from its hook to its post-step: never persisted.
export function restoreContext({ source, destination, read, env = process.env, verifier, instant, backend = 'json' }) {
  return { source, destination, read, env, verifier, instant, backend, calls: 0, knowledge: 'none', ledger: null, record: null, prior: null, post: null };
}

// The post-step run on B before anything is written (§4.6): a candidate that
// cannot take a token refuses the restore, which loses nothing and leaves B
// as it is, since showing it or keeping its id are both hard stops (V-4). The
// causes are counted, and the remedy for `not_attributed` -- restore into a
// fresh path, migrate there, back up, restore that -- is offered only when
// it works: nothing kindless or unreplayable beside it, and no candidate the
// fresh path would itself refuse (re-review, finding 3). The remedy says what
// its intermediate store shows (Corner 1; review finding 9).
function untokenable(ctx, b, plan) {
  if (!plan.remove.length && !plan.quarantine.length) return null;
  const staging = createShadowGraph({ verifier: ctx.verifier, now: () => ctx.instant });
  staging.importData(structuredClone(b));
  try { privilegedReapplyDeletion(staging, plan); return null; }
  catch (error) { if (error?.untokenable) return error.untokenable; throw error; }
}

function refuseUntokenable(ctx, b, plan, fresh) {
  const counts = untokenable(ctx, b, plan);
  if (!counts) return;
  const freshKnowledge = mergeKnowledge({ d: null, b, mine: null, carried: fresh.carried, registry: fresh.registry, instant: ctx.instant });
  const freshPlan = classifyRestore(b, freshKnowledge, { live: [], descent: false, descentMode: null, overlap: [], postdated: freshKnowledge.postdated });
  const remedy = !counts.fact_without_kind && !counts.not_replayable && !untokenable(ctx, b, freshPlan)?.not_attributed;
  const causes = Object.entries(counts).map(([cause, count]) => `${cause} ${count}`).join(', ');
  const error = refusal(`deletion records reach items of the backup that would have to be withheld, and they cannot take an erasure token (${causes}). ${remedy
    ? 'Restore the backup into a fresh path, run migrate there, back that store up, and restore the new backup here. The fresh path is a store of its own: until then, what it shows is decided by the deletion records that reach it there.'
    : 'There is no remedy at this build: such a backup cannot be restored into a destination whose deletion records reach these items.'}`);
  error.untokenable = counts;
  throw error;
}

// The pre-step (§4), inside the fence the primitive installs under and before
// any write. It refuses what this build cannot honour (§5.1), merges what it
// can (§5.2), and writes the record -- D's ledger as it was plus `pending` --
// only when the restore has something to add or to change; with nothing, the
// primitive runs alone (the T-10 companions).
async function preStep(ctx, given) {
  const b = requiresLegacyPurgeMigration(given) ? validateRestorePayload(given) : given;
  // A writer through another hard link of D is outside every fence this
  // restore holds (V-24).
  if ((await linkCount(ctx.destination)) > 1) throw refusal('the destination has another hard link, through which a write could reach it outside this restore; remove the other link, or restore into a fresh path');
  let d;
  try { d = await ctx.read(); } catch (error) { throw refusal(UNREADABLE_DESTINATION, error); }
  let mine;
  let carried;
  let registry;
  try { [mine, carried, registry] = [await ledgerSnapshot(ctx.destination), await ledgerSnapshot(ctx.source), await readRegistry(ctx.env)]; }
  catch (error) { throw refusal(UNREADABLE_KNOWLEDGE, error); }
  // Step 0 resolved any record; one here is a defence. A sidecar never
  // carries one (C3), an empty list being none (review finding 15).
  if (mine.ledger?.pending.length) throw refusal(PENDING_DELETION);
  if (carried.ledger?.pending.length) throw refusal('the backup\'s deletion records hold a pending record, which a backup never carries');
  if (!carried.ledger && (await linkCount(ctx.source)) > 1) throw refusal('the backup has another hard link and no deletion records beside its name, so records beside the other name cannot be ruled out');
  if (holdsCursor(d)) throw refusal('the destination holds a transcript cursor, which a restore cannot carry yet; a later ShadowGraph build is needed');
  const knowledge = mergeKnowledge({ d, b, mine: mine.ledger, carried: carried.ledger, registry, instant: ctx.instant });
  const merged = knowledge.tombstones.length > 0 || knowledge.quarantine.length > 0;
  ctx.knowledge = merged ? 'present' : 'none';
  ctx.ledger = mine.ledger;
  // T-10 at the verb level (review finding 2; §4.6): with nothing merged no
  // rule reaches B -- descent included -- so the inputs and the plan are
  // computed only when M or Q holds something. Then the restore is the
  // primitive alone, and only a flag B's sidecar carries is still written.
  const inputs = merged ? restoreInputs(b, d, knowledge, mine.ledger) : NO_INPUTS;
  const plan = merged ? classifyRestore(b, knowledge, inputs) : { remove: [], quarantine: [] };
  if (merged) refuseUntokenable(ctx, b, plan, { carried: carried.ledger, registry });
  const add = {
    tombstones: knowledge.tombstones.slice(knowledge.own),
    quarantine: knowledge.quarantine.slice(knowledge.ownQuarantine),
    ...(mine.ledger?.tokensStripped === undefined && knowledge.tokensStripped !== undefined ? { tokensStripped: knowledge.tokensStripped } : {})
  };
  // Through an alias, the ledger these records live in would be left behind
  // (re-review N-1): D's own records count, though they write nothing here.
  if (merged || add.tokensStripped !== undefined || mine.ledger?.tokensStripped !== undefined) await refuseAliasDestination(ctx.destination);
  if (!add.tombstones.length && !add.quarantine.length && !add.tokensStripped && !plan.remove.length && !plan.quarantine.length) return;
  const record = {
    kind: 'restore',
    pre: { revision: d === null ? 0 : currentRevision(d), head: journalHead(d), existed: d !== null },
    expected: { revision: nextRevisionAfter(d ?? {}, given), head: journalHead(b) },
    add,
    inputs
  };
  // What a discard puts back: the ledger's bytes and mode, or nothing (§2 step 5).
  const written = await writeLedger(ctx.destination, (ledger) => { ledger.pending = [record]; }, { env: ctx.env });
  ctx.prior = { path: written.path, text: written.text, bytes: mine.bytes, mode: mine.mode };
  ctx.record = record;
}

// A same-path restore runs no pre-step and writes nothing (§3.5, V-5): it only
// says whether deletion knowledge reaches the store.
async function samePathKnowledge(ctx, payload) {
  try {
    const { ledger } = await ledgerSnapshot(ctx.destination);
    const knowledge = mergeKnowledge({ d: payload, b: payload, mine: ledger, carried: null, registry: await readRegistry(ctx.env), instant: ctx.instant });
    return knowledge.tombstones.length || knowledge.quarantine.length ? 'present' : 'none';
  } catch (error) { throw refusal(UNREADABLE_KNOWLEDGE, error); }
}

// The installed payload is the one the record describes (§5.3): the
// primitive's own revision rule over B's own journal. Declared an equivalent
// mutant under the canonical fence; the binding checks before every commit
// are the tested guards.
function assertBinding(ctx, payload) {
  if (!ctx.record) return;
  const { expected } = ctx.record;
  if (currentRevision(payload) !== expected.revision || journalHead(payload) !== expected.head) throw new Error('The restored payload is not the one the restore record describes');
}

// The validate hook both primitives call (§5): the caller's validator first,
// each call on its own copy, so it can only reject (review finding 5); the
// pre-step at the first call (R-5); and on SQLite the binding at the third,
// the installed replacement -- the second still carries B's own revision
// (review finding 21).
export function restoreHook(ctx, callerValidate) {
  return async (payload) => {
    ctx.calls += 1;
    if (typeof callerValidate === 'function') await callerValidate(structuredClone(payload));
    if (ctx.calls === 1) {
      if (normalized(ctx.source) === normalized(ctx.destination)) ctx.knowledge = await samePathKnowledge(ctx, payload);
      else await preStep(ctx, payload);
    } else if (ctx.calls === 3 && ctx.backend === 'sqlite') assertBinding(ctx, payload);
  };
}

// The `afterReplace` both primitives call, inside their rollback scope (§7).
// With no record the caller gets its own copy of what was installed, with D's
// ledger's view when it holds knowledge; with one, the post-step is computed
// here and the caller gets a copy of its payload with the view of the ledger
// as the post-step will leave it, so running graphs never see raw B
// (rev6:380-381) and a caller that changes its copy cannot change what is
// committed (review finding 5). A failure here rolls the primitive back.
export function activation(ctx, callerAfterReplace) {
  return async (installed) => {
    if (ctx.record) {
      assertBinding(ctx, installed);
      ctx.post = postStepOf(installed, ctx.record, ctx.ledger, { verifier: ctx.verifier, instant: ctx.instant });
    }
    if (typeof callerAfterReplace !== 'function') return;
    const copy = structuredClone(ctx.post?.payload ?? installed);
    if (ctx.record) {
      const knowledge = knowledgeOf(ctx.ledger, ctx.record);
      attachLedgerView(copy, { tombstones: knowledge.tombstones, quarantine: firstPerToken([...knowledge.quarantine, ...ctx.post.quarantine]) });
    } else if (ctx.ledger?.tombstones.length || ctx.ledger?.quarantine.length) attachLedgerView(copy, ctx.ledger);
    await callerAfterReplace(copy);
  };
}

// ---------------------------------------------------------------------------
// The post-step, discard and resolution (§6.6, §8.4, §12).
// ---------------------------------------------------------------------------

// Ledger step 1 (§6.6): the record's `add` and this run's quarantine,
// appended only where not already present, so a step 1 repeated after a crash
// appends nothing twice and leaves `inputs.postdated` naming the same
// tombstones (re-review NF-3). With a payload to commit, the record gets the
// tokens it assigns (kept on a re-run) and the state the commit leaves.
function ledgerStepOne(ledger, effect) {
  const [record] = ledger.pending;
  const kept = new Set((ledger.tombstones ?? []).map(canonical));
  const tombstones = record.add.tombstones.filter((tombstone) => !kept.has(canonical(tombstone)) && kept.add(canonical(tombstone)));
  if (tombstones.length) ledger.tombstones = [...(ledger.tombstones ?? []), ...tombstones];
  const held = new Set((ledger.quarantine ?? []).map((entry) => entry.token));
  const quarantine = firstPerToken([...record.add.quarantine, ...effect.quarantine]).filter((entry) => !held.has(entry.token));
  if (quarantine.length) ledger.quarantine = [...(ledger.quarantine ?? []), ...quarantine];
  if (record.add.tokensStripped !== undefined && ledger.tokensStripped === undefined) ledger.tokensStripped = record.add.tokensStripped;
  if (effect.payload) {
    const { kind, pre, expected, add, inputs } = record;
    ledger.pending = [{ kind, pre, expected, post: { revision: expected.revision + 1, head: journalHead(effect.payload) }, add, inputs, minted: record.minted ?? effect.minted }];
  }
}

// The record goes, and the `pending` member with it, so the ledger returns to
// the members it had before the restore (review finding 15).
function clearRecord(ledger) {
  delete ledger.pending;
}

// A discard (§8.4, §12.1): nothing the record would have added was ever
// committed, so nothing is lost. D's ledger goes back byte for byte, mode
// included, while it is still exactly what the pre-step wrote; one the pre-step
// made, holding nothing else, is removed. Otherwise the record is removed by
// rewrite, and a ledger left with only its version and the record goes.
async function discard(file, env, prior) {
  if (prior && (prior.bytes ? await restoreLedgerBytes(prior.path, prior.text, prior.bytes, prior.mode) : await unlinkLedgerIfRecordOnly(prior.path, prior.text))) return;
  const { path, bytes } = await ledgerSnapshot(file);
  if (path && await unlinkLedgerIfRecordOnly(path, bytes.toString('utf8'))) return;
  await writeLedger(file, clearRecord, { env });
}

// A store's record taken to its end, under the store fence (§8.2, §8.4): in
// `pre` it is discarded, in `committed` completed from its persisted inputs
// only -- steps 1 to 5 of §6.6, the payload committed only over D in the state
// the record binds -- and in `post` cleared. Any other state, or a record this
// build does not write, is kept and refuses. `computed` is the live wrapper's
// post-step, from its activation; `restoreFault` its awaited seams. Resolves
// to whether the payload was written, or null when there is no record.
async function resolveRecord({ read, commit }, file, env, { verifier, instant, computed, restoreFault } = {}) {
  const ledger = await readLedger(file);
  if (!ledger?.pending.length) return null;
  const [record] = ledger.pending;
  if (ledger.pending.length > 1 || !restoreRecordValid(record, ledger.tombstones)) throw pendingUnsupported();
  let current;
  try { current = await read(); } catch { throw restoreUnresolvable(); }
  const state = restoreBinding(record, current, { absent: current === null });
  if (state === 'unknown') throw restoreUnresolvable();
  if (state === 'pre') { await discard(file, env); return false; }
  if (state === 'post') { await writeLedger(file, clearRecord, { env }); return false; }
  const effect = computed ?? postStepOf(current, record, ledger, { verifier, instant, minted: record.minted });
  await writeLedger(file, (next) => ledgerStepOne(next, effect), { env });
  await restoreFault?.('postStepLedgerWritten');
  if (effect.payload) await commit(effect.payload);
  await restoreFault?.('postStepCommitted');
  await writeLedger(file, clearRecord, { env });
  return effect.payload !== null;
}

// Resolution (§8.4), by a restore's step 0, a backup, a save or a quarantine
// verb, with the restore lock held: with its own verifier, when its entry has
// one, and its own clock, neither of which a record persists (re-review NF-6
// (f)). `held`: the caller already holds the store fence.
export async function resolvePendingRestore(io, { held = false, verifier } = {}) {
  await io.run((store) => resolveRecord(store, io.file, io.env, { verifier, instant: new Date().toISOString() }), { held });
}

// Step 0's refusal carries the restore code, as every refusal by a restore
// entry does (§5.1); the resolver's own code is kept as the cause (review
// finding 19).
export async function asRestoreRefusal(step) {
  try { return await step; }
  catch (error) {
    if (error?.code === DELETION_PENDING_UNSUPPORTED) throw refusal(PENDING_DELETION, error);
    if ([CONTROL_LEDGER_MALFORMED, CONTROL_LEDGER_NEWER_VERSION].includes(error?.code)) throw refusal(UNREADABLE_KNOWLEDGE, error);
    throw error;
  }
}

// A primitive error, settled before the restore lock is released (§12.1). D
// still in the state the pre-step read -- every rollback, every error before
// installation, a fresh JSON path the rollback unlinked -- discards the
// record. Installed, unknown or unreadable keeps it, and loads suppress with
// it; it is never discarded unless D is verified at `pre`, and D is never
// made. A failure here keeps the record too, which fails closed, and the
// primitive's own error is the one thrown.
export async function settleAfterFailure(io, ctx, { held = false } = {}) {
  if (!ctx.record) return;
  try {
    await io.run(async ({ read }) => {
      const record = (await readLedger(io.file))?.pending[0];
      if (!record || canonical(record) !== canonical(ctx.record)) return;
      const current = await read();
      if (restoreBinding(record, current, { absent: current === null }) === 'pre') await discard(io.file, io.env, ctx.prior);
    }, { held });
  } catch { /* the record is kept */ }
}

// After the primitive returned (§6.6, §7): the post-step under the store
// fence, then a second activation from the store's own load when the payload
// was written, which syncs the caller's revision. A post-step that fails
// re-activates the caller from a load that suppresses with the record and
// returns `completion: 'pending'` (V-8); if that load fails too, the
// post-step's error stands. On SQLite `load` takes the fence itself, so it is
// called only after `io.run` returns (review finding 7).
export async function completeRestore(io, ctx, result, callerAfterReplace, { held = false, load, restoreFault } = {}) {
  const outcome = { ...result, deletionKnowledge: ctx.knowledge };
  if (ctx.knowledge === 'present') outcome.reapplied = { ...(ctx.post?.counts ?? NO_EFFECT.counts) };
  if (!ctx.record) return outcome;
  let written;
  try {
    await restoreFault?.('beforePostStep');
    written = await io.run((store) => resolveRecord(store, io.file, io.env, { computed: ctx.post ?? NO_EFFECT, restoreFault }), { held });
  } catch (error) {
    let reloaded;
    try { reloaded = await load(); } catch { throw error; }
    if (typeof callerAfterReplace === 'function') await callerAfterReplace(reloaded);
    return { ...outcome, completion: 'pending' };
  }
  // The record the pre-step wrote is not beside the store: the post-step
  // never ran, and a load now would suppress nothing, so the caller keeps the
  // activation the hook gave it and the restore fails (review finding 1, its
  // defence; re-review N-2; §12.3).
  if (written === null) throw refusal('the backup was installed, but its deletion record is no longer beside the store, so what the records remove or withhold was not applied; restore again through the name the store file has itself');
  if (written && typeof callerAfterReplace === 'function') await callerAfterReplace(await load());
  return outcome;
}

// ---------------------------------------------------------------------------
// Writes never commit over a record (§8.3).
// ---------------------------------------------------------------------------

// What a save throws inside its fence when it meets a restore record; it never
// leaves save().
export class RestorePendingError extends Error {
  constructor() {
    super('A restore record waits for its post-step');
    this.name = 'RestorePendingError';
  }
}

// A save that meets a record releases its fence, waits on the restore lock --
// for a live restore, bounded by its timeout, or reclaiming a dead one's --
// resolves, and is tried once more inside that lock, so no other restore can
// write a record between the two (review finding 12); the retry usually ends
// in a revision conflict, which the callers reload on (V-9). A record still
// there then is one this build cannot resolve.
export async function saveResolving(io, options, attempt) {
  try { return await attempt(); }
  catch (error) { if (!(error instanceof RestorePendingError)) throw error; }
  return restoreLock(io.file, options).run(async () => {
    await resolvePendingRestore(io);
    try { return await attempt(); }
    catch (error) {
      if (error instanceof RestorePendingError) throw pendingUnsupported();
      throw error;
    }
  });
}
