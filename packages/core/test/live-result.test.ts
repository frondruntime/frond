import { afterEach, expect, test } from "bun:test";
import { autorun, isObservable, makeAutoObservable, makeObservable, observable } from "mobx";
import { carryInternal, createRuntime, Driver, internalOf, Key, withInternal } from "../src";
import {
  type ActionContract,
  type Dep,
  dep,
  dependencies,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "../src/node";

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.submit({ _tag: "RuntimeStop" });
});

async function started(development = true) {
  const runtime = createRuntime({ development, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  return runtime;
}

// Counts autorun reruns per reader; the first run is not counted.
function readers(read: Record<string, () => unknown>) {
  const reruns: Record<string, number> = {};
  const disposers = Object.entries(read).map(([name, run]) => {
    reruns[name] = -1;
    return autorun(() => {
      run();
      reruns[name] = (reruns[name] ?? 0) + 1;
    });
  });
  return {
    take(): Record<string, number> {
      const taken = { ...reruns };
      for (const name of Object.keys(reruns)) reruns[name] = 0;
      return taken;
    },
    dispose(): void {
      for (const dispose of disposers) dispose();
    },
  };
}

type Board = {
  a: number;
  b: number;
  items: Array<{ id: string; v: number }>;
};

let refreshBoard: Board = { a: 0, b: 0, items: [] };

type BoardSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Board;
  readonly actions: {
    readonly patchA: ActionContract;
    readonly spreadA: ActionContract;
    readonly patchItem: ActionContract;
    readonly pushItem: ActionContract;
    readonly dropB: ActionContract;
    readonly pushInPlace: ActionContract;
    readonly patchThenFail: ActionContract<void, { readonly _tag: "Rejected" }>;
  };
}>;

const freshBoard = (): Board => ({
  a: 0,
  b: 0,
  items: [
    { id: "x", v: 0 },
    { id: "y", v: 0 },
  ],
});

class BoardNode extends NodeBase<BoardSpec> {
  static readonly spec = resourceSpec.async<BoardSpec>({
    tag: "test/live-result/board",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => freshBoard()),
    refresh: Driver.Refresh((ctx) => {
      ctx.setResult(structuredClone(refreshBoard));
    }),
    actions: {
      patchA: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.a += 1;
        });
      }),
      spreadA: Driver.Action((ctx) => {
        ctx.setResult((current) => ({ ...current, a: current.a + 1 }));
      }),
      patchItem: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          const first = current.items[0];
          if (first !== undefined) first.v += 1;
        });
      }),
      pushItem: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.items.push({ id: "z", v: 0 });
        });
      }),
      // Mutates the draft items, then spreads the root.
      pushInPlace: Driver.Action((ctx) => {
        ctx.setResult((current) => {
          current.items.push({ id: "w", v: 0 });
          return { ...current };
        });
      }),
      dropB: Driver.Action((ctx) => {
        ctx.setResult((current) => {
          const { b: _dropped, ...rest } = current;
          return rest as Board;
        });
      }),
      patchThenFail: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.a += 100;
        });
        throw { _tag: "Rejected" } as const;
      }),
    },
  });
}

async function board() {
  const runtime = await started();
  const handle = runtime.client.node(BoardNode, {});
  await handle.ensureReady();
  const node = handle.readReady();
  const watch = readers({
    a: () => node.result.a,
    b: () => node.result.b,
    item0: () => node.result.items[0]?.v,
    item1: () => node.result.items[1]?.v,
    length: () => node.result.items.length,
  });
  return { handle, node, watch };
}

test("a patch replaces the snapshot and reruns every result reader", async () => {
  const { handle, node, watch } = await board();
  const root = node.result;

  expect((await handle.actions.patchA())._tag).toBe("Success");
  expect(watch.take()).toEqual({ a: 1, b: 1, item0: 1, item1: 1, length: 1 });
  expect(node.result.a).toBe(1);

  expect((await handle.actions.patchItem())._tag).toBe("Success");
  expect(watch.take()).toEqual({ a: 1, b: 1, item0: 1, item1: 1, length: 1 });
  expect(node.result.items[0]?.v).toBe(1);

  // Previously returned snapshots stay unchanged across writes.
  expect(node.result).not.toBe(root);
  expect(root.a).toBe(0);
  watch.dispose();
});

