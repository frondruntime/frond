import { type Context, Exit } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import type { ReadyData } from "../cell/cellPhase";
import { finishObserverWork, runEffectEdge } from "../driverExecution/effectRunner";
import { teardownReadyData } from "../lifecycle/cleanup";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import type { GraphCancel, GraphResume } from "../queue/reply";
import { validityChanged } from "../resultValidity";
import type { NodeRead, ResultValidity } from "../types";
import { startReadiness } from "./index";
import { beginReadinessAttempt } from "./readinessAttempt";

export function startExpiredInvalidation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  ready: ReadyData,
  expiredValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>,
  context: Context.Context<never> | undefined,
  resume: GraphResume<NodeRead>
): GraphCancel {
  let canceled = false;
  let cancel = runEffectEdge(
    teardownReadyData(
      cell,
      ready,
      { release: env.driverTimeouts.release, live: env.driverTimeouts.live },
      { _tag: "ReadyInvalidated" }
    ),
    context,
    (exit) => {
      cell.jobs.post({
        run: () => {
          if (canceled) return;
          if (exit._tag === "Failure") {
            resume(Exit.failCause(exit.cause));
            return;
          }
          const acquire = () => {
            if (canceled) return;
            const attempt = beginReadinessAttempt(cell, {
              args: ready.args,
              previousResult: { result: ready.result },
              liveLeases: ready.liveLeases,
              resultValidity: expiredValidity,
              liveFailure: ready.liveFailure,
            });
            cancel = startReadiness(env, cell, attempt, context, resume);
          };
          const invalidate = () => {
            if (canceled) return;
            if (validityChanged(ready.resultValidity, expiredValidity))
              finishObserverWork(
                cell.notifyResultValidityChanged(
                  cell.nodeId,
                  ready.resultValidity,
                  expiredValidity,
                  "time-bound"
                ),
                context,
                acquire,
                cell.jobs
              );
            else acquire();
          };
          if (exit.value.length === 0) invalidate();
          else
            finishObserverWork(
              env.state.notifyCleanupFailures(cell.nodeId, "expired-invalidation", exit.value),
              context,
              invalidate,
              cell.jobs
            );
        },
      });
    }
  );
  return () => {
    canceled = true;
    return cancel();
  };
}
