import { afterEach, expect, spyOn, test } from "bun:test";
import "global-jsdom/register";
import {
  type Dep,
  Driver,
  dep,
  dependencies,
  Graph,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "@frondruntime/core";
import { createFrondTestHarness } from "@frondruntime/core/testing";
import { FrondProvider, useNode, useNodeRead, useNodes } from "@frondruntime/react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { StrictMode, Suspense } from "react";

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
    const state = container.querySelector("[data-state]")?.textContent;
    if (state !== undefined && state !== null && states.at(-1) !== state) states.push(state);
  };
  capture();
  const observer = new MutationObserver(capture);
  observer.observe(container, { subtree: true, childList: true, characterData: true });
  observers.push(observer);
  return states;
}

type TextSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: string;
}>;

test("useNode shows the Suspense fallback before the boot result", async () => {
  const boot = Promise.withResolvers<string>();
  class BootNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/boot"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(() => boot.promise),
    });
  }
  function Content() {
    return <output data-state>{useNode(BootNode, {}).result}</output>;
  }
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Suspense fallback={<output data-state>booting</output>}>
        <Content />
      </Suspense>
    </FrondProvider>
  );
  expect(view.getByText("booting")).toBeTruthy();
  const states = observeStates(view.container);
  await act(async () => boot.resolve("ready content"));
  expect(await view.findByText("ready content")).toBeTruthy();
  expect(states).toEqual(["booting", "ready content"]);
});

test.each([
  "ready",
  "failure",
] as const)("useNodeRead shows Pending inline before the boot %s without a boundary", async (outcome) => {
  const boot = Promise.withResolvers<string>();
  class InlineNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag(`compat/react/inline-${outcome}`),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(() => boot.promise),
    });
  }
  function Content() {
    const read = useNodeRead(InlineNode, {});
    return (
      <output data-state>
        {read._tag === "Ready"
          ? `Ready:${read.result}`
          : read._tag === "Error"
            ? `Error:${read.kind}:${read.error instanceof Graph.AcquireFailed ? read.error._tag : "unexpected"}`
            : read._tag}
      </output>
    );
  }
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Content />
    </FrondProvider>
  );
  expect(await view.findByText("Pending")).toBeTruthy();
  const states = observeStates(view.container);
  await act(async () => {
    if (outcome === "ready") boot.resolve("inline content");
    else boot.reject(new Error("inline boot failed"));
  });
  // 0.5 behavior: the inline read exposes AcquireFailed directly, whereas
  // the throwing reader decorates it as FrondRuntimeReadError for boundaries.
  const final = outcome === "ready" ? "Ready:inline content" : "Error:readiness:AcquireFailed";
  expect(await view.findByText(final)).toBeTruthy();
  expect(states).toEqual(["Pending", final]);
});

test("useNode switches a mounted reader to the new keyed arguments", async () => {
  const secondBoot = Promise.withResolvers<string>();
  type KeyedSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: { readonly identity: string };
    readonly key: Key.Structure<{ readonly identity: string }>;
    readonly result: string;
  }>;
  class KeyedNode extends NodeBase<KeyedSpec> {
    static readonly spec = resourceSpec.async<KeyedSpec>({
      tag: tag("compat/react/keyed-arguments"),
      key: (args) => Key.structure({ identity: args.identity }),
      acquire: Driver.Acquire(async (context) =>
        context.args.identity === "second" ? secondBoot.promise : "first result"
      ),
    });
  }
  function Content({ identity }: { readonly identity: string }) {
    return <output>{useNode(KeyedNode, { identity }).result}</output>;
  }
  const harness = await startHarness();
  const tree = (identity: string) => (
    <FrondProvider runtime={harness.runtime}>
      <Suspense fallback={<output>switching</output>}>
        <Content identity={identity} />
      </Suspense>
    </FrondProvider>
  );
  const view = render(tree("first"));
  expect(await view.findByText("first result")).toBeTruthy();
  view.rerender(tree("second"));
  expect(await view.findByText("switching")).toBeTruthy();
  await act(async () => secondBoot.resolve("second result"));
  expect(await view.findByText("second result")).toBeTruthy();
  expect(view.queryByText("first result")).toBeNull();
});

test.each([
  "useNode",
  "useNodes",
] as const)("%s keeps ready content visible while new arguments refresh the same identity", async (hook) => {
  const refresh = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  type FilterSpec = NodeSpec<{
    readonly mode: "async";
    readonly args: { readonly filter: string };
    readonly key: Key.Singleton;
    readonly result: string;
  }>;
  class FilterNode extends NodeBase<FilterSpec> {
    static readonly spec = resourceSpec.async<FilterSpec>({
      tag: tag(`compat/react/${hook}-filter`),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async (context) => context.args.filter),
      refresh: Driver.Refresh(async (context) => {
        entered.resolve();
        await refresh.promise;
        await context.setResult(context.args.filter);
      }),
    });
  }
  class SiblingNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag(`compat/react/${hook}-sibling`),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => "sibling"),
    });
  }
  function SingularContent({ filter }: { readonly filter: string }) {
    const node = useNode(FilterNode, { filter });
    return (
      <output data-state>
        {node.result}:{node.args.filter}
      </output>
    );
  }
  function PluralContent({ filter }: { readonly filter: string }) {
    const nodes = useNodes({ filtered: [FilterNode, { filter }], sibling: [SiblingNode, {}] });
    return (
      <output data-state>
        {nodes.filtered.result}:{nodes.filtered.args.filter}/{nodes.sibling.result}
      </output>
    );
  }
  const harness = await startHarness();
  const tree = (filter: string) => (
    <FrondProvider runtime={harness.runtime}>
      <Suspense fallback={<output>booting</output>}>
        {hook === "useNode" ? (
          <SingularContent filter={filter} />
        ) : (
          <PluralContent filter={filter} />
        )}
      </Suspense>
    </FrondProvider>
  );
  const suffix = hook === "useNodes" ? "/sibling" : "";
  const view = render(tree("all"));
  expect(await view.findByText(`all:all${suffix}`)).toBeTruthy();
  const states = observeStates(view.container);
  view.rerender(tree("active"));
  await act(async () => entered.promise);
  expect(await view.findByText(`all:active${suffix}`)).toBeTruthy();
  expect(view.queryByText("booting")).toBeNull();
  await act(async () => refresh.resolve());
  expect(await view.findByText(`active:active${suffix}`)).toBeTruthy();
  expect(states).toEqual([`all:all${suffix}`, `all:active${suffix}`, `active:active${suffix}`]);
});

