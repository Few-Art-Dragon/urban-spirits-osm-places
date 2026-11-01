import { Worker } from 'node:worker_threads';

import type { PlaceInfo } from './place';
import { Coverage, type Feature } from './cells';
import type { WorkerMessage } from './cover-worker';
import { readOsmExtract, type PbfSource } from './read';

export interface ComputedPlaces {
  sourceDate: Date | undefined;
  places: Map<string, PlaceInfo>;
  features: number;
}

export interface ComputeOptions {
  /** Threads that share the features; a country's take an hour on one (Belarus, 12.10). */
  threads?: number;
  onProgress?: (done: number, total: number) => void;
}

/** Extract → type and blocked mask of every spawn cell that is not plain, unobstructed `urban`. */
export async function computePlaces(
  source: PbfSource,
  { threads = 1, onProgress }: ComputeOptions = {},
): Promise<ComputedPlaces> {
  const { sourceDate, features } = await readOsmExtract(source);
  const coverage = new Coverage();
  if (threads <= 1) {
    for (const [index, feature] of features.entries()) {
      onProgress?.(index, features.length);
      coverage.add(feature);
    }
  } else {
    await coverInWorkers(features, threads, coverage, (done) =>
      onProgress?.(done, features.length),
    );
  }
  return { sourceDate, places: coverage.places(), features: features.length };
}

/** The bundle (build.mjs) ships the worker as its own file next to the importing script. */
const WORKER = import.meta.url.endsWith('.mjs')
  ? new URL('./osm-cover-worker.mjs', import.meta.url)
  : new URL('./cover-worker.ts', import.meta.url);

async function coverInWorkers(
  features: readonly Feature[],
  threads: number,
  into: Coverage,
  onProgress: (done: number) => void,
): Promise<void> {
  // Dealt round, not cut in blocks: the extract ends with its biggest forests and lakes.
  const shares: Feature[][] = Array.from({ length: threads }, () => []);
  for (const [index, feature] of features.entries()) shares[index % threads]?.push(feature);
  const done = shares.map(() => 0);
  await Promise.all(
    shares.map(
      (share, thread) =>
        new Promise<void>((resolve, reject) => {
          const worker = new Worker(WORKER);
          worker.on('message', (message: WorkerMessage) => {
            if (message.type === 'progress') {
              done[thread] = message.done;
              onProgress(done.reduce((sum, count) => sum + count, 0));
              return;
            }
            into.merge(message.parts);
            resolve();
            void worker.terminate();
          });
          worker.on('error', reject);
          worker.on('exit', (code) => {
            if (code !== 0)
              reject(new Error(`cover worker ${String(thread)} exited with ${String(code)}`));
          });
          worker.postMessage(share);
        }),
    ),
  );
}
