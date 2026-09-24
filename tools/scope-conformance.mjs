// Project-scoping conformance harness: eleven public read paths, each exercised
// on its own against two projects plus records in the literal project `default`
// (where identity-less writes landed before the schema-6 writer refused them),
// once with no project (unresolved scope) and once with project `alpha`
// selected. The fixture links an alpha decision to a beta attempt, so a selected
// read that follows a graph edge meets a boundary it could actually cross.
//
// NOT part of `npm test`, deliberately. The approved `project_only` rule says a
// read with no resolved project returns nothing, reports `complete: false` and
// declares a scoped-coverage limitation; a read for one project never returns
// another project's record. The current build does not meet that on any of the
// eleven paths. This harness records exactly how each path fails today and
// exits 0 only while that recorded behaviour still holds. It exits 1 when any
// path differs from its row in EITHER direction -- a new failure, or a path
// that became conformant while its row was still recorded -- so a scoping
// change can neither regress silently nor be claimed without retiring its row.
//
//   npm run test:scope-conformance
//   node tools/scope-conformance.mjs [--baseline <file>]
//
// `node --test` runs every JavaScript file under test/, so a harness kept there
// would run inside the production suite; tools/ already holds this repository's
// other out-of-suite instruments (compare-failures.cjs / expected-failures.json).
//
// Rules the harness enforces rather than trusts:
// - every path is observed on every run, whether or not it has a row, so a
//   deleted row cannot hide a failing path;
// - a row may only record NON-conformant behaviour -- a row that already meets
//   the target is refused, so the baseline cannot be used to fake a pass;
// - a path with no row must be conformant, for the unresolved AND the selected
//   project, so retiring a row cannot drop either half of the target;
// - a path whose target cannot yet be stated in full may not be retired at all
//   (`retireOnlyWith`): it must first gain the missing target.
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { createShadowGraph } from '../src/shadowgraph.js';

// A fresh graph per path, so one path's side effects cannot shape another's
// observation.
function fixture() {
  const graph = createShadowGraph({ now: () => '2026-01-01T00:00:00.000Z' });
  const alphaDecision = graph.addDecision({ project: 'alpha', title: 'Alpha MARKER cache', chosen: 'redis' });
  const alphaAttempt = graph.addAttempt({ project: 'alpha', solution: 'alpha warm-up script', result: 'worked' });
  const alphaMemory = graph.remember({ project: 'alpha', memoryType: 'note', key: 'alpha', text: 'MEMORY-MARKER alpha' }).memory;
  graph.link({ from: alphaDecision.id, to: alphaAttempt.id, relation: 'tried' });
  graph.link({ from: alphaDecision.id, to: alphaMemory.id, relation: 'noted' });
  graph.addDecision({ project: 'beta', title: 'Beta MARKER cache', chosen: 'memcached' });
  const betaAttempt = graph.addAttempt({ project: 'beta', solution: 'beta warm-up script', result: 'worked' });
  graph.remember({ project: 'beta', memoryType: 'note', key: 'beta', text: 'MEMORY-MARKER beta' });
  // The deliberate cross-project edge. A read with `alpha` selected must not
  // follow it into beta, however the read expands.
  graph.link({ from: alphaDecision.id, to: betaAttempt.id, relation: 'related' });
  // The unresolved-scope case. A write with neither a project nor an origin is
  // refused since the schema-6 writer, so these records are written to the
  // literal project "default" -- the bucket such writes used to land in, and
  // the one an identity-less read still collapses to. Every observation below
  // is unchanged by that: a read that leaks "default" is still caught.
  graph.addDecision({ project: 'default', title: 'Unscoped MARKER cache', chosen: 'none' });
  graph.remember({ project: 'default', memoryType: 'note', key: 'unscoped', text: 'MEMORY-MARKER unscoped' });
  return { graph, alphaDecisionId: alphaDecision.id, betaAttemptId: betaAttempt.id };
}

const projectsOf = (records) => [...new Set(records.map((record) => record.project))].sort();
const itemProjects = (result) => projectsOf(result.items.map((item) => item.record));
const envelope = (result) => ({
  scopeProject: result.completeness.scope.project,
  complete: result.completeness.complete,
  limitation: result.completeness.limitation?.code === 'scoped_coverage'
});
const unresolvedTarget = { withheldProjects: [], complete: false, limitation: true };
// Every `selected*` observation below is a read with project `alpha`.
const recordsIn = (context) => [...context.activeDecisions, ...context.staleAssumptions, ...context.failedAttemptsToAvoid, ...context.reusableAttempts];

