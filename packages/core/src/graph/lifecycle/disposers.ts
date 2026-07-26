import { Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import type { Disposer } from "../../driver";
import type { GraphNodeCell } from "../cell/cellModel";
import { DisposerFailed, DisposerTimedOut, type DriverOperationTimeoutMs } from "../types";

// Registry guarantee: a disposer function runs at most once across every
// runtime invocation path — operation-bag drain, ready-data teardown,
// release-hook drain, and late settled adds — no matter how many populations
// it was registered in. Idempotency belongs to the registry, not the author's
// memoize. WeakSet keyed on function identity, so it never retains disposers.
const invokedDisposers = new WeakSet<Disposer>();

// Teardown settles the ready-owned live disposer array. The owning operation
// bag consults this so a disposer added after teardown runs immediately
// (detached, bounded) instead of landing in an array nobody reads again.
const settledDisposerArrays = new WeakSet<ReadonlyArray<Disposer>>();

export function disposersSettled(disposers: ReadonlyArray<Disposer>): boolean {
  return settledDisposerArrays.has(disposers);
}

// Owner: single bounded runner for a disposer batch. Reverse registration
// order, sequential, and the `driverTimeouts.release` bound applies per
// disposer — after one times out the remaining cleanup still runs. A disposer
// that outlives the bound keeps running detached; the graph does not wait
// beyond the bound and reports a DisposerFailed with a DisposerTimedOut cause.
export function runDisposers(
  cell: GraphNodeCell,
  disposers: ReadonlyArray<Disposer>,
  timeout: DriverOperationTimeoutMs
): Effect.Effect<ReadonlyArray<DisposerFailed>> {
  return Effect.forEach(
    [...disposers].reverse(),
    (disposer) => runDisposer(cell, disposer, timeout),
    {
      concurrency: 1,
    }
  ).pipe(Effect.map((failures) => failures.filter((failure) => failure !== undefined)));
}

// Owner: teardown drain for the ready-owned live disposer array. Loops until
// the array is empty so cleanup registered during the drain (by a disposer or
// by orphaned async driver work) is still run and awaited (bounded), then
// settles the array so post-teardown adds run immediately instead of leaking.
export function drainLiveDisposers(
  cell: GraphNodeCell,
  disposers: ReadonlyArray<Disposer>,
  timeout: DriverOperationTimeoutMs
): Effect.Effect<ReadonlyArray<DisposerFailed>> {
  return Effect.gen(function* () {
    // Ownership: ready data holds the live collected array handed off by the
    // acquire operation bag; draining mutates it in place on purpose.
    const live = disposers as Array<Disposer>;
    const failures: Array<DisposerFailed> = [];

    while (live.length > 0) {
      const batch = live.splice(0, live.length);
      failures.push(...(yield* runDisposers(cell, batch, timeout)));
    }

    settledDisposerArrays.add(live);
    return failures;
  });
}

// Owner: detached single-disposer run for late adds after settlement. The
// synchronous part runs inline (and reports inline on throw); a returned
// promise is awaited detachedly under the same per-disposer bound.
export function runDetachedDisposer(
  cell: GraphNodeCell,
  disposer: Disposer,
  timeout: DriverOperationTimeoutMs,
  report: (failure: DisposerFailed) => void
): void {
  let pending: Promise<void> | undefined;

  try {
    pending = invokeDisposerOnce(disposer);
  } catch (cause) {
    report(disposerFailed(cell, cause));
    return;
  }

  if (pending === undefined) {
    return;
  }

  void Effect.runPromise(awaitBoundedDisposer(cell, pending, timeout))
    .then((failure) => {
      if (failure !== undefined) {
        report(failure);
      }
    })
    .catch(() => undefined);
}

function runDisposer(
  cell: GraphNodeCell,
  disposer: Disposer,
  timeout: DriverOperationTimeoutMs
): Effect.Effect<DisposerFailed | undefined> {
  return Effect.try({
    try: () => invokeDisposerOnce(disposer),
    catch: (cause) => disposerFailed(cell, cause),
  }).pipe(
    Effect.flatMap((pending) =>
      pending === undefined
        ? Effect.succeed<DisposerFailed | undefined>(undefined)
        : awaitBoundedDisposer(cell, pending, timeout)
    ),
    Effect.catch((failure) => Effect.succeed(failure))
  );
}

function invokeDisposerOnce(disposer: Disposer): Promise<void> | undefined {
  if (invokedDisposers.has(disposer)) {
    return undefined;
  }

  invokedDisposers.add(disposer);
  const result = disposer();

  if (!isThenable(result)) {
    return undefined;
  }

  const pending = Promise.resolve(result);
  // A disposer abandoned past its bound keeps running detached; consume a late
  // rejection here so it never surfaces as an unhandled rejection.
  pending.catch(() => undefined);
  return pending;
}

function awaitBoundedDisposer(
  cell: GraphNodeCell,
  pending: Promise<void>,
  timeout: DriverOperationTimeoutMs
): Effect.Effect<DisposerFailed | undefined> {
  return Effect.tryPromise({
    try: () => pending,
    catch: (cause) => disposerFailed(cell, cause),
  }).pipe(
    Effect.as<DisposerFailed | undefined>(undefined),
    Effect.timeoutOrElse({
      duration: timeout,
      orElse: () => Effect.succeed<DisposerFailed | undefined>(disposerTimedOut(cell, timeout)),
    }),
    Effect.catch((failure) => Effect.succeed(failure))
  );
}

function disposerFailed(cell: GraphNodeCell, cause: unknown): DisposerFailed {
  return new DisposerFailed({ nodeId: cell.nodeId, tag: cell.tag, cause });
}

function disposerTimedOut(cell: GraphNodeCell, timeout: DriverOperationTimeoutMs): DisposerFailed {
  return disposerFailed(
    cell,
    new DisposerTimedOut({
      nodeId: cell.nodeId,
      tag: cell.tag,
      timeout,
      cancellation: disposerTimeoutCancellation(timeout),
    })
  );
}

function disposerTimeoutCancellation(timeout: number): RuntimeCancellationReason {
  return {
    _tag: "TimedOut",
    detail: `${timeout}ms`,
  };
}

function isThenable(value: unknown): value is PromiseLike<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}
