import { type Context, type Effect, Exit } from "effect";
import { finishObserverWork } from "../graph/driverExecution/effectRunner";
import { type GraphCancel, type GraphResume, noCancel } from "../graph/queue/reply";
import type { GraphSystemCore } from "../graph/system/core";
import type { CoreRefreshSubmission } from "../graph/system/refreshAdmission";
import type { GraphFailure } from "../graph/types/failures";
import type { NodeId } from "../graph/types/ids";
import type { ActionRequest } from "../graph/types/operations";
import type { NodeSnapshotLookup, ProjectionContext } from "../graph/types/reads";
import type { GraphSystemService } from "../graph/types/service";
import { canonicalArgs, isKeyError, type KeyError } from "../keys";
import { nodeSpanAttributes } from "./observability";
import type { RuntimeOperationStartRegistry } from "./operationStarts";
import type { RuntimeCommand, RuntimeEvent, RuntimeId, RuntimeSubmission } from "./types";
import type { RuntimeWorkContext } from "./work";

type RuntimeGraphCommandTag = Extract<RuntimeCommand["_tag"], `Graph${string}`>;
export type RuntimeGraphCommand = Extract<
  RuntimeCommand,
  { readonly _tag: RuntimeGraphCommandTag }
>;

export function runRuntimeGraphCommand(
  input: {
    readonly command: RuntimeGraphCommand;
    readonly graphSystem: GraphSystemService;
    readonly graphCore: GraphSystemCore;
    readonly syncClock: { readonly now: () => number };
    readonly work: RuntimeWorkContext;
    readonly emit: (event: RuntimeEvent) => Effect.Effect<void>;
    readonly syncProjectionContext: () => ProjectionContext;
    readonly operationStarts: RuntimeOperationStartRegistry;
  },
  context: Context.Context<never> | undefined,
  resume: GraphResume<RuntimeSubmission, KeyError>
): GraphCancel {
  const command = input.command;
  const graph = input.graphCore;
  const at = input.syncClock.now();
  const complete = (submission: RuntimeSubmission, event?: RuntimeEvent) => {
    if (event === undefined) resume(Exit.succeed(submission));
    else
      finishObserverWork(
        input.emit(event),
        context,
        () => resume(Exit.succeed(submission)),
        graph.jobs
      );
  };
  const fail = (exit: Exit.Failure<unknown, never>) => resume(Exit.failCause(exit.cause));
  try {
    switch (command._tag) {
      case "GraphEnsureNode":
        canonicalArgs(command.request.args);
        return graph.ensureNode(command.request, context, (exit) => {
          if (exit._tag === "Failure") {
            fail(exit);
            return;
          }
          complete(
            { _tag: "GraphNodeEnsured", read: exit.value },
            { _tag: "GraphNodeEnsured", nodeId: exit.value.nodeId, status: exit.value.status, at }
          );
        });
      case "GraphEnsureReadyNode":
      case "GraphEnsureReadyNodeById": {
        const ready: GraphResume<import("../graph").NodeRead> = (exit) => {
          if (exit._tag === "Failure") {
            fail(exit);
            return;
          }
          complete(
            { _tag: "GraphNodeReadyEnsured", read: exit.value },
            {
              _tag: "GraphNodeReadyEnsured",
              nodeId: exit.value.nodeId,
              status: exit.value.status,
              at,
            }
          );
        };
        if (command._tag === "GraphEnsureReadyNodeById")
          return graph.ensureReadyNodeById(command.nodeId, context, ready);
        canonicalArgs(command.request.args);
        return graph.ensureReadyNode(command.request, context, ready);
      }
      case "GraphRunAction": {
        validateTargetArgs(command.request.target);
        const clear = input.operationStarts.registerAction(
          graphTargetNodeId(input.graphSystem, command.request.target),
          command.request.action,
          command.request.input,
          input.work
        );
        const cancel = graph.runAction(command.request, context, (exit) => {
          clear();
          if (exit._tag === "Failure") fail(exit);
          else complete({ _tag: "GraphActionCompleted", result: exit.value });
        });
        return () => {
          clear();
          return cancel();
        };
      }
      case "GraphRefreshNode": {
        validateTargetArgs(command.request.target);
        const clear = input.operationStarts.registerRefresh(
          graphTargetNodeId(input.graphSystem, command.request.target),
          input.work
        );
        let cancelTask: GraphCancel | undefined;
        const cancelPlan = graph.submitRefreshNode(command.request, context, (exit) => {
          if (exit._tag === "Failure") {
            clear();
            fail(exit);
            return;
          }
          const submission = exit.value as CoreRefreshSubmission;
          switch (submission._tag) {
            case "Missing":
              clear();
              complete({ _tag: "GraphRefreshCompleted", result: submission.result });
              break;
            case "Joined":
            case "Started":
              if (submission._tag === "Joined") clear();
              cancelTask = submission.task.listen((exit) => {
                clear();
                if (exit._tag === "Failure") {
                  fail(exit);
                  return;
                }
                const result = exit.value;
                const event: RuntimeEvent | undefined =
                  submission._tag === "Joined"
                    ? undefined
                    : result._tag === "Success"
                      ? {
                          _tag: "GraphRefreshSucceeded",
                          nodeId: result.nodeId,
                          value: result.value,
                          at: input.syncClock.now(),
                        }
                      : {
                          _tag: "GraphRefreshFailed",
                          nodeId: result.nodeId,
                          error: result.error,
                          at: input.syncClock.now(),
                        };
                complete({ _tag: "GraphRefreshCompleted", result }, event);
              });
              break;
          }
        });
        return () => {
          clear();
          return cancelTask === undefined ? cancelPlan() : cancelTask();
        };
      }
      case "GraphUpdateNodeArgs": {
        canonicalArgs(command.request.args);
        const clear = input.operationStarts.registerArgsUpdate(command.request.nodeId, input.work);
        const cancel = graph.updateNodeArgs(command.request, context, (exit) => {
          clear();
          if (exit._tag === "Failure") {
            fail(exit);
            return;
          }
          const result = exit.value;
          complete(
            { _tag: "GraphNodeArgsUpdateCompleted", result },
            result._tag === "Success"
              ? {
                  _tag: "GraphNodeArgsUpdateSucceeded",
                  nodeId: result.nodeId,
                  shouldRefresh: result.shouldRefresh,
                  at: input.syncClock.now(),
                }
              : {
                  _tag: "GraphNodeArgsUpdateFailed",
                  nodeId: result.nodeId,
                  error: result.error,
                  at: input.syncClock.now(),
                }
          );
        });
        return () => {
          clear();
          return cancel();
        };
      }
      case "GraphUnsafeUpdateNode":
        return graph.unsafeUpdateNode(command.request, context, (exit) => {
          if (exit._tag === "Failure") {
            fail(exit);
            return;
          }
          const result = exit.value;
          complete(
            { _tag: "GraphUnsafeNodeUpdateCompleted", result },
            result._tag === "Success"
              ? {
                  _tag: "GraphUnsafeNodeUpdated",
                  nodeId: result.nodeId,
                  label: command.request.label,
                  at,
                }
              : {
                  _tag: "GraphUnsafeNodeUpdateFailed",
                  nodeId: result.nodeId,
                  error: result.error,
                  label: command.request.label,
                  at,
                }
          );
        });
      case "GraphReleaseNode":
        return graph.releaseNode(command.nodeId, command.reason, context, (exit) => {
          if (exit._tag === "Failure") {
            fail(exit);
            return;
          }
          const failure = projectedCleanupFailure(
            input.graphSystem.readNodeSnapshotSync(command.nodeId, input.syncProjectionContext())
          );
          complete(
            { _tag: "GraphNodeReleased", nodeId: command.nodeId },
            {
              _tag: "GraphNodeReleased",
              nodeId: command.nodeId,
              reason: command.reason,
              failure,
              at,
            }
          );
        });
      case "GraphEvictSubgraph":
        return graph.evictSubgraph(command.request, context, (exit) => {
          if (exit._tag === "Failure") {
            fail(exit);
            return;
          }
          const result = exit.value;
          complete(
            { _tag: "GraphSubgraphEvicted", result },
            {
              _tag: "GraphNodesEvicted",
              nodeIds: result.nodeIds,
              reason: command.request.reason,
              failures: result.failures,
              at,
            }
          );
        });
      case "GraphAcquireNodeLiveLease":
        return graph.acquireNodeLiveLease(command.request, context, (exit) => {
          if (exit._tag === "Failure") fail(exit);
          else complete({ _tag: "GraphNodeLiveLeaseAcquired", result: exit.value });
        });
      case "GraphReleaseNodeLiveLease":
        return graph.releaseNodeLiveLease(command.request, context, (exit) => {
          if (exit._tag === "Failure") fail(exit);
          else complete({ _tag: "GraphNodeLiveLeaseReleased", result: exit.value });
        });
      default: {
        const exhaustive: never = command;
        return exhaustive;
      }
    }
  } catch (cause) {
    resume(isKeyError(cause) ? Exit.fail(cause) : Exit.die(cause));
    return noCancel;
  }
}

