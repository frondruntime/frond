// 0.6 intended change: fixes a bug 0.5 shared — a reader that mounts on a ready node with
// different args under the same key aligns the node to its args; the last mount wins.
// Each test file registers its own cleanup; see setup.ts.
import { afterEach, describe, expect, test } from "bun:test";
import "global-jsdom/register";
import {
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  type RuntimeInstance,
  resourceSpec,
} from "@frondruntime/core";
import { act, cleanup, render } from "@testing-library/react";
import { Effect } from "effect";
import { Activity, createElement, type ReactNode, StrictMode, Suspense } from "react";
import { FrondProvider, useNode, useNodeRead, useNodeState, useNodes } from "../src";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

type PageArgs = { readonly page: number };

type SingletonPageSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: PageArgs;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

type KeyedPageSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: PageArgs;
  readonly key: Key.Structure<PageArgs>;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

type Counts = { acquires: number; refreshes: number };

function makeSingletonPageNode(tag: string, rejectedPage?: number) {
  const counts: Counts = { acquires: 0, refreshes: 0 };

  class SingletonPageNode extends NodeBase<SingletonPageSpec> {
    static readonly spec = resourceSpec.effect<SingletonPageSpec>({
      tag,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          counts.acquires += 1;
          return `page-${ctx.args.page}`;
        })
      ),
      refresh: Driver.Refresh((ctx) =>
        Effect.gen(function* () {
          counts.refreshes += 1;
          if (ctx.args.page === rejectedPage) {
            return yield* Effect.fail({ _tag: "RefreshRejected" });
          }
          yield* ctx.setResult(`page-${ctx.args.page}`);
        })
      ),
    });
  }

  return { PageNode: SingletonPageNode, counts };
}

function makeKeyedPageNode(tag: string) {
  const counts: Counts = { acquires: 0, refreshes: 0 };

  class KeyedPageNode extends NodeBase<KeyedPageSpec> {
    static readonly spec = resourceSpec.effect<KeyedPageSpec>({
      tag,
      key: (args) => Key.structure(args),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          counts.acquires += 1;
          return `page-${ctx.args.page}`;
        })
      ),
      refresh: Driver.Refresh((ctx) =>
        Effect.gen(function* () {
          counts.refreshes += 1;
          yield* ctx.setResult(`page-${ctx.args.page}`);
        })
      ),
    });
  }

  return { PageNode: KeyedPageNode, counts };
}

// A refresh waits for `release` after `hold`, or for `releasePage(page)` after
// `holdPage(page)`, then fails while `failing` is set.
function makeGatedPageNode(tag: string) {
  const counts: Counts = { acquires: 0, refreshes: 0 };
  const control = {
    failing: true,
    gate: Promise.resolve(),
    release: () => {},
    hold: () => {
      control.gate = new Promise<void>((resolve) => {
        control.release = resolve;
      });
    },
    pageGates: new Map<number, { readonly promise: Promise<void>; readonly release: () => void }>(),
    holdPage: (page: number) => {
      let release = () => {};
      const promise = new Promise<void>((resolve) => {
        release = resolve;
      });
      control.pageGates.set(page, { promise, release });
    },
    releasePage: (page: number) => {
      control.pageGates.get(page)?.release();
    },
  };

  class GatedPageNode extends NodeBase<SingletonPageSpec> {
    static readonly spec = resourceSpec.effect<SingletonPageSpec>({
      tag,
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire((ctx) =>
        Effect.sync(() => {
          counts.acquires += 1;
          return `page-${ctx.args.page}`;
        })
      ),
      refresh: Driver.Refresh((ctx) =>
        Effect.gen(function* () {
          counts.refreshes += 1;
          const gate = control.pageGates.get(ctx.args.page)?.promise ?? control.gate;
          yield* Effect.promise(() => gate);
          if (control.failing) {
            return yield* Effect.fail({ _tag: "RefreshRejected" });
          }
          yield* ctx.setResult(`page-${ctx.args.page}`);
        })
      ),
    });
  }

  return { PageNode: GatedPageNode, counts, control };
}

type PageNodeInstance = { readonly args: PageArgs; readonly result: string };

const label = (prefix: string, node: PageNodeInstance): string =>
  `${prefix}${node.args.page}:${node.result}`;

async function startedRuntime(): Promise<RuntimeInstance> {
  const runtime = createRuntime();
  await runtime.submit({ _tag: "RuntimeStart" });
  return runtime;
}

function tree(runtime: RuntimeInstance, children: ReactNode, strict = false): ReactNode {
  const provided = createElement(
    FrondProvider,
    { runtime },
    createElement(Suspense, { fallback: createElement("span", undefined, "loading") }, children)
  );
  return strict ? createElement(StrictMode, undefined, provided) : provided;
}

async function argsUpdatesStarted(runtime: RuntimeInstance): Promise<number> {
  return (await runtime.query({ _tag: "RuntimeEvents" })).events.filter(
    (record) => record.event._tag === "GraphNodeArgsUpdateStarted"
  ).length;
}

async function flush(rounds = 5): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function storedArgs(runtime: RuntimeInstance, spec: unknown, args: PageArgs): unknown {
  const read = runtime.client.node<PageArgs, string>(spec, args).read();
  return read._tag === "Ready" ? (read.node as unknown as PageNodeInstance).args : read._tag;
}

type PageReader = (props: { readonly page: number; readonly name?: string }) => ReactNode;

