import { Effect } from "effect";
import { isObservableObject, runInAction } from "mobx";
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
  ResultPatchOptions,
} from "../../driver/types";
import { containsCommittedPlainData } from "../../node/resultData";
import { stageResultDraft } from "../../node/resultDraft";
import type { RuntimeSignalAccess } from "../../signals";
import type { GraphNodeCell } from "../cell/cellModel";
import {
  commitResultState,
  type ResultCommitDefaultValidity,
  type ResultState,
  resultValidityInvariantFailure,
  validateResultValidity,
} from "../resultValidity";
import { DriverPromiseFailed, GraphInvariantViolation, type ResultCommit } from "../types";
import { isPlainObject } from "./patchResultClone";

export function makeDriverContext<TDeps extends object>(input: {
  readonly cell: GraphNodeCell;
  readonly node: object;
  readonly args: unknown;
  readonly deps: TDeps;
  readonly abortController: AbortController;
  readonly nodeSignal: AbortSignal;
  readonly disposers: DisposerBag;
  readonly signals: RuntimeSignalAccess;
  readonly refreshDep: <K extends keyof TDeps & string>(
    dependencyName: K
  ) => Effect.Effect<TDeps[K], unknown>;
  readonly refreshDepPromise: <K extends keyof TDeps & string>(
    dependencyName: K
  ) => Promise<TDeps[K]>;
  readonly getCurrentResultState: () => ResultState;
  readonly setCurrentResultState: (next: ResultState) => void;
  readonly now: () => number;
  readonly setResultDefaultValidity?: ResultCommitDefaultValidity | undefined;
  readonly cloneResultOnPatch?: boolean | undefined;
  readonly resultPatch?: ResultPatchOptions | undefined;
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
      refreshDep: input.refreshDepPromise,
    },
  };
}

export function makeAcquireDriverContext<TDeps extends object>(input: {
  readonly cell: GraphNodeCell;
  readonly args: unknown;
  readonly deps: TDeps;
  readonly abortController: AbortController;
  // Contract: `abortController` is operation-scoped, `nodeSignal` spans the
  // ready-node incarnation. See the ctx docs on DriverAcquireContext.
  readonly nodeSignal: AbortSignal;
  readonly disposers: DisposerBag;
  readonly signals: RuntimeSignalAccess;
  readonly getCurrentResultState: () => ResultState;
  readonly setCurrentResultState: (next: ResultState) => void;
  readonly now: () => number;
  readonly setResultDefaultValidity?: ResultCommitDefaultValidity | undefined;
  readonly cloneResultOnPatch?: boolean | undefined;
  readonly resultPatch?: ResultPatchOptions | undefined;
}): NormalizedAcquireDriverContext<unknown, TDeps, unknown> {
  const setResult = (
    next: unknown | ResultCommit<unknown> | ((current: unknown) => unknown | ResultCommit<unknown>)
  ): void => {
    const current = input.getCurrentResultState();
    const drafted =
      typeof next === "function" &&
      (input.cloneResultOnPatch === true || containsCommittedPlainData(current.result))
        ? stageResultDraft(
            current.result,
            (value) => next(value),
            true,
            input.resultPatch,
            input.cell
          )
        : undefined;
    const nextValue =
      drafted === undefined
        ? typeof next === "function"
          ? next(current.result)
          : next
        : drafted.value;
    // Contract: result commits are stamped with the clock at commit time, not
    // at operation start. A slow driver must not commit a backdated loadedAt.
    const now = input.now();
    const staged = commitResultState(nextValue, current, input.cell.resultValidityPolicy, now, {
      context: input.cell,
      defaultLoadedAt: now,
      defaultValidity: input.setResultDefaultValidity ?? "current",
    });
    input.setCurrentResultState({
      ...staged,
      resultPatched: drafted === undefined ? staged.resultPatched : true,
    });
  };
  const setResultValidity = (validity: unknown): void => {
    const current = input.getCurrentResultState();
    input.setCurrentResultState({
      result: current.result,
      resultLoadedAt: current.resultLoadedAt,
      resultValidity: validateResultValidity(validity, input.cell),
      resultValidityCommit: "explicit",
      resultWritten: current.resultWritten,
      resultPatched: current.resultPatched,
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

    if (input.cloneResultOnPatch === true || containsCommittedPlainData(current)) {
      const staged = input.getCurrentResultState();
      const drafted = stageResultDraft(current, recipe, false, input.resultPatch, input.cell);
      input.setCurrentResultState({
        ...staged,
        result: drafted.value,
        resultWritten: true,
        resultPatched: true,
      });
      return;
    }
    assertPatchableResult(current, input.resultPatch, input.cell);
    const state = input.getCurrentResultState();
    input.setCurrentResultState({ ...state, resultWritten: true, resultPatched: true });

    // A shared observable result is mutated in place; an action keeps MobX
    // strict mode quiet and batches the writes into one reaction.
    const staged = input.getCurrentResultState().result;
    runInAction(() => recipe(staged));
  };

  const effectContext: DriverAcquireContext<unknown, TDeps, unknown> = {
    args: input.args,
    deps: input.deps,
    signal: input.abortController.signal,
    nodeSignal: input.nodeSignal,
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
    nodeSignal: input.nodeSignal,
    disposers: input.disposers,
    signals: bridgeAsyncDriverSignals(input.signals),
    setResult,
    setResultValidity,
    patchResult,
  };

  return { effect: effectContext, async: asyncContext };
}

function assertPatchableResult(
  value: unknown,
  options: ResultPatchOptions | undefined,
  context: GraphNodeCell
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }

  // Same classification as the clone path: a MobX observable is non-plain
  // even when its proxy reports a plain prototype.
  if (isPlainObject(value) && !isObservableObject(value)) {
    return;
  }

  if (options?.nonPlainClone !== undefined) {
    return;
  }

  throw new GraphInvariantViolation({
    nodeId: context.nodeId,
    tag: context.tag,
    invariant: "driver patchResult requires resultPatch.nonPlainClone for non-plain result values",
    cause: { constructorName: value.constructor?.name },
  });
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
