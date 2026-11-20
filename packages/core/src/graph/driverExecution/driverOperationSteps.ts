import { type Context, Effect } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import { interruptDriverOperation } from "../lifecycle/operationDisposers";
import type { GraphCancel } from "../queue/reply";
import { validityChanged } from "../resultValidity";
import type { ResultValidity, ResultValidityChangedReason } from "../types";
import { finishObserverWork } from "./effectRunner";

/**
 * Runs `then(value)` once the result-validity sink has seen a move from
 * `previous` to `next`, or at once when the validity did not change. Taking
 * the value keeps the unchanged path free of a continuation closure.
 */
export function notifyValidityThen<A>(
  cell: GraphNodeCell,
  previous: ResultValidity,
  next: ResultValidity,
  reason: ResultValidityChangedReason,
  context: Context.Context<never> | undefined,
  then: (value: A) => void,
  value: A
): GraphCancel | undefined {
  if (!validityChanged(previous, next)) {
    then(value);
    return;
  }
  return finishObserverWork(
    cell.notifyResultValidityChanged(cell.nodeId, previous, next, reason),
    context,
    () => then(value),
    cell.jobs
  );
}

/**
 * The cancel of a started driver operation: stop the driver edge, then abort
 * its signal and drain the operation's disposers, reporting their failures.
 */
export function cancelDriverOperation(
  cancelEdge: GraphCancel,
  operation: Parameters<typeof interruptDriverOperation>[0]
): Effect.Effect<void> {
  return cancelEdge().pipe(Effect.andThen(interruptDriverOperation(operation)));
}
