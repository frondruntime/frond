import { expect, test } from "bun:test";
import { createRuntime, Driver, Key, NodeBase, type NodeSpec, resourceSpec, tag } from "../src";
import { leakSlackPerRound, liveSample, objectGrowth } from "./leakTestFixtures";

type KeyedSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly id: number };
  readonly key: Key.Structure<{ readonly id: number }>;
  readonly result: { id: number };
}>;

class KeyedNode extends NodeBase<KeyedSpec> {
  static readonly spec = resourceSpec.async<KeyedSpec>({
    tag: tag("test/core/leak-args/keyed"),
    key: ({ id }) => Key.structure({ id }),
    acquire: Driver.Acquire((context) => ({ id: context.args.id })),
  });
}

type UpdatingSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: { readonly id: number };
  readonly key: Key.Singleton;
  readonly result: { id: number };
}>;

class UpdatingNode extends NodeBase<UpdatingSpec> {
  static readonly spec = resourceSpec.async<UpdatingSpec>({
    tag: tag("test/core/leak-args/updating"),
    key: () => Key.singleton(),
    acquire: Driver.Acquire((context) => ({ id: context.args.id })),
    refresh: Driver.Refresh((context) => {
      context.setResult({ id: context.args.id });
    }),
  });
}

test("distinct argument keys leave no growth after their nodes are evicted", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const nodes = liveSample();
  const argumentsSample = liveSample();
  try {
    await runtime.submit({ _tag: "RuntimeStart" });
    const round = async (index: number, track: boolean) => {
      const args = { id: index };
      const handle = runtime.client.node(KeyedNode, args);
      if ((await handle.ensureReady())._tag !== "Ready")
        throw new Error("Node did not become ready");
      if (handle.readReady().result.id !== index) throw new Error("Wrong keyed result");
      if (track) {
        nodes.track(handle.readReady());
        argumentsSample.track(args);
      }
      const eviction = await handle.evict("selfAndDependents", "leak check");
      if (eviction.failures.length !== 0 || !eviction.nodeIds.includes(handle.nodeId))
        throw new Error("Node eviction failed");
      if (handle.read()._tag !== "Unwired") throw new Error("Evicted node is still wired");
    };
    const growth = await objectGrowth((index) => round(index, false));
    for (let index = 0; index < 20; index += 1) await round(10_000 + index, true);
    // Replace conservative stack roots from the sampling calls before collecting.
    for (let index = 0; index < 20; index += 1) await round(20_000 + index, false);
    console.info("L4 keys", JSON.stringify(growth));
    expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
    expect(await nodes.alive()).toBeLessThanOrEqual(2);
    expect(await argumentsSample.alive()).toBeLessThanOrEqual(2);
  } finally {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 120_000);

test("updating one ready node's arguments retains no argument history", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const argumentsSample = liveSample();
  try {
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node(UpdatingNode, { id: -1 });
    if ((await handle.ensureReady())._tag !== "Ready") throw new Error("Node did not become ready");
    const node = handle.readReady();
    const round = async (index: number, track: boolean) => {
      const args = { id: index };
      if (track) argumentsSample.track(args);
      if ((await handle.updateArgs(args))._tag !== "Success") throw new Error("Args update failed");
      if ((await handle.ensureReady())._tag !== "Ready")
        throw new Error("Updated node is not ready");
      if (handle.args.id !== index || node.args.id !== index || node.result.id !== index)
        throw new Error("Args update did not commit and refresh");
      if (handle.readReady() !== node) throw new Error("Args update replaced the node");
    };
    const growth = await objectGrowth((index) => round(index, false));
    for (let index = 0; index < 20; index += 1) await round(10_000 + index, true);
    // Replace conservative stack roots from the sampling calls before collecting.
    for (let index = 0; index < 20; index += 1) await round(20_000 + index, false);
    console.info("L4 updates", JSON.stringify(growth));
    expect(growth.perRound, JSON.stringify(growth)).toBeLessThan(leakSlackPerRound);
    expect(await argumentsSample.alive()).toBeLessThanOrEqual(2);
  } finally {
    await runtime.submit({ _tag: "RuntimeStop" });
  }
}, 120_000);
