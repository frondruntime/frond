import { describe, expect, spyOn, test } from "bun:test";
import { Deferred, Effect, Exit, Match } from "effect";
import { autorun, observable, onBecomeObserved, onBecomeUnobserved, spy } from "mobx";
import { Driver, Key, unwrapEffect } from "../src";
import { ActionFailed, GraphInvariantViolation, type NodeId, resultCommit } from "../src/graph";
import { createNode } from "../src/mobx";
import {
  type ActionContract,
  type Dep,
  dep,
  dependencies,
  FrondNodeClosed,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  serviceSpec,
} from "../src/node";
import {
  createRuntime,
  FrondRuntimeInvariantViolation,
  type RuntimeSubmission,
} from "../src/runtime";
import { runtimeCore } from "../src/runtime/core";
import { waitForRuntimeEvent, waitForRuntimeEventCount } from "../src/testing";

type Profile = {
  readonly name: string;
  timezone: string;
};

type TransportSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

class TransportNode extends NodeBase<TransportSpec> {
  static readonly spec = serviceSpec.effect<TransportSpec>({
    tag: "mobx/services/transport",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed("transport")),
  });
}

type ProfileSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: {
    readonly transport: Dep<typeof TransportNode>;
  };
  readonly result: Profile;
  readonly actions: {
    readonly updateTimezone: ActionContract<
      { readonly timezone: string },
      { readonly timezone: string }
    >;
    readonly rejectTimezone: ActionContract<void, never>;
  };
}>;

class ProfileNode extends NodeBase<ProfileSpec> {
  static readonly spec = resourceSpec.effect<ProfileSpec>({
    tag: "mobx/resources/profile",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({
      transport: dep(TransportNode, {}),
    })),
    acquire: Driver.Acquire((ctx) =>
      Effect.succeed({ name: ctx.deps.transport.result, timezone: "UTC" })
    ),
    refresh: Driver.Refresh((ctx) =>
      ctx.setResult({
        name: ctx.deps.transport.result,
        timezone: "PST",
      })
    ),
    actions: {
      updateTimezone: Driver.Action((ctx, input) =>
        Effect.gen(function* () {
          yield* ctx.patchResult((current) => {
            current.timezone = input.timezone;
          });

          return { timezone: input.timezone };
        })
      ),
      rejectTimezone: Driver.Action(() => Effect.fail({ _tag: "TimezoneRejected" } as const)),
    },
  });
  get timezone(): string {
    return this.result.timezone;
  }
}

