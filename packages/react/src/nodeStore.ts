import type * as Frond from "@frondruntime/core";
import { getReactArgsFingerprint } from "./argsFingerprint";
import { FrondReactAdapterInvariant } from "./errors";
import { ReactRuntimeMetadata } from "./metadata";
import { projectReactNodeRead } from "./nodeReadProjection";
import { makeRevivableStoreSubscriptions } from "./storeSubscriptions";
import type { ReactNodeRuntime, ReactNodeSpec, ReactNodeState } from "./types";

export interface ReactNodeStore<
  TArgs extends Frond.Key.KeyInput,
  TDeps extends object,
  TResult,
  TNode extends object,
> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getVersion: () => number;
  readonly read: () => ReactNodeState<TArgs, TDeps, TResult, TNode>;
  readonly peek: () => Frond.Runtime.RuntimeNodeRead<TResult, TNode>;
  /**
   * Submits `args` when they differ from the last args this store submitted.
   * The first call is the reader's mount and also aligns a node holding other
   * args, unless `mount` is `false`.
   */
  readonly updateArgs: (
    args: TArgs,
    fingerprint?: string | undefined,
    mount?: boolean | undefined
  ) => Promise<void>;
  readonly dispose: () => void;
}

// The core's NodeBase keeps this runtime-owned count; a node without it
// reads undefined, which always compares equal.
type ResultPatchCounted = { readonly _resultPatchCount?: number | undefined };

// An args update a React store submitted and the runtime has not settled yet,
// per runtime and node. A mount alignment compares against the newest one
// instead of the stored args, since the stored args do not show it until it
// runs: the last mount in effect order wins. Updates made outside React are
// not tracked here. The store that submitted it writes `outcome` once, when it
// settles, so a store whose args matched it can tell what it left behind.
type SubmittedArgs = {
  readonly fingerprint: string;
  outcome: "Pending" | "Succeeded" | "Failed";
};
const submittedArgsByRuntime = new WeakMap<
  ReactNodeRuntime,
  Map<Frond.Graph.NodeId, SubmittedArgs>
>();

// How a reader's args compare with the latest args of its node.
type LatestArgs = "Settled" | "Unsettled" | "Different" | "Unknown";

type ReadinessAttempt = {
  readonly _tag: "Pending";
  readonly promise: Promise<void>;
  readonly presentation: "Unseen" | "PendingRead" | "ReadyGate";
  readonly settled: boolean;
};

export function makeReactNodeStore<
  TArgs extends Frond.Key.KeyInput,
  TDeps extends object,
  TResult,
  TNode extends object,
