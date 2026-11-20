import { type Context, Effect, Exit } from "effect";
import type { GraphNodeCell, GraphPlanState } from "../cell/cellModel";
import { acquireLiveLeaseOperation, releaseLiveLeaseOperation } from "../cell/cellOperations";
import type { GraphCellOperation } from "../cell/cellQueue";
import type { GraphCellQueueRegistry } from "../cell/queueRegistry";
import { missingNodeLiveLease } from "../liveness";
import { bridgeObservedResultLease } from "../liveness/resultObservationBridge";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import { type GraphGate, planTask } from "../queue/graphGate";
import {
  callbackEffect,
  completedTask,
  forkIn,
  type GraphCancel,
  type GraphResume,
  noCancel,
} from "../queue/reply";
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

type LeaseCellOperation = (cell: GraphNodeCell) => GraphCellOperation<NodeLiveLeaseResult>;

const missingObservedLease: ObservedResultLease = { _tag: "Missing" };

export function makeGraphSystemLiveness(options: {
  readonly state: GraphPlanState;
  readonly gate: GraphGate;
  readonly queueRegistry: GraphCellQueueRegistry;
  readonly graphEnv: GraphOperationEnvironment;
  readonly observers: GraphSystemObservers;
}): GraphSystemLiveness {
  const { state, gate, queueRegistry, graphEnv, observers } = options;
  let liveLeaseCounter = 0;

  const nextLiveLeaseId = (): NodeLiveLeaseId => {
    liveLeaseCounter += 1;
    return `live-lease:${liveLeaseCounter}` as NodeLiveLeaseId;
  };

  const startLeaseCall = (
    nodeId: NodeId,
    operation: LeaseCellOperation,
    context: Context.Context<never> | undefined,
    resume: GraphResume<NodeLiveLeaseResult>
  ): GraphCancel => {
    const call = new LeaseCall(observers, context, resume);
    call.current = planTask(
      gate,
      (context) => {
        // Lookup belongs inside the gate: a prior eviction may replace this cell.
        const cell = state.nodes.get(nodeId);
        return cell === undefined
          ? completedTask(missingNodeLiveLease(nodeId))
          : queueRegistry.submitSync(cell, operation(cell), context);
      },
      context,
      call.settle
    );
    return call.cancel;
  };

  const startAcquireNodeLiveLease = (
    request: AcquireNodeLiveLeaseRequest,
    context: Context.Context<never> | undefined,
    resume: GraphResume<NodeLiveLeaseResult>
  ): GraphCancel =>
    startLeaseCall(
      request.nodeId,
      (cell) => acquireLiveLeaseOperation(graphEnv, cell, request),
      context,
      resume
    );

  const startReleaseNodeLiveLease = (
    request: ReleaseNodeLiveLeaseRequest,
    context: Context.Context<never> | undefined,
    resume: GraphResume<NodeLiveLeaseResult>
  ): GraphCancel =>
    startLeaseCall(
      request.nodeId,
      (cell) => releaseLiveLeaseOperation(graphEnv, cell, request),
      context,
      resume
    );

  const acquireObservedResultLease = (
    nodeId: NodeId,
    scope: unknown,
    lease: ObservedResultLease,
    resume: GraphResume<ObservedResultLease>
  ): void => {
    if (lease._tag === "Held") {
      resume(Exit.succeed(lease));
      return;
    }

    startAcquireNodeLiveLease({ nodeId, source: "mobx", scope }, undefined, (exit) =>
      resume(
        exit._tag === "Failure"
          ? Exit.failCause(exit.cause)
          : Exit.succeed(observedLease(exit.value))
      )
    );
  };

  const releaseObservedResultLease = (
    nodeId: NodeId,
    lease: ObservedResultLease,
    resume: GraphResume<ObservedResultLease>
  ): void => {
    if (lease._tag === "Missing") {
      resume(Exit.succeed(missingObservedLease));
      return;
    }

    startReleaseNodeLiveLease({ nodeId, leaseId: lease.leaseId }, undefined, (exit) =>
      resume(
        exit._tag === "Failure" ? Exit.failCause(exit.cause) : Exit.succeed(missingObservedLease)
      )
    );
  };

  return {
    nextLiveLeaseId,
    reportResultObserved: (nodeId, scope, observed, lease) =>
      bridgeObservedResultLease((resume) =>
        observed
          ? acquireObservedResultLease(nodeId, scope, lease, resume)
          : releaseObservedResultLease(nodeId, lease, resume)
      ),
    acquireNodeLiveLease: (request) =>
      callbackEffect((context, resume) => startAcquireNodeLiveLease(request, context, resume)),
    releaseNodeLiveLease: (request) =>
      callbackEffect((context, resume) => startReleaseNodeLiveLease(request, context, resume)),
  };
}

