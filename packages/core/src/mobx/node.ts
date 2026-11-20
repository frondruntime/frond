import { makeAutoObservable, observable, runInAction } from "mobx";
import { idleOperation } from "../graph/operations/nodeOperation";
import { runInMicrotask } from "../graph/queue/microtask";
import type { NodeId } from "../graph/types/ids";
import type {
  ActionResult,
  EvictMode,
  EvictResult,
  NodeOperation,
  NodeOperationFailure,
  RefreshResult,
} from "../graph/types/operations";
import type { NodeStatus } from "../graph/types/reads";
import type { ResultValidity } from "../graph/types/resultValidity";
import { unwrapEffect } from "../interop";
import type { KeyInput } from "../keys";
import type { DependenciesRecord, FrondNode, NodeSpecLike, ResolvedDeps } from "../node";
import type {
  Runtime,
  RuntimeNodeHandle,
  RuntimeNodeSnapshot,
  RuntimeSubscription,
} from "../runtime";
import { type RuntimeCore, runtimeCore } from "../runtime/core";
import { corePromise } from "../runtime/promiseFacade";
import type {
  RuntimeCommand,
  RuntimeNodeSnapshotLookup,
  RuntimeSubmission,
} from "../runtime/types";
import { FrondMobXProjectionError } from "./errors";
import { mobxRuntimeMetadata } from "./metadata";
import type { MobXNode, MobXNodeOptions, MobXNodeRuntime, MobXNodeSpec } from "./types";

const unwiredStatus: NodeStatus = { _tag: "Unwired" };

type DirectMobXRuntime = MobXNodeRuntime & Pick<Runtime, "readNodeSnapshotSync">;

/**
 * Creates a MobX projection for one Frond node identity.
 *
 * The projection mirrors runtime state for non-React consumers. It does not own
 * readiness, liveness truth, or ready-node construction.
 */
export function createNode<
  TArgs extends KeyInput,
  TDeps extends DependenciesRecord,
  TResult,
  TNode extends object,
>(
  runtime: MobXNodeRuntime,
  spec: MobXNodeSpec<TArgs, TDeps, TResult, TNode>,
  args: TArgs,
  options: MobXNodeOptions = {}
): MobXNode<TArgs, TDeps, TResult, TNode> {
  return new RuntimeMobXNode<TArgs, TDeps, TResult, TNode>(runtime, spec, args, options);
}

class RuntimeMobXNode<
  TArgs extends KeyInput,
  TDeps extends DependenciesRecord,
  TResult,
  TNode extends object,
