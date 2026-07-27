import { Effect } from "effect";
import {
  interruptedCancellation as makeInterruptedCancellation,
  type RuntimeCancellationReason,
} from "../../cancellation";
import type { Disposer, DisposerBag } from "../../driver";
import type { GraphNodeCell } from "../cell/cellModel";
import type {
  DisposerFailed,
  DriverOperationTimeoutMs,
  GraphCleanupFailureObserver,
} from "../types";
import { reportDetachedCleanupFailure } from "./cleanupFailureBridge";
import {
  type DisposerRegistry,
  makeDisposerRegistry,
  runDetachedDisposer,
  runDisposers,
} from "./disposers";

// Owner: every driver operation (acquire/refresh/action) collects disposers
// through this bag. While the operation runs, adds accumulate. Once the
// operation settles on a failure or interrupt path the collected disposers are
// drained (or handed off to ready-data ownership), and any late add from
// orphaned async driver work runs immediately — bounded by the node's
// `driverTimeouts.release` — and reports its failure instead of landing in a
// list nobody reads.
export interface OperationDisposers extends DisposerBag {
  /**
   * Hand off ownership: commits the collected disposers into the incarnation
   * registry and returns it for ready-data ownership. Adds keep accumulating
   * into the registry, and a later interrupt drain is a no-op — the committed
   * node owns its disposers until teardown. After teardown settles the
   * registry, late adds run immediately (bounded).
   */
  readonly handOff: () => DisposerRegistry;
  /**
   * Drain and settle: runs collected disposers now (bounded per disposer) and
   * returns failures. Late adds after this run immediately. No-op after a
   * ready hand-off.
   */
  readonly drain: (
    reason: OperationDisposerSettleReason
  ) => Effect.Effect<ReadonlyArray<DisposerFailed>>;
  /**
   * Hand off a settled copy: removes collected disposers for ready-data
   * ownership without running them. Late adds after this run immediately.
   */
  readonly take: (reason: OperationDisposerSettleReason) => ReadonlyArray<Disposer>;
}

export type OperationDisposerSettleReason = Extract<
  Parameters<GraphCleanupFailureObserver>[1],
  "acquire" | "action" | "interrupt" | "refresh" | "teardown"
>;

export function makeOperationDisposers(
  cell: GraphNodeCell,
  notifyCleanupFailures: GraphCleanupFailureObserver,
  releaseTimeout: DriverOperationTimeoutMs,
  sharedRegistry?: DisposerRegistry
): OperationDisposers {
  // Disposers collected by THIS operation while it runs. An acquire bag
  // commits them into the incarnation registry at the ready hand-off; refresh
  // and action bags hand them over through `take` at their result commit.
  const pending: Array<Disposer> = [];
  // Incarnation scope: an acquire bag mints a fresh registry (whose invoked
  // set is new); refresh and action bags receive the registry of the ready
  // data they commit into, so every population of one incarnation dedupes
  // against a single once-only set. Registering a stable function object again
  // in a later incarnation (after evict + re-acquire) runs it again at that
  // incarnation's teardown, because the registry — and its invoked set — is
  // per incarnation, never module scope.
  const registry = sharedRegistry ?? makeDisposerRegistry();
  let settledReason: OperationDisposerSettleReason | undefined;
  let handedOff = false;

  const runSettled = (disposer: Disposer, reason: OperationDisposerSettleReason): void => {
    runDetachedDisposer(cell, disposer, releaseTimeout, registry.invoked, (failure) => {
      reportDetachedCleanupFailure(notifyCleanupFailures, cell.nodeId, reason, [failure]);
    });
  };

  return {
    add: (disposer) => {
      if (settledReason !== undefined) {
        runSettled(disposer, settledReason);
        return;
      }

      if (handedOff) {
        // Hazard: after a ready hand-off the committed node owns the registry,
        // and teardown settles it. A disposer added past that point must still
        // run (detached, bounded) instead of accumulating into a dead list.
        if (registry.isSettled()) {
          runSettled(disposer, "teardown");
          return;
        }

        registry.add(disposer);
        return;
      }

      pending.push(disposer);
    },
    handOff: () => {
      handedOff = true;
      registry.append(pending.splice(0, pending.length));
      return registry;
    },
    drain: (reason) =>
      Effect.suspend(() => {
        // Hazard: after a ready hand-off the committed node owns the registry;
        // a post-commit interrupt must not run or remove the node's disposers.
        if (handedOff) {
          return Effect.succeed<ReadonlyArray<DisposerFailed>>([]);
        }

        settledReason = reason;
        return runDisposers(
          cell,
          pending.splice(0, pending.length),
          releaseTimeout,
          registry.invoked
        );
      }),
    take: (reason) => {
      settledReason = reason;
      return pending.splice(0, pending.length);
    },
  };
}

// Owner: shared interruption finalizer for driver operations. Eviction, stop,
// and release interrupt the worker fiber; this is where the operation's
// AbortController learns about it and where disposers registered before the
// interruption are drained (bounded per disposer) and reported.
export function interruptDriverOperation(input: {
  readonly cell: GraphNodeCell;
  readonly abortController: AbortController;
  readonly disposers: OperationDisposers;
  readonly notifyCleanupFailures: GraphCleanupFailureObserver;
}): Effect.Effect<void> {
  return Effect.gen(function* () {
    input.abortController.abort(interruptedCancellation());
    const failures = yield* input.disposers.drain("interrupt");

    if (failures.length > 0) {
      yield* input.notifyCleanupFailures(input.cell.nodeId, "interrupt", failures);
    }
  });
}

export function interruptedCancellation(): RuntimeCancellationReason {
  return makeInterruptedCancellation("graph cell operation interrupted");
}
