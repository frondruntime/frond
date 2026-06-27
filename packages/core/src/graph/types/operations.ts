import type { Effect } from "effect";
import type { RuntimeCancellationReason } from "../../cancellation";
import type {
  ActionFailed,
  GraphFailure,
  RefreshFailed,
  UnsafeUpdateNodeFailed,
  UpdateNodeArgsFailed,
} from "./failures";
import type { NodeId } from "./ids";

export type NodeOperationKind = "action" | "refresh" | "args";

export type NodeOperation =
  | {
      readonly _tag: "Idle";
    }
  | {
      readonly _tag: "Running";
      readonly operationId: number;
      readonly kind: NodeOperationKind;
      readonly startedAt: number;
      readonly action?: string | undefined;
    };

export interface NodeOperationFailure {
  readonly operationId: number;
  readonly kind: NodeOperationKind;
  readonly error: unknown;
  readonly at: number;
}

export interface NodeRequest {
  readonly spec: unknown;
  readonly args: unknown;
}

export interface SpecOverride {
  readonly from: unknown;
  readonly to: unknown;
}

export type NodeTarget =
  | {
      readonly _tag: "NodeRequest";
      readonly request: NodeRequest;
    }
  | {
      readonly _tag: "NodeId";
      readonly nodeId: NodeId;
    };

export interface ActionRequest {
  readonly target: NodeTarget;
  readonly action: string;
  readonly input: unknown;
}

export interface RefreshRequest {
  readonly target: NodeTarget;
}

export type EvictMode = "dependents" | "selfAndDependents";

export interface EvictSubgraphRequest {
  readonly rootNodeIds: ReadonlyArray<NodeId>;
  readonly mode: EvictMode;
  readonly cancellation?: RuntimeCancellationReason | undefined;
  readonly reason?: string | undefined;
}

export interface EvictResult {
  readonly nodeIds: ReadonlyArray<NodeId>;
  readonly failures: ReadonlyArray<GraphFailure>;
}

export interface GraphNodeCleanupResult {
  readonly nodeId: NodeId;
  readonly failures: ReadonlyArray<GraphFailure>;
}

export interface UpdateNodeArgsRequest {
  readonly nodeId: NodeId;
  readonly spec: unknown;
  readonly args: unknown;
}

export type UpdateNodeArgsResult =
  | {
      readonly _tag: "Success";
      readonly nodeId: NodeId;
      readonly shouldRefresh: boolean;
    }
  | {
      readonly _tag: "Failure";
      readonly nodeId: NodeId;
      readonly error: UpdateNodeArgsFailed;
    };

export interface UnsafeUpdateNodeRequest {
  readonly nodeId: NodeId;
  readonly recipe: (node: object) => void;
  readonly label?: string | undefined;
}

export type UnsafeUpdateNodeResult =
  | {
      readonly _tag: "Success";
      readonly nodeId: NodeId;
      readonly value?: unknown;
    }
  | {
      readonly _tag: "Failure";
      readonly nodeId: NodeId;
      readonly error: UnsafeUpdateNodeFailed;
    };

export type ActionResult =
  | {
      readonly _tag: "Success";
      readonly nodeId: NodeId;
      readonly value: unknown;
    }
  | {
      readonly _tag: "Failure";
      readonly nodeId: NodeId;
      readonly error: ActionFailed;
    };

export type RefreshResult =
  | {
      readonly _tag: "Success";
      readonly nodeId: NodeId;
      readonly value: unknown;
    }
  | {
      readonly _tag: "Failure";
      readonly nodeId: NodeId;
      readonly error: RefreshFailed;
    };

export type OperationAdmissionPolicy = "queue" | "join" | "reject";

export type OperationAdmission = {
  readonly policy: OperationAdmissionPolicy;
  readonly outcome: "started" | "joined" | "queued" | "rejected";
};

export type OperationAdmissionKey = {
  readonly _tag: "Refresh";
  readonly nodeId: NodeId;
};

export interface GraphTask<A> {
  readonly await: Effect.Effect<A>;
}

export type RefreshSubmission =
  | {
      readonly _tag: "Started";
      readonly nodeId: NodeId;
      readonly admission: OperationAdmission;
      readonly task: GraphTask<RefreshResult>;
    }
  | {
      readonly _tag: "Joined";
      readonly nodeId: NodeId;
      readonly admission: OperationAdmission;
      readonly task: GraphTask<RefreshResult>;
    }
  | {
      readonly _tag: "Missing";
      readonly nodeId: NodeId;
      readonly admission: OperationAdmission;
      readonly result: RefreshResult;
    };
