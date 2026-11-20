import { afterEach, expect, test } from "bun:test";
import "global-jsdom/register";
import {
  type ActionContract,
  Driver,
  Graph,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "@frondruntime/core";
import { createFrondTestHarness } from "@frondruntime/core/testing";
import {
  FrondProvider,
  useNodeControls,
  useNodeState,
  useNodesControls,
  useRuntimeClient,
} from "@frondruntime/react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Suspense, useState } from "react";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const harnesses: Array<ReturnType<typeof createFrondTestHarness>> = [];
const observers: MutationObserver[] = [];

afterEach(async () => {
  for (const observer of observers.splice(0)) observer.disconnect();
  cleanup();
  for (const harness of harnesses.splice(0)) await harness.teardown();
});

async function startHarness() {
  const harness = createFrondTestHarness();
  harnesses.push(harness);
  await harness.start();
  return harness;
}

function observeStates(container: HTMLElement) {
  const states: string[] = [];
  const capture = () => {
    const state = container.querySelector("output")?.textContent;
    if (state !== undefined && state !== null && states.at(-1) !== state) states.push(state);
  };
  capture();
  const observer = new MutationObserver(capture);
  observer.observe(container, { subtree: true, childList: true, characterData: true });
  observers.push(observer);
  return states;
}

test.each([
  "action",
  "refresh",
] as const)("a click exposes the running %s status and commits the result before clearing busy", async (operation) => {
  const completion = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let pending: Promise<unknown> = Promise.resolve();
  type CounterSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly result: number;
    readonly actions: { readonly increment: ActionContract<number, string> };
  }>;
  class CounterNode extends NodeBase<CounterSpec> {
    static readonly spec = resourceSpec.async<CounterSpec>({
      tag: tag(`compat/react/status-${operation}`),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => 1),
      refresh: Driver.Refresh(async (context) => {
        entered.resolve();
        await completion.promise;
        await context.setResult(5);
      }),
      actions: {
        increment: Driver.Action(async (context, amount) => {
          entered.resolve();
          await completion.promise;
          await context.setResult(context.node.result + amount);
          return "incremented";
        }),
      },
    });
  }
  function Content() {
    const state = useNodeState(CounterNode, {});
    const controls = useNodeControls(CounterNode, {});
    const running =
      state.operation._tag === "Running"
        ? `${state.operation.kind}:${state.operation.action ?? "none"}`
        : "Idle";
    return (
      <>
        <output>
          {state.node.result}:{state.busy ? "busy" : "idle"}:{running}:{state.resultValidity._tag}
        </output>
        <button
          type="button"
          onClick={() => {
            pending = operation === "action" ? state.node.actions.increment(4) : controls.refresh();
          }}
        >
          run
        </button>
      </>
    );
  }
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Suspense fallback="booting">
        <Content />
      </Suspense>
    </FrondProvider>
  );
  expect(await view.findByText("1:idle:Idle:Current")).toBeTruthy();
  const states = observeStates(view.container);
  await act(async () => {
    fireEvent.click(view.getByText("run"));
    await entered.promise;
  });
  const busy = `1:busy:${operation}:${operation === "action" ? "increment" : "none"}:Current`;
  expect(await view.findByText(busy)).toBeTruthy();
  await act(async () => {
    completion.resolve();
    const result = await pending;
    if (operation === "action") expect(result).toBe("incremented");
    else expect(result).toMatchObject({ _tag: "Success" });
  });
  expect(view.getByText("5:idle:Idle:Current")).toBeTruthy();
  expect(states).toEqual(["1:idle:Idle:Current", busy, "5:idle:Idle:Current"]);
});

