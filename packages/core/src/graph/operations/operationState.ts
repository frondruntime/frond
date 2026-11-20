import { type Context, Effect, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import type { ActiveCellOperation } from "../cell/cellPhase";
import {
  beginNodeOperationState,
  completeNodeOperationState,
  failNodeOperationState,
} from "../cell/cellTransitions";
import { finishObserverWork } from "../driverExecution/effectRunner";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import {
  GraphInvariantViolation,
  type GraphOperationStarted,
  NodeEvicted,
  type RunningActionOperation,
  type RunningArgsOperation,
  type RunningRefreshOperation,
} from "../types";

export type BackgroundOperationResult =
  | {
      readonly _tag: "Success";
    }
  | {
      readonly _tag: "Failure";
      readonly error: unknown;
    };

/** The operation kinds that run through {@link startBackgroundOperation}. */
type BackgroundOperationKind = RunningBackgroundOperation["kind"];

/** A running refresh or args operation, narrowed by `kind`. */
type RunningBackgroundOperation = RunningRefreshOperation | RunningArgsOperation;

/** A running operation, narrowed by `kind`. */
export type RunningOperation = RunningActionOperation | RunningBackgroundOperation;

export function startBackgroundOperation<A extends BackgroundOperationResult>(
  cell: GraphNodeCell,
  kind: BackgroundOperationKind,
  body: (operation: ActiveCellOperation, resume: GraphResume<A>) => GraphCancel,
  context: Context.Context<never> | undefined,
  resume: GraphResume<A>
): GraphCancel {
  const operation = beginBackgroundOperationSync(cell, kind, cell.syncClock.now());
  return runOperation(
    cell,
    operation,
    graphOperationStarted(cell, operation),
    runBackgroundBody,
    body,
    context,
    resume,
    undefined
  );
}

/** Starts a refresh or args body; the caller's body is the run's input. */
function runBackgroundBody<A extends BackgroundOperationResult>(
  _cell: GraphNodeCell,
  operation: RunningBackgroundOperation,
  body: (operation: ActiveCellOperation, resume: GraphResume<A>) => GraphCancel,
  _context: Context.Context<never> | undefined,
  settled: GraphResume<A>
): GraphCancel {
  return body(operation, settled);
}

/**
 * Runs a begun operation: its start sink, its change sink, then `body`. When
 * the body settles, ends the operation, runs the change sink, then, for a
 * successful exit, `completed`'s sink, then resumes. A cancel interrupts the
 * phase running at the time and ends the operation as interrupted.
 *
 * A Failure exit, or a body that throws, ends the operation with a
 * {@link GraphInvariantViolation}: a body reports its own failure as a result.
 */
export function runOperation<O extends RunningOperation, A extends BackgroundOperationResult, I>(
  cell: GraphNodeCell,
  operation: O,
  started: GraphOperationStarted,
  body: (
    cell: GraphNodeCell,
    operation: O,
    input: I,
    context: Context.Context<never> | undefined,
    resume: GraphResume<A>
  ) => GraphCancel,
  input: I,
  context: Context.Context<never> | undefined,
  resume: GraphResume<A>,
  completed:
    | ((cell: GraphNodeCell, operation: O, input: I, result: A) => Effect.Effect<void>)
    | undefined
): GraphCancel {
  let cancel: GraphCancel = noCancel;
  let canceled = false;
  let bodySettled = false;
  const settled: GraphResume<A> = (exit) => {
    if (canceled) return;
    bodySettled = true;
    if (exit._tag === "Failure") {
      failNodeOperationSync(
        cell,
        operation,
        new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: `${operation.kind} operation failed before returning an operation result`,
          cause: exit.cause,
        }),
        cell.syncClock.now()
      );
    } else if (exit.value._tag === "Success") completeNodeOperationSync(cell, operation);
    else failNodeOperationSync(cell, operation, exit.value.error, cell.syncClock.now());
    const changedSink = finishObserverWork(
      cell.notifyChanged(cell.nodeId),
      context,
      () => {
        if (exit._tag === "Failure" || completed === undefined) {
          resume(exit);
          return;
        }
        // A cancel during the change sink already ended the operation, and
        // its interrupt reports the operation's end.
        if (canceled) return;
        const completedSink = finishObserverWork(
          completed(cell, operation, input, exit.value),
          context,
          () => resume(exit),
          cell.jobs
        );
        if (completedSink !== undefined) cancel = completedSink;
      },
      cell.jobs
    );
    if (changedSink !== undefined) cancel = changedSink;
  };
  // A sink still running before the body starts is the operation's work:
  // cancelling interrupts it, then ends the operation. `undefined` means it
  // already ran.
  const startedSink = finishObserverWork(
    cell.notifyOperationStarted(started),
    context,
    () => {
      // A cancel during the start sink already ended the operation and
      // notified the change: start no further work of its own.
      if (canceled) return;
      const changedSink = finishObserverWork(
        cell.notifyChanged(cell.nodeId),
        context,
        () => {
          if (canceled) return;
          try {
            const bodyCancel = body(cell, operation, input, context, settled);
            // A synchronous settlement may already own a suspended sink.
            if (!bodySettled) cancel = bodyCancel;
          } catch (cause) {
            settled(Exit.die(cause));
          }
        },
        cell.jobs
      );
      if (changedSink !== undefined) cancel = changedSink;
    },
    cell.jobs
  );
  if (startedSink !== undefined) cancel = startedSink;
  return () => {
    canceled = true;
    return cancel().pipe(
      Effect.andThen(
        Effect.suspend(() => {
          failNodeOperationSync(
            cell,
            operation,
            new NodeEvicted({
              nodeId: cell.nodeId,
              tag: cell.tag,
              cancellation: {
                _tag: "Interrupted",
                detail: `${operation.kind} operation interrupted before settling`,
              },
            }),
            cell.syncClock.now()
          );
          return cell.notifyChanged(cell.nodeId);
        })
      )
    );
  };
}

