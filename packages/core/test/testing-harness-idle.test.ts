import { describe, expect, test } from "bun:test";
import { createFrondTestHarness } from "../src/testing";
import {
  type ActionContract,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

type CounterSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: { readonly bump: ActionContract<void, void> };
}>;

const realSetTimeout = globalThis.setTimeout;
const realDelay = (ms: number) => new Promise<void>((resolve) => realSetTimeout(resolve, ms));
const bumps: string[] = [];

class Counter extends NodeBase<CounterSpec> {
  static readonly spec = serviceSpec.async<CounterSpec>({
    tag: "test/idle-counter",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => 1),
    actions: {
      bump: Driver.Action(async () => {
        await realDelay(5);
        bumps.push("bump");
      }),
    },
  });
}

describe("graph work under a held queueMicrotask", () => {
  test("a harness load settles while queueMicrotask callbacks are held, as Jest fake timers do", async () => {
    const harness = createFrondTestHarness();
    await harness.start();
    const realQueueMicrotask = globalThis.queueMicrotask;
    const held: Array<() => void> = [];
    globalThis.queueMicrotask = (callback) => {
      held.push(callback);
    };
    let outcome = "pending";
    try {
      const load = harness.startNode(Counter, {}).then(
        () => {
          outcome = "settled";
        },
        () => {
          outcome = "rejected";
        }
      );
      await Promise.race([load, realDelay(200)]);
    } finally {
      globalThis.queueMicrotask = realQueueMicrotask;
      for (const callback of held.splice(0)) callback();
    }

    expect(outcome).toBe("settled");
    await harness.teardown();
  });
});

describe("harness waitForIdle", () => {
  test("waits for an action started without await", async () => {
    bumps.length = 0;
    const harness = createFrondTestHarness();
    await harness.start();
    const handle = harness.node(Counter, {});
    await handle.ensureReady();

    void handle.actions.bump();
    await harness.waitForIdle();

    expect(bumps).toEqual(["bump"]);
    await harness.teardown();
  });
});
