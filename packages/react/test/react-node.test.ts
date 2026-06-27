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
import { Deferred, Effect } from "effect";
import { makeReactNodeControls } from "../src/nodeControls";
import { projectReactNodeRead } from "../src/nodeReadProjection";
import { makeReactNodeStore } from "../src/nodeStore";
import { makeReactNodesStore } from "../src/useNodes";
import { makeInspectionSnapshotForbiddenRuntime } from "./projectionTestFixtures";

type Profile = {
  readonly timezone: string;
};

type ReactProfileSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Profile;
}>;

class ReactProfileNode extends NodeBase<ReactProfileSpec> {
  static readonly spec = resourceSpec<ReactProfileSpec>({
    tag: "react/resources/profile",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ReactProfileSpec>({
      acquire: Driver.Acquire(() => Effect.succeed({ timezone: "UTC" })),
    }),
  });

  get timezone(): string {
    return this.result.timezone;
  }
}

type ReactArgsRollbackSpec = NodeSpec<{
  readonly args: { readonly filter: string };
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: Profile;
}>;

class ReactArgsRollbackNode extends NodeBase<ReactArgsRollbackSpec> {
  static readonly spec = resourceSpec<ReactArgsRollbackSpec>({
    tag: "react/resources/args-rollback",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ReactArgsRollbackSpec>({
      acquire: Driver.Acquire((ctx) =>
        Effect.succeed({
          timezone: ctx.args.filter,
        })
      ),
      refresh: Driver.Refresh(() => Effect.fail({ _tag: "RefreshRejected" })),
    }),
  });
}

// Refresh succeeds for any filter except "fail" — exercises the rollback race
// where the older updateArgs fails after the newer one has already succeeded.
class ReactArgsSelectiveNode extends NodeBase<ReactArgsRollbackSpec> {
  static readonly spec = resourceSpec<ReactArgsRollbackSpec>({
    tag: "react/resources/args-selective",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ReactArgsRollbackSpec>({
      acquire: Driver.Acquire((ctx) => Effect.succeed({ timezone: ctx.args.filter })),
      refresh: Driver.Refresh((ctx) =>
        ctx.args.filter === "fail"
          ? Effect.fail({ _tag: "RefreshRejected" })
          : ctx.setResult({ timezone: ctx.args.filter })
      ),
    }),
  });
}

