import { type Context, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import { finishObserverWork } from "../driverExecution/effectRunner";
import { updateReadyNodeRuntimeState } from "../planning/readyNodeRuntime";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import type { UnsafeUpdateNodeRequest, UnsafeUpdateNodeResult } from "../types";
import { makeUnsafeUpdateNodeFailure } from "./operationFailures";

export function unsafeUpdateNodeInCell(
  cell: GraphNodeCell,
  request: UnsafeUpdateNodeRequest,
  context: Context.Context<never> | undefined,
  resume: GraphResume<UnsafeUpdateNodeResult>
): GraphCancel {
  const phase = cell.state.getSync().phase;
  const projection = projectCellPhase(phase);
  const ready = phaseReadyData(phase);
  if (
    projection._tag === "Removed" ||
    projection.status._tag !== "Wired" ||
    ready._tag === "Missing"
  ) {
    resume(
      Exit.succeed(
        makeUnsafeUpdateNodeFailure(
          cell,
          request,
          projection._tag === "Removed" ? { _tag: "Unwired" } : projection.status
        )
      )
    );
    return noCancel;
  }
  const { node } = ready.ready;
  let result: UnsafeUpdateNodeResult;
  try {
    request.recipe(node);
    result = {
      _tag: "Success",
      nodeId: cell.nodeId,
      value: (node as { readonly result?: unknown }).result,
    };
  } catch (cause) {
    resume(Exit.succeed(makeUnsafeUpdateNodeFailure(cell, request, cause)));
    return noCancel;
  }
  cell.state.updateSync(() => {
    ready.ready.result = result.value;
  });
  updateReadyNodeRuntimeState({ node, result: result.value });
  finishObserverWork(
    cell.notifyChanged(cell.nodeId),
    context,
    () => resume(Exit.succeed(result)),
    cell.jobs
  );
  return noCancel;
}
