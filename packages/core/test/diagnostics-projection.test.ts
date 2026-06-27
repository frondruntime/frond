import { describe, expect, test } from "bun:test";
import { projectError } from "../src/diagnostics";
import {
  AcquireFailed,
  CycleDetected,
  DependencyFailed,
  DependencyFailures,
  EffectBoundaryFailed,
  GraphInvariantViolation,
  KeyBuildFailed,
  type NodeId,
  RefreshFailed,
  ResultExpired,
} from "../src/graph";
import { KeyNonFiniteNumberError } from "../src/keys";
import { FrondRuntimeReadError, FrondRuntimeUnavailable } from "../src/runtime";

const cycleFirst = 'diagnostics/cycle-first:v1:"singleton"' as NodeId;
const cycleSecond = 'diagnostics/cycle-second:v1:"singleton"' as NodeId;
const invalidKeyNode = "diagnostics/invalid-key:__invalid__:nan" as NodeId;

describe("Frond diagnostics projection", () => {
  test("cycle read error projects to actionable invalid graph summary", () => {
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
    const projection = projectError(error);

    expect(projection.headline).toBe("Dependency cycle detected");
    expect(projection.summary).toContain("cycle-first -> cycle-second -> cycle-first");
    expect(projection.kind).toBe("invalid");
    expect(projection.retryable).toBe(false);
    expect(projection.path).toEqual([cycleFirst, cycleSecond, cycleFirst]);
  });

  test("invalid key projects to invalid node key with key error detail", () => {
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
    const projection = projectError(error);

    expect(projection.headline).toBe("Invalid node key");
    expect(projection.rootTag).toBe("KeyNonFiniteNumberError");
    expect(projection.rootMessage).toBe("Invalid key input at $.value: non-finite number.");
  });

  test("readiness failure projects to root backend error", () => {
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
    const projection = projectError(error);

    expect(projection.headline).toBe("Readiness failed");
    expect(projection.rootTag).toBe("DiagnosticsBackendError");
    expect(projection.rootMessage).toBe("Backend returned HTTP 500");
  });

  test("dependency aggregate projects as readiness failure", () => {
    const parentNodeId = 'diagnostics/parent:v1:"singleton"' as NodeId;
    const leftNodeId = 'diagnostics/left:v1:"singleton"' as NodeId;
    const rightNodeId = 'diagnostics/right:v1:"singleton"' as NodeId;
    const failure = new DependencyFailures({
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
    const projection = projectError(failure);

    expect(projection.kind).toBe("readiness");
    expect(projection.headline).toBe("Readiness failed");
    expect(projection.rootTag).toBe("DependencyFailures");
  });

  test("Effect boundary failures walk through to the actionable cause", () => {
    const cause = new TypeError("driver typo");
    const failure = new AcquireFailed({
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      tag: "diagnostics/request",
      cause: new EffectBoundaryFailed({
        boundary: "readiness-acquire",
        cause,
        effectCause: { _tag: "TestCause" },
        pretty: "TypeError: driver typo",
      }),
    });
    const projection = projectError(
      new FrondRuntimeReadError({
        message: "Frond node readiness failed.",
        nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
        kind: "readiness",
        cause: failure,
      })
    );

    expect(projection.headline).toBe("Readiness failed");
    expect(projection.rootTag).toBe("TypeError");
    expect(projection.rootMessage).toBe("driver typo");
    expect(projection.causeChain.map((frame) => frame.tag ?? frame.name)).toContain(
      "EffectBoundaryFailed"
    );
  });

  test("expired acquire result projects as readiness failure with typed root cause", () => {
    const failure = new AcquireFailed({
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      tag: "diagnostics/request",
      cause: new ResultExpired({
        nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
        tag: "diagnostics/request",
        resultValidity: { _tag: "Expired", loadedAt: 100, staleAt: 150, expiredAt: 200 },
      }),
    });
    const projection = projectError(
      new FrondRuntimeReadError({
        message: "Frond node readiness failed.",
        nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
        kind: "readiness",
        cause: failure,
      })
    );

    expect(projection.headline).toBe("Readiness failed");
    expect(projection.kind).toBe("readiness");
    expect(projection.rootTag).toBe("ResultExpired");
    expect(projection.causeChain.map((frame) => frame.tag ?? frame.name)).toContain(
      "AcquireFailed"
    );
  });

  test("expired refresh command projects as operation failure with typed root cause", () => {
    const failure = new RefreshFailed({
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      tag: "diagnostics/request",
      cause: new ResultExpired({
        nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
        tag: "diagnostics/request",
        resultValidity: { _tag: "Expired", loadedAt: 100, staleAt: 150, expiredAt: 200 },
      }),
    });
    const projection = projectError(failure);

    expect(projection.headline).toBe("Operation failed");
    expect(projection.kind).toBe("operation");
    expect(projection.rootTag).toBe("ResultExpired");
    expect(projection.causeChain.map((frame) => frame.tag ?? frame.name)).toContain(
      "RefreshFailed"
    );
  });

  test("Graph invariant projection preserves invariant text", () => {
    const invariant = new GraphInvariantViolation({
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      tag: "diagnostics/request",
      invariant: "ready dependency must expose graph-owned node object",
    });
    const projection = projectError(invariant);

    expect(projection.rootTag).toBe("GraphInvariantViolation");
    expect(projection.rootMessage).toBe("ready dependency must expose graph-owned node object");
    expect(projection.summary).toBe("ready dependency must expose graph-owned node object");
  });

  test("stopped runtime projects to runtime unavailable", () => {
    const error = new FrondRuntimeUnavailable({
      nodeId: 'diagnostics/stopped:v1:"singleton"' as NodeId,
      message: "Frond runtime is stopped.",
    });
    const projection = projectError(error);

    expect(projection.headline).toBe("Runtime unavailable");
    expect(projection.kind).toBe("runtime");
    expect(projection.rootTag).toBe("FrondRuntimeUnavailable");
  });

  test("unknown thrown values produce explicit fallback projections", () => {
    expect(projectError(new TypeError("broken")).headline).toBe("Unexpected error: TypeError");
    expect(projectError("broken").headline).toBe("Unexpected thrown value");
    expect(projectError(42).headline).toBe("Unexpected thrown value");
    expect(projectError(null).headline).toBe("Unexpected thrown value");
    expect(projectError(undefined).headline).toBe("Unexpected thrown value");
    expect(projectError({ reason: "plain object" }).headline).toBe("Unexpected thrown object");
  });
});
