import { Data, Effect, Match } from "effect";
import type { RuntimeEventClassification } from "../events";
import type { RuntimeEvent, RuntimeEventRecord, RuntimeSink } from "../runtime/types";
import { diagnosticsProjectionFailure, frameTag, projectError } from "./projection";
import { normalizeOptions, safeGet, safePreview, safeString, valueKind } from "./safe";
import { serializeCauseChain } from "./serialize";
import type { FrondErrorProjection, FrondErrorReport, SerializedCauseFrame } from "./types";

type ReportMessageInput =
  | { readonly _tag: "UnexpectedError"; readonly rootTag: string }
  | { readonly _tag: "UnexpectedValue"; readonly valueLabel: string }
  | { readonly _tag: "Invalid"; readonly rootTag: string }
  | { readonly _tag: "Readiness"; readonly rootTag: string }
  | { readonly _tag: "Operation"; readonly rootTag: string }
  | { readonly _tag: "Live"; readonly rootTag: string }
  | { readonly _tag: "Runtime"; readonly rootTag: string };

type ErrorReportContexts = Record<string, unknown> & {
  dependencyFailures?: DependencyAggregateReportContext | undefined;
};

class RuntimeReportSinkHandlerFailed extends Data.TaggedError("RuntimeReportSinkHandlerFailed")<{
  readonly message: string;
  readonly cause: unknown;
}> {}

/**
 * Projects an unknown failure into a serializable Frond diagnostic report.
 *
 * Use at process/reporting boundaries. Runtime execution should keep typed
 * graph/runtime failures instead of converting them to reports early.
 */
export function createErrorReport(error: unknown): FrondErrorReport {
  try {
    return createErrorReportFromProjection(projectError(error));
  } catch (cause) {
    return createErrorReportFromProjection(diagnosticsProjectionFailure(error, cause));
  }
}

/**
 * Creates diagnostic reports for reportable failures carried by one runtime event.
 *
 * Non-failure events produce an empty array. The original runtime event remains
 * available through report contexts for Sentry-like sinks.
 */
export function createRuntimeEventReports(
  record: RuntimeEventRecord
): ReadonlyArray<FrondErrorReport> {
  try {
    return record.failures.map((failure) =>
      enrichRuntimeEventReport(createErrorReport(failure), record)
    );
  } catch (cause) {
    return [
      enrichRuntimeEventReport(
        createErrorReport(diagnosticsProjectionFailure(record, cause)),
        record
      ),
    ];
  }
}

export interface RuntimeReportSinkInput {
  readonly record: RuntimeEventRecord;
  readonly report: FrondErrorReport;
}

export interface RuntimeReportSinkOptions {
  readonly name: string;
  readonly handleReport: (input: RuntimeReportSinkInput) => void | Promise<void>;
}

/**
 * Builds a runtime sink that forwards generated diagnostic reports.
 *
 * Boundary: `handleReport` may be sync or Promise-returning; the helper wraps it
 * into the Effect-native sink contract.
 */
export function createRuntimeReportSink(options: RuntimeReportSinkOptions): RuntimeSink {
  return {
    name: options.name,
    handle: (record) =>
      Effect.tryPromise({
        try: async () => {
          for (const report of createRuntimeEventReports(record)) {
            await options.handleReport({ record, report });
          }
        },
        catch: (cause) =>
          new RuntimeReportSinkHandlerFailed({
            message: "Runtime report sink handler failed.",
            cause,
          }),
      }),
  };
}

function createErrorReportFromProjection(projection: FrondErrorProjection): FrondErrorReport {
  const message = reportMessage(projection);
  // This synthetic error is the tracker-facing object. The raw Frond/runtime
  // error stays as `cause` and in structured contexts so integrations can group
  // by the projected root cause instead of by wrapper classes like
  // FrondRuntimeReadError, AcquireFailed, ActionFailed, or RefreshFailed.
  const reportError = new Error(message, { cause: projection.raw });
  reportError.name = "FrondDiagnosticError";
  useProjectedRootStack(reportError, projection, message);
  const contexts: ErrorReportContexts = {
    frond: {
      headline: projection.headline,
      summary: projection.summary,
      kind: projection.kind,
      retryable: projection.retryable,
      rootTag: projection.rootTag,
      rootMessage: projection.rootMessage,
      nodeId: projection.nodeId,
      nodeTag: projection.nodeTag,
      operation: projection.operation,
      dependency: projection.dependency,
      path: projection.path,
    },
    causeChain: projection.causeChain,
  };
  const aggregate = dependencyAggregateContext(projection.raw);

  if (aggregate !== undefined) {
    contexts.dependencyFailures = aggregate;
  }

  return {
    error: reportError,
    message,
    fingerprint: reportFingerprint(projection),
    tags: reportTags(projection),
    contexts,
    extra: {
      rawPreview: safePreview(projection.raw, normalizeOptions({})),
    },
  };
}

