import { Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import type { DisposerBag } from "../../driver";
import type { GraphNodeCell } from "../planning/plan";
import { DisposerFailed, type GraphCleanupFailureObserver, type NodeId } from "../types";
import { reportDetachedCleanupFailure } from "./cleanupFailureBridge";
import { runDisposers } from "./disposers";

// Owner: every driver operation (acquire/refresh/action) collects disposers
// through this bag. While the operation runs, adds accumulate. Once the
// operation settles on a failure or interrupt path the collected disposers are
// drained (or handed off to ready-data ownership), and any late add from
// orphaned async driver work runs immediately and reports its failure instead
// of landing in an array nobody reads.
export interface OperationDisposers extends DisposerBag {
  /**
   * Hand off ownership: returns the live collected array for ready-data
   * ownership. Adds keep accumulating into the array, and a later interrupt
   * drain is a no-op — the committed node owns its disposers until teardown.
   */
  readonly handOff: () => Array<() => void>;
  /**
   * Drain and settle: runs collected disposers now and returns failures. Late
   * adds after this run immediately. No-op after a ready hand-off.
   */
  readonly drain: (
    reason: OperationDisposerSettleReason
  ) => Effect.Effect<ReadonlyArray<DisposerFailed>>;
  /**
   * Hand off a settled copy: removes collected disposers for ready-data
   * ownership without running them. Late adds after this run immediately.
   */
  readonly take: (reason: OperationDisposerSettleReason) => ReadonlyArray<() => void>;
}

export type OperationDisposerSettleReason = Extract<
  Parameters<GraphCleanupFailureObserver>[1],
  "acquire" | "action" | "interrupt" | "refresh"
>;

export function makeOperationDisposers(
  cell: GraphNodeCell,
  notifyCleanupFailures: GraphCleanupFailureObserver
): OperationDisposers {
  const disposers: Array<() => void> = [];
  let settledReason: OperationDisposerSettleReason | undefined;
  let handedOff = false;

  const runSettled = (disposer: () => void, reason: OperationDisposerSettleReason): void => {
    try {
      disposer();
    } catch (cause) {
      reportLateDisposerFailure(cell.nodeId, reason, notifyCleanupFailures, cause, cell.tag);
    }
  };

  return {
    add: (disposer) => {
      if (settledReason !== undefined) {
        runSettled(disposer, settledReason);
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
        return runDisposers(cell, disposers.splice(0, disposers.length));
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
// interruption are drained and reported.
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

function reportLateDisposerFailure(
  nodeId: NodeId,
  reason: OperationDisposerSettleReason,
  notifyCleanupFailures: GraphCleanupFailureObserver,
  cause: unknown,
  tag: string
): void {
  reportDetachedCleanupFailure(notifyCleanupFailures, nodeId, reason, [
    new DisposerFailed({ nodeId, tag, cause }),
  ]);
}