describe("React node store", () => {
  test("subscribes to runtime events only through the external store subscription", () => {
    const runtime = createRuntime();
    let observed = 0;
    let unsubscribed = 0;
    const wrappedRuntime: RuntimeInstance = {
      ...runtime,
      client: createRuntimeClient({
        resolveNodeIdSync: runtime.resolveNodeIdSync,
        getStatusSync: runtime.getStatusSync,
        readNodeSnapshotSync: runtime.readNodeSnapshotSync,
        readNodeSnapshot: runtime.readNodeSnapshot,
        observe: (observer) => {
          observed += 1;
          const subscription = runtime.observe(observer);

          return {
            unsubscribe: () => {
              unsubscribed += 1;
              subscription.unsubscribe();
            },
          };
        },
        submit: runtime.submit,
      }),
      observe: (observer: Parameters<RuntimeInstance["observe"]>[0]) => {
        observed += 1;
        const subscription = runtime.observe(observer);

        return {
          unsubscribe: () => {
            unsubscribed += 1;
            subscription.unsubscribe();
          },
        };
      },
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

  test("throws one stable readiness attempt until the node becomes ready", async () => {
    const runtime = createRuntime();
    const args = {};
    const store = makeReactNodeStore(runtime, {
      spec: ReactProfileNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactProfileNode, args }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });

    const firstAttempt = readThrownPromise(store.read);
    const secondAttempt = readThrownPromise(store.read);

    expect(secondAttempt).toBe(firstAttempt);

    await firstAttempt;

    const ready = store.read();

    expect(ready.node).toBeInstanceOf(ReactProfileNode);
    expect(ready.node.timezone).toBe("UTC");

    store.dispose();
  });

  test("disposed store ignores readiness settlement", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());
    const gate = await Effect.runPromise(Deferred.make<Profile>());
    type SlowDisposeSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: Profile;
    }>;

    class SlowDisposeNode extends NodeBase<SlowDisposeSpec> {
      static readonly spec = resourceSpec<SlowDisposeSpec>({
        tag: "react/resources/slow-dispose",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SlowDisposeSpec>({
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
    const args = {};
    const store = makeReactNodeStore(runtime, {
      spec: SlowDisposeNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: SlowDisposeNode, args }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    const attempt = readThrownPromise(store.read);
    await Effect.runPromise(Deferred.await(started));

    store.dispose();
    const versionAfterDispose = store.getVersion();

    await Effect.runPromise(Deferred.succeed(gate, { timezone: "UTC" }));
    await attempt;

    expect(store.getVersion()).toBe(versionAfterDispose);
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
    await readThrownPromise(store.read);

    const ready = store.read();

    expect(ready.node).toBeInstanceOf(ReactProfileNode);
    expect(ready.node.result).toEqual({ timezone: "UTC" });
    expect(trapped.snapshotCalls()).toBe(0);

    store.dispose();
  });

  test("cold boot records React readiness metadata", async () => {
    const runtime = createRuntime();
    const args = {};
    const store = makeReactNodeStore(runtime, {
      spec: ReactProfileNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactProfileNode, args }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await readThrownPromise(store.read);
    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;
    const ensured = events.find((record) => record.event._tag === "GraphNodeReadyEnsured");

    expect(ensured?.work.source).toBe("react");
    expect(ensured?.work.reason).toBe("readiness");
    expect(ensured?.work.priority).toBe("visible");

    store.dispose();
  });

  test("idle projection schedules readiness through boot instead of raw ensureReady", () => {
    const runtime = createRuntime();
    const handle = runtime.client.node<Record<string, never>, Profile>(ReactProfileNode, {});
    const scheduled = Promise.resolve();
    let bootCalls = 0;
    let ensureReadyCalls = 0;
    let current: Promise<void> | undefined;
    let thrown: unknown;

    try {
      projectReactNodeRead<Record<string, never>, Record<string, never>, Profile, ReactProfileNode>(
        {
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
        }
      );
    } catch (cause) {
      thrown = cause;
    }

    expect(thrown).toBe(scheduled);
    expect(bootCalls).toBe(1);
    expect(ensureReadyCalls).toBe(0);
  });

  test("failed args reconciliation rolls back React store fingerprint so the same args can retry", async () => {
    const runtime = createRuntime();
    const args = { filter: "all" };
    const store = makeReactNodeStore(runtime, {
      spec: ReactArgsRollbackNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactArgsRollbackNode, args }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await readThrownPromise(store.read);

    await store.updateArgs({ filter: "active" });
    await store.updateArgs({ filter: "active" });

    const events = (await runtime.query({ _tag: "RuntimeEvents" })).events;

    expect(
      events.filter((record) => record.event._tag === "GraphNodeArgsUpdateStarted")
    ).toHaveLength(2);

    store.dispose();
  });

  test("failed older updateArgs does not clobber the fingerprint a newer success set", async () => {
    const runtime = createRuntime();
    const initial = { filter: "init" };
    const store = makeReactNodeStore(runtime, {
      spec: ReactArgsSelectiveNode,
      args: initial,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactArgsSelectiveNode, args: initial }),
    });

    await runtime.submit({ _tag: "RuntimeStart" });
    await readThrownPromise(store.read);

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
});

function readThrownPromise(read: () => unknown): Promise<unknown> {
  try {
    read();
  } catch (thrown) {
    if (thrown instanceof Promise) {
      return thrown;
    }
  }

  throw new Error("Expected read to throw a Suspense promise.");
}

test("node controls route through the runtime handle without reading the node", async () => {
  const runtime = createRuntime();
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
  const runtime = createRuntime();
  const args = {};
  const store = makeReactNodesStore(runtime, [
    {
      key: "profile",
      spec: ReactProfileNode,
      args,
      nodeId: runtime.resolveNodeIdSync({ spec: ReactProfileNode, args }),
    },
  ]);

  await runtime.submit({ _tag: "RuntimeStart" });
  await readThrownPromise(store.read);

  const nodes = store.read();

  expect(nodes.profile).toBeInstanceOf(ReactProfileNode);
  expect((nodes.profile as ReactProfileNode).timezone).toBe("UTC");
  expect(store.read()).toBe(nodes);

  store.dispose();
});

test("nodes store throws one stable composite attempt until children become ready", async () => {
  const startedA = await Effect.runPromise(Deferred.make<void>());
  const startedB = await Effect.runPromise(Deferred.make<void>());
  const gateA = await Effect.runPromise(Deferred.make<Profile>());
  const gateB = await Effect.runPromise(Deferred.make<Profile>());

  type SlowNodeASpec = NodeSpec<{
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: Profile;
  }>;

  class SlowNodeA extends NodeBase<SlowNodeASpec> {
    static readonly spec = resourceSpec<SlowNodeASpec>({
      tag: "react/resources/slow-a",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      driver: Driver.Effect<SlowNodeASpec>({
        acquire: Driver.Acquire(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(startedA, undefined);
            return yield* Deferred.await(gateA);
          })
        ),
      }),
    });
  }

  type SlowNodeBSpec = NodeSpec<{
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: Profile;
  }>;

  class SlowNodeB extends NodeBase<SlowNodeBSpec> {
    static readonly spec = resourceSpec<SlowNodeBSpec>({
      tag: "react/resources/slow-b",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      driver: Driver.Effect<SlowNodeBSpec>({
        acquire: Driver.Acquire(() =>
          Effect.gen(function* () {
            yield* Deferred.succeed(startedB, undefined);
            return yield* Deferred.await(gateB);
          })
        ),
      }),
    });
  }

  const runtime = createRuntime();
  const args = {};
  const store = makeReactNodesStore(runtime, [
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
  ]);

  await runtime.submit({ _tag: "RuntimeStart" });

  const firstAttempt = readThrownPromise(store.read);
  const secondAttempt = readThrownPromise(store.read);

  expect(secondAttempt).toBe(firstAttempt);

  await Effect.runPromise(Deferred.await(startedA));
  await Effect.runPromise(Deferred.await(startedB));

  await Effect.runPromise(Deferred.succeed(gateA, { timezone: "UTC" }));
  await Effect.runPromise(Deferred.succeed(gateB, { timezone: "CET" }));
  await firstAttempt;

  const nodes = store.read();

  expect((nodes.a as SlowNodeA).result).toEqual({ timezone: "UTC" });
  expect((nodes.b as SlowNodeB).result).toEqual({ timezone: "CET" });

  store.dispose();
});
