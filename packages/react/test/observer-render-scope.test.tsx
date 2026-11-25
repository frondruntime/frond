import { afterEach, expect, spyOn, test } from "bun:test";
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
import {
  FrondProvider,
  FrondReactUsageError,
  Preload,
  useNode,
  useNodes,
} from "@frondruntime/react";
import { act, cleanup, render } from "@testing-library/react";
import { makeAutoObservable, makeObservable, observable } from "mobx";
import { observer } from "mobx-react-lite";
import { Component, createElement, type ReactNode, Suspense } from "react";

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) await runtime.submit({ _tag: "RuntimeStop" });
});

async function started(development = true) {
  const runtime = createRuntime({ development, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  return runtime;
}

function mount(runtime: ReturnType<typeof createRuntime>, children: ReactNode): void {
  render(createElement(FrondProvider, { runtime }, children));
}

type Board = { a: number; b: number };

type BoardSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Board;
  readonly actions: { readonly patchA: ActionContract; readonly spreadA: ActionContract };
}>;

function boardNode(name: string) {
  return class BoardNode extends NodeBase<BoardSpec> {
    static readonly spec = resourceSpec.async<BoardSpec>({
      tag: tag(`test/react/observer-render-scope/${name}`),
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => ({ a: 0, b: 0 })),
      actions: {
        patchA: Driver.Action((ctx) => {
          ctx.patchResult((current) => {
            current.a += 1;
          });
        }),
        spreadA: Driver.Action((ctx) => {
          ctx.setResult((current) => ({ ...current, a: current.a + 1 }));
        }),
      },
    });
  };
}

test("a changing result commit renders every snapshot reader and skips actions-only readers", async () => {
  const BoardNode = boardNode("fields");
  const runtime = await started();
  const handle = runtime.client.node(BoardNode, {});
  await handle.ensureReady();
  const renders = { readA: 0, readB: 0, actionsOnly: 0, many: 0 };
  const ReadA = observer(function ReadA() {
    const node = useNode(BoardNode, {});
    renders.readA += 1;
    return createElement("i", undefined, node.result.a);
  });
  const ReadB = observer(function ReadB() {
    const node = useNode(BoardNode, {});
    renders.readB += 1;
    return createElement("i", undefined, node.result.b);
  });
  const ActionsOnly = observer(function ActionsOnly() {
    const node = useNode(BoardNode, {});
    renders.actionsOnly += 1;
    return createElement("button", { type: "button", onClick: () => node.actions.patchA() });
  });
  const ManyReadB = observer(function ManyReadB() {
    const { board } = useNodes({ board: [BoardNode, {}] });
    renders.many += 1;
    return createElement("i", undefined, board.result.b);
  });
  mount(
    runtime,
    <>
      <ReadA />
      <ReadB />
      <ActionsOnly />
      <ManyReadB />
    </>
  );
  const before = { ...renders };

  await act(async () => {
    expect((await handle.actions.patchA())._tag).toBe("Success");
  });
  await act(async () => {
    expect((await handle.actions.spreadA())._tag).toBe("Success");
  });

  expect({
    readA: renders.readA - before.readA,
    readB: renders.readB - before.readB,
    actionsOnly: renders.actionsOnly - before.actionsOnly,
    many: renders.many - before.many,
  }).toEqual({ readA: 2, readB: 2, actionsOnly: 0, many: 2 });
});

// A class instance MobX does not observe, shared through patches.
class Tally {
  x = 0;
}

type TallySpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { label: string; tally: Tally };
  readonly actions: { readonly bump: ActionContract };
}>;

class TallyNode extends NodeBase<TallySpec> {
  static readonly spec = resourceSpec.async<TallySpec>({
    tag: tag("test/react/observer-render-scope/tally"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    resultPatch: { nonPlainClone: "share" },
    acquire: Driver.Acquire(() => ({ label: "t", tally: new Tally() })),
    actions: {
      bump: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.tally.x += 1;
        });
      }),
    },
  });
}

