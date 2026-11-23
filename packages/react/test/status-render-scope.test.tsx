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
import { FrondProvider, useNodeRead, useNodeState } from "@frondruntime/react";
import { act, cleanup, render } from "@testing-library/react";
import { createElement } from "react";
import { makeReactNodeStore } from "../src/nodeStore";

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
  readonly result: { readonly count: number };
  readonly actions: {
    readonly keep: ActionContract;
    readonly hold: ActionContract;
  };
}>;

function counterFixture() {
  const holdEntered = Promise.withResolvers<void>();
  const holdRelease = Promise.withResolvers<void>();
  class CounterNode extends NodeBase<CounterSpec> {
    static readonly spec = resourceSpec.async<CounterSpec>({
      tag: tag("react/status-render-scope/counter"),
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => ({ count: 0 })),
      actions: {
        keep: Driver.Action((ctx) => {
          ctx.setResult((current) => current);
        }),
        hold: Driver.Action(async () => {
          holdEntered.resolve();
          await holdRelease.promise;
        }),
      },
    });
  }
  return { CounterNode, holdEntered, holdRelease };
}

async function mountReaders() {
  const { CounterNode, holdEntered, holdRelease } = counterFixture();
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const handle = runtime.client.node(CounterNode, {});
  await handle.ensureReady();
  const renders = { state: 0, read: 0 };
  function StateReader() {
    const state = useNodeState(CounterNode, {});
    renders.state += 1;
    return createElement("i", undefined, state.busy ? "busy" : "idle");
  }
  function ReadReader() {
    const read = useNodeRead(CounterNode, {});
    renders.read += 1;
    return createElement("i", undefined, read.busy ? "busy" : "idle");
  }
  render(
    <FrondProvider runtime={runtime}>
      <StateReader />
      <ReadReader />
    </FrondProvider>
  );
  return { handle, renders, holdEntered, holdRelease };
}

test("a status store bumps once per distinct state, not once per notification", async () => {
  const { CounterNode } = counterFixture();
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const handle = runtime.client.node(CounterNode, {});
  await handle.ensureReady();
  const store = makeReactNodeStore(runtime, {
    spec: CounterNode,
    args: {},
    nodeId: runtime.resolveNodeIdSync({ spec: CounterNode, args: {} }),
  });
  let notifications = 0;
  const unsubscribeRuntime = handle.subscribe(() => {
    notifications += 1;
  });
  const unsubscribeStore = store.subscribe(() => {});
  const versionBefore = store.getVersion();

  // A sync action that writes nothing: running, then idle again.
  expect((await handle.actions.keep())._tag).toBe("Success");

  // The runtime repeats each state; the store bumps only on a change.
  expect(notifications).toBeGreaterThan(2);
  expect(store.getVersion() - versionBefore).toBe(2);
  unsubscribeStore();
  unsubscribeRuntime();
  store.dispose();
});

test("a status store still bumps when its readiness attempt settles", async () => {
  const { CounterNode } = counterFixture();
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const store = makeReactNodeStore(runtime, {
    spec: CounterNode,
    args: {},
    nodeId: runtime.resolveNodeIdSync({ spec: CounterNode, args: {} }),
  });
  const seen: string[] = [];
  const unsubscribe = store.subscribe(() => {
    seen.push(store.peek()._tag);
  });
  const handle = runtime.client.node(CounterNode, {});
  await handle.ensureReady();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The runtime reports Ready, then the store's own readiness attempt
  // settles: a Suspense reader gated on that attempt needs the second bump.
  expect(seen.slice(-2)).toEqual(["Ready", "Ready"]);
  unsubscribe();
  store.dispose();
});

test("status readers rerender when the busy flag changes", async () => {
  const { handle, renders, holdEntered, holdRelease } = await mountReaders();
  const before = { ...renders };

  let pending: Promise<unknown> | undefined;
  await act(async () => {
    pending = handle.actions.hold();
    await holdEntered.promise;
  });

  expect(renders.state - before.state).toBe(1);
  expect(renders.read - before.read).toBe(1);

  await act(async () => {
    holdRelease.resolve();
    await pending;
  });

  expect(renders.state - before.state).toBe(2);
  expect(renders.read - before.read).toBe(2);
});

test("status readers never read the result's own fields", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let getterReads = 0;
  function result(version: number) {
    return {
      get unrelated(): number {
        getterReads += 1;
        throw new Error("unused getter");
      },
      version,
    };
  }
  type GetterSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: ReturnType<typeof result>;
    readonly actions: { readonly replace: ActionContract };
  }>;
  class GetterNode extends NodeBase<GetterSpec> {
    static readonly spec = resourceSpec.async<GetterSpec>({
      tag: tag("react/status-render-scope/getter"),
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => result(0)),
      actions: {
        replace: Driver.Action(async (ctx) => {
          entered.resolve();
          await release.promise;
          ctx.setResult(result(1));
        }),
      },
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const handle = runtime.client.node(GetterNode, {});
  await handle.ensureReady();

  function Status() {
    const state = useNodeState(GetterNode, {});
    return createElement("output", { "data-testid": "status" }, state.busy ? "busy" : "idle");
  }
  function ExplicitRead() {
    const read = useNodeRead(GetterNode, {});
    return createElement(
      "output",
      { "data-testid": "read" },
      read._tag === "Ready" ? `${read.busy ? "busy" : "idle"}:${read.result.version}` : read._tag
    );
  }
  const view = render(
    createElement(
      FrondProvider,
      { runtime },
      createElement("div", null, createElement(Status), createElement(ExplicitRead))
    )
  );

  let pending: Promise<unknown> = Promise.resolve();
  await act(async () => {
    pending = handle.actions.replace();
    await entered.promise;
  });
  expect(view.getByTestId("status").textContent).toBe("busy");
  expect(view.getByTestId("read").textContent).toBe("busy:0");

  await act(async () => {
    release.resolve();
    await pending;
  });
  expect([
    view.getByTestId("status").textContent,
    view.getByTestId("read").textContent,
    getterReads,
  ]).toEqual(["idle", "idle:1", 0]);
});
