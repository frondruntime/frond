import type { Effect } from "effect";
import type { NodeDescriptor } from "../planning/descriptor";
import type {
  DriverOperationTimeouts,
  EdgeSnapshot,
  GraphActionCompletionObserver,
  GraphCleanupFailureObserver,
  GraphLiveFailureObserver,
  GraphNodeChangeObserver,
  GraphOperationStartObserver,
  GraphResultValidityObserver,
  NodeId,
  NodeLiveDemandSnapshot,
  NodeLiveLeaseId,
  NodeRequest,
  NodeSnapshot,
  NormalizedResultValidityPolicy,
  ObservedResultLease,
} from "../types";
import type { ActionResult } from "../types/operations";
import type { GraphCellActor } from "./cellActor";
import type { CellPhase } from "./cellPhase";
import type { GraphCellState, GraphCellStateReader } from "./cellState";

export interface GraphPlanState {
  readonly nodes: Map<NodeId, GraphNodeCell>;
  readonly edges: Map<string, EdgeSnapshot>;
  readonly specByTag: Map<string, unknown>;
  readonly specOverrides: ReadonlyMap<unknown, unknown>;
  readonly driverTimeouts: DriverOperationTimeouts;
  readonly nextLiveLeaseId: () => NodeLiveLeaseId;
  readonly executeNodeAction: (
    nodeId: NodeId,
    action: string,
    input: unknown
  ) => Effect.Effect<ActionResult>;
  readonly notifyNodeChanged: GraphNodeChangeObserver;
  readonly notifyOperationStarted: GraphOperationStartObserver;
  readonly notifyActionCompleted: GraphActionCompletionObserver;
  readonly notifyResultValidityChanged: GraphResultValidityObserver;
  readonly notifyLiveDemandChanged: (
    nodeId: NodeId,
    liveDemand: NodeLiveDemandSnapshot
  ) => Effect.Effect<void>;
  readonly notifyLiveFailures: GraphLiveFailureObserver;
  readonly notifyCleanupFailures: GraphCleanupFailureObserver;
  readonly reportResultObserved: (
    nodeId: NodeId,
    scope: unknown,
    observed: boolean,
    lease: ObservedResultLease
  ) => Promise<ObservedResultLease>;
  readonly cellActors?: {
    readonly getExistingActor: (nodeId: NodeId) => Effect.Effect<GraphCellActor | undefined>;
    readonly deleteActor: (
      nodeId: NodeId,
      actor?: GraphCellActor | undefined
    ) => Effect.Effect<void>;
  };
}

export interface GraphNodeCellView {
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly kind: string;
  readonly key: NodeSnapshot["key"];
  readonly label: string;
  readonly descriptor: NodeDescriptor;
  readonly resultValidityPolicy: NormalizedResultValidityPolicy;
  readonly dependencies: Readonly<Record<string, NodeId>>;
  readonly state: GraphCellStateReader<GraphNodeState>;
}

export interface GraphNodeCell extends GraphNodeCellView {
  readonly request: NodeRequest;
  readonly originalRequest: NodeRequest;
  readonly state: GraphCellState<GraphNodeState>;
  readonly notifyChanged: GraphNodeChangeObserver;
  readonly notifyOperationStarted: GraphOperationStartObserver;
  readonly notifyActionCompleted: GraphActionCompletionObserver;
  readonly notifyResultValidityChanged: GraphResultValidityObserver;
}

export interface GraphNodeState {
  readonly nextOperationId: number;
  readonly nextAttemptId: number;
  readonly nextLiveGeneration: number;
  readonly phase: CellPhase;
}
