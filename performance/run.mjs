#!/usr/bin/env node
// The delivery-budget performance step (`npm run test:performance`; CI runs it
// once per required job, before the suite, PR #12). An entry script only: it
// always runs the step, with no main-module check that could let it exit
// without running. The logic is in performance/cases.mjs. An argument names
// another performance file (the suite's tests of this step use it); CI passes
// none.
import { PERFORMANCE_FILE, runPerformance } from './cases.mjs';

process.exitCode = runPerformance(process.argv[2] ?? PERFORMANCE_FILE);
