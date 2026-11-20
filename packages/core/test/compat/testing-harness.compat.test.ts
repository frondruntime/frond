import { afterEach, expect, test } from "bun:test";
import * as Frond from "@frondruntime/core";
import * as FrondTest from "@frondruntime/core/testing";
import { Effect } from "effect";

const harnesses: FrondTest.FrondTestHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.teardown();
});
function createHarness(options: FrondTest.FrondTestHarnessOptions = {}) {
  const harness = FrondTest.createFrondTestHarness(options);
  harnesses.push(harness);
  return harness;
}

type SourceSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly key: Frond.Key.Singleton;
  readonly result: { value: number };
}>;
class SourceNode extends Frond.NodeBase<SourceSpec> {
  static readonly spec = Frond.serviceSpec.async<SourceSpec>({
    tag: Frond.tag("compat/harness/source"),
    key: () => Frond.Key.singleton(),
    acquire: Frond.Driver.Acquire(async () => ({ value: 3 })),
  });
}
type ConsumerSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly key: Frond.Key.Singleton;
  readonly deps: { readonly source: Frond.Dep<typeof SourceNode> };
  readonly result: number;
}>;
class ConsumerNode extends Frond.NodeBase<ConsumerSpec> {
  static readonly spec = Frond.facadeSpec.async<ConsumerSpec>({
    tag: Frond.tag("compat/harness/consumer"),
    key: () => Frond.Key.singleton(),
    dependencies: Frond.dependencies(() => ({ source: Frond.dep(SourceNode, Frond.Args.none) })),
    acquire: Frond.Driver.Acquire(async (context) => context.deps.source.result.value * 2),
  });
  get doubled() {
    return this.result * 2;
  }
}

test("Harness start and stop expose their final status and captured events after awaiting", async () => {
  const harness = createHarness();
  await harness.start();
  expect(harness.runtime.getStatusSync()).toBe("running");
  expect(
    await harness.waitForEvent((record) => record.event._tag === "RuntimeStarted")
  ).toMatchObject({
    event: { _tag: "RuntimeStarted" },
    work: { source: "test", reason: "start" },
  });
  await harness.stop();
  expect(harness.runtime.getStatusSync()).toBe("stopped");
  expect(harness.events.some((record) => record.event._tag === "RuntimeStopped")).toBe(true);
  await harness.teardown();
  await harness.teardown();
  expect(harness.runtime.getStatusSync()).toBe("stopped");
});

test("Harness startNode and startNodes return ready domain instances with dependency results", async () => {
  const harness = createHarness();
  const node = await harness.startNode(ConsumerNode, {});
  expect(node).toBeInstanceOf(ConsumerNode);
  expect(node.result).toBe(6);
  expect(node.doubled).toBe(12);
  expect(node.deps.source.result).toEqual({ value: 3 });
  // 0.5 behavior: startNodes types erase the input map to NodeSpecLike, making args never.
  // Restore this concrete public input/output contract while exercising the actual helper.
  const startNodes = harness.startNodes as (inputs: {
    source: { spec: typeof SourceNode; args: Frond.Args.None };
    consumer: { spec: typeof ConsumerNode; args: Frond.Args.None };
  }) => Promise<{ source: SourceNode; consumer: ConsumerNode }>;
  const nodes = await startNodes({
    source: { spec: SourceNode, args: {} },
    consumer: { spec: ConsumerNode, args: {} },
  });
  expect(nodes.consumer).toBe(node);
  expect(nodes.source.result).toEqual({ value: 3 });
  const handle = harness.node(ConsumerNode, {});
  expect(harness.readReady(handle)).toMatchObject({ _tag: "Ready", busy: false, result: 6 });
  expect(() => harness.readError(handle)).toThrow("received Ready");
  await harness.waitForIdle();
  expect(harness.runtime.isQuiescent()).toBe(true);
});

