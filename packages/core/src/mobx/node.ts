import { makeAutoObservable, observable, runInAction } from "mobx";
import { idleOperation } from "../graph/operations/nodeOperation";
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
import type { DependenciesRecord, FrondNode, ResolvedDeps } from "../node";
import type { RuntimeNodeHandle, RuntimeNodeSnapshot, RuntimeSubscription } from "../runtime";
import { FrondMobXProjectionError } from "./errors";
import { mobxRuntimeMetadata } from "./metadata";
import type { MobXNode, MobXNodeOptions, MobXNodeRuntime, MobXNodeSpec } from "./types";

const unwiredStatus: NodeStatus = { _tag: "Unwired" };

/**
 * Creates a MobX projection for one Frond node identity.
 *
 * The projection mirrors runtime state for non-React consumers. It does not own
 * readiness, liveness truth, or ready-node construction.
 */
export function createNode<TArgs, TDeps extends DependenciesRecord, TResult, TNode extends object>(
  runtime: MobXNodeRuntime,
  spec: MobXNodeSpec<TArgs, TDeps, TResult, TNode>,
  args: TArgs,
  options: MobXNodeOptions = {}
): MobXNode<TArgs, TDeps, TResult, TNode> {
  return new RuntimeMobXNode<TArgs, TDeps, TResult, TNode>(runtime, spec, args, options);
}

class RuntimeMobXNode<TArgs, TDeps extends DependenciesRecord, TResult, TNode extends object>
  implements MobXNode<TArgs, TDeps, TResult, TNode>
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

  private readonly subscription: RuntimeSubscription | undefined;

  constructor(
    runtime: MobXNodeRuntime,
    spec: MobXNodeSpec<TArgs, TDeps, TResult, TNode>,
    args: TArgs,
    options: MobXNodeOptions
  ) {
    this.runtime = runtime;
    this.handle = runtime.client.node<TArgs, TResult>(spec, args);
    this.nodeId = this.handle.nodeId;
    this.subscription =
      (options.observeRuntimeEvents ?? true)
        ? runtime.observe((record) => {
            if (record.nodeIds.includes(this.nodeId)) {
              void this.sync();
            }
          })
        : undefined;

    makeAutoObservable<
      RuntimeMobXNode<TArgs, TDeps, TResult, TNode>,
      "runtime" | "subscription" | "currentNode"
    >(this, {
      handle: false,
      currentNode: observable.ref,
      runtime: false,
      subscription: false,
    });

    if (options.autoSync ?? true) {
      void this.sync();
    }
  }

  get args(): TArgs {
    return this.handle.args;
  }

  get busy(): boolean {
    return this.operation._tag === "Running";
  }

  async ensure(): Promise<void> {
    const ensure = this.handle.ensure(mobxRuntimeMetadata.readiness());

    await this.sync();
    await ensure;
    await this.sync();
  }

  async ensureReady(): Promise<void> {
    const ensureReady = this.handle.ensureReady(mobxRuntimeMetadata.readiness());

    await this.sync();
    await ensureReady;
    await this.sync();
  }

  async runAction(action: string, input?: unknown): Promise<ActionResult> {
    const result = await this.handle.runAction(action, input, mobxRuntimeMetadata.action());

    await this.sync();
    return result;
  }

  async refresh(): Promise<RefreshResult> {
    const result = await this.handle.refresh(mobxRuntimeMetadata.refresh());

    await this.sync();
    return result;
  }

  async releaseResources(reason?: string | undefined): Promise<void> {
    await this.handle.releaseResources(reason, mobxRuntimeMetadata.release());
    await this.sync();
  }

  async evict(mode?: EvictMode | undefined, reason?: string | undefined): Promise<EvictResult> {
    const result = await this.handle.evict(mode, reason, mobxRuntimeMetadata.eviction());

    await this.sync();
    return result;
  }

  async sync(): Promise<void> {
    const lookup = await this.runtime.readNodeSnapshot(this.nodeId);
    const snapshot =
      lookup._tag === "Found" ? (lookup.snapshot as RuntimeNodeSnapshot<TResult>) : undefined;
    const snapshotNode = currentNodeFromSnapshot<TArgs, TDeps, TResult, TNode>(snapshot);

    runInAction(() => {
      this.currentNode = snapshotNode;
      this.snapshot = snapshot;
      this.status = snapshot?.status ?? unwiredStatus;
      this.operation = snapshot?.operation ?? idleOperation;
      this.operationFailure = snapshot?.operationFailure;
      this.resultValidity = snapshot?.resultValidity;
      this.result =
        snapshot?._tag === "Ready" && snapshot.resultValidity?._tag !== "Expired"
          ? snapshot.result
          : undefined;
      this.failure = snapshot?.failure;
    });
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
    this.subscription?.unsubscribe();
  }
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
