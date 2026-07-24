// Do NOT `import "./setup"` here: bun evaluates a shared module once and scopes
// its top-level `afterEach(cleanup)` to the first test file that loads it. This
// file sorts before react-dom.test.tsx, so importing ./setup would steal the
// cleanup hook from that suite and leak DOM between its tests. The equivalent
// registration is inlined below instead.
import { afterEach, describe, expect, test } from "bun:test";
import "global-jsdom/register";
import {
  createRuntime,
  createRuntimeClient,
  Driver,
  dependencies,
  Graph,
  Key,
  NodeBase,
  type NodeSpec,
  type Runtime,
  type RuntimeInstance,
  resourceSpec,
} from "@frondruntime/core";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { Deferred, Effect } from "effect";
import { createElement, StrictMode, useState } from "react";
import { FrondProvider, useNodeRead } from "../src";
import { makeReactNodeStore } from "../src/nodeStore";

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

afterEach(() => {
  cleanup();
});

type Profile = {
  readonly timezone: string;
};

type EmptyArgs = Record<string, never>;

type ProfileSpec<TArgs = EmptyArgs, TKey = Key.Singleton> = NodeSpec<{
  readonly args: TArgs;
  readonly key: TKey;
  readonly deps: Record<string, never>;
  readonly result: Profile;
}>;

/**
 * Renders the non-throwing read union as one stable text label so tests can
 * assert the inline tag transitions with plain text queries.
 */
const readLabel = (read: Runtime.RuntimeNodeRead<Profile>): string => {
  if (read._tag === "Ready") {
    return `Ready:${read.result?.timezone}`;
  }

  if (read._tag === "Error") {
    return `Error:${read.kind}`;
  }

  return read._tag;
};

/**
 * Wraps a fresh runtime so tests can count upstream `observe` subscriptions
 * exactly like the store-level subscription accounting in react-node.test.ts.
 */
function makeSubscriptionCountingRuntime(): {
  readonly runtime: RuntimeInstance;
  readonly counts: { observed: number; unsubscribed: number };
} {
  const base = createRuntime();
  const counts = { observed: 0, unsubscribed: 0 };
  const countingObserve = (observer: Parameters<RuntimeInstance["observe"]>[0]) => {
    counts.observed += 1;
    const subscription = base.observe(observer);

    return {
      unsubscribe: () => {
        counts.unsubscribed += 1;
        subscription.unsubscribe();
      },
    };
  };
  const runtime: RuntimeInstance = {
    ...base,
    client: createRuntimeClient(
      {
        resolveNodeIdSync: base.resolveNodeIdSync,
        getStatusSync: base.getStatusSync,
        readNodeSnapshotSync: base.readNodeSnapshotSync,
        readNodeSnapshot: (nodeId) =>
          Effect.tryPromise({
            try: () => base.readNodeSnapshot(nodeId),
            catch: (error) => error,
          }),
        observe: (observer) => Effect.sync(() => countingObserve(observer)),
        submit: (command) =>
          Effect.tryPromise({ try: () => base.submit(command), catch: (error) => error }),
      } as never,
      {
        run: (effect) => Effect.runPromise(effect),
        runSync: (effect) => Effect.runSync(effect),
      }
    ),
    observe: countingObserve,
  };

  return { runtime, counts };
}

