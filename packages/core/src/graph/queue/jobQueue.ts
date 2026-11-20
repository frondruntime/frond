import type { Fiber } from "effect";
import { runInMicrotask } from "./microtask";

export interface GraphJob {
  run(): void;
}

export interface GraphJobQueue {
  post(job: GraphJob): void;
  /** True from the first post until a drain finds the queue empty. */
  hasPendingJobs(): boolean;
  /** Observer fibers still running on this queue, so stop can end them. */
  readonly observerFibers: Set<Fiber.Fiber<void>>;
}

/**
 * One microtask drain owns all graph jobs. Posting never runs user code.
 * `schedule` is a seam for tests that drive the drain by hand.
 */
export function makeGraphJobQueue(
  schedule: (drain: () => void) => void = runInMicrotask
): GraphJobQueue {
  const jobs: GraphJob[] = [];
  let scheduled = false;
  let head = 0;
  const drain = () => {
    try {
      for (head = 0; head < jobs.length; head += 1) jobs[head]?.run();
    } finally {
      // A throwing job escapes to the host's uncaught-error report, as it
      // always did; the jobs behind it stay queued for a fresh drain.
      if (head + 1 < jobs.length) {
        jobs.splice(0, head + 1);
        schedule(drain);
      } else {
        jobs.length = 0;
        scheduled = false;
      }
    }
  };
  return {
    observerFibers: new Set(),
    hasPendingJobs: () => scheduled,
    post(job) {
      jobs.push(job);
      if (!scheduled) {
        scheduled = true;
        schedule(drain);
      }
    },
  };
}
