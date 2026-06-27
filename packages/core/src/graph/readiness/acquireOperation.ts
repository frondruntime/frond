import { Cause, Clock, Effect } from "effect";
import {
  type CellReadinessAttempt,
  phaseBase,
  phaseLiveLeases,
  phaseReadyData,
  projectLiveDemand,
} from "../cell/cellPhase";
import { completeAcquireState } from "../cell/cellTransitions";
import { makeAcquireDriverContext } from "../driverExecution/driverContext";
import { runTimedDriverOperation } from "../driverExecution/driverOperationRunner";
import {
  effectBoundaryFailed,
  effectCauseHasOnlyExpectedFailures,
} from "../driverExecution/effectBoundary";
import { bridgeNodeActionRunner } from "../driverExecution/nodeActionBridge";
import {
  interruptDriverOperation,
  makeOperationDisposers,
  type OperationDisposers,
} from "../lifecycle/operationDisposers";
import { deliverLiveDemand } from "../liveness";
import { makeResultObservedReporter } from "../liveness/resultObservationBridge";
import type { GraphOperationEnvironment } from "../operations/dependencies";
import { constructReadyNode } from "../planning/nodeMaterialization";
import type { GraphNodeCell } from "../planning/plan";
import {
  commitResultState,
  type ResultState,
  resultValidityInvariantFailure,
  validityChanged,
} from "../resultValidity";
import {
  AcquireFailed,
  GraphInvariantViolation,
  type GraphLiveFailureObserver,
  type NodeRead,
  ResultExpired,
  type ResultValidity,
} from "../types";
import { completeAttempt, failAttempt } from "./readinessAttempt";

export function runAcquire(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  deps: Record<string, object>,
  attempt: CellReadinessAttempt
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const abortController = new AbortController();
    const disposers = makeOperationDisposers(cell, env.state.notifyCleanupFailures);
    const initialState = yield* cell.state.get;
    const base = phaseBase(initialState.phase);

    if (base._tag === "Missing") {
      return yield* failAttempt(
        cell,
        attempt,
        new AcquireFailed({
          nodeId: cell.nodeId,
          tag: cell.tag,
          cause: new GraphInvariantViolation({
            nodeId: cell.nodeId,
            tag: cell.tag,
            invariant: "acquire requires retained graph args",
          }),
        })
      );
    }

    const clock = yield* Clock.Clock;
    const startedAt = clock.currentTimeMillisUnsafe();
    let currentResultState: ResultState = commitResultState(
      undefined,
      undefined,
      cell.resultValidityPolicy,
      startedAt,
      { context: cell, defaultLoadedAt: startedAt }
    );

    // Contract: acquire has no ready node instance. It can use args, ready deps,
    // signals, disposers, and result helpers; author-node construction happens
    // only after a valid result is committed. Args come from the live phase
    // base captured at attempt start, not the original planning request, so a
    // re-acquire after a same-identity args update sees the updated args.
    const ctx = makeAcquireDriverContext({
      cell,
      args: base.base.args,
      deps,
      abortController,
      disposers,
      signals: env.signals,
      now: () => clock.currentTimeMillisUnsafe(),
      getCurrentResultState: () => currentResultState,
      setCurrentResultState: (next) => {
        currentResultState = next;
      },
    });

    return yield* runTimedDriverOperation({
      cell,
      operation: "acquire",
      boundary: "readiness-acquire",
      timeout: env.driverTimeouts.acquire,
      abortController,
      spanName: "frond.graph.acquire",
      spanAttributes: {
        ...env.runtimeSpanAttributes,
        "frond.node.id": cell.nodeId,
        "frond.node.tag": cell.tag,
        "frond.node.attempt_id": attempt.attemptId,
        "frond.driver.mode": cell.descriptor.driver.mode,
      },
      run: () => cell.descriptor.driver.acquire(ctx),
    }).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cleanupAcquireDisposers(env, cell, disposers).pipe(
            Effect.flatMap(() => failAcquireFailure(cell, attempt, cause))
          ),
        onSuccess: (acquired) =>
          // Contract: validity is evaluated against the clock at commit time.
          // An acquire slower than expireAfter must not commit a backdated
          // loadedAt that is already expired on the next read.
          commitResultStateEffect(
            cell,
            acquired,
            currentResultState,
            clock.currentTimeMillisUnsafe()
          ).pipe(
            Effect.flatMap((resultState) => {
              if (resultState.resultValidity._tag === "Expired") {
                const expiredValidity = resultState.resultValidity;

                return cleanupAcquireDisposers(env, cell, disposers).pipe(
                  Effect.flatMap(() => failExpiredAcquireResult(cell, attempt, expiredValidity))
                );
              }

              return constructAndCompleteAcquireSuccess(
                env,
                cell,
                attempt,
                deps,
                resultState,
                disposers
              );
            }),
            Effect.catchCause((cause) =>
              cleanupAcquireDisposers(env, cell, disposers).pipe(
                Effect.flatMap(() => failAcquireCause(cell, attempt, cause))
              )
            )
          ),
      }),
      Effect.onInterrupt(() =>
        interruptDriverOperation({
          cell,
          abortController,
          disposers,
          notifyCleanupFailures: env.state.notifyCleanupFailures,
        })
      )
    );
  });
}

