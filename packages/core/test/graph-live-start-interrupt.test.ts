import { describe, expect, test } from "bun:test";
import {
  Driver,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "./graphTestFixtures";

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

type GatedLiveSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

// Fixture shape shared by the interrupt-atomicity scenarios: an async driver
// whose live start ignores its abort signal and settles only when the test
// releases the gate — potentially after the surrounding lease operation was
// interrupted by stop, eviction, or a driver timeout.
function makeGatedLiveStartNode(tag: string) {
  let releaseGate: (resource: string) => void = () => {};
  let markStarted: () => void = () => {};
  const harness = {
    startSignals: [] as Array<AbortSignal>,
    stops: [] as Array<{ readonly resource: string; readonly reason: string }>,
    resolveStart: (resource: string) => releaseGate(resource),
    started: new Promise<void>((resolve) => {
      markStarted = resolve;
    }),
  };

  class GatedLiveNode extends NodeBase<GatedLiveSpec> {
    static readonly spec = resourceSpec.async<GatedLiveSpec>({
      tag,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(async () => "ready"),
      live: Driver.Live({
        start: (ctx) => {
          harness.startSignals.push(ctx.signal);
          markStarted();

          // Deliberately ignores ctx.signal: models a driver whose in-flight
          // promise cannot be cancelled and settles with a real resource after
          // the runtime already moved on.
          return new Promise<string>((resolve) => {
            releaseGate = resolve;
          });
        },
        stop: async (ctx, resource) => {
          harness.stops.push({ resource, reason: ctx.reason._tag });
        },
      }),
    });
  }

  return { harness, GatedLiveNode };
}

describe("live start interrupt atomicity", () => {
  test("graph stop during live start routes a late-settling resource into stop", async () => {
    const { harness, GatedLiveNode } = makeGatedLiveStartNode(
      "graph/resources/live-start-interrupt-graph-stop"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: GatedLiveNode, args: {} })
    );
    const leasePromise = Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    ).catch(() => undefined);

    await harness.started;
    await Effect.runPromise(graph.stop().pipe(Effect.timeout("500 millis")));
    await leasePromise;

    expect(harness.stops).toEqual([]);

    // The interrupted start settles with a resource only now. The runtime must
    // still route it into the driver stop hook instead of dropping it.
    harness.resolveStart("late-resource");
    await waitFor(() => harness.stops.length > 0);

    expect(harness.stops).toEqual([{ resource: "late-resource", reason: "StartInterrupted" }]);
  });

  test("eviction during live start routes a late-settling resource into stop", async () => {
    const { harness, GatedLiveNode } = makeGatedLiveStartNode(
      "graph/resources/live-start-interrupt-eviction"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: GatedLiveNode, args: {} })
    );
    const leasePromise = Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    ).catch(() => undefined);

    await harness.started;
    await Effect.runPromise(
      graph
        .evictSubgraph({
          rootNodeIds: [handle.nodeId],
          mode: "selfAndDependents",
          reason: "live start interrupt test",
        })
        .pipe(Effect.timeout("500 millis"))
    );
    await leasePromise;

    expect(harness.stops).toEqual([]);

    harness.resolveStart("late-resource");
    await waitFor(() => harness.stops.length > 0);

    expect(harness.stops).toEqual([{ resource: "late-resource", reason: "StartInterrupted" }]);
    expect(harness.startSignals[0]?.aborted).toBe(true);
  });

  test("live start that outlives its timeout still stops the late resource", async () => {
    const { harness, GatedLiveNode } = makeGatedLiveStartNode(
      "graph/resources/live-start-timeout-orphan"
    );
    const graph = makeInMemoryGraphSystem({
      runtimeId: "mock-test-runtime",
      driverTimeouts: { live: 5 },
    });
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: GatedLiveNode, args: {} })
    );

    const lease = await Effect.runPromise(
      graph
        .acquireNodeLiveLease({
          nodeId: handle.nodeId,
          source: "manual",
          scope: { pair: "BTC/USD" },
        })
        .pipe(Effect.timeout("500 millis"))
    );

    expect(lease._tag).toBe("Held");
    expect(harness.stops).toEqual([]);

    harness.resolveStart("late-resource");
    await waitFor(() => harness.stops.length > 0);

    expect(harness.stops).toEqual([{ resource: "late-resource", reason: "StartInterrupted" }]);
  });

  test("a committed live start is stopped exactly once through the normal path", async () => {
    // Regression pin: the orphan routing must not double-stop a resource that
    // was committed normally and later stopped by demand release.
    const { harness, GatedLiveNode } = makeGatedLiveStartNode(
      "graph/resources/live-start-committed"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: GatedLiveNode, args: {} })
    );
    const leasePromise = Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );

    await harness.started;
    harness.resolveStart("committed-resource");
    const lease = await leasePromise;

    expect(lease._tag).toBe("Held");

    if (lease._tag !== "Held") {
      throw new Error("Expected live lease to be held.");
    }

    await Effect.runPromise(
      graph.releaseNodeLiveLease({ nodeId: handle.nodeId, leaseId: lease.leaseId })
    );
    await Effect.runPromise(graph.stop());
    await waitFor(() => harness.stops.length > 0);

    expect(harness.stops).toEqual([{ resource: "committed-resource", reason: "DemandInactive" }]);
  });
});
