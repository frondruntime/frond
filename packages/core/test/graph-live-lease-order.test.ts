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

type LeaseOrderSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("live lease ordering", () => {
  test("a lease acquire notifies node change, then live demand, then live failures", async () => {
    class FailingStartNode extends NodeBase<LeaseOrderSpec> {
      static readonly spec = resourceSpec.async<LeaseOrderSpec>({
        tag: "graph/resources/live-lease-order-failing-start",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(async () => "ready"),
        live: Driver.Live({
          start: () => {
            throw new Error("start failed");
          },
          stop: () => undefined,
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: FailingStartNode, args: {} })
    );
    const events: Array<string> = [];
    await Effect.runPromise(
      graph.observeNodeChanges(() =>
        Effect.sync(() => {
          events.push("changed");
        })
      )
    );
    await Effect.runPromise(
      graph.observeLiveDemandChanges((_nodeId, demand) =>
        Effect.sync(() => {
          events.push(`demand:${demand.isLive}`);
        })
      )
    );
    await Effect.runPromise(
      graph.observeLiveFailures((_nodeId, failures) =>
        Effect.sync(() => {
          events.push(`failures:${failures.length}`);
        })
      )
    );

    const result = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    events.push(`returned:${result._tag}`);

    expect(events).toEqual(["changed", "demand:true", "failures:1", "returned:Held"]);
  });

  test("eviction during an in-flight live update rolls the pending lease back", async () => {
    const updates: Array<AbortSignal> = [];
    const stops: Array<{ readonly resource: string; readonly reason: string }> = [];
    let updateStarted: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      updateStarted = resolve;
    });
    class GatedUpdateNode extends NodeBase<LeaseOrderSpec> {
      static readonly spec = resourceSpec.async<LeaseOrderSpec>({
        tag: "graph/resources/live-lease-order-gated-update",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(async () => "ready"),
        live: Driver.Live({
          start: async () => "resource",
          update: (ctx) => {
            updates.push(ctx.signal);
            updateStarted();
            return new Promise<void>(() => {});
          },
          stop: async (ctx, resource) => {
            stops.push({ resource, reason: ctx.reason._tag });
          },
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: GatedUpdateNode, args: {} })
    );
    await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "BTC/USD" },
      })
    );
    const demands: Array<ReadonlyArray<unknown>> = [];
    await Effect.runPromise(
      graph.observeLiveDemandChanges((_nodeId, demand) =>
        Effect.sync(() => {
          demands.push(demand.scopes);
        })
      )
    );

    const pending = Effect.runPromiseExit(
      graph.acquireNodeLiveLease({
        nodeId: handle.nodeId,
        source: "manual",
        scope: { pair: "ETH/USD" },
      })
    );
    await started;
    await Effect.runPromise(
      graph
        .evictSubgraph({
          rootNodeIds: [handle.nodeId],
          mode: "selfAndDependents",
          reason: "live lease rollback test",
        })
        .pipe(Effect.timeout("500 millis"))
    );
    const exit = await pending;
    await waitFor(() => stops.length > 0);

    expect(exit._tag).toBe("Failure");
    expect(updates[0]?.aborted).toBe(true);
    expect(demands).toEqual([[{ pair: "BTC/USD" }]]);
    expect(stops).toEqual([{ resource: "resource", reason: "NodeEvicted" }]);
  });
});
