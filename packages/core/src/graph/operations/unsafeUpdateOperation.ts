import { type Context, Exit } from "effect";
import { prepareCommittedResult } from "../../node/committedResult";
import { stageResultDraft } from "../../node/resultDraft";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseReadyData, projectCellPhase } from "../cell/cellPhase";
import { finishObserverWork } from "../driverExecution/effectRunner";
import { updateReadyNodeRuntimeState } from "../planning/readyNodeRuntime";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import type { UnsafeUpdateNodeRequest, UnsafeUpdateNodeResult } from "../types";
import { runCommitBatch } from "./operationCommit";
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
    const previous = (node as { readonly result?: unknown }).result;
    // The updater receives a draft of committed data while other node fields
    // retain their unsafe write-through behavior.
    const drafted = stageResultDraft(
      previous,
      (current) => {
        const updater = Proxy.revocable(node, {
          get(target, key, receiver) {
            return key === "result" ? current : Reflect.get(target, key, receiver);
          },
        });
        try {
          request.recipe(updater.proxy);
        } finally {
          updater.revoke();
        }
      },
      false,
      { nonPlainClone: "share" },
      cell
    );
    result = {
      _tag: "Success",
      nodeId: cell.nodeId,
      value: prepareCommittedResult(drafted.value, previous, true, cell.development),
    };
  } catch (cause) {
    resume(Exit.succeed(makeUnsafeUpdateNodeFailure(cell, request, cause)));
    return noCancel;
  }
  let observerFailure: ReturnType<typeof runCommitBatch>;
  try {
    observerFailure = runCommitBatch(cell, () => {
      cell.state.updateSync(() => {
        ready.ready.result = result.value;
      });
      updateReadyNodeRuntimeState({ node, result: result.value, resultPatched: true });
    });
  } catch (cause) {
    resume(Exit.succeed(makeUnsafeUpdateNodeFailure(cell, request, cause)));
    return noCancel;
  }
  if (observerFailure !== undefined) {
    finishObserverWork(
      cell.reportObserverFailure({
        channel: "node-change",
        value: [cell.nodeId],
        cause: observerFailure.cause,
      }),
      context,
      () => notifyUnsafeUpdate(cell, result, context, resume),
      cell.jobs
    );
  } else {
    notifyUnsafeUpdate(cell, result, context, resume);
  }
  return noCancel;
}

function notifyUnsafeUpdate(
  cell: GraphNodeCell,
  result: UnsafeUpdateNodeResult,
  context: Context.Context<never> | undefined,
  resume: GraphResume<UnsafeUpdateNodeResult>
): void {
  finishObserverWork(
    cell.notifyChanged(cell.nodeId),
    context,
    () => resume(Exit.succeed(result)),
    cell.jobs
  );
}