/** Begins an action operation; the action path starts its own events. */
export function beginActionOperationSync(
  cell: GraphNodeCell,
  action: string,
  startedAt: number
): RunningActionOperation {
  return cell.state.updateSync((latest) => {
    const operation: RunningActionOperation = {
      _tag: "Running",
      operationId: latest.nextOperationId,
      kind: "action",
      startedAt,
      action,
    };
    beginNodeOperationState({ latest, operation });
    return operation;
  });
}

function beginBackgroundOperationSync(
  cell: GraphNodeCell,
  kind: BackgroundOperationKind,
  startedAt: number
): RunningBackgroundOperation {
  return cell.state.updateSync((latest) => {
    const operation: RunningBackgroundOperation = {
      _tag: "Running",
      operationId: latest.nextOperationId,
      kind,
      startedAt,
      action: undefined,
    };
    beginNodeOperationState({ latest, operation });
    return operation;
  });
}

function graphOperationStarted(
  cell: GraphNodeCell,
  operation: RunningBackgroundOperation
): GraphOperationStarted {
  switch (operation.kind) {
    case "refresh":
      return { _tag: "RefreshStarted", nodeId: cell.nodeId, operation };
    case "args":
      return { _tag: "ArgsUpdateStarted", nodeId: cell.nodeId, operation };
  }
}

export function completeNodeOperationSync(
  cell: GraphNodeCell,
  operation: ActiveCellOperation
): void {
  cell.state.updateSync((latest) => {
    completeNodeOperationState({ latest, operation });
  });
}

export function failNodeOperationSync(
  cell: GraphNodeCell,
  operation: ActiveCellOperation,
  error: unknown,
  at: number
): void {
  cell.state.updateSync((latest) => {
    failNodeOperationState({
      latest,
      operation,
      failure: {
        operationId: operation.operationId,
        kind: operation.kind,
        error,
        at,
      },
    });
  });
}
