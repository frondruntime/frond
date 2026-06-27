import { Clock, Deferred, Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import { runtimeCancellationDetail } from "../../cancellation";
import { releaseCell } from "../lifecycle/cleanup";
import { acquireNodeLiveLease, releaseNodeLiveLease } from "../liveness";
import {
  refreshInCell,
  runActionInCell,
  unsafeUpdateNodeInCell,
  updateNodeArgsInCell,
} from "../operations";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import type { GraphNodeCell } from "../planning/plan";
import { ensureReadyCell } from "../readiness";
import {
  type AcquireNodeLiveLeaseRequest,
  ActionFailed,
  type ActionRequest,
  type ActionResult,
  NodeEvicted,
  type NodeLiveLeaseResult,
  type NodeRead,
  RefreshFailed,
  type RefreshRequest,
  type RefreshResult,
  type ReleaseNodeLiveLeaseRequest,
  type RunningActionOperation,
  type UnsafeUpdateNodeRequest,
  type UnsafeUpdateNodeResult,
  UpdateNodeArgsFailed,
  type UpdateNodeArgsRequest,
  type UpdateNodeArgsResult,
} from "../types";
import { type GraphCellOperation, interruptCellOperation } from "./cellActor";
import { phaseBase, phaseReadinessAttempt } from "./cellPhase";
import { failReadinessAttemptState } from "./cellTransitions";

export function ensureReadyOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell
): GraphCellOperation<NodeRead> {
  return {
    effect: ensureReadyCell(env, cell),
    interrupt: (reply, reason) => completeEvictedReadiness(cell, reply, reason),
  };
}

export function runActionOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: ActionRequest
): GraphCellOperation<ActionResult> {
  return {
    effect: runActionInCell(env, (current) => ensureReadyCell(env, current), cell, request),
    interrupt: (reply, reason) => completeInterruptedAction(cell, request, reply, reason),
  };
}

export function refreshOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: RefreshRequest
): GraphCellOperation<RefreshResult> {
  return {
    effect: refreshInCell(env, cell, request),
    interrupt: (reply, reason) => completeInterruptedRefresh(cell, reply, reason),
  };
}

export function updateArgsOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: UpdateNodeArgsRequest
): GraphCellOperation<UpdateNodeArgsResult> {
  return {
    effect: updateNodeArgsInCell(env, cell, request),
    interrupt: (reply, reason) => completeInterruptedUpdateArgs(cell, reply, reason),
  };
}

export function unsafeUpdateNodeOperation(
  cell: GraphNodeCell,
  request: UnsafeUpdateNodeRequest
): GraphCellOperation<UnsafeUpdateNodeResult> {
  return {
    effect: unsafeUpdateNodeInCell(cell, request),
    interrupt: interruptCellOperation,
  };
}

export function acquireLiveLeaseOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: AcquireNodeLiveLeaseRequest
): GraphCellOperation<NodeLiveLeaseResult> {
  return {
    effect: acquireNodeLiveLease(
      env.state,
      { _tag: "Found", cell },
      request,
      env.driverTimeouts.live
    ),
    interrupt: interruptCellOperation,
  };
}

export function releaseLiveLeaseOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: ReleaseNodeLiveLeaseRequest
): GraphCellOperation<NodeLiveLeaseResult> {
  return {
    effect: releaseNodeLiveLease({ _tag: "Found", cell }, request, env.driverTimeouts.live),
    interrupt: interruptCellOperation,
  };
}

export function releaseOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  reason?: string | undefined
): GraphCellOperation<void> {
  return {
    effect: releaseCell(cell, env.driverTimeouts.release, env.driverTimeouts.live, {
      _tag: "NodeReleased",
    }).pipe(Effect.asVoid),
    interrupt: (reply) => interruptCellOperation(reply, { _tag: "Released", detail: reason }),
  };
}

function completeInterruptedAction(
  cell: GraphNodeCell,
  request: ActionRequest,
  reply: Deferred.Deferred<ActionResult>,
  cancellation: RuntimeCancellationReason | undefined
): Effect.Effect<void> {
  const eviction = nodeEvicted(cell, cancellation);
  const result = {
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new ActionFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      action: request.action,
      input: request.input,
      cause: eviction,
    }),
  } satisfies ActionResult;

  return Effect.gen(function* () {
    const current = yield* cell.state.get;
    const completedAt = yield* Clock.currentTimeMillis;

    yield* Deferred.succeed(reply, result).pipe(Effect.asVoid);
    yield* cell.notifyActionCompleted({
      nodeId: cell.nodeId,
      operation: currentActionOperation(current.phase),
      action: request.action,
      input: request.input,
      result,
      completedAt,
    });
  });
}

function completeInterruptedRefresh(
  cell: GraphNodeCell,
  reply: Deferred.Deferred<RefreshResult>,
  cancellation: RuntimeCancellationReason | undefined
): Effect.Effect<void> {
  const eviction = nodeEvicted(cell, cancellation);

  return Deferred.succeed(reply, {
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new RefreshFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      cause: eviction,
    }),
  }).pipe(Effect.asVoid);
}

function completeInterruptedUpdateArgs(
  cell: GraphNodeCell,
  reply: Deferred.Deferred<UpdateNodeArgsResult>,
  cancellation: RuntimeCancellationReason | undefined
): Effect.Effect<void> {
  const eviction = nodeEvicted(cell, cancellation);

  return Deferred.succeed(reply, {
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new UpdateNodeArgsFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      cause: eviction,
    }),
  }).pipe(Effect.asVoid);
}

function completeEvictedReadiness(
  cell: GraphNodeCell,
  reply: Deferred.Deferred<NodeRead>,
  cancellation: RuntimeCancellationReason | undefined
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const error = nodeEvicted(cell, cancellation);
    const status = { _tag: "Wired", run: { _tag: "Error", error } } as const;
    const current = yield* cell.state.get;
    const base = phaseBase(current.phase);
    const handle =
      base._tag === "Found"
        ? ({
            _tag: "Error",
            nodeId: cell.nodeId,
            tag: cell.tag,
            status,
            error,
          } satisfies NodeRead)
        : ({
            _tag: "Invalid",
            nodeId: cell.nodeId,
            tag: cell.tag,
            status: { _tag: "Invalid", error },
            nodeLookup: { _tag: "Missing" },
            error,
          } satisfies NodeRead);
    const attemptLookup = phaseReadinessAttempt(current.phase);

    if (attemptLookup._tag === "Found") {
      const { attempt } = attemptLookup;
      attempt.resolve(handle);
      yield* Deferred.succeed(attempt.deferred, handle).pipe(Effect.asVoid);
    }

    yield* cell.state.transition((latest) => [
      undefined,
      failReadinessAttemptState({ latest, cause: error }),
    ]);
    yield* Deferred.succeed(reply, handle).pipe(Effect.asVoid);
  });
}

function currentActionOperation(
  phase: Parameters<typeof phaseBase>[0]
): RunningActionOperation | undefined {
  if (phase._tag !== "Operating" || phase.operation.kind !== "action") {
    return undefined;
  }

  return phase.operation as RunningActionOperation;
}

function nodeEvicted(
  cell: GraphNodeCell,
  cancellation: RuntimeCancellationReason | undefined
): NodeEvicted {
  const normalized = cancellation ?? { _tag: "Evicted" };

  return new NodeEvicted({
    nodeId: cell.nodeId,
    tag: cell.tag,
    cancellation: normalized,
    reason: runtimeCancellationDetail(normalized),
  });
}
