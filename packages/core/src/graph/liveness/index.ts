import { Clock, Effect } from "effect";
import type { GraphNodeCellLookup } from "../cell/cellLookup";
import type { GraphNodeCell, GraphPlanState } from "../cell/cellModel";
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
import type {
  AcquireNodeLiveLeaseRequest,
  ActiveNodeLiveDemandSnapshot,
  DriverOperationTimeoutMs,
  GraphFailure,
  GraphInvariantViolation as GraphInvariantViolationType,
  LiveResourceStopReason,
  NodeLiveDemandSnapshot,
  NodeLiveFailure,
  NodeLiveLeaseId,
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
  liveTimeout: DriverOperationTimeoutMs,
  liveInterrupt?: LiveDeliveryInterrupt | undefined,
  onLeasePrepared?: ((leaseId: NodeLiveLeaseId) => void) | undefined
): Effect.Effect<NodeLiveLeaseResult> {
  return Effect.gen(function* () {
    if (cellLookup._tag === "Missing") {
      return {
        _tag: "NodeMissing",
        nodeId: request.nodeId,
        liveDemand: projectLiveDemand([]),
      };
    }

    const { cell } = cellLookup;
    const scopeKeyResult = liveScopeKey(cell, request.scope);

    if ("failure" in scopeKeyResult) {
      const current = yield* cell.state.get;
      return {
        _tag: "Failed",
        nodeId: request.nodeId,
        liveDemand: projectLiveDemand(phaseLiveLeases(current.phase)),
        failures: [scopeKeyResult.failure],
      };
    }

    const leaseId = state.nextLiveLeaseId();
    const scopeKey = scopeKeyResult.scopeKey;
    onLeasePrepared?.(leaseId);
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

    const failures = changed
      ? yield* deliverLiveDemand(cell, liveDemand, liveTimeout, liveInterrupt)
      : [];

    if (changed) {
      yield* cell.notifyChanged(cell.nodeId);
    }

    return {
      _tag: "Held",
      nodeId: request.nodeId,
      leaseId,
      liveDemand,
      changed,
      failures,
    };
  });
}

export function rollbackNodeLiveLease(
  state: Pick<GraphPlanState, "notifyLiveDemandChanged" | "notifyLiveFailures">,
  cell: GraphNodeCell,
  leaseId: NodeLiveLeaseId,
  liveTimeout: DriverOperationTimeoutMs
): Effect.Effect<void> {
  return Effect.gen(function* () {
    type RollbackResult =
      | { readonly _tag: "Missing" }
      | {
          readonly _tag: "Removed";
          readonly changed: boolean;
          readonly liveDemand: NodeLiveDemandSnapshot;
        };
    const rollback = yield* cell.state.transition<RollbackResult>((latest) => {
      const latestLiveLeases = phaseLiveLeases(latest.phase);
      const liveLeases = latestLiveLeases.filter((lease) => lease.leaseId !== leaseId);

      if (liveLeases.length === latestLiveLeases.length) {
        return [{ _tag: "Missing" } as const, latest] as const;
      }

      const liveDemand = projectLiveDemand(liveLeases);
      return [
        {
          _tag: "Removed",
          changed: !sameLiveLeasesDemand(latestLiveLeases, liveLeases),
          liveDemand,
        } as const,
        {
          ...latest,
          phase: mapPhaseBase(latest.phase, (base) => ({ ...base, liveLeases })),
        },
      ] as const;
    });

    if (rollback._tag === "Missing" || !rollback.changed) {
      return;
    }

    const failures = yield* deliverLiveDemand(cell, rollback.liveDemand, liveTimeout);
    yield* cell.notifyChanged(cell.nodeId);
    yield* state.notifyLiveDemandChanged(cell.nodeId, rollback.liveDemand);

    if (failures.length > 0) {
      yield* state.notifyLiveFailures(cell.nodeId, failures);
    }
  });
}

export function releaseNodeLiveLease(
  cellLookup: GraphNodeCellLookup,
  request: ReleaseNodeLiveLeaseRequest,
  liveTimeout: DriverOperationTimeoutMs,
  liveInterrupt?: LiveDeliveryInterrupt | undefined
): Effect.Effect<NodeLiveLeaseResult> {
  return Effect.gen(function* () {
    if (cellLookup._tag === "Missing") {
      return {
        _tag: "NodeMissing",
        nodeId: request.nodeId,
        liveDemand: projectLiveDemand([]),
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

    const failures = changed
      ? yield* deliverLiveDemand(cell, liveDemand, liveTimeout, liveInterrupt)
      : [];

    if (changed) {
      yield* cell.notifyChanged(cell.nodeId);
    }

    return {
      _tag: "Held",
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
  liveTimeout: DriverOperationTimeoutMs,
  liveInterrupt?: LiveDeliveryInterrupt | undefined
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
      return yield* stopCurrentLiveResource(
        cell,
        ready.ready.liveResource,
        liveTimeout,
        {
          _tag: "DemandInactive",
        },
        liveInterrupt
      );
    }

    const currentLive = ready.ready.liveResource;

    if (currentLive._tag === "Inactive") {
      return yield* startLiveResource(
        cell,
        ready.ready.node,
        active.demand,
        liveTimeout,
        [],
        liveInterrupt
      );
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
        },
        liveInterrupt
      );
      return yield* startLiveResource(
        cell,
        ready.ready.node,
        active.demand,
        liveTimeout,
        stopFailures,
        liveInterrupt
      );
    }

    return yield* updateLiveResource(
      cell,
      ready.ready.node,
      currentLive,
      active.demand,
      liveTimeout,
      liveInterrupt
    );
  });
}

