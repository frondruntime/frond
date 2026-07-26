import type { Effect } from "effect";
import type {
  ActionContracts,
  ActionInputArgs,
  ActionOutput,
  DriverMode,
} from "../../driver/types";
import type { GraphFailure } from "../../graph/types/failures";
import type {
  NodeLiveDemandSnapshot,
  NodeLiveLeaseId,
  NodeLiveSource,
} from "../../graph/types/liveness";
import type {
  ActionResult,
  EvictResult,
  EvictSubgraphRequest,
  NodeOperation,
  NodeRequest,
  RefreshResult,
  UpdateNodeArgsResult,
} from "../../graph/types/operations";
import type { NodeRead } from "../../graph/types/reads";
import type {
  NodeSpecActions,
  NodeSpecArgs,
  NodeSpecInstance,
  NodeSpecLike,
  NodeSpecMode,
  NodeSpecResult,
} from "../../node/types";
import type {
  RuntimeSignal,
  RuntimeSignalSubscriber,
  RuntimeSignalSubscription,
} from "../../signals";
import type { RuntimeWorkMetadata } from "../work";
import type { RuntimeCommand, RuntimeControl, RuntimeInput, RuntimeQuery } from "./commands";
import type { RuntimeError, RuntimeStatus } from "./ids";
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
  readonly getSnapshot: () => Promise<RuntimeSnapshot>;
  readonly observe: (observer: RuntimeObserver) => RuntimeSubscription;
  /**
   * Instantaneous projection of the nodes whose current operation is `Running`,
   * derived from `getSnapshotSync().graph.nodes[].operation` (no new graph
   * state). Like `getSnapshotSync`, it answers on a not-yet-started or stopped
   * runtime (empty graph projects an empty list).
   *
   * This is an observability/barrier-building read, NOT an await-quiescence
   * primitive: operations may start or settle between the read and any code
   * acting on it, so polling it is not a robust barrier. A real
   * await-quiescence surface is deliberately deferred — drain admission policy
   * is a 0.3.0 design question.
   */
  readonly pendingOperations: () => ReadonlyArray<RuntimePendingOperation>;
  /**
   * `pendingOperations().length === 0` — the same instantaneous read, with the
   * same non-barrier caveat.
   */
  readonly isQuiescent: () => boolean;
}

/**
 * One node's in-flight operation as projected by `runtime.pendingOperations()`.
 */
export interface RuntimePendingOperation {
  readonly nodeId: NodeRead["nodeId"];
  readonly tag: string;
  readonly operation: Extract<NodeOperation, { readonly _tag: "Running" }>;
}

/**
 * Typed convenience client for node handles.
 *
 * Use handles for product operations. Reserve `__unsafe` for devtools and test
 * surfaces that intentionally bypass normal node requests.
 */
export interface RuntimeClient {
  readonly node: <TSpec extends NodeSpecLike>(
    spec: TSpec,
    args: NodeSpecArgs<TSpec>
  ) => RuntimeNodeHandle<
    NodeSpecArgs<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>,
    NodeSpecMode<TSpec>,
    RuntimeHandleNode<TSpec>
  >;
  readonly __unsafe: RuntimeClientUnsafe;
}

/**
 * The ready author-node instance type a typed handle exposes on `Ready` reads.
 *
 * `NodeSpecInstance` recovers the nominal class instance. For opaque
 * `NodeSpecLike` carriers whose instance type is not statically recoverable,
 * `NodeSpecInstance` collapses to `any` (the lib `Function.prototype` is
 * `any`), so the `0 extends 1 & T` guard detects that collapse and degrades
 * the surface to `object` instead of `any`; the intersection with `object`
 * keeps every other instance type within the read surface's `TNode extends
 * object` constraint.
 */
export type RuntimeHandleNode<TSpec extends NodeSpecLike> = 0 extends 1 & NodeSpecInstance<TSpec>
  ? object
  : NodeSpecInstance<TSpec> & object;

/**
 * A node handle's typed, mode-native action surface.
 *
 * Each action follows the node's authored driver mode: an effect-driver node's
 * actions return an `Effect`, an async-driver node's return a `Promise`. Both
 * resolve to the `ActionResult` tagged union (Success/Failure) typed to the
 * action's output — unlike the node facade's actions, the handle does not lift a
 * Failure into the error channel; inspect `result._tag`. Cross the boundary with
 * `unwrapEffect` / `wrapPromise`.
 */
