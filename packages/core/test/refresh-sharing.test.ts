import { afterEach, expect, test } from "bun:test";
import { autorun } from "mobx";
import * as Frond from "../src";
import { prepareCommittedResult } from "../src/node/committedResult";
import { isFullyFrozen } from "../src/node/resultData";
import * as FrondTest from "../src/testing";

const harnesses: FrondTest.FrondTestHarness[] = [];
const disposers: Array<() => void> = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

class Counter {
  value = 0;
}
type Row = { value: number; detail?: unknown; [slot: symbol]: unknown };
type Board = { revision: number; rows: Row[]; counter?: Counter; map?: Map<string, number> };
const make = (length = 1000): Board => ({
  revision: 0,
  rows: Array.from({ length }, (_, value) => ({ value })),
});

async function board(initial = make()) {
  let next = initial;
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Board;
    readonly actions: {
      readonly replace: Frond.ActionContract<Board>;
      readonly staged: Frond.ActionContract<Board>;
      readonly mutate: Frond.ActionContract;
    };
  }>;
  class BoardNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/refresh-sharing"),
      key: () => Frond.Key.singleton(),
      resultPatch: { nonPlainClone: "share" },
      acquire: Frond.Driver.Acquire(() => initial),
      refresh: Frond.Driver.Refresh((ctx) => ctx.setResult(next)),
      actions: {
        replace: Frond.Driver.Action((ctx, value) => ctx.setResult(value)),
        staged: Frond.Driver.Action((ctx, value) => {
          ctx.setResult({ revision: 0, rows: [{ value: 99 }] });
          ctx.setResult(value);
        }),
        mutate: Frond.Driver.Action((ctx) =>
          ctx.patchResult((current) => {
            if (current.counter === undefined) throw new Error("missing counter");
            current.counter.value += 1;
          })
        ),
      },
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(BoardNode, {});
  const handle = harness.node(BoardNode, {});
  return {
    node,
    handle,
    plain: () => harness.readReady(handle).result,
    refresh: (value: Board) => {
      next = value;
      return handle.refresh();
    },
  };
}

function reader(read: () => unknown) {
  let runs = 0;
  disposers.push(
    autorun(() => {
      read();
      runs += 1;
    })
  );
  return () => runs;
}

test("one-row refresh shares unchanged rows and notifies every result reader", async () => {
  const { node, plain, refresh } = await board();
  const before = plain();
  const previousRows = [...node.result.rows];
  const changed = reader(() => node.result.rows[7]?.value);
  const unchanged = reader(() => node.result.rows[8]?.value);
  let candidateReads = 0;
  const next = make();
  next.rows = next.rows.map(
    (row, index) =>
      new Proxy(
        { value: index === 7 ? 70 : row.value },
        {
          getOwnPropertyDescriptor(target, key) {
            // Object.freeze reads descriptors after preventExtensions; count only the commit walk.
            if (key === "value" && Object.isExtensible(target)) candidateReads += 1;
            return Reflect.getOwnPropertyDescriptor(target, key);
          },
        }
      )
  );
  expect(await refresh(next)).toMatchObject({ _tag: "Success" });
  expect(candidateReads).toBe(1000);
  expect([changed(), unchanged()]).toEqual([2, 2]);
  expect(plain()).not.toBe(before);
  expect(plain().rows).not.toBe(before.rows);
  previousRows.forEach((row, index) => {
    if (index === 7) expect(node.result.rows[index]).not.toBe(row);
    else expect(node.result.rows[index]).toBe(row);
    expect(Object.isFrozen(plain().rows[index])).toBe(true);
    if (index !== 7) expect(plain().rows[index]).toBe(before.rows[index]);
  });
});

test("equal refresh retains the committed root and notifies no reader", async () => {
  const { node, plain, refresh } = await board();
  const before = plain();
  const runs = reader(() => node.result.rows[0]?.value);
  expect(await refresh(make())).toMatchObject({ _tag: "Success" });
  expect(plain()).toBe(before);
  expect(runs()).toBe(1);
});

