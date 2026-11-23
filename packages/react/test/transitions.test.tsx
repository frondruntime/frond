import "./setup";
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "@frondruntime/core";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { observer } from "mobx-react-lite";
import {
  Component,
  type ReactNode,
  Suspense,
  use,
  useLayoutEffect,
  useState,
  useTransition,
} from "react";
import { FrondProvider, getErrorReport, useNode, useNodeState, useNodes } from "../src";

type Identity = "a" | "b" | "c" | "sibling";
type TransitionArgs = { readonly identity: Identity };
type TransitionSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: TransitionArgs;
  readonly key: Key.Structure<TransitionArgs>;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;
type ReaderKind = "useNode" | "useNodeState" | "useNodes";

test("React can render a transition fallback speculatively without committing it", async () => {
  const gate = Promise.withResolvers<string>();
  const counts = { renders: 0, commits: 0 };
  function Fallback() {
    counts.renders += 1;
    useLayoutEffect(() => {
      counts.commits += 1;
    }, []);
    return <span>plain loading</span>;
  }
  function Reader({ pending }: { readonly pending: boolean }) {
    const value = pending ? use(gate.promise) : "plain a";
    return <span>{value}</span>;
  }
  function App() {
    const [pending, setPending] = useState(false);
    const [isPending, startTransition] = useTransition();
    return (
      <>
        <button type="button" onClick={() => startTransition(() => setPending(true))}>
          plain change
        </button>
        <span>{String(isPending)}</span>
        <Suspense fallback={<Fallback />}>
          <Reader pending={pending} />
        </Suspense>
      </>
    );
  }
  const view = await act(async () => render(<App />));
  await act(async () => {
    fireEvent.click(view.getByText("plain change"));
  });
  expect(view.getByText("plain a")).toBeTruthy();
  expect(view.getByText("true")).toBeTruthy();
  expect(view.queryByText("plain loading")).toBeNull();
  expect(counts).toEqual({ renders: 1, commits: 0 });
  await act(async () => {
    gate.resolve("plain b");
  });
  expect(view.getByText("plain b")).toBeTruthy();
  expect(view.getByText("false")).toBeTruthy();
  expect(view.queryByText("plain loading")).toBeNull();
  expect(counts).toEqual({ renders: 1, commits: 0 });
});

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});

class TestErrorBoundary extends Component<
  { readonly children: ReactNode; readonly onError: (error: unknown) => void },
  { readonly error: unknown }
> {
  override readonly state = { error: undefined };

  static getDerivedStateFromError(error: unknown): { readonly error: unknown } {
    return { error };
  }

  override componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  override render(): ReactNode {
    return this.state.error === undefined ? (
      this.props.children
    ) : (
      <output data-testid="error">{getErrorReport(this.state.error).causeMessage}</output>
    );
  }
}