function useProjectedRootStack(
  error: Error,
  projection: FrondErrorProjection,
  message: string
): void {
  const rootStack = projectedRootStack(projection);

  if (rootStack === undefined) {
    return;
  }

  try {
    error.stack = rewriteStackHeader(rootStack, error.name, message);
  } catch {
    // Error.stack is non-standard. If the host refuses assignment, keep the
    // synthetic construction stack and rely on structured causeChain context.
  }
}

function projectedRootStack(projection: FrondErrorProjection): string | undefined {
  const reversed = [...projection.causeChain].reverse();
  const exactRootFrame = reversed.find(
    (frame) =>
      frame.stack !== undefined &&
      frameTag(frame) === projection.rootTag &&
      frameRootMessage(frame) === projection.rootMessage
  );

  if (exactRootFrame?.stack !== undefined) {
    return exactRootFrame.stack;
  }

  return reversed.find(
    (frame) => frame.stack !== undefined && frameTag(frame) === projection.rootTag
  )?.stack;
}

function frameRootMessage(frame: SerializedCauseFrame): string {
  return frame.invariant ?? frame.message ?? frameTag(frame);
}

function rewriteStackHeader(stack: string, name: string, message: string): string {
  const [first, ...rest] = stack.split("\n");

  if (first === undefined) {
    return stack;
  }

  return [`${name}: ${message}`, ...rest].join("\n");
}

type DependencyAggregateReportContext = {
  readonly tag: string;
  readonly nodeId?: string | undefined;
  readonly nodeTag?: string | undefined;
  readonly failureCount: number;
  readonly failures: ReadonlyArray<{
    readonly tag?: string | undefined;
    readonly nodeId?: string | undefined;
    readonly nodeTag?: string | undefined;
    readonly dependency?: string | undefined;
    readonly dependencyNodeId?: string | undefined;
    readonly rootTag: string;
    readonly rootMessage: string;
    readonly causeChain: ReadonlyArray<SerializedCauseFrame>;
  }>;
};

function dependencyAggregateContext(raw: unknown): DependencyAggregateReportContext | undefined {
  const aggregate = findDependencyAggregate(raw);

  if (aggregate === undefined) {
    return undefined;
  }

  const failures = safeGet(aggregate, "failures");

  if (!Array.isArray(failures) || failures.length === 0) {
    return undefined;
  }

  return {
    tag: safeString(safeGet(aggregate, "_tag")) ?? "DependencyFailures",
    nodeId: safeString(safeGet(aggregate, "nodeId")),
    nodeTag: safeString(safeGet(aggregate, "tag")),
    failureCount: failures.length,
    failures: failures.map(dependencyFailureContext),
  };
}

function findDependencyAggregate(raw: unknown): unknown | undefined {
  let current: unknown = raw;

  for (let depth = 0; depth < 8; depth += 1) {
    const tag = safeString(safeGet(current, "_tag"));

    if (tag === "DependencyFailures" || tag === "DependencyDefinitionFailures") {
      return current;
    }

    const cause = safeGet(current, "cause");

    if (cause === undefined) {
      return undefined;
    }

    current = cause;
  }

  return undefined;
}

function dependencyFailureContext(
  failure: unknown
): DependencyAggregateReportContext["failures"][number] {
  const causeChain = serializeCauseChain(failure);
  const root = causeChain.at(-1);

  return {
    tag: safeString(safeGet(failure, "_tag")),
    nodeId: safeString(safeGet(failure, "nodeId")),
    nodeTag: safeString(safeGet(failure, "tag")),
    dependency: safeString(safeGet(failure, "dependency")),
    dependencyNodeId: safeString(safeGet(failure, "dependencyNodeId")),
    rootTag: root?.tag ?? root?.name ?? root?.valueKind ?? "Unknown",
    rootMessage: root?.message ?? "Unknown",
    causeChain,
  };
}

function enrichRuntimeEventReport(
  report: FrondErrorReport,
  record: RuntimeEventRecord
): FrondErrorReport {
  const envelope = runtimeEventEnvelope(record);

  return {
    ...report,
    tags: {
      ...report.tags,
      "frond.runtime_id": envelope.runtimeId,
      "frond.event_tag": envelope.eventTag,
      "frond.event_category": envelope.classification.category,
      "frond.event_severity": envelope.classification.severity,
      "frond.event_reportable": String(envelope.classification.reportable),
      "frond.event_timeline": envelope.classification.timeline,
    },
    contexts: {
      ...report.contexts,
      runtimeEvent: envelope,
    },
  };
}