> implements MobXNode<TArgs, TDeps, TResult, TNode>
{
  readonly handle: RuntimeNodeHandle<TArgs, TResult>;

  readonly nodeId: NodeId;

  private currentNode: (TNode & FrondNode<TArgs, ResolvedDeps<TDeps>, TResult>) | undefined;

  status: NodeStatus = unwiredStatus;

  operation: NodeOperation = idleOperation;

  operationFailure: NodeOperationFailure | undefined;

  resultValidity: ResultValidity | undefined;

  result: TResult | undefined;

  failure: unknown | undefined;

  snapshot: RuntimeNodeSnapshot<TResult> | undefined;

  private readonly runtime: MobXNodeRuntime;
  // A runtime from `createRuntime` carries its core; a structural
  // `MobXNodeRuntime` does not and goes through its handle.
  private readonly core: RuntimeCore | undefined;
  private readonly spec: unknown;

  private readonly subscription: RuntimeSubscription | undefined;

  private syncScheduled = false;

  private readonly flushSync = (): void => {
    if (!this.syncScheduled) return;
    if (this.core !== undefined) {
      try {
        this.applySnapshot(this.readSnapshotSync());
      } catch (cause) {
        this.reportSyncFailure(cause);
      }
    } else void this.sync().catch(this.reportSyncFailure);
  };

  private readonly reportSyncFailure = (cause: unknown): void => {
    void this.runtime.recordMobXProjectionFailure?.(
      this.nodeId,
      new FrondMobXProjectionError({
        nodeId: this.nodeId,
        message: `Frond MobX projection ${this.nodeId} failed to sync.`,
        cause,
      })
    );
  };

  constructor(
    runtime: MobXNodeRuntime,
    spec: MobXNodeSpec<TArgs, TDeps, TResult, TNode>,
    args: TArgs,
    options: MobXNodeOptions
  ) {
    this.runtime = runtime;
    this.core = runtimeCore(runtime);
    this.spec = spec;
    // The MobX node is parametrized by args/result, not the spec, and does not
    // use the handle's typed action surface (it exposes its own `runAction`), so
    // the handle is created through the loose client entry.
    this.handle = (
      runtime.client.node as unknown as (
        spec: NodeSpecLike,
        args: TArgs
      ) => RuntimeNodeHandle<TArgs, TResult>
    )(spec as unknown as NodeSpecLike, args);
    this.nodeId = this.handle.nodeId;
    this.subscription =
      (options.observeRuntimeEvents ?? true)
        ? subscribeNode(runtime, this.nodeId, () => this.scheduleSync())
        : undefined;

    makeAutoObservable<
      RuntimeMobXNode<TArgs, TDeps, TResult, TNode>,
      | "runtime"
      | "core"
      | "spec"
      | "subscription"
      | "currentNode"
      | "syncScheduled"
      | "flushSync"
      | "reportSyncFailure"
      | "scheduleSync"
      | "applySnapshot"
      | "submitDirect"
      | "readSnapshotSync"
    >(this, {
      handle: false,
      // Every projected field is a ref: a sync stores the runtime's value as is,
      // with no deep copy, and a field whose value is unchanged notifies nobody.
      currentNode: observable.ref,
      status: observable.ref,
      operation: observable.ref,
      operationFailure: observable.ref,
      resultValidity: observable.ref,
      result: observable.ref,
      failure: observable.ref,
      snapshot: observable.ref,
      runtime: false,
      core: false,
      spec: false,
      subscription: false,
      syncScheduled: false,
      flushSync: false,
      reportSyncFailure: false,
      scheduleSync: false,
      sync: false,
      applySnapshot: false,
      submitDirect: false,
      readSnapshotSync: false,
    });

    if (options.autoSync ?? true) {
      this.scheduleSync();
    }
  }

  get args(): TArgs {
    return this.handle.args;
  }

  get busy(): boolean {
    return this.operation._tag === "Running";
  }

  ensure(): Promise<void> {
    const core = this.core;
    if (core !== undefined)
      return this.submitDirect(
        core,
        {
          _tag: "GraphEnsureNode",
          request: { spec: this.spec, args: this.handle.args },
          metadata: mobxRuntimeMetadata.readiness(),
        },
        "GraphNodeEnsured",
        voidSubmission
      );
    return this.ensureFallback(false);
  }

  ensureReady(): Promise<void> {
    const core = this.core;
    if (core !== undefined)
      return this.submitDirect(
        core,
        {
          _tag: "GraphEnsureReadyNode",
          request: { spec: this.spec, args: this.handle.args },
          metadata: mobxRuntimeMetadata.readiness(),
        },
        "GraphNodeReadyEnsured",
        voidSubmission
      );
    return this.ensureFallback(true);
  }

  private async ensureFallback(ready: boolean): Promise<void> {
    const pending = ready
      ? this.handle.ensureReady(mobxRuntimeMetadata.readiness())
      : this.handle.ensure(mobxRuntimeMetadata.readiness());
    try {
      await this.sync();
      await pending;
    } catch (cause) {
      await pending.catch(() => undefined);
      throw cause;
    }
    await this.sync();
  }

  runAction(action: string, input?: unknown): Promise<ActionResult> {
    const core = this.core;
    if (core === undefined)
      return unwrapEffect(this.handle.action(action, input, mobxRuntimeMetadata.action())).then(
        async (result) => {
          await this.sync();
          return result;
        }
      );
    return this.submitDirect(
      core,
      {
        _tag: "GraphRunAction",
        request: {
          target: { _tag: "NodeRequest", request: { spec: this.spec, args: this.handle.args } },
          action,
          input,
        },
        metadata: mobxRuntimeMetadata.action(),
      },
      "GraphActionCompleted",
      actionSubmission
    );
  }

  refresh(): Promise<RefreshResult> {
    const core = this.core;
    if (core !== undefined)
      return this.submitDirect(
        core,
        {
          _tag: "GraphRefreshNode",
          request: {
            target: { _tag: "NodeRequest", request: { spec: this.spec, args: this.handle.args } },
          },
          metadata: mobxRuntimeMetadata.refresh(),
        },
        "GraphRefreshCompleted",
        refreshSubmission
      );
    return this.handle.refresh(mobxRuntimeMetadata.refresh()).then(async (result) => {
      await this.sync();
      return result;
    });
  }

  releaseResources(reason?: string): Promise<void> {
    const core = this.core;
    if (core !== undefined)
      return this.submitDirect(
        core,
        {
          _tag: "GraphReleaseNode",
          nodeId: this.nodeId,
          reason,
          metadata: mobxRuntimeMetadata.release(),
        },
        "GraphNodeReleased",
        voidSubmission
      );
    return this.handle
      .releaseResources(reason, mobxRuntimeMetadata.release())
      .then(() => this.sync());
  }

  evict(mode: EvictMode = "selfAndDependents", reason?: string): Promise<EvictResult> {
    const core = this.core;
    if (core !== undefined)
      return this.submitDirect(
        core,
        {
          _tag: "GraphEvictSubgraph",
          request: { rootNodeIds: [this.nodeId], mode, reason },
          metadata: mobxRuntimeMetadata.eviction(),
        },
        "GraphSubgraphEvicted",
        evictionSubmission
      );
    return this.handle.evict(mode, reason, mobxRuntimeMetadata.eviction()).then(async (result) => {
      await this.sync();
      return result;
    });
  }

  private submitDirect<TTag extends RuntimeSubmission["_tag"], TValue>(
    core: RuntimeCore,
    command: RuntimeCommand,
    expected: TTag,
    extract: (submission: Extract<RuntimeSubmission, { readonly _tag: TTag }>) => TValue
  ): Promise<TValue> {
    return corePromise(
      (resume) => core.submit(command, undefined, resume),
      (submission: RuntimeSubmission) => {
        this.applySnapshot(this.readSnapshotSync());
        if (submission._tag !== expected)
          throw new Error(`Expected runtime submission ${expected}`);
        return extract(submission as Extract<RuntimeSubmission, { readonly _tag: TTag }>);
      }
    );
  }

  private readSnapshotSync(): RuntimeNodeSnapshotLookup<unknown> {
    // Only a runtime bridged by `createRuntime` carries a core, and it reads
    // snapshots synchronously.
    return (this.runtime as DirectMobXRuntime).readNodeSnapshotSync(this.nodeId);
  }

  async sync(): Promise<void> {
    // Explicit syncs consume pending event work and read before yielding on real
    // runtimes. In particular, runAction must publish the commit before returning.
    this.syncScheduled = false;
    const lookup =
      this.core !== undefined
        ? this.readSnapshotSync()
        : await this.runtime.readNodeSnapshot(this.nodeId);
    this.applySnapshot(lookup);
  }

  private applySnapshot(lookup: RuntimeNodeSnapshotLookup<unknown>): void {
    this.syncScheduled = false;
    const snapshot =
      lookup._tag === "Found" ? (lookup.snapshot as RuntimeNodeSnapshot<TResult>) : undefined;
    const snapshotNode = currentNodeFromSnapshot<TArgs, TDeps, TResult, TNode>(snapshot);
    const status = snapshot?.status ?? unwiredStatus;
    const operation = snapshot?.operation ?? idleOperation;
    const result =
      snapshot?._tag === "Ready" && snapshot.resultValidity?._tag !== "Expired"
        ? snapshot.result
        : undefined;

    runInAction(() => {
      if (this.currentNode !== snapshotNode) this.currentNode = snapshotNode;
      if (this.snapshot !== snapshot) this.snapshot = snapshot;
      if (this.status !== status) this.status = status;
      if (this.operation !== operation) this.operation = operation;
      if (this.operationFailure !== snapshot?.operationFailure)
        this.operationFailure = snapshot?.operationFailure;
      if (this.resultValidity !== snapshot?.resultValidity)
        this.resultValidity = snapshot?.resultValidity;
      // Object.is: a commit from 0 to -0 (or NaN to NaN) is what MobX's ref comparer sees.
      if (!Object.is(this.result, result)) this.result = result;
      if (this.failure !== snapshot?.failure) this.failure = snapshot?.failure;
    });
  }

  private scheduleSync(): void {
    if (this.syncScheduled) return;
    this.syncScheduled = true;
    runInMicrotask(this.flushSync);
  }

  get node(): TNode & FrondNode<TArgs, ResolvedDeps<TDeps>, TResult> {
    if (this.currentNode === undefined) {
      throw new FrondMobXProjectionError({
        nodeId: this.nodeId,
        message: `Frond MobX projection ${this.nodeId} does not have a current node.`,
      });
    }

    return this.currentNode;
  }

  dispose(): void {
    this.syncScheduled = false;
    this.subscription?.unsubscribe();
  }
}

