import { afterEach, expect, setSystemTime, test } from "bun:test";
import * as Frond from "@frondruntime/core";

const runtimes: Frond.Runtime.Runtime[] = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) {
    await runtime.submit({ _tag: "RuntimeStop", reason: "compatibility teardown" });
  }
});
function createRuntime(options: Partial<Frond.Runtime.RuntimeOptions> = {}) {
  const runtime = Frond.createRuntime({ development: true, eventBufferSize: 512, ...options });
  runtimes.push(runtime);
  return runtime;
}
type StringSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly args: Frond.Args.None;
  readonly key: Frond.Key.Singleton;
  readonly result: string;
}>;

test("static results remain current when the public synchronous clock advances", async () => {
  let now = Date.now();
  class StaticNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/static-validity"),
      key: () => Frond.Key.singleton(),
      resultValidity: { _tag: "Static" },
      acquire: Frond.Driver.Acquire(() => "permanent"),
    });
  }
  const runtime = createRuntime({
    development: true,
    eventBufferSize: 512,
    syncClock: { now: () => now },
  });
  const handle = runtime.client.node(StaticNode, Frond.Args.none);
  await handle.ensureReady();
  now += 1_000_000_000;
  expect(handle.read()).toMatchObject({
    _tag: "Ready",
    result: "permanent",
    resultValidity: { _tag: "Current" },
  });
});

test("time-bound reads progress from current through stale to expired without scheduling acquisition", async () => {
  const loadedAt = Date.now();
  let now = loadedAt;
  const acquisitions: string[] = [];
  class CachedNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/time-bound-validity"),
      key: () => Frond.Key.singleton(),
      resultValidity: { _tag: "TimeBound", staleAfter: 1_000_000, expireAfter: 2_000_000 },
      acquire: Frond.Driver.Acquire(() => {
        acquisitions.push("cached");
        return Frond.resultCommit("cached", { loadedAt });
      }),
    });
  }
  const runtime = createRuntime({
    development: true,
    eventBufferSize: 512,
    syncClock: { now: () => now },
  });
  const handle = runtime.client.node(CachedNode, Frond.Args.none);
  await handle.ensureReady();
  expect(handle.read()).toMatchObject({
    _tag: "Ready",
    result: "cached",
    resultValidity: { _tag: "Current", currentAt: loadedAt },
  });
  now = loadedAt + 1_000_000;
  expect(handle.read()).toMatchObject({
    _tag: "Ready",
    result: "cached",
    resultValidity: { _tag: "Stale", staleAt: now },
  });
  now = loadedAt + 2_000_000;
  expect(handle.read()._tag).toBe("Idle");
  expect("result" in handle.read()).toBe(false);
  expect(runtime.client.__unsafe.readNode(handle.nodeId)).toMatchObject({
    _tag: "Expired",
    resultValidity: { _tag: "Expired", expiredAt: now },
  });
  expect(acquisitions).toEqual(["cached"]);
});

test("an already expired acquire result resolves as AcquireFailed with ResultExpired metadata", async () => {
  class ExpiredNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/expired-commit"),
      key: () => Frond.Key.singleton(),
      resultValidity: { _tag: "TimeBound", staleAfter: 10, expireAfter: 20 },
      acquire: Frond.Driver.Acquire(() => Frond.resultCommit("old cache", { loadedAt: 0 })),
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(ExpiredNode, Frond.Args.none);
  expect(await handle.ensureReady()).toMatchObject({
    _tag: "Error",
    error: {
      _tag: "AcquireFailed",
      cause: {
        _tag: "ResultExpired",
        nodeId: handle.nodeId,
        tag: ExpiredNode.spec.tag,
        resultValidity: { _tag: "Expired", expiredAt: 20 },
      },
    },
  });
  expect(handle.read()._tag).toBe("Error");
});

