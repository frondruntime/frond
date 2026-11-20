import type { AsyncLiveResourceDescriptor } from "./liveDescriptor";
import { buildNormalizedDriver } from "./normalize";
import type {
  AsyncDriver,
  AsyncDriverActionContracts,
  AsyncDriverActionMap,
  AsyncDriverActionResult,
  Driver,
  NormalizedLiveResource,
} from "./types";

export function createAsyncDriver<
  TResult,
  TActions extends AsyncDriverActionMap<object, unknown, object, TResult>,
>(
  driver: AsyncDriver<object, unknown, object, TResult, TActions>
): Driver<object, unknown, object, TResult, AsyncDriverActionContracts<TActions>>;
export function createAsyncDriver<
  TNode extends object = object,
  TDeps extends object = object,
  TResult = unknown,
  TArgs = unknown,
  TActions extends AsyncDriverActionMap<TNode, TArgs, TDeps, TResult> = Record<string, never>,
>(
  driver: AsyncDriver<TNode, TArgs, TDeps, TResult, TActions>
): Driver<object, unknown, object, TResult, AsyncDriverActionContracts<TActions>>;
export function createAsyncDriver<
  TNode extends object = object,
  TDeps extends object = object,
  TResult = unknown,
  TArgs = unknown,
  TActions extends AsyncDriverActionMap<TNode, TArgs, TDeps, TResult> = Record<string, never>,
>(
  driver: AsyncDriver<TNode, TArgs, TDeps, TResult, TActions>
): Driver<object, unknown, object, TResult, AsyncDriverActionContracts<TActions>> {
  const normalized = buildNormalizedDriver<
    TNode,
    TArgs,
    TDeps,
    TResult,
    AsyncDriverActionContracts<TActions>,
    TActions,
    NonNullable<AsyncDriver<TNode, TArgs, TDeps, TResult, TActions>["release"]>,
    NonNullable<AsyncDriver<TNode, TArgs, TDeps, TResult, TActions>["refresh"]>,
    NonNullable<AsyncDriver<TNode, TArgs, TDeps, TResult, TActions>["live"]>,
    TActions[keyof TActions]
  >({
    mode: "async",
    resultValidity: driver.resultValidity,
    resultPatch: driver.resultPatch,
    acquire: (ctx) => driver.acquire(ctx.async),
    release: driver.release,
    refresh: driver.refresh,
    live: driver.live,
    actions: driver.actions,
    normalizeRelease: (release) => (ctx) => release(ctx.async),
    normalizeRefresh: (refresh) => (ctx) => refresh(ctx.async),
    normalizeLive: normalizeAsyncLiveResource,
    normalizeAction: (action) => (ctx, input) => runAction(action, ctx.async, input),
  });

  return normalized as unknown as Driver<
    object,
    unknown,
    object,
    TResult,
    AsyncDriverActionContracts<TActions>
  >;
}

function normalizeAsyncLiveResource<TNode extends object>(
  live: AsyncLiveResourceDescriptor<TNode, unknown>
): NormalizedLiveResource<TNode> {
  const resource: NormalizedLiveResource<TNode> = {
    start: (ctx, demand) => live.start(ctx.async, demand),
    stop: (ctx, resource) => live.stop(ctx.async, resource),
  };
  if (live.update === undefined) return resource;
  return {
    start: resource.start,
    stop: resource.stop,
    update: (ctx, value, demand) => live.update?.(ctx.async, value, demand),
  };
}

function runAction<TAction>(
  action: TAction,
  ctx: unknown,
  input: unknown
): AsyncDriverActionResult<unknown> | undefined {
  const run =
    typeof action === "object" &&
    action !== null &&
    "run" in action &&
    typeof (action as { readonly run?: unknown }).run === "function"
      ? (
          action as {
            readonly run: (
              ctx: unknown,
              input: unknown
            ) => AsyncDriverActionResult<unknown> | undefined;
          }
        ).run
      : (action as (ctx: unknown, input: unknown) => AsyncDriverActionResult<unknown> | undefined);

  return run(ctx, input);
}
