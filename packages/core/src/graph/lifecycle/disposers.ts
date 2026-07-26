import { Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import type { Disposer } from "../../driver";
import type { GraphNodeCell } from "../cell/cellModel";
import { DisposerFailed, DisposerTimedOut, type DriverOperationTimeoutMs } from "../types";

// Registry guarantee: a disposer function runs at most once across every
// runtime invocation path OF ONE READY INCARNATION — operation-bag drain,
// ready-data teardown, release-hook drain, and late settled adds — no matter
// how many populations it was registered in. Idempotency belongs to the
// registry, not the author's memoize. The invoked set is scoped to the
// incarnation (created with the acquire operation bag and shared by every bag
// that feeds the same ready data), never module scope: a stable function
// object (module-level unsubscribe, bound method) registered again by a later
// incarnation after evict + re-acquire must run again at that incarnation's
// teardown. WeakSet keyed on function identity, so it never retains disposers.
export type InvokedDisposers = WeakSet<Disposer>;

export function makeInvokedDisposers(): InvokedDisposers {
  return new WeakSet<Disposer>();
}

// Incarnation lookup: the live collected array is the ownership token that
// travels from the acquire operation bag into ready data, so drains that only
// see the array (ready teardown) recover the incarnation's invoked set from
// it. Bags register their array here at creation; sibling populations of the
// same incarnation (release-hook bag, refresh/action bags) adopt the same set.
const invokedDisposersByRegistry = new WeakMap<ReadonlyArray<Disposer>, InvokedDisposers>();

export function adoptInvokedDisposers(
  registry: ReadonlyArray<Disposer>,
  invoked: InvokedDisposers
): InvokedDisposers {
  invokedDisposersByRegistry.set(registry, invoked);
  return invoked;
}

export function invokedDisposersOf(registry: ReadonlyArray<Disposer>): InvokedDisposers {
  const invoked = invokedDisposersByRegistry.get(registry);

  if (invoked !== undefined) {
    return invoked;
  }

  return adoptInvokedDisposers(registry, makeInvokedDisposers());
}

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
  timeout: DriverOperationTimeoutMs,
  invoked: InvokedDisposers
): Effect.Effect<ReadonlyArray<DisposerFailed>> {
  return Effect.forEach(
    [...disposers].reverse(),
    (disposer) => runDisposer(cell, disposer, timeout, invoked),
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
    // acquire operation bag; draining mutates it in place on purpose. The
    // incarnation's invoked set travels with that array, so this drain shares
    // once-only bookkeeping with every bag of the same incarnation.
    const live = disposers as Array<Disposer>;
    const invoked = invokedDisposersOf(disposers);
    const failures: Array<DisposerFailed> = [];

    while (live.length > 0) {
      const batch = live.splice(0, live.length);
      failures.push(...(yield* runDisposers(cell, batch, timeout, invoked)));
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
  invoked: InvokedDisposers,
  report: (failure: DisposerFailed) => void
): void {
  let pending: Promise<void> | undefined;

  try {
    pending = invokeDisposerOnce(disposer, invoked);
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
  timeout: DriverOperationTimeoutMs,
  invoked: InvokedDisposers
): Effect.Effect<DisposerFailed | undefined> {
  return Effect.try({
    try: () => invokeDisposerOnce(disposer, invoked),
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

function invokeDisposerOnce(
  disposer: Disposer,
  invoked: InvokedDisposers
): Promise<void> | undefined {
  if (invoked.has(disposer)) {
    return undefined;
  }

  invoked.add(disposer);
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