interface NodeListeners {
  readonly byNode: Map<NodeId, Set<() => void>>;
  readonly subscription: RuntimeSubscription;
}

const runtimeListeners = new WeakMap<MobXNodeRuntime, NodeListeners>();

function subscribeNode(
  runtime: MobXNodeRuntime,
  nodeId: NodeId,
  listener: () => void
): RuntimeSubscription {
  let listeners = runtimeListeners.get(runtime);
  if (listeners === undefined) {
    const byNode = new Map<NodeId, Set<() => void>>();
    const subscription = runtime.observe((record) => {
      for (const id of record.nodeIds) {
        const callbacks = byNode.get(id);
        if (callbacks !== undefined) {
          for (const callback of callbacks) callback();
        }
      }
    });
    listeners = { byNode, subscription };
    runtimeListeners.set(runtime, listeners);
  }
  let callbacks = listeners.byNode.get(nodeId);
  if (callbacks === undefined) {
    callbacks = new Set();
    listeners.byNode.set(nodeId, callbacks);
  }
  callbacks.add(listener);
  const owned = listeners;
  const nodeCallbacks = callbacks;
  return {
    unsubscribe: () => {
      if (!nodeCallbacks.delete(listener)) return;
      if (nodeCallbacks.size === 0) owned.byNode.delete(nodeId);
      if (owned.byNode.size === 0) {
        owned.subscription.unsubscribe();
        runtimeListeners.delete(runtime);
      }
    },
  };
}

function currentNodeFromSnapshot<
  TArgs,
  TDeps extends DependenciesRecord,
  TResult,
  TNode extends object,
>(
  snapshot: RuntimeNodeSnapshot<TResult> | undefined
): (TNode & FrondNode<TArgs, ResolvedDeps<TDeps>, TResult>) | undefined {
  if (
    snapshot === undefined ||
    snapshot._tag !== "Ready" ||
    snapshot.resultValidity?._tag === "Expired"
  ) {
    return undefined;
  }

  return snapshot.node as TNode & FrondNode<TArgs, ResolvedDeps<TDeps>, TResult>;
}

const voidSubmission = () => undefined;
const actionSubmission = (
  submission: Extract<RuntimeSubmission, { readonly _tag: "GraphActionCompleted" }>
) => submission.result;
const refreshSubmission = (
  submission: Extract<RuntimeSubmission, { readonly _tag: "GraphRefreshCompleted" }>
) => submission.result;
const evictionSubmission = (
  submission: Extract<RuntimeSubmission, { readonly _tag: "GraphSubgraphEvicted" }>
) => submission.result;