export function graphCommandSpanName(command: RuntimeGraphCommand): string {
  switch (command._tag) {
    case "GraphEnsureNode":
      return "frond.graph.ensureNode";
    case "GraphEnsureReadyNode":
    case "GraphEnsureReadyNodeById":
      return "frond.graph.ensureReady";
    case "GraphRunAction":
      return "frond.graph.action";
    case "GraphRefreshNode":
      return "frond.graph.refresh";
    case "GraphUpdateNodeArgs":
      return "frond.graph.args";
    case "GraphUnsafeUpdateNode":
      return "frond.graph.unsafeUpdate";
    case "GraphReleaseNode":
      return "frond.graph.release";
    case "GraphEvictSubgraph":
      return "frond.graph.evict";
    case "GraphAcquireNodeLiveLease":
      return "frond.graph.live.acquire";
    case "GraphReleaseNodeLiveLease":
      return "frond.graph.live.release";
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
}
function projectedCleanupFailure(lookup: NodeSnapshotLookup): GraphFailure | undefined {
  return lookup._tag === "Found"
    ? (lookup.snapshot.failure as GraphFailure | undefined)
    : undefined;
}
function validateTargetArgs(target: ActionRequest["target"]): void {
  if (target._tag === "NodeRequest") canonicalArgs(target.request.args);
}
function graphTargetNodeId(graph: GraphSystemService, target: ActionRequest["target"]): NodeId {
  return target._tag === "NodeId" ? target.nodeId : graph.resolveNodeIdSync(target.request);
}

/** Attribute construction belongs only to the Effect facade. */
export function graphCommandSpanAttributes(
  runtimeId: RuntimeId,
  command: RuntimeGraphCommand,
  work: RuntimeWorkContext
): Record<string, unknown> {
  let nodeId: NodeId | undefined;
  let action: string | undefined;
  let source: string | undefined;
  let reason: string;
  switch (command._tag) {
    case "GraphEnsureNode":
    case "GraphEnsureReadyNode":
      reason = "readiness";
      break;
    case "GraphEnsureReadyNodeById":
      nodeId = command.nodeId;
      reason = "readiness";
      break;
    case "GraphRunAction":
      nodeId = knownTargetNodeId(command.request.target);
      action = command.request.action;
      reason = "action";
      break;
    case "GraphRefreshNode":
      nodeId = knownTargetNodeId(command.request.target);
      reason = "refresh";
      break;
    case "GraphUpdateNodeArgs":
      nodeId = command.request.nodeId;
      reason = "args-update";
      break;
    case "GraphUnsafeUpdateNode":
      nodeId = command.request.nodeId;
      reason = "unsafe-update";
      break;
    case "GraphReleaseNode":
      nodeId = command.nodeId;
      reason = "release";
      break;
    case "GraphEvictSubgraph":
      reason = "eviction";
      break;
    case "GraphAcquireNodeLiveLease":
      nodeId = command.request.nodeId;
      source = command.request.source;
      reason = "live";
      break;
    case "GraphReleaseNodeLiveLease":
      nodeId = command.request.nodeId;
      reason = "live";
      break;
    default: {
      const exhaustive: never = command;
      return exhaustive;
    }
  }
  return nodeSpanAttributes({ runtimeId, nodeId, action, source, reason, work });
}
function knownTargetNodeId(target: ActionRequest["target"]): NodeId | undefined {
  return target._tag === "NodeId" ? target.nodeId : undefined;
}