type RuntimeEventReportEnvelope = {
  readonly runtimeId: string;
  readonly sequence: number;
  readonly recordedAt: number;
  readonly eventTag: RuntimeEvent["_tag"];
  readonly eventAt?: number | undefined;
  readonly nodeIds: ReadonlyArray<string>;
  readonly classification: RuntimeEventClassification;
  readonly work: {
    readonly workId: number;
    readonly source: string;
    readonly reason: string;
    readonly priority: string;
    readonly parentWorkId?: number | undefined;
  };
  readonly signal?:
    | {
        readonly sequence: number;
        readonly recordedAt: number;
        readonly channel: string;
        readonly name: string;
      }
    | undefined;
};

function runtimeEventEnvelope(record: RuntimeEventRecord): RuntimeEventReportEnvelope {
  return {
    runtimeId: record.runtimeId,
    sequence: record.sequence,
    recordedAt: record.recordedAt,
    eventTag: record.event._tag,
    eventAt: runtimeEventAt(record.event),
    nodeIds: record.nodeIds,
    classification: record.classification,
    work: runtimeEventWork(record),
    signal: runtimeEventSignal(record.event),
  };
}

function runtimeEventWork(record: RuntimeEventRecord): RuntimeEventReportEnvelope["work"] {
  const work = {
    workId: record.work.workId,
    source: record.work.source,
    reason: record.work.reason,
    priority: record.work.priority,
  };

  if (record.work.parentWorkId === undefined) {
    return work;
  }

  return {
    ...work,
    parentWorkId: record.work.parentWorkId,
  };
}

function runtimeEventAt(event: RuntimeEvent): number | undefined {
  return "at" in event ? event.at : undefined;
}

function runtimeEventSignal(event: RuntimeEvent): RuntimeEventReportEnvelope["signal"] {
  const signalRecord =
    event._tag === "RuntimeSignalPublished"
      ? event.record
      : event._tag === "RuntimeSignalSubscriberFailureObserved"
        ? event.signal
        : undefined;

  if (signalRecord === undefined) {
    return undefined;
  }

  return {
    sequence: signalRecord.sequence,
    recordedAt: signalRecord.recordedAt,
    channel: signalRecord.signal.channel,
    name: signalRecord.signal.name,
  };
}

function reportMessage(projection: FrondErrorProjection): string {
  return Match.value(reportMessageInput(projection)).pipe(
    Match.tag("UnexpectedError", ({ rootTag }) => `Frond unexpected error: ${rootTag}`),
    Match.tag("UnexpectedValue", ({ valueLabel }) => `Frond unexpected ${valueLabel}`),
    Match.tag("Invalid", ({ rootTag }) => `Frond invalid graph: ${rootTag}`),
    Match.tag("Readiness", ({ rootTag }) => `Frond readiness failed: ${rootTag}`),
    Match.tag("Operation", ({ rootTag }) => `Frond operation failed: ${rootTag}`),
    Match.tag("Live", ({ rootTag }) => `Frond live work failed: ${rootTag}`),
    Match.tag("Runtime", ({ rootTag }) => `Frond runtime: ${rootTag}`),
    Match.exhaustive
  );
}

function reportMessageInput(projection: FrondErrorProjection): ReportMessageInput {
  if (projection.kind === "unexpected" && projection.raw instanceof Error) {
    return { _tag: "UnexpectedError", rootTag: projection.rootTag };
  }

  if (projection.kind === "unexpected") {
    return {
      _tag: "UnexpectedValue",
      valueLabel: projection.raw === null ? "null" : typeof projection.raw,
    };
  }

  return Match.value(projection.kind).pipe(
    Match.when("invalid", () => ({ _tag: "Invalid", rootTag: projection.rootTag }) as const),
    Match.when("readiness", () => ({ _tag: "Readiness", rootTag: projection.rootTag }) as const),
    Match.when("operation", () => ({ _tag: "Operation", rootTag: projection.rootTag }) as const),
    Match.when("live", () => ({ _tag: "Live", rootTag: projection.rootTag }) as const),
    Match.when("runtime", () => ({ _tag: "Runtime", rootTag: projection.rootTag }) as const),
    Match.exhaustive
  );
}

function reportFingerprint(projection: FrondErrorProjection): ReadonlyArray<string> {
  return Match.value(projection).pipe(
    Match.when(
      { kind: "unexpected" },
      ({ raw, rootTag }) => ["frond", "unexpected", valueKind(raw), rootTag] as const
    ),
    Match.orElse(({ kind, rootTag, nodeTag }) => {
      const parts = ["frond", kind, rootTag];

      if (nodeTag !== undefined) {
        parts.push(nodeTag);
      }

      return parts;
    })
  );
}

function reportTags(projection: FrondErrorProjection): Record<string, string> {
  return {
    "frond.kind": projection.kind,
    "frond.retryable": String(projection.retryable),
    "frond.root_tag": projection.rootTag,
    "frond.node_tag": projection.nodeTag ?? "unknown",
  };
}
