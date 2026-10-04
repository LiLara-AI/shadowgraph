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

// The live form (PR-37a): the store as the graph holds it with what deletion
// records withhold set apart -- the input to redaction's lookup, the Markdown
// pull and downgrade, never to a save. The snapshot above puts it back.
export function privilegedLiveSnapshot(graph) {
  return primitive(graph, 'liveSnapshot', 'privilegedLiveSnapshot')();
}

// How much deletion records withhold, by collection: counts, never ids.
export function privilegedWithheldCounts(graph) {
  return primitive(graph, 'withheldCounts', 'privilegedWithheldCounts')();
}

export function privilegedValidate(graph) {
  return primitive(graph, 'validate', 'privilegedValidate')();
}

export function privilegedRebuild(graph, options) {
  return primitive(graph, 'rebuild', 'privilegedRebuild')(options);
}

// Only the local CLI confirmation path calls the issuance primitive. These
// internal helpers are absent from package exports and the graph API.
export function privilegedIssueAccess(graph, input) {
  return primitive(graph, 'issueAccess', 'privilegedIssueAccess')(input);
}
export function privilegedAccessInspection(graph) {
  return primitive(graph, 'inspectAccess', 'privilegedAccessInspection')();
}
export function privilegedAccessRefusal(graph, input) {
  return primitive(graph, 'accessRefusal', 'privilegedAccessRefusal')(input);
}
export function privilegedBindProject(graph, input) {
  return primitive(graph, 'bindProject', 'privilegedBindProject')(input);
}
export function privilegedResolveProjectBinding(graph, input) {
  return primitive(graph, 'resolveProjectBinding', 'privilegedResolveProjectBinding')(input);
}

// The capture writer (PR-34). The capture hook (src/capture-hook.js, PR-36c)
// is its one caller, and it stays inert until capture is activated (AG-2);
// only extraction (P7) will move an item.
export function privilegedRecordCapture(graph, input) {
  return primitive(graph, 'recordCapture', 'privilegedRecordCapture')(input);
}
export function privilegedTransitionCapture(graph, input) {
  return primitive(graph, 'transitionCapture', 'privilegedTransitionCapture')(input);
}
export function privilegedClaimCapture(graph, input) {
  return primitive(graph, 'claimCapture', 'privilegedClaimCapture')(input);
}
export function privilegedCompleteExtraction(graph, input) {
  return primitive(graph, 'completeExtraction', 'privilegedCompleteExtraction')(input);
}
export function privilegedSettleExtraction(graph, input) {
  return primitive(graph, 'settleExtraction', 'privilegedSettleExtraction')(input);
}
export function privilegedExtractionStatus(graph, input) {
  return primitive(graph, 'extractionStatus', 'privilegedExtractionStatus')(input);
}
// OD-2 cleanup, reached only through fenced lifecycle writes. Never a read.
export function privilegedExpireCapture(graph, options) {
  return primitive(graph, 'expireCapture', 'privilegedExpireCapture')(options);
}

export function privilegedInspectCapture(graph, input) {
  return primitive(graph, 'inspectCapture', 'privilegedInspectCapture')(input);
}

export function privilegedCancelCapture(graph, input) {
  return primitive(graph, 'cancelCapture', 'privilegedCancelCapture')(input);
}

export function privilegedDeleteCapture(graph, input) {
  return primitive(graph, 'deleteCapture', 'privilegedDeleteCapture')(input);
}

export function privilegedCompleteCaptureDelete(graph, input) {
  return primitive(graph, 'completeCaptureDelete', 'privilegedCompleteCaptureDelete')(input);
}
// A ShadowGraph self-event (PR-35): counted on its session, never recorded.
export function privilegedRecordSelfEvent(graph, input) {
  return primitive(graph, 'recordSelfEvent', 'privilegedRecordSelfEvent')(input);
}
// The transcript cursor (PR-36): the capture hook is its one caller.
export function privilegedRecordTranscript(graph, input) {
  return primitive(graph, 'recordTranscript', 'privilegedRecordTranscript')(input);
}
// A restore's post-step and `quarantine purge` (PR-37c design §6.4): the
// restore wrapper and the quarantine verbs are its callers. It is never on the
// graph's public API.
export function privilegedReapplyDeletion(graph, plan, options) {
  return primitive(graph, 'reapplyDeletion', 'privilegedReapplyDeletion')(plan, options);
}
// The completion of a pending purge (PR-37d design §2.5, §4.3): the purge
// re-run with the record's marker id and instant, which no public purge can
// force. The restore wrapper's resolver is its one caller.
export function privilegedCompletePurge(graph, project, options) {
  return primitive(graph, 'completePurge', 'privilegedCompletePurge')(project, options);
}
// What is quarantined, by identity (PR-37c design §9.2): the owner's
// `quarantine` verbs (src/internal/quarantine.js) are its one caller, and no
// agent surface reaches it.
export function privilegedQuarantined(graph) {
  return primitive(graph, 'quarantined', 'privilegedQuarantined')();
}