function readers(spec: object): ReadonlyArray<readonly [string, PageReader]> {
  const Spec = spec as never;
  return [
    [
      "useNodeRead",
      ({ page, name = "" }) => {
        const read = useNodeRead(Spec, { page } as never) as {
          readonly _tag: string;
          readonly node?: PageNodeInstance;
        };
        return createElement(
          "output",
          undefined,
          read._tag === "Ready" && read.node !== undefined ? label(name, read.node) : read._tag
        );
      },
    ],
    [
      "useNode",
      ({ page, name = "" }) => {
        const node = useNode(Spec, { page } as never) as unknown as PageNodeInstance;
        return createElement("output", undefined, label(name, node));
      },
    ],
    [
      "useNodeState",
      ({ page, name = "" }) => {
        const state = useNodeState(Spec, { page } as never) as unknown as {
          readonly node: PageNodeInstance;
        };
        return createElement("output", undefined, label(name, state.node));
      },
    ],
    [
      "useNodes",
      ({ page, name = "" }) => {
        const nodes = useNodes({ only: [Spec, { page }] } as never) as unknown as {
          readonly only: PageNodeInstance;
        };
        return createElement("output", undefined, label(name, nodes.only));
      },
    ],
  ];
}

describe("React readers align a ready node's args on mount", () => {
  for (const [hook] of readers({})) {
    test(`${hook} mounting with other args moves a node acquired with page 1 to page 2`, async () => {
      const { PageNode, counts } = makeSingletonPageNode(`react-mount-args/pre-acquired/${hook}`);
      const Reader = new Map(readers(PageNode)).get(hook) as PageReader;
      const runtime = await startedRuntime();
      await runtime.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();

      const view = render(tree(runtime, createElement(Reader, { page: 2 })));

      expect(await view.findByText("2:page-2")).toBeTruthy();
      expect(storedArgs(runtime, PageNode, { page: 2 })).toEqual({ page: 2 });
      await flush();
      expect(counts.refreshes).toBe(1);
      expect(await argsUpdatesStarted(runtime)).toBe(1);
    });
  }

  test("a StrictMode mount with other args aligns the node with one refresh", async () => {
    const { PageNode, counts } = makeSingletonPageNode("react-mount-args/strict-mode");
    const Reader = new Map(readers(PageNode)).get("useNodeRead") as PageReader;
    const runtime = await startedRuntime();
    await runtime.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();

    const view = render(tree(runtime, createElement(Reader, { page: 2 }), true));

    expect(await view.findByText("2:page-2")).toBeTruthy();
    await flush();
    expect(counts.refreshes).toBe(1);
    expect(await argsUpdatesStarted(runtime)).toBe(1);
  });

  test("changing a mounted reader's args from page 1 to page 2 refreshes once", async () => {
    const { PageNode, counts } = makeSingletonPageNode("react-mount-args/prop-change");
    const Reader = new Map(readers(PageNode)).get("useNodeState") as PageReader;
    const runtime = await startedRuntime();

    const view = render(tree(runtime, createElement(Reader, { page: 1 })));
    expect(await view.findByText("1:page-1")).toBeTruthy();
    await flush();
    expect(counts.refreshes).toBe(0);

    view.rerender(tree(runtime, createElement(Reader, { page: 2 })));

    expect(await view.findByText("2:page-2")).toBeTruthy();
    await flush();
    expect(storedArgs(runtime, PageNode, { page: 2 })).toEqual({ page: 2 });
    expect(counts.refreshes).toBe(1);
    expect(await argsUpdatesStarted(runtime)).toBe(1);
  });

  test("a later reader with other args wins and neither reader keeps re-fetching", async () => {
    const { PageNode, counts } = makeSingletonPageNode("react-mount-args/two-readers");
    const readerByHook = new Map(readers(PageNode));
    const ReaderA = readerByHook.get("useNodeRead") as PageReader;
    const ReaderB = readerByHook.get("useNode") as PageReader;
    const runtime = await startedRuntime();
    const both = (withB: boolean) =>
      tree(
        runtime,
        createElement(
          "div",
          undefined,
          createElement(ReaderA, { page: 1, name: "A:" }),
          withB ? createElement(ReaderB, { page: 2, name: "B:" }) : null
        )
      );

    const view = render(both(false));
    expect(await view.findByText("A:1:page-1")).toBeTruthy();

    view.rerender(both(true));

    expect(await view.findByText("A:2:page-2")).toBeTruthy();
    expect(await view.findByText("B:2:page-2")).toBeTruthy();
    await flush();
    const settledRefreshes = counts.refreshes;
    const settledUpdates = await argsUpdatesStarted(runtime);
    expect(settledRefreshes).toBe(1);
    expect(settledUpdates).toBe(1);

    for (let round = 0; round < 3; round += 1) {
      view.rerender(both(true));
      await flush();
    }

    expect(counts.refreshes).toBe(settledRefreshes);
    expect(await argsUpdatesStarted(runtime)).toBe(settledUpdates);
    expect(storedArgs(runtime, PageNode, { page: 2 })).toEqual({ page: 2 });
    expect(view.getByText("A:2:page-2")).toBeTruthy();
    expect(view.getByText("B:2:page-2")).toBeTruthy();
  });

  test("readers mounting together with the same other args align the node", async () => {
    const { PageNode, counts } = makeSingletonPageNode("react-mount-args/joint-mount");
    const readerByHook = new Map(readers(PageNode));
    const ReaderA = readerByHook.get("useNodeRead") as PageReader;
    const ReaderB = readerByHook.get("useNodeState") as PageReader;
    const runtime = await startedRuntime();
    await runtime.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();

    const view = render(
      tree(
        runtime,
        createElement(
          "div",
          undefined,
          createElement(ReaderA, { page: 2, name: "A:" }),
          createElement(ReaderB, { page: 2, name: "B:" })
        )
      )
    );

    expect(await view.findByText("A:2:page-2")).toBeTruthy();
    expect(await view.findByText("B:2:page-2")).toBeTruthy();
    await flush();
    expect(storedArgs(runtime, PageNode, { page: 2 })).toEqual({ page: 2 });
    // The second mount sees the first one's queued page 2 and submits nothing.
    expect(counts.refreshes).toBe(1);
    expect(await argsUpdatesStarted(runtime)).toBe(1);
  });

  for (const strict of [false, true]) {
    test(`the later of two sibling mounts in one commit wins${strict ? " under StrictMode" : ""}`, async () => {
      const { PageNode, counts } = makeSingletonPageNode(
        `react-mount-args/one-commit-siblings/${strict}`
      );
      const readerByHook = new Map(readers(PageNode));
      const ReaderB = readerByHook.get("useNode") as PageReader;
      const ReaderA = readerByHook.get("useNodeRead") as PageReader;
      const runtime = await startedRuntime();
      await runtime.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();

      const view = render(
        tree(
          runtime,
          createElement(
            "div",
            undefined,
            createElement(ReaderB, { page: 2, name: "B:" }),
            createElement(ReaderA, { page: 1, name: "A:" })
          ),
          strict
        )
      );
      await flush();

      expect(await view.findByText("A:1:page-1")).toBeTruthy();
      expect(await view.findByText("B:1:page-1")).toBeTruthy();
      expect(storedArgs(runtime, PageNode, { page: 1 })).toEqual({ page: 1 });
      expect(counts.refreshes).toBe(2);
      expect(await argsUpdatesStarted(runtime)).toBe(2);
    });
  }

  test("a parent mounting in the same commit as its child wins, since its effect runs last", async () => {
    const { PageNode, counts } = makeSingletonPageNode("react-mount-args/one-commit-parent");
    const Child = new Map(readers(PageNode)).get("useNodeRead") as PageReader;
    const Parent = ({ children }: { readonly children: ReactNode }) => {
      const read = useNodeRead(PageNode as never, { page: 1 } as never) as {
        readonly _tag: string;
        readonly node?: PageNodeInstance;
      };
      return createElement(
        "div",
        undefined,
        createElement(
          "output",
          undefined,
          read._tag === "Ready" && read.node !== undefined ? label("P:", read.node) : read._tag
        ),
        children
      );
    };
    const runtime = await startedRuntime();
    await runtime.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();

    const view = render(
      tree(runtime, createElement(Parent, undefined, createElement(Child, { page: 2, name: "C:" })))
    );
    await flush();

    expect(await view.findByText("P:1:page-1")).toBeTruthy();
    expect(await view.findByText("C:1:page-1")).toBeTruthy();
    expect(storedArgs(runtime, PageNode, { page: 1 })).toEqual({ page: 1 });
    expect(counts.refreshes).toBe(2);
  });

  test("a failed alignment keeps the stored args and a change back to them submits nothing", async () => {
    const { PageNode, counts } = makeSingletonPageNode("react-mount-args/failed-alignment", 2);
    const Reader = new Map(readers(PageNode)).get("useNodeRead") as PageReader;
    const runtime = await startedRuntime();
    await runtime.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();

    const view = render(tree(runtime, createElement(Reader, { page: 2 })));
    await flush();
    expect(counts.refreshes).toBe(1);
    expect(await view.findByText("1:page-1")).toBeTruthy();
    expect(storedArgs(runtime, PageNode, { page: 2 })).toEqual({ page: 1 });

    view.rerender(tree(runtime, createElement(Reader, { page: 1 })));
    await flush();

    expect(counts.refreshes).toBe(1);
    expect(await argsUpdatesStarted(runtime)).toBe(1);
    expect(view.getByText("1:page-1")).toBeTruthy();
  });

  test("an Activity reveal does not align the node again", async () => {
    const { PageNode, counts } = makeSingletonPageNode("react-mount-args/activity");
    const Reader = new Map(readers(PageNode)).get("useNodeRead") as PageReader;
    const runtime = await startedRuntime();
    const handle = runtime.client.node<PageArgs, string>(PageNode, { page: 1 });
    await handle.ensureReady();
    const shown = (mode: "visible" | "hidden") =>
      tree(runtime, createElement(Activity, { mode }, createElement(Reader, { page: 2 })));

    const view = render(shown("visible"));
    expect(await view.findByText("2:page-2")).toBeTruthy();
    await flush();
    expect(counts.refreshes).toBe(1);

    view.rerender(shown("hidden"));
    await flush();
    await act(async () => {
      await handle.updateArgs({ page: 3 });
    });
    expect(counts.refreshes).toBe(2);

    view.rerender(shown("visible"));
    await flush();

    expect(counts.refreshes).toBe(2);
    expect(storedArgs(runtime, PageNode, { page: 3 })).toEqual({ page: 3 });
    expect(await view.findByText("3:page-3")).toBeTruthy();
  });

  for (const hook of ["useNodeRead", "useNodes"] as const) {
    test(`${hook} hidden by Activity submits the args it changed to on reveal`, async () => {
      const { PageNode, counts } = makeSingletonPageNode(
        `react-mount-args/activity-hidden-${hook}`
      );
      const Reader = new Map(readers(PageNode)).get(hook) as PageReader;
      const runtime = await startedRuntime();
      const shown = (mode: "visible" | "hidden", page: number) =>
        tree(runtime, createElement(Activity, { mode }, createElement(Reader, { page })));

      const view = render(shown("visible", 1));
      expect(await view.findByText("1:page-1")).toBeTruthy();
      await flush();
      expect(counts.refreshes).toBe(0);

      view.rerender(shown("hidden", 1));
      await flush();
      view.rerender(shown("hidden", 2));
      await flush();
      expect(counts.refreshes).toBe(0);

      view.rerender(shown("visible", 2));
      await flush();

      expect(counts.refreshes).toBe(1);
      expect(storedArgs(runtime, PageNode, { page: 2 })).toEqual({ page: 2 });
      expect(await view.findByText("2:page-2")).toBeTruthy();
    });
  }

  for (const hook of ["useNodeRead", "useNodes"] as const) {
    test(`${hook} hidden while a matching update from outside React runs keeps a newer writer's args on reveal`, async () => {
      const { PageNode, counts, control } = makeGatedPageNode(
        `react-mount-args/activity-outside-match-${hook}`
      );
      const Reader = new Map(readers(PageNode)).get(hook) as PageReader;
      const runtime = await startedRuntime();
      const handle = runtime.client.node<PageArgs, string>(PageNode, { page: 1 });
      const shown = (mode: "visible" | "hidden", page: number) =>
        tree(runtime, createElement(Activity, { mode }, createElement(Reader, { page })));

      const view = render(shown("visible", 1));
      expect(await view.findByText("1:page-1")).toBeTruthy();
      view.rerender(shown("visible", 2));
      await flush();
      expect(counts.refreshes).toBe(1);
      expect(storedArgs(runtime, PageNode, { page: 1 })).toEqual({ page: 1 });

      // The reader changes to the page an update from outside React is bringing.
      control.failing = false;
      control.holdPage(3);
      const outside = handle.updateArgs({ page: 3 });
      await flush();
      view.rerender(shown("visible", 3));
      await flush();
      expect(counts.refreshes).toBe(2);

      // While the reader is hidden, that update succeeds and another writer
      // moves the node on to page 4.
      view.rerender(shown("hidden", 3));
      await flush();
      await act(async () => {
        control.releasePage(3);
        await outside;
      });
      await act(async () => {
        await handle.updateArgs({ page: 4 });
      });
      expect(counts.refreshes).toBe(3);

      view.rerender(shown("visible", 3));
      await flush();

      expect(counts.refreshes).toBe(3);
      expect(storedArgs(runtime, PageNode, { page: 4 })).toEqual({ page: 4 });
    });
  }

  for (const hook of ["useNodeRead", "useNodes"] as const) {
    for (const later of ["failed", "running"] as const) {
      test(`${hook} hidden during its match does not take a ${later} operation of the node acquired again for it`, async () => {
        const { PageNode, control } = makeGatedPageNode(
          `react-mount-args/activity-incarnation-${hook}-${later}`
        );
        // The useNodes reader does not read its node: after an eviction while
        // hidden, useNodes hands back the closed node until it is revealed.
        const Reader: PageReader =
          hook === "useNodeRead"
            ? (new Map(readers(PageNode)).get(hook) as PageReader)
            : ({ page }) => {
                useNodes({ only: [PageNode, { page }] } as never);
                return createElement("output", undefined, "nodes");
              };
        // A fixed clock gives the operations of both incarnations one start time.
        const runtime = createRuntime({ syncClock: { now: () => 0 } });
        await runtime.submit({ _tag: "RuntimeStart" });
        const handle = runtime.client.node<PageArgs, string>(PageNode, { page: 1 });
        const shown = (mode: "visible" | "hidden", page: number) =>
          tree(runtime, createElement(Activity, { mode }, createElement(Reader, { page })));

        const view = render(shown("visible", 1));
        expect(await view.findByText(hook === "useNodeRead" ? "1:page-1" : "nodes")).toBeTruthy();
        view.rerender(shown("visible", 2));
        await flush();
        expect(storedArgs(runtime, PageNode, { page: 1 })).toEqual({ page: 1 });

        // The reader matches an update from outside React to page 3, which
        // succeeds while the reader is hidden.
        control.failing = false;
        control.holdPage(3);
        const outside = handle.updateArgs({ page: 3 });
        await flush();
        view.rerender(shown("visible", 3));
        await flush();
        view.rerender(shown("hidden", 3));
        await flush();
        await act(async () => {
          control.releasePage(3);
          await outside;
        });
        expect(storedArgs(runtime, PageNode, { page: 3 })).toEqual({ page: 3 });

        // The node is evicted and acquired again on page 4, where the second
        // operation, numbered like the matched one, fails or still runs.
        const fresh = runtime.client.node<PageArgs, string>(PageNode, { page: 4 });
        await act(async () => {
          await handle.evict();
          await fresh.ensureReady();
          await fresh.refresh();
        });
        control.failing = later === "failed";
        control.holdPage(5);
        if (later === "failed") {
          control.releasePage(5);
        }
        const laterUpdate = fresh.updateArgs({ page: 5 });
        await flush();
        if (later === "failed") {
          await act(async () => {
            await laterUpdate;
          });
        }
        const started = await argsUpdatesStarted(runtime);

        view.rerender(shown("visible", 3));
        await flush();

        expect(await argsUpdatesStarted(runtime)).toBe(started);
        await act(async () => {
          control.releasePage(5);
          await laterUpdate;
        });
        await flush();
        expect(storedArgs(runtime, PageNode, { page: 1 })).toEqual({
          page: later === "failed" ? 4 : 5,
        });
      });
    }
  }

  test("a reader whose args equal the stored args refreshes nothing on mount", async () => {
    const { PageNode, counts } = makeSingletonPageNode("react-mount-args/equal-args");
    const runtime = await startedRuntime();
    await runtime.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();

    for (const [, Reader] of readers(PageNode)) {
      // A fresh literal each mount: the comparison is by value, not by reference.
      const view = render(tree(runtime, createElement(Reader, { page: 1 })));
      expect(await view.findByText("1:page-1")).toBeTruthy();
      await flush();
      view.unmount();
    }

    expect(counts.refreshes).toBe(0);
    expect(await argsUpdatesStarted(runtime)).toBe(0);
  });
});

