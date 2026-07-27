import { FrondRuntimeInvariantViolation } from "./errors";
import type { RuntimeId } from "./types";

export type { RuntimeCancellationReason } from "../cancellation";

export type RuntimeWorkSource =
  | "react"
  | "mobx"
  | "node"
  | "manual"
  | "devtools"
  | "runtime"
  | "signal"
  | "test";

export type RuntimeWorkReason =
  | "start"
  | "stop"
  | "readiness"
  | "retry"
  | "preload"
  | "refresh"
  | "action"
  | "args-update"
  | "live"
  | "release"
  | "eviction"
  | "unsafe-update"
  | "input"
  | "signal";

export type RuntimeWorkPriority = "blocking" | "visible" | "background" | "idle";

export type RuntimeWorkId = number & { readonly __brand: "Runtime.WorkId" };

export type RuntimeWorkMetadata = {
  readonly source?: RuntimeWorkSource | undefined;
  readonly reason?: RuntimeWorkReason | undefined;
  readonly priority?: RuntimeWorkPriority | undefined;
  /**
   * Caller-cancellation `AbortSignal` (unrelated to the `"signal"` work
   * source/reason, which name runtime pub/sub signals).
   *
   * Honored today by `handle.action` only; other metadata-bearing surfaces
   * ignore it. When the signal fires, the submission is interrupted exactly as
   * if the caller's Effect fiber were interrupted: queued work settles without
   * invoking the driver, active single-owner work aborts its operation
   * `ctx.signal`, and join-admission work keeps running for its other awaiters
   * (the leaving caller just stops waiting). An already-aborted signal settles
   * as interruption without submitting at all.
   *
   * The cancelled call settles with Effect interruption, so a Promise caller
   * going through `unwrapEffect` sees a rejection carrying the interrupted
   * `Cause` — the same convention as any other interruption.
   */
  readonly signal?: AbortSignal | undefined;
};

export type RuntimeWorkContext = {
  readonly runtimeId: RuntimeId;
  readonly workId: RuntimeWorkId;
  readonly source: RuntimeWorkSource;
  readonly reason: RuntimeWorkReason;
  readonly priority: RuntimeWorkPriority;
  readonly parentWorkId?: RuntimeWorkId | undefined;
};

function runtimeWorkId(value: number): RuntimeWorkId {
  return value as RuntimeWorkId;
}

export function makeRuntimeWorkFactory(runtimeId: RuntimeId): {
  readonly defaultWork: RuntimeWorkContext;
  readonly nextWork: (
    metadata: RuntimeWorkMetadata | undefined,
    defaults: RuntimeWorkDefaults,
    parentWorkId?: RuntimeWorkId | undefined
  ) => RuntimeWorkContext;
} {
  let nextWorkId = 0;
  const allocateWorkId = (): RuntimeWorkId => {
    nextWorkId += 1;
    return runtimeWorkId(nextWorkId);
  };
  const defaultWork = {
    runtimeId,
    workId: runtimeWorkId(0),
    source: "runtime",
    reason: "start",
    priority: "background",
  } satisfies RuntimeWorkContext;

  return {
    defaultWork,
    nextWork: (metadata, defaults, parentWorkId) => ({
      runtimeId,
      workId: allocateWorkId(),
      source: validateWorkSource(metadata?.source) ?? defaults.source,
      reason: validateWorkReason(metadata?.reason) ?? defaults.reason,
      priority: validateWorkPriority(metadata?.priority) ?? defaults.priority,
      parentWorkId,
    }),
  };
}

export type RuntimeWorkDefaults = {
  readonly source: RuntimeWorkSource;
  readonly reason: RuntimeWorkReason;
  readonly priority: RuntimeWorkPriority;
};

export function runtimeWorkAttributes(work: RuntimeWorkContext): Record<string, unknown> {
  const attributes: Record<string, unknown> = {
    "frond.runtime.id": work.runtimeId,
    "frond.work.id": work.workId,
    "frond.work.source": work.source,
    "frond.work.reason": work.reason,
    "frond.work.priority": work.priority,
  };

  if (work.parentWorkId !== undefined) {
    attributes["frond.work.parent_id"] = work.parentWorkId;
  }

  return attributes;
}

export function validateRuntimeWorkMetadata(
  metadata: RuntimeWorkMetadata | undefined
): RuntimeWorkMetadata | undefined {
  if (metadata === undefined) {
    return undefined;
  }

  validateWorkSource(metadata.source);
  validateWorkReason(metadata.reason);
  validateWorkPriority(metadata.priority);
  validateWorkSignal(metadata.signal);
  return metadata;
}

function validateWorkSignal(signal: RuntimeWorkMetadata["signal"]): AbortSignal | undefined {
  if (signal === undefined || signal instanceof AbortSignal) {
    return signal;
  }

  throw invalidMetadata("signal", signal);
}

function validateWorkSource(source: RuntimeWorkMetadata["source"]): RuntimeWorkSource | undefined {
  return validateEnum("source", source, runtimeWorkSources);
}

function validateWorkReason(reason: RuntimeWorkMetadata["reason"]): RuntimeWorkReason | undefined {
  return validateEnum("reason", reason, runtimeWorkReasons);
}

function validateWorkPriority(
  priority: RuntimeWorkMetadata["priority"]
): RuntimeWorkPriority | undefined {
  return validateEnum("priority", priority, runtimeWorkPriorities);
}

function validateEnum<TValue extends string>(
  field: string,
  value: TValue | undefined,
  allowed: ReadonlyArray<TValue>
): TValue | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (allowed.includes(value)) {
    return value;
  }

  throw invalidMetadata(field, value);
}

function invalidMetadata(field: string, value: unknown): FrondRuntimeInvariantViolation {
  return new FrondRuntimeInvariantViolation({
    message: `Runtime work metadata ${field} is invalid; received ${String(value)}.`,
    cause: { field, value },
  });
}

const runtimeWorkSources: ReadonlyArray<RuntimeWorkSource> = [
  "react",
  "mobx",
  "node",
  "manual",
  "devtools",
  "runtime",
  "signal",
  "test",
];

const runtimeWorkReasons: ReadonlyArray<RuntimeWorkReason> = [
  "start",
  "stop",
  "readiness",
  "retry",
  "preload",
  "refresh",
  "action",
  "args-update",
  "live",
  "release",
  "eviction",
  "unsafe-update",
  "input",
  "signal",
];

const runtimeWorkPriorities: ReadonlyArray<RuntimeWorkPriority> = [
  "blocking",
  "visible",
  "background",
  "idle",
];