export type HandleActions<TActions extends ActionContracts, TMode extends DriverMode> = {
  readonly [TName in keyof TActions & string]: TMode extends "effect"
    ? (
        ...input: ActionInputArgs<TActions[TName]>
      ) => Effect.Effect<ActionResult<ActionOutput<TActions[TName]>>, RuntimeError>
    : (
        ...input: ActionInputArgs<TActions[TName]>
      ) => Promise<ActionResult<ActionOutput<TActions[TName]>>>;
};

/**
 * Stable handle for one node identity.
 *
 * The handle can schedule readiness, actions, refresh, release, eviction, and
 * explicit live leases. It is not a ready author node; call `read`/`boot` or a
 * React/MobX adapter to project current state.
 *
 * `TNode` is the ready author-node instance type exposed by `read()`/`boot()`
 * `Ready` arms and by `snapshot()`. Handles created through
 * `client.node(Spec, args)` carry `NodeSpecInstance<Spec>`; the `object`
 * default remains for loosely-typed adapter handles.
 */
export interface RuntimeNodeHandle<
  TArgs,
  TResult,
  TActions extends ActionContracts = Record<string, never>,
  TMode extends DriverMode = "async",
  TNode extends object = object,
> {
  readonly nodeId: NodeRead["nodeId"];
  readonly args: TArgs;
  readonly read: () => RuntimeNodeRead<TResult, TNode>;
  // Monotonic revision of this node's committed state. Stable across calls when
  // nothing changed, so it is the `getSnapshot` for a `useSyncExternalStore`
  // integration outside the React hooks, in place of hashing `read()` by hand.
  readonly readVersion: () => number;
  readonly boot: (metadata?: RuntimeWorkMetadata | undefined) => RuntimeNodeRead<TResult, TNode>;
  readonly subscribe: (listener: () => void) => () => void;
  readonly ensure: (metadata?: RuntimeWorkMetadata | undefined) => Promise<NodeRead>;
  readonly ensureReady: (metadata?: RuntimeWorkMetadata | undefined) => Promise<NodeRead>;
  // Synchronous ready-or-throw projection of `read()`: Ready returns the typed
  // node instance; Error rethrows the read's underlying error; any other phase
  // throws `FrondNodeNotReady` carrying the observed readiness. Never schedules
  // graph work.
  readonly readReady: () => TNode;
  // One awaited readiness attempt (`ensureReady`) followed by the same
  // `readReady` projection, for call sites that want the typed node or a
  // thrown error in a single await.
  readonly ensureReadyNode: (metadata?: RuntimeWorkMetadata | undefined) => Promise<TNode>;
  // Typed, mode-native action surface: `handle.actions.<name>(input)`.
  readonly actions: HandleActions<TActions, TMode>;
  // Untyped Effect primitive for dynamic action names and metadata-bearing calls
  // (adapters, devtools). Always Effect-native; `unwrapEffect` for a Promise.
  readonly action: (
    action: string,
    input?: unknown,
    metadata?: RuntimeWorkMetadata | undefined
  ) => Effect.Effect<ActionResult, RuntimeError>;
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
  ) => Promise<RuntimeNodeLiveLeaseResult>;
  readonly snapshot: () => Promise<RuntimeNodeSnapshotLookup<TResult, TNode>>;
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

/**
 * Held exposes a public lease only when the graph recorded a releasable lease.
 * Failure exposes typed acquisition failures when no lease was recorded.
 */
export type RuntimeNodeLiveLeaseResult =
  | {
      readonly _tag: "Held";
      readonly nodeId: NodeRead["nodeId"];
      readonly lease: RuntimeNodeLiveLease;
      readonly liveDemand: NodeLiveDemandSnapshot;
    }
  | {
      readonly _tag: "Failure";
      readonly nodeId: NodeRead["nodeId"];
      readonly failures: ReadonlyArray<GraphFailure>;
      readonly liveDemand: NodeLiveDemandSnapshot;
    }
  | {
      readonly _tag: "NodeMissing";
      readonly nodeId: NodeRead["nodeId"];
      readonly liveDemand: NodeLiveDemandSnapshot;
    };

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