test.each([
  "action",
  "refresh",
] as const)("a failed %s keeps ready content and exposes operationFailure before a successful retry", async (operation) => {
  const completion = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  let shouldFail = true;
  let pending: Promise<unknown> = Promise.resolve();
  const failure = new Error("request rejected");
  type FailureSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly result: string;
    readonly actions: { readonly save: ActionContract<string, string> };
  }>;
  class FailureNode extends NodeBase<FailureSpec> {
    static readonly spec = resourceSpec.async<FailureSpec>({
      tag: tag(`compat/react/failure-${operation}`),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => "saved"),
      refresh: Driver.Refresh(async (context) => {
        entered.resolve();
        await completion.promise;
        if (shouldFail) throw failure;
        await context.setResult("recovered");
      }),
      actions: {
        save: Driver.Action(async (context, value) => {
          entered.resolve();
          await completion.promise;
          if (shouldFail) throw failure;
          await context.setResult(value);
          return "save complete";
        }),
      },
    });
  }
  function Content() {
    const state = useNodeState(FailureNode, {});
    const controls = useNodeControls(FailureNode, {});
    const error = state.operationFailure?.error;
    const errorTag =
      error instanceof Graph.ActionFailed || error instanceof Graph.RefreshFailed
        ? error._tag
        : "none";
    return (
      <>
        <output>
          {state.node.result}:{state.busy ? "busy" : "idle"}:
          {state.operationFailure?.kind ?? "none"}:{errorTag}
        </output>
        <button
          type="button"
          onClick={() => {
            const submitted =
              operation === "action" ? state.node.actions.save("recovered") : controls.refresh();
            pending = submitted.then(
              (result) => result,
              (error: unknown) => error
            );
          }}
        >
          save
        </button>
      </>
    );
  }
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Suspense fallback="booting">
        <Content />
      </Suspense>
    </FrondProvider>
  );
  expect(await view.findByText("saved:idle:none:none")).toBeTruthy();
  const states = observeStates(view.container);
  await act(async () => {
    fireEvent.click(view.getByText("save"));
    await entered.promise;
  });
  expect(await view.findByText("saved:busy:none:none")).toBeTruthy();
  await act(async () => {
    completion.resolve();
    const result = await pending;
    const error =
      result instanceof Graph.ActionFailed
        ? result
        : typeof result === "object" && result !== null && "error" in result
          ? result.error
          : undefined;
    if (!(error instanceof Graph.ActionFailed || error instanceof Graph.RefreshFailed)) {
      throw new Error("The operation did not expose its typed failure");
    }
    expect(error._tag).toBe(operation === "action" ? "ActionFailed" : "RefreshFailed");
    expect(error.nodeId).toBe(harness.node(FailureNode, {}).nodeId);
    expect(error.tag).toBe(FailureNode.spec.tag);
    if (error instanceof Graph.ActionFailed) {
      expect(error.action).toBe("save");
      expect(error.input).toBe("recovered");
    }
    expect(error.cause).toBeInstanceOf(Graph.DriverPromiseFailed);
    if (!(error.cause instanceof Graph.DriverPromiseFailed))
      throw new Error("Missing driver failure");
    expect(error.cause.cause).toBe(failure);
  });
  const failed = `saved:idle:${operation}:${operation === "action" ? "ActionFailed" : "RefreshFailed"}`;
  expect(await view.findByText(failed)).toBeTruthy();
  expect(states).toEqual(["saved:idle:none:none", "saved:busy:none:none", failed]);
  shouldFail = false;
  await act(async () => {
    fireEvent.click(view.getByText("save"));
    await pending;
  });
  expect(await view.findByText("recovered:idle:none:none")).toBeTruthy();
});

