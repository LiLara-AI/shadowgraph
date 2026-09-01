// Compare the tests a mutation actually broke against the tests it must break.
//
// Exits 0 and prints one markdown table row when they match exactly. Exits 1
// and explains the difference otherwise, so the harness can re-run the cell once
// (a flake elsewhere in the suite) and then fail loudly rather than publishing a
// number nobody can reproduce.
const fs = require('fs');
const path = require('path');

const [name, observedPath] = process.argv.slice(2);
if (!name || !observedPath) {
  throw new Error('usage: compare-failures.cjs <mutation> <observed-file>');
}

const expectedAll = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'expected-failures.json'), 'utf8')
);
const expected = expectedAll[name];
if (!Array.isArray(expected) || expected.length === 0) {
  console.error(`no expected failures declared for mutation ${name}`);
  process.exit(1);
}

const observed = fs.readFileSync(observedPath, 'utf8')
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean);

const expectedSet = new Set(expected);
const observedSet = new Set(observed);
const missing = expected.filter((test) => !observedSet.has(test)).sort();
const unexpected = observed.filter((test) => !expectedSet.has(test)).sort();

if (missing.length > 0) {
  console.error(`${name}: guard is no longer load-bearing for:`);
  for (const test of missing) console.error(`  - ${test}`);
}
if (unexpected.length > 0) {
  console.error(`${name}: unexpected failures (flake, or the guard covers more than declared):`);
  for (const test of unexpected) console.error(`  + ${test}`);
}
if (missing.length > 0 || unexpected.length > 0) process.exit(1);

// One row, naming the tests rather than counting them. A reader can check any
// cell by running that test against the mutation themselves.
const label = name
  .replace(/([A-Z])/gu, ' $1')
  .replace(/^./u, (character) => character.toUpperCase());
console.log(`| ${label} | ${expected.length} — ${expected.join('; ')} |`);
