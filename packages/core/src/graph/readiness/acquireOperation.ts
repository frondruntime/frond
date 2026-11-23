import { Cause, type Context, Effect, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import {
  type CellReadinessAttempt,
  phaseBase,
  phaseLiveLeases,
  projectLiveDemand,
} from "../cell/cellPhase";
import { completeAcquireState } from "../cell/cellTransitions";
import { makeAcquireDriverContext } from "../driverExecution/driverContext";
import { startEdge } from "../driverExecution/driverOperationRunner";
import { effectBoundaryFailed } from "../driverExecution/effectBoundary";
import { finishObserverWork, runEffectEdge } from "../driverExecution/effectRunner";
import {
  bridgeNodeActionEffectRunner,
  bridgeNodeActionRunner,
} from "../driverExecution/nodeActionBridge";
import { makeAcquireNodeLifetime } from "../lifecycle/nodeLifetime";
import { interruptDriverOperation, makeOperationDisposers } from "../lifecycle/operationDisposers";
import { deliverLiveDemand } from "../liveness";
import { makeResultObservedReporter } from "../liveness/resultObservationBridge";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import { constructReadyNode } from "../planning/nodeMaterialization";
import { type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import {
  commitDriverOperationResult,
  commitResultState,
  type ResultState,
  resultValidityInvariantFailure,
  validityChanged,
} from "../resultValidity";
import {
  AcquireFailed,
  GraphInvariantViolation,
  type NodeRead,
  ResultExpired,
  type ResultValidity,
} from "../types";
import { startFailAttempt } from "./readinessAttempt";

export function startAcquire(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  deps: Record<string, object>,
  attempt: CellReadinessAttempt,
  context: Context.Context<never> | undefined,
  resume: GraphResume<NodeRead>
): GraphCancel {
  const base = phaseBase(cell.state.getSync().phase);
  if (base._tag === "Missing")
    return startFailAttempt(
      cell,
      attempt,
      new AcquireFailed({
        nodeId: cell.nodeId,
        tag: cell.tag,
        cause: new GraphInvariantViolation({
          nodeId: cell.nodeId,
          tag: cell.tag,
          invariant: "acquire requires retained graph args",
        }),
      }),
      undefined,
      context,
      resume
    );
  const abortController = new AbortController();
  const nodeLifetime = makeAcquireNodeLifetime();
  const disposers = makeOperationDisposers(
    cell,
    env.state.notifyCleanupFailures,
    env.driverTimeouts.release
  );
  const now = cell.syncClock.now;
  const startedAt = now();
  let resultState = commitResultState(undefined, undefined, cell.resultValidityPolicy, startedAt, {
    context: cell,
    defaultLoadedAt: startedAt,
  });
  let canceled = false;
  let cancel: GraphCancel = noCancel;
  const ctx = makeAcquireDriverContext({
    cell,
    args: base.base.args,
    deps,
    abortController,
    nodeSignal: nodeLifetime.signal,
    disposers,
    signals: env.signals,
    now,
    getCurrentResultState: () => resultState,
    setCurrentResultState: (next) => {
      resultState = next;
    },
    resultPatch: cell.descriptor.driver.resultPatch,
  });
  const cleanup = (next: () => void) => {
    nodeLifetime.abortIfUnowned();
    runEffectEdge(disposers.drain("acquire"), context, (exit) => {
      if (exit._tag === "Failure") {
        resume(Exit.failCause(exit.cause));
        return;
      }
      if (exit.value.length === 0) next();
      else
        finishObserverWork(
          env.state.notifyCleanupFailures(cell.nodeId, "acquire", exit.value),
          context,
          next,
          cell.jobs
        );
    });
  };
  const fail = (cause: unknown, validity?: ResultValidity) =>
    cleanup(() => {
      if (!canceled)
        startFailAttempt(
          cell,
          attempt,
          cause instanceof AcquireFailed
            ? cause
            : new AcquireFailed({ nodeId: cell.nodeId, tag: cell.tag, cause }),
          validity,
          context,
          resume
        );
    });
  const complete = (committed: ResultState) => {
    const latest = cell.state.getSync();
    if (latest.phase._tag !== "Acquiring" || latest.phase.attempt.attemptId !== attempt.attemptId) {
      cleanup(() => attempt.listen(resume));
      return;
    }
    const currentBase = latest.phase.base;
    const constructed = constructReadyNode(cell.request, {
      nodeId: cell.nodeId,
      tag: cell.tag,
      construction: {
        nodeId: cell.nodeId,
        tag: cell.tag,
        args: currentBase.args,
        deps,
        result: committed.result,
        action: bridgeNodeActionRunner(env.state.executeNodeActionDirect, cell.nodeId),
        actionEffect: bridgeNodeActionEffectRunner(env.state.executeNodeAction, cell.nodeId),
        reportResultObserved: makeResultObservedReporter(env.state, {
          nodeId: cell.nodeId,
          tag: cell.tag,
        }),
        addDisposer: disposers.add,
      },
    });
    if (constructed._tag === "Failure") {
      fail(constructed.failure);
      return;
    }
    const node = constructed.value;
    const previousValidity = currentBase.resultValidity;
    cell.state.updateSync((latest) =>
      completeAcquireState({
        latest,
        attempt,
        ready: {
          node,
          args: currentBase.args,
          deps,
          resultState: committed,
          resultValidityPolicy: cell.resultValidityPolicy,
          disposers: disposers.handOff(),
          nodeLifetime: nodeLifetime.handOff(),
        },
      })
    );
    const finish = () => {
      if (canceled) return;
      const read: NodeRead = {
        _tag: "Ready",
        nodeId: cell.nodeId,
        tag: cell.tag,
        status: { _tag: "Wired", run: { _tag: "Ready" } },
        node,
        resultValidity: committed.resultValidity,
      };
      attempt.resolve(read);
      resume(Exit.succeed(read));
    };
    const live = () => {
      const demand = projectLiveDemand(phaseLiveLeases(cell.state.getSync().phase));
      if (!demand.isLive || cell.descriptor.driver.live._tag === "Missing") {
        finish();
        return;
      }
      cancel = runEffectEdge(
        deliverLiveDemand(cell, demand, env.driverTimeouts.live),
        context,
        (exit) => {
          if (exit._tag === "Failure") {
            resume(Exit.failCause(exit.cause));
            return;
          }
          if (exit.value.length === 0) {
            finish();
            return;
          }
          finishObserverWork(
            env.state.notifyLiveFailures(cell.nodeId, exit.value),
            context,
            () => finishObserverWork(cell.notifyChanged(cell.nodeId), context, finish, cell.jobs),
            cell.jobs
          );
        }
      );
    };
    finishObserverWork(
      cell.notifyChanged(cell.nodeId),
      context,
      () => {
        if (
          previousValidity !== undefined &&
          validityChanged(previousValidity, committed.resultValidity)
        )
          finishObserverWork(
            cell.notifyResultValidityChanged(
              cell.nodeId,
              previousValidity,
              committed.resultValidity,
              "acquire"
            ),
            context,
            live,
            cell.jobs
          );
        else live();
      },
      cell.jobs
    );
  };
  cancel = startEdge(
    {
      cell,
      operation: "acquire",
      boundary: "readiness-acquire",
      timeout: env.driverTimeouts.acquire,
      abortController,
      spanName: "frond.graph.acquire",
      spanAttributes: {
        ...env.runtimeSpanAttributes,
        "frond.node.id": cell.nodeId,
        "frond.node.tag": cell.tag,
        "frond.node.attempt_id": attempt.attemptId,
        "frond.driver.mode": cell.descriptor.driver.mode,
      },
      run: () => cell.descriptor.driver.acquire(ctx),
    },
    context,
    (exit) => {
      if (canceled) return;
      if (exit._tag === "Failure") {
        fail(Cause.squash(exit.cause));
        return;
      }
      let committed: ResultState;
      try {
        committed = commitDriverOperationResult(
          cell.resultValidityPolicy,
          now(),
          {
            context: cell,
            returned: exit.value,
            staged: resultState,
            defaultLoadedAt: now(),
            retainEqual: base.base.previousResult,
          },
          cell.development
        );
      } catch (cause) {
        fail(resultValidityInvariantFailure(cell, "driver result commit failed", cause));
        return;
      }
      if (committed.resultValidity._tag === "Expired") {
        fail(
          new ResultExpired({
            nodeId: cell.nodeId,
            tag: cell.tag,
            resultValidity: committed.resultValidity,
          }),
          committed.resultValidity
        );
        return;
      }
      try {
        complete(committed);
      } catch (cause) {
        fail(effectBoundaryFailed("readiness-acquire", Cause.die(cause)));
      }
    }
  );
  return () => {
    canceled = true;
    nodeLifetime.abortIfUnowned();
    return cancel().pipe(
      Effect.andThen(
        interruptDriverOperation({
          cell,
          abortController,
          disposers,
          notifyCleanupFailures: env.state.notifyCleanupFailures,
        })
      )
    );
  };
}