function observedLease(result: NodeLiveLeaseResult): ObservedResultLease {
  switch (result._tag) {
    case "Held": {
      return result.changed || result.liveDemand.isLive
        ? { _tag: "Held", leaseId: result.leaseId }
        : missingObservedLease;
    }
    case "Failed":
    case "NodeMissing": {
      return missingObservedLease;
    }
    default: {
      const unreachable: never = result;
      return unreachable;
    }
  }
}

/**
 * One lease call: the cell task, then the demand and failure notices its
 * result carries, then the caller's resume. A cancel withdraws the step in
 * flight and ends the call.
 */
class LeaseCall {
  current: GraphCancel = noCancel;
  private ended = false;
  private exit: Exit.Exit<NodeLiveLeaseResult> | undefined;

  constructor(
    private readonly observers: GraphSystemObservers,
    private readonly context: Context.Context<never> | undefined,
    private readonly resume: GraphResume<NodeLiveLeaseResult>
  ) {}

  readonly settle = (exit: Exit.Exit<NodeLiveLeaseResult>): void => {
    if (this.ended) return;
    this.current = noCancel;
    this.exit = exit;
    if (exit._tag === "Success" && exit.value._tag === "Held" && exit.value.changed) {
      const held = exit.value;
      this.observe(
        () => this.observers.notifyLiveDemandChanged(held.nodeId, held.liveDemand),
        this.notifyFailures
      );
      return;
    }
    this.notifyFailures();
  };

  readonly cancel = (): Effect.Effect<void> => {
    if (this.ended) return Effect.void;
    this.ended = true;
    const current = this.current;
    this.current = noCancel;
    return current();
  };

  private readonly notifyFailures = (): void => {
    if (this.ended) return;
    this.current = noCancel;
    const exit = this.exit;
    if (exit === undefined || exit._tag === "Failure" || exit.value._tag === "NodeMissing") {
      this.complete();
      return;
    }
    const { nodeId, failures } = exit.value;
    if (failures.length === 0) {
      this.complete();
      return;
    }
    this.observe(() => this.observers.notifyLiveFailures(nodeId, failures), this.complete);
  };

  private readonly complete = (): void => {
    if (this.ended || this.exit === undefined) return;
    this.ended = true;
    this.current = noCancel;
    this.resume(this.exit);
  };

  // The notice belongs to the caller, as when it ran in the caller's fiber:
  // it is not observer work a runtime stop interrupts, the call goes on in the
  // same turn the notice ends, and a notice that throws, fails, dies, or
  // interrupts itself ends the call with that cause.
  private observe(notice: () => Effect.Effect<void>, next: () => void): void {
    let work: Effect.Effect<void>;
    try {
      work = notice();
    } catch (cause) {
      this.exit = Exit.die(cause);
      this.complete();
      return;
    }
    if (work === Effect.void) {
      next();
      return;
    }
    let ended = false;
    const fiber = forkIn(this.context, work);
    fiber.addObserver((exit) => {
      ended = true;
      if (this.ended) return;
      switch (exit._tag) {
        case "Success":
          next();
          return;
        case "Failure":
          this.exit = Exit.failCause(exit.cause);
          this.complete();
          return;
      }
    });
    if (ended) return;
    this.current = () =>
      Effect.callback((done) => {
        fiber.addObserver(() => done(Effect.void));
        fiber.interruptUnsafe();
      });
  }
}