test("sharing preserves fresh symbol payloads and null-prototype children on changed refreshes", async () => {
  const slot = Symbol("payload");
  const initial = make(2);
  initial.rows = [
    { value: 0, detail: { a: 1 }, [slot]: { secret: 1 } },
    { value: 1, detail: Object.assign(Object.create(null), { a: 1 }) },
  ];
  const { plain, refresh } = await board(initial);
  const next = make(2);
  const payload = { secret: 1 };
  const detail = Object.assign(Object.create(null), { a: 1 });
  next.revision = 1;
  next.rows = [
    { value: 0, detail: { a: 1 }, [slot]: payload },
    { value: 1, detail },
  ];
  expect(await refresh(next)).toMatchObject({ _tag: "Success" });
  expect(Reflect.get(plain().rows[0] as object, slot)).toBe(payload);
  expect(plain().rows[0]?.detail).toBe(initial.rows[0]?.detail);
  expect(plain().rows[1]?.detail).toBe(detail);
});

test("loose root retention still accepts equal symbol payloads", async () => {
  const slot = Symbol("payload");
  const initial = make(1);
  initial.rows[0] = { value: 0, [slot]: { secret: 1 } };
  const { plain, refresh } = await board(initial);
  const before = plain();
  const next = make(1);
  next.rows[0] = { value: 0, [slot]: { secret: 1 } };
  expect(await refresh(next)).toMatchObject({ _tag: "Success" });
  expect(plain()).toBe(before);
});

test("adding, removing, and reordering rows updates the affected readers", async () => {
  const { node, plain, refresh } = await board(make(2));
  const before = plain();
  const length = reader(() => node.result.rows.length);
  const first = reader(() => node.result.rows[0]?.value);
  const second = reader(() => node.result.rows[1]?.value);
  expect(await refresh(make(3))).toMatchObject({ _tag: "Success" });
  expect(plain().rows[0]).toBe(before.rows[0]);
  expect(plain().rows[1]).toBe(before.rows[1]);
  expect([length(), first(), second()]).toEqual([2, 2, 2]);
  expect(
    await refresh({ revision: 0, rows: [{ value: 1 }, { value: 0 }, { value: 2 }] })
  ).toMatchObject({ _tag: "Success" });
  expect(node.result.rows.map((row) => row.value)).toEqual([1, 0, 2]);
  expect([length(), first(), second()]).toEqual([3, 3, 3]);
  expect(await refresh({ revision: 0, rows: [{ value: 1 }] })).toMatchObject({ _tag: "Success" });
  expect(node.result.rows.map((row) => row.value)).toEqual([1]);
  expect([length(), first(), second()]).toEqual([4, 4, 4]);
});

test("new opaque instances and Maps remain the driver's references", async () => {
  const initial = { ...make(1), counter: new Counter(), map: new Map([["a", 1]]) };
  const { plain, refresh } = await board(initial);
  const next = { ...make(1), counter: new Counter(), map: new Map([["a", 1]]) };
  expect(await refresh(next)).toMatchObject({ _tag: "Success" });
  expect(plain().counter).toBe(next.counter);
  expect(plain().map).toBe(next.map);
});

test("an equal cyclic candidate retains the old root", async () => {
  const initial = make(1);
  initial.rows[0] = { value: 0, detail: initial };
  const { plain, refresh } = await board(initial);
  const next = make(1);
  next.rows[0] = { value: 0, detail: next };
  expect(await refresh(next)).toMatchObject({ _tag: "Success" });
  expect(plain()).toBe(initial);
});

test("a depth-cut source is not trusted after its subtree is frozen at a shallower depth", () => {
  const leaf = { value: 1 };
  let deep: { next?: unknown } = { next: leaf };
  const subtree = deep;
  for (let index = 0; index < 1000; index += 1) deep = { next: deep };
  prepareCommittedResult(deep, undefined, false, true);
  expect(Object.isFrozen(deep)).toBe(true);
  expect(isFullyFrozen(deep)).toBe(false);
  leaf.value = 2;
  prepareCommittedResult(subtree, subtree, false, true);
  expect(isFullyFrozen(subtree)).toBe(true);
  expect(leaf.value).toBe(2);
  expect(Object.isFrozen(leaf)).toBe(true);
});

test("a cycle-cut container remains unskippable", () => {
  const cycle: { value: number; self?: unknown } = { value: 1 };
  cycle.self = cycle;
  prepareCommittedResult(cycle, undefined, false, true);
  expect(Object.isFrozen(cycle)).toBe(true);
  expect(isFullyFrozen(cycle)).toBe(false);
});

