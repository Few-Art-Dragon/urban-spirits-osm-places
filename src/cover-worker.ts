import { parentPort } from 'node:worker_threads';

import { Coverage, type Feature } from './cells';

// One share of an extract's features on its own thread (import.ts, coverInWorkers).
export type WorkerMessage =
  { type: 'progress'; done: number } | { type: 'done'; parts: ReturnType<Coverage['parts']> };

const PROGRESS_EVERY_MS = 5_000;

const port = parentPort;
if (!port) throw new Error('cover-worker runs as a worker thread');

port.once('message', (features: Feature[]) => {
  const coverage = new Coverage();
  let reported = Date.now();
  for (const [index, feature] of features.entries()) {
    coverage.add(feature);
    if (Date.now() - reported > PROGRESS_EVERY_MS) {
      reported = Date.now();
      port.postMessage({ type: 'progress', done: index + 1 } satisfies WorkerMessage);
    }
  }
  port.postMessage({ type: 'done', parts: coverage.parts() } satisfies WorkerMessage);
});
