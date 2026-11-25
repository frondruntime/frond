import { describe, expect, test } from "bun:test";
import { Effect } from "effect";
import { FrondRuntimeClosed, type RuntimeEvent, type RuntimeEventRecord } from "../src/runtime";
import { Signals } from "../src/signals";
import {
  type ActionContract,
  createRuntime,
  Driver,
  dependencies,
  Key,
  NodeBase,
  type NodeSpec,
  serviceSpec,
} from "./graphTestFixtures";

// The host's lifecycle as the Promise facade observes it: idle, running, stopped.

function eventTags(records: Array<RuntimeEventRecord>, tag: RuntimeEvent["_tag"]): number {
  return records.filter((record) => record.event._tag === tag).length;
}

type StopSpec = NodeSpec<{
  readonly mode: "async";
  readonly args: Record<string, never>;
  readonly key: Key.Singleton;
  readonly deps: Record<string, never>;
  readonly result: number;
  readonly actions: { readonly act: ActionContract<void, void> };
}>;

/**
 * A runtime whose one sink parks, once, on the first record `park` accepts,
 * until the stop interrupts it. `sunk` lists every record a sink started on;
 * `listened` lists what a listener registered behind one that throws on
 * `throwOn` received.
 */
function parkedSinkRuntime(
  park: (record: RuntimeEventRecord) => boolean,
  throwOn?: RuntimeEvent["_tag"]
) {
  const sunk: Array<RuntimeEvent["_tag"]> = [];
  const listened: Array<RuntimeEvent["_tag"]> = [];
  const parked = Promise.withResolvers<void>();
  let parking = true;
  const runtime = createRuntime({
    development: true,
    eventBufferSize: 512,
    sinks: [
      {
        name: "parked",
        handle: (record) => {
          sunk.push(record.event._tag);
          if (!parking || !park(record)) return Effect.void;
          parking = false;
          parked.resolve();
          return Effect.never;
        },
      },
    ],
  });
  runtime.observe((record) => {
    if (record.event._tag === throwOn) throw new Error("listener failed");
  });
  runtime.observe((record) => {
    listened.push(record.event._tag);
  });
  return { runtime, sunk, listened, parked: parked.promise };
}

/** Parks the sink on the node change the action's driver commits, then stops. */
async function stopBehindActionChange(throwOn?: RuntimeEvent["_tag"]) {
  let driven = false;
  class Resource extends NodeBase<StopSpec> {
    static readonly spec = serviceSpec.async<StopSpec>({
      tag: "lifecycle/stop-behind-action-change",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(() => 0),
      actions: {
        act: Driver.Action(() => {
          driven = true;
        }),
      },
    });
  }
  const harness = parkedSinkRuntime(
    (record) => driven && record.event._tag === "GraphNodeChanged",
    throwOn
  );
  const handle = harness.runtime.client.node(Resource, {});
  await handle.ensureReadyNode();
  const action = handle.actions.act();
  await harness.parked;
  await expect(harness.runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
    _tag: "RuntimeStopped",
  });
  // The stop evicts the node under the action, which its caller sees.
  await expect(action).resolves.toMatchObject({ _tag: "Failure" });
  return harness;
}

/** Parks the sink on the node change a failed acquire commits, then stops. */
async function stopBehindReadinessFailure(throwOn?: RuntimeEvent["_tag"]) {
  let failing = false;
  class Resource extends NodeBase<StopSpec> {
    static readonly spec = serviceSpec.async<StopSpec>({
      tag: "lifecycle/stop-behind-readiness-failure",
      key: () => Key.singleton(),
      dependencies: dependencies(() => ({})),
      acquire: Driver.Acquire(async () => {
        failing = true;
        throw new Error("acquire failed");
      }),
      actions: { act: Driver.Action(() => {}) },
    });
  }
  const harness = parkedSinkRuntime(
    (record) => failing && record.event._tag === "GraphNodeChanged",
    throwOn
  );
  const ready = harness.runtime.client.node(Resource, {}).ensureReady();
  await harness.parked;
  await expect(harness.runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
    _tag: "RuntimeStopped",
  });
  await Promise.allSettled([ready]);
  return harness;
}