for (const staged of [false, true])
  test(`setResult(value) shares against the committed baseline and retains an equal root (staged=${staged})`, async () => {
    const { node, handle, plain } = await board();
    const before = plain();
    const runs = reader(() => node.result.rows[0]?.value);
    const next = make();
    expect(
      await (staged ? handle.actions.staged(next) : handle.actions.replace(next))
    ).toMatchObject({ _tag: "Success" });
    expect(plain()).toBe(before);
    expect(plain().rows).toBe(before.rows);
    expect(runs()).toBe(1);
  });

test("equal refresh preserves non-plain containment for a subsequent shared class patch", async () => {
  const counter = new Counter();
  const { node, handle, refresh } = await board({ ...make(1), counter });
  const runs = reader(() => node.result.counter?.value);
  expect(await refresh({ ...make(1), counter })).toMatchObject({ _tag: "Success" });
  expect(runs()).toBe(1);
  expect(await handle.actions.mutate()).toMatchObject({ _tag: "Success" });
  expect(node.result.counter?.value).toBe(1);
  expect(runs()).toBe(2);
});

test("a changed refresh preserves non-plain containment for a shared class patch", async () => {
  const counter = new Counter();
  const { node, handle, refresh } = await board({ ...make(2), counter });
  const runs = reader(() => node.result.counter?.value);
  expect(await refresh({ revision: 1, rows: [{ value: 7 }, { value: 1 }], counter })).toMatchObject(
    { _tag: "Success" }
  );
  expect(await handle.actions.mutate()).toMatchObject({ _tag: "Success" });
  expect(node.result.counter?.value).toBe(1);
  expect(runs()).toBe(3);
});

test("an equal refresh draft still retains the previous root", async () => {
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Board;
  }>;
  class Resource extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/refresh-sharing/equal-draft"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => make(1)),
      refresh: Frond.Driver.Refresh((ctx) => {
        ctx.patchResult((current) => {
          current.revision += 1;
        });
        ctx.patchResult((current) => {
          current.revision -= 1;
        });
      }),
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(Resource, {});
  const handle = harness.node(Resource, {});
  const before = harness.readReady(handle).result;
  const runs = reader(() => node.result.revision);
  expect(await handle.refresh()).toMatchObject({ _tag: "Success" });
  expect(harness.readReady(handle).result).toBe(before);
  expect(runs()).toBe(1);
});

test("expiry acquire shares against the previous committed result", async () => {
  let now = 100;
  let generation = 0;
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Board;
  }>;
  class Resource extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/refresh-sharing/reacquire"),
      key: () => Frond.Key.singleton(),
      resultValidity: { _tag: "TimeBound", expireAfter: 10 },
      acquire: Frond.Driver.Acquire(() => ({ ...make(2), revision: generation++ })),
    });
  }
  const harness = FrondTest.createFrondTestHarness({ syncClock: { now: () => now } });
  harnesses.push(harness);
  await harness.startNode(Resource, {});
  const handle = harness.node(Resource, {});
  const before = harness.readReady(handle).result;
  now = 200;
  await handle.ensureReadyNode();
  const after = harness.readReady(handle).result;
  expect(after.revision).toBe(1);
  expect(after).not.toBe(before);
  expect(after.rows).toBe(before.rows);
});

test("a Frond-frozen replacement copies on write while sharing equal rows", async () => {
  const { handle, plain } = await board(make(2));
  const before = plain();
  const next = make(2);
  const rows = next.rows;
  prepareCommittedResult(next, undefined, false, true);
  expect(await handle.actions.replace(next)).toMatchObject({ _tag: "Success" });
  expect(plain()).toBe(before);
  expect(plain().rows).toBe(before.rows);
  expect(next.rows).toBe(rows);
  expect(next.rows).not.toBe(before.rows);
});

test("sharing equality uses descriptor values instead of a proxy's get trap", () => {
  const before = { row: { value: 1 } };
  prepareCommittedResult(before, undefined, false, true);
  const next = {
    row: new Proxy(
      { value: 1 },
      {
        get(target, key, receiver) {
          if (key === "value") throw new Error("get trap must not be invoked by equality");
          return Reflect.get(target, key, receiver);
        },
      }
    ),
  };
  expect(prepareCommittedResult(next, before, true, true)).toBe(before);
});
