// Project-scoping conformance harness: eleven public read paths, each exercised
// on its own against two projects plus records written with no project at all.
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
// - a path with no row must be conformant.
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
  graph.remember({ project: 'beta', memoryType: 'note', key: 'beta', text: 'MEMORY-MARKER beta' });
  // The unresolved-scope case: written with no project at all.
  graph.addDecision({ title: 'Unscoped MARKER cache', chosen: 'none' });
  graph.remember({ memoryType: 'note', key: 'unscoped', text: 'MEMORY-MARKER unscoped' });
  return { graph, alphaDecisionId: alphaDecision.id };
}

const projectsOf = (records) => [...new Set(records.map((record) => record.project))].sort();
const itemProjects = (result) => projectsOf(result.items.map((item) => item.record));
const envelope = (result) => ({
  scopeProject: result.completeness.scope.project,
  complete: result.completeness.complete,
  limitation: result.completeness.limitation?.code === 'scoped_coverage'
});
const unresolvedTarget = { withheldProjects: [], complete: false, limitation: true };

// `observe` records what the path does; `target` holds only the fields that
// decide conformance. Everything observed is compared against the row.
const PATHS = {
  // The project predicate on its own: a filter-only query, no content terms.
  matchesFilters: {
    observe: ({ graph }) => ({
      withheldProjects: itemProjects(graph.search('', { kind: 'decision' })),
      selectedProjects: itemProjects(graph.search('', { kind: 'decision', project: 'beta' }))
    }),
    target: { withheldProjects: [], selectedProjects: ['beta'] }
  },
  search: {
    observe: ({ graph }) => {
      const result = graph.search('MARKER', {});
      return { withheldProjects: itemProjects(result), ...envelope(result) };
    },
    target: unresolvedTarget
  },
  retrieve: {
    observe: ({ graph }) => {
      const result = graph.retrieve('MARKER', {});
      return {
        withheldProjects: itemProjects(result),
        graphExpandedProjects: projectsOf(result.items.filter((item) => item.matchedBy === 'graph').map((item) => item.record)),
        ...envelope(result)
      };
    },
    target: { ...unresolvedTarget, graphExpandedProjects: [] }
  },
  recall: {
    observe: ({ graph }) => {
      const result = graph.recall('MEMORY-MARKER', {});
      return { withheldProjects: itemProjects(result), ...envelope(result) };
    },
    target: unresolvedTarget
  },
  context: {
    observe: ({ graph }) => {
      const result = graph.context({});
      return { withheldProjects: projectsOf(result.activeDecisions), ...envelope(result) };
    },
    target: unresolvedTarget
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
        existenceDistinguishable: otherProject !== outcome({ id: 'decision_absent', project: 'beta' })
      };
    },
    target: { withheldReturnsRecord: false, otherProjectReturnsRecord: false, existenceDistinguishable: false }
  },
  traverse: {
    observe: ({ graph, alphaDecisionId }) => {
      const withheld = graph.traverse({ id: alphaDecisionId });
      const selected = graph.traverse({ id: alphaDecisionId, project: 'alpha' });
      return {
        withheldNodeProjects: projectsOf(withheld.nodes),
        withheldReachesMemory: withheld.nodes.some((node) => node.kind === 'memory'),
        selectedReachesMemory: selected.nodes.some((node) => node.kind === 'memory')
      };
    },
    target: { withheldNodeProjects: [], selectedReachesMemory: true }
  },
  getJournal: {
    observe: ({ graph }) => {
      const result = graph.getJournal({});
      return { withheldProjects: projectsOf(result.items), ...envelope(result) };
    },
    target: unresolvedTarget
  },
  // The fixture holds one decision in each of alpha, beta and the unscoped case.
  stats: {
    observe: ({ graph }) => ({
      withheldDecisions: graph.stats().decisions,
      selectedDecisions: graph.stats({ project: 'alpha' }).decisions
    }),
    target: { withheldDecisions: 0, selectedDecisions: 1 }
  },
  redact: {
    observe: ({ graph }) => ({
      withheldProjects: projectsOf(graph.redact({}).records),
      selectedProjects: projectsOf(graph.redact({ project: 'beta' }).records)
    }),
    target: { withheldProjects: [], selectedProjects: ['beta'] }
  },
  // exportData() is what GET /records and the `list` verb return today.
  publicExport: {
    observe: ({ graph }) => ({ withheldProjects: projectsOf(graph.exportData().records) }),
    target: { withheldProjects: [] }
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
  if (!row) {
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
