import { describe, expect, test } from "bun:test";
import type { NodeId } from "../src/graph";
import type { NodeSpec } from "./graphTestFixtures";
import {
  Deferred,
  Driver,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  serviceSpec,
} from "./graphTestFixtures";

type SingletonSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

// A ready node whose one disposer holds its teardown open until the test lets
// it finish, so a snapshot can be read while the release or eviction runs.
function makeHeldTeardownNode(tag: string) {
  const disposing = Deferred.makeUnsafe<void>();
  let finishDisposer = (): void => {};
  const disposerDone = new Promise<void>((resolve) => {
    finishDisposer = resolve;
  });

  class HeldTeardownNode extends NodeBase<SingletonSpec> {
    static readonly spec = serviceSpec.effect<SingletonSpec>({
      tag,
      key: () => Key.singleton(),
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          ctx.disposers.add(() => {
            Deferred.doneUnsafe(disposing, Effect.void);
            return disposerDone;
          });
          return "ready";
        })
      ),
    });
  }

  return { HeldTeardownNode, disposing, finishDisposer: () => finishDisposer() };
}

function snapshotTag(
  graph: ReturnType<typeof makeInMemoryGraphSystem>,
  nodeId: NodeId
): Promise<string | undefined> {
  return Effect.runPromise(
    graph
      .snapshot()
      .pipe(Effect.map((snapshot) => snapshot.nodes.find((node) => node.nodeId === nodeId)?._tag))
  );
}

// The public `NodeSnapshot` keeps its `Releasing` tag for source compatibility,
// but no cell phase produces it, in 0.5 or 0.6: a node being released or
// evicted reports its last ready snapshot until its teardown ends.
describe("releasing snapshot", () => {
  test("a node being released never reports a Releasing snapshot", async () => {
    const { HeldTeardownNode, disposing, finishDisposer } = makeHeldTeardownNode(
      "services/releasing-snapshot-release"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: HeldTeardownNode, args: {} })
    );

    const release = Effect.runPromise(graph.releaseNode(handle.nodeId));
    await Effect.runPromise(Deferred.await(disposing));
    const during = await snapshotTag(graph, handle.nodeId);
    finishDisposer();
    await release;
    const after = await snapshotTag(graph, handle.nodeId);

    expect(during).toBe("Ready");
    expect(after).toBe("Idle");
  });

  test("a node being evicted never reports a Releasing snapshot", async () => {
    const { HeldTeardownNode, disposing, finishDisposer } = makeHeldTeardownNode(
      "services/releasing-snapshot-evict"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: HeldTeardownNode, args: {} })
    );

    const eviction = Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
    );
    await Effect.runPromise(Deferred.await(disposing));
    const during = await snapshotTag(graph, handle.nodeId);
    finishDisposer();
    await eviction;
    const after = await snapshotTag(graph, handle.nodeId);

    expect(during).toBe("Ready");
    expect(after).toBeUndefined();
  });
});