describe("MobX node projection", () => {
  test("real runtime sync reads and publishes before its Promise is awaited", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.client.node(ProfileNode, {}).ensureReady();
    const projection = createNode(runtime, ProfileNode, {}, { autoSync: false });
    const syncRead = spyOn(runtime, "readNodeSnapshotSync");
    const asyncRead = spyOn(runtime, "readNodeSnapshot");

    try {
      const synced = projection.sync();
      expect(synced).toBeInstanceOf(Promise);
      expect(projection.result?.timezone).toBe("UTC");
      expect(syncRead).toHaveBeenCalledTimes(1);
      expect(asyncRead).not.toHaveBeenCalled();
      await synced;
    } finally {
      projection.dispose();
      syncRead.mockRestore();
      asyncRead.mockRestore();
    }
  });

  test("a spread runtime wrapper keeps the asynchronous read even with a sync method", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.client.node(ProfileNode, {}).ensureReady();
    const wrapper = { ...runtime };
    const syncRead = spyOn(wrapper, "readNodeSnapshotSync");
    const asyncRead = spyOn(wrapper, "readNodeSnapshot");
    const projection = createNode(wrapper, ProfileNode, {}, { autoSync: false });

    try {
      const synced = projection.sync();
      expect(projection.result).toBeUndefined();
      expect(syncRead).not.toHaveBeenCalled();
      expect(asyncRead).toHaveBeenCalledTimes(1);
      await synced;
      expect(projection.result?.timezone).toBe("UTC");
    } finally {
      projection.dispose();
      syncRead.mockRestore();
      asyncRead.mockRestore();
    }
  });

  test("a proxy of the runtime keeps the asynchronous read through its own traps", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.client.node(ProfileNode, {}).ensureReady();
    const trapped: Array<PropertyKey> = [];
    const proxy = new Proxy(runtime, {
      get(target, property, receiver) {
        trapped.push(property);
        if (property === "readNodeSnapshot")
          return async (nodeId: NodeId) => ({ _tag: "Missing", nodeId }) as const;
        return Reflect.get(target, property, receiver);
      },
    });
    const projection = createNode(proxy, ProfileNode, {}, { autoSync: false });

    try {
      await projection.sync();
      expect(trapped).toContain("readNodeSnapshot");
      expect(trapped).not.toContain("readNodeSnapshotSync");
      expect(projection.status._tag).toBe("Unwired");
      expect(projection.result).toBeUndefined();
    } finally {
      projection.dispose();
    }
  });

  test("looking up the runtime core reads no symbol property of a proxied runtime", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const symbolReads: Array<symbol> = [];
    const observed = new Proxy(runtime, {
      get(target, property, receiver) {
        if (typeof property === "symbol") symbolReads.push(property);
        return Reflect.get(target, property, receiver);
      },
    });
    const projection = createNode(observed, ProfileNode, {}, { autoSync: false });

    try {
      expect(symbolReads).toEqual([]);
    } finally {
      projection.dispose();
    }
  });

  test("a proxied runtime that rejects symbol keys still builds a projection", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const strict = new Proxy(runtime, {
      get(target, property, receiver) {
        if (typeof property === "symbol") throw new TypeError("symbol keys are not supported");
        return Reflect.get(target, property, receiver);
      },
    });

    const projection = createNode(strict, ProfileNode, {}, { autoSync: false });
    projection.dispose();
  });

  test("a direct submission with the wrong tag rejects with a plain Error", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.client.node(ProfileNode, {}).ensureReady();
    const core = runtimeCore(runtime);
    if (core === undefined) throw new Error("Expected a runtime core");
    const submit = spyOn(core, "submit").mockImplementation((_command, _context, resume) => {
      resume(Exit.succeed({ _tag: "RuntimeStarted" } as unknown as RuntimeSubmission));
      return () => Effect.void;
    });
    const projection = createNode(runtime, ProfileNode, {}, { autoSync: false });

    try {
      const rejection = await projection.refresh().then(
        () => undefined,
        (cause: unknown) => cause
      );
      expect(rejection).toBeInstanceOf(Error);
      expect(rejection).not.toBeInstanceOf(FrondRuntimeInvariantViolation);
      expect((rejection as Error).message).toBe(
        "Expected runtime submission GraphRefreshCompleted"
      );
    } finally {
      projection.dispose();
      submit.mockRestore();
    }
  });

  test("coalesces a node's event burst into one synchronous read and MobX action", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node(ProfileNode, {});
    await handle.ensureReady();
    const record = runtime
      .getSnapshotSync()
      .events.find((event) => event.nodeIds.includes(handle.nodeId));
    if (record === undefined) throw new Error("Expected a profile runtime event");
    const observe = spyOn(runtime, "observe");
    const projection = createNode(runtime, ProfileNode, {}, { autoSync: false });
    const unrelated = createNode(runtime, TransportNode, {}, { autoSync: false });
    const observer = observe.mock.calls[0]?.[0];
    if (observer === undefined) throw new Error("Expected a projection observer");
    const syncRead = spyOn(runtime, "readNodeSnapshotSync");
    let actions = 0;
    const stopSpy = spy((event) => {
      if (event.type === "action") actions++;
    });

    try {
      expect(observe).toHaveBeenCalledTimes(1);
      for (let i = 0; i < 5; i++) observer(record);
      expect(syncRead).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(syncRead).toHaveBeenCalledTimes(1);
      expect(syncRead).toHaveBeenCalledWith(projection.nodeId);
      expect(actions).toBe(1);
      expect(projection.result?.timezone).toBe("UTC");
      expect(unrelated.snapshot).toBeUndefined();

      // Explicit sync consumes pending event work instead of doing a second read.
      observer(record);
      await projection.sync();
      expect(syncRead).toHaveBeenCalledTimes(2);
      expect(actions).toBe(2);

      observer(record);
      projection.dispose();
      await Promise.resolve();
      expect(syncRead).toHaveBeenCalledTimes(2);
      unrelated.dispose();

      // Last-listener cleanup allows a later projection to subscribe anew.
      const replacement = createNode(runtime, ProfileNode, {}, { autoSync: false });
      expect(observe).toHaveBeenCalledTimes(2);
      replacement.dispose();
    } finally {
      stopSpy();
      projection.dispose();
      unrelated.dispose();
      observe.mockRestore();
      syncRead.mockRestore();
    }
  });

  test("an event syncs the projection while queueMicrotask callbacks are held, as Jest fake timers do", async () => {
    const runtime = createRuntime();
    await runtime.submit({ _tag: "RuntimeStart" });
    const handle = runtime.client.node(ProfileNode, {});
    await handle.ensureReady();
    const record = runtime
      .getSnapshotSync()
      .events.find((event) => event.nodeIds.includes(handle.nodeId));
    if (record === undefined) throw new Error("Expected a profile runtime event");
    const observe = spyOn(runtime, "observe");
    const projection = createNode(runtime, ProfileNode, {}, { autoSync: false });
    const observer = observe.mock.calls[0]?.[0];
    if (observer === undefined) throw new Error("Expected a projection observer");
    const held = spyOn(globalThis, "queueMicrotask").mockImplementation(() => {});

    try {
      observer(record);
      await Promise.resolve();
      expect(projection.result?.timezone).toBe("UTC");
    } finally {
      held.mockRestore();
      projection.dispose();
      observe.mockRestore();
    }
  });

  test("runAction publishes its final commit with event observation disabled", async () => {
    const runtime = createRuntime();
    const projection = createNode(
      runtime,
      ProfileNode,
      {},
      {
        autoSync: false,
        observeRuntimeEvents: false,
      }
    );
    try {
      await runtime.submit({ _tag: "RuntimeStart" });
      await projection.ensureReady();
      const result = await projection.runAction("updateTimezone", { timezone: "CET" });
      expect(result._tag).toBe("Success");
      expect(projection.result?.timezone).toBe("CET");
      expect(projection.node.timezone).toBe("CET");
      expect(projection.busy).toBe(false);
    } finally {
      projection.dispose();
    }
  });

  test("mirrors runtime readiness into observable node state", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});
    const observedLabels: Array<string> = [];
    const stop = autorun(() => {
      observedLabels.push(projection.result?.timezone ?? "missing");
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Ready" } });
    expect(projection.result).toEqual({ name: "transport", timezone: "UTC" });
    expect(observedLabels).toContain("UTC");

    stop();
    projection.dispose();
  });

  test("syncs through one-node runtime snapshots", async () => {
    const runtime = createRuntime();
    const projection = createNode(
      {
        client: runtime.client,
        readNodeSnapshot: runtime.readNodeSnapshot,
        observe: runtime.observe,
      },
      ProfileNode,
      {}
    );

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.result).toEqual({ name: "transport", timezone: "UTC" });

    projection.dispose();
  });

  test("fire-and-forget sync rejection is recorded as a runtime observer failure", async () => {
    const runtime = createRuntime();
    const runtimeWithFailure = runtime as typeof runtime & {
      readonly recordMobXProjectionFailure: (nodeId: NodeId, cause: unknown) => Promise<void>;
    };
    const cause = new Error("projection read failed");
    const projection = createNode(
      {
        client: runtime.client,
        observe: runtime.observe,
        readNodeSnapshot: async () => {
          throw cause;
        },
        recordMobXProjectionFailure: (nodeId, syncCause) =>
          runtimeWithFailure.recordMobXProjectionFailure(nodeId, syncCause),
      },
      ProfileNode,
      {}
    );

    const failureRecord = await waitForRuntimeEvent(runtime, "RuntimeObserverFailureObserved");
    const failure = failureRecord.event;

    expect(failure).toMatchObject({
      _tag: "RuntimeObserverFailureObserved",
      eventTag: "MobXProjectionSync",
    });
    expect(
      failure._tag === "RuntimeObserverFailureObserved" ? failure.cause : undefined
    ).toMatchObject({
      _tag: "FrondMobXProjectionError",
      nodeId: projection.nodeId,
      cause,
    });

    projection.dispose();
  });

  test("does not expose expired results as ordinary projected results", async () => {
    type ExpiredProfileSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: Profile;
    }>;

    class ExpiredProfileNode extends NodeBase<ExpiredProfileSpec> {
      static readonly spec = resourceSpec.effect<ExpiredProfileSpec>({
        tag: "mobx/resources/expired-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        resultValidity: { _tag: "Manual" },
        acquire: Driver.Acquire(() =>
          Effect.succeed(
            resultCommit(
              { name: "transport", timezone: "expired" },
              {
                validity: { _tag: "Expired", expiredAt: 10 },
              }
            )
          )
        ),
      });
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, ExpiredProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.resultValidity).toMatchObject({ _tag: "Expired", expiredAt: 10 });
    expect(projection.result).toBeUndefined();
    expect(projection.snapshot?.result).toBeUndefined();

    projection.dispose();
  });

  test("exposes a stable user node instance with strict runtime fields", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    expect(() => projection.node).toThrow("current node");

    await projection.ensure();

    expect(() => projection.node).toThrow("current node");

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.node).toBeInstanceOf(ProfileNode);
    expect(projection.node.nodeId).toBe(projection.nodeId);
    expect(projection.node.tag).toBe("mobx/resources/profile");
    expect(projection.node.args).toEqual({});
    expect(projection.node.result).toEqual({ name: "transport", timezone: "UTC" });
    expect(projection.node.deps.transport).toBeInstanceOf(TransportNode);
    expect(projection.node.deps.transport.result).toBe("transport");

    projection.dispose();
  });

  test("uses the graph-owned node object instead of constructing a projection copy", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const snapshot = await runtime.getSnapshot();
    const graphNode = snapshot.graph.nodes.find((entry) => entry.nodeId === projection.nodeId);

    expect(graphNode?.node).toBe(projection.node);

    projection.dispose();
  });

  test("driver node mutations are visible through the projected node", async () => {
    type MutableActions = {
      readonly mutateLabel: ActionContract<void, string>;
    };

    type MutableSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: null;
      readonly actions: MutableActions;
    }>;

    class MutableNode extends NodeBase<MutableSpec> {
      static readonly spec = resourceSpec.effect<MutableSpec>({
        tag: "mobx/resources/node-mutation",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed(null)),
        actions: {
          mutateLabel: Driver.Action((ctx) =>
            Effect.sync(() => {
              ctx.node.label = "mutated by driver";
              return ctx.node.label;
            })
          ),
        },
      });
      label = "initial";
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, MutableNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    await unwrapEffect(projection.node.actions.mutateLabel());
    expect(projection.node.label).toBe("mutated by driver");

    projection.dispose();
  });

  test("facade nodes can compute through dependency node objects", async () => {
    type FacadeSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: {
        readonly profile: Dep<typeof ProfileNode>;
      };
      readonly result: null;
    }>;

    class FacadeNode extends NodeBase<FacadeSpec> {
      static readonly spec = resourceSpec.effect<FacadeSpec>({
        tag: "mobx/facades/profile-label",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({
          profile: dep(ProfileNode, {}),
        })),
        acquire: Driver.Acquire(() => Effect.succeed(null)),
      });
      get profileLabel(): string {
        return this.deps.profile.timezone;
      }
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, FacadeNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    expect(projection.node.deps.profile).toBeInstanceOf(ProfileNode);
    expect(projection.node.profileLabel).toBe("UTC");

    projection.dispose();
  });

  test("routes domain actions and refresh through runtime handle and updates MobX node", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});
    const observedTimezones: Array<string> = [];

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    const stop = autorun(() => {
      observedTimezones.push(projection.node.timezone);
    });

    const action = unwrapEffect(projection.node.actions.updateTimezone({ timezone: "CET" }));

    expect(typeof action.then).toBe("function");

    const actionResult = await action;

    expect(actionResult).toEqual({ timezone: "CET" });
    expect(projection.result).toEqual({ name: "transport", timezone: "CET" });
    expect(projection.node.timezone).toBe("CET");
    expect(observedTimezones).toContain("CET");

    const refreshResult = await projection.refresh();

    expect(refreshResult).toEqual({
      _tag: "Success",
      nodeId: projection.nodeId,
      value: { name: "transport", timezone: "PST" },
    });
    expect(projection.node.result).toEqual({ name: "transport", timezone: "PST" });
    expect(observedTimezones).toContain("PST");

    stop();
    projection.dispose();
  });

  test("node domain action emits runtime action success events", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    await unwrapEffect(projection.node.actions.updateTimezone({ timezone: "CET" }));
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const actionStarts = events.filter((record) => record.event._tag === "GraphActionStarted");
    const actionSuccesses = events.filter((record) => record.event._tag === "GraphActionSucceeded");

    expect(actionStarts).toHaveLength(1);
    expect(actionStarts[0]?.work.source).toBe("node");
    expect(actionStarts[0]?.event).toMatchObject({
      _tag: "GraphActionStarted",
      action: "updateTimezone",
      input: { timezone: "CET" },
    });
    expect(actionSuccesses).toHaveLength(1);
    expect(actionSuccesses[0]?.work.source).toBe("node");
    expect(actionSuccesses[0]?.event).toMatchObject({
      _tag: "GraphActionSucceeded",
      action: "updateTimezone",
      input: { timezone: "CET" },
      value: { timezone: "CET" },
    });

    projection.dispose();
  });

  test("node domain action emits runtime action failure events", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    await expect(unwrapEffect(projection.node.actions.rejectTimezone())).rejects.toBeInstanceOf(
      ActionFailed
    );
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const actionStarts = events.filter((record) => record.event._tag === "GraphActionStarted");
    const actionFailures = events.filter((record) => record.event._tag === "GraphActionFailed");
    const failureEvent = actionFailures[0]?.event;

    expect(actionStarts).toHaveLength(1);
    expect(actionStarts[0]?.work.source).toBe("node");
    expect(actionStarts[0]?.event).toMatchObject({
      _tag: "GraphActionStarted",
      action: "rejectTimezone",
    });
    expect(actionFailures).toHaveLength(1);
    expect(actionFailures[0]?.work.source).toBe("node");
    expect(failureEvent).toMatchObject({
      _tag: "GraphActionFailed",
      action: "rejectTimezone",
    });
    expect(
      failureEvent?._tag === "GraphActionFailed" ? failureEvent.error : undefined
    ).toBeInstanceOf(ActionFailed);

    projection.dispose();
  });

  test("MobX node methods record MobX work metadata", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    await projection.runAction("updateTimezone", { timezone: "CET" });
    await projection.refresh();
    await projection.releaseResources("test release");
    await projection.evict("selfAndDependents", "test eviction");
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const recordsByTag = new Map(events.map((record) => [record.event._tag, record]));

    expect(recordsByTag.get("GraphNodeReadyEnsured")?.work.source).toBe("mobx");
    expect(recordsByTag.get("GraphActionStarted")?.work.source).toBe("mobx");
    expect(recordsByTag.get("GraphRefreshStarted")?.work.source).toBe("mobx");
    expect(recordsByTag.get("GraphNodeReleased")?.work.source).toBe("mobx");
    expect(recordsByTag.get("GraphNodesEvicted")?.work.source).toBe("mobx");

    projection.dispose();
  });

  test("node domain action bridge rejects failed actions with typed action failure", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    await expect(unwrapEffect(projection.node.actions.rejectTimezone())).rejects.toBeInstanceOf(
      ActionFailed
    );

    projection.dispose();
  });

  test("mirrors runtime operation state while preserving projected result", async () => {
    const refreshStarted = await Effect.runPromise(Deferred.make<void>());
    const refreshGate = await Effect.runPromise(Deferred.make<void>());
    type SlowMobXSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class SlowMobXNode extends NodeBase<SlowMobXSpec> {
      static readonly spec = resourceSpec.effect<SlowMobXSpec>({
        tag: "mobx/resources/slow-operation",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "stable" })),
        refresh: Driver.Refresh((ctx) =>
          Effect.gen(function* () {
            yield* Deferred.succeed(refreshStarted, undefined);
            yield* Deferred.await(refreshGate);
            yield* ctx.setResult({ value: "fresh" });
          })
        ),
      });
    }
    const runtime = createRuntime();
    const projection = createNode(runtime, SlowMobXNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    const refresh = projection.refresh();
    await Effect.runPromise(Deferred.await(refreshStarted));
    await projection.sync();

    expect(projection.busy).toBe(true);
    expect(projection.operation).toMatchObject({ _tag: "Running", kind: "refresh" });
    expect(projection.result).toEqual({ value: "stable" });

    await Effect.runPromise(Deferred.succeed(refreshGate, undefined));
    await refresh;

    expect(projection.busy).toBe(false);
    expect(projection.operationFailure).toBeUndefined();
    expect(projection.result).toEqual({ value: "fresh" });

    projection.dispose();
  });

  test("release clears projected result while preserving wired idle state", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    await projection.releaseResources("test release");

    expect(projection.status).toEqual({ _tag: "Wired", run: { _tag: "Idle" } });
    expect(projection.result).toBeUndefined();
    expect(() => projection.node).toThrow("current node");

    projection.dispose();
  });

  test("evict clears the current graph-owned node and rewires a new generation", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const firstNode = projection.node;
    const result = await projection.evict("selfAndDependents", "test eviction");

    expect(result.nodeIds).toContain(projection.nodeId);
    expect(projection.status).toEqual({ _tag: "Unwired" });
    expect(projection.result).toBeUndefined();
    expect(() => projection.node).toThrow("current node");

    await projection.ensureReady();

    expect(projection.node).toBeInstanceOf(ProfileNode);
    expect(projection.node).not.toBe(firstNode);
    expect(projection.node.timezone).toBe("UTC");

    projection.dispose();
  });

  test("observing graph-owned node result creates a MobX live lease", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.node.result;
    });

    await waitForRuntimeEvent(runtime, "GraphNodeLiveDemandChanged");

    const observed = await projection.snapshot;

    expect(observed?.liveDemand).toEqual({
      isLive: true,
      sources: ["mobx"],
      scopes: [{ field: "result" }],
    });

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    projection.dispose();
  });

  test("observed-result live start failure does not leave phantom MobX demand", async () => {
    const failure = new Error("live start failed once");
    let starts = 0;
    type FlakyLiveSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: string;
    }>;

    class FlakyLiveNode extends NodeBase<FlakyLiveSpec> {
      static readonly spec = resourceSpec.effect<FlakyLiveSpec>({
        tag: "mobx/resources/flaky-live",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed("ready")),
        live: Driver.Live({
          start: () =>
            Effect.sync(() => {
              starts += 1;
            }).pipe(
              Effect.flatMap(() => (starts === 1 ? Effect.fail(failure) : Effect.succeed("live")))
            ),
          stop: () => Effect.void,
        }),
      });
    }
    const runtime = createRuntime();
    const projection = createNode(runtime, FlakyLiveNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.node.result;
    });

    await waitForRuntimeEvent(runtime, "GraphNodeLiveFailed");

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });
    expect(starts).toBe(1);

    projection.dispose();
  });

  test("observing graph-owned result payload creates scoped MobX live demand", async () => {
    type Pair = "BTC/USD" | "ETH/USD";
    type RatesResult = {
      readonly rates: ReturnType<typeof observable.map<Pair, number>>;
    };

    type ScopedRatesSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: RatesResult;
    }>;

    class ScopedRatesNode extends NodeBase<ScopedRatesSpec> {
      static readonly spec = resourceSpec.effect<ScopedRatesSpec>({
        tag: "mobx/resources/scoped-rates",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.succeed({
            rates: observable.map<Pair, number>([
              ["BTC/USD", 1],
              ["ETH/USD", 2],
            ]),
          })
        ),
      });
      constructor() {
        super();

        for (const pair of this.result.rates.keys()) {
          this.onRuntimeClose(
            onBecomeObserved(this.result.rates, pair, () => {
              this.reportPairObserved(pair, true);
            })
          );
          this.onRuntimeClose(
            onBecomeUnobserved(this.result.rates, pair, () => {
              this.reportPairObserved(pair, false);
            })
          );
        }
      }

      rate(pair: Pair): number {
        return this.untrackedResult().rates.get(pair) ?? 0;
      }

      reportPairObserved(pair: Pair, observed: boolean): void {
        this.reportResultObserved({ field: "rates", pair }, observed);
      }
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, ScopedRatesNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.node.rate("BTC/USD");
    });

    await waitForRuntimeEvent(runtime, "GraphNodeLiveDemandChanged");
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: true,
      sources: ["mobx"],
      scopes: [{ field: "rates", pair: "BTC/USD" }],
    });

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    projection.dispose();
  });

  test("unsupported MobX live scopes surface typed live failures", async () => {
    type UnsupportedScopeSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class UnsupportedScopeNode extends NodeBase<UnsupportedScopeSpec> {
      static readonly spec = resourceSpec.effect<UnsupportedScopeSpec>({
        tag: "mobx/resources/unsupported-live-scope",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
      });
      reportUnsupportedScope(): void {
        this.reportResultObserved(Symbol("scope"), true);
      }
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, UnsupportedScopeNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    projection.node.reportUnsupportedScope();

    const record = await waitForRuntimeEvent(runtime, "GraphNodeLiveFailed");
    expect(record.failures[0]).toBeInstanceOf(GraphInvariantViolation);

    await projection.sync();
    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    projection.dispose();
  });

  test("rapid result payload unobserve releases the acquired scoped live lease", async () => {
    type Pair = "BTC/USD";
    type RatesResult = {
      readonly rates: ReturnType<typeof observable.map<Pair, number>>;
    };

    type RapidScopedRatesSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: RatesResult;
    }>;

    class RapidScopedRatesNode extends NodeBase<RapidScopedRatesSpec> {
      static readonly spec = resourceSpec.effect<RapidScopedRatesSpec>({
        tag: "mobx/resources/rapid-scoped-rates",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.succeed({
            rates: observable.map<Pair, number>([["BTC/USD", 1]]),
          })
        ),
      });
      constructor() {
        super();

        this.onRuntimeClose(
          onBecomeObserved(this.result.rates, "BTC/USD", () => {
            this.reportPairObserved("BTC/USD", true);
          })
        );
        this.onRuntimeClose(
          onBecomeUnobserved(this.result.rates, "BTC/USD", () => {
            this.reportPairObserved("BTC/USD", false);
          })
        );
      }

      rate(): number {
        return this.untrackedResult().rates.get("BTC/USD") ?? 0;
      }

      reportPairObserved(pair: Pair, observed: boolean): void {
        this.reportResultObserved({ field: "rates", pair }, observed);
      }
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, RapidScopedRatesNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.node.rate();
    });

    stop();
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    projection.dispose();
  });

  test("invalidation rolls back an observation lease interrupted during live start", async () => {
    const liveStarted = await Effect.runPromise(Deferred.make<void>());
    const liveGate = await Effect.runPromise(Deferred.make<void>());
    let liveStarts = 0;
    type InterruptedObservationSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly values: ReturnType<typeof observable.map<string, string>> };
    }>;

    class InterruptedObservationNode extends NodeBase<InterruptedObservationSpec> {
      static readonly spec = resourceSpec.effect<InterruptedObservationSpec>({
        tag: "mobx/resources/interrupted-observation-lease",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.succeed({ values: observable.map([["value", "ready"]]) })
        ),
        live: Driver.Live({
          start: () =>
            Effect.gen(function* () {
              liveStarts += 1;
              yield* Deferred.succeed(liveStarted, undefined);
              yield* Deferred.await(liveGate);
              return "live";
            }),
          stop: () => Effect.void,
        }),
      });

      constructor() {
        super();
        this.onRuntimeClose(
          onBecomeObserved(this.result.values, "value", () => {
            this.reportResultObserved({ field: "values", key: "value" }, true);
          })
        );
        this.onRuntimeClose(
          onBecomeUnobserved(this.result.values, "value", () => {
            this.reportResultObserved({ field: "values", key: "value" }, false);
          })
        );
      }

      readValue(): string | undefined {
        return this.untrackedResult().values.get("value");
      }
    }

    class ConflictingObservationNode extends NodeBase<InterruptedObservationSpec> {
      static readonly spec = resourceSpec.effect<InterruptedObservationSpec>({
        tag: "mobx/resources/interrupted-observation-lease",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.succeed({ values: observable.map([["value", "conflict"]]) })
        ),
      });
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, InterruptedObservationNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    const node = projection.node;

    const stopObserving = autorun(() => {
      void node.readValue();
    });
    await Effect.runPromise(Deferred.await(liveStarted));

    await runtime.submit({
      _tag: "GraphEnsureNode",
      request: { spec: ConflictingObservationNode, args: {} },
    });
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    stopObserving();
    await projection.ensureReady();
    expect(liveStarts).toBe(1);

    projection.dispose();
  });

  test("invalidation releases a successfully acquired observation lease by id", async () => {
    type InvalidatedObservationSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class InvalidatedObservationNode extends NodeBase<InvalidatedObservationSpec> {
      static readonly spec = resourceSpec.effect<InvalidatedObservationSpec>({
        tag: "mobx/resources/invalidated-observation-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
        live: Driver.Live({
          start: () => Effect.succeed("live"),
          stop: () => Effect.void,
        }),
      });
    }

    class ConflictingInvalidatedObservationNode extends NodeBase<InvalidatedObservationSpec> {
      static readonly spec = resourceSpec.effect<InvalidatedObservationSpec>({
        tag: "mobx/resources/invalidated-observation-release",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() => Effect.succeed({ value: "conflict" })),
      });
    }

    const runtime = createRuntime();
    const projection = createNode(runtime, InvalidatedObservationNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    const node = projection.node;

    const stopObserving = autorun(
      () => {
        void node.result;
      },
      { onError: () => undefined }
    );
    await waitForRuntimeEvent(runtime, "GraphNodeLiveDemandChanged");

    await runtime.submit({
      _tag: "GraphEnsureNode",
      request: { spec: ConflictingInvalidatedObservationNode, args: {} },
    });
    // Invalidation teardown and the observation release now post queue jobs.
    await waitForRuntimeEventCount(runtime, "GraphNodeLiveDemandChanged", 2);
    await projection.sync();

    expect(projection.snapshot?.liveDemand).toEqual({
      isLive: false,
      sources: [],
      scopes: [],
    });

    stopObserving();
    projection.dispose();
  });

  test("observing projection mirror result does not create duplicate live demand", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();

    const stop = autorun(() => {
      void projection.result;
    });
    await Promise.resolve();

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(events.some((record) => record.event._tag === "GraphNodeLiveDemandChanged")).toBe(false);

    stop();
    projection.dispose();
  });

  test("stale node action after release is closed and fresh node can act after reacquire", async () => {
    const runtime = createRuntime();
    const projection = createNode(runtime, ProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    await projection.ensureReady();
    const staleNode = projection.node;
    await projection.releaseResources("test release");

    await expect(
      unwrapEffect(staleNode.actions.updateTimezone({ timezone: "EET" }))
    ).rejects.toThrow(FrondNodeClosed);
    await projection.ensureReady();

    const result = await unwrapEffect(projection.node.actions.updateTimezone({ timezone: "EET" }));

    expect(result).toEqual({ timezone: "EET" });
    expect(projection.node.timezone).toBe("EET");

    projection.dispose();
  });

  test("ensureReady exposes pending state before slow acquire completes", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<Profile>());
    type SlowProfileSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: Profile;
    }>;

    class SlowProfileNode extends NodeBase<SlowProfileSpec> {
      static readonly spec = resourceSpec.effect<SlowProfileSpec>({
        tag: "mobx/resources/slow-profile",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(started, undefined);
            return yield* Deferred.await(gate);
          })
        ),
      });
    }
    const runtime = createRuntime();
    const projection = createNode(runtime, SlowProfileNode, {});

    await runtime.submit({ _tag: "RuntimeStart" });
    const ready = projection.ensureReady();
    await Effect.runPromise(Deferred.await(started));
    await projection.sync();

    const runState = Match.value(projection.status).pipe(
      Match.tag("Wired", ({ run }) => run._tag),
      Match.orElse(() => "not-wired")
    );

    expect(runState).toBe("Pending");

    await Effect.runPromise(Deferred.succeed(gate, { name: "slow", timezone: "UTC" }));
    await ready;

    expect(projection.node.result).toEqual({ name: "slow", timezone: "UTC" });

    projection.dispose();
  });
});
