import { afterEach, expect, test } from "bun:test";
import * as Frond from "../src";
import * as FrondTest from "../src/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

type Board = { rows: Array<{ value: number }> };
const freshBoard = (): Board => ({ rows: [{ value: 1 }, { value: 2 }] });

async function board(development: boolean) {
  let next = freshBoard();
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Board;
    readonly actions: { readonly patch: Frond.ActionContract };
  }>;
  class BoardNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/development-flag"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => freshBoard()),
      refresh: Frond.Driver.Refresh((context) => context.setResult(next)),
      actions: {
        patch: Frond.Driver.Action((context) =>
          context.patchResult((draft) => {
            const row = draft.rows[0];
            if (row === undefined) throw new Error("Expected the first row");
            row.value += 1;
          })
        ),
      },
    });
  }
  const harness = FrondTest.createFrondTestHarness({ development });
  harnesses.push(harness);
  const node = await harness.startNode(BoardNode, {});
  const handle = harness.node(BoardNode, {});
  return {
    node,
    handle,
    refresh: (value: Board) => {
      next = value;
      return handle.refresh();
    },
  };
}

test("development freezes the committed result and nested rows", async () => {
  const { node } = await board(true);
  expect(Object.isFrozen(node.result)).toBe(true);
  expect(Object.isFrozen(node.result.rows)).toBe(true);
  expect(Object.isFrozen(node.result.rows[0])).toBe(true);
});

test("production preserves sharing and draft isolation without freezing", async () => {
  const { node, handle, refresh } = await board(false);
  const first = node.result;
  expect(Object.isFrozen(first)).toBe(false);
  expect(Object.isFrozen(first.rows)).toBe(false);
  expect(Object.isFrozen(first.rows[0])).toBe(false);
  expect(await refresh(freshBoard())).toMatchObject({ _tag: "Success" });
  expect(node.result).toBe(first);

  expect(await refresh({ rows: [{ value: 1 }, { value: 3 }] })).toMatchObject({
    _tag: "Success",
  });
  const second = node.result;
  expect(second).not.toBe(first);
  expect(second.rows[0]).toBe(first.rows[0]);
  expect(second.rows[1]).not.toBe(first.rows[1]);
  expect(Object.isFrozen(second)).toBe(false);
  expect(Object.isFrozen(second.rows[1])).toBe(false);

  expect(await handle.actions.patch()).toMatchObject({ _tag: "Success" });
  expect(node.result).not.toBe(second);
  expect(node.result.rows[0]?.value).toBe(2);
  expect(node.result.rows[1]).toBe(second.rows[1]);
  expect(second.rows[0]?.value).toBe(1);
  expect(first.rows.map((row) => row.value)).toEqual([1, 2]);
  expect(Object.isFrozen(node.result)).toBe(false);
});

test("untyped callers must provide a boolean development option", () => {
  expect(() =>
    Frond.createRuntime({ eventBufferSize: 0 } as unknown as Frond.Runtime.RuntimeOptions)
  ).toThrow(Frond.Runtime.FrondRuntimeInvariantViolation);
  for (const development of [undefined, null, 0, 1, "true", {}]) {
    expect(() =>
      Frond.createRuntime({
        eventBufferSize: 0,
        development,
      } as unknown as Frond.Runtime.RuntimeOptions)
    ).toThrow(Frond.Runtime.FrondRuntimeInvariantViolation);
  }
});

for (const development of [true, false]) {
  test(`dependency re-plan checks follow the runtime option (development=${development})`, async () => {
    let dependencyCalls = 0;
    type Spec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly key: Frond.Key.Singleton;
      readonly result: string;
    }>;
    class CountingNode extends Frond.NodeBase<Spec> {
      static readonly spec = Frond.serviceSpec.async<Spec>({
        tag: Frond.tag("test/development-replan"),
        key: () => Frond.Key.singleton(),
        dependencies: Frond.dependencies(() => {
          dependencyCalls += 1;
          return {};
        }),
        acquire: Frond.Driver.Acquire(() => "ready"),
      });
    }
    const harness = FrondTest.createFrondTestHarness({ development });
    harnesses.push(harness);
    await harness.start();
    expect(harness.runtime.development).toBe(development);
    const handle = harness.node(CountingNode, {});
    await handle.ensure();
    dependencyCalls = 0;
    await handle.ensure();
    expect(dependencyCalls).toBe(development ? 1 : 0);
  });
}
