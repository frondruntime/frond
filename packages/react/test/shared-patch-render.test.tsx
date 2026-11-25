import { afterEach, describe, expect, test } from "bun:test";
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
  resultCommit,
  tag,
} from "@frondruntime/core";
import { FrondProvider, useNode, useNodes } from "@frondruntime/react";
import { act, cleanup, render } from "@testing-library/react";
import { observer } from "mobx-react-lite";
import { createElement } from "react";

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) await runtime.submit({ _tag: "RuntimeStop" });
});

// A non-plain result (class instance) patched with
// `resultPatch: { nonPlainClone: "share" }` keeps its reference on commit.
class Counter {
  count = 0;
}

type CounterSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Counter;
  readonly actions: {
    readonly increment: ActionContract;
    readonly patchThenSet: ActionContract;
    readonly patchThenCommit: ActionContract;
    readonly patchThenSwapBack: ActionContract;
    readonly noop: ActionContract;
  };
}>;

class CounterNode extends NodeBase<CounterSpec> {
  static readonly spec = resourceSpec.async<CounterSpec>({
    tag: tag("test/react/shared-counter"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    resultPatch: { nonPlainClone: "share" },
    acquire: Driver.Acquire(() => new Counter()),
    actions: {
      increment: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.count += 1;
        });
      }),
      // The patched reference is kept through a same-reference setResult.
      patchThenSet: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.count += 1;
        });
        ctx.setResult((current) => current);
      }),
      // ... and through a result commit of the same reference.
      patchThenCommit: Driver.Action((ctx) => {
        ctx.patchResult((current) => {
          current.count += 1;
        });
        ctx.setResult((current) => resultCommit(current));
      }),
      // ... and when it is set again after another value was staged.
      patchThenSwapBack: Driver.Action((ctx) => {
        const original = ctx.node.result;
        ctx.patchResult((current) => {
          current.count += 1;
        });
        ctx.setResult(new Counter());
        ctx.setResult(original);
      }),
      noop: Driver.Action(() => undefined),
    },
    // The patched reference is kept through a returned result.
    refresh: Driver.Refresh((ctx) => {
      ctx.patchResult((current) => {
        current.count += 1;
      });
      return ctx.node.result;
    }),
  });
}

function useSingle() {
  return useNode(CounterNode, {});
}

function useComposite() {
  return useNodes({ counter: [CounterNode, {}] } as const).counter;
}

for (const mode of ["useNode", "useNodes"] as const) {
  const useReader = mode === "useNode" ? useSingle : useComposite;
  describe(`${mode} and a shared-reference patch`, () => {
    test("a committed in-place patch re-renders; a no-write settle does not", async () => {
      const runtime = createRuntime({ development: true, eventBufferSize: 512 });
      runtimes.push(runtime);
      await runtime.submit({ _tag: "RuntimeStart" });
      const handle = runtime.client.node(CounterNode, {});
      await handle.ensureReady();
      let renders = 0;
      const Reader = observer(function Reader() {
        const node = useReader();
        renders += 1;
        return createElement("output", undefined, `count=${node.result.count}`);
      });
      const view = render(
        <FrondProvider runtime={runtime}>
          <Reader />
        </FrondProvider>
      );
      expect(view.container.textContent).toBe("count=0");
      await act(async () => {
        const result = await handle.actions.increment();
        expect(result._tag).toBe("Success");
      });
      expect(handle.readReady().result.count).toBe(1);
      expect(view.container.textContent).toBe("count=1");
      const afterPatch = renders;
      await act(async () => {
        const result = await handle.actions.noop();
        expect(result._tag).toBe("Success");
      });
      expect(renders).toBe(afterPatch);
    });

    const keptThrough = {
      setResult: "a same-reference setResult",
      resultCommit: "a same-reference result commit",
      swapBack: "a setResult back to the patched reference",
      refresh: "a returned same reference",
    } as const;
    for (const commit of ["setResult", "resultCommit", "swapBack", "refresh"] as const) {
      test(`an in-place patch kept through ${keptThrough[commit]} re-renders`, async () => {
        const runtime = createRuntime({ development: true, eventBufferSize: 512 });
        runtimes.push(runtime);
        await runtime.submit({ _tag: "RuntimeStart" });
        const handle = runtime.client.node(CounterNode, {});
        await handle.ensureReady();
        const Reader = observer(function Reader() {
          const node = useReader();
          return createElement("output", undefined, `count=${node.result.count}`);
        });
        const view = render(
          <FrondProvider runtime={runtime}>
            <Reader />
          </FrondProvider>
        );
        expect(view.container.textContent).toBe("count=0");
        await act(async () => {
          const result =
            commit === "setResult"
              ? await handle.actions.patchThenSet()
              : commit === "resultCommit"
                ? await handle.actions.patchThenCommit()
                : commit === "swapBack"
                  ? await handle.actions.patchThenSwapBack()
                  : await handle.refresh();
          expect(result._tag).toBe("Success");
        });
        expect(handle.readReady().result.count).toBe(1);
        expect(view.container.textContent).toBe("count=1");
      });
    }
  });
}
