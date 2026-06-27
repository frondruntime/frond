import { Clock, Effect } from "effect";
import type { GraphNodeCellLookup } from "../cell/cellLookup";
import {
  activeLiveDemand,
  type CellLiveLease,
  type LiveResourceState,
  mapPhaseBase,
  mapPhaseReady,
  phaseLiveLeases,
  phaseReadyData,
  projectLiveDemand,
} from "../cell/cellPhase";
import { makeLiveContext, makeLiveStopContext } from "../driverExecution/driverContext";
import { runTimedDriverOperation } from "../driverExecution/driverOperationRunner";
import { interruptedCancellation } from "../lifecycle/operationDisposers";
import { canonicalKey } from "../planning/canonicalKey";
import type { GraphNodeCell, GraphPlanState } from "../planning/plan";
import type {
  AcquireNodeLiveLeaseRequest,
  ActiveNodeLiveDemandSnapshot,
  DriverOperationTimeoutMs,
  GraphFailure,
  GraphInvariantViolation as GraphInvariantViolationType,
  LiveResourceStopReason,
  NodeLiveDemandSnapshot,
  NodeLiveFailure,
  NodeLiveLeaseResult,
  NodeLiveScopeKey,
  ReleaseNodeLiveLeaseRequest,
} from "../types";
import {
  GraphInvariantViolation as GraphInvariantViolationError,
  LiveDeliveryFailed,
} from "../types";

export function acquireNodeLiveLease(
  state: Pick<GraphPlanState, "nextLiveLeaseId">,
  cellLookup: GraphNodeCellLookup,
  request: AcquireNodeLiveLeaseRequest,
  liveTimeout: DriverOperationTimeoutMs
): Effect.Effect<NodeLiveLeaseResult> {
  return Effect.gen(function* () {
    if (cellLookup._tag === "Missing") {
      const leaseId = state.nextLiveLeaseId();
      return {
        nodeId: request.nodeId,
        leaseId,
        liveDemand: projectLiveDemand([]),
        changed: false,
        failures: [],
      };
    }

    const { cell } = cellLookup;
    const leaseId = state.nextLiveLeaseId();
    const scopeKeyResult = liveScopeKey(cell, request.scope);

    if ("failure" in scopeKeyResult) {
      const current = yield* cell.state.get;
      return {
        nodeId: request.nodeId,
        leaseId,
        liveDemand: projectLiveDemand(phaseLiveLeases(current.phase)),
        changed: false,
        failures: [scopeKeyResult.failure],
      };
    }

    const scopeKey = scopeKeyResult.scopeKey;
    const { changed, liveDemand } = yield* cell.state.transition((latest) => {
      const latestLiveLeases = phaseLiveLeases(latest.phase);
      const liveLeases = [
        ...latestLiveLeases,
        {
          leaseId,
          source: request.source,
          scope: request.scope,
          scopeKey,
        },
      ];
      const nextDemand = projectLiveDemand(liveLeases);
      const changed = !sameLiveLeasesDemand(latestLiveLeases, liveLeases);
      return [
        { changed, liveDemand: nextDemand },
        {
          ...latest,
          phase: mapPhaseBase(latest.phase, (base) => ({ ...base, liveLeases })),
        },
      ] as const;
    });

    const failures = changed ? yield* deliverLiveDemand(cell, liveDemand, liveTimeout) : [];

    if (changed) {
      yield* cell.notifyChanged(cell.nodeId);
    }

    return {
      nodeId: request.nodeId,
      leaseId,
      liveDemand,
      changed,
      failures,
    };
  });
}

export function releaseNodeLiveLease(
  cellLookup: GraphNodeCellLookup,
  request: ReleaseNodeLiveLeaseRequest,
  liveTimeout: DriverOperationTimeoutMs
): Effect.Effect<NodeLiveLeaseResult> {
  return Effect.gen(function* () {
    if (cellLookup._tag === "Missing") {
      return {
        nodeId: request.nodeId,
        leaseId: request.leaseId,
        liveDemand: projectLiveDemand([]),
        changed: false,
        failures: [],
      };
    }

    const { cell } = cellLookup;
    const { changed, liveDemand } = yield* cell.state.transition((latest) => {
      const latestLiveLeases = phaseLiveLeases(latest.phase);
      const liveLeases = latestLiveLeases.filter((lease) => lease.leaseId !== request.leaseId);
      const nextDemand = projectLiveDemand(liveLeases);
      const changed =
        liveLeases.length !== latestLiveLeases.length &&
        !sameLiveLeasesDemand(latestLiveLeases, liveLeases);
      return [
        { changed, liveDemand: nextDemand },
        {
          ...latest,
          phase: mapPhaseBase(latest.phase, (base) => ({ ...base, liveLeases })),
        },
      ] as const;
    });

    const failures = changed ? yield* deliverLiveDemand(cell, liveDemand, liveTimeout) : [];

    if (changed) {
      yield* cell.notifyChanged(cell.nodeId);
    }

    return {
      nodeId: request.nodeId,
      leaseId: request.leaseId,
      liveDemand,
      changed,
      failures,
    };
  });
}

