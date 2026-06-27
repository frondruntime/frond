import type * as Frond from "@frondruntime/core";
import type {
  FrondNode,
  NodeSpec,
  NodeSpecArgs,
  NodeSpecDeclaredDeps,
  NodeSpecInstance,
  NodeSpecLike,
  NodeSpecResult,
  ResolvedDeps,
} from "@frondruntime/core";

export type ReactNodeSpec<TArgs, TDeps extends object, TResult, TNode extends object> = NodeSpec<{
  readonly args: TArgs;
  readonly deps: TDeps;
  readonly result: TResult;
  readonly node?: TNode;
}>;

export type ReactNodeInput<TSpec extends NodeSpecLike> = readonly [TSpec, NodeSpecArgs<TSpec>];

export type ReactNodeInputMap = Record<string, readonly [unknown, unknown]>;

export type CheckedReactNodeInputMap<TMap extends Record<string, readonly [unknown, unknown]>> = {
  readonly [TKey in keyof TMap]: TMap[TKey] extends readonly [infer TSpec, unknown]
    ? TSpec extends NodeSpecLike
      ? ReactNodeInput<TSpec>
      : never
    : never;
};

/**
 * Author node instance exposed by React only after readiness succeeds.
 */
export type ReadyReactNode<TSpec extends NodeSpecLike> =
  NodeSpecInstance<TSpec> extends object
    ? NodeSpecInstance<TSpec> &
        FrondNode<
          NodeSpecArgs<TSpec>,
          ResolvedDeps<NodeSpecDeclaredDeps<TSpec>>,
          NodeSpecResult<TSpec>
        >
    : FrondNode<
        NodeSpecArgs<TSpec>,
        ResolvedDeps<NodeSpecDeclaredDeps<TSpec>>,
        NodeSpecResult<TSpec>
      >;

export type UseNodesResult<TMap extends Record<string, readonly [unknown, unknown]>> = {
  readonly [TKey in keyof TMap]: TMap[TKey] extends ReactNodeInput<infer TSpec>
    ? ReadyReactNode<TSpec>
    : never;
};

/**
 * Imperative node controls that do not read product data.
 */
export interface UseNodeControls {
  readonly nodeId: Frond.Graph.NodeId;
  readonly ensureReady: () => Promise<void>;
  readonly refresh: () => Promise<Frond.Graph.RefreshResult>;
  readonly evict: (
    mode?: Frond.Graph.EvictMode | undefined,
    reason?: string | undefined
  ) => Promise<Frond.Graph.EvictResult>;
  readonly releaseResources: (reason?: string | undefined) => Promise<void>;
}

export type UseNodesControls<TMap extends Record<string, readonly [unknown, unknown]>> = {
  readonly [TKey in keyof TMap]: TMap[TKey] extends readonly [infer TSpec, unknown]
    ? TSpec extends NodeSpecLike
      ? UseNodeControls
      : never
    : never;
};

export type UseNodeState<TSpec extends NodeSpecLike> = ReactNodeState<
  NodeSpecArgs<TSpec>,
  NodeSpecDeclaredDeps<TSpec>,
  NodeSpecResult<TSpec>,
  NodeSpecInstance<TSpec> extends object ? NodeSpecInstance<TSpec> : object
>;

/**
 * Ready node plus runtime operation metadata for React status UI.
 */
export interface ReactNodeState<TArgs, TDeps extends object, TResult, TNode extends object> {
  readonly nodeId: Frond.Graph.NodeId;
  readonly node: TNode & FrondNode<TArgs, ResolvedDeps<TDeps>, TResult>;
  readonly operation: Frond.Graph.NodeOperation;
  readonly busy: boolean;
  readonly operationFailure: Frond.Graph.NodeOperationFailure | undefined;
  readonly resultValidity: Frond.Runtime.DisplayableResultValidity;
}

export interface ReactNodeRuntime
  extends Pick<Frond.Runtime.Runtime, "client" | "resolveNodeIdSync"> {}
