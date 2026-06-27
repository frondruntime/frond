import { describe, expect, test } from "bun:test";
import { Deferred, Effect } from "effect";
import type { NodeId, NodeLiveLeaseId, NodeLiveScopeKey, NodeRead } from "../src/graph";
import {
  type ActiveCellOperation,
  acquiringCell,
  type CellBase,
  type CellLiveLease,
  type CellReadinessAttempt,
  evictedCell,
  idleCell,
  invalidCell,
  operatingCell,
  phaseBase,
  phaseReadinessAttempt,
  phaseReadyData,
  projectCellPhase,
  projectLiveDemand,
  type ReadyData,
  readinessErrorCell,
  readyCell,
  releasingCell,
} from "../src/graph/cell/cellPhase";
import { makeGraphCellState } from "../src/graph/cell/cellState";
import { runBackgroundOperation } from "../src/graph/operations/operationState";
import type { GraphNodeCell, GraphNodeState } from "../src/graph/planning/plan";

describe("graph cell phase", () => {
  test("idle projects as wired idle with retained identity data", () => {
    const base = makeBase({ resultObserved: true });
    const projection = projectCellPhase(idleCell(base));

    expect(projection._tag).toBe("Idle");
    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect("node" in projection).toBe(false);
    expect(projection.args).toBe(base.args);
    expect(projection.liveDemand).toEqual({
      isLive: true,
      sources: ["mobx"],
      scopes: [base.liveLeases[0]?.scope],
    });
    expect(projection.operation).toEqual({ _tag: "Idle" });
    expect(projection.failure).toEqual({ _tag: "None" });
    expect("result" in projection).toBe(false);
    expect("attempt" in projection).toBe(false);
  });

  test("idle can project retained cleanup failure", () => {
    const base = makeBase();
    const cleanupFailure = new Error("release cleanup failed");
    const projection = projectCellPhase(idleCell(base, cleanupFailure));

    expect(projection._tag).toBe("Idle");
    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(projection.failure).toEqual({ _tag: "Present", failure: cleanupFailure });
  });

  test("acquiring projects as pending with a graph-owned attempt", () => {
    const base = makeBase();
    const attempt = makeAttempt(7);
    const projection = projectCellPhase(acquiringCell(base, attempt));

    expect(projection._tag).toBe("Pending");
    expect(projection.status).toEqual({
      _tag: "Wired",
      run: { _tag: "Pending", attemptId: 7 },
    });
    expect(projection.attempt).toBe(attempt.promise);
    expect("node" in projection).toBe(false);
  });

  test("readiness error projects as readiness failure without operation failure", () => {
    const base = makeBase();
    const error = new Error("backend failed");
    const projection = projectCellPhase(readinessErrorCell(base, error));

    expect(projection._tag).toBe("ReadinessError");
    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Error", error } });
    expect(projection.failure).toEqual({ _tag: "Present", failure: error });
    expect(projection.operation).toEqual({ _tag: "Idle" });
    expect(projection.operationFailure).toBeUndefined();
  });

  test("ready projects as consumer-ready with explicit result", () => {
    const ready = makeReadyData({ result: { timezone: "UTC" } });
    const projection = projectCellPhase(readyCell(ready));

    expect(projection._tag).toBe("Ready");
    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(projection.node).toBe(ready.node);
    expect(projection.result).toBe(ready.result);
    expect(projection.operation).toEqual({ _tag: "Idle" });
  });

  test("ready projection preserves undefined as an explicit result", () => {
    const ready = makeReadyData({ result: undefined });
    const projection = projectCellPhase(readyCell(ready));

    expect(projection._tag).toBe("Ready");
    expect("result" in projection).toBe(true);
    expect(projection.result).toBeUndefined();
  });

  test("ready can project the last background operation failure without poisoning readiness", () => {
    const ready = makeReadyData({ result: { timezone: "UTC" } });
    const error = new Error("toast-worthy failure");
    const operationFailure = {
      operationId: 11,
      kind: "action",
      error,
      at: 123,
    } as const;
    const projection = projectCellPhase(readyCell(ready, operationFailure));

    expect(projection._tag).toBe("Ready");
    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(projection.result).toBe(ready.result);
    expect(projection.failure).toEqual({ _tag: "None" });
    expect(projection.operationFailure).toBe(operationFailure);
  });

  test("operating projects as ready and busy with the previous result", () => {
    const ready = makeReadyData({ result: { page: 1 } });
    const previous = makeReadyData({ result: { page: 0 } });
    const operation: ActiveCellOperation = {
      _tag: "Running",
      operationId: 12,
      kind: "args",
      startedAt: 456,
    };
    const projection = projectCellPhase(operatingCell(ready, operation, previous));

    expect(projection._tag).toBe("Ready");
    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(projection.result).toBe(ready.result);
    expect(projection.operation).toBe(operation);
    expect(projection.operationFailure).toBeUndefined();
  });

  test("background operation failure before result settles operation state", async () => {
    const ready = makeReadyData({ result: { page: 1 } });
    const cell = await makeCell(readyCell(ready));

    await expect(
      Effect.runPromise(
        runBackgroundOperation(cell, "refresh", () => Effect.fail(new Error("body failed")))
      )
    ).rejects.toThrow("body failed");

    const state = await Effect.runPromise(cell.state.get);
    const projection = projectCellPhase(state.phase);

    expect(projection._tag).toBe("Ready");
    expect(projection.operation).toEqual({ _tag: "Idle" });
    expect(projection.operationFailure).toMatchObject({
      operationId: 0,
      kind: "refresh",
      error: {
        _tag: "GraphInvariantViolation",
        invariant: "refresh operation failed before returning an operation result",
      },
    });
  });

  test("releasing projects as wired idle while retained identity exists", () => {
    const base = makeBase();
    const projection = projectCellPhase(releasingCell(base));

    expect(projection._tag).toBe("Releasing");
    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect("node" in projection).toBe(false);
    expect("result" in projection).toBe(false);
  });

  test("releasing can project cleanup failure", () => {
    const base = makeBase();
    const cleanupFailure = new Error("cleanup failed");
    const projection = projectCellPhase(releasingCell(base, cleanupFailure));

    expect(projection._tag).toBe("Releasing");
    expect(projection.failure).toEqual({ _tag: "Present", failure: cleanupFailure });
  });

  test("invalid projects as non-ready failure", () => {
    const base = makeBase();
    const error = new Error("cycle");
    const projection = projectCellPhase(invalidCell(error, base));

    expect(projection._tag).toBe("Invalid");
    expect(projection.status).toEqual({ _tag: "Invalid", error });
    expect(projection.failure).toEqual({ _tag: "Present", failure: error });
    expect(projection.nodeLookup).toEqual({ _tag: "Missing" });
    expect("node" in projection).toBe(false);
    expect("result" in projection).toBe(false);
  });

  test("evicted projects as removed", () => {
    const projection = projectCellPhase(evictedCell("manual"));

    expect(projection).toEqual({ _tag: "Removed", reason: "manual" });
  });

  test("base lookup is explicit across phases", () => {
    const base = makeBase();
    const ready = makeReadyData({ result: "ready" });
    const attempt = makeAttempt(3);

    expect(phaseBase(idleCell(base))).toEqual({ _tag: "Found", base });
    expect(phaseBase(acquiringCell(base, attempt))).toEqual({ _tag: "Found", base });
    expect(phaseBase(readinessErrorCell(base, new Error("failed")))).toEqual({
      _tag: "Found",
      base,
    });
    expect(phaseBase(readyCell(ready))).toMatchObject({
      _tag: "Found",
      base: { args: ready.args, liveLeases: ready.liveLeases },
    });
    expect(phaseBase(operatingCell(ready, makeOperation(4)))).toMatchObject({
      _tag: "Found",
      base: { args: ready.args, liveLeases: ready.liveLeases },
    });
    expect(phaseBase(releasingCell(base))).toEqual({ _tag: "Found", base });
    expect(phaseBase(invalidCell(new Error("cycle"), base))).toEqual({ _tag: "Found", base });
    expect(phaseBase(invalidCell(new Error("cycle")))).toEqual({
      _tag: "Missing",
      phase: "Invalid",
    });
    expect(phaseBase(evictedCell("manual"))).toEqual({ _tag: "Missing", phase: "Evicted" });
  });

  test("ready lookup is explicit and preserves undefined results", () => {
    const base = makeBase();
    const ready = makeReadyData({ result: undefined });
    const attempt = makeAttempt(5);

    expect(phaseReadyData(idleCell(base))).toEqual({ _tag: "Missing", phase: "Idle" });
    expect(phaseReadyData(acquiringCell(base, attempt))).toEqual({
      _tag: "Missing",
      phase: "Acquiring",
    });
    expect(phaseReadyData(readinessErrorCell(base, new Error("failed")))).toEqual({
      _tag: "Missing",
      phase: "ReadinessError",
    });
    expect(phaseReadyData(readyCell(ready))).toEqual({ _tag: "Found", ready });
    expect(phaseReadyData(operatingCell(ready, makeOperation(6)))).toEqual({
      _tag: "Found",
      ready,
    });
    expect(phaseReadyData(releasingCell(base))).toEqual({
      _tag: "Missing",
      phase: "Releasing",
    });
    expect(phaseReadyData(invalidCell(new Error("cycle"), base))).toEqual({
      _tag: "Missing",
      phase: "Invalid",
    });
    expect(phaseReadyData(evictedCell("manual"))).toEqual({
      _tag: "Missing",
      phase: "Evicted",
    });

    const lookup = phaseReadyData(readyCell(ready));

    if (lookup._tag !== "Found") {
      throw new Error("Expected ready lookup.");
    }

    expect("result" in lookup.ready).toBe(true);
    expect(lookup.ready.result).toBeUndefined();
  });

  test("readiness attempt lookup is explicit", () => {
    const base = makeBase();
    const ready = makeReadyData({ result: "ready" });
    const attempt = makeAttempt(8);

    expect(phaseReadinessAttempt(idleCell(base))).toEqual({
      _tag: "Missing",
      phase: "Idle",
    });
    expect(phaseReadinessAttempt(acquiringCell(base, attempt))).toEqual({
      _tag: "Found",
      attempt,
    });
    expect(phaseReadinessAttempt(readinessErrorCell(base, new Error("failed")))).toEqual({
      _tag: "Missing",
      phase: "ReadinessError",
    });
    expect(phaseReadinessAttempt(readyCell(ready))).toEqual({
      _tag: "Missing",
      phase: "Ready",
    });
    expect(phaseReadinessAttempt(operatingCell(ready, makeOperation(9)))).toEqual({
      _tag: "Missing",
      phase: "Operating",
    });
    expect(phaseReadinessAttempt(releasingCell(base))).toEqual({
      _tag: "Missing",
      phase: "Releasing",
    });
    expect(phaseReadinessAttempt(invalidCell(new Error("cycle"), base))).toEqual({
      _tag: "Missing",
      phase: "Invalid",
    });
    expect(phaseReadinessAttempt(evictedCell("manual"))).toEqual({
      _tag: "Missing",
      phase: "Evicted",
    });
  });

  test("live demand deduplicates sources and preserves observed scopes", () => {
    const manualScope = { owner: "test" };
    const mobxScope = { owner: "mobx" };
    const demand = projectLiveDemand([
      makeLease("manual", manualScope),
      makeLease("mobx", mobxScope),
      makeLease("manual", manualScope),
    ]);

    expect(demand).toEqual({
      isLive: true,
      sources: ["manual", "mobx"],
      scopes: [manualScope, mobxScope],
    });
  });

  test("live demand with no leases projects as inactive", () => {
    const demand = projectLiveDemand([]);

    expect(demand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });
    expect(projectLiveDemand([])).toBe(demand);
  });
});

