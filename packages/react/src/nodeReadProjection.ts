import type { FrondNode, ResolvedDeps } from "@frondruntime/core";
import * as Frond from "@frondruntime/core";
import { attachErrorRecovery, type FrondReactErrorRecovery } from "./errorRecovery";
import type { ReactNodeState } from "./types";

export function projectReactNodeRead<
  TArgs,
  TDeps extends object,
  TResult,
  TNode extends object,
>(input: {
  readonly handle: Frond.Runtime.RuntimeNodeHandle<
    TArgs,
    TResult,
    Record<string, never>,
    "async",
    TNode
  >;
  readonly handleRead: Frond.Runtime.RuntimeNodeRead<TResult, TNode>;
  readonly ensureReady: () => Promise<void>;
  readonly scheduleBoot: () => void;
  readonly scheduleReadinessAttempt: (attempt: Promise<unknown>) => void;
  readonly currentReadinessPromise: () => Promise<void> | undefined;
  readonly markReadinessPresentedByPendingRead: () => void;
}): ReactNodeState<TArgs, TDeps, TResult, TNode> {
  const read = input.handleRead;
  switch (read._tag) {
    case "Ready": {
      const ready = read;
      return readyReactNodeState<TArgs, TDeps, TResult, TNode>(input.handle, ready);
    }
    case "Pending": {
      const pending = read;
      input.scheduleReadinessAttempt(pending.attempt);
      input.markReadinessPresentedByPendingRead();
      throw input.currentReadinessPromise() ?? pending.attempt;
    }
    case "Error": {
      const errorRead = read;
      const retryable = errorRead.kind === "readiness";
      // React receives the runtime read wrapper for control flow: it carries
      // retry metadata and preserves the full Frond cause chain. Reporting
      // boundaries must project it with `getErrorReport(...)` before sending it
      // to Sentry-like trackers, otherwise grouping falls back to the wrapper.
      throw runtimeReadError({
        message: runtimeReadErrorMessage(errorRead.kind),
        nodeId: errorRead.nodeId,
        kind: errorRead.kind,
        cause: errorRead.error,
        recovery: retryable
          ? {
              _tag: "FrondReactErrorRecovery",
              nodeId: errorRead.nodeId,
              reason: "readiness",
              resetKey: errorRead.nodeId,
              retry: input.ensureReady,
              retryable,
            }
          : undefined,
      });
    }
    case "Unwired":
    case "Idle":
      throw readinessPromise(input);
    default: {
      const unreachable: never = read;
      return unreachable;
    }
  }
}

function runtimeReadErrorMessage(kind: Frond.Runtime.RuntimeReadFailureKind): string {
  switch (kind) {
    case "readiness":
      return "Frond node readiness failed.";
    case "invalid":
      return "Frond node wiring is invalid.";
    case "runtime":
      return "Frond runtime is unavailable.";
    default: {
      const unreachable: never = kind;
      return unreachable;
    }
  }
}

function readyReactNodeState<TArgs, TDeps extends object, TResult, TNode extends object>(
  handle: Frond.Runtime.RuntimeNodeHandle<TArgs, TResult, Record<string, never>, "async", TNode>,
  read: Extract<Frond.Runtime.RuntimeNodeRead<TResult, TNode>, { readonly _tag: "Ready" }>
): ReactNodeState<TArgs, TDeps, TResult, TNode> {
  return {
    nodeId: handle.nodeId,
    // The read hands back the typed instance; the remaining cast asserts only
    // the FrondNode accessor surface every graph-constructed ready node has.
    node: read.node as TNode & FrondNode<TArgs, ResolvedDeps<TDeps>, TResult>,
    operation: read.operation,
    busy: read.busy,
    operationFailure: read.operationFailure,
    resultValidity: read.resultValidity,
  };
}

function readinessPromise(input: {
  readonly handle: Pick<Frond.Runtime.RuntimeNodeHandle<unknown, unknown>, "nodeId">;
  readonly scheduleBoot: () => void;
  readonly currentReadinessPromise: () => Promise<void> | undefined;
}): Promise<void> {
  const currentAttempt = input.currentReadinessPromise();

  if (currentAttempt !== undefined) {
    return currentAttempt;
  }

  input.scheduleBoot();
  const attempt = input.currentReadinessPromise();

  if (attempt === undefined) {
    throw new Frond.Runtime.FrondRuntimeReadError({
      message: "Frond node readiness boot did not produce a pending attempt.",
      kind: "runtime",
      nodeId: input.handle.nodeId,
      cause: "React readiness fallback failed to schedule boot.",
    });
  }

  return attempt;
}

function runtimeReadError(input: {
  readonly message: string;
  readonly nodeId: Frond.Graph.NodeId;
  readonly kind: "readiness" | "invalid" | "runtime";
  readonly cause: unknown;
  readonly recovery?: FrondReactErrorRecovery | undefined;
}): Frond.Runtime.FrondRuntimeReadError {
  const cause = input.cause;

  if (cause instanceof Frond.Runtime.FrondRuntimeReadError) {
    return input.recovery === undefined ? cause : attachErrorRecovery(cause, input.recovery);
  }

  const error = new Frond.Runtime.FrondRuntimeReadError(input);

  return input.recovery === undefined ? error : attachErrorRecovery(error, input.recovery);
}
