import { describe, expect, test } from "bun:test";
import type { DisposerBag } from "../src/driver";
import type { NodeSpec } from "./graphTestFixtures";
import {
  Deferred,
  DisposerFailed,
  DisposerTimedOut,
  Driver,
  dependencies,
  Effect,
  Key,
  makeInMemoryGraphSystem,
  NodeBase,
  ReleaseFailed,
  serviceSpec,
} from "./graphTestFixtures";

type SingletonSpec = NodeSpec<{
  readonly mode: "effect";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: string;
}>;

const neverSettles = (): Promise<void> => new Promise<void>(() => {});

describe("bounded async disposers", () => {
  test("later disposers still run in reverse order after an earlier one times out", async () => {
    const runs: Array<string> = [];

    class TimeoutOrderNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/disposer-timeout-order",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(() => {
              runs.push("first");
            });
            ctx.disposers.add(() => {
              runs.push("hanging");
              return neverSettles();
            });
            ctx.disposers.add(() => {
              runs.push("last");
            });
            return "ready";
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: TimeoutOrderNode, args: {} })
    );
    const result = await Effect.runPromise(
      graph
        .evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
        .pipe(Effect.timeout("500 millis"))
    );

    // Reverse registration order survives the timeout: the disposer registered
    // after the hanging one runs before it, and the one registered before it
    // still runs after the bound elapses.
    expect(runs).toEqual(["last", "hanging", "first"]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toBeInstanceOf(DisposerFailed);
  });

  test("eviction completes and removes graph records with a never-settling disposer", async () => {
    class HangingDisposerNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/evict-hanging-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(() => neverSettles());
            return "ready";
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: HangingDisposerNode, args: {} })
    );
    const result = await Effect.runPromise(
      graph
        .evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
        .pipe(Effect.timeout("500 millis"))
    );
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(result.nodeIds).toEqual([handle.nodeId]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toBeInstanceOf(DisposerFailed);
    expect(snapshot.nodes).toEqual([]);
  });

  test("runtime stop completes with a never-settling disposer and reports the timeout", async () => {
    class StopHangingDisposerNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/stop-hanging-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(() => neverSettles());
            return "ready";
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    await Effect.runPromise(graph.ensureReadyNode({ spec: StopHangingDisposerNode, args: {} }));
    const results = await Effect.runPromise(graph.stop().pipe(Effect.timeout("500 millis")));
    const snapshot = await Effect.runPromise(graph.snapshot());

    expect(results).toHaveLength(1);
    expect(results[0]?.failures).toHaveLength(1);
    expect(results[0]?.failures[0]).toBeInstanceOf(DisposerFailed);
    expect(snapshot.status).toBe("stopped");
  });

  test("runtime stop completes when an interrupted acquire holds a never-settling disposer", async () => {
    const started = await Effect.runPromise(Deferred.make<void>());

    class InterruptedAcquireNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/interrupted-acquire-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.gen(function* () {
            ctx.disposers.add(() => neverSettles());
            yield* Deferred.succeed(started, undefined);
            return yield* Effect.never;
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    const ready = Effect.runPromise(
      graph.ensureReadyNode({ spec: InterruptedAcquireNode, args: {} })
    );
    await Effect.runPromise(Deferred.await(started));
    const stopped = await Effect.runPromise(graph.stop().pipe(Effect.timeout("500 millis")));
    await ready;

    expect(stopped).toHaveLength(1);
  });

  test("timed-out disposer surfaces DisposerFailed with a DisposerTimedOut cause, not ReleaseFailed", async () => {
    class TaxonomyNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/disposer-timeout-taxonomy",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(() => neverSettles());
            return "ready";
          })
        ),
        release: Driver.Release(() => Effect.void),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    const handle = await Effect.runPromise(graph.ensureReadyNode({ spec: TaxonomyNode, args: {} }));
    const result = await Effect.runPromise(
      graph
        .evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
        .pipe(Effect.timeout("500 millis"))
    );

    expect(result.failures).toHaveLength(1);
    const failure = result.failures[0];
    expect(failure).toBeInstanceOf(DisposerFailed);
    expect(failure).not.toBeInstanceOf(ReleaseFailed);
    const cause = (failure as DisposerFailed).cause;
    expect(cause).toBeInstanceOf(DisposerTimedOut);
    expect(cause).toMatchObject({
      _tag: "DisposerTimedOut",
      tag: "services/disposer-timeout-taxonomy",
      timeout: 10,
      cancellation: { _tag: "TimedOut", detail: "10ms" },
    });
  });

  test("a disposer reachable from two registration paths runs exactly once", async () => {
    let runs = 0;
    const sharedDisposer = (): void => {
      runs += 1;
    };

    class SharedDisposerNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/shared-disposer-once",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(sharedDisposer);
            ctx.disposers.add(sharedDisposer);
            return "ready";
          })
        ),
        // Same function registered again through the release hook's own bag:
        // the registry, not the author's memoize, guarantees a single run.
        release: Driver.Release((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(sharedDisposer);
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: SharedDisposerNode, args: {} })
    );
    const result = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
    );

    expect(runs).toBe(1);
    expect(result.failures).toEqual([]);
  });

  test("a disposer registered during teardown still runs and its async work is awaited", async () => {
    const events: Array<string> = [];
    let bag: DisposerBag | undefined;

    class LateRegistrationNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/late-teardown-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            bag = ctx.disposers;
            ctx.disposers.add(async () => {
              events.push("outer-start");
              await Promise.resolve();
              // Cleanup spawned during the drain: registered while teardown is
              // already running its disposers.
              bag?.add(async () => {
                events.push("spawned-start");
                await Promise.resolve();
                events.push("spawned-done");
              });
              events.push("outer-done");
            });
            return "ready";
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 50 },
    });

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: LateRegistrationNode, args: {} })
    );
    const result = await Effect.runPromise(
      graph
        .evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
        .pipe(Effect.timeout("500 millis"))
    );

    // The drain awaited both the original disposer and the one it spawned
    // mid-drain before eviction resolved.
    expect(events).toEqual(["outer-start", "outer-done", "spawned-start", "spawned-done"]);
    expect(result.failures).toEqual([]);
  });

  test("a stable disposer function runs once per incarnation across evict and re-acquire", async () => {
    // Regression: the once-only registry must be scoped to one ready
    // incarnation. A stable function object (module-level unsubscribe, bound
    // method) registered by incarnation 1 and run at its teardown must run
    // again when incarnation 2 registers it after evict + re-acquire.
    let runs = 0;
    const stableUnsubscribe = (): void => {
      runs += 1;
    };

    class StableDisposerNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/stable-disposer-per-incarnation",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(stableUnsubscribe);
            return "ready";
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    const first = await Effect.runPromise(
      graph.ensureReadyNode({ spec: StableDisposerNode, args: {} })
    );
    const firstEviction = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [first.nodeId], mode: "selfAndDependents" })
    );
    expect(runs).toBe(1);

    const second = await Effect.runPromise(
      graph.ensureReadyNode({ spec: StableDisposerNode, args: {} })
    );
    const secondEviction = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [second.nodeId], mode: "selfAndDependents" })
    );

    expect(runs).toBe(2);
    expect(firstEviction.failures).toEqual([]);
    expect(secondEviction.failures).toEqual([]);
  });

  test("ctx and release-hook registrations dedupe within an incarnation and re-run per incarnation", async () => {
    // Regression companion: within ONE incarnation the acquire-ctx bag and the
    // release hook's own bag share a single once-only set (one run per
    // teardown), but a later incarnation re-registers the same function
    // through BOTH paths and gets its own run.
    let runs = 0;
    const sharedDisposer = (): void => {
      runs += 1;
    };

    class DoubleLifecycleNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/shared-disposer-double-lifecycle",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(sharedDisposer);
            ctx.disposers.add(sharedDisposer);
            return "ready";
          })
        ),
        release: Driver.Release((ctx) =>
          Effect.sync(() => {
            ctx.disposers.add(sharedDisposer);
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    const first = await Effect.runPromise(
      graph.ensureReadyNode({ spec: DoubleLifecycleNode, args: {} })
    );
    const firstEviction = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [first.nodeId], mode: "selfAndDependents" })
    );
    expect(runs).toBe(1);

    const second = await Effect.runPromise(
      graph.ensureReadyNode({ spec: DoubleLifecycleNode, args: {} })
    );
    const secondEviction = await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [second.nodeId], mode: "selfAndDependents" })
    );

    expect(runs).toBe(2);
    expect(firstEviction.failures).toEqual([]);
    expect(secondEviction.failures).toEqual([]);
  });

  test("a disposer added after teardown settled runs immediately instead of leaking", async () => {
    let bag: DisposerBag | undefined;
    let lateRan = false;

    class PostTeardownNode extends NodeBase<SingletonSpec> {
      static readonly spec = serviceSpec.effect<SingletonSpec>({
        tag: "services/post-teardown-disposer",
        key: () => Key.singleton(),
        dependencies: dependencies(() => ({})),
        acquire: Driver.Acquire((ctx) =>
          Effect.sync(() => {
            bag = ctx.disposers;
            return "ready";
          })
        ),
      });
    }
    const graph = makeInMemoryGraphSystem({
      driverTimeouts: { release: 10 },
    });

    const handle = await Effect.runPromise(
      graph.ensureReadyNode({ spec: PostTeardownNode, args: {} })
    );
    await Effect.runPromise(
      graph.evictSubgraph({ rootNodeIds: [handle.nodeId], mode: "selfAndDependents" })
    );

    bag?.add(() => {
      lateRan = true;
    });

    expect(lateRan).toBe(true);
  });
});
