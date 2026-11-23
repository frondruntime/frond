import { afterEach, expect, test } from "bun:test";
import "../setup";
import {
  type ActionContract,
  Driver,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "@frondruntime/core";
import { createFrondTestHarness, readySpec } from "@frondruntime/core/testing";
import { useNode, useNodes } from "@frondruntime/react";
import { TestFrondProvider } from "@frondruntime/react/testing";
import { act, cleanup, render } from "@testing-library/react";
import { observer } from "mobx-react-lite";
import { Suspense } from "react";

// MIGRATION-0.6.md, section 10: graph work runs in one microtask drain, so
// the initial render commits no graph work before that drain.

const harnesses: Array<ReturnType<typeof createFrondTestHarness>> = [];

afterEach(async () => {
  cleanup();
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

type CountSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: number;
}>;

test("a readySpec node suspends on its first read and is ready after an async act", async () => {
  class CountNode extends NodeBase<CountSpec> {
    static readonly spec = resourceSpec.async<CountSpec>({
      tag: tag("compat/react-queue-deferral/ready-spec"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => 0),
    });
  }
  const Reader = observer(function Reader() {
    const { count } = useNodes({ count: [CountNode, {}] });
    return <output>{`count:${count.result}`}</output>;
  });
  const harness = createFrondTestHarness({
    specOverrides: [{ from: CountNode, to: readySpec(CountNode, 1) }],
  });
  harnesses.push(harness);
  const tree = (
    <TestFrondProvider harness={harness}>
      <Suspense fallback={<output>loading</output>}>
        <Reader />
      </Suspense>
    </TestFrondProvider>
  );

  let view: ReturnType<typeof render> | undefined;
  const mounting = act(() => {
    view = render(tree);
  });
  // 0.6 intended change: 0.5 acquired the override in the caller's frame and
  // rendered "count:1" after a synchronous act.
  expect(view?.container.textContent).toBe("loading");
  // Await the same scope after checking the caller's frame. React.use leaves
  // work in this act queue that a separate empty act cannot finish.
  await mounting;
  expect(view?.container.textContent).toBe("count:1");
});

type DraftSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: string;
  readonly actions: { readonly save: ActionContract<string, string> };
}>;

test("an action's result write lands after a synchronous act, inside an async act", async () => {
  class DraftNode extends NodeBase<DraftSpec> {
    static readonly spec = resourceSpec.async<DraftSpec>({
      tag: tag("compat/react-queue-deferral/action-write"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => "empty"),
      actions: {
        save: Driver.Action((context, draft) => {
          context.setResult(draft);
          return draft;
        }),
      },
    });
  }
  let save: ((draft: string) => Promise<string>) | undefined;
  const Editor = observer(function Editor() {
    const node = useNode(DraftNode, {});
    save = node.actions.save;
    return <output>{node.result}</output>;
  });
  const harness = createFrondTestHarness();
  harnesses.push(harness);
  const view = await act(async () =>
    render(
      <TestFrondProvider harness={harness}>
        <Suspense fallback={<output>loading</output>}>
          <Editor />
        </Suspense>
      </TestFrondProvider>
    )
  );
  expect(await view.findByText("empty")).toBeTruthy();

  let saving: Promise<string> | undefined;
  act(() => {
    saving = save?.("first");
  });
  // 0.6 intended change: 0.5 wrote the MobX result inside the synchronous act.
  expect(view.container.textContent).toBe("empty");
  await act(async () => {
    await saving;
  });
  expect(view.container.textContent).toBe("first");

  await act(async () => {
    await save?.("second");
  });
  expect(view.container.textContent).toBe("second");
});
