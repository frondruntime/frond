import { Clock, Effect } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import { effectiveResultValidity } from "../resultValidity";
import {
  GraphInvariantViolation,
  type RefreshRequest,
  type RefreshResult,
  ResultExpired,
} from "../types";
import type { GraphOperationEnvironment } from "./dependencies";
import { runReadyDriverOperation } from "./driverOperationSkeleton";
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

    return yield* runReadyDriverOperation<unknown, RefreshResult>({
      env,
      cell,
      phase: current.phase,
      readyData,
      operation: "refresh",
      boundary: "driver-refresh",
      timeout: env.driverTimeouts.refresh,
      disposerReason: "refresh",
      spanName: "frond.graph.refresh.driver",
      spanAttributes: {
        ...env.runtimeSpanAttributes,
        "frond.node.id": cell.nodeId,
        "frond.node.tag": cell.tag,
        "frond.driver.mode": cell.descriptor.driver.mode,
      },
      commitInput: ({ value, currentResultState, now }) => ({
        context: cell,
        returned: value,
        staged: currentResultState,
        defaultLoadedAt: now(),
      }),
      previousValidity: readyData.resultValidity,
      validityReason: "refresh",
      run: (ctx) => refresh.run(ctx),
      makeFailure: (cause) => makeRefreshFailure(cell, request, cause),
      makeSuccess: ({ committedResultState }) =>
        ({
          _tag: "Success",
          nodeId: cell.nodeId,
          value: committedResultState.result,
        }) satisfies RefreshResult,
    });
  });
}
