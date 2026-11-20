import { Cause } from "effect";
import type { GraphJobQueue } from "../queue/jobQueue";

/**
 * The failure an operation step reports for `cause`. On the operation path a
 * cause holds a single `Fail` (the driver edge normalizes its exit, and the
 * dependency path fails with one `DependencyFailed`), so this is its error.
 * Any other cause squashes as `Cause.squash` does: the first `Fail`, else the
 * first defect, else an interruption error.
 */
export function singleFailure(cause: Cause.Cause<unknown>): unknown {
  return Cause.squash(cause);
}

/**
 * Reports a cause no caller can receive through the host's uncaught-error
 * path: a graph job that throws it when the queue drains.
 */
export function reportCause(jobs: GraphJobQueue, cause: Cause.Cause<unknown>): void {
  jobs.post(new ThrowCause(cause));
}

class ThrowCause {
  constructor(readonly cause: Cause.Cause<unknown>) {}
  run(): void {
    throw this.cause;
  }
}