test("a spread setResult reruns every result reader", async () => {
  const { handle, node, watch } = await board();

  expect((await handle.actions.spreadA())._tag).toBe("Success");
  expect(watch.take()).toEqual({ a: 1, b: 1, item0: 1, item1: 1, length: 1 });
  expect(node.result.a).toBe(1);
  watch.dispose();
});

test("a pushed array entry and a removed key reach their readers", async () => {
  const { handle, node, watch } = await board();

  expect((await handle.actions.pushItem())._tag).toBe("Success");
  expect(node.result.items.map((item) => item.id)).toEqual(["x", "y", "z"]);
  expect(watch.take()).toMatchObject({ a: 1, b: 1, length: 1 });

  expect((await handle.actions.dropB())._tag).toBe("Success");
  expect("b" in node.result).toBe(false);
  expect(Object.keys(node.result)).toEqual(["a", "items"]);
  expect(watch.take()).toMatchObject({ a: 1, b: 1, length: 1 });
  watch.dispose();
});

test("a changing refresh reruns every result reader", async () => {
  const { handle, watch } = await board();

  refreshBoard = freshBoard();
  await handle.refresh();
  expect(watch.take()).toEqual({ a: 0, b: 0, item0: 0, item1: 0, length: 0 });

  refreshBoard = { ...freshBoard(), b: 5 };
  await handle.refresh();
  expect(watch.take()).toEqual({ a: 1, b: 1, item0: 1, item1: 1, length: 1 });
  watch.dispose();
});

test("a failed operation leaves the result and its readers untouched", async () => {
  const { handle, node, watch } = await board();

  expect((await handle.actions.patchThenFail())._tag).toBe("Failure");
  expect(node.result.a).toBe(0);
  expect(watch.take()).toEqual({ a: 0, b: 0, item0: 0, item1: 0, length: 0 });
  watch.dispose();
});

test("a refresh with equal data reruns no reader", async () => {
  const { handle, watch } = await board();

  refreshBoard = freshBoard();
  await handle.refresh();
  expect(watch.take()).toEqual({ a: 0, b: 0, item0: 0, item1: 0, length: 0 });
  watch.dispose();
});

type Session = { readonly user: string; readonly visits: number };

type SessionSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Session;
  readonly actions: {
    readonly visit: ActionContract;
    readonly spreadCarry: ActionContract;
    readonly spreadDrop: ActionContract;
  };
}>;

class SessionNode extends NodeBase<SessionSpec> {
  static readonly spec = resourceSpec.async<SessionSpec>({
    tag: "test/live-result/session",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => withInternal({ user: "ada", visits: 0 }, "socket-1")),
    actions: {
      visit: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          (current as { visits: number }).visits += 1;
        });
      }),
      spreadCarry: Driver.Action((ctx) => {
        ctx.setResult((current) =>
          carryInternal(current as never, { ...current, visits: current.visits + 1 })
        );
      }),
      spreadDrop: Driver.Action((ctx) => {
        ctx.setResult((current) => ({ ...current, visits: current.visits + 1 }));
      }),
    },
  });
}

test("the internal envelope slot follows the committed result", async () => {
  const runtime = await started();
  const handle = runtime.client.node(SessionNode, {});
  await handle.ensureReady();
  const node = handle.readReady();
  const internal = () => internalOf(node.result as never);

  expect(internal()).toBe("socket-1");
  expect((await handle.actions.visit())._tag).toBe("Success");
  expect(internal()).toBe("socket-1");
  expect((await handle.actions.spreadCarry())._tag).toBe("Success");
  expect(internal()).toBe("socket-1");
  expect(node.result.visits).toBe(2);
  expect((await handle.actions.spreadDrop())._tag).toBe("Success");
  expect(() => internal()).toThrow(TypeError);
  expect(Object.keys(node.result)).toEqual(["user", "visits"]);
  expect(JSON.parse(JSON.stringify(node.result))).toEqual({ user: "ada", visits: 3 });
});

class Pair {
  a = 0;
  b = 0;
  constructor() {
    makeAutoObservable(this);
  }
}

type PairSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Pair;
  readonly actions: { readonly patchA: ActionContract };
}>;

class PairNode extends NodeBase<PairSpec> {
  static readonly spec = resourceSpec.async<PairSpec>({
    tag: "test/live-result/pair",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    resultPatch: { nonPlainClone: "share" },
    acquire: Driver.Acquire(() => new Pair()),
    actions: {
      patchA: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.a += 1;
        });
      }),
    },
  });
}

