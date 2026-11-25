import { describe, expect, test } from "bun:test";
import {
  createRuntime,
  createRuntimeClient,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  type RuntimeInstance,
  resourceSpec,
} from "@frondruntime/core";
import { effectBridgeRunner, effectHostFromRuntime } from "@frondruntime/core/testing";
import { Deferred, Effect } from "effect";
import { makeReactNodeControls } from "../src/nodeControls";
import { projectReactNodeRead } from "../src/nodeReadProjection";
import { makeReactNodeStore } from "../src/nodeStore";
import { type SuspendPromise, type SuspenseRead, suspendPromise } from "../src/suspendPromise";
import { makeReactNodesStore } from "../src/useNodes";
import { makeInspectionSnapshotForbiddenRuntime } from "./projectionTestFixtures";

type Profile = {
  readonly timezone: string;
};

type ReactProfileSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Profile;
}>;

class ReactProfileNode extends NodeBase<ReactProfileSpec> {
  static readonly spec = resourceSpec.effect<ReactProfileSpec>({
    tag: "react/resources/profile",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire(() => Effect.succeed({ timezone: "UTC" })),
  });

  get timezone(): string {
    return this.result.timezone;
  }
}

type ReactArgsRollbackSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: { readonly filter: string };
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Profile;
}>;

class ReactArgsRollbackNode extends NodeBase<ReactArgsRollbackSpec> {
  static readonly spec = resourceSpec.effect<ReactArgsRollbackSpec>({
    tag: "react/resources/args-rollback",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire((ctx) =>
      Effect.succeed({
        timezone: ctx.args.filter,
      })
    ),
    refresh: Driver.Refresh(() => Effect.fail({ _tag: "RefreshRejected" })),
  });
}

// Refresh succeeds for any filter except "fail" — exercises the rollback race
// where the older updateArgs fails after the newer one has already succeeded.
class ReactArgsSelectiveNode extends NodeBase<ReactArgsRollbackSpec> {
  static readonly spec = resourceSpec.effect<ReactArgsRollbackSpec>({
    tag: "react/resources/args-selective",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    acquire: Driver.Acquire((ctx) => Effect.succeed({ timezone: ctx.args.filter })),
    refresh: Driver.Refresh((ctx) =>
      ctx.args.filter === "fail"
        ? Effect.fail({ _tag: "RefreshRejected" })
        : ctx.setResult({ timezone: ctx.args.filter })
    ),
  });
}

