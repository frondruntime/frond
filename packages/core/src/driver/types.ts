import type { Effect } from "effect";
import type {
  ActiveNodeLiveDemandSnapshot,
  ResultCommit as GraphResultCommit,
  ResultValidity,
  ResultValidityPolicy,
} from "../graph/types";
import type {
  RuntimeSignal,
  RuntimeSignalAccess,
  RuntimeSignalChannel,
  RuntimeSignalQuery,
  RuntimeSignalRecord,
  RuntimeSignalSubscription,
} from "../signals";
import type {
  AsyncLiveContext,
  AsyncLiveResourceDescriptor,
  AsyncLiveStopContext,
  EffectLiveResourceDescriptor,
  LiveContext,
  LiveResourceStopReason,
  LiveStopContext,
} from "./liveDescriptor";

export type ResultCommit<TValue> = GraphResultCommit<TValue>;

export type AsyncDriverResult<TValue> =
  | TValue
  | ResultCommit<TValue>
  | Promise<TValue | ResultCommit<TValue>>;

export type AsyncDriverVoidResult = void | Promise<void>;

export type AsyncDriverActionResult<TValue = unknown> = TValue | Promise<TValue>;

export type ActionAdmissionPolicy = "queue" | "reject" | "join";

export type ActionAdmission =
  | {
      readonly policy: "queue";
    }
  | {
      readonly policy: "reject";
    }
  | {
      readonly policy: "join";
      readonly admissionKey: (input: unknown) => unknown;
    };

export type ActionOptions<TInput> =
  | {
      readonly admission?: "queue" | "reject" | undefined;
    }
  | (TInput extends void
      ? never
      : {
          readonly admission: "join";
          readonly admissionKey: (input: TInput) => unknown;
        });

export const FROND_DRIVER_ACTION_BRAND: unique symbol = Symbol.for("frond.driver.action") as never;

export interface DriverActionDescriptor<TRun> {
  readonly [FROND_DRIVER_ACTION_BRAND]: true;
  readonly run: TRun;
  readonly admission: ActionAdmission;
}

export interface ActionContract<TInput = void, TOutput = void> {
  readonly _input?: TInput | undefined;
  readonly _output?: TOutput | undefined;
}

export type ActionContracts = object;

export type ActionInput<TAction> =
  TAction extends ActionContract<infer TInput, unknown> ? TInput : unknown;

export type ActionOutput<TAction> =
  TAction extends ActionContract<unknown, infer TOutput> ? TOutput : unknown;

export type ActionInputArgs<TAction> =
  TAction extends ActionContract<infer TInput, unknown>
    ? TInput extends void
      ? readonly []
      : readonly [input: TInput]
    : readonly [input?: unknown];

type AwaitedActionResult<TValue> = TValue extends Promise<infer TOutput> ? TOutput : TValue;

type EffectActionResult<TValue> =
  TValue extends Effect.Effect<infer TOutput, unknown, unknown> ? TOutput : never;

export type AsyncDriverActionContract<TAction> =
  TAction extends DriverActionDescriptor<infer TRun>
    ? TRun extends (
        ctx: AsyncDriverContext<infer _Node, infer _Args, infer _Deps, infer _Result>,
        input: infer TInput
      ) => infer TOutput
      ? ActionContract<TInput, AwaitedActionResult<TOutput>>
      : never
    : TAction extends (
          ctx: AsyncDriverContext<infer _Node, infer _Args, infer _Deps, infer _Result>,
          input: infer TInput
        ) => infer TOutput
      ? ActionContract<TInput, AwaitedActionResult<TOutput>>
      : never;

export type EffectDriverActionContract<TAction> =
  TAction extends DriverActionDescriptor<infer TRun>
    ? TRun extends (
        ctx: DriverContext<infer _Node, infer _Args, infer _Deps, infer _Result>,
        input: infer TInput
      ) => infer TOutput
      ? ActionContract<TInput, EffectActionResult<TOutput>>
      : never
    : TAction extends (
          ctx: DriverContext<infer _Node, infer _Args, infer _Deps, infer _Result>,
          input: infer TInput
        ) => infer TOutput
      ? ActionContract<TInput, EffectActionResult<TOutput>>
      : never;

export type AsyncDriverActionContracts<TActions> = {
  readonly [TName in keyof TActions]: AsyncDriverActionContract<TActions[TName]>;
};

export type EffectDriverActionContracts<TActions> = {
  readonly [TName in keyof TActions]: EffectDriverActionContract<TActions[TName]>;
};

type EffectDriverAction<TNode extends object, TArgs, TDeps extends object, TResult> = {
  bivarianceHack(
    ctx: DriverContext<TNode, TArgs, TDeps, TResult>,
    input: unknown
  ): Effect.Effect<unknown, unknown, unknown>;
}["bivarianceHack"];

