import type { Effect as EffectType } from "effect";
import type {
  NodeBase,
  NodeSpec,
  NodeSpecActions,
  NodeSpecArgs,
  NodeSpecResolvedDeps,
  NodeSpecResult,
} from "../node/types";
import { createAsyncDriver } from "./asyncDefinition";
import { createEffectDriver } from "./effectDefinition";
import type {
  AsyncLiveResource,
  AsyncLiveResourceDescriptor,
  EffectLiveResource,
  EffectLiveResourceDescriptor,
} from "./liveDescriptor";
import { createLiveDescriptor } from "./liveDescriptor";
import type {
  ActionInput,
  ActionOptions,
  ActionOutput,
  AsyncAcquireDriverContext,
  AsyncDisposeContext,
  AsyncDriver,
  AsyncDriverActionMap,
  AsyncDriverActionResult,
  AsyncDriverResult,
  AsyncDriverVoidResult,
  DisposeContext,
  Driver,
  DriverAcquireContext,
  DriverActionDescriptor,
  DriverContext,
  EffectDriver,
  EffectDriverActionMap,
  ResultCommit,
} from "./types";
import { FROND_DRIVER_ACTION_BRAND as ACTION_BRAND } from "./types";

const DRIVER_HOOK_BRAND: unique symbol = Symbol.for("frond.driver.hook") as never;

type DriverHookDescriptor<TKind extends string, TRun> = {
  readonly [DRIVER_HOOK_BRAND]: TKind;
  readonly run: TRun;
};

type AsyncNode<TSpec extends NodeSpec<{ readonly result?: unknown }>> = NodeBase<TSpec>;

type AsyncActionImplementations<TSpec extends NodeSpec<{ readonly result?: unknown }>> = {
  readonly [TName in keyof NodeSpecActions<TSpec> & string]: DriverActionDescriptor<
    (
      ctx: import("./types").AsyncDriverContext<
        AsyncNode<TSpec>,
        NodeSpecArgs<TSpec>,
        NodeSpecResolvedDeps<TSpec>,
        NodeSpecResult<TSpec>
      >,
      input: ActionInput<NodeSpecActions<TSpec>[TName]>
    ) => AsyncDriverActionResult<ActionOutput<NodeSpecActions<TSpec>[TName]>>
  >;
};

type EffectActionImplementations<TSpec extends NodeSpec<{ readonly result?: unknown }>, R> = {
  readonly [TName in keyof NodeSpecActions<TSpec> & string]: DriverActionDescriptor<
    (
      ctx: DriverContext<
        AsyncNode<TSpec>,
        NodeSpecArgs<TSpec>,
        NodeSpecResolvedDeps<TSpec>,
        NodeSpecResult<TSpec>
      >,
      input: ActionInput<NodeSpecActions<TSpec>[TName]>
    ) => EffectType.Effect<ActionOutput<NodeSpecActions<TSpec>[TName]>, unknown, R>
  >;
};

type AsyncAcquire<TSpec extends NodeSpec<{ readonly result?: unknown }>> = (
  ctx: AsyncAcquireDriverContext<
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>
  >
) => AsyncDriverResult<NodeSpecResult<TSpec>>;

type AsyncRefresh<TSpec extends NodeSpec<{ readonly result?: unknown }>> = (
  ctx: import("./types").AsyncDriverContext<
    AsyncNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>
  >
) => AsyncDriverVoidResult;

type AsyncRelease<TSpec extends NodeSpec<{ readonly result?: unknown }>> = (
  ctx: AsyncDisposeContext<AsyncNode<TSpec>>
) => AsyncDriverVoidResult;

type EffectAcquire<TSpec extends NodeSpec<{ readonly result?: unknown }>, R> = (
  ctx: DriverAcquireContext<NodeSpecArgs<TSpec>, NodeSpecResolvedDeps<TSpec>, NodeSpecResult<TSpec>>
) => EffectType.Effect<NodeSpecResult<TSpec> | ResultCommit<NodeSpecResult<TSpec>>, unknown, R>;

