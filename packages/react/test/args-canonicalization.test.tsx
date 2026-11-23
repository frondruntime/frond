import "./setup";
import { afterEach, describe, expect, test } from "bun:test";
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
import { createElement, Suspense } from "react";
import { FrondProvider, useNodeControls, useNodeRead, useNodes } from "../src";
import { getReactArgsFingerprint } from "../src/argsFingerprint";
import { prepareReactNodeMap } from "../src/nodeInputMap";
import { makeReactNodeStore } from "../src/nodeStore";
import type { ReactNodeRuntime } from "../src/types";

afterEach(() => {
  cleanup();
});

type PageArgs = { readonly page: number; readonly query: string };

type SingletonPageSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: PageArgs;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
}>;

class SingletonPageNode extends NodeBase<SingletonPageSpec> {
  static readonly spec = resourceSpec.effect<SingletonPageSpec>({
    tag: "react-canonical/singleton-page",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed(1)),
  });
}

type WholeArgsPageSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: PageArgs;
  readonly key: Key.Structure<PageArgs>;
  readonly deps: Record<string, never>;
  readonly result: number;
}>;

class WholeArgsPageNode extends NodeBase<WholeArgsPageSpec> {
  static readonly spec = resourceSpec.effect<WholeArgsPageSpec>({
    tag: "react-canonical/whole-args-page",
    key: (args) => Key.structure(args),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed(2)),
  });
}

// Same tag as SingletonPageNode, keyed by the whole args: an override from the
// singleton spec to this one changes the resolved node id.
class OverridePageNode extends NodeBase<WholeArgsPageSpec> {
  static readonly spec = resourceSpec.effect<WholeArgsPageSpec>({
    tag: "react-canonical/singleton-page",
    key: (args) => Key.structure(args),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed(3)),
  });
}

// A plain-object proxy whose `ownKeys` trap counts canonicalization passes:
// each pass sorts the object's keys exactly once.
function countingArgs(target: PageArgs, counter: { passes: number }): PageArgs {
  return new Proxy(target, {
    ownKeys(object) {
      counter.passes += 1;
      return Reflect.ownKeys(object);
    },
  });
}

function publicIdentity(runtime: ReactNodeRuntime, spec: unknown, args: unknown) {
  const nodeId = runtime.resolveNodeIdSync({ spec, args } as never);
  return { nodeId, argsFingerprint: getReactArgsFingerprint(args) };
}

function preparedIdentity(runtime: ReactNodeRuntime, spec: unknown, args: unknown) {
  const [entry] = prepareReactNodeMap({
    hook: "useNodes",
    runtime,
    map: { only: [spec, args] } as never,
  }).entries;
  return { nodeId: entry?.nodeId, argsFingerprint: entry?.argsFingerprint };
}

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (cause) {
    return cause;
  }
  throw new Error("expected a throw");
}

