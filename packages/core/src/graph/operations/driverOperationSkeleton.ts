import { Clock, Effect } from "effect";
import type { GraphNodeCell } from "../cell/cellModel";
import type { ReadyData } from "../cell/cellPhase";
import { phaseArgs } from "../cell/cellPhase";
import { makeDriverContext } from "../driverExecution/driverContext";
import {
  recoverDriverOperationFailure,
  runTimedDriverOperation,
} from "../driverExecution/driverOperationRunner";
import type { EffectBoundary } from "../driverExecution/effectBoundary";
import {
  interruptDriverOperation,
  makeOperationDisposers,
  type OperationDisposerSettleReason,
} from "../lifecycle/operationDisposers";
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
import type { GraphOperationEnvironment } from "./dependencies";
import { collectDependencyValues, refreshDependencyValue } from "./dependencies";
import { appendOperationDisposers, commitReadyOperationResult } from "./operationCommit";
import type { BackgroundOperationResult } from "./operationState";

type DriverContext = ReturnType<typeof makeDriverContext<Record<string, object>>>;

export function runReadyDriverOperation<TValue, TResult extends BackgroundOperationResult>(input: {
  readonly env: GraphOperationEnvironment;
  readonly cell: GraphNodeCell;
  readonly phase: Parameters<typeof phaseArgs>[0];
  readonly readyData: ReadyData;
  readonly operation: string;
  readonly boundary: EffectBoundary;
  readonly timeout: DriverOperationTimeoutMs;
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
  readonly run: (ctx: DriverContext) => Effect.Effect<TValue | ResultCommit<TValue>, unknown>;
  readonly makeFailure: (cause: unknown) => TResult;
  readonly makeSuccess: (input: {
    readonly value: TValue | ResultCommit<TValue>;
    readonly committedResultState: ResultState;
  }) => TResult;
}): Effect.Effect<TResult> {
  return Effect.gen(function* () {
    const depsResult = yield* collectDependencyValues(input.env, input.cell).pipe(
      Effect.match({
        onFailure: (cause) => ({ _tag: "Failure", cause }) as const,
        onSuccess: (deps) => ({ _tag: "Success", deps }) as const,
      })
    );

    if (depsResult._tag === "Failure") {
      return input.makeFailure(depsResult.cause);
    }

    const abortController = new AbortController();
    // Same incarnation as the acquire that committed this ready data: the
    // operation bag shares the incarnation's registry so its drains dedupe
    // against disposers already run for this ready generation.
    const operationDisposers = makeOperationDisposers(
      input.cell,
      input.env.state.notifyCleanupFailures,
      input.env.driverTimeouts.release,
      input.readyData.disposers
    );
    const clock = yield* Clock.Clock;
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
      deps: depsResult.deps,
      abortController,
      // Same incarnation, same node-lifetime signal as the acquire that
      // committed this ready data; only the operation signal is fresh.
      nodeSignal: input.readyData.nodeLifetime.signal,
      disposers: operationDisposers,
      signals: input.env.signals,
      refreshDep: (dependencyName) => refreshDependencyValue(input.env, input.cell, dependencyName),
      now: () => clock.currentTimeMillisUnsafe(),
      getCurrentResultState: () => currentResultState,
      setCurrentResultState: (next) => {
        currentResultState = next;
      },
      setResultDefaultValidity: input.setResultDefaultValidity,
      cloneResultOnPatch: true,
      resultPatch: input.cell.descriptor.driver.resultPatch,
    });

    const appendDisposers = () =>
      appendOperationDisposers(input.cell, operationDisposers.take(input.disposerReason));

    return yield* recoverDriverOperationFailure(
      runTimedDriverOperation({
        cell: input.cell,
        operation: input.operation,
        boundary: input.boundary,
        timeout: input.timeout,
        abortController,
        spanName: input.spanName,
        spanAttributes: input.spanAttributes,
        run: () => input.run(ctx),
      }).pipe(
        Effect.matchEffect({
          onFailure: (cause) =>
            Effect.gen(function* () {
              yield* appendDisposers();
              return input.makeFailure(cause);
            }),
          onSuccess: (value) =>
            Effect.gen(function* () {
              const committedResultState = yield* Effect.try({
                try: () =>
                  commitDriverOperationResult(
                    input.cell.resultValidityPolicy,
                    clock.currentTimeMillisUnsafe(),
                    input.commitInput({
                      value,
                      currentResultState,
                      now: () => clock.currentTimeMillisUnsafe(),
                    })
                  ),
                catch: (cause) =>
                  resultValidityInvariantFailure(input.cell, "driver result commit failed", cause),
              });

              yield* commitReadyOperationResult({
                cell: input.cell,
                node: input.readyData.node,
                deps: depsResult.deps,
                resultState: committedResultState,
                previousValidity: input.previousValidity,
                validityReason: input.validityReason,
                operationDisposers: operationDisposers.take(input.disposerReason),
              });

              return input.makeSuccess({ value, committedResultState });
            }),
        }),
        Effect.onInterrupt(() =>
          interruptDriverOperation({
            cell: input.cell,
            abortController,
            disposers: operationDisposers,
            notifyCleanupFailures: input.env.state.notifyCleanupFailures,
          })
        )
      ),
      input.boundary,
      (cause) =>
        Effect.gen(function* () {
          yield* appendDisposers();
          return input.makeFailure(cause);
        })
    );
  });
}
