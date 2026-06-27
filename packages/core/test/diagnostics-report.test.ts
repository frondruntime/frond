import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  createErrorReport,
  createRuntimeEventReports,
  createRuntimeReportSink,
  type RuntimeReportSinkInput,
} from "../src/diagnostics";
import { classify, failures, nodeIds } from "../src/events";
import {
  AcquireFailed,
  CycleDetected,
  DependencyFailed,
  DependencyFailures,
  DisposerFailed,
  EffectBoundaryFailed,
  KeyBuildFailed,
  type NodeId,
  RefreshFailed,
  ResultExpired,
} from "../src/graph";
import { KeyNonFiniteNumberError } from "../src/keys";
import { FrondRuntimeReadError, type RuntimeEvent, type RuntimeEventRecord } from "../src/runtime";
import { RuntimeEvents } from "../src/runtime/events";
import { Signals } from "../src/signals";

const cycleFirst = 'diagnostics/cycle-first:v1:"singleton"' as NodeId;
const cycleSecond = 'diagnostics/cycle-second:v1:"singleton"' as NodeId;
const invalidKeyNode = "diagnostics/invalid-key:__invalid__:nan" as NodeId;

describe("Frond diagnostics report", () => {
  test("cycle report uses stable invalid graph message and fingerprint", () => {
    const cycle = new CycleDetected({
      nodeId: cycleFirst,
      tag: "diagnostics/cycle-first",
      path: [cycleFirst, cycleSecond, cycleFirst],
    });
    const error = new FrondRuntimeReadError({
      message: "Frond node wiring is invalid.",
      nodeId: cycleFirst,
      kind: "invalid",
      cause: cycle,
    });
    const report = createErrorReport(error);

    expect(report.message).toBe("Frond invalid graph: CycleDetected");
    expect(report.fingerprint).toEqual([
      "frond",
      "invalid",
      "CycleDetected",
      "diagnostics/cycle-first",
    ]);
  });

  test("invalid key report excludes high-cardinality node id from fingerprint", () => {
    const keyError = new KeyNonFiniteNumberError({
      _tag: "KeyNonFiniteNumberError",
      message: "Invalid key input at $.value: non-finite number.",
      path: "$.value",
      value: Number.NaN,
    });
    const failure = new KeyBuildFailed({
      nodeId: invalidKeyNode,
      tag: "diagnostics/invalid-key",
      cause: keyError,
    });
    const error = new FrondRuntimeReadError({
      message: "Frond node wiring is invalid.",
      nodeId: invalidKeyNode,
      kind: "invalid",
      cause: failure,
    });
    const report = createErrorReport(error);

    expect(report.fingerprint).toEqual([
      "frond",
      "invalid",
      "KeyNonFiniteNumberError",
      "diagnostics/invalid-key",
    ]);
    expect(report.fingerprint.join(" ")).not.toContain("__invalid__");
  });

  test("readiness report uses actionable root backend error", () => {
    class DiagnosticsBackendError extends Error {
      constructor() {
        super("Backend returned HTTP 500");
        this.name = "DiagnosticsBackendError";
      }
    }

    const failure = new AcquireFailed({
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      tag: "diagnostics/request",
      cause: new DiagnosticsBackendError(),
    });
    const error = new FrondRuntimeReadError({
      message: "Frond node readiness failed.",
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      kind: "readiness",
      cause: failure,
    });
    const report = createErrorReport(error);

    expect(report.message).toBe("Frond readiness failed: DiagnosticsBackendError");
    expect(report.error.name).toBe("FrondDiagnosticError");
    expect(report.error.stack?.split("\n")[0]).toBe(
      "FrondDiagnosticError: Frond readiness failed: DiagnosticsBackendError"
    );
    expect(report.error.stack).toContain("diagnostics-report.test.ts");
    expect(report.error.stack).not.toContain("createErrorReportFromProjection");
  });

  test("dependency aggregate event report includes every sibling failure", () => {
    const parentNodeId = 'diagnostics/parent:v1:"singleton"' as NodeId;
    const leftNodeId = 'diagnostics/left:v1:"singleton"' as NodeId;
    const rightNodeId = 'diagnostics/right:v1:"singleton"' as NodeId;
    const aggregate = new DependencyFailures({
      nodeId: parentNodeId,
      tag: "diagnostics/parent",
      failures: [
        new DependencyFailed({
          nodeId: parentNodeId,
          tag: "diagnostics/parent",
          dependency: "left",
          dependencyNodeId: leftNodeId,
          cause: new AcquireFailed({
            nodeId: leftNodeId,
            tag: "diagnostics/left",
            cause: new Error("left failed"),
          }),
        }),
        new DependencyFailed({
          nodeId: parentNodeId,
          tag: "diagnostics/parent",
          dependency: "right",
          dependencyNodeId: rightNodeId,
          cause: new AcquireFailed({
            nodeId: rightNodeId,
            tag: "diagnostics/right",
            cause: new Error("right failed"),
          }),
        }),
      ],
    });
    const record = makeRuntimeEventRecord(
      RuntimeEvents.graphNodeReadyEnsured(
        parentNodeId,
        { _tag: "Wired", run: { _tag: "Error", error: aggregate } },
        100
      )
    );
    const [report] = createRuntimeEventReports(record);
    const aggregateContext = report?.contexts.dependencyFailures as
      | {
          readonly failureCount: number;
          readonly nodeTag: string;
          readonly failures: ReadonlyArray<{
            readonly dependency: string;
            readonly dependencyNodeId: NodeId;
            readonly causeChain: ReadonlyArray<{ readonly tag?: string }>;
          }>;
        }
      | undefined;

    expect(report?.message).toBe("Frond readiness failed: DependencyFailures");
    expect(report?.fingerprint).toEqual([
      "frond",
      "readiness",
      "DependencyFailures",
      "diagnostics/parent",
    ]);
    expect(aggregateContext).toMatchObject({
      failureCount: 2,
      nodeTag: "diagnostics/parent",
    });
    expect(aggregateContext?.failures.map((failure) => failure.dependency).sort()).toEqual([
      "left",
      "right",
    ]);
    expect(aggregateContext?.failures.map((failure) => failure.dependencyNodeId).sort()).toEqual(
      [leftNodeId, rightNodeId].sort()
    );
    expect(
      aggregateContext?.failures.every((failure) =>
        failure.causeChain.some((frame) => frame.tag === "DependencyFailed")
      )
    ).toBe(true);
  });

  test("unexpected values produce explicit fallback reports", () => {
    expect(createErrorReport(new TypeError("broken")).message).toBe(
      "Frond unexpected error: TypeError"
    );
    expect(createErrorReport("broken").message).toBe("Frond unexpected string");
    expect(createErrorReport(null).message).toBe("Frond unexpected null");
  });

  test("runtime event reports add envelope context without changing fingerprint", () => {
    const error = new Error("Backend returned HTTP 500");
    error.name = "DiagnosticsBackendError";
    const nodeId = 'diagnostics/request:v1:{"id":123}' as NodeId;
    const runtimeEvent = RuntimeEvents.graphRefreshFailed(
      nodeId,
      new RefreshFailed({
        nodeId,
        tag: "diagnostics/request",
        cause: error,
      }),
      100
    );
    const record = makeRuntimeEventRecord(runtimeEvent);
    const [report] = createRuntimeEventReports(record);

    expect(report?.message).toBe("Frond operation failed: DiagnosticsBackendError");
    expect(report?.fingerprint).toEqual([
      "frond",
      "operation",
      "DiagnosticsBackendError",
      "diagnostics/request",
    ]);
    expect(report?.fingerprint.join(" ")).not.toContain("runtime-test");
    expect(report?.fingerprint.join(" ")).not.toContain("123");
    expect(report?.tags).toMatchObject({
      "frond.runtime_id": "runtime-test",
      "frond.event_tag": "GraphRefreshFailed",
      "frond.event_category": "operation",
      "frond.event_severity": "error",
    });
    expect(report?.contexts.runtimeEvent).toMatchObject({
      runtimeId: "runtime-test",
      sequence: 7,
      recordedAt: 110,
      eventTag: "GraphRefreshFailed",
      eventAt: 100,
      nodeIds: ['diagnostics/request:v1:{"id":123}'],
      work: {
        workId: 1,
        source: "test",
        reason: "refresh",
        priority: "visible",
      },
    });
    expect(JSON.stringify(report?.contexts.runtimeEvent)).not.toContain(
      "Backend returned HTTP 500"
    );
  });

  test("expired refresh reports group by typed root cause without runtime or node id", () => {
    const nodeId = 'diagnostics/request:v1:{"id":123}' as NodeId;
    const record = makeRuntimeEventRecord(
      RuntimeEvents.graphRefreshFailed(
        nodeId,
        new RefreshFailed({
          nodeId,
          tag: "diagnostics/request",
          cause: new ResultExpired({
            nodeId,
            tag: "diagnostics/request",
            resultValidity: { _tag: "Expired", loadedAt: 100, staleAt: 150, expiredAt: 200 },
          }),
        }),
        100
      )
    );
    const [report] = createRuntimeEventReports(record);

    expect(report?.message).toBe("Frond operation failed: ResultExpired");
    expect(report?.fingerprint).toEqual([
      "frond",
      "operation",
      "ResultExpired",
      "diagnostics/request",
    ]);
    expect(report?.fingerprint.join(" ")).not.toContain("runtime-test");
    expect(report?.fingerprint.join(" ")).not.toContain("123");
  });

  test("runtime event reports return empty output for non-failure events", () => {
    const record = makeRuntimeEventRecord(RuntimeEvents.runtimeStarted(100));

    expect(createRuntimeEventReports(record)).toEqual([]);
  });

  test("runtime report sink forwards generated reports with original event records", async () => {
    const inputs: Array<RuntimeReportSinkInput> = [];
    const sink = createRuntimeReportSink({
      name: "diagnostics-report-test-sink",
      handleReport: (input) => {
        inputs.push(input);
      },
    });
    const nodeId = 'diagnostics/request:v1:{"id":123}' as NodeId;
    const record = makeRuntimeEventRecord(
      RuntimeEvents.graphRefreshFailed(
        nodeId,
        new RefreshFailed({
          nodeId,
          tag: "diagnostics/request",
          cause: new Error("Backend returned HTTP 500"),
        }),
        100
      )
    );

    await Effect.runPromise(sink.handle(record));

    expect(sink.name).toBe("diagnostics-report-test-sink");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.record).toBe(record);
    expect(inputs[0]?.report.message).toBe("Frond operation failed: Error");
  });

  test("runtime report sink ignores events without generated reports", async () => {
    const reports: Array<unknown> = [];
    const sink = createRuntimeReportSink({
      name: "diagnostics-empty-report-test-sink",
      handleReport: (input) => {
        reports.push(input.report);
      },
    });

    await Effect.runPromise(sink.handle(makeRuntimeEventRecord(RuntimeEvents.runtimeStarted(100))));

    expect(reports).toEqual([]);
  });

  test("runtime report sink preserves rejected report handlers as sink failures", async () => {
    const sink = createRuntimeReportSink({
      name: "diagnostics-rejected-report-test-sink",
      handleReport: async () => {
        throw new Error("report handler rejected");
      },
    });
    const nodeId = 'diagnostics/request:v1:{"id":123}' as NodeId;
    const record = makeRuntimeEventRecord(
      RuntimeEvents.graphRefreshFailed(
        nodeId,
        new RefreshFailed({
          nodeId,
          tag: "diagnostics/request",
          cause: new Error("Backend returned HTTP 500"),
        }),
        100
      )
    );

    await expect(Effect.runPromise(sink.handle(record))).rejects.toMatchObject({
      _tag: "RuntimeReportSinkHandlerFailed",
      cause: expect.any(Error),
    });
  });

  test("signal subscriber failure report includes signal envelope", () => {
    const signalRecord = {
      runtimeId: "runtime-test" as RuntimeEventRecord["runtimeId"],
      sequence: 3,
      recordedAt: 105,
      signal: Signals.signal({ channel: "app.analytics", name: "button_clicked" }),
    };
    const record = makeRuntimeEventRecord(
      RuntimeEvents.runtimeSignalSubscriberFailureObserved(
        "subscriber",
        signalRecord,
        new Error("subscriber failed"),
        110
      )
    );
    const [report] = createRuntimeEventReports(record);

    expect(report?.contexts.runtimeEvent).toMatchObject({
      eventTag: "RuntimeSignalSubscriberFailureObserved",
      signal: {
        sequence: 3,
        recordedAt: 105,
        channel: "app.analytics",
        name: "button_clicked",
      },
    });
    expect(report?.fingerprint.join(" ")).not.toContain("runtime-test");
    expect(report?.fingerprint.join(" ")).not.toContain("1");
  });

  test("release cleanup report uses operation context, not readiness", () => {
    const nodeId = 'diagnostics/release:v1:"singleton"' as NodeId;
    const root = new TypeError("release died");
    const record = makeRuntimeEventRecord(
      RuntimeEvents.graphNodeReleased(
        nodeId,
        "test release",
        100,
        new DisposerFailed({
          nodeId,
          tag: "diagnostics/release",
          cause: new EffectBoundaryFailed({
            boundary: "driver-release",
            cause: root,
            effectCause: root,
            pretty: "TypeError: release died",
          }),
        })
      )
    );
    const [report] = createRuntimeEventReports(record);

    expect(report?.message).toBe("Frond operation failed: TypeError");
    expect(report?.fingerprint).toEqual(["frond", "operation", "TypeError", "diagnostics/release"]);
  });
});

function makeRuntimeEventRecord(event: RuntimeEvent): RuntimeEventRecord {
  return {
    runtimeId: "runtime-test" as RuntimeEventRecord["runtimeId"],
    sequence: 7,
    recordedAt: 110,
    event,
    work: {
      runtimeId: "runtime-test" as RuntimeEventRecord["runtimeId"],
      workId: 1 as RuntimeEventRecord["work"]["workId"],
      source: "test",
      reason: "refresh",
      priority: "visible",
    },
    classification: classify(event),
    nodeIds: nodeIds(event),
    failures: failures(event),
  };
}
