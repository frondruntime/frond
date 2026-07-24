import { describe, expect, test } from "bun:test";
import { projectError, serializeCauseChain } from "../src/diagnostics";
import {
  EffectBoundaryFailed,
  GraphInvariantViolation,
  NodeEvicted,
  type NodeId,
} from "../src/graph";

describe("Frond diagnostics cause serialization", () => {
  test("cause serialization is bounded, stack-preserving, redacted, and hostile-safe", () => {
    const cyclic: { secretToken: string; self?: unknown } = { secretToken: "secret" };
    cyclic.self = cyclic;
    const error = new Error("outer", { cause: cyclic });
    const hostile = {
      get cause() {
        throw new Error("hostile getter");
      },
    };

    const cyclicFrames = serializeCauseChain(error);
    const hostileProjection = projectError(hostile);

    expect(cyclicFrames[0]?.stack).toContain("Error: outer");
    expect(JSON.stringify(cyclicFrames)).toContain("[Redacted]");
    expect(JSON.stringify(cyclicFrames)).toContain("[Circular]");
    expect(hostileProjection.headline).toBe("Unexpected thrown object");
    expect(hostileProjection.causeChain[0]?.preview).toMatchObject({
      cause: expect.stringContaining("hostile getter"),
    });
  });

  test("shared preview references are not labeled circular but true cycles are", () => {
    const shared = { id: "shared" };
    const cycle: { readonly label: string; self?: unknown } = { label: "cycle" };
    cycle.self = cycle;

    const [frame] = serializeCauseChain(
      {
        first: shared,
        second: shared,
        cycle,
      },
      { maxDepth: 6 }
    );

    expect(frame?.preview).toMatchObject({
      first: { id: "shared" },
      second: { id: "shared" },
      cycle: {
        label: "cycle",
        self: "[Circular]",
      },
    });
  });

  test("cause serialization preserves boundary and invariant fields", () => {
    const invariant = new GraphInvariantViolation({
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      tag: "diagnostics/request",
      invariant: "dependency cell must exist before dependency readiness awaits",
    });
    const boundary = new EffectBoundaryFailed({
      boundary: "runtime-sink",
      cause: invariant,
      effectCause: { _tag: "TestCause" },
      pretty: "GraphInvariantViolation",
    });
    const frames = serializeCauseChain(boundary);

    expect(frames[0]?.boundary).toBe("runtime-sink");
    expect(frames[1]?.invariant).toBe(
      "dependency cell must exist before dependency readiness awaits"
    );
  });

  test("cause serialization preserves typed cancellation reason", () => {
    const evicted = new NodeEvicted({
      nodeId: 'diagnostics/request:v1:"singleton"' as NodeId,
      tag: "diagnostics/request",
      cancellation: { _tag: "Evicted", detail: "manual test eviction" },
      reason: "manual test eviction",
    });
    const frames = serializeCauseChain(evicted);

    expect(frames[0]?.cancellation).toEqual({
      _tag: "Evicted",
      detail: "manual test eviction",
    });
  });
});
