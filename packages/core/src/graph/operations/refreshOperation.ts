import { type Context, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import { effectiveResultValidity } from "../resultValidity";
import { type RefreshRequest, type RefreshResult, ResultExpired } from "../types";
import type { GraphOperationEnvironment } from "./dependencies";
import { startReadyDriverOperation } from "./driverOperationSkeleton";
import { makeRefreshFailure } from "./operationFailures";
import { startBackgroundOperation } from "./operationState";

export function startRefresh(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: RefreshRequest,
  context: Context.Context<never> | undefined,
  resume: GraphResume<RefreshResult>,
  decided?: () => void
): GraphCancel {
  return startBackgroundOperation(
    cell,
    "refresh",
    (_operation, settled) => startRefreshDriver(env, cell, request, context, settled, decided),
    context,
    resume
  );
}

export function startRefreshDriver(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: RefreshRequest,
  context: Context.Context<never> | undefined,
  resume: GraphResume<RefreshResult>,
  decided?: () => void
): GraphCancel {
  const complete = (result: RefreshResult) => {
    resume(Exit.succeed(result));
    return noCancel;
  };
  const current = cell.state.getSync();
  const ready = phaseReadyData(current.phase);

  if (ready._tag === "Missing") {
    // Only the Ready and Operating phases hold ready data, and they are the
    // only phases `projectCellPhase` projects as "Ready": project the rest for
    // the failure status.
    const projection = projectCellPhase(current.phase);
    return complete(
      makeRefreshFailure(
        cell,
        request,
        projection._tag === "Removed" ? { _tag: "Unwired" } : projection.status
      )
    );
  }
  const readyData = ready.ready;
  const clock = cell.syncClock;
  const resultValidity = effectiveResultValidity(
    readyData.resultValidity,
    readyData.resultValidityPolicy,
    readyData.resultLoadedAt,
    clock.now()
  );

  if (resultValidity._tag === "Expired") {
    return complete(
      makeRefreshFailure(
        cell,
        request,
        new ResultExpired({
          nodeId: cell.nodeId,
          tag: cell.tag,
          resultValidity,
        })
      )
    );
  }

  const { refresh } = cell.descriptor.driver;

  if (refresh._tag === "Missing") {
    return complete({
      _tag: "Success",
      nodeId: cell.nodeId,
      value: readyData.result,
    } satisfies RefreshResult);
  }

  return startReadyDriverOperation<unknown, RefreshResult>(
    {
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
        retainEqual: readyData,
        returned: value,
        staged: currentResultState,
        defaultLoadedAt: now(),
      }),
      previousValidity: readyData.resultValidity,
      validityReason: "refresh",
      run: (ctx) => refresh.run(ctx),
      onDecided: decided,
      makeFailure: (cause) => makeRefreshFailure(cell, request, cause),
      makeSuccess: ({ committedResultState }) =>
        ({
          _tag: "Success",
          nodeId: cell.nodeId,
          value: committedResultState.result,
        }) satisfies RefreshResult,
    },
    context,
    resume
  );
}
