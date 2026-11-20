import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import type { GraphNodeState } from "../src/graph/cell/cellModel";
import { type ActiveCellOperation, type ReadyData, readyCell } from "../src/graph/cell/cellPhase";
import { makeGraphCellState } from "../src/graph/cell/cellState";
import {
  beginNodeOperationState,
  commitReadyOperationState,
  completeNodeOperationState,
  failNodeOperationState,
} from "../src/graph/cell/cellTransitions";
import { makeDisposerRegistry } from "../src/graph/lifecycle/disposers";

function readyState(): GraphNodeState {
  const ready: ReadyData = {
    node: {},
    args: {},
    deps: {},
    result: 0,
    liveLeases: [],
    liveResource: { _tag: "Inactive" },
    resultValidity: { _tag: "Current" },
    resultValidityPolicy: { _tag: "Static" },
    disposers: makeDisposerRegistry(),
    nodeLifetime: new AbortController(),
  };
  return { phase: readyCell(ready), nextOperationId: 1, nextAttemptId: 0, nextLiveGeneration: 1 };
}

function operation(operationId: number): ActiveCellOperation {
  return { _tag: "Running", kind: "refresh", operationId, startedAt: 123 };
}

describe("synchronous cell store", () => {
  test("mutations are immediately readable and Effect adapters share the revision", async () => {
    const initial = readyState();
    const store = makeGraphCellState(initial, 7);
    store.updateSync((latest) => beginNodeOperationState({ latest, operation: operation(1) }));
    expect(store.getSync()).toBe(initial);
    expect(store.getSync().phase._tag).toBe("Operating");
    expect(store.getRevisionSync()).toBe(8);
    expect(await Effect.runPromise(store.get)).toBe(initial);
    await Effect.runPromise(
      store.transition((latest) => [
        undefined,
        completeNodeOperationState({ latest, operation: operation(1) }),
      ])
    );
    expect(store.getSync()).toBe(initial);
    expect(store.getSync().phase._tag).toBe("Ready");
    expect(store.getRevisionSync()).toBe(9);
  });

  test("late completion and failure leave the current operation intact", () => {
    const latest = readyState();
    const active = operation(2);
    beginNodeOperationState({ latest, operation: active });
    const phase = latest.phase;
    completeNodeOperationState({ latest, operation: operation(1) });
    failNodeOperationState({
      latest,
      operation: operation(1),
      failure: {
        operationId: 1,
        kind: "refresh",
        error: new Error("stale"),
        at: 123,
      },
    });
    expect(latest.phase).toBe(phase);
    expect(latest.nextOperationId).toBe(3);
    completeNodeOperationState({ latest, operation: active });
    expect(latest.phase._tag).toBe("Ready");
  });

  test("result commits retain the store and ready record identities", () => {
    const latest = readyState();
    const phase = latest.phase;
    const deps = { service: {} };
    const committed = commitReadyOperationState({
      latest,
      deps,
      resultState: {
        result: 42,
        resultValidity: { _tag: "Current" },
        resultLoadedAt: 456,
        resultValidityCommit: "default",
      },
      operationDisposers: [],
    });
    expect(committed).toBe(latest);
    expect(latest.phase).toBe(phase);
    if (latest.phase._tag !== "Ready") throw new Error("Expected ready cell");
    expect(latest.phase.ready.deps).toBe(deps);
    expect(latest.phase.ready.result).toBe(42);
    expect(latest.phase.ready.resultLoadedAt).toBe(456);
  });
});