export function stopCurrentLiveResource(
  cell: GraphNodeCell,
  liveResource: LiveResourceState,
  liveTimeout: DriverOperationTimeoutMs,
  reason: LiveResourceStopReason,
  liveInterrupt?: LiveDeliveryInterrupt | undefined
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

    return yield* stopLiveResource(
      cell,
      ready.ready.node,
      liveResource,
      liveTimeout,
      reason,
      liveInterrupt
    );
  });
}

function updateLiveResource(
  cell: GraphNodeCell,
  node: object,
  currentLive: Extract<LiveResourceState, { readonly _tag: "Active" }>,
  demand: ActiveNodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs,
  liveInterrupt?: LiveDeliveryInterrupt | undefined
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing" || live.run.update === undefined) {
    return Effect.succeed([]);
  }

  const abortController = new AbortController();
  const ctx = makeLiveContext({ node, abortController });

  const runUpdate = runTimedDriverOperation({
    cell,
    operation: "live.update",
    boundary: "driver-live",
    timeout: liveTimeout,
    abortController,
    spanName: "frond.graph.live.update",
    spanAttributes: liveSpanAttributes(cell, "update"),
    run: () => live.run.update?.(ctx, currentLive.resource, demand),
  });

  return trackLiveInterrupt(liveInterrupt, abortController, runUpdate).pipe(
    Effect.matchEffect({
      onFailure: (cause) =>
        Effect.gen(function* () {
          // Hazard: update failure leaves resource state uncertain. Report it,
          // stop the old resource once, then make one bounded restart attempt
          // for the latest active demand. Do not loop here.
          const updateFailure = liveDeliveryFailed(cell, "update", cause);
          const stopFailures = yield* stopLiveResource(
            cell,
            node,
            currentLive,
            liveTimeout,
            {
              _tag: "UpdateFailed",
            },
            liveInterrupt
          );
          return yield* startLiveResource(
            cell,
            node,
            demand,
            liveTimeout,
            [updateFailure, ...stopFailures],
            liveInterrupt
          );
        }),
      onSuccess: () =>
        setLiveResourceState(cell, {
          _tag: "Active",
          generation: currentLive.generation,
          demand,
          resource: currentLive.resource,
        }).pipe(Effect.as([])),
    }),
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        abortController.abort(interruptedCancellation());
      })
    )
  );
}

function startLiveResource(
  cell: GraphNodeCell,
  node: object,
  demand: ActiveNodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs,
  previousFailures: ReadonlyArray<GraphFailure>,
  liveInterrupt?: LiveDeliveryInterrupt | undefined
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

    // Interrupt atomicity: any resource returned from start must reach stop.
    // Two escapes feed one dedupe gate: (1) the value crossed into the runtime
    // but the fiber was interrupted before the state commit (`produced`);
    // (2) a promise-based start settles after the operation was abandoned and
    // reports through onAbandonedResource. Either way the resource is routed
    // into a detached driver stop instead of being dropped.
    let produced: { readonly resource: unknown } | undefined;
    let settled = false;
    const stopAbandonedResource = (resource: unknown): void => {
      if (settled) {
        return;
      }

      settled = true;
      runDetachedAbandonedLiveStop(cell, node, resource, liveTimeout);
    };

    const runStart = runTimedDriverOperation({
      cell,
      operation: "live.start",
      boundary: "driver-live",
      timeout: liveTimeout,
      abortController,
      spanName: "frond.graph.live.start",
      spanAttributes: liveSpanAttributes(cell, "start"),
      run: () =>
        live.run.start(ctx, demand, { onAbandonedResource: stopAbandonedResource }).pipe(
          Effect.tap((resource) =>
            Effect.sync(() => {
              produced = { resource };
            })
          )
        ),
    });

    return yield* trackLiveInterrupt(liveInterrupt, abortController, runStart).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          Effect.gen(function* () {
            const failures = [...previousFailures, liveDeliveryFailed(cell, "start", cause)];
            yield* setLiveResourceState(cell, { _tag: "Inactive" }, failures);
            return failures;
          }),
        onSuccess: (resource) =>
          Effect.gen(function* () {
            // Committed resources are owned by cell state from here on; the
            // abandoned-resource routing must never double-stop them.
            settled = true;
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

          if (produced !== undefined) {
            stopAbandonedResource(produced.resource);
          }
        })
      )
    );
  });
}