export function deliverLiveDemand(
  cell: GraphNodeCell,
  nextDemand: NodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing") {
    return Effect.succeed([]);
  }

  return Effect.gen(function* () {
    const current = yield* cell.state.get;
    const ready = phaseReadyData(current.phase);

    if (ready._tag === "Missing") {
      return [];
    }

    const active = activeLiveDemand(nextDemand);

    // Contract: driver live hooks see only active demand. Inactive demand is a
    // graph-owned transition that stops the current resource, if any.
    if (active._tag === "Inactive") {
      return yield* stopCurrentLiveResource(cell, ready.ready.liveResource, liveTimeout, {
        _tag: "DemandInactive",
      });
    }

    const currentLive = ready.ready.liveResource;

    if (currentLive._tag === "Inactive") {
      return yield* startLiveResource(cell, ready.ready.node, active.demand, liveTimeout, []);
    }

    if (sameLiveDemand(currentLive.demand, active.demand)) {
      return [];
    }

    if (live.run.update === undefined) {
      // Contract: without an update hook, changed active demand is modeled as a
      // stop/start transition. Authors opt into in-place resource updates.
      const stopFailures = yield* stopLiveResource(
        cell,
        ready.ready.node,
        currentLive,
        liveTimeout,
        {
          _tag: "DemandChanged",
        }
      );
      return yield* startLiveResource(
        cell,
        ready.ready.node,
        active.demand,
        liveTimeout,
        stopFailures
      );
    }

    return yield* updateLiveResource(
      cell,
      ready.ready.node,
      currentLive,
      active.demand,
      liveTimeout
    );
  });
}

export function stopCurrentLiveResource(
  cell: GraphNodeCell,
  liveResource: LiveResourceState,
  liveTimeout: DriverOperationTimeoutMs,
  reason: LiveResourceStopReason
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  if (liveResource._tag === "Inactive") {
    return setLiveResourceState(cell, { _tag: "Inactive" }).pipe(Effect.as([]));
  }

  return Effect.gen(function* () {
    const current = yield* cell.state.get;
    const ready = phaseReadyData(current.phase);

    if (ready._tag === "Missing") {
      return [];
    }

    return yield* stopLiveResource(cell, ready.ready.node, liveResource, liveTimeout, reason);
  });
}

function updateLiveResource(
  cell: GraphNodeCell,
  node: object,
  currentLive: Extract<LiveResourceState, { readonly _tag: "Active" }>,
  demand: ActiveNodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing" || live.run.update === undefined) {
    return Effect.succeed([]);
  }

  const abortController = new AbortController();
  const ctx = makeLiveContext({ node, abortController });

  return runTimedDriverOperation({
    cell,
    operation: "live.update",
    boundary: "driver-live",
    timeout: liveTimeout,
    abortController,
    spanName: "frond.graph.live.update",
    spanAttributes: liveSpanAttributes(cell, "update"),
    run: () => live.run.update?.(ctx, currentLive.resource, demand),
  }).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.gen(function* () {
          // Hazard: update failure leaves resource state uncertain. Report it,
          // stop the old resource once, then make one bounded restart attempt
          // for the latest active demand. Do not loop here.
          const updateFailure = liveDeliveryFailed(cell, "update", cause);
          const stopFailures = yield* stopLiveResource(cell, node, currentLive, liveTimeout, {
            _tag: "UpdateFailed",
          });
          return yield* startLiveResource(cell, node, demand, liveTimeout, [
            updateFailure,
            ...stopFailures,
          ]);
        }),
      onSuccess: () =>
        setLiveResourceState(cell, {
          _tag: "Active",
          generation: currentLive.generation,
          demand,
          resource: currentLive.resource,
        }).pipe(Effect.as([])),
    })
  );
}

function startLiveResource(
  cell: GraphNodeCell,
  node: object,
  demand: ActiveNodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs,
  previousFailures: ReadonlyArray<GraphFailure>
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing") {
    return Effect.succeed(previousFailures);
  }

  return Effect.gen(function* () {
    const generation = yield* cell.state.transition((latest) => [
      latest.nextLiveGeneration,
      { ...latest, nextLiveGeneration: latest.nextLiveGeneration + 1 },
    ]);
    const abortController = new AbortController();
    const ctx = makeLiveContext({ node, abortController });

    return yield* runTimedDriverOperation({
      cell,
      operation: "live.start",
      boundary: "driver-live",
      timeout: liveTimeout,
      abortController,
      spanName: "frond.graph.live.start",
      spanAttributes: liveSpanAttributes(cell, "start"),
      run: () => live.run.start(ctx, demand),
    }).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          Effect.gen(function* () {
            const failures = [...previousFailures, liveDeliveryFailed(cell, "start", cause)];
            yield* setLiveResourceState(cell, { _tag: "Inactive" }, failures);
            return failures;
          }),
        onSuccess: (resource) =>
          Effect.gen(function* () {
            // Hazard: generation prevents a late start from overwriting a newer
            // live-resource transition if actor behavior changes later.
            yield* setLiveResourceState(
              cell,
              {
                _tag: "Active",
                generation,
                demand,
                resource,
              },
              previousFailures
            );
            return previousFailures;
          }),
      }),
      // Hazard: eviction and stop interrupt the live-lease operation fiber;
      // without this the live.start driver never observes cancellation and
      // its in-flight work runs ungoverned (same wiring as acquire/refresh/
      // action driver operations).
      Effect.onInterrupt(() =>
        Effect.sync(() => {
          abortController.abort(interruptedCancellation());
        })
      )
    );
  });
}

