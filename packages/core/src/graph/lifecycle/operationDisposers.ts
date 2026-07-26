import { Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import type { Disposer, DisposerBag } from "../../driver";
import type { GraphNodeCell } from "../cell/cellModel";
import type {
  DisposerFailed,
  DriverOperationTimeoutMs,
  GraphCleanupFailureObserver,
} from "../types";
import { reportDetachedCleanupFailure } from "./cleanupFailureBridge";
import { disposersSettled, runDetachedDisposer, runDisposers } from "./disposers";

// Owner: every driver operation (acquire/refresh/action) collects disposers
// through this bag. While the operation runs, adds accumulate. Once the
// operation settles on a failure or interrupt path the collected disposers are
// drained (or handed off to ready-data ownership), and any late add from
// orphaned async driver work runs immediately — bounded by the node's
// `driverTimeouts.release` — and reports its failure instead of landing in an
// array nobody reads.
export interface OperationDisposers extends DisposerBag {
  /**
   * Hand off ownership: returns the live collected array for ready-data
   * ownership. Adds keep accumulating into the array, and a later interrupt
   * drain is a no-op — the committed node owns its disposers until teardown.
   * After teardown settles the array, late adds run immediately (bounded).
   */
  readonly handOff: () => Array<Disposer>;
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
  releaseTimeout: DriverOperationTimeoutMs
): OperationDisposers {
  const disposers: Array<Disposer> = [];
  let settledReason: OperationDisposerSettleReason | undefined;
  let handedOff = false;

  const runSettled = (disposer: Disposer, reason: OperationDisposerSettleReason): void => {
    runDetachedDisposer(cell, disposer, releaseTimeout, (failure) => {
      reportDetachedCleanupFailure(notifyCleanupFailures, cell.nodeId, reason, [failure]);
    });
  };

  return {
    add: (disposer) => {
      if (settledReason !== undefined) {
        runSettled(disposer, settledReason);
        return;
      }

      // Hazard: after a ready hand-off the committed node owns this array, and
      // teardown settles it. A disposer added past that point must still run
      // (detached, bounded) instead of accumulating into a dead array.
      if (handedOff && disposersSettled(disposers)) {
        runSettled(disposer, "teardown");
        return;
      }

      disposers.push(disposer);
    },
    handOff: () => {
      handedOff = true;
      return disposers;
    },
    drain: (reason) =>
      Effect.suspend(() => {
        // Hazard: after a ready hand-off the committed node owns this array; a
        // post-commit interrupt must not run or remove the node's disposers.
        if (handedOff) {
          return Effect.succeed<ReadonlyArray<DisposerFailed>>([]);
        }

        settledReason = reason;
        return runDisposers(cell, disposers.splice(0, disposers.length), releaseTimeout);
      }),
    take: (reason) => {
      settledReason = reason;
      return disposers.splice(0, disposers.length);
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
  return {
    _tag: "Interrupted",
    detail: "graph cell operation interrupted",
  };
}
