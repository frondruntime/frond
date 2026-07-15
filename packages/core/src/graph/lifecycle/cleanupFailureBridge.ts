import { Effect } from "effect";

import type { GraphCleanupFailureObserver, GraphFailure, NodeId } from "../types";

// Bridge: late cleanup failures can arrive from orphaned synchronous/promise
// driver continuations after the owning operation effect has already settled.
// There is no live Effect frame left to yield into, so report through one
// explicit detached boundary and consume observer defects.
export function reportDetachedCleanupFailure(
  notifyCleanupFailures: GraphCleanupFailureObserver,
  nodeId: NodeId,
  reason: Parameters<GraphCleanupFailureObserver>[1],
  failures: ReadonlyArray<GraphFailure>
): void {
  void Effect.runPromise(notifyCleanupFailures(nodeId, reason, failures)).catch(() => undefined);
}
