import { Clock, Effect } from "effect";
import { phaseArgs, phaseReadyData } from "../cell/cellPhase";
import { makeDriverContext } from "../driverExecution/driverContext";
import {
  recoverDriverOperationFailure,
  runTimedDriverOperation,
} from "../driverExecution/driverOperationRunner";
import { interruptDriverOperation, makeOperationDisposers } from "../lifecycle/operationDisposers";
import type { GraphNodeCell } from "../planning/plan";
import type { ResultState } from "../resultValidity";
import {
  type ActionRequest,
  type ActionResult,
  GraphInvariantViolation,
  type NodeRead,
  type RunningActionOperation,
} from "../types";
import {
  collectDependencyValues,
  type GraphOperationEnvironment,
  refreshDependencyValue,
} from "./dependencies";
import { appendOperationDisposers, commitReadyOperationResult } from "./operationCommit";
import { makeActionFailure } from "./operationFailures";
import { runBackgroundOperation } from "./operationState";

export function runActionInCell(
  env: GraphOperationEnvironment,
  ensureReady: (cell: GraphNodeCell) => Effect.Effect<NodeRead>,
  cell: GraphNodeCell,
  request: ActionRequest
): Effect.Effect<ActionResult> {
  return Effect.gen(function* () {
    const readyHandle = yield* ensureReady(cell);

    return yield* runBackgroundOperation(
      cell,
      "action",
      () => runActionDriver(env, cell, request, readyHandle),
      {
        action: request.action,
        actionInput: request.input,
        // Contract: both runtime-submitted actions and node-domain
        // `this.action(...)` completions are observed from the graph here.
        // Runtime command code must not emit a second completion event.
        onSettled: (operation, result) =>
          Effect.gen(function* () {
            const completedAt = yield* Clock.currentTimeMillis;
            yield* cell.notifyActionCompleted({
              nodeId: cell.nodeId,
              operation: operation as RunningActionOperation,
              action: request.action,
              input: request.input,
              result,
              completedAt,
            });
          }),
      }
    );
  });
}

function runActionDriver(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: ActionRequest,
  readyHandle: NodeRead
): Effect.Effect<ActionResult> {
  return Effect.gen(function* () {
    if (readyHandle.status._tag !== "Wired" || readyHandle.status.run._tag !== "Ready") {
      return makeActionFailure(cell, request, readyHandle.status);
    }

    const action = cell.descriptor.driver.actions.read(request.action);

    if (action._tag === "Missing") {
      return makeActionFailure(
        cell,
        request,
        new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: "requested action must exist on the node driver",
          cause: { action: action.action },
        })
      );
    }

    const current = yield* cell.state.get;
    const ready = phaseReadyData(current.phase);

    if (ready._tag === "Missing") {
      return makeActionFailure(
        cell,
        request,
        new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: "action requires ready graph-owned node data",
        })
      );
    }
    const readyData = ready.ready;
    const readyNode = readyData.node;

    const depsResult = yield* collectDependencyValues(env, cell).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "Failure", cause }) as const,
        onSuccess: (deps) => ({ _tag: "Success", deps }) as const,
      })
    );

    if (depsResult._tag === "Failure") {
      return makeActionFailure(cell, request, depsResult.cause);
    }

    const abortController = new AbortController();
    const actionDisposers = makeOperationDisposers(cell, env.state.notifyCleanupFailures);
    const clock = yield* Clock.Clock;
    let currentResultState: ResultState = {
      result: readyData.result,
      resultLoadedAt: readyData.resultLoadedAt,
      resultValidity: readyData.resultValidity,
      resultValidityCommit: "default",
    };

    const ctx = makeDriverContext({
      cell,
      node: readyNode,
      args: phaseArgs(current.phase),
      deps: depsResult.deps,
      abortController,
      disposers: actionDisposers,
      signals: env.signals,
      refreshDep: (dependencyName) => refreshDependencyValue(env, cell, dependencyName),
      now: () => clock.currentTimeMillisUnsafe(),
      getCurrentResultState: () => currentResultState,
      setCurrentResultState: (next) => {
        currentResultState = next;
      },
      setResultDefaultValidity: "preserve",
      cloneResultOnPatch: true,
    });

    return yield* recoverDriverOperationFailure(
      runTimedDriverOperation({
        cell,
        operation: `action:${request.action}`,
        boundary: "driver-action",
        timeout: env.driverTimeouts.action,
        abortController,
        spanName: "frond.graph.action.driver",
        spanAttributes: {
          ...env.runtimeSpanAttributes,
          "frond.node.id": cell.nodeId,
          "frond.node.tag": cell.tag,
          "frond.action": request.action,
          "frond.driver.mode": cell.descriptor.driver.mode,
        },
        run: () => action.run(ctx, request.input),
      }).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.gen(function* () {
              yield* appendOperationDisposers(cell, actionDisposers.take("action"));
              return makeActionFailure(cell, request, cause);
            }),
          onSuccess: (value) =>
            Effect.gen(function* () {
              yield* commitReadyOperationResult({
                cell,
                node: readyNode,
                deps: depsResult.deps,
                resultState: currentResultState,
                previousValidity: readyData.resultValidity,
                validityReason: "manual",
                operationDisposers: actionDisposers.take("action"),
              });

              return {
                _tag: "Success",
                nodeId: cell.nodeId,
                value,
              } satisfies ActionResult;
            }),
        }),
        Effect.onInterrupt(() =>
          interruptDriverOperation({
            cell,
            abortController,
            disposers: actionDisposers,
            notifyCleanupFailures: env.state.notifyCleanupFailures,
          })
        )
      ),
      "driver-action",
      (cause) =>
        Effect.gen(function* () {
          yield* appendOperationDisposers(cell, actionDisposers.take("action"));
          return makeActionFailure(cell, request, cause);
        })
    );
  });
}
