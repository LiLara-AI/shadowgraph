#!/bin/bash
# Measure every guard by removing it and recording WHICH tests break.
#
# The first version published how many tests failed. Independent review ran it
# twice at the same commit and got two different tables, a different cell wrong
# each time: a flake anywhere in the 2043-test suite is attributed to whichever
# guard happens to be mutated at that moment, and the baseline/final checks
# cannot catch it because the flake only shows up mid-table. It had removed
# transcription error and replaced it with attribution error - the same class of
# mistake, one level up.
#
# A cell is now a set of test names compared against tools/expected-failures.json.
# An unexpected extra failure is treated as a flake and the cell is re-run once;
# a missing expected failure is a guard that stopped being load-bearing. Either
# way it is named rather than folded into a number.
#
# Backups go in a directory from mktemp rather than a literal path: a hardcoded
# one is wrong on some platforms, and the packaged-text policy refuses absolute
# POSIX temp paths in files the package ships. This tool lives under tools/
# rather than scripts/ precisely so it is not one of them - `files` carries
# `scripts/`, and a tool whose whole job is rewriting benchmark/lib in place has
# no business in a distributable.
set -u
cd "$(dirname "$0")/.." || exit 1

WORK="$(mktemp -d)"

RUNNER=benchmark/lib/v11-runner.mjs
BUNDLE=benchmark/lib/v11-evidence-bundle.mjs
RUN=benchmark/lib/v11-run.mjs
VALIDATE=benchmark/lib/validate.mjs

cp "$RUNNER" "$WORK/runner"
cp "$BUNDLE" "$WORK/bundle"
cp "$RUN" "$WORK/run"
cp "$VALIDATE" "$WORK/validate"

restore() {
  cp "$WORK/runner" "$RUNNER"
  cp "$WORK/bundle" "$BUNDLE"
  cp "$WORK/run" "$RUN"
  cp "$WORK/validate" "$VALIDATE"
}

# Restore BEFORE discarding the backups, and on interrupt as well as exit. The
# first version trapped EXIT only and deleted the backups without restoring, so
# a Ctrl-C during any of the long test runs left mutated source behind and
# destroyed the copy that would have fixed it.
cleanup() {
  restore
  rm -rf "$WORK"
}
trap cleanup EXIT INT TERM

failing_names() {
  npm test 2>&1 | sed -n 's/^\xe2\x9c\x96 \(.*\) ([0-9.]*ms)$/\1/p' | sort -u
}

MUTATIONS="narrowing purity armIdentity resumeSeed indexRebuild requiredDigest canonical scoredRefusal"

echo "measuring baseline..."
failing_names > "$WORK/baseline"
if [ -s "$WORK/baseline" ]; then
  echo "ERROR: the tree is not green before measuring:" >&2
  cat "$WORK/baseline" >&2
  exit 1
fi
echo "baseline: green"

RESULTS="$WORK/results"
: > "$RESULTS"
STATUS=0

for name in $MUTATIONS; do
  attempt=1
  while : ; do
    if ! node tools/mutate.cjs "$name" >/dev/null; then
      echo "ERROR: mutation $name failed to apply" >&2
      STATUS=1
      break
    fi
    failing_names > "$WORK/observed"
    restore
    if node tools/compare-failures.cjs "$name" "$WORK/observed" >> "$RESULTS" 2>"$WORK/err"; then
      break
    fi
    cat "$WORK/err" >&2
    if [ "$attempt" -eq 1 ]; then
      echo "  $name: mismatch, re-running once in case it was a flake" >&2
      attempt=2
      continue
    fi
    echo "ERROR: $name did not match its expected failures twice running" >&2
    STATUS=1
    break
  done
done

restore
failing_names > "$WORK/final"
if [ -s "$WORK/final" ]; then
  echo "ERROR: the tree is not green after measuring:" >&2
  cat "$WORK/final" >&2
  STATUS=1
fi

echo
echo "| Guard removed | Tests that fail |"
echo "| --- | --- |"
cat "$RESULTS"
echo
git status --porcelain
exit "$STATUS"
