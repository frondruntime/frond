import { Clock, Effect } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseReadyData } from "../cell/cellPhase";
import {
  type ActionRequest,
  type ActionResult,
  GraphInvariantViolation,
  type NodeRead,
  type RunningActionOperation,
} from "../types";
import type { GraphOperationEnvironment } from "./dependencies";
import { runReadyDriverOperation } from "./driverOperationSkeleton";
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

    return yield* runReadyDriverOperation<unknown, ActionResult>({
      env,
      cell,
      phase: current.phase,
      readyData,
      operation: `action:${request.action}`,
      boundary: "driver-action",
      timeout: env.driverTimeouts.action,
      disposerReason: "action",
      spanName: "frond.graph.action.driver",
      spanAttributes: {
        ...env.runtimeSpanAttributes,
        "frond.node.id": cell.nodeId,
        "frond.node.tag": cell.tag,
        "frond.action": request.action,
        "frond.driver.mode": cell.descriptor.driver.mode,
      },
      setResultDefaultValidity: "preserve",
      commitInput: ({ currentResultState, now }) => {
        const commitNow = now();

        return {
          context: cell,
          returned: undefined,
          staged: currentResultState,
          defaultLoadedAt: commitNow,
          defaultValidity: "preserve",
        };
      },
      previousValidity: readyData.resultValidity,
      validityReason: "manual",
      run: (ctx) => action.run(ctx, request.input),
      makeFailure: (cause) => makeActionFailure(cell, request, cause),
      makeSuccess: ({ value }) =>
        ({
          _tag: "Success",
          nodeId: cell.nodeId,
          value,
        }) satisfies ActionResult,
    });
  });
}
