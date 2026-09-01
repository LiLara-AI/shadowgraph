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
  scoredRefusal: [
    'benchmark/lib/v11-runner.mjs',
    '  if (options.scored) {\n'
    + "    throw new Error('This candidate may not execute a scored run');\n  }\n",
    ''
  ]
};

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
