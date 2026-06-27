import { Effect } from "effect";
import type { CellBase, ReadyData } from "../cell/cellPhase";
import { teardownReadyData } from "../lifecycle/cleanup";
import { ensureDependencyNodes, type GraphOperationEnvironment } from "../operations/dependencies";
import type { GraphNodeCell } from "../planning/plan";
import { validityChanged } from "../resultValidity";
import type { NodeRead, ResultValidity } from "../types";
import { runAcquire } from "./acquireOperation";
import { failAttempt, runReadinessAttempt } from "./readinessAttempt";

export function runExpiredInvalidationAttempt(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  ready: ReadyData,
  expiredValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    // Contract: re-acquiring after expiry discards the current ready generation,
    // so it must run the full teardown (live stop, driver release, disposers).
    const cleanupFailures = yield* teardownReadyData(
      cell,
      ready,
      { release: env.driverTimeouts.release, live: env.driverTimeouts.live },
      { _tag: "ReadyInvalidated" }
    );

    if (cleanupFailures.length > 0) {
      yield* env.state.notifyCleanupFailures(cell.nodeId, "expired-invalidation", cleanupFailures);
    }

    const base = expiredInvalidationBase(ready, expiredValidity);

    if (validityChanged(ready.resultValidity, expiredValidity)) {
      yield* cell.notifyResultValidityChanged(
        cell.nodeId,
        ready.resultValidity,
        expiredValidity,
        "time-bound"
      );
    }

    return yield* runReadinessAttempt(cell, base, (attempt) =>
      Effect.gen(function* () {
        const depsResult = yield* ensureDependencyNodes(env, cell).pipe(
          Effect.match({
            onFailure: (failure) => ({ _tag: "Failure", failure }) as const,
            onSuccess: (deps) => ({ _tag: "Success", deps }) as const,
          })
        );

        if (depsResult._tag === "Failure") {
          return yield* failAttempt(cell, attempt, depsResult.failure);
        }

        return yield* runAcquire(env, cell, depsResult.deps, attempt);
      })
    );
  });
}

function expiredInvalidationBase(
  ready: ReadyData,
  resultValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>
): CellBase {
  return {
    args: ready.args,
    liveLeases: ready.liveLeases,
    resultValidity,
    liveFailure: ready.liveFailure,
  };
}
