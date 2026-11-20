import { describe, expect, test } from "bun:test";
import { Exit } from "effect";
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

// A ready node that records its node-lifetime signal and whose one disposer
// holds its teardown open until the test lets it finish.
function makeHeldReleaseNode(tag: string) {
  const disposing = Deferred.makeUnsafe<void>();
  const nodeSignals: Array<AbortSignal> = [];
  let finishDisposer = (): void => {};
  const disposerDone = new Promise<void>((resolve) => {
    finishDisposer = resolve;
  });

  class HeldReleaseNode extends NodeBase<SingletonSpec> {
    static readonly spec = serviceSpec.effect<SingletonSpec>({
      tag,
      key: () => Key.singleton(),
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          nodeSignals.push(ctx.nodeSignal);
          ctx.disposers.add(() => {
            Deferred.doneUnsafe(disposing, Effect.void);
            return disposerDone;
          });
          return "ready";
        })
      ),
    });
  }

  return { HeldReleaseNode, disposing, nodeSignals, finishDisposer: () => finishDisposer() };
}

// 0.5 built `{ _tag: "Released", detail: reason }` for an interrupted release
// and then dropped it (`interruptCellOperation` on master: `void reason`), so
// the reason passed to `releaseNode` reaches no driver hook and no caller.
describe("release reason", () => {
  test("a released node's lifetime signal carries the close detail, not the reason", async () => {
    const { HeldReleaseNode, nodeSignals, finishDisposer } = makeHeldReleaseNode(
      "services/release-reason-signal"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: HeldReleaseNode, args: {} })
    );

    finishDisposer();
    await Effect.runPromise(graph.releaseNode(handle.nodeId, "manual release"));

    expect(nodeSignals[0]?.aborted).toBe(true);
    expect(nodeSignals[0]?.reason).toEqual({ _tag: "Released", detail: "ready node closed" });
  });

  test("a release cut short by eviction settles its caller as a plain interruption", async () => {
    const { HeldReleaseNode, disposing, finishDisposer } = makeHeldReleaseNode(
      "services/release-reason-interrupted"
    );
    const graph = makeInMemoryGraphSystem();
    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: HeldReleaseNode, args: {} })
    );

    const release = Effect.runPromiseExit(graph.releaseNode(handle.nodeId, "manual release"));
    await Effect.runPromise(Deferred.await(disposing));
    const eviction = Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
    );
    finishDisposer();
    const exit = await release;
    await eviction;

    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(JSON.stringify(exit)).not.toContain("manual release");
  });
});
