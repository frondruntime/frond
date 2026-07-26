import type { DriverMode } from "../driver/types";
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
import type { KeyInput } from "../keys";
import type { DependenciesRecord, FrondNode, NodeSpec, NodeSpecClass, ResolvedDeps } from "../node";
import type {
  Runtime,
  RuntimeNodeHandle,
  RuntimeNodeSnapshot,
  RuntimeSubscription,
} from "../runtime";

export interface MobXNode<TArgs, TDeps extends DependenciesRecord, TResult, TNode extends object> {
  readonly handle: RuntimeNodeHandle<TArgs, TResult>;
  readonly nodeId: NodeId;
  readonly args: TArgs;
  readonly node: TNode & FrondNode<TArgs, ResolvedDeps<TDeps>, TResult>;
  readonly status: NodeStatus;
  readonly operation: NodeOperation;
  readonly busy: boolean;
  readonly operationFailure: NodeOperationFailure | undefined;
  readonly resultValidity: ResultValidity | undefined;
  readonly result: TResult | undefined;
  readonly failure: unknown | undefined;
  readonly snapshot: RuntimeNodeSnapshot<TResult> | undefined;
  readonly ensure: () => Promise<void>;
  readonly ensureReady: () => Promise<void>;
  readonly runAction: (action: string, input?: unknown) => Promise<ActionResult>;
  readonly refresh: () => Promise<RefreshResult>;
  readonly releaseResources: (reason?: string | undefined) => Promise<void>;
  readonly evict: (
    mode?: EvictMode | undefined,
    reason?: string | undefined
  ) => Promise<EvictResult>;
  readonly sync: () => Promise<void>;
  readonly dispose: () => void;
}

export type MobXNodeSpec<
  TArgs extends KeyInput,
  TDeps extends DependenciesRecord,
  TResult,
  TNode extends object,
> = NodeSpecClass<
  NodeSpec<{
    readonly mode: DriverMode;
    readonly args: TArgs;
    readonly deps: TDeps;
    readonly result: TResult;
  }>,
  TNode
>;

export interface MobXNodeOptions {
  readonly autoSync?: boolean | undefined;
  readonly observeRuntimeEvents?: boolean | undefined;
}

export type MobXNodeRuntime = Pick<Runtime, "client" | "readNodeSnapshot" | "observe"> & {
  readonly recordMobXProjectionFailure?:
    | ((nodeId: NodeId, cause: unknown) => Promise<void>)
    | undefined;
};

export type MobXNodeSubscription = RuntimeSubscription;
