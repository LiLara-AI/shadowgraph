#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { validateJournalBenchmark } from '../benchmark/lib/journal-validation.mjs';

const input = process.argv[2];
if (!input || process.argv.length !== 3) throw new Error('Usage: node scripts/validate-bench-journal.mjs <raw-results.json>');
const output = JSON.parse(await readFile(resolve(input), 'utf8'));
const validation = validateJournalBenchmark(output);
process.stdout.write(`${JSON.stringify(validation)}\n`);
if (!validation.valid) process.exitCode = 1;
