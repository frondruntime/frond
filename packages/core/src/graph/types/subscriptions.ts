import type { Effect } from "effect";
import type { GraphFailure } from "./failures";
import type { NodeId } from "./ids";
import type { NodeLiveDemandSnapshot } from "./liveness";
import type { ActionResult, NodeOperation } from "./operations";
import type { ResultValidity, ResultValidityChangedReason } from "./resultValidity";

export type GraphNodeChangeObserver = (nodeId: NodeId) => Effect.Effect<void>;

export interface GraphSubscription {
  readonly unsubscribe: () => void;
}

export type GraphResultValidityObserver = (
  nodeId: NodeId,
  previous: ResultValidity,
  next: ResultValidity,
  reason: ResultValidityChangedReason
) => Effect.Effect<void>;

export type GraphLiveDemandObserver = (
  nodeId: NodeId,
  liveDemand: NodeLiveDemandSnapshot
) => Effect.Effect<void>;

export type GraphLiveFailureObserver = (
  nodeId: NodeId,
  failures: ReadonlyArray<GraphFailure>
) => Effect.Effect<void>;

export type GraphCleanupFailureReason =
  | "acquire"
  | "action"
  | "expired-invalidation"
  | "invalidate"
  | "interrupt"
  | "refresh";

export type GraphCleanupFailureObserver = (
  nodeId: NodeId,
  reason: GraphCleanupFailureReason,
  failures: ReadonlyArray<GraphFailure>
) => Effect.Effect<void>;

export type RunningNodeOperation = Extract<NodeOperation, { readonly _tag: "Running" }>;
export type RunningActionOperation = RunningNodeOperation & {
  readonly kind: "action";
  readonly action: string;
};
export type RunningRefreshOperation = RunningNodeOperation & {
  readonly kind: "refresh";
};
export type RunningArgsOperation = RunningNodeOperation & {
  readonly kind: "args";
};

export type GraphOperationStarted =
  | {
      readonly _tag: "ActionStarted";
      readonly nodeId: NodeId;
      readonly operation: RunningActionOperation;
      readonly action: string;
      readonly input: unknown;
    }
  | {
      readonly _tag: "RefreshStarted";
      readonly nodeId: NodeId;
      readonly operation: RunningRefreshOperation;
    }
  | {
      readonly _tag: "ArgsUpdateStarted";
      readonly nodeId: NodeId;
      readonly operation: RunningArgsOperation;
    };

export type GraphOperationStartObserver = (started: GraphOperationStarted) => Effect.Effect<void>;

export interface GraphActionCompleted {
  readonly nodeId: NodeId;
  readonly operation?: RunningActionOperation | undefined;
  readonly action: string;
  readonly input: unknown;
  readonly result: ActionResult;
  readonly completedAt: number;
}

export type GraphActionCompletionObserver = (
  completed: GraphActionCompleted
) => Effect.Effect<void>;

export type GraphObserverChannel =
  | "node-change"
  | "result-validity"
  | "live-demand"
  | "live-failure"
  | "cleanup-failure"
  | "operation-start"
  | "action-completion";

export interface GraphObserverFailure {
  readonly channel: GraphObserverChannel;
  readonly value: unknown;
  readonly cause: unknown;
}

export type GraphObserverFailureObserver = (failure: GraphObserverFailure) => Effect.Effect<void>;
