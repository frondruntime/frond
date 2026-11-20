import type { Context } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import { ensureReadyOperation } from "../cell/cellOperations";
import type { GraphCellTask } from "../cell/cellQueue";
import type { GraphCellQueueRegistry } from "../cell/queueRegistry";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import type { NodeRead } from "../types";
import { beginReadinessAttempt } from "./readinessAttempt";

export function submitReadiness(
  registry: GraphCellQueueRegistry,
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  context: Context.Context<never> | undefined
): GraphCellTask<NodeRead> {
  const phase = cell.state.getSync().phase;
  const queue = registry.queues.get(cell.nodeId);
  // Join the in-flight acquire only while nothing is queued behind it: a call
  // after a queued release or update must wait its turn (per-cell FIFO).
  if (phase._tag === "Acquiring" && (queue === undefined || !queue.hasQueued)) return phase.attempt;
  const attempt =
    (queue === undefined || queue.isIdle) &&
    (phase._tag === "Idle" || phase._tag === "ReadinessError")
      ? beginReadinessAttempt(cell, phase.base)
      : undefined;
  return registry.submitSync(cell, ensureReadyOperation(env, cell, attempt), context);
}