test("manual invalidation hides the old result and ensureReady reacquires while preserving demand", async () => {
  const lifecycle: string[] = [];
  let generation = 0;
  type InvalidatedSpec = Frond.NodeSpec<{
    readonly mode: "async";
    readonly args: Frond.Args.None;
    readonly key: Frond.Key.Singleton;
    readonly result: string;
    readonly actions: {
      readonly stale: Frond.ActionContract<void, void>;
      readonly expire: Frond.ActionContract<void, void>;
    };
  }>;
  class InvalidatedNode extends Frond.NodeBase<InvalidatedSpec> {
    static readonly spec = Frond.resourceSpec.async<InvalidatedSpec>({
      tag: Frond.tag("compat/lifecycle/manual-invalidation"),
      key: () => Frond.Key.singleton(),
      resultValidity: { _tag: "Manual" },
      acquire: Frond.Driver.Acquire(() => {
        generation += 1;
        return `generation:${generation}`;
      }),
      release: Frond.Driver.Release(({ node }) => {
        lifecycle.push(`release:${node.result}`);
      }),
      live: Frond.Driver.Live({
        start: () => {
          lifecycle.push("live");
          return "subscription";
        },
        stop: (context) => {
          lifecycle.push(context.reason._tag);
        },
      }),
      actions: {
        stale: Frond.Driver.Action((context) => {
          context.setResultValidity({ _tag: "Stale", staleAt: 10 });
        }),
        expire: Frond.Driver.Action((context) => {
          context.setResultValidity({ _tag: "Expired", expiredAt: 20 });
        }),
      },
    });
  }
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(InvalidatedNode, Frond.Args.none);
  await handle.ensureReady();
  const previousNode = handle.readReady();
  const lease = await handle.acquireLiveLease("manual", { topic: "orders" });
  if (lease._tag !== "Held") throw new Error("Expected a manual demand lease.");
  await handle.actions.stale();
  expect(handle.read()).toMatchObject({
    _tag: "Ready",
    result: "generation:1",
    resultValidity: { _tag: "Stale", staleAt: 10 },
  });
  await handle.actions.expire();
  // 0.5 behavior: an expired result is retained for diagnostics but ordinary reads report Idle.
  expect(handle.read()._tag).toBe("Idle");
  expect(runtime.client.__unsafe.readNode(handle.nodeId)).toMatchObject({
    _tag: "Expired",
    resultValidity: { _tag: "Expired", expiredAt: 20 },
  });
  expect(await handle.snapshot()).toMatchObject({
    _tag: "Found",
    snapshot: { result: "generation:1" },
  });
  await handle.ensureReady();
  expect(handle.read()).toMatchObject({
    _tag: "Ready",
    result: "generation:2",
    resultValidity: { _tag: "Current" },
  });
  expect(handle.readReady()).not.toBe(previousNode);
  expect(await handle.snapshot()).toMatchObject({
    _tag: "Found",
    snapshot: { liveDemand: { isLive: true, sources: ["manual"], scopes: [{ topic: "orders" }] } },
  });
  expect(lifecycle).toEqual(["live", "ReadyInvalidated", "release:generation:1", "live"]);
  await lease.lease.dispose();
  expect(lifecycle.at(-1)).toBe("DemandInactive");
});

test("time-bound expiration reacquires a fresh result through ensureReady without a real delay", async () => {
  const origin = 1_800_000_000_000;
  let generation = 0;
  const released: string[] = [];
  class ExpiringNode extends Frond.NodeBase<StringSpec> {
    static readonly spec = Frond.resourceSpec.async<StringSpec>({
      tag: Frond.tag("compat/lifecycle/time-bound-reacquire"),
      key: () => Frond.Key.singleton(),
      resultValidity: { _tag: "TimeBound", staleAfter: 1_000, expireAfter: 2_000 },
      acquire: Frond.Driver.Acquire(() => {
        generation += 1;
        return Frond.resultCommit(`generation:${generation}`, { loadedAt: Date.now() });
      }),
      release: Frond.Driver.Release(({ node }) => {
        released.push(node.result);
      }),
    });
  }
  setSystemTime(origin);
  const runtime = createRuntime({
    development: true,
    eventBufferSize: 512,
    syncClock: { now: () => Date.now() },
  });
  try {
    const handle = runtime.client.node(ExpiringNode, Frond.Args.none);
    await handle.ensureReady();
    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: "generation:1",
      resultValidity: { _tag: "Current" },
    });
    setSystemTime(origin + 3_000);
    expect(handle.read()._tag).toBe("Idle");
    await handle.ensureReady();
    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: "generation:2",
      resultValidity: { _tag: "Current" },
    });
    expect(released).toEqual(["generation:1"]);
  } finally {
    await runtime.submit({ _tag: "RuntimeStop", reason: "restore compatibility clock" });
    setSystemTime();
  }
});