test("a shared patch of a value MobX does not observe still renders its observer reader", async () => {
  const runtime = await started();
  const handle = runtime.client.node(TallyNode, {});
  await handle.ensureReady();
  const ReadTally = observer(function ReadTally() {
    const node = useNode(TallyNode, {});
    return createElement("i", { "data-testid": "tally" }, node.result.tally.x);
  });
  mount(runtime, <ReadTally />);

  await act(async () => {
    expect((await handle.actions.bump())._tag).toBe("Success");
  });

  expect(document.querySelector("[data-testid=tally]")?.textContent).toBe("1");
});

// An author-observable class result: its own fields notify their readers.
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
    tag: tag("test/react/observer-render-scope/pair"),
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

test("a shared model patch renders only child observers reading the changed field", async () => {
  const runtime = await started();
  const handle = runtime.client.node(PairNode, {});
  await handle.ensureReady();
  const renders = { snapshot: 0, readA: 0, readB: 0 };
  const ReadA = observer(function ReadA({ model }: { readonly model: Pair }) {
    renders.readA += 1;
    return createElement("i", undefined, model.a);
  });
  const ReadB = observer(function ReadB({ model }: { readonly model: Pair }) {
    renders.readB += 1;
    return createElement("i", undefined, model.b);
  });
  const SnapshotReader = observer(function SnapshotReader() {
    const node = useNode(PairNode, {});
    renders.snapshot += 1;
    return (
      <>
        <ReadA model={node.result} />
        <ReadB model={node.result} />
      </>
    );
  });
  mount(runtime, <SnapshotReader />);
  const before = { ...renders };

  await act(async () => {
    expect((await handle.actions.patchA())._tag).toBe("Success");
  });

  expect(renders.snapshot - before.snapshot).toBe(0);
  expect(renders.readA - before.readA).toBe(1);
  expect(renders.readB - before.readB).toBe(0);
});

for (const root of ["observable", "plain", "mixed"] as const) {
  test(`shared ${root} results keep useNode and useNodes render scope after suspension`, async () => {
    const initial = { model: new Pair(), tally: root === "mixed" ? new Tally() : null };
    if (root === "observable") makeObservable(initial, { model: observable.ref });
    const acquire = Promise.withResolvers<typeof initial>();
    type ModelSpec = NodeSpec<{
      readonly mode: "async";
      readonly key: Key.Singleton;
      readonly result: typeof initial;
      readonly actions: { readonly patchA: ActionContract };
    }>;
    class ModelNode extends NodeBase<ModelSpec> {
      static readonly spec = resourceSpec.async<ModelSpec>({
        tag: `test/react/observer-render-scope/suspended-${root}`,
        key: () => Key.singleton(),
        resultPatch: { nonPlainClone: "share" },
        acquire: Driver.Acquire(() => acquire.promise),
        actions: {
          patchA: Driver.Action((ctx) => {
            ctx.patchResult((current) => {
              current.model.a += 1;
            });
          }),
        },
      });
    }
    const runtime = await started();
    const handle = runtime.client.node(ModelNode, {});
    const renders = { single: 0, many: 0, readA: 0, readB: 0 };
    const ReadA = observer(function ReadA({ model }: { readonly model: Pair }) {
      renders.readA += 1;
      return <i data-testid="model-a">{model.a}</i>;
    });
    const ReadB = observer(function ReadB({ model }: { readonly model: Pair }) {
      renders.readB += 1;
      return <i>{model.b}</i>;
    });
    const Single = observer(function Single() {
      const node = useNode(ModelNode, {});
      renders.single += 1;
      return (
        <>
          <ReadA model={node.result.model} />
          <ReadB model={node.result.model} />
        </>
      );
    });
    const Many = observer(function Many() {
      const { model } = useNodes({ model: [ModelNode, {}] });
      renders.many += 1;
      return <i>{model.result === initial ? "same result" : "new result"}</i>;
    });
    await act(async () => {
      mount(
        runtime,
        <Suspense fallback={<span>loading model</span>}>
          <Single />
          <Many />
        </Suspense>
      );
    });
    expect(document.body.textContent).toContain("loading model");
    await act(async () => {
      acquire.resolve(initial);
      await handle.ensureReady();
    });
    expect(document.body.textContent).toContain("same result");
    const before = { ...renders };
    for (let patches = 1; patches <= 2; patches += 1) {
      await act(async () => {
        expect((await handle.actions.patchA())._tag).toBe("Success");
      });
      expect(handle.readReady().result).toBe(initial);
      expect(document.querySelector("[data-testid=model-a]")?.textContent).toBe(String(patches));
      expect({
        single: renders.single - before.single,
        many: renders.many - before.many,
        readA: renders.readA - before.readA,
        readB: renders.readB - before.readB,
      }).toEqual({
        single: root === "mixed" ? patches : 0,
        many: root === "mixed" ? patches : 0,
        readA: patches,
        readB: 0,
      });
    }
  });
}