async function mountReader(kind: ReaderKind) {
  const gates = {
    a: Promise.withResolvers<string>(),
    b: Promise.withResolvers<string>(),
    c: Promise.withResolvers<string>(),
    sibling: Promise.withResolvers<string>(),
  };
  const acquires = { a: 0, b: 0, c: 0, sibling: 0 };
  const counts = { fallbackRenders: 0, fallbackCommits: 0 };
  const commits: Array<string> = [];
  const errors: Array<unknown> = [];

  class TransitionNode extends NodeBase<TransitionSpec> {
    static readonly spec = resourceSpec.async<TransitionSpec>({
      tag: tag(`react/transitions/${kind}`),
      key: (args) => Key.structure(args),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((context) => {
        acquires[context.args.identity] += 1;
        return gates[context.args.identity].promise;
      }),
    });
  }

  function Content({ value }: { readonly value: string }) {
    // Record commits, not render attempts: React may retry or abandon a render.
    useLayoutEffect(() => {
      commits.push(value);
    }, [value]);
    return <output data-testid="content">{value}</output>;
  }

  const NodeReader = observer(function NodeReader({ identity }: TransitionArgs) {
    const node = useNode(TransitionNode, { identity });
    return <Content value={node.result} />;
  });
  const StateReader = observer(function StateReader({ identity }: TransitionArgs) {
    const state = useNodeState(TransitionNode, { identity });
    return <Content value={state.node.result} />;
  });
  const NodesReader = observer(function NodesReader({ identity }: TransitionArgs) {
    const nodes = useNodes({
      selected: [TransitionNode, { identity }],
      sibling: [TransitionNode, { identity: "sibling" }],
    });
    return <Content value={`${nodes.selected.result}/${nodes.sibling.result}`} />;
  });
  const Reader = { useNode: NodeReader, useNodeState: StateReader, useNodes: NodesReader }[kind];

  function Fallback() {
    counts.fallbackRenders += 1;
    useLayoutEffect(() => {
      counts.fallbackCommits += 1;
    }, []);
    return <span>loading</span>;
  }

  function App() {
    const [identity, setIdentity] = useState<Identity>("a");
    const [isPending, startTransition] = useTransition();
    return (
      <>
        <output data-testid="pending">{String(isPending)}</output>
        {(["a", "b", "c"] as const).map((next) => (
          <button key={next} type="button" onClick={() => startTransition(() => setIdentity(next))}>
            transition {next}
          </button>
        ))}
        <button type="button" onClick={() => setIdentity("b")}>
          urgent b
        </button>
        <TestErrorBoundary onError={(error) => errors.push(error)}>
          <Suspense fallback={<Fallback />}>
            <Reader identity={identity} />
          </Suspense>
        </TestErrorBoundary>
      </>
    );
  }

  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  // Start with an already revealed boundary; initial boot is covered elsewhere.
  gates.a.resolve("a");
  await runtime.client.node(TransitionNode, { identity: "a" }).ensureReady();
  if (kind === "useNodes") {
    gates.sibling.resolve("sibling");
    await runtime.client.node(TransitionNode, { identity: "sibling" }).ensureReady();
  }
  const view = await act(async () =>
    render(
      <FrondProvider runtime={runtime}>
        <App />
      </FrondProvider>
    )
  );

  function expectScreen(content: string, pending: boolean, fallbackRenders: number) {
    expect(view.getByTestId("content").textContent).toBe(content);
    expect(view.getByTestId("pending").textContent).toBe(String(pending));
    expect(view.queryByText("loading")).toBeNull();
    // React's async act also renders speculative fallbacks during transitions,
    // as the plain React control proves. Only a commit could flash the fallback.
    expect(counts).toEqual({ fallbackRenders, fallbackCommits: 0 });
  }

  expectScreen(kind === "useNodes" ? "a/sibling" : "a", false, 0);
  expect(acquires.a).toBe(1);

  return {
    view,
    gates,
    acquires,
    counts,
    commits,
    errors,
    expectScreen,
    transitionTo: async (identity: Identity) => {
      await act(async () => {
        fireEvent.click(view.getByText(`transition ${identity}`));
      });
    },
    resolve: async (identity: Identity) => {
      await act(async () => {
        gates[identity].resolve(identity);
        await runtime.client.node(TransitionNode, { identity }).ensureReady();
      });
    },
    reject: async (identity: Identity, error: Error) => {
      await act(async () => {
        gates[identity].reject(error);
        await runtime.client.node(TransitionNode, { identity }).ensureReady();
      });
    },
  };
}

test("useNode keeps previous content and isPending until transition args are ready", async () => {
  const scenario = await mountReader("useNode");

  await scenario.transitionTo("b");
  expect(scenario.acquires.b).toBe(1);
  scenario.expectScreen("a", true, 1);
  expect(scenario.commits).toEqual(["a"]);

  await scenario.resolve("b");
  scenario.expectScreen("b", false, 1);
  expect(scenario.commits).toEqual(["a", "b"]);
});

test("useNode shows the fallback exactly once for an urgent args change", async () => {
  const scenario = await mountReader("useNode");

  await act(async () => {
    fireEvent.click(scenario.view.getByText("urgent b"));
  });
  expect(scenario.acquires.b).toBe(1);
  expect(scenario.view.getByText("loading")).toBeTruthy();
  expect(scenario.view.getByTestId("content").style.display).toBe("none");
  expect(scenario.view.getByTestId("pending").textContent).toBe("false");
  expect(scenario.counts).toEqual({ fallbackRenders: 1, fallbackCommits: 1 });
  expect(scenario.commits).toEqual(["a"]);

  await scenario.resolve("b");
  expect(scenario.view.getByTestId("content").textContent).toBe("b");
  expect(scenario.view.queryByText("loading")).toBeNull();
  expect(scenario.counts).toEqual({ fallbackRenders: 1, fallbackCommits: 1 });
  expect(scenario.commits).toEqual(["a", "b"]);
});

