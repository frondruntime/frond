import { Clock, Effect } from "effect";
import type { ActiveCellOperation } from "../cell/cellPhase";
import {
  beginNodeOperationState,
  completeNodeOperationState,
  failNodeOperationState,
} from "../cell/cellTransitions";
import type { GraphNodeCell } from "../planning/plan";
import {
  GraphInvariantViolation,
  type GraphOperationStarted,
  type NodeOperation,
  type NodeOperationKind,
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

interface BackgroundOperationOptions<A> {
  readonly action?: string | undefined;
  readonly actionInput?: unknown;
  readonly onSettled?:
    | ((operation: ActiveCellOperation, result: A) => Effect.Effect<void>)
    | undefined;
}

export function runBackgroundOperation<A extends BackgroundOperationResult>(
  cell: GraphNodeCell,
  kind: NodeOperationKind,
  body: (operation: ActiveCellOperation) => Effect.Effect<A>,
  options: BackgroundOperationOptions<A> = {}
): Effect.Effect<A> {
  const onSettled = options.onSettled;

  // Owner: graph operation state begins here, not at runtime command
  // submission. Runtime start events subscribe to this observer so queued work
  // is reported only when the actor actually starts it.
  return beginNodeOperation(cell, kind, options).pipe(
    Effect.flatMap((operation) =>
      body(operation).pipe(
        Effect.flatMap((result) =>
          settleBackgroundOperation(cell, operation, result).pipe(
            Effect.flatMap(() =>
              onSettled === undefined ? Effect.void : onSettled(operation, result)
            ),
            Effect.as(result)
          )
        ),
        Effect.catchCause((cause) =>
          failNodeOperation(
            cell,
            operation,
            new GraphInvariantViolation({
              nodeId: cell.nodeId,
              tag: cell.tag,
              invariant: `${kind} operation failed before returning an operation result`,
              cause,
            })
          ).pipe(Effect.flatMap(() => Effect.failCause(cause)))
        )
      )
    )
  );
}

function settleBackgroundOperation(
  cell: GraphNodeCell,
  operation: ActiveCellOperation,
  result: BackgroundOperationResult
): Effect.Effect<void> {
  return result._tag === "Success"
    ? completeNodeOperation(cell, operation)
    : failNodeOperation(cell, operation, result.error);
}

function beginNodeOperation(
  cell: GraphNodeCell,
  kind: NodeOperationKind,
  options: Pick<
    BackgroundOperationOptions<BackgroundOperationResult>,
    "action" | "actionInput"
  > = {}
): Effect.Effect<ActiveCellOperation> {
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    let active: ActiveCellOperation | undefined;

    yield* cell.state.transition((latest) => {
      const operationId = latest.nextOperationId;
      const operation = {
        _tag: "Running",
        operationId,
        kind,
        startedAt,
        action: options.action,
      } satisfies NodeOperation;

      active = operation;

      return [undefined, beginNodeOperationState({ latest, operation })] as const;
    });

    if (active === undefined) {
      throw new GraphInvariantViolation({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: `failed to begin ${kind} operation`,
      });
    }

    // Contract: action input is observer payload only. Persisted operation
    // snapshots store the action name, not arbitrary user input.
    yield* cell.notifyOperationStarted(graphOperationStarted(cell, active, options.actionInput));
    yield* cell.notifyChanged(cell.nodeId);

    return active;
  });
}

function graphOperationStarted(
  cell: GraphNodeCell,
  operation: ActiveCellOperation,
  actionInput: unknown
): GraphOperationStarted {
  if (operation.kind === "action") {
    if (operation.action === undefined) {
      throw new GraphInvariantViolation({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: "action operation start requires action name",
      });
    }

    return {
      _tag: "ActionStarted",
      nodeId: cell.nodeId,
      operation: operation as RunningActionOperation,
      action: operation.action,
      input: actionInput,
    };
  }

  if (operation.kind === "refresh") {
    return {
      _tag: "RefreshStarted",
      nodeId: cell.nodeId,
      operation: operation as RunningRefreshOperation,
    };
  }

  return {
    _tag: "ArgsUpdateStarted",
    nodeId: cell.nodeId,
    operation: operation as RunningArgsOperation,
  };
}

function completeNodeOperation(
  cell: GraphNodeCell,
  operation: ActiveCellOperation
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* cell.state.transition((latest) => [
      undefined,
      completeNodeOperationState({ latest, operation }),
    ]);
    yield* cell.notifyChanged(cell.nodeId);
  });
}

function failNodeOperation(
  cell: GraphNodeCell,
  operation: ActiveCellOperation,
  error: unknown
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const at = yield* Clock.currentTimeMillis;

    yield* cell.state.transition((latest) => [
      undefined,
      failNodeOperationState({
        latest,
        operation,
        failure: {
          operationId: operation.operationId,
          kind: operation.kind,
          error,
          at,
        },
      }),
    ]);
    yield* cell.notifyChanged(cell.nodeId);
  });
}
