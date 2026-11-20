import type { Context } from "effect";
import { Effect, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import {
  type CellBase,
  type CellPhase,
  type CellReadinessAttempt,
  phaseBase,
} from "../cell/cellPhase";
import { beginReadinessAttemptState, failReadinessAttemptState } from "../cell/cellTransitions";
import { finishObserverWork } from "../driverExecution/effectRunner";
import { type GraphCancel, GraphReply, type GraphResume, noCancel } from "../queue/reply";
import { GraphInvariantViolation, type NodeRead, type ResultValidity } from "../types";
import { recordSourceFailure } from "./sourceFailures";

export function startFailAttempt(
  cell: GraphNodeCell,
  attempt: CellReadinessAttempt,
  cause: unknown,
  resultValidity: ResultValidity | undefined,
  context: Context.Context<never> | undefined,
  resume: GraphResume<NodeRead>
): GraphCancel {
  const phase = cell.state.getSync().phase;
  if (phase._tag !== "Acquiring" || phase.attempt.attemptId !== attempt.attemptId)
    return attempt.listen(resume);
  const status = { _tag: "Wired", run: { _tag: "Error", error: cause } } as const;
  cell.state.updateSync((latest) => {
    failReadinessAttemptState({ latest, cause, resultValidity });
  });
  finishObserverWork(
    cell.notifyChanged(cell.nodeId),
    context,
    () => {
      recordSourceFailure(cause);
      finishObserverWork(
        cell.notifyReadinessFailed(cell.nodeId, cause),
        context,
        () => {
          const handle = failedReadFromPhase(cell, cell.state.getSync().phase, cause, status);
          attempt.resolve(handle);
          resume(Exit.succeed(handle));
        },
        cell.jobs
      );
    },
    cell.jobs
  );
  return noCancel;
}

export function completeAttempt(
  attempt: CellReadinessAttempt,
  handle: NodeRead
): Effect.Effect<void> {
  return Effect.sync(() => attempt.resolve(handle));
}

function resultValidityFromPhase(phase: CellPhase): ResultValidity | undefined {
  const base = phaseBase(phase);

  return base._tag === "Found" ? base.base.resultValidity : undefined;
}

function failedReadFromPhase(
  cell: GraphNodeCell,
  phase: CellPhase,
  cause: unknown,
  status: Extract<NodeRead, { readonly _tag: "Error" }>["status"]
): NodeRead {
  const base = phaseBase(phase);
  const resultValidity = resultValidityFromPhase(phase);

  if (base._tag === "Found") {
    return {
      _tag: "Error",
      nodeId: cell.nodeId,
      tag: cell.tag,
      status,
      error: cause,
      resultValidity,
    };
  }

  const error = new GraphInvariantViolation({
    nodeId: cell.nodeId,
    tag: cell.tag,
    invariant: "failed readiness attempt must retain graph-owned node base",
    cause: { phase: base.phase, readinessFailure: cause },
  });

  return {
    _tag: "Invalid",
    nodeId: cell.nodeId,
    tag: cell.tag,
    status: { _tag: "Invalid", error },
    nodeLookup: { _tag: "Missing" },
    error,
    resultValidity,
  };
}

export function beginReadinessAttempt(cell: GraphNodeCell, base: CellBase): CellReadinessAttempt {
  const attemptId = cell.state.getSync().nextAttemptId + 1;
  const reply = new GraphReply<NodeRead>();
  let resolvePromise!: (handle: NodeRead) => void;
  const promise = new Promise<NodeRead>((resolve) => {
    resolvePromise = resolve;
  });
  let settled = false;
  const attempt: CellReadinessAttempt = {
    attemptId,
    get await() {
      return reply.await;
    },
    listen: reply.listen,
    promise,
    resolve(handle) {
      if (settled) return;
      settled = true;
      reply.settle(Exit.succeed(handle));
      resolvePromise(handle);
    },
  };
  cell.state.updateSync((latest) => {
    beginReadinessAttemptState({ latest, attemptId, base, attempt });
  });
  return attempt;
}