class UsageBoundary extends Component<
  { readonly children: ReactNode; readonly onError: (error: unknown) => void },
  { readonly failed: boolean }
> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.failed ? <output>usage-error</output> : this.props.children;
  }
}

test("useNodes outside an observer throws on every development render", async () => {
  const BoardNode = boardNode("plain-many");
  const runtime = await started();
  await runtime.client.node(BoardNode, {}).ensureReady();
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  const caught: Array<unknown> = [];
  try {
    function PlainMany() {
      const { board } = useNodes({ board: [BoardNode, {}] });
      return createElement("i", undefined, board.result.a);
    }
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const view = render(
        <FrondProvider runtime={runtime}>
          <UsageBoundary onError={(error) => caught.push(error)}>
            <PlainMany />
          </UsageBoundary>
        </FrondProvider>
      );
      expect(view.getByText("usage-error")).toBeTruthy();
      expect(caught).toHaveLength(attempt + 1);
      view.unmount();
    }
    for (const error of caught) {
      expect(error).toBeInstanceOf(FrondReactUsageError);
      if (!(error instanceof FrondReactUsageError)) throw new Error("Expected usage error");
      expect(error.hook).toBe("useNodes");
    }
  } finally {
    consoleError.mockRestore();
  }
});

test("useNodes inside an observer renders without a usage error", async () => {
  const BoardNode = boardNode("many-observer");
  const runtime = await started();
  await runtime.client.node(BoardNode, {}).ensureReady();
  const ReadMany = observer(function ReadMany() {
    const { board } = useNodes({ board: [BoardNode, {}] });
    return createElement("output", undefined, board.result.a);
  });
  const view = render(
    <FrondProvider runtime={runtime}>
      <ReadMany />
    </FrondProvider>
  );
  expect(view.getByText("0")).toBeTruthy();
});

test("useNodes outside an observer renders in the production path", async () => {
  const BoardNode = boardNode("many-production");
  const runtime = await started(false);
  await runtime.client.node(BoardNode, {}).ensureReady();
  function PlainMany() {
    const { board } = useNodes({ board: [BoardNode, {}] });
    return createElement("output", undefined, board.result.a);
  }
  const view = render(
    <FrondProvider runtime={runtime}>
      <PlainMany />
    </FrondProvider>
  );
  expect(view.getByText("0")).toBeTruthy();
});

test("Preload outside an observer boots its node without a usage error", async () => {
  const BoardNode = boardNode("plain-preload");
  const runtime = await started();
  const handle = runtime.client.node(BoardNode, {});
  let view: ReturnType<typeof render> | undefined;
  await act(async () => {
    view = render(
      <FrondProvider runtime={runtime}>
        <Suspense fallback="pending">
          <Preload nodes={[{ board: [BoardNode, {}] }]}>
            <output>preloaded</output>
          </Preload>
        </Suspense>
      </FrondProvider>
    );
  });
  expect(view?.getByText("preloaded")).toBeTruthy();
  expect(handle.read()._tag).toBe("Ready");
});
