import "./setup";
import { afterEach, expect, test } from "bun:test";
import {
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "@frondruntime/core";
import { act, cleanup, render } from "@testing-library/react";
import { observer } from "mobx-react-lite";
import { Activity, Component, type ReactNode, Suspense } from "react";
import { FrondProvider, useNodes } from "../src";
import { prepareReactNodeMap } from "../src/nodeInputMap";
import { makeReactNodesStore } from "../src/useNodes";

afterEach(cleanup);

type ReplacementSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

function makeReplacementNode(tag: string) {
  let acquisitions = 0;
  class ReplacementNode extends NodeBase<ReplacementSpec> {
    static readonly spec = resourceSpec.async<ReplacementSpec>({
      tag,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => `incarnation-${++acquisitions}`),
    });
  }
  return ReplacementNode;
}

for (const detach of ["unsubscribe", "dispose"] as const) {
  test(`useNodes re-reads a replaced node after ${detach} and a detached read`, async () => {
    const ReplacementNode = makeReplacementNode(`react/detached-cache/${detach}`);
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node(ReplacementNode, {});
    await handle.ensureReady();
    const entries = prepareReactNodeMap({
      hook: "useNodes",
      runtime,
      map: { only: [ReplacementNode, {}] },
    }).entries;
    const store = makeReactNodesStore(runtime, entries);
    let unsubscribe = () => {};
    try {
      unsubscribe = store.subscribe(() => {});
      expect(store.read()._tag).toBe("Ready");
      if (detach === "unsubscribe") unsubscribe();
      else store.dispose();

      // Hidden renders can repopulate the cache while effects stay detached.
      expect(store.read()._tag).toBe("Ready");
      await handle.evict();
      await handle.ensureReady();
      const current = handle.readReady();
      const read = store.read();
      expect(read._tag).toBe("Ready");
      if (read._tag !== "Ready") throw new Error(`Unexpected read: ${read._tag}`);
      expect(read.value["only"]).toBe(current);
      expect((read.value["only"] as { readonly result: string }).result).toBe("incarnation-2");
    } finally {
      unsubscribe();
      store.dispose();
      await runtime.submit({ _tag: "RuntimeStop" });
    }
  });
}

test("useNodes reads the current node during hidden Activity renders after external replacement", async () => {
  const ReplacementNode = makeReplacementNode("react/detached-cache/activity");
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  await runtime.submit({ _tag: "RuntimeStart" });
  const handle = runtime.client.node(ReplacementNode, {});
  const caught: Array<unknown> = [];
  const reads: Array<{ readonly revision: number; readonly node: object }> = [];
  const Reader = observer(function Reader({ revision }: { readonly revision: number }) {
    const { only } = useNodes({ only: [ReplacementNode, {}] });
    reads.push({ revision, node: only });
    return <output>{`${only.result}:${revision}`}</output>;
  });
  const tree = (mode: "hidden" | "visible", revision: number) => (
    <FrondProvider runtime={runtime}>
      <Boundary onError={(error) => caught.push(error)}>
        <Suspense fallback="loading">
          <Activity mode={mode}>
            <Reader revision={revision} />
          </Activity>
        </Suspense>
      </Boundary>
    </FrondProvider>
  );
  try {
    await handle.ensureReady();
    const view = await act(async () => render(tree("visible", 0), { onCaughtError: () => {} }));
    expect(view.container.textContent).toBe("incarnation-1:0");
    await act(async () => view.rerender(tree("hidden", 0)));
    await act(async () => view.rerender(tree("hidden", 1)));
    expect(reads.some((read) => read.revision === 1)).toBe(true);
    await act(async () => {
      await handle.evict();
      await handle.ensureReady();
    });
    const current = handle.readReady();
    await act(async () => view.rerender(tree("hidden", 2)));
    expect(caught).toEqual([]);
    expect(reads.filter((read) => read.revision === 2).at(-1)?.node).toBe(current);
    await act(async () => view.rerender(tree("visible", 3)));
    expect(view.container.textContent).toBe("incarnation-2:3");
    expect(caught).toEqual([]);
  } finally {
    cleanup();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});

class Boundary extends Component<
  { readonly children: ReactNode; readonly onError: (error: unknown) => void },
  { readonly error: unknown }
> {
  readonly state: { readonly error: unknown } = { error: undefined };

  static getDerivedStateFromError(error: unknown) {
    return { error };
  }

  componentDidCatch(error: unknown): void {
    this.props.onError(error);
  }

  render(): ReactNode {
    return this.state.error === undefined ? this.props.children : <output>boundary</output>;
  }
}
