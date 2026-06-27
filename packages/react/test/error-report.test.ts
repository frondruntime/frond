import { describe, expect, test } from "bun:test";
import { Graph, Runtime } from "@frondruntime/core";
import { getErrorReport } from "../src/errorReport";

class MarketOffline extends Error {
  readonly _tag = "MarketOffline";

  constructor() {
    super("Mock market data is offline.");
    this.name = "MarketOffline";
  }
}

const quoteNodeId = 'expo/quote:v1:{"symbol":"ETH-USD"}' as Graph.NodeId;

describe("React error report", () => {
  test("projects decorated runtime read errors into boundary-facing diagnostics", () => {
    const error = new Runtime.FrondRuntimeReadError({
      message: "Frond node readiness failed.",
      nodeId: quoteNodeId,
      kind: "readiness",
      cause: new Graph.AcquireFailed({
        nodeId: quoteNodeId,
        tag: "expo/quote",
        cause: new MarketOffline(),
      }),
    });

    const report = getErrorReport(error);

    expect(report.headline).toBe("Readiness failed");
    expect(report.summary).toBe("Mock market data is offline.");
    expect(report.message).toBe("Frond readiness failed: MarketOffline");
    expect(report.kind).toBe("readiness");
    expect(report.retryable).toBe(true);
    expect(report.rootTag).toBe("MarketOffline");
    expect(report.rootMessage).toBe("Mock market data is offline.");
    expect(report.nodeId).toBe(quoteNodeId);
    expect(report.nodeTag).toBe("expo/quote");
    expect(report.diagnostic.message).toBe("Frond readiness failed: MarketOffline");
  });
});
