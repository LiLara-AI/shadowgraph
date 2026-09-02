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

# Every check below refuses to read an empty or absent result as a healthy one.
# That single mistake has now appeared four times in this file's history: a
# truncated log read as a green baseline, a missing summary read as no failures,
# git unavailable read as a clean tree, and git failing mid-run read as an
# unchanged tree. Each was fixed in isolation; this pass treats the class.
WORK="$(mktemp -d)" || { echo "ERROR: could not create a working directory" >&2; exit 1; }

# Logs of runs that failed or timed out, kept so the next question is
# answerable. Deliberately outside WORK, which the cleanup trap deletes; it is
# removed on the way out only if nothing was written to it.
DIAGNOSTICS="$(mktemp -d)" || { echo "ERROR: could not create a diagnostics directory" >&2; rm -rf "$WORK"; exit 1; }
trap 'rm -rf "$WORK"; rmdir "$DIAGNOSTICS" 2>/dev/null' EXIT

# What the tree looked like before anything was mutated. Comparing the whole
# porcelain listing to this at the end is the only check here that is a superset
# of both earlier ones: the first grepped a hardcoded `benchmark/lib/`, the
# second compared only the four files mutate.cjs writes, and a suite that
# created or modified anything else walked past both. Independent review
# demonstrated exactly that, twice.
# Note the limits, so the check is not read as broader than it is: porcelain
# collapses an untracked directory to one line whatever appears inside it, and
# says nothing about ignored files. Both were equally true of the checks this
# replaced.
if ! BASELINE_DIRT="$(git status --porcelain)"; then
  echo "ERROR: git status failed, so the tree cannot be compared before and after" >&2
  echo "       this harness rewrites source in place; it will not run unverified" >&2
  exit 1
fi

# Back up exactly what mutate.cjs can write, by asking it. The hardcoded list
# this replaced had drifted: it copied validate.mjs, which no mutation touches,
# implying a mutation that does not exist, while nothing checked that every
# mutated file was actually covered.
mapfile -t MUTABLE_FILES < <(node tools/mutate.cjs --files)
if [ "${#MUTABLE_FILES[@]}" -eq 0 ]; then
  echo "ERROR: mutate.cjs listed no mutable files" >&2
  exit 1
fi

# Backups live in their own directory. A flat $WORK shares a namespace with
# baseline, results, observed, measured, declared and the logs, and a key that
# collided with one of those would be overwritten silently - after which restore
# writes the wrong bytes and the byte check compares the file against the same
# wrong key and passes, unable to see its own collision.
BACKUP="$WORK/backup"
mkdir -p "$BACKUP" || exit 1
backup_key() { echo "$1" | tr '/' '_'; }

for file in "${MUTABLE_FILES[@]}"; do
  cp "$file" "$BACKUP/$(backup_key "$file")" || exit 1
done

# Restore only what actually differs.
#
# `cp` truncates its destination before writing, so copying over a file that is
# already byte-identical to its backup is pure downside: a failure there destroys
# content that was already correct. That is not hypothetical - the EXIT trap runs
# a restore after the byte check has already established identity, so the only
# way that pass could ever change anything was to damage it, and it ran too late
# for its own error status to reach the exit code. Independent review executed it:
# four guard sources truncated to zero bytes, an eleven-row table published with
# no banner, exit 0, and the backups deleted immediately afterwards.
restore() {
  local failed=0 file key
  for file in "${MUTABLE_FILES[@]}"; do
    key="$BACKUP/$(backup_key "$file")"
    cmp -s "$file" "$key" && continue
    cp "$key" "$file" || { echo "ERROR: could not restore $file" >&2; failed=1; }
  done
  return "$failed"
}

# The pid of the suite currently running, so a signal can reach it. GNU timeout
# puts the suite in its own process group, which is what lets it kill npm's node
# children - but that also removes them from the terminal's foreground group, so
# Ctrl-C stops reaching them. Adding the timeout had therefore silently broken
# the restore-on-interrupt that was verified before it existed: the trap would
# not run until the suite ended on its own, up to RUN_TIMEOUT_SECONDS later, and
# an operator who escalated in that window left mutated source behind.
# Independent review caught it.
SUITE_PID=""

stop_suite() {
  [ -n "$SUITE_PID" ] || return 0
  kill -KILL "-$SUITE_PID" 2>/dev/null
  kill -KILL "$SUITE_PID" 2>/dev/null
  SUITE_PID=""
}