test("a parent reader displays a child refresh only after the parent also refreshes", async () => {
  let childResult = "initial child";
  class ChildNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/dependency-child"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => childResult),
      refresh: Driver.Refresh(async (context) => {
        await context.setResult(childResult);
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
      tag: tag("compat/react/dependency-parent"),
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({ child: dep(ChildNode, {}) })),
      acquire: Driver.Acquire(async () => "parent"),
      refresh: Driver.Refresh(async (context) => {
        await context.setResult("refreshed parent");
      }),
    });
  }
  function Content() {
    const parent = useNode(ParentNode, {});
    return <output data-state>{parent.deps.child.result}</output>;
  }
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Suspense fallback="booting">
        <Content />
      </Suspense>
    </FrondProvider>
  );
  expect(await view.findByText("initial child")).toBeTruthy();
  const states = observeStates(view.container);
  childResult = "updated child";
  await act(async () => {
    await harness.node(ChildNode, {}).refresh();
  });
  // 0.5 behavior: useNode tracks the parent identity, so a plain React reader
  // does not observe a dependency's MobX result without an observer wrapper.
  expect(view.getByText("initial child")).toBeTruthy();
  await act(async () => {
    await harness.node(ParentNode, {}).refresh();
  });
  expect(await view.findByText("updated child")).toBeTruthy();
  childResult = "latest child";
  await act(async () => {
    await harness.node(ChildNode, {}).refresh();
    await harness.node(ParentNode, {}).refresh();
  });
  // 0.6 intended change (docs/v06-architecture.md, "React store and result identity"): the
  // second parent refresh commits an equal result, a status-only notification, so a plain
  // useNode(parent) reader does not re-render. 0.5 showed "latest child" here. Readers of a
  // dependency's result use useNode(ChildNode) or a MobX observer.
  expect(view.getByText("updated child")).toBeTruthy();
  expect(states).toEqual(["initial child", "updated child"]);
});

test("StrictMode can unmount a pending boot and remount its ready result without warnings", async () => {
  const boot = Promise.withResolvers<string>();
  const entered = Promise.withResolvers<void>();
  class StrictNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/strict-remount"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(() => {
        entered.resolve();
        return boot.promise;
      }),
    });
  }
  function Content() {
    return <output>{useNode(StrictNode, {}).result}</output>;
  }
  const harness = await startHarness();
  const errors = spyOn(console, "error").mockImplementation(() => {});
  const warnings = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const tree = (
      <StrictMode>
        <FrondProvider runtime={harness.runtime}>
          <Suspense fallback={<output>booting</output>}>
            <Content />
          </Suspense>
        </FrondProvider>
      </StrictMode>
    );
    const first = render(tree);
    expect(first.getByText("booting")).toBeTruthy();
    await act(async () => entered.promise);
    first.unmount();
    await act(async () => {
      boot.resolve("remounted content");
      await harness.node(StrictNode, {}).ensureReady();
    });
    const second = render(tree);
    expect(await second.findByText("remounted content")).toBeTruthy();
    second.unmount();
    const third = render(tree);
    expect(await third.findByText("remounted content")).toBeTruthy();
    expect(errors.mock.calls).toEqual([]);
    expect(warnings.mock.calls).toEqual([]);
  } finally {
    errors.mockRestore();
    warnings.mockRestore();
  }
});

test("twelve components reading one node all display its refreshed result", async () => {
  class SharedNode extends NodeBase<TextSpec> {
    static readonly spec = resourceSpec.async<TextSpec>({
      tag: tag("compat/react/shared-readers"),
      key: () => Key.singleton(),
      acquire: Driver.Acquire(async () => "initial"),
      refresh: Driver.Refresh(async (context) => {
        await context.setResult("final");
      }),
    });
  }
  function Content({ identity }: { readonly identity: number }) {
    return <output data-testid={`reader-${identity}`}>{useNode(SharedNode, {}).result}</output>;
  }
  const identities = Array.from({ length: 12 }, (_, identity) => identity);
  const harness = await startHarness();
  const view = render(
    <FrondProvider runtime={harness.runtime}>
      <Suspense fallback="booting">
        {identities.map((identity) => (
          <Content key={identity} identity={identity} />
        ))}
      </Suspense>
    </FrondProvider>
  );
  await waitFor(() => {
    for (const identity of identities)
      expect(view.getByTestId(`reader-${identity}`).textContent).toBe("initial");
  });
  await act(async () => {
    await harness.node(SharedNode, {}).refresh();
  });
  for (const identity of identities)
    expect(view.getByTestId(`reader-${identity}`).textContent).toBe("final");
});
