import type { Effect } from "effect";
import type { NodeDescriptor } from "../planning/descriptor";
import type { GraphJobQueue } from "../queue/jobQueue";
import type { CoreCall } from "../queue/reply";
import type {
  DriverOperationTimeouts,
  EdgeSnapshot,
  GraphActionCompletionObserver,
  GraphCleanupFailureObserver,
  GraphLiveFailureObserver,
  GraphNodeChangeObserver,
  GraphObserverFailureObserver,
  GraphOperationStartObserver,
  GraphReadinessFailureObserver,
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
import type { CellPhase } from "./cellPhase";
import type { GraphCellQueue } from "./cellQueue";
import type { GraphCellState, GraphCellStateReader } from "./cellState";

export interface GraphPlanState {
  readonly development: boolean;
  readonly syncClock: { readonly now: () => number };
  readonly jobs: GraphJobQueue;
  readonly enqueue: (effect: Effect.Effect<void>) => void;
  readonly nodes: Map<NodeId, GraphNodeCell>;
  readonly edges: Map<string, EdgeSnapshot>;
  // The highest committed revision of any evicted cell. A cell created after
  // an eviction seeds its revision past this, so `readVersion` stays
  // monotonic across evict + recreate for the same node identity instead of
  // ABA-ing back to 0. One number for the graph, not one entry per evicted
  // node id, which would grow with every id evicted and never recreated.
  evictedRevisionFloor: number;
  // Bumped whenever eviction deletes a cell and its edges, and whenever a cell
  // enters Invalid or a release takes one out of it. A cell wired at an older
  // generation may have lost a dependency (directly or further down) to an
  // interrupted eviction, or have a closure member that failed planning, so it
  // takes the full re-plan once to heal.
  wiringGeneration: number;
  readonly specByTag: Map<string, unknown>;
  readonly specOverrides: ReadonlyMap<unknown, unknown>;
  readonly driverTimeouts: DriverOperationTimeouts;
  readonly nextLiveLeaseId: () => NodeLiveLeaseId;
  readonly executeNodeActionDirect: CoreCall<GraphPlanState["executeNodeAction"]>;
  readonly executeNodeAction: (
    nodeId: NodeId,
    action: string,
    input: unknown
  ) => Effect.Effect<ActionResult>;
  readonly notifyNodeChanged: GraphNodeChangeObserver;
  readonly notifyOperationStarted: GraphOperationStartObserver;
  readonly notifyActionCompleted: GraphActionCompletionObserver;
  readonly notifyResultValidityChanged: GraphResultValidityObserver;
  readonly notifyReadinessFailed: GraphReadinessFailureObserver;
  readonly reportObserverFailure: GraphObserverFailureObserver;
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
  readonly cellQueues: {
    readonly getExistingQueue: (nodeId: NodeId) => GraphCellQueue | undefined;
    readonly deleteQueue: (nodeId: NodeId, queue?: GraphCellQueue | undefined) => void;
  };
}

export interface GraphNodeCellView {
  readonly development: boolean;
  readonly syncClock: { readonly now: () => number };
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
  readonly jobs: GraphJobQueue;
  readonly request: NodeRequest;
  readonly originalRequest: NodeRequest;
  readonly state: GraphCellState<GraphNodeState>;
  readonly notifyChanged: GraphNodeChangeObserver;
  readonly notifyOperationStarted: GraphOperationStartObserver;
  readonly notifyActionCompleted: GraphActionCompletionObserver;
  readonly notifyResultValidityChanged: GraphResultValidityObserver;
  readonly notifyReadinessFailed: GraphReadinessFailureObserver;
  readonly reportObserverFailure: GraphObserverFailureObserver;
  // The `GraphPlanState.wiringGeneration` at which this cell and its whole
  // dependency closure were last planned, recorded, and not Invalid; 0 until
  // the first such wiring.
  wiredGeneration: number;
}

export interface GraphNodeState {
  nextOperationId: number;
  nextAttemptId: number;
  nextLiveGeneration: number;
  phase: CellPhase;
}
