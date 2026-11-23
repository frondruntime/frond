import { afterEach, expect, test } from "bun:test";
import { autorun, observable } from "mobx";
import * as Frond from "../src";
import { prepareCommittedResult } from "../src/node/committedResult";
import * as FrondTest from "../src/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

type Board = { rev: number; rows: Array<{ v: number }> };
const freshBoard = (): Board => ({ rev: 0, rows: Array.from({ length: 8 }, () => ({ v: 0 })) });

async function board() {
  const acquired = freshBoard();
  let refreshed = freshBoard();
  const staged = freshBoard();
  let failedPatch: Board | undefined;
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Board;
    readonly actions: {
      readonly replace: Frond.ActionContract;
      readonly patch: Frond.ActionContract;
      readonly stageAndPatch: Frond.ActionContract;
      readonly fail: Frond.ActionContract;
    };
  }>;
  class BoardNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/committed-result-read-only/board"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => acquired),
      refresh: Frond.Driver.Refresh((ctx) => {
        refreshed = { ...freshBoard(), rev: 1 };
        ctx.setResult(refreshed);
      }),
      actions: {
        replace: Frond.Driver.Action((ctx) => {
          ctx.setResult((current) => ({ ...current, rev: current.rev + 1 }));
        }),
        patch: Frond.Driver.Action((ctx) => {
          ctx.patchResult((current) => {
            const row = current.rows[7];
            if (row !== undefined) row.v += 1;
          });
        }),
        stageAndPatch: Frond.Driver.Action((ctx) => {
          ctx.setResult(staged);
          expect(Object.isFrozen(staged)).toBe(false);
          ctx.patchResult((current) => {
            current.rev = 2;
          });
          // The second draft starts from the first finalized patch.
          ctx.patchResult((current) => {
            const row = current.rows[7];
            if (row !== undefined) row.v = 3;
          });
        }),
        fail: Frond.Driver.Action((ctx) => {
          ctx.patchResult((current) => {
            failedPatch = current;
            const row = current.rows[7];
            if (row !== undefined) row.v = 99;
          });
          throw new Error("reject staged patch");
        }),
      },
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(BoardNode, {});
  const handle = harness.node(BoardNode, {});
  return {
    harness,
    node,
    handle,
    acquired,
    refreshed: () => refreshed,
    failedPatch: () => failedPatch,
  };
}

function expectFrozen(value: Board) {
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.rows)).toBe(true);
  for (const row of value.rows) expect(Object.isFrozen(row)).toBe(true);
}

for (const operation of ["acquire", "refresh", "setResult", "patchResult"] as const) {
  test(`${operation} freezes committed plain data`, async () => {
    const { harness, handle, acquired, refreshed } = await board();
    switch (operation) {
      case "acquire":
        expectFrozen(acquired);
        break;
      case "refresh":
        expect(await handle.refresh()).toMatchObject({ _tag: "Success" });
        expectFrozen(refreshed());
        break;
      case "setResult":
        expect(await handle.actions.replace()).toMatchObject({ _tag: "Success" });
        break;
      case "patchResult":
        expect(await handle.actions.patch()).toMatchObject({ _tag: "Success" });
        break;
    }
    expectFrozen(harness.readReady(handle).result);
  });
}

test("a driver-retained row rejects mutation after commit", async () => {
  const { acquired, node } = await board();
  expect(() => {
    const row = acquired.rows[3];
    if (row !== undefined) row.v = 5;
  }).toThrow(TypeError);
  expect(node.result.rows[3]?.v).toBe(0);
});

test("frozen commits notify every result reader", async () => {
  const { handle, node } = await board();
  let row3 = 0;
  let row7 = 0;
  const dispose3 = autorun(() => {
    void node.result.rows[3]?.v;
    row3 += 1;
  });
  const dispose7 = autorun(() => {
    void node.result.rows[7]?.v;
    row7 += 1;
  });
  try {
    expect(await handle.actions.patch()).toMatchObject({ _tag: "Success" });
    expect(row3).toBe(2);
    expect(row7).toBe(2);
    expect(node.result.rows[7]?.v).toBe(1);
  } finally {
    dispose3();
    dispose7();
  }
});