test("readySpec severs a dependency subtree while mockSpec preserves declared dependencies", async () => {
  const stub = FrondTest.readySpec(SourceNode, { value: 9 });
  const replacement = FrondTest.mockSpec(ConsumerNode, {
    driver: Frond.Driver.Async<ConsumerSpec>({
      acquire: Frond.Driver.Acquire(async (context) => context.deps.source.result.value + 1),
    }),
  });
  const harness = createHarness({
    specOverrides: [
      { from: SourceNode, to: stub },
      { from: ConsumerNode, to: replacement },
    ],
  });
  const node = await harness.startNode(ConsumerNode, {});
  expect(node.result).toBe(10);
  expect(node.deps.source.result).toEqual({ value: 9 });
  const snapshot = await harness.runtime.getSnapshot();
  expect(snapshot.graph.edges).toContainEqual({
    from: node.nodeId,
    to: node.deps.source.nodeId,
    dependency: "source",
  });
  const isolated = createHarness({
    specOverrides: [{ from: ConsumerNode, to: FrondTest.readySpec(ConsumerNode, 42) }],
  });
  const isolatedNode = await isolated.startNode(ConsumerNode, {});
  expect(isolatedNode.result).toBe(42);
  expect((await isolated.runtime.getSnapshot()).graph.nodes.map((entry) => entry.tag)).toEqual([
    "compat/harness/consumer",
  ]);
  expect((await isolated.runtime.getSnapshot()).graph.edges).toEqual([]);
});

type DeferredSpec = Frond.NodeSpec<{
  readonly mode: "async";
  readonly key: Frond.Key.Singleton;
  readonly result: number;
}>;

function createDeferredNode() {
  const deferred = FrondTest.createDeferredDriver<number>({
    refresh: true,
    release: true,
    actions: ["calculate"],
  });
  class DeferredNode extends Frond.NodeBase<DeferredSpec> {
    static readonly spec = Frond.serviceSpec.fromDriver<DeferredSpec>({
      tag: Frond.tag("compat/harness/deferred"),
      key: () => Frond.Key.singleton(),
      // 0.5 behavior: this async helper declares a union-mode Driver; narrow its known mode.
      driver: deferred.driver as Frond.NodeDescriptor<DeferredSpec, "async">["driver"],
    });
  }
  expect(deferred.driver.mode).toBe("async");
  return { deferred, DeferredNode };
}

test("Deferred driver gates expose pending reads and commit only after each operation resolves", async () => {
  const { deferred, DeferredNode } = createDeferredNode();
  const harness = createHarness();
  const handle = harness.node(DeferredNode, {});
  expect(handle.read()._tag).toBe("Unwired");
  expect(() => harness.readReady(handle)).toThrow("received Unwired");
  const readiness = handle.ensureReady();
  const acquireCall = await deferred.acquire.waitForCall();
  expect(acquireCall.ctx.args).toEqual({});
  expect(handle.read()._tag).toBe("Pending");
  const readyRead = FrondTest.waitForRuntimeNodeRead(handle, (read) => read._tag === "Ready");
  deferred.acquire.resolveNext(4);
  await readiness;
  expect(await readyRead).toMatchObject({ _tag: "Ready", result: 4 });
  const refresh = handle.refresh();
  await deferred.refresh.waitForCall();
  expect(handle.read()).toMatchObject({ _tag: "Ready", busy: true, result: 4 });
  deferred.refresh.resolveNext(8);
  await refresh;
  expect(handle.read()).toMatchObject({ _tag: "Ready", busy: false, result: 8 });
  const action = Frond.unwrapEffect(handle.action("calculate", { amount: 5 }));
  const actionGate = deferred.actions["calculate"];
  if (actionGate === undefined) throw new Error("Missing calculate gate");
  expect((await actionGate.waitForCall()).input).toEqual({ amount: 5 });
  actionGate.resolveNext(13);
  expect(await action).toMatchObject({ _tag: "Success", value: 13 });
  expect(handle.read()).toMatchObject({ result: 8 });
  await harness.waitForIdle();
  const release = handle.releaseResources();
  expect((await deferred.release.waitForCall()).ctx.node).toBeInstanceOf(DeferredNode);
  deferred.release.resolveNext(undefined);
  await release;
  expect(handle.read()._tag).toBe("Idle");
});

