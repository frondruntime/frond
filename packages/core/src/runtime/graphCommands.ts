import { Clock, Effect, Match } from "effect";
import type { GraphFailure } from "../graph/types/failures";
import type { NodeId } from "../graph/types/ids";
import type { ActionRequest } from "../graph/types/operations";
import type { NodeSnapshotLookup, ProjectionContext } from "../graph/types/reads";
import type { GraphSystemService } from "../graph/types/service";
import { RuntimeEvents } from "./events";
import { nodeSpanAttributes, withRuntimeSpan } from "./observability";
import type { RuntimeOperationStartRegistry } from "./operationStarts";
import type { RuntimeCommand, RuntimeEvent, RuntimeId, RuntimeSubmission } from "./types";
import type { RuntimeWorkContext } from "./work";

type RuntimeGraphCommandTag = Extract<RuntimeCommand["_tag"], `Graph${string}`>;
export type RuntimeGraphCommand = Extract<
  RuntimeCommand,
  { readonly _tag: RuntimeGraphCommandTag }
>;

export function runRuntimeGraphCommand(input: {
  readonly command: RuntimeGraphCommand;
  readonly graphSystem: GraphSystemService;
  readonly runtimeId: RuntimeId;
  readonly work: RuntimeWorkContext;
  readonly emit: (event: RuntimeEvent) => Effect.Effect<void>;
  readonly syncProjectionContext: () => ProjectionContext;
  readonly operationStarts: RuntimeOperationStartRegistry;
}): Effect.Effect<RuntimeSubmission> {
  return Match.value(input.command).pipe(
    Match.tag("GraphEnsureNode", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const read = yield* input.graphSystem.ensureNode(request);

          yield* input.emit(RuntimeEvents.graphNodeEnsured(read.nodeId, read.status, at));

          return { _tag: "GraphNodeEnsured", read } satisfies RuntimeSubmission;
        }),
        "frond.graph.ensureNode",
        nodeSpanAttributes({ runtimeId: input.runtimeId, reason: "readiness", work: input.work })
      )
    ),
    Match.tag("GraphEnsureReadyNode", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const read = yield* input.graphSystem.ensureReadyNode(request);

          yield* input.emit(RuntimeEvents.graphNodeReadyEnsured(read.nodeId, read.status, at));

          return { _tag: "GraphNodeReadyEnsured", read } satisfies RuntimeSubmission;
        }),
        "frond.graph.ensureReady",
        nodeSpanAttributes({ runtimeId: input.runtimeId, reason: "readiness", work: input.work })
      )
    ),
    Match.tag("GraphEnsureReadyNodeById", ({ nodeId }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const read = yield* input.graphSystem.ensureReadyNodeById(nodeId);

          yield* input.emit(RuntimeEvents.graphNodeReadyEnsured(read.nodeId, read.status, at));

          return { _tag: "GraphNodeReadyEnsured", read } satisfies RuntimeSubmission;
        }),
        "frond.graph.ensureReady",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          nodeId,
          reason: "readiness",
          work: input.work,
        })
      )
    ),
    Match.tag("GraphRunAction", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const nodeId = graphTargetNodeId(input.graphSystem, request.target);
          // Boundary: runtime records command metadata before graph actor
          // admission, then graph operation observers emit start/completion
          // events from the real actor-owned operation boundary.
          const cancelPendingStart = input.operationStarts.registerAction(
            nodeId,
            request.action,
            request.input,
            input.work
          );

          const result = yield* input.graphSystem
            .runAction(request)
            .pipe(Effect.ensuring(Effect.sync(cancelPendingStart)));

          return { _tag: "GraphActionCompleted", result } satisfies RuntimeSubmission;
        }),
        "frond.graph.action",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          nodeId: graphTargetNodeIdIfKnown(request.target),
          action: request.action,
          reason: "action",
          work: input.work,
        })
      )
    ),
    Match.tag("GraphRefreshNode", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const submission = yield* input.graphSystem.submitRefreshNode(request);
          const result = yield* Match.value(submission).pipe(
            Match.tag("Started", ({ nodeId, task }) =>
              Effect.gen(function* () {
                const cancelPendingStart = input.operationStarts.registerRefresh(
                  nodeId,
                  input.work
                );
                const result = yield* task.await.pipe(
                  Effect.ensuring(Effect.sync(cancelPendingStart))
                );
                const completedAt = yield* Clock.currentTimeMillis;
                yield* Match.value(result).pipe(
                  Match.tag("Success", ({ nodeId, value }) =>
                    input.emit(RuntimeEvents.graphRefreshSucceeded(nodeId, value, completedAt))
                  ),
                  Match.tag("Failure", ({ error, nodeId }) =>
                    input.emit(RuntimeEvents.graphRefreshFailed(nodeId, error, completedAt))
                  ),
                  Match.exhaustive
                );
                return result;
              })
            ),
            Match.tag("Joined", ({ task }) => task.await),
            Match.tag("Missing", ({ result }) => Effect.succeed(result)),
            Match.exhaustive
          );

          return { _tag: "GraphRefreshCompleted", result } satisfies RuntimeSubmission;
        }),
        "frond.graph.refresh",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          nodeId: graphTargetNodeIdIfKnown(request.target),
          reason: "refresh",
          work: input.work,
        })
      )
    ),
    Match.tag("GraphUpdateNodeArgs", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const cancelPendingStart = input.operationStarts.registerArgsUpdate(
            request.nodeId,
            input.work
          );
          const result = yield* input.graphSystem
            .updateNodeArgs(request)
            .pipe(Effect.ensuring(Effect.sync(cancelPendingStart)));
          const completedAt = yield* Clock.currentTimeMillis;

          yield* Match.value(result).pipe(
            Match.tag("Success", ({ nodeId, shouldRefresh }) =>
              input.emit(
                RuntimeEvents.graphNodeArgsUpdateSucceeded(nodeId, shouldRefresh, completedAt)
              )
            ),
            Match.tag("Failure", ({ nodeId, error }) =>
              input.emit(RuntimeEvents.graphNodeArgsUpdateFailed(nodeId, error, completedAt))
            ),
            Match.exhaustive
          );

          return { _tag: "GraphNodeArgsUpdateCompleted", result } satisfies RuntimeSubmission;
        }),
        "frond.graph.args",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          nodeId: request.nodeId,
          reason: "args-update",
          work: input.work,
        })
      )
    ),
    Match.tag("GraphUnsafeUpdateNode", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const result = yield* input.graphSystem.unsafeUpdateNode(request);

          yield* Match.value(result).pipe(
            Match.tag("Success", ({ nodeId }) =>
              input.emit(RuntimeEvents.graphUnsafeNodeUpdated(nodeId, request.label, at))
            ),
            Match.tag("Failure", ({ error, nodeId }) =>
              input.emit(
                RuntimeEvents.graphUnsafeNodeUpdateFailed(nodeId, request.label, error, at)
              )
            ),
            Match.exhaustive
          );

          return {
            _tag: "GraphUnsafeNodeUpdateCompleted",
            result,
          } satisfies RuntimeSubmission;
        }),
        "frond.graph.unsafeUpdate",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          nodeId: request.nodeId,
          reason: "unsafe-update",
          work: input.work,
        })
      )
    ),
    Match.tag("GraphReleaseNode", ({ nodeId, reason }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;

          yield* input.graphSystem.releaseNode(nodeId, reason);
          const lookup = input.graphSystem.readNodeSnapshotSync(
            nodeId,
            input.syncProjectionContext()
          );
          // Contract: release completion reports the projected retained failure,
          // including live stop failures, while the command result remains void.
          const failure = projectedCleanupFailure(lookup);
          yield* input.emit(RuntimeEvents.graphNodeReleased(nodeId, reason, at, failure));

          return { _tag: "GraphNodeReleased", nodeId } satisfies RuntimeSubmission;
        }),
        "frond.graph.release",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          nodeId,
          reason: "release",
          work: input.work,
        })
      )
    ),
    Match.tag("GraphEvictSubgraph", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const at = yield* Clock.currentTimeMillis;
          const result = yield* input.graphSystem.evictSubgraph(request);

          yield* input.emit(
            RuntimeEvents.graphNodesEvicted(result.nodeIds, request.reason, result.failures, at)
          );

          return { _tag: "GraphSubgraphEvicted", result } satisfies RuntimeSubmission;
        }),
        "frond.graph.evict",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          reason: "eviction",
          work: input.work,
        })
      )
    ),
    Match.tag("GraphAcquireNodeLiveLease", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const result = yield* input.graphSystem.acquireNodeLiveLease(request);

          return {
            _tag: "GraphNodeLiveLeaseAcquired",
            nodeId: result.nodeId,
            leaseId: result.leaseId,
            liveDemand: result.liveDemand,
          } satisfies RuntimeSubmission;
        }),
        "frond.graph.live.acquire",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          nodeId: request.nodeId,
          source: request.source,
          reason: "live",
          work: input.work,
        })
      )
    ),
    Match.tag("GraphReleaseNodeLiveLease", ({ request }) =>
      withRuntimeSpan(
        Effect.gen(function* () {
          const result = yield* input.graphSystem.releaseNodeLiveLease(request);

          return {
            _tag: "GraphNodeLiveLeaseReleased",
            nodeId: result.nodeId,
            leaseId: result.leaseId,
            liveDemand: result.liveDemand,
          } satisfies RuntimeSubmission;
        }),
        "frond.graph.live.release",
        nodeSpanAttributes({
          runtimeId: input.runtimeId,
          nodeId: request.nodeId,
          reason: "live",
          work: input.work,
        })
      )
    ),
    Match.exhaustive
  );
}

function projectedCleanupFailure(lookup: NodeSnapshotLookup): GraphFailure | undefined {
  return lookup._tag === "Found"
    ? (lookup.snapshot.failure as GraphFailure | undefined)
    : undefined;
}

function graphTargetNodeId(
  graphSystem: GraphSystemService,
  target: ActionRequest["target"]
): NodeId {
  return Match.value(target).pipe(
    Match.tag("NodeId", ({ nodeId }) => nodeId),
    Match.tag("NodeRequest", ({ request }) => graphSystem.resolveNodeIdSync(request)),
    Match.exhaustive
  );
}

function graphTargetNodeIdIfKnown(target: ActionRequest["target"]): NodeId | undefined {
  return Match.value(target).pipe(
    Match.tag("NodeId", ({ nodeId }) => nodeId),
    Match.tag("NodeRequest", () => undefined),
    Match.exhaustive
  );
}
