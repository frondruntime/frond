import type { Effect } from "effect";
import type { ResultValidityPolicy } from "../graph/types";
import { makeDriverActionRegistry, normalizeDriverHook } from "./capabilities";
import type {
  ActionContracts,
  Driver,
  DriverActionRegistry,
  DriverActionRun,
  DriverMode,
  NormalizedAcquireDriverContext,
  NormalizedDisposeContext,
  NormalizedDriverContext,
  NormalizedLiveResource,
  ResultCommit,
} from "./types";
import { FROND_DRIVER_ACTION_BRAND } from "./types";

export function buildNormalizedDriver<
  TNode extends object,
  TArgs,
  TDeps extends object,
  TResult,
  TActions extends ActionContracts,
  TActionMap extends object,
  TRelease,
  TRefresh,
  TLive,
  TAction,
>(input: {
  readonly mode: DriverMode;
  readonly resultValidity?: ResultValidityPolicy | undefined;
  readonly acquire: (
    ctx: NormalizedAcquireDriverContext<TArgs, TDeps, TResult>
  ) => Effect.Effect<TResult | ResultCommit<TResult>, unknown>;
  readonly release?: TRelease | undefined;
  readonly refresh?: TRefresh | undefined;
  readonly live?: TLive | undefined;
  readonly actions?: TActionMap | undefined;
  readonly normalizeRelease: (
    hook: TRelease
  ) => (ctx: NormalizedDisposeContext<TNode>) => Effect.Effect<void, unknown>;
  readonly normalizeRefresh: (
    hook: TRefresh
  ) => (ctx: NormalizedDriverContext<TNode, TArgs, TDeps, TResult>) => Effect.Effect<void, unknown>;
  readonly normalizeLive: (hook: TLive) => NormalizedLiveResource<TNode>;
  readonly normalizeAction: (action: TAction) => DriverActionRun<TNode, TArgs, TDeps, TResult>;
}): Driver<TNode, TArgs, TDeps, TResult, TActions> {
  return {
    _tag: "NormalizedDriver",
    mode: input.mode,
    resultValidity: input.resultValidity,
    acquire: input.acquire,
    release: normalizeDriverHook(input.release, input.normalizeRelease),
    refresh: normalizeDriverHook(input.refresh, input.normalizeRefresh),
    live: normalizeDriverHook(input.live, input.normalizeLive),
    actions: normalizeActions(input.actions, input.normalizeAction),
  };
}

function normalizeActions<TNode extends object, TArgs, TDeps extends object, TResult, TAction>(
  actions: object | undefined,
  normalize: (action: TAction) => DriverActionRun<TNode, TArgs, TDeps, TResult>
): DriverActionRegistry<TNode, TArgs, TDeps, TResult> {
  const normalized: Record<
    string,
    {
      readonly run: DriverActionRun<TNode, TArgs, TDeps, TResult>;
      readonly admission: import("./types").ActionAdmission;
    }
  > = {};
  const actionMap = actions as Readonly<Record<string, TAction | undefined>> | undefined;

  for (const key of Object.keys(actionMap ?? {})) {
    const action = actionMap?.[key];

    if (action !== undefined) {
      const descriptor = readActionDescriptor(action);
      normalized[key] = {
        run: normalize(action),
        admission: descriptor.admission,
      };
    }
  }

  return makeDriverActionRegistry(normalized);
}

function readActionDescriptor(action: unknown): {
  readonly admission: import("./types").ActionAdmission;
} {
  if (
    typeof action !== "object" ||
    action === null ||
    (action as { readonly [FROND_DRIVER_ACTION_BRAND]?: unknown })[FROND_DRIVER_ACTION_BRAND] !==
      true
  ) {
    return { admission: { policy: "queue" } };
  }

  return action as { readonly admission: import("./types").ActionAdmission };
}