# Restore BEFORE discarding the backups, and on interrupt as well as exit. The
# first version trapped EXIT only and deleted the backups without restoring, so
# a Ctrl-C during any of the long test runs left mutated source behind and
# destroyed the copy that would have fixed it.
# Runs once. on_signal cleans up and then exits, which fires the EXIT trap and
# would clean up a second time - restoring from backups the first pass had just
# deleted, and printing "could not restore" for files it had in fact restored.
# A teardown that reports failure on success is worse than one that says
# nothing, and this one guards the very property it exists to guarantee.
CLEANED=0
cleanup() {
  [ "$CLEANED" -eq 1 ] && return 0
  CLEANED=1
  stop_suite
  if ! restore; then
    # Keep the backups: they are the only copies, and the message that tells the
    # operator to use them used to be followed by their deletion. Exit non-zero
    # from the trap, because by this point the script's own status is settled.
    echo "ERROR: the tree may still be mutated; backups kept in $BACKUP" >&2
    rmdir "$DIAGNOSTICS" 2>/dev/null
    exit 1
  fi
  rm -rf "$WORK"
  rmdir "$DIAGNOSTICS" 2>/dev/null
}

on_signal() {
  # Ignore further interrupts while cleaning up. The CLEANED guard stops
  # cleanup running twice, but it also meant a second Ctrl-C landing during
  # restore() re-entered here, took the guard's early return, and exited with
  # the tree still mutated - the guard against one failure opening another.
  trap '' INT TERM
  echo "" >&2
  echo "interrupted - stopping the suite and restoring mutated sources" >&2
  cleanup
  exit 130
}

trap cleanup EXIT
trap on_signal INT TERM

# How long one npm test may take before it is declared hung. A healthy run is
# about 90 seconds, so this is roughly six times headroom. It exists because a
# leaked handle does not fail - it waits, silently, forever: a meter left open by
# a failed assertion kept one run parked for over an hour at near-zero CPU with
# nothing on stdout, and the harness waited with it.
RUN_TIMEOUT_SECONDS="${RUN_TIMEOUT_SECONDS:-600}"

# Run the suite into a log with a hard bound. GNU timeout puts the child in its
# own process group and signals the group, so npm's node children die with it
# rather than surviving to hold the port.
# Returns: 0 completed, 124 timed out, other = npm's own failure.
run_suite() {
  timeout --signal=KILL --kill-after=15 "$RUN_TIMEOUT_SECONDS" npm test > "$1" 2>&1 &
  SUITE_PID=$!
  wait "$SUITE_PID"
  local code=$?
  SUITE_PID=""
  return "$code"
}

# A finished run prints a summary line. Matching it with `^.` was wrong: the
# reporter prefixes that line with U+2139, three UTF-8 bytes, so the pattern
# matched only in a UTF-8 locale and failed under LC_ALL=C - reporting a run
# that completed as one that died. `[^ ]*` matches those bytes in either
# locale. It fails closed, but with the wrong diagnosis, which is its own kind
# of wrong answer. Independent review found it.
has_summary() {
  grep -qE '^[^ ]+ tests [0-9][0-9]*$' "$1"
}

names_from_log() {
  sed -n 's/^\xe2\x9c\x96 \(.*\) ([0-9.]*ms)$/\1/p' "$1" | sort -u
}

# Every guard with a declared expectation. A name missing from this list is a
# guard nobody measures, so the row count is asserted against the declaration
# file below rather than against a number written here.
MUTATIONS="narrowing purity armIdentity resumeSeed indexRebuild requiredDigest canonical scoredRefusal envType serviceTag modelDigest"

TOTAL="$(printf '%s\n' $MUTATIONS | wc -l)"
echo "measuring baseline (timeout ${RUN_TIMEOUT_SECONDS}s per run, $TOTAL guards)..." >&2
run_suite "$WORK/baseline.log"
code=$?
if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
  cp "$WORK/baseline.log" "$DIAGNOSTICS/baseline.log" 2>/dev/null
  echo "ERROR: the baseline run timed out after ${RUN_TIMEOUT_SECONDS}s" >&2
  echo "       a run that did not finish is not a green baseline" >&2
  echo "       log: $DIAGNOSTICS/baseline.log" >&2
  exit 1
fi