test("an author-observable result is kept by reference", async () => {
  const runtime = await started();
  const handle = runtime.client.node(PairNode, {});
  await handle.ensureReady();
  const node = handle.readReady();
  const pair = node.result;
  const watch = readers({ a: () => node.result.a, b: () => node.result.b });

  expect(pair).toBeInstanceOf(Pair);
  expect((await handle.actions.patchA())._tag).toBe("Success");
  expect(node.result).toBe(pair);
  // The observable field notifies its own readers without an extra commit notification.
  expect(watch.take()).toEqual({ a: 1, b: 0 });
  watch.dispose();
});

class ObservableRow {
  value = 0;

  constructor() {
    makeObservable(this, { value: observable });
  }
}

const observableRows = () => Array.from({ length: 200 }, () => new ObservableRow());

class ObservableRows {
  rows = observableRows();
  // An observable boundary owns its contents, including unannotated fields.
  cache = new Map<string, number>();

  constructor() {
    makeObservable(this, { rows: observable.ref });
  }
}

for (const development of [true, false]) {
  for (const root of ["observable", "plain"] as const) {
    test(`share patches with ${root} roots notify only the changed observable row (development: ${development})`, async () => {
      type RowsSpec = NodeSpec<{
        readonly mode: "async";
        readonly key: Key.Singleton;
        readonly result: { rows: Array<ObservableRow> };
        readonly actions: { readonly patchRow: ActionContract<number> };
      }>;
      class RowsNode extends NodeBase<RowsSpec> {
        static readonly spec = resourceSpec.async<RowsSpec>({
          tag: "test/live-result/observable-rows",
          key: () => Key.singleton(),
          resultPatch: { nonPlainClone: "share" },
          acquire: Driver.Acquire(() =>
            root === "observable" ? new ObservableRows() : { rows: observableRows() }
          ),
          actions: {
            patchRow: Driver.Action((ctx, index) => {
              ctx.patchResult((current) => {
                const row = current.rows[index];
                if (row !== undefined) row.value += 1;
              });
            }),
          },
        });
      }
      const runtime = await started(development);
      const handle = runtime.client.node(RowsNode, {});
      await handle.ensureReady();
      const node = handle.readReady();
      const before = node.result;
      const watch = readers({
        root: () => node.result,
        ...Object.fromEntries(
          before.rows.map((_, index) => [String(index), () => node.result.rows[index]?.value])
        ),
      });
      try {
        expect((await handle.actions.patchRow(7))._tag).toBe("Success");
        expect(watch.take()).toEqual({
          root: 0,
          ...Object.fromEntries(
            before.rows.map((_, index) => [String(index), index === 7 ? 1 : 0])
          ),
        });
        for (let patch = 1; patch < 100; patch += 1) {
          expect((await handle.actions.patchRow(7))._tag).toBe("Success");
        }
        expect(watch.take()).toEqual({
          root: 0,
          ...Object.fromEntries(
            before.rows.map((_, index) => [String(index), index === 7 ? 99 : 0])
          ),
        });
        expect(node.result).toBe(before);
        expect(node.result.rows[7]?.value).toBe(100);
      } finally {
        watch.dispose();
      }
    });
  }
}

test("a mixed result notifies every result reader until its non-observable Map is removed", async () => {
  type MixedSpec = NodeSpec<{
    readonly mode: "async";
    readonly key: Key.Singleton;
    readonly result: { model: Pair; map: Map<string, number> | null };
    readonly actions: {
      readonly patchMap: ActionContract;
      readonly patchModel: ActionContract;
      readonly removeMap: ActionContract;
    };
  }>;
  class MixedNode extends NodeBase<MixedSpec> {
    static readonly spec = resourceSpec.async<MixedSpec>({
      tag: "test/live-result/mixed",
      key: () => Key.singleton(),
      resultPatch: { nonPlainClone: "share" },
      acquire: Driver.Acquire(() => ({ model: new Pair(), map: new Map([["count", 0]]) })),
      actions: {
        patchMap: Driver.Action((ctx) => {
          ctx.patchResult((current) => {
            current.map?.set("count", 1);
          });
        }),
        patchModel: Driver.Action((ctx) => {
          ctx.patchResult((current) => {
            current.model.a += 1;
          });
        }),
        removeMap: Driver.Action((ctx) => {
          ctx.patchResult((current) => {
            current.map = null;
          });
        }),
      },
    });
  }
  const runtime = await started();
  const handle = runtime.client.node(MixedNode, {});
  await handle.ensureReady();
  const node = handle.readReady();
  const before = node.result;
  const watch = readers({
    root: () => node.result,
    a: () => node.result.model.a,
    b: () => node.result.model.b,
    map: () => node.result.map?.get("count"),
  });
  try {
    expect((await handle.actions.patchMap())._tag).toBe("Success");
    expect(node.result).toBe(before);
    expect(node.result.map?.get("count")).toBe(1);
    expect(watch.take()).toEqual({ root: 1, a: 1, b: 1, map: 1 });
    expect((await handle.actions.patchModel())._tag).toBe("Success");
    expect(watch.take()).toEqual({ root: 1, a: 2, b: 1, map: 1 });
    expect((await handle.actions.removeMap())._tag).toBe("Success");
    expect(watch.take()).toEqual({ root: 1, a: 1, b: 1, map: 1 });
    expect((await handle.actions.patchModel())._tag).toBe("Success");
    expect(watch.take()).toEqual({ root: 0, a: 1, b: 0, map: 0 });
    expect(node.result.model.a).toBe(2);
  } finally {
    watch.dispose();
  }
});

