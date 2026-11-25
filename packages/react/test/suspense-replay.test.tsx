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
import { Suspense, useCallback, useState } from "react";
import { FrondProvider, useNode, useNodeState, useNodes } from "../src";

type ReplaySpec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly id: string };
  readonly key: Key.Structure<{ readonly id: string }>;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

class ReplayNode extends NodeBase<ReplaySpec> {
  static readonly spec = resourceSpec.async<ReplaySpec>({
    tag: "react/suspense-replay",
    key: (args) => Key.structure(args),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(({ args }) => args.id),
  });
}

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});

function useSingleRead(id: string): string {
  return useNode(ReplayNode, { id: `${id}/second` }).result;
}

function useStateRead(id: string): string {
  return useNodeState(ReplayNode, { id: `${id}/second` }).node.result;
}

function useCompositeRead(id: string): string {
  const nodes = useNodes({
    second: [ReplayNode, { id: `${id}/second` }],
    third: [ReplayNode, { id: `${id}/third` }],
  });
  return `${nodes.second.result},${nodes.third.result}`;
}

for (const [kind, useRead] of [
  ["useNode", useSingleRead],
  ["useNodeState", useStateRead],
  ["useNodes", useCompositeRead],
] as const) {
  test(`${kind} replays a sequential cold read before mounting subsequent hooks`, async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    runtimes.push(runtime);
    await runtime.submit({ _tag: "RuntimeStart" });
    const recoverable: Array<unknown> = [];
    const Reader = observer(function Reader({ id }: { readonly id: string }) {
      const [prefix] = useState("ready");
      // The first suspend can unwind. A later one in the same component can
      // replay its partial hook list, even with React DOM rather than RN.
      const first = useNode(ReplayNode, { id });
      const value = useRead(first.result);
      const label = useCallback(() => `${prefix}:${value}`, [prefix, value]);
      return <output>{label()}</output>;
    });
    const tree = (id: string) => (
      <FrondProvider runtime={runtime}>
        <Suspense fallback="loading">
          <Reader id={id} />
        </Suspense>
      </FrondProvider>
    );
    const view = await act(async () =>
      render(tree("first"), { onRecoverableError: (error) => recoverable.push(error) })
    );
    for (const id of ["first", "updated"]) {
      await act(async () => {
        view.rerender(tree(id));
      });
      expect(view.container.textContent).toBe(
        kind === "useNodes" ? `ready:${id}/second,${id}/third` : `ready:${id}/second`
      );
      expect(recoverable).toEqual([]);
    }
  });

  test(`${kind} reveals a Ready replacement while its readiness attempt is still pending`, async () => {
    const replacement = Promise.withResolvers<string>();
    const sinkStarted = Promise.withResolvers<void>();
    const sinkGate = Promise.withResolvers<void>();
    let acquisitions = 0;
    class ReplacementNode extends NodeBase<ReplaySpec> {
      static readonly spec = resourceSpec.async<ReplaySpec>({
        tag: "react/suspense-replay/replacement",
        key: (args) => Key.structure(args),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => {
          acquisitions += 1;
          return acquisitions === 1 ? "initial" : replacement.promise;
        }),
      });
    }
    const runtime = createRuntime({
      development: true,
      eventBufferSize: 512,
      sinks: [
        {
          name: "hold-ready-notification",
          handle: ({ event }) =>
            event._tag === "GraphNodeChanged" &&
            event.nodeId === handle.nodeId &&
            acquisitions > 1 &&
            handle.read()._tag === "Ready"
              ? Effect.promise(() => {
                  sinkStarted.resolve();
                  return sinkGate.promise;
                })
              : Effect.void,
        },
      ],
    });
    runtimes.push(runtime);
    const handle = runtime.client.node(ReplacementNode, { id: "selected" });
    const useReplacementRead = {
      useNode: () => useNode(ReplacementNode, { id: "selected" }).result,
      useNodeState: () => useNodeState(ReplacementNode, { id: "selected" }).node.result,
      useNodes: () => useNodes({ selected: [ReplacementNode, { id: "selected" }] }).selected.result,
    }[kind];
    const Reader = observer(function Reader({ revision }: { readonly revision: number }) {
      const value = useReplacementRead();
      return <output>{`${value}:${revision}`}</output>;
    });
    const tree = (revision: number) => (
      <FrondProvider runtime={runtime}>
        <Suspense fallback="loading">
          <Reader revision={revision} />
        </Suspense>
      </FrondProvider>
    );

    try {
      await runtime.submit({ _tag: "RuntimeStart" });
      const view = await act(async () => render(tree(0)));
      expect(view.container.textContent).toBe("initial:0");
      await act(async () => {
        await handle.evict();
      });
      expect(view.getByText("loading")).toBeTruthy();
      expect(acquisitions).toBe(2);

      // Replaying an attempt that is still pending must continue to suspend.
      await act(async () => {
        view.rerender(tree(1));
      });
      expect(view.getByText("loading")).toBeTruthy();

      let readinessSettled = false;
      const readiness = handle.ensureReady().then(() => {
        readinessSettled = true;
      });
      await act(async () => {
        replacement.resolve("replacement");
        await sinkStarted.promise;
      });
      expect(handle.read()).toMatchObject({ _tag: "Ready", node: { result: "replacement" } });
      expect(readinessSettled).toBe(false);

      await act(async () => {
        view.rerender(tree(2));
      });
      expect(view.queryByText("loading")?.textContent).toBeUndefined();
      expect(view.container.textContent).toBe("replacement:2");
      expect(readinessSettled).toBe(false);

      await act(async () => {
        sinkGate.resolve();
        await readiness;
      });
    } finally {
      await act(async () => {
        replacement.resolve("replacement");
        sinkGate.resolve();
      });
    }
  });
}
