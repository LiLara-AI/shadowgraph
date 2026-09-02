// Remove one guard, so its absence can be measured.
//
// Every mutation asserts its anchor matches exactly once, so a mutation that
// silently stopped applying would fail loudly instead of reporting zero
// failures and looking like a guard nobody needs.
const fs = require('fs');

const MUTATIONS = {
  // Reverses the narrowing by bypassing the constant entirely, which is what
  // "removing this guard" now has to mean.
  //
  // The earlier version added keys to the object literal handed to the builder.
  // Once the call site began SELECTING fields by OUTER_REQUEST_INPUT_FIELDS,
  // that mutation became a no-op - extra keys on `available` are simply not
  // selected - so it would have reported the guard as no longer load-bearing.
  // Fail-safe, but misleading, and independent review caught the anchor break
  // before the no-op could be published. A guard that gets stronger changes what
  // removing it means, and its mutation has to move with it.
  narrowing: [
    'benchmark/lib/v11-runner.mjs',
    '      return options.buildOuterRequest(Object.fromEntries(\n'
    + '        OUTER_REQUEST_INPUT_FIELDS.map((field) => [field, available[field]])\n'
    + '      ));',
    '      return options.buildOuterRequest({\n'
    + '        ...available,\n'
    + '        namespace: structuredClone(retrievalNamespace),\n'
    + '        correlation: { ...outerCorrelation }\n'
    + '      });'
  ],
  // Drops the comparison but keeps the rebuild call, so this isolates the
  // purity property. Removing the call as well fails 3 tests rather than 1,
  // because two assertions count builder invocations - that larger number
  // measures the counting assertions, not this guard. Independent review and
  // this harness first disagreed here (1 against 3) for exactly that reason;
  // both were right about what they actually mutated.
  purity: [
    'benchmark/lib/v11-runner.mjs',
    "  if (!isDeepStrictEqual(rebuild(), request)) {\n"
    + "    throw new Error('Outer request builder is not a pure function of its input');\n  }\n",
    '  rebuild();\n'
  ],
  armIdentity: [
    'benchmark/lib/v11-runner.mjs',
    "      throw new Error('Outer request prompt must not identify the arm under measurement');",
    '      void identity;'
  ],
  resumeSeed: [
    'benchmark/lib/v11-runner.mjs',
    'systemSha256: priorBinding?.systemSha256 ?? null',
    'systemSha256: null'
  ],
  indexRebuild: [
    'benchmark/lib/v11-evidence-bundle.mjs',
    'const validated = buildEvidenceIndex({ entries: index.entries });',
    'const validated = index;'
  ],
  requiredDigest: [
    'benchmark/lib/v11-evidence-bundle.mjs',
    "  assertDigest(input.expectedDigest, 'expected bundle digest');\n",
    ''
  ],
  canonical: [
    'benchmark/lib/v11-run.mjs',
    '  if (buildOuterRequest !== buildV11Prompt) {',
    '  if (false) {'
  ],
  // Reverts the per-field typing to the permissive check that accepted either
  // a positive number or a non-empty string for every field, so a count could
  // be satisfied by prose.
  envType: [
    'benchmark/lib/v11-locks.mjs',
    "    if (ENVIRONMENT_SHAPE[field] === 'count') {\n"
    + '      return !Number.isSafeInteger(value) || value <= 0;\n    }',
    "    if (typeof value === 'number') return !Number.isFinite(value) || value <= 0;"
  ],
  // Reverts the description-field check to the version that accepted any
  // non-empty string, so "unknown" typed into every slot produced a lock.
  // Neuters the predicate itself, so this measures the property across the
  // environment, service and model builders rather than at one call site.
  placeholder: [
    'benchmark/lib/placeholder.mjs',
    '  return PLACEHOLDER_VALUES.has(normalizePlaceholder(value));',
    '  return false;'
  ],
  // Lets a service be recorded against a moving tag rather than a digest.
  serviceTag: [
    'benchmark/lib/v11-locks.mjs',
    '    if (parts.length !== 2) {',
    '    if (false) {'
  ],
  // Lets a short Ollama identifier stand in for a weights digest, which is the
  // one thing blocker B1 turns on.
  modelDigest: [
    'benchmark/lib/v11-locks.mjs',
    "    if (typeof model.weightsDigest !== 'string' || !PREFIXED_SHA256.test(model.weightsDigest)) {",
    "    if (typeof model.weightsDigest !== 'string') {"
  ],
  scoredRefusal: [
    'benchmark/lib/v11-runner.mjs',
    '  if (options.scored) {\n'
    + "    throw new Error('This candidate may not execute a scored run');\n  }\n",
    ''
  ]
};

// The harness has to back up exactly the files that can be written here. When
// it kept its own list the two drifted: it copied validate.mjs, which no
// mutation touches, implying a mutation that does not exist. A list that can
// disagree with the thing it describes is the defect this whole tool exists to
// remove, so the harness asks rather than remembers.
if (process.argv[2] === '--files') {
  const files = [...new Set(Object.values(MUTATIONS).map(([file]) => file))].sort();
  for (const file of files) console.log(file);
  process.exit(0);
}

const name = process.argv[2];
const mutation = MUTATIONS[name];
if (mutation === undefined) {
  throw new Error(`unknown mutation: ${name}. Known: ${Object.keys(MUTATIONS).join(', ')}`);
}
const [file, from, to] = mutation;
const source = fs.readFileSync(file, 'utf8');
const occurrences = source.split(from).length - 1;
if (occurrences !== 1) {
  throw new Error(`mutation ${name}: anchor matched ${occurrences} times in ${file}`);
}
fs.writeFileSync(file, source.replace(from, to));
console.log(`mutated: ${name}`);