describe("React node store", () => {
  test("subscribes to runtime events only through the external store subscription", () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    let observed = 0;
    let unsubscribed = 0;
    const countingObserve = (observer: Parameters<RuntimeInstance["observe"]>[0]) => {
      observed += 1;
      const subscription = runtime.observe(observer);

      return {
        unsubscribe: () => {
          unsubscribed += 1;
          subscription.unsubscribe();
        },
      };
    };
    const wrappedRuntime: RuntimeInstance = {
      ...runtime,
      client: createRuntimeClient(
        effectHostFromRuntime({ ...runtime, observe: countingObserve }),
        effectBridgeRunner
      ),
      observe: countingObserve,
    };
    const args = {};
    const store = makeReactNodeStore(wrappedRuntime, {
      spec: ReactProfileNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactProfileNode, args }),
    });

    expect(observed).toBe(0);

    const unsubscribe = store.subscribe(() => {});

    expect(observed).toBe(1);

    unsubscribe();

    expect(unsubscribed).toBe(1);

    store.dispose();
  });

  test("returns one stable readiness attempt until the node becomes ready", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const args = {};
    const store = makeReactNodeStore(runtime, {
      spec: ReactProfileNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactProfileNode, args }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });

    const firstAttempt = readPendingPromise(store.read);
    const secondAttempt = readPendingPromise(store.read);

    expect(secondAttempt).toBe(firstAttempt);

    await firstAttempt;

    const ready = readReady(store.read);

    expect(ready.node).toBeInstanceOf(ReactProfileNode);
    expect(ready.node.timezone).toBe("UTC");
    expect(firstAttempt.status).toBe("fulfilled");

    store.dispose();
  });

  test("disposed store ignores readiness settlement", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<Profile>());
    type SlowDisposeSpec = NodeSpec<{
      readonly mode: "effect";
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: Profile;
    }>;

    class SlowDisposeNode extends NodeBase<SlowDisposeSpec> {
      static readonly spec = resourceSpec.effect<SlowDisposeSpec>({
        tag: "react/resources/slow-dispose",
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
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const args = {};
    const store = makeReactNodeStore(runtime, {
      spec: SlowDisposeNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: SlowDisposeNode, args }),
    });

    const coldAttempt = readPendingPromise(store.read);
    const duplicate = makeReactNodeStore(runtime, {
      spec: SlowDisposeNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: SlowDisposeNode, args }),
    });
    expect(readPendingPromise(duplicate.read)).toBe(coldAttempt);

    await runtime.submit({ _tag: "RuntimeStart" });
    const attempt = readPendingPromise(store.read);
    expect(attempt).toBe(coldAttempt);
    await Effect.runPromise(Deferred.await(started));

    const rebuilt = makeReactNodeStore(runtime, {
      spec: SlowDisposeNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: SlowDisposeNode, args }),
    });
    expect(readPendingPromise(rebuilt.read)).toBe(attempt);

    store.dispose();
    const versionAfterDispose = store.getVersion();

    await Effect.runPromise(Deferred.succeed(gate, { timezone: "UTC" }));
    await attempt;

    expect(store.getVersion()).toBe(versionAfterDispose);
    duplicate.dispose();
    rebuilt.dispose();
  });

  test("ready reads do not require full runtime snapshots", async () => {
    const trapped = makeInspectionSnapshotForbiddenRuntime();
    const runtime = trapped.runtime;
    const args = {};
    const store = makeReactNodeStore(runtime, {
      spec: ReactProfileNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactProfileNode, args }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await readPendingPromise(store.read);

    const ready = readReady(store.read);

    expect(ready.node).toBeInstanceOf(ReactProfileNode);
    expect(ready.node.result).toEqual({ timezone: "UTC" });
    expect(trapped.snapshotCalls()).toBe(0);

    store.dispose();
  });

  test("an unseen settled attempt cannot hide a new boot after eviction", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    const args = {};
    const handle = runtime.client.node(ReactProfileNode, args);
    const store = makeReactNodeStore(runtime, {
      spec: ReactProfileNode,
      args,
      nodeId: handle.nodeId,
    });
    // Settle without presenting the store's readiness promise to React.
    await handle.ensureReady();
    await handle.evict("selfAndDependents", "new readiness attempt");

    const next = readPendingPromise(store.read);
    expect(next.status).toBe("pending");
    await next;
    // The first read found Idle, so the ready gate still presents this attempt.
    // Its metadata lets React.use consume that gate without another suspend.
    expect(readPendingPromise(store.read)).toBe(next);
    expect(next.status).toBe("fulfilled");
    expect(readReady(store.read).node).toBeInstanceOf(ReactProfileNode);
    store.dispose();
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("cold boot records React readiness metadata", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const args = {};
    const store = makeReactNodeStore(runtime, {
      spec: ReactProfileNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactProfileNode, args }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await readPendingPromise(store.read);
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const ensured = events.find((record) => record.event._tag === "GraphNodeReadyEnsured");

    expect(ensured?.work.source).toBe("react");
    expect(ensured?.work.reason).toBe("readiness");
    expect(ensured?.work.priority).toBe("visible");

    store.dispose();
  });

  test("idle projection schedules readiness through boot instead of raw ensureReady", () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const handle = runtime.client.node<Record<string, never>, Profile>(ReactProfileNode, {});
    const scheduled = suspendPromise(Promise.resolve());
    let bootCalls = 0;
    let ensureReadyCalls = 0;
    let current: SuspendPromise | undefined;
    const projected = projectReactNodeRead<
      Record<string, never>,
      Record<string, never>,
      Profile,
      ReactProfileNode
    >({
      handle,
      handleRead: {
        _tag: "Idle",
        nodeId: handle.nodeId,
        operation: { _tag: "Idle" },
        busy: false,
      },
      ensureReady: () => {
        ensureReadyCalls += 1;
        return Promise.resolve();
      },
      scheduleBoot: () => {
        bootCalls += 1;
        current = scheduled;
      },
      scheduleReadinessAttempt: () => {
        throw new Error("Idle projection should not receive an existing pending attempt.");
      },
      currentReadinessPromise: () => current,
      markReadinessPresentedByPendingRead: () => {
        throw new Error("Idle projection should not mark a pending read.");
      },
    });

    expect(projected).toEqual({ _tag: "Pending", promise: scheduled });
    expect(bootCalls).toBe(1);
    expect(ensureReadyCalls).toBe(0);
  });

  test("failed args reconciliation rolls back React store fingerprint so the same args can retry", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const args = { filter: "all" };
    const store = makeReactNodeStore(runtime, {
      spec: ReactArgsRollbackNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactArgsRollbackNode, args }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await readPendingPromise(store.read);

    await store.updateArgs({ filter: "active" });
    await store.updateArgs({ filter: "active" });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(
      events.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(2);

    store.dispose();
  });

  test("failed older updateArgs does not clobber the fingerprint a newer success set", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const initial = { filter: "init" };
    const store = makeReactNodeStore(runtime, {
      spec: ReactArgsSelectiveNode,
      args: initial,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactArgsSelectiveNode, args: initial }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await readPendingPromise(store.read);

    // Dispatch both concurrently. The runtime serializes per-node operations so
    // "fail" resolves first (Failure) and "ok" resolves second (Success). Without
    // the rollback guard, the failed call's then-block clobbers the fingerprint
    // that the newer successful call established, and a no-op re-dispatch of
    // {filter:"ok"} below produces a third GraphNodeArgsUpdateStarted event.
    const failed = store.updateArgs({ filter: "fail" });
    const succeeded = store.updateArgs({ filter: "ok" });
    await Promise.all([failed, succeeded]);

    // After both settle the latest user intent is {filter:"ok"} and the runtime
    // accepted it. Re-issuing the same args should be a no-op.
    await store.updateArgs({ filter: "ok" });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(
      events.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(2);

    store.dispose();
  });

  test("rejected updateArgs rolls back the fingerprint and allows retry", async () => {
    const baseRuntime = createRuntime({ development: true, eventBufferSize: 512 });
    const runtime = rejectTransportArgsUpdate(baseRuntime, "transport-reject");
    const initial = { filter: "init" };
    const store = makeReactNodeStore(runtime, {
      spec: ReactArgsSelectiveNode,
      args: initial,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactArgsSelectiveNode, args: initial }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await readPendingPromise(store.read);

    await store.updateArgs({ filter: "transport-reject" });

    await store.updateArgs({ filter: "transport-reject" });
    await store.updateArgs({ filter: "ok" });

    const ready = readReady(store.read);
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(ready.node.result).toEqual({ timezone: "ok" });
    expect(ready.operationFailure).toBeUndefined();
    expect(
      events.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(2);

    store.dispose();
  });

  test("a transport rejection cannot shadow a newer graph-projected args failure", async () => {
    const baseRuntime = createRuntime({ development: true, eventBufferSize: 512 });
    const runtime = rejectTransportArgsUpdate(baseRuntime, "transport-reject");
    const initial = { filter: "init" };
    const store = makeReactNodeStore(runtime, {
      spec: ReactArgsSelectiveNode,
      args: initial,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactArgsSelectiveNode, args: initial }),
    });
    const handle = runtime.client.node(ReactArgsSelectiveNode, initial);

    await runtime.submit({ _tag: "RuntimeStart" });
    await readPendingPromise(store.read);

    await store.updateArgs({ filter: "transport-reject" });
    const graphFailure = await handle.updateArgs({ filter: "fail" });
    const read = readReady(store.read);
    const snapshot = await runtime.getSnapshot();
    const graphNode = snapshot.graph.nodes.find(
      (node) => node.tag === "react/resources/args-selective"
    );

    expect(graphFailure._tag).toBe("Failure");
    expect(read.operationFailure).toMatchObject({
      kind: "args",
      error: { _tag: "UpdateNodeArgsFailed" },
    });
    expect(read.operationFailure?.operationId).toBe(graphNode?.operationFailure?.operationId);

    store.dispose();
  });

  test("failed updateArgs across dispose-revive still rolls back the fingerprint", async () => {
    const failStarted = await Effect.runPromise(Deferred.make<void>());
    const failGate = await Effect.runPromise(Deferred.make<void>());

    class SlowFailingArgsNode extends NodeBase<ReactArgsRollbackSpec> {
      static readonly spec = resourceSpec.effect<ReactArgsRollbackSpec>({
        tag: "react/resources/args-revive-rollback",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) => Effect.succeed({ timezone: ctx.args.filter })),
        refresh: Driver.Refresh(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(failStarted, undefined);
            yield* Deferred.await(failGate);
            return yield* Effect.fail({ _tag: "RefreshRejected" });
          })
        ),
      });
    }
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const initial = { filter: "init" };
    const store = makeReactNodeStore(runtime, {
      spec: SlowFailingArgsNode,
      args: initial,
      nodeId: runtime.resolveNodeIdSync({ spec: SlowFailingArgsNode, args: initial }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    const unsubscribe = store.subscribe(() => {});
    await readPendingPromise(store.read);

    const failed = store.updateArgs({ filter: "fail" });
    await Effect.runPromise(Deferred.await(failStarted));

    unsubscribe();
    const revive = store.subscribe(() => {});

    await Effect.runPromise(Deferred.succeed(failGate, undefined));
    await failed;
    await store.updateArgs({ filter: "fail" });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(
      events.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(2);

    revive();
  });
});

function rejectTransportArgsUpdate(
  runtime: RuntimeInstance,
  rejectedFilter: string
): RuntimeInstance {
  let rejected = false;
  const wrappedRuntime = {
    ...runtime,
    submit: (command: Parameters<RuntimeInstance["submit"]>[0]) => {
      if (
        !rejected &&
        command._tag === "GraphUpdateNodeArgs" &&
        (command.request.args as { readonly filter?: unknown }).filter === rejectedFilter
      ) {
        rejected = true;
        return Promise.reject(new Error(`transport rejected ${rejectedFilter}`));
      }

      return runtime.submit(command);
    },
  } satisfies RuntimeInstance;

  return {
    ...wrappedRuntime,
    client: createRuntimeClient(effectHostFromRuntime(wrappedRuntime), effectBridgeRunner),
  };
}

function readPendingPromise<T>(read: () => SuspenseRead<T>): SuspendPromise {
  const result = read();
  expect(result._tag).toBe("Pending");
  if (result._tag !== "Pending") {
    throw new Error("Expected a pending Suspense read.");
  }
  return result.promise;
}

function readReady<T>(read: () => SuspenseRead<T>): T {
  const result = read();
  expect(result._tag).toBe("Ready");
  if (result._tag !== "Ready") {
    throw new Error("Expected a ready Suspense read.");
  }
  return result.value;
}

test("node controls route through the runtime handle without reading the node", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const handle = runtime.client.node(ReactProfileNode, {});
  const controls = makeReactNodeControls(handle);

  await runtime.submit({ _tag: "RuntimeStart" });

  expect(controls.nodeId).toBe(handle.nodeId);
  expect(handle.read()).toEqual({ _tag: "Unwired", nodeId: handle.nodeId });

  await controls.ensureReady();

  const ready = handle.read();

  expect(ready._tag).toBe("Ready");
  expect((ready as { readonly node: ReactProfileNode }).node.timezone).toBe("UTC");

  await controls.releaseResources();

  expect(handle.read()._tag).toBe("Idle");
});

