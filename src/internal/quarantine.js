// The owner's quarantine verbs (PR-37c design §9; OD-DP1 = Option A): what a
// restore withheld as possibly purged is listed, released or purged here, and
// only here: `shadowgraph quarantine list|release|purge` on the CLI, after the
// owner confirms at a terminal there. Nothing is released or purged
// automatically (rev6:399, :590). The bodies are kept out of cli.js so they
// run in tests on every platform; cli.js is their only importer, and no MCP
// tool or HTTP route reaches them (a source scan pins both, §13.3).
//
// INTERNAL: package.json "exports" does not map this file.
import { createShadowGraph } from '../shadowgraph.js';
import { isValidIsoInstant } from '../fact-validity.js';
import { restoreLock } from '../revision-store.js';
import { privilegedQuarantined, privilegedReapplyDeletion, privilegedSnapshot } from './snapshot.js';
import { attachDeletionView, pendingUnsupported, readLedger, storeIo, writeLedger } from './deletion-knowledge.js';
import { resolvePendingRestore } from './restore-wrapper.js';

const SUBCOMMANDS = ['list', 'release', 'purge'];
const USAGE = 'Usage: shadowgraph quarantine list [{"project": P}] | release {"ids": [id, ...]} or {"project": P} | purge {"ids": [id, ...]} or {"project": P}';
const named = (value) => typeof value === 'string' && value.length > 0;

// Messages name no id, project or token (F16): the owner has the selection.
function refusal(code, message) {
  const error = new Error(`${message} (${code})`);
  error.code = code;
  return error;
}