// Detached by design: the operation that owned this start was already
// interrupted or timed out, so no caller awaits this stop. Failures are
// recorded on the cell as live failures rather than thrown into an
// unobserved fiber.
function runDetachedAbandonedLiveStop(
  cell: GraphNodeCell,
  node: object,
  resource: unknown,
  liveTimeout: DriverOperationTimeoutMs
): void {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing") {
    return;
  }

  const abortController = new AbortController();
  const ctx = makeLiveStopContext({
    node,
    abortController,
    reason: { _tag: "StartInterrupted" },
  });

  const runStop = runTimedDriverOperation({
    cell,
    operation: "live.stop",
    boundary: "driver-live",
    timeout: liveTimeout,
    abortController,
    spanName: "frond.graph.live.stop",
    spanAttributes: liveSpanAttributes(cell, "stop"),
    run: () => live.run.stop(ctx, resource),
  });

  Effect.runFork(
    runStop.pipe(
      Effect.asVoid,
      Effect.catch((cause) => recordDetachedLiveStopFailure(cell, cause)),
      Effect.catchCause(() => Effect.void)
    )
  );
}

// Records a detached stop failure as the cell's live failure without touching
// the live-resource slot: the abandoned resource never became current, so a
// newer active resource (or Inactive) must not be clobbered from a detached
// fiber.
function recordDetachedLiveStopFailure(cell: GraphNodeCell, cause: unknown): Effect.Effect<void> {
  return Effect.gen(function* () {
    const liveFailure = yield* liveFailureFromFailures([liveDeliveryFailed(cell, "stop", cause)]);
    yield* cell.state.transition((latest) => [
      undefined,
      {
        ...latest,
        phase: mapPhaseBase(latest.phase, (base) => ({ ...base, liveFailure })),
      },
    ]);
    yield* cell.notifyChanged(cell.nodeId);
  });
}

function stopLiveResource(
  cell: GraphNodeCell,
  node: object,
  currentLive: Extract<LiveResourceState, { readonly _tag: "Active" }>,
  liveTimeout: DriverOperationTimeoutMs,
  reason: LiveResourceStopReason,
  liveInterrupt?: LiveDeliveryInterrupt | undefined
): Effect.Effect<ReadonlyArray<GraphFailure>> {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing") {
    return setLiveResourceState(cell, { _tag: "Inactive" }).pipe(Effect.as([]));
  }

  const abortController = new AbortController();
  const ctx = makeLiveStopContext({ node, abortController, reason });

  const runStop = runTimedDriverOperation({
    cell,
    operation: "live.stop",
    boundary: "driver-live",
    timeout: liveTimeout,
    abortController,
    spanName: "frond.graph.live.stop",
    spanAttributes: liveSpanAttributes(cell, "stop"),
    run: () => live.run.stop(ctx, currentLive.resource),
  });

  return trackLiveInterrupt(liveInterrupt, abortController, runStop).pipe(
    Effect.matchEffect({
      onFailure: (cause) => {
        const failures = [liveDeliveryFailed(cell, "stop", cause)];
        return setLiveResourceState(cell, { _tag: "Inactive" }, failures).pipe(Effect.as(failures));
      },
      onSuccess: () => setLiveResourceState(cell, { _tag: "Inactive" }).pipe(Effect.as([])),
    }),
    Effect.onInterrupt(() =>
      Effect.sync(() => {
        abortController.abort(interruptedCancellation());
      })
    )
  );
}

export interface LiveDeliveryInterrupt {
  readonly track: <A, E, R>(
    abortController: AbortController,
    effect: Effect.Effect<A, E, R>
  ) => Effect.Effect<A, E, R>;
  readonly abort: () => void;
}

export function makeLiveDeliveryInterrupt(): LiveDeliveryInterrupt {
  const abortControllers = new Set<AbortController>();

  return {
    track: (abortController, effect) =>
      Effect.sync(() => {
        abortControllers.add(abortController);
      }).pipe(
        Effect.flatMap(() => effect),
        Effect.ensuring(
          Effect.sync(() => {
            abortControllers.delete(abortController);
          })
        )
      ),
    abort: () => {
      for (const abortController of abortControllers) {
        abortController.abort(interruptedCancellation());
      }
    },
  };
}

function trackLiveInterrupt<A, E, R>(
  liveInterrupt: LiveDeliveryInterrupt | undefined,
  abortController: AbortController,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  return liveInterrupt === undefined ? effect : liveInterrupt.track(abortController, effect);
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