# A finished run prints a summary. Its absence means the run died some other
# way, and an empty failure list from a log that has no summary is silence, not
# success.
if ! has_summary "$WORK/baseline.log"; then
  cp "$WORK/baseline.log" "$DIAGNOSTICS/baseline.log" 2>/dev/null
  echo "ERROR: the baseline run produced no test summary (exit $code)" >&2
  echo "       log: $DIAGNOSTICS/baseline.log" >&2
  exit 1
fi

names_from_log "$WORK/baseline.log" > "$WORK/baseline"
if [ -s "$WORK/baseline" ]; then
  echo "ERROR: the tree is not green before measuring:" >&2
  cat "$WORK/baseline" >&2
  cp "$WORK/baseline.log" "$DIAGNOSTICS/baseline.log" 2>/dev/null
  echo "log: $DIAGNOSTICS/baseline.log" >&2
  exit 1
fi
echo "baseline: green" >&2

RESULTS="$WORK/results"
: > "$RESULTS"
STATUS=0

INDEX=0
TIMED_OUT=""
for name in $MUTATIONS; do
  INDEX=$((INDEX + 1))
  attempt=1
  while : ; do
    printf '[%2d/%2d] %-16s attempt %d ... ' "$INDEX" "$TOTAL" "$name" "$attempt" >&2
    if ! node tools/mutate.cjs "$name" >/dev/null; then
      echo "ANCHOR FAILED" >&2
      echo "ERROR: mutation $name failed to apply" >&2
      STATUS=1
      break
    fi
    STARTED="$SECONDS"
    run_suite "$WORK/run.log"
    code=$?
    restore || STATUS=1
    ELAPSED=$((SECONDS - STARTED))

    # A timeout is not a measurement and must never be mistaken for one. It is
    # recorded as its own kind of row, the log is kept, and the harness stops:
    # a hung suite usually means a leaked handle, and the remaining ten runs
    # would each wait the full timeout before saying so.
    if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
      echo "TIMED OUT after ${ELAPSED}s" >&2
      cp "$WORK/run.log" "$DIAGNOSTICS/$name.timeout.log" 2>/dev/null
      printf '| %s | **TIMED OUT** after %ss — not a measurement; log: %s |\n' \
        "$name" "$ELAPSED" "$DIAGNOSTICS/$name.timeout.log" >> "$RESULTS"
      echo "ERROR: $name timed out; the suite did not finish, so this guard is unmeasured" >&2
      echo "       log retained at $DIAGNOSTICS/$name.timeout.log" >&2
      STATUS=1
      TIMED_OUT="$name"
      break
    fi

    if ! has_summary "$WORK/run.log"; then
      echo "NO SUMMARY (${ELAPSED}s)" >&2
      cp "$WORK/run.log" "$DIAGNOSTICS/$name.nosummary.log" 2>/dev/null
      printf '| %s | **NO SUMMARY** — the run died without reporting; log: %s |\n' \
        "$name" "$DIAGNOSTICS/$name.nosummary.log" >> "$RESULTS"
      echo "ERROR: $name produced no test summary, so it is unmeasured" >&2
      STATUS=1
      break
    fi
    names_from_log "$WORK/run.log" > "$WORK/observed"
    if node tools/compare-failures.cjs "$name" "$WORK/observed" >> "$RESULTS" 2>"$WORK/err"; then
      echo "$name" >> "$WORK/measured"
      echo "ok (${ELAPSED}s)" >&2
      break
    fi
    echo "mismatch (${ELAPSED}s)" >&2
    cat "$WORK/err" >&2
    if [ "$attempt" -eq 1 ]; then
      echo "  $name: re-running once in case it was a flake" >&2
      attempt=2
      continue
    fi
    cp "$WORK/run.log" "$DIAGNOSTICS/$name.mismatch.log" 2>/dev/null
    echo "ERROR: $name did not match its expected failures twice running" >&2
    echo "       log retained at $DIAGNOSTICS/$name.mismatch.log" >&2
    STATUS=1
    break
  done
  if [ -n "$TIMED_OUT" ]; then
    echo "stopping after a timeout; the remaining guards are unmeasured" >&2
    break
  fi
done

restore || STATUS=1

# Every guard declared in expected-failures.json must have been measured. The
# per-cell check catches a mutation that fails to apply; it cannot catch one
# that was never listed, and a guard nobody measures is a guard nobody knows
# about.
touch "$WORK/measured"
if ! node -e 'const d=require("./tools/expected-failures.json");for(const k of Object.keys(d)) if(!k.startsWith("_")) console.log(k)' > "$WORK/declared.raw"; then
  echo "ERROR: could not read tools/expected-failures.json" >&2
  STATUS=1
