// The two-axis classification register of the default context path (plan
// v1.4.4 §13.4; AC-060; PC-01(a)/(b), PC-17). Every field reachable on the
// default discovery/context path -- nested fields, schema descriptions,
// collection names, transport wrappers, and the MCP server instructions and
// prompts -- carries a class on the content axis, the metadata axis, or both.
// Only recommendation/advice leaves the default channel; PR-19 rewords or
// removes what is classified so here. A fact inside an advice-classed text
// survives the rewording: the prompt's disclosure that nothing can be marked
// verified without a configured verifier, the instructions' description of the
// server, and the below-threshold confidence behind suggestedQuestions.
//
// Paths: `a.b` for object keys, `a[]` for array items, `a#description` for a
// schema description, and a `transport:` prefix for wrapper members. Patterns:
// `*` matches within one segment, a trailing `.**` matches a node and all of
// its descendants (array items included), and a leading `**.` matches at any
// depth; no wildcard reaches into a `#description` suffix. The first matching
// entry classifies a path, so specific entries come before general ones, and
// caller-supplied values come before the rules for fields every stored record
// shares, so a key inside a caller's value is never read as ShadowGraph
// metadata.
//
// Stored records pass through fields this build neither writes nor reads: the
// keys of a legacy or newer writer, kept verbatim on import. Those are open-ended,
// so each record collection ends in a pass-through entry. Records this build
// writes never reach one: the test fails if they do, so a new field this build
// adds must be registered explicitly.
//
// test/default-path-register.test.js enumerates the paths and fails on any
// path this register does not classify. Run it with
// SHADOWGRAPH_AC060_TABLE=<file> to write the classification table.

export const CONTENT_CLASSES = Object.freeze([
  'historical fact', 'observed experience', 'extracted statement', 'inferred explanation',
  'relationship', 'changed condition', 'current state', 'recommendation/advice'
]);
export const METADATA_CLASSES = Object.freeze(['evidence', 'completeness', 'provenance', 'verification state', 'scope']);
// VAR-04: API routing keys, the notice's keys and transport-wrapper members fit
// neither axis. They carry this recorded variance class, which covers keys and
// identifiers only; every prose value still takes a content class.
export const VARIANCE_METADATA_CLASSES = Object.freeze(['interface']);
export const ADVICE = 'recommendation/advice';

// Key names whose plain-English function is an instruction (E03 §2). The data
// under them is classified on its own; the name itself is advice.
export const ADVISORY_NAMES = Object.freeze(['failedAttemptsToAvoid', 'alternativesToReconsider', 'openReviews', 'suggestedQuestions']);

// Tripwires for ShadowGraph-generated prose that is not classified as advice,
// and for key names. Recorded caller text is quoted history and is not read.
export const ADVICE_LEXICON = Object.freeze([
  /\bshould\b/i, /\bworth\b/i, /\brecommend/i, /\bto avoid\b/i, /\blook at again\b/i, /\bdue for\b/i,
  /\bto reconsider\b/i, /\bactionable\b/i, /^pass this\b/i, /\bbefore (?:a )?consequential\b/i, /\bbefore continuing\b/i
]);
export const ADVICE_NAME_WORDS = Object.freeze(['should', 'worth', 'recommend', 'recommended', 'avoid', 'suggest', 'suggested', 'reconsider']);

const entry = (pattern, content, metadata, options = {}) => Object.freeze({ pattern, content: content ?? null, metadata: metadata ?? null, generated: false, passThrough: false, ...options });
const c = (pattern, content, options) => entry(pattern, content, null, options);
const m = (pattern, metadata, options) => entry(pattern, null, metadata, options);
// ShadowGraph writes this prose, so the advice tripwire reads it.
const G = { generated: true };
const modernWrapper = (prefix, members) => members.map((member) => m(`${prefix}${member}`, 'interface'));
// A field of a stored record kept verbatim from an import.
const passThrough = (collection) => c(`${collection}[].*.**`, 'historical fact', { passThrough: true });

