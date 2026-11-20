import { type Context, type Effect, Exit } from "effect";
import type { ActionAdmission } from "../../driver";
import { canonicalKey } from "../../keys";
import { lookupGraphNodeCell } from "../cell/cellLookup";
import type { GraphNodeCell, GraphPlanState } from "../cell/cellModel";
import {
  refreshOperation,
  releaseOperation,
  runActionOperation,
  unsafeUpdateNodeOperation,
  updateArgsOperation,
} from "../cell/cellOperations";
import type { GraphCellTask } from "../cell/cellQueue";
import type { GraphCellQueueRegistry } from "../cell/queueRegistry";
import { finishObserverWork } from "../driverExecution/effectRunner";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import {
  makeActionFailure,
  makeMissingNodeActionFailure,
  makeMissingNodeUpdateArgsFailure,
  makeMissingUnsafeUpdateNodeFailure,
} from "../operations/operationFailures";
import { resolveEffectiveNodeId } from "../planning/identity";
import { ensurePlannedNodeSync } from "../planning/plan";
import { type GraphGate, planTask } from "../queue/graphGate";
import {
  type CoreCall,
  callbackEffect,
  completedTask,
  type GraphCancel,
  GraphReply,
  type GraphResume,
  noCancel,
} from "../queue/reply";
import { submitReadiness } from "../readiness/submission";
import {
  type ActionRequest,
  type ActionResult,
  GraphInvariantViolation,
  type GraphSystemService,
  type NodeId,
  type RefreshRequest,
} from "../types";
import { registerAdmittedTask } from "./admissionRegistration";
import type { CoreRefreshSubmission, RefreshAdmissionController } from "./refreshAdmission";

export type GraphCommandsCore = {
  readonly [K in Exclude<keyof GraphSystemCommands, "core" | "submitRefreshDirect">]: CoreCall<
    GraphSystemCommands[K]
  >;
};

export interface GraphSystemCommands {
  readonly core: GraphCommandsCore;
  /** `core.submitRefreshNode`, typed with the callback task it submits. */
  readonly submitRefreshDirect: (
    request: RefreshRequest,
    context: Context.Context<never> | undefined,
    resume: GraphResume<CoreRefreshSubmission>
  ) => GraphCancel;
  readonly ensureReadyNode: GraphSystemService["ensureReadyNode"];
  readonly runAction: GraphSystemService["runAction"];
  readonly submitRefreshNode: GraphSystemService["submitRefreshNode"];
  readonly refreshNode: GraphSystemService["refreshNode"];
  readonly updateNodeArgs: GraphSystemService["updateNodeArgs"];
  readonly unsafeUpdateNode: GraphSystemService["unsafeUpdateNode"];
  readonly releaseNode: GraphSystemService["releaseNode"];
  readonly executeNodeAction: (
    nodeId: NodeId,
    action: string,
    input: unknown
  ) => Effect.Effect<ActionResult>;
}

