import { Match } from "effect";
import {
  makeObservable,
  observable,
  onBecomeObserved,
  onBecomeUnobserved,
  runInAction,
  untracked,
} from "mobx";
import type {
  ActionContract,
  ActionContracts,
  ActionInput,
  ActionInputArgs,
  ActionOutput,
  Driver,
} from "../driver/types";
import type { ActionResult, NodeId as GraphNodeId } from "../graph/types";
import type { KeyValue, Singleton } from "../keys";

export const FROND_NODE_SPEC_BRAND: unique symbol = Symbol.for("frond.nodeSpec") as never;
declare const NODE_TAG_BRAND: unique symbol;

export type NodeId = GraphNodeId;

export type NodeTag = string & {
  readonly [NODE_TAG_BRAND]: "NodeTag";
};

export type NodeKind = "node" | "service" | "resource" | "facade";

export namespace Args {
  export type None = Record<string, never>;
  export const none: None = {};
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
    readonly args?: unknown;
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
    readonly args?: unknown;
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

/**
 * Base class for author nodes constructed by the graph after readiness succeeds.
 *
 * `super()` receives graph-owned ready state from a construction context. Direct
 * construction outside Frond throws, and closed ready nodes reject runtime-backed
 * reads/actions after release, eviction, or graph stop.
 */
export class NodeBase<TSpec extends NodeSpec<{ readonly result?: unknown }>> {
  private _nodeId: NodeId;

  private _tagSlot: string;

  private _args: NodeSpecArgs<TSpec>;

  private _deps: NodeSpecResolvedDeps<TSpec>;

  private _result: NodeSpecResult<TSpec>;

  private _action: RuntimeActionExecutor;

  private _reportResultObserved: RuntimeResultObservationReporter;

  private _addDisposer: (disposer: () => void) => void;

  private _resultObserved = false;

  private _resultObservationReported = false;

  private _closed = false;

  readonly actions: NodeActions<NodeSpecActions<TSpec>>;

  constructor() {
    const construction = currentReadyNodeConstruction as
      | RuntimeReadyNodeConstruction<
          NodeSpecArgs<TSpec>,
          NodeSpecResolvedDeps<TSpec>,
          NodeSpecResult<TSpec>
        >
      | undefined;

    if (construction === undefined) {
      throw new FrondNodeConstructionUnavailable();
    }

    this._nodeId = construction.nodeId;
    this._tagSlot = construction.tag;
    this._args = construction.args;
    this._deps = construction.deps;
    this._result = construction.result;
    this._action = construction.action;
    this._reportResultObserved = construction.reportResultObserved;
    this._addDisposer = construction.addDisposer;
    this.actions = makeActionFacade<NodeSpecActions<TSpec>>(
      declaredActionPredicate(new.target),
      (name, input) => this._runAction(name, input)
    );

    makeObservable<NodeBase<TSpec>, "_args" | "_deps" | "_result">(this, {
      _args: observable.ref,
      _deps: observable.ref,
      _result: observable.ref,
    });
    onBecomeObserved(this, "_result", () => {
      this._resultObserved = true;
      this._reportObservedResultIfReady();
    });
    onBecomeUnobserved(this, "_result", () => {
      this._resultObserved = false;
      this._releaseReportedResultObservation();
    });
  }

  get nodeId(): NodeId {
    this._assertOpen("nodeId");
    return this._nodeId;
  }

  get tag(): string {
    this._assertOpen("tag");
    return this._tagSlot;
  }

  get args(): NodeSpecArgs<TSpec> {
    this._assertOpen("args");
    return this._args;
  }

  get deps(): NodeSpecResolvedDeps<TSpec> {
    this._assertOpen("deps");
    return this._deps;
  }

  get result(): NodeSpecResult<TSpec> {
    this._assertOpen("result");
    return this._result;
  }

  private _runAction(name: string, input?: unknown): Promise<unknown> {
    if (this._closed) {
      return Promise.reject(new FrondNodeClosed(`action:${name}`));
    }

    return this._action(name, input).then((result) =>
      Match.value(result).pipe(
        Match.tag("Success", ({ value }) => value),
        Match.tag("Failure", ({ error }) => {
          throw error;
        }),
        Match.exhaustive
      )
    );
  }