>(
  runtime: ReactNodeRuntime,
  request: {
    readonly spec: ReactNodeSpec<TArgs, TDeps, TResult, TNode>;
    readonly args: TArgs;
    readonly nodeId: Frond.Graph.NodeId;
    /** The fingerprint of `args`, when the caller already computed it. */
    readonly argsFingerprint?: string | undefined;
  },
  mode: "status" | "result" = "status"
): ReactNodeStore<TArgs, TDeps, TResult, TNode> {
  let readinessAttempt: ReadinessAttempt | undefined;
  let unsubscribe: (() => void) | undefined;
  let generation = 0;
  // The fingerprint of the args this store last submitted, or `undefined`
  // after a failed update, when the store does not know which args the node
  // holds.
  let argsFingerprint: string | undefined =
    request.argsFingerprint ?? getReactArgsFingerprint(request.args);
  // The first `updateArgs` call is the reader's first committed mount, unless
  // the caller says it is not. It is consumed once and never re-armed, so a
  // StrictMode or Activity replay does not push this reader's args back over a
  // later mount's.
  let mountAligned = false;
  // Counts this store's submissions. A failed update clears the slot only if
  // no later submission replaced it: an older request that fails after a
  // newer one was submitted says nothing about the args the newer one set.
  let submissionCount = 0;
  // After a failed update, the request this reader's args matched while it
  // still ran, and for an update from outside React its operation id. Its
  // outcome settles the slot on the next call: success makes its args the
  // slot, failure leaves the slot unknown. A submission of this store drops
  // it.
  let matchedRequest: SubmittedArgs | undefined;
  let matchedOperationId: number | undefined;
  // The ready node the matched operation ran on. A node acquired again after
  // an eviction is a new node object that numbers its operations from the
  // start, so only the same node object tells the matched operation and its
  // failure record from a later one that reuses its id.
  let matchedNode: object | undefined;
  // The store drives read/boot/subscribe/updateArgs, not the typed action
  // surface, so it uses the client through its loose entry.
  const handle = (
    runtime.client.node as unknown as (
      spec: unknown,
      args: unknown
    ) => Frond.Runtime.RuntimeNodeHandle<TArgs, TResult, Record<string, never>, "async", TNode>
  )(request.spec, request.args);

  const subscriptions = makeRevivableStoreSubscriptions({
    attach: () => {
      unsubscribe ??= handle.subscribe(() => {
        if (matchedOperationId !== undefined) {
          settleOutsideMatch();
        }
        sync();
      });
      sync();
    },
    detach: () => {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  });
  // Save accessor values separately: the ready node itself is mutable, so
  // retaining the previous read would lose changes to args/deps/result.
  let emittedTag: Frond.Runtime.RuntimeNodeRead<TResult, TNode>["_tag"] | undefined;
  let emittedNode: TNode | undefined;
  let emittedResult: unknown;
  let emittedDeps: unknown;
  let emittedArgs: unknown;
  let emittedResultPatchCount: number | undefined;
  let emittedErrorKind: Frond.Runtime.RuntimeReadFailureKind | undefined;
  let emittedError: unknown;
  const emit = (read?: Frond.Runtime.RuntimeNodeRead<TResult, TNode>): void => {
    if (mode === "status") {
      subscriptions.emit();
      return;
    }
    if (subscriptions.isDisposed()) {
      return;
    }

    const next = read ?? handle.read();
    let changed = next._tag !== emittedTag;
    switch (next._tag) {
      case "Ready": {
        // Every graph-constructed node has these accessors; TNode captures
        // only the author's additional instance surface in the handle type.
        const node = next.node as TNode & Frond.FrondNode<TArgs, object, TResult>;
        const result = node.result;
        const deps = node.deps;
        const args = node.args;
        // A shared-reference patchResult commit keeps `result`; the core's
        // patch count tells it apart from a status-only notification.
        const resultPatchCount = (node as ResultPatchCounted)._resultPatchCount;
        changed ||=
          next.node !== emittedNode ||
          !Object.is(result, emittedResult) ||
          resultPatchCount !== emittedResultPatchCount ||
          deps !== emittedDeps ||
          args !== emittedArgs;
        emittedNode = next.node;
        emittedResult = result;
        emittedResultPatchCount = resultPatchCount;
        emittedDeps = deps;
        emittedArgs = args;
        break;
      }
      case "Error":
        changed ||= next.kind !== emittedErrorKind || !Object.is(next.error, emittedError);
        emittedErrorKind = next.kind;
        emittedError = next.error;
        break;
      case "Unwired":
      case "Idle":
      case "Pending":
        break;
      default: {
        const unreachable: never = next;
        throw unreachable;
      }
    }
    emittedTag = next._tag;
    if (changed) {
      subscriptions.emit();
    }
  };
  const isDisposed = subscriptions.isDisposed;

  const scheduleReadinessAttempt = (
    attempt: Promise<unknown>,
    options: { readonly allowDisposed?: boolean | undefined } = {}
  ): void => {
    if (isDisposed() && options.allowDisposed !== true) {
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
      if (scheduledGeneration !== generation) {
        return;
      }

      if (readinessAttempt?.promise === nextReadiness) {
        readinessAttempt =
          readinessAttempt.presentation === "Unseen"
            ? { ...readinessAttempt, settled: true }
            : undefined;
      }

      if (!isDisposed()) {
        emit();
      }
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
  const scheduleBoot = (options: { readonly allowDisposed?: boolean | undefined } = {}): void => {
    if (isDisposed() && options.allowDisposed !== true) {
      return;
    }

    const read = handle.boot(ReactRuntimeMetadata.readiness());

    switch (read._tag) {
      case "Pending": {
        const { attempt } = read;
        scheduleReadinessAttempt(attempt, { allowDisposed: options.allowDisposed });
        break;
      }
      default:
        break;
    }
  };

  const scheduleBootForRead = (): void => {
    scheduleBoot({ allowDisposed: true });
  };

  const sync = (): void => {
    if (isDisposed()) {
      return;
    }

    const read = handle.read();
    switch (read._tag) {
      case "Unwired":
      case "Idle":
        scheduleBoot();
        break;
      case "Pending": {
        const { attempt } = read;
        scheduleReadinessAttempt(attempt);
        break;
      }
      default:
        break;
    }
    emit(read);
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
      scheduleBoot: scheduleBootForRead,
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
    handleRead: Frond.Runtime.RuntimeNodeRead<TResult, TNode>
  ): Promise<void> | undefined => {
    if (handleRead._tag !== "Ready") {
      return undefined;
    }

    if (readinessAttempt === undefined) {
      return undefined;
    }

    const { promise, presentation } = readinessAttempt;

    switch (presentation) {
      case "PendingRead":
        return undefined;
      case "Unseen": {
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
      }
      case "ReadyGate": {
        if (readinessAttempt?.settled === true) {
          readinessAttempt = undefined;
          return undefined;
        }

        return promise;
      }
      default: {
        const unreachable: never = presentation;
        return unreachable;
      }
    }
  };

  // Non-throwing counterpart to `read`. Unlike the Suspense/error-throwing
  // `read`, this drives the same cold-start boot but hands the raw runtime read
  // back so a caller can render Pending/Error states inline via `useNodeRead`.
  const peek = (): Frond.Runtime.RuntimeNodeRead<TResult, TNode> => {
    const handleRead = handle.read();

    if (handleRead._tag === "Unwired" || handleRead._tag === "Idle") {
      scheduleBoot();
    }

    return handleRead;
  };

  // Compares the reader's args with the node's latest args: those of a React
  // update still queued or in flight for the node, else the stored args.
  // `Unsettled` means they match args an update has not settled yet, which a
  // failure may still roll back. `Unknown` means there are no latest args: an
  // Unwired or Idle node boots with this store's own args, and a Pending one
  // is left alone.
  const compareWithLatestArgs = (nextArgs: TArgs, nextArgsFingerprint: string): LatestArgs => {
    const submitted = submittedArgsByRuntime.get(runtime)?.get(request.nodeId);
    if (submitted !== undefined) {
      return submitted.fingerprint === nextArgsFingerprint ? "Unsettled" : "Different";
    }
    const handleRead = handle.read();
    switch (handleRead._tag) {
      case "Ready": {
        const storedArgs = (handleRead.node as TNode & Frond.FrondNode<TArgs, object, TResult>)
          .args;
        if (
          storedArgs !== nextArgs &&
          getReactArgsFingerprint(storedArgs) !== nextArgsFingerprint
        ) {
          return "Different";
        }
        // An args update from outside React sets the node's args before its
        // refresh runs and puts them back if the refresh fails. No other
        // operation moves the args.
        return handleRead.operation._tag === "Running" && handleRead.operation.kind === "args"
          ? "Unsettled"
          : "Settled";
      }
      case "Unwired":
      case "Idle":
      case "Pending":
      case "Error":
        return "Unknown";
      default: {
        const unreachable: never = handleRead;
        throw unreachable;
      }
    }
  };

  // Records the request that is bringing the node to this reader's args: the
  // React submission for the node, else the args update running on it.
  const trackMatchedRequest = (fingerprint: string): void => {
    const submitted = submittedArgsByRuntime.get(runtime)?.get(request.nodeId);
    if (submitted !== undefined) {
      matchedRequest = submitted;
      matchedOperationId = undefined;
      matchedNode = undefined;
      return;
    }
    const handleRead = handle.read();
    switch (handleRead._tag) {
      case "Ready": {
        const operation = handleRead.operation;
        switch (operation._tag) {
          case "Running": {
            matchedRequest = { fingerprint, outcome: "Pending" };
            matchedOperationId = operation.operationId;
            matchedNode = handleRead.node;
            return;
          }
          case "Idle":
            return;
          default: {
            const unreachable: never = operation;
            throw unreachable;
          }
        }
      }
      case "Unwired":
      case "Idle":
      case "Pending":
      case "Error":
        return;
      default: {
        const unreachable: never = handleRead;
        throw unreachable;
      }
    }
  };

  // Whether the node still runs the matched operation from outside React.
  const runsMatchedOperation = (operation: Frond.Graph.NodeOperation): boolean => {
    switch (operation._tag) {
      case "Running":
        return operation.operationId === matchedOperationId;
      case "Idle":
        return false;
      default: {
        const unreachable: never = operation;
        throw unreachable;
      }
    }
  };

  // Settles a matched update from outside React once the node no longer runs
  // it. The failure record of that operation on the node it ran on, which an
  // eviction that cancels it also leaves, says it failed. Anything else counts
  // as success, also when a later update has moved the node on, replaced the
  // record, or run on the node acquired again: the reader's args did not
  // change, so it does not push them back over a newer writer's. A read with
  // no ready node cannot show which node a record belongs to, so it counts as
  // success too. Called when the node notifies, and on the reader's next call
  // when a hide stopped the notifications.
  const settleOutsideMatch = (): void => {
    const handleRead = handle.read();
    let failure: Frond.Graph.NodeOperationFailure | undefined;
    switch (handleRead._tag) {
      case "Ready": {
        if (handleRead.node !== matchedNode) {
          break;
        }
        if (runsMatchedOperation(handleRead.operation)) {
          return;
        }
        failure = handleRead.operationFailure;
        break;
      }
      case "Idle":
      case "Pending":
      case "Error":
      case "Unwired":
        break;
      default: {
        const unreachable: never = handleRead;
        throw unreachable;
      }
    }
    const operationId = matchedOperationId;
    matchedOperationId = undefined;
    matchedNode = undefined;
    if (matchedRequest === undefined) {
      return;
    }
    matchedRequest.outcome =
      failure !== undefined && failure.operationId === operationId && failure.kind === "args"
        ? "Failed"
        : "Succeeded";
  };

  // A matched request that succeeded leaves the node on this reader's args.
  const settleMatchedRequest = (matched: SubmittedArgs): void => {
    if (matchedOperationId !== undefined) {
      settleOutsideMatch();
    }
    switch (matched.outcome) {
      case "Pending":
        return;
      case "Succeeded": {
        if (argsFingerprint === undefined) {
          argsFingerprint = matched.fingerprint;
        }
        break;
      }
      case "Failed":
        break;
      default: {
        const unreachable: never = matched.outcome;
        throw unreachable;
      }
    }
    matchedRequest = undefined;
  };

  // A later submission for the node replaces this one and settles it itself.
  const settleSubmission = (
    submittedForRuntime: Map<Frond.Graph.NodeId, SubmittedArgs>,
    submission: SubmittedArgs
  ): void => {
    if (submittedForRuntime.get(request.nodeId) === submission) {
      submittedForRuntime.delete(request.nodeId);
    }
  };

  return {
    subscribe: subscriptions.subscribe,
    getVersion: subscriptions.getVersion,
    read,
    peek,
    updateArgs: async (nextArgs, precomputedFingerprint, mount) => {
      if (isDisposed()) {
        return;
      }

      if (matchedRequest !== undefined) {
        settleMatchedRequest(matchedRequest);
      }
      const nextArgsFingerprint = precomputedFingerprint ?? getReactArgsFingerprint(nextArgs);
      const firstMount = !mountAligned && mount !== false;
      mountAligned = true;

      // After a failed update the store does not know which args the node
      // holds, so it compares with the node's latest args. On the first mount,
      // a ready node that another request left on other args under the same
      // key takes this reader's args: the last mount wins. After that only a
      // change of this reader's own args reconciles, never a notification.
      if (
        argsFingerprint === undefined ||
        (firstMount && nextArgsFingerprint === argsFingerprint)
      ) {
        const latest = compareWithLatestArgs(nextArgs, nextArgsFingerprint);
        switch (latest) {
          case "Settled": {
            argsFingerprint = nextArgsFingerprint;
            matchedRequest = undefined;
            matchedOperationId = undefined;
            matchedNode = undefined;
            return;
          }
          // Another request is bringing the node to these args. The slot stays
          // as it was: this reader's own args on a first mount, unknown after a
          // failure until that request settles.
          case "Unsettled": {
            if (argsFingerprint === undefined) {
              trackMatchedRequest(nextArgsFingerprint);
            }
            return;
          }
          case "Unknown": {
            if (argsFingerprint !== undefined) {
              return;
            }
            break;
          }
          case "Different": {
            break;
          }
          default: {
            const unreachable: never = latest;
            throw unreachable;
          }
        }
      } else if (nextArgsFingerprint === argsFingerprint) {
        return;
      }

      argsFingerprint = nextArgsFingerprint;
      matchedRequest = undefined;
      matchedOperationId = undefined;
      matchedNode = undefined;
      const updateGeneration = generation;
      submissionCount += 1;
      const submissionNumber = submissionCount;
      let submittedForRuntime = submittedArgsByRuntime.get(runtime);
      if (submittedForRuntime === undefined) {
        submittedForRuntime = new Map();
        submittedArgsByRuntime.set(runtime, submittedForRuntime);
      }
      const submission: SubmittedArgs = { fingerprint: nextArgsFingerprint, outcome: "Pending" };
      submittedForRuntime.set(request.nodeId, submission);

      let result: Frond.Graph.UpdateNodeArgsResult;
      try {
        result = await handle.updateArgs(nextArgs, ReactRuntimeMetadata.argsUpdate());
      } catch {
        submission.outcome = "Failed";
        settleSubmission(submittedForRuntime, submission);
        if (submissionNumber === submissionCount) {
          argsFingerprint = undefined;
        }

        if (updateGeneration === generation) {
          sync();
        } else {
          emit();
        }

        return;
      }

      submission.outcome = result._tag === "Failure" ? "Failed" : "Succeeded";
      settleSubmission(submittedForRuntime, submission);

      // A failed update leaves the slot unknown, not on an earlier request that
      // may have failed too, nor on the node's args at this moment, which may
      // be those of another update still running. The next call compares with
      // the node.
      if (result._tag === "Failure" && submissionNumber === submissionCount) {
        argsFingerprint = undefined;
      }

      if (updateGeneration !== generation) {
        return;
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
