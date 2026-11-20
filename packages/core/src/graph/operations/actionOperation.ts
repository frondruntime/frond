import { type Context, type Effect, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseReadyData } from "../cell/cellPhase";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import { startReadiness } from "../readiness";
import {
  type ActionRequest,
  type ActionResult,
  GraphInvariantViolation,
  type NodeRead,
  type RunningActionOperation,
} from "../types";
import type { GraphOperationEnvironment } from "./dependencies";
import { startReadyDriverOperation } from "./driverOperationSkeleton";
import { makeActionFailure } from "./operationFailures";
import { beginActionOperationSync, runOperation } from "./operationState";

/**
 * What an action's body and completion read beyond the cell and context. One
 * record per action, so the shared runner takes module-level callbacks.
 */
interface ActionRun {
  readonly env: GraphOperationEnvironment;
  readonly request: ActionRequest;
  readonly handle: NodeRead;
  readonly decided: (() => void) | undefined;
}

export function runActionInCell(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: ActionRequest,
  context: Context.Context<never> | undefined,
  resume: GraphResume<ActionResult>,
  decided?: () => void
): GraphCancel {
  let cancel: GraphCancel = noCancel;
  let canceled = false;
  let startedAction = false;
  const cancelReady = startReadiness(env, cell, undefined, context, (exit) => {
    if (exit._tag === "Success") {
      startedAction = true;
      if (canceled) return;
      cancel = startAction(env, cell, request, exit.value, context, resume, decided);
    } else resume(Exit.failCause(exit.cause));
  });
  if (!startedAction) cancel = cancelReady;
  return () => {
    canceled = true;
    return cancel();
  };
}

function startAction(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: ActionRequest,
  handle: NodeRead,
  context: Context.Context<never> | undefined,
  resume: GraphResume<ActionResult>,
  decided: (() => void) | undefined
): GraphCancel {
  const operation = beginActionOperationSync(cell, request.action, cell.syncClock.now());
  return runOperation(
    cell,
    operation,
    {
      _tag: "ActionStarted",
      nodeId: cell.nodeId,
      operation,
      action: request.action,
      input: request.input,
    },
    runActionBody,
    { env, request, handle, decided },
    context,
    resume,
    notifyActionCompletion
  );
}

function runActionBody(
  cell: GraphNodeCell,
  _operation: RunningActionOperation,
  run: ActionRun,
  context: Context.Context<never> | undefined,
  settled: GraphResume<ActionResult>
): GraphCancel {
  return runActionDriver(run.env, cell, run.request, run.handle, context, run.decided, settled);
}

function notifyActionCompletion(
  cell: GraphNodeCell,
  operation: RunningActionOperation,
  run: ActionRun,
  result: ActionResult
): Effect.Effect<void> {
  return cell.notifyActionCompleted({
    nodeId: cell.nodeId,
    operation,
    action: run.request.action,
    input: run.request.input,
    result,
    completedAt: cell.syncClock.now(),
  });
}

function runActionDriver(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: ActionRequest,
  readyHandle: NodeRead,
  context: Context.Context<never> | undefined,
  decided: (() => void) | undefined,
  resume: GraphResume<ActionResult>
): GraphCancel {
  const fail = (result: ActionResult) => {
    resume(Exit.succeed(result));
    return noCancel;
  };
  if (readyHandle.status._tag !== "Wired" || readyHandle.status.run._tag !== "Ready") {
    return fail(makeActionFailure(cell, request, notReadyCause(readyHandle)));
  }

  const action = cell.descriptor.driver.actions.read(request.action);

  if (action._tag === "Missing") {
    return fail(
      makeActionFailure(
        cell,
        request,
        new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: "requested action must exist on the node driver",
          cause: { action: action.action },
        })
      )
    );
  }

  const current = cell.state.getSync();
  const ready = phaseReadyData(current.phase);

  if (ready._tag === "Missing") {
    return fail(
      makeActionFailure(
        cell,
        request,
        new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: "action requires ready graph-owned node data",
        })
      )
    );
  }
  const readyData = ready.ready;

  return startReadyDriverOperation<unknown, ActionResult>(
    {
      env,
      cell,
      phase: current.phase,
      readyData,
      operation: `action:${request.action}`,
      boundary: "driver-action",
      // Per-action policy wins over the runtime default: a positive override
      // replaces the deadline, "unbounded" skips only the deadline (stop,
      // eviction, and caller interruption still interrupt the fiber).
      timeout: action.timeout ?? env.driverTimeouts.action,
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
      onDecided: decided,
      makeFailure: (cause) => makeActionFailure(cell, request, cause),
      makeSuccess: ({ value }) =>
        ({
          _tag: "Success",
          nodeId: cell.nodeId,
          value,
        }) satisfies ActionResult,
    },
    context,
    resume
  );
}

/**
 * The readiness failure itself when the implicit acquire failed, so the action
 * failure wraps the error that attempt already reported instead of a status.
 */
function notReadyCause(readyHandle: NodeRead): unknown {
  const { status } = readyHandle;

  if (status._tag === "Invalid") {
    return status.error;
  }

  if (status._tag === "Wired" && status.run._tag === "Error") {
    return status.run.error;
  }

  return status;
}
