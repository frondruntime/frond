import { Effect } from "effect";
import type { EffectLiveResourceDescriptor } from "./liveDescriptor";
import { buildNormalizedDriver } from "./normalize";
import type {
  Driver,
  EffectDriver,
  EffectDriverActionContracts,
  EffectDriverActionMap,
  NormalizedLiveResource,
  ResultCommit,
} from "./types";

// Pure typed driver constructor; runtime work starts only after normalization.
export function createEffectDriver<
  TResult,
  TActions extends EffectDriverActionMap<object, unknown, object, TResult>,
  R = never,
>(
  driver: EffectDriver<object, unknown, object, TResult, TActions, R>
): Driver<object, unknown, object, TResult, EffectDriverActionContracts<TActions>>;
export function createEffectDriver<
  TNode extends object = object,
  TDeps extends object = object,
  TResult = unknown,
  TArgs = unknown,
  TActions extends EffectDriverActionMap<TNode, TArgs, TDeps, TResult> = Record<string, never>,
  R = never,
>(
  driver: EffectDriver<TNode, TArgs, TDeps, TResult, TActions, R>
): Driver<object, unknown, object, TResult, EffectDriverActionContracts<TActions>>;
export function createEffectDriver<
  TNode extends object = object,
  TDeps extends object = object,
  TResult = unknown,
  TArgs = unknown,
  TActions extends EffectDriverActionMap<TNode, TArgs, TDeps, TResult> = Record<string, never>,
  R = never,
>(
  driver: EffectDriver<TNode, TArgs, TDeps, TResult, TActions, R>
): Driver<object, unknown, object, TResult, EffectDriverActionContracts<TActions>> {
  const normalized = buildNormalizedDriver<
    TNode,
    TArgs,
    TDeps,
    TResult,
    EffectDriverActionContracts<TActions>,
    TActions,
    NonNullable<EffectDriver<TNode, TArgs, TDeps, TResult, TActions, R>["release"]>,
    NonNullable<EffectDriver<TNode, TArgs, TDeps, TResult, TActions, R>["refresh"]>,
    NonNullable<EffectDriver<TNode, TArgs, TDeps, TResult, TActions, R>["live"]>,
    TActions[keyof TActions]
  >({
    mode: "effect",
    resultValidity: driver.resultValidity,
    acquire: (ctx) =>
      Effect.suspend(
        () => driver.acquire(ctx.effect) as Effect.Effect<TResult | ResultCommit<TResult>, unknown>
      ),
    release: driver.release,
    refresh: driver.refresh,
    live: driver.live,
    actions: driver.actions,
    normalizeRelease: (release) => (ctx) =>
      Effect.suspend(() => release(ctx.effect) as Effect.Effect<void, unknown>),
    normalizeRefresh: (refresh) => (ctx) =>
      Effect.suspend(() => refresh(ctx.effect) as Effect.Effect<void, unknown>),
    normalizeLive: normalizeEffectLiveResource,
    normalizeAction: (action) => (ctx, input) =>
      Effect.suspend(() => runAction(action, ctx.effect, input) as Effect.Effect<unknown, unknown>),
  });

  return normalized as unknown as Driver<
    object,
    unknown,
    object,
    TResult,
    EffectDriverActionContracts<TActions>
  >;
}

function runAction<TAction>(action: TAction, ctx: unknown, input: unknown): unknown {
  const run =
    typeof action === "object" &&
    action !== null &&
    "run" in action &&
    typeof (action as { readonly run?: unknown }).run === "function"
      ? (action as { readonly run: (ctx: unknown, input: unknown) => unknown }).run
      : (action as (ctx: unknown, input: unknown) => unknown);

  return run(ctx, input);
}

function normalizeEffectLiveResource<TNode extends object>(
  live: EffectLiveResourceDescriptor<TNode, unknown, unknown>
): NormalizedLiveResource<TNode> {
  const resource = {
    start: (ctx, demand) =>
      Effect.suspend(() => live.start(ctx.effect, demand) as Effect.Effect<unknown, unknown>),
    stop: (ctx, resource, reason) =>
      Effect.suspend(
        () => live.stop({ ...ctx.effect, reason }, resource) as Effect.Effect<void, unknown>
      ),
  } satisfies NormalizedLiveResource<TNode>;

  return live.update === undefined
    ? resource
    : {
        ...resource,
        update: (ctx, liveResource, demand) =>
          Effect.suspend(
            () => live.update?.(ctx.effect, liveResource, demand) as Effect.Effect<void, unknown>
          ),
      };
}