// `observe` records what the path does; `target` holds only the fields that
// decide conformance. Everything observed is compared against the row.
const PATHS = {
  // The project predicate on its own: a filter-only query, no content terms.
  matchesFilters: {
    observe: ({ graph }) => ({
      withheldProjects: itemProjects(graph.search('', { kind: 'decision' })),
      selectedProjects: itemProjects(graph.search('', { kind: 'decision', project: 'alpha' }))
    }),
    target: { withheldProjects: [], selectedProjects: ['alpha'] }
  },
  search: {
    observe: ({ graph }) => {
      const result = graph.search('MARKER', {});
      return { withheldProjects: itemProjects(result), ...envelope(result), selectedProjects: itemProjects(graph.search('MARKER', { project: 'alpha' })) };
    },
    target: { ...unresolvedTarget, selectedProjects: ['alpha'] }
  },
  retrieve: {
    observe: ({ graph }) => {
      const expanded = (result) => projectsOf(result.items.filter((item) => item.matchedBy === 'graph').map((item) => item.record));
      const result = graph.retrieve('MARKER', {});
      const selected = graph.retrieve('MARKER', { project: 'alpha' });
      return {
        withheldProjects: itemProjects(result),
        graphExpandedProjects: expanded(result),
        ...envelope(result),
        selectedProjects: itemProjects(selected),
        selectedGraphExpandedProjects: expanded(selected)
      };
    },
    target: { ...unresolvedTarget, graphExpandedProjects: [], selectedProjects: ['alpha'], selectedGraphExpandedProjects: ['alpha'] }
  },
  recall: {
    observe: ({ graph }) => {
      const result = graph.recall('MEMORY-MARKER', {});
      return { withheldProjects: itemProjects(result), ...envelope(result), selectedProjects: itemProjects(graph.recall('MEMORY-MARKER', { project: 'alpha' })) };
    },
    target: { ...unresolvedTarget, selectedProjects: ['alpha'] }
  },
  context: {
    observe: ({ graph }) => {
      const result = graph.context({});
      return { withheldProjects: projectsOf(result.activeDecisions), ...envelope(result), selectedProjects: projectsOf(recordsIn(graph.context({ project: 'alpha' }))) };
    },
    target: { ...unresolvedTarget, selectedProjects: ['alpha'] }
  },
  // A by-id read. traverse() is the public entry point that resolves an
  // arbitrary id, through entity(). Outside the boundary the target is no
  // record, and the same response whether or not the id exists elsewhere.
  entity: {
    observe: ({ graph, alphaDecisionId }) => {
      const outcome = (input) => {
        try { return graph.traverse(input).nodes.some((node) => node.id === input.id) ? 'returned' : 'withheld'; }
        catch (error) { return `threw: ${error.message}`; }
      };
      const otherProject = outcome({ id: alphaDecisionId, project: 'beta' });
      return {
        withheldReturnsRecord: outcome({ id: alphaDecisionId }) === 'returned',
        otherProjectReturnsRecord: otherProject === 'returned',
        existenceDistinguishable: otherProject !== outcome({ id: 'decision_absent', project: 'beta' }),
        selectedReturnsRecord: outcome({ id: alphaDecisionId, project: 'alpha' }) === 'returned'
      };
    },
    target: { withheldReturnsRecord: false, otherProjectReturnsRecord: false, existenceDistinguishable: false, selectedReturnsRecord: true }
  },
  traverse: {
    observe: ({ graph, alphaDecisionId }) => {
      const withheld = graph.traverse({ id: alphaDecisionId });
      const selected = graph.traverse({ id: alphaDecisionId, project: 'alpha' });
      return {
        withheldNodeProjects: projectsOf(withheld.nodes),
        withheldReachesMemory: withheld.nodes.some((node) => node.kind === 'memory'),
        selectedReachesMemory: selected.nodes.some((node) => node.kind === 'memory'),
        selectedNodeProjects: projectsOf(selected.nodes)
      };
    },
    target: { withheldNodeProjects: [], selectedReachesMemory: true, selectedNodeProjects: ['alpha'] }
  },
  // `selectedNamesBetaId` is observed but not yet targeted: the alpha-labelled
  // entry for the cross-project link carries the beta id in its payload, and
  // whether an in-scope entry may name an out-of-scope id is left to the
  // change-set that scopes the journal. Recording it keeps it from moving silently.
  getJournal: {
    observe: ({ graph, betaAttemptId }) => {
      const result = graph.getJournal({});
      const selected = graph.getJournal({ project: 'alpha' }).items;
      return { withheldProjects: projectsOf(result.items), ...envelope(result), selectedProjects: projectsOf(selected), selectedNamesBetaId: JSON.stringify(selected).includes(betaAttemptId) };
    },
    target: { ...unresolvedTarget, selectedProjects: ['alpha'] }
  },
  // The fixture holds one decision in each of alpha, beta and the unscoped case,
  // and one attempt in each of alpha and beta.
  stats: {
    observe: ({ graph }) => {
      const selected = graph.stats({ project: 'alpha' });
      return { withheldDecisions: graph.stats().decisions, selectedDecisions: selected.decisions, selectedAttempts: selected.attempts };
    },
    target: { withheldDecisions: 0, selectedDecisions: 1, selectedAttempts: 1 }
  },
  redact: {
    observe: ({ graph, betaAttemptId }) => {
      const selected = graph.redact({ project: 'alpha' });
      const ids = new Set([...selected.records, ...selected.facts].map((item) => item.id));
      return {
        withheldProjects: projectsOf(graph.redact({}).records),
        selectedProjects: projectsOf([...selected.records, ...selected.facts, ...selected.journal]),
        selectedRelationsLeavingScope: selected.relations.filter((relation) => !ids.has(relation.from) || !ids.has(relation.to)).length,
        selectedNamesBetaId: JSON.stringify(selected).includes(betaAttemptId)   // observed, not targeted -- see getJournal
      };
    },
    target: { withheldProjects: [], selectedProjects: ['alpha'], selectedRelationsLeavingScope: 0 }
  },
  // exportData() is what GET /records and the `list` verb return today. It has
  // no project parameter, so no selected-project target can be written for it
  // without inventing an interface; retiring its row therefore requires adding
  // that target in the same change-set that gives the public export its scope.
  publicExport: {
    observe: ({ graph }) => ({ withheldProjects: projectsOf(graph.exportData().records) }),
    target: { withheldProjects: [] },
    retireOnlyWith: 'a selected-project target, added in the same change-set that gives the public export a project scope'
  }
};

