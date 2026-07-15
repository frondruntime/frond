import type {
  ActionContract,
  ActionContracts,
  ActionInput,
  ActionInputArgs,
  ActionOutput,
  Driver,
} from "../driver/types";
import type { NodeId as GraphNodeId } from "../graph/types";
import type { KeyInput, KeyValue, Singleton } from "../keys";
import type { NodeBase } from "./runtime";

export const FROND_NODE_SPEC_BRAND: unique symbol = Symbol.for("frond.nodeSpec") as never;
declare const NODE_TAG_BRAND: unique symbol;

export type NodeId = GraphNodeId;

export type NodeTag = string & {
  readonly [NODE_TAG_BRAND]: "NodeTag";
};

export type NodeKind = "node" | "service" | "resource" | "facade";

export namespace Args {
  export type None = Record<string, never>;
  export const none: None = Object.freeze({});
}

/**
 * Type carrier for a Frond node spec.
 *
 * The optional `_shape` field exists only for inference. Runtime identity and
 * execution come from the descriptor created by `nodeSpec`/`serviceSpec`/
 * `resourceSpec`/`facadeSpec`.
 */
export interface NodeSpec<
  TShape extends {
    readonly args?: KeyInput;
    readonly key?: unknown;
    readonly deps?: DependenciesRecord;
    readonly result?: unknown;
    readonly actions?: ActionContracts;
  } = { readonly result: unknown },
> {
  readonly _shape?: TShape | undefined;
}

export type NodeSpecClass<
  TSpec extends NodeSpec<{
    readonly args?: KeyInput;
    readonly key?: unknown;
    readonly deps?: DependenciesRecord;
    readonly result?: unknown;
    readonly actions?: ActionContracts;
  }> = NodeSpec<{ readonly result: unknown }>,
  TNode extends object = NodeBase<TSpec>,
> = (abstract new (
  ...args: ReadonlyArray<never>
) => TNode) & {
  readonly spec: NodeDescriptor<TSpec>;
};

export type NodeSpecLike = (abstract new (
  ...args: ReadonlyArray<never>
) => object) & {
  readonly spec: unknown;
};

export type NodeActions<TActions extends ActionContracts> = {
  readonly [TName in keyof TActions & string]: (
    ...input: ActionInputArgs<TActions[TName]>
  ) => Promise<ActionOutput<TActions[TName]>>;
};

type NodeSpecCarrier<TSpec> = TSpec extends { readonly spec: NodeDescriptor<infer TCarrier> }
  ? TCarrier
  : TSpec;

export type NodeSpecArgs<TSpec> =
  NodeSpecCarrier<TSpec> extends NodeSpec<infer TShape>
    ? TShape extends { readonly args: infer TArgs }
      ? TArgs extends KeyInput
        ? TArgs
        : never
      : Args.None
    : never;

export type NodeSpecDeclaredDeps<TSpec> =
  NodeSpecCarrier<TSpec> extends NodeSpec<infer TShape>
    ? TShape extends { readonly deps: infer TDeps extends DependenciesRecord }
      ? TDeps
      : Record<string, never>
    : never;

export type NodeSpecResolvedDeps<TSpec> = ResolvedDeps<NodeSpecDeclaredDeps<TSpec>>;

export type NodeSpecKey<TSpec> =
  NodeSpecCarrier<TSpec> extends NodeSpec<infer TShape>
    ? TShape extends { readonly key: infer TKey extends KeyValue }
      ? TKey
      : Singleton
    : never;

export type NodeSpecResult<TSpec> =
  NodeSpecCarrier<TSpec> extends NodeSpec<infer TShape>
    ? TShape extends { readonly result: infer TResult }
      ? TResult
      : unknown
    : never;

export type NodeSpecActions<TSpec> =
  NodeSpecCarrier<TSpec> extends NodeSpec<infer TShape>
    ? TShape extends { readonly actions: infer TActions extends ActionContracts }
      ? TActions
      : Record<string, never>
    : never;

export type NodeSpecInstance<TSpec> = TSpec extends { readonly prototype: infer TNode }
  ? TNode
  : never;

export class FrondNodeSpecError extends TypeError {
  readonly _tag = "FrondNodeSpecError";

  override readonly cause: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "FrondNodeSpecError";
    this.cause = cause;
  }
}

export type NodeDescriptor<TSpec extends NodeSpec<{ readonly result?: unknown }>> = {
  readonly kind: NodeKind;
  readonly tag: NodeTag;
  readonly key: (args: NodeSpecArgs<TSpec>) => NodeSpecKey<TSpec>;
  readonly dependencies: (args: NodeSpecArgs<TSpec>) => NodeSpecDeclaredDeps<TSpec>;
  readonly driver: Driver<
    NodeBase<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>
  >;
};

export type NodeSpecInput<TSpec extends NodeSpec<{ readonly result?: unknown }>> = {
  readonly tag: NodeTag;
  readonly key: (args: NodeSpecArgs<TSpec>) => NodeSpecKey<TSpec>;
  readonly dependencies?:
    | DependencyResolver<NodeSpecArgs<TSpec>, NodeSpecDeclaredDeps<TSpec>>
    | undefined;
  readonly driver: Driver<
    NodeBase<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>
  >;
};

export interface DependencyResolver<TArgs, TDeps extends DependenciesRecord> {
  readonly(args: TArgs): TDeps;
  readonly [FROND_DEPENDENCIES_BRAND]: true;
}

export const FROND_DEPENDENCIES_BRAND: unique symbol = Symbol.for("frond.dependencies") as never;

export type Dependency<TSpec> = {
  readonly type: "dependency";
  readonly spec: TSpec;
  readonly args: NodeSpecArgs<TSpec>;
};

export type Dep<TSpec extends NodeSpecLike> = Dependency<TSpec>;

export type DependenciesRecord = object;

export type ResolvedDeps<TDeps extends object> = {
  readonly [TKey in keyof TDeps]: TDeps[TKey] extends Dependency<infer TSpec>
    ? NodeSpecInstance<TSpec>
    : TDeps[TKey];
};

export type { ActionContract, ActionContracts, ActionInput, ActionInputArgs, ActionOutput };