// The caller's own values inside an evaluated condition: recorded, not ours.
const conditionValues = (base) => [
  c(`${base}[].expected.**`, 'historical fact'),
  c(`${base}[].observed.**`, 'historical fact'),
  c(`${base}[].evidence.value.**`, 'historical fact'),
  c(`${base}[].conflictingEvidence[].value.**`, 'historical fact')
];
// A condition evaluated against facts: reopenWhen on openReviews and
// conditionDiagnostics, reusableWhen on reusableAttempts.
const conditionEntries = (base, verdict) => [
  m(base, 'evidence'),
  c(`${base}[].decisionId`, 'relationship'),
  c(`${base}[].attemptId`, 'relationship'),
  c(`${base}[].alternativeId`, 'relationship'),
  c(`${base}[].alternativeLabel`, 'historical fact'),
  c(`${base}[].key`, 'historical fact'),
  c(`${base}[].operator`, 'historical fact'),
  c(`${base}[].unit`, 'historical fact'),
  c(`${base}[].verdict`, verdict),
  entry(`${base}[].reason`, 'inferred explanation', 'evidence', G),
  m(`${base}[].evidence.**`, 'evidence'),
  m(`${base}[].conflictingEvidence.**`, 'evidence')
];

export const REGISTER = Object.freeze([
  // --- advice: E03 §2, and what the register and PR-18 review surfaced ------
  c('suggestedQuestions', ADVICE),
  c('suggestedQuestions[]', ADVICE, G),
  c('suggestedQuestions#description', ADVICE, G),
  c('activeDecisions#description', ADVICE, G),
  c('openReviews#description', ADVICE, G),
  c('openReviews[]#description', ADVICE, G),
  c('openReviews[].decisionId#description', ADVICE, G),
  c('openReviews[].alternativesToReconsider#description', ADVICE, G),
  c('openReviews[].reviewSignalId#description', ADVICE, G),
  c('reusableAttempts#description', ADVICE, G),
  c('reusableAttempts[]#description', ADVICE, G),
  c('failedAttemptsToAvoid[].reusableWhen#description', ADVICE, G),
  c('discover:instructions', ADVICE, G),
  c('prompt-list:prompts[].description', ADVICE, G),
  c('prompt:messages[].content.text', ADVICE, G),

  // --- every other description is prose about the interface ------------------
  c('**#description', 'current state', G),

  // --- caller values, before any rule for shared record fields --------------
  c('staleAssumptions[].value.**', 'historical fact'),
  c('activeDecisions[].alternatives[].reopenWhen[].value.**', 'historical fact'),
  c('failedAttemptsToAvoid[].reusableWhen[].value.**', 'historical fact'),
  ...conditionValues('openReviews[].violatedConditions'),
  ...conditionValues('conditionDiagnostics[].conditions'),
  ...conditionValues('reusableAttempts[].satisfiedConditions'),

  // --- transports (VAR-04: wrapper members are interface) -------------------
  m('tool:name', 'interface'),
  c('tool:description', 'current state', G),
  m('tool:annotations.**', 'interface'),
  m('tool:inputSchema.**', 'interface'),
  m('tool:outputSchema', 'interface'),
  m('mcp:content.**', 'interface'),
  m('mcp:structuredContent', 'interface'),
  m('resource:contents.**', 'interface'),
  m('resource-list:resources[].uri', 'interface'),
  m('resource-list:resources[].name', 'interface'),
  m('resource-list:resources[].mimeType', 'interface'),
  c('resource-list:resources[].description', 'current state', G),
  m('resource-list:resources', 'interface'),
  m('initialize:protocolVersion', 'interface'),
  m('initialize:capabilities.**', 'interface'),
  m('initialize:serverInfo.**', 'interface'),
  m('discover:supportedVersions.**', 'interface'),
  m('discover:capabilities.**', 'interface'),
  // The 2026-07-28 result members each method adds around its payload.
  ...modernWrapper('discover:', ['resultType', 'ttlMs', 'cacheScope', '_meta.**']),
  ...modernWrapper('tool-list:', ['resultType', 'ttlMs', 'cacheScope', '_meta.**']),
  ...modernWrapper('mcp:', ['resultType', 'isError', '_meta.**']),
  ...modernWrapper('resource:', ['resultType', 'ttlMs', 'cacheScope', '_meta.**']),
  ...modernWrapper('resource-list:', ['resultType', 'ttlMs', 'cacheScope', '_meta.**']),
  ...modernWrapper('prompt-list:', ['resultType', 'ttlMs', 'cacheScope', '_meta.**']),
  ...modernWrapper('prompt:', ['resultType', '_meta.**']),
  m('prompt-list:prompts', 'interface'),
  m('prompt-list:prompts[].name', 'interface'),
  m('prompt-list:prompts[].arguments.**', 'interface'),
  c('prompt:description', 'current state', G),
  m('prompt:messages', 'interface'),
  m('prompt:messages[].role', 'interface'),
  m('prompt:messages[].content', 'interface'),
  m('prompt:messages[].content.type', 'interface'),
  m('http:body', 'interface'),
  m('cli:stdout', 'interface'),

  // --- fields with the same meaning in every stored record ------------------
  m('**.verificationStatus', 'verification state'),
  m('**.legacyVerificationStatus', 'verification state'),
  m('**.verificationUntrustedReason', 'verification state'),
  m('**.sourceClass', 'provenance'),
  m('**.sourceRaw', 'provenance'),
  m('**.actor', 'provenance'),
  m('**.client', 'provenance'),
  m('**.sessionId', 'provenance'),
  m('**.schemaVersion', 'provenance'),
  m('**.createdAt', 'provenance'),
  m('**.updatedAt', 'provenance'),
  m('**.migration.**', 'provenance'),
  m('**.attribution', 'scope'),
  m('**.originId', 'scope'),

  // --- the resolved project and the declared notice -------------------------
  m('project', 'scope'),
  m('notice', 'interface'),
  m('notice.code', 'interface'),
  m('notice.replacement.**', 'interface'),
  c('notice.detail', 'current state', G),

  // --- read provenance and completeness (metadata axis) ---------------------
  m('readProvenance.scope.**', 'scope'),
  m('readProvenance.request.**', 'scope'),
  m('readProvenance.**', 'provenance'),
  m('completeness.scope.**', 'scope'),
  entry('completeness.limitation.detail', 'current state', 'completeness', G),
  m('completeness.**', 'completeness'),

  // --- activeDecisions: stored decisions in force ---------------------------
  c('activeDecisions', 'current state'),
  m('activeDecisions[].id', 'provenance'),
  m('activeDecisions[].kind', 'provenance'),
  m('activeDecisions[].project', 'scope'),
  c('activeDecisions[].title', 'historical fact'),
  c('activeDecisions[].goal', 'historical fact'),
  c('activeDecisions[].chosen', 'historical fact'),
  c('activeDecisions[].assumptions.**', 'historical fact'),
  c('activeDecisions[].status', 'current state'),
  c('activeDecisions[].reviewAfter', 'historical fact'),
  c('activeDecisions[].failedAttempts.**', 'observed experience'),
  c('activeDecisions[].supersedes.**', 'relationship'),
  c('activeDecisions[].supersededBy', 'relationship'),
  c('activeDecisions[].outcome.**', 'observed experience'),
  // A confidence move's reason is generated for an outcome ("Outcome: failed")
  // and caller text for an evidence contribution. Being mixed, it is not marked
  // generated, so the advice wording check does not read it: a known limit.
  entry('activeDecisions[].confidence.history[].reason', 'inferred explanation', 'evidence'),
  entry('activeDecisions[].confidence.basis.contributions[].reason', 'inferred explanation', 'evidence'),
  m('activeDecisions[].confidence.**', 'evidence'),
  entry('activeDecisions[].evidence[].detail', 'historical fact', 'evidence'),
  m('activeDecisions[].evidence.**', 'evidence'),
  m('activeDecisions[].alternatives[].id', 'provenance'),
  c('activeDecisions[].alternatives[].status', 'current state'),
  c('activeDecisions[].alternatives[].label', 'historical fact'),
  c('activeDecisions[].alternatives[].reasonRejected', 'historical fact'),
  c('activeDecisions[].alternatives[].reopenWhen.**', 'historical fact'),
  c('activeDecisions[].alternatives', 'historical fact'),
  passThrough('activeDecisions'),

  // --- staleAssumptions: facts no longer active -----------------------------
  c('staleAssumptions', 'changed condition'),
  m('staleAssumptions[].id', 'provenance'),
  m('staleAssumptions[].kind', 'provenance'),
  m('staleAssumptions[].project', 'scope'),
  m('staleAssumptions[].source', 'provenance'),
  m('staleAssumptions[].observedAt', 'provenance'),
  m('staleAssumptions[].confidence', 'evidence'),
  m('staleAssumptions[].validityPolicy.**', 'provenance'),
  m('staleAssumptions[].verification.**', 'verification state'),
  c('staleAssumptions[].status', 'current state'),
  c('staleAssumptions[].supersededBy', 'relationship'),
  c('staleAssumptions[].key', 'historical fact'),
  c('staleAssumptions[].expiresAt', 'historical fact'),
  c('staleAssumptions[].validTo', 'historical fact'),
  c('staleAssumptions[].temporal.**', 'historical fact'),
  passThrough('staleAssumptions'),

  // --- failedAttemptsToAvoid: recorded failed attempts (advisory name) ------
  c('failedAttemptsToAvoid', 'observed experience'),
  m('failedAttemptsToAvoid[].id', 'provenance'),
  m('failedAttemptsToAvoid[].kind', 'provenance'),
  m('failedAttemptsToAvoid[].project', 'scope'),
  c('failedAttemptsToAvoid[].solution', 'observed experience'),
  c('failedAttemptsToAvoid[].result', 'observed experience'),
  c('failedAttemptsToAvoid[].resultClass', 'observed experience'),
  c('failedAttemptsToAvoid[].reason', 'observed experience'),
  c('failedAttemptsToAvoid[].environment', 'observed experience'),
  c('failedAttemptsToAvoid[].relatedTo.**', 'relationship'),
  c('failedAttemptsToAvoid[].reusableWhen.**', 'historical fact'),
  passThrough('failedAttemptsToAvoid'),

  // --- openReviews: recorded review conditions that fired (advisory name) ---
  c('openReviews', 'changed condition'),
  c('openReviews[].decisionId', 'relationship'),
  c('openReviews[].title', 'historical fact'),
  c('openReviews[].reason', 'changed condition', G),
  c('openReviews[].alternativesToReconsider.**', 'historical fact'),
  m('openReviews[].reviewSignalId', 'provenance'),
  c('openReviews[].reviewSignalStatus', 'current state'),
  ...conditionEntries('openReviews[].violatedConditions', 'changed condition'),

  // --- conditionDiagnostics: conditions that could not be settled -----------
  entry('conditionDiagnostics', 'current state', 'evidence'),
  c('conditionDiagnostics[].decisionId', 'relationship'),
  c('conditionDiagnostics[].attemptId', 'relationship'),
  c('conditionDiagnostics[].title', 'historical fact'),
  // unknown or contested: the evaluation's present state, not a change.
  ...conditionEntries('conditionDiagnostics[].conditions', 'current state'),

  // --- reusableAttempts: recorded preconditions that now hold ---------------
  c('reusableAttempts', 'changed condition'),
  c('reusableAttempts[].attemptId', 'relationship'),
  c('reusableAttempts[].solution', 'observed experience'),
  c('reusableAttempts[].resultClass', 'observed experience'),
  ...conditionEntries('reusableAttempts[].satisfiedConditions', 'changed condition')
]);

