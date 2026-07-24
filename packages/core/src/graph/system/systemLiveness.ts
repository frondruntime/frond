import { Effect, Match, type Semaphore } from "effect";
import type { GraphCellActorRegistry } from "../cell/actorRegistry";
import type { GraphPlanState } from "../cell/cellModel";
import { acquireLiveLeaseOperation, releaseLiveLeaseOperation } from "../cell/cellOperations";
import { submitToCellActor } from "../cell/cellSubmission";
import { acquireNodeLiveLease, releaseNodeLiveLease } from "../liveness";
import { bridgeObservedResultLease } from "../liveness/resultObservationBridge";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import type {
  AcquireNodeLiveLeaseRequest,
  NodeId,
  NodeLiveLeaseId,
  NodeLiveLeaseResult,
  ObservedResultLease,
  ReleaseNodeLiveLeaseRequest,
} from "../types";
import type { GraphSystemObservers } from "./systemObservers";

export interface GraphSystemLiveness {
  readonly nextLiveLeaseId: () => NodeLiveLeaseId;
  readonly reportResultObserved: (
    nodeId: NodeId,
    scope: unknown,
    observed: boolean,
    lease: ObservedResultLease
  ) => Promise<ObservedResultLease>;
  readonly acquireNodeLiveLease: (
    request: AcquireNodeLiveLeaseRequest
  ) => Effect.Effect<NodeLiveLeaseResult>;
  readonly releaseNodeLiveLease: (
    request: ReleaseNodeLiveLeaseRequest
  ) => Effect.Effect<NodeLiveLeaseResult>;
}

export function makeGraphSystemLiveness(options: {
  readonly state: GraphPlanState;
  readonly planningSemaphore: ReturnType<typeof Semaphore.makeUnsafe>;
  readonly actorRegistry: GraphCellActorRegistry;
  readonly graphEnv: GraphOperationEnvironment;
  readonly observers: GraphSystemObservers;
}): GraphSystemLiveness {
  let liveLeaseCounter = 0;

  const nextLiveLeaseId = (): NodeLiveLeaseId => {
    liveLeaseCounter += 1;
    return `live-lease:${liveLeaseCounter}` as NodeLiveLeaseId;
  };

  const acquireNodeLiveLeaseInActor = (
    request: AcquireNodeLiveLeaseRequest
  ): Effect.Effect<NodeLiveLeaseResult> =>
    Effect.gen(function* () {
      const submission = yield* submitToCellActor(
        {
          state: options.state,
          planningSemaphore: options.planningSemaphore,
          submit: options.actorRegistry.submit,
        },
        request.nodeId,
        (cell) => acquireLiveLeaseOperation(options.graphEnv, cell, request)
      );

      const result = yield* Match.value(submission).pipe(
        Match.tag("Submitted", ({ task }) => task.await),
        Match.tag("Missing", ({ nodeId }) =>
          acquireNodeLiveLease(
            options.state,
            { _tag: "Missing", nodeId },
            request,
            options.graphEnv.driverTimeouts.live
          )
        ),
        Match.exhaustive
      );

      yield* notifyLiveResult(options.observers, result);
      return result;
    });

  const releaseNodeLiveLeaseInActor = (
    request: ReleaseNodeLiveLeaseRequest
  ): Effect.Effect<NodeLiveLeaseResult> =>
    Effect.gen(function* () {
      const submission = yield* submitToCellActor(
        {
          state: options.state,
          planningSemaphore: options.planningSemaphore,
          submit: options.actorRegistry.submit,
        },
        request.nodeId,
        (cell) => releaseLiveLeaseOperation(options.graphEnv, cell, request)
      );

      const result = yield* Match.value(submission).pipe(
        Match.tag("Submitted", ({ task }) => task.await),
        Match.tag("Missing", ({ nodeId }) =>
          releaseNodeLiveLease(
            { _tag: "Missing", nodeId },
            request,
            options.graphEnv.driverTimeouts.live
          )
        ),
        Match.exhaustive
      );

      yield* notifyLiveResult(options.observers, result);
      return result;
    });

  const acquireObservedResultLease = (
    nodeId: NodeId,
    scope: unknown,
    lease: ObservedResultLease
  ): Effect.Effect<ObservedResultLease> => {
    if (lease._tag === "Held") {
      return Effect.succeed(lease);
    }

    return Effect.gen(function* () {
      const result = yield* acquireNodeLiveLeaseInActor({
        nodeId,
        source: "mobx",
        scope,
      });
      return Match.value(result).pipe(
        Match.tag("Held", (held) =>
          held.changed || held.liveDemand.isLive
            ? ({ _tag: "Held", leaseId: held.leaseId } as const)
            : ({ _tag: "Missing" } as const)
        ),
        Match.tag("Failed", () => ({ _tag: "Missing" }) as const),
        Match.tag("NodeMissing", () => ({ _tag: "Missing" }) as const),
        Match.exhaustive
      );
    });
  };

  const releaseObservedResultLease = (
    nodeId: NodeId,
    lease: ObservedResultLease
  ): Effect.Effect<ObservedResultLease> => {
    if (lease._tag === "Missing") {
      return Effect.succeed({ _tag: "Missing" } as const);
    }

    return releaseNodeLiveLeaseInActor({ nodeId, leaseId: lease.leaseId }).pipe(
      Effect.as({ _tag: "Missing" } as const)
    );
  };

  return {
    nextLiveLeaseId,
    reportResultObserved: (nodeId, scope, observed, lease) =>
      bridgeObservedResultLease(
        observed
          ? acquireObservedResultLease(nodeId, scope, lease)
          : releaseObservedResultLease(nodeId, lease)
      ),
    acquireNodeLiveLease: acquireNodeLiveLeaseInActor,
    releaseNodeLiveLease: releaseNodeLiveLeaseInActor,
  };
}

function notifyLiveResult(
  observers: GraphSystemObservers,
  result: NodeLiveLeaseResult
): Effect.Effect<void> {
  return Effect.gen(function* () {
    yield* Match.value(result).pipe(
      Match.tag("Held", (held) =>
        Effect.gen(function* () {
          if (held.changed) {
            yield* observers.notifyLiveDemandChanged(held.nodeId, held.liveDemand);
          }
          if (held.failures.length > 0) {
            yield* observers.notifyLiveFailures(held.nodeId, held.failures);
          }
        })
      ),
      Match.tag("Failed", (failed) =>
        failed.failures.length > 0
          ? observers.notifyLiveFailures(failed.nodeId, failed.failures)
          : Effect.void
      ),
      Match.tag("NodeMissing", () => Effect.void),
      Match.exhaustive
    );
  });
}
