import type { NodeId, NodeOperationKind } from "../graph/types";
import type {
  GraphActionCompleted,
  GraphObserverChannel,
  GraphObserverFailure,
  GraphOperationStarted,
} from "../graph/types/subscriptions";
import { FrondRuntimeInvariantViolation } from "./errors";
import { RuntimeEvents } from "./events";
import type { RuntimeEvent } from "./types";
import type { RuntimeWorkContext } from "./work";

type PendingRuntimeOperationStart =
  | {
      readonly _tag: "Action";
      readonly nodeId: NodeId;
      readonly action: string;
      readonly input: unknown;
      readonly work: RuntimeWorkContext;
    }
  | {
      readonly _tag: "Refresh";
      readonly nodeId: NodeId;
      readonly work: RuntimeWorkContext;
    }
  | {
      readonly _tag: "Args";
      readonly nodeId: NodeId;
      readonly work: RuntimeWorkContext;
    };

export interface RuntimeOperationStartRegistry {
  readonly registerAction: (
    nodeId: NodeId,
    action: string,
    input: unknown,
    work: RuntimeWorkContext
  ) => () => boolean;
  readonly registerRefresh: (nodeId: NodeId, work: RuntimeWorkContext) => () => boolean;
  readonly registerArgsUpdate: (nodeId: NodeId, work: RuntimeWorkContext) => () => boolean;
  readonly recordStarted: (
    started: GraphOperationStarted,
    fallbackWork: (reason: RuntimeWorkContext["reason"]) => RuntimeWorkContext
  ) => { readonly event: RuntimeEvent; readonly work: RuntimeWorkContext };
  readonly recordActionCompleted: (
    completed: GraphActionCompleted,
    fallbackWork: () => RuntimeWorkContext
  ) => { readonly event: RuntimeEvent; readonly work: RuntimeWorkContext };
}

export function makeRuntimeOperationStartRegistry(): RuntimeOperationStartRegistry {
  let nextId = 1;
  const pending = new Map<
    string,
    Array<{ readonly id: number; readonly operation: PendingRuntimeOperationStart }>
  >();
  const activeActions = new Map<
    string,
    {
      readonly action: string;
      readonly input: unknown;
      readonly work: RuntimeWorkContext;
    }
  >();

  return {
    registerAction: (nodeId, action, input, work) =>
      registerPending(pending, nextPendingId(), actionKey(nodeId, action), {
        _tag: "Action",
        nodeId,
        action,
        input,
        work,
      }),
    registerRefresh: (nodeId, work) =>
      registerPending(pending, nextPendingId(), refreshKey(nodeId), {
        _tag: "Refresh",
        nodeId,
        work,
      }),
    registerArgsUpdate: (nodeId, work) =>
      registerPending(pending, nextPendingId(), argsKey(nodeId), {
        _tag: "Args",
        nodeId,
        work,
      }),
    recordStarted: (started, fallbackWork) => {
      const pendingOperation = takePending(pending, operationStartKey(started))?.operation;
      const work = pendingOperation?.work ?? fallbackWork(operationReason(started));
      const event = runtimeEventForOperationStart(started, pendingOperation);

      if (started._tag === "ActionStarted") {
        activeActions.set(actionCompletionKey(started.nodeId, started.operation.operationId), {
          action: pendingOperation?._tag === "Action" ? pendingOperation.action : started.action,
          input: pendingOperation?._tag === "Action" ? pendingOperation.input : started.input,
          work,
        });
      }

      return { event, work };
    },
    recordActionCompleted: (completed, fallbackWork) => {
      const active =
        completed.operation === undefined
          ? undefined
          : takeActiveAction(
              activeActions,
              actionCompletionKey(completed.nodeId, completed.operation.operationId)
            );
      const pendingOperation =
        active === undefined
          ? takePending(pending, actionKey(completed.nodeId, completed.action))?.operation
          : undefined;
      const work =
        active?.work ??
        (pendingOperation?._tag === "Action" ? pendingOperation.work : undefined) ??
        fallbackWork();
      const action =
        active?.action ??
        (pendingOperation?._tag === "Action" ? pendingOperation.action : completed.action);
      const input =
        active?.input ??
        (pendingOperation?._tag === "Action" ? pendingOperation.input : completed.input);

      return {
        event: runtimeEventForActionCompletion(completed, action, input),
        work,
      };
    },
  };

  function nextPendingId(): number {
    const id = nextId;
    nextId += 1;
    return id;
  }
}

function runtimeEventForOperationStart(
  started: GraphOperationStarted,
  pending: PendingRuntimeOperationStart | undefined
): RuntimeEvent {
  return operationStartEvent[started.operation.kind](started, pending);
}

export function runtimeEventTagForGraphObserverChannel(
  failure: GraphObserverFailure
): RuntimeEvent["_tag"] {
  return graphObserverChannelEventTag(failure);
}

function graphObserverChannelEventTag(failure: {
  readonly channel: GraphObserverChannel;
  readonly value: unknown;
}): RuntimeEvent["_tag"] {
  return graphObserverEventTag[failure.channel](failure.value);
}

function operationStartFailureEventTag(value: unknown): RuntimeEvent["_tag"] {
  const operation = (value as Partial<GraphOperationStarted> | undefined)?.operation;

  if (operation?._tag !== "Running") {
    return "GraphActionStarted";
  }

  return operationStartEventTag[operation.kind];
}

const operationStartKeyByKind = {
  action: (started: GraphOperationStarted) =>
    started._tag === "ActionStarted" ? actionKey(started.nodeId, started.action) : "",
  refresh: (started: GraphOperationStarted) => refreshKey(started.nodeId),
  args: (started: GraphOperationStarted) => argsKey(started.nodeId),
} satisfies Record<NodeOperationKind, (started: GraphOperationStarted) => string>;