test("nodes store returns a ready keyed node map", async () => {
  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const args = {};
  const entries = [
    {
      key: "profile",
      spec: ReactProfileNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactProfileNode, args }),
    },
  ];
  const store = makeReactNodesStore(runtime, entries);

  await runtime.submit({ _tag: "RuntimeStart" });
  await readPendingPromise(store.read);

  const nodes = readReady(store.read);

  expect(nodes.profile).toBeInstanceOf(ReactProfileNode);
  expect((nodes.profile as ReactProfileNode).timezone).toBe("UTC");
  expect(readReady(store.read)).toBe(nodes);

  store.dispose();
});

test("nodes store returns one stable composite attempt until children become ready", async () => {
  const startedA = await Effect.runPromise(Deferred.make<void>());
  const startedB = await Effect.runPromise(Deferred.make<void>());
  const gateA = await Effect.runPromise(Deferred.make<Profile>());
  const gateB = await Effect.runPromise(Deferred.make<Profile>());

  type SlowNodeASpec = NodeSpec<{
    readonly mode: "effect";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: Profile;
  }>;

  class SlowNodeA extends NodeBase<SlowNodeASpec> {
    static readonly spec = resourceSpec.effect<SlowNodeASpec>({
      tag: "react/resources/slow-a",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(startedA, undefined);
          return yield* Deferred.await(gateA);
        })
      ),
    });
  }

  type SlowNodeBSpec = NodeSpec<{
    readonly mode: "effect";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: Profile;
  }>;

  class SlowNodeB extends NodeBase<SlowNodeBSpec> {
    static readonly spec = resourceSpec.effect<SlowNodeBSpec>({
      tag: "react/resources/slow-b",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() =>
        Effect.gen(function* () {
          yield* Deferred.succeed(startedB, undefined);
          return yield* Deferred.await(gateB);
        })
      ),
    });
  }

  const runtime = createRuntime({ development: true, eventBufferSize: 512 });
  const args = {};
  const entries = [
    {
      key: "a",
      spec: SlowNodeA,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: SlowNodeA, args }),
    },
    {
      key: "b",
      spec: SlowNodeB,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: SlowNodeB, args }),
    },
  ];
  const store = makeReactNodesStore(runtime, entries);

  await runtime.submit({ _tag: "RuntimeStart" });

  const firstAttempt = readPendingPromise(store.read);
  const secondAttempt = readPendingPromise(store.read);

  expect(secondAttempt).toBe(firstAttempt);

  await Effect.runPromise(Deferred.await(startedA));
  await Effect.runPromise(Deferred.await(startedB));

  const rebuilt = makeReactNodesStore(runtime, entries);
  expect(readPendingPromise(rebuilt.read)).toBe(firstAttempt);

  await Effect.runPromise(Deferred.succeed(gateA, { timezone: "UTC" }));
  await Effect.runPromise(Deferred.succeed(gateB, { timezone: "CET" }));
  await firstAttempt;

  const nodes = readReady(store.read);

  expect((nodes.a as SlowNodeA).result).toEqual({ timezone: "UTC" });
  expect((nodes.b as SlowNodeB).result).toEqual({ timezone: "CET" });
  expect(firstAttempt.status).toBe("fulfilled");

  rebuilt.dispose();
  store.dispose();
});
