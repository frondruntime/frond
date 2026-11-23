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
import { observer } from "mobx-react-lite";
import { Component, type ReactNode, Suspense } from "react";
import { FrondProvider, getErrorReport, useNodes } from "../src";

afterEach(cleanup);

type ChildArgs = { readonly name: "first" | "second" };
type ChildSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: ChildArgs;
  readonly key: Key.Structure<ChildArgs>;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

for (const outcome of ["failure", "success"] as const) {
  test(`useNodes re-reads a cold child's ${outcome} while its sibling is pending`, async () => {
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const calls: Array<string> = [];
    class ChildNode extends NodeBase<ChildSpec> {
      static readonly spec = resourceSpec.effect<ChildSpec>({
        tag: `react/cold-settlement/${outcome}`,
        key: (args) => Key.structure(args),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((context) =>
          Effect.gen(function* () {
            calls.push(context.args.name);
            const gate = context.args.name === "first" ? first : second;
            yield* Effect.promise(() => gate.promise);
            if (context.args.name === "first" && outcome === "failure") {
              return yield* Effect.fail({ _tag: "FirstChildFailed" });
            }
            return context.args.name;
          })
        ),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    const firstHandle = runtime.client.node(ChildNode, { name: "first" });
    const secondHandle = runtime.client.node(ChildNode, { name: "second" });
    const caught: Array<unknown> = [];
    const Reader = observer(function Reader({ revision }: { readonly revision: number }) {
      const nodes = useNodes({
        first: [ChildNode, { name: "first" }],
        second: [ChildNode, { name: "second" }],
      });
      return <output>{`${nodes.first.result},${nodes.second.result}:${revision}`}</output>;
    });
    const tree = (revision: number) => (
      <FrondProvider runtime={runtime}>
        <Boundary onError={(error) => caught.push(error)}>
          <Suspense fallback="loading">
            <Reader revision={revision} />
          </Suspense>
        </Boundary>
      </FrondProvider>
    );
    try {
      const view = await act(async () => render(tree(0), { onCaughtError: () => {} }));
      expect(calls.toSorted()).toEqual(["first", "second"]);
      expect(view.container.textContent).toBe("loading");
      await act(async () => first.resolve());
      expect(secondHandle.read()._tag).toBe("Pending");
      if (outcome === "failure") {
        expect(firstHandle.read()._tag).toBe("Error");
        expect(caught).toHaveLength(1);
        expect(getErrorReport(caught[0]).causeType).toBe("FirstChildFailed");
        expect(getErrorReport(caught[0]).failingNode?.id).toBe(firstHandle.nodeId);
        expect(view.container.textContent).toBe("boundary");
      } else {
        expect(firstHandle.read()._tag).toBe("Ready");
        expect(caught).toEqual([]);
        expect(view.container.textContent).toBe("loading");
        // Replays must suspend on the remaining child, never on the settled set.
        await act(async () => view.rerender(tree(1)));
        expect(caught).toEqual([]);
        expect(view.container.textContent).toBe("loading");
        await act(async () => second.resolve());
        expect(view.container.textContent).toBe("first,second:1");
        expect(caught).toEqual([]);
        expect(calls.toSorted()).toEqual(["first", "second"]);
      }
    } finally {
      await act(async () => {
        first.resolve();
        second.resolve();
      });
      cleanup();
      await runtime.submit({ _tag: "RuntimeStop" });
    }
  });
}

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
