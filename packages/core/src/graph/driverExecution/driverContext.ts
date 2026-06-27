import { Effect } from "effect";
import type {
  AsyncAcquireDriverContext,
  AsyncDisposeContext,
  DisposeContext,
  DisposerBag,
  DriverAcquireContext,
  LiveResourceStopReason,
} from "../../driver";
import { bridgeAsyncDriverSignals } from "../../driver/asyncSignalBridge";
import type {
  NormalizedAcquireDriverContext,
  NormalizedDisposeContext,
  NormalizedDriverContext,
  NormalizedLiveContext,
  NormalizedLiveStopContext,
} from "../../driver/types";
import type { RuntimeSignalAccess } from "../../signals";
import type { GraphNodeCell } from "../planning/plan";
import {
  commitResultState,
  type ResultCommitDefaultValidity,
  type ResultState,
  resultValidityInvariantFailure,
  validateResultValidity,
} from "../resultValidity";
import { DriverPromiseFailed, GraphInvariantViolation, type ResultCommit } from "../types";

export function makeDriverContext<TDeps extends object>(input: {
  readonly cell: GraphNodeCell;
  readonly node: object;
  readonly args: unknown;
  readonly deps: TDeps;
  readonly abortController: AbortController;
  readonly disposers: DisposerBag;
  readonly signals: RuntimeSignalAccess;
  readonly refreshDep: <K extends keyof TDeps & string>(
    dependencyName: K
  ) => Effect.Effect<TDeps[K], unknown>;
  readonly getCurrentResultState: () => ResultState;
  readonly setCurrentResultState: (next: ResultState) => void;
  readonly now: () => number;
  readonly setResultDefaultValidity?: ResultCommitDefaultValidity | undefined;
  readonly cloneResultOnPatch?: boolean | undefined;
}): NormalizedDriverContext<object, unknown, TDeps, unknown> {
  const acquireContext = makeAcquireDriverContext(input);

  return {
    effect: {
      ...acquireContext.effect,
      node: input.node,
      refreshDep: input.refreshDep,
    },
    async: {
      ...acquireContext.async,
      node: input.node,
      refreshDep: (dependencyName) => Effect.runPromise(input.refreshDep(dependencyName)),
    },
  };
}

export function makeAcquireDriverContext<TDeps extends object>(input: {
  readonly cell: GraphNodeCell;
  readonly args: unknown;
  readonly deps: TDeps;
  readonly abortController: AbortController;
  readonly disposers: DisposerBag;
  readonly signals: RuntimeSignalAccess;
  readonly getCurrentResultState: () => ResultState;
  readonly setCurrentResultState: (next: ResultState) => void;
  readonly now: () => number;
  readonly setResultDefaultValidity?: ResultCommitDefaultValidity | undefined;
  readonly cloneResultOnPatch?: boolean | undefined;
}): NormalizedAcquireDriverContext<unknown, TDeps, unknown> {
  let resultClonedForPatch = false;
  const setResult = (
    next: unknown | ResultCommit<unknown> | ((current: unknown) => unknown | ResultCommit<unknown>)
  ): void => {
    const current = input.getCurrentResultState();
    const nextValue = typeof next === "function" ? next(current.result) : next;
    // Contract: result commits are stamped with the clock at commit time, not
    // at operation start. A slow driver must not commit a backdated loadedAt.
    const now = input.now();
    input.setCurrentResultState(
      commitResultState(nextValue, current, input.cell.resultValidityPolicy, now, {
        context: input.cell,
        defaultLoadedAt: now,
        defaultValidity: input.setResultDefaultValidity ?? "current",
      })
    );
  };
  const setResultValidity = (validity: unknown): void => {
    const current = input.getCurrentResultState();
    input.setCurrentResultState({
      ...current,
      resultValidity: validateResultValidity(validity, input.cell),
      resultValidityCommit: "explicit",
    });
  };
  const patchResult = (recipe: (current: unknown) => void): void => {
    const current = input.getCurrentResultState().result;

    if (current === undefined || current === null) {
      throw new GraphInvariantViolation({
        nodeId: input.cell.nodeId,
        tag: input.cell.tag,
        invariant: "driver patchResult requires an existing graph result",
        cause: { result: current },
      });
    }

    if (input.cloneResultOnPatch === true && !resultClonedForPatch) {
      input.setCurrentResultState({
        ...input.getCurrentResultState(),
        result: clonePatchableResult(current),
      });
      resultClonedForPatch = true;
    }

    recipe(input.getCurrentResultState().result);
  };

  const effectContext: DriverAcquireContext<unknown, TDeps, unknown> = {
    args: input.args,
    deps: input.deps,
    signal: input.abortController.signal,
    disposers: input.disposers,
    signals: input.signals,
    setResult: (next) =>
      Effect.try({
        try: () => setResult(next),
        catch: (cause) =>
          resultValidityInvariantFailure(input.cell, "driver setResult failed", cause),
      }),
    setResultValidity: (validity) =>
      Effect.try({
        try: () => setResultValidity(validity),
        catch: (cause) =>
          resultValidityInvariantFailure(input.cell, "driver setResultValidity failed", cause),
      }),
    patchResult: (recipe) =>
      Effect.try({
        try: () => patchResult(recipe),
        catch: (cause) =>
          new DriverPromiseFailed({
            nodeId: input.cell.nodeId,
            tag: input.cell.tag,
            operation: "patchResult",
            cause,
          }),
      }),
    tryPromise: (run) =>
      Effect.tryPromise({
        try: () => run(input.abortController.signal),
        catch: (cause) =>
          new DriverPromiseFailed({
            nodeId: input.cell.nodeId,
            tag: input.cell.tag,
            operation: "promise",
            cause,
          }),
      }),
  };

  const asyncContext: AsyncAcquireDriverContext<unknown, TDeps, unknown> = {
    args: input.args,
    deps: input.deps,
    signal: input.abortController.signal,
    disposers: input.disposers,
    signals: bridgeAsyncDriverSignals(input.signals),
    setResult,
    setResultValidity,
    patchResult,
  };

  return { effect: effectContext, async: asyncContext };
}

function clonePatchableResult(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => clonePatchableResult(entry));
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, clonePatchableResult(entry)])
    );
  }

  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);

  return prototype === Object.prototype || prototype === null;
}

export function makeDisposeContext(input: {
  readonly node: object;
  readonly abortController: AbortController;
  readonly disposers: DisposerBag;
}): NormalizedDisposeContext<object> {
  const context = makeSimpleDriverContext(input);

  return { effect: context, async: context };
}

export function makeLiveContext(input: {
  readonly node: object;
  readonly abortController: AbortController;
}): NormalizedLiveContext<object> {
  const context = {
    node: input.node,
    signal: input.abortController.signal,
  };

  return { effect: context, async: context };
}

export function makeLiveStopContext(input: {
  readonly node: object;
  readonly abortController: AbortController;
  readonly reason: LiveResourceStopReason;
}): NormalizedLiveStopContext<object> {
  const context = {
    node: input.node,
    signal: input.abortController.signal,
    reason: input.reason,
  };

  return { effect: context, async: context };
}

function makeSimpleDriverContext(input: {
  readonly node: object;
  readonly abortController: AbortController;
  readonly disposers: DisposerBag;
}): DisposeContext<object> & AsyncDisposeContext<object> {
  return {
    node: input.node,
    signal: input.abortController.signal,
    disposers: input.disposers,
  };
}
