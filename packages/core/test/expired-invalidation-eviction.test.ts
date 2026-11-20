import { expect, test } from "bun:test";
import {
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  resourceSpec,
} from "@frondruntime/core";
import { createFrondTestHarness } from "@frondruntime/core/testing";
import { Deferred, Effect } from "effect";

test("eviction suppresses expiry validity notification after a parked cleanup-failure sink resumes", async () => {
  const sinkStarted = await Effect.runPromise(Deferred.make<void>());
  const sinkGate = await Effect.runPromise(Deferred.make<void>());
  let now = 0;
  let acquireCalls = 0;

  type Spec = NodeSpec<{
    readonly mode: "effect";
    readonly args: Record<string, never>;
    readonly key: Key.Singleton;
    readonly deps: Record<string, never>;
    readonly result: string;
  }>;

  // effect-mode: exercise the runtime's suspended notification continuation.
  class ExpiringNode extends NodeBase<Spec> {
    static readonly spec = resourceSpec.effect<Spec>({
      tag: "expired-invalidation/eviction",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      resultValidity: { _tag: "TimeBound", expireAfter: "1 millis" },
      acquire: Driver.Acquire(() =>
        Effect.sync(() => {
          acquireCalls += 1;
          return "ready";
        })
      ),
      release: Driver.Release(() => Effect.fail(new Error("cleanup failed"))),
    });
  }

  const harness = createFrondTestHarness({
    syncClock: { now: () => now },
    sinks: [
      {
        name: "park-cleanup-failure",
        handle: ({ event }) =>
          event._tag === "GraphNodeCleanupFailed" && event.reason === "expired-invalidation"
            ? Effect.gen(function* () {
                yield* Deferred.succeed(sinkStarted, undefined);
                yield* Deferred.await(sinkGate);
              })
            : Effect.void,
      },
    ],
  });

  try {
    const handle = harness.node(ExpiringNode, {});
    await handle.ensureReady();
    expect(handle.read()).toMatchObject({ _tag: "Ready" });
    now = 2;

    const readiness = handle.ensureReady();
    await Effect.runPromise(Deferred.await(sinkStarted));
    const eviction = await handle.evict();
    await readiness;

    expect(eviction.nodeIds).toContain(handle.nodeId);
    expect(await handle.snapshot()).toMatchObject({ _tag: "Missing" });
    const expiryEvents = () =>
      harness.events
        .map((record) => record.event)
        .filter(
          (event) =>
            event._tag === "GraphNodeResultValidityChanged" && event.reason === "time-bound"
        );
    expect(expiryEvents()).toEqual([]);

    await Effect.runPromise(Deferred.succeed(sinkGate, undefined));
    await harness.waitForIdle();

    expect(acquireCalls).toBe(1);
    expect(expiryEvents()).toEqual([]);
  } finally {
    await Effect.runPromise(Deferred.succeed(sinkGate, undefined));
    await harness.teardown();
  }
});
