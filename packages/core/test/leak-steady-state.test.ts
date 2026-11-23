import { expect, test } from "bun:test";
import {
  type ActionContract,
  createRuntime,
  Driver,
  Graph,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "../src";
import { leakSlackPerRound, objectGrowth } from "./leakTestFixtures";

type CounterSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: { value: number; failRefresh: boolean };
  readonly actions: {
    readonly succeed: ActionContract;
    readonly fail: ActionContract;
    readonly prepareRefreshFailure: ActionContract;
  };
}>;

class CounterNode extends NodeBase<CounterSpec> {
  static readonly spec = resourceSpec.async<CounterSpec>({
    tag: tag("test/core/leak-steady-state/counter"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => ({ value: 0, failRefresh: false })),
    refresh: Driver.Refresh((context) => {
      let fail = false;
      context.patchResult((current) => {
        fail = current.failRefresh;
        current.value += 1;
      });
      if (fail) throw new Error("Expected refresh failure");
    }),
    actions: {
      succeed: Driver.Action((context) => {
        context.patchResult((current) => {
          current.value += 1;
          current.failRefresh = false;
        });
      }),
      fail: Driver.Action((context) => {
        context.patchResult((current) => {
          current.value = -1;
        });
        throw new Error("Expected action failure");
      }),
      prepareRefreshFailure: Driver.Action((context) => {
        context.patchResult((current) => {
          current.failRefresh = true;
        });
      }),
    },
  });
}

test("a subscribed node retains no operation history during steady state work", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  let unsubscribe = () => {};
  try {
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node(CounterNode, {});
    if ((await handle.ensureReady())._tag !== "Ready") throw new Error("Node did not become ready");
    const node = handle.readReady();
    let notifications = 0;
    unsubscribe = handle.subscribe(() => {
      notifications += 1;
    });
    const growth = await objectGrowth(async () => {
      const before = notifications;
      const value = node.result.value;
      if ((await handle.actions.succeed())._tag !== "Success") throw new Error("Action failed");
      if (node.result.value !== value + 1) throw new Error("Action did not commit");
      if ((await handle.refresh())._tag !== "Success") throw new Error("Refresh failed");
      if (node.result.value !== value + 2) throw new Error("Refresh did not commit");
      const action = await handle.actions.fail();
      if (
        action._tag !== "Failure" ||
        !(action.error.cause instanceof Graph.DriverPromiseFailed) ||
        !(action.error.cause.cause instanceof Error) ||
        action.error.cause.cause.message !== "Expected action failure"
      )
        throw new Error("Action did not fail through its expected channel");
      if ((await handle.actions.prepareRefreshFailure())._tag !== "Success")
        throw new Error("Refresh failure setup failed");
      const refresh = await handle.refresh();
      if (
        refresh._tag !== "Failure" ||
        !(refresh.error.cause instanceof Graph.DriverPromiseFailed) ||
        !(refresh.error.cause.cause instanceof Error) ||
        refresh.error.cause.cause.message !== "Expected refresh failure"
      )
        throw new Error("Refresh did not fail through its expected channel");
      if ((await handle.ensureReady())._tag !== "Ready") throw new Error("Node lost readiness");
      if (handle.readReady() !== node || node.result.value !== value + 2)
        throw new Error("Failed operations replaced the node or committed their drafts");
      if (!runtime.isQuiescent()) throw new Error("Operation did not settle");
      if (notifications <= before) throw new Error("Node subscription stopped receiving events");
    });
    console.info("L9 steady state", JSON.stringify(growth));
    expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
  } finally {
    unsubscribe();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 120_000);