describe("runtime host lifecycle", () => {
  test("a second start while running settles without starting the graph again", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const events: Array<RuntimeEventRecord> = [];
    const subscription = runtime.observe((event) => {
      events.push(event);
    });

    expect(runtime.getStatusSync()).toBe("idle");
    await expect(runtime.submit({ _tag: "RuntimeStart" })).resolves.toEqual({
      _tag: "RuntimeStarted",
    });
    await expect(runtime.submit({ _tag: "RuntimeStart" })).resolves.toEqual({
      _tag: "RuntimeStarted",
    });

    expect(runtime.getStatusSync()).toBe("running");
    expect(eventTags(events, "RuntimeStarted")).toBe(1);
    expect(eventTags(events, "GraphSystemStarted")).toBe(1);
    subscription.unsubscribe();
    await runtime.submit({ _tag: "RuntimeStop" });
  });

  test("a stop after a stop settles from the first stop and emits nothing new", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    const events: Array<RuntimeEventRecord> = [];
    runtime.observe((event) => {
      events.push(event);
    });
    await runtime.submit({ _tag: "RuntimeStart" });

    await expect(runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
      _tag: "RuntimeStopped",
    });
    const stoppedEvents = events.length;
    await expect(runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
      _tag: "RuntimeStopped",
    });

    expect(runtime.getStatusSync()).toBe("stopped");
    expect(events).toHaveLength(stoppedEvents);
    expect(eventTags(events, "RuntimeStopped")).toBe(1);
  });

  test("stopping an idle runtime closes it to a later start", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });

    await expect(runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
      _tag: "RuntimeStopped",
    });

    expect(runtime.getStatusSync()).toBe("stopped");
    await expect(runtime.submit({ _tag: "RuntimeStart" })).rejects.toBeInstanceOf(
      FrondRuntimeClosed
    );
    expect(runtime.getStatusSync()).toBe("stopped");
  });

  test("a stopped runtime refuses signal subscriptions and reports stopped status", async () => {
    const runtime = createRuntime({ development: true, eventBufferSize: 512 });
    await runtime.submit({ _tag: "RuntimeStart" });
    await runtime.submit({ _tag: "RuntimeStop" });

    await expect(
      runtime.subscribeSignals({
        name: "after-stop",
        channels: [Signals.channel("runtime/lifecycle")],
        handle: () => Effect.void,
      })
    ).rejects.toBeInstanceOf(FrondRuntimeClosed);
    await expect(runtime.query({ _tag: "RuntimeStatus" })).resolves.toMatchObject({
      status: "stopped",
    });
    expect(runtime.getSnapshotSync().status).toBe("stopped");
  });

  test("an input whose sink the stop interrupts settles without starting another sink", async () => {
    const sinks: string[] = [];
    const received = Promise.withResolvers<void>();
    const runtime = createRuntime({
      development: true,
      eventBufferSize: 512,
      sinks: [
        {
          name: "blocking-input",
          handle: (record) => {
            switch (record.event._tag) {
              case "RuntimeInputReceived":
                return Effect.sync(() => {
                  sinks.push("received:started");
                  received.resolve();
                }).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Effect.sync(() => sinks.push("received:interrupted")))
                );
              case "GraphSystemInputObserved":
                return Effect.sync(() => {
                  sinks.push("observed:started");
                }).pipe(Effect.andThen(Effect.never));
              default:
                return Effect.void;
            }
          },
        },
      ],
    });
    const events: Array<RuntimeEvent["_tag"]> = [];
    runtime.observe((record) => {
      events.push(record.event._tag);
    });
    await runtime.submit({ _tag: "RuntimeStart" });
    const ingested = runtime.ingest({
      _tag: "RuntimeInput",
      name: "during-stop",
      payload: undefined,
    });
    await received.promise;

    await expect(runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
      _tag: "RuntimeStopped",
    });
    expect(sinks).toEqual(["received:started", "received:interrupted"]);
    await expect(ingested).resolves.toBeUndefined();
    // The input's continuation still runs and records its event; only its
    // sink is refused.
    expect(events.slice(-3)).toEqual([
      "GraphSystemInputObserved",
      "GraphSystemStopped",
      "RuntimeStopped",
    ]);
  }, 1000);

  // MIGRATION-0.6: once the stop has swept the running sinks, an event emitted
  // while it closes reaches every listener and starts no sink.
  test("a start finished during the stop reaches listeners but no sink", async () => {
    const harness = parkedSinkRuntime((record) => record.event._tag === "RuntimeStarted");
    const started = harness.runtime.submit({ _tag: "RuntimeStart" });
    await harness.parked;

    await expect(harness.runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
      _tag: "RuntimeStopped",
    });
    await expect(started).resolves.toEqual({ _tag: "RuntimeStarted" });
    expect(harness.listened).toContain("GraphSystemStarted");
    expect(harness.sunk).not.toContain("GraphSystemStarted");
    expect(harness.sunk.slice(-2)).toEqual(["GraphSystemStopped", "RuntimeStopped"]);
  }, 1000);

  // As in 0.5, the stop's eviction ends an action whose driver already
  // returned: its GraphActionFailed is the action's only terminal event, and
  // the driver's late result neither completes it nor reaches a sink.
  test("an action the stop overtakes emits one terminal event, its failure", async () => {
    const harness = await stopBehindActionChange();

    expect(
      harness.listened.filter(
        (tag) => tag === "GraphActionSucceeded" || tag === "GraphActionFailed"
      )
    ).toEqual(["GraphActionFailed"]);
    expect(harness.sunk).not.toContain("GraphActionSucceeded");
  }, 1000);

  test("a readiness failure finished during the stop reaches listeners but no sink", async () => {
    const harness = await stopBehindReadinessFailure();

    expect(harness.listened).toContain("GraphNodeReadinessFailed");
    expect(harness.sunk).not.toContain("GraphNodeReadinessFailed");
  }, 1000);

  // Signal publishing is not observer work the stop sweeps, so a delivery
  // parked on a sink can resume after the stop: its listeners still run, and
  // no sink starts, neither for a listener failure nor for the signal.
  test("a signal delivery parked across the stop starts no sink once released", async () => {
    const sunk: Array<RuntimeEvent["_tag"]> = [];
    const listened: Array<RuntimeEvent["_tag"]> = [];
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let parking = true;
    const runtime = createRuntime({
      development: true,
      eventBufferSize: 512,
      sinks: [
        {
          name: "parked-diagnostic",
          handle: (record) => {
            sunk.push(record.event._tag);
            if (!parking || record.event._tag !== "RuntimeObserverFailureObserved")
              return Effect.void;
            parking = false;
            parked.resolve();
            return Effect.promise(() => release.promise);
          },
        },
      ],
    });
    const throwOnSignal = (record: RuntimeEventRecord) => {
      if (record.event._tag === "RuntimeSignalPublished") throw new Error("listener failed");
    };
    runtime.observe(throwOnSignal);
    runtime.observe((record) => throwOnSignal(record));
    runtime.observe((record) => {
      listened.push(record.event._tag);
    });
    await runtime.submit({ _tag: "RuntimeStart" });
    const published = runtime.publish(
      Signals.signal({ channel: Signals.channel("lifecycle/parked"), name: "parked" })
    );
    await parked.promise;

    await expect(runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
      _tag: "RuntimeStopped",
    });
    const sunkAtStop = sunk.length;
    release.resolve();
    await published;

    expect(sunk.slice(sunkAtStop)).toEqual([]);
    expect(listened.slice(-1)).toEqual(["RuntimeSignalPublished"]);
  }, 1000);

  // A signal sink that fails after the stop still reports it to listeners, and
  // a listener that throws on that report starts no sink.
  test("a signal sink that fails after the stop reaches listeners but starts no sink", async () => {
    const sunk: Array<RuntimeEvent["_tag"]> = [];
    const listened: Array<RuntimeEvent["_tag"]> = [];
    const parked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let parking = true;
    const runtime = createRuntime({
      development: true,
      eventBufferSize: 512,
      sinks: [
        {
          name: "parked-signal",
          handle: (record) => {
            sunk.push(record.event._tag);
            if (!parking || record.event._tag !== "RuntimeSignalPublished") return Effect.void;
            parking = false;
            parked.resolve();
            return Effect.promise(() => release.promise).pipe(
              Effect.andThen(Effect.die(new Error("sink failed")))
            );
          },
        },
      ],
    });
    runtime.observe((record) => {
      if (record.event._tag === "RuntimeSinkFailureObserved") throw new Error("listener failed");
    });
    runtime.observe((record) => {
      listened.push(record.event._tag);
    });
    await runtime.submit({ _tag: "RuntimeStart" });
    const published = runtime.publish(
      Signals.signal({ channel: Signals.channel("lifecycle/parked"), name: "parked" })
    );
    await parked.promise;

    await expect(runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
      _tag: "RuntimeStopped",
    });
    const sunkAtStop = sunk.length;
    release.resolve();
    await published;

    expect(sunk.slice(sunkAtStop)).toEqual([]);
    expect(listened.slice(-1)).toEqual(["RuntimeSinkFailureObserved"]);
  }, 1000);

  // A listener that throws while the stop closes must not cost the listeners
  // behind it the event: the observer failure starts no sink and, like every
  // late diagnostic, is dropped.
  test("an input observed during the stop reaches the listener behind one that throws", async () => {
    const harness = parkedSinkRuntime(
      (record) => record.event._tag === "RuntimeInputReceived",
      "GraphSystemInputObserved"
    );
    await harness.runtime.submit({ _tag: "RuntimeStart" });
    const ingested = harness.runtime.ingest({
      _tag: "RuntimeInput",
      name: "during-stop",
      payload: undefined,
    });
    await harness.parked;

    await expect(harness.runtime.submit({ _tag: "RuntimeStop" })).resolves.toEqual({
      _tag: "RuntimeStopped",
    });
    await expect(ingested).resolves.toBeUndefined();
    expect(harness.listened.slice(-3)).toEqual([
      "GraphSystemInputObserved",
      "GraphSystemStopped",
      "RuntimeStopped",
    ]);
    expect(harness.listened).not.toContain("RuntimeObserverFailureObserved");
    expect(harness.sunk).not.toContain("GraphSystemInputObserved");
    expect(harness.sunk).not.toContain("RuntimeObserverFailureObserved");
  }, 1000);

  test("an action the stop overtakes reaches the listener behind one that throws", async () => {
    const harness = await stopBehindActionChange("GraphActionFailed");

    expect(harness.listened.slice(-4)).toEqual([
      "GraphActionFailed",
      "GraphNodeChanged",
      "GraphSystemStopped",
      "RuntimeStopped",
    ]);
    expect(harness.listened).not.toContain("GraphActionSucceeded");
    expect(harness.sunk).not.toContain("GraphActionSucceeded");
  }, 1000);

  test("a readiness failure finished during the stop reaches the listener behind one that throws", async () => {
    const harness = await stopBehindReadinessFailure("GraphNodeReadinessFailed");

    expect(harness.listened).toContain("GraphNodeReadinessFailed");
    expect(harness.listened).not.toContain("RuntimeObserverFailureObserved");
    expect(harness.sunk).not.toContain("GraphNodeReadinessFailed");
    expect(harness.sunk).not.toContain("RuntimeObserverFailureObserved");
    expect(harness.sunk.slice(-2)).toEqual(["GraphSystemStopped", "RuntimeStopped"]);
  }, 1000);
});