export function makeGraphSystemCommands(options: {
  readonly state: GraphPlanState;
  readonly gate: GraphGate;
  readonly queueRegistry: GraphCellQueueRegistry;
  readonly graphEnv: GraphOperationEnvironment;
  readonly refreshAdmission: RefreshAdmissionController;
}): GraphSystemCommands {
  const activeActionAdmissions = new Map<string, GraphCellTask<ActionResult>>();
  const { state, gate, queueRegistry, graphEnv } = options;
  const resolveTarget = (target: ActionRequest["target"]) =>
    lookupGraphNodeCell(
      state,
      target._tag === "NodeRequest"
        ? ensurePlannedNodeSync(state, target.request).nodeId
        : target.nodeId
    );

  const completedAction = (
    nodeId: NodeId,
    request: ActionRequest,
    result: ActionResult
  ): GraphCellTask<ActionResult> => {
    const reply = new GraphReply<ActionResult>();
    finishObserverWork(
      state.notifyActionCompleted({
        nodeId,
        action: request.action,
        input: request.input,
        result,
        completedAt: state.syncClock.now(),
      }),
      undefined,
      () => reply.settle(Exit.succeed(result)),
      state.jobs
    );
    return reply;
  };

  function submitAction(
    cell: GraphNodeCell,
    request: ActionRequest,
    context: Context.Context<never> | undefined
  ): GraphCellTask<ActionResult> {
    const action = cell.descriptor.driver.actions.read(request.action);
    if (action._tag === "Missing" || action.admission.policy === "queue")
      return queueRegistry.submitSync(cell, runActionOperation(graphEnv, cell, request), context, {
        interruptible: true,
      });
    const key = readActionAdmissionKey(cell, request, action.admission);
    if (key._tag === "Failure")
      return completedAction(cell.nodeId, request, makeActionFailure(cell, request, key.cause));
    const active = activeActionAdmissions.get(key.key);
    if (active !== undefined) {
      if (action.admission.policy === "join") return active;
      return completedAction(
        cell.nodeId,
        request,
        makeActionFailure(
          cell,
          request,
          new GraphInvariantViolation({
            nodeId: cell.nodeId,
            tag: cell.tag,
            invariant: "action admission rejected a concurrent request",
            cause: { action: request.action },
          })
        )
      );
    }
    return registerAdmittedTask({
      active: activeActionAdmissions,
      key: key.key,
      start: (onComplete) =>
        queueRegistry.submitSync(cell, runActionOperation(graphEnv, cell, request), context, {
          onComplete,
          // A join call never joins a decided operation no caller is attached to.
          onDecided: action.admission.policy === "join" ? onComplete : undefined,
          interruptible: action.admission.policy === "reject",
        }),
    });
  }

  const core: GraphCommandsCore = {
    runAction: (request, context, resume) =>
      planTask(
        gate,
        (context) => {
          const lookup = resolveTarget(request.target);
          return lookup._tag === "Missing"
            ? completedAction(
                lookup.nodeId,
                request,
                makeMissingNodeActionFailure(lookup.nodeId, request)
              )
            : submitAction(lookup.cell, request, context);
        },
        context,
        resume
      ),
    ensureReadyNode: (request, context, resume) =>
      planTask(
        gate,
        (context) => {
          const handle = ensurePlannedNodeSync(state, request);
          const cell = state.nodes.get(handle.nodeId);
          return cell === undefined
            ? completedTask(handle)
            : submitReadiness(queueRegistry, graphEnv, cell, context);
        },
        context,
        resume,
        true
      ),
    submitRefreshNode: submitRefreshDirect,
    refreshNode: (request, context, resume) =>
      planTask(
        gate,
        (context) => {
          const submission = planRefresh(request, context);
          return submission._tag === "Missing" ? completedTask(submission.result) : submission.task;
        },
        context,
        resume
      ),
    updateNodeArgs: (request, context, resume) => {
      let submitted = false;
      const cancel = planTask(
        gate,
        (context) => {
          const nextNodeId = resolveEffectiveNodeId(state, {
            spec: request.spec,
            args: request.args,
          });
          if (nextNodeId !== request.nodeId)
            return completedTask(
              makeMissingNodeUpdateArgsFailure(
                request.nodeId,
                request,
                `same-identity args update resolved ${nextNodeId}`
              )
            );
          const cell = state.nodes.get(request.nodeId);
          if (cell === undefined)
            return completedTask(makeMissingNodeUpdateArgsFailure(request.nodeId, request));
          submitted = true;
          return queueRegistry.submitSync(
            cell,
            updateArgsOperation(graphEnv, cell, request),
            context
          );
        },
        context,
        resume
      );
      // A submitted update is not interruptible and commits whatever its caller
      // does, so its caller stays attached: the commit still reaches the handle's
      // args and the event bus. Only an update not yet planned is withdrawn.
      return () => (submitted ? noCancel() : cancel());
    },
    unsafeUpdateNode: (request, context, resume) =>
      planTask(
        gate,
        (context) => {
          const cell = state.nodes.get(request.nodeId);
          return cell === undefined
            ? completedTask(makeMissingUnsafeUpdateNodeFailure(request.nodeId, request))
            : queueRegistry.submitSync(cell, unsafeUpdateNodeOperation(cell, request), context);
        },
        context,
        resume
      ),
    releaseNode: (nodeId, reason, context, resume) =>
      planTask(
        gate,
        (context) => {
          const cell = state.nodes.get(nodeId);
          return cell === undefined
            ? completedTask(undefined)
            : queueRegistry.submitSync(cell, releaseOperation(graphEnv, cell, reason), context);
        },
        context,
        resume
      ),
    executeNodeAction: (nodeId, action, input, context, resume) =>
      core.runAction({ target: { _tag: "NodeId", nodeId }, action, input }, context, resume),
  };
  function submitRefreshDirect(
    request: RefreshRequest,
    context: Context.Context<never> | undefined,
    resume: GraphResume<CoreRefreshSubmission>
  ): GraphCancel {
    return gate.planDirect((context) => planRefresh(request, context), context, resume);
  }
  function planRefresh(
    request: RefreshRequest,
    context: Context.Context<never> | undefined
  ): CoreRefreshSubmission {
    return options.refreshAdmission.submit({
      request,
      cellLookup: resolveTarget(request.target),
      start: (cell, onComplete) =>
        queueRegistry.submitSync(cell, refreshOperation(graphEnv, cell, request), context, {
          onComplete,
          onDecided: onComplete,
        }),
    });
  }
  return {
    core,
    submitRefreshDirect,
    ensureReadyNode: (request) =>
      callbackEffect((context, resume) => core.ensureReadyNode(request, context, resume)),
    runAction: (request) =>
      callbackEffect((context, resume) => core.runAction(request, context, resume)),
    submitRefreshNode: (request) =>
      callbackEffect((context, resume) => core.submitRefreshNode(request, context, resume)),
    refreshNode: (request) =>
      callbackEffect((context, resume) => core.refreshNode(request, context, resume)),
    updateNodeArgs: (request) =>
      callbackEffect((context, resume) => core.updateNodeArgs(request, context, resume)),
    unsafeUpdateNode: (request) =>
      callbackEffect((context, resume) => core.unsafeUpdateNode(request, context, resume)),
    releaseNode: (nodeId, reason) =>
      callbackEffect((context, resume) => core.releaseNode(nodeId, reason, context, resume)),
    executeNodeAction: (nodeId, action, input) =>
      callbackEffect((context, resume) =>
        core.executeNodeAction(nodeId, action, input, context, resume)
      ),
  };
}

function readActionAdmissionKey(
  cell: GraphNodeCell,
  request: ActionRequest,
  admission: ActionAdmission
):
  | {
      readonly _tag: "Success";
      readonly key: string;
    }
  | {
      readonly _tag: "Failure";
      readonly cause: unknown;
    } {
  try {
    // A join admission without an authored admissionKey (void-input actions)
    // falls through to the same constant per-node/action key reject uses, so
    // every concurrent invocation shares the one in-flight run.
    const raw =
      admission.policy === "join" && admission.admissionKey !== undefined
        ? admission.admissionKey(request.input)
        : { nodeId: cell.nodeId, action: request.action };
    return {
      _tag: "Success",
      key: `${cell.nodeId}:${request.action}:${canonicalKey(raw)}`,
    };
  } catch (cause) {
    return {
      _tag: "Failure",
      cause: new GraphInvariantViolation({
        nodeId: cell.nodeId,
        tag: cell.tag,
        invariant: "action admission key must be canonicalizable",
        cause,
      }),
    };
  }
}
