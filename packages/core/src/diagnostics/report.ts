import { Data, Effect } from "effect";
import type { RuntimeEventClassification } from "../events";
import { unreportedFailures } from "../graph/readiness/sourceFailures";
import type { RuntimeEvent, RuntimeEventRecord, RuntimeSink } from "../runtime/types";
import { diagnosticsProjectionFailure, projectError, unclassifiedCauseType } from "./projection";
import { normalizeOptions, safePreview } from "./safe";
import { serializeCauseChain } from "./serialize";
import type { FrondErrorProjection, FrondErrorReport } from "./types";

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
 * One tracker error per failure object. Every value that resolves to the same
 * failing node failure (the sink's source event, a reader's
 * `FrondRuntimeReadError`, a dependent's `DependencyFailed`) gets the same
 * `report.error`, so identity-based tracker dedupe works across surfaces.
 * Message and fingerprint depend only on the failure; contexts (requester,
 * path) stay per surface.
 */
const errorsByFailure = new WeakMap<object, Error>();

function reportErrorFor(projection: FrondErrorProjection, message: string): Error {
  const key = projection.failingFailure;
  const memoizable = typeof key === "object" && key !== null;
  const existing = memoizable ? errorsByFailure.get(key) : undefined;

  if (existing !== undefined) {
    return existing;
  }

  // This synthetic error is the tracker-facing object: named by the cause type
  // and caused by the failing node's own failure, not by the requester's
  // wrappers. The requester path lives in contexts.
  const error = new Error(message, { cause: key });
  error.name = `FrondDiagnostic.${projection.causeType}`;
  useProjectedRootStack(error, projection, message);

  if (memoizable) {
    errorsByFailure.set(key, error);
  }

  return error;
}

/**
 * Creates diagnostic reports for reportable failures carried by one runtime event.
 *
 * Non-failure and non-reportable events produce an empty array: a failure is
 * reported once, by the event at its source. A dependency aggregate that
 * mixes reported and unreported members reports only the latter, one each.
 * The original runtime event remains available through report contexts for
 * Sentry-like sinks; the report shares `error` with every other report of the
 * same failure.
 */
export function createRuntimeEventReports(
  record: RuntimeEventRecord
): ReadonlyArray<FrondErrorReport> {
  if (!record.classification.reportable) {
    return [];
  }

  try {
    return record.failures
      .flatMap(unreportedFailures)
      .map((failure) => enrichRuntimeEventReport(createErrorReport(failure), record));
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

  return {
    error: reportErrorFor(projection, message),
    message,
    fingerprint: reportFingerprint(projection),
    tags: reportTags(projection),
    contexts: {
      frond: {
        headline: projection.headline,
        summary: projection.summary,
        kind: projection.kind,
        retryable: projection.retryable,
        causeType: projection.causeType,
        causeMessage: projection.causeMessage,
        messageType: projection.messageType,
        failingNode: projection.failingNode,
        requester: projection.requester,
        path: projection.path,
        operation: projection.operation,
        dependency: projection.dependency,
      },
      causeChain:
        projection.failingFailure === projection.raw
          ? projection.causeChain
          : serializeCauseChain(projection.failingFailure),
    },
    extra: {
      rawPreview: safePreview(projection.failingFailure, normalizeOptions({})),
    },
  };
}

function useProjectedRootStack(
  error: Error,
  projection: FrondErrorProjection,
  message: string
): void {
  const stack = projection.stack;

  if (stack === undefined) {
    return;
  }

  try {
    error.stack = rewriteStackHeader(stack, error.name, message);
  } catch {
    // Error.stack is non-standard. If the host refuses assignment, keep the
    // synthetic construction stack and rely on structured causeChain context.
  }
}

function rewriteStackHeader(stack: string, name: string, message: string): string {
  const [first, ...rest] = stack.split("\n");

  if (first === undefined) {
    return stack;
  }

  return [`${name}: ${message}`, ...rest].join("\n");
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

/** `[<failing node tag> <operation>] <cause message>`; no prefix without a node. */
function reportMessage(projection: FrondErrorProjection): string {
  const nodeTag = projection.failingNode?.tag;

  if (nodeTag === undefined) {
    return projection.causeMessage.length > 0 ? projection.causeMessage : projection.headline;
  }

  const location =
    projection.operation === undefined ? nodeTag : `${nodeTag} ${projection.operation}`;

  return projection.causeMessage.length > 0
    ? `[${location}] ${projection.causeMessage}`
    : `[${location}]`;
}

/**
 * `["frond", kind, failingNode?, operation?, causeType]`, plus the masked
 * message for unclassified causes. The node id (args, keys) never enters it.
 */
function reportFingerprint(projection: FrondErrorProjection): ReadonlyArray<string> {
  const parts = ["frond", projection.kind];

  if (projection.failingNode?.tag !== undefined) {
    parts.push(projection.failingNode.tag);
  }

  if (projection.operation !== undefined) {
    parts.push(projection.operation);
  }

  parts.push(projection.causeType);

  if (isUnclassified(projection.causeType)) {
    const masked = maskMessage(projection.causeMessage);

    if (masked.length > 0) {
      parts.push(masked);
    }
  }

  return parts;
}

function isUnclassified(causeType: string): boolean {
  return causeType === unclassifiedCauseType || causeType.startsWith("Thrown");
}

const maskedMessageLength = 120;
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const tokenPattern = /[0-9a-z]+(?:-[0-9a-z]+)*/gi;

/**
 * Replaces UUIDs, hex runs (dash-joined groups count as one), and numbers with
 * placeholders so unclassified messages group by what they say, not by ids.
 */
export function maskMessage(message: string): string {
  const masked = message.replace(uuidPattern, "<uuid>").replace(tokenPattern, maskToken).trim();

  return masked.length > maskedMessageLength ? masked.slice(0, maskedMessageLength) : masked;
}

function maskToken(token: string): string {
  if (!/\d/.test(token)) {
    return token;
  }

  if (/^\d+$/.test(token)) {
    return "<n>";
  }

  if (/^(?:0x)?[0-9a-f]+(?:-[0-9a-f]+)*$/i.test(token)) {
    return "<hex>";
  }

  return token.replace(/\d+/g, "<n>");
}

function reportTags(projection: FrondErrorProjection): Record<string, string> {
  return {
    "frond.kind": projection.kind,
    "frond.retryable": String(projection.retryable),
    "frond.cause_type": projection.causeType,
    "frond.failing_node": projection.failingNode?.tag ?? "unknown",
    "frond.operation": projection.operation ?? "none",
    "frond.requester": projection.requester?.tag ?? "unknown",
  };
}