  /**
   * Reports field-level MobX observation as driver liveness demand.
   *
   * Use from ready node code when a domain field should control live resources.
   * React presence is not driver liveness.
   */
  protected reportResultObserved(scope: unknown, observed: boolean): void {
    this._assertOpen("result observation");
    this._reportResultObserved(scope, observed);
  }

  /**
   * Registers cleanup owned by the ready node lifecycle.
   *
   * Disposers registered here run when Frond closes this ready node, not when a
   * React component unmounts unless that unmount releases or evicts the node.
   */
  protected onRuntimeClose(disposer: () => void): void {
    this._assertOpen("runtime close disposer");
    this._addDisposer(disposer);
  }

  /**
   * Reads the ready result without MobX tracking.
   *
   * Use inside domain methods that mutate observable result objects without
   * turning the method itself into a liveness observation.
   */
  protected untrackedResult(): NodeSpecResult<TSpec> {
    this._assertOpen("result");
    return untracked(() => this._result);
  }

  _updateRuntimeReadyState(
    update: RuntimeReadyNodeUpdate<
      NodeSpecArgs<TSpec>,
      NodeSpecResolvedDeps<TSpec>,
      NodeSpecResult<TSpec>
    >
  ): void {
    this._assertOpen("runtime state");
    runInAction(() => {
      if ("args" in update) {
        this._args = update.args as NodeSpecArgs<TSpec>;
      }
      if ("deps" in update) {
        this._deps = update.deps as NodeSpecResolvedDeps<TSpec>;
      }
      if ("result" in update) {
        this._result = update.result as NodeSpecResult<TSpec>;
      }
      this._reportObservedResultIfReady();
    });
  }

  _closeRuntimeNode(): void {
    runInAction(() => {
      this._releaseReportedResultObservation();
      this._closed = true;
    });
  }

  _isRuntimeNodeClosed(): boolean {
    return this._closed;
  }

  private _reportObservedResultIfReady(): void {
    if (!this._resultObserved || this._resultObservationReported || this._closed) {
      return;
    }

    this._resultObservationReported = true;
    this._reportResultObserved({ field: "result" }, true);
  }

  private _releaseReportedResultObservation(): void {
    if (!this._resultObservationReported) {
      return;
    }

    this._resultObservationReported = false;
    this._reportResultObserved({ field: "result" }, false);
  }

  private _assertOpen(field: string): void {
    if (this._closed) {
      throw new FrondNodeClosed(field);
    }
  }
}

/**
 * Ready author-node shape exposed to consumers and driver operation contexts.
 *
 * This type is for ready nodes only. Non-ready runtime reads carry lifecycle
 * variants and do not expose author node instances.
 */
export type FrondNode<
  TSpecOrArgs = NodeSpec<{ readonly result: unknown }>,
  TDeps extends object = never,
  TResult = never,
  TActions extends ActionContracts = Record<string, never>,
> = [TDeps] extends [never]
  ? NodeBase<TSpecOrArgs extends NodeSpec ? TSpecOrArgs : NodeSpec<{ readonly result: unknown }>>
  : NodeBase<
      NodeSpec<{
        readonly args: TSpecOrArgs;
        readonly deps: TDeps;
        readonly result: TResult;
        readonly actions: TActions;
      }>
    >;

type NodeSpecCarrier<TSpec> = TSpec extends { readonly spec: NodeDescriptor<infer TCarrier> }
  ? TCarrier
  : TSpec;

export type NodeSpecArgs<TSpec> =
  NodeSpecCarrier<TSpec> extends NodeSpec<infer TShape>
    ? TShape extends { readonly args: infer TArgs }
      ? TArgs
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

export type RuntimeActionExecutor = (name: string, input?: unknown) => Promise<ActionResult>;

export type RuntimeResultObservationReporter = (scope: unknown, observed: boolean) => void;

/**
 * Runtime-only payload used while constructing a ready author node.
 *
 * Boundary: this is the only path from graph-owned cell state into `NodeBase`.
 * Public constructors intentionally receive no arguments.
 */
export type RuntimeReadyNodeConstruction<TArgs, TDeps extends object, TResult> = {
  readonly nodeId: NodeId;
  readonly tag: string;
  readonly args: TArgs;
  readonly deps: TDeps;
  readonly result: TResult;
  readonly action: RuntimeActionExecutor;
  readonly reportResultObserved: RuntimeResultObservationReporter;
  readonly addDisposer: (disposer: () => void) => void;
};

export type RuntimeReadyNodeUpdate<TArgs, TDeps extends object, TResult> = {
  readonly args?: TArgs | undefined;
  readonly deps?: TDeps | undefined;
  readonly result?: TResult | undefined;
};

export type RuntimeReadyNodeControl<TArgs, TDeps extends object, TResult> = {
  _updateRuntimeReadyState: (update: RuntimeReadyNodeUpdate<TArgs, TDeps, TResult>) => void;
  _closeRuntimeNode: () => void;
  _isRuntimeNodeClosed: () => boolean;
};

export class FrondNodeConstructionUnavailable extends Error {
  readonly _tag = "FrondNodeConstructionUnavailable";

