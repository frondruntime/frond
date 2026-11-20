import { Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import { runtimeCancellationDetail } from "../../cancellation";
import { runEffectEdge } from "../driverExecution/effectRunner";
import { releaseCell } from "../lifecycle/cleanup";
import {
  rollbackNodeLiveLease,
  startAcquireNodeLiveLease,
  startReleaseNodeLiveLease,
} from "../liveness";
import { runActionInCell, unsafeUpdateNodeInCell, updateNodeArgsInCell } from "../operations";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import { startRefresh } from "../operations/refreshOperation";
import { startReadiness } from "../readiness";
import { completeAttempt } from "../readiness/readinessAttempt";
import {
  type AcquireNodeLiveLeaseRequest,
  ActionFailed,
  type ActionRequest,
  type ActionResult,
  NodeEvicted,
  type NodeLiveLeaseId,
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
import type { GraphNodeCell } from "./cellModel";
import { type CellReadinessAttempt, phaseBase, phaseReadinessAttempt } from "./cellPhase";
import type { GraphCellOperation } from "./cellQueue";
import { failReadinessAttemptState } from "./cellTransitions";

export function ensureReadyOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  attempt?: CellReadinessAttempt
): GraphCellOperation<NodeRead> {
  return {
    start: (context, resume) => startReadiness(env, cell, attempt, context, resume),
    interrupt: (reason) => completeEvictedReadiness(cell, reason),
  };
}

export function runActionOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: ActionRequest
): GraphCellOperation<ActionResult> {
  return {
    start: (context, resume, decided) =>
      runActionInCell(env, cell, request, context, resume, decided),
    interrupt: (reason) => completeInterruptedAction(cell, request, reason),
  };
}

export function refreshOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: RefreshRequest
): GraphCellOperation<RefreshResult> {
  return {
    start: (context, resume, decided) => startRefresh(env, cell, request, context, resume, decided),
    interrupt: (reason) => completeInterruptedRefresh(cell, reason),
  };
}

export function updateArgsOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: UpdateNodeArgsRequest
): GraphCellOperation<UpdateNodeArgsResult> {
  return {
    start: (context, resume) => updateNodeArgsInCell(env, cell, request, context, resume),
    interrupt: (reason) => completeInterruptedUpdateArgs(cell, reason),
  };
}

export function unsafeUpdateNodeOperation(
  cell: GraphNodeCell,
  request: UnsafeUpdateNodeRequest
): GraphCellOperation<UnsafeUpdateNodeResult> {
  return {
    start: (context, resume) => unsafeUpdateNodeInCell(cell, request, context, resume),
  };
}

export function acquireLiveLeaseOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: AcquireNodeLiveLeaseRequest
): GraphCellOperation<NodeLiveLeaseResult> {
  let preparedLeaseId: NodeLiveLeaseId | undefined;

  return {
    start: (context, resume) =>
      startAcquireNodeLiveLease(
        env.state,
        { _tag: "Found", cell },
        request,
        env.driverTimeouts.live,
        (leaseId) => {
          preparedLeaseId = leaseId;
        },
        context,
        resume
      ),
    // The cancel has already aborted the hook in flight, and its interruption
    // runs alongside this one; a lease added before the cancel is rolled back
    // so its demand never sticks.
    interrupt: () =>
      preparedLeaseId === undefined
        ? Effect.interrupt
        : rollbackNodeLiveLease(env.state, cell, preparedLeaseId, env.driverTimeouts.live).pipe(
            Effect.andThen(Effect.interrupt)
          ),
    interruptsWorkAlongside: true,
  };
}

export function releaseLiveLeaseOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  request: ReleaseNodeLiveLeaseRequest
): GraphCellOperation<NodeLiveLeaseResult> {
  return {
    start: (context, resume) =>
      startReleaseNodeLiveLease(
        { _tag: "Found", cell },
        request,
        env.driverTimeouts.live,
        context,
        resume
      ),
    interruptsWorkAlongside: true,
  };
}

export function releaseOperation(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  _reason?: string | undefined
): GraphCellOperation<void> {
  const release = releaseCell(
    env.state,
    cell,
    env.driverTimeouts.release,
    env.driverTimeouts.live,
    {
      _tag: "NodeReleased",
    }
  ).pipe(Effect.asVoid);
  return {
    start: (context, resume) => runEffectEdge(release, context, resume),
    interruptsWorkAlongside: true,
  };
}

function completeInterruptedAction(
  cell: GraphNodeCell,
  request: ActionRequest,
  cancellation: RuntimeCancellationReason | undefined
): Effect.Effect<ActionResult> {
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
    const completedAt = cell.syncClock.now();

    yield* cell.notifyActionCompleted({
      nodeId: cell.nodeId,
      operation: currentActionOperation(current.phase),
      action: request.action,
      input: request.input,
      result,
      completedAt,
    });
    return result;
  });
}

function completeInterruptedRefresh(
  cell: GraphNodeCell,
  cancellation: RuntimeCancellationReason | undefined
): Effect.Effect<RefreshResult> {
  const eviction = nodeEvicted(cell, cancellation);

  return Effect.succeed({
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new RefreshFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      cause: eviction,
    }),
  });
}

function completeInterruptedUpdateArgs(
  cell: GraphNodeCell,
  cancellation: RuntimeCancellationReason | undefined
): Effect.Effect<UpdateNodeArgsResult> {
  const eviction = nodeEvicted(cell, cancellation);

  return Effect.succeed({
    _tag: "Failure",
    nodeId: cell.nodeId,
    error: new UpdateNodeArgsFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      cause: eviction,
    }),
  });
}

function completeEvictedReadiness(
  cell: GraphNodeCell,
  cancellation: RuntimeCancellationReason | undefined
): Effect.Effect<NodeRead> {
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

    yield* cell.state.transition((latest) => [
      undefined,
      failReadinessAttemptState({ latest, cause: error }),
    ]);
    if (attemptLookup._tag === "Found") {
      yield* completeAttempt(attemptLookup.attempt, handle);
    }
    return handle;
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