type EffectRefresh<TSpec extends NodeSpec<{ readonly result?: unknown }>, R> = (
  ctx: DriverContext<
    AsyncNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>
  >
) => EffectType.Effect<void, unknown, R>;

type EffectRelease<TSpec extends NodeSpec<{ readonly result?: unknown }>, R> = (
  ctx: DisposeContext<AsyncNode<TSpec>>
) => EffectType.Effect<void, unknown, R>;

export type AsyncInput<
  TSpec extends NodeSpec<{ readonly result?: unknown }>,
  TActions = AsyncActionImplementations<TSpec>,
> = {
  readonly resultValidity?: AsyncDriver<
    AsyncNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    AsyncDriverActionMap<
      AsyncNode<TSpec>,
      NodeSpecArgs<TSpec>,
      NodeSpecResolvedDeps<TSpec>,
      NodeSpecResult<TSpec>
    >
  >["resultValidity"];
  readonly acquire: DriverHookDescriptor<"acquire", AsyncAcquire<TSpec>>;
  readonly refresh?: DriverHookDescriptor<"refresh", AsyncRefresh<TSpec>> | undefined;
  readonly release?: DriverHookDescriptor<"release", AsyncRelease<TSpec>> | undefined;
  readonly live?:
    | DriverHookDescriptor<"live", AsyncLiveResourceDescriptor<AsyncNode<TSpec>, unknown>>
    | undefined;
  readonly actions?: TActions | undefined;
};

export type EffectInput<
  TSpec extends NodeSpec<{ readonly result?: unknown }>,
  R = never,
  TActions = EffectActionImplementations<TSpec, R>,
> = {
  readonly resultValidity?: EffectDriver<
    AsyncNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    EffectDriverActionMap<
      AsyncNode<TSpec>,
      NodeSpecArgs<TSpec>,
      NodeSpecResolvedDeps<TSpec>,
      NodeSpecResult<TSpec>
    >,
    R
  >["resultValidity"];
  readonly acquire: DriverHookDescriptor<"acquire", EffectAcquire<TSpec, R>>;
  readonly refresh?: DriverHookDescriptor<"refresh", EffectRefresh<TSpec, R>> | undefined;
  readonly release?: DriverHookDescriptor<"release", EffectRelease<TSpec, R>> | undefined;
  readonly live?:
    | DriverHookDescriptor<"live", EffectLiveResourceDescriptor<AsyncNode<TSpec>, unknown, R>>
    | undefined;
  readonly actions?: TActions | undefined;
};

/**
 * Builds a Promise-facing driver for frontend-style authoring.
 *
 * Async drivers may call Promise APIs such as HTTP clients. They must not return
 * Effect values from hooks; use `Driver.Effect` when the hook itself is
 * Effect-native.
 */
export function Async<
  TSpec extends NodeSpec<{ readonly result?: unknown }>,
  TActions = AsyncActionImplementations<TSpec>,
>(
  input: AsyncInput<TSpec, TActions>
): Driver<
  AsyncNode<TSpec>,
  NodeSpecArgs<TSpec>,
  NodeSpecResolvedDeps<TSpec>,
  NodeSpecResult<TSpec>,
  NodeSpecActions<TSpec>
> {
  return createAsyncDriver({
    resultValidity: input.resultValidity,
    acquire: input.acquire.run,
    refresh: input.refresh?.run,
    release: input.release?.run,
    live: input.live?.run,
    actions: input.actions,
  } as AsyncDriver<
    AsyncNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    AsyncDriverActionMap<
      AsyncNode<TSpec>,
      NodeSpecArgs<TSpec>,
      NodeSpecResolvedDeps<TSpec>,
      NodeSpecResult<TSpec>
    >
  >) as unknown as Driver<
    AsyncNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>
  >;
}

/**
 * Builds an Effect-native driver.
 *
 * Effect drivers preserve typed failures, requirements, interruption, and Cause
 * across graph execution. Use this when the driver belongs to the runtime
 * Effect domain instead of a Promise bridge.
 */
