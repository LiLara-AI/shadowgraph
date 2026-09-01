#!/bin/bash
# Measure every guard by removing it and counting failures against the FULL
# repository suite. Emits a markdown table and a JSON line.
#
# This exists because three consecutive review rounds caught a wrong number in a
# hand-written table. By the third round the methodology was right and the
# transcription still was not, so the numbers that reach the documentation now
# come from here.
#
# Backups go in a directory from mktemp rather than a literal path: a hardcoded
# one is wrong on some platforms, and the packaged-text policy refuses absolute
# POSIX temp paths in shipped files.
set -u
cd "$(dirname "$0")/.." || exit 1

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

RUNNER=benchmark/lib/v11-runner.mjs
BUNDLE=benchmark/lib/v11-evidence-bundle.mjs
RUN=benchmark/lib/v11-run.mjs

cp "$RUNNER" "$WORK/runner"; cp "$BUNDLE" "$WORK/bundle"; cp "$RUN" "$WORK/run"
restore() {
  cp "$WORK/runner" "$RUNNER"
  cp "$WORK/bundle" "$BUNDLE"
  cp "$WORK/run" "$RUN"
}

fails() {
  npm test 2>&1 | grep -E '^# fail |^. fail ' | head -1 | grep -oE '[0-9]+$'
}

declare -a NAMES=()
declare -a COUNTS=()

measure() {
  NAMES+=("$1")
  COUNTS+=("$(fails)")
  restore
}

echo "measuring baseline..."
BASELINE="$(fails)"
echo "baseline failures: $BASELINE"

node scripts/mutate.cjs narrowing      && measure "Builder input narrowing"
node scripts/mutate.cjs purity         && measure "Purity rebuild"
node scripts/mutate.cjs armIdentity    && measure "Arm-identity check"
node scripts/mutate.cjs resumeSeed     && measure "Resume binding seeding"
node scripts/mutate.cjs indexRebuild   && measure "Bundle index rebuild"
node scripts/mutate.cjs requiredDigest && measure "Required expectedDigest"
node scripts/mutate.cjs canonical      && measure "Canonical builder identity"

restore
FINAL="$(fails)"

# A mutation whose anchor stopped matching would otherwise report zero failures
# and read as a guard nobody needs.
if [ "${#NAMES[@]}" -ne 7 ]; then
  echo "ERROR: expected 7 measurements, got ${#NAMES[@]} - a mutation failed to apply" >&2
  exit 1
fi
if [ "$BASELINE" != "0" ] || [ "$FINAL" != "0" ]; then
  echo "ERROR: baseline=$BASELINE final=$FINAL - the tree was not clean before or after" >&2
  exit 1
fi

echo
echo "| Guard removed | Tests that fail |"
echo "| --- | --- |"
for i in "${!NAMES[@]}"; do
  echo "| ${NAMES[$i]} | ${COUNTS[$i]} |"
done
echo
printf 'JSON {"baseline":%s,"final":%s' "$BASELINE" "$FINAL"
for i in "${!NAMES[@]}"; do
  printf ',"%s":%s' "${NAMES[$i]}" "${COUNTS[$i]}"
done
printf '}\n'
git status --porcelain
