import { expect, test } from "bun:test";
import {
  type ActionContract,
  createRuntime,
  createRuntimeCoordinator,
  Driver,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  tag,
} from "../src";
import { leakSlackPerRound, liveSample, objectGrowth } from "./leakTestFixtures";

type CounterSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly result: { value: number };
  readonly actions: { readonly increment: ActionContract };
}>;

class CounterNode extends NodeBase<CounterSpec> {
  static readonly spec = resourceSpec.async<CounterSpec>({
    tag: tag("test/core/leak-runtime-stop/counter"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire(() => ({ value: 0 })),
    actions: {
      increment: Driver.Action((context) => {
        context.patchResult((current) => {
          current.value += 1;
        });
      }),
    },
  });
}

async function readyRuntime() {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  try {
    if ((await runtime.submit({ _tag: "RuntimeStart" }))._tag !== "RuntimeStarted")
      throw new Error("Runtime did not start");
    const handle = runtime.client.node(CounterNode, {});
    if ((await handle.ensureReady())._tag !== "Ready") throw new Error("Node did not become ready");
    if ((await handle.actions.increment())._tag !== "Success") throw new Error("Action failed");
    if (handle.readReady().result.value !== 1) throw new Error("Action did not commit");
    return { runtime, node: handle.readReady() };
  } catch (cause) {
    await runtime.submit({ _tag: "RuntimeStop" });
    throw cause;
  }
}

async function stopRuntime(runtime: ReturnType<typeof createRuntime>): Promise<void> {
  if ((await runtime.submit({ _tag: "RuntimeStop" }))._tag !== "RuntimeStopped")
    throw new Error("Runtime did not stop");
}

test("a stopped runtime and its ready node are collected without growth", async () => {
  const runtimes = liveSample();
  const nodes = liveSample();
  const round = async (track: boolean) => {
    const { runtime, node } = await readyRuntime();
    try {
      if (track) {
        runtimes.track(runtime);
        nodes.track(node);
      }
    } finally {
      await stopRuntime(runtime);
    }
  };
  const growth = await objectGrowth(() => round(false));
  for (let index = 0; index < 20; index += 1) await round(true);
  // Replace conservative stack roots from the sampling calls before collecting.
  for (let index = 0; index < 20; index += 1) await round(false);
  console.info("L2 stop", JSON.stringify(growth));
  expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
  expect(await runtimes.alive()).toBeLessThanOrEqual(2);
  expect(await nodes.alive()).toBeLessThanOrEqual(2);
}, 120_000);

test("a disposed runtime coordinator releases its runtime and ready node without growth", async () => {
  const coordinators = liveSample();
  const runtimes = liveSample();
  const nodes = liveSample();
  const round = async (track: boolean) => {
    const coordinator = createRuntimeCoordinator<Awaited<ReturnType<typeof readyRuntime>>>();
    try {
      const ready = await coordinator.start(async () => {
        const value = await readyRuntime();
        return { value, dispose: () => stopRuntime(value.runtime) };
      });
      if (track) {
        coordinators.track(coordinator);
        runtimes.track(ready.runtime);
        nodes.track(ready.node);
      }
    } finally {
      await coordinator.dispose();
    }
  };
  const growth = await objectGrowth(() => round(false));
  for (let index = 0; index < 20; index += 1) await round(true);
  // Replace conservative stack roots from the sampling calls before collecting.
  for (let index = 0; index < 20; index += 1) await round(false);
  console.info("L2 coordinator", JSON.stringify(growth));
  expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
  expect(await coordinators.alive()).toBeLessThanOrEqual(2);
  expect(await runtimes.alive()).toBeLessThanOrEqual(2);
  expect(await nodes.alive()).toBeLessThanOrEqual(2);
}, 120_000);