// A class instance MobX does not observe: the committed snapshot keeps it by
// reference, and a shared patch changes it in place.
class Tally {
  x = 0;
}

type Ledger = { label: string; count: number; tally: Tally };

type LedgerSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Ledger;
  readonly actions: {
    readonly bumpTally: ActionContract;
    readonly bumpTallyAndCount: ActionContract;
    readonly keep: ActionContract;
  };
}>;

class LedgerNode extends NodeBase<LedgerSpec> {
  static readonly spec = resourceSpec.async<LedgerSpec>({
    tag: "test/live-result/ledger",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    resultPatch: { nonPlainClone: "share" },
    acquire: Driver.Acquire(() => ({ label: "l", count: 0, tally: new Tally() })),
    actions: {
      bumpTally: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.tally.x += 1;
        });
      }),
      bumpTallyAndCount: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.tally.x += 1;
          current.count += 1;
        });
      }),
      keep: Driver.Action(() => {}),
    },
  });
}

async function ledger() {
  const runtime = await started();
  const handle = runtime.client.node(LedgerNode, {});
  await handle.ensureReady();
  const node = handle.readReady();
  const watch = readers({
    tally: () => node.result.tally.x,
    count: () => node.result.count,
  });
  return { handle, node, watch };
}

test("a shared patch of a nested value MobX does not observe reaches its readers", async () => {
  const { handle, node, watch } = await ledger();
  const tally = node.result.tally;

  expect((await handle.actions.bumpTally())._tag).toBe("Success");
  expect(node.result.tally).toBe(tally);
  // Every reader of a result that holds such a value reruns on a patch.
  expect(watch.take()).toEqual({ tally: 1, count: 1 });

  expect((await handle.actions.bumpTallyAndCount())._tag).toBe("Success");
  expect(node.result.tally.x).toBe(2);
  expect(watch.take()).toEqual({ tally: 1, count: 1 });
  watch.dispose();
});

test("an action that writes nothing reruns no reader of such a result", async () => {
  const { handle, watch } = await ledger();

  expect((await handle.actions.bumpTally())._tag).toBe("Success");
  watch.take();
  expect((await handle.actions.keep())._tag).toBe("Success");
  expect(watch.take()).toEqual({ tally: 0, count: 0 });
  watch.dispose();
});

type TallySpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Tally;
  readonly actions: { readonly bump: ActionContract };
}>;

class TallyNode extends NodeBase<TallySpec> {
  static readonly spec = resourceSpec.async<TallySpec>({
    tag: "test/live-result/tally",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    resultPatch: { nonPlainClone: "share" },
    acquire: Driver.Acquire(() => new Tally()),
    actions: {
      bump: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.x += 1;
        });
      }),
    },
  });
}

test("a shared patch of a root MobX does not observe reaches its readers", async () => {
  const runtime = await started();
  const handle = runtime.client.node(TallyNode, {});
  await handle.ensureReady();
  const node = handle.readReady();
  const tally = node.result;
  const watch = readers({ x: () => node.result.x });

  expect((await handle.actions.bump())._tag).toBe("Success");
  expect(node.result).toBe(tally);
  expect(watch.take()).toEqual({ x: 1 });
  watch.dispose();
});

type Loop = { name: string; self?: Loop };

type ShapeSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly a: number } | ReadonlyArray<number> | null | Loop;
  readonly actions: {
    readonly toArray: ActionContract;
    readonly toNull: ActionContract;
    readonly toLoop: ActionContract;
  };
}>;

