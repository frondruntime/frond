import { describe, expect, test } from "bun:test";
import {
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "../src/index";
import { createDeferred } from "../src/testing";

describe("public graph queue", () => {
  test("same-turn boot and ensureReady reserve one keyed acquire without synchronous listeners", async () => {
    const acquired = createDeferred<void>();
    const started = createDeferred<void>();
    let runs = 0;
    type Spec = NodeSpec<{
      readonly mode: "async";
      readonly args: { readonly id: string };
      readonly key: string;
      readonly deps: Record<string, never>;
      readonly result: number;
    }>;
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: "queue/boot-once",
        key: (args) => args.id,
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(async () => {
          runs += 1;
          started.resolve();
          await acquired.promise;
          return runs;
        }),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const first = runtime.client.node(Resource, { id: "same" });
    let notifications = 0;
    const unsubscribe = first.subscribe(() => {
      notifications += 1;
    });
    const boot = first.boot();
    expect(boot._tag).toBe("Pending");
    expect(first.read()._tag).toBe("Pending");
    const calls = [];
    for (let i = 0; i < 30; i += 1) {
      const handle = runtime.client.node(Resource, { id: "same" });
      const read = handle.boot();
      expect(read._tag).toBe("Pending");
      if (read._tag === "Pending") calls.push(read.attempt);
      calls.push(handle.ensureReady());
    }
    expect(runs).toBe(0);
    expect(notifications).toBe(0);
    await started.promise;
    expect(runs).toBe(1);
    acquired.resolve();
    await Promise.all(calls);
    expect(first.readReady().result).toBe(1);
    expect(runs).toBe(1);
    unsubscribe();
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("readiness posted during eviction waits for release and acquires a fresh cell", async () => {
    const releasing = createDeferred<void>();
    const release = createDeferred<void>();
    let runs = 0;
    type Spec = NodeSpec<{
      readonly mode: "async";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: number;
    }>;
    class Resource extends NodeBase<Spec> {
      static readonly spec = serviceSpec.async<Spec>({
        tag: "queue/eviction-gate",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => ++runs),
        release: Driver.Release(async () => {
          releasing.resolve();
          await release.promise;
        }),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node(Resource, {});
    const old = await handle.ensureReadyNode();
    const evicted = runtime.submit({
      _tag: "GraphEvictSubgraph",
      request: { rootNodeIds: [handle.nodeId], mode: "selfAndDependents" },
    });
    await releasing.promise;
    const ready = handle.ensureReadyNode();
    expect(runs).toBe(1);
    release.resolve();
    await evicted;
    const fresh = await ready;
    expect(fresh).not.toBe(old);
    expect(fresh.result).toBe(2);
    await runtime.submit({ _tag: "RuntimeStop" });
  });
});

test("a same-turn readiness call stays behind a previously submitted release", async () => {
  const released = createDeferred<void>();
  const finishRelease = createDeferred<void>();
  let acquires = 0;
  type Spec = NodeSpec<{
    readonly mode: "async";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: number;
  }>;
  class Resource extends NodeBase<Spec> {
    static readonly spec = serviceSpec.async<Spec>({
      tag: "queue/release-before-readiness",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => ++acquires),
      release: Driver.Release(async () => {
        released.resolve();
        await finishRelease.promise;
      }),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(Resource, {});
  await handle.ensureReady();
  const releasing = handle.releaseResources();
  const ready = handle.ensureReadyNode();
  await released.promise;
  expect(acquires).toBe(1);
  finishRelease.resolve();
  await releasing;
  expect((await ready).result).toBe(2);
  await runtime.submit({ _tag: "RuntimeStop" });
});
