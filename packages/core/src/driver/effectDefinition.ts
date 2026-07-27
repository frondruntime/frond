import { Effect, Fiber } from "effect";
import type { EffectLiveResourceDescriptor } from "./liveDescriptor";
import { buildNormalizedDriver } from "./normalize";
import type {
  Driver,
  EffectDriver,
  EffectDriverActionContracts,
  EffectDriverActionMap,
  NormalizedLiveResource,
  NormalizedLiveStartOptions,
  ResultCommit,
} from "./types";

// Pure typed driver constructor; runtime work starts only after normalization.
export function createEffectDriver<
  TResult,
  TActions extends EffectDriverActionMap<object, unknown, object, TResult>,
  R extends never = never,
>(
  driver: EffectDriver<object, unknown, object, TResult, TActions, R>
): Driver<object, unknown, object, TResult, EffectDriverActionContracts<TActions>>;
export function createEffectDriver<
  TNode extends object = object,
  TDeps extends object = object,
  TResult = unknown,
  TArgs = unknown,
  TActions extends EffectDriverActionMap<TNode, TArgs, TDeps, TResult> = Record<string, never>,
  R extends never = never,
>(
  driver: EffectDriver<TNode, TArgs, TDeps, TResult, TActions, R>
): Driver<object, unknown, object, TResult, EffectDriverActionContracts<TActions>>;
export function createEffectDriver<
  TNode extends object = object,
  TDeps extends object = object,
  TResult = unknown,
  TArgs = unknown,
  TActions extends EffectDriverActionMap<TNode, TArgs, TDeps, TResult> = Record<string, never>,
  R extends never = never,
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
    resultPatch: driver.resultPatch,
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
    start: (ctx, demand, options) =>
      runRoutedEffectLiveStart(
        Effect.suspend(() => live.start(ctx.effect, demand) as Effect.Effect<unknown, unknown>),
        options
      ),
    stop: (ctx, resource) =>
      Effect.suspend(() => live.stop(ctx.effect, resource) as Effect.Effect<void, unknown>),
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

// Interrupt atomicity, effect mode (the mirror of the async normalization's
// retained-promise escape): a start effect like `Effect.uninterruptible(acquire)`
// that completes while an interrupt is pending discards its value at the region
// boundary — the caller never sees the resource, so nothing routes it to stop.
// The only place a produced value is guaranteed observable is a continuation
// inside the same uninterruptible region as the start completion, so the start
// runs fully masked on a detached routing fiber with a recording tap fused into
// that region (mirroring acquireRelease's acquire contract). The caller's fiber
// awaits the routing fiber interruptibly, so stop, eviction, and driver
// timeouts abandon the operation promptly; abandonment sends the routing fiber
// an interrupt that can only land inside driver-authored `Effect.interruptible`
// regions — where no resource exists yet. A resource produced before or after
// abandonment is reported through `onAbandonedResource` instead of dropped.
function runRoutedEffectLiveStart(
  start: Effect.Effect<unknown, unknown>,
  options: NormalizedLiveStartOptions | undefined
): Effect.Effect<unknown, unknown> {
  const onAbandonedResource = options?.onAbandonedResource;

  if (onAbandonedResource === undefined) {
    return start;
  }

  return Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let produced: { readonly resource: unknown } | undefined;
      let abandoned = false;
      const routing = yield* Effect.forkDetach(
        Effect.uninterruptibleMask(() =>
          start.pipe(
            Effect.tap((resource) =>
              Effect.sync(() => {
                produced = { resource };

                if (abandoned) {
                  onAbandonedResource(resource);
                }
              })
            )
          )
        )
      );

      return yield* restore(Fiber.join(routing)).pipe(
        Effect.onInterrupt(() =>
          Effect.gen(function* () {
            abandoned = true;

            // The routing tap already recorded a resource: report it here —
            // the tap's own abandoned check ran before this interrupt landed.
            if (produced !== undefined) {
              onAbandonedResource(produced.resource);
            }

            yield* Effect.forkDetach(Fiber.interrupt(routing));
          })
        )
      );
    })
  );
}
