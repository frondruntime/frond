import { afterEach, expect, test } from "bun:test";
import "./setup";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "@frondruntime/core";
import { FrondProvider, useNode, useNodeState } from "@frondruntime/react";
import { act, cleanup, render } from "@testing-library/react";
import { autorun, makeAutoObservable } from "mobx";
import { observer } from "mobx-react-lite";
import { createElement } from "react";

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) await runtime.submit({ _tag: "RuntimeStop" });
});

type Board = {
  a: number;
  b: number;
  items: Array<{ id: string; v: number }>;
};

const freshBoard = (): Board => ({
  a: 0,
  b: 0,
  items: [
    { id: "x", v: 0 },
    { id: "y", v: 0 },
  ],
});

let releaseSlow: (() => void) | undefined;
let slowEntered: (() => void) | undefined;

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
    readonly setSame: ActionContract;
    readonly slow: ActionContract;
  };
}>;

class BoardNode extends NodeBase<BoardSpec> {
  static readonly spec = resourceSpec.async<BoardSpec>({
    tag: tag("test/react/render-scope-board"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => freshBoard()),
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
      setSame: Driver.Action((ctx) => {
        ctx.setResult((current) => current);
      }),
      slow: Driver.Action(async () => {
        await new Promise<void>((resolve) => {
          releaseSlow = resolve;
          slowEntered?.();
        });
      }),
    },
    refresh: Driver.Refresh(() => freshBoard()),
  });
}

type Counts = Record<string, number>;

test("baseline: renders and reactions per change", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const handle = runtime.client.node(BoardNode, {});
  await handle.ensureReady();

  const renders: Counts = {
    readA: 0,
    readB: 0,
    readItem: 0,
    actionsOnly: 0,
    stateBusy: 0,
    rowX: 0,
    rowY: 0,
  };
  const ReadA = observer(function ReadA() {
    const node = useNode(BoardNode, {});
    renders.readA = (renders.readA ?? 0) + 1;
    return createElement("i", undefined, node.result.a);
  });
  const ReadB = observer(function ReadB() {
    const node = useNode(BoardNode, {});
    renders.readB = (renders.readB ?? 0) + 1;
    return createElement("i", undefined, node.result.b);
  });
  const RowView = observer(function RowView({ row }: { readonly row: Board["items"][number] }) {
    const key = row.id === "x" ? "rowX" : "rowY";
    renders[key] = (renders[key] ?? 0) + 1;
    return createElement("i", undefined, row.v);
  });
  const ReadItem = observer(function ReadItem() {
    const node = useNode(BoardNode, {});
    renders.readItem = (renders.readItem ?? 0) + 1;
    return node.result.items.map((row) => createElement(RowView, { key: row.id, row }));
  });
  const ActionsOnly = observer(function ActionsOnly() {
    const node = useNode(BoardNode, {});
    renders.actionsOnly = (renders.actionsOnly ?? 0) + 1;
    return createElement("button", { type: "button", onClick: () => node.actions.patchA() }, "go");
  });
  const StateBusy = observer(function StateBusy() {
    const state = useNodeState(BoardNode, {});
    renders.stateBusy = (renders.stateBusy ?? 0) + 1;
    return createElement("i", undefined, state.busy ? "busy" : "idle");
  });

  const ready = handle.readReady();
  const reactions: Counts = { nodeA: 0, nodeB: 0, nodeItem: 0 };
  const disposers = [
    autorun(() => {
      void ready.result.a;
      reactions.nodeA = (reactions.nodeA ?? 0) + 1;
    }),
    autorun(() => {
      void ready.result.b;
      reactions.nodeB = (reactions.nodeB ?? 0) + 1;
    }),
    autorun(() => {
      void ready.result.items[0]?.v;
      reactions.nodeItem = (reactions.nodeItem ?? 0) + 1;
    }),
  ];

  render(
    <FrondProvider runtime={runtime}>
      <ReadA />
      <ReadB />
      <ReadItem />
      <ActionsOnly />
      <StateBusy />
    </FrondProvider>
  );

  const rows: Array<Record<string, string | number>> = [];
  let lastRenders = { ...renders };
  let lastReactions = { ...reactions };
  const snap = (label: string): void => {
    const row: Record<string, string | number> = { change: label };
    for (const key of Object.keys(renders))
      row[`r:${key}`] = (renders[key] ?? 0) - (lastRenders[key] ?? 0);
    for (const key of Object.keys(reactions))
      row[`m:${key}`] = (reactions[key] ?? 0) - (lastReactions[key] ?? 0);
    rows.push(row);
    lastRenders = { ...renders };
    lastReactions = { ...reactions };
  };

  snap("mount");
  await act(async () => {
    expect((await handle.actions.patchA())._tag).toBe("Success");
  });
  snap("patchResult a");
  await act(async () => {
    expect((await handle.actions.spreadA())._tag).toBe("Success");
  });
  snap("setResult spread a");
  await act(async () => {
    expect((await handle.actions.patchItem())._tag).toBe("Success");
  });
  snap("patchResult items[0].v");
  await act(async () => {
    expect((await handle.actions.setSame())._tag).toBe("Success");
  });
  snap("setResult same ref");
  let pending: Promise<unknown> | undefined;
  await act(async () => {
    const entered = new Promise<void>((resolve) => {
      slowEntered = resolve;
    });
    pending = handle.actions.slow();
    await entered;
  });
  snap("action start (no write)");
  await act(async () => {
    releaseSlow?.();
    await pending;
  });
  snap("action end (no write)");
  await act(async () => {
    await handle.refresh();
  });
  snap("refresh, changed data");
  await act(async () => {
    await handle.refresh();
  });
  snap("refresh, equal data");

  for (const dispose of disposers) dispose();
  const changingCommits = new Set([
    "patchResult a",
    "setResult spread a",
    "patchResult items[0].v",
    "refresh, changed data",
  ]);
  for (const row of rows) {
    const changed = changingCommits.has(String(row.change)) ? 1 : 0;
    for (const reader of ["readA", "readB", "readItem"]) {
      expect(row[`r:${reader}`]).toBe(changed);
    }
    for (const reaction of ["nodeA", "nodeB", "nodeItem"]) {
      expect(row[`m:${reaction}`]).toBe(changed);
    }
    expect(row["r:actionsOnly"]).toBe(0);
    expect(row["r:rowX"]).toBe(
      row.change === "patchResult items[0].v" || row.change === "refresh, changed data" ? 1 : 0
    );
    expect(row["r:rowY"]).toBe(0);
  }
});

