// Automatic capture's work, off the main thread (PR-36c, plan §12.1): reading
// and rewriting the store is synchronous in parts, and the thread keeping the
// deadline must stay free (src/cli.js; superviseCapture in
// src/capture-hook.js). It posts `enter` and `leave` around the store, and
// nothing else: the hook is silent.
import { parentPort, workerData } from 'node:worker_threads';
import { runCapture } from './capture-hook.js';
import { triggerExtraction } from './internal/extraction-trigger.js';

const { capture, input, deadline, record } = workerData;
try {
  const outcome = await runCapture({ capture, input, deadline, record, post: (message) => parentPort.postMessage(message) });
  const event = JSON.parse(input.replace(/^\uFEFF/u, '')).hook_event_name;
  await triggerExtraction({ event, outcome, deadline });
} catch {}
