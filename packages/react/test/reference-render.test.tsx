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
import { FrondProvider, FrondReactUsageError, useNode } from "@frondruntime/react";
import { act, cleanup, render } from "@testing-library/react";
import { observer } from "mobx-react-lite";
import { Component, createElement, type ReactNode } from "react";

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) await runtime.submit({ _tag: "RuntimeStop" });
});

type Row = { readonly id: string; readonly count: number };
type List = { readonly rows: ReadonlyArray<Row> };

type ListSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: List;
  readonly actions: { readonly bumpFirst: ActionContract };
}>;

class ListNode extends NodeBase<ListSpec> {
  static readonly spec = resourceSpec.async<ListSpec>({
    tag: tag("test/react/reference-render-list"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => ({
      rows: Array.from({ length: 10 }, (_, index) => ({ id: `r${index}`, count: 0 })),
    })),
    actions: {
      bumpFirst: Driver.Action((context) => {
        context.patchResult((current) => {
          const first = current.rows[0];
          if (first !== undefined) current.rows[0] = { ...first, count: first.count + 1 };
        });
      }),
    },
  });
}

async function startRuntime(development = true) {
  const runtime = createRuntime({ eventBufferSize: 512, development });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const handle = runtime.client.node(ListNode, {});
  await handle.ensureReady();
  return { runtime, handle };
}

test("ten writes to one row rerender that row ten times and no other row", async () => {
  const { runtime, handle } = await startRuntime();
  const rowRenders = new Map<string, number>();
  let listRenders = 0;

  const RowView = observer(function RowView(props: { readonly row: Row }) {
    rowRenders.set(props.row.id, (rowRenders.get(props.row.id) ?? 0) + 1);
    return createElement("li", undefined, `${props.row.id}:${props.row.count}`);
  });
  const ListView = observer(function ListView() {
    const node = useNode(ListNode, {});
    listRenders += 1;
    return createElement(
      "ul",
      undefined,
      node.result.rows.map((row) => createElement(RowView, { key: row.id, row }))
    );
  });

  const view = render(createElement(FrondProvider, { runtime }, createElement(ListView)));
  await act(async () => {});
  expect(view.container.textContent).toContain("r0:0");
  const listBefore = listRenders;
  const rowsBefore = new Map(rowRenders);

  for (let write = 0; write < 10; write += 1) {
    await act(async () => {
      await handle.actions.bumpFirst();
    });
  }

  expect(view.container.textContent).toContain("r0:10");
  expect(listRenders - listBefore).toBe(10);
  expect((rowRenders.get("r0") ?? 0) - (rowsBefore.get("r0") ?? 0)).toBe(10);
  for (let index = 1; index < 10; index += 1) {
    expect(rowRenders.get(`r${index}`)).toBe(rowsBefore.get(`r${index}`));
  }
});

class Boundary extends Component<
  { readonly children: ReactNode; readonly onError: (error: unknown) => void },
  { readonly error: unknown }
> {
  override state: { readonly error: unknown } = { error: undefined };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }
  override render() {
    return this.state.error === undefined ? this.props.children : null;
  }
}

test("useNode outside an observer throws in development on every render", async () => {
  const { runtime } = await startRuntime();
  const caught: Array<unknown> = [];
  const originalError = console.error;
  console.error = () => {};
  try {
    function Plain() {
      useNode(ListNode, {});
      return null;
    }
    for (let mount = 0; mount < 2; mount += 1) {
      render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(
            Boundary,
            { onError: (error: unknown) => caught.push(error) },
            createElement(Plain)
          )
        )
      );
      await act(async () => {});
      cleanup();
    }
  } finally {
    console.error = originalError;
  }
  expect(caught).toHaveLength(2);
  for (const error of caught) expect(error).toBeInstanceOf(FrondReactUsageError);
});

test("useNode outside an observer does not throw when development checks are off", async () => {
  const { runtime } = await startRuntime(false);
  function Plain() {
    const node = useNode(ListNode, {});
    return createElement("p", undefined, String(node.result.rows.length));
  }
  const view = render(createElement(FrondProvider, { runtime }, createElement(Plain)));
  await act(async () => {});
  expect(view.container.textContent).toBe("10");
});
