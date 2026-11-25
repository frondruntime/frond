import { afterEach, expect, test } from "bun:test";
import { autorun, isObservable } from "mobx";
import * as Frond from "../src";
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
type Row = { value: number };
type Board = { a: number; rows: Row[]; other?: Row; x?: number; counter?: Counter };
type Recipe = (current: Board, live: Board) => void;

async function board(options: { shared?: boolean; counter?: boolean } = {}) {
  let enumerations = 0;
  const shared = { value: 0 };
  const result: Board = {
    a: 0,
    rows: Array.from({ length: 1000 }, (_, index) =>
      options.shared && index === 0
        ? shared
        : new Proxy(
            { value: index },
            {
              ownKeys(target) {
                if (index > 0) enumerations += 1;
                return Reflect.ownKeys(target);
              },
            }
          )
    ),
  };
  if (options.shared) result.other = shared;
  if (options.counter) result.counter = new Counter();
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Board;
    readonly actions: {
      readonly patch: Frond.ActionContract<Recipe>;
      readonly fail: Frond.ActionContract<Recipe>;
      readonly twice: Frond.ActionContract;
      readonly update: Frond.ActionContract<
        (current: Board) => Board | Frond.Driver.ResultCommit<Board>
      >;
      readonly batch: Frond.ActionContract<ReadonlyArray<Recipe>>;
      readonly stage: Frond.ActionContract<(live: Board) => Board>;
    };
  }>;
  class BoardNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/patch-result-draft"),
      key: () => Frond.Key.singleton(),
      resultPatch: options.counter ? { nonPlainClone: "share" } : undefined,
      acquire: Frond.Driver.Acquire(() => result),
      actions: {
        patch: Frond.Driver.Action((ctx, recipe) => {
          ctx.patchResult((current) => recipe(current, ctx.node.result));
        }),
        fail: Frond.Driver.Action((ctx, recipe) => {
          ctx.patchResult((current) => recipe(current, ctx.node.result));
          throw new Error("reject patch");
        }),
        twice: Frond.Driver.Action((ctx) => {
          ctx.patchResult((current) => {
            rowAt(current, 0).value += 1;
          });
          ctx.patchResult((current) => {
            rowAt(current, 1).value += 1;
          });
        }),
        update: Frond.Driver.Action((ctx, update) => {
          ctx.setResult(update);
        }),
        batch: Frond.Driver.Action((ctx, recipes) => {
          for (const recipe of recipes)
            ctx.patchResult((current) => recipe(current, ctx.node.result));
        }),
        stage: Frond.Driver.Action((ctx, create) => {
          ctx.setResult(create(ctx.node.result));
          ctx.patchResult((current) => {
            current.a += 1;
          });
        }),
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
    takeUntouchedEnumerations: () => {
      const count = enumerations;
      enumerations = 0;
      return count;
    },
  };
}

