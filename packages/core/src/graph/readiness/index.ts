import { Clock, Deferred, Effect } from "effect";
import { phaseBase } from "../cell/cellPhase";
import { ensureDependencyNodes, type GraphOperationEnvironment } from "../operations/dependencies";
import type { GraphNodeCell } from "../planning/plan";
import { effectiveResultValidity } from "../resultValidity";
import type { NodeRead } from "../types";
import { runAcquire } from "./acquireOperation";
import { runExpiredInvalidationAttempt } from "./expiredInvalidation";
import { failAttempt, runReadinessAttempt } from "./readinessAttempt";

export function ensureReadyCell(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const current = yield* cell.state.get;

    if (current.phase._tag === "Evicted") {
      return { _tag: "Unwired", nodeId: cell.nodeId, status: { _tag: "Unwired" } };
    }

    if (current.phase._tag === "Invalid") {
      return {
        _tag: "Invalid",
        nodeId: cell.nodeId,
        tag: cell.tag,
        status: { _tag: "Invalid", error: current.phase.error },
        nodeLookup: { _tag: "Missing" },
        error: current.phase.error,
      };
    }

    if (current.phase._tag === "Ready" || current.phase._tag === "Operating") {
      const ready = current.phase.ready;
      const now = yield* Clock.currentTimeMillis;
      const effectiveValidity = effectiveResultValidity(
        ready.resultValidity,
        ready.resultValidityPolicy,
        ready.resultLoadedAt,
        now
      );

      if (effectiveValidity._tag === "Expired" && current.phase._tag === "Ready") {
        return yield* runExpiredInvalidationAttempt(env, cell, ready, effectiveValidity);
      }

      // Contract: the handle always reports the effective validity. An
      // Operating cell defers the invalidation itself (never stomp a running
      // operation), but dependents must still see a clock-expired dependency.
      return {
        _tag: "Ready",
        nodeId: cell.nodeId,
        tag: cell.tag,
        status: { _tag: "Wired", run: { _tag: "Ready" } },
        node: ready.node,
        resultValidity: effectiveValidity,
      };
    }

    if (current.phase._tag === "Acquiring") {
      return yield* Deferred.await(current.phase.attempt.deferred);
    }

    const base = phaseBase(current.phase);

    if (base._tag === "Missing") {
      return { _tag: "Unwired", nodeId: cell.nodeId, status: { _tag: "Unwired" } };
    }

    return yield* runReadinessAttempt(cell, base.base, (attempt) =>
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
