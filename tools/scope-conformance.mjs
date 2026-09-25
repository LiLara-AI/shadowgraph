// All-positive project-scope conformance: eleven paths, sixteen checks.
// Every path must satisfy its boundary and coverage target. The historical
// alpha-to-beta relation fixture is retained unchanged. npm run test:scope-conformance
import { isDeepStrictEqual } from 'node:util';
import { createShadowGraph } from '../src/shadowgraph.js';
import { historicalRelation } from './historical-relation.js';

// A fresh graph per path, so one path's side effects cannot shape another's
// observation.
function fixture() {
  const NOW = '2026-01-01T00:00:00.000Z';
  const graph = createShadowGraph({ now: () => NOW });
  const alphaDecision = graph.addDecision({ project: 'alpha', title: 'Alpha MARKER cache', chosen: 'redis' });
  const alphaAttempt = graph.addAttempt({ project: 'alpha', solution: 'alpha warm-up script', result: 'worked' });
  const alphaMemory = graph.remember({ project: 'alpha', memoryType: 'note', key: 'alpha', text: 'MEMORY-MARKER alpha' }).memory;
  graph.link({ project: 'alpha', from: alphaDecision.id, to: alphaAttempt.id, relation: 'tried' });
  graph.link({ project: 'alpha', from: alphaDecision.id, to: alphaMemory.id, relation: 'noted' });
  graph.addDecision({ project: 'beta', title: 'Beta MARKER cache', chosen: 'memcached' });
  const betaAttempt = graph.addAttempt({ project: 'beta', solution: 'beta warm-up script', result: 'worked' });
  graph.remember({ project: 'beta', memoryType: 'note', key: 'beta', text: 'MEMORY-MARKER beta' });
  // The deliberate cross-project edge. A read with `alpha` selected must not
  // follow it into beta, however the read expands. link() refuses a relation
  // across projects since plan PR-09 (P1 reconciliation F-16), so the edge is
  // imported as a store written before then holds it, as the fixture's ninth
  // journal entry.
  graph.importData(historicalRelation({ id: 'relation_alpha_beta', from: alphaDecision.id, to: betaAttempt.id, relation: 'related', project: 'alpha', seq: 9, at: NOW }));
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
  requestState: result.completeness.scope.requestState,
  originPresented: result.completeness.scope.originPresented,
  grant: result.completeness.scope.grant,
  complete: result.completeness.complete,
  limitation: result.completeness.limitation?.code === 'scoped_coverage'
});
// An unresolved read returns no record, and says so.
const coverageTarget = { scopeProject: null, requestState: 'project_unresolved', originPresented: false, grant: null, complete: false, limitation: true };
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
    observe: ({ graph }) => ({
      withheldProjects: itemProjects(graph.search('MARKER', {})),
      selectedProjects: itemProjects(graph.search('MARKER', { project: 'alpha' }))
    }),
    target: { withheldProjects: [], selectedProjects: ['alpha'] }
  },
  'search.coverage': {
    observe: ({ graph }) => envelope(graph.search('MARKER', {})),
    target: coverageTarget
  },
  retrieve: {
    observe: ({ graph }) => {
      const expanded = (result) => projectsOf(result.items.filter((item) => item.matchedBy === 'graph').map((item) => item.record));
      const result = graph.retrieve('MARKER', {});
      const selected = graph.retrieve('MARKER', { project: 'alpha' });
      return {
        withheldProjects: itemProjects(result),
        graphExpandedProjects: expanded(result),
        selectedProjects: itemProjects(selected),
        selectedGraphExpandedProjects: expanded(selected)
      };
    },
    target: { withheldProjects: [], graphExpandedProjects: [], selectedProjects: ['alpha'], selectedGraphExpandedProjects: ['alpha'] }
  },
  'retrieve.coverage': {
    observe: ({ graph }) => envelope(graph.retrieve('MARKER', {})),
    target: coverageTarget
  },
  recall: {
    observe: ({ graph }) => ({
      withheldProjects: itemProjects(graph.recall('MEMORY-MARKER', {})),
      selectedProjects: itemProjects(graph.recall('MEMORY-MARKER', { project: 'alpha' }))
    }),
    target: { withheldProjects: [], selectedProjects: ['alpha'] }
  },
  'recall.coverage': {
    observe: ({ graph }) => envelope(graph.recall('MEMORY-MARKER', {})),
    target: coverageTarget
  },
  // Every record collection context() returns, for both the unresolved and the
  // selected read.
  context: {
    observe: ({ graph }) => ({
      withheldProjects: projectsOf(recordsIn(graph.context({}))),
      selectedProjects: projectsOf(recordsIn(graph.context({ project: 'alpha' })))
    }),
    target: { withheldProjects: [], selectedProjects: ['alpha'] }
  },
  'context.coverage': {
    observe: ({ graph }) => envelope(graph.context({})),
    target: coverageTarget
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
  // The alpha-labelled journal entry for the cross-project link carries the beta
  // id in its payload, so a selected read that returned it would name an id
  // outside its scope (P1 reconciliation F-16): `selectedNamesBetaId` is
  // targeted false here, for redact and for the public export.
  getJournal: {
    observe: ({ graph, betaAttemptId }) => {
      const selected = graph.getJournal({ project: 'alpha' }).items;
      return { withheldProjects: projectsOf(graph.getJournal({}).items), selectedProjects: projectsOf(selected), selectedNamesBetaId: JSON.stringify(selected).includes(betaAttemptId) };
    },
    target: { withheldProjects: [], selectedProjects: ['alpha'], selectedNamesBetaId: false }
  },
  'getJournal.coverage': {
    observe: ({ graph }) => envelope(graph.getJournal({})),
    target: coverageTarget
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
        selectedNamesBetaId: JSON.stringify(selected).includes(betaAttemptId)
      };
    },
    target: { withheldProjects: [], selectedProjects: ['alpha'], selectedRelationsLeavingScope: 0, selectedNamesBetaId: false }
  },
  // exportData() is what GET /records and the `list` verb return. It gained its
  // project scope in the change-set that retired its row, together with this
  // selected-project target.
  publicExport: {
    observe: ({ graph, betaAttemptId }) => {
      const selected = graph.exportData({ project: 'alpha' });
      return {
        withheldProjects: projectsOf(graph.exportData().records),
        selectedProjects: projectsOf([...selected.records, ...selected.facts]),
        selectedNamesBetaId: JSON.stringify(selected).includes(betaAttemptId)
      };
    },
    target: { withheldProjects: [], selectedProjects: ['alpha'], selectedNamesBetaId: false }
  }
};

const meetsTarget = (observed, target) => Object.entries(target).every(([key, value]) => isDeepStrictEqual(observed[key], value));

const results = [];
for (const [name, path] of Object.entries(PATHS)) {
  let observed;
  try { observed = path.observe(fixture()); } catch (error) { observed = { harnessError: error.message }; }
  const ok = meetsTarget(observed, path.target);
  results.push({ name, ok, detail: ok ? 'conformant' : `observed ${JSON.stringify(observed)}; expected ${JSON.stringify(path.target)}` });
}
for (const { name, ok, detail } of results) console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
const failed = results.filter((result) => !result.ok).length;
const readPaths = new Set(Object.keys(PATHS).map((name) => name.split('.')[0])).size;
console.log(`scope conformance: ${readPaths} paths, ${Object.keys(PATHS).length} checks, all-positive, ${failed} failing`);
process.exitCode = failed ? 1 : 0;
