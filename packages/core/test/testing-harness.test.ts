import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import {
  createDeferredDriver,
  createFrondTestHarness,
  createTestRuntime,
  mockSpec,
  readySpec,
  waitForRuntimeEventCount,
} from "../src/testing";
import {
  Driver,
  dep,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

describe("Frond testing harness", () => {
  test("creates an isolated runtime and records test-owned start/stop work", async () => {
    const harness = createFrondTestHarness();

    await harness.start();
    await harness.stop();

    expect(harness.events.map((record) => record.event._tag)).toContain("RuntimeStarted");
    expect(harness.events.map((record) => record.event._tag)).toContain("RuntimeStopped");
    expect(
      harness.events.find((record) => record.event._tag === "RuntimeStarted")?.work.source
    ).toBe("test");
    expect(
      harness.events.find((record) => record.event._tag === "RuntimeStopped")?.work.source
    ).toBe("test");
  });

  test("teardown is idempotent after acquire failure", async () => {
    const deferred = createDeferredDriver<string>();

    type FailingHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FailingHarnessNode extends NodeBase<FailingHarnessSpec> {
      static readonly spec = serviceSpec<FailingHarnessSpec>({
        tag: "testing/resources/failing-harness",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: deferred.driver,
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(FailingHarnessNode, {});
    const readiness = handle.ensureReady({
      source: "test",
      reason: "readiness",
      priority: "blocking",
    });

    await deferred.acquire.waitForCall();
    deferred.acquire.rejectNext(new Error("expected reject"));
    await readiness;

    expect(harness.readError(handle)._tag).toBe("Error");
    await expect(harness.teardown()).resolves.toBeUndefined();
    await expect(harness.teardown()).resolves.toBeUndefined();
  });

  test("sink failures are captured as runtime events and do not fail harness commands", async () => {
    const harness = createFrondTestHarness({
      sinks: [
        {
          name: "failing-test-sink",
          handle: () => Effect.fail(new Error("sink failed")),
        },
      ],
    });

    await harness.start();
    const snapshot = await harness.runtime.getSnapshotFor("test");

    expect(snapshot.events.map((record) => record.event._tag)).toContain(
      "RuntimeSinkFailureObserved"
    );
  });

  test("startNode returns a typed ready node with domain methods", async () => {
    type DomainHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class DomainHarnessNode extends NodeBase<DomainHarnessSpec> {
      static readonly spec = serviceSpec<DomainHarnessSpec>({
        tag: "testing/resources/domain-harness",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DomainHarnessSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
      });

      upper(): string {
        return this.result.toUpperCase();
      }
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const node = await harness.startNode(DomainHarnessNode, {});

    expect(node.result).toBe("ready");
    expect(node.upper()).toBe("READY");
    expect(typeof node.nodeId).toBe("string");
  });

  test("startNodes preserves keyed ready-node map typing and values", async () => {
    type LeftHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class LeftHarnessNode extends NodeBase<LeftHarnessSpec> {
      static readonly spec = serviceSpec<LeftHarnessSpec>({
        tag: "testing/resources/left-harness",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<LeftHarnessSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("left")),
        }),
      });
    }

    type RightHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: number;
    }>;

    class RightHarnessNode extends NodeBase<RightHarnessSpec> {
      static readonly spec = serviceSpec<RightHarnessSpec>({
        tag: "testing/resources/right-harness",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RightHarnessSpec>({
          acquire: Driver.Acquire(() => Effect.succeed(42)),
        }),
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const nodes = await harness.startNodes({
      left: { spec: LeftHarnessNode, args: {} },
      right: { spec: RightHarnessNode, args: {} },
    });

    expect(nodes.left.result).toBe("left");
    expect(nodes.right.result).toBe(42);
  });

  test("deferred driver acquire and refresh use separate operation gates", async () => {
    const deferred = createDeferredDriver<string>({ refresh: true });

    type RefreshHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class RefreshHarnessNode extends NodeBase<RefreshHarnessSpec> {
      static readonly spec = serviceSpec<RefreshHarnessSpec>({
        tag: "testing/resources/refresh-harness",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: deferred.driver,
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(RefreshHarnessNode, {});
    const readiness = handle.ensureReady({
      source: "test",
      reason: "readiness",
      priority: "blocking",
    });

    await deferred.acquire.waitForCall();
    deferred.acquire.resolveNext("initial");
    await readiness;

    const refresh = handle.refresh({ source: "test", reason: "refresh", priority: "visible" });
    const refreshCall = await deferred.refresh.waitForCall();

    expect(refreshCall.callIndex).toBe(0);
    deferred.refresh.rejectNext(new Error("refresh rejected"));
    await expect(refresh).resolves.toMatchObject({ _tag: "Failure" });
    expect(harness.readReady(handle).result).toBe("initial");
  });

  test("wait helpers observe public runtime records and node reads", async () => {
    const deferred = createDeferredDriver<string>();

    type WaitHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class WaitHarnessNode extends NodeBase<WaitHarnessSpec> {
      static readonly spec = serviceSpec<WaitHarnessSpec>({
        tag: "testing/resources/wait-harness",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: deferred.driver,
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(WaitHarnessNode, {});
    const pending = harness.waitForNodeRead(handle, (read) => read._tag === "Pending");
    const readiness = handle.ensureReady({
      source: "test",
      reason: "readiness",
      priority: "blocking",
    });

    expect((await pending)._tag).toBe("Pending");
    await deferred.acquire.waitForCall();
    deferred.acquire.resolveNext("ready");
    await readiness;

    await harness.waitForEvent((record) => record.event._tag === "GraphNodeReadyEnsured");
    await expect(harness.waitForIdle()).resolves.toBeUndefined();
  });

  test("waitForRuntimeEventCount accumulates matching events across polls", async () => {
    type ReadyHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    const readyNode = (tag: string) =>
      class extends NodeBase<ReadyHarnessSpec> {
        static readonly spec = serviceSpec<ReadyHarnessSpec>({
          tag,
          key: () => Key.singleton(),
          dependencies: dependencies(() => ({})),
          driver: Driver.Effect<ReadyHarnessSpec>({
            acquire: Driver.Acquire(() => Effect.succeed("ready")),
          }),
        });
      };
    const FirstReadyNode = readyNode("testing/resources/wait-count-first");
    const SecondReadyNode = readyNode("testing/resources/wait-count-second");

    const harness = createFrondTestHarness();
    await harness.start();

    // Begin waiting before the events exist so they arrive over later polls.
    const waiting = waitForRuntimeEventCount(harness.runtime, "GraphNodeReadyEnsured", 2, {
      intervalMs: 1,
    });

    await harness.startNode(FirstReadyNode, {});
    await harness.startNode(SecondReadyNode, {});

    const matches = await waiting;

    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect(matches.every((record) => record.event._tag === "GraphNodeReadyEnsured")).toBe(true);
  });

  test("deferred action gate captures input and preserves FIFO resolution", async () => {
    const deferred = createDeferredDriver<number>({ actions: ["increment"] });

    type ActionHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: number;
    }>;

    class ActionHarnessNode extends NodeBase<ActionHarnessSpec> {
      static readonly spec = serviceSpec<ActionHarnessSpec>({
        tag: "testing/resources/action-harness",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: deferred.driver,
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(ActionHarnessNode, {});
    const readiness = handle.ensureReady({
      source: "test",
      reason: "readiness",
      priority: "blocking",
    });

    await deferred.acquire.waitForCall();
    deferred.acquire.resolveNext(1);
    await readiness;

    const first = handle.runAction(
      "increment",
      { amount: 1 },
      { source: "test", reason: "action", priority: "visible" }
    );
    const second = handle.runAction(
      "increment",
      { amount: 2 },
      { source: "test", reason: "action", priority: "visible" }
    );

    const firstCall = await deferred.actions.increment.waitForCall(0);
    expect(firstCall.input).toEqual({ amount: 1 });
    deferred.actions.increment.resolveNext(2);
    await expect(first).resolves.toMatchObject({ _tag: "Success", value: 2 });

    const secondCall = await deferred.actions.increment.waitForCall(1);
    expect(secondCall.input).toEqual({ amount: 2 });
    deferred.actions.increment.resolveNext(3);
    await expect(second).resolves.toMatchObject({ _tag: "Success", value: 3 });
  });

  test("release gate runs through public release paths", async () => {
    const deferred = createDeferredDriver<string>({ release: true });

    type ReleaseHarnessSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class ReleaseHarnessNode extends NodeBase<ReleaseHarnessSpec> {
      static readonly spec = serviceSpec<ReleaseHarnessSpec>({
        tag: "testing/resources/release-harness",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: deferred.driver,
      });
    }

    const harness = createFrondTestHarness();
    await harness.start();

    const handle = harness.node(ReleaseHarnessNode, {});
    const readiness = handle.ensureReady({
      source: "test",
      reason: "readiness",
      priority: "blocking",
    });

    await deferred.acquire.waitForCall();
    deferred.acquire.resolveNext("ready");
    await readiness;

    const release = handle.releaseResources("test release", {
      source: "test",
      reason: "release",
      priority: "blocking",
    });
    const releaseCall = await deferred.release.waitForCall();

    expect(releaseCall.ctx.node).toBeInstanceOf(ReleaseHarnessNode);
    deferred.release.resolveNext(undefined);
    await expect(release).resolves.toBeUndefined();
  });

  test("mockSpec and readySpec preserve tag and dependency wiring", async () => {
    type BaseDependencySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class BaseDependencyNode extends NodeBase<BaseDependencySpec> {
      static readonly spec = serviceSpec<BaseDependencySpec>({
        tag: "testing/resources/base-dependency",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<BaseDependencySpec>({
          acquire: Driver.Acquire(() => Effect.succeed("base")),
        }),
      });
    }

    type ConsumerSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly dependency: ReturnType<typeof dep<typeof BaseDependencyNode>>;
      };
      readonly result: string;
    }>;

    class ConsumerNode extends NodeBase<ConsumerSpec> {
      static readonly spec = serviceSpec<ConsumerSpec>({
        tag: "testing/resources/consumer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({ dependency: dep(BaseDependencyNode, {}) })),
        driver: Driver.Effect<ConsumerSpec>({
          acquire: Driver.Acquire((ctx) =>
            Effect.succeed(`consumer:${ctx.deps.dependency.result}`)
          ),
        }),
      });
    }

    const ReadyDependencyNode = readySpec(BaseDependencyNode, "ready");
    const ConsumerWithMockDependency = mockSpec(ConsumerNode, {
      dependencies: dependencies(() => ({ dependency: dep(ReadyDependencyNode, {}) })),
    });
    const harness = createFrondTestHarness({
      specOverrides: [{ from: ConsumerNode, to: ConsumerWithMockDependency }],
    });
    await harness.start();

    const node = await harness.startNode(ConsumerNode, {});

    expect(ReadyDependencyNode.spec.tag).toBe(BaseDependencyNode.spec.tag);
    expect(ConsumerWithMockDependency.spec.tag).toBe(ConsumerNode.spec.tag);
    expect(node.result).toBe("consumer:ready");
  });
});

describe("low-level test runtime", () => {
  test("createTestRuntime remains the primitive under the harness", async () => {
    const runtime = createTestRuntime();

    await runtime.runtime.submit({
      _tag: "RuntimeStart",
      metadata: { source: "test", reason: "start", priority: "blocking" },
    });

    expect(
      runtime.events.find((record) => record.event._tag === "RuntimeStarted")?.work.source
    ).toBe("test");
  });
});