test("Deferred rejection exposes readError and teardown settles after failed acquisition", async () => {
  const { deferred, DeferredNode } = createDeferredNode();
  const harness = createHarness();
  const handle = harness.node(DeferredNode, {});
  const readiness = handle.ensureReady();
  await deferred.acquire.waitForCall();
  deferred.acquire.rejectNext({ _tag: "Unavailable", service: "quotes" });
  await readiness;
  expect(harness.readError(handle)).toMatchObject({
    _tag: "Error",
    kind: "readiness",
    error: {
      _tag: "AcquireFailed",
      cause: { _tag: "DriverPromiseFailed", cause: { _tag: "Unavailable", service: "quotes" } },
    },
  });
  expect(() => harness.readReady(handle)).toThrow("received Error");
  await harness.teardown();
  expect(harness.runtime.getStatusSync()).toBe("stopped");
});

test("Runtime event wait helpers accept captured arrays and runtime queries in event order", async () => {
  const harness = createHarness();
  await harness.start();
  await harness.startNode(SourceNode, {});
  const fromArray = await FrondTest.waitForRuntimeEvent(harness.events, "GraphNodeReadyEnsured");
  const fromRuntime = await FrondTest.waitForRuntimeEvent(
    harness.runtime,
    (record) => record.event._tag === "GraphNodeReadyEnsured"
  );
  expect(fromRuntime).toEqual(fromArray);
  const matching = await FrondTest.waitForRuntimeEventCount(
    harness.runtime,
    (record) =>
      record.event._tag === "RuntimeStarted" || record.event._tag === "GraphNodeReadyEnsured",
    2
  );
  expect(matching.map((record) => record.event._tag)).toEqual([
    "RuntimeStarted",
    "GraphNodeReadyEnsured",
  ]);
  expect(matching[0]?.sequence).toBeLessThan(matching[1]?.sequence ?? 0);
  expect(
    await harness.waitForNodeRead(harness.node(SourceNode, {}), (read) => read._tag === "Ready")
  ).toMatchObject({ result: { value: 3 } });
});

test("Wait helpers reject invalid options missing events and throwing read predicates", async () => {
  expect(() => FrondTest.createFrondTestHarness({ waitTimeoutMs: -1 })).toThrow(
    "finite non-negative"
  );
  await expect(FrondTest.waitForRuntimeEventCount([], "RuntimeStarted", -1)).rejects.toThrow(
    "non-negative integer"
  );
  await expect(
    FrondTest.waitForRuntimeEvent([], "RuntimeStarted", {
      timeoutMs: 0,
      description: "missing start",
    })
  ).rejects.toThrow("missing start");
  const harness = createHarness();
  const problem = new Error("predicate rejected");
  await expect(
    FrondTest.waitForRuntimeNodeRead(harness.node(SourceNode, {}), () => {
      throw problem;
    })
  ).rejects.toBe(problem);
});

test("Deferred values resolve and reject through their public Promise", async () => {
  const value = FrondTest.createDeferred<number>();
  value.resolve(42);
  expect(await value.promise).toBe(42);
  const rejected = FrondTest.createDeferred<void>();
  const rejection = rejected.promise.catch((cause: unknown) => cause);
  rejected.reject({ _tag: "FixtureRejected" });
  expect(await rejection).toMatchObject({ _tag: "FixtureRejected" });
  expect(() => FrondTest.createDeferredDriver({ actions: ["same", "same"] })).toThrow("duplicated");
});

test("Test runtimes capture awaited events and Effect host bridges preserve handle results", async () => {
  const fixture = FrondTest.createTestRuntime();
  try {
    const host = FrondTest.effectHostFromRuntime(fixture.runtime);
    const client = Frond.createRuntimeClient(host, FrondTest.effectBridgeRunner);
    const handle = client.node(SourceNode, {});
    await handle.ensureReady();
    expect(handle.readReady().result).toEqual({ value: 3 });
    expect(fixture.client.node(SourceNode, {}).nodeId).toBe(handle.nodeId);
    expect(fixture.sink.events).toBe(fixture.events);
    expect(fixture.events.some((record) => record.event._tag === "GraphNodeReadyEnsured")).toBe(
      true
    );
    expect(FrondTest.effectBridgeRunner.runSync(Effect.succeed("synchronous"))).toBe("synchronous");
    expect(await FrondTest.effectBridgeRunner.run(Effect.succeed("asynchronous"))).toBe(
      "asynchronous"
    );
  } finally {
    await fixture.runtime.submit({ _tag: "RuntimeStop" });
  }
});