test("singular controls ensure refresh release and evict without a Suspense reader", async () => {
  const released: string[] = [];
  type ResourceSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly result: string;
  }>;
  class ResourceNode extends NodeBase<ResourceSpec> {
    static readonly spec = resourceSpec.async<ResourceSpec>({
      tag: tag("compat/react/singular-controls"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => "acquired"),
      refresh: Driver.Refresh(async (context) => {
        await context.setResult("refreshed");
      }),
      release: Driver.Release(async (context) => {
        released.push(context.node.result);
      }),
    });
  }
  let pending: Promise<void> = Promise.resolve();
  function Content() {
    const controls = useNodeControls(ResourceNode, {});
    const client = useRuntimeClient();
    const [label, setLabel] = useState("controls only");
    const readLabel = () => {
      const read = client.node(ResourceNode, {}).read();
      return read._tag === "Ready" ? read.result : read._tag;
    };
    return (
      <>
        <output>{label}</output>
        <button
          type="button"
          onClick={() => {
            pending = controls.ensureReady().then(() => setLabel(readLabel()));
          }}
        >
          ensure
        </button>
        <button
          type="button"
          onClick={() => {
            pending = controls
              .refresh()
              .then((result) => setLabel(`${result._tag}:${readLabel()}`));
          }}
        >
          refresh
        </button>
        <button
          type="button"
          onClick={() => {
            pending = controls
              .releaseResources("screen closed")
              .then(() => setLabel(`released:${readLabel()}`));
          }}
        >
          release
        </button>
        <button
          type="button"
          onClick={() => {
            pending = controls
              .evict("selfAndDependents", "reset")
              .then((result) =>
                setLabel(`evicted:${result.nodeIds.includes(controls.nodeId)}:${readLabel()}`)
              );
          }}
        >
          evict
        </button>
      </>
    );
  }
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Content />
    </FrondProvider>
  );
  expect(view.getByText("controls only")).toBeTruthy();
  expect(harness.node(ResourceNode, {}).read()._tag).toBe("Unwired");
  const click = async (label: string) =>
    act(async () => {
      fireEvent.click(view.getByText(label));
      await pending;
    });
  await click("ensure");
  expect(view.getByText("acquired")).toBeTruthy();
  await click("refresh");
  expect(view.getByText("Success:refreshed")).toBeTruthy();
  await click("release");
  expect(view.getByText("released:Idle")).toBeTruthy();
  expect(released).toEqual(["refreshed"]);
  await click("ensure");
  expect(view.getByText("acquired")).toBeTruthy();
  await click("evict");
  expect(view.getByText("evicted:true:Unwired")).toBeTruthy();
  expect(released).toEqual(["refreshed", "acquired"]);
});

test("plural controls keep keyed resources independent through every lifecycle method", async () => {
  type KeyedSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: { readonly identity: string };
    readonly key: Key.Structure<{ readonly identity: string }>;
    readonly result: string;
  }>;
  class KeyedNode extends NodeBase<KeyedSpec> {
    static readonly spec = resourceSpec.async<KeyedSpec>({
      tag: tag("compat/react/plural-controls"),
      key: (args) => Key.structure({ identity: args.identity }),
      acquire: Driver.Acquire(async (context) => `${context.args.identity}:initial`),
      refresh: Driver.Refresh(async (context) => {
        await context.setResult(`${context.args.identity}:updated`);
      }),
    });
  }
  let pending: Promise<void> = Promise.resolve();
  function Content() {
    const controls = useNodesControls({
      left: [KeyedNode, { identity: "left" }],
      right: [KeyedNode, { identity: "right" }],
    });
    const client = useRuntimeClient();
    const [label, setLabel] = useState("controls only");
    const update = () =>
      setLabel(
        ["left", "right"]
          .map((identity) => {
            const read = client.node(KeyedNode, { identity }).read();
            return read._tag === "Ready" ? read.result : read._tag;
          })
          .join("/")
      );
    return (
      <>
        <output>{label}</output>
        <button
          type="button"
          onClick={() => {
            pending = Promise.all([controls.left.ensureReady(), controls.right.ensureReady()]).then(
              update
            );
          }}
        >
          ensure both
        </button>
        <button
          type="button"
          onClick={() => {
            pending = controls.left.refresh().then(update);
          }}
        >
          refresh left
        </button>
        <button
          type="button"
          onClick={() => {
            pending = controls.left.releaseResources().then(update);
          }}
        >
          release left
        </button>
        <button
          type="button"
          onClick={() => {
            pending = controls.right.evict("selfAndDependents").then(update);
          }}
        >
          evict right
        </button>
      </>
    );
  }
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Content />
    </FrondProvider>
  );
  const states = observeStates(view.container);
  for (const [button, expected] of [
    ["ensure both", "left:initial/right:initial"],
    ["refresh left", "left:updated/right:initial"],
    ["release left", "Idle/right:initial"],
    ["evict right", "Idle/Unwired"],
  ] as const) {
    await act(async () => {
      fireEvent.click(view.getByText(button));
      await pending;
    });
    expect(view.getByText(expected)).toBeTruthy();
  }
  expect(states).toEqual([
    "controls only",
    "left:initial/right:initial",
    "left:updated/right:initial",
    "Idle/right:initial",
    "Idle/Unwired",
  ]);
});
