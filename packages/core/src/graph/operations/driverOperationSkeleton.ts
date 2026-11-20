import { type Context, Exit } from "effect";
import type { DriverRunResult } from "../../driver/types";
import { corePromise } from "../../runtime/promiseFacade";
import type { GraphNodeCell } from "../cell/cellModel";
import { phaseArgs, type ReadyData } from "../cell/cellPhase";
import { singleFailure } from "../driverExecution/causePolicy";
import { makeDriverContext } from "../driverExecution/driverContext";
import { startEdge } from "../driverExecution/driverOperationRunner";
import { cancelDriverOperation, notifyValidityThen } from "../driverExecution/driverOperationSteps";
import type { EffectBoundary } from "../driverExecution/effectBoundary";
import {
  makeOperationDisposers,
  type OperationDisposerSettleReason,
} from "../lifecycle/operationDisposers";
import { callbackEffect, type GraphCancel, type GraphResume, noCancel } from "../queue/reply";
import {
  commitDriverOperationResult,
  type DriverResultCommitOptions,
  type ResultState,
  resultValidityInvariantFailure,
} from "../resultValidity";
import type {
  DriverOperationTimeoutMs,
  ResultCommit,
  ResultValidity,
  ResultValidityChangedReason,
} from "../types";
import {
  collectDependencyValuesSync,
  type GraphOperationEnvironment,
  startRefreshDependency,
} from "./dependencies";
import { appendOperationDisposersSync, commitReadyOperationResultSync } from "./operationCommit";
import type { BackgroundOperationResult } from "./operationState";

type DriverContext = ReturnType<typeof makeDriverContext<Record<string, object>>>;
interface ReadyDriverOperation<TValue, TResult extends BackgroundOperationResult> {
  readonly env: GraphOperationEnvironment;
  readonly cell: GraphNodeCell;
  readonly phase: Parameters<typeof phaseArgs>[0];
  readonly readyData: ReadyData;
  readonly operation: string;
  readonly boundary: EffectBoundary;
  readonly timeout: DriverOperationTimeoutMs | "unbounded";
  readonly disposerReason: OperationDisposerSettleReason;
  readonly spanName: string;
  readonly spanAttributes: Record<string, unknown>;
  readonly setResultDefaultValidity?: DriverResultCommitOptions["defaultValidity"] | undefined;
  readonly commitInput: (input: {
    readonly value: TValue | ResultCommit<TValue>;
    readonly currentResultState: ResultState;
    readonly now: () => number;
  }) => DriverResultCommitOptions;
  readonly previousValidity: ResultValidity;
  readonly validityReason: ResultValidityChangedReason;
  readonly run: (ctx: DriverContext) => DriverRunResult<TValue | ResultCommit<TValue>>;
  readonly onDecided?: (() => void) | undefined;
  readonly makeFailure: (cause: unknown) => TResult;
  readonly makeSuccess: (input: {
    readonly value: TValue | ResultCommit<TValue>;
    readonly committedResultState: ResultState;
  }) => TResult;
}

export function startReadyDriverOperation<TValue, TResult extends BackgroundOperationResult>(
  input: ReadyDriverOperation<TValue, TResult>,
  context: Context.Context<never> | undefined,
  resume: GraphResume<TResult>
): GraphCancel {
  const deps = collectDependencyValuesSync(input.env, input.cell);
  if (deps._tag === "Failure") {
    resume(Exit.succeed(input.makeFailure(deps.failure)));
    return noCancel;
  }
  const abortController = new AbortController();
  const disposers = makeOperationDisposers(
    input.cell,
    input.env.state.notifyCleanupFailures,
    input.env.driverTimeouts.release,
    input.readyData.disposers
  );
  const now = input.cell.syncClock.now;
  let currentResultState: ResultState = {
    result: input.readyData.result,
    resultLoadedAt: input.readyData.resultLoadedAt,
    resultValidity: input.readyData.resultValidity,
    resultValidityCommit: "default",
  };
  const ctx = makeDriverContext({
    cell: input.cell,
    node: input.readyData.node,
    args: phaseArgs(input.phase),
    deps: deps.value,
    abortController,
    nodeSignal: input.readyData.nodeLifetime.signal,
    disposers,
    signals: input.env.signals,
    refreshDep: (name) =>
      callbackEffect((context, resume) =>
        startRefreshDependency(input.env, input.cell, name, context, resume)
      ),
    refreshDepPromise: (name) =>
      corePromise((resume) => startRefreshDependency(input.env, input.cell, name, context, resume)),
    now,
    getCurrentResultState: () => currentResultState,
    setCurrentResultState: (next) => {
      currentResultState = next;
    },
    setResultDefaultValidity: input.setResultDefaultValidity,
    cloneResultOnPatch: true,
    resultPatch: input.cell.descriptor.driver.resultPatch,
  });
  let canceled = false;
  let cancel = startEdge(
    {
      cell: input.cell,
      operation: input.operation,
      boundary: input.boundary,
      timeout: input.timeout,
      abortController,
      spanName: input.spanName,
      spanAttributes: input.spanAttributes,
      run: () => input.run(ctx),
      onDecided: input.onDecided,
    },
    context,
    (exit) => {
      if (canceled) return;
      const phase = input.cell.state.getSync().phase;
      if (
        input.phase._tag !== "Operating" ||
        phase._tag !== "Operating" ||
        phase.operation.operationId !== input.phase.operation.operationId
      )
        return;
      if (exit._tag === "Failure") {
        appendOperationDisposersSync(input.cell, disposers.take(input.disposerReason));
        resume(Exit.succeed(input.makeFailure(singleFailure(exit.cause))));
        return;
      }
      let committed: ResultState;
      try {
        committed = commitDriverOperationResult(
          input.cell.resultValidityPolicy,
          now(),
          input.commitInput({ value: exit.value, currentResultState, now })
        );
        commitReadyOperationResultSync({
          cell: input.cell,
          node: input.readyData.node,
          deps: deps.value,
          resultState: committed,
          operationDisposers: disposers.take(input.disposerReason),
        });
      } catch (cause) {
        appendOperationDisposersSync(input.cell, disposers.take(input.disposerReason));
        resume(
          Exit.succeed(
            input.makeFailure(
              resultValidityInvariantFailure(input.cell, "driver result commit failed", cause)
            )
          )
        );
        return;
      }
      const result = input.makeSuccess({ value: exit.value, committedResultState: committed });
      cancel =
        notifyValidityThen(
          input.cell,
          input.previousValidity,
          committed.resultValidity,
          input.validityReason,
          context,
          resume,
          Exit.succeed(result)
        ) ?? noCancel;
    }
  );
  return () => {
    canceled = true;
    return cancelDriverOperation(cancel, {
      cell: input.cell,
      abortController,
      disposers,
      notifyCleanupFailures: input.env.state.notifyCleanupFailures,
    });
  };
}
