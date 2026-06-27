import type { NodeId, NodeKey, SystemStatus } from "./ids";
import type { NodeLiveDemandSnapshot, NodeLiveFailure } from "./liveness";
import type { NodeOperation, NodeOperationFailure } from "./operations";
import type { ResultValidity } from "./resultValidity";

export type NodeRunState =
  | {
      readonly _tag: "Idle";
    }
  | {
      readonly _tag: "Pending";
      readonly attemptId: number;
    }
  | {
      readonly _tag: "Ready";
    }
  | {
      readonly _tag: "Error";
      readonly error: unknown;
    };

export type NodeStatus =
  | {
      readonly _tag: "Unwired";
    }
  | {
      readonly _tag: "Invalid";
      readonly error: unknown;
    }
  | {
      readonly _tag: "Wired";
      readonly run: NodeRunState;
    };

export type NodeObjectLookup =
  | {
      readonly _tag: "Found";
      readonly node: object;
    }
  | {
      readonly _tag: "Missing";
    };

interface NodeReadBase {
  readonly nodeId: NodeId;
  readonly tag?: string | undefined;
  readonly status: NodeStatus;
  readonly resultValidity?: ResultValidity | undefined;
}

export type NodeRead =
  | ({
      readonly _tag: "Unwired";
    } & NodeReadBase)
  | ({
      readonly _tag: "Idle";
    } & NodeReadBase)
  | ({
      readonly _tag: "Pending";
    } & NodeReadBase)
  | ({
      readonly _tag: "Ready";
      readonly node: object;
    } & NodeReadBase)
  | ({
      readonly _tag: "Error";
      readonly error: unknown;
    } & NodeReadBase)
  | ({
      readonly _tag: "Invalid";
      readonly nodeLookup: NodeObjectLookup;
      readonly error: unknown;
    } & NodeReadBase);

interface NodeSnapshotBase {
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly kind: string;
  readonly key: NodeKey;
  readonly label: string;
  readonly status: NodeStatus;
  readonly resultValidity?: ResultValidity | undefined;
  readonly liveDemand: NodeLiveDemandSnapshot;
  readonly liveFailure?: NodeLiveFailure | undefined;
  readonly operation: NodeOperation;
  readonly operationFailure?: NodeOperationFailure | undefined;
  readonly failure?: unknown;
}

export type NodeSnapshot =
  | ({
      readonly _tag: "Unwired";
    } & NodeSnapshotBase)
  | ({
      readonly _tag: "Idle";
    } & NodeSnapshotBase)
  | ({
      readonly _tag: "Pending";
      readonly attempt: Promise<NodeRead>;
    } & NodeSnapshotBase)
  | ({
      readonly _tag: "Ready";
      readonly node: object;
      readonly result: unknown;
    } & NodeSnapshotBase)
  | ({
      readonly _tag: "ReadinessError";
      readonly error: unknown;
    } & NodeSnapshotBase)
  | ({
      readonly _tag: "Releasing";
    } & NodeSnapshotBase)
  | ({
      readonly _tag: "Invalid";
      readonly nodeLookup: NodeObjectLookup;
      readonly error: unknown;
    } & NodeSnapshotBase);

export type NodeSnapshotLookup =
  | {
      readonly _tag: "Found";
      readonly snapshot: NodeSnapshot;
    }
  | {
      readonly _tag: "Missing";
      readonly nodeId: NodeId;
    };

export interface EdgeSnapshot {
  readonly from: NodeId;
  readonly to: NodeId;
  readonly dependency: string;
}

export interface SystemSnapshot {
  readonly status: SystemStatus;
  readonly observedInputs: number;
  readonly nodes: ReadonlyArray<NodeSnapshot>;
  readonly edges: ReadonlyArray<EdgeSnapshot>;
}

export interface ProjectionContext {
  readonly now: number;
}