export type EffectDriverActionMap<TNode extends object, TArgs, TDeps extends object, TResult> = {
  readonly [name: string]:
    | DriverActionDescriptor<EffectDriverAction<TNode, TArgs, TDeps, TResult>>
    | EffectDriverAction<TNode, TArgs, TDeps, TResult>;
};

export type AsyncRuntimeSignalAccess = {
  readonly publish: (signal: RuntimeSignal) => Promise<void>;
  readonly readRetained: (
    query?: RuntimeSignalQuery | undefined
  ) => Promise<ReadonlyArray<RuntimeSignalRecord>>;
  readonly subscribe: (
    subscriber: AsyncRuntimeSignalSubscriber
  ) => Promise<RuntimeSignalSubscription>;
};

export interface AsyncRuntimeSignalSubscriber {
  readonly name: string;
  readonly channels?: ReadonlyArray<RuntimeSignalChannel> | undefined;
  readonly handle: (record: RuntimeSignalRecord) => void | Promise<void>;
}

export type AsyncAcquireDriverContext<TArgs, TDeps extends object, TResult> = {
  readonly args: TArgs;
  readonly deps: TDeps;
  readonly signal: AbortSignal;
  readonly disposers: DisposerBag;
  readonly signals: AsyncRuntimeSignalAccess;
  readonly setResult: (
    next: TResult | ResultCommit<TResult> | ((current: TResult) => TResult | ResultCommit<TResult>)
  ) => void;
  readonly setResultValidity: (validity: ResultValidity) => void;
  readonly patchResult: (recipe: (current: TResult) => void) => void;
};

export type AsyncDriverContext<
  TNode extends object,
  TArgs,
  TDeps extends object,
  TResult,
> = AsyncAcquireDriverContext<TArgs, TDeps, TResult> & {
  readonly node: TNode;
  readonly refreshDep: <K extends keyof TDeps & string>(name: K) => Promise<TDeps[K]>;
};

type AsyncDriverAction<TNode extends object, TArgs, TDeps extends object, TResult> = {
  bivarianceHack(
    ctx: AsyncDriverContext<TNode, TArgs, TDeps, TResult>,
    input: unknown
  ): AsyncDriverActionResult<unknown>;
}["bivarianceHack"];

export type AsyncDriverActionMap<TNode extends object, TArgs, TDeps extends object, TResult> = {
  readonly [name: string]:
    | DriverActionDescriptor<AsyncDriverAction<TNode, TArgs, TDeps, TResult>>
    | AsyncDriverAction<TNode, TArgs, TDeps, TResult>;
};

export type AsyncDriver<
  TNode extends object,
  TArgs = unknown,
  TDeps extends object = object,
  TResult = unknown,
  TActions extends AsyncDriverActionMap<TNode, TArgs, TDeps, TResult> = Record<string, never>,
> = {
  readonly resultValidity?: ResultValidityPolicy | undefined;
  readonly acquire: (
    ctx: AsyncAcquireDriverContext<TArgs, TDeps, TResult>
  ) => AsyncDriverResult<TResult>;
  readonly release?: (ctx: AsyncDisposeContext<TNode>) => AsyncDriverVoidResult;
  readonly refresh?: (
    ctx: AsyncDriverContext<TNode, TArgs, TDeps, TResult>
  ) => AsyncDriverVoidResult;
  readonly live?: AsyncLiveResourceDescriptor<TNode, unknown> | undefined;
  readonly actions?: TActions | undefined;
};

export type AsyncDisposeContext<TNode extends object> = {
  readonly node: TNode;
  readonly signal: AbortSignal;
  readonly disposers: DisposerBag;
};

export type EffectDriver<
  TNode extends object,
  TArgs = unknown,
  TDeps extends object = object,
  TResult = unknown,
  TActions extends EffectDriverActionMap<TNode, TArgs, TDeps, TResult> = Record<string, never>,
  R = never,
> = {
  readonly resultValidity?: ResultValidityPolicy | undefined;
  readonly acquire: (
    ctx: DriverAcquireContext<TArgs, TDeps, TResult>
  ) => Effect.Effect<TResult | ResultCommit<TResult>, unknown, R>;
  readonly release?: (ctx: DisposeContext<TNode>) => Effect.Effect<void, unknown, R>;
  readonly refresh?: (
    ctx: DriverContext<TNode, TArgs, TDeps, TResult>
  ) => Effect.Effect<void, unknown, R>;
  readonly live?: EffectLiveResourceDescriptor<TNode, unknown, R> | undefined;
  readonly actions?: TActions | undefined;
};

export type DriverMode = "async" | "effect";

export type DriverHook<TRun> =
  | {
      readonly _tag: "Available";
      readonly run: TRun;
    }
  | {
      readonly _tag: "Missing";
    };

export type DriverActionRun<TNode extends object, TArgs, TDeps extends object, TResult> = (
  ctx: NormalizedDriverContext<TNode, TArgs, TDeps, TResult>,
  input: unknown
) => Effect.Effect<unknown, unknown>;