let loop: Loop = { name: "loop" };

class ShapeNode extends NodeBase<ShapeSpec> {
  static readonly spec = resourceSpec.async<ShapeSpec>({
    tag: "test/live-result/shape",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => ({ a: 1 })),
    actions: {
      toArray: Driver.Action((ctx) => {
        ctx.setResult([1, 2]);
      }),
      toNull: Driver.Action((ctx) => {
        ctx.setResult(null);
      }),
      toLoop: Driver.Action((ctx) => {
        loop = { name: "loop" };
        loop.self = loop;
        ctx.setResult(loop);
      }),
    },
  });
}

test("a result that changes shape replaces the root", async () => {
  const runtime = await started();
  const handle = runtime.client.node(ShapeNode, {});
  await handle.ensureReady();
  const node = handle.readReady();
  const watch = readers({ root: () => node.result });

  expect((await handle.actions.toArray())._tag).toBe("Success");
  expect(Array.isArray(node.result)).toBe(true);
  expect([...(node.result as ReadonlyArray<number>)]).toEqual([1, 2]);
  expect((await handle.actions.toNull())._tag).toBe("Success");
  expect(node.result).toBeNull();
  expect(watch.take()).toEqual({ root: 2 });
  watch.dispose();
});

test("a cyclic result is kept by reference", async () => {
  const runtime = await started();
  const handle = runtime.client.node(ShapeNode, {});
  await handle.ensureReady();
  const node = handle.readReady();

  expect((await handle.actions.toLoop())._tag).toBe("Success");
  expect(node.result).toBe(loop);
});

type ProfileSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly profile: { readonly name: string } };
  readonly actions: { readonly rename: ActionContract };
}>;

class ProfileNode extends NodeBase<ProfileSpec> {
  static readonly spec = resourceSpec.async<ProfileSpec>({
    tag: "test/live-result/profile",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => ({ profile: { name: "ada" } })),
    actions: {
      rename: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          (current.profile as { name: string }).name = "bob";
        });
      }),
    },
  });
}

type CardSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: { readonly source: Dep<typeof ProfileNode> };
  readonly result: { readonly profile: { readonly name: string }; readonly opened: number };
  readonly actions: { readonly open: ActionContract };
}>;

class CardNode extends NodeBase<CardSpec> {
  static readonly spec = resourceSpec.async<CardSpec>({
    tag: "test/live-result/card",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({ source: dep(ProfileNode, {}) })),
    acquire: Driver.Acquire((ctx) => ({ profile: ctx.deps.source.result.profile, opened: 0 })),
    actions: {
      open: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          (current as { opened: number }).opened += 1;
        });
      }),
    },
  });
}

test("a dependent that embeds a dependency's result can still patch", async () => {
  const runtime = await started();
  const handle = runtime.client.node(CardNode, {});
  await handle.ensureReady();

  expect((await handle.actions.open())._tag).toBe("Success");
  const node = handle.readReady();
  expect(node.result.opened).toBe(1);
  expect(node.result.profile.name).toBe("ada");
});

test("a dependent holds its dependency's frozen snapshot across subsequent writes", async () => {
  const runtime = await started();
  const handle = runtime.client.node(CardNode, {});
  await handle.ensureReady();
  const committed = () => {
    const read = handle.read();
    return read._tag === "Ready" ? read.result : undefined;
  };
  const before = committed();

  expect(isObservable(before?.profile)).toBe(false);
  expect(structuredClone(before)).toEqual({ profile: { name: "ada" }, opened: 0 });

  // The dependency's next write reaches its own readers, never the
  // dependent's committed value.
  expect((await runtime.client.node(ProfileNode, {}).actions.rename())._tag).toBe("Success");
  expect(committed()?.profile.name).toBe("ada");
});

test("a spread after a draft mutation commits and notifies array readers", async () => {
  const runtime = await started();
  const handle = runtime.client.node(BoardNode, {});
  await handle.ensureReady();
  const node = handle.readReady();
  const watch = readers({ length: () => node.result.items.length, a: () => node.result.a });

  expect(await handle.actions.pushInPlace()).toMatchObject({
    _tag: "Success",
  });
  expect(node.result.items.map((item) => item.id)).toEqual(["x", "y", "w"]);
  expect(watch.take()).toEqual({ length: 1, a: 1 });
  watch.dispose();
});
