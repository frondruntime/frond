import { describe, expect, test } from "bun:test";
import {
  type ActionContract,
  Driver,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "./graphTestFixtures";

type LifetimeSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
  readonly actions: {
    readonly probe: ActionContract<void, void>;
  };
}>;

// One incarnation per acquire: the fixture records the node-lifetime signal and
// the operation signal seen by each driver hook so tests can pin identity and
// abort timing across close paths and incarnations.
function makeLifetimeProbeNode(tag: string) {
  const captured = {
    acquireNodeSignals: [] as Array<AbortSignal>,
    acquireOperationSignals: [] as Array<AbortSignal>,
    actionCaptures: [] as Array<{
      readonly nodeSignal: AbortSignal;
      readonly operationSignal: AbortSignal;
    }>,
  };

  class LifetimeProbeNode extends NodeBase<LifetimeSpec> {
    static readonly spec = resourceSpec.async<LifetimeSpec>({
      tag,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(async (ctx) => {
        captured.acquireNodeSignals.push(ctx.nodeSignal);
        captured.acquireOperationSignals.push(ctx.signal);
        return "ready";
      }),
      actions: {
        probe: Driver.Action(async (ctx) => {
          captured.actionCaptures.push({
            nodeSignal: ctx.nodeSignal,
            operationSignal: ctx.signal,
          });
        }),
      },
    });
  }

  return { captured, LifetimeProbeNode };
}

describe("node-lifetime signal", () => {
  test("aborts on eviction", async () => {
    const { captured, LifetimeProbeNode } = makeLifetimeProbeNode(
      "graph/resources/node-lifetime-eviction"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: LifetimeProbeNode, args: {} })
    );
    const nodeSignal = captured.acquireNodeSignals[0];

    expect(nodeSignal).toBeInstanceOf(AbortSignal);
    expect(nodeSignal?.aborted).toBe(false);
    // The node-lifetime signal is not the operation signal.
    expect(nodeSignal).not.toBe(captured.acquireOperationSignals[0]);

    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [handle.nodeId],
        mode: "selfAndDependents",
        reason: "node lifetime signal test",
      })
    );

    expect(nodeSignal?.aborted).toBe(true);
  });

  test("aborts on runtime stop", async () => {
    const { captured, LifetimeProbeNode } = makeLifetimeProbeNode(
      "graph/resources/node-lifetime-stop"
    );
    const graph = makeInMemoryGraphSystem();
    await Effect.runPromise(graph.ensureReadyNode({ spec: LifetimeProbeNode, args: {} }));
    const nodeSignal = captured.acquireNodeSignals[0];

    expect(nodeSignal?.aborted).toBe(false);

    await Effect.runPromise(graph.stop());

    expect(nodeSignal?.aborted).toBe(true);
  });

  test("aborts on node release", async () => {
    const { captured, LifetimeProbeNode } = makeLifetimeProbeNode(
      "graph/resources/node-lifetime-release"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: LifetimeProbeNode, args: {} })
    );
    const nodeSignal = captured.acquireNodeSignals[0];

    expect(nodeSignal?.aborted).toBe(false);

    await Effect.runPromise(graph.releaseNode(handle.nodeId));

    expect(nodeSignal?.aborted).toBe(true);
  });

  test("does not abort across an ordinary action and is shared with action hooks", async () => {
    const { captured, LifetimeProbeNode } = makeLifetimeProbeNode(
      "graph/resources/node-lifetime-action"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: LifetimeProbeNode, args: {} })
    );

    await Effect.runPromise(
      graph.runAction({
        target: { _tag: "NodeId", nodeId: handle.nodeId },
        action: "probe",
        input: undefined,
      })
    );

    const nodeSignal = captured.acquireNodeSignals[0];
    const actionCapture = captured.actionCaptures[0];

    expect(nodeSignal?.aborted).toBe(false);
    // Same incarnation, same node-lifetime signal in every hook.
    expect(actionCapture?.nodeSignal).toBe(nodeSignal as AbortSignal);
    // The operation signal is per-operation and distinct from the node signal.
    expect(actionCapture?.operationSignal).not.toBe(nodeSignal as AbortSignal);
    expect(actionCapture?.operationSignal).not.toBe(
      captured.acquireOperationSignals[0] as AbortSignal
    );
    expect(actionCapture?.nodeSignal.aborted).toBe(false);
  });

  test("a fresh incarnation after evict and recreate gets a fresh signal", async () => {
    const { captured, LifetimeProbeNode } = makeLifetimeProbeNode(
      "graph/resources/node-lifetime-recreate"
    );
    const graph = makeInMemoryGraphSystem();
    const first = await Effect.runPromise(
      graph.ensureReadyNode({ spec: LifetimeProbeNode, args: {} })
    );

    await Effect.runPromise(
      graph.evictSubgraph({
        rootNodeIds: [first.nodeId],
        mode: "selfAndDependents",
        reason: "node lifetime recreate test",
      })
    );
    await Effect.runPromise(graph.ensureReadyNode({ spec: LifetimeProbeNode, args: {} }));

    const firstSignal = captured.acquireNodeSignals[0];
    const secondSignal = captured.acquireNodeSignals[1];

    expect(captured.acquireNodeSignals).toHaveLength(2);
    expect(secondSignal).not.toBe(firstSignal as AbortSignal);
    expect(firstSignal?.aborted).toBe(true);
    expect(secondSignal?.aborted).toBe(false);
  });
});