// `list` takes an optional project; `release` and `purge` exactly one of ids
// or a project (§9.1).
function checkSelection(subcommand, selection) {
  const value = selection ?? {};
  if (!SUBCOMMANDS.includes(subcommand) || value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(USAGE);
  const ids = value.ids !== undefined;
  const project = value.project !== undefined;
  if (project && !named(value.project)) throw new Error(USAGE);
  if (subcommand === 'list' ? ids : ids === project || (ids && !(Array.isArray(value.ids) && value.ids.length && value.ids.every(named)))) {
    throw new Error(`${USAGE}; release and purge take exactly one of ids or a project`);
  }
}

// Counts by owner: a project, or the origin of unattributed items.
function countsOf(entries) {
  const counts = {};
  for (const entry of entries) {
    const owner = (entry.attribution === 'unattributed' ? entry.originId : entry.project) ?? 'unowned';
    counts[owner] = (counts[owner] ?? 0) + 1;
  }
  return counts;
}

// One verb's work (§9.1): the restore lock only, then one hold of the store
// fence through the store's own I/O, in which any restore record is resolved
// first (§8.4), the payload read and its view built -- fenced, so no bracket
// -- and a graph imported with it. `store.load` and `store.save` are never
// called inside: both take the fence, which cannot be re-entered. A purge
// record is completed only by a confirmed verb that writes (`complete`).
// Listing and pre-confirmation selection refuse every pending record without
// resolving even a restore's pre-state (FND-P6-20).
async function underLocks(store, now, act, { complete }) {
  const io = storeIo(store);
  return restoreLock(io.file).run(() => io.run(async (tools) => {
    if (complete) await resolvePendingRestore(io, { held: true, purges: true });
    else if ((await readLedger(io.file))?.pending.length) throw pendingUnsupported();
    const payload = await tools.read();
    const graph = createShadowGraph(typeof now === 'function' ? { now } : {});
    if (payload !== null) graph.importData(await attachDeletionView(payload, io.file, { env: io.env }));
    return act(graph, tools, io);
  }));
}

// The selected items, each one quarantined, or the whole call refused. A token
// a tombstone names is never quarantined (§9.3), so this also refuses its
// release.
function selected(graph, ids) {
  const quarantined = new Map(privilegedQuarantined(graph).map((entry) => [entry.id, entry]));
  if (!ids.every((id) => quarantined.has(id))) throw refusal('quarantine_selection_refused', 'Refusing the whole selection: an item in it is not quarantined');
  return ids.map((id) => quarantined.get(id));
}

// What a verb will act on, read-only, for the owner's confirmation and for
// `list` (§9.2): identity and counts, never content.
export async function quarantineSelection(store, subcommand, selection) {
  checkSelection(subcommand, selection);
  return underLocks(store, undefined, (graph) => {
    const all = privilegedQuarantined(graph);
    if (subcommand === 'list') {
      const entries = selection?.project === undefined ? all : all.filter((entry) => entry.project === selection.project);
      return { entries, counts: countsOf(entries) };
    }
    const entries = selection.ids ? selected(graph, [...new Set(selection.ids)]) : all.filter((entry) => entry.project === selection.project);
    return { subcommand, ids: entries.map((entry) => entry.id), counts: countsOf(entries) };
  }, { complete: false });
}

// `release` or `purge` of the ids the owner confirmed (§9.2), each checked
// again under the locks, so one that stopped being quarantined since refuses
// the call.
//
// Release removes the items' entries from the ledger's quarantine and writes
// no payload: each keeps its token and becomes visible. It refuses when a
// tombstone of the item's project or origin was recorded after the entry, as
// it may have purged the item since (R5 L1 VS1 (2)). A project tombstone that
// names no project reaches every project, and an entry or tombstone with no
// valid instant counts as earlier or later accordingly, both closed.
//
// Purge removes the items physically, as a logical removal: skeletons, and no
// restore.reapplied, since this is not a restore. Their quarantine entries
// stay, so any copy a later restore brings back stays hidden (rev6:417), and
// it writes no tombstone or registry entry (V-6): nothing was ever proven
// purged. A hard splice needs gap evidence only a removal with PR-37d's
// discipline should write.
export async function applyQuarantine(store, subcommand, ids, { now } = {}) {
  if (!['release', 'purge'].includes(subcommand) || !Array.isArray(ids) || !ids.length || !ids.every(named)) throw new Error(USAGE);
  return underLocks(store, now, async (graph, { commit }, io) => {
    const items = selected(graph, [...new Set(ids)]);
    if (subcommand === 'purge') {
      privilegedReapplyDeletion(graph, { remove: items.map(({ id }) => ({ id, mode: 'logical' })) }, { journal: false });
      await commit(privilegedSnapshot(graph));
      return { subcommand, ids: items.map(({ id }) => id) };
    }
    const snapshot = privilegedSnapshot(graph);
    const tokenOf = new Map([...snapshot.records, ...snapshot.facts].map((entity) => [entity.id, entity.erasureToken]));
    const { tombstones, quarantine } = await readLedger(io.file);
    const later = (tombstone, entry) => !isValidIsoInstant(tombstone.at) || !isValidIsoInstant(entry.at) || Date.parse(tombstone.at) > Date.parse(entry.at);
    for (const item of items) {
      const reaches = (tombstone) => (tombstone.kind === 'project' && (tombstone.purgedProject === undefined || tombstone.purgedProject === item.project))
        || (tombstone.kind === 'origin' && item.attribution === 'unattributed' && tombstone.purgedOrigin === item.originId);
      const entries = quarantine.filter((entry) => entry.token === tokenOf.get(item.id));
      if (tombstones.some((tombstone) => reaches(tombstone) && entries.some((entry) => later(tombstone, entry)))) {
        throw refusal('quarantine_release_refused', 'Refusing to release: a deletion record later than the quarantine may reach an item in the selection');
      }
    }
    const tokens = new Set(items.map(({ id }) => tokenOf.get(id)));
    await writeLedger(io.file, (next) => { next.quarantine = next.quarantine.filter((entry) => !tokens.has(entry.token)); }, { env: io.env });
    return { subcommand, ids: items.map(({ id }) => id) };
  }, { complete: true });
}