const operationStartEvent = {
  action: (started: GraphOperationStarted, pending: PendingRuntimeOperationStart | undefined) => {
    const action = pending?._tag === "Action" ? pending.action : actionStarted(started).action;
    const input = pending?._tag === "Action" ? pending.input : actionStarted(started).input;
    return RuntimeEvents.graphActionStarted(
      started.nodeId,
      action,
      input,
      started.operation.startedAt
    );
  },
  refresh: (started: GraphOperationStarted) =>
    RuntimeEvents.graphRefreshStarted(started.nodeId, started.operation.startedAt),
  args: (started: GraphOperationStarted) =>
    RuntimeEvents.graphNodeArgsUpdateStarted(started.nodeId, started.operation.startedAt),
} satisfies Record<
  NodeOperationKind,
  (
    started: GraphOperationStarted,
    pending: PendingRuntimeOperationStart | undefined
  ) => RuntimeEvent
>;

const operationStartEventTag = {
  action: "GraphActionStarted",
  refresh: "GraphRefreshStarted",
  args: "GraphNodeArgsUpdateStarted",
} satisfies Record<NodeOperationKind, RuntimeEvent["_tag"]>;

const graphObserverEventTag = {
  "node-change": () => "GraphNodeChanged",
  "result-validity": () => "GraphNodeResultValidityChanged",
  "live-demand": () => "GraphNodeLiveDemandChanged",
  "live-failure": () => "GraphNodeLiveFailed",
  "cleanup-failure": () => "GraphNodeCleanupFailed",
  "operation-start": operationStartFailureEventTag,
  "action-completion": actionCompletionFailureEventTag,
} satisfies Record<GraphObserverChannel, (value: unknown) => RuntimeEvent["_tag"]>;

function operationStartKey(started: GraphOperationStarted): string {
  return operationStartKeyByKind[started.operation.kind](started);
}

function operationReason(started: GraphOperationStarted): RuntimeWorkContext["reason"] {
  return started.operation.kind === "args" ? "args-update" : started.operation.kind;
}

function runtimeEventForActionCompletion(
  completed: GraphActionCompleted,
  action: string,
  input: unknown
): RuntimeEvent {
  return completed.result._tag === "Success"
    ? RuntimeEvents.graphActionSucceeded(
        completed.nodeId,
        action,
        input,
        completed.result.value,
        completed.completedAt
      )
    : RuntimeEvents.graphActionFailed(
        completed.nodeId,
        action,
        input,
        completed.result.error,
        completed.completedAt
      );
}

function actionCompletionFailureEventTag(value: unknown): RuntimeEvent["_tag"] {
  const result = (value as Partial<GraphActionCompleted> | undefined)?.result;

  // Default to the failure tag — if we cannot determine the original action
  // completion result, the conservative (diagnostic-safe) choice is to classify
  // it as a failure rather than a success.
  return result?._tag === "Success" ? "GraphActionSucceeded" : "GraphActionFailed";
}

function actionCompletionKey(nodeId: NodeId, operationId: number): string {
  return `${nodeId}:action:${operationId}`;
}

function actionStarted(
  started: GraphOperationStarted
): Extract<GraphOperationStarted, { readonly _tag: "ActionStarted" }> {
  if (started._tag !== "ActionStarted") {
    throw new FrondRuntimeInvariantViolation({
      message: "Expected action operation start.",
      cause: started,
    });
  }

  return started;
}

function takeActiveAction(
  activeActions: Map<
    string,
    {
      readonly action: string;
      readonly input: unknown;
      readonly work: RuntimeWorkContext;
    }
  >,
  key: string
):
  | {
      readonly action: string;
      readonly input: unknown;
      readonly work: RuntimeWorkContext;
    }
  | undefined {
  const active = activeActions.get(key);
  activeActions.delete(key);
  return active;
}

function registerPending(
  pending: Map<
    string,
    Array<{ readonly id: number; readonly operation: PendingRuntimeOperationStart }>
  >,
  id: number,
  key: string,
  operation: PendingRuntimeOperationStart
): () => boolean {
  const queue = pending.get(key) ?? [];
  queue.push({ id, operation });
  pending.set(key, queue);

  return () => removePending(pending, key, id);
}

function takePending(
  pending: Map<
    string,
    Array<{ readonly id: number; readonly operation: PendingRuntimeOperationStart }>
  >,
  key: string
): { readonly id: number; readonly operation: PendingRuntimeOperationStart } | undefined {
  const queue = pending.get(key);

  if (queue === undefined) {
    return undefined;
  }

  const record = queue.shift();
  if (queue.length === 0) {
    pending.delete(key);
  }

  return record;
}

function removePending(
  pending: Map<
    string,
    Array<{ readonly id: number; readonly operation: PendingRuntimeOperationStart }>
  >,
  key: string,
  id: number
): boolean {
  const queue = pending.get(key);

  if (queue === undefined) {
    return false;
  }

  const next = queue.filter((record) => record.id !== id);
  const removed = next.length !== queue.length;

  if (next.length === 0) {
    pending.delete(key);
    return removed;
  }

  pending.set(key, next);
  return removed;
}

function actionKey(nodeId: NodeId, action: string): string {
  return `${nodeId}\u0000action\u0000${action}`;
}

function refreshKey(nodeId: NodeId): string {
  return `${nodeId}\u0000refresh`;
}

function argsKey(nodeId: NodeId): string {
  return `${nodeId}\u0000args`;
}
