import { describe, expect, test } from "bun:test";
import { makeGraphCellState } from "../src/graph/cell/cellState";
import type { GraphNodeState } from "../src/graph/planning/plan";
import type { Runtime } from "../src/runtime";
import {
  type ActionContract,
  createRuntime,
  Deferred,
  Driver,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  type NodeSpec,
  resourceSpec,
  resultCommit,
  serviceSpec,
} from "./graphTestFixtures";
import { makeInspectionSnapshotForbiddenRuntime } from "./projectionTestFixtures";

describe("runtime projection surface", () => {
  test("graph cell state exposes the same committed value through Effect and sync reads", async () => {
    const state = makeGraphCellState({
      nextOperationId: 1,
      nextAttemptId: 0,
      phase: { _tag: "Evicted" },
    } satisfies GraphNodeState);

    expect(state.getSync().nextOperationId).toBe(1);
    expect((await Effect.runPromise(state.get)).nextOperationId).toBe(1);

    await Effect.runPromise(
      state.replace({
        nextOperationId: 2,
        nextAttemptId: 0,
        phase: { _tag: "Evicted" },
      })
    );

    expect(state.getSync().nextOperationId).toBe(2);

    await Effect.runPromise(
      state.transition((current) => [
        undefined,
        {
          ...current,
          nextOperationId: current.nextOperationId + 1,
        },
      ])
    );

    expect((await Effect.runPromise(state.get)).nextOperationId).toBe(3);

    const previous = await Effect.runPromise(
      state.transition((current) => [
        current.nextOperationId,
        {
          ...current,
          nextOperationId: current.nextOperationId + 1,
        },
      ])
    );

    expect(previous).toBe(3);
    expect(state.getSync().nextOperationId).toBe(4);
  });

  test("runtime handle reads and snapshots do not use full runtime snapshots", async () => {
    const trapped = makeInspectionSnapshotForbiddenRuntime();
    const runtime = trapped.runtime;
    const handle = runtime.client.node<Record<string, never>, { readonly value: string }>(
      ProjectionReadyNode,
      {}
    );

    await handle.ensureReady();

    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      nodeId: handle.nodeId,
      result: { value: "ready" },
    });
    expect(await handle.snapshot()).toMatchObject({
      _tag: "Found",
      snapshot: {
        _tag: "Ready",
        nodeId: handle.nodeId,
        result: { value: "ready" },
      },
    });
    await handle.releaseResources();
    expect(trapped.snapshotCalls()).toBe(0);
  });

  test("runtime snapshot purpose is currently an intent label, not a shape selector", async () => {
    const runtime = createRuntime();
    const handle = runtime.client.node<Record<string, never>, { readonly value: string }>(
      ProjectionReadyNode,
      {}
    );

    await handle.ensureReady();

    const diagnostics = await runtime.getSnapshotFor("diagnostics");
    const productRead = await runtime.getSnapshotFor("product-read");
    const testSnapshot = await runtime.getSnapshotFor("test");

    expect(productRead.graph).toEqual(diagnostics.graph);
    expect(testSnapshot.graph).toEqual(diagnostics.graph);
    expect(productRead.events.map((record) => record.event._tag)).toEqual(
      diagnostics.events.map((record) => record.event._tag)
    );
  });

  test("graph one-node snapshot and full snapshot agree for the same projection context", async () => {
    const graph = makeInMemoryGraphSystem();

    await Effect.runPromise(graph.ensureReadyNode({ spec: ProjectionTimeBoundNode, args: {} }));

    const nodeId = graph.resolveNodeIdSync({ spec: ProjectionTimeBoundNode, args: {} });
    const context = { now: 115 };
    const oneNode = graph.readNodeSnapshotSync(nodeId, context);
    const fullSnapshot = await Effect.runPromise(graph.snapshot(context));

    expect(oneNode).toEqual({
      _tag: "Found",
      snapshot: fullSnapshot.nodes.find((node) => node.nodeId === nodeId),
    });

    if (oneNode._tag !== "Found") {
      throw new Error("Expected one-node snapshot lookup to be found.");
    }

    expect(oneNode.snapshot.resultValidity).toEqual({ _tag: "Stale", staleAt: 110 });
    expect(oneNode.snapshot).toMatchObject({
      _tag: "Ready",
      node: expect.any(Object),
    });
    expect(graph.readNodeSnapshotSync("projection-surface/missing" as never, context)).toEqual({
      _tag: "Missing",
      nodeId: "projection-surface/missing",
    });
  });

  test("graph invalid snapshots expose explicit node lookup", async () => {
    const graph = makeInMemoryGraphSystem();

    const invalidKeyRead = await Effect.runPromise(
      graph.ensureNode({ spec: InvalidKeyNode, args: {} })
    );
    const invalidKeyLookup = graph.readNodeSnapshotSync(invalidKeyRead.nodeId, { now: 0 });

    expect(invalidKeyLookup).toMatchObject({
      _tag: "Found",
      snapshot: {
        _tag: "Invalid",
        nodeLookup: { _tag: "Missing" },
      },
    });

    const constructorFailureRead = await Effect.runPromise(
      graph.ensureReadyNode({ spec: ConstructorFailureNode, args: {} })
    );
    const constructorFailureLookup = graph.readNodeSnapshotSync(constructorFailureRead.nodeId, {
      now: 0,
    });

    expect(constructorFailureLookup).toMatchObject({
      _tag: "Found",
      snapshot: {
        _tag: "ReadinessError",
        status: { _tag: "Wired", run: { _tag: "Error", error: expect.any(Object) } },
      },
    });
  });

  test("runtime sync clock controls passive time-bound product projection", async () => {
    const loadedAt = Date.now();
    let now = loadedAt;
    type SyncClockSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class SyncClockNode extends NodeBase<SyncClockSpec> {
      static readonly spec = resourceSpec<SyncClockSpec>({
        tag: "projection-surface/sync-clock",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<SyncClockSpec>({
          resultValidity: {
            _tag: "TimeBound",
            expireAfter: "10 seconds",
          },
          acquire: Driver.Acquire(() =>
            Effect.succeed(
              resultCommit(
                { value: "sync-clock" },
                {
                  loadedAt,
                }
              )
            )
          ),
        }),
      });
    }
    const runtime = createRuntime({
      syncClock: {
        now: () => now,
      },
    });
    const handle = runtime.client.node<Record<string, never>, { readonly value: string }>(
      SyncClockNode,
      {}
    );

    await handle.ensureReady();

    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      resultValidity: { _tag: "Current", currentAt: loadedAt },
    });

    const beforeEvents = await eventSequences(runtime);
    now = loadedAt + 11_000;
    const expired = handle.read();
    const rawExpired = runtime.client.__unsafe.readNode(handle.nodeId);
    const afterEvents = await eventSequences(runtime);

    expect(expired).toMatchObject({
      _tag: "Idle",
    });
    expect(rawExpired).toMatchObject({
      _tag: "Expired",
      resultValidity: { _tag: "Expired", expiredAt: loadedAt + 10_000 },
    });
    expect("result" in expired).toBe(false);
    expect(afterEvents).toEqual(beforeEvents);
  });

  test("runtime sync clock fails loudly when it returns malformed time", () => {
    const runtime = createRuntime({
      syncClock: {
        now: () => Number.NaN,
      },
    });
    const handle = runtime.client.node<Record<string, never>, { readonly value: string }>(
      ProjectionReadyNode,
      {}
    );

    expect(() => handle.read()).toThrow("syncClock.now must return a finite number");
  });

  test("runtime node reads are passive across unwired idle ready and error states", async () => {
    const runtime = createRuntime();
    const ready = runtime.client.node<Record<string, never>, { readonly value: string }>(
      ProjectionReadyNode,
      {}
    );
    const failing = runtime.client.node<Record<string, never>, { readonly value: string }>(
      ProjectionFailingNode,
      {}
    );

    await expectReadDoesNotEmit(runtime, () => {
      expect(ready.read()).toMatchObject({ _tag: "Unwired", nodeId: ready.nodeId });
    });

    await ready.ensure();
    await expectReadDoesNotEmit(runtime, () => {
      expect(ready.read()).toMatchObject({ _tag: "Idle", nodeId: ready.nodeId });
    });

    await ready.ensureReady();
    await expectReadDoesNotEmit(runtime, () => {
      expect(ready.read()).toMatchObject({
        _tag: "Ready",
        nodeId: ready.nodeId,
        result: { value: "ready" },
      });
    });

    await failing.ensureReady();
    await expectReadDoesNotEmit(runtime, () => {
      expect(failing.read()).toMatchObject({ _tag: "Error", nodeId: failing.nodeId });
    });
  });

  test("runtime read and handle snapshot agree for pending and busy projections", async () => {
    const acquireStarted = await Effect.runPromise(Deferred.make<void>());
    const acquireGate = await Effect.runPromise(Deferred.make<{ readonly value: string }>());
    type PendingSpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
    }>;

    class PendingNode extends NodeBase<PendingSpec> {
      static readonly spec = serviceSpec<PendingSpec>({
        tag: "projection-surface/pending",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<PendingSpec>({
          acquire: Driver.Acquire(() =>
            Effect.gen(function* () {
              yield* Deferred.succeed(acquireStarted, undefined);
              return yield* Deferred.await(acquireGate);
            })
          ),
        }),
      });
    }
    const runtime = createRuntime();
    const pending = runtime.client.node<Record<string, never>, { readonly value: string }>(
      PendingNode,
      {}
    );

    const readiness = pending.ensureReady();
    await Effect.runPromise(Deferred.await(acquireStarted));

    expect(pending.read()).toMatchObject({ _tag: "Pending", nodeId: pending.nodeId });
    expect(await pending.snapshot()).toMatchObject({
      _tag: "Found",
      snapshot: {
        _tag: "Pending",
        nodeId: pending.nodeId,
        status: { _tag: "Wired", run: { _tag: "Pending" } },
        attempt: expect.any(Promise),
      },
    });

    await Effect.runPromise(Deferred.succeed(acquireGate, { value: "ready" }));
    await readiness;

    const actionStarted = await Effect.runPromise(Deferred.make<void>());
    const actionGate = await Effect.runPromise(Deferred.make<void>());
    type BusySpec = NodeSpec<{
      readonly args: Record<string, never>;
      readonly key: Key.Singleton;
      readonly deps: Record<string, never>;
      readonly result: { readonly value: string };
      readonly actions: {
        readonly wait: ActionContract<void, void>;
      };
    }>;

    class BusyNode extends NodeBase<BusySpec> {
      static readonly spec = serviceSpec<BusySpec>({
        tag: "projection-surface/busy",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        driver: Driver.Effect<BusySpec>({
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
    const busy = runtime.client.node<Record<string, never>, { readonly value: string }>(
      BusyNode,
      {}
    );

    await busy.ensureReady();
    const action = busy.runAction("wait");
    await Effect.runPromise(Deferred.await(actionStarted));

    expect(busy.read()).toMatchObject({
      _tag: "Ready",
      nodeId: busy.nodeId,
      busy: true,
      operation: { _tag: "Running", kind: "action" },
      result: { value: "idle" },
    });
    expect(await busy.snapshot()).toMatchObject({
      _tag: "Found",
      snapshot: {
        _tag: "Ready",
        nodeId: busy.nodeId,
        status: { _tag: "Wired", run: { _tag: "Ready" } },
        operation: { _tag: "Running", kind: "action" },
        result: { value: "idle" },
      },
    });

    await Effect.runPromise(Deferred.succeed(actionGate, undefined));
    await action;
  });

  test("expired product read is passive and invalidation is explicit readiness work", async () => {
    manualExpirationAcquireCount = 0;
    const runtime = createRuntime();
    const handle = runtime.client.node<Record<string, never>, { readonly value: string }>(
      ProjectionManualExpirationNode,
      {}
    );

    await handle.ensureReady();
    await handle.runAction("expire");

    const beforeEvents = await eventSequences(runtime);
    const read = handle.read();
    const rawRead = runtime.client.__unsafe.readNode(handle.nodeId);
    const snapshot = await handle.snapshot();
    const afterEvents = await eventSequences(runtime);

    expect(read).toMatchObject({
      _tag: "Idle",
      nodeId: handle.nodeId,
    });
    expect(rawRead).toMatchObject({
      _tag: "Expired",
      nodeId: handle.nodeId,
      resultValidity: { _tag: "Expired", expiredAt: 10 },
    });
    expect("result" in read).toBe(false);
    expect(snapshot).toMatchObject({
      _tag: "Found",
      snapshot: {
        _tag: "Ready",
        nodeId: handle.nodeId,
        status: { _tag: "Wired", run: { _tag: "Ready" } },
        result: { value: "current" },
        resultValidity: { _tag: "Expired", expiredAt: 10 },
      },
    });
    expect(afterEvents).toEqual(beforeEvents);
    expect(manualExpirationAcquireCount).toBe(1);

    await handle.ensureReady();

    expect(manualExpirationAcquireCount).toBe(2);
    expect(handle.read()).toMatchObject({
      _tag: "Ready",
      result: { value: "reacquired" },
      resultValidity: { _tag: "Current" },
    });
  });
});

async function expectReadDoesNotEmit(runtime: Runtime, read: () => void): Promise<void> {
  const before = await eventSequences(runtime);

  read();

  const after = await eventSequences(runtime);

  expect(after).toEqual(before);
}

async function eventSequences(runtime: Runtime): Promise<ReadonlyArray<number>> {
  const query = await runtime.query({ _tag: "RuntimeEvents" });

  return query.events.map((record) => record.sequence);
}

type ProjectionReadySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class ProjectionReadyNode extends NodeBase<ProjectionReadySpec> {
  static readonly spec = serviceSpec<ProjectionReadySpec>({
    tag: "projection-surface/ready",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ProjectionReadySpec>({
      acquire: Driver.Acquire(() => Effect.succeed({ value: "ready" })),
    }),
  });
}

type ProjectionFailingSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class ProjectionFailingNode extends NodeBase<ProjectionFailingSpec> {
  static readonly spec = serviceSpec<ProjectionFailingSpec>({
    tag: "projection-surface/failing",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ProjectionFailingSpec>({
      acquire: Driver.Acquire(() => Effect.fail(new Error("projection failure"))),
    }),
  });
}

type InvalidKeySpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

class InvalidKeyNode extends NodeBase<InvalidKeySpec> {
  static readonly spec = serviceSpec<InvalidKeySpec>({
    tag: "projection-surface/invalid-key",
    key: () => {
      throw new Error("invalid key");
    },
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<InvalidKeySpec>({
      acquire: Driver.Acquire(() => Effect.succeed("unused")),
    }),
  });
}

type ConstructorFailureSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

class ConstructorFailureNode extends NodeBase<ConstructorFailureSpec> {
  static readonly spec = serviceSpec<ConstructorFailureSpec>({
    tag: "projection-surface/constructor-failure",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ConstructorFailureSpec>({
      acquire: Driver.Acquire(() => Effect.succeed("unused")),
    }),
  });

  constructor() {
    super();
    throw new Error("constructor failed");
  }
}

type ProjectionTimeBoundSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
}>;

class ProjectionTimeBoundNode extends NodeBase<ProjectionTimeBoundSpec> {
  static readonly spec = resourceSpec<ProjectionTimeBoundSpec>({
    tag: "projection-surface/time-bound",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ProjectionTimeBoundSpec>({
      resultValidity: {
        _tag: "TimeBound",
        staleAfter: "10 millis",
      },
      acquire: Driver.Acquire(() =>
        Effect.succeed(
          resultCommit(
            { value: "time-bound" },
            {
              loadedAt: 100,
            }
          )
        )
      ),
    }),
  });
}

let manualExpirationAcquireCount = 0;
type ProjectionManualExpirationSpec = NodeSpec<{
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: { readonly value: string };
  readonly actions: {
    readonly expire: ActionContract<void, void>;
  };
}>;

class ProjectionManualExpirationNode extends NodeBase<ProjectionManualExpirationSpec> {
  static readonly spec = resourceSpec<ProjectionManualExpirationSpec>({
    tag: "projection-surface/manual-expiration",
    key: () => Key.singleton(),
    dependencies: dependencies(() => ({})),
    driver: Driver.Effect<ProjectionManualExpirationSpec>({
      resultValidity: { _tag: "Manual" },
      acquire: Driver.Acquire(() => {
        manualExpirationAcquireCount += 1;

        return Effect.succeed({
          value: manualExpirationAcquireCount === 1 ? "current" : "reacquired",
        });
      }),
      actions: {
        expire: Driver.Action((ctx) => ctx.setResultValidity({ _tag: "Expired", expiredAt: 10 })),
      },
    }),
  });
}
