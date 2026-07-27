export type RuntimeCancellationReason =
  | {
      readonly _tag: "RuntimeStopped";
      readonly detail?: string | undefined;
    }
  | {
      readonly _tag: "Evicted";
      readonly detail?: string | undefined;
    }
  | {
      readonly _tag: "Released";
      readonly detail?: string | undefined;
    }
  | {
      readonly _tag: "ArgsSuperseded";
      readonly detail?: string | undefined;
    }
  | {
      readonly _tag: "TimedOut";
      readonly detail?: string | undefined;
    }
  | {
      readonly _tag: "Interrupted";
      readonly detail?: string | undefined;
    };

export function runtimeCancellationDetail(
  reason: RuntimeCancellationReason | undefined
): string | undefined {
  return reason?.detail;
}

/** Shared constructor for the timeout cancellation carried by abort signals. */
export function timedOutCancellation(timeout: number): RuntimeCancellationReason {
  return {
    _tag: "TimedOut",
    detail: `${timeout}ms`,
  };
}

/** Shared constructor for the interruption cancellation carried by abort signals. */
export function interruptedCancellation(detail: string): RuntimeCancellationReason {
  return {
    _tag: "Interrupted",
    detail,
  };
}
