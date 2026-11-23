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
import { FrondProvider, useNode, useNodeState, useNodes } from "@frondruntime/react";
import { act, cleanup, render } from "@testing-library/react";
import { observer } from "mobx-react-lite";
import { createElement, type ReactNode, StrictMode } from "react";
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
  readonly actions: { readonly increment: ActionContract };
}>;

class BoardNode extends NodeBase<BoardSpec> {
  static readonly spec = resourceSpec.async<BoardSpec>({
    tag: tag("test/react/leak-mount/board"),
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => ({ a: 0 })),
    actions: {
      increment: Driver.Action((context) => {
        context.patchResult((current) => {
          current.a += 1;
        });
      }),
    },
  });
}

const ReadBoard = observer(function ReadBoard() {
  const node = useNode(BoardNode, {});
  return createElement("output", undefined, node.result.a);
});

const ReadManyAndState = observer(function ReadManyAndState() {
  const { board } = useNodes({ board: [BoardNode, {}] });
  const state = useNodeState(BoardNode, {});
  return createElement(
    "output",
    undefined,
    `${board.result.a}:${state.node.result.a}:${state.busy}`
  );
});

async function checkMounts(name: string, children: ReactNode, composite: boolean) {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  runtimes.push(runtime);
  await runtime.submit({ _tag: "RuntimeStart" });
  const handle = runtime.client.node(BoardNode, {});
  await handle.ensureReady();
  if (handle.read()._tag !== "Ready") throw new Error("The board did not become ready");
  const containers = liveSample();
  let value = 0;
  const round = async (track: boolean) => {
    const view = render(createElement(FrondProvider, { runtime }, children));
    try {
      if (track) containers.track(view.container);
      await act(async () => {
        if ((await handle.actions.increment())._tag !== "Success") {
          throw new Error("The result write failed");
        }
      });
      value += 1;
      const expected = composite ? `${value}:${value}:false` : String(value);
      if (view.container.textContent !== expected) throw new Error("The observer missed the write");
    } finally {
      view.unmount();
      // unmount alone leaves Testing Library's container/root registries populated.
      cleanup();
    }
  };
  const growth = await objectGrowth(() => round(false));
  for (let index = 0; index < 20; index += 1) await round(true);
  console.info(name, JSON.stringify(growth));
  expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
  expect(await containers.alive()).toBeLessThanOrEqual(2);
}

test("an observer mounted and unmounted around a result write leaves no growth", async () => {
  await checkMounts("L3 observer", createElement(ReadBoard), false);
}, 120_000);

test("a StrictMode observer mounted and unmounted around a result write leaves no growth", async () => {
  await checkMounts(
    "L3 StrictMode",
    createElement(StrictMode, undefined, createElement(ReadBoard)),
    false
  );
}, 120_000);

test("useNodes and useNodeState release their stores after unmount", async () => {
  await checkMounts("L3 composite", createElement(ReadManyAndState), true);
}, 120_000);
