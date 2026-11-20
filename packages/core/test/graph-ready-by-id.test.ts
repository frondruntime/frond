import { describe, expect, test } from "bun:test";
import { Effect, Exit, Fiber } from "effect";
import type { NodeId } from "../src/graph";
import type { NodeSpec } from "./graphTestFixtures";
import { Driver, Key, makeInMemoryGraphSystem, NodeBase, serviceSpec } from "./graphTestFixtures";

// The graph service's ready-by-id and ensure-node calls, as the Effect surface sees them.

type SlowSpec = NodeSpec<{
  readonly mode: "effect";
  readonly key: Key.Singleton;
  readonly result: { readonly ready: true };
}>;

function makeSlowNode(name: string) {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = { acquires: 0, acquireAborted: false };

  class SlowNode extends NodeBase<SlowSpec> {
    static readonly spec = serviceSpec.effect<SlowSpec>({
      tag: name,
      key: () => Key.singleton(),
      acquire: Driver.Acquire((ctx) =>
        Effect.gen(function* () {
          probe.acquires += 1;
          ctx.signal.addEventListener("abort", () => {
            probe.acquireAborted = true;
          });
          yield* Effect.promise(() => opened);
          return { ready: true as const };
        })
      ),
    });
  }

  return { SlowNode, probe, release: () => release() };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("graph ensureReadyNodeById", () => {
  test("an unplanned node id reads Unwired", async () => {
    const graph = makeInMemoryGraphSystem();
    const nodeId = "graph-ready-by-id/missing" as NodeId;

    const read = await Effect.runPromise(graph.ensureReadyNodeById(nodeId));

    expect(read).toEqual({ _tag: "Unwired", nodeId, status: { _tag: "Unwired" } });
  });

  test("a planned node id runs readiness and reads Ready", async () => {
    const { SlowNode, probe, release } = makeSlowNode("graph-ready-by-id/ready");
    const graph = makeInMemoryGraphSystem();
    const { nodeId } = await Effect.runPromise(graph.ensureNode({ spec: SlowNode, args: {} }));
    release();

    const read = await Effect.runPromise(graph.ensureReadyNodeById(nodeId));

    expect(read._tag).toBe("Ready");
    expect(probe.acquires).toBe(1);
  });

  test("interrupting the sole caller mid-acquire leaves the graph-owned attempt running", async () => {
    const { SlowNode, probe, release } = makeSlowNode("graph-ready-by-id/interrupt");
    const graph = makeInMemoryGraphSystem();
    const { nodeId } = await Effect.runPromise(graph.ensureNode({ spec: SlowNode, args: {} }));

    const fiber = Effect.runFork(graph.ensureReadyNodeById(nodeId));
    await tick();
    expect(probe.acquires).toBe(1);
    const exit = await Effect.runPromise(
      Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)))
    );

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(probe.acquireAborted).toBe(false);
    release();
    const read = await Effect.runPromise(graph.ensureReadyNodeById(nodeId));
    expect(read._tag).toBe("Ready");
    expect(probe.acquires).toBe(1);
  });
});