describe("after a failed update a reader compares its next args with the node's", () => {
  for (const path of ["mount", "prop change"] as const) {
    test(`after a ${path} update and a prop change both fail, a change to other args resubmits`, async () => {
      const { PageNode, counts, control } = makeGatedPageNode(
        `react-mount-args/failed-rollback/${path.replace(" ", "-")}`
      );
      const Reader = new Map(readers(PageNode)).get("useNodeRead") as PageReader;
      const runtime = await startedRuntime();
      const show = (page: number) => tree(runtime, createElement(Reader, { page }));
      let view: ReturnType<typeof render>;

      if (path === "mount") {
        await runtime.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();
        control.hold();
        view = render(show(2));
      } else {
        view = render(show(1));
        expect(await view.findByText("1:page-1")).toBeTruthy();
        control.hold();
        view.rerender(show(2));
      }
      await flush();
      view.rerender(show(3));
      await flush();
      await act(async () => {
        control.release();
      });
      await flush();

      expect(storedArgs(runtime, PageNode, { page: 1 })).toEqual({ page: 1 });
      expect(counts.refreshes).toBe(2);
      expect(await argsUpdatesStarted(runtime)).toBe(2);

      control.failing = false;
      view.rerender(show(2));
      await flush();

      expect(await argsUpdatesStarted(runtime)).toBe(3);
      expect(storedArgs(runtime, PageNode, { page: 2 })).toEqual({ page: 2 });
      expect(await view.findByText("2:page-2")).toBeTruthy();
    });
  }

  test("a failure that lands while another request's update runs does not take its args as the node's", async () => {
    const { PageNode, counts, control } = makeGatedPageNode("react-mount-args/failed-two-writers");
    const Reader = new Map(readers(PageNode)).get("useNodeRead") as PageReader;
    const runtime = await startedRuntime();
    const show = (page: number) => tree(runtime, createElement(Reader, { page }));

    const view = render(show(1));
    expect(await view.findByText("1:page-1")).toBeTruthy();
    control.holdPage(2);
    control.holdPage(3);
    view.rerender(show(2));
    await flush();
    const outside = runtime.client.node<PageArgs, string>(PageNode, { page: 3 }).updateArgs({
      page: 3,
    });
    await flush();

    await act(async () => {
      control.releasePage(2);
    });
    await flush();
    // The reader's page 2 failed while the outside page 3 is running.
    expect(storedArgs(runtime, PageNode, { page: 3 })).toEqual({ page: 3 });

    await act(async () => {
      control.releasePage(3);
      await outside;
    });
    await flush();
    expect(storedArgs(runtime, PageNode, { page: 1 })).toEqual({ page: 1 });
    expect(counts.refreshes).toBe(2);

    control.failing = false;
    view.rerender(show(3));
    await flush();

    expect(counts.refreshes).toBe(3);
    expect(storedArgs(runtime, PageNode, { page: 3 })).toEqual({ page: 3 });
    expect(await view.findByText("3:page-3")).toBeTruthy();
  });
});

