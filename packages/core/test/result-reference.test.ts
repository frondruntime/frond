import { afterEach, expect, test } from "bun:test";
import { autorun, isObservable } from "mobx";
import * as Frond from "../src";
import * as FrondTest from "../src/testing";

type Row = { readonly id: string; readonly name: string };
type Board = { readonly title: string; readonly rows: ReadonlyArray<Row> };

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

async function board(initial: Board) {
  type Spec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly key: Frond.Key.Singleton;
    readonly result: Board;
    readonly actions: {
      readonly replace: Frond.ActionContract<Board>;
      readonly patch: Frond.ActionContract<(current: { title: string; rows: Array<Row> }) => void>;
    };
  }>;
  class BoardNode extends Frond.NodeBase<Spec> {
    static readonly spec = Frond.serviceSpec.async<Spec>({
      tag: Frond.tag("test/result-reference"),
      key: () => Frond.Key.singleton(),
      acquire: Frond.Driver.Acquire(() => initial),
      actions: {
        replace: Frond.Driver.Action((context, value) => context.setResult(value)),
        patch: Frond.Driver.Action((context, recipe) =>
          context.patchResult(recipe as (current: Board) => void)
        ),
      },
    });
  }
  const harness = FrondTest.createFrondTestHarness();
  harnesses.push(harness);
  const node = await harness.startNode(BoardNode, {});
  const handle = harness.node(BoardNode, {});
  return { node, handle, committed: () => harness.readReady(handle).result };
}

const rows = (count: number): Array<Row> =>
  Array.from({ length: count }, (_, index) => ({ id: `r${index}`, name: `row ${index}` }));

test("node.result is the committed snapshot, frozen and not observable", async () => {
  const subject = await board({ title: "t", rows: rows(3) });
  expect(subject.node.result).toBe(subject.committed());
  expect(Object.isFrozen(subject.node.result)).toBe(true);
  expect(isObservable(subject.node.result)).toBe(false);
  expect(isObservable(subject.node.result.rows)).toBe(false);
  expect(isObservable(subject.node.result.rows[0])).toBe(false);

  await subject.handle.actions.patch((current) => {
    current.title = "u";
  });
  expect(subject.node.result).toBe(subject.committed());
  expect(subject.node.result.title).toBe("u");
});

test("a patch makes new objects only along the changed path", async () => {
  const subject = await board({ title: "t", rows: rows(3) });
  const before = subject.node.result;
  await subject.handle.actions.patch((current) => {
    const first = current.rows[0];
    if (first !== undefined) current.rows[0] = { ...first, name: "edited" };
  });
  const after = subject.node.result;
  expect(after).not.toBe(before);
  expect(after.rows).not.toBe(before.rows);
  expect(after.rows[0]).not.toBe(before.rows[0]);
  expect(after.rows[0]?.name).toBe("edited");
  expect(after.rows[1]).toBe(before.rows[1]);
  expect(after.rows[2]).toBe(before.rows[2]);
});

test("a prepend by patch keeps every existing row object", async () => {
  const subject = await board({ title: "t", rows: rows(3) });
  const before = subject.node.result.rows;
  await subject.handle.actions.patch((current) => {
    current.rows.unshift({ id: "new", name: "new" });
  });
  const after = subject.node.result.rows;
  expect(after).toHaveLength(4);
  expect(after[1]).toBe(before[0]);
  expect(after[2]).toBe(before[1]);
  expect(after[3]).toBe(before[2]);
});

test("readers rerun once per changing commit and not for an equal one", async () => {
  const subject = await board({ title: "t", rows: rows(3) });
  let runs = 0;
  const stop = autorun(() => {
    void subject.node.result;
    runs += 1;
  });
  try {
    expect(runs).toBe(1);
    await subject.handle.actions.patch((current) => {
      current.title = "u";
    });
    expect(runs).toBe(2);
    await subject.handle.actions.patch((current) => {
      current.title = "u";
    });
    expect(runs).toBe(2);
    await subject.handle.actions.replace({ title: "u", rows: rows(3) });
    expect(runs).toBe(2);
  } finally {
    stop();
  }
});

test("an equal setResult keeps the previous snapshot", async () => {
  const subject = await board({ title: "t", rows: rows(3) });
  const before = subject.node.result;
  await subject.handle.actions.replace({ title: "t", rows: rows(3) });
  expect(subject.node.result).toBe(before);
});