const meetsTarget = (observed, target) => Object.entries(target).every(([key, value]) => isDeepStrictEqual(observed[key], value));

const flag = process.argv.indexOf('--baseline');
const baselinePath = flag === -1 ? new URL('./scope-conformance-baseline.json', import.meta.url) : process.argv[flag + 1];
const { paths: rows = {} } = JSON.parse(await readFile(baselinePath, 'utf8'));

const results = Object.keys(rows)
  .filter((name) => !Object.hasOwn(PATHS, name))
  .map((name) => ({ name, ok: false, detail: 'baseline row names no known read path' }));
for (const [name, path] of Object.entries(PATHS)) {
  let observed;
  try { observed = path.observe(fixture()); } catch (error) { observed = { harnessError: error.message }; }
  const conformant = meetsTarget(observed, path.target);
  const row = rows[name];
  if (!row && path.retireOnlyWith) {
    results.push({ name, ok: false, detail: `row may not be retired until the harness has ${path.retireOnlyWith}` });
  } else if (!row) {
    results.push({ name, ok: conformant, detail: conformant ? 'conformant (row retired)' : `non-conformant with no baseline row; observed ${JSON.stringify(observed)}` });
  } else if (meetsTarget(row.observed ?? {}, path.target)) {
    results.push({ name, ok: false, detail: 'baseline row records conformant behaviour; retire the row instead' });
  } else if (!isDeepStrictEqual(observed, row.observed)) {
    results.push({
      name,
      ok: false,
      detail: `${conformant ? 'now conformant: retire this row in the same change-set' : 'drifted from the recorded baseline'}; `
        + `recorded ${JSON.stringify(row.observed)}; observed ${JSON.stringify(observed)}`
    });
  } else {
    const failing = Object.keys(path.target).filter((key) => !isDeepStrictEqual(observed[key], path.target[key]));
    results.push({ name, ok: true, detail: `matches recorded non-conformance (${failing.join(', ')})` });
  }
}

for (const { name, ok, detail } of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
const failed = results.filter((result) => !result.ok).length;
console.log(`scope conformance: ${Object.keys(PATHS).length} paths, ${Object.keys(rows).length} baseline rows, ${failed} failing`);
process.exitCode = failed ? 1 : 0;