export function Effect<
  TSpec extends NodeSpec<{ readonly result?: unknown }>,
  R = never,
  TActions = EffectActionImplementations<TSpec, R>,
>(
  input: EffectInput<TSpec, R, TActions>
): Driver<
  AsyncNode<TSpec>,
  NodeSpecArgs<TSpec>,
  NodeSpecResolvedDeps<TSpec>,
  NodeSpecResult<TSpec>,
  NodeSpecActions<TSpec>
> {
  return createEffectDriver({
    resultValidity: input.resultValidity,
    acquire: input.acquire.run,
    refresh: input.refresh?.run,
    release: input.release?.run,
    live: input.live?.run,
    actions: input.actions,
  } as EffectDriver<
    AsyncNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    EffectDriverActionMap<
      AsyncNode<TSpec>,
      NodeSpecArgs<TSpec>,
      NodeSpecResolvedDeps<TSpec>,
      NodeSpecResult<TSpec>
    >,
    R
  >) as unknown as Driver<
    AsyncNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>
  >;
}

/**
 * Defines the readiness hook.
 *
 * Acquire receives args, ready dependencies, signals, and result helpers, but no
 * ready node instance. The author node is constructed only after acquire
 * commits a valid result.
 */
export function Acquire<TRun>(run: TRun): DriverHookDescriptor<"acquire", TRun> {
  return hook("acquire", run);
}

/**
 * Defines a ready-node refresh hook.
 *
 * Refresh runs against the current ready node and is serialized with actions and
 * args updates for the same graph cell.
 */
export function Refresh<TRun>(run: TRun): DriverHookDescriptor<"refresh", TRun> {
  return hook("refresh", run);
}

/**
 * Defines ready-node cleanup work.
 *
 * Release runs when Frond closes a ready node. Do not use it for live-resource
 * subscriptions; use `Driver.Live` for demand-driven resources.
 */
export function Release<TRun>(run: TRun): DriverHookDescriptor<"release", TRun> {
  return hook("release", run);
}

/**
 * Defines demand-driven live work.
 *
 * `start` receives only active demand; `stop` owns cleanup. Authors should not
 * branch on inactive demand or register live cleanup through operation
 * disposers.
 */
export function Live<TNode extends object, TResource>(
  resource: AsyncLiveResource<TNode, TResource>
): DriverHookDescriptor<"live", AsyncLiveResourceDescriptor<TNode, TResource>>;
export function Live<TNode extends object, TResource, R = never>(
  resource: EffectLiveResource<TNode, TResource, R>
): DriverHookDescriptor<"live", EffectLiveResourceDescriptor<TNode, TResource, R>>;
export function Live(resource: object): DriverHookDescriptor<"live", object> {
  return hook("live", createLiveDescriptor(resource as AsyncLiveResource<object, unknown>));
}

/**
 * Defines a serialized domain action.
 *
 * The default admission policy queues per node. Use join admission only when
 * equal inputs should share one in-flight operation.
 */
export function Action<TContext, TInput, TOutput>(
  run: { bivarianceHack(ctx: TContext, input: TInput): TOutput }["bivarianceHack"],
  options?: ActionOptions<TInput>
): DriverActionDescriptor<typeof run> {
  if (
    options?.admission === "join" &&
    typeof (options as { readonly admissionKey?: unknown }).admissionKey !== "function"
  ) {
    throw new TypeError("Frond.Driver.Action join admission requires admissionKey(input).");
  }

  const admission =
    options?.admission === "join"
      ? {
          policy: "join" as const,
          admissionKey: options.admissionKey as (input: unknown) => unknown,
        }
      : ({ policy: options?.admission ?? "queue" } as const);

  return {
    [ACTION_BRAND]: true,
    run,
    admission,
  } satisfies DriverActionDescriptor<typeof run>;
}

function hook<TKind extends string, TRun>(
  kind: TKind,
  run: TRun
): DriverHookDescriptor<TKind, TRun> {
  return {
    [DRIVER_HOOK_BRAND]: kind,
    run,
  };
}
