import { afterEach, expect, test } from "bun:test";
import { autorun } from "mobx";
import * as Frond from "../src";
import * as FrondTest from "../src/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

async function board() {
  let enumerations = 0;
  let now = 100;
  const row = new Proxy(
    { value: 1 },
    {
      ownKeys: (target) => {
        enumerations += 1;
        return Reflect.ownKeys(target);
      },
    }
  );
  const result = { rows: [row] };
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: typeof result;
    readonly actions: {
      readonly noop: Frond.ActionContract<void, string>;
      readonly stale: Frond.ActionContract;
      readonly current: Frond.ActionContract;
      readonly setSame: Frond.ActionContract;
      readonly patch: Frond.ActionContract;
    };
  }>;
  class Board extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/action-without-result-write"),
      key: () => Frond.Key.singleton(),
      resultValidity: { _tag: "TimeBound", expireAfter: 200 },
      acquire: Frond.Driver.Acquire(() => result),
      actions: {
        noop: Frond.Driver.Action(() => "output"),
        stale: Frond.Driver.Action((ctx) => {
          ctx.setResultValidity({ _tag: "Stale", staleAt: 50 });
        }),
        current: Frond.Driver.Action((ctx) => {
          ctx.setResultValidity({ _tag: "Current" });
        }),
        setSame: Frond.Driver.Action((ctx) => {
          ctx.setResult((current) => {
            const first = current.rows[0];
            if (first !== undefined) first.value += 1;
            return current;
          });
          ctx.setResultValidity({ _tag: "Stale", staleAt: 50 });
        }),
        patch: Frond.Driver.Action((ctx) => {
          ctx.patchResult((current) => {
            const first = current.rows[0];
            if (first !== undefined) first.value += 1;
          });
          ctx.setResultValidity({ _tag: "Stale", staleAt: 50 });
        }),
      },
    });
  }
  const harness = FrondTest.createFrondTestHarness({ syncClock: { now: () => now } });
  harnesses.push(harness);
  const node = await harness.startNode(Board, {});
  const handle = harness.node(Board, {});
  return {
    harness,
    handle,
    node,
    setNow: (next: number) => {
      now = next;
    },
    takeEnumerations: () => {
      const count = enumerations;
      enumerations = 0;
      return count;
    },
  };
}

test("a no-write action preserves result identity, metadata, and row readers", async () => {
  const { harness, handle, node, setNow } = await board();
  const root = node.result;
  const before = harness.readReady(handle);
  let notifications = 0;
  let rowReads = 0;
  const unsubscribe = handle.subscribe(() => {
    notifications += 1;
  });
  const dispose = autorun(() => {
    void node.result.rows[0]?.value;
    rowReads += 1;
  });
  try {
    await harness.waitForIdle();
    const version = handle.readVersion();
    const eventStart = harness.events.length;
    notifications = 0;
    setNow(150);
    expect(await handle.actions.noop()).toMatchObject({ _tag: "Success", value: "output" });
    const after = harness.readReady(handle);
    expect(after.result).toBe(before.result);
    expect(handle.readReady().result).toBe(root);
    expect(after.resultValidity).toEqual(before.resultValidity);
    expect(after.resultValidity).toEqual({ _tag: "Current", currentAt: 100 });
    expect(rowReads).toBe(1);
    expect(handle.readVersion() - version).toBe(3);
    expect(notifications).toBe(4);
    expect(harness.events.slice(eventStart).map((record) => record.event._tag)).toEqual([
      "GraphActionStarted",
      "GraphNodeChanged",
      "GraphNodeChanged",
      "GraphActionSucceeded",
    ]);
  } finally {
    dispose();
    unsubscribe();
  }
});

test("a validity-only action commits validity without changing the result", async () => {
  const { harness, handle, node, setNow } = await board();
  const root = node.result;
  const before = harness.readReady(handle);
  setNow(150);
  expect(await handle.actions.stale()).toMatchObject({ _tag: "Success" });
  const after = harness.readReady(handle);
  expect(after.result).toBe(before.result);
  expect(handle.readReady().result).toBe(root);
  expect(after.resultValidity).toEqual({ _tag: "Stale", staleAt: 50 });
  expect(await handle.actions.current()).toMatchObject({ _tag: "Success" });
  expect(harness.readReady(handle).resultValidity).toEqual({ _tag: "Current", currentAt: 100 });
  setNow(300);
  expect(handle.read()).toMatchObject({ _tag: "Idle" });
});

test("actions without a result write do not enumerate committed rows", async () => {
  const { handle, takeEnumerations } = await board();
  takeEnumerations();
  expect(await handle.actions.noop()).toMatchObject({ _tag: "Success" });
  expect(takeEnumerations()).toBe(0);
  expect(await handle.actions.stale()).toMatchObject({ _tag: "Success" });
  expect(takeEnumerations()).toBe(0);
});

test("setResult updaters and patchResult commit drafts after a validity write", async () => {
  const { harness, handle, node, takeEnumerations } = await board();
  const root = node.result;
  expect(await handle.actions.setSame()).toMatchObject({
    _tag: "Success",
  });
  expect(node.result.rows[0]?.value).toBe(2);
  expect(harness.readReady(handle).resultValidity).toEqual({ _tag: "Stale", staleAt: 50 });
  takeEnumerations();
  expect(await handle.actions.noop()).toMatchObject({ _tag: "Success" });
  expect(takeEnumerations()).toBe(0);
  expect(await handle.actions.patch()).toMatchObject({ _tag: "Success" });
  expect(node.result.rows[0]?.value).toBe(3);
  expect(node.result).not.toBe(root);
  expect(node.result).toBe(harness.readReady(handle).result);
  expect(harness.readReady(handle).resultValidity).toEqual({ _tag: "Stale", staleAt: 50 });
  takeEnumerations();
  expect(await handle.actions.noop()).toMatchObject({ _tag: "Success" });
  expect(takeEnumerations()).toBe(0);
});