describe("React DOM useNodeRead", () => {
  test("cold mount renders Pending inline and lands Ready without a Suspense boundary", async () => {
    const gate = await Effect.runPromise(Deferred.make<Profile>());

    class ReadColdProfileNode extends NodeBase<ProfileSpec, "effect"> {
      static readonly spec = resourceSpec.effect<ProfileSpec>({
        tag: "react-dom-read/resources/cold-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Deferred.await(gate)),
      });
    }

    const observedTags: string[] = [];
    const ReadView = () => {
      const read = useNodeRead(ReadColdProfileNode, {});
      observedTags.push(read._tag);

      return createElement("output", undefined, readLabel(read));
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    // No Suspense boundary anywhere in the tree: a thrown Pending would crash
    // the render instead of committing an inline fallback.
    const view = render(createElement(FrondProvider, { runtime }, createElement(ReadView)));

    // The very first commit produced DOM output, so the hook returned a value
    // instead of suspending.
    const output = view.container.querySelector("output");
    expect(output).not.toBeNull();
    expect(["Unwired", "Idle", "Pending"]).toContain(output?.textContent ?? "");

    expect(await view.findByText("Pending")).toBeTruthy();
    expect(view.queryByText("Ready:UTC")).toBeNull();

    await act(async () => {
      await Effect.runPromise(Deferred.succeed(gate, { timezone: "UTC" }));
    });

    expect(await view.findByText("Ready:UTC")).toBeTruthy();
    expect(observedTags).toContain("Pending");
    expect(observedTags).not.toContain("Error");
  });

  test("failing acquire renders the Error tag inline without throwing to a boundary", async () => {
    class ReadFailingProfileNode extends NodeBase<ProfileSpec, "effect"> {
      static readonly spec = resourceSpec.effect<ProfileSpec>({
        tag: "react-dom-read/resources/failing-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.fail(new Error("acquire exploded"))),
      });
    }

    let latestRead: Runtime.RuntimeNodeRead<Profile> | undefined;
    const ReadView = () => {
      const read = useNodeRead(ReadFailingProfileNode, {});
      latestRead = read;

      return createElement("output", undefined, readLabel(read));
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    // No ErrorBoundary and no Suspense: a thrown readiness error would unmount
    // the tree instead of rendering the inline Error tag.
    const view = render(createElement(FrondProvider, { runtime }, createElement(ReadView)));

    expect(await view.findByText("Error:readiness")).toBeTruthy();

    // The component stayed mounted and kept rendering after the failure.
    expect(view.container.querySelector("output")).not.toBeNull();
    expect(latestRead?._tag).toBe("Error");

    if (latestRead?._tag === "Error") {
      expect(latestRead.kind).toBe("readiness");
      expect(latestRead.error).toBeInstanceOf(Graph.AcquireFailed);
    }
  });

  test("StrictMode replay keeps one live subscription and still lands Ready", async () => {
    class StrictReadProfileNode extends NodeBase<ProfileSpec, "effect"> {
      static readonly spec = resourceSpec.effect<ProfileSpec>({
        tag: "react-dom-read/resources/strict-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ timezone: "UTC" })),
      });
    }

    const ReadView = () => {
      const read = useNodeRead(StrictReadProfileNode, {});

      return createElement("output", undefined, readLabel(read));
    };

    const { runtime, counts } = makeSubscriptionCountingRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(
      createElement(
        StrictMode,
        undefined,
        createElement(FrondProvider, { runtime }, createElement(ReadView))
      )
    );

    expect(await view.findByText("Ready:UTC")).toBeTruthy();

    // StrictMode replays effect cleanup/setup on the same store; the revivable
    // subscription must balance out to exactly one live upstream observer.
    expect(counts.observed - counts.unsubscribed).toBe(1);

    view.unmount();

    await waitFor(() => expect(counts.unsubscribed).toBe(counts.observed));
  });

  test("args change re-points the hook to the new key without bleeding old state", async () => {
    const gateTwo = await Effect.runPromise(Deferred.make<Profile>());

    type KeyedReadSpec = ProfileSpec<
      { readonly id: string },
      Key.Structure<{ readonly id: string }>
    >;

    class KeyedReadProfileNode extends NodeBase<KeyedReadSpec, "effect"> {
      static readonly spec = resourceSpec.effect<KeyedReadSpec>({
        tag: "react-dom-read/resources/keyed-profile",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          ctx.args.id === "two" ? Deferred.await(gateTwo) : Effect.succeed({ timezone: "tz-one" })
        ),
      });
    }

    const Shell = () => {
      const [id, setId] = useState("one");
      const read = useNodeRead(KeyedReadProfileNode, { id });

      return createElement(
        "div",
        undefined,
        createElement("output", undefined, readLabel(read)),
        createElement("button", { type: "button", onClick: () => setId("one") }, "to-one"),
        createElement("button", { type: "button", onClick: () => setId("two") }, "to-two")
      );
    };

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(createElement(FrondProvider, { runtime }, createElement(Shell)));

    expect(await view.findByText("Ready:tz-one")).toBeTruthy();

    fireEvent.click(view.getByText("to-two"));

    // The new key is still acquiring: the hook must surface Pending for the
    // new node, never the previous key's Ready payload.
    expect(await view.findByText("Pending")).toBeTruthy();
    expect(view.queryByText("Ready:tz-one")).toBeNull();

    // Rapid flips: back to the ready key, then forward again before the
    // gated acquire settles.
    fireEvent.click(view.getByText("to-one"));
    expect(await view.findByText("Ready:tz-one")).toBeTruthy();
    fireEvent.click(view.getByText("to-two"));
    expect(await view.findByText("Pending")).toBeTruthy();

    await act(async () => {
      await Effect.runPromise(Deferred.succeed(gateTwo, { timezone: "tz-two" }));
    });

    // The hook settled on the final args, not an intermediate flip.
    expect(await view.findByText("Ready:tz-two")).toBeTruthy();
    expect(view.queryByText("Ready:tz-one")).toBeNull();
  });

  test("unmount releases the runtime subscription", async () => {
    class ReadUnmountProfileNode extends NodeBase<ProfileSpec, "effect"> {
      static readonly spec = resourceSpec.effect<ProfileSpec>({
        tag: "react-dom-read/resources/unmount-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ timezone: "UTC" })),
      });
    }

    const ReadView = () => {
      const read = useNodeRead(ReadUnmountProfileNode, {});

      return createElement("output", undefined, readLabel(read));
    };

    const { runtime, counts } = makeSubscriptionCountingRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });

    const view = render(createElement(FrondProvider, { runtime }, createElement(ReadView)));

    expect(await view.findByText("Ready:UTC")).toBeTruthy();
    expect(counts.observed).toBe(1);
    expect(counts.unsubscribed).toBe(0);

    view.unmount();

    await waitFor(() => expect(counts.unsubscribed).toBe(1));
    // No revival after unmount: the store never re-attached upstream.
    expect(counts.observed).toBe(1);
  });

  test("resubscribe after an unobserved change revives the store and delivers the fresh peek", async () => {
    let refreshCount = 0;

    class ReadAttachWindowNode extends NodeBase<ProfileSpec> {
      static readonly spec = resourceSpec.effect<ProfileSpec>({
        tag: "react-dom-read/resources/attach-window",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ timezone: "initial" })),
        refresh: Driver.Refresh((ctx) =>
          Effect.gen(function* () {
            refreshCount += 1;
            yield* ctx.setResult({ timezone: `fresh-${refreshCount}` });
          })
        ),
      });
    }

    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node<EmptyArgs, Profile>(ReadAttachWindowNode, {});
    await handle.ensureReady();
    const store = makeReactNodeStore(runtime, {
      spec: ReadAttachWindowNode,
      args: {},
      nodeId: runtime.resolveNodeIdSync({ spec: ReadAttachWindowNode, args: {} }),
    });

    const initial = store.peek();
    expect(initial._tag).toBe("Ready");
    expect(initial._tag === "Ready" ? initial.result : undefined).toEqual({ timezone: "initial" });

    // Open the unsubscribe/resubscribe window that useNodeRead's effect
    // cleanup + StrictMode/Activity replay produces.
    const detach = store.subscribe(() => {});
    detach();

    const versionBeforeMissedRefresh = store.getVersion();

    await act(async () => {
      await handle.refresh();
    });

    // The change landed while nothing was attached: no version bump, so a
    // subscribed component would not have re-rendered yet.
    expect(store.getVersion()).toBe(versionBeforeMissedRefresh);

    let delivered: Runtime.RuntimeNodeRead<Profile> | undefined;
    const resubscribe = store.subscribe(() => {
      delivered = store.peek() as Runtime.RuntimeNodeRead<Profile>;
    });

    // Reattach resyncs: the revived subscription delivers the missed change.
    expect(delivered?._tag).toBe("Ready");
    expect(delivered?._tag === "Ready" ? delivered.result : undefined).toEqual({
      timezone: "fresh-1",
    });
    expect(store.getVersion()).toBeGreaterThan(versionBeforeMissedRefresh);

    resubscribe();
    store.dispose();
  });
});
