import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  createErrorReport,
  createRuntimeEventReports,
  createRuntimeReportSink,
  projectError,
  type RuntimeReportSinkInput,
} from "../src/diagnostics";
import { classify, failures, nodeIds } from "../src/events";
import {
  AcquireFailed,
  ActionFailed,
  CycleDetected,
  DependencyFailed,
  DependencyFailures,
  DependencyResultExpired,
  DisposerFailed,
  DriverPromiseFailed,
  EffectBoundaryFailed,
  KeyBuildFailed,
  type NodeId,
  RefreshFailed,
  ResultExpired,
} from "../src/graph";
import { recordSourceFailure } from "../src/graph/readiness/sourceFailures";
import { KeyNonFiniteNumberError } from "../src/keys";
import { FrondRuntimeReadError, type RuntimeEvent, type RuntimeEventRecord } from "../src/runtime";
import { Signals } from "../src/signals";

const cycleFirst = 'diagnostics/cycle-first:v1:"singleton"' as NodeId;
const cycleSecond = 'diagnostics/cycle-second:v1:"singleton"' as NodeId;
const invalidKeyNode = "diagnostics/invalid-key:__invalid__:nan" as NodeId;

describe("Frond diagnostics report", () => {
  test("hostile Error fields do not collapse the full report cause chain", () => {
    class HostileFieldError extends Error {
      constructor(cause: unknown) {
        super("hidden", { cause });
        delete (this as { message?: string | undefined }).message;
        delete (this as { stack?: string | undefined }).stack;
      }

      override get name(): string {
        throw new Error("name getter exploded");
      }

      override get message(): string {
        throw new Error("message getter exploded");
      }

      override get stack(): string {
        throw new Error("stack getter exploded");
      }
    }

    const inner = new TypeError("inner survived");
    const failure = new AcquireFailed({
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      tag: "diagnostics/request",
      cause: new HostileFieldError(inner),
    });
    const error = new FrondRuntimeReadError({
      message: "Frond node readiness failed.",
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      kind: "readiness",
      cause: failure,
    });
    const report = createErrorReport(error);
    const causeChain = report.contexts.causeChain as ReadonlyArray<{
      readonly tag?: string | undefined;
      readonly name?: string | undefined;
      readonly valueKind?: string | undefined;
      readonly message?: string | undefined;
    }>;

    expect(causeChain.map((frame) => frame.valueKind)).not.toContain("projection-failure");
    expect(causeChain.map((frame) => frame.tag ?? frame.name)).toContain("AcquireFailed");
    expect(causeChain.map((frame) => frame.name)).toContain("TypeError");
    expect(causeChain.at(-1)?.message).toBe("inner survived");
  });

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

    expect(report.error.name).toBe("FrondDiagnostic.CycleDetected");
    expect(report.message).toBe("[diagnostics/cycle-first] Dependency cycle detected");
    expect(report.fingerprint).toEqual([
      "frond",
      "invalid",
      "diagnostics/cycle-first",
      "CycleDetected",
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

    expect(report.error.name).toBe("FrondDiagnostic.KeyNonFiniteNumberError");
    expect(report.message).toBe(
      "[diagnostics/invalid-key key] Invalid key input at $.value: non-finite number."
    );
    expect(report.fingerprint).toEqual([
      "frond",
      "invalid",
      "diagnostics/invalid-key",
      "key",
      "KeyNonFiniteNumberError",
    ]);
    expect(report.fingerprint.join(" ")).not.toContain("__invalid__");
    expect(report.message).not.toContain("__invalid__");
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

    expect(report.message).toBe("[diagnostics/request acquire] Backend returned HTTP 500");
    expect(report.error.name).toBe("FrondDiagnostic.DiagnosticsBackendError");
    expect(report.error.cause).toBe(failure);
    expect(report.error.stack?.split("\n")[0]).toBe(
      "FrondDiagnostic.DiagnosticsBackendError: [diagnostics/request acquire] Backend returned HTTP 500"
    );
    expect(report.error.stack).toContain("diagnostics-report.test.ts");
    expect(report.error.stack).not.toContain("createErrorReportFromProjection");
  });

  test("dependency aggregate reports nothing itself; each member reports at its source", () => {
    const parentNodeId = 'diagnostics/parent:v1:"singleton"' as NodeId;
    const leftNodeId = 'diagnostics/left:v1:"singleton"' as NodeId;
    const rightNodeId = 'diagnostics/right:v1:"singleton"' as NodeId;
    const leftFailure = new AcquireFailed({
      nodeId: leftNodeId,
      tag: "diagnostics/left",
      cause: new Error("left failed"),
    });
    const rightFailure = new AcquireFailed({
      nodeId: rightNodeId,
      tag: "diagnostics/right",
      cause: new TypeError("right failed"),
    });
    const aggregate = new DependencyFailures({
      nodeId: parentNodeId,
      tag: "diagnostics/parent",
      failures: [
        new DependencyFailed({
          nodeId: parentNodeId,
          tag: "diagnostics/parent",
          dependency: "left",
          dependencyNodeId: leftNodeId,
          cause: leftFailure,
        }),
        new DependencyFailed({
          nodeId: parentNodeId,
          tag: "diagnostics/parent",
          dependency: "right",
          dependencyNodeId: rightNodeId,
          cause: rightFailure,
        }),
      ],
    });
    // Each member's own readiness attempt failed (and reported) first.
    recordSourceFailure(leftFailure);
    recordSourceFailure(rightFailure);
    const parentRecord = makeRuntimeEventRecord({
      _tag: "GraphNodeReadinessFailed",
      nodeId: parentNodeId,
      error: aggregate,
      at: 100,
    });
    const sourceReports = [leftFailure, rightFailure].flatMap((error, index) =>
      createRuntimeEventReports(
        makeRuntimeEventRecord({
          _tag: "GraphNodeReadinessFailed",
          nodeId: index === 0 ? leftNodeId : rightNodeId,
          error,
          at: 100,
        })
      )
    );

    expect(parentRecord.classification.reportable).toBe(false);
    expect(createRuntimeEventReports(parentRecord)).toEqual([]);
    expect(sourceReports.map((report) => report.message)).toEqual([
      "[diagnostics/left acquire] left failed",
      "[diagnostics/right acquire] right failed",
    ]);
    // A direct projection of the aggregate resolves to its first member.
    expect(createErrorReport(aggregate).error).toBe(sourceReports[0]?.error);
    // Members stay visible in the aggregate frame of the serialized chain.
    const aggregateFrame = createErrorReport(aggregate).contexts.causeChain as ReadonlyArray<{
      readonly tag?: string;
    }>;
    expect(aggregateFrame.map((frame) => frame.tag)).toContain("AcquireFailed");
  });

  test("a mixed dependency aggregate reports only the members no attempt reported", () => {
    const parentNodeId = 'diagnostics/mixed-parent:v1:"singleton"' as NodeId;
    const leftNodeId = 'diagnostics/mixed-left:v1:"singleton"' as NodeId;
    const rightNodeId = 'diagnostics/mixed-right:v1:"singleton"' as NodeId;
    const leftFailure = new AcquireFailed({
      nodeId: leftNodeId,
      tag: "diagnostics/mixed-left",
      cause: new Error("left failed"),
    });
    const rightMember = new DependencyFailed({
      nodeId: parentNodeId,
      tag: "diagnostics/mixed-parent",
      dependency: "right",
      dependencyNodeId: rightNodeId,
      cause: new DependencyResultExpired({
        nodeId: rightNodeId,
        tag: "diagnostics/mixed-right",
        resultValidity: { _tag: "Expired", loadedAt: 100, staleAt: 150, expiredAt: 200 },
      }),
    });
    const aggregate = new DependencyFailures({
      nodeId: parentNodeId,
      tag: "diagnostics/mixed-parent",
      failures: [
        new DependencyFailed({
          nodeId: parentNodeId,
          tag: "diagnostics/mixed-parent",
          dependency: "left",
          dependencyNodeId: leftNodeId,
          cause: leftFailure,
        }),
        rightMember,
      ],
    });
    // Only the left member's own attempt failed (and reported) first; the
    // right member expired without an attempt.
    recordSourceFailure(leftFailure);
    const [leftReport] = createRuntimeEventReports(
      makeRuntimeEventRecord({
        _tag: "GraphNodeReadinessFailed",
        nodeId: leftNodeId,
        error: leftFailure,
        at: 100,
      })
    );
    const parentReports = createRuntimeEventReports(
      makeRuntimeEventRecord({
        _tag: "GraphNodeReadinessFailed",
        nodeId: parentNodeId,
        error: aggregate,
        at: 100,
      })
    );
    const actionReports = createRuntimeEventReports(
      makeRuntimeEventRecord({
        _tag: "GraphActionFailed",
        nodeId: parentNodeId,
        action: "save",
        input: undefined,
        error: new ActionFailed({
          nodeId: parentNodeId,
          tag: "diagnostics/mixed-parent",
          action: "save",
          input: undefined,
          cause: aggregate,
        }),
        at: 100,
      })
    );

    expect(parentReports.map((report) => report.message)).toEqual([
      "[diagnostics/mixed-right] dependency result expired",
    ]);
    expect(parentReports[0]?.error).toBe(createErrorReport(rightMember).error);
    expect(parentReports[0]?.error).not.toBe(leftReport?.error);
    // The same aggregate observed by an action fans out the same way.
    expect(actionReports.map((report) => report.error)).toEqual([parentReports[0]?.error]);
  });

  test("an action on a node whose own attempt failed resolves to that attempt's report", () => {
    const nodeId = 'diagnostics/not-ready:v1:"singleton"' as NodeId;
    const source = new AcquireFailed({
      nodeId,
      tag: "diagnostics/not-ready",
      cause: new Error("acquire exploded"),
    });
    recordSourceFailure(source);
    const sourceReport = createErrorReport(source);
    const actionReport = createErrorReport(
      new ActionFailed({
        nodeId,
        tag: "diagnostics/not-ready",
        action: "touch",
        input: undefined,
        cause: source,
      })
    );

    expect(actionReport.message).toBe("[diagnostics/not-ready acquire] acquire exploded");
    expect(actionReport.fingerprint).toEqual(sourceReport.fingerprint);
    expect(actionReport.error).toBe(sourceReport.error);
    expect(actionReport.contexts.frond).toMatchObject({ kind: "readiness", operation: "acquire" });
  });

  test("a dependency wrapper of a failure no attempt reported stays reportable", () => {
    const parentNodeId = 'diagnostics/unreported-parent:v1:"singleton"' as NodeId;
    const childNodeId = 'diagnostics/unreported-child:v1:"singleton"' as NodeId;
    const record = makeRuntimeEventRecord({
      _tag: "GraphNodeReadinessFailed",
      nodeId: parentNodeId,
      error: new DependencyFailed({
        nodeId: parentNodeId,
        tag: "diagnostics/unreported-parent",
        dependency: "child",
        dependencyNodeId: childNodeId,
        cause: new KeyBuildFailed({
          nodeId: childNodeId,
          tag: "diagnostics/unreported-child",
          cause: new Error("key exploded"),
        }),
      }),
      at: 100,
    });

    expect(record.classification.reportable).toBe(true);
    expect(createRuntimeEventReports(record)).toHaveLength(1);
  });

  test("a deep dependency chain projects to the same source report as the failure itself", () => {
    const leafNodeId = 'diagnostics/deep-leaf:v1:"singleton"' as NodeId;
    const source = new AcquireFailed({
      nodeId: leafNodeId,
      tag: "diagnostics/deep-leaf",
      cause: new DriverPromiseFailed({
        nodeId: leafNodeId,
        tag: "diagnostics/deep-leaf",
        operation: "acquire",
        cause: new TypeError("leaf exploded"),
      }),
    });
    let reader: unknown = source;
    let dependencyNodeId = leafNodeId;

    // Seven dependency edges above the source: ten frames, past the eight the
    // serialized chain keeps.
    for (let depth = 0; depth < 7; depth += 1) {
      const nodeId = `diagnostics/deep-${depth}:v1:"singleton"` as NodeId;
      reader = new DependencyFailed({
        nodeId,
        tag: `diagnostics/deep-${depth}`,
        dependency: "next",
        dependencyNodeId,
        cause: reader,
      });
      dependencyNodeId = nodeId;
    }

    const sourceReport = createErrorReport(source);
    const readerReport = createErrorReport(reader);

    expect(readerReport.message).toBe("[diagnostics/deep-leaf acquire] leaf exploded");
    expect(readerReport.fingerprint).toEqual(sourceReport.fingerprint);
    expect(readerReport.error).toBe(sourceReport.error);
    // The serialized chain stays bounded; only source resolution walks past it.
    expect(projectError(reader).causeChain).toHaveLength(8);
  });

  test("unexpected values produce explicit fallback reports", () => {
    const typeError = createErrorReport(new TypeError("broken"));
    const thrownString = createErrorReport("broken");
    const thrownNull = createErrorReport(null);

    expect(typeError.error.name).toBe("FrondDiagnostic.TypeError");
    expect(typeError.message).toBe("broken");
    expect(typeError.fingerprint).toEqual(["frond", "unexpected", "TypeError"]);
    expect(thrownString.error.name).toBe("FrondDiagnostic.ThrownString");
    expect(thrownString.message).toBe("broken");
    expect(thrownString.fingerprint).toEqual(["frond", "unexpected", "ThrownString", "broken"]);
    expect(thrownNull.error.name).toBe("FrondDiagnostic.ThrownNull");
    expect(thrownNull.message).toBe("Unexpected thrown value");
  });

  test("runtime event reports add envelope context without changing fingerprint", () => {
    const error = new Error("Backend returned HTTP 500");
    error.name = "DiagnosticsBackendError";
    const nodeId = 'diagnostics/request:v1:{"id":123}' as NodeId;
    const runtimeFailureEvent = {
      _tag: "GraphRefreshFailed",
      nodeId,
      error: new RefreshFailed({
        nodeId,
        tag: "diagnostics/request",
        cause: error,
      }),
      at: 100,
    };
    const record = makeRuntimeEventRecord(runtimeFailureEvent);
    const [report] = createRuntimeEventReports(record);

    expect(report?.message).toBe("[diagnostics/request refresh] Backend returned HTTP 500");
    expect(report?.fingerprint).toEqual([
      "frond",
      "operation",
      "diagnostics/request",
      "refresh",
      "DiagnosticsBackendError",
    ]);
    expect(report?.error).toBe(createErrorReport(runtimeFailureEvent.error).error);
    expect(report?.fingerprint).toEqual(createErrorReport(runtimeFailureEvent.error).fingerprint);
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
    const record = makeRuntimeEventRecord({
      _tag: "GraphRefreshFailed",
      nodeId,
      error: new RefreshFailed({
        nodeId,
        tag: "diagnostics/request",
        cause: new ResultExpired({
          nodeId,
          tag: "diagnostics/request",
          resultValidity: { _tag: "Expired", loadedAt: 100, staleAt: 150, expiredAt: 200 },
        }),
      }),
      at: 100,
    });
    const [report] = createRuntimeEventReports(record);

    expect(report?.message).toBe("[diagnostics/request refresh] result expired");
    expect(report?.fingerprint).toEqual([
      "frond",
      "operation",
      "diagnostics/request",
      "refresh",
      "ResultExpired",
    ]);
    expect(report?.fingerprint.join(" ")).not.toContain("runtime-test");
    expect(report?.fingerprint.join(" ")).not.toContain("123");
  });

  test("runtime event reports return empty output for non-failure events", () => {
    const record = makeRuntimeEventRecord({ _tag: "RuntimeStarted", at: 100 });

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
    const record = makeRuntimeEventRecord({
      _tag: "GraphRefreshFailed",
      nodeId,
      error: new RefreshFailed({
        nodeId,
        tag: "diagnostics/request",
        cause: new Error("Backend returned HTTP 500"),
      }),
      at: 100,
    });

    await Effect.runPromise(sink.handle(record));

    expect(sink.name).toBe("diagnostics-report-test-sink");
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.record).toBe(record);
    expect(inputs[0]?.report.message).toBe(
      "[diagnostics/request refresh] Backend returned HTTP 500"
    );
    expect(inputs[0]?.report.fingerprint).toEqual([
      "frond",
      "operation",
      "diagnostics/request",
      "refresh",
      "Error",
      "Backend returned HTTP <n>",
    ]);
  });

  test("runtime report sink ignores events without generated reports", async () => {
    const reports: Array<unknown> = [];
    const sink = createRuntimeReportSink({
      name: "diagnostics-empty-report-test-sink",
      handleReport: (input) => {
        reports.push(input.report);
      },
    });

    await Effect.runPromise(
      sink.handle(makeRuntimeEventRecord({ _tag: "RuntimeStarted", at: 100 }))
    );

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
    const record = makeRuntimeEventRecord({
      _tag: "GraphRefreshFailed",
      nodeId,
      error: new RefreshFailed({
        nodeId,
        tag: "diagnostics/request",
        cause: new Error("Backend returned HTTP 500"),
      }),
      at: 100,
    });

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
    const record = makeRuntimeEventRecord({
      _tag: "RuntimeSignalSubscriberFailureObserved",
      subscriber: "subscriber",
      signal: signalRecord,
      cause: new Error("subscriber failed"),
      at: 110,
    });
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
    const record = makeRuntimeEventRecord({
      _tag: "GraphNodeReleased",
      nodeId,
      reason: "test release",
      at: 100,
      failure: new DisposerFailed({
        nodeId,
        tag: "diagnostics/release",
        cause: new EffectBoundaryFailed({
          boundary: "driver-release",
          cause: root,
          effectCause: root,
          pretty: "TypeError: release died",
        }),
      }),
    });
    const [report] = createRuntimeEventReports(record);

    expect(report?.message).toBe("[diagnostics/release dispose] release died");
    expect(report?.fingerprint).toEqual([
      "frond",
      "operation",
      "diagnostics/release",
      "dispose",
      "TypeError",
    ]);
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
