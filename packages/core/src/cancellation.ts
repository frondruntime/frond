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
