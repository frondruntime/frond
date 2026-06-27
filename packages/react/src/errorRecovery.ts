import type * as Frond from "@frondruntime/core";

const reactErrorRecoverySymbol = Symbol.for("frond.react.errorRecovery");

export type FrondReactErrorRecoveryReason = "readiness";

export interface FrondReactErrorRecovery {
  readonly _tag: "FrondReactErrorRecovery";
  readonly nodeId: Frond.Graph.NodeId;
  readonly reason: FrondReactErrorRecoveryReason;
  readonly retryable: true;
  readonly resetKey: string;
  readonly retry: () => Promise<unknown>;
}

/**
 * Reads Frond retry metadata attached to a React error-boundary error.
 */
export function getErrorRecovery(error: unknown): FrondReactErrorRecovery | undefined {
  if (typeof error !== "object" || error === null) {
    return undefined;
  }

  const recovery = Reflect.get(error, reactErrorRecoverySymbol);

  return isFrondReactErrorRecovery(recovery) ? recovery : undefined;
}

/**
 * Returns true when an error boundary can offer a Frond readiness retry.
 */
export function isRecoverableNodeError(error: unknown): boolean {
  return getErrorRecovery(error) !== undefined;
}

/**
 * Attaches non-enumerable recovery metadata to a React-thrown node error.
 */
export function attachErrorRecovery<TError extends Error>(
  error: TError,
  recovery: FrondReactErrorRecovery
): TError {
  try {
    Object.defineProperty(error, reactErrorRecoverySymbol, {
      configurable: true,
      enumerable: false,
      value: recovery,
      writable: false,
    });
  } catch {
    return error;
  }

  return error;
}

function isFrondReactErrorRecovery(value: unknown): value is FrondReactErrorRecovery {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as {
    readonly _tag?: unknown;
    readonly nodeId?: unknown;
    readonly reason?: unknown;
    readonly retryable?: unknown;
    readonly resetKey?: unknown;
    readonly retry?: unknown;
  };

  return (
    candidate._tag === "FrondReactErrorRecovery" &&
    typeof candidate.nodeId === "string" &&
    candidate.reason === "readiness" &&
    candidate.retryable === true &&
    typeof candidate.resetKey === "string" &&
    typeof candidate.retry === "function"
  );
}