for (const order of ["c-first", "b-first"] as const) {
  test(`superseded transition never commits b when resolving ${order}`, async () => {
    const scenario = await mountReader("useNode");

    await scenario.transitionTo("b");
    expect(scenario.acquires.b).toBe(1);
    scenario.expectScreen("a", true, 1);
    await scenario.transitionTo("c");
    expect(scenario.acquires.c).toBe(1);
    scenario.expectScreen("a", true, 2);
    expect(scenario.commits).toEqual(["a"]);

    if (order === "c-first") {
      await scenario.resolve("c");
      scenario.expectScreen("c", false, 2);
      expect(scenario.commits).toEqual(["a", "c"]);
      await scenario.resolve("b");
    } else {
      await scenario.resolve("b");
      // Settling b pings React, which retries still-pending c's fallback speculatively.
      scenario.expectScreen("a", true, 3);
      expect(scenario.commits).toEqual(["a"]);
      await scenario.resolve("c");
    }

    scenario.expectScreen("c", false, order === "c-first" ? 2 : 3);
    expect(scenario.commits).toEqual(["a", "c"]);
    expect(scenario.acquires).toEqual({ a: 1, b: 1, c: 1, sibling: 0 });
  });
}

test("useNodes keeps both previous children while one child's args transition", async () => {
  const scenario = await mountReader("useNodes");

  await scenario.transitionTo("b");
  expect(scenario.acquires.b).toBe(1);
  scenario.expectScreen("a/sibling", true, 1);
  expect(scenario.commits).toEqual(["a/sibling"]);

  await scenario.resolve("b");
  scenario.expectScreen("b/sibling", false, 1);
  expect(scenario.commits).toEqual(["a/sibling", "b/sibling"]);
  expect(scenario.acquires).toEqual({ a: 1, b: 1, c: 0, sibling: 1 });
});

test("useNodeState keeps previous content while its args transition", async () => {
  const scenario = await mountReader("useNodeState");

  await scenario.transitionTo("b");
  expect(scenario.acquires.b).toBe(1);
  scenario.expectScreen("a", true, 1);

  await scenario.resolve("b");
  scenario.expectScreen("b", false, 1);
  expect(scenario.commits).toEqual(["a", "b"]);
});

test("a rejected transition acquire reaches the error boundary and clears isPending", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const scenario = await mountReader("useNode");

    await scenario.transitionTo("b");
    expect(scenario.acquires.b).toBe(1);
    scenario.expectScreen("a", true, 1);

    await scenario.reject("b", new Error("transition acquire failed"));
    expect(scenario.view.getByTestId("error").textContent).toBe("transition acquire failed");
    expect(scenario.errors).toHaveLength(1);
    expect(getErrorReport(scenario.errors[0]).kind).toBe("readiness");
    expect(scenario.view.getByTestId("pending").textContent).toBe("false");
    expect(scenario.view.queryByTestId("content")).toBeNull();
    expect(scenario.view.queryByText("loading")).toBeNull();
    expect(scenario.counts).toEqual({ fallbackRenders: 1, fallbackCommits: 0 });
    expect(scenario.commits).toEqual(["a"]);
    expect(scenario.acquires.b).toBe(1);
  } finally {
    consoleError.mockRestore();
  }
});

test("transitioning back to ready args shows a without a fallback or another acquire", async () => {
  const scenario = await mountReader("useNode");
  await scenario.transitionTo("b");
  scenario.expectScreen("a", true, 1);
  await scenario.resolve("b");
  scenario.expectScreen("b", false, 1);

  await scenario.transitionTo("a");

  // Render attempts depend on React retries; assert committed UI and fallback count instead.
  scenario.expectScreen("a", false, 1);
  expect(scenario.commits).toEqual(["a", "b", "a"]);
  expect(scenario.acquires).toEqual({ a: 1, b: 1, c: 0, sibling: 0 });
});