function stopLiveResource(
  cell: GraphNodeCell,
  node: object,
  currentLive: Extract<LiveResourceState, { readonly _tag: "Active" }>,
  liveTimeout: DriverOperationTimeoutMs,
  reason: LiveResourceStopReason
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing") {
    return setLiveResourceState(cell, { _tag: "Inactive" }).pipe(Effect.as([]));
  }

  const abortController = new AbortController();
  const ctx = makeLiveStopContext({ node, abortController, reason });

  return runTimedDriverOperation({
    cell,
    operation: "live.stop",
    boundary: "driver-live",
    timeout: liveTimeout,
    abortController,
    spanName: "frond.graph.live.stop",
    spanAttributes: liveSpanAttributes(cell, "stop"),
    run: () => live.run.stop(ctx, currentLive.resource, reason),
  }).pipe(
    Effect.matchEffect({
      onFailure: (cause) => {
        const failures = [liveDeliveryFailed(cell, "stop", cause)];
        return setLiveResourceState(cell, { _tag: "Inactive" }, failures).pipe(Effect.as(failures));
      },
      onSuccess: () => setLiveResourceState(cell, { _tag: "Inactive" }).pipe(Effect.as([])),
    })
  );
}

function setLiveResourceState(
  cell: GraphNodeCell,
  liveResource: LiveResourceState,
  failures: ReadonlyArray<GraphFailure> = []
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const liveFailure = yield* liveFailureFromFailures(failures);
    yield* cell.state.transition((latest) => [
      undefined,
      {
        ...latest,
        phase: mapPhaseReady(
          mapPhaseBase(latest.phase, (base) => ({ ...base, liveFailure })),
          (readyData) => ({ ...readyData, liveResource })
        ),
      },
    ]);
  });
}

function sameLiveDemand(
  left: ActiveNodeLiveDemandSnapshot,
  right: ActiveNodeLiveDemandSnapshot
): boolean {
  return (
    JSON.stringify(left.sources) === JSON.stringify(right.sources) &&
    JSON.stringify(left.scopes) === JSON.stringify(right.scopes)
  );
}

function liveSpanAttributes(
  cell: GraphNodeCell,
  stage: "start" | "update" | "stop"
): Record<string, unknown> {
  return {
    "frond.node.id": cell.nodeId,
    "frond.node.tag": cell.tag,
    "frond.driver.mode": cell.descriptor.driver.mode,
    "frond.live.stage": stage,
  };
}

function liveDeliveryFailed(
  cell: GraphNodeCell,
  stage: "start" | "update" | "stop",
  cause: unknown
): LiveDeliveryFailed {
  return new LiveDeliveryFailed({
    nodeId: cell.nodeId,
    tag: cell.tag,
    stage,
    cause,
  });
}

function liveFailureFromFailures(
  failures: ReadonlyArray<GraphFailure>
): Effect.Effect<NodeLiveFailure | undefined> {
  const noFailure: NodeLiveFailure | undefined = undefined;

  return failures.length === 0
    ? Effect.succeed(noFailure)
    : Clock.currentTimeMillis.pipe(Effect.map((at) => ({ failures, at })));
}

function sameLiveLeasesDemand(
  left: ReadonlyArray<Pick<CellLiveLease, "source" | "scopeKey">>,
  right: ReadonlyArray<Pick<CellLiveLease, "source" | "scopeKey">>
): boolean {
  return (
    sameProjectedSet(left, right, (lease) => lease.source) &&
    sameProjectedSet(left, right, (lease) => lease.scopeKey)
  );
}

function sameProjectedSet<TInput, TValue>(
  left: ReadonlyArray<TInput>,
  right: ReadonlyArray<TInput>,
  project: (input: TInput) => TValue
): boolean {
  const leftValues = new Set(left.map(project));
  const rightValues = new Set(right.map(project));

  return (
    leftValues.size === rightValues.size && [...leftValues].every((value) => rightValues.has(value))
  );
}

function liveScopeKey(
  cell: GraphNodeCell,
  scope: unknown
):
  | {
      readonly scopeKey: NodeLiveScopeKey;
    }
  | {
      readonly failure: GraphInvariantViolationType;
    } {
  try {
    return { scopeKey: canonicalKey(scope) as unknown as NodeLiveScopeKey };
  } catch (cause) {
    return {
      failure: new GraphInvariantViolationError({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: "live lease scope must be a JSON-shaped key value",
        cause,
      }),
    };
  }
}