function failAcquireFailure(
  cell: GraphNodeCell,
  attempt: CellReadinessAttempt,
  cause: unknown
): Effect.Effect<NodeRead> {
  return failAttempt(
    cell,
    attempt,
    cause instanceof AcquireFailed
      ? cause
      : new AcquireFailed({ nodeId: cell.nodeId, tag: cell.tag, cause })
  );
}

function commitResultStateEffect(
  cell: GraphNodeCell,
  next: unknown,
  current: ResultState,
  now: number
): Effect.Effect<ResultState, unknown> {
  return Effect.try({
    try: () =>
      commitResultState(next, current, cell.resultValidityPolicy, now, {
        context: cell,
        defaultLoadedAt: now,
      }),
    catch: (cause) => resultValidityInvariantFailure(cell, "driver result commit failed", cause),
  });
}

function failAcquireCause(
  cell: GraphNodeCell,
  attempt: CellReadinessAttempt,
  cause: Cause.Cause<unknown>
): Effect.Effect<NodeRead> {
  const primaryCause = Cause.squash(cause);

  if (effectCauseHasOnlyExpectedFailures(cause)) {
    return failAttempt(
      cell,
      attempt,
      primaryCause instanceof AcquireFailed
        ? primaryCause
        : new AcquireFailed({ nodeId: cell.nodeId, tag: cell.tag, cause: primaryCause })
    );
  }

  return failAttempt(
    cell,
    attempt,
    new AcquireFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      cause: effectBoundaryFailed("readiness-acquire", cause),
    })
  );
}

function completeAcquireSuccess(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  attempt: CellReadinessAttempt,
  node: object,
  deps: Record<string, object>,
  resultState: ResultState,
  disposers: OperationDisposers,
  liveTimeout: number,
  notifyLiveFailures: GraphLiveFailureObserver,
  reason: "acquire" = "acquire"
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const status = { _tag: "Wired", run: { _tag: "Ready" } } as const;
    const latest = yield* cell.state.get;
    const base = phaseBase(latest.phase);

    if (base._tag === "Missing") {
      return yield* cleanupAcquireDisposers(env, cell, disposers).pipe(
        Effect.flatMap(() =>
          failAttempt(
            cell,
            attempt,
            new AcquireFailed({
              nodeId: cell.nodeId,
              tag: cell.tag,
              cause: new GraphInvariantViolation({
                nodeId: cell.nodeId,
                tag: cell.tag,
                invariant: "acquire success requires retained graph-owned node args",
                cause: { phase: base.phase },
              }),
            })
          )
        )
      );
    }

    const args = base.base.args;
    const previousReady = phaseReadyData(latest.phase);
    const previousValidity =
      previousReady._tag === "Found"
        ? previousReady.ready.resultValidity
        : base.base.resultValidity;

    yield* cell.state.transition((latest) => [
      undefined,
      completeAcquireState({
        latest,
        ready: {
          node,
          args,
          deps,
          resultState,
          resultValidityPolicy: cell.resultValidityPolicy,
          // Ownership: the live collected array transfers to ready data, so
          // disposers added after the ready commit keep accumulating into the
          // node's disposer set until teardown. The hand-off also makes a
          // post-commit interrupt drain a no-op so the committed node keeps
          // its disposers.
          disposers: disposers.handOff(),
        },
      }),
    ]);
    yield* cell.notifyChanged(cell.nodeId);
    if (
      previousValidity !== undefined &&
      validityChanged(previousValidity, resultState.resultValidity)
    ) {
      yield* cell.notifyResultValidityChanged(
        cell.nodeId,
        previousValidity,
        resultState.resultValidity,
        reason
      );
    }
    const liveFailures = yield* deliverLiveDemand(
      cell,
      projectLiveDemand(phaseLiveLeases(latest.phase)),
      liveTimeout
    );

    if (liveFailures.length > 0) {
      yield* notifyLiveFailures(cell.nodeId, liveFailures);
      yield* cell.notifyChanged(cell.nodeId);
    }

    const handle = {
      _tag: "Ready",
      nodeId: cell.nodeId,
      tag: cell.tag,
      status,
      node,
      resultValidity: resultState.resultValidity,
    } satisfies NodeRead;
    yield* completeAttempt(attempt, handle);
    return handle;
  });
}

