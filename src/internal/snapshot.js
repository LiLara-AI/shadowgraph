// The privileged store primitives (plan v1.4.4 §11; P1 reconciliation F-17).
//
// INTERNAL. The snapshot is the persistence primitive -- the input to
// store.save, replaceData staging, rebuild normalisation, backup and restore
// validation -- and it is deliberately not a read of the memory product:
// complete, unscoped, with no side effects. The integrity check and the
// journal replay beside it see the whole store in the same way, because
// staging and restore validation must refuse a store that is broken anywhere;
// their public counterparts, graph.validate() and graph.rebuild(), answer
// inside the request's scope. package.json "exports" does not map this file,
// so it cannot be imported by package name, and
// test/privileged-snapshot.test.js holds the list of repository modules
// allowed to import it by path.
//
// A graph registers its primitives here when createShadowGraph() builds it.
// The registry is a WeakMap, so the graph object itself carries no key,
// symbol or method that exposes them.
const registry = new WeakMap();

export function registerPrivileged(graph, primitives) {
  registry.set(graph, primitives);
  return graph;
}

function primitive(graph, name, caller) {
  const found = graph !== null && typeof graph === 'object' ? registry.get(graph)?.[name] : undefined;
  if (!found) throw new TypeError(`${caller} requires a graph created by createShadowGraph`);
  return found;
}

export function privilegedSnapshot(graph) {
  return primitive(graph, 'snapshot', 'privilegedSnapshot')();
}

export function privilegedValidate(graph) {
  return primitive(graph, 'validate', 'privilegedValidate')();
}

export function privilegedRebuild(graph, options) {
  return primitive(graph, 'rebuild', 'privilegedRebuild')(options);
}
