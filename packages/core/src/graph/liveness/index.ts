import { Cause, type Context, Effect, Exit } from "effect";
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
import { type DriverEdgeInput, startEdge } from "../driverExecution/driverOperationRunner";
import { finishObserverWorkInTurn } from "../driverExecution/effectRunner";
import { interruptedCancellation } from "../lifecycle/operationDisposers";
import { canonicalKey } from "../planning/canonicalKey";
import { callbackEffect, type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
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

type ActiveLiveResource = Extract<LiveResourceState, { readonly _tag: "Active" }>;
type LiveFailures = ReadonlyArray<GraphFailure>;
type LiveDone = (failures: LiveFailures) => void;

const noFailures: LiveFailures = [];
const inactiveLiveResource: LiveResourceState = { _tag: "Inactive" };

/**
 * One live delivery: the step in flight and the caller waiting on the result.
 * Every step settles through a graph job; a step that settles after `cancel`
 * stops the delivery where it stands.
 */
class LiveChain<A> {
  ended = false;
  current: GraphCancel = noCancel;
  /** An update's signal stays governed until its failure recovery ends. */
  updateAbort: AbortController | undefined = undefined;

  constructor(
    readonly context: Context.Context<never> | undefined,
    private readonly resume: GraphResume<A>
  ) {}

  succeed(value: A): void {
    if (this.ended) return;
    this.ended = true;
    this.resume(Exit.succeed(value));
  }

  die(cause: unknown): void {
    if (this.ended) return;
    this.ended = true;
    this.resume(Exit.die(cause));
  }

  failCause(cause: Cause.Cause<never>): void {
    if (this.ended) return;
    this.ended = true;
    this.resume(Exit.failCause(cause));
  }

  cancel = (): Effect.Effect<void> => {
    if (this.ended) return Effect.void;
    this.ended = true;
    this.updateAbort?.abort(interruptedCancellation());
    const current = this.current;
    this.current = noCancel;
    return current();
  };
}

function startLiveChain<A>(
  context: Context.Context<never> | undefined,
  resume: GraphResume<A>,
  run: (chain: LiveChain<A>) => void
): GraphCancel {
  const chain = new LiveChain(context, resume);
  try {
    run(chain);
  } catch (cause) {
    chain.die(cause);
  }
  return chain.cancel;
}

export function startAcquireNodeLiveLease(
  state: Pick<GraphPlanState, "nextLiveLeaseId">,
  cellLookup: GraphNodeCellLookup,
  request: AcquireNodeLiveLeaseRequest,
  liveTimeout: DriverOperationTimeoutMs,
  onLeasePrepared: ((leaseId: NodeLiveLeaseId) => void) | undefined,
  context: Context.Context<never> | undefined,
  resume: GraphResume<NodeLiveLeaseResult>
): GraphCancel {
  return startLiveChain(context, resume, (chain) => {
    if (cellLookup._tag === "Missing") {
      chain.succeed(missingNodeLiveLease(request.nodeId));
      return;
    }

    const { cell } = cellLookup;
    const scopeKeyResult = liveScopeKey(cell, request.scope);

    if ("failure" in scopeKeyResult) {
      chain.succeed({
        _tag: "Failed",
        nodeId: request.nodeId,
        liveDemand: projectLiveDemand(phaseLiveLeases(cell.state.getSync().phase)),
        failures: [scopeKeyResult.failure],
      });
      return;
    }

    const leaseId = state.nextLiveLeaseId();
    const scopeKey = scopeKeyResult.scopeKey;
    onLeasePrepared?.(leaseId);
    const { changed, liveDemand } = cell.state.transitionSync((latest) => {
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

    if (!changed) {
      chain.succeed(heldLease(request.nodeId, leaseId, liveDemand, false, noFailures));
      return;
    }

    runDeliverLiveDemand(cell, liveDemand, liveTimeout, chain, (failures) =>
      notifyLiveObservers(chain, cell, cell.notifyChanged(cell.nodeId), () =>
        chain.succeed(heldLease(request.nodeId, leaseId, liveDemand, true, failures))
      )
    );
  });
}

export function rollbackNodeLiveLease(
  state: Pick<GraphPlanState, "notifyLiveDemandChanged" | "notifyLiveFailures">,
  cell: GraphNodeCell,
  leaseId: NodeLiveLeaseId,
  liveTimeout: DriverOperationTimeoutMs
): Effect.Effect<void> {
  return callbackEffect((context, resume) =>
    startLiveChain<void>(context, resume, (chain) => {
      type RollbackResult =
        | { readonly _tag: "Missing" }
        | {
            readonly _tag: "Removed";
            readonly changed: boolean;
            readonly liveDemand: NodeLiveDemandSnapshot;
          };
      const rollback = cell.state.transitionSync<RollbackResult>((latest) => {
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
        chain.succeed(undefined);
        return;
      }

      const { liveDemand } = rollback;
      runDeliverLiveDemand(cell, liveDemand, liveTimeout, chain, (failures) =>
        notifyLiveObservers(chain, cell, cell.notifyChanged(cell.nodeId), () =>
          notifyLiveObservers(
            chain,
            cell,
            state.notifyLiveDemandChanged(cell.nodeId, liveDemand),
            () => {
              if (failures.length === 0) {
                chain.succeed(undefined);
                return;
              }
              notifyLiveObservers(
                chain,
                cell,
                state.notifyLiveFailures(cell.nodeId, failures),
                () => chain.succeed(undefined)
              );
            }
          )
        )
      );
    })
  );
}

export function startReleaseNodeLiveLease(
  cellLookup: GraphNodeCellLookup,
  request: ReleaseNodeLiveLeaseRequest,
  liveTimeout: DriverOperationTimeoutMs,
  context: Context.Context<never> | undefined,
  resume: GraphResume<NodeLiveLeaseResult>
): GraphCancel {
  return startLiveChain(context, resume, (chain) => {
    if (cellLookup._tag === "Missing") {
      chain.succeed(missingNodeLiveLease(request.nodeId));
      return;
    }

    const { cell } = cellLookup;
    const { changed, liveDemand } = cell.state.transitionSync((latest) => {
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

    if (!changed) {
      chain.succeed(heldLease(request.nodeId, request.leaseId, liveDemand, false, noFailures));
      return;
    }

    runDeliverLiveDemand(cell, liveDemand, liveTimeout, chain, (failures) =>
      notifyLiveObservers(chain, cell, cell.notifyChanged(cell.nodeId), () =>
        chain.succeed(heldLease(request.nodeId, request.leaseId, liveDemand, true, failures))
      )
    );
  });
}

export function deliverLiveDemand(
  cell: GraphNodeCell,
  nextDemand: NodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs
): Effect.Effect<LiveFailures> {
  if (cell.descriptor.driver.live._tag === "Missing") {
    return Effect.succeed(noFailures);
  }

  return callbackEffect((context, resume) =>
    startLiveChain<LiveFailures>(context, resume, (chain) =>
      runDeliverLiveDemand(cell, nextDemand, liveTimeout, chain, (failures) =>
        chain.succeed(failures)
      )
    )
  );
}

export function stopCurrentLiveResource(
  cell: GraphNodeCell,
  liveResource: LiveResourceState,
  liveTimeout: DriverOperationTimeoutMs,
  reason: LiveResourceStopReason
): Effect.Effect<LiveFailures> {
  if (liveResource._tag === "Inactive") {
    return Effect.sync(() => {
      setLiveResourceState(cell, inactiveLiveResource, noFailures);
      return noFailures;
    });
  }

  return callbackEffect((context, resume) =>
    startLiveChain<LiveFailures>(context, resume, (chain) =>
      runStopCurrentLiveResource(cell, liveResource, liveTimeout, reason, chain, (failures) =>
        chain.succeed(failures)
      )
    )
  );
}

function runDeliverLiveDemand<A>(
  cell: GraphNodeCell,
  nextDemand: NodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs,
  chain: LiveChain<A>,
  done: LiveDone
): void {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing") {
    done(noFailures);
    return;
  }

  const ready = phaseReadyData(cell.state.getSync().phase);

  if (ready._tag === "Missing") {
    done(noFailures);
    return;
  }

  const active = activeLiveDemand(nextDemand);

  // Contract: driver live hooks see only active demand. Inactive demand is a
  // graph-owned transition that stops the current resource, if any.
  if (active._tag === "Inactive") {
    runStopCurrentLiveResource(
      cell,
      ready.ready.liveResource,
      liveTimeout,
      { _tag: "DemandInactive" },
      chain,
      done
    );
    return;
  }

  const { node } = ready.ready;
  const currentLive = ready.ready.liveResource;

  if (currentLive._tag === "Inactive") {
    runLiveStart(cell, node, active.demand, liveTimeout, noFailures, chain, done);
    return;
  }

  if (sameLiveDemand(currentLive.demand, active.demand)) {
    done(noFailures);
    return;
  }

  if (live.run.update === undefined) {
    // Contract: without an update hook, changed active demand is modeled as a
    // stop/start transition. Authors opt into in-place resource updates.
    runLiveStop(
      cell,
      node,
      currentLive,
      liveTimeout,
      { _tag: "DemandChanged" },
      chain,
      (stopFailures) =>
        runLiveStart(cell, node, active.demand, liveTimeout, stopFailures, chain, done)
    );
    return;
  }

  runLiveUpdate(cell, node, currentLive, active.demand, liveTimeout, chain, done);
}

function runStopCurrentLiveResource<A>(
  cell: GraphNodeCell,
  liveResource: LiveResourceState,
  liveTimeout: DriverOperationTimeoutMs,
  reason: LiveResourceStopReason,
  chain: LiveChain<A>,
  done: LiveDone
): void {
  if (liveResource._tag === "Inactive") {
    setLiveResourceState(cell, inactiveLiveResource, noFailures);
    done(noFailures);
    return;
  }

  const ready = phaseReadyData(cell.state.getSync().phase);

  if (ready._tag === "Missing") {
    done(noFailures);
    return;
  }

  runLiveStop(cell, ready.ready.node, liveResource, liveTimeout, reason, chain, done);
}

/**
 * Runs one live hook as the chain's current step. Its settle continues the
 * chain unless the chain was canceled first; a continuation that throws ends
 * the delivery as a defect, as a throw inside the Effect pipeline did.
 */
function runLiveEdge<A, B>(
  chain: LiveChain<B>,
  input: DriverEdgeInput<A>,
  settle: (exit: Exit.Exit<A, unknown>) => void
): void {
  chain.current = startEdge(input, chain.context, (exit) => {
    if (chain.ended) return;
    chain.current = noCancel;
    try {
      settle(exit);
    } catch (cause) {
      chain.die(cause);
    }
  });
}

/**
 * Runs observer work as the chain's current step, then `next` in the turn the
 * work ends, as the notice inside the delivery's Effect pipeline did. Work
 * that fails, dies, or interrupts itself ends the delivery with its cause.
 * A void notice continues at once; the chain is the owner of effectful work,
 * so no notice allocates a failure handler.
 */
function notifyLiveObservers<A>(
  chain: LiveChain<A>,
  cell: GraphNodeCell,
  work: Effect.Effect<void>,
  next: () => void
): void {
  if (work === Effect.void) {
    continueLiveChain(chain, next);
    return;
  }
  const cancel = finishObserverWorkInTurn(
    work,
    chain.context,
    () => continueLiveChain(chain, next),
    chain,
    cell.jobs
  );
  if (cancel !== undefined) chain.current = cancel;
}

/** Runs the chain's next step; a step that throws ends the delivery as a defect. */
function continueLiveChain<A>(chain: LiveChain<A>, next: () => void): void {
  if (chain.ended) return;
  chain.current = noCancel;
  try {
    next();
  } catch (cause) {
    chain.die(cause);
  }
}

function runLiveUpdate<A>(
  cell: GraphNodeCell,
  node: object,
  currentLive: ActiveLiveResource,
  demand: ActiveNodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs,
  chain: LiveChain<A>,
  done: LiveDone
): void {
  const { live } = cell.descriptor.driver;
  const update = live._tag === "Missing" ? undefined : live.run.update;

  if (update === undefined) {
    done(noFailures);
    return;
  }

  const abortController = new AbortController();
  const ctx = makeLiveContext({ node, abortController });
  // The update's signal stays governed through its failure recovery below,
  // as one interruptible delivery step.
  chain.updateAbort = abortController;

  runLiveEdge(
    chain,
    {
      cell,
      operation: "live.update",
      boundary: "driver-live",
      timeout: liveTimeout,
      abortController,
      spanName: "frond.graph.live.update",
      spanAttributes: liveSpanAttributes(cell, "update"),
      run: () => update(ctx, currentLive.resource, demand),
    },
    (exit) => {
      if (exit._tag === "Success") {
        chain.updateAbort = undefined;
        setLiveResourceState(
          cell,
          {
            _tag: "Active",
            generation: currentLive.generation,
            demand,
            resource: currentLive.resource,
          },
          noFailures
        );
        done(noFailures);
        return;
      }

      // Hazard: update failure leaves resource state uncertain. Report it,
      // stop the old resource once, then make one bounded restart attempt
      // for the latest active demand. Do not loop here.
      const updateFailure = liveDeliveryFailed(cell, "update", Cause.squash(exit.cause));
      runLiveStop(
        cell,
        node,
        currentLive,
        liveTimeout,
        { _tag: "UpdateFailed" },
        chain,
        (stopFailures) =>
          runLiveStart(
            cell,
            node,
            demand,
            liveTimeout,
            [updateFailure, ...stopFailures],
            chain,
            (failures) => {
              chain.updateAbort = undefined;
              done(failures);
            }
          )
      );
    }
  );
}

function runLiveStart<A>(
  cell: GraphNodeCell,
  node: object,
  demand: ActiveNodeLiveDemandSnapshot,
  liveTimeout: DriverOperationTimeoutMs,
  previousFailures: LiveFailures,
  chain: LiveChain<A>,
  done: LiveDone
): void {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing") {
    done(previousFailures);
    return;
  }

  const generation = cell.state.transitionSync((latest) => [
    latest.nextLiveGeneration,
    { ...latest, nextLiveGeneration: latest.nextLiveGeneration + 1 },
  ]);
  const abortController = new AbortController();
  const ctx = makeLiveContext({ node, abortController });

  // Interrupt atomicity: any resource returned from start must reach stop.
  // Two escapes feed one dedupe gate: (1) the value crossed into the runtime
  // but the delivery was canceled before the state commit (`produced`);
  // (2) the normalized start's underlying work settles with a resource after
  // the lease operation was abandoned — a retained promise in async mode, a
  // masked routing fiber in effect mode — and reports it through the
  // onAbandonedResource contract both normalizations implement. Either way
  // the resource is routed into a detached driver stop instead of dropped.
  let produced: { readonly resource: unknown } | undefined;
  let settled = false;
  const stopAbandonedResource = (resource: unknown): void => {
    if (settled) {
      return;
    }

    settled = true;
    runDetachedAbandonedLiveStop(cell, node, resource, liveTimeout);
  };

  runLiveEdge(
    chain,
    {
      cell,
      operation: "live.start",
      boundary: "driver-live",
      timeout: liveTimeout,
      abortController,
      spanName: "frond.graph.live.start",
      spanAttributes: liveSpanAttributes(cell, "start"),
      run: () => live.run.start(ctx, demand, { onAbandonedResource: stopAbandonedResource }),
      onProduced: (resource) => {
        produced = { resource };
      },
      onAbandonedResource: stopAbandonedResource,
    },
    (exit) => {
      if (exit._tag === "Failure") {
        const failures = [
          ...previousFailures,
          liveDeliveryFailed(cell, "start", Cause.squash(exit.cause)),
        ];
        setLiveResourceState(cell, inactiveLiveResource, failures);
        done(failures);
        return;
      }

      // Committed resources are owned by cell state from here on; the
      // abandoned-resource routing must never double-stop them.
      settled = true;
      // Hazard: generation prevents a late start from overwriting a newer
      // live-resource transition if queue behavior changes later.
      setLiveResourceState(
        cell,
        {
          _tag: "Active",
          generation,
          demand,
          resource: exit.value,
        },
        previousFailures
      );
      done(previousFailures);
    }
  );

  // Hazard: eviction and stop cancel the live-lease delivery; the start hook
  // must observe cancellation and a produced resource must reach stop, after
  // the edge's own interruption has ended.
  const cancelEdge = chain.current;
  chain.current = () =>
    cancelEdge().pipe(
      Effect.andThen(
        Effect.sync(() => {
          abortController.abort(interruptedCancellation());

          if (produced !== undefined) {
            stopAbandonedResource(produced.resource);
          }
        })
      )
    );
}

// Detached by design: the operation that owned this start was already
// interrupted or timed out, so no caller awaits this stop. Failures are
// recorded on the cell as live failures rather than thrown.
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
  const ctx = makeLiveStopContext({ node, abortController, reason: { _tag: "StartInterrupted" } });

  startEdge(
    {
      cell,
      operation: "live.stop",
      boundary: "driver-live",
      timeout: liveTimeout,
      abortController,
      spanName: "frond.graph.live.stop",
      spanAttributes: liveSpanAttributes(cell, "stop"),
      run: () => live.run.stop(ctx, resource),
    },
    undefined,
    (exit) => {
      if (exit._tag === "Failure") {
        recordDetachedLiveStopFailure(cell, Cause.squash(exit.cause));
      }
    }
  );
}

// Records a detached stop failure as the cell's live failure without touching
// the live-resource slot: the abandoned resource never became current, so a
// newer active resource (or Inactive) must not be clobbered by a detached
// stop.
function recordDetachedLiveStopFailure(cell: GraphNodeCell, cause: unknown): void {
  const liveFailure = liveFailureFromFailures(cell, [liveDeliveryFailed(cell, "stop", cause)]);
  cell.state.transitionSync((latest) => [
    undefined,
    {
      ...latest,
      phase: mapPhaseBase(latest.phase, (base) => ({ ...base, liveFailure })),
    },
  ]);
  const work = cell.notifyChanged(cell.nodeId);

  if (work !== Effect.void) {
    Effect.runFork(work.pipe(Effect.catchCause(() => Effect.void)));
  }
}

function runLiveStop<A>(
  cell: GraphNodeCell,
  node: object,
  currentLive: ActiveLiveResource,
  liveTimeout: DriverOperationTimeoutMs,
  reason: LiveResourceStopReason,
  chain: LiveChain<A>,
  done: LiveDone
): void {
  const { live } = cell.descriptor.driver;

  if (live._tag === "Missing") {
    setLiveResourceState(cell, inactiveLiveResource, noFailures);
    done(noFailures);
    return;
  }

  const abortController = new AbortController();
  const ctx = makeLiveStopContext({ node, abortController, reason });

  runLiveEdge(
    chain,
    {
      cell,
      operation: "live.stop",
      boundary: "driver-live",
      timeout: liveTimeout,
      abortController,
      spanName: "frond.graph.live.stop",
      spanAttributes: liveSpanAttributes(cell, "stop"),
      run: () => live.run.stop(ctx, currentLive.resource),
    },
    (exit) => {
      if (exit._tag === "Failure") {
        const failures = [liveDeliveryFailed(cell, "stop", Cause.squash(exit.cause))];
        setLiveResourceState(cell, inactiveLiveResource, failures);
        done(failures);
        return;
      }

      setLiveResourceState(cell, inactiveLiveResource, noFailures);
      done(noFailures);
    }
  );
}

export function missingNodeLiveLease(nodeId: NodeLiveLeaseResult["nodeId"]): NodeLiveLeaseResult {
  return {
    _tag: "NodeMissing",
    nodeId,
    liveDemand: projectLiveDemand([]),
  };
}

function heldLease(
  nodeId: NodeLiveLeaseResult["nodeId"],
  leaseId: NodeLiveLeaseId,
  liveDemand: NodeLiveDemandSnapshot,
  changed: boolean,
  failures: LiveFailures
): NodeLiveLeaseResult {
  return {
    _tag: "Held",
    nodeId,
    leaseId,
    liveDemand,
    changed,
    failures,
  };
}

function setLiveResourceState(
  cell: GraphNodeCell,
  liveResource: LiveResourceState,
  failures: LiveFailures
): void {
  const liveFailure = liveFailureFromFailures(cell, failures);
  cell.state.transitionSync((latest) => [
    undefined,
    {
      ...latest,
      phase: mapPhaseReady(
        mapPhaseBase(latest.phase, (base) => ({ ...base, liveFailure })),
        (readyData) => ({ ...readyData, liveResource })
      ),
    },
  ]);
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
  cell: GraphNodeCell,
  failures: LiveFailures
): NodeLiveFailure | undefined {
  return failures.length === 0 ? undefined : { failures, at: cell.syncClock.now() };
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