const escape = (text) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
function compile(pattern) {
  const [path, suffix] = pattern.split('#');
  let body;
  if (path === '**') body = '[^#]*';
  else {
    let lead = '', tail = '', core = path;
    if (core.startsWith('**.')) { lead = '(?:[^#]*\\.)?'; core = core.slice(3); }
    if (core.endsWith('.**')) { tail = '(?:(?:\\.|\\[\\])[^#]*)?'; core = core.slice(0, -3); }
    body = lead + core.split('*').map(escape).join('[^.#]*') + tail;
  }
  return new RegExp(`^${body}${suffix === undefined ? '' : `#${escape(suffix)}`}$`, 'u');
}
const COMPILED = REGISTER.map((item) => ({ ...item, regex: compile(item.pattern) }));

// The first register entry that classifies a path, or null.
export function classify(path) {
  return COMPILED.find((item) => item.regex.test(path)) ?? null;
}

const record = (found, source, path, prose) => {
  if (!found.has(path)) found.set(path, { sources: new Set([source]), prose: new Set() });
  if (typeof prose === 'string') found.get(path).prose.add(prose);
};

// Paths of an output schema: each property, primitive array items, and every
// description as its own path.
export function schemaPaths(schema, prefix = '', source = 'schema') {
  const found = new Map();
  const walk = (node, path) => {
    if (!node || typeof node !== 'object') return;
    if (typeof node.description === 'string') record(found, source, `${path}#description`, node.description);
    for (const [name, child] of Object.entries(node.properties ?? {})) {
      const next = path === prefix ? `${prefix}${name}` : `${path}.${name}`;
      record(found, source, next);
      walk(child, next);
    }
    if (node.items && typeof node.items === 'object') {
      if (!node.items.properties) record(found, source, `${path}[]`);
      walk(node.items, `${path}[]`);
    }
    for (const branch of [...(node.anyOf ?? []), ...(node.oneOf ?? [])]) walk(branch, path);
  };
  walk(schema, prefix);
  return found;
}

// Paths of a runtime value: object keys, array items, and the string values
// seen at each path, so prose can be read.
export function valuePaths(value, prefix = '', source = 'runtime') {
  const found = new Map();
  const walk = (node, path) => {
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item === null || typeof item !== 'object') record(found, source, `${path}[]`, item);
        walk(item, `${path}[]`);
      }
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [name, child] of Object.entries(node)) {
      const next = path === prefix ? `${prefix}${name}` : `${path}.${name}`;
      record(found, source, next, child);
      walk(child, next);
    }
  };
  walk(value, prefix);
  return found;
}