describe("a reader moved to another runtime aligns the node there", () => {
  for (const hook of ["useNodes", "useNodeRead"]) {
    test(`${hook} aligns a node another runtime holds on other args`, async () => {
      const { PageNode } = makeSingletonPageNode(`react-mount-args/runtime-swap/${hook}`);
      const Reader = new Map(readers(PageNode)).get(hook) as PageReader;
      const first = await startedRuntime();
      const second = await startedRuntime();
      await second.client.node<PageArgs, string>(PageNode, { page: 1 }).ensureReady();

      const view = render(tree(first, createElement(Reader, { page: 2 })));
      expect(await view.findByText("2:page-2")).toBeTruthy();

      view.rerender(tree(second, createElement(Reader, { page: 2 })));
      await flush();

      expect(await view.findByText("2:page-2")).toBeTruthy();
      expect(storedArgs(second, PageNode, { page: 2 })).toEqual({ page: 2 });
    });
  }
});

describe("useNodes reconciles only the entries whose own args changed", () => {
  test("a same-key change of one entry does not re-submit its sibling", async () => {
    const left = makeSingletonPageNode("react-mount-args/nodes-left");
    const right = makeSingletonPageNode("react-mount-args/nodes-right");
    const runtime = await startedRuntime();
    const Pair = ({ leftPage }: { readonly leftPage: number }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page: leftPage }],
        right: [right.PageNode, { page: 1 }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };

    const view = render(tree(runtime, createElement(Pair, { leftPage: 1 })));
    expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();

    // Another request moves the sibling; the useNodes reader keeps its old args.
    await act(async () => {
      await runtime.client.node<PageArgs, string>(right.PageNode, { page: 3 }).updateArgs({
        page: 3,
      });
    });
    expect(await view.findByText("1:page-1|3:page-3")).toBeTruthy();
    expect(right.counts.refreshes).toBe(1);

    view.rerender(tree(runtime, createElement(Pair, { leftPage: 2 })));

    expect(await view.findByText("2:page-2|3:page-3")).toBeTruthy();
    await flush();
    expect(left.counts.refreshes).toBe(1);
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 3 });
  });

  test("an entry whose args change in the commit that rebuilds its store for a sibling's key submits them", async () => {
    const left = makeKeyedPageNode("react-mount-args/nodes-rebuild-left");
    const right = makeSingletonPageNode("react-mount-args/nodes-rebuild-right");
    const runtime = await startedRuntime();
    const Pair = ({ page }: { readonly page: number }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page }],
        right: [right.PageNode, { page }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };

    const view = render(tree(runtime, createElement(Pair, { page: 1 })));
    expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();

    view.rerender(tree(runtime, createElement(Pair, { page: 2 })));

    expect(await view.findByText("2:page-2|2:page-2")).toBeTruthy();
    await flush();
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 2 })).toEqual({ page: 2 });
  });

  test("an entry whose own change failed retries it when a sibling changes", async () => {
    const left = makeSingletonPageNode("react-mount-args/nodes-retry-left");
    const right = makeGatedPageNode("react-mount-args/nodes-retry-right");
    const runtime = await startedRuntime();
    const Pair = ({
      leftPage,
      rightPage,
    }: {
      readonly leftPage: number;
      readonly rightPage: number;
    }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page: leftPage }],
        right: [right.PageNode, { page: rightPage }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };
    const show = (leftPage: number, rightPage: number) =>
      tree(runtime, createElement(Pair, { leftPage, rightPage }));

    const view = render(show(1, 1));
    expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();

    view.rerender(show(1, 2));
    await flush();
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });

    right.control.failing = false;
    view.rerender(show(2, 2));

    expect(await view.findByText("2:page-2|2:page-2")).toBeTruthy();
    await flush();
    expect(right.counts.refreshes).toBe(2);
    expect(storedArgs(runtime, right.PageNode, { page: 2 })).toEqual({ page: 2 });
  });

  test("a key change of a sibling drops the retry of an entry's failed change", async () => {
    const left = makeKeyedPageNode("react-mount-args/nodes-no-retry-left");
    const right = makeGatedPageNode("react-mount-args/nodes-no-retry-right");
    const runtime = await startedRuntime();
    const Pair = ({
      leftPage,
      rightPage,
    }: {
      readonly leftPage: number;
      readonly rightPage: number;
    }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page: leftPage }],
        right: [right.PageNode, { page: rightPage }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };
    const show = (leftPage: number, rightPage: number) =>
      tree(runtime, createElement(Pair, { leftPage, rightPage }));

    const view = render(show(1, 1));
    expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();

    view.rerender(show(1, 2));
    await flush();
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });

    right.control.failing = false;
    view.rerender(show(2, 2));

    // A new left key rebuilds every child store; the rebuilt right store
    // starts on its own page 2 and has nothing to retry.
    expect(await view.findByText("2:page-2|1:page-1")).toBeTruthy();
    await flush();
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });
  });

  for (const writer of ["useNodeRead", "updateArgs"] as const) {
    test(`an entry keeps the retry of its failed change when a ${writer} request for the same args fails too`, async () => {
      const left = makeSingletonPageNode(`react-mount-args/nodes-shared-retry-left-${writer}`);
      const right = makeGatedPageNode(`react-mount-args/nodes-shared-retry-right-${writer}`);
      const Reader = new Map(readers(right.PageNode)).get("useNodeRead") as PageReader;
      const runtime = await startedRuntime();
      const Pair = ({
        leftPage,
        rightPage,
      }: {
        readonly leftPage: number;
        readonly rightPage: number;
      }) => {
        const nodes = useNodes({
          left: [left.PageNode, { page: leftPage }],
          right: [right.PageNode, { page: rightPage }],
        }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
        return createElement(
          "output",
          undefined,
          `${label("", nodes.left)}|${label("", nodes.right)}`
        );
      };
      const show = (leftPage: number, rightPage: number, writerPage?: number) =>
        tree(runtime, [
          createElement(Pair, { key: "pair", leftPage, rightPage }),
          writerPage === undefined
            ? null
            : createElement(Reader, { key: "writer", page: writerPage }),
        ]);

      const view = render(show(1, 1));
      expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();

      view.rerender(show(1, 2));
      await flush();
      expect(right.counts.refreshes).toBe(1);
      expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });

      // Another writer starts a request for the same page 2 and holds it.
      right.control.holdPage(2);
      const writerPage = writer === "useNodeRead" ? 2 : undefined;
      const outside =
        writer === "updateArgs"
          ? runtime.client.node<PageArgs, string>(right.PageNode, { page: 2 }).updateArgs({
              page: 2,
            })
          : undefined;
      view.rerender(show(1, 2, writerPage));
      await flush();
      expect(right.counts.refreshes).toBe(2);

      // The sibling changes while that request runs, then the request fails.
      view.rerender(show(2, 2, writerPage));
      await flush();
      expect(left.counts.refreshes).toBe(1);
      await act(async () => {
        right.control.releasePage(2);
        await outside;
      });
      await flush();
      expect(right.counts.refreshes).toBe(2);
      expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });

      right.control.failing = false;
      view.rerender(show(3, 2, writerPage));
      await flush();

      expect(right.counts.refreshes).toBe(3);
      expect(storedArgs(runtime, right.PageNode, { page: 2 })).toEqual({ page: 2 });
    });
  }

  test("an earlier queued change that fails does not undo an entry's later change", async () => {
    const left = makeSingletonPageNode("react-mount-args/nodes-ownership-left");
    const right = makeGatedPageNode("react-mount-args/nodes-ownership-right");
    const runtime = await startedRuntime();
    const Pair = ({
      leftPage,
      rightPage,
    }: {
      readonly leftPage: number;
      readonly rightPage: number;
    }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page: leftPage }],
        right: [right.PageNode, { page: rightPage }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };
    const show = (leftPage: number, rightPage: number) =>
      tree(runtime, createElement(Pair, { leftPage, rightPage }));

    const view = render(show(1, 1));
    expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();

    // Queue page 2, page 3, then page 2 again behind the first.
    right.control.holdPage(2);
    right.control.holdPage(3);
    for (const page of [2, 3, 2]) {
      view.rerender(show(1, page));
      await flush();
    }
    expect(right.counts.refreshes).toBe(1);

    // The first page 2 fails; page 3 and the second page 2 succeed.
    await act(async () => {
      right.control.releasePage(2);
    });
    await flush();
    expect(right.counts.refreshes).toBe(2);
    right.control.failing = false;
    await act(async () => {
      right.control.releasePage(3);
    });
    await flush();
    expect(right.counts.refreshes).toBe(3);
    expect(storedArgs(runtime, right.PageNode, { page: 2 })).toEqual({ page: 2 });

    await act(async () => {
      await runtime.client.node<PageArgs, string>(right.PageNode, { page: 4 }).updateArgs({
        page: 4,
      });
    });
    expect(right.counts.refreshes).toBe(4);

    // The right entry's own args have not changed since its last request.
    view.rerender(show(2, 2));
    await flush();

    expect(left.counts.refreshes).toBe(1);
    expect(right.counts.refreshes).toBe(4);
    expect(storedArgs(runtime, right.PageNode, { page: 4 })).toEqual({ page: 4 });
  });

  test("an entry mounting onto a reader's pending request for its args keeps them as its own", async () => {
    const left = makeSingletonPageNode("react-mount-args/nodes-joint-mount-left");
    const right = makeSingletonPageNode("react-mount-args/nodes-joint-mount-right");
    const Reader = new Map(readers(right.PageNode)).get("useNodeRead") as PageReader;
    const runtime = await startedRuntime();
    await runtime.client.node<PageArgs, string>(right.PageNode, { page: 1 }).ensureReady();
    const Pair = ({ leftPage }: { readonly leftPage: number }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page: leftPage }],
        right: [right.PageNode, { page: 2 }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };
    // The reader's effect runs first and submits page 2; the entry mounts onto it.
    const show = (leftPage: number) =>
      tree(runtime, [
        createElement(Reader, { key: "reader", page: 2, name: "reader-" }),
        createElement(Pair, { key: "pair", leftPage }),
      ]);

    const view = render(show(1));
    await flush();
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 2 })).toEqual({ page: 2 });

    await act(async () => {
      await runtime.client.node<PageArgs, string>(right.PageNode, { page: 4 }).updateArgs({
        page: 4,
      });
    });
    expect(right.counts.refreshes).toBe(2);

    view.rerender(show(2));
    await flush();

    expect(left.counts.refreshes).toBe(1);
    expect(right.counts.refreshes).toBe(2);
    expect(storedArgs(runtime, right.PageNode, { page: 4 })).toEqual({ page: 4 });
  });

  test("a change that matches the node while an unrelated refresh runs takes its args as the node's", async () => {
    const left = makeSingletonPageNode("react-mount-args/nodes-busy-refresh-left");
    const right = makeGatedPageNode("react-mount-args/nodes-busy-refresh-right");
    const runtime = await startedRuntime();
    const Pair = ({
      leftPage,
      rightPage,
    }: {
      readonly leftPage: number;
      readonly rightPage: number;
    }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page: leftPage }],
        right: [right.PageNode, { page: rightPage }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };
    const show = (leftPage: number, rightPage: number) =>
      tree(runtime, createElement(Pair, { leftPage, rightPage }));
    const handle = runtime.client.node<PageArgs, string>(right.PageNode, { page: 1 });

    const view = render(show(1, 1));
    expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();
    view.rerender(show(1, 2));
    await flush();
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });

    // A refresh, not an args update, runs on page 1 while the entry changes back to it.
    right.control.failing = false;
    right.control.holdPage(1);
    const refresh = handle.refresh();
    await flush();
    expect(right.counts.refreshes).toBe(2);
    view.rerender(show(1, 1));
    await flush();
    await act(async () => {
      right.control.releasePage(1);
      await refresh;
    });
    await flush();
    expect(right.counts.refreshes).toBe(2);

    await act(async () => {
      await handle.updateArgs({ page: 4 });
    });
    expect(right.counts.refreshes).toBe(3);

    view.rerender(show(2, 1));
    await flush();

    expect(left.counts.refreshes).toBe(1);
    expect(right.counts.refreshes).toBe(3);
    expect(storedArgs(runtime, right.PageNode, { page: 4 })).toEqual({ page: 4 });
  });

  for (const writer of ["useNodeRead", "updateArgs"] as const) {
    test(`an entry takes its args as the node's once a matching ${writer} request succeeds`, async () => {
      const left = makeSingletonPageNode(`react-mount-args/nodes-shared-success-left-${writer}`);
      const right = makeGatedPageNode(`react-mount-args/nodes-shared-success-right-${writer}`);
      const Reader = new Map(readers(right.PageNode)).get("useNodeRead") as PageReader;
      const runtime = await startedRuntime();
      const Pair = ({
        leftPage,
        rightPage,
      }: {
        readonly leftPage: number;
        readonly rightPage: number;
      }) => {
        const nodes = useNodes({
          left: [left.PageNode, { page: leftPage }],
          right: [right.PageNode, { page: rightPage }],
        }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
        return createElement(
          "output",
          undefined,
          `${label("", nodes.left)}|${label("", nodes.right)}`
        );
      };
      const show = (leftPage: number, rightPage: number, writerPage?: number) =>
        tree(runtime, [
          createElement(Pair, { key: "pair", leftPage, rightPage }),
          writerPage === undefined
            ? null
            : createElement(Reader, { key: "writer", page: writerPage }),
        ]);
      const handle = runtime.client.node<PageArgs, string>(right.PageNode, { page: 1 });

      const view = render(show(1, 1));
      expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();
      view.rerender(show(1, 2));
      await flush();
      expect(right.counts.refreshes).toBe(1);
      expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });

      // Another writer starts a request for the same page 2 and holds it.
      right.control.failing = false;
      right.control.holdPage(2);
      const writerPage = writer === "useNodeRead" ? 2 : undefined;
      const outside = writer === "updateArgs" ? handle.updateArgs({ page: 2 }) : undefined;
      view.rerender(show(1, 2, writerPage));
      await flush();
      expect(right.counts.refreshes).toBe(2);

      // The sibling changes while that request runs, then the request succeeds.
      view.rerender(show(2, 2, writerPage));
      await flush();
      await act(async () => {
        right.control.releasePage(2);
        await outside;
      });
      await flush();
      expect(right.counts.refreshes).toBe(2);
      expect(storedArgs(runtime, right.PageNode, { page: 2 })).toEqual({ page: 2 });

      // The writer moves the node on to page 4.
      if (writer === "useNodeRead") {
        view.rerender(show(2, 2, 4));
        await flush();
      } else {
        await act(async () => {
          await handle.updateArgs({ page: 4 });
        });
      }
      expect(right.counts.refreshes).toBe(3);

      view.rerender(show(3, 2, writer === "useNodeRead" ? 4 : undefined));
      await flush();

      expect(left.counts.refreshes).toBe(2);
      expect(right.counts.refreshes).toBe(3);
      expect(storedArgs(runtime, right.PageNode, { page: 4 })).toEqual({ page: 4 });
    });
  }

  test("an entry whose matched update from outside React an eviction cancels retries its args when a sibling changes", async () => {
    const left = makeSingletonPageNode("react-mount-args/nodes-evicted-match-left");
    const right = makeGatedPageNode("react-mount-args/nodes-evicted-match-right");
    const runtime = await startedRuntime();
    const Pair = ({
      leftPage,
      rightPage,
    }: {
      readonly leftPage: number;
      readonly rightPage: number;
    }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page: leftPage }],
        right: [right.PageNode, { page: rightPage }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };
    const show = (leftPage: number, rightPage: number) =>
      tree(runtime, createElement(Pair, { leftPage, rightPage }));
    const handle = runtime.client.node<PageArgs, string>(right.PageNode, { page: 1 });

    const view = render(show(1, 1));
    expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();
    view.rerender(show(1, 2));
    await flush();
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });

    // The entry changes to the page an update from outside React is bringing.
    right.control.failing = false;
    right.control.holdPage(3);
    const outside = handle.updateArgs({ page: 3 });
    await flush();
    view.rerender(show(1, 3));
    await flush();
    expect(right.counts.refreshes).toBe(2);

    // An eviction cancels that update and the node is acquired again.
    await act(async () => {
      await handle.evict();
    });
    expect((await outside)._tag).toBe("Failure");
    right.control.releasePage(3);
    await flush();
    expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 1 });

    view.rerender(show(2, 3));
    await flush();

    expect(storedArgs(runtime, right.PageNode, { page: 3 })).toEqual({ page: 3 });
  });

  test("a key change of one entry does not re-submit its sibling", async () => {
    const left = makeKeyedPageNode("react-mount-args/nodes-keyed-left");
    const right = makeSingletonPageNode("react-mount-args/nodes-keyed-right");
    const runtime = await startedRuntime();
    const Pair = ({ leftPage }: { readonly leftPage: number }) => {
      const nodes = useNodes({
        left: [left.PageNode, { page: leftPage }],
        right: [right.PageNode, { page: 1 }],
      }) as unknown as { readonly left: PageNodeInstance; readonly right: PageNodeInstance };
      return createElement(
        "output",
        undefined,
        `${label("", nodes.left)}|${label("", nodes.right)}`
      );
    };

    const view = render(tree(runtime, createElement(Pair, { leftPage: 1 })));
    expect(await view.findByText("1:page-1|1:page-1")).toBeTruthy();

    await act(async () => {
      await runtime.client.node<PageArgs, string>(right.PageNode, { page: 3 }).updateArgs({
        page: 3,
      });
    });
    expect(await view.findByText("1:page-1|3:page-3")).toBeTruthy();
    expect(right.counts.refreshes).toBe(1);

    // A new left key rebuilds the composite store; the unchanged right entry stays put.
    view.rerender(tree(runtime, createElement(Pair, { leftPage: 2 })));

    expect(await view.findByText("2:page-2|3:page-3")).toBeTruthy();
    await flush();
    expect(left.counts.acquires).toBe(2);
    expect(left.counts.refreshes).toBe(0);
    expect(right.counts.refreshes).toBe(1);
    expect(storedArgs(runtime, right.PageNode, { page: 1 })).toEqual({ page: 3 });
  });
});
