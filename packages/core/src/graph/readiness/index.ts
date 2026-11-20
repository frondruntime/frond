import { Cause, type Context, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import type { CellReadinessAttempt } from "../cell/cellPhase";
import { finishObserverWork } from "../driverExecution/effectRunner";
import { type GraphOperationEnvironment, startDependencyNodes } from "../operations/dependencies";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import { effectiveResultValidity } from "../resultValidity";
import type { NodeRead } from "../types";
import { startAcquire } from "./acquireOperation";
import { startExpiredInvalidation } from "./expiredInvalidation";
import { beginReadinessAttempt, startFailAttempt } from "./readinessAttempt";

export function checkCellReadiness(cell: GraphNodeCell, now: number) {
  const phase = cell.state.getSync().phase;
  switch (phase._tag) {
    case "Invalid":
      return {
        _tag: "Read",
        read: {
          _tag: "Invalid",
          nodeId: cell.nodeId,
          tag: cell.tag,
          status: { _tag: "Invalid", error: phase.error },
          nodeLookup: { _tag: "Missing" },
          error: phase.error,
        } satisfies NodeRead,
      } as const;
    case "Ready":
    case "Operating": {
      const ready = phase.ready;
      const validity = effectiveResultValidity(
        ready.resultValidity,
        ready.resultValidityPolicy,
        ready.resultLoadedAt,
        now
      );
      if (validity._tag === "Expired" && phase._tag === "Ready") {
        return { _tag: "Expired", ready, validity } as const;
      }
      return {
        _tag: "Read",
        read: {
          _tag: "Ready",
          nodeId: cell.nodeId,
          tag: cell.tag,
          status: { _tag: "Wired", run: { _tag: "Ready" } },
          node: ready.node,
          resultValidity: validity,
        } satisfies NodeRead,
      } as const;
    }
    case "Acquiring":
      return { _tag: "Pending", attempt: phase.attempt } as const;
    case "Idle":
    case "ReadinessError": {
      return { _tag: "Acquire", base: phase.base } as const;
    }
    default: {
      const unreachable: never = phase;
      return unreachable;
    }
  }
}

export function startReadiness(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  prepared: CellReadinessAttempt | undefined,
  context: Context.Context<never> | undefined,
  resume: GraphResume<NodeRead>
): GraphCancel {
  let attempt: CellReadinessAttempt;
  if (prepared === undefined) {
    const readiness = checkCellReadiness(cell, cell.syncClock.now());
    switch (readiness._tag) {
      case "Read":
        resume(Exit.succeed(readiness.read));
        return noCancel;
      case "Pending":
        return readiness.attempt.listen(resume);
      case "Expired":
        return startExpiredInvalidation(
          env,
          cell,
          readiness.ready,
          readiness.validity,
          context,
          resume
        );
      case "Acquire":
        attempt = beginReadinessAttempt(cell, readiness.base);
        break;
    }
  } else {
    attempt = prepared;
    const phase = cell.state.getSync().phase;
    if (phase._tag !== "Acquiring" || phase.attempt.attemptId !== attempt.attemptId)
      return attempt.listen(resume);
  }
  let canceled = false;
  let cancel: GraphCancel = noCancel;
  finishObserverWork(
    cell.notifyChanged(cell.nodeId),
    context,
    () => {
      if (canceled) return;
      let startedAcquire = false;
      const cancelDeps = startDependencyNodes(env, cell, context, (exit) => {
        if (canceled) return;
        startedAcquire = true;
        cancel =
          exit._tag === "Failure"
            ? startFailAttempt(cell, attempt, Cause.squash(exit.cause), undefined, context, resume)
            : startAcquire(env, cell, exit.value, attempt, context, resume);
      });
      if (!startedAcquire) cancel = cancelDeps;
    },
    cell.jobs
  );
  return () => {
    canceled = true;
    return cancel();
  };
}
