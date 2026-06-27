import type * as Frond from "@frondruntime/core";
import { Match } from "effect";
import { getReactArgsFingerprint } from "./argsFingerprint";
import { FrondReactAdapterInvariant } from "./errors";
import { ReactRuntimeMetadata } from "./metadata";
import { projectReactNodeRead } from "./nodeReadProjection";
import { makeRevivableStoreSubscriptions } from "./storeSubscriptions";
import type { ReactNodeRuntime, ReactNodeSpec, ReactNodeState } from "./types";

interface ReactNodeStore<TArgs, TDeps extends object, TResult, TNode extends object> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getVersion: () => number;
  readonly read: () => ReactNodeState<TArgs, TDeps, TResult, TNode>;
  readonly updateArgs: (args: TArgs) => Promise<void>;
  readonly dispose: () => void;
}

type ReadinessAttempt = {
  readonly _tag: "Pending";
  readonly promise: Promise<void>;
  readonly presentation: "Unseen" | "PendingRead" | "ReadyGate";
  readonly settled: boolean;
};

export function makeReactNodeStore<TArgs, TDeps extends object, TResult, TNode extends object>(
  runtime: ReactNodeRuntime,
  request: {
    readonly spec: ReactNodeSpec<TArgs, TDeps, TResult, TNode>;
    readonly args: TArgs;
    readonly nodeId: Frond.Graph.NodeId;
  }
): ReactNodeStore<TArgs, TDeps, TResult, TNode> {
  let readinessAttempt: ReadinessAttempt | undefined;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  let argsFingerprint = getReactArgsFingerprint(request.args);
  const handle = runtime.client.node<TArgs, TResult>(request.spec, request.args);

  const subscriptions = makeRevivableStoreSubscriptions({
    attach: () => {
      unsubscribe ??= handle.subscribe(() => {
        sync();
      });
    },
    detach: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  });
  const emit = subscriptions.emit;
  const isDisposed = subscriptions.isDisposed;

  const scheduleReadinessAttempt = (attempt: Promise<unknown>): void => {
    if (isDisposed()) {
      return;
    }

    if (readinessAttempt?._tag === "Pending") {
      return;
    }

    const nextReadiness: Promise<void> = attempt.then(
      () => {},
      () => {}
    );
    const scheduledGeneration = generation;
    readinessAttempt = {
      _tag: "Pending",
      promise: nextReadiness,
      presentation: "Unseen",
      settled: false,
    };
    void nextReadiness.finally(() => {
      if (isDisposed() || scheduledGeneration !== generation) {
        return;
      }

      if (readinessAttempt?.promise === nextReadiness) {
        readinessAttempt =
          readinessAttempt.presentation === "Unseen"
            ? { ...readinessAttempt, settled: true }
            : undefined;
      }
      emit();
    });
  };

  /*
   * React Suspense cold-start boundary.
   *
   * This call is deliberately more specific than a generic "read during render"
   * rule. `RuntimeNodeHandle.read()` is the observational product read: it is
   * synchronous, non-throwing, and must not schedule graph work. React cannot
   * use only that passive read for the initial cold path, because a component
   * that calls `useNode()` has to produce a Suspense promise on the same render
   * that discovers the node is not ready yet.
   *
   * `handle.boot(...)` is the named adapter-owned exception for that cold
   * Suspense path. It may schedule readiness only for Unwired/Idle nodes. It
   * does not retry readiness errors, it does not construct nodes in React, and
   * it does not make React the owner of lifecycle state. The graph/cell actor
   * still owns the current attempt, node construction, operation ordering,
   * cancellation, and duplicate acquire suppression.
   *
   * This matters under StrictMode and aborted renders. React may construct this
   * store more than once before a commit. Duplicate boots must therefore join
   * the same graph-owned readiness attempt instead of creating duplicate
   * driver acquires. The store keeps only an adapter-local wrapper promise so
   * Suspense and the ready gate can present one stable local promise while the
   * runtime remains the source of truth for the underlying attempt.
   *
   * Do not move this into an effect without redesigning Suspense startup. An
   * effect would run after commit, but a cold `useNode()` render needs to throw
   * before commit so the nearest Suspense boundary can own the loading state.
   */
  const scheduleBoot = (): void => {
    if (isDisposed()) {
      return;
    }

    const read = handle.boot(ReactRuntimeMetadata.readiness());

    Match.value(read).pipe(
      Match.tag("Pending", ({ attempt }) => {
        scheduleReadinessAttempt(attempt);
      }),
      Match.orElse(() => undefined)
    );
  };

  const sync = (): void => {
    if (isDisposed()) {
      return;
    }

    const read = handle.read();
    Match.value(read).pipe(
      Match.tag("Unwired", () => scheduleBoot()),
      Match.tag("Idle", () => scheduleBoot()),
      Match.tag("Pending", ({ attempt }) => {
        scheduleReadinessAttempt(attempt);
      }),
      Match.orElse(() => undefined)
    );
    emit();
  };

  scheduleBoot();
  sync();

  const ensureReady = (): Promise<void> => {
    const currentReadiness = currentReadinessPromise();

    if (currentReadiness !== undefined) {
      return currentReadiness;
    }

    // Error-recovery bindings captured by an error boundary can outlive this
    // store: the failed subtree unmounts and effect cleanup disposes it before
    // the user invokes retry. The adapter-local readiness slot is gone, so
    // hand the retry straight to the runtime attempt. Mirror the live path's
    // wrapper semantics: the returned promise settles when the attempt
    // settles and never rejects.
    if (isDisposed()) {
      return handle.ensureReady(ReactRuntimeMetadata.readiness()).then(
        () => undefined,
        () => undefined
      );
    }

    scheduleReadinessAttempt(handle.ensureReady(ReactRuntimeMetadata.readiness()));
    emit();

    const scheduledReadiness = currentReadinessPromise();

    if (scheduledReadiness === undefined) {
      throw new FrondReactAdapterInvariant({
        hook: "useNode",
        message: "Frond React node store failed to schedule readiness.",
      });
    }

    return scheduledReadiness;
  };

  const read = (): ReactNodeState<TArgs, TDeps, TResult, TNode> => {
    const handleRead = handle.read();

    const readyGate = readyGateSuspenseAttempt(handleRead);

    if (readyGate !== undefined) {
      throw readyGate;
    }

    return projectReactNodeRead<TArgs, TDeps, TResult, TNode>({
      handle,
      handleRead,
      ensureReady,
      scheduleBoot,
      scheduleReadinessAttempt,
      currentReadinessPromise,
      markReadinessPresentedByPendingRead,
    });
  };

  const currentReadinessPromise = (): Promise<void> | undefined =>
    readinessAttempt === undefined ? undefined : readinessAttempt.promise;

  const markReadinessPresentedByPendingRead = (): void => {
    if (readinessAttempt === undefined) {
      return;
    }

    readinessAttempt = {
      _tag: "Pending",
      promise: readinessAttempt.promise,
      presentation: "PendingRead",
      settled: readinessAttempt.settled,
    };
  };

  const readyGateSuspenseAttempt = (
    handleRead: Frond.Runtime.RuntimeNodeRead<TResult>
  ): Promise<void> | undefined => {
    if (handleRead._tag !== "Ready") {
      return undefined;
    }

    if (readinessAttempt === undefined) {
      return undefined;
    }

    const { promise, presentation } = readinessAttempt;

    return Match.value(presentation).pipe(
      Match.when("PendingRead", () => undefined),
      Match.when("Unseen", () => {
        if (readinessAttempt?.settled === true) {
          readinessAttempt = undefined;
          return promise;
        }

        readinessAttempt = {
          _tag: "Pending",
          promise,
          presentation: "ReadyGate",
          settled: false,
        };
        return promise;
      }),
      Match.when("ReadyGate", () => {
        if (readinessAttempt?.settled === true) {
          readinessAttempt = undefined;
          return undefined;
        }

        return promise;
      }),
      Match.exhaustive
    );
  };

  return {
    subscribe: subscriptions.subscribe,
    getVersion: subscriptions.getVersion,
    read,
    updateArgs: async (nextArgs) => {
      if (isDisposed()) {
        return;
      }

      const nextArgsFingerprint = getReactArgsFingerprint(nextArgs);

      if (nextArgsFingerprint === argsFingerprint) {
        return;
      }

      const previousArgsFingerprint = argsFingerprint;

      argsFingerprint = nextArgsFingerprint;
      const updateGeneration = generation;
      const result = await handle.updateArgs(nextArgs, ReactRuntimeMetadata.argsUpdate());

      if (isDisposed() || updateGeneration !== generation) {
        return;
      }

      // Only roll back if we still own the fingerprint slot. A later
      // updateArgs may have set a newer fingerprint while we were awaiting;
      // clobbering it with our stale `previous` would lose that user intent
      // and force a redundant re-dispatch on the next render.
      if (result._tag === "Failure" && argsFingerprint === nextArgsFingerprint) {
        argsFingerprint = previousArgsFingerprint;
      }

      sync();
    },
    dispose: () => {
      if (!subscriptions.dispose()) {
        return;
      }

      generation += 1;
      readinessAttempt = undefined;
    },
  };
}
