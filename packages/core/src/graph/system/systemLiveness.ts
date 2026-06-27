import { Effect, Match, type Semaphore } from "effect";
import type { GraphCellActorRegistry } from "../cell/actorRegistry";
import { acquireLiveLeaseOperation, releaseLiveLeaseOperation } from "../cell/cellOperations";
import { submitToCellActor } from "../cell/cellSubmission";
import { acquireNodeLiveLease, releaseNodeLiveLease } from "../liveness";
import { bridgeObservedResultLease } from "../liveness/resultObservationBridge";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import type { GraphPlanState } from "../planning/plan";
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
          getActor: options.actorRegistry.getActor,
        },
        request.nodeId,
        (cell, actor) => actor.submit(acquireLiveLeaseOperation(options.graphEnv, cell, request))
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
          getActor: options.actorRegistry.getActor,
        },
        request.nodeId,
        (cell, actor) => actor.submit(releaseLiveLeaseOperation(options.graphEnv, cell, request))
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
      if (result.failures.length > 0) {
        return { _tag: "Missing" } as const;
      }
      return result.changed || result.liveDemand.isLive
        ? ({ _tag: "Held", leaseId: result.leaseId } as const)
        : ({ _tag: "Missing" } as const);
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
    if (result.changed) {
      yield* observers.notifyLiveDemandChanged(result.nodeId, result.liveDemand);
    }
    if (result.failures.length > 0) {
      yield* observers.notifyLiveFailures(result.nodeId, result.failures);
    }
  });
}
