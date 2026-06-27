import { Clock, Effect } from "effect";
import { phaseArgs, phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import { makeDriverContext } from "../driverExecution/driverContext";
import {
  recoverDriverOperationFailure,
  runTimedDriverOperation,
} from "../driverExecution/driverOperationRunner";
import { interruptDriverOperation, makeOperationDisposers } from "../lifecycle/operationDisposers";
import type { GraphNodeCell } from "../planning/plan";
import { effectiveResultValidity, type ResultState } from "../resultValidity";
import {
  GraphInvariantViolation,
  type RefreshRequest,
  type RefreshResult,
  ResultExpired,
} from "../types";
import {
  collectDependencyValues,
  type GraphOperationEnvironment,
  refreshDependencyValue,
} from "./dependencies";
import { appendOperationDisposers, commitReadyOperationResult } from "./operationCommit";
import { makeRefreshFailure } from "./operationFailures";
import { runBackgroundOperation } from "./operationState";

export function refreshInCell(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: RefreshRequest
): Effect.Effect<RefreshResult> {
  return runBackgroundOperation(cell, "refresh", () => runRefreshDriver(env, cell, request));
}

export function runRefreshDriver(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: RefreshRequest
): Effect.Effect<RefreshResult> {
  return Effect.gen(function* () {
    const current = yield* cell.state.get;
    const projection = projectCellPhase(current.phase);

    if (projection._tag !== "Ready") {
      return makeRefreshFailure(
        cell,
        request,
        projection._tag === "Removed" ? { _tag: "Unwired" } : projection.status
      );
    }

    const ready = phaseReadyData(current.phase);

    if (ready._tag === "Missing") {
      return makeRefreshFailure(
        cell,
        request,
        new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: "refresh requires ready graph-owned node data",
        })
      );
    }
    const readyData = ready.ready;
    const readyNode = readyData.node;
    const clock = yield* Clock.Clock;
    const resultValidity = effectiveResultValidity(
      readyData.resultValidity,
      readyData.resultValidityPolicy,
      readyData.resultLoadedAt,
      clock.currentTimeMillisUnsafe()
    );

    if (resultValidity._tag === "Expired") {
      return makeRefreshFailure(
        cell,
        request,
        new ResultExpired({
          nodeId: cell.nodeId,
          tag: cell.tag,
          resultValidity,
        })
      );
    }

    const { refresh } = cell.descriptor.driver;

    if (refresh._tag === "Missing") {
      return {
        _tag: "Success",
        nodeId: cell.nodeId,
        value: readyData.result,
      } satisfies RefreshResult;
    }

    const depsResult = yield* collectDependencyValues(env, cell).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "Failure", cause }) as const,
        onSuccess: (deps) => ({ _tag: "Success", deps }) as const,
      })
    );

    if (depsResult._tag === "Failure") {
      return makeRefreshFailure(cell, request, depsResult.cause);
    }

    const abortController = new AbortController();
    const refreshDisposers = makeOperationDisposers(cell, env.state.notifyCleanupFailures);
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
      disposers: refreshDisposers,
      signals: env.signals,
      refreshDep: (dependencyName) => refreshDependencyValue(env, cell, dependencyName),
      now: () => clock.currentTimeMillisUnsafe(),
      getCurrentResultState: () => currentResultState,
      setCurrentResultState: (next) => {
        currentResultState = next;
      },
      cloneResultOnPatch: true,
    });

    return yield* recoverDriverOperationFailure(
      runTimedDriverOperation({
        cell,
        operation: "refresh",
        boundary: "driver-refresh",
        timeout: env.driverTimeouts.refresh,
        abortController,
        spanName: "frond.graph.refresh.driver",
        spanAttributes: {
          ...env.runtimeSpanAttributes,
          "frond.node.id": cell.nodeId,
          "frond.node.tag": cell.tag,
          "frond.driver.mode": cell.descriptor.driver.mode,
        },
        run: () => refresh.run(ctx),
      }).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.gen(function* () {
              yield* appendOperationDisposers(cell, refreshDisposers.take("refresh"));
              return makeRefreshFailure(cell, request, cause);
            }),
          onSuccess: (value) =>
            Effect.gen(function* () {
              yield* commitReadyOperationResult({
                cell,
                node: readyNode,
                deps: depsResult.deps,
                resultState: currentResultState,
                previousValidity: readyData.resultValidity,
                validityReason: "refresh",
                operationDisposers: refreshDisposers.take("refresh"),
              });

              return {
                _tag: "Success",
                nodeId: cell.nodeId,
                value,
              } satisfies RefreshResult;
            }),
        }),
        Effect.onInterrupt(() =>
          interruptDriverOperation({
            cell,
            abortController,
            disposers: refreshDisposers,
            notifyCleanupFailures: env.state.notifyCleanupFailures,
          })
        )
      ),
      "driver-refresh",
      (cause) =>
        Effect.gen(function* () {
          yield* appendOperationDisposers(cell, refreshDisposers.take("refresh"));
          return makeRefreshFailure(cell, request, cause);
        })
    );
  });
}
