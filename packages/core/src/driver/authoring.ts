import type { Effect as EffectType } from "effect";
import type { ResultValidityPolicy } from "../graph/types";
import type { NodeBase } from "../node/runtime";
import type {
  NodeSpec,
  NodeSpecActions,
  NodeSpecArgs,
  NodeSpecResolvedDeps,
  NodeSpecResult,
} from "../node/types";
import { FrondNodeSpecError } from "../node/types";
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
  AsyncDriverContext,
  AsyncDriverResult,
  AsyncDriverVoidResult,
  DisposeContext,
  Driver,
  DriverAcquireContext,
  DriverActionDescriptor,
  DriverContext,
  DriverMode,
  EffectDriver,
  EffectDriverActionMap,
  ResultCommit,
  ResultPatchOptions,
} from "./types";
import { FROND_DRIVER_ACTION_BRAND as ACTION_BRAND } from "./types";

const DRIVER_HOOK_BRAND: unique symbol = Symbol.for("frond.driver.hook") as never;

type DriverHookDescriptor<TKind extends string, TRun> = {
  readonly [DRIVER_HOOK_BRAND]: TKind;
  readonly run: TRun;
};

// The node type hooks see, in the driver's authored mode: effect-mode hooks
// receive a node whose action facade is Effect-native, async-mode hooks a
// Promise-native one.
type SpecNode<
  TSpec extends NodeSpec<{ readonly result?: unknown }>,
  TMode extends DriverMode = "async",
> = NodeBase<TSpec, TMode>;

/**
 * Rejects keys in an explicitly supplied action map (`resourceSpec.async<Spec,
 * typeof actions>`) that have no declared action contract: undeclared keys map
 * to `never`, so phantom actions fail to typecheck instead of registering in
 * the driver registry. Resolves to `unknown` when every key is declared,
 * leaving inline authoring and the generic default unaffected.
 */
type DeclaredActionKeysOnly<TSpec extends NodeSpec<{ readonly result?: unknown }>, TActions> = [
  Exclude<keyof TActions, keyof NodeSpecActions<TSpec>>,
] extends [never]
  ? unknown
  : Record<Exclude<keyof TActions, keyof NodeSpecActions<TSpec>>, never>;

export type AsyncActionImplementations<TSpec extends NodeSpec<{ readonly result?: unknown }>> = {
  readonly [TName in keyof NodeSpecActions<TSpec> & string]: DriverActionDescriptor<
    (
      ctx: AsyncDriverContext<
        SpecNode<TSpec>,
        NodeSpecArgs<TSpec>,
        NodeSpecResolvedDeps<TSpec>,
        NodeSpecResult<TSpec>
      >,
      input: ActionInput<NodeSpecActions<TSpec>[TName]>
    ) => AsyncDriverActionResult<ActionOutput<NodeSpecActions<TSpec>[TName]>>
  >;
};

export type EffectActionImplementations<
  TSpec extends NodeSpec<{ readonly result?: unknown }>,
  R extends never,
