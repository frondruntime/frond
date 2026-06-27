import { Effect } from "effect";
import type { AsyncLiveResourceDescriptor } from "./liveDescriptor";
import { buildNormalizedDriver } from "./normalize";
import type {
  AsyncDriver,
  AsyncDriverActionContracts,
  AsyncDriverActionMap,
  AsyncDriverActionResult,
  AsyncDriverResult,
  AsyncDriverVoidResult,
  Driver,
  NormalizedLiveResource,
  ResultCommit,
} from "./types";

export class AsyncDriverHookFailed {
  readonly _tag = "AsyncDriverHookFailed";

  constructor(readonly cause: unknown) {}
}

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
    acquire: (ctx) => runAsyncResult(() => driver.acquire(ctx.async)),
    release: driver.release,
    refresh: driver.refresh,
    live: driver.live,
    actions: driver.actions,
    normalizeRelease: (release) => (ctx) => runAsyncVoid(() => release(ctx.async)),
    normalizeRefresh: (refresh) => (ctx) => runAsyncVoid(() => refresh(ctx.async)),
    normalizeLive: normalizeAsyncLiveResource,
    normalizeAction: (action) => (ctx, input) =>
      runAsyncAction(() => runAction(action, ctx.async, input)),
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
  const resource = {
    start: (ctx, demand) => runAsyncResource(() => live.start(ctx.async, demand)),
    stop: (ctx, resource, reason) =>
      runAsyncVoid(() => live.stop({ ...ctx.async, reason }, resource)),
  } satisfies NormalizedLiveResource<TNode>;

  return live.update === undefined
    ? resource
    : {
        ...resource,
        update: (ctx, liveResource, demand) =>
          runAsyncVoid(() => live.update?.(ctx.async, liveResource, demand)),
      };
}

// Single shared try/Promise-unwrap that all four runAsync* variants delegate to.
// The variants only differ in how the sync-return path is finalized, so they
// each pass an `onSync` callback that produces the final Effect.
function runAsync<TIn, TOut>(
  run: () => TIn | Promise<TIn> | undefined,
  onSync: (value: TIn | undefined) => Effect.Effect<TOut, AsyncDriverHookFailed>
): Effect.Effect<TOut, AsyncDriverHookFailed> {
  return Effect.try({
    try: run,
    catch: (cause) => new AsyncDriverHookFailed(cause),
  }).pipe(
    Effect.flatMap((result) =>
      isPromiseLike<TOut>(result)
        ? Effect.tryPromise({
            try: () => result,
            catch: (cause) => new AsyncDriverHookFailed(cause),
          })
        : onSync(result as TIn | undefined)
    )
  );
}

const succeedSync = <TOut>(value: unknown): Effect.Effect<TOut, AsyncDriverHookFailed> =>
  Effect.succeed(value as TOut);

const succeedVoid = (): Effect.Effect<void, AsyncDriverHookFailed> => Effect.void;

function runAsyncResult<TValue>(
  run: () => AsyncDriverResult<TValue> | undefined
): Effect.Effect<TValue | ResultCommit<TValue>, AsyncDriverHookFailed> {
  return runAsync<TValue | ResultCommit<TValue>, TValue | ResultCommit<TValue>>(
    run as () => TValue | ResultCommit<TValue> | Promise<TValue | ResultCommit<TValue>> | undefined,
    succeedSync
  );
}

function runAsyncResource<TValue>(
  run: () => TValue | Promise<TValue>
): Effect.Effect<TValue, AsyncDriverHookFailed> {
  return runAsync<TValue, TValue>(run, succeedSync);
}

function runAsyncVoid(
  run: () => AsyncDriverVoidResult | undefined
): Effect.Effect<void, AsyncDriverHookFailed> {
  return runAsync<void, void>(run as () => void | Promise<void> | undefined, succeedVoid);
}

function runAsyncAction<TValue>(
  run: () => AsyncDriverActionResult<TValue> | undefined
): Effect.Effect<TValue, AsyncDriverHookFailed> {
  return runAsync<TValue, TValue>(run as () => TValue | Promise<TValue> | undefined, succeedSync);
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

function isPromiseLike<TValue>(value: unknown): value is Promise<TValue> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}
