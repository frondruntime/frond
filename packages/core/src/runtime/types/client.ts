import type { NodeLiveLeaseId, NodeLiveSource } from "../../graph/types/liveness";
import type {
  ActionResult,
  EvictResult,
  EvictSubgraphRequest,
  NodeRequest,
  RefreshResult,
  UpdateNodeArgsResult,
} from "../../graph/types/operations";
import type { NodeRead } from "../../graph/types/reads";
import type {
  RuntimeSignal,
  RuntimeSignalSubscriber,
  RuntimeSignalSubscription,
} from "../../signals";
import type { RuntimeSnapshotPurpose, RuntimeWorkMetadata } from "../work";
import type { RuntimeCommand, RuntimeControl, RuntimeInput, RuntimeQuery } from "./commands";
import type { RuntimeStatus } from "./ids";
import type { RuntimeQueryResult } from "./queries";
import type { RawRuntimeNodeRead, RuntimeNodeRead, RuntimeNodeSnapshotLookup } from "./reads";
import type { RuntimeObserver, RuntimeSubscription } from "./service";
import type { RuntimeSnapshot } from "./snapshots";
import type { RuntimeSubmission } from "./submissions";

/**
 * Public app-facing runtime facade.
 *
 * Promise methods are consumer bridges over an Effect-native host. Sync methods
 * are inspection/projection reads only and must not schedule graph work.
 */
export interface Runtime {
  readonly resolveNodeIdSync: (request: NodeRequest) => NodeRead["nodeId"];
  readonly getStatusSync: () => RuntimeStatus;
  readonly readNodeSnapshotSync: (nodeId: NodeRead["nodeId"]) => RuntimeNodeSnapshotLookup<unknown>;
  readonly readNodeSnapshot: (
    nodeId: NodeRead["nodeId"]
  ) => Promise<RuntimeNodeSnapshotLookup<unknown>>;
  readonly client: RuntimeClient;
  readonly submit: (command: RuntimeCommand) => Promise<RuntimeSubmission>;
  readonly control: (control: RuntimeControl) => Promise<void>;
  readonly query: (query: RuntimeQuery) => Promise<RuntimeQueryResult>;
  readonly ingest: (input: RuntimeInput) => Promise<void>;
  readonly publish: (
    signal: RuntimeSignal,
    metadata?: RuntimeWorkMetadata | undefined
  ) => Promise<void>;
  readonly subscribeSignals: (
    subscriber: RuntimeSignalSubscriber
  ) => Promise<RuntimeSignalSubscription>;
  readonly getSnapshotSync: () => RuntimeSnapshot;
  readonly getSnapshotSyncFor: (purpose: RuntimeSnapshotPurpose) => RuntimeSnapshot;
  readonly getSnapshot: () => Promise<RuntimeSnapshot>;
  readonly getSnapshotFor: (purpose: RuntimeSnapshotPurpose) => Promise<RuntimeSnapshot>;
  readonly observe: (observer: RuntimeObserver) => RuntimeSubscription;
}

/**
 * Typed convenience client for node handles.
 *
 * Use handles for product operations. Reserve `__unsafe` for devtools and test
 * surfaces that intentionally bypass normal node requests.
 */
export interface RuntimeClient {
  readonly node: <TArgs, TResult>(spec: unknown, args: TArgs) => RuntimeNodeHandle<TArgs, TResult>;
  readonly __unsafe: RuntimeClientUnsafe;
}

/**
 * Stable handle for one node identity.
 *
 * The handle can schedule readiness, actions, refresh, release, eviction, and
 * explicit live leases. It is not a ready author node; call `read`/`boot` or a
 * React/MobX adapter to project current state.
 */
export interface RuntimeNodeHandle<TArgs, TResult> {
  readonly nodeId: NodeRead["nodeId"];
  readonly args: TArgs;
  readonly read: () => RuntimeNodeRead<TResult>;
  readonly boot: (metadata?: RuntimeWorkMetadata | undefined) => RuntimeNodeRead<TResult>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly ensure: (metadata?: RuntimeWorkMetadata | undefined) => Promise<NodeRead>;
  readonly ensureReady: (metadata?: RuntimeWorkMetadata | undefined) => Promise<NodeRead>;
  readonly runAction: (
    action: string,
    input?: unknown,
    metadata?: RuntimeWorkMetadata | undefined
  ) => Promise<ActionResult>;
  readonly refresh: (metadata?: RuntimeWorkMetadata | undefined) => Promise<RefreshResult>;
  readonly updateArgs: (
    args: TArgs,
    metadata?: RuntimeWorkMetadata | undefined
  ) => Promise<UpdateNodeArgsResult>;
  readonly releaseResources: (
    reason?: string | undefined,
    metadata?: RuntimeWorkMetadata | undefined
  ) => Promise<void>;
  readonly evict: (
    mode?: EvictSubgraphRequest["mode"] | undefined,
    reason?: string | undefined,
    metadata?: RuntimeWorkMetadata | undefined
  ) => Promise<EvictResult>;
  readonly acquireLiveLease: (
    source: NodeLiveSource,
    scope: unknown,
    metadata?: RuntimeWorkMetadata | undefined
  ) => Promise<RuntimeNodeLiveLease>;
  readonly snapshot: () => Promise<RuntimeNodeSnapshotLookup<TResult>>;
}

/**
 * Explicit liveness lease acquired outside MobX field observation.
 *
 * Dispose the lease to remove this demand source. Driver live resources stop
 * only when the combined live demand becomes inactive or changes.
 */
export interface RuntimeNodeLiveLease {
  readonly nodeId: NodeRead["nodeId"];
  readonly leaseId: NodeLiveLeaseId;
  readonly source: NodeLiveSource;
  readonly scope: unknown;
  readonly dispose: () => Promise<void>;
}

export type UnsafeNodeRead = RawRuntimeNodeRead<unknown>;

// `ensureReady`, `refresh`, and `updateNode` all answer the same three-arm
// question: did we schedule it, was the node unwired, or was it invalid? Share
// one type instead of two byte-for-byte identical aliases.
export type UnsafeScheduleResult =
  | {
      readonly _tag: "Scheduled";
      readonly nodeId: NodeRead["nodeId"];
    }
  | {
      readonly _tag: "Unwired";
      readonly nodeId: NodeRead["nodeId"];
    }
  | {
      readonly _tag: "Invalid";
      readonly nodeId: NodeRead["nodeId"];
      readonly error: unknown;
    };

export interface RuntimeClientUnsafe {
  readonly readNode: (nodeId: NodeRead["nodeId"]) => UnsafeNodeRead;
  readonly ensureReady: (nodeId: NodeRead["nodeId"]) => UnsafeScheduleResult;
  readonly refresh: (nodeId: NodeRead["nodeId"]) => UnsafeScheduleResult;
  readonly updateNode: (
    nodeId: NodeRead["nodeId"],
    recipe: (node: object) => void,
    options?: { readonly label?: string | undefined } | undefined
  ) => UnsafeScheduleResult;
}