test("setResult then repeated patchResult stays mutable until the operation commits", async () => {
  const { harness, handle, node } = await board();
  expect(await handle.actions.stageAndPatch()).toMatchObject({ _tag: "Success" });
  expect(node.result.rev).toBe(2);
  expect(node.result.rows[7]?.v).toBe(3);
  expectFrozen(harness.readReady(handle).result);
});

test("a failed patch leaves the frozen committed value unchanged", async () => {
  const { harness, handle, node, failedPatch } = await board();
  const before = harness.readReady(handle).result;
  expect(await handle.actions.fail()).toMatchObject({ _tag: "Failure" });
  expect(() => failedPatch()?.rows[7]?.v).toThrow(TypeError);
  expect(() => Object.isFrozen(failedPatch())).toThrow(TypeError);
  expect(harness.readReady(handle).result).toBe(before);
  expect(before.rows[7]?.v).toBe(0);
  expect(node.result.rows[7]?.v).toBe(0);
  expectFrozen(before);
});

async function startValue<T>(value: T) {
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: T;
  }>;
  class ValueNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/committed-result-read-only/value"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => value),
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  return harness.startNode(ValueNode, {});
}

test("opaque data stays mutable and author-frozen data stays opaque", async () => {
  class Client {
    state = { v: 0 };
  }
  const client = new Client();
  const map = new Map([["row", { v: 0 }]]);
  const set = new Set([{ v: 0 }]);
  const date = new Date(0);
  const authorObservable = observable({ v: 0 });
  const authorFrozen = Object.freeze({ nested: { v: 0 } });
  const nullPrototype: object = Object.create(null);
  const sealed = Object.seal({ nested: { v: 0 } });
  const accessor = {
    get nested() {
      return client.state;
    },
  };
  const hidden = Object.defineProperty({ nested: { v: 0 } }, "hidden", { value: 1 });
  const value = {
    client,
    map,
    set,
    date,
    authorObservable,
    authorFrozen,
    nullPrototype,
    sealed,
    accessor,
    hidden,
  };
  const node = await startValue(value);
  expect(Object.isFrozen(value)).toBe(true);
  for (const opaque of [
    client,
    client.state,
    map,
    set,
    date,
    authorObservable,
    nullPrototype,
    sealed,
    sealed.nested,
    accessor,
    hidden,
    hidden.nested,
    authorFrozen.nested,
  ]) {
    expect(Object.isFrozen(opaque)).toBe(false);
  }
  expect(node.result.client).toBe(client);
  expect(node.result.map).toBe(map);
  expect(node.result.authorObservable).toBe(authorObservable);
  expect(node.result.authorFrozen).toBe(authorFrozen);
  client.state.v = 1;
  map.set("new", { v: 1 });
  expect(node.result.client.state.v).toBe(1);
  expect(node.result.map.size).toBe(2);
});

test("acquire staging and symbol internals stay mutable until commit", async () => {
  const internal = { v: 0 };
  const value = Frond.withInternal(freshBoard(), internal);
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Board;
  }>;
  class StagedNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/committed-result-read-only/staged-acquire"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire((ctx) => {
        ctx.setResult(value);
        expect(Object.isFrozen(value)).toBe(false);
        ctx.patchResult((current) => {
          current.rev = 4;
        });
      }),
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(StagedNode, {});
  expectFrozen(value);
  expect(node.result.rev).toBe(4);
  expect(Frond.internalOf(value)).toBe(internal);
  expect(Object.isFrozen(internal)).toBe(false);
  internal.v += 1;
  expect(Frond.internalOf(value).v).toBe(1);
});

test("freeze terminates at cycles and the snapshot depth limit", async () => {
  type Link = { next?: Link };
  const cycle: Link = {};
  cycle.next = cycle;
  const cyclicNode = await startValue(cycle);
  expect(Object.isFrozen(cycle)).toBe(true);
  expect(cyclicNode.result).toBe(cycle);
  const links: Link[] = Array.from({ length: 1002 }, () => ({}));
  for (let index = 0; index < links.length - 1; index += 1) {
    const current = links[index];
    if (current !== undefined) current.next = links[index + 1];
  }
  await startValue(links[0]);
  expect(Object.isFrozen(links[999])).toBe(true);
  expect(Object.isFrozen(links[1000])).toBe(false);
});

