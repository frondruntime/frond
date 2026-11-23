import { afterEach, expect, test } from "bun:test";
import "./setup";
import {
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "@frondruntime/core";
import { FrondProvider, useNode } from "@frondruntime/react";
import { act, cleanup, render } from "@testing-library/react";
import { observer } from "mobx-react-lite";
import { createElement, StrictMode, Suspense } from "react";
import { leakSlackPerRound, liveSample, objectGrowth } from "../../core/test/leakTestFixtures";

const runtimes: Array<ReturnType<typeof createRuntime>> = [];
afterEach(async () => {
  cleanup();
  for (const runtime of runtimes.splice(0)) await runtime.submit({ _tag: "RuntimeStop" });
});

type BoardSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { a: number };
}>;

async function started() {
  // Isolate render/store ownership from the runtime's bounded diagnostic history.
  const runtime = createRuntime({ development: true, eventBufferSize: 0 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  return runtime;
}

test("a suspended render unmounted before readiness releases its abandoned store", async () => {
  const runtime = await started();
  let entered = Promise.withResolvers<void>();
  let gate = Promise.withResolvers<{ a: number }>();
  class BoardNode extends NodeBase<BoardSpec> {
    static readonly spec = resourceSpec.async<BoardSpec>({
      tag: tag("test/react/leak-uncommitted/suspended"),
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => {
        entered.resolve();
        return gate.promise;
      }),
    });
  }
  let committedReads = 0;
  const ReadBoard = observer(function ReadBoard() {
    const node = useNode(BoardNode, {});
    committedReads += 1;
    return createElement("output", undefined, node.result.a);
  });
  const nodes = liveSample();
  const round = async (track: boolean) => {
    entered = Promise.withResolvers<void>();
    gate = Promise.withResolvers<{ a: number }>();
    const handle = runtime.client.node(BoardNode, {});
    const view = await act(async () =>
      render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(Suspense, { fallback: "loading" }, createElement(ReadBoard))
        )
      )
    );
    try {
      await act(async () => {
        await entered.promise;
      });
      if (view.container.textContent !== "loading" || handle.read()._tag !== "Pending") {
        throw new Error("The render did not suspend on acquire");
      }
    } finally {
      view.unmount();
      cleanup();
      gate.resolve({ a: 1 });
    }
    await act(async () => {
      await handle.ensureReady();
    });
    const read = handle.read();
    if (read._tag !== "Ready" || committedReads !== 0)
      throw new Error("The abandoned render committed");
    if (track) nodes.track(read.node);
    const eviction = await handle.evict("selfAndDependents", "leak check");
    if (
      eviction.failures.length !== 0 ||
      !eviction.nodeIds.includes(handle.nodeId) ||
      handle.read()._tag === "Ready"
    )
      throw new Error("Eviction failed");
  };
  // Cold Suspense boots exercise more JIT paths than ready mounts. Finish one
  // extra warm-up before the harness starts its measured windows.
  for (let index = 0; index < 400; index += 1) await round(false);
  const growth = await objectGrowth(() => round(false));
  for (let index = 0; index < 20; index += 1) await round(true);
  console.info("L10 suspended", JSON.stringify(growth));
  expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
  expect(await nodes.alive()).toBeLessThanOrEqual(2);
}, 120_000);

test("StrictMode discards its first render without retaining its store", async () => {
  const runtime = await started();
  class BoardNode extends NodeBase<BoardSpec> {
    static readonly spec = resourceSpec.async<BoardSpec>({
      tag: tag("test/react/leak-uncommitted/strict"),
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => ({ a: 1 })),
    });
  }
  await runtime.client.node(BoardNode, {}).ensureReady();
  let renders = 0;
  const ReadBoard = observer(function ReadBoard() {
    const node = useNode(BoardNode, {});
    renders += 1;
    return createElement("output", undefined, node.result.a);
  });
  const containers = liveSample();
  const round = async (track: boolean) => {
    renders = 0;
    const view = await act(async () =>
      render(
        createElement(
          FrondProvider,
          { runtime },
          createElement(StrictMode, undefined, createElement(ReadBoard))
        )
      )
    );
    try {
      if (track) containers.track(view.container);
      await act(async () => {});
      if (renders < 2 || view.container.textContent !== "1")
        throw new Error("StrictMode did not replay the render");
    } finally {
      view.unmount();
      cleanup();
    }
  };
  const growth = await objectGrowth(() => round(false));
  for (let index = 0; index < 20; index += 1) await round(true);
  console.info("L10 StrictMode", JSON.stringify(growth));
  expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
  expect(await containers.alive()).toBeLessThanOrEqual(2);
}, 120_000);