function constructAndCompleteAcquireSuccess(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  attempt: CellReadinessAttempt,
  deps: Record<string, object>,
  resultState: ResultState,
  disposers: OperationDisposers
): Effect.Effect<NodeRead> {
  return Effect.gen(function* () {
    const latest = yield* cell.state.get;
    const base = phaseBase(latest.phase);

    if (base._tag === "Missing") {
      return yield* cleanupAcquireDisposers(env, cell, disposers).pipe(
        Effect.flatMap(() =>
          failAttempt(
            cell,
            attempt,
            new AcquireFailed({
              nodeId: cell.nodeId,
              tag: cell.tag,
              cause: new GraphInvariantViolation({
                nodeId: cell.nodeId,
                tag: cell.tag,
                invariant: "acquire success requires retained graph args",
                cause: { phase: base.phase },
              }),
            })
          )
        )
      );
    }

    // Boundary: this is the graph-owned construction point for ready author
    // nodes. Constructor failures are readiness failures, not planning failures.
    const constructed = constructReadyNode(cell.request, {
      nodeId: cell.nodeId,
      tag: cell.tag,
      construction: {
        nodeId: cell.nodeId,
        tag: cell.tag,
        args: base.base.args,
        deps,
        result: resultState.result,
        action: bridgeNodeActionRunner(env.state.executeNodeAction, cell.nodeId),
        reportResultObserved: makeResultObservedReporter(env.state, {
          nodeId: cell.nodeId,
          tag: cell.tag,
        }),
        addDisposer: (disposer) => {
          disposers.add(disposer);
        },
      },
    });

    if (constructed._tag === "Failure") {
      yield* cleanupAcquireDisposers(env, cell, disposers);
      return yield* failAcquireFailure(cell, attempt, constructed.failure);
    }

    return yield* completeAcquireSuccess(
      env,
      cell,
      attempt,
      constructed.value,
      deps,
      resultState,
      disposers,
      env.driverTimeouts.live,
      env.state.notifyLiveFailures
    );
  });
}

function failExpiredAcquireResult(
  cell: GraphNodeCell,
  attempt: CellReadinessAttempt,
  resultValidity: Extract<ResultValidity, { readonly _tag: "Expired" }>
): Effect.Effect<NodeRead> {
  return failAttempt(
    cell,
    attempt,
    new AcquireFailed({
      nodeId: cell.nodeId,
      tag: cell.tag,
      cause: new ResultExpired({
        nodeId: cell.nodeId,
        tag: cell.tag,
        resultValidity,
      }),
    }),
    resultValidity
  );
}

function cleanupAcquireDisposers(
  env: GraphOperationEnvironment,
  cell: GraphNodeCell,
  disposers: OperationDisposers
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const failures = yield* disposers.drain("acquire");

    if (failures.length > 0) {
      yield* env.state.notifyCleanupFailures(cell.nodeId, "acquire", failures);
    }
  });
}