describe("React args canonicalization", () => {
  test("the counting proxy passes the plain-object check and counts one pass", () => {
    const counter = { passes: 0 };
    const args = countingArgs({ page: 1, query: "a" }, counter);

    expect(Key.canonicalArgs(args)).toBe(Key.canonicalArgs({ query: "a", page: 1 }));
    expect(counter.passes).toBe(1);
  });

  test("useNodeRead canonicalizes args once per render", async () => {
    const counter = { passes: 0 };
    let renders = 0;
    const View = () => {
      renders += 1;
      const read = useNodeRead(SingletonPageNode, countingArgs({ page: 1, query: "a" }, counter));
      return createElement("output", undefined, read._tag);
    };
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = await act(async () =>
      render(createElement(FrondProvider, { runtime }, createElement(View)))
    );
    await act(async () => {
      await Promise.resolve();
    });

    counter.passes = 0;
    renders = 0;
    view.rerender(createElement(FrondProvider, { runtime }, createElement(View)));

    expect(renders).toBeGreaterThan(0);
    expect(counter.passes).toBe(renders);
  });

  test("useNodeControls canonicalizes args once per render", async () => {
    const counter = { passes: 0 };
    let renders = 0;
    const View = () => {
      renders += 1;
      useNodeControls(SingletonPageNode, countingArgs({ page: 1, query: "a" }, counter));
      return createElement("output", undefined, "controls");
    };
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = await act(async () =>
      render(createElement(FrondProvider, { runtime }, createElement(View)))
    );
    await act(async () => {
      await Promise.resolve();
    });

    counter.passes = 0;
    renders = 0;
    view.rerender(createElement(FrondProvider, { runtime }, createElement(View)));

    expect(renders).toBeGreaterThan(0);
    expect(counter.passes).toBe(renders);
  });

  test("useNodes canonicalizes each entry's args once per render", async () => {
    const counter = { passes: 0 };
    let renders = 0;
    const View = observer(({ revision }: { readonly revision: number }) => {
      renders += 1;
      useNodes({
        page: [SingletonPageNode, countingArgs({ page: 1, query: "a" }, counter)],
      });
      return createElement("output", { "data-revision": revision }, "ready");
    });
    const tree = (revision: number) =>
      createElement(
        Suspense,
        { fallback: createElement("span", undefined, "loading") },
        createElement(View, { revision })
      );
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = await act(async () => render(createElement(FrondProvider, { runtime }, tree(0))));
    expect(await view.findByText("ready")).toBeTruthy();

    counter.passes = 0;
    renders = 0;
    view.rerender(createElement(FrondProvider, { runtime }, tree(1)));

    expect(renders).toBeGreaterThan(0);
    expect(counter.passes).toBe(renders);
  });

  test("a store given the render's fingerprint does not canonicalize args for it again", async () => {
    // A fresh runtime each, so both stores pay the same for their `client.node` call.
    const storePasses = async (argsFingerprint: string | undefined) => {
      const runtime = createRuntime({ development: true, eventBufferSize: 512 });
      await runtime.submit({ _tag: "RuntimeStart" });
      const counter = { passes: 0 };
      const args = countingArgs({ page: 1, query: "a" }, counter);
      const nodeId = runtime.resolveNodeIdSync({ spec: SingletonPageNode, args });
      counter.passes = 0;
      const store = makeReactNodeStore(
        runtime,
        { spec: SingletonPageNode as never, args, nodeId, argsFingerprint },
        "status"
      );
      const passes = counter.passes;
      return { store, args, counter, passes };
    };

    const given = await storePasses(getReactArgsFingerprint({ page: 1, query: "a" }));
    const computed = await storePasses(undefined);
    expect(computed.passes - given.passes).toBe(1);

    // The mount effect hands over the render's fingerprint: no pass of its own.
    given.counter.passes = 0;
    await given.store.updateArgs(given.args, getReactArgsFingerprint({ query: "a", page: 1 }));
    expect(given.counter.passes).toBe(0);
    given.store.dispose();
    computed.store.dispose();
  });

  test("useNodes canonicalizes args kept by reference on every render", async () => {
    const counter = { passes: 0 };
    const args = countingArgs({ page: 1, query: "a" }, counter);
    let renders = 0;
    const View = observer(({ revision }: { readonly revision: number }) => {
      renders += 1;
      useNodes({ page: [SingletonPageNode, args] });
      return createElement("output", { "data-revision": revision }, "stable args ready");
    });
    const tree = (revision: number) =>
      createElement(
        Suspense,
        { fallback: createElement("span", undefined, "loading") },
        createElement(View, { revision })
      );
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    const view = await act(async () => render(createElement(FrondProvider, { runtime }, tree(0))));
    // A text no other test renders: `findByText` searches the whole document.
    expect(await view.findByText("stable args ready")).toBeTruthy();

    counter.passes = 0;
    renders = 0;
    view.rerender(createElement(FrondProvider, { runtime }, tree(1)));

    expect(renders).toBeGreaterThan(0);
    expect(counter.passes).toBe(renders);
  });

  test("args mutated in place are fingerprinted again on the next prepare", () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const args = { page: 1, query: "a" };
    const map = { page: [WholeArgsPageNode, args] } as never;
    const first = prepareReactNodeMap({ hook: "useNodes", runtime, map });

    args.page = 2;
    const again = prepareReactNodeMap({ hook: "useNodes", runtime, map });

    expect(first.entries[0]?.argsFingerprint).toBe(
      getReactArgsFingerprint({ page: 1, query: "a" })
    );
    expect(again.entries[0]?.argsFingerprint).toBe(
      getReactArgsFingerprint({ page: 2, query: "a" })
    );
    expect(again.argsIdentity).not.toBe(first.argsIdentity);
  });

  test("resolves the same node id and fingerprint as the public path", () => {
    const longQuery = "x".repeat(3_000);
    const runtime = createRuntime({
      development: true,
      eventBufferSize: 512,
      specOverrides: [{ from: SingletonPageNode, to: OverridePageNode }],
    });
    const plain = createRuntime({ development: true, eventBufferSize: 512 });
    const cases: ReadonlyArray<readonly [ReactNodeRuntime, unknown, PageArgs]> = [
      [plain, SingletonPageNode, { page: 1, query: "a" }],
      [plain, WholeArgsPageNode, { query: "a", page: 1 }],
      // Args over the key size cap are valid args; only the key is capped.
      [plain, SingletonPageNode, { page: 1, query: longQuery }],
      // A whole-args key over the cap resolves to an invalid-key node id.
      [plain, WholeArgsPageNode, { page: 1, query: longQuery }],
      // The spec override decides the key.
      [runtime, SingletonPageNode, { page: 2, query: "b" }],
    ];

    for (const [target, spec, args] of cases) {
      expect(preparedIdentity(target, spec, args)).toEqual(publicIdentity(target, spec, args));
    }
    expect(
      publicIdentity(plain, WholeArgsPageNode, { page: 1, query: longQuery }).nodeId
    ).toContain("__invalid__");
    expect(publicIdentity(runtime, SingletonPageNode, { page: 2, query: "b" }).nodeId).not.toBe(
      publicIdentity(plain, SingletonPageNode, { page: 2, query: "b" }).nodeId
    );
  });

  test("invalid args throw the same error as the public path, before the spec is checked", () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const cases: ReadonlyArray<readonly [unknown, unknown]> = [
      [SingletonPageNode, { page: 1, query: "a", onSelect: () => "ready" }],
      [SingletonPageNode, { page: Number.NaN, query: "a" }],
      // Invalid args and an invalid spec: the args error wins.
      [{ notASpec: true }, { page: 1, query: "a", onSelect: () => "ready" }],
    ];

    for (const [spec, args] of cases) {
      const expected = thrown(() => runtime.resolveNodeIdSync({ spec, args } as never));
      const actual = thrown(() => preparedIdentity(runtime, spec, args));

      expect(Key.isKeyError(expected)).toBe(true);
      expect((actual as Error).constructor).toBe((expected as Error).constructor);
      expect((actual as Error).message).toBe((expected as Error).message);
    }
  });

  test("a wrapper runtime's own resolveNodeIdSync is honored", () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const args = { page: 1, query: "a" };
    const resolveNodeIdSync = () => "wrapped:node" as never;
    const spreadWrapper: ReactNodeRuntime = { ...runtime, resolveNodeIdSync };
    const prototypeWrapper: ReactNodeRuntime = Object.assign(Object.create(runtime), {
      resolveNodeIdSync,
    });
    const proxyWrapper: ReactNodeRuntime = new Proxy(runtime, {
      get(object, property, receiver) {
        return property === "resolveNodeIdSync"
          ? resolveNodeIdSync
          : Reflect.get(object, property, receiver);
      },
    });

    expect(preparedIdentity(spreadWrapper, SingletonPageNode, args).nodeId).toBe("wrapped:node");
    expect(preparedIdentity(prototypeWrapper, SingletonPageNode, args).nodeId).toBe("wrapped:node");
    expect(preparedIdentity(proxyWrapper, SingletonPageNode, args).nodeId).toBe("wrapped:node");
  });

  test("a Proxy runtime honors its public resolver when memoizing a node store", async () => {
    class KeyedPageNode extends NodeBase<WholeArgsPageSpec> {
      static readonly spec = resourceSpec.effect<WholeArgsPageSpec>({
        tag: "react-canonical/singleton-page",
        key: (args) => Key.structure(args),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.args.page)),
      });
    }

    const target = createRuntime({ development: true, eventBufferSize: 512 });
    const delegated = createRuntime({
      development: true,
      eventBufferSize: 512,
      specOverrides: [{ from: SingletonPageNode, to: KeyedPageNode }],
    });
    // The public resolver and client share the delegated graph; the hidden
    // symbol forwards from the target unchanged.
    const wrapper = new Proxy(target, {
      get(object, property, receiver) {
        if (property === "resolveNodeIdSync" || property === "client") {
          return Reflect.get(delegated, property);
        }
        return Reflect.get(object, property, receiver);
      },
    });
    const View = ({ page }: PageArgs) => {
      const read = useNodeRead(SingletonPageNode, { page, query: "a" });
      return createElement("output", undefined, read._tag === "Ready" ? read.result : read._tag);
    };
    const tree = (page: number) =>
      createElement(FrondProvider, { runtime: wrapper }, createElement(View, { page, query: "a" }));

    try {
      await delegated.submit({ _tag: "RuntimeStart" });
      await delegated.client.node(SingletonPageNode, { page: 1, query: "a" }).ensureReadyNode();
      await delegated.client.node(SingletonPageNode, { page: 2, query: "a" }).ensureReadyNode();
      expect(
        wrapper.resolveNodeIdSync({ spec: SingletonPageNode, args: { page: 1, query: "a" } })
      ).not.toBe(
        wrapper.resolveNodeIdSync({ spec: SingletonPageNode, args: { page: 2, query: "a" } })
      );

      const view = await act(async () => render(tree(1)));
      expect(view.getByRole("status").textContent).toBe("1");
      await act(async () => {
        view.rerender(tree(2));
      });

      expect(view.getByRole("status").textContent).toBe("2");
    } finally {
      cleanup();
      await delegated.submit({ _tag: "RuntimeStop" });
    }
  });
});
