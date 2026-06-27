import { Context, type Effect } from "effect";
import type { RuntimeSignalAccess } from "../../signals";
import type { NodeId } from "./ids";
import type {
  AcquireNodeLiveLeaseRequest,
  NodeLiveLeaseResult,
  ReleaseNodeLiveLeaseRequest,
} from "./liveness";
import type {
  ActionRequest,
  ActionResult,
  EvictResult,
  EvictSubgraphRequest,
  GraphNodeCleanupResult,
  NodeRequest,
  RefreshRequest,
  RefreshResult,
  RefreshSubmission,
  SpecOverride,
  UnsafeUpdateNodeRequest,
  UnsafeUpdateNodeResult,
  UpdateNodeArgsRequest,
  UpdateNodeArgsResult,
} from "./operations";
import type { NodeRead, NodeSnapshotLookup, ProjectionContext, SystemSnapshot } from "./reads";
import type {
  GraphActionCompletionObserver,
  GraphCleanupFailureObserver,
  GraphLiveDemandObserver,
  GraphLiveFailureObserver,
  GraphNodeChangeObserver,
  GraphObserverFailureObserver,
  GraphOperationStartObserver,
  GraphResultValidityObserver,
  GraphSubscription,
} from "./subscriptions";

export type DriverOperationTimeoutMs = number;

export interface DriverOperationTimeouts {
  readonly acquire: DriverOperationTimeoutMs;
  readonly refresh: DriverOperationTimeoutMs;
  readonly action: DriverOperationTimeoutMs;
  readonly release: DriverOperationTimeoutMs;
  readonly live: DriverOperationTimeoutMs;
}

export type DriverOperationTimeoutOptions = Partial<DriverOperationTimeouts>;

export interface GraphSystemOptions {
  readonly runtimeId: string;
  readonly specOverrides?: ReadonlyArray<SpecOverride> | undefined;
  readonly driverTimeouts?: DriverOperationTimeoutOptions | undefined;
  readonly signals?: RuntimeSignalAccess | undefined;
}

export interface GraphInput {
  readonly _tag: string;
}

export interface GraphSystemService {
  readonly start: () => Effect.Effect<void>;
  readonly stop: () => Effect.Effect<ReadonlyArray<GraphNodeCleanupResult>>;
  readonly resolveNodeIdSync: (request: NodeRequest) => NodeId;
  readonly ensureNode: (request: NodeRequest) => Effect.Effect<NodeRead>;
  readonly ensureReadyNode: (request: NodeRequest) => Effect.Effect<NodeRead>;
  readonly ensureReadyNodeById: (nodeId: NodeId) => Effect.Effect<NodeRead>;
  readonly runAction: (request: ActionRequest) => Effect.Effect<ActionResult>;
  readonly submitRefreshNode: (request: RefreshRequest) => Effect.Effect<RefreshSubmission>;
  readonly refreshNode: (request: RefreshRequest) => Effect.Effect<RefreshResult>;
  readonly updateNodeArgs: (request: UpdateNodeArgsRequest) => Effect.Effect<UpdateNodeArgsResult>;
  readonly unsafeUpdateNode: (
    request: UnsafeUpdateNodeRequest
  ) => Effect.Effect<UnsafeUpdateNodeResult>;
  readonly releaseNode: (nodeId: NodeId, reason?: string | undefined) => Effect.Effect<void>;
  readonly evictSubgraph: (request: EvictSubgraphRequest) => Effect.Effect<EvictResult>;
  readonly acquireNodeLiveLease: (
    request: AcquireNodeLiveLeaseRequest
  ) => Effect.Effect<NodeLiveLeaseResult>;
  readonly releaseNodeLiveLease: (
    request: ReleaseNodeLiveLeaseRequest
  ) => Effect.Effect<NodeLiveLeaseResult>;
  readonly readNodeSnapshotSync: (nodeId: NodeId, context: ProjectionContext) => NodeSnapshotLookup;
  readonly readNodeSnapshot: (
    nodeId: NodeId,
    context?: ProjectionContext | undefined
  ) => Effect.Effect<NodeSnapshotLookup>;
  readonly observeNodeChanges: (
    observer: GraphNodeChangeObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeResultValidityChanges: (
    observer: GraphResultValidityObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeLiveDemandChanges: (
    observer: GraphLiveDemandObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeLiveFailures: (
    observer: GraphLiveFailureObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeCleanupFailures: (
    observer: GraphCleanupFailureObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeOperationStarts: (
    observer: GraphOperationStartObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeActionCompletions: (
    observer: GraphActionCompletionObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly observeObserverFailures: (
    observer: GraphObserverFailureObserver
  ) => Effect.Effect<GraphSubscription>;
  readonly handleInput: (input: GraphInput) => Effect.Effect<void>;
  readonly snapshot: (context?: ProjectionContext | undefined) => Effect.Effect<SystemSnapshot>;
}

export class GraphSystem extends Context.Service<GraphSystem, GraphSystemService>()(
  "GraphSystem"
) {}
