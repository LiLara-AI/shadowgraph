// The privileged complete-store snapshot (plan v1.4.4 §11).
//
// INTERNAL. It is the persistence primitive -- the input to store.save,
// replaceData staging, rebuild normalisation, backup and restore validation --
// and it is deliberately not a read of the memory product: complete, unscoped,
// with no side effects. package.json "exports" does not map this file, so it
// cannot be imported by package name, and test/privileged-snapshot.test.js
// holds the list of repository modules allowed to import it by path.
//
// A graph registers its snapshot function here when createShadowGraph() builds
// it. The registry is a WeakMap, so the graph object itself carries no key,
// symbol or method that exposes the snapshot.
const snapshots = new WeakMap();

export function registerPrivilegedSnapshot(graph, snapshot) {
  snapshots.set(graph, snapshot);
  return graph;
}

export function privilegedSnapshot(graph) {
  const snapshot = graph !== null && typeof graph === 'object' ? snapshots.get(graph) : undefined;
  if (!snapshot) throw new TypeError('privilegedSnapshot requires a graph created by createShadowGraph');
  return snapshot();
}
