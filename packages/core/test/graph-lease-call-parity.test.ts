import { describe, expect, test } from "bun:test";
import type { NodeId } from "../src/graph";
import type { RuntimeSink } from "../src/index";
import {
  createRuntime,
  Driver,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "./graphTestFixtures";

type AsyncSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

type EffectSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

const settle = async (rounds = 20): Promise<void> => {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
};

describe("lease call parity", () => {
  test("eviction interrupts an in-flight Effect update while the lease rollback waits", async () => {
    const events: string[] = [];
    const updateStarted = Promise.withResolvers<void>();
    const updateFinalized = Promise.withResolvers<void>();
    class EffectUpdateNode extends NodeBase<EffectSpec> {
      static readonly spec = resourceSpec.effect<EffectSpec>({
        tag: "graph/resources/lease-parity-effect-update",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
        live: Driver.Live({
          start: () => Effect.succeed("resource"),
          update: (_ctx, _resource, demand) =>
            demand.scopes.length > 1
              ? Effect.sync(() => updateStarted.resolve()).pipe(
                  Effect.andThen(Effect.never),
                  Effect.ensuring(
                    Effect.sync(() => {
                      events.push("update:finalized");
                      updateFinalized.resolve();
                    })
                  )
                )
              : Effect.void,
          stop: () => Effect.void,
        }),
      });
    }
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: EffectUpdateNode, args: {} })
    );
    await Effect.runPromise(
      graph.acquireNodeLiveLease({ nodeId: handle.nodeId, source: "manual", scope: { pair: "A" } })
    );
    await Effect.runPromise(
      graph.observeLiveDemandChanges(() =>
        Effect.sync(() => {
          events.push("rollback:waiting");
        }).pipe(Effect.andThen(Effect.promise(() => updateFinalized.promise)))
      )
    );

    const pending = Effect.runPromiseExit(
      graph.acquireNodeLiveLease({ nodeId: handle.nodeId, source: "manual", scope: { pair: "B" } })
    );
    await updateStarted.promise;
    const evicted = await Effect.runPromiseExit(
      graph
        .evictSubgraph({
          rootNodeIds: [handle.nodeId],
          mode: "selfAndDependents",
          reason: "lease parity rollback",
        })
        .pipe(Effect.timeout("500 millis"))
    );

    expect(events).toEqual(["rollback:waiting", "update:finalized"]);
    expect(evicted._tag).toBe("Success");
    expect((await pending)._tag).toBe("Failure");
  }, 3000);

  test("runtime stop leaves a lease call's pending live-demand sink to finish", async () => {
    type Spec = NodeSpec<{
      readonly mode: "async";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;
    class Resource extends NodeBase<Spec> {
      static readonly spec = resourceSpec.async<Spec>({
        tag: "graph/resources/lease-parity-stop-sink",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => "ready"),
        live: Driver.Live({ start: () => "live", stop: () => undefined }),
      });
    }
    const events: string[] = [];
    const parked = Promise.withResolvers<void>();
    const gate = { parked: false, release: () => {} };
    const sink: RuntimeSink = {
      name: "parked-live-demand",
      handle: (record) =>
        record.event._tag === "GraphNodeLiveDemandChanged" && !gate.parked
          ? Effect.callback<void>((resume) => {
              gate.parked = true;
              gate.release = () => resume(Effect.void);
              parked.resolve();
            }).pipe(
              Effect.onInterrupt(() => Effect.sync(() => events.push("sink:interrupted"))),
              Effect.ensuring(Effect.sync(() => events.push("sink:finalized")))
            )
          : Effect.void,
    };
    const runtime = createRuntime({ development: true, eventBufferSize: 512, sinks: [sink] });
    const handle = runtime.client.node(Resource, {});
    await handle.ensureReadyNode();
    const lease = handle.acquireLiveLease("manual", { pair: "A" }).then((result) => {
      events.push(`lease:${result._tag}`);
    });
    await parked.promise;
    await runtime.submit({ _tag: "RuntimeStop" });
    events.push("stop:done");
    await settle();
    const atStop = [...events];

    gate.release();
    await lease;

    expect(atStop).toEqual(["stop:done"]);
    expect(events).toEqual(["stop:done", "sink:finalized", "lease:Held"]);
  }, 3000);

  function gatedStartFixture() {
    const events: string[] = [];
    const startGate = Promise.withResolvers<void>();
    const startEntered = Promise.withResolvers<void>();
    class GatedStartNode extends NodeBase<AsyncSpec> {
      static readonly spec = resourceSpec.async<AsyncSpec>({
        tag: "graph/resources/lease-parity-gated-start",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(async () => "ready"),
        live: Driver.Live({
          start: async (ctx) => {
            events.push("start");
            ctx.signal.addEventListener("abort", () => events.push("start:aborted"));
            startEntered.resolve();
            await startGate.promise;
            return "r1";
          },
          stop: (ctx, resource) => {
            events.push(`stop:${resource}:${ctx.reason._tag}`);
          },
        }),
      });
    }
    return { events, startGate, startEntered, GatedStartNode };
  }

  async function observeAll(
    graph: ReturnType<typeof makeInMemoryGraphSystem>,
    events: string[]
  ): Promise<void> {
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
  }

  /**
   * Queues a marker behind the release in the node's cell queue and returns
   * once both are queued behind the in-flight acquire. The marker releases a
   * lease the node never held: it commits the cell, so the revision moves, but
   * it leaves the lease values and the demand unchanged and sends no notice.
   * The cell queue runs in order, so a marker that settles after the release
   * shows the release was queued before it. A lease call for a missing node is
   * planned behind both, so its result shows both have reached the queue.
   */
  async function queueMarkerBehindRelease(
    graph: ReturnType<typeof makeInMemoryGraphSystem>,
    nodeId: NodeId,
    events: string[]
  ): Promise<{ readonly settled: Promise<void> }> {
    const marker = Effect.runPromiseExit(
      graph.releaseNodeLiveLease({ nodeId, leaseId: "live-lease:marker" as never })
    ).then((exit) => {
      events.push(`marker:${exit._tag === "Success" ? exit.value._tag : exit._tag}`);
    });
    const probe = await Effect.runPromise(
      graph.acquireNodeLiveLease({
        nodeId: "graph/resources/lease-parity-queue-probe" as NodeId,
        source: "manual",
        scope: {},
      })
    );
    expect(probe._tag).toBe("NodeMissing");
    return { settled: marker };
  }

  test("an acquire caller resumes before the queued release's notices", async () => {
    const { events, startGate, startEntered, GatedStartNode } = gatedStartFixture();
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: GatedStartNode, args: {} })
    );
    await observeAll(graph, events);

    // Each caller logs in its own fiber, the turn it resumes.
    const acquire = Effect.runPromise(
      graph
        .acquireNodeLiveLease({ nodeId: handle.nodeId, source: "manual", scope: { pair: "A" } })
        .pipe(Effect.tap((result) => Effect.sync(() => events.push(`acquire:${result._tag}`))))
    );
    await startEntered.promise;
    const release = Effect.runPromise(
      graph
        .releaseNodeLiveLease({ nodeId: handle.nodeId, leaseId: "live-lease:1" as never })
        .pipe(Effect.tap((result) => Effect.sync(() => events.push(`release:${result._tag}`))))
    );
    const marker = (await queueMarkerBehindRelease(graph, handle.nodeId, events)).settled;
    events.length = 0;
    startGate.resolve();
    await Promise.all([acquire, release, marker]);

    expect(events).toEqual([
      "changed",
      "demand:true",
      "acquire:Held",
      "stop:r1:DemandInactive",
      "changed",
      "demand:false",
      "release:Held",
      "marker:Held",
    ]);
  }, 3000);

  test("graph stop resumes the in-flight acquire caller before the queued release caller", async () => {
    const { events, startEntered, GatedStartNode } = gatedStartFixture();
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: GatedStartNode, args: {} })
    );
    await observeAll(graph, events);

    const acquire = Effect.runPromiseExit(
      graph.acquireNodeLiveLease({ nodeId: handle.nodeId, source: "manual", scope: { pair: "A" } })
    ).then((exit) => {
      events.push(`acquire:${exit._tag}`);
    });
    await startEntered.promise;
    const release = Effect.runPromiseExit(
      graph.releaseNodeLiveLease({
        nodeId: handle.nodeId,
        leaseId: "live-lease:1" as never,
      })
    ).then((exit) => {
      events.push(`release:${exit._tag}`);
    });
    const marker = (await queueMarkerBehindRelease(graph, handle.nodeId, events)).settled;
    events.length = 0;
    const stopped = Effect.runPromiseExit(graph.stop()).then((exit) => {
      events.push(`stop:${exit._tag}`);
    });
    await Promise.all([acquire, release, marker, stopped]);

    const callers = events.filter(
      (event) =>
        event.startsWith("acquire:") || event.startsWith("release:") || event.startsWith("marker:")
    );
    expect(callers).toEqual(["acquire:Failure", "release:Failure", "marker:Failure"]);
  }, 3000);
});
