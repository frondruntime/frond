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
import { Effect } from "effect";
import { FrondProvider, useNodeControls, useNodesControls } from "../src";

afterEach(cleanup);

type PageArgs = { readonly page: number };
type PageSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: PageArgs;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

for (const hook of ["useNodeControls", "useNodesControls"] as const) {
  test(`${hook} retries earlier args after overlapping updates both fail`, async () => {
    const secondPage = Promise.withResolvers<void>();
    const thirdPage = Promise.withResolvers<void>();
    const calls: Array<number> = [];
    let failing = true;
    class PageNode extends NodeBase<PageSpec> {
      static readonly spec = resourceSpec.effect<PageSpec>({
        tag: `react/controls-overlap/${hook}`,
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((context) => Effect.succeed(`page-${context.args.page}`)),
        refresh: Driver.Refresh((context) =>
          Effect.gen(function* () {
            calls.push(context.args.page);
            const gate = context.args.page === 2 ? secondPage : thirdPage;
            yield* Effect.promise(() => gate.promise);
            if (failing) {
              return yield* Effect.fail({ _tag: "RefreshFailed", page: context.args.page });
            }
            yield* context.setResult(`page-${context.args.page}`);
          })
        ),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node(PageNode, { page: 1 });
    function Single({ page }: PageArgs) {
      useNodeControls(PageNode, { page });
      return <output>{`controls:${page}`}</output>;
    }
    function Composite({ page }: PageArgs) {
      useNodesControls({ only: [PageNode, { page }] });
      return <output>{`controls:${page}`}</output>;
    }
    const Controls = hook === "useNodeControls" ? Single : Composite;
    const tree = (page: number) => (
      <FrondProvider runtime={runtime}>
        <Controls page={page} />
      </FrondProvider>
    );
    try {
      await handle.ensureReady();
      const view = await act(async () => render(tree(1)));
      await act(async () => view.rerender(tree(2)));
      expect(calls).toEqual([2]);
      await act(async () => view.rerender(tree(3)));
      await act(async () => secondPage.resolve());
      expect(calls).toEqual([2, 3]);
      await act(async () => thirdPage.resolve());
      expect(handle.readReady().args).toEqual({ page: 1 });
      const failedEvents = (await runtime.query({ _tag: "RuntimeEvents" })).events.filter(
        (record) => record.event._tag === "GraphNodeArgsUpdateFailed"
      );
      expect(failedEvents).toHaveLength(2);

      failing = false;
      await act(async () => view.rerender(tree(2)));
      const current = handle.readReady();
      expect(calls).toEqual([2, 3, 2]);
      expect(current.args).toEqual({ page: 2 });
      expect(current.result).toBe("page-2");
    } finally {
      await act(async () => {
        secondPage.resolve();
        thirdPage.resolve();
      });
      cleanup();
      await runtime.submit({ _tag: "RuntimeStop" });
    }
  });
}