  constructor() {
    super("Frond node instances can only be constructed by the Frond runtime after readiness.");
    this.name = "FrondNodeConstructionUnavailable";
  }
}

export class FrondNodeClosed extends Error {
  readonly _tag = "FrondNodeClosed";

  readonly field: string;

  constructor(field: string) {
    super(`Frond node field "${field}" is not available after the ready node was closed.`);
    this.name = "FrondNodeClosed";
    this.field = field;
  }
}

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

let currentReadyNodeConstruction:
  | RuntimeReadyNodeConstruction<unknown, object, unknown>
  | undefined;

export function withReadyNodeConstruction<TValue>(
  construction: RuntimeReadyNodeConstruction<unknown, object, unknown>,
  run: () => TValue
): TValue {
  // Hazard: node construction is stack-scoped so nested construction restores
  // the previous context and direct async leakage cannot hydrate later nodes.
  const previous = currentReadyNodeConstruction;
  currentReadyNodeConstruction = construction;

  try {
    return run();
  } finally {
    currentReadyNodeConstruction = previous;
  }
}

export function asRuntimeReadyNodeControl<TArgs, TDeps extends object, TResult>(
  node: object | undefined
): RuntimeReadyNodeControl<TArgs, TDeps, TResult> | undefined {
  const control = node as Partial<RuntimeReadyNodeControl<TArgs, TDeps, TResult>> | undefined;

  return typeof control?._updateRuntimeReadyState === "function" &&
    typeof control._closeRuntimeNode === "function" &&
    typeof control._isRuntimeNodeClosed === "function"
    ? (control as RuntimeReadyNodeControl<TArgs, TDeps, TResult>)
    : undefined;
}

// Protocol trap names the JavaScript runtime probes on arbitrary objects.
// Returning a callable for "then" makes the facade a thenable, so awaiting it
// never settles and dispatches a phantom action; "toJSON" fires on stringify.
const PROTOCOL_PROPERTY_NAMES: ReadonlySet<string> = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "constructor",
  "toString",
  "valueOf",
]);

function declaredActionPredicate(target: unknown): (name: string) => boolean {
  const spec = (
    target as
      | {
          readonly spec?: {
            readonly driver?: {
              readonly actions?: {
                readonly read?: (action: string) => { readonly _tag: "Found" | "Missing" };
              };
            };
          };
        }
      | undefined
  )?.spec;
  const read = spec?.driver?.actions?.read;

  if (typeof read !== "function") {
    // Runtime construction always goes through a validated node spec class, so
    // the declared registry is reachable. This guard only covers exotic
    // subclassing and degrades to blocking protocol trap names.
    return (name) => !PROTOCOL_PROPERTY_NAMES.has(name);
  }

  return (name) => read(name)._tag === "Found";
}

function makeActionFacade<TActions extends ActionContracts>(
  isDeclaredAction: (name: string) => boolean,
  runAction: (name: string, input?: unknown) => Promise<unknown>
): NodeActions<TActions> {
  // Only declared action contract names dispatch. Every other property reads as
  // undefined so the facade is never mistaken for a thenable and never invents
  // phantom actions for protocol probes such as "then" or "toJSON".
  return new Proxy(Object.create(null), {
    get(_target, property) {
      if (typeof property !== "string" || !isDeclaredAction(property)) {
        return undefined;
      }

      return (...input: ReadonlyArray<unknown>) => runAction(property, input[0]);
    },
    has(_target, property) {
      return typeof property === "string" && isDeclaredAction(property);
    },
  }) as NodeActions<TActions>;
}

export type { ActionContract, ActionContracts, ActionInput, ActionInputArgs, ActionOutput };