function makeBase(options: { readonly resultObserved?: boolean } = {}): CellBase {
  const liveLeases = options.resultObserved ? [makeLease("mobx", { owner: "result" })] : [];

  return {
    args: { id: "profile" },
    liveLeases,
  };
}

function makeOperation(operationId: number): ActiveCellOperation {
  return {
    _tag: "Running",
    operationId,
    kind: "refresh",
    startedAt: operationId * 100,
  };
}

function makeReadyData(options: { readonly result: unknown }): ReadyData {
  const base = makeBase();

  return {
    ...base,
    node: { kind: "node" },
    deps: { transport: { kind: "transport" } },
    result: options.result,
    resultValidity: { _tag: "Current" },
    resultValidityPolicy: { _tag: "Static" },
    disposers: [],
    liveResource: { _tag: "Inactive" },
  };
}

function makeAttempt(attemptId: number): CellReadinessAttempt {
  return {
    attemptId,
    deferred: Deferred.makeUnsafe<NodeRead>(),
    promise: Promise.resolve({
      nodeId: 'resources/profile:{"id":"profile"}' as NodeId,
      status: { _tag: "Wired", run: { _tag: "Ready" } },
    } satisfies NodeRead),
    resolve: () => {},
  };
}

function makeLease(source: "manual" | "mobx", scope: unknown): CellLiveLease {
  return {
    leaseId: `lease:${source}` as NodeLiveLeaseId,
    source,
    scope,
    scopeKey: `scope:${source}` as NodeLiveScopeKey,
  };
}

async function makeCell(phase: GraphNodeState["phase"]): Promise<GraphNodeCell> {
  const state = makeGraphCellState({
    nextOperationId: 0,
    nextAttemptId: 0,
    phase,
  } satisfies GraphNodeState);

  return {
    nodeId: 'resources/profile:{"id":"profile"}' as NodeId,
    tag: "resources/profile",
    kind: "resource",
    key: '{"id":"profile"}' as never,
    label: "resources/profile",
    request: { spec: {}, args: {} },
    originalRequest: { spec: {}, args: {} },
    descriptor: {} as never,
    dependencies: {},
    state,
    notifyOperationStarted: () => Effect.void,
    notifyChanged: () => Effect.void,
    notifyResultValidityChanged: () => Effect.void,
  };
}
