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

export type RuntimeSnapshotPurpose =
  | "product-read"
  | "devtools"
  | "diagnostics"
  | "test"
  | "persistence";

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
  return metadata;
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