function rowAt(current: Board, index: number): Row {
  const row = current.rows[index];
  if (row === undefined) throw new Error(`missing row ${index}`);
  return row;
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

test("one field replaces changed containers, shares untouched rows, and notifies all result readers", async () => {
  const { node, handle, plain } = await board();
  const before = plain();
  const root = node.result;
  const rows = root.rows;
  const liveRows = [...rows];
  const changed = reader(() => node.result.rows[0]?.value);
  const untouched = reader(() => node.result.rows[999]?.value);
  expect(
    await handle.actions.patch((current) => {
      rowAt(current, 0).value += 1;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(changed()).toBe(2);
  expect(untouched()).toBe(2);
  expect(node.result).not.toBe(root);
  expect(node.result.rows).not.toBe(rows);
  for (let index = 0; index < rows.length; index += 1) {
    if (index === 0) expect(node.result.rows[index]).not.toBe(liveRows[index]);
    else expect(node.result.rows[index]).toBe(liveRows[index]);
    if (index > 0) {
      expect(plain().rows[index]).toBe(before.rows[index]);
      expect(Object.isFrozen(plain().rows[index])).toBe(true);
    }
  }
  expect(before.rows[0]?.value).toBe(0);
  expect(plain().rows[0]?.value).toBe(1);
});

test("a one-field patch enumerates zero untouched rows", async () => {
  const { handle, takeUntouchedEnumerations } = await board();
  takeUntouchedEnumerations();
  expect(
    await handle.actions.patch((current) => {
      rowAt(current, 0).value += 1;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(takeUntouchedEnumerations()).toBe(0);
});

test("a failed patch leaves committed snapshot and readers unchanged", async () => {
  const { handle, node, plain } = await board();
  const before = plain();
  const root = node.result;
  const runs = reader(() => node.result.rows[0]?.value);
  expect(
    await handle.actions.fail((current) => {
      rowAt(current, 0).value = 99;
    })
  ).toMatchObject({ _tag: "Failure" });
  expect(plain()).toBe(before);
  expect(node.result).toBe(root);
  expect(node.result.rows[0]?.value).toBe(0);
  expect(runs()).toBe(1);
});

test("two patches in one operation both commit", async () => {
  const { handle, node, plain } = await board();
  const rows = [...node.result.rows];
  expect(await handle.actions.twice()).toMatchObject({ _tag: "Success" });
  expect(node.result.rows.slice(0, 2)).toEqual([{ value: 1 }, { value: 2 }]);
  expect(plain().rows.slice(0, 2)).toEqual([{ value: 1 }, { value: 2 }]);
  expect(node.result.rows[0]).not.toBe(rows[0]);
  expect(node.result.rows[1]).not.toBe(rows[1]);
});

test("assigning a committed container preserves its frozen reference", async () => {
  const { handle, node, plain } = await board();
  const source = plain().rows[0];
  expect(
    await handle.actions.patch((current, live) => {
      current.other = live.rows[0];
    })
  ).toMatchObject({ _tag: "Success" });
  expect(plain().other).toBe(source);
  expect(isObservable(plain().other)).toBe(false);
  expect(node.result.other?.value).toBe(0);
});

test("push, splice, and delete notify every result reader", async () => {
  const { handle, node } = await board({ shared: true });
  const length = reader(() => node.result.rows.length);
  const first = reader(() => node.result.rows[0]?.value);
  const other = reader(() => node.result.other?.value);
  expect(
    await handle.actions.patch((current) => {
      current.rows.push({ value: 1000 });
    })
  ).toMatchObject({ _tag: "Success" });
  expect([length(), first(), other()]).toEqual([2, 2, 2]);
  expect(
    await handle.actions.patch((current) => {
      current.rows.splice(0, 1, { value: 42 });
      delete current.other;
    })
  ).toMatchObject({ _tag: "Success" });
  // A same-length splice replaces the snapshot, so every result reader reruns.
  expect([length(), first(), other()]).toEqual([3, 3, 3]);
  expect(node.result.rows[0]?.value).toBe(42);
  expect(
    await handle.actions.patch((current) => {
      delete current.rows[0];
      current.rows.length = 2;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(node.result.rows.length).toBe(2);
  expect(node.result.rows[0]).toBeUndefined();
  expect([length(), first(), other()]).toEqual([4, 4, 4]);
});

test("stashed drafts are revoked after patch recipes and updaters return", async () => {
  const { handle } = await board();
  let stashed: Board | undefined;
  expect(
    await handle.actions.patch((current) => {
      stashed = current;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(() => stashed?.a).toThrow(TypeError);
  expect(
    await handle.actions.update((current) => {
      stashed = current;
      return current;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(() => stashed?.rows).toThrow(TypeError);
});

test("mutate-and-return updates the committed snapshot; spread preserves rows", async () => {
  const { handle, node, plain } = await board();
  const rows = node.result.rows;
  const committedRows = plain().rows;
  expect(
    await handle.actions.update((current) => {
      current.a += 1;
      return current;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(plain().a).toBe(1);
  expect(node.result.a).toBe(1);
  expect(await handle.actions.update((current) => ({ ...current, x: 1 }))).toMatchObject({
    _tag: "Success",
  });
  expect(node.result.x).toBe(1);
  expect(node.result.rows).toBe(rows);
  expect(plain().rows).toBe(committedRows);
});

test("a shared class mutation still reaches the in-place readers", async () => {
  const { handle, node, takeUntouchedEnumerations } = await board({ counter: true });
  takeUntouchedEnumerations();
  const runs = reader(() => node.result.counter?.value);
  expect(
    await handle.actions.patch((current) => {
      if (current.counter === undefined) throw new Error("missing counter");
      current.counter.value += 1;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(node.result.counter?.value).toBe(1);
  expect(runs()).toBe(2);
  expect(takeUntouchedEnumerations()).toBe(0);
});

test("one plain object at two keys has independent draft locations", async () => {
  const { handle, node, plain } = await board({ shared: true });
  expect(plain().rows[0]).toBe(plain().other);
  expect(
    await handle.actions.patch((current) => {
      rowAt(current, 0).value = 7;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(node.result.rows[0]?.value).toBe(7);
  expect(node.result.other?.value).toBe(0);
  expect(plain().other?.value).toBe(0);
});

test("equal writes and absent deletes preserve the plain result and enumerate no rows", async () => {
  const { handle, node, plain, takeUntouchedEnumerations } = await board();
  const before = plain();
  const runs = reader(() => node.result.rows[0]?.value);
  takeUntouchedEnumerations();
  expect(
    await handle.actions.patch((current) => {
      current.a = 0;
      const rows = current.rows;
      current.rows = rows;
      delete current.x;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(plain()).toBe(before);
  expect(runs()).toBe(1);
  expect(takeUntouchedEnumerations()).toBe(0);
});

test("assigned spreads normalize their draft children, and detached drafts cannot overwrite replacements", async () => {
  const { handle, node, plain } = await board();
  const oldRow = plain().rows[0];
  expect(
    await handle.actions.patch((current) => {
      const detached = rowAt(current, 0);
      current.rows[0] = { value: 17 };
      detached.value = 99;
      current.other = { ...rowAt(current, 0) };
    })
  ).toMatchObject({ _tag: "Success" });
  expect(oldRow?.value).toBe(0);
  expect(plain().rows[0]?.value).toBe(17);
  expect(plain().other?.value).toBe(17);
  expect(node.result.other?.value).toBe(17);
});

test("a failing updater revokes drafts and rolls back all writes", async () => {
  const { handle, node, plain } = await board();
  const before = plain();
  const runs = reader(() => node.result.a);
  let stashed: Board | undefined;
  expect(
    await handle.actions.update((current) => {
      stashed = current;
      current.a = 99;
      throw new Error("reject updater");
    })
  ).toMatchObject({ _tag: "Failure" });
  expect(plain()).toBe(before);
  expect(node.result.a).toBe(0);
  expect(runs()).toBe(1);
  expect(() => stashed?.a).toThrow(TypeError);
});

test("repeated writes compose by path when a base object appears at two keys", async () => {
  const { handle, node, plain, takeUntouchedEnumerations } = await board({ shared: true });
  const row = node.result.rows[0];
  const other = node.result.other;
  takeUntouchedEnumerations();
  expect(
    await handle.actions.batch([
      (current) => {
        rowAt(current, 0).value += 1;
      },
      (current) => {
        if (current.other !== undefined) current.other.value = 9;
      },
      (current) => {
        rowAt(current, 0).value += 2;
      },
    ])
  ).toMatchObject({ _tag: "Success" });
  expect(plain().rows[0]?.value).toBe(3);
  expect(plain().other?.value).toBe(9);
  expect(node.result.rows[0]).not.toBe(row);
  expect(node.result.other).not.toBe(other);
  expect(row?.value).toBe(0);
  expect(other?.value).toBe(0);
  expect(takeUntouchedEnumerations()).toBe(0);
});

test("patching a newly staged result preserves untouched committed containers", async () => {
  const { handle, node, plain } = await board();
  const source = plain().rows[0];
  expect(
    await handle.actions.stage((live) => ({ a: 10, rows: [], other: live.rows[0] }))
  ).toMatchObject({ _tag: "Success" });
  expect(plain().other).toBe(source);
  expect(isObservable(plain().other)).toBe(false);
  expect(node.result.a).toBe(11);
  expect(node.result.rows).toEqual([]);
  expect(node.result.other?.value).toBe(0);
});

test("updaters returning resultCommit preserve draft changes and explicit validity", async () => {
  const { handle, node, plain, takeUntouchedEnumerations } = await board();
  const rows = plain().rows;
  takeUntouchedEnumerations();
  expect(
    await handle.actions.update((current) => {
      rowAt(current, 0).value += 1;
      return Frond.resultCommit(current, { validity: { _tag: "Stale", staleAt: 10 } });
    })
  ).toMatchObject({ _tag: "Success" });
  expect(node.result.rows[0]?.value).toBe(1);
  expect(plain().rows[1]).toBe(rows[1]);
  expect(handle.read()).toMatchObject({ resultValidity: { _tag: "Stale", staleAt: 10 } });
  expect(takeUntouchedEnumerations()).toBe(0);
  expect(
    await handle.actions.update((current) => Frond.resultCommit({ ...current, x: 3 }))
  ).toMatchObject({ _tag: "Success" });
  expect(node.result.x).toBe(3);
  expect(plain().rows[1]).toBe(rows[1]);
  expect(takeUntouchedEnumerations()).toBe(0);
});

test("new containers with embedded drafts normalize untouched entries after later writes", async () => {
  const { handle, node, plain } = await board();
  expect(
    await handle.actions.patch((current) => {
      const row = rowAt(current, 0);
      current.rows = [row];
      const rows = current.rows;
      row.value = 7;
      rows.push({ value: 8 });
    })
  ).toMatchObject({ _tag: "Success" });
  expect(plain().rows).toEqual([{ value: 7 }, { value: 8 }]);
  expect(node.result.rows).toEqual([{ value: 7 }, { value: 8 }]);
});

test("fresh rows assigned in a patch share unchanged rows and notify every result reader", async () => {
  const { node, handle } = await board();
  const liveRows = node.result.rows;
  const liveRow = node.result.rows[3];
  const third = reader(() => node.result.rows[3]?.value);
  const seventh = reader(() => node.result.rows[7]?.value);
  const fresh = Array.from({ length: 1000 }, (_, index) => ({
    value: index === 7 ? 70 : index,
  }));
  expect(
    await handle.actions.patch((current) => {
      current.rows = fresh;
    })
  ).toMatchObject({ _tag: "Success" });
  expect(node.result.rows).not.toBe(liveRows);
  expect(node.result.rows[3]).toBe(liveRow);
  expect(node.result.rows[7]?.value).toBe(70);
  expect(third()).toBe(2);
  expect(seventh()).toBe(2);
});

test("an updater returning fresh rows replaces the array and notifies every result reader", async () => {
  const { node, handle } = await board();
  const liveRows = node.result.rows;
  const third = reader(() => node.result.rows[3]?.value);
  const seventh = reader(() => node.result.rows[7]?.value);
  expect(
    await handle.actions.update((current) => ({
      ...current,
      rows: Array.from({ length: 1000 }, (_, index) => ({ value: index === 7 ? 70 : index })),
    }))
  ).toMatchObject({ _tag: "Success" });
  expect(node.result.rows).not.toBe(liveRows);
  expect(node.result.rows[7]?.value).toBe(70);
  expect(third()).toBe(2);
  expect(seventh()).toBe(2);
});
