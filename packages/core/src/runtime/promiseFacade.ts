import { Cause, Effect } from "effect";
import { type GraphCancel, type GraphResume, noCancel } from "../graph/queue/reply";

export function corePromise<A, E, B = A>(
  start: (resume: GraphResume<A, E>) => GraphCancel,
  project: (value: A) => B = identity as (value: A) => B,
  signal?: AbortSignal,
  recover?: (cause: unknown) => B
): Promise<B> {
  // biome-ignore lint/plugin: v0.6 requires one Promise at the public facade boundary (docs/v06-architecture.md).
  return new Promise((resolve, reject) => {
    let settled = false;
    let cancel: GraphCancel = noCancel;
    const fail =
      recover === undefined
        ? reject
        : (cause: unknown) => {
            try {
              resolve(recover(cause));
            } catch (failure) {
              reject(failure);
            }
          };
    const abort = () => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      const cleanup = cancel();
      if (cleanup === Effect.void) fail(Cause.interrupt());
      else Effect.runFork(cleanup).addObserver(() => fail(Cause.interrupt()));
    };
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    try {
      cancel = start((exit) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener("abort", abort);
        if (exit._tag === "Failure") {
          fail(promiseRejection(exit.cause));
          return;
        }
        try {
          resolve(project(exit.value));
        } catch (cause) {
          fail(cause);
        }
      });
    } catch (cause) {
      settled = true;
      signal?.removeEventListener("abort", abort);
      fail(cause);
    }
  });
}
/**
 * The value a Promise caller rejects with for a failed `cause`.
 *
 * A typed failure or a defect rejects with its squashed value, as
 * `Effect.runPromise` does. A cause with neither (an interruption) rejects with
 * the `Cause` itself, as `unwrapEffect` rejects an aborted action caller, so
 * Effect's "All fibers interrupted without error" Error never reaches a caller.
 */
export function promiseRejection(cause: Cause.Cause<unknown>): unknown {
  return Cause.hasFails(cause) || Cause.hasDies(cause) ? Cause.squash(cause) : cause;
}

function identity<A>(value: A): A {
  return value;
}
