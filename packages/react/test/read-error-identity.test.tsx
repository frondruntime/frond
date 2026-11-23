import "./setup";
import { afterEach, expect, spyOn, test } from "bun:test";
import {
  createRuntime,
  type Dep,
  Driver,
  dep,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "@frondruntime/core";
import { act, cleanup, render } from "@testing-library/react";
import { Effect } from "effect";
import { observer } from "mobx-react-lite";
import { Component, createElement, type ReactNode, Suspense } from "react";
import { FrondProvider, getErrorRecovery, getErrorReport, useNode } from "../src";

afterEach(cleanup);

type EmptyArgs = Record<string, never>;

type QuoteSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: EmptyArgs;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

const readers = 11;

class Boundary extends Component<
  {
    readonly children: ReactNode;
    readonly caught: Array<unknown>;
    readonly resets: Array<() => void>;
  },
  { readonly error: unknown }
> {
  override state = { error: undefined as unknown };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidMount() {
    this.props.resets.push(() => this.setState({ error: undefined }));
  }
  override componentDidCatch(error: unknown) {
    this.props.caught.push(error);
  }
  override render() {
    return this.state.error === undefined
      ? this.props.children
      : createElement("output", undefined, "failed");
  }
}

async function mountReaders(views: ReadonlyArray<() => ReactNode>) {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  await runtime.submit({ _tag: "RuntimeStart" });
  const caught: Array<unknown> = [];
  const resets: Array<() => void> = [];
  const view = await act(async () =>
    render(
      createElement(
        FrondProvider,
        { runtime },
        ...views.map((View, index) =>
          createElement(
            Boundary,
            { key: index, caught, resets },
            createElement(Suspense, { fallback: "loading" }, createElement(View))
          )
        )
      )
    )
  );
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
  const resetAll = async () => {
    caught.length = 0;
    await act(async () => {
      for (const reset of resets) reset();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  };
  return { view, caught, resetAll };
}

function quoteNode(tag: string, acquire: () => Effect.Effect<string, Error>) {
  class QuoteNode extends NodeBase<QuoteSpec> {
    static readonly spec = resourceSpec.effect<QuoteSpec>({
      tag,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(acquire),
    });
  }
  return QuoteNode;
}

test("every reader of a failing node throws the same read error", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const QuoteNode = quoteNode("read-error-identity/quote", () =>
      Effect.fail(new Error("offline"))
    );
    const View = observer(() => createElement("output", undefined, useNode(QuoteNode, {}).result));
    const { caught } = await mountReaders(Array.from({ length: readers }, () => View));

    expect(caught).toHaveLength(readers);
    expect(new Set(caught).size).toBe(1);
    const report = getErrorReport(caught[0]);
    expect(report.kind).toBe("readiness");
    expect(report.summary).toBe("offline");
    expect(report.failingNode?.tag).toBe("read-error-identity/quote");
  } finally {
    consoleError.mockRestore();
  }
});

test("retry from any reader's boundary recovers every reader, and a later failure is a new error", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    // The same error object every time: the read error still changes per
    // failure, because the runtime wraps each failure in a new cause.
    const offline = new Error("offline");
    let attempts = 0;
    const QuoteNode = quoteNode("read-error-identity/retry", () => {
      attempts += 1;
      return attempts < 3 ? Effect.fail(offline) : Effect.succeed("quote");
    });
    const View = observer(() => createElement("output", undefined, useNode(QuoteNode, {}).result));
    const { view, caught, resetAll } = await mountReaders(
      Array.from({ length: readers }, () => View)
    );
    const first = caught[0];
    expect(new Set(caught).size).toBe(1);

    // Every reader's subtree is now a fallback, so the store that built the
    // shared recovery is gone; a later reader's retry must still work.
    await act(async () => {
      await getErrorRecovery(caught[readers - 1])?.retry();
    });
    await resetAll();
    expect(attempts).toBe(2);
    expect(caught).toHaveLength(readers);
    expect(new Set(caught).size).toBe(1);
    expect(caught[0]).not.toBe(first);

    await act(async () => {
      await getErrorRecovery(caught[3])?.retry();
    });
    await resetAll();
    expect(attempts).toBe(3);
    expect(caught).toHaveLength(0);
    expect(view.container.textContent).toBe("quote".repeat(readers));
  } finally {
    consoleError.mockRestore();
  }
});

type ChartSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: EmptyArgs;
  readonly key: Key.Singleton;
  readonly deps: { readonly quote: Dep<ReturnType<typeof quoteNode>> };
  readonly result: string;
}>;

test("a node and the node that depends on it throw their own read errors", async () => {
  const consoleError = spyOn(console, "error").mockImplementation(() => {});
  try {
    const QuoteNode = quoteNode("read-error-identity/source", () =>
      Effect.fail(new Error("offline"))
    );
    class ChartNode extends NodeBase<ChartSpec> {
      static readonly spec = resourceSpec.effect<ChartSpec>({
        tag: "read-error-identity/chart",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ quote: dep(QuoteNode, {}) })),
        acquire: Driver.Acquire(() => Effect.succeed("chart")),
      });
    }
    const QuoteView = observer(() =>
      createElement("output", undefined, useNode(QuoteNode, {}).result)
    );
    const ChartView = observer(() =>
      createElement("output", undefined, useNode(ChartNode, {}).result)
    );
    const { caught } = await mountReaders([QuoteView, ChartView, QuoteView, ChartView]);

    expect(caught).toHaveLength(4);
    expect(new Set(caught).size).toBe(2);
    const byRequester = new Map(
      caught.map((error) => [getErrorReport(error).requester?.tag, error])
    );
    expect([...byRequester.keys()].sort()).toEqual([
      "read-error-identity/chart",
      "read-error-identity/source",
    ]);
    const chartError = byRequester.get("read-error-identity/chart");
    expect(getErrorReport(chartError).failingNode?.tag).toBe("read-error-identity/source");
    expect(getErrorRecovery(chartError)?.nodeId).toBe(getErrorReport(chartError).requester?.id);
  } finally {
    consoleError.mockRestore();
  }
});