export type DriverActionLookup<TNode extends object, TArgs, TDeps extends object, TResult> =
  | {
      readonly _tag: "Found";
      readonly run: DriverActionRun<TNode, TArgs, TDeps, TResult>;
      readonly admission: ActionAdmission;
    }
  | {
      readonly _tag: "Missing";
      readonly action: string;
    };

export type DriverActionRegistry<TNode extends object, TArgs, TDeps extends object, TResult> = {
  readonly read: (action: string) => DriverActionLookup<TNode, TArgs, TDeps, TResult>;
};

export type Driver<
  TNode extends object,
  TArgs = unknown,
  TDeps extends object = object,
  TResult = unknown,
  TActions extends ActionContracts = ActionContracts,
> = {
  readonly _tag: "NormalizedDriver";
  readonly mode: DriverMode;
  readonly _actions?: TActions | undefined;
  readonly resultValidity?: ResultValidityPolicy | undefined;
  readonly acquire: (
    ctx: NormalizedAcquireDriverContext<TArgs, TDeps, TResult>
  ) => Effect.Effect<TResult | ResultCommit<TResult>, unknown>;
  readonly release: DriverHook<
    (ctx: NormalizedDisposeContext<TNode>) => Effect.Effect<void, unknown>
  >;
  readonly refresh: DriverHook<
    (ctx: NormalizedDriverContext<TNode, TArgs, TDeps, TResult>) => Effect.Effect<void, unknown>
  >;
  readonly live: DriverHook<NormalizedLiveResource<TNode>>;
  readonly actions: DriverActionRegistry<TNode, TArgs, TDeps, TResult>;
};

export type NormalizedDriverContext<TNode extends object, TArgs, TDeps extends object, TResult> = {
  readonly effect: DriverContext<TNode, TArgs, TDeps, TResult>;
  readonly async: AsyncDriverContext<TNode, TArgs, TDeps, TResult>;
};

export type NormalizedAcquireDriverContext<TArgs, TDeps extends object, TResult> = {
  readonly effect: DriverAcquireContext<TArgs, TDeps, TResult>;
  readonly async: AsyncAcquireDriverContext<TArgs, TDeps, TResult>;
};

export type NormalizedDisposeContext<TNode extends object> = {
  readonly effect: DisposeContext<TNode>;
  readonly async: AsyncDisposeContext<TNode>;
};

export type NormalizedLiveContext<TNode extends object> = {
  readonly effect: LiveContext<TNode>;
  readonly async: AsyncLiveContext<TNode>;
};

export type NormalizedLiveStopContext<TNode extends object> = {
  readonly effect: LiveStopContext<TNode>;
  readonly async: AsyncLiveStopContext<TNode>;
};

export interface NormalizedLiveResource<TNode extends object> {
  readonly start: (
    ctx: NormalizedLiveContext<TNode>,
    demand: ActiveNodeLiveDemandSnapshot
  ) => Effect.Effect<unknown, unknown>;
  readonly update?: (
    ctx: NormalizedLiveContext<TNode>,
    resource: unknown,
    demand: ActiveNodeLiveDemandSnapshot
  ) => Effect.Effect<void, unknown>;
  readonly stop: (
    ctx: NormalizedLiveStopContext<TNode>,
    resource: unknown,
    reason: LiveResourceStopReason
  ) => Effect.Effect<void, unknown>;
}

export type DriverContext<TNode extends object, TArgs, TDeps extends object, TResult> = {
  readonly node: TNode;
  readonly refreshDep: <K extends keyof TDeps & string>(
    name: K
  ) => Effect.Effect<TDeps[K], unknown>;
} & DriverAcquireContext<TArgs, TDeps, TResult>;

export type DriverAcquireContext<TArgs, TDeps extends object, TResult> = {
  readonly args: TArgs;
  readonly deps: TDeps;
  readonly signal: AbortSignal;
  readonly disposers: DisposerBag;
  readonly signals: RuntimeSignalAccess;
  readonly setResult: (
    next: TResult | ResultCommit<TResult> | ((current: TResult) => TResult | ResultCommit<TResult>)
  ) => Effect.Effect<void, unknown>;
  readonly setResultValidity: (validity: ResultValidity) => Effect.Effect<void, unknown>;
  readonly patchResult: (recipe: (current: TResult) => void) => Effect.Effect<void, unknown>;
  readonly tryPromise: <TValue>(
    run: (signal: AbortSignal) => Promise<TValue>
  ) => Effect.Effect<TValue, unknown>;
};

export type DisposeContext<TNode extends object> = {
  readonly node: TNode;
  readonly signal: AbortSignal;
  readonly disposers: DisposerBag;
};

export type DisposerBag = {
  readonly add: (disposer: () => void) => void;
};
