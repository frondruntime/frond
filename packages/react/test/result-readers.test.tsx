import { afterEach, describe, expect, spyOn, test } from "bun:test";
import "global-jsdom/register";
import {
  type ActionContract,
  createRuntime,
  type Dep,
  Driver,
  dep,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  type NodeSpecArgs,
  type NodeSpecLike,
  resourceSpec,
  tag,
} from "@frondruntime/core";
import {
  type CheckedReactNodeInputMap,
  FrondProvider,
  type ReadyReactNode,
  useNode,
  useNodeState,
  useNodes,
} from "@frondruntime/react";
import { act, cleanup, render } from "@testing-library/react";
import { Component, createElement, type ReactNode, Suspense } from "react";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});

type CounterSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: {
    readonly hold: ActionContract;
    readonly increment: ActionContract;
    readonly fail: ActionContract;
  };
}>;

function counterFixture() {
  const started = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let failAcquire = false;
  class CounterNode extends NodeBase<CounterSpec> {
    static readonly spec = resourceSpec.async<CounterSpec>({
      tag: tag("react/result-readers/counter"),
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => {
        if (failAcquire) {
          throw new Error("acquire failed");
        }
        return 0;
      }),
      actions: {
        hold: Driver.Action(async () => {
          started.resolve();
          await gate.promise;
        }),
        increment: Driver.Action((ctx) => ctx.setResult((current) => current + 1)),
        fail: Driver.Action(() => {
          throw new Error("action failed");
        }),
      },
    });
  }
  return {
    CounterNode,
    started,
    gate,
    failAcquire: () => {
      failAcquire = true;
    },
  };
}

async function startRuntime() {
  const runtime = createRuntime();
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  return runtime;
}

class ReadErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly error: unknown }
> {
  override readonly state = { error: undefined };
  static getDerivedStateFromError(error: unknown) {
    return { error };
  }
  override render() {
    return this.state.error === undefined
      ? this.props.children
      : createElement("output", undefined, "read-error");
  }
}

function useComposite<TSpec extends NodeSpecLike>(
  spec: TSpec,
  args: NodeSpecArgs<TSpec>
): ReadyReactNode<TSpec> {
  const map = { node: [spec, args] } as const;
  // TypeScript cannot reduce the conditional map check for a generic spec;
  // the signature already pairs this spec with its own args.
  return useNodes<typeof map>(map as typeof map & CheckedReactNodeInputMap<typeof map>).node;
}