fi
sort "$WORK/declared.raw" > "$WORK/declared" 2>/dev/null
if [ ! -s "$WORK/declared" ]; then
  # An empty declaration would make every guard look measured.
  echo "ERROR: no declared guards were read; nothing can be reconciled" >&2
  STATUS=1
fi
MISSING="$(comm -23 "$WORK/declared" <(sort "$WORK/measured"))"
if [ -n "$TIMED_OUT" ]; then
  echo "NOTE: stopped early after $TIMED_OUT timed out; these guards are unmeasured:" >&2
  printf '%s
' "$MISSING" | while IFS= read -r guard; do
    [ -n "$guard" ] && echo "  $guard" >&2
  done
elif [ -n "$MISSING" ]; then
  echo "ERROR: these declared guards produced no measurement:" >&2
  printf '%s
' "$MISSING" | while IFS= read -r guard; do
    [ -n "$guard" ] && echo "  $guard" >&2
  done
  echo "       missing from MUTATIONS, or failed the comparison, or produced a" >&2
  echo "       timed-out / no-summary row above, which is not a measurement" >&2
  STATUS=1
fi

run_suite "$WORK/final.log"
code=$?
if [ "$code" -eq 124 ] || [ "$code" -eq 137 ]; then
  # The baseline and every cell distinguish a timeout from a dead run. The final
  # run did not, so a hung suite was reported as one that produced no summary -
  # fail-closed, but with the wrong diagnosis, which this file elsewhere calls
  # its own kind of wrong answer.
  cp "$WORK/final.log" "$DIAGNOSTICS/final.log" 2>/dev/null
  echo "ERROR: the final run timed out after ${RUN_TIMEOUT_SECONDS}s; the tree is unverified" >&2
  echo "       log: $DIAGNOSTICS/final.log" >&2
  STATUS=1
elif ! has_summary "$WORK/final.log"; then
  cp "$WORK/final.log" "$DIAGNOSTICS/final.log" 2>/dev/null
  echo "ERROR: the final run produced no test summary; the tree state is unverified" >&2
  echo "       log: $DIAGNOSTICS/final.log" >&2
  STATUS=1
fi
names_from_log "$WORK/final.log" > "$WORK/final"
if [ -s "$WORK/final" ]; then
  echo "ERROR: the tree is not green after measuring:" >&2
  cat "$WORK/final" >&2
  STATUS=1
fi

# Every mutable file must be byte-identical to the copy taken before the run.
#
# Checked BEFORE anything is printed. The first version of this check ran after
# the table, so the one condition that invalidates every row above could not
# reach the banner that says so: redirect stdout to a file and you got a clean,
# unmarked table with the problem only on stderr.
#
# It compares against the backups rather than grepping `git status` for
# `benchmark/lib/`. That directory was a second remembered list, in the same
# file that had just stopped remembering the first one - it would miss a
# mutation to any file outside it, fail on unrelated dirt whose path merely
# contains the string, and pass silently if git were unavailable. The backups
# are the exact thing "unchanged" means here. Independent review found both.
for file in "${MUTABLE_FILES[@]}"; do
  if ! cmp -s "$file" "$BACKUP/$(backup_key "$file")"; then
    echo "ERROR: $file differs from its pre-run copy - a mutation survived" >&2
    STATUS=1
  fi
done

# And nothing else moved either. The byte check above is exact but narrow, and
# narrowing was how the previous two versions of this check failed.
if ! FINAL_DIRT="$(git status --porcelain)"; then
  # An empty result here used to compare equal to a clean baseline and pass. The
  # byte check above is git-independent and still holds, but a check that cannot
  # run has not passed.
  echo "ERROR: git status failed after the run; the tree comparison is unverified" >&2
  STATUS=1
elif [ "$FINAL_DIRT" != "$BASELINE_DIRT" ]; then
  echo "ERROR: the working tree changed during the run:" >&2
  diff <(printf '%s
' "$BASELINE_DIRT") <(printf '%s
' "$FINAL_DIRT") >&2
  STATUS=1
fi

echo
if [ "$STATUS" -ne 0 ]; then
  echo "!! THIS TABLE IS NOT A MEASUREMENT - the harness exited non-zero. Do not publish it. !!"
fi
echo "| Guard removed | Tests that fail |"
echo "| --- | --- |"
cat "$RESULTS"
exit "$STATUS"