export function mergePaths(...maps) {
  const merged = new Map();
  for (const map of maps) {
    for (const [path, { sources, prose }] of map) {
      if (!merged.has(path)) merged.set(path, { sources: new Set(), prose: new Set() });
      for (const source of sources) merged.get(path).sources.add(source);
      for (const text of prose) merged.get(path).prose.add(text);
    }
  }
  return merged;
}

const keyNames = (path) => path.split('#')[0].replace(/^[a-z-]+:/, '').split('.').map((segment) => segment.replace(/\[\]$/, '')).filter(Boolean);
// The key names on a path that are themselves advice.
export const advisoryNamesIn = (path) => keyNames(path).filter((name) => ADVISORY_NAMES.includes(name));
// Key names whose words read as an instruction.
export const adviceWordsInNames = (path) => keyNames(path).filter((name) =>
  name.split(/(?=[A-Z])|_/).map((word) => word.toLowerCase()).some((word) => ADVICE_NAME_WORDS.includes(word)));

// Prose is more than an identifier: several words or sentence punctuation.
export const isProse = (text) => text.trim().split(/\s+/).length > 3 || /[.;:,!?]\s/.test(text);

// The AC-060 two-axis table, one row per path.
export function classificationTable(paths) {
  const rows = [...paths.keys()].sort().map((path) => {
    const found = classify(path);
    const names = advisoryNamesIn(path);
    return `| \`${path}\` | ${found?.content ?? ''} | ${found?.metadata ?? ''} | ${names.length ? `${ADVICE} (name: ${names.join(', ')})` : ''} | ${[...paths.get(path).sources].sort().join(', ')} | \`${found?.pattern ?? 'UNCLASSIFIED'}\`${found?.passThrough ? ' (pass-through)' : ''} |`;
  });
  return ['| Path | Content axis | Metadata axis | Name axis | Seen in | Register entry |', '|---|---|---|---|---|---|', ...rows].join('\n');
}