for (const mode of ["useNode", "useNodes"] as const) {
  const useReader = mode === "useNode" ? useNode : useComposite;
  describe(`${mode} result subscriptions`, () => {
    test("skips operation start and unchanged settle while status readers stay current", async () => {
      const { CounterNode, started, gate } = counterFixture();
      const runtime = await startRuntime();
      const handle = runtime.client.node(CounterNode, {});
      const node = await handle.ensureReadyNode();
      let resultRenders = 0;
      let statusRenders = 0;
      let busy = false;
      function ResultReader() {
        const current = useReader(CounterNode, {});
        resultRenders += 1;
        return createElement("output", undefined, String(current.result));
      }
      function StatusReader() {
        busy = useNodeState(CounterNode, {}).busy;
        statusRenders += 1;
        return null;
      }
      render(
        <FrondProvider runtime={runtime}>
          <ResultReader />
          <StatusReader />
        </FrondProvider>
      );
      const before = resultRenders;
      const statusBefore = statusRenders;
      const previousDeps = node.deps;
      let operation: Promise<void> | undefined;
      await act(async () => {
        operation = node.actions.hold();
        await started.promise;
      });
      expect(busy).toBe(true);
      expect(statusRenders).toBeGreaterThan(statusBefore);
      expect(resultRenders).toBe(before);
      await act(async () => {
        gate.resolve();
        await operation;
      });
      expect(busy).toBe(false);
      expect(node.result).toBe(0);
      expect(node.deps).toBe(previousDeps);
      expect(resultRenders).toBe(before);
    });

    test("renders committed results and ignores caller-visible operation failures", async () => {
      const { CounterNode } = counterFixture();
      const runtime = await startRuntime();
      const node = await runtime.client.node(CounterNode, {}).ensureReadyNode();
      let renders = 0;
      function Reader() {
        const current = useReader(CounterNode, {});
        renders += 1;
        return createElement("output", undefined, String(current.result));
      }
      const view = render(
        <FrondProvider runtime={runtime}>
          <Reader />
        </FrondProvider>
      );
      const before = renders;
      await act(async () => {
        await node.actions.increment();
      });
      expect(view.getByText("1")).toBeTruthy();
      expect(renders).toBeGreaterThan(before);
      const afterResult = renders;
      await act(async () => {
        await expect(node.actions.fail()).rejects.toBeDefined();
      });
      expect(renders).toBe(afterResult);
    });

    test("renders changed dependency accessors without changing the parent result", async () => {
      let childResult = 0;
      type ChildSpec = NodeSpec<{
        readonly mode: "async";
        readonly args: Record<string, never>;
        readonly key: Key.Singleton;
        readonly deps: Record<string, never>;
        readonly result: number;
      }>;
      class ChildNode extends NodeBase<ChildSpec> {
        static readonly spec = resourceSpec.async<ChildSpec>({
          tag: tag("react/result-readers/child"),
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          acquire: Driver.Acquire(() => childResult),
          refresh: Driver.Refresh((ctx) => {
            childResult += 1;
            ctx.setResult(childResult);
          }),
        });
      }
      type ParentSpec = NodeSpec<{
        readonly mode: "async";
        readonly args: Record<string, never>;
        readonly key: Key.Singleton;
        readonly deps: { readonly child: Dep<typeof ChildNode> };
        readonly result: string;
      }>;
      class ParentNode extends NodeBase<ParentSpec> {
        static readonly spec = resourceSpec.async<ParentSpec>({
          tag: tag("react/result-readers/parent"),
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({ child: dep(ChildNode, {}) })),
          acquire: Driver.Acquire(() => "parent"),
          refresh: Driver.Refresh(() => {}),
        });
      }
      const runtime = await startRuntime();
      const handle = runtime.client.node(ParentNode, {});
      const parent = await handle.ensureReadyNode();
      const previousDeps = parent.deps;
      let renders = 0;
      function Reader() {
        const current = useReader(ParentNode, {});
        renders += 1;
        return createElement("output", undefined, String(current.deps.child.result));
      }
      const view = render(
        <FrondProvider runtime={runtime}>
          <Reader />
        </FrondProvider>
      );
      const before = renders;
      const childHandle = runtime.client.node(ChildNode, {});
      await act(async () => {
        await handle.refresh();
      });
      expect(parent.deps).toBe(previousDeps);
      expect(renders).toBe(before);
      await act(async () => {
        await childHandle.refresh();
        await handle.refresh();
      });
      // A child result mutation keeps the dependency entry reference-equal.
      expect(parent.deps).toBe(previousDeps);
      expect(parent.deps.child.result).toBe(1);
      expect(renders).toBe(before);
      await act(async () => {
        // Releasing just the child preserves the parent incarnation, then
        // reacquiring replaces the actual dependency entry on parent refresh.
        await childHandle.releaseResources();
        const replacement = await childHandle.ensureReadyNode();
        expect(replacement).not.toBe(previousDeps.child);
        await handle.refresh();
      });
      expect(parent.result).toBe("parent");
      expect(parent.deps).not.toBe(previousDeps);
      expect(view.getByText("1")).toBeTruthy();
      expect(renders).toBeGreaterThan(before);
    });

    test("re-enters Suspense after eviction and delivers a readiness error", async () => {
      const consoleError = spyOn(console, "error").mockImplementation(() => {});
      try {
        const fixture = counterFixture();
        const { CounterNode } = fixture;
        const runtime = await startRuntime();
        const handle = runtime.client.node(CounterNode, {});
        await handle.ensureReadyNode();
        let renders = 0;
        function Reader() {
          renders += 1;
          const node = useReader(CounterNode, {});
          return createElement("output", undefined, String(node.result));
        }
        const view = render(
          <FrondProvider runtime={runtime}>
            <ReadErrorBoundary>
              <Suspense fallback="pending">
                <Reader />
              </Suspense>
            </ReadErrorBoundary>
          </FrondProvider>
        );
        expect(view.getByText("0")).toBeTruthy();
        const before = renders;
        fixture.failAcquire();
        await act(async () => {
          await handle.evict();
        });
        expect(await view.findByText("read-error")).toBeTruthy();
        expect(renders).toBeGreaterThan(before);
      } finally {
        consoleError.mockRestore();
      }
    });
  });
}