for (const authorFirst of [false, true]) {
  test(`equal refresh preserves author ownership when author-frozen data is ${authorFirst ? "previous" : "next"}`, async () => {
    const author = Object.freeze({ v: 1 });
    const plain = { v: 1 };
    let value = authorFirst ? author : plain;
    type Spec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly key: Frond.Key.Singleton;
      readonly result: { readonly v: number };
    }>;
    class OwnershipNode extends Frond.NodeBase<Spec> {
      static readonly spec = Frond.serviceSpec.async<Spec>({
        tag: Frond.tag("test/committed-result-read-only/ownership"),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => value),
        refresh: Frond.Driver.Refresh((ctx) => ctx.setResult(value)),
      });
    }
    const harness = FrondTest.createFrondTestHarness();
    harnesses.push(harness);
    const node = await harness.startNode(OwnershipNode, {});
    const handle = harness.node(OwnershipNode, {});
    value = authorFirst ? plain : author;
    expect(await handle.refresh()).toMatchObject({ _tag: "Success" });
    expect(harness.readReady(handle).result).toBe(value);
    expect(node.result).toBe(value);
  });
}

function commitForFreeze<Value>(
  value: Value,
  previous: unknown = undefined,
  development = true
): Value {
  return prepareCommittedResult(value, previous, previous !== undefined, development) as Value;
}

for (const nested of [false, true]) {
  test(`development freezes a production-owned value: nested=${nested}`, () => {
    const value = { child: { value: 0 } };
    commitForFreeze(value, undefined, false);
    expect(Object.isFrozen(value)).toBe(false);
    const result = prepareCommittedResult(
      nested ? { branch: value } : value,
      undefined,
      false,
      true
    );
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.child)).toBe(true);
  });
  test(`production and development runtimes share frozen results: nested=${nested}`, async () => {
    const value = { child: { value: 0 } };
    type Result = { child: { value: number } } | { branch: { child: { value: number } } };
    type Spec = Frond.NodeSpec<{
      readonly mode: "async";
      readonly key: Frond.Key.Singleton;
      readonly result: Result;
    }>;
    let next: Result = value;
    class SharedNode extends Frond.NodeBase<Spec> {
      static readonly spec = Frond.serviceSpec.async<Spec>({
        tag: Frond.tag("test/committed-result-read-only/freeze"),
        key: () => Frond.Key.singleton(),
        acquire: Frond.Driver.Acquire(() => next),
      });
    }
    const production = FrondTest.createFrondTestHarness({ development: false });
    const development = FrondTest.createFrondTestHarness({ development: true });
    try {
      const original = await production.startNode(SharedNode, {});
      expect(original.result).toBe(value);
      expect(Object.isFrozen(value)).toBe(false);
      next = nested ? { branch: value } : value;
      const reused = await development.startNode(SharedNode, {});
      expect(Object.isFrozen(reused.result)).toBe(true);
      expect(Object.isFrozen(value)).toBe(true);
      expect(Object.isFrozen(value.child)).toBe(true);
    } finally {
      await development.teardown();
      await production.teardown();
    }
  });
}

test("a production-owned frozen root still needs its descendants frozen", () => {
  const value = { child: { value: 0 } };
  commitForFreeze(value, undefined, false);
  Object.freeze(value);
  commitForFreeze(value, value, true);
  expect(Object.isFrozen(value)).toBe(true);
  expect(Object.isFrozen(value.child)).toBe(true);
});

test("an equal development candidate cannot retain an unfrozen production root", () => {
  const before = commitForFreeze({ child: { value: 0 } }, undefined, false);
  const candidate = { child: { value: 0 } };
  const after = commitForFreeze(candidate, before, true);
  expect(after).toEqual(before);
  expect(Object.isFrozen(candidate)).toBe(true);
  expect(Object.isFrozen(after)).toBe(true);
  expect(Object.isFrozen(after.child)).toBe(true);
});
