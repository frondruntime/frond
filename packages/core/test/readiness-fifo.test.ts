import { expect, test } from "bun:test";
import {
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "../src/index";

test("a readiness call after a queued release waits for a fresh acquire", async () => {
  const started = Promise.withResolvers<void>();
  const finishAcquire = Promise.withResolvers<void>();
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
      tag: "readiness/fifo-after-release",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(async () => {
        acquires += 1;
        started.resolve();
        await finishAcquire.promise;
        return acquires;
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(Resource, {});
  try {
    const first = handle.ensureReady();
    await started.promise;
    const release = handle.releaseResources();
    const second = handle.ensureReady();
    finishAcquire.resolve();
    const [initial, , fresh] = await Promise.all([first, release, second]);
    expect(initial._tag).toBe("Ready");
    expect(fresh._tag).toBe("Ready");
    expect({ acquires, currentRead: handle.read()._tag }).toEqual({
      acquires: 2,
      currentRead: "Ready",
    });
  } finally {
    finishAcquire.resolve();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});

test("a readiness call with nothing queued joins the in-flight acquire", async () => {
  const finishAcquire = Promise.withResolvers<void>();
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
      tag: "readiness/fifo-join",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(async () => {
        acquires += 1;
        await finishAcquire.promise;
        return acquires;
      }),
    });
  }
  const runtime = createRuntime();
  const handle = runtime.client.node(Resource, {});
  try {
    const first = handle.ensureReady();
    const second = handle.ensureReady();
    finishAcquire.resolve();
    expect((await first)._tag).toBe("Ready");
    expect((await second)._tag).toBe("Ready");
    expect(acquires).toBe(1);
  } finally {
    finishAcquire.resolve();
    await runtime.submit({ _tag: "RuntimeStop" });
  }
});
