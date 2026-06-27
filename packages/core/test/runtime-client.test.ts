import { describe, expect, test } from "bun:test";
import type { NodeId } from "../src/graph";
import { FrondNodeConstructionUnavailable } from "../src/node";
import { FrondRuntimeClosed, FrondRuntimeInvariantViolation } from "../src/runtime";
import type { RuntimeSubmission } from "../src/runtime/types";
import { Signals } from "../src/signals";
import { waitForRuntimeNodeRead } from "../src/testing";
import {
  AcquireFailed,
  type ActionContract,
  ActionProfileNode,
  createRuntime,
  createRuntimeClient,
  Deferred,
  Driver,
  dependencies,
  Effect,
  EffectBoundaryFailed,
  GraphInvariantViolation,
  Key,
  type MutableProfile,
  NodeBase,
  type NodeSpec,
  ProfileNode,
  serviceSpec,
  TransportNode,
} from "./graphTestFixtures";

describe("runtime client", () => {
  test("runtime client reports unexpected submission tags with expected tag context", async () => {
    const nodeId = 'resources/action-profile:{"type":"singleton"}' as NodeId;
    const runtime = {
      resolveNodeIdSync: () => nodeId,
      getStatusSync: () => "running" as const,
      readNodeSnapshotSync: () => ({ _tag: "Missing", nodeId }) as const,
      readNodeSnapshot: async () => ({ _tag: "Missing", nodeId }) as const,
      observe: () => ({ unsubscribe: () => undefined }),
      submit: async () => ({ _tag: "RuntimeStarted" }) satisfies RuntimeSubmission,
    };
    const handle = createRuntimeClient(runtime).node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );

    await expect(handle.ensureReady()).rejects.toThrow(
      "Expected runtime submission GraphNodeReadyEnsured, received RuntimeStarted."
    );
    await expect(handle.runAction("updateTimezone", { timezone: "CET" })).rejects.toBeInstanceOf(
      FrondRuntimeInvariantViolation
    );
  });

  test("runtime client node handle ensures readiness and reads snapshots", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );

    const handle = await profile.ensureReady();
    const snapshot = await profile.snapshot();

    expect(profile.nodeId).toBe(handle.nodeId);
    expect(snapshot).toMatchObject({
      _tag: "Found",
      snapshot: {
        nodeId: handle.nodeId,
        status: { _tag: "Wired", run: { _tag: "Ready" } },
        result: { name: "transport", timezone: "UTC" },
      },
    });
  });

  test("runtime client boot preserves supplied work metadata", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );
    const boot = profile.boot({ source: "test", reason: "preload", priority: "idle" });

    if (boot._tag !== "Booting" && boot._tag !== "Pending") {
      throw new Error("Expected boot to schedule readiness.");
    }

    await boot.attempt;
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const ensured = events.find((record) => record.event._tag === "GraphNodeReadyEnsured");

    expect(ensured?.work.source).toBe("test");
    expect(ensured?.work.reason).toBe("preload");
    expect(ensured?.work.priority).toBe("idle");
  });

  test("runtime client boot attempt settles when submission rejects", async () => {
    const nodeId = 'resources/action-profile:{"type":"singleton"}' as NodeId;
    const failure = new FrondRuntimeClosed({ operation: "GraphEnsureReadyNode" });
    const runtime = {
      resolveNodeIdSync: () => nodeId,
      getStatusSync: () => "running" as const,
      readNodeSnapshotSync: () =>
        ({
          _tag: "Found",
          snapshot: {
            _tag: "Idle",
            nodeId,
            tag: "resources/action-profile",
            kind: "resource",
            key: { type: "singleton" },
            label: "resource:resources/action-profile",
            status: { _tag: "Wired", run: { _tag: "Idle" } },
            liveDemand: { isLive: false, sources: [], scopes: [] },
            operation: { _tag: "Idle" },
          },
        }) as const,
      readNodeSnapshot: async () => ({ _tag: "Missing", nodeId }) as const,
      observe: () => ({ unsubscribe: () => undefined }),
      submit: async () => {
        throw failure;
      },
    };
    const handle = createRuntimeClient(runtime).node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );
    const booted = handle.boot();

    expect(booted._tag).toBe("Pending");

    if (booted._tag !== "Pending") {
      throw new Error("Expected boot to return a pending read.");
    }

    await expect(booted.attempt).resolves.toMatchObject({
      _tag: "Error",
      nodeId,
      error: failure,
    });
  });

  test("runtime client boot validates metadata synchronously", () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );

    expect(() => profile.boot({ source: "scheduler" as never })).toThrow(
      FrondRuntimeInvariantViolation
    );
  });

  test("runtime client node handle runs action and refresh through runtime events", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );

    const action = await profile.runAction("updateTimezone", { timezone: "CET" });
    const refresh = await profile.refresh();
    const snapshot = await profile.snapshot();
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const eventTags = events.map((record) => record.event._tag);

    expect(action).toMatchObject({ _tag: "Success", value: { timezone: "CET" } });
    expect(refresh).toMatchObject({ _tag: "Success" });
    expect(snapshot).toMatchObject({
      _tag: "Found",
      snapshot: { result: { name: "transport", timezone: "REFRESHED" } },
    });
    expect(eventTags).toContain("GraphActionStarted");
    expect(eventTags).toContain("GraphActionSucceeded");
    expect(eventTags).toContain("GraphRefreshStarted");
    expect(eventTags.at(-1)).toBe("GraphRefreshSucceeded");
  });

  test("runtime client node handle releases through runtime host", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );

    await profile.ensureReady();
    await profile.releaseResources("test release");
    const snapshot = await profile.snapshot();
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const eventTags = events.map((record) => record.event._tag);

    expect(snapshot).toMatchObject({
      _tag: "Found",
      snapshot: { status: { _tag: "Wired", run: { _tag: "Idle" } } },
    });

    if (snapshot._tag !== "Found") {
      throw new Error("Expected released node snapshot to be found.");
    }

    expect(snapshot.snapshot.result).toBeUndefined();
    expect(eventTags).toContain("GraphNodeReadyEnsured");
    expect(eventTags.at(-1)).toBe("GraphNodeReleased");
  });

  test("runtime client evicts, notifies subscribers, and can rewire", async () => {
    let constructed = 0;
    let acquired = 0;
    type RewiredSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class RewiredNode extends NodeBase<RewiredSpec> {
      static readonly spec = serviceSpec<RewiredSpec>({
        tag: "services/runtime-evict-rewire",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RewiredSpec>({
          acquire: Driver.Acquire(() => Effect.sync(() => `ready:${++acquired}`)),
        }),
      });

      constructor() {
        super();
        constructed += 1;
      }
    }
    const runtime = createRuntime();
    const handle = runtime.client.node<Record<string, never>, string>(RewiredNode, {});
    let changes = 0;
    const unsubscribe = handle.subscribe(() => {
      changes += 1;
    });

    await handle.ensureReady();

    const firstReady = handle.read();

    if (firstReady._tag !== "Ready") {
      throw new Error("Expected ready node.");
    }

    const result = await handle.evict("selfAndDependents", "test eviction");

    expect(result.nodeIds).toEqual([handle.nodeId]);
    expect(handle.read()).toEqual({ _tag: "Unwired", nodeId: handle.nodeId });
    expect(changes).toBeGreaterThanOrEqual(2);

    await handle.ensureReady();

    const secondReady = handle.read();

    if (secondReady._tag !== "Ready") {
      throw new Error("Expected rewired ready node.");
    }

    expect(secondReady.node).not.toBe(firstReady.node);
    expect(secondReady.result).toBe("ready:2");
    expect(constructed).toBe(2);

    unsubscribe();
  });

  test("runtime client live leases compose demand and emit change events", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, string>(ProfileNode, {});

    await profile.ensure();
    const first = await profile.acquireLiveLease("manual", { pair: "BTC/USD" });
    const second = await profile.acquireLiveLease("manual", { pair: "BTC/USD" });
    const third = await profile.acquireLiveLease("mobx", { pair: "ETH/USD" });
    const liveSnapshot = await profile.snapshot();

    if (liveSnapshot._tag !== "Found") {
      throw new Error("Expected live snapshot to be found.");
    }

    expect(liveSnapshot.snapshot.liveDemand).toEqual({
      isLive: true,
      sources: ["manual", "mobx"],
      scopes: [{ pair: "BTC/USD" }, { pair: "ETH/USD" }],
    });

    await first.dispose();
    const stillLiveSnapshot = await profile.snapshot();

    expect(stillLiveSnapshot).toEqual(liveSnapshot);

    await second.dispose();
    await third.dispose();
    await third.dispose();

    const idleSnapshot = await profile.snapshot();
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(idleSnapshot).toMatchObject({
      _tag: "Found",
      snapshot: {
        liveDemand: {
          isLive: false,
          sources: [],
          scopes: [],
        },
      },
    });
    expect(
      events
        .filter((record) => record.event._tag === "GraphNodeLiveDemandChanged")
        .map((record) => record.event._tag)
    ).toEqual([
      "GraphNodeLiveDemandChanged",
      "GraphNodeLiveDemandChanged",
      "GraphNodeLiveDemandChanged",
      "GraphNodeLiveDemandChanged",
    ]);
  });

  test("runtime client live lease dispose retries after a failed release", async () => {
    const nodeId = 'resources/profile:{"type":"singleton"}' as NodeId;
    let releaseCalls = 0;
    const releaseFailure = new FrondRuntimeClosed({ operation: "GraphReleaseNodeLiveLease" });
    const runtime = {
      resolveNodeIdSync: () => nodeId,
      getStatusSync: () => "running" as const,
      readNodeSnapshotSync: () => ({ _tag: "Missing", nodeId }) as const,
      readNodeSnapshot: async () => ({ _tag: "Missing", nodeId }) as const,
      observe: () => ({ unsubscribe: () => undefined }),
      submit: async (command: Parameters<ReturnType<typeof createRuntime>["submit"]>[0]) => {
        if (command._tag === "GraphAcquireNodeLiveLease") {
          return {
            _tag: "GraphNodeLiveLeaseAcquired",
            nodeId,
            leaseId: "lease-1" as never,
            liveDemand: { isLive: true, sources: ["manual"], scopes: [{ pair: "BTC/USD" }] },
          } satisfies RuntimeSubmission;
        }

        if (command._tag === "GraphReleaseNodeLiveLease") {
          releaseCalls += 1;

          if (releaseCalls === 1) {
            throw releaseFailure;
          }

          return {
            _tag: "GraphNodeLiveLeaseReleased",
            nodeId,
            leaseId: "lease-1" as never,
            liveDemand: { isLive: false, sources: [], scopes: [] },
          } satisfies RuntimeSubmission;
        }

        throw new Error(`Unexpected command ${command._tag}.`);
      },
    };
    const handle = createRuntimeClient(runtime).node<Record<string, never>, string>(
      ProfileNode,
      {}
    );
    const lease = await handle.acquireLiveLease("manual", { pair: "BTC/USD" });

    await expect(lease.dispose()).rejects.toBe(releaseFailure);
    await expect(lease.dispose()).resolves.toBeUndefined();
    await expect(lease.dispose()).resolves.toBeUndefined();
    expect(releaseCalls).toBe(2);
  });

  test("runtime client read is sync and non-throwing across idle pending and ready", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );

    expect(profile.read()).toMatchObject({ _tag: "Unwired", nodeId: profile.nodeId });
    expect((await runtime.getSnapshot()).graph.nodes).toHaveLength(0);

    await profile.ensure();

    expect(profile.read()).toMatchObject({ _tag: "Idle", nodeId: profile.nodeId });

    const booted = profile.boot();

    expect(booted).toMatchObject({ _tag: "Pending", nodeId: profile.nodeId });

    if (booted._tag !== "Pending") {
      throw new Error("Expected boot to return pending read.");
    }

    await booted.attempt;

    const ready = profile.read();

    expect(ready).toMatchObject({
      _tag: "Ready",
      nodeId: profile.nodeId,
      result: { name: "transport", timezone: "UTC" },
    });

    if (ready._tag !== "Ready") {
      throw new Error("Expected ready read.");
    }

    expect(ready.node).toBeInstanceOf(ActionProfileNode);
    expect(ready.node.nodeId).toBe(profile.nodeId);
    expect(ready.node.tag).toBe("resources/action-profile");
    expect(ready.node.args).toEqual({});
    expect(ready.node.deps.transport).toBeInstanceOf(TransportNode);
    expect(ready.node.result).toEqual({ name: "transport", timezone: "UTC" });
  });

  test("runtime client author nodes cannot be constructed outside Frond readiness", () => {
    expect(() => new ProfileNode()).toThrow(FrondNodeConstructionUnavailable);
  });

  test("runtime client pending read returns stable attempt", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<string>());
    type SlowSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SlowNode extends NodeBase<SlowSpec> {
      static readonly spec = serviceSpec<SlowSpec>({
        tag: "services/runtime-client-slow",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(gate);
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const slow = runtime.client.node<Record<string, never>, string>(SlowNode, {});

    const booted = slow.boot();

    expect(booted._tag).toBe("Pending");

    await Effect.runPromise(Deferred.await(started));

    const first = slow.read();
    const second = slow.read();

    if (first._tag !== "Pending" || second._tag !== "Pending") {
      throw new Error("Expected pending reads.");
    }

    expect(second.attempt).toBe(first.attempt);

    await Effect.runPromise(Deferred.succeed(gate, "ready"));
    await first.attempt;
  });

  test("runtime client stopped runtime read is unavailable and boot does not synthesize pending", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );

    await runtime.submit({ _tag: "RuntimeStart" });
    await profile.ensureReady();
    await runtime.submit({ _tag: "RuntimeStop", reason: "test stop" });

    expect(profile.read()).toMatchObject({
      _tag: "Error",
      kind: "runtime",
      nodeId: profile.nodeId,
    });
    expect(profile.boot()).toMatchObject({
      _tag: "Error",
      kind: "runtime",
      nodeId: profile.nodeId,
    });
    expect(runtime.client.__unsafe.readNode(profile.nodeId)).toMatchObject({
      _tag: "Unavailable",
      nodeId: profile.nodeId,
    });
  });

  test("stopped runtime rejects execution commands before graph work is admitted", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );

    await runtime.submit({ _tag: "RuntimeStart" });
    await profile.ensureReady();
    await runtime.submit({ _tag: "RuntimeStop", reason: "terminal runtime" });

    const before = await runtime.query({ _tag: "RuntimeEvents" });
    const beforeCount = before._tag === "RuntimeEvents" ? before.events.length : 0;

    await expect(runtime.submit({ _tag: "RuntimeStart" })).rejects.toBeInstanceOf(
      FrondRuntimeClosed
    );
    await expect(profile.ensureReady()).rejects.toBeInstanceOf(FrondRuntimeClosed);
    await expect(profile.runAction("updateTimezone", { timezone: "CET" })).rejects.toBeInstanceOf(
      FrondRuntimeClosed
    );
    await expect(profile.refresh()).rejects.toBeInstanceOf(FrondRuntimeClosed);
    await expect(profile.acquireLiveLease("manual", { source: "test" })).rejects.toBeInstanceOf(
      FrondRuntimeClosed
    );
    await expect(
      runtime.ingest({ _tag: "RuntimeInput", name: "after-stop", payload: undefined })
    ).rejects.toBeInstanceOf(FrondRuntimeClosed);
    await expect(
      runtime.publish(Signals.signal({ channel: "runtime/stopped", name: "after-stop" }))
    ).rejects.toBeInstanceOf(FrondRuntimeClosed);
    await expect(
      runtime.control({ _tag: "SetInputIngestion", enabled: false })
    ).rejects.toBeInstanceOf(FrondRuntimeClosed);

    const after = await runtime.query({ _tag: "RuntimeEvents" });
    const afterEvents = after._tag === "RuntimeEvents" ? after.events : [];

    expect(afterEvents).toHaveLength(beforeCount);
    expect(profile.read()).toMatchObject({
      _tag: "Error",
      kind: "runtime",
      nodeId: profile.nodeId,
    });
  });

  test("runtime client read exposes graph-owned pending attempt without scheduling work", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<string>());
    type SlowSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class SlowNode extends NodeBase<SlowSpec> {
      static readonly spec = serviceSpec<SlowSpec>({
        tag: "services/runtime-client-external-pending",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              return yield* Deferred.await(gate);
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const owner = runtime.client.node<Record<string, never>, string>(SlowNode, {});
    const observer = runtime.client.node<Record<string, never>, string>(SlowNode, {});
    const secondClient = createRuntimeClient(runtime);
    const crossClientObserver = secondClient.node<Record<string, never>, string>(SlowNode, {});
    const ready = owner.ensureReady();

    await Effect.runPromise(Deferred.await(started));

    const read = observer.read();
    const crossClientRead = crossClientObserver.read();

    expect(read).toMatchObject({ _tag: "Pending", nodeId: observer.nodeId });
    expect(crossClientRead).toMatchObject({
      _tag: "Pending",
      nodeId: crossClientObserver.nodeId,
    });

    if (read._tag !== "Pending" || crossClientRead._tag !== "Pending") {
      throw new Error("Expected pending reads.");
    }

    expect(read.attempt).toBeDefined();
    expect(crossClientRead.attempt).toBe(read.attempt);

    await Effect.runPromise(Deferred.succeed(gate, "ready"));
    await read.attempt;
    await ready;
  });

  test("graph-owned pending attempt resolves on readiness failure", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<void>());
    type FailingSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FailingNode extends NodeBase<FailingSpec> {
      static readonly spec = serviceSpec<FailingSpec>({
        tag: "services/runtime-client-failing-attempt",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(started, undefined);
              yield* Deferred.await(gate);
              return yield* Effect.fail("rejected");
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const owner = runtime.client.node<Record<string, never>, string>(FailingNode, {});
    const observer = runtime.client.node<Record<string, never>, string>(FailingNode, {});
    const ready = owner.ensureReady();

    await Effect.runPromise(Deferred.await(started));
    const read = observer.read();

    if (read._tag !== "Pending" || read.attempt === undefined) {
      throw new Error("Expected graph-owned pending attempt.");
    }

    await Effect.runPromise(Deferred.succeed(gate, undefined));
    const handle = await read.attempt;
    await ready;

    expect(handle.status).toMatchObject({ _tag: "Wired", run: { _tag: "Error" } });
  });

  test("runtime client subscribe only emits for matching node", async () => {
    const runtime = createRuntime();
    const profile = runtime.client.node<Record<string, never>, string>(ProfileNode, {});
    const actionProfile = runtime.client.node<Record<string, never>, MutableProfile>(
      ActionProfileNode,
      {}
    );
    let changes = 0;
    const unsubscribe = profile.subscribe(() => {
      changes += 1;
    });

    await actionProfile.ensureReady();

    expect(changes).toBe(0);

    await profile.ensureReady();

    expect(changes).toBeGreaterThanOrEqual(1);

    unsubscribe();
  });

  test("runtime client boot does not retry error but ensureReady does", async () => {
    let attempts = 0;
    type FailingOnceSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FailingOnceNode extends NodeBase<FailingOnceSpec> {
      static readonly spec = serviceSpec<FailingOnceSpec>({
        tag: "services/runtime-client-failing-once",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<FailingOnceSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              attempts += 1;

              if (attempts === 1) {
                return yield* Effect.fail(new Error("first attempt failed"));
              }

              return "ready";
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const failing = runtime.client.node<Record<string, never>, string>(FailingOnceNode, {});

    await failing.ensureReady();

    expect(failing.read()).toMatchObject({ _tag: "Error", nodeId: failing.nodeId });
    expect(attempts).toBe(1);

    expect(failing.boot()).toMatchObject({ _tag: "Error", nodeId: failing.nodeId });
    expect(attempts).toBe(1);

    await failing.ensureReady();

    expect(failing.read()).toMatchObject({
      _tag: "Ready",
      nodeId: failing.nodeId,
      result: "ready",
    });
    expect(attempts).toBe(2);
  });

  test("runtime client pending attempt resolves on acquire defect", async () => {
    const cause = new TypeError("driver typo");
    type DefectSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class DefectNode extends NodeBase<DefectSpec> {
      static readonly spec = serviceSpec<DefectSpec>({
        tag: "services/runtime-client-acquire-defect",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<DefectSpec>({
          acquire: Driver.Acquire(() => Effect.die(cause)),
        }),
      });
    }
    const runtime = createRuntime();
    const defect = runtime.client.node<Record<string, never>, string>(DefectNode, {});
    const pending = defect.boot();

    expect(pending._tag).toBe("Pending");
    const handle =
      pending._tag === "Pending" ? await pending.attempt : await Promise.reject("missing attempt");
    const read = defect.read();

    expect(handle.status._tag === "Wired" ? handle.status.run._tag : undefined).toBe("Error");
    expect(read._tag).toBe("Error");
    expect(read._tag === "Error" ? read.error : undefined).toBeInstanceOf(AcquireFailed);
    expect(read._tag === "Error" ? (read.error as AcquireFailed).cause : undefined).toBeInstanceOf(
      EffectBoundaryFailed
    );
  });

  test("same-identity updateArgs updates ready node args and refreshes ready data", async () => {
    type ListArgs = {
      readonly filter: string;
    };
    type ListResult = {
      readonly filter: string;
      readonly revision: number;
    };
    let revision = 0;
    type ListSpec = NodeSpec<{
      readonly args: ListArgs;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: ListResult;
    }>;

    class ListNode extends NodeBase<ListSpec> {
      static readonly spec = serviceSpec<ListSpec>({
        tag: "services/runtime-client-list",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<ListSpec>({
          acquire: Driver.Acquire((ctx) => {
            revision += 1;
            return Effect.succeed({
              filter: ctx.args.filter,
              revision,
            });
          }),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              revision += 1;
              yield* ctx.setResult({
                filter: ctx.args.filter,
                revision,
              });
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const list = runtime.client.node<ListArgs, ListResult>(ListNode, { filter: "all" });

    await list.ensureReady();

    expect(list.read()).toMatchObject({
      _tag: "Ready",
      result: { filter: "all", revision: 1 },
    });

    const update = await list.updateArgs({ filter: "active" });

    expect(update).toMatchObject({
      _tag: "Success",
      nodeId: list.nodeId,
      shouldRefresh: true,
    });

    await waitForRuntimeNodeRead(list, (read) => {
      return read._tag === "Ready" && read.result.filter === "active" && read.result.revision === 2;
    });

    expect(list.read()).toMatchObject({
      _tag: "Ready",
      result: { filter: "active", revision: 2 },
    });

    const equivalentUpdate = await list.updateArgs({ filter: "active" });

    expect(equivalentUpdate).toMatchObject({
      _tag: "Success",
      nodeId: list.nodeId,
      shouldRefresh: true,
    });

    await waitForRuntimeNodeRead(list, (read) => {
      return read._tag === "Ready" && read.result.filter === "active" && read.result.revision === 3;
    });

    expect(list.read()).toMatchObject({
      _tag: "Ready",
      result: { filter: "active", revision: 3 },
    });
  });

  test("updateArgs keeps old data busy while refresh is pending", async () => {
    type ListArgs = {
      readonly filter: string;
    };
    type ListResult = {
      readonly filter: string;
    };
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    type SlowListSpec = NodeSpec<{
      readonly args: ListArgs;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: ListResult;
    }>;

    class SlowListNode extends NodeBase<SlowListSpec> {
      static readonly spec = serviceSpec<SlowListSpec>({
        tag: "services/runtime-client-slow-list",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowListSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed({ filter: ctx.args.filter })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* Deferred.succeed(refreshStarted, undefined);
              yield* Deferred.await(refreshGate);
              yield* ctx.setResult({
                filter: ctx.args.filter,
              });
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const list = runtime.client.node<ListArgs, ListResult>(SlowListNode, { filter: "all" });

    await list.ensureReady();
    const update = list.updateArgs({ filter: "active" });
    await Effect.runPromise(Deferred.await(refreshStarted));
    const pending = list.read();

    expect(pending).toMatchObject({
      _tag: "Ready",
      busy: true,
      operation: { _tag: "Running", kind: "args" },
      result: { filter: "all" },
    });

    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    await update;

    expect(list.read()).toMatchObject({
      _tag: "Ready",
      busy: false,
      result: { filter: "active" },
    });
  });

  test("runtime subscriptions observe operation running state", async () => {
    const actionStarted = await Effect.runPromise(Deferred.make<void>());
    const actionGate = await Effect.runPromise(Deferred.make<void>());
    type BusyActionSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { value: string };
      readonly actions: {
        readonly wait: ActionContract<void, void>;
      };
    }>;

    class BusyActionNode extends NodeBase<BusyActionSpec> {
      static readonly spec = serviceSpec<BusyActionSpec>({
        tag: "services/runtime-client-busy-action",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<BusyActionSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "idle" })),
          actions: {
            wait: Driver.Action(() =>
              Effect.gen(function* () {
                yield* Deferred.succeed(actionStarted, undefined);
                yield* Deferred.await(actionGate);
              })
            ),
          },
        }),
      });
    }
    const runtime = createRuntime();
    const node = runtime.client.node<Record<string, never>, { value: string }>(BusyActionNode, {});
    const reads: Array<ReturnType<typeof node.read>> = [];
    const unsubscribe = node.subscribe(() => {
      reads.push(node.read());
    });

    await node.ensureReady();
    const action = node.runAction("wait");
    await Effect.runPromise(Deferred.await(actionStarted));

    expect(reads.some((read) => read._tag === "Ready" && read.busy)).toBe(true);

    await Effect.runPromise(Deferred.succeed(actionGate, undefined));
    await action;

    expect(reads.some((read) => read._tag === "Ready" && !read.busy)).toBe(true);
    unsubscribe();
  });

  test("updateArgs rolls back args and result when args refresh fails", async () => {
    type ListArgs = {
      readonly filter: string;
    };
    type ListResult = {
      readonly filter: string;
    };
    type RollbackListSpec = NodeSpec<{
      readonly args: ListArgs;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: ListResult;
    }>;

    class RollbackListNode extends NodeBase<RollbackListSpec> {
      static readonly spec = serviceSpec<RollbackListSpec>({
        tag: "services/runtime-client-rollback-list",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RollbackListSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed({ filter: ctx.args.filter })),
          refresh: Driver.Refresh(() => Effect.fail({ _tag: "RefreshRejected" })),
        }),
      });
    }
    const runtime = createRuntime();
    const list = runtime.client.node<ListArgs, ListResult>(RollbackListNode, { filter: "all" });

    await list.ensureReady();
    const update = await list.updateArgs({ filter: "active" });
    const read = list.read();

    expect(update._tag).toBe("Failure");
    expect(list.args).toEqual({ filter: "all" });
    expect(read).toMatchObject({
      _tag: "Ready",
      busy: false,
      operationFailure: { kind: "args", error: { _tag: "UpdateNodeArgsFailed" } },
      result: { filter: "all" },
    });
    expect(
      read._tag === "Ready" ? (read.node as { readonly args: ListArgs }).args : undefined
    ).toEqual({ filter: "all" });
  });

  test("updateArgs rolls back staged refresh patches when args refresh fails", async () => {
    type ListArgs = {
      readonly filter: string;
    };
    type ListResult = {
      readonly filter: string;
    };
    type RollbackPatchListSpec = NodeSpec<{
      readonly args: ListArgs;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: ListResult;
    }>;

    class RollbackPatchListNode extends NodeBase<RollbackPatchListSpec> {
      static readonly spec = serviceSpec<RollbackPatchListSpec>({
        tag: "services/runtime-client-rollback-patch-list",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<RollbackPatchListSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed({ filter: ctx.args.filter })),
          refresh: Driver.Refresh((ctx) =>
            Effect.gen(function* () {
              yield* ctx.patchResult((current) => {
                current.filter = "leaked";
              });
              return yield* Effect.fail({ _tag: "RefreshRejected" });
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const list = runtime.client.node<ListArgs, ListResult>(RollbackPatchListNode, {
      filter: "all",
    });

    await list.ensureReady();
    const update = await list.updateArgs({ filter: "active" });

    expect(update._tag).toBe("Failure");
    expect(list.read()).toMatchObject({
      _tag: "Ready",
      result: { filter: "all" },
    });
  });

  test("updateArgs rejects cross-identity changes without replacing current ready state", async () => {
    type ListArgs = {
      readonly id: string;
      readonly filter: string;
    };
    type KeyedListSpec = NodeSpec<{
      readonly args: ListArgs;
      readonly key: Key.Structure<{ readonly id: string }>;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class KeyedListNode extends NodeBase<KeyedListSpec> {
      static readonly spec = serviceSpec<KeyedListSpec>({
        tag: "services/runtime-client-keyed-list",
        key: (args) => Key.structure({ id: args.id }),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<KeyedListSpec>({
          acquire: Driver.Acquire((ctx) => Effect.succeed(ctx.args.filter)),
        }),
      });
    }
    const runtime = createRuntime();
    const list = runtime.client.node<ListArgs, string>(KeyedListNode, {
      id: "one",
      filter: "all",
    });

    await list.ensureReady();

    const update = await list.updateArgs({ id: "two", filter: "active" });

    expect(update._tag).toBe("Failure");
    expect(update._tag === "Failure" ? update.error.cause : undefined).toBeInstanceOf(
      GraphInvariantViolation
    );
    expect(list.read()).toMatchObject({
      _tag: "Ready",
      result: "all",
    });
  });

  test("__unsafe reads and schedules explicit runtime work by node id", async () => {
    type UnsafeSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { value: string };
    }>;

    class UnsafeNode extends NodeBase<UnsafeSpec> {
      static readonly spec = serviceSpec<UnsafeSpec>({
        tag: "services/runtime-client-unsafe",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<UnsafeSpec>({
          acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        }),
      });
    }
    const runtime = createRuntime();
    const handle = runtime.client.node<Record<string, never>, { value: string }>(UnsafeNode, {});

    await handle.ensureReady();

    expect(runtime.client.__unsafe.readNode(handle.nodeId)).toMatchObject({
      _tag: "Ready",
      nodeId: handle.nodeId,
      result: { value: "ready" },
    });

    const update = runtime.client.__unsafe.updateNode(
      handle.nodeId,
      (node) => {
        (node as { readonly result: { value: string } }).result.value = "unsafe";
      },
      { label: "test" }
    );

    expect(update).toEqual({ _tag: "Scheduled", nodeId: handle.nodeId });

    await waitForRuntimeNodeRead(handle, (read) => {
      return read._tag === "Ready" && read.result.value === "unsafe";
    });

    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: { value: "unsafe" },
    });
  });

  test("__unsafe ensureReady schedules an already-wired idle node by node id", async () => {
    type IdleUnsafeSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class IdleUnsafeNode extends NodeBase<IdleUnsafeSpec> {
      static readonly spec = serviceSpec<IdleUnsafeSpec>({
        tag: "services/runtime-client-unsafe-idle",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<IdleUnsafeSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
      });
    }

    const runtime = createRuntime();
    const handle = runtime.client.node<Record<string, never>, string>(IdleUnsafeNode, {});

    await handle.ensure();

    expect(handle.read()).toMatchObject({
      _tag: "Idle",
      nodeId: handle.nodeId,
    });

    expect(runtime.client.__unsafe.ensureReady(handle.nodeId)).toEqual({
      _tag: "Scheduled",
      nodeId: handle.nodeId,
    });

    await waitForRuntimeNodeRead(handle, (read) => read._tag === "Ready");

    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: "ready",
    });
  });

  test("__unsafe schedule/update reports Invalid when the underlying node is invalid", async () => {
    type InvalidUnsafeSpec = NodeSpec<{
      readonly args: { readonly value: number };
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class InvalidUnsafeNode extends NodeBase<InvalidUnsafeSpec> {
      static readonly spec = serviceSpec<InvalidUnsafeSpec>({
        tag: "services/runtime-client-unsafe-invalid",
        key: (args) => ({ value: args.value }) as never,
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<InvalidUnsafeSpec>({
          acquire: Driver.Acquire(() => Effect.succeed("ready")),
        }),
      });
    }

    const runtime = createRuntime();
    // NaN cannot be a canonical key, so the node lands in Invalid status.
    const handle = runtime.client.node<{ readonly value: number }, string>(InvalidUnsafeNode, {
      value: Number.NaN,
    });

    await handle.ensure();

    const ensureReadyResult = runtime.client.__unsafe.ensureReady(handle.nodeId);
    const refreshResult = runtime.client.__unsafe.refresh(handle.nodeId);
    const updateResult = runtime.client.__unsafe.updateNode(handle.nodeId, () => {});

    expect(ensureReadyResult).toMatchObject({ _tag: "Invalid", nodeId: handle.nodeId });
    expect(refreshResult).toMatchObject({ _tag: "Invalid", nodeId: handle.nodeId });
    expect(updateResult).toMatchObject({ _tag: "Invalid", nodeId: handle.nodeId });
  });
});
