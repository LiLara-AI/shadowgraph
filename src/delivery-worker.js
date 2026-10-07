// Host delivery's work, off the main thread (PR-32, plan §18.4): reading,
// ranking and redacting a large store is synchronous, and a timer on the same
// thread could not stop it. The main thread (src/cli.js) keeps the deadline,
// writes the line this posts only while time remains, and otherwise exits 0.
import { parentPort, workerData } from 'node:worker_threads';
import { runDeliver } from './delivery.js';

const { args, input, file, storage, deadline } = workerData;
await runDeliver({ args, readInput: () => input, file, storage, deadline, write: (text) => parentPort.postMessage(text) });