> = {
  readonly [TName in keyof NodeSpecActions<TSpec> & string]: DriverActionDescriptor<
    (
      ctx: DriverContext<
        SpecNode<TSpec, "effect">,
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
  ctx: AsyncDriverContext<
    SpecNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>
  >
) => AsyncDriverVoidResult;

type AsyncRelease<TSpec extends NodeSpec<{ readonly result?: unknown }>> = (
  ctx: AsyncDisposeContext<SpecNode<TSpec>>
) => AsyncDriverVoidResult;

type EffectAcquire<TSpec extends NodeSpec<{ readonly result?: unknown }>, R extends never> = (
  ctx: DriverAcquireContext<NodeSpecArgs<TSpec>, NodeSpecResolvedDeps<TSpec>, NodeSpecResult<TSpec>>
) => EffectType.Effect<NodeSpecResult<TSpec> | ResultCommit<NodeSpecResult<TSpec>>, unknown, R>;

type EffectRefresh<TSpec extends NodeSpec<{ readonly result?: unknown }>, R extends never> = (
  ctx: DriverContext<
    SpecNode<TSpec, "effect">,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>
  >
) => EffectType.Effect<void, unknown, R>;

type EffectRelease<TSpec extends NodeSpec<{ readonly result?: unknown }>, R extends never> = (
  ctx: DisposeContext<SpecNode<TSpec, "effect">>
) => EffectType.Effect<void, unknown, R>;

export type AsyncInput<
  TSpec extends NodeSpec<{ readonly result?: unknown }>,
  TActions extends AsyncActionImplementations<TSpec> = AsyncActionImplementations<TSpec>,
> = {
  readonly resultValidity?: ResultValidityPolicy | undefined;
  readonly resultPatch?: ResultPatchOptions | undefined;
  readonly acquire: DriverHookDescriptor<"acquire", AsyncAcquire<TSpec>>;
  readonly refresh?: DriverHookDescriptor<"refresh", AsyncRefresh<TSpec>> | undefined;
  readonly release?: DriverHookDescriptor<"release", AsyncRelease<TSpec>> | undefined;
  readonly live?:
    | DriverHookDescriptor<"live", AsyncLiveResourceDescriptor<SpecNode<TSpec>, unknown>>
    | undefined;
  readonly actions?: (TActions & DeclaredActionKeysOnly<TSpec, TActions>) | undefined;
};

export type EffectInput<
  TSpec extends NodeSpec<{ readonly result?: unknown }>,
  R extends never = never,
  TActions extends EffectActionImplementations<TSpec, R> = EffectActionImplementations<TSpec, R>,
> = {
  readonly resultValidity?: ResultValidityPolicy | undefined;
  readonly resultPatch?: ResultPatchOptions | undefined;
  readonly acquire: DriverHookDescriptor<"acquire", EffectAcquire<TSpec, R>>;
  readonly refresh?: DriverHookDescriptor<"refresh", EffectRefresh<TSpec, R>> | undefined;
  readonly release?: DriverHookDescriptor<"release", EffectRelease<TSpec, R>> | undefined;
  readonly live?:
    | DriverHookDescriptor<
        "live",
        EffectLiveResourceDescriptor<SpecNode<TSpec, "effect">, unknown, R>
      >
    | undefined;
  readonly actions?: (TActions & DeclaredActionKeysOnly<TSpec, TActions>) | undefined;
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
  TActions extends AsyncActionImplementations<TSpec> = AsyncActionImplementations<TSpec>,
>(
  input: AsyncInput<TSpec, TActions>
): Driver<
  SpecNode<TSpec>,
  NodeSpecArgs<TSpec>,
  NodeSpecResolvedDeps<TSpec>,
  NodeSpecResult<TSpec>,
  NodeSpecActions<TSpec>,
  "async"
> {
  assertHookDescriptor(input.acquire, "acquire", "acquire");
  assertOptionalHookDescriptor(input.refresh, "refresh", "refresh");
  assertOptionalHookDescriptor(input.release, "release", "release");
  assertOptionalHookDescriptor(input.live, "live", "live");
  assertActionMap(input.actions);

  return createAsyncDriver({
    resultValidity: input.resultValidity,
    resultPatch: input.resultPatch,
    acquire: input.acquire.run,
    refresh: input.refresh?.run,
    release: input.release?.run,
    live: input.live?.run,
    actions: input.actions,
  } as AsyncDriver<
    SpecNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    AsyncDriverActionMap<
      SpecNode<TSpec>,
      NodeSpecArgs<TSpec>,
      NodeSpecResolvedDeps<TSpec>,
      NodeSpecResult<TSpec>
    >
  >) as unknown as Driver<
    SpecNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>,
    "async"
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
  R extends never = never,
  TActions extends EffectActionImplementations<TSpec, R> = EffectActionImplementations<TSpec, R>,
>(
  input: EffectInput<TSpec, R, TActions>
): Driver<
  SpecNode<TSpec>,
  NodeSpecArgs<TSpec>,
  NodeSpecResolvedDeps<TSpec>,
  NodeSpecResult<TSpec>,
  NodeSpecActions<TSpec>,
  "effect"
> {
  assertHookDescriptor(input.acquire, "acquire", "acquire");
  assertOptionalHookDescriptor(input.refresh, "refresh", "refresh");
  assertOptionalHookDescriptor(input.release, "release", "release");
  assertOptionalHookDescriptor(input.live, "live", "live");
  assertActionMap(input.actions);

  return createEffectDriver({
    resultValidity: input.resultValidity,
    resultPatch: input.resultPatch,
    acquire: input.acquire.run,
    refresh: input.refresh?.run,
    release: input.release?.run,
    live: input.live?.run,
    actions: input.actions,
  } as EffectDriver<
    SpecNode<TSpec, "effect">,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    EffectDriverActionMap<
      SpecNode<TSpec, "effect">,
      NodeSpecArgs<TSpec>,
      NodeSpecResolvedDeps<TSpec>,
      NodeSpecResult<TSpec>
    >,
    R
  >) as unknown as Driver<
    SpecNode<TSpec>,
    NodeSpecArgs<TSpec>,
    NodeSpecResolvedDeps<TSpec>,
    NodeSpecResult<TSpec>,
    NodeSpecActions<TSpec>,
    "effect"
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

function assertOptionalHookDescriptor<TKind extends string>(
  value: unknown,
  expectedKind: TKind,
  field: string
): void {
  if (value !== undefined) {
    assertHookDescriptor(value, expectedKind, field);
  }
}

function assertHookDescriptor<TKind extends string>(
  value: unknown,
  expectedKind: TKind,
  field: string
): asserts value is DriverHookDescriptor<TKind, unknown> {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as { readonly [DRIVER_HOOK_BRAND]?: unknown })[DRIVER_HOOK_BRAND] !== expectedKind ||
    !("run" in value) ||
    (expectedKind !== "live" && typeof (value as { readonly run?: unknown }).run !== "function")
  ) {
    throw new FrondNodeSpecError(
      `Frond driver ${field} hook must use Driver.${hookName(expectedKind)}(...).`
    );
  }
}

function assertActionMap(actions: unknown): void {
  const actionMap = actions as Readonly<Record<string, unknown>> | undefined;

  for (const [name, action] of Object.entries(actionMap ?? {})) {
    if (typeof action === "function") {
      continue;
    }

    if (
      typeof action === "object" &&
      action !== null &&
      (action as { readonly [ACTION_BRAND]?: unknown })[ACTION_BRAND] === true &&
      typeof (action as { readonly run?: unknown }).run === "function"
    ) {
      continue;
    }

    throw new FrondNodeSpecError(
      `Frond driver action "${name}" must be a function or Driver.Action(...).`
    );
  }
}

function hookName(kind: string): string {
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}`;
}