// An author-observable class result shared through patches keeps its
// reference. Child observers receive the model directly so its own fields
// determine which child renders.
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
    tag: tag("test/react/render-scope-pair"),
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

test("baseline: shared observable result patch", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const handle = runtime.client.node(PairNode, {});
  await handle.ensureReady();
  const renders: Counts = { snapshot: 0, readA: 0, readB: 0 };
  const ReadA = observer(function ReadA({ model }: { readonly model: Pair }) {
    renders.readA = (renders.readA ?? 0) + 1;
    return createElement("i", undefined, model.a);
  });
  const ReadB = observer(function ReadB({ model }: { readonly model: Pair }) {
    renders.readB = (renders.readB ?? 0) + 1;
    return createElement("i", undefined, model.b);
  });
  const SnapshotReader = observer(function SnapshotReader() {
    const node = useNode(PairNode, {});
    renders.snapshot = (renders.snapshot ?? 0) + 1;
    return (
      <>
        <ReadA model={node.result} />
        <ReadB model={node.result} />
      </>
    );
  });
  render(
    <FrondProvider runtime={runtime}>
      <SnapshotReader />
    </FrondProvider>
  );
  const before = { ...renders };
  await act(async () => {
    expect((await handle.actions.patchA())._tag).toBe("Success");
  });
  expect((renders.snapshot ?? 0) - (before.snapshot ?? 0)).toBe(0);
  expect((renders.readA ?? 0) - (before.readA ?? 0)).toBe(1);
  expect((renders.readB ?? 0) - (before.readB ?? 0)).toBe(0);
});
